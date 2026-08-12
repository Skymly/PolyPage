/**
 * Pure utility functions shared by all contexts (also unit-tested).
 */

/** Replace {{var}} placeholders in a template. Unknown variables are kept. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match;
  });
}

/** Escape a value so it can be safely embedded inside a JSON string literal. */
export function escapeForJsonString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Read a value from a nested object/JSON via a dot path ("data.items.0.text").
 * Returns undefined when any segment is missing.
 */
export function getByPath(value: unknown, path: string | undefined): unknown {
  if (!path || path.trim() === '') return value;
  let current: unknown = value;
  for (const rawSegment of path.split('.')) {
    const segment = rawSegment.trim();
    if (segment === '') continue;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Fast non-cryptographic string hash (djb2-xor variant), hex encoded. */
export function hashText(input: string): string {
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2) ^ (c * 31);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export interface BatchSlice<T> {
  items: T[];
  chars: number;
}

/**
 * Split items into batches honoring both max item count and max char budget.
 * A single item longer than maxChars still forms its own batch.
 */
export function chunkItems<T>(
  items: T[],
  maxItems: number,
  maxChars: number,
  textOf: (item: T) => string,
): BatchSlice<T>[] {
  const batches: BatchSlice<T>[] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const len = textOf(item).length;
    const wouldExceed =
      current.length > 0 && (current.length >= maxItems || chars + len > maxChars);
    if (wouldExceed) {
      batches.push({ items: current, chars });
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }
  if (current.length > 0) batches.push({ items: current, chars });
  return batches;
}

/** Strip markdown code fences that models sometimes wrap around JSON. */
export function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return text.trim();
}

/**
 * Parse a model reply for a batch of N texts.
 * Accepts: a JSON array, or a numbered list (1. / 1) / [1]).
 * Returns null when the reply cannot be mapped to exactly N items
 * (unless N === 1, in which case the whole reply is the translation).
 */
export function parseBatchTranslation(content: string, expectedCount: number): string[] | null {
  const cleaned = stripCodeFences(content).trim();
  if (cleaned === '') return null;

  if (expectedCount === 1) return [cleaned];

  // 1) Try JSON array (search for the outermost [...] in the reply).
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed) && parsed.length === expectedCount && parsed.every((x) => typeof x === 'string')) {
        return parsed as string[];
      }
    } catch {
      // fall through to numbered list parsing
    }
  }

  // 2) Try numbered list: "1. text", "1) text", "[1] text"
  const lines = cleaned.split('\n');
  const items: string[] = [];
  let buffer: string[] = [];
  let lastNumber = 0;
  const numberRe = /^\s*(?:\[(\d+)\]|(\d+)[.)、])\s*(.*)$/;
  for (const line of lines) {
    const m = line.match(numberRe);
    if (m) {
      if (buffer.length > 0) items.push(buffer.join('\n').trim());
      buffer = [];
      const n = parseInt(m[1] ?? m[2], 10);
      if (n !== lastNumber + 1 && lastNumber !== 0 && items.length > 0) {
        // numbering restarted or skipped — unreliable
        return null;
      }
      lastNumber = n;
      buffer.push(m[3]);
    } else if (lastNumber > 0) {
      buffer.push(line);
    }
  }
  if (buffer.length > 0) items.push(buffer.join('\n').trim());
  if (items.length === expectedCount && items.every((t) => t.length > 0)) return items;

  return null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function nowIso(): string {
  return new Date().toISOString();
}
