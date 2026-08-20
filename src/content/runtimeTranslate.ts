/**
 * chrome.runtime adapter for 网页翻译. Stream port stays here; NodeEntry does not.
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
  },
) => Promise<TranslateResults>;

export const defaultRuntimeTranslateItems: TranslateItemsFn = async (items, opts) => {
  const domain = opts?.domain ?? (typeof location !== 'undefined' ? location.hostname : undefined);
  if (opts?.onDelta) {
    return streamViaPort(items, opts.onDelta, domain);
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
): Promise<TranslateResults> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const results: TranslateResults = { results: {}, errors: {} };
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        /* already closed */
      }
      resolve(results);
    };
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as StreamPortMessage;
      if (msg.type === 'delta') onDelta(msg.key, msg.delta);
      else if (msg.type === 'done') results.results[msg.key] = msg.text;
      else if (msg.type === 'error') {
        results.errors[msg.key] = { kind: (msg.kind as ErrorKind) ?? 'unknown', message: msg.message };
      } else if (msg.type === 'finished') finish();
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      for (const item of items) {
        if (results.results[item.key] === undefined && results.errors[item.key] === undefined) {
          results.errors[item.key] = { kind: 'network', message: '流式连接中断' };
        }
      }
      finish();
    });
    const init: StreamPortInit = { items, domain };
    port.postMessage(init);
  });
}