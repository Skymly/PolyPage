// @ts-nocheck
/**
 * M-66: version fields stay aligned; live docs do not freeze test counts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('version and count hygiene (M-66)', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const version = pkg.version as string;
  const verRe = version.replace(/\./g, '\\.');

  it('keeps package, lock, manifest, gateway, and store versions together', () => {
    const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(resolve('public/manifest.json'), 'utf8'));
    const csproj = readFileSync(resolve('native-host/PolyPage.Gateway/PolyPage.Gateway.csproj'), 'utf8');
    const gateway = readFileSync(resolve('native-host/PolyPage.Gateway/GatewayServer.cs'), 'utf8');
    const listing = readFileSync(resolve('docs/store/LISTING.md'), 'utf8');
    const permissions = readFileSync(resolve('docs/store/PERMISSIONS.md'), 'utf8');
    const privacy = readFileSync(resolve('docs/store/PRIVACY.md'), 'utf8');
    const plan = readFileSync(resolve('PolyPage-4.2.md'), 'utf8');
    expect(lock.version).toBe(version);
    expect(manifest.version).toBe(version);
    expect(csproj).toContain('<Version>' + version + '</Version>');
    expect(gateway).toContain('Version = "' + version + '"');
    expect(listing).toMatch(new RegExp('草稿（' + verRe + '）'));
    expect(permissions).toMatch(new RegExp('版本：' + verRe));
    expect(privacy).toMatch(new RegExp('版本：' + verRe));
    expect(plan).toContain('@ ' + version);
  });

  it('does not freeze live test or smoke counts in README', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8');
    expect(readme).not.toMatch(/vitest 单元测试（\d+）/);
    expect(readme).not.toMatch(/冒烟（\d+ 项断言）/);
    expect(readme).not.toMatch(/\*\*\d+ 个单元测试\*\*/);
    expect(readme).not.toMatch(/\*\*\d+ 项端到端断言\*\*/);
    expect(readme).toContain('见 `npm run test` 输出');
    expect(readme).toContain('见 `npm run smoke` 输出');
  });
});
