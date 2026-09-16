/**
 * ASR in-flight capture abort (M-10).
 */
import { describe, expect, it } from 'vitest';
import { AsrSession, delay, isAbortError, rejectWholeFileFallback, settleTabResponse } from '../src/content/media';

describe('delay (M-10)', () => {
  it('rejects when the signal aborts before the timer fires', async () => {
    const ac = new AbortController();
    const pending = delay(1000, ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(delay(1000, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('AsrSession (M-10)', () => {
  it('abort returns the requestId so restore can send asr-cancel', () => {
    const session = new AsrSession();
    const { requestId } = session.start();
    expect(session.active).toBe(true);
    expect(session.abort()).toBe(requestId);
    expect(session.active).toBe(false);
    expect(isAbortError(Object.assign(new Error('请求已取消'), { name: 'AbortError' }))).toBe(true);
  });
});

describe('rejectWholeFileFallback (M-11)', () => {
  it('returns an error instead of fetching the whole media file', () => {
    const res = rejectWholeFileFallback(new Error('captureStream 失败'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('已拒绝下载整段文件');
    expect(res.error).toContain('captureStream 失败');
  });
});

describe('settleTabResponse (M-11)', () => {
  it('still sendResponse when the command promise rejects', async () => {
    const seen: unknown[] = [];
    settleTabResponse(Promise.reject(new Error('boom')), (value) => {
      seen.push(value);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([{ ok: false, error: 'boom' }]);
  });
});
