/**
 * New provider request-construction / response-parsing tests against fixed
 * payloads (spec 2.0 §12.1): DeepL, Azure Translator, Google Translate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/providers/deepl';
import '../src/providers/azure-translator';
import '../src/providers/google-translate';
import { createProvider } from '../src/providers/provider';
import { toAzureLanguage, toDeepLLanguage, toGoogleLanguage } from '../src/providers/langCodes';
import type { ProviderConfig } from '../src/shared/types';

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetchOnce(responseJson: unknown, capture: CapturedRequest[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      capture.push({
        url,
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(responseJson), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function baseConfig(type: ProviderConfig['type'], extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 't',
    name: 'test',
    type,
    baseUrl: '',
    apiKey: 'test-key',
    model: '',
    sourceLanguage: '',
    targetLanguage: '',
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

describe('DeepL provider', () => {
  it('builds the documented request and parses translations', async () => {
    const captured: CapturedRequest[] = [];
    mockFetchOnce(
      {
        translations: [
          { detected_source_language: 'EN', text: '你好，世界' },
          { detected_source_language: 'EN', text: '第二条' },
        ],
      },
      captured,
    );
    const provider = createProvider(
      baseConfig('deepl', { baseUrl: 'https://api-free.deepl.com', formality: 'more' }),
    );
    const out = await provider.translateTexts(['Hello, world', 'Second'], ctx, new AbortController().signal);
    expect(out).toEqual(['你好，世界', '第二条']);

    const req = captured[0];
    expect(req.url).toBe('https://api-free.deepl.com/v2/translate');
    expect(req.headers.Authorization).toBe('DeepL-Auth-Key test-key');
    expect(req.body).toMatchObject({
      text: ['Hello, world', 'Second'],
      target_lang: 'ZH',
      source_lang: 'EN',
      formality: 'more',
    });
  });

  it('throws invalid_response on count mismatch', async () => {
    mockFetchOnce({ translations: [{ text: 'only one' }] }, []);
    const provider = createProvider(baseConfig('deepl', { baseUrl: 'https://api-free.deepl.com' }));
    await expect(
      provider.translateTexts(['a', 'b'], ctx, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('maps HTTP 403 to auth error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 })),
    );
    const provider = createProvider(baseConfig('deepl', { baseUrl: 'https://api-free.deepl.com' }));
    await expect(
      provider.translateTexts(['a'], ctx, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('Azure Translator provider', () => {
  it('builds the documented request and parses the array response', async () => {
    const captured: CapturedRequest[] = [];
    mockFetchOnce(
      [
        { translations: [{ text: '你好', to: 'zh-Hans' }] },
        { translations: [{ text: '世界', to: 'zh-Hans' }] },
      ],
      captured,
    );
    const provider = createProvider(
      baseConfig('azure-translator', {
        baseUrl: 'https://api.cognitive.microsofttranslator.com',
        region: 'eastasia',
      }),
    );
    const out = await provider.translateTexts(['Hello', 'World'], ctx, new AbortController().signal);
    expect(out).toEqual(['你好', '世界']);

    const req = captured[0];
    expect(req.url).toContain('/translate?');
    expect(req.url).toContain('api-version=3.0');
    expect(req.url).toContain('to=zh-Hans');
    expect(req.url).toContain('from=en');
    expect(req.headers['Ocp-Apim-Subscription-Key']).toBe('test-key');
    expect(req.headers['Ocp-Apim-Subscription-Region']).toBe('eastasia');
    expect(req.body).toEqual([{ Text: 'Hello' }, { Text: 'World' }]);
  });

  it('requires an API key (config error)', async () => {
    const provider = createProvider(baseConfig('azure-translator', { apiKey: '' }));
    await expect(
      provider.translateTexts(['a'], ctx, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'config' });
  });
});

describe('Google Translate provider', () => {
  it('builds the v2 request with key in query and decodes entities', async () => {
    const captured: CapturedRequest[] = [];
    mockFetchOnce(
      {
        data: {
          translations: [{ translatedText: '你好 &amp; 世界' }, { translatedText: '&#39;引号&#39;' }],
        },
      },
      captured,
    );
    const provider = createProvider(
      baseConfig('google-translate', {
        baseUrl: 'https://translation.googleapis.com/language/translate/v2',
      }),
    );
    const out = await provider.translateTexts(['a & b', "'q'"], ctx, new AbortController().signal);
    expect(out).toEqual(['你好 & 世界', "'引号'"]);

    const req = captured[0];
    expect(req.url).toContain('https://translation.googleapis.com/language/translate/v2?key=test-key');
    expect(req.body).toMatchObject({ q: ['a & b', "'q'"], target: 'zh-CN', format: 'text' });
  });

  it('maps HTTP 429 to rate_limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 })),
    );
    const provider = createProvider(baseConfig('google-translate'));
    await expect(
      provider.translateTexts(['a'], ctx, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

describe('language code mapping', () => {
  it('maps Chinese labels per provider dialect', () => {
    expect(toDeepLLanguage('简体中文')).toBe('ZH');
    expect(toDeepLLanguage('English')).toBe('EN');
    expect(toDeepLLanguage('auto')).toBeUndefined();
    expect(toAzureLanguage('简体中文')).toBe('zh-Hans');
    expect(toAzureLanguage('ja')).toBe('ja');
    expect(toGoogleLanguage('简体中文')).toBe('zh-CN');
    expect(toGoogleLanguage('繁体中文')).toBe('zh-TW');
    expect(toGoogleLanguage('')).toBeUndefined();
  });
  it('passes through raw codes unchanged', () => {
    expect(toDeepLLanguage('DE')).toBe('DE');
    expect(toAzureLanguage('fr')).toBe('fr');
    expect(toGoogleLanguage('ko')).toBe('ko');
  });
});