/**
 * M-61: restoreAll must drop controller map entries and capture listeners.
 */
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { SubtitleManager } from '../src/content/media';

describe('SubtitleManager teardown (M-61)', () => {
  it('restoreAll deletes controllers and unwires capture listeners', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const video = document.getElementById('v') as HTMLVideoElement;
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const manager = new SubtitleManager();
    manager.applyMemoryCues(video, [{ startTime: 0, endTime: 1, text: 'hi' }]);
    expect(manager.controllerCount).toBe(1);
    expect(manager.interactionWired).toBe(true);
    expect(add).toHaveBeenCalledWith('mouseenter', expect.any(Function), true);
    manager.restoreAll();
    expect(manager.controllerCount).toBe(0);
    expect(manager.interactionWired).toBe(false);
    expect(remove).toHaveBeenCalledWith('mouseenter', expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith('click', expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith('fullscreenchange', expect.any(Function));
  });
});
