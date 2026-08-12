/**
 * Page scanning: find translatable block elements (spec §7.3).
 *
 * Rules:
 *  - candidate tags: p, h1-h6, li, blockquote, figcaption, td, th,
 *    article, section, div (div/article/section only when they hold no
 *    translatable descendant — the most specific element wins);
 *  - skip tags and their subtrees: script, style, code, pre, form controls,
 *    media, nav, etc.;
 *  - contenteditable regions are skipped to avoid breaking editors;
 *  - text filters: too short / digits / URLs / emails / code (shared module);
 *  - hidden nodes are not translated (spec §7.3 rule 8).
 */
import { BILINGUAL_CLASS, CANDIDATE_SELECTOR, SKIP_TAGS } from '../shared/constants';
import { filterText } from '../shared/textFilters';

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

function insideSkippedSubtree(el: Element, root: ParentNode): boolean {
  let node: Element | null = el;
  while (node && node !== root) {
    if (SKIP_TAGS.has(node.tagName)) return true;
    if (node instanceof HTMLElement && node.isContentEditable) return true;
    node = node.parentElement;
  }
  return false;
}

/** A container (div/article/section...) is skipped when it has candidate
 *  descendants carrying their own text — those descendants are translated
 *  instead, which avoids duplicated or nested translations. */
function hasCandidateDescendantWithText(el: Element): boolean {
  const descendants = el.querySelectorAll(CANDIDATE_SELECTOR);
  for (const d of descendants) {
    if ((d.textContent ?? '').trim().length > 0) return true;
  }
  return false;
}

const CONTAINER_TAGS = new Set(['DIV', 'ARTICLE', 'SECTION']);

export function scanTranslatableNodes(root: ParentNode, minTextLength: number): HTMLElement[] {
  const found: HTMLElement[] = [];
  if (!(root instanceof Element) && !(root instanceof Document)) return found;
  const candidates = (root as Element | Document).querySelectorAll(CANDIDATE_SELECTOR);
  for (const node of candidates) {
    const el = node as HTMLElement;
    // Never translate our own inserted bilingual blocks.
    if (el.closest(`.${BILINGUAL_CLASS}`)) continue;
    if (insideSkippedSubtree(el, root)) continue;
    if (CONTAINER_TAGS.has(el.tagName) && hasCandidateDescendantWithText(el)) continue;
    if (isHidden(el)) continue;
    const text = (el.textContent ?? '').trim();
    if (filterText(text, minTextLength).skip) continue;
    found.push(el);
  }
  return found;
}
