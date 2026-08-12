/**
 * Options page (spec §10.4): provider management, languages, display mode,
 * blacklist, cache management, error log, import/export, shortcut info.
 */
import { sendRuntime } from '../messaging/messages';
import { DEFAULT_CUSTOM_HTTP_BODY, defaultProvider } from '../shared/constants';
import type { DisplayMode, ProviderConfig, ProviderType, Settings } from '../shared/types';
import { normalizeSettings, validateImportedSettings } from '../storage/settings';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

let draft: Settings | null = null;
let selectedId: string | null = null;

/* --------------------------------- helpers ---------------------------------- */

let toastTimer: number | null = null;
function toast(message: string, isError = false): void {
  const el = $<HTMLDivElement>('toast');
  el.textContent = message;
  el.classList.toggle('toast-error', isError);
  el.classList.remove('hidden');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 2600);
}

function markDirty(): void {
  $<HTMLElement>('save-hint').textContent = '有未保存的更改';
}
function clearDirty(): void {
  $<HTMLElement>('save-hint').textContent = '';
}

function num(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function selectedProvider(): ProviderConfig | null {
  return draft?.providers.find((p) => p.id === selectedId) ?? null;
}

/* ------------------------------- general form -------------------------------- */

function renderGeneral(): void {
  if (!draft) return;
  $<HTMLSelectElement>('default-mode').value = draft.defaultDisplayMode;
  $<HTMLInputElement>('auto-translate').checked = draft.autoTranslate;
  $<HTMLInputElement>('cache-enabled').checked = draft.cacheEnabled;
  $<HTMLInputElement>('default-source').value = draft.defaultSourceLanguage;
  $<HTMLInputElement>('default-target').value = draft.defaultTargetLanguage;
  $<HTMLInputElement>('min-text-length').value = String(draft.minTextLength);
  $<HTMLTextAreaElement>('blacklist-input').value = draft.blacklist.join('\n');
}

function collectGeneral(): void {
  if (!draft) return;
  draft.defaultDisplayMode = $<HTMLSelectElement>('default-mode').value as DisplayMode;
  draft.autoTranslate = $<HTMLInputElement>('auto-translate').checked;
  draft.cacheEnabled = $<HTMLInputElement>('cache-enabled').checked;
  draft.defaultSourceLanguage = $<HTMLInputElement>('default-source').value.trim() || 'auto';
  draft.defaultTargetLanguage = $<HTMLInputElement>('default-target').value.trim() || '简体中文';
  draft.minTextLength = Math.round(num($<HTMLInputElement>('min-text-length').value, draft.minTextLength));
  draft.blacklist = $<HTMLTextAreaElement>('blacklist-input')
    .value.split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/* ------------------------------ provider list -------------------------------- */

function renderProviderList(): void {
  if (!draft) return;
  const list = $<HTMLDivElement>('provider-list');
  list.textContent = '';
  for (const provider of draft.providers) {
    const row = document.createElement('div');
    row.className = `provider-row${provider.id === selectedId ? ' selected' : ''}`;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'active-provider';
    radio.checked = provider.id === draft.activeProviderId;
    radio.title = '设为当前使用的翻译服务';
    radio.addEventListener('click', (e) => e.stopPropagation());
    radio.addEventListener('change', () => {
      if (!draft) return;
      draft.activeProviderId = provider.id;
      markDirty();
      renderProviderList();
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${provider.name}${provider.enabled ? '' : '（已禁用）'}`;

    const badge = document.createElement('span');
    badge.className = 'type-badge';
    badge.textContent = provider.type;

    row.append(radio, name, badge);
    if (provider.id === draft.activeProviderId) {
      const active = document.createElement('span');
      active.className = 'active-badge';
      active.textContent = '使用中';
      row.appendChild(active);
    }

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = '删除';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeProvider(provider.id);
    });
    row.appendChild(del);

    row.addEventListener('click', () => {
      selectedId = provider.id;
      renderProviderList();
      renderEditor();
    });
    list.appendChild(row);
  }
}

function removeProvider(id: string): void {
  if (!draft) return;
  const provider = draft.providers.find((p) => p.id === id);
  if (!provider) return;
  if (!confirm(`确定删除翻译服务「${provider.name}」吗？`)) return;
  draft.providers = draft.providers.filter((p) => p.id !== id);
  if (draft.providers.length === 0) {
    const fresh = makeProvider('openai-compatible');
    draft.providers.push(fresh);
  }
  if (draft.activeProviderId === id) draft.activeProviderId = draft.providers[0].id;
  if (selectedId === id) selectedId = draft.providers[0].id;
  markDirty();
  renderProviderList();
  renderEditor();
}

function makeProvider(type: ProviderType): ProviderConfig {
  const base = defaultProvider();
  const provider: ProviderConfig = {
    ...base,
    id: `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: type === 'openai-compatible' ? 'OpenAI-compatible' : '自定义 HTTP API',
    type,
  };
  if (type === 'custom-http') {
    provider.baseUrl = '';
    provider.model = '';
    provider.method = 'POST';
    provider.bodyTemplate = DEFAULT_CUSTOM_HTTP_BODY;
    provider.responsePath = '';
    provider.apiKeyPlacement = 'header';
    provider.apiKeyParamName = 'Authorization';
  }
  return provider;
}

function addProvider(type: ProviderType): void {
  if (!draft) return;
  const provider = makeProvider(type);
  draft.providers.push(provider);
  selectedId = provider.id;
  markDirty();
  renderProviderList();
  renderEditor();
}

/* ------------------------------ provider editor ------------------------------ */

function renderEditor(): void {
  const editor = $<HTMLDivElement>('editor');
  const provider = selectedProvider();
  if (!provider) {
    editor.classList.add('hidden');
    return;
  }
  editor.classList.remove('hidden');
  $<HTMLElement>('editor-title').textContent = `编辑：${provider.name}`;

  $<HTMLInputElement>('f-name').value = provider.name;
  $<HTMLSelectElement>('f-type').value = provider.type;
  $<HTMLInputElement>('f-baseurl').value = provider.baseUrl;
  $<HTMLInputElement>('f-apikey').value = provider.apiKey;
  $<HTMLInputElement>('f-model').value = provider.model;
  $<HTMLInputElement>('f-source').value = provider.sourceLanguage;
  $<HTMLInputElement>('f-target').value = provider.targetLanguage;
  $<HTMLInputElement>('f-timeout').value = String(provider.timeoutMs);
  $<HTMLInputElement>('f-batch-items').value = String(provider.maxBatchItems);
  $<HTMLInputElement>('f-batch-chars').value = String(provider.maxBatchChars);
  $<HTMLInputElement>('f-temperature').value = String(provider.temperature);
  $<HTMLInputElement>('f-maxtokens').value = String(provider.maxTokens);
  $<HTMLTextAreaElement>('f-system-prompt').value = provider.systemPrompt;
  $<HTMLTextAreaElement>('f-user-prompt').value = provider.userPromptTemplate;
  $<HTMLTextAreaElement>('f-headers').value = JSON.stringify(provider.headers, null, 2) === '{}'
    ? ''
    : JSON.stringify(provider.headers, null, 2);
  $<HTMLInputElement>('f-enabled').checked = provider.enabled;

  $<HTMLSelectElement>('f-method').value = provider.method ?? 'POST';
  $<HTMLSelectElement>('f-key-placement').value = provider.apiKeyPlacement ?? 'header';
  $<HTMLInputElement>('f-key-name').value = provider.apiKeyParamName ?? 'Authorization';
  $<HTMLInputElement>('f-response-path').value = provider.responsePath ?? '';
  $<HTMLTextAreaElement>('f-body-template').value = provider.bodyTemplate ?? DEFAULT_CUSTOM_HTTP_BODY;

  applyTypeVisibility(provider.type);
  $<HTMLDivElement>('headers-error').classList.add('hidden');
  $<HTMLElement>('test-result').textContent = '';
}

function applyTypeVisibility(type: ProviderType): void {
  const isLLM = type === 'openai-compatible';
  for (const id of ['field-system-prompt', 'field-user-prompt', 'field-temperature', 'field-maxtokens']) {
    $<HTMLElement>(id).classList.toggle('hidden', !isLLM);
  }
  $<HTMLElement>('custom-http-fields').classList.toggle('hidden', isLLM);
}

/** Read the editor form back into the selected provider. Returns false on invalid headers. */
function collectEditor(): boolean {
  const provider = selectedProvider();
  if (!provider) return true;

  provider.name = $<HTMLInputElement>('f-name').value.trim() || provider.id;
  provider.type = $<HTMLSelectElement>('f-type').value as ProviderType;
  provider.baseUrl = $<HTMLInputElement>('f-baseurl').value.trim();
  provider.apiKey = $<HTMLInputElement>('f-apikey').value.trim();
  provider.model = $<HTMLInputElement>('f-model').value.trim();
  provider.sourceLanguage = $<HTMLInputElement>('f-source').value.trim();
  provider.targetLanguage = $<HTMLInputElement>('f-target').value.trim();
  provider.timeoutMs = num($<HTMLInputElement>('f-timeout').value, provider.timeoutMs);
  provider.maxBatchItems = Math.round(num($<HTMLInputElement>('f-batch-items').value, provider.maxBatchItems));
  provider.maxBatchChars = Math.round(num($<HTMLInputElement>('f-batch-chars').value, provider.maxBatchChars));
  provider.temperature = num($<HTMLInputElement>('f-temperature').value, provider.temperature);
  provider.maxTokens = Math.round(num($<HTMLInputElement>('f-maxtokens').value, provider.maxTokens));
  provider.systemPrompt = $<HTMLTextAreaElement>('f-system-prompt').value;
  provider.userPromptTemplate = $<HTMLTextAreaElement>('f-user-prompt').value;
  provider.enabled = $<HTMLInputElement>('f-enabled').checked;

  const headersError = $<HTMLDivElement>('headers-error');
  const headersRaw = $<HTMLTextAreaElement>('f-headers').value.trim();
  if (headersRaw === '') {
    provider.headers = {};
    headersError.classList.add('hidden');
  } else {
    try {
      const parsed: unknown = JSON.parse(headersRaw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('必须是 JSON 对象');
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        headers[k] = String(v);
      }
      provider.headers = headers;
      headersError.classList.add('hidden');
    } catch (e) {
      headersError.textContent = `请求头 JSON 无效：${e instanceof Error ? e.message : String(e)}`;
      headersError.classList.remove('hidden');
      return false;
    }
  }

  provider.method = $<HTMLSelectElement>('f-method').value as ProviderConfig['method'];
  provider.apiKeyPlacement = $<HTMLSelectElement>('f-key-placement').value as ProviderConfig['apiKeyPlacement'];
  provider.apiKeyParamName = $<HTMLInputElement>('f-key-name').value.trim();
  provider.responsePath = $<HTMLInputElement>('f-response-path').value.trim();
  provider.bodyTemplate = $<HTMLTextAreaElement>('f-body-template').value;

  applyTypeVisibility(provider.type);
  return true;
}

/* --------------------------------- actions ----------------------------------- */

async function persist(): Promise<boolean> {
  if (!draft) return false;
  collectGeneral();
  if (!collectEditor()) {
    toast('请修正表单中的错误', true);
    return false;
  }
  const normalized = normalizeSettings(draft);
  try {
    const res = await sendRuntime({ type: 'save-settings', settings: normalized });
    if (!res?.ok) {
      toast(`保存失败：${res?.error ?? '未知错误'}`, true);
      return false;
    }
  } catch (e) {
    toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, true);
    return false;
  }
  draft = normalized;
  selectedId = normalized.providers.some((p) => p.id === selectedId)
    ? selectedId
    : normalized.activeProviderId;
  clearDirty();
  renderAll();
  toast('设置已保存');
  return true;
}

async function testProvider(): Promise<void> {
  if (!collectEditor()) return;
  const provider = selectedProvider();
  if (!provider) return;
  const resultEl = $<HTMLElement>('test-result');
  resultEl.className = 'test-result';
  resultEl.textContent = '测试中…';
  try {
    const res = await sendRuntime({ type: 'test-provider', provider });
    if (res?.ok) {
      resultEl.textContent = `✓ 连接成功，示例译文：${res.result}`;
      resultEl.classList.add('ok');
    } else {
      resultEl.textContent = `✗ ${res?.error ?? '测试失败'}`;
      resultEl.classList.add('bad');
    }
  } catch (e) {
    resultEl.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
    resultEl.classList.add('bad');
  }
}

async function refreshCacheStats(): Promise<void> {
  try {
    const stats = await sendRuntime({ type: 'get-cache-stats' });
    $<HTMLElement>('cache-count').textContent = `当前缓存 ${stats.entries} 条`;
  } catch {
    $<HTMLElement>('cache-count').textContent = '无法读取缓存统计';
  }
}

async function refreshErrorLog(): Promise<void> {
  const box = $<HTMLDivElement>('error-log');
  box.textContent = '';
  try {
    const { entries } = await sendRuntime({ type: 'get-error-log' });
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = '暂无错误记录';
      box.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'log-entry';
      const time = new Date(entry.ts).toLocaleString();
      row.innerHTML = `<span class="log-meta">${time}</span><span class="log-kind">${entry.kind}</span><span>${entry.message}</span>`;
      box.appendChild(row);
    }
  } catch {
    box.textContent = '无法读取错误日志';
  }
}

function exportSettings(): void {
  if (!draft) return;
  collectGeneral();
  collectEditor();
  const payload = { app: 'polypage-web-translator', version: 1, exportedAt: new Date().toISOString(), settings: draft };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'polypage-settings.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importSettings(file: File): Promise<void> {
  try {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    const normalized = validateImportedSettings(parsed);
    if (!normalized) {
      toast('导入失败：文件格式无效或缺少必要配置', true);
      return;
    }
    await sendRuntime({ type: 'save-settings', settings: normalized });
    draft = normalized;
    selectedId = normalized.activeProviderId;
    renderAll();
    toast('配置已导入');
  } catch {
    toast('导入失败：无法解析 JSON 文件', true);
  }
}

async function renderShortcuts(): Promise<void> {
  const box = $<HTMLDivElement>('shortcut-list');
  box.textContent = '';
  try {
    const commands = await chrome.commands.getAll();
    for (const cmd of commands) {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const label = cmd.description || cmd.name;
      row.innerHTML = `<span>${label}</span><kbd>${cmd.shortcut || '未设置'}</kbd>`;
      box.appendChild(row);
    }
  } catch {
    box.textContent = '无法读取快捷键信息';
  }
}

/* ---------------------------------- wiring ----------------------------------- */

function renderAll(): void {
  renderGeneral();
  renderProviderList();
  renderEditor();
}

async function init(): Promise<void> {
  try {
    const { settings } = await sendRuntime({ type: 'get-full-settings' });
    draft = normalizeSettings(settings);
  } catch {
    toast('无法加载设置（后台未就绪），请刷新重试', true);
    return;
  }
  selectedId = draft.activeProviderId;
  renderAll();
  void refreshCacheStats();
  void refreshErrorLog();
  void renderShortcuts();

  $<HTMLButtonElement>('save').addEventListener('click', () => void persist());
  $<HTMLButtonElement>('add-openai').addEventListener('click', () => addProvider('openai-compatible'));
  $<HTMLButtonElement>('add-custom').addEventListener('click', () => addProvider('custom-http'));
  $<HTMLButtonElement>('test-provider').addEventListener('click', () => void testProvider());
  $<HTMLSelectElement>('f-type').addEventListener('change', () => {
    collectEditor();
    renderEditor();
    markDirty();
  });
  $<HTMLButtonElement>('clear-cache').addEventListener('click', async () => {
    await sendRuntime({ type: 'clear-cache' });
    toast('缓存已清空');
    void refreshCacheStats();
  });
  $<HTMLButtonElement>('refresh-log').addEventListener('click', () => void refreshErrorLog());
  $<HTMLButtonElement>('clear-log').addEventListener('click', async () => {
    await sendRuntime({ type: 'clear-error-log' });
    void refreshErrorLog();
  });
  $<HTMLButtonElement>('export').addEventListener('click', exportSettings);
  $<HTMLButtonElement>('import').addEventListener('click', () => $<HTMLInputElement>('import-file').click());
  $<HTMLInputElement>('import-file').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void importSettings(file);
    (e.target as HTMLInputElement).value = '';
  });

  // Any field edit marks the draft dirty.
  document.querySelector('.content')?.addEventListener('input', markDirty);
}

void init();
