/**
 * M-02: tesseract runtime must not assume Worker exists (Chrome SW).
 */
import { describe, expect, it } from 'vitest';
import {
  computeOcrAvailable,
  resolveCreateWorker,
  resolveTesseractRuntime,
} from '../src/shared/tesseractRuntime';

describe('resolveTesseractRuntime', () => {
  it('prefers Worker (Firefox event page)', () => {
    expect(resolveTesseractRuntime(true, false)).toBe('worker');
    expect(resolveTesseractRuntime(true, true)).toBe('worker');
  });

  it('falls back to offscreen when Worker is missing', () => {
    expect(resolveTesseractRuntime(false, true)).toBe('offscreen');
  });

  it('is unavailable when neither Worker nor offscreen exists', () => {
    expect(resolveTesseractRuntime(false, false)).toBe('unavailable');
  });
});

describe('computeOcrAvailable', () => {
  it('greys tesseract when the runtime cannot host createWorker', () => {
    expect(computeOcrAvailable(true, 'tesseract-wasm', true, false)).toBe(false);
  });

  it('keeps tesseract available without a vision provider', () => {
    expect(computeOcrAvailable(true, 'tesseract-wasm', false, true)).toBe(true);
  });

  it('still requires vision for the llm-vision engine', () => {
    expect(computeOcrAvailable(true, 'llm-vision', false, true)).toBe(false);
    expect(computeOcrAvailable(true, 'llm-vision', true, false)).toBe(true);
  });
});

describe('resolveCreateWorker', () => {
  it('reads createWorker from the vendored default export', () => {
    const fn = async () => ({}) as never;
    expect(resolveCreateWorker({ default: { createWorker: fn } })).toBe(fn);
  });

  it('reads a named createWorker export', () => {
    const fn = async () => ({}) as never;
    expect(resolveCreateWorker({ createWorker: fn })).toBe(fn);
  });

  it('fails closed when the module has no createWorker', () => {
    expect(() => resolveCreateWorker({ default: {} })).toThrow(/缺少 createWorker/);
  });
});
