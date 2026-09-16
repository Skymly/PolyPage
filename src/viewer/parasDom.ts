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
