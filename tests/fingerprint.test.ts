/**
 * Document fingerprint + PDF cache key tests (spec 3.0 §5.5, §12.1):
 * deterministic fingerprints and stable cache-key scoping.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseFingerprint,
  fingerprintFromMeta,
  pdfScopedCacheText,
} from '../src/viewer/pdf/fingerprint';
import { buildCacheKey } from '../src/storage/cache';

describe('fingerprintFromMeta', () => {
  it('is deterministic for identical metadata', () => {
    const a = fingerprintFromMeta({ etag: '"abc"', lastModified: 'Mon, 01 Jan 2026', size: 1234, headerHash: 'ff' });
    const b = fingerprintFromMeta({ etag: '"abc"', lastModified: 'Mon, 01 Jan 2026', size: 1234, headerHash: 'ff' });
    expect(a).toBe(b);
    expect(a.startsWith('meta:')).toBe(true);
  });

  it('changes when any component changes', () => {
    const base = { etag: '"abc"', size: 1234, headerHash: 'ff' };
    expect(fingerprintFromMeta({ ...base, size: 1235 })).not.toBe(fingerprintFromMeta(base));
    expect(fingerprintFromMeta({ ...base, etag: '"abd"' })).not.toBe(fingerprintFromMeta(base));
    expect(fingerprintFromMeta({ ...base, headerHash: 'fe' })).not.toBe(fingerprintFromMeta(base));
  });

  it('tolerates missing fields', () => {
    const f = fingerprintFromMeta({});
    expect(f).toMatch(/^meta:[0-9a-f]{16}$/);
  });
});

describe('chooseFingerprint', () => {
  it('prefers the PDF trailer file ID', () => {
    expect(chooseFingerprint('ABCDEF0123', { size: 10 })).toBe('fileid:ABCDEF0123');
  });

  it('falls back to meta fingerprint when file ID absent', () => {
    const f = chooseFingerprint(null, { size: 10, headerHash: 'aa' });
    expect(f.startsWith('meta:')).toBe(true);
    const f2 = chooseFingerprint('   ', { size: 10, headerHash: 'aa' });
    expect(f2).toBe(f);
  });
});

describe('PDF cache keys (spec 3.0 §5.5.2)', () => {
  it('scope includes fingerprint + page + index + text', () => {
    const t1 = pdfScopedCacheText('fileid:X', 3, 7, 'hello');
    const t2 = pdfScopedCacheText('fileid:X', 3, 8, 'hello');
    const t3 = pdfScopedCacheText('fileid:Y', 3, 7, 'hello');
    expect(t1).not.toBe(t2);
    expect(t1).not.toBe(t3);
  });

  it('cache key stays stable for the same scoped text and language pair', () => {
    const text = pdfScopedCacheText('fileid:X', 1, 0, 'paragraph');
    const k1 = buildCacheKey('prov', 'auto', '简体中文', text, 2);
    const k2 = buildCacheKey('prov', 'auto', '简体中文', text, 2);
    expect(k1).toBe(k2);
    const k3 = buildCacheKey('prov', 'auto', '简体中文', text, 3);
    expect(k3).not.toBe(k1); // glossary bump invalidates
  });
});