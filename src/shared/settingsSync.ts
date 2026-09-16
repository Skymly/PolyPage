/** Live settings sync (M-43): open pages must not auto-translate on a broadcast. */
export type SettingsApplyPhase = 'init' | 'live';

export function shouldStartAutoTranslate(
  phase: SettingsApplyPhase,
  autoTranslate: boolean,
  blacklisted: boolean,
  sameLanguage: boolean,
): boolean {
  if (phase !== 'init') return false;
  return autoTranslate && !blacklisted && !sameLanguage;
}
