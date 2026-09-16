/**
 * Offscreen document that can new Worker (M-02). The service worker forwards
 * tesseract-recognize here because Chrome MV3 service workers cannot construct Worker.
 */
import { abortVendoredTesseract, runVendoredCreateWorker } from '../ocr/tesseract';

let activeRecognize: AbortController | null = null;

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const msg = message as { type?: string; dataUrl?: string; langs?: unknown };
  if (msg.type === 'tesseract-abort') {
    activeRecognize?.abort();
    void abortVendoredTesseract();
    return;
  }
  if (msg.type !== 'tesseract-recognize') return;
  const dataUrl = typeof msg.dataUrl === 'string' ? msg.dataUrl : '';
  const langs = Array.isArray(msg.langs) ? msg.langs.filter((l): l is string => typeof l === 'string') : [];
  activeRecognize?.abort();
  const ac = new AbortController();
  activeRecognize = ac;
  void (async () => {
    try {
      const raw = await runVendoredCreateWorker({ dataUrl, langs }, ac.signal);
      sendResponse({ ok: true, text: raw.text, lines: raw.lines });
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true;
});
