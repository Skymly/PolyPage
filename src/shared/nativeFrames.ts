/**
 * Native Messaging frame codec (spec 2.0 §5.2).
 *
 * Transport: 32-bit little-endian length prefix + UTF-8 JSON payload.
 * Chrome applies this framing between the extension and the native host;
 * this module is used by the Node-based mock host (smoke tests) and mirrors
 * the C# gateway implementation. Unit-tested including the 1MB boundary.
 */

/** Native Messaging hard limit: 1 MB per message (host -> extension). */
export const NATIVE_MAX_MESSAGE_BYTES = 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode one JSON message into a length-prefixed frame. */
export function encodeFrame(message: unknown): Uint8Array {
  const json = JSON.stringify(message);
  const payload = textEncoder.encode(json);
  if (payload.byteLength > NATIVE_MAX_MESSAGE_BYTES) {
    throw new Error(
      `Native Messaging 帧超过 1MB 上限（${payload.byteLength} 字节），请在扩展侧预切分批量`,
    );
  }
  const frame = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.byteLength, true); // little-endian
  frame.set(payload, 4);
  return frame;
}

/**
 * Incremental frame decoder: feed raw chunks, get complete parsed messages.
 * Handles frames split across chunks and multiple frames per chunk.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  /** Feed a chunk; returns all complete messages decoded so far. */
  push(chunk: Uint8Array): unknown[] {
    this.buffer = concatBytes(this.buffer, chunk);
    const out: unknown[] = [];
    for (;;) {
      if (this.buffer.byteLength < 4) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4);
      const length = view.getUint32(0, true);
      if (length > NATIVE_MAX_MESSAGE_BYTES) {
        throw new Error(`收到超过 1MB 的 Native Messaging 帧（${length} 字节）`);
      }
      if (this.buffer.byteLength < 4 + length) break;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      out.push(JSON.parse(textDecoder.decode(payload)));
    }
    return out;
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}