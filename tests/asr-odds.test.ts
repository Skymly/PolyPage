/**
 * ASR odds and ends (M-88): ended media, full-confirm cap, cue-fetch epoch.
 */
import { describe, expect, it } from 'vitest';
import {
  ASR_FULL_CONFIRM_CAP_SECONDS,
  resolveCaptureDuration,
  shouldCommitCueFetch,
} from '../src/content/media';
import { AsrRoundTrip } from '../src/asr/roundtrip';
import { defaultProvider, defaultSettings } from '../src/shared/constants';
import type { ProviderConfig, Settings } from '../src/shared/types';
import type { TranslationProvider } from '../src/providers/provider';

describe('resolveCaptureDuration (M-88)', () => {
  it('does not record a full maxSeconds window when the media has ended', () => {
    const resolved = resolveCaptureDuration({
      mediaDuration: 90,
      currentTime: 90,
      maxSeconds: 90,
      confirmFull: true,
      confirmFullNow: () => true,
    });
    expect(resolved.ended).toBe(true);
    expect(resolved.duration).toBe(0);
  });

  it('caps a confirmed full-file capture', () => {
    const resolved = resolveCaptureDuration({
      mediaDuration: 10_000,
      currentTime: 0,
      maxSeconds: 90,
      confirmFull: true,
      confirmFullNow: () => true,
    });
    expect(resolved.duration).toBe(ASR_FULL_CONFIRM_CAP_SECONDS);
    expect(ASR_FULL_CONFIRM_CAP_SECONDS).toBe(30 * 60);
  });

  it('keeps the default window when the user declines full confirm', () => {
    const resolved = resolveCaptureDuration({
      mediaDuration: 400,
      currentTime: 0,
      maxSeconds: 90,
      confirmFull: true,
      confirmFullNow: () => false,
    });
    expect(resolved.duration).toBe(90);
  });
});

describe('shouldCommitCueFetch (M-88)', () => {
  it('drops a late translation after restore', () => {
    expect(shouldCommitCueFetch(1, 2, false)).toBe(false);
    expect(shouldCommitCueFetch(3, 3, true)).toBe(true);
  });
});

describe('translateCueTexts failure (M-88)', () => {
  function settings(): Settings {
    const p: ProviderConfig = {
      ...defaultProvider(),
      id: 'a',
      name: 'Alpha',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      sourceLanguage: 'English',
      targetLanguage: '简体中文',
    };
    return {
      ...defaultSettings(),
      activeProviderId: p.id,
      providers: [p],
      asr: { ...defaultSettings().asr, enabled: true, maxUploadMb: 8 },
    };
  }

  it('keeps source cues without empty-string translations when translate throws', async () => {
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
    const res = await trip.transcribeAndTranslate({
      mime: 'audio/webm',
      bytes: new Uint8Array([1]),
      windowStart: 0,
      windowDuration: 10,
      signal: new AbortController().signal,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.cues[0].text).toBe('Hi.');
      expect(res.cues[0].translation).toBeUndefined();
    }
  });
});
