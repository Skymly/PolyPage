/**
 * Site rule application for the current page (spec 2.0 §6.4).
 * Wraps the pure matching logic from shared/siteRules with hostname access.
 */
import { matchRulesForHost, mergeEffectiveRules } from '../shared/siteRules';
export { hostnameFromUrl, resolveBlacklistHost } from '../shared/siteRules';
import type { EffectiveRule, SiteRule } from '../shared/types';

/** Resolve the effective rule for a hostname (enabled rules only). */
export function effectiveRuleForHost(hostname: string, rules: SiteRule[]): EffectiveRule {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { includeSelectors: [], excludeSelectors: [], minTextLength: null, defaultMode: null, viewportOnly: false, subtitleSelectors: [] };
  }
  const matched = matchRulesForHost(hostname, rules);
  return mergeEffectiveRules(matched);
}

/**
 * Blacklist check. Cross-origin iframes cannot read window.top; they
 * must use resolveBlacklistHost(topLevelHostname(), tabHostname) so an
 * empty top host still matches the tab URL (M-51).
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