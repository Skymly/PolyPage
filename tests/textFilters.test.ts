import { describe, expect, it } from 'vitest';
import { filterText } from '../src/shared/textFilters';

describe('filterText', () => {
  it('keeps normal prose', () => {
    expect(filterText('This is a normal sentence about something.', 6).skip).toBe(false);
  });
  it('skips empty and too-short text', () => {
    expect(filterText('', 6).reason).toBe('empty');
    expect(filterText('  ok  ', 6).reason).toBe('too_short');
  });
  it('skips pure numbers', () => {
    expect(filterText('1,234,567', 6).reason).toBe('digits');
    expect(filterText('42% + 3.14', 6).reason).toBe('digits');
  });
  it('skips URLs', () => {
    expect(filterText('https://example.com/a/b?c=1', 6).reason).toBe('url');
    expect(filterText('www.example.com/path', 6).reason).toBe('url');
  });
  it('skips emails', () => {
    expect(filterText('someone@example.com', 6).reason).toBe('email');
  });
  it('skips code-like fragments', () => {
    expect(filterText('if (x) { return 1; } else { return 2; }', 6).reason).toBe('code');
  });
  it('does not skip sentences mentioning domains in prose', () => {
    expect(filterText('Visit example.com for details about the product.', 6).skip).toBe(false);
  });
});
