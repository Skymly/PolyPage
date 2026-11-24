import { kindedFailure, STREAM_PORT_NAME } from '../messaging/messages';
import type { StreamPortInit, StreamPortMessage } from '../messaging/messages';
import { createProvider, toProviderError } from '../providers/provider';
import { renderGlossary } from '../shared/siteRules';
import type { ErrorKind, ProviderConfig, TranslateResults, TranslationItem } from '../shared/types';
import { ChromeTranslationCache } from '../storage/cache';
import { normalizeSettings } from '../storage/settings';
import { IdbTmStore, TranslationMemory } from '../storage/tm';
import { effectiveLanguages } from '../translation/context';
import { TranslationPipeline } from '../translation/pipeline';
import { logError, recordStat } from './diagnostics';
import { getSettings } from './settingsState';
import { completeTasks, recordInflight } from './tabState';

const translationMemory = new TranslationMemory(new IdbTmStore());
let tmSessionHits = 0;

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
  recordInflight,
  completeTasks,
});

export async function handleTranslate(
  items: TranslationItem[],
  domain?: string,
  tabId?: number,
  frameId?: number,
  pageLanguage?: string | null,
): Promise<TranslateResults> {
  return pipeline.translate(
    items.map((item) => ({
      text: item.text,
      cacheScope: item.cacheScope,
      documentContext: item.documentContext,
      key: item.key,
      domain,
      tabId,
      frameId,
      pageLanguage,
    })),
  );
}

export async function handleTranslateCue(
  text: string,
  domain?: string,
  tabId?: number,
): Promise<{ translated?: string; error?: string; kind?: ErrorKind }> {
  const res = await pipeline.translate([{ text, domain, tabId }], { immediate: true });
  const translated = Object.values(res.results)[0];
  if (translated !== undefined) return { translated };
  const err = Object.values(res.errors)[0];
  return { error: err?.message ?? '翻译失败', kind: err?.kind ?? 'unknown' };
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
    init.items.map((item) => ({
      text: item.text,
      key: item.key,
      cacheScope: item.cacheScope,
      documentContext: item.documentContext,
      domain: init.domain,
      pageLanguage: init.pageLanguage,
    })),
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

export function translateDraft(texts: string[], domain?: string, tabId?: number, frameId?: number): Promise<TranslateResults> {
  return pipeline.translate(
    texts.map((text, index) => ({ text, key: String(index), draft: true, domain, tabId, frameId })),
    { immediate: texts.length === 1 },
  );
}

export async function translateSelection(text: string, domain?: string, tabId?: number, frameId?: number) {
  const settings = await getSettings();
  const outcome = await pipeline.translate([{ text, domain, tabId, frameId, key: 'selection' }]);
  const translated = outcome.results.selection;
  if (translated === undefined) {
    return kindedFailure(
      outcome.errors.selection?.kind ?? 'unknown',
      outcome.errors.selection?.message ?? '翻译失败',
    );
  }
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  const language = provider ? effectiveLanguages(settings, provider).target : settings.defaultTargetLanguage;
  return { ok: true, translated, language };
}

export function cancelTranslations(tabId: number): void {
  pipeline.cancelTab(tabId);
}

export async function translateMediaTexts(
  texts: string[],
  keyPrefix: 'ocr' | 'asr',
): Promise<string[]> {
  const items = texts.map((text, i) => ({ text, key: `${keyPrefix}-${i}` }));
  const res = await pipeline.translate(items, { immediate: true });
  return items.map(({ key }) => res.results[key] ?? '');
}

export async function clearTranslationMemory(): Promise<void> {
  await translationMemory.clear();
  tmSessionHits = 0;
}

export async function translationMemoryStats() {
  const stats = await translationMemory.stats();
  const settings = await getSettings();
  return {
    entries: stats.entries,
    hits: stats.hits,
    sessionHits: tmSessionHits,
    enabled: settings.translationMemory.enabled,
  };
}

export async function handleTestProvider(raw: ProviderConfig): Promise<{ ok: boolean; result?: string; latencyMs?: number; error?: string }> {
  const provider = normalizeSettings({ providers: [raw], activeProviderId: raw.id }).providers[0];
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

export function registerTranslationPort(): void {
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
}
