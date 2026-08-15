/**
 * Native Messaging binary.chunk client (spec 4.0 §6.2):
 * split payloads so each JSON frame stays under the 1MB hard limit.
 * Recommended raw chunk size is 512 KiB: Base64 expands 4/3, and the
 * Native Messaging frame hard-limit is 1 MiB including JSON wrapper.
 * (768 KiB raw encodes to exactly 1 MiB of Base64 with no room left.)
 */
export const BINARY_CHUNK_RAW_MAX = 512 * 1024;

export interface BinaryChunkMessage {
  transferId: string;
  index: number;
  total: number;
  mime: string;
  data: string;
  sha256?: string;
}

/** Split bytes into Base64 chunk messages. sha256 is attached to every chunk. */
export function splitBinaryChunks(
  bytes: Uint8Array,
  mime: string,
  transferId: string,
  sha256?: string,
): BinaryChunkMessage[] {
  const size = Math.max(1, BINARY_CHUNK_RAW_MAX);
  const total = Math.max(1, Math.ceil(bytes.byteLength / size) || 1);
  const chunks: BinaryChunkMessage[] = [];
  if (bytes.byteLength === 0) {
    return [{ transferId, index: 0, total: 1, mime, data: '', ...(sha256 ? { sha256 } : {}) }];
  }
  for (let index = 0; index < total; index++) {
    const slice = bytes.subarray(index * size, Math.min(bytes.byteLength, (index + 1) * size));
    const chunk: BinaryChunkMessage = {
      transferId,
      index,
      total,
      mime,
      data: bytesToBase64(slice),
    };
    if (sha256) chunk.sha256 = sha256;
    chunks.push(chunk);
  }
  return chunks;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function assembleBinaryChunks(chunks: BinaryChunkMessage[]): Uint8Array {
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  const parts = ordered.map((c) => base64ToBytes(c.data));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
