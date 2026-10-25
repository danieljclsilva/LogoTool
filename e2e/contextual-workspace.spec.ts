// Tranche C acceptance (lead-owned): contextual workspace controls and
// scoped-draft safety. Two measured products + a shared-region variant
// fixture (all synthetic, built inline): unsaved edits survive product /
// variant / side switches and restore on return; cancel keeps the bucket;
// source reimport clears; async saves land on the clicked scope only;
// selected anchors/corners expose name/remove/precision with invalid-edit
// recovery; the shared-region effect is explicit at the save control;
// pick lists collapse behind All-disclosures on selection. Offline file://,
// zero console/page errors, zero HTTP(S) requests.

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
  await expect(page.locator('[data-job-landing]')).toBeVisible();
  await page.locator('[data-builder-hook="job-landing-create"]').click();
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
  return { context, page, probe };
}

async function syntheticPngBytes(page: Page, fill = '#1d6f3a', w = 400, h = 300): Promise<Uint8Array> {
  const base64 = await page.evaluate(({ color, width, height }: { color: string; width: number; height: number }): string => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d canvas unavailable for synthetic PNG fixture.');
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  }, { color: fill, width: w, height: h });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

interface FixtureProduct {
  id: string;
  name: string;
  regionId: string;
  regionName: string;
  variants: string[];
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

/** Two measured single-variant products sharing one front photo each. */
async function twoProductFixture(pngA: Uint8Array, pngB: Uint8Array): Promise<Uint8Array> {
  const products: FixtureProduct[] = [
    { id: 'P-CTX-A', name: 'Jacket A', regionId: 'region-a-1', regionName: 'Chest A', variants: ['P-CTX-A-V'] },
    { id: 'P-CTX-B', name: 'Jacket B', regionId: 'region-b-1', regionName: 'Chest B', variants: ['P-CTX-B-V'] },
  ];
  const project = {
    schemaVersion: '0.1.0-provisional',
    projectId: 'SYN-PROJ-CTX-001',
    revision: 1,
    products: products.map((product, index) => ({
      schemaVersion: '0.1.0-provisional',
      id: product.id,
      name: product.name,
      kind: 'other',
      variants: [{ id: product.variants[0], regionIds: [product.regionId] }],
      regions: [measuredRegion(product.regionId, product.regionName, `cal-ctx-${index + 1}`)],
      calibrations: [{ id: `cal-ctx-${index + 1}`, version: '1', description: 'context trial' }],
    })),
    logos: [],
    configurations: products.map((product) => ({
      id: `cfg-${product.id}`, productId: product.id, variantId: product.variants[0], placements: [],
    })),
  };
  const mappingFor = (product: FixtureProduct, image: string, index: number) => ({
    productId: product.id,
    variantId: product.variants[0],
    regionId: product.regionId,
    view: 'front',
    image,
    transform: { a: 0.5 / 280, b: 0, c: 0.25, d: 0, e: -0.5 / 200, f: 0.75 },
    calibrationId: `cal-ctx-${index + 1}`,
    calibrationVersion: '1',
    status: 'provisional',
  });
  return createProjectPackage({
    project,
    assets: [],
    additionalAssets: [
      { path: 'presentation/a-front.png', bytes: pngA },
      { path: 'presentation/b-front.png', bytes: pngB },
      {
        path: 'presentation/preview.json',
        bytes: new TextEncoder().encode(JSON.stringify({
          version: 2,
          views: products.map((product) => ({
            productId: product.id,
            variantId: product.variants[0],
            view: 'front',
            image: product.id === 'P-CTX-A' ? 'presentation/a-front.png' : 'presentation/b-front.png',
          })),
        })),
      },
      {
        path: 'presentation/photo-mappings.json',
        bytes: new TextEncoder().encode(JSON.stringify({
          version: 1,
          mappings: [
            mappingFor(products[0]!, 'presentation/a-front.png', 0),
            mappingFor(products[1]!, 'presentation/b-front.png', 1),
          ],
        })),
      },
    ],
  }, { sha256 });
}

/** One measured product with a real 2000 px photo (marker-scale proof). */
async function bigPhotoFixture(png: Uint8Array): Promise<Uint8Array> {
  const project = {
    schemaVersion: '0.1.0-provisional',
    projectId: 'SYN-PROJ-CTX-BIG',
    revision: 1,
    products: [{
      schemaVersion: '0.1.0-provisional',
      id: 'P-CTX-BIG',
      name: 'Big photo product',
      kind: 'other',
      variants: [{ id: 'P-CTX-BIG-V', regionIds: ['region-big-1'] }],
      regions: [measuredRegion('region-big-1', 'Big chest', 'cal-big-1')],
      calibrations: [{ id: 'cal-big-1', version: '1', description: 'big trial' }],
    }],
    logos: [],
    configurations: [
      { id: 'cfg-big', productId: 'P-CTX-BIG', variantId: 'P-CTX-BIG-V', placements: [] },
    ],
  };
  return createProjectPackage({
    project,
    assets: [],
    additionalAssets: [
      { path: 'presentation/front.png', bytes: png },
      {
        path: 'presentation/preview.json',
        bytes: new TextEncoder().encode(JSON.stringify({
          version: 2,
          views: [{ productId: 'P-CTX-BIG', variantId: 'P-CTX-BIG-V', view: 'front', image: 'presentation/front.png' }],
        })),
      },
      {
        path: 'presentation/photo-mappings.json',
        bytes: new TextEncoder().encode(JSON.stringify({
          version: 1,
          mappings: [{
            productId: 'P-CTX-BIG',
            variantId: 'P-CTX-BIG-V',
            regionId: 'region-big-1',
            view: 'front',
            image: 'presentation/front.png',
            transform: { a: 0.5 / 280, b: 0, c: 0.25, d: 0, e: -0.5 / 200, f: 0.75 },
            calibrationId: 'cal-big-1',
            calibrationVersion: '1',
            status: 'provisional',
          }],
        })),
      },
    ],
  }, { sha256 });
}

test('contextual workspace: markers keep usable sizes on a 2000 px photo, desktop and narrow', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openBuilder(browser);
  try {
    const fixturePath = info.outputPath('context-big.logo-project');
    await writeFile(fixturePath, Buffer.from(await bigPhotoFixture(
      await syntheticPngBytes(page, '#274a68', 2000, 1600),
    )));
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await (await shown(page, 'source-file')).setInputFiles(fixturePath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded context-big.logo-project');
    const workspace = builder(page, 'product-workspace');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();

    // Anchor marker, label, hit target and corner/midpoint targets.
    const stage = workspace.locator('.product-setup-overlay').first();
    const stageBox = (await stage.boundingBox())!;
    await stage.click({ position: { x: Math.round(stageBox.width * 0.5), y: Math.round(stageBox.height * 0.5) } });
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    async function markerMinimums() {
      const dot = workspace.locator('.product-setup-anchors circle.product-setup-dot').first();
      const dotBox = await dot.boundingBox();
      assert.ok(dotBox, 'anchor dot has a box');
      expect(dotBox.width).toBeGreaterThanOrEqual(12);
      expect(dotBox.height).toBeGreaterThanOrEqual(12);
      const tag = workspace.locator('.product-setup-anchors text.product-setup-tag').first();
      const tagBox = await tag.boundingBox();
      assert.ok(tagBox, 'anchor label has a box');
      expect(tagBox.height).toBeGreaterThanOrEqual(8);
      const hit = workspace.locator('.product-setup-anchors circle[data-markhit]').first();
      const hitBox = await hit.boundingBox();
      assert.ok(hitBox, 'anchor hit target has a box');
      expect(hitBox.width).toBeGreaterThanOrEqual(20);
      expect(hitBox.height).toBeGreaterThanOrEqual(20);
    }
    await markerMinimums();
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    const vertex = workspace.locator('circle.product-setup-vertex').first();
    const vertexBox = await vertex.boundingBox();
    assert.ok(vertexBox, 'corner handle has a box');
    expect(vertexBox.width).toBeGreaterThanOrEqual(12);
    const vertexHit = workspace.locator('.product-setup-vertices circle[data-markhit]').first();
    const vertexHitBox = await vertexHit.boundingBox();
    assert.ok(vertexHitBox, 'corner hit target has a box');
    expect(vertexHitBox.width).toBeGreaterThanOrEqual(20);
    const midHit = workspace.locator('.product-setup-midpoints circle[data-markhit]').first();
    const midHitBox = await midHit.boundingBox();
    assert.ok(midHitBox, 'midpoint hit target has a box');
    expect(midHitBox.width).toBeGreaterThanOrEqual(20);
    // Drawing handles while a replacement polygon is in progress.
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    const live = (await stage.boundingBox())!;
    await stage.click({ position: { x: Math.round(live.width * 0.3), y: Math.round(live.height * 0.3) } });
    await stage.click({ position: { x: Math.round(live.width * 0.7), y: Math.round(live.height * 0.3) } });
    const drawHit = workspace.locator('.product-setup-drawing circle[data-markhit]').first();
    const drawHitBox = await drawHit.boundingBox();
    assert.ok(drawHitBox, 'drawing handle hit target has a box');
    expect(drawHitBox.width).toBeGreaterThanOrEqual(20);
    await stage.press('Escape');
    await expect(workspace.getByText('Drawing cancelled; nothing was committed.')).toBeVisible();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('context-big-markers.png') });
    }

    // Narrow viewport: the same minimums hold (back in the anchor tool so
    // the interactive marker, not the reference dot, is measured; corner
    // handles were already proven at desktop scale above).
    await workspace.getByRole('button', { name: /^Anchor( \(\d+\))?$/ }).click();
    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(300);
    await markerMinimums();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('context-big-narrow.png') });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    await expect(probe.pageErrors).toEqual([]);
    await expect(probe.consoleErrors).toEqual([]);
    await expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
/** One product with two variants sharing one region (shared-region notice). */
async function sharedVariantFixture(png: Uint8Array): Promise<Uint8Array> {
  const project = {
    schemaVersion: '0.1.0-provisional',
    projectId: 'SYN-PROJ-CTX-SHARED',
    revision: 1,
    products: [{
      schemaVersion: '0.1.0-provisional',
      id: 'P-CTX-S',
      name: 'Shared product',
      kind: 'other',
      variants: [
        { id: 'P-CTX-S-A', regionIds: ['region-shared-1'] },
        { id: 'P-CTX-S-B', regionIds: ['region-shared-1'] },
      ],
      regions: [measuredRegion('region-shared-1', 'Shared chest', 'cal-shared-1')],
      calibrations: [{ id: 'cal-shared-1', version: '1', description: 'shared trial' }],
    }],
    logos: [],
    configurations: [
      { id: 'cfg-s-a', productId: 'P-CTX-S', variantId: 'P-CTX-S-A', placements: [] },
      { id: 'cfg-s-b', productId: 'P-CTX-S', variantId: 'P-CTX-S-B', placements: [] },
    ],
  };
  const mappingFor = (variantId: string) => ({
    productId: 'P-CTX-S',
    variantId,
    regionId: 'region-shared-1',
    view: 'front',
    image: 'presentation/front.png',
    transform: { a: 0.5 / 280, b: 0, c: 0.25, d: 0, e: -0.5 / 200, f: 0.75 },
    calibrationId: 'cal-shared-1',
    calibrationVersion: '1',
    status: 'provisional',
  });
  return createProjectPackage({
    project,
    assets: [],
    additionalAssets: [
      { path: 'presentation/front.png', bytes: png },
      {
        path: 'presentation/preview.json',
        bytes: new TextEncoder().encode(JSON.stringify({
          version: 2,
          views: ['P-CTX-S-A', 'P-CTX-S-B'].map((variantId) => ({
            productId: 'P-CTX-S', variantId, view: 'front', image: 'presentation/front.png',
          })),
        })),
      },
      {
        path: 'presentation/photo-mappings.json',
        bytes: new TextEncoder().encode(JSON.stringify({
          version: 1,
          mappings: [mappingFor('P-CTX-S-A'), mappingFor('P-CTX-S-B')],
        })),
      },
    ],
  }, { sha256 });
}

async function advancedCoords(workspace: ReturnType<Page['locator']>): Promise<string> {
  await workspace.locator('.product-setup-advanced summary').click();
  const text = await workspace.locator('.product-setup-advanced-list').first().textContent() ?? '';
  await workspace.locator('.product-setup-advanced summary').click();
  return text;
}

/** Precision inputs live under an opt-in disclosure on the selected row. */
async function openPrecision(workspace: ReturnType<Page['locator']>): Promise<void> {
  const summary = workspace.locator('.product-setup-precision > summary');
  if ((await summary.count()) === 0) return;
  const open = await summary.first().evaluate((element) => (element.closest('details') as HTMLDetailsElement).open);
  if (!open) await summary.first().click();
}

/** Corner handles sit anywhere in a tall scrolled workspace: center the
 *  handle in the viewport before clicking so the click point is on screen. */
async function clickVertex(workspace: ReturnType<Page['locator']>, index: number): Promise<void> {
  const handle = workspace.locator('.product-setup-vertex').nth(index);
  await handle.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await handle.click();
}

test('contextual workspace: unsaved drafts survive switches, precision, cancel, reimport, scoped saves', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openBuilder(browser);
  try {
    const fixturePath = info.outputPath('context-two-products.logo-project');
    await writeFile(fixturePath, Buffer.from(await twoProductFixture(
      await syntheticPngBytes(page, '#1d6f3a'),
      await syntheticPngBytes(page, '#6f1d3a'),
    )));
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await (await shown(page, 'source-file')).setInputFiles(fixturePath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded context-two-products.logo-project');
    const workspace = builder(page, 'product-workspace');
    const productSelect = builder(page, 'workspace-product');

    // Unsaved anchor on A, then on B; both survive the switches.
    const stage = workspace.locator('.product-setup-overlay').first();
    const tapCenter = async () => {
      const box = (await stage.boundingBox())!;
      await stage.click({ position: { x: Math.round(box.width * 0.5), y: Math.round(box.height * 0.5) } });
    };
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    await tapCenter();
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    await expect(workspace.getByText(/staged edits/)).toBeVisible();
    await productSelect.selectOption('P-CTX-B');
    await expect(workspace.locator('figcaption', { hasText: 'Chest B' })).toBeVisible();
    await tapCenter();
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    // Back on A: A's unsaved anchor restored, B's absent (per-scope drafts).
    await productSelect.selectOption('P-CTX-A');
    await expect(workspace.locator('figcaption', { hasText: 'Chest A' })).toBeVisible();
    let coords = await advancedCoords(workspace);
    expect(coords).toContain('Anchor 1');
    expect(coords).not.toContain('Chest B');
    // Back on B: B's own unsaved anchor restored.
    await productSelect.selectOption('P-CTX-B');
    coords = await advancedCoords(workspace);
    expect(coords).toContain('Anchor 1');
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('context-staged-b.png') });
    }

    // Selected anchor exposes name/remove/precision; invalid input recovers.
    await productSelect.selectOption('P-CTX-A');
    await workspace.locator('.product-setup-anchors circle.product-setup-dot').first().click();
    const nameInput = workspace.locator('[data-fkey^="psv-anchor-name-"]');
    await expect(nameInput).toBeVisible();
    const xInput = workspace.locator('[data-fkey^="psv-anchor-x-"]');
    const yInput = workspace.locator('[data-fkey^="psv-anchor-y-"]');
    await openPrecision(workspace);
    await expect(xInput).toBeVisible();
    await expect(yInput).toBeVisible();
    // Pick list collapses behind All-disclosures on selection.
    await expect(workspace.locator('summary', { hasText: 'All anchors' })).toBeVisible();
    await xInput.fill('37.5');
    await xInput.press('Tab');
    await expect(workspace.getByText('Moved anchor “Anchor 1”.')).toBeVisible();
    coords = await advancedCoords(workspace);
    expect(coords).toContain('37.5');
    // Chromium number inputs refuse typed letters, so drive the invalid
    // path the way a paste/autofill would: an unsanitary value commits
    // nothing and the old value is kept.
    await xInput.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = 'abc';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(workspace.getByText('Anchor not moved:')).toBeVisible();
    expect(await xInput.inputValue()).toBe('37.5');

    // Selected corner exposes precision + remove; invalid recovers.
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await clickVertex(workspace, 0);
    const cornerX = workspace.locator('[data-fkey^="psv-corner-x-"]');
    await openPrecision(workspace);
    await expect(cornerX).toBeVisible();
    await expect(workspace.locator('summary', { hasText: 'All corners' })).toBeVisible();
    await cornerX.evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = 'not-a-number';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(workspace.getByText('Corner not moved:')).toBeVisible();

    // Cancel drawing keeps the staged bucket intact.
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    const live = (await stage.boundingBox())!;
    await stage.click({ position: { x: Math.round(live.width * 0.3), y: Math.round(live.height * 0.3) } });
    await stage.click({ position: { x: Math.round(live.width * 0.7), y: Math.round(live.height * 0.3) } });
    await stage.press('Escape');
    await expect(workspace.getByText('Drawing cancelled; nothing was committed.')).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();

    // Async save lands on the clicked scope even when the operator switches
    // mid-save: B keeps its own unsaved anchor, A reports its own save.
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await productSelect.selectOption('P-CTX-B');
    await expect(workspace.getByText(/Saved .*Chest A/)).toBeVisible();
    coords = await advancedCoords(workspace);
    expect(coords).toContain('Anchor 1');
    expect(coords).not.toContain('37.5');
    await productSelect.selectOption('P-CTX-A');
    await expect(workspace.getByText('Matches the saved setup.')).toBeVisible();

    // Source reimport clears staged drafts: new unsaved edit, reopen file.
    // (Tool button carries its count once anchors exist.)
    await workspace.getByRole('button', { name: /^Anchor( \(\d+\))?$/, exact: false }).click();
    const fresh = (await stage.boundingBox())!;
    await stage.click({ position: { x: Math.round(fresh.width * 0.65), y: Math.round(fresh.height * 0.6) } });
    await expect(workspace.getByText(/Created “Anchor \d+”/)).toBeVisible();
    await (await shown(page, 'source-file')).setInputFiles(fixturePath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded context-two-products.logo-project');
    await expect(workspace.getByText('Matches the saved setup.')).toBeVisible();
    await expect(workspace.getByText('Anchors (0)')).toBeVisible();

    await expect(probe.pageErrors).toEqual([]);
    await expect(probe.consoleErrors).toEqual([]);
    await expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test('contextual workspace: variant switches restore drafts, shared effect stated at save', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openBuilder(browser);
  try {
    const fixturePath = info.outputPath('context-shared.logo-project');
    await writeFile(fixturePath, Buffer.from(await sharedVariantFixture(
      await syntheticPngBytes(page, '#1d3a6f', 400, 300),
    )));
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await (await shown(page, 'source-file')).setInputFiles(fixturePath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded context-shared.logo-project');
    const workspace = builder(page, 'product-workspace');
    const variantSelect = builder(page, 'workspace-variant');

    // Shared-region effect is explicit at the save control before saving.
    await expect(workspace.locator('.product-setup-shared-notice')).toContainText('spans 2 options');
    await expect(workspace.locator('.product-setup-shared-notice')).toContainText('anchors stay per option');

    // Unsaved anchor on variant A survives a round trip through B.
    const stage = workspace.locator('.product-setup-overlay').first();
    const tapCenter = async () => {
      const box = (await stage.boundingBox())!;
      await stage.click({ position: { x: Math.round(box.width * 0.5), y: Math.round(box.height * 0.5) } });
    };
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    await tapCenter();
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    await variantSelect.selectOption('P-CTX-S-B');
    await expect(workspace.getByText('Matches the saved setup.')).toBeVisible();
    await variantSelect.selectOption('P-CTX-S-A');
    const coords = await advancedCoords(workspace);
    expect(coords).toContain('Anchor 1');

    // Keyboard focus survives a move round trip: focus the selected marker,
    // nudge with an arrow key (refreshes), focus is restored by data-fkey.
    await workspace.locator('.product-setup-anchors circle.product-setup-dot').first().click();
    const marker = workspace.locator('.product-setup-anchor.is-selected');
    await expect(marker).toBeFocused();
    await marker.press('ArrowRight');
    await expect(workspace.getByText('Moved anchor “Anchor 1”.')).toBeVisible();
    await expect(workspace.locator('.product-setup-anchor.is-selected')).toBeFocused();
    const nameInput = workspace.locator('[data-fkey^="psv-anchor-name-"]');
    await nameInput.fill('Shared point');
    await nameInput.press('Tab');
    await expect(workspace.getByText('Renamed anchor to “Shared point”.')).toBeVisible();

    // Shared-region stale-draft guard (root repro): B stages an anchor; A
    // moves corner 1 and saves; B's anchor-only save must NOT revert A's
    // saved corner — the master keeps exact project geometry.
    await variantSelect.selectOption('P-CTX-S-B');
    await tapCenter();
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    await variantSelect.selectOption('P-CTX-S-A');
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await clickVertex(workspace, 0);
    await openPrecision(workspace);
    const sharedX = workspace.locator('[data-fkey^="psv-corner-x-"]');
    await sharedX.fill('25');
    await sharedX.press('Tab');
    await expect(workspace.getByText('Moved corner 1.')).toBeVisible();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .*Shared chest/)).toBeVisible();
    await variantSelect.selectOption('P-CTX-S-B');
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .*Shared chest/)).toBeVisible();
    const staleEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const staleMaster = await staleEvent;
    const stalePath = info.outputPath('context-shared-master.logo-project');
    await staleMaster.saveAs(stalePath);
    const staleParsed = await parseProjectPackage(new Uint8Array(await readFile(stalePath)), { sha256 });
    const staleRegion = staleParsed.project.products[0]!.regions[0]!;
    expect(staleRegion.safeArea[0]).toEqual([25, 0]);
    expect(staleRegion.safeArea).toHaveLength(4);

    // Conflicting staged areas: A stages a corner move (no save); B stages
    // a different move and saves; A's save is refused, A's edits are kept,
    // and the master keeps B's geometry. Reset recovers cleanly.
    await variantSelect.selectOption('P-CTX-S-A');
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await clickVertex(workspace, 1);
    await openPrecision(workspace);
    const conflictY = workspace.locator('[data-fkey^="psv-corner-y-"]');
    await conflictY.fill('50');
    await conflictY.press('Tab');
    await expect(workspace.getByText('Moved corner 2.')).toBeVisible();
    await variantSelect.selectOption('P-CTX-S-B');
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await clickVertex(workspace, 2);
    await openPrecision(workspace);
    const conflictX = workspace.locator('[data-fkey^="psv-corner-x-"]');
    await conflictX.fill('200');
    await conflictX.press('Tab');
    await expect(workspace.getByText('Moved corner 3.')).toBeVisible();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .*Shared chest/)).toBeVisible();
    await variantSelect.selectOption('P-CTX-S-A');
    await expect(workspace.locator('.product-setup-conflict')).toContainText('changed on another option');
    await expect(workspace.getByRole('button', { name: 'Save product setup' })).toBeDisabled();
    // Corner rows render in the safe-area tool: the staged Y=50 edit is intact.
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    const conflictCoords = await advancedCoords(workspace);
    expect(conflictCoords).toContain('50.0');
    const conflictEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const conflictMaster = await conflictEvent;
    const conflictPath = info.outputPath('context-conflict-master.logo-project');
    await conflictMaster.saveAs(conflictPath);
    const conflictParsed = await parseProjectPackage(new Uint8Array(await readFile(conflictPath)), { sha256 });
    const conflictRegion = conflictParsed.project.products[0]!.regions[0]!;
    expect(conflictRegion.safeArea[0]).toEqual([25, 0]);
    expect(conflictRegion.safeArea[2]).toEqual([200, 200]);
    expect(conflictRegion.safeArea[1]).toEqual([280, 0]);
    await workspace.getByRole('button', { name: 'Reset to saved' }).click();
    await expect(workspace.getByText('Matches the saved setup.')).toBeVisible();

    // Narrow viewport keeps the workspace usable.
    await page.setViewportSize({ width: 480, height: 900 });
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('context-narrow.png') });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    await expect(probe.pageErrors).toEqual([]);
    await expect(probe.consoleErrors).toEqual([]);
    await expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
