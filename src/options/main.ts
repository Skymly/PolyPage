/**
 * Options page (spec §10.4), evolved for 2.0:
 *  - provider presets + six provider types with per-type fields;
 *  - failover chain editor (spec 2.0 §5.6);
 *  - glossary editor with paste import (spec 2.0 §7.4);
 *  - site rules editor with JSON preview + import/export (spec 2.0 §6.4);
 *  - native host (gateway) status probe (spec 2.0 §5.5);
 *  - per-provider stats + error log filtering (spec 2.0 §8.3).
 */
import { sendRuntime } from '../messaging/messages';
import { DEFAULT_CUSTOM_HTTP_BODY, DEFAULT_NATIVE_HOST_NAME, defaultProvider } from '../shared/constants';
import { formatPackMegabytes } from '../ocr/packs';
import type { PdfLayoutPreset } from '../shared/types';
import { normalizeSiteRule } from '../shared/siteRules';
import type {
  DisplayMode,
  GlossaryEntry,
  ProviderConfig,
  ProviderStats,
  ProviderType,
  SelectionTranslateMode,
  Settings,
  SiteRule,
} from '../shared/types';
import { PROVIDER_PRESETS, findPreset, presetToProvider } from '../providers/presets';
import { normalizeSettings, validateImportedSettings } from '../storage/settings';
import { minimaxHostHint } from '../shared/sanitize';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

let draft: Settings | null = null;
let selectedId: string | null = null;
let editingRuleId: string | null = null;
let logFilterProvider = '';

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

function newProviderId(): string {
  return `provider-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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
  $<HTMLSelectElement>('selection-translate').value = draft.selectionTranslate;
  $<HTMLSelectElement>('language-detect').value = draft.languageDetection;
  $<HTMLInputElement>('selection-speak').checked = draft.selectionSpeak;
  $<HTMLInputElement>('default-source').value = draft.defaultSourceLanguage;
  $<HTMLInputElement>('default-target').value = draft.defaultTargetLanguage;
  $<HTMLInputElement>('min-text-length').value = String(draft.minTextLength);
  $<HTMLInputElement>('inline-budget').value = String(draft.inlineBudget);
  $<HTMLInputElement>('viewport-budget').value = String(draft.viewportBudget);
  $<HTMLTextAreaElement>('blacklist-input').value = draft.blacklist.join('\n');
  const sanitize = draft.outputSanitize;
  $<HTMLInputElement>('sanitize-enabled').checked = sanitize.enabled;
  $<HTMLInputElement>('sanitize-think').checked = sanitize.stripThink;
  $<HTMLInputElement>('sanitize-fences').checked = sanitize.stripCodeFences;
}

function collectGeneral(): void {
  if (!draft) return;
  draft.defaultDisplayMode = $<HTMLSelectElement>('default-mode').value as DisplayMode;
  draft.autoTranslate = $<HTMLInputElement>('auto-translate').checked;
  draft.cacheEnabled = $<HTMLInputElement>('cache-enabled').checked;
  draft.selectionTranslate = $<HTMLSelectElement>('selection-translate')
    .value as SelectionTranslateMode;
  draft.languageDetection = $<HTMLSelectElement>('language-detect').value === 'off' ? 'off' : 'auto';
  draft.selectionSpeak = $<HTMLInputElement>('selection-speak').checked;
  draft.defaultSourceLanguage = $<HTMLInputElement>('default-source').value.trim() || 'auto';
  draft.defaultTargetLanguage = $<HTMLInputElement>('default-target').value.trim() || '简体中文';
  draft.minTextLength = Math.round(num($<HTMLInputElement>('min-text-length').value, draft.minTextLength));
  draft.inlineBudget = Math.round(num($<HTMLInputElement>('inline-budget').value, draft.inlineBudget));
  draft.viewportBudget = Math.round(num($<HTMLInputElement>('viewport-budget').value, draft.viewportBudget));
  draft.blacklist = $<HTMLTextAreaElement>('blacklist-input')
    .value.split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  draft.outputSanitize = {
    enabled: $<HTMLInputElement>('sanitize-enabled').checked,
    stripThink: $<HTMLInputElement>('sanitize-think').checked,
    stripCodeFences: $<HTMLInputElement>('sanitize-fences').checked,
  };
}

/* --------------------------- 3.0 media sections ------------------------------ */

function renderMediaSections(): void {
  if (!draft) return;
  $<HTMLInputElement>('pdf-enabled').checked = draft.pdfViewer.enabled;
  $<HTMLSelectElement>('pdf-mode').value = draft.pdfViewer.defaultMode;
  $<HTMLInputElement>('pdf-skip-hf').checked = draft.pdfViewer.skipHeadersFooters;
  $<HTMLInputElement>('pdf-concurrency').value = String(draft.pdfViewer.maxConcurrentPages);
  $<HTMLInputElement>('pdf-autoopen').checked = draft.pdfViewer.autoOpen;
  $<HTMLInputElement>('pdf-scanned-ocr').checked = draft.pdfViewer.scannedPageOcr;
  $<HTMLSelectElement>('pdf-layout').value = draft.pdfViewer.layoutPreset ?? 'auto';
  $<HTMLInputElement>('img-enabled').checked = draft.imageTranslate.enabled;
  $<HTMLSelectElement>('img-trigger').value = draft.imageTranslate.trigger;
  $<HTMLSelectElement>('img-engine').value = draft.imageTranslate.engine;
  $<HTMLInputElement>('img-maxedge').value = String(draft.imageTranslate.maxEdgePx);
  $<HTMLInputElement>('img-overlay').checked = draft.imageOverlay.enabled;
  $<HTMLInputElement>('sub-enabled').checked = draft.subtitles.enabled;
  $<HTMLSelectElement>('sub-bilingual').value = draft.subtitles.bilingual;
  $<HTMLInputElement>('sub-font').value = String(draft.subtitles.fontSizePct);
  $<HTMLInputElement>('sub-swap').checked = draft.subtitles.swapSrcDst;
  $<HTMLSelectElement>('sub-position').value = draft.subtitles.position;
  const bgPresets = ['rgba(0,0,0,.62)', 'rgba(0,0,0,.85)', 'rgba(0,0,0,.35)', 'transparent'];
  if (bgPresets.includes(draft.subtitles.background)) {
    $<HTMLSelectElement>('sub-bg').value = draft.subtitles.background;
    $<HTMLInputElement>('sub-bg-custom').value = '';
  } else {
    $<HTMLSelectElement>('sub-bg').value = 'custom';
    $<HTMLInputElement>('sub-bg-custom').value = draft.subtitles.background;
  }
  $<HTMLInputElement>('asr-enabled').checked = draft.asr.enabled;
  $<HTMLInputElement>('asr-maxsec').value = String(draft.asr.maxSeconds);
  $<HTMLInputElement>('asr-confirm-full').checked = draft.asr.confirmFull;
  $<HTMLInputElement>('asr-streaming').checked = draft.asr.streaming;
  $<HTMLInputElement>('tm-enabled').checked = draft.translationMemory.enabled;
  $<HTMLInputElement>('tm-max').value = String(draft.translationMemory.maxEntries);
  void refreshPdfPermStatus();
}

function collectMediaSections(): void {
  if (!draft) return;
  draft.pdfViewer = {
    ...draft.pdfViewer,
    enabled: $<HTMLInputElement>('pdf-enabled').checked,
    defaultMode:
      $<HTMLSelectElement>('pdf-mode').value === 'translated_hover_original'
        ? 'translated_hover_original'
        : 'bilingual',
    skipHeadersFooters: $<HTMLInputElement>('pdf-skip-hf').checked,
    maxConcurrentPages: Math.round(num($<HTMLInputElement>('pdf-concurrency').value, draft.pdfViewer.maxConcurrentPages)),
    autoOpen: $<HTMLInputElement>('pdf-autoopen').checked,
    scannedPageOcr: $<HTMLInputElement>('pdf-scanned-ocr').checked,
    layoutPreset: ((): PdfLayoutPreset => {
      const v = $<HTMLSelectElement>('pdf-layout').value;
      return v === 'single' || v === 'columns' || v === 'table' ? v : 'auto';
    })(),
  };
  draft.imageTranslate = {
    ...draft.imageTranslate,
    enabled: $<HTMLInputElement>('img-enabled').checked,
    trigger: (() => {
      const v = $<HTMLSelectElement>('img-trigger').value;
      return v === 'contextMenu' || v === 'hoverButton' ? v : 'both';
    })(),
    engine: $<HTMLSelectElement>('img-engine').value === 'tesseract-wasm' ? 'tesseract-wasm' : 'llm-vision',
    maxEdgePx: Math.round(num($<HTMLInputElement>('img-maxedge').value, draft.imageTranslate.maxEdgePx)),
  };
  draft.imageOverlay = { enabled: $<HTMLInputElement>('img-overlay').checked };
  draft.subtitles = {
    ...draft.subtitles,
    enabled: $<HTMLInputElement>('sub-enabled').checked,
    bilingual: (() => {
      const v = $<HTMLSelectElement>('sub-bilingual').value;
      return v === 'src' || v === 'dst' ? v : 'both';
    })(),
    fontSizePct: Math.round(num($<HTMLInputElement>('sub-font').value, draft.subtitles.fontSizePct)),
    swapSrcDst: $<HTMLInputElement>('sub-swap').checked,
    position: $<HTMLSelectElement>('sub-position').value === 'top' ? 'top' : 'bottom',
    background: (() => {
      const preset = $<HTMLSelectElement>('sub-bg').value;
      if (preset === 'custom') {
        const custom = $<HTMLInputElement>('sub-bg-custom').value.trim();
        return custom !== '' ? custom : draft.subtitles.background;
      }
      return preset;
    })(),
  };
  draft.asr = {
    ...draft.asr,
    enabled: $<HTMLInputElement>('asr-enabled').checked,
    maxSeconds: Math.round(num($<HTMLInputElement>('asr-maxsec').value, draft.asr.maxSeconds)),
    confirmFull: $<HTMLInputElement>('asr-confirm-full').checked,
    streaming: $<HTMLInputElement>('asr-streaming').checked,
  };
  draft.translationMemory = {
    enabled: $<HTMLInputElement>('tm-enabled').checked,
    maxEntries: Math.round(num($<HTMLInputElement>('tm-max').value, draft.translationMemory.maxEntries)),
  };
}

async function refreshPdfPermStatus(): Promise<void> {
  const el = $<HTMLElement>('pdf-perm-status');
  try {
    const granted = await chrome.permissions.contains({ permissions: ['webNavigation'] });
    el.textContent = granted ? '（webNavigation 权限已授予）' : '（尚未授予 webNavigation 权限）';
  } catch {
    el.textContent = '';
  }
}

async function onAutoOpenChange(enabled: boolean): Promise<void> {
  if (!enabled) return;
  try {
    const granted = await chrome.permissions.request({ permissions: ['webNavigation'] });
    if (!granted) {
      $<HTMLInputElement>('pdf-autoopen').checked = false;
      toast('未授予 webNavigation 权限，自动打开保持关闭', true);
    } else {
      toast('已授予 webNavigation 权限');
    }
    void refreshPdfPermStatus();
  } catch {
    $<HTMLInputElement>('pdf-autoopen').checked = false;
  }
}

/* ------------------------------ feedback log (3.0) --------------------------- */

async function renderFeedbackLog(): Promise<void> {
  const box = $<HTMLDivElement>('feedback-list');
  box.textContent = '';
  try {
    const res = await sendRuntime({ type: 'get-feedback-log' });
    const entries = res.entries ?? [];
    if (entries.length === 0) {
      box.textContent = '暂无反馈记录。在双语块 / 字幕 / PDF 块 / 划词面板悬停可「标记坏句」。';
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'log-row';
      const time = new Date(entry.ts).toLocaleString();
      const del = document.createElement('button');
      del.className = 'btn btn-small';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        await sendRuntime({ type: 'delete-feedback-entry', ts: entry.ts });
        void renderFeedbackLog();
      });
      const head = document.createElement('div');
      head.innerHTML = `<span class="log-time">${time}</span> <span class="log-provider">[${entry.providerName ?? '?'} / ${entry.where}]</span>`;
      head.appendChild(del);
      const body = document.createElement('div');
      body.textContent = `原文：${entry.source}\n译文：${entry.translation}\n页面：${entry.pageUrl}`;
      body.style.whiteSpace = 'pre-wrap';
      row.append(head, body);
      box.appendChild(row);
    }
  } catch {
    box.textContent = '无法读取反馈日志';
  }
}

function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportFeedback(format: 'csv' | 'json'): Promise<void> {
  try {
    const res = await sendRuntime({ type: 'get-feedback-log' });
    const entries = res.entries ?? [];
    if (entries.length === 0) {
      toast('反馈日志为空', true);
      return;
    }
    if (format === 'json') {
      downloadText('polypage-feedback.json', JSON.stringify(entries, null, 2), 'application/json');
      return;
    }
    const csvEscape = (value: string): string =>
      /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    const header = 'ts,source,translation,provider,pageUrl,where';
    const rows = entries.map((e) =>
      [
        new Date(e.ts).toISOString(),
        csvEscape(e.source),
        csvEscape(e.translation),
        csvEscape(e.providerName ?? ''),
        csvEscape(e.pageUrl),
        csvEscape(e.where),
      ].join(','),
    );
    downloadText('polypage-feedback.csv', [header, ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  } catch (e) {
    toast(`导出失败：${e instanceof Error ? e.message : String(e)}`, true);
  }
}

/* ------------------------------ provider list -------------------------------- */

let statsCache: Record<string, ProviderStats> = {};

async function refreshStats(): Promise<void> {
  try {
    const res = await sendRuntime({ type: 'get-provider-stats' });
    statsCache = res.stats ?? {};
  } catch {
    statsCache = {};
  }
}

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

    // Sliding-window stats (session only, spec 2.0 §8.3).
    const stats = statsCache[provider.id];
    if (stats && stats.calls > 0) {
      const stat = document.createElement('span');
      stat.className = 'stats-badge';
      const rate = Math.round((stats.ok / stats.calls) * 100);
      stat.textContent = `${stats.ok}/${stats.calls} · ${stats.avgMs}ms`;
      stat.title = `近 ${stats.calls} 次请求成功率 ${rate}%${stats.lastError ? `；最近错误：${stats.lastError}` : ''}`;
      row.appendChild(stat);
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
  draft.providers = draft.providers.filter((p) => p.id !== id);
  draft.failoverChain = draft.failoverChain.filter((fid) => fid !== id);
  for (const p of draft.providers) {
    if (p.fallbackProviderId === id) p.fallbackProviderId = '';
  }
  if (draft.providers.length === 0) {
    const fresh = makeProvider('openai-compatible');
    draft.providers.push(fresh);
  }
  if (draft.activeProviderId === id) draft.activeProviderId = draft.providers[0].id;
  if (selectedId === id) selectedId = draft.providers[0].id;
  markDirty();
  renderProviderList();
  renderEditor();
  renderFailover();
}
function makeProvider(type: ProviderType): ProviderConfig {
  const base = defaultProvider();
  const provider: ProviderConfig = {
    ...base,
    id: newProviderId(),
    name:
      type === 'openai-compatible'
        ? 'OpenAI-compatible'
        : type === 'custom-http'
          ? '自定义 HTTP API'
          : type,
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
    provider.systemPrompt = '';
    provider.userPromptTemplate = '';
  }
  if (type === 'native-host') {
    provider.baseUrl = '';
    provider.model = '';
    provider.hostName = DEFAULT_NATIVE_HOST_NAME;
    provider.backend = '';
    provider.fallbackProviderId = '';
    provider.systemPrompt = '';
    provider.userPromptTemplate = '';
  }
  if (type === 'deepl' || type === 'azure-translator' || type === 'google-translate') {
    provider.systemPrompt = '';
    provider.userPromptTemplate = '';
    provider.maxBatchItems = 50;
    provider.maxBatchChars = 20000;
  }
  if (type === 'deepl') provider.baseUrl = 'https://api-free.deepl.com';
  if (type === 'azure-translator') provider.baseUrl = 'https://api.cognitive.microsofttranslator.com';
  if (type === 'google-translate') provider.baseUrl = 'https://translation.googleapis.com/language/translate/v2';
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

function addProviderFromPreset(presetId: string): void {
  if (!draft) return;
  const preset = findPreset(presetId);
  if (!preset) return;
  const provider = presetToProvider(preset, newProviderId());
  draft.providers.push(provider);
  selectedId = provider.id;
  markDirty();
  renderProviderList();
  renderEditor();
  toast(`已从预设「${preset.name}」创建${preset.needsApiKey ? '，请填写 API Key 后保存' : ''}`);
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
  $<HTMLTextAreaElement>('f-headers').value =
    JSON.stringify(provider.headers, null, 2) === '{}'
      ? ''
      : JSON.stringify(provider.headers, null, 2);
  $<HTMLInputElement>('f-enabled').checked = provider.enabled;

  $<HTMLSelectElement>('f-method').value = provider.method ?? 'POST';
  $<HTMLSelectElement>('f-key-placement').value = provider.apiKeyPlacement ?? 'header';
  $<HTMLInputElement>('f-key-name').value = provider.apiKeyParamName ?? 'Authorization';
  $<HTMLInputElement>('f-response-path').value = provider.responsePath ?? '';
  $<HTMLTextAreaElement>('f-body-template').value = provider.bodyTemplate ?? DEFAULT_CUSTOM_HTTP_BODY;

  $<HTMLSelectElement>('f-formality').value = provider.formality ?? 'default';
  $<HTMLInputElement>('f-region').value = provider.region ?? '';
  $<HTMLInputElement>('f-hostname').value = provider.hostName ?? DEFAULT_NATIVE_HOST_NAME;
  $<HTMLInputElement>('f-backend').value = provider.backend ?? '';

  // Fallback provider select (native-host only).
  const fallback = $<HTMLSelectElement>('f-fallback');
  fallback.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '（无回退）';
  fallback.appendChild(none);
  for (const p of draft?.providers ?? []) {
    if (p.id === provider.id) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    fallback.appendChild(opt);
  }
  fallback.value = provider.fallbackProviderId ?? '';
  if (fallback.value !== (provider.fallbackProviderId ?? '')) fallback.value = '';

  applyTypeVisibility(provider.type);
  $<HTMLDivElement>('headers-error').classList.add('hidden');
  $<HTMLElement>('test-result').textContent = '';
  refreshMinimaxHint();
}

function refreshMinimaxHint(): void {
  const el = document.getElementById('minimax-host-hint');
  if (!el) return;
  const baseUrl = $<HTMLInputElement>('f-baseurl').value;
  const apiKey = $<HTMLInputElement>('f-apikey').value;
  const hint = minimaxHostHint(baseUrl, apiKey);
  if (hint) {
    el.hidden = false;
    el.textContent = hint;
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

function applyTypeVisibility(type: ProviderType): void {
  const isLLM = type === 'openai-compatible';
  const isHttpApi = type === 'deepl' || type === 'azure-translator' || type === 'google-translate';
  const isNative = type === 'native-host';
  for (const id of ['field-system-prompt', 'field-user-prompt', 'field-temperature', 'field-maxtokens']) {
    $<HTMLElement>(id).classList.toggle('hidden', !isLLM);
  }
  $<HTMLElement>('field-baseurl').classList.toggle('hidden', isNative);
  $<HTMLElement>('field-apikey').classList.toggle('hidden', isNative);
  $<HTMLElement>('field-model').classList.toggle('hidden', isHttpApi || isNative);
  $<HTMLElement>('custom-http-fields').classList.toggle('hidden', type !== 'custom-http');
  $<HTMLElement>('deepl-fields').classList.toggle('hidden', type !== 'deepl');
  $<HTMLElement>('azure-fields').classList.toggle('hidden', type !== 'azure-translator');
  $<HTMLElement>('native-host-fields').classList.toggle('hidden', !isNative);
}

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
  provider.apiKeyPlacement = $<HTMLSelectElement>('f-key-placement')
    .value as ProviderConfig['apiKeyPlacement'];
  provider.apiKeyParamName = $<HTMLInputElement>('f-key-name').value.trim();
  provider.responsePath = $<HTMLInputElement>('f-response-path').value.trim();
  provider.bodyTemplate = $<HTMLTextAreaElement>('f-body-template').value;

  provider.formality = $<HTMLSelectElement>('f-formality').value as ProviderConfig['formality'];
  provider.region = $<HTMLInputElement>('f-region').value.trim();
  provider.hostName = $<HTMLInputElement>('f-hostname').value.trim() || DEFAULT_NATIVE_HOST_NAME;
  provider.backend = $<HTMLInputElement>('f-backend').value.trim();
  provider.fallbackProviderId = $<HTMLSelectElement>('f-fallback').value;

  applyTypeVisibility(provider.type);
  return true;
}
/* -------------------------------- failover ----------------------------------- */

function renderFailover(): void {
  if (!draft) return;
  const list = $<HTMLDivElement>('failover-list');
  list.textContent = '';
  if (draft.failoverChain.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '链条为空：活动服务失败时不进行故障转移（native-host 的专属回退仍生效）。';
    list.appendChild(empty);
  }
  draft.failoverChain.forEach((id, index) => {
    const provider = draft!.providers.find((p) => p.id === id);
    const row = document.createElement('div');
    row.className = 'failover-row';
    const label = document.createElement('span');
    label.textContent = `${index + 1}. ${provider?.name ?? id}`;
    row.appendChild(label);
    const up = document.createElement('button');
    up.className = 'icon-btn';
    up.textContent = '↑';
    up.disabled = index === 0;
    up.addEventListener('click', () => {
      const chain = draft!.failoverChain;
      [chain[index - 1], chain[index]] = [chain[index], chain[index - 1]];
      markDirty();
      renderFailover();
    });
    const down = document.createElement('button');
    down.className = 'icon-btn';
    down.textContent = '↓';
    down.disabled = index === draft!.failoverChain.length - 1;
    down.addEventListener('click', () => {
      const chain = draft!.failoverChain;
      [chain[index + 1], chain[index]] = [chain[index], chain[index + 1]];
      markDirty();
      renderFailover();
    });
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      draft!.failoverChain.splice(index, 1);
      markDirty();
      renderFailover();
    });
    row.append(up, down, del);
    list.appendChild(row);
  });

  const select = $<HTMLSelectElement>('failover-select');
  select.textContent = '';
  for (const p of draft.providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
}

function addToFailover(): void {
  if (!draft) return;
  const id = $<HTMLSelectElement>('failover-select').value;
  if (!id || draft.failoverChain.includes(id)) return;
  draft.failoverChain.push(id);
  markDirty();
  renderFailover();
}

/* -------------------------------- glossary ----------------------------------- */

function bumpGlossaryVersion(): void {
  if (!draft) return;
  draft.glossaryVersion += 1;
  renderGlossary();
}

function renderGlossary(): void {
  if (!draft) return;
  const list = $<HTMLDivElement>('glossary-list');
  list.textContent = '';
  if (draft.glossary.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '暂无术语。术语将以「原文 = 译文」注入 System Prompt。';
    list.appendChild(empty);
  }
  draft.glossary.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'glossary-row';
    const source = document.createElement('input');
    source.type = 'text';
    source.value = entry.source;
    source.placeholder = '原文';
    source.addEventListener('input', () => {
      draft!.glossary[index].source = source.value;
      markDirty();
    });
    source.addEventListener('change', bumpGlossaryVersion);
    const eq = document.createElement('span');
    eq.textContent = '=';
    const target = document.createElement('input');
    target.type = 'text';
    target.value = entry.target;
    target.placeholder = '译文';
    target.addEventListener('input', () => {
      draft!.glossary[index].target = target.value;
      markDirty();
    });
    target.addEventListener('change', bumpGlossaryVersion);
    const note = document.createElement('input');
    note.type = 'text';
    note.value = entry.note ?? '';
    note.placeholder = '备注（可选）';
    note.addEventListener('input', () => {
      const value = note.value.trim();
      if (value === '') delete draft!.glossary[index].note;
      else draft!.glossary[index].note = value;
      markDirty();
    });
    note.addEventListener('change', bumpGlossaryVersion);
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      draft!.glossary.splice(index, 1);
      markDirty();
      bumpGlossaryVersion();
    });
    row.append(source, eq, target, note, del);
    list.appendChild(row);
  });
  $<HTMLElement>('glossary-version').textContent = `术语表版本：v${draft.glossaryVersion}`;
}

function addGlossaryEntry(): void {
  if (!draft) return;
  draft.glossary.push({ source: '', target: '' });
  markDirty();
  renderGlossary();
}

function importPastedGlossary(): void {
  if (!draft) return;
  const raw = $<HTMLTextAreaElement>('glossary-paste').value;
  let added = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.includes('=')) continue;
    const [sourcePart, ...rest] = trimmed.split('=');
    let targetPart = rest.join('=').trim();
    const source = sourcePart.trim();
    let note: string | undefined;
    const noteMatch = targetPart.match(/^(.*?)\s*[（(](.*)[)）]\s*$/);
    if (noteMatch) {
      targetPart = noteMatch[1].trim();
      note = noteMatch[2].trim();
    }
    if (source === '' || targetPart === '') continue;
    const entry: GlossaryEntry = { source, target: targetPart };
    if (note) entry.note = note;
    draft.glossary.push(entry);
    added++;
  }
  $<HTMLTextAreaElement>('glossary-paste').value = '';
  if (added > 0) {
    markDirty();
    bumpGlossaryVersion();
    toast(`已导入 ${added} 条术语（保存后生效）`);
  } else {
    toast('未解析到任何「原文 = 译文」行', true);
  }
}

/* -------------------------------- site rules --------------------------------- */

function renderRules(): void {
  if (!draft) return;
  const list = $<HTMLDivElement>('rule-list');
  list.textContent = '';
  if (draft.siteRules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '暂无站点规则。';
    list.appendChild(empty);
  }
  for (const rule of draft.siteRules) {
    const row = document.createElement('div');
    row.className = 'rule-row';

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = rule.enabled !== false;
    enabled.title = '启用/停用';
    enabled.addEventListener('change', () => {
      rule.enabled = enabled.checked;
      markDirty();
    });

    const summary = document.createElement('span');
    summary.className = 'rule-summary';
    const bits: string[] = [];
    if (rule.defaultMode) bits.push(`模式:${rule.defaultMode}`);
    if (typeof rule.minTextLength === 'number') bits.push(`长度≥${rule.minTextLength}`);
    if (rule.viewportOnly) bits.push('仅视口');
    if ((rule.includeSelectors ?? []).length > 0) bits.push(`include:${rule.includeSelectors!.length}`);
    if ((rule.excludeSelectors ?? []).length > 0) bits.push(`exclude:${rule.excludeSelectors!.length}`);
    const builtin = rule.id.startsWith('builtin-') ? '（内置）' : '';
    summary.textContent = `${rule.match.join(', ')}${builtin}${bits.length > 0 ? ` — ${bits.join('，')}` : ''}`;

    const edit = document.createElement('button');
    edit.className = 'icon-btn';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => openRuleEditor(rule.id));
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      if (!draft) return;
      draft.siteRules = draft.siteRules.filter((r) => r.id !== rule.id);
      markDirty();
      renderRules();
    });

    row.append(enabled, summary, edit, del);
    list.appendChild(row);
  }
}

function openRuleEditor(ruleId: string | null): void {
  if (!draft) return;
  editingRuleId = ruleId;
  const rule = ruleId ? draft.siteRules.find((r) => r.id === ruleId) : null;
  $<HTMLElement>('rule-editor-title').textContent = rule ? '编辑规则' : '新增规则';
  $<HTMLInputElement>('r-match').value = rule?.match.join(', ') ?? '';
  $<HTMLInputElement>('r-include').value = (rule?.includeSelectors ?? []).join(', ');
  $<HTMLInputElement>('r-exclude').value = (rule?.excludeSelectors ?? []).join(', ');
  $<HTMLInputElement>('r-minlen').value = rule?.minTextLength !== undefined ? String(rule.minTextLength) : '';
  $<HTMLSelectElement>('r-mode').value = rule?.defaultMode ?? '';
  $<HTMLInputElement>('r-viewport').checked = rule?.viewportOnly === true;
  $<HTMLInputElement>('r-enabled').checked = rule?.enabled !== false;
  updateRulePreview();
  $<HTMLDivElement>('rule-editor').classList.remove('hidden');
}

function buildRuleFromEditor(): SiteRule | null {
  const match = $<HTMLInputElement>('r-match')
    .value.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const raw: Partial<SiteRule> = {
    id: editingRuleId ?? `rule-${Date.now().toString(36)}`,
    match,
    enabled: $<HTMLInputElement>('r-enabled').checked,
  };
  const include = $<HTMLInputElement>('r-include').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (include.length > 0) raw.includeSelectors = include;
  const exclude = $<HTMLInputElement>('r-exclude').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (exclude.length > 0) raw.excludeSelectors = exclude;
  const minLen = $<HTMLInputElement>('r-minlen').value;
  if (minLen.trim() !== '') raw.minTextLength = num(minLen, 6);
  const mode = $<HTMLSelectElement>('r-mode').value;
  if (mode !== '') raw.defaultMode = mode as DisplayMode;
  if ($<HTMLInputElement>('r-viewport').checked) raw.viewportOnly = true;
  return normalizeSiteRule(raw, raw.id as string);
}

function updateRulePreview(): void {
  const rule = buildRuleFromEditor();
  $<HTMLPreElement>('rule-json').textContent = rule
    ? JSON.stringify(rule, null, 2)
    : '（无效：match 域名不能为空）';
}

function saveRuleFromEditor(): void {
  if (!draft) return;
  const rule = buildRuleFromEditor();
  if (!rule) {
    toast('规则无效：match 域名不能为空', true);
    return;
  }
  const index = draft.siteRules.findIndex((r) => r.id === rule.id);
  if (index >= 0) draft.siteRules[index] = rule;
  else draft.siteRules.push(rule);
  markDirty();
  renderRules();
  $<HTMLDivElement>('rule-editor').classList.add('hidden');
  editingRuleId = null;
  toast('规则已应用到草稿，保存全部设置后生效');
}

function exportRules(): void {
  if (!draft) return;
  const payload = {
    app: 'polypage-site-rules',
    version: 2,
    exportedAt: new Date().toISOString(),
    rules: draft.siteRules,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'polypage-site-rules.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importRules(file: File): Promise<void> {
  if (!draft) return;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    const rawRules = Array.isArray(parsed)
      ? parsed
      : (parsed as { rules?: unknown[] })?.rules;
    if (!Array.isArray(rawRules)) throw new Error('缺少 rules 数组');
    let added = 0;
    for (const raw of rawRules) {
      const rule = normalizeSiteRule(raw, `rule-import-${Date.now().toString(36)}-${added}`);
      if (!rule) continue;
      if (draft.siteRules.some((r) => r.id === rule.id)) continue;
      draft.siteRules.push(rule);
      added++;
    }
    markDirty();
    renderRules();
    toast(`已导入 ${added} 条规则（保存后生效）`);
  } catch (e) {
    toast(`规则导入失败：${e instanceof Error ? e.message : String(e)}`, true);
  }
}

/* -------------------------------- gateway UI --------------------------------- */

async function checkHostStatus(): Promise<void> {
  const statusEl = $<HTMLElement>('host-status');
  const backendsEl = $<HTMLElement>('host-backends');
  statusEl.className = 'test-result';
  statusEl.textContent = '检测中…';
  backendsEl.textContent = '';
  try {
    const res = await sendRuntime({ type: 'host-status' });
    const compat = document.getElementById('compat-status');
    if (res.installed) {
      const proto = typeof res.protocol === 'number' ? ` protocol ${res.protocol}` : '';
      statusEl.textContent = `✓ 网关已连接${res.version ? `（版本 ${res.version}${proto}）` : proto}`;
      statusEl.classList.add('ok');
      if (compat) compat.textContent = res.browser === 'firefox' ? 'Firefox：connectNative ping 成功。' : 'Chromium：connectNative ping 成功。';
    } else {
      statusEl.textContent = `✗ 未检测到网关：${res.reason ?? res.error ?? '未知错误'}`;
      statusEl.classList.add('bad');
      backendsEl.textContent =
        '安装方法：运行 native-host 发布的 PolyPage.Gateway.exe --install（无需管理员），' +
        '开发态可用 --allow chrome-extension://<扩展ID>/ 追加允许来源。Firefox 需 allowed_extensions 含 polypage@skymly.com。';
      if (compat) compat.textContent = res.reason ?? '本地网关未连接，将走 failover。';
    }
  } catch (e) {
    statusEl.textContent = `✗ ${e instanceof Error ? e.message : String(e)}`;
    statusEl.classList.add('bad');
  }
}

async function refreshTmStats(): Promise<void> {
  const el = document.getElementById('tm-stats');
  if (!el) return;
  try {
    const stats = await sendRuntime({ type: 'tm-stats' });
    el.textContent = `当前 ${stats.entries} 条，累计命中 ${stats.hits}，本会话 ${stats.sessionHits}`;
  } catch {
    el.textContent = '无法读取句子记忆统计';
  }
}

async function renderOcrPacks(): Promise<void> {
  const box = document.getElementById('ocr-pack-list');
  if (!box) return;
  let packs: Array<{ id: string; name: string; bytes: number; status: string; received?: number; error?: string; bundled?: boolean }> = [];
  try {
    const res = await sendRuntime({ type: 'ocr-pack-progress' });
    packs = res.packs ?? [];
  } catch {
    box.textContent = '无法读取语言包状态';
    return;
  }
  box.textContent = '';
  for (const pack of packs) {
    const row = document.createElement('div');
    row.className = 'ocr-pack-row';
    const label = document.createElement('div');
    const size = pack.bundled ? '内置' : formatPackMegabytes(pack.bytes);
    label.textContent = `${pack.name} (${pack.id}) · ${size} · ${pack.status}`;
    if (pack.error) label.textContent += ` — ${pack.error}`;
    if (pack.status === 'downloading' && pack.received != null) {
      label.textContent += ` ${pack.received}/${pack.bytes}`;
    }
    row.append(label);
    if (!pack.bundled) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.type = 'button';
      if (pack.status === 'ready') {
        btn.textContent = '删除';
        btn.addEventListener('click', () => {
          void sendRuntime({ type: 'ocr-pack-remove', lang: pack.id }).then(() => void renderOcrPacks());
        });
      } else {
        btn.textContent = pack.status === 'error' ? '重试下载' : '下载';
        btn.addEventListener('click', () => {
          const ok = window.confirm(`将下载第三方 OCR 数据（${pack.name}），约 ${formatPackMegabytes(pack.bytes)}。继续？`);
          if (!ok) return;
          btn.disabled = true;
          void sendRuntime({ type: 'ocr-pack-download', lang: pack.id }).then((res) => {
            if (!res.ok) toast(res.error ?? '下载失败', true);
            void renderOcrPacks();
          });
        });
      }
      row.append(btn);
    }
    box.append(row);
  }
}

/* --------------------------------- actions ----------------------------------- */

async function persist(): Promise<boolean> {
  if (!draft) return false;
  collectGeneral();
  collectMediaSections();
  if (!collectEditor()) {
    toast('请修正表单中的错误', true);
    return false;
  }
  // Drop glossary rows that are still empty.
  draft.glossary = draft.glossary.filter((g) => g.source.trim() !== '' && g.target.trim() !== '');
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
      const latency = typeof res.latencyMs === 'number' ? `（${res.latencyMs}ms）` : '';
      resultEl.textContent = `✓ 连接成功${latency}，示例译文：${res.result}`;
      resultEl.classList.add('ok');
      await refreshStats();
      renderProviderList();
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

let logEntriesCache: { providerId?: string }[] = [];

function renderLogFilter(): void {
  const select = $<HTMLSelectElement>('log-filter');
  select.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部 Provider';
  select.appendChild(all);
  const ids = new Set<string>();
  for (const entry of logEntriesCache) {
    if (entry.providerId) ids.add(entry.providerId);
  }
  for (const id of ids) {
    const provider = draft?.providers.find((p) => p.id === id);
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = provider?.name ?? id;
    select.appendChild(opt);
  }
  select.value = logFilterProvider;
  if (select.value !== logFilterProvider) {
    logFilterProvider = '';
    select.value = '';
  }
}

async function refreshErrorLog(): Promise<void> {
  const box = $<HTMLDivElement>('error-log');
  box.textContent = '';
  try {
    const { entries } = await sendRuntime({ type: 'get-error-log' });
    logEntriesCache = entries;
    renderLogFilter();
    const filtered = logFilterProvider
      ? entries.filter((e) => e.providerId === logFilterProvider)
      : entries;
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = logFilterProvider ? '该 Provider 暂无错误记录' : '暂无错误记录';
      box.appendChild(empty);
      return;
    }
    for (const entry of filtered) {
      const row = document.createElement('div');
      row.className = 'log-entry';
      const time = new Date(entry.ts).toLocaleString();
      const provider = entry.providerId
        ? (draft?.providers.find((p) => p.id === entry.providerId)?.name ?? entry.providerId)
        : '';
      row.innerHTML = `<span class="log-meta">${time}</span><span class="log-kind">${entry.kind}</span>${
        provider ? `<span class="log-provider">[${provider}]</span>` : ''
      }<span>${entry.message}</span>`;
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
  const payload = { app: 'polypage-web-translator', version: 5, exportedAt: new Date().toISOString(), settings: draft };
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
    toast('配置已导入（旧版本配置会自动迁移；不含 TM 表）');
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

function renderPresets(): void {
  const select = $<HTMLSelectElement>('preset-select');
  select.textContent = '';
  for (const preset of PROVIDER_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = `${preset.name} — ${preset.description}`;
    select.appendChild(opt);
  }
}

/* ---------------------------------- wiring ----------------------------------- */

function renderAll(): void {
  renderGeneral();
  renderMediaSections();
  renderProviderList();
  renderEditor();
  renderFailover();
  renderGlossary();
  renderRules();
  void refreshTmStats();
  void renderOcrPacks();
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
  renderPresets();
  await refreshStats();
  renderAll();
  void refreshCacheStats();
  void refreshErrorLog();
  void renderShortcuts();

  $<HTMLButtonElement>('save').addEventListener('click', () => void persist());
  $<HTMLButtonElement>('add-openai').addEventListener('click', () => addProvider('openai-compatible'));
  $<HTMLButtonElement>('add-custom').addEventListener('click', () => addProvider('custom-http'));
  $<HTMLButtonElement>('add-native').addEventListener('click', () => addProvider('native-host'));
  $<HTMLButtonElement>('add-from-preset').addEventListener('click', () =>
    addProviderFromPreset($<HTMLSelectElement>('preset-select').value),
  );
  $<HTMLButtonElement>('test-provider').addEventListener('click', () => void testProvider());
  $<HTMLSelectElement>('f-type').addEventListener('change', () => {
    collectEditor();
    renderEditor();
    markDirty();
  });
  $<HTMLButtonElement>('failover-add').addEventListener('click', addToFailover);
  $<HTMLButtonElement>('glossary-add').addEventListener('click', addGlossaryEntry);
  $<HTMLButtonElement>('glossary-import').addEventListener('click', importPastedGlossary);
  $<HTMLButtonElement>('rule-add').addEventListener('click', () => openRuleEditor(null));
  $<HTMLButtonElement>('rule-save').addEventListener('click', saveRuleFromEditor);
  $<HTMLButtonElement>('rule-cancel').addEventListener('click', () => {
    $<HTMLDivElement>('rule-editor').classList.add('hidden');
    editingRuleId = null;
  });
  $<HTMLButtonElement>('rule-export').addEventListener('click', exportRules);
  $<HTMLButtonElement>('rule-import').addEventListener('click', () =>
    $<HTMLInputElement>('rule-import-file').click(),
  );
  $<HTMLInputElement>('rule-import-file').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void importRules(file);
    (e.target as HTMLInputElement).value = '';
  });
  for (const id of ['r-match', 'r-include', 'r-exclude', 'r-minlen', 'r-mode', 'r-viewport', 'r-enabled']) {
    document.getElementById(id)?.addEventListener('input', updateRulePreview);
  }
  $<HTMLButtonElement>('host-check').addEventListener('click', () => void checkHostStatus());
  $<HTMLButtonElement>('tm-clear').addEventListener('click', async () => {
    if (!window.confirm('确定清空句子记忆？此操作不可恢复，且不影响翻译缓存。')) return;
    await sendRuntime({ type: 'tm-clear' });
    void refreshTmStats();
    toast('句子记忆已清空');
  });
  $<HTMLButtonElement>('clear-cache').addEventListener('click', async () => {
    await sendRuntime({ type: 'clear-cache' });
    toast('缓存已清空');
    void refreshCacheStats();
  });
  $<HTMLButtonElement>('refresh-log').addEventListener('click', () => void refreshErrorLog());
  $<HTMLSelectElement>('log-filter').addEventListener('change', (e) => {
    logFilterProvider = (e.target as HTMLSelectElement).value;
    void refreshErrorLog();
  });
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

  /* 3.0 wiring: media sections + feedback log. */
  $<HTMLInputElement>('pdf-autoopen').addEventListener('change', (e) => {
    void onAutoOpenChange((e.target as HTMLInputElement).checked);
  });
  $<HTMLButtonElement>('feedback-refresh').addEventListener('click', () => void renderFeedbackLog());
  $<HTMLButtonElement>('feedback-export-csv').addEventListener('click', () => void exportFeedback('csv'));
  $<HTMLButtonElement>('feedback-export-json').addEventListener('click', () => void exportFeedback('json'));
  $<HTMLButtonElement>('feedback-clear').addEventListener('click', async () => {
    await sendRuntime({ type: 'clear-feedback-log' });
    void renderFeedbackLog();
    toast('反馈日志已清空');
  });
  void renderFeedbackLog();

  // Any field edit marks the draft dirty.
  document.querySelector('.content')?.addEventListener('input', markDirty);
  $('f-baseurl').addEventListener('input', refreshMinimaxHint);
  $('f-apikey').addEventListener('input', refreshMinimaxHint);
}

void init();