/**
 * M-18: custom-http provider against a mock JSON API.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/providers/custom-http';
import { createProvider } from '../src/providers/provider';
import type { ProviderConfig } from '../src/shared/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'ch',
    name: 'Custom',
    type: 'custom-http',
    baseUrl: 'http://127.0.0.1:9/translate',
    apiKey: 'test-key',
    model: '',
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
    method: 'POST',
    bodyTemplate: '{ "q": {{texts}}, "from": "{{sourceLanguage}}", "to": "{{targetLanguage}}" }',
    responsePath: 'data.translations',
    ...extra,
  };
}

const ctx = { sourceLanguage: 'English', targetLanguage: '简体中文' };

describe('custom-http translateTexts', () => {
  it('posts the rendered body and reads responsePath', async () => {
    const captured: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({
          url: typeof input === 'string' ? input : input.toString(),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(
          JSON.stringify({ data: { translations: ['[gw] Hello', '[gw] Second'] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const provider = createProvider(config());
    const out = await provider.translateTexts(
      ['Hello', 'Second'],
      ctx,
      new AbortController().signal,
    );
    expect(captured[0].url).toBe('http://127.0.0.1:9/translate');
    expect(captured[0].body).toEqual({ q: ['Hello', 'Second'], from: 'English', to: '简体中文' });
    expect(out).toEqual(['[gw] Hello', '[gw] Second']);
  });

  it('puts text/q/source/target on the query string for GET (M-77)', async () => {
    const captured: { url: string; method: string | undefined; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({
          url: typeof input === 'string' ? input : input.toString(),
          method: init?.method,
          body: init?.body,
        });
        return new Response(JSON.stringify({ data: { translations: ['hi'] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const provider = createProvider(config({ method: 'GET', bodyTemplate: '' }));
    const out = await provider.translateTexts(['Hello'], ctx, new AbortController().signal);
    expect(out).toEqual(['hi']);
    expect(captured[0].method).toBe('GET');
    expect(captured[0].body).toBeUndefined();
    const parsed = new URL(captured[0].url);
    expect(parsed.searchParams.get('text')).toBe('Hello');
    expect(parsed.searchParams.get('q')).toBe('Hello');
    expect(parsed.searchParams.get('source')).toBe('English');
    expect(parsed.searchParams.get('target')).toBe('简体中文');
  });

  it('rejects javascript: baseUrl (M-77)', async () => {
    const provider = createProvider(config({ baseUrl: 'javascript:alert(1)' }));
    await expect(
      provider.translateTexts(['Hello'], ctx, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'config' });
  });
});
