import type {
  CdpCommandMessage,
  CdpEventMessage,
  CdpResponseMessage,
  CdpTargetInfo,
  ExtensionTabSummary,
  TabPolicyMode,
} from '@agent-browser-bridge/protocol';
import { isEligibleTabUrl, TabPolicy } from './tab-policy.js';

export interface ChromeTabLike {
  id?: number;
  windowId?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
}

export interface ChromeDebuggerTargetLike {
  tabId?: number;
  sessionId?: string;
}

/** Subset of `chrome.debugger.Debuggee` returned by `chrome.debugger.getTargets()`. */
export interface ChromeDebuggerTargetInfoLike {
  id: string;
  tabId?: number;
  type: string;
  title?: string;
  url?: string;
  attached?: boolean;
}

/** Minimal chrome.* API surface required by CdpBridge (injectable for unit testing). */
export interface ChromeBridgeApi {
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<ChromeTabLike[]>;
    get(tabId: number): Promise<ChromeTabLike>;
    create(createProperties: { url?: string; active?: boolean }): Promise<ChromeTabLike>;
    remove(tabId: number): Promise<void>;
    update(tabId: number, updateProperties: { active?: boolean }): Promise<ChromeTabLike>;
    onCreated: { addListener(cb: (tab: ChromeTabLike) => void): void };
    onUpdated: {
      addListener(
        cb: (tabId: number, changeInfo: Record<string, unknown>, tab: ChromeTabLike) => void,
      ): void;
    };
    onRemoved: { addListener(cb: (tabId: number) => void): void };
  };
  debugger: {
    attach(target: ChromeDebuggerTargetLike, requiredVersion: string): Promise<void>;
    detach(target: ChromeDebuggerTargetLike): Promise<void>;
    sendCommand(
      target: ChromeDebuggerTargetLike,
      method: string,
      commandParams?: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined>;
    /**
     * Optional `chrome.debugger.getTargets()`. When present, CdpBridge resolves the real
     * Chrome target id for every tab *before* attaching, so a freshly created tab never
     * exposes a synthetic `tab-<id>` target that later turns into a second, real target.
     */
    getTargets?(): Promise<ChromeDebuggerTargetInfoLike[]>;
    onEvent: {
      addListener(
        cb: (
          source: ChromeDebuggerTargetLike,
          method: string,
          params?: Record<string, unknown>,
        ) => void,
      ): void;
    };
    onDetach: {
      addListener(cb: (source: ChromeDebuggerTargetLike, reason: string) => void): void;
    };
  };
  userAgent?: string;
}

interface AttachedTabState {
  tabId: number;
  targetId: string;
  /**
   * Every CDP session currently attached to this tab. One tab is attached to
   * `chrome.debugger` once, but any number of CDP clients (each `agent-browser`
   * session, Playwright client, ...) can hold their own session id.
   */
  sessions: Set<string>;
  url: string;
  title: string;
  childSessions: Set<string>;
}

export interface CdpBridgeCallbacks {
  emitEvent: (evt: CdpEventMessage) => void;
  onTabsChanged?: (tabs: ExtensionTabSummary[], mode: TabPolicyMode) => void;
}

/**
 * Translates Browser-level CDP commands (`Target.*`, `Browser.*`) into `chrome.tabs`
 * + `chrome.debugger` calls, and forwards session-scoped CDP commands (including OOPIF
 * child sessions) to `chrome.debugger.sendCommand`.
 *
 * Multi-client model: one `chrome.debugger` attachment per tab, many CDP sessions per
 * attachment. Root-level tab events are fanned out to every live session of that tab,
 * and a session detaching only releases the debugger once the last session is gone.
 */
export class CdpBridge {
  private readonly api: ChromeBridgeApi;
  private readonly policy: TabPolicy;
  private readonly callbacks: CdpBridgeCallbacks;

  private readonly attachedByTabId = new Map<number, AttachedTabState>();
  private readonly sessionIdToTabId = new Map<string, number>();
  private readonly childSessionToTabId = new Map<string, number>();
  private readonly browserSessionIds = new Set<string>();
  private readonly tabIdToTargetId = new Map<number, string>();
  private readonly targetIdToTabId = new Map<string, number>();
  private readonly detachReasons = new Map<number, string>();
  private readonly knownTargets = new Map<number, CdpTargetInfo>();

  private nextSessionSeq = 1;
  private discoverTargets = false;
  private autoAttach = false;
  private autoAttachFlatten = true;
  private listenersBound = false;

  constructor(api: ChromeBridgeApi, policy: TabPolicy, callbacks: CdpBridgeCallbacks) {
    this.api = api;
    this.policy = policy;
    this.callbacks = callbacks;
  }

  bindListeners(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;

    this.api.debugger.onEvent.addListener((source, method, params) => {
      this.handleDebuggerEvent(source, method, params);
    });

    this.api.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== undefined) {
        this.handleDebuggerDetach(source.tabId, reason);
      }
    });

    this.api.tabs.onCreated.addListener((tab) => {
      void this.handleTabCreated(tab);
    });

    this.api.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
      void this.handleTabUpdated(tabId, tab);
    });

    this.api.tabs.onRemoved.addListener((tabId) => {
      void this.handleTabRemoved(tabId);
    });
  }

  static targetIdForTab(tabId: number): string {
    return `tab-${tabId}`;
  }

  static tabIdFromTargetId(targetId: string): number | null {
    if (!targetId.startsWith('tab-')) return null;
    const n = Number(targetId.slice(4));
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  private resolveTargetIdForTab(tabId: number): string {
    return this.tabIdToTargetId.get(tabId) ?? CdpBridge.targetIdForTab(tabId);
  }

  private resolveTabIdFromTargetId(targetId: string): number | null {
    const mapped = this.targetIdToTabId.get(targetId);
    if (mapped !== undefined) return mapped;
    return CdpBridge.tabIdFromTargetId(targetId);
  }

  private recordTargetIdMapping(tabId: number, targetId: string): void {
    const prev = this.tabIdToTargetId.get(tabId);
    if (prev && prev !== targetId) {
      this.targetIdToTabId.delete(prev);
    }
    this.tabIdToTargetId.set(tabId, targetId);
    this.targetIdToTabId.set(targetId, tabId);
  }

  /**
   * Refresh the tabId → real Chrome targetId map from `chrome.debugger.getTargets()`.
   * This never attaches a debugger; it only reads Chrome's target inventory.
   */
  private async refreshRealTargetIds(): Promise<boolean> {
    const getTargets = this.api.debugger.getTargets;
    if (typeof getTargets !== 'function') return false;

    let targets: ChromeDebuggerTargetInfoLike[] | undefined;
    try {
      targets = await getTargets.call(this.api.debugger);
    } catch {
      return false;
    }
    if (!Array.isArray(targets)) return false;

    for (const target of targets) {
      if (typeof target?.id !== 'string' || target.id.length === 0) continue;
      if (typeof target.tabId !== 'number') continue;
      if (target.type !== 'page') continue;
      this.recordTargetIdMapping(target.tabId, target.id);
    }
    return true;
  }

  getMode(): TabPolicyMode {
    return this.policy.getMode();
  }

  async setMode(mode: TabPolicyMode): Promise<ExtensionTabSummary[]> {
    this.policy.setMode(mode);
    if (mode === 'manual') {
      // Detach any tabs that are not explicitly authorized in manual mode.
      const tabs = await this.safeQueryTabs();
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        if (!this.policy.isAuthorized(tab.id, this.resolveTabUrl(tab)) && this.attachedByTabId.has(tab.id)) {
          await this.detachTab(tab.id, 'mode_switched_to_manual');
        }
      }
    } else if (this.autoAttach) {
      await this.attachAllAuthorizedTabs();
    }
    const summaries = await this.getTabSummaries();
    this.callbacks.onTabsChanged?.(summaries, mode);
    return summaries;
  }

  async authorizeTab(tabId: number, attachNow = true): Promise<ExtensionTabSummary[]> {
    this.policy.authorizeTab(tabId);
    this.detachReasons.delete(tabId);
    if (attachNow) {
      await this.tryAttachTab(tabId);
    }
    const summaries = await this.getTabSummaries();
    this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
    return summaries;
  }

  async revokeTab(tabId: number): Promise<ExtensionTabSummary[]> {
    this.policy.revokeTab(tabId);
    await this.detachTab(tabId, 'user_revoked');
    const summaries = await this.getTabSummaries();
    this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
    return summaries;
  }

  /** Force-release every CDP session on one tab (user clicked Detach, or the tab is closing). */
  async detachTab(tabId: number, reason = 'user_detached'): Promise<void> {
    const state = this.attachedByTabId.get(tabId);
    if (!state) return;
    try {
      await this.api.debugger.detach({ tabId });
    } catch {
      // Tab may already be detached or closed.
    }
    this.cleanupAttachedTab(tabId, reason);
  }

  async detachAll(reason = 'bridge_disconnect'): Promise<void> {
    const tabIds = [...this.attachedByTabId.keys()];
    for (const tabId of tabIds) {
      await this.detachTab(tabId, reason);
    }
  }

  async getTabSummaries(): Promise<ExtensionTabSummary[]> {
    await this.refreshRealTargetIds();
    const tabs = await this.safeQueryTabs();
    const out: ExtensionTabSummary[] = [];
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const url = this.resolveTabUrl(tab);
      const eligible = isEligibleTabUrl(url);
      const authorized = this.policy.isAuthorized(tab.id, url);
      const attached = this.attachedByTabId.get(tab.id);
      const primarySessionId = attached ? attached.sessions.values().next().value : undefined;
      out.push({
        tabId: tab.id,
        targetId: this.resolveTargetIdForTab(tab.id),
        windowId: tab.windowId,
        url,
        title: tab.title ?? '',
        active: Boolean(tab.active),
        attached: attached !== undefined,
        eligible,
        authorized,
        ...(primarySessionId !== undefined ? { sessionId: primarySessionId } : {}),
        ...(this.detachReasons.has(tab.id) ? { detachReason: this.detachReasons.get(tab.id) } : {}),
      });
    }
    return out;
  }

  /** Handle an incoming CDP command from the Relay Daemon. */
  async handleCommand(cmd: CdpCommandMessage): Promise<CdpResponseMessage> {
    try {
      if (cmd.sessionId && !this.browserSessionIds.has(cmd.sessionId)) {
        return await this.handleSessionCommand(cmd);
      }
      const result = await this.handleBrowserCommand(cmd.method, cmd.params ?? {}, cmd.sessionId);
      return {
        type: 'cdp.res',
        id: cmd.id,
        ...(cmd.sessionId ? { sessionId: cmd.sessionId } : {}),
        result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: 'cdp.res',
        id: cmd.id,
        ...(cmd.sessionId ? { sessionId: cmd.sessionId } : {}),
        error: { code: -32000, message },
      };
    }
  }

  private async handleBrowserCommand(
    method: string,
    params: Record<string, unknown>,
    parentSessionId?: string,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case 'Browser.getVersion': {
        const ua =
          this.api.userAgent ??
          (typeof navigator !== 'undefined' ? navigator.userAgent : 'Mozilla/5.0 Chrome/131.0.0.0');
        return {
          protocolVersion: '1.3',
          product: 'Chrome/131.0.0.0',
          revision: '@agent-browser-bridge',
          userAgent: ua,
          jsVersion: '13.1',
        };
      }

      case 'Browser.getWindowForTarget': {
        const targetId = typeof params.targetId === 'string' ? params.targetId : undefined;
        const tabId = targetId ? this.resolveTabIdFromTargetId(targetId) : null;
        let windowId = 1;
        if (tabId !== null) {
          try {
            const tab = await this.api.tabs.get(tabId);
            if (tab.windowId !== undefined) windowId = tab.windowId;
          } catch {
            // Fall back to default windowId.
          }
        }
        return {
          windowId,
          bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' },
        };
      }

      case 'Browser.close': {
        // NEVER close the user's real browser! Detach debugging sessions cleanly instead.
        this.browserSessionIds.clear();
        await this.detachAll('browser_close_requested');
        const summaries = await this.getTabSummaries();
        this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
        return {};
      }

      case 'Target.attachToBrowserTarget': {
        const sessionId = `abb-b-${this.nextSessionSeq++}`;
        this.browserSessionIds.add(sessionId);
        return { sessionId };
      }

      case 'Target.getBrowserContexts': {
        return { browserContextIds: [] };
      }

      case 'Target.setDiscoverTargets': {
        this.discoverTargets = Boolean(params.discover);
        if (this.discoverTargets) {
          const infos = await this.listAuthorizedTargetInfos();
          for (const targetInfo of infos) {
            this.callbacks.emitEvent({
              type: 'cdp.evt',
              method: 'Target.targetCreated',
              params: { targetInfo },
              ...(parentSessionId ? { sessionId: parentSessionId } : {}),
            });
          }
        }
        return {};
      }

      case 'Target.getTargets': {
        const targetInfos = await this.listAuthorizedTargetInfos();
        return { targetInfos };
      }

      case 'Target.getTargetInfo': {
        const targetId = typeof params.targetId === 'string' ? params.targetId.trim() : '';
        if (!targetId || targetId === 'browser') {
          // Browser-level Target.getTargetInfo (sent without targetId by some CDP clients).
          return {
            targetInfo: {
              targetId: 'browser',
              type: 'browser',
              title: '',
              url: '',
              attached: true,
              canAccessOpener: false,
            },
          };
        }
        const tabId = this.resolveTabIdFromTargetId(targetId);
        if (tabId === null) {
          throw new Error(`Unknown targetId: ${targetId}`);
        }
        const tab = await this.api.tabs.get(tabId);
        return { targetInfo: this.buildTargetInfo(tab) };
      }

      case 'Target.setAutoAttach': {
        this.autoAttach = Boolean(params.autoAttach);
        this.autoAttachFlatten = params.flatten !== false;
        if (this.autoAttach) {
          await this.attachAllAuthorizedTabs();
        }
        return {};
      }

      case 'Target.attachToTarget': {
        const targetId = typeof params.targetId === 'string' ? params.targetId : '';
        const tabId = this.resolveTabIdFromTargetId(targetId);
        if (tabId === null) {
          throw new Error(`Invalid targetId: "${targetId}"`);
        }
        const alreadyAttached = this.attachedByTabId.has(tabId);
        const state = await this.attachTabOrThrow(tabId);
        let sessionId = state.sessions.values().next().value as string | undefined;
        if (alreadyAttached || sessionId === undefined) {
          // Allocate a distinct alias sessionId (e.g. for a second agent-browser session)
          // so multiple CDP sessions on the same tab never collide or detach each other.
          sessionId = `abb-s-${this.nextSessionSeq++}`;
          state.sessions.add(sessionId);
          this.sessionIdToTabId.set(sessionId, tabId);
        }
        const tab = await this.api.tabs.get(tabId);
        const targetInfo = this.buildTargetInfo(tab);
        if (params.flatten !== false) {
          this.callbacks.emitEvent({
            type: 'cdp.evt',
            method: 'Target.attachedToTarget',
            params: {
              sessionId,
              targetInfo,
              waitingForDebugger: false,
            },
            ...(parentSessionId ? { sessionId: parentSessionId } : {}),
          });
        }
        const summaries = await this.getTabSummaries();
        this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
        return { sessionId };
      }

      case 'Target.detachFromTarget': {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
        const targetId = typeof params.targetId === 'string' ? params.targetId : undefined;
        if (sessionId && this.browserSessionIds.has(sessionId)) {
          this.browserSessionIds.delete(sessionId);
          return {};
        }
        let tabId: number | undefined;
        if (sessionId) {
          tabId = this.sessionIdToTabId.get(sessionId);
          if (tabId !== undefined) {
            const state = this.attachedByTabId.get(tabId);
            if (state && state.sessions.has(sessionId)) {
              state.sessions.delete(sessionId);
              this.sessionIdToTabId.delete(sessionId);
              this.callbacks.emitEvent({
                type: 'cdp.evt',
                method: 'Target.detachedFromTarget',
                params: { sessionId, targetId: state.targetId },
                ...(parentSessionId ? { sessionId: parentSessionId } : {}),
              });
              if (state.sessions.size === 0) {
                // Last session for this tab: release the chrome.debugger attachment.
                await this.detachTab(tabId, 'cdp_detach');
              }
              const summaries = await this.getTabSummaries();
              this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
              return {};
            }
          }
        } else if (targetId) {
          tabId = this.resolveTabIdFromTargetId(targetId) ?? undefined;
        }
        if (tabId !== undefined) {
          await this.detachTab(tabId, 'cdp_detach');
          const summaries = await this.getTabSummaries();
          this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
        }
        return {};
      }

      case 'Target.createTarget': {
        const url = typeof params.url === 'string' && params.url.length > 0 ? params.url : 'about:blank';
        // Background silent by default unless caller explicitly sets background: false.
        const active = params.background === false;
        const created = await this.api.tabs.create({ url, active });
        if (created.id === undefined) {
          throw new Error('Failed to create browser tab');
        }
        // Resolve Chrome's real targetId before answering so callers never see a synthetic id.
        await this.refreshRealTargetIds();
        // Always authorize tabs created by the Agent itself, even in manual mode.
        this.policy.authorizeTab(created.id);
        if (this.autoAttach) {
          // Attach BEFORE returning targetId so Chrome's real targetId is resolved and matches
          // the Target.attachedToTarget event the CDP client expects.
          await this.tryAttachTab(created.id, true);
        }
        const targetInfo = this.buildTargetInfo(created);
        this.knownTargets.set(created.id, targetInfo);
        if (this.discoverTargets) {
          this.callbacks.emitEvent({
            type: 'cdp.evt',
            method: 'Target.targetCreated',
            params: { targetInfo },
          });
        }
        const summaries = await this.getTabSummaries();
        this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
        return { targetId: targetInfo.targetId };
      }

      case 'Target.closeTarget': {
        const targetId = typeof params.targetId === 'string' ? params.targetId : '';
        const tabId = this.resolveTabIdFromTargetId(targetId);
        if (tabId === null) {
          return { success: false };
        }
        if (this.attachedByTabId.has(tabId)) {
          await this.detachTab(tabId, 'target_closed');
        }
        await this.api.tabs.remove(tabId);
        this.policy.pruneClosedTab(tabId);
        this.knownTargets.delete(tabId);
        const mappedTarget = this.tabIdToTargetId.get(tabId);
        if (mappedTarget) {
          this.tabIdToTargetId.delete(tabId);
          this.targetIdToTabId.delete(mappedTarget);
        }
        const summaries = await this.getTabSummaries();
        this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
        return { success: true };
      }

      case 'Target.activateTarget': {
        const targetId = typeof params.targetId === 'string' ? params.targetId : '';
        const tabId = this.resolveTabIdFromTargetId(targetId);
        if (tabId === null) {
          throw new Error(`Invalid targetId: "${targetId}"`);
        }
        await this.api.tabs.update(tabId, { active: true });
        return {};
      }

      case 'Browser.setDownloadBehavior':
      case 'Browser.cancelDownload':
      case 'Browser.setWindowBounds':
      case 'Browser.grantPermissions':
      case 'Browser.resetPermissions':
      case 'Target.setRemoteLocations':
      case 'Target.exposeDevToolsProtocol':
      case 'Target.disposeBrowserContext':
      case 'Storage.clearCookies':
      case 'Storage.setCookies': {
        // Safe no-op shims for browser-level commands CDP clients may issue.
        return {};
      }

      case 'Storage.getCookies': {
        return { cookies: [] };
      }

      default:
        throw new Error(`Unsupported browser-level CDP method: ${method}`);
    }
  }

  private async handleSessionCommand(cmd: CdpCommandMessage): Promise<CdpResponseMessage> {
    const sessionId = cmd.sessionId!;
    const rootTabId = this.sessionIdToTabId.get(sessionId);
    const childRootTabId = rootTabId === undefined ? this.childSessionToTabId.get(sessionId) : undefined;

    if (rootTabId === undefined && childRootTabId === undefined) {
      return {
        type: 'cdp.res',
        id: cmd.id,
        sessionId,
        error: {
          code: -32001,
          message: `Session "${sessionId}" is not attached (tab may have been closed or DevTools took over)`,
        },
      };
    }

    const debuggee: ChromeDebuggerTargetLike =
      childRootTabId !== undefined
        ? { tabId: childRootTabId, sessionId }
        : { tabId: rootTabId! };

    // Handle Target.detachFromTarget scoped to a child session
    if (cmd.method === 'Target.detachFromTarget' && typeof cmd.params?.sessionId === 'string') {
      const targetChild = cmd.params.sessionId;
      this.childSessionToTabId.delete(targetChild);
    }

    const result = await this.api.debugger.sendCommand(debuggee, cmd.method, cmd.params);
    return {
      type: 'cdp.res',
      id: cmd.id,
      sessionId,
      result: result ?? {},
    };
  }

  private handleDebuggerEvent(
    source: ChromeDebuggerTargetLike,
    method: string,
    params?: Record<string, unknown>,
  ): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const state = this.attachedByTabId.get(tabId);
    if (!state) return;

    // Track OOPIF / iframe child sessions created by Chrome's Target.setAutoAttach inside a tab.
    if (method === 'Target.attachedToTarget' && typeof params?.sessionId === 'string') {
      const childSid = params.sessionId;
      state.childSessions.add(childSid);
      this.childSessionToTabId.set(childSid, tabId);
    } else if (method === 'Target.detachedFromTarget' && typeof params?.sessionId === 'string') {
      const childSid = params.sessionId;
      state.childSessions.delete(childSid);
      this.childSessionToTabId.delete(childSid);
    }

    // Child-session events belong to exactly that child session; root events are shared by
    // every CDP session attached to this tab so a second client never goes blind.
    const outgoingSessionIds = source.sessionId !== undefined ? [source.sessionId] : [...state.sessions];
    for (const outgoingSessionId of outgoingSessionIds) {
      this.callbacks.emitEvent({
        type: 'cdp.evt',
        method,
        params: params ?? {},
        sessionId: outgoingSessionId,
      });
    }
  }

  private handleDebuggerDetach(tabId: number, reason: string): void {
    // Pitfall #2: User opening F12 DevTools fires onDetach with reason === 'replaced_with_devtools'.
    // Never crash the extension connection — mark just this tab as detached and emit Target.detachedFromTarget.
    this.cleanupAttachedTab(tabId, reason);
    void this.getTabSummaries().then((summaries) => {
      this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
    });
  }

  private cleanupAttachedTab(tabId: number, reason: string): void {
    const state = this.attachedByTabId.get(tabId);
    if (!state) return;

    this.attachedByTabId.delete(tabId);
    for (const sessionId of state.sessions) {
      this.sessionIdToTabId.delete(sessionId);
      this.callbacks.emitEvent({
        type: 'cdp.evt',
        method: 'Target.detachedFromTarget',
        params: { sessionId, targetId: state.targetId },
      });
    }
    state.sessions.clear();
    for (const childSid of state.childSessions) {
      this.childSessionToTabId.delete(childSid);
      this.callbacks.emitEvent({
        type: 'cdp.evt',
        method: 'Target.detachedFromTarget',
        params: { sessionId: childSid },
      });
    }
    state.childSessions.clear();
    this.detachReasons.set(tabId, reason);
  }

  private async handleTabCreated(tab: ChromeTabLike): Promise<void> {
    if (tab.id === undefined) return;
    await this.refreshRealTargetIds();
    const url = this.resolveTabUrl(tab);
    if (!this.policy.isAuthorized(tab.id, url)) {
      const summaries = await this.getTabSummaries();
      this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
      return;
    }
    const targetInfo = this.buildTargetInfo(tab);
    this.knownTargets.set(tab.id, targetInfo);
    if (this.discoverTargets) {
      this.callbacks.emitEvent({
        type: 'cdp.evt',
        method: 'Target.targetCreated',
        params: { targetInfo },
      });
    }
    if (this.autoAttach) {
      await this.tryAttachTab(tab.id, true);
    }
    const summaries = await this.getTabSummaries();
    this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
  }

  private async handleTabUpdated(tabId: number, tab: ChromeTabLike): Promise<void> {
    const url = this.resolveTabUrl(tab);
    const authorized = this.policy.isAuthorized(tabId, url);
    if (!authorized) {
      if (this.attachedByTabId.has(tabId)) {
        await this.detachTab(tabId, 'navigated_to_restricted_url');
      }
      if (this.knownTargets.has(tabId)) {
        const prev = this.knownTargets.get(tabId)!;
        this.knownTargets.delete(tabId);
        if (this.discoverTargets) {
          this.callbacks.emitEvent({
            type: 'cdp.evt',
            method: 'Target.targetDestroyed',
            params: { targetId: prev.targetId },
          });
        }
      }
      const summaries = await this.getTabSummaries();
      this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
      return;
    }

    const targetInfo = this.buildTargetInfo(tab);
    const existed = this.knownTargets.has(tabId);
    this.knownTargets.set(tabId, targetInfo);

    const attached = this.attachedByTabId.get(tabId);
    if (attached) {
      attached.url = targetInfo.url;
      attached.title = targetInfo.title;
    }

    if (this.discoverTargets) {
      this.callbacks.emitEvent({
        type: 'cdp.evt',
        method: existed ? 'Target.targetInfoChanged' : 'Target.targetCreated',
        params: { targetInfo },
      });
    }

    if (this.autoAttach && !this.attachedByTabId.has(tabId)) {
      const prevReason = this.detachReasons.get(tabId);
      // Do not immediately fight the user if they explicitly detached or opened DevTools.
      if (prevReason !== 'user_detached' && prevReason !== 'user_revoked' && prevReason !== 'replaced_with_devtools') {
        await this.tryAttachTab(tabId, true);
      }
    }

    const summaries = await this.getTabSummaries();
    this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
  }

  private async handleTabRemoved(tabId: number): Promise<void> {
    this.policy.pruneClosedTab(tabId);
    this.detachReasons.delete(tabId);
    if (this.attachedByTabId.has(tabId)) {
      this.cleanupAttachedTab(tabId, 'tab_closed');
    }
    const mappedTarget = this.tabIdToTargetId.get(tabId);
    if (mappedTarget) {
      this.tabIdToTargetId.delete(tabId);
      this.targetIdToTabId.delete(mappedTarget);
    }
    const prev = this.knownTargets.get(tabId);
    if (prev) {
      this.knownTargets.delete(tabId);
      if (this.discoverTargets) {
        this.callbacks.emitEvent({
          type: 'cdp.evt',
          method: 'Target.targetDestroyed',
          params: { targetId: prev.targetId },
        });
      }
    }
    const summaries = await this.getTabSummaries();
    this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
  }

  private async attachAllAuthorizedTabs(): Promise<void> {
    await this.refreshRealTargetIds();
    const tabs = await this.safeQueryTabs();
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      if (!this.policy.isAuthorized(tab.id, this.resolveTabUrl(tab))) continue;
      // Swallow per-tab errors (Pitfall #4: privileged/DevTools tab must never break list/attachAll)
      await this.tryAttachTab(tab.id, true);
    }
    const summaries = await this.getTabSummaries();
    this.callbacks.onTabsChanged?.(summaries, this.policy.getMode());
  }

  async tryAttachTab(tabId: number, emitAttachedEvent = true): Promise<AttachedTabState | null> {
    try {
      const state = await this.attachTabOrThrow(tabId);
      if (emitAttachedEvent && this.autoAttachFlatten) {
        const tab = await this.api.tabs.get(tabId);
        const sessionId = state.sessions.values().next().value;
        if (sessionId !== undefined) {
          this.callbacks.emitEvent({
            type: 'cdp.evt',
            method: 'Target.attachedToTarget',
            params: {
              sessionId,
              targetInfo: this.buildTargetInfo(tab),
              waitingForDebugger: false,
            },
          });
        }
      }
      return state;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.detachReasons.set(tabId, `attach_failed: ${msg}`);
      return null;
    }
  }

  private async attachTabOrThrow(tabId: number): Promise<AttachedTabState> {
    const existing = this.attachedByTabId.get(tabId);
    if (existing) return existing;

    const tab = await this.api.tabs.get(tabId);
    const url = this.resolveTabUrl(tab);
    if (!isEligibleTabUrl(url)) {
      throw new Error(`Tab ${tabId} URL "${url}" is a restricted browser page and cannot be debugged`);
    }
    if (!this.policy.isAuthorized(tabId, url)) {
      throw new Error(`Tab ${tabId} is not authorized in current "${this.policy.getMode()}" mode`);
    }

    await this.api.debugger.attach({ tabId }, '1.3');

    // Query Chrome's real targetId so Target.attachedToTarget matches Page.getFrameTree().frameTree.frame.id.
    const previousTargetId = this.resolveTargetIdForTab(tabId);
    let targetId = previousTargetId;
    try {
      const infoRes = await this.api.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
      const realId = (infoRes?.targetInfo as { targetId?: unknown } | undefined)?.targetId;
      if (typeof realId === 'string' && realId.length > 0) {
        targetId = realId;
        this.recordTargetIdMapping(tabId, realId);
      }
    } catch {
      // Keep the current mapping when running against a minimal mock.
    }

    if (targetId !== previousTargetId) {
      // The synthetic `tab-<id>` placeholder became a real Chrome target: retire the
      // placeholder so discovery clients never list the same tab twice.
      const previousKnown = this.knownTargets.get(tabId);
      if (previousKnown) {
        this.knownTargets.delete(tabId);
        if (this.discoverTargets) {
          this.callbacks.emitEvent({
            type: 'cdp.evt',
            method: 'Target.targetDestroyed',
            params: { targetId: previousTargetId },
          });
        }
      }
      if (this.discoverTargets) {
        this.callbacks.emitEvent({
          type: 'cdp.evt',
          method: 'Target.targetCreated',
          params: { targetInfo: this.buildTargetInfo(tab) },
        });
      }
    }

    const sessionId = `abb-s-${this.nextSessionSeq++}`;
    const state: AttachedTabState = {
      tabId,
      targetId,
      sessions: new Set([sessionId]),
      url,
      title: tab.title ?? '',
      childSessions: new Set(),
    };
    this.attachedByTabId.set(tabId, state);
    this.sessionIdToTabId.set(sessionId, tabId);
    this.detachReasons.delete(tabId);
    return state;
  }

  private async listAuthorizedTargetInfos(): Promise<CdpTargetInfo[]> {
    await this.refreshRealTargetIds();
    const tabs = await this.safeQueryTabs();
    const out: CdpTargetInfo[] = [];
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      if (!this.policy.isAuthorized(tab.id, this.resolveTabUrl(tab))) continue;
      const info = this.buildTargetInfo(tab);
      this.knownTargets.set(tab.id, info);
      out.push(info);
    }
    return out;
  }

  private buildTargetInfo(tab: ChromeTabLike): CdpTargetInfo {
    const tabId = tab.id ?? 0;
    return {
      targetId: this.resolveTargetIdForTab(tabId),
      type: 'page',
      title: tab.title ?? '',
      url: this.resolveTabUrl(tab),
      attached: this.attachedByTabId.has(tabId),
      canAccessOpener: false,
      browserContextId: 'default',
    };
  }

  private resolveTabUrl(tab: ChromeTabLike): string {
    return tab.url || tab.pendingUrl || '';
  }

  private async safeQueryTabs(): Promise<ChromeTabLike[]> {
    try {
      return await this.api.tabs.query({});
    } catch {
      return [];
    }
  }
}
