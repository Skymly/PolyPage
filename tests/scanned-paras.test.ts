/**
 * Scanned-page OCR must rebuild paragraph DOM (M-08).
 */
import { describe, expect, it } from 'vitest';
import { keepExistingParas, scannedOcrParaFromSegment, pdfDstNeedsRetryClick, assignPdfDstRetryClick, pdfTranslateAborted } from '../src/viewer/parasDom';

const existing = {} as Element;

describe('keepExistingParas (M-08)', () => {
  it('keeps a scanned-page placeholder', () => {
    expect(keepExistingParas(existing, true, [])).toBe(true);
  });

  it('keeps populated paragraph nodes', () => {
    expect(keepExistingParas(existing, false, [{ el: {} }])).toBe(true);
  });

  it('does not keep the empty scanned placeholder after OCR fills paragraphs', () => {
    expect(keepExistingParas(existing, false, [{ el: null }])).toBe(false);
  });

  it('creates a new layer when none exists', () => {
    expect(keepExistingParas(null, false, [{ el: null }])).toBe(false);
  });

  it('keeps empty OCR translations as error instead of copying source (M-33)', () => {
    expect(scannedOcrParaFromSegment({ text: 'HELLO', translation: '你好' })).toEqual({
      text: 'HELLO',
      status: 'done',
      translated: '你好',
      error: null,
    });
    expect(scannedOcrParaFromSegment({ text: 'HELLO', translation: '  ' })).toEqual({
      text: 'HELLO',
      status: 'error',
      translated: null,
      error: '译文为空',
    });
  });

  it('only error paragraphs keep a retry click handler (M-89)', () => {
    expect(pdfDstNeedsRetryClick('error')).toBe(true);
    expect(pdfDstNeedsRetryClick('done')).toBe(false);
    expect(pdfDstNeedsRetryClick('pending')).toBe(false);

    const dst: { onclick: ((this: GlobalEventHandlers, ev: PointerEvent) => unknown) | null } = {
      onclick: () => undefined,
    };
    assignPdfDstRetryClick(dst, 'error', () => undefined);
    expect(dst.onclick).not.toBeNull();
    assignPdfDstRetryClick(dst, 'done', () => undefined);
    expect(dst.onclick).toBeNull();
  });

  it('stops PDF translate after pagehide abort (M-89)', () => {
    const ac = new AbortController();
    expect(pdfTranslateAborted(ac.signal)).toBe(false);
    ac.abort();
    expect(pdfTranslateAborted(ac.signal)).toBe(true);
  });
});
