/**
 * Quality-feedback log (spec 3.0 §8.2): user-flagged bad translations.
 * Independent from the error log; ring buffer of 200 entries persisted in
 * chrome.storage.local. Runs in background + options pages.
 */
import { FEEDBACK_LOG_KEY, FEEDBACK_LOG_MAX } from '../shared/constants';
import type { FeedbackEntry } from '../shared/types';

export async function loadFeedbackLog(): Promise<FeedbackEntry[]> {
  const data = await chrome.storage.local.get(FEEDBACK_LOG_KEY);
  const entries = data[FEEDBACK_LOG_KEY];
  if (!Array.isArray(entries)) return [];
  return entries.filter((e): e is FeedbackEntry => {
    return (
      e !== null &&
      typeof e === 'object' &&
      typeof (e as FeedbackEntry).source === 'string' &&
      typeof (e as FeedbackEntry).translation === 'string'
    );
  });
}

/** Prepend one entry and enforce the ring limit. */
export async function appendFeedback(entry: FeedbackEntry): Promise<void> {
  const entries = await loadFeedbackLog();
  entries.unshift(entry);
  await chrome.storage.local.set({
    [FEEDBACK_LOG_KEY]: entries.slice(0, FEEDBACK_LOG_MAX),
  });
}

export async function deleteFeedbackEntry(ts: number): Promise<void> {
  const entries = await loadFeedbackLog();
  await chrome.storage.local.set({
    [FEEDBACK_LOG_KEY]: entries.filter((e) => e.ts !== ts),
  });
}

export async function clearFeedbackLog(): Promise<void> {
  await chrome.storage.local.remove(FEEDBACK_LOG_KEY);
}

/** CSV escaping: quote fields, double embedded quotes. */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function feedbackToCsv(entries: FeedbackEntry[]): string {
  const header = ['ts', 'source', 'translation', 'provider', 'pageUrl', 'where']
    .map(csvEscape)
    .join(',');
  const rows = entries.map((e) =>
    [
      new Date(e.ts).toISOString(),
      csvEscape(e.source),
      csvEscape(e.translation),
      csvEscape(e.providerName ?? ''),
      csvEscape(e.pageUrl),
      csvEscape(e.where),
    ].join(','),
  );
  return [header, ...rows].join('\r\n');
}

export function feedbackToJson(entries: FeedbackEntry[]): string {
  return JSON.stringify(entries, null, 2);
}