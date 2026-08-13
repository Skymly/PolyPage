/**
 * Pure image preprocessing helpers (spec 3.0 §6.2 item 4, §12.1). The
 * canvas/bitmap work itself runs in the background (OffscreenCanvas); these
 * decisions are unit-tested.
 */

export interface DownsampleTarget {
  width: number;
  height: number;
  scale: number;
}

/**
 * Compute the downsample target for an image whose largest edge must not
 * exceed maxEdgePx. Exact-fit images keep their dimensions (scale 1).
 */
export function computeDownsample(
  width: number,
  height: number,
  maxEdgePx: number,
): DownsampleTarget {
  if (width <= 0 || height <= 0 || maxEdgePx <= 0) {
    return { width, height, scale: 1 };
  }
  const largest = Math.max(width, height);
  if (largest <= maxEdgePx) return { width, height, scale: 1 };
  const scale = maxEdgePx / largest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/** True when either the pixel edge or the byte size exceeds the limits. */
export function needsDownsample(
  width: number,
  height: number,
  bytes: number,
  maxEdgePx: number,
  maxBytes: number,
): boolean {
  return Math.max(width, height) > maxEdgePx || bytes > maxBytes;
}