/**
 * OCR 往返 result cache. Not the translation-pipeline cache: stored values
 * are segment lists, not 译文 strings.
 */
import { OCR_CACHE_INDEX_KEY, OCR_CACHE_KEY_PREFIX, OCR_CACHE_MAX_ENTRIES } from '../shared/constants';
import { hashText } from '../shared/utils';
import type { OcrSegment } from '../shared/types';

export interface OcrCacheKeyParts {
  providerId: string;
  engineId: string;
  sourceLanguage: string;
  targetLanguage: string;
  glossaryVersion: number;
  identity: string;
}

export function buildOcrCacheKey(parts: OcrCacheKeyParts): string {
  return hashText(
    [
      parts.providerId,
      parts.engineId,
      parts.sourceLanguage,
      parts.targetLanguage,
      `g${parts.glossaryVersion}`,
      parts.identity,
    ].join('|'),
  );
}

export interface OcrResultCache {
  get(key: string): Promise<OcrSegment[] | undefined>;
  put(key: string, segments: OcrSegment[]): Promise<void>;
}

export class MemoryOcrCache implements OcrResultCache {
  readonly map = new Map<string, OcrSegment[]>();

  async get(key: string): Promise<OcrSegment[] | undefined> {
    const hit = this.map.get(key);
    return hit ? hit.map((s) => ({ ...s })) : undefined;
  }

  async put(key: string, segments: OcrSegment[]): Promise<void> {
    this.map.set(key, segments.map((s) => ({ ...s })));
  }
}

interface Stored {
  segments: OcrSegment[];
  ts: number;
}

interface Index {
  order: string[];
}

export class ChromeOcrCache implements OcrResultCache {
  private lock: Promise<unknown> = Promise.resolve();

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  async get(key: string): Promise<OcrSegment[] | undefined> {
    const storageKey = OCR_CACHE_KEY_PREFIX + key;
    const data = await chrome.storage.local.get(storageKey);
    const entry = data[storageKey] as Stored | undefined;
    if (!entry || !Array.isArray(entry.segments)) return undefined;
    return entry.segments;
  }

  async put(key: string, segments: OcrSegment[]): Promise<void> {
    const storageKey = OCR_CACHE_KEY_PREFIX + key;
    const now = Date.now();
    await chrome.storage.local.set({ [storageKey]: { segments, ts: now } as Stored });
    await this.withLock(async () => {
      const data = await chrome.storage.local.get(OCR_CACHE_INDEX_KEY);
      const index = (data[OCR_CACHE_INDEX_KEY] as Index | undefined) ?? { order: [] };
      if (!Array.isArray(index.order)) index.order = [];
      index.order = index.order.filter((h) => h !== key);
      index.order.push(key);
      const evict: string[] = [];
      while (index.order.length > OCR_CACHE_MAX_ENTRIES) {
        const oldest = index.order.shift();
        if (oldest) evict.push(OCR_CACHE_KEY_PREFIX + oldest);
      }
      if (evict.length > 0) await chrome.storage.local.remove(evict);
      await chrome.storage.local.set({ [OCR_CACHE_INDEX_KEY]: index });
    });
  }
}