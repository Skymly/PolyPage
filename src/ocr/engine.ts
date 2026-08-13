/**
 * OcrEngine abstraction (spec 3.0 §6.1): thinner than the Provider
 * abstraction, parallel to it. Engines turn one image into structured
 * `{ text, translation }` segments.
 *
 *  - llm-vision (P0): one multimodal call returns segments directly;
 *  - tesseract-wasm (P1, dynamic chunk): local OCR text -> existing text
 *    translation pipeline (two-step, offline capable).
 */
import type { OcrEngineId, OcrResult } from '../shared/types';
import type { TranslationContext } from '../providers/provider';

export interface ImageInput {
  /** Data URL of the (possibly downsampled) image. */
  dataUrl: string;
}

export interface OcrEngine {
  readonly id: OcrEngineId;
  /**
   * One-shot recognition + translation. `tesseract-wasm` fills only `text`
   * and leaves `translation` to the text pipeline (spec 3.0 §6.1 item 2).
   */
  recognize(input: ImageInput, ctx: TranslationContext, signal: AbortSignal): Promise<OcrResult>;
}

/** Engines that require a provider with vision support. */
export function engineNeedsVisionProvider(id: OcrEngineId): boolean {
  return id === 'llm-vision';
}