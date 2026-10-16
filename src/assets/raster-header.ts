/** Bounded raster header inspection. No browser, decoding, IO or production data. */
export type RasterMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
export interface RasterHeader { width: number; height: number; mediaType: RasterMediaType }
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_PIXELS = 4096 * 4096;
export const MAX_PREVIEW_EDGE = 8192;

export function readRasterHeader(bytes: Uint8Array): RasterHeader | null {
  if (bytes.length < 12 || bytes.length > MAX_PREVIEW_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0; let height = 0; let mediaType: RasterMediaType;
  if ([137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)) {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
    width = view.getUint32(16); height = view.getUint32(20); mediaType = 'image/png';
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mediaType = 'image/jpeg';
    let cursor = 2;
    while (cursor + 3 < bytes.length) {
      if (bytes[cursor++] !== 0xff) return null;
      while (bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (cursor + 2 > bytes.length) return null;
      const length = view.getUint16(cursor);
      if (length < 2 || cursor + length > bytes.length) return null;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8) return null;
        height = view.getUint16(cursor + 3); width = view.getUint16(cursor + 5); break;
      }
      cursor += length;
    }
  } else if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    mediaType = 'image/webp';
    if (bytes.length < 30 || view.getUint32(4, true) + 8 !== bytes.length) return null;
    const chunk = view.getUint32(12);
    if (chunk === 0x56503858) { // VP8X
      width = 1 + (bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16);
      height = 1 + (bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16);
    } else if (chunk === 0x56503820) { // VP8
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    } else if (chunk === 0x5650384c && bytes[20] === 0x2f) { // VP8L
      const packed = view.getUint32(21, true);
      width = (packed & 0x3fff) + 1; height = ((packed >>> 14) & 0x3fff) + 1;
    } else return null;
  } else return null;
  if (!width || !height || width > MAX_PREVIEW_EDGE || height > MAX_PREVIEW_EDGE || width * height > MAX_PREVIEW_PIXELS) return null;
  return { width, height, mediaType };
}
