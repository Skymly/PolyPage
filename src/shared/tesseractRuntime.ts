/**
 * Whether this global can run tesseract.js createWorker (M-02).
 *
 * Chrome MV3 service workers have no Worker. Firefox event pages do.
 * Chrome can fall back to an offscreen document.
 */

export type TesseractRuntimeMode = 'worker' | 'offscreen' | 'unavailable';

export function resolveTesseractRuntime(hasWorker: boolean, hasOffscreen: boolean): TesseractRuntimeMode {
  if (hasWorker) return 'worker';
  if (hasOffscreen) return 'offscreen';
  return 'unavailable';
}

export function tesseractRuntimeAvailable(): boolean {
  return resolveTesseractRuntime(
    typeof Worker === 'function',
    typeof chrome !== 'undefined' && typeof chrome.offscreen?.createDocument === 'function',
  ) !== 'unavailable';
}

export function computeOcrAvailable(
  enabled: boolean,
  engine: 'tesseract-wasm' | 'llm-vision',
  vision: boolean,
  tessRuntime: boolean,
): boolean {
  if (!enabled) return false;
  if (engine === 'tesseract-wasm') return tessRuntime;
  return vision;
}

/** Vendored tesseract.esm.min.js is a CJS wrap that only `export default`. */
export function resolveCreateWorker(mod: unknown): (typeof import('tesseract.js'))['createWorker'] {
  const rec = mod && typeof mod === 'object' ? (mod as Record<string, unknown>) : {};
  const nested =
    rec.default && typeof rec.default === 'object' ? (rec.default as Record<string, unknown>) : rec;
  const createWorker = nested.createWorker ?? rec.createWorker;
  if (typeof createWorker !== 'function') {
    throw new Error('Tesseract WASM 模块缺少 createWorker');
  }
  return createWorker as (typeof import('tesseract.js'))['createWorker'];
}
