// @vitest-environment happy-dom
/**
 * M-18: restore fidelity for 网页翻译 display modes.
 * data-wt-id residue is M-31 and is stripped before HTML compare.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BILINGUAL_CLASS,
  DATA_ATTR,
  INLINE_DST_CLASS,
  INLINE_SRC_CLASS,
} from '../src/shared/constants';
import { PageTranslator } from '../src/content/translator';
import type { TranslateItemsFn } from '../src/content/runtimeTranslate';
import type { DisplayMode } from '../src/shared/types';

beforeEach(() => {
  HTMLElement.prototype.checkVisibility = () => true;
  document.body.innerHTML = '';
});

const ORIGINAL = 'The quick brown fox jumps over the lazy dog near the river bank.';
const TRANSLATED = '敏捷的棕色狐狸跳过了河边的懒狗。';

function translatorWithMap(map: Record<string, string>): PageTranslator {
  const translateItems: TranslateItemsFn = async (items) => ({
    results: Object.fromEntries(items.map((item) => [item.key, map[item.text] ?? `译:${item.text}`])),
    errors: {},
  });
  const translator = new PageTranslator({ translateItems });
  translator.configure({ minTextLength: 8 });
  return translator;
}

function mountArticle(): HTMLElement {
  document.body.innerHTML = `<article id="root"><p id="p1">${ORIGINAL}</p></article>`;
  return document.getElementById('root') as HTMLElement;
}

function htmlWithoutWtId(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    if (!(node instanceof Element)) continue;
    node.removeAttribute(DATA_ATTR);
    if (node.getAttribute('class') === '') node.removeAttribute('class');
  }
  return clone.innerHTML;
}

function translationChromeGone(root: ParentNode = document): void {
  expect(root.querySelector(`.${BILINGUAL_CLASS}`)).toBeNull();
  expect(root.querySelector(`.${INLINE_SRC_CLASS}`)).toBeNull();
  expect(root.querySelector(`.${INLINE_DST_CLASS}`)).toBeNull();
}

describe('restore fidelity (M-18)', () => {
  const modes: DisplayMode[] = ['bilingual', 'translated', 'inline'];

  it.each(modes)('restore() after translate(%s) recovers the original article HTML', async (mode) => {
    const root = mountArticle();
    const before = htmlWithoutWtId(root);
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate(mode);
    expect(document.getElementById('p1')?.textContent).toContain(mode === 'translated' ? TRANSLATED : ORIGINAL);
    translator.restore();
    expect(htmlWithoutWtId(root)).toBe(before);
    expect(document.getElementById('p1')?.textContent).toBe(ORIGINAL);
    translationChromeGone();
  });

  it('bilingual → translated → restore recovers the original article', async () => {
    const root = mountArticle();
    const before = htmlWithoutWtId(root);
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('bilingual');
    await translator.setMode('translated');
    expect(document.getElementById('p1')?.textContent).toBe(TRANSLATED);
    translator.restore();
    expect(htmlWithoutWtId(root)).toBe(before);
    expect(document.getElementById('p1')?.textContent).toBe(ORIGINAL);
    translationChromeGone();
  });

  it('translated → bilingual → restore recovers the original article', async () => {
    const root = mountArticle();
    const before = htmlWithoutWtId(root);
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('translated');
    await translator.setMode('bilingual');
    translator.restore();
    expect(htmlWithoutWtId(root)).toBe(before);
    translationChromeGone();
  });

  it('inline → bilingual → restore recovers the original article', async () => {
    const root = mountArticle();
    const before = htmlWithoutWtId(root);
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('inline');
    await translator.setMode('bilingual');
    translator.restore();
    expect(htmlWithoutWtId(root)).toBe(before);
    translationChromeGone();
  });

  it('bilingual → inline → restore recovers the original article', async () => {
    const root = mountArticle();
    const before = htmlWithoutWtId(root);
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('bilingual');
    await translator.setMode('inline');
    translator.restore();
    expect(htmlWithoutWtId(root)).toBe(before);
    expect(document.getElementById('p1')?.textContent).toBe(ORIGINAL);
    translationChromeGone();
  });
});
