/**
 * Site rule application for the current page (spec 2.0 §6.4).
 * Wraps the pure matching logic from shared/siteRules with hostname access.
 */
import { matchRulesForHost, mergeEffectiveRules } from '../shared/siteRules';
import type { EffectiveRule, SiteRule } from '../shared/types';

/** Resolve the effective rule for a hostname (enabled rules only). */
export function effectiveRuleForHost(hostname: string, rules: SiteRule[]): EffectiveRule {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { includeSelectors: [], excludeSelectors: [], minTextLength: null, defaultMode: null, viewportOnly: false };
  }
  const matched = matchRulesForHost(hostname, rules);
  return mergeEffectiveRules(matched);
}

/**
 * Blacklist check (1.0 semantics, kept here for reuse by frames):
 * a frame that cannot read the top hostname (cross-origin) is not
 * blacklisted on its own — the top frame enforces the blacklist
 * (spec 2.0 §6.2 item 7).
 */
export function hostBlacklisted(hostname: string, blacklist: string[]): boolean {
  const host = hostname.toLowerCase();
  return blacklist.some((entry) => {
    const domain = entry.trim().toLowerCase();
    if (domain === '') return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** Best-effort top-level hostname for blacklist purposes inside frames. */
export function topLevelHostname(): string {
  try {
    if (window.top && window.top !== window.self) {
      return window.top.location.hostname;
    }
  } catch {
    return ''; // cross-origin top frame — unknown
  }
  return location.hostname;
}