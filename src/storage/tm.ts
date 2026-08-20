/**
 * Sentence-level translation memory (spec 4.1 pillar M / 5).
 *
 * Independent IndexedDB table, default-off. Exact match after normalization
 * (NFKC + whitespace fold + trim + edge punctuation). No fuzzy / stem /
 * embedding lookup. Entries never store a URL or page title.
 *
 * The store backend is injectable so unit tests run against memory.
 */
import { DEFAULT_TM_MAX_ENTRIES } from '../shared/constants';
import { hashText } from '../shared/utils';

export const TM_MIN_CHARS = 8;
export const TM_MAX_CHARS = 240;
export const TM_DB_NAME = 'polypage-tm';
export const TM_STORE_NAME = 'tm';

/** Unicode punctuation / symbols stripped from both ends after whitespace fold. */
const EDGE_PUNCT_RE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

export interface TmEntry {
  hash: string;
  source: string;
  target: string;
  langPair: string;
  hits: number;
  ts: number;
}

export interface TmStore {
  get(hash: string): Promise<TmEntry | undefined>;
  getMany(hashes: string[]): Promise<Map<string, TmEntry>>;
  put(entry: TmEntry): Promise<void>;
  delete(hash: string): Promise<void>;
  getAll(): Promise<TmEntry[]>;
  clear(): Promise<void>;
}

export interface TmLookupItem {
  key: string;
  text: string;
}

/** NFKC + collapse whitespace + trim + strip leading/trailing punctuation. */
export function normalizeTmSource(text: string): string {
  const folded = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return folded.replace(EDGE_PUNCT_RE, '').trim();
}

export function tmLangPair(sourceLanguage: string, targetLanguage: string): string {
  return sourceLanguage.trim() + '|' + targetLanguage.trim();
}

export function tmEntryHash(normalizedSource: string, langPair: string): string {
  return hashText(langPair + '\u0000' + normalizedSource);
}

export function isTmEligible(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= TM_MIN_CHARS && trimmed.length <= TM_MAX_CHARS;
}

export class MemoryTmStore implements TmStore {
  readonly map = new Map<string, TmEntry>();

  async get(hash: string): Promise<TmEntry | undefined> {
    const entry = this.map.get(hash);
    return entry ? { ...entry } : undefined;
  }

  async getMany(hashes: string[]): Promise<Map<string, TmEntry>> {
    const out = new Map<string, TmEntry>();
    for (const hash of hashes) {
      const entry = this.map.get(hash);
      if (entry) out.set(hash, { ...entry });
    }
    return out;
  }

  async put(entry: TmEntry): Promise<void> {
    this.map.set(entry.hash, { ...entry });
  }

  async delete(hash: string): Promise<void> {
    this.map.delete(hash);
  }

  async getAll(): Promise<TmEntry[]> {
    return [...this.map.values()].map((e) => ({ ...e }));
  }

  async clear(): Promise<void> {
    this.map.clear();
  }
}

export class IdbTmStore implements TmStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly dbName = TM_DB_NAME) {}

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(TM_STORE_NAME)) {
          db.createObjectStore(TM_STORE_NAME, { keyPath: 'hash' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  private withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T> {
    return this.open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(TM_STORE_NAME, mode);
          const store = tx.objectStore(TM_STORE_NAME);
          const request = fn(store);
          let result: T;
          if (request) {
            request.onsuccess = () => {
              result = request.result;
            };
          }
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        }),
    );
  }

  async get(hash: string): Promise<TmEntry | undefined> {
    const value = await this.withStore<TmEntry | undefined>('readonly', (store) => store.get(hash));
    return value ?? undefined;
  }

  async getMany(hashes: string[]): Promise<Map<string, TmEntry>> {
    const all = await this.getAll();
    const want = new Set(hashes);
    const out = new Map<string, TmEntry>();
    for (const entry of all) {
      if (want.has(entry.hash)) out.set(entry.hash, entry);
    }
    return out;
  }

  async put(entry: TmEntry): Promise<void> {
    await this.withStore('readwrite', (store) => {
      store.put(entry);
    });
  }

  async delete(hash: string): Promise<void> {
    await this.withStore('readwrite', (store) => {
      store.delete(hash);
    });
  }

  async getAll(): Promise<TmEntry[]> {
    const rows = await this.withStore<TmEntry[]>('readonly', (store) => store.getAll() as IDBRequest<TmEntry[]>);
    return Array.isArray(rows) ? rows : [];
  }

  async clear(): Promise<void> {
    await this.withStore('readwrite', (store) => {
      store.clear();
    });
  }
}

export interface TmStats {
  entries: number;
  hits: number;
}

/**
 * High-level TM. Eviction: lowest hits, then oldest ts (pinned by unit tests).
 * enabled === false callers must not invoke lookup/remember.
 */
export class TranslationMemory {
  constructor(
    private readonly store: TmStore,
    private readonly maxEntries: number = DEFAULT_TM_MAX_ENTRIES,
  ) {}

  async lookup(
    items: TmLookupItem[],
    langPair: string,
  ): Promise<Map<string, string>> {
    const hits = new Map<string, string>();
    if (items.length === 0) return hits;
    const planned: Array<{ key: string; hash: string }> = [];
    for (const item of items) {
      const normalized = normalizeTmSource(item.text);
      if (normalized === '') continue;
      planned.push({ key: item.key, hash: tmEntryHash(normalized, langPair) });
    }
    if (planned.length === 0) return hits;
    const found = await this.store.getMany(planned.map((p) => p.hash));
    const now = Date.now();
    for (const item of planned) {
      const entry = found.get(item.hash);
      if (!entry) continue;
      hits.set(item.key, entry.target);
      await this.store.put({ ...entry, hits: entry.hits + 1, ts: now });
    }
    return hits;
  }

  async remember(
    items: Array<{ source: string; target: string }>,
    langPair: string,
    maxEntries = this.maxEntries,
  ): Promise<void> {
    const now = Date.now();
    for (const item of items) {
      if (!isTmEligible(item.source)) continue;
      const translated = item.target.trim();
      if (translated === '') continue;
      const normalized = normalizeTmSource(item.source);
      if (normalized === '') continue;
      const hash = tmEntryHash(normalized, langPair);
      const existing = await this.store.get(hash);
      await this.store.put({
        hash,
        source: normalized,
        target: translated,
        langPair,
        hits: existing ? existing.hits + 1 : 0,
        ts: now,
      });
    }
    await this.prune(maxEntries);
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }

  async stats(): Promise<TmStats> {
    const all = await this.store.getAll();
    return {
      entries: all.length,
      hits: all.reduce((sum, e) => sum + e.hits, 0),
    };
  }

  private async prune(maxEntries = this.maxEntries): Promise<void> {
    const all = await this.store.getAll();
    if (all.length <= maxEntries) return;
    const sorted = [...all].sort((a, b) => a.hits - b.hits || a.ts - b.ts);
    const evict = sorted.slice(0, all.length - maxEntries);
    for (const entry of evict) {
      await this.store.delete(entry.hash);
    }
  }
}
