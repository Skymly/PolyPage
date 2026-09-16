/**
 * Privileged settings RPCs must come from extension pages (M-41).
 */
import { describe, expect, it } from 'vitest';
import { extensionOriginOf, isExtensionPageSender } from '../src/background/privilegedSender';

const origin = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef';

describe('isExtensionPageSender (M-41)', () => {
  it('accepts Options, Popup, and viewer URLs on the extension origin', () => {
    expect(extensionOriginOf(`${origin}/`)).toBe(origin);
    expect(isExtensionPageSender({ url: `${origin}/options/src/options/options.html` }, origin)).toBe(true);
    expect(isExtensionPageSender({ url: `${origin}/popup/src/popup/popup.html` }, origin)).toBe(true);
    expect(isExtensionPageSender({ url: `${origin}/viewer/pdf-viewer.html?src=x` }, origin)).toBe(true);
  });

  it('rejects content-script page URLs and missing sender.url', () => {
    expect(isExtensionPageSender({ url: 'https://example.com/article' }, origin)).toBe(false);
    expect(isExtensionPageSender({ url: 'http://127.0.0.1:8123/' }, origin)).toBe(false);
    expect(isExtensionPageSender({}, origin)).toBe(false);
    expect(isExtensionPageSender({ url: 'not a url' }, origin)).toBe(false);
  });
});
