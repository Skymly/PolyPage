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
import { sendRuntime, VIEWER_RESUME_TYPE } from '../messaging/messages';
import { PDF_FETCH_TIMEOUT_MS, PDF_MAX_BYTES } from '../shared/constants';
import type { PdfViewerMode } from '../shared/types';
import { openPdfDocument } from './pdf/loader';
import type { PdfDocumentLike, PdfPageLike } from './pdf/loader';
import {
  blankCanvas,
  cleanupPdfPage,
  extractPageTextThenCleanup,
  releaseOffscreenPage,
} from './pdf/pageLifecycle';
import {
  clusterOptionsForPreset,
  extractLines,
} from './pdf/segment';
import type { PdfLayoutPreset, TextItemLike } from './pdf/segment';
import { bookmarkSections, pageParagraphs, sampleHeaders } from './pdf/sections';
import type { ExtractedPage } from './pdf/sections';
import { chooseFingerprint, pdfCacheScope } from './pdf/fingerprint';
import { bilingualPdfHtml } from './pdf/htmlExport';
import { matchPdfResumeTasks, pdfParagraphKey } from './resume';
import {
  assignPdfDstRetryClick,
  keepExistingParas,
  pdfTranslateAborted,
  scannedOcrParaFromSegment,
} from './parasDom';
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
const pageNumberEl = $<HTMLInputElement>('page-number');
const localFile = $<HTMLInputElement>('local-file');
const exportBtn = $<HTMLButtonElement>('export-btn');
const pageLayout = $<HTMLSelectElement>('page-layout');
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
  bounds?: [number, number, number, number];
  section?: string;
  requestVersion?: number;
  replayedAfterDisconnect?: boolean;
  status: 'idle' | 'pending' | 'done' | 'error';
  translated: string | null;
  error: string | null;
  el: HTMLElement | null;
}

interface PageState {
  index: number; // 1-based pdf.js page number
  pdfPage: PdfPageLike | null;
  loaded: boolean;
  paragraphs: ParaState[];
  scanned: boolean;
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  rendered: boolean;
  workStarted: boolean;
  renderGen: number;
  busy: boolean;
  wanted: boolean;
  lastLocalSection?: string;
  layout?: PdfLayoutPreset;
  viewport?: ReturnType<PdfPageLike['getViewport']>;
}

let mode: ViewerMode = 'bilingual';
const pages: PageState[] = [];
const pagesByNumber = new Map<number, PageState>();
/** Kept so off-screen pages can re-getPage after cleanup (M-65). */
let pdfDoc: PdfDocumentLike | null = null;
let fingerprint = '';
let documentTitle = '';
let currentPage = 1;
let maxConcurrentPages = 3;
let skipHeadersFooters = true;
const translateWork = new AbortController();
let scannedPageOcr = true;
let layoutPreset: 'auto' | 'single' | 'columns' | 'table' = 'auto';
let maxEdgePx = 4096;
let ocrEngineId = 'llm-vision';
let scannedOcrCount = 0;
let activeCount = 0;
/** Set after chrome.tabs.getCurrent so resume broadcasts can filter this tab. */
let viewerTabId: number | undefined;

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
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), PDF_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', signal: ac.signal });
  } finally {
    window.clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`下载 PDF 失败（HTTP ${res.status}）`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType !== '' && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    throw new Error(`该地址返回的不是 PDF（Content-Type: ${contentType}）`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PDF_MAX_BYTES) {
    throw new Error(`PDF 超过大小上限（${PDF_MAX_BYTES} 字节）`);
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error('下载的 PDF 内容为空');
  if (bytes.byteLength > PDF_MAX_BYTES) {
    throw new Error(`PDF 超过大小上限（${PDF_MAX_BYTES} 字节）`);
  }
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

async function main(file?: File): Promise<void> {
  const url = sourceUrl();
  if (!url && !file) {
    docEl.setAttribute('aria-busy', 'false');
    return;
  }
  fatalEl.classList.add('hidden');
  docEl.setAttribute('aria-busy', 'true');
  try {
    viewerTabId = (await chrome.tabs.getCurrent())?.id;
  } catch {
    viewerTabId = undefined;
  }
  let fileName = file?.name ?? (url && new URL(url).pathname.split('/').pop()) ?? 'document.pdf';
  if (!file) { try { fileName = decodeURIComponent(fileName); } catch { /* keep the URL filename */ } }
  titleEl.textContent = fileName;
  titleEl.title = file?.name ?? url ?? fileName;

  const settings = await sendRuntime({ type: 'get-viewer-settings' });
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
    if (file) {
      if (!file.size || file.size > PDF_MAX_BYTES) throw new Error('请选择大小不超过 50 MB 的非空 PDF 文件。');
      fetched = { bytes: await file.arrayBuffer(), etag: null, lastModified: null };
    } else {
      fetched = await fetchPdf(url!);
    }
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
  pdfDoc = doc;
  documentTitle = fileName;
  const metadata = doc.getMetadata().then(({ info }) => {
    if (typeof info?.Title === 'string' && info.Title.trim()) documentTitle = info.Title.trim();
  }).catch(() => undefined);
  localFile.closest('label')?.classList.add('hidden');
  $<HTMLElement>('open-another').classList.remove('hidden');
  pageNumberEl.max = String(doc.numPages);
  $<HTMLElement>('page-total').textContent = `/ ${doc.numPages}`;
  $<HTMLElement>('page-jump').classList.remove('hidden');
  exportBtn.disabled = false;

  try {
    await buildPages(doc, metadata);
  } catch (e) {
    fatal(`读取 PDF 页面失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  docEl.setAttribute('aria-busy', 'false');
  updateProgress();

  try {
    const pending = await sendRuntime({ type: 'get-inflight', tabId: viewerTabId });
    if (pending.tasks.length > 0) void resumePdfInflight(pending.tasks);
  } catch {
    /* resume is best-effort */
  }

  window.addEventListener('pagehide', () => {
    translateWork.abort();
    for (const p of pages) releaseOffscreenPage(p);
    pdfDoc = null;
    void doc.destroy().catch(() => undefined);
  });
}

/* ------------------------------ extraction pass ------------------------------- */

let sample = new Map<number, Promise<ExtractedPage>>();
let headerSignatures: Promise<Set<string>> = Promise.resolve(new Set());
let bookmarks: ReturnType<typeof bookmarkSections> | undefined;
const candidates = new Set<PageState>();
const translating = new Set<PageState>();

async function extractPage(doc: PdfDocumentLike, index: number, layout = layoutPreset): Promise<ExtractedPage> {
  const pdfPage = await doc.getPage(index);
  return extractPageTextThenCleanup(pdfPage, (items) =>
    extractLines(items as TextItemLike[], clusterOptionsForPreset(layout)),
  );
}

async function loadParagraphs(page: PageState): Promise<void> {
  if (!pdfDoc || page.loaded) return;
  const [raw, repeating] = await Promise.all([
    page.layout ? extractPage(pdfDoc, page.index, page.layout) : sample.get(page.index) ?? extractPage(pdfDoc, page.index),
    headerSignatures,
  ]);
  const cluster = clusterOptionsForPreset(page.layout ?? layoutPreset);
  const { paragraphs, scanned } = pageParagraphs(raw, repeating, cluster);
  page.lastLocalSection = paragraphs.at(-1)?.section;
  let inherited: string | undefined;
  if (paragraphs.length && !paragraphs[0].section) {
    bookmarks ??= bookmarkSections(pdfDoc).catch(() => []);
    inherited = (await bookmarks).filter((s) => s.page <= page.index).at(-1)?.title;
    if (!inherited && page.index > 1) {
      const previous = pagesByNumber.get(page.index - 1);
      if (previous?.loaded) inherited = previous.lastLocalSection;
      else {
        try {
          const rawPrevious = await (sample.get(page.index - 1) ?? extractPage(pdfDoc, page.index - 1));
          inherited = pageParagraphs(rawPrevious, repeating, cluster).paragraphs.at(-1)?.section;
        } catch { /* a damaged previous page must not block this page */ }
      }
    }
  }
  page.paragraphs = paragraphs.map((p) => {
    return { ...p, section: p.section ?? inherited, status: 'idle', translated: null, error: null, el: null };
  });
  page.scanned = scanned;
  page.loaded = true;
  placeSourceLinks(page);
}

async function buildPages(doc: PdfDocumentLike, metadata: Promise<void>): Promise<void> {
  const io = new IntersectionObserver((records) => {
    for (const rec of records) {
      const page = pagesByNumber.get(Number((rec.target as HTMLElement).dataset.page))!;
      page.wanted = rec.isIntersecting;
      if (page.wanted) candidates.add(page);
      else {
        candidates.delete(page);
        releaseOffscreenPage(page);
      }
    }
    scheduleVisible();
  }, { rootMargin: '400px 0px' });

  function appendShell(index: number, parent: HTMLElement): PageState {
    const container = document.createElement('section');
    container.className = 'page';
    container.dataset.page = String(index);
    container.setAttribute('aria-label', `第 ${index} 页`);
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    const typical = pages[0]?.viewport;
    if (typical) {
      sheet.style.width = `${typical.width}px`;
      sheet.style.aspectRatio = `${typical.width} / ${typical.height}`;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 0;
    canvas.height = 0;
    sheet.appendChild(canvas);
    container.appendChild(sheet);
    parent.appendChild(container);
    const page: PageState = {
      index, loaded: false, pdfPage: null, paragraphs: [], scanned: false,
      canvas, container, rendered: false, workStarted: false, renderGen: 0, busy: false, wanted: false,
    };
    pages.push(page);
    pagesByNumber.set(index, page);
    io.observe(container);
    return page;
  }

  const first = appendShell(1, docEl);
  first.wanted = true;
  first.busy = true;
  if (skipHeadersFooters) {
    // Use a fixed sample so revisiting pages in a different order preserves paragraph IDs and cache hits.
    const sampled = sampleHeaders(doc.numPages, (i) => extractPage(doc, i));
    sample = sampled.pages;
    headerSignatures = sampled.signatures;
  }
  try { await renderPage(first); } catch { /* extracted text can still be read */ }
  await metadata;
  first.busy = false;
  candidates.add(first);
  scheduleVisible();
  // Let the first canvas paint before allocating the remaining scroll placeholders.
  const groupSize = 16;
  const groups = new Map<number, HTMLElement>();
  function expandGroup(start: number): void {
    const group = groups.get(start);
    if (!group || group.hasChildNodes()) return;
    groupObserver.unobserve(group);
    for (let i = start; i <= Math.min(doc.numPages, start + groupSize - 1); i++) appendShell(i, group);
    group.style.height = '';
  }
  const groupObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) expandGroup(Number((entry.target as HTMLElement).dataset.start));
    }
  }, { rootMargin: '500px 0px' });
  function installGroups(): void {
    if (groups.size) return;
    const height = first.container.getBoundingClientRect().height + 18;
    const fragment = document.createDocumentFragment();
    for (let start = 2; start <= doc.numPages; start += groupSize) {
      const group = document.createElement('div');
      group.dataset.start = String(start);
      group.style.height = `${height * Math.min(groupSize, doc.numPages - start + 1)}px`;
      groups.set(start, group);
      fragment.appendChild(group);
      groupObserver.observe(group);
    }
    docEl.appendChild(fragment);
  }
  let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(installGroups); });
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frame); io.disconnect(); groupObserver.disconnect();
  }, { once: true });

  $('page-jump').addEventListener('submit', (event) => {
    event.preventDefault();
    const number = pageNumberEl.valueAsNumber;
    if (!Number.isInteger(number) || number < 1 || number > doc.numPages) return;
    if (!pagesByNumber.has(number)) {
      installGroups();
      expandGroup(2 + Math.floor((number - 2) / groupSize) * groupSize);
    }
    const page = pagesByNumber.get(number)!;
    currentPage = number;
    page.container.scrollIntoView({ block: 'start' });
    page.wanted = true;
    candidates.add(page);
    scheduleVisible();
  });
}

function updateCurrentPage(): void {
  const belowToolbar = $('toolbar').getBoundingClientRect().bottom + 25;
  const visible = [...candidates].filter((p) => p.container.getBoundingClientRect().bottom >= belowToolbar);
  visible.sort((a, b) => a.index - b.index);
  if (visible.length) currentPage = visible[0].index;
  if (document.activeElement !== pageNumberEl) pageNumberEl.value = String(currentPage);
  syncLayoutControl();
}

function syncLayoutControl(): void {
  const page = pagesByNumber.get(currentPage);
  pageLayout.value = page?.layout ?? layoutPreset;
  pageLayout.disabled = !page?.loaded || !page.paragraphs.some((p) => p.bounds);
}

function scheduleVisible(): void {
  if (translateWork.signal.aborted) return;
  const pending = [...candidates].filter((p) => p.wanted && !p.busy && (!p.rendered || !p.workStarted));
  pending.sort((a, b) => Math.abs(a.index - currentPage) - Math.abs(b.index - currentPage));
  for (const page of pending) {
    if (activeCount >= maxConcurrentPages) break;
    activeCount++;
    page.busy = true;
    void workPage(page).catch((error: unknown) => {
      let notice = page.container.querySelector<HTMLButtonElement>('.page-error');
      if (!notice) {
        notice = document.createElement('button');
        notice.className = 'page-error';
        page.container.appendChild(notice);
      }
      notice.textContent = `页面读取失败，点击重试（${error instanceof Error ? error.message : error}）`;
      notice.onclick = () => { notice.remove(); candidates.add(page); scheduleVisible(); };
      candidates.delete(page);
    }).finally(() => {
      activeCount--;
      page.busy = false;
      scheduleVisible();
    });
  }
  if (mode === 'original') return;
  const needingTranslation = [...candidates].filter((p) =>
    p.wanted && p.workStarted && !translating.has(p) && p.paragraphs.some((para) => para.status === 'idle'));
  needingTranslation.sort((a, b) => Math.abs(a.index - currentPage) - Math.abs(b.index - currentPage));
  for (const page of needingTranslation) {
    if (translating.size >= maxConcurrentPages) break;
    translating.add(page);
    void translatePage(page).finally(() => { translating.delete(page); scheduleVisible(); });
  }
}

async function workPage(page: PageState): Promise<void> {
  if (!page.rendered) {
    try { await renderPage(page); } catch {
      // Keep an extracted-text fallback and avoid repeated render attempts while visible.
      page.rendered = true;
    }
  }
  if (!page.wanted || page.workStarted) return;
  await loadParagraphs(page);
  if (!page.wanted) return;
  page.workStarted = true;
  ensureParasDom(page);
  renderPageParas(page);
  updateProgress();
}

async function renderPage(page: PageState): Promise<void> {
  if (!pdfDoc) return;
  const gen = page.renderGen;
  const pdfPage = await pdfDoc.getPage(page.index);
  page.pdfPage = pdfPage;
  try {
    const base = pdfPage.getViewport({ scale: 1 });
    const available = Math.max(docEl.clientWidth - 60, 320);
    const scale = Math.min(2.2, Math.max(0.6, available / base.width));
    const viewport = pdfPage.getViewport({ scale });
    page.viewport = viewport;
    const sheet = page.canvas.parentElement!;
    sheet.style.width = `${viewport.width}px`;
    sheet.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    page.canvas.width = Math.floor(viewport.width * dpr);
    page.canvas.height = Math.floor(viewport.height * dpr);
    page.canvas.style.width = `${Math.floor(viewport.width)}px`;
    page.canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = page.canvas.getContext('2d');
    if (!ctx) throw new Error('无法初始化 PDF 画布');
    ctx.scale(dpr, dpr);
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    if (page.renderGen !== gen) {
      blankCanvas(page.canvas);
      return;
    }
    page.rendered = true;
    if (page.loaded) placeSourceLinks(page);
  } finally {
    cleanupPdfPage(pdfPage);
    page.pdfPage = null;
  }
}

/* ------------------------------- translation ---------------------------------- */

const CHUNK = 8;

async function translatePage(page: PageState, includeOffscreen = false, subset = page.paragraphs): Promise<void> {
  const paragraphs = page.paragraphs;
  if (page.scanned) {
    showScannedHint(page);
    return;
  }
  const todo = subset.filter((p) => p.status === 'idle' || p.status === 'error');
  if (todo.length === 0) return;
  ensureParasDom(page);
  renderPageParas(page);

  for (let i = 0; i < todo.length; i += CHUNK) {
    if (page.paragraphs !== paragraphs || pdfTranslateAborted(translateWork.signal)) return;
    if ((!page.wanted || mode === 'original') && !includeOffscreen) return;
    const chunk = todo.slice(i, i + CHUNK);
    const ready = chunk.filter((p) => p.status === 'idle' || p.status === 'error');
    if (!ready.length) continue;
    const versions = ready.map((para) => {
      para.status = 'pending';
      para.error = null;
      return para.requestVersion = (para.requestVersion ?? 0) + 1;
    });
    const items = ready.map((para) => {
      const paraIndex = page.paragraphs.indexOf(para);
      return {
        key: pdfParagraphKey(page.index, paraIndex),
        text: para.text,
        cacheScope: pdfCacheScope(fingerprint, page.index, paraIndex),
        documentContext: { title: documentTitle, section: para.section },
      };
    });
    try {
      const res = await sendRuntime({
        type: 'translate',
        items,
        domain: 'pdf-viewer',
        tabId: viewerTabId,
      });
      if (page.paragraphs !== paragraphs) return;
      ready.forEach((para, index) => {
        if (para.requestVersion !== versions[index]) return;
        const key = pdfParagraphKey(page.index, page.paragraphs.indexOf(para));
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
      if (page.paragraphs !== paragraphs) return;
      const message = e instanceof Error ? e.message : String(e);
      ready.forEach((para, index) => {
        if (para.requestVersion !== versions[index]) return;
        para.status = 'error';
        para.error = message;
      });
      if (/channel closed|Receiving end does not exist|message port closed/i.test(message)) {
        scheduleInflightPull();
        // A worker can terminate before its in-flight record is durable.
        // Replay once if the restart broadcast missed this interrupted batch.
        window.setTimeout(() => {
          if (translateWork.signal.aborted || page.paragraphs !== paragraphs) return;
          const missed = ready.filter((p, index) =>
            p.requestVersion === versions[index] && p.status === 'error' && !p.replayedAfterDisconnect);
          for (const p of missed) { p.replayedAfterDisconnect = true; p.status = 'idle'; }
          if (missed.length) void translatePage(page, true, missed);
        }, 800);
      }
    }
    renderPageParas(page);
    updateProgress();
  }
}

async function resumePdfInflight(tasks: Array<{ key: string; textHash: string }>): Promise<boolean> {
  if (tasks.length === 0 || pages.length === 0 || fingerprint === '') return false;
  const hits = matchPdfResumeTasks(pages, tasks, fingerprint);
  if (hits.length === 0) return false;
  const pageSet = new Set<PageState>();
  for (const hit of hits) {
    hit.para.status = 'idle';
    hit.para.error = null;
    pageSet.add(hit.page as PageState);
  }
  for (const page of pageSet) {
    page.workStarted = true;
    void translatePage(page, true);
  }
  return true;
}

let inflightPullScheduled = false;
function scheduleInflightPull(): void {
  if (inflightPullScheduled) return;
  inflightPullScheduled = true;
  void (async () => {
    try {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const pending = await sendRuntime({ type: 'get-inflight', tabId: viewerTabId });
          if (pending.tasks.length > 0) {
            await resumePdfInflight(pending.tasks);
            return;
          }
        } catch {
          /* SW still down */
        }
      }
    } finally {
      inflightPullScheduled = false;
    }
  })();
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const msg = message as { type?: string; tabId?: number; tasks?: Array<{ key: string; textHash: string }> };
  if (msg.type !== VIEWER_RESUME_TYPE) return;
  if (viewerTabId !== undefined && msg.tabId !== undefined && viewerTabId !== msg.tabId) {
    return;
  }
  void resumePdfInflight(msg.tasks ?? []).then((accepted) => sendResponse({ ok: accepted }));
  return true;
});

/* --------------------------------- rendering ---------------------------------- */

function selectParagraph(page: PageState, index: number, target: 'source' | 'translation'): void {
  const scope = page.container;
  scope.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
  const hit = scope.querySelector<HTMLElement>(`.source-hit[data-index="${index}"]`);
  const para = page.paragraphs[index]?.el;
  hit?.classList.add('selected');
  para?.classList.add('selected');
  const destination = target === 'source' ? hit ?? page.canvas : para;
  destination?.scrollIntoView({ block: 'center' });
  destination?.focus({ preventScroll: true });
}

function placeSourceLinks(page: PageState): void {
  const viewport = page.viewport;
  if (!viewport) return;
  const sheet = page.canvas.parentElement!;
  if (sheet.querySelector('.source-links')) return;
  const layer = document.createElement('div');
  layer.className = 'source-links';
  page.paragraphs.forEach((para, index) => {
    if (!para.bounds) return;
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(para.bounds);
    const hit = document.createElement('button');
    hit.className = 'source-hit';
    hit.dataset.index = String(index);
    hit.title = `查看第 ${index + 1} 段译文`;
    hit.setAttribute('aria-label', hit.title);
    hit.style.left = `${100 * Math.min(x0, x1) / viewport.width}%`;
    hit.style.top = `${100 * Math.min(y0, y1) / viewport.height}%`;
    hit.style.width = `${100 * Math.abs(x1 - x0) / viewport.width}%`;
    hit.style.height = `${100 * Math.abs(y1 - y0) / viewport.height}%`;
    hit.onclick = () => selectParagraph(page, index, 'translation');
    layer.appendChild(hit);
  });
  sheet.appendChild(layer);
}

function ensureParasDom(page: PageState): void {
  const existing = page.container.querySelector('.paras');
  if (keepExistingParas(existing, page.scanned, page.paragraphs)) return;
  existing?.remove();
  for (const para of page.paragraphs) para.el = null;
  const paras = document.createElement('div');
  paras.className = 'paras';
  page.container.appendChild(paras);
  if (page.scanned) {
    showScannedHint(page);
    return;
  }
  page.paragraphs.forEach((para, index) => {
    const el = document.createElement('div');
    el.className = 'para';
    el.tabIndex = -1;
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
    const locate = document.createElement('button');
    locate.className = 'source-location';
    locate.textContent = para.bounds ? `定位原文 · 第 ${index + 1} 段` : '定位扫描页';
    locate.onclick = () => selectParagraph(page, index, 'source');
    el.append(locate, src, dst, mark);
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
    if (!page.rendered || page.canvas.width === 0) await renderPage(page);
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
      ...scannedOcrParaFromSegment(seg),
      el: null,
    }));
    page.scanned = false;
    hint.remove();
    page.container.querySelector('.paras')?.remove();
    for (const para of page.paragraphs) para.el = null;
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
      assignPdfDstRetryClick(dst, 'idle', () => undefined);
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
    } else {
      dst.textContent = '翻译中…';
      dst.classList.add('pending');
      mark.style.display = 'none';
    }
    assignPdfDstRetryClick(dst, para.status, () => {
      para.status = 'idle';
      void translatePage(page);
    });
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
  syncLayoutControl();
  const { done, total, failed } = progressCounts();
  const scannedPages = pages.filter((p) => p.scanned).length;
  let text = total > 0 ? `已读段落：已译 ${done}/${total}` : '—';
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

pageLayout.addEventListener('change', () => {
  const page = pagesByNumber.get(currentPage);
  if (!page?.loaded) return;
  page.layout = pageLayout.value as PdfLayoutPreset;
  page.loaded = false;
  page.workStarted = false;
  page.paragraphs = [];
  page.container.querySelector('.paras')?.remove();
  page.container.querySelector('.source-links')?.remove();
  pageLayout.disabled = true;
  scheduleVisible();
});

modeSelect.addEventListener('change', () => {
  const next = modeSelect.value as ViewerMode;
  mode = next;
  hideTooltip();
  rerenderAll();
  scheduleVisible();
});

retryBtn.addEventListener('click', () => {
  for (const page of pages) {
    if (page.paragraphs.some((p) => p.status === 'error')) {
      void translatePage(page, true);
    }
  }
});

let scrollFrame = 0;
window.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateCurrentPage(); });
}, { passive: true });

exportBtn.addEventListener('click', () => {
  if (!pdfDoc) return;
  const onlyCurrent = $<HTMLSelectElement>('export-range').value === 'page';
  const first = onlyCurrent ? currentPage : 1;
  const last = onlyCurrent ? currentPage : pdfDoc.numPages;
  const html = bilingualPdfHtml(documentTitle, first, last, (n) => pagesByNumber.get(n));
  const anchor = document.createElement('a');
  const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  anchor.href = blobUrl;
  const base = (titleEl.textContent ?? 'document').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_');
  anchor.download = `${base}.${onlyCurrent ? `p${first}.` : ''}bilingual.html`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
});

localFile.addEventListener('change', () => {
  const file = localFile.files?.[0];
  if (!file) return;
  localFile.disabled = true;
  void main(file).catch((e: unknown) => fatal(String(e))).finally(() => {
    localFile.value = ''; localFile.disabled = false;
  });
});

localFile.disabled = sourceUrl() !== null;
main().catch((e: unknown) => {
  fatal(`阅读器发生未预期错误：${e instanceof Error ? e.message : String(e)}`);
}).finally(() => { localFile.disabled = false; });
