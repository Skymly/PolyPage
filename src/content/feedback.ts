/**
 * Bad-translation marking on bilingual blocks (spec 3.0 §8.2). A single
 * floating mini-button appears while hovering a translated bilingual block;
 * clicking records the pair in the background feedback log. Marking never
 * changes rendering (spec §8.2 item 4).
 *
 * The selection panel and subtitle layer own their own mark buttons; this
 * module covers page bilingual blocks.
 */
import { sendRuntime } from '../messaging/messages';
import { BILINGUAL_CLASS, DATA_ATTR } from '../shared/constants';

export class FeedbackMarker {
  private btn: HTMLElement | null = null;
  private currentBlock: HTMLElement | null = null;

  init(): void {
    document.addEventListener('mouseover', this.onMouseOver, true);
    document.addEventListener('mouseout', this.onMouseOut, true);
  }

  private onMouseOver = (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target === this.btn || this.btn?.contains(target)) return;
    const block = target.closest(`.${BILINGUAL_CLASS}`);
    if (!(block instanceof HTMLElement)) {
      // Moving between block and button: keep visible briefly.
      return;
    }
    const text = (block.textContent ?? '').trim();
    if (text === '' || text.startsWith('翻译中') || text.startsWith('翻译失败')) return;
    this.show(block, e);
  };

  private onMouseOut = (e: MouseEvent): void => {
    const to = e.relatedTarget;
    if (to === this.btn || (to instanceof Node && this.btn?.contains(to))) return;
    const block = this.currentBlock;
    if (block && to instanceof Node && block.contains(to)) return;
    this.hide();
  };

  private show(block: HTMLElement, e: MouseEvent): void {
    this.currentBlock = block;
    if (!this.btn) {
      const btn = document.createElement('button');
      btn.className = 'wt-feedback-btn';
      btn.textContent = '标记坏句';
      btn.style.cssText = [
        'position:fixed',
        'z-index:2147483646',
        'background:#fff',
        'color:#6b7280',
        'border:1px solid #d8dce6',
        'border-radius:4px',
        'padding:1px 8px',
        'font-size:11px',
        'cursor:pointer',
        'box-shadow:0 2px 6px rgba(0,0,0,.12)',
        'font-family:system-ui,sans-serif',
      ].join(';');
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        void this.mark();
      });
      btn.addEventListener('mouseenter', () => {
        if (this.hideTimer !== null) {
          window.clearTimeout(this.hideTimer);
          this.hideTimer = null;
        }
      });
      btn.addEventListener('mouseleave', () => this.scheduleHide());
      this.btn = btn;
    }
    document.documentElement.appendChild(this.btn);
    const x = Math.min(e.clientX + 12, window.innerWidth - 90);
    const y = Math.max(4, e.clientY - 24);
    this.btn.style.left = `${Math.round(x)}px`;
    this.btn.style.top = `${Math.round(y)}px`;
    this.btn.textContent = '标记坏句';
  }

  private hideTimer: number | null = null;

  private scheduleHide(): void {
    if (this.hideTimer !== null) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, 250);
  }

  private hide(): void {
    this.btn?.remove();
    this.currentBlock = null;
  }

  private async mark(): Promise<void> {
    const block = this.currentBlock;
    const btn = this.btn;
    if (!block || !btn) return;
    const id = block.getAttribute(DATA_ATTR);
    // Original text lives on the source element carrying the same wt-id.
    let source = '';
    if (id) {
      const origin = document.querySelector(
        `[${DATA_ATTR}="${CSS.escape(id)}"]:not(.${BILINGUAL_CLASS})`,
      );
      source = (origin?.textContent ?? '').trim();
    }
    const translation = (block.textContent ?? '').trim();
    try {
      await sendRuntime({
        type: 'mark-feedback',
        source,
        translation,
        pageUrl: location.href,
        where: 'page',
      });
      btn.textContent = '已标记 ✓';
    } catch {
      btn.textContent = '标记失败';
    }
    window.setTimeout(() => this.hide(), 900);
  }
}