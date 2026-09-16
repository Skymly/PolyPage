/**
 * Page scanning: find translatable block elements (spec §7.3).
 *
 * 2.0 evolution (spec 2.0 §6.1/§6.4):
 *  - recursion into open shadow roots (closed roots are a known limit);
 *  - site-rule include/exclude selector filtering;
 *  - candidate discovery helpers are shadow-DOM aware.
 *
 * 4.0: `<nav>` / `[role=navigation]` labels are scanned (Wikipedia sidebar
 * and TOC). Short menu text uses NAV_MIN_TEXT_LENGTH so items like "Tools"
 * are not dropped. Inserted nav suffixes are ignored when reading source text.
 *
 * Rules:
 *  - candidate tags: p, h1-h6, li, blockquote, figcaption, td, th,
 *    article, section, div, li (div/article/section/li only when they hold no
 *    translatable descendant — the most specific element wins);
 *  - skip tags and their subtrees: script, style, code, pre, form controls,
 *    media, etc. (buttons stay skipped so interactive chrome is not rewritten);
 *  - contenteditable regions are skipped to avoid breaking editors;
 *  - text filters: too short / digits / URLs / emails / code (shared module);
 *  - hidden nodes are not translated (spec §7.3 rule 8).
 */
import {
  BILINGUAL_CLASS,
  CANDIDATE_SELECTOR,
  INLINE_DST_CLASS,
  INLINE_SRC_CLASS,
  NAV_CHROME_SELECTOR,
  NAV_MIN_TEXT_LENGTH,
  NAV_TRANSLATION_CLASS,
  SKIP_MATH_CLASSES,
  SKIP_TAGS,
} from '../shared/constants';
import { filterText } from '../shared/textFilters';
import type { EffectiveRule } from '../shared/types';

export function isHidden(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === 'function') {
    try {
      return !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } catch {
      // fall through to manual checks
    }
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  const style = getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden';
}

/** Parent hop that crosses shadow boundaries (element -> host). */
function climb(node: Node): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  if (root instanceof ShadowRoot) return root.host;
  return null;
}

function isSkippedSubtreeRoot(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (el.classList?.contains(BILINGUAL_CLASS)) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (SKIP_MATH_CLASSES.has(el.tagName.toLowerCase())) return true;
  for (const cls of SKIP_MATH_CLASSES) {
    if (el.classList?.contains(cls)) return true;
  }
  return false;
}

function insideSkippedSubtree(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (isSkippedSubtreeRoot(node)) return true;
    node = climb(node);
  }
  return false;
}

/** Query a selector across the root and all open shadow roots beneath it. */
export function deepQuerySelectorAll(root: ParentNode, selector: string): Element[] {
  const out: Element[] = [];
  const visit = (r: ParentNode): void => {
    let found: Element[] = [];
    try {
      found = Array.from(r.querySelectorAll(selector));
    } catch {
      return; // invalid selector — treat as no match
    }
    out.push(...found);
    let all: Element[] = [];
    try {
      all = Array.from(r.querySelectorAll('*'));
    } catch {
      return;
    }
    for (const el of all) {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) visit(shadow);
    }
  };
  visit(root);
  return out;
}

/** True when el itself or any ancestor (crossing shadow boundaries) matches. */
export function elementMatchesWithin(el: Element, selector: string): boolean {
  let node: Element | null = el;
  while (node) {
    try {
      if (node.matches(selector)) return true;
    } catch {
      return false; // invalid selector — ignore rule safely
    }
    node = climb(node);
  }
  return false;
}

/** Site chrome whose labels should stay clickable (sidebar / TOC / menu). */
export function isMenuChrome(el: Element): boolean {
  return elementMatchesWithin(el, NAV_CHROME_SELECTOR);
}

/**
 * Subtrees whose text is ours, not the page original (nav suffix, bilingual
 * block, inline destination). `wt-inline-src` is *not* included: it wraps
 * the original text nodes and must still be read.
 */
export function isTranslationTextChrome(el: Element): boolean {
  return (
    el.classList.contains(NAV_TRANSLATION_CLASS) ||
    el.classList.contains(BILINGUAL_CLASS) ||
    el.classList.contains(INLINE_DST_CLASS)
  );
}

/**
 * Nodes we inserted into the page. Shared by `sourceTextOf` (text chrome) and
 * the content-script `isOwnNode` filter (also the inline source wrapper).
 */
export function isInsertedOwnElement(el: Element): boolean {
  return isTranslationTextChrome(el) || el.classList.contains(INLINE_SRC_CLASS);
}

/** Original label text, ignoring inserted translation chrome and skip-tag subtrees. */
export function sourceTextOf(el: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node instanceof Element) {
      if (isTranslationTextChrome(node) || isSkippedSubtreeRoot(node)) return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(el);
  return parts.join('').trim();
}

/** A container (div/article/section...) is skipped when it has candidate
 *  descendants carrying their own text — those descendants are translated
 *  instead, which avoids duplicated or nested translations. */
function hasCandidateDescendantWithText(el: Element): boolean {
  const descendants = deepQuerySelectorAll(el, CANDIDATE_SELECTOR);
  for (const d of descendants) {
    if (sourceTextOf(d as HTMLElement).length > 0) return true;
  }
  return false;
}

const CONTAINER_TAGS = new Set(['DIV', 'ARTICLE', 'SECTION', 'LI']);

export interface ScanOptions {
  minTextLength: number;
  /** Effective site rule (spec 2.0 §6.4); null = no rule filtering. */
  rule?: EffectiveRule | null;
}

export function scanTranslatableNodes(root: ParentNode, minTextLength: number): HTMLElement[] {
  return scanTranslatableNodesWithRule(root, { minTextLength, rule: null });
}

export function scanTranslatableNodesWithRule(root: ParentNode, options: ScanOptions): HTMLElement[] {
  const found: HTMLElement[] = [];
  if (!(root instanceof Element) && !(root instanceof Document)) return found;
  const candidates = deepQuerySelectorAll(root as Element | Document, CANDIDATE_SELECTOR);
  const rule = options.rule ?? null;
  for (const node of candidates) {
    const el = node as HTMLElement;
    // Never translate our own inserted bilingual blocks.
    if (el.closest(`.${BILINGUAL_CLASS}`)) continue;
    if (insideSkippedSubtree(el)) continue;
    if (CONTAINER_TAGS.has(el.tagName) && hasCandidateDescendantWithText(el)) continue;
    if (rule) {
      if (rule.includeSelectors.length > 0) {
        const inside = rule.includeSelectors.some((s) => elementMatchesWithin(el, s));
        if (!inside) continue;
      }
      if (rule.excludeSelectors.some((s) => elementMatchesWithin(el, s))) continue;
    }
    if (isHidden(el)) continue;
    const text = sourceTextOf(el);
    const minLen = isMenuChrome(el) ? Math.min(options.minTextLength, NAV_MIN_TEXT_LENGTH) : options.minTextLength;
    if (filterText(text, minLen).skip) continue;
    found.push(el);
  }
  return found;
}
