import type { DocumentContext, GlossaryEntry } from './types';
import { renderGlossary } from './siteRules';

function label(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 96).join('');
}

export function boundedDocumentContext(value?: DocumentContext): DocumentContext | undefined {
  const title = label(value?.title);
  const section = label(value?.section);
  if (!title && !section) return undefined;
  return { ...(title && { title }), ...(section && { section }) };
}

/** Match Latin terms as words (e.g. "port" should not match "support").
 * CJK terms can occur inside a sentence without surrounding spaces. */
function containsTerm(text: string, source: string): boolean {
  const term = source.trim().toLowerCase();
  for (let pos = text.indexOf(term); pos >= 0; pos = text.indexOf(term, pos + 1)) {
    const before = text[pos - 1] ?? '';
    const after = text[pos + term.length] ?? '';
    if (/^[a-z0-9_]/.test(term) && /[a-z0-9_]/.test(before)) continue;
    if (/[a-z0-9_]$/.test(term) && /[a-z0-9_]/.test(after)) continue;
    return true;
  }
  return false;
}

export function glossaryFits(entries: GlossaryEntry[]): boolean {
  return entries.length <= 12 && renderGlossary(entries).length <= 1024;
}

export function matchedTerms(entries: GlossaryEntry[], texts: string[]): GlossaryEntry[] {
  if (texts.length === 0 || entries.length === 0) return [];
  const body = texts.join('\n').toLowerCase();
  const matched: GlossaryEntry[] = [];
  for (const entry of entries) {
    if (!entry.source.trim() || !entry.target.trim()) continue;
    if (!containsTerm(body, entry.source)) continue;
    if (!glossaryFits([...matched, entry])) continue;
    matched.push(entry);
    if (matched.length >= 12) break;
  }
  return matched;
}

export function relevantGlossary(entries: GlossaryEntry[], texts: string[] = []): string {
  return renderGlossary(matchedTerms(entries, texts));
}
