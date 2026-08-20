/**
 * Provider capability projection. Content scripts consume booleans only.
 */
import type { ProviderConfig } from '../shared/types';
import type { GatewayCapabilities } from '../shared/nativeRpc';
import {
  providerSupportsAsr,
  providerSupportsStreaming,
  providerSupportsVision,
} from './provider';
import type { TranslationProvider } from './provider';
import { isProviderConfigured } from '../translation/context';

export interface ProviderCapabilities {
  vision: boolean;
  asr: boolean;
  streaming: boolean;
}

const NONE: ProviderCapabilities = { vision: false, asr: false, streaming: false };

export function providerCapabilities(
  provider: ProviderConfig | undefined,
  instance: TranslationProvider | null | undefined,
  gateway: GatewayCapabilities | null | undefined,
): ProviderCapabilities {
  if (!provider || !isProviderConfigured(provider)) return NONE;
  if (provider.type === 'native-host') {
    const protocol = gateway?.protocol ?? 1;
    if (protocol < 2) return NONE;
    return {
      vision: gateway?.supportsVision === true,
      asr: gateway?.supportsAsr === true,
      streaming: gateway?.supportsStreaming === true,
    };
  }
  return {
    vision: !!instance && providerSupportsVision(instance),
    asr: !!instance && providerSupportsAsr(instance),
    streaming: !!instance && providerSupportsStreaming(instance),
  };
}