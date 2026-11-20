import {
  PROTOCOL_VERSION,
  type CdpError,
  type ExtensionTabSummary,
  type TabPolicyMode,
} from './cdp-types.js';

export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
  extensionVersion: string;
  browserName: string;
  userAgent: string;
  tabPolicyMode: TabPolicyMode;
  tabs: ExtensionTabSummary[];
}

export interface HelloAckMessage {
  type: 'hello.ack';
  protocolVersion: typeof PROTOCOL_VERSION;
  relayId: string;
  serverTime: number;
  heartbeatIntervalMs: number;
}

export interface PingMessage {
  type: 'ping';
  ts: number;
}

export interface PongMessage {
  type: 'pong';
  ts: number;
}

export interface CdpCommandMessage {
  type: 'cdp.cmd';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResponseMessage {
  type: 'cdp.res';
  id: number;
  result?: Record<string, unknown>;
  error?: CdpError;
  sessionId?: string;
}

export interface CdpEventMessage {
  type: 'cdp.evt';
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface TabsSyncMessage {
  type: 'tabs.sync';
  mode: TabPolicyMode;
  tabs: ExtensionTabSummary[];
}

export interface ControlCommandMessage {
  type: 'control.cmd';
  id: number;
  action: 'detach_tab' | 'attach_tab' | 'set_mode' | 'refresh_tabs';
  tabId?: number;
  mode?: TabPolicyMode;
}

export interface ControlResponseMessage {
  type: 'control.res';
  id: number;
  ok: boolean;
  error?: string;
  tabs?: ExtensionTabSummary[];
  mode?: TabPolicyMode;
}

export interface StatusRequestMessage {
  type: 'status';
}

export type ExtensionToRelayMessage =
  | HelloMessage
  | PingMessage
  | PongMessage
  | CdpResponseMessage
  | CdpEventMessage
  | TabsSyncMessage
  | ControlResponseMessage
  | StatusRequestMessage;

export type RelayToExtensionMessage =
  | HelloAckMessage
  | PingMessage
  | PongMessage
  | CdpCommandMessage
  | ControlCommandMessage;

export type BridgeMessage = ExtensionToRelayMessage | RelayToExtensionMessage;

const VALID_TYPES = new Set([
  'hello',
  'hello.ack',
  'ping',
  'pong',
  'cdp.cmd',
  'cdp.res',
  'cdp.evt',
  'tabs.sync',
  'control.cmd',
  'control.res',
  'status',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Serialize any protocol frame to JSON string. */
export function encodeMessage(msg: BridgeMessage): string {
  return JSON.stringify(msg);
}

/** Parse and structurally validate a raw JSON frame from Extension or Relay. */
export function decodeMessage(raw: string): BridgeMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string' || !VALID_TYPES.has(parsed.type)) {
    return null;
  }
  switch (parsed.type) {
    case 'hello':
      if (
        typeof parsed.protocolVersion !== 'number' ||
        typeof parsed.extensionVersion !== 'string' ||
        typeof parsed.browserName !== 'string' ||
        typeof parsed.userAgent !== 'string' ||
        (parsed.tabPolicyMode !== 'auto' && parsed.tabPolicyMode !== 'manual') ||
        !Array.isArray(parsed.tabs)
      ) {
        return null;
      }
      return parsed as unknown as HelloMessage;
    case 'hello.ack':
      if (
        typeof parsed.protocolVersion !== 'number' ||
        typeof parsed.relayId !== 'string' ||
        typeof parsed.serverTime !== 'number' ||
        typeof parsed.heartbeatIntervalMs !== 'number'
      ) {
        return null;
      }
      return parsed as unknown as HelloAckMessage;
    case 'ping':
    case 'pong':
      if (typeof parsed.ts !== 'number') return null;
      return parsed as unknown as PingMessage | PongMessage;
    case 'cdp.cmd':
      if (typeof parsed.id !== 'number' || typeof parsed.method !== 'string') return null;
      return parsed as unknown as CdpCommandMessage;
    case 'cdp.res':
      if (typeof parsed.id !== 'number') return null;
      return parsed as unknown as CdpResponseMessage;
    case 'cdp.evt':
      if (typeof parsed.method !== 'string') return null;
      return parsed as unknown as CdpEventMessage;
    case 'tabs.sync':
      if (
        (parsed.mode !== 'auto' && parsed.mode !== 'manual') ||
        !Array.isArray(parsed.tabs)
      ) {
        return null;
      }
      return parsed as unknown as TabsSyncMessage;
    case 'control.cmd':
      if (typeof parsed.id !== 'number' || typeof parsed.action !== 'string') return null;
      return parsed as unknown as ControlCommandMessage;
    case 'control.res':
      if (typeof parsed.id !== 'number' || typeof parsed.ok !== 'boolean') return null;
      return parsed as unknown as ControlResponseMessage;
    case 'status':
      return { type: 'status' };
    default:
      return null;
  }
}

/** Parse a standard CDP JSON message (from a CDP client like playwright-core). */
export function isValidCdpClientRequest(
  value: unknown,
): value is { id: number; method: string; params?: Record<string, unknown>; sessionId?: string } {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.method === 'string' &&
    (value.params === undefined || isRecord(value.params)) &&
    (value.sessionId === undefined || typeof value.sessionId === 'string')
  );
}
