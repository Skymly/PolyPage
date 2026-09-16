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
import { sourceTextOf } from '../src/content/scanner';
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

  it('inline: restore() after a third-party mutation still matches original HTML (M-01)', async () => {
    const root = mountArticle();
    const before = htmlWithoutWtId(root);
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('inline');
    expect(document.getElementById('p1')?.querySelector(`.${INLINE_DST_CLASS}`)).not.toBeNull();

    const junk = document.createElement('span');
    junk.id = 'third-party';
    junk.textContent = 'ad banner';
    root.appendChild(junk);
    expect(translator.detectRecycledNodes()).toBe(false);

    translator.restore();
    junk.remove();
    expect(htmlWithoutWtId(root)).toBe(before);
    expect(document.getElementById('p1')?.textContent).toBe(ORIGINAL);
    translationChromeGone();
  });

  it('inline: replacing the paragraph content is still treated as recycle (M-01)', async () => {
    mountArticle();
    const recycled = 'Completely new recycled paragraph text here for the virtual list.';
    const translator = translatorWithMap({
      [ORIGINAL]: TRANSLATED,
      [recycled]: '虚拟列表换了新段落。',
    });
    await translator.translate('inline');
    const p = document.getElementById('p1') as HTMLElement;
    p.textContent = recycled;
    expect(translator.detectRecycledNodes()).toBe(true);
    expect(sourceTextOf(p)).toBe(recycled);
  });
});

describe('bilingual block teardown (M-12)', () => {
  it('recycle replaces the node text without leaving the old bilingual sibling', async () => {
    const root = mountArticle();
    const recycled = 'Completely new recycled paragraph text here for the virtual list.';
    const translator = translatorWithMap({
      [ORIGINAL]: TRANSLATED,
      [recycled]: '虚拟列表换了新段落。',
    });
    await translator.translate('bilingual');
    expect(root.querySelectorAll(`.${BILINGUAL_CLASS}`).length).toBe(1);
    const stale = root.querySelector(`.${BILINGUAL_CLASS}`) as HTMLElement;

    const p = document.getElementById('p1') as HTMLElement;
    p.textContent = recycled;
    expect(stale.isConnected).toBe(true);
    translator.detectRecycledNodes();
    expect(stale.isConnected).toBe(false);
    expect(root.querySelectorAll(`.${BILINGUAL_CLASS}`).length).toBeLessThanOrEqual(1);
  });

  it('restore() after the host is disconnected removes the orphan bilingual block', async () => {
    const root = mountArticle();
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('bilingual');
    const stale = root.querySelector(`.${BILINGUAL_CLASS}`) as HTMLElement;
    expect(stale).not.toBeNull();
    document.getElementById('p1')!.remove();
    translator.restore();
    expect(stale.isConnected).toBe(false);
    expect(root.querySelector(`.${BILINGUAL_CLASS}`)).toBeNull();
  });
});

describe('setMode inline restores first (M-13)', () => {
  it('bilingual → inline removes the bilingual sibling and keeps original in src', async () => {
    const root = mountArticle();
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('bilingual');
    expect(root.querySelector(`.${BILINGUAL_CLASS}`)).not.toBeNull();
    await translator.setMode('inline');
    expect(root.querySelector(`.${BILINGUAL_CLASS}`)).toBeNull();
    const p = document.getElementById('p1') as HTMLElement;
    expect(p.querySelector(`.${INLINE_SRC_CLASS}`)?.textContent).toBe(ORIGINAL);
    expect(p.querySelector(`.${INLINE_DST_CLASS}`)?.textContent).toBe(TRANSLATED);
  });

  it('translated → inline wraps the original, not the translation (M-13)', async () => {
    mountArticle();
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('translated');
    expect(document.getElementById('p1')?.textContent).toBe(TRANSLATED);
    await translator.setMode('inline');
    const p = document.getElementById('p1') as HTMLElement;
    expect(p.querySelector(`.${INLINE_SRC_CLASS}`)?.textContent).toBe(ORIGINAL);
    expect(p.querySelector(`.${INLINE_DST_CLASS}`)?.textContent).toBe(TRANSLATED);
    expect(p.textContent).not.toContain(`译:${TRANSLATED}`);
  });

  it('li bilingual → inline does not re-translate the inner block (M-13)', async () => {
    document.body.innerHTML = `<ul id="root"><li id="item">${ORIGINAL}</li></ul>`;
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('bilingual');
    const li = document.getElementById('item') as HTMLElement;
    expect(li.querySelector(`.${BILINGUAL_CLASS}`)).not.toBeNull();
    await translator.setMode('inline');
    expect(li.querySelector(`.${BILINGUAL_CLASS}`)).toBeNull();
    expect(li.querySelector(`.${INLINE_SRC_CLASS}`)?.textContent).toBe(ORIGINAL);
    expect(li.querySelector(`.${INLINE_DST_CLASS}`)?.textContent).toBe(TRANSLATED);
  });
});
