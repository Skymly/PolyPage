/**
 * PDF text extraction post-processing: rebuild paragraphs from pdf.js
 * textItems using line-gap / font-size / indent heuristics (spec 3.0 §5.3).
 * Pure functions — unit-tested in tests/pdfSegment.test.ts.
 *
 * Pipeline: items -> visual lines -> column reordering -> paragraphs, with
 * hyphenation merge, page-number filtering and cross-page header/footer
 * filtering. Two-column handling is a P0 heuristic (spec 3.0 §13); perfect
 * layout reconstruction is explicitly out of scope.
 */

/** Minimal structural view of a pdf.js TextItem. */
export interface TextItemLike {
  str: string;
  /** pdf.js transform matrix; [3] approximates the font height. */
  transform: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

export interface PdfLine {
  /** Visual Y in top-down coordinates (smaller = higher on the page). */
  y: number;
  /** Vertical gap to the previous line in READING order (0 for the first;
   *  Infinity at a column jump back to the top). */
  gapBefore: number;
  /** Left indent in text-space units. */
  indent: number;
  fontSize: number;
  text: string;
}

export interface PdfParagraph {
  text: string;
  fontSize: number;
}

export interface PageClusterResult {
  paragraphs: PdfParagraph[];
  /** True when the page has no usable text layer (spec 3.0 §5.3 item 4). */
  scanned: boolean;
}

export interface ClusterOptions {
  /** Line-gap multiplier that starts a new paragraph (default 1.6). */
  paragraphGapFactor?: number;
  /** Font-size change ratio that starts a new paragraph (default 0.15). */
  fontSizeChangeRatio?: number;
  /** Split a line when the item gap exceeds this many font sizes. */
  columnGapFactor?: number;
  /** Minimum two-segment run length before column-major reorder (default 3). */
  minColumnRun?: number;
  /** 4.2: break a paragraph when two same-row cells sit at different x. */
  cellBreak?: boolean;
}

export type PdfLayoutPreset = 'auto' | 'single' | 'columns' | 'table';

/** 4.1 P2: tunable clustering presets. */
export function clusterOptionsForPreset(preset: PdfLayoutPreset | undefined): ClusterOptions {
  switch (preset) {
    case 'single':
      return { columnGapFactor: 80, minColumnRun: 99, paragraphGapFactor: 1.6 };
    case 'columns':
      return { columnGapFactor: 2.4, minColumnRun: 2, paragraphGapFactor: 1.6 };
    case 'table':
      return { columnGapFactor: 1.8, minColumnRun: 99, paragraphGapFactor: 1.15, fontSizeChangeRatio: 0.1, cellBreak: true };
    default:
      return { columnGapFactor: 4, minColumnRun: 3, paragraphGapFactor: 1.6 };
  }
}

const CJK = /[\u3000-\u303f\u3040-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function fontSizeOf(item: TextItemLike): number {
  const h = Math.abs(item.transform?.[3] ?? 0);
  if (h > 0) return h;
  if (item.height && item.height > 0) return item.height;
  return 10;
}

/** True when a line is a standalone page number (digits/roman, short). */
export function isPageNumberLine(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 8) return false;
  if (/^\d{1,4}$/.test(t)) return true;
  if (/^[ivxlcdm]+$/.test(t) && t.length <= 7) return true;
  if (/^(page|p\.?)\s*\d{1,4}$/i.test(t)) return true;
  if (/^第\s*\d{1,4}\s*页$/.test(t)) return true;
  return false;
}

interface Segment {
  y: number;
  x0: number;
  fontSize: number;
  text: string;
}

/**
 * Group text items into visual lines and split them into segments. Items are
 * sorted top-down then left-to-right; same-line items sit within
 * 0.35 * font-size on the Y axis; gaps wider than columnGapFactor *
 * font-size start a new segment (columns).
 */
export function extractSegments(items: TextItemLike[], opts: ClusterOptions = {}): Segment[] {
  const columnGapFactor = opts.columnGapFactor ?? 4;
  const usable = items.filter((i) => typeof i.str === 'string' && i.str.trim() !== '');
  if (usable.length === 0) return [];

  interface Placed {
    x: number;
    y: number;
    fontSize: number;
    str: string;
    width: number;
  }
  const placed: Placed[] = usable.map((item) => ({
    x: item.transform?.[4] ?? 0,
    // PDF Y grows upwards; invert so smaller = higher on the page.
    y: -(item.transform?.[5] ?? 0),
    fontSize: fontSizeOf(item),
    str: item.str,
    width: item.width ?? 0,
  }));
  placed.sort((a, b) => a.y - b.y || a.x - b.x);

  interface LineGroup {
    y: number;
    fontSize: number;
    items: Placed[];
  }
  const groups: LineGroup[] = [];
  for (const p of placed) {
    const last = groups[groups.length - 1];
    const tol = Math.max(last?.fontSize ?? p.fontSize, p.fontSize) * 0.35;
    if (last && Math.abs(p.y - last.y) <= tol) {
      last.items.push(p);
      last.fontSize = Math.max(last.fontSize, p.fontSize);
    } else {
      groups.push({ y: p.y, fontSize: p.fontSize, items: [p] });
    }
  }

  const segments: Segment[] = [];
  for (const group of groups) {
    group.items.sort((a, b) => a.x - b.x);
    let text = '';
    let x0 = group.items[0]?.x ?? 0;
    let prevEnd = Number.NaN;
    let prevSize = group.fontSize;
    const push = (): void => {
      if (text.trim() !== '') {
        segments.push({ y: group.y, x0, fontSize: group.fontSize, text: text.trim() });
      }
    };
    for (const item of group.items) {
      if (text !== '' && Number.isFinite(prevEnd)) {
        const gap = item.x - prevEnd;
        if (gap > columnGapFactor * Math.max(prevSize, item.fontSize)) {
          push();
          text = '';
          x0 = item.x;
        } else if (gap > 0.25 * prevSize) {
          text += ' ';
        }
      }
      text += item.str;
      prevEnd = item.x + item.width;
      prevSize = item.fontSize;
    }
    push();
  }
  return segments;
}

/**
 * Reorder segments into reading order. Runs of >= 3 consecutive visual lines
 * that each split into exactly two segments at a consistent X are treated as
 * two columns and emitted column-major (left column fully, then right).
 */
export function reorderColumns(segments: Segment[], opts: ClusterOptions = {}): Segment[] {
  const byLine = new Map<number, Segment[]>();
  for (const seg of segments) {
    const list = byLine.get(seg.y) ?? [];
    list.push(seg);
    byLine.set(seg.y, list);
  }
  const lineYs = [...byLine.keys()].sort((a, b) => a - b);
  const out: Segment[] = [];

  let i = 0;
  while (i < lineYs.length) {
    let j = i;
    while (j < lineYs.length && (byLine.get(lineYs[j]) ?? []).length === 2) j++;
    const runLen = j - i;
    let emitted = false;
    const minRun = opts.minColumnRun ?? 3;
    if (runLen >= minRun) {
      const run = lineYs.slice(i, j);
      const rights = run.map((y) => (byLine.get(y) ?? [])[1]);
      const rightX = rights[0]?.x0 ?? 0;
      const consistent = rights.every(
        (r) => Math.abs(r.x0 - rightX) <= 2 * Math.max(r.fontSize, 1),
      );
      if (consistent) {
        for (const y of run) out.push((byLine.get(y) ?? [])[0]);
        for (const y of run) out.push((byLine.get(y) ?? [])[1]);
        emitted = true;
      }
    }
    if (!emitted) {
      const end = j === i ? i + 1 : j;
      for (const y of lineYs.slice(i, end)) out.push(...(byLine.get(y) ?? []));
      j = end;
    }
    i = j;
  }
  return out;
}

/**
 * Group text items into reading-order lines with gap metadata. The
 * `gapBefore` of each line is the vertical distance to the previous line in
 * reading order; column jumps (right column restarts at the top) yield
 * Infinity so clustering always starts a new paragraph there.
 */
export function extractLines(items: TextItemLike[], opts: ClusterOptions = {}): PdfLine[] {
  const ordered = reorderColumns(extractSegments(items, opts), opts);
  const lines: PdfLine[] = [];
  let prevY = Number.NaN;
  for (const seg of ordered) {
    let gapBefore: number;
    if (Number.isNaN(prevY)) gapBefore = 0;
    else if (seg.y < prevY - 0.5) gapBefore = Number.POSITIVE_INFINITY; // column jump
    else gapBefore = seg.y - prevY;
    lines.push({
      y: seg.y,
      gapBefore,
      indent: seg.x0,
      fontSize: seg.fontSize,
      text: seg.text,
    });
    prevY = seg.y;
  }
  return lines.filter((l) => l.text.length > 0);
}

/**
 * Cluster lines into paragraphs (spec 3.0 §5.3 item 2). New paragraph when:
 *  - vertical gap exceeds paragraphGapFactor * recent line height;
 *  - font size changes beyond fontSizeChangeRatio (headings);
 *  - an indented first line starts after unindented body lines.
 */
export function clusterParagraphs(lines: PdfLine[], opts: ClusterOptions = {}): PdfParagraph[] {
  const gapFactor = opts.paragraphGapFactor ?? 1.6;
  const sizeRatio = opts.fontSizeChangeRatio ?? 0.15;
  const paragraphs: PdfParagraph[] = [];
  let buffer: PdfLine[] = [];
  let prev: PdfLine | null = null;

  const flush = (): void => {
    if (buffer.length === 0) return;
    paragraphs.push({
      text: joinLines(buffer),
      fontSize: buffer[0].fontSize,
    });
    buffer = [];
  };

  for (const line of lines) {
    if (prev) {
      const lineHeight = Math.max(prev.fontSize, 1);
      const gapBreak =
        Number.isFinite(line.gapBefore) && line.gapBefore > lineHeight * gapFactor;
      const columnJump = !Number.isFinite(line.gapBefore);
      const sizeChanged =
        Math.abs(line.fontSize - prev.fontSize) / Math.max(prev.fontSize, 1) > sizeRatio;
      const indentStarted =
        buffer.length >= 2 &&
        line.indent - buffer[0].indent > 1.5 * lineHeight &&
        Math.abs(line.fontSize - prev.fontSize) < 1e-6;
      const cellBreak =
        opts.cellBreak === true &&
        Math.abs(line.y - prev.y) <= 0.5 &&
        Math.abs(line.indent - prev.indent) > 2 * lineHeight;
      if (gapBreak || columnJump || sizeChanged || indentStarted || cellBreak) {
        flush();
      }
    }
    buffer.push(line);
    prev = line;
  }
  flush();
  return paragraphs.filter((p) => p.text.trim().length > 0);
}

/** Join lines with hyphenation merge and CJK-aware spacing. */
export function joinLines(lines: PdfLine[]): string {
  let out = '';
  for (const line of lines) {
    const text = line.text;
    if (out === '') {
      out = text;
      continue;
    }
    if (out.endsWith('-') && /^[a-z]/.test(text)) {
      out = out.slice(0, -1) + text; // hyphenation merge
    } else if (CJK.test(out[out.length - 1] ?? '') || CJK.test(text[0] ?? '')) {
      out += text; // no spaces inside CJK runs
    } else {
      out += ` ${text}`;
    }
  }
  return out;
}

function normalizeForRepeat(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Cluster from pre-extracted lines (shared by clusterPage and the viewer,
 *  which extracts once to feed collectRepeatingLines). */
export function clusterPageFromLines(
  lines: PdfLine[],
  options: { skipHeadersFooters?: boolean; headerFooterSet?: Set<string>; cluster?: ClusterOptions } = {},
): PageClusterResult {
  const skip = options.skipHeadersFooters ?? true;
  const hf = options.headerFooterSet;
  const filtered = lines.filter((line) => {
    if (isPageNumberLine(line.text)) return false;
    if (skip && hf && hf.has(normalizeForRepeat(line.text))) return false;
    return true;
  });
  const paragraphs = clusterParagraphs(filtered, options.cluster);
  const scanned = lines.length === 0;
  return { paragraphs, scanned };
}

/**
 * Cluster one page. `headerFooterSet` holds repeating short lines collected
 * across pages (see collectRepeatingLines); they are dropped here.
 */
export function clusterPage(
  items: TextItemLike[],
  options: { skipHeadersFooters?: boolean; headerFooterSet?: Set<string>; cluster?: ClusterOptions } = {},
): PageClusterResult {
  return clusterPageFromLines(extractLines(items, options.cluster), options);
}

/**
 * Collect short lines repeating near page edges across many pages — the
 * header/footer signature (spec 3.0 §5.3 item 3). A line qualifies when it
 * appears on at least max(3, 40%) of pages and is at most 60 chars long.
 */
export function collectRepeatingLines(pages: PdfLine[][]): Set<string> {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    if (lines.length === 0) continue;
    const edge = Math.min(2, lines.length);
    const candidates = [...lines.slice(0, edge), ...lines.slice(-edge)];
    const seen = new Set<string>();
    for (const line of candidates) {
      const t = line.text.trim();
      if (t.length === 0 || t.length > 60) continue;
      const norm = normalizeForRepeat(t);
      if (seen.has(norm)) continue;
      seen.add(norm);
      counts.set(norm, (counts.get(norm) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.4));
  const out = new Set<string>();
  for (const [norm, n] of counts) {
    if (n >= threshold) out.add(norm);
  }
  return out;
}