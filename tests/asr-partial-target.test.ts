/**
 * ASR partials stay on the pinned capture target and do not clobber 译文 (M-50).
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { AsrRoundTrip } from '../src/asr/roundtrip';
import { SubtitleManager } from '../src/content/media';
import { mergeMemoryCues } from '../src/content/subtitleScheduler';
import { defaultProvider, defaultSettings } from '../src/shared/constants';
import type { ProviderConfig, Settings } from '../src/shared/types';
import type { TranslationProvider } from '../src/providers/provider';

describe('mergeMemoryCues (M-50)', () => {
  it('keeps an existing translation when a late source-only partial arrives', () => {
    const merged = mergeMemoryCues(
      [{ startTime: 0, endTime: 2, text: 'Hello', translation: '你好' }],
      [{ startTime: 0, endTime: 2, text: 'Hello' }],
    );
    expect(merged).toEqual([{ startTime: 0, endTime: 2, text: 'Hello', translation: '你好' }]);
  });

  it('lets an incoming translation replace a source-only cue', () => {
    const merged = mergeMemoryCues(
      [{ startTime: 0, endTime: 2, text: 'Hello' }],
      [{ startTime: 0, endTime: 2, text: 'Hello', translation: '你好' }],
    );
    expect(merged[0].translation).toBe('你好');
  });
});

describe('SubtitleManager ASR pin (M-50)', () => {
  it('applies partials to the pinned media, not the hovered one', () => {
    document.body.innerHTML = '<video id="a"></video><video id="b"></video>';
    const a = document.getElementById('a') as HTMLVideoElement;
    const b = document.getElementById('b') as HTMLVideoElement;
    const manager = new SubtitleManager();
    manager.pinAsrTarget(b);
    a.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    expect(manager.pickCaptionlessMedia()).toBe(a);
    expect(manager.asrTargetMedia()).toBe(b);
    manager.applyAsrPartial([{ startTime: 0, endTime: 2, text: 'hi' }]);
    expect(manager.memoryCueCount(b)).toBe(1);
    expect(manager.memoryCueCount(a)).toBe(0);
  });

  it('does not let a late partial wipe a translated memory cue', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const video = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 1 });
    const manager = new SubtitleManager();
    manager.pinAsrTarget(video);
    manager.applyMemoryCues(video, [
      { startTime: 0, endTime: 2, text: 'Hello', translation: '你好' },
    ]);
    manager.applyAsrPartial([{ startTime: 0, endTime: 2, text: 'Hello' }]);
    expect(manager.memoryCuesOf(video)[0]?.translation).toBe('你好');
  });
});

describe('AsrRoundTrip waits for onPartial (M-50)', () => {
  function provider(): ProviderConfig {
    return {
      ...defaultProvider(),
      id: 'a',
      name: 'Alpha',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      sourceLanguage: 'English',
      targetLanguage: '简体中文',
      supportsAsr: true,
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

  it('does not return the final cues until the last onPartial promise settles', async () => {
    let partialSettled = false;
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
      mime: 'audio/webm',
      bytes: new Uint8Array([1]),
      windowStart: 0,
      windowDuration: 10,
      signal: new AbortController().signal,
      emitPartials: true,
      onPartial: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            partialSettled = true;
            resolve();
          }, 15);
        }),
    });
    expect(partialSettled).toBe(true);
    expect(res.ok).toBe(true);
  });
});
