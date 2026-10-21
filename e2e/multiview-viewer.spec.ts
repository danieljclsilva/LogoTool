import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectDocument } from '../src/core/types.js';
import { openOfflineContext, assertCleanProbe } from './helpers.js';
import type { Page } from '@playwright/test';

// Single-canvas product-view acceptance. The customer editor has ONE primary
// canvas with Photo / Diagram / 3D modes (no second independent viewer): the
// measured placement diagram stays the authority; mapped photos render actual
// PNG artwork overlays; 3D mode hosts the real interactive GLB (honest
// availability text, no logo projection, no wheel scroll trap). Legacy
// unmapped packages fall back to the truthful diagram + reference-only status.

const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const editor = pathToFileURL(resolve('dist/customer-configurator.html')).href;
const hook = (page: Page, name: string) => page.locator(`[data-customer-hook="${name}"]`);

type Side = 'front' | 'back' | 'left' | 'right';
const SIDES: Side[] = ['front', 'back', 'left', 'right'];

async function syntheticPng(page: Page, color: string): Promise<Uint8Array> {
  const base64 = await page.evaluate((fill) => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 10;
    const context = canvas.getContext('2d')!;
    context.fillStyle = fill;
    context.fillRect(0, 0, 20, 10);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, color);
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function fixture(): Promise<{ project: ProjectDocument; assets: Array<{ path: string; kind: string; bytes: Uint8Array }> }> {
  const parsed = await parseProjectPackage(new Uint8Array(await readFile(resolve('dist/trusted-issued.logo-project'))), { sha256 });
  return { project: parsed.project, assets: parsed.assets as Array<{ path: string; kind: string; bytes: Uint8Array }> };
}

function firstIds(project: ProjectDocument): { productId: string; variantId: string } {
  return { productId: project.configurations[0]!.productId, variantId: project.configurations[0]!.variantId };
}

async function packageWith(
  project: ProjectDocument,
  assets: Array<{ path: string; kind: string; bytes: Uint8Array }>,
  additional: Array<{ path: string; bytes: Uint8Array }>,
): Promise<Uint8Array> {
  return createProjectPackage({
    project,
    assets: assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
    additionalAssets: additional,
  }, { sha256 });
}

function v2Manifest(project: ProjectDocument, sides: Side[], model: string | null): Uint8Array {
  const { productId, variantId } = firstIds(project);
  const views = sides.map((view) => ({ productId, variantId, view, image: `presentation/${view}.png` }));
  const raw: Record<string, unknown> = { version: 2, views };
  if (model) raw['models'] = [{ productId, variantId, model }];
  return new TextEncoder().encode(JSON.stringify(raw));
}

function modelOnlyManifest(project: ProjectDocument, model: string): Uint8Array {
  const { productId, variantId } = firstIds(project);
  return new TextEncoder().encode(JSON.stringify({ version: 2, views: [], models: [{ productId, variantId, model }] }));
}

/** Synthetic photo-mapping file: bbox affine per region (Y-up mm to v=0-top UV). */
function mappingsFor(project: ProjectDocument, entries: Array<{ regionId: string; view: Side; image: string }>): Uint8Array {
  const { productId, variantId } = firstIds(project);
  const product = project.products.find((item) => item.id === productId)!;
  const mappings = entries.map((entry) => {
    const region = product.regions.find((item) => item.id === entry.regionId)!;
    const xs = region.safeArea.map((point) => point[0]);
    const ys = region.safeArea.map((point) => point[1]);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const w = maxX - minX; const h = maxY - minY;
    return {
      productId, variantId, regionId: entry.regionId, view: entry.view, image: entry.image,
      transform: { a: 1 / w, b: 0, c: -minX / w, d: 0, e: -1 / h, f: maxY / h },
      calibrationId: region.calibrationRef.calibrationId,
      calibrationVersion: region.calibrationRef.version,
      status: 'provisional',
    };
  });
  return new TextEncoder().encode(JSON.stringify({ version: 1, mappings }));
}

async function load(page: Page, bytes: Uint8Array, name = 'synthetic.logo-project'): Promise<void> {
  await hook(page, 'file-input').setInputFiles({ name, mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(hook(page, 'status')).toContainText(`Opened ${name}`);
}

async function downloadBytes(page: Page, trigger: () => Promise<void>): Promise<Uint8Array> {
  const event = page.waitForEvent('download');
  await trigger();
  const download = await event;
  return new Uint8Array(await readFile((await download.path())!));
}

interface ViewsProbeWindow {
  __logoPresentation: {
    getViewsState: () => {
      available: boolean; mode: string; side: string | null; sides: Side[];
      modelPath: string | null; caption: string; warning: string | null;
      failed: boolean; flatFallback: boolean; surface: string;
    };
  };
}

async function viewsState(page: Page): Promise<{
  available: boolean; mode: string; side: string | null; sides: Side[];
  modelPath: string | null; caption: string; warning: string | null;
  failed: boolean; flatFallback: boolean; surface: string;
}> {
  return page.evaluate(() => {
    const scoped = window as unknown as ViewsProbeWindow;
    return scoped.__logoPresentation.getViewsState();
  });
}

async function shoot(page: Page, info: { outputPath: (name: string) => Promise<string> | string }, name: string): Promise<void> {
  await page.screenshot({ path: await info.outputPath(name) });
}

async function mode3dCanvasRendered(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-customer-hook="mode-3d-canvas"]');
    if (canvas === null || !(canvas instanceof HTMLCanvasElement)) return false;
    return canvas.width > 0 && canvas.height > 0;
  });
}

async function mode3dPixels(page: Page): Promise<{ lit: number }> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector('[data-customer-hook="mode-3d-canvas"]') as HTMLCanvasElement;
    const w = 64; const h = 64;
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const octx = off.getContext('2d')!;
    octx.drawImage(canvas, 0, 0, w, h);
    const data = octx.getImageData(0, 0, w, h).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      if (Math.max(Math.abs(data[i]! - 30), Math.abs(data[i + 1]! - 30), Math.abs(data[i + 2]! - 30)) < 10) continue;
      lit++;
    }
    return { lit };
  });
}

async function mode3dWrapMetrics(page: Page): Promise<{ wrapH: number; canvasH: number; canvasW: number; bodyH: number }> {
  return page.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>('[data-customer-hook="mode-3d-wrap"]')!;
    const canvas = document.querySelector<HTMLCanvasElement>('[data-customer-hook="mode-3d-canvas"]')!;
    return { wrapH: wrap.clientHeight, canvasH: canvas.clientHeight, canvasW: canvas.clientWidth, bodyH: document.body.scrollHeight };
  });
}

test('model-only package offers honest 3D with a rendered model and side-tab availability', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const glb = new Uint8Array(await readFile(resolve('examples/models/synthetic-block.glb')));
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: modelOnlyManifest(source.project, 'presentation/model.glb') },
      { path: 'presentation/model.glb', bytes: glb },
    ]);
    await load(page, bytes, 'model-only.logo-project');
    // No second viewer: the hidden showcase stays hidden; the primary canvas
    // shows the measured diagram by default.
    await expect(hook(page, 'views-showcase')).toBeHidden();
    await expect(hook(page, 'canvas')).toBeVisible();
    const state = await viewsState(page);
    expect(state.available).toBe(true);
    expect(state.modelPath).toEqual('presentation/model.glb');
    // All four side tabs are offered but disabled: no mapping binds them.
    for (const side of SIDES) {
      await expect(hook(page, `side-${side}`)).toBeVisible();
      await expect(hook(page, `side-${side}`)).toBeDisabled();
    }
    // 3D mode renders the real model with an honest no-projection caption.
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-wrap')).toBeVisible();
    await expect.poll(() => mode3dCanvasRendered(page)).toBe(true);
    await expect(hook(page, 'model-availability')).toContainText('presentation/model.glb');
    await expect(hook(page, 'model-availability')).toContainText('No logo artwork is projected');
    await expect(hook(page, 'mode-3d-zoom-in')).toBeEnabled();
    await expect(hook(page, 'mode-3d-zoom-out')).toBeEnabled();
    await expect(hook(page, 'mode-3d-reset')).toBeEnabled();
    await expect.poll(() => mode3dPixels(page).then((pixels) => pixels.lit)).toBeGreaterThan(50);
    // Zoom controls keep working; the canvas never traps page scroll.
    await hook(page, 'mode-3d-reset').click();
    await expect.poll(() => mode3dPixels(page).then((pixels) => pixels.lit)).toBeGreaterThan(50);
    const before = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    const saved = await parseProjectPackage(before, { sha256 });
    expect(JSON.stringify(saved.project)).toEqual(JSON.stringify(source.project));
    await shoot(page, info, 'multiview-model-only.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

for (const side of SIDES) {
  test(`image-only single side (${side}) falls back to the diagram with missing-side honesty`, async ({ browser }, info) => {
    const { context, page, probe } = await openOfflineContext(browser);
    try {
      await page.goto(editor);
      const source = await fixture();
      const png = await syntheticPng(page, '#12394b');
      const bytes = await packageWith(source.project, source.assets, [
        { path: 'presentation/preview.json', bytes: v2Manifest(source.project, [side], null) },
        { path: `presentation/${side}.png`, bytes: png },
      ]);
      await load(page, bytes, `single-${side}.logo-project`);
      await expect(hook(page, 'views-showcase')).toBeHidden();
      const state = await viewsState(page);
      expect(state.available).toBe(true);
      expect(state.sides).toEqual([side]);
      // The unmapped photo is reference-only: no mapped overlay, the diagram
      // stays visible, photo mode is disabled with a reason.
      await expect(hook(page, `side-${side}`)).toBeVisible();
      await expect(hook(page, `side-${side}`)).toBeDisabled();
      await expect(hook(page, `side-${side}`)).toHaveAttribute('title', /reference-only|not mapped/i);
      await expect(hook(page, 'canvas')).toBeVisible();
      await expect(hook(page, 'reference-img')).toBeHidden();
      await expect(hook(page, 'mode-photo')).toBeDisabled();
      await expect(hook(page, 'mapping-status')).toContainText('Reference only');
      for (const other of SIDES.filter((entry) => entry !== side)) {
        await expect(hook(page, `side-${other}`)).toBeDisabled();
      }
      const before = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
      expect(Buffer.from(before)).toEqual(Buffer.from(bytes));
      await shoot(page, info, `multiview-single-${side}.png`);
      assertCleanProbe(probe);
    } finally { await context.close(); }
  });
}

test('mapped front/back views switch sides on one canvas; switching never mutates', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const front = await syntheticPng(page, '#12394b');
    const back = await syntheticPng(page, '#4b3912');
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front', 'back'], null) },
      { path: 'presentation/front.png', bytes: front },
      { path: 'presentation/back.png', bytes: back },
      {
        path: 'presentation/photo-mappings.json',
        bytes: mappingsFor(source.project, [
          { regionId: 'SYN-TEE-CHEST', view: 'front', image: 'presentation/front.png' },
          { regionId: 'SYN-TEE-BACK', view: 'back', image: 'presentation/back.png' },
        ]),
      },
    ]);
    await load(page, bytes, 'multi-view.logo-project');
    await expect(hook(page, 'views-showcase')).toBeHidden();
    expect((await viewsState(page)).sides.sort()).toEqual(['back', 'front']);
    // Both mapped sides are enabled; unmapped sides stay disabled honestly.
    await expect(hook(page, 'side-front')).toBeEnabled();
    await expect(hook(page, 'side-back')).toBeEnabled();
    await expect(hook(page, 'side-left')).toBeDisabled();
    // Front shows the mapped photo with the actual artwork overlay.
    await hook(page, 'side-front').click();
    await expect(hook(page, 'mode-photo')).toBeEnabled();
    await hook(page, 'mode-photo').click();
    await expect(hook(page, 'reference-img')).toBeVisible();
    await expect.poll(() => hook(page, 'reference-img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(20);
    await expect(hook(page, 'mapping-status')).toContainText('front view');
    await expect(hook(page, 'mapping-status')).toContainText('visual trial, not production approval');
    await expect(hook(page, 'view-caption')).toContainText('Mapped photo');
    const baseline = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(baseline)).toEqual(Buffer.from(bytes));
    // Back switches region and photo; the project is untouched by viewing.
    await hook(page, 'side-back').click();
    await expect(hook(page, 'reference-img')).toBeVisible();
    await expect(hook(page, 'mapping-status')).toContainText('back view');
    await hook(page, 'mode-diagram').click();
    await expect(hook(page, 'canvas')).toBeVisible();
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-pane')).toBeVisible();
    await hook(page, 'side-front').click();
    const afterSwitches = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(afterSwitches)).toEqual(Buffer.from(baseline));
    await load(page, afterSwitches, 'reopened.logo-project');
    const reopened = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(reopened)).toEqual(Buffer.from(baseline));
    const roundtrip = await parseProjectPackage(reopened, { sha256 });
    expect(JSON.stringify(roundtrip.project)).toEqual(JSON.stringify(source.project));
    await shoot(page, info, 'multiview-switching.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('invalid manifest, corrupt model and bad rasters fall back to the measured diagram', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const png = await syntheticPng(page, '#12394b');
    const variants: Array<{ name: string; additional: Array<{ path: string; bytes: Uint8Array }> }> = [
      { name: 'invalid-manifest.logo-project', additional: [{ path: 'presentation/preview.json', bytes: new TextEncoder().encode('not json') }] },
      {
        name: 'corrupt-model.logo-project',
        additional: [
          { path: 'presentation/preview.json', bytes: modelOnlyManifest(source.project, 'presentation/model.glb') },
          { path: 'presentation/model.glb', bytes: new TextEncoder().encode('not a model at all................') },
        ],
      },
      {
        name: 'remote-view.logo-project',
        additional: [{ path: 'presentation/preview.json', bytes: new TextEncoder().encode(JSON.stringify({ version: 2, views: [{ productId: firstIds(source.project).productId, view: 'front', image: 'https://example.invalid/a.png' }] })) }],
      },
      {
        name: 'missing-bytes.logo-project',
        additional: [{ path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front'], null) }],
      },
      {
        name: 'bad-raster.logo-project',
        additional: [
          { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front'], null) },
          { path: 'presentation/front.png', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') },
        ],
      },
    ];
    for (const variant of variants) {
      const packed = await packageWith(source.project, source.assets, variant.additional);
      await load(page, packed, variant.name);
      await expect(hook(page, 'views-showcase')).toBeHidden();
      await expect(hook(page, 'canvas')).toBeVisible();
      await expect(hook(page, 'save-draft-top')).toBeEnabled();
      const saved = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
      const roundtrip = await parseProjectPackage(saved, { sha256 });
      expect(JSON.stringify(roundtrip.project)).toEqual(JSON.stringify(source.project));
      void png;
    }
    await shoot(page, info, 'multiview-invalid.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('photo mode and side switching never mutate the project; save/reopen keeps exact bytes', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const front = await syntheticPng(page, '#12394b');
    const back = await syntheticPng(page, '#4b3912');
    const glb = new Uint8Array(await readFile(resolve('examples/models/synthetic-block.glb')));
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front', 'back'], 'presentation/model.glb') },
      { path: 'presentation/front.png', bytes: front },
      { path: 'presentation/back.png', bytes: back },
      { path: 'presentation/model.glb', bytes: glb },
      {
        path: 'presentation/photo-mappings.json',
        bytes: mappingsFor(source.project, [
          { regionId: 'SYN-TEE-CHEST', view: 'front', image: 'presentation/front.png' },
          { regionId: 'SYN-TEE-BACK', view: 'back', image: 'presentation/back.png' },
        ]),
      },
    ]);
    await load(page, bytes, 'switching.logo-project');
    await expect(hook(page, 'views-showcase')).toBeHidden();
    const baseline = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(baseline)).toEqual(Buffer.from(bytes));
    await hook(page, 'side-back').click();
    await hook(page, 'mode-photo').click();
    await expect(hook(page, 'reference-img')).toBeVisible();
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-canvas')).toBeVisible();
    await hook(page, 'side-front').click();
    await hook(page, 'mode-diagram').click();
    await expect(hook(page, 'canvas')).toBeVisible();
    const afterSwitches = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(afterSwitches)).toEqual(Buffer.from(baseline));
    await load(page, afterSwitches, 'reopened.logo-project');
    const reopened = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(reopened)).toEqual(Buffer.from(baseline));
    const roundtrip = await parseProjectPackage(reopened, { sha256 });
    expect(JSON.stringify(roundtrip.project)).toEqual(JSON.stringify(source.project));
    await shoot(page, info, 'multiview-photo-switching.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('zero-placement project loads the diagram by default for decisions', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser, { width: 390, height: 844 });
  try {
    await page.goto(editor);
    const zero = JSON.parse(await readFile(resolve('examples/projects/project-empty.project.json'), 'utf8')) as ProjectDocument;
    const png = await syntheticPng(page, '#12394b');
    const project = structuredClone(zero);
    const bytes = await packageWith(project, [], [
      { path: 'presentation/preview.json', bytes: v2Manifest(project, ['front'], null) },
      { path: 'presentation/front.png', bytes: png },
    ]);
    await load(page, bytes, 'zero-placement.logo-project');
    await expect(hook(page, 'views-showcase')).toBeHidden();
    // The measured diagram is the default; the unmapped photo is reference-only.
    await expect(hook(page, 'canvas')).toBeVisible();
    await expect(hook(page, 'mode-diagram')).toHaveAttribute('aria-pressed', 'true');
    await expect(hook(page, 'mapping-status')).toContainText('Reference only');
    const saved = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(saved)).toEqual(Buffer.from(bytes));
    await shoot(page, info, 'multiview-zero-mobile.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

async function canvasRendered(page: Page): Promise<boolean> {
  return mode3dCanvasRendered(page);
}

async function canvasPixels(page: Page): Promise<{ lit: number; buckets: number; mean: number | null }> {
  const { lit } = await mode3dPixels(page);
  return { lit, buckets: 1, mean: null };
}

test('replacement model bytes and an intervening image proxy keep the honest 3D pane current', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const blue = new Uint8Array(await readFile(resolve('examples/models/synthetic-block.glb')));
    // Change only equal-length material bytes: path, length, first and last
    // bytes all remain identical, so a container-header cache would collide.
    const red = new Uint8Array(Buffer.from(Buffer.from(blue).toString('latin1')
      .replace('[0.16,0.38,0.85,1]', '[0.85,0.38,0.16,1]'), 'latin1'));
    expect(red.length).toBe(blue.length);
    expect(Buffer.from(red)).not.toEqual(Buffer.from(blue));
    const modelPackage = (bytes: Uint8Array) => packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: modelOnlyManifest(source.project, 'presentation/model.glb') },
      { path: 'presentation/model.glb', bytes },
    ]);
    const bluePackage = await modelPackage(blue);
    const redPackage = await modelPackage(red);
    const png = await syntheticPng(page, '#00ff00');
    const proxyPackage = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front'], null) },
      { path: 'presentation/front.png', bytes: png },
    ]);
    // Blue model shows in the single 3D pane with honest availability text.
    await load(page, bluePackage, 'blue.logo-project');
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-canvas')).toBeVisible();
    await expect.poll(() => mode3dPixels(page).then((pixels) => pixels.lit)).toBeGreaterThan(50);
    await expect(hook(page, 'model-availability')).toContainText('presentation/model.glb');
    // A red model with identical container bytes replaces the pane content;
    // an intervening model-less package clears it (never a stale blue canvas).
    await load(page, proxyPackage, 'proxy.logo-project');
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-canvas')).toBeHidden();
    await expect(hook(page, 'model-availability')).toContainText('No 3D model supplied');
    await load(page, redPackage, 'red.logo-project');
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-canvas')).toBeVisible();
    await expect.poll(() => mode3dPixels(page).then((pixels) => pixels.lit)).toBeGreaterThan(50);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('GLB-only flat image proxy is replaced by the honest 3D pane', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const glb = new Uint8Array(await readFile(resolve('examples/models/synthetic-block.glb')));
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: modelOnlyManifest(source.project, 'presentation/model.glb') },
      { path: 'presentation/model.glb', bytes: glb },
    ]);
    await load(page, bytes, 'glb-only-flat.logo-project');
    await expect(hook(page, 'views-showcase')).toBeHidden();
    const state = await viewsState(page);
    expect(state.available).toBe(true);
    expect(state.modelPath).toEqual('presentation/model.glb');
    expect(state.flatFallback).toBe(true);
    // All four side tabs are offered but need a mapping to enable.
    for (const side of SIDES) {
      await expect(hook(page, `side-${side}`)).toBeVisible();
      await expect(hook(page, `side-${side}`)).toBeDisabled();
    }
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-canvas')).toBeVisible();
    await expect.poll(() => mode3dCanvasRendered(page)).toBe(true);
    await shoot(page, info, 'multiview-glb-only-flat.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('combined model plus three photos keeps right honest in the single canvas', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const glb = new Uint8Array(await readFile(resolve('examples/models/synthetic-block.glb')));
    const front = await syntheticPng(page, '#12394b');
    const back = await syntheticPng(page, '#4b3912');
    const left = await syntheticPng(page, '#2b4b12');
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front', 'back', 'left'], 'presentation/model.glb') },
      { path: 'presentation/front.png', bytes: front },
      { path: 'presentation/back.png', bytes: back },
      { path: 'presentation/left.png', bytes: left },
      { path: 'presentation/model.glb', bytes: glb },
    ]);
    await load(page, bytes, 'model-three-photo.logo-project');
    await expect(hook(page, 'views-showcase')).toBeHidden();
    // The right side was never supplied: its tab stays disabled with an
    // honest title, and no right photo is ever invented.
    const right = hook(page, 'side-right');
    await expect(right).toBeDisabled();
    await expect(right).toHaveAttribute('title', /No right view supplied/i);
    // 3D mode shows the real model with honest availability text.
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-canvas')).toBeVisible();
    await expect.poll(() => mode3dPixels(page).then((pixels) => pixels.lit)).toBeGreaterThan(50);
    await expect(hook(page, 'model-availability')).toContainText('Interactive 3D model');
    const saved = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(saved)).toEqual(Buffer.from(bytes));
    await shoot(page, info, 'multiview-model-three-photo.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('switching mapped photo mode during a held raster decode retries the same image', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    // Installed before navigation: it must intercept the very first decode.
    await page.addInitScript(() => {
      const native = window.createImageBitmap.bind(window);
      const state: { hold: boolean; releases: Array<() => void> } = { hold: true, releases: [] };
      (window as unknown as { __heldBitmap: typeof state }).__heldBitmap = state;
      window.createImageBitmap = (function (...args: unknown[]) {
        const result = Reflect.apply(native, window, args) as Promise<ImageBitmap>;
        if (!state.hold) return result;
        return result.then((bitmap) => new Promise<ImageBitmap>((done) => state.releases.push(() => done(bitmap))));
      }) as typeof window.createImageBitmap;
    });
    await page.goto(editor);
    const source = await fixture();
    const png = await syntheticPng(page, '#12394b');
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front'], null) },
      { path: 'presentation/front.png', bytes: png },
      {
        path: 'presentation/photo-mappings.json',
        bytes: mappingsFor(source.project, [
          { regionId: 'SYN-TEE-CHEST', view: 'front', image: 'presentation/front.png' },
        ]),
      },
    ]);
    await load(page, bytes, 'held-same-image.logo-project');
    await hook(page, 'side-front').click();
    await hook(page, 'mode-photo').click();
    await page.waitForFunction(() => (window as unknown as { __heldBitmap: { releases: unknown[] } }).__heldBitmap.releases.length >= 1);
    await page.evaluate(() => { (window as unknown as { __heldBitmap: { hold: boolean } }).__heldBitmap.hold = false; });
    // Toggling diagram/photo while a decode is held retries the same image.
    await hook(page, 'mode-diagram').click();
    await expect(hook(page, 'canvas')).toBeVisible();
    await hook(page, 'mode-photo').click();
    await page.evaluate(() => { for (const release of (window as unknown as { __heldBitmap: { releases: Array<() => void> } }).__heldBitmap.releases) release(); });
    await expect(hook(page, 'mode-photo')).toHaveAttribute('aria-pressed', 'true');
    await expect(hook(page, 'reference-img')).toBeVisible();
    await expect.poll(() => hook(page, 'reference-img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(20);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('stale raster decode never installs the wrong side after a side switch', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const front = await syntheticPng(page, '#00ff00');
    const back = await syntheticPng(page, '#ff0000');
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front', 'back'], null) },
      { path: 'presentation/front.png', bytes: front },
      { path: 'presentation/back.png', bytes: back },
      {
        path: 'presentation/photo-mappings.json',
        bytes: mappingsFor(source.project, [
          { regionId: 'SYN-TEE-CHEST', view: 'front', image: 'presentation/front.png' },
          { regionId: 'SYN-TEE-BACK', view: 'back', image: 'presentation/back.png' },
        ]),
      },
    ]);
    await load(page, bytes, 'stale-decode.logo-project');
    await hook(page, 'side-front').click();
    await hook(page, 'mode-photo').click();
    // Switch sides immediately: a delayed front decode must not paint over back.
    await hook(page, 'side-back').click();
    await expect(hook(page, 'mapping-status')).toContainText('back view');
    await expect.poll(() => hook(page, 'reference-img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(20);
    await expect(hook(page, 'reference-img')).toBeVisible();
    await shoot(page, info, 'multiview-stale-decode.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('corrupt model surfaces preview-unavailable in the 3D pane, never a blank success', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser, { width: 390, height: 844 });
  try {
    await page.goto(editor);
    const source = await fixture();
    const front = await syntheticPng(page, '#12394b');
    // Collapsed-bounds copy of the synthetic GLB: the container header parses
    // and the payload passes the self-contained read-boundary checks, but the
    // position bounds collapse to a single point, so the viewer builds an
    // empty scene and must surface failure instead of a blank success canvas.
    const validGlb = new Uint8Array(await readFile(resolve('examples/models/synthetic-block.glb')));
    const glbView = new DataView(validGlb.buffer, validGlb.byteOffset, validGlb.byteLength);
    const jsonLength = glbView.getUint32(12, true);
    const manifest2 = JSON.parse(Buffer.from(validGlb.subarray(20, 20 + jsonLength)).toString('utf8').replace(/\0+$/, ''));
    manifest2.accessors[0].min = [0, 0, 0];
    manifest2.accessors[0].max = [0, 0, 0];
    const sceneText = new TextEncoder().encode(JSON.stringify(manifest2));
    const paddedLength = (sceneText.length + 3) & ~3;
    const padded = new Uint8Array(paddedLength);
    padded.set(sceneText);
    padded.fill(0x20, sceneText.length);
    const bin = validGlb.slice(20 + jsonLength + 8);
    const glb = new Uint8Array(20 + paddedLength + 8 + bin.length);
    const writer = new DataView(glb.buffer);
    writer.setUint32(0, 0x46546c67, true);
    writer.setUint32(4, 2, true);
    writer.setUint32(8, glb.length, true);
    writer.setUint32(12, paddedLength, true);
    writer.setUint32(16, 0x4e4f534a, true);
    glb.set(padded, 20);
    writer.setUint32(20 + paddedLength, bin.length, true);
    writer.setUint32(20 + paddedLength + 4, 0x004e4942, true);
    glb.set(bin, 20 + paddedLength + 8);
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front'], 'presentation/model.glb') },
      { path: 'presentation/front.png', bytes: front },
      { path: 'presentation/model.glb', bytes: glb },
    ]);
    await load(page, bytes, 'model-failure.logo-project');
    await hook(page, 'mode-3d').click();
    await expect.poll(() => viewsState(page).then((state) => state.failed)).toBe(true);
    await expect(hook(page, 'model-availability')).toContainText(/Preview unavailable|not a valid model|No 3D model/i);
    await expect(hook(page, 'mode-3d-canvas')).toBeHidden();
    // The measured diagram stays usable alongside the failure notice.
    await hook(page, 'mode-diagram').click();
    await expect(hook(page, 'canvas')).toBeVisible();
    const saved = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(saved)).toEqual(Buffer.from(bytes));
    await shoot(page, info, 'multiview-failure-mobile.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('single-canvas layout stays bounded across animation frames and screenshots settle', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const glb = new Uint8Array(await readFile(resolve('examples/models/synthetic-block.glb')));
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: modelOnlyManifest(source.project, 'presentation/model.glb') },
      { path: 'presentation/model.glb', bytes: glb },
    ]);
    await load(page, bytes, 'layout-stable.logo-project');
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-wrap')).toBeVisible();
    await expect.poll(() => viewsState(page).then((state) => state.surface)).toBe('model');
    // Let several animation frames run: the bounded wrap + block canvas keep
    // every metric identical, and the page never gains a horizontal scrollbar.
    const first = await mode3dWrapMetrics(page);
    expect(first.wrapH).toBeGreaterThan(0);
    expect(first.canvasH).toBeGreaterThan(0);
    for (let frame = 0; frame < 5; frame += 1) {
      await page.waitForTimeout(300);
      const next = await mode3dWrapMetrics(page);
      expect(next.wrapH).toEqual(first.wrapH);
      expect(next.canvasH).toEqual(first.canvasH);
      expect(next.canvasW).toEqual(first.canvasW);
      expect(next.bodyH).toEqual(first.bodyH);
    }
    // Canvas fills the wrap (block layout, no baseline gap).
    expect(Math.abs(first.canvasH - first.wrapH)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shoot(page, info, 'multiview-layout-stable.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
