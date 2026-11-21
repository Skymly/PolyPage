import { getSettings } from './settingsState';

export function looksLikePdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return url.toLowerCase().split('?')[0].endsWith('.pdf');
  }
}

function viewerUrlFor(src: string): string {
  return chrome.runtime.getURL(`viewer/pdf-viewer.html?src=${encodeURIComponent(src)}`);
}

export const pdfProgressByTab = new Map<number, { url: string; done: number; total: number; failed: number }>();

export async function handlePdfOpen(url: string): Promise<{ ok: boolean; tabId?: number; error?: string }> {
  const settings = await getSettings();
  if (!settings.pdfViewer.enabled) {
    return { ok: false, error: 'PDF 双语阅读器已在设置中关闭' };
  }
  let normalized: string;
  try {
    normalized = new URL(url).toString();
  } catch {
    return { ok: false, error: '无效的 URL' };
  }
  if (normalized.startsWith('chrome') || normalized.startsWith('about:')) {
    return { ok: false, error: '无法打开内部页面' };
  }
  const tab = await chrome.tabs.create({ url: viewerUrlFor(normalized) });
  return { ok: true, ...(tab.id !== undefined ? { tabId: tab.id } : {}) };
}

async function maybeAutoOpenPdf(details: { tabId: number; frameId: number; url: string }): Promise<void> {
  if (details.frameId !== 0) return;
  if (!looksLikePdfUrl(details.url)) return;
  if (details.url.startsWith('chrome-extension://')) return;
  try {
    const settings = await getSettings();
    if (!settings.pdfViewer.enabled || !settings.pdfViewer.autoOpen) return;
    const granted = await chrome.permissions.contains({ permissions: ['webNavigation'] });
    if (!granted) return;
    await chrome.tabs.update(details.tabId, { url: viewerUrlFor(details.url) });
  } catch {
    /* permission missing or tab gone */
  }
}

export function registerPdfAutoOpen(): void {
  chrome.webNavigation?.onCompleted?.addListener((details) => {
    void maybeAutoOpenPdf(details);
  });
}
