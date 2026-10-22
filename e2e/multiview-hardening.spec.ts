import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectDocument } from '../src/core/types.js';
import { createProvisionalProduct } from '../src/core/project-builder/provisional-product.js';
import { openOfflineContext, assertCleanProbe, revealCustomerControl, selectCustomerOption } from './helpers.js';
type ViewsSide = 'front' | 'back' | 'left' | 'right';

const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const editor = pathToFileURL(resolve('dist/dev/customer-configurator.html')).href;
const hook = (page: Page, name: string) => page.locator(`[data-customer-hook="${name}"]`);

/** Synthetic canvas raster (mirrors e2e/multiview-viewer.spec.ts). */
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

/**
 * Header-valid GLB whose buffer payload lives at a sibling URI (same
 * minimal-GLB technique as e2e/multiview-builder.spec.ts). parseGlb accepts
 * the container; validateSelfContained rejects it as asset-external-uri.
 */
function glbExternalUri(): Uint8Array {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    buffers: [{ byteLength: 72, uri: 'model.bin' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  };
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  Buffer.from(jsonBytes).copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

async function fixtureBase(): Promise<{
  project: ProjectDocument;
  assets: Array<{ path: string; kind: string; bytes: Uint8Array }>;
}> {
  const parsed = await parseProjectPackage(new Uint8Array(await readFile(resolve('dist/dev/trusted-issued.logo-project'))), { sha256 });
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
      available: boolean; mode: string; side: string | null; sides: ViewsSide[];
      modelPath: string | null; caption: string; warning: string | null;
      failed: boolean; flatFallback: boolean; surface: string;
    };
  };
}

async function viewsState(page: Page): Promise<{
  available: boolean; mode: string; side: string | null; sides: ViewsSide[];
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

test('external-reference model-only package stays offline with a failure caption, never a blank success canvas', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixtureBase();
    const { productId, variantId } = firstIds(source.project);
    const manifest = new TextEncoder().encode(JSON.stringify({
      version: 2,
      views: [],
      models: [{ productId, variantId, model: 'presentation/model.glb' }],
    }));
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: manifest },
      { path: 'presentation/model.glb', bytes: glbExternalUri() },
    ]);
    await load(page, bytes, 'external-model-only.logo-project');
    // The unrenderable model is dropped at the read boundary: no showcase,
    // the measured diagram stays, and the warning names the cause.
    await expect(hook(page, 'views-showcase')).toBeHidden();
    await expect(hook(page, 'canvas')).toBeVisible();
    const state = await viewsState(page);
    expect(state.available).toBe(false);
    expect(state.modelPath).toBe(null);
    expect(state.warning ?? '').toMatch(/external reference|self-contained/i);
    expect(state.caption).not.toMatch(/Interactive 3D model|Flat product view|Model projection/);
    await shoot(page, info, 'hardening-external-model-only.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('external-reference model with valid views keeps rasters and warns, offline', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const source = await fixtureBase();
    const { productId, variantId } = firstIds(source.project);
    const manifest = new TextEncoder().encode(JSON.stringify({
      version: 2,
      views: [{ productId, variantId, view: 'front', image: 'presentation/front.png' }],
      models: [{ productId, variantId, model: 'presentation/model.glb' }],
    }));
    const png = await syntheticPng(page, '#12394b');
    const bytes = await packageWith(source.project, source.assets, [
      { path: 'presentation/preview.json', bytes: manifest },
      { path: 'presentation/front.png', bytes: png },
      { path: 'presentation/model.glb', bytes: glbExternalUri() },
    ]);
    await load(page, bytes, 'external-model-with-views.logo-project');
    // The raster channel is reference-only without a mapping; the measured
    // diagram stays authoritative and the model warning is explicit.
    await expect(hook(page, 'views-showcase')).toBeHidden();
    await expect(hook(page, 'canvas')).toBeVisible();
    await expect(hook(page, 'reference-img')).toBeHidden();
    const state = await viewsState(page);
    expect(state.modelPath).toBe(null);
    expect(state.warning ?? '').toMatch(/external reference|self-contained/i);
    await expect(hook(page, 'mapping-status')).toContainText('Reference only');
    // The 3D pane reports the rejected model instead of a blank canvas.
    await hook(page, 'mode-3d').click();
    await expect(hook(page, 'mode-3d-pane')).toBeVisible();
    await expect(hook(page, 'model-availability')).toContainText(/not a self-contained model|external reference|Preview unavailable|No 3D model supplied/i);
    await expect(hook(page, 'canvas-pane')).toBeVisible();
    await shoot(page, info, 'hardening-external-model-with-views-mobile.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('stale package load keeps the current project until the new bytes validate', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const empty = JSON.parse(await readFile(resolve('examples/projects/project-empty.project.json'), 'utf8')) as ProjectDocument;
    const packageA = await packageWith(empty, [], []);
    const projectB = { ...structuredClone(empty), projectId: 'SYN-PROJ-HARDEN-B' };
    delete projectB.confirmation;
    delete projectB.review;
    const packageB = await packageWith(projectB, [], []);
    await load(page, Buffer.from(packageA), 'stale-a.logo-project');
    await expect(hook(page, 'project-id')).toHaveText('SYN-PROJ-EMPTY-001');
    // Hold the new file's read: B starts loading but must not install until
    // its bytes validate.
    await page.evaluate(() => {
      interface HeldRead { started: boolean; release?: () => void }
      interface HeldWindow { __heldRead?: HeldRead }
      const scoped = window as unknown as HeldWindow;
      const record: HeldRead = { started: false };
      scoped.__heldRead = record;
      const native = File.prototype.arrayBuffer;
      Object.defineProperty(File.prototype, 'arrayBuffer', {
        configurable: true,
        writable: true,
        value: function (this: File): Promise<ArrayBuffer> {
          if (this.name !== 'stale-b.logo-project') return native.call(this);
          record.started = true;
          return new Promise<ArrayBuffer>((resolveRead, rejectRead) => {
            record.release = () => {
              Object.defineProperty(File.prototype, 'arrayBuffer', { configurable: true, writable: true, value: native });
              void native.call(this).then(resolveRead, rejectRead);
            };
          });
        },
      });
    });
    await hook(page, 'file-input').setInputFiles({ name: 'stale-b.logo-project', mimeType: 'application/zip', buffer: Buffer.from(packageB) });
    await page.waitForFunction(() => {
      interface HeldStarted { __heldRead?: { started: boolean } }
      return (window as unknown as HeldStarted).__heldRead?.started === true;
    });
    await expect(hook(page, 'project-id')).toHaveText('SYN-PROJ-EMPTY-001');
    await expect(hook(page, 'status')).toContainText('Opening stale-b.logo-project');
    await page.evaluate(() => {
      interface HeldRelease { __heldRead?: { release?: () => void } }
      const record = (window as unknown as HeldRelease).__heldRead;
      if (!record?.release) throw new Error('The held package read was not ready.');
      record.release();
    });
    await expect(hook(page, 'status')).toContainText('Opened stale-b.logo-project');
    await expect(hook(page, 'project-id')).toHaveText('SYN-PROJ-HARDEN-B');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('preview-only config with artwork blocks placement in the real UI; calibrated config places normally', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor);
    const empty = JSON.parse(await readFile(resolve('examples/projects/project-empty.project.json'), 'utf8')) as ProjectDocument;
    const provisional = createProvisionalProduct({ id: 'PREV-ONLY-1' });
    if (!provisional.ok) throw new Error('Expected the provisional preview-only product to build.');
    const logoA = JSON.parse(await readFile(resolve('examples/logos/syn-mark-a.logo.json'), 'utf8'));
    const logoB = JSON.parse(await readFile(resolve('examples/logos/syn-mark-b.logo.json'), 'utf8'));
    const svgA = new Uint8Array(await readFile(resolve('examples/logos/syn-mark-a.svg')));
    const svgB = new Uint8Array(await readFile(resolve('examples/logos/syn-mark-b.svg')));
    const previewVariantId = provisional.product.variants[0]!.id;
    const project: ProjectDocument = {
      ...structuredClone(empty),
      projectId: 'SYN-PROJ-HARDEN-PREV',
      products: [...structuredClone(empty).products, provisional.product],
      logos: [logoA, logoB],
      configurations: [
        ...structuredClone(empty).configurations,
        { id: 'cfg-preview', productId: provisional.product.id, variantId: previewVariantId, placements: [] },
      ],
    };
    delete project.confirmation;
    delete project.review;
    const bytes = await createProjectPackage({
      project,
      assets: [
        { path: 'logos/syn-mark-a.svg', bytes: svgA },
        { path: 'logos/syn-mark-b.svg', bytes: svgB },
      ],
      additionalAssets: [],
    }, { sha256 });
    await load(page, bytes, 'artwork-with-preview-only.logo-project');
    await expect(hook(page, 'configuration').locator('option')).toHaveCount(2);
    // Preview-only config: the form offers no area and no method, and the
    // real add control stays disabled (the add path throws
    // preview-only-unprepared-region, covered in Node).
    await selectCustomerOption(page, 'configuration', 'cfg-preview');
    await expect(page.locator('[data-customer-hook="region"] option')).toHaveCount(0);
    await expect(page.locator('[data-customer-hook="method"] option')).toHaveCount(0);
    await expect(hook(page, 'add')).toBeDisabled();
    // Calibrated config with the same artwork places normally.
    await selectCustomerOption(page, 'configuration', 'SYN-CFG-CAP-OS');
    await expect(page.locator('[data-customer-hook="region"] option')).toHaveCount(1);
    await expect(page.locator('[data-customer-hook="region"]')).toHaveValue('SYN-CAP-FRONT');
    await expect(hook(page, 'add')).toBeEnabled();
    await revealCustomerControl(page, 'add');
    await hook(page, 'add').click();
    await expect(hook(page, 'status')).toContainText('Added the logo');
    await expect(hook(page, 'revision')).toHaveText('2');
    // Candidate export path is unaffected: the draft saves, and the
    // calibrated config carries the placement while preview-only stays empty.
    const saved = await downloadBytes(page, () => hook(page, 'save-draft-top').click());
    const roundtrip = await parseProjectPackage(saved, { sha256 });
    const calibrated = roundtrip.project.configurations.find((entry) => entry.id === 'SYN-CFG-CAP-OS');
    const preview = roundtrip.project.configurations.find((entry) => entry.id === 'cfg-preview');
    expect(calibrated?.placements.length).toBe(1);
    expect(preview?.placements.length).toBe(0);
    await shoot(page, info, 'hardening-artwork-preview-only.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, info, 'hardening-artwork-preview-only-mobile.png');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
