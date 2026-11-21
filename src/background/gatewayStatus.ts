import type { RuntimeResponseFor } from '../messaging/messages';
import { providerCapabilities } from '../providers/capabilities';
import { createProvider } from '../providers/provider';
import { DEFAULT_NATIVE_HOST_NAME } from '../shared/constants';
import { deniedNativeHostMessage, isAllowedNativeHostName } from '../shared/nativeHostName';
import type { GatewayCapabilities } from '../shared/nativeRpc';
import type { Settings } from '../shared/types';
import { isProviderConfigured } from '../translation/context';
import { nativeRequest, pingNativeHost } from './nativePort';

function detectBrowser(): 'firefox' | 'chromium' {
  return typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent) ? 'firefox' : 'chromium';
}

function nativeFailureReason(error?: string): string {
  const browser = detectBrowser();
  if (browser === 'firefox') {
    return (
      (error ? error + '。' : '') +
      'Firefox 需安装器写入 HKCU\\Software\\Mozilla\\NativeMessagingHosts，且 allowed_extensions 包含 polypage@skymly.com（与 dist-firefox gecko.id 一致）。'
    );
  }
  return error ?? '本地网关未安装或不可达';
}

/** Last probed gateway capabilities. null after a failed probe. */
let lastGatewayCaps: GatewayCapabilities | null = null;
let lastGatewayPing: { ok: boolean; version?: string; protocol?: number; error?: string } | null = null;
let gatewayProbed = false;
let gatewayProbeInflight: Promise<void> | null = null;

async function probeGatewayOnce(hostName = DEFAULT_NATIVE_HOST_NAME): Promise<void> {
  try {
    const ping = await pingNativeHost(hostName);
    lastGatewayPing = ping;
    if (ping.ok) {
      try {
        lastGatewayCaps = await nativeRequest<GatewayCapabilities>(
          hostName,
          'capabilities',
          {},
          { timeoutMs: 8000 },
        );
      } catch {
        lastGatewayCaps = { protocol: typeof ping.protocol === 'number' ? ping.protocol : 1 };
      }
    } else {
      lastGatewayCaps = null;
    }
  } catch (e) {
    lastGatewayPing = { ok: false, error: e instanceof Error ? e.message : String(e) };
    lastGatewayCaps = null;
  } finally {
    gatewayProbed = true;
  }
}

export async function ensureGatewayProbed(): Promise<void> {
  if (gatewayProbed) return;
  if (!gatewayProbeInflight) gatewayProbeInflight = probeGatewayOnce();
  await gatewayProbeInflight;
}

export function activeProviderCapabilities(settings: Settings) {
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId);
  let instance = null;
  try {
    if (provider && isProviderConfigured(provider)) instance = createProvider(provider);
  } catch {
    instance = null;
  }
  return providerCapabilities(provider, instance, lastGatewayCaps, gatewayProbed);
}

export async function hostStatus(
  requestedHost: string | undefined,
  getSettings: () => Promise<Settings>,
): Promise<RuntimeResponseFor<{ type: 'host-status' }>> {
  const hostName = requestedHost?.trim() || DEFAULT_NATIVE_HOST_NAME;
  if (!isAllowedNativeHostName(hostName)) {
    return {
      installed: false,
      error: deniedNativeHostMessage(hostName),
      browser: detectBrowser(),
      reason: deniedNativeHostMessage(hostName),
      probe: 'missing',
    };
  }
  gatewayProbeInflight = probeGatewayOnce(hostName);
  await gatewayProbeInflight;
  const ping = lastGatewayPing ?? { ok: false };
  const caps = activeProviderCapabilities(await getSettings());
  const stale = caps.gatewayProbe === 'stale-protocol';
  return {
    installed: ping.ok,
    version: ping.version,
    protocol: lastGatewayCaps?.protocol ?? ping.protocol,
    error: ping.error,
    browser: detectBrowser(),
    reason: ping.ok
      ? stale
        ? '网关协议过旧，视觉/转写不可用'
        : undefined
      : nativeFailureReason(ping.error),
    probe: caps.gatewayProbe,
  };
}
