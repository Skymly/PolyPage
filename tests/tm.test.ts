/**
 * Sentence TM (spec 4.1 pillar M / 12.1): normalize hit / miss / ring eviction
 * / disabled does not write.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryTmStore,
  TranslationMemory,
  isTmEligible,
  normalizeTmSource,
  tmEntryHash,
  tmLangPair,
} from '../src/storage/tm';

const PAIR = tmLangPair('English', 'Chinese');

describe('normalizeTmSource', () => {
  it('folds NFKC + whitespace and strips edge punctuation', () => {
    expect(normalizeTmSource('  Hello,   world!  ')).toBe('Hello, world');
    expect(normalizeTmSource('Hello, world')).toBe('Hello, world');
    expect(normalizeTmSource('Hello, world!')).toBe('Hello, world');
    expect(normalizeTmSource('「你好，世界。」')).toBe('你好,世界');
  });

  it('treats Hello, world! and Hello, world as the same hash', () => {
    const a = tmEntryHash(normalizeTmSource('Hello, world!'), PAIR);
    const b = tmEntryHash(normalizeTmSource('Hello, world'), PAIR);
    expect(a).toBe(b);
  });
});

describe('isTmEligible', () => {
  it('accepts 8-240 trimmed chars only', () => {
    expect(isTmEligible('1234567')).toBe(false);
    expect(isTmEligible('12345678')).toBe(true);
    expect(isTmEligible('x'.repeat(240))).toBe(true);
    expect(isTmEligible('x'.repeat(241))).toBe(false);
    expect(isTmEligible('   12345678   ')).toBe(true);
  });
});

describe('TranslationMemory', () => {
  it('hits after a remember on the normalized sentence', async () => {
    const tm = new TranslationMemory(new MemoryTmStore(), 10);
    await tm.remember([{ source: 'Hello, world!', target: '你好，世界' }], PAIR);
    const hits = await tm.lookup(
      [
        { key: 'a', text: 'Hello, world' },
        { key: 'b', text: 'Something else entirely.' },
      ],
      PAIR,
    );
    expect(hits.get('a')).toBe('你好，世界');
    expect(hits.has('b')).toBe(false);
  });

  it('does not hit a different language pair', async () => {
    const tm = new TranslationMemory(new MemoryTmStore(), 10);
    await tm.remember([{ source: 'Hello, world!', target: '你好，世界' }], PAIR);
    const hits = await tm.lookup([{ key: 'a', text: 'Hello, world!' }], tmLangPair('English', 'Japanese'));
    expect(hits.size).toBe(0);
  });

  it('does not write ineligible short/long sentences', async () => {
    const store = new MemoryTmStore();
    const tm = new TranslationMemory(store, 10);
    await tm.remember(
      [
        { source: 'short', target: '短' },
        { source: 'x'.repeat(241), target: '长' },
      ],
      PAIR,
    );
    expect((await store.getAll()).length).toBe(0);
  });

  it('evicts lowest hits then oldest ts when over maxEntries', async () => {
    const store = new MemoryTmStore();
    const tm = new TranslationMemory(store, 2);
    await tm.remember([{ source: 'AAAAAAAA', target: '甲' }], PAIR);
    await tm.remember([{ source: 'BBBBBBBB', target: '乙' }], PAIR);
    await tm.lookup([{ key: 'a', text: 'BBBBBBBB' }], PAIR);
    await tm.remember([{ source: 'CCCCCCCC', target: '丙' }], PAIR);
    const left = (await store.getAll()).map((e) => e.source).sort();
    expect(left).toEqual(['BBBBBBBB', 'CCCCCCCC']);
  });

  it('clear empties the table', async () => {
    const tm = new TranslationMemory(new MemoryTmStore(), 10);
    await tm.remember([{ source: 'Hello, world!', target: '你好，世界' }], PAIR);
    await tm.clear();
    expect((await tm.stats()).entries).toBe(0);
  });
});
