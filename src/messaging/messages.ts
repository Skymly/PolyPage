/**
 * Message protocol between content script, popup, options and background.
 *
 * Two channels:
 *  - RuntimeMessage: chrome.runtime.sendMessage (content/popup/options -> background)
 *  - TabCommand:     chrome.tabs.sendMessage   (background/popup -> content script)
 */
import type {
  ContentSettings,
  DisplayMode,
  ErrorLogEntry,
  PageState,
  ProviderConfig,
  SettingsSummary,
  TranslateResults,
  TranslationItem,
} from '../shared/types';

/* --------------------------- content -> background --------------------------- */

export type RuntimeMessage =
  | { type: 'translate'; items: TranslationItem[] }
  | { type: 'get-content-settings' }
  | { type: 'get-settings-summary' }
  | { type: 'get-full-settings' }
  | { type: 'save-settings'; settings: unknown }
  | { type: 'test-provider'; provider: ProviderConfig }
  | { type: 'get-cache-stats' }
  | { type: 'clear-cache' }
  | { type: 'get-error-log' }
  | { type: 'clear-error-log' };

export type RuntimeResponseFor<M extends RuntimeMessage> =
  M extends { type: 'translate' } ? TranslateResults :
  M extends { type: 'get-content-settings' } ? ContentSettings :
  M extends { type: 'get-settings-summary' } ? SettingsSummary :
  M extends { type: 'get-full-settings' } ? { settings: unknown } :
  M extends { type: 'save-settings' } ? { ok: boolean; error?: string } :
  M extends { type: 'test-provider' } ? { ok: boolean; result?: string; error?: string } :
  M extends { type: 'get-cache-stats' } ? { entries: number } :
  M extends { type: 'clear-cache' } ? { ok: true } :
  M extends { type: 'get-error-log' } ? { entries: ErrorLogEntry[] } :
  M extends { type: 'clear-error-log' } ? { ok: true } :
  never;

export function sendRuntime<M extends RuntimeMessage>(
  message: M,
): Promise<RuntimeResponseFor<M>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message ?? 'runtime message failed'));
        else resolve(response as RuntimeResponseFor<M>);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/* ------------------------------ -> content script ---------------------------- */

export type TabCommand =
  | { type: 'wt:translate'; mode?: DisplayMode }
  | { type: 'wt:restore' }
  | { type: 'wt:toggle' }
  | { type: 'wt:set-mode'; mode: DisplayMode }
  | { type: 'wt:retry-failed' }
  | { type: 'wt:rescan' }
  | { type: 'wt:get-state' };

export type TabCommandResponse<C extends TabCommand> =
  C extends { type: 'wt:get-state' } ? PageState :
  { ok: true };

export function sendTabCommand<C extends TabCommand>(
  tabId: number,
  command: C,
): Promise<TabCommandResponse<C>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, command, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message ?? 'tab message failed'));
        else resolve(response as TabCommandResponse<C>);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
