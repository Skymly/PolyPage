/**
 * Settings persistence (chrome.storage.local) with normalization/migration.
 * Runs in background, popup and options pages (never in content scripts).
 *
 * 2.0: schema v2. Migration v1 -> v2 only adds defaults and never clears
 * existing fields (spec 2.0 §9.3).
 * 3.0: schema v3. Migration v2 -> v3 only adds defaults (spec 3.0 §9.3);
 * v3 settings remain readable by 2.0 code because unknown fields are ignored
 * during 2.0 normalization (regression-tested in tests/migration3.test.ts).
 */
import {
  BUILTIN_SITE_RULES,
  DEFAULT_IMAGE_MAX_EDGE_PX,
  DEFAULT_INLINE_BUDGET,
  DEFAULT_NATIVE_HOST_NAME,
  DEFAULT_SUBTITLE_FONT_PCT,
  DEFAULT_VIEWPORT_BUDGET,
  SCHEMA_VERSION,
  SETTINGS_STORAGE_KEY,
  defaultSettings,
} from '../shared/constants';
import { DISPLAY_MODES } from '../shared/types';
import type {
  DisplayMode,
  GlossaryEntry,
  ImageTranslateSettings,
  LanguageDetectionMode,
  PdfViewerSettings,
  ProviderConfig,
  ProviderType,
  SelectionTranslateMode,
  Settings,
  SiteRule,
  SubtitleSettings,
} from '../shared/types';
import { normalizeSiteRule } from '../shared/siteRules';
import { clamp } from '../shared/utils';

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(data[SETTINGS_STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}

const PROVIDER_TYPES: ProviderType[] = [
  'openai-compatible',
  'custom-http',
  'deepl',
  'azure-translator',
  'google-translate',
  'native-host',
];

/** Coerce arbitrary stored data (schema v1, v2 or v3) into a valid v3 Settings. */
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

  // Glossary normalization (2.0).
  const glossary: GlossaryEntry[] = Array.isArray(r.glossary)
    ? r.glossary
        .filter((e): e is GlossaryEntry => e !== null && typeof e === 'object')
        .map((e) => ({
          source: typeof e.source === 'string' ? e.source.trim() : '',
          target: typeof e.target === 'string' ? e.target.trim() : '',
          ...(typeof e.note === 'string' && e.note.trim() !== '' ? { note: e.note.trim() } : {}),
        }))
        .filter((e) => e.source !== '' && e.target !== '')
    : [];

  // Site rules: keep valid user rules; re-add any missing built-ins so a
  // version update can ship new default rules without clobbering the user.
  const userRules: SiteRule[] = Array.isArray(r.siteRules)
    ? r.siteRules
        .map((rule, i) => normalizeSiteRule(rule, `rule-${i + 1}`))
        .filter((rule): rule is SiteRule => rule !== null)
    : [];
  const siteRules = [...userRules];
  for (const builtin of BUILTIN_SITE_RULES) {
    if (!siteRules.some((s) => s.id === builtin.id)) {
      siteRules.push({ ...builtin });
    }
  }

  // Failover chain: only keep ids that exist among providers; deduplicated.
  const failoverSeen = new Set<string>();
  const failoverChain = Array.isArray(r.failoverChain)
    ? r.failoverChain.filter((id): id is string => {
        if (typeof id !== 'string' || failoverSeen.has(id)) return false;
        if (!providers.some((p) => p.id === id)) return false;
        failoverSeen.add(id);
        return true;
      })
    : [];

  const selectionTranslate: SelectionTranslateMode =
    r.selectionTranslate === 'always' || r.selectionTranslate === 'alt' || r.selectionTranslate === 'off'
      ? r.selectionTranslate
      : defaults.selectionTranslate;

  return {
    schemaVersion: SCHEMA_VERSION,
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
    glossary,
    glossaryVersion:
      typeof r.glossaryVersion === 'number' && Number.isFinite(r.glossaryVersion)
        ? Math.max(0, Math.round(r.glossaryVersion))
        : 0,
    siteRules,
    failoverChain,
    selectionTranslate,
    inlineBudget:
      typeof r.inlineBudget === 'number' && Number.isFinite(r.inlineBudget)
        ? clamp(Math.round(r.inlineBudget), 10, 5000)
        : DEFAULT_INLINE_BUDGET,
    viewportBudget:
      typeof r.viewportBudget === 'number' && Number.isFinite(r.viewportBudget)
        ? clamp(Math.round(r.viewportBudget), 50, 10000)
        : DEFAULT_VIEWPORT_BUDGET,
    /* ------------------------- 3.0 additions ------------------------- */
    pdfViewer: normalizePdfViewer(r.pdfViewer),
    imageTranslate: normalizeImageTranslate(r.imageTranslate),
    subtitles: normalizeSubtitles(r.subtitles),
    languageDetection:
      r.languageDetection === 'off' ? 'off' : ('auto' as LanguageDetectionMode),
    selectionSpeak: r.selectionSpeak !== false,
  };
}

function normalizeMode(value: unknown): DisplayMode {
  return DISPLAY_MODES.includes(value as DisplayMode) ? (value as DisplayMode) : 'bilingual';
}

/* --------------------------- 3.0 sub-normalizers ----------------------------- */

export function normalizePdfViewer(raw: unknown): PdfViewerSettings {
  const d = defaultSettings().pdfViewer;
  if (raw === null || typeof raw !== 'object') return d;
  const r = raw as Partial<PdfViewerSettings>;
  return {
    enabled: r.enabled !== false,
    defaultMode:
      r.defaultMode === 'translated_hover_original' ? 'translated_hover_original' : 'bilingual',
    skipHeadersFooters: r.skipHeadersFooters !== false,
    maxConcurrentPages:
      typeof r.maxConcurrentPages === 'number' && Number.isFinite(r.maxConcurrentPages)
        ? clamp(Math.round(r.maxConcurrentPages), 1, 8)
        : d.maxConcurrentPages,
    autoOpen: r.autoOpen === true,
  };
}

export function normalizeImageTranslate(raw: unknown): ImageTranslateSettings {
  const d = defaultSettings().imageTranslate;
  if (raw === null || typeof raw !== 'object') return d;
  const r = raw as Partial<ImageTranslateSettings>;
  return {
    enabled: r.enabled !== false,
    trigger:
      r.trigger === 'contextMenu' || r.trigger === 'hoverButton' ? r.trigger : 'both',
    engine: r.engine === 'tesseract-wasm' ? 'tesseract-wasm' : 'llm-vision',
    maxEdgePx:
      typeof r.maxEdgePx === 'number' && Number.isFinite(r.maxEdgePx)
        ? clamp(Math.round(r.maxEdgePx), 512, 8192)
        : DEFAULT_IMAGE_MAX_EDGE_PX,
  };
}

export function normalizeSubtitles(raw: unknown): SubtitleSettings {
  if (raw === null || typeof raw !== 'object') return defaultSettings().subtitles;
  const r = raw as Partial<SubtitleSettings>;
  return {
    enabled: r.enabled !== false,
    bilingual: r.bilingual === 'src' || r.bilingual === 'dst' ? r.bilingual : 'both',
    fontSizePct:
      typeof r.fontSizePct === 'number' && Number.isFinite(r.fontSizePct)
        ? clamp(Math.round(r.fontSizePct), 50, 250)
        : DEFAULT_SUBTITLE_FONT_PCT,
  };
}

export function normalizeProvider(raw: unknown): ProviderConfig | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Partial<ProviderConfig>;
  if (typeof r.id !== 'string' || r.id.trim() === '') return null;
  if (!PROVIDER_TYPES.includes(r.type as ProviderType)) return null;
  const type = r.type as ProviderType;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : fallback;
  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === 'object') {
    for (const [k, v] of Object.entries(r.headers)) {
      if (typeof k === 'string' && typeof v === 'string') headers[k] = v;
    }
  }

  const provider: ProviderConfig = {
    id: r.id,
    name: str(r.name, r.id),
    type,
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
  };

  if (type === 'custom-http') {
    provider.method =
      r.method === 'GET' || r.method === 'PUT' || r.method === 'PATCH' ? r.method : 'POST';
    provider.bodyTemplate = str(r.bodyTemplate);
    provider.responsePath = str(r.responsePath);
    provider.apiKeyPlacement =
      r.apiKeyPlacement === 'query' || r.apiKeyPlacement === 'body' ? r.apiKeyPlacement : 'header';
    provider.apiKeyParamName = str(r.apiKeyParamName, 'Authorization');
  }
  if (type === 'deepl') {
    provider.formality =
      r.formality === 'more' || r.formality === 'less' ? r.formality : 'default';
  }
  if (type === 'azure-translator') {
    provider.region = str(r.region);
  }
  if (type === 'native-host') {
    provider.hostName = str(r.hostName, DEFAULT_NATIVE_HOST_NAME).trim() || DEFAULT_NATIVE_HOST_NAME;
    provider.backend = str(r.backend);
    provider.fallbackProviderId = str(r.fallbackProviderId);
  }
  return provider;
}

/** Basic validation for settings imported from a JSON file. */
export function validateImportedSettings(raw: unknown): Settings | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = (raw as { settings?: unknown }).settings ?? raw;
  const normalized = normalizeSettings(candidate);
  // Require at least one usable provider: a base URL for HTTP types, or a
  // configured native-host provider.
  const usable = normalized.providers.some(
    (p) => p.type === 'native-host' || p.baseUrl.trim() !== '',
  );
  if (!usable) return null;
  return normalized;
}