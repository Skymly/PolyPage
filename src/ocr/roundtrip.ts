/**
 * OCR 往返 — one module from image URL to ordered segments.
 *
 * Vision one-step is not 翻译管线 and does not failover. Tesseract two-step
 * sends recognized sentences through an injected translateTexts function.
 */
import { engineNeedsVisionProvider } from './engine';
import type { OcrEngine } from './engine';
import { LlmVisionEngine } from './llm-vision';
import { TesseractEngine } from './tesseract';
import { buildOcrCacheKey } from './resultCache';
import type { OcrResultCache } from './resultCache';
import { defaultFetchImage, defaultPrepareDataUrl, sha256Hex } from './imagePrep';
import { sanitizeOptionsFromSettings, sanitizeTranslation } from '../shared/sanitize';
import type { ErrorKind, OcrEngineId, OcrSegment, ProviderConfig, Settings } from '../shared/types';
import { providerSupportsVision, toProviderError } from '../providers/provider';
import type { TranslationContext, TranslationProvider } from '../providers/provider';
import { buildContext, effectiveLanguages, isProviderConfigured } from '../translation/context';
import type { OcrResponse } from '../messaging/messages';

export interface OcrRecognizeInput {
  url: string;
  naturalWidth?: number;
  naturalHeight?: number;
  cacheIdentity?: string;
  signal: AbortSignal;
}

export interface OcrRoundTripDeps {
  getSettings: (force?: boolean) => Promise<Settings>;
  cache: OcrResultCache;
  createProvider: (config: ProviderConfig) => TranslationProvider;
  /** Tesseract two-step only. Production wraps 翻译管线 with immediate: true. */
  translateTexts: (texts: string[]) => Promise<string[]>;
  fetchImage?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<{ buffer: ArrayBuffer; mime: string }>;
  prepareDataUrl?: (buffer: ArrayBuffer, mime: string, maxEdgePx: number) => Promise<string>;
  createEngine?: (
    engineId: OcrEngineId,
    langs: string[],
    provider: TranslationProvider | undefined,
  ) => OcrEngine;
  prepareTesseractLangs?: (tessLangs: string[], extraLangs: string[]) => Promise<string[]>;
  recordStat?: (providerId: string, ok: boolean, latencyMs: number, error?: string) => void;
  logError?: (where: string, kind: ErrorKind, message: string, providerId?: string) => Promise<void> | void;
}

function sanitizeSegmentTranslation(text: string, settings: Settings): string {
  const result = sanitizeTranslation(text, sanitizeOptionsFromSettings(settings));
  return result.ok ? result.text : '';
}

export class OcrRoundTrip {
  constructor(private readonly deps: OcrRoundTripDeps) {}

  async recognize(input: OcrRecognizeInput): Promise<OcrResponse> {
    const settings = await this.deps.getSettings(true);
    if (!settings.imageTranslate.enabled) {
      return { ok: false, kind: 'config', error: '图片翻译已在设置中关闭' };
    }
    const engineId = settings.imageTranslate.engine;
    const needsVision = engineNeedsVisionProvider(engineId);
    const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
    const providerReady = !!provider && isProviderConfigured(provider);

    if (needsVision && !providerReady) {
      return { ok: false, kind: 'config', error: '翻译服务未配置或已禁用' };
    }

    let instance: TranslationProvider | undefined;
    if (providerReady && provider) {
      try {
        instance = this.deps.createProvider(provider);
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

    const started = Date.now();
    try {
      const fetchImage = this.deps.fetchImage ?? defaultFetchImage;
      const { buffer, mime } = await fetchImage(input.url, input.signal);
      const contentHash = await sha256Hex(buffer);
      const identity = contentHash
        ? `img|${contentHash}`
        : `imgurl|${input.url}|${input.naturalWidth ?? 0}x${input.naturalHeight ?? 0}`;
      const cacheIdentity = input.cacheIdentity ?? identity;
      const { source, target } = provider
        ? effectiveLanguages(settings, provider)
        : { source: settings.defaultSourceLanguage, target: settings.defaultTargetLanguage };

      if (settings.cacheEnabled && provider) {
        try {
          const key = buildOcrCacheKey({
            providerId: provider.id,
            engineId,
            sourceLanguage: source,
            targetLanguage: target,
            glossaryVersion: settings.glossaryVersion,
            identity: cacheIdentity,
          });
          const cached = await this.deps.cache.get(key);
          if (cached) {
            return { ok: true, segments: cached, cached: true, engine: engineId };
          }
        } catch {
          /* fall through */
        }
      }

      const prepare = this.deps.prepareDataUrl ?? defaultPrepareDataUrl;
      const dataUrl = await prepare(buffer, mime, settings.imageTranslate.maxEdgePx);
      const ctx: TranslationContext = provider
        ? buildContext(settings, provider)
        : {
            sourceLanguage: settings.defaultSourceLanguage,
            targetLanguage: settings.defaultTargetLanguage,
            glossary: '',
          };

      let tessLangs = settings.imageTranslate.tessLangs;
      if (engineId === 'tesseract-wasm' && this.deps.prepareTesseractLangs) {
        try {
          tessLangs = await this.deps.prepareTesseractLangs(
            settings.imageTranslate.tessLangs,
            settings.ocrPacks.extraLangs,
          );
        } catch {
          tessLangs = settings.imageTranslate.tessLangs;
        }
      }

      const engine = (this.deps.createEngine ?? defaultCreateEngine)(engineId, tessLangs, instance);
      const result = await engine.recognize({ dataUrl }, ctx, input.signal);
      let segments: OcrSegment[] = result.segments.map((seg) => ({
        ...seg,
        translation: sanitizeSegmentTranslation(seg.translation || '', settings),
      }));

      if (engine.id === 'tesseract-wasm' && instance && provider) {
        const texts = segments.map((s) => s.text);
        if (texts.length > 0) {
          const translated = await this.deps.translateTexts(texts);
          segments = segments.map((s, i) => ({
            ...s,
            translation: translated[i] ?? '',
          }));
        }
      }

      if (provider) {
        this.deps.recordStat?.(provider.id, true, Date.now() - started);
      }

      if (settings.cacheEnabled && provider) {
        try {
          const key = buildOcrCacheKey({
            providerId: provider.id,
            engineId: result.engine,
            sourceLanguage: source,
            targetLanguage: target,
            glossaryVersion: settings.glossaryVersion,
            identity: cacheIdentity,
          });
          await this.deps.cache.put(key, segments);
        } catch {
          /* cache best-effort */
        }
      }
      return { ok: true, segments, cached: false, engine: result.engine };
    } catch (e) {
      const err = toProviderError(e);
      if (provider) {
        this.deps.recordStat?.(provider.id, false, Date.now() - started, err.message);
      }
      await this.deps.logError?.('ocr', err.kind, `图片翻译失败: ${err.message}`, provider?.id);
      return { ok: false, kind: err.kind, error: err.message };
    }
  }
}

function defaultCreateEngine(
  engineId: OcrEngineId,
  langs: string[],
  provider: TranslationProvider | undefined,
): OcrEngine {
  if (engineId === 'tesseract-wasm') return new TesseractEngine(undefined, langs);
  return new LlmVisionEngine(provider!);
}