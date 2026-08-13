/**
 * pdf.js local-packaging loader (spec 3.0 §5.1 / §13). The vendor build is
 * shipped inside the extension (dist/vendor) and lazily imported only by the
 * reader page — content scripts and the service worker never load it.
 *
 * MV3 note: the worker is a same-extension module worker; if worker startup
 * fails pdf.js falls back to its fake (main-thread) worker automatically as
 * long as workerSrc points at a readable file (spec 3.0 §13 mitigation).
 */

/** Structural typing keeps us independent of pdf.js's own d.ts. */
export interface PdfPageLike {
  pageNumber: number;
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
  getTextContent(): Promise<{ items: unknown[] }>;
}

export interface PdfDocumentLike {
  numPages: number;
  fingerprints?: readonly (string | null)[] | null;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(params: { data: ArrayBuffer | Uint8Array }): { promise: Promise<PdfDocumentLike> };
}

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/** Lazily import the locally packaged pdf.js module. */
export function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    const url = chrome.runtime.getURL('vendor/pdf.min.mjs');
    pdfjsPromise = import(/* @vite-ignore */ url).then((mod) => {
      const pdfjs = mod as unknown as PdfJsModule;
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/** Open a document from raw bytes. */
export async function openPdfDocument(data: ArrayBuffer): Promise<PdfDocumentLike> {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument({ data }).promise;
}