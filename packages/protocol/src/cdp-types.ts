/** Protocol version shared by Extension and Relay. */
export const PROTOCOL_VERSION = 1 as const;

/** Default Relay listening port and host. */
export const DEFAULT_RELAY_HOST = '127.0.0.1';
export const DEFAULT_RELAY_PORT = 9229;
export const DEFAULT_EXT_PATH = '/ext';

/** Max WebSocket payload (64 MiB) to support full-page screenshots and large DOM snapshots. */
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** 20s heartbeat keeps Chrome MV3 Service Worker active past the 30s idle timer. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

/** Heartbeat timeout after which Relay considers an extension connection dead. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 65_000;

export type TabPolicyMode = 'auto' | 'manual';

export interface CdpError {
  code: number;
  message: string;
  data?: unknown;
}

export interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: CdpError;
  sessionId?: string;
}

export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpTargetInfo {
  targetId: string;
  type: 'page' | 'iframe' | 'worker' | 'service_worker' | 'other' | string;
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: boolean;
  browserContextId?: string;
}

export interface ExtensionTabSummary {
  tabId: number;
  targetId: string;
  windowId?: number;
  url: string;
  title: string;
  active: boolean;
  attached: boolean;
  eligible: boolean;
  authorized: boolean;
  sessionId?: string;
  detachReason?: string;
}

export interface ExtensionClientInfo {
  extensionVersion: string;
  browserName: string;
  userAgent: string;
  tabPolicyMode: TabPolicyMode;
  remoteAddress?: string;
  isRemote: boolean;
  connectedAt: number;
  lastHeartbeatAt: number;
}

export interface RelayStatusSnapshot {
  ok: boolean;
  relayId: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  host: string;
  port: number;
  extPath: string;
  tokenRequired: boolean;
  uptimeMs: number;
  extensionConnected: boolean;
  extension: ExtensionClientInfo | null;
  tabs: ExtensionTabSummary[];
  cdpClients: number;
  cdpWsPath: string;
  cdpWsUrl: string;
}
