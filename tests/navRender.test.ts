// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  HTMLElement.prototype.checkVisibility = () => true;
});

import { NAV_TRANSLATION_CLASS } from '../src/shared/constants';
import { PageTranslator } from '../src/content/translator';
import type { TranslateItemsFn } from '../src/content/runtimeTranslate';

function translatorWithMap(map: Record<string, string>): PageTranslator {
  const translateItems: TranslateItemsFn = async (items) => ({
    results: Object.fromEntries(items.map((item) => [item.key, map[item.text] ?? `译:${item.text}`])),
    errors: {},
  });
  const translator = new PageTranslator({ translateItems });
  translator.configure({ minTextLength: 2 });
  return translator;
}

describe('nav compact rendering via 网页翻译', () => {
  it('keeps the link and appends [译文] inside it', async () => {
    document.body.innerHTML = `<nav><ul><li id="item"><a href="/wiki/Contents">Contents</a></li></ul></nav>`;
    const translator = translatorWithMap({ Contents: '目录' });
    await translator.translate('bilingual');
    const li = document.getElementById('item') as HTMLElement;
    const anchor = li.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('/wiki/Contents');
    expect(anchor?.textContent).toBe('Contents[目录]');
    expect(anchor?.querySelector(`.${NAV_TRANSLATION_CLASS}`)?.textContent).toBe('[目录]');
    expect(li.querySelector('.wt-bilingual-block')).toBeNull();
  });

  it('does not rewrite the link in translated mode', async () => {
    document.body.innerHTML = `<nav><ul><li id="item"><a href="#top">Main page</a></li></ul></nav>`;
    const translator = translatorWithMap({ 'Main page': '首页' });
    await translator.translate('translated');
    const li = document.getElementById('item') as HTMLElement;
    expect(li.querySelector('a')?.getAttribute('href')).toBe('#top');
    expect(li.querySelector('a')?.textContent).toBe('Main page[首页]');
  });

  it('removes the suffix when restoring original', async () => {
    document.body.innerHTML = `<nav><ul><li id="item"><a href="#">Tools</a></li></ul></nav>`;
    const translator = translatorWithMap({ Tools: '工具' });
    await translator.translate('bilingual');
    translator.restore();
    const li = document.getElementById('item') as HTMLElement;
    expect(li.querySelector(`.${NAV_TRANSLATION_CLASS}`)).toBeNull();
    expect(li.textContent?.trim()).toBe('Tools');
  });
});