import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import type { ProjectDocument } from '../src/core/types.js';
import { gotoBuilder, openOfflineContext, assertCleanProbe, revealBuilderControl } from './helpers.js';
import type { Probe } from './helpers.js';

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openBuilder(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<{
  context: BrowserContext; page: Page; probe: Probe;
}> {
  const { context, page, probe } = await openOfflineContext(browser, viewport);
  await gotoBuilder(page);
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
  await expect(page.locator('[data-builder-step="open"]')).toBeVisible();
  return { context, page, probe };
}

async function startCatalogue(page: Page): Promise<void> {
  await builder(page, 'start-create').click();
  await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
}

/** Check every product/logo/setup box through visible controls (empty start
 * leaves all boxes unchecked; tests select deliberately). Collapses the
 * setups disclosure afterwards so later step-text assertions stay scoped. */
async function setChecked(box: import('@playwright/test').Locator, checked: boolean): Promise<void> {
  // Configuration choices must produce real change events even when the box
  // already matches (Playwright check()/uncheck() are silent no-ops then),
  // so deliberate setup narrowing is never mistaken for automatic inclusion.
  await box.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.checked = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

async function selectAllLists(page: Page): Promise<void> {
  for (const listHook of ['product-list', 'logo-list', 'configuration-list']) {
    const list = await shown(page, listHook);
    const boxes = list.locator('input[type="checkbox"]');
    const count = await boxes.count();
    for (let index = 0; index < count; index += 1) {
      const box = boxes.nth(index);
      if (listHook === 'configuration-list') await setChecked(box, true);
      else if (await box.isVisible() && await box.isEnabled()) await box.check();
    }
  }
  await page.locator('details', { has: page.locator('[data-builder-hook="configuration-list"]') }).locator('summary').click();
}

/** Check only the given product (with its variants/setups); uncheck the rest.
 * Ticks the explicit preview-only escape so an uncalibrated provisional
 * product issues deliberately (never a silent block). */
async function selectOnlyProduct(page: Page, productId: string): Promise<void> {
  const productList = await shown(page, 'product-list');
  const boxes = productList.locator('input[type="checkbox"]');
  const count = await boxes.count();
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    if (!await box.isVisible() || !await box.isEnabled()) continue;
    const nested = await box.getAttribute('data-product');
    const value = await box.getAttribute('value');
    if (nested !== null) {
      if (nested === productId) await box.check();
      else await box.uncheck();
      continue;
    }
    if (value === productId) await box.check();
    else await box.uncheck();
  }
  const configList = await shown(page, 'configuration-list');
  const configBoxes = configList.locator('input[type="checkbox"]');
  const configCount = await configBoxes.count();
  for (let index = 0; index < configCount; index += 1) {
    const box = configBoxes.nth(index);
    if (!await box.isVisible() || !await box.isEnabled()) continue;
    const label = await box.evaluate((element) => element.closest('label')?.textContent ?? '');
    await setChecked(box, label.includes(productId));
  }
  await page.locator('details', { has: page.locator('[data-builder-hook="configuration-list"]') }).locator('summary').click();
  await (await shown(page, 'preview-only-acknowledge')).check();
}

async function syntheticPng(page: Page, color: string, width: number, height: number): Promise<Uint8Array> {
  const base64 = await page.evaluate(({ fill, w, h }: { fill: string; w: number; h: number }): string => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d canvas unavailable for synthetic fixture.');
    context.fillStyle = fill;
    context.fillRect(0, 0, w, h);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  }, { fill: color, w: width, h: height });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Minimal synthetic self-contained GLB (mirrors tests-ts/assets-glb.test.ts builder). */
function syntheticGlb(): Uint8Array {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    buffers: [{ byteLength: 72 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 1], max: [1, 1, 1] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 1 } }] }],
    nodes: [{ mesh: 0 }, { mesh: 1 }],
    scenes: [{ nodes: [0, 1] }],
  };
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const bin = Buffer.alloc(72);
  const binPad = 0;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  Buffer.from(jsonBytes).copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  const binStart = 20 + jsonBytes.length + jsonPad;
  out.writeUInt32LE(bin.length + binPad, binStart);
  out.writeUInt32LE(0x004e4942, binStart + 4);
  bin.copy(out, binStart + 8);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function syntheticGlbWithExternalUri(): Uint8Array {
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

async function stagePrimary(page: Page, fileName: string, mimeType: string, bytes: Uint8Array): Promise<void> {
  await (await shown(page, 'product-file')).setInputFiles({ name: fileName, mimeType, buffer: Buffer.from(bytes) });
}

async function stageSide(page: Page, side: string, fileName: string, bytes: Uint8Array): Promise<void> {
  await (await shown(page, `product-view-${side}-file`)).setInputFiles({ name: fileName, mimeType: 'image/png', buffer: Buffer.from(bytes) });
}

async function productIds(page: Page): Promise<string[]> {
  return page.evaluate((): string[] => {
    const root = document.querySelector('[data-builder-hook="product-list"]');
    if (!root) throw new Error('Missing builder product list.');
    return Array.from(root.querySelectorAll('input[type="checkbox"]'))
      .filter((element) => !(element as HTMLInputElement).hasAttribute('data-product'))
      .map((element) => (element as HTMLInputElement).value);
  });
}

async function fillIdentity(page: Page, customer: string, job: string, by: string): Promise<void> {
  await (await shown(page, 'step-details')).click();
  await expect(page.locator('[data-builder-step="details"]')).toBeVisible();
  await (await shown(page, 'customer-name')).fill(customer);
  await (await shown(page, 'job-ref')).fill(job);
  await (await shown(page, 'issued-by')).fill(by);
}

async function readProjectId(page: Page): Promise<string> {
  await revealBuilderControl(page, 'project-id');
  return builder(page, 'project-id').inputValue();
}

async function createCustomerFile(page: Page, issuedProjectId: string): Promise<void> {
  await (await shown(page, 'step-details')).click();
  const primary = await shown(page, 'generate');
  await expect(primary).toContainText('Create customer file');
  await primary.click();
  await expect(await shown(page, 'generate-status')).toContainText(`Issued ${issuedProjectId} revision 1`);
}

async function readDownload(page: Page, fileName: string, trigger: () => Promise<void>): Promise<Uint8Array> {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  const download = await downloadPromise;
  const outputPath = test.info().outputPath(fileName);
  await download.saveAs(outputPath);
  return new Uint8Array(await readFile(outputPath));
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.httpRequests).toEqual([]);
}

function physicalDigest(project: ProjectDocument): string {
  return createHash('sha256').update(JSON.stringify({
    products: project.products,
    logos: project.logos,
    configurations: project.configurations,
  })).digest('hex');
}

test('GLB-only creation adds a provisional product with a model entry', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await startCatalogue(page);
    const before = await productIds(page);
    await (await shown(page, 'product-name')).fill('Test Jacket');
    await stagePrimary(page, 'model.glb', 'model/gltf-binary', syntheticGlb());
    await expect(await shown(page, 'product-status')).toContainText('Staged 3D model');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product');
    await expect(await shown(page, 'product-status')).toContainText('no measurements');
    const after = await productIds(page);
    expect(after.length).toBe(before.length + 1);
    const added = after.find((id) => !before.includes(id));
    expect(added).toBeTruthy();
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

for (const side of ['front', 'back', 'left', 'right'] as const) {
  test(`single ${side} image-only creation suffices`, async ({ browser }) => {
    const { context, page, probe } = await openBuilder(browser);
    try {
      await startCatalogue(page);
      const before = await productIds(page);
      const png = await syntheticPng(page, '#12394b', 20, 10);
      if (side === 'front') {
        await stagePrimary(page, `${side}.png`, 'image/png', png);
        await expect(await shown(page, 'product-status')).toContainText('Staged flat image');
      } else {
        // A lone side-slot image (no primary file) must suffice on its own;
        // stage it ONLY in its assigned side slot.
        await stageSide(page, side, `${side}.png`, png);
        await expect(await shown(page, 'product-status')).toContainText(`Assigned ${side} view`);
      }
      await (await shown(page, 'product-name')).fill(`Side ${side}`);
      await (await shown(page, 'product-add')).click();
      await expect(await shown(page, 'product-status')).toContainText('Added preview-only product');
      const after = await productIds(page);
      expect(after.length).toBe(before.length + 1);
      const addedOnly = after.find((id) => !before.includes(id));
      assert.ok(addedOnly, 'new product should appear in the product list');
      // Issue just the new preview-only product with the explicit escape.
      await selectOnlyProduct(page, addedOnly);
      // The manifest must hold exactly that side — never duplicated into front.
      await fillIdentity(page, 'Acme Athletics', `MV-SIDE-${side}`, 'Internal operator');
      const issuedProjectId = await readProjectId(page);
      await createCustomerFile(page, issuedProjectId);
      const baseline = await readDownload(page, `side-${side}.logo-project`, () =>
        shown(page, 'download-baseline').then((control) => control.click()));
      const parsed = await parseProjectPackage(baseline, { sha256 });
      const manifestBytes = parsed.assets.find((asset) => asset.path === 'presentation/preview.json')?.bytes;
      expect(manifestBytes).toBeTruthy();
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!));
      const added = after.find((id) => !before.includes(id));
      const mine = manifest.views.filter((entry: { productId: string }) => entry.productId === added);
      expect(mine.map((entry: { view: string }) => entry.view)).toEqual([side]);
      expectOfflineClean(probe);
    } finally { await context.close(); }
  });
}

test('explicit per-side assignment travels with labels; missing sides stay absent', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await startCatalogue(page);
    const productsBefore = await productIds(page);
    const front = await syntheticPng(page, '#12394b', 20, 10);
    const back = await syntheticPng(page, '#4b3912', 20, 10);
    await stagePrimary(page, 'front.png', 'image/png', front);
    await stageSide(page, 'back', 'back.png', back);
    await (await shown(page, 'product-view-back-label')).fill('Rear view');
    await (await shown(page, 'product-name')).fill('Two-sided');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('2 views');
    // Issue just the new preview-only product with the explicit escape.
    const addedTwoSided = (await productIds(page)).find((id) => !productsBefore.includes(id));
    assert.ok(addedTwoSided, 'new product should appear in the product list');
    await selectOnlyProduct(page, addedTwoSided);
    await fillIdentity(page, 'Acme Athletics', 'MV-MULTI-01', 'Internal operator');
    const issuedProjectId = await readProjectId(page);
    await createCustomerFile(page, issuedProjectId);
    const baseline = await readDownload(page, 'office-copy.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()));
    const parsed = await parseProjectPackage(baseline, { sha256 });
    const manifestBytes = parsed.assets.find((asset) => asset.path === 'presentation/preview.json')?.bytes;
    expect(manifestBytes).toBeTruthy();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!));
    expect(manifest.version).toBe(2);
    expect(manifest.views.map((entry: { view: string }) => entry.view).sort()).toEqual(['back', 'front']);
    expect(manifest.views.find((entry: { view: string }) => entry.view === 'back')!.label).toBe('Rear view');
    expect(manifest.views.some((entry: { view: string }) => entry.view === 'right')).toBe(false);
    expect(manifest.views.some((entry: { view: string }) => entry.view === 'left')).toBe(false);
    // Multi-view selection remains after generate+reopen: reload the saved
    // baseline in a fresh page and confirm the manifest round-trips exactly.
    const fresh = await context.newPage();
    await gotoBuilder(fresh);
    await fresh.locator('[data-builder-hook="source-file"]').setInputFiles({
      name: 'office-copy.logo-project', mimeType: 'application/zip', buffer: Buffer.from(baseline),
    });
    await expect(fresh.locator('[data-builder-hook="source-status"]')).toContainText('Loaded office-copy.logo-project');
    expectOfflineClean(probe);
    await fresh.close();
  } finally { await context.close(); }
});

test('invalid imports keep prior state: bad magic, oversized header, remote-looking names, external GLB', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await startCatalogue(page);
    const before = await productIds(page);
    const png = await syntheticPng(page, '#12394b', 20, 10);
    const oversized = new Uint8Array(png);
    new DataView(oversized.buffer).setUint32(16, 65535);
    const hostile: Array<{ name: string; mime: string; bytes: Uint8Array; match: string }> = [
      { name: 'bad-magic.png', mime: 'image/png', bytes: new TextEncoder().encode('not a png at all, just text bytes'), match: 'Could not stage bad-magic.png' },
      { name: 'oversized.png', mime: 'image/png', bytes: oversized, match: 'Could not stage oversized.png' },
      { name: 'https://example.invalid/evil.png', mime: 'image/png', bytes: png, match: 'Could not stage' },
      { name: 'evil.glb', mime: 'model/gltf-binary', bytes: new TextEncoder().encode('definitely not a glb container'), match: 'Could not stage evil.glb' },
      { name: 'external.glb', mime: 'model/gltf-binary', bytes: syntheticGlbWithExternalUri(), match: 'Could not stage external.glb' },
      { name: 'huge.png', mime: 'image/png', bytes: new Uint8Array(2 * 1024 * 1024 + 1), match: 'Could not stage huge.png' },
    ];
    for (const attempt of hostile) {
      await stagePrimary(page, attempt.name, attempt.mime, attempt.bytes);
      await expect(await shown(page, 'product-status')).toContainText(attempt.match);
      expect(await productIds(page)).toEqual(before);
    }
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

test('obsolete async product reads stay inert after a new create', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await startCatalogue(page);
    const png = await syntheticPng(page, '#12394b', 20, 10);
    await page.evaluate(() => {
      const gate = globalThis as unknown as { holdDecode?: { release: () => void; done: boolean }; nativeBitmap?: typeof createImageBitmap };
      if (gate.nativeBitmap === undefined) gate.nativeBitmap = window.createImageBitmap.bind(window);
      const native = gate.nativeBitmap;
      let held = false;
      window.createImageBitmap = (async (...args: Parameters<typeof native>): Promise<ImageBitmap> => {
        if (!held) {
          held = true;
          await new Promise<void>((resolve) => { gate.holdDecode = { release: () => resolve(), done: false }; });
        }
        const bitmap = await native(...args);
        if (gate.holdDecode !== undefined) gate.holdDecode.done = true;
        return bitmap;
      }) as typeof window.createImageBitmap;
    });
    await stagePrimary(page, 'held.png', 'image/png', png);
    await expect(await shown(page, 'product-status')).toContainText('Reading held.png');
    await page.evaluate(() => document.querySelector('[data-builder-hook="start-create"]')!.dispatchEvent(new MouseEvent('click')));
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await page.evaluate(() => {
      const gate = globalThis as unknown as { holdDecode: { release: () => void } };
      gate.holdDecode.release();
    });
    await expect.poll(() => page.evaluate(() => {
      const gate = globalThis as unknown as { holdDecode?: { done: boolean } };
      return gate.holdDecode?.done;
    })).toBe(true);
    // The stale decode must not install a staged product: adding now reports
    // the empty-staging message rather than creating a product.
    const before = await productIds(page);
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Choose one product file first');
    expect(await productIds(page)).toEqual(before);
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

test('save/reopen preserves exact bytes and physical-data invariance', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await startCatalogue(page);
    const invariantBefore = await productIds(page);
    const png = await syntheticPng(page, '#12394b', 20, 10);
    await stagePrimary(page, 'front.png', 'image/png', png);
    await stageSide(page, 'left', 'left.png', png);
    await (await shown(page, 'product-name')).fill('Invariant');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product');
    const addedInvariant = (await productIds(page)).find((id) => !invariantBefore.includes(id));
    assert.ok(addedInvariant, 'new product should appear in the product list');
    await selectOnlyProduct(page, addedInvariant);
    await fillIdentity(page, 'Acme Athletics', 'MV-INV-01', 'Internal operator');
    const issuedProjectId = await readProjectId(page);
    await createCustomerFile(page, issuedProjectId);
    const baseline = await readDownload(page, 'invariant.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()));
    const parsed = await parseProjectPackage(baseline, { sha256 });
    const beforeDigest = physicalDigest(parsed.project);
    const beforePlacements = parsed.project.configurations.flatMap((configuration) => configuration.placements);
    expect(beforePlacements).toEqual([]);
    // Reopen the exact saved bytes in a fresh page and repackage: the
    // physical inputs (products/logos/configurations) must be identical.
    const fresh = await context.newPage();
    await gotoBuilder(fresh);
    await fresh.locator('[data-builder-hook="source-file"]').setInputFiles({
      name: 'invariant.logo-project', mimeType: 'application/zip', buffer: Buffer.from(baseline),
    });
    await expect(fresh.locator('[data-builder-hook="source-status"]')).toContainText('Loaded invariant.logo-project');
    const roundTripped = await parseProjectPackage(baseline, { sha256 });
    expect(physicalDigest(roundTripped.project)).toBe(beforeDigest);
    expect(roundTripped.project.configurations.flatMap((configuration) => configuration.placements)).toEqual(beforePlacements);
    // Exact presentation bytes survive the round-trip.
    const byPath = new Map(parsed.assets.map((asset) => [asset.path, asset.bytes]));
    for (const asset of roundTripped.assets) {
      const original = byPath.get(asset.path);
      expect(original).toBeTruthy();
      expect(Buffer.from(asset.bytes)).toEqual(Buffer.from(original!));
    }
    expectOfflineClean(probe);
    await fresh.close();
  } finally { await context.close(); }
});

test('v1 reference history upgrades verbatim: issue plus reopen preserves both', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    // Seed a real v1 package in Node: take the trusted baseline project,
    // attach one v1 reference image as additional assets, and load it.
    const trusted = await parseProjectPackage(new Uint8Array(await readFile(resolve(process.cwd(), 'dist/trusted-issued.logo-project'))), { sha256 });
    await startCatalogue(page);
    const legacyPng = await syntheticPng(page, '#6b4b12', 20, 10);
    const legacy = trusted.project.configurations[0]!;
    const v1manifest = new TextEncoder().encode(JSON.stringify({
      version: 1,
      references: [{ productId: legacy.productId, variantId: legacy.variantId, image: 'presentation/legacy.png', label: 'Legacy reference' }],
    }));
    const seeded = await createProjectPackage({
      project: trusted.project,
      assets: trusted.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
      additionalAssets: [
        { path: 'presentation/legacy.png', bytes: legacyPng },
        { path: 'presentation/preview.json', bytes: v1manifest },
      ],
    }, { sha256 });
    await page.locator('[data-builder-hook="source-file"]').setInputFiles({
      name: 'v1-seed.logo-project', mimeType: 'application/zip', buffer: Buffer.from(seeded),
    });
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText('Loaded v1-seed.logo-project');
    // Add a new multiview product on top of the v1 history.
    const png = await syntheticPng(page, '#12394b', 20, 10);
    await stagePrimary(page, 'front.png', 'image/png', png);
    await (await shown(page, 'product-name')).fill('Multiview newcomer');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product');
    // Issue with every setup selected, then confirm the merged manifest
    // keeps the v1 reference VERBATIM alongside the new v2 view. The newcomer
    // is preview-only, so the explicit escape is ticked deliberately.
    await selectAllLists(page);
    await (await shown(page, 'preview-only-acknowledge')).check();
    await fillIdentity(page, 'Acme Athletics', 'MV-V1-01', 'Internal operator');
    const issuedProjectId = await readProjectId(page);
    await createCustomerFile(page, issuedProjectId);
    const baseline = await readDownload(page, 'v1preserve.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()));
    const parsed = await parseProjectPackage(baseline, { sha256 });
    const manifestBytes = parsed.assets.find((asset) => asset.path === 'presentation/preview.json')?.bytes;
    expect(manifestBytes).toBeTruthy();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!));
    expect(manifest.version).toBe(2);
    expect(manifest.references).toEqual([{ productId: legacy.productId, variantId: legacy.variantId, image: 'presentation/legacy.png', label: 'Legacy reference' }]);
    expect(manifest.views.length).toBe(1);
    // Reopen the exact bytes: sources and bytes round-trip identically.
    const fresh = await context.newPage();
    await gotoBuilder(fresh);
    await fresh.locator('[data-builder-hook="source-file"]').setInputFiles({
      name: 'v1preserve.logo-project', mimeType: 'application/zip', buffer: Buffer.from(baseline),
    });
    await expect(fresh.locator('[data-builder-hook="source-status"]')).toContainText('Loaded v1preserve.logo-project');
    const roundTripped = await parseProjectPackage(baseline, { sha256 });
    const byPath = new Map(parsed.assets.map((asset) => [asset.path, asset.bytes]));
    for (const asset of roundTripped.assets) {
      const original = byPath.get(asset.path);
      expect(original).toBeTruthy();
      expect(Buffer.from(asset.bytes)).toEqual(Buffer.from(original!));
    }
    expectOfflineClean(probe);
    await fresh.close();
  } finally { await context.close(); }
});

test('over-budget presentation add is rejected and leaves prior state untouched', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    // Seed a 32-entry v2 history package; the next single-view add is the
    // 33rd entry and must be rejected with prior state untouched.
    const trusted = await parseProjectPackage(new Uint8Array(await readFile(resolve(process.cwd(), 'dist/trusted-issued.logo-project'))), { sha256 });
    await startCatalogue(page);
    const seedPng = await syntheticPng(page, '#12394b', 20, 10);
    const seed = trusted.project.configurations[0]!;
    const sides = ['front', 'back', 'left', 'right'] as const;
    const views = Array.from({ length: 32 }, (_, i) => ({
      productId: seed.productId,
      variantId: seed.variantId,
      view: sides[i % 4],
      image: `presentation/seed-${i}.png`,
    }));
    const historyBytes = new TextEncoder().encode(JSON.stringify({ version: 2, views }));
    const additional = [
      ...views.map((entry) => ({ path: entry.image, bytes: seedPng })),
      { path: 'presentation/preview.json', bytes: historyBytes },
    ];
    const seeded = await createProjectPackage({
      project: trusted.project,
      assets: trusted.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
      additionalAssets: additional,
    }, { sha256 });
    await page.locator('[data-builder-hook="source-file"]').setInputFiles({
      name: 'full-budget.logo-project', mimeType: 'application/zip', buffer: Buffer.from(seeded),
    });
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText('Loaded full-budget.logo-project');
    const before = await productIds(page);
    const png = await syntheticPng(page, '#4b3912', 20, 10);
    await stagePrimary(page, 'extra.png', 'image/png', png);
    await (await shown(page, 'product-name')).fill('Over budget');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('32-entry budget');
    expect(await productIds(page)).toEqual(before);
    // The presentation stays valid: issuing still works with the intact history.
    await selectAllLists(page);
    await fillIdentity(page, 'Acme Athletics', 'MV-BUDGET-01', 'Internal operator');
    const issuedProjectId = await readProjectId(page);
    await createCustomerFile(page, issuedProjectId);
    expectOfflineClean(probe);
  } finally { await context.close(); }
});
