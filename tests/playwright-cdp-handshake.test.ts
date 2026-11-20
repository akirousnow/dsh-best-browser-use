import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayServer } from '../packages/relay/dist/index.js';
import { BrowserEngine } from '../packages/engine/dist/index.js';
import { MockExtensionClient } from './mock-extension.js';

// Minimal valid 1280x720 JPEG with SOF0 marker
const SAMPLE_JPEG_BASE64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]).toString('base64');

describe('Real playwright-core connectOverCDP handshake against RelayServer + CdpBridge', () => {
  const relays: RelayServer[] = [];
  const exts: MockExtensionClient[] = [];
  const engines: BrowserEngine[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const eng of engines.splice(0)) {
      await eng.disconnect().catch(() => void 0);
    }
    for (const ext of exts.splice(0)) {
      await ext.close();
    }
    for (const r of relays.splice(0)) {
      await r.stop();
    }
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('connects real playwright-core via connectOverCDP and runs browser_tabs, browser_snapshot, and browser_screenshot (LINUX DO repro)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'abb-pw-handshake-'));
    tempDirs.push(tmpDir);

    const relay = new RelayServer({
      host: '127.0.0.1',
      port: 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const { port } = await relay.start();

    const REAL_CHROME_TARGET_ID = '8F3A2B1C9D0E7F6A5B4C3D2E1F0A9B8C';

    const ext = new MockExtensionClient({
      wsUrl: `ws://127.0.0.1:${port}/ext`,
      origin: 'chrome-extension://abcdefghijklmnop',
      initialTabs: [
        {
          id: 42,
          windowId: 1,
          url: 'https://linux.do/',
          title: 'LINUX DO - 新的理想型社区',
          active: true,
        },
        {
          id: 43,
          windowId: 1,
          url: 'chrome://extensions',
          title: 'Extensions',
          active: false,
        },
      ],
    });
    exts.push(ext);

    // Emulate Chrome's real page-level CDP responses expected by playwright-core CRPage + engine
    ext.chromeState.commandHandler = async (target, method, params) => {
      const tabId = target.tabId ?? 42;
      switch (method) {
        case 'Target.getTargetInfo':
          return {
            targetInfo: {
              targetId: REAL_CHROME_TARGET_ID,
              type: 'page',
              title: 'LINUX DO - 新的理想型社区',
              url: 'https://linux.do/',
              attached: true,
              canAccessOpener: false,
              browserContextId: 'default',
            },
          };
        case 'Page.getFrameTree':
          return {
            frameTree: {
              frame: {
                id: REAL_CHROME_TARGET_ID,
                loaderId: `loader-${tabId}`,
                url: 'https://linux.do/',
                securityOrigin: 'https://linux.do',
                mimeType: 'text/html',
              },
              childFrames: [],
            },
          };
        case 'Page.addScriptToEvaluateOnNewDocument':
          return { identifier: '1' };
        case 'Page.createIsolatedWorld': {
          const worldName = String(params?.worldName ?? '');
          const frameId = String(params?.frameId ?? REAL_CHROME_TARGET_ID);
          setTimeout(() => {
            ext.chromeState.triggerDebuggerEvent({ tabId }, 'Runtime.executionContextCreated', {
              context: {
                id: 2,
                origin: 'https://linux.do',
                name: worldName,
                uniqueId: `ctx-${tabId}-2`,
                auxData: { isDefault: false, type: 'isolated', frameId },
              },
            });
          }, 5);
          return { executionContextId: 2 };
        }
        case 'Runtime.enable':
          setTimeout(() => {
            ext.chromeState.triggerDebuggerEvent({ tabId }, 'Runtime.executionContextCreated', {
              context: {
                id: 1,
                origin: 'https://linux.do',
                name: '',
                uniqueId: `ctx-${tabId}-1`,
                auxData: { isDefault: true, type: 'default', frameId: REAL_CHROME_TARGET_ID },
              },
            });
          }, 5);
          return {};
        case 'Runtime.evaluate':
          return { result: { type: 'string', value: 'LINUX DO - 新的理想型社区' } };
        case 'Runtime.callFunctionOn':
          return { result: { type: 'string', value: 'LINUX DO - 新的理想型社区' } };
        case 'Accessibility.getFullAXTree':
          return {
            nodes: [
              {
                nodeId: '1',
                role: { type: 'role', value: 'RootWebArea' },
                name: { type: 'computedString', value: 'LINUX DO - 新的理想型社区' },
                childIds: ['2', '3'],
              },
              {
                nodeId: '2',
                role: { type: 'role', value: 'heading' },
                name: { type: 'computedString', value: '最新话题' },
                properties: [{ name: 'level', value: { type: 'integer', value: 1 } }],
              },
              {
                nodeId: '3',
                role: { type: 'role', value: 'link' },
                name: { type: 'computedString', value: 'LINUX DO' },
              },
            ],
          };
        case 'Page.getLayoutMetrics':
          return {
            cssVisualViewport: { clientWidth: 1440, clientHeight: 900 },
            cssContentSize: { width: 1440, height: 2400 },
          };
        case 'Page.captureScreenshot':
          return { data: SAMPLE_JPEG_BASE64 };
        case 'Browser.getWindowForTarget':
          return { windowId: 1, bounds: { left: 0, top: 0, width: 1440, height: 900, windowState: 'normal' } };
        default:
          return {};
      }
    };

    await ext.connect();

    // Real BrowserEngine using real PlaywrightCdpBackend -> real playwright-core.chromium.connectOverCDP!
    const engine = new BrowserEngine({
      relayPort: port,
      autoStartRelay: false,
      screenshotDir: tmpDir,
    });
    engines.push(engine);

    // 1. browser_tabs (triggers connectOverCDP -> Browser.getVersion + Target.setAutoAttach + Target.getTargetInfo w/o targetId + page.title())
    const tabsRes = await engine.browserTabs();
    expect(tabsRes.tabs).toHaveLength(1);
    expect(tabsRes.tabs[0]?.tabId).toBe('$t1');
    expect(tabsRes.tabs[0]?.url).toBe('https://linux.do/');
    expect(tabsRes.tabs[0]?.title).toBe('LINUX DO - 新的理想型社区');

    // 2. browser_snapshot (triggers page.context().newCDPSession(page) -> Target.attachToBrowserTarget + Target.attachToTarget alias + Accessibility.getFullAXTree)
    const snapRes = await engine.browserSnapshot();
    expect(snapRes.tabId).toBe('$t1');
    expect(snapRes.text).toContain('最新话题');
    expect(snapRes.text).toContain('LINUX DO');

    // 3. browser_screenshot (triggers Page.getLayoutMetrics + Page.captureScreenshot over newCDPSession)
    const shotRes = await engine.browserScreenshot();
    expect(shotRes.tabId).toBe('$t1');
    expect(shotRes.width).toBe(1280);
    expect(shotRes.height).toBe(720);
    expect((await stat(shotRes.filePath)).isFile()).toBe(true);
  });
});
