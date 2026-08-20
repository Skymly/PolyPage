// @ts-nocheck
/**
 * Firefox gecko.id stays aligned with the native-host installer (spec 4.1 §7.2).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Firefox native-host identity', () => {
  it('gecko.id matches the installer DefaultGeckoId', () => {
    const mjs = readFileSync(resolve('scripts/manifest-firefox.mjs'), 'utf8');
    const cs = readFileSync(resolve('native-host/PolyPage.Gateway/Installer.cs'), 'utf8');
    expect(mjs).toContain("export const GECKO_ID = 'polypage@skymly.com';");
    expect(cs).toContain('public const string DefaultGeckoId = "polypage@skymly.com";');
    expect(cs).toContain('Software\\Mozilla\\NativeMessagingHosts');
    expect(cs).toContain('allowed_extensions');
    expect(cs).toContain('.firefox.json');
  });
});
