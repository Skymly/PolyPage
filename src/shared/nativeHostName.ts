/**
 * Native Messaging host names the extension is allowed to open (M-55).
 * Smoke uses `com.skymly.polypage.gateway.smoke`; production uses `.gateway`.
 */

const ALLOWED = /^com\.skymly\.polypage\.[a-z][a-z0-9._-]*$/;

export function isAllowedNativeHostName(name: string): boolean {
  return ALLOWED.test(name.trim());
}

export function deniedNativeHostMessage(name: string): string {
  return `本地网关名称不在允许列表：${name}`;
}
