// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubtitleManager } from '../src/content/media';
import { ImageTranslateController } from '../src/content/imageButton';
import { sendRuntime } from '../src/messaging/messages';

vi.mock('../src/messaging/messages', () => ({ sendRuntime: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

describe('media reading regressions', () => {
  it('translates only the selected native track and follows a new language', async () => {
    const v = document.createElement('video');
    document.body.append(v);
    function track(mode: TextTrackMode, text: string) {
      return Object.assign(new EventTarget(), { mode, kind: 'subtitles', cues: [{ startTime: 0, endTime: 1, text }] });
    }
    const en = track('showing', 'Hello');
    const fr = track('disabled', 'Bonjour');
    const tracks = Object.assign(new EventTarget(), { 0: en, 1: fr, length: 2 });
    Object.defineProperty(v, 'textTracks', { value: tracks });
    vi.mocked(sendRuntime).mockResolvedValue({ ok: true, translated: '你好' });
    const manager = new SubtitleManager();
    try {
      manager.toggle();
      await Promise.resolve();
      expect(sendRuntime).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello' }));
      fr.mode = 'showing';
      en.mode = 'disabled';
      tracks.dispatchEvent(new Event('change'));
      expect(sendRuntime).toHaveBeenCalledWith(expect.objectContaining({ text: 'Bonjour' }));
    } finally { manager.restoreAll(); }
    expect(fr.mode).toBe('showing');
    expect(en.mode).toBe('disabled');
  });

  it('discards a late OCR result after the panel closes', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(sendRuntime).mockImplementation(((message: { type: string }) =>
      message.type === 'ocr-request' ? new Promise<unknown>(resolve => { finish = resolve; }) : Promise.resolve({ ok: true })) as typeof sendRuntime);
    const ctl = new ImageTranslateController();
    const shadow = vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
      return Element.prototype.attachShadow.call(this, { ...init, mode: 'open' });
    });
    try {
      ctl.translateImage('https://example.test/photo.png', undefined, true);
      const close = document.querySelector('.wt-ocr-host')!.shadowRoot!.querySelectorAll('button')[1];
      close.click();
      finish({ ok: true, segments: [{ text: 'Hi', translation: '好' }] });
      await Promise.resolve();
      expect(document.querySelector('.wt-ocr-host')).toBeNull();
    } finally { shadow.mockRestore(); document.querySelector('.wt-ocr-host')?.remove(); }
  });
});
