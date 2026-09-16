/**
 * M-86: illegal subtitleSelectors must not throw (scanner already guards).
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  SubtitleManager,
  matchSelectorAgainstNode,
  queryAllSafeSelectors,
} from '../src/content/media';

describe('subtitle selector guards (M-86)', () => {
  it('skips illegal CSS instead of throwing', () => {
    document.body.innerHTML = '<div class="caption">hello</div>';
    const node = document.querySelector('.caption') as HTMLElement;
    expect(() => matchSelectorAgainstNode(node, [':::not-css', '.caption'])).not.toThrow();
    expect(matchSelectorAgainstNode(node, [':::not-css', '.caption'])).toBe(node);
    expect(matchSelectorAgainstNode(node, [':::not-css'])).toBeNull();
  });

  it('queryAllSafeSelectors ignores invalid selectors and keeps valid ones', () => {
    document.body.innerHTML = '<span class="cue">hi</span>';
    expect(() => queryAllSafeSelectors(document, [':::boom', '.cue'])).not.toThrow();
    expect(queryAllSafeSelectors(document, [':::boom', '.cue']).map((el) => el.className)).toEqual([
      'cue',
    ]);
  });

  it('applySelectors with an illegal selector does not throw', () => {
    const manager = new SubtitleManager();
    expect(() => manager.applySelectors([':::not-a-selector', '.ytp-caption-segment'])).not.toThrow();
    manager.restoreAll();
  });
});
