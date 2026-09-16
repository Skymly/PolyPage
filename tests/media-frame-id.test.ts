/**
 * Media tab commands target the top frame; cross-origin frames use the tab host (M-51).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_COMMAND_FRAME_ID, sendTabCommand } from '../src/messaging/messages';
import { hostBlacklisted, hostnameFromUrl, resolveBlacklistHost } from '../src/content/rules';

describe('resolveBlacklistHost (M-51)', () => {
  it('uses the readable top host when the frame can see it', () => {
    expect(resolveBlacklistHost('news.example.com', 'other.com')).toBe('news.example.com');
  });

  it('falls back to the tab host when topLevelHostname is empty', () => {
    expect(resolveBlacklistHost('', 'blocked.example')).toBe('blocked.example');
  });

  it('makes a cross-origin empty host match the page blacklist', () => {
    const host = resolveBlacklistHost('', 'blocked.example');
    expect(hostBlacklisted('', ['blocked.example'])).toBe(false);
    expect(hostBlacklisted(host, ['blocked.example'])).toBe(true);
  });
});

describe('hostnameFromUrl (M-51)', () => {
  it('reads the hostname from a tab URL', () => {
    expect(hostnameFromUrl('https://blocked.example/path')).toBe('blocked.example');
  });

  it('returns empty for missing or invalid URLs', () => {
    expect(hostnameFromUrl(undefined)).toBe('');
    expect(hostnameFromUrl('not-a-url')).toBe('');
  });
});

describe('sendTabCommand frameId (M-51)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards frameId so media commands do not fan out to every frame', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('chrome', {
      runtime: { lastError: undefined },
      tabs: {
        sendMessage: (
          tabId: number,
          message: unknown,
          options: unknown,
          cb?: (res: unknown) => void,
        ) => {
          calls.push({ tabId, message, options });
          const reply = typeof options === 'function' ? options : cb;
          reply?.({ ok: true });
        },
      },
    });
    await sendTabCommand(9, { type: 'wt:transcribe-media' }, { frameId: MEDIA_COMMAND_FRAME_ID });
    expect(MEDIA_COMMAND_FRAME_ID).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tabId: 9,
      options: { frameId: 0 },
    });
  });

  it('omits options when no frameId is given', async () => {
    const arities: number[] = [];
    vi.stubGlobal('chrome', {
      runtime: { lastError: undefined },
      tabs: {
        sendMessage: (...args: unknown[]) => {
          arities.push(args.length);
          const cb = args[args.length - 1];
          if (typeof cb === 'function') cb({ ok: true });
        },
      },
    });
    await sendTabCommand(3, { type: 'wt:translate' });
    expect(arities).toEqual([3]);
  });
});
