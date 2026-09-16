/**
 * Document fingerprint (spec 3.0 §5.5): stable identity for a PDF used in
 * cache keys. Prefers the PDF trailer file ID (pdf.js `fingerprints`);
 * falls back to etag/last-modified + size + first-4KB hash.
 */
import { hashText } from '../../shared/utils';

export interface FingerprintMeta {
  etag?: string | null;
  lastModified?: string | null;
  size?: number;
  /** Hash of the first 4KB of the body. */
  headerHash?: string;
}

/**
 * Compute the fallback fingerprint from HTTP metadata + header hash.
 * Deterministic and unit-tested (spec 3.0 §12.1).
 */
export function fingerprintFromMeta(meta: FingerprintMeta): string {
  const parts = [
    meta.etag?.trim() ?? '',
    meta.lastModified?.trim() ?? '',
    String(meta.size ?? 0),
    meta.headerHash ?? '',
  ];
  return `meta:${hashText(parts.join('|'))}`;
}

/** Choose the best available fingerprint. */
export function chooseFingerprint(
  pdfJsFingerprint: string | null | undefined,
  meta: FingerprintMeta,
): string {
  if (typeof pdfJsFingerprint === 'string' && pdfJsFingerprint.trim() !== '') {
    return `fileid:${pdfJsFingerprint.trim()}`;
  }
  return fingerprintFromMeta(meta);
}

/**
 * Cache-key prefix for a PDF paragraph (spec 3.0 §5.5.2). Goes on
 * `PipelineItem.cacheScope`; the body stays in `text` so Providers and TM
 * never see the document file ID.
 */
export function pdfCacheScope(fingerprint: string, page: number, paraIndex: number): string {
  return `pdf|${fingerprint}|p${page}|i${paraIndex}|`;
}

/**
 * Scope + body, used for resume `textHash` so in-flight records stay stable.
 * Language pair and glossaryVersion are added by the shared cache key builder.
 */
export function pdfScopedCacheText(
  fingerprint: string,
  page: number,
  paraIndex: number,
  text: string,
): string {
  return `${pdfCacheScope(fingerprint, page, paraIndex)}${text}`;
}