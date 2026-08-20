// @vitest-environment happy-dom
/**
 * Image overlay relayout (spec 4.2 §7.2): boxes follow the image's current
 * getBoundingClientRect after scroll / resize, batched on rAF.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyImageOverlay, relayoutAll, removeImageOverlay } from '../src/ocr/overlay';

function mockRect(el: HTMLElement, rect: { left: number; top: number; width: number; height: number }): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON() {
      return this;
    },
  } as DOMRect);
}

describe('image overlay relayout', () => {
  afterEach(() => {
    removeImageOverlay();
    vi.restoreAllMocks();
  });

  it('recomputes host box from the image rect after a move', () => {
    const img = document.createElement('img');
    img.src = 'https://example.com/a.png';
    Object.defineProperty(img, 'naturalWidth', { value: 200 });
    Object.defineProperty(img, 'naturalHeight', { value: 100 });
    document.body.appendChild(img);
    mockRect(img, { left: 10, top: 20, width: 200, height: 100 });
    applyImageOverlay(img, [
      { text: 'HELLO', translation: '你好', bbox: { x0: 0, y0: 0, x1: 80, y1: 20 } },
    ]);
    const host = document.querySelector('.wt-ocr-overlay-host') as HTMLElement;
    expect(host.style.left).toBe('10px');
    expect(host.style.top).toBe('20px');

    mockRect(img, { left: 40, top: 80, width: 200, height: 100 });
    relayoutAll();
    expect(host.style.left).toBe('40px');
    expect(host.style.top).toBe('80px');
    img.remove();
  });

  it('removeImageOverlay unloads every host', () => {
    const img = document.createElement('img');
    img.src = 'https://example.com/b.png';
    document.body.appendChild(img);
    mockRect(img, { left: 0, top: 0, width: 120, height: 80 });
    applyImageOverlay(img, [{ text: 'X', translation: 'Y' }]);
    expect(document.querySelectorAll('.wt-ocr-overlay-host').length).toBe(1);
    removeImageOverlay();
    expect(document.querySelectorAll('.wt-ocr-overlay-host').length).toBe(0);
    img.remove();
  });
});
