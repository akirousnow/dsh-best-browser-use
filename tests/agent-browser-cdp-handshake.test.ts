import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CdpCommandMessage, CdpEventMessage } from '../packages/protocol/src/index.js';
import { RelayServer } from '../packages/relay/dist/index.js';
import { CdpBridge, type ChromeBridgeApi } from '../packages/extension/src/cdp-bridge.js';
import { TabPolicy } from '../packages/extension/src/tab-policy.js';
import { createMockChromeApi, type MockChromeState } from './mock-extension.js';

const execFileAsync = promisify(execFile);

async function hasAgentBrowser(): Promise<boolean> {
  try {
    await execFileAsync('agent-browser', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const AGENT_BROWSER_AVAILABLE = await hasAgentBrowser();

interface Harness {
  relay: RelayServer;
  bridge: CdpBridge;
  state: MockChromeState;
  socket: WebSocket;
  browserCommands: string[];
  cdpWsUrl: string;
  home: string;
  session: string;
  namespace: string;
}

describe.skipIf(!AGENT_BROWSER_AVAILABLE)('real agent-browser against the Relay and MV3 bridge', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await runAgentBrowser(harness, ['close'], { allowFailure: true }).catch(() => void 0);
      harness.socket.close();
      await harness.relay.stop();
      await rm(harness.home, { recursive: true, force: true });
    }
  });

  async function startHarness(): Promise<Harness> {
    const home = await mkdtemp(join(tmpdir(), 'abb-cdp-'));
    const relay = new RelayServer({
      host: '127.0.0.1',
      port: 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    const { port, cdpWsUrl } = await relay.start();

    const { api, state } = createMockChromeApi([
      { id: 42, windowId: 1, url: 'https://linux.do/', title: 'LINUX DO', active: true },
      { id: 43, windowId: 1, url: 'https://github.com/', title: 'GitHub', active: false },
    ]);

    state.commandHandler = async (target, method, params) => {
      const tabId = target.tabId ?? 42;
      const realId = state.realTargetIdFor(tabId);
      const tab = state.tabs.get(tabId);
      switch (method) {
        case 'Target.getTargetInfo':
          return {
            targetInfo: {
              targetId: realId,
              type: 'page',
              title: tab?.title ?? '',
              url: tab?.url ?? '',
              attached: true,
              canAccessOpener: false,
              browserContextId: 'default',
            },
          };
        case 'Page.getFrameTree':
          return {
            frameTree: {
              frame: {
                id: realId,
                loaderId: `loader-${tabId}`,
                url: tab?.url ?? 'about:blank',
                securityOrigin: 'https://linux.do',
                mimeType: 'text/html',
              },
              childFrames: [],
            },
          };
        case 'Runtime.evaluate': {
          const expression = String(params?.expression ?? '');
          if (expression === '1') return { result: { type: 'number', value: 1 } };
          if (expression.includes('document.title')) {
            return { result: { type: 'string', value: tab?.title ?? '' } };
          }
          if (expression.includes('location.href')) {
            return { result: { type: 'string', value: tab?.url ?? '' } };
          }
          return { result: { type: 'object', value: [] } };
        }
        case 'Accessibility.getFullAXTree':
          return {
            nodes: [
              {
                nodeId: '1',
                role: { type: 'role', value: 'RootWebArea' },
                name: { type: 'computedString', value: tab?.title ?? '' },
                childIds: ['2'],
              },
              {
                nodeId: '2',
                role: { type: 'role', value: 'button' },
                name: { type: 'computedString', value: 'Sign in' },
                backendDOMNodeId: 7,
              },
            ],
          };
        case 'Page.getLayoutMetrics':
          return {
            cssVisualViewport: { clientWidth: 1280, clientHeight: 720 },
            cssContentSize: { width: 1280, height: 720 },
          };
        case 'Page.captureScreenshot':
          // 1x1 PNG so the CLI can write a real image file.
          return {
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
          };
        default:
          return {};
      }
    };

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ext`, {
      headers: { origin: 'chrome-extension://abcdefghijklmnop' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const bridge = new CdpBridge(api as ChromeBridgeApi, new TabPolicy('auto'), {
      emitEvent: (event: CdpEventMessage) => socket.send(JSON.stringify(event)),
      onTabsChanged: (tabs, mode) => socket.send(JSON.stringify({ type: 'tabs.sync', mode, tabs })),
    });
    bridge.bindListeners();

    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        extensionVersion: '0.2.0',
        browserName: 'Chrome',
        userAgent: 'Mozilla/5.0 Chrome/131.0.0.0',
        tabPolicyMode: 'auto',
        tabs: await bridge.getTabSummaries(),
      }),
    );

    const browserCommands: string[] = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8')) as CdpCommandMessage;
      if (message.type !== 'cdp.cmd') return;
      if (message.sessionId === undefined) browserCommands.push(message.method);
      void bridge.handleCommand(message).then((response) => socket.send(JSON.stringify(response)));
    });

    const harness: Harness = {
      relay,
      bridge,
      state,
      socket,
      browserCommands,
      cdpWsUrl,
      home,
      session: `abb-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      namespace: `abb-test-${process.pid}`,
    };
    harnesses.push(harness);
    return harness;
  }

  async function runAgentBrowser(
    harness: Harness,
    args: string[],
    options: { allowFailure?: boolean } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        'agent-browser',
        ['--session', harness.session, '--json', ...args],
        {
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            ...process.env,
            HOME: harness.home,
            XDG_RUNTIME_DIR: harness.home,
            AGENT_BROWSER_SOCKET_DIR: harness.home,
            AGENT_BROWSER_NAMESPACE: harness.namespace,
            AGENT_BROWSER_NO_VERSION_CHECK: '1',
          },
        },
      );
      return { code: 0, stdout, stderr };
    } catch (err) {
      const failure = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      if (options.allowFailure) {
        return {
          code: failure.code ?? 1,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? failure.message ?? '',
        };
      }
      throw err;
    }
  }

  function parseJson(stdout: string): Record<string, unknown> {
    const trimmed = stdout.trim();
    const parsed = JSON.parse(trimmed) as { success?: boolean; data?: Record<string, unknown>; error?: unknown };
    if (parsed.error) throw new Error(`agent-browser error: ${JSON.stringify(parsed.error)}`);
    return parsed.data ?? {};
  }

  it(
    'lists, switches, creates and closes tabs without duplicate targets',
    async () => {
      const harness = await startHarness();

      await runAgentBrowser(harness, ['connect', harness.cdpWsUrl]);

      const listed = parseJson((await runAgentBrowser(harness, ['tab', 'list'])).stdout);
      const tabs = listed.tabs as Array<{ tabId: string; targetId: string; url: string }>;
      expect(tabs).toHaveLength(2);
      expect(new Set(tabs.map((tab) => tab.targetId)).size).toBe(2);
      expect(tabs.map((tab) => tab.url).sort()).toEqual(['https://github.com/', 'https://linux.do/']);
      expect(tabs.map((tab) => tab.targetId).sort()).toEqual(
        [harness.state.realTargetIdFor(42), harness.state.realTargetIdFor(43)].sort(),
      );

      await runAgentBrowser(harness, ['tab', 't2']);
      const snapshot = parseJson((await runAgentBrowser(harness, ['snapshot', '-i'])).stdout);
      expect(String(snapshot.snapshot)).toContain('Sign in');
      expect(snapshot.origin).toBe('https://github.com/');

      const created = parseJson((await runAgentBrowser(harness, ['tab', 'new', 'https://example.org'])).stdout);
      expect(created.url).toBe('https://example.org');

      const afterCreate = parseJson((await runAgentBrowser(harness, ['tab', 'list'])).stdout);
      const createdTabs = afterCreate.tabs as Array<{ tabId: string; targetId: string; url: string }>;
      expect(createdTabs).toHaveLength(3);
      expect(new Set(createdTabs.map((tab) => tab.targetId)).size).toBe(3);
      expect(createdTabs.filter((tab) => tab.url === 'https://example.org')).toHaveLength(1);

      await runAgentBrowser(harness, ['tab', 'close', String(created.tabId)]);
      const afterClose = parseJson((await runAgentBrowser(harness, ['tab', 'list'])).stdout);
      expect(afterClose.tabs as unknown[]).toHaveLength(2);

      // The user's real browser is never closed: only the debugger sessions are released.
      expect(harness.browserCommands).not.toContain('Browser.close');
      expect(harness.state.tabs.size).toBe(2);
    },
    120_000,
  );

  it(
    'runs a snapshot/delta cycle and a JPEG screenshot through the bridge',
    async () => {
      const harness = await startHarness();
      await runAgentBrowser(harness, ['connect', harness.cdpWsUrl]);

      const first = parseJson((await runAgentBrowser(harness, ['snapshot', '-i', '--delta'])).stdout);
      expect((first.snapshot as { kind: string }).kind).toBe('full');

      const second = parseJson((await runAgentBrowser(harness, ['snapshot', '-i', '--delta'])).stdout);
      expect(['unchanged', 'delta', 'full']).toContain((second.snapshot as { kind: string }).kind);

      const shotPath = join(harness.home, 'page.png');
      const shot = await runAgentBrowser(harness, [
        '--screenshot-format',
        'png',
        'screenshot',
        shotPath,
      ]);
      expect(shot.code).toBe(0);
      expect(shot.stdout).toContain('page.png');
    },
    120_000,
  );
});
