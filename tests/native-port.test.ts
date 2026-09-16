/**
 * M-73: RPC timeout must cancel the in-flight gateway request; idle
 * disconnect must reschedule while pending.size > 0 so a timed-out
 * request cannot leak the native port.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_PORT_IDLE_MS } from '../src/shared/constants';
import { disconnectHost, nativeRequest } from '../src/background/nativePort';
import { ProviderError } from '../src/providers/provider';

const HOST = 'com.skymly.polypage.gateway';

function installNative(): {
  posted: unknown[];
  disconnected: () => boolean;
  deliver: (raw: unknown) => void;
} {
  const posted: unknown[] = [];
  let disconnected = false;
  const messageListeners: Array<(raw: unknown) => void> = [];
  const port = {
    postMessage: (m: unknown) => {
      if (disconnected) throw new Error('native port already disconnected');
      posted.push(m);
    },
    disconnect: () => {
      disconnected = true;
    },
    onMessage: {
      addListener: (fn: (raw: unknown) => void) => {
        messageListeners.push(fn);
      },
    },
    onDisconnect: { addListener: () => undefined },
  };
  vi.stubGlobal('chrome', {
    runtime: {
      connectNative: () => port,
      lastError: undefined,
    },
  });
  return {
    posted,
    disconnected: () => disconnected,
    deliver: (raw: unknown) => {
      for (const fn of messageListeners) fn(raw);
    },
  };
}

afterEach(() => {
  disconnectHost(HOST);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('nativeRequest timeout (M-73)', () => {
  it('posts a cancel notification when the RPC timer fires', async () => {
    const env = installNative();
    const pending = nativeRequest(HOST, 'translate', { texts: ['a'] }, { timeoutMs: 40 });
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    expect(env.posted).toContainEqual({ jsonrpc: '2.0', method: 'cancel', params: { id: 1 } });
  });

  it('reschedules idle so a timeout after the first idle tick still disconnects', async () => {
    vi.useFakeTimers();
    const env = installNative();
    const pending = nativeRequest(HOST, 'transcribe', {}, { timeoutMs: 90_000 });
    const rejected = expect(pending).rejects.toBeInstanceOf(ProviderError);
    await vi.advanceTimersByTimeAsync(NATIVE_PORT_IDLE_MS);
    expect(env.disconnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(env.disconnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(NATIVE_PORT_IDLE_MS);
    expect(env.disconnected()).toBe(true);
  });
});
