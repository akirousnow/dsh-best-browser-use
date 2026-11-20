import { describe, expect, it } from 'vitest';
import type { CdpEventMessage } from '../packages/protocol/src/index.js';
import { CdpBridge } from '../packages/extension/src/cdp-bridge.js';
import { isEligibleTabUrl, TabPolicy } from '../packages/extension/src/tab-policy.js';
import { createMockChromeApi } from './mock-extension.js';

describe('TabPolicy and CdpBridge (MV3 extension core)', () => {
  it('filters privileged URLs strictly by allowlist', () => {
    expect(isEligibleTabUrl('https://github.com/deepseek-ai')).toBe(true);
    expect(isEligibleTabUrl('http://127.0.0.1:3080/')).toBe(true);
    expect(isEligibleTabUrl('file:///tmp/demo.html')).toBe(true);
    expect(isEligibleTabUrl('about:blank')).toBe(true);

    expect(isEligibleTabUrl('chrome://settings')).toBe(false);
    expect(isEligibleTabUrl('chrome-extension://abcdef1234567890/popup.html')).toBe(false);
    expect(isEligibleTabUrl('edge://extensions')).toBe(false);
    expect(isEligibleTabUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
    expect(isEligibleTabUrl('https://chromewebstore.google.com/detail/xyz')).toBe(false);
    expect(isEligibleTabUrl('https://chrome.google.com/webstore/category/extensions')).toBe(false);
    expect(isEligibleTabUrl('')).toBe(false);
  });

  it('supports auto and manual tab authorization modes', () => {
    const policy = new TabPolicy('auto');
    expect(policy.isAuthorized(1, 'https://example.com')).toBe(true);
    expect(policy.isAuthorized(2, 'chrome://extensions')).toBe(false);

    policy.setMode('manual');
    expect(policy.isAuthorized(1, 'https://example.com')).toBe(false);
    policy.authorizeTab(1);
    expect(policy.isAuthorized(1, 'https://example.com')).toBe(true);
    policy.revokeTab(1);
    expect(policy.isAuthorized(1, 'https://example.com')).toBe(false);
  });

  it('opens new tabs in background by default, swallows single-tab attach errors, routes OOPIF child sessions, and survives DevTools preemption', async () => {
    const events: CdpEventMessage[] = [];
    const { api, state } = createMockChromeApi([
      { id: 1, url: 'https://app.example.com', title: 'App', active: true },
      { id: 2, url: 'https://devtools-busy.example.com', title: 'Busy Tab', active: false },
      { id: 3, url: 'chrome://settings', title: 'Settings', active: false },
    ]);
    // Simulate tab 2 already having DevTools attached
    state.attachFailTabIds.add(2);

    const policy = new TabPolicy('auto');
    const bridge = new CdpBridge(api, policy, {
      emitEvent: (evt) => events.push(evt),
    });
    bridge.bindListeners();

    // setAutoAttach should attach tab 1, gracefully swallow tab 2's error, and skip chrome://settings
    const autoRes = await bridge.handleCommand({
      type: 'cdp.cmd',
      id: 1,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, flatten: true },
    });
    expect(autoRes.error).toBeUndefined();
    expect(state.attachedTabIds.has(1)).toBe(true);
    expect(state.attachedTabIds.has(2)).toBe(false);
    expect(state.attachedTabIds.has(3)).toBe(false);

    // Find sessionId for tab 1
    const attachedEvt = events.find((e) => e.method === 'Target.attachedToTarget');
    expect(attachedEvt).toBeDefined();
    const tab1SessionId = String(attachedEvt?.params?.sessionId);

    // Simulate Chrome attaching an OOPIF child iframe session on tab 1
    state.triggerDebuggerEvent({ tabId: 1 }, 'Target.attachedToTarget', {
      sessionId: 'oopif-child-99',
      targetInfo: { targetId: 'iframe-99', type: 'iframe', url: 'https://iframe.other.com', title: '' },
    });

    // Sending a command to child session routes to { tabId: 1, sessionId: 'oopif-child-99' }
    const childCmdRes = await bridge.handleCommand({
      type: 'cdp.cmd',
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: 'document.title' },
      sessionId: 'oopif-child-99',
    });
    expect(childCmdRes.error).toBeUndefined();
    expect(state.sentCommands.at(-1)?.target).toEqual({ tabId: 1, sessionId: 'oopif-child-99' });

    // Target.createTarget defaults to background (active: false)
    const createRes = await bridge.handleCommand({
      type: 'cdp.cmd',
      id: 3,
      method: 'Target.createTarget',
      params: { url: 'https://docs.example.com' },
    });
    expect(createRes.error).toBeUndefined();
    expect(state.lastCreatedOptions.at(-1)).toEqual({ url: 'https://docs.example.com', active: false });

    // Pitfall #2: User opens F12 DevTools on tab 1 -> replaced_with_devtools
    events.length = 0;
    state.triggerDebuggerDetach(1, 'replaced_with_devtools');
    const detachedEvts = events.filter((e) => e.method === 'Target.detachedFromTarget');
    expect(detachedEvts.some((e) => e.params?.sessionId === tab1SessionId)).toBe(true);
    expect(detachedEvts.some((e) => e.params?.sessionId === 'oopif-child-99')).toBe(true);

    const summaries = await bridge.getTabSummaries();
    const tab1Summary = summaries.find((t) => t.tabId === 1);
    expect(tab1Summary?.attached).toBe(false);
    expect(tab1Summary?.detachReason).toBe('replaced_with_devtools');

    // Browser.close detaches sessions WITHOUT closing user tabs
    const tabCountBefore = state.tabs.size;
    await bridge.handleCommand({ type: 'cdp.cmd', id: 4, method: 'Browser.close' });
    expect(state.tabs.size).toBe(tabCountBefore);
    expect(state.attachedTabIds.size).toBe(0);
  });
});
