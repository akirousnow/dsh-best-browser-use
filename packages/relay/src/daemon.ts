import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EXT_PATH,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
  type RelayStatusSnapshot,
} from '@agent-browser-bridge/protocol';

export interface DaemonStateRecord {
  pid: number;
  host: string;
  port: number;
  extPath: string;
  tokenRequired: boolean;
  cdpWsUrl: string;
  startedAt: number;
}

export interface DaemonOptions {
  host?: string;
  port?: number;
  extPath?: string;
  token?: string;
  stateDir?: string;
}

export function defaultStateDir(): string {
  return process.env.AGENT_BROWSER_BRIDGE_HOME ?? join(homedir(), '.agent-browser-bridge');
}

export function stateFilePath(port = DEFAULT_RELAY_PORT, stateDir = defaultStateDir()): string {
  return join(stateDir, `relay-${port}.json`);
}

export async function writeDaemonState(
  record: DaemonStateRecord,
  stateDir = defaultStateDir(),
): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const file = stateFilePath(record.port, stateDir);
  await writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  return file;
}

export async function readDaemonState(
  port = DEFAULT_RELAY_PORT,
  stateDir = defaultStateDir(),
): Promise<DaemonStateRecord | null> {
  try {
    const raw = await readFile(stateFilePath(port, stateDir), 'utf8');
    return JSON.parse(raw) as DaemonStateRecord;
  } catch {
    return null;
  }
}

export async function removeDaemonState(
  port = DEFAULT_RELAY_PORT,
  stateDir = defaultStateDir(),
): Promise<void> {
  try {
    await rm(stateFilePath(port, stateDir), { force: true });
  } catch {
    // Ignore.
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Probe a locally running Relay Daemon via GET http://127.0.0.1:<port>/status. */
export async function queryRelayStatus(
  port = DEFAULT_RELAY_PORT,
  timeoutMs = 1500,
): Promise<RelayStatusSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as RelayStatusSnapshot;
    return data && data.ok === true ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensure a Relay Daemon is running on `port`.
 * If already reachable via /status, returns it immediately without interrupting the extension.
 * Otherwise spawns a detached daemon process and waits until /status responds.
 */
export async function ensureRelayRunning(
  options: DaemonOptions = {},
  waitTimeoutMs = 5_000,
): Promise<RelayStatusSnapshot> {
  const port = options.port ?? DEFAULT_RELAY_PORT;
  const existing = await queryRelayStatus(port);
  if (existing) return existing;

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const binScript = join(currentDir, 'bin.js');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABB_RELAY_HOST: options.host ?? DEFAULT_RELAY_HOST,
    ABB_RELAY_PORT: String(port),
    ABB_RELAY_EXT_PATH: options.extPath ?? DEFAULT_EXT_PATH,
    ...(options.token ? { ABB_RELAY_TOKEN: options.token } : {}),
    ...(options.stateDir ? { AGENT_BROWSER_BRIDGE_HOME: options.stateDir } : {}),
  };

  const child = spawn(process.execPath, [binScript], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();

  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const status = await queryRelayStatus(port, 500);
    if (status) return status;
    await new Promise((r) => setTimeout(r, 120));
  }

  throw new Error(`Timed out waiting for Relay Daemon on 127.0.0.1:${port} to start`);
}

/** Stop a background Relay Daemon identified by its PID file. */
export async function stopRelayDaemon(
  port = DEFAULT_RELAY_PORT,
  stateDir = defaultStateDir(),
): Promise<{ stopped: boolean; pid?: number }> {
  const state = await readDaemonState(port, stateDir);
  if (!state) {
    return { stopped: false };
  }
  if (!isProcessAlive(state.pid)) {
    await removeDaemonState(port, stateDir);
    return { stopped: false, pid: state.pid };
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    await removeDaemonState(port, stateDir);
    return { stopped: false, pid: state.pid };
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) {
      await removeDaemonState(port, stateDir);
      return { stopped: true, pid: state.pid };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    process.kill(state.pid, 'SIGKILL');
  } catch {
    // Ignore.
  }
  await removeDaemonState(port, stateDir);
  return { stopped: true, pid: state.pid };
}
