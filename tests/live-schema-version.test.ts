// @ts-nocheck
/**
 * M-93: live-check scripts must seed the current schema, not a stale v5 shape.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = [
  'scripts/load-edge-ollama.mjs',
  'scripts/ollama-live-check.mjs',
  'scripts/minimax-live-check.mjs',
];

describe('live-check schemaVersion (M-93)', () => {
  it('does not hardcode schemaVersion 5', () => {
    for (const rel of files) {
      const src = readFileSync(resolve(rel), 'utf8');
      expect(src, rel).not.toMatch(/schemaVersion:\s*5\b/);
      expect(src, rel).toMatch(/SCHEMA_VERSION/);
    }
  });
});
