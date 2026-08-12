/**
 * Translation cache on chrome.storage.local.
 *
 * Layout:
 *  - one key per translation:  "trcache:<hash>" -> { t: translatedText, ts: epochMs }
 *  - one index key:            "cacheIndex"     -> { order: ["<hash>", ...] } (LRU order)
 *
 * Runs only in the background service worker (content scripts never touch it).
 *
 * 2.0: the glossary version participates in the cache key so glossary edits
 * never serve stale cached translations (spec 2.0 §7.4).
 */
import { CACHE_INDEX_KEY, CACHE_KEY_PREFIX, CACHE_MAX_ENTRIES } from '../shared/constants';
import { hashText } from '../shared/utils';

interface CacheEntry {
  t: string;
  ts: number;
}

interface CacheIndex {
  order: string[];
}

/** Cache key independent of element ids: provider + languages + glossary + text. */
export function buildCacheKey(
  providerId: string,
  sourceLanguage: string,
  targetLanguage: string,
  text: string,
  glossaryVersion = 0,
): string {
  return hashText(
    `${providerId}|${sourceLanguage}|${targetLanguage}|g${glossaryVersion}|${text}`,
  );
}

/** Serialize index updates (the SW is single-threaded but flushes interleave at awaits). */
let indexLock: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexLock.then(fn, fn);
  indexLock = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<CacheIndex> {
  const data = await chrome.storage.local.get(CACHE_INDEX_KEY);
  const index = data[CACHE_INDEX_KEY] as CacheIndex | undefined;
  if (!index || !Array.isArray(index.order)) return { order: [] };
  return { order: index.order.filter((h) => typeof h === 'string') };
}

export async function cacheGet(
  texts: { key: string; text: string }[],
  providerId: string,
  sourceLanguage: string,
  targetLanguage: string,
  glossaryVersion = 0,
): Promise<Map<string, string>> {
  const hits = new Map<string, string>();
  if (texts.length === 0) return hits;
  const storageKeys = texts.map(({ key, text }) => ({
    storageKey:
      CACHE_KEY_PREFIX + buildCacheKey(providerId, sourceLanguage, targetLanguage, text, glossaryVersion),
    key,
  }));
  const data = await chrome.storage.local.get(storageKeys.map((k) => k.storageKey));
  for (const { storageKey, key } of storageKeys) {
    const entry = data[storageKey] as CacheEntry | undefined;
    if (entry && typeof entry.t === 'string') hits.set(key, entry.t);
  }
  return hits;
}

export async function cachePut(
  items: { text: string; translated: string }[],
  providerId: string,
  sourceLanguage: string,
  targetLanguage: string,
  glossaryVersion = 0,
): Promise<void> {
  if (items.length === 0) return;
  const now = Date.now();
  const writes: Record<string, CacheEntry> = {};
  const hashes: string[] = [];
  for (const { text, translated } of items) {
    const hash = buildCacheKey(providerId, sourceLanguage, targetLanguage, text, glossaryVersion);
    writes[CACHE_KEY_PREFIX + hash] = { t: translated, ts: now };
    hashes.push(hash);
  }
  await chrome.storage.local.set(writes);
  await withIndexLock(async () => {
    const index = await readIndex();
    const hashSet = new Set(hashes);
    // Move touched hashes to the tail (most recently used).
    index.order = index.order.filter((h) => !hashSet.has(h));
    index.order.push(...hashes);
    // Evict oldest entries beyond the limit.
    const evict: string[] = [];
    while (index.order.length > CACHE_MAX_ENTRIES) {
      const oldest = index.order.shift();
      if (oldest) evict.push(CACHE_KEY_PREFIX + oldest);
    }
    if (evict.length > 0) await chrome.storage.local.remove(evict);
    await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index });
  });
}

export async function cacheStats(): Promise<{ entries: number }> {
  const index = await readIndex();
  return { entries: index.order.length };
}

export async function cacheClear(): Promise<void> {
  await withIndexLock(async () => {
    const index = await readIndex();
    const keys = index.order.map((h) => CACHE_KEY_PREFIX + h);
    keys.push(CACHE_INDEX_KEY);
    await chrome.storage.local.remove(keys);
  });
}