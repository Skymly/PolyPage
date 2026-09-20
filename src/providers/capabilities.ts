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
  /** Native-host only: why vision/ASR/streaming are off. */
  gatewayProbe?: GatewayProbe;
}

export type GatewayProbe = 'unprobed' | 'missing' | 'stale-protocol' | 'ok';

const NONE: ProviderCapabilities = { vision: false, asr: false, streaming: false };

export function providerCapabilities(
  provider: ProviderConfig | undefined,
  instance: TranslationProvider | null | undefined,
  gateway: GatewayCapabilities | null | undefined,
  probed = true,
): ProviderCapabilities {
  if (!provider || !isProviderConfigured(provider)) return NONE;
  if (provider.type === 'native-host') {
    if (!probed) return { ...NONE, gatewayProbe: 'unprobed' };
    if (!gateway) return { ...NONE, gatewayProbe: 'missing' };
    if ((gateway.protocol ?? 1) < 2) {
      return {
        vision: false,
        asr: false,
        streaming: gateway.supportsStreaming === true,
        gatewayProbe: 'stale-protocol',
      };
    }
    return {
      vision: gateway.supportsVision === true,
      asr: gateway.supportsAsr === true,
      streaming: gateway.supportsStreaming === true,
      gatewayProbe: 'ok',
    };
  }
  return {
    vision: !!instance && providerSupportsVision(instance),
    asr: !!instance && providerSupportsAsr(instance),
    streaming: !!instance && providerSupportsStreaming(instance),
  };
}