/**
 * Re-export: language-code mapping lives in shared so content/ does not
 * import providers/ (M-57).
 */
export {
  resolveLanguageCode,
  toAzureLanguage,
  toDeepLLanguage,
  toGoogleLanguage,
} from '../shared/langCodes';
