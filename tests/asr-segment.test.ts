/**
 * ASR cue segmentation (spec 4.0 §5.4, §12.1):
 * backend segments / even split / >80 chars recut / drop empty.
 */
import { describe, expect, it } from 'vitest';
import { ASR_MAX_CUE_CHARS, segmentTranscript } from '../src/asr/segment';

describe('segmentTranscript', () => {
  it('prefers backend segments and drops empty ones', () => {
    const cues = segmentTranscript(
      {
        text: 'ignored when segments exist',
        segments: [
          { start: 1, end: 2, text: 'Hello there' },
          { start: 2, end: 3, text: '   ' },
          { start: 3, end: 4, text: 'General Kenobi' },
        ],
      },
      0,
      10,
    );
    expect(cues).toEqual([
      { start: 1, end: 2, text: 'Hello there' },
      { start: 3, end: 4, text: 'General Kenobi' },
    ]);
  });

  it('splits plain text on sentence punctuation and assigns even timestamps', () => {
    const cues = segmentTranscript({ text: 'Hello there. General Kenobi.' }, 10, 8);
    expect(cues.map((c) => c.text)).toEqual(['Hello there.', 'General Kenobi.']);
    expect(cues[0].start).toBe(10);
    expect(cues[0].end).toBe(14);
    expect(cues[1].start).toBe(14);
    expect(cues[1].end).toBe(18);
  });

  it('recuts a cue longer than 80 characters', () => {
    const long = 'A'.repeat(ASR_MAX_CUE_CHARS + 20);
    const cues = segmentTranscript({ text: long }, 0, 4);
    expect(cues.length).toBe(2);
    expect(cues.every((c) => c.text.length <= ASR_MAX_CUE_CHARS)).toBe(true);
    expect(cues.map((c) => c.text).join('')).toBe(long);
    expect(cues[0].start).toBe(0);
    expect(cues[cues.length - 1].end).toBeCloseTo(4);
  });

  it('drops empty fragments from plain text', () => {
    expect(segmentTranscript({ text: '   \n\n  ' }, 0, 5)).toEqual([]);
  });
});
