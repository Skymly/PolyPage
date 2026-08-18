// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  HTMLElement.prototype.checkVisibility = () => true;
});
import { NAV_TRANSLATION_CLASS } from '../src/shared/constants';
import { renderEntry } from '../src/content/renderer';
import type { NodeEntry } from '../src/content/translator';

function entryFor(el: HTMLElement, translated: string): NodeEntry {
  return {
    id: 'wt-nav-1',
    el,
    originalText: (el.textContent ?? '').trim(),
    textHash: 'x',
    originalNodes: null,
    translated,
    status: 'done',
    error: null,
    bilingualEl: null,
    inlineSegments: null,
    inlineDegraded: false,
    visible: true,
  };
}

describe('nav compact rendering', () => {
  it('keeps the link and appends [译文] inside it', () => {
    document.body.innerHTML = `<nav><ul><li id="item"><a href="/wiki/Contents">Contents</a></li></ul></nav>`;
    const li = document.getElementById('item') as HTMLElement;
    const entry = entryFor(li, '目录');
    renderEntry(entry, 'bilingual');
    const anchor = li.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('/wiki/Contents');
    expect(anchor?.textContent).toBe('Contents[目录]');
    expect(anchor?.querySelector(`.${NAV_TRANSLATION_CLASS}`)?.textContent).toBe('[目录]');
    expect(li.querySelector('.wt-bilingual-block')).toBeNull();
  });

  it('does not rewrite the link in translated mode', () => {
    document.body.innerHTML = `<nav><ul><li id="item"><a href="#top">Main page</a></li></ul></nav>`;
    const li = document.getElementById('item') as HTMLElement;
    const entry = entryFor(li, '首页');
    renderEntry(entry, 'translated');
    expect(li.querySelector('a')?.getAttribute('href')).toBe('#top');
    expect(li.querySelector('a')?.textContent).toBe('Main page[首页]');
  });

  it('removes the suffix when restoring original', () => {
    document.body.innerHTML = `<nav><ul><li id="item"><a href="#">Tools</a></li></ul></nav>`;
    const li = document.getElementById('item') as HTMLElement;
    const entry = entryFor(li, '工具');
    renderEntry(entry, 'bilingual');
    renderEntry(entry, 'original');
    expect(li.querySelector(`.${NAV_TRANSLATION_CLASS}`)).toBeNull();
    expect(li.textContent?.trim()).toBe('Tools');
  });
});
