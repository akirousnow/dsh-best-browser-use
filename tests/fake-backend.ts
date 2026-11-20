import {
  saveScreenshotBuffer,
  type BrowserBackend,
  type PageAdapter,
  type PendingDialogInfo,
  type RawAxNode,
  type SnapshotElement,
  type UploadFilePayload,
} from '../packages/engine/dist/index.js';

// Minimal valid JPEG bytes with SOF0 header declaring 1280x720 dimensions
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]);

export class FakePageAdapter implements PageAdapter {
  currentUrl: string;
  currentTitle: string;
  fields = new Map<string, string>([
    ['Email', ''],
    ['Name', ''],
  ]);
  hovered: string[] = [];
  clicked: string[] = [];
  typed: string[] = [];
  pressed: string[] = [];
  uploaded: Array<{ ref: string; files: UploadFilePayload[] }> = [];
  pendingDialog: PendingDialogInfo | null = null;
  statusBanner = '';
  closed = false;

  constructor(url: string, title: string) {
    this.currentUrl = url;
    this.currentTitle = title;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async navigate(opts: { url?: string; action?: 'goto' | 'back' | 'forward' | 'reload' }): Promise<void> {
    if (opts.action === 'goto' && opts.url) {
      this.currentUrl = opts.url;
      this.currentTitle = `Page ${new URL(opts.url).hostname}`;
    } else if (opts.action === 'back') {
      this.currentUrl = 'https://previous.example.com/';
      this.currentTitle = 'Previous';
    }
  }

  async getAXTree(): Promise<RawAxNode[]> {
    const children = ['2', '3', '4', '5', '6'];
    const nodes: RawAxNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, childIds: children },
      {
        nodeId: '2',
        role: { type: 'role', value: 'textbox' },
        name: { type: 'computedString', value: 'Email' },
        value: { type: 'string', value: this.fields.get('Email') ?? '' },
      },
      {
        nodeId: '3',
        role: { type: 'role', value: 'textbox' },
        name: { type: 'computedString', value: 'Name' },
        value: { type: 'string', value: this.fields.get('Name') ?? '' },
      },
      {
        nodeId: '4',
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Submit' },
      },
      {
        nodeId: '5',
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Upload File' },
      },
      {
        nodeId: '6',
        role: { type: 'role', value: 'link' },
        name: { type: 'computedString', value: 'Help' },
      },
    ];
    if (this.statusBanner) {
      children.push('7');
      nodes.push({
        nodeId: '7',
        role: { type: 'role', value: 'status' },
        name: { type: 'computedString', value: this.statusBanner },
      });
    }
    return nodes;
  }

  async screenshot(opts: { outputDir?: string }) {
    return await saveScreenshotBuffer(MINIMAL_JPEG, { outputDir: opts.outputDir });
  }

  async click(el: SnapshotElement): Promise<void> {
    this.clicked.push(el.name);
    if (el.name === 'Submit') {
      this.statusBanner = `Submitted for ${this.fields.get('Email') || 'guest'}`;
    }
  }

  async hover(el: SnapshotElement): Promise<void> {
    this.hovered.push(el.name);
    this.statusBanner = `Tooltip: ${el.name}`;
  }

  async fill(el: SnapshotElement, value: string): Promise<void> {
    this.fields.set(el.name, value);
  }

  async type(text: string, opts?: { element?: SnapshotElement; submit?: boolean }): Promise<void> {
    this.typed.push(text);
    if (opts?.element) {
      this.fields.set(opts.element.name, (this.fields.get(opts.element.name) ?? '') + text);
    }
    if (opts?.submit) {
      this.pressed.push('Enter');
    }
  }

  async press(key: string): Promise<void> {
    this.pressed.push(key);
  }

  async waitFor(opts: { delayMs?: number }): Promise<void> {
    const ms = opts.delayMs;
    if (ms !== undefined && ms > 0) {
      await new Promise((r) => setTimeout(r, Math.min(ms, 50)));
    }
  }

  async upload(el: SnapshotElement, files: UploadFilePayload[]): Promise<void> {
    this.uploaded.push({ ref: el.ref, files });
    this.statusBanner = `Uploaded ${files.length} file(s)`;
  }

  getPendingDialog(): PendingDialogInfo | null {
    return this.pendingDialog;
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<PendingDialogInfo> {
    if (!this.pendingDialog) throw new Error('No pending dialog');
    const info = this.pendingDialog;
    this.pendingDialog = null;
    this.statusBanner = accept ? `Dialog accepted: ${promptText ?? 'ok'}` : 'Dialog dismissed';
    return info;
  }
}

export class FakeBrowserBackend implements BrowserBackend {
  pages: FakePageAdapter[] = [];
  remote = false;
  connected = true;
  lastNewTabBackground: boolean | undefined;

  constructor(initialPages?: FakePageAdapter[]) {
    this.pages = initialPages ?? [new FakePageAdapter('https://app.example.com/form', 'Form Demo')];
  }

  async ensureConnected(): Promise<void> {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async isRemoteBrowser(): Promise<boolean> {
    return this.remote;
  }

  async getRelayStatus() {
    return null;
  }

  async listPages() {
    this.pages = this.pages.filter((p) => !p.closed);
    return Promise.all(
      this.pages.map(async (p) => ({
        page: p,
        url: p.url(),
        title: await p.title(),
      })),
    );
  }

  async newTab(options: { url?: string; background?: boolean }) {
    this.lastNewTabBackground = options.background;
    const p = new FakePageAdapter(options.url ?? 'about:blank', 'New Tab');
    this.pages.push(p);
    return { page: p, url: p.url(), title: await p.title() };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}
