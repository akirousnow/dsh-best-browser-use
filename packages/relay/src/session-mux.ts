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

export interface SessionMuxOptions {
  commandTimeoutMs?: number;
  sendToExtension: (msg: CdpCommandMessage) => boolean;
}

/**
 * Multiplexes one or more local CDP clients (e.g. DSH, CLI, Playwright) onto the single
 * active Browser Extension WebSocket connection.
 *
 * Each CDP client keeps its own independent request ID space; SessionMux rewrites IDs into
 * a globally unique monotonic sequence for the extension and demultiplexes responses back.
 */
export class SessionMux {
  private readonly clients = new Map<string, WebSocket>();
  private readonly pending = new Map<number, PendingCdpRequest>();
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
    this.clients.set(clientId, ws);

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
    this.clients.delete(clientId);
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
      const targetWs = this.clients.get(entry.clientId);
      if (targetWs) {
        this.sendJson(targetWs, {
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

    const ws = this.clients.get(entry.clientId);
    if (!ws) return;

    const sessionId = msg.sessionId ?? entry.sessionId;
    if (msg.error !== undefined) {
      this.sendJson(ws, {
        id: entry.clientReqId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        error: msg.error,
      });
    } else {
      this.sendJson(ws, {
        id: entry.clientReqId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        result: msg.result ?? {},
      });
    }
  }

  /** Broadcast a `cdp.evt` frame from the Extension to all connected CDP clients. */
  broadcastExtensionEvent(msg: CdpEventMessage): void {
    const payload = JSON.stringify({
      method: msg.method,
      params: msg.params ?? {},
      ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
    });
    for (const ws of this.clients.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Reject all in-flight CDP requests when the extension disconnects. */
  failAllPending(reason: string): void {
    for (const [relayReqId, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(relayReqId);
      const ws = this.clients.get(entry.clientId);
      if (ws) {
        this.sendJson(ws, {
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
    for (const ws of this.clients.values()) {
      try {
        ws.close(code, reason);
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
