/**
 * Settings schema migration tests (spec 2.0 §9.3, 3.0 §9.3, §12.1):
 *  - v1 -> v3 migration adds defaults without clearing existing fields;
 *  - v2 settings remain readable by 1.0-style normalization (unknown fields
 *    are ignored), which is the backwards-compat guarantee of §9.3 item 3.
 *  - v3 -> v2 read compatibility lives in tests/migration3.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_SITE_RULES, DEFAULT_IMAGE_MAX_EDGE_PX, DEFAULT_INLINE_BUDGET, DEFAULT_VIEWPORT_BUDGET } from '../src/shared/constants';
import type { Settings } from '../src/shared/types';
import { clamp } from '../src/shared/utils';
import { normalizeProvider, normalizeSettings } from '../src/storage/settings';

/** A realistic 1.0 (schema v1) settings document. */
const v1Settings = {
  schemaVersion: 1,
  activeProviderId: 'my-openai',
  providers: [
    {
      id: 'my-openai',
      name: 'My LLM',
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-123',
      model: 'gpt-4o-mini',
      sourceLanguage: 'English',
      targetLanguage: '简体中文',
      timeoutMs: 30000,
      maxBatchItems: 8,
      maxBatchChars: 5000,
      systemPrompt: 'translate',
      userPromptTemplate: '{{text}}',
      temperature: 0.3,
      maxTokens: 2048,
      headers: { 'X-Extra': '1' },
      enabled: true,
    },
  ],
  defaultDisplayMode: 'translated',
  autoTranslate: true,
  blacklist: ['bank.example.com'],
  defaultSourceLanguage: 'English',
  defaultTargetLanguage: '日本語',
  cacheEnabled: false,
  minTextLength: 9,
};

describe('v1 -> v3 migration', () => {
  const migrated = normalizeSettings(v1Settings);

  it('bumps schemaVersion to 3', () => {
    expect(migrated.schemaVersion).toBe(3);
  });

  it('keeps every existing v1 field intact', () => {
    expect(migrated.activeProviderId).toBe('my-openai');
    expect(migrated.providers).toHaveLength(1);
    const p = migrated.providers[0];
    expect(p.apiKey).toBe('sk-test-123');
    expect(p.baseUrl).toBe('https://api.openai.com/v1');
    expect(p.timeoutMs).toBe(30000);
    expect(p.maxBatchItems).toBe(8);
    expect(p.temperature).toBe(0.3);
    expect(p.headers).toEqual({ 'X-Extra': '1' });
    expect(migrated.defaultDisplayMode).toBe('translated');
    expect(migrated.autoTranslate).toBe(true);
    expect(migrated.blacklist).toEqual(['bank.example.com']);
    expect(migrated.defaultSourceLanguage).toBe('English');
    expect(migrated.defaultTargetLanguage).toBe('日本語');
    expect(migrated.cacheEnabled).toBe(false);
    expect(migrated.minTextLength).toBe(9);
  });

  it('adds 2.0 defaults for new fields', () => {
    expect(migrated.glossary).toEqual([]);
    expect(migrated.glossaryVersion).toBe(0);
    expect(migrated.failoverChain).toEqual([]);
    expect(migrated.selectionTranslate).toBe('always');
    expect(migrated.inlineBudget).toBe(DEFAULT_INLINE_BUDGET);
    expect(migrated.viewportBudget).toBe(DEFAULT_VIEWPORT_BUDGET);
    // Built-in site rules ship with fresh installs/migrations.
    for (const builtin of BUILTIN_SITE_RULES) {
      expect(migrated.siteRules.some((r) => r.id === builtin.id)).toBe(true);
    }
  });

  it('adds 3.0 defaults for pillar E/F/G/H fields', () => {
    expect(migrated.pdfViewer).toEqual({
      enabled: true,
      defaultMode: 'bilingual',
      skipHeadersFooters: true,
      maxConcurrentPages: 3,
      autoOpen: false,
    });
    expect(migrated.imageTranslate).toEqual({
      enabled: true,
      trigger: 'both',
      engine: 'llm-vision',
      maxEdgePx: DEFAULT_IMAGE_MAX_EDGE_PX,
    });
    expect(migrated.subtitles).toEqual({ enabled: true, bilingual: 'both', fontSizePct: 100 });
    expect(migrated.languageDetection).toBe('auto');
    expect(migrated.selectionSpeak).toBe(true);
  });
});

/**
 * Copy of the 1.0 normalizeSettings behavior (schema v1 output, unknown
 * fields ignored). Used to prove a 1.0 build can safely read v2 documents.
 */
function legacy10Normalize(raw: unknown): Record<string, unknown> {
  const defaults = {
    schemaVersion: 1,
    defaultDisplayMode: 'bilingual',
    autoTranslate: false,
    blacklist: [],
    defaultSourceLanguage: 'auto',
    defaultTargetLanguage: '简体中文',
    cacheEnabled: true,
    minTextLength: 6,
  };
  if (raw === null || typeof raw !== 'object') return defaults;
  const r = raw as Record<string, unknown>;
  const modes = ['original', 'translated', 'translated_hover_original', 'original_hover_translated', 'bilingual'];
  return {
    schemaVersion: 1,
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
  };
}

describe('v2 -> v1 read compatibility', () => {
  it('1.0-style normalization reads a v2 document without losing v1 fields', () => {
    const v2Doc = normalizeSettings(v1Settings);
    v2Doc.glossary = [{ source: 'a', target: 'b' }];
    v2Doc.glossaryVersion = 3;
    v2Doc.failoverChain = ['my-openai'];
    const legacy = legacy10Normalize(v2Doc) as unknown as Settings;
    expect(legacy.defaultDisplayMode).toBe('translated');
    expect(legacy.autoTranslate).toBe(true);
    expect(legacy.blacklist).toEqual(['bank.example.com']);
    expect(legacy.minTextLength).toBe(9);
    expect(Array.isArray(legacy.providers)).toBe(true);
  });
});

describe('2.0 provider normalization', () => {
  it('accepts new provider types with their specific fields', () => {
    const deepl = normalizeProvider({
      id: 'd1',
      type: 'deepl',
      formality: 'more',
      baseUrl: 'https://api.deepl.com',
      apiKey: 'k',
    });
    expect(deepl?.formality).toBe('more');

    const azure = normalizeProvider({ id: 'a1', type: 'azure-translator', region: 'eastasia' });
    expect(azure?.region).toBe('eastasia');

    const native = normalizeProvider({
      id: 'n1',
      type: 'native-host',
      hostName: '',
      backend: 'ollama:qwen2.5',
      fallbackProviderId: 'd1',
    });
    expect(native?.hostName).toBe('com.skymly.polypage.gateway');
    expect(native?.backend).toBe('ollama:qwen2.5');
    expect(native?.fallbackProviderId).toBe('d1');
  });

  it('still rejects unknown provider types (v1 behavior)', () => {
    expect(normalizeProvider({ id: 'x', type: 'bogus' })).toBeNull();
  });
});

describe('failover chain normalization', () => {
  it('drops provider ids that do not exist', () => {
    const s = normalizeSettings({
      providers: [{ id: 'a', type: 'openai-compatible', baseUrl: 'http://x' }],
      failoverChain: ['a', 'ghost', 'a'],
    });
    expect(s.failoverChain).toEqual(['a']);
  });
});

describe('glossary normalization', () => {
  it('filters incomplete entries and trims fields', () => {
    const s = normalizeSettings({
      glossary: [
        { source: ' foo ', target: ' bar ' },
        { source: '', target: 'x' },
        { source: 'y', target: '' },
        'garbage',
        { source: 'a', target: 'b', note: ' n ' },
      ],
      glossaryVersion: 4.9,
    });
    expect(s.glossary).toEqual([
      { source: 'foo', target: 'bar' },
      { source: 'a', target: 'b', note: 'n' },
    ]);
    expect(s.glossaryVersion).toBe(5);
  });
});