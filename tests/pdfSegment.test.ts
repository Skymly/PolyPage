/**
 * PDF paragraph clustering tests (spec 3.0 §5.3, §12.1): line-gap paragraph
 * breaks, font-size heading breaks, hyphenation merge, page-number filter,
 * cross-page header/footer filter, two-column reorder, scanned detection.
 *
 * TextItems are synthesized with a pdf.js-like transform
 * [scaleX, skewY, skewX, scaleY, x, y] where y grows UPWARDS.
 */
import { describe, expect, it } from 'vitest';
import {
  clusterPage,
  clusterPageFromLines,
  clusterParagraphs,
  collectRepeatingLines,
  extractLines,
  isPageNumberLine,
} from '../src/viewer/pdf/segment';
import type { PdfLine, TextItemLike } from '../src/viewer/pdf/segment';

/** Build a text item at (x, yFromTop) with a font size. */
function item(str: string, x: number, yFromTop: number, fontSize = 10, width?: number): TextItemLike {
  return {
    str,
    transform: [fontSize, 0, 0, fontSize, x, 792 - yFromTop],
    width: width ?? str.length * fontSize * 0.5,
  };
}

describe('extractLines', () => {
  it('groups items on the same visual line', () => {
    const lines = extractLines([
      item('Hello', 50, 100),
      item('world', 110, 100.5),
      item('Second line', 50, 120),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('Hello world');
    expect(lines[1].text).toBe('Second line');
  });

  it('splits wide gaps into separate segments', () => {
    const lines = extractLines([
      item('left', 50, 100, 10, 30),
      item('right', 400, 100),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(['left', 'right']);
  });
});

describe('clusterParagraphs', () => {
  function line(text: string, y: number, fontSize = 10, gapBefore?: number): PdfLine {
    return { y, gapBefore: gapBefore ?? 12, indent: 50, fontSize, text };
  }

  it('breaks paragraphs on large line gaps (行距换段)', () => {
    const paras = clusterParagraphs([
      line('First paragraph line one', 100),
      line('first paragraph line two', 112),
      line('Second paragraph starts here', 160, 10, 48), // big gap
    ]);
    expect(paras).toHaveLength(2);
    expect(paras[0].text).toContain('line two');
    expect(paras[1].text).toContain('Second paragraph');
  });

  it('breaks paragraphs on heading font-size change (字号换段)', () => {
    const paras = clusterParagraphs([
      line('Chapter title', 100, 18, 0),
      line('Body text follows the heading.', 130, 10, 22),
    ]);
    expect(paras).toHaveLength(2);
    expect(paras[0].text).toBe('Chapter title');
  });

  it('merges hyphenated line breaks (连字符合并)', () => {
    const paras = clusterParagraphs([
      line('The trans-', 100),
      line('lation pipeline is fast', 112),
    ]);
    expect(paras).toHaveLength(1);
    expect(paras[0].text).toBe('The translation pipeline is fast');
  });

  it('keeps hyphen when next line starts uppercase', () => {
    const paras = clusterParagraphs([
      line('Use T-', 100),
      line('SQL for the database', 112),
    ]);
    expect(paras[0].text).toBe('Use T- SQL for the database');
  });

  it('joins CJK lines without spaces', () => {
    const paras = clusterParagraphs([
      line('开源软件改变了', 100),
      line('世界。', 112),
    ]);
    expect(paras[0].text).toBe('开源软件改变了世界。');
  });
});

describe('page number filtering (页码过滤)', () => {
  it('detects plain numeric and roman page numbers', () => {
    expect(isPageNumberLine('12')).toBe(true);
    expect(isPageNumberLine('iv')).toBe(true);
    expect(isPageNumberLine('Page 12')).toBe(true);
    expect(isPageNumberLine('第 3 页')).toBe(true);
    expect(isPageNumberLine('12345678')).toBe(false);
    expect(isPageNumberLine('The year 2020')).toBe(false);
  });

  it('drops standalone page numbers from clustering', () => {
    const items = [
      item('A real paragraph with enough text to matter.', 50, 100),
      item('42', 300, 700),
    ];
    const { paragraphs } = clusterPage(items);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].text).toContain('real paragraph');
  });
});

describe('header/footer filtering (页眉页脚过滤)', () => {
  it('collects lines repeating across page edges', () => {
    const pages: PdfLine[][] = [0, 1, 2, 3, 4].map((i) => [
      { y: 10, gapBefore: 0, indent: 50, fontSize: 9, text: 'ACME Conference 2026' },
      { y: 100, gapBefore: 90, indent: 50, fontSize: 10, text: `Body text on page ${i + 1} with enough content.` },
      { y: 700, gapBefore: 590, indent: 50, fontSize: 9, text: 'ACME Conference 2026' },
    ]);
    const repeating = collectRepeatingLines(pages);
    expect(repeating.has('acme conference 2026')).toBe(true);
  });

  it('drops repeating header/footer lines when clustering', () => {
    const hf = new Set(['acme conference 2026']);
    const items = [
      item('ACME Conference 2026', 50, 30, 9),
      item('The real content paragraph lives here.', 50, 120),
    ];
    const withFilter = clusterPage(items, { skipHeadersFooters: true, headerFooterSet: hf });
    const without = clusterPage(items, { skipHeadersFooters: false, headerFooterSet: hf });
    expect(withFilter.paragraphs.map((p) => p.text)).toEqual(['The real content paragraph lives here.']);
    expect(without.paragraphs).toHaveLength(2);
  });

  it('can be disabled globally (pdfViewer.skipHeadersFooters=false)', () => {
    const lines: PdfLine[] = [
      { y: 0, gapBefore: 0, indent: 0, fontSize: 9, text: 'HEADER' },
      { y: 1, gapBefore: 12, indent: 0, fontSize: 10, text: 'body' },
    ];
    const hf = new Set(['header']);
    const kept = clusterPageFromLines(lines, { skipHeadersFooters: false, headerFooterSet: hf });
    expect(kept.paragraphs.some((p) => p.text.includes('HEADER'))).toBe(true);
  });
});

describe('two-column layouts', () => {
  it('reads left column fully before right column', () => {
    const items: TextItemLike[] = [];
    for (let row = 0; row < 4; row++) {
      items.push(item(`L${row}`, 50, 100 + row * 14, 10, 30));
      items.push(item(`R${row}`, 400, 100 + row * 14, 10, 30));
    }
    const lines = extractLines(items);
    const texts = lines.map((l) => l.text);
    expect(texts).toEqual(['L0', 'L1', 'L2', 'L3', 'R0', 'R1', 'R2', 'R3']);
    // Column jump forces a paragraph break.
    const paras = clusterParagraphs(lines);
    expect(paras).toHaveLength(2);
    expect(paras[0].text).toContain('L0');
    expect(paras[1].text).toContain('R0');
  });
});

describe('scanned pages', () => {
  it('marks pages without any text items as scanned', () => {
    const result = clusterPage([]);
    expect(result.scanned).toBe(true);
    expect(result.paragraphs).toEqual([]);
  });

  it('marks whitespace-only pages as scanned', () => {
    const result = clusterPage([
      { str: '   ', transform: [10, 0, 0, 10, 50, 700] },
    ]);
    expect(result.scanned).toBe(true);
  });

  it('text pages are not scanned', () => {
    const result = clusterPage([item('Real text', 50, 100)]);
    expect(result.scanned).toBe(false);
  });
});