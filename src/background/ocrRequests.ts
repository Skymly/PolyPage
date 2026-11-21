import type { OcrResponse } from '../messaging/messages';
import {
  IdbOcrPackStore,
  OcrPackManager,
  knownPackId,
  resolveTessLangs,
  seedTesseractLangCache,
  ocrMissingPackMessage,
} from '../ocr/packs';
import { ChromeOcrCache } from '../ocr/resultCache';
import { OcrRoundTrip } from '../ocr/roundtrip';
import { createProvider } from '../providers/provider';
import { ocrRequestAllowed } from '../shared/imageAccess';
import { logError, recordStat } from './diagnostics';
import { broadcastSettingsChanged, getSettings, persistSettings } from './settingsState';
import { translateMediaTexts } from './translationRequests';

const ocrPacks = new OcrPackManager(new IdbOcrPackStore());
const ocrControllers = new Map<string, AbortController>();

const ocrRoundTrip = new OcrRoundTrip({
  getSettings,
  cache: new ChromeOcrCache(),
  createProvider,
  translateTexts: (texts) => translateMediaTexts(texts, 'ocr'),
  prepareTesseractLangs: async (tessLangs, extraLangs) => {
    const ready = await ocrPacks.readyIds();
    const resolved = await resolveTessLangs(tessLangs, extraLangs, ready);
    const skipped = ocrMissingPackMessage(resolved.missing);
    if (skipped) await logError('ocr', 'config', skipped);
    for (const id of resolved.langs) {
      const pack = await ocrPacks.getReady(id);
      if (pack) await seedTesseractLangCache(id, pack.data);
    }
    return resolved.langs;
  },
  recordStat,
  logError,
});

export async function handleOcrRequest(
  requestId: string,
  url: string,
  naturalWidth: number | undefined,
  naturalHeight: number | undefined,
  cacheIdentity: string | undefined,
  sender: chrome.runtime.MessageSender,
  userGesture: boolean,
): Promise<OcrResponse> {
  if (
    !ocrRequestAllowed({
      imageUrl: url,
      tabUrl: sender.tab?.url,
      senderUrl: sender.url,
      userGesture,
    })
  ) {
    return { ok: false, kind: 'config', error: '图片地址与当前页面不同源，已拒绝抓取' };
  }
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

export function cancelOcr(requestId: string): void {
  ocrControllers.get(requestId)?.abort();
}

export async function downloadOcrPack(lang: string): Promise<{ ok: boolean; error?: string }> {
  if (!knownPackId(lang)) {
    return { ok: false, error: '未列出的语言包' };
  }
  await ocrPacks.download(lang);
  const s = await getSettings(true);
  if (!s.ocrPacks.extraLangs.includes(lang)) {
    s.ocrPacks = { extraLangs: [...s.ocrPacks.extraLangs, lang] };
    s.imageTranslate = {
      ...s.imageTranslate,
      tessLangs: [...new Set([...s.imageTranslate.tessLangs, lang])],
    };
    await persistSettings(s);
    void broadcastSettingsChanged();
  }
  return { ok: true };
}

export async function removeOcrPack(lang: string): Promise<void> {
  await ocrPacks.remove(lang);
  const s = await getSettings(true);
  s.ocrPacks = { extraLangs: s.ocrPacks.extraLangs.filter((id) => id !== lang) };
  s.imageTranslate = {
    ...s.imageTranslate,
    tessLangs: s.imageTranslate.tessLangs.filter((id) => id !== lang),
  };
  await persistSettings(s);
  void broadcastSettingsChanged();
}

export function ocrPackStatus() {
  return ocrPacks.status();
}
