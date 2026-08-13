/**
 * tesseract-wasm engine (spec 3.0 §6.1 item 2, P1 — scheduled for 3.1).
 *
 * Local WASM OCR produces text, which then flows through the existing text
 * translation pipeline (two-step, offline OCR + online translation).
 *
 * 3.0 ships the registration shape so settings/UI can reference the engine
 * id; the WASM payload itself is a dynamically loaded chunk to keep the base
 * bundle small, and is not bundled yet.
 */
import { ProviderError } from '../providers/provider';
import type { TranslationContext } from '../providers/provider';
import type { ImageInput, OcrEngine } from './engine';
import type { OcrResult } from '../shared/types';

export class TesseractEngine implements OcrEngine {
  readonly id = 'tesseract-wasm';

  async recognize(
    _input: ImageInput,
    _ctx: TranslationContext,
    _signal: AbortSignal,
  ): Promise<OcrResult> {
    throw new ProviderError(
      'config',
      'Tesseract WASM 引擎将在 3.1 提供（P1 项），当前请使用 llm-vision',
    );
  }
}