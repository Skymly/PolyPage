/**
 * Schema v3 migration tests (spec 3.0 §9.3, §12.1):
 *  - v2 -> v3 migration only adds defaults and never clears existing fields;
 *  - v3 settings remain readable by 2.0-style normalization (unknown fields
 *    ignored) — the same backwards-compat guarantee 2.0 gave 1.0.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_SITE_RULES } from '../src/shared/constants';
import type { Settings } from '../src/shared/types';
import { clamp } from '../src/shared/utils';
import { normalizeSettings } from '../src/storage/settings';

/** A realistic 2.0 (schema v2) settings document. */
const v2Settings = {
  schemaVersion: 2,
  activeProviderId: 'my-openai',
  providers: [
    {
      id: 'my-openai',
      name: 'My LLM',
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-456',
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
      headers: { 'X-Two': '2' },
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
};

describe('v2 -> v3 migration', () => {
  const migrated = normalizeSettings(v2Settings);

  it('bumps schemaVersion to 3', () => {
    expect(migrated.schemaVersion).toBe(3);
  });

  it('keeps every existing v2 field intact', () => {
    expect(migrated.activeProviderId).toBe('my-openai');
    expect(migrated.providers).toHaveLength(1);
    const p = migrated.providers[0];
    expect(p.apiKey).toBe('sk-test-456');
    expect(p.baseUrl).toBe('https://api.openai.com/v1');
    expect(p.timeoutMs).toBe(45000);
    expect(p.maxBatchItems).toBe(6);
    expect(p.temperature).toBe(0.4);
    expect(p.headers).toEqual({ 'X-Two': '2' });
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
  });

  it('adds 3.0 defaults without touching stored fields', () => {
    expect(migrated.pdfViewer.enabled).toBe(true);
    expect(migrated.pdfViewer.defaultMode).toBe('bilingual');
    expect(migrated.pdfViewer.skipHeadersFooters).toBe(true);
    expect(migrated.imageTranslate.enabled).toBe(true);
    expect(migrated.imageTranslate.engine).toBe('llm-vision');
    expect(migrated.subtitles.bilingual).toBe('both');
    expect(migrated.languageDetection).toBe('auto');
    expect(migrated.selectionSpeak).toBe(true);
    // Built-ins re-added alongside the user rule.
    for (const builtin of BUILTIN_SITE_RULES) {
      expect(migrated.siteRules.some((r) => r.id === builtin.id)).toBe(true);
    }
  });

  it('normalizes partial 3.0 sections leniently', () => {
    const s = normalizeSettings({
      ...v2Settings,
      pdfViewer: { defaultMode: 'translated_hover_original', maxConcurrentPages: 99 },
      imageTranslate: { trigger: 'hoverButton', maxEdgePx: 1 },
      subtitles: { bilingual: 'dst', fontSizePct: 9999 },
      languageDetection: 'off',
      selectionSpeak: false,
    });
    expect(s.pdfViewer.defaultMode).toBe('translated_hover_original');
    expect(s.pdfViewer.enabled).toBe(true);
    expect(s.pdfViewer.maxConcurrentPages).toBe(8); // clamped
    expect(s.imageTranslate.trigger).toBe('hoverButton');
    expect(s.imageTranslate.maxEdgePx).toBe(512); // clamped
    expect(s.subtitles.bilingual).toBe('dst');
    expect(s.subtitles.fontSizePct).toBe(250); // clamped
    expect(s.languageDetection).toBe('off');
    expect(s.selectionSpeak).toBe(false);
  });

  it('normalizes site rule subtitleSelectors', () => {
    const s = normalizeSettings({
      siteRules: [
        {
          id: 'sub-rule',
          match: ['video.example.com'],
          subtitleSelectors: ['.captions', '  ', 42],
        },
      ],
    });
    const rule = s.siteRules.find((r) => r.id === 'sub-rule');
    expect(rule?.subtitleSelectors).toEqual(['.captions']);
  });
});

/**
 * Copy of the 2.0 normalizeSettings contract (schema v2 output, unknown
 * fields ignored). Proves a 2.0 build can safely read a v3 document.
 */
function legacy20Normalize(raw: unknown): Record<string, unknown> {
  const defaults = {
    schemaVersion: 2,
    defaultDisplayMode: 'bilingual',
    autoTranslate: false,
    blacklist: [],
    defaultSourceLanguage: 'auto',
    defaultTargetLanguage: '简体中文',
    cacheEnabled: true,
    minTextLength: 6,
    glossary: [],
    glossaryVersion: 0,
    failoverChain: [],
    selectionTranslate: 'always',
    inlineBudget: 300,
    viewportBudget: 500,
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
    schemaVersion: 2,
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
  };
}

describe('v3 -> v2 read compatibility', () => {
  it('2.0-style normalization reads a v3 document without losing v2 fields', () => {
    const v3Doc = normalizeSettings(v2Settings);
    // Make the document carry every 3.0 addition.
    v3Doc.pdfViewer.maxConcurrentPages = 5;
    v3Doc.imageTranslate.trigger = 'contextMenu';
    const legacy = legacy20Normalize(v3Doc) as unknown as Settings & Record<string, unknown>;
    expect(legacy.schemaVersion).toBe(2);
    expect(legacy.defaultDisplayMode).toBe('inline');
    expect(legacy.autoTranslate).toBe(true);
    expect(legacy.blacklist).toEqual(['mail.example.com']);
    expect(legacy.minTextLength).toBe(7);
    expect(legacy.glossary).toEqual([{ source: 'model', target: '模型' }]);
    expect(legacy.selectionTranslate).toBe('alt');
    expect(Array.isArray(legacy.providers)).toBe(true);
    expect((legacy.providers[0] as { apiKey: string }).apiKey).toBe('sk-test-456');
  });
});