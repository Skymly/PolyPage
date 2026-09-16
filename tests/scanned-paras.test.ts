/**
 * Scanned-page OCR must rebuild paragraph DOM (M-08).
 */
import { describe, expect, it } from 'vitest';
import { keepExistingParas } from '../src/viewer/parasDom';

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
});
