/**
 * Shared translation-context helpers used by the pipeline and by SW adapters
 * that still need language / Provider configuration outside the pipeline
 * (OCR, ASR, settings projection).
 */
import type { ProviderConfig, Settings, ErrorKind } from '../shared/types';
import type { TranslationContext } from '../providers/provider';
import { renderGlossary } from '../shared/siteRules';

export function effectiveLanguages(settings: Settings, provider: ProviderConfig): {
  source: string;
  target: string;
} {
  return {
    source: provider.sourceLanguage.trim() !== '' ? provider.sourceLanguage : settings.defaultSourceLanguage,
    target: provider.targetLanguage.trim() !== '' ? provider.targetLanguage : settings.defaultTargetLanguage,
  };
}

export function buildContext(
  settings: Settings,
  provider: ProviderConfig,
  domain?: string,
  pageLanguage?: string | null,
): TranslationContext {
  const { source, target } = effectiveLanguages(settings, provider);
  const resolvedSource =
    source.trim().toLowerCase() === 'auto' &&
    settings.languageDetection === 'auto' &&
    typeof pageLanguage === 'string' &&
    pageLanguage !== ''
      ? pageLanguage
      : source;
  return {
    sourceLanguage: resolvedSource,
    targetLanguage: target,
    domain,
    glossary: renderGlossary(settings.glossary),
  };
}

export function isProviderConfigured(provider: ProviderConfig): boolean {
  if (!provider.enabled) return false;
  if (provider.type === 'native-host') return (provider.hostName ?? '').trim() !== '';
  return provider.baseUrl.trim() !== '';
}

/** Errors that justify failing over to the next provider (spec 2.0 §5.6). */
export function failoverEligible(kind: ErrorKind, providerType: string): boolean {
  if (kind === 'network' || kind === 'timeout' || kind === 'rate_limit' || kind === 'server') return true;
  return kind === 'config' && providerType === 'native-host';
}

/** Ordered list of provider ids to try after providerId fails. */
export function buildFailoverChain(settings: Settings, providerId: string): string[] {
  const chain: string[] = [];
  const configured = settings.failoverChain ?? [];
  const index = configured.indexOf(providerId);
  if (index >= 0) chain.push(...configured.slice(index + 1));
  else chain.push(...configured.filter((id) => id !== providerId));
  const provider = settings.providers.find((p) => p.id === providerId);
  if (provider?.type === 'native-host' && provider.fallbackProviderId) {
    if (!chain.includes(provider.fallbackProviderId)) chain.push(provider.fallbackProviderId);
  }
  const seen = new Set<string>();
  return chain.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const p = settings.providers.find((x) => x.id === id);
    return !!p && isProviderConfigured(p);
  });
}
