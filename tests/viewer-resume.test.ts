import { describe, expect, it } from 'vitest';
import { pdfScopedCacheText } from '../src/viewer/pdf/fingerprint';
import {
  matchPdfResumeTasks,
  parsePdfParagraphKey,
  pdfParagraphKey,
} from '../src/viewer/resume';
import { hashText } from '../src/shared/utils';

describe('pdfParagraphKey (M-03)', () => {
  it('is stable across todo-list order (page + paragraph index)', () => {
    expect(pdfParagraphKey(2, 3)).toBe('p2-3');
    expect(parsePdfParagraphKey('p2-3')).toEqual({ pageIndex: 2, paraIndex: 3 });
    expect(parsePdfParagraphKey('wt-1')).toBeNull();
  });
});

describe('matchPdfResumeTasks (M-03)', () => {
  const fingerprint = 'fileid:abc';
  const pages = [
    {
      index: 1,
      paragraphs: [
        { text: 'Hello world from the first paragraph.', status: 'error' as const },
        { text: 'Second paragraph stays idle.', status: 'idle' as const },
        { text: 'Already done.', status: 'done' as const },
      ],
    },
  ];

  function hashFor(paraIndex: number, text: string): string {
    return hashText(pdfScopedCacheText(fingerprint, 1, paraIndex, text));
  }

  it('re-submits matching error/idle paragraphs and skips hash mismatches and done', () => {
    const tasks = [
      { key: pdfParagraphKey(1, 0), textHash: hashFor(0, pages[0].paragraphs[0].text) },
      { key: pdfParagraphKey(1, 1), textHash: 'not-the-hash' },
      { key: pdfParagraphKey(1, 2), textHash: hashFor(2, pages[0].paragraphs[2].text) },
      { key: 'wt-1', textHash: 'x' },
    ];
    const hits = matchPdfResumeTasks(pages, tasks, fingerprint);
    expect(hits.map((h) => h.key)).toEqual(['p1-0']);
    expect(hits[0].paraIndex).toBe(0);
  });
});
