window.__ModuleLoader__.load({
  id: '@local/agent-browser-bridge',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const STRINGS = {
      en: {
        title: 'Browser bridge',
        loading: 'Browser…',
        connected: (n) => `Browser · ${n} ${n === 1 ? 'tab' : 'tabs'}`,
        waiting: 'Browser · waiting',
        offline: 'Browser · offline',
        readOnly: 'Read-only',
        fullAccess: 'Full control',
        modeAuto: 'Auto-takeover',
        modeManual: 'Manual tabs',
        relayEndpoint: 'Extension endpoint',
        tokenRequiredHint: 'Token authentication is required. Enter the configured Relay token in the extension popup.',
        remoteHostHint: 'Replace <server-host> with this machine\'s reachable IP or domain.',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        tabsHeading: (n) => `Visible tabs (${n})`,
        noTabs: 'No eligible normal web tabs open.',
        manualEmpty: 'Manual mode active — check tabs in the Chrome extension popup to grant access.',
        waitingHint: 'Relay is running. Install or open the Agent Browser Bridge extension and click Connect.',
        offlineHint: 'Relay is unreachable. Check plugin settings or port availability.',
        detach: 'Detach',
        detaching: 'Detaching…',
        attached: 'Attached',
        devtoolsBusy: 'DevTools active',
        attachFailed: 'Attach failed',
        ready: 'Ready',
        downloadZip: 'Download Chrome extension (.zip)',
        installSteps: 'Unzip → open chrome://extensions (or edge:// / brave://) → enable Developer mode → Load unpacked.',
        close: 'Close',
      },
      zh: {
        title: '真实浏览器桥接',
        loading: '浏览器…',
        connected: (n) => `浏览器 · ${n} 个标签`,
        waiting: '浏览器 · 等待扩展',
        offline: '浏览器 · 未就绪',
        readOnly: '只读模式',
        fullAccess: '读写控制',
        modeAuto: '自动接管',
        modeManual: '手动授权',
        relayEndpoint: '扩展连接地址',
        tokenRequiredHint: '当前已启用 Token 鉴权，请在浏览器扩展弹窗中填入对应 Token。',
        remoteHostHint: '请将 <server-host> 替换为本机可访问的 IP 或域名。',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败',
        tabsHeading: (n) => `已同步标签页 (${n})`,
        noTabs: '暂未检测到普通网页标签页。',
        manualEmpty: '当前为手动授权模式，请在浏览器扩展弹窗中勾选要授权的标签页。',
        waitingHint: 'Relay 已就绪。安装或打开 Agent Browser Bridge 扩展并点击连接即可开始。',
        offlineHint: 'Relay 未响应，请检查插件配置或端口占用情况。',
        detach: '释放',
        detaching: '释放中…',
        attached: '已接管',
        devtoolsBusy: 'F12 占用',
        attachFailed: '接管失败',
        ready: '就绪',
        downloadZip: '下载 Chrome 扩展包 (.zip)',
        installSteps: '解压后打开 chrome://extensions（或 edge:// / brave://）→ 开启开发者模式 → 加载已解压扩展。',
        close: '关闭',
      },
    };

    function getStrings(langHint) {
      const lang = String(langHint || document.documentElement.lang || navigator.language || 'en').toLowerCase();
      return lang.startsWith('zh') ? STRINGS.zh : STRINGS.en;
    }

    function shortHost(url) {
      try {
        return new URL(url).host || url;
      } catch {
        return url || '';
      }
    }

    function formatDisplayEndpoint(status) {
      const rawHost = status?.host || '127.0.0.1';
      const isWildcard = rawHost === '0.0.0.0' || rawHost === '::';
      const displayHost = isWildcard ? '<server-host>' : rawHost;
      const port = status?.port || 9229;
      const path = status?.extPath || '/ext';
      return {
        display: `${displayHost}:${port}${path}`,
        copyValue: `ws://${displayHost}:${port}${path}`,
        isWildcard,
      };
    }

    async function copyToClipboard(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          // Fall through to execCommand fallback (e.g. non-secure HTTP LAN origins).
        }
      }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }

    const STYLE_ID = 'abb-dsh-plugin-styles';
    const SCOPED_CSS = `
.abb-dock-root {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
.abb-dock-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  max-width: 100%;
  padding: 1px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease, transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
}
.abb-dock-trigger[data-surface="hero"] {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-card-fill);
  padding: 3px 10px;
  min-height: 26px;
}
@media (hover: hover) and (pointer: fine) {
  .abb-dock-trigger:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
}
.abb-dock-trigger[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
}
.abb-dock-trigger:active {
  transform: scale(0.97);
}
.abb-dock-trigger:focus-visible,
.abb-btn-mini:focus-visible,
.abb-close-btn:focus-visible,
.abb-cta-link:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.abb-trigger-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.abb-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
  background: var(--dsw-alias-state-idle-primary);
}
.abb-dot[data-state="connected"] {
  background: var(--dsw-alias-state-success-primary);
}
.abb-dot[data-state="waiting"] {
  background: var(--dsw-alias-state-warn-primary);
}
.abb-dot[data-state="offline"] {
  background: var(--dsw-alias-state-error-primary);
}
@keyframes abb-pop-in {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
.abb-popover {
  position: fixed;
  z-index: 1100;
  width: 332px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  border-radius: var(--dsw-radius-lg, 12px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2));
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.2));
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
  animation: abb-pop-in 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
@media (prefers-reduced-motion: reduce) {
  .abb-popover,
  .abb-dock-trigger,
  .abb-btn-mini {
    animation: none;
    transition: none;
  }
}
.abb-pop-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.abb-pop-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 600;
  font-size: 13px;
  min-width: 0;
}
.abb-pop-badges {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.abb-badge {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-card-fill);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.abb-badge[data-tone="success"] {
  color: var(--dsw-alias-state-success-primary);
}
.abb-badge[data-tone="warn"] {
  color: var(--dsw-alias-state-warn-primary);
}
.abb-close-btn {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  border-radius: var(--dsw-radius-sm, 6px);
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.abb-close-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.abb-section-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.abb-endpoint-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-card-fill);
}
.abb-mono {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.abb-btn-mini {
  flex-shrink: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: background-color 120ms ease, transform 120ms ease;
}
.abb-btn-mini:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.abb-btn-mini:active:not(:disabled) {
  transform: scale(0.97);
}
.abb-btn-mini:disabled {
  opacity: 0.55;
  cursor: default;
}
.abb-hint {
  font-size: 12px;
  line-height: 1.45;
  color: var(--dsw-alias-label-secondary);
}
.abb-error {
  font-size: 11px;
  line-height: 1.4;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-secondary, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.abb-tabs-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 176px;
  overflow-y: auto;
}
.abb-tab-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-card-fill);
}
.abb-tab-meta {
  min-width: 0;
  flex: 1;
}
.abb-tab-title {
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.abb-tab-host {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.abb-tab-actions {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.abb-onboarding {
  border-top: 1px solid var(--dsw-alias-border-l1);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.abb-cta-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-on-color, #ffffff);
  text-decoration: none;
  font-size: 12px;
  font-weight: 500;
}
.abb-cta-link:hover {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
}
.abb-link {
  color: var(--dsw-alias-link);
  text-decoration: none;
  font-size: 12px;
  font-weight: 500;
}
.abb-link:hover {
  text-decoration: underline;
}
.abb-steps {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  line-height: 1.45;
}
`;

    function ensureStyleElement() {
      let el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = SCOPED_CSS;
        document.head.appendChild(el);
      }
      return el;
    }

    function createDockComponent(ctx, surface) {
      return function BrowserBridgeControl() {
        const [langTick, setLangTick] = useState(0);
        const [status, setStatus] = useState(null);
        const [loadState, setLoadState] = useState('loading'); // 'loading' | 'ok' | 'error'
        const [actionError, setActionError] = useState(null);
        const [detachingIds, setDetachingIds] = useState(() => new Set());
        const [open, setOpen] = useState(false);
        const [copyState, setCopyState] = useState('idle'); // 'idle' | 'copied' | 'failed'
        const [popStyle, setPopStyle] = useState({ left: 12, top: 12 });

        const triggerRef = useRef(null);
        const popoverRef = useRef(null);
        const copyTimerRef = useRef(null);
        const fetchSeqRef = useRef(0);

        const localeSvc = ctx.get('locale');
        const activeLocale =
          localeSvc?.snapshot?.active ?? document.documentElement.lang ?? navigator.language;
        const t = getStrings(activeLocale);
        void langTick;

        useEffect(() => {
          if (!localeSvc || typeof localeSvc.subscribe !== 'function') return;
          return localeSvc.subscribe(() => {
            setLangTick((n) => n + 1);
          });
        }, [localeSvc]);

        const fetchStatus = useCallback(async () => {
          const seq = ++fetchSeqRef.current;
          try {
            const res = await fetch('/api/agent-browser-bridge/status', { cache: 'no-store' });
            if (seq !== fetchSeqRef.current) return;
            if (!res.ok) {
              setLoadState('error');
              setStatus(null);
              return;
            }
            const data = await res.json();
            if (seq !== fetchSeqRef.current) return;
            setStatus(data);
            setLoadState('ok');
          } catch {
            if (seq !== fetchSeqRef.current) return;
            setLoadState('error');
            setStatus(null);
          }
        }, []);

        useEffect(() => {
          void fetchStatus();
          const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') {
              void fetchStatus();
            }
          }, 5000);
          const onResume = () => {
            if (document.visibilityState === 'visible') {
              void fetchStatus();
            }
          };
          document.addEventListener('visibilitychange', onResume);
          window.addEventListener('focus', onResume);
          return () => {
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', onResume);
            window.removeEventListener('focus', onResume);
            if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
          };
        }, [fetchStatus]);

        const updatePosition = useCallback(() => {
          const trigger = triggerRef.current;
          if (!trigger) return;
          const rect = trigger.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const popWidth = Math.min(332, vw - 24);
          const popHeight = popoverRef.current?.offsetHeight || 280;

          let left = rect.left + rect.width / 2 - popWidth / 2;
          left = Math.max(12, Math.min(left, vw - popWidth - 12));

          // Prefer opening above the trigger; flip below if not enough room above.
          let top = rect.top - popHeight - 8;
          if (top < 12) {
            top = Math.min(rect.bottom + 8, vh - popHeight - 12);
          }
          top = Math.max(12, top);
          setPopStyle({ left: Math.round(left), top: Math.round(top) });
        }, []);

        useEffect(() => {
          if (!open) return;
          updatePosition();
          const raf = window.requestAnimationFrame(updatePosition);
          window.addEventListener('resize', updatePosition);
          window.addEventListener('scroll', updatePosition, true);

          const onKeyDown = (ev) => {
            if (ev.key === 'Escape') {
              setOpen(false);
              triggerRef.current?.focus();
            }
          };
          const onOutside = (ev) => {
            const target = ev.target;
            if (
              triggerRef.current?.contains(target) ||
              popoverRef.current?.contains(target)
            ) {
              return;
            }
            setOpen(false);
          };

          window.addEventListener('keydown', onKeyDown);
          window.addEventListener('pointerdown', onOutside, true);
          return () => {
            window.cancelAnimationFrame(raf);
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('pointerdown', onOutside, true);
          };
        }, [open, updatePosition, status]);

        const allTabs = status?.tabs || [];
        const eligibleTabs = allTabs.filter((tab) => tab.eligible);
        const authorizedTabs = eligibleTabs.filter((tab) => tab.authorized);
        const tabPolicyMode = status?.extension?.tabPolicyMode || 'auto';

        const visualState =
          loadState === 'loading'
            ? 'loading'
            : loadState === 'error' || !status?.relayRunning
              ? 'offline'
              : status?.extensionConnected
                ? 'connected'
                : 'waiting';

        const pillLabel =
          visualState === 'loading'
            ? t.loading
            : visualState === 'connected'
              ? t.connected(authorizedTabs.length)
              : visualState === 'waiting'
                ? t.waiting
                : t.offline;

        const endpointInfo = formatDisplayEndpoint(status);

        const handleCopy = async () => {
          const ok = await copyToClipboard(endpointInfo.copyValue);
          setCopyState(ok ? 'copied' : 'failed');
          if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
          copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1800);
        };

        const handleDetach = async (tabId) => {
          setActionError(null);
          setDetachingIds((prev) => new Set(prev).add(tabId));
          try {
            const res = await fetch('/api/agent-browser-bridge/control', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'detach_tab', tabId }),
            });
            const data = await res.json().catch(() => ({ ok: false }));
            if (!res.ok || data?.ok === false) {
              setActionError(data?.error || `HTTP ${res.status}`);
            }
            await fetchStatus();
          } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err));
          } finally {
            setDetachingIds((prev) => {
              const next = new Set(prev);
              next.delete(tabId);
              return next;
            });
          }
        };

        const popoverNode =
          open &&
          ReactDOM.createPortal(
            h(
              'div',
              {
                ref: popoverRef,
                className: 'abb-popover',
                role: 'dialog',
                'aria-label': t.title,
                style: { left: `${popStyle.left}px`, top: `${popStyle.top}px` },
              },
              h(
                'div',
                { className: 'abb-pop-header' },
                h(
                  'div',
                  { className: 'abb-pop-title' },
                  h('span', { className: 'abb-dot', 'data-state': visualState }),
                  h('span', null, t.title),
                ),
                h(
                  'div',
                  { className: 'abb-pop-badges' },
                  h('span', { className: 'abb-badge' }, status?.readOnly ? t.readOnly : t.fullAccess),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'abb-close-btn',
                      'aria-label': t.close,
                      onClick: () => {
                        setOpen(false);
                        triggerRef.current?.focus();
                      },
                    },
                    '×',
                  ),
                ),
              ),
              actionError && h('div', { className: 'abb-error', role: 'alert' }, actionError),
              h(
                'div',
                null,
                h(
                  'div',
                  { className: 'abb-section-label' },
                  h('span', null, t.relayEndpoint),
                  status?.extensionConnected &&
                    h(
                      'span',
                      null,
                      `${status.extension?.browserName || 'Chrome'} · ${tabPolicyMode === 'manual' ? t.modeManual : t.modeAuto}`,
                    ),
                ),
                h(
                  'div',
                  { className: 'abb-endpoint-box' },
                  h('span', { className: 'abb-mono', title: endpointInfo.copyValue }, endpointInfo.display),
                  h(
                    'button',
                    { type: 'button', className: 'abb-btn-mini', onClick: () => void handleCopy() },
                    copyState === 'copied'
                      ? t.copied
                      : copyState === 'failed'
                        ? t.copyFailed
                        : t.copy,
                  ),
                ),
              ),
              endpointInfo.isWildcard && h('div', { className: 'abb-steps' }, t.remoteHostHint),
              status?.tokenRequired && h('div', { className: 'abb-steps' }, t.tokenRequiredHint),
              visualState === 'offline' &&
                h('div', { className: 'abb-hint' }, status?.relayError || t.offlineHint),
              visualState === 'waiting' && h('div', { className: 'abb-hint' }, t.waitingHint),
              visualState === 'connected' &&
                h(
                  'div',
                  null,
                  h('div', { className: 'abb-section-label' }, h('span', null, t.tabsHeading(authorizedTabs.length))),
                  h(
                    'div',
                    { className: 'abb-tabs-list' },
                    authorizedTabs.length === 0
                      ? h(
                          'div',
                          { className: 'abb-hint' },
                          tabPolicyMode === 'manual' && eligibleTabs.length > 0 ? t.manualEmpty : t.noTabs,
                        )
                      : authorizedTabs.map((tab) => {
                          const isBusy = detachingIds.has(tab.tabId);
                          const isDevtools = tab.detachReason === 'replaced_with_devtools';
                          const isFailed =
                            typeof tab.detachReason === 'string' &&
                            tab.detachReason.startsWith('attach_failed:');
                          return h(
                            'div',
                            { key: tab.tabId, className: 'abb-tab-row' },
                            h(
                              'div',
                              { className: 'abb-tab-meta' },
                              h('div', { className: 'abb-tab-title' }, tab.title || '(untitled)'),
                              h('div', { className: 'abb-tab-host' }, shortHost(tab.url)),
                            ),
                            h(
                              'div',
                              { className: 'abb-tab-actions' },
                              tab.attached
                                ? [
                                    h('span', { key: 'b', className: 'abb-badge', 'data-tone': 'success' }, t.attached),
                                    h(
                                      'button',
                                      {
                                        key: 'd',
                                        type: 'button',
                                        className: 'abb-btn-mini',
                                        disabled: isBusy,
                                        onClick: () => void handleDetach(tab.tabId),
                                      },
                                      isBusy ? t.detaching : t.detach,
                                    ),
                                  ]
                                : isDevtools
                                  ? h('span', { className: 'abb-badge', 'data-tone': 'warn' }, t.devtoolsBusy)
                                  : isFailed
                                    ? h(
                                        'span',
                                        { className: 'abb-badge', 'data-tone': 'warn', title: tab.detachReason },
                                        t.attachFailed,
                                      )
                                    : h('span', { className: 'abb-badge' }, t.ready),
                            ),
                          );
                        }),
                  ),
                ),
              status?.extensionZipAvailable &&
                h(
                  'div',
                  { className: 'abb-onboarding' },
                  h(
                    'a',
                    {
                      className: visualState === 'waiting' ? 'abb-cta-link' : 'abb-link',
                      href: '/api/agent-browser-bridge/extension.zip',
                      download: 'agent-browser-bridge-extension.zip',
                    },
                    t.downloadZip,
                  ),
                  visualState !== 'connected' && h('div', { className: 'abb-steps' }, t.installSteps),
                ),
            ),
            document.body,
          );

        return h(
          'div',
          { className: 'abb-dock-root' },
          h(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              className: 'abb-dock-trigger',
              'data-surface': surface,
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              onClick: () => {
                setActionError(null);
                setOpen((prev) => !prev);
                void fetchStatus();
              },
            },
            h('span', { className: 'abb-dot', 'data-state': visualState, 'aria-hidden': true }),
            h('span', { className: 'abb-trigger-label' }, pillLabel),
          ),
          popoverNode,
        );
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const styleEl = ensureStyleElement();
        ctx.effect(() => () => {
          styleEl.remove();
        });

        const ComposerDockControl = createDockComponent(ctx, 'dock');
        const HeroOptionControl = createDockComponent(ctx, 'hero');

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'agent-browser-bridge-status',
              order: 20,
            },
            ComposerDockControl,
          ),
        );

        ctx.slots.inject('conversation.hero.options', () =>
          ctx.slots.register(
            {
              name: 'conversation.hero.options',
              id: 'agent-browser-bridge-hero-status',
              order: 20,
            },
            HeroOptionControl,
          ),
        );
      },
    };
  },
});
