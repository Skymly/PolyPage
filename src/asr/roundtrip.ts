/**
 * 转写并翻译 — captured audio window to timed cues with optional 译文.
 * Capture stays in the page. Transcription is not 翻译管线; cue text is.
 */
import { normalizeTranscript } from './engine';
import { toProviderError } from '../providers/provider';
import type { TranslationProvider } from '../providers/provider';
import type { ProviderConfig, Settings } from '../shared/types';
import { buildContext, isProviderConfigured } from '../translation/context';
import type { AsrResponse } from '../messaging/messages';
import { providerSupportsAsr } from '../providers/provider';

export interface AsrRoundTripInput {
  mime: string;
  bytes: Uint8Array;
  windowStart: number;
  windowDuration: number;
  languageHint?: string;
  signal: AbortSignal;
  emitPartials?: boolean;
  onPartial?: (cues: Array<{ start: number; end: number; text: string }>) => void;
}

export interface AsrRoundTripDeps {
  getSettings: (force?: boolean) => Promise<Settings>;
  createProvider: (config: ProviderConfig) => TranslationProvider;
  translateTexts: (texts: string[]) => Promise<string[]>;
  recordStat?: (providerId: string, ok: boolean, latencyMs: number, error?: string) => void;
}

export class AsrRoundTrip {
  constructor(private readonly deps: AsrRoundTripDeps) {}

  async transcribeAndTranslate(input: AsrRoundTripInput): Promise<AsrResponse> {
    const settings = await this.deps.getSettings(true);
    if (!settings.asr.enabled) {
      return { ok: false, kind: 'config', error: '语音转写已在设置中关闭' };
    }
    const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
    if (!provider || !isProviderConfigured(provider)) {
      return { ok: false, kind: 'config', error: '翻译服务未配置或已禁用' };
    }
    let instance: TranslationProvider;
    try {
      instance = this.deps.createProvider(provider);
    } catch (e) {
      return { ok: false, kind: 'config', error: toProviderError(e).message };
    }
    if (!providerSupportsAsr(instance) || typeof instance.transcribe !== 'function') {
      return { ok: false, kind: 'config', error: '当前翻译服务不支持转写' };
    }
    const maxBytes = settings.asr.maxUploadMb * 1024 * 1024;
    if (input.bytes.byteLength > maxBytes) {
      return { ok: false, kind: 'config', error: `音频超过上传上限（${settings.asr.maxUploadMb} MB）` };
    }
    const started = Date.now();
    try {
      const ctx = {
        ...buildContext(settings, provider),
        languageHint:
          input.languageHint && input.languageHint !== 'auto' ? input.languageHint : undefined,
      };
      const streamingFn = instance.transcribeStream;
      let raw: { text: string; segments?: Array<{ start: number; end: number; text: string }> };
      if (input.emitPartials && typeof streamingFn === 'function') {
        raw = await streamingFn.call(
          instance,
          { mime: input.mime, bytes: input.bytes },
          ctx,
          (partial) => {
            const cues = normalizeTranscript(partial, input.windowStart, input.windowDuration);
            input.onPartial?.(cues.map((c) => ({ start: c.start, end: c.end, text: c.text })));
          },
          input.signal,
        );
      } else {
        raw = await instance.transcribe({ mime: input.mime, bytes: input.bytes }, ctx, input.signal);
      }
      const segments = normalizeTranscript(raw, input.windowStart, input.windowDuration);
      this.deps.recordStat?.(provider.id, true, Date.now() - started);
      const translations = await this.translateCueTexts(segments.map((s) => s.text));
      return {
        ok: true,
        cues: segments.map((c, i) => ({
          start: c.start,
          end: c.end,
          text: c.text,
          translation: translations[i] ?? '',
        })),
      };
    } catch (e) {
      const err = toProviderError(e);
      this.deps.recordStat?.(provider.id, false, Date.now() - started, err.message);
      return { ok: false, kind: err.kind, error: err.message };
    }
  }

  private async translateCueTexts(texts: string[]): Promise<string[]> {
    if (texts.length === 0) return [];
    try {
      const out = await this.deps.translateTexts(texts);
      return texts.map((_, i) => out[i] ?? '');
    } catch {
      return texts.map(() => '');
    }
  }
}