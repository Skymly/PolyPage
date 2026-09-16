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
