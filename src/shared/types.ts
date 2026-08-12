/**
 * Shared type definitions used across background, content, popup and options.
 * 2.0: schema v2 types (glossary, site rules, failover, selection translate,
 * inline mode, native-host provider). See PolyPage-2.0.md.
 */

/** Display modes. 2.0 adds `inline` (sixth mode, spec 2.0 §7.2). */
export type DisplayMode =
  | 'original'
  | 'translated'
  | 'translated_hover_original'
  | 'original_hover_translated'
  | 'bilingual'
  | 'inline';

export const DISPLAY_MODES: DisplayMode[] = [
  'original',
  'translated',
  'translated_hover_original',
  'original_hover_translated',
  'bilingual',
  'inline',
];

/**
 * Provider types. 1.0: openai-compatible, custom-http.
 * 2.0 adds: deepl, azure-translator, google-translate, native-host.
 */
export type ProviderType =
  | 'openai-compatible'
  | 'custom-http'
  | 'deepl'
  | 'azure-translator'
  | 'google-translate'
  | 'native-host';

export type ApiKeyPlacement = 'header' | 'query' | 'body';

/** Selection-translate trigger strategy (spec 2.0 §7.1). */
export type SelectionTranslateMode = 'always' | 'alt' | 'off';

/** One glossary entry; rendered into the {{glossary}} prompt variable. */
export interface GlossaryEntry {
  source: string;
  target: string;
  note?: string;
}

/** Site rule (spec 2.0 §6.4). All fields optional except id/match. */
export interface SiteRule {
  id: string;
  /** Hostname patterns: "example.com" (exact) or "*.example.com" (wildcard). */
  match: string[];
  includeSelectors?: string[];
  excludeSelectors?: string[];
  minTextLength?: number;
  defaultMode?: DisplayMode;
  /** Only translate nodes entering the viewport (virtual lists). */
  viewportOnly?: boolean;
  enabled?: boolean;
}

/** Effective per-site configuration after merging matched rules. */
export interface EffectiveRule {
  includeSelectors: string[];
  excludeSelectors: string[];
  minTextLength: number | null;
  defaultMode: DisplayMode | null;
  viewportOnly: boolean;
}

/** Provider configuration (1.0 fields kept; 2.0 additions are optional). */
export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Empty string means "use global default language". */
  sourceLanguage: string;
  targetLanguage: string;
  timeoutMs: number;
  maxBatchItems: number;
  maxBatchChars: number;
  systemPrompt: string;
  userPromptTemplate: string;
  temperature: number;
  maxTokens: number;
  headers: Record<string, string>;
  enabled: boolean;
  /** custom-http only: HTTP method, defaults to POST. */
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH';
  /** custom-http only: JSON request body template with {{placeholders}}. */
  bodyTemplate?: string;
  /** custom-http only: dot path into the JSON response. */
  responsePath?: string;
  /** custom-http only: where to place the API key. */
  apiKeyPlacement?: ApiKeyPlacement;
  /** custom-http only: header/query/body field name for the API key. */
  apiKeyParamName?: string;
  /** deepl only: formality parameter. */
  formality?: 'default' | 'more' | 'less';
  /** azure-translator only: subscription region header. */
  region?: string;
  /** native-host only: Native Messaging host name. */
  hostName?: string;
  /** native-host only: gateway backend id, empty = gateway default. */
  backend?: string;
  /** native-host only: fallback provider id when the gateway is unavailable. */
  fallbackProviderId?: string;
}

/** Global settings stored in chrome.storage.local (schema v2). */
export interface Settings {
  schemaVersion: number;
  activeProviderId: string;
  providers: ProviderConfig[];
  defaultDisplayMode: DisplayMode;
  /** Automatically translate pages on load (skipping blacklisted hosts). */
  autoTranslate: boolean;
  /** Hosts that must never be translated, one entry per host. */
  blacklist: string[];
  defaultSourceLanguage: string;
  defaultTargetLanguage: string;
  cacheEnabled: boolean;
  /** Minimum trimmed text length for a node to be translated. */
  minTextLength: number;
  /* ------------------------- 2.0 additions ------------------------- */
  glossary: GlossaryEntry[];
  /** Incremented on every glossary edit; participates in the cache key. */
  glossaryVersion: number;
  siteRules: SiteRule[];
  /** Ordered provider ids tried after the active provider fails. */
  failoverChain: string[];
  selectionTranslate: SelectionTranslateMode;
  /** Max inline-mode tasks per page before degrading to bilingual. */
  inlineBudget: number;
  /** Pending-item threshold that switches a page to viewport-only mode. */
  viewportBudget: number;
}

/** A single translation work item as sent from content script to background. */
export interface TranslationItem {
  /** Stable key within the page (the element's data-wt-id). */
  key: string;
  text: string;
}

export type ErrorKind =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'invalid_response'
  | 'config'
  | 'aborted'
  | 'unknown';

export interface TranslateResults {
  results: Record<string, string>;
  errors: Record<string, { kind: ErrorKind; message: string }>;
  /** Set when a failover provider served the batch (spec 2.0 §5.6). */
  actualProviderId?: string;
  actualProviderName?: string;
}

/** Status of a single page node. */
export type NodeStatus = 'idle' | 'pending' | 'done' | 'error';

/** Page state reported by the content script to the popup. */
export interface PageState {
  injected: true;
  blacklisted: boolean;
  active: boolean;
  mode: DisplayMode | null;
  total: number;
  translated: number;
  pending: number;
  failed: number;
  lastError: string | null;
  /** 2.0: frame awareness + failover/downgrade hints. */
  isTopFrame: boolean;
  frameUrl?: string;
  /** Provider name that actually served translations (after failover). */
  actualProvider?: string | null;
  /** inline mode degraded over-budget elements to paragraph bilingual. */
  inlineDowngraded?: boolean;
  /** Page switched to viewport-only translation (over viewportBudget). */
  viewportOnly?: boolean;
}

/** Aggregated per-frame state served to the popup (spec 2.0 §6.2). */
export interface FrameStateEntry {
  frameId: number;
  state: PageState;
}

/** One entry in the persisted error log. */
export interface ErrorLogEntry {
  ts: number;
  where: string;
  kind: ErrorKind;
  message: string;
  /** 2.0: provider attribution for filtering (P1). */
  providerId?: string;
}

/** Summary used by the popup (never exposes API keys). */
export interface SettingsSummary {
  providerName: string;
  providerType: ProviderType;
  targetLanguage: string;
  sourceLanguage: string;
  defaultDisplayMode: DisplayMode;
  autoTranslate: boolean;
  providerConfigured: boolean;
  selectionTranslate: SelectionTranslateMode;
}

/** Subset of settings the content script is allowed to see (no API keys). */
export interface ContentSettings {
  defaultDisplayMode: DisplayMode;
  autoTranslate: boolean;
  blacklist: string[];
  minTextLength: number;
  selectionTranslate: SelectionTranslateMode;
  siteRules: SiteRule[];
  inlineBudget: number;
  viewportBudget: number;
}

/** Per-provider sliding-window stats (in-memory only, spec 2.0 §8.3). */
export interface ProviderStats {
  calls: number;
  ok: number;
  avgMs: number;
  lastError: string | null;
}