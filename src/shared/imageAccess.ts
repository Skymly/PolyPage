/**
 * Privilege checks for OCR image fetch (M-06).
 * A page-synthesized click must not let the extension pull a third-party
 * image with the user's cookies, then leak the text back through open shadow.
 */

export function ocrRequestAllowed(input: {
  imageUrl: string;
  tabUrl?: string;
  senderUrl?: string;
  userGesture: boolean;
}): boolean {
  if (input.userGesture) return true;
  const url = input.imageUrl;
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  if (
    input.senderUrl?.startsWith('chrome-extension://') ||
    input.senderUrl?.startsWith('moz-extension://')
  ) {
    return true;
  }
  if (!input.tabUrl) return false;
  try {
    return new URL(url).origin === new URL(input.tabUrl).origin;
  } catch {
    return false;
  }
}

export function isTrustedGesture(event: Event): boolean {
  return event.isTrusted === true;
}
