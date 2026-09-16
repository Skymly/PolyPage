/**
 * tesseract-wasm engine (spec 4.0 §7.1): local WASM OCR, then the existing
 * text translation pipeline (two-step). recognize() fills only `text`;
 * the background calls translateTexts afterwards.
 *
 * WASM / core scripts load via dynamic import of vendored files (never
 * inlined into content.js). Tests inject a recognizer stub so the two-step
 * contract does not need a real WASM runtime.
 */
import { DEFAULT_TESS_LANGS } from '../shared/constants';
import { ProviderError } from '../providers/provider';
import type { TranslationContext } from '../providers/provider';
import type { ImageInput, OcrEngine } from './engine';
import type { OcrResult, OcrSegment } from '../shared/types';
import { resolveTesseractRuntime, resolveCreateWorker } from '../shared/tesseractRuntime';

export interface TessLineBox {
  text: string;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

export interface TessRecognizeFn {
  (input: { dataUrl: string; langs: string[] }, signal: AbortSignal): Promise<{ text: string; lines?: TessLineBox[] }>;
}

/** Split OCR output into non-empty paragraph-like fragments. */
export function splitOcrText(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export class TesseractEngine implements OcrEngine {
  readonly id = 'tesseract-wasm' as const;

  constructor(
    private readonly recognizeRaw?: TessRecognizeFn,
    private readonly langs: string[] = DEFAULT_TESS_LANGS,
  ) {}

  async recognize(
    input: ImageInput,
    _ctx: TranslationContext,
    signal: AbortSignal,
  ): Promise<OcrResult> {
    if (signal.aborted) throw new ProviderError('aborted', '已取消');
    let rawText: string;
    let lines: TessLineBox[] | undefined;
    try {
      const fn = this.recognizeRaw ?? loadVendoredRecognizer;
      const raw = await fn({ dataUrl: input.dataUrl, langs: this.langs }, signal);
      rawText = raw.text ?? '';
      lines = raw.lines;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      const kind = /wasm|load|fetch|import|network/i.test(message) ? 'config' : 'invalid_response';
      throw new ProviderError(kind, `Tesseract 识别失败: ${message}`);
    }
    if (lines && lines.length > 0) {
      const segments: OcrSegment[] = lines
        .map((line) => ({
          text: line.text.trim(),
          translation: '',
          ...(line.bbox ? { bbox: line.bbox } : {}),
        }))
        .filter((s) => s.text.length > 0);
      if (segments.length > 0) return { engine: this.id, segments };
    }
    const fragments = splitOcrText(rawText);
    const segments: OcrSegment[] = fragments.map((text) => ({ text, translation: '' }));
    return { engine: this.id, segments };
  }
}

/**
 * Production recognizer: dynamically import vendored tesseract.js and point
 * it at locally packaged worker / core / traineddata (spec 4.0 §7.1).
 *
 * Chrome service workers cannot `new Worker`. Firefox event pages can.
 * When Worker is missing, Chrome offscreen documents run createWorker.
 */
async function loadVendoredRecognizer(
  input: { dataUrl: string; langs: string[] },
  signal: AbortSignal,
): Promise<{ text: string; lines?: TessLineBox[] }> {
  const mode = resolveTesseractRuntime(
    typeof Worker === 'function',
    typeof chrome !== 'undefined' && typeof chrome.offscreen?.createDocument === 'function',
  );
  if (mode === 'unavailable') {
    throw new ProviderError('config', '当前后台无法运行本地 Tesseract');
  }
  if (mode === 'offscreen') {
    return recognizeViaOffscreen(input, signal);
  }
  return runVendoredCreateWorker(input, signal);
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification: 'Run tesseract.js Worker because the service worker cannot construct Worker',
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/already exists|Only a single offscreen/i.test(message)) {
      throw new ProviderError('config', `无法创建 OCR 后台页: ${message}`);
    }
  }
}

async function recognizeViaOffscreen(
  input: { dataUrl: string; langs: string[] },
  signal: AbortSignal,
): Promise<{ text: string; lines?: TessLineBox[] }> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) {
    throw new ProviderError('config', 'Tesseract WASM 只能在扩展后台加载');
  }
  await ensureOffscreenDocument();
  if (signal.aborted) throw new ProviderError('aborted', '已取消');
  const request = sendRecognizeToOffscreen(input, signal);
  const response = await new Promise<{ ok?: boolean; text?: string; lines?: TessLineBox[]; error?: string } | undefined>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new ProviderError('invalid_response', 'Tesseract 识别超时')), 90_000);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ProviderError('aborted', '已取消'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      request.then(
        (value) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    },
  );
  if (!response?.ok) {
    throw new ProviderError('invalid_response', response?.error ?? 'Tesseract 识别失败');
  }
  return { text: response.text ?? '', lines: response.lines };
}

async function sendRecognizeToOffscreen(
  input: { dataUrl: string; langs: string[] },
  signal: AbortSignal,
): Promise<{ ok?: boolean; text?: string; lines?: TessLineBox[]; error?: string } | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal.aborted) throw new ProviderError('aborted', '已取消');
    try {
      return (await chrome.runtime.sendMessage({
        type: 'tesseract-recognize',
        dataUrl: input.dataUrl,
        langs: input.langs,
      })) as { ok?: boolean; text?: string; lines?: TessLineBox[]; error?: string } | undefined;
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      if (!/Receiving end does not exist|Could not establish connection/i.test(message) || attempt === 3) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Direct tesseract.js createWorker path. Used by Firefox event pages and by
 * the Chrome offscreen document (both expose Worker).
 */
export async function runVendoredCreateWorker(
  input: { dataUrl: string; langs: string[] },
  signal: AbortSignal,
): Promise<{ text: string; lines?: TessLineBox[] }> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) {
    throw new ProviderError('config', 'Tesseract WASM 只能在扩展后台加载');
  }
  const lang = (input.langs.length > 0 ? input.langs : DEFAULT_TESS_LANGS).join('+');
  const vendor = (name: string) => chrome.runtime.getURL(`vendor/${name}`);
  let createWorker: (typeof import('tesseract.js'))['createWorker'];
  try {
    const mod = await import(/* @vite-ignore */ vendor('tesseract.esm.min.js'));
    createWorker = resolveCreateWorker(mod);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ProviderError('config', `Tesseract WASM 加载失败: ${message}`);
  }
  if (signal.aborted) throw new ProviderError('aborted', '已取消');
  const tessGlobal = globalThis as unknown as { __ppTessLog?: unknown; __ppTessErr?: string };
  const worker = await createWorker(lang, 1, {
    workerPath: vendor('tesseract-worker.min.js'),
    corePath: vendor('tesseract-core-simd-lstm.wasm.js'),
    langPath: vendor('tessdata'),
    workerBlobURL: false,
    gzip: false,
    cacheMethod: 'none',
    errorHandler: (err) => {
      tessGlobal.__ppTessErr = err instanceof Error ? err.message : String(err);
    },
    logger: (m) => {
      tessGlobal.__ppTessLog = m;
    },
  });
  try {
    if (signal.aborted) throw new ProviderError('aborted', '已取消');
    const { data } = await worker.recognize(input.dataUrl);
    const page = data as unknown as { lines?: Array<{ text?: string; bbox?: { x0: number; y0: number; x1: number; y1: number } }> };
    const lines = Array.isArray(page.lines)
      ? page.lines
          .map((line) => ({
            text: (line.text ?? '').trim(),
            ...(line.bbox ? { bbox: line.bbox } : {}),
          }))
          .filter((line) => line.text.length > 0)
      : undefined;
    return { text: data?.text ?? '', lines };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new ProviderError('invalid_response', `Tesseract 识别失败: ${message}`);
  } finally {
    await worker.terminate();
  }
}
