/**
 * M-65: PDF pages must release pdf.js page objects and canvases.
 */
import { describe, expect, it } from 'vitest';
import {
  blankCanvas,
  cleanupPdfPage,
  extractPageTextThenCleanup,
  releaseOffscreenPage,
} from '../src/viewer/pdf/pageLifecycle';

function fakePage(opts: { throwOnText?: boolean } = {}) {
  let cleanupCalls = 0;
  const page = {
    getViewport: () => ({ width: 612, height: 792 }),
    getTextContent: async () => {
      if (opts.throwOnText) throw new Error('text layer missing');
      return { items: [{ str: 'Hello' }] };
    },
    cleanup: () => {
      cleanupCalls += 1;
    },
  };
  return {
    page,
    cleanupCount: () => cleanupCalls,
  };
}

describe('cleanupPdfPage', () => {
  it('calls cleanup when present', () => {
    const { page, cleanupCount } = fakePage();
    cleanupPdfPage(page);
    expect(cleanupCount()).toBe(1);
  });

  it('is a no-op for null', () => {
    expect(() => cleanupPdfPage(null)).not.toThrow();
  });
});

describe('extractPageTextThenCleanup (M-65)', () => {
  it('releases the page after a successful text extract', async () => {
    const { page, cleanupCount } = fakePage();
    const result = await extractPageTextThenCleanup(page, () => [
      { y: 0, gapBefore: 0, indent: 0, fontSize: 10, text: 'Hello' },
    ]);
    expect(result.pageHeight).toBe(792);
    expect(result.lines[0].text).toBe('Hello');
    expect(cleanupCount()).toBe(1);
  });

  it('still cleanup when getTextContent throws', async () => {
    const { page, cleanupCount } = fakePage({ throwOnText: true });
    const result = await extractPageTextThenCleanup(page, () => []);
    expect(result.lines).toEqual([]);
    expect(cleanupCount()).toBe(1);
  });
});

describe('releaseOffscreenPage (M-65)', () => {
  it('blanks the canvas, cleanup the page, and marks unrendered', () => {
    const { page, cleanupCount } = fakePage();
    const canvas = { width: 800, height: 1000 };
    const state = { canvas, pdfPage: page, rendered: true, renderGen: 0 };
    releaseOffscreenPage(state);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(state.pdfPage).toBeNull();
    expect(state.rendered).toBe(false);
    expect(state.renderGen).toBe(1);
    expect(cleanupCount()).toBe(1);
  });
});

describe('blankCanvas', () => {
  it('zeros both dimensions', () => {
    const canvas = { width: 10, height: 20 };
    blankCanvas(canvas);
    expect(canvas).toEqual({ width: 0, height: 0 });
  });
});
