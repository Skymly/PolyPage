import { describe, expect, it } from 'vitest';
import {
  isExtensionViewerUrl,
  shouldDropInflightAfterAttempt,
  settleInflightAfterAttempt,
  tabIdForTranslate,
} from '../src/background/recoverInflight';

describe('shouldDropInflightAfterAttempt (M-03)', () => {
  it('drops records when the tab is gone', () => {
    expect(shouldDropInflightAfterAttempt(false, false)).toBe(true);
    expect(shouldDropInflightAfterAttempt(false, true)).toBe(true);
  });

  it('drops records when the resume command was accepted', () => {
    expect(shouldDropInflightAfterAttempt(true, true)).toBe(true);
  });

  it('keeps records when send fails but the tab is still open', () => {
    expect(shouldDropInflightAfterAttempt(true, false)).toBe(false);
  });
});

describe('tabIdForTranslate (M-03)', () => {
  it('prefers the explicit tabId from the translate message', () => {
    expect(tabIdForTranslate(42, undefined)).toBe(42);
    expect(tabIdForTranslate(42, 7)).toBe(42);
    expect(tabIdForTranslate(undefined, 7)).toBe(7);
    expect(tabIdForTranslate(undefined, undefined)).toBeUndefined();
  });
});

describe('settleInflightAfterAttempt (M-03)', () => {
  it('does not removeTab when delivery fails and the tab still exists', async () => {
    let removed = false;
    const result = await settleInflightAfterAttempt(true, false, async () => {
      removed = true;
    });
    expect(result).toBe('kept');
    expect(removed).toBe(false);
  });

  it('removeTab when the tab is gone even if send never ran', async () => {
    let removed = false;
    const result = await settleInflightAfterAttempt(false, false, async () => {
      removed = true;
    });
    expect(result).toBe('removed');
    expect(removed).toBe(true);
  });
});

describe('isExtensionViewerUrl (M-03)', () => {
  it('treats chrome-extension and moz-extension viewer URLs as extension pages', () => {
    expect(isExtensionViewerUrl('chrome-extension://abc/viewer/pdf-viewer.html?src=x')).toBe(true);
    expect(isExtensionViewerUrl('moz-extension://abc/viewer/pdf-viewer.html')).toBe(true);
    expect(isExtensionViewerUrl('https://example.com/a.pdf')).toBe(false);
    expect(isExtensionViewerUrl(undefined)).toBe(false);
  });
});
