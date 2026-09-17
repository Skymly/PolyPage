/**
 * M-18: openai-compatible translateTexts / translateStream against a mock HTTP API.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/providers/openai-compatible';
import { createProvider } from '../src/providers/provider';
import type { ProviderConfig } from '../src/shared/types';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function config(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'oa',
    name: 'OpenAI',
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'test-key',
    model: 'mock-model',
    sourceLanguage: 'English',
    targetLanguage: '简体中文',
    timeoutMs: 5000,
    maxBatchItems: 50,
    maxBatchChars: 20000,
    systemPrompt: '',
    userPromptTemplate: '',
    temperature: 0.2,
    maxTokens: 4096,
    headers: {},
    enabled: true,
    ...extra,
  };
}

const ctx = { sourceLanguage: 'English', targetLanguage: '简体中文' };

function chatJson(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function sseBody(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe('openai-compatible translateTexts', () => {
  it('posts chat/completions and returns the assistant content', async () => {
    const captured: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({
          url: typeof input === 'string' ? input : input.toString(),
          body: JSON.parse(String(init?.body)),
        });
        return chatJson('你好，世界');
      }),
    );
    const provider = createProvider(config());
    const out = await provider.translateTexts(['Hello, world!'], ctx, new AbortController().signal);
    expect(captured[0].url).toBe('http://127.0.0.1:9/v1/chat/completions');
    expect(captured[0].body.model).toBe('mock-model');
    expect(captured[0].body.stream).toBe(false);
    expect(out).toEqual(['你好，世界']);
  });
});

describe('openai-compatible translateStream', () => {
  it('concatenates SSE deltas until [DONE]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = sseBody([
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    const provider = createProvider(config());
    const deltas: string[] = [];
    const full = await provider.translateStream!(
      'Hello',
      ctx,
      (d) => deltas.push(d),
      new AbortController().signal,
    );
    expect(deltas.join('')).toBe('你好');
    expect(full).toBe('你好');
  });

  it('parses CRLF-delimited SSE events (M-77)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = sseBody([
          'data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n',
          'data: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\n',
          'data: [DONE]\r\n\r\n',
        ]);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );
    const provider = createProvider(config());
    const deltas: string[] = [];
    const full = await provider.translateStream!(
      'Hello',
      ctx,
      (d) => deltas.push(d),
      new AbortController().signal,
    );
    expect(deltas.join('')).toBe('你好');
    expect(full).toBe('你好');
  });

  it('does not retry translateStream after emitting would be irrecoverable (M-77)', async () => {
    const fetchMock = vi.fn(async () => new Response('quota', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createProvider(config());
    await expect(
      provider.translateStream!('Hello', ctx, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('openai-compatible transcribe timeout (M-73)', () => {
  it('does not retry a whole-file transcribe and waits past the text timeout', async () => {
    vi.useFakeTimers();
    let fetches = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        fetches += 1;
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }),
    );
    const provider = createProvider(config({ supportsAsr: true, timeoutMs: 5_000 }));
    const pending = provider.transcribe!(
      { mime: 'audio/webm', bytes: new Uint8Array([1, 2, 3]) },
      { ...ctx, languageHint: 'en' },
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetches).toBe(1);
    await vi.advanceTimersByTimeAsync(200_000);
    await rejected;
    expect(fetches).toBe(1);
  });
});
