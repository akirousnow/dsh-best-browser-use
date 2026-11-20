import type { TabPolicyMode } from '@agent-browser-bridge/protocol';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

const RESTRICTED_HOSTS = new Set([
  'chrome.google.com',
  'chromewebstore.google.com',
  'microsoftedge.microsoft.com',
]);

/**
 * Determine whether Chrome's `chrome.debugger` can safely attach to a tab URL.
 * Whitelist-only: http://, https://, file://, and about:blank.
 * Privileged internal pages (chrome://, edge://, chrome-extension://, Web Store, etc.)
 * are skipped so a single restricted tab never disrupts tab discovery.
 */
export function isEligibleTabUrl(url: string | undefined): boolean {
  if (!url || url.trim().length === 0) return false;
  if (url === 'about:blank') return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    if (host === 'chromewebstore.google.com') return false;
    if (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return false;
    if (host === 'microsoftedge.microsoft.com' && parsed.pathname.startsWith('/addons')) return false;
    if (RESTRICTED_HOSTS.has(host) && parsed.pathname.includes('webstore')) return false;
  }

  return true;
}

/**
 * Tracks tab authorization policy:
 * - `auto` (default): automatically authorizes every eligible normal tab.
 * - `manual`: only authorizes tabs explicitly enabled by the user.
 */
export class TabPolicy {
  private mode: TabPolicyMode;
  private readonly manualAuthorizedTabIds = new Set<number>();

  constructor(initialMode: TabPolicyMode = 'auto') {
    this.mode = initialMode;
  }

  getMode(): TabPolicyMode {
    return this.mode;
  }

  setMode(mode: TabPolicyMode): void {
    this.mode = mode;
  }

  authorizeTab(tabId: number): void {
    this.manualAuthorizedTabIds.add(tabId);
  }

  revokeTab(tabId: number): void {
    this.manualAuthorizedTabIds.delete(tabId);
  }

  pruneClosedTab(tabId: number): void {
    this.manualAuthorizedTabIds.delete(tabId);
  }

  isAuthorized(tabId: number, url: string | undefined): boolean {
    if (!isEligibleTabUrl(url)) return false;
    if (this.mode === 'auto') return true;
    return this.manualAuthorizedTabIds.has(tabId);
  }

  getManualTabIds(): number[] {
    return [...this.manualAuthorizedTabIds];
  }
}
