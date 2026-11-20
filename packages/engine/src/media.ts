import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ScreenshotMediaType = 'image/jpeg' | 'image/png';

export interface ScreenshotAsset {
  filePath: string;
  mediaType: ScreenshotMediaType;
  base64: string;
  bytes: number;
  width: number;
  height: number;
}

/** Directory where agent-browser drops screenshots when the caller does not name one. */
export function defaultScreenshotDir(): string {
  return join(tmpdir(), 'agent-browser-bridge-screenshots');
}

/**
 * Parse JPEG SOF0/SOF1/SOF2/SOF3 markers to determine pixel dimensions without external libs.
 * @param buf - raw JPEG bytes.
 * @returns the declared width and height, or zeros when the markers are absent.
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
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read width and height from a PNG IHDR chunk without external libs.
 * @param buf - raw PNG bytes.
 * @returns the declared width and height, or zeros when the signature or IHDR is missing.
 */
export function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: 0, height: 0 };
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') {
    return { width: 0, height: 0 };
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Detect the media type from the file signature, falling back to the file extension. */
export function detectImageMediaType(buf: Buffer, filePath: string): ScreenshotMediaType {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  return filePath.toLowerCase().endsWith('.jpg') || filePath.toLowerCase().endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png';
}

/**
 * Load a screenshot produced by agent-browser and describe it for the model and UI.
 * @param filePath - absolute path reported by `agent-browser screenshot --json`.
 * @returns the image bytes, media type, and pixel dimensions.
 */
export async function readScreenshotAsset(filePath: string): Promise<ScreenshotAsset> {
  const buf = await readFile(filePath);
  const mediaType = detectImageMediaType(buf, filePath);
  const dims = mediaType === 'image/jpeg' ? parseJpegDimensions(buf) : parsePngDimensions(buf);
  return {
    filePath,
    mediaType,
    base64: buf.toString('base64'),
    bytes: buf.length,
    width: dims.width,
    height: dims.height,
  };
}
