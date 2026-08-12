import type { ProviderConfig, Settings, SiteRule } from './types';

export const SETTINGS_STORAGE_KEY = 'settings';
export const CACHE_INDEX_KEY = 'cacheIndex';
export const CACHE_KEY_PREFIX = 'trcache:';
export const ERROR_LOG_KEY = 'errorLog';

export const ERROR_LOG_MAX = 50;
export const CACHE_MAX_ENTRIES = 3000;

/** Current settings schema version (2.0). */
export const SCHEMA_VERSION = 2;

/** How long the background waits to merge incoming items into one batch. */
export const BATCH_WINDOW_MS = 80;
/** Max parallel provider requests. */
export const MAX_CONCURRENT_REQUESTS = 2;
/** Provider-level retry attempts for retryable errors (excluding first try). */
export const MAX_RETRIES = 2;

export const DATA_ATTR = 'data-wt-id';
export const BILINGUAL_CLASS = 'wt-bilingual-block';
export const PENDING_CLASS = 'wt-pending';
export const ERROR_CLASS = 'wt-error';
/** 2.0 inline mode classes (spec 2.0 §7.2). */
export const INLINE_SRC_CLASS = 'wt-inline-src';
export const INLINE_DST_CLASS = 'wt-inline-dst';
/** Marker attribute for shadow-root style clones. */
export const SHADOW_STYLE_ATTR = 'data-wt-shadow-style';

/** Elements considered as translation candidates (spec §7.3). */
export const CANDIDATE_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, article, section, div';

/** Elements never translated, and subtrees never entered (spec §7.3). */
export const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'BUTTON',
  'SVG',
  'CANVAS',
  'IFRAME',
  'IMG',
  'VIDEO',
  'AUDIO',
  'TEMPLATE',
  'OPTION',
  'NAV',
]);

export const DEFAULT_SYSTEM_PROMPT = `You are a professional translation engine.
Translate the user's text from {{sourceLanguage}} to {{targetLanguage}}.
Rules:
- Output ONLY the translation. No explanations, no commentary, no quotation marks around the whole output.
- Never include the source text in the output.
- Keep URLs, email addresses, code, numbers, placeholders (like {{name}}) and special tokens unchanged.
- Preserve the original item order. For numbered input, keep the same numbering scheme.
- Keep the tone, terminology and punctuation style of the original.
{{glossary}}`;

export const DEFAULT_USER_PROMPT = `Translate the following text from {{sourceLanguage}} to {{targetLanguage}}:

{{text}}`;

export const DEFAULT_CUSTOM_HTTP_BODY = `{
  "q": {{texts}},
  "source": "{{sourceLanguage}}",
  "target": "{{targetLanguage}}"
}`;

/** Default Native Messaging host name (spec 2.0 §5.3). */
export const DEFAULT_NATIVE_HOST_NAME = 'com.skymly.polypage.gateway';
/** Idle time before the background disconnects the native port. */
export const NATIVE_PORT_IDLE_MS = 60_000;

/** Selection-translate text length bounds (spec 2.0 §7.1). */
export const SELECTION_MIN_LEN = 1;
export const SELECTION_MAX_LEN = 500;

/** Defaults for 2.0 numeric budgets. */
export const DEFAULT_INLINE_BUDGET = 300;
export const DEFAULT_VIEWPORT_BUDGET = 500;

/** Built-in site rules shipped with the extension (spec 2.0 §6.4 item 5). */
export const BUILTIN_SITE_RULES: SiteRule[] = [
  {
    id: 'builtin-wikipedia',
    match: ['*.wikipedia.org'],
    minTextLength: 8,
    enabled: true,
  },
  {
    id: 'builtin-github',
    match: ['github.com', '*.github.com'],
    excludeSelectors: ['.blob-code-inner', '.js-file-line', 'pre', 'code'],
    enabled: true,
  },
];

export function defaultProvider(): ProviderConfig {
  return {
    id: 'default-openai',
    name: 'OpenAI-compatible (default)',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    sourceLanguage: '',
    targetLanguage: '',
    timeoutMs: 60000,
    maxBatchItems: 10,
    maxBatchChars: 6000,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userPromptTemplate: DEFAULT_USER_PROMPT,
    temperature: 0.2,
    maxTokens: 4096,
    headers: {},
    enabled: true,
  };
}

export function defaultSettings(): Settings {
  const provider = defaultProvider();
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProviderId: provider.id,
    providers: [provider],
    defaultDisplayMode: 'bilingual',
    autoTranslate: false,
    blacklist: [],
    defaultSourceLanguage: 'auto',
    defaultTargetLanguage: '简体中文',
    cacheEnabled: true,
    minTextLength: 6,
    glossary: [],
    glossaryVersion: 0,
    siteRules: BUILTIN_SITE_RULES.map((r) => ({ ...r })),
    failoverChain: [],
    selectionTranslate: 'always',
    inlineBudget: DEFAULT_INLINE_BUDGET,
    viewportBudget: DEFAULT_VIEWPORT_BUDGET,
  };
}