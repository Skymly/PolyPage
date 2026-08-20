/**
 * Schema v4 migration tests (spec 4.0 §9.3, §12.1):
 *  - v3 -> v4 migration only adds defaults and never clears existing fields;
 *  - v4 settings remain readable by 3.0-style normalization (unknown fields
 *    ignored) — the same backwards-compat guarantee 3.0 gave 2.0.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_SITE_RULES } from '../src/shared/constants';
import type { Settings } from '../src/shared/types';
import { clamp } from '../src/shared/utils';
import { normalizeSettings } from '../src/storage/settings';

/** A realistic 3.0 (schema v3) settings document. */
const v3Settings = {
  schemaVersion: 3,
  activeProviderId: 'my-openai',
  providers: [
    {
      id: 'my-openai',
      name: 'My LLM',
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-789',
      model: 'gpt-4o-mini',
      sourceLanguage: 'auto',
      targetLanguage: '简体中文',
      timeoutMs: 45000,
      maxBatchItems: 6,
      maxBatchChars: 4000,
      systemPrompt: 'translate',
      userPromptTemplate: '{{text}}',
      temperature: 0.4,
      maxTokens: 2048,
      headers: { 'X-Three': '3' },
      enabled: true,
    },
  ],
  defaultDisplayMode: 'inline',
  autoTranslate: true,
  blacklist: ['mail.example.com'],
  defaultSourceLanguage: 'auto',
  defaultTargetLanguage: '简体中文',
  cacheEnabled: true,
  minTextLength: 7,
  glossary: [{ source: 'model', target: '模型' }],
  glossaryVersion: 2,
  siteRules: [
    { id: 'user-rule', match: ['example.com'], minTextLength: 9, enabled: true },
  ],
  failoverChain: [],
  selectionTranslate: 'alt',
  inlineBudget: 250,
  viewportBudget: 600,
  pdfViewer: {
    enabled: true,
    defaultMode: 'translated_hover_original' as const,
    skipHeadersFooters: false,
    maxConcurrentPages: 5,
    autoOpen: true,
  },
  imageTranslate: {
    enabled: true,
    trigger: 'contextMenu' as const,
    engine: 'tesseract-wasm' as const,
    maxEdgePx: 2048,
  },
  subtitles: {
    enabled: true,
    bilingual: 'dst' as const,
    fontSizePct: 120,
  },
  languageDetection: 'off' as const,
  selectionSpeak: false,
};

describe('v3 -> v4 migration', () => {
  const migrated = normalizeSettings(v3Settings);

  it('bumps schemaVersion to current', () => {
    expect(migrated.schemaVersion).toBe(6);
  });

  it('keeps every existing v3 field intact', () => {
    expect(migrated.activeProviderId).toBe('my-openai');
    expect(migrated.providers).toHaveLength(1);
    const p = migrated.providers[0];
    expect(p.apiKey).toBe('sk-test-789');
    expect(p.baseUrl).toBe('https://api.openai.com/v1');
    expect(p.timeoutMs).toBe(45000);
    expect(p.maxBatchItems).toBe(6);
    expect(p.temperature).toBe(0.4);
    expect(p.headers).toEqual({ 'X-Three': '3' });
    expect(migrated.defaultDisplayMode).toBe('inline');
    expect(migrated.autoTranslate).toBe(true);
    expect(migrated.blacklist).toEqual(['mail.example.com']);
    expect(migrated.defaultTargetLanguage).toBe('简体中文');
    expect(migrated.cacheEnabled).toBe(true);
    expect(migrated.minTextLength).toBe(7);
    expect(migrated.glossary).toEqual([{ source: 'model', target: '模型' }]);
    expect(migrated.glossaryVersion).toBe(2);
    expect(migrated.siteRules.some((r) => r.id === 'user-rule' && r.minTextLength === 9)).toBe(true);
    expect(migrated.failoverChain).toEqual([]);
    expect(migrated.selectionTranslate).toBe('alt');
    expect(migrated.inlineBudget).toBe(250);
    expect(migrated.viewportBudget).toBe(600);
    expect(migrated.pdfViewer.enabled).toBe(true);
    expect(migrated.pdfViewer.defaultMode).toBe('translated_hover_original');
    expect(migrated.pdfViewer.skipHeadersFooters).toBe(false);
    expect(migrated.pdfViewer.maxConcurrentPages).toBe(5);
    expect(migrated.pdfViewer.autoOpen).toBe(true);
    expect(migrated.imageTranslate.enabled).toBe(true);
    expect(migrated.imageTranslate.trigger).toBe('contextMenu');
    expect(migrated.imageTranslate.engine).toBe('tesseract-wasm');
    expect(migrated.imageTranslate.maxEdgePx).toBe(2048);
    expect(migrated.subtitles.enabled).toBe(true);
    expect(migrated.subtitles.bilingual).toBe('dst');
    expect(migrated.subtitles.fontSizePct).toBe(120);
    expect(migrated.languageDetection).toBe('off');
    expect(migrated.selectionSpeak).toBe(false);
  });

  it('adds 4.0 defaults without touching stored fields', () => {
    expect(migrated.asr.enabled).toBe(true);
    expect(migrated.asr.maxSeconds).toBe(90);
    expect(migrated.asr.maxUploadMb).toBe(20);
    expect(migrated.asr.confirmFull).toBe(true);
    expect(migrated.subtitles.swapSrcDst).toBe(false);
    expect(migrated.subtitles.background).toBe('rgba(0,0,0,.62)');
    expect(migrated.subtitles.position).toBe('bottom');
    expect(migrated.translationMemory.enabled).toBe(false);
    expect(migrated.translationMemory.maxEntries).toBe(5000);
    expect(migrated.pdfViewer.scannedPageOcr).toBe(true);
    expect(migrated.imageTranslate.tessLangs).toEqual(['eng', 'chi_sim']);
    for (const builtin of BUILTIN_SITE_RULES) {
      expect(migrated.siteRules.some((r) => r.id === builtin.id)).toBe(true);
    }
  });

  it('normalizes partial 4.0 sections leniently', () => {
    const s = normalizeSettings({
      ...v3Settings,
      asr: { maxSeconds: 3, maxUploadMb: 999 },
      subtitles: { ...v3Settings.subtitles, background: '', position: 'top' },
      translationMemory: { enabled: true, maxEntries: 10 },
      pdfViewer: { ...v3Settings.pdfViewer, scannedPageOcr: false },
      imageTranslate: { ...v3Settings.imageTranslate, tessLangs: ['chi_sim', '  ', 42] },
    });
    expect(s.asr.maxSeconds).toBe(10);
    expect(s.asr.maxUploadMb).toBe(100);
    expect(s.asr.enabled).toBe(true);
    expect(s.asr.confirmFull).toBe(true);
    expect(s.subtitles.background).toBe('rgba(0,0,0,.62)');
    expect(s.subtitles.position).toBe('top');
    expect(s.subtitles.bilingual).toBe('dst');
    expect(s.translationMemory.enabled).toBe(true);
    expect(s.translationMemory.maxEntries).toBe(100);
    expect(s.pdfViewer.scannedPageOcr).toBe(false);
    expect(s.pdfViewer.maxConcurrentPages).toBe(5);
    expect(s.imageTranslate.tessLangs).toEqual(['chi_sim']);
  });
});

/**
 * Copy of the 3.0 normalizeSettings contract (schema v3 output, unknown
 * fields ignored). Proves a 3.0 build can safely read a v4 document.
 */
function legacy30NormalizePdfViewer(raw: unknown): Record<string, unknown> {
  const d = {
    enabled: true,
    defaultMode: 'bilingual',
    skipHeadersFooters: true,
    maxConcurrentPages: 3,
    autoOpen: false,
  };
  if (raw === null || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
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

function legacy30NormalizeImageTranslate(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') {
    return { enabled: true, trigger: 'both', engine: 'llm-vision', maxEdgePx: 4096 };
  }
  const r = raw as Record<string, unknown>;
  return {
    enabled: r.enabled !== false,
    trigger: r.trigger === 'contextMenu' || r.trigger === 'hoverButton' ? r.trigger : 'both',
    engine: r.engine === 'tesseract-wasm' ? 'tesseract-wasm' : 'llm-vision',
    maxEdgePx:
      typeof r.maxEdgePx === 'number' && Number.isFinite(r.maxEdgePx)
        ? clamp(Math.round(r.maxEdgePx), 512, 8192)
        : 4096,
  };
}

function legacy30NormalizeSubtitles(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') {
    return { enabled: true, bilingual: 'both', fontSizePct: 100 };
  }
  const r = raw as Record<string, unknown>;
  return {
    enabled: r.enabled !== false,
    bilingual: r.bilingual === 'src' || r.bilingual === 'dst' ? r.bilingual : 'both',
    fontSizePct:
      typeof r.fontSizePct === 'number' && Number.isFinite(r.fontSizePct)
        ? clamp(Math.round(r.fontSizePct), 50, 250)
        : 100,
  };
}

function legacy30Normalize(raw: unknown): Record<string, unknown> {
  const defaults = {
    schemaVersion: 3,
    defaultDisplayMode: 'bilingual',
    autoTranslate: false,
    blacklist: [] as string[],
    defaultSourceLanguage: 'auto',
    defaultTargetLanguage: '简体中文',
    cacheEnabled: true,
    minTextLength: 6,
    glossary: [] as unknown[],
    glossaryVersion: 0,
    failoverChain: [] as string[],
    selectionTranslate: 'always',
    inlineBudget: 300,
    viewportBudget: 500,
    languageDetection: 'auto',
    selectionSpeak: true,
  };
  if (raw === null || typeof raw !== 'object') return defaults;
  const r = raw as Record<string, unknown>;
  const modes = [
    'original',
    'translated',
    'translated_hover_original',
    'original_hover_translated',
    'bilingual',
    'inline',
  ];
  const sel = ['always', 'alt', 'off'];
  return {
    schemaVersion: 3,
    activeProviderId: typeof r.activeProviderId === 'string' ? r.activeProviderId : '',
    providers: Array.isArray(r.providers) ? r.providers : [],
    defaultDisplayMode: modes.includes(r.defaultDisplayMode as string)
      ? r.defaultDisplayMode
      : 'bilingual',
    autoTranslate: r.autoTranslate === true,
    blacklist: Array.isArray(r.blacklist)
      ? r.blacklist.filter((h): h is string => typeof h === 'string')
      : [],
    defaultSourceLanguage:
      typeof r.defaultSourceLanguage === 'string' ? r.defaultSourceLanguage : 'auto',
    defaultTargetLanguage:
      typeof r.defaultTargetLanguage === 'string' ? r.defaultTargetLanguage : '简体中文',
    cacheEnabled: r.cacheEnabled !== false,
    minTextLength:
      typeof r.minTextLength === 'number' && Number.isFinite(r.minTextLength)
        ? clamp(Math.round(r.minTextLength), 1, 200)
        : 6,
    glossary: Array.isArray(r.glossary) ? r.glossary : [],
    glossaryVersion: typeof r.glossaryVersion === 'number' ? r.glossaryVersion : 0,
    siteRules: Array.isArray(r.siteRules) ? r.siteRules : [],
    failoverChain: Array.isArray(r.failoverChain) ? r.failoverChain : [],
    selectionTranslate: sel.includes(r.selectionTranslate as string)
      ? r.selectionTranslate
      : 'always',
    inlineBudget: typeof r.inlineBudget === 'number' ? r.inlineBudget : 300,
    viewportBudget: typeof r.viewportBudget === 'number' ? r.viewportBudget : 500,
    pdfViewer: legacy30NormalizePdfViewer(r.pdfViewer),
    imageTranslate: legacy30NormalizeImageTranslate(r.imageTranslate),
    subtitles: legacy30NormalizeSubtitles(r.subtitles),
    languageDetection: r.languageDetection === 'off' ? 'off' : 'auto',
    selectionSpeak: r.selectionSpeak !== false,
  };
}

describe('v4 -> v3 read compatibility', () => {
  it('3.0-style normalization reads a v4 document without losing v3 fields', () => {
    const v4Doc = normalizeSettings(v3Settings);
    const legacy = legacy30Normalize(v4Doc) as unknown as Settings & Record<string, unknown>;
    expect(legacy.schemaVersion).toBe(3);
    expect(legacy.defaultDisplayMode).toBe('inline');
    expect(legacy.autoTranslate).toBe(true);
    expect(legacy.blacklist).toEqual(['mail.example.com']);
    expect(legacy.minTextLength).toBe(7);
    expect(legacy.glossary).toEqual([{ source: 'model', target: '模型' }]);
    expect(legacy.selectionTranslate).toBe('alt');
    expect(Array.isArray(legacy.providers)).toBe(true);
    expect((legacy.providers[0] as { apiKey: string }).apiKey).toBe('sk-test-789');
    expect(legacy.pdfViewer.defaultMode).toBe('translated_hover_original');
    expect(legacy.pdfViewer.skipHeadersFooters).toBe(false);
    expect(legacy.pdfViewer.maxConcurrentPages).toBe(5);
    expect(legacy.pdfViewer.autoOpen).toBe(true);
    expect(legacy.imageTranslate.trigger).toBe('contextMenu');
    expect(legacy.imageTranslate.engine).toBe('tesseract-wasm');
    expect(legacy.imageTranslate.maxEdgePx).toBe(2048);
    expect(legacy.subtitles.bilingual).toBe('dst');
    expect(legacy.subtitles.fontSizePct).toBe(120);
    expect(legacy.languageDetection).toBe('off');
    expect(legacy.selectionSpeak).toBe(false);
    expect(legacy.asr).toBeUndefined();
    expect(legacy.translationMemory).toBeUndefined();
    expect((legacy.pdfViewer as unknown as Record<string, unknown>).scannedPageOcr).toBeUndefined();
    expect((legacy.imageTranslate as unknown as Record<string, unknown>).tessLangs).toBeUndefined();
    expect((legacy.subtitles as unknown as Record<string, unknown>).swapSrcDst).toBeUndefined();
    expect((legacy.subtitles as unknown as Record<string, unknown>).background).toBeUndefined();
    expect((legacy.subtitles as unknown as Record<string, unknown>).position).toBeUndefined();
  });
});
