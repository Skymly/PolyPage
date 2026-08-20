/**
 * Translation pipeline — the one module that turns source text into 译文.
 *
 * Callers (webpage, PDF, selection, cue, stream, OCR two-step) share cache,
 * sentence TM, output hygiene, Provider failover, stats, and the concurrency
 * cap. `immediate` only skips the 80ms merge window. Streaming deltas are
 * progress, not 译文.
 */
import { BATCH_WINDOW_MS, MAX_CONCURRENT_REQUESTS } from '../shared/constants';
import { sanitizeOptionsFromSettings, sanitizeTranslation } from '../shared/sanitize';
import type { ErrorKind, ProviderConfig, Settings, TranslateResults } from '../shared/types';
import {
  ProviderError,
  providerSupportsStreaming,
  toProviderError,
} from '../providers/provider';
import type { TranslationProvider } from '../providers/provider';
import type { TranslationCache } from '../storage/cache';
import { TranslationMemory, tmLangPair } from '../storage/tm';
import {
  buildContext,
  buildFailoverChain,
  effectiveLanguages,
  failoverEligible,
  isProviderConfigured,
} from './context';

export interface PipelineItem {
  text: string;
  key?: string;
  domain?: string;
  pageLanguage?: string | null;
  tabId?: number;
  frameId?: number;
}

export interface TranslateOptions {
  /** Skip the 80ms merge window. Does not skip cache / TM / sanitize / failover / stats. */
  immediate?: boolean;
  /** Progress only. Not 译文; not written to cache or TM. */
  onDelta?: (key: string, delta: string) => void;
  /** Extra abort (stream port disconnect). Does not join the tab cancel set. */
  signal?: AbortSignal;
}

export interface PipelineDeps {
  getSettings: (force?: boolean) => Promise<Settings>;
  cache: TranslationCache;
  tm: TranslationMemory;
  createProvider: (config: ProviderConfig) => TranslationProvider;
  recordStat?: (providerId: string, ok: boolean, latencyMs: number, error?: string) => void;
  logError?: (where: string, kind: ErrorKind, message: string, providerId?: string) => Promise<void> | void;
  onTmHit?: () => void;
  recordInflight?: (
    tabId: number | undefined,
    frameId: number | undefined,
    items: Array<{ key: string; text: string }>,
  ) => Promise<void> | void;
  completeTasks?: (tabId: number | undefined, keys: string[]) => Promise<void> | void;
}

function applyOutputSanitize(
  text: string,
  settings: Settings,
): { ok: true; text: string } | { ok: false } {
  const result = sanitizeTranslation(text, sanitizeOptionsFromSettings(settings));
  return result.ok ? { ok: true, text: result.text } : { ok: false };
}

interface ItemResult {
  translated?: string;
  error?: { kind: ErrorKind; message: string };
  actualProviderName?: string;
}

interface QueueItem {
  requestId: number;
  resultKey: string;
  providerId: string;
  text: string;
  key: string;
  domain?: string;
  pageLanguage?: string | null;
  tabId?: number;
  frameId?: number;
  stream: boolean;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  resolve: (r: ItemResult) => void;
}

export class TranslationPipeline {
  private readonly queue: QueueItem[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private pendingFlush = false;
  private requestSeq = 0;
  private readonly inflightByTab = new Map<number, Set<AbortController>>();

  constructor(private readonly deps: PipelineDeps) {}

  cancelTab(tabId: number): void {
    const set = this.inflightByTab.get(tabId);
    if (!set) return;
    this.inflightByTab.delete(tabId);
    for (const controller of set) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
  }

  async translate(items: PipelineItem[], options: TranslateOptions = {}): Promise<TranslateResults> {
    const settings = await this.deps.getSettings();
    const providerId = settings.activeProviderId;
    const requestId = ++this.requestSeq;
    const pending = items.map((item, index) => {
      const resultKey = item.key && item.key !== '' ? item.key : `anon-${requestId}-${index}`;
      return new Promise<{ resultKey: string; outcome: ItemResult }>((resolve) => {
        if (options.signal?.aborted) {
          resolve({
            resultKey,
            outcome: { error: { kind: 'aborted', message: '请求已取消' } },
          });
          return;
        }
        this.queue.push({
          requestId,
          resultKey,
          providerId,
          text: item.text,
          key: item.key ?? '',
          domain: item.domain,
          pageLanguage: item.pageLanguage,
          tabId: item.tabId,
          frameId: item.frameId,
          stream: typeof options.onDelta === 'function',
          signal: options.signal,
          onDelta: options.onDelta
            ? (delta) => options.onDelta!(resultKey, delta)
            : undefined,
          resolve: (outcome) => resolve({ resultKey, outcome }),
        });
      });
    });
    if (pending.length > 0) this.schedule(options.immediate === true);
    const settled = await Promise.all(pending);

    const results: TranslateResults = { results: {}, errors: {} };
    let actualProviderName: string | undefined;
    for (const { resultKey, outcome } of settled) {
      if (outcome.translated !== undefined) results.results[resultKey] = outcome.translated;
      else if (outcome.error) results.errors[resultKey] = outcome.error;
      else results.errors[resultKey] = { kind: 'unknown', message: '未知错误' };
      if (outcome.actualProviderName) actualProviderName = outcome.actualProviderName;
    }
    if (actualProviderName) results.actualProviderName = actualProviderName;
    return results;
  }

  private schedule(immediate: boolean): void {
    const kick = (): void => {
      void this.flushQueue();
    };
    if (immediate) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      kick();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        kick();
      }, BATCH_WINDOW_MS);
    }
  }

  private async flushQueue(): Promise<void> {
    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.pendingFlush = false;
        await this.flushOnce();
      } while (this.pendingFlush);
    } finally {
      this.flushing = false;
    }
  }

  private async flushOnce(): Promise<void> {
    const items = this.queue.splice(0, this.queue.length);
    if (items.length === 0) return;
    const settings = await this.deps.getSettings(true);

    const groups = new Map<string, QueueItem[]>();
    for (const item of items) {
      const key = `${item.providerId}|${item.tabId ?? -1}`;
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }

    const jobs: Array<() => Promise<void>> = [];
    for (const group of groups.values()) {
      jobs.push(...(await this.jobsForGroup(settings, group)));
    }

    let index = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, Math.max(jobs.length, 0)) }, async () => {
      while (index < jobs.length) {
        const job = jobs[index++];
        await job();
      }
    });
    await Promise.all(workers);
  }

  private async jobsForGroup(settings: Settings, group: QueueItem[]): Promise<Array<() => Promise<void>>> {
    const providerId = group[0].providerId;
    const groupTabId = group[0].tabId;
    const groupFrameId = group[0].frameId;
    const provider = settings.providers.find((p) => p.id === providerId);
    if (!provider || !isProviderConfigured(provider)) {
      const message = !provider
        ? '翻译服务未配置'
        : !provider.enabled
          ? '翻译服务已禁用'
          : provider.type === 'native-host'
            ? '本地网关未配置 Host 名称'
            : '未配置 Base URL，请在设置页填写';
      for (const item of group) item.resolve({ error: { kind: 'config', message } });
      await this.deps.logError?.('background', 'config', `Provider "${provider?.name ?? providerId}": ${message}`, providerId);
      return [];
    }
    const { source, target } = effectiveLanguages(settings, provider);

    let hits = new Map<string, string>();
    if (settings.cacheEnabled) {
      try {
        hits = await this.deps.cache.get(
          group.map((g, i) => ({ key: String(i), text: g.text })),
          providerId,
          source,
          target,
          settings.glossaryVersion,
        );
      } catch {
        hits = new Map();
      }
    }
    const misses: QueueItem[] = [];
    group.forEach((item, i) => {
      const cached = hits.get(String(i));
      if (cached !== undefined) {
        const cleaned = applyOutputSanitize(cached, settings);
        if (cleaned.ok) item.resolve({ translated: cleaned.text });
        else misses.push(item);
      } else misses.push(item);
    });
    if (settings.translationMemory.enabled && misses.length > 0) {
      try {
        const pair = tmLangPair(source, target);
        const tmHits = await this.deps.tm.lookup(
          misses.map((m, i) => ({ key: String(i), text: m.text })),
          pair,
        );
        const still: QueueItem[] = [];
        misses.forEach((item, i) => {
          const hit = tmHits.get(String(i));
          if (hit !== undefined) {
            const cleaned = applyOutputSanitize(hit, settings);
            if (cleaned.ok) {
              this.deps.onTmHit?.();
              item.resolve({ translated: cleaned.text });
            } else still.push(item);
          } else still.push(item);
        });
        misses.length = 0;
        misses.push(...still);
      } catch {
        /* TM is best-effort */
      }
    }
    if (misses.length === 0) return [];

    const resumeItems = misses.filter((m) => m.key !== '' && !m.stream);
    if (resumeItems.length > 0) {
      try {
        await this.deps.recordInflight?.(
          groupTabId,
          groupFrameId,
          resumeItems.map((m) => ({ key: m.key, text: m.text })),
        );
      } catch {
        /* best-effort */
      }
    }

    const jobs: Array<() => Promise<void>> = [];
    const streamItems = misses.filter((m) => m.stream);
    const batchItems = misses.filter((m) => !m.stream);

    for (const item of streamItems) {
      jobs.push(() => this.runStreamWithFailover(settings, provider, item));
    }

    let chars = 0;
    let batch: QueueItem[] = [];
    const batches: QueueItem[][] = [];
    for (const item of batchItems) {
      if (
        batch.length > 0 &&
        (batch.length >= provider.maxBatchItems || chars + item.text.length > provider.maxBatchChars)
      ) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(item);
      chars += item.text.length;
    }
    if (batch.length > 0) batches.push(batch);
    for (const b of batches) {
      jobs.push(() => this.runBatchWithFailover(settings, provider, b, groupTabId));
    }
    return jobs;
  }

  private async runBatchWithFailover(
    settings: Settings,
    primary: ProviderConfig,
    batch: QueueItem[],
    tabId?: number,
  ): Promise<void> {
    const chain = buildFailoverChain(settings, primary.id);
    const attempts: ProviderConfig[] = [primary];
    for (const id of chain) {
      const next = settings.providers.find((p) => p.id === id);
      if (next) attempts.push(next);
    }

    for (let i = 0; i < attempts.length; i++) {
      const provider = attempts[i];
      const error = await this.runBatch(
        settings,
        provider,
        batch,
        tabId,
        i > 0 ? provider.name : undefined,
      );
      if (!error) {
        if (i > 0) {
          await this.deps.logError?.(
            'failover',
            'unknown',
            `故障转移成功：${primary.name} → ${provider.name}`,
            provider.id,
          );
        }
        return;
      }
      const eligible = failoverEligible(error.kind, provider.type);
      if (!eligible || i === attempts.length - 1) {
        for (const item of batch) item.resolve({ error: { kind: error.kind, message: error.message } });
        await this.deps.completeTasks?.(
          tabId,
          batch.map((b) => b.key).filter((k) => k !== ''),
        );
        await this.deps.logError?.(
          'background',
          error.kind,
          `Provider "${provider.name}": ${error.message}`,
          provider.id,
        );
        return;
      }
      await this.deps.logError?.(
        'failover',
        error.kind,
        `Provider "${provider.name}" 失败（${error.kind}），尝试链条下一个服务`,
        provider.id,
      );
    }
  }

  /**
   * Run one provider for a batch. Returns null on success (items already
   * resolved); otherwise the whole-batch failure (items left unresolved).
   */
  private async runBatch(
    settings: Settings,
    providerConfig: ProviderConfig,
    batch: QueueItem[],
    tabId?: number,
    actualProviderName?: string,
  ): Promise<{ kind: ErrorKind; message: string } | null> {
    let instance: TranslationProvider;
    try {
      instance = this.deps.createProvider(providerConfig);
    } catch (e) {
      const err = toProviderError(e);
      for (const item of batch) item.resolve({ error: { kind: err.kind, message: err.message } });
      await this.deps.logError?.('background', err.kind, err.message, providerConfig.id);
      return null;
    }
    const started = Date.now();
    const controller = new AbortController();
    this.registerInflight(tabId, controller);
    const onExternal = (): void => controller.abort();
    const extra = batch[0]?.signal;
    extra?.addEventListener('abort', onExternal);
    try {
      if (controller.signal.aborted || extra?.aborted) {
        throw new ProviderError('aborted', '请求已取消');
      }
      const texts = batch.map((b) => b.text);
      const ctx = buildContext(settings, providerConfig, batch[0]?.domain, batch[0]?.pageLanguage);
      const { source, target } = effectiveLanguages(settings, providerConfig);
      const translated = await instance.translateTexts(texts, ctx, controller.signal);
      const successes: { text: string; translated: string }[] = [];
      const doneKeys: string[] = [];
      batch.forEach((item, i) => {
        const t = translated[i];
        if (typeof t === 'string' && t.trim() !== '') {
          const cleaned = applyOutputSanitize(t, settings);
          if (!cleaned.ok) {
            item.resolve({ error: { kind: 'invalid_response', message: '译文卫生层剥离后为空' } });
            return;
          }
          item.resolve({
            translated: cleaned.text,
            ...(actualProviderName ? { actualProviderName } : {}),
          });
          successes.push({ text: item.text, translated: cleaned.text });
          if (item.key !== '') doneKeys.push(item.key);
        } else {
          item.resolve({ error: { kind: 'invalid_response', message: '该条目缺少翻译结果' } });
        }
      });
      this.deps.recordStat?.(providerConfig.id, true, Date.now() - started);
      if (settings.cacheEnabled && successes.length > 0) {
        try {
          await this.deps.cache.put(successes, providerConfig.id, source, target, settings.glossaryVersion);
        } catch {
          /* cache failures never break translation results */
        }
      }
      if (settings.translationMemory.enabled && successes.length > 0) {
        try {
          await this.deps.tm.remember(
            successes.map((s) => ({ source: s.text, target: s.translated })),
            tmLangPair(source, target),
            settings.translationMemory.maxEntries,
          );
        } catch {
          /* TM write is best-effort */
        }
      }
      void this.deps.completeTasks?.(tabId, doneKeys);
      return null;
    } catch (e) {
      const err = toProviderError(e);
      this.deps.recordStat?.(providerConfig.id, false, Date.now() - started, err.message);
      return { kind: err.kind, message: err.message };
    } finally {
      extra?.removeEventListener('abort', onExternal);
      this.unregisterInflight(tabId, controller);
    }
  }

  private async runStreamWithFailover(
    settings: Settings,
    primary: ProviderConfig,
    item: QueueItem,
  ): Promise<void> {
    const chain = buildFailoverChain(settings, primary.id);
    const attempts: ProviderConfig[] = [primary];
    for (const id of chain) {
      const next = settings.providers.find((p) => p.id === id);
      if (next) attempts.push(next);
    }

    for (let i = 0; i < attempts.length; i++) {
      const provider = attempts[i];
      const emitDeltas = i === 0;
      const error = await this.runStreamAttempt(
        settings,
        provider,
        item,
        emitDeltas,
        i > 0 ? provider.name : undefined,
      );
      if (!error) {
        if (i > 0) {
          await this.deps.logError?.(
            'failover',
            'unknown',
            `故障转移成功：${primary.name} → ${provider.name}`,
            provider.id,
          );
        }
        return;
      }
      const eligible = failoverEligible(error.kind, provider.type);
      if (!eligible || i === attempts.length - 1) {
        item.resolve({ error: { kind: error.kind, message: error.message } });
        await this.deps.logError?.(
          'background',
          error.kind,
          `Provider "${provider.name}": ${error.message}`,
          provider.id,
        );
        return;
      }
      await this.deps.logError?.(
        'failover',
        error.kind,
        `Provider "${provider.name}" 失败（${error.kind}），尝试链条下一个服务`,
        provider.id,
      );
    }
  }

  private async runStreamAttempt(
    settings: Settings,
    providerConfig: ProviderConfig,
    item: QueueItem,
    emitDeltas: boolean,
    actualProviderName?: string,
  ): Promise<{ kind: ErrorKind; message: string } | null> {
    let instance: TranslationProvider;
    try {
      instance = this.deps.createProvider(providerConfig);
    } catch (e) {
      const err = toProviderError(e);
      return { kind: err.kind, message: err.message };
    }
    const started = Date.now();
    const controller = new AbortController();
    const onExternal = (): void => controller.abort();
    item.signal?.addEventListener('abort', onExternal);
    try {
      if (item.signal?.aborted) {
        return { kind: 'aborted', message: '请求已取消' };
      }
      const ctx = buildContext(settings, providerConfig, item.domain, item.pageLanguage);
      const { source, target } = effectiveLanguages(settings, providerConfig);
      let full: string;
      const streaming = providerSupportsStreaming(instance);
      if (streaming && typeof instance.translateStream === 'function') {
        full = await instance.translateStream(
          item.text,
          ctx,
          (delta) => {
            if (emitDeltas) item.onDelta?.(delta);
          },
          controller.signal,
        );
      } else {
        const translated = await instance.translateTexts([item.text], ctx, controller.signal);
        full = translated[0] ?? '';
        if (emitDeltas && full !== '') item.onDelta?.(full);
      }
      if (typeof full !== 'string' || full.trim() === '') {
        return { kind: 'invalid_response', message: '缺少翻译结果' };
      }
      const cleaned = applyOutputSanitize(full, settings);
      if (!cleaned.ok) {
        return { kind: 'invalid_response', message: '译文卫生层剥离后为空' };
      }
      this.deps.recordStat?.(providerConfig.id, true, Date.now() - started);
      if (settings.cacheEnabled) {
        try {
          await this.deps.cache.put(
            [{ text: item.text, translated: cleaned.text }],
            providerConfig.id,
            source,
            target,
            settings.glossaryVersion,
          );
        } catch {
          /* best-effort */
        }
      }
      if (settings.translationMemory.enabled) {
        try {
          await this.deps.tm.remember(
            [{ source: item.text, target: cleaned.text }],
            tmLangPair(source, target),
            settings.translationMemory.maxEntries,
          );
        } catch {
          /* best-effort */
        }
      }
      item.resolve({
        translated: cleaned.text,
        ...(actualProviderName ? { actualProviderName } : {}),
      });
      return null;
    } catch (e) {
      const err = toProviderError(e);
      this.deps.recordStat?.(providerConfig.id, false, Date.now() - started, err.message);
      return { kind: err.kind, message: err.message };
    } finally {
      item.signal?.removeEventListener('abort', onExternal);
    }
  }

  private registerInflight(tabId: number | undefined, controller: AbortController): void {
    if (tabId === undefined) return;
    let set = this.inflightByTab.get(tabId);
    if (!set) {
      set = new Set();
      this.inflightByTab.set(tabId, set);
    }
    set.add(controller);
  }

  private unregisterInflight(tabId: number | undefined, controller: AbortController): void {
    if (tabId === undefined) return;
    const set = this.inflightByTab.get(tabId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.inflightByTab.delete(tabId);
  }
}