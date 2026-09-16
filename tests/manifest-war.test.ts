// @ts-nocheck
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('manifest web_accessible_resources (M-54)', () => {
  it('does not expose vendor to arbitrary pages', () => {
    const manifest = JSON.parse(readFileSync(resolve('public/manifest.json'), 'utf8'));
    expect(manifest.web_accessible_resources).toBeUndefined();
  });
});
