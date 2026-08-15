/**
 * Image translation entry points (spec 3.0 pillar F / §6.3).
 *
 * Two user-triggered entries — never automatic (spec 3.0 §0 item 5):
 *  1. context menu "翻译图片文字" (background forwards wt:translate-image);
 *  2. hover button on images >= 200px rendered edge (when enabled).
 *
 * Both open the Shadow DOM result panel and route through the background
 * OCR pipeline (ocr-request / ocr-cancel). Panels never touch page DOM.
 */
import { sendRuntime } from '../messaging/messages';
import { IMAGE_HOVER_MIN_PX } from '../shared/constants';
import type { ImageTranslateTrigger } from '../shared/types';
import { OcrResultPanel } from '../ocr/resultPanel';

export interface ImageButtonConfig {
  enabled: boolean;
  trigger: ImageTranslateTrigger;
  visionSupported: boolean;
  /** 4.0: OCR can run (vision provider or tesseract-wasm). */
  ocrAvailable: boolean;
  /** Reason shown when entries are greyed out. */
  disabledReason: string | null;
}

export class ImageTranslateController {
  private button: HTMLElement | null = null;
  private buttonImg: HTMLImageElement | null = null;
  private panel = new OcrResultPanel();
  private currentRequestId: string | null = null;
  private config: ImageButtonConfig = {
    enabled: true,
    trigger: 'both',
    visionSupported: true,
    ocrAvailable: true,
    disabledReason: null,
  };

  configure(config: ImageButtonConfig): void {
    this.config = config;
    if (!this.hoverAllowed()) this.hideButton();
  }

  private hoverAllowed(): boolean {
    return (
      this.config.enabled &&
      (this.config.trigger === 'hoverButton' || this.config.trigger === 'both')
    );
  }

  init(): void {
    document.addEventListener('mouseover', this.onMouseOver, true);
    document.addEventListener('mouseout', this.onMouseOut, true);
  }

  private onMouseOver = (e: MouseEvent): void => {
    if (!this.hoverAllowed()) return;
    const target = e.target;
    if (!(target instanceof HTMLImageElement)) return;
    if (this.isOwnUi(target)) return;
    const rect = target.getBoundingClientRect();
    if (rect.width < IMAGE_HOVER_MIN_PX && rect.height < IMAGE_HOVER_MIN_PX) return;
    this.showButton(target);
  };

  private onMouseOut = (e: MouseEvent): void => {
    const to = e.relatedTarget;
    if (to instanceof HTMLElement && this.isOwnUi(to)) return;
    if (to === this.buttonImg) return;
    // Keep the button while hovering the button itself.
    if (to instanceof HTMLElement && to === this.button) return;
    this.hideButton();
  };

  private isOwnUi(el: Element): boolean {
    return el.closest('.wt-ocr-host') !== null || el.classList.contains('wt-img-btn');
  }

  private showButton(img: HTMLImageElement): void {
    this.hideButton();
    const btn = document.createElement('button');
    btn.className = 'wt-img-btn';
    btn.textContent = '译图';
    const reason = this.config.disabledReason;
    btn.title = this.config.ocrAvailable
      ? '翻译图片文字 (PolyPage)'
      : reason ?? '当前翻译服务不支持视觉翻译';
    btn.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'background:#4f46e5',
      'color:#fff',
      'border:none',
      'border-radius:6px',
      'padding:4px 10px',
      'font-size:12px',
      'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)',
      'font-family:system-ui,sans-serif',
    ].join(';');
    if (!this.config.ocrAvailable) {
      btn.style.background = '#9ca3af';
      btn.style.cursor = 'not-allowed';
    }
    const rect = img.getBoundingClientRect();
    btn.style.left = `${Math.max(4, Math.round(rect.right - 52))}px`;
    btn.style.top = `${Math.max(4, Math.round(rect.top + 6))}px`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.config.ocrAvailable) return;
      this.translateImage(img.src, img);
    });
    document.documentElement.appendChild(btn);
    this.button = btn;
    this.buttonImg = img;
  }

  private hideButton(): void {
    this.button?.remove();
    this.button = null;
    this.buttonImg = null;
  }

  /** Entry for both hover button and background context-menu command. */
  translateImage(url: string, near?: Element): void {
    if (!this.config.enabled) return;
    if (!this.config.ocrAvailable) {
      this.panel.setCallbacks({ onCancel: () => undefined, onClose: () => undefined });
      this.panel.showLoading(near);
      this.panel.showError(this.config.disabledReason ?? '当前翻译服务不支持视觉翻译');
      return;
    }
    const requestId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.currentRequestId = requestId;
    this.panel.setCallbacks({
      onCancel: () => {
        void sendRuntime({ type: 'ocr-cancel', requestId }).catch(() => undefined);
        this.panel.hide();
      },
      onClose: () => {
        void sendRuntime({ type: 'ocr-cancel', requestId }).catch(() => undefined);
      },
    });
    this.panel.showLoading(near);
    void sendRuntime({
      type: 'ocr-request',
      requestId,
      url,
      ...(near instanceof HTMLImageElement
        ? { naturalWidth: near.naturalWidth, naturalHeight: near.naturalHeight }
        : {}),
    })
      .then((res) => {
        if (this.currentRequestId !== requestId) return;
        if (res?.ok) {
          this.panel.showSegments(res.segments);
        } else {
          this.panel.showError(res?.error ?? '未知错误');
        }
      })
      .catch((e: unknown) => {
        if (this.currentRequestId !== requestId) return;
        this.panel.showError(e instanceof Error ? e.message : String(e));
      });
  }
}