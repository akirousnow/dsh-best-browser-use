import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

interface RegisteredSlot {
  meta: Record<string, unknown>;
  component: (props: Record<string, unknown>) => unknown;
}

describe('DSH Client $ Browser Tab Quick-Picker & ReferenceCodec', () => {
  it('registers conversation.input.overlay, ReferenceCodec without polluting @, and serializes live tab refs cleanly', async () => {
    const clientCode = await readFile(join(repoRoot, 'packages/dsh-plugin/client.js'), 'utf8');

    let loadedModule: { id: string; factory: (req: (id: string) => unknown) => { apply: (ctx: unknown) => void } } | null = null;
    const registeredSlots: RegisteredSlot[] = [];
    let registeredSource: {
      trigger: string;
      name: string;
      showGroupTitle: boolean;
      candidates: () => Promise<unknown[]>;
      codec: {
        clipboardText: (ref: string) => string;
        serialize: (ref: string) => Promise<string>;
      };
    } | null = null;

    const fakeStyleEl = { id: '', textContent: '', remove: () => {} };
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      clearInterval: () => {},
      navigator: { language: 'zh-CN' },
      document: {
        documentElement: { lang: 'zh-CN' },
        visibilityState: 'visible',
        body: {},
        head: { appendChild: () => {} },
        getElementById: () => null,
        createElement: () => fakeStyleEl,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      fetch: async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          relayRunning: true,
          extensionConnected: true,
          host: '127.0.0.1',
          port: 9229,
          extPath: '/ext',
          tabs: [
            { tabId: 10, tabRef: '$t1', url: 'https://github.com/akirousnow/dsh-best-browser-use', title: 'GitHub Repo', eligible: true, authorized: true, active: false, attached: true, targetId: 'tab-10' },
            { tabId: 20, tabRef: '$t2', url: 'https://linux.do/t/topic/3211681', title: 'LINUX DO - 新的理想型社区', eligible: true, authorized: true, active: true, attached: true, targetId: 'C3EC28BD334A13835EFF196007103FC3' },
          ],
        }),
      }),
      window: {
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout,
        clearTimeout,
        addEventListener: (ev: string, fn: (...args: unknown[]) => void) => {
          if (!listeners.has(ev)) listeners.set(ev, new Set());
          listeners.get(ev)!.add(fn);
        },
        removeEventListener: (ev: string, fn: (...args: unknown[]) => void) => {
          listeners.get(ev)?.delete(fn);
        },
        __ModuleLoader__: {
          load(def: typeof loadedModule) {
            loadedModule = def;
          },
        },
      },
    };

    vm.runInNewContext(clientCode, sandbox);
    expect(loadedModule).not.toBeNull();
    expect(loadedModule!.id).toBe('@local/agent-browser-bridge');

    const plugin = loadedModule!.factory((id: string) => {
      if (id === 'react') {
        return {
          createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
          useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
          useEffect: () => {},
          useRef: (init: unknown) => ({ current: init }),
          useCallback: (fn: unknown) => fn,
          useMemo: (fn: () => unknown) => fn(),
        };
      }
      if (id === 'react-dom') {
        return { createPortal: (node: unknown) => node };
      }
      throw new Error(`Unexpected client require: ${id}`);
    });

    const cleanups: Array<() => void> = [];
    const mockCtx: Record<string, unknown> = {
      effect: (fn: () => () => void) => {
        const dispose = fn();
        if (typeof dispose === 'function') cleanups.push(dispose);
      },
      get: () => undefined,
      inject: (deps: string[], cb: (scope: Record<string, unknown>) => void) => {
        cb(mockCtx);
      },
      inputTriggers: {
        registerSource: (src: typeof registeredSource) => {
          registeredSource = src;
          return () => {
            registeredSource = null;
          };
        },
      },
      sessions: {
        scope: (sid: string) => ({ sid, bail: () => true }),
      },
      conversation: {
        input: {
          for: () => ({
            snapshot: { draft: '$linux', draftRev: 1, phase: 'plain' },
            projection: { detectText: '$linux' },
            caretSpan: () => ({ start: 6, end: 6 }),
          }),
        },
      },
      slots: {
        inject: (_name: string, cb: () => void) => cb(),
        register: (meta: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown) => {
          registeredSlots.push({ meta, component });
          return () => {};
        },
      },
    };

    plugin.apply(mockCtx);
    // Allow initial async status fetch inside statusStore.start() to settle
    await new Promise((r) => setTimeout(r, 20));

    // Verify all 3 UI surfaces registered: input overlay ($ picker), composer dock, and hero options
    const slotIds = registeredSlots.map((s) => `${s.meta.name}:${s.meta.id}`);
    expect(slotIds).toContain('conversation.input.overlay:agent-browser-bridge-dollar-tab-picker');
    expect(slotIds).toContain('conversation.composer.dock:agent-browser-bridge-status');
    expect(slotIds).toContain('conversation.hero.options:agent-browser-bridge-hero-status');

    // Verify ReferenceCodec registered on inputTriggers without polluting @ candidates
    expect(registeredSource).not.toBeNull();
    expect(registeredSource!.name).toBe('browser-tabs');
    expect(registeredSource!.showGroupTitle).toBe(false);
    expect(await registeredSource!.candidates()).toEqual([]);

    // Verify codec.serialize resolves live tabRef/title/URL cleanly for the model,
    // including the CDP targetId so the model can address the tab directly.
    const refPayload = JSON.stringify({
      tabId: 20,
      tabRef: '$t99', // stale ref; live store knows tabId 20 is now $t2!
      title: 'Old Title',
      url: 'https://linux.do/t/topic/3211681',
      targetId: '',
    });
    const serialized = await registeredSource!.codec.serialize(refPayload);
    expect(serialized).toBe(
      '[Browser Tab $t2 (targetId: C3EC28BD334A13835EFF196007103FC3): "LINUX DO - 新的理想型社区" (https://linux.do/t/topic/3211681)]',
    );
    expect(registeredSource!.codec.clipboardText(refPayload)).toBe('$t99 Old Title');

    // A synthetic `tab-<id>` placeholder is not worth showing to the model.
    const placeholder = await registeredSource!.codec.serialize(
      JSON.stringify({ tabId: 10, tabRef: '$t1', title: 'GitHub Repo', url: 'https://github.com/x', targetId: 'tab-10' }),
    );
    expect(placeholder).toBe(
      '[Browser Tab $t1: "GitHub Repo" (https://github.com/akirousnow/dsh-best-browser-use)]',
    );

    // Clean disposal
    for (const c of cleanups) c();
    expect(registeredSource).toBeNull();
  });
});
