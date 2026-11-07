// Station intake UX acceptance (Worker 2): explicit Images/3D toggle with
// only the relevant fields, dynamic named view rows (free labels, unbounded
// count, stable ids), one prominent "Add product and set up" with gating,
// a single inviting empty-state intake block, and automatic workspace focus
// on success. In-place named rows on existing products: legacy side keys
// keep the proven planner path (replace/add/stale/master roundtrips); new
// slug views commit through the local narrow path. Flexible views flow end
// to end via the v3 manifest, workspace tabs, calibration sidecars, mappings,
// master reopen, both customer deliveries and the operation document; the
// five-view journey below covers calibrate, save, replace, reopen, issue,
// customer placement and review agreement on the real station. Synthetic
// synthetic legacy-side package built from createProvisionalProduct only.
// Offline file://, zero console/page errors, zero HTTP(S) requests.

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { createProvisionalProduct } from '../src/core/project-builder/provisional-product.js';
import type { ProjectDocument } from '../src/core/types.js';
import { SCHEMA_VERSION } from '../src/core/types.js';
import { gotoBuilder, revealBuilderControl, revealCustomerControl, selectCustomerOption } from './helpers.js';

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

/** Scope for the optional customer-approval branch UI (§7 of the UX spec). */
function approval(page: Page) {
  return page.locator('[data-customer-approval]');
}

/** Enter the approval branch from placements and issue the current job
 * (branch-scoped buttons only: legacy generate/download hooks are gone). */
async function createBranchIssue(page: Page): Promise<string> {
  await (await shown(page, 'job-to-placements')).click();
  await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
  await builder(page, 'job-placement-host').getByRole('button', { name: 'Send for customer approval' }).click();
  await expect(approval(page)).toBeVisible();
  await (await shown(page, 'job-issue-project-new')).click();
  const issueId = await builder(page, 'job-issue-project-id').inputValue();
  expect(issueId.length).toBeGreaterThan(0);
  await approval(page).getByRole('button', { name: 'Create customer file', exact: true }).click();
  await expect(approval(page)).toContainText('Customer file created');
  return issueId;
}

/** Re-enter the visible approval branch (issue state preserved). */
async function reopenApprovalBranch(page: Page): Promise<void> {
  await page.locator('[data-builder-hook="job-step-2"]').click();
  await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
  await builder(page, 'job-placement-host').getByRole('button', { name: 'Send for customer approval' }).click();
  await expect(approval(page)).toBeVisible();
}

/** Open a file through a branch button (real file-chooser wiring). */
async function branchOpenFile(
  page: Page,
  buttonName: 'Open office copy' | 'Open customer response',
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  await Promise.all([
    page.waitForEvent('filechooser').then((chooser) => chooser.setFiles({
      name: fileName, mimeType: 'application/zip', buffer: Buffer.from(bytes),
    })),
    approval(page).getByRole('button', { name: buttonName }).click(),
  ]);
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

/** Synthetic legacy-side package (single front view) for in-place rows. */
async function legacyFrontPackage(png: Uint8Array): Promise<{ bytes: Uint8Array; productId: string; variantId: string }> {
  const made = createProvisionalProduct({ id: 'legacy-jacket', name: 'Legacy Jacket', kind: 'other' });
  assert.ok(made.ok, 'provisional product must mint');
  const product = JSON.parse(JSON.stringify(made.product)) as ProjectDocument['products'][number];
  const variantId = product.variants[0]!.id;
  const project: ProjectDocument = {
    schemaVersion: SCHEMA_VERSION,
    projectId: 'legacy-intake-fixture',
    revision: 1,
    products: [product],
    logos: [],
    configurations: [{ id: 'builder-config-legacy-jacket', productId: product.id, variantId, placements: [] }],
  };
  const imagePath = 'presentation/legacy-jacket/front.png';
  const manifest = {
    version: 2,
    views: [{ productId: product.id, variantId, view: 'front', image: imagePath, label: 'Front view' }],
  };
  const bytes = await createProjectPackage({
    project,
    assets: [],
    additionalAssets: [
      { path: 'presentation/preview.json', bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
      { path: imagePath, bytes: png },
    ],
  }, { sha256 });
  return { bytes, productId: product.id, variantId };
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

test('station intake: named views, gating, single empty state, workspace focus', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openBuilder(browser);
  let dialogCount = 0;
  page.on('dialog', async (dialog) => { dialogCount += 1; await dialog.dismiss(); });
  try {
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();

    // Single inviting intake block: no duplicated "workspace stays empty" text.
    await expect(await shown(page, 'add-product-summary')).toContainText('Add a product');
    await expect(page.locator('body')).not.toContainText('The workspace stays empty until then');
    const addButton = await shown(page, 'product-add');
    await expect(addButton).toContainText('Add product and set up');
    await expect(addButton).toBeDisabled();
    await expect(await shown(page, 'product-status')).toContainText('Choose at least one view image');

    // Explicit Images/3D toggle: Images by default, only relevant fields shown.
    await expect(await shown(page, 'intake-mode-images')).toBeChecked();
    await expect(page.locator('[data-builder-hook="intake-images-panel"]')).toBeVisible();
    await expect(page.locator('[data-builder-hook="intake-model-panel"]')).toBeHidden();

    // Keyboard toggle between modes (real arrow-key radio interaction).
    await (await shown(page, 'intake-mode-images')).focus();
    await page.keyboard.press('ArrowRight');
    await expect(await shown(page, 'intake-mode-model')).toBeChecked();
    await expect(page.locator('[data-builder-hook="intake-model-panel"]')).toBeVisible();
    await expect(page.locator('[data-builder-hook="intake-images-panel"]')).toBeHidden();
    await page.keyboard.press('ArrowLeft');
    await expect(await shown(page, 'intake-mode-images')).toBeChecked();

    // Both staging paths survive toggles. Add uses only the active mode.
    await (await shown(page, 'intake-mode-model')).check();
    const modelBytes = syntheticGlb();
    await (await shown(page, 'product-file')).setInputFiles({ name: 'shell.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(modelBytes) });
    await expect(await shown(page, 'intake-model-status')).toContainText('ready');
    await expect(addButton).toBeEnabled();
    await (await shown(page, 'intake-mode-images')).click();
    await expect(await shown(page, 'intake-mode-images')).toBeChecked();
    await expect(builder(page, 'intake-model-status')).toContainText('ready');
    await expect(addButton).toBeDisabled();
    await (await shown(page, 'intake-mode-model')).check();
    await expect(addButton).toBeEnabled();
    await expect(builder(page, 'intake-model-status')).toContainText('shell.glb ready');
    await (await shown(page, 'intake-mode-images')).click();
    expect(dialogCount).toBe(0);

    const labels = ['Crown', 'Sleeve', 'Main view', 'Cuff', 'Hood'];
    const fills = ['#1d6f3a', '#6f1d3a', '#3a5a1d', '#1d4a6f', '#5a1d6f'];
    for (let index = 1; index < labels.length; index += 1) {
      await (await shown(page, 'product-view-add')).click();
    }
    expect(await page.locator('[data-view-row]').count()).toBe(5);
    for (let index = 0; index < labels.length; index += 1) {
      await page.locator('[data-builder-hook="product-view-rows"] input[type="text"]').nth(index).fill(labels[index]!);
      const png = await syntheticPngBytes(page, fills[index]);
      await page.locator('[data-builder-hook="product-view-rows"] input[type="file"]').nth(index)
        .setInputFiles({ name: `${labels[index]!.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, mimeType: 'image/png', buffer: Buffer.from(png) });
      await expect(page.locator('[data-view-row]').nth(index).locator('.view-row-state')).toContainText('ready');
    }
    await expect(addButton).toBeEnabled();
    await expect(await shown(page, 'product-status')).toContainText('“Crown”');

    // A sixth row can be added and removed again (row count is unbounded).
    await (await shown(page, 'product-view-add')).click();
    expect(await page.locator('[data-view-row]').count()).toBe(6);
    await page.locator('[data-view-row]').nth(5).getByRole('button', { name: /Remove/ }).click();
    expect(await page.locator('[data-view-row]').count()).toBe(5);
    await expect(addButton).toBeEnabled();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('photo-intake-intake.png') });
    }

    // Create: one prominent action, correct product selected, focus moves to
    // the calibration workspace. Focus is asserted before any later helper
    // call reopens the disclosure (reveal focuses summaries to open them).
    await (await shown(page, 'product-name')).fill('Named Views Jacket');
    await addButton.click();
    // Plain locator (no reveal): the success closes the intake disclosure and
    // the assertion must not reopen/refocus it before the focus check below.
    await expect(builder(page, 'product-status')).toContainText('Added preview-only product Named Views Jacket (5 view');
    const productId: string = await builder(page, 'workspace-product').evaluate(
      (element) => (element as HTMLSelectElement).value,
    );
    assert.ok(productId.length > 0, 'workspace product must be selected');
    const focusedInWorkspace = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof Element)) return 'none';
      if (active.getAttribute('data-builder-hook') === 'workspace-product') return 'workspace-product';
      const box = document.querySelector('[data-builder-hook="product-workspace"]');
      return box !== null && box.contains(active) ? 'workspace-box' : active.tagName;
    });
    assert.ok(
      focusedInWorkspace === 'workspace-product' || focusedInWorkspace === 'workspace-box',
      `focus must move into the setup workspace on success (was: ${focusedInWorkspace})`,
    );
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('photo-intake-setup.png') });
    }

    // Adding a logo never obscures the intake/create state.
    const crestPng = await syntheticPngBytes(page, '#8a6d1d');
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Named Views Jacket');
    await expect(await shown(page, 'add-product-summary')).toContainText('Add another product');

    // Master bytes: five manifest views with stable ids distinct from labels.
    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master = await masterEvent;
    const masterPath = info.outputPath('photo-intake-master.logo-project');
    await master.saveAs(masterPath);
    const parsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    expect(parsed.project.products).toHaveLength(1);
    expect(parsed.project.products[0]!.id).toBe(productId);
    const manifestRaw = parsed.assets.find((asset) => asset.path === 'presentation/preview.json');
    assert.ok(manifestRaw, 'master must carry the presentation manifest');
    const manifest = JSON.parse(Buffer.from(manifestRaw.bytes).toString('utf8')) as {
      version: number;
      views: Array<{ productId: string; view: string; image: string; label?: string }>;
    };
    expect(manifest.views).toHaveLength(5);
    expect(manifest.views.map((entry) => entry.label)).toEqual(labels);
    const ids = manifest.views.map((entry) => entry.view);
    expect(new Set(ids).size).toBe(5);
    for (const entry of manifest.views) {
      assert.ok(entry.label !== undefined && entry.label !== entry.view, 'stable id must differ from the mutable label');
      assert.ok(parsed.assets.some((asset) => asset.path === entry.image), `image bytes must ship for ${entry.image}`);
    }

    // Narrow viewport: intake stays usable on small screens.
    await page.setViewportSize({ width: 480, height: 900 });
    await expect(await shown(page, 'add-product-summary')).toContainText('Add another product');
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('photo-intake-narrow.png') });
    }

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test('station intake: 3D model flow hides photo UI', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openBuilder(browser);
  try {
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();

    await (await shown(page, 'intake-mode-model')).check();
    await expect(page.locator('[data-builder-hook="intake-model-panel"]')).toBeVisible();
    await expect(page.locator('[data-builder-hook="intake-images-panel"]')).toBeHidden();
    const modelBytes = syntheticGlb();
    await (await shown(page, 'product-file')).setInputFiles({ name: 'shell.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(modelBytes) });
    await expect(await shown(page, 'intake-model-status')).toContainText('ready');
    await expect(await shown(page, 'product-add')).toBeEnabled();
    await (await shown(page, 'product-name')).fill('Model Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Model Jacket');
    await expect(await shown(page, 'product-status')).toContainText('3D model (all viewpoints included)');

    // Model-only products never show photo UI: the in-place disclosure hides.
    await expect(page.locator('[data-builder-hook="product-photo-disclosure"]')).toBeHidden();

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test('in-place named rows: legacy views keep working, slug views at byte level', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openBuilder(browser);
  try {
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();

    // Legacy-side package in: the in-place disclosure lists named rows.
    const frontPng = await syntheticPngBytes(page, '#1d6f3a');
    const frontDigest = digestOf(frontPng);
    const legacy = await legacyFrontPackage(frontPng);
    await (await shown(page, 'job-open-file')).setInputFiles({ name: 'legacy-front.logo-project', mimeType: 'application/zip', buffer: Buffer.from(legacy.bytes) });
    await expect(await shown(page, 'source-status')).toContainText('Loaded legacy-front.logo-project');
    await expect(page.locator('[data-in-place-view="front"] .view-row-name')).toHaveValue('Front view');
    await expect(await shown(page, 'product-photo-context')).toContainText('Legacy Jacket');
    const workspace = builder(page, 'product-workspace');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    expect(await builder(page, 'workspace-product').evaluate(
      (element) => (element as HTMLSelectElement).options.length,
    )).toBe(1);

    // Measure the front and save one anchor: the replace below must retire
    // exactly this mapping while the superseded bytes stay as evidence.
    await workspace.getByRole('tab', { name: 'Front' }).click();
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    await expect(guided).toBeVisible();
    const overlay = guided.locator('.guided-scale-overlay[aria-label*="rectangle corners"]');
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

    // Generate a customer file now: the replace below must mark it stale.
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(frontPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await (await shown(page, 'job-step-1')).click();
    await (await shown(page, 'customer-name')).fill('Legacy Customer');
    await (await shown(page, 'job-ref')).fill('LEGACY-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await createBranchIssue(page);
    await expect(approval(page).getByRole('button', { name: 'Save customer file', exact: true })).toBeEnabled();

    // Replace the front through its named row: mapping retires, outputs stale.
    await (await shown(page, 'job-step-1')).click();
    const frontPng2 = await syntheticPngBytes(page, '#1d4a6f');
    const frontDigest2 = digestOf(frontPng2);
    await page.locator('[data-in-place-view="front"] input[type="file"]')
      .setInputFiles({ name: 'front-v2.png', mimeType: 'image/png', buffer: Buffer.from(frontPng2) });
    await expect(await shown(page, 'product-photo-status')).toContainText('Replaced Front photo on');
    await expect(await shown(page, 'product-photo-status')).toContainText('1 photo mapping was retired');
    // Asset-only change: the filed issue is retained as the review baseline
    // (branch staleness tracks project text, not photo bytes); a fresh issue
    // ID picks up the replacement photo below.
    await reopenApprovalBranch(page);
    await expect(approval(page)).toContainText('Customer file created');
    await (await shown(page, 'job-step-1')).click();
    await workspace.getByRole('tab', { name: 'Front' }).click();
    await expect(workspace.getByText('has no scale mapping yet')).toBeVisible();
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('photo-intake-replaced-front.png') });
    }

    // Malformed bytes are rejected; the prior project survives.
    await page.locator('[data-in-place-view="front"] input[type="file"]')
      .setInputFiles({ name: 'not-a-photo.png', mimeType: 'image/png', buffer: Buffer.from('this is not image bytes') });
    await expect(await shown(page, 'product-photo-status')).toContainText('Could not attach not-a-photo.png');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();

    // Regenerate BOTH customer formats; superseded bytes stay as evidence.
    // Content changed since the last issue, so mint a fresh issue ID first.
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await (await shown(page, 'job-step-1')).click();
    await reopenApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    await approval(page).getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(approval(page)).toContainText('Customer file created');
    const baselineEvent = page.waitForEvent('download');
    await approval(page).getByRole('button', { name: 'Save office copy', exact: true }).click();
    const baseline = await baselineEvent;
    const baselinePath = info.outputPath('photo-intake-issued.logo-project');
    await baseline.saveAs(baselinePath);
    const parsed = await parseProjectPackage(new Uint8Array(await readFile(baselinePath)), { sha256 });
    expect(parsed.project.products).toHaveLength(1);
    expect(parsed.project.products[0]!.id).toBe(legacy.productId);
    const assetDigest = (path: string): string | null => {
      const found = parsed.assets.find((asset) => asset.path === path);
      return found ? digestOf(found.bytes) : null;
    };
    const glbPath = parsed.assets.find((asset) => asset.path.endsWith('.glb'))?.path ?? null;
    assert.ok(glbPath === null, 'Images product must not carry a model');
    const manifestRaw = parsed.assets.find((asset) => asset.path === 'presentation/preview.json');
    assert.ok(manifestRaw, 'issued package must carry the presentation manifest');
    const manifest = JSON.parse(Buffer.from(manifestRaw.bytes).toString('utf8')) as {
      version: number;
      views: Array<{ productId: string; view: string; image: string }>;
    };
    const ownViews = manifest.views.filter((entry) => entry.productId === legacy.productId);
    expect(ownViews.map((entry) => entry.view)).toEqual(['front']);
    expect(assetDigest(ownViews[0]!.image)).toBe(frontDigest2);
    const supersededOriginal = parsed.assets.find((asset) => digestOf(asset.bytes) === frontDigest);
    assert.ok(supersededOriginal, 'superseded front photo bytes must be retained as evidence');
    const mappingsRaw = parsed.assets.find((asset) => asset.path === 'presentation/photo-mappings.json');
    const mappings = mappingsRaw
      ? JSON.parse(Buffer.from(mappingsRaw.bytes).toString('utf8')) as { mappings: Array<{ view: string; image: string }> }
      : { mappings: [] };
    expect(mappings.mappings.filter((entry) => entry.view === 'front')).toHaveLength(0);
    const htmlEvent = page.waitForEvent('download');
    await approval(page).getByRole('button', { name: 'Save customer file', exact: true }).click();
    const html = await htmlEvent;
    assert.ok(html.suggestedFilename().endsWith('.html'), 'self-contained customer file downloads');
    await html.saveAs(info.outputPath('photo-intake-customer.html'));
    // The earlier issue helper already revealed More options: only open it
    // when closed, never blind-toggle it shut before using its controls.
    const hybridOptions = approval(page).locator('details', { hasText: 'More options' });
    if (!await hybridOptions.evaluate((element) => (element as HTMLDetailsElement).open)) {
      await approval(page).locator('summary', { hasText: 'More options' }).click();
    }
    await approval(page).getByRole('radio', { name: 'ZIP file with the setup files inside' }).check();
    await approval(page).getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(approval(page)).toContainText('Customer file created');
    const zipEvent = page.waitForEvent('download');
    await approval(page).getByRole('button', { name: 'Save customer file', exact: true }).click();
    const zip = await zipEvent;
    const zipPath = info.outputPath('photo-intake-hybrid.zip');
    await zip.saveAs(zipPath);
    const entries = unzipSync(new Uint8Array(await readFile(zipPath)));
    expect(Object.keys(entries).sort()).toEqual(['LEGACY-01.logo-project', 'OPEN_LOGO_CONFIGURATOR.html']);

    // Master roundtrip: the saved anchors sidecar rides the replace.
    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master = await masterEvent;
    const masterPath = info.outputPath('photo-intake-master.logo-project');
    await master.saveAs(masterPath);
    const masterParsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    expect(masterParsed.project.products).toHaveLength(1);
    expect(masterParsed.project.products[0]!.id).toBe(legacy.productId);
    const masterSidecarRaw = masterParsed.assets.find((asset) => asset.path === 'presentation/operation-anchors.json');
    assert.ok(masterSidecarRaw, 'master must carry the saved anchors sidecar through the replace');
    const masterSidecar = JSON.parse(Buffer.from(masterSidecarRaw.bytes).toString('utf8')) as { anchors: Array<{ name: string }> };
    expect(masterSidecar.anchors.map((anchor) => anchor.name)).toEqual(['Anchor 1']);
    await (await shown(page, 'job-open-file')).setInputFiles(masterPath);
    // Unsaved edits are held by the retained replacement guard (Journey E):
    // Discard reproduces the old silent replace before asserting the reopen.
    await expect(builder(page, 'builder-alert')).toContainText('unsaved changes');
    await builder(page, 'builder-alert').getByRole('button', { name: 'Discard changes' }).click();
    await expect(await shown(page, 'source-status')).toContainText('Loaded photo-intake-master.logo-project');
    await expect(page.locator('[data-in-place-view="front"] .view-row-name')).toHaveValue('Front view');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();

    // Slug views: the add row names a new view, committed at byte level.
    // (Display of slug views in workspace tabs needs the downstream reader
    // generalization; asserted here on status + manifest bytes.)
    const crownPng = await syntheticPngBytes(page, '#8a1d6f');
    await (await shown(page, 'product-photo-new-label')).fill('Crown');
    await page.locator('[data-builder-hook="product-photo-add-file"]')
      .setInputFiles({ name: 'crown.png', mimeType: 'image/png', buffer: Buffer.from(crownPng) });
    await expect(await shown(page, 'product-photo-status')).toContainText('Added view image “Crown”');
    // Reopening the master reset the deliberate selection: re-check the
    // catalogue so the placements step (and the branch behind it) unlocks.
    // The reopened job differs from the filed issue, so the branch reports
    // the filed files stale.
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await reopenApprovalBranch(page);
    await expect(approval(page)).toContainText('Previously saved files are stale');
    const masterEvent2 = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master2 = await masterEvent2;
    const masterPath2 = info.outputPath('photo-intake-master-slug.logo-project');
    await master2.saveAs(masterPath2);
    const slugBytes = new Uint8Array(await readFile(masterPath2));
    const slugEntries = unzipSync(slugBytes);
    const slugManifestRaw = slugEntries['presentation/preview.json'];
    assert.ok(slugManifestRaw, 'master must carry the presentation manifest');
    const slugManifest = JSON.parse(Buffer.from(slugManifestRaw).toString('utf8')) as {
      version: number;
      views: Array<{ productId: string; view: string; image: string; label?: string }>;
    };
    const crownEntry = slugManifest.views.find((entry) => entry.label === 'Crown');
    assert.ok(crownEntry, 'slug view label must ship in the package');
    assert.ok(crownEntry.view !== 'Crown', 'slug view id must differ from its label');
    const frontEntry = slugManifest.views.find((entry) => entry.view === 'front');
    assert.ok(frontEntry, 'legacy front view must survive the slug add');
    if (info.project.name === 'chromium') {
      await page.setViewportSize({ width: 480, height: 900 });
      await (await shown(page, 'job-step-1')).click();
      await expect(page.locator('[data-builder-hook="product-photo-disclosure"]')).toBeVisible();
      await page.screenshot({ path: info.outputPath('photo-intake-narrow.png') });
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test('five named views calibrate, save, reopen, issue, customer places, review agrees', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const { context, page, probe } = await openBuilder(browser);
  const directory = await mkdtemp(join(tmpdir(), 'LogoTool five named views '));
  try {
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();

    // Five freely named views through the real intake rows.
    const labels = ['Crown', 'Sleeve', 'Main view', 'Cuff', 'Hood'];
    const fills = ['#1d6f3a', '#6f1d3a', '#3a5a1d', '#1d4a6f', '#5a1d6f'];
    for (let index = 1; index < labels.length; index += 1) {
      await (await shown(page, 'product-view-add')).click();
    }
    for (let index = 0; index < labels.length; index += 1) {
      const png = await syntheticPngBytes(page, fills[index], 400, 300);
      const row = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]').nth(index);
      await row.locator('input[type="text"]').fill(labels[index]!);
      await row.locator('input[type="file"]').setInputFiles({ name: `${labels[index]!.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, mimeType: 'image/png', buffer: Buffer.from(png) });
      await expect(row.locator('.view-row-state')).toContainText('ready');
    }
    await (await shown(page, 'product-name')).fill('Five View Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(builder(page, 'product-status')).toContainText('Added preview-only product Five View Jacket (5 views');
    const productId: string = await builder(page, 'workspace-product').evaluate(
      (element) => (element as HTMLSelectElement).value,
    );
    assert.ok(productId.length > 0, 'workspace product must be selected');

    // All five tabs exist, keyed by stable ids, labelled by human names.
    const workspace = builder(page, 'product-workspace');
    for (const [index, label] of labels.entries()) {
      await expect(workspace.getByRole('tab', { name: label })).toBeVisible();
      await expect(workspace.locator(`[data-fkey="psv-tab-view-${index + 1}"]`)).toBeVisible();
    }

    // Calibrate two of the five views with the real guided rectangle flow.
    for (const label of ['Crown', 'Sleeve']) {
      await workspace.getByRole('tab', { name: label }).click();
      await workspace.getByRole('button', { name: 'Set up scale' }).click();
      const guided = builder(page, 'guided-scale');
      await expect(guided).toBeVisible();
      const overlay = guided.locator('.guided-scale-overlay[aria-label*="rectangle corners"]');
      const overlayBox = (await overlay.boundingBox())!;
      const corner = async (fx: number, fy: number) => {
        await overlay.click({ position: { x: Math.round(overlayBox.width * fx), y: Math.round(overlayBox.height * fy) } });
      };
      await corner(0.25, 0.25);
      await corner(0.75, 0.25);
      await corner(0.75, 0.75);
      await corner(0.25, 0.75);
      await guided.locator('[data-guided="width"]').fill('280');
      await guided.locator('[data-guided="height"]').fill('200');
      await guided.locator('[data-guided="create"]').click();
      await expect(await shown(page, 'workspace-status')).toContainText(`Measured the ${label} view: 280×200`);
      await workspace.getByRole('button', { name: 'Save product setup' }).click();
      await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
    }

    // Replacing one view retires only its evidence: Crown and Sleeve stay
    // measured, and the Cuff label survives on its new photo.
    const cuffPng = await syntheticPngBytes(page, '#888811', 400, 300);
    await page.locator('[data-in-place-view="view-4"] input[type="file"]').setInputFiles({ name: 'cuff-v2.png', mimeType: 'image/png', buffer: Buffer.from(cuffPng) });
    await expect(await shown(page, 'product-photo-status')).toContainText('Replaced view image \u201cCuff\u201d on');
    await workspace.getByRole('tab', { name: 'Crown' }).click();
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    await workspace.getByRole('tab', { name: 'Sleeve' }).click();
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    await workspace.getByRole('tab', { name: 'Cuff' }).click();
    await expect(workspace.getByText('has no scale mapping yet')).toBeVisible();

    // Rename the measured Crown view after creation: issue a delivery first
    // (zero-logo issues are valid), then rename through the real in-place
    // row. Id, image bytes, calibration, anchors and safe areas must stay
    // stable; only the label changes. The crest logo is uploaded before the
    // rename (regression order): the rename roundtrip compares canonical
    // project text, so the logo import key order cannot trip it.
    await (await shown(page, 'job-step-1')).click();
    await (await shown(page, 'customer-name')).fill('Five Views Customer');
    await (await shown(page, 'job-ref')).fill('FIVE-00');
    await (await shown(page, 'issued-by')).fill('Lead check');
    // Uploaded before the rename; auto-selected for the FIVE-01 issue below.
    const crestPng = await syntheticPngBytes(page, '#8a6d1d');
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await createBranchIssue(page);
    await expect(approval(page).getByRole('button', { name: 'Save customer file', exact: true })).toBeEnabled();
    await (await shown(page, 'job-step-1')).click();
    const crownRow = page.locator('[data-in-place-view="view-1"]');
    await crownRow.locator('input[type="text"]').fill('Crown front');
    await crownRow.getByRole('button', { name: 'Rename view Crown' }).click();
    await expect(await shown(page, 'product-photo-status')).toContainText('Renamed view image to \u201cCrown front\u201d');
    // Manifest-only change: the filed issue is retained, not invalidated.
    await reopenApprovalBranch(page);
    await expect(approval(page)).toContainText('Customer file created');
    await (await shown(page, 'job-step-1')).click();
    // Tab, hook and calibration follow the stable id: the label changes, the
    // measurements do not.
    await expect(workspace.getByRole('tab', { name: 'Crown front' })).toBeVisible();
    await expect(workspace.locator('[data-fkey="psv-tab-view-1"]')).toBeVisible();
    await workspace.getByRole('tab', { name: 'Crown front' }).click();
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    const renamedLabels = ['Crown front', 'Sleeve', 'Main view', 'Cuff', 'Hood'];

    // Save the master: five named views, two measured regions + mappings.
    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master = await masterEvent;
    const masterPath = join(directory, 'five-views-master.logo-project');
    await master.saveAs(masterPath);
    const masterBytes = new Uint8Array(await readFile(masterPath));
    const parsedMaster = await parseProjectPackage(masterBytes, { sha256 });
    const masterManifest = JSON.parse(Buffer.from(parsedMaster.assets.find((asset) => asset.path === 'presentation/preview.json')!.bytes).toString('utf8')) as {
      version: number;
      views: Array<{ productId: string; view: string; image: string; label?: string }>;
    };
    expect(masterManifest.version).toBe(3);
    expect(masterManifest.views).toHaveLength(5);
    expect(new Set(masterManifest.views.map((entry) => entry.view)).size).toBe(5);
    expect(masterManifest.views.map((entry) => entry.label)).toEqual(renamedLabels);
    const masterMappings = JSON.parse(Buffer.from(parsedMaster.assets.find((asset) => asset.path === 'presentation/photo-mappings.json')!.bytes).toString('utf8')) as {
      mappings: Array<{ regionId: string; viewId?: string; image: string }>;
    };
    expect(masterMappings.mappings).toHaveLength(2);
    expect(new Set(masterMappings.mappings.map((entry) => entry.viewId)).size).toBe(2);
    const masterProduct = parsedMaster.project.products[0]!;
    expect(masterProduct.regions.map((entry) => entry.id).sort()).toEqual(['region-visual-1', 'region-visual-2']);
    // Exact ids and measurement data survive the rename: same image path,
    // same 4-corner safe polygon, same mapping count.
    const crownEntry = masterManifest.views.find((entry) => entry.view === 'view-1')!;
    assert.ok(crownEntry.image.endsWith('/view-1.png'), 'renamed view keeps its exact image path');
    const crownRegion = masterProduct.regions.find((entry) => entry.id === 'region-visual-1')!;
    expect(crownRegion.safeArea).toHaveLength(4);
    expect(crownRegion.calibrationRef).toEqual({ calibrationId: 'cal-visual-1', version: '1' });
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('five-views-setup.png') });
    }

    // Reopen the master fresh: all five tabs and both calibrations return.
    const fresh = await context.newPage();
    try {
      await gotoBuilder(fresh);
      await fresh.locator('[data-builder-hook="job-open-file"]').setInputFiles(masterPath);
      await expect(fresh.locator('[data-builder-hook="source-status"]')).toContainText('.logo-project');
      const freshWorkspace = builder(fresh, 'product-workspace');
      for (const label of renamedLabels) {
        await expect(freshWorkspace.getByRole('tab', { name: label })).toBeVisible();
      }
      await freshWorkspace.getByRole('tab', { name: 'Crown front' }).click();
      await expect(freshWorkspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    } finally {
      await fresh.close();
    }

    // Issue the hybrid customer delivery: named views and exact assets travel.
    // (The crest logo uploaded before the rename stays auto-selected.)
    // Content changed since the last issue, so mint a fresh issue ID first.
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await (await shown(page, 'job-step-1')).click();
    await (await shown(page, 'customer-name')).fill('Five Views Customer');
    await (await shown(page, 'job-ref')).fill('FIVE-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await (await shown(page, 'job-to-placements')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await builder(page, 'job-placement-host').getByRole('button', { name: 'Send for customer approval' }).click();
    await expect(approval(page)).toBeVisible();
    // The branch disclosure persists across entries (an earlier issue in this
    // journey left it open): only open it when closed, never blind-toggle.
    const fiveViewOptions = approval(page).locator('details', { hasText: 'More options' });
    if (!await fiveViewOptions.evaluate((element) => (element as HTMLDetailsElement).open)) {
      await approval(page).locator('summary', { hasText: 'More options' }).click();
    }
    await approval(page).getByRole('radio', { name: 'ZIP file with the setup files inside' }).check();
    await (await shown(page, 'job-issue-project-new')).click();
    await approval(page).getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(approval(page)).toContainText('Customer file created');
    const downloadBranch = async (fileName: string, button: 'Save office copy' | 'Save customer file'): Promise<Uint8Array> => {
      const event = page.waitForEvent('download');
      await approval(page).getByRole('button', { name: button, exact: true }).click();
      const download = await event;
      const outputPath = join(directory, fileName);
      await download.saveAs(outputPath);
      return new Uint8Array(await readFile(outputPath));
    };
    const officeCopyA = await downloadBranch('five-views-office-a.logo-project', 'Save office copy');
    // Determinism: recreating unchanged content under the same ID succeeds
    // with byte-identical office bytes.
    await approval(page).getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(approval(page)).toContainText('Customer file created');
    const officeCopyB = await downloadBranch('five-views-office-b.logo-project', 'Save office copy');
    expect(Buffer.from(officeCopyB)).toEqual(Buffer.from(officeCopyA));
    const hybridZip = await downloadBranch('five-views.zip', 'Save customer file');
    const hybridEntries = unzipSync(hybridZip);
    const hybridNames = Object.keys(hybridEntries);
    assert.ok(hybridNames.includes('OPEN_LOGO_CONFIGURATOR.html'), 'hybrid ZIP carries the customer page');
    const hybridProjectEntry = hybridNames.find((name) => name.endsWith('.logo-project'));
    assert.ok(hybridProjectEntry, 'hybrid ZIP carries the project file');
    const hybridParsed = await parseProjectPackage(new Uint8Array(hybridEntries[hybridProjectEntry]!), { sha256 });
    const hybridManifest = JSON.parse(Buffer.from(hybridParsed.assets.find((asset) => asset.path === 'presentation/preview.json')!.bytes).toString('utf8')) as typeof masterManifest;
    expect(hybridManifest.version).toBe(3);
    expect(hybridManifest.views.map((entry) => entry.label)).toEqual(renamedLabels);
    expect(hybridManifest.views).toHaveLength(5);

    // Self-contained delivery round-trips the same named views.
    await approval(page).getByRole('radio', { name: 'One file the customer opens directly' }).check();
    await (await shown(page, 'job-issue-project-new')).click();
    await approval(page).getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(approval(page)).toContainText('Customer file created');
    const selfContained = await downloadBranch('OPEN_LOGO_CONFIGURATOR.html', 'Save customer file');
    const officeCopy = await downloadBranch('five-views-office.logo-project', 'Save office copy');
    const { extractEmbeddedProjectPackage } = await import('../src/packaging/self-contained-html/index.js');
    const embedded = extractEmbeddedProjectPackage(selfContained);
    assert.ok(embedded, 'self-contained HTML embeds the project package');
    const selfParsed = await parseProjectPackage(embedded, { sha256 });
    const selfManifest = JSON.parse(Buffer.from(selfParsed.assets.find((asset) => asset.path === 'presentation/preview.json')!.bytes).toString('utf8')) as typeof masterManifest;
    expect(selfManifest.views.map((entry) => entry.label)).toEqual(renamedLabels);
    const officeParsed = await parseProjectPackage(officeCopy, { sha256 });
    const issuedProductId = officeParsed.project.products[0]!.id;
    const issuedLogo = officeParsed.project.logos.find((entry) => entry.name === 'crest');
    assert.ok(issuedLogo, 'issued project carries the uploaded logo');
    const configId = `builder-config-${issuedProductId}`;

    // Customer places one logo in each measured region, confirms, returns.
    const customerHtmlPath = join(directory, 'OPEN_LOGO_CONFIGURATOR.html');
    await writeFile(customerHtmlPath, selfContained);
    const editor = await context.newPage();
    probe.pageErrors.push(...[]);
    editor.on('pageerror', (error) => probe.pageErrors.push(String(error)));
    editor.on('console', (message) => {
      if (message.type() === 'error') probe.consoleErrors.push(message.text());
    });
    try {
      await editor.goto(pathToFileURL(customerHtmlPath).href);
      await expect(editor.locator('[data-customer-hook="project-id"]')).toHaveText(officeParsed.project.projectId);
      await selectCustomerOption(editor, 'configuration', configId);
      const placeIn = async (regionId: string): Promise<void> => {
        await selectCustomerOption(editor, 'region', regionId);
        await selectCustomerOption(editor, 'logo', issuedLogo.id);
        await selectCustomerOption(editor, 'method', 'embroidery');
        await revealCustomerControl(editor, 'x-mm');
        await editor.locator('[data-customer-hook="x-mm"]').fill('140');
        await editor.locator('[data-customer-hook="y-mm"]').fill('100');
        await editor.locator('[data-customer-hook="width-mm"]').fill('50');
        await editor.locator('[data-customer-hook="height-mm"]').fill('30');
        await revealCustomerControl(editor, 'add');
        await editor.locator('[data-customer-hook="add"]').click();
      };
      await placeIn('region-visual-1');
      await expect(editor.locator('[data-customer-hook="placement"] option')).toHaveCount(2);
      // Start a genuinely new placement (otherwise the form would keep
      // editing the selected one), then place in the second region.
      await revealCustomerControl(editor, 'add-another');
      await editor.locator('[data-customer-hook="add-another"]').click();
      await placeIn('region-visual-2');
      await expect(editor.locator('[data-customer-hook="placement"] option')).toHaveCount(3);
      await expect(editor.locator('[data-customer-hook="review"]')).toContainText('Center: 140.0 mm, 100.0 mm');
      await revealCustomerControl(editor, 'confirmed-by');
      await editor.locator('[data-customer-hook="confirmed-by"]').fill('five views reviewer');
      await revealCustomerControl(editor, 'confirm');
      await editor.locator('[data-customer-hook="confirm"]').click();
      await expect(editor.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed: version');
      const downloadPromise = editor.waitForEvent('download');
      await revealCustomerControl(editor, 'submit');
      await editor.locator('[data-customer-hook="submit"]').click();
      const download = await downloadPromise;
      const returnPath = join(directory, 'five-views-return.logo-project');
      await download.saveAs(returnPath);
      const returnBytes = new Uint8Array(await readFile(returnPath));

      // Staff review in the approval branch: the office copy validates the
      // return, the change summary names the views, and installing the
      // response opens Step 2 with the customer geometry.
      await page.locator('[data-builder-hook="job-step-2"]').click();
      await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
      await builder(page, 'job-placement-host').getByRole('button', { name: 'Send for customer approval' }).click();
      await expect(approval(page)).toBeVisible();
      await branchOpenFile(page, 'Open office copy', 'five-views-office.logo-project', officeCopy);
      await expect(approval(page)).toContainText('Office copy loaded: five-views-office.logo-project');
      await branchOpenFile(page, 'Open customer response', 'five-views-return.logo-project', returnBytes);
      await expect(approval(page)).toContainText('Response checked against the office copy');
      await expect(approval(page)).toContainText('five views reviewer');
      await expect(approval(page)).toContainText('Geometry: valid; 2 measured footprint(s)');
      await expect(approval(page)).toContainText('Five View Jacket');
      await expect(approval(page)).toContainText('Crown');
      await expect(approval(page)).toContainText('Sleeve');
      await approval(page).getByRole('button', { name: 'Use customer changes', exact: true }).click();
      await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
      const installedHost = builder(page, 'job-placement-host');
      expect(await installedHost.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);
      await expect(installedHost.locator('[data-placement-hook="pw-placement-list"]')).toContainText('crest');
      // Invalid returns are rejected atomically; the installed job survives.
      await installedHost.getByRole('button', { name: 'Send for customer approval' }).click();
      await expect(approval(page)).toBeVisible();
      await branchOpenFile(page, 'Open customer response', 'invalid-return.logo-project', new TextEncoder().encode('not a logo project'));
      await expect(approval(page)).toContainText('Could not import response invalid-return.logo-project');
      await expect(approval(page)).toContainText('The active job and outputs are unchanged.');
      expect(await installedHost.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);
    } finally {
      await editor.close();
    }

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await context.close();
  }
});
