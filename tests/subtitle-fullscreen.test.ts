/**
 * Subtitle layer follows native fullscreen (M-32).
 */
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { SubtitleManager, subtitleLayerParent } from '../src/content/media';

describe('subtitleLayerParent (M-32)', () => {
  it('uses documentElement when nothing is fullscreen', () => {
    expect(subtitleLayerParent()).toBe(document.documentElement);
  });

  it('uses document.fullscreenElement when present', () => {
    document.body.innerHTML = '<div id="player"></div>';
    const player = document.getElementById('player') as HTMLDivElement;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => player,
    });
    expect(subtitleLayerParent()).toBe(player);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
  });
});

describe('SubtitleManager fullscreen reparent (M-32)', () => {
  it('moves the subtitle host into the fullscreen element', () => {
    document.body.innerHTML = '<div id="player"><video id="v"></video></div>';
    const player = document.getElementById('player') as HTMLDivElement;
    const video = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 1 });
    const manager = new SubtitleManager();
    manager.applyMemoryCues(video, [{ startTime: 0, endTime: 2, text: 'hi', translation: '你好' }]);
    const host = document.querySelector('.wt-subtitle-host');
    expect(host?.parentElement).toBe(document.documentElement);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => player,
    });
    manager.syncPresentation();
    expect(host?.parentElement).toBe(player);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => null,
    });
    manager.syncPresentation();
    expect(host?.parentElement).toBe(document.documentElement);
  });
});
