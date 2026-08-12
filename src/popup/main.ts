/**
 * Popup UI (spec §10.3), evolved for 2.0:
 *  - six display modes (adds inline, spec 2.0 §7.2);
 *  - multi-frame aggregated state (spec 2.0 §6.2);
 *  - failover actual-provider hint (spec 2.0 §5.6);
 *  - selection-translate toggle (spec 2.0 §7.1);
 *  - bilingual export HTML/Markdown (spec 2.0 §7.5).
 */
import { sendRuntime, sendTabCommand } from '../messaging/messages';
import type { ExportEntry } from '../messaging/messages';
import type { DisplayMode, FrameStateEntry, PageState } from '../shared/types';
import { normalizeSettings } from '../storage/settings';

const MODE_META: Record<DisplayMode, { name: string; desc: string }> = {
  original: { name: '原文', desc: '显示原始内容' },
  translated: { name: '译文', desc: '正文替换为译文' },
  translated_hover_original: { name: '译文 + 悬停原文', desc: '悬停段落查看原文' },
  original_hover_translated: { name: '原文 + 悬停译文', desc: '悬停段落查看译文' },
  bilingual: { name: '双语对照', desc: '原文下方插入译文' },
  inline: { name: '段内对照', desc: '句内内联显示译文' },
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

let activeTabId: number | null = null;

async function resolveActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
}

interface Aggregated {
  state: PageState | null;
  frames: FrameStateEntry[];
  reachable: boolean;
}

/** Merge per-frame states; top frame drives mode/blacklist. */
function aggregate(frames: FrameStateEntry[]): PageState | null {
  if (frames.length === 0) return null;
  const top = frames.find((f) => f.state.isTopFrame) ?? frames[0];
  const merged: PageState = { ...top.state, frameUrl: undefined };
  if (frames.length > 1) {
    merged.total = 0;
    merged.translated = 0;
    merged.pending = 0;
    merged.failed = 0;
    for (const f of frames) {
      merged.total += f.state.total;
      merged.translated += f.state.translated;
      merged.pending += f.state.pending;
      merged.failed += f.state.failed;
      merged.active = merged.active || f.state.active;
      merged.mode = merged.mode ?? f.state.mode;
      merged.lastError = merged.lastError ?? f.state.lastError;
      merged.actualProvider = merged.actualProvider ?? f.state.actualProvider;
      merged.inlineDowngraded = merged.inlineDowngraded || f.state.inlineDowngraded;
      merged.viewportOnly = merged.viewportOnly || f.state.viewportOnly;
    }
  }
  return merged;
}

async function fetchAggregated(): Promise<Aggregated> {
  // Prefer the background's frame aggregation (2.0); fall back to a direct
  // content-script query (1.0 behavior) when nothing was reported yet.
  try {
    const res = await sendRuntime({ type: 'get-frame-states', ...(activeTabId !== null ? { tabId: activeTabId } : {}) });
    if (res.frames.length > 0) {
      return { state: aggregate(res.frames), frames: res.frames, reachable: true };
    }
  } catch {
    /* background busy — try direct */
  }
  if (activeTabId === null) return { state: null, frames: [], reachable: false };
  try {
    const state = await sendTabCommand(activeTabId, { type: 'wt:get-state' });
    return { state, frames: [{ frameId: 0, state }], reachable: true };
  } catch {
    return { state: null, frames: [], reachable: false };
  }
}

function renderAggregated(agg: Aggregated): void {
  const pill = $<HTMLSpanElement>('status-pill');
  const unsupported = $<HTMLDivElement>('unsupported');
  const blacklisted = $<HTMLDivElement>('blacklisted');
  const main = $<HTMLElement>('main');
  const state = agg.state;

  unsupported.classList.toggle('hidden', agg.reachable);
  blacklisted.classList.toggle('hidden', !(state?.blacklisted ?? false));
  main.style.opacity = agg.reachable && !state?.blacklisted ? '1' : '0.45';

  if (!state) {
    pill.textContent = '不可用';
    pill.className = 'pill';
  } else if (state.blacklisted) {
    pill.textContent = '黑名单';
    pill.className = 'pill';
  } else if (!state.active) {
    pill.textContent = '未翻译';
    pill.className = 'pill pill-idle';
  } else if (state.pending > 0) {
    pill.textContent = '翻译中…';
    pill.className = 'pill pill-working';
  } else if (state.failed > 0) {
    pill.textContent = state.translated > 0 ? '部分失败' : '翻译失败';
    pill.className = 'pill pill-error';
  } else {
    pill.textContent = '已翻译';
    pill.className = 'pill pill-active';
  }

  if (!state) return;

  $<HTMLElement>('info-progress').textContent = state.active
    ? `${state.translated}/${state.total}${state.pending > 0 ? `（进行中 ${state.pending}）` : ''}${state.failed > 0 ? `，失败 ${state.failed}` : ''}`
    : `共识别 ${state.total} 个段落`;

  const framesRow = $<HTMLDivElement>('row-frames');
  if (agg.frames.length > 1) {
    framesRow.classList.remove('hidden');
    $<HTMLElement>('info-frames').textContent = `${agg.frames.length} 个 frame`;
  } else {
    framesRow.classList.add('hidden');
  }

  const actualRow = $<HTMLDivElement>('row-actual');
  if (state.actualProvider) {
    actualRow.classList.remove('hidden');
    $<HTMLElement>('info-actual').textContent = state.actualProvider;
  } else {
    actualRow.classList.add('hidden');
  }

  const hints: string[] = [];
  if (state.viewportOnly) hints.push('已降级为仅视口翻译（页面条目过多）');
  if (state.inlineDowngraded) hints.push('部分段落超出段内对照预算，已降级为段落双语');
  const hintBox = $<HTMLDivElement>('info-hints');
  if (hints.length > 0) {
    hintBox.textContent = hints.join('；');
    hintBox.classList.remove('hidden');
  } else {
    hintBox.classList.add('hidden');
  }

  const errBox = $<HTMLDivElement>('info-error');
  if (state.lastError) {
    errBox.textContent = `最近错误：${state.lastError}`;
    errBox.classList.remove('hidden');
  } else {
    errBox.classList.add('hidden');
  }

  // Sync mode selection.
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((input) => {
    input.checked = input.value === (state.mode ?? 'original');
    input.closest('.mode-item')?.classList.toggle('selected', input.checked);
  });
}

function buildModeList(): void {
  const list = $<HTMLDivElement>('mode-list');
  const order: DisplayMode[] = [
    'bilingual',
    'inline',
    'translated',
    'translated_hover_original',
    'original_hover_translated',
    'original',
  ];
  for (const mode of order) {
    const meta = MODE_META[mode];
    const label = document.createElement('label');
    label.className = 'mode-item';
    label.innerHTML = `
      <input type="radio" name="mode" value="${mode}" />
      <span>
        <span class="mode-name">${meta.name}</span><br />
        <span class="mode-desc">${meta.desc}</span>
      </span>`;
    label.querySelector('input')!.addEventListener('change', () => {
      void applyMode(mode);
    });
    list.appendChild(label);
  }
}

async function applyMode(mode: DisplayMode): Promise<void> {
  if (activeTabId === null) return;
  try {
    await sendTabCommand(activeTabId, { type: 'wt:set-mode', mode });
  } catch {
    /* content unreachable; refresh() will reflect it */
  }
  await refresh();
}

async function command(type: 'wt:translate' | 'wt:restore' | 'wt:retry-failed' | 'wt:rescan'): Promise<void> {
  if (activeTabId === null) return;
  try {
    await sendTabCommand(activeTabId, { type });
  } catch {
    /* content unreachable; refresh() will reflect it */
  }
  // Give the content script a moment to start before polling state.
  setTimeout(() => void refresh(), 250);
}

async function refresh(): Promise<void> {
  const agg = await fetchAggregated();
  renderAggregated(agg);
}

async function loadSummary(): Promise<void> {
  try {
    const summary = await sendRuntime({ type: 'get-settings-summary' });
    $<HTMLElement>('info-provider').textContent = summary.providerConfigured
      ? summary.providerName
      : `${summary.providerName}（未配置）`;
    $<HTMLElement>('info-target').textContent = summary.targetLanguage;
    const toggle = $<HTMLInputElement>('toggle-selection');
    toggle.checked = summary.selectionTranslate !== 'off';
    if (!summary.providerConfigured) {
      const errBox = $<HTMLDivElement>('info-error');
      errBox.textContent = '尚未配置翻译服务，请先打开设置填写 API。';
      errBox.classList.remove('hidden');
    }
  } catch {
    // background not ready yet; state polling will still work
  }
}

async function toggleSelectionTranslate(enabled: boolean): Promise<void> {
  try {
    const { settings } = await sendRuntime({ type: 'get-full-settings' });
    const draft = normalizeSettings(settings);
    draft.selectionTranslate = enabled ? 'always' : 'off';
    await sendRuntime({ type: 'save-settings', settings: draft });
  } catch {
    /* background unavailable */
  }
}

/* --------------------------------- export ----------------------------------- */

function buildHtmlExport(title: string, entries: ExportEntry[]): string {
  const rows = entries
    .map((e) => {
      const tag = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote'].includes(e.tag)
        ? e.tag
        : 'p';
      const translation = e.translated ?? '（未翻译）';
      const escapedOriginal = escapeHtml(e.original);
      const escapedTranslation = escapeHtml(translation);
      return `<${tag}>${escapedOriginal}</${tag}>\n<div class="wt-export-dst">${escapedTranslation}</div>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)} — 双语导出</title>
<style>
body{font-family:system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 16px;line-height:1.7;}
.wt-export-dst{margin:-0.4em 0 1.2em;padding:0.15em 0.6em;border-left:3px solid #4f46e5;color:#3b3f51;background:#eef0ff;font-size:0.95em;white-space:pre-wrap;}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
${rows}
</body></html>`;
}

function buildMarkdownExport(title: string, entries: ExportEntry[]): string {
  const lines = [`# ${title}`, ''];
  for (const e of entries) {
    lines.push(e.original);
    const translation = e.translated ?? '（未翻译）';
    for (const part of translation.split('\n')) lines.push(`> ${part}`);
    lines.push('');
  }
  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportAs(format: 'html' | 'md'): Promise<void> {
  try {
    const res = await sendRuntime({ type: 'get-export-payload' });
    if (!res?.ok || !res.entries) {
      throw new Error(res?.error ?? '无法导出：页面未翻译或内容脚本不可用');
    }
    const title = res.title ?? 'page';
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'page';
    if (format === 'html') {
      download(`${safeTitle}.bilingual.html`, buildHtmlExport(title, res.entries), 'text/html;charset=utf-8');
    } else {
      download(`${safeTitle}.bilingual.md`, buildMarkdownExport(title, res.entries), 'text/markdown;charset=utf-8');
    }
  } catch (e) {
    const errBox = $<HTMLDivElement>('info-error');
    errBox.textContent = e instanceof Error ? e.message : String(e);
    errBox.classList.remove('hidden');
  }
}

/* ---------------------------------- main ------------------------------------- */

async function main(): Promise<void> {
  buildModeList();
  await resolveActiveTab();
  await Promise.all([refresh(), loadSummary()]);

  $<HTMLButtonElement>('btn-translate').addEventListener('click', () => void command('wt:translate'));
  $<HTMLButtonElement>('btn-restore').addEventListener('click', () => void command('wt:restore'));
  $<HTMLButtonElement>('btn-retry').addEventListener('click', () => void command('wt:retry-failed'));
  $<HTMLButtonElement>('btn-rescan').addEventListener('click', () => void command('wt:rescan'));
  $<HTMLButtonElement>('btn-export-html').addEventListener('click', () => void exportAs('html'));
  $<HTMLButtonElement>('btn-export-md').addEventListener('click', () => void exportAs('md'));
  $<HTMLInputElement>('toggle-selection').addEventListener('change', (e) => {
    void toggleSelectionTranslate((e.target as HTMLInputElement).checked);
  });
  $<HTMLAnchorElement>('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  setInterval(() => void refresh(), 1200);
}

void main();