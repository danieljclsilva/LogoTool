// Tranche E acceptance (lead-owned): product cards replace nested rows.
// Thumbnail/name cards (real photo bytes, white background, human fallback
// labels never IDs); include checkbox independent from Open setup; single
// option products ship their only option with no second decision; real
// multi-option choices; deliberate configuration subsets kept; both
// customer formats + master roundtrip unchanged. Synthetic fixtures only.
// Offline file://, zero console/page errors, zero HTTP(S) requests.

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { gotoBuilder, revealBuilderControl } from './helpers.js';

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return ['builder-next', 'builder-back'].includes(name)
    ? builder(page, name).filter({ visible: true }).first()
    : builder(page, name);
}

async function openBuilder(browser: Browser): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(String(message.text()));
  });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  await gotoBuilder(page);
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
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

test('product cards: thumbnails, independent open, single-option default, narrowed subset', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openBuilder(browser);
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
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await (await shown(page, 'source-file')).setInputFiles(fixturePath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded product-cards.logo-project');

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
    // Multi-option product reveals its real choices once included.
    await multiCard.locator('input[type="checkbox"][value="CARD-MULTI"]').check();
    await expect(multiCard.locator('[data-options-for]')).toBeVisible();
    await expect(multiCard.getByRole('checkbox', { name: 'Size M' })).toBeVisible();
    await expect(multiCard.getByRole('checkbox', { name: 'Size L' })).toBeVisible();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('product-cards.png') });
    }

    // Include is independent from Open setup: checking Solo never moves
    // the workspace; only its Open button does.
    await multiCard.getByRole('button', { name: 'Open setup for Multi Jacket' }).click();
    await expect(builder(page, 'workspace-product')).toHaveValue('CARD-MULTI');
    await soloCard.locator('input[type="checkbox"]').check();
    await expect(await shown(page, 'selection-summary')).toContainText('1 option');
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

    // Issue: Solo's only setup ships by default; Multi ships only Size M.
    await (await shown(page, 'builder-next')).click();
    await (await shown(page, 'customer-name')).fill('Card Customer');
    await (await shown(page, 'job-ref')).fill('CARDS-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('Customer file ready (revision 1)');
    const baselineEvent = page.waitForEvent('download');
    await (await shown(page, 'download-baseline')).click();
    const baseline = await baselineEvent;
    const baselinePath = info.outputPath('cards-issued.logo-project');
    await baseline.saveAs(baselinePath);
    const parsed = await parseProjectPackage(new Uint8Array(await readFile(baselinePath)), { sha256 });
    expect(parsed.project.configurations.map((entry) => entry.id).sort()).toEqual(['cfg-multi-m', 'cfg-solo']);

    // Deliberate configuration subset survives regeneration.
    await (await shown(page, 'step-choose')).click();
    await page.locator('details', { has: page.locator('[data-builder-hook="configuration-list"]') }).locator('summary').click();
    await page.locator('[data-builder-hook="configuration-list"] input[type="checkbox"][value="cfg-multi-m"]').uncheck();
    await (await shown(page, 'builder-next')).click();
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('Customer file ready (revision 1)');
    const baselineEvent2 = page.waitForEvent('download');
    await (await shown(page, 'download-baseline')).click();
    const baseline2 = await baselineEvent2;
    const baselinePath2 = info.outputPath('cards-narrowed.logo-project');
    await baseline2.saveAs(baselinePath2);
    const parsed2 = await parseProjectPackage(new Uint8Array(await readFile(baselinePath2)), { sha256 });
    expect(parsed2.project.configurations.map((entry) => entry.id)).toEqual(['cfg-solo']);

    // Both customer formats + master roundtrip unchanged.
    const htmlEvent = page.waitForEvent('download');
    await (await shown(page, 'download-package')).click();
    const html = await htmlEvent;
    assert.ok(html.suggestedFilename().endsWith('.html'), 'self-contained customer file downloads');
    await html.saveAs(info.outputPath('cards-customer.html'));
    await (await shown(page, 'step-details')).click();
    await (await shown(page, 'format-hybrid')).check();
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('Customer file ready (revision 1)');
    const zipEvent = page.waitForEvent('download');
    await (await shown(page, 'download-package')).click();
    const zip = await zipEvent;
    const zipPath = info.outputPath('cards-hybrid.zip');
    await zip.saveAs(zipPath);
    expect(Object.keys(unzipSync(new Uint8Array(await readFile(zipPath)))).sort())
      .toEqual(['CARDS-01.logo-project', 'OPEN_LOGO_CONFIGURATOR.html']);
    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master = await masterEvent;
    const masterPath = info.outputPath('cards-master.logo-project');
    await master.saveAs(masterPath);
    const masterParsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    expect(masterParsed.project.products).toHaveLength(3);
    await (await shown(page, 'source-file')).setInputFiles(masterPath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded cards-master.logo-project');
    await expect(page.locator('div[data-product-card="CARD-SOLO"]')).toBeVisible();

    // Narrow viewport keeps cards usable.
    await page.setViewportSize({ width: 480, height: 900 });
    await expect(page.locator('div[data-product-card="CARD-MULTI"]')).toBeVisible();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('product-cards-narrow.png') });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
