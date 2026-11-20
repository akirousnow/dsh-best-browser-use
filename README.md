# Agent Browser Bridge (`dsh-best-browser-use`)

让 AI Agent 通过 [`agent-browser`](https://agent-browser.dev) 驱动两类浏览器：**你日常已登录的真实浏览器**（无需任何启动参数），以及**按对话隔离的测试浏览器**（无头/有头，专用于项目自动化）。

## 架构概览

```text
Chrome / Edge / Brave (MV3 Extension, packages/extension)
        │  主动外连 ws(s)://<host>:<port>/ext（Origin 白名单 + Token + 20s 心跳）
        │  chrome.debugger.getTargets() 预取真实 targetId · 按需懒附着 · 多会话对称分发
        ▼
CDP Relay Daemon (packages/relay, 默认 127.0.0.1:9229)
        │  仅本机回环 /cdp/<secret>（标准 CDP WebSocket）、/json/version、/status、/control
        ▼
agent-browser（原生 Rust CLI + 常驻 daemon，由用户安装）
        │  --cdp <relay>/cdp/<secret>  → 真实浏览器
        │  独立 launch                 → 隔离的无头/有头测试浏览器
        ▼
agent-browser Runtime Adapter (packages/engine — 无 playwright-core)
  ├─ 二进制解析与健康探测（config → AGENT_BROWSER_BIN → PATH）
  ├─ 命令级安全策略（只读白名单、eval/凭证分目标授权、URL 协议、batch 递归校验、远程上传拦截）
  └─ 会话与连接治理（按对话隔离 session/namespace/socket、Relay 重启自愈、超时与取消、退出清理）
        ├──▶ packages/dsh-plugin  (原生 DSH Host+Client Bundle：browser + browser_screenshot + browser-bridge 技能)
        └──▶ packages/cli         (命令行工具 `bb`：Relay 守护、配对、cdp-url、ab、mcp)
```

## 前置依赖

```bash
npm i -g agent-browser
agent-browser install          # 下载 Chrome for Testing（Linux 可加 --with-deps）
agent-browser --version        # 确认可用
```

插件不把 `agent-browser` 作为 npm 依赖（避免 postinstall 审批），而是从 `binaryPath` 配置、`AGENT_BROWSER_BIN` 环境变量或 `PATH` 中解析。

## 快速开始

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

构建完成后：
- Chrome 扩展解压目录位于 `packages/extension/dist/`
- 可分发安装包位于 `packages/extension/dist/agent-browser-bridge-extension.zip`（同时内置于 `packages/dsh-plugin/assets/`，可在 DSH Web 状态胶囊中一键下载）

### 加载浏览器扩展

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择 `packages/extension/dist`。
3. 点击工具栏中的 **Agent Browser Bridge** 图标：默认 `127.0.0.1:9229` 开箱即用，状态灯变绿即代表连接成功。

### 安装 DSH 插件

将 `packages/dsh-plugin` 安装到当前 DSH Profile（**Plugins → Add plugin** 或 `plugin_manager`）。插件会：
- 自动托管 Relay（若端口已有外部 Relay 则直接复用）
- 注册 **2 个工具**：`browser`（单条命令透传）与 `browser_screenshot`（多模态截图）
- 在 `skills` 服务可用时注册 `browser-bridge` 技能（完整操作手册，按需加载）
- 在对话输入栏 Dock 与新会话首页显示浏览器状态胶囊（agent-browser 版本、扩展连接、已同步标签、`.zip` 下载、关闭残留测试浏览器）

## 两个工具

```jsonc
// browser：一次一条 agent-browser 命令
browser({ args: ["snapshot", "-i"] })
browser({ args: ["click", "@e3"] })
browser({ args: ["fill", "@e2", "hello"] })
browser({ args: ["tab", "list"] })
browser({ target: "headless", args: ["open", "http://localhost:3000"] })
browser({ target: "headless", args: ["a11y", "--json"] })
browser({ args: ["batch"], stdin: '[["open","http://localhost:3000"],["snapshot","-i"]]' })
browser({ tab: "C3EC28BD334A13835EFF196007103FC3", args: ["get", "text", "@e1"] })

// browser_screenshot：页面或单个元素
browser_screenshot({ fullPage: true })
browser_screenshot({ target: "headless", selector: "#main", annotate: true, ifChanged: true })
```

### 两种目标

| target | 浏览器 | 适用场景 |
|---|---|---|
| `bridge`（默认） | 用户真实浏览器（经扩展 + Relay） | 需要现有登录态、Cookie、已打开标签页的任务 |
| `headless` | 隔离的无头 Chromium | 项目自动化测试、断言、审计、抓取 |
| `headed` | 隔离的可视 Chromium | 观察测试过程、调试失败流程 |

隔离浏览器按对话命名会话（`dsh-headless-<session>`），默认 15 分钟空闲自动退出，插件卸载时统一关闭，绝不触碰用户浏览器。

## CLI（`bb`）

```bash
bb daemon start                 # 启动 Relay（DSH 插件会自动做这件事）
bb daemon status                # 查看扩展连接与 CDP 端点
bb pair --host <ip> --wss       # 打印远程配对参数
bb cdp-url                      # 输出本机 CDP WebSocket URL
bb ab -- snapshot -i            # 用 agent-browser 直连桥接浏览器
bb ab -- tab list
bb mcp --tools core,tabs        # 以 MCP Server 形式暴露（注入 AGENT_BROWSER_CDP）
bb mcp --headless --tools all   # 以独立无头浏览器启动 MCP Server
```

`bb` 不再重复实现浏览器动作命令——所有浏览器操作统一由 `agent-browser` 提供。

## 远程服务器部署（WSS 反代）

在远程 Linux 服务器上启动 Relay（绑定非回环地址时若未指定 `--token`，将自动生成 32 字节强随机 Token）：

```bash
bb daemon start --host 0.0.0.0 --port 9229 --token "<your-secret-token>"
```

Nginx 反代示例（本地浏览器扩展勾选 **WSS 加密**，填域名 + `443` + 路径 `/ext` + Token）：

```nginx
location /ext {
    proxy_pass http://127.0.0.1:9229/ext;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

> 安全说明：`/cdp` 与 `/status` 永远强制仅允许本机回环地址（`127.0.0.1` / `::1`）访问，切勿反代 `/cdp` 或 `/status` 到公网。

## 安全模型

| 边界 | 默认行为 |
|---|---|
| 网页内容 | 快照/文本/控制台/网络输出标记为不可信数据，防止提示词注入 |
| 本地 CDP | 仅回环可访问，使用一次性 secret 路径 |
| `readOnly` | 仅允许 `tab list`、`snapshot`、`read`、`get`、`wait`、`console`、`errors`、`network requests`、`diff`、`a11y`、`vitals`、`screenshot` |
| JavaScript（`eval`、`wait --fn`、`webmcp invoke`、`flow run`） | 真实浏览器默认禁止（`allowEvalInBridge: false`）；隔离浏览器默认允许 |
| 凭证命令（`cookies`/`storage`/`state`/`auth`） | 真实浏览器默认禁止；隔离浏览器允许 |
| 导航协议 | 仅 `http(s)`、`about:blank`（`file:` 需显式开启；隔离浏览器额外允许 `data:text/html`） |
| 宿主专属参数 | 模型不可设置 `--cdp`、`--profile`、`--engine`、`--config`、`--session`、`--allowed-domains` 等，由插件统一注入 |
| 远程上传 | 扩展在远端时拒绝本机文件上传 |

## 常见故障排查

- **升级插件后扩展行为没变**：`packages/extension/dist` 已重新打包（0.2.0，含真实 targetId 预取与多会话释放）。在 `chrome://extensions` 中找到 **Agent Browser Bridge** 点一次刷新 ↻ 即可加载新代码；宿主插件侧无需重启 DSH（重建 `dist/bridge.mjs` 后在 Plugins 里关闭再启用该插件就会加载新 bundle）。
- **打开 F12 DevTools 后某个 Tab 断开**：Chrome 规定 `chrome.debugger` 与 DevTools 互斥。扩展仅将该 Tab 标记为 `F12 占用`，关闭 F12 后在弹窗点击「重新接管」即可恢复。
- **`chrome://` / 网上应用店未出现在 Tab 列表**：系统特权页不支持调试附着，扩展按白名单（`http://`、`https://`、`file://`、`about:blank`）过滤跳过。
- **提示未安装 agent-browser**：执行 `npm i -g agent-browser && agent-browser install`，或在插件配置中填写 `binaryPath`。
- **隔离浏览器缺少 Chrome**：执行 `agent-browser install`（Linux 可加 `--with-deps`）。
- **`$HOME` 只读环境（容器/沙箱）**：插件会把 agent-browser 的 socket 目录切到可写的临时目录，并使用独立 `AGENT_BROWSER_NAMESPACE`，不会与你终端里的 agent-browser 会话互相干扰。
