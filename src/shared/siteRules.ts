/**
 * Site rules: pure matching and merging logic (spec 2.0 §6.4).
 * DOM application lives in the content script; this module is unit-tested.
 */
import type { DisplayMode, EffectiveRule, GlossaryEntry, SiteRule } from './types';
import { DISPLAY_MODES } from './types';

/**
 * Match a hostname against a pattern.
 *  - "example.com"       exact match (case-insensitive)
 *  - "*.example.com"     any subdomain of example.com (not the bare domain)
 *  - "example.com" also matches "www.example.com"? No — keep exact semantics;
 *    rules should list both forms when needed.
 */
export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const host = hostname.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (host === '' || p === '') return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return suffix !== '' && host.endsWith(`.${suffix}`);
  }
  if (p.startsWith('*')) {
    // "*example.com" — rare, treat as suffix match without the dot requirement.
    return host.endsWith(p.slice(1));
  }
  return host === p;
}

/** Specificity score: exact domain > wildcard. Higher wins. */
function patternSpecificity(pattern: string): number {
  const p = pattern.trim().toLowerCase();
  if (p.startsWith('*')) return 1;
  return 2;
}

/**
 * Return rules matching the hostname, enabled only, sorted by specificity
 * (most specific first). A rule's score is the max specificity of its
 * matching patterns.
 */
export function matchRulesForHost(hostname: string, rules: SiteRule[]): SiteRule[] {
  const scored: { rule: SiteRule; score: number }[] = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (!Array.isArray(rule.match)) continue;
    let score = 0;
    for (const pattern of rule.match) {
      if (typeof pattern !== 'string') continue;
      if (hostMatchesPattern(hostname, pattern)) {
        score = Math.max(score, patternSpecificity(pattern));
      }
    }
    if (score > 0) scored.push({ rule, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.rule);
}

function normalizeMode(value: unknown): DisplayMode | null {
  return DISPLAY_MODES.includes(value as DisplayMode) ? (value as DisplayMode) : null;
}

/**
 * Merge matched rules (most specific first) into one effective rule.
 * Explicit values win over absent ones; among equals, the more specific
 * rule wins (spec: 显式 > 默认).
 */
export function mergeEffectiveRules(matched: SiteRule[]): EffectiveRule {
  const effective: EffectiveRule = {
    includeSelectors: [],
    excludeSelectors: [],
    minTextLength: null,
    defaultMode: null,
    viewportOnly: false,
  };
  // Walk least specific first so more specific rules overwrite.
  for (let i = matched.length - 1; i >= 0; i--) {
    const rule = matched[i];
    if (Array.isArray(rule.includeSelectors) && rule.includeSelectors.length > 0) {
      effective.includeSelectors = rule.includeSelectors.filter((s) => typeof s === 'string' && s.trim() !== '');
    }
    if (Array.isArray(rule.excludeSelectors) && rule.excludeSelectors.length > 0) {
      effective.excludeSelectors = rule.excludeSelectors.filter((s) => typeof s === 'string' && s.trim() !== '');
    }
    if (typeof rule.minTextLength === 'number' && Number.isFinite(rule.minTextLength)) {
      effective.minTextLength = Math.round(rule.minTextLength);
    }
    const mode = normalizeMode(rule.defaultMode);
    if (mode) effective.defaultMode = mode;
    if (rule.viewportOnly === true) effective.viewportOnly = true;
  }
  return effective;
}

/**
 * Render the glossary for prompt injection (spec 2.0 §7.4):
 * one "source = target" line per entry. Empty glossary renders empty string.
 */
export function renderGlossary(entries: GlossaryEntry[]): string {
  const lines = entries
    .filter((e) => e.source.trim() !== '' && e.target.trim() !== '')
    .map((e) => {
      const note = e.note && e.note.trim() !== '' ? ` (${e.note.trim()})` : '';
      return `${e.source.trim()} = ${e.target.trim()}${note}`;
    });
  if (lines.length === 0) return '';
  return `Glossary — always use these translations:\n${lines.join('\n')}`;
}

/** Validate/normalize a raw site rule object (from editor or import). */
export function normalizeSiteRule(raw: unknown, fallbackId: string): SiteRule | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Partial<SiteRule>;
  const match = Array.isArray(r.match)
    ? r.match
        .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
        .map((m) => m.trim())
    : [];
  if (match.length === 0) return null;
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : undefined;
  const rule: SiteRule = {
    id: typeof r.id === 'string' && r.id.trim() !== '' ? r.id : fallbackId,
    match,
    enabled: r.enabled !== false,
  };
  const inc = strArray(r.includeSelectors);
  if (inc && inc.length > 0) rule.includeSelectors = inc;
  const exc = strArray(r.excludeSelectors);
  if (exc && exc.length > 0) rule.excludeSelectors = exc;
  if (typeof r.minTextLength === 'number' && Number.isFinite(r.minTextLength)) {
    rule.minTextLength = Math.max(1, Math.round(r.minTextLength));
  }
  const mode = normalizeMode(r.defaultMode);
  if (mode) rule.defaultMode = mode;
  if (r.viewportOnly === true) rule.viewportOnly = true;
  return rule;
}