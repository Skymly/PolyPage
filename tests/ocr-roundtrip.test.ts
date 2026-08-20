/**
 * OCR 往返: own cache, vision not 翻译管线, tesseract two-step via injected
 * translateTexts, OCR-only when no Provider.
 */
import { describe, expect, it } from 'vitest';
import { defaultProvider, defaultSettings } from '../src/shared/constants';
import type { ProviderConfig, Settings } from '../src/shared/types';
import { MemoryOcrCache, buildOcrCacheKey } from '../src/ocr/resultCache';
import { OcrRoundTrip } from '../src/ocr/roundtrip';
import type { OcrEngine } from '../src/ocr/engine';
import { ProviderError } from '../src/providers/provider';
import type { TranslationProvider } from '../src/providers/provider';

function provider(id = 'a'): ProviderConfig {
  return {
    ...defaultProvider(),
    id,
    name: 'Alpha',
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    sourceLanguage: 'English',
    targetLanguage: '简体中文',
  };
}

function settings(overrides: Partial<Settings> = {}, providers?: ProviderConfig[]): Settings {
  const list = providers ?? [provider()];
  return {
    ...defaultSettings(),
    activeProviderId: list[0]?.id ?? '',
    providers: list,
    cacheEnabled: true,
    imageTranslate: {
      ...defaultSettings().imageTranslate,
      enabled: true,
      engine: 'llm-vision',
    },
    ...overrides,
  };
}

function fakeEngine(
  id: 'llm-vision' | 'tesseract-wasm',
  segments: Array<{ text: string; translation: string }>,
  calls: string[],
): OcrEngine {
  return {
    id,
    recognize: async () => {
      calls.push(id);
      return { engine: id, segments };
    },
  };
}

function make(
  s: Settings,
  extra: Partial<ConstructorParameters<typeof OcrRoundTrip>[0]> & {
    engineSegments?: Array<{ text: string; translation: string }>;
  } = {},
) {
  const cache = extra.cache ?? new MemoryOcrCache();
  const engineCalls: string[] = [];
  const translateCalls: string[][] = [];
  const trip = new OcrRoundTrip({
    getSettings: extra.getSettings ?? (async () => s),
    cache,
    createProvider:
      extra.createProvider ??
      ((c) =>
        ({
          config: c,
          translateTexts: async (texts) => texts.map((t) => `译:${t}`),
          translateImage: async () => '[]',
        }) as TranslationProvider),
    translateTexts:
      extra.translateTexts ??
      (async (texts) => {
        translateCalls.push(texts);
        return texts.map((t) => `译:${t}`);
      }),
    fetchImage:
      extra.fetchImage ??
      (async () => ({ buffer: new Uint8Array([1, 2, 3]).buffer, mime: 'image/png' })),
    prepareDataUrl: extra.prepareDataUrl ?? (async () => 'data:image/png;base64,AA'),
    createEngine:
      extra.createEngine ??
      ((id) =>
        fakeEngine(
          id,
          extra.engineSegments ?? [{ text: 'HELLO', translation: id === 'llm-vision' ? '你好' : '' }],
          engineCalls,
        )),
  });
  return { trip, cache, engineCalls, translateCalls };
}

const input = {
  url: 'https://example.test/a.png',
  signal: new AbortController().signal,
};

describe('OcrRoundTrip', () => {
  it('returns cache hits without calling the engine', async () => {
    const cache = new MemoryOcrCache();
    const key = buildOcrCacheKey({
      providerId: 'a',
      engineId: 'llm-vision',
      sourceLanguage: 'English',
      targetLanguage: '简体中文',
      glossaryVersion: 0,
      identity: 'img|deadbeef',
    });
    await cache.put(key, [{ text: 'CACHED', translation: '缓存' }]);
    const { trip, engineCalls } = make(settings(), {
      cache,
      fetchImage: async () => {
        const bytes = new Uint8Array([9, 9, 9]);
        return { buffer: bytes.buffer, mime: 'image/png' };
      },
    });
    // sha256 of [9,9,9] won't match deadbeef — seed after first miss by putting with real hash is hard.
    // Instead: run once to populate, then again.
    const first = await trip.recognize(input);
    expect(first.ok && first.cached).toBe(false);
    expect(engineCalls.length).toBe(1);
    const second = await trip.recognize(input);
    expect(second.ok && second.cached).toBe(true);
    if (second.ok) expect(second.segments[0].text).toBe('HELLO');
    expect(engineCalls.length).toBe(1);
  });

  it('vision without a Provider fails; tesseract does OCR-only', async () => {
    const vision = make(
      settings({ activeProviderId: '', providers: [], imageTranslate: { ...defaultSettings().imageTranslate, engine: 'llm-vision', enabled: true } }),
    );
    const vis = await vision.trip.recognize(input);
    expect(vis.ok).toBe(false);
    if (!vis.ok) expect(vis.error).toContain('未配置');

    const tessSettings = settings(
      { imageTranslate: { ...defaultSettings().imageTranslate, engine: 'tesseract-wasm', enabled: true } },
      [],
    );
    tessSettings.activeProviderId = '';
    tessSettings.providers = [];
    const tess = make(tessSettings, {
      engineSegments: [{ text: 'ONLY', translation: '' }],
    });
    const rec = await tess.trip.recognize(input);
    expect(rec.ok).toBe(true);
    if (rec.ok) {
      expect(rec.segments[0]).toEqual({ text: 'ONLY', translation: '' });
      expect(tess.translateCalls).toEqual([]);
    }
  });

  it('strips vision think-tags per segment and still succeeds', async () => {
    const { trip, translateCalls } = make(settings(), {
      engineSegments: [
        { text: 'A', translation: '<think>x</think>' },
        { text: 'B', translation: '好' },
      ],
    });
    const res = await trip.recognize(input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.segments[0].translation).toBe('');
      expect(res.segments[1].translation).toBe('好');
    }
    expect(translateCalls).toEqual([]);
  });

  it('tesseract two-step uses translateTexts, vision does not', async () => {
    const tess = make(
      settings({ imageTranslate: { ...defaultSettings().imageTranslate, engine: 'tesseract-wasm', enabled: true } }),
      { engineSegments: [{ text: 'Hello', translation: '' }] },
    );
    const rec = await tess.trip.recognize(input);
    expect(rec.ok).toBe(true);
    expect(tess.translateCalls).toEqual([['Hello']]);
    if (rec.ok) expect(rec.segments[0].translation).toBe('译:Hello');

    const vis = make(settings(), { engineSegments: [{ text: 'X', translation: 'Y' }] });
    await vis.trip.recognize(input);
    expect(vis.translateCalls).toEqual([]);
  });

  it('does not failover vision failures', async () => {
    const { trip } = make(settings(), {
      createEngine: () => ({
        id: 'llm-vision',
        recognize: async () => {
          throw new ProviderError('network', 'vision down');
        },
      }),
    });
    const res = await trip.recognize(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('network');
  });
});