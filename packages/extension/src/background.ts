import {
  DEFAULT_EXT_PATH,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type ControlCommandMessage,
  type ExtensionTabSummary,
  type ExtensionToRelayMessage,
  type TabPolicyMode,
} from '@agent-browser-bridge/protocol';
import { CdpBridge, type ChromeBridgeApi } from './cdp-bridge.js';
import { TabPolicy } from './tab-policy.js';

export interface ExtensionConfig {
  host: string;
  port: number;
  path: string;
  useWss: boolean;
  token: string;
  autoConnect: boolean;
  tabPolicyMode: TabPolicyMode;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ExtensionRuntimeState {
  connectionState: ConnectionState;
  lastError: string | null;
  relayId: string | null;
  config: ExtensionConfig;
  tabs: ExtensionTabSummary[];
  reconnectAttempt: number;
}

const STORAGE_KEY = 'agent_browser_bridge_config_v1';
const KEEPALIVE_ALARM = 'abb-keepalive-alarm';

const DEFAULT_CONFIG: ExtensionConfig = {
  host: DEFAULT_RELAY_HOST,
  port: DEFAULT_RELAY_PORT,
  path: DEFAULT_EXT_PATH,
  useWss: false,
  token: '',
  autoConnect: true,
  tabPolicyMode: 'auto',
};

let config: ExtensionConfig = { ...DEFAULT_CONFIG };
let connectionState: ConnectionState = 'disconnected';
let lastError: string | null = null;
let relayId: string | null = null;
let desiredConnected = true;
let reconnectAttempt = 0;
let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastTabs: ExtensionTabSummary[] = [];

const policy = new TabPolicy(DEFAULT_CONFIG.tabPolicyMode);
const bridge = new CdpBridge(chrome as unknown as ChromeBridgeApi, policy, {
  emitEvent(evt) {
    sendToRelay(evt);
  },
  onTabsChanged(tabs, mode) {
    lastTabs = tabs;
    updateBadge();
    sendToRelay({ type: 'tabs.sync', mode, tabs });
  },
});

function buildWsUrl(cfg: ExtensionConfig): string {
  const scheme = cfg.useWss ? 'wss' : 'ws';
  const normalizedPath = cfg.path.startsWith('/') ? cfg.path : `/${cfg.path || 'ext'}`;
  const url = new URL(`${scheme}://${cfg.host}:${cfg.port}${normalizedPath}`);
  if (cfg.token.trim().length > 0) {
    url.searchParams.set('token', cfg.token.trim());
  }
  return url.toString();
}

function sendToRelay(msg: ExtensionToRelayMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(encodeMessage(msg));
  } catch {
    // Socket closed mid-send; reconnect loop will recover.
  }
}

function updateBadge(): void {
  const attachedCount = lastTabs.filter((t) => t.attached).length;
  let color = '#6b7280';
  let text = '';

  switch (connectionState) {
    case 'connected':
      color = '#16a34a';
      text = attachedCount > 0 ? String(attachedCount) : 'ON';
      break;
    case 'connecting':
    case 'reconnecting':
      color = '#d97706';
      text = '...';
      break;
    case 'error':
      color = '#dc2626';
      text = '!';
      break;
    case 'disconnected':
    default:
      color = '#6b7280';
      text = '';
      break;
  }

  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setBadgeText({ text });
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS): void {
  stopHeartbeat();
  // Pitfall #1: 20s periodic WebSocket frame keeps Chrome 116+ MV3 Service Worker alive past 30s idle timer.
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendToRelay({ type: 'ping', ts: Date.now() });
    }
  }, intervalMs);
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!desiredConnected) return;
  clearReconnectTimer();
  const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
  reconnectAttempt++;
  connectionState = 'reconnecting';
  updateBadge();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (desiredConnected) {
      void connect();
    }
  }, delayMs);
}

async function handleControlCommand(cmd: ControlCommandMessage): Promise<void> {
  try {
    let tabs: ExtensionTabSummary[] | undefined;
    let mode: TabPolicyMode | undefined;
    if (cmd.action === 'detach_tab' && cmd.tabId !== undefined) {
      await bridge.detachTab(cmd.tabId, 'remote_control_detach');
      tabs = await bridge.getTabSummaries();
    } else if (cmd.action === 'attach_tab' && cmd.tabId !== undefined) {
      tabs = await bridge.authorizeTab(cmd.tabId, true);
    } else if (cmd.action === 'set_mode' && cmd.mode) {
      config.tabPolicyMode = cmd.mode;
      await saveConfig(config);
      tabs = await bridge.setMode(cmd.mode);
      mode = cmd.mode;
    } else if (cmd.action === 'refresh_tabs') {
      tabs = await bridge.getTabSummaries();
      mode = bridge.getMode();
    }
    sendToRelay({
      type: 'control.res',
      id: cmd.id,
      ok: true,
      ...(tabs ? { tabs } : {}),
      ...(mode ? { mode } : {}),
    });
  } catch (err) {
    sendToRelay({
      type: 'control.res',
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function detectBrowserName(ua: string): string {
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Brave')) return 'Brave';
  if (ua.includes('Chromium')) return 'Chromium';
  return 'Chrome';
}

async function connect(): Promise<void> {
  clearReconnectTimer();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  desiredConnected = true;
  connectionState = reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
  lastError = null;
  updateBadge();

  let url: string;
  try {
    url = buildWsUrl(config);
  } catch (err) {
    connectionState = 'error';
    lastError = `Invalid Relay URL: ${err instanceof Error ? err.message : String(err)}`;
    updateBadge();
    return;
  }

  const socket = new WebSocket(url);
  ws = socket;

  socket.addEventListener('open', async () => {
    if (ws !== socket) return;
    reconnectAttempt = 0;
    connectionState = 'connected';
    lastError = null;

    const tabs = await bridge.getTabSummaries();
    lastTabs = tabs;
    updateBadge();

    const manifest = chrome.runtime.getManifest();
    const ua = navigator.userAgent;
    sendToRelay({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: manifest.version,
      browserName: detectBrowserName(ua),
      userAgent: ua,
      tabPolicyMode: bridge.getMode(),
      tabs,
    });
    startHeartbeat(DEFAULT_HEARTBEAT_INTERVAL_MS);
  });

  socket.addEventListener('message', (event) => {
    if (ws !== socket) return;
    const raw = typeof event.data === 'string' ? event.data : '';
    const msg = decodeMessage(raw);
    if (!msg) return;

    switch (msg.type) {
      case 'hello.ack':
        relayId = msg.relayId;
        startHeartbeat(msg.heartbeatIntervalMs);
        break;
      case 'ping':
        sendToRelay({ type: 'pong', ts: msg.ts });
        break;
      case 'pong':
        break;
      case 'cdp.cmd':
        void bridge.handleCommand(msg).then((res) => sendToRelay(res));
        break;
      case 'control.cmd':
        void handleControlCommand(msg);
        break;
      default:
        break;
    }
  });

  socket.addEventListener('error', () => {
    if (ws !== socket) return;
    lastError = `Cannot reach Relay at ${config.useWss ? 'wss' : 'ws'}://${config.host}:${config.port}${config.path}`;
    if (!desiredConnected) {
      connectionState = 'error';
      updateBadge();
    }
  });

  socket.addEventListener('close', (ev) => {
    if (ws !== socket) return;
    ws = null;
    relayId = null;
    stopHeartbeat();

    if (ev.code === 4000) {
      // Replaced by another connection.
      desiredConnected = false;
      connectionState = 'disconnected';
      updateBadge();
      return;
    }

    if (ev.reason) {
      lastError = ev.reason;
    }

    if (desiredConnected) {
      scheduleReconnect();
    } else {
      connectionState = 'disconnected';
      updateBadge();
    }
  });
}

async function disconnect(): Promise<void> {
  desiredConnected = false;
  clearReconnectTimer();
  stopHeartbeat();
  reconnectAttempt = 0;

  if (ws) {
    const current = ws;
    ws = null;
    try {
      current.close(1000, 'User disconnected');
    } catch {
      // Ignore.
    }
  }
  await bridge.detachAll('user_disconnected');
  lastTabs = await bridge.getTabSummaries();
  connectionState = 'disconnected';
  relayId = null;
  lastError = null;
  updateBadge();
}

async function loadConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] as Partial<ExtensionConfig> | undefined;
  config = {
    ...DEFAULT_CONFIG,
    ...(raw ?? {}),
  };
  policy.setMode(config.tabPolicyMode);
  return config;
}

async function saveConfig(next: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
  config = {
    ...config,
    ...next,
    port: Number(next.port ?? config.port) || DEFAULT_RELAY_PORT,
  };
  policy.setMode(config.tabPolicyMode);
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
  return config;
}

async function getRuntimeState(): Promise<ExtensionRuntimeState> {
  lastTabs = await bridge.getTabSummaries();
  return {
    connectionState,
    lastError,
    relayId,
    config,
    tabs: lastTabs,
    reconnectAttempt,
  };
}

// Safety-net alarm: wakes Service Worker every 30s if Chrome ever suspends it, and reconnects if dropped.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  void bootPromise.then(() => {
    if (desiredConnected && (!ws || ws.readyState === WebSocket.CLOSED)) {
      void connect();
    } else if (ws && ws.readyState === WebSocket.OPEN) {
      sendToRelay({ type: 'ping', ts: Date.now() });
    }
  });
});

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  const run = async () => {
    switch (message.type) {
      case 'get_state':
        return await getRuntimeState();
      case 'save_and_connect': {
        await saveConfig(message.config as Partial<ExtensionConfig>);
        await disconnect();
        desiredConnected = true;
        await connect();
        return await getRuntimeState();
      }
      case 'save_config': {
        await saveConfig(message.config as Partial<ExtensionConfig>);
        return await getRuntimeState();
      }
      case 'connect': {
        if (message.config) {
          await saveConfig(message.config as Partial<ExtensionConfig>);
        }
        desiredConnected = true;
        await connect();
        return await getRuntimeState();
      }
      case 'disconnect': {
        await disconnect();
        return await getRuntimeState();
      }
      case 'set_mode': {
        const mode = message.mode === 'manual' ? 'manual' : 'auto';
        await saveConfig({ tabPolicyMode: mode });
        await bridge.setMode(mode);
        return await getRuntimeState();
      }
      case 'authorize_tab': {
        await bridge.authorizeTab(Number(message.tabId), true);
        return await getRuntimeState();
      }
      case 'revoke_tab': {
        await bridge.revokeTab(Number(message.tabId));
        return await getRuntimeState();
      }
      case 'detach_tab': {
        await bridge.detachTab(Number(message.tabId), 'user_detached');
        return await getRuntimeState();
      }
      default:
        return { error: `Unknown popup action: ${String(message.type)}` };
    }
  };

  void run()
    .then((result) => sendResponse(result))
    .catch((err) =>
      sendResponse({ error: err instanceof Error ? err.message : String(err) }),
    );
  return true;
});

async function boot(): Promise<void> {
  bridge.bindListeners();
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  await loadConfig();
  lastTabs = await bridge.getTabSummaries();
  updateBadge();
  if (config.autoConnect) {
    await connect();
  }
}

const bootPromise = boot();
