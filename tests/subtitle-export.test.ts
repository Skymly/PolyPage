import { describe, expect, it } from 'vitest';
import { bilingualSrt, mergeWatchedIntervals, translatedIntervals } from '../src/content/subtitleExport';

describe('字幕导出', () => {
  it('combines replayed portions of a caption without filling unwatched gaps', () => {
    const cue = { text: 'Replay', translation: '回放' };
    expect(mergeWatchedIntervals([
      { ...cue, startTime: 7, endTime: 8 }, { ...cue, startTime: 1.3, endTime: 3 },
      { ...cue, startTime: 1.1, endTime: 2 },
    ])).toEqual([{ ...cue, startTime: 1.1, endTime: 3 }, { ...cue, startTime: 7, endTime: 8 }]);
  });
  it('uses the displayed translation for overlapping cues and preserves the source line breaks', () => {
    const cues = [
      { startTime: 1, endTime: 3, text: 'A\nB' },
      { startTime: 2, endTime: 4, text: '<i>C</i>' },
      { startTime: 5, endTime: 6, text: 'Unseen' },
    ];
    const dictionary = new Map([['A B', '甲\n乙'], ['A B C', '合译']]);
    const rows = translatedIntervals(cues, text => dictionary.get(text) ?? null);
    expect(bilingualSrt(rows)).toBe('\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nA\r\nB\r\n甲\r\n乙\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nA\r\nB\r\nC\r\n合译\r\n');
  });

  it('sorts by media time and omits unobserved or zero-duration spans', () => {
    const result = bilingualSrt([
      { startTime: 3600.0501, endTime: 3600.251, text: 'Later', translation: '后' },
      { startTime: .123, endTime: 1, text: 'Start', translation: '先' },
      { startTime: 1, endTime: 1.0001, text: 'Empty', translation: '空' },
    ]);
    expect(result).toContain('1\r\n00:00:00,123 --> 00:00:01,000');
    expect(result).toContain('2\r\n01:00:00,050 --> 01:00:00,251');
    expect(result).not.toContain('Empty');
    expect(bilingualSrt([{ startTime: 0, endTime: 2, text: 'only source' }])).toBe('');
  });
});
