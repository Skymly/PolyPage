/**
 * Subtitle cue scheduling tests (spec 3.0 §7.1, §12.1): activation, switch,
 * cache hit, restore; plus VTT tag stripping and active-cue lookup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CueScheduler, activeCueText, stripVttTags } from '../src/content/subtitleScheduler';
import type { CueLike } from '../src/content/subtitleScheduler';

const cues: CueLike[] = [
  { startTime: 1, endTime: 3, text: 'Hello there' },
  { startTime: 3, endTime: 5, text: '<c.yellow>General Kenobi</c>' },
  { startTime: 8, endTime: 9, text: 'Hello there' }, // repeat later
];

describe('stripVttTags', () => {
  it('removes cue markup and collapses whitespace', () => {
    expect(stripVttTags('<c.yellow>Hello</c>  world')).toBe('Hello world');
    expect(stripVttTags('<00:00:01.000>Timed <b>bold</b>')).toBe('Timed bold');
    expect(stripVttTags('{\\an8}ASS override')).toBe('ASS override');
  });
});

describe('activeCueText', () => {
  it('finds the cue covering the timestamp', () => {
    expect(activeCueText(cues, 2)).toBe('Hello there');
    expect(activeCueText(cues, 4)).toBe('General Kenobi');
  });

  it('returns null in gaps', () => {
    expect(activeCueText(cues, 6)).toBeNull();
    expect(activeCueText(cues, 0)).toBeNull();
  });

  it('ends are exclusive', () => {
    expect(activeCueText(cues, 3)).toBe('General Kenobi');
  });
});

describe('CueScheduler', () => {
  it('activates: first contact requests a fetch', () => {
    const s = new CueScheduler();
    expect(s.decide(cues, 2)).toEqual({ kind: 'fetch', text: 'Hello there' });
  });

  it('does not re-fetch while pending', () => {
    const s = new CueScheduler();
    s.decide(cues, 2);
    expect(s.decide(cues, 2)).toEqual({ kind: 'show', text: 'Hello there', translation: null });
  });

  it('shows the translation once resolved', () => {
    const s = new CueScheduler();
    s.decide(cues, 2);
    s.resolve('Hello there', '你好');
    expect(s.decide(cues, 2)).toEqual({ kind: 'show', text: 'Hello there', translation: '你好' });
  });

  it('switch: moving to the next cue fetches it', () => {
    const s = new CueScheduler();
    s.decide(cues, 2);
    s.resolve('Hello there', '你好');
    expect(s.decide(cues, 4)).toEqual({ kind: 'fetch', text: 'General Kenobi' });
  });

  it('cache hit: repeated cue text skips the fetch (字幕重复率高)', () => {
    const s = new CueScheduler();
    s.decide(cues, 2);
    s.resolve('Hello there', '你好');
    s.decide(cues, 4);
    s.resolve('General Kenobi', '肯诺比');
    expect(s.decide(cues, 8.5)).toEqual({ kind: 'show', text: 'Hello there', translation: '你好' });
  });

  it('restore: reset clears all state (关闭还原)', () => {
    const s = new CueScheduler();
    s.decide(cues, 2);
    s.resolve('Hello there', '你好');
    s.reset();
    expect(s.hasCached('Hello there')).toBe(false);
    expect(s.decide(cues, 2)).toEqual({ kind: 'fetch', text: 'Hello there' });
  });

  it('failed translations retry after a cooldown (no per-tick spam)', () => {
    vi.useFakeTimers();
    try {
      const s = new CueScheduler();
      s.decide(cues, 2);
      s.resolve('Hello there', null);
      expect(s.hasCached('Hello there')).toBe(false);
      // Immediately after failure: placeholder, no re-fetch storm.
      expect(s.decide(cues, 2)).toEqual({ kind: 'show', text: 'Hello there', translation: null });
      // After the cooldown the cue is fetched again (retryable).
      vi.advanceTimersByTime(6000);
      expect(s.decide(cues, 2)).toEqual({ kind: 'fetch', text: 'Hello there' });
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gaps render nothing', () => {
    const s = new CueScheduler();
    expect(s.decide(cues, 6)).toEqual({ kind: 'none' });
  });
});