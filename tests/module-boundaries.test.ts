// @ts-nocheck
/**
 * M-57: content does not import providers/; openai-compatible does not
 * import ocr/; SW header matches ADR-0002 (OCR 往返 cache, not 翻译管线 cache).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

describe('M-57 import direction', () => {
  it('content/index does not import providers/', () => {
    expect(src('src/content/index.ts')).not.toMatch(/from ['"]\.\.\/providers\//);
  });

  it('openai-compatible does not import ocr/', () => {
    expect(src('src/providers/openai-compatible.ts')).not.toMatch(/from ['"]\.\.\/ocr\//);
  });

  it('service-worker header does not claim OCR uses translation cache', () => {
    const header = src('src/background/service-worker.ts').slice(0, 1600);
    expect(header).not.toMatch(/all through the existing cache/i);
    expect(header).toMatch(/ADR-0002/);
  });
});
