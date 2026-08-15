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

export interface TessRecognizeFn {
  (input: { dataUrl: string; langs: string[] }, signal: AbortSignal): Promise<{ text: string }>;
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
    try {
      const fn = this.recognizeRaw ?? loadVendoredRecognizer;
      const raw = await fn({ dataUrl: input.dataUrl, langs: this.langs }, signal);
      rawText = raw.text ?? '';
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      const kind = /wasm|load|fetch|import|network/i.test(message) ? 'config' : 'invalid_response';
      throw new ProviderError(kind, `Tesseract 识别失败: ${message}`);
    }
    const fragments = splitOcrText(rawText);
    const segments: OcrSegment[] = fragments.map((text) => ({ text, translation: '' }));
    return { engine: this.id, segments };
  }
}

/**
 * Production recognizer: dynamically import vendored tesseract.js and point
 * it at locally packaged worker / core / traineddata (spec 4.0 §7.1).
 */
async function loadVendoredRecognizer(
  input: { dataUrl: string; langs: string[] },
  signal: AbortSignal,
): Promise<{ text: string }> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) {
    throw new ProviderError('config', 'Tesseract WASM 只能在扩展后台加载');
  }
  const lang = (input.langs.length > 0 ? input.langs : DEFAULT_TESS_LANGS).join('+');
  const vendor = (name: string) => chrome.runtime.getURL(`vendor/${name}`);
  let createWorker: (typeof import('tesseract.js'))['createWorker'];
  try {
    const mod = (await import(/* @vite-ignore */ vendor('tesseract.esm.min.js'))) as {
      createWorker: (typeof import('tesseract.js'))['createWorker'];
    };
    createWorker = mod.createWorker;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ProviderError('config', `Tesseract WASM 加载失败: ${message}`);
  }
  if (signal.aborted) throw new ProviderError('aborted', '已取消');
  const worker = await createWorker(lang, 1, {
    workerPath: vendor('tesseract-worker.min.js'),
    corePath: vendor('tesseract-core-simd-lstm.wasm.js'),
    langPath: vendor('tessdata'),
    workerBlobURL: false,
    gzip: false,
  });
  try {
    if (signal.aborted) throw new ProviderError('aborted', '已取消');
    const { data } = await worker.recognize(input.dataUrl);
    return { text: data?.text ?? '' };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new ProviderError('invalid_response', `Tesseract 识别失败: ${message}`);
  } finally {
    await worker.terminate();
  }
}
