// @vitest-environment happy-dom
/**
 * M-98: shortcut and mode lists must not parse HTML via innerHTML.
 */
import { describe, expect, it } from 'vitest';
import { renderShortcutRow } from '../src/options/shortcutDom';
import { renderModeItem } from '../src/popup/modeDom';

describe('shortcut rows (M-98)', () => {
  it('does not parse HTML in command description or shortcut', () => {
    const row = renderShortcutRow({
      description: '<img src=x>译',
      name: 'toggle-translate',
      shortcut: '<form action="https://evil.test">Ctrl+Shift+L</form>',
    });
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('form')).toBeNull();
    expect(row.querySelector('span')!.textContent).toBe('<img src=x>译');
    expect(row.querySelector('kbd')!.textContent).toBe(
      '<form action="https://evil.test">Ctrl+Shift+L</form>',
    );
  });
});

describe('mode items (M-98)', () => {
  it('does not parse HTML in mode name or description', () => {
    const label = renderModeItem('inline', {
      name: '<img src=x>段内',
      desc: '<form action="https://evil.test">句内</form>',
    });
    expect(label.querySelector('img')).toBeNull();
    expect(label.querySelector('form')).toBeNull();
    expect(label.querySelector('input')!.value).toBe('inline');
    expect(label.querySelector('.mode-name')!.textContent).toBe('<img src=x>段内');
    expect(label.querySelector('.mode-desc')!.textContent).toBe(
      '<form action="https://evil.test">句内</form>',
    );
  });
});
