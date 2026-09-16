// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { DATA_ATTR } from '../src/shared/constants';
import { PageTranslator } from '../src/content/translator';
import type { TranslateItemsFn } from '../src/content/runtimeTranslate';
import { hashText } from '../src/shared/utils';

beforeEach(() => {
  HTMLElement.prototype.checkVisibility = () => true;
  document.body.innerHTML = '';
});

const ORIGINAL = 'The quick brown fox jumps over the lazy dog near the river bank.';

describe('resumeInflight textHash (M-16)', () => {
  it('does not activate or fetch when the hash does not match the current node', async () => {
    document.body.innerHTML = `<article><p id="p1">${ORIGINAL}</p></article>`;
    let calls = 0;
    const translateItems: TranslateItemsFn = async (items) => {
      calls++;
      return {
        results: Object.fromEntries(items.map((item) => [item.key, `译:${item.text}`])),
        errors: {},
      };
    };
    const translator = new PageTranslator({ translateItems });
    translator.configure({ minTextLength: 8 });
    translator.scan();
    const id = document.getElementById('p1')?.getAttribute(DATA_ATTR);
    expect(id).toBeTruthy();
    await translator.resumeInflight([{ key: id!, textHash: 'not-the-hash' }]);
    expect(translator.active).toBe(false);
    expect(calls).toBe(0);
  });

  it('re-submits when the hash matches the current node', async () => {
    document.body.innerHTML = `<article><p id="p1">${ORIGINAL}</p></article>`;
    let calls = 0;
    const translateItems: TranslateItemsFn = async (items) => {
      calls++;
      return {
        results: Object.fromEntries(items.map((item) => [item.key, `译:${item.text}`])),
        errors: {},
      };
    };
    const translator = new PageTranslator({ translateItems });
    translator.configure({ minTextLength: 8 });
    translator.scan();
    const id = document.getElementById('p1')?.getAttribute(DATA_ATTR);
    await translator.resumeInflight([{ key: id!, textHash: hashText(ORIGINAL) }]);
    expect(translator.active).toBe(true);
    expect(calls).toBe(1);
  });
});
