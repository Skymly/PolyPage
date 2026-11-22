import {
  OPENCODE_GO_QUOTA_MINUTES,
  OPENCODE_GO_QUOTA_STORAGE_PREFIX,
  SETTINGS_STORAGE_KEY,
} from '../shared/constants';
import type { ProviderConfig, Settings } from '../shared/types';
import { loadSettings, normalizeSettings } from '../storage/settings';
import { fetchOpenCodeGoQuota } from '../providers/opencode-go';
import type { OpenCodeGoQuotaStatus } from '../providers/opencode-go';
import { toProviderError } from '../providers/provider';

const QUOTA_ALARM = 'opencode-go-quota';
// Allow alarm delivery to precede the previous fetch's completion by a few seconds.
const QUOTA_FRESH_MS = OPENCODE_GO_QUOTA_MINUTES * 60_000 - 30_000;
const inFlight = new Map<string, Promise<OpenCodeGoQuotaStatus>>();

async function quotaStorageKey(id: string, apiKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([id, apiKey]));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return OPENCODE_GO_QUOTA_STORAGE_PREFIX + digest;
}

function savedProvider(settings: Settings, id: string, apiKey: string): ProviderConfig | undefined {
  return settings.providers.find((provider) =>
    provider.type === 'opencode-go' && provider.id === id && provider.apiKey === apiKey,
  );
}

async function readQuota(storageKey: string): Promise<OpenCodeGoQuotaStatus | null> {
  const stored = await chrome.storage.local.get(storageKey);
  return stored[storageKey] ?? null;
}

async function queryQuota(apiKey: string, previous?: OpenCodeGoQuotaStatus | null): Promise<OpenCodeGoQuotaStatus> {
  try {
    const windows = await fetchOpenCodeGoQuota(apiKey);
    const checkedAt = Date.now();
    return { checkedAt, lastSuccess: { fetchedAt: checkedAt, windows } };
  } catch (error) {
    const status: OpenCodeGoQuotaStatus = { checkedAt: Date.now(), error: toProviderError(error).message };
    if (previous?.lastSuccess) status.lastSuccess = previous.lastSuccess;
    return status;
  }
}

async function refreshSavedQuota(provider: ProviderConfig): Promise<OpenCodeGoQuotaStatus> {
  const { id, apiKey } = provider;
  const requestKey = JSON.stringify([id, apiKey]);
  const pending = inFlight.get(requestKey);
  if (pending) return pending;
  const refresh = (async () => {
    const storageKey = await quotaStorageKey(id, apiKey);
    const previous = await readQuota(storageKey);
    const status = await queryQuota(apiKey, previous);
    // A draft can be deleted or change credentials while the request is in flight.
    if (savedProvider(await loadSettings(), id, apiKey)) {
      await chrome.storage.local.set({ [storageKey]: status });
    }
    return status;
  })();
  inFlight.set(requestKey, refresh);
  try {
    return await refresh;
  } finally {
    inFlight.delete(requestKey);
  }
}

async function refreshDueQuota(provider: ProviderConfig): Promise<void> {
  const previous = await readQuota(await quotaStorageKey(provider.id, provider.apiKey));
  if (!previous || Date.now() - previous.checkedAt >= QUOTA_FRESH_MS) await refreshSavedQuota(provider);
}

export async function openCodeGoQuotaStatus(
  id: string,
  rawKey: string,
  refresh: boolean,
): Promise<OpenCodeGoQuotaStatus | null> {
  const apiKey = rawKey.trim();
  if (!apiKey) return null;
  const provider = savedProvider(await loadSettings(), id, apiKey);
  if (!provider) return refresh ? queryQuota(apiKey) : null;
  return refresh ? refreshSavedQuota(provider) : readQuota(await quotaStorageKey(id, apiKey));
}

function monitoredProviders(settings: Settings): ProviderConfig[] {
  return settings.providers.filter((provider) =>
    provider.type === 'opencode-go' && provider.enabled && provider.apiKey && provider.autoRefreshQuota !== false,
  );
}

export function startOpenCodeGoQuotaMonitor(): void {
  // Alarms can disappear on browser restart. Reconcile them on worker startup
  // and settings changes, and use the persisted check time to avoid extra traffic.
  let sync = Promise.resolve();
  const reconcile = (oldSettings?: Settings) => {
    sync = sync.then(async () => {
      const current = await loadSettings();
      const providers = monitoredProviders(current);
      const alarm = await chrome.alarms.get(QUOTA_ALARM);
      if (providers.length > 0 && !alarm) {
        await chrome.alarms.create(QUOTA_ALARM, { periodInMinutes: OPENCODE_GO_QUOTA_MINUTES });
      } else if (providers.length === 0 && alarm) {
        await chrome.alarms.clear(QUOTA_ALARM);
      }
      const removed = oldSettings?.providers.filter((provider) =>
        provider.type === 'opencode-go' && provider.apiKey && !savedProvider(current, provider.id, provider.apiKey),
      ) ?? [];
      if (removed.length > 0) {
        const keys = await Promise.all(removed.map(({ id, apiKey }) => quotaStorageKey(id, apiKey)));
        await chrome.storage.local.remove(keys);
      }
      void Promise.allSettled(providers.map(refreshDueQuota));
    }).catch(() => {
      // The next worker start, settings change, or alarm can retry the refresh.
    });
  };

  chrome.runtime.onStartup.addListener(() => reconcile());
  chrome.alarms.onAlarm.addListener(({ name }) => {
    if (name === QUOTA_ALARM) reconcile();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_STORAGE_KEY]) {
      reconcile(normalizeSettings(changes[SETTINGS_STORAGE_KEY].oldValue));
    }
  });
  reconcile();
}
