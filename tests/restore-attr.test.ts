// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { DATA_ATTR, SHADOW_STYLE_ATTR } from '../src/shared/constants';
import { PageTranslator } from '../src/content/translator';
import type { TranslateItemsFn } from '../src/content/runtimeTranslate';

beforeEach(() => {
  HTMLElement.prototype.checkVisibility = () => true;
  document.body.innerHTML = '';
});

const ORIGINAL = 'The quick brown fox jumps over the lazy dog near the river bank.';
const TRANSLATED = '敏捷的棕色狐狸跳过了河边的懒狗。';
const OTHER = 'Another paragraph that is long enough to be a translation candidate.';

function translatorWithMap(map: Record<string, string>): PageTranslator {
  const translateItems: TranslateItemsFn = async (items) => ({
    results: Object.fromEntries(items.map((item) => [item.key, map[item.text] ?? `译:${item.text}`])),
    errors: {},
  });
  const translator = new PageTranslator({ translateItems });
  translator.configure({ minTextLength: 8 });
  return translator;
}

describe('restore strips extension residue (M-31)', () => {
  it('restore() removes data-wt-id from the live element', async () => {
    document.body.innerHTML = `<article><p id="p1">${ORIGINAL}</p></article>`;
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    await translator.translate('bilingual');
    const p = document.getElementById('p1') as HTMLElement;
    expect(p.hasAttribute(DATA_ATTR)).toBe(true);
    translator.restore();
    expect(p.hasAttribute(DATA_ATTR)).toBe(false);
    expect(document.querySelector(`[${DATA_ATTR}]`)).toBeNull();
  });

  it('restore() removes injected shadow-root style clones', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<p>${ORIGINAL}</p>`;
    const { ensureShadowStyle } = await import('../src/content/renderer');
    ensureShadowStyle(shadow);
    expect(shadow.querySelector(`style[${SHADOW_STYLE_ATTR}]`)).not.toBeNull();
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    translator.restore();
    expect(shadow.querySelector(`style[${SHADOW_STYLE_ATTR}]`)).toBeNull();
  });

  it('scan() on a blacklisted host does not stamp data-wt-id', () => {
    document.body.innerHTML = `<article><p id="p1">${ORIGINAL}</p></article>`;
    const translator = translatorWithMap({ [ORIGINAL]: TRANSLATED });
    translator.blacklisted = true;
    expect(translator.scan()).toBe(0);
    expect(document.getElementById('p1')?.hasAttribute(DATA_ATTR)).toBe(false);
  });
});

describe('data-wt-id is not trusted from the page (M-84)', () => {
  it('two elements sharing a preset id are both translated with distinct ids', async () => {
    document.body.innerHTML = `
      <article>
        <p id="p1" ${DATA_ATTR}="stolen">${ORIGINAL}</p>
        <p id="p2" ${DATA_ATTR}="stolen">${OTHER}</p>
      </article>
    `;
    const translator = translatorWithMap({
      [ORIGINAL]: TRANSLATED,
      [OTHER]: '另一段译文也足够长。',
    });
    await translator.translate('bilingual');
    const p1 = document.getElementById('p1') as HTMLElement;
    const p2 = document.getElementById('p2') as HTMLElement;
    expect(p1.getAttribute(DATA_ATTR)).not.toBe('stolen');
    expect(p2.getAttribute(DATA_ATTR)).not.toBe('stolen');
    expect(p1.getAttribute(DATA_ATTR)).not.toBe(p2.getAttribute(DATA_ATTR));
    expect(document.querySelectorAll('.wt-bilingual-block').length).toBe(2);
  });
});
