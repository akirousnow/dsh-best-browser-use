import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  isValidCdpClientRequest,
} from '../packages/protocol/src/index.js';

describe('protocol frames', () => {
  it('round-trips hello, hello.ack, cdp.cmd, cdp.res, cdp.evt, ping/pong, and tabs.sync', () => {
    const frames = [
      {
        type: 'hello' as const,
        protocolVersion: PROTOCOL_VERSION,
        extensionVersion: '0.1.0',
        browserName: 'Chrome',
        userAgent: 'Mozilla/5.0',
        tabPolicyMode: 'auto' as const,
        tabs: [],
      },
      {
        type: 'hello.ack' as const,
        protocolVersion: PROTOCOL_VERSION,
        relayId: 'r-1',
        serverTime: 123456,
        heartbeatIntervalMs: 20_000,
      },
      { type: 'ping' as const, ts: 111 },
      { type: 'pong' as const, ts: 111 },
      { type: 'cdp.cmd' as const, id: 7, method: 'Page.navigate', params: { url: 'https://example.com' }, sessionId: 's1' },
      { type: 'cdp.res' as const, id: 7, result: { frameId: 'f1' }, sessionId: 's1' },
      { type: 'cdp.evt' as const, method: 'Page.loadEventFired', params: { timestamp: 99 }, sessionId: 's1' },
      { type: 'tabs.sync' as const, mode: 'manual' as const, tabs: [] },
      { type: 'control.cmd' as const, id: 2, action: 'detach_tab' as const, tabId: 42 },
      { type: 'control.res' as const, id: 2, ok: true },
    ];

    for (const frame of frames) {
      const encoded = encodeMessage(frame);
      expect(decodeMessage(encoded)).toEqual(frame);
    }
  });

  it('rejects invalid JSON, unknown types, and malformed payloads', () => {
    expect(decodeMessage('{not json')).toBeNull();
    expect(decodeMessage('null')).toBeNull();
    expect(decodeMessage('[]')).toBeNull();
    expect(decodeMessage(JSON.stringify({ type: 'unknown' }))).toBeNull();
    expect(decodeMessage(JSON.stringify({ type: 'cdp.cmd', id: 'bad', method: 'Page.reload' }))).toBeNull();
    expect(decodeMessage(JSON.stringify({ type: 'hello', protocolVersion: 1 }))).toBeNull();
    expect(decodeMessage(JSON.stringify({ type: 'tabs.sync', mode: 'invalid', tabs: [] }))).toBeNull();
  });

  it('validates standard CDP client requests', () => {
    expect(isValidCdpClientRequest({ id: 1, method: 'Target.getTargets' })).toBe(true);
    expect(
      isValidCdpClientRequest({ id: 2, method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: 's1' }),
    ).toBe(true);
    expect(isValidCdpClientRequest({ id: '1', method: 'Target.getTargets' })).toBe(false);
    expect(isValidCdpClientRequest({ id: 1 })).toBe(false);
    expect(isValidCdpClientRequest({ id: 1, method: 'X', params: ['not-an-object'] })).toBe(false);
  });
});
