import type { PdfDocumentLike, PdfOutlineEntry } from './loader';
import { clusterPageFromLines, collectRepeatingLines } from './segment';
import type { ClusterOptions, PdfLine } from './segment';

export interface ExtractedPage { lines: PdfLine[]; pageHeight: number }

export function sampleHeaders(count: number, load: (index: number) => Promise<ExtractedPage>) {
  const pages = new Map<number, Promise<ExtractedPage>>();
  for (let index = 1; index <= Math.min(3, count); index++) {
    pages.set(index, load(index).catch((err: unknown) => { pages.delete(index); throw err; }));
  }
  const signatures = Promise.allSettled(pages.values()).then((results) =>
    collectRepeatingLines(results.flatMap((r) => r.status === 'fulfilled' ? [r.value.lines] : [])));
  return { pages, signatures };
}

/** Resolve a bounded number of internal bookmarks, keeping document order on a shared page. */
export async function bookmarkSections(doc: PdfDocumentLike): Promise<Array<{ page: number; title: string }>> {
  const entries: PdfOutlineEntry[] = [];
  function visit(items: PdfOutlineEntry[]): void {
    for (const entry of items) {
      if (entries.length >= 256) return;
      entries.push(entry);
      if (entry.items) visit(entry.items);
    }
  }
  visit(await doc.getOutline() ?? []);
  const sections = await Promise.all(entries.map(async ({ dest, title }) => {
    if (!dest || !title.trim()) return [];
    try {
      const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      const ref = resolved?.[0];
      const index = typeof ref === 'number' ? ref : ref && typeof ref === 'object' && 'num' in ref && 'gen' in ref
        ? await doc.getPageIndex(ref as { num: number; gen: number }) : -1;
      if (!Number.isInteger(index) || index < 0 || index >= doc.numPages) return [];
      return [{ page: index + 1, title: title.trim().slice(0, 120) }];
    } catch { return []; }
  }));
  return sections.flat().sort((a, b) => a.page - b.page);
}

export function pageParagraphs(
  { lines, pageHeight }: ExtractedPage, headerFooterSet: Set<string>, cluster: ClusterOptions,
) {
  const { paragraphs, scanned } = clusterPageFromLines(lines, { headerFooterSet, cluster, pageHeight });
  const sizes = lines.map((l) => l.fontSize).sort((a, b) => a - b);
  const bodySize = sizes[Math.floor(sizes.length / 2)] ?? 0;
  let section: string | undefined;
  return { scanned, paragraphs: paragraphs.map((p) => {
    if (p.text.length <= 120 && p.fontSize >= bodySize * 1.2) section = p.text;
    return { ...p, section };
  }) };
}
