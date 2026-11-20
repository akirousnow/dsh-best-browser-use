import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../packages/cli/src/index.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function capture(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('bb CLI (Relay + agent-browser launcher)', () => {
  const ports: number[] = [];

  afterEach(() => {
    ports.length = 0;
  });

  it('documents the Relay and agent-browser integration commands', async () => {
    const help = await capture(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('bb daemon start');
    expect(help.stdout).toContain('bb cdp-url');
    expect(help.stdout).toContain('bb ab');
    expect(help.stdout).toContain('bb mcp');
    expect(help.stdout).toContain('agent-browser');
    // The old per-action browser commands are delegated to agent-browser now.
    expect(help.stdout).not.toContain('bb snapshot');
    expect(help.stdout).not.toContain('bb fill-form');
  });

  it('prints remote pairing settings with a generated token', async () => {
    const pair = await capture(['pair', '--host', '10.0.0.5', '--port', '9229', '--wss', '--json']);
    expect(pair.code).toBe(0);
    const parsed = JSON.parse(pair.stdout) as { wsUrl: string; remote: boolean; token: string };
    expect(parsed.wsUrl).toBe('wss://10.0.0.5:9229/ext');
    expect(parsed.remote).toBe(true);
    expect(parsed.token.length).toBeGreaterThan(20);
  });

  it('reports a missing Relay instead of guessing', async () => {
    const port = await freePort();
    ports.push(port);

    const status = await capture(['daemon', 'status', '--port', String(port), '--json']);
    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout)).toEqual({ running: false, port });

    const cdpUrl = await capture(['cdp-url', '--port', String(port)]);
    expect(cdpUrl.code).toBe(1);
    expect(cdpUrl.stderr).toContain('not running');

    const ab = await capture(['ab', '--port', String(port), '--', 'snapshot']);
    expect(ab.code).toBe(1);
    expect(ab.stderr).toContain('not running');
  });
});

describe('DSH plugin bundle after the agent-browser refactor', () => {
  const pluginDir = join(repoRoot, 'packages/dsh-plugin');

  it('ships a two-tool host plugin with no Playwright or workspace dependencies', async () => {
    const pkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8')) as {
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

    expect(pkg.dependencies['playwright-core']).toBeUndefined();
    for (const version of Object.values(pkg.dependencies ?? {})) {
      expect(version.startsWith('workspace:')).toBe(false);
    }
  });

  it('registers exactly the browser and browser_screenshot tools plus the runtime skill', async () => {
    const source = await readFile(join(pluginDir, 'index.js'), 'utf8');
    expect(source).toContain("name: 'browser'");
    expect(source).toContain("name: 'browser_screenshot'");
    expect(source).toContain('AgentBrowserRuntime');
    expect(source).toContain('BROWSER_BRIDGE_SKILL_CONTENT');
    expect(source).toContain('skills.register');
    expect(source).toContain('close_session');
    expect(source).toContain('managedSessions');
    // The 15-tool surface is gone.
    expect(source).not.toContain("toolName: 'browser_tabs'");
    expect(source).not.toContain('browser_fill_form');
    expect(source).not.toContain('BrowserEngine');
  });

  it('keeps the client UI on host tokens and carries the CDP targetId in tab references', async () => {
    const clientJs = await readFile(join(pluginDir, 'client.js'), 'utf8');
    expect(clientJs).toContain("id: '@local/agent-browser-bridge'");
    expect(clientJs).not.toContain('@deepseek-ai/dsh-client-ui-primitives');
    expect(clientJs).toContain('--dsw-alias-');
    expect(clientJs).toContain('conversation.input.overlay');
    expect(clientJs).toContain('agent-browser-bridge-dollar-tab-picker');
    expect(clientJs).toContain('slash/input-insert-reference');
    expect(clientJs).toContain('slash/input-insert-text');
    expect(clientJs).toContain('targetId');
    expect(clientJs).toContain('isRealTargetId');
    expect(clientJs).toContain('close_session');
  });

  it('ships locales, artwork, the extension zip, and a bundle without Playwright', async () => {
    const en = JSON.parse(await readFile(join(pluginDir, 'locale/en.json'), 'utf8')) as {
      meta: { title: string; description: string; detail: string };
    };
    const zh = JSON.parse(await readFile(join(pluginDir, 'locale/zh.json'), 'utf8')) as {
      meta: { title: string; description: string; detail: string };
    };
    expect(en.meta.detail).toBe('docs/DETAIL.md');
    expect(zh.meta.detail).toBe('docs/DETAIL.zh.md');
    expect(en.meta.description.toLowerCase()).toContain('agent-browser');
    expect(zh.meta.description).toContain('agent-browser');

    const iconSvg = await readFile(join(pluginDir, 'icon.svg'), 'utf8');
    expect(iconSvg).toContain('viewBox="0 0 36 36"');
    expect(iconSvg).not.toMatch(/<script|<style|<text|<foreignObject/i);

    const previewSvg = await readFile(join(pluginDir, 'docs/preview.svg'), 'utf8');
    expect(previewSvg).toContain('viewBox="0 0 640 300"');
    expect(previewSvg).not.toMatch(/<script|<style|<text|<foreignObject/i);

    const zipBuf = await readFile(join(pluginDir, 'assets/agent-browser-bridge-extension.zip'));
    expect(zipBuf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);

    const bridge = await readFile(join(pluginDir, 'dist/bridge.mjs'), 'utf8');
    expect(bridge).toContain('AgentBrowserRuntime');
    expect(bridge).not.toContain('playwright');
    expect((await stat(join(pluginDir, 'dist/bridge.mjs'))).isFile()).toBe(true);
  });

  it('no longer ships a duplicated MCP server package', async () => {
    await expect(stat(join(repoRoot, 'packages/mcp'))).rejects.toThrow();
  });
});
