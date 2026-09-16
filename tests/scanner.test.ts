// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  HTMLElement.prototype.checkVisibility = () => true;
});
import { INLINE_DST_CLASS, INLINE_SRC_CLASS, NAV_TRANSLATION_CLASS } from '../src/shared/constants';
import {
  isMenuChrome,
  scanTranslatableNodes,
  sourceTextOf,
} from '../src/content/scanner';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe('scanTranslatableNodes nav chrome', () => {
  it('includes Wikipedia-style nav list items and short labels', () => {
    mount(`
      <nav id="sidebar">
        <ul>
          <li><a href="/wiki/">Main page</a></li>
          <li><a href="#toc">Contents</a></li>
          <li><a href="#t">Tools</a></li>
        </ul>
      </nav>
      <p id="prose">Open source software has changed the world of publishing.</p>
      <button>Download now please</button>
    `);
    const found = scanTranslatableNodes(document.body, 8);
    const texts = found.map((el) => sourceTextOf(el));
    expect(texts).toContain('Main page');
    expect(texts).toContain('Contents');
    expect(texts).toContain('Tools');
    expect(texts).toContain('Open source software has changed the world of publishing.');
    expect(found.some((el) => el.tagName === 'BUTTON')).toBe(false);
    expect(found.every((el) => isMenuChrome(el) || el.id === 'prose' || el.tagName === 'P')).toBe(true);
  });

  it('ignores inserted nav suffixes when reading source text', () => {
    mount(`<nav><ul><li id="item"><a href="#">Contents<span class="${NAV_TRANSLATION_CLASS}">[目录]</span></a></li></ul></nav>`);
    const li = document.getElementById('item') as HTMLElement;
    expect(sourceTextOf(li)).toBe('Contents');
    expect(scanTranslatableNodes(document.body, 8).map((el) => sourceTextOf(el))).toEqual(['Contents']);
  });

  it('ignores inline destination spans when reading source text (M-01)', () => {
    mount(
      `<p id="p1"><span class="${INLINE_SRC_CLASS}">The quick brown fox.</span><span class="${INLINE_DST_CLASS}">敏捷的棕狐。</span></p>`,
    );
    const p = document.getElementById('p1') as HTMLElement;
    expect(sourceTextOf(p)).toBe('The quick brown fox.');
  });

  it('still skips code and form controls outside nav', () => {
    mount(`<p>Visible paragraph text here.</p><pre>const skip = true;</pre><code>nope</code>`);
    const texts = scanTranslatableNodes(document.body, 6).map((el) => sourceTextOf(el));
    expect(texts).toEqual(['Visible paragraph text here.']);
  });
});
