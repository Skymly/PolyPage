/**
 * Empty scanned-page `.paras` must not block a later rebuild (M-08).
 */
export function keepExistingParas(
  existing: Element | null,
  scanned: boolean,
  paragraphs: Array<{ el: unknown }>,
): boolean {
  if (!existing) return false;
  if (scanned) return true;
  return paragraphs.length > 0 && paragraphs.every((p) => p.el != null);
}

export function scannedOcrParaFromSegment(seg: { text: string; translation: string }): {
  text: string;
  status: 'done' | 'error';
  translated: string | null;
  error: string | null;
} {
  const translated = seg.translation.trim();
  if (translated !== '') {
    return { text: seg.text, status: 'done', translated, error: null };
  }
  return { text: seg.text, status: 'error', translated: null, error: '译文为空' };
}

/** Error-state PDF dst binds a retry click; done/pending must drop it (M-89). */
export function pdfDstNeedsRetryClick(status: 'idle' | 'pending' | 'done' | 'error'): boolean {
  return status === 'error';
}

export function assignPdfDstRetryClick(
  dst: { onclick: ((this: GlobalEventHandlers, ev: PointerEvent) => unknown) | null },
  status: 'idle' | 'pending' | 'done' | 'error',
  retry: (this: GlobalEventHandlers, ev: PointerEvent) => void,
): void {
  dst.onclick = pdfDstNeedsRetryClick(status) ? retry : null;
}

/** In-flight PDF translate stops between chunks after pagehide (M-89). */
export function pdfTranslateAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
