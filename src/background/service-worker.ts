/**
 * Background service worker (spec §10.1).
 *
 * Responsibilities: settings access, translation queue with batch merging,
 * provider invocation, timeout/retry (delegated to providers), cache writes,
 * error classification + logging. Never touches page DOM.
 */
import { sendTabCommand } from '../messaging/messages';
import type { RuntimeMessage } from '../messaging/messages';
import { createProvider, toProviderError } from '../providers/provider';
import type { TranslationProvider } from '../providers/provider';
// Side-effect imports: register provider factories.
import '../providers/openai-compatible';
import '../providers/custom-http';
import { cacheClear, cacheGet, cachePut, cacheStats } from '../storage/cache';
import { loadSettings, normalizeSettings, saveSettings } from '../storage/settings';
import {
  BATCH_WINDOW_MS,
  ERROR_LOG_KEY,
  ERROR_LOG_MAX,
  MAX_CONCURRENT_REQUESTS,
  defaultSettings,
} from '../shared/constants';
import type {
  ContentSettings,
  ErrorKind,
  ErrorLogEntry,
  ProviderConfig,
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

/* -------------------------------- error log --------------------------------- */

async function logError(where: string, kind: ErrorKind, message: string): Promise<void> {
  try {
    const data = await chrome.storage.local.get(ERROR_LOG_KEY);
    const entries = Array.isArray(data[ERROR_LOG_KEY]) ? (data[ERROR_LOG_KEY] as ErrorLogEntry[]) : [];
    entries.unshift({ ts: Date.now(), where, kind, message });
    await chrome.storage.local.set({ [ERROR_LOG_KEY]: entries.slice(0, ERROR_LOG_MAX) });
  } catch {
    // logging must never break the request path
  }
}

/* ------------------------------ translation queue ---------------------------- */

interface QueueItem {
  text: string;
  providerId: string;
  resolve: (r: { translated?: string; error?: { kind: ErrorKind; message: string } }) => void;
}

const queue: QueueItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueue(providerId: string, text: string): Promise<{ translated?: string; error?: { kind: ErrorKind; message: string } }> {
  return new Promise((resolve) => {
    queue.push({ text, providerId, resolve });
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushQueue();
      }, BATCH_WINDOW_MS);
    }
  });
}

async function flushQueue(): Promise<void> {
  const items = queue.splice(0, queue.length);
  if (items.length === 0) return;
  const settings = await getSettings(true);

  // Group by provider so each provider gets its own batches.
  const groups = new Map<string, QueueItem[]>();
  for (const item of items) {
    const list = groups.get(item.providerId) ?? [];
    list.push(item);
    groups.set(item.providerId, list);
  }

  const jobs: Promise<void>[] = [];
  for (const [providerId, group] of groups) {
    const provider = settings.providers.find((p) => p.id === providerId);
    if (!provider || !provider.enabled) {
      for (const item of group) {
        item.resolve({ error: { kind: 'config', message: '翻译服务未配置或已禁用' } });
      }
      continue;
    }
    if (provider.type === 'openai-compatible' && provider.apiKey.trim() === '') {
      for (const item of group) {
        item.resolve({ error: { kind: 'config', message: '未配置 API Key，请在设置页填写' } });
      }
      await logError('background', 'config', `Provider "${provider.name}": 未配置 API Key`);
      continue;
    }
    const { source, target } = effectiveLanguages(settings, provider);

    // Cache lookup first.
    let hits = new Map<string, string>();
    if (settings.cacheEnabled) {
      try {
        hits = await cacheGet(
          group.map((g, i) => ({ key: String(i), text: g.text })),
          providerId,
          source,
          target,
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
      jobs.push(runBatch(provider, source, target, b, settings.cacheEnabled));
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

async function runBatch(
  providerConfig: ProviderConfig,
  sourceLanguage: string,
  targetLanguage: string,
  batch: QueueItem[],
  cacheEnabled: boolean,
): Promise<void> {
  let instance: TranslationProvider;
  try {
    instance = createProvider(providerConfig);
  } catch (e) {
    const err = toProviderError(e);
    for (const item of batch) item.resolve({ error: { kind: err.kind, message: err.message } });
    await logError('background', err.kind, err.message);
    return;
  }
  try {
    const texts = batch.map((b) => b.text);
    const translated = await instance.translateTexts(texts, { sourceLanguage, targetLanguage }, new AbortController().signal);
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
    if (cacheEnabled && successes.length > 0) {
      try {
        await cachePut(successes, providerConfig.id, sourceLanguage, targetLanguage);
      } catch {
        // cache failures never break translation results
      }
    }
  } catch (e) {
    const err = toProviderError(e);
    for (const item of batch) item.resolve({ error: { kind: err.kind, message: err.message } });
    await logError('background', err.kind, `Provider "${providerConfig.name}": ${err.message}`);
  }
}

/* ------------------------------- message router ------------------------------ */

async function handleTranslate(items: TranslationItem[]): Promise<TranslateResults> {
  const settings = await getSettings();
  const activeProviderId = settings.activeProviderId;
  const settled = await Promise.all(
    items.map(async (item) => {
      const outcome = await enqueue(activeProviderId, item.text);
      return { key: item.key, outcome };
    }),
  );
  const results: TranslateResults = { results: {}, errors: {} };
  for (const { key, outcome } of settled) {
    if (outcome.translated !== undefined) results.results[key] = outcome.translated;
    else if (outcome.error) results.errors[key] = outcome.error;
    else results.errors[key] = { kind: 'unknown', message: '未知错误' };
  }
  return results;
}

async function handleTestProvider(provider: ProviderConfig): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    const instance = createProvider(provider);
    const source = provider.sourceLanguage.trim() !== '' ? provider.sourceLanguage : 'English';
    const target = provider.targetLanguage.trim() !== '' ? provider.targetLanguage : '简体中文';
    const controller = new AbortController();
    const translated = await instance.translateTexts(['Hello, world!'], { sourceLanguage: source, targetLanguage: target }, controller.signal);
    return { ok: true, result: translated[0] };
  } catch (e) {
    const err = toProviderError(e);
    await logError('test-provider', err.kind, err.message);
    return { ok: false, error: `${err.kind}: ${err.message}` };
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  void (async () => {
    try {
      switch (message.type) {
        case 'translate':
          sendResponse(await handleTranslate(message.items));
          break;
        case 'get-content-settings': {
          const s = await getSettings();
          const cs: ContentSettings = {
            defaultDisplayMode: s.defaultDisplayMode,
            autoTranslate: s.autoTranslate,
            blacklist: s.blacklist,
            minTextLength: s.minTextLength,
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
            providerConfigured: !!provider && provider.enabled && provider.baseUrl.trim() !== '',
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
});

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
});

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

