import { createRequire } from 'node:module';
import type { Browser, CDPSession, Dialog, Page } from 'playwright-core';
import {
  DEFAULT_RELAY_PORT,
  type RelayStatusSnapshot,
} from '@agent-browser-bridge/protocol';
import { ensureRelayRunning, queryRelayStatus } from '@agent-browser-bridge/relay';
import { saveScreenshotBuffer, type ScreenshotOptions, type ScreenshotResult } from './media.js';
import type { RawAxNode, SnapshotElement } from './snapshot.js';
import type { UploadFilePayload } from './security.js';

const PLAYWRIGHT_CACHE_KEY = Symbol.for('agent-browser-bridge.playwright-core');

function loadPlaywrightCore(): typeof import('playwright-core') {
  const g = globalThis as Record<symbol, typeof import('playwright-core') | undefined>;
  const cached = g[PLAYWRIGHT_CACHE_KEY];
  if (cached && cached.chromium) return cached;
  const req = createRequire(import.meta.url);
  const loaded = req('playwright-core') as typeof import('playwright-core');
  g[PLAYWRIGHT_CACHE_KEY] = loaded;
  return loaded;
}

export interface PendingDialogInfo {
  type: string;
  message: string;
  defaultValue: string;
}

export interface PageAdapter {
  url(): string;
  title(): Promise<string>;
  close(): Promise<void>;
  navigate(options: { url?: string; action?: 'goto' | 'back' | 'forward' | 'reload'; timeoutMs?: number }): Promise<void>;
  getAXTree(): Promise<RawAxNode[]>;
  screenshot(options: ScreenshotOptions): Promise<ScreenshotResult>;
  click(element: SnapshotElement, options?: { button?: 'left' | 'right' | 'middle'; doubleClick?: boolean }): Promise<void>;
  hover(element: SnapshotElement): Promise<void>;
  fill(element: SnapshotElement, value: string): Promise<void>;
  type(text: string, options?: { element?: SnapshotElement; delayMs?: number; submit?: boolean }): Promise<void>;
  press(key: string, options?: { element?: SnapshotElement }): Promise<void>;
  waitFor(options: { text?: string; textGone?: string; timeoutMs?: number; delayMs?: number }): Promise<void>;
  upload(element: SnapshotElement, files: UploadFilePayload[]): Promise<void>;
  getPendingDialog(): PendingDialogInfo | null;
  handleDialog(accept: boolean, promptText?: string): Promise<PendingDialogInfo>;
}

export interface BrowserBackend {
  ensureConnected(): Promise<void>;
  isConnected(): boolean;
  isRemoteBrowser(): Promise<boolean>;
  getRelayStatus(): Promise<RelayStatusSnapshot | null>;
  listPages(): Promise<Array<{ page: PageAdapter; url: string; title: string }>>;
  newTab(options: { url?: string; background?: boolean }): Promise<{ page: PageAdapter; url: string; title: string }>;
  disconnect(): Promise<void>;
}

class PlaywrightPageAdapter implements PageAdapter {
  private readonly page: Page;
  private cdpSession: CDPSession | null = null;
  private pendingDialog: Dialog | null = null;

  constructor(page: Page) {
    this.page = page;
    this.page.on('dialog', (dialog) => {
      // Hold dialog reference so Playwright never deadlocks; Agent resolves via browser_dialog.
      this.pendingDialog = dialog;
    });
  }

  url(): string {
    return this.page.url();
  }

  async title(): Promise<string> {
    try {
      return await this.page.title();
    } catch {
      return '';
    }
  }

  async close(): Promise<void> {
    await this.page.close();
  }

  private async getCdp(): Promise<CDPSession> {
    if (!this.cdpSession) {
      this.cdpSession = await this.page.context().newCDPSession(this.page);
    }
    return this.cdpSession;
  }

  async navigate(options: {
    url?: string;
    action?: 'goto' | 'back' | 'forward' | 'reload';
    timeoutMs?: number;
  }): Promise<void> {
    const timeout = options.timeoutMs ?? 25_000;
    const action = options.action ?? (options.url ? 'goto' : 'reload');
    if (action === 'back') {
      await this.page.goBack({ waitUntil: 'domcontentloaded', timeout });
    } else if (action === 'forward') {
      await this.page.goForward({ waitUntil: 'domcontentloaded', timeout });
    } else if (action === 'reload') {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout });
    } else if (options.url) {
      await this.page.goto(options.url, { waitUntil: 'domcontentloaded', timeout });
    }
  }

  async getAXTree(): Promise<RawAxNode[]> {
    const cdp = await this.getCdp();
    const res = (await cdp.send('Accessibility.getFullAXTree')) as { nodes?: RawAxNode[] };
    return res.nodes ?? [];
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const maxWidth = options.maxWidth ?? 1280;
    const quality = Math.max(20, Math.min(95, options.quality ?? 75));
    const cdp = await this.getCdp();

    const metrics = (await cdp.send('Page.getLayoutMetrics')) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      cssContentSize?: { width?: number; height?: number };
    };

    const viewportW = metrics.cssVisualViewport?.clientWidth ?? 1280;
    const viewportH = metrics.cssVisualViewport?.clientHeight ?? 720;
    const contentW = metrics.cssContentSize?.width ?? viewportW;
    const contentH = metrics.cssContentSize?.height ?? viewportH;

    const targetW = options.fullPage ? Math.max(viewportW, contentW) : viewportW;
    const targetH = options.fullPage ? Math.min(10_000, Math.max(viewportH, contentH)) : viewportH;
    const scale = targetW > maxWidth ? maxWidth / targetW : 1;

    const shot = (await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality,
      captureBeyondViewport: Boolean(options.fullPage),
      clip: {
        x: 0,
        y: 0,
        width: targetW,
        height: targetH,
        scale,
      },
    })) as { data: string };

    const buffer = Buffer.from(shot.data, 'base64');
    return await saveScreenshotBuffer(buffer, {
      outputDir: options.outputDir,
      fallbackWidth: Math.round(targetW * scale),
      fallbackHeight: Math.round(targetH * scale),
    });
  }

  private resolveLocator(el: SnapshotElement) {
    type AriaRole = Parameters<Page['getByRole']>[0];
    const role = el.role as AriaRole;
    if (el.name) {
      return this.page.getByRole(role, { name: el.name, exact: true }).nth(el.nth);
    }
    return this.page.getByRole(role).nth(el.nth);
  }

  async click(
    el: SnapshotElement,
    options: { button?: 'left' | 'right' | 'middle'; doubleClick?: boolean } = {},
  ): Promise<void> {
    const locator = this.resolveLocator(el);
    if (options.doubleClick) {
      await locator.dblclick({ button: options.button ?? 'left', timeout: 10_000 });
    } else {
      await locator.click({ button: options.button ?? 'left', timeout: 10_000 });
    }
  }

  async hover(el: SnapshotElement): Promise<void> {
    await this.resolveLocator(el).hover({ timeout: 10_000 });
  }

  async fill(el: SnapshotElement, value: string): Promise<void> {
    const locator = this.resolveLocator(el);
    if (el.role === 'combobox' || el.role === 'listbox') {
      try {
        await locator.selectOption({ label: value }, { timeout: 5_000 });
        return;
      } catch {
        try {
          await locator.selectOption({ value }, { timeout: 5_000 });
          return;
        } catch {
          // Fall through to standard fill (custom ARIA comboboxes)
        }
      }
    }
    if (el.role === 'checkbox' || el.role === 'switch' || el.role === 'radio') {
      const truthy = value === 'true' || value === '1' || value === 'on' || value === 'checked';
      await locator.setChecked(truthy, { timeout: 10_000 });
      return;
    }
    await locator.fill(value, { timeout: 10_000 });
  }

  async type(
    text: string,
    options: { element?: SnapshotElement; delayMs?: number; submit?: boolean } = {},
  ): Promise<void> {
    if (options.element) {
      await this.resolveLocator(options.element).click({ timeout: 10_000 });
    }
    await this.page.keyboard.type(text, { delay: options.delayMs ?? 25 });
    if (options.submit) {
      await this.page.keyboard.press('Enter');
    }
  }

  async press(key: string, options: { element?: SnapshotElement } = {}): Promise<void> {
    if (options.element) {
      await this.resolveLocator(options.element).focus({ timeout: 10_000 });
    }
    await this.page.keyboard.press(key);
  }

  async waitFor(options: {
    text?: string;
    textGone?: string;
    timeoutMs?: number;
    delayMs?: number;
  }): Promise<void> {
    const timeout = Math.min(60_000, options.timeoutMs ?? 10_000);
    const delay = options.delayMs;
    if (delay !== undefined && delay > 0) {
      await new Promise((r) => setTimeout(r, Math.min(30_000, delay)));
    }
    if (options.text) {
      await this.page.getByText(options.text).first().waitFor({ state: 'visible', timeout });
    }
    if (options.textGone) {
      await this.page.getByText(options.textGone).first().waitFor({ state: 'hidden', timeout });
    }
  }

  async upload(el: SnapshotElement, files: UploadFilePayload[]): Promise<void> {
    const locator = this.resolveLocator(el);
    const hasBuffers = files.some((f) => f.transferBuffer !== undefined);
    if (hasBuffers) {
      await locator.setInputFiles(
        files.map((f) => f.transferBuffer!),
        { timeout: 15_000 },
      );
    } else {
      await locator.setInputFiles(
        files.map((f) => f.path),
        { timeout: 15_000 },
      );
    }
  }

  getPendingDialog(): PendingDialogInfo | null {
    if (!this.pendingDialog) return null;
    return {
      type: this.pendingDialog.type(),
      message: this.pendingDialog.message(),
      defaultValue: this.pendingDialog.defaultValue(),
    };
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<PendingDialogInfo> {
    const dialog = this.pendingDialog;
    if (!dialog) {
      throw new Error('No pending browser dialog is open on this tab.');
    }
    const info: PendingDialogInfo = {
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
    };
    this.pendingDialog = null;
    if (accept) {
      await dialog.accept(promptText);
    } else {
      await dialog.dismiss();
    }
    return info;
  }
}

export interface PlaywrightCdpBackendOptions {
  relayPort?: number;
  cdpUrl?: string;
  autoStartRelay?: boolean;
  relayHost?: string;
  relayToken?: string;
}

/**
 * Production backend powered by `playwright-core.connectOverCDP` connecting to the
 * local Relay Daemon's `/cdp/<secret>` endpoint.
 */
export class PlaywrightCdpBackend implements BrowserBackend {
  private readonly relayPort: number;
  private readonly explicitCdpUrl: string | undefined;
  private readonly autoStartRelay: boolean;
  private readonly relayHost: string | undefined;
  private readonly relayToken: string | undefined;

  private browser: Browser | null = null;
  private readonly adapters = new WeakMap<Page, PlaywrightPageAdapter>();

  constructor(options: PlaywrightCdpBackendOptions = {}) {
    this.relayPort = options.relayPort ?? DEFAULT_RELAY_PORT;
    this.explicitCdpUrl = options.cdpUrl;
    this.autoStartRelay = options.autoStartRelay ?? true;
    this.relayHost = options.relayHost;
    this.relayToken = options.relayToken;
  }

  isConnected(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  async getRelayStatus(): Promise<RelayStatusSnapshot | null> {
    return await queryRelayStatus(this.relayPort);
  }

  async isRemoteBrowser(): Promise<boolean> {
    const status = await this.getRelayStatus();
    return Boolean(status?.extension?.isRemote);
  }

  async ensureConnected(): Promise<void> {
    if (this.browser && this.browser.isConnected()) {
      return;
    }

    let cdpUrl = this.explicitCdpUrl;
    if (!cdpUrl) {
      const status = this.autoStartRelay
        ? await ensureRelayRunning({
            port: this.relayPort,
            host: this.relayHost,
            token: this.relayToken,
          })
        : await queryRelayStatus(this.relayPort);

      if (!status) {
        throw new Error(
          `Relay Daemon is not running on 127.0.0.1:${this.relayPort}. Start it with "bb daemon start" or enable autoStartRelay.`,
        );
      }
      if (!status.extensionConnected) {
        throw new Error(
          `Relay Daemon is running on ${status.host}:${status.port}, but no Chrome/Edge browser extension is connected yet. Click the Agent Browser Bridge extension icon in your browser and connect.`,
        );
      }
      cdpUrl = status.cdpWsUrl;
    }

    const { chromium } = loadPlaywrightCore();
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
    browser.on('disconnected', () => {
      if (this.browser === browser) {
        this.browser = null;
      }
    });
    this.browser = browser;
  }

  private getAdapter(page: Page): PlaywrightPageAdapter {
    let adapter = this.adapters.get(page);
    if (!adapter) {
      adapter = new PlaywrightPageAdapter(page);
      this.adapters.set(page, adapter);
    }
    return adapter;
  }

  async listPages(): Promise<Array<{ page: PageAdapter; url: string; title: string }>> {
    await this.ensureConnected();
    const browser = this.browser!;
    const out: Array<{ page: PageAdapter; url: string; title: string }> = [];

    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        const adapter = this.getAdapter(page);
        out.push({
          page: adapter,
          url: adapter.url(),
          title: await adapter.title(),
        });
      }
    }
    return out;
  }

  async newTab(options: {
    url?: string;
    background?: boolean;
  }): Promise<{ page: PageAdapter; url: string; title: string }> {
    await this.ensureConnected();
    const browser = this.browser!;
    const ctx = browser.contexts()[0];
    if (!ctx) {
      throw new Error('No default browser context available from connected extension.');
    }

    const page = await ctx.newPage();
    const adapter = this.getAdapter(page);
    if (options.url && options.url !== 'about:blank') {
      await adapter.navigate({ url: options.url, action: 'goto' });
    }
    if (options.background === false) {
      await page.bringToFront().catch(() => void 0);
    }
    return {
      page: adapter,
      url: adapter.url(),
      title: await adapter.title(),
    };
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      await b.close().catch(() => void 0);
    }
  }
}
