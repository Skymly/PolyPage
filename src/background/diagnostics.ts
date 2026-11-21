import { ERROR_LOG_KEY, ERROR_LOG_MAX } from '../shared/constants';
import type { ErrorKind, ErrorLogEntry, ProviderStats } from '../shared/types';

const STATS_WINDOW = 50;
const providerStats = new Map<string, { results: boolean[]; latencies: number[]; lastError: string | null }>();

export function recordStat(providerId: string, ok: boolean, latencyMs: number, error?: string): void {
  let entry = providerStats.get(providerId);
  if (!entry) {
    entry = { results: [], latencies: [], lastError: null };
    providerStats.set(providerId, entry);
  }
  entry.results.push(ok);
  entry.latencies.push(latencyMs);
  if (entry.results.length > STATS_WINDOW) {
    entry.results.shift();
    entry.latencies.shift();
  }
  if (!ok && error) entry.lastError = error;
}

export function snapshotStats(): Record<string, ProviderStats> {
  const out: Record<string, ProviderStats> = {};
  for (const [id, entry] of providerStats) {
    const calls = entry.results.length;
    const ok = entry.results.filter(Boolean).length;
    const avgMs = calls > 0 ? Math.round(entry.latencies.reduce((a, b) => a + b, 0) / calls) : 0;
    out[id] = { calls, ok, avgMs, lastError: entry.lastError };
  }
  return out;
}

export async function logError(
  where: string,
  kind: ErrorKind,
  message: string,
  providerId?: string,
): Promise<void> {
  try {
    const data = await chrome.storage.local.get(ERROR_LOG_KEY);
    const entries = Array.isArray(data[ERROR_LOG_KEY]) ? (data[ERROR_LOG_KEY] as ErrorLogEntry[]) : [];
    entries.unshift({ ts: Date.now(), where, kind, message, ...(providerId ? { providerId } : {}) });
    await chrome.storage.local.set({ [ERROR_LOG_KEY]: entries.slice(0, ERROR_LOG_MAX) });
  } catch {
    /* logging must never break translation */
  }
}
