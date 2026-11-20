import {
  PlaywrightCdpBackend,
  type BrowserBackend,
  type PageAdapter,
  type PendingDialogInfo,
  type PlaywrightCdpBackendOptions,
} from './client.js';
import type { ScreenshotResult } from './media.js';
import { SecurityGuard, type SecurityPolicyConfig } from './security.js';
import {
  buildSnapshotFromAXTree,
  diffSnapshots,
  renderFullSnapshot,
  type PageSnapshot,
  type SnapshotDiffResult,
  type SnapshotElement,
} from './snapshot.js';
import { TabManager } from './tabs.js';

export interface BrowserEngineOptions extends PlaywrightCdpBackendOptions {
  backend?: BrowserBackend;
  security?: SecurityPolicyConfig;
  screenshotDir?: string;
  maxScreenshotWidth?: number;
  screenshotQuality?: number;
  maxSnapshotElements?: number;
}

export interface TabInfoResult {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface ActionSnapshotOutcome {
  tabId: string;
  url: string;
  title: string;
  diff: SnapshotDiffResult;
  pendingDialog?: PendingDialogInfo | null;
}

/**
 * High-cohesion AI Agent Browser Engine implementing the 15 core browser_* tools.
 */
export class BrowserEngine {
  readonly backend: BrowserBackend;
  readonly security: SecurityGuard;
  readonly tabs = new TabManager<PageAdapter>();

  private readonly lastSnapshots = new Map<string, PageSnapshot>();
  private readonly screenshotDir: string | undefined;
  private readonly maxScreenshotWidth: number;
  private readonly screenshotQuality: number;
  private readonly maxSnapshotElements: number;

  constructor(options: BrowserEngineOptions = {}) {
    this.backend = options.backend ?? new PlaywrightCdpBackend(options);
    this.security = new SecurityGuard(options.security);
    this.screenshotDir = options.screenshotDir;
    this.maxScreenshotWidth = options.maxScreenshotWidth ?? 1280;
    this.screenshotQuality = options.screenshotQuality ?? 75;
    this.maxSnapshotElements = options.maxSnapshotElements ?? 350;
  }

  async disconnect(): Promise<void> {
    this.tabs.markDisconnected();
    await this.backend.disconnect();
  }

  private async syncTabs(): Promise<TabInfoResult[]> {
    const pages = await this.backend.listPages();
    const entries = this.tabs.sync(pages);
    return entries.map((e) => ({
      tabId: e.tabId,
      url: e.url,
      title: e.title,
      active: e.active,
    }));
  }

  private async resolveTab(tabId?: string): Promise<{ tabId: string; page: PageAdapter }> {
    await this.syncTabs();
    const resolved = this.tabs.resolve(tabId);
    if (tabId) {
      this.tabs.setActiveTabId(tabId);
    }
    return resolved;
  }

  private formatDialogHint(dialog: PendingDialogInfo | null): string | undefined {
    if (!dialog) return undefined;
    return `${dialog.type}: ${JSON.stringify(dialog.message)} (call browser_dialog to accept or dismiss)`;
  }

  private async captureSnapshot(tabId: string, page: PageAdapter): Promise<PageSnapshot> {
    const [nodes, title] = await Promise.all([page.getAXTree(), page.title()]);
    const snap = buildSnapshotFromAXTree(nodes, {
      url: page.url(),
      title,
      maxElements: this.maxSnapshotElements,
    });
    this.lastSnapshots.set(tabId, snap);
    return snap;
  }

  private async captureIncrementalOutcome(
    tabId: string,
    page: PageAdapter,
    prevSnap: PageSnapshot | undefined,
  ): Promise<ActionSnapshotOutcome> {
    const nextSnap = await this.captureSnapshot(tabId, page);
    const dialog = page.getPendingDialog();
    const diff = diffSnapshots(prevSnap, nextSnap, this.formatDialogHint(dialog));
    return {
      tabId,
      url: nextSnap.url,
      title: nextSnap.title,
      diff,
      pendingDialog: dialog,
    };
  }

  private async resolveElementRef(tabId: string, page: PageAdapter, ref: string): Promise<{
    element: SnapshotElement;
    snapshot: PageSnapshot;
  }> {
    let snap = this.lastSnapshots.get(tabId);
    if (!snap) {
      snap = await this.captureSnapshot(tabId, page);
    }
    const element = snap.refMap.get(ref);
    if (!element) {
      throw new Error(
        `Element ref "${ref}" was not found in the latest snapshot for tab ${tabId}. Call browser_snapshot to refresh available refs.`,
      );
    }
    return { element, snapshot: snap };
  }

  // --- Tool 1: browser_tabs (readOnly) ---
  async browserTabs(args: { selectTabId?: string } = {}): Promise<{
    tabs: TabInfoResult[];
    activeTabId: string | null;
  }> {
    this.security.assertToolAllowed('browser_tabs');
    if (args.selectTabId) {
      await this.syncTabs();
      this.tabs.setActiveTabId(args.selectTabId);
    }
    const list = await this.syncTabs();
    return {
      tabs: list,
      activeTabId: this.tabs.getActiveTabId(),
    };
  }

  // --- Tool 2: browser_new_tab ---
  async browserNewTab(args: { url?: string; background?: boolean } = {}): Promise<{
    tabId: string;
    url: string;
    title: string;
    background: boolean;
    snapshotText: string;
  }> {
    this.security.assertToolAllowed('browser_new_tab');
    const url = args.url ? this.security.assertNavigationUrlAllowed(args.url) : 'about:blank';
    const background = args.background ?? true;
    const created = await this.backend.newTab({ url, background });
    const tabId = this.tabs.registerNewPage(created.page, created.url, created.title, true);
    const snap = await this.captureSnapshot(tabId, created.page);
    return {
      tabId,
      url: snap.url,
      title: snap.title,
      background,
      snapshotText: renderFullSnapshot(snap, this.formatDialogHint(created.page.getPendingDialog())),
    };
  }

  // --- Tool 3: browser_close_tab ---
  async browserCloseTab(args: { tabId?: string } = {}): Promise<{
    closedTabId: string;
    remainingTabs: TabInfoResult[];
  }> {
    this.security.assertToolAllowed('browser_close_tab');
    const { tabId, page } = await this.resolveTab(args.tabId);
    await page.close();
    this.tabs.removeTab(tabId);
    this.lastSnapshots.delete(tabId);
    const remainingTabs = await this.syncTabs();
    return { closedTabId: tabId, remainingTabs };
  }

  // --- Tool 4: browser_snapshot (readOnly) ---
  async browserSnapshot(args: { tabId?: string } = {}): Promise<{
    tabId: string;
    url: string;
    title: string;
    elementCount: number;
    truncated: boolean;
    text: string;
  }> {
    this.security.assertToolAllowed('browser_snapshot');
    const { tabId, page } = await this.resolveTab(args.tabId);
    const snap = await this.captureSnapshot(tabId, page);
    return {
      tabId,
      url: snap.url,
      title: snap.title,
      elementCount: snap.elements.length,
      truncated: snap.truncated,
      text: renderFullSnapshot(snap, this.formatDialogHint(page.getPendingDialog())),
    };
  }

  // --- Tool 5: browser_screenshot (readOnly) ---
  async browserScreenshot(args: {
    tabId?: string;
    fullPage?: boolean;
    quality?: number;
  } = {}): Promise<ScreenshotResult & { tabId: string; url: string; title: string }> {
    this.security.assertToolAllowed('browser_screenshot');
    const { tabId, page } = await this.resolveTab(args.tabId);
    const shot = await page.screenshot({
      fullPage: args.fullPage ?? false,
      quality: args.quality ?? this.screenshotQuality,
      maxWidth: this.maxScreenshotWidth,
      outputDir: this.screenshotDir,
    });
    return {
      ...shot,
      tabId,
      url: page.url(),
      title: await page.title(),
    };
  }

  // --- Tool 6: browser_wait (readOnly) ---
  async browserWait(args: {
    tabId?: string;
    text?: string;
    textGone?: string;
    timeoutMs?: number;
    delayMs?: number;
  }): Promise<{
    tabId: string;
    url: string;
    title: string;
    snapshotText: string;
  }> {
    this.security.assertToolAllowed('browser_wait');
    const { tabId, page } = await this.resolveTab(args.tabId);
    await page.waitFor({
      text: args.text,
      textGone: args.textGone,
      timeoutMs: args.timeoutMs,
      delayMs: args.delayMs,
    });
    const snap = await this.captureSnapshot(tabId, page);
    return {
      tabId,
      url: snap.url,
      title: snap.title,
      snapshotText: renderFullSnapshot(snap, this.formatDialogHint(page.getPendingDialog())),
    };
  }

  // --- Tool 7: browser_navigate ---
  async browserNavigate(args: {
    tabId?: string;
    url?: string;
    action?: 'goto' | 'back' | 'forward' | 'reload';
  }): Promise<{
    tabId: string;
    url: string;
    title: string;
    snapshotText: string;
  }> {
    this.security.assertToolAllowed('browser_navigate');
    const { tabId, page } = await this.resolveTab(args.tabId);
    const action = args.action ?? (args.url ? 'goto' : 'reload');
    const safeUrl =
      action === 'goto' ? this.security.assertNavigationUrlAllowed(args.url ?? '') : undefined;

    await page.navigate({ url: safeUrl, action });
    const snap = await this.captureSnapshot(tabId, page);
    return {
      tabId,
      url: snap.url,
      title: snap.title,
      snapshotText: renderFullSnapshot(snap, this.formatDialogHint(page.getPendingDialog())),
    };
  }

  // --- Tool 8: browser_click ---
  async browserClick(args: {
    tabId?: string;
    ref: string;
    button?: 'left' | 'right' | 'middle';
    doubleClick?: boolean;
  }): Promise<ActionSnapshotOutcome> {
    this.security.assertToolAllowed('browser_click');
    const { tabId, page } = await this.resolveTab(args.tabId);
    const { element, snapshot } = await this.resolveElementRef(tabId, page, args.ref);
    await page.click(element, { button: args.button, doubleClick: args.doubleClick });
    return await this.captureIncrementalOutcome(tabId, page, snapshot);
  }

  // --- Tool 9: browser_hover ---
  async browserHover(args: { tabId?: string; ref: string }): Promise<ActionSnapshotOutcome> {
    this.security.assertToolAllowed('browser_hover');
    const { tabId, page } = await this.resolveTab(args.tabId);
    const { element, snapshot } = await this.resolveElementRef(tabId, page, args.ref);
    await page.hover(element);
    return await this.captureIncrementalOutcome(tabId, page, snapshot);
  }

  // --- Tool 10: browser_fill ---
  async browserFill(args: {
    tabId?: string;
    ref: string;
    value: string;
  }): Promise<ActionSnapshotOutcome> {
    this.security.assertToolAllowed('browser_fill');
    const { tabId, page } = await this.resolveTab(args.tabId);
    const { element, snapshot } = await this.resolveElementRef(tabId, page, args.ref);
    await page.fill(element, args.value);
    return await this.captureIncrementalOutcome(tabId, page, snapshot);
  }

  // --- Tool 11: browser_fill_form ---
  async browserFillForm(args: {
    tabId?: string;
    fields: Array<{ ref: string; value: string }>;
  }): Promise<ActionSnapshotOutcome & { filledCount: number }> {
    this.security.assertToolAllowed('browser_fill_form');
    if (!Array.isArray(args.fields) || args.fields.length === 0) {
      throw new Error('browser_fill_form requires a non-empty fields array');
    }
    const { tabId, page } = await this.resolveTab(args.tabId);
    let snap = this.lastSnapshots.get(tabId);
    if (!snap) {
      snap = await this.captureSnapshot(tabId, page);
    }

    // Validate all refs before mutating so partial failures are avoided
    const resolvedFields = args.fields.map((f) => {
      const el = snap!.refMap.get(f.ref);
      if (!el) {
        throw new Error(
          `Element ref "${f.ref}" not found in latest snapshot for tab ${tabId}. Refresh with browser_snapshot first.`,
        );
      }
      return { element: el, value: f.value };
    });

    for (const item of resolvedFields) {
      await page.fill(item.element, item.value);
    }

    const outcome = await this.captureIncrementalOutcome(tabId, page, snap);
    return { ...outcome, filledCount: resolvedFields.length };
  }

  // --- Tool 12: browser_type ---
  async browserType(args: {
    tabId?: string;
    text: string;
    ref?: string;
    delayMs?: number;
    submit?: boolean;
  }): Promise<ActionSnapshotOutcome> {
    this.security.assertToolAllowed('browser_type');
    const { tabId, page } = await this.resolveTab(args.tabId);
    let prevSnap = this.lastSnapshots.get(tabId);
    let element: SnapshotElement | undefined;
    if (args.ref) {
      const res = await this.resolveElementRef(tabId, page, args.ref);
      element = res.element;
      prevSnap = res.snapshot;
    } else if (!prevSnap) {
      prevSnap = await this.captureSnapshot(tabId, page);
    }
    await page.type(args.text, {
      element,
      delayMs: args.delayMs,
      submit: args.submit,
    });
    return await this.captureIncrementalOutcome(tabId, page, prevSnap);
  }

  // --- Tool 13: browser_press ---
  async browserPress(args: {
    tabId?: string;
    key: string;
    ref?: string;
  }): Promise<ActionSnapshotOutcome> {
    this.security.assertToolAllowed('browser_press');
    const { tabId, page } = await this.resolveTab(args.tabId);
    let prevSnap = this.lastSnapshots.get(tabId);
    let element: SnapshotElement | undefined;
    if (args.ref) {
      const res = await this.resolveElementRef(tabId, page, args.ref);
      element = res.element;
      prevSnap = res.snapshot;
    } else if (!prevSnap) {
      prevSnap = await this.captureSnapshot(tabId, page);
    }
    await page.press(args.key, { element });
    return await this.captureIncrementalOutcome(tabId, page, prevSnap);
  }

  // --- Tool 14: browser_dialog ---
  async browserDialog(args: {
    tabId?: string;
    accept: boolean;
    promptText?: string;
  }): Promise<{
    tabId: string;
    dialog: PendingDialogInfo;
    accepted: boolean;
    diff: SnapshotDiffResult;
  }> {
    this.security.assertToolAllowed('browser_dialog');
    const { tabId, page } = await this.resolveTab(args.tabId);
    const prevSnap = this.lastSnapshots.get(tabId);
    const dialog = await page.handleDialog(args.accept, args.promptText);
    const outcome = await this.captureIncrementalOutcome(tabId, page, prevSnap);
    return {
      tabId,
      dialog,
      accepted: args.accept,
      diff: outcome.diff,
    };
  }

  // --- Tool 15: browser_upload ---
  async browserUpload(args: {
    tabId?: string;
    ref: string;
    paths: string[];
    cwd?: string;
  }): Promise<ActionSnapshotOutcome & { uploadedCount: number; transferredOverWs: boolean }> {
    this.security.assertToolAllowed('browser_upload');
    const { tabId, page } = await this.resolveTab(args.tabId);
    const { element, snapshot } = await this.resolveElementRef(tabId, page, args.ref);
    const isRemote = await this.backend.isRemoteBrowser();
    const files = await this.security.prepareUploadFiles(args.paths, {
      isRemoteBrowser: isRemote,
      cwd: args.cwd,
    });
    await page.upload(element, files);
    const outcome = await this.captureIncrementalOutcome(tabId, page, snapshot);
    return {
      ...outcome,
      uploadedCount: files.length,
      transferredOverWs: isRemote,
    };
  }
}
