/**
 * SW-restart 续译投递策略（M-03）。
 *
 * 网页走 chrome.tabs.sendMessage；PDF 阅读器是 chrome-extension://
 * 扩展页，没有 content script，tabs.sendMessage 必然失败。
 * 失败且 tab 仍在时必须保留任务表，让 viewer 稍后拉一次。
 */

export function isExtensionViewerUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('chrome-extension://') || url.startsWith('moz-extension://');
}

/** Drop records only when the tab is gone or the resume command was accepted. */
export function shouldDropInflightAfterAttempt(tabExists: boolean, delivered: boolean): boolean {
  return !tabExists || delivered;
}

/** Prefer an explicit translate.tabId (PDF viewer) over sender.tab, which can be missing on extension pages. */
export function tabIdForTranslate(
  messageTabId: number | undefined,
  senderTabId: number | undefined,
): number | undefined {
  return messageTabId ?? senderTabId;
}

export async function settleInflightAfterAttempt(
  tabExists: boolean,
  delivered: boolean,
  remove: () => Promise<void>,
): Promise<'removed' | 'kept'> {
  if (shouldDropInflightAfterAttempt(tabExists, delivered)) {
    await remove();
    return 'removed';
  }
  return 'kept';
}
