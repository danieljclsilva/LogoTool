import test from 'node:test';
import assert from 'node:assert/strict';
import { readRasterHeader, MAX_PREVIEW_BYTES } from '../src/assets/raster-header.js';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33); const view = new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10]); view.setUint32(8,13); view.setUint32(12,0x49484452);
  view.setUint32(16,width); view.setUint32(20,height); return bytes;
}
test('raster header bounds reject zero, oversized and disguised content before decoding', () => {
  assert.deepEqual(readRasterHeader(png(768,231)), { width:768, height:231, mediaType:'image/png' });
  for (const bytes of [png(0,10),png(65535,10),png(8192,8192),new TextEncoder().encode('<svg onload="fetch(1)"></svg>'),new Uint8Array(MAX_PREVIEW_BYTES + 1)]) assert.equal(readRasterHeader(bytes),null);
  const truncated = png(10,10).subarray(0,24); assert.equal(readRasterHeader(truncated),null);
});
test('JPEG segment scanning rejects malformed lengths and reads SOF dimensions', () => {
  const bytes = new Uint8Array([255,216,255,224,0,4,0,0,255,192,0,8,8,0,10,0,20,0]);
  assert.deepEqual(readRasterHeader(bytes), { width:20, height:10, mediaType:'image/jpeg' });
  bytes[5] = 255; assert.equal(readRasterHeader(bytes),null);
});
test('WebP dimensions support VP8X, reject inconsistent RIFF lengths and oversized canvases', () => {
  const bytes = new Uint8Array(30); const view = new DataView(bytes.buffer);
  view.setUint32(0,0x52494646); view.setUint32(4,22,true); view.setUint32(8,0x57454250); view.setUint32(12,0x56503858);
  bytes[24]=19;bytes[27]=9;
  assert.deepEqual(readRasterHeader(bytes),{ width:20,height:10,mediaType:'image/webp' });
  view.setUint32(4,100,true); assert.equal(readRasterHeader(bytes),null);
});
