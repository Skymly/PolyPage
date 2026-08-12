/**
 * Shared type definitions used across background, content, popup and options.
 */

/** Display modes, see spec §7.1. */
export type DisplayMode =
  | 'original'
  | 'translated'
  | 'translated_hover_original'
  | 'original_hover_translated'
  | 'bilingual';

export const DISPLAY_MODES: DisplayMode[] = [
  'original',
  'translated',
  'translated_hover_original',
  'original_hover_translated',
  'bilingual',
];

/** Provider types supported in 1.0 (spec §8.2). `native-host` is reserved. */
export type ProviderType = 'openai-compatible' | 'custom-http';

export type ApiKeyPlacement = 'header' | 'query' | 'body';

/** Provider configuration (spec §8.1, plus custom-http specifics). */
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
  /** custom-http only: dot path into the JSON response, e.g. "data.translations". */
  responsePath?: string;
  /** custom-http only: where to place the API key. */
  apiKeyPlacement?: ApiKeyPlacement;
  /** custom-http only: header/query/body field name for the API key. */
  apiKeyParamName?: string;
}

/** Global settings stored in chrome.storage.local. */
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
}

/** One entry in the persisted error log. */
export interface ErrorLogEntry {
  ts: number;
  where: string;
  kind: ErrorKind;
  message: string;
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
}

/** Subset of settings the content script is allowed to see (no API keys). */
export interface ContentSettings {
  defaultDisplayMode: DisplayMode;
  autoTranslate: boolean;
  blacklist: string[];
  minTextLength: number;
}
