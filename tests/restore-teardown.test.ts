/**
 * M-85: toggle-off must share restore teardown (ASR, translator, subtitles, overlay).
 */
import { describe, expect, it } from 'vitest';
import { restorePage } from '../src/content/restorePage';

describe('restorePage (M-85)', () => {
  it('runs ASR abort, translator, subtitles, overlay, then report in that order', () => {
    const order: string[] = [];
    const asrRequestId = restorePage({
      abortAsr() {
        order.push('asr');
        return 'req-1';
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
      scheduleReport() {
        order.push('report');
      },
    });
    expect(asrRequestId).toBe('req-1');
    expect(order).toEqual(['asr', 'translator', 'subtitles', 'overlay', 'report']);
  });
});
