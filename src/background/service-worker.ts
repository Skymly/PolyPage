/**
 * Background service worker entry point and runtime message adapter.
 * OCR uses the separate round-trip cache described in ADR-0002.
 */
import { kindedFailure, protocolVersionOk, sendTabCommand } from '../messaging/messages';
import type { RuntimeMessage } from '../messaging/messages';
import { listProviderModels } from '../providers/modelCatalog';
import { toProviderError } from '../providers/provider';
// Register provider factories before handling browser events.
import '../providers/openai-compatible';
import '../providers/opencode-go';
import '../providers/custom-http';
import '../providers/deepl';
import '../providers/azure-translator';
import '../providers/google-translate';
import '../providers/native-host';
import { ocrCacheClear } from '../ocr/resultCache';
import { defaultSettings, ERROR_LOG_KEY } from '../shared/constants';
import type { FeedbackEntry, SelectionTranslateMode, SettingsSummary } from '../shared/types';
import { cacheClear, cacheStats } from '../storage/cache';
import {
  appendFeedback,
  clearFeedbackLog,
  deleteFeedbackEntry,
  loadFeedbackLog,
  sanitizeFeedbackPageUrl,
} from '../storage/feedback';
import { applyFullSettingsSave, normalizeProvider, normalizeSettings, saveSettings } from '../storage/settings';
import { effectiveLanguages, isProviderConfigured } from '../translation/context';
import { cancelAsr, handleAsrStart } from './asrRequests';
import { registerContextMenus, setupContextMenus } from './contextMenus';
import { logError, snapshotStats } from './diagnostics';
import { activeProviderCapabilities, ensureGatewayProbed, hostStatus } from './gatewayStatus';
import { cancelOcr, downloadOcrPack, handleOcrRequest, ocrPackStatus, removeOcrPack } from './ocrRequests';
import { openCodeGoQuotaStatus, startOpenCodeGoQuotaMonitor } from './opencodeGoQuota';
import { handlePdfOpen, pdfProgressByTab, registerPdfAutoOpen } from './pdfRequests';
import { PRIVILEGED_SETTINGS_DENIED, extensionOriginOf, isExtensionPageSender } from './privilegedSender';
import { tabIdForTranslate } from './recoverInflight';
import { broadcastSettingsChanged, buildContentSettings, getSettings, persistSettings } from './settingsState';
import { handleGetFrameStates, recordFrameState, recoverInflightTasks, registerTabCleanup, takeInflight } from './tabState';
import {
  cancelTranslations,
  clearTranslationMemory,
  handleTestProvider,
  handleTranslate,
  handleTranslateCue,
  registerTranslationPort,
  translateSelection,
  translationMemoryStats,
} from './translationRequests';

registerTabCleanup(cancelTranslations);
registerTranslationPort();
registerContextMenus();
registerPdfAutoOpen();
startOpenCodeGoQuotaMonitor();

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, sender: chrome.runtime.MessageSender, sendResponse) => {
    void (async () => {
      try {
        if (!protocolVersionOk(message)) {
          sendResponse(kindedFailure('config', `unsupported protocol v`));
          return;
        }
        const extensionOrigin = extensionOriginOf(chrome.runtime.getURL('/'));
        switch (message.type) {
          case 'translate':
            sendResponse(
              await handleTranslate(
                message.items,
                message.domain,
                tabIdForTranslate(message.tabId, sender.tab?.id),
                sender.frameId,
                message.pageLanguage,
              ),
            );
            break;
          case 'cancel-translations':
            if (sender.tab?.id !== undefined) cancelTranslations(sender.tab.id);
            sendResponse({ ok: true });
            break;
          case 'translate-selection':
            sendResponse(await translateSelection(message.text, message.domain, sender.tab?.id, sender.frameId));
            break;
          case 'translate-cue': {
            const res = await handleTranslateCue(message.text, message.domain, sender.tab?.id);
            if (res.translated !== undefined) sendResponse({ ok: true, translated: res.translated });
            else sendResponse(kindedFailure(res.kind ?? 'unknown', res.error ?? '翻译失败'));
            break;
          }
          case 'get-content-settings': {
            await ensureGatewayProbed();
            const s = await getSettings();
            sendResponse(buildContentSettings(s, sender.tab?.url));
            break;
          }
          case 'get-settings-summary': {
            await ensureGatewayProbed();
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
            if (!isExtensionPageSender(sender, extensionOrigin)) {
              sendResponse({ settings: null, error: PRIVILEGED_SETTINGS_DENIED });
              break;
            }
            sendResponse({ settings: await getSettings(true) });
            break;
          case 'save-settings': {
            if (!isExtensionPageSender(sender, extensionOrigin)) {
              sendResponse({ ok: false, error: PRIVILEGED_SETTINGS_DENIED });
              break;
            }
            const incoming = normalizeSettings(message.settings);
            const current = await getSettings(true);
            const next = applyFullSettingsSave(
              incoming,
              current,
              message.replaceAll ? 'replace' : 'merge-packs',
            );
            await persistSettings(next);
            setupContextMenus(next);
            sendResponse({ ok: true, settings: next });
            void broadcastSettingsChanged();
            break;
          }
          case 'set-selection-translate': {
            if (!isExtensionPageSender(sender, extensionOrigin)) {
              sendResponse({ ok: false, error: PRIVILEGED_SETTINGS_DENIED });
              break;
            }
            const current = await getSettings(true);
            const selectionTranslate: SelectionTranslateMode = message.enabled ? 'always' : 'off';
            const next = { ...current, selectionTranslate };
            await persistSettings(next);
            setupContextMenus(next);
            sendResponse({ ok: true });
            void broadcastSettingsChanged();
            break;
          }
          case 'get-viewer-settings': {
            if (!isExtensionPageSender(sender, extensionOrigin)) {
              sendResponse({ ok: false, error: PRIVILEGED_SETTINGS_DENIED });
              break;
            }
            const s = await getSettings();
            sendResponse({
              pdfViewer: {
                defaultMode: s.pdfViewer.defaultMode,
                skipHeadersFooters: s.pdfViewer.skipHeadersFooters,
                maxConcurrentPages: s.pdfViewer.maxConcurrentPages,
                scannedPageOcr: s.pdfViewer.scannedPageOcr,
                layoutPreset: s.pdfViewer.layoutPreset,
              },
              imageTranslate: {
                maxEdgePx: s.imageTranslate.maxEdgePx,
                engine: s.imageTranslate.engine,
              },
            });
            break;
          }
          case 'test-provider':
            if (!isExtensionPageSender(sender, extensionOrigin)) {
              sendResponse({ ok: false, error: PRIVILEGED_SETTINGS_DENIED });
              break;
            }
            sendResponse(await handleTestProvider(message.provider));
            break;
          case 'list-provider-models': {
            if (!isExtensionPageSender(sender, extensionOrigin)) {
              sendResponse({ ok: false, error: PRIVILEGED_SETTINGS_DENIED });
              break;
            }
            const provider = normalizeProvider(message.provider);
            if (!provider) {
              sendResponse(kindedFailure('config', '翻译服务配置无效'));
              break;
            }
            sendResponse({ ok: true, models: await listProviderModels(provider) });
            break;
          }
          case 'opencode-go-quota': {
            if (!isExtensionPageSender(sender, extensionOrigin)) {
              sendResponse({ ok: false, error: PRIVILEGED_SETTINGS_DENIED });
              break;
            }
            const status = await openCodeGoQuotaStatus(message.providerId, message.apiKey, message.refresh === true);
            sendResponse({ ok: true, status });
            break;
          }
          case 'get-cache-stats':
            sendResponse(await cacheStats());
            break;
          case 'clear-cache':
            await cacheClear();
            await ocrCacheClear();
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
          case 'host-status':
            sendResponse(await hostStatus(message.hostName, getSettings));
            break;
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
            if (!sender.url) {
              sendResponse({ ok: false, kind: 'config', error: '缺少调用方 URL' });
              break;
            }
            sendResponse(
              await handleOcrRequest(
                message.requestId,
                message.url,
                message.naturalWidth,
                message.naturalHeight,
                message.cacheIdentity,
                sender,
                message.userGesture === true,
              ),
            );
            break;
          case 'ocr-cancel': {
            cancelOcr(message.requestId);
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
              pageUrl: sanitizeFeedbackPageUrl(message.pageUrl),
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
            await clearTranslationMemory();
            sendResponse({ ok: true });
            break;
          case 'tm-stats':
            sendResponse(await translationMemoryStats());
            break;
          case 'ocr-pack-download':
            try {
              sendResponse(await downloadOcrPack(message.lang));
            } catch (e) {
              sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
            }
            break;
          case 'ocr-pack-progress':
            sendResponse({ packs: await ocrPackStatus() });
            break;
          case 'ocr-pack-remove':
            try {
              await removeOcrPack(message.lang);
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
            }
            break;
          case 'asr-cancel': {
            cancelAsr(message.requestId);
            sendResponse({ ok: true });
            break;
          }
          case 'get-inflight':
            await takeInflight(message.tabId, sender.tab?.id, sendResponse);
            break;
          default:
            sendResponse(kindedFailure('config', 'unknown message'));
        }
      } catch (e) {
        const err = toProviderError(e);
        await logError('message-handler', err.kind, err.message);
        sendResponse(kindedFailure(err.kind, err.message));
      }
    })();
    return true; // async response
  },
);

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
void ensureGatewayProbed();

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
