// @vitest-environment happy-dom
/**
 * Options log rows must not parse remote HTML (M-38).
 */
import { describe, expect, it } from 'vitest';
import { renderErrorLogEntry, renderFeedbackLogHead } from '../src/options/logDom';

describe('Options log DOM (M-38)', () => {
  it('does not parse HTML in error messages or provider names', () => {
    const row = renderErrorLogEntry({
      time: 't',
      kind: 'network',
      provider: '<img src=x>',
      message: '<img src="https://evil.test/x"><form action="https://evil.test">x</form>',
    });
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('form')).toBeNull();
    expect(row.querySelector('.log-provider')!.textContent).toBe('[<img src=x>]');
    expect(row.textContent).toContain('<img src="https://evil.test/x">');
  });

  it('does not parse HTML in feedback providerName or where', () => {
    const head = renderFeedbackLogHead({
      time: 't',
      providerName: '<img src=x>',
      where: '<form action="https://evil.test">pdf</form>',
    });
    expect(head.querySelector('img')).toBeNull();
    expect(head.querySelector('form')).toBeNull();
    expect(head.querySelector('.log-provider')!.textContent).toBe(
      '[<img src=x> / <form action="https://evil.test">pdf</form>]',
    );
  });
});
