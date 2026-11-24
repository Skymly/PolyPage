import { withProtocol } from '../messaging/messages';
import { hostnameFromUrl } from '../shared/siteRules';
import { computeOcrAvailable, tesseractRuntimeAvailable } from '../shared/tesseractRuntime';
import type { ContentSettings, Settings } from '../shared/types';
import { loadSettings, saveSettings } from '../storage/settings';
import { buildFailoverChain, effectiveLanguages, isProviderConfigured } from '../translation/context';
import { activeProviderCapabilities } from './gatewayStatus';

let settingsCache: Settings | null = null;

export async function getSettings(force = false): Promise<Settings> {
  if (!settingsCache || force) settingsCache = await loadSettings();
  return settingsCache;
}

export async function persistSettings(settings: Settings): Promise<void> {
  await saveSettings(settings);
  settingsCache = settings;
}

export function imageRoute(settings: Settings): string {
  const provider = settings.providers.find(p => p.id === settings.activeProviderId);
  const ready = provider && isProviderConfigured(provider);
  if (settings.imageTranslate.engine === 'llm-vision') {
    return ready ? `图片发送至 ${provider.name} 识别并翻译` : '请先配置视觉翻译服务';
  }
  if (!ready) return '本机识别，仅提取文字';
  const backups = buildFailoverChain(settings, provider.id)
    .map(id => settings.providers.find(p => p.id === id)?.name).filter(Boolean);
  return `本机识别，文字发给 ${provider.name}${backups.length ? `（备用：${backups.join('、')}）` : ''}`;
}

export function buildContentSettings(s: Settings, tabUrl?: string): ContentSettings {
  const caps = activeProviderCapabilities(s);
  const vision = caps.vision;
  const provider = s.providers.find((p) => p.id === s.activeProviderId);
  return {
    defaultDisplayMode: s.defaultDisplayMode,
    autoTranslate: s.autoTranslate,
    blacklist: s.blacklist,
    minTextLength: s.minTextLength,
    selectionTranslate: s.selectionTranslate,
    siteRules: s.siteRules,
    inlineBudget: s.inlineBudget,
    viewportBudget: s.viewportBudget,
    defaultTargetLanguage: s.defaultTargetLanguage,
    draftTargetLanguage: s.draftTargetLanguage,
    languageDetection: s.languageDetection,
    selectionSpeak: s.selectionSpeak,
    selectionTargetLanguage: provider ? effectiveLanguages(s, provider).target : s.defaultTargetLanguage,
    imageTranslateEnabled: s.imageTranslate.enabled,
    imageTranslateTrigger: s.imageTranslate.trigger,
    imageRoute: imageRoute(s),
    visionSupported: vision,
    subtitlesEnabled: s.subtitles.enabled,
    subtitleBilingual: s.subtitles.bilingual,
    subtitleFontSizePct: s.subtitles.fontSizePct,
    subtitleSwapSrcDst: s.subtitles.swapSrcDst,
    subtitleBackground: s.subtitles.background,
    subtitlePosition: s.subtitles.position,
    ocrEngine: s.imageTranslate.engine,
    ocrAvailable: computeOcrAvailable(
      s.imageTranslate.enabled,
      s.imageTranslate.engine,
      vision,
      tesseractRuntimeAvailable(),
    ),
    asrEnabled: s.asr.enabled,
    asrSupported: caps.asr,
    asrMaxSeconds: s.asr.maxSeconds,
    asrConfirmFull: s.asr.confirmFull,
    asrMaxUploadMb: s.asr.maxUploadMb,
    imageOverlayEnabled: s.imageOverlay.enabled,
    asrStreaming: s.asr.streaming,
    streamingSupported: caps.streaming,
    tabHostname: hostnameFromUrl(tabUrl),
  };
}

export async function broadcastSettingsChanged(): Promise<void> {
  const s = await getSettings();
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (tab.id == null) continue;
    const cs = buildContentSettings(s, tab.url);
    try {
      chrome.tabs.sendMessage(tab.id, withProtocol({
        type: 'wt:settings-changed',
        settings: cs,
      }), () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* tab cannot receive messages */
    }
  }
}
