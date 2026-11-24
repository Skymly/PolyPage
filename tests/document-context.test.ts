import { describe, expect, it } from 'vitest';
import { boundedDocumentContext, relevantGlossary } from '../src/shared/documentContext';

describe('bounded translation references', () => {
  it('caps both labels without splitting Unicode characters and drops whitespace-only labels', () => {
    expect(boundedDocumentContext({ title: '  \n ', section: '📖'.repeat(200) })).toEqual({ section: '📖'.repeat(96) });
    expect(boundedDocumentContext({ title: '  ' })).toBeUndefined();
  });

  it('matches English words and CJK substrings, with a stable limit on complete entries', () => {
    const entries = [
      { source: '超时', target: 'timeout' },
      { source: 'port', target: '端口' },
      { source: 'Atlas', target: 'a'.repeat(1100) },
      ...Array.from({ length: 20 }, (_, i) => ({ source: 'model' + i, target: '译名' + i })),
    ];
    const result = relevantGlossary(entries, ['发生了超时错误。', 'support Atlas', entries.slice(3).map(g => g.source.toUpperCase()).join(' ')]);
    expect(result).toContain('超时 = timeout');
    expect(result).not.toMatch(/port =|Atlas =|model11 =/);
    expect(result.split('\n')).toHaveLength(13);
    expect(result.length).toBeLessThanOrEqual(1024);
    expect(relevantGlossary(entries)).toBe(''); // no recognized text yet (one-step vision or ASR)
  });
});
