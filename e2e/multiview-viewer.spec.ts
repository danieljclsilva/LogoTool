import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectDocument } from '../src/core/types.js';
import { openOfflineContext, assertCleanProbe } from './helpers.js';
import type { Page } from '@playwright/test';

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

interface ViewsProbe {
  __logoPresentation: {
    getViewsState: () => {
      available: boolean; mode: string; side: string | null; sides: Side[]; modelPath: string | null; caption: string; warning: string | null; failed: boolean; flatFallback: boolean; surface: string;
    };
  };
}

async function viewsState(page: Page): Promise<{ available: boolean; mode: string; side: string | null; sides: Side[]; modelPath: string | null; caption: string; warning: string | null; failed: boolean; flatFallback: boolean; surface: string }> {
  return page.evaluate(() => {
    // Named boundary cast: the customer bundle publishes __logoPresentation for tests.
    const scoped = window as unknown as ViewsProbe;
    return scoped.__logoPresentation.getViewsState();
  });
}

async function shoot(page: Page, info: { outputPath: (name: string) => Promise<string> | string }, name: string): Promise<void> {
  await page.screenshot({ path: await info.outputPath(name) });
}

async function showcaseMetrics(page: Page): Promise<{ wrapH: number; canvasH: number; canvasW: number; bodyH: number }> {
  return page.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>('[data-customer-hook="views-model-wrap"]')!;
    const canvas = document.querySelector<HTMLCanvasElement>('[data-customer-hook="views-model-canvas"]')!;
    return {
      wrapH: wrap.clientHeight,
      canvasH: canvas.clientHeight,
      canvasW: canvas.clientWidth,
      bodyH: document.body.scrollHeight,
    };
  });
}

test('model-only package offers 3D with side presets and honest projection captions', async ({ browser }, info) => {
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
    await expect(hook(page, 'views-showcase')).toBeVisible();
    const state = await viewsState(page);
    expect(state.available).toBe(true);
    expect(state.modelPath).toEqual('presentation/model.glb');
    await hook(page, 'views-mode-3d').click();
    await expect(hook(page, 'views-model-wrap')).toBeVisible();
    await expect(hook(page, 'views-caption')).toContainText('Interactive 3D model');
    for (const side of SIDES) {
      await hook(page, `views-side-${side}`).click();
      await expect(hook(page, 'views-caption')).toContainText(side);
    }
    await hook(page, 'views-mode-2d').click();
    await expect(hook(page, 'views-caption')).toContainText('Model projection - not a garment unfolding');
    const before = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    const saved = await parseProjectPackage(before, { sha256 });
    expect(JSON.stringify(saved.project)).toEqual(JSON.stringify(source.project));
    await shoot(page, info, 'multiview-model-only.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

for (const side of SIDES) {
  test(`image-only single side (${side}) shows flat view with missing-side honesty`, async ({ browser }, info) => {
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
      await expect(hook(page, 'views-showcase')).toBeVisible();
      const state = await viewsState(page);
      expect(state.available).toBe(true);
      expect(state.sides).toEqual([side]);
      await expect(hook(page, `views-side-${side}`)).toBeVisible();
      await expect(hook(page, 'views-flat-img')).toBeVisible();
      await expect.poll(() => hook(page, 'views-flat-img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(20);
      await expect(hook(page, 'views-caption')).toContainText('Flat product view');
      await expect(hook(page, 'views-missing')).toContainText('not supplied');
      for (const other of SIDES.filter((entry) => entry !== side)) {
        await expect(hook(page, `views-side-${other}`)).toBeHidden();
      }
      await expect(hook(page, 'views-missing')).toContainText(SIDES.filter((entry) => entry !== side)[0]!);
      const before = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
      expect(Buffer.from(before)).toEqual(Buffer.from(bytes));
      await shoot(page, info, `multiview-single-${side}.png`);
      assertCleanProbe(probe);
    } finally { await context.close(); }
  });
}

test('multi-view selection switches sides; image-only 3D is a labelled proxy', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const front = await syntheticPng(page, '#12394b');
    const left = await syntheticPng(page, '#4b3912');
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front', 'left'], null) },
      { path: 'presentation/front.png', bytes: front },
      { path: 'presentation/left.png', bytes: left },
    ]);
    await load(page, bytes, 'multi-view.logo-project');
    await expect(hook(page, 'views-showcase')).toBeVisible();
    expect((await viewsState(page)).sides.sort()).toEqual(['front', 'left']);
    await hook(page, 'views-side-left').click();
    await expect(hook(page, 'views-caption')).toContainText('left view');
    await expect(hook(page, 'views-flat-img')).toBeVisible();
    await hook(page, 'views-side-front').click();
    await expect(hook(page, 'views-caption')).toContainText('front view');
    await expect(hook(page, 'views-missing')).toContainText('back');
    await expect(hook(page, 'views-missing')).toContainText('right');
    await expect(hook(page, 'views-missing')).toContainText('not supplied');
    await hook(page, 'views-mode-2d').click();
    await expect(hook(page, 'views-caption')).toContainText('Planar view - not a 3D reconstruction');
    await expect(hook(page, 'views-flat-img')).toBeVisible();
    await hook(page, 'views-mode-3d').click();
    await expect(hook(page, 'views-caption')).toContainText('Proxy - not reconstructed geometry');
    await expect(hook(page, 'views-model-wrap')).toBeVisible();
    const before = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(before)).toEqual(Buffer.from(bytes));
    await shoot(page, info, 'multiview-multi.png');
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

test('mode and side switching never mutates the project; save/reopen keeps exact bytes', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const png = await syntheticPng(page, '#12394b');
    const glb = new Uint8Array(await readFile(resolve('examples/models/synthetic-block.glb')));
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front', 'back'], 'presentation/model.glb') },
      { path: 'presentation/front.png', bytes: png },
      { path: 'presentation/back.png', bytes: png },
      { path: 'presentation/model.glb', bytes: glb },
    ]);
    await load(page, bytes, 'switching.logo-project');
    await expect(hook(page, 'views-showcase')).toBeVisible();
    const baseline = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(baseline)).toEqual(Buffer.from(bytes));
    await hook(page, 'views-side-back').click();
    await hook(page, 'views-mode-2d').click();
    await hook(page, 'views-mode-3d').click();
    await hook(page, 'views-side-front').click();
    await hook(page, 'views-mode-flat').click();
    await hook(page, 'view-diagram').click();
    const afterSwitches = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(afterSwitches)).toEqual(Buffer.from(baseline));
    await load(page, afterSwitches, 'reopened.logo-project');
    await expect(hook(page, 'views-showcase')).toBeVisible();
    const reopened = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(reopened)).toEqual(Buffer.from(baseline));
    const roundtrip = await parseProjectPackage(reopened, { sha256 });
    expect(JSON.stringify(roundtrip.project)).toEqual(JSON.stringify(source.project));
    await shoot(page, info, 'multiview-switching.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('zero-placement project loads the showcase; diagram stays the default for decisions', async ({ browser }, info) => {
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
    await expect(hook(page, 'views-showcase')).toBeVisible();
    await expect(hook(page, 'views-caption')).toContainText('Flat product view');
    await expect(hook(page, 'views-flat-img')).toBeVisible();
    await expect(hook(page, 'canvas')).toHaveCount(1);
    const saved = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(saved)).toEqual(Buffer.from(bytes));
    await shoot(page, info, 'multiview-zero-mobile.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

async function canvasRendered(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-customer-hook="views-model-canvas"]');
    if (canvas === null || !(canvas instanceof HTMLCanvasElement)) return false;
    // A live viewer sizes the canvas for its container; a zero-area canvas
    // never painted. The viewer-reported surface status plus this size check
    // establish readiness; canvasPixels below proves actual rendered pixels.
    return canvas.width > 0 && canvas.height > 0;
  });
}

// In-page canvas readback: samples the live WebGL canvas synchronously after
// two animation frames (the viewer's own render already presented this
// frame). Requires preserveDrawingBuffer on the viewer renderer; no second GL
// context is created, so the viewer is undisturbed. Returns lit-pixel count
// and coarse color buckets distinguishing blank/dark from rendered geometry.
async function canvasPixels(page: Page): Promise<{ lit: number; buckets: number; mean: number | null }> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector('[data-customer-hook="views-model-canvas"]') as HTMLCanvasElement;
    const w = 64; const h = 64;
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const octx = off.getContext('2d')!;
    octx.drawImage(canvas, 0, 0, w, h);
    const data = octx.getImageData(0, 0, w, h).data;
    let lit = 0; let sum = 0;
    const distinct = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      // Opaque renderer background (#1e1e1e) is not geometry evidence.
      if (Math.max(Math.abs(data[i]! - 30), Math.abs(data[i + 1]! - 30), Math.abs(data[i + 2]! - 30)) < 10) continue;
      lit++;
      sum += data[i]! + data[i + 1]! + data[i + 2]!;
      distinct.add((data[i]! >> 4 << 8) | (data[i + 1]! >> 4 << 4) | (data[i + 2]! >> 4));
    }
    return { lit, buckets: distinct.size, mean: lit > 0 ? Math.round(sum / lit / 3) : null };
  });
}

test('replacement model bytes and an intervening image proxy cannot reuse a stale model', async ({ browser }) => {
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
    async function colorCount(color: 'red' | 'blue' | 'green'): Promise<number> {
      return page.evaluate(async (selected) => {
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        const canvas = document.querySelector<HTMLCanvasElement>('[data-customer-hook="views-model-canvas"]')!;
        const sample = document.createElement('canvas'); sample.width = 64; sample.height = 64;
        const ctx = sample.getContext('2d')!;
        ctx.drawImage(canvas, 0, 0, 64, 64);
        const pixels = ctx.getImageData(0, 0, 64, 64).data;
        const channel = selected === 'red' ? 0 : selected === 'green' ? 1 : 2;
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + channel]! > pixels[i + (channel + 1) % 3]! + 20 &&
            pixels[i + channel]! > pixels[i + (channel + 2) % 3]! + 20) count++;
        }
        return count;
      }, color);
    }
    for (const [name, bytes, color] of [
      ['blue', bluePackage, 'blue'], ['red', redPackage, 'red'],
      ['proxy', proxyPackage, 'green'], ['red-return', redPackage, 'red'],
    ] as const) {
      await load(page, bytes, `${name}.logo-project`);
      await hook(page, 'views-mode-3d').click();
      await expect.poll(() => colorCount(color)).toBeGreaterThan(50);
    }
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('GLB-only flat is enabled and renders a labelled model projection', async ({ browser }, info) => {
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
    await expect(hook(page, 'views-showcase')).toBeVisible();
    const flat = hook(page, 'views-mode-flat');
    await expect(flat).toBeEnabled();
    await flat.click();
    await expect(flat).toHaveAttribute('aria-pressed', 'true');
    await expect(hook(page, 'views-caption')).toContainText('Flat model projection');
    await expect.poll(() => viewsState(page).then((state) => state.flatFallback)).toBe(true);
    await expect.poll(() => viewsState(page).then((state) => state.surface)).toBe('model');
    await expect(hook(page, 'views-model-wrap')).toBeVisible();
    await expect.poll(() => canvasRendered(page)).toBe(true);
    // Every side button stays offered with a model; camera free-runs per side.
    for (const side of SIDES) {
      await expect(hook(page, `views-side-${side}`)).toBeEnabled();
    }
    await shoot(page, info, 'multiview-glb-only-flat.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('combined model plus three photos keeps right available and drives the camera', async ({ browser }, info) => {
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
    await expect(hook(page, 'views-showcase')).toBeVisible();
    await hook(page, 'views-mode-3d').click();
    const right = hook(page, 'views-side-right');
    await expect(right).toBeEnabled();
    await right.click();
    await expect(right).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => viewsState(page).then((state) => state.side)).toBe('right');
    await expect(hook(page, 'views-caption')).toContainText('right view');
    await expect(hook(page, 'views-caption')).toContainText('Interactive 3D model');
    await expect.poll(() => viewsState(page).then((state) => state.surface)).toBe('model');
    await expect(hook(page, 'views-model-wrap')).toBeVisible();
    await expect.poll(() => canvasRendered(page)).toBe(true);
    // Pixel proof, not status alone: the canvas must hold rendered model
    // pixels (blank = defect). The synthetic block is single-color, so only
    // lit count is asserted here; color variety is proven by the real-jacket
    // acceptance pixels.
    const rightPixels = await canvasPixels(page);
    expect(rightPixels.lit).toBeGreaterThan(50);
    // The absent right photo is never invented: flat on right is the
    // explicitly labelled model projection.
    await hook(page, 'views-mode-flat').click();
    await expect(hook(page, 'views-caption')).toContainText('Flat model projection');
    await expect(hook(page, 'views-caption')).toContainText('right view');
    const saved = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(saved)).toEqual(Buffer.from(bytes));
    await shoot(page, info, 'multiview-model-three-photo.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('switching mode during a held raster decode retries the same image', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const png = await syntheticPng(page, '#12394b');
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front'], null) },
      { path: 'presentation/front.png', bytes: png },
    ]);
    await page.evaluate(() => {
      const native = window.createImageBitmap;
      const state = { hold: true, releases: [] as Array<() => void> };
      (window as unknown as { __heldBitmap: typeof state }).__heldBitmap = state;
      window.createImageBitmap = (function (...args: unknown[]) {
        const result = Reflect.apply(native, window, args) as Promise<ImageBitmap>;
        if (!state.hold) return result;
        return result.then((bitmap) => new Promise<ImageBitmap>((done) => state.releases.push(() => done(bitmap))));
      }) as typeof window.createImageBitmap;
    });
    await load(page, bytes, 'held-same-image.logo-project');
    await page.waitForFunction(() => (window as unknown as { __heldBitmap: { releases: unknown[] } }).__heldBitmap.releases.length >= 2);
    await page.evaluate(() => { (window as unknown as { __heldBitmap: { hold: boolean } }).__heldBitmap.hold = false; });
    await hook(page, 'views-mode-2d').click();
    await expect(hook(page, 'views-flat-img')).toBeVisible();
    await expect.poll(() => hook(page, 'views-flat-img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(20);
    await page.evaluate(() => { for (const release of (window as unknown as { __heldBitmap: { releases: Array<() => void> } }).__heldBitmap.releases) release(); });
    await expect(hook(page, 'views-mode-2d')).toHaveAttribute('aria-pressed', 'true');
    await expect(hook(page, 'views-flat-img')).toBeVisible();
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('stale raster decode never installs after a mode/side switch', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixture();
    const front = await syntheticPng(page, '#12394b');
    const back = await syntheticPng(page, '#7a1f3d');
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: v2Manifest(source.project, ['front', 'back'], null) },
      { path: 'presentation/front.png', bytes: front },
      { path: 'presentation/back.png', bytes: back },
    ]);
    await load(page, bytes, 'stale-decode.logo-project');
    await expect(hook(page, 'views-showcase')).toBeVisible();
    await hook(page, 'views-side-front').click();
    await expect.poll(() => viewsState(page).then((state) => state.side)).toBe('front');
    // Switch sides immediately: a delayed front decode must not paint over back.
    await hook(page, 'views-side-back').click();
    await expect.poll(() => viewsState(page).then((state) => state.side)).toBe('back');
    await expect(hook(page, 'views-caption')).toContainText('back view');
    await expect.poll(() => hook(page, 'views-flat-img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(20);
    await expect(hook(page, 'views-caption')).toContainText('back view');
    await shoot(page, info, 'multiview-stale-decode.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('corrupt model surfaces preview-unavailable, never a blank success', async ({ browser }, info) => {
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
    await expect(hook(page, 'views-showcase')).toBeVisible();
    await hook(page, 'views-mode-3d').click();
    await expect.poll(() => viewsState(page).then((state) => state.failed)).toBe(true);
    await expect(hook(page, 'views-caption')).toContainText('Preview unavailable');
    const warning = hook(page, 'views-warning');
    const empty = hook(page, 'views-empty');
    const warningVisible = await warning.isVisible().catch(() => false);
    const emptyVisible = await empty.isVisible().catch(() => false);
    expect(warningVisible || emptyVisible).toBe(true);
    // Flat raster fallback stays available alongside the failure notice.
    await hook(page, 'views-mode-flat').click();
    await expect(hook(page, 'views-flat-img')).toBeVisible();
    const saved = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    expect(Buffer.from(saved)).toEqual(Buffer.from(bytes));
    await shoot(page, info, 'multiview-failure-mobile.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('showcase canvas layout stays bounded across animation frames and screenshots settle', async ({ browser }, info) => {
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
    await expect(hook(page, 'views-showcase')).toBeVisible();
    await hook(page, 'views-mode-3d').click();
    await expect(hook(page, 'views-model-wrap')).toBeVisible();
    await expect.poll(() => viewsState(page).then((state) => state.surface)).toBe('model');
    // Let several animation frames run: an inline-canvas baseline gap grows
    // the wrap ~6px per frame and never settles. Bounded wrap + block canvas
    // keeps every metric identical.
    const first = await showcaseMetrics(page);
    expect(first.wrapH).toBeGreaterThan(0);
    expect(first.canvasH).toBeGreaterThan(0);
    for (let frame = 0; frame < 5; frame += 1) {
      await page.waitForTimeout(300);
      const next = await showcaseMetrics(page);
      expect(next.wrapH).toEqual(first.wrapH);
      expect(next.canvasH).toEqual(first.canvasH);
      expect(next.canvasW).toEqual(first.canvasW);
      expect(next.bodyH).toEqual(first.bodyH);
    }
    // Canvas fills the wrap (block layout, no baseline gap).
    expect(Math.abs(first.canvasH - first.wrapH)).toBeLessThanOrEqual(2);
    await shoot(page, info, 'multiview-layout-stable.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
