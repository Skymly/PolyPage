/**
 * Selection translate (划词翻译, spec 2.0 §7.1), evolved for 3.0 §8.3:
 *
 *  - triggers on mouseup / keyup (Shift+arrow selection), 1-500 chars;
 *  - trigger strategy: always / hold-Alt / off (settings);
 *  - floating button at the selection end, expanding to a translation panel;
 *  - all UI lives inside a Shadow DOM host on <html> — never in page DOM;
 *  - reuses the background translate pipeline (single item + cache);
 *  - 3.0: speak button (speechSynthesis, target-language voice; Alt+click
 *    speaks the original), bad-translation mark button, and repeatLast()
 *    for the Alt+Q command (spec 3.0 §8.3).
 */
import { sendRuntime } from '../messaging/messages';
import { SELECTION_MAX_LEN, SELECTION_MIN_LEN } from '../shared/constants';
import type { SelectionTranslateMode } from '../shared/types';

const SEL_CSS = `
  .wt-sel-btn {
    display: none;
    position: absolute;
    width: 28px; height: 28px;
    border: none; border-radius: 50%;
    background: #2563eb; color: #fff;
    font: 600 13px/1 system-ui, sans-serif;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.35);
    pointer-events: auto;
    z-index: 2147483647;
  }
  .wt-sel-btn:hover { background: #1d4ed8; }
  .wt-sel-panel {
    display: none;
    position: absolute;
    max-width: 420px; min-width: 180px;
    background: #ffffff; color: #1f2937;
    border: 1px solid #d1d5db; border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,.22);
    font: 13px/1.6 system-ui, sans-serif;
    pointer-events: auto;
    z-index: 2147483647;
  }
  @media (prefers-color-scheme: dark) {
    .wt-sel-panel { background: #1f2937; color: #f3f4f6; border-color: #374151; }
    .wt-sel-actions button { background: #374151; color: #e5e7eb; }
  }
  .wt-sel-text { padding: 10px 12px 4px; white-space: pre-wrap; word-break: break-word; }
  .wt-sel-text.error { color: #dc2626; }
  .wt-sel-actions { display: flex; gap: 8px; padding: 8px 12px 10px; flex-wrap: wrap; }
  .wt-sel-actions button {
    border: none; border-radius: 6px; padding: 4px 10px;
    background: #e5e7eb; color: #111827; cursor: pointer; font-size: 12px;
  }
  .wt-sel-actions button:hover { background: #d1d5db; }
  .wt-sel-actions button:disabled { opacity: .5; cursor: default; }
`;

export class SelectionTranslator {
  private host: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private panel: HTMLElement | null = null;
  private textEl: HTMLElement | null = null;
  private speakBtn: HTMLButtonElement | null = null;
  private markBtn: HTMLButtonElement | null = null;
  private mode: SelectionTranslateMode = 'always';
  private currentSelectionText = '';
  /** Last completed result, replayed by Alt+Q (spec 3.0 §8.3 item 2). */
  private lastResult: { source: string; translated: string; language: string | null } | null =
    null;
  private lastPanelPos: { x: number; y: number } | null = null;
  private speakEnabled = false;
  private targetLanguage: string | null = null;

  setMode(mode: SelectionTranslateMode): void {
    this.mode = mode;
    if (mode === 'off') this.hideAll();
  }

  /** 3.0: speak availability comes from settings + capability probe. */
  setSpeak(enabled: boolean): void {
    this.speakEnabled = enabled && typeof window.speechSynthesis !== 'undefined';
    if (this.speakBtn) this.speakBtn.disabled = !this.speakEnabled;
  }

  start(): void {
    document.addEventListener('mouseup', this.onMouseUp, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    document.addEventListener('mousedown', this.onMouseDown, true);
    window.addEventListener('scroll', this.onScrollResize, true);
    window.addEventListener('resize', this.onScrollResize);
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  destroy(): void {
    document.removeEventListener('mouseup', this.onMouseUp, true);
    document.removeEventListener('keyup', this.onKeyUp, true);
    document.removeEventListener('mousedown', this.onMouseDown, true);
    window.removeEventListener('scroll', this.onScrollResize, true);
    window.removeEventListener('resize', this.onScrollResize);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.host?.remove();
    this.host = null;
  }

  /* --------------------------------- triggers --------------------------------- */

  private onMouseUp = (e: MouseEvent): void => {
    if (this.mode === 'off') return;
    // Clicks inside our own UI are handled separately.
    const target = e.target as Node | null;
    if (target && this.host && this.host.contains(target)) return;
    const requireAlt = this.mode === 'alt';
    if (requireAlt && !e.altKey) {
      this.hideAll();
      return;
    }
    // Let the browser finalize the selection first.
    window.setTimeout(() => this.checkSelection(), 0);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.mode === 'off') return;
    const isShiftNav = e.shiftKey && e.key.startsWith('Arrow');
    if (!isShiftNav) return;
    if (this.mode === 'alt' && !e.altKey) return;
    window.setTimeout(() => this.checkSelection(), 0);
  };

  private onMouseDown = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (target && this.host && this.host.contains(target)) return;
    this.hideAll();
  };

  private onScrollResize = (): void => {
    this.hideAll();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.hideAll();
  };

  /** Context menu / command entry: translate whatever is selected now. */
  translateCurrentSelection(): boolean {
    const text = this.readSelection();
    if (!text) return false;
    this.currentSelectionText = text;
    this.ensureHost();
    this.positionAtSelection();
    this.showPanel('翻译中…', false);
    void this.translate(text);
    return true;
  }

  /**
   * Alt+Q (spec 3.0 §8.3 item 2): repeat the previous selection translate.
   * With a live selection it translates it; without one it replays the
   * last result panel.
   */
  repeatLast(): boolean {
    const text = this.readSelection();
    if (text) return this.translateCurrentSelection();
    if (!this.lastResult) return false;
    this.ensureHost();
    if (this.lastPanelPos && this.host) {
      this.host.style.transform = `translate(${this.lastPanelPos.x}px, ${this.lastPanelPos.y}px)`;
    } else {
      this.host!.style.transform = `translate(${Math.round(window.innerWidth / 2 - 160)}px, 90px)`;
    }
    this.showPanel(this.lastResult.translated, false);
    return true;
  }

  private checkSelection(): void {
    const text = this.readSelection();
    if (!text) {
      this.hideAll();
      return;
    }
    this.currentSelectionText = text;
    this.ensureHost();
    this.positionAtSelection();
    this.showButton();
  }

  private readSelection(): string | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().trim();
    if (text.length < SELECTION_MIN_LEN || text.length > SELECTION_MAX_LEN) return null;
    return text;
  }

  /* ------------------------------------ UI ------------------------------------ */

  private ensureHost(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.className = 'wt-selection-host';
    host.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SEL_CSS;
    const button = document.createElement('button');
    button.className = 'wt-sel-btn';
    button.textContent = '译';
    button.title = '翻译选中文字 (PolyPage)';
    const panel = document.createElement('div');
    panel.className = 'wt-sel-panel';
    const textEl = document.createElement('div');
    textEl.className = 'wt-sel-text';
    const actions = document.createElement('div');
    actions.className = 'wt-sel-actions';
    const speakBtn = document.createElement('button');
    speakBtn.textContent = '朗读';
    speakBtn.title = '朗读译文（Alt+点击朗读原文）';
    const markBtn = document.createElement('button');
    markBtn.textContent = '标记坏句';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '收起';
    actions.append(speakBtn, markBtn, copyBtn, closeBtn);
    panel.append(textEl, actions);
    shadow.append(style, button, panel);
    document.documentElement.appendChild(host);

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showPanel('翻译中…', false);
      void this.translate(this.currentSelectionText);
    });
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void navigator.clipboard?.writeText(textEl.textContent ?? '').then(() => {
        copyBtn.textContent = '已复制';
        window.setTimeout(() => (copyBtn.textContent = '复制'), 1200);
      });
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hideAll();
    });
    speakBtn.disabled = !this.speakEnabled;
    speakBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Alt+click speaks the original text (spec 3.0 §8.3 item 1).
      const useOriginal = e.altKey;
      const text = useOriginal ? this.currentSelectionText : (textEl.textContent ?? '');
      if (useOriginal || (!e.altKey && !textEl.classList.contains('error'))) {
        this.speak(text, useOriginal ? null : this.targetLanguage);
      }
    });
    markBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const translated = textEl.classList.contains('error') ? '' : (textEl.textContent ?? '');
      if (translated === '' || translated === '翻译中…') return;
      void sendRuntime({
        type: 'mark-feedback',
        source: this.currentSelectionText,
        translation: translated,
        pageUrl: location.href,
        where: 'selection',
      }).then(() => {
        markBtn.textContent = '已标记 ✓';
        window.setTimeout(() => (markBtn.textContent = '标记坏句'), 1200);
      });
    });

    this.host = host;
    this.button = button;
    this.panel = panel;
    this.textEl = textEl;
    this.speakBtn = speakBtn;
    this.markBtn = markBtn;
  }

  private positionAtSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !this.host) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    this.host.style.transform = `translate(${Math.round(rect.right + scrollX)}px, ${Math.round(rect.bottom + scrollY + 6)}px)`;
    this.lastPanelPos = {
      x: Math.round(rect.right + scrollX),
      y: Math.round(rect.bottom + scrollY + 6),
    };
  }

  private showButton(): void {
    if (!this.button || !this.panel) return;
    this.panel.style.display = 'none';
    this.button.style.display = 'block';
    this.button.style.transform = 'translate(-28px, 0)';
  }

  private showPanel(text: string, isError: boolean): void {
    if (!this.button || !this.panel || !this.textEl) return;
    this.button.style.display = 'none';
    this.panel.style.display = 'block';
    this.panel.style.transform = 'translate(-100%, 0)';
    this.textEl.textContent = text;
    this.textEl.classList.toggle('error', isError);
    if (this.markBtn) this.markBtn.style.display = isError ? 'none' : '';
    if (this.speakBtn) {
      const speakable = !isError && text !== '翻译中…';
      this.speakBtn.disabled = !this.speakEnabled || !speakable;
    }
  }

  private hideAll(): void {
    if (this.button) this.button.style.display = 'none';
    if (this.panel) this.panel.style.display = 'none';
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
  }

  /* --------------------------------- speaking --------------------------------- */

  private speak(text: string, language: string | null): void {
    if (typeof window.speechSynthesis === 'undefined' || text.trim() === '') return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      if (language) utterance.lang = language;
      const voices = window.speechSynthesis.getVoices();
      if (language && voices.length > 0) {
        const prefix = language.split('-')[0].toLowerCase();
        const match =
          voices.find((v) => v.lang.toLowerCase() === language.toLowerCase()) ??
          voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
        if (match) utterance.voice = match;
      }
      window.speechSynthesis.speak(utterance);
    } catch {
      // Voice missing or engine busy — capability probe keeps button honest.
    }
  }

  /* -------------------------------- translation ------------------------------- */

  private async translate(text: string): Promise<void> {
    try {
      const res = await sendRuntime({
        type: 'translate-selection',
        text,
        domain: location.hostname,
      });
      if (res?.ok && res.translated !== undefined) {
        this.targetLanguage = res.language ?? null;
        this.lastResult = { source: text, translated: res.translated, language: res.language ?? null };
        this.showPanel(res.translated, false);
      } else {
        this.showPanel(`翻译失败：${res?.error ?? '未知错误'}`, true);
      }
    } catch (e) {
      this.showPanel(`翻译失败：${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
}