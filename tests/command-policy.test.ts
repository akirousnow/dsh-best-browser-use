import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandPolicyGuard,
  SecurityError,
  splitCommandLine,
  type CommandValidationContext,
} from '../packages/engine/src/index.js';

function bridgeContext(extra: Partial<CommandValidationContext> = {}): CommandValidationContext {
  return { target: 'bridge', ...extra };
}

function headlessContext(extra: Partial<CommandValidationContext> = {}): CommandValidationContext {
  return { target: 'headless', ...extra };
}

function expectBlocked(guard: CommandPolicyGuard, args: string[], context: CommandValidationContext, code: string) {
  try {
    guard.validate(args, context);
  } catch (err) {
    expect(err).toBeInstanceOf(SecurityError);
    expect((err as SecurityError).code).toBe(code);
    return;
  }
  throw new Error(`Expected "${args.join(' ')}" to be blocked with ${code}`);
}

describe('CommandPolicyGuard', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks host-only flags in both --flag value and --flag=value forms', () => {
    const guard = new CommandPolicyGuard();
    expectBlocked(guard, ['--cdp', 'ws://127.0.0.1:9229/cdp/x', 'snapshot'], bridgeContext(), 'HOST_ONLY_FLAG');
    expectBlocked(guard, ['--session=other', 'snapshot'], bridgeContext(), 'HOST_ONLY_FLAG');
    expectBlocked(guard, ['open', 'https://example.com', '--profile', 'Default'], bridgeContext(), 'HOST_ONLY_FLAG');
    expectBlocked(guard, ['--executable-path', '/usr/bin/chrome', 'open'], bridgeContext(), 'HOST_ONLY_FLAG');
    expectBlocked(guard, ['--engine', 'lightpanda', 'open'], bridgeContext(), 'HOST_ONLY_FLAG');
    expectBlocked(guard, ['--allowed-domains', 'a.com', 'open'], bridgeContext(), 'HOST_ONLY_FLAG');
  });

  it('blocks host-management commands and the CDP endpoint probe', () => {
    const guard = new CommandPolicyGuard();
    for (const command of ['connect', 'install', 'upgrade', 'plugin', 'dashboard', 'mcp', 'chat', 'doctor', 'inspect']) {
      expectBlocked(guard, [command], bridgeContext(), 'HOST_ONLY_COMMAND');
    }
    expectBlocked(guard, ['get', 'cdp-url'], bridgeContext(), 'HOST_ONLY_COMMAND');
  });

  it('rejects empty command arrays and flag-first arrays', () => {
    const guard = new CommandPolicyGuard();
    expectBlocked(guard, [], bridgeContext(), 'EMPTY_COMMAND');
    expectBlocked(guard, ['--json', 'snapshot'], bridgeContext(), 'FLAG_FIRST');
  });

  it('allows observation commands in read-only mode and blocks everything that mutates', () => {
    const guard = new CommandPolicyGuard({ readOnly: true });
    const allowed = [
      ['tab'],
      ['tab', 'list'],
      ['tab', 't2'],
      ['snapshot', '-i'],
      ['snapshot', '-i', '--delta'],
      ['read'],
      ['read', 'https://docs.example.com/guide'],
      ['get', 'text', '@e1'],
      ['get', 'url'],
      ['is', 'visible', '@e2'],
      ['wait', '--text', 'Saved'],
      ['wait', '@e3'],
      ['console'],
      ['errors'],
      ['network', 'requests'],
      ['network', 'request', 'abc'],
      ['diff', 'snapshot'],
      ['diff', 'screenshot', '--baseline', 'before.png'],
      ['a11y'],
      ['vitals'],
      ['react', 'tree'],
      ['screenshot'],
      ['skills', 'list'],
      ['session', 'info'],
      ['dialog', 'status'],
    ];
    for (const args of allowed) {
      expect(guard.validate(args, bridgeContext()).isReadOnly).toBe(true);
    }

    const blocked = [
      ['open', 'https://example.com'],
      ['click', '@e1'],
      ['fill', '@e1', 'x'],
      ['type', '@e1', 'x'],
      ['press', 'Enter'],
      ['upload', '@e1', './file.txt'],
      ['eval', '1+1'],
      ['set', 'viewport', '1280', '800'],
      ['cookies'],
      ['storage', 'local'],
      ['state', 'save', './auth.json'],
      ['auth', 'list'],
      ['network', 'route', '*', '--abort'],
      ['network', 'requests', '--clear'],
      ['console', '--clear'],
      ['errors', '--clear'],
      ['dialog', 'accept'],
      ['tab', 'new', 'https://example.com'],
      ['tab', 'close', 't2'],
      ['diff', 'url', 'https://a.com', 'https://b.com'],
      ['a11y', 'https://example.com'],
      ['vitals', 'https://example.com'],
      ['record', 'start', './demo.webm'],
      ['trace', 'start'],
      ['wait', '--fn', 'window.ready'],
      ['wait', '--download', './file.pdf'],
    ];
    for (const args of blocked) {
      expectBlocked(guard, args, bridgeContext(), 'READ_ONLY_MODE');
    }
  });

  it('gates JavaScript execution per target', () => {
    const guard = new CommandPolicyGuard();
    for (const args of [['eval', 'document.title'], ['wait', '--fn', 'window.ready'], ['webmcp', 'invoke', 'tool'], ['flow', 'run', 'x']]) {
      expectBlocked(guard, args, bridgeContext(), 'EVAL_DISABLED');
      expect(guard.validate(args, headlessContext()).isReadOnly).toBe(false);
    }
    // Allowed in an isolated browser, still blocked in read-only mode.
    expect(guard.validate(['eval', '1'], headlessContext()).command).toBe('eval');
    const readOnlyGuard = new CommandPolicyGuard({ readOnly: true });
    expectBlocked(readOnlyGuard, ['eval', '1'], headlessContext(), 'READ_ONLY_MODE');
    expectBlocked(readOnlyGuard, ['wait', '--fn', 'window.ready'], headlessContext(), 'READ_ONLY_MODE');
  });

  it('blocks credential access against the real browser only', () => {
    const guard = new CommandPolicyGuard();
    for (const args of [['cookies'], ['cookies', 'set', 'a', 'b'], ['storage', 'local'], ['state', 'save', './x.json'], ['auth', 'list']]) {
      expectBlocked(guard, args, bridgeContext(), 'CREDENTIAL_ACCESS_BLOCKED');
      expect(guard.validate(args, headlessContext()).command).toBe(args[0]);
    }
    const permissive = new CommandPolicyGuard({ allowSensitiveInBridge: true });
    expect(permissive.validate(['cookies'], bridgeContext()).command).toBe('cookies');
  });

  it('restricts navigation protocols and accepts bare hosts', () => {
    const guard = new CommandPolicyGuard();
    expect(guard.validate(['open', 'https://example.com'], bridgeContext()).command).toBe('open');
    expect(guard.validate(['open', 'example.com'], bridgeContext()).command).toBe('open');
    expect(guard.validate(['open', 'about:blank'], bridgeContext()).command).toBe('open');
    expect(guard.validate(['navigate', 'http://localhost:3000/app'], bridgeContext()).command).toBe('navigate');

    expectBlocked(guard, ['open', 'javascript:alert(1)'], bridgeContext(), 'BLOCKED_PROTOCOL');
    expectBlocked(guard, ['open', 'chrome://settings'], bridgeContext(), 'BLOCKED_PROTOCOL');
    expectBlocked(guard, ['open', 'file:///tmp/demo.html'], bridgeContext(), 'BLOCKED_PROTOCOL');
    expectBlocked(guard, ['tab', 'new', 'file:///tmp/demo.html'], bridgeContext(), 'BLOCKED_PROTOCOL');
    expectBlocked(guard, ['diff', 'url', 'https://a.com', 'javascript:1'], bridgeContext(), 'BLOCKED_PROTOCOL');
    expectBlocked(guard, ['open', 'data:text/html,<h1>x</h1>'], bridgeContext(), 'BLOCKED_PROTOCOL');

    const fileGuard = new CommandPolicyGuard({ allowFileUrls: true });
    expect(fileGuard.validate(['open', 'file:///tmp/demo.html'], bridgeContext()).command).toBe('open');
    // data: URLs are only for isolated browsers.
    expect(guard.validate(['open', 'data:text/html,<h1>x</h1>'], headlessContext()).command).toBe('open');
    expectBlocked(guard, ['open', 'data:application/json,{}'], headlessContext(), 'BLOCKED_PROTOCOL');
  });

  it('validates every command inside a batch, including JSON stdin', () => {
    const guard = new CommandPolicyGuard({ readOnly: true });
    expect(guard.validate(['batch', 'snapshot -i', 'get text @e1'], bridgeContext()).isReadOnly).toBe(true);
    expectBlocked(guard, ['batch', 'snapshot -i', 'click @e1'], bridgeContext(), 'READ_ONLY_MODE');
    expectBlocked(
      guard,
      ['batch'],
      bridgeContext({ stdin: '[["snapshot","-i"],["open","https://example.com"]]' }),
      'READ_ONLY_MODE',
    );
    expectBlocked(
      guard,
      ['batch'],
      bridgeContext({ stdin: '[["--cdp","ws://x","snapshot"]]' }),
      'HOST_ONLY_FLAG',
    );
    expectBlocked(guard, ['batch', 'batch snapshot'], bridgeContext(), 'NESTED_BATCH');
    expectBlocked(guard, ['batch'], bridgeContext({ stdin: '{"not":"an array"}' }), 'INVALID_BATCH_STDIN');

    const rw = new CommandPolicyGuard();
    // Nested commands get the same URL policy as top-level ones.
    expectBlocked(
      rw,
      ['batch'],
      bridgeContext({ stdin: JSON.stringify([['open', 'javascript:1']]) }),
      'BLOCKED_PROTOCOL',
    );
    const mixed = rw.validate(['batch'], {
      ...bridgeContext(),
      stdin: JSON.stringify([['snapshot', '-i'], ['get', 'text', '@e1']]),
    });
    expect(mixed.command).toBe('batch');
    expect(mixed.isReadOnly).toBe(true);
    expect(mixed.returnsPageContent).toBe(true);
  });

  it('blocks uploads to a remote browser and enforces allowed upload roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'abb-policy-'));
    tempDirs.push(dir);
    const allowedFile = join(dir, 'report.txt');
    await writeFile(allowedFile, 'hello', 'utf8');

    const guard = new CommandPolicyGuard({ allowedUploadRoots: [dir] });
    expect(
      guard.validate(['upload', '@e4', allowedFile], bridgeContext({ cwd: dir })).command,
    ).toBe('upload');

    expectBlocked(
      guard,
      ['upload', '@e4', allowedFile],
      bridgeContext({ isRemoteBrowser: true }),
      'REMOTE_UPLOAD_BLOCKED',
    );
    expectBlocked(
      guard,
      ['upload', '@e4', '/etc/hostname'],
      bridgeContext({ cwd: dir }),
      'UPLOAD_PATH_OUTSIDE_ROOT',
    );
    expectBlocked(
      guard,
      ['upload', '@e4', join(dir, 'missing.txt')],
      bridgeContext({ cwd: dir }),
      'UPLOAD_FILE_NOT_FOUND',
    );
  });

  it('honours the headless/headed switches and reports command traits', () => {
    const guard = new CommandPolicyGuard({ allowHeadless: false, allowHeaded: false });
    expectBlocked(guard, ['snapshot'], headlessContext(), 'HEADLESS_DISABLED');
    expectBlocked(guard, ['snapshot'], { target: 'headed' }, 'HEADED_DISABLED');

    const traits = guard.validate(['snapshot', '-i'], bridgeContext());
    expect(traits.returnsPageContent).toBe(true);
    expect(traits.switchesTab).toBe(false);

    const tabSwitch = guard.validate(['tab', 't2'], bridgeContext());
    expect(tabSwitch.switchesTab).toBe(true);
    expect(tabSwitch.isReadOnly).toBe(true);

    const click = guard.validate(['click', '@e1'], bridgeContext());
    expect(click.returnsPageContent).toBe(false);
    expect(click.isReadOnly).toBe(false);
  });

  it('splits quoted batch command strings', () => {
    expect(splitCommandLine('fill @e1 "hello world"')).toEqual(['fill', '@e1', 'hello world']);
    expect(splitCommandLine("type @e2 'a b' --delay 10")).toEqual(['type', '@e2', 'a b', '--delay', '10']);
    expect(splitCommandLine('  snapshot   -i  ')).toEqual(['snapshot', '-i']);
  });
});
