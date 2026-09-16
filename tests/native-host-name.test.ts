/**
 * Native Messaging hostName whitelist (M-55).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_NATIVE_HOST_NAME } from '../src/shared/constants';
import { isAllowedNativeHostName } from '../src/shared/nativeHostName';
import { normalizeProvider } from '../src/storage/settings';

describe('isAllowedNativeHostName (M-55)', () => {
  it('allows the production and smoke hosts', () => {
    expect(isAllowedNativeHostName(DEFAULT_NATIVE_HOST_NAME)).toBe(true);
    expect(isAllowedNativeHostName('com.skymly.polypage.gateway.smoke')).toBe(true);
  });

  it('rejects arbitrary registered native hosts', () => {
    expect(isAllowedNativeHostName('com.google.chrome.example')).toBe(false);
    expect(isAllowedNativeHostName('com.skymly.polypage')).toBe(false);
    expect(isAllowedNativeHostName('com.skymly.polypage.Gateway')).toBe(false);
    expect(isAllowedNativeHostName('com.skymly.other.gateway')).toBe(false);
  });
});

describe('normalizeProvider hostName (M-55)', () => {
  it('rewrites a disallowed hostName to the default gateway', () => {
    const p = normalizeProvider({
      id: 'n',
      type: 'native-host',
      hostName: 'com.google.chrome.example',
    });
    expect(p?.hostName).toBe(DEFAULT_NATIVE_HOST_NAME);
  });
});
