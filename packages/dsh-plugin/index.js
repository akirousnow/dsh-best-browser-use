import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = dirname(fileURLToPath(import.meta.url));

/**
 * The engine, Relay, and protocol live in a built bundle. A linked (unpacked) plugin is
 * reloaded in place, but Node hands back the cached module for the same specifier, so the
 * bundle is imported per activation through a query derived from its mtime. Rebuild
 * `dist/bridge.mjs` and reload the plugin: the new runtime is used without a restart.
 */
const bridgeBundleUrl = new URL('./dist/bridge.mjs', import.meta.url);

async function loadBridgeModule() {
  const version = await stat(bridgeBundleUrl)
    .then((info) => Math.round(info.mtimeMs).toString(36))
    .catch(() => '0');
  return await import(`${bridgeBundleUrl.href}?v=${version}`);
}

// Mirrors the protocol defaults; the config schema needs them before any bundle loads.
const DEFAULT_RELAY_HOST = '127.0.0.1';
const DEFAULT_RELAY_PORT = 9229;
const DEFAULT_EXT_PATH = '/ext';

const EXTENSION_ZIP_PATH = join(pkgDir, 'assets', 'agent-browser-bridge-extension.zip');
const CONTROL_ACTIONS = new Set([
  'detach_tab',
  'attach_tab',
  'set_mode',
  'refresh_tabs',
  'close_session',
]);
const SKILL_NAME = 'browser-bridge';

async function loadSchemastery() {
  try {
    const mod = await import('@deepseek-ai/schemastery');
    return mod.default ?? mod;
  } catch {
    const installDir = process.env.DSH_INSTALL_DIR;
    if (installDir) {
      try {
        const mod = await import(
          pathToFileURL(join(installDir, 'node_modules/@deepseek-ai/schemastery/lib/index.mjs')).href
        );
        return mod.default ?? mod;
      } catch {
        // Optional outside the DSH runtime.
      }
    }
    return null;
  }
}

const z = await loadSchemastery();

export const name = 'agent-browser-bridge';
export const inject = ['tools', 'systemPrompt'];

export const Config = z
  ? z.object({
      // --- Relay (browser extension bridge) ---
      host: z
        .string()
        .default(DEFAULT_RELAY_HOST)
        .description(
          'Bind address for the managed CDP Relay (127.0.0.1 for local, 0.0.0.0 for remote browser connections).',
        ),
      port: z
        .natural()
        .min(1)
        .max(65535)
        .default(DEFAULT_RELAY_PORT)
        .description('Port for the CDP Relay (1–65535, default 9229).'),
      extPath: z
        .string()
        .default(DEFAULT_EXT_PATH)
        .description('WebSocket path used by the browser extension (default /ext).'),
      token: z
        .string()
        .default('')
        .description(
          'Optional auth token on loopback; required (auto-generated if blank) when host is non-loopback.',
        ),
      manageRelay: z
        .boolean()
        .default(true)
        .description(
          'Start an embedded Relay automatically if none is already listening on the configured port.',
        ),

      // --- agent-browser runtime ---
      defaultTarget: z
        .union([z.const('bridge'), z.const('headless'), z.const('headed')])
        .default('bridge')
        .description(
          'Default browser for `browser` calls: "bridge" drives the user\'s real browser, "headless"/"headed" launch an isolated browser for project automation.',
        ),
      allowHeadless: z
        .boolean()
        .default(true)
        .description('Allow the model to launch isolated headless browsers.'),
      allowHeaded: z
        .boolean()
        .default(true)
        .description('Allow the model to launch isolated visible (headed) browsers.'),
      binaryPath: z
        .string()
        .default('')
        .description(
          'Absolute path to the agent-browser executable. Blank resolves AGENT_BROWSER_BIN, then PATH.',
        ),
      socketDir: z
        .string()
        .default('')
        .description(
          'Writable directory for agent-browser daemon sockets. Blank uses a per-user temp directory, which keeps working when $HOME is read-only.',
        ),
      headlessIdleTimeout: z
        .string()
        .default('15m')
        .description('Idle timeout for isolated browsers, e.g. "15m", "1h", or "0" to disable.'),
      maxOutputChars: z
        .natural()
        .min(4000)
        .default(40000)
        .description('Maximum characters of page output returned per command.'),
      pinTabInBridge: z
        .boolean()
        .default(false)
        .description(
          'Pin each bridge session to its own tab. Off by default so the user\'s current tab stays usable.',
        ),

      // --- Safety ---
      readOnly: z
        .boolean()
        .default(false)
        .description(
          'Restrict the model to observation commands (tab list, snapshot, read, get, wait, screenshot, console, errors, network requests, diff, a11y, vitals).',
        ),
      allowEvalInBridge: z
        .boolean()
        .default(false)
        .description(
          'Allow eval-style JavaScript (eval, wait --fn, webmcp invoke) against the user\'s real browser.',
        ),
      allowEvalInHeadless: z
        .boolean()
        .default(true)
        .description('Allow eval-style JavaScript in isolated headless/headed browsers.'),
      allowSensitiveInBridge: z
        .boolean()
        .default(false)
        .description(
          'Allow cookies/storage/state/auth commands against the user\'s real browser.',
        ),
      allowFileUrls: z
        .boolean()
        .default(false)
        .description('Allow navigating to file:// URLs.'),

      // --- Screenshots ---
      screenshotFormat: z
        .union([z.const('jpeg'), z.const('png')])
        .default('jpeg')
        .description('Default screenshot format.'),
      screenshotQuality: z
        .natural()
        .min(20)
        .max(95)
        .default(75)
        .description('Default JPEG quality for screenshots (20–95).'),
      registerSkill: z
        .boolean()
        .default(true)
        .description('Register the bundled `browser-bridge` skill when the skills service is present.'),
    })
  : undefined;

const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
  },
  required: ['text'],
};

const SCREENSHOT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    filePath: { type: 'string' },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
    },
  },
  required: ['text', 'filePath'],
};

const TARGET_SCHEMA = {
  type: 'string',
  enum: ['bridge', 'headless', 'headed'],
  description:
    '"bridge" drives the browser the user is signed in to; "headless"/"headed" launch an isolated browser for project automation and tests.',
};

const SESSION_SCHEMA = {
  type: 'string',
  description:
    'Optional isolated session name (letters, digits, "-", "_"). Defaults to one session per conversation and target. Use distinct names to run roles in parallel, e.g. "admin" and "viewer".',
};

const TAB_SCHEMA = {
  type: 'string',
  description:
    'Optional tab to act on: a $tN ref from the picker, a tab label, or the targetId printed in a [Browser Tab ...] reference. Switches the session to that tab first.',
};

const LAUNCH_OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Launch settings for isolated browsers only (ignored for target "bridge").',
  properties: {
    enable: {
      type: 'array',
      items: { type: 'string' },
      description: 'Built-in init features, e.g. ["react-devtools"].',
    },
    allowedDomains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Restrict browser and read traffic to these domain patterns.',
    },
    colorScheme: {
      type: 'string',
      enum: ['dark', 'light', 'no-preference'],
      description: 'Emulated color scheme.',
    },
    ignoreHttpsErrors: { type: 'boolean', description: 'Ignore HTTPS certificate errors.' },
    restore: {
      description: 'Persist and restore cookies and localStorage: true keys by session, or pass an explicit key.',
      oneOf: [{ type: 'boolean' }, { type: 'string' }],
    },
  },
};

function objectParams(properties, required) {
  return {
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function truncateLabel(value, maxLen = 72) {
  const s = String(value ?? '');
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

async function routeSupportsImages(ctx, exec) {
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? exec?.agent?.options?.provider;
    const model = routed?.model ?? exec?.agent?.options?.model;
    const llm = ctx.get('llm');
    if (!provider || !model || !llm) return false;
    const info = await llm.resolveModelInfo(provider, model, exec?.signal);
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
  } catch {
    return false;
  }
}

async function resolveCwd(ctx, exec) {
  try {
    const wd = ctx.get('workingDirectory');
    if (wd && typeof wd.ensure === 'function' && exec?.agent) {
      return await wd.ensure(exec.agent, exec.signal);
    }
  } catch {
    // Fall back to the Host process directory.
  }
  return process.cwd();
}

function sessionIdOf(exec) {
  const id = exec?.agent?.sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > 64 * 1024) throw new Error('Body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object');
  }
  return parsed;
}

function writeJson(res, status, data, headOnly = false) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
  });
  res.end(headOnly ? undefined : payload);
}

function isSameOriginMutation(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function apply(ctx, config) {
  const {
    AGENT_BROWSER_BRIDGE_READONLY_SYSTEM_PROMPT,
    AGENT_BROWSER_BRIDGE_SYSTEM_PROMPT,
    AGENT_BROWSER_INSTALL_HINT,
    AgentBrowserRuntime,
    BROWSER_BRIDGE_SKILL_CONTENT,
    RelayServer,
    probeAgentBrowser,
    queryRelayStatus,
  } = await loadBridgeModule();

  const cfg = {
    host: config?.host ?? DEFAULT_RELAY_HOST,
    port: Math.max(1, Math.min(65535, Number(config?.port ?? DEFAULT_RELAY_PORT) || DEFAULT_RELAY_PORT)),
    extPath: config?.extPath ?? DEFAULT_EXT_PATH,
    token: config?.token ?? '',
    manageRelay: config?.manageRelay ?? true,
    defaultTarget: config?.defaultTarget ?? 'bridge',
    allowHeadless: config?.allowHeadless ?? true,
    allowHeaded: config?.allowHeaded ?? true,
    binaryPath: config?.binaryPath ?? '',
    socketDir: config?.socketDir ?? '',
    headlessIdleTimeout: config?.headlessIdleTimeout ?? '15m',
    maxOutputChars: Math.max(4000, Number(config?.maxOutputChars ?? 40000) || 40000),
    pinTabInBridge: config?.pinTabInBridge ?? false,
    readOnly: config?.readOnly ?? false,
    allowEvalInBridge: config?.allowEvalInBridge ?? false,
    allowEvalInHeadless: config?.allowEvalInHeadless ?? true,
    allowSensitiveInBridge: config?.allowSensitiveInBridge ?? false,
    allowFileUrls: config?.allowFileUrls ?? false,
    screenshotFormat: config?.screenshotFormat ?? 'jpeg',
    screenshotQuality: Math.max(20, Math.min(95, Number(config?.screenshotQuality ?? 75) || 75)),
    registerSkill: config?.registerSkill ?? true,
  };

  let managedRelay = null;
  let relayStartupError = null;
  let disposed = false;

  const runtime = new AgentBrowserRuntime({
    policy: {
      readOnly: cfg.readOnly,
      allowHeadless: cfg.allowHeadless,
      allowHeaded: cfg.allowHeaded,
      allowEvalInBridge: cfg.allowEvalInBridge,
      allowEvalInHeadless: cfg.allowEvalInHeadless,
      allowSensitiveInBridge: cfg.allowSensitiveInBridge,
      allowFileUrls: cfg.allowFileUrls,
    },
    binaryPath: cfg.binaryPath,
    socketDir: cfg.socketDir,
    relayHost: cfg.host,
    relayPort: cfg.port,
    relayToken: cfg.token,
    defaultTarget: cfg.defaultTarget,
    headlessIdleTimeout: cfg.headlessIdleTimeout,
    maxOutputChars: cfg.maxOutputChars,
    screenshotFormat: cfg.screenshotFormat,
    screenshotQuality: cfg.screenshotQuality,
  });

  const relayReadyPromise = (async () => {
    const existing = await queryRelayStatus(cfg.port, 1000);
    if (existing) {
      return existing;
    }
    if (!cfg.manageRelay || disposed) {
      return null;
    }
    try {
      const server = new RelayServer({
        host: cfg.host,
        port: cfg.port,
        extPath: cfg.extPath,
        token: cfg.token || undefined,
        logger: {
          info: (...a) => ctx.logger?.info?.(...a),
          warn: (...a) => ctx.logger?.warn?.(...a),
          error: (...a) => ctx.logger?.error?.(...a),
        },
      });
      await server.start();
      if (disposed) {
        await server.stop();
        return null;
      }
      managedRelay = server;
      relayStartupError = null;
      if (server.tokenAutoGenerated && server.token) {
        ctx.logger?.info?.(
          `[agent-browser-bridge] Remote Relay started on ${server.host}:${server.port}${server.extPath} with generated token: ${server.token}`,
        );
      }
      return server.getStatus();
    } catch (err) {
      relayStartupError = err instanceof Error ? err.message : String(err);
      ctx.logger?.warn?.(
        `[agent-browser-bridge] Failed to start managed Relay: ${relayStartupError}`,
      );
      return null;
    }
  })();

  ctx.effect(() => {
    return async () => {
      disposed = true;
      await runtime.dispose().catch(() => void 0);
      if (managedRelay) {
        const s = managedRelay;
        managedRelay = null;
        await s.stop().catch(() => void 0);
      }
    };
  });

  const sectionOrder =
    typeof ctx.systemPrompt?.getSectionOrder === 'function'
      ? ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') + 50
      : 3050;

  ctx.systemPrompt.section({
    name: 'tool:agent-browser-bridge',
    order: sectionOrder,
    text: ({ scope, toolSet }) => {
      const hasBrowser = ctx.tools.get('browser', scope, toolSet) !== undefined;
      if (!hasBrowser) return '';
      return cfg.readOnly
        ? AGENT_BROWSER_BRIDGE_READONLY_SYSTEM_PROMPT
        : AGENT_BROWSER_BRIDGE_SYSTEM_PROMPT;
    },
  });

  // --- Tool 1: browser (command passthrough) ---
  ctx.tools.register({
    name: 'browser',
    description:
      'Run one agent-browser command against a real or isolated browser. Pass the command as an argv array, e.g. ["snapshot", "-i"], ["click", "@e3"], ["fill", "@e2", "hello"], ["wait", "--text", "Saved"], ["tab", "list"], ["open", "http://localhost:3000"], ["a11y", "--json"]. Returns text, or JSON when `json` is true.',
    parameters: objectParams(
      {
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Command and arguments, e.g. ["snapshot", "-i"] or ["fill", "@e2", "hello"]. One command per call; use "batch" with stdin for several steps.',
        },
        target: TARGET_SCHEMA,
        session: SESSION_SCHEMA,
        tab: TAB_SCHEMA,
        stdin: {
          type: 'string',
          description: 'Standard input for the command, e.g. a script for ["eval", "--stdin"] or a JSON array for ["batch"].',
        },
        json: {
          type: 'boolean',
          description: 'Ask agent-browser for JSON output (--json). Default false.',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Command deadline in milliseconds (default 30000, max 120000).',
        },
        launchOptions: LAUNCH_OPTIONS_SCHEMA,
      },
      ['args'],
    ),
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: (args) => {
      try {
        const target = args?.target ?? cfg.defaultTarget;
        const validated = runtime.guard.validate(args?.args ?? [], { target });
        return validated.isReadOnly && !args?.tab;
      } catch {
        return false;
      }
    },
    async execute(args, exec) {
      const target = args?.target ?? cfg.defaultTarget;
      if (target === 'bridge') {
        await relayReadyPromise;
      }
      const result = await runtime.run({
        args: Array.isArray(args?.args) ? args.args.map((item) => String(item)) : [],
        target,
        session: typeof args?.session === 'string' ? args.session : undefined,
        tab: typeof args?.tab === 'string' ? args.tab : undefined,
        stdin: typeof args?.stdin === 'string' ? args.stdin : undefined,
        json: args?.json === true,
        timeoutMs: clampTimeout(args?.timeoutMs),
        launchOptions: args?.launchOptions,
        dshSessionId: sessionIdOf(exec),
        cwd: await resolveCwd(ctx, exec),
        signal: exec?.signal,
      });
      return { text: result.text };
    },
    presentCall: (args) => {
      const command = Array.isArray(args?.args) ? args.args.map((item) => String(item)).join(' ') : '';
      const target = args?.target ?? cfg.defaultTarget;
      return {
        card: 'generic',
        title: truncateLabel(`Browser [${target}] ${command || 'command'}`),
        kind: 'other',
      };
    },
  });

  // --- Tool 2: browser_screenshot ---
  ctx.tools.register({
    name: 'browser_screenshot',
    description:
      'Capture a screenshot of the page or one element and return the saved path, plus the image when the model route accepts images.',
    parameters: objectParams({
      target: TARGET_SCHEMA,
      session: SESSION_SCHEMA,
      tab: TAB_SCHEMA,
      selector: {
        type: 'string',
        description: 'Optional @eN ref or CSS selector to capture a single element.',
      },
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default false).' },
      annotate: {
        type: 'boolean',
        description: 'Overlay numbered [N] labels that map to @eN refs, plus a legend (default false).',
      },
      ifChanged: {
        type: 'boolean',
        description: 'Skip the image when pixels are unchanged since the previous capture (default false).',
      },
      format: { type: 'string', enum: ['jpeg', 'png'], description: 'Image format.' },
      quality: {
        type: 'integer',
        description: 'JPEG quality 20–95 (ignored for PNG).',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Command deadline in milliseconds (default 30000, max 120000).',
      },
      launchOptions: LAUNCH_OPTIONS_SCHEMA,
    }),
    output: {
      schema: SCREENSHOT_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: value.text }];
        if (value.image) {
          blocks.push({ type: 'image', attachment: value.image });
        }
        return blocks;
      },
      presentationMeta: (_args, value) => ({ path: value.filePath }),
    },
    timeoutMs: 120_000,
    isConcurrencySafe: (args) => !args?.tab,
    async execute(args, exec) {
      const target = args?.target ?? cfg.defaultTarget;
      if (target === 'bridge') {
        await relayReadyPromise;
      }
      const capture = await runtime.screenshot({
        target,
        session: typeof args?.session === 'string' ? args.session : undefined,
        tab: typeof args?.tab === 'string' ? args.tab : undefined,
        selector: typeof args?.selector === 'string' ? args.selector : undefined,
        fullPage: args?.fullPage === true,
        annotate: args?.annotate === true,
        ifChanged: args?.ifChanged === true,
        format: args?.format === 'jpeg' || args?.format === 'png' ? args.format : undefined,
        quality: typeof args?.quality === 'number' ? args.quality : undefined,
        timeoutMs: clampTimeout(args?.timeoutMs),
        launchOptions: args?.launchOptions,
        dshSessionId: sessionIdOf(exec),
        cwd: await resolveCwd(ctx, exec),
        signal: exec?.signal,
      });

      if (!capture.changed || !capture.filePath) {
        return { text: capture.text, filePath: '' };
      }

      const attachments = ctx.get('attachments');
      if (attachments && (await routeSupportsImages(ctx, exec))) {
        try {
          const ref = await attachments.saveImage({
            data: Buffer.from(capture.base64, 'base64'),
            mediaType: capture.mediaType,
            name: `browser-${capture.target}-${Date.now()}.${capture.mediaType === 'image/jpeg' ? 'jpg' : 'png'}`,
          });
          return {
            text: capture.text,
            filePath: capture.filePath,
            image: {
              attachmentId: String(ref.attachmentId),
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...(ref.name !== undefined ? { name: ref.name } : {}),
            },
          };
        } catch {
          // Fall back cleanly to text + file path.
        }
      }
      return { text: capture.text, filePath: capture.filePath };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.fullPage ? 'Full-page browser screenshot' : 'Browser screenshot',
      kind: 'read',
    }),
  });

  // --- Runtime skill: the durable operator manual ---
  if (cfg.registerSkill) {
    ctx.inject(['skills'], (skillCtx) => {
      skillCtx.skills.register({
        name: SKILL_NAME,
        description:
          'Drive a real or isolated browser through the `browser` and `browser_screenshot` tools: snapshot-and-ref loop, tabs, waiting, forms, project automation with headless targets, accessibility and performance audits, network capture, and signed-in flows.',
        whenToUse:
          'Load before multi-step browser work, when driving the user\'s signed-in browser, or when running browser automation for a project (tests, audits, scraping).',
        content: BROWSER_BRIDGE_SKILL_CONTENT,
        source: 'runtime',
      });
    });
  }

  // Expose authenticated same-origin Web UI routes when DSH WebServer is mounted
  ctx.inject(['webServer'], (webCtx) => {
    const checkRequestAuth = (req, res) => {
      const conn = webCtx.get('connection');
      const rejected = conn?.requestRejection?.(req);
      if (rejected !== undefined) {
        writeJson(res, rejected, { error: rejected === 401 ? 'Unauthorized' : 'Forbidden' });
        return false;
      }
      return true;
    };

    const unregisterStatus = webCtx.webServer.register({
      kind: 'exact',
      path: '/api/agent-browser-bridge/status',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { error: 'Method Not Allowed' });
          return;
        }
        if (!checkRequestAuth(req, res)) return;
        await relayReadyPromise;
        const relayStatus = managedRelay
          ? managedRelay.getStatus()
          : await queryRelayStatus(cfg.port, 1000);
        let extensionZipAvailable = false;
        try {
          const info = await stat(EXTENSION_ZIP_PATH);
          extensionZipAvailable = info.isFile();
        } catch {
          extensionZipAvailable = false;
        }
        const probe = await probeAgentBrowser(cfg.binaryPath || undefined);
        const rawTabs = relayStatus?.tabs ?? [];
        let authorizedSeq = 1;
        const enrichedTabs = rawTabs.map((tab) => {
          if (tab.eligible && tab.authorized) {
            return { ...tab, tabRef: `$t${authorizedSeq++}` };
          }
          return tab;
        });
        writeJson(
          res,
          200,
          {
            ok: true,
            readOnly: cfg.readOnly,
            managed: managedRelay !== null,
            relayRunning: relayStatus !== null,
            relayError: relayStatus ? null : relayStartupError,
            host: relayStatus?.host ?? cfg.host,
            port: relayStatus?.port ?? cfg.port,
            extPath: relayStatus?.extPath ?? cfg.extPath,
            tokenRequired: relayStatus?.tokenRequired ?? Boolean(cfg.token),
            extensionConnected: Boolean(relayStatus?.extensionConnected),
            extension: relayStatus?.extension ?? null,
            tabs: enrichedTabs,
            cdpClients: relayStatus?.cdpClients ?? 0,
            extensionZipAvailable,
            agentBrowser: {
              available: probe.available,
              version: probe.version,
              binaryPath: probe.path,
              error: probe.error,
              installHint: AGENT_BROWSER_INSTALL_HINT,
            },
            defaultTarget: cfg.defaultTarget,
            allowHeadless: cfg.allowHeadless,
            allowHeaded: cfg.allowHeaded,
            managedSessions: runtime.listSessions(),
          },
          req.method === 'HEAD',
        );
      },
    });

    const unregisterZip = webCtx.webServer.register({
      kind: 'exact',
      path: '/api/agent-browser-bridge/extension.zip',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { error: 'Method Not Allowed' });
          return;
        }
        if (!checkRequestAuth(req, res)) return;
        try {
          const data = await readFile(EXTENSION_ZIP_PATH);
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="agent-browser-bridge-extension.zip"',
            'content-length': String(data.length),
            'cache-control': 'no-store',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
        } catch {
          writeJson(res, 404, { error: 'Extension zip has not been packaged yet.' }, req.method === 'HEAD');
        }
      },
    });

    const unregisterControl = webCtx.webServer.register({
      kind: 'exact',
      path: '/api/agent-browser-bridge/control',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'Method Not Allowed' });
          return;
        }
        if (!checkRequestAuth(req, res)) return;
        if (!isSameOriginMutation(req)) {
          writeJson(res, 403, { ok: false, error: 'Cross-origin control request blocked' });
          return;
        }
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.includes('application/json')) {
          writeJson(res, 415, { ok: false, error: 'Content-Type must be application/json' });
          return;
        }

        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          writeJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' });
          return;
        }

        if (typeof body.action !== 'string' || !CONTROL_ACTIONS.has(body.action)) {
          writeJson(res, 400, { ok: false, error: `Unsupported control action: ${String(body.action)}` });
          return;
        }

        if (body.action === 'close_session') {
          const sessionName = typeof body.sessionName === 'string' ? body.sessionName : '';
          if (!sessionName) {
            writeJson(res, 400, { ok: false, error: 'close_session requires sessionName' });
            return;
          }
          const closed = await runtime.closeSession(sessionName).catch(() => false);
          writeJson(res, 200, { ok: closed, sessionName, closed });
          return;
        }

        const tabId = typeof body.tabId === 'number' && Number.isInteger(body.tabId) ? body.tabId : undefined;
        const mode = body.mode === 'auto' || body.mode === 'manual' ? body.mode : undefined;

        try {
          if (managedRelay) {
            const result = await managedRelay.sendControl(body.action, { tabId, mode });
            writeJson(res, 200, result);
            return;
          }
          const relayRes = await fetch(`http://127.0.0.1:${cfg.port}/control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: body.action, tabId, mode }),
            signal: AbortSignal.timeout(10_000),
          });
          const rawText = await relayRes.text();
          let data;
          try {
            data = rawText ? JSON.parse(rawText) : { ok: relayRes.ok };
          } catch {
            data = { ok: false, error: rawText || `Relay returned HTTP ${relayRes.status}` };
          }
          writeJson(res, relayRes.status, data);
        } catch (err) {
          writeJson(res, 502, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    webCtx.effect(() => () => {
      unregisterStatus();
      unregisterZip();
      unregisterControl();
    });
  });
}

function clampTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1_000, Math.min(120_000, Math.round(value)));
}
