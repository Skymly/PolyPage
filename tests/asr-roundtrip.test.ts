/**
 * 转写并翻译: transcribe then 翻译管线; partials are source-only.
 */
import { describe, expect, it } from 'vitest';
import { defaultProvider, defaultSettings } from '../src/shared/constants';
import type { ProviderConfig, Settings } from '../src/shared/types';
import { ProviderError } from '../src/providers/provider';
import type { TranslationProvider } from '../src/providers/provider';
import { AsrRoundTrip } from '../src/asr/roundtrip';

function provider(): ProviderConfig {
  return {
    ...defaultProvider(),
    id: 'a',
    name: 'Alpha',
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    sourceLanguage: 'English',
    targetLanguage: '简体中文',
  };
}

function settings(): Settings {
  const p = provider();
  return {
    ...defaultSettings(),
    activeProviderId: p.id,
    providers: [p],
    asr: { ...defaultSettings().asr, enabled: true, streaming: true, maxUploadMb: 8 },
  };
}

const input = {
  mime: 'audio/webm',
  bytes: new Uint8Array([1, 2, 3]),
  windowStart: 0,
  windowDuration: 10,
  signal: new AbortController().signal,
};

describe('AsrRoundTrip', () => {
  it('transcribes then translates cue texts', async () => {
    const translated: string[][] = [];
    const trip = new AsrRoundTrip({
      getSettings: async () => settings(),
      createProvider: (c) =>
        ({
          config: c,
          translateTexts: async (texts) => texts,
          transcribe: async () => ({ text: 'Hello world.', segments: [{ start: 0, end: 2, text: 'Hello world.' }] }),
        }) as TranslationProvider,
      translateTexts: async (texts) => {
        translated.push(texts);
        return texts.map((t) => `译:${t}`);
      },
    });
    const res = await trip.transcribeAndTranslate(input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.cues).toEqual([{ start: 0, end: 2, text: 'Hello world.', translation: '译:Hello world.' }]);
    }
    expect(translated).toEqual([['Hello world.']]);
  });

  it('keeps source cues when translation throws', async () => {
    const trip = new AsrRoundTrip({
      getSettings: async () => settings(),
      createProvider: (c) =>
        ({
          config: c,
          translateTexts: async (texts) => texts,
          transcribe: async () => ({ text: 'Hi.', segments: [{ start: 0, end: 1, text: 'Hi.' }] }),
        }) as TranslationProvider,
      translateTexts: async () => {
        throw new Error('pipeline down');
      },
    });
    const res = await trip.transcribeAndTranslate(input);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cues[0]).toMatchObject({ text: 'Hi.', translation: '' });
  });

  it('does not failover a transcribe network error', async () => {
    const trip = new AsrRoundTrip({
      getSettings: async () => settings(),
      createProvider: (c) =>
        ({
          config: c,
          translateTexts: async (texts) => texts,
          transcribe: async () => {
            throw new ProviderError('network', 'asr down');
          },
        }) as TranslationProvider,
      translateTexts: async () => ['nope'],
    });
    const res = await trip.transcribeAndTranslate(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('network');
  });

  it('emits source-only partials', async () => {
    const partials: Array<{ text: string }>[] = [];
    const trip = new AsrRoundTrip({
      getSettings: async () => settings(),
      createProvider: (c) =>
        ({
          config: c,
          translateTexts: async (texts) => texts,
          transcribe: async () => ({ text: 'Final.', segments: [{ start: 0, end: 3, text: 'Final.' }] }),
          transcribeStream: async (_input, _ctx, onPartial) => {
            onPartial({ text: 'Hel', segments: [{ start: 0, end: 1, text: 'Hel' }] });
            return { text: 'Final.', segments: [{ start: 0, end: 3, text: 'Final.' }] };
          },
        }) as TranslationProvider,
      translateTexts: async (texts) => texts.map((t) => `译:${t}`),
    });
    const res = await trip.transcribeAndTranslate({
      ...input,
      emitPartials: true,
      onPartial: (cues) => partials.push(cues),
    });
    expect(partials[0][0]).toEqual({ start: 0, end: 1, text: 'Hel' });
    expect(res.ok && res.cues[0].translation).toBe('译:Final.');
  });
});