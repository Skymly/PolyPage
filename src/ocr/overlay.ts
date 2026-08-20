/**
 * In-place image overlay (spec 4.1 P1 / 8.2, refined in 4.2 §7.2).
 *
 * Semi-transparent blocks stacked on the source image. Not a pixel-perfect
 * reconstruction: vertical / curved / multi-column posters are out of scope.
 * Closing translation or toggling the setting off removes every overlay.
 * 4.2: scroll / resize / visualViewport changes recompute boxes from the
 * image's current getBoundingClientRect, batched on rAF.
 */
import type { OcrSegment } from '../shared/types';

const OVERLAY_ATTR = 'data-wt-overlay-for';
const HOST_CLASS = 'wt-ocr-overlay-host';

export interface OverlayBox {
  text: string;
  translation: string;
  /** Pixel box in the image's natural coordinate space. */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

interface LiveOverlay {
  img: HTMLImageElement;
  segments: OverlayBox[];
  host: HTMLElement;
}

const live = new Map<string, LiveOverlay>();
let raf = 0;
let listening = false;

function overlayKey(img: HTMLImageElement): string {
  return img.currentSrc || img.src || String(img.naturalWidth) + 'x' + String(img.naturalHeight);
}

function allOverlays(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.' + HOST_CLASS)];
}

function stopListening(): void {
  if (!listening) return;
  window.removeEventListener('scroll', scheduleRelayout, true);
  window.removeEventListener('resize', scheduleRelayout);
  window.visualViewport?.removeEventListener('resize', scheduleRelayout);
  window.visualViewport?.removeEventListener('scroll', scheduleRelayout);
  listening = false;
}

function ensureListening(): void {
  if (listening) return;
  window.addEventListener('scroll', scheduleRelayout, true);
  window.addEventListener('resize', scheduleRelayout);
  window.visualViewport?.addEventListener('resize', scheduleRelayout);
  window.visualViewport?.addEventListener('scroll', scheduleRelayout);
  listening = true;
}

export function scheduleRelayout(): void {
  if (raf !== 0) return;
  const rafFn = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
  raf = rafFn(() => {
    raf = 0;
    relayoutAll();
  });
}

/** Recompute every live overlay from the image's current box. */
export function relayoutAll(): void {
  for (const [key, entry] of [...live.entries()]) {
    if (!entry.img.isConnected || !entry.host.isConnected) {
      entry.host.remove();
      live.delete(key);
      continue;
    }
    layoutHost(entry.host, entry.img, entry.segments);
  }
  if (live.size === 0) stopListening();
}

function layoutHost(host: HTMLElement, img: HTMLImageElement, segments: OverlayBox[]): void {
  const rect = img.getBoundingClientRect();
  host.style.left = Math.round(rect.left) + 'px';
  host.style.top = Math.round(rect.top) + 'px';
  host.style.width = Math.round(rect.width) + 'px';
  host.style.height = Math.round(rect.height) + 'px';
  host.style.display = rect.width < 8 || rect.height < 8 ? 'none' : 'block';

  const nw = img.naturalWidth || rect.width;
  const nh = img.naturalHeight || rect.height;
  const sx = rect.width / Math.max(1, nw);
  const sy = rect.height / Math.max(1, nh);
  const usable = segments.filter((s) => (s.translation || s.text).trim() !== '');
  const withBox = usable.filter((s) => s.bbox && s.bbox.x1 > s.bbox.x0 && s.bbox.y1 > s.bbox.y0);
  const stacked = withBox.length === 0;
  const blocks = [...host.children] as HTMLElement[];
  usable.forEach((seg, i) => {
    const block = blocks[i];
    if (!block) return;
    if (!stacked && seg.bbox) {
      const w = Math.max(16, (seg.bbox.x1 - seg.bbox.x0) * sx);
      const h = Math.max(14, (seg.bbox.y1 - seg.bbox.y0) * sy);
      block.style.left = Math.round(seg.bbox.x0 * sx) + 'px';
      block.style.top = Math.round(seg.bbox.y0 * sy) + 'px';
      block.style.width = Math.round(w) + 'px';
      block.style.height = Math.round(h) + 'px';
      block.style.right = '';
      block.style.fontSize = Math.max(10, Math.min(18, h * 0.7)) + 'px';
    } else {
      block.style.left = '6px';
      block.style.right = '6px';
      block.style.top = 6 + i * 28 + 'px';
      block.style.width = '';
      block.style.height = '';
      block.style.fontSize = '12px';
    }
  });
}

export function removeImageOverlay(img?: HTMLImageElement): void {
  if (!img) {
    for (const entry of live.values()) entry.host.remove();
    live.clear();
    for (const el of allOverlays()) el.remove();
    stopListening();
    return;
  }
  const key = overlayKey(img);
  const entry = live.get(key);
  if (entry) {
    entry.host.remove();
    live.delete(key);
  }
  for (const el of allOverlays()) {
    if (el.getAttribute(OVERLAY_ATTR) === key) el.remove();
  }
  if (live.size === 0) stopListening();
}

/**
 * Draw overlay blocks. When a segment has a bbox, the box is scaled from
 * natural image pixels onto the rendered rect; otherwise blocks stack from
 * the top of the image.
 */
export function applyImageOverlay(img: HTMLImageElement, segments: OverlayBox[] | OcrSegment[]): void {
  removeImageOverlay(img);
  const usable = segments.filter((s) => (s.translation || s.text).trim() !== '');
  if (usable.length === 0) return;

  const rect = img.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const host = document.createElement('div');
  host.className = HOST_CLASS;
  host.setAttribute(OVERLAY_ATTR, overlayKey(img));
  host.style.cssText = [
    'position:fixed',
    'left:' + Math.round(rect.left) + 'px',
    'top:' + Math.round(rect.top) + 'px',
    'width:' + Math.round(rect.width) + 'px',
    'height:' + Math.round(rect.height) + 'px',
    'z-index:2147483645',
    'pointer-events:none',
    'overflow:hidden',
    'font-family:system-ui,sans-serif',
  ].join(';');

  usable.forEach((seg) => {
    const block = document.createElement('div');
    block.textContent = (seg.translation || seg.text).trim();
    block.style.cssText = [
      'position:absolute',
      'background:rgba(15,23,42,.72)',
      'color:#fff',
      'padding:2px 6px',
      'border-radius:4px',
      'line-height:1.3',
      'overflow:hidden',
      'box-sizing:border-box',
    ].join(';');
    host.appendChild(block);
  });
  document.documentElement.appendChild(host);
  live.set(overlayKey(img), { img, segments: usable, host });
  layoutHost(host, img, usable);
  ensureListening();
}

export function hasImageOverlay(): boolean {
  return live.size > 0 || allOverlays().length > 0;
}
