#!/usr/bin/env node
import { DEFAULT_RELAY_PORT } from '@agent-browser-bridge/protocol';
import { BrowserEngine } from '@agent-browser-bridge/engine';
import { startStdioMcpServer, startStreamableHttpMcpServer } from './index.js';

function parseArgs(argv: string[]) {
  const opts = {
    transport: 'stdio' as 'stdio' | 'http',
    httpHost: '127.0.0.1',
    httpPort: 9230,
    relayPort: process.env.ABB_RELAY_PORT ? Number(process.env.ABB_RELAY_PORT) : DEFAULT_RELAY_PORT,
    readOnly: process.env.ABB_READ_ONLY === '1' || process.env.ABB_READ_ONLY === 'true',
    allowRemoteUploadTransfer: process.env.ABB_ALLOW_REMOTE_UPLOAD === '1',
    autoStartRelay: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--http') opts.transport = 'http';
    else if (arg === '--stdio') opts.transport = 'stdio';
    else if (arg === '--http-host' && argv[i + 1]) opts.httpHost = argv[++i]!;
    else if (arg === '--http-port' && argv[i + 1]) opts.httpPort = Number(argv[++i]);
    else if (arg === '--relay-port' && argv[i + 1]) opts.relayPort = Number(argv[++i]);
    else if (arg === '--read-only') opts.readOnly = true;
    else if (arg === '--no-auto-relay') opts.autoStartRelay = false;
    else if (arg === '--allow-remote-upload') opts.allowRemoteUploadTransfer = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const engine = new BrowserEngine({
    relayPort: opts.relayPort,
    autoStartRelay: opts.autoStartRelay,
    security: {
      readOnly: opts.readOnly,
      allowRemoteUploadTransfer: opts.allowRemoteUploadTransfer,
    },
  });

  if (opts.transport === 'http') {
    const handle = await startStreamableHttpMcpServer(engine, {
      host: opts.httpHost,
      port: opts.httpPort,
      readOnly: opts.readOnly,
    });
    console.error(`[browser-bridge-mcp] Streamable HTTP MCP listening on ${handle.url}`);
    const shutdown = async () => {
      await handle.close();
      await engine.disconnect();
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  } else {
    await startStdioMcpServer(engine, { readOnly: opts.readOnly });
    const shutdown = async () => {
      await engine.disconnect();
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  }
}

main().catch((err) => {
  console.error('[browser-bridge-mcp] Fatal error:', err);
  process.exit(1);
});
