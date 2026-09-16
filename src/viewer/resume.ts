/**
 * PDF 阅读器续译匹配（M-03）：稳定段落 key + textHash。
 * 不碰 DOM；viewer/main.ts 拿匹配结果再提交翻译管线。
 */
import { pdfScopedCacheText } from './pdf/fingerprint';
import { hashText } from '../shared/utils';

export function pdfParagraphKey(pageIndex: number, paraIndex: number): string {
  return `p${pageIndex}-${paraIndex}`;
}

export function parsePdfParagraphKey(key: string): { pageIndex: number; paraIndex: number } | null {
  const match = /^p(\d+)-(\d+)$/.exec(key);
  if (!match) return null;
  return { pageIndex: Number(match[1]), paraIndex: Number(match[2]) };
}

export interface PdfResumePara {
  text: string;
  status: 'idle' | 'pending' | 'done' | 'error';
  error?: string | null;
}

export interface PdfResumePage<TPara extends PdfResumePara> {
  index: number;
  paragraphs: TPara[];
}

export interface PdfResumeMatch<TPara extends PdfResumePara> {
  page: PdfResumePage<TPara>;
  para: TPara;
  paraIndex: number;
  key: string;
}

export function matchPdfResumeTasks<TPara extends PdfResumePara>(
  pages: Array<PdfResumePage<TPara>>,
  tasks: Array<{ key: string; textHash: string }>,
  fingerprint: string,
): Array<PdfResumeMatch<TPara>> {
  const byPage = new Map(pages.map((page) => [page.index, page]));
  const hits: Array<PdfResumeMatch<TPara>> = [];
  for (const task of tasks) {
    const parsed = parsePdfParagraphKey(task.key);
    if (!parsed) continue;
    const page = byPage.get(parsed.pageIndex);
    if (!page) continue;
    const para = page.paragraphs[parsed.paraIndex];
    if (!para) continue;
    if (para.status === 'done') continue;
    const scoped = pdfScopedCacheText(fingerprint, page.index, parsed.paraIndex, para.text);
    if (hashText(scoped) !== task.textHash) continue;
    hits.push({ page, para, paraIndex: parsed.paraIndex, key: task.key });
  }
  return hits;
}
