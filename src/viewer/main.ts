/**
 * PDF bilingual reader page (spec 3.0 pillar E / §5).
 *
 * Flow: fetch bytes -> pdf.js (locally packaged, lazily loaded) -> per-page
 * text extraction + paragraph clustering -> lazy render + translate through
 * the existing background pipeline (queue / batching / cache / failover).
 *
 * Display modes: bilingual (default) and translated_hover_original, plus a
 * read-only "original" fallback. Documents are identified by a fingerprint
 * that participates in cache keys, so reopening a translated document costs
 * zero API calls (spec 3.0 §11 M5 exit criteria).
 */
import { sendRuntime } from '../messaging/messages';
import { loadSettings } from '../storage/settings';
import { PDF_PARAGRAPH_BUDGET } from '../shared/constants';
import type { PdfViewerMode } from '../shared/types';
import { openPdfDocument } from './pdf/loader';
import type { PdfDocumentLike, PdfPageLike } from './pdf/loader';
import {
  clusterPageFromLines,
  clusterOptionsForPreset,
  collectRepeatingLines,
  extractLines,
} from './pdf/segment';
import type { PdfLine, TextItemLike } from './pdf/segment';
import { chooseFingerprint, pdfScopedCacheText } from './pdf/fingerprint';
import {
  SCANNED_PAGE_OCR_BUDGET,
  canvasToOcrDataUrl,
  imageHashFromDataUrl,
  scannedPageCacheText,
} from './pdf/scannedOcr';

/* --------------------------------- DOM handles -------------------------------- */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const docEl = $<HTMLElement>('document');
const titleEl = $<HTMLElement>('doc-title');
const progressEl = $<HTMLElement>('progress');
const budgetHint = $<HTMLElement>('budget-hint');
const modeSelect = $<HTMLSelectElement>('mode-select');
const retryBtn = $<HTMLButtonElement>('retry-btn');
const fatalEl = $<HTMLElement>('fatal');

function fatal(message: string): void {
  fatalEl.textContent = message;
  fatalEl.classList.remove('hidden');
  docEl.setAttribute('aria-busy', 'false');
}

/* --------------------------------- page model --------------------------------- */

type ViewerMode = PdfViewerMode | 'original';

interface ParaState {
  text: string;
  status: 'idle' | 'pending' | 'done' | 'error';
  translated: string | null;
  error: string | null;
  el: HTMLElement | null;
}

interface PageState {
  index: number; // 1-based pdf.js page number
  pdfPage: PdfPageLike | null;
  lines: PdfLine[];
  paragraphs: ParaState[];
  scanned: boolean;
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  rendered: boolean;
  workStarted: boolean;
}

let mode: ViewerMode = 'bilingual';
let pages: PageState[] = [];
let fingerprint = '';
let degradedViewport = false;
let maxConcurrentPages = 3;
let skipHeadersFooters = true;
let scannedPageOcr = true;
let layoutPreset: 'auto' | 'single' | 'columns' | 'table' = 'auto';
let maxEdgePx = 4096;
let ocrEngineId = 'llm-vision';
let scannedOcrCount = 0;
let activeCount = 0;
const waiters: (() => void)[] = [];

async function acquirePageSlot(): Promise<void> {
  if (activeCount < maxConcurrentPages) {
    activeCount++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeCount++;
}

function releasePageSlot(): void {
  activeCount--;
  const next = waiters.shift();
  if (next) next();
}

/* --------------------------------- bootstrap ---------------------------------- */

function sourceUrl(): string | null {
  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (!src) return null;
  try {
    return new URL(src).toString();
  } catch {
    return null;
  }
}

async function fetchPdf(url: string): Promise<{ bytes: ArrayBuffer; etag: string | null; lastModified: string | null }> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`下载 PDF 失败（HTTP ${res.status}）`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType !== '' && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    throw new Error(`该地址返回的不是 PDF（Content-Type: ${contentType}）`);
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error('下载的 PDF 内容为空');
  return {
    bytes,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

/** Compute the header hash fallback fingerprint component. */
async function headerHash(bytes: ArrayBuffer): Promise<string> {
  const head = bytes.slice(0, 4096);
  try {
    const digest = await crypto.subtle.digest('SHA-256', head);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // crypto.subtle unavailable: degrade to a size-based marker.
    return `size:${bytes.byteLength}`;
  }
}

async function main(): Promise<void> {
  const url = sourceUrl();
  if (!url) {
    fatal('缺少 src 参数：请从 Popup 或右键菜单「用 PolyPage 打开」进入阅读器。');
    return;
  }
  let fileName = decodeURIComponent(url.split('/').pop() ?? 'document.pdf');
  try {
    fileName = fileName.split('?')[0] || 'document.pdf';
  } catch {
    /* keep */
  }
  titleEl.textContent = fileName;
  titleEl.title = url;

  const settings = await loadSettings();
  maxConcurrentPages = settings.pdfViewer.maxConcurrentPages;
  skipHeadersFooters = settings.pdfViewer.skipHeadersFooters;
  scannedPageOcr = settings.pdfViewer.scannedPageOcr;
  layoutPreset = settings.pdfViewer.layoutPreset ?? 'auto';
  maxEdgePx = settings.imageTranslate.maxEdgePx;
  ocrEngineId = settings.imageTranslate.engine;
  mode = settings.pdfViewer.defaultMode;
  modeSelect.value = mode;

  let doc: PdfDocumentLike;
  let fetched: { bytes: ArrayBuffer; etag: string | null; lastModified: string | null };
  try {
    fetched = await fetchPdf(url);
  } catch (e) {
    fatal(e instanceof Error ? e.message : String(e));
    return;
  }
  // Compute the header hash BEFORE pdf.js takes the buffer: getDocument()
  // transfers (detaches) the ArrayBuffer into its worker.
  const hh = await headerHash(fetched.bytes);
  const byteLength = fetched.bytes.byteLength;
  try {
    doc = await openPdfDocument(fetched.bytes);
  } catch (e) {
    fatal(`无法解析 PDF 文件：${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  fingerprint = chooseFingerprint(doc.fingerprints?.[0] ?? null, {
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    size: byteLength,
    headerHash: hh,
  });

  try {
    await buildPages(doc);
  } catch (e) {
    fatal(`读取 PDF 页面失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  docEl.setAttribute('aria-busy', 'false');
  updateProgress();

  window.addEventListener('pagehide', () => {
    void doc.destroy().catch(() => undefined);
  });
}

/* ------------------------------ extraction pass ------------------------------- */

async function buildPages(doc: PdfDocumentLike): Promise<void> {
  const allLines: PdfLine[][] = [];
  const pageObjects: PdfPageLike[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pageObjects.push(page);
    try {
      const content = await page.getTextContent();
      allLines.push(extractLines(content.items as TextItemLike[], clusterOptionsForPreset(layoutPreset)));
    } catch {
      allLines.push([]);
    }
  }

  const repeating = skipHeadersFooters ? collectRepeatingLines(allLines) : new Set<string>();
  const cluster = clusterOptionsForPreset(layoutPreset);

  const totalBudgetCheck = { paragraphs: 0 };
  pages = pageObjects.map((pdfPage, i) => {
    const result = clusterPageFromLines(allLines[i], {
      skipHeadersFooters,
      headerFooterSet: repeating,
      cluster,
    });
    const paragraphs: ParaState[] = result.paragraphs.map((p) => ({
      text: p.text,
      status: 'idle',
      translated: null,
      error: null,
      el: null,
    }));
    totalBudgetCheck.paragraphs += paragraphs.length;
    return {
      index: i + 1,
      pdfPage,
      lines: allLines[i],
      paragraphs,
      scanned: result.scanned,
      container: buildPageDom(i + 1),
      canvas: null as unknown as HTMLCanvasElement,
      rendered: false,
      workStarted: false,
    };
  });
  // Wire canvases after DOM insertion.
  for (const page of pages) {
    page.canvas = page.container.querySelector('canvas') as HTMLCanvasElement;
  }

  if (totalBudgetCheck.paragraphs > PDF_PARAGRAPH_BUDGET) {
    degradedViewport = true;
    budgetHint.textContent = `待翻译段落 ${totalBudgetCheck.paragraphs} 条，超过预算 ${PDF_PARAGRAPH_BUDGET}：已降级为仅翻译视口 ±1 页`;
    budgetHint.classList.remove('hidden');
  }

  observePages();
}

function buildPageDom(pageNumber: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'page';
  wrap.dataset.page = String(pageNumber);
  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  docEl.appendChild(wrap);
  return wrap;
}

/* ------------------------------- lazy rendering ------------------------------- */

let io: IntersectionObserver | null = null;

function observePages(): void {
  io?.disconnect();
  io = new IntersectionObserver(
    (records) => {
      for (const rec of records) {
        if (!rec.isIntersecting) continue;
        const target = rec.target as HTMLElement;
        const pageNumber = Number(target.dataset.page ?? '0');
        const page = pages[pageNumber - 1];
        if (!page || page.workStarted) continue;
        page.workStarted = true;
        void workPage(page);
      }
    },
    {
      // Degraded mode: viewport +/- one screen; normal: small prefetch margin.
      rootMargin: degradedViewport ? '100% 0px 100% 0px' : '600px 0px 600px 0px',
    },
  );
  for (const page of pages) io.observe(page.container);
}

async function workPage(page: PageState): Promise<void> {
  await acquirePageSlot();
  try {
    if (!page.rendered) {
      try {
        await renderPage(page);
      } catch {
        /* render failure does not block text translation */
      }
    }
    if (mode !== 'original') {
      await translatePage(page);
    }
    ensureParasDom(page);
    renderPageParas(page);
  } finally {
    releasePageSlot();
  }
}

async function renderPage(page: PageState): Promise<void> {
  if (!page.pdfPage) return;
  const base = page.pdfPage.getViewport({ scale: 1 });
  const available = Math.max(docEl.clientWidth - 60, 320);
  const scale = Math.min(2.2, Math.max(0.6, available / base.width));
  const viewport = page.pdfPage.getViewport({ scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  page.canvas.width = Math.floor(viewport.width * dpr);
  page.canvas.height = Math.floor(viewport.height * dpr);
  page.canvas.style.width = `${Math.floor(viewport.width)}px`;
  page.canvas.style.height = `${Math.floor(viewport.height)}px`;
  const ctx = page.canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  await page.pdfPage.render({ canvasContext: ctx, viewport }).promise;
  page.rendered = true;
}

/* ------------------------------- translation ---------------------------------- */

const CHUNK = 8;

async function translatePage(page: PageState): Promise<void> {
  if (page.scanned) {
    showScannedHint(page);
    return;
  }
  const todo = page.paragraphs.filter((p) => p.status === 'idle' || p.status === 'error');
  if (todo.length === 0) return;
  for (const para of todo) {
    para.status = 'pending';
    para.error = null;
  }
  ensureParasDom(page);
  renderPageParas(page);

  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const items = chunk.map((para, j) => ({
      key: `p${page.index}-${i + j}`,
      text: pdfScopedCacheText(fingerprint, page.index, page.paragraphs.indexOf(para), para.text),
    }));
    try {
      const res = await sendRuntime({ type: 'translate', items, domain: 'pdf-viewer' });
      chunk.forEach((para, j) => {
        const key = `p${page.index}-${i + j}`;
        const translated = res.results[key];
        if (translated !== undefined) {
          para.status = 'done';
          para.translated = translated;
        } else {
          para.status = 'error';
          para.error = res.errors[key]?.message ?? '翻译失败';
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      for (const para of chunk) {
        para.status = 'error';
        para.error = message;
      }
    }
    renderPageParas(page);
    updateProgress();
  }
}

/* --------------------------------- rendering ---------------------------------- */

function ensureParasDom(page: PageState): void {
  if (page.container.querySelector('.paras')) return;
  const paras = document.createElement('div');
  paras.className = 'paras';
  page.container.appendChild(paras);
  if (page.scanned) {
    showScannedHint(page);
    return;
  }
  page.paragraphs.forEach((para) => {
    const el = document.createElement('div');
    el.className = 'para';
    const src = document.createElement('div');
    src.className = 'src';
    const dst = document.createElement('div');
    dst.className = 'dst';
    const mark = document.createElement('button');
    mark.className = 'mark-btn';
    mark.textContent = '标记坏句';
    mark.addEventListener('click', (e) => {
      e.stopPropagation();
      if (para.translated === null) return;
      void sendRuntime({
        type: 'mark-feedback',
        source: para.text,
        translation: para.translated,
        pageUrl: `pdf-viewer:${titleEl.title || titleEl.textContent}`,
        where: 'pdf',
      }).then(() => {
        mark.textContent = '已标记';
        window.setTimeout(() => (mark.textContent = '标记坏句'), 1200);
      });
    });
    if (mode === 'translated_hover_original') {
      el.addEventListener('mouseenter', () => showTooltip(el, para.text));
      el.addEventListener('mouseleave', hideTooltip);
    }
    el.append(src, dst, mark);
    paras.appendChild(el);
    para.el = el;
  });
}

function showScannedHint(page: PageState): void {
  if (page.container.querySelector('.scanned-hint')) return;
  const hint = document.createElement('div');
  hint.className = 'scanned-hint';
  const text = document.createElement('div');
  text.textContent =
    '此页没有文本层（可能是扫描图片）。点击「识别本页」将该页渲染为图片后走当前 OCR 引擎。';
  hint.appendChild(text);
  if (scannedPageOcr) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ocr-page-btn';
    btn.textContent = '识别本页';
    btn.addEventListener('click', () => {
      void recognizeScannedPage(page, btn, hint);
    });
    hint.appendChild(btn);
  }
  page.container.appendChild(hint);
}

async function recognizeScannedPage(
  page: PageState,
  btn: HTMLButtonElement,
  hint: HTMLElement,
): Promise<void> {
  if (scannedOcrCount >= SCANNED_PAGE_OCR_BUDGET) {
    const ok = window.confirm(
      `本文档已识别 ${scannedOcrCount} 页扫描页（上限 ${SCANNED_PAGE_OCR_BUDGET}）。继续将产生额外 OCR / 翻译费用，是否继续？`,
    );
    if (!ok) return;
  }
  btn.disabled = true;
  btn.textContent = '识别中…';
  try {
    if (!page.rendered) await renderPage(page);
    const dataUrl = canvasToOcrDataUrl(page.canvas, maxEdgePx);
    const imageHash = imageHashFromDataUrl(dataUrl);
    const cacheIdentity = scannedPageCacheText(fingerprint, page.index, imageHash, ocrEngineId);
    const requestId = `pdfocr-${page.index}-${Date.now()}`;
    const res = await sendRuntime({
      type: 'ocr-request',
      requestId,
      url: dataUrl,
      cacheIdentity,
    });
    if (!res?.ok) {
      throw new Error(res && 'error' in res ? res.error : '识别失败');
    }
    scannedOcrCount += 1;
    page.paragraphs = res.segments.map((seg) => ({
      text: seg.text,
      status: 'done' as const,
      translated: seg.translation.trim() !== '' ? seg.translation : seg.text,
      error: null,
      el: null,
    }));
    page.scanned = false;
    hint.remove();
    ensureParasDom(page);
    renderPageParas(page);
    updateProgress();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    let errEl = hint.querySelector('.ocr-page-error') as HTMLElement | null;
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'ocr-page-error';
      hint.appendChild(errEl);
    }
    errEl.textContent = `识别失败：${message}`;
    btn.disabled = false;
    btn.textContent = '识别本页';
  }
}

function renderPageParas(page: PageState): void {
  const parasEl = page.container.querySelector('.paras');
  if (!parasEl) return;
  for (const para of page.paragraphs) {
    const el = para.el;
    if (!el) continue;
    const src = el.querySelector('.src') as HTMLElement;
    const dst = el.querySelector('.dst') as HTMLElement;
    const mark = el.querySelector('.mark-btn') as HTMLElement;
    if (mode === 'original') {
      src.style.display = '';
      dst.style.display = 'none';
      mark.style.display = 'none';
      src.textContent = para.text;
      continue;
    }
    const bilingual = mode === 'bilingual';
    src.style.display = bilingual ? '' : 'none';
    dst.style.display = '';
    src.textContent = para.text;
    dst.classList.remove('pending', 'error');
    if (para.status === 'done' && para.translated !== null) {
      dst.textContent = para.translated;
      mark.style.display = '';
    } else if (para.status === 'error') {
      dst.textContent = `翻译失败：${para.error ?? '未知错误'}（点击重试）`;
      dst.classList.add('error');
      mark.style.display = 'none';
      dst.onclick = (): void => {
        para.status = 'idle';
        void translatePage(page);
      };
    } else {
      dst.textContent = '翻译中…';
      dst.classList.add('pending');
      mark.style.display = 'none';
    }
  }
}

function rerenderAll(): void {
  for (const page of pages) {
    // Rebuild paragraph DOM so hover handlers match the new mode.
    const parasEl = page.container.querySelector('.paras');
    if (parasEl) parasEl.remove();
    for (const para of page.paragraphs) para.el = null;
    if (page.workStarted) {
      ensureParasDom(page);
      renderPageParas(page);
    }
  }
}

/* ---------------------------------- tooltip ----------------------------------- */

let tooltipEl: HTMLElement | null = null;

function showTooltip(anchor: HTMLElement, text: string): void {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'tooltip';
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.textContent = text;
  const rect = anchor.getBoundingClientRect();
  tooltipEl.style.visibility = 'hidden';
  tooltipEl.style.display = 'block';
  const width = tooltipEl.offsetWidth;
  const height = tooltipEl.offsetHeight;
  let left = Math.min(Math.max(rect.left, 10), window.innerWidth - width - 10);
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 10) top = Math.max(10, rect.top - height - 8);
  tooltipEl.style.left = `${Math.round(left)}px`;
  tooltipEl.style.top = `${Math.round(top)}px`;
  tooltipEl.style.visibility = 'visible';
}

function hideTooltip(): void {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

/* ---------------------------------- progress ---------------------------------- */

let progressTimer: number | null = null;

function progressCounts(): { done: number; total: number; failed: number } {
  let done = 0;
  let total = 0;
  let failed = 0;
  for (const page of pages) {
    for (const para of page.paragraphs) {
      total++;
      if (para.status === 'done') done++;
      else if (para.status === 'error') failed++;
    }
  }
  return { done, total, failed };
}

function updateProgress(): void {
  const { done, total, failed } = progressCounts();
  const scannedPages = pages.filter((p) => p.scanned).length;
  let text = total > 0 ? `已译 ${done}/${total}` : '—';
  if (failed > 0) text += `，失败 ${failed}`;
  if (scannedPages > 0) text += `，扫描页 ${scannedPages}`;
  progressEl.textContent = text;
  retryBtn.disabled = failed === 0;
  if (progressTimer !== null) return;
  progressTimer = window.setTimeout(() => {
    progressTimer = null;
    void sendRuntime({
      type: 'pdf-progress',
      url: titleEl.title || location.href,
      done,
      total,
      failed,
    }).catch(() => undefined);
  }, 600);
}

/* ----------------------------------- events ----------------------------------- */

modeSelect.addEventListener('change', () => {
  const next = modeSelect.value as ViewerMode;
  mode = next;
  hideTooltip();
  rerenderAll();
  if (next !== 'original') {
    for (const page of pages) {
      if (page.workStarted && page.paragraphs.some((p) => p.status === 'idle')) {
        void translatePage(page);
      }
    }
  }
});

retryBtn.addEventListener('click', () => {
  for (const page of pages) {
    if (page.paragraphs.some((p) => p.status === 'error')) {
      void translatePage(page);
    }
  }
});

main().catch((e: unknown) => {
  fatal(`阅读器发生未预期错误：${e instanceof Error ? e.message : String(e)}`);
});