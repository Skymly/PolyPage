// @ts-nocheck
/**
 * M-90: production build is scripts/build.mjs; vendored tesseract has no
 * dangling source maps; tesseract.js is a pin in devDependencies.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('build hygiene (M-90)', () => {
  it('vite.config.ts does not claim a production multi-page build', () => {
    const src = readFileSync(resolve('vite.config.ts'), 'utf8');
    expect(src).not.toMatch(/build\s*:\s*\{/);
    expect(src).toContain('scripts/build.mjs');
  });

  it('verifyDist requires the tesseract wasm sibling', () => {
    const src = readFileSync(resolve('scripts/build.mjs'), 'utf8');
    expect(src).toContain("'vendor/tesseract-core-simd-lstm.wasm'");
    const hashes = JSON.parse(readFileSync(resolve('scripts/vendor-hashes.json'), 'utf8'));
    expect(hashes.files['tesseract-core-simd-lstm.wasm']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('vendored JS has no dangling sourceMappingURL', () => {
    for (const name of [
      'vendor/tesseract.esm.min.js',
      'vendor/tesseract-worker.min.js',
      'vendor/tesseract-core-simd-lstm.wasm.js',
      'vendor/pdf.min.mjs',
      'vendor/pdf.worker.min.mjs',
    ]) {
      const text = readFileSync(resolve(name), 'utf8');
      expect(text, name).not.toMatch(/sourceMappingURL=/);
    }
  });

  it('tesseract.js is pinned in devDependencies like pdfjs-dist', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    expect(pkg.dependencies?.['tesseract.js']).toBeUndefined();
    expect(pkg.devDependencies['tesseract.js']).toBe('7.0.0');
    expect(pkg.devDependencies['pdfjs-dist']).toBe('4.10.38');
  });
});
