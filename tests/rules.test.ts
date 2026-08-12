/**
 * Site rules matching/merging tests (spec 2.0 §6.4, §12.1).
 */
import { describe, expect, it } from 'vitest';
import {
  hostMatchesPattern,
  matchRulesForHost,
  mergeEffectiveRules,
  normalizeSiteRule,
  renderGlossary,
} from '../src/shared/siteRules';
import type { SiteRule } from '../src/shared/types';

describe('hostMatchesPattern', () => {
  it('matches exact domains case-insensitively', () => {
    expect(hostMatchesPattern('Example.com', 'example.com')).toBe(true);
    expect(hostMatchesPattern('example.com', 'other.com')).toBe(false);
  });
  it('matches wildcard subdomains but not the bare domain', () => {
    expect(hostMatchesPattern('a.example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('deep.a.example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('example.com', '*.example.com')).toBe(false);
  });
  it('rejects empty inputs', () => {
    expect(hostMatchesPattern('', 'example.com')).toBe(false);
    expect(hostMatchesPattern('example.com', '')).toBe(false);
  });
});

describe('matchRulesForHost', () => {
  const rules: SiteRule[] = [
    { id: 'wild', match: ['*.example.com'], minTextLength: 10, enabled: true },
    { id: 'exact', match: ['news.example.com'], defaultMode: 'inline', enabled: true },
    { id: 'disabled', match: ['news.example.com'], defaultMode: 'translated', enabled: false },
    { id: 'other', match: ['other.com'], enabled: true },
  ];

  it('returns only enabled matching rules, most specific first', () => {
    const matched = matchRulesForHost('news.example.com', rules);
    expect(matched.map((r) => r.id)).toEqual(['exact', 'wild']);
  });

  it('returns wildcard rule for subdomains without an exact rule', () => {
    const matched = matchRulesForHost('blog.example.com', rules);
    expect(matched.map((r) => r.id)).toEqual(['wild']);
  });

  it('returns nothing for unrelated hosts', () => {
    expect(matchRulesForHost('unrelated.org', rules)).toEqual([]);
  });
});

describe('mergeEffectiveRules', () => {
  it('lets the more specific rule win on conflicts', () => {
    const wild: SiteRule = {
      id: 'wild',
      match: ['*.example.com'],
      minTextLength: 10,
      defaultMode: 'bilingual',
      excludeSelectors: ['.ad'],
      enabled: true,
    };
    const exact: SiteRule = {
      id: 'exact',
      match: ['news.example.com'],
      defaultMode: 'inline',
      enabled: true,
    };
    // matchRulesForHost order: most specific first.
    const merged = mergeEffectiveRules([exact, wild]);
    expect(merged.defaultMode).toBe('inline');
    expect(merged.minTextLength).toBe(10);
    expect(merged.excludeSelectors).toEqual(['.ad']);
    expect(merged.includeSelectors).toEqual([]);
    expect(merged.viewportOnly).toBe(false);
  });

  it('explicit values win over absent ones regardless of order', () => {
    const a: SiteRule = { id: 'a', match: ['x.com'], viewportOnly: true, enabled: true };
    const b: SiteRule = { id: 'b', match: ['x.com'], minTextLength: 12, enabled: true };
    const merged = mergeEffectiveRules([a, b]);
    expect(merged.viewportOnly).toBe(true);
    expect(merged.minTextLength).toBe(12);
  });
});

describe('normalizeSiteRule', () => {
  it('rejects rules without match patterns', () => {
    expect(normalizeSiteRule({ id: 'x' }, 'fallback')).toBeNull();
    expect(normalizeSiteRule({ id: 'x', match: [] }, 'fallback')).toBeNull();
    expect(normalizeSiteRule(null, 'fallback')).toBeNull();
  });
  it('keeps valid fields and assigns fallback id', () => {
    const rule = normalizeSiteRule(
      {
        match: [' example.com ', ''],
        includeSelectors: ['article', '  '],
        minTextLength: 9.7,
        defaultMode: 'bilingual',
      },
      'fallback-id',
    );
    expect(rule).not.toBeNull();
    expect(rule!.id).toBe('fallback-id');
    expect(rule!.match).toEqual(['example.com']);
    expect(rule!.includeSelectors).toEqual(['article']);
    expect(rule!.minTextLength).toBe(10);
    expect(rule!.enabled).toBe(true);
  });
  it('drops invalid defaultMode values', () => {
    const rule = normalizeSiteRule({ match: ['x.com'], defaultMode: 'bogus' }, 'id');
    expect(rule!.defaultMode).toBeUndefined();
  });
});

describe('renderGlossary', () => {
  it('renders source = target lines with optional notes', () => {
    const text = renderGlossary([
      { source: 'container', target: '集装箱' },
      { source: 'bill of lading', target: '提单', note: '海运单据' },
      { source: '', target: 'ignored' },
    ]);
    expect(text).toContain('container = 集装箱');
    expect(text).toContain('bill of lading = 提单 (海运单据)');
    expect(text).not.toContain('ignored');
  });
  it('returns empty string for an empty glossary', () => {
    expect(renderGlossary([])).toBe('');
  });
});