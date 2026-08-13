/**
 * Pure subtitle cue helpers (spec 3.0 pillar G / §7.1). DOM orchestration
 * lives in content/media.ts; these functions are unit-tested.
 */

export interface CueLike {
  startTime: number;
  endTime: number;
  text: string;
}

/** Strip WebVTT cue payload tags (<c>, <b>, timestamps...) and collapse
 *  whitespace. */
export function stripVttTags(text: string): string {
  return text
    .replace(/<[^>\d][^>]*>/g, '') // markup tags like <c.colorCCCCCC>
    .replace(/<\d{2}:\d{2}[^>]*>/g, '') // timestamp tags <00:00:01.000>
    .replace(/\{[^}]*\}/g, '') // ASS-style inline overrides
    .replace(/\s+/g, ' ')
    .trim();
}

/** Find the cue(s) active at `time`; returns their cleaned joined text. */
export function activeCueText(cues: CueLike[], time: number): string | null {
  const active = cues.filter((c) => time >= c.startTime && time < c.endTime);
  if (active.length === 0) return null;
  const text = active.map((c) => stripVttTags(c.text)).filter((t) => t !== '').join(' ');
  return text === '' ? null : text;
}

/**
 * Cue scheduling decisions (spec 3.0 §12.1: activation / switch / cache
 * hit / restore). The scheduler owns the cue->translation cache; repeated
 * cues hit the cache instead of re-requesting (subtitle text repeats a lot).
 */
export type CueAction =
  | { kind: 'none' }
  | { kind: 'show'; text: string; translation: string | null }
  | { kind: 'fetch'; text: string };

/** Failed cues retry after this cooldown instead of every tick. */
const RETRY_COOLDOWN_MS = 5000;

export class CueScheduler {
  /** text -> translation. */
  private cache = new Map<string, string>();
  private pending = new Set<string>();
  /** text -> last failure timestamp (retryable after cooldown). */
  private failedAt = new Map<string, number>();
  private current: string | null = null;

  /** Decide what the renderer should do for the cue active at `time`. */
  decide(cues: CueLike[], time: number): CueAction {
    const text = activeCueText(cues, time);
    if (text === null) {
      this.current = null;
      return { kind: 'none' };
    }
    const cached = this.cache.get(text);
    if (cached !== undefined) {
      this.current = text;
      return { kind: 'show', text, translation: cached };
    }
    if (this.pending.has(text)) {
      this.current = text;
      return { kind: 'show', text, translation: null };
    }
    const failed = this.failedAt.get(text);
    if (failed !== undefined && Date.now() - failed < RETRY_COOLDOWN_MS) {
      this.current = text;
      return { kind: 'show', text, translation: null };
    }
    this.current = text;
    this.pending.add(text);
    return { kind: 'fetch', text };
  }

  /** Record a completed translation (or null on failure -> retryable after
   *  the cooldown). */
  resolve(text: string, translation: string | null): void {
    this.pending.delete(text);
    if (translation !== null) {
      this.cache.set(text, translation);
      this.failedAt.delete(text);
    } else {
      this.failedAt.set(text, Date.now());
    }
  }

  hasCached(text: string): boolean {
    return this.cache.has(text);
  }

  cachedTranslation(text: string): string | null {
    return this.cache.get(text) ?? null;
  }

  /** Restore: drop all state (layer teardown, spec 3.0 §7.1 item 7). */
  reset(): void {
    this.cache.clear();
    this.pending.clear();
    this.failedAt.clear();
    this.current = null;
  }

  get activeText(): string | null {
    return this.current;
  }
}