// @ts-nocheck
/**
 * M-91: smoke harness honors EDGE_PATH, port env vars, and FFMPEG_PATH.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('smoke portability (M-91)', () => {
  const src = readFileSync(resolve('scripts/smoke-test.mjs'), 'utf8');

  it('lets EDGE_PATH override the hardcoded Edge location and fails closed if missing', () => {
    expect(src).toContain("process.env.EDGE_PATH");
    expect(src).toContain('Set EDGE_PATH to msedge.exe');
    expect(src).toMatch(/if \(!existsSync\(BROWSER\)\)/);
  });

  it('exposes SMOKE_PORT_* and SMOKE_CDP_PORT overrides', () => {
    expect(src).toContain("envPort('SMOKE_PORT_PAGE', 8123)");
    expect(src).toContain("envPort('SMOKE_PORT_API', 8124)");
    expect(src).toContain("envPort('SMOKE_PORT_XORIGIN', 8125)");
    expect(src).toContain("envPort('SMOKE_CDP_PORT', 9222)");
    expect(src).toContain('PORT_CDP');
    expect(src).not.toMatch(/http:\/\/127\.0\.0\.1:9222/);
  });

  it('uses FFMPEG_PATH and warns instead of silently stubbing', () => {
    expect(src).toContain("process.env.FFMPEG_PATH");
    expect(src).toContain('Set FFMPEG_PATH');
  });
});
