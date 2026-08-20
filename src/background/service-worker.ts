/**
 * Background service worker (spec §10.1, evolved for 2.0 §9 and 3.0 §9).
 *
 * chrome.runtime adapter: settings, OCR/ASR/PDF, menus, frame state.
 * Text translation goes through the in-process 翻译管线 module
 * (`src/translation/pipeline.ts`). Never touches page DOM.
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
import { createProvider, toProviderError } from '../providers/provider';
import { base64ToBytes } from '../shared/binaryChunk';
import { nativeRequest } from './nativePort';
import type { GatewayCapabilities } from '../shared/nativeRpc';
// Side-effect imports: register provider factories.
import '../providers/openai-compatible';
import '../providers/custom-http';
import '../providers/deepl';
import '../providers/azure-translator';
import '../providers/google-translate';
import '../providers/native-host';
import { pingNativeHost } from './nativePort';
import { cacheClear, cacheStats, ChromeTranslationCache } from '../storage/cache';
import { loadSettings, normalizeSettings, saveSettings } from '../storage/settings';
import { IdbTmStore, TranslationMemory } from '../storage/tm';
import {
  IdbOcrPackStore,
  OcrPackManager,
  knownPackId,
  resolveTessLangs,
  seedTesseractLangCache,
} from '../ocr/packs';
import {
  appendFeedback,
  clearFeedbackLog,
  deleteFeedbackEntry,
  loadFeedbackLog,
} from '../storage/feedback';
import { IdbTaskStore, TaskTable } from '../storage/taskTable';
import { detectLanguage } from '../shared/languageDetect';
import {
  DEFAULT_NATIVE_HOST_NAME,
  ERROR_LOG_KEY,
  ERROR_LOG_MAX,
  defaultSettings,
} from '../shared/constants';
import { OcrRoundTrip } from '../ocr/roundtrip';
import { AsrRoundTrip } from '../asr/roundtrip';
import { ChromeOcrCache } from '../ocr/resultCache';
import { TranslationPipeline } from '../translation/pipeline';
import { effectiveLanguages, isProviderConfigured } from '../translation/context';
import { providerCapabilities } from '../providers/capabilities';
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
const translationMemory = new TranslationMemory(new IdbTmStore());
const ocrPacks = new OcrPackManager(new IdbOcrPackStore());
let tmSessionHits = 0;

function detectBrowser(): 'firefox' | 'chromium' {
  return typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chromium';
}

function nativeFailureReason(error?: string): string {
  const browser = detectBrowser();
  if (browser === 'firefox') {
    return (
      (error ? error + '。' : '') +
      'Firefox 需安装器写入 HKCU\\Software\\Mozilla\\NativeMessagingHosts，且 allowed_extensions 包含 polypage@skymly.com（与 dist-firefox gecko.id 一致）。'
    );
  }
  return error ?? '本地网关未安装或不可达';
}

async function getSettings(force = false): Promise<Settings> {
  if (!settingsCache || force) settingsCache = await loadSettings();
  return settingsCache;
}

/** Last probed gateway capabilities (protocol=1 greys vision/ASR). */
let lastGatewayCaps: GatewayCapabilities | null = null;

function activeProviderCapabilities(settings: Settings) {
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  let instance = null;
  try {
    if (provider && isProviderConfigured(provider)) instance = createProvider(provider);
  } catch {
    instance = null;
  }
  return providerCapabilities(provider, instance, lastGatewayCaps);
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

async function completeTasks(tabId: number | undefined, keys: string[]): Promise<void> {
  if (tabId === undefined || keys.length === 0) return;
  try {
    await taskTable.markDone(tabId, keys);
  } catch {
    /* persistence is best-effort */
  }
}

/* ------------------------------ translation pipeline ------------------------- */

const pipeline = new TranslationPipeline({
  getSettings,
  cache: new ChromeTranslationCache(),
  tm: translationMemory,
  createProvider,
  recordStat,
  logError,
  onTmHit: () => {
    tmSessionHits += 1;
  },
  recordInflight: async (tabId, frameId, items) => {
    if (tabId === undefined || items.length === 0) return;
    try {
      await taskTable.markInflight(tabId, frameId ?? 0, items);
    } catch {
      /* persistence is best-effort */
    }
  },
  completeTasks,
});

const ocrRoundTrip = new OcrRoundTrip({
  getSettings,
  cache: new ChromeOcrCache(),
  createProvider,
  translateTexts: async (texts) => {
    const res = await pipeline.translate(
      texts.map((text, i) => ({ text, key: `ocr-${i}` })),
      { immediate: true },
    );
    return texts.map((_, i) => res.results[`ocr-${i}`] ?? '');
  },
  prepareTesseractLangs: async (tessLangs, extraLangs) => {
    const ready = await ocrPacks.readyIds();
    const resolved = await resolveTessLangs(tessLangs, extraLangs, ready);
    for (const id of resolved.langs) {
      const pack = await ocrPacks.getReady(id);
      if (pack) await seedTesseractLangCache(id, pack.data);
    }
    return resolved.langs;
  },
  recordStat,
  logError,
});

const asrRoundTrip = new AsrRoundTrip({
  getSettings,
  createProvider,
  translateTexts: async (texts) => {
    const res = await pipeline.translate(
      texts.map((text, i) => ({ text, key: `asr-${i}` })),
      { immediate: true },
    );
    return texts.map((_, i) => res.results[`asr-${i}`] ?? '');
  },
  recordStat,
});

async function handleTranslate(
  items: TranslationItem[],
  domain?: string,
  tabId?: number,
  frameId?: number,
  pageLanguage?: string | null,
): Promise<TranslateResults> {
  return pipeline.translate(
    items.map((item) => ({
      text: item.text,
      key: item.key,
      domain,
      tabId,
      frameId,
      pageLanguage,
    })),
  );
}

async function handleTranslateCue(
  text: string,
  domain?: string,
  tabId?: number,
): Promise<{ translated?: string; error?: string }> {
  const res = await pipeline.translate([{ text, domain, tabId }], { immediate: true });
  const translated = Object.values(res.results)[0];
  if (translated !== undefined) return { translated };
  const err = Object.values(res.errors)[0];
  return { error: err?.message ?? '翻译失败' };
}

async function handleStreamRequest(port: chrome.runtime.Port, init: StreamPortInit): Promise<void> {
  const post = (msg: StreamPortMessage): void => {
    try {
      port.postMessage(msg);
    } catch {
      /* receiver closed */
    }
  };
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  const res = await pipeline.translate(
    init.items.map((item) => ({ text: item.text, key: item.key, domain: init.domain })),
    {
      immediate: true,
      onDelta: (key, delta) => post({ type: 'delta', key, delta }),
      signal: controller.signal,
    },
  );
  for (const item of init.items) {
    const text = res.results[item.key];
    if (text !== undefined) post({ type: 'done', key: item.key, text });
    else {
      const err = res.errors[item.key];
      post({
        type: 'error',
        key: item.key,
        kind: err?.kind ?? 'unknown',
        message: err?.message ?? '翻译失败',
      });
    }
  }
  post({ type: 'finished' });
}


async function handleAsrStart(
  requestId: string,
  mime: string,
  base64: string,
  windowStart: number,
  windowDuration: number,
  languageHint?: string,
  tabId?: number,
): Promise<AsrResponse> {
  const settings = await getSettings(true);
  const controller = new AbortController();
  asrControllers.set(requestId, controller);
  try {
    const bytes = base64ToBytes(base64);
    return await asrRoundTrip.transcribeAndTranslate({
      mime,
      bytes,
      windowStart,
      windowDuration,
      languageHint,
      signal: controller.signal,
      emitPartials: settings.asr.streaming === true && tabId !== undefined,
      onPartial:
        tabId !== undefined
          ? (cues) => {
              void sendTabCommand(tabId, { type: 'wt:asr-partial', cues }).catch(() => undefined);
            }
          : undefined,
    });
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
  pipeline.cancelTab(tabId);
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

/* ------------------------------ OCR pipeline (3.0 F) ------------------------- */

const ocrControllers = new Map<string, AbortController>();
const asrControllers = new Map<string, AbortController>();

async function handleOcrRequest(
  requestId: string,
  url: string,
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
  cacheIdentity?: string,
): Promise<OcrResponse> {
  const controller = new AbortController();
  ocrControllers.set(requestId, controller);
  try {
    return await ocrRoundTrip.recognize({
      url,
      naturalWidth,
      naturalHeight,
      cacheIdentity,
      signal: controller.signal,
    });
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
      const vision = settings ? activeProviderCapabilities(settings).vision : true;
      chrome.contextMenus.create({
        id: MENU_TRANSLATE_IMAGE,
        title: vision ? '翻译图片文字 (PolyPage)' : '翻译图片文字（当前服务不支持视觉）',
        contexts: ['image'],
        enabled: vision,
      });
    }
    const asrEnabled = settings?.asr.enabled ?? true;
    const asr = settings ? activeProviderCapabilities(settings).asr : false;
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
            if (sender.tab?.id !== undefined) pipeline.cancelTab(sender.tab.id);
            sendResponse({ ok: true });
            break;
          case 'translate-selection': {
            const settings = await getSettings();
            const outcome = await pipeline.translate(
              [
                {
                  text: message.text,
                  domain: message.domain,
                  tabId: sender.tab?.id,
                  frameId: sender.frameId,
                  key: 'selection',
                },
              ],
            );
            if (outcome.results.selection !== undefined) {
              const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
              const target = provider
                ? effectiveLanguages(settings, provider).target
                : settings.defaultTargetLanguage;
              sendResponse({ ok: true, translated: outcome.results.selection, language: target });
            } else {
              sendResponse({ ok: false, error: outcome.errors.selection?.message ?? '翻译失败' });
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
            const vision = activeProviderCapabilities(s).vision;
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
              asrSupported: activeProviderCapabilities(s).asr,
              asrMaxSeconds: s.asr.maxSeconds,
              asrConfirmFull: s.asr.confirmFull,
              asrMaxUploadMb: s.asr.maxUploadMb,
              imageOverlayEnabled: s.imageOverlay.enabled,
              asrStreaming: s.asr.streaming,
              streamingSupported: activeProviderCapabilities(s).streaming,
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
              visionSupported: activeProviderCapabilities(s).vision,
              imageTranslateEnabled: s.imageTranslate.enabled,
              subtitlesEnabled: s.subtitles.enabled,
              pdfViewerEnabled: s.pdfViewer.enabled,
              selectionSpeak: s.selectionSpeak,
              asrSupported: activeProviderCapabilities(s).asr,
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
                lastGatewayCaps = { protocol: typeof ping.protocol === 'number' ? ping.protocol : 1 };
              }
            } else {
              lastGatewayCaps = null;
            }
            sendResponse({
              installed: ping.ok,
              version: ping.version,
              protocol: lastGatewayCaps?.protocol ?? ping.protocol,
              error: ping.error,
              browser: detectBrowser(),
              reason: ping.ok ? undefined : nativeFailureReason(ping.error),
            });
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
                sender.tab?.id,
              ),
            );
            break;
          case 'tm-clear':
            await translationMemory.clear();
            tmSessionHits = 0;
            sendResponse({ ok: true });
            break;
          case 'tm-stats': {
            const stats = await translationMemory.stats();
            const s = await getSettings();
            sendResponse({
              entries: stats.entries,
              hits: stats.hits,
              sessionHits: tmSessionHits,
              enabled: s.translationMemory.enabled,
            });
            break;
          }
          case 'ocr-pack-download': {
            try {
              if (!knownPackId(message.lang)) {
                sendResponse({ ok: false, error: '未列出的语言包' });
                break;
              }
              await ocrPacks.download(message.lang);
              const s = await getSettings(true);
              if (!s.ocrPacks.extraLangs.includes(message.lang)) {
                s.ocrPacks = { extraLangs: [...s.ocrPacks.extraLangs, message.lang] };
                s.imageTranslate = {
                  ...s.imageTranslate,
                  tessLangs: [...new Set([...s.imageTranslate.tessLangs, message.lang])],
                };
                await saveSettings(s);
                settingsCache = s;
              }
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
            }
            break;
          }
          case 'ocr-pack-progress':
            sendResponse({ packs: await ocrPacks.status() });
            break;
          case 'ocr-pack-remove': {
            try {
              await ocrPacks.remove(message.lang);
              const s = await getSettings(true);
              s.ocrPacks = { extraLangs: s.ocrPacks.extraLangs.filter((id) => id !== message.lang) };
              s.imageTranslate = {
                ...s.imageTranslate,
                tessLangs: s.imageTranslate.tessLangs.filter((id) => id !== message.lang),
              };
              await saveSettings(s);
              settingsCache = s;
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
            }
            break;
          }
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