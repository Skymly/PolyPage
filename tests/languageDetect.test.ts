/**
 * Language detector tests (spec 3.0 §8.1, §12.1): 12-language sample corpus
 * must classify at >= 90% accuracy, plus edge cases (empty, uncertain,
 * mixed-script guard behavior).
 */
import { describe, expect, it } from 'vitest';
import { countScripts, detectLanguage, stopwordVotes } from '../src/shared/languageDetect';

/** One representative sample per supported language. */
const CORPUS: { lang: string; samples: string[] }[] = [
  {
    lang: 'zh',
    samples: ['开源软件改变了世界，越来越多的公司开始拥抱开源社区。'],
  },
  {
    lang: 'en',
    samples: ['The quick brown fox jumps over the lazy dog and the cat is on the mat.'],
  },
  {
    lang: 'ja',
    samples: ['オープンソースソフトウェアは世界を変えました。多くの会社が利用しています。'],
  },
  {
    lang: 'ko',
    samples: ['오픈 소스 소프트웨어는 세상을 바꾸었습니다. 많은 회사가 사용하고 있습니다.'],
  },
  {
    lang: 'ru',
    samples: ['Открытое программное обеспечение изменило мир, и многие компании используют его.'],
  },
  {
    lang: 'es',
    samples: ['El software de código abierto ha cambiado el mundo y muchas empresas lo utilizan.'],
  },
  {
    lang: 'fr',
    samples: ['Le logiciel open source a changé le monde et de nombreuses entreprises utilisent cette technologie.'],
  },
  {
    lang: 'de',
    samples: ['Die Open-Source-Software hat die Welt verändert und viele Unternehmen nutzen sie.'],
  },
  {
    lang: 'it',
    samples: ['Il software open source ha cambiato il mondo e molte aziende lo utilizzano ogni giorno.'],
  },
  {
    lang: 'pt',
    samples: ['O software de código aberto mudou o mundo e muitas empresas o utilizam diariamente.'],
  },
  {
    lang: 'nl',
    samples: ['De open source software heeft de wereld veranderd en veel bedrijven gebruiken het.'],
  },
  {
    lang: 'ar',
    samples: ['غيّرت البرمجيات مفتوحة المصدر العالم، وتستخدمها العديد من الشركات حول العالم.'],
  },
];

describe('detectLanguage 12-language corpus (spec: >= 90%)', () => {
  it('classifies each sample correctly', () => {
    let correct = 0;
    const misses: string[] = [];
    for (const { lang, samples } of CORPUS) {
      const result = detectLanguage(samples);
      if (result.language === lang) correct++;
      else misses.push(`${lang} -> ${result.language} ${JSON.stringify(result.scores)}`);
    }
    expect(correct / CORPUS.length, misses.join(' | ')).toBeGreaterThanOrEqual(0.9);
    expect(misses).toEqual([]);
  });

  it('reports confidence for script-unambiguous languages', () => {
    expect(detectLanguage(['开源软件改变了世界']).confident).toBe(true);
    expect(detectLanguage(['오픈 소스 소프트웨어는 세상을 바꾸었습니다']).language).toBe('ko');
    expect(detectLanguage(['オープンソースは世界を変えたと思います']).language).toBe('ja');
  });
});

describe('detectLanguage edge cases', () => {
  it('returns null language for empty input', () => {
    expect(detectLanguage([])).toEqual({ language: null, confident: false, scores: {} });
    expect(detectLanguage(['', '   ']).language).toBeNull();
  });

  it('does not force a winner on stopword-free Latin text', () => {
    const result = detectLanguage(['Xylophia zanzibar quorum vexing']);
    expect(result.language).toBeNull();
  });

  it('handles multiple samples with voting', () => {
    const result = detectLanguage([
      'The committee reviewed the proposal and the budget.',
      'It is important that the report is complete and accurate.',
      'This is the third paragraph with enough words to vote.',
    ]);
    expect(result.language).toBe('en');
    expect(result.confident).toBe(true);
  });

  it('mixes scripts without crashing (ja with kanji + kana)', () => {
    const counts = countScripts('日本語のテスト text');
    expect(counts.han).toBeGreaterThan(0);
    expect(counts.hiragana).toBeGreaterThan(0);
    expect(counts.latin).toBeGreaterThan(0);
  });

  it('stopword votes accumulate across samples', () => {
    const votes = stopwordVotes(['the cat and the dog', 'that is a house']);
    expect(votes.en).toBeGreaterThan(0);
    expect(votes.fr).toBe(0);
  });
});