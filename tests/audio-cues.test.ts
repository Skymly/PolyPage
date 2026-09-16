/**
 * Memory cues on <audio> (M-19).
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { SubtitleManager } from '../src/content/media';

describe('applyMemoryCues on audio (M-19)', () => {
  it('mounts a subtitle host for a pure audio element', () => {
    document.body.innerHTML = '<audio id="a"></audio>';
    const audio = document.getElementById('a') as HTMLAudioElement;
    Object.defineProperty(audio, 'currentTime', { configurable: true, value: 1.5 });
    const manager = new SubtitleManager();
    manager.applyMemoryCues(audio, [
      { startTime: 0, endTime: 4, text: 'hello', translation: '你好' },
    ]);
    expect(manager.asrActive()).toBe(true);
    const host = document.querySelector('.wt-subtitle-host');
    expect(host).toBeTruthy();
    expect(host?.shadowRoot?.textContent).toContain('你好');
  });
});
