/**
 * Translation pipeline: cache / TM / sanitize / failover / stats / concurrency
 * sit behind one interface. Cue (immediate) and stream share them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultProvider, defaultSettings } from '../src/shared/constants';
import type { ProviderConfig, Settings } from '../src/shared/types';
import type { TranslationProvider } from '../src/providers/provider';
import { ProviderError } from '../src/providers/provider';
import { MemoryTranslationCache } from '../src/storage/cache';
import { MemoryTmStore, TranslationMemory } from '../src/storage/tm';
import { TranslationPipeline } from '../src/translation/pipeline';

function provider(id: string, name: string): ProviderConfig {
  return {
    ...defaultProvider(),
    id,
    name,
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    sourceLanguage: 'English',
    targetLanguage: '简体中文',
    maxBatchItems: 8,
    maxBatchChars: 20000,
  };
}

function settings(overrides: Partial<Settings> = {}, providers?: ProviderConfig[]): Settings {
  const list = providers ?? [provider('a', 'Alpha')];
  return {
    ...defaultSettings(),
    activeProviderId: list[0].id,
    providers: list,
    cacheEnabled: true,
    translationMemory: { enabled: false, maxEntries: 100 },
    failoverChain: [],
    glossary: [],
    glossaryVersion: 0,
    ...overrides,
  };
}

function fake(
  config: ProviderConfig,
  impl: {
    translateTexts?: (texts: string[]) => Promise<string[]>;
    translateStream?: (
      text: string,
      onDelta: (d: string) => void,
      signal: AbortSignal,
    ) => Promise<string>;
  } = {},
): TranslationProvider {
  const providerImpl: TranslationProvider = {
    config,
    translateTexts:
      impl.translateTexts ??
      (async (texts, _ctx, _signal) => texts.map((t) => `译:${t}`)),
  };
  if (impl.translateStream) {
    providerImpl.translateStream = async (text, _ctx, onDelta, signal) =>
      impl.translateStream!(text, onDelta, signal);
  }
  return providerImpl;
}

function makePipeline(
  s: Settings,
  factories: Record<string, (c: ProviderConfig) => TranslationProvider>,
  extra: Partial<ConstructorParameters<typeof TranslationPipeline>[0]> = {},
): TranslationPipeline {
  const cache = extra.cache ?? new MemoryTranslationCache();
  const tm = extra.tm ?? new TranslationMemory(new MemoryTmStore(), 100);
  return new TranslationPipeline({
    getSettings: extra.getSettings ?? (async () => s),
    cache,
    tm,
    createProvider:
      extra.createProvider ??
      ((c) => {
        const f = factories[c.id];
        if (!f) throw new ProviderError('config', `no factory ${c.id}`);
        return f(c);
      }),
    recordStat: extra.recordStat,
    logError: extra.logError,
    onTmHit: extra.onTmHit,
    recordInflight: extra.recordInflight,
    completeTasks: extra.completeTasks,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TranslationPipeline', () => {
  it('returns cache hits without calling the Provider', async () => {
    const cache = new MemoryTranslationCache();
    await cache.put([{ text: 'Hello', translated: '你好' }], 'a', 'English', '简体中文', 0);
    const calls: string[][] = [];
    const pipeline = makePipeline(settings(), {
      a: (c) =>
        fake(c, {
          translateTexts: async (texts) => {
            calls.push(texts);
            return texts.map((t) => `译:${t}`);
          },
        }),
    }, { cache });
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('你好');
    expect(calls).toEqual([]);
  });

  it('TM hit skips the Provider and counts onTmHit', async () => {
    const tm = new TranslationMemory(new MemoryTmStore(), 100);
    await tm.remember([{ source: 'Hello, world!', target: '你好，世界' }], 'English|简体中文');
    let hits = 0;
    const calls: string[][] = [];
    const pipeline = makePipeline(
      settings({ translationMemory: { enabled: true, maxEntries: 100 } }),
      {
        a: (c) =>
          fake(c, {
            translateTexts: async (texts) => {
              calls.push(texts);
              return texts.map((t) => `译:${t}`);
            },
          }),
      },
      { tm, onTmHit: () => hits++ },
    );
    const res = await pipeline.translate([{ text: 'Hello, world!', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('你好，世界');
    expect(hits).toBe(1);
    expect(calls).toEqual([]);
  });

  it('sanitize-empty is invalid_response and is not written to cache', async () => {
    const cache = new MemoryTranslationCache();
    const pipeline = makePipeline(settings(), {
      a: (c) => fake(c, { translateTexts: async () => ['<think>x</think>'] }),
    }, { cache });
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.errors.k1?.kind).toBe('invalid_response');
    const hits = await cache.get([{ key: 'k1', text: 'Hello' }], 'a', 'English', '简体中文', 0);
    expect(hits.size).toBe(0);
  });

  it('failover on network, not on invalid_response', async () => {
    const a = provider('a', 'Alpha');
    const b = provider('b', 'Beta');
    const s = settings({ failoverChain: ['b'] }, [a, b]);
    const pipeline = makePipeline(s, {
      a: (c) =>
        fake(c, {
          translateTexts: async () => {
            throw new ProviderError('network', 'down');
          },
        }),
      b: (c) => fake(c, { translateTexts: async (texts) => texts.map((t) => `B:${t}`) }),
    });
    const ok = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(ok.results.k1).toBe('B:Hello');
    expect(ok.actualProviderName).toBe('Beta');

    const pipeline2 = makePipeline(s, {
      a: (c) => fake(c, { translateTexts: async () => ['<think></think>'] }),
      b: (c) => fake(c, { translateTexts: async () => ['不该走到'] }),
    });
    const bad = await pipeline2.translate([{ text: 'Hello', key: 'k2' }], { immediate: true });
    expect(bad.errors.k2?.kind).toBe('invalid_response');
    expect(bad.actualProviderName).toBeUndefined();
  });

  it('immediate (cue) still failovers', async () => {
    const a = provider('a', 'Alpha');
    const b = provider('b', 'Beta');
    const pipeline = makePipeline(settings({ failoverChain: ['b'] }, [a, b]), {
      a: (c) =>
        fake(c, {
          translateTexts: async () => {
            throw new ProviderError('timeout', 'slow');
          },
        }),
      b: (c) => fake(c, { translateTexts: async () => ['字幕译文'] }),
    });
    const res = await pipeline.translate([{ text: 'cue text' }], { immediate: true });
    const values = Object.values(res.results);
    expect(values).toEqual(['字幕译文']);
    expect(res.actualProviderName).toBe('Beta');
  });

  it('stream cache-hits without calling translateStream', async () => {
    const cache = new MemoryTranslationCache();
    await cache.put([{ text: 'Hello', translated: '你好' }], 'a', 'English', '简体中文', 0);
    let streamed = 0;
    const deltas: string[] = [];
    const pipeline = makePipeline(settings(), {
      a: (c) =>
        fake(c, {
          translateStream: async () => {
            streamed += 1;
            return 'nope';
          },
        }),
    }, { cache });
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], {
      immediate: true,
      onDelta: (_key, d) => deltas.push(d),
    });
    expect(res.results.k1).toBe('你好');
    expect(streamed).toBe(0);
    expect(deltas).toEqual([]);
  });

  it('stream failover does not stitch deltas across Providers', async () => {
    const a = provider('a', 'Alpha');
    const b = provider('b', 'Beta');
    const deltas: string[] = [];
    const pipeline = makePipeline(settings({ failoverChain: ['b'] }, [a, b]), {
      a: (c) =>
        fake(c, {
          translateStream: async (_text, onDelta) => {
            onDelta('半');
            throw new ProviderError('network', 'cut');
          },
        }),
      b: (c) =>
        fake(c, {
          translateStream: async (_text, onDelta) => {
            onDelta('不该出现');
            return '完整译文';
          },
        }),
    });
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], {
      immediate: true,
      onDelta: (_key, d) => deltas.push(d),
    });
    expect(res.results.k1).toBe('完整译文');
    expect(deltas).toEqual(['半']);
    expect(res.actualProviderName).toBe('Beta');
  });

  it('stream sanitize-empty does not failover', async () => {
    const a = provider('a', 'Alpha');
    const b = provider('b', 'Beta');
    const pipeline = makePipeline(settings({ failoverChain: ['b'] }, [a, b]), {
      a: (c) => fake(c, { translateStream: async () => '<think>zzz</think>' }),
      b: (c) => fake(c, { translateStream: async () => '不该走到' }),
    });
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], {
      immediate: true,
      onDelta: () => undefined,
    });
    expect(res.errors.k1?.kind).toBe('invalid_response');
  });

  it('does not record inflight for stream or keyless cue', async () => {
    const inflight: Array<{ key: string; text: string }[]> = [];
    const pipeline = makePipeline(settings(), {
      a: (c) => fake(c),
    }, {
      recordInflight: (_tab, _frame, items) => {
        inflight.push(items);
      },
    });
    await pipeline.translate([{ text: 'cue only' }], { immediate: true });
    await pipeline.translate([{ text: 'stream', key: 'node-1' }], {
      immediate: true,
      onDelta: () => undefined,
    });
    await pipeline.translate([{ text: 'page', key: 'node-2', tabId: 1 }], { immediate: true });
    expect(inflight).toEqual([[{ key: 'node-2', text: 'page' }]]);
  });

  it('caps concurrent Provider calls at 2', async () => {
    let current = 0;
    let max = 0;
    const gate: Array<() => void> = [];
    const pipeline = makePipeline(settings(), {
      a: (c) =>
        fake(c, {
          translateStream: async () => {
            current += 1;
            max = Math.max(max, current);
            await new Promise<void>((r) => gate.push(r));
            current -= 1;
            return 'x';
          },
        }),
    });
    const pending = pipeline.translate(
      [
        { text: 'one', key: '1' },
        { text: 'two', key: '2' },
        { text: 'three', key: '3' },
      ],
      { immediate: true, onDelta: () => undefined },
    );
    await vi.waitFor(() => expect(gate.length).toBe(2));
    expect(max).toBe(2);
    gate.splice(0).forEach((r) => r());
    await vi.waitFor(() => expect(gate.length).toBe(1));
    gate.splice(0).forEach((r) => r());
    await pending;
    expect(max).toBe(2);
  });
});