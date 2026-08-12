/**
 * JSON-RPC 2.0 message types shared by the extension's native-host provider
 * and the mock/real gateway (spec 2.0 §5.2).
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** Gateway JSON-RPC error codes map to extension ErrorKind (spec 2.0 §5.2). */
export const RPC_ERROR_CODES = {
  network: -32001,
  timeout: -32002,
  auth: -32003,
  rate_limit: -32004,
  server: -32005,
  invalid_response: -32006,
  config: -32007,
} as const;

export type RpcErrorKindName = keyof typeof RPC_ERROR_CODES;

export function rpcCodeToErrorKind(code: number): RpcErrorKindName | 'unknown' {
  for (const [name, value] of Object.entries(RPC_ERROR_CODES)) {
    if (value === code) return name as RpcErrorKindName;
  }
  return 'unknown';
}

/** Capabilities reported by the gateway's `capabilities` method. */
export interface GatewayCapabilities {
  name?: string;
  version?: string;
  protocol?: number;
  backends?: string[];
  supportsStreaming?: boolean;
  maxBatchItems?: number;
  maxBatchChars?: number;
}