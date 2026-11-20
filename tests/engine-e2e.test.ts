import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserEngine, SecurityError } from '../packages/engine/dist/index.js';
import { FakeBrowserBackend, FakePageAdapter } from './fake-backend.js';

describe('BrowserEngine all 15 tools, reconnect rebinding, and security guard', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('executes all 15 browser_* actions end-to-end with incremental diffs and JPEG capture', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'abb-engine-test-'));
    tempDirs.push(tmpDir);
    const sampleFile = join(tmpDir, 'report.txt');
    await writeFile(sampleFile, 'hello browser upload', 'utf8');

    const backend = new FakeBrowserBackend();
    const engine = new BrowserEngine({ backend, screenshotDir: tmpDir });

    const tabsRes = await engine.browserTabs();
    expect(tabsRes.tabs).toHaveLength(1);
    expect(tabsRes.activeTabId).toBe('$t1');

    const snap = await engine.browserSnapshot();
    expect(snap.text).toContain('[e1] textbox "Email"');
    expect(snap.text).toContain('[e2] textbox "Name"');
    expect(snap.text).toContain('[e3] button "Submit"');

    const fillFormRes = await engine.browserFillForm({
      fields: [
        { ref: 'e1', value: 'dev@example.com' },
        { ref: 'e2', value: 'Alice' },
      ],
    });
    expect(fillFormRes.filledCount).toBe(2);
    expect(fillFormRes.diff.kind).toBe('diff');
    expect(fillFormRes.diff.text).toContain('dev@example.com');

    const clickRes = await engine.browserClick({ ref: 'e3' });
    expect(clickRes.diff.kind).toBe('diff');
    expect(clickRes.diff.text).toContain('Submitted for dev@example.com');

    const hoverRes = await engine.browserHover({ ref: 'e5' });
    expect(hoverRes.diff.text).toContain('Tooltip: Help');

    await engine.browserType({ ref: 'e2', text: ' Lin', submit: true });
    expect(backend.pages[0]!.fields.get('Name')).toBe('Alice Lin');
    await engine.browserPress({ key: 'Escape' });
    expect(backend.pages[0]!.pressed).toContain('Escape');

    const waitRes = await engine.browserWait({ delayMs: 5 });
    expect(waitRes.tabId).toBe('$t1');

    const shot = await engine.browserScreenshot();
    expect(shot.width).toBe(1280);
    expect(shot.height).toBe(720);
    expect((await stat(shot.filePath)).isFile()).toBe(true);

    backend.pages[0]!.pendingDialog = { type: 'prompt', message: 'Enter PIN', defaultValue: '' };
    const dialogRes = await engine.browserDialog({ accept: true, promptText: '1234' });
    expect(dialogRes.accepted).toBe(true);
    expect(dialogRes.diff.text).toContain('Dialog accepted: 1234');

    const uploadRes = await engine.browserUpload({ ref: 'e4', paths: [sampleFile] });
    expect(uploadRes.uploadedCount).toBe(1);
    expect(uploadRes.transferredOverWs).toBe(false);

    const navRes = await engine.browserNavigate({ url: 'https://docs.example.com/guide' });
    expect(navRes.url).toBe('https://docs.example.com/guide');

    const newTabRes = await engine.browserNewTab({ url: 'https://news.example.com' });
    expect(newTabRes.background).toBe(true);
    expect(backend.lastNewTabBackground).toBe(true);
    expect(newTabRes.tabId).toBe('$t2');

    const closeRes = await engine.browserCloseTab({ tabId: '$t2' });
    expect(closeRes.closedTabId).toBe('$t2');
    expect(closeRes.remainingTabs).toHaveLength(1);
  });

  it('rebinds stable $tN tab refs by URL+Title after a disconnect/reconnect', async () => {
    const p1 = new FakePageAdapter('https://mail.example.com/inbox', 'Inbox');
    const p2 = new FakePageAdapter('https://docs.example.com/spec', 'Spec');
    const backend = new FakeBrowserBackend([p1, p2]);
    const engine = new BrowserEngine({ backend });

    const before = await engine.browserTabs();
    expect(before.tabs.map((t) => [t.tabId, t.url])).toEqual([
      ['$t1', 'https://mail.example.com/inbox'],
      ['$t2', 'https://docs.example.com/spec'],
    ]);

    engine.tabs.markDisconnected();
    backend.pages = [
      new FakePageAdapter('https://docs.example.com/spec', 'Spec'),
      new FakePageAdapter('https://mail.example.com/inbox', 'Inbox'),
    ];

    const after = await engine.browserTabs();
    const mapAfter = Object.fromEntries(after.tabs.map((t) => [t.url, t.tabId]));
    expect(mapAfter['https://mail.example.com/inbox']).toBe('$t1');
    expect(mapAfter['https://docs.example.com/spec']).toBe('$t2');
  });

  it('enforces read-only mode, navigation protocol allowlist, and remote upload boundaries', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'abb-sec-test-'));
    tempDirs.push(tmpDir);
    const sampleFile = join(tmpDir, 'doc.txt');
    await writeFile(sampleFile, 'remote-transfer-bytes', 'utf8');

    const backend = new FakeBrowserBackend();
    const roEngine = new BrowserEngine({ backend, security: { readOnly: true } });

    await expect(roEngine.browserTabs()).resolves.toBeDefined();
    await expect(roEngine.browserSnapshot()).resolves.toBeDefined();
    await expect(roEngine.browserClick({ ref: 'e3' })).rejects.toThrow(SecurityError);
    await expect(roEngine.browserNavigate({ url: 'https://example.com' })).rejects.toThrow(SecurityError);
    expect(() => roEngine.security.assertEvalAllowed()).toThrow(SecurityError);

    const rwEngine = new BrowserEngine({ backend });
    await expect(rwEngine.browserNavigate({ url: 'javascript:alert(1)' })).rejects.toThrow(SecurityError);
    await expect(rwEngine.browserNavigate({ url: 'chrome://settings' })).rejects.toThrow(SecurityError);

    backend.remote = true;
    await rwEngine.browserSnapshot();
    await expect(rwEngine.browserUpload({ ref: 'e4', paths: [sampleFile] })).rejects.toThrow(SecurityError);

    const transferEngine = new BrowserEngine({
      backend,
      security: { allowRemoteUploadTransfer: true },
    });
    await transferEngine.browserSnapshot();
    const res = await transferEngine.browserUpload({ ref: 'e4', paths: [sampleFile] });
    expect(res.transferredOverWs).toBe(true);
    expect(backend.pages[0]!.uploaded.at(-1)?.files[0]?.transferBuffer?.name).toBe('doc.txt');
  });
});
