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
 */
import type {
  ContentSettings,
  DisplayMode,
  ErrorLogEntry,
  FrameStateEntry,
  PageState,
  ProviderConfig,
  ProviderStats,
  SettingsSummary,
  TranslateResults,
  TranslationItem,
} from '../shared/types';

export const PROTOCOL_VERSION = 2;

/* --------------------------- content -> background --------------------------- */

export type RuntimeMessage =
  | { type: 'translate'; v?: number; items: TranslationItem[]; domain?: string }
  | { type: 'translate-selection'; v?: number; text: string; domain?: string }
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
  | { type: 'get-export-payload'; v?: number; tabId?: number };

export type RuntimeResponseFor<M extends RuntimeMessage> =
  M extends { type: 'translate' } ? TranslateResults :
  M extends { type: 'translate-selection' } ? { ok: boolean; translated?: string; error?: string } :
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
  never;

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
  /** 2.0: context menu / shortcut — translate the current selection. */
  | { type: 'wt:translate-selection'; v?: number }
  /** 2.0 (P1): collect bilingual export payload. */
  | { type: 'wt:collect-export'; v?: number };

export type TabCommandResponse<C extends TabCommand> =
  C extends { type: 'wt:get-state' } ? PageState :
  C extends { type: 'wt:collect-export' } ? { entries: ExportEntry[]; title: string } :
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