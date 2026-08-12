/**
 * Map user-friendly language names (often Chinese labels) to provider-
 * specific language codes. Unknown values pass through unchanged so power
 * users can always type raw codes.
 */

/** Chinese label -> BCP-47-ish code used by DeepL/Azure/Google. */
const ZH_LABEL_MAP: Record<string, string> = {
  '简体中文': 'zh',
  '中文': 'zh',
  '简体': 'zh',
  '中文（简体）': 'zh',
  '繁体中文': 'zh-Hant',
  '中文（繁体）': 'zh-Hant',
  '英语': 'en',
  '英文': 'en',
  '英语（美国）': 'en',
  '日语': 'ja',
  '日文': 'ja',
  '韩语': 'ko',
  '韩文': 'ko',
  '法语': 'fr',
  '法语（法国）': 'fr',
  '德语': 'de',
  '西班牙语': 'es',
  '俄语': 'ru',
  '葡萄牙语': 'pt',
  '意大利语': 'it',
  '泰语': 'th',
  '越南语': 'vi',
  '印尼语': 'id',
  '阿拉伯语': 'ar',
  '荷兰语': 'nl',
  '波兰语': 'pl',
  '土耳其语': 'tr',
  // Common English labels (case-insensitive lookup).
  english: 'en',
  chinese: 'zh',
  'simplified chinese': 'zh',
  'traditional chinese': 'zh-Hant',
  japanese: 'ja',
  korean: 'ko',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  russian: 'ru',
  portuguese: 'pt',
  italian: 'it',
  thai: 'th',
  vietnamese: 'vi',
  indonesian: 'id',
  arabic: 'ar',
  dutch: 'nl',
  polish: 'pl',
  turkish: 'tr',
};

function baseLabel(language: string): string {
  return language.trim().toLowerCase();
}

/**
 * Resolve a language label to a code. Returns undefined for "auto"/empty
 * (caller decides how to express auto-detection per API).
 */
export function resolveLanguageCode(language: string): string | undefined {
  const raw = language.trim();
  if (raw === '' || baseLabel(raw) === 'auto' || baseLabel(raw) === '自动') return undefined;
  const hit = ZH_LABEL_MAP[raw] ?? ZH_LABEL_MAP[baseLabel(raw)];
  if (hit) return hit;
  return raw;
}

/** DeepL expects uppercase codes; zh-Hant maps to ZH-HANT. */
export function toDeepLLanguage(language: string): string | undefined {
  const code = resolveLanguageCode(language);
  if (!code) return undefined;
  if (baseLabel(code) === 'zh-hans') return 'ZH';
  return code.toUpperCase();
}

/** Azure accepts BCP-47; plain "zh" means simplified. */
export function toAzureLanguage(language: string): string | undefined {
  const code = resolveLanguageCode(language);
  if (!code) return undefined;
  if (baseLabel(code) === 'zh') return 'zh-Hans';
  return code;
}

/** Google v2 uses codes like zh-CN / zh-TW. */
export function toGoogleLanguage(language: string): string | undefined {
  const code = resolveLanguageCode(language);
  if (!code) return undefined;
  const lower = baseLabel(code);
  if (lower === 'zh' || lower === 'zh-hans') return 'zh-CN';
  if (lower === 'zh-hant') return 'zh-TW';
  return code;
}