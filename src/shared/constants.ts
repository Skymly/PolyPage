import type { ProviderConfig, Settings, SiteRule } from './types';

export const SETTINGS_STORAGE_KEY = 'settings';
export const CACHE_INDEX_KEY = 'cacheIndex';
export const CACHE_KEY_PREFIX = 'trcache:';
export const ERROR_LOG_KEY = 'errorLog';
/** 3.0: quality-feedback log storage key (spec 3.0 §8.2). */
export const FEEDBACK_LOG_KEY = 'feedbackLog';

export const ERROR_LOG_MAX = 50;
export const CACHE_MAX_ENTRIES = 3000;
export const OCR_CACHE_INDEX_KEY = 'ocrCacheIndex';
export const OCR_CACHE_KEY_PREFIX = 'ocrcache:';
export const OCR_CACHE_MAX_ENTRIES = 500;
/** 3.0: feedback log ring size (spec 3.0 §8.2). */
export const FEEDBACK_LOG_MAX = 200;
/** 3.0: resume task table ring size (spec 3.0 §8.4). */
export const TASK_TABLE_MAX = 5000;

/** Current settings schema version (4.2). */
export const SCHEMA_VERSION = 6;

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
/** Compact in-place nav/menu translation suffix (Contents[目录]). */
export const NAV_TRANSLATION_CLASS = 'wt-nav-translation';
/** Nav labels are short; still translate them (Wikipedia sidebar / TOC). */
export const NAV_MIN_TEXT_LENGTH = 2;
export const NAV_CHROME_SELECTOR = 'nav, [role="navigation"]';
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

/* ------------------------------ 3.0 defaults -------------------------------- */

/** Max image edge before downsampling (spec 3.0 §6.2 item 4). */
export const DEFAULT_IMAGE_MAX_EDGE_PX = 4096;
/** Max uploaded image size before downsampling (spec 3.0 §6.2 item 4). */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Images smaller than this (rendered size) get no hover button. */
export const IMAGE_HOVER_MIN_PX = 200;
/** Pending paragraph budget before the PDF reader degrades to viewport±1. */
export const PDF_PARAGRAPH_BUDGET = 2000;
/** Default subtitle font size, percent of the layer default. */
export const DEFAULT_SUBTITLE_FONT_PCT = 100;
/** Number of leading paragraphs sampled for language detection. */
export const LANGUAGE_DETECT_MAX_SAMPLES = 12;
/** Max characters per sampled paragraph for language detection. */
export const LANGUAGE_DETECT_SAMPLE_CHARS = 240;

/* ------------------------------ 4.0 defaults -------------------------------- */

/** ASR capture window in seconds (spec 4.0 §9.3). */
export const DEFAULT_ASR_MAX_SECONDS = 90;
/** ASR upload size cap in MiB (spec 4.0 §9.3). */
export const DEFAULT_ASR_MAX_UPLOAD_MB = 20;
/** Default subtitle cue background (spec 4.0 §9.3). */
export const DEFAULT_SUBTITLE_BACKGROUND = 'rgba(0,0,0,.62)';
/** Sentence TM ring size (spec 4.0 §9.3). */
export const DEFAULT_TM_MAX_ENTRIES = 5000;
/** Default tesseract language packs (spec 4.0 §9.3). */
export const DEFAULT_TESS_LANGS: string[] = ['eng', 'chi_sim'];

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
  {
    // 3.0 (pillar G): YouTube self-drawn captions. Known limitation: the
    // selectors break when YouTube ships new markup (spec 3.0 §7.2 item 4).
    id: 'builtin-youtube',
    match: ['*.youtube.com'],
    subtitleSelectors: ['.ytp-caption-segment'],
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
    /* 3.0 */
    pdfViewer: {
      enabled: true,
      defaultMode: 'bilingual',
      skipHeadersFooters: true,
      maxConcurrentPages: 3,
      autoOpen: false,
      scannedPageOcr: true,
      layoutPreset: 'auto',
    },
    imageTranslate: {
      enabled: true,
      trigger: 'both',
      engine: 'llm-vision',
      maxEdgePx: DEFAULT_IMAGE_MAX_EDGE_PX,
      tessLangs: [...DEFAULT_TESS_LANGS],
    },
    subtitles: {
      enabled: true,
      bilingual: 'both',
      fontSizePct: DEFAULT_SUBTITLE_FONT_PCT,
      swapSrcDst: false,
      background: DEFAULT_SUBTITLE_BACKGROUND,
      position: 'bottom',
    },
    languageDetection: 'auto',
    selectionSpeak: true,
    /* 4.0 */
    asr: {
      enabled: true,
      maxSeconds: DEFAULT_ASR_MAX_SECONDS,
      maxUploadMb: DEFAULT_ASR_MAX_UPLOAD_MB,
      confirmFull: true,
      streaming: false,
    },
    translationMemory: {
      enabled: false,
      maxEntries: DEFAULT_TM_MAX_ENTRIES,
    },
    ocrPacks: {
      extraLangs: [],
    },
    imageOverlay: {
      enabled: false,
    },
    outputSanitize: {
      enabled: true,
      stripThink: true,
      stripCodeFences: false,
    },
  };
}