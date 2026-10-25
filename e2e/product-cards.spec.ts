// Product cards acceptance through the operator job shell: opened fixture
// packages render thumbnail/name cards (real photo bytes, white
// background, human fallback labels never IDs); include checkbox is
// independent from Open setup; single-option products ship their only
// option with no second decision; deliberate narrowing (variant + setup
// unticks) survives into the placement/review outputs. Product cards
// arrive unchecked for an opened fixture: the operator ticks to include
// and unticks to exclude. Synthetic fixtures only. Offline file://, zero
// console/page errors, zero HTTP(S) requests.

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createProjectPackage } from '../src/packaging/project-package/index.js';
import { createHash } from 'node:crypto';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { BUILDER_URL, gotoBuilder, openOfflineContext, revealBuilderControl } from './helpers.js';
import type { Probe } from './helpers.js';
import { release } from 'node:os';

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openStation(browser: Browser): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  await test.info().attach('product-cards-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform, release: release(), arch: process.arch,
      browser: browser.browserType().name(), browserVersion: browser.version(),
      viewport: { width: 1280, height: 900 }, offline: true, entryPoint: BUILDER_URL,
    }, null, 2),
  });
  const { context, page, probe } = await openOfflineContext(browser, { width: 1280, height: 900 });
  await gotoBuilder(page);
  await expect(page.locator('[data-job-landing]')).toBeVisible();
  await builder(page, 'job-landing-create').click();
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
  return { context, page, probe };
}

async function syntheticPngBytes(page: Page, fill: string, w: number, h: number): Promise<Uint8Array> {
  const base64 = await page.evaluate(({ color, width, height }: { color: string; width: number; height: number }): string => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d canvas unavailable.');
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  }, { color: fill, width: w, height: h });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Minimal synthetic self-contained GLB (mirrors multiview-builder.spec.ts). */
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
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  Buffer.from(jsonBytes).copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  const binStart = 20 + jsonBytes.length + jsonPad;
  out.writeUInt32LE(bin.length, binStart);
  out.writeUInt32LE(0x004e4942, binStart + 4);
  bin.copy(out, binStart + 8);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function measuredRegion(regionId: string, regionName: string, calibrationId: string) {
  return {
    id: regionId,
    name: regionName,
    frame: {
      frameId: `frame-${regionId}`,
      originDescription: 'Lower-left corner of the measured rectangle',
      axes: { xPositive: 'right', yPositive: 'up' },
    },
    calibrationRef: { calibrationId, version: '1' },
    safeArea: [[0, 0], [280, 0], [280, 200], [0, 200]],
    allowedMethods: ['embroidery', 'print'],
  };
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.httpRequests).toEqual([]);
}

test('product cards: thumbnails, independent open, single-option default, narrowed subset', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openStation(browser);
  try {
    const soloPng = await syntheticPngBytes(page, '#1d6f3a', 400, 300);
    const multiPng = await syntheticPngBytes(page, '#6f1d3a', 400, 300);
    const glb = syntheticGlb();
    const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const project = {
      schemaVersion: '0.1.0-provisional',
      projectId: 'SYN-PROJ-CARDS-001',
      revision: 1,
      products: [
        {
          schemaVersion: '0.1.0-provisional', id: 'CARD-SOLO', name: 'Solo Jacket', kind: 'other',
          variants: [{ id: 'CARD-SOLO-V', regionIds: ['region-solo-1'] }],
          regions: [measuredRegion('region-solo-1', 'Solo chest', 'cal-solo-1')],
          calibrations: [{ id: 'cal-solo-1', version: '1', description: 'solo trial' }],
        },
        {
          schemaVersion: '0.1.0-provisional', id: 'CARD-MULTI', name: 'Multi Jacket', kind: 'other',
          variants: [
            { id: 'CARD-MULTI-M', name: 'Size M', regionIds: ['region-multi-1'] },
            { id: 'CARD-MULTI-L', name: 'Size L', regionIds: ['region-multi-1'] },
          ],
          regions: [measuredRegion('region-multi-1', 'Multi chest', 'cal-multi-1')],
          calibrations: [{ id: 'cal-multi-1', version: '1', description: 'multi trial' }],
        },
        {
          schemaVersion: '0.1.0-provisional', id: 'CARD-MODEL', kind: 'other',
          variants: [{ id: 'CARD-MODEL-V', regionIds: [] }],
          regions: [],
          calibrations: [],
        },
      ],
      logos: [],
      configurations: [
        { id: 'cfg-solo', productId: 'CARD-SOLO', variantId: 'CARD-SOLO-V', placements: [] },
        { id: 'cfg-multi-m', productId: 'CARD-MULTI', variantId: 'CARD-MULTI-M', placements: [] },
        { id: 'cfg-multi-l', productId: 'CARD-MULTI', variantId: 'CARD-MULTI-L', placements: [] },
      ],
    };
    const mappingFor = (productId: string, variantId: string, regionId: string, image: string, calibrationId: string) => ({
      productId, variantId, regionId, view: 'front', image,
      transform: { a: 1 / 280, b: 0, c: 0, d: 0, e: -1 / 200, f: 1 },
      calibrationId, calibrationVersion: '1', status: 'provisional',
    });
    const bytes = await createProjectPackage({
      project,
      assets: [],
      additionalAssets: [
        { path: 'presentation/solo-front.png', bytes: soloPng },
        { path: 'presentation/multi-front.png', bytes: multiPng },
        { path: 'presentation/model.glb', bytes: new Uint8Array(glb) },
        {
          path: 'presentation/preview.json',
          bytes: enc({
            version: 2,
            views: [
              { productId: 'CARD-SOLO', variantId: 'CARD-SOLO-V', view: 'front', image: 'presentation/solo-front.png' },
              { productId: 'CARD-MULTI', variantId: 'CARD-MULTI-M', view: 'front', image: 'presentation/multi-front.png' },
              { productId: 'CARD-MULTI', variantId: 'CARD-MULTI-L', view: 'front', image: 'presentation/multi-front.png' },
            ],
            models: [{ productId: 'CARD-MODEL', variantId: 'CARD-MODEL-V', model: 'presentation/model.glb' }],
          }),
        },
        {
          path: 'presentation/photo-mappings.json',
          bytes: enc({
            version: 1,
            mappings: [
              mappingFor('CARD-SOLO', 'CARD-SOLO-V', 'region-solo-1', 'presentation/solo-front.png', 'cal-solo-1'),
              mappingFor('CARD-MULTI', 'CARD-MULTI-M', 'region-multi-1', 'presentation/multi-front.png', 'cal-multi-1'),
            ],
          }),
        },
      ],
    }, { sha256 });
    const fixturePath = info.outputPath('product-cards.logo-project');
    await writeFile(fixturePath, Buffer.from(bytes));
    // Open the explicit fixture through the real Open job chooser.
    await builder(page, 'job-open-file').setInputFiles(fixturePath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded product-cards.logo-project');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await (await shown(page, 'customer-name')).fill('Card Customer');
    await (await shown(page, 'job-ref')).fill('CARDS-01');

    // Cards: real thumbnails, human names, model-only fallback (never an ID).
    const soloCard = page.locator('div[data-product-card="CARD-SOLO"]');
    const multiCard = page.locator('div[data-product-card="CARD-MULTI"]');
    const modelCard = page.locator('div[data-product-card="CARD-MODEL"]');
    await expect(soloCard.locator('img.product-thumb')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(soloCard.locator('img.product-thumb')).toHaveAttribute('alt', 'Solo Jacket photo');
    await expect(multiCard.locator('img.product-thumb')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(modelCard.locator('img.product-thumb')).toHaveCount(0);
    await expect(modelCard).toContainText('3D model — no photo yet');
    await expect(modelCard).toContainText('Product 3');
    await expect(modelCard).not.toContainText('CARD-MODEL');
    // Single-option product: no variant row, inclusion stated once.
    await expect(soloCard.locator('[data-options-for]')).toHaveCount(0);
    await expect(soloCard).toContainText('Includes Standard option.');
    // Opened fixture cards arrive unchecked: tick to include. Multi-option
    // product reveals its real choices once included.
    await expect(soloCard.locator('input[type="checkbox"]').first()).not.toBeChecked();
    await expect(multiCard.locator('input[type="checkbox"]').first()).not.toBeChecked();
    await multiCard.locator('input[type="checkbox"][value="CARD-MULTI"]').check();
    await expect(multiCard.locator('input[type="checkbox"][value="CARD-MULTI"]')).toBeChecked();
    await expect(multiCard.locator('[data-options-for]')).toBeVisible();
    await expect(multiCard.getByRole('checkbox', { name: 'Size M' })).toBeVisible();
    await expect(multiCard.getByRole('checkbox', { name: 'Size L' })).toBeVisible();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('product-cards.png') });
    }

    // Include is independent from Open setup: opening Multi never moves the
    // include state; only its Open button moves the workspace.
    await multiCard.getByRole('button', { name: 'Open setup for Multi Jacket' }).click();
    await expect(builder(page, 'workspace-product')).toHaveValue('CARD-MULTI');
    await soloCard.locator('input[type="checkbox"]').check();
    await expect(soloCard.locator('input[type="checkbox"]').first()).toBeChecked();
    await expect(await shown(page, 'selection-summary')).toContainText('2 products');
    await expect(builder(page, 'workspace-product')).toHaveValue('CARD-MULTI');
    await soloCard.getByRole('button', { name: 'Open setup for Solo Jacket' }).click();
    await expect(builder(page, 'workspace-product')).toHaveValue('CARD-SOLO');

    // Narrow to Size M only (Size L stays out); add one logo for counts.
    // (Multi is already included above, so its options are visible.)
    await multiCard.getByRole('checkbox', { name: 'Size M' }).check();
    await multiCard.getByRole('checkbox', { name: 'Size L' }).uncheck();
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(soloPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await expect(await shown(page, 'selection-summary')).toContainText('2 products');
    await expect(await shown(page, 'selection-summary')).toContainText('2 options');
    await expect(await shown(page, 'selection-summary')).toContainText('1 logo');

    // Deliberate configuration subset: untick the Size L setup as well (the
    // Size L option is already out; this pins the narrowed choice).
    await page.locator('details', { has: page.locator('[data-builder-hook="configuration-list"]') }).locator('summary').click();
    await page.locator('[data-builder-hook="configuration-list"] input[type="checkbox"][value="cfg-multi-l"]').uncheck();

    // Step 2 shows only the included scope: Solo plus Multi. Size L was
    // unticked in Step 1 and stays out of the placement scope.
    await expect(await shown(page, 'job-prepare-gate')).toHaveText('');
    await (await shown(page, 'job-to-placements')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    const host = builder(page, 'job-placement-host');
    await expect(host).toContainText('Solo Jacket');
    await expect(host).toContainText('Multi Jacket');
    // Untick Solo: the editable catalogue keeps it (Step 2 still lists it
    // for editing), but scoped outputs must omit it — proven at review.
    await (await shown(page, 'job-step-1')).click();
    await soloCard.locator('input[type="checkbox"]').uncheck();
    await expect(soloCard.locator('input[type="checkbox"]').first()).not.toBeChecked();
    await (await shown(page, 'job-step-2')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await expect(builder(page, 'job-placement-host')).toContainText('Solo Jacket');
    await expect(builder(page, 'job-placement-host')).toContainText('Multi Jacket');

    // Review carries the narrowed job: one product, one option, and zero
    // placements stay present with the explicit no-placement statement.
    // The operator data pins the surviving variant by name.
    await builder(page, 'job-placement-host').getByRole('button', { name: 'Review document' }).click();
    await expect(page.locator('[data-job-step="review"]')).toBeVisible();
    const reviewHost = builder(page, 'job-review-host');
    await expect(reviewHost).toContainText('Products: 1 · Options: 1 · Placements: 0');
    await expect(reviewHost).not.toContainText('Solo Jacket');
    await expect(reviewHost.locator('[data-doc-review-preview]')).toContainText('No logos configured on this sheet — 0 logos, nothing to place, measure, or produce.');
    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
    await reviewHost.locator('summary', { hasText: 'More output options' }).click();
    const operatorEvent = page.waitForEvent('download');
    await reviewHost.getByRole('button', { name: 'Save operator data' }).click();
    const operatorFile = await operatorEvent;
    const operatorPath = await operatorFile.path();
    assert.ok(operatorPath, 'operator download path is available');
    const operatorView = JSON.parse(await readFile(operatorPath, 'utf8')) as {
      format: string;
      products: Array<{ product: string; variant: string; logos: unknown[]; instructions: string[] }>;
    };
    expect(operatorView.format).toBe('operation-export/1');
    expect(operatorView.products).toHaveLength(1);
    expect(operatorView.products[0]!.product).toBe('Multi Jacket');
    expect(operatorView.products[0]!.variant).toBe('Size M');
    expect(operatorView.products[0]!.logos).toEqual([]);

    // Narrow viewport keeps cards usable.
    await (await shown(page, 'job-step-1')).click();
    await page.setViewportSize({ width: 480, height: 900 });
    await expect(page.locator('div[data-product-card="CARD-MULTI"]')).toBeVisible();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('product-cards-narrow.png') });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});
