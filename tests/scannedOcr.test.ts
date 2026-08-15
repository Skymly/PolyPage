/**
 * Scanned-page OCR cache key (spec 4.0 §7.2, §12.1):
 * fingerprint + page + image hash + engine id.
 */
import { describe, expect, it } from 'vitest';
import { imageHashFromDataUrl, scannedPageCacheText } from '../src/viewer/pdf/scannedOcr';

describe('scannedPageCacheText', () => {
  it('includes fingerprint, page, image hash and engine', () => {
    const key = scannedPageCacheText('fileid:abc', 3, 'deadbeef', 'tesseract-wasm');
    expect(key).toBe('pdfocr|fileid:abc|p3|deadbeef|tesseract-wasm');
  });

  it('changes when the engine or page changes', () => {
    const a = scannedPageCacheText('fileid:abc', 1, 'img1', 'llm-vision');
    const b = scannedPageCacheText('fileid:abc', 1, 'img1', 'tesseract-wasm');
    const c = scannedPageCacheText('fileid:abc', 2, 'img1', 'llm-vision');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('imageHashFromDataUrl', () => {
  it('is stable for the same payload and differs across images', () => {
    const a = imageHashFromDataUrl('data:image/png;base64,AAA');
    const b = imageHashFromDataUrl('data:image/png;base64,AAA');
    const c = imageHashFromDataUrl('data:image/png;base64,BBB');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
