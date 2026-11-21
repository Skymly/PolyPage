import { sendTabCommand, sendViewerResume } from '../messaging/messages';
import type { FrameStateEntry, PageState } from '../shared/types';
import { IdbTaskStore, resumePayloadForTab, TaskTable } from '../storage/taskTable';
import { isExtensionViewerUrl, settleInflightAfterAttempt, tabIdForTranslate } from './recoverInflight';

/** Resume task table (spec 3.0 §8.4). Falls back to in-memory when IndexedDB
 *  is unavailable (never blocks translation). */
const taskTable = new TaskTable(new IdbTaskStore());

export async function completeTasks(
  tabId: number | undefined,
  keys: string[],
  frameId?: number,
): Promise<void> {
  if (tabId === undefined || keys.length === 0) return;
  try {
    await taskTable.markDone(tabId, keys, frameId);
  } catch {
    /* persistence is best-effort */
  }
}

export async function recordInflight(
  tabId: number | undefined,
  frameId: number | undefined,
  items: { key: string; text: string }[],
): Promise<void> {
  if (tabId === undefined || items.length === 0) return;
  try {
    let pageUrl: string | undefined;
    try {
      pageUrl = (await chrome.tabs.get(tabId)).url;
    } catch {
      /* tab gone */
    }
    await taskTable.markInflight(tabId, frameId ?? 0, items, pageUrl);
  } catch {
    /* persistence is best-effort */
  }
}

const frameStates = new Map<number, Map<number, PageState>>();

export function recordFrameState(tabId: number | undefined, frameId: number | undefined, state: PageState): void {
  if (tabId === undefined) return;
  let frames = frameStates.get(tabId);
  if (!frames) {
    frames = new Map();
    frameStates.set(tabId, frames);
  }
  frames.set(frameId ?? 0, state);
}

export function registerTabCleanup(cancelTranslations: (tabId: number) => void): void {
  const clearTab = (tabId: number): void => {
    frameStates.delete(tabId);
    cancelTranslations(tabId);
    void taskTable.removeTab(tabId).catch(() => undefined);
  };
  chrome.tabs.onRemoved.addListener(clearTab);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') clearTab(tabId);
  });
}

export async function handleGetFrameStates(tabId?: number): Promise<{ frames: FrameStateEntry[] }> {
  let target = tabId;
  if (target === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    target = tab?.id;
  }
  if (target === undefined) return { frames: [] };
  const frames = frameStates.get(target);
  if (!frames) return { frames: [] };
  return {
    frames: [...frames.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([frameId, state]) => ({ frameId, state })),
  };
}

/**
 * SW startup recovery (spec 3.0 §8.4 item 2): scan persisted in-flight
 * records whose tabs are still alive and ask the content scripts to
 * re-submit them. Cache idempotency skips anything already done.
 */
export async function recoverInflightTasks(): Promise<void> {
  try {
    const inflight = await taskTable.listInflight();
    if (inflight.length === 0) return;
    const byTab = new Map<number, typeof inflight>();
    for (const rec of inflight) {
      if (rec.tabId < 0) continue;
      const list = byTab.get(rec.tabId) ?? [];
      list.push(rec);
      byTab.set(rec.tabId, list);
    }
    for (const [tabId, records] of byTab) {
      let tabExists = false;
      let delivered = false;
      try {
        const tab = await chrome.tabs.get(tabId); // throws when the tab is gone
        tabExists = true;
        const tasks = resumePayloadForTab(records, tab.url);
        if (tasks.length === 0) {
          delivered = true;
        } else if (isExtensionViewerUrl(tab.url)) {
          await sendViewerResume(tabId, tasks);
          delivered = true;
        } else {
          await sendTabCommand(tabId, { type: 'wt:resume-inflight', tasks });
          delivered = true;
        }
      } catch {
        // Tab closed or receiver absent — keep records when the tab still exists.
      }
      await settleInflightAfterAttempt(tabExists, delivered, () => taskTable.removeTab(tabId));
    }
  } catch {
    /* IndexedDB unavailable; resume is best-effort */
  }
}

export async function takeInflight(
  requestedTabId: number | undefined,
  senderTabId: number | undefined,
  respond: (response: { tasks: ReturnType<typeof resumePayloadForTab> }) => void,
): Promise<void> {
  const tabId = tabIdForTranslate(requestedTabId, senderTabId);
  if (tabId === undefined) {
    respond({ tasks: [] });
    return;
  }
  const inflight = await taskTable.listInflight();
  const mine = inflight.filter((r) => r.tabId === tabId);
  let url: string | undefined;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch {
    await taskTable.removeTab(tabId);
    respond({ tasks: [] });
    return;
  }
  const tasks = resumePayloadForTab(mine, url);
  respond({ tasks });
  if (tasks.length > 0) await taskTable.removeTab(tabId);
}
