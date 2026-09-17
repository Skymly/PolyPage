import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyLruTouch,
  buildCacheKey,
  cacheClear,
  cacheFingerprint,
  cacheGet,
  cachePut,
  uniqueKeepOrder,
} from '../src/storage/cache';
import { ocrCacheClear } from '../src/ocr/resultCache';
import {
  CACHE_INDEX_KEY,
  CACHE_KEY_PREFIX,
  OCR_CACHE_INDEX_KEY,
  OCR_CACHE_KEY_PREFIX,
  defaultProvider,
} from '../src/shared/constants';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockLocalStore(initial: Record<string, unknown> = {}): Map<string, unknown> {
  const store = new Map<string, unknown>(Object.entries(initial));
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys?: string | string[] | null) => {
          if (keys == null) return Object.fromEntries(store);
          const list = typeof keys === 'string' ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const key of list) {
            if (store.has(key)) out[key] = store.get(key);
          }
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) store.set(key, value);
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
        },
      },
    },
  });
  return store;
}

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

describe('cache LRU (M-80)', () => {
  it('uniqueKeepOrder drops later duplicates', () => {
    expect(uniqueKeepOrder(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('applyLruTouch does not enqueue the same hash twice', () => {
    const touched = applyLruTouch(['old'], ['dup', 'dup'], 3);
    expect(touched.order).toEqual(['old', 'dup']);
    expect(touched.evict).toEqual([]);
  });

  it('applyLruTouch evicts a ghost duplicate without leaving a dangling slot', () => {
    const touched = applyLruTouch(['z', 'z'], ['w'], 2);
    expect(touched.order).toEqual(['z', 'w']);
    expect(touched.evict).toEqual([]);
  });

  it('cachePut of duplicate texts keeps a single LRU slot', async () => {
    const store = mockLocalStore();
    await cachePut(
      [
        { text: 'Hello', translated: '你好' },
        { text: 'Hello', translated: '你好二' },
      ],
      'p',
      'English',
      '简体中文',
    );
    const hash = buildCacheKey('p', 'English', '简体中文', 'Hello');
    const index = store.get(CACHE_INDEX_KEY) as { order: string[] };
    expect(index.order).toEqual([hash]);
    expect(store.get(CACHE_KEY_PREFIX + hash)).toEqual({ t: '你好二', ts: expect.any(Number) });
    const hits = await cacheGet([{ key: 'k', text: 'Hello' }], 'p', 'English', '简体中文');
    expect(hits.get('k')).toBe('你好二');
  });

  it('cacheClear removes orphan trcache keys even if they are missing from the index', async () => {
    mockLocalStore({
      [CACHE_INDEX_KEY]: { order: [] },
      [`${CACHE_KEY_PREFIX}orphan`]: { t: 'stale', ts: 1 },
      settings: { schemaVersion: 6 },
    });
    await cacheClear();
    const all = await chrome.storage.local.get(null);
    expect(all[`${CACHE_KEY_PREFIX}orphan`]).toBeUndefined();
    expect(all[CACHE_INDEX_KEY]).toBeUndefined();
    expect(all.settings).toEqual({ schemaVersion: 6 });
  });
});

describe('ocrCacheClear (M-80)', () => {
  it('removes OCR cache keys and leaves translation cache alone', async () => {
    mockLocalStore({
      [OCR_CACHE_INDEX_KEY]: { order: ['abc'] },
      [`${OCR_CACHE_KEY_PREFIX}abc`]: { segments: [], ts: 1 },
      [`${CACHE_KEY_PREFIX}keep`]: { t: 'x', ts: 1 },
    });
    await ocrCacheClear();
    const all = await chrome.storage.local.get(null);
    expect(all[OCR_CACHE_INDEX_KEY]).toBeUndefined();
    expect(all[`${OCR_CACHE_KEY_PREFIX}abc`]).toBeUndefined();
    expect(all[`${CACHE_KEY_PREFIX}keep`]).toEqual({ t: 'x', ts: 1 });
  });
});


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
