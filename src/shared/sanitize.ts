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
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' };

const THINK_PAIR = /<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi;
const THINK_TAG = /<\/?think\b[^>]*>/gi;
const THINK_CLOSE = /<\/think>/i;

/**
 * Strip thinking-chain tags. Paired `<think>…</think>` (case-insensitive,
 * unclosed pairs run to end-of-string) are removed first. A leftover
 * `</think>` is treated as the end of a qwen3-style thinking prefix.
 * Remaining bare tags are dropped. The word "think" is never touched.
 */
export function stripThinkTags(content: string): string {
  let text = content.replace(THINK_PAIR, '');
  const close = text.search(THINK_CLOSE);
  if (close >= 0) {
    text = text.slice(close).replace(THINK_CLOSE, '');
  }
  return text.replace(THINK_TAG, '');
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
    return raw.trim() === '' ? { ok: false, reason: 'empty' } : { ok: true, text: raw };
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

/**
 * Token Plan keys (`sk-cp-`) must hit `api.minimax.chat`. The international
 * `api.minimax.io` host returns 401 for those keys. Never include the key.
 */
export function minimaxHostHint(baseUrl: string, apiKey: string): string | null {
  const url = baseUrl.trim().toLowerCase();
  const key = apiKey.trim();
  if (!key.startsWith('sk-cp-')) return null;
  if (url.includes('minimax.io')) {
    return 'Token Plan 密钥应使用 https://api.minimax.chat ，不要指向 api.minimax.io';
  }
  return null;
}
