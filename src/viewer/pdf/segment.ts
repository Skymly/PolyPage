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
  right?: number;
  tableRow?: boolean;
  fontSize: number;
  text: string;
}

export interface PdfParagraph {
  text: string;
  fontSize: number;
  /** Bounding box in PDF user-space units, relative to the original page. */
  bounds: [number, number, number, number];
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

/** US Letter height used by tests and as fallback when the viewer omits viewport height. */
export const DEFAULT_PDF_PAGE_HEIGHT = 792;

/** Drop page-number-like lines only in the top/bottom band (M-37). */
export const PAGE_NUMBER_EDGE_RATIO = 0.08;

/**
 * `y` is the inverted text-item coordinate (smaller = higher on the page).
 * Top ≈ -pageHeight, bottom ≈ 0.
 */
export function isNearPageEdge(
  y: number,
  pageHeight: number,
  ratio = PAGE_NUMBER_EDGE_RATIO,
): boolean {
  if (!(pageHeight > 0) || !Number.isFinite(y)) return false;
  const band = pageHeight * ratio;
  return y <= -pageHeight + band || y >= -band;
}

interface Segment {
  y: number;
  x0: number;
  x1: number;
  fontSize: number;
  text: string;
  column?: 'left' | 'right';
  tableRow?: boolean;
}

/** A persistent gutter in a paper remains empty even when the two columns
 * have different line heights. Look at original PDF glyph runs before
 * grouping them into visual rows, which would erase a narrow gutter. */
function paperGutter(items: TextItemLike[], options: ClusterOptions): number | undefined {
  if ((options.columnGapFactor ?? 4) > 20) return;
  const runs = items.filter((i) => i.str?.trim() && (i.width ?? 0) > 0);
  if (runs.length < 8) return;
  let left = Infinity, right = -Infinity;
  for (const r of runs) { left = Math.min(left, r.transform[4]); right = Math.max(right, r.transform[4] + r.width!); }
  const width = right - left;
  if (width < 120) return;
  const center = (left + right) / 2;
  let best: { x: number; score: number } | undefined;
  for (let step = -10; step <= 10; step++) {
    const x = center + width * step / 100;
    const crossing = new Set<number>();
    const leftRows = new Set<number>(), rightRows = new Set<number>();
    for (const r of runs) {
      const x0 = r.transform[4], x1 = x0 + r.width!, y = Math.round(r.transform[5]);
      if (x0 < x + 2 && x1 > x - 2) crossing.add(y);
      // Full prose lines distinguish a gutter from gaps between narrow table cells.
      else if (r.width! >= width * 0.16 && /[\p{L}]{2}/u.test(r.str)) {
        (x1 < x ? leftRows : rightRows).add(y);
      }
    }
    const evidence = Math.min(leftRows.size, rightRows.size);
    if (evidence < 4 || crossing.size > Math.max(4, evidence * 0.28)) continue;
    const score = crossing.size + Math.abs(step) / 32;
    if (!best || score < best.score) best = { x, score };
  }
  return best?.x;
}

function paperSegments(items: TextItemLike[], gutter: number, opts: ClusterOptions): Segment[] {
  const runs = items.filter((i) => i.str?.trim()).sort((a, b) => b.transform[5] - a.transform[5]);
  const out: Segment[] = [];
  let left: TextItemLike[] = [], right: TextItemLike[] = [];
  const flush = (): void => {
    for (const s of extractSegments(left, opts)) out.push({ ...s, column: 'left' });
    for (const s of extractSegments(right, opts)) out.push({ ...s, column: 'right' });
    left = []; right = [];
  };
  for (let i = 0; i < runs.length;) {
    let j = i + 1;
    const tol = Math.max(1, fontSizeOf(runs[i]) * 0.3);
    while (j < runs.length && runs[i].transform[5] - runs[j].transform[5] <= tol) j++;
    const row = runs.slice(i, j);
    if (row.some((r) => r.transform[4] < gutter && r.transform[4] + (r.width ?? 0) > gutter)) {
      flush();
      out.push(...extractSegments(row, opts));
    } else {
      for (const r of row) (r.transform[4] < gutter ? left : right).push(r);
    }
    i = j;
  }
  flush();
  return out;
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

  // Adjacent numeric columns in a table are often closer than the gutter
  // used for prose. Use their repeated centers to include the header row.
  const numericCenters = groups.map(({ items }) =>
    items.filter((p) => /^[-–—]$|^\d+(?:[.,]\d+)*%?$/.test(p.str.trim())).map((p) => p.x + p.width / 2));
  const segments: Segment[] = [];
  for (const [index, group] of groups.entries()) {
    group.items.sort((a, b) => a.x - b.x);
    const tableRow = group.items.length >= 3 && [index - 1, index + 1].some((neighbor) => {
      const centers = numericCenters[neighbor] ?? [];
      if (centers.length < 2 || Math.abs(groups[neighbor].y - group.y) > 2.4 * group.fontSize) return false;
      return group.items.filter((p) =>
        centers.some((x) => Math.abs(p.x + p.width / 2 - x) < group.fontSize)).length >= 2;
    });
    let text = '';
    let x0 = group.items[0]?.x ?? 0;
    let prevEnd = Number.NaN;
    let prevSize = group.fontSize;
    const push = (): void => {
      if (text.trim() !== '') {
        segments.push({ y: group.y, x0, x1: prevEnd, fontSize: group.fontSize, text: text.trim(), tableRow });
      }
    };
    for (const item of group.items) {
      if (text !== '' && Number.isFinite(prevEnd)) {
        const gap = item.x - prevEnd;
        if (gap > (tableRow ? Math.min(1.5, columnGapFactor) : columnGapFactor) * Math.max(prevSize, item.fontSize)) {
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
  const gutter = paperGutter(items, opts);
  const ordered = gutter === undefined ? reorderColumns(extractSegments(items, opts), opts) : paperSegments(items, gutter, opts);
  const rowSizes = new Map<string, number>();
  const rowKey = (s: Segment) => `${s.column ?? ''}:${s.y}`;
  for (const seg of ordered) rowSizes.set(rowKey(seg), (rowSizes.get(rowKey(seg)) ?? 0) + 1);
  const lines: PdfLine[] = [];
  let prevY = Number.NaN;
  let prevColumn: Segment['column'];
  for (const seg of ordered) {
    let gapBefore: number;
    if (Number.isNaN(prevY)) gapBefore = 0;
    else if (seg.y < prevY - 0.5 || prevColumn !== seg.column) gapBefore = Number.POSITIVE_INFINITY;
    else gapBefore = seg.y - prevY;
    lines.push({
      y: seg.y,
      gapBefore,
      indent: seg.x0,
      right: seg.x1,
      tableRow: seg.tableRow || (rowSizes.get(rowKey(seg)) ?? 0) >= (opts.cellBreak ? 2 : 3),
      fontSize: seg.fontSize,
      text: seg.text,
    });
    prevY = seg.y;
    prevColumn = seg.column;
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
      bounds: buffer.reduce<[number, number, number, number]>((box, line) => [
        Math.min(box[0], line.indent), Math.min(box[1], -line.y - line.fontSize * 0.22),
        Math.max(box[2], line.right ?? line.indent), Math.max(box[3], -line.y + line.fontSize),
      ], [Infinity, Infinity, -Infinity, -Infinity]),
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
      if (gapBreak || columnJump || sizeChanged || indentStarted || cellBreak || line.tableRow || prev.tableRow) {
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
  options: {
    skipHeadersFooters?: boolean;
    headerFooterSet?: Set<string>;
    cluster?: ClusterOptions;
    pageHeight?: number;
  } = {},
): PageClusterResult {
  const skip = options.skipHeadersFooters ?? true;
  const hf = options.headerFooterSet;
  const pageHeight = options.pageHeight ?? DEFAULT_PDF_PAGE_HEIGHT;
  const filtered = lines.filter((line) => {
    if (!line.tableRow && isPageNumberLine(line.text) && isNearPageEdge(line.y, pageHeight)) return false;
    if (skip && hf && isNearPageEdge(line.y, pageHeight) && hf.has(normalizeForRepeat(line.text))) return false;
    return true;
  });
  const paragraphs = clusterParagraphs(filtered, options.cluster);
  const scanned = filtered.length === 0;
  return { paragraphs, scanned };
}

/**
 * Cluster one page. `headerFooterSet` holds repeating short lines collected
 * across pages (see collectRepeatingLines); they are dropped here.
 */
export function clusterPage(
  items: TextItemLike[],
  options: {
    skipHeadersFooters?: boolean;
    headerFooterSet?: Set<string>;
    cluster?: ClusterOptions;
    pageHeight?: number;
  } = {},
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
