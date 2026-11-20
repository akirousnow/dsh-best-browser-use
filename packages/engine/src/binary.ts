import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/** Environment variable that overrides agent-browser binary discovery. */
export const AGENT_BROWSER_BIN_ENV = 'AGENT_BROWSER_BIN';

/** Default command name looked up on `PATH`. */
const AGENT_BROWSER_COMMAND = process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser';

/** Where a resolved binary came from. */
export type BinarySource = 'config' | 'env' | 'path';

export interface ResolvedBinary {
  path: string;
  source: BinarySource;
}

export interface AgentBrowserProbeResult {
  /** True only when the binary ran and printed a version. */
  available: boolean;
  /** Absolute or PATH-resolved executable used, when one was found. */
  path: string | null;
  /** Version reported by `agent-browser --version`, when available. */
  version: string | null;
  /** Human-readable reason the binary is unusable, when it is not available. */
  error: string | null;
  /** Where the binary was found. */
  source: BinarySource | null;
}

export interface ProbeOptions {
  /** How long `--version` may take (default 5000 ms). */
  timeoutMs?: number;
  /** Ignore a cached result and probe again. */
  fresh?: boolean;
}

const PROBE_CACHE_TTL_MS = 60_000;
const probeCache = new Map<string, { at: number; result: AgentBrowserProbeResult }>();

async function isExecutable(candidate: string): Promise<boolean> {
  if (!candidate) return false;
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the `agent-browser` executable.
 *
 * Order: explicit configuration, then `AGENT_BROWSER_BIN`, then `PATH`.
 * @param preferredPath - Configured binary path, if any.
 * @returns the resolved binary, or `null` when nothing executable was found.
 */
export async function resolveAgentBrowserBinary(
  preferredPath?: string,
): Promise<ResolvedBinary | null> {
  const configured = preferredPath?.trim();
  if (configured && (await isExecutable(configured))) {
    return { path: configured, source: 'config' };
  }

  const fromEnv = process.env[AGENT_BROWSER_BIN_ENV]?.trim();
  if (fromEnv && (await isExecutable(fromEnv))) {
    return { path: fromEnv, source: 'env' };
  }

  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, AGENT_BROWSER_COMMAND);
    if (await isExecutable(candidate)) {
      return { path: candidate, source: 'path' };
    }
  }

  return null;
}

/** Install hint shared by every failure path that means "agent-browser is missing". */
export const AGENT_BROWSER_INSTALL_HINT =
  'Install it with `npm i -g agent-browser && agent-browser install`, or point the plugin at an existing binary with the `binaryPath` setting.';

/**
 * Check that `agent-browser` exists and can run, caching the answer briefly.
 * @param preferredPath - Configured binary path, if any.
 * @param options - timeout and cache controls.
 * @returns availability, resolved path, version, and any error text.
 */
export async function probeAgentBrowser(
  preferredPath?: string,
  options: ProbeOptions = {},
): Promise<AgentBrowserProbeResult> {
  const resolved = await resolveAgentBrowserBinary(preferredPath);
  if (!resolved) {
    return {
      available: false,
      path: null,
      version: null,
      source: null,
      error: `agent-browser executable not found on PATH. ${AGENT_BROWSER_INSTALL_HINT}`,
    };
  }

  const cacheKey = resolved.path;
  if (!options.fresh) {
    const cached = probeCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const result = await new Promise<AgentBrowserProbeResult>((resolve) => {
    execFile(
      resolved.path,
      ['--version'],
      { timeout: options.timeoutMs ?? 5_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            available: false,
            path: resolved.path,
            version: null,
            source: resolved.source,
            error: `agent-browser at ${resolved.path} could not run: ${error.message}`,
          });
          return;
        }
        const raw = `${stdout}`.trim() || `${stderr}`.trim();
        const version = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(raw)?.[1] ?? (raw || null);
        resolve({
          available: true,
          path: resolved.path,
          version,
          source: resolved.source,
          error: null,
        });
      },
    );
  });

  probeCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/** Drop cached probe results (used after a user installs or upgrades agent-browser). */
export function resetAgentBrowserProbeCache(): void {
  probeCache.clear();
}
