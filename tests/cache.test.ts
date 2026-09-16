import { describe, expect, it } from 'vitest';
import { buildCacheKey, cacheFingerprint } from '../src/storage/cache';
import { defaultProvider } from '../src/shared/constants';

describe('cacheFingerprint (M-24)', () => {
  it('changes the cache key when the model changes', () => {
    const a = defaultProvider();
    const b = { ...a, model: 'other-model' };
    expect(cacheFingerprint(a)).not.toBe(cacheFingerprint(b));
    expect(buildCacheKey('p', 'English', '简体中文', 'Hello', 0, cacheFingerprint(a))).not.toBe(
      buildCacheKey('p', 'English', '简体中文', 'Hello', 0, cacheFingerprint(b)),
    );
  });

  it('keeps the same key when only the provider id is unchanged', () => {
    const a = defaultProvider();
    expect(buildCacheKey('p', 'English', '简体中文', 'Hello', 0, cacheFingerprint(a))).toBe(
      buildCacheKey('p', 'English', '简体中文', 'Hello', 0, cacheFingerprint({ ...a })),
    );
  });
});
