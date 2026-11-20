import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ScreenshotOptions {
  fullPage?: boolean;
  quality?: number;
  maxWidth?: number;
  outputDir?: string;
}

export interface ScreenshotResult {
  filePath: string;
  mediaType: 'image/jpeg';
  base64: string;
  bytes: number;
  width: number;
  height: number;
}

export function defaultScreenshotDir(): string {
  return join(tmpdir(), 'agent-browser-bridge-screenshots');
}

/**
 * Parse JPEG SOF0/SOF2 markers to determine actual image pixel dimensions without external libs.
 */
export function parseJpegDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { width: 0, height: 0 };
  }
  let offset = 2;
  while (offset + 4 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === undefined) break;
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buf.readUInt16BE(offset + 2);
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3
    ) {
      if (offset + 9 <= buf.length) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { width, height };
      }
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

/** Save a captured JPEG buffer into the temp directory and return structured metadata. */
export async function saveScreenshotBuffer(
  buffer: Buffer,
  options: { outputDir?: string; fallbackWidth?: number; fallbackHeight?: number } = {},
): Promise<ScreenshotResult> {
  const dir = options.outputDir ?? defaultScreenshotDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `shot-${Date.now()}-${randomUUID().slice(0, 8)}.jpg`);
  await writeFile(filePath, buffer);

  const dims = parseJpegDimensions(buffer);
  return {
    filePath,
    mediaType: 'image/jpeg',
    base64: buffer.toString('base64'),
    bytes: buffer.length,
    width: dims.width || options.fallbackWidth || 1280,
    height: dims.height || options.fallbackHeight || 720,
  };
}
