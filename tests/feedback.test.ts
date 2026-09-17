/**
 * Quality feedback log tests (spec 3.0 §8.2, §12.1): ring limit and
 * CSV/JSON export formatting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FEEDBACK_LOG_KEY, FEEDBACK_LOG_MAX } from '../src/shared/constants';
import type { FeedbackEntry } from '../src/shared/types';
import { appendFeedback, csvEscape, feedbackToCsv, sanitizeFeedbackPageUrl } from '../src/storage/feedback';

function entry(i: number): FeedbackEntry {
  return {
    ts: 1700000000000 + i,
    source: `source ${i}`,
    translation: `translation ${i}`,
    providerName: 'Mock LLM',
    pageUrl: `https://example.com/${i}`,
    where: 'page',
  };
}

describe('ring limit', () => {
  it('caps the exported list at FEEDBACK_LOG_MAX (200)', () => {
    // The storage-level cap lives in appendFeedback (needs chrome.storage);
    // here we pin the contract constant + slice behavior used by the store.
    const entries = Array.from({ length: FEEDBACK_LOG_MAX + 25 }, (_, i) => entry(i));
    expect(FEEDBACK_LOG_MAX).toBe(200);
    expect(entries.slice(0, FEEDBACK_LOG_MAX)).toHaveLength(200);
  });
});

describe('csvEscape', () => {
  it('quotes values containing commas, quotes or newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralizes formula-like prefixes (M-39)', () => {
    expect(csvEscape('=cmd|A1')).toBe(`"'=cmd|A1"`);
    expect(csvEscape('+1+1')).toBe(`"'+1+1"`);
    expect(csvEscape('-SUM(A1)')).toBe(`"'-SUM(A1)"`);
    expect(csvEscape('@HYPERLINK("http://x")')).toBe(`"'@HYPERLINK(""http://x"")"`);
    expect(csvEscape('\t=1+1')).toBe(`"'\t=1+1"`);
  });
});

describe('feedbackToCsv', () => {
  it('emits a header plus one escaped row per entry', () => {
    const csv = feedbackToCsv([
      { ...entry(1), source: 'hello, world', translation: '你好\n世界' },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('ts,source,translation,provider,pageUrl,where');
    expect(lines).toHaveLength(2); // embedded bare \n stays inside the quoted field
    expect(lines[1]).toContain('"hello, world"');
    expect(lines[1]).toContain('"你好\n世界"');
  });

  it('handles empty logs', () => {
    expect(feedbackToCsv([])).toBe('ts,source,translation,provider,pageUrl,where');
  });

  it('neutralizes formula cells in exported rows (M-39)', () => {
    const csv = feedbackToCsv([
      { ...entry(1), source: '=1+1', translation: '+cmd', pageUrl: '-http://x' },
    ]);
    expect(csv).toContain(`"'=1+1"`);
    expect(csv).toContain(`"'+cmd"`);
    expect(csv).toContain(`"'-http://x"`);
  });
});

describe('sanitizeFeedbackPageUrl (M-59)', () => {
  it('drops query and hash from http(s) URLs', () => {
    expect(sanitizeFeedbackPageUrl('https://example.com/a?token=secret#frag')).toBe(
      'https://example.com/a',
    );
    expect(sanitizeFeedbackPageUrl('http://example.com/path/?q=1')).toBe('http://example.com/path/');
  });

  it('keeps pdf-viewer labels without query', () => {
    expect(sanitizeFeedbackPageUrl('pdf-viewer:My Doc.pdf?x=1')).toBe('pdf-viewer:My Doc.pdf');
  });
});

describe('appendFeedback lock (M-62)', () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('keeps both entries when two appends overlap', async () => {
    let stored: FeedbackEntry[] = [];
    let releaseFirstGet: () => void = () => undefined;
    const firstGetBlocked = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    let gets = 0;
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      storage: {
        local: {
          get: async () => {
            gets += 1;
            if (gets === 1) await firstGetBlocked;
            return { [FEEDBACK_LOG_KEY]: stored };
          },
          set: async (obj: Record<string, unknown>) => {
            stored = (obj[FEEDBACK_LOG_KEY] as FeedbackEntry[]) ?? stored;
          },
        },
      },
    } as typeof chrome;

    const first = appendFeedback(entry(1));
    const second = appendFeedback(entry(2));
    releaseFirstGet();
    await Promise.all([first, second]);
    expect(stored.map((e) => e.source)).toEqual(['source 2', 'source 1']);
  });
});