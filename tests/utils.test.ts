import { describe, expect, it } from 'vitest';
import {
  chunkItems,
  escapeForJsonString,
  getByPath,
  hashText,
  parseBatchTranslation,
  renderTemplate,
  stripCodeFences,
} from '../src/shared/utils';

describe('renderTemplate', () => {
  it('replaces known variables', () => {
    expect(
      renderTemplate('Translate {{text}} to {{targetLanguage}}', {
        text: 'hello',
        targetLanguage: '中文',
      }),
    ).toBe('Translate hello to 中文');
  });

  it('keeps unknown variables untouched', () => {
    expect(renderTemplate('a {{missing}} b', {})).toBe('a {{missing}} b');
  });

  it('tolerates spaces inside braces', () => {
    expect(renderTemplate('{{ text }}', { text: 'x' })).toBe('x');
  });
});

describe('escapeForJsonString', () => {
  it('escapes quotes, backslashes and newlines', () => {
    expect(escapeForJsonString('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });
});

describe('getByPath', () => {
  const data = { data: { translations: ['a', 'b'], nested: { value: 42 } } };
  it('reads nested values', () => {
    expect(getByPath(data, 'data.translations')).toEqual(['a', 'b']);
    expect(getByPath(data, 'data.nested.value')).toBe(42);
  });
  it('supports numeric segments for arrays', () => {
    expect(getByPath(data, 'data.translations.1')).toBe('b');
  });
  it('returns undefined for missing paths and empty path returns root', () => {
    expect(getByPath(data, 'data.nope')).toBeUndefined();
    expect(getByPath(data, '')).toBe(data);
    expect(getByPath(data, undefined)).toBe(data);
  });
});

describe('hashText', () => {
  it('is deterministic and distinct', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});

describe('chunkItems', () => {
  const items = ['aaaa', 'bbbb', 'cccc', 'dddd'];
  it('respects max item count', () => {
    const batches = chunkItems(items, 2, 1000, (s) => s);
    expect(batches.map((b) => b.items.length)).toEqual([2, 2]);
  });
  it('respects max char budget', () => {
    const batches = chunkItems(items, 10, 8, (s) => s);
    expect(batches.map((b) => b.items)).toEqual([
      ['aaaa', 'bbbb'],
      ['cccc', 'dddd'],
    ]);
  });
  it('isolates oversized single items', () => {
    const batches = chunkItems(['x'.repeat(50), 'yy'], 10, 10, (s) => s);
    expect(batches.length).toBe(2);
    expect(batches[0].items).toEqual(['x'.repeat(50)]);
  });
});

describe('stripCodeFences', () => {
  it('strips ```json fences', () => {
    expect(stripCodeFences('```json\n["a"]\n```')).toBe('["a"]');
  });
  it('returns plain text trimmed', () => {
    expect(stripCodeFences('  hi  ')).toBe('hi');
  });
});

describe('parseBatchTranslation', () => {
  it('parses a JSON array', () => {
    expect(parseBatchTranslation('["一", "二"]', 2)).toEqual(['一', '二']);
  });
  it('parses a fenced JSON array', () => {
    expect(parseBatchTranslation('```json\n["一","二"]\n```', 2)).toEqual(['一', '二']);
  });
  it('parses a numbered list', () => {
    const reply = '1) 第一条\n2) 第二条';
    expect(parseBatchTranslation(reply, 2)).toEqual(['第一条', '第二条']);
  });
  it('parses multi-line numbered items', () => {
    const reply = '1. line one\ncontinued\n2. second';
    expect(parseBatchTranslation(reply, 2)).toEqual(['line one\ncontinued', 'second']);
  });
  it('returns the whole reply for single-item batches', () => {
    expect(parseBatchTranslation('just text', 1)).toEqual(['just text']);
  });
  it('rejects mismatched counts', () => {
    expect(parseBatchTranslation('["only one"]', 2)).toBeNull();
    expect(parseBatchTranslation('', 1)).toBeNull();
  });
});
