/**
 * Tooltip bubble shown on hover (spec §7.4).
 *
 * - Rendered inside a Shadow DOM host appended to <html>, so page CSS never
 *   touches it and its content never enters the page DOM (spec §7.4.3/13).
 * - pointer-events: none — it can never block or steal the mouse.
 * - Hides on scroll/resize, delayed hide on mouse-out to avoid flicker.
 */
import tooltipCss from '../styles/tooltip.css?raw';

export type TooltipState = 'ready' | 'loading' | 'error';

const LOADING_TEXT = '翻译中…';
const HIDE_DELAY_MS = 200;

export class Tooltip {
  private host: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private hideTimer: number | null = null;
  private current: Element | null = null;

  /** Element the tooltip is currently attached to (null when hidden). */
  get currentTarget(): Element | null {
    return this.current;
  }

  private ensureHost(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.className = 'wt-tooltip-host';
    host.style.cssText =
      'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = tooltipCss;
    const box = document.createElement('div');
    box.className = 'wt-tooltip';
    shadow.appendChild(style);
    shadow.appendChild(box);
    document.documentElement.appendChild(host);
    this.host = host;
    this.box = box;
    window.addEventListener('scroll', this.onViewportChange, true);
    window.addEventListener('resize', this.onViewportChange);
  }

  private onViewportChange = (): void => {
    this.hideNow();
  };

  show(target: Element, text: string, state: TooltipState): void {
    this.ensureHost();
    const box = this.box!;
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    box.classList.remove('wt-tooltip--loading', 'wt-tooltip--error');
    if (state === 'loading') {
      box.textContent = LOADING_TEXT;
      box.classList.add('wt-tooltip--loading');
    } else if (state === 'error') {
      box.textContent = `翻译失败：${text}`;
      box.classList.add('wt-tooltip--error');
    } else {
      box.textContent = text;
    }
    this.position(target, box);
    this.current = target;
  }

  private position(target: Element, box: HTMLElement): void {
    const host = this.host!;
    const rect = target.getBoundingClientRect();
    const margin = 10;
    // Measure while invisible.
    box.style.visibility = 'hidden';
    const boxWidth = box.offsetWidth;
    const boxHeight = box.offsetHeight;
    let left = Math.min(Math.max(rect.left, margin), window.innerWidth - boxWidth - margin);
    if (left < margin) left = margin;
    let top = rect.bottom + margin;
    if (top + boxHeight > window.innerHeight - margin) {
      top = rect.top - boxHeight - margin;
    }
    if (top < margin) top = margin;
    host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    box.style.visibility = 'visible';
  }

  /** Hide after a short delay (lets the user move between elements smoothly). */
  hide(delayed = true): void {
    if (!delayed) {
      this.hideNow();
      return;
    }
    if (this.hideTimer !== null) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.hideNow();
    }, HIDE_DELAY_MS);
  }

  hideNow(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.box) this.box.textContent = '';
    if (this.host) this.host.style.transform = 'translate(-10000px, -10000px)';
    this.current = null;
  }

  destroy(): void {
    window.removeEventListener('scroll', this.onViewportChange, true);
    window.removeEventListener('resize', this.onViewportChange);
    this.host?.remove();
    this.host = null;
    this.box = null;
    this.current = null;
  }
}
