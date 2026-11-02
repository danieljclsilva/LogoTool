import { revealCustomerControl, selectCustomerOption } from './helpers.js';
import { expect, test } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import type { ProjectDocument, PointMm } from '../src/core/types.js';
import { PROJECT_EDITOR_LIMITS } from '../src/core/project-editor/index.js';

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
const HTML_ENTRY = 'customer-configurator.html';
const PROJECT_ENTRY = 'SYNTHETIC-CUSTOMER.logo-project';

interface LocalPrototype {
  directory: string;
  htmlPath: string;
  projectPath: string;
  projectBytes: Buffer;
}

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

interface DeferredFileRead {
  started: boolean;
  release?: () => void;
}

interface DeferredDigest {
  started: boolean;
  release?: () => void;
}

async function unpackPrototype(): Promise<LocalPrototype> {
  const archive = new Uint8Array(await fs.readFile(resolve('dist/dev/synthetic-customer-prototype.zip')));
  const entries = unzipSync(archive);
  const names = Object.keys(entries).sort();
  expect(names).toEqual([HTML_ENTRY, PROJECT_ENTRY].sort());
  const directory = await fs.mkdtemp(join(tmpdir(), 'LogoTool synthetic customer editor with spaces '));
  const htmlPath = join(directory, 'standalone customer configurator.html');
  const projectPath = join(directory, 'SYNTHETIC-CUSTOMER.logo-project');
  const html = entries[HTML_ENTRY];
  const project = entries[PROJECT_ENTRY];
  if (!html || !project) throw new Error('Synthetic customer prototype ZIP is missing its named inline HTML or project package.');
  const projectBytes = Buffer.from(project);
  await Promise.all([
    fs.writeFile(htmlPath, Buffer.from(html)),
    fs.writeFile(projectPath, projectBytes),
  ]);
  return { directory, htmlPath, projectPath, projectBytes };
}

async function openOfflineEditor(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<{
  context: BrowserContext;
  page: Page;
  probe: Probe;
}> {
  const info = test.info();
  await info.attach('customer-editor-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform,
      release: release(),
      arch: process.arch,
      browser: info.project.name,
      browserVersion: browser.version(),
      viewport,
      offline: true,
      entryPoint: 'file://',
      prototype: 'synthetic customer editor',
    }, null, 2),
  });
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  return { context, page, probe };
}

async function openPage(page: Page, prototype: LocalPrototype): Promise<void> {
  await page.goto(pathToFileURL(prototype.htmlPath).href);
  await expect(page).toHaveTitle(/logo layout/i);
  await expect(page.locator('.wordmark')).toHaveText('Logo Station');
  await expect(page.locator('[data-customer-hook="choose"]')).toBeVisible();
}

async function choosePackage(page: Page, path: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await revealCustomerControl(page, 'choose');
  await page.locator('[data-customer-hook="choose"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path);
  await expect(page.locator('[data-customer-hook="project-id"]')).not.toHaveText('Not loaded');
}

async function dropPackage(page: Page, bytes: Uint8Array, fileName: string): Promise<void> {
  await page.evaluate(({ base64, name }) => {
    const binary = atob(base64);
    const data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], name, { type: 'application/zip' }));
    const target = document.querySelector<HTMLElement>('[data-customer-hook="dropzone"]');
    if (!target) throw new Error('Missing customer package drop target.');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { base64: Buffer.from(bytes).toString('base64'), name: fileName });
  await expect(page.locator('[data-customer-hook="status"]')).toContainText(`Opened ${fileName}`);
}

async function createEmptyReplacementPackage(sourceBytes: Uint8Array): Promise<Uint8Array> {
  const parsed = await parseProjectPackage(sourceBytes, { sha256 });
  const project = {
    ...parsed.project,
    projectId: 'SYN-PROJ-ASYNC-NEW',
    configurations: parsed.project.configurations.map((configuration) => ({ ...configuration, placements: [] })),
  };
  delete project.confirmation;
  delete project.review;
  const assets = parsed.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes }));
  const additionalAssets = parsed.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes }));
  return createProjectPackage({ project, assets, additionalAssets }, { sha256 });
}

async function createExclusionPackage(sourceBytes: Uint8Array): Promise<Uint8Array> {
  const parsed = await parseProjectPackage(sourceBytes, { sha256 });
  const project = {
    ...parsed.project,
    products: parsed.project.products.map((product) => ({
      ...product,
      regions: product.regions.map((region) => region.id === 'SYN-TEE-CHEST'
        ? { ...region, exclusions: [[[-10, -10], [10, -10], [10, 10], [-10, 10]]] }
        : region),
    })),
  };
  const assets = parsed.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes }));
  const additionalAssets = parsed.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes }));
  return createProjectPackage({ project, assets, additionalAssets }, { sha256 });
}

async function createOverBudgetRegionPackage(sourceBytes: Uint8Array): Promise<Uint8Array> {
  const parsed = await parseProjectPackage(sourceBytes, { sha256 });
  const project = structuredClone(parsed.project) as ProjectDocument;
  const unusedRegion = project.products[1]?.regions.find((region) => region.id === 'SYN-TR-THIGH-R');
  if (!unusedRegion) throw new Error('Synthetic fixture is missing its unused right-thigh region.');
  unusedRegion.safeArea = Array.from(
    { length: PROJECT_EDITOR_LIMITS.maxVerticesPerRing + 1 },
    (_, index): PointMm => [index, 0],
  );
  const assets = parsed.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes }));
  const additionalAssets = parsed.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes }));
  return createProjectPackage({ project, assets, additionalAssets }, { sha256 });
}

async function saveDownloadedFile(page: Page, outputPath: string, trigger: () => Promise<void>): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  assert.ok(downloadedPath, 'Playwright should retain the locally saved package.');
  const bytes = await fs.readFile(downloadedPath);
  await fs.writeFile(outputPath, bytes);
  return bytes;
}

async function captureBothViewports(page: Page, info: TestInfo): Promise<void> {
  const directory = info.outputPath('customer-editor-screenshots');
  await fs.mkdir(directory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(directory, 'customer-editor-1280x900.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(directory, 'customer-editor-390x844.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.networkRequests).toEqual([]);
}

async function setNumber(page: Page, hook: string, value: number): Promise<void> {
  await revealCustomerControl(page, hook);
  await page.locator(`[data-customer-hook="${hook}"]`).fill(String(value));
  // Human commits fire `change` on blur; Tab out so the edit auto-applies
  // exactly as a human-committed edit would (fill alone keeps focus).
  await page.locator(`[data-customer-hook="${hook}"]`).press('Tab');
}

async function openAdvancedDetails(page: Page, hook: string): Promise<void> {
  await revealCustomerControl(page, hook);
  const control = page.locator(`[data-customer-hook="${hook}"]`);
  const details = control.locator('xpath=ancestor::details[1]');
  if ((await details.count()) === 0) return;
  if (await details.getAttribute('open') !== null) return;
  await details.locator('summary').click();
  await expect(control).toBeVisible();
}

async function startDrag(page: Page, polygonIndex = 0): Promise<{ startX: number; startY: number; pointerId: number }> {
  await page.evaluate(() => {
    const canvas = document.querySelector<SVGSVGElement>('[data-customer-hook="canvas"]');
    if (!canvas) throw new Error('Missing region canvas.');
    const state = window as Window & { __lastCustomerPointerId?: number | null };
    state.__lastCustomerPointerId = null;
    canvas.addEventListener('pointerdown', (event) => { state.__lastCustomerPointerId = event.pointerId; }, { once: true });
  });
  const polygon = page.locator('svg [data-customer-hook="canvas-layer"] polygon.footprint').nth(polygonIndex);
  const bounds = await polygon.boundingBox();
  if (!bounds) throw new Error('Placement footprint is not visible for direct drag.');
  const startX = bounds.x + bounds.width * 0.2;
  const startY = bounds.y + bounds.height * 0.3;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 32, startY + 22, { steps: 3 });
  const pointerId = await page.evaluate(() => (window as Window & { __lastCustomerPointerId?: number | null }).__lastCustomerPointerId);
  if (pointerId == null) throw new Error('Pointerdown did not reach the SVG gesture surface.');
  return { startX, startY, pointerId };
}

test('offline chooser edit, multiple configurations, exact review, confirmation, and package round-trip', async ({ browser }, info) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText(/SYN-PROJ-/);
    await expect(page.locator('[data-customer-hook="asset-count"]')).toHaveText('2');
    const issuedRevision = Number(await page.locator('[data-customer-hook="revision"]').textContent());
    await revealCustomerControl(page, 'confirmed-by');
    await page.locator('[data-customer-hook="confirmed-by"]').fill('initial synthetic reviewer');
    await revealCustomerControl(page, 'confirm');
    await page.locator('[data-customer-hook="confirm"]').click();
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed: version');
    await expect(page.locator('[data-customer-hook="configuration"] option')).toHaveCount(2);
    await expect(page.locator('[data-customer-hook="canvas"] polygon.safe-area')).toHaveCount(1);
    await expect(page.locator('[data-customer-hook="canvas"] image, [data-customer-hook="canvas"] img')).toHaveCount(0);

    await selectCustomerOption(page, 'configuration', 'SYN-CFG-TEE-M');
    await selectCustomerOption(page, 'region', 'SYN-TEE-CHEST');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 0.0 mm, 10.0 mm');
    await setNumber(page, 'x-mm', 4);
    await setNumber(page, 'y-mm', 12);
    await setNumber(page, 'width-mm', 76);
    await setNumber(page, 'height-mm', 38);
    await openAdvancedDetails(page, 'rotation');
    await setNumber(page, 'rotation', 15);
    await revealCustomerControl(page, 'placement-instructions');
    await page.locator('[data-customer-hook="placement-instructions"]').fill('Keep the seam clear.');
    await page.locator('[data-customer-hook="placement-instructions"]').press('Tab');
    await revealCustomerControl(page, 'instructions');
    await page.locator('[data-customer-hook="instructions"]').fill('Both measurement and project instructions change in one revision.');
    await page.locator('[data-customer-hook="instructions"]').press('Tab');
    await selectCustomerOption(page, 'method', 'embroidery');
    // Valid edits auto-apply as successive new revisions on change (no
    // separate Apply step), so the batch above lands as multiple versions.
    const editedRevision = Number(await page.locator('[data-customer-hook="revision"]').textContent());
    expect(editedRevision).toBeGreaterThan(issuedRevision);
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 4.0 mm, 12.0 mm');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Width × height: 76.0 mm × 38.0 mm');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Turn clockwise: 15.0°');
    await expect(page.locator('[data-customer-hook="review-reference"]')).toContainText('Frame: FRAME-SYN-CHEST');
    await expect(page.locator('[data-customer-hook="review-reference"]')).toContainText('Axes: +x right; +y up');
    await expect(page.locator('[data-customer-hook="review-reference"]')).toContainText('Calibration: CAL-SYN-001 v1');
    await expect(page.locator('[data-customer-hook="review-reference"]')).toContainText('SYN-CFG-TR-REG');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Note about this logo: Keep the seam clear.');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Notes for the whole project: Both measurement and project instructions change in one revision.');
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText(/no longer counts|Nothing confirmed/i);

    await selectCustomerOption(page, 'configuration', 'SYN-CFG-TR-REG');
    await revealCustomerControl(page, 'remove');
    await page.locator('[data-customer-hook="remove"]').click();
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(1);
    await selectCustomerOption(page, 'logo', 'SYN-LOGO-B');
    await setNumber(page, 'x-mm', 0);
    await setNumber(page, 'y-mm', 0);
    await setNumber(page, 'width-mm', 52);
    await setNumber(page, 'height-mm', 24);
    await openAdvancedDetails(page, 'rotation');
    await setNumber(page, 'rotation', 0);
    await revealCustomerControl(page, 'add');
    await page.locator('[data-customer-hook="add"]').click();
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(2);
    await revealCustomerControl(page, 'add');
    await page.locator('[data-customer-hook="add"]').click();
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(3);
    await selectCustomerOption(page, 'configuration', 'SYN-CFG-TEE-M');
    await selectCustomerOption(page, 'variant', 'SYN-TEE-XL');
    await expect(page.locator('[data-customer-hook="configuration"] option')).toHaveCount(3);
    await expect(page.locator('[data-customer-hook="variant"]')).toHaveValue('SYN-TEE-XL');
    await selectCustomerOption(page, 'product', 'SYN-TR-001');
    await expect(page.locator('[data-customer-hook="variant"]')).toHaveValue('SYN-TR-REG');
    await selectCustomerOption(page, 'region', 'SYN-TR-THIGH-R');
    await openAdvancedDetails(page, 'frame');
    await expect(page.locator('[data-customer-hook="frame"]')).toContainText('FRAME-SYN-THIGH-R');
    await selectCustomerOption(page, 'variant', 'SYN-TR-SHORT');
    await expect(page.locator('[data-customer-hook="configuration"] option')).toHaveCount(4);
    await expect(page.locator('[data-customer-hook="region"]')).toHaveValue('SYN-TR-THIGH-L');

    await selectCustomerOption(page, 'configuration', 'SYN-CFG-TEE-M');
    await revealCustomerControl(page, 'instructions');
    await page.locator('[data-customer-hook="instructions"]').fill('Synthetic customer instruction: use the updated centered placement.');
  await page.locator('[data-customer-hook="instructions"]').press('Tab');
    // The note edit auto-applies as a new revision; confirmation invalidates.
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText(/no longer counts|does not match|Nothing confirmed/i);
    await revealCustomerControl(page, 'confirmed-by');
    await page.locator('[data-customer-hook="confirmed-by"]').fill('offline prototype reviewer');
    await revealCustomerControl(page, 'confirm');
    await page.locator('[data-customer-hook="confirm"]').click();
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed: version');
    await expect(page.locator('[data-customer-hook="submit"]')).toBeEnabled();

    const savedBytes = await saveDownloadedFile(page, join(prototype.directory, 'confirmed customer return.logo-project'), async () => {
      await revealCustomerControl(page, 'submit');
      await page.locator('[data-customer-hook="submit"]').click();
    });
    const original = await parseProjectPackage(new Uint8Array(prototype.projectBytes), { sha256 });
    const saved = await parseProjectPackage(new Uint8Array(savedBytes), { sha256 });
    expect(saved.project.instructions).toBe('Synthetic customer instruction: use the updated centered placement.');
    expect(saved.project.confirmation?.revision).toBe(saved.project.revision);
    const reviewedConfiguration = saved.project.configurations.find((configuration) => configuration.id === 'SYN-CFG-TEE-M');
    expect(reviewedConfiguration?.placements).toHaveLength(2);
    expect(reviewedConfiguration?.placements[0]?.instructions).toBe('Keep the seam clear.');
    expect(saved.assets.map((asset) => ({ path: asset.path, kind: asset.kind }))).toEqual(
      original.assets.map((asset) => ({ path: asset.path, kind: asset.kind })),
    );
    for (let index = 0; index < original.assets.length; index += 1) {
      assert.deepEqual(saved.assets[index]?.bytes, original.assets[index]?.bytes);
    }

    const returnedPath = join(prototype.directory, 'confirmed return reopened.logo-project');
    await fs.writeFile(returnedPath, savedBytes);
    await page.locator('[data-customer-hook="file-input"]').setInputFiles(returnedPath);
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText(saved.project.projectId);
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed: version');
    await selectCustomerOption(page, 'configuration', 'SYN-CFG-TEE-M');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 4.0 mm, 12.0 mm');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Width × height: 76.0 mm × 38.0 mm');
    await expect(page.locator('[data-customer-hook="asset-count"]')).toHaveText('2');
    await captureBothViewports(page, info);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('drop accepts a geometric-invalid editable draft but blocks confirmation and submit', async ({ browser }, info) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    const exclusionBytes = await createExclusionPackage(new Uint8Array(prototype.projectBytes));
    await dropPackage(page, exclusionBytes, 'dropped exclusion fixture.logo-project');
    await expect(page.locator('[data-customer-hook="canvas"] polygon.exclusion-area')).toHaveCount(1);
    await revealCustomerControl(page, 'confirmed-by');
    await page.locator('[data-customer-hook="confirmed-by"]').fill('should remain unconfirmed');
    await setNumber(page, 'y-mm', 0);
    // The invalid-fit numbers auto-apply as a new revision; confirmation and
    // submit stay blocked by the fit verdict (no Apply click needed).
    // Normal copy is short and human; the exact validator verdict stays
    // Advanced-only.
    await expect(page.locator('[data-customer-hook="geometry"]')).toContainText('This logo extends beyond');
    await expect(page.locator('[data-customer-hook="geometry"]')).not.toContainText('footprint');
    await expect(page.locator('[data-customer-hook="geometry-technical-wrap"]')).toBeVisible();
    await expect(page.locator('[data-customer-hook="geometry-technical"]')).toContainText('Fits: no');
    const geometryTitle = await page.locator('[data-customer-hook="geometry"]').getAttribute('title');
    expect(geometryTitle ?? '').not.toMatch(/vertex|\(.*,/);
    await expect(page.locator('[data-customer-hook="save"]')).toBeEnabled();
    await expect(page.locator('[data-customer-hook="confirm"]')).toBeDisabled();
    await expect(page.locator('[data-customer-hook="submit"]')).toBeDisabled();
    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'broken.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from('not a ZIP archive'),
    });
    await expect(page.locator('[data-customer-hook="status"]')).toContainText(/Could not load broken\.logo-project/);
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    await expect(page.locator('[data-customer-hook="x-mm"]')).toHaveValue('0');
    await expect(page.locator('[data-customer-hook="save"]')).toBeEnabled();

    const draftBytes = await saveDownloadedFile(page, join(prototype.directory, 'invalid fit draft.logo-project'), async () => {
      await revealCustomerControl(page, 'save');
      await page.locator('[data-customer-hook="save"]').click();
    });
    const draft = await parseProjectPackage(new Uint8Array(draftBytes), { sha256 });
    expect(draft.project.configurations[0]?.placements[0]?.pos.xMm).toBe(0);
    expect(draft.project.configurations[0]?.placements[0]?.pos.yMm).toBe(0);
    expect(draft.project.confirmation).toBeUndefined();
    const source = await parseProjectPackage(new Uint8Array(prototype.projectBytes), { sha256 });
    expect(draft.assets.map((asset) => asset.path)).toEqual(source.assets.map((asset) => asset.path));
    for (let index = 0; index < source.assets.length; index += 1) {
      assert.deepEqual(draft.assets[index]?.bytes, source.assets[index]?.bytes);
    }
    await captureBothViewports(page, info);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('over-budget unused-region geometry is rejected before installation or polygon rendering', async ({ browser }, info) => {
  const prototype = await unpackPrototype();
  const overBudget = await createOverBudgetRegionPackage(new Uint8Array(prototype.projectBytes));
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    const revision = await page.locator('[data-customer-hook="revision"]').textContent();
    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'over-budget-unused-region.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(overBudget),
    });
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('512-vertex project-editor limit');
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(revision!);
    await expect(page.locator('[data-customer-hook="canvas"] polygon.safe-area')).toHaveCount(1);
    await captureBothViewports(page, info);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('footprint drag preserves its grab offset and physical box, while Escape cancels an uncommitted drag', async ({ browser }, info) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    const before = {
      x: Number(await page.locator('[data-customer-hook="x-mm"]').inputValue()),
      y: Number(await page.locator('[data-customer-hook="y-mm"]').inputValue()),
      width: Number(await page.locator('[data-customer-hook="width-mm"]').inputValue()),
      height: Number(await page.locator('[data-customer-hook="height-mm"]').inputValue()),
      rotation: Number(await page.locator('[data-customer-hook="rotation"]').inputValue()),
      revision: Number(await page.locator('[data-customer-hook="revision"]').textContent()),
      viewBox: await page.locator('[data-customer-hook="canvas"]').getAttribute('viewBox'),
    };
    const gesture = await startDrag(page);
    const dragSaveBytes = await saveDownloadedFile(page, join(prototype.directory, 'committed baseline during drag.logo-project'), async () => {
      await page.locator('[data-customer-hook="save-draft-top"]').press('Enter');
    });
    const savedDuringDrag = await parseProjectPackage(new Uint8Array(dragSaveBytes), { sha256 });
    expect(savedDuringDrag.project.revision).toBe(before.revision);
    expect(savedDuringDrag.project.configurations[0]!.placements[0]!.pos).toEqual({ xMm: before.x, yMm: before.y });
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(before.revision));

    const endpointX = gesture.startX + 54;
    const endpointY = gesture.startY + 41;
    const pointerDelta = await page.evaluate(({ startX, startY, endX, endY }) => {
      const svg = document.querySelector<SVGSVGElement>('[data-customer-hook="canvas"]');
      const matrix = svg?.getScreenCTM();
      if (!svg || !matrix) throw new Error('The region SVG transform is not available for drag acceptance.');
      const start = svg.createSVGPoint();
      start.x = startX;
      start.y = startY;
      const end = svg.createSVGPoint();
      end.x = endX;
      end.y = endY;
      const startMm = start.matrixTransform(matrix.inverse());
      const endMm = end.matrixTransform(matrix.inverse());
      return { x: endMm.x - startMm.x, y: -(endMm.y - startMm.y) };
    }, { startX: gesture.startX, startY: gesture.startY, endX: endpointX, endY: endpointY });
    await page.evaluate(({ pointerId, clientX, clientY }) => {
      const canvas = document.querySelector<SVGSVGElement>('[data-customer-hook="canvas"]');
      if (!canvas) throw new Error('Missing canvas for the pointer release endpoint.');
      canvas.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId, isPrimary: true, button: 0, clientX, clientY,
      }));
    }, { pointerId: gesture.pointerId, clientX: endpointX, clientY: endpointY });
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(before.revision + 1));
    const moved = {
      x: Number(await page.locator('[data-customer-hook="x-mm"]').inputValue()),
      y: Number(await page.locator('[data-customer-hook="y-mm"]').inputValue()),
    };
    expect(moved.x - before.x).toBeCloseTo(pointerDelta.x, 3);
    expect(moved.y - before.y).toBeCloseTo(pointerDelta.y, 3);
    expect(moved.x).not.toBe(before.x);
    expect(moved.y).not.toBe(before.y);
    expect(Number(await page.locator('[data-customer-hook="width-mm"]').inputValue())).toBe(before.width);
    expect(Number(await page.locator('[data-customer-hook="height-mm"]').inputValue())).toBe(before.height);
    expect(Number(await page.locator('[data-customer-hook="rotation"]').inputValue())).toBe(before.rotation);
    await expect(page.locator('[data-customer-hook="canvas"]')).toHaveAttribute('viewBox', before.viewBox!);

    const committedRevision = Number(await page.locator('[data-customer-hook="revision"]').textContent());
    const nextDrag = await startDrag(page);
    await page.mouse.move(nextDrag.startX + 46, nextDrag.startY + 37, { steps: 2 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(committedRevision));
    await expect(page.locator('[data-customer-hook="x-mm"]')).toHaveValue(String(moved.x));
    await expect(page.locator('[data-customer-hook="y-mm"]')).toHaveValue(String(moved.y));
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Move cancelled with Escape');
    const cancelledPointer = await startDrag(page);
    await page.evaluate(({ pointerId }) => {
      const canvas = document.querySelector<SVGSVGElement>('[data-customer-hook="canvas"]');
      if (!canvas) throw new Error('Missing canvas for pointercancel.');
      canvas.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId, isPrimary: true }));
    }, cancelledPointer);
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(committedRevision));
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Move cancelled');

    const lostCapture = await startDrag(page);
    await page.evaluate(({ pointerId }) => {
      const canvas = document.querySelector<SVGSVGElement>('[data-customer-hook="canvas"]');
      if (!canvas?.hasPointerCapture(pointerId)) throw new Error('Expected the gesture surface to hold pointer capture.');
      canvas.releasePointerCapture(pointerId);
    }, lostCapture);
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Move cancelled');
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(committedRevision));

    const blurred = await startDrag(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('window lost focus');
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(committedRevision));
    expect(blurred.pointerId).toBeGreaterThan(0);
    await startDrag(page);
    await selectCustomerOption(page, 'configuration', 'SYN-CFG-TR-REG');
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(committedRevision));
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Moving stopped because you switched');

    await captureBothViewports(page, info);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('superseded load, confirmation digest, and draft-save completion cannot install or download stale state', async ({ browser }, info) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);

    const replacementBytes = await createEmptyReplacementPackage(new Uint8Array(prototype.projectBytes));
    await page.evaluate(({ base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const file = new File([bytes], name, { type: 'application/zip' });
      const read: DeferredFileRead = { started: false };
      (window as Window & { __deferredCustomerRead?: DeferredFileRead }).__deferredCustomerRead = read;
      const nativeRead = File.prototype.arrayBuffer;
      Object.defineProperty(File.prototype, 'arrayBuffer', {
        configurable: true,
        writable: true,
        value: function (this: File): Promise<ArrayBuffer> {
          if (this.name !== name) return nativeRead.call(this);
          read.started = true;
          return new Promise<ArrayBuffer>((resolveRead, rejectRead) => {
            read.release = () => {
              Object.defineProperty(File.prototype, 'arrayBuffer', { configurable: true, writable: true, value: nativeRead });
              void nativeRead.call(this).then(resolveRead, rejectRead);
            };
          });
        },
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const target = document.querySelector<HTMLElement>('[data-customer-hook="dropzone"]');
      if (!target) throw new Error('Missing customer package drop target.');
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, { base64: Buffer.from(prototype.projectBytes).toString('base64'), name: 'obsolete delayed project.logo-project' });
    await page.waitForFunction(() => (window as Window & { __deferredCustomerRead?: DeferredFileRead }).__deferredCustomerRead?.started === true);
    await dropPackage(page, replacementBytes, 'newest empty configuration.logo-project');
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-ASYNC-NEW');
    await page.evaluate(() => {
      const read = (window as Window & { __deferredCustomerRead?: DeferredFileRead }).__deferredCustomerRead;
      if (!read?.release) throw new Error('The delayed obsolete file read was not ready.');
      read.release();
    });
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-ASYNC-NEW');

    await revealCustomerControl(page, 'confirmed-by');

    await page.locator('[data-customer-hook="confirmed-by"]').fill('async review');
    await page.evaluate(() => {
      const deferred: DeferredDigest = { started: false };
      (window as Window & { __deferredCustomerDigest?: DeferredDigest }).__deferredCustomerDigest = deferred;
      const nativeDigest = SubtleCrypto.prototype.digest;
      Object.defineProperty(SubtleCrypto.prototype, 'digest', {
        configurable: true,
        writable: true,
        value: function (this: SubtleCrypto, algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
          deferred.started = true;
          return new Promise<ArrayBuffer>((resolveDigest, rejectDigest) => {
            deferred.release = () => {
              Object.defineProperty(SubtleCrypto.prototype, 'digest', { configurable: true, writable: true, value: nativeDigest });
              void nativeDigest.call(this, algorithm, data).then(resolveDigest, rejectDigest);
            };
          });
        },
      });
    });
    await revealCustomerControl(page, 'confirm');
    await page.locator('[data-customer-hook="confirm"]').click();
    await page.waitForFunction(() => (window as Window & { __deferredCustomerDigest?: DeferredDigest }).__deferredCustomerDigest?.started === true);
    const otherConfiguration = await page.locator('[data-customer-hook="configuration"] option').nth(1).getAttribute('value');
    if (!otherConfiguration) throw new Error('Expected a second configuration for stale confirmation context switching.');
    await selectCustomerOption(page, 'configuration', otherConfiguration);
    await page.evaluate(() => {
      const deferred = (window as Window & { __deferredCustomerDigest?: DeferredDigest }).__deferredCustomerDigest;
      if (!deferred?.release) throw new Error('The delayed confirmation digest was not ready.');
      deferred.release();
    });
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Confirmation stopped because something changed');
    await expect(page.locator('[data-customer-hook="submit"]')).toBeDisabled();

    await page.evaluate(() => {
      const deferred: DeferredDigest = { started: false };
      (window as Window & { __deferredSaveDigest?: DeferredDigest }).__deferredSaveDigest = deferred;
      const nativeDigest = SubtleCrypto.prototype.digest;
      Object.defineProperty(SubtleCrypto.prototype, 'digest', {
        configurable: true,
        writable: true,
        value: function (this: SubtleCrypto, algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
          deferred.started = true;
          return new Promise<ArrayBuffer>((resolveDigest, rejectDigest) => {
            deferred.release = () => {
              Object.defineProperty(SubtleCrypto.prototype, 'digest', { configurable: true, writable: true, value: nativeDigest });
              void nativeDigest.call(this, algorithm, data).then(resolveDigest, rejectDigest);
            };
          });
        },
      });
    });
    let downloaded = false;
    page.on('download', () => { downloaded = true; });
    await revealCustomerControl(page, 'save');
    await page.locator('[data-customer-hook="save"]').click();
    await page.waitForFunction(() => (window as Window & { __deferredSaveDigest?: DeferredDigest }).__deferredSaveDigest?.started === true);
    const currentConfiguration = await page.locator('[data-customer-hook="configuration"] option').first().getAttribute('value');
    if (!currentConfiguration) throw new Error('Expected a configuration to switch while draft save is pending.');
    await selectCustomerOption(page, 'configuration', currentConfiguration);
    await page.evaluate(() => {
      const deferred = (window as Window & { __deferredSaveDigest?: DeferredDigest }).__deferredSaveDigest;
      if (!deferred?.release) throw new Error('The delayed package asset digest was not ready.');
      deferred.release();
    });
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Saving stopped because something changed');
    expect(downloaded).toBe(false);
    await captureBothViewports(page, info);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('undo and reset restore package content as new revisions', async ({ browser }, info) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    const issuedRevision = Number(await page.locator('[data-customer-hook="revision"]').textContent());
    await revealCustomerControl(page, 'confirmed-by');
    await page.locator('[data-customer-hook="confirmed-by"]').fill('Synthetic undo reviewer');
    await revealCustomerControl(page, 'confirm');
    await page.locator('[data-customer-hook="confirm"]').click();
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText(`Confirmed: version ${issuedRevision}`);
    await setNumber(page, 'x-mm', 25);
    // The number edit auto-applies as a new revision (no Apply click).
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 1));

    await setNumber(page, 'x-mm', 15);
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 2));
    await revealCustomerControl(page, 'undo');
    await page.locator('[data-customer-hook="undo"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 3));
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 25.0 mm, 10.0 mm');

    await revealCustomerControl(page, 'undo');

    await page.locator('[data-customer-hook="undo"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 4));
    await expect(page.locator('[data-customer-hook="undo"]')).toBeDisabled();
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 0.0 mm, 10.0 mm');

    await setNumber(page, 'x-mm', 40);
    // The number edit auto-applies as a new revision (no Apply click).
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 5));
    await openAdvancedDetails(page, 'reset');
    await revealCustomerControl(page, 'reset');
    await page.locator('[data-customer-hook="reset"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 6));
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 0.0 mm, 10.0 mm');
    await expect(page.locator('[data-customer-hook="instructions"]')).toHaveValue(/Synthetic fixture instructions/);
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText(/no longer counts|does not match|Nothing confirmed/i);
    await captureBothViewports(page, info);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('one workspace edits position and size together; review stays a separate confirmation step', async ({ browser }, info) => {
  for (const viewport of [{ width: 1536, height: 1024 }, { width: 390, height: 844 }]) {
    const prototype = await unpackPrototype();
    const { context, page, probe } = await openOfflineEditor(browser, viewport);
    try {
      await openPage(page, prototype);
      await choosePackage(page, prototype.projectPath);
      const revision = Number(await page.locator('[data-customer-hook="revision"]').textContent());
      // One placement workspace: region, placement, width and precise
      // coordinates live together — no Position -> Size stepping per logo.
      await expect(page.locator('[data-step-panel="edit"]')).toBeVisible();
      await expect(page.locator('[data-step-panel="review"]')).toBeHidden();
      await expect(page.locator('[data-customer-hook="step-edit"]')).toBeVisible();
      await expect(page.locator('[data-customer-hook="job-choices"]')).not.toHaveAttribute('open', '');
      await expect(page.locator('[data-customer-hook="product"]')).toBeHidden();
      await expect(page.locator('[data-customer-hook="logo-chips"]')).toBeVisible();
      await expect(page.locator('[data-customer-hook="placement-instructions"]')).toBeVisible();
      await expect(page.locator('[data-customer-hook="region"]')).toBeHidden();
      await expect(page.locator('[data-customer-hook="width-mm"]')).toBeHidden();
      await expect(page.locator('[data-customer-hook="x-mm"]')).toBeHidden();
      await expect(page.locator('[data-customer-hook="height-mm"]')).toBeHidden();
      // Width commits in place (Tab = human commit parity) without leaving
      // the workspace; Review is the separate combined proof step.
      await revealCustomerControl(page, 'width-mm');
      await page.locator('[data-customer-hook="width-mm"]').fill('64');
      await page.locator('[data-customer-hook="width-mm"]').press('Tab');
      await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(revision + 1));
      await page.locator('[data-customer-hook="primary-next"]').click();
      await expect(page.locator('[data-step-panel="review"]')).toBeVisible();
      await expect(page.locator('[data-customer-hook="review"]')).toContainText('Width × height: 64.0 mm × 32.0 mm');
      for (const hook of ['precise-position','precise-size']) await expect(page.locator(`[data-customer-hook="${hook}"]`)).not.toHaveAttribute('open', '');
      await page.locator('[data-customer-hook="confirmed-by"]').fill('Synthetic guided reviewer');
      await page.locator('[data-customer-hook="confirm"]').click();
      const bytes = await saveDownloadedFile(page, join(prototype.directory, 'guided.logo-project'), () => page.locator('[data-customer-hook="submit"]').click());
      const saved = await parseProjectPackage(new Uint8Array(bytes), { sha256 });
      expect(saved.project.confirmation?.revision).toBe(revision + 1);
      expect(saved.project.configurations[0]?.placements[0]?.widthMm).toBe(64);
      expect(saved.project.configurations[0]?.placements[0]?.heightMm).toBe(32);
      await expect(page.locator('[data-customer-hook="status"]')).toContainText('email attachment');
      await page.locator('[data-customer-hook="step-edit"]').click();
      await expect(page.locator('[data-step-panel="edit"]')).toBeVisible();
      const precise = page.locator('[data-customer-hook="precise-size"]');
      await precise.locator('summary').focus(); await page.keyboard.press('Enter');
      await expect(precise).toHaveAttribute('open', '');
      await page.locator('[data-customer-hook="height-mm"]').fill('15');
      await expect(page.locator('[data-customer-hook="ratio-lock"]')).not.toBeChecked();
      // The height edit auto-applies on change; no Apply click is needed.
      await page.locator('[data-customer-hook="width-mm"]').fill('60');
      await page.locator('[data-customer-hook="width-mm"]').press('Tab');
      await expect(page.locator('[data-customer-hook="height-mm"]')).toHaveValue('15');
      await page.locator('[data-customer-hook="primary-next"]').click();
      await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('no longer counts');
      await expect(page.locator('[data-customer-hook="submit"]')).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`guided-${viewport.width}.png`) });
      expectOfflineClean(probe);
    } finally { await context.close(); await fs.rm(prototype.directory, { recursive: true, force: true }); }
  }
});

test('visible area chips select each named area without opening Advanced', async ({ browser }, info) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    await selectCustomerOption(page, 'configuration', 'SYN-CFG-TEE-M');
    await expect(page.locator('[data-customer-hook="area-chips"]')).toBeHidden();
    await revealCustomerControl(page, 'add-another');
    await page.locator('[data-customer-hook="add-another"]').click();
    // Two named areas in this synthetic option; no duplicate region selects.
    await expect(page.locator('[data-customer-hook="area-chips"]')).toBeVisible();
    await expect(page.locator('[data-customer-hook="area-chips"] button')).toHaveCount(2);
    await expect(page.locator('[data-customer-hook="area-chips"] button').first()).toContainText('Chest');
    await expect(page.locator('[data-customer-hook="region"]')).toHaveCount(1);
    await expect(page.locator('[data-customer-hook="precise-position"]')).not.toHaveAttribute('open', '');
    const placementsBefore = await page.locator('[data-customer-hook="placement"] option').count();
    // Each named area is selectable outside Advanced through the same guarded
    // transition as the region select (aria-pressed + select identity follow).
    await page.locator('[data-customer-hook="area-chips"] button', { hasText: 'Back' }).click();
    await expect(page.locator('[data-customer-hook="area-chips"] button', { hasText: 'Back' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-customer-hook="area-chips"] button', { hasText: 'Chest' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-customer-hook="region"]')).toHaveValue('SYN-TEE-BACK');
    await expect(page.locator('[data-customer-hook="precise-position"]')).not.toHaveAttribute('open', '');
    await page.locator('[data-customer-hook="area-chips"] button', { hasText: 'Chest' }).click();
    await expect(page.locator('[data-customer-hook="area-chips"] button', { hasText: 'Chest' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-customer-hook="region"]')).toHaveValue('SYN-TEE-CHEST');
    // Committed placements survive area-chip navigation.
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(placementsBefore);
    // Area changes preserve the typed new-placement draft.
    await revealCustomerControl(page, 'width-mm');
    await page.locator('[data-customer-hook="width-mm"]').fill('77');
    await revealCustomerControl(page, 'placement-instructions');
    await page.locator('[data-customer-hook="placement-instructions"]').fill('Keep the seam clear.');
    await page.locator('[data-customer-hook="area-chips"] button', { hasText: 'Back' }).click();
    await expect(page.locator('[data-customer-hook="region"]')).toHaveValue('SYN-TEE-BACK');
    await expect(page.locator('[data-customer-hook="width-mm"]')).toHaveValue('77');
    await expect(page.locator('[data-customer-hook="placement-instructions"]')).toHaveValue('Keep the seam clear.');
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(placementsBefore);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('short fit warning, invalid numeric draft, and no-area honesty', async ({ browser }, info) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    await selectCustomerOption(page, 'configuration', 'SYN-CFG-TEE-M');
    // Oversize the selected logo so it leaves the Chest area.
    await setNumber(page, 'width-mm', 500);
    await expect(page.locator('[data-customer-hook="geometry"]')).toContainText('This logo extends beyond Chest');
    await expect(page.locator('[data-customer-hook="geometry"]')).toContainText('Reduce its size or move it inside the area');
    await expect(page.locator('[data-customer-hook="geometry"]')).not.toContainText('footprint vertex');
    await expect(page.locator('[data-customer-hook="geometry-technical"]')).toContainText('Fits: no');
    await expect(page.locator('[data-customer-hook="geometry-technical-wrap"]')).not.toHaveAttribute('open', '');
    await expect(page.locator('[data-customer-hook="geometry-technical"]')).toBeHidden();
    await expect(page.locator('[data-customer-hook="review"]')).not.toBeVisible();
    await page.locator('[data-customer-hook="primary-next"]').click();
    await expect(page.locator('[data-step-panel="review"]')).toBeVisible();
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('This logo extends beyond Chest');
    expect(await page.locator('[data-customer-hook="review"]').innerText()).not.toContain('footprint vertex');
    await expect(page.locator('[data-customer-hook="review"] .review-technical').first()).toContainText('Fits: no');
    await expect(page.locator('[data-customer-hook="confirm"]')).toBeDisabled();
    await page.locator('[data-customer-hook="step-edit"]').click();
    // Invalid numeric draft cannot confirm: non-finite width stays pending.
    await revealCustomerControl(page, 'width-mm');
    await page.locator('[data-customer-hook="width-mm"]').fill('');
    await page.locator('[data-customer-hook="width-mm"]').press('Tab');
    await expect(page.locator('[data-customer-hook="confirm"]')).toBeDisabled();
    await expect(page.locator('[data-customer-hook="status"]')).toContainText(/Could not save|not applied yet|numbers/);
    // No-area job stays honest: empty regions hide chips and disable Add.
    const parsed = await parseProjectPackage(new Uint8Array(prototype.projectBytes), { sha256 });
    const emptied = structuredClone(parsed.project) as ProjectDocument;
    for (const product of emptied.products) {
      product.regions = [];
      (product as { calibrations?: unknown }).calibrations = [];
      for (const variant of product.variants) { variant.regionIds = []; delete variant.placementOverrides; }
    }
    for (const configuration of emptied.configurations) configuration.placements = [];
    delete emptied.confirmation;
    delete emptied.review;
    const assets = parsed.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes }));
    const additionalAssets = parsed.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes }));
    const emptyBytes = await createProjectPackage({ project: emptied, assets, additionalAssets }, { sha256 });
    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'synthetic-no-area.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(emptyBytes),
    });
    await expect(page.locator('[data-customer-hook="area-chips"]')).toBeHidden();
    await expect(page.locator('[data-customer-hook="area-empty"]')).toBeVisible();
    await expect(page.locator('[data-customer-hook="add"]')).toBeDisabled();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});
