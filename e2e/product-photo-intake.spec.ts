// Tranche A acceptance (lead-owned): in-place side photos on an existing
// product, starting from the required core use case: a MODEL-ONLY product
// keeps its original GLB bytes while a front photo is attached to the SAME
// product. Then: add back in place → measure front + save an anchor (so a
// saved-anchors sidecar exists) → generate → attach left (generated outputs
// must go stale) → replace front (sidecar rides once, stale mapping
// retires, product/model/geometry untouched) → malformed rejected →
// regenerate BOTH customer formats with original/unrelated asset digest
// checks → narrow viewport → master reopen. Synthetic in-page PNGs and a
// minimal synthetic GLB only. Offline file://, zero console/page errors,
// zero HTTP(S) requests.

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { gotoBuilder, revealBuilderControl } from './helpers.js';

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

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

/** Minimal synthetic self-contained GLB (mirrors e2e/multiview-builder.spec.ts). */
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

async function checkAllBoxes(page: Page, listHook: string): Promise<void> {
  await (await shown(page, listHook)).locator('input[type="checkbox"]').evaluateAll((nodes) => {
    for (const node of nodes) {
      const box = node as HTMLInputElement;
      if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
}

test('in-place photos: model-only product keeps its GLB, add/replace sides, stale outputs, both formats', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();

    // Core use case: a MODEL-ONLY product first (no photo anywhere).
    const modelBytes = syntheticGlb();
    const modelDigest = digestOf(modelBytes);
    await (await shown(page, 'product-file')).setInputFiles({ name: 'shell.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(modelBytes) });
    await (await shown(page, 'product-name')).fill('Tranche A Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Tranche A Jacket');
    const workspace = builder(page, 'product-workspace');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toHaveCount(0);
    const productId: string = await builder(page, 'workspace-product').evaluate(
      (element) => (element as HTMLSelectElement).value,
    );
    assert.ok(productId.length > 0, 'workspace product must be selected');

    // Attach the front photo to the SAME model-only product (human names,
    // never raw IDs, in the hint and the acknowledgement).
    await (await shown(page, 'product-photo-side')).selectOption('front');
    await expect(await shown(page, 'product-photo-status')).toContainText('Tranche A Jacket');
    await expect(await shown(page, 'product-photo-status')).not.toContainText(productId);
    await expect(await shown(page, 'product-photo-status')).toContainText('has no photo yet — choosing a file adds it');
    const frontPng = await syntheticPngBytes(page, '#1d6f3a');
    const frontDigest = digestOf(frontPng);
    await (await shown(page, 'product-photo-file')).setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: Buffer.from(frontPng) });
    await expect(await shown(page, 'product-photo-status')).toContainText('Added Front photo to');
    await expect(await shown(page, 'product-photo-status')).toContainText('Tranche A Jacket');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    expect(await builder(page, 'workspace-product').evaluate(
      (element) => (element as HTMLSelectElement).options.length,
    )).toBe(1);
    expect(await builder(page, 'workspace-product').evaluate(
      (element) => (element as HTMLSelectElement).value,
    )).toBe(productId);

    // Add the back view to the same product as well.
    await (await shown(page, 'product-photo-side')).selectOption('back');
    const backPng = await syntheticPngBytes(page, '#6f1d3a');
    const backDigest = digestOf(backPng);
    await (await shown(page, 'product-photo-file')).setInputFiles({ name: 'back.png', mimeType: 'image/png', buffer: Buffer.from(backPng) });
    await expect(await shown(page, 'product-photo-status')).toContainText('Added Back photo to');
    await expect(workspace.getByRole('tab', { name: 'Back' })).toBeVisible();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('photo-intake-added-back.png') });
    }

    // Measure the front and save one anchor: this writes the saved-anchors
    // sidecar, which the replace below must carry exactly once.
    await workspace.getByRole('tab', { name: 'Front' }).click();
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    await expect(guided).toBeVisible();
    const overlay = guided.locator('.guided-scale-overlay');
    await expect(overlay).toBeVisible();
    const box = (await overlay.boundingBox())!;
    const corner = async (fx: number, fy: number) => {
      await overlay.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
    };
    await corner(0.25, 0.25);
    await corner(0.75, 0.25);
    await corner(0.75, 0.75);
    await corner(0.25, 0.75);
    await guided.locator('[data-guided="width"]').fill('280');
    await guided.locator('[data-guided="height"]').fill('200');
    await guided.locator('[data-guided="create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Measured the Front view: 280×200');
    const stage = workspace.locator('.product-setup-overlay').first();
    await workspace.getByRole('button', { name: 'Anchor', exact: true }).click();
    const stageBox = (await stage.boundingBox())!;
    await stage.click({ position: { x: Math.round(stageBox.width * 0.5), y: Math.round(stageBox.height * 0.5) } });
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 1 anchors\)/)).toBeVisible();

    // Generate a customer file now: the next attach must mark it stale.
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(frontPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await (await shown(page, 'builder-next')).click();
    await (await shown(page, 'customer-name')).fill('Tranche Customer');
    await (await shown(page, 'job-ref')).fill('TRANCHE-A-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('Customer file ready (revision 1)');
    await expect(await shown(page, 'download-package')).toBeEnabled();

    // Attaching the left photo invalidates the generated delivery: a regen
    // is required before any download.
    await (await shown(page, 'product-photo-side')).selectOption('left');
    const leftPng = await syntheticPngBytes(page, '#3a5a1d');
    await (await shown(page, 'product-photo-file')).setInputFiles({ name: 'left.png', mimeType: 'image/png', buffer: Buffer.from(leftPng) });
    await expect(await shown(page, 'product-photo-status')).toContainText('Added Left photo to');
    await expect(await shown(page, 'size-estimate')).toContainText('No issued package generated yet');
    await expect(await shown(page, 'download-package')).toBeDisabled();
    await expect(await shown(page, 'download-html')).toBeDisabled();

    // Replace the front with saved anchors present: the sidecar must ride
    // along exactly once (no duplicate-path rejection), the stale mapping
    // retires, and the superseded bytes stay in the package as evidence.
    await (await shown(page, 'step-choose')).click();
    await (await shown(page, 'product-photo-side')).selectOption('front');
    await expect(await shown(page, 'product-photo-status')).toContainText('already has a photo — choosing a file replaces it');
    const frontPng2 = await syntheticPngBytes(page, '#1d4a6f');
    const frontDigest2 = digestOf(frontPng2);
    await (await shown(page, 'product-photo-file')).setInputFiles({ name: 'front-v2.png', mimeType: 'image/png', buffer: Buffer.from(frontPng2) });
    await expect(await shown(page, 'product-photo-status')).toContainText('Replaced Front photo on');
    await expect(await shown(page, 'product-photo-status')).toContainText('1 photo mapping was retired');
    expect(await builder(page, 'workspace-product').evaluate(
      (element) => (element as HTMLSelectElement).value,
    )).toBe(productId);
    await workspace.getByRole('tab', { name: 'Front' }).click();
    await expect(workspace.getByText('has no scale mapping yet')).toBeVisible();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('photo-intake-replaced-front.png') });
    }

    // Malformed bytes are rejected; the prior project survives.
    await (await shown(page, 'product-photo-side')).selectOption('right');
    await (await shown(page, 'product-photo-file')).setInputFiles({ name: 'not-a-photo.png', mimeType: 'image/png', buffer: Buffer.from('this is not image bytes') });
    await expect(await shown(page, 'product-photo-status')).toContainText('Could not attach not-a-photo.png');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();

    // Regenerate BOTH customer formats; original and unrelated asset bytes
    // must be digest-identical, the superseded front photo retained.
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await (await shown(page, 'builder-next')).click();
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('Customer file ready (revision 1)');
    const baselineEvent = page.waitForEvent('download');
    await (await shown(page, 'download-baseline')).click();
    const baseline = await baselineEvent;
    const baselinePath = info.outputPath('photo-intake-issued.logo-project');
    await baseline.saveAs(baselinePath);
    const parsed = await parseProjectPackage(new Uint8Array(await readFile(baselinePath)), { sha256 });
    expect(parsed.project.products).toHaveLength(1);
    expect(parsed.project.products[0]!.id).toBe(productId);
    const assetDigest = (path: string): string | null => {
      const found = parsed.assets.find((asset) => asset.path === path);
      return found ? digestOf(found.bytes) : null;
    };
    const glbPath = parsed.assets.find((asset) => asset.path.endsWith('.glb'))?.path ?? null;
    assert.ok(glbPath, 'issued package must carry the original model');
    expect(assetDigest(glbPath)).toBe(modelDigest);
    const manifestRaw = parsed.assets.find((asset) => asset.path === 'presentation/preview.json');
    assert.ok(manifestRaw, 'issued package must carry the presentation manifest');
    const manifest = JSON.parse(Buffer.from(manifestRaw.bytes).toString('utf8')) as {
      version: number;
      views: Array<{ productId: string; view: string; image: string }>;
    };
    const ownViews = manifest.views.filter((entry) => entry.productId === productId);
    expect(ownViews.map((entry) => entry.view).sort()).toEqual(['back', 'front', 'left']);
    const frontView = ownViews.find((entry) => entry.view === 'front')!;
    const backView = ownViews.find((entry) => entry.view === 'back')!;
    // Replacement minted a FRESH path: the live front bytes are v2, and the
    // original front bytes survive untouched at their original path.
    expect(assetDigest(frontView.image)).toBe(frontDigest2);
    expect(frontView.image).not.toBe(backView.image);
    const supersededOriginal = parsed.assets.find((asset) => digestOf(asset.bytes) === frontDigest);
    assert.ok(supersededOriginal, 'superseded front photo bytes must be retained as evidence');
    expect(assetDigest(backView.image)).toBe(backDigest);
    const mappingsRaw = parsed.assets.find((asset) => asset.path === 'presentation/photo-mappings.json');
    const mappings = mappingsRaw
      ? JSON.parse(Buffer.from(mappingsRaw.bytes).toString('utf8')) as { mappings: Array<{ view: string; image: string }> }
      : { mappings: [] };
    expect(mappings.mappings.filter((entry) => entry.view === 'front')).toHaveLength(0);
    // The staff anchors sidecar is working state: it rides the master, not
    // the issued customer baseline. Its survival is asserted on the master
    // below; the replace succeeding at all (with the sidecar present) is
    // the duplicate-path regression.
    const htmlEvent = page.waitForEvent('download');
    await (await shown(page, 'download-package')).click();
    const html = await htmlEvent;
    assert.ok(html.suggestedFilename().endsWith('.html'), 'self-contained customer file downloads');
    await html.saveAs(info.outputPath('photo-intake-customer.html'));
    await (await shown(page, 'step-details')).click();
    await (await shown(page, 'format-hybrid')).check();
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('Customer file ready (revision 1)');
    const zipEvent = page.waitForEvent('download');
    await (await shown(page, 'download-package')).click();
    const zip = await zipEvent;
    const zipPath = info.outputPath('photo-intake-hybrid.zip');
    await zip.saveAs(zipPath);
    const entries = unzipSync(new Uint8Array(await readFile(zipPath)));
    expect(Object.keys(entries).sort()).toEqual(['OPEN_LOGO_CONFIGURATOR.html', 'TRANCHE-A-01.logo-project']);

    // Narrow viewport: the disclosure stays usable on small screens.
    await page.setViewportSize({ width: 480, height: 900 });
    await (await shown(page, 'step-choose')).click();
    await (await shown(page, 'product-photo-side')).selectOption('right');
    await expect(await shown(page, 'product-photo-status')).toContainText('has no photo yet');
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('photo-intake-narrow.png') });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // Master roundtrip: same product, all three views, GLB intact.
    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master = await masterEvent;
    const masterPath = info.outputPath('photo-intake-master.logo-project');
    await master.saveAs(masterPath);
    const masterParsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    expect(masterParsed.project.products).toHaveLength(1);
    expect(masterParsed.project.products[0]!.id).toBe(productId);
    const masterGlb = masterParsed.assets.find((asset) => asset.path.endsWith('.glb'));
    assert.ok(masterGlb, 'master must carry the original model');
    expect(digestOf(masterGlb.bytes)).toBe(modelDigest);
    const masterSidecarRaw = masterParsed.assets.find((asset) => asset.path === 'presentation/operation-anchors.json');
    assert.ok(masterSidecarRaw, 'master must carry the saved anchors sidecar through the replace');
    const masterSidecar = JSON.parse(Buffer.from(masterSidecarRaw.bytes).toString('utf8')) as { anchors: Array<{ name: string }> };
    expect(masterSidecar.anchors.map((anchor) => anchor.name)).toEqual(['Anchor 1']);
    await (await shown(page, 'source-file')).setInputFiles(masterPath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded photo-intake-master.logo-project');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    await expect(workspace.getByRole('tab', { name: 'Back' })).toBeVisible();
    expect(await builder(page, 'workspace-product').evaluate(
      (element) => (element as HTMLSelectElement).value,
    )).toBe(productId);

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
