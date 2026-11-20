// @ts-nocheck
/**
 * M-92: firefox-gateway-check must fail closed on DEGRADED native-host.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firefoxProbeFailure } from '../scripts/firefox-gateway-probe.mjs';

describe('firefox-gateway-check exit codes (M-92)', () => {
  const src = readFileSync(resolve('scripts/firefox-gateway-check.mjs'), 'utf8');

  it('does not treat DEGRADED as success', () => {
    expect(src).toContain('process.exitCode = 3');
    expect(src).not.toMatch(/process\.exit(?:Code\s*=\s*|\()\s*result\.addonLoaded\s*\?\s*0\s*:\s*1/);
    expect(src).toMatch(/Exit 3/);
  });
});

describe('Firefox native gateway result', () => {
  const status = { installed: true, protocol: 2 };
  const translate = { results: { fx1: 'fixture output' }, errors: {} };

  it('requires the fixture to pass through the native host', () => {
    expect(firefoxProbeFailure({ status, translate }, 'fixture output')).toBeNull();
    expect(firefoxProbeFailure({ status, translate }, 'different output')).toMatch(/fixture/);
  });

  it('fails closed for stale protocol, empty output, and translation errors', () => {
    expect(firefoxProbeFailure({ status: { ...status, protocol: 1 }, translate })).toMatch(/protocol 2/);
    expect(firefoxProbeFailure({ status, translate: { results: { fx1: ' ' } } })).toMatch(/fx1/);
    expect(firefoxProbeFailure({ status, translate: { ...translate, errors: { fx1: 'failed' } } })).toMatch(/fx1/);
  });
});
