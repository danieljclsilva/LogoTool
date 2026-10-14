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
  const archive = new Uint8Array(await fs.readFile(resolve('dist/synthetic-customer-prototype.zip')));
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
  await expect(page).toHaveTitle(/Synthetic Customer Editor/);
  await expect(page.locator('#customer-editor h1')).toHaveText('LogoTool · Synthetic Customer Editor');
  await expect(page.locator('[data-customer-hook="choose"]')).toBeVisible();
}

async function choosePackage(page: Page, path: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
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
  await expect(page.locator('[data-customer-hook="status"]')).toContainText(`Loaded ${fileName}`);
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
  await page.locator(`[data-customer-hook="${hook}"]`).fill(String(value));
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
    await page.locator('[data-customer-hook="confirmed-by"]').fill('initial synthetic reviewer');
    await page.locator('[data-customer-hook="confirm"]').click();
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('Current confirmation');
    await expect(page.locator('[data-customer-hook="configuration"] option')).toHaveCount(2);
    await expect(page.locator('[data-customer-hook="canvas"] polygon.safe-area')).toHaveCount(1);
    await expect(page.locator('[data-customer-hook="canvas"] image, [data-customer-hook="canvas"] img')).toHaveCount(0);

    await page.locator('[data-customer-hook="configuration"]').selectOption('SYN-CFG-TEE-M');
    await page.locator('[data-customer-hook="region"]').selectOption('SYN-TEE-CHEST');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 0 mm, 10 mm');
    await setNumber(page, 'x-mm', 4);
    await setNumber(page, 'y-mm', 12);
    await setNumber(page, 'width-mm', 76);
    await setNumber(page, 'height-mm', 38);
    await setNumber(page, 'rotation', 15);
    await page.locator('[data-customer-hook="placement-instructions"]').fill('Keep the seam clear.');
    await page.locator('[data-customer-hook="instructions"]').fill('Both measurement and project instructions change in one revision.');
    await page.locator('[data-customer-hook="method"]').selectOption('embroidery');
    await page.locator('[data-customer-hook="update"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 1));
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 4 mm, 12 mm');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Width × height: 76 mm × 38 mm');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Clockwise rotation: 15°');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Frame: FRAME-SYN-CHEST');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Axes: +x right; +y up');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Calibration: CAL-SYN-001 v1');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('SYN-CFG-TR-REG');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Placement instructions: Keep the seam clear.');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Project instructions: Both measurement and project instructions change in one revision.');
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText(/Previous confirmation.*stale/i);

    await page.locator('[data-customer-hook="configuration"]').selectOption('SYN-CFG-TR-REG');
    await page.locator('[data-customer-hook="remove"]').click();
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(1);
    await page.locator('[data-customer-hook="logo"]').selectOption('SYN-LOGO-B');
    await setNumber(page, 'x-mm', 0);
    await setNumber(page, 'y-mm', 0);
    await setNumber(page, 'width-mm', 52);
    await setNumber(page, 'height-mm', 24);
    await setNumber(page, 'rotation', 0);
    await page.locator('[data-customer-hook="method"]').selectOption('print');
    await page.locator('[data-customer-hook="add"]').click();
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(2);
    await page.locator('[data-customer-hook="add"]').click();
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(3);
    await page.locator('[data-customer-hook="configuration"]').selectOption('SYN-CFG-TEE-M');
    await page.locator('[data-customer-hook="variant"]').selectOption('SYN-TEE-XL');
    await expect(page.locator('[data-customer-hook="configuration"] option')).toHaveCount(3);
    await expect(page.locator('[data-customer-hook="variant"]')).toHaveValue('SYN-TEE-XL');
    await page.locator('[data-customer-hook="product"]').selectOption('SYN-TR-001');
    await expect(page.locator('[data-customer-hook="variant"]')).toHaveValue('SYN-TR-REG');
    await page.locator('[data-customer-hook="region"]').selectOption('SYN-TR-THIGH-R');
    await expect(page.locator('[data-customer-hook="frame"]')).toContainText('FRAME-SYN-THIGH-R');
    await page.locator('[data-customer-hook="variant"]').selectOption('SYN-TR-SHORT');
    await expect(page.locator('[data-customer-hook="configuration"] option')).toHaveCount(4);
    await expect(page.locator('[data-customer-hook="region"]')).toHaveValue('SYN-TR-THIGH-L');

    await page.locator('[data-customer-hook="configuration"]').selectOption('SYN-CFG-TEE-M');
    await page.locator('[data-customer-hook="instructions"]').fill('Synthetic customer instruction: use the updated centered placement.');
    await page.locator('[data-customer-hook="update"]').click();
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText(/Previous confirmation.*stale/i);
    await page.locator('[data-customer-hook="confirmed-by"]').fill('offline prototype reviewer');
    await page.locator('[data-customer-hook="confirm"]').click();
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('Current confirmation');
    await expect(page.locator('[data-customer-hook="submit"]')).toBeEnabled();

    const savedBytes = await saveDownloadedFile(page, join(prototype.directory, 'confirmed customer return.logo-project'), async () => {
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
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('Current confirmation');
    await page.locator('[data-customer-hook="configuration"]').selectOption('SYN-CFG-TEE-M');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 4 mm, 12 mm');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Width × height: 76 mm × 38 mm');
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
    await page.locator('[data-customer-hook="confirmed-by"]').fill('should remain unconfirmed');
    await setNumber(page, 'y-mm', 0);
    await page.locator('[data-customer-hook="update"]').click();
    await expect(page.locator('[data-customer-hook="geometry"]')).toContainText('Fit: no');
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
      await page.locator('[data-customer-hook="save"]').press('Enter');
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
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Drag cancelled');
    const cancelledPointer = await startDrag(page);
    await page.evaluate(({ pointerId }) => {
      const canvas = document.querySelector<SVGSVGElement>('[data-customer-hook="canvas"]');
      if (!canvas) throw new Error('Missing canvas for pointercancel.');
      canvas.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId, isPrimary: true }));
    }, cancelledPointer);
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(committedRevision));
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Drag cancelled');

    const lostCapture = await startDrag(page);
    await page.evaluate(({ pointerId }) => {
      const canvas = document.querySelector<SVGSVGElement>('[data-customer-hook="canvas"]');
      if (!canvas?.hasPointerCapture(pointerId)) throw new Error('Expected the gesture surface to hold pointer capture.');
      canvas.releasePointerCapture(pointerId);
    }, lostCapture);
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Drag cancelled');
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(committedRevision));

    const blurred = await startDrag(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('window lost focus');
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(committedRevision));
    expect(blurred.pointerId).toBeGreaterThan(0);
    await startDrag(page);
    await page.locator('[data-customer-hook="configuration"]').selectOption('SYN-CFG-TR-REG');
    await page.mouse.up();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(committedRevision));
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Drag cancelled because the editing context changed');

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
    await page.locator('[data-customer-hook="confirm"]').click();
    await page.waitForFunction(() => (window as Window & { __deferredCustomerDigest?: DeferredDigest }).__deferredCustomerDigest?.started === true);
    const otherConfiguration = await page.locator('[data-customer-hook="configuration"] option').nth(1).getAttribute('value');
    if (!otherConfiguration) throw new Error('Expected a second configuration for stale confirmation context switching.');
    await page.locator('[data-customer-hook="configuration"]').selectOption(otherConfiguration);
    await page.evaluate(() => {
      const deferred = (window as Window & { __deferredCustomerDigest?: DeferredDigest }).__deferredCustomerDigest;
      if (!deferred?.release) throw new Error('The delayed confirmation digest was not ready.');
      deferred.release();
    });
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Confirmation cancelled');
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
    await page.locator('[data-customer-hook="save"]').click();
    await page.waitForFunction(() => (window as Window & { __deferredSaveDigest?: DeferredDigest }).__deferredSaveDigest?.started === true);
    const currentConfiguration = await page.locator('[data-customer-hook="configuration"] option').first().getAttribute('value');
    if (!currentConfiguration) throw new Error('Expected a configuration to switch while draft save is pending.');
    await page.locator('[data-customer-hook="configuration"]').selectOption(currentConfiguration);
    await page.evaluate(() => {
      const deferred = (window as Window & { __deferredSaveDigest?: DeferredDigest }).__deferredSaveDigest;
      if (!deferred?.release) throw new Error('The delayed package asset digest was not ready.');
      deferred.release();
    });
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('cancelled because the project changed');
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
    await page.locator('[data-customer-hook="confirmed-by"]').fill('Synthetic undo reviewer');
    await page.locator('[data-customer-hook="confirm"]').click();
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText(`Current confirmation for revision ${issuedRevision}`);
    await setNumber(page, 'x-mm', 25);
    await page.locator('[data-customer-hook="update"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 1));

    await setNumber(page, 'x-mm', 15);
    await page.locator('[data-customer-hook="update"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 2));
    await page.locator('[data-customer-hook="undo"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 3));
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 25 mm, 10 mm');

    await page.locator('[data-customer-hook="undo"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 4));
    await expect(page.locator('[data-customer-hook="undo"]')).toBeDisabled();
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 0 mm, 10 mm');

    await setNumber(page, 'x-mm', 40);
    await page.locator('[data-customer-hook="update"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 5));
    await page.locator('[data-customer-hook="reset"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(String(issuedRevision + 6));
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 0 mm, 10 mm');
    await expect(page.locator('[data-customer-hook="instructions"]')).toHaveValue(/Synthetic fixture instructions/);
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText(/No current customer confirmation|stale/i);
    await captureBothViewports(page, info);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});
