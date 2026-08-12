/**
 * Popup UI (spec §10.3): translate/restore, display-mode switching,
 * page status, active provider + target language, error summary.
 */
import { sendRuntime, sendTabCommand } from '../messaging/messages';
import type { DisplayMode, PageState } from '../shared/types';

const MODE_META: Record<DisplayMode, { name: string; desc: string }> = {
  original: { name: '原文', desc: '显示原始内容' },
  translated: { name: '译文', desc: '正文替换为译文' },
  translated_hover_original: { name: '译文 + 悬停原文', desc: '悬停段落查看原文' },
  original_hover_translated: { name: '原文 + 悬停译文', desc: '悬停段落查看译文' },
  bilingual: { name: '双语对照', desc: '原文下方插入译文' },
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

let activeTabId: number | null = null;
let contentReachable = false;
let currentState: PageState | null = null;

async function resolveActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
}

async function fetchState(): Promise<PageState | null> {
  if (activeTabId === null) return null;
  try {
    const state = await sendTabCommand(activeTabId, { type: 'wt:get-state' });
    contentReachable = true;
    return state;
  } catch {
    contentReachable = false;
    return null;
  }
}

function renderState(state: PageState | null): void {
  const pill = $<HTMLSpanElement>('status-pill');
  const unsupported = $<HTMLDivElement>('unsupported');
  const blacklisted = $<HTMLDivElement>('blacklisted');
  const main = $<HTMLElement>('main');

  unsupported.classList.toggle('hidden', contentReachable);
  blacklisted.classList.toggle('hidden', !(state?.blacklisted ?? false));
  main.style.opacity = contentReachable && !state?.blacklisted ? '1' : '0.45';

  if (!state) {
    pill.textContent = '不可用';
    pill.className = 'pill';
    return;
  }
  if (state.blacklisted) {
    pill.textContent = '黑名单';
    pill.className = 'pill';
    return;
  }
  if (!state.active) {
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

  $<HTMLElement>('info-progress').textContent = state.active
    ? `${state.translated}/${state.total}${state.pending > 0 ? `（进行中 ${state.pending}）` : ''}${state.failed > 0 ? `，失败 ${state.failed}` : ''}`
    : `共识别 ${state.total} 个段落`;

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
    contentReachable = false;
  }
  await refresh();
}

async function command(type: 'wt:translate' | 'wt:restore' | 'wt:retry-failed' | 'wt:rescan'): Promise<void> {
  if (activeTabId === null) return;
  try {
    switch (type) {
      case 'wt:translate':
        await sendTabCommand(activeTabId, { type: 'wt:translate' });
        break;
      case 'wt:restore':
        await sendTabCommand(activeTabId, { type: 'wt:restore' });
        break;
      case 'wt:retry-failed':
        await sendTabCommand(activeTabId, { type: 'wt:retry-failed' });
        break;
      case 'wt:rescan':
        await sendTabCommand(activeTabId, { type: 'wt:rescan' });
        break;
    }
  } catch {
    contentReachable = false;
  }
  // Give the content script a moment to start before polling state.
  setTimeout(() => void refresh(), 250);
}

async function refresh(): Promise<void> {
  currentState = await fetchState();
  renderState(currentState);
}

async function loadSummary(): Promise<void> {
  try {
    const summary = await sendRuntime({ type: 'get-settings-summary' });
    $<HTMLElement>('info-provider').textContent = summary.providerConfigured
      ? summary.providerName
      : `${summary.providerName}（未配置）`;
    $<HTMLElement>('info-target').textContent = summary.targetLanguage;
    if (!summary.providerConfigured) {
      const errBox = $<HTMLDivElement>('info-error');
      errBox.textContent = '尚未配置翻译服务，请先打开设置填写 API。';
      errBox.classList.remove('hidden');
    }
  } catch {
    // background not ready yet; state polling will still work
  }
}

async function main(): Promise<void> {
  buildModeList();
  await resolveActiveTab();
  await Promise.all([refresh(), loadSummary()]);

  $<HTMLButtonElement>('btn-translate').addEventListener('click', () => void command('wt:translate'));
  $<HTMLButtonElement>('btn-restore').addEventListener('click', () => void command('wt:restore'));
  $<HTMLButtonElement>('btn-retry').addEventListener('click', () => void command('wt:retry-failed'));
  $<HTMLButtonElement>('btn-rescan').addEventListener('click', () => void command('wt:rescan'));
  $<HTMLAnchorElement>('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  setInterval(() => void refresh(), 1200);
}

void main();
