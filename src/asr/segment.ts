/**
 * ASR cue segmentation (spec 4.0 §5.4 item 5):
 * prefer backend segments; otherwise split on sentence punctuation and
 * assign even timestamps across the capture window. Empty fragments are
 * dropped; cues longer than 80 characters are recut.
 */
export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

export const ASR_MAX_CUE_CHARS = 80;

const SENTENCE_SPLIT = /(?<=[。！？.!?…])\s+|\n+/;

export function segmentTranscript(
  input: { text: string; segments?: Array<{ start?: number; end?: number; text?: string }> },
  windowStart: number,
  windowDuration: number,
): AsrSegment[] {
  const duration = Number.isFinite(windowDuration) && windowDuration > 0 ? windowDuration : 1;
  const origin = Number.isFinite(windowStart) ? windowStart : 0;
  const fromBackend = (input.segments ?? [])
    .map((s) => ({
      start: typeof s.start === 'number' ? s.start : origin,
      end: typeof s.end === 'number' ? s.end : origin + duration,
      text: (s.text ?? '').trim(),
    }))
    .filter((s) => s.text.length > 0);
  const base = fromBackend.length > 0 ? fromBackend : evenSplitPlainText(input.text ?? '', origin, duration);
  return recutLongCues(base);
}

function evenSplitPlainText(text: string, origin: number, duration: number): AsrSegment[] {
  const parts = text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return [];
  return assignEvenTimes(parts, origin, duration);
}

function assignEvenTimes(parts: string[], origin: number, duration: number): AsrSegment[] {
  const n = parts.length;
  return parts.map((text, i) => ({
    start: origin + (i / n) * duration,
    end: origin + ((i + 1) / n) * duration,
    text,
  }));
}

function recutLongCues(segments: AsrSegment[]): AsrSegment[] {
  const out: AsrSegment[] = [];
  for (const seg of segments) {
    if (seg.text.length <= ASR_MAX_CUE_CHARS) {
      out.push(seg);
      continue;
    }
    const pieces = splitLongText(seg.text);
    const span = Math.max(seg.end - seg.start, 0.01);
    const totalChars = pieces.reduce((n, p) => n + p.length, 0) || 1;
    let cursor = seg.start;
    for (const text of pieces) {
      const slice = span * (text.length / totalChars);
      out.push({ start: cursor, end: cursor + slice, text });
      cursor += slice;
    }
  }
  return out;
}

function splitLongText(text: string): string[] {
  const byPunct = text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seeds = byPunct.length > 1 ? byPunct : [text];
  const out: string[] = [];
  for (const seed of seeds) {
    if (seed.length <= ASR_MAX_CUE_CHARS) {
      out.push(seed);
      continue;
    }
    for (let i = 0; i < seed.length; i += ASR_MAX_CUE_CHARS) {
      const chunk = seed.slice(i, i + ASR_MAX_CUE_CHARS).trim();
      if (chunk.length > 0) out.push(chunk);
    }
  }
  return out;
}
