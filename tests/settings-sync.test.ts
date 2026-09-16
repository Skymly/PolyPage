import { describe, expect, it } from 'vitest';
import { shouldStartAutoTranslate } from '../src/shared/settingsSync';

describe('shouldStartAutoTranslate (M-43)', () => {
  it('starts auto-translate only on init when not blacklisted and not same-language', () => {
    expect(shouldStartAutoTranslate('init', true, false, false)).toBe(true);
    expect(shouldStartAutoTranslate('init', true, false, true)).toBe(false);
    expect(shouldStartAutoTranslate('init', true, true, false)).toBe(false);
    expect(shouldStartAutoTranslate('init', false, false, false)).toBe(false);
  });

  it('never auto-translates on a live settings broadcast', () => {
    expect(shouldStartAutoTranslate('live', true, false, false)).toBe(false);
  });
});
