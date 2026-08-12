/**
 * Content script bootstrap.
 * Wires the PageTranslator, DOM observer and the popup/background commands.
 */
import { sendRuntime } from '../messaging/messages';
import type { TabCommand } from '../messaging/messages';
import { BILINGUAL_CLASS } from '../shared/constants';
import type { ContentSettings } from '../shared/types';
import { DomObserver } from './observer';
import { PageTranslator } from './translator';

const translator = new PageTranslator();
translator.init();

let contentSettings: ContentSettings | null = null;

function isOwnNode(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  if (node.classList.contains(BILINGUAL_CLASS) || node.classList.contains('wt-tooltip-host')) {
    return true;
  }
  return node.closest(`.${BILINGUAL_CLASS}, .wt-tooltip-host`) !== null;
}

const observer = new DomObserver(
  () => {
    if (translator.active) translator.rescan();
  },
  isOwnNode,
);

function hostBlacklisted(hostname: string, blacklist: string[]): boolean {
  const host = hostname.toLowerCase();
  return blacklist.some((entry) => {
    const domain = entry.trim().toLowerCase();
    if (domain === '') return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

async function handleCommand(cmd: TabCommand): Promise<unknown> {
  switch (cmd.type) {
    case 'wt:get-state':
      return translator.state();
    case 'wt:translate': {
      const mode = cmd.mode ?? contentSettings?.defaultDisplayMode ?? 'bilingual';
      void translator.translate(mode);
      return { ok: true };
    }
    case 'wt:restore':
      translator.restore();
      return { ok: true };
    case 'wt:toggle': {
      if (translator.active) {
        translator.restore();
      } else {
        const mode = contentSettings?.defaultDisplayMode ?? 'bilingual';
        void translator.translate(mode);
      }
      return { ok: true };
    }
    case 'wt:set-mode':
      void translator.setMode(cmd.mode);
      return { ok: true };
    case 'wt:retry-failed':
      void translator.retryFailed();
      return { ok: true };
    case 'wt:rescan':
      translator.rescan();
      return { ok: true };
    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((message: TabCommand, _sender, sendResponse) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('wt:')) return false;
  void handleCommand(message).then(sendResponse);
  return true; // async response
});

async function init(): Promise<void> {
  try {
    contentSettings = await sendRuntime({ type: 'get-content-settings' });
  } catch {
    return; // background unavailable; popup actions will still work when it wakes up
  }
  translator.minTextLength = contentSettings.minTextLength;
  if (hostBlacklisted(location.hostname, contentSettings.blacklist)) {
    translator.blacklisted = true;
    return;
  }
  // Initial scan so the popup can report how many paragraphs were found
  // before the user triggers any translation.
  translator.scan();
  observer.start();
  if (contentSettings.autoTranslate) {
    void translator.translate(contentSettings.defaultDisplayMode);
  }
}

void init();
