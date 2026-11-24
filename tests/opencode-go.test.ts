import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider, providerSupportsAsr, providerSupportsStreaming } from '../src/providers/provider';
import { fetchOpenCodeGoQuota } from '../src/providers/opencode-go';
import { listProviderModels } from '../src/providers/modelCatalog';
import { findPreset, presetToProvider } from '../src/providers/presets';
import { defaultProvider } from '../src/shared/constants';
import { normalizeProvider } from '../src/storage/settings';
import { isProviderConfigured } from '../src/translation/context';

afterEach(() => vi.unstubAllGlobals());

const context = { sourceLanguage: 'English', targetLanguage: '简体中文' };
const reset = '2026-11-21T08:00:00.000Z';
const usage = {
  rolling: { percent: 0, resetsAt: reset },
  weekly: { percent: 25, resetsAt: reset },
  monthly: { percent: 100, resetsAt: null },
};

describe('OpenCode Go provider', () => {
  it('prefills the official endpoint and requires both key and model to be configured', () => {
    const preset = findPreset('preset-opencode-go');
    if (!preset) throw new Error('missing OpenCode Go preset');
    const provider = presetToProvider(preset, 'go');
    expect(provider).toMatchObject({ type: 'opencode-go', autoRefreshQuota: true, model: 'glm-5.3-flash' });
    expect(isProviderConfigured(provider)).toBe(false);
    const normalized = normalizeProvider({
      ...provider,
      baseUrl: 'https://wrong.example/v1',
      model: ' opencode-go/kimi-k3 ',
      apiKey: ' test-key ',
      autoRefreshQuota: false,
    });
    if (!normalized) throw new Error('invalid OpenCode Go settings');
    expect(normalized).toMatchObject({
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      model: 'kimi-k3',
      apiKey: 'test-key',
      autoRefreshQuota: false,
    });
    expect(isProviderConfigured(normalized)).toBe(true);
    expect(isProviderConfigured({ ...normalized, model: '' })).toBe(false);
  });

  it('sends ordinary and streaming translations to Go with the same session and the configured key', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '你好' } }] }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      ...defaultProvider(),
      type: 'opencode-go' as const,
      baseUrl: 'https://wrong.example/v1',
      headers: { authorization: 'wrong-key', 'x-opencode-session': 'wrong-session' },
      apiKey: ' test-key ',
      model: 'opencode-go/claude-haiku-5-5',
      thinkingLevel: 'low' as const,
    };
    const provider = createProvider(config);
    const signal = new AbortController().signal;
    const scoped = { ...context, documentContext: { title: 'Manual', section: 'TCP' }, glossary: 'port = 端口' };
    expect(await provider.translateTexts(['Hello'], scoped, signal)).toEqual(['你好']);
    expect(await provider.translateStream?.('Hello', scoped, vi.fn(), signal)).toBe('你好');
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'claude-haiku-5-5', reasoning_effort: 'low' });
      const { messages } = JSON.parse(String(init?.body));
      expect(messages[0].content).toContain('port = 端口');
      expect(messages[1].content).toContain('"section":"TCP"');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-key');
    }
    const session = new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-opencode-session');
    expect(session).toMatch(/^ses_[0-9a-f-]+$/);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('x-opencode-session')).toBe(session);
    expect(providerSupportsStreaming(createProvider({ ...config, supportsStreaming: false }))).toBe(false);
    expect(providerSupportsAsr(provider)).toBe(false);
  });

  it('loads the live catalog shape without credentials and keeps text models with native protocols', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
      { id: 'kimi-k3', name: 'Kimi K3', capabilities: { reasoning: { supported: true, effort: ['max', 'default', 1] } } },
      {
        id: 'claude-haiku-5-5', name: 'Claude Haiku', api: { messages: {} },
        capabilities: { reasoning: { supported: true, toggle: true, effort: ['high', 'none'] } },
      },
      { id: 'unconfigurable-model', capabilities: { reasoning: { supported: true } } },
      { id: 'kimi-k3', name: 'Duplicate' },
      { id: 'image-model', type: 'image' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listProviderModels({ ...defaultProvider(), type: 'opencode-go', apiKey: 'go-test-key' })).resolves.toEqual([
      { id: 'claude-haiku-5-5', name: 'Claude Haiku', reasoningEfforts: ['none', 'high'] },
      { id: 'kimi-k3', name: 'Kimi K3', reasoningEfforts: ['max'] },
      { id: 'unconfigurable-model', name: 'unconfigurable-model', reasoningEfforts: [] },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://opencode.ai/inference/go/v1/models');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.credentials).toBe('omit');
  });

  it('reads the three quota windows and distinguishes entitlement and malformed responses', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ usage }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ usage: { rolling: { percent: null } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchOpenCodeGoQuota(' test-key ')).resolves.toEqual(usage);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://opencode.ai/inference/go/v1/usage', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      credentials: 'omit',
      redirect: 'error',
    }));
    await expect(fetchOpenCodeGoQuota('test-key')).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('403') });
    await expect(fetchOpenCodeGoQuota('test-key')).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
