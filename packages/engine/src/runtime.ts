import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RELAY_PORT, type RelayStatusSnapshot } from '@agent-browser-bridge/protocol';
import { queryRelayStatus } from '@agent-browser-bridge/relay';
import {
  AGENT_BROWSER_INSTALL_HINT,
  probeAgentBrowser,
  type AgentBrowserProbeResult,
} from './binary.js';
import {
  defaultScreenshotDir,
  readScreenshotAsset,
  type ScreenshotMediaType,
} from './media.js';
import { UNTRUSTED_PAGE_CONTENT_NOTICE } from './prompt.js';
import {
  CommandPolicyGuard,
  SecurityError,
  type BrowserTarget,
  type CommandPolicyConfig,
  type ValidatedCommand,
} from './security.js';

/** One child-process invocation. */
export interface CommandExecutorInput {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface CommandExecutorResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable process runner so tests never spawn a real browser. */
export interface CommandExecutor {
  run(input: CommandExecutorInput): Promise<CommandExecutorResult>;
}

/** Spawn a child process without a shell, forwarding stdin, timeout, and cancellation. */
export const defaultCommandExecutor: CommandExecutor = {
  run(input) {
    return new Promise<CommandExecutorResult>((resolve, reject) => {
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        fail(new Error('The browser command was cancelled.'));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, input.timeoutMs ?? 30_000);
      timer.unref?.();

      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        fail(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (timedOut) {
          reject(
            new Error(
              `agent-browser did not finish within ${input.timeoutMs ?? 30_000} ms. Increase timeoutMs or narrow the command.`,
            ),
          );
          return;
        }
        resolve({ code: code ?? 0, stdout, stderr });
      });

      if (input.stdin !== undefined) {
        child.stdin?.end(input.stdin);
      } else {
        child.stdin?.end();
      }
    });
  },
};

/** Optional isolated-browser launch settings. Only used by headless and headed targets. */
export interface LaunchOptions {
  enable?: string[];
  allowedDomains?: string[];
  colorScheme?: 'dark' | 'light' | 'no-preference';
  ignoreHttpsErrors?: boolean;
  restore?: boolean | string;
}

/** A `browser` tool call. */
export interface BrowserRunInput {
  args: string[];
  target?: BrowserTarget | undefined;
  session?: string | undefined;
  tab?: string | undefined;
  stdin?: string | undefined;
  json?: boolean | undefined;
  timeoutMs?: number | undefined;
  launchOptions?: LaunchOptions | undefined;
  /** Conversation id used to derive the default isolated session name. */
  dshSessionId?: string | undefined;
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** Result of a `browser` tool call. */
export interface BrowserRunResult {
  text: string;
  target: BrowserTarget;
  sessionName: string;
  command: string;
  exitCode: number;
  data: unknown;
  untrustedPageContent: boolean;
}

/** A `browser_screenshot` tool call. */
export interface BrowserScreenshotInput {
  target?: BrowserTarget | undefined;
  session?: string | undefined;
  tab?: string | undefined;
  selector?: string | undefined;
  fullPage?: boolean | undefined;
  annotate?: boolean | undefined;
  ifChanged?: boolean | undefined;
  format?: 'jpeg' | 'png' | undefined;
  quality?: number | undefined;
  outputDir?: string | undefined;
  timeoutMs?: number | undefined;
  launchOptions?: LaunchOptions | undefined;
  dshSessionId?: string | undefined;
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** Captured screenshot, ready to be attached or described. */
export interface ScreenshotCapture {
  /** False when `ifChanged` skipped an unchanged capture. */
  changed: boolean;
  /** Present only when a new image was written. */
  filePath?: string;
  mediaType?: ScreenshotMediaType;
  base64?: string;
  bytes?: number;
  width?: number;
  height?: number;
  text: string;
  target: BrowserTarget;
  sessionName: string;
  tabId?: string;
}

/** A browser session this runtime started and still owns. */
export interface ManagedSessionInfo {
  sessionName: string;
  target: BrowserTarget;
  cdpWsUrl?: string;
  lastUsedAt: number;
}

export interface AgentBrowserRuntimeOptions {
  policy?: CommandPolicyConfig;
  binaryPath?: string;
  socketDir?: string;
  namespace?: string;
  relayHost?: string;
  relayPort?: number;
  relayToken?: string;
  defaultTarget?: BrowserTarget;
  headlessIdleTimeout?: string;
  maxOutputChars?: number;
  screenshotFormat?: 'jpeg' | 'png';
  screenshotQuality?: number;
  screenshotDir?: string;
  executor?: CommandExecutor;
  /** Override Relay status discovery (tests inject a fake). */
  relayStatusProvider?: (port: number) => Promise<RelayStatusSnapshot | null>;
}

interface ManagedSessionState {
  sessionName: string;
  target: BrowserTarget;
  cdpWsUrl?: string;
  relayId?: string;
  lastUsedAt: number;
}

interface ExecuteOptions {
  args: string[];
  target: BrowserTarget;
  sessionName: string;
  state: ManagedSessionState;
  cwd: string;
  env: NodeJS.ProcessEnv;
  binPath: string;
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  json?: boolean | undefined;
  contentBoundaries?: boolean | undefined;
  globalArgs?: string[] | undefined;
  launchOptions?: LaunchOptions | undefined;
  validated: ValidatedCommand;
}

const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

/** Reduce a conversation id to something usable inside an agent-browser session name. */
function sanitizeSessionPart(value: string | undefined): string {
  const cleaned = (value ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 24) : 'main';
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * `agent-browser --json` wraps results as `{ success, data, error }`.
 * Unwrap that envelope so callers see the payload, and surface a reported error.
 */
export function unwrapAgentBrowserJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!('data' in record) || typeof record.success !== 'boolean') return value;
  if (record.success === false || record.error) {
    const detail =
      typeof record.error === 'string' ? record.error : JSON.stringify(record.error ?? {});
    throw new Error(`agent-browser reported an error: ${detail}`);
  }
  return record.data;
}

function parseAgentBrowserOutput(raw: string): unknown {
  const parsed = tryParseJson(raw);
  return parsed === null ? null : unwrapAgentBrowserJson(parsed);
}

/**
 * `agent-browser` attaches launch lifecycle bookkeeping to every JSON payload. It is noise
 * for the model, so rendered text drops it while the canonical `data` value keeps it.
 */
function stripLifecycle(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!('lifecycle' in record)) return value;
  const { lifecycle: _lifecycle, ...rest } = record;
  return rest;
}

const CONNECTION_FAILURE_PATTERN =
  /failed to connect|connection refused|econnrefused|not connected|no browser|target closed|daemon|browser closed|socket/i;

/**
 * Runs `agent-browser` against either the user's real browser (via the Relay's CDP endpoint)
 * or an isolated headless/headed browser owned by agent-browser itself.
 *
 * The runtime owns: binary discovery, command policy, session naming, environment isolation,
 * bridge connection lifecycle, output boundaries, and cleanup of every session it started.
 */
export class AgentBrowserRuntime {
  readonly guard: CommandPolicyGuard;

  private readonly executor: CommandExecutor;
  private readonly binaryPath: string | undefined;
  private readonly socketDir: string | undefined;
  private readonly namespace: string;
  private readonly relayHost: string;
  private readonly relayPort: number;
  private readonly defaultTarget: BrowserTarget;
  private readonly headlessIdleTimeout: string;
  private readonly maxOutputChars: number;
  private readonly screenshotFormat: 'jpeg' | 'png';
  private readonly screenshotQuality: number;
  private readonly screenshotDir: string;
  private readonly relayStatusProvider: (port: number) => Promise<RelayStatusSnapshot | null>;

  private readonly sessions = new Map<string, ManagedSessionState>();

  constructor(options: AgentBrowserRuntimeOptions = {}) {
    this.guard = new CommandPolicyGuard(options.policy);
    this.executor = options.executor ?? defaultCommandExecutor;
    this.binaryPath = options.binaryPath?.trim() || undefined;
    this.socketDir = options.socketDir?.trim() || undefined;
    this.namespace = options.namespace?.trim() || 'dsh-abb';
    this.relayHost = options.relayHost ?? '127.0.0.1';
    this.relayPort = options.relayPort ?? DEFAULT_RELAY_PORT;
    this.defaultTarget = options.defaultTarget ?? 'bridge';
    this.headlessIdleTimeout = options.headlessIdleTimeout ?? '15m';
    this.maxOutputChars = Math.max(1_000, options.maxOutputChars ?? 40_000);
    this.screenshotFormat = options.screenshotFormat ?? 'jpeg';
    this.screenshotQuality = Math.min(95, Math.max(20, options.screenshotQuality ?? 75));
    this.screenshotDir = options.screenshotDir ?? defaultScreenshotDir();
    this.relayStatusProvider = options.relayStatusProvider ?? ((port) => queryRelayStatus(port));
  }

  /** Check that `agent-browser` exists; cached briefly by the binary module. */
  async probe(): Promise<AgentBrowserProbeResult> {
    return await probeAgentBrowser(this.binaryPath);
  }

  /** Sessions this runtime currently owns, newest last. */
  listSessions(): ManagedSessionInfo[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      .map((entry) => ({
        sessionName: entry.sessionName,
        target: entry.target,
        ...(entry.cdpWsUrl !== undefined ? { cdpWsUrl: entry.cdpWsUrl } : {}),
        lastUsedAt: entry.lastUsedAt,
      }));
  }

  /** Run one `agent-browser` command. */
  async run(input: BrowserRunInput): Promise<BrowserRunResult> {
    const target = input.target ?? this.defaultTarget;
    const binPath = await this.requireBinary();
    const cwd = input.cwd ?? process.cwd();

    const status = target === 'bridge' ? await this.getRelayStatus() : null;
    const validated = this.guard.validate(input.args, {
      target,
      stdin: input.stdin,
      isRemoteBrowser: Boolean(status?.extension?.isRemote),
      cwd,
    });

    const sessionName = this.resolveSessionName(input.session, target, input.dshSessionId);
    const state = this.trackSession(sessionName, target);
    const env = await this.buildEnv();

    if (target === 'bridge') {
      await this.ensureBridgeConnection({ state, status, sessionName, cwd, env, binPath });
    }

    if (input.tab && validated.command !== 'tab') {
      await this.switchTab({ state, tab: input.tab, cwd, env, binPath, target, launchOptions: input.launchOptions });
    }

    const executeOptions: ExecuteOptions = {
      args: validated.args,
      target,
      sessionName,
      state,
      cwd,
      env,
      binPath,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs ?? 30_000,
      signal: input.signal,
      json: input.json,
      contentBoundaries: validated.returnsPageContent,
      launchOptions: input.launchOptions,
      validated,
    };

    let result = await this.execute(executeOptions);
    if (result.code !== 0 && validated.isReadOnly && target === 'bridge' && this.looksLikeConnectionFailure(result)) {
      // The Relay restarted or the extension reconnected: rebuild the CDP session once.
      state.cdpWsUrl = undefined;
      state.relayId = undefined;
      await this.ensureBridgeConnection({
        state,
        status: await this.getRelayStatus(),
        sessionName,
        cwd,
        env,
        binPath,
      });
      result = await this.execute(executeOptions);
    }

    if (result.code !== 0) {
      throw this.buildFailure(result, validated, target);
    }

    state.lastUsedAt = Date.now();
    const data = parseAgentBrowserOutput(result.stdout);
    return {
      text: this.renderText(result, data, validated),
      target,
      sessionName,
      command: validated.command,
      exitCode: result.code,
      data,
      untrustedPageContent: validated.returnsPageContent,
    };
  }

  /** Capture a screenshot and load it for attachment. */
  async screenshot(input: BrowserScreenshotInput): Promise<ScreenshotCapture> {
    const target = input.target ?? this.defaultTarget;
    const binPath = await this.requireBinary();
    const cwd = input.cwd ?? process.cwd();
    const format = input.format ?? this.screenshotFormat;
    const quality = Math.min(95, Math.max(20, input.quality ?? this.screenshotQuality));
    const outputDir = input.outputDir ?? this.screenshotDir;
    await mkdir(outputDir, { recursive: true });

    const args = ['screenshot'];
    if (input.selector) args.push(input.selector);
    if (input.fullPage) args.push('--full');
    if (input.annotate) args.push('--annotate');
    if (input.ifChanged) args.push('--if-changed');

    // Output location, format, and quality are plugin-owned launch flags, never model input.
    const globalArgs = [
      '--screenshot-dir',
      outputDir,
      '--screenshot-format',
      format,
    ];
    if (format === 'jpeg') globalArgs.push('--screenshot-quality', String(quality));

    const validated = this.guard.validate(args, { target, cwd });
    const sessionName = this.resolveSessionName(input.session, target, input.dshSessionId);
    const state = this.trackSession(sessionName, target);
    const env = await this.buildEnv();

    if (target === 'bridge') {
      await this.ensureBridgeConnection({
        state,
        status: await this.getRelayStatus(),
        sessionName,
        cwd,
        env,
        binPath,
      });
    }
    if (input.tab) {
      await this.switchTab({
        state,
        tab: input.tab,
        cwd,
        env,
        binPath,
        target,
        launchOptions: input.launchOptions,
      });
    }

    const result = await this.execute({
      args: validated.args,
      target,
      sessionName,
      state,
      cwd,
      env,
      binPath,
      timeoutMs: input.timeoutMs ?? 30_000,
      signal: input.signal,
      json: true,
      globalArgs,
      launchOptions: input.launchOptions,
      validated,
    });

    if (result.code !== 0) {
      throw this.buildFailure(result, validated, target);
    }

    state.lastUsedAt = Date.now();
    const data = parseAgentBrowserOutput(result.stdout) as
      | { path?: string; changed?: boolean; revision?: number }
      | null;
    const filePath = typeof data?.path === 'string' ? data.path : undefined;
    const changed = data?.changed !== false && filePath !== undefined;

    if (!changed || !filePath) {
      return {
        changed: false,
        text: `No pixel change since the previous ${input.selector ? `capture of ${input.selector}` : 'capture'}; no new image was written.`,
        target,
        sessionName,
      };
    }

    const asset = await readScreenshotAsset(filePath);
    const dims = asset.width > 0 && asset.height > 0 ? `${asset.width}x${asset.height}` : 'unknown size';
    return {
      changed: true,
      filePath,
      mediaType: asset.mediaType,
      base64: asset.base64,
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
      text: `Captured ${asset.mediaType === 'image/jpeg' ? 'JPEG' : 'PNG'} screenshot (${dims}, ${asset.bytes} bytes)\nSaved: ${filePath}`,
      target,
      sessionName,
    };
  }

  /** Close one session and forget it. Returns false when it was not tracked. */
  async closeSession(sessionName: string): Promise<boolean> {
    const state = this.sessions.get(sessionName);
    if (!state) return false;
    this.sessions.delete(sessionName);
    await this.closeSessionProcess(sessionName, state.target);
    return true;
  }

  /** Close every session this runtime started. Safe to call more than once. */
  async dispose(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    for (const [sessionName, state] of entries) {
      await this.closeSessionProcess(sessionName, state.target);
    }
  }

  private async closeSessionProcess(sessionName: string, target: BrowserTarget): Promise<void> {
    const binPath = await this.requireBinary().catch(() => null);
    if (!binPath) return;
    try {
      const env = await this.buildEnv();
      await this.executor.run({
        command: binPath,
        args: ['--session', sessionName, '--json', 'close'],
        env,
        timeoutMs: 15_000,
      });
    } catch {
      // Best effort: a dead daemon needs no cleanup.
    }
    void target;
  }

  private async requireBinary(): Promise<string> {
    const probe = await this.probe();
    if (!probe.available || !probe.path) {
      throw new SecurityError(
        'AGENT_BROWSER_UNAVAILABLE',
        probe.error ?? `agent-browser is not available. ${AGENT_BROWSER_INSTALL_HINT}`,
      );
    }
    return probe.path;
  }

  private async getRelayStatus(): Promise<RelayStatusSnapshot | null> {
    try {
      return await this.relayStatusProvider(this.relayPort);
    } catch {
      return null;
    }
  }

  private resolveSessionName(
    explicit: string | undefined,
    target: BrowserTarget,
    dshSessionId: string | undefined,
  ): string {
    if (explicit !== undefined && explicit !== '') {
      if (!SESSION_NAME_PATTERN.test(explicit)) {
        throw new SecurityError(
          'INVALID_SESSION_NAME',
          `Session names may only contain letters, numbers, "-" and "_" (max 48 characters); got "${explicit}".`,
        );
      }
      return explicit;
    }
    const prefix = target === 'bridge' ? 'dsh-bridge' : target === 'headed' ? 'dsh-headed' : 'dsh-headless';
    return `${prefix}-${sanitizeSessionPart(dshSessionId)}`;
  }

  private trackSession(sessionName: string, target: BrowserTarget): ManagedSessionState {
    const existing = this.sessions.get(sessionName);
    if (existing) {
      if (existing.target !== target) {
        throw new SecurityError(
          'SESSION_TARGET_MISMATCH',
          `Session "${sessionName}" is already bound to target "${existing.target}". Pick another session name for "${target}".`,
        );
      }
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const state: ManagedSessionState = { sessionName, target, lastUsedAt: Date.now() };
    this.sessions.set(sessionName, state);
    return state;
  }

  private async buildEnv(): Promise<NodeJS.ProcessEnv> {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    const socketDir = this.socketDir ?? join(tmpdir(), `dsh-abb-sockets-${uid}`);
    try {
      await mkdir(socketDir, { recursive: true, mode: 0o700 });
    } catch {
      // A read-only temp directory must not block every command.
    }
    return {
      ...process.env,
      AGENT_BROWSER_NAMESPACE: this.namespace,
      AGENT_BROWSER_SOCKET_DIR: socketDir,
      AGENT_BROWSER_NO_VERSION_CHECK: '1',
    };
  }

  private async ensureBridgeConnection(context: {
    state: ManagedSessionState;
    status: RelayStatusSnapshot | null;
    sessionName: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    binPath: string;
  }): Promise<void> {
    const { state, status, sessionName, cwd, env, binPath } = context;

    if (!status) {
      throw new SecurityError(
        'RELAY_UNAVAILABLE',
        `The browser Relay is not reachable on ${this.relayHost}:${this.relayPort}. Start the plugin's managed Relay, or use target "headless" to run an isolated browser instead.`,
      );
    }
    if (!status.extensionConnected) {
      throw new SecurityError(
        'EXTENSION_DISCONNECTED',
        `The Relay is running on ${status.host}:${status.port}, but no browser extension is connected. Click the Agent Browser Bridge extension icon in Chrome/Edge/Brave and connect, or use target "headless" for an isolated browser.`,
      );
    }

    const upToDate =
      state.cdpWsUrl === status.cdpWsUrl && state.relayId === status.relayId;
    if (upToDate) return;

    if (state.cdpWsUrl !== undefined) {
      // The Relay restarted (new CDP secret): drop the stale local daemon first.
      await this.closeSessionProcess(sessionName, state.target);
    }

    const result = await this.executor.run({
      command: binPath,
      args: ['--session', sessionName, '--json', 'connect', status.cdpWsUrl],
      cwd,
      env,
      timeoutMs: 20_000,
    });
    if (result.code !== 0) {
      throw this.buildFailure(
        result,
        {
          args: ['connect'],
          command: 'connect',
          isReadOnly: false,
          returnsPageContent: false,
          switchesTab: false,
        },
        'bridge',
      );
    }
    state.cdpWsUrl = status.cdpWsUrl;
    state.relayId = status.relayId;
  }

  private async switchTab(context: {
    state: ManagedSessionState;
    tab: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    binPath: string;
    target: BrowserTarget;
    launchOptions?: LaunchOptions | undefined;
  }): Promise<void> {
    const validated = this.guard.validate(['tab', context.tab], { target: context.target });
    const result = await this.execute({
      args: validated.args,
      target: context.target,
      sessionName: context.state.sessionName,
      state: context.state,
      cwd: context.cwd,
      env: context.env,
      binPath: context.binPath,
      timeoutMs: 20_000,
      launchOptions: context.launchOptions,
      validated,
    });
    if (result.code !== 0) {
      throw this.buildFailure(result, validated, context.target);
    }
  }

  private buildGlobalArgs(options: ExecuteOptions): string[] {
    const out: string[] = [];

    if (options.target === 'headed') {
      out.push('--headed');
    }
    if (options.target !== 'bridge') {
      out.push('--idle-timeout', this.headlessIdleTimeout);
      const launch = options.launchOptions;
      if (launch?.enable && launch.enable.length > 0) out.push('--enable', launch.enable.join(','));
      if (launch?.allowedDomains && launch.allowedDomains.length > 0) {
        out.push('--allowed-domains', launch.allowedDomains.join(','));
      }
      if (launch?.colorScheme) out.push('--color-scheme', launch.colorScheme);
      if (launch?.ignoreHttpsErrors) out.push('--ignore-https-errors');
      if (launch?.restore === true) out.push('--restore');
      else if (typeof launch?.restore === 'string' && launch.restore.length > 0) {
        out.push('--restore', launch.restore);
      }
    }

    out.push('--session', options.sessionName);
    if (options.json) out.push('--json');
    if (options.contentBoundaries) {
      out.push('--content-boundaries', '--max-output', String(this.maxOutputChars));
    }
    if (options.globalArgs) out.push(...options.globalArgs);
    return out;
  }

  private async execute(options: ExecuteOptions): Promise<CommandExecutorResult> {
    const args = [...this.buildGlobalArgs(options), ...options.args];
    return await this.executor.run({
      command: options.binPath,
      args,
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal,
    });
  }

  private looksLikeConnectionFailure(result: CommandExecutorResult): boolean {
    const detail = `${result.stderr}\n${result.stdout}`;
    return CONNECTION_FAILURE_PATTERN.test(detail);
  }

  private buildFailure(
    result: CommandExecutorResult,
    validated: ValidatedCommand,
    target: BrowserTarget,
  ): Error {
    const detail = (result.stderr || result.stdout || '').trim();
    const hint = /could not find (chrome|chromium)|no browser|install/i.test(detail)
      ? target === 'bridge'
        ? ''
        : `\n\nInstall the managed browser with \`agent-browser install\` (on Linux add \`--with-deps\`).`
      : '';
    return new Error(
      `agent-browser ${validated.args.join(' ')} failed (exit ${result.code}).${detail ? `\n${detail}` : ''}${hint}`,
    );
  }

  private renderText(
    result: CommandExecutorResult,
    data: unknown,
    validated: ValidatedCommand,
  ): string {
    const raw = result.stdout.trim() || result.stderr.trim();
    const body = data !== null ? JSON.stringify(stripLifecycle(data), null, 2) : raw;
    if (body.length === 0) {
      return `agent-browser ${validated.args.join(' ')} completed with no output.`;
    }
    const capped =
      body.length > this.maxOutputChars
        ? `${body.slice(0, this.maxOutputChars)}\n\n(truncated at ${this.maxOutputChars} characters)`
        : body;
    return validated.returnsPageContent ? `${UNTRUSTED_PAGE_CONTENT_NOTICE}\n${capped}` : capped;
  }
}
