import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  type CdpCommandMessage,
  type ControlCommandMessage,
  type ExtensionTabSummary,
  type TabPolicyMode,
} from '../packages/protocol/src/index.js';
import {
  CdpBridge,
  type ChromeBridgeApi,
  type ChromeDebuggerTargetLike,
  type ChromeTabLike,
} from '../packages/extension/src/cdp-bridge.js';
import { TabPolicy } from '../packages/extension/src/tab-policy.js';

export interface MockChromeState {
  tabs: Map<number, ChromeTabLike>;
  attachedTabIds: Set<number>;
  attachFailTabIds: Set<number>;
  lastCreatedOptions: Array<{ url?: string; active?: boolean }>;
  sentCommands: Array<{
    target: ChromeDebuggerTargetLike;
    method: string;
    params?: Record<string, unknown>;
  }>;
  commandHandler?: (
    target: ChromeDebuggerTargetLike,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  triggerDebuggerEvent: (
    source: ChromeDebuggerTargetLike,
    method: string,
    params?: Record<string, unknown>,
  ) => void;
  triggerDebuggerDetach: (tabId: number, reason: string) => void;
  triggerTabCreated: (tab: ChromeTabLike) => void;
  triggerTabUpdated: (tabId: number, tab: ChromeTabLike) => void;
  triggerTabRemoved: (tabId: number) => void;
}

/** Create an in-memory mock of Chrome's tabs + debugger APIs for deterministic tests. */
export function createMockChromeApi(
  initialTabs: ChromeTabLike[] = [
    { id: 1, windowId: 1, url: 'https://example.com/', title: 'Example Domain', active: true },
    { id: 2, windowId: 1, url: 'chrome://settings', title: 'Settings', active: false },
  ],
): { api: ChromeBridgeApi; state: MockChromeState } {
  const tabs = new Map<number, ChromeTabLike>();
  let nextTabId = 10;
  for (const t of initialTabs) {
    const id = t.id ?? nextTabId++;
    tabs.set(id, { ...t, id });
    if (id >= nextTabId) nextTabId = id + 1;
  }

  const attachedTabIds = new Set<number>();
  const attachFailTabIds = new Set<number>();
  const lastCreatedOptions: Array<{ url?: string; active?: boolean }> = [];
  const sentCommands: MockChromeState['sentCommands'] = [];

  const createdListeners: Array<(tab: ChromeTabLike) => void> = [];
  const updatedListeners: Array<
    (tabId: number, changeInfo: Record<string, unknown>, tab: ChromeTabLike) => void
  > = [];
  const removedListeners: Array<(tabId: number) => void> = [];
  const eventListeners: Array<
    (source: ChromeDebuggerTargetLike, method: string, params?: Record<string, unknown>) => void
  > = [];
  const detachListeners: Array<(source: ChromeDebuggerTargetLike, reason: string) => void> = [];

  const state: MockChromeState = {
    tabs,
    attachedTabIds,
    attachFailTabIds,
    lastCreatedOptions,
    sentCommands,
    triggerDebuggerEvent(source, method, params) {
      for (const fn of eventListeners) fn(source, method, params);
    },
    triggerDebuggerDetach(tabId, reason) {
      attachedTabIds.delete(tabId);
      for (const fn of detachListeners) fn({ tabId }, reason);
    },
    triggerTabCreated(tab) {
      if (tab.id !== undefined) tabs.set(tab.id, tab);
      for (const fn of createdListeners) fn(tab);
    },
    triggerTabUpdated(tabId, tab) {
      tabs.set(tabId, { ...tab, id: tabId });
      for (const fn of updatedListeners) fn(tabId, { url: tab.url }, { ...tab, id: tabId });
    },
    triggerTabRemoved(tabId) {
      tabs.delete(tabId);
      attachedTabIds.delete(tabId);
      for (const fn of removedListeners) fn(tabId);
    },
  };

  const api: ChromeBridgeApi = {
    userAgent: 'Mozilla/5.0 MockChrome/131.0.0.0',
    tabs: {
      async query() {
        return [...tabs.values()];
      },
      async get(tabId) {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id ${tabId}`);
        return t;
      },
      async create(props) {
        lastCreatedOptions.push({ ...props });
        const id = nextTabId++;
        const tab: ChromeTabLike = {
          id,
          windowId: 1,
          url: props.url ?? 'about:blank',
          title: props.url ?? 'New Tab',
          active: Boolean(props.active),
        };
        tabs.set(id, tab);
        return tab;
      },
      async remove(tabId) {
        tabs.delete(tabId);
        attachedTabIds.delete(tabId);
      },
      async update(tabId, props) {
        const t = tabs.get(tabId);
        if (!t) throw new Error(`No tab with id ${tabId}`);
        if (props.active !== undefined) {
          if (props.active) {
            for (const other of tabs.values()) other.active = false;
          }
          t.active = props.active;
        }
        return t;
      },
      onCreated: { addListener: (cb) => createdListeners.push(cb) },
      onUpdated: { addListener: (cb) => updatedListeners.push(cb) },
      onRemoved: { addListener: (cb) => removedListeners.push(cb) },
    },
    debugger: {
      async attach(target) {
        const tabId = target.tabId!;
        if (attachFailTabIds.has(tabId)) {
          throw new Error(`Cannot attach to tab ${tabId}: DevTools already open`);
        }
        attachedTabIds.add(tabId);
      },
      async detach(target) {
        if (target.tabId !== undefined) attachedTabIds.delete(target.tabId);
      },
      async sendCommand(target, method, params) {
        sentCommands.push({ target, method, params });
        if (state.commandHandler) {
          return await state.commandHandler(target, method, params);
        }
        return { ok: true, echoedMethod: method, echoedParams: params ?? {} };
      },
      onEvent: { addListener: (cb) => eventListeners.push(cb) },
      onDetach: { addListener: (cb) => detachListeners.push(cb) },
    },
  };

  return { api, state };
}

export interface MockExtensionClientOptions {
  wsUrl: string;
  origin?: string;
  headers?: Record<string, string>;
  protocols?: string | string[];
  mode?: TabPolicyMode;
  initialTabs?: ChromeTabLike[];
  autoPong?: boolean;
}

/**
 * Full mock Chrome MV3 Extension speaking the exact Relay protocol over a real WebSocket.
 * Enables full-pipeline automated tests without requiring a Chrome binary.
 */
export class MockExtensionClient {
  readonly policy: TabPolicy;
  readonly bridge: CdpBridge;
  readonly chromeState: MockChromeState;
  ws: WebSocket | null = null;
  relayId: string | null = null;
  readonly receivedMessages: unknown[] = [];

  private readonly options: MockExtensionClientOptions;

  constructor(options: MockExtensionClientOptions) {
    this.options = options;
    const { api, state } = createMockChromeApi(options.initialTabs);
    this.chromeState = state;
    this.policy = new TabPolicy(options.mode ?? 'auto');
    this.bridge = new CdpBridge(api, this.policy, {
      emitEvent: (evt) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(encodeMessage(evt));
        }
      },
      onTabsChanged: (tabs: ExtensionTabSummary[], mode: TabPolicyMode) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(encodeMessage({ type: 'tabs.sync', mode, tabs }));
        }
      },
    });
    this.bridge.bindListeners();
  }

  async connect(): Promise<void> {
    const headers: Record<string, string> = { ...(this.options.headers ?? {}) };
    if (this.options.origin !== undefined) {
      headers.Origin = this.options.origin;
    }

    const ws = new WebSocket(this.options.wsUrl, this.options.protocols, {
      headers,
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let acked = false;
      ws.once('error', (err) => {
        if (!acked) reject(err);
      });
      ws.once('unexpected-response', (_req, res) => {
        if (!acked) reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim()));
      });
      ws.once('open', async () => {
        const tabs = await this.bridge.getTabSummaries();
        ws.send(
          encodeMessage({
            type: 'hello',
            protocolVersion: PROTOCOL_VERSION,
            extensionVersion: '0.1.0-mock',
            browserName: 'MockChrome',
            userAgent: 'Mozilla/5.0 MockChrome/131.0.0.0',
            tabPolicyMode: this.policy.getMode(),
            tabs,
          }),
        );
      });
      ws.on('message', (raw) => {
        const msg = decodeMessage(raw.toString('utf8'));
        if (!msg) return;
        this.receivedMessages.push(msg);

        if (msg.type === 'hello.ack') {
          this.relayId = msg.relayId;
          acked = true;
          resolve();
        } else if (msg.type === 'ping') {
          if (this.options.autoPong !== false) {
            ws.send(encodeMessage({ type: 'pong', ts: msg.ts }));
          }
        } else if (msg.type === 'cdp.cmd') {
          void this.handleCdpCmd(msg);
        } else if (msg.type === 'control.cmd') {
          void this.handleControl(msg);
        }
      });
    });
  }

  private async handleCdpCmd(cmd: CdpCommandMessage): Promise<void> {
    const res = await this.bridge.handleCommand(cmd);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMessage(res));
    }
  }

  private async handleControl(cmd: ControlCommandMessage): Promise<void> {
    try {
      let tabs: ExtensionTabSummary[] | undefined;
      let mode: TabPolicyMode | undefined;
      if (cmd.action === 'detach_tab' && cmd.tabId !== undefined) {
        await this.bridge.detachTab(cmd.tabId, 'remote_control_detach');
        tabs = await this.bridge.getTabSummaries();
      } else if (cmd.action === 'attach_tab' && cmd.tabId !== undefined) {
        tabs = await this.bridge.authorizeTab(cmd.tabId, true);
      } else if (cmd.action === 'set_mode' && cmd.mode) {
        tabs = await this.bridge.setMode(cmd.mode);
        mode = cmd.mode;
      } else if (cmd.action === 'refresh_tabs') {
        tabs = await this.bridge.getTabSummaries();
        mode = this.bridge.getMode();
      }
      this.ws?.send(
        encodeMessage({
          type: 'control.res',
          id: cmd.id,
          ok: true,
          ...(tabs ? { tabs } : {}),
          ...(mode ? { mode } : {}),
        }),
      );
    } catch (err) {
      this.ws?.send(
        encodeMessage({
          type: 'control.res',
          id: cmd.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    const sock = this.ws;
    this.ws = null;
    if (sock.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      sock.once('close', () => resolve());
      sock.close();
    });
  }
}
