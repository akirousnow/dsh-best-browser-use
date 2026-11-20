import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const ALLOWED_EXTENSION_ORIGIN_RE = /^(chrome-extension|moz-extension|extension):\/\/[a-z0-9_-]{8,}$/i;

/** Returns true if an IP or hostname refers exclusively to the local loopback interface. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const trimmed = address.trim().toLowerCase();
  if (trimmed === 'localhost' || trimmed === '::1' || trimmed === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const v4 = trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
  if (/^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/.test(v4)) {
    const octets = v4.split('.').map(Number);
    return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  }
  return false;
}

/**
 * CSWSH guard for the /ext WebSocket endpoint.
 * Rejects regular web origins (http://, https://, file://, null) so malicious websites
 * cannot connect to ws://127.0.0.1:9229/ext from a user's browser tab.
 */
export function validateExtensionOrigin(origin: string | undefined): {
  allowed: boolean;
  reason?: string;
} {
  if (origin === undefined || origin === '') {
    return { allowed: true };
  }
  if (ALLOWED_EXTENSION_ORIGIN_RE.test(origin)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Blocked Origin "${origin}": only chrome-extension:// origins (or absent Origin) are allowed on /ext`,
  };
}

/**
 * CSWSH guard for local /cdp WebSocket endpoint.
 * CDP clients (playwright-core, Node ws, CLI) do not send a browser web Origin header.
 * Reject any Origin header from web pages.
 */
export function validateCdpOrigin(origin: string | undefined): {
  allowed: boolean;
  reason?: string;
} {
  if (origin === undefined || origin === '') {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Blocked browser Origin "${origin}" on /cdp endpoint`,
  };
}

/** Generate a cryptographically secure 32-byte hex token. */
export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Constant-time string comparison via SHA-256 digest equality (hides length differences). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Extract bearer/query/header token from an incoming HTTP upgrade request.
 * Supports:
 * 1. `Authorization: Bearer <token>`
 * 2. `x-bridge-token: <token>`
 * 3. `?token=<token>` query string (used by Chrome MV3 WebSocket which cannot set custom headers)
 * 4. `Sec-WebSocket-Protocol` entry prefixed with `bridge-token.`
 */
export function extractTokenFromRequest(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t.length > 0) return t;
  }

  const customHeader = req.headers['x-bridge-token'];
  if (typeof customHeader === 'string' && customHeader.trim().length > 0) {
    return customHeader.trim();
  }

  const protoHeader = req.headers['sec-websocket-protocol'];
  if (typeof protoHeader === 'string') {
    for (const part of protoHeader.split(',')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('bridge-token.')) {
        const t = trimmed.slice('bridge-token.'.length).trim();
        if (t.length > 0) return t;
      }
    }
  }

  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      const qp = parsed.searchParams.get('token');
      if (qp && qp.length > 0) return qp;
    } catch {
      // Ignore malformed URLs; caller will reject.
    }
  }

  return undefined;
}

/** Validate token against expected configured token. */
export function validateToken(expected: string | undefined, provided: string | undefined): boolean {
  if (!expected) return true;
  if (!provided) return false;
  return constantTimeEqual(expected, provided);
}

/**
 * Normalize an extension endpoint path so it starts with "/" and has no trailing slash (except "/").
 */
export function normalizePath(path: string | undefined, fallback = '/ext'): string {
  const raw = (path ?? fallback).trim();
  if (!raw) return fallback;
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  return prefixed.length > 1 && prefixed.endsWith('/') ? prefixed.slice(0, -1) : prefixed;
}
