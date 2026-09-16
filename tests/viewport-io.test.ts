// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { PageTranslator } from '../src/content/translator';
import type { TranslateItemsFn } from '../src/content/runtimeTranslate';

const A = 'The first paragraph is long enough to be translated as its own unit.';
const B = 'The second paragraph is also long enough to be translated on its own.';

type FakeIO = {
  observed: Set<Element>;
  trigger: (el: Element, isIntersecting: boolean) => void;
};

let lastIO: FakeIO | null = null;

beforeEach(() => {
  HTMLElement.prototype.checkVisibility = () => true;
  document.body.innerHTML = '';
  lastIO = null;
  class FakeIntersectionObserver {
    observed = new Set<Element>();
    private readonly cb: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
      lastIO = this;
    }
    observe(el: Element): void {
      this.observed.add(el);
    }
    unobserve(el: Element): void {
      this.observed.delete(el);
    }
    disconnect(): void {
      this.observed.clear();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    trigger(el: Element, isIntersecting: boolean): void {
      this.cb(
        [
          {
            target: el,
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0,
            time: 0,
            boundingClientRect: el.getBoundingClientRect(),
            intersectionRect: el.getBoundingClientRect(),
            rootBounds: null,
            isVisible: isIntersecting,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      );
    }
  }
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
});

describe('viewport IntersectionObserver (M-83)', () => {
  it('unobserves an entry after it first becomes visible', async () => {
    document.body.innerHTML = `<article><p id="p1">${A}</p><p id="p2">${B}</p></article>`;
    const translateItems: TranslateItemsFn = async (items) => ({
      results: Object.fromEntries(items.map((item) => [item.key, `译:${item.text}`])),
      errors: {},
    });
    const translator = new PageTranslator({ translateItems });
    translator.configure({ minTextLength: 8, viewportBudget: 1 });
    const running = translator.translate('bilingual');
    const p1 = document.getElementById('p1') as HTMLElement;
    expect(lastIO).not.toBeNull();
    expect(lastIO!.observed.has(p1)).toBe(true);
    lastIO!.trigger(p1, true);
    await running;
    expect(lastIO!.observed.has(p1)).toBe(false);
  });
});
