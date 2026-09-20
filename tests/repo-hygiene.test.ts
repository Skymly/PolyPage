// @ts-nocheck
/**
 * M-94: repo hygiene — ignore junk, attribute tessdata, archive finished specs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('repo hygiene (M-94)', () => {
  it('gitignore covers env, VS, test output, coverage, and nul', () => {
    const src = readFileSync(resolve('.gitignore'), 'utf8');
    expect(src).toMatch(/^\.env$/m);
    expect(src).toMatch(/^\.vs\/$/m);
    expect(src).toMatch(/^TestResults\/$/m);
    expect(src).toMatch(/^coverage\/$/m);
    expect(src).toMatch(/^nul$/m);
  });

  it('attributes tessdata_fast language packs', () => {
    const notice = readFileSync(resolve('vendor/tessdata.LICENSE'), 'utf8');
    expect(notice).toMatch(/tessdata_fast/);
    expect(notice).toMatch(/Apache License/);
  });

  it('archives finished specs under docs/history', () => {
    expect(existsSync(resolve('PolyPage.md'))).toBe(false);
    expect(existsSync(resolve('PolyPage-2.0.md'))).toBe(false);
    expect(existsSync(resolve('PolyPage-3.0.md'))).toBe(false);
    expect(existsSync(resolve('PolyPage-4.0.md'))).toBe(false);
    expect(existsSync(resolve('PolyPage-4.1.md'))).toBe(false);
    expect(existsSync(resolve('docs/VALIDATION-2.0.md'))).toBe(false);
    expect(existsSync(resolve('docs/history/PolyPage.md'))).toBe(true);
    expect(existsSync(resolve('docs/history/PolyPage-4.1.md'))).toBe(true);
    expect(existsSync(resolve('docs/history/VALIDATION-4.1.md'))).toBe(true);
    expect(existsSync(resolve('PolyPage-4.2.md'))).toBe(true);
    expect(existsSync(resolve('docs/VALIDATION-4.2.md'))).toBe(true);
  });
});
