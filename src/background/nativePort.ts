/**
 * Native Messaging connection manager (spec 2.0 §5.1/§5.3).
 * Background service worker only.
 *
 * - one chrome.runtime.Port per host name, opened lazily on first request;
 * - JSON-RPC 2.0 request/response correlation plus notification streaming;
 * - idle timeout (default 60s without activity) disconnects the port;
 * - the open port doubles as Service Worker keep-alive while requests run;
 * - a host that is not installed surfaces as ProviderError kind "config".
 */
import { NATIVE_PORT_IDLE_MS } from '../shared/constants';
import type { JsonRpcResponse } from '../shared/nativeRpc';
import { rpcCodeToErrorKind } from '../shared/nativeRpc';
import { ProviderError } from '../providers/provider';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (e: ProviderError) => void;
  timer: ReturnType<typeof setTimeout>;
  onNotification?: (method: string, params: unknown) => void;
}

interface HostConnection {
  port: chrome.runtime.Port;
  seq: number;
  pending: Map<number, PendingRequest>;
  lastActivity: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}

const connections = new Map<string, HostConnection>();

function failAll(conn: HostConnection, message: string): void {
  for (const [, pending] of conn.pending) {
    clearTimeout(pending.timer);
    pending.reject(new ProviderError('config', message));
  }
  conn.pending.clear();
}

function scheduleIdleDisconnect(hostName: string, conn: HostConnection): void {
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => {
    conn.idleTimer = null;
    if (conn.pending.size === 0) {
      disconnectHost(hostName, '空闲超时，已断开本地网关连接');
    }
  }, NATIVE_PORT_IDLE_MS);
}

export function disconnectHost(hostName: string, _reason?: string): void {
  const conn = connections.get(hostName);
  if (!conn) return;
  connections.delete(hostName);
  conn.dead = true;
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  failAll(conn, '本地网关连接已断开');
  try {
    conn.port.disconnect();
  } catch {
    /* already disconnected */
  }
}

function connectHost(hostName: string): HostConnection {
  const existing = connections.get(hostName);
  if (existing && !existing.dead) return existing;

  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(hostName);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const firefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);
    const hint = firefox
      ? 'Firefox 需安装器写入 Mozilla NativeMessagingHosts，且 allowed_extensions 包含 polypage@skymly.com'
      : '请确认已安装网关';
    throw new ProviderError('config', `无法启动本地网关 "${hostName}"：${raw}（${hint}）`);
  }

  const conn: HostConnection = {
    port,
    seq: 0,
    pending: new Map(),
    lastActivity: Date.now(),
    idleTimer: null,
    dead: false,
  };
  connections.set(hostName, conn);

  port.onMessage.addListener((raw: unknown) => {
    conn.lastActivity = Date.now();
    const msg = raw as Partial<JsonRpcResponse> & { method?: string; params?: unknown };
    // Notification (streaming delta or server event).
    if (typeof msg.method === 'string' && msg.id === undefined) {
      const params = (msg.params ?? {}) as { id?: number };
      if (typeof params.id === 'number') {
        const pending = conn.pending.get(params.id);
        pending?.onNotification?.(msg.method, msg.params);
      }
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const id = msg.id as number;
    const pending = conn.pending.get(id);
    if (!pending) return;
    conn.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const kind = rpcCodeToErrorKind(msg.error.code);
      pending.reject(
        new ProviderError(kind, `本地网关错误 (${msg.error.code}): ${msg.error.message}`),
      );
    } else {
      pending.resolve(msg.result);
    }
    scheduleIdleDisconnect(hostName, conn);
  });

  port.onDisconnect.addListener(() => {
    conn.dead = true;
    connections.delete(hostName);
    const err = chrome.runtime.lastError;
    const message = err?.message
      ? `本地网关连接断开：${err.message}`
      : '本地网关连接断开（网关可能未安装或已退出）';
    failAll(conn, message);
  });

  scheduleIdleDisconnect(hostName, conn);
  return conn;
}

export interface NativeRequestOptions {
  timeoutMs?: number;
  onNotification?: (method: string, params: unknown) => void;
  /** Called with the assigned request id (used for cancel semantics). */
  onId?: (id: number) => void;
}

/**
 * Send one JSON-RPC request to the host and await the response.
 * Throws ProviderError(kind=config) when the host is not installed/reachable.
 */
export function nativeRequest<T = unknown>(
  hostName: string,
  method: string,
  params: unknown,
  options: NativeRequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  let conn: HostConnection;
  try {
    conn = connectHost(hostName);
  } catch (e) {
    return Promise.reject(e instanceof ProviderError ? e : new ProviderError('config', String(e)));
  }
  const id = ++conn.seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new ProviderError('timeout', `本地网关响应超时（${timeoutMs}ms）: ${method}`));
    }, timeoutMs);
    conn.pending.set(id, {
      resolve: resolve as (r: unknown) => void,
      reject,
      timer,
      onNotification: options.onNotification,
    });
    options.onId?.(id);
    try {
      conn.port.postMessage({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      conn.pending.delete(id);
      clearTimeout(timer);
      reject(
        new ProviderError(
          'config',
          `无法向本地网关发送消息：${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  });
}

/** Send a JSON-RPC notification (no response expected), e.g. cancel. */
export function nativeNotify(hostName: string, method: string, params: unknown): void {
  const conn = connections.get(hostName);
  if (!conn || conn.dead) return;
  try {
    conn.port.postMessage({ jsonrpc: '2.0', method, params });
  } catch {
    /* host already gone */
  }
}

/** Ping a host without creating a provider instance. */
export async function pingNativeHost(
  hostName: string,
  timeoutMs = 8000,
): Promise<{ ok: boolean; version?: string; protocol?: number; error?: string }> {
  try {
    const result = await nativeRequest<{ version?: string; protocol?: number }>(
      hostName,
      'ping',
      {},
      { timeoutMs },
    );
    return {
      ok: true,
      version: typeof result?.version === 'string' ? result.version : undefined,
      protocol: typeof result?.protocol === 'number' ? result.protocol : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}