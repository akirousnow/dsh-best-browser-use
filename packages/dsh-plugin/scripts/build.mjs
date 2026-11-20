import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pkgDir));
const distDir = join(pkgDir, 'dist');
const assetsDir = join(pkgDir, 'assets');

async function main() {
  await mkdir(distDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });

  // Bundle workspace packages (protocol + relay + engine) into a single self-contained ESM file
  // so @local/agent-browser-bridge works cleanly when installed into any DSH profile without workspace:* links.
  await build({
    entryPoints: [join(pkgDir, 'src/bridge-entry.ts')],
    outfile: join(distDir, 'bridge.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['ws'],
    sourcemap: false,
  });

  // Copy packed Chrome MV3 extension zip if built so DSH UI can offer 1-click download.
  const extZip = join(repoRoot, 'packages/extension/dist/agent-browser-bridge-extension.zip');
  try {
    await stat(extZip);
    await copyFile(extZip, join(assetsDir, 'agent-browser-bridge-extension.zip'));
    console.log('[dsh-plugin] Bundled bridge.mjs and copied extension zip into assets/');
  } catch {
    console.warn('[dsh-plugin] Extension zip not found yet; run pack:ext first to bundle assets/*.zip');
  }
}

main().catch((err) => {
  console.error('[dsh-plugin] Build failed:', err);
  process.exit(1);
});
