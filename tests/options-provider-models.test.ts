// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import html from '../src/options/options.html?raw';
import type { RuntimeMessage } from '../src/messaging/messages';
import { defaultSettings } from '../src/shared/constants';
import { normalizeSettings } from '../src/storage/settings';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('adds services from one picker and uses the unsaved connection to fetch and select a model', async () => {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll('link, script')) element.remove();
  document.body.append(template.content);
  let settings = defaultSettings();
  settings.providers[0].apiKey = 'existing-provider-key';
  const save = vi.fn((incoming: unknown) => {
    settings = normalizeSettings(incoming);
    return { ok: true, settings };
  });
  const sendMessage = vi.fn((message: RuntimeMessage, reply: (value: unknown) => void) => {
    switch (message.type) {
      case 'get-full-settings': reply({ settings }); break;
      case 'save-settings': reply(save(message.settings)); break;
      case 'test-provider': reply({ ok: true, result: '你好' }); break;
      case 'list-provider-models':
        reply({ ok: true, models: message.provider.type === 'opencode-go'
          ? [{ id: 'kimi-k3', name: 'Kimi K3', reasoningEfforts: ['max'] }]
          : [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] });
        break;
      case 'opencode-go-quota': reply({ ok: true, status: null }); break;
      default: reply({});
    }
  });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    commands: { getAll: async () => [] },
    storage: { onChanged: { addListener: vi.fn() } },
  });
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  await import('../src/options/main');
  await vi.waitFor(() => expect(get('editor-title').textContent).toContain('OpenAI-compatible'));
  const originalProvider = settings.providers[0];

  const addPreset = (name: string) => {
    get('add-provider').click();
    const button = [...get('provider-preset-list').querySelectorAll('button')]
      .find((preset) => preset.textContent === name);
    if (!button) throw new Error(`Missing preset ${name}`);
    button.click();
  };
  addPreset('OpenCode Go');
  const apiKey = get<HTMLInputElement>('f-apikey');
  expect(document.activeElement).toBe(apiKey);
  expect(apiKey.value).toBe('');
  expect(get('editor-title').textContent).toContain('OpenCode Go');
  expect(get<HTMLDetailsElement>('provider-advanced').open).toBe(false);
  expect(document.querySelector('.active-badge')?.parentElement?.textContent).toContain('OpenAI-compatible');

  get('save-provider').click();
  expect(get('test-result').textContent).toContain('API Key');
  expect(save).not.toHaveBeenCalled();

  const picker = get<HTMLSelectElement>('provider-model-select');
  const model = get<HTMLInputElement>('f-model');
  const thinking = get<HTMLSelectElement>('f-thinking-level');
  apiKey.value = 'go-test-key';
  apiKey.dispatchEvent(new Event('input', { bubbles: true }));
  expect(picker.disabled).toBe(true);
  get('provider-model-fetch').click();
  await vi.waitFor(() => expect(picker.disabled).toBe(false));
  expect(model.classList.contains('hidden')).toBe(true);
  picker.value = 'kimi-k3';
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  expect(model.value).toBe('kimi-k3');
  expect([...thinking.options].map(({ value }) => value)).toEqual(['', 'max']);
  thinking.value = 'max';
  thinking.dispatchEvent(new Event('change', { bubbles: true }));
  get('provider-model-mode').click();
  expect(document.activeElement).toBe(model);
  model.value = 'custom-go-model';
  model.dispatchEvent(new Event('input', { bubbles: true }));
  expect(thinking.value).toBe('');
  expect([...thinking.options].map(({ value }) => value)).toContain('medium');
  get('provider-model-mode').click();
  expect(picker.value).toBe('custom-go-model');

  thinking.value = 'medium';
  thinking.dispatchEvent(new Event('change', { bubbles: true }));
  get('test-provider').click();
  await vi.waitFor(() => expect(get('test-result').textContent).toContain('你好'));
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'test-provider', provider: expect.objectContaining({ thinkingLevel: 'medium' }),
  }), expect.any(Function));
  get('save-provider').click();
  await vi.waitFor(() => expect(get('save-provider').textContent).toBe('保存设置'));
  expect(save).toHaveBeenCalledTimes(1);
  expect(settings.providers).toContainEqual(originalProvider);
  expect(settings.providers.find((provider) => provider.id === settings.activeProviderId)).toMatchObject({
    type: 'opencode-go', model: 'custom-go-model', apiKey: 'go-test-key', enabled: true, thinkingLevel: 'medium',
  });
  expect(thinking.value).toBe('medium');
  expect(document.querySelector('.active-badge')?.parentElement?.textContent).toContain('OpenCode Go');

  addPreset('DeepSeek');
  expect(thinking.value).toBe('');
  expect(document.activeElement).toBe(apiKey);
  expect(apiKey.value).toBe('');
  expect(get<HTMLInputElement>('f-baseurl').value).toBe('https://api.deepseek.com/v1');
  expect(picker.disabled).toBe(true);
  apiKey.value = 'deepseek-test-key';
  apiKey.dispatchEvent(new Event('input', { bubbles: true }));
  get('provider-model-fetch').click();
  await vi.waitFor(() => expect(picker.disabled).toBe(false));
  expect([...picker.options].map(({ value }) => value)).toContain('deepseek-flash');
  expect([...picker.options].map(({ value }) => value)).not.toContain('kimi-k3');
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'list-provider-models',
    provider: expect.objectContaining({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'deepseek-test-key' }),
  }), expect.any(Function));
  picker.value = 'deepseek-flash';
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  get('save-provider').click();
  await vi.waitFor(() => expect(settings.providers.find(({ id }) => id === settings.activeProviderId)).toMatchObject({
    name: 'DeepSeek', model: 'deepseek-flash',
  }));
});
