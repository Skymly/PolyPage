/**
 * Native Messaging frame codec tests (spec 2.0 §12.1):
 * encode/decode round trip, chunked delivery, and the 1MB boundary.
 */
import { describe, expect, it } from 'vitest';
import { FrameDecoder, NATIVE_MAX_MESSAGE_BYTES, encodeFrame } from '../src/shared/nativeFrames';
import { RPC_ERROR_CODES, rpcCodeToErrorKind } from '../src/shared/nativeRpc';

describe('encodeFrame', () => {
  it('writes a 32-bit little-endian length prefix', () => {
    const frame = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const view = new DataView(frame.buffer, frame.byteOffset);
    const length = view.getUint32(0, true);
    expect(length).toBe(frame.byteLength - 4);
    const json = new TextDecoder().decode(frame.subarray(4));
    expect(JSON.parse(json)).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });

  it('accepts a payload exactly at the 1MB limit', () => {
    // Build a JSON string payload of exactly NATIVE_MAX_MESSAGE_BYTES bytes.
    const prefix = '{"t":"';
    const suffix = '"}';
    const filler = 'a'.repeat(NATIVE_MAX_MESSAGE_BYTES - prefix.length - suffix.length);
    const message = JSON.parse(`${prefix}${filler}${suffix}`);
    const frame = encodeFrame(message);
    expect(frame.byteLength).toBe(4 + NATIVE_MAX_MESSAGE_BYTES);
  });

  it('rejects payloads above the 1MB limit', () => {
    const message = { t: 'a'.repeat(NATIVE_MAX_MESSAGE_BYTES) };
    expect(() => encodeFrame(message)).toThrow(/1MB/);
  });
});

describe('FrameDecoder', () => {
  it('decodes a single complete frame', () => {
    const decoder = new FrameDecoder();
    const msgs = decoder.push(encodeFrame({ hello: 'world' }));
    expect(msgs).toEqual([{ hello: 'world' }]);
  });

  it('handles frames split across many chunks', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    const out: unknown[] = [];
    // Feed one byte at a time.
    for (let i = 0; i < frame.byteLength; i++) {
      out.push(...decoder.push(frame.subarray(i, i + 1)));
    }
    expect(out).toEqual([{ jsonrpc: '2.0', id: 7, result: { ok: true } }]);
  });

  it('handles multiple frames in one chunk', () => {
    const decoder = new FrameDecoder();
    const a = encodeFrame({ n: 1 });
    const b = encodeFrame({ n: 2 });
    const combined = new Uint8Array(a.byteLength + b.byteLength);
    combined.set(a, 0);
    combined.set(b, a.byteLength);
    expect(decoder.push(combined)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('preserves UTF-8 multibyte content', () => {
    const decoder = new FrameDecoder();
    const msgs = decoder.push(encodeFrame({ text: '你好，世界 🌍' }));
    expect(msgs).toEqual([{ text: '你好，世界 🌍' }]);
  });

  it('rejects declared lengths above the 1MB limit', () => {
    const decoder = new FrameDecoder();
    const frame = new Uint8Array(8);
    new DataView(frame.buffer).setUint32(0, NATIVE_MAX_MESSAGE_BYTES + 1, true);
    expect(() => decoder.push(frame)).toThrow(/1MB/);
  });
});

describe('JSON-RPC error code mapping', () => {
  it('maps every documented code to an ErrorKind', () => {
    expect(rpcCodeToErrorKind(RPC_ERROR_CODES.network)).toBe('network');
    expect(rpcCodeToErrorKind(RPC_ERROR_CODES.timeout)).toBe('timeout');
    expect(rpcCodeToErrorKind(RPC_ERROR_CODES.auth)).toBe('auth');
    expect(rpcCodeToErrorKind(RPC_ERROR_CODES.rate_limit)).toBe('rate_limit');
    expect(rpcCodeToErrorKind(RPC_ERROR_CODES.server)).toBe('server');
    expect(rpcCodeToErrorKind(RPC_ERROR_CODES.invalid_response)).toBe('invalid_response');
    expect(rpcCodeToErrorKind(RPC_ERROR_CODES.config)).toBe('config');
    expect(rpcCodeToErrorKind(-31000)).toBe('unknown');
  });
});