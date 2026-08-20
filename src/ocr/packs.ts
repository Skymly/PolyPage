/**
 * OCR additional language-pack catalog / download / delete (spec 4.1 pillar N).
 *
 * Packs are data files (tesseract .traineddata), never executable code.
 * Users must see the size declaration and opt in before any download.
 * Storage is IndexedDB (never chrome.storage.local). Bundled eng + chi_sim
 * stay in vendor/tessdata and are not managed here.
 */
import { DEFAULT_TESS_LANGS } from '../shared/constants';

export const OCR_PACK_DB_NAME = 'polypage-ocrpacks';
export const OCR_PACK_STORE_NAME = 'packs';

/** Official tessdata_fast (LSTM integer) hosted on GitHub raw. Hashes pinned. */
export const TESSDATA_FAST_BASE =
  'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main';

export interface OcrPackMeta {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}

export const OCR_PACK_CATALOG: readonly OcrPackMeta[] = [
  {
    id: 'jpn',
    name: 'Japanese',
    bytes: 2471260,
    sha256: '1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d',
    url: `${TESSDATA_FAST_BASE}/jpn.traineddata`,
  },
  {
    id: 'kor',
    name: 'Korean',
    bytes: 1677415,
    sha256: '6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2',
    url: `${TESSDATA_FAST_BASE}/kor.traineddata`,
  },
  {
    id: 'fra',
    name: 'French',
    bytes: 1130365,
    sha256: 'ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca',
    url: `${TESSDATA_FAST_BASE}/fra.traineddata`,
  },
  {
    id: 'deu',
    name: 'German',
    bytes: 1525436,
    sha256: '19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d',
    url: `${TESSDATA_FAST_BASE}/deu.traineddata`,
  },
];

export type OcrPackStatusId = 'absent' | 'downloading' | 'ready' | 'error';

export interface OcrPackStatus {
  id: string;
  name: string;
  bytes: number;
  status: OcrPackStatusId;
  received?: number;
  error?: string;
  bundled?: boolean;
}

export interface StoredOcrPack {
  id: string;
  sha256: string;
  bytes: number;
  data: ArrayBuffer;
  ts: number;
}

export interface OcrPackStore {
  get(id: string): Promise<StoredOcrPack | undefined>;
  put(pack: StoredOcrPack): Promise<void>;
  delete(id: string): Promise<void>;
  listIds(): Promise<string[]>;
}

export type PackFetch = (
  url: string,
  init: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void },
) => Promise<ArrayBuffer>;

export class MemoryOcrPackStore implements OcrPackStore {
  readonly map = new Map<string, StoredOcrPack>();

  async get(id: string): Promise<StoredOcrPack | undefined> {
    const row = this.map.get(id);
    return row ? { ...row, data: row.data.slice(0) } : undefined;
  }

  async put(pack: StoredOcrPack): Promise<void> {
    this.map.set(pack.id, { ...pack, data: pack.data.slice(0) });
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }

  async listIds(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

export class IdbOcrPackStore implements OcrPackStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly dbName = OCR_PACK_DB_NAME) {}

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OCR_PACK_STORE_NAME)) {
          db.createObjectStore(OCR_PACK_STORE_NAME, { keyPath: 'id' });
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
          const tx = db.transaction(OCR_PACK_STORE_NAME, mode);
          const store = tx.objectStore(OCR_PACK_STORE_NAME);
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

  async get(id: string): Promise<StoredOcrPack | undefined> {
    const value = await this.withStore<StoredOcrPack | undefined>('readonly', (store) => store.get(id));
    return value ?? undefined;
  }

  async put(pack: StoredOcrPack): Promise<void> {
    await this.withStore('readwrite', (store) => {
      store.put(pack);
    });
  }

  async delete(id: string): Promise<void> {
    await this.withStore('readwrite', (store) => {
      store.delete(id);
    });
  }

  async listIds(): Promise<string[]> {
    const keys = await this.withStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return (keys ?? []).map(String);
  }
}

export function catalogPack(id: string): OcrPackMeta | undefined {
  return OCR_PACK_CATALOG.find((p) => p.id === id);
}

export function formatPackMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function knownPackId(id: string): boolean {
  return OCR_PACK_CATALOG.some((p) => p.id === id);
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function defaultPackFetch(
  url: string,
  init: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {},
): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal: init.signal, credentials: 'omit' });
  if (!res.ok) {
    throw new Error('download failed HTTP ' + res.status);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body || !init.onProgress) {
    return res.arrayBuffer();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      init.onProgress(received, total);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export class OcrPackManager {
  readonly progress = new Map<string, OcrPackStatus>();

  constructor(
    private readonly store: OcrPackStore,
    private readonly fetchImpl: PackFetch = defaultPackFetch,
    private readonly catalog: readonly OcrPackMeta[] = OCR_PACK_CATALOG,
  ) {}

  private meta(id: string): OcrPackMeta | undefined {
    return this.catalog.find((p) => p.id === id);
  }

  async status(): Promise<OcrPackStatus[]> {
    const ready = new Set(await this.store.listIds());
    return [
      ...DEFAULT_TESS_LANGS.map((id) => ({
        id,
        name: id === 'eng' ? 'English (bundled)' : 'Simplified Chinese (bundled)',
        bytes: 0,
        status: 'ready' as const,
        bundled: true,
      })),
      ...this.catalog.map((meta) => {
        const live = this.progress.get(meta.id);
        if (live) return live;
        return {
          id: meta.id,
          name: meta.name,
          bytes: meta.bytes,
          status: ready.has(meta.id) ? ('ready' as const) : ('absent' as const),
        };
      }),
    ];
  }

  async download(id: string, signal?: AbortSignal): Promise<StoredOcrPack> {
    const meta = this.meta(id);
    if (!meta) throw new Error('unknown OCR pack: ' + id);
    this.progress.set(id, {
      id,
      name: meta.name,
      bytes: meta.bytes,
      status: 'downloading',
      received: 0,
    });
    try {
      const data = await this.fetchImpl(meta.url, {
        signal,
        onProgress: (received, total) => {
          this.progress.set(id, {
            id,
            name: meta.name,
            bytes: total || meta.bytes,
            status: 'downloading',
            received,
          });
        },
      });
      const digest = await sha256Hex(data);
      if (digest !== meta.sha256) {
        throw new Error('OCR pack hash mismatch');
      }
      const pack: StoredOcrPack = {
        id,
        sha256: digest,
        bytes: data.byteLength,
        data,
        ts: Date.now(),
      };
      await this.store.put(pack);
      this.progress.set(id, { id, name: meta.name, bytes: pack.bytes, status: 'ready' });
      return pack;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.progress.set(id, {
        id,
        name: meta.name,
        bytes: meta.bytes,
        status: 'error',
        error: message,
      });
      throw e instanceof Error ? e : new Error(message);
    }
  }

  async remove(id: string): Promise<void> {
    const meta = this.meta(id);
    if (!meta) throw new Error('unknown OCR pack: ' + id);
    await this.store.delete(id);
    this.progress.set(id, {
      id,
      name: meta?.name ?? id,
      bytes: meta?.bytes ?? 0,
      status: 'absent',
    });
  }

  async getReady(id: string): Promise<StoredOcrPack | undefined> {
    return this.store.get(id);
  }

  async readyIds(): Promise<string[]> {
    return this.store.listIds();
  }
}

/**
 * Compose tesseract lang from bundled defaults + ready extra packs.
 * Missing extras are dropped (never throw).
 */
export async function resolveTessLangs(
  requested: string[] | undefined,
  extrasEnabled: string[],
  readyIds: string[],
): Promise<{ langs: string[]; missing: string[] }> {
  const ready = new Set(readyIds);
  const wanted = new Set<string>();
  for (const id of DEFAULT_TESS_LANGS) wanted.add(id);
  for (const id of requested ?? []) {
    if (typeof id === 'string' && id.trim() !== '') wanted.add(id.trim());
  }
  for (const id of extrasEnabled) {
    if (knownPackId(id)) wanted.add(id);
  }
  const langs: string[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    if (DEFAULT_TESS_LANGS.includes(id) || ready.has(id)) langs.push(id);
    else missing.push(id);
  }
  if (langs.length === 0) langs.push(...DEFAULT_TESS_LANGS);
  return { langs, missing };
}

/**
 * Seed tesseract.js idb-keyval cache so createWorker can load extra langs
 * without fetching them from langPath (vendor/tessdata only has eng/chi_sim).
 */
export async function seedTesseractLangCache(lang: string, data: ArrayBuffer): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('keyval-store', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keyval')) db.createObjectStore('keyval');
    };
    req.onerror = () => reject(req.error ?? new Error('tesseract cache open failed'));
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keyval')) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction('keyval', 'readwrite');
      tx.objectStore('keyval').put(new Uint8Array(data), './' + lang + '.traineddata');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('tesseract cache write failed'));
      };
    };
  });
}
