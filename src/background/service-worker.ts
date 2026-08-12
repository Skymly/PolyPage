/**
 * Background service worker (spec §10.1, evolved for 2.0 §9).
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
 */
import { sendTabCommand } from '../messaging/messages';
import type { RuntimeMessage, StreamPortInit, StreamPortMessage } from '../messaging/messages';
import { STREAM_PORT_NAME } from '../messaging/messages';
import { createProvider, providerSupportsStreaming, toProviderError } from '../providers/provider';
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
  BATCH_WINDOW_MS,
  DEFAULT_NATIVE_HOST_NAME,
  ERROR_LOG_KEY,
  ERROR_LOG_MAX,
  MAX_CONCURRENT_REQUESTS,
  defaultSettings,
} from '../shared/constants';
import { renderGlossary } from '../shared/siteRules';
import type {
  ContentSettings,
  ErrorKind,
  ErrorLogEntry,
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

function buildContext(settings: Settings, provider: ProviderConfig, domain?: string): TranslationContext {
  const { source, target } = effectiveLanguages(settings, provider);
  return {
    sourceLanguage: source,
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
    // logging must never break the request path
  }
}

/* ------------------------------ translation queue ---------------------------- */

interface QueueItem {
  text: string;
  providerId: string;
  domain?: string;
  /** Originating tab (used for cancel semantics, spec 2.0 §5.3 item 5). */
  tabId?: number;
  resolve: (r: { translated?: string; error?: { kind: ErrorKind; message: string } }) => void;
}

/** In-flight batch controllers per tab so restore/mode-switch can cancel. */
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

function enqueue(
  providerId: string,
  text: string,
  domain?: string,
  tabId?: number,
): Promise<{ translated?: string; error?: { kind: ErrorKind; message: string } }> {
  return new Promise((resolve) => {
    queue.push({ text, providerId, domain, tabId, resolve });
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushQueue();
      }, BATCH_WINDOW_MS);
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
    const ctx = buildContext(settings, providerConfig, batch[0]?.domain);
    const { source, target } = effectiveLanguages(settings, providerConfig);
    const translated = await instance.translateTexts(texts, ctx, controller.signal);
    const successes: { text: string; translated: string }[] = [];
    batch.forEach((item, i) => {
      const t = translated[i];
      if (typeof t === 'string' && t.trim() !== '') {
        item.resolve({ translated: t });
        successes.push({ text: item.text, translated: t });
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
): Promise<TranslateResults> {
  const settings = await getSettings();
  const activeProviderId = settings.activeProviderId;
  const settled = await Promise.all(
    items.map(async (item) => {
      const outcome = await enqueue(activeProviderId, item.text, domain, tabId);
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

/* -------------------------------- context menus ------------------------------ */

function setupContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'wt-translate-page',
      title: '翻译此页 (PolyPage)',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'wt-translate-selection',
      title: '翻译选中文字 (PolyPage)',
      contexts: ['selection'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === 'wt-translate-page') {
      await sendTabCommand(tab.id, { type: 'wt:translate' });
    } else if (info.menuItemId === 'wt-translate-selection') {
      await sendTabCommand(tab.id, { type: 'wt:translate-selection' });
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
            sendResponse(await handleTranslate(message.items, message.domain, sender.tab?.id));
            break;
          case 'cancel-translations':
            if (sender.tab?.id !== undefined) cancelTabTranslations(sender.tab.id);
            sendResponse({ ok: true });
            break;
          case 'translate-selection': {
            const settings = await getSettings();
            const outcome = await enqueue(
              settings.activeProviderId,
              message.text,
              message.domain,
              sender.tab?.id,
            );
            if (outcome.translated !== undefined) {
              sendResponse({ ok: true, translated: outcome.translated });
            } else {
              sendResponse({ ok: false, error: outcome.error?.message ?? '翻译失败' });
            }
            break;
          }
          case 'get-content-settings': {
            const s = await getSettings();
            const cs: ContentSettings = {
              defaultDisplayMode: s.defaultDisplayMode,
              autoTranslate: s.autoTranslate,
              blacklist: s.blacklist,
              minTextLength: s.minTextLength,
              selectionTranslate: s.selectionTranslate,
              siteRules: s.siteRules,
              inlineBudget: s.inlineBudget,
              viewportBudget: s.viewportBudget,
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

/* ------------------------------ install & commands --------------------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const existing = await chrome.storage.local.get('settings');
    if (!existing.settings) {
      await saveSettings(defaultSettings());
    }
  }
  setupContextMenus();
});

// Service workers can restart; make sure context menus exist.
setupContextMenus();

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await sendTabCommand(tab.id, { type: 'wt:toggle' });
  } catch {
    // content script not present (e.g. chrome:// pages) — ignore
  }
});

