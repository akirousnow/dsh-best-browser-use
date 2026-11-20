import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { build } from 'esbuild';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(pkgDir, 'dist');
const zipOutPath = join(distDir, 'agent-browser-bridge-extension.zip');

// --- Minimal PNG generator (clean rounded-square blue/cyan browser bridge emblem) ---
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function generateIconPng(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size * 0.44;
  const rBridge = size * 0.24;
  const strokeW = Math.max(1.5, size * 0.085);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // Soft rounded-circle gradient backdrop
      const edge = rOuter - dist;
      if (edge > -0.75) {
        const cov = Math.max(0, Math.min(1, edge + 0.75));
        const t = (x + y) / (2 * size);
        r = Math.round(62 + (82 - 62) * t);
        g = Math.round(145 + (105 - 145) * t);
        b = Math.round(245 + (225 - 245) * t);
        a = Math.round(cov * 255);

        // White bridge arc + two anchor nodes
        const ringDist = Math.abs(dist - rBridge);
        const isArc = dy <= size * 0.06 && ringDist < strokeW * 0.55;
        const leftNode = Math.hypot(dx + rBridge * 0.88, dy - size * 0.08) < strokeW * 0.8;
        const rightNode = Math.hypot(dx - rBridge * 0.88, dy - size * 0.08) < strokeW * 0.8;
        const centerBar = Math.abs(dy - size * 0.08) < strokeW * 0.4 && Math.abs(dx) < rBridge * 0.88;

        if (isArc || leftNode || rightNode || centerBar) {
          r = 255;
          g = 255;
          b = 255;
        }
      }

      const idx = y * stride + 1 + x * 4;
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Pure Node ZIP packer (DEFLATE) ---
async function collectFiles(dir, rootDir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full, rootDir)));
    } else if (entry.isFile() && !entry.name.endsWith('.zip')) {
      files.push({ full, rel: relative(rootDir, full).replaceAll('\\', '/') });
    }
  }
  return files;
}

async function createZipArchive(sourceDir, outFile) {
  const files = await collectFiles(sourceDir, sourceDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const uncompressed = await readFile(file.full);
    const compressed = deflateRawSync(uncompressed);
    const nameBuf = Buffer.from(file.rel, 'utf8');
    const crc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  await writeFile(outFile, Buffer.concat([...localParts, centralDir, eocd]));
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(join(distDir, 'icons'), { recursive: true });

  await build({
    entryPoints: {
      background: join(pkgDir, 'src/background.ts'),
      popup: join(pkgDir, 'src/popup/popup.ts'),
    },
    outdir: distDir,
    bundle: true,
    format: 'esm',
    target: 'chrome116',
    platform: 'browser',
    sourcemap: false,
    minify: false,
  });

  await copyFile(join(pkgDir, 'manifest.json'), join(distDir, 'manifest.json'));
  await copyFile(join(pkgDir, 'src/popup/popup.html'), join(distDir, 'popup.html'));
  await copyFile(join(pkgDir, 'src/popup/popup.css'), join(distDir, 'popup.css'));

  for (const size of [16, 48, 128]) {
    await writeFile(join(distDir, 'icons', `icon-${size}.png`), generateIconPng(size));
  }

  await createZipArchive(distDir, zipOutPath);
  const info = await stat(zipOutPath);
  console.log(`[extension] Built dist/ and packaged ${zipOutPath} (${info.size} bytes)`);
}

main().catch((err) => {
  console.error('[extension] Pack failed:', err);
  process.exit(1);
});
