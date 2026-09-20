// @ts-nocheck
/**
 * Firefox gecko.id stays aligned with the native-host installer (spec 4.1 §7.2).
 * M-92: assert the written dist-firefox manifest, not just source toContain.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GECKO_ID, writeFirefoxDist } from '../scripts/manifest-firefox.mjs';

describe('Firefox native-host identity', () => {
  it('gecko.id matches the installer DefaultGeckoId', () => {
    const mjs = readFileSync(path.resolve('scripts/manifest-firefox.mjs'), 'utf8');
    const cs = readFileSync(path.resolve('native-host/PolyPage.Gateway/Installer.cs'), 'utf8');
    expect(mjs).toContain("export const GECKO_ID = 'polypage@skymly.com';");
    expect(cs).toContain('public const string DefaultGeckoId = "polypage@skymly.com";');
    expect(cs).toContain('Software\\Mozilla\\NativeMessagingHosts');
    expect(cs).toContain('allowed_extensions');
    expect(cs).toContain('.firefox.json');
    expect(mjs).toContain("p !== 'offscreen'");
    const manifest = JSON.parse(readFileSync(path.resolve('public/manifest.json'), 'utf8'));
    expect(manifest.permissions).toContain('offscreen');
    expect(manifest.content_security_policy?.extension_pages).toContain('wasm-unsafe-eval');
  });
});

describe('dist-firefox manifest (M-92)', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes gecko.id, event-page background, and drops offscreen', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'polypage-fx-manifest-'));
    dirs.push(rootDir);
    const dist = path.join(rootDir, 'dist');
    mkdirSync(dist);
    writeFileSync(
      path.join(dist, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        background: { service_worker: 'background.js', type: 'module' },
        permissions: ['storage', 'nativeMessaging', 'offscreen'],
        host_permissions: ['<all_urls>'],
        content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: ['content.js'] }],
      }),
    );
    const out = path.join(rootDir, 'dist-firefox');
    await writeFirefoxDist(dist, out);
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.browser_specific_settings.gecko.id).toBe(GECKO_ID);
    expect(manifest.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(manifest.permissions).toEqual(['storage', 'nativeMessaging']);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });
});
