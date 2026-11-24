/**
 * chrome.runtime adapter for content-script translations.
 */
import { sendRuntime } from '../messaging/messages';
import { STREAM_PORT_NAME } from '../messaging/messages';
import type { StreamPortInit, StreamPortMessage } from '../messaging/messages';
import type { ErrorKind, TranslateResults, TranslationItem } from '../shared/types';

export type TranslateItemsFn = (
  items: TranslationItem[],
  opts?: {
    onDelta?: (key: string, delta: string) => void;
    pageLanguage?: string | null;
    domain?: string;
    signal?: AbortSignal;
  },
) => Promise<TranslateResults>;

export const defaultRuntimeTranslateItems: TranslateItemsFn = async (items, opts) => {
  const domain = opts?.domain ?? (typeof location !== 'undefined' ? location.hostname : undefined);
  if (opts?.onDelta) {
    return streamViaPort(items, opts.onDelta, domain, opts.signal, opts.pageLanguage);
  }
  return sendRuntime({
    type: 'translate',
    items,
    domain,
    pageLanguage: opts?.pageLanguage,
  });
};

function streamViaPort(
  items: TranslationItem[],
  onDelta: (key: string, delta: string) => void,
  domain?: string,
  signal?: AbortSignal,
  pageLanguage?: string | null,
): Promise<TranslateResults> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    const results: TranslateResults = { results: {}, errors: {} };
    let settled = false;
    const close = (): boolean => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', abort);
      try {
        port.disconnect();
      } catch {
        /* already closed */
      }
      return true;
    };
    const finish = (): void => {
      if (close()) resolve(results);
    };
    const abort = (): void => {
      if (close()) reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    port.onMessage.addListener((raw: unknown) => {
      if (settled) return;
      const msg = raw as StreamPortMessage;
      if (msg.type === 'delta') onDelta(msg.key, msg.delta);
      else if (msg.type === 'done') results.results[msg.key] = msg.text;
      else if (msg.type === 'error') {
        results.errors[msg.key] = { kind: (msg.kind as ErrorKind) ?? 'unknown', message: msg.message };
      } else if (msg.type === 'finished') finish();
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (settled) return;
      for (const item of items) {
        if (results.results[item.key] === undefined && results.errors[item.key] === undefined) {
          results.errors[item.key] = { kind: 'network', message: '流式连接中断' };
        }
      }
      finish();
    });
    const init: StreamPortInit = { items, domain, pageLanguage };
    try {
      port.postMessage(init);
    } catch (error) {
      if (close()) reject(error);
    }
  });
}
