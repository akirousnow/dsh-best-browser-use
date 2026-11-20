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
  stopRelayDaemon,
  writeDaemonState,
  removeDaemonState,
} from '@agent-browser-bridge/relay';
import { BrowserEngine } from '@agent-browser-bridge/engine';

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_IO: CliIo = {
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
};

function getFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  const valueFlags = new Set([
    '--host',
    '--port',
    '--token',
    '--ext-path',
    '--tab',
    '--ref',
    '--text',
    '--text-gone',
    '--ms',
    '--timeout',
    '--prompt',
    '--quality',
    '--select',
    '--state-dir',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]!;
    if (valueFlags.has(item)) {
      i++;
      continue;
    }
    if (item.startsWith('--')) continue;
    out.push(item);
  }
  return out;
}

export function formatHelpText(): string {
  return [
    'bb — Agent Browser Bridge CLI',
    '',
    'Daemon & Pairing:',
    '  bb daemon start [--host 127.0.0.1] [--port 9229] [--token <secret>] [--foreground]',
    '  bb daemon stop [--port 9229]',
    '  bb daemon status [--port 9229] [--json]',
    '  bb pair [--host 127.0.0.1] [--port 9229] [--wss] [--ext-path /ext] [--token <secret>]',
    '',
    'Browser Actions (auto-connects to local Relay Daemon):',
    '  bb tabs [--select $t1]',
    '  bb new-tab [url] [--foreground]',
    '  bb close-tab [$t1]',
    '  bb snapshot [--tab $t1]',
    '  bb screenshot [--tab $t1] [--full-page] [--quality 75]',
    '  bb navigate <url|back|forward|reload> [--tab $t1]',
    '  bb click <ref> [--tab $t1] [--double]',
    '  bb hover <ref> [--tab $t1]',
    '  bb fill <ref> <value> [--tab $t1]',
    '  bb fill-form <json> [--tab $t1]',
    '  bb type <text> [--ref e1] [--submit] [--tab $t1]',
    '  bb press <key> [--ref e1] [--tab $t1]',
    '  bb wait [--text <str>] [--text-gone <str>] [--ms <n>] [--tab $t1]',
    '  bb dialog <accept|dismiss> [--prompt <text>] [--tab $t1]',
    '  bb upload <ref> <file1> [file2...] [--tab $t1]',
  ].join('\n');
}

export async function runCli(
  argv: string[],
  io: CliIo = DEFAULT_IO,
  injectedEngine?: BrowserEngine,
): Promise<number> {
  if (argv.length === 0 || hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    io.stdout(formatHelpText());
    return 0;
  }

  const pos = positionalArgs(argv);
  const cmd = pos[0];
  const port = Number(getFlag(argv, '--port') ?? process.env.ABB_RELAY_PORT ?? DEFAULT_RELAY_PORT);
  const host = getFlag(argv, '--host') ?? process.env.ABB_RELAY_HOST ?? DEFAULT_RELAY_HOST;
  const extPath = getFlag(argv, '--ext-path') ?? process.env.ABB_RELAY_EXT_PATH ?? DEFAULT_EXT_PATH;
  const token = getFlag(argv, '--token') ?? process.env.ABB_RELAY_TOKEN;
  const stateDir = getFlag(argv, '--state-dir');
  const jsonOutput = hasFlag(argv, '--json');

  if (cmd === 'daemon') {
    const sub = pos[1] ?? 'status';
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
        io.stdout(`Extension:    ${status.extensionConnected ? `CONNECTED (${status.extension?.browserName ?? 'Chrome'})` : 'WAITING FOR EXTENSION'}`);
        io.stdout(`Tabs:         ${status.tabs.filter((t) => t.authorized).length} authorized / ${status.tabs.filter((t) => t.attached).length} attached`);
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
        io.stdout(res.stopped ? `Stopped Relay Daemon (PID ${res.pid}).` : `No managed Relay Daemon found for port ${port}.`);
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
        io.stdout(`Start Relay on the remote host with:\n  bb daemon start --host 0.0.0.0 --port ${port} --token ${effectiveToken}`);
      }
    }
    return 0;
  }

  const readOnly = hasFlag(argv, '--read-only');
  const engine =
    injectedEngine ??
    new BrowserEngine({
      relayPort: port,
      autoStartRelay: !hasFlag(argv, '--no-auto-relay'),
      security: { readOnly },
    });

  const tabId = getFlag(argv, '--tab');

  try {
    switch (cmd) {
      case 'tabs': {
        const res = await engine.browserTabs({ selectTabId: getFlag(argv, '--select') });
        if (jsonOutput) {
          io.stdout(JSON.stringify(res, null, 2));
        } else {
          for (const t of res.tabs) {
            io.stdout(`${t.active ? '*' : ' '} ${t.tabId}  ${t.title || '(untitled)'}  —  ${t.url}`);
          }
        }
        return 0;
      }
      case 'new-tab': {
        const res = await engine.browserNewTab({
          url: pos[1],
          background: !hasFlag(argv, '--foreground'),
        });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : `${res.tabId} ${res.url}\n\n${res.snapshotText}`);
        return 0;
      }
      case 'close-tab': {
        const res = await engine.browserCloseTab({ tabId: pos[1] ?? tabId });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : `Closed ${res.closedTabId}`);
        return 0;
      }
      case 'snapshot': {
        const res = await engine.browserSnapshot({ tabId: pos[1] ?? tabId });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.text);
        return 0;
      }
      case 'screenshot': {
        const qualityStr = getFlag(argv, '--quality');
        const res = await engine.browserScreenshot({
          tabId: pos[1] ?? tabId,
          fullPage: hasFlag(argv, '--full-page'),
          quality: qualityStr ? Number(qualityStr) : undefined,
        });
        io.stdout(
          jsonOutput
            ? JSON.stringify({ ...res, base64: undefined }, null, 2)
            : `Saved screenshot (${res.width}x${res.height}, ${res.bytes} bytes): ${res.filePath}`,
        );
        return 0;
      }
      case 'navigate': {
        const target = pos[1];
        if (!target) {
          io.stderr('Usage: bb navigate <url|back|forward|reload>');
          return 2;
        }
        const isAction = target === 'back' || target === 'forward' || target === 'reload';
        const res = await engine.browserNavigate({
          tabId,
          action: isAction ? target : 'goto',
          url: isAction ? undefined : target,
        });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.snapshotText);
        return 0;
      }
      case 'click': {
        const ref = pos[1];
        if (!ref) {
          io.stderr('Usage: bb click <ref>');
          return 2;
        }
        const res = await engine.browserClick({ tabId, ref, doubleClick: hasFlag(argv, '--double') });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.diff.text);
        return 0;
      }
      case 'hover': {
        const ref = pos[1];
        if (!ref) {
          io.stderr('Usage: bb hover <ref>');
          return 2;
        }
        const res = await engine.browserHover({ tabId, ref });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.diff.text);
        return 0;
      }
      case 'fill': {
        const ref = pos[1];
        const value = pos[2];
        if (!ref || value === undefined) {
          io.stderr('Usage: bb fill <ref> <value>');
          return 2;
        }
        const res = await engine.browserFill({ tabId, ref, value });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.diff.text);
        return 0;
      }
      case 'fill-form': {
        const raw = pos[1];
        if (!raw) {
          io.stderr('Usage: bb fill-form \'[{"ref":"e1","value":"alice"}]\'');
          return 2;
        }
        const fields = JSON.parse(raw) as Array<{ ref: string; value: string }>;
        const res = await engine.browserFillForm({ tabId, fields });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.diff.text);
        return 0;
      }
      case 'type': {
        const text = pos[1];
        if (text === undefined) {
          io.stderr('Usage: bb type <text> [--ref e1] [--submit]');
          return 2;
        }
        const res = await engine.browserType({
          tabId,
          text,
          ref: getFlag(argv, '--ref'),
          submit: hasFlag(argv, '--submit'),
        });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.diff.text);
        return 0;
      }
      case 'press': {
        const key = pos[1];
        if (!key) {
          io.stderr('Usage: bb press <key> [--ref e1]');
          return 2;
        }
        const res = await engine.browserPress({ tabId, key, ref: getFlag(argv, '--ref') });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.diff.text);
        return 0;
      }
      case 'wait': {
        const msStr = getFlag(argv, '--ms');
        const timeoutStr = getFlag(argv, '--timeout');
        const res = await engine.browserWait({
          tabId,
          text: getFlag(argv, '--text'),
          textGone: getFlag(argv, '--text-gone'),
          delayMs: msStr ? Number(msStr) : undefined,
          timeoutMs: timeoutStr ? Number(timeoutStr) : undefined,
        });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.snapshotText);
        return 0;
      }
      case 'dialog': {
        const action = pos[1];
        if (action !== 'accept' && action !== 'dismiss') {
          io.stderr('Usage: bb dialog <accept|dismiss> [--prompt <text>]');
          return 2;
        }
        const res = await engine.browserDialog({
          tabId,
          accept: action === 'accept',
          promptText: getFlag(argv, '--prompt'),
        });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.diff.text);
        return 0;
      }
      case 'upload': {
        const ref = pos[1];
        const paths = pos.slice(2);
        if (!ref || paths.length === 0) {
          io.stderr('Usage: bb upload <ref> <file1> [file2...]');
          return 2;
        }
        const res = await engine.browserUpload({ tabId, ref, paths });
        io.stdout(jsonOutput ? JSON.stringify(res, null, 2) : res.diff.text);
        return 0;
      }
      default:
        io.stderr(`Unknown command: ${cmd}. Run "bb --help" for usage.`);
        return 2;
    }
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    if (!injectedEngine) {
      await engine.disconnect().catch(() => void 0);
    }
  }
}
