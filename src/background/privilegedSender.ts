/**
 * Privileged Options/Popup commands must come from extension pages (M-41).
 * Use protocol+host — `URL.origin` is `"null"` for `chrome-extension:` in Node.
 */

export function extensionOriginOf(runtimeRootUrl: string): string {
  const u = new URL(runtimeRootUrl);
  return `${u.protocol}//${u.host}`;
}

export function isExtensionPageSender(
  sender: { url?: string },
  extensionOrigin: string,
): boolean {
  if (!sender.url) return false;
  try {
    return extensionOriginOf(sender.url) === extensionOrigin;
  } catch {
    return false;
  }
}

export const PRIVILEGED_SETTINGS_DENIED = '仅扩展页面可执行此操作';
