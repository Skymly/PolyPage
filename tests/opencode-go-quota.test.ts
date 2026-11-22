import { afterEach, expect, it, vi } from 'vitest';
import { openCodeGoQuotaStatus, startOpenCodeGoQuotaMonitor } from '../src/background/opencodeGoQuota';
import { OPENCODE_GO_QUOTA_MINUTES, defaultProvider } from '../src/shared/constants';
import type { ProviderConfig } from '../src/shared/types';

const go: ProviderConfig = { ...defaultProvider(), id: 'go', type: 'opencode-go', apiKey: 'test-key' };
const usage = {
  rolling: { percent: 10, resetsAt: null },
  weekly: { percent: 30, resetsAt: null },
  monthly: { percent: 45, resetsAt: null },
};

function stubBackground(initialProviders: ProviderConfig[]) {
  const storage = new Map<string, unknown>([['settings', { providers: initialProviders }]]);
  let settingsChanged: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;
  let alarmFired: ((alarm: { name: string }) => void) | undefined;
  let alarm: { name: string } | undefined;
  const create = vi.fn((name: string) => { alarm = { name }; });
  const clear = vi.fn(() => { alarm = undefined; });
  const alarms = {
    create,
    clear,
    get: async () => alarm,
    onAlarm: { addListener: (listener: typeof alarmFired) => { alarmFired = listener; } },
  };
  const local = {
    get: async (key: string) => ({ [key]: storage.get(key) }),
    set: vi.fn(async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) storage.set(key, value);
    }),
    remove: vi.fn(async (keys: string[]) => {
      for (const key of keys) storage.delete(key);
    }),
  };
  vi.stubGlobal('chrome', {
    alarms,
    runtime: { onStartup: { addListener: vi.fn() } },
    storage: {
      local,
      onChanged: { addListener: (listener: typeof settingsChanged) => { settingsChanged = listener; } },
    },
  });
  return {
    local,
    alarms,
    fireAlarm: () => { if (alarm) alarmFired?.(alarm); },
    saveProviders(providers: ProviderConfig[]) {
      const oldValue = storage.get('settings');
      const newValue = { providers };
      storage.set('settings', newValue);
      settingsChanged?.({ settings: { oldValue, newValue } }, 'local');
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('starts and clears the alarm with saved settings, keeps the last good reading and removes it when deleted', async () => {
  const background = stubBackground([]);
  const clock = vi.spyOn(Date, 'now');
  const now = 1_800_000_000_000;
  clock.mockReturnValue(now);
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ usage }))
    .mockResolvedValueOnce(new Response(null, { status: 429 }));
  vi.stubGlobal('fetch', fetchMock);

  startOpenCodeGoQuotaMonitor();
  background.saveProviders([go]);
  await vi.waitFor(() => expect(background.local.set).toHaveBeenCalledTimes(1));
  expect(background.alarms.create).toHaveBeenCalledWith('opencode-go-quota', { periodInMinutes: OPENCODE_GO_QUOTA_MINUTES });
  const lastSuccess = { fetchedAt: now, windows: usage };
  await expect(openCodeGoQuotaStatus(go.id, go.apiKey, false)).resolves.toEqual({ checkedAt: now, lastSuccess });

  clock.mockReturnValue(now + OPENCODE_GO_QUOTA_MINUTES * 60_000 - 500);
  background.fireAlarm();
  await vi.waitFor(() => expect(background.local.set).toHaveBeenCalledTimes(2));
  await expect(openCodeGoQuotaStatus(go.id, go.apiKey, false)).resolves.toMatchObject({
    lastSuccess, error: expect.stringContaining('429'),
  });

  background.saveProviders([{ ...go, autoRefreshQuota: false }]);
  await vi.waitFor(() => expect(background.alarms.clear).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  background.saveProviders([]);
  await vi.waitFor(() => expect(background.local.remove).toHaveBeenCalledTimes(1));
  await expect(openCodeGoQuotaStatus(go.id, go.apiKey, false)).resolves.toBeNull();
});

it('allows a draft key to query without storing it and isolates a saved result after key changes', async () => {
  const background = stubBackground([go]);
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ usage }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(openCodeGoQuotaStatus(go.id, 'draft-key', true)).resolves.toMatchObject({ lastSuccess: { windows: usage } });
  expect(background.local.set).not.toHaveBeenCalled();
  await expect(openCodeGoQuotaStatus(go.id, 'draft-key', false)).resolves.toBeNull();

  await Promise.all([
    openCodeGoQuotaStatus(go.id, go.apiKey, true),
    openCodeGoQuotaStatus(go.id, go.apiKey, true),
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(background.local.set).toHaveBeenCalledTimes(1);
  background.saveProviders([{ ...go, apiKey: 'replaced-key' }]);
  await expect(openCodeGoQuotaStatus(go.id, 'replaced-key', false)).resolves.toBeNull();
});
