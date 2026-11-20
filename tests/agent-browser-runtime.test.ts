import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RelayStatusSnapshot } from '../packages/protocol/src/index.js';
import {
  AgentBrowserRuntime,
  SecurityError,
  UNTRUSTED_PAGE_CONTENT_NOTICE,
  type CommandExecutor,
  type CommandExecutorInput,
  type CommandExecutorResult,
} from '../packages/engine/src/index.js';

/** Minimal valid JPEG with a SOF0 marker declaring 640x480. */
const SAMPLE_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]);

class FakeExecutor implements CommandExecutor {
  readonly calls: CommandExecutorInput[] = [];
  handler: (input: CommandExecutorInput) => CommandExecutorResult | Promise<CommandExecutorResult> = () => ({
    code: 0,
    stdout: 'ok',
    stderr: '',
  });

  async run(input: CommandExecutorInput): Promise<CommandExecutorResult> {
    this.calls.push(input);
    return await this.handler(input);
  }

  get commands(): string[][] {
    return this.calls.map((call) => call.args);
  }
}

function relayStatus(overrides: Partial<RelayStatusSnapshot> = {}): RelayStatusSnapshot {
  return {
    ok: true,
    relayId: 'relay-1',
    protocolVersion: 1,
    host: '127.0.0.1',
    port: 9229,
    extPath: '/ext',
    tokenRequired: false,
    uptimeMs: 1_000,
    extensionConnected: true,
    extension: {
      extensionVersion: '0.2.0',
      browserName: 'Chrome',
      userAgent: 'Mozilla/5.0 Chrome/131',
      tabPolicyMode: 'auto',
      isRemote: false,
      connectedAt: 1_000,
      lastHeartbeatAt: 2_000,
    },
    tabs: [],
    cdpClients: 0,
    cdpWsPath: '/cdp/secret',
    cdpWsUrl: 'ws://127.0.0.1:9229/cdp/secret',
    ...overrides,
  };
}

describe('AgentBrowserRuntime', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeRuntime(options: {
    status?: RelayStatusSnapshot | null;
    policy?: Record<string, unknown>;
    maxOutputChars?: number;
  } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'abb-runtime-'));
    tempDirs.push(dir);
    const executor = new FakeExecutor();
    let status = options.status === undefined ? relayStatus() : options.status;
    const runtime = new AgentBrowserRuntime({
      // `node --version` is enough for the availability probe and needs no browser.
      binaryPath: process.execPath,
      socketDir: join(dir, 'sockets'),
      executor,
      policy: options.policy,
      maxOutputChars: options.maxOutputChars,
      relayStatusProvider: async () => status,
    });
    return {
      dir,
      executor,
      runtime,
      setStatus: (next: RelayStatusSnapshot | null) => {
        status = next;
      },
    };
  }

  it('connects the bridge session once, then reuses it', async () => {
    const { executor, runtime } = await makeRuntime();

    const first = await runtime.run({ args: ['tab', 'list'], target: 'bridge', dshSessionId: 'sess-1' });
    expect(first.sessionName).toBe('dsh-bridge-sess-1');
    expect(executor.commands[0]).toEqual([
      '--session',
      'dsh-bridge-sess-1',
      '--json',
      'connect',
      'ws://127.0.0.1:9229/cdp/secret',
    ]);
    expect(executor.commands[1]).toEqual(['--session', 'dsh-bridge-sess-1', 'tab', 'list']);

    await runtime.run({ args: ['snapshot', '-i'], target: 'bridge', dshSessionId: 'sess-1' });
    expect(executor.calls).toHaveLength(3);
    expect(executor.commands[2]).toEqual([
      '--session',
      'dsh-bridge-sess-1',
      '--content-boundaries',
      '--max-output',
      '40000',
      'snapshot',
      '-i',
    ]);
  });

  it('reconnects when the Relay generation changes', async () => {
    const { executor, runtime, setStatus } = await makeRuntime();
    await runtime.run({ args: ['tab', 'list'], target: 'bridge', dshSessionId: 'sess-1' });

    setStatus(relayStatus({ relayId: 'relay-2', cdpWsUrl: 'ws://127.0.0.1:9229/cdp/second' }));
    await runtime.run({ args: ['tab', 'list'], target: 'bridge', dshSessionId: 'sess-1' });

    const commands = executor.commands.slice(2);
    expect(commands[0]).toEqual(['--session', 'dsh-bridge-sess-1', '--json', 'close']);
    expect(commands[1]).toEqual([
      '--session',
      'dsh-bridge-sess-1',
      '--json',
      'connect',
      'ws://127.0.0.1:9229/cdp/second',
    ]);
    expect(commands[2]).toEqual(['--session', 'dsh-bridge-sess-1', 'tab', 'list']);
  });

  it('fails fast with actionable errors when the bridge is not ready', async () => {
    const { runtime, setStatus } = await makeRuntime();
    setStatus(null);
    await expect(runtime.run({ args: ['snapshot'], target: 'bridge' })).rejects.toMatchObject({
      code: 'RELAY_UNAVAILABLE',
    });

    setStatus(relayStatus({ extensionConnected: false }));
    await expect(runtime.run({ args: ['snapshot'], target: 'bridge' })).rejects.toMatchObject({
      code: 'EXTENSION_DISCONNECTED',
    });
  });

  it('launches isolated browsers with the plugin-owned launch flags and no CDP endpoint', async () => {
    const { executor, runtime } = await makeRuntime();
    await runtime.run({
      args: ['snapshot', '-i'],
      target: 'headless',
      dshSessionId: 'sess-2',
      launchOptions: {
        enable: ['react-devtools'],
        allowedDomains: ['localhost'],
        colorScheme: 'dark',
        ignoreHttpsErrors: true,
      },
    });

    expect(executor.commands[0]).toEqual([
      '--idle-timeout',
      '15m',
      '--enable',
      'react-devtools',
      '--allowed-domains',
      'localhost',
      '--color-scheme',
      'dark',
      '--ignore-https-errors',
      '--session',
      'dsh-headless-sess-2',
      '--content-boundaries',
      '--max-output',
      '40000',
      'snapshot',
      '-i',
    ]);
    expect(executor.commands[0]).not.toContain('--cdp');
  });

  it('adds --headed only for the headed target', async () => {
    const { executor, runtime } = await makeRuntime();
    await runtime.run({ args: ['open', 'http://localhost:3000'], target: 'headed', dshSessionId: 's' });
    expect(executor.commands[0]?.slice(0, 2)).toEqual(['--headed', '--idle-timeout']);
    expect(executor.commands[0]).toContain('dsh-headed-s');
  });

  it('isolates daemon sockets and state from the user shell', async () => {
    const { executor, runtime, dir } = await makeRuntime();
    await runtime.run({ args: ['tab', 'list'], target: 'headless' });
    const env = executor.calls[0]?.env ?? {};
    expect(env.AGENT_BROWSER_NAMESPACE).toBe('dsh-abb');
    expect(env.AGENT_BROWSER_NO_VERSION_CHECK).toBe('1');
    expect(env.AGENT_BROWSER_SOCKET_DIR).toBe(join(dir, 'sockets'));
  });

  it('switches to the requested tab before running the command', async () => {
    const { executor, runtime } = await makeRuntime();
    await runtime.run({ args: ['snapshot', '-i'], target: 'headless', tab: 't2', dshSessionId: 's' });
    expect(executor.commands[0]).toEqual([
      '--idle-timeout',
      '15m',
      '--session',
      'dsh-headless-s',
      'tab',
      't2',
    ]);
    expect(executor.commands[1]).toEqual([
      '--idle-timeout',
      '15m',
      '--session',
      'dsh-headless-s',
      '--content-boundaries',
      '--max-output',
      '40000',
      'snapshot',
      '-i',
    ]);
  });

  it('validates session names and refuses to reuse a session across targets', async () => {
    const { runtime } = await makeRuntime();
    await expect(
      runtime.run({ args: ['snapshot'], target: 'headless', session: 'has space' }),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION_NAME' });

    await runtime.run({ args: ['snapshot'], target: 'headless', session: 'shared' });
    await expect(
      runtime.run({ args: ['snapshot'], target: 'headed', session: 'shared' }),
    ).rejects.toMatchObject({ code: 'SESSION_TARGET_MISMATCH' });
  });

  it('retries once after a bridge connection failure', async () => {
    const { executor, runtime } = await makeRuntime();
    let failures = 1;
    executor.handler = (input) => {
      if (input.args.includes('connect')) return { code: 0, stdout: '{}', stderr: '' };
      if (failures > 0) {
        failures -= 1;
        return { code: 1, stdout: '', stderr: 'Failed to connect to browser' };
      }
      return { code: 0, stdout: 'Recovered', stderr: '' };
    };

    const result = await runtime.run({ args: ['tab', 'list'], target: 'bridge', dshSessionId: 's' });
    expect(result.text).toBe('Recovered');
    expect(executor.calls.filter((call) => call.args.includes('connect'))).toHaveLength(2);
  });

  it('returns page output with the untrusted-content notice and caps long output', async () => {
    const { executor, runtime } = await makeRuntime({ maxOutputChars: 1_000 });
    executor.handler = () => ({ code: 0, stdout: 'x'.repeat(2_000), stderr: '' });

    const result = await runtime.run({ args: ['snapshot'], target: 'headless' });
    expect(result.text.startsWith(UNTRUSTED_PAGE_CONTENT_NOTICE)).toBe(true);
    expect(result.untrustedPageContent).toBe(true);
    expect(result.text).toContain('truncated at 1000 characters');

    const plain = await runtime.run({ args: ['tab', 'list'], target: 'headless' });
    expect(plain.text.startsWith(UNTRUSTED_PAGE_CONTENT_NOTICE)).toBe(false);
  });

  it('parses JSON output into data', async () => {
    const { executor, runtime } = await makeRuntime();
    // Real `agent-browser --json` output wraps the payload in a success envelope.
    executor.handler = () => ({
      code: 0,
      stdout: JSON.stringify({
        success: true,
        data: { tabs: [{ tabId: 't1' }] },
        error: null,
      }),
      stderr: '',
    });
    const result = await runtime.run({ args: ['tab', 'list'], target: 'headless', json: true });
    expect(result.data).toEqual({ tabs: [{ tabId: 't1' }] });
    expect(result.text).toContain('"tabId": "t1"');
    expect(result.text).not.toContain('success');

    // Launch lifecycle bookkeeping is noise for the model: stripped from text, kept in data.
    executor.handler = () => ({
      code: 0,
      stdout: JSON.stringify({
        success: true,
        data: { lifecycle: { launched: true }, tabs: [{ tabId: 't1' }] },
        error: null,
      }),
      stderr: '',
    });
    const noisy = await runtime.run({ args: ['tab', 'list'], target: 'headless', json: true });
    expect(noisy.text).not.toContain('lifecycle');
    expect(noisy.text).toContain('"tabId": "t1"');
    expect(noisy.data).toMatchObject({ lifecycle: { launched: true } });
  });

  it('captures screenshots and reports their real dimensions', async () => {
    const { dir, executor, runtime } = await makeRuntime();
    const shotPath = join(dir, 'shot.jpg');
    await writeFile(shotPath, SAMPLE_JPEG);
    executor.handler = () => ({
      code: 0,
      stdout: JSON.stringify({
        success: true,
        data: { path: shotPath, changed: true, revision: 1 },
        error: null,
      }),
      stderr: '',
    });

    const capture = await runtime.screenshot({ target: 'headless', fullPage: true, dshSessionId: 's' });
    expect(capture.changed).toBe(true);
    expect(capture.filePath).toBe(shotPath);
    expect(capture.mediaType).toBe('image/jpeg');
    expect(capture.width).toBe(640);
    expect(capture.height).toBe(480);
    expect(capture.base64?.length).toBeGreaterThan(0);

    const args = executor.commands[0] ?? [];
    expect(args).toContain('--screenshot-format');
    expect(args).toContain('jpeg');
    expect(args).toContain('--screenshot-quality');
    expect(args).toContain('screenshot');
    expect(args).toContain('--full');
    expect(args).toContain('--screenshot-dir');
  });

  it('skips the image when ifChanged reports no pixel change', async () => {
    const { executor, runtime } = await makeRuntime();
    executor.handler = () => ({
      code: 0,
      stdout: JSON.stringify({
        success: true,
        data: { changed: false, revision: 3 },
        error: null,
      }),
      stderr: '',
    });
    const capture = await runtime.screenshot({ target: 'headless', ifChanged: true });
    expect(capture.changed).toBe(false);
    expect(capture.filePath).toBeUndefined();
    expect(capture.text).toContain('No pixel change');
  });

  it('surfaces agent-browser failures with the command and stderr', async () => {
    const { executor, runtime } = await makeRuntime();
    executor.handler = () => ({ code: 2, stdout: '', stderr: 'Ref not found: @e9' });
    await expect(runtime.run({ args: ['click', '@e9'], target: 'headless' })).rejects.toThrow(
      /click @e9 failed \(exit 2\)[\s\S]*Ref not found/,
    );
  });

  it('explains how to install agent-browser when it is missing', async () => {
    const savedPath = process.env.PATH;
    const savedBin = process.env.AGENT_BROWSER_BIN;
    process.env.PATH = '';
    delete process.env.AGENT_BROWSER_BIN;
    try {
      const runtime = new AgentBrowserRuntime({
        binaryPath: '/nonexistent/agent-browser',
        executor: new FakeExecutor(),
        relayStatusProvider: async () => relayStatus(),
      });
      const probe = await runtime.probe();
      expect(probe.available).toBe(false);
      await expect(runtime.run({ args: ['snapshot'], target: 'headless' })).rejects.toMatchObject({
        code: 'AGENT_BROWSER_UNAVAILABLE',
      });
    } finally {
      process.env.PATH = savedPath;
      if (savedBin === undefined) delete process.env.AGENT_BROWSER_BIN;
      else process.env.AGENT_BROWSER_BIN = savedBin;
    }
  });

  it('closes every session it owns on dispose', async () => {
    const { executor, runtime } = await makeRuntime();
    await runtime.run({ args: ['snapshot'], target: 'headless', session: 'alpha' });
    await runtime.run({ args: ['snapshot'], target: 'headless', session: 'beta' });
    expect(runtime.listSessions().map((entry) => entry.sessionName)).toEqual(['alpha', 'beta']);

    await runtime.dispose();
    const closeCalls = executor.calls.filter((call) => call.args.includes('close'));
    expect(closeCalls.map((call) => call.args[1])).toEqual(['alpha', 'beta']);
    expect(runtime.listSessions()).toEqual([]);

    await runtime.closeSession('alpha').then((closed) => expect(closed).toBe(false));
  });

  it('reports a blocked command without spawning a process', async () => {
    const { executor, runtime } = await makeRuntime();
    await expect(
      runtime.run({ args: ['--cdp', 'ws://evil', 'snapshot'], target: 'headless' }),
    ).rejects.toBeInstanceOf(SecurityError);
    expect(executor.calls).toHaveLength(0);
  });
});
