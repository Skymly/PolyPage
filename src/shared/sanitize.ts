/**
 * Output hygiene (spec 4.2 pillar P).
 *
 * Pure functions used by the background pipeline before a translation is
 * shown or written to cache / TM. Content scripts must not invent a second
 * rewrite pass.
 */
import { stripCodeFences } from './utils';
import type { OutputSanitizeSettings } from './types';

export interface SanitizeOptions {
  enabled?: boolean;
  stripThink?: boolean;
  stripCodeFences?: boolean;
}

export type SanitizeResult =
  | { ok: true; text: string; persist?: boolean }
  | { ok: false; reason: 'empty' };

/** Debug `enabled: false` must not persist raw model output into cache / TM. */
export function persistSanitizedOutput(settings: { outputSanitize?: { enabled?: boolean } }): boolean {
  return settings.outputSanitize?.enabled !== false;
}

const THINK_PAIR = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const THINK_PAIR_HOLD = /<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi;
const THINK_TAG = /<\/?think\b[^>]*>/gi;
const THINK_CLOSE = /<\/think>/i;

/**
 * Strip thinking-chain tags. Closed `<think>…</think>` pairs are always
 * removed. Unclosed open tags: streaming holds through end-of-string;
 * final hygiene only drops the tag so a translation that mentions `<think>`
 * is not swallowed. A leftover `</think>` is a qwen3 prefix only when it
 * sits after a newline (or at the start); same-line mentions keep the body.
 */
export function stripThinkTags(content: string, options?: { holdUnclosed?: boolean }): string {
  let text = content.replace(options?.holdUnclosed ? THINK_PAIR_HOLD : THINK_PAIR, '');
  const close = text.search(THINK_CLOSE);
  if (close >= 0) {
    const prefix = text.slice(0, close);
    if (prefix.includes('\n') || prefix.trim() === '') {
      text = text.slice(close).replace(THINK_CLOSE, '');
    } else {
      text = text.replace(THINK_CLOSE, '');
    }
  }
  return text.replace(THINK_TAG, '');
}

/** Hold a trailing fragment that could turn into a think tag on the next delta. */
function holdThinkTagFragment(text: string): string {
  const start = text.lastIndexOf('<');
  if (start < 0) return text;
  const tail = text.slice(start).toLowerCase();
  if ('<think>'.startsWith(tail) || '</think>'.startsWith(tail) || /^<\/?think\b[^>]*$/.test(tail)) {
    return text.slice(0, start);
  }
  return text;
}

/**
 * Append-only preview. Without a separate reasoning channel or an inline close
 * tag, unmarked text may turn out to be reasoning when an orphan close arrives.
 */
export function createThinkDeltaFilter(allowUnmarkedText: boolean): (delta: string, separatedReasoning?: boolean) => string {
  let acc = '';
  let shown = '';
  let answerStarted = allowUnmarkedText;
  return (delta, separatedReasoning = false) => {
    acc += delta;
    if (!answerStarted && !separatedReasoning) {
      const close = THINK_CLOSE.exec(acc);
      if (!close) return '';
      acc = acc.slice(close.index + close[0].length);
    }
    answerStarted = true;
    const cleaned = holdThinkTagFragment(stripThinkTags(acc, { holdUnclosed: true }));
    if (!cleaned.startsWith(shown)) return '';
    const piece = cleaned.slice(shown.length);
    shown = cleaned;
    return piece;
  };
}

export function sanitizeOptionsFromSettings(
  settings: { outputSanitize?: OutputSanitizeSettings } | OutputSanitizeSettings | undefined,
): SanitizeOptions {
  const raw =
    settings && 'outputSanitize' in settings ? settings.outputSanitize : (settings as OutputSanitizeSettings | undefined);
  return {
    enabled: raw?.enabled !== false,
    stripThink: raw?.stripThink !== false,
    stripCodeFences: raw?.stripCodeFences === true,
  };
}

/**
 * Last-gate hygiene for a single translation string.
 * `enabled === false` leaves the raw model output untouched (debug).
 * After stripping, empty / whitespace-only results are `invalid_response`.
 */
export function sanitizeTranslation(raw: string, options?: SanitizeOptions): SanitizeResult {
  if (options?.enabled === false) {
    return raw.trim() === '' ? { ok: false, reason: 'empty' } : { ok: true, text: raw, persist: false };
  }

  let text = raw;
  if (options?.stripThink !== false) {
    text = stripThinkTags(text);
  }
  if (options?.stripCodeFences === true) {
    text = stripCodeFences(text);
  }
  text = text.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  return { ok: true, text };
}

export function hostnameOfUrl(raw: string): string | null {
  try {
    return new URL(raw.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

/** Official MiniMax API hosts (not a substring of an unrelated URL). */
export function isMinimaxApiHost(baseUrl: string): boolean {
  const host = hostnameOfUrl(baseUrl);
  if (!host) return false;
  return hostMatches(host, 'minimax.chat') || hostMatches(host, 'minimax.io');
}

/**
 * Token Plan keys (`sk-cp-`) must hit `api.minimax.chat`. The international
 * `api.minimax.io` host returns 401 for those keys. Never include the key.
 */
export function minimaxHostHint(baseUrl: string, apiKey: string): string | null {
  const key = apiKey.trim();
  if (!key.startsWith('sk-cp-')) return null;
  const host = hostnameOfUrl(baseUrl);
  if (!host || !hostMatches(host, 'minimax.io')) return null;
  return 'Token Plan 密钥应使用 https://api.minimax.chat ，不要指向 api.minimax.io';
}
