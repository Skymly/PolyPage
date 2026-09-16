/**
 * PDF page object / canvas lifetime (M-65).
 *
 * Text extraction still walks every page once (header/footer signatures),
 * but the pdf.js PageProxy must not stay pinned, and off-screen canvases
 * must drop their backing store.
 */
import type { PdfLine } from './segment';

export interface PdfPageHandle {
  getViewport(params: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup?: () => void;
}

export function cleanupPdfPage(page: { cleanup?: () => void } | null | undefined): void {
  if (page && typeof page.cleanup === 'function') page.cleanup();
}

export function blankCanvas(canvas: { width: number; height: number }): void {
  canvas.width = 0;
  canvas.height = 0;
}

export async function extractPageTextThenCleanup(
  page: PdfPageHandle,
  toLines: (items: unknown[]) => PdfLine[],
): Promise<{ lines: PdfLine[]; pageHeight: number }> {
  const pageHeight = page.getViewport({ scale: 1 }).height;
  let lines: PdfLine[] = [];
  try {
    const content = await page.getTextContent();
    lines = toLines(content.items);
  } catch {
    lines = [];
  } finally {
    cleanupPdfPage(page);
  }
  return { lines, pageHeight };
}

export function releaseOffscreenPage(page: {
  canvas: { width: number; height: number };
  pdfPage: { cleanup?: () => void } | null;
  rendered: boolean;
  renderGen?: number;
}): void {
  blankCanvas(page.canvas);
  cleanupPdfPage(page.pdfPage);
  page.pdfPage = null;
  page.rendered = false;
  page.renderGen = (page.renderGen ?? 0) + 1;
}
