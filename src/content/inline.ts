/**
 * Inline bilingual mode support (spec 2.0 §7.2).
 *
 * Candidates are split into text-node segments; each segment becomes one
 * translation task. Rendering wraps every original text node in
 * <span class="wt-inline-src"> and appends one <span class="wt-inline-dst">
 * per segment after its last node — original inline markup (a, strong, ...)
 * is preserved, and the whole structure is restorable through the entry's
 * saved originalNodes.
 */
import { INLINE_DST_CLASS, INLINE_SRC_CLASS } from '../shared/constants';

export interface InlineSegment {
  /** Translation task key (entryId:sN). */
  key: string;
  /** Concatenated original text of the segment. */
  text: string;
  /** Text nodes belonging to the segment, in document order. */
  nodes: Text[];
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'TABLE', 'TR', 'TD', 'TH',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'FIGCAPTION', 'BR',
]);

function nearestBlockAncestor(node: Node): Element | null {
  let el: Element | null = node.parentElement;
  while (el) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return null;
}


const SKIP_INLINE_SUBTREE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

/** Collect all text nodes under a root (manual descent; shadow-safe). */
function collectTextNodes(root: Node, out: Text[]): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(child as Text);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (SKIP_INLINE_SUBTREE.has(el.tagName)) continue;
      // Skip our own rendered spans on rescans.
      if (el.classList?.contains(INLINE_SRC_CLASS) || el.classList?.contains(INLINE_DST_CLASS)) continue;
      collectTextNodes(el, out);
    }
  }
}

/**
 * Collect inline segments under an element.
 * Consecutive text nodes sharing the same nearest block ancestor merge into
 * one segment (that keeps "adjacent short text nodes" as a single task,
 * spec 2.0 §7.2 item 3). Text nodes inside nested block elements form
 * their own segments.
 */
export function collectInlineSegments(root: HTMLElement, entryId: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const all: Text[] = [];
  collectTextNodes(root, all);
  const textNodes = all.filter((node) => {
    if ((node.nodeValue ?? '').trim() === '') return false;
    if (!node.parentElement) return false;
    const parent = node.parentElement;
    return !(parent.classList?.contains(INLINE_SRC_CLASS) || parent.classList?.contains(INLINE_DST_CLASS));
  });

  let current: { block: Element | null; text: string; nodes: Text[] } | null = null;
  for (const textNode of textNodes) {
    const block = nearestBlockAncestor(textNode);
    const text = (textNode.nodeValue ?? '').trim();
    if (current && current.block === block) {
      current.text += ' ' + text;
      current.nodes.push(textNode);
    } else {
      if (current) pushSegment(current);
      current = { block, text, nodes: [textNode] };
    }
  }
  if (current) pushSegment(current);

  function pushSegment(seg: { block: Element | null; text: string; nodes: Text[] }): void {
    segments.push({
      key: `${entryId}:s${segments.length + 1}`,
      text: seg.text.replace(/\s+/g, ' ').trim(),
      nodes: seg.nodes,
    });
  }

  return segments.filter((s) => s.text !== '');
}

export interface RenderedSegment {
  key: string;
  /** The translation span; update textContent as results stream in. */
  dstEl: HTMLElement;
}

/**
 * Render one segment: wrap each original text node in a source span
 * (preserving surrounding inline markup) and append a single destination
 * span after the segment's last node.
 */
export function renderInlineSegment(segment: InlineSegment, doc: Document = document): RenderedSegment {
  const spans: HTMLElement[] = [];
  for (const textNode of segment.nodes) {
    const src = doc.createElement('span');
    src.className = INLINE_SRC_CLASS;
    src.textContent = textNode.nodeValue;
    textNode.replaceWith(src);
    spans.push(src);
  }
  const dst = doc.createElement('span');
  dst.className = INLINE_DST_CLASS;
  dst.textContent = '…';
  spans[spans.length - 1].insertAdjacentElement('afterend', dst);
  return { key: segment.key, dstEl: dst };
}