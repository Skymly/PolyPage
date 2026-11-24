import { sendRuntime } from '../messaging/messages';
import { applyDraft, draftEditor, draftIntact, draftPreview, snapshotDraft, type DraftEditor } from './draftEditor';

const STYLE = `
  :host { all:initial; position:fixed; z-index:2147483647; font:13px/1.5 system-ui,sans-serif; color:#202534; }
  :host([hidden]) { display:none; }
  .panel { box-sizing:border-box; width:max-content; max-width:min(360px,calc(100vw - 16px));
    background:#fff; border:1px solid #b7bfce; border-radius:9px; padding:5px;
    box-shadow:0 3px 15px #18203330; }
  output { display:block; padding:6px 7px; max-height:28vh; overflow:auto; white-space:pre-wrap;
    overflow-wrap:anywhere; }
  output:empty { display:none; }
  button { color:#23344f; background:#fff; border:0; border-radius:5px; font:inherit; padding:4px 8px;
    cursor:pointer; }
  button:hover,button:focus-visible { background:#e8efff; }
  button:disabled { color:#697383; cursor:default; }
`;

type Action = [label: string, run: () => void];

export class DraftTranslator {
  private editor: DraftEditor | null = null;
  private host: HTMLElement | null = null;
  private target = '英语';
  private active = false;
  private composing = false;
  private revision = 0;
  private hasResultOrRequest = false;
  private applying = false;
  private undoReplacement: (() => boolean) | null = null;

  configure(enabled: boolean, target: string): void {
    if (this.target !== target) {
      this.target = target;
      this.clear();
    }
    if (this.active === enabled) return;
    this.active = enabled;
    const method = enabled ? 'addEventListener' : 'removeEventListener';
    document[method]('focusin', this.onTarget, true);
    document[method]('pointerdown', this.onTarget, true);
    document[method]('input', this.onInput, true);
    document[method]('compositionstart', this.onComposition, true);
    document[method]('compositionend', this.onComposition, true);
    document[method]('keydown', this.onKey, true);
    window[method]('scroll', this.position, true);
    window[method]('resize', this.position);
    if (!enabled) this.clear();
    else this.focus(draftEditor(document.activeElement));
  }

  private clear(): void {
    this.revision++;
    this.hasResultOrRequest = false;
    this.undoReplacement = null;
    this.editor = null;
    this.composing = false;
    this.host?.remove();
    this.host = null;
  }

  private focus(editor: DraftEditor | null): void {
    if (editor === this.editor) return;
    this.clear();
    this.editor = editor;
    if (editor) this.ready();
  }

  private onTarget = (e: Event): void => {
    if (this.host && e.composedPath().includes(this.host)) return;
    this.focus(draftEditor(e.composedPath()[0]));
  };

  private onComposition = (e: Event): void => {
    if (!this.editor || !e.composedPath().includes(this.editor)) return;
    this.composing = e.type === 'compositionstart';
    this.revision++;
    this.ready();
  };

  private onInput = (e: Event): void => {
    if (this.applying || !this.hasResultOrRequest || !this.editor || !e.composedPath().includes(this.editor)) return;
    this.revision++;
    this.ready('草稿已更新，可重新预览。');
  };

  private onKey = (e: Event): void => {
    const event = e as KeyboardEvent;
    if (!this.editor || !event.isTrusted) return;
    if (event.key === 'Escape') this.clear();
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z' &&
        !event.isComposing && !this.composing && this.undoReplacement?.()) {
      event.preventDefault();
      return;
    }
    if (event.altKey && event.shiftKey && event.key === 'Enter' &&
        !event.isComposing && !this.composing && !event.repeat) {
      event.preventDefault();
      void this.translate();
    }
  };

  private position = (): void => {
    if (!this.host || !this.editor) return;
    const r = this.editor.getBoundingClientRect();
    const host = this.host;
    host.hidden = !this.editor.isConnected || r.bottom < 0 || r.top > innerHeight ||
      r.right < 0 || r.left > innerWidth;
    const x = Math.max(4, Math.min(r.right - host.offsetWidth, innerWidth - host.offsetWidth - 4));
    const below = r.bottom + 4;
    const y = below + host.offsetHeight <= innerHeight ? below : Math.max(4, r.top - host.offsetHeight - 4);
    host.style.left = x + 'px';
    host.style.top = y + 'px';
  };

  private ready(message = ''): void {
    this.hasResultOrRequest = false;
    this.undoReplacement = null;
    this.render(message, [[`预览翻译 · ${this.target}`, () => void this.translate()]]);
  }

  private render(message: string, actions: Action[]): void {
    if (!this.host) {
      const host = document.createElement('div');
      host.className = 'wt-draft-host';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = STYLE;
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', 'PolyPage 输入框翻译');
      shadow.append(style, panel);
      document.documentElement.append(host);
      this.host = host;
    }
    const panel = this.host.shadowRoot!.querySelector('.panel')!;
    const output = document.createElement('output');
    output.setAttribute('aria-live', 'polite');
    output.textContent = message;
    panel.replaceChildren(output);
    for (const [label, run] of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (label.startsWith('预览翻译')) button.title = '翻译选区或整份草稿（Alt+Shift+Enter）';
      button.disabled = this.composing;
      button.addEventListener('mousedown', e => e.preventDefault());
      button.addEventListener('click', e => { if (e.isTrusted) run(); });
      panel.append(button);
    }
    this.position();
  }

  private async translate(): Promise<void> {
    const editor = this.editor;
    if (!editor || this.composing || draftEditor(editor) !== editor) return;
    const snap = snapshotDraft(editor);
    if (!snap.edits.length) {
      this.ready('选区或草稿里没有可翻译的正文。引用和代码会保留。');
      return;
    }
    const revision = ++this.revision;
    this.undoReplacement = null;
    const close: Action = ['关闭', () => this.clear()];
    this.hasResultOrRequest = true;
    this.render(`正在翻译为${this.target}…`, [close]);
    try {
      const res = await sendRuntime({
        type: 'translate-draft', texts: snap.edits.map(e => e.source), domain: location.hostname,
      });
      if (revision !== this.revision) return;
      if (!draftIntact(snap)) return this.ready('草稿已更新，可重新预览。');
      const translations = snap.edits.map((_, i) => {
        if (!res?.results?.[i]?.trim()) throw new Error(res?.errors?.[i]?.message ?? '服务未返回译文');
        return res.results[i];
      });
      const apply = (): void => {
        this.applying = true;
        try {
          const undo = applyDraft(snap, translations);
          if (!undo) return this.ready('编辑器已更新或阻止替换，可重新预览。');
          this.undoReplacement = () => {
            this.applying = true;
            try {
              const restored = undo();
              this.ready(restored ? '已还原草稿。' : '草稿已更新，保留了最新内容。');
              return restored;
            }
            finally { this.applying = false; }
          };
          this.render('已替换', [['撤销替换', this.undoReplacement], close]);
        } finally { this.applying = false; }
      };
      this.render(draftPreview(snap, translations), [[snap.selected ? '替换选区' : '替换草稿', apply], close]);
    } catch (error) {
      if (revision === this.revision) this.ready(`翻译失败，草稿已保留。\n${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
