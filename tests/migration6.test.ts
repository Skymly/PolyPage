/**
 * Schema v6 migration tests (spec 4.2 §9.3, §12.1):
 *  - v5 -> v6 migration only adds defaults and never clears existing fields;
 *  - v6 settings remain readable by 4.1-style normalization (unknown fields
 *    ignored) — the same backwards-compat guarantee 4.1 gave 4.0.
 */
import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../src/storage/settings';

const v5Settings = {
  schemaVersion: 5,
  activeProviderId: 'my-openai',
  providers: [
    {
      id: 'my-openai',
      name: 'My LLM',
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-420',
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
      headers: { 'X-Five': '5' },
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
  siteRules: [{ id: 'user-rule', match: ['example.com'], minTextLength: 9, enabled: true }],
  failoverChain: [],
  selectionTranslate: 'alt',
  inlineBudget: 250,
  viewportBudget: 600,
  pdfViewer: {
    enabled: true,
    defaultMode: 'translated_hover_original',
    skipHeadersFooters: false,
    maxConcurrentPages: 5,
    autoOpen: true,
    scannedPageOcr: false,
    layoutPreset: 'columns',
  },
  imageTranslate: {
    enabled: true,
    trigger: 'contextMenu',
    engine: 'tesseract-wasm',
    maxEdgePx: 2048,
    tessLangs: ['eng', 'chi_sim'],
  },
  subtitles: {
    enabled: true,
    bilingual: 'dst',
    fontSizePct: 120,
    swapSrcDst: true,
    background: 'rgba(0,0,0,.85)',
    position: 'top',
  },
  languageDetection: 'off',
  selectionSpeak: false,
  asr: { enabled: false, maxSeconds: 30, maxUploadMb: 8, confirmFull: false, streaming: true },
  translationMemory: { enabled: true, maxEntries: 2000 },
  ocrPacks: { extraLangs: ['fra'] },
  imageOverlay: { enabled: true },
};

describe('v5 -> v6 migration', () => {
  const migrated = normalizeSettings(v5Settings);

  it('bumps schemaVersion to 6', () => {
    expect(migrated.schemaVersion).toBe(6);
  });

  it('keeps every existing v5 field intact', () => {
    expect(migrated.activeProviderId).toBe('my-openai');
    expect(migrated.providers[0].apiKey).toBe('sk-test-420');
    expect(migrated.defaultDisplayMode).toBe('inline');
    expect(migrated.autoTranslate).toBe(true);
    expect(migrated.minTextLength).toBe(7);
    expect(migrated.glossary).toEqual([{ source: 'model', target: '模型' }]);
    expect(migrated.selectionTranslate).toBe('alt');
    expect(migrated.pdfViewer.scannedPageOcr).toBe(false);
    expect(migrated.pdfViewer.layoutPreset).toBe('columns');
    expect(migrated.imageTranslate.engine).toBe('tesseract-wasm');
    expect(migrated.subtitles.swapSrcDst).toBe(true);
    expect(migrated.asr.enabled).toBe(false);
    expect(migrated.asr.streaming).toBe(true);
    expect(migrated.translationMemory.enabled).toBe(true);
    expect(migrated.ocrPacks.extraLangs).toEqual(['fra']);
    expect(migrated.imageOverlay.enabled).toBe(true);
  });

  it('adds 4.2 outputSanitize defaults without touching stored fields', () => {
    expect(migrated.outputSanitize).toEqual({
      enabled: true,
      stripThink: true,
      stripCodeFences: false,
    });
  });
});

describe('v6 is additive over v5 (M-93)', () => {
  it('keeps the v5 seed and only adds 4.2 fields', () => {
    const v6 = normalizeSettings(v5Settings);
    const { schemaVersion: _ignored, siteRules, ...seed } = v5Settings;
    expect(v6).toMatchObject(seed);
    expect(v6.siteRules.some((rule) => rule.id === 'user-rule')).toBe(true);
    expect(v6.schemaVersion).toBe(6);
    expect(v6.outputSanitize).toEqual({
      enabled: true,
      stripThink: true,
      stripCodeFences: false,
    });
  });
});
