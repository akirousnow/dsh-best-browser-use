import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserEngine, READ_ONLY_TOOL_NAMES } from '../packages/engine/dist/index.js';
import {
  MCP_BROWSER_TOOLS,
  dispatchEngineTool,
  startStreamableHttpMcpServer,
  type HttpMcpServerHandle,
} from '../packages/mcp/dist/index.js';
import { runCli } from '../packages/cli/dist/index.js';
import { FakeBrowserBackend } from './fake-backend.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('MCP Server, CLI (bb), and Native DSH Plugin Bundle', () => {
  const httpServers: HttpMcpServerHandle[] = [];

  afterEach(async () => {
    for (const s of httpServers.splice(0)) {
      await s.close();
    }
  });

  it('exposes exact 15 MCP tools with readOnlyHint annotations and works over Streamable HTTP', async () => {
    expect(MCP_BROWSER_TOOLS).toHaveLength(15);
    const readOnlyTools = MCP_BROWSER_TOOLS.filter((t) => t.annotations.readOnlyHint);
    expect(readOnlyTools.map((t) => t.name).sort()).toEqual([...READ_ONLY_TOOL_NAMES].sort());

    const backend = new FakeBrowserBackend();
    const engine = new BrowserEngine({ backend });
    const handle = await startStreamableHttpMcpServer(engine, { host: '127.0.0.1', port: 0 });
    httpServers.push(handle);

    // Initialize MCP session over Streamable HTTP
    const initRes = await fetch(handle.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1.0.0' },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // Send tools/list on initialized session
    const listRes = await fetch(handle.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(listRes.status).toBe(200);
    const bodyText = await listRes.text();
    expect(bodyText).toContain('browser_tabs');
    expect(bodyText).toContain('browser_fill_form');
    expect(bodyText).toContain('browser_upload');

    // Direct dispatch test
    const tabsOut = await dispatchEngineTool(engine, 'browser_tabs');
    expect(tabsOut.isError).toBeUndefined();
    expect(tabsOut.content[0]?.type).toBe('text');
    expect((tabsOut.content[0] as { text: string }).text).toContain('$t1');
  });

  it('runs CLI commands (help, pair, tabs, snapshot, click, fill-form)', async () => {
    const backend = new FakeBrowserBackend();
    const engine = new BrowserEngine({ backend });

    const capture = async (argv: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(argv, { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) }, engine);
      return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    };

    const help = await capture(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('bb daemon start');

    const pair = await capture(['pair', '--host', '10.0.0.5', '--port', '9229', '--wss', '--json']);
    expect(pair.code).toBe(0);
    const parsedPair = JSON.parse(pair.stdout) as { wsUrl: string; remote: boolean; token: string };
    expect(parsedPair.wsUrl).toBe('wss://10.0.0.5:9229/ext');
    expect(parsedPair.remote).toBe(true);
    expect(parsedPair.token.length).toBeGreaterThan(20);

    const tabs = await capture(['tabs']);
    expect(tabs.code).toBe(0);
    expect(tabs.stdout).toContain('$t1');

    const snap = await capture(['snapshot']);
    expect(snap.code).toBe(0);
    expect(snap.stdout).toContain('[e1] textbox "Email"');

    const fill = await capture(['fill-form', '[{"ref":"e1","value":"cli@example.com"}]']);
    expect(fill.code).toBe(0);
    expect(fill.stdout).toContain('cli@example.com');
  });

  it('validates native DSH plugin bundle manifest, locales, icon, detail preview, and packaged extension zip', async () => {
    const dshDir = join(repoRoot, 'packages/dsh-plugin');
    const pkg = JSON.parse(await readFile(join(dshDir, 'package.json'), 'utf8')) as {
      name: string;
      exports: Record<string, string>;
      files: string[];
      dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } };
      dependencies: Record<string, string>;
    };

    expect(pkg.name).toBe('@local/agent-browser-bridge');
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml');
    expect(pkg.dsh.client.platform).toBe('web');
    expect(pkg.exports['.']).toBe('./index.js');
    expect(pkg.exports['./client']).toBe('./client.js');
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json');
    expect(pkg.exports['./icon']).toBe('./icon.svg');
    // Must not depend on workspace:* so DSH plugin_manager can install cleanly
    for (const ver of Object.values(pkg.dependencies ?? {})) {
      expect(ver.startsWith('workspace:')).toBe(false);
    }

    // Verify locales and single-image detail docs
    const en = JSON.parse(await readFile(join(dshDir, 'locale/en.json'), 'utf8')) as {
      meta: { title: string; description: string; detail: string };
    };
    const zh = JSON.parse(await readFile(join(dshDir, 'locale/zh.json'), 'utf8')) as {
      meta: { title: string; description: string; detail: string };
    };
    expect(en.meta.detail).toBe('docs/DETAIL.md');
    expect(zh.meta.detail).toBe('docs/DETAIL.zh.md');

    const detailEn = (await readFile(join(dshDir, en.meta.detail), 'utf8')).trim();
    const detailZh = (await readFile(join(dshDir, zh.meta.detail), 'utf8')).trim();
    expect(detailEn).toMatch(/^!\[.+\]\(preview\.svg\)$/);
    expect(detailZh).toMatch(/^!\[.+\]\(preview\.svg\)$/);

    // Verify icon.svg and preview.svg follow DSH artwork constraints
    const iconSvg = await readFile(join(dshDir, 'icon.svg'), 'utf8');
    expect(iconSvg).toContain('viewBox="0 0 36 36"');
    expect(iconSvg).not.toMatch(/<script|<style|<text|<foreignObject/i);

    const previewSvg = await readFile(join(dshDir, 'docs/preview.svg'), 'utf8');
    expect(previewSvg).toContain('viewBox="0 0 640 300"');
    expect(previewSvg).not.toMatch(/<script|<style|<text|<foreignObject/i);

    // Verify client.js does not import @deepseek-ai/dsh-client-ui-primitives
    const clientJs = await readFile(join(dshDir, 'client.js'), 'utf8');
    expect(clientJs).toContain("id: '@local/agent-browser-bridge'");
    expect(clientJs).not.toContain('@deepseek-ai/dsh-client-ui-primitives');
    expect(clientJs).toContain('--dsw-alias-');

    // Verify packaged extension zip exists and starts with valid PK zip signature
    const zipBuf = await readFile(join(dshDir, 'assets/agent-browser-bridge-extension.zip'));
    expect(zipBuf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);

    // Verify bundled bridge runtime exists
    expect((await stat(join(dshDir, 'dist/bridge.mjs'))).isFile()).toBe(true);
  });
});
