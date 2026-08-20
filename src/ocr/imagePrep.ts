/**
 * Image fetch / data-URL decode / downsample for OCR 往返.
 * Production uses OffscreenCanvas; tests inject stubs and never enter here.
 */
import { IMAGE_MAX_BYTES } from '../shared/constants';
import { computeDownsample, needsDownsample } from '../shared/imageUtils';

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function decodeDataUrl(url: string): { buffer: ArrayBuffer; mime: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  const mime = match?.[1] || 'image/png';
  const payload = match?.[3] ?? '';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { buffer: bytes.buffer, mime };
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export async function defaultFetchImage(
  url: string,
  signal: AbortSignal,
): Promise<{ buffer: ArrayBuffer; mime: string }> {
  if (url.startsWith('data:')) return decodeDataUrl(url);
  const res = await fetch(url, { signal, credentials: 'include' });
  if (!res.ok) throw new Error(`图片下载失败（HTTP ${res.status}）`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error('图片内容为空');
  return { buffer, mime: res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png' };
}

export async function defaultPrepareDataUrl(
  buffer: ArrayBuffer,
  mime: string,
  maxEdgePx: number,
): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let bitmap: ImageBitmap | null = null;
  try {
    if (!needsDownsample(1, 1, buffer.byteLength, maxEdgePx, IMAGE_MAX_BYTES)) {
      return bytesToDataUrl(bytes, mime);
    }
    bitmap = await createImageBitmap(new Blob([buffer], { type: mime }));
  } catch {
    return bytesToDataUrl(bytes, mime);
  }
  const needsResize = needsDownsample(
    bitmap.width,
    bitmap.height,
    buffer.byteLength,
    maxEdgePx,
    IMAGE_MAX_BYTES,
  );
  if (!needsResize) {
    bitmap.close();
    return bytesToDataUrl(bytes, mime);
  }
  const target = computeDownsample(bitmap.width, bitmap.height, maxEdgePx);
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return bytesToDataUrl(bytes, mime);
  }
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const out = new Uint8Array(await blob.arrayBuffer());
  return bytesToDataUrl(out, 'image/jpeg');
}