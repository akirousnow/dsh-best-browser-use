import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Which browser a command runs against. */
export type BrowserTarget = 'bridge' | 'headless' | 'headed';

/** Policy knobs for the command guard. */
export interface CommandPolicyConfig {
  /** Only allow observation commands (no navigation, clicks, fills, eval, credentials). */
  readOnly?: boolean;
  /** Allow launching an isolated headless browser for project automation. */
  allowHeadless?: boolean;
  /** Allow launching an isolated headed browser. */
  allowHeaded?: boolean;
  /** Allow `eval`-style JavaScript in the user's real (bridge) browser. Default false. */
  allowEvalInBridge?: boolean;
  /** Allow `eval`-style JavaScript in an isolated headless/headed browser. Default true. */
  allowEvalInHeadless?: boolean;
  /** Allow reading cookies/storage/auth state from the user's real browser. Default false. */
  allowSensitiveInBridge?: boolean;
  /** Allow navigating to `file://` URLs. Default false. */
  allowFileUrls?: boolean;
  /** Optional allowlist of directories that uploads may read from. */
  allowedUploadRoots?: string[];
}

/** Context a command is validated against. */
export interface CommandValidationContext {
  target: BrowserTarget;
  stdin?: string | undefined;
  /** True when the connected extension runs on another machine. */
  isRemoteBrowser?: boolean;
  /** Working directory used to resolve upload paths. */
  cwd?: string | undefined;
}

/** Result of validating one command line. */
export interface ValidatedCommand {
  /** The command as given (normalized, unchanged). */
  args: string[];
  /** Primary subcommand, e.g. `snapshot`, `tab`, `batch`. */
  command: string;
  /** Secondary word for grouped commands, e.g. `list` for `tab list`. */
  subcommand?: string;
  /** True when the command cannot change page or browser state. */
  isReadOnly: boolean;
  /** True when the output is untrusted page content. */
  returnsPageContent: boolean;
  /** True when the command itself switches the active tab. */
  switchesTab: boolean;
}

export class SecurityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}

/**
 * Global flags the model must never set: they change which browser is driven,
 * how it is launched, or where credentials and policy come from.
 */
const HOST_ONLY_FLAGS = new Set([
  '--cdp',
  '--cdp-headers',
  '--auto-connect',
  '--no-auto-connect',
  '--config',
  '--executable-path',
  '--extension',
  '--init-script',
  '--enable',
  '--args',
  '--profile',
  '--provider',
  '-p',
  '--session',
  '--namespace',
  '--action-policy',
  '--confirm-actions',
  '--confirm-interactive',
  '--proxy',
  '--proxy-bypass',
  '--ca-cert',
  '--no-ca-cert',
  '--use-system-ca',
  '--allow-file-access',
  '--engine',
  '--headed',
  '--pin-tab',
  '--no-pin-tab',
  '--download-path',
  '--screenshot-dir',
  '--screenshot-format',
  '--screenshot-quality',
  '--state',
  '--headers',
  '--user-agent',
  '--restore',
  '--restore-save',
  '--restore-check-url',
  '--restore-check-text',
  '--restore-check-fn',
  '--idle-timeout',
  '--relaunch',
  '--webgpu',
  '--no-webmcp',
  '--hide-scrollbars',
  '--content-boundaries',
  '--max-output',
  '--color-scheme',
  '--ignore-https-errors',
  '--input-mode',
  '--allowed-domains',
]);

/** Subcommands that manage the host installation or open host surfaces. */
const HOST_ONLY_COMMANDS = new Set([
  'connect',
  'install',
  'upgrade',
  'plugin',
  'dashboard',
  'mcp',
  'chat',
  'doctor',
  'confirm',
  'deny',
  'inspect',
  'removeinitscript',
]);

/** Commands that execute arbitrary JavaScript in the page. */
const EVAL_COMMANDS = new Set(['eval']);

/** Commands that read or write credentials and persisted auth state. */
const CREDENTIAL_COMMANDS = new Set(['cookies', 'storage', 'state', 'auth']);

/** Commands whose output is page content and must be treated as untrusted data. */
const PAGE_CONTENT_COMMANDS = new Set([
  'snapshot',
  'read',
  'get',
  'console',
  'errors',
  'network',
  'a11y',
  'vitals',
  'react',
  'eval',
  'diff',
]);

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set([
  '--depth',
  '--selector',
  '-s',
  '--timeout',
  '--wait-timeout',
  '--url',
  '--load',
  '--fn',
  '--text',
  '-t',
  '--text-gone',
  '--ms',
  '--prompt',
  '--quality',
  '--state',
  '--threshold',
  '--screenshot-dir',
  '--screenshot-quality',
  '--screenshot-format',
  '--session',
  '--namespace',
  '--cdp',
  '--cdp-headers',
  '--config',
  '--profile',
  '--provider',
  '-p',
  '--engine',
  '--proxy',
  '--proxy-bypass',
  '--executable-path',
  '--extension',
  '--init-script',
  '--enable',
  '--args',
  '--user-agent',
  '--headers',
  '--download-path',
  '--idle-timeout',
  '--max-output',
  '--color-scheme',
  '--allowed-domains',
  '--action-policy',
  '--confirm-actions',
  '--input-mode',
  '--label',
  '--from',
  '--to',
  '--output',
  '--param',
  '--where',
  '--fields',
  '--limit',
  '--origin',
  '--allow-write',
  '--baseline',
  '-b',
  '--delay',
  '--fps',
  '--contact-sheet-threshold',
  '--tags',
  '--frame',
  '--item',
  '--username-selector',
  '--password-selector',
  '--submit-selector',
  '--credential-provider',
  '--username',
  '--password',
  '--domain',
  '--path',
  '--http-only',
  '--secure',
  '--same-site',
  '--expires',
  '--curl',
  '--host',
  '--port',
  '--token',
  '--ext-path',
]);

interface ParsedCommand {
  command: string;
  subcommand?: string;
  positionals: string[];
  flags: Set<string>;
}

/** Split a command string into argv, honouring single and double quotes. */
export function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        out.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) out.push(current);
  return out;
}

function parseCommand(args: readonly string[]): ParsedCommand {
  const positionals: string[] = [];
  const flags = new Set<string>();
  let literal = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (literal) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      flags.add(name);
      if (eq === -1 && VALUE_FLAGS.has(name)) i++;
      continue;
    }
    positionals.push(arg);
  }

  const command = positionals[0] ?? '';
  const subcommand = positionals[1];
  return { command, subcommand, positionals, flags };
}

function looksLikeUrl(value: string): boolean {
  return value.includes('://') || /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(value);
}

function normalizeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(value)) {
      try {
        return new URL(`https://${value}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

const READ_ONLY_COMMANDS = new Set([
  'snapshot',
  'read',
  'get',
  'is',
  'screenshot',
  'wait',
  'console',
  'errors',
  'diff',
  'a11y',
  'vitals',
  'react',
  'skills',
  'session',
  'frame',
  'highlight',
  'clipboard',
  'network',
  'dialog',
  'scroll',
  'scrollintoview',
  'tab',
  'batch',
]);

const READ_ONLY_NETWORK_SUBCOMMANDS = new Set(['requests', 'request']);
const READ_ONLY_DIFF_SUBCOMMANDS = new Set(['snapshot', 'screenshot']);
const READ_ONLY_REACT_SUBCOMMANDS = new Set(['tree', 'inspect', 'suspense', 'renders']);
const READ_ONLY_SKILLS_SUBCOMMANDS = new Set(['list', 'get', 'path', '']);
const READ_ONLY_SESSION_SUBCOMMANDS = new Set(['list', 'info', '']);
const READ_ONLY_WEBMCP_SUBCOMMANDS = new Set(['list']);

/**
 * Validates every `agent-browser` command line before it reaches the child process.
 *
 * The guard is deliberately allow-by-policy: a command must pass the global flag scan,
 * the host-command scan, the per-target capability gates, and — in read-only mode —
 * an explicit observation whitelist.
 */
export class CommandPolicyGuard {
  readonly readOnly: boolean;
  readonly allowHeadless: boolean;
  readonly allowHeaded: boolean;
  readonly allowEvalInBridge: boolean;
  readonly allowEvalInHeadless: boolean;
  readonly allowSensitiveInBridge: boolean;
  readonly allowFileUrls: boolean;
  readonly allowedUploadRoots: string[] | undefined;

  constructor(config: CommandPolicyConfig = {}) {
    this.readOnly = config.readOnly ?? false;
    this.allowHeadless = config.allowHeadless ?? true;
    this.allowHeaded = config.allowHeaded ?? true;
    this.allowEvalInBridge = config.allowEvalInBridge ?? false;
    this.allowEvalInHeadless = config.allowEvalInHeadless ?? true;
    this.allowSensitiveInBridge = config.allowSensitiveInBridge ?? false;
    this.allowFileUrls = config.allowFileUrls ?? false;
    this.allowedUploadRoots = config.allowedUploadRoots?.map((root) => resolve(root));
  }

  /**
   * Validate one command (or one batch) and describe what it does.
   * @param args - argv for `agent-browser`, without the binary itself.
   * @param context - target, stdin payload, remote flag, and working directory.
   * @returns the normalized command description.
   * @throws SecurityError when the command violates policy.
   */
  validate(args: readonly string[], context: CommandValidationContext): ValidatedCommand {
    if (!Array.isArray(args) || args.length === 0) {
      throw new SecurityError('EMPTY_COMMAND', 'The `args` array must contain at least one agent-browser command.');
    }
    const argv = args.map((arg) => String(arg));
    this.assertTargetAllowed(context.target);

    const parsed = parseCommand(argv);
    if (!parsed.command) {
      throw new SecurityError('EMPTY_COMMAND', 'The `args` array must start with an agent-browser command.');
    }
    this.assertFlagsAllowed(parsed);
    if (argv[0]!.startsWith('-')) {
      throw new SecurityError(
        'FLAG_FIRST',
        `The first element of \`args\` must be a command, not the flag "${argv[0]}".`,
      );
    }

    this.assertCommandAllowed(parsed);

    const nested = this.collectBatchCommands(parsed, context);    if (nested.length > 0) {
      for (const sub of nested) {
        if (sub.command === 'batch') {
          throw new SecurityError('NESTED_BATCH', '`batch` cannot be nested inside another `batch`.');
        }
        this.assertFlagsAllowed(sub);
        this.assertCommandAllowed(sub);
      }
    }

    const commands = nested.length > 0 ? nested : [parsed];
    const isReadOnly = commands.every((entry) => this.isReadOnlyCommand(entry));
    if (this.readOnly && !isReadOnly) {
      throw new SecurityError(
        'READ_ONLY_MODE',
        `The command "${argv.join(' ')}" is blocked because this plugin runs in read-only mode. Only observation commands (tab list, snapshot, read, get, wait, screenshot, console, errors, network requests, diff snapshot, a11y, vitals) are permitted.`,
      );
    }

    for (const entry of commands) {
      this.assertEvalAllowed(entry, context);
      this.assertCredentialAllowed(entry, context);
      this.assertNavigationAllowed(entry, context);
      this.assertUploadAllowed(entry, context);
    }

    return {
      args: argv,
      command: parsed.command,
      ...(parsed.subcommand !== undefined ? { subcommand: parsed.subcommand } : {}),
      isReadOnly,
      returnsPageContent: commands.some((entry) => PAGE_CONTENT_COMMANDS.has(entry.command)),
      switchesTab: parsed.command === 'tab' && this.isTabSwitch(parsed),
    };
  }

  /** True when `tab <ref>` (not `tab`, `tab list`, `tab new`, `tab close`). */
  isTabSwitch(parsed: ParsedCommand): boolean {
    if (parsed.command !== 'tab') return false;
    const op = parsed.subcommand;
    if (op === undefined) return false;
    return op !== 'list' && op !== 'new' && op !== 'close' && op !== 'window';
  }

  private assertTargetAllowed(target: BrowserTarget): void {
    if (target === 'headless' && !this.allowHeadless) {
      throw new SecurityError(
        'HEADLESS_DISABLED',
        'Headless browser targets are disabled by this plugin configuration (allowHeadless: false).',
      );
    }
    if (target === 'headed' && !this.allowHeaded) {
      throw new SecurityError(
        'HEADED_DISABLED',
        'Headed browser targets are disabled by this plugin configuration (allowHeaded: false).',
      );
    }
  }

  private assertFlagsAllowed(parsed: ParsedCommand): void {
    for (const flag of parsed.flags) {
      if (HOST_ONLY_FLAGS.has(flag)) {
        throw new SecurityError(
          'HOST_ONLY_FLAG',
          `The flag "${flag}" is managed by the plugin and cannot be set by the model. Use the tool parameters (target, session, launchOptions) instead.`,
        );
      }
    }
  }

  private assertCommandAllowed(parsed: ParsedCommand): void {
    if (HOST_ONLY_COMMANDS.has(parsed.command)) {
      throw new SecurityError(
        'HOST_ONLY_COMMAND',
        `The command "${parsed.command}" manages the local installation or host surfaces and is not available as a browser tool.`,
      );
    }
    if (parsed.command === 'get' && parsed.subcommand === 'cdp-url') {
      throw new SecurityError(
        'HOST_ONLY_COMMAND',
        '`get cdp-url` exposes the local CDP endpoint and is not available as a browser tool.',
      );
    }
  }

  private isReadOnlyCommand(parsed: ParsedCommand): boolean {
    if (!READ_ONLY_COMMANDS.has(parsed.command)) return false;

    switch (parsed.command) {
      case 'tab': {
        const op = parsed.subcommand;
        if (op === undefined || op === 'list') return true;
        return this.isTabSwitch(parsed);
      }
      case 'network':
        return READ_ONLY_NETWORK_SUBCOMMANDS.has(parsed.subcommand ?? '') && !parsed.flags.has('--clear');
      case 'diff':
        return READ_ONLY_DIFF_SUBCOMMANDS.has(parsed.subcommand ?? '');
      case 'react':
        return READ_ONLY_REACT_SUBCOMMANDS.has(parsed.subcommand ?? '');
      case 'skills':
        return READ_ONLY_SKILLS_SUBCOMMANDS.has(parsed.subcommand ?? '');
      case 'session':
        return READ_ONLY_SESSION_SUBCOMMANDS.has(parsed.subcommand ?? '');
      case 'dialog':
        return parsed.subcommand === 'status';
      case 'wait':
        // `wait --fn` runs JavaScript in the page.
        return !parsed.flags.has('--fn') && !parsed.flags.has('--download');
      case 'console':
      case 'errors':
        return !parsed.flags.has('--clear');
      case 'clipboard':
        return parsed.subcommand === 'read';
      case 'get':
        return parsed.subcommand !== 'cdp-url';
      case 'a11y':
      case 'vitals':
        // A URL argument navigates the tab.
        return parsed.positionals.length <= 1;
      case 'batch':
        return true;
      default:
        return true;
    }
  }

  private collectBatchCommands(parsed: ParsedCommand, context: CommandValidationContext): ParsedCommand[] {
    if (parsed.command !== 'batch') return [];
    const out: ParsedCommand[] = [];

    for (const entry of parsed.positionals.slice(1)) {
      const argv = splitCommandLine(entry);
      if (argv.length > 0) out.push(parseCommand(argv));
    }

    const stdin = context.stdin?.trim();
    if (stdin) {
      let payload: unknown;
      try {
        payload = JSON.parse(stdin);
      } catch {
        throw new SecurityError('INVALID_BATCH_STDIN', '`batch` stdin must be a JSON array of command arrays.');
      }
      if (!Array.isArray(payload)) {
        throw new SecurityError('INVALID_BATCH_STDIN', '`batch` stdin must be a JSON array of command arrays.');
      }
      for (const row of payload) {
        if (Array.isArray(row)) {
          const argv = row.map((item) => String(item));
          if (argv.length > 0) out.push(parseCommand(argv));
        } else if (typeof row === 'string') {
          const argv = splitCommandLine(row);
          if (argv.length > 0) out.push(parseCommand(argv));
        } else {
          throw new SecurityError(
            'INVALID_BATCH_STDIN',
            'Each `batch` stdin row must be a string or an array of strings.',
          );
        }
      }
    }

    return out;
  }

  private assertEvalAllowed(parsed: ParsedCommand, context: CommandValidationContext): void {
    const runsJs =
      EVAL_COMMANDS.has(parsed.command) ||
      (parsed.command === 'wait' && parsed.flags.has('--fn')) ||
      (parsed.command === 'webmcp' && parsed.subcommand === 'invoke') ||
      (parsed.command === 'flow' && parsed.subcommand === 'run');
    if (!runsJs) return;

    const allowed = context.target === 'bridge' ? this.allowEvalInBridge : this.allowEvalInHeadless;
    if (!allowed) {
      throw new SecurityError(
        'EVAL_DISABLED',
        context.target === 'bridge'
          ? 'Running JavaScript in the user\'s real browser is disabled (allowEvalInBridge: false). Use target "headless" for scripted checks, or enable it in the plugin settings.'
          : 'Running JavaScript is disabled for this browser target (allowEvalInHeadless: false).',
      );
    }
  }

  private assertCredentialAllowed(parsed: ParsedCommand, context: CommandValidationContext): void {
    if (!CREDENTIAL_COMMANDS.has(parsed.command)) return;
    if (context.target !== 'bridge') return;
    if (this.allowSensitiveInBridge) return;
    throw new SecurityError(
      'CREDENTIAL_ACCESS_BLOCKED',
      `The command "${parsed.command}" can read or overwrite credentials. It is blocked against the user's real browser (allowSensitiveInBridge: false); use an isolated headless browser for credential fixtures.`,
    );
  }

  private assertNavigationAllowed(parsed: ParsedCommand, context: CommandValidationContext): void {
    // `tab new <url>` and `diff url <a> <b>` carry a subcommand word before their operands.
    const words = parsed.positionals.slice(1);
    const operands =
      parsed.command === 'tab' || parsed.command === 'diff' ? words.slice(1) : words;
    const urls: string[] = [];

    switch (parsed.command) {
      case 'open':
      case 'goto':
      case 'navigate':
      case 'pushstate':
        if (operands[0]) urls.push(operands[0]);
        break;
      case 'tab':
        if (parsed.subcommand === 'new' && operands[0]) urls.push(operands[0]);
        break;
      case 'read':
        if (operands[0] && looksLikeUrl(operands[0])) urls.push(operands[0]);
        break;
      case 'a11y':
      case 'vitals':
        if (operands[0] && looksLikeUrl(operands[0])) urls.push(operands[0]);
        break;
      case 'diff':
        if (parsed.subcommand === 'url') {
          urls.push(...operands.slice(0, 2));
        }
        break;
      default:
        break;
    }

    for (const raw of urls) {
      this.assertUrlAllowed(raw, context.target);
    }
  }

  private assertUrlAllowed(raw: string, target: BrowserTarget): void {
    if (raw === 'about:blank') return;
    const parsedUrl = normalizeUrl(raw);
    if (!parsedUrl) {
      throw new SecurityError('INVALID_URL', `"${raw}" is not a valid http(s) URL.`);
    }

    const allowed = new Set(['http:', 'https:', 'about:']);
    if (this.allowFileUrls) allowed.add('file:');
    if (target !== 'bridge') allowed.add('data:');

    if (!allowed.has(parsedUrl.protocol)) {
      throw new SecurityError(
        'BLOCKED_PROTOCOL',
        `Navigation to "${parsedUrl.protocol}" URLs is blocked for safety. Use http(s) URLs${target === 'bridge' ? '' : ', about:, or data:text/html'}.`,
      );
    }
    if (parsedUrl.protocol === 'data:' && !/^data:text\/html/i.test(raw)) {
      throw new SecurityError('BLOCKED_PROTOCOL', 'Only `data:text/html` URLs are allowed.');
    }
  }

  private assertUploadAllowed(parsed: ParsedCommand, context: CommandValidationContext): void {
    if (parsed.command !== 'upload') return;

    if (context.target === 'bridge' && context.isRemoteBrowser) {
      throw new SecurityError(
        'REMOTE_UPLOAD_BLOCKED',
        'A remote browser cannot read files from this machine. Run the upload against a local browser or an isolated headless browser instead.',
      );
    }

    const files = parsed.positionals.slice(2);
    if (files.length === 0) return;
    const baseCwd = context.cwd ?? process.cwd();

    for (const raw of files) {
      const resolved = isAbsolute(raw) ? resolve(raw) : resolve(baseCwd, raw);
      if (this.allowedUploadRoots && this.allowedUploadRoots.length > 0) {
        const permitted = this.allowedUploadRoots.some(
          (root) => resolved === root || resolved.startsWith(`${root}/`),
        );
        if (!permitted) {
          throw new SecurityError(
            'UPLOAD_PATH_OUTSIDE_ROOT',
            `Upload path "${raw}" is outside the configured allowedUploadRoots.`,
          );
        }
      }
      if (!existsSync(resolved)) {
        throw new SecurityError('UPLOAD_FILE_NOT_FOUND', `Upload file not found: "${raw}"`);
      }
    }
  }
}
