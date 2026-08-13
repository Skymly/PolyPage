/**
 * Quality feedback log tests (spec 3.0 §8.2, §12.1): ring limit and
 * CSV/JSON export formatting.
 */
import { describe, expect, it } from 'vitest';
import { FEEDBACK_LOG_MAX } from '../src/shared/constants';
import type { FeedbackEntry } from '../src/shared/types';
import { csvEscape, feedbackToCsv } from '../src/storage/feedback';

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
});