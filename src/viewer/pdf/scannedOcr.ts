/**
 * Scanned-page OCR helpers (spec 4.0 §7.2).
 *
 * The viewer renders a pdf.js page to a canvas, downsamples to PNG, and
 * sends it through the existing OcrEngine via ocr-request. Cache identity
 * is fingerprint + page + image hash + engine (language pair / glossary
 * version are added by the shared cache key builder).
 */
import { hashText } from '../../shared/utils';

export const SCANNED_PAGE_OCR_BUDGET = 20;

export function scannedPageCacheText(
  fingerprint: string,
  page: number,
  imageHash: string,
  engineId: string,
): string {
  return `pdfocr|${fingerprint}|p${page}|${imageHash}|${engineId}`;
}

/** djb2 hash of a data URL / PNG payload, used as the image identity. */
export function imageHashFromDataUrl(dataUrl: string): string {
  return hashText(dataUrl);
}

/**
 * Downsample a rendered page canvas so the longest edge is <= maxEdgePx,
 * then emit a PNG data URL for ocr-request.
 */
export function canvasToOcrDataUrl(canvas: HTMLCanvasElement, maxEdgePx: number): string {
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) return canvas.toDataURL('image/png');
  const longest = Math.max(w, h);
  if (longest <= maxEdgePx) return canvas.toDataURL('image/png');
  const scale = maxEdgePx / longest;
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const tmp = document.createElement('canvas');
  tmp.width = tw;
  tmp.height = th;
  const ctx = tmp.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/png');
  ctx.drawImage(canvas, 0, 0, tw, th);
  return tmp.toDataURL('image/png');
}
