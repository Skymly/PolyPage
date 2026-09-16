// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTranslator } from '../src/content/translator';
import type { TranslateItemsFn } from '../src/content/runtimeTranslate';

beforeEach(() => {
  HTMLElement.prototype.checkVisibility = () => true;
  document.body.innerHTML = '';
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('modeEpoch (M-27)', () => {
  it('setMode stops the previous fetchTranslations from sending later chunks', async () => {
    const paras = Array.from(
      { length: 9 },
      (_, i) => `Paragraph number ${i} needs enough characters to translate.`,
    );
    document.body.innerHTML = `<article id="root">${paras.map((t, i) => `<p id="p${i}">${t}</p>`).join('')}</article>`;

    const first = deferred();
    let calls = 0;
    const translateItems: TranslateItemsFn = async (items) => {
      calls++;
      if (calls === 1) await first.promise;
      return {
        results: Object.fromEntries(items.map((item) => [item.key, `译:${item.text}`])),
        errors: {},
      };
    };
    const translator = new PageTranslator({ translateItems });
    translator.configure({ minTextLength: 8 });

    const running = translator.translate('bilingual');
    await vi.waitFor(() => {
      expect(calls).toBe(1);
    });

    await translator.setMode('translated');
    const afterSetMode = calls;
    first.resolve();
    await running;
    expect(calls).toBe(afterSetMode);
  });
});
