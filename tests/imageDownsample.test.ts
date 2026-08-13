/**
 * Image downsample decision tests (spec 3.0 §6.2 item 4, §12.1): over-limit,
 * exact-fit, byte-size fallback.
 */
import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_BYTES } from '../src/shared/constants';
import { computeDownsample, needsDownsample } from '../src/shared/imageUtils';

describe('computeDownsample', () => {
  it('shrinks landscape images to the max edge', () => {
    const t = computeDownsample(8192, 4096, 4096);
    expect(t.width).toBe(4096);
    expect(t.height).toBe(2048);
    expect(t.scale).toBeCloseTo(0.5);
  });

  it('shrinks portrait images by height', () => {
    const t = computeDownsample(3000, 6000, 4096);
    expect(t.height).toBe(4096);
    expect(t.width).toBe(2048);
  });

  it('keeps exact-fit images untouched (恰好)', () => {
    const t = computeDownsample(4096, 2000, 4096);
    expect(t).toEqual({ width: 4096, height: 2000, scale: 1 });
  });

  it('keeps smaller images untouched', () => {
    expect(computeDownsample(800, 600, 4096).scale).toBe(1);
  });

  it('never produces zero dimensions (超限回退底线)', () => {
    const t = computeDownsample(100000, 3, 4096);
    expect(t.width).toBe(4096);
    expect(t.height).toBeGreaterThanOrEqual(1);
  });

  it('guards invalid inputs', () => {
    expect(computeDownsample(0, 100, 4096).scale).toBe(1);
    expect(computeDownsample(100, 100, 0).scale).toBe(1);
  });
});

describe('needsDownsample', () => {
  it('triggers on edge over-limit', () => {
    expect(needsDownsample(5000, 100, 1000, 4096, IMAGE_MAX_BYTES)).toBe(true);
  });

  it('triggers on byte size over-limit even for small edges', () => {
    expect(needsDownsample(1000, 1000, IMAGE_MAX_BYTES + 1, 4096, IMAGE_MAX_BYTES)).toBe(true);
  });

  it('stays false when both are within limits (恰好)', () => {
    expect(needsDownsample(4096, 4096, IMAGE_MAX_BYTES, 4096, IMAGE_MAX_BYTES)).toBe(false);
  });
});