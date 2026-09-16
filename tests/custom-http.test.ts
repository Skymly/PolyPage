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
});
