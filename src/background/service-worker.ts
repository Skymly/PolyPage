/**
 * Background service worker (spec §10.1, evolved for 2.0 §9 and 3.0 §9).
 *
 * Responsibilities: settings access, translation queue with batch merging,
 * provider invocation, timeout/retry (delegated to providers), cache writes,
 * error classification + logging. Never touches page DOM.
 *
 * 2.0 additions:
 *  - failover chain execution (spec 2.0 §5.6);
 *  - per-frame page state aggregation (spec 2.0 §6.2);
 *  - native-host gateway probing (host-status, spec 2.0 §5.5);
 *  - per-provider sliding-window stats (spec 2.0 §8.3, P1);
 *  - context menu commands (spec 2.0 P1);
 *  - streaming translation over a runtime Port (spec 2.0 §7.3);
 *  - glossary + domain injected into the translation context.
 *
 * 3.0 additions:
 *  - OCR request routing: image fetch -> downsample -> vision provider,
 *    all through the existing cache + error classification (pillar F);
 *  - translate-cue low-latency path for subtitles (pillar G);
 *  - quality feedback log handlers (pillar H);
 *  - PDF reader open/progress messages (pillar E);
 *  - language detection helper + auto source-language fill-in (pillar H);
 *  - resume task table (IndexedDB) + SW-restart recovery (pillar H).
 */
import { sendTabCommand } from '../messaging/messages';
import type { AsrResponse, OcrResponse, RuntimeMessage, StreamPortInit, StreamPortMessage } from '../messaging/messages';
import { STREAM_PORT_NAME } from '../messaging/messages';
import { createProvider, providerSupportsAsr, providerSupportsStreaming, providerSupportsVision, toProviderError } from '../providers/provider';
import { normalizeTranscript } from '../asr/engine';
import { base64ToBytes } from '../shared/binaryChunk';
import { nativeRequest } from './nativePort';
import type { GatewayCapabilities } from '../shared/nativeRpc';
import type { ProviderError, TranslationContext, TranslationProvider } from '../providers/provider';
// Side-effect imports: register provider factories.
import '../providers/openai-compatible';
import '../providers/custom-http';
import '../providers/deepl';
import '../providers/azure-translator';
import '../providers/google-translate';
import '../providers/native-host';
import { pingNativeHost } from './nativePort';
import { cacheClear, cacheGet, cachePut, cacheStats } from '../storage/cache';
import { loadSettings, normalizeSettings, saveSettings } from '../storage/settings';
import {
  appendFeedback,
  clearFeedbackLog,
  deleteFeedbackEntry,
  loadFeedbackLog,
} from '../storage/feedback';
import { IdbTaskStore, TaskTable } from '../storage/taskTable';
import { engineNeedsVisionProvider } from '../ocr/engine';
import { LlmVisionEngine } from '../ocr/llm-vision';
import { TesseractEngine } from '../ocr/tesseract';
import { detectLanguage } from '../shared/languageDetect';
import { computeDownsample, needsDownsample } from '../shared/imageUtils';
import {
  BATCH_WINDOW_MS,
  DEFAULT_NATIVE_HOST_NAME,
  ERROR_LOG_KEY,
  ERROR_LOG_MAX,
  IMAGE_MAX_BYTES,
  MAX_CONCURRENT_REQUESTS,
  defaultSettings,
} from '../shared/constants';
import { renderGlossary } from '../shared/siteRules';
import type {
  ContentSettings,
  ErrorKind,
  ErrorLogEntry,
  FeedbackEntry,
  FrameStateEntry,
  PageState,
  ProviderConfig,
  ProviderStats,
  Settings,
  SettingsSummary,
  TranslateResults,
  TranslationItem,
} from '../shared/types';

/* --------------------------------- settings --------------------------------- */

let settingsCache: Settings | null = null;

async function getSettings(force = false): Promise<Settings> {
  if (!settingsCache || force) settingsCache = await loadSettings();
  return settingsCache;
}

function effectiveLanguages(settings: Settings, provider: ProviderConfig) {
  return {
    source: provider.sourceLanguage.trim() !== '' ? provider.sourceLanguage : settings.defaultSourceLanguage,
    target: provider.targetLanguage.trim() !== '' ? provider.targetLanguage : settings.defaultTargetLanguage,
  };
}

/**
 * Build the provider context. 3.0: when the effective source language is
 * "auto" and language detection is on, the detected page language fills in
 * (spec 3.0 §8.1 item 2); uncertain detection falls back to the original
 * auto behavior (spec §8.1 item 4).
 */
function buildContext(
  settings: Settings,
  provider: ProviderConfig,
  domain?: string,
  pageLanguage?: string | null,
): TranslationContext {
  const { source, target } = effectiveLanguages(settings, provider);
  const resolvedSource =
    source.trim().toLowerCase() === 'auto' &&
    settings.languageDetection === 'auto' &&
    typeof pageLanguage === 'string' &&
    pageLanguage !== ''
      ? pageLanguage
      : source;
  return {
    sourceLanguage: resolvedSource,
    targetLanguage: target,
    domain,
    glossary: renderGlossary(settings.glossary),
  };
}

function isProviderConfigured(provider: ProviderConfig): boolean {
  if (!provider.enabled) return false;
  if (provider.type === 'native-host') return (provider.hostName ?? '').trim() !== '';
  return provider.baseUrl.trim() !== '';
}

/** Last probed gateway capabilities (protocol=1 greys vision/ASR). */
let lastGatewayCaps: GatewayCapabilities | null = null;

/** Vision capability probe for menu/popup greying (spec 3.0 §6.2 item 3). */
function activeProviderSupportsVision(settings: Settings): boolean {
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  if (!provider || !isProviderConfigured(provider)) return false;
  if (provider.type === 'native-host') {
    return (lastGatewayCaps?.protocol ?? 1) >= 2 && !!lastGatewayCaps?.supportsVision;
  }
  try {
    return providerSupportsVision(createProvider(provider));
  } catch {
    return false;
  }
}

function activeProviderSupportsAsr(settings: Settings): boolean {
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  if (!provider || !isProviderConfigured(provider)) return false;
  if (provider.type === 'native-host') {
    return (lastGatewayCaps?.protocol ?? 1) >= 2 && !!lastGatewayCaps?.supportsAsr;
  }
  try {
    return providerSupportsAsr(createProvider(provider));
  } catch {
    return false;
  }
}

/* ------------------------------- provider stats ------------------------------ */

const STATS_WINDOW = 50;
const providerStats = new Map<string, { results: boolean[]; latencies: number[]; lastError: string | null }>();

function recordStat(providerId: string, ok: boolean, latencyMs: number, error?: string): void {
  let entry = providerStats.get(providerId);
  if (!entry) {
    entry = { results: [], latencies: [], lastError: null };
    providerStats.set(providerId, entry);
  }
  entry.results.push(ok);
  entry.latencies.push(latencyMs);
  if (entry.results.length > STATS_WINDOW) {
    entry.results.shift();
    entry.latencies.shift();
  }
  if (!ok && error) entry.lastError = error;
  if (ok) entry.lastError = entry.lastError; // keep last error visible
}

function snapshotStats(): Record<string, ProviderStats> {
  const out: Record<string, ProviderStats> = {};
  for (const [id, entry] of providerStats) {
    const calls = entry.results.length;
    const ok = entry.results.filter(Boolean).length;
    const avgMs = calls > 0 ? Math.round(entry.latencies.reduce((a, b) => a + b, 0) / calls) : 0;
    out[id] = { calls, ok, avgMs, lastError: entry.lastError };
  }
  return out;
}

/* -------------------------------- error log ---------------------------------- */

async function logError(
  where: string,
  kind: ErrorKind,
  message: string,
  providerId?: string,
): Promise<void> {
  try {
    const data = await chrome.storage.local.get(ERROR_LOG_KEY);
    const entries = Array.isArray(data[ERROR_LOG_KEY]) ? (data[ERROR_LOG_KEY] as ErrorLogEntry[]) : [];
    entries.unshift({ ts: Date.now(), where, kind, message, ...(providerId ? { providerId } : {}) });
    await chrome.storage.local.set({ [ERROR_LOG_KEY]: entries.slice(0, ERROR_LOG_MAX) });
  } catch {
    /* logging must never break translation */
  }
}

/* -------------------------------- task table --------------------------------- */

/** Resume task table (spec 3.0 §8.4). Falls back to in-memory when IndexedDB
 *  is unavailable (never blocks translation). */
const taskTable = new TaskTable(new IdbTaskStore());

async function recordInflight(
  tabId: number | undefined,
  frameId: number | undefined,
  key: string,
  text: string,
): Promise<void> {
  if (tabId === undefined || key === '') return;
  try {
    await taskTable.markInflight(tabId, frameId ?? 0, [{ key, text }]);
  } catch {
    /* persistence is best-effort */
  }
}

async function completeTasks(tabId: number | undefined, keys: string[]): Promise<void> {
  if (tabId === undefined || keys.length === 0) return;
  try {
    await taskTable.markDone(tabId, keys);
  } catch {
    /* persistence is best-effort */
  }
}

/* --------------------------------- queue ------------------------------------- */

interface QueueItem {
  text: string;
  providerId: string;
  domain?: string;
  tabId?: number;
  frameId?: number;
  key: string;
  pageLanguage?: string | null;
  resolve: (r: { translated?: string; error?: { kind: ErrorKind; message: string } }) => void;
}

const inflightByTab = new Map<number, Set<AbortController>>();
function registerInflight(tabId: number | undefined, controller: AbortController): void {
  if (tabId === undefined) return;
  let set = inflightByTab.get(tabId);
  if (!set) {
    set = new Set();
    inflightByTab.set(tabId, set);
  }
  set.add(controller);
}

function unregisterInflight(tabId: number | undefined, controller: AbortController): void {
  if (tabId === undefined) return;
  const set = inflightByTab.get(tabId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) inflightByTab.delete(tabId);
}

function cancelTabTranslations(tabId: number): void {
  const set = inflightByTab.get(tabId);
  if (!set) return;
  inflightByTab.delete(tabId);
  for (const controller of set) {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }
}

const queue: QueueItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Set by the last flush when a failover served a batch (popup hint). */
let lastFailoverInfo: { providerName: string } | null = null;

interface EnqueueOptions {
  domain?: string;
  tabId?: number;
  frameId?: number;
  key?: string;
  pageLanguage?: string | null;
  /** Skip the 80ms batch window (subtitle cues need low latency). */
  immediate?: boolean;
}

function enqueue(
  providerId: string,
  text: string,
  options: EnqueueOptions = {},
): Promise<{ translated?: string; error?: { kind: ErrorKind; message: string } }> {
  return new Promise((resolve) => {
    queue.push({
      text,
      providerId,
      domain: options.domain,
      tabId: options.tabId,
      frameId: options.frameId,
      key: options.key ?? '',
      pageLanguage: options.pageLanguage,
      resolve,
    });
    const schedule = (): void => {
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          void flushQueue();
        }, BATCH_WINDOW_MS);
      }
    };
    if (options.immediate) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      void flushQueue();
    } else {
      schedule();
    }
  });
}

/** Errors that justify failing over to the next provider (spec 2.0 §5.6). */
function failoverEligible(kind: ErrorKind, providerType: string): boolean {
  if (kind === 'network' || kind === 'timeout' || kind === 'rate_limit' || kind === 'server') return true;
  // native host not installed / unreachable counts as a config failure.
  return kind === 'config' && providerType === 'native-host';
}

/** Ordered list of provider ids to try after `providerId` fails. */
function buildFailoverChain(settings: Settings, providerId: string): string[] {
  const chain: string[] = [];
  const configured = settings.failoverChain ?? [];
  const index = configured.indexOf(providerId);
  if (index >= 0) chain.push(...configured.slice(index + 1));
  else chain.push(...configured.filter((id) => id !== providerId));
  // native-host per-provider fallback always participates.
  const provider = settings.providers.find((p) => p.id === providerId);
  if (provider?.type === 'native-host' && provider.fallbackProviderId) {
    if (!chain.includes(provider.fallbackProviderId)) chain.push(provider.fallbackProviderId);
  }
  // Deduplicate and drop disabled/missing providers.
  const seen = new Set<string>();
  return chain.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const p = settings.providers.find((x) => x.id === id);
    return !!p && isProviderConfigured(p);
  });
}

async function flushQueue(): Promise<void> {
  const items = queue.splice(0, queue.length);
  if (items.length === 0) return;
  const settings = await getSettings(true);

  // Group by provider AND tab so each batch belongs to exactly one cancel
  // scope (spec 2.0 §5.3 item 5: cancel must not hit unrelated tabs).
  const groups = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = `${item.providerId}|${item.tabId ?? -1}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const jobs: Promise<void>[] = [];
  for (const group of groups.values()) {
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
      await logError('background', 'config', `Provider "${provider?.name ?? providerId}": ${message}`, providerId);
      continue;
    }
    const { source, target } = effectiveLanguages(settings, provider);

    // Cache lookup first (glossary version participates in the key).
    let hits = new Map<string, string>();
    if (settings.cacheEnabled) {
      try {
        hits = await cacheGet(
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
      if (cached !== undefined) item.resolve({ translated: cached });
      else misses.push(item);
    });
    if (misses.length === 0) continue;

    // 3.0 resume: persist in-flight tasks before hitting the network.
    await recordInflight(
      groupTabId,
      groupFrameId,
      misses.length === 1 ? misses[0].key : '',
      misses.length === 1 ? misses[0].text : '',
    );
    if (misses.length > 1) {
      try {
        await taskTable.markInflight(
          groupTabId ?? -1,
          groupFrameId ?? 0,
          misses.filter((m) => m.key !== '').map((m) => ({ key: m.key, text: m.text })),
        );
      } catch {
        /* best-effort */
      }
    }

    // Respect batch size limits.
    let chars = 0;
    let batch: QueueItem[] = [];
    const batches: QueueItem[][] = [];
    for (const item of misses) {
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
      jobs.push(runBatchWithFailover(settings, provider, b, groupTabId));
    }
  }

  // Run with bounded concurrency.
  let index = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, jobs.length) }, async () => {
    while (index < jobs.length) {
      const job = jobs[index++];
      await job;
    }
  });
  await Promise.all(workers);
}

/**
 * Run one batch; on an eligible whole-batch failure walk the failover chain
 * (spec 2.0 §5.6). Failover applies to the whole batch, once per provider.
 */
async function runBatchWithFailover(
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
    const error = await runBatch(settings, provider, batch, tabId);
    if (!error) {
      if (i > 0) {
        lastFailoverInfo = { providerName: provider.name };
        await logError(
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
      await completeTasks(tabId, batch.map((b) => b.key).filter((k) => k !== ''));
      await logError('background', error.kind, `Provider "${provider.name}": ${error.message}`, provider.id);
      return;
    }
    await logError(
      'failover',
      error.kind,
      `Provider "${provider.name}" 失败（${error.kind}），尝试链条下一个服务`,
      provider.id,
    );
  }
}

/**
 * Run one provider for a batch. Returns null on success; otherwise the
 * ProviderError describing the whole-batch failure (items left unresolved).
 */
async function runBatch(
  settings: Settings,
  providerConfig: ProviderConfig,
  batch: QueueItem[],
  tabId?: number,
): Promise<{ kind: ErrorKind; message: string } | null> {
  let instance: TranslationProvider;
  try {
    instance = createProvider(providerConfig);
  } catch (e) {
    const err = toProviderError(e);
    for (const item of batch) item.resolve({ error: { kind: err.kind, message: err.message } });
    await logError('background', err.kind, err.message, providerConfig.id);
    return null;
  }
  const started = Date.now();
  const controller = new AbortController();
  registerInflight(tabId, controller);
  try {
    const texts = batch.map((b) => b.text);
    const ctx = buildContext(settings, providerConfig, batch[0]?.domain, batch[0]?.pageLanguage);
    const { source, target } = effectiveLanguages(settings, providerConfig);
    const translated = await instance.translateTexts(texts, ctx, controller.signal);
    const successes: { text: string; translated: string }[] = [];
    const doneKeys: string[] = [];
    batch.forEach((item, i) => {
      const t = translated[i];
      if (typeof t === 'string' && t.trim() !== '') {
        item.resolve({ translated: t });
        successes.push({ text: item.text, translated: t });
        if (item.key !== '') doneKeys.push(item.key);
      } else {
        item.resolve({ error: { kind: 'invalid_response', message: '该条目缺少翻译结果' } });
      }
    });
    recordStat(providerConfig.id, true, Date.now() - started);
    if (settings.cacheEnabled && successes.length > 0) {
      try {
        await cachePut(successes, providerConfig.id, source, target, settings.glossaryVersion);
      } catch {
        // cache failures never break translation results
      }
    }
    // Fire-and-forget: awaiting here would settle the batch one microtask
    // later, letting handleTranslate read lastFailoverInfo before
    // runBatchWithFailover writes it (actualProvider attribution race).
    void completeTasks(tabId, doneKeys);
    return null;
  } catch (e) {
    const err = toProviderError(e) as ProviderError;
    recordStat(providerConfig.id, false, Date.now() - started, err.message);
    return { kind: err.kind, message: err.message };
  } finally {
    unregisterInflight(tabId, controller);
  }
}
/* ------------------------------- message router ------------------------------ */

async function handleTranslate(
  items: TranslationItem[],
  domain?: string,
  tabId?: number,
  frameId?: number,
  pageLanguage?: string | null,
): Promise<TranslateResults> {
  const settings = await getSettings();
  const activeProviderId = settings.activeProviderId;
  const settled = await Promise.all(
    items.map(async (item) => {
      const outcome = await enqueue(activeProviderId, item.text, {
        domain,
        tabId,
        frameId,
        key: item.key,
        pageLanguage,
      });
      return { key: item.key, outcome };
    }),
  );
  const results: TranslateResults = { results: {}, errors: {} };
  for (const { key, outcome } of settled) {
    if (outcome.translated !== undefined) results.results[key] = outcome.translated;
    else if (outcome.error) results.errors[key] = outcome.error;
    else results.errors[key] = { kind: 'unknown', message: '未知错误' };
  }
  if (lastFailoverInfo) {
    results.actualProviderName = lastFailoverInfo.providerName;
    lastFailoverInfo = null;
  }
  return results;
}

/** 3.0 (pillar G): low-latency single-text path for subtitle cues — same
 *  provider/cache/error machinery, no batch window. */
async function handleTranslateCue(
  text: string,
  domain?: string,
  tabId?: number,
): Promise<{ translated?: string; error?: string }> {
  const settings = await getSettings();
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  if (!provider || !isProviderConfigured(provider)) {
    return { error: '翻译服务未配置或已禁用' };
  }
  const { source, target } = effectiveLanguages(settings, provider);
  if (settings.cacheEnabled) {
    try {
      const hits = await cacheGet(
        [{ key: 'cue', text }],
        provider.id,
        source,
        target,
        settings.glossaryVersion,
      );
      const cached = hits.get('cue');
      if (cached !== undefined) return { translated: cached };
    } catch {
      /* fall through to provider */
    }
  }
  let instance: TranslationProvider;
  try {
    instance = createProvider(provider);
  } catch (e) {
    return { error: toProviderError(e).message };
  }
  const started = Date.now();
  const controller = new AbortController();
  registerInflight(tabId, controller);
  try {
    const ctx = buildContext(settings, provider, domain);
    const translated = await instance.translateTexts([text], ctx, controller.signal);
    const first = translated[0];
    if (typeof first !== 'string' || first.trim() === '') {
      return { error: '缺少翻译结果' };
    }
    recordStat(provider.id, true, Date.now() - started);
    if (settings.cacheEnabled) {
      try {
        await cachePut([{ text, translated: first }], provider.id, source, target, settings.glossaryVersion);
      } catch {
        /* cache best-effort */
      }
    }
    return { translated: first };
  } catch (e) {
    const err = toProviderError(e);
    recordStat(provider.id, false, Date.now() - started, err.message);
    return { error: err.message };
  } finally {
    unregisterInflight(tabId, controller);
  }
}

async function handleAsrStart(
  requestId: string,
  mime: string,
  base64: string,
  windowStart: number,
  windowDuration: number,
  languageHint?: string,
): Promise<AsrResponse> {
  const settings = await getSettings(true);
  if (!settings.asr.enabled) {
    return { ok: false, kind: 'config', error: '语音转写已在设置中关闭' };
  }
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  if (!provider || !isProviderConfigured(provider)) {
    return { ok: false, kind: 'config', error: '翻译服务未配置或已禁用' };
  }
  if (!activeProviderSupportsAsr(settings)) {
    return { ok: false, kind: 'config', error: '当前翻译服务不支持转写' };
  }
  let instance: TranslationProvider;
  try {
    instance = createProvider(provider);
  } catch (e) {
    return { ok: false, kind: 'config', error: toProviderError(e).message };
  }
  if (typeof instance.transcribe !== 'function') {
    return { ok: false, kind: 'config', error: '当前翻译服务不支持转写' };
  }
  const bytes = base64ToBytes(base64);
  const maxBytes = settings.asr.maxUploadMb * 1024 * 1024;
  if (bytes.byteLength > maxBytes) {
    return { ok: false, kind: 'config', error: `音频超过上传上限（${settings.asr.maxUploadMb} MB）` };
  }
  const controller = new AbortController();
  asrControllers.set(requestId, controller);
  const started = Date.now();
  try {
    const ctx = {
      ...buildContext(settings, provider),
      languageHint: languageHint && languageHint !== 'auto' ? languageHint : undefined,
    };
    const raw = await instance.transcribe({ mime, bytes }, ctx, controller.signal);
    const cues = normalizeTranscript(raw, windowStart, windowDuration);
    recordStat(provider.id, true, Date.now() - started);
    return {
      ok: true,
      cues: cues.map((c) => ({ start: c.start, end: c.end, text: c.text, translation: '' })),
    };
  } catch (e) {
    const err = toProviderError(e);
    recordStat(provider.id, false, Date.now() - started, err.message);
    return { ok: false, kind: err.kind, error: err.message };
  } finally {
    asrControllers.delete(requestId);
  }
}

async function handleTestProvider(provider: ProviderConfig): Promise<{ ok: boolean; result?: string; latencyMs?: number; error?: string }> {
  const started = Date.now();
  try {
    const instance = createProvider(provider);
    const source = provider.sourceLanguage.trim() !== '' ? provider.sourceLanguage : 'English';
    const target = provider.targetLanguage.trim() !== '' ? provider.targetLanguage : '简体中文';
    const controller = new AbortController();
    const translated = await instance.translateTexts(
      ['Hello, world!'],
      { sourceLanguage: source, targetLanguage: target, glossary: renderGlossary((await getSettings()).glossary) },
      controller.signal,
    );
    return { ok: true, result: translated[0], latencyMs: Date.now() - started };
  } catch (e) {
    const err = toProviderError(e);
    await logError('test-provider', err.kind, err.message, provider.id);
    return { ok: false, error: `${err.kind}: ${err.message}` };
  }
}

/* ------------------------------ frame state map ------------------------------ */

const frameStates = new Map<number, Map<number, PageState>>();

function recordFrameState(tabId: number | undefined, frameId: number | undefined, state: PageState): void {
  if (tabId === undefined) return;
  let frames = frameStates.get(tabId);
  if (!frames) {
    frames = new Map();
    frameStates.set(tabId, frames);
  }
  frames.set(frameId ?? 0, state);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  frameStates.delete(tabId);
  cancelTabTranslations(tabId);
  void taskTable.removeTab(tabId).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') frameStates.delete(tabId);
});

async function handleGetFrameStates(tabId?: number): Promise<{ frames: FrameStateEntry[] }> {
  let target = tabId;
  if (target === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    target = tab?.id;
  }
  if (target === undefined) return { frames: [] };
  const frames = frameStates.get(target);
  if (!frames) return { frames: [] };
  return {
    frames: [...frames.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([frameId, state]) => ({ frameId, state })),
  };
}

/* --------------------------------- streaming --------------------------------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== STREAM_PORT_NAME) return;
  port.onMessage.addListener((raw: unknown) => {
    const init = raw as StreamPortInit;
    if (!init || !Array.isArray(init.items)) return;
    void handleStreamRequest(port, init).catch(() => {
      /* port may already be gone */
    });
  });
});

async function handleStreamRequest(port: chrome.runtime.Port, init: StreamPortInit): Promise<void> {
  const settings = await getSettings(true);
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  const post = (msg: StreamPortMessage): void => {
    try {
      port.postMessage(msg);
    } catch {
      /* receiver closed */
    }
  };
  if (!provider || !isProviderConfigured(provider)) {
    for (const item of init.items) {
      post({ type: 'error', key: item.key, kind: 'config', message: '翻译服务未配置或已禁用' });
    }
    post({ type: 'finished' });
    return;
  }
  let instance: TranslationProvider;
  try {
    instance = createProvider(provider);
  } catch (e) {
    const err = toProviderError(e);
    for (const item of init.items) post({ type: 'error', key: item.key, kind: err.kind, message: err.message });
    post({ type: 'finished' });
    return;
  }

  const ctx = buildContext(settings, provider, init.domain);
  const streaming = providerSupportsStreaming(instance);
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  if (!streaming) {
    // Fallback: batch translate, then emit each result as a single delta.
    try {
      const texts = init.items.map((i) => i.text);
      const translated = await instance.translateTexts(texts, ctx, controller.signal);
      init.items.forEach((item, i) => {
        const text = translated[i] ?? '';
        if (text !== '') {
          post({ type: 'delta', key: item.key, delta: text });
          post({ type: 'done', key: item.key, text });
        } else {
          post({ type: 'error', key: item.key, kind: 'invalid_response', message: '缺少翻译结果' });
        }
      });
      if (settings.cacheEnabled) {
        const successes = init.items
          .map((item, i) => ({ text: item.text, translated: translated[i] ?? '' }))
          .filter((x) => x.translated !== '');
        const { source, target } = effectiveLanguages(settings, provider);
        await cachePut(successes, provider.id, source, target, settings.glossaryVersion);
      }
    } catch (e) {
      const err = toProviderError(e);
      for (const item of init.items) post({ type: 'error', key: item.key, kind: err.kind, message: err.message });
    }
    post({ type: 'finished' });
    return;
  }

  for (const item of init.items) {
    if (controller.signal.aborted) break;
    try {
      const full = await instance.translateStream!(
        item.text,
        ctx,
        (delta) => post({ type: 'delta', key: item.key, delta }),
        controller.signal,
      );
      post({ type: 'done', key: item.key, text: full });
      if (settings.cacheEnabled) {
        const { source, target } = effectiveLanguages(settings, provider);
        await cachePut([{ text: item.text, translated: full }], provider.id, source, target, settings.glossaryVersion);
      }
    } catch (e) {
      const err = toProviderError(e);
      post({ type: 'error', key: item.key, kind: err.kind, message: err.message });
    }
  }
  post({ type: 'finished' });
}
/* ------------------------------ OCR pipeline (3.0 F) ------------------------- */

const ocrControllers = new Map<string, AbortController>();
const asrControllers = new Map<string, AbortController>();

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Fetch image bytes from the background (host permissions apply). */
async function fetchImageBytes(url: string, signal: AbortSignal): Promise<{ buffer: ArrayBuffer; mime: string }> {
  const res = await fetch(url, { signal, credentials: 'include' });
  if (!res.ok) throw new Error(`图片下载失败（HTTP ${res.status}）`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error('图片内容为空');
  return { buffer, mime: res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png' };
}

/** Downsample when edge/size limits are exceeded (spec 3.0 §6.2 item 4). */
async function prepareDataUrl(
  buffer: ArrayBuffer,
  mime: string,
  maxEdgePx: number,
): Promise<string> {
  const bytes = new Uint8Array(buffer);
  let bitmap: ImageBitmap | null = null;
  try {
    if (!needsDownsample(1, 1, buffer.byteLength, maxEdgePx, IMAGE_MAX_BYTES)) {
      return bytesToDataUrl(bytes, mime);
    }
    bitmap = await createImageBitmap(new Blob([buffer], { type: mime }));
  } catch {
    // Undecodable as an image bitmap: send raw bytes and let the API decide.
    return bytesToDataUrl(bytes, mime);
  }
  const needsResize = needsDownsample(bitmap.width, bitmap.height, buffer.byteLength, maxEdgePx, IMAGE_MAX_BYTES);
  if (!needsResize) {
    bitmap.close();
    return bytesToDataUrl(bytes, mime);
  }
  const target = computeDownsample(bitmap.width, bitmap.height, maxEdgePx);
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return bytesToDataUrl(bytes, mime);
  }
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const out = new Uint8Array(await blob.arrayBuffer());
  return bytesToDataUrl(out, 'image/jpeg');
}

/** Full OCR round trip: fetch -> hash -> cache -> engine -> optional translate -> cache put. */
async function handleOcrRequest(
  requestId: string,
  url: string,
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
  cacheIdentity?: string,
): Promise<OcrResponse> {
  const settings = await getSettings(true);
  if (!settings.imageTranslate.enabled) {
    return { ok: false, kind: 'config', error: '图片翻译已在设置中关闭' };
  }
  const engineId = settings.imageTranslate.engine;
  const needsVision = engineNeedsVisionProvider(engineId);
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  const providerReady = !!provider && isProviderConfigured(provider);

  // llm-vision still requires a configured provider. tesseract-wasm can run
  // OCR-only (仅识别) when the provider is missing or unconfigured.
  if (needsVision && !providerReady) {
    return { ok: false, kind: 'config', error: '翻译服务未配置或已禁用' };
  }

  let instance: TranslationProvider | undefined;
  if (providerReady && provider) {
    try {
      instance = createProvider(provider);
    } catch (e) {
      const err = toProviderError(e);
      if (needsVision) return { ok: false, kind: err.kind, error: err.message };
    }
  }
  if (needsVision) {
    if (!instance) {
      return { ok: false, kind: 'config', error: '翻译服务未配置或已禁用' };
    }
    if (!providerSupportsVision(instance)) {
      return { ok: false, kind: 'config', error: '当前翻译服务不支持视觉翻译' };
    }
  }

  const controller = new AbortController();
  ocrControllers.set(requestId, controller);
  const started = Date.now();
  try {
    const { buffer, mime } = await fetchImageBytes(url, controller.signal);
    const contentHash = await sha256Hex(buffer);
    // Cache key: content hash for fetchable images; URL + natural size as
    // the fallback identity (spec 3.0 §6.4 item 1). Language pair and
    // glossaryVersion join via the shared cache key builder. Engine id is
    // always included so tesseract / vision results never collide.
    const identity = contentHash
      ? `img|${contentHash}`
      : `imgurl|${url}|${naturalWidth ?? 0}x${naturalHeight ?? 0}`;
    const cacheText = `img:${cacheIdentity ?? identity}|${engineId}`;
    const { source, target } = provider
      ? effectiveLanguages(settings, provider)
      : { source: settings.defaultSourceLanguage, target: settings.defaultTargetLanguage };
    if (settings.cacheEnabled && provider) {
      try {
        const hits = await cacheGet(
          [{ key: 'ocr', text: cacheText }],
          provider.id,
          source,
          target,
          settings.glossaryVersion,
        );
        const cached = hits.get('ocr');
        if (cached !== undefined) {
          const segments = JSON.parse(cached) as { text: string; translation: string }[];
          return { ok: true, segments, cached: true, engine: engineId };
        }
      } catch {
        /* fall through */
      }
    }

    const dataUrl = await prepareDataUrl(buffer, mime, settings.imageTranslate.maxEdgePx);
    const ctx = provider
      ? buildContext(settings, provider)
      : {
          sourceLanguage: settings.defaultSourceLanguage,
          targetLanguage: settings.defaultTargetLanguage,
          glossary: renderGlossary(settings.glossary),
        };
    const engine =
      engineId === 'tesseract-wasm'
        ? new TesseractEngine(undefined, settings.imageTranslate.tessLangs)
        : new LlmVisionEngine(instance!);
    const result = await engine.recognize({ dataUrl }, ctx, controller.signal);
    let segments = result.segments;
    if (engine.id === 'tesseract-wasm' && instance) {
      const texts = segments.map((s) => s.text);
      const translated = texts.length > 0 ? await instance.translateTexts(texts, ctx, controller.signal) : [];
      segments = segments.map((s, i) => ({ text: s.text, translation: translated[i] ?? '' }));
    }
    if (provider) {
      recordStat(provider.id, true, Date.now() - started);
    }

    if (settings.cacheEnabled && provider) {
      try {
        await cachePut(
          [{ text: cacheText, translated: JSON.stringify(segments) }],
          provider.id,
          source,
          target,
          settings.glossaryVersion,
        );
      } catch {
        /* cache best-effort */
      }
    }
    return { ok: true, segments, cached: false, engine: engine.id };
  } catch (e) {
    const err = toProviderError(e);
    if (provider) {
      recordStat(provider.id, false, Date.now() - started, err.message);
    }
    await logError('ocr', err.kind, `图片翻译失败: ${err.message}`, provider?.id);
    return { ok: false, kind: err.kind, error: err.message };
  } finally {
    ocrControllers.delete(requestId);
  }
}

/* ------------------------------ PDF reader (3.0 E) --------------------------- */

function looksLikePdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return url.toLowerCase().split('?')[0].endsWith('.pdf');
  }
}

function viewerUrlFor(src: string): string {
  return chrome.runtime.getURL(`viewer/pdf-viewer.html?src=${encodeURIComponent(src)}`);
}

const pdfProgressByTab = new Map<number, { url: string; done: number; total: number; failed: number }>();

async function handlePdfOpen(url: string): Promise<{ ok: boolean; tabId?: number; error?: string }> {
  const settings = await getSettings();
  if (!settings.pdfViewer.enabled) {
    return { ok: false, error: 'PDF 双语阅读器已在设置中关闭' };
  }
  let normalized: string;
  try {
    normalized = new URL(url).toString();
  } catch {
    return { ok: false, error: '无效的 URL' };
  }
  if (normalized.startsWith('chrome') || normalized.startsWith('about:')) {
    return { ok: false, error: '无法打开内部页面' };
  }
  const tab = await chrome.tabs.create({ url: viewerUrlFor(normalized) });
  return { ok: true, ...(tab.id !== undefined ? { tabId: tab.id } : {}) };
}

/* ------------------------------- resume (3.0 H) ------------------------------ */

/**
 * SW startup recovery (spec 3.0 §8.4 item 2): scan persisted in-flight
 * records whose tabs are still alive and ask the content scripts to
 * re-submit them. Cache idempotency skips anything already done.
 */
async function recoverInflightTasks(): Promise<void> {
  try {
    const inflight = await taskTable.listInflight();
    if (inflight.length === 0) return;
    const byTab = new Map<number, string[]>();
    for (const rec of inflight) {
      if (rec.tabId < 0) continue;
      const keys = byTab.get(rec.tabId) ?? [];
      keys.push(rec.taskKey);
      byTab.set(rec.tabId, keys);
    }
    for (const [tabId, keys] of byTab) {
      try {
        await chrome.tabs.get(tabId); // throws when the tab is gone
        await sendTabCommand(tabId, { type: 'wt:resume-inflight', keys });
      } catch {
        // Tab closed or content script absent — drop the records.
      }
      await taskTable.removeTab(tabId);
    }
  } catch {
    /* IndexedDB unavailable; resume is best-effort */
  }
}

/* ------------------------------ context menus -------------------------------- */

const MENU_TRANSLATE_PAGE = 'wt-translate-page';
const MENU_TRANSLATE_SELECTION = 'wt-translate-selection';
const MENU_OPEN_PDF = 'wt-open-pdf';
const MENU_TRANSLATE_IMAGE = 'wt-translate-image';
const MENU_TRANSCRIBE_MEDIA = 'wt-transcribe-media';

function setupContextMenus(settings?: Settings): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_PAGE,
      title: '翻译此页 (PolyPage)',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_SELECTION,
      title: '翻译选中文字 (PolyPage)',
      contexts: ['selection'],
    });
    const pdfEnabled = settings?.pdfViewer.enabled ?? true;
    if (pdfEnabled) {
      chrome.contextMenus.create({
        id: MENU_OPEN_PDF,
        title: '用 PolyPage 打开双语阅读器',
        contexts: ['page', 'link'],
      });
    }
    const imageEnabled = settings?.imageTranslate.enabled ?? true;
    if (imageEnabled) {
      const vision = settings ? activeProviderSupportsVision(settings) : true;
      chrome.contextMenus.create({
        id: MENU_TRANSLATE_IMAGE,
        title: vision ? '翻译图片文字 (PolyPage)' : '翻译图片文字（当前服务不支持视觉）',
        contexts: ['image'],
        enabled: vision,
      });
    }
    const asrEnabled = settings?.asr.enabled ?? true;
    const asr = settings ? activeProviderSupportsAsr(settings) : false;
    if (asrEnabled) {
      chrome.contextMenus.create({
        id: MENU_TRANSCRIBE_MEDIA,
        title: asr ? '转写并翻译 (PolyPage)' : '转写并翻译（当前服务不支持）',
        contexts: ['video', 'audio'],
        enabled: asr,
      });
    }
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === MENU_TRANSLATE_PAGE) {
      await sendTabCommand(tab.id, { type: 'wt:translate' });
    } else if (info.menuItemId === MENU_TRANSLATE_SELECTION) {
      await sendTabCommand(tab.id, { type: 'wt:translate-selection' });
    } else if (info.menuItemId === MENU_TRANSLATE_IMAGE) {
      if (typeof info.srcUrl === 'string' && info.srcUrl !== '') {
        await sendTabCommand(tab.id, { type: 'wt:translate-image', url: info.srcUrl });
      }
    } else if (info.menuItemId === MENU_TRANSCRIBE_MEDIA) {
      await sendTabCommand(tab.id, { type: 'wt:transcribe-media' });
    } else if (info.menuItemId === MENU_OPEN_PDF) {
      const url =
        typeof info.linkUrl === 'string' && info.linkUrl !== ''
          ? info.linkUrl
          : info.pageUrl ?? tab.url ?? '';
      if (url === '') return;
      // Content script may confirm/normalize the URL (page context).
      let target = url;
      if (!looksLikePdfUrl(url) && typeof info.linkUrl !== 'string') {
        try {
          const res = await sendTabCommand(tab.id, { type: 'wt:open-pdf-viewer' });
          if (res?.url) target = res.url;
        } catch {
          /* no content script — use the raw URL */
        }
      }
      void handlePdfOpen(target).then((res) => {
        if (!res.ok) void logError('pdf-open', 'config', res.error ?? '无法打开阅读器');
      });
    }
  } catch {
    // content script not present (e.g. chrome:// pages) — ignore
  }
});
/* ---------------------------------- router ----------------------------------- */

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, sender: chrome.runtime.MessageSender, sendResponse) => {
    void (async () => {
      try {
        switch (message.type) {
          case 'translate':
            sendResponse(
              await handleTranslate(
                message.items,
                message.domain,
                sender.tab?.id,
                sender.frameId,
                message.pageLanguage,
              ),
            );
            break;
          case 'cancel-translations':
            if (sender.tab?.id !== undefined) cancelTabTranslations(sender.tab.id);
            sendResponse({ ok: true });
            break;
          case 'translate-selection': {
            const settings = await getSettings();
            const outcome = await enqueue(settings.activeProviderId, message.text, {
              domain: message.domain,
              tabId: sender.tab?.id,
              frameId: sender.frameId,
              key: 'selection',
            });
            if (outcome.translated !== undefined) {
              const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
              const target = provider
                ? effectiveLanguages(settings, provider).target
                : settings.defaultTargetLanguage;
              sendResponse({ ok: true, translated: outcome.translated, language: target });
            } else {
              sendResponse({ ok: false, error: outcome.error?.message ?? '翻译失败' });
            }
            break;
          }
          case 'translate-cue': {
            const res = await handleTranslateCue(message.text, message.domain, sender.tab?.id);
            if (res.translated !== undefined) sendResponse({ ok: true, translated: res.translated });
            else sendResponse({ ok: false, error: res.error ?? '翻译失败' });
            break;
          }
          case 'get-content-settings': {
            const s = await getSettings();
            const vision = activeProviderSupportsVision(s);
            const cs: ContentSettings = {
              defaultDisplayMode: s.defaultDisplayMode,
              autoTranslate: s.autoTranslate,
              blacklist: s.blacklist,
              minTextLength: s.minTextLength,
              selectionTranslate: s.selectionTranslate,
              siteRules: s.siteRules,
              inlineBudget: s.inlineBudget,
              viewportBudget: s.viewportBudget,
              defaultTargetLanguage: s.defaultTargetLanguage,
              languageDetection: s.languageDetection,
              selectionSpeak: s.selectionSpeak,
              imageTranslateEnabled: s.imageTranslate.enabled,
              imageTranslateTrigger: s.imageTranslate.trigger,
              visionSupported: vision,
              subtitlesEnabled: s.subtitles.enabled,
              subtitleBilingual: s.subtitles.bilingual,
              subtitleFontSizePct: s.subtitles.fontSizePct,
              subtitleSwapSrcDst: s.subtitles.swapSrcDst,
              subtitleBackground: s.subtitles.background,
              subtitlePosition: s.subtitles.position,
              ocrEngine: s.imageTranslate.engine,
              ocrAvailable: s.imageTranslate.enabled && (s.imageTranslate.engine === 'tesseract-wasm' || vision),
              asrEnabled: s.asr.enabled,
              asrSupported: activeProviderSupportsAsr(s),
              asrMaxSeconds: s.asr.maxSeconds,
              asrConfirmFull: s.asr.confirmFull,
              asrMaxUploadMb: s.asr.maxUploadMb,
            };
            sendResponse(cs);
            break;
          }
          case 'get-settings-summary': {
            const s = await getSettings();
            const provider = s.providers.find((p) => p.id === s.activeProviderId);
            const summary: SettingsSummary = {
              providerName: provider?.name ?? '(未配置)',
              providerType: provider?.type ?? 'openai-compatible',
              targetLanguage: provider
                ? effectiveLanguages(s, provider).target
                : s.defaultTargetLanguage,
              sourceLanguage: provider
                ? effectiveLanguages(s, provider).source
                : s.defaultSourceLanguage,
              defaultDisplayMode: s.defaultDisplayMode,
              autoTranslate: s.autoTranslate,
              providerConfigured: !!provider && isProviderConfigured(provider),
              selectionTranslate: s.selectionTranslate,
              visionSupported: activeProviderSupportsVision(s),
              imageTranslateEnabled: s.imageTranslate.enabled,
              subtitlesEnabled: s.subtitles.enabled,
              pdfViewerEnabled: s.pdfViewer.enabled,
              selectionSpeak: s.selectionSpeak,
              asrSupported: activeProviderSupportsAsr(s),
              asrEnabled: s.asr.enabled,
            };
            sendResponse(summary);
            break;
          }
          case 'get-full-settings':
            sendResponse({ settings: await getSettings(true) });
            break;
          case 'save-settings': {
            const normalized = normalizeSettings(message.settings);
            await saveSettings(normalized);
            settingsCache = normalized;
            setupContextMenus(normalized);
            sendResponse({ ok: true });
            break;
          }
          case 'test-provider':
            sendResponse(await handleTestProvider(normalizeProviderSafe(message.provider)));
            break;
          case 'get-cache-stats':
            sendResponse(await cacheStats());
            break;
          case 'clear-cache':
            await cacheClear();
            sendResponse({ ok: true });
            break;
          case 'get-error-log': {
            const data = await chrome.storage.local.get(ERROR_LOG_KEY);
            sendResponse({ entries: Array.isArray(data[ERROR_LOG_KEY]) ? data[ERROR_LOG_KEY] : [] });
            break;
          }
          case 'clear-error-log':
            await chrome.storage.local.remove(ERROR_LOG_KEY);
            sendResponse({ ok: true });
            break;
          case 'report-frame-state':
            recordFrameState(sender.tab?.id, sender.frameId, message.state);
            sendResponse({ ok: true });
            break;
          case 'get-frame-states':
            sendResponse(await handleGetFrameStates(message.tabId));
            break;
          case 'host-status': {
            const hostName = message.hostName?.trim() || DEFAULT_NATIVE_HOST_NAME;
            const ping = await pingNativeHost(hostName);
            if (ping.ok) {
              try {
                lastGatewayCaps = await nativeRequest<GatewayCapabilities>(
                  hostName,
                  'capabilities',
                  {},
                  { timeoutMs: 8000 },
                );
              } catch {
                lastGatewayCaps = { protocol: 1 };
              }
            } else {
              lastGatewayCaps = null;
            }
            sendResponse({ installed: ping.ok, version: ping.version, error: ping.error });
            break;
          }
          case 'get-provider-stats':
            sendResponse({ stats: snapshotStats() });
            break;
          case 'get-export-payload': {
            let tabId = message.tabId;
            if (tabId === undefined) {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              tabId = tab?.id;
            }
            if (tabId === undefined) {
              sendResponse({ ok: false, error: '找不到活动标签页' });
              break;
            }
            try {
              // Broadcast to all frames; the top frame is expected to answer.
              const payload = await sendTabCommand(tabId, { type: 'wt:collect-export' });
              sendResponse({ ok: true, ...payload });
            } catch (e) {
              sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
            }
            break;
          }
          /* ---------------------------- 3.0 additions --------------------------- */
          case 'ocr-request':
            sendResponse(
              await handleOcrRequest(
                message.requestId,
                message.url,
                message.naturalWidth,
                message.naturalHeight,
                message.cacheIdentity,
              ),
            );
            break;
          case 'ocr-cancel': {
            const controller = ocrControllers.get(message.requestId);
            controller?.abort();
            sendResponse({ ok: true });
            break;
          }
          case 'mark-feedback': {
            const s = await getSettings();
            const provider = s.providers.find((p) => p.id === s.activeProviderId);
            const entry: FeedbackEntry = {
              ts: Date.now(),
              source: message.source,
              translation: message.translation,
              pageUrl: message.pageUrl,
              where: message.where,
              ...(message.providerName ? { providerName: message.providerName } : {}),
              ...(provider ? { providerId: provider.id } : {}),
            };
            if (!entry.providerName && provider) entry.providerName = provider.name;
            await appendFeedback(entry);
            sendResponse({ ok: true });
            break;
          }
          case 'get-feedback-log':
            sendResponse({ entries: await loadFeedbackLog() });
            break;
          case 'delete-feedback-entry':
            await deleteFeedbackEntry(message.ts);
            sendResponse({ ok: true });
            break;
          case 'clear-feedback-log':
            await clearFeedbackLog();
            sendResponse({ ok: true });
            break;
          case 'pdf-open':
            sendResponse(await handlePdfOpen(message.url));
            break;
          case 'pdf-progress':
            if (sender.tab?.id !== undefined) {
              pdfProgressByTab.set(sender.tab.id, {
                url: message.url,
                done: message.done,
                total: message.total,
                failed: message.failed,
              });
            }
            sendResponse({ ok: true });
            break;
          case 'detect-language': {
            const result = detectLanguage(message.texts);
            sendResponse({ language: result.language, confident: result.confident });
            break;
          }
          case 'asr-start':
            sendResponse(
              await handleAsrStart(
                message.requestId,
                message.mime,
                message.base64,
                message.windowStart,
                message.windowDuration,
                message.languageHint,
              ),
            );
            break;
          case 'asr-cancel': {
            asrControllers.get(message.requestId)?.abort();
            sendResponse({ ok: true });
            break;
          }
          default:
            sendResponse({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        const err = toProviderError(e);
        await logError('message-handler', err.kind, err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async response
  },
);

function normalizeProviderSafe(raw: ProviderConfig): ProviderConfig {
  // Reuse settings normalization to coerce the provider shape.
  const normalized = normalizeSettings({ providers: [raw], activeProviderId: raw.id });
  return normalized.providers[0];
}

/* --------------------- webNavigation auto-open (3.0 E, P1) ------------------- */

async function maybeAutoOpenPdf(details: { tabId: number; frameId: number; url: string }): Promise<void> {
  if (details.frameId !== 0) return;
  if (!looksLikePdfUrl(details.url)) return;
  if (details.url.startsWith('chrome-extension://')) return;
  try {
    const settings = await getSettings();
    if (!settings.pdfViewer.enabled || !settings.pdfViewer.autoOpen) return;
    const granted = await chrome.permissions.contains({ permissions: ['webNavigation'] });
    if (!granted) return;
    await chrome.tabs.update(details.tabId, { url: viewerUrlFor(details.url) });
  } catch {
    /* permission missing or tab gone */
  }
}

if (chrome.webNavigation?.onCompleted) {
  chrome.webNavigation.onCompleted.addListener((details) => {
    void maybeAutoOpenPdf(details);
  });
}

/* ------------------------------ install & commands --------------------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const existing = await chrome.storage.local.get('settings');
    if (!existing.settings) {
      await saveSettings(defaultSettings());
    }
  }
  setupContextMenus(await getSettings(true).catch(() => undefined));
});

// Service workers can restart; make sure context menus exist.
void getSettings(true)
  .then((s) => setupContextMenus(s))
  .catch(() => setupContextMenus());

// 3.0 resume: recover persisted in-flight tasks on every SW start.
void recoverInflightTasks();

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    if (command === 'toggle-translate') {
      await sendTabCommand(tab.id, { type: 'wt:toggle' });
    } else if (command === 'repeat-selection') {
      // 3.0 (spec §8.3 item 2): Alt+Q repeats the last selection translate.
      await sendTabCommand(tab.id, { type: 'wt:repeat-selection' });
    }
  } catch {
    // content script not present (e.g. chrome:// pages) — ignore
  }
});