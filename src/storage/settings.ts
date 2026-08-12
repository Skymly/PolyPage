/**
 * Settings persistence (chrome.storage.local) with normalization/migration.
 * Runs in background, popup and options pages (never in content scripts).
 */
import { SETTINGS_STORAGE_KEY, defaultSettings } from '../shared/constants';
import { DISPLAY_MODES } from '../shared/types';
import type { DisplayMode, ProviderConfig, Settings } from '../shared/types';
import { clamp } from '../shared/utils';

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(data[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}

/** Coerce arbitrary stored data into a valid Settings object. */
export function normalizeSettings(raw: unknown): Settings {
  const defaults = defaultSettings();
  if (raw === null || typeof raw !== 'object') return defaults;
  const r = raw as Partial<Settings>;

  const providers = Array.isArray(r.providers)
    ? r.providers.map(normalizeProvider).filter((p): p is ProviderConfig => p !== null)
    : [];
  if (providers.length === 0) providers.push(defaults.providers[0]);

  const activeProviderId =
    typeof r.activeProviderId === 'string' && providers.some((p) => p.id === r.activeProviderId)
      ? r.activeProviderId
      : providers[0].id;

  return {
    schemaVersion: 1,
    activeProviderId,
    providers,
    defaultDisplayMode: normalizeMode(r.defaultDisplayMode),
    autoTranslate: r.autoTranslate === true,
    blacklist: Array.isArray(r.blacklist)
      ? r.blacklist.filter((h): h is string => typeof h === 'string' && h.trim() !== '')
      : [],
    defaultSourceLanguage:
      typeof r.defaultSourceLanguage === 'string' && r.defaultSourceLanguage.trim() !== ''
        ? r.defaultSourceLanguage
        : defaults.defaultSourceLanguage,
    defaultTargetLanguage:
      typeof r.defaultTargetLanguage === 'string' && r.defaultTargetLanguage.trim() !== ''
        ? r.defaultTargetLanguage
        : defaults.defaultTargetLanguage,
    cacheEnabled: r.cacheEnabled !== false,
    minTextLength:
      typeof r.minTextLength === 'number' && Number.isFinite(r.minTextLength)
        ? clamp(Math.round(r.minTextLength), 1, 200)
        : defaults.minTextLength,
  };
}

function normalizeMode(value: unknown): DisplayMode {
  return DISPLAY_MODES.includes(value as DisplayMode) ? (value as DisplayMode) : 'bilingual';
}

export function normalizeProvider(raw: unknown): ProviderConfig | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Partial<ProviderConfig>;
  if (typeof r.id !== 'string' || r.id.trim() === '') return null;
  if (r.type !== 'openai-compatible' && r.type !== 'custom-http') return null;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : fallback;
  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === 'object') {
    for (const [k, v] of Object.entries(r.headers)) {
      if (typeof k === 'string' && typeof v === 'string') headers[k] = v;
    }
  }

  return {
    id: r.id,
    name: str(r.name, r.id),
    type: r.type,
    baseUrl: str(r.baseUrl),
    apiKey: str(r.apiKey),
    model: str(r.model),
    sourceLanguage: str(r.sourceLanguage),
    targetLanguage: str(r.targetLanguage),
    timeoutMs: num(r.timeoutMs, 60000, 1000, 600000),
    maxBatchItems: num(r.maxBatchItems, 10, 1, 100),
    maxBatchChars: num(r.maxBatchChars, 6000, 100, 100000),
    systemPrompt: str(r.systemPrompt),
    userPromptTemplate: str(r.userPromptTemplate),
    temperature: num(r.temperature, 0.2, 0, 2),
    maxTokens: num(r.maxTokens, 4096, 1, 200000),
    headers,
    enabled: r.enabled !== false,
    ...(r.type === 'custom-http'
      ? {
          method:
            r.method === 'GET' || r.method === 'PUT' || r.method === 'PATCH' ? r.method : 'POST',
          bodyTemplate: str(r.bodyTemplate),
          responsePath: str(r.responsePath),
          apiKeyPlacement:
            r.apiKeyPlacement === 'query' || r.apiKeyPlacement === 'body'
              ? r.apiKeyPlacement
              : 'header',
          apiKeyParamName: str(r.apiKeyParamName, 'Authorization'),
        }
      : {}),
  };
}

/** Basic validation for settings imported from a JSON file. */
export function validateImportedSettings(raw: unknown): Settings | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = (raw as { settings?: unknown }).settings ?? raw;
  const normalized = normalizeSettings(candidate);
  // Require at least one provider with a base URL configured.
  if (!normalized.providers.some((p) => p.baseUrl.trim() !== '')) return null;
  return normalized;
}
