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
 * 4.2: model / prompt / temperature fingerprint is also in the key (M-24).
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

/** Fingerprint of model + prompts + temperature (M-24). */
export function cacheFingerprint(provider: {
  model: string;
  systemPrompt: string;
  userPromptTemplate: string;
  temperature: number;
}): string {
  return hashText(
    `${provider.model}|${provider.systemPrompt}|${provider.userPromptTemplate}|${provider.temperature}`,
  );
}

/** Cache key independent of element ids: provider + languages + glossary + fingerprint + text. */
export function buildCacheKey(
  providerId: string,
  sourceLanguage: string,
  targetLanguage: string,
  text: string,
  glossaryVersion = 0,
  fingerprint = '',
): string {
  return hashText(
    `${providerId}|${sourceLanguage}|${targetLanguage}|g${glossaryVersion}|f${fingerprint}|${text}`,
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
  return { order: uniqueKeepOrder(index.order.filter((h) => typeof h === 'string')) };
}

/** First-seen order; used so a batch cannot push the same hash twice. */
export function uniqueKeepOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Move `hashes` to the LRU tail (once each) and return keys to evict. */
export function applyLruTouch(
  order: string[],
  hashes: string[],
  maxEntries: number,
): { order: string[]; evict: string[] } {
  const uniqueNew = uniqueKeepOrder(hashes);
  const touched = new Set(uniqueNew);
  const next = uniqueKeepOrder(order).filter((h) => !touched.has(h));
  next.push(...uniqueNew);
  const evict: string[] = [];
  while (next.length > maxEntries) {
    const oldest = next.shift();
    if (oldest) evict.push(oldest);
  }
  return { order: next, evict };
}

export async function cacheGet(
  texts: { key: string; text: string }[],
  providerId: string,
  sourceLanguage: string,
  targetLanguage: string,
  glossaryVersion = 0,
  fingerprint = '',
): Promise<Map<string, string>> {
  const hits = new Map<string, string>();
  if (texts.length === 0) return hits;
  const storageKeys = texts.map(({ key, text }) => ({
    storageKey:
      CACHE_KEY_PREFIX +
      buildCacheKey(providerId, sourceLanguage, targetLanguage, text, glossaryVersion, fingerprint),
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
  fingerprint = '',
): Promise<void> {
  if (items.length === 0) return;
  const now = Date.now();
  const writes: Record<string, CacheEntry> = {};
  const hashes: string[] = [];
  for (const { text, translated } of items) {
    const hash = buildCacheKey(
      providerId,
      sourceLanguage,
      targetLanguage,
      text,
      glossaryVersion,
      fingerprint,
    );
    writes[CACHE_KEY_PREFIX + hash] = { t: translated, ts: now };
    hashes.push(hash);
  }
  await withIndexLock(async () => {
    const index = await readIndex();
    const touched = applyLruTouch(index.order, hashes, CACHE_MAX_ENTRIES);
    const keep = new Set(touched.order);
    for (const key of Object.keys(writes)) {
      if (!keep.has(key.slice(CACHE_KEY_PREFIX.length))) delete writes[key];
    }
    if (touched.evict.length > 0) {
      await chrome.storage.local.remove(touched.evict.map((h) => CACHE_KEY_PREFIX + h));
    }
    await chrome.storage.local.set({ ...writes, [CACHE_INDEX_KEY]: { order: touched.order } });
  });
}

export async function cacheDelete(
  texts: string[],
  providerId: string,
  sourceLanguage: string,
  targetLanguage: string,
  glossaryVersion = 0,
  fingerprint = '',
): Promise<void> {
  if (texts.length === 0) return;
  const hashes = texts.map((text) =>
    buildCacheKey(providerId, sourceLanguage, targetLanguage, text, glossaryVersion, fingerprint),
  );
  await chrome.storage.local.remove(hashes.map((h) => CACHE_KEY_PREFIX + h));
  await withIndexLock(async () => {
    const index = await readIndex();
    const hashSet = new Set(hashes);
    index.order = index.order.filter((h) => !hashSet.has(h));
    await chrome.storage.local.set({ [CACHE_INDEX_KEY]: index });
  });
}

export async function cacheStats(): Promise<{ entries: number }> {
  const index = await readIndex();
  return { entries: index.order.length };
}

export async function cacheClear(): Promise<void> {
  await withIndexLock(async () => {
    const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    const keys = Object.keys(all).filter(
      (k) => k === CACHE_INDEX_KEY || k.startsWith(CACHE_KEY_PREFIX),
    );
    if (keys.length > 0) await chrome.storage.local.remove(keys);
  });
}

/** Seam for the translation pipeline. Two adapters: chrome.storage and memory. */
export interface TranslationCache {
  get(
    texts: { key: string; text: string }[],
    providerId: string,
    sourceLanguage: string,
    targetLanguage: string,
    glossaryVersion?: number,
    fingerprint?: string,
  ): Promise<Map<string, string>>;
  put(
    items: { text: string; translated: string }[],
    providerId: string,
    sourceLanguage: string,
    targetLanguage: string,
    glossaryVersion?: number,
    fingerprint?: string,
  ): Promise<void>;
  delete?(
    texts: string[],
    providerId: string,
    sourceLanguage: string,
    targetLanguage: string,
    glossaryVersion?: number,
    fingerprint?: string,
  ): Promise<void>;
}

/** Production adapter: chrome.storage.local LRU cache. */
export class ChromeTranslationCache implements TranslationCache {
  get(
    texts: { key: string; text: string }[],
    providerId: string,
    sourceLanguage: string,
    targetLanguage: string,
    glossaryVersion = 0,
    fingerprint = '',
  ): Promise<Map<string, string>> {
    return cacheGet(texts, providerId, sourceLanguage, targetLanguage, glossaryVersion, fingerprint);
  }

  put(
    items: { text: string; translated: string }[],
    providerId: string,
    sourceLanguage: string,
    targetLanguage: string,
    glossaryVersion = 0,
    fingerprint = '',
  ): Promise<void> {
    return cachePut(items, providerId, sourceLanguage, targetLanguage, glossaryVersion, fingerprint);
  }

  delete(
    texts: string[],
    providerId: string,
    sourceLanguage: string,
    targetLanguage: string,
    glossaryVersion = 0,
    fingerprint = '',
  ): Promise<void> {
    return cacheDelete(texts, providerId, sourceLanguage, targetLanguage, glossaryVersion, fingerprint);
  }
}

/** Test adapter: in-memory map keyed like the production cache. */
export class MemoryTranslationCache implements TranslationCache {
  private readonly map = new Map<string, string>();

  async get(
    texts: { key: string; text: string }[],
    providerId: string,
    sourceLanguage: string,
    targetLanguage: string,
    glossaryVersion = 0,
    fingerprint = '',
  ): Promise<Map<string, string>> {
    const hits = new Map<string, string>();
    for (const { key, text } of texts) {
      const hashed = buildCacheKey(
        providerId,
        sourceLanguage,
        targetLanguage,
        text,
        glossaryVersion,
        fingerprint,
      );
      const hit = this.map.get(hashed);
      if (hit !== undefined) hits.set(key, hit);
    }
    return hits;
  }

  async put(
    items: { text: string; translated: string }[],
    providerId: string,
    sourceLanguage: string,
    targetLanguage: string,
    glossaryVersion = 0,
    fingerprint = '',
  ): Promise<void> {
    for (const { text, translated } of items) {
      const hashed = buildCacheKey(
        providerId,
        sourceLanguage,
        targetLanguage,
        text,
        glossaryVersion,
        fingerprint,
      );
      this.map.set(hashed, translated);
    }
  }

  async delete(
    texts: string[],
    providerId: string,
    sourceLanguage: string,
    targetLanguage: string,
    glossaryVersion = 0,
    fingerprint = '',
  ): Promise<void> {
    for (const text of texts) {
      const hashed = buildCacheKey(
        providerId,
        sourceLanguage,
        targetLanguage,
        text,
        glossaryVersion,
        fingerprint,
      );
      this.map.delete(hashed);
    }
  }
}
