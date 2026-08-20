/**
 * Schema v5 migration tests (spec 4.1 §9.3, §12.1):
 *  - v4 -> v5 migration only adds defaults and never clears existing fields;
 *  - v5 settings remain readable by 4.0-style normalization (unknown fields
 *    ignored) — the same backwards-compat guarantee 4.0 gave 3.0.
 */
import { describe, expect, it } from 'vitest';
import { clamp } from '../src/shared/utils';
import { normalizeSettings } from '../src/storage/settings';

const v4Settings = {
  schemaVersion: 4,
  activeProviderId: 'my-openai',
  providers: [
    {
      id: 'my-openai',
      name: 'My LLM',
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-410',
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
      headers: { 'X-Four': '4' },
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
    defaultMode: 'translated_hover_original' as const,
    skipHeadersFooters: false,
    maxConcurrentPages: 5,
    autoOpen: true,
    scannedPageOcr: false,
  },
  imageTranslate: {
    enabled: true,
    trigger: 'contextMenu' as const,
    engine: 'tesseract-wasm' as const,
    maxEdgePx: 2048,
    tessLangs: ['eng', 'chi_sim'],
  },
  subtitles: {
    enabled: true,
    bilingual: 'dst' as const,
    fontSizePct: 120,
    swapSrcDst: true,
    background: 'rgba(0,0,0,.85)',
    position: 'top' as const,
  },
  languageDetection: 'off' as const,
  selectionSpeak: false,
  asr: { enabled: false, maxSeconds: 30, maxUploadMb: 8, confirmFull: false },
  translationMemory: { enabled: false, maxEntries: 2000 },
};

describe('v4 -> v5 migration', () => {
  const migrated = normalizeSettings(v4Settings);

  it('bumps schemaVersion to current', () => {
    expect(migrated.schemaVersion).toBe(6);
  });

  it('keeps every existing v4 field intact', () => {
    expect(migrated.activeProviderId).toBe('my-openai');
    expect(migrated.providers[0].apiKey).toBe('sk-test-410');
    expect(migrated.defaultDisplayMode).toBe('inline');
    expect(migrated.autoTranslate).toBe(true);
    expect(migrated.minTextLength).toBe(7);
    expect(migrated.glossary).toEqual([{ source: 'model', target: '模型' }]);
    expect(migrated.selectionTranslate).toBe('alt');
    expect(migrated.pdfViewer.scannedPageOcr).toBe(false);
    expect(migrated.imageTranslate.engine).toBe('tesseract-wasm');
    expect(migrated.subtitles.swapSrcDst).toBe(true);
    expect(migrated.asr.enabled).toBe(false);
    expect(migrated.asr.maxSeconds).toBe(30);
    expect(migrated.translationMemory.enabled).toBe(false);
    expect(migrated.translationMemory.maxEntries).toBe(2000);
  });

  it('adds 4.1 defaults without touching stored fields', () => {
    expect(migrated.ocrPacks.extraLangs).toEqual([]);
    expect(migrated.imageOverlay.enabled).toBe(false);
    expect(migrated.asr.streaming).toBe(false);
    expect(migrated.pdfViewer.layoutPreset).toBe('auto');
  });
});

function legacy40Normalize(raw: unknown): Record<string, unknown> {
  const defaults = {
    schemaVersion: 4,
    defaultDisplayMode: 'bilingual',
    autoTranslate: false,
    blacklist: [] as string[],
    minTextLength: 6,
    asr: { enabled: true, maxSeconds: 90, maxUploadMb: 20, confirmFull: true },
    translationMemory: { enabled: false, maxEntries: 5000 },
  };
  if (raw === null || typeof raw !== 'object') return defaults;
  const r = raw as Record<string, unknown>;
  const asrRaw = r.asr && typeof r.asr === 'object' ? (r.asr as Record<string, unknown>) : {};
  const tmRaw = r.translationMemory && typeof r.translationMemory === 'object'
    ? (r.translationMemory as Record<string, unknown>)
    : {};
  const pdfRaw = r.pdfViewer && typeof r.pdfViewer === 'object' ? (r.pdfViewer as Record<string, unknown>) : {};
  return {
    schemaVersion: 4,
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
    },
    asr: {
      enabled: asrRaw.enabled !== false,
      maxSeconds: typeof asrRaw.maxSeconds === 'number' ? asrRaw.maxSeconds : 90,
      maxUploadMb: typeof asrRaw.maxUploadMb === 'number' ? asrRaw.maxUploadMb : 20,
      confirmFull: asrRaw.confirmFull !== false,
    },
    translationMemory: {
      enabled: tmRaw.enabled === true,
      maxEntries: typeof tmRaw.maxEntries === 'number' ? tmRaw.maxEntries : 5000,
    },
  };
}

describe('v5 -> v4 read compatibility', () => {
  it('4.0-style normalization reads a v5 document without losing v4 fields', () => {
    const v5Doc = normalizeSettings(v4Settings);
    const legacy = legacy40Normalize(v5Doc);
    expect(legacy.schemaVersion).toBe(4);
    expect(legacy.defaultDisplayMode).toBe('inline');
    expect(legacy.autoTranslate).toBe(true);
    expect(legacy.minTextLength).toBe(7);
    expect((legacy.asr as { enabled: boolean }).enabled).toBe(false);
    expect((legacy.asr as { maxSeconds: number }).maxSeconds).toBe(30);
    expect((legacy.translationMemory as { maxEntries: number }).maxEntries).toBe(2000);
    expect((legacy.asr as { streaming?: boolean }).streaming).toBeUndefined();
    expect(legacy.ocrPacks).toBeUndefined();
    expect(legacy.imageOverlay).toBeUndefined();
    expect((legacy.pdfViewer as { layoutPreset?: string }).layoutPreset).toBeUndefined();
  });
});
