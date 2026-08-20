/**
 * Schema v6 migration tests (spec 4.2 §9.3, §12.1):
 *  - v5 -> v6 migration only adds defaults and never clears existing fields;
 *  - v6 settings remain readable by 4.1-style normalization (unknown fields
 *    ignored) — the same backwards-compat guarantee 4.1 gave 4.0.
 */
import { describe, expect, it } from 'vitest';
import { clamp } from '../src/shared/utils';
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

function legacy41Normalize(raw: unknown): Record<string, unknown> {
  const defaults = {
    schemaVersion: 5,
    defaultDisplayMode: 'bilingual',
    autoTranslate: false,
    blacklist: [],
    minTextLength: 6,
    asr: { enabled: true, maxSeconds: 90, maxUploadMb: 20, confirmFull: true, streaming: false },
    translationMemory: { enabled: false, maxEntries: 5000 },
    ocrPacks: { extraLangs: [] },
    imageOverlay: { enabled: false },
  };
  if (raw === null || typeof raw !== 'object') return defaults;
  const r = raw as Record<string, unknown>;
  const asrRaw = r.asr && typeof r.asr === 'object' ? (r.asr as Record<string, unknown>) : {};
  const tmRaw = r.translationMemory && typeof r.translationMemory === 'object' ? (r.translationMemory as Record<string, unknown>) : {};
  const pdfRaw = r.pdfViewer && typeof r.pdfViewer === 'object' ? (r.pdfViewer as Record<string, unknown>) : {};
  const packsRaw = r.ocrPacks && typeof r.ocrPacks === 'object' ? (r.ocrPacks as Record<string, unknown>) : {};
  const overlayRaw = r.imageOverlay && typeof r.imageOverlay === 'object' ? (r.imageOverlay as Record<string, unknown>) : {};
  return {
    schemaVersion: 5,
    activeProviderId: typeof r.activeProviderId === 'string' ? r.activeProviderId : '',
    providers: Array.isArray(r.providers) ? r.providers : [],
    defaultDisplayMode: r.defaultDisplayMode,
    autoTranslate: r.autoTranslate === true,
    blacklist: Array.isArray(r.blacklist) ? r.blacklist : [],
    minTextLength:
      typeof r.minTextLength === 'number' && Number.isFinite(r.minTextLength)
        ? clamp(Math.round(r.minTextLength), 1, 200)
        : 6,
    pdfViewer: {
      enabled: pdfRaw.enabled !== false,
      scannedPageOcr: pdfRaw.scannedPageOcr !== false,
      layoutPreset: pdfRaw.layoutPreset === 'single' || pdfRaw.layoutPreset === 'columns' || pdfRaw.layoutPreset === 'table'
        ? pdfRaw.layoutPreset
        : 'auto',
    },
    asr: {
      enabled: asrRaw.enabled !== false,
      maxSeconds: typeof asrRaw.maxSeconds === 'number' ? asrRaw.maxSeconds : 90,
      maxUploadMb: typeof asrRaw.maxUploadMb === 'number' ? asrRaw.maxUploadMb : 20,
      confirmFull: asrRaw.confirmFull !== false,
      streaming: asrRaw.streaming === true,
    },
    translationMemory: {
      enabled: tmRaw.enabled === true,
      maxEntries: typeof tmRaw.maxEntries === 'number' ? tmRaw.maxEntries : 5000,
    },
    ocrPacks: {
      extraLangs: Array.isArray(packsRaw.extraLangs) ? packsRaw.extraLangs : [],
    },
    imageOverlay: { enabled: overlayRaw.enabled === true },
  };
}

describe('v6 -> v5 read compatibility', () => {
  it('4.1-style normalization reads a v6 document without losing v5 fields', () => {
    const v6Doc = normalizeSettings(v5Settings);
    const legacy = legacy41Normalize(v6Doc);
    expect(legacy.schemaVersion).toBe(5);
    expect(legacy.defaultDisplayMode).toBe('inline');
    expect(legacy.autoTranslate).toBe(true);
    expect(legacy.minTextLength).toBe(7);
    expect((legacy.asr as { enabled: boolean }).enabled).toBe(false);
    expect((legacy.asr as { streaming: boolean }).streaming).toBe(true);
    expect((legacy.translationMemory as { maxEntries: number }).maxEntries).toBe(2000);
    expect((legacy.ocrPacks as { extraLangs: string[] }).extraLangs).toEqual(['fra']);
    expect((legacy.imageOverlay as { enabled: boolean }).enabled).toBe(true);
    expect((legacy.pdfViewer as { layoutPreset?: string }).layoutPreset).toBe('columns');
    expect(legacy.outputSanitize).toBeUndefined();
  });
});
