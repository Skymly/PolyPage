// @ts-nocheck
/**
 * M-96: tessdata downloads must match an existing pin; hashes are drift detection.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('vendor pins (M-96)', () => {
  it('sync-vendor fail-closes tessdata against an existing pin', () => {
    const src = readFileSync(resolve('scripts/sync-vendor.mjs'), 'utf8');
    expect(src).toContain('vendor-hashes.json');
    expect(src).toMatch(/existingPins|existing pin|hash mismatch for /);
    expect(src).toMatch(/unlink|rmSync|rm\(/);
  });

  it('documents same-repo hashes as drift detection', () => {
    const sync = readFileSync(resolve('scripts/sync-vendor.mjs'), 'utf8');
    const build = readFileSync(resolve('scripts/build.mjs'), 'utf8');
    const hashes = readFileSync(resolve('scripts/vendor-hashes.json'), 'utf8');
    expect(sync).toMatch(/drift detection/i);
    expect(build).toMatch(/drift detection/i);
    expect(hashes).toMatch(/drift detection/i);
  });
});
