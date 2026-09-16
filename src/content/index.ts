/**
 * Content script bootstrap (2.0, spec 2.0 §9; evolved for 3.0 pillars F/G/H).
 * Wires the PageTranslator, DOM observer, selection translator, site rules,
 * subtitle manager, image translate entries, feedback marker and the
 * popup/background commands. Runs in every frame (all_frames).
 */
import { sendRuntime } from '../messaging/messages';
import type { TabCommand } from '../messaging/messages';
import {
  BILINGUAL_CLASS,
  INLINE_DST_CLASS,
  INLINE_SRC_CLASS,
  LANGUAGE_DETECT_MAX_SAMPLES,
  LANGUAGE_DETECT_SAMPLE_CHARS,
  NAV_TRANSLATION_CLASS,
  SHADOW_STYLE_ATTR,
} from '../shared/constants';
import { detectLanguage, pageLanguageBlocksAutoTranslate } from '../shared/languageDetect';
import { shouldStartAutoTranslate } from '../shared/settingsSync';
import { resolveLanguageCode } from '../providers/langCodes';
import type { ContentSettings, EffectiveRule, PageState } from '../shared/types';
import { DomObserver } from './observer';
import { effectiveRuleForHost, hostBlacklisted, resolveBlacklistHost, topLevelHostname } from './rules';
import { isInsertedOwnElement } from './scanner';
import { SelectionTranslator } from './selection';
import { PageTranslator } from './translator';
import {
  AsrSession,
  SubtitleManager,
  captureMediaWindow,
  isAbortError,
  rejectWholeFileFallback,
  resolveCaptureDuration,
  settleTabResponse,
} from './media';
import { bytesToBase64 } from '../shared/binaryChunk';
import { ImageTranslateController } from './imageButton';
import { OCR_OVERLAY_HOST_CLASS, removeImageOverlay } from '../ocr/overlay';
import { FeedbackMarker } from './feedback';

const translator = new PageTranslator();
translator.init();

const selectionTranslator = new SelectionTranslator();
const subtitleManager = new SubtitleManager();
const asrSession = new AsrSession();
const imageController = new ImageTranslateController();
const feedbackMarker = new FeedbackMarker();

let contentSettings: ContentSettings | null = null;
let effectiveRule: EffectiveRule | null = null;
/** 3.0: detected page language (spec 3.0 §8.1). */
let pageLanguage: string | null = null;
let pageLanguageConfident = false;
/** 3.0: auto-translate skipped because page language == target language. */
let autoSkipped = false;

function isOwnNode(node: Node): boolean {
  if (!(node instanceof Element)) {
    // Text nodes: owned when their parent is one of our elements.
    const parent = node.parentElement;
    if (!parent) return false;
    return isOwnNode(parent);
  }
  if (node.hasAttribute?.(SHADOW_STYLE_ATTR)) return true;
  if (isInsertedOwnElement(node)) return true;
  if (
    node.classList.contains('wt-tooltip-host') ||
    node.classList.contains('wt-selection-host') ||
    node.classList.contains('wt-ocr-host') ||
    node.classList.contains(OCR_OVERLAY_HOST_CLASS) ||
    node.classList.contains('wt-img-btn') ||
    node.classList.contains('wt-feedback-btn') ||
    node.classList.contains('wt-subtitle-host')
  ) {
    return true;
  }
  return (
    node.closest(
      `.${BILINGUAL_CLASS}, .${NAV_TRANSLATION_CLASS}, .wt-tooltip-host, .${INLINE_SRC_CLASS}, .${INLINE_DST_CLASS}`,
    ) !== null
  );
}

const observer = new DomObserver(
  () => {
    if (translator.active) {
      translator.detectRecycledNodes();
      translator.rescan();
    }
  },
  isOwnNode,
);

/* ---------------------------- frame state reporting --------------------------- */

/** PageState augmented with the 3.0 frame-level fields. */
function extendedState(): PageState {
  const state = translator.state();
  state.pageLanguage = pageLanguage;
  state.autoSkipped = autoSkipped;
  state.subtitles = subtitleManager.state();
  state.subtitleVideos = subtitleManager.subtitleVideoCount();
  state.captionlessMedia = subtitleManager.captionlessMediaCount();
  state.asrActive = subtitleManager.asrActive() || asrSession.active;
  state.ocrPanelText = imageController.panelText();
  return state;
}

let reportTimer: number | null = null;
translator.onStateChange = () => {
  scheduleReport();
};

function scheduleReport(): void {
  if (reportTimer !== null) return;
  reportTimer = window.setTimeout(() => {
    reportTimer = null;
    sendRuntime({ type: 'report-frame-state', state: extendedState() }).catch(() => {
      /* background may be restarting; popup polls again later */
    });
  }, 300);
}

/* ------------------------------- language detect ------------------------------ */

function detectPageLanguage(): void {
  if (contentSettings?.languageDetection === 'off') return;
  const nodes = document.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, td');
  const samples: string[] = [];
  for (const node of Array.from(nodes)) {
    if (isOwnNode(node)) continue;
    const text = (node.textContent ?? '').trim();
    if (text.length < 8) continue;
    samples.push(text.slice(0, LANGUAGE_DETECT_SAMPLE_CHARS));
    if (samples.length >= LANGUAGE_DETECT_MAX_SAMPLES) break;
  }
  const result = detectLanguage(samples);
  pageLanguage = result.language;
  pageLanguageConfident = result.confident;
}

/** True when a confident detection matches the configured target. */
function pageMatchesTargetLanguage(): boolean {
  if (!contentSettings) return false;
  const target = resolveLanguageCode(contentSettings.defaultTargetLanguage);
  if (!target) return false;
  const base = target.split('-')[0].toLowerCase();
  return pageLanguageBlocksAutoTranslate(pageLanguage, pageLanguageConfident, base);
}

/** force is only sent by the popup / tests — there is no page-script sender (M-88). */
async function handleTranscribeMedia(force: boolean): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  if (!contentSettings?.asrEnabled) return { ok: false, error: '语音转写已关闭' };
  if (!contentSettings.asrSupported) return { ok: false, error: '当前翻译服务不支持转写' };
  if (asrSession.active) return { ok: false, error: '转写进行中' };
  if (subtitleManager.asrActive()) {
    subtitleManager.restoreAll();
    scheduleReport();
    return { ok: true };
  }
  if (subtitleManager.subtitleVideoCount() > 0 && !force) {
    return { ok: true, skipped: 'has-tracks' };
  }
  const media = subtitleManager.pickCaptionlessMedia();
  if (!media) return { ok: false, error: '没有可转写的无字幕媒体' };
  subtitleManager.pinAsrTarget(media);
  const maxSeconds = contentSettings.asrMaxSeconds ?? 90;
  const resolved = resolveCaptureDuration({
    mediaDuration: media.duration,
    currentTime: media.currentTime || 0,
    maxSeconds,
    confirmFull: contentSettings.asrConfirmFull ?? true,
    confirmFullNow: (remaining) =>
      window.confirm(
        `默认只转写 ${maxSeconds} 秒。整段约 ${Math.round(remaining)} 秒将上传到当前 Provider 或本地网关。确定转写整段，取消则只转写 ${maxSeconds} 秒。`,
      ),
  });
  if (resolved.ended || resolved.duration <= 0) return { ok: false, error: '媒体已播放完毕' };
  const duration = resolved.duration;
  const { requestId, signal } = asrSession.start();
  const onHide = (): void => {
    asrSession.abort();
  };
  window.addEventListener('pagehide', onHide);
  scheduleReport();
  try {
    let captured: { mime: string; bytes: Uint8Array; start: number; duration: number };
    try {
      captured = await captureMediaWindow(media, duration, signal);
    } catch (e) {
      if (isAbortError(e) || signal.aborted) return { ok: true };
      return rejectWholeFileFallback(e);
    }
    if (signal.aborted) {
      void sendRuntime({ type: 'asr-cancel', requestId });
      return { ok: true };
    }
    const res = await sendRuntime({
      type: 'asr-start',
      requestId,
      mime: captured.mime,
      base64: bytesToBase64(captured.bytes),
      windowStart: captured.start,
      windowDuration: captured.duration,
      languageHint: pageLanguage ?? undefined,
    });
    if (signal.aborted) {
      void sendRuntime({ type: 'asr-cancel', requestId });
      return { ok: true };
    }
    if (!res?.ok) return { ok: false, error: res && 'error' in res ? res.error : '转写失败' };
    subtitleManager.applyMemoryCues(
      media,
      res.cues.map((c) => ({
        startTime: c.start,
        endTime: c.end,
        text: c.text,
        translation: c.translation,
      })),
    );
    scheduleReport();
    return { ok: true };
  } finally {
    window.removeEventListener('pagehide', onHide);
    asrSession.finish();
    scheduleReport();
  }
}

/* --------------------------------- commands ---------------------------------- */

function defaultMode(): ContentSettings['defaultDisplayMode'] {
  return effectiveRule?.defaultMode ?? contentSettings?.defaultDisplayMode ?? 'bilingual';
}

async function handleCommand(cmd: TabCommand): Promise<unknown> {
  switch (cmd.type) {
    case 'wt:get-state':
      return extendedState();
    case 'wt:translate': {
      const mode = cmd.mode ?? defaultMode();
      void translator.translate(mode);
      return { ok: true };
    }
    case 'wt:restore': {
      const asrRequestId = asrSession.abort();
      if (asrRequestId) void sendRuntime({ type: 'asr-cancel', requestId: asrRequestId });
      translator.restore();
      subtitleManager.restoreAll();
      removeImageOverlay();
      scheduleReport();
      return { ok: true };
    }
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
    /* ------------------------------ 3.0 additions ----------------------------- */
    case 'wt:open-pdf-viewer':
      return { ok: true, url: location.href };
    case 'wt:translate-image':
      imageController.translateImage(cmd.url, undefined, true);
      return { ok: true };
    case 'wt:toggle-subtitles': {
      subtitleManager.configure({
        bilingual: contentSettings?.subtitleBilingual ?? 'both',
        fontSizePct: contentSettings?.subtitleFontSizePct ?? 100,
        swapSrcDst: contentSettings?.subtitleSwapSrcDst ?? false,
        background: contentSettings?.subtitleBackground ?? 'rgba(0,0,0,.62)',
        position: contentSettings?.subtitlePosition ?? 'bottom',
      });
      subtitleManager.toggle();
      scheduleReport();
      return { ok: true };
    }
    case 'wt:repeat-selection':
      return { ok: selectionTranslator.repeatLast() };
    case 'wt:resume-inflight':
      void translator.resumeInflight(cmd.tasks).then(scheduleReport);
      return { ok: true };
    case 'wt:transcribe-media':
      return handleTranscribeMedia(cmd.force === true);
    case 'wt:asr-partial':
      subtitleManager.applyAsrPartial(
        cmd.cues.map((c) => ({ startTime: c.start, endTime: c.end, text: c.text })),
      );
      return { ok: true };
    case 'wt:settings-changed':
      applyLiveSettings(cmd.settings);
      return { ok: true };
    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((message: TabCommand, _sender, sendResponse) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('wt:')) return false;
  settleTabResponse(handleCommand(message), sendResponse);
  return true; // async response
});

/* ----------------------------------- init ------------------------------------ */

async function init(): Promise<void> {
  try {
    contentSettings = await sendRuntime({ type: 'get-content-settings' });
  } catch {
    return; // background unavailable; popup actions will still work when it wakes up
  }

  const blacklisted = applyLoadedSettings(contentSettings);
  selectionTranslator.start();

  if (!blacklisted) {
    imageController.init();
    feedbackMarker.init();
  }

  if (document.body) {
    detectPageLanguage();
    translator.configure({ pageLanguage });
  } else {
    window.addEventListener(
      'DOMContentLoaded',
      () => {
        detectPageLanguage();
        translator.configure({ pageLanguage });
      },
      { once: true },
    );
  }

  observer.start();
  if (!blacklisted) translator.rescan();

  if (
    shouldStartAutoTranslate(
      'init',
      contentSettings.autoTranslate,
      blacklisted,
      pageMatchesTargetLanguage(),
    )
  ) {
    void translator.translate(defaultMode());
  } else if (contentSettings.autoTranslate && !blacklisted && pageMatchesTargetLanguage()) {
    autoSkipped = true;
  }
  scheduleReport();
}

/** Reconfigure from a projected snapshot. Does not start listeners (M-43 live). */
function applyLoadedSettings(cs: ContentSettings): boolean {
  contentSettings = cs;
  effectiveRule = effectiveRuleForHost(location.hostname, cs.siteRules);
  translator.configure({
    minTextLength: effectiveRule.minTextLength ?? cs.minTextLength,
    rule: effectiveRule,
    inlineBudget: cs.inlineBudget,
    viewportBudget: cs.viewportBudget,
    streamingAvailable: cs.streamingSupported === true,
  });
  const topHost = resolveBlacklistHost(topLevelHostname(), cs.tabHostname ?? '');
  const blacklisted = hostBlacklisted(topHost, cs.blacklist);
  translator.blacklisted = blacklisted;
  selectionTranslator.setMode(cs.selectionTranslate);
  selectionTranslator.setSpeak(cs.selectionSpeak);
  if (!blacklisted) {
    const ocrAvailable = cs.ocrAvailable ?? cs.visionSupported;
    imageController.configure({
      enabled: cs.imageTranslateEnabled,
      trigger: cs.imageTranslateTrigger,
      visionSupported: cs.visionSupported,
      overlayEnabled: cs.imageOverlayEnabled === true,
      ocrAvailable,
      disabledReason: ocrAvailable
        ? null
        : (cs.ocrEngine === 'tesseract-wasm'
            ? '本地 OCR 不可用'
            : '当前翻译服务不支持视觉翻译，请切换到 OpenAI-compatible 多模态服务或改用 tesseract-wasm'),
    });
    subtitleManager.configure({
      bilingual: cs.subtitleBilingual ?? 'both',
      fontSizePct: cs.subtitleFontSizePct ?? 100,
      swapSrcDst: cs.subtitleSwapSrcDst ?? false,
      background: cs.subtitleBackground ?? 'rgba(0,0,0,.62)',
      position: cs.subtitlePosition ?? 'bottom',
    });
    if ((effectiveRule?.subtitleSelectors.length ?? 0) > 0 && cs.subtitlesEnabled) {
      subtitleManager.applySelectors(effectiveRule.subtitleSelectors);
    }
  }
  return blacklisted;
}

function applyLiveSettings(cs: ContentSettings): void {
  const blacklisted = applyLoadedSettings(cs);
  if (blacklisted && translator.active) {
    translator.restore();
    subtitleManager.restoreAll();
    removeImageOverlay();
  }
  if (document.body) {
    detectPageLanguage();
    translator.configure({ pageLanguage });
  }
  scheduleReport();
}

void init();