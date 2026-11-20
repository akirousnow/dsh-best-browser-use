import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { READ_ONLY_TOOL_NAMES, type BrowserToolName } from './prompt.js';

export interface SecurityPolicyConfig {
  /** When true, only read-only tools (tabs, snapshot, screenshot, wait) are allowed. */
  readOnly?: boolean;
  /** Disallow arbitrary JS evaluation by default. */
  allowEval?: boolean;
  /** Allow navigating to file:// URLs (disabled by default). */
  allowFileUrls?: boolean;
  /**
   * When the browser extension is connected from a remote client machine, local Host paths
   * cannot be read by the remote browser. By default uploads are rejected in remote mode.
   * Enable `allowRemoteUploadTransfer` to transfer small files over WebSocket as in-memory buffers.
   */
  allowRemoteUploadTransfer?: boolean;
  /** Max size per transferred file in remote upload mode (default 10 MiB). */
  maxRemoteUploadBytes?: number;
  /** Optional allowlist of directory roots for upload paths. */
  allowedUploadRoots?: string[];
}

export interface UploadFilePayload {
  path: string;
  transferBuffer?: {
    name: string;
    mimeType: string;
    buffer: Buffer;
  };
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.html': 'text/html',
};

export class SecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}

export class SecurityGuard {
  readonly readOnly: boolean;
  readonly allowEval: boolean;
  readonly allowFileUrls: boolean;
  readonly allowRemoteUploadTransfer: boolean;
  readonly maxRemoteUploadBytes: number;
  readonly allowedUploadRoots: string[] | undefined;

  constructor(config: SecurityPolicyConfig = {}) {
    this.readOnly = config.readOnly ?? false;
    this.allowEval = config.allowEval ?? false;
    this.allowFileUrls = config.allowFileUrls ?? false;
    this.allowRemoteUploadTransfer = config.allowRemoteUploadTransfer ?? false;
    this.maxRemoteUploadBytes = config.maxRemoteUploadBytes ?? 10 * 1024 * 1024;
    this.allowedUploadRoots = config.allowedUploadRoots?.map((r) => resolve(r));
  }

  assertToolAllowed(tool: BrowserToolName): void {
    if (this.readOnly && !READ_ONLY_TOOL_NAMES.has(tool)) {
      throw new SecurityError(
        'READ_ONLY_MODE',
        `Tool "${tool}" is blocked because browser bridge is running in read-only mode. Only read-only tools (${[...READ_ONLY_TOOL_NAMES].join(', ')}) are permitted.`,
      );
    }
  }

  assertEvalAllowed(): void {
    if (!this.allowEval) {
      throw new SecurityError(
        'EVAL_DISABLED',
        'Arbitrary JavaScript evaluation is disabled by security policy (allowEval=false).',
      );
    }
  }

  assertNavigationUrlAllowed(rawUrl: string): string {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      throw new SecurityError('INVALID_URL', 'URL must be a non-empty string');
    }
    if (trimmed === 'about:blank') return trimmed;

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      // Allow bare hostnames like "example.com" by upgrading to https://
      if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(trimmed)) {
        parsed = new URL(`https://${trimmed}`);
      } else {
        throw new SecurityError('INVALID_URL', `Invalid navigation URL: "${rawUrl}"`);
      }
    }

    const allowed = new Set(['http:', 'https:']);
    if (this.allowFileUrls) allowed.add('file:');

    if (!allowed.has(parsed.protocol)) {
      throw new SecurityError(
        'BLOCKED_PROTOCOL',
        `Navigation to "${parsed.protocol}" URLs is blocked for safety. Only http(s):// URLs are allowed.`,
      );
    }
    return parsed.toString();
  }

  async prepareUploadFiles(
    filePaths: string[],
    options: { isRemoteBrowser: boolean; cwd?: string },
  ): Promise<UploadFilePayload[]> {
    if (filePaths.length === 0) {
      throw new SecurityError('EMPTY_UPLOAD', 'At least one file path is required for browser_upload');
    }

    if (options.isRemoteBrowser && !this.allowRemoteUploadTransfer) {
      throw new SecurityError(
        'REMOTE_UPLOAD_BLOCKED',
        'Cannot pass Host local file paths to a remote browser extension (remote browser cannot read Host filesystem). Enable allowRemoteUploadTransfer to transfer small files over WebSocket.',
      );
    }

    const baseCwd = options.cwd ?? process.cwd();
    const results: UploadFilePayload[] = [];

    for (const rawPath of filePaths) {
      const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(baseCwd, rawPath);

      if (this.allowedUploadRoots && this.allowedUploadRoots.length > 0) {
        const permitted = this.allowedUploadRoots.some(
          (root) => resolved === root || resolved.startsWith(`${root}/`),
        );
        if (!permitted) {
          throw new SecurityError(
            'UPLOAD_PATH_OUTSIDE_ROOT',
            `Upload path "${rawPath}" is outside the configured allowedUploadRoots.`,
          );
        }
      }

      let info;
      try {
        info = await stat(resolved);
      } catch {
        throw new SecurityError('UPLOAD_FILE_NOT_FOUND', `Upload file not found: "${rawPath}"`);
      }
      if (!info.isFile()) {
        throw new SecurityError('UPLOAD_NOT_A_FILE', `Upload path is not a regular file: "${rawPath}"`);
      }

      if (options.isRemoteBrowser) {
        if (info.size > this.maxRemoteUploadBytes) {
          throw new SecurityError(
            'REMOTE_UPLOAD_TOO_LARGE',
            `File "${basename(resolved)}" (${info.size} bytes) exceeds remote upload transfer limit (${this.maxRemoteUploadBytes} bytes).`,
          );
        }
        const buffer = await readFile(resolved);
        const ext = extname(resolved).toLowerCase();
        results.push({
          path: resolved,
          transferBuffer: {
            name: basename(resolved),
            mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream',
            buffer,
          },
        });
      } else {
        results.push({ path: resolved });
      }
    }

    return results;
  }
}
