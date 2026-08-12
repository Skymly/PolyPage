import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/shared/constants';
import { normalizeProvider, normalizeSettings, validateImportedSettings } from '../src/storage/settings';

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
    expect(s.providers.map((p) => p.id)).toEqual(['a']);
    expect(s.activeProviderId).toBe('a');
  });

  it('clamps numeric fields', () => {
    const s = normalizeSettings({
      providers: [{ id: 'a', type: 'custom-http', timeoutMs: 5, maxBatchItems: 99999 }],
    });
    expect(s.providers[0].timeoutMs).toBe(1000);
    expect(s.providers[0].maxBatchItems).toBe(100);
  });
});

describe('normalizeProvider', () => {
  it('rejects invalid providers', () => {
    expect(normalizeProvider(null)).toBeNull();
    expect(normalizeProvider({ id: '', type: 'openai-compatible' })).toBeNull();
    expect(normalizeProvider({ id: 'x', type: 'nope' })).toBeNull();
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
