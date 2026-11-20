window.__ModuleLoader__.load({
  id: '@local/agent-browser-bridge',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const SOURCE_NAME = 'browser-tabs';
    const REF_PLACEHOLDER = '\uFFFC';

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
        remoteHostHint: "Replace <server-host> with this machine's reachable IP or domain.",
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
        pickerTitle: 'Browser tabs',
        pickerKeys: '↑↓ · Enter · Esc',
        pickerAria: 'Browser tab suggestions',
        pickerHint: 'Tip: type $ in the composer to quickly pick a browser tab.',
        activeTabBadge: 'Active',
        engineLabel: 'Browser engine',
        engineMissing: 'agent-browser is not installed',
        engineMissingHint: (hint) => hint,
        sessionsHeading: (n) => `Isolated test browsers (${n})`,
        closeSession: 'Close',
        closingSession: 'Closing…',
        sessionTargetHeadless: 'Headless',
        sessionTargetHeaded: 'Headed',
        sessionTargetBridge: 'Real browser',
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
        pickerTitle: '浏览器标签页',
        pickerKeys: '↑↓ 选择 · Enter 插入 · Esc 关闭',
        pickerAria: '浏览器标签页快捷选择',
        pickerHint: '提示：在输入框键入 $ 可快速搜索并插入标签页。',
        activeTabBadge: '当前',
        engineLabel: '浏览器引擎',
        engineMissing: '未检测到 agent-browser',
        engineMissingHint: (hint) => hint,
        sessionsHeading: (n) => `隔离测试浏览器 (${n})`,
        closeSession: '关闭',
        closingSession: '关闭中…',
        sessionTargetHeadless: '无头',
        sessionTargetHeaded: '有头',
        sessionTargetBridge: '真实浏览器',
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

    function truncateText(text, maxLen) {
      const s = String(text || '').trim();
      if (s.length <= maxLen) return s;
      return `${s.slice(0, maxLen - 1)}…`;
    }

    function normalizeAuthorizedTabs(status) {
      const raw = status?.tabs || [];
      let seq = 1;
      const out = [];
      for (const tab of raw) {
        if (!tab || !tab.eligible || !tab.authorized) continue;
        const tabRef = typeof tab.tabRef === 'string' && tab.tabRef ? tab.tabRef : `$t${seq}`;
        seq += 1;
        out.push({
          ...tab,
          tabRef,
          host: shortHost(tab.url),
        });
      }
      return out;
    }

    /**
     * Detect an active `$query` token immediately preceding the caret.
     * Requires `$` at offset 0 or preceded by whitespace; stops on whitespace or chip placeholder.
     */
    function detectDollarTabTrigger(detectText, caret) {
      if (typeof detectText !== 'string' || typeof caret !== 'number' || caret <= 0) return null;
      const bounded = Math.min(caret, detectText.length);
      const before = detectText.slice(0, bounded);
      const dollarAt = before.lastIndexOf('$');
      if (dollarAt < 0) return null;
      if (dollarAt > 0 && !/\s/.test(before[dollarAt - 1])) return null;
      const query = before.slice(dollarAt + 1);
      if (/[\s\uFFFC]/.test(query)) return null;
      return {
        start: dollarAt,
        end: bounded,
        query,
      };
    }

    /**
     * Filter and rank authorized tabs for a `$query`.
     * Matches exact/prefix `$tN` / `tN` / `N` first, then title/host/URL substring, then subsequence.
     */
    function filterBrowserTabs(tabs, rawQuery) {
      if (!Array.isArray(tabs) || tabs.length === 0) return [];
      const q = String(rawQuery || '').trim().toLowerCase();
      if (!q) return tabs;

      const stripped = q.startsWith('$') ? q.slice(1) : q;
      const scored = [];
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const refLower = String(tab.tabRef || `$t${i + 1}`).toLowerCase(); // "$t4"
        const refNoDollar = refLower.startsWith('$') ? refLower.slice(1) : refLower; // "t4"
        const numOnly = refNoDollar.startsWith('t') ? refNoDollar.slice(1) : refNoDollar; // "4"
        const titleLower = String(tab.title || '').toLowerCase();
        const urlLower = String(tab.url || '').toLowerCase();
        const hostLower = String(tab.host || '').toLowerCase();

        let score = -1;
        if (stripped === refNoDollar || stripped === numOnly || q === refLower) {
          score = 1000;
        } else if (refNoDollar.startsWith(stripped) || numOnly.startsWith(stripped)) {
          score = 800;
        } else if (titleLower.startsWith(stripped) || hostLower.startsWith(stripped)) {
          score = 600;
        } else if (titleLower.includes(stripped)) {
          score = 450;
        } else if (hostLower.includes(stripped) || urlLower.includes(stripped)) {
          score = 300;
        } else {
          // Ordered subsequence check on title + host
          const hay = `${titleLower} ${hostLower}`;
          let qi = 0;
          for (let hi = 0; hi < hay.length && qi < stripped.length; hi++) {
            if (hay[hi] === stripped[qi]) qi++;
          }
          if (qi === stripped.length && stripped.length >= 2) {
            score = 150;
          }
        }
        if (score >= 0) {
          scored.push({ tab, score, index: i });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.index - b.index);
      return scored.map((entry) => entry.tab);
    }

    function encodeTabRefPayload(tab) {
      return JSON.stringify({
        tabId: tab.tabId,
        tabRef: tab.tabRef,
        title: tab.title || '',
        url: tab.url || '',
        targetId: tab.targetId || '',
      });
    }

    function decodeTabRefPayload(rawRef) {
      try {
        const parsed = JSON.parse(rawRef);
        if (parsed && typeof parsed === 'object') {
          return {
            tabId: typeof parsed.tabId === 'number' ? parsed.tabId : undefined,
            tabRef: typeof parsed.tabRef === 'string' ? parsed.tabRef : '$t1',
            title: typeof parsed.title === 'string' ? parsed.title : '',
            url: typeof parsed.url === 'string' ? parsed.url : '',
            targetId: typeof parsed.targetId === 'string' ? parsed.targetId : '',
          };
        }
      } catch {
        // Fallback if plain ref string
      }
      return { tabId: undefined, tabRef: String(rawRef || ''), title: '', url: '', targetId: '' };
    }

    /** A `tab-<id>` id is a placeholder the extension uses before Chrome reports the real one. */
    function isRealTargetId(targetId) {
      return typeof targetId === 'string' && targetId.length > 0 && !/^tab-\d+$/.test(targetId);
    }

    function formatSerializedTab(tab) {
      const title = (tab.title || shortHost(tab.url) || 'Untitled').replace(/\s+/g, ' ').trim();
      const urlPart = tab.url ? ` (${tab.url})` : '';
      const targetPart = isRealTargetId(tab.targetId) ? ` (targetId: ${tab.targetId})` : '';
      return `[Browser Tab ${tab.tabRef}${targetPart}: "${title}"${urlPart}]`;
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
          // Fall through to execCommand fallback.
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

    /** Shared lightweight status store so Dock, Hero, and $ Tab Picker share one poll loop. */
    function createBridgeStatusStore() {
      let state = { loadState: 'loading', status: null, authorizedTabs: [], updatedAt: 0 };
      const listeners = new Set();
      let seq = 0;
      let timer = null;
      let started = false;

      const emit = () => {
        for (const fn of listeners) {
          try {
            fn();
          } catch {
            // Ignore listener errors.
          }
        }
      };

      const fetchNow = async () => {
        const mySeq = ++seq;
        try {
          const res = await fetch('/api/agent-browser-bridge/status', { cache: 'no-store' });
          if (mySeq !== seq) return state;
          if (!res.ok) {
            state = { loadState: 'error', status: null, authorizedTabs: [], updatedAt: Date.now() };
            emit();
            return state;
          }
          const data = await res.json();
          if (mySeq !== seq) return state;
          state = {
            loadState: 'ok',
            status: data,
            authorizedTabs: normalizeAuthorizedTabs(data),
            updatedAt: Date.now(),
          };
          emit();
          return state;
        } catch {
          if (mySeq !== seq) return state;
          state = { loadState: 'error', status: null, authorizedTabs: [], updatedAt: Date.now() };
          emit();
          return state;
        }
      };

      const onResume = () => {
        if (document.visibilityState === 'visible') {
          void fetchNow();
        }
      };

      const start = () => {
        if (started) return;
        started = true;
        void fetchNow();
        timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') {
            void fetchNow();
          }
        }, 5000);
        document.addEventListener('visibilitychange', onResume);
        window.addEventListener('focus', onResume);
      };

      const stop = () => {
        if (!started) return;
        started = false;
        if (timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
        document.removeEventListener('visibilitychange', onResume);
        window.removeEventListener('focus', onResume);
      };

      return {
        start,
        stop,
        getSnapshot: () => state,
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        refresh: () => fetchNow(),
        refreshIfStale: (maxAgeMs = 1500) => {
          if (Date.now() - state.updatedAt > maxAgeMs) {
            void fetchNow();
          }
        },
      };
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
/* $ Quick Tab Picker Menu inside conversation.input.overlay — floats above composer card like DSH MenuView */
.abb-picker-shell {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  z-index: 40;
  max-height: 360px;
  display: flex;
  flex-direction: column;
  border-radius: var(--dsw-radius-lg, 12px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2));
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.2));
  overflow: hidden;
  animation: abb-pop-in 140ms cubic-bezier(0.23, 1, 0.32, 1);
}
.abb-picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 12px 5px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-menu-group-header-fill, transparent);
}
.abb-picker-heading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.abb-picker-keys {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.abb-picker-list {
  max-height: 292px;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.abb-picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-md, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  text-align: left;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.3;
}
.abb-picker-row[data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.abb-picker-ref {
  flex-shrink: 0;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--dsw-radius-sm, 5px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-card-fill);
  color: var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary));
}
.abb-picker-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.abb-picker-host {
  flex-shrink: 1;
  max-width: 170px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
@media (prefers-reduced-motion: reduce) {
  .abb-popover,
  .abb-picker-shell,
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
        document.head.appendChild(el);
      }
      el.textContent = SCOPED_CSS;
      return el;
    }

    function useBridgeStatus(statusStore) {
      const [snap, setSnap] = useState(() => statusStore.getSnapshot());
      useEffect(() => {
        setSnap(statusStore.getSnapshot());
        return statusStore.subscribe(() => setSnap(statusStore.getSnapshot()));
      }, [statusStore]);
      return snap;
    }

    function useLocaleStrings(ctx) {
      const [tick, setTick] = useState(0);
      const localeSvc = ctx.get('locale');
      useEffect(() => {
        if (!localeSvc || typeof localeSvc.subscribe !== 'function') return;
        return localeSvc.subscribe(() => setTick((n) => n + 1));
      }, [localeSvc]);
      void tick;
      const activeLocale =
        localeSvc?.snapshot?.active ?? document.documentElement.lang ?? navigator.language;
      return getStrings(activeLocale);
    }

    /**
     * Native `$` Browser Tab Quick-Picker mounted in `conversation.input.overlay`.
     * Triggered whenever the user types `$` (at draft start or after whitespace) in the composer.
     */
    function createDollarTabPicker(ctx, statusStore, hasReferenceCodec) {
      return function DollarTabPickerOverlay({ actx, shell }) {
        const t = useLocaleStrings(ctx);
        const bridge = useBridgeStatus(statusStore);

        const [hit, setHit] = useState(null);
        const [highlightIdx, setHighlightIdx] = useState(0);
        const [dismissedAt, setDismissedAt] = useState(null);
        const menuRef = useRef(null);
        const rowRefs = useRef([]);

        const readTriggerFromShell = useCallback(() => {
          if (!shell) return null;
          const snap = shell.snapshot || shell.state?.getSnapshot?.();
          if (!snap || (snap.phase !== 'plain' && snap.phase !== 'claimed')) return null;

          let detectText =
            shell.projection?.detectText ??
            shell.draftEditor?.projection?.detectText;
          let caret = null;

          if (typeof shell.caretSpan === 'function') {
            const sel = shell.caretSpan();
            if (sel && sel.start === sel.end) {
              caret = sel.end;
            } else {
              return null; // Non-collapsed text selection: do not pop completion menu.
            }
          }

          if (typeof detectText !== 'string') {
            detectText = typeof snap.draft === 'string' ? snap.draft : '';
            if (caret === null) caret = detectText.length;
          }

          if (caret === null) return null;
          const detected = detectDollarTabTrigger(detectText, caret);
          if (!detected) return null;
          return {
            ...detected,
            draftRev: snap.draftRev,
          };
        }, [shell]);

        // Track every Lexical text/selection update + InputState update
        useEffect(() => {
          if (!shell) return;
          const sync = () => {
            const nextHit = readTriggerFromShell();
            setHit((prev) => {
              if (!nextHit) {
                setDismissedAt(null);
                return null;
              }
              if (
                prev &&
                prev.start === nextHit.start &&
                prev.end === nextHit.end &&
                prev.query === nextHit.query &&
                prev.draftRev === nextHit.draftRev
              ) {
                return prev;
              }
              if (!prev) {
                statusStore.refreshIfStale(1500);
              }
              if (prev && prev.start !== nextHit.start) {
                setDismissedAt(null);
              }
              return nextHit;
            });
          };

          sync();
          const offs = [];
          if (shell.state && typeof shell.state.subscribe === 'function') {
            offs.push(shell.state.subscribe(sync));
          }
          if (shell.editor && typeof shell.editor.registerUpdateListener === 'function') {
            offs.push(shell.editor.registerUpdateListener(sync));
          }
          return () => {
            for (const off of offs) {
              if (typeof off === 'function') off();
            }
          };
        }, [shell, readTriggerFromShell, statusStore]);

        const isConnected = Boolean(bridge.status?.extensionConnected);
        const filteredTabs = useMemo(() => {
          if (!hit || !isConnected) return [];
          return filterBrowserTabs(bridge.authorizedTabs, hit.query);
        }, [hit, isConnected, bridge.authorizedTabs]);

        const isOpen =
          hit !== null &&
          dismissedAt !== hit.start &&
          filteredTabs.length > 0;

        // Reset/clamp highlight when candidates change
        useEffect(() => {
          setHighlightIdx((idx) => {
            if (filteredTabs.length === 0) return 0;
            return idx >= filteredTabs.length ? 0 : idx;
          });
        }, [filteredTabs.length, hit?.query]);

        // Keep highlighted row scrolled into view
        useEffect(() => {
          if (!isOpen) return;
          const el = rowRefs.current[highlightIdx];
          if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'nearest' });
          }
        }, [isOpen, highlightIdx]);

        const pickTab = useCallback(
          (tab) => {
            if (!hit || !shell || !actx) return;
            const liveRev = shell.snapshot?.draftRev ?? hit.draftRev;
            const span = { start: hit.start, end: hit.end, draftRev: liveRev };
            const titleText = tab.title || tab.host || 'Tab';
            const chipLabel = `${tab.tabRef} ${truncateText(titleText, 28)}`;

            let applied = false;
            if (hasReferenceCodec()) {
              applied = Boolean(
                actx.bail('slash/input-insert-reference', {
                  reference: {
                    source: SOURCE_NAME,
                    ref: encodeTabRefPayload(tab),
                    label: chipLabel,
                    appearance: 'session',
                    clipboardText: `${tab.tabRef} ${titleText}`,
                  },
                  span,
                }),
              );
            }
            if (!applied) {
              const serialized = `${formatSerializedTab(tab)} `;
              applied = Boolean(
                actx.bail('slash/input-insert-text', {
                  text: serialized,
                  span,
                }),
              );
            }
            setHit(null);
            setDismissedAt(null);
            shell.focus?.();
          },
          [hit, shell, actx, hasReferenceCodec],
        );

        // Capture-phase keyboard navigation while menu is open
        useEffect(() => {
          if (!isOpen) return;
          const editorEl = shell?.editor?.getRootElement?.() || null;

          const onKeyDown = (ev) => {
            if (ev.isComposing || ev.keyCode === 229) return;
            if (editorEl && !editorEl.contains(ev.target) && !menuRef.current?.contains(ev.target)) {
              return;
            }
            if (ev.key === 'ArrowDown') {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              setHighlightIdx((i) => (i + 1) % filteredTabs.length);
            } else if (ev.key === 'ArrowUp') {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              setHighlightIdx((i) => (i - 1 + filteredTabs.length) % filteredTabs.length);
            } else if (ev.key === 'Enter' || ev.key === 'Tab') {
              if (ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey) return;
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              const chosen = filteredTabs[highlightIdx] ?? filteredTabs[0];
              if (chosen) pickTab(chosen);
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              setDismissedAt(hit.start);
            }
          };

          const onPointerDown = (ev) => {
            const target = ev.target;
            if (menuRef.current?.contains(target)) return;
            if (editorEl && editorEl.contains(target)) return;
            setDismissedAt(hit.start);
          };

          window.addEventListener('keydown', onKeyDown, true);
          window.addEventListener('pointerdown', onPointerDown, true);
          return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('pointerdown', onPointerDown, true);
          };
        }, [isOpen, filteredTabs, highlightIdx, hit, pickTab, shell]);

        if (!isOpen) return null;

        return h(
          'div',
          {
            ref: menuRef,
            className: 'abb-picker-shell',
            'data-abb-tab-picker': 'open',
          },
          h(
            'div',
            { className: 'abb-picker-header' },
            h(
              'span',
              { className: 'abb-picker-heading' },
              h('span', { className: 'abb-dot', 'data-state': 'connected', 'aria-hidden': true }),
              h('span', null, `${t.pickerTitle} (${filteredTabs.length})`),
            ),
            h('span', { className: 'abb-picker-keys' }, t.pickerKeys),
          ),
          h(
            'div',
            {
              className: 'abb-picker-list',
              role: 'listbox',
              'aria-label': t.pickerAria,
            },
            filteredTabs.map((tab, idx) => {
              const active = idx === highlightIdx;
              return h(
                'button',
                {
                  key: `${tab.tabId}-${tab.tabRef}`,
                  ref: (el) => {
                    rowRefs.current[idx] = el;
                  },
                  type: 'button',
                  role: 'option',
                  'aria-selected': active,
                  className: 'abb-picker-row',
                  'data-active': active ? 'true' : 'false',
                  onMouseEnter: () => setHighlightIdx(idx),
                  onMouseDown: (ev) => {
                    // Prevent blurring the composer editor, matching DSH input-trigger convention
                    ev.preventDefault();
                    pickTab(tab);
                  },
                },
                h('span', { className: 'abb-picker-ref' }, tab.tabRef),
                h('span', { className: 'abb-picker-title' }, tab.title || tab.host || '(untitled)'),
                tab.active && h('span', { className: 'abb-badge', 'data-tone': 'success' }, t.activeTabBadge),
                h('span', { className: 'abb-picker-host', title: tab.url }, tab.host),
              );
            }),
          ),
        );
      };
    }

    function createDockComponent(ctx, statusStore, surface) {
      return function BrowserBridgeControl() {
        const t = useLocaleStrings(ctx);
        const bridge = useBridgeStatus(statusStore);
        const { status, loadState, authorizedTabs } = bridge;

        const [actionError, setActionError] = useState(null);
        const [detachingIds, setDetachingIds] = useState(() => new Set());
        const [closingSessionNames, setClosingSessionNames] = useState(() => new Set());
        const [open, setOpen] = useState(false);
        const [copyState, setCopyState] = useState('idle');
        const [popStyle, setPopStyle] = useState({ left: 12, top: 12 });

        const triggerRef = useRef(null);
        const popoverRef = useRef(null);
        const copyTimerRef = useRef(null);

        useEffect(() => {
          return () => {
            if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
          };
        }, []);

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
            if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
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
            await statusStore.refresh();
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

        const handleCloseSession = async (sessionName) => {
          setActionError(null);
          setClosingSessionNames((prev) => new Set(prev).add(sessionName));
          try {
            const res = await fetch('/api/agent-browser-bridge/control', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'close_session', sessionName }),
            });
            const data = await res.json().catch(() => ({ ok: false }));
            if (!res.ok || data?.ok === false) {
              setActionError(data?.error || `HTTP ${res.status}`);
            }
            await statusStore.refresh();
          } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err));
          } finally {
            setClosingSessionNames((prev) => {
              const next = new Set(prev);
              next.delete(sessionName);
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
              status?.agentBrowser &&
                h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'abb-section-label' },
                    h('span', null, t.engineLabel),
                    h(
                      'span',
                      null,
                      status.agentBrowser.available
                        ? `agent-browser ${status.agentBrowser.version || ''}`.trim()
                        : t.engineMissing,
                    ),
                  ),
                  !status.agentBrowser.available &&
                    h(
                      'div',
                      { className: 'abb-error', role: 'alert' },
                      t.engineMissingHint(
                        status.agentBrowser.installHint ||
                          status.agentBrowser.error ||
                          'agent-browser is required.',
                      ),
                    ),
                ),
              status?.managedSessions &&
                status.managedSessions.length > 0 &&
                h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'abb-section-label' },
                    h('span', null, t.sessionsHeading(status.managedSessions.length)),
                  ),
                  h(
                    'div',
                    { className: 'abb-tabs-list' },
                    status.managedSessions.map((session) =>
                      h(
                        'div',
                        { key: session.sessionName, className: 'abb-tab-row' },
                        h(
                          'span',
                          { className: 'abb-badge' },
                          session.target === 'headless'
                            ? t.sessionTargetHeadless
                            : session.target === 'headed'
                              ? t.sessionTargetHeaded
                              : t.sessionTargetBridge,
                        ),
                        h(
                          'div',
                          { className: 'abb-tab-meta' },
                          h('div', { className: 'abb-tab-title' }, session.sessionName),
                          session.cdpWsUrl && h('div', { className: 'abb-tab-host' }, 'bridge'),
                        ),
                        h(
                          'div',
                          { className: 'abb-tab-actions' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'abb-btn-mini',
                              disabled: closingSessionNames.has(session.sessionName),
                              onClick: () => void handleCloseSession(session.sessionName),
                            },
                            closingSessionNames.has(session.sessionName)
                              ? t.closingSession
                              : t.closeSession,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
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
                            h('span', { className: 'abb-picker-ref' }, tab.tabRef),
                            h(
                              'div',
                              { className: 'abb-tab-meta' },
                              h('div', { className: 'abb-tab-title' }, tab.title || '(untitled)'),
                              h('div', { className: 'abb-tab-host' }, tab.host),
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
                  h('div', { className: 'abb-steps', style: { marginTop: '6px' } }, t.pickerHint),
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
                void statusStore.refresh();
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
        const statusStore = createBridgeStatusStore();
        statusStore.start();

        ctx.effect(() => () => {
          statusStore.stop();
          styleEl.remove();
        });

        let codecRegistered = false;

        // Register ReferenceCodec for atomic `$` tab chips without polluting the `@` menu
        ctx.inject(['inputTriggers'], (trigCtx) => {
          const unregister = trigCtx.inputTriggers.registerSource({
            trigger: '@',
            name: SOURCE_NAME,
            order: 99,
            showGroupTitle: false,
            candidates: async () => [],
            onPick: () => undefined,
            codec: {
              clipboardText(rawRef) {
                const parsed = decodeTabRefPayload(rawRef);
                return `${parsed.tabRef} ${parsed.title || shortHost(parsed.url)}`.trim();
              },
              async serialize(rawRef) {
                const parsed = decodeTabRefPayload(rawRef);
                // Re-resolve live tabRef/title/url if the tab is currently open so $tN is always fresh
                const liveTabs = statusStore.getSnapshot().authorizedTabs;
                const live =
                  (parsed.tabId !== undefined
                    ? liveTabs.find((x) => x.tabId === parsed.tabId)
                    : undefined) ??
                  (parsed.url ? liveTabs.find((x) => x.url === parsed.url) : undefined);
                return formatSerializedTab(live ?? parsed);
              },
            },
          });
          codecRegistered = true;
          trigCtx.effect(() => () => {
            codecRegistered = false;
            unregister();
          });
        });

        // Register `$` Quick Tab Picker inside conversation.input.overlay
        ctx.inject(['sessions', 'conversation'], (convCtx) => {
          const DollarTabPickerOverlay = createDollarTabPicker(
            convCtx,
            statusStore,
            () => codecRegistered,
          );
          convCtx.slots.inject('conversation.input.overlay', () =>
            convCtx.slots.register(
              {
                name: 'conversation.input.overlay',
                id: 'agent-browser-bridge-dollar-tab-picker',
                order: 10,
                inject: (sessionId) => {
                  const actx = convCtx.sessions.scope(sessionId);
                  if (actx === undefined) return { actx: null, shell: null };
                  return {
                    actx,
                    shell: convCtx.conversation.input.for(actx),
                  };
                },
              },
              DollarTabPickerOverlay,
            ),
          );
        });

        const ComposerDockControl = createDockComponent(ctx, statusStore, 'dock');
        const HeroOptionControl = createDockComponent(ctx, statusStore, 'hero');

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
