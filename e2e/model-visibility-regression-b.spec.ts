/**
 * model-visibility-regression-b.spec.ts (Worker B).
 *
 * Real-browser regression for issue 5 against the actual ModelViewer:
 * rear handles/labels/hit-tests must cull with the visible surface, and
 * opposite-shell artwork must never bleed on thin/folded garments.
 *
 * Self-contained harness (repo-local esbuild, inlined IIFE, file://,
 * offline): synthetic thin two-shell + folded GLBs, front/back logos added
 * in BOTH orders. Asserts zero console/page errors and zero HTTP(S)
 * requests. Desktop 1280x900 evidence only; Windows Chrome/Edge file://
 * remains the delivery gate (not run here).
 */
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { release } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { buildSync } from 'esbuild';

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

const VIEWPORT = { width: 1280, height: 900 };
const VIEWER_PATH = resolve(process.cwd(), 'src/viewer/model-viewer.ts');

type Vec3 = [number, number, number];

/** Deterministic non-indexed GLB from triangles with explicit normals. */
function glbFromTris(tris: Array<{ p: [Vec3, Vec3, Vec3]; n: Vec3 }>): Uint8Array {
  const pos: number[] = [];
  const nrm: number[] = [];
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) {
    for (const p of tri.p) {
      pos.push(p[0], p[1], p[2]);
      nrm.push(tri.n[0], tri.n[1], tri.n[2]);
      min = [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])];
      max = [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])];
    }
  }
  const posArray = new Float32Array(pos);
  const nrmArray = new Float32Array(nrm);
  const posBuf = Buffer.from(posArray.buffer, posArray.byteOffset, posArray.byteLength);
  const nrmBuf = Buffer.from(nrmArray.buffer, nrmArray.byteOffset, nrmArray.byteLength);
  const bin = Buffer.concat([posBuf, nrmBuf]);
  const json = {
    asset: { version: '2.0', generator: 'logotool-visibility-b-fixture' },
    scene: 0,
    scenes: [{ name: 'syn', nodes: [0] }],
    nodes: [{ name: 'syn', mesh: 0 }],
    meshes: [{
      name: 'syn',
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0, mode: 4 }],
    }],
    materials: [{ name: 'syn-mat', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.8, 1.0], metallicFactor: 0, roughnessFactor: 0.8 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: posBuf.length, byteLength: nrmBuf.length, target: 34962 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  const binStart = 20 + jsonBytes.length + jsonPad;
  out.writeUInt32LE(bin.length, binStart);
  out.writeUInt32LE(0x004e4942, binStart + 4);
  bin.copy(out, binStart + 8);
  return new Uint8Array(out);
}

function quadTris(corners: [Vec3, Vec3, Vec3, Vec3], n: Vec3): Array<{ p: [Vec3, Vec3, Vec3]; n: Vec3 }> {
  const [a, b, c, d] = corners;
  return [{ p: [a, b, c], n }, { p: [a, c, d], n }];
}

/** Thin garment: two parallel 1x1 shells 0.02 apart. */
function thinShellGlb(): Uint8Array {
  const h = 0.5;
  const z = 0.01;
  return glbFromTris([
    ...quadTris([[-h, -h, z], [h, -h, z], [h, h, z], [-h, h, z]], [0, 0, 1]),
    ...quadTris([[-h, -h, -z], [-h, h, -z], [h, h, -z], [h, -h, -z]], [0, 0, -1]),
  ]);
}

/** Folded garment: flat front panel, 60-degree wing, rear shell. */
function foldedShellGlb(): Uint8Array {
  const wingN: Vec3 = [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)];
  const hx = 0.25;
  const ox = hx + Math.cos(Math.PI / 3);
  const oz = Math.sin(Math.PI / 3);
  return glbFromTris([
    ...quadTris([[hx - 1, -0.5, 0], [hx, -0.5, 0], [hx, 0.5, 0], [hx - 1, 0.5, 0]], [0, 0, 1]),
    ...quadTris([[hx, -0.5, 0], [ox, -0.5, oz], [ox, 0.5, oz], [hx, 0.5, 0]], wingN),
    ...quadTris([[-0.5, -0.7, -0.02], [-0.5, 0.7, -0.02], [0.5, 0.7, -0.02], [0.5, -0.7, -0.02]], [0, 0, -1]),
  ]);
}

const FRONT_POINT: Vec3 = [0, 0, 0.011];
const FRONT_NORMAL: Vec3 = [0, 0, 1];
const THIN_BACK_POINT: Vec3 = [0, 0, -0.011];
const FOLDED_BACK_POINT: Vec3 = [0, 0, -0.031];
const BACK_NORMAL: Vec3 = [0, 0, -1];

/** Minimal harness source: real ModelViewer, JSON-able probes only. No backticks inside. */
function harnessSource(): string {
  return (
    'import { ModelViewer } from ' + JSON.stringify(VIEWER_PATH) + ';\n' +
    'const canvas = document.getElementById("gl") as HTMLCanvasElement | null;\n' +
    'const stage = document.getElementById("stage") as HTMLElement | null;\n' +
    'if (!canvas || !stage) throw new Error("visibility-b harness: missing #gl or #stage.");\n' +
    'const attached = ModelViewer.attach({ canvas, container: stage, background: 0xffffff });\n' +
    'const viewer = attached.viewer;\n' +
    'if (!viewer) throw new Error("visibility-b harness: no WebGL viewer.");\n' +
    'function base64ToBytes(base64: string): Uint8Array {\n' +
    '  const binary = atob(base64);\n' +
    '  const out = new Uint8Array(binary.length);\n' +
    '  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);\n' +
    '  return out;\n' +
    '}\n' +
    'function artImage(fill: string): Promise<ImageBitmap> {\n' +
    '  const c = document.createElement("canvas"); c.width = 64; c.height = 64;\n' +
    '  const ctx = c.getContext("2d")!; ctx.fillStyle = fill; ctx.fillRect(0, 0, 64, 64);\n' +
    '  return createImageBitmap(c);\n' +
    '}\n' +
    'async function artwork(addOrder: string, backZ: number): Promise<number> {\n' +
    '  const front = await artImage("#0a8a8a");\n' +
    '  const back = await artImage("#ffaa00");\n' +
    '  const s = 0.15;\n' +
    '  const bp = backZ;\n' +
    '  const a = { id: "front-logo", cornersModel: [{x:-s,y:-s,z:0.011},{x:s,y:-s,z:0.011},{x:s,y:s,z:0.011},{x:-s,y:s,z:0.011}], anchorModel: {x:0,y:0,z:0.011}, depthModel: 0.06, image: front, selected: true, fits: true };\n' +
    '  const b = { id: "back-logo", cornersModel: [{x:-s,y:-s,z:bp},{x:s,y:-s,z:bp},{x:s,y:s,z:bp},{x:-s,y:s,z:bp}], anchorModel: {x:0,y:0,z:bp}, depthModel: 0.06, image: back, selected: false, fits: true };\n' +
    '  viewer.setSurfaceArtworkOverlays(addOrder === "back-first" ? [b, a] : [a, b]);\n' +
    '  return viewer.getSurfaceArtworkCount();\n' +
    '}\n' +
    'function clientAt(fx: number, fy: number): { x: number; y: number } {\n' +
    '  const rect = canvas.getBoundingClientRect();\n' +
    '  return { x: rect.left + rect.width * fx, y: rect.top + rect.height * fy };\n' +
    '}\n' +
    '(window as unknown as { __visibilityB: unknown }).__visibilityB = {\n' +
    '  async load(base64: string): Promise<string> { return (await viewer.showModel(base64ToBytes(base64))).kind; },\n' +
    '  side(name: string): void { viewer.setViewSide(name as "front" | "back"); },\n' +
    '  probe(p: number[]): number[] | null { const r = viewer.projectToClient({ x: p[0]!, y: p[1]!, z: p[2]! }); return r ? [r.x, r.y] : null; },\n' +
    '  facing(p: number[], n: number[]): boolean | null { return viewer.isSurfaceFacing({ x: p[0]!, y: p[1]!, z: p[2]! }, { x: n[0]!, y: n[1]!, z: n[2]! }); },\n' +
    '  pick(fx: number, fy: number): boolean { const c = clientAt(fx, fy); return viewer.pickSurface(c.x, c.y) !== null; },\n' +
    '  plane(fx: number, fy: number, o: number[], n: number[]): boolean {\n' +
    '    const c = clientAt(fx, fy);\n' +
    '    return viewer.intersectRegionPlane(c.x, c.y, { origin: { x: o[0]!, y: o[1]!, z: o[2]! }, normal: { x: n[0]!, y: n[1]!, z: n[2]! } }) !== null;\n' +
    '  },\n' +
    '  cam(): unknown { return viewer.getCameraState(); },\n' +
    '  setCam(json: string): boolean { return viewer.setCameraState(JSON.parse(json)); },\n' +
    '  mode(m?: string): unknown { if (m === "select" || m === "pan") viewer.setInteractionMode(m); return viewer.getInteractionMode(); },\n' +
    '  pan(b?: boolean): unknown { if (typeof b === "boolean") viewer.setPanEnabled(b); return viewer.getPanEnabled(); },\n' +
    '  anchors(b?: boolean): unknown { if (typeof b === "boolean") viewer.setAnchorsVisible(b); return viewer.getAnchorsVisible(); },\n' +
    '  async shot(json: string): Promise<unknown> {\n' +
    '    const r = await viewer.captureCleanView(JSON.parse(json));\n' +
    '    if (!r) return null;\n' +
    '    return { revision: r.revision, width: r.width, height: r.height, bytes: r.dataURL.length, png: r.dataURL.startsWith("data:image/png") };\n' +
    '  },\n' +
    '  artwork,\n' +
    '  async artOne(which: string): Promise<number> {\n' +
    '    const front = await artImage("#0a8a8a");\n' +
    '    const back = await artImage("#ffaa00");\n' +
    '    const s = 0.15;\n' +
    '    const a = { id: "front-logo", cornersModel: [{x:-s,y:-s,z:0.011},{x:s,y:-s,z:0.011},{x:s,y:s,z:0.011},{x:-s,y:s,z:0.011}], anchorModel: {x:0,y:0,z:0.011}, depthModel: 0.06, image: front, selected: true, fits: true };\n' +
    '    const b = { id: "back-logo", cornersModel: [{x:-s,y:-s,z:-0.011},{x:s,y:-s,z:-0.011},{x:s,y:s,z:-0.011},{x:-s,y:s,z:-0.011}], anchorModel: {x:0,y:0,z:-0.011}, depthModel: 0.06, image: back, selected: false, fits: true };\n' +
    '    viewer.setSurfaceArtworkOverlays(which === "front" ? [a] : [b]);\n' +
    '    return viewer.getSurfaceArtworkCount();\n' +
    '  },\n' +
    '  centerPx(): number[] {\n' +
    '    const probe = document.createElement("canvas"); probe.width = canvas.width; probe.height = canvas.height;\n' +
    '    const ctx = probe.getContext("2d")!; ctx.drawImage(canvas, 0, 0);\n' +
    '    return Array.from(ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data);\n' +
    '  },\n' +
    '};\n'
  );
}

async function openHarness(browser: Browser, fileName: string): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  const bundled = buildSync({
    stdin: { contents: harnessSource(), resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const js = String(bundled.outputFiles[0]!.text).replace(/<\/script/gi, '<\\/script');
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>model visibility regression B</title><style>' +
    '#stage{width:720px;height:540px}' +
    '#stage canvas{width:100%;height:100%;display:block}' +
    '</style></head><body><div id="stage"><canvas id="gl"></canvas></div>' +
    '<script>' + js + '</script></body></html>';
  const context = await browser.newContext({ offline: true, viewport: VIEWPORT });
  await context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  const outputPath = test.info().outputPath(fileName);
  await writeFile(outputPath, html);
  await page.goto(pathToFileURL(outputPath).href);
  const mounted = await page.evaluate((): boolean => {
    const api = (window as unknown as { __visibilityB: unknown }).__visibilityB;
    return typeof api === 'object' && api !== null;
  });
  expect(mounted).toBe(true);
  return { context, page, probe };
}

async function call<R>(page: Page, method: string, ...args: unknown[]): Promise<R> {
  return page.evaluate(([name, rest]): R => {
    const api = (window as unknown as { __visibilityB: Record<string, (...a: unknown[]) => R> }).__visibilityB;
    const fn = api[name];
    if (typeof fn !== 'function') throw new Error(`visibility-b harness has no method ${name}.`);
    return fn(...rest);
  }, [method, args] as [string, unknown[]]);
}

function assertClean(probe: Probe): void {
  expect(probe.pageErrors, `page errors: ${probe.pageErrors.join('; ')}`).toEqual([]);
  expect(probe.consoleErrors, `console errors: ${probe.consoleErrors.join('; ')}`).toEqual([]);
  expect(probe.networkRequests, `network requests: ${probe.networkRequests.join('; ')}`).toEqual([]);
}

test('thin shell: rear projections, facing and hit-tests cull with the visible side', async ({ browser }, info) => {
  const { context, page, probe } = await openHarness(browser, 'visibility-b-thin.html');
  try {
    await info.attach('offline-environment', {
      contentType: 'application/json',
      body: JSON.stringify({ os: process.platform, release: release(), browserVersion: browser.version(), viewport: VIEWPORT, offline: true, entryPoint: 'file://', scope: 'model-visibility-b-thin' }),
    });
    expect(await call<string>(page, 'load', Buffer.from(thinShellGlb()).toString('base64'))).toBe('ready');
    await call(page, 'side', 'front');
    expect(await call(page, 'probe', [...FRONT_POINT])).not.toBeNull();
    expect(await call(page, 'probe', [...THIN_BACK_POINT])).toBeNull();
    expect(await call(page, 'facing', [...FRONT_POINT], [...FRONT_NORMAL])).toBe(true);
    expect(await call(page, 'facing', [...THIN_BACK_POINT], [...BACK_NORMAL])).toBe(false);
    expect(await call(page, 'pick', 0.5, 0.5)).toBe(true);
    expect(await call<boolean>(page, 'plane', 0.5, 0.5, [...FRONT_POINT], [...FRONT_NORMAL])).toBe(true);
    await call(page, 'side', 'back');
    expect(await call(page, 'probe', [...FRONT_POINT])).toBeNull();
    expect(await call(page, 'probe', [...THIN_BACK_POINT])).not.toBeNull();
    expect(await call(page, 'facing', [...FRONT_POINT], [...FRONT_NORMAL])).toBe(false);
    expect(await call(page, 'facing', [...THIN_BACK_POINT], [...BACK_NORMAL])).toBe(true);
    expect(await call<boolean>(page, 'plane', 0.5, 0.5, [...FRONT_POINT], [...FRONT_NORMAL])).toBe(false);
    assertClean(probe);
  } finally {
    await context.close();
  }
});

test('folded shell: rear projections and facing cull with the visible side', async ({ browser }, info) => {
  const { context, page, probe } = await openHarness(browser, 'visibility-b-folded.html');
  try {
    await info.attach('offline-environment', {
      contentType: 'application/json',
      body: JSON.stringify({ os: process.platform, release: release(), browserVersion: browser.version(), viewport: VIEWPORT, offline: true, entryPoint: 'file://', scope: 'model-visibility-b-folded' }),
    });
    expect(await call<string>(page, 'load', Buffer.from(foldedShellGlb()).toString('base64'))).toBe('ready');
    await call(page, 'side', 'front');
    expect(await call(page, 'probe', [...FRONT_POINT])).not.toBeNull();
    expect(await call(page, 'probe', [...FOLDED_BACK_POINT])).toBeNull();
    expect(await call(page, 'facing', [...FRONT_POINT], [...FRONT_NORMAL])).toBe(true);
    await call(page, 'side', 'back');
    expect(await call(page, 'probe', [...FRONT_POINT])).toBeNull();
    expect(await call(page, 'facing', [...FRONT_POINT], [...FRONT_NORMAL])).toBe(false);
    expect(await call(page, 'facing', [...FOLDED_BACK_POINT], [...BACK_NORMAL])).toBe(true);
    assertClean(probe);
  } finally {
    await context.close();
  }
});

test('pan reservation, camera state and clean capture API contract', async ({ browser }) => {
  const { context, page, probe } = await openHarness(browser, 'visibility-b-camera.html');
  try {
    expect(await call<string>(page, 'load', Buffer.from(thinShellGlb()).toString('base64'))).toBe('ready');
    await call(page, 'side', 'front');
    expect(await call(page, 'pick', 0.5, 0.5)).toBe(true);
    expect(await call(page, 'mode', 'pan')).toBe('pan');
    expect(await call(page, 'pick', 0.5, 0.5)).toBe(false);
    expect(await call(page, 'plane', 0.5, 0.5, [...FRONT_POINT], [...FRONT_NORMAL])).toBe(false);
    expect(await call(page, 'mode', 'select')).toBe('select');
    expect(await call(page, 'pick', 0.5, 0.5)).toBe(true);
    expect(await call<boolean>(page, 'plane', 0.5, 0.5, [...FRONT_POINT], [...FRONT_NORMAL])).toBe(true);
    expect(await call(page, 'pan', false)).toBe(false);
    expect(await call(page, 'pan', true)).toBe(true);
    const state = await call<{ position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; zoomPct: number; mode: string }>(page, 'cam');
    expect(Number.isFinite(state.position.x)).toBe(true);
    expect(state.mode).toBe('select');
    expect(await call(page, 'setCam', JSON.stringify(state))).toBe(true);
    expect(await call(page, 'setCam', JSON.stringify({ position: { x: NaN, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, mode: 'select' }))).toBe(false);
    expect(await call(page, 'anchors', true)).toBe(true);
    const shot = await call<{ revision: string; width: number; height: number; bytes: number; png: boolean }>(
      page, 'shot', JSON.stringify({ revision: 'rev-7', width: 320, height: 240 }));
    expect(shot.revision).toBe('rev-7');
    expect(shot.width).toBe(320);
    expect(shot.height).toBe(240);
    expect(shot.png).toBe(true);
    expect(shot.bytes).toBeGreaterThan(1000);
    expect(await call(page, 'anchors')).toBe(true);
    expect(await call(page, 'shot', JSON.stringify({ revision: '', width: 320, height: 240 }))).toBeNull();
    assertClean(probe);
  } finally {
    await context.close();
  }
});

test('front/back artwork occludes correctly in both add orders', async ({ browser }) => {
  for (const order of ['front-first', 'back-first'] as const) {
    const { context, page, probe } = await openHarness(browser, `visibility-b-art-${order}.html`);
    try {
      expect(await call<string>(page, 'load', Buffer.from(thinShellGlb()).toString('base64'))).toBe('ready');
      expect(await call(page, 'artwork', order, -0.011)).toBe(2);
      await call(page, 'side', 'front');
      await expect.poll(async () => { const px = await call<number[]>(page, 'centerPx'); return px[1]! > 100 && px[0]! < 80; }, { message: 'front view renders teal artwork' }).toBe(true);
      await call(page, 'side', 'back');
      await expect.poll(async () => { const px = await call<number[]>(page, 'centerPx'); return px[0]! > 200 && px[2]! < 80; }, { message: 'back view renders amber artwork' }).toBe(true);
      assertClean(probe);
    } finally {
      await context.close();
    }
  }
});
