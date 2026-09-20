// @ts-nocheck
/**
 * M-92: firefox-gateway-check must fail closed on DEGRADED native-host.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('firefox-gateway-check exit codes (M-92)', () => {
  const src = readFileSync(resolve('scripts/firefox-gateway-check.mjs'), 'utf8');

  it('does not treat DEGRADED as success', () => {
    expect(src).toContain('process.exitCode = 3');
    expect(src).not.toContain('process.exitCode = result.addonLoaded ? 0 : 1');
    expect(src).toMatch(/Exit 3/);
  });
});
