/**
 * Image OCR result panel (spec 3.0 §6.3): a Shadow DOM floating panel built
 * on the same isolation discipline as the selection panel — nothing enters
 * the page DOM, page CSS never reaches it.
 *
 * States: loading skeleton -> segments list | error with reason. Cancel
 * button aborts the in-flight OCR request via AbortController semantics.
 */

const PANEL_CSS = `
:host { all: initial; }
.wt-ocr-host { position: fixed; z-index: 2147483647; font-family: system-ui, -apple-system, sans-serif; }
.wt-ocr-panel {
  width: 340px; max-height: 420px; overflow: auto;
  background: #ffffff; color: #1f2430;
  border: 1px solid #d8dce6; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.22);
  font-size: 13px; line-height: 1.55;
}
.wt-ocr-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; border-bottom: 1px solid #eceff5; position: sticky; top: 0;
  background: #f7f8fb; font-weight: 600;
}
.wt-ocr-head .wt-ocr-actions button { margin-left: 6px; }
.wt-ocr-body { padding: 8px 10px; }
.wt-ocr-seg { padding: 6px 0; border-bottom: 1px dashed #eceff5; }
.wt-ocr-seg:last-child { border-bottom: none; }
.wt-ocr-src { color: #6b7280; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.wt-ocr-dst { color: #111827; white-space: pre-wrap; word-break: break-word; }
.wt-ocr-copy { cursor: pointer; border: 1px solid #d8dce6; background: #fff; border-radius: 4px; font-size: 11px; padding: 0 6px; margin-top: 2px; color: #4b5563; }
.wt-ocr-copy:hover { background: #eef2ff; }
.wt-ocr-skel { color: #6b7280; padding: 10px 0; }
.wt-ocr-error { color: #b91c1c; padding: 8px 0; }
button { cursor: pointer; border: none; background: transparent; font-size: 12px; color: #4b5563; }
button:hover { color: #111827; }
`;

export interface OcrPanelCallbacks {
  onCancel(): void;
  onClose(): void;
}

export class OcrResultPanel {
  private host: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private callbacks: OcrPanelCallbacks | null = null;

  private ensureHost(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.className = 'wt-ocr-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    const panel = document.createElement('div');
    panel.className = 'wt-ocr-panel';
    const head = document.createElement('div');
    head.className = 'wt-ocr-head';
    const title = document.createElement('span');
    title.textContent = '图片文字翻译';
    const actions = document.createElement('span');
    actions.className = 'wt-ocr-actions';
    const copyAll = document.createElement('button');
    copyAll.className = 'wt-ocr-copyall';
    copyAll.textContent = '复制全部';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '收起';
    actions.append(copyAll, closeBtn);
    head.append(title, actions);
    const body = document.createElement('div');
    body.className = 'wt-ocr-body';
    panel.append(head, body);
    shadow.append(style, panel);
    document.documentElement.appendChild(host);

    copyAll.addEventListener('click', (e) => {
      e.stopPropagation();
      const segs = [...body.querySelectorAll('.wt-ocr-seg')].map((seg) => {
        const src = seg.querySelector('.wt-ocr-src')?.textContent ?? '';
        const dst = seg.querySelector('.wt-ocr-dst')?.textContent ?? '';
        return `${src} -> ${dst}`;
      });
      void navigator.clipboard?.writeText(segs.join('\n')).then(() => {
        copyAll.textContent = '已复制';
        window.setTimeout(() => (copyAll.textContent = '复制全部'), 1200);
      });
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
      this.callbacks?.onClose();
    });

    this.host = host;
    this.body = body;
    this.titleEl = title;
  }

  /** Position near a source element (image) or at viewport center. */
  showLoading(near?: Element): void {
    this.ensureHost();
    const host = this.host!;
    host.style.cssText =
      'position:fixed;top:0;left:0;z-index:2147483647;';
    let left = Math.max(16, (window.innerWidth - 340) / 2);
    let top = 90;
    if (near) {
      const rect = near.getBoundingClientRect();
      left = Math.min(Math.max(rect.right + 12, 16), window.innerWidth - 356);
      top = Math.min(Math.max(rect.top, 16), window.innerHeight - 200);
    }
    host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    const body = this.body!;
    body.innerHTML = '';
    const skel = document.createElement('div');
    skel.className = 'wt-ocr-skel';
    skel.textContent = '正在识别并翻译图片文字…';
    const cancel = document.createElement('button');
    cancel.className = 'wt-ocr-copy';
    cancel.textContent = '取消';
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks?.onCancel();
    });
    body.append(skel, cancel);
  }

  setCallbacks(callbacks: OcrPanelCallbacks): void {
    this.callbacks = callbacks;
  }

  showSegments(segments: { text: string; translation: string }[]): void {
    this.ensureHost();
    const body = this.body!;
    body.innerHTML = '';
    const ocrOnly = segments.length > 0 && segments.every((s) => s.translation.trim() === '');
    if (this.titleEl) this.titleEl.textContent = ocrOnly ? '仅识别' : '图片文字翻译';
    if (segments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wt-ocr-skel';
      empty.textContent = '未识别到文字';
      body.append(empty);
      return;
    }
    for (const seg of segments) {
      const row = document.createElement('div');
      row.className = 'wt-ocr-seg';
      const src = document.createElement('div');
      src.className = 'wt-ocr-src';
      src.textContent = seg.text;
      const dst = document.createElement('div');
      dst.className = 'wt-ocr-dst';
      dst.textContent = seg.translation || '（无译文）';
      const copy = document.createElement('button');
      copy.className = 'wt-ocr-copy';
      copy.textContent = '复制';
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(`${seg.text} -> ${seg.translation}`).then(() => {
          copy.textContent = '已复制';
          window.setTimeout(() => (copy.textContent = '复制'), 1200);
        });
      });
      row.append(src, dst, copy);
      body.append(row);
    }
  }

  showError(message: string): void {
    this.ensureHost();
    const body = this.body!;
    body.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'wt-ocr-error';
    err.textContent = `图片翻译失败：${message}`;
    body.append(err);
  }

  hide(): void {
    this.host?.remove();
    this.host = null;
    this.body = null;
    this.titleEl = null;
  }

  get visible(): boolean {
    return this.host !== null;
  }
}