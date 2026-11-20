import type { ExtensionRuntimeState, ExtensionConfig } from '../background.js';

const IS_ZH = (navigator.language || '').toLowerCase().startsWith('zh');

const T = IS_ZH
  ? {
      connSettings: 'Relay 连接设置',
      host: 'Host / IP（支持粘贴 ws:// 完整地址）',
      port: '端口',
      token: 'Token（本机可选，远程必填）',
      tokenPlaceholder: '粘贴 Relay Token',
      show: '显示',
      hide: '隐藏',
      wss: 'WSS 加密 (HTTPS 反代)',
      autoConnect: '启动自动连接',
      advanced: '高级路径设置',
      path: 'WebSocket 路径',
      tabMode: 'Tab 接管模式',
      modeAuto: '自动接管全部',
      modeManual: '仅授权勾选',
      connect: '连接',
      disconnect: '断开',
      cancel: '取消',
      stop: '停止',
      retry: '重试连接',
      reconnectNow: '立即重连',
      dirtyHint: '连接参数已修改，重连后生效。',
      statusConnected: (vis: number, att: number) => `已连接 · 可见 ${vis} 个 Tab（已调试 ${att}）`,
      statusConnecting: '正在连接 Relay…',
      statusReconnecting: (n: number) => `重连中（第 ${n} 次）…`,
      statusError: '连接出错',
      statusDisconnected: '未连接',
      emptyTabs: '暂无可接管的普通网页 Tab（chrome:// 等系统页自动跳过）',
      untitled: '(无标题)',
      attached: '已接管',
      detach: '释放调试',
      devtoolsBusy: 'F12 占用',
      attachFailed: '接管失败',
      reattach: '重新接管',
      ready: '就绪',
      bgUnreachable: (m: string) => `扩展后台未响应: ${m}`,
      authorizeTitle: '授权 Agent 访问此标签页',
    }
  : {
      connSettings: 'Relay connection',
      host: 'Host / IP (or paste ws:// URL)',
      port: 'Port',
      token: 'Token (optional locally, required remotely)',
      tokenPlaceholder: 'Paste Relay token',
      show: 'Show',
      hide: 'Hide',
      wss: 'Use WSS (TLS proxy)',
      autoConnect: 'Auto-connect',
      advanced: 'Advanced path',
      path: 'WebSocket path',
      tabMode: 'Tab access mode',
      modeAuto: 'Auto all',
      modeManual: 'Manual',
      connect: 'Connect',
      disconnect: 'Disconnect',
      cancel: 'Cancel',
      stop: 'Stop',
      retry: 'Retry',
      reconnectNow: 'Reconnect',
      dirtyHint: 'Settings updated — reconnect to apply.',
      statusConnected: (vis: number, att: number) => `Connected · ${vis} visible (${att} attached)`,
      statusConnecting: 'Connecting to Relay…',
      statusReconnecting: (n: number) => `Reconnecting (attempt ${n})…`,
      statusError: 'Connection error',
      statusDisconnected: 'Disconnected',
      emptyTabs: 'No eligible web tabs open (system pages like chrome:// are skipped).',
      untitled: '(untitled)',
      attached: 'Attached',
      detach: 'Detach',
      devtoolsBusy: 'DevTools active',
      attachFailed: 'Attach failed',
      reattach: 'Retry attach',
      ready: 'Ready',
      bgUnreachable: (m: string) => `Background worker error: ${m}`,
      authorizeTitle: 'Grant agent access to this tab',
    };

const statusDot = document.getElementById('status-dot') as HTMLSpanElement;
const statusText = document.getElementById('status-text') as HTMLDivElement;
const toggleConnectBtn = document.getElementById('toggle-connect') as HTMLButtonElement;
const errorBanner = document.getElementById('error-banner') as HTMLDivElement;
const dirtyBanner = document.getElementById('dirty-banner') as HTMLDivElement;

const inputHost = document.getElementById('input-host') as HTMLInputElement;
const inputPort = document.getElementById('input-port') as HTMLInputElement;
const inputPath = document.getElementById('input-path') as HTMLInputElement;
const inputToken = document.getElementById('input-token') as HTMLInputElement;
const inputWss = document.getElementById('input-wss') as HTMLInputElement;
const inputAutoConnect = document.getElementById('input-autoconnect') as HTMLInputElement;
const toggleTokenVisBtn = document.getElementById('toggle-token-vis') as HTMLButtonElement;

const modeAutoBtn = document.getElementById('mode-auto') as HTMLButtonElement;
const modeManualBtn = document.getElementById('mode-manual') as HTMLButtonElement;
const tabListEl = document.getElementById('tab-list') as HTMLDivElement;

function applyStaticLocale(): void {
  document.documentElement.lang = IS_ZH ? 'zh-CN' : 'en';
  const setText = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText('lbl-conn-settings', T.connSettings);
  setText('lbl-host', T.host);
  setText('lbl-port', T.port);
  setText('lbl-token', T.token);
  setText('lbl-wss', T.wss);
  setText('lbl-autoconnect', T.autoConnect);
  setText('lbl-advanced', T.advanced);
  setText('lbl-path', T.path);
  setText('lbl-tab-mode', T.tabMode);
  modeAutoBtn.textContent = T.modeAuto;
  modeManualBtn.textContent = T.modeManual;
  inputToken.placeholder = T.tokenPlaceholder;
  toggleTokenVisBtn.textContent = T.show;
}

let currentState: ExtensionRuntimeState | null = null;
let formHydrated = false;
let lastTabsRenderKey = '';
let localError: string | null = null;
let configDirtyWhileConnected = false;

function clampPort(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 9229;
  if (n > 65535) return 65535;
  return n;
}

/**
 * Smart parser when a user pastes a full endpoint like `ws://127.0.0.1:9229/ext?token=abc`,
 * `wss://relay.example.com/ext`, or `127.0.0.1:9229/ext` into the Host field.
 */
function parseSmartEndpointInput(rawHostValue: string): boolean {
  const trimmed = rawHostValue.trim();
  if (!trimmed.includes('://') && !trimmed.includes(':') && !trimmed.includes('/')) {
    return false;
  }
  try {
    const candidate = trimmed.includes('://') ? trimmed : `ws://${trimmed}`;
    const parsed = new URL(candidate);
    if (!parsed.hostname) return false;
    inputHost.value = parsed.hostname;
    if (parsed.port) {
      inputPort.value = String(clampPort(parsed.port));
    } else if (parsed.protocol === 'wss:' || parsed.protocol === 'https:') {
      inputPort.value = '443';
    }
    if (parsed.pathname && parsed.pathname !== '/') {
      inputPath.value = parsed.pathname;
    }
    if (parsed.protocol === 'wss:' || parsed.protocol === 'https:') {
      inputWss.checked = true;
    } else if (parsed.protocol === 'ws:' || parsed.protocol === 'http:') {
      inputWss.checked = false;
    }
    const tokenParam = parsed.searchParams.get('token');
    if (tokenParam) {
      inputToken.value = tokenParam;
    }
    return true;
  } catch {
    return false;
  }
}

function sendMessage<T>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response: (T & { error?: string }) | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || typeof response !== 'object') {
        reject(new Error('Empty response from background worker'));
        return;
      }
      if ('error' in response && typeof response.error === 'string') {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

function readFormConfig(): Partial<ExtensionConfig> {
  parseSmartEndpointInput(inputHost.value);
  const port = clampPort(inputPort.value);
  inputPort.value = String(port);
  const rawPath = inputPath.value.trim() || '/ext';
  const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  inputPath.value = normalizedPath;

  return {
    host: inputHost.value.trim() || '127.0.0.1',
    port,
    path: normalizedPath,
    token: inputToken.value.trim(),
    useWss: inputWss.checked,
    autoConnect: inputAutoConnect.checked,
  };
}

function formatHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function showError(message: string | null): void {
  localError = message;
  const effective = localError || currentState?.lastError || null;
  if (effective) {
    errorBanner.textContent = effective;
    errorBanner.classList.remove('hidden');
  } else {
    errorBanner.textContent = '';
    errorBanner.classList.add('hidden');
  }
}

function renderDirtyBanner(): void {
  if (!configDirtyWhileConnected) {
    dirtyBanner.classList.add('hidden');
    dirtyBanner.innerHTML = '';
    return;
  }
  dirtyBanner.classList.remove('hidden');
  dirtyBanner.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = T.dirtyHint;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-mini';
  btn.textContent = T.reconnectNow;
  btn.addEventListener('click', () => {
    void runAction(btn, { type: 'save_and_connect', config: readFormConfig() }, () => {
      configDirtyWhileConnected = false;
    });
  });
  dirtyBanner.appendChild(span);
  dirtyBanner.appendChild(btn);
}

async function runAction(
  button: HTMLButtonElement | null,
  payload: Record<string, unknown>,
  onSuccess?: () => void,
): Promise<void> {
  if (button) button.disabled = true;
  localError = null;
  try {
    const state = await sendMessage<ExtensionRuntimeState>(payload);
    onSuccess?.();
    render(state);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    if (button) button.disabled = false;
  }
}

function render(state: ExtensionRuntimeState): void {
  currentState = state;

  if (!formHydrated) {
    inputHost.value = state.config.host;
    inputPort.value = String(clampPort(state.config.port));
    inputPath.value = state.config.path;
    inputToken.value = state.config.token;
    inputWss.checked = state.config.useWss;
    inputAutoConnect.checked = state.config.autoConnect;
    formHydrated = true;
  }

  const eligibleTabs = (state.tabs || []).filter((t) => t.eligible);
  const attachedTabs = eligibleTabs.filter((t) => t.attached);
  const authorizedTabs = eligibleTabs.filter((t) => t.authorized);

  statusDot.dataset.state = state.connectionState;
  if (state.connectionState === 'connected') {
    statusText.textContent = T.statusConnected(authorizedTabs.length, attachedTabs.length);
    toggleConnectBtn.textContent = T.disconnect;
    toggleConnectBtn.className = 'btn btn-danger';
  } else if (state.connectionState === 'connecting') {
    statusText.textContent = T.statusConnecting;
    toggleConnectBtn.textContent = T.cancel;
    toggleConnectBtn.className = 'btn btn-danger';
  } else if (state.connectionState === 'reconnecting') {
    statusText.textContent = T.statusReconnecting(state.reconnectAttempt);
    toggleConnectBtn.textContent = T.stop;
    toggleConnectBtn.className = 'btn btn-danger';
  } else if (state.connectionState === 'error') {
    statusText.textContent = T.statusError;
    toggleConnectBtn.textContent = T.retry;
    toggleConnectBtn.className = 'btn btn-primary';
  } else {
    statusText.textContent = T.statusDisconnected;
    toggleConnectBtn.textContent = T.connect;
    toggleConnectBtn.className = 'btn btn-primary';
    configDirtyWhileConnected = false;
  }

  showError(localError);
  renderDirtyBanner();

  const isManual = state.config.tabPolicyMode === 'manual';
  modeAutoBtn.classList.toggle('active', !isManual);
  modeManualBtn.classList.toggle('active', isManual);
  modeAutoBtn.setAttribute('aria-pressed', String(!isManual));
  modeManualBtn.setAttribute('aria-pressed', String(isManual));

  // Avoid wiping DOM on 2s poll when tab rows haven't changed (preserves focus & scroll)
  const tabsKey = JSON.stringify({
    mode: state.config.tabPolicyMode,
    tabs: eligibleTabs.map((t) => [t.tabId, t.title, t.url, t.attached, t.authorized, t.detachReason ?? '']),
  });
  if (tabsKey === lastTabsRenderKey) {
    return;
  }
  lastTabsRenderKey = tabsKey;

  tabListEl.innerHTML = '';
  if (eligibleTabs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = T.emptyTabs;
    tabListEl.appendChild(empty);
    return;
  }

  for (const tab of eligibleTabs) {
    const item = document.createElement('div');
    item.className = 'tab-item';

    const info = document.createElement('div');
    info.className = 'tab-info';
    const titleEl = document.createElement('div');
    titleEl.className = 'tab-title';
    titleEl.textContent = tab.title || T.untitled;
    const urlEl = document.createElement('div');
    urlEl.className = 'tab-url';
    urlEl.textContent = formatHost(tab.url);
    info.appendChild(titleEl);
    info.appendChild(urlEl);

    if (isManual) {
      const label = document.createElement('label');
      label.className = 'tab-select-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = tab.authorized;
      cb.title = T.authorizeTitle;
      cb.addEventListener('change', () => {
        cb.disabled = true;
        void sendMessage<ExtensionRuntimeState>({
          type: cb.checked ? 'authorize_tab' : 'revoke_tab',
          tabId: tab.tabId,
        })
          .then((next) => {
            lastTabsRenderKey = '';
            render(next);
          })
          .catch((err) => {
            cb.disabled = false;
            showError(err instanceof Error ? err.message : String(err));
          });
      });
      label.appendChild(cb);
      label.appendChild(info);
      item.appendChild(label);
    } else {
      item.appendChild(info);
    }

    const actions = document.createElement('div');
    actions.className = 'tab-actions';

    const isDevtools = tab.detachReason === 'replaced_with_devtools';
    const isAttachFailed =
      typeof tab.detachReason === 'string' && tab.detachReason.startsWith('attach_failed:');

    if (tab.attached) {
      const pill = document.createElement('span');
      pill.className = 'pill attached';
      pill.textContent = T.attached;
      actions.appendChild(pill);

      const detachBtn = document.createElement('button');
      detachBtn.className = 'btn-mini';
      detachBtn.type = 'button';
      detachBtn.textContent = T.detach;
      detachBtn.addEventListener('click', () => {
        void runAction(detachBtn, { type: 'detach_tab', tabId: tab.tabId });
      });
      actions.appendChild(detachBtn);
    } else if (isDevtools || isAttachFailed) {
      const pill = document.createElement('span');
      pill.className = 'pill warn';
      pill.textContent = isDevtools ? T.devtoolsBusy : T.attachFailed;
      if (isAttachFailed && tab.detachReason) {
        pill.title = tab.detachReason;
      }
      actions.appendChild(pill);

      const reattachBtn = document.createElement('button');
      reattachBtn.className = 'btn-mini';
      reattachBtn.type = 'button';
      reattachBtn.textContent = T.reattach;
      reattachBtn.addEventListener('click', () => {
        void runAction(reattachBtn, { type: 'authorize_tab', tabId: tab.tabId });
      });
      actions.appendChild(reattachBtn);
    } else if (tab.authorized) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = T.ready;
      actions.appendChild(pill);
    }

    item.appendChild(actions);
    tabListEl.appendChild(item);
  }
}

toggleConnectBtn.addEventListener('click', () => {
  if (!currentState) return;
  const active =
    currentState.connectionState === 'connected' ||
    currentState.connectionState === 'connecting' ||
    currentState.connectionState === 'reconnecting';
  if (active) {
    void runAction(toggleConnectBtn, { type: 'disconnect' });
  } else {
    void runAction(
      toggleConnectBtn,
      { type: 'save_and_connect', config: readFormConfig() },
      () => {
        configDirtyWhileConnected = false;
      },
    );
  }
});

toggleTokenVisBtn.addEventListener('click', () => {
  const showing = inputToken.type === 'text';
  inputToken.type = showing ? 'password' : 'text';
  toggleTokenVisBtn.textContent = showing ? T.show : T.hide;
  toggleTokenVisBtn.setAttribute('aria-pressed', String(!showing));
  toggleTokenVisBtn.setAttribute('aria-label', showing ? T.show : T.hide);
});

modeAutoBtn.addEventListener('click', () => {
  void runAction(modeAutoBtn, { type: 'set_mode', mode: 'auto' });
});

modeManualBtn.addEventListener('click', () => {
  void runAction(modeManualBtn, { type: 'set_mode', mode: 'manual' });
});

inputHost.addEventListener('paste', () => {
  window.setTimeout(() => {
    if (parseSmartEndpointInput(inputHost.value)) {
      void sendMessage<ExtensionRuntimeState>({
        type: 'save_config',
        config: readFormConfig(),
      })
        .then((next) => {
          if (next.connectionState === 'connected') configDirtyWhileConnected = true;
          render(next);
        })
        .catch((err) => showError(err instanceof Error ? err.message : String(err)));
    }
  }, 0);
});

for (const el of [inputHost, inputPort, inputPath, inputToken, inputWss, inputAutoConnect]) {
  el.addEventListener('change', () => {
    void sendMessage<ExtensionRuntimeState>({
      type: 'save_config',
      config: readFormConfig(),
    })
      .then((next) => {
        if (next.connectionState === 'connected' && el !== inputAutoConnect) {
          configDirtyWhileConnected = true;
        }
        render(next);
      })
      .catch((err) => showError(err instanceof Error ? err.message : String(err)));
  });
}

async function refresh(): Promise<void> {
  try {
    const state = await sendMessage<ExtensionRuntimeState>({ type: 'get_state' });
    render(state);
  } catch (err) {
    statusText.textContent = T.bgUnreachable(err instanceof Error ? err.message : String(err));
  }
}

applyStaticLocale();
void refresh();
setInterval(() => {
  void refresh();
}, 2_000);
