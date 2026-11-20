import { spawn } from 'node:child_process';
import {
  DEFAULT_EXT_PATH,
  DEFAULT_RELAY_HOST,
  DEFAULT_RELAY_PORT,
} from '@agent-browser-bridge/protocol';
import {
  ensureRelayRunning,
  generateSecureToken,
  isLoopbackAddress,
  queryRelayStatus,
  RelayServer,
  removeDaemonState,
  stopRelayDaemon,
  writeDaemonState,
} from '@agent-browser-bridge/relay';
import {
  AGENT_BROWSER_INSTALL_HINT,
  probeAgentBrowser,
  resolveAgentBrowserBinary,
} from '@agent-browser-bridge/engine';

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_IO: CliIo = {
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
};

const DEFAULT_MCP_TOOLS = 'core,tabs';

function getFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

/** Everything after a literal `--`, or after the subcommand when no `--` is present. */
function passthroughArgs(argv: string[], startIndex: number): string[] {
  const marker = argv.indexOf('--', startIndex);
  if (marker !== -1) return argv.slice(marker + 1);
  const valueFlags = new Set(['--port', '--host', '--token', '--ext-path', '--tools', '--state-dir']);
  const out: string[] = [];
  for (let i = startIndex; i < argv.length; i++) {
    const item = argv[i]!;
    if (valueFlags.has(item)) {
      i++;
      continue;
    }
    if (item.startsWith('-')) continue;
    out.push(item);
  }
  return out;
}

export function formatHelpText(): string {
  return [
    'bb — Agent Browser Bridge CLI',
    '',
    'The bridge connects your everyday Chrome/Edge/Brave to agent-browser through a local Relay.',
    'All browser commands are delegated to `agent-browser` itself; this CLI only manages the',
    'Relay, prints the local CDP endpoint, and launches agent-browser against it.',
    '',
    'Relay:',
    '  bb daemon start [--host 127.0.0.1] [--port 9229] [--token <secret>] [--foreground]',
    '  bb daemon stop [--port 9229]',
    '  bb daemon status [--port 9229] [--json]',
    '  bb pair [--host 127.0.0.1] [--port 9229] [--wss] [--ext-path /ext] [--token <secret>]',
    '',
    'agent-browser integration:',
    '  bb cdp-url [--port 9229] [--json]      Print the local CDP WebSocket URL of the Relay',
    '  bb ab [--port 9229] [-- <args...>]     Run agent-browser against the bridged browser',
    '  bb mcp [--port 9229] [--tools core,tabs] [--headless] [-- <args...>]',
    '                                         Start agent-browser as an MCP server',
    '',
    'Examples:',
    '  bb daemon start && bb ab -- snapshot -i',
    '  bb ab -- tab list',
    '  bb ab -- open https://example.com',
    '  bb mcp --tools core,tabs',
    '  bb mcp --headless --tools all',
  ].join('\n');
}

/** Resolve the Relay CDP endpoint, or report why it is unavailable. */
async function resolveCdpUrl(
  port: number,
  io: CliIo,
): Promise<{ cdpWsUrl: string; relayId: string } | null> {
  const status = await queryRelayStatus(port, 1_500);
  if (!status) {
    io.stderr(
      `Relay Daemon is not running on 127.0.0.1:${port}. Start it with "bb daemon start" or install the DSH plugin, which manages one for you.`,
    );
    return null;
  }
  if (!status.extensionConnected) {
    io.stderr(
      `Relay Daemon is running on ${status.host}:${status.port}, but no browser extension is connected. Open the Agent Browser Bridge extension in Chrome/Edge/Brave and click Connect.`,
    );
    return null;
  }
  return { cdpWsUrl: status.cdpWsUrl, relayId: status.relayId };
}

async function requireBinary(io: CliIo): Promise<string | null> {
  const probe = await probeAgentBrowser();
  if (!probe.available || !probe.path) {
    io.stderr(probe.error ?? `agent-browser is not available. ${AGENT_BROWSER_INSTALL_HINT}`);
    return null;
  }
  return probe.path;
}

async function spawnInherit(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

export async function runCli(argv: string[], io: CliIo = DEFAULT_IO): Promise<number> {
  if (argv.length === 0 || hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    io.stdout(formatHelpText());
    return 0;
  }

  const cmd = argv[0];
  const port = Number(getFlag(argv, '--port') ?? process.env.ABB_RELAY_PORT ?? DEFAULT_RELAY_PORT);
  const host = getFlag(argv, '--host') ?? process.env.ABB_RELAY_HOST ?? DEFAULT_RELAY_HOST;
  const extPath = getFlag(argv, '--ext-path') ?? process.env.ABB_RELAY_EXT_PATH ?? DEFAULT_EXT_PATH;
  const token = getFlag(argv, '--token') ?? process.env.ABB_RELAY_TOKEN;
  const stateDir = getFlag(argv, '--state-dir');
  const jsonOutput = hasFlag(argv, '--json');

  if (cmd === 'daemon') {
    const sub = argv[1] ?? 'status';
    if (sub === 'status') {
      const status = await queryRelayStatus(port);
      if (!status) {
        if (jsonOutput) {
          io.stdout(JSON.stringify({ running: false, port }));
        } else {
          io.stdout(`Relay Daemon is not running on 127.0.0.1:${port}.`);
        }
        return 1;
      }
      if (jsonOutput) {
        io.stdout(JSON.stringify(status, null, 2));
      } else {
        io.stdout(`Relay Daemon: RUNNING (${status.host}:${status.port})`);
        io.stdout(
          `Extension:    ${status.extensionConnected ? `CONNECTED (${status.extension?.browserName ?? 'Chrome'})` : 'WAITING FOR EXTENSION'}`,
        );
        io.stdout(
          `Tabs:         ${status.tabs.filter((t) => t.authorized).length} authorized / ${status.tabs.filter((t) => t.attached).length} attached`,
        );
        io.stdout(`CDP Clients:  ${status.cdpClients}`);
        io.stdout(`CDP Endpoint: ${status.cdpWsUrl}`);
      }
      return 0;
    }

    if (sub === 'start') {
      if (hasFlag(argv, '--foreground')) {
        const server = new RelayServer({ host, port, extPath, token });
        const started = await server.start();
        await writeDaemonState(
          {
            pid: process.pid,
            host: started.host,
            port: started.port,
            extPath: server.extPath,
            tokenRequired: server.tokenRequired,
            cdpWsUrl: started.cdpWsUrl,
            startedAt: Date.now(),
          },
          stateDir,
        );
        io.stdout(`Relay listening on http://${started.host}:${started.port}${server.extPath}`);
        if (started.token && server.tokenAutoGenerated) {
          io.stdout(`Generated Token: ${started.token}`);
        }
        await new Promise<void>((resolve) => {
          const done = async () => {
            await server.stop();
            await removeDaemonState(started.port, stateDir);
            resolve();
          };
          process.once('SIGINT', () => void done());
          process.once('SIGTERM', () => void done());
        });
        return 0;
      }

      const status = await ensureRelayRunning({ host, port, extPath, token, stateDir });
      if (jsonOutput) {
        io.stdout(JSON.stringify(status, null, 2));
      } else {
        io.stdout(`Relay Daemon ready on ${status.host}:${status.port} (CDP: ${status.cdpWsUrl})`);
      }
      return 0;
    }

    if (sub === 'stop') {
      const res = await stopRelayDaemon(port, stateDir);
      if (jsonOutput) {
        io.stdout(JSON.stringify(res));
      } else {
        io.stdout(
          res.stopped
            ? `Stopped Relay Daemon (PID ${res.pid}).`
            : `No managed Relay Daemon found for port ${port}.`,
        );
      }
      return 0;
    }

    io.stderr(`Unknown daemon subcommand: ${sub}`);
    return 2;
  }

  if (cmd === 'pair') {
    const useWss = hasFlag(argv, '--wss');
    const isRemote = !isLoopbackAddress(host);
    const effectiveToken = token ?? (isRemote ? generateSecureToken(24) : '');
    const scheme = useWss ? 'wss' : 'ws';
    const wsUrl = `${scheme}://${host}:${port}${extPath}`;
    const payload = {
      host,
      port,
      path: extPath,
      useWss,
      token: effectiveToken,
      wsUrl,
      remote: isRemote,
    };

    if (jsonOutput) {
      io.stdout(JSON.stringify(payload, null, 2));
    } else {
      io.stdout('Agent Browser Bridge — Extension Pairing Settings');
      io.stdout('-------------------------------------------------');
      io.stdout(`Host / IP : ${host}`);
      io.stdout(`Port      : ${port}`);
      io.stdout(`Path      : ${extPath}`);
      io.stdout(`WSS       : ${useWss ? 'ON' : 'OFF'}`);
      io.stdout(`Token     : ${effectiveToken || '(optional on 127.0.0.1)'}`);
      io.stdout(`WS URL    : ${wsUrl}`);
      if (isRemote && !token) {
        io.stdout('');
        io.stdout(
          `Start Relay on the remote host with:\n  bb daemon start --host 0.0.0.0 --port ${port} --token ${effectiveToken}`,
        );
      }
    }
    return 0;
  }

  if (cmd === 'cdp-url') {
    const resolved = await resolveCdpUrl(port, io);
    if (!resolved) return 1;
    if (jsonOutput) {
      io.stdout(JSON.stringify({ cdpWsUrl: resolved.cdpWsUrl, relayId: resolved.relayId, port }, null, 2));
    } else {
      io.stdout(resolved.cdpWsUrl);
    }
    return 0;
  }

  if (cmd === 'ab') {
    const resolved = await resolveCdpUrl(port, io);
    if (!resolved) return 1;
    const binPath = await requireBinary(io);
    if (!binPath) return 1;
    const passthrough = passthroughArgs(argv, 1);
    if (passthrough.length === 0) {
      io.stderr('Usage: bb ab [--port 9229] [-- <agent-browser args...>]');
      return 2;
    }
    return await spawnInherit(binPath, ['--cdp', resolved.cdpWsUrl, ...passthrough]);
  }

  if (cmd === 'mcp') {
    const binPath = await requireBinary(io);
    if (!binPath) return 1;
    const tools = getFlag(argv, '--tools') ?? DEFAULT_MCP_TOOLS;
    const headless = hasFlag(argv, '--headless');
    const passthrough = passthroughArgs(argv, 1);
    const args = ['mcp', '--tools', tools, ...passthrough];

    if (headless) {
      return await spawnInherit(binPath, args);
    }

    const resolved = await resolveCdpUrl(port, io);
    if (!resolved) return 1;
    return await spawnInherit(binPath, args, {
      ...process.env,
      AGENT_BROWSER_CDP: resolved.cdpWsUrl,
    });
  }

  io.stderr(`Unknown command: ${cmd}. Run "bb --help" for usage.`);
  return 2;
}

/** Binary resolution is exported for tests and for future `bb` subcommands. */
export { resolveAgentBrowserBinary };
