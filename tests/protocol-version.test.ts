/**
 * M-67: protocol v is stamped last and mismatches are rejected; absent v stays compatible.
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, kindedFailure, protocolVersionOk, withProtocol } from '../src/messaging/messages';

describe('withProtocol (M-67)', () => {
  it('stamps PROTOCOL_VERSION even when the payload already has v', () => {
    expect(withProtocol({ type: 'translate', v: 1 }).v).toBe(PROTOCOL_VERSION);
    expect(withProtocol({ type: 'wt:restore', v: 99 }).v).toBe(PROTOCOL_VERSION);
  });
});

describe('protocolVersionOk (M-67)', () => {
  it('accepts missing v (older compatible)', () => {
    expect(protocolVersionOk({ type: 'translate' })).toBe(true);
  });

  it('accepts current PROTOCOL_VERSION', () => {
    expect(protocolVersionOk({ type: 'translate', v: PROTOCOL_VERSION })).toBe(true);
  });

  it('rejects a different numeric v', () => {
    expect(protocolVersionOk({ type: 'translate', v: PROTOCOL_VERSION + 1 })).toBe(false);
    expect(protocolVersionOk({ type: 'wt:restore', v: 1 })).toBe(false);
  });
});

describe('kindedFailure (M-68)', () => {
  it('always includes kind on ok:false', () => {
    expect(kindedFailure('timeout', '超时')).toEqual({ ok: false, kind: 'timeout', error: '超时' });
  });
});
