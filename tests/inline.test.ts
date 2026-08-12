// @vitest-environment happy-dom
/**
 * Inline mode segment splitting/rendering tests (spec 2.0 §7.2, §12.1).
 * Runs under happy-dom because the logic operates on DOM text nodes.
 */
import { describe, expect, it } from 'vitest';
import { INLINE_DST_CLASS, INLINE_SRC_CLASS } from '../src/shared/constants';
import { allocateInlineBudget, collectInlineSegments, renderInlineSegment } from '../src/content/inline';

function makeContainer(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('collectInlineSegments', () => {
  it('creates one segment per paragraph with plain text', () => {
    const el = makeContainer('<p id="a">Hello world from the page.</p>');
    const p = el.querySelector('#a') as HTMLElement;
    const segments = collectInlineSegments(p, 'wt-1');
    expect(segments).toHaveLength(1);
    expect(segments[0].key).toBe('wt-1:s1');
    expect(segments[0].text).toBe('Hello world from the page.');
    expect(segments[0].nodes).toHaveLength(1);
  });

  it('merges adjacent inline-marked text nodes into one segment', () => {
    const el = makeContainer(
      '<p id="b">First part <strong>bold part</strong> <a href="#">link part</a> end.</p>',
    );
    const p = el.querySelector('#b') as HTMLElement;
    const segments = collectInlineSegments(p, 'wt-2');
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toContain('First part');
    expect(segments[0].text).toContain('bold part');
    expect(segments[0].text).toContain('link part');
    // Four text nodes: "First part ", "bold part", " ", "link part", " end."
    expect(segments[0].nodes.length).toBeGreaterThanOrEqual(4);
  });

  it('splits segments across nested block boundaries', () => {
    const el = makeContainer(
      '<div id="c">Outer text.<p>Inner paragraph text.</p></div>',
    );
    const div = el.querySelector('#c') as HTMLElement;
    const segments = collectInlineSegments(div, 'wt-3');
    expect(segments.length).toBe(2);
    const texts = segments.map((s) => s.text);
    expect(texts).toContain('Outer text.');
    expect(texts).toContain('Inner paragraph text.');
  });

  it('skips empty and script text', () => {
    const el = makeContainer('<p id="d">   <script>var x = 1;</script>Visible text here.</p>');
    const p = el.querySelector('#d') as HTMLElement;
    const segments = collectInlineSegments(p, 'wt-4');
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe('Visible text here.');
  });
});

describe('renderInlineSegment', () => {
  it('wraps text nodes in src spans and appends one dst span, preserving markup', () => {
    const el = makeContainer(
      '<p id="e">Start <strong>bold</strong> end.</p>',
    );
    const p = el.querySelector('#e') as HTMLElement;
    const segments = collectInlineSegments(p, 'wt-5');
    expect(segments).toHaveLength(1);
    renderInlineSegment(segments[0]);

    // Original inline markup preserved: <strong> still present.
    expect(p.querySelector('strong')).not.toBeNull();
    const srcSpans = p.querySelectorAll(`.${INLINE_SRC_CLASS}`);
    expect(srcSpans.length).toBeGreaterThanOrEqual(3);
    const dstSpans = p.querySelectorAll(`.${INLINE_DST_CLASS}`);
    expect(dstSpans).toHaveLength(1);
    // dst span sits after the last src span.
    const lastSrc = srcSpans[srcSpans.length - 1];
    expect(lastSrc.nextElementSibling?.className).toBe(INLINE_DST_CLASS);
  });

  it('is fully restorable by replacing children with saved originals', () => {
    const el = makeContainer('<p id="f">Some original content here.</p>');
    const p = el.querySelector('#f') as HTMLElement;
    const saved = Array.from(p.childNodes);
    const segments = collectInlineSegments(p, 'wt-6');
    renderInlineSegment(segments[0]);
    expect(p.querySelectorAll(`.${INLINE_SRC_CLASS}`).length).toBeGreaterThan(0);
    // Restore.
    p.replaceChildren(...saved);
    expect(p.textContent).toBe('Some original content here.');
    expect(p.querySelectorAll('span')).toHaveLength(0);
  });
});
describe('allocateInlineBudget (spec 2.0 §7.2 item 3)', () => {
  it('accepts everything when the budget is large enough', () => {
    const plan = allocateInlineBudget([1, 2, 3], 300);
    expect(plan.accepted).toEqual([true, true, true]);
    expect(plan.downgraded).toBe(false);
  });

  it('degrades the first entry that exceeds the remaining budget', () => {
    const plan = allocateInlineBudget([2, 5, 1], 6);
    expect(plan.accepted).toEqual([true, false, true]);
    expect(plan.downgraded).toBe(true);
  });

  it('later entries still fit after an earlier degrade', () => {
    const plan = allocateInlineBudget([10, 1], 5);
    expect(plan.accepted).toEqual([false, true]);
    expect(plan.downgraded).toBe(true);
  });

  it('treats zero-segment entries as degraded without the over-budget hint', () => {
    const plan = allocateInlineBudget([0, 1], 300);
    expect(plan.accepted).toEqual([false, true]);
    expect(plan.downgraded).toBe(false);
  });

  it('accepts an entry that exactly exhausts the budget', () => {
    const plan = allocateInlineBudget([3, 1], 3);
    expect(plan.accepted).toEqual([true, false]);
    expect(plan.downgraded).toBe(true);
  });
});