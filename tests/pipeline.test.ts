/**
 * Translation pipeline: cache / TM / sanitize / failover / stats / concurrency
 * sit behind one interface. Cue (immediate) and stream share them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BATCH_WINDOW_MS, defaultProvider, defaultSettings } from '../src/shared/constants';
import type { ProviderConfig, Settings } from '../src/shared/types';
import type { TranslationProvider } from '../src/providers/provider';
import { ProviderError } from '../src/providers/provider';
import { MemoryTranslationCache, cacheFingerprint } from '../src/storage/cache';
import { MemoryTmStore, TranslationMemory } from '../src/storage/tm';
import { TranslationPipeline } from '../src/translation/pipeline';
import { buildContext } from '../src/translation/context';

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
    translateTexts?: (
      texts: string[],
      ctx?: unknown,
      signal?: AbortSignal,
    ) => Promise<string[]>;
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

function seed(cache: MemoryTranslationCache, s: Settings, text: string, translated: string): Promise<void> {
  const p = s.providers[0];
  const ctx = buildContext(s, p);
  return cache.put(
    [{ text, translated }],
    p.id,
    ctx.sourceLanguage,
    ctx.targetLanguage,
    s.glossaryVersion,
    cacheFingerprint(p),
  );
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
    const s = settings();
    await seed(cache, s, 'Hello', '你好');
    const calls: string[][] = [];
    const pipeline = makePipeline(s, {
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
    const hits = await cache.get(
      [{ key: 'k1', text: 'Hello' }],
      'a',
      'English',
      '简体中文',
      0,
      cacheFingerprint(settings().providers[0]),
    );
    expect(hits.size).toBe(0);
  });

  it('does not persist cache when outputSanitize is disabled (M-79)', async () => {
    const cache = new MemoryTranslationCache();
    const s = settings({
      outputSanitize: { enabled: false, stripThink: true, stripCodeFences: false },
    });
    const pipeline = makePipeline(
      s,
      {
        a: (c) => fake(c, { translateTexts: async () => ['<think>raw</think>hello'] }),
      },
      { cache },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('<think>raw</think>hello');
    const hits = await cache.get(
      [{ key: 'k1', text: 'Hello' }],
      'a',
      'English',
      '简体中文',
      0,
      cacheFingerprint(s.providers[0]),
    );
    expect(hits.size).toBe(0);
  });

  it('does not persist cache when outputSanitize is disabled (M-79)', async () => {
    const cache = new MemoryTranslationCache();
    const s = settings({
      outputSanitize: { enabled: false, stripThink: true, stripCodeFences: false },
    });
    const pipeline = makePipeline(
      s,
      {
        a: (c) => fake(c, { translateTexts: async () => ['<think>raw</think>hello'] }),
      },
      { cache },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('<think>raw</think>hello');
    const hits = await cache.get(
      [{ key: 'k1', text: 'Hello' }],
      'a',
      'English',
      '简体中文',
      0,
      cacheFingerprint(s.providers[0]),
    );
    expect(hits.size).toBe(0);
  });

  it('does not persist cache when outputSanitize is disabled (M-79)', async () => {
    const cache = new MemoryTranslationCache();
    const s = settings({
      outputSanitize: { enabled: false, stripThink: true, stripCodeFences: false },
    });
    const pipeline = makePipeline(
      s,
      {
        a: (c) => fake(c, { translateTexts: async () => ['<think>raw</think>hello'] }),
      },
      { cache },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('<think>raw</think>hello');
    const hits = await cache.get(
      [{ key: 'k1', text: 'Hello' }],
      'a',
      'English',
      '简体中文',
      0,
      cacheFingerprint(s.providers[0]),
    );
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

  it('cancelTab does not failover even if the provider reports timeout (M-05)', async () => {
    const a = provider('a', 'Alpha');
    const b = provider('b', 'Beta');
    let pipeline!: TranslationPipeline;
    let betaCalls = 0;
    pipeline = makePipeline(settings({ failoverChain: ['b'] }, [a, b]), {
      a: (c) =>
        fake(c, {
          translateTexts: async () => {
            pipeline.cancelTab(7);
            throw new ProviderError('timeout', '请求已取消');
          },
        }),
      b: (c) =>
        fake(c, {
          translateTexts: async (texts) => {
            betaCalls += 1;
            return texts.map((t) => `B:${t}`);
          },
        }),
    });
    const res = await pipeline.translate([{ text: 'Hello from a cancelled tab', key: 'k1', tabId: 7 }], {
      immediate: true,
    });
    expect(betaCalls).toBe(0);
    expect(res.errors.k1?.kind).toBe('aborted');
    expect(res.actualProviderName).toBeUndefined();
  });

  it('stream cache-hits without calling translateStream', async () => {
    const cache = new MemoryTranslationCache();
    const s = settings();
    await seed(cache, s, 'Hello', '你好');
    let streamed = 0;
    const deltas: string[] = [];
    const pipeline = makePipeline(s, {
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

  it('does not forward think-tag residue in streaming deltas (M-60)', async () => {
    const deltas: string[] = [];
    const pipeline = makePipeline(settings(), {
      a: (c) =>
        fake(c, {
          translateStream: async (_text, onDelta) => {
            onDelta('<think>secret');
            onDelta(' plan</think>');
            onDelta('开源软件');
            return '<think>secret plan</think>开源软件';
          },
        }),
    });
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], {
      immediate: true,
      onDelta: (_key, d) => deltas.push(d),
    });
    expect(res.results.k1).toBe('开源软件');
    expect(deltas.join('')).toBe('开源软件');
    expect(deltas.join('')).not.toContain('secret');
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
    await pipeline.translate([{ text: 'picked', key: 'selection', tabId: 1 }], { immediate: true });
    expect(inflight).toEqual([[{ key: 'node-2', text: 'page' }]]);
  });

  it('caps concurrent Provider calls at 2 unless every item is immediate (M-82)', async () => {
    vi.useFakeTimers();
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
      { onDelta: () => undefined },
    );
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await vi.waitFor(() => expect(gate.length).toBe(2));
    expect(max).toBe(2);
    gate.splice(0).forEach((r) => r());
    await vi.waitFor(() => expect(gate.length).toBe(1));
    gate.splice(0).forEach((r) => r());
    await pending;
    expect(max).toBe(2);
  });

  it('lifts the concurrency cap when every queued item is immediate (M-82)', async () => {
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
    await vi.waitFor(() => expect(gate.length).toBe(3));
    expect(max).toBe(3);
    gate.splice(0).forEach((r) => r());
    await pending;
    expect(max).toBe(3);
  });

  it('writes cache.put on a Provider miss with the source text (M-18)', async () => {
    const cache = new MemoryTranslationCache();
    const put = vi.spyOn(cache, 'put');
    const pipeline = makePipeline(settings(), { a: (c) => fake(c) }, { cache });
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('译:Hello');
    expect(put).toHaveBeenCalled();
    const [items, providerId, source, target, glossaryVersion] = put.mock.calls[0];
    expect(items).toEqual([{ text: 'Hello', translated: '译:Hello' }]);
    expect(providerId).toBe('a');
    expect(source).toBe('English');
    expect(target).toBe('简体中文');
    expect(glossaryVersion).toBe(0);
  });

  it('flushes a non-immediate enqueue after the batch window (M-18)', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const pipeline = makePipeline(settings(), {
      a: (c) =>
        fake(c, {
          translateTexts: async (texts) => {
            calls.push(texts);
            return texts.map((t) => `译:${t}`);
          },
        }),
    });
    const pending = pipeline.translate([{ text: 'Hello', key: 'k1' }]);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    const res = await pending;
    expect(res.results.k1).toBe('译:Hello');
    expect(calls).toEqual([['Hello']]);
  });

  it('cancelTab drains queued items so the Provider is never called (M-21)', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const pipeline = makePipeline(settings(), {
      a: (c) =>
        fake(c, {
          translateTexts: async (texts) => {
            calls.push(texts);
            return texts.map((t) => `译:${t}`);
          },
        }),
    });
    const pending = pipeline.translate([{ text: 'Hello', key: 'k1', tabId: 7 }]);
    await Promise.resolve();
    await Promise.resolve();
    pipeline.cancelTab(7);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    const res = await pending;
    expect(res.errors.k1?.kind).toBe('aborted');
    expect(calls).toEqual([]);
  });

  it('does not batch items that differ in domain, pageLanguage, or frameId (M-22)', async () => {
    const calls: string[][] = [];
    const pipeline = makePipeline(settings(), {
      a: (c) =>
        fake(c, {
          translateTexts: async (texts) => {
            calls.push(texts);
            return texts.map((t) => `译:${t}`);
          },
        }),
    });
    const [r1, r2, r3] = await Promise.all([
      pipeline.translate([{ text: 'A', key: 'k1', tabId: 1, frameId: 0, domain: 'a.example' }], {
        immediate: true,
      }),
      pipeline.translate([{ text: 'B', key: 'k2', tabId: 1, frameId: 0, domain: 'b.example' }], {
        immediate: true,
      }),
      pipeline.translate(
        [{ text: 'C', key: 'k3', tabId: 1, frameId: 3, pageLanguage: 'Japanese' }],
        { immediate: true },
      ),
    ]);
    expect(r1.results.k1).toBe('译:A');
    expect(r2.results.k2).toBe('译:B');
    expect(r3.results.k3).toBe('译:C');
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.join(',')).sort()).toEqual(['A', 'B', 'C']);
  });

  it('failovers when createProvider throws a network error (M-23)', async () => {
    const a = provider('a', 'Alpha');
    const b = provider('b', 'Beta');
    const pipeline = makePipeline(
      settings({ failoverChain: ['b'] }, [a, b]),
      { b: (c) => fake(c) },
      {
        createProvider: (c) => {
          if (c.id === 'a') throw new ProviderError('network', 'factory boom');
          return fake(c);
        },
      },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('译:Hello');
    expect(res.actualProviderName).toBe('Beta');
  });

  it('completeTasks includes invalid_response keys (M-23)', async () => {
    const done: Array<{ keys: string[]; frameId?: number }> = [];
    const pipeline = makePipeline(
      settings(),
      { a: (c) => fake(c, { translateTexts: async () => [''] }) },
      {
        completeTasks: async (_tab, keys, frameId) => {
          done.push({ keys, frameId });
        },
      },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1', tabId: 1, frameId: 3 }], {
      immediate: true,
    });
    expect(res.errors.k1?.kind).toBe('invalid_response');
    expect(done).toEqual([{ keys: ['k1'], frameId: 3 }]);
  });

  it('cache key includes model fingerprint so a model change misses (M-24)', async () => {
    const cache = new MemoryTranslationCache();
    const s = settings();
    await seed(cache, s, 'Hello', '你好');
    const next = settings({}, [{ ...s.providers[0], model: 'other-model' }]);
    const calls: string[][] = [];
    const pipeline = makePipeline(
      next,
      {
        a: (c) =>
          fake(c, {
            translateTexts: async (texts) => {
              calls.push(texts);
              return texts.map((t) => `新:${t}`);
            },
          }),
      },
      { cache },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('新:Hello');
    expect(calls).toEqual([['Hello']]);
  });

  it('source=auto cache lookup uses the resolved pageLanguage (M-24)', async () => {
    const cache = new MemoryTranslationCache();
    const p = { ...provider('a', 'Alpha'), sourceLanguage: 'auto' };
    const s = settings({ languageDetection: 'auto' }, [p]);
    const ctx = buildContext(s, p, undefined, 'Japanese');
    await cache.put(
      [{ text: 'Hello', translated: 'こんにちは' }],
      p.id,
      ctx.sourceLanguage,
      ctx.targetLanguage,
      s.glossaryVersion,
      cacheFingerprint(p),
    );
    const calls: string[][] = [];
    const pipeline = makePipeline(
      s,
      {
        a: (c) =>
          fake(c, {
            translateTexts: async (texts) => {
              calls.push(texts);
              return texts.map((t) => `译:${t}`);
            },
          }),
      },
      { cache },
    );
    const res = await pipeline.translate(
      [{ text: 'Hello', key: 'k1', pageLanguage: 'Japanese' }],
      { immediate: true },
    );
    expect(res.results.k1).toBe('こんにちは');
    expect(calls).toEqual([]);
  });

  it('deletes a cache entry that sanitizes to empty and refetches (M-25)', async () => {
    const cache = new MemoryTranslationCache();
    const s = settings();
    await seed(cache, s, 'Hello', '<think>x</think>');
    const deleted: string[][] = [];
    const origDelete = cache.delete.bind(cache);
    cache.delete = async (texts, ...rest) => {
      deleted.push(texts);
      return origDelete(texts, ...rest);
    };
    const calls: string[][] = [];
    const pipeline = makePipeline(
      s,
      {
        a: (c) =>
          fake(c, {
            translateTexts: async (texts) => {
              calls.push(texts);
              return texts.map((t) => `译:${t}`);
            },
          }),
      },
      { cache },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('译:Hello');
    expect(deleted).toEqual([['Hello']]);
    expect(calls).toEqual([['Hello']]);
  });

  it('failover success writes cache under the primary provider id (M-25)', async () => {
    const cache = new MemoryTranslationCache();
    const put = vi.spyOn(cache, 'put');
    const a = provider('a', 'Alpha');
    const b = provider('b', 'Beta');
    const pipeline = makePipeline(
      settings({ failoverChain: ['b'] }, [a, b]),
      {
        a: (c) =>
          fake(c, {
            translateTexts: async () => {
              throw new ProviderError('network', 'down');
            },
          }),
        b: (c) => fake(c),
      },
      { cache },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.results.k1).toBe('译:Hello');
    expect(res.actualProviderName).toBe('Beta');
    expect(put.mock.calls[0][1]).toBe('a');
  });

  it('records invalid_response as a failure, not a success (M-52)', async () => {
    const stats: Array<{ ok: boolean; message?: string }> = [];
    const pipeline = makePipeline(
      settings(),
      { a: (c) => fake(c, { translateTexts: async () => ['<think>x</think>'] }) },
      {
        recordStat: (_id, ok, _ms, message) => {
          stats.push({ ok, message });
        },
      },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], { immediate: true });
    expect(res.errors.k1?.kind).toBe('invalid_response');
    expect(stats).toEqual([{ ok: false, message: 'invalid_response' }]);
  });

  it('does not record an aborted request as a Provider failure (M-52)', async () => {
    const stats: Array<{ ok: boolean }> = [];
    let pipeline!: TranslationPipeline;
    pipeline = makePipeline(
      settings(),
      {
        a: (c) =>
          fake(c, {
            translateTexts: async () => {
              pipeline.cancelTab(7);
              throw new ProviderError('aborted', '请求已取消');
            },
          }),
      },
      {
        recordStat: (_id, ok) => {
          stats.push({ ok });
        },
      },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1', tabId: 7 }], {
      immediate: true,
    });
    expect(res.errors.k1?.kind).toBe('aborted');
    expect(stats).toEqual([]);
  });

  it('records stream hygiene-empty as invalid_response stats (M-52)', async () => {
    const stats: Array<{ ok: boolean; message?: string }> = [];
    const pipeline = makePipeline(
      settings(),
      {
        a: (c) =>
          fake(c, {
            translateStream: async () => '<think>x</think>',
          }),
      },
      {
        recordStat: (_id, ok, _ms, message) => {
          stats.push({ ok, message });
        },
      },
    );
    const res = await pipeline.translate([{ text: 'Hello', key: 'k1' }], {
      immediate: true,
      onDelta: () => undefined,
    });
    expect(res.errors.k1?.kind).toBe('invalid_response');
    expect(stats).toEqual([{ ok: false, message: 'invalid_response' }]);
  });

  it('fans out a duplicate in-queue key to one Provider call (M-82)', async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const pipeline = makePipeline(settings(), {
      a: (c) =>
        fake(c, {
          translateTexts: async (texts) => {
            calls.push(texts);
            return texts.map((t) => `译:${t}`);
          },
        }),
    });
    const p1 = pipeline.translate([{ text: 'Hello', key: 'k1', tabId: 1, frameId: 0 }]);
    const p2 = pipeline.translate([{ text: 'Hello', key: 'k1', tabId: 1, frameId: 0 }]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.results.k1).toBe('译:Hello');
    expect(r2.results.k1).toBe('译:Hello');
    expect(calls).toEqual([['Hello']]);
  });

  it('aborts the whole batch when a later item signal fires (M-82)', async () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pipeline = makePipeline(settings(), {
      a: (c) =>
        fake(c, {
          translateTexts: async (_texts: string[], _ctx: unknown, signal?: AbortSignal) => {
            markStarted();
            await new Promise<void>((_resolve, reject) => {
              const fail = (): void => reject(new ProviderError('aborted', '请求已取消'));
              if (!signal || signal.aborted) {
                fail();
                return;
              }
              signal.addEventListener('abort', fail);
            });
            return [];
          },
        }),
    });
    const p1 = pipeline.translate([{ text: 'A', key: 'k1', tabId: 1 }], { signal: ac1.signal });
    const p2 = pipeline.translate([{ text: 'B', key: 'k2', tabId: 1 }], { signal: ac2.signal });
    await started;
    ac2.abort();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.errors.k1?.kind).toBe('aborted');
    expect(r2.errors.k2?.kind).toBe('aborted');
  });

  it('keeps cacheScope off the Provider and TM, and in the cache key (M-07)', async () => {
    const cache = new MemoryTranslationCache();
    const tm = new TranslationMemory(new MemoryTmStore(), 100);
    const calls: string[][] = [];
    const inflight: Array<{ key: string; text: string }> = [];
    const s = settings({ translationMemory: { enabled: true, maxEntries: 100 } });
    const fp = cacheFingerprint(s.providers[0]);
    const pipeline = makePipeline(
      s,
      {
        a: (c) =>
          fake(c, {
            translateTexts: async (texts) => {
              calls.push(texts);
              return texts.map((t) => `译:${t}`);
            },
          }),
      },
      {
        cache,
        tm,
        recordInflight: async (_tab, _frame, items) => {
          inflight.push(...items);
        },
      },
    );
    const body = 'Hello, world!';
    const scopeA = 'pdf|fileid:X|p1|i0|';
    const scopeB = 'pdf|fileid:X|p1|i1|';
    const res = await pipeline.translate(
      [{ text: body, key: 'p1-0', cacheScope: scopeA, tabId: 9 }],
      { immediate: true },
    );
    expect(res.results['p1-0']).toBe(`译:${body}`);
    expect(calls).toEqual([[body]]);
    expect(inflight).toEqual([{ key: 'p1-0', text: `${scopeA}${body}` }]);

    const tmHits = await tm.lookup([{ key: 'body', text: body }], 'English|简体中文');
    expect(tmHits.get('body')).toBe(`译:${body}`);
    const tmPrefixed = await tm.lookup(
      [{ key: 'scoped', text: `${scopeA}${body}` }],
      'English|简体中文',
    );
    expect(tmPrefixed.size).toBe(0);

    const cacheHits = await cache.get(
      [{ key: 'scoped', text: `${scopeA}${body}` }],
      'a',
      'English',
      '简体中文',
      0,
      fp,
    );
    expect(cacheHits.get('scoped')).toBe(`译:${body}`);
    const cacheBody = await cache.get(
      [{ key: 'body', text: body }],
      'a',
      'English',
      '简体中文',
      0,
      fp,
    );
    expect(cacheBody.size).toBe(0);

    const cacheOther = await cache.get(
      [{ key: 'other', text: `${scopeB}${body}` }],
      'a',
      'English',
      '简体中文',
      0,
      fp,
    );
    expect(cacheOther.size).toBe(0);

    calls.length = 0;
    const hit = await pipeline.translate(
      [{ text: body, key: 'p1-0b', cacheScope: scopeA, tabId: 9 }],
      { immediate: true },
    );
    expect(hit.results['p1-0b']).toBe(`译:${body}`);
    expect(calls).toEqual([]);

    const cacheOnly = new MemoryTranslationCache();
    const cacheCalls: string[][] = [];
    const cachePipeline = makePipeline(
      settings({ cacheEnabled: true, translationMemory: { enabled: false, maxEntries: 100 } }),
      {
        a: (c) =>
          fake(c, {
            translateTexts: async (texts) => {
              cacheCalls.push(texts);
              return texts.map((t) => `译:${t}`);
            },
          }),
      },
      { cache: cacheOnly },
    );
    await cachePipeline.translate(
      [{ text: body, key: 'p1-0', cacheScope: scopeA }],
      { immediate: true },
    );
    cacheCalls.length = 0;
    const miss = await cachePipeline.translate(
      [{ text: body, key: 'p1-1', cacheScope: scopeB }],
      { immediate: true },
    );
    expect(miss.results['p1-1']).toBe(`译:${body}`);
    expect(cacheCalls).toEqual([[body]]);
    cacheCalls.length = 0;
    const scopedHit = await cachePipeline.translate(
      [{ text: body, key: 'p1-0c', cacheScope: scopeA }],
      { immediate: true },
    );
    expect(scopedHit.results['p1-0c']).toBe(`译:${body}`);
    expect(cacheCalls).toEqual([]);
  });
});