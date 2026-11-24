import { boundedDocumentContext } from '../shared/documentContext';
import type { EffectiveRule } from '../shared/types';
import { isReadableRegion } from './scanner';

const LANDMARK = 'article, main, nav, aside, [role="main"], [role="navigation"]';

function scopeOf(el: HTMLElement): ParentNode {
  return el.closest(LANDMARK) ?? el.getRootNode() as ParentNode;
}

/** Snapshot heading order for one round of work. Each article (or shadow root)
 * has its own outline, so menus and adjacent articles do not supply the label. */
export function pageContextReader(rule: EffectiveRule | null, originalText: (heading: HTMLElement) => string) {
  const outlines = new Map<ParentNode, HTMLElement[]>();
  return (el: HTMLElement) => {
    const scope = scopeOf(el);
    let headings = outlines.get(scope);
    if (!headings) {
      headings = Array.from(scope.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
        .filter((heading) => scopeOf(heading) === scope && isReadableRegion(heading, rule));
      outlines.set(scope, headings);
    }
    // Upper bound of the current element in document order.
    let start = 0;
    let end = headings.length;
    while (start < end) {
      const middle = (start + end) >>> 1;
      const heading = headings[middle];
      if (heading === el || (heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) start = middle + 1;
      else end = middle;
    }
    const preceding = headings[start - 1];
    return boundedDocumentContext({
      title: el.ownerDocument.title,
      section: preceding ? originalText(preceding) : undefined,
    });
  };
}
