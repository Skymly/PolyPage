import { MEDIA_COMMAND_FRAME_ID, sendTabCommand } from '../messaging/messages';
import { imageContextMenuState, tesseractRuntimeAvailable } from '../shared/tesseractRuntime';
import type { Settings } from '../shared/types';
import { logError } from './diagnostics';
import { activeProviderCapabilities } from './gatewayStatus';
import { handlePdfOpen, looksLikePdfUrl } from './pdfRequests';
import { imageRoute } from './settingsState';

const MENU_TRANSLATE_PAGE = 'wt-translate-page';
const MENU_TRANSLATE_SELECTION = 'wt-translate-selection';
const MENU_OPEN_PDF = 'wt-open-pdf';
const MENU_TRANSLATE_IMAGE = 'wt-translate-image';
const MENU_TRANSCRIBE_MEDIA = 'wt-transcribe-media';

export function setupContextMenus(settings?: Settings): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_PAGE,
      title: '翻译此页 (PolyPage)',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_SELECTION,
      title: '翻译选中文字 (PolyPage)',
      contexts: ['selection'],
    });
    const pdfEnabled = settings?.pdfViewer.enabled ?? true;
    if (pdfEnabled) {
      chrome.contextMenus.create({
        id: MENU_OPEN_PDF,
        title: '用 PolyPage 打开双语阅读器',
        contexts: ['page', 'link'],
      });
    }
    const imageEnabled = settings?.imageTranslate.enabled ?? true;
    if (imageEnabled) {
      if (!settings) {
        chrome.contextMenus.create({
          id: MENU_TRANSLATE_IMAGE,
          title: '翻译图片文字 (PolyPage)',
          contexts: ['image'],
          enabled: true,
        });
      } else {
        const vision = activeProviderCapabilities(settings).vision;
        const menu = imageContextMenuState(
          true,
          settings.imageTranslate.engine,
          vision,
          tesseractRuntimeAvailable(),
        );
        if (menu.create) {
          chrome.contextMenus.create({
            id: MENU_TRANSLATE_IMAGE,
            title: menu.enabled ? `翻译图片文字 · ${imageRoute(settings)}` : menu.title,
            contexts: ['image'],
            enabled: menu.enabled,
          });
        }
      }
    }
    const asrEnabled = settings?.asr.enabled ?? true;
    const asr = settings ? activeProviderCapabilities(settings).asr : false;
    if (asrEnabled) {
      chrome.contextMenus.create({
        id: MENU_TRANSCRIBE_MEDIA,
        title: asr ? '转写并翻译 (PolyPage)' : '转写并翻译（当前服务不支持）',
        contexts: ['video', 'audio'],
        enabled: asr,
      });
    }
  });
}

export function registerContextMenus(): void {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;
    try {
      if (info.menuItemId === MENU_TRANSLATE_PAGE) {
        await sendTabCommand(tab.id, { type: 'wt:translate' });
      } else if (info.menuItemId === MENU_TRANSLATE_SELECTION) {
        await sendTabCommand(tab.id, { type: 'wt:translate-selection' });
      } else if (info.menuItemId === MENU_TRANSLATE_IMAGE) {
        if (typeof info.srcUrl === 'string' && info.srcUrl !== '') {
          await sendTabCommand(tab.id, { type: 'wt:translate-image', url: info.srcUrl });
        }
      } else if (info.menuItemId === MENU_TRANSCRIBE_MEDIA) {
        await sendTabCommand(tab.id, { type: 'wt:transcribe-media' }, { frameId: MEDIA_COMMAND_FRAME_ID });
      } else if (info.menuItemId === MENU_OPEN_PDF) {
        const url =
          typeof info.linkUrl === 'string' && info.linkUrl !== ''
            ? info.linkUrl
            : info.pageUrl ?? tab.url ?? '';
        if (url === '') return;
        // Content script may confirm/normalize the URL (page context).
        let target = url;
        if (!looksLikePdfUrl(url) && typeof info.linkUrl !== 'string') {
          try {
            const res = await sendTabCommand(tab.id, { type: 'wt:open-pdf-viewer' });
            if (res?.url) target = res.url;
          } catch {
            /* no content script — use the raw URL */
          }
        }
        void handlePdfOpen(target).then((res) => {
          if (!res.ok) void logError('pdf-open', 'config', res.error ?? '无法打开阅读器');
        });
      }
    } catch {
      // content script not present (e.g. chrome:// pages) — ignore
    }
  });
}
