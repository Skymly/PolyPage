/**
 * Text-level filtering rules (spec §7.3). Pure functions, unit-tested.
 */

const URL_RE = /^(?:https?|ftp):\/\/[^\s]+$/i;
const BARE_DOMAIN_RE = /^(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/[^\s]*)?$/i;
const EMAIL_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const DIGITS_RE = /^[\d\s.,:%+\-/]+$/;
/** Heuristic for code-like fragments: balanced braces/semicolons and keywords. */
const CODE_RE = /(?:^|[;{}])(?:\s*(?:if|for|while|return|function|const|let|var|import|export|class|=>)\s)/;

export interface TextFilterResult {
  skip: boolean;
  reason?: 'too_short' | 'digits' | 'url' | 'email' | 'code' | 'empty';
}

/** Decide whether a candidate text should be skipped (spec §7.3 filter rules). */
export function filterText(rawText: string, minTextLength: number): TextFilterResult {
  const text = rawText.trim();
  if (text.length === 0) return { skip: true, reason: 'empty' };
  if (text.length < minTextLength) return { skip: true, reason: 'too_short' };
  if (DIGITS_RE.test(text)) return { skip: true, reason: 'digits' };
  if (URL_RE.test(text) || (BARE_DOMAIN_RE.test(text) && !text.includes(' '))) {
    return { skip: true, reason: 'url' };
  }
  if (EMAIL_RE.test(text)) return { skip: true, reason: 'email' };
  if (text.includes('{') && text.includes('}') && CODE_RE.test(text)) {
    return { skip: true, reason: 'code' };
  }
  return { skip: false };
}
