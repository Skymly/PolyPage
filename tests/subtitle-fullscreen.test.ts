/**
 * Subtitle layer follows native fullscreen (M-32).
 */
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubtitleManager, subtitleLayerParent } from '../src/content/media';

function setFullscreen(element: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });
  document.dispatchEvent(new Event('fullscreenchange'));
}

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
  const manager = new SubtitleManager();

  afterEach(() => {
    manager.restoreAll();
    setFullscreen(null);
    document.body.replaceChildren();
  });

  it('moves the subtitle host into the fullscreen element', () => {
    document.body.innerHTML = '<div id="player"><video id="v"></video></div>';
    const player = document.getElementById('player') as HTMLDivElement;
    const video = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 1 });
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

  it('opens the active video overlay above native fullscreen and clears the popover on exit', () => {
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector('video')!;
    manager.applyMemoryCues(video, [{ startTime: 0, endTime: 2, text: 'hi', translation: '你好' }]);
    const host = document.querySelector<HTMLElement>('.wt-subtitle-host')!;
    let open = false;
    host.showPopover = vi.fn(() => { open = true; });
    host.hidePopover = vi.fn(() => { open = false; });
    vi.spyOn(host, 'matches').mockImplementation((selector) => selector === ':popover-open' && open);

    setFullscreen(video);
    expect(host.parentElement).toBe(document.documentElement);
    expect(host.getAttribute('popover')).toBe('manual');
    expect(host.showPopover).toHaveBeenCalledOnce();

    setFullscreen(null);
    expect(host.hidePopover).toHaveBeenCalledOnce();
    expect(host.hasAttribute('popover')).toBe(false);
    expect(host.parentElement).toBe(document.documentElement);
  });

  it('restores the original track in native fullscreen when popovers are unavailable', () => {
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector('video')!;
    const track = Object.assign(new EventTarget(), { kind: 'subtitles', mode: 'showing' });
    Object.defineProperty(video, 'textTracks', { value: [track] });
    expect(manager.toggle()).toBe('on');

    const host = document.querySelector<HTMLElement>('.wt-subtitle-host')!;
    Object.defineProperty(host, 'showPopover', { value: undefined });
    expect(track.mode).toBe('hidden');
    setFullscreen(video);
    expect(track.mode).toBe('showing');
    expect(host.style.display).toBe('none');

    setFullscreen(null);
    expect(track.mode).toBe('hidden');
    expect(host.style.display).toBe('');
    manager.restoreAll();
    expect(track.mode).toBe('showing');
  });
});
