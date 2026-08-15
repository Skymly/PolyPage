/**
 * Message protocol between content script, popup, options and background.
 *
 * Two channels:
 *  - RuntimeMessage: chrome.runtime.sendMessage (content/popup/options -> background)
 *  - TabCommand:     chrome.tabs.sendMessage   (background/popup -> content script)
 *
 * 2.0 (protocol v2, spec 2.0 §9.2):
 *  - every message carries v: 2 (absent means v1, handled compatibly);
 *  - new: report-frame-state / get-frame-states (frame aggregation),
 *    host-status (gateway probe), get-provider-stats (P1 ops),
 *    wt:translate-selection (context menu / shortcut);
 *  - streaming deltas use a runtime Port ("wt-stream"), not one-shot messages.
 *
 * 3.0 (protocol v3, spec 3.0 §9.2):
 *  - every message carries v: 3; messages without v are treated as an older
 *    protocol version and stay fully compatible (spec 3.0 §0 item 1);
 *  - new: ocr-request / ocr-cancel (image OCR), translate-cue (subtitle
 *    low-latency path), mark-feedback / feedback log access, pdf-open /
 *    pdf-progress (PDF reader), detect-language;
 *  - new TabCommands: wt:open-pdf-viewer, wt:translate-image,
 *    wt:toggle-subtitles, wt:repeat-selection, wt:resume-inflight.
 *
 * 4.0 (protocol v4, spec 4.0 §9.2):
 *  - every message carries v: 4; messages without v stay compatible;
 *  - new: asr-start / asr-cancel; TabCommand wt:transcribe-media.
 */
import type {
  ContentSettings,
  DisplayMode,
  ErrorLogEntry,
  FeedbackEntry,
  FrameStateEntry,
  OcrSegment,
  PageState,
  ProviderConfig,
  ProviderStats,
  SettingsSummary,
  TranslateResults,
  TranslationItem,
} from '../shared/types';

export const PROTOCOL_VERSION = 4;

/* --------------------------- content -> background --------------------------- */

export type RuntimeMessage =
  | { type: 'translate'; v?: number; items: TranslationItem[]; domain?: string; pageLanguage?: string | null }
  | { type: 'translate-selection'; v?: number; text: string; domain?: string }
  /** 3.0: low-latency single-text path for subtitle cues (no batch window). */
  | { type: 'translate-cue'; v?: number; text: string; domain?: string }
  | { type: 'get-content-settings'; v?: number }
  | { type: 'get-settings-summary'; v?: number }
  | { type: 'get-full-settings'; v?: number }
  | { type: 'save-settings'; v?: number; settings: unknown }
  | { type: 'test-provider'; v?: number; provider: ProviderConfig }
  | { type: 'get-cache-stats'; v?: number }
  | { type: 'clear-cache'; v?: number }
  | { type: 'get-error-log'; v?: number }
  | { type: 'clear-error-log'; v?: number }
  /** 2.0: content script reports its frame's page state. */
  | { type: 'report-frame-state'; v?: number; state: PageState }
  /** 2.0 (spec §5.3 item 5): abort in-flight translations for this tab. */
  | { type: 'cancel-translations'; v?: number }
  /** 2.0: popup asks for aggregated per-frame states of a tab. */
  | { type: 'get-frame-states'; v?: number; tabId?: number }
  /** 2.0: gateway installation/health probe. */
  | { type: 'host-status'; v?: number; hostName?: string }
  /** 2.0 (P1): per-provider sliding window stats. */
  | { type: 'get-provider-stats'; v?: number }
  /** 2.0 (P1): bilingual export payload for the active tab. */
  | { type: 'get-export-payload'; v?: number; tabId?: number }
  /* ------------------------------ 3.0 additions ----------------------------- */
  /** 3.0 (pillar F): translate an image through the vision pipeline. */
  | { type: 'ocr-request'; v?: number; requestId: string; url: string; naturalWidth?: number; naturalHeight?: number; cacheIdentity?: string }
  /** 3.0 (pillar F): abort an in-flight OCR request. */
  | { type: 'ocr-cancel'; v?: number; requestId: string }
  /** 3.0 (pillar H): mark a bad translation into the feedback log. */
  | { type: 'mark-feedback'; v?: number; source: string; translation: string; pageUrl: string; where: FeedbackEntry['where']; providerName?: string }
  | { type: 'get-feedback-log'; v?: number }
  | { type: 'delete-feedback-entry'; v?: number; ts: number }
  | { type: 'clear-feedback-log'; v?: number }
  /** 3.0 (pillar E): open the PDF bilingual reader for a URL. */
  | { type: 'pdf-open'; v?: number; url: string }
  /** 3.0 (pillar E): viewer progress report (popup hint). */
  | { type: 'pdf-progress'; v?: number; url: string; done: number; total: number; failed: number }
  /** 3.0 (pillar H): detect the dominant language of text samples. */
  | { type: 'detect-language'; v?: number; texts: string[] }
  | {
      type: 'asr-start';
      v?: number;
      requestId: string;
      mime: string;
      base64: string;
      windowStart: number;
      windowDuration: number;
      languageHint?: string;
    }
  | { type: 'asr-cancel'; v?: number; requestId: string };

export type OcrResponse =
  | { ok: true; segments: OcrSegment[]; cached: boolean; engine: string }
  | { ok: false; kind: string; error: string };

export type RuntimeResponseFor<M extends RuntimeMessage> =
  M extends { type: 'translate' } ? TranslateResults :
  M extends { type: 'translate-selection' } ? { ok: boolean; translated?: string; language?: string; error?: string } :
  M extends { type: 'translate-cue' } ? { ok: boolean; translated?: string; error?: string } :
  M extends { type: 'get-content-settings' } ? ContentSettings :
  M extends { type: 'get-settings-summary' } ? SettingsSummary :
  M extends { type: 'get-full-settings' } ? { settings: unknown } :
  M extends { type: 'save-settings' } ? { ok: boolean; error?: string } :
  M extends { type: 'test-provider' } ? { ok: boolean; result?: string; latencyMs?: number; error?: string } :
  M extends { type: 'get-cache-stats' } ? { entries: number } :
  M extends { type: 'clear-cache' } ? { ok: true } :
  M extends { type: 'get-error-log' } ? { entries: ErrorLogEntry[] } :
  M extends { type: 'clear-error-log' } ? { ok: true } :
  M extends { type: 'report-frame-state' } ? { ok: true } :
  M extends { type: 'cancel-translations' } ? { ok: true } :
  M extends { type: 'get-frame-states' } ? { frames: FrameStateEntry[] } :
  M extends { type: 'host-status' } ? { installed: boolean; version?: string; error?: string } :
  M extends { type: 'get-provider-stats' } ? { stats: Record<string, ProviderStats> } :
  M extends { type: 'get-export-payload' } ? { ok: boolean; entries?: ExportEntry[]; title?: string; url?: string; error?: string } :
  M extends { type: 'ocr-request' } ? OcrResponse :
  M extends { type: 'ocr-cancel' } ? { ok: true } :
  M extends { type: 'mark-feedback' } ? { ok: true } :
  M extends { type: 'get-feedback-log' } ? { entries: FeedbackEntry[] } :
  M extends { type: 'delete-feedback-entry' } ? { ok: true } :
  M extends { type: 'clear-feedback-log' } ? { ok: true } :
  M extends { type: 'pdf-open' } ? { ok: boolean; tabId?: number; error?: string } :
  M extends { type: 'pdf-progress' } ? { ok: true } :
  M extends { type: 'detect-language' } ? { language: string | null; confident: boolean } :
  M extends { type: 'asr-start' } ? AsrResponse :
  M extends { type: 'asr-cancel' } ? { ok: true } :
  never;

export type AsrResponse =
  | {
      ok: true;
      cues: Array<{ start: number; end: number; text: string; translation: string }>;
    }
  | { ok: false; kind: string; error: string };

export interface ExportEntry {
  original: string;
  translated: string | null;
  status: 'done' | 'pending' | 'error' | 'idle';
  tag: string;
}

export function sendRuntime<M extends RuntimeMessage>(
  message: M,
): Promise<RuntimeResponseFor<M>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ v: PROTOCOL_VERSION, ...message }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message ?? 'runtime message failed'));
        else resolve(response as RuntimeResponseFor<M>);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/* ------------------------------ streaming port ------------------------------- */

export const STREAM_PORT_NAME = 'wt-stream';

export type StreamPortInit = { items: TranslationItem[]; domain?: string };
export type StreamPortMessage =
  | { type: 'delta'; key: string; delta: string }
  | { type: 'done'; key: string; text: string }
  | { type: 'error'; key: string; kind: string; message: string }
  | { type: 'finished' };

/* ------------------------------ -> content script ---------------------------- */

export type TabCommand =
  | { type: 'wt:translate'; v?: number; mode?: DisplayMode }
  | { type: 'wt:restore'; v?: number }
  | { type: 'wt:toggle'; v?: number }
  | { type: 'wt:set-mode'; v?: number; mode: DisplayMode }
  | { type: 'wt:retry-failed'; v?: number }
  | { type: 'wt:rescan'; v?: number }
  | { type: 'wt:get-state'; v?: number }
  /** 2.0: context menu / command — translate the current selection. */
  | { type: 'wt:translate-selection'; v?: number }
  /** 2.0 (P1): collect bilingual export payload. */
  | { type: 'wt:collect-export'; v?: number }
  /* ------------------------------ 3.0 additions ----------------------------- */
  /** 3.0 (pillar E): answer with the tab's URL so the background can open
   *  the PDF reader (context menu page entry). */
  | { type: 'wt:open-pdf-viewer'; v?: number }
  /** 3.0 (pillar F): open the image OCR panel for an image URL. */
  | { type: 'wt:translate-image'; v?: number; url: string }
  /** 3.0 (pillar G): toggle the subtitle layer on the active video. */
  | { type: 'wt:toggle-subtitles'; v?: number }
  /** 3.0 (pillar H): repeat the last selection translation (Alt+Q). */
  | { type: 'wt:repeat-selection'; v?: number }
  /** 3.0 (pillar H): re-submit persisted in-flight tasks after SW restart. */
  | { type: 'wt:resume-inflight'; v?: number; keys: string[] }
  | { type: 'wt:transcribe-media'; v?: number; force?: boolean };

export type TabCommandResponse<C extends TabCommand> =
  C extends { type: 'wt:get-state' } ? PageState :
  C extends { type: 'wt:collect-export' } ? { entries: ExportEntry[]; title: string } :
  C extends { type: 'wt:open-pdf-viewer' } ? { ok: true; url: string } :
  C extends { type: 'wt:transcribe-media' } ? { ok: boolean; skipped?: string; error?: string } :
  { ok: true };

export function sendTabCommand<C extends TabCommand>(
  tabId: number,
  command: C,
): Promise<TabCommandResponse<C>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, { v: PROTOCOL_VERSION, ...command }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message ?? 'tab message failed'));
        else resolve(response as TabCommandResponse<C>);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}