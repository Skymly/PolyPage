/**
 * Local zero-dependency page language detector (spec 3.0 §8.1).
 *
 * Strategy: Unicode script classification first (zh/ja/ko/ar/th are
 * script-unambiguous), then high-frequency stopword voting for the Latin
 * and Cyrillic families. Total footprint stays well under 5KB of logic.
 *
 * Supported languages (12): zh, en, ja, ko, ru, es, fr, de, it, pt, nl, ar.
 */

export interface DetectionResult {
  /** Dominant language code, or null when no confident decision. */
  language: string | null;
  confident: boolean;
  /** Normalized vote scores per language (for debugging/UI hints). */
  scores: Record<string, number>;
}

/** Small high-frequency stopword tables per Latin/Cyrillic language. */
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'it', 'with', 'as', 'was', 'on', 'are', 'this', 'be', 'at', 'have', 'from', 'or'],
  es: ['el', 'la', 'de', 'que', 'los', 'las', 'y', 'en', 'un', 'una', 'es', 'del', 'por', 'con', 'para', 'se', 'su', 'al', 'como', 'más'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'un', 'une', 'que', 'pour', 'dans', 'sur', 'avec', 'pas', 'ce', 'qui', 'au', 'en', 'plus'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'von', 'mit', 'ein', 'eine', 'für', 'auf', 'dem', 'den', 'des', 'als', 'auch', 'wird', 'bei', 'nach'],
  it: ['il', 'di', 'che', 'la', 'le', 'lo', 'gli', 'un', 'una', 'per', 'sono', 'con', 'del', 'della', 'più', 'anche', 'come', 'questo', 'alla', 'nei'],
  pt: ['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'que', 'em', 'um', 'uma', 'para', 'com', 'não', 'por', 'se', 'mais', 'como'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'op', 'te', 'zijn', 'voor', 'met', 'niet', 'aan', 'ook', 'maar', 'bij', 'naar', 'nog', 'dan'],
  ru: ['и', 'в', 'не', 'на', 'что', 'это', 'по', 'с', 'как', 'но', 'из', 'к', 'у', 'для', 'от', 'за', 'о', 'вы', 'мы', 'так'],
};

/** Languages resolvable only via stopwords (Latin family). */
const LATIN_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl'];

export interface ScriptCounts {
  han: number;
  hiragana: number;
  katakana: number;
  hangul: number;
  cyrillic: number;
  arabic: number;
  thai: number;
  latin: number;
  total: number;
}

/** Classify characters of a sample into script buckets. */
export function countScripts(text: string): ScriptCounts {
  const counts: ScriptCounts = {
    han: 0,
    hiragana: 0,
    katakana: 0,
    hangul: 0,
    cyrillic: 0,
    arabic: 0,
    thai: 0,
    latin: 0,
    total: 0,
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    let matched = true;
    if (cp >= 0x4e00 && cp <= 0x9fff) counts.han++;
    else if (cp >= 0x3400 && cp <= 0x4dbf) counts.han++;
    else if (cp >= 0xf900 && cp <= 0xfaff) counts.han++;
    else if (cp >= 0x3040 && cp <= 0x309f) counts.hiragana++;
    else if (cp >= 0x30a0 && cp <= 0x30ff) counts.katakana++;
    else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) counts.hangul++;
    else if (cp >= 0x0400 && cp <= 0x04ff) counts.cyrillic++;
    else if (cp >= 0x0600 && cp <= 0x06ff) counts.arabic++;
    else if (cp >= 0x0e00 && cp <= 0x0e7f) counts.thai++;
    else if (cp >= 0x41 && cp <= 0x5a) counts.latin++;
    else if (cp >= 0x61 && cp <= 0x7a) counts.latin++;
    else if (cp >= 0x00c0 && cp <= 0x024f) counts.latin++; // Latin-1 supplement + extensions
    else if (cp >= 0x1e00 && cp <= 0x1eff) counts.latin++; // Latin Extended Additional
    else matched = false;
    if (matched) counts.total++;
  }
  return counts;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 1 && t.length <= 12);
}

/** Vote stopwords across all samples; returns raw hit counts per language. */
export function stopwordVotes(samples: string[]): Record<string, number> {
  const votes: Record<string, number> = {};
  for (const lang of Object.keys(STOPWORDS)) votes[lang] = 0;
  for (const sample of samples) {
    const tokens = new Set(tokenize(sample));
    for (const [lang, words] of Object.entries(STOPWORDS)) {
      for (const w of words) {
        if (tokens.has(w)) votes[lang]++;
      }
    }
  }
  return votes;
}

/**
 * Detect the dominant language of the provided text samples.
 * Returns a null language when samples are empty or no script/signal wins.
 */
export function detectLanguage(samples: string[]): DetectionResult {
  const cleaned = samples
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.length > 0);
  if (cleaned.length === 0) {
    return { language: null, confident: false, scores: {} };
  }
  const joined = cleaned.join('\n');
  const counts = countScripts(joined);
  const total = Math.max(1, counts.total);
  const scores: Record<string, number> = {};

  // Japanese uses kana alongside kanji; pure Hangul means Korean.
  const kana = counts.hiragana + counts.katakana;
  if ((counts.han + kana) / total >= 0.4) {
    const lang = kana > 0 ? 'ja' : 'zh';
    scores[lang] = (counts.han + kana) / total;
    return { language: lang, confident: true, scores };
  }
  if (counts.hangul / total >= 0.2) {
    scores.ko = counts.hangul / total;
    return { language: 'ko', confident: counts.hangul / total >= 0.35, scores };
  }
  if (counts.arabic / total >= 0.35) {
    scores.ar = counts.arabic / total;
    return { language: 'ar', confident: true, scores };
  }
  if (counts.thai / total >= 0.35) {
    // Thai is not one of the 12 supported targets; report und confidently.
    scores.th = counts.thai / total;
    return { language: null, confident: false, scores };
  }

  const votes = stopwordVotes(cleaned);
  if (counts.cyrillic / total >= 0.3) {
    // Cyrillic family: ru is the only supported representative.
    scores.ru = counts.cyrillic / total + votes.ru / 100;
    return { language: 'ru', confident: true, scores };
  }

  if (counts.latin / total < 0.25) {
    return { language: null, confident: false, scores };
  }

  // Latin family: stopword voting decides.
  let best: { lang: string; hits: number } | null = null;
  let runnerUp = 0;
  for (const lang of LATIN_LANGUAGES) {
    const hits = votes[lang] ?? 0;
    scores[lang] = hits;
    if (!best || hits > best.hits) {
      if (best) runnerUp = Math.max(runnerUp, best.hits);
      best = { lang, hits };
    } else {
      runnerUp = Math.max(runnerUp, hits);
    }
  }
  if (!best || best.hits === 0) {
    // Latin text with no stopword signal at all: not confident.
    return { language: null, confident: false, scores };
  }
  const confident = best.hits >= 2 && best.hits >= runnerUp * 1.5;
  return { language: confident ? best.lang : null, confident, scores };
}