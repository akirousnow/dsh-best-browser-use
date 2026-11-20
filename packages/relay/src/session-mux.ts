import type { WebSocket } from 'ws';
import {
  encodeMessage,
  isValidCdpClientRequest,
  type CdpCommandMessage,
  type CdpEventMessage,
  type CdpResponseMessage,
} from '@agent-browser-bridge/protocol';

interface PendingCdpRequest {
  clientId: string;
  clientReqId: number;
  method: string;
  sessionId?: string;
  timer: ReturnType<typeof setTimeout>;
}

interface ClientTrackingState {
  ws: WebSocket;
  autoAttach: boolean;
  rootTargets: Set<string>;
  sessionToRootTarget: Map<string, string>;
  ownedSessions: Set<string>;
}

export interface SessionMuxOptions {
  commandTimeoutMs?: number;
  sendToExtension: (msg: CdpCommandMessage) => boolean;
}

/**
 * Multiplexes one or more local CDP clients (e.g. DSH, CLI, Playwright) onto the single
 * active Browser Extension WebSocket connection.
 *
 * Each CDP client keeps its own independent request ID space; SessionMux rewrites IDs into
 * a globally unique monotonic sequence for the extension, demultiplexes responses back, and
 * deduplicates root-level Target.attachedToTarget events per client so connecting a second
 * Playwright client never triggers "Duplicate target" assertions in an existing client.
 */
export class SessionMux {
  private readonly clients = new Map<string, ClientTrackingState>();
  private readonly pending = new Map<number, PendingCdpRequest>();
  private readonly sessionOwner = new Map<string, string>();
  private nextClientSeq = 1;
  private nextRelayReqId = 1;
  private readonly commandTimeoutMs: number;
  private readonly sendToExtension: (msg: CdpCommandMessage) => boolean;

  constructor(options: SessionMuxOptions) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
    this.sendToExtension = options.sendToExtension;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  addClient(ws: WebSocket): string {
    const clientId = `cdp-${this.nextClientSeq++}`;
    this.clients.set(clientId, {
      ws,
      autoAttach: false,
      rootTargets: new Set(),
      sessionToRootTarget: new Map(),
      ownedSessions: new Set(),
    });

    ws.on('message', (data) => {
      this.handleClientMessage(clientId, ws, data.toString('utf8'));
    });

    ws.on('close', () => {
      this.removeClient(clientId);
    });

    ws.on('error', () => {
      this.removeClient(clientId);
    });

    return clientId;
  }

  removeClient(clientId: string): void {
    const state = this.clients.get(clientId);
    if (state) {
      for (const sid of state.ownedSessions) {
        if (this.sessionOwner.get(sid) === clientId) {
          this.sessionOwner.delete(sid);
        }
      }
      this.clients.delete(clientId);
    }
    for (const [relayReqId, entry] of this.pending.entries()) {
      if (entry.clientId === clientId) {
        clearTimeout(entry.timer);
        this.pending.delete(relayReqId);
      }
    }
  }

  /** Forward a CDP command from an internal caller or raw CDP client JSON frame. */
  private handleClientMessage(clientId: string, ws: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendJson(ws, {
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    if (!isValidCdpClientRequest(parsed)) {
      this.sendJson(ws, {
        id:
          typeof parsed === 'object' && parsed !== null && 'id' in parsed
            ? (parsed as { id: unknown }).id
            : undefined,
        error: { code: -32600, message: 'Invalid CDP request: numeric id and string method required' },
      });
      return;
    }

    const clientState = this.clients.get(clientId);
    if (clientState && !parsed.sessionId && parsed.method === 'Target.setAutoAttach') {
      clientState.autoAttach = Boolean(parsed.params?.autoAttach);
    }

    // Intercept Browser.close when multiple clients are connected so one client disconnecting
    // does not detach tabs used by other agents.
    if (parsed.method === 'Browser.close' && this.clients.size > 1) {
      this.sendJson(ws, {
        id: parsed.id,
        result: {},
      });
      return;
    }

    const relayReqId = this.nextRelayReqId++;
    const cmd: CdpCommandMessage = {
      type: 'cdp.cmd',
      id: relayReqId,
      method: parsed.method,
      ...(parsed.params !== undefined ? { params: parsed.params } : {}),
      ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
    };

    const timer = setTimeout(() => {
      const entry = this.pending.get(relayReqId);
      if (!entry) return;
      this.pending.delete(relayReqId);
      const target = this.clients.get(entry.clientId);
      if (target) {
        this.sendJson(target.ws, {
          id: entry.clientReqId,
          ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
          error: {
            code: -32001,
            message: `CDP command "${entry.method}" timed out after ${this.commandTimeoutMs}ms`,
          },
        });
      }
    }, this.commandTimeoutMs);

    this.pending.set(relayReqId, {
      clientId,
      clientReqId: parsed.id,
      method: parsed.method,
      sessionId: parsed.sessionId,
      timer,
    });

    const sent = this.sendToExtension(cmd);
    if (!sent) {
      clearTimeout(timer);
      this.pending.delete(relayReqId);
      this.sendJson(ws, {
        id: parsed.id,
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
        error: {
          code: -32000,
          message:
            'Browser extension is not connected to the Relay Daemon. Open the Agent Browser Bridge extension popup in Chrome and click Connect.',
        },
      });
    }
  }

  /** Deliver a `cdp.res` frame from the Extension back to its originating CDP client. */
  handleExtensionResponse(msg: CdpResponseMessage): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.id);

    const client = this.clients.get(entry.clientId);
    if (!client) return;

    // Track browser-target sessions owned privately by one CDP client (e.g. Playwright newCDPSession)
    if (
      msg.error === undefined &&
      entry.method === 'Target.attachToBrowserTarget' &&
      typeof msg.result?.sessionId === 'string'
    ) {
      client.ownedSessions.add(msg.result.sessionId);
      this.sessionOwner.set(msg.result.sessionId, entry.clientId);
    }

    const sessionId = msg.sessionId ?? entry.sessionId;
    if (msg.error !== undefined) {
      this.sendJson(client.ws, {
        id: entry.clientReqId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        error: msg.error,
      });
    } else {
      this.sendJson(client.ws, {
        id: entry.clientReqId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        result: msg.result ?? {},
      });
    }
  }

  /** Broadcast a `cdp.evt` frame from the Extension to connected CDP clients with per-client target dedup. */
  broadcastExtensionEvent(msg: CdpEventMessage): void {
    const payload = JSON.stringify({
      method: msg.method,
      params: msg.params ?? {},
      ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
    });

    // Events scoped to a client-private browser session route only to that client.
    if (msg.sessionId !== undefined) {
      const ownerId = this.sessionOwner.get(msg.sessionId);
      if (ownerId !== undefined) {
        const owner = this.clients.get(ownerId);
        if (owner && owner.ws.readyState === owner.ws.OPEN) {
          owner.ws.send(payload);
        }
        return;
      }
    }

    // Deduplicate root-level Target.attachedToTarget per client so multi-client autoAttach
    // never trips Playwright's "Duplicate target" assertion on already-connected clients.
    if (msg.sessionId === undefined && msg.method === 'Target.attachedToTarget') {
      const targetInfo = msg.params?.targetInfo as { targetId?: unknown } | undefined;
      const targetId = typeof targetInfo?.targetId === 'string' ? targetInfo.targetId : undefined;
      const attachedSid = typeof msg.params?.sessionId === 'string' ? msg.params.sessionId : undefined;

      for (const client of this.clients.values()) {
        if (client.ws.readyState !== client.ws.OPEN) continue;
        if (targetId && client.rootTargets.has(targetId)) {
          continue;
        }
        if (targetId) {
          client.rootTargets.add(targetId);
          if (attachedSid) {
            client.sessionToRootTarget.set(attachedSid, targetId);
          }
        }
        client.ws.send(payload);
      }
      return;
    }

    if (msg.sessionId === undefined && msg.method === 'Target.detachedFromTarget') {
      const detachedSid = typeof msg.params?.sessionId === 'string' ? msg.params.sessionId : undefined;
      const explicitTargetId = typeof msg.params?.targetId === 'string' ? msg.params.targetId : undefined;
      for (const client of this.clients.values()) {
        const mappedTarget = detachedSid ? client.sessionToRootTarget.get(detachedSid) : undefined;
        const targetId = explicitTargetId ?? mappedTarget;
        if (detachedSid) client.sessionToRootTarget.delete(detachedSid);
        if (targetId) client.rootTargets.delete(targetId);
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.send(payload);
        }
      }
      return;
    }

    for (const client of this.clients.values()) {
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  /** Reject all in-flight CDP requests and reset client target tracking when extension disconnects. */
  failAllPending(reason: string): void {
    for (const client of this.clients.values()) {
      client.rootTargets.clear();
      client.sessionToRootTarget.clear();
      client.ownedSessions.clear();
    }
    this.sessionOwner.clear();

    for (const [relayReqId, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(relayReqId);
      const client = this.clients.get(entry.clientId);
      if (client) {
        this.sendJson(client.ws, {
          id: entry.clientReqId,
          ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
          error: { code: -32000, message: reason },
        });
      }
    }
  }

  /** Close all CDP client sockets cleanly during Relay shutdown. */
  closeAll(code = 1001, reason = 'Relay shutting down'): void {
    this.failAllPending(reason);
    for (const client of this.clients.values()) {
      try {
        client.ws.close(code, reason);
      } catch {
        // Ignore already-closed sockets.
      }
    }
    this.clients.clear();
  }

  private sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }
}

export { encodeMessage };
