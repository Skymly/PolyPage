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
  SHADOW_STYLE_ATTR,
} from '../shared/constants';
import { detectLanguage } from '../shared/languageDetect';
import { resolveLanguageCode } from '../providers/langCodes';
import type { ContentSettings, EffectiveRule, PageState } from '../shared/types';
import { DomObserver } from './observer';
import { effectiveRuleForHost, hostBlacklisted, topLevelHostname } from './rules';
import { SelectionTranslator } from './selection';
import { PageTranslator } from './translator';
import { SubtitleManager, captureMediaWindow } from './media';
import { bytesToBase64 } from '../shared/binaryChunk';
import { ImageTranslateController } from './imageButton';
import { FeedbackMarker } from './feedback';

const translator = new PageTranslator();
translator.init();

const selectionTranslator = new SelectionTranslator();
const subtitleManager = new SubtitleManager();
const imageController = new ImageTranslateController();
const feedbackMarker = new FeedbackMarker();

let contentSettings: ContentSettings | null = null;
let effectiveRule: EffectiveRule | null = null;
/** 3.0: detected page language (spec 3.0 §8.1). */
let pageLanguage: string | null = null;
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
  if (
    node.classList.contains(BILINGUAL_CLASS) ||
    node.classList.contains('wt-tooltip-host') ||
    node.classList.contains('wt-selection-host') ||
    node.classList.contains('wt-ocr-host') ||
    node.classList.contains('wt-img-btn') ||
    node.classList.contains('wt-feedback-btn') ||
    node.classList.contains('wt-subtitle-host') ||
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

/** PageState augmented with the 3.0 frame-level fields. */
function extendedState(): PageState {
  const state = translator.state();
  state.pageLanguage = pageLanguage;
  state.autoSkipped = autoSkipped;
  state.subtitles = subtitleManager.state();
  state.subtitleVideos = subtitleManager.subtitleVideoCount();
  state.captionlessMedia = subtitleManager.captionlessMediaCount();
  state.asrActive = subtitleManager.asrActive();
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
}

/** True when the detected page language matches the configured target. */
function pageMatchesTargetLanguage(): boolean {
  if (!pageLanguage || !contentSettings) return false;
  const target = resolveLanguageCode(contentSettings.defaultTargetLanguage);
  if (!target) return false;
  const base = target.split('-')[0].toLowerCase();
  return base === pageLanguage.toLowerCase();
}

async function handleTranscribeMedia(force: boolean): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  if (!contentSettings?.asrEnabled) return { ok: false, error: '语音转写已关闭' };
  if (!contentSettings.asrSupported) return { ok: false, error: '当前翻译服务不支持转写' };
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
  const maxSeconds = contentSettings.asrMaxSeconds ?? 90;
  const remaining =
    Number.isFinite(media.duration) && media.duration > 0
      ? Math.max(0, media.duration - (media.currentTime || 0))
      : maxSeconds;
  let duration = Math.min(maxSeconds, remaining || maxSeconds);
  if ((contentSettings.asrConfirmFull ?? true) && remaining > maxSeconds) {
    const full = window.confirm(
      `默认只转写 ${maxSeconds} 秒。整段约 ${Math.round(remaining)} 秒将上传到当前 Provider 或本地网关。确定转写整段，取消则只转写 ${maxSeconds} 秒。`,
    );
    if (full) duration = remaining;
  }
  let captured: { mime: string; bytes: Uint8Array; start: number; duration: number };
  try {
    captured = await captureMediaWindow(media, duration);
  } catch (e) {
    const src = media.currentSrc || media.src;
    if (src && /^https?:/i.test(src)) {
      const res = await fetch(src);
      if (!res.ok) return { ok: false, error: e instanceof Error ? e.message : String(e) };
      const bytes = new Uint8Array(await res.arrayBuffer());
      captured = {
        mime: res.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/webm',
        bytes,
        start: media.currentTime || 0,
        duration,
      };
    } else {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const requestId = `asr-${Date.now()}`;
  const res = await sendRuntime({
    type: 'asr-start',
    requestId,
    mime: captured.mime,
    base64: bytesToBase64(captured.bytes),
    windowStart: captured.start,
    windowDuration: captured.duration,
    languageHint: pageLanguage ?? undefined,
  });
  if (!res?.ok) return { ok: false, error: res && 'error' in res ? res.error : '转写失败' };
  subtitleManager.applyMemoryCues(
    media,
    res.cues.map((c) => ({ startTime: c.start, endTime: c.end, text: c.text })),
  );
  scheduleReport();
  return { ok: true };
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
    case 'wt:restore':
      translator.restore();
      subtitleManager.restoreAll();
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
    /* ------------------------------ 3.0 additions ----------------------------- */
    case 'wt:open-pdf-viewer':
      return { ok: true, url: location.href };
    case 'wt:translate-image':
      imageController.translateImage(cmd.url);
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
      void translator.resumeInflight(cmd.keys).then(scheduleReport);
      return { ok: true };
    case 'wt:transcribe-media':
      return handleTranscribeMedia(cmd.force === true);
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
  let summary: { providerType?: string; selectionSpeak?: boolean } | null = null;
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
  const blacklisted = hostBlacklisted(topHost, contentSettings.blacklist);
  translator.blacklisted = blacklisted;
  selectionTranslator.setMode(contentSettings.selectionTranslate);
  selectionTranslator.setSpeak(contentSettings.selectionSpeak);
  selectionTranslator.start();

  // 3.0 pillars F/G/H wiring (never on blacklisted hosts).
  if (!blacklisted) {
    const ocrAvailable = contentSettings.ocrAvailable ?? contentSettings.visionSupported;
    imageController.configure({
      enabled: contentSettings.imageTranslateEnabled,
      trigger: contentSettings.imageTranslateTrigger,
      visionSupported: contentSettings.visionSupported,
      ocrAvailable,
      disabledReason: ocrAvailable
        ? null
        : (contentSettings.ocrEngine === 'tesseract-wasm'
            ? '本地 OCR 不可用'
            : '当前翻译服务不支持视觉翻译，请切换到 OpenAI-compatible 多模态服务或改用 tesseract-wasm'),
    });
    imageController.init();
    feedbackMarker.init();
    subtitleManager.configure({
      bilingual: contentSettings.subtitleBilingual ?? 'both',
      fontSizePct: contentSettings.subtitleFontSizePct ?? 100,
      swapSrcDst: contentSettings.subtitleSwapSrcDst ?? false,
      background: contentSettings.subtitleBackground ?? 'rgba(0,0,0,.62)',
      position: contentSettings.subtitlePosition ?? 'bottom',
    });
    if ((effectiveRule?.subtitleSelectors.length ?? 0) > 0 && contentSettings.subtitlesEnabled) {
      subtitleManager.applySelectors(effectiveRule!.subtitleSelectors);
    }
  }

  // Language detection feeds the auto-translate guard and the popup hint.
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
  translator.rescan();

  if (contentSettings.autoTranslate && !blacklisted) {
    // Guard (spec 3.0 §8.1 item 3): never auto-translate pages already in
    // the target language.
    if (pageMatchesTargetLanguage()) {
      autoSkipped = true;
      scheduleReport();
    } else {
      void translator.translate(defaultMode());
    }
  }
  scheduleReport();
}

void init();