import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/shared/constants';
import { applyFullSettingsSave, normalizeProvider, normalizeSettings, redactSettings, validateImportedSettings } from '../src/storage/settings';

describe('normalizeSettings', () => {
  it('returns defaults for garbage input', () => {
    const s = normalizeSettings(undefined);
    expect(s.providers.length).toBe(1);
    expect(s.defaultDisplayMode).toBe('bilingual');
  });

  it('keeps valid providers and fixes the active id', () => {
    const s = normalizeSettings({
      activeProviderId: 'missing',
      providers: [
        { id: 'a', type: 'openai-compatible', baseUrl: 'http://x', name: 'A' },
        { id: 'b', type: 'bogus-type' },
      ],
    });
    expect(s.providers.map((p) => p.id)).toEqual(['a', 'b']);
    expect(s.activeProviderId).toBe('a');
  });

  it('clamps numeric fields', () => {
    const s = normalizeSettings({
      providers: [{ id: 'a', type: 'custom-http', timeoutMs: 5, maxBatchItems: 99999 }],
    });
    expect(s.providers[0].timeoutMs).toBe(1000);
    expect(s.providers[0].maxBatchItems).toBe(100);
  });

  it('does not replace a sole unknown-type provider with the default OpenAI (M-56)', () => {
    const s = normalizeSettings({
      providers: [{ id: 'legacy', type: 'future-llm', apiKey: 'keep-me', name: 'Future' }],
    });
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0].id).toBe('legacy');
    expect(s.providers[0].type).toBe('future-llm');
    expect(s.providers[0].apiKey).toBe('keep-me');
    expect(s.activeProviderId).toBe('legacy');
  });
});

describe('normalizeProvider', () => {
  it('rejects providers without an id', () => {
    expect(normalizeProvider(null)).toBeNull();
    expect(normalizeProvider({ id: '', type: 'openai-compatible' })).toBeNull();
  });

  it('keeps unknown types and their apiKey (M-56)', () => {
    const p = normalizeProvider({ id: 'x', type: 'nope', apiKey: 'secret', name: 'Future' });
    expect(p?.id).toBe('x');
    expect(p?.type).toBe('nope');
    expect(p?.apiKey).toBe('secret');
    expect(p?.name).toBe('Future');
  });

  it('defaults openai-compatible extras: streaming on, vision/asr off (M-34)', () => {
    const p = normalizeProvider({ id: 'a', type: 'openai-compatible', baseUrl: 'http://x' });
    expect(p?.supportsStreaming).toBe(true);
    expect(p?.supportsVision).toBe(false);
    expect(p?.supportsAsr).toBe(false);
    const on = normalizeProvider({
      id: 'b',
      type: 'openai-compatible',
      baseUrl: 'http://x',
      supportsVision: true,
      supportsAsr: true,
      supportsStreaming: false,
    });
    expect(on?.supportsVision).toBe(true);
    expect(on?.supportsAsr).toBe(true);
    expect(on?.supportsStreaming).toBe(false);
  });
});

describe('validateImportedSettings', () => {
  it('accepts an exported payload', () => {
    const payload = { app: 'polypage-web-translator', settings: defaultSettings() };
    payload.settings.providers[0].baseUrl = 'https://api.example.com/v1';
    expect(validateImportedSettings(payload)).not.toBeNull();
  });
  it('rejects payloads without a configured base URL', () => {
    expect(validateImportedSettings({ providers: [{ id: 'a', type: 'custom-http', baseUrl: '' }] })).toBeNull();
  });
  it('rejects non-objects', () => {
    expect(validateImportedSettings('hello')).toBeNull();
    expect(validateImportedSettings(null)).toBeNull();
  });
});

describe('redactSettings (M-53)', () => {
  it('clears apiKey and headers without mutating the original', () => {
    const s = normalizeSettings({
      providers: [
        {
          id: 'a',
          type: 'openai-compatible',
          baseUrl: 'http://x',
          name: 'A',
          apiKey: 'secret',
          headers: { Authorization: 'Bearer x' },
        },
      ],
    });
    const redacted = redactSettings(s);
    expect(redacted.providers[0].apiKey).toBe('');
    expect(redacted.providers[0].headers).toEqual({});
    expect(s.providers[0].apiKey).toBe('secret');
    expect(s.providers[0].headers).toEqual({ Authorization: 'Bearer x' });
  });
});

describe('applyFullSettingsSave (M-40)', () => {
  it('does not let a stale Options draft drop OCR extraLangs', () => {
    const current = defaultSettings();
    current.ocrPacks = { extraLangs: ['jpn'] };
    current.imageTranslate = { ...current.imageTranslate, tessLangs: ['eng', 'jpn'] };
    const incoming = defaultSettings();
    incoming.defaultTargetLanguage = 'ja';
    incoming.ocrPacks = { extraLangs: [] };
    incoming.imageTranslate = { ...incoming.imageTranslate, tessLangs: ['eng'] };
    const next = applyFullSettingsSave(incoming, current, 'merge-packs');
    expect(next.ocrPacks.extraLangs).toEqual(['jpn']);
    expect(next.imageTranslate.tessLangs).toEqual(['eng', 'jpn']);
    expect(next.defaultTargetLanguage).toBe('ja');
  });

  it('replaceAll overwrites pack langs (import)', () => {
    const current = defaultSettings();
    current.ocrPacks = { extraLangs: ['jpn'] };
    const incoming = defaultSettings();
    incoming.ocrPacks = { extraLangs: [] };
    const next = applyFullSettingsSave(incoming, current, 'replace');
    expect(next.ocrPacks.extraLangs).toEqual([]);
  });
});

describe('built-in site rules (M-64)', () => {
  it('keeps a disabled built-in after normalize instead of resurrecting a second copy', () => {
    const s = normalizeSettings({
      siteRules: [{ id: 'builtin-wikipedia', match: ['*.wikipedia.org'], enabled: false }],
    });
    const wiki = s.siteRules.filter((r) => r.id === 'builtin-wikipedia');
    expect(wiki).toHaveLength(1);
    expect(wiki[0].enabled).toBe(false);
  });
});
