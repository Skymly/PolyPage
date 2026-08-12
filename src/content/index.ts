/**
 * Content script bootstrap (2.0, spec 2.0 §9).
 * Wires the PageTranslator, DOM observer, selection translator, site rules
 * and the popup/background commands. Runs in every frame (all_frames).
 */
import { sendRuntime } from '../messaging/messages';
import type { TabCommand } from '../messaging/messages';
import {
  BILINGUAL_CLASS,
  INLINE_DST_CLASS,
  INLINE_SRC_CLASS,
  SHADOW_STYLE_ATTR,
} from '../shared/constants';
import type { ContentSettings, EffectiveRule } from '../shared/types';
import { DomObserver } from './observer';
import { effectiveRuleForHost, hostBlacklisted, topLevelHostname } from './rules';
import { SelectionTranslator } from './selection';
import { PageTranslator } from './translator';

const translator = new PageTranslator();
translator.init();

const selectionTranslator = new SelectionTranslator();

let contentSettings: ContentSettings | null = null;
let effectiveRule: EffectiveRule | null = null;

function isOwnNode(node: Node): boolean {
  if (!(node instanceof Element)) {
    // Text nodes: owned when their parent is one of our elements.
    const parent = node.parentElement;
    if (!parent) return false;
    return isOwnNode(parent);
  }
  if (node.hasAttribute?.(SHADOW_STYLE_ATTR)) return true;
  if (
    node.classList.contains(BILINGUAL_CLASS) ||
    node.classList.contains('wt-tooltip-host') ||
    node.classList.contains('wt-selection-host') ||
    node.classList.contains(INLINE_SRC_CLASS) ||
    node.classList.contains(INLINE_DST_CLASS)
  ) {
    return true;
  }
  return (
    node.closest(
      `.${BILINGUAL_CLASS}, .wt-tooltip-host, .${INLINE_SRC_CLASS}, .${INLINE_DST_CLASS}`,
    ) !== null
  );
}

const observer = new DomObserver(
  () => {
    observer.scanForShadowRoots(document.body);
    if (translator.active) {
      translator.detectRecycledNodes();
      translator.rescan();
    }
  },
  isOwnNode,
);

/* ---------------------------- frame state reporting --------------------------- */

let reportTimer: number | null = null;
translator.onStateChange = () => {
  if (reportTimer !== null) return;
  reportTimer = window.setTimeout(() => {
    reportTimer = null;
    sendRuntime({ type: 'report-frame-state', state: translator.state() }).catch(() => {
      /* background may be restarting; popup polls again later */
    });
  }, 300);
};

/* --------------------------------- commands ---------------------------------- */

function defaultMode(): ContentSettings['defaultDisplayMode'] {
  return effectiveRule?.defaultMode ?? contentSettings?.defaultDisplayMode ?? 'bilingual';
}

async function handleCommand(cmd: TabCommand): Promise<unknown> {
  switch (cmd.type) {
    case 'wt:get-state':
      return translator.state();
    case 'wt:translate': {
      const mode = cmd.mode ?? defaultMode();
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
        void translator.translate(defaultMode());
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
    case 'wt:translate-selection':
      return { ok: selectionTranslator.translateCurrentSelection() };
    case 'wt:collect-export':
      return translator.collectExport();
    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((message: TabCommand, _sender, sendResponse) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('wt:')) return false;
  void handleCommand(message).then(sendResponse);
  return true; // async response
});

/* ----------------------------------- init ------------------------------------ */

async function init(): Promise<void> {
  let summary: { providerType?: string } | null = null;
  try {
    const [settings, settingsSummary] = await Promise.all([
      sendRuntime({ type: 'get-content-settings' }),
      sendRuntime({ type: 'get-settings-summary' }).catch(() => null),
    ]);
    contentSettings = settings;
    summary = settingsSummary;
  } catch {
    return; // background unavailable; popup actions will still work when it wakes up
  }

  // Site rules for this frame's host (spec 2.0 §6.4).
  effectiveRule = effectiveRuleForHost(location.hostname, contentSettings.siteRules);

  translator.configure({
    minTextLength: effectiveRule.minTextLength ?? contentSettings.minTextLength,
    rule: effectiveRule,
    inlineBudget: contentSettings.inlineBudget,
    viewportBudget: contentSettings.viewportBudget,
    streamingAvailable: summary?.providerType === 'openai-compatible',
  });

  // Blacklist applies by top-level domain; frames follow the top page
  // (spec 2.0 §6.2 item 7).
  const topHost = topLevelHostname();
  if (hostBlacklisted(topHost || location.hostname, contentSettings.blacklist)) {
    translator.blacklisted = true;
    return;
  }

  // Selection translate (spec 2.0 §7.1) — disabled on blacklisted sites.
  selectionTranslator.setMode(contentSettings.selectionTranslate);
  if (contentSettings.selectionTranslate !== 'off') {
    selectionTranslator.start();
  }

  // Initial scan so the popup can report how many paragraphs were found
  // before the user triggers any translation.
  translator.scan();
  observer.start();
  if (contentSettings.autoTranslate) {
    void translator.translate(defaultMode());
  }
}

void init();