# Agent Browser Bridge (`dsh-best-browser-use`)

让 AI Agent（原生 DeepSeek Harness 插件、MCP Server 或 CLI）零特殊配置操控用户日常 Chrome / Edge / Brave 浏览器、复用现有登录态与 Cookie 的 4 层解耦桥接系统。

## 架构概览

```text
Chrome / Edge / Brave (MV3 Extension)
        │  主动外连 ws(s)://<host>:<port>/ext (Origin 防劫持 + Token 鉴权 + 20s 心跳)
        ▼
Relay Daemon (packages/relay, 默认 127.0.0.1:9229)
        │  仅本机回环 /cdp/<secret> (标准 CDP WebSocket, maxPayload 64 MiB)
        ▼
Agent Engine (packages/engine, playwright-core connectOverCDP)
  ├─ 稳定 $tN Tab 管理与断线 URL+Title 自动恢复
  ├─ 无障碍树精简快照 + 动作后增量 Diff（>50% 或 URL 变化自动全量回退）
  ├─ 压缩 JPEG 截图（宽 ≤ 1280px）+ 15 个高内聚工具
  └─ 只读安全模式 · 禁 eval · 远程上传边界 · 防网页 Prompt Injection
        ├──▶ packages/dsh-plugin  (原生 DSH Host+Client Bundle：15 个工具 + 对话栏状态胶囊)
        ├──▶ packages/mcp         (标准 MCP Server：stdio & Streamable HTTP)
        └──▶ packages/cli         (命令行工具 `bb`)
```

## 快速开始

### 1. 安装依赖与构建

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

构建完成后：
- Chrome 扩展解压目录位于 `packages/extension/dist/`
- 可直接分发的扩展安装包位于 `packages/extension/dist/agent-browser-bridge-extension.zip`（同时内置于 `packages/dsh-plugin/assets/`，可在 DSH Web 界面状态胶囊中一键下载）

### 2. 三步加载 Chrome / Edge / Brave 扩展

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角 **开发者模式**。
2. 点击 **加载已解压的扩展程序**，选择 `packages/extension/dist`（或解压 `.zip` 后的目录）。
3. 点击浏览器工具栏中的 **Agent Browser Bridge** 图标：本机默认 `127.0.0.1:9229` 开箱即用，状态灯变绿即代表连接成功。

### 3. 接入方式

#### 方式 A：原生 DeepSeek Harness 插件（推荐）
将 `packages/dsh-plugin` 安装到当前 DSH Profile（**Plugins → Add plugin** 或通过 `plugin_manager`）：
- 自动托管 Relay（若 `9229` 已有外部 Relay 运行则直接复用）
- 原生注册 15 个 `browser_*` 工具并注入防网页 Prompt Injection 系统提示词
- 在对话输入栏 Dock 中显示浏览器连接状态胶囊（查看/释放 Tab、复制连接地址、下载扩展 `.zip`）
- 可在插件配置中开启 `readOnly: true` 切换只读安全模式

#### 方式 B：独立 MCP Server（stdio / Streamable HTTP）
```bash
# stdio 模式（供 Claude Code / Cursor / DSH MCP 客户端调用）
node packages/mcp/dist/bin.js

# 只读安全模式
node packages/mcp/dist/bin.js --read-only

# Streamable HTTP 模式（默认仅绑定 127.0.0.1:9230/mcp）
node packages/mcp/dist/bin.js --http --http-port 9230
```

#### 方式 C：CLI（`bb`）
```bash
node packages/cli/dist/bin.js daemon start
node packages/cli/dist/bin.js daemon status
node packages/cli/dist/bin.js tabs
node packages/cli/dist/bin.js snapshot
node packages/cli/dist/bin.js pair --host your.server.com --port 443 --wss
```

## 远程服务器部署（WSS 加密反代）

在远程 Linux 服务器上启动 Relay（绑定非回环地址时若未指定 `--token`，将自动生成 32 字节强随机 Token）：

```bash
node packages/cli/dist/bin.js daemon start --host 0.0.0.0 --port 9229 --token "<your-secret-token>"
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

## 常见故障排查

- **打开 F12 DevTools 后某个 Tab 断开**：Chrome 规定 `chrome.debugger` 与 DevTools 互斥。扩展会优雅地仅将该 Tab 标记为 `F12 占用` 而不断开整体连接；关闭 F12 后在弹窗点击「重新接管」即可恢复。
- **`chrome://` / 网上应用店未出现在 Tab 列表**：系统特权页不支持调试附着，扩展会自动按白名单（仅 `http://`、`https://`、`file://`、`about:blank`）过滤跳过，避免报错传染。
- **远程模式上传本地文件被拒绝**：远程浏览器无法读取服务器本机路径；默认拒绝，如需通过 WebSocket 传输小文件（默认上限 10 MiB），请显式开启 `allowRemoteUploadTransfer: true`。
