// @ts-nocheck
/**
 * M-95: one source for official Provider base URLs; icons join the build;
 * CONTEXT _Avoid_ does not rename exported identifiers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URLS, defaultProvider } from '../src/shared/constants';
import { PROVIDER_PRESETS } from '../src/providers/presets';
import { parseDisplayMode } from '../src/shared/types';

describe('official Provider base URLs (M-95)', () => {
  it('keeps defaultProvider, presets, and type fallbacks on one map', () => {
    expect(defaultProvider().baseUrl).toBe(DEFAULT_BASE_URLS['openai-compatible']);
    expect(PROVIDER_PRESETS.find((p) => p.id === 'preset-openai')?.baseUrl).toBe(
      DEFAULT_BASE_URLS['openai-compatible'],
    );
    expect(PROVIDER_PRESETS.find((p) => p.id === 'preset-deepl')?.baseUrl).toBe(DEFAULT_BASE_URLS.deepl);
    expect(PROVIDER_PRESETS.find((p) => p.id === 'preset-azure-translator')?.baseUrl).toBe(
      DEFAULT_BASE_URLS['azure-translator'],
    );
    expect(PROVIDER_PRESETS.find((p) => p.id === 'preset-google-translate')?.baseUrl).toBe(
      DEFAULT_BASE_URLS['google-translate'],
    );
  });

  it('does not keep per-file official URL copies', () => {
    for (const rel of [
      'src/providers/deepl.ts',
      'src/providers/azure-translator.ts',
      'src/providers/google-translate.ts',
      'src/options/main.ts',
    ]) {
      const src = readFileSync(resolve(rel), 'utf8');
      expect(src, rel).not.toMatch(/const DEFAULT_BASE_URL = 'https:/);
      expect(src, rel).toContain('DEFAULT_BASE_URLS');
    }
  });
});

describe('display mode parse (M-95)', () => {
  it('accepts known modes and rejects the rest', () => {
    expect(parseDisplayMode('inline')).toBe('inline');
    expect(parseDisplayMode('nope')).toBeNull();
  });
});

describe('icons and CONTEXT identifiers (M-95)', () => {
  it('build copyStatic generates icons before copying them', () => {
    const src = readFileSync(resolve('scripts/build.mjs'), 'utf8');
    expect(src).toContain('generateIcons');
  });

  it('CONTEXT keeps _Avoid_ and documents identifiers separately', () => {
    const src = readFileSync(resolve('CONTEXT.md'), 'utf8');
    expect(src).toMatch(/^## Identifiers/m);
    expect(src).toContain('PageTranslator');
    expect(src).toMatch(/_Avoid_:\s*PageTranslator/);
  });
});
