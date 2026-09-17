/**
 * M-61: restorePageLayers must stop the DOM observer; translate restarts it.
 */
import { describe, expect, it } from 'vitest';
import { restorePage } from '../src/content/restorePage';

describe('restorePage observer stop (M-61)', () => {
  it('stops the observer after overlay teardown', () => {
    const order: string[] = [];
    restorePage({
      abortAsr() {
        order.push('asr');
        return null;
      },
      restoreTranslator() {
        order.push('translator');
      },
      restoreSubtitles() {
        order.push('subtitles');
      },
      removeOverlay() {
        order.push('overlay');
      },
      stopObserver() {
        order.push('observer');
      },
      scheduleReport() {
        order.push('report');
      },
    });
    expect(order).toEqual(['asr', 'translator', 'subtitles', 'overlay', 'observer', 'report']);
  });
});
