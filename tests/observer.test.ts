// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { DomObserver } from '../src/content/observer';

describe('DomObserver shadow scan (M-83)', () => {
  it('observes the added host shadowRoot without a full-document rescan', () => {
    document.body.innerHTML = '';
    const observer = new DomObserver(() => {}, () => false);
    observer.start();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>shadow paragraph text</p>';
    observer.scanForShadowRoots(host);
    expect(observer.isObserving(shadow)).toBe(true);
    observer.stop();
  });
});
