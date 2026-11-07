import { gotoBuilder, revealBuilderControl, revealCustomerControl, selectCustomerOption } from './helpers.js';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCandidateExport } from '../src/core/index.js';
import type { ProjectDocument, Sha256HexFn } from '../src/core/index.js';
import { appendPreparedProduct, preparedEvidencePaths } from '../src/core/project-builder/prepared-import.js';
import { assertProjectEditorLimits } from '../src/core/project-editor/index.js';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { extractEmbeddedProjectPackage } from '../src/packaging/self-contained-html/index.js';

// Prepared-product roundtrip (developer conversion output -> ordinary Open
// saved project -> customer file -> placements in the same mm regions ->
// confirm/save/reopen -> baseline review -> candidate JSON consistent). The
// station no longer offers a prepared-JSON import control: prepared products
// reach the operator as ordinary saved projects, built here in Node through
// the same validated core (append + exact-byte evidence-hash check +
// packaging) the removed station control used to run. Opens built pages and
// generated packages through file:// in offline contexts with synthetic
// fixtures only. Every test asserts zero console/page errors and zero
// HTTP(S) requests.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256Text: Sha256HexFn = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const FIXTURE_PATH = resolve(process.cwd(), 'e2e/fixtures/prepared-bridge-product.json');

const CUSTOMER = 'Acme Athletics';
const ISSUED_BY = 'Internal operator';

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

function attachProbe(page: Page, probe: Probe): void {
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
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

async function openBuilder(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<{
  context: BrowserContext;
  page: Page;
  probe: Probe;
}> {
  await test.info().attach('prepared-import-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform,
      release: release(),
      arch: process.arch,
      browser: browser.browserType().name(),
      browserVersion: browser.version(),
      viewport,
      offline: true,
      entryPoint: 'file://dist/station/Logo Station.html',
      prototype: 'prepared product import',
    }, null, 2),
  });
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  attachProbe(page, probe);
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  await gotoBuilder(page);
  await expect(page.getByRole('heading', { name: 'Prepare an operational document' })).toBeVisible();
  await page.locator('[data-builder-hook="job-landing-create"]').click();
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Prepare the job' })).toBeVisible();
  return { context, page, probe };
}

async function createFromCatalogue(page: Page): Promise<void> {
  // Landing create already lands on Prepare job: no hidden wizard steps to
  // advance through.
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
}

/**
 * Developer-side prepared build: append the bridge fixture to a fresh draft,
 * verify the evidence digest over the EXACT bytes that will be packaged, and
 * emit an ordinary saved project. Mirrors the checks the former station
 * import control applied, so tampered evidence fails here before the station
 * ever sees it; the station only ever Opens the resulting saved project.
 */
async function buildPreparedProjectPackage(fixturePath: string = FIXTURE_PATH): Promise<{ fileName: string; bytes: Uint8Array }> {
  const parsed: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const base: ProjectDocument = {
    schemaVersion: '0.1.0-provisional',
    projectId: 'SYN-PREPARED-BASE',
    revision: 1,
    products: [],
    logos: [],
    configurations: [],
  };
  const appended = appendPreparedProduct(base, parsed);
  if (!appended.ok) {
    throw new Error(`prepared product rejected: ${appended.errors.map((error) => `${error.code} at ${error.path}`).join('; ')}`);
  }
  const importedProductId = appended.project.products[appended.project.products.length - 1]!.id;
  if (appended.areaBundleText === null) {
    throw new Error('prepared product rejected: area bundle text supplied without its SHA-256; refusing to package unverified evidence');
  }
  if (appended.areaBundleSha256 === null) {
    throw new Error('prepared product rejected: area bundle text supplied without its SHA-256; refusing to package unverified evidence');
  }
  const evidenceBytes = new Uint8Array(Buffer.from(appended.areaBundleText, 'utf8'));
  const evidenceDigest = createHash('sha256').update(evidenceBytes).digest('hex');
  if (evidenceDigest !== appended.areaBundleSha256) {
    throw new Error('prepared product rejected: evidence hash mismatch at areaBundleSha256 (recorded digest does not match the evidence bytes); refusing to package unverified evidence');
  }
  const evidencePaths = preparedEvidencePaths(importedProductId);
  const additionalAssets: Array<{ path: string; bytes: Uint8Array }> = [];
  if (appended.sidecar !== null && typeof appended.sidecar === 'object') {
    additionalAssets.push({ path: evidencePaths.sidecar, bytes: new Uint8Array(Buffer.from(JSON.stringify(appended.sidecar, null, 2), 'utf8')) });
  }
  additionalAssets.push({ path: evidencePaths.areaBundle, bytes: evidenceBytes });
  assertProjectEditorLimits(appended.project);
  const packageBytes = await createProjectPackage(
    { project: appended.project, assets: [], additionalAssets },
    { sha256 },
  );
  return { fileName: 'prepared-bridge.logo-project', bytes: packageBytes };
}

async function importPreparedFixture(page: Page): Promise<void> {
  // No prepared-JSON import control remains in normal station UI: the
  // prepared product arrives as an ordinary saved project through the real
  // Open control, exactly as an operator reopens handoff work.
  const { fileName, bytes } = await buildPreparedProjectPackage();
  await page.locator('[data-builder-hook="job-open-file"]').setInputFiles({
    name: fileName, mimeType: 'application/zip', buffer: Buffer.from(bytes),
  });
  await expect(page.locator('[data-builder-hook="source-status"]')).toContainText(`Loaded ${fileName}`);
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
  await expect(await shown(page, 'product-status')).not.toContainText('Could not');
}

function approvalBranch(page: Page) {
  return page.locator('[data-job-branch="approval"]');
}

/** Placements entry: Step 1 -> placements, explicit product/option scope where
 * the workspace offers a choice, then the approval branch. */
async function enterApprovalBranch(page: Page): Promise<import('@playwright/test').Locator> {
  await page.locator('[data-builder-hook="job-to-placements"]').click();
  await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
  for (const selectHook of ['pw-product-select', 'pw-option-select']) {
    const select = page.locator(`[data-placement-hook="${selectHook}"]`);
    if (await select.count() > 0) {
      const value = await select.evaluate((element) => (element as HTMLSelectElement).options[0]?.value ?? '');
      if (value !== '') await select.selectOption(value);
    }
  }
  await page.getByRole('button', { name: 'Send for customer approval' }).click();
  const branch = approvalBranch(page);
  await expect(branch).toBeVisible();
  await expect(branch.getByRole('heading', { name: 'Send for customer approval' })).toBeVisible();
  return branch;
}

async function issueCustomerFile(page: Page, job: string): Promise<{ issuedProjectId: string }> {
  // Identity lives directly on Step 1 (Prepare the job) in the job shell.
  await (await shown(page, 'customer-name')).fill(CUSTOMER);
  await (await shown(page, 'job-ref')).fill(job);
  await (await shown(page, 'issued-by')).fill(ISSUED_BY);
  const branch = await enterApprovalBranch(page);
  await (await shown(page, 'job-issue-project-new')).click();
  const issuedProjectId = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
  assert.ok(issuedProjectId.length > 0);
  await branch.getByRole('button', { name: 'Create customer file', exact: true }).click();
  await expect(branch.getByText('Customer file created')).toBeVisible();
  return { issuedProjectId };
}

async function readOfficeCopy(page: Page, fileName: string): Promise<Uint8Array> {
  return readDownload(page, fileName, () =>
    approvalBranch(page).getByRole('button', { name: 'Save office copy', exact: true }).click());
}

async function readCustomerFile(page: Page, fileName: string): Promise<Uint8Array> {
  return readDownload(page, fileName, () =>
    approvalBranch(page).getByRole('button', { name: 'Save customer file', exact: true }).click());
}

/** Synthetic 20x10 PNG bytes rendered in the page (exact original bytes). */
async function syntheticPngBytes(page: Page): Promise<Uint8Array> {
  const base64 = await page.evaluate((): string => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 10;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d canvas unavailable for synthetic PNG fixture.');
    context.fillStyle = '#3a6f1d';
    context.fillRect(0, 0, 20, 10);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function readDownload(page: Page, fileName: string, trigger: () => Promise<void>): Promise<Uint8Array> {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  const download = await downloadPromise;
  const outputPath = test.info().outputPath(fileName);
  await download.saveAs(outputPath);
  return new Uint8Array(await readFile(outputPath));
}

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

/** Empty start leaves all boxes unchecked: tick every list deliberately. */
async function selectAllLists(page: Page): Promise<void> {
  for (const listHook of ['product-list', 'logo-list', 'configuration-list']) {
    await shown(page, listHook);
    const list = builder(page, listHook);
    const boxes = list.locator('input[type="checkbox"]');
    const count = await boxes.count();
    for (let index = 0; index < count; index += 1) {
      const box = boxes.nth(index);
      if (listHook === 'configuration-list') await setChecked(box, true);
      else if (await box.isVisible() && await box.isEnabled()) await box.check();
    }
  }
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.networkRequests).toEqual([]);
}

test('opens a prepared saved project and issues it with exact mm geometry and sidecar evidence', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await createFromCatalogue(page);
    await importPreparedFixture(page);
    // The prepared product is listed; the operator selects it for the issue.
    // Opening a saved project never pre-selects anything (empty start), so
    // tick the imported product deliberately like a human operator.
    const bridgeBox = builder(page, 'product-list').locator('input[type="checkbox"][value="SYN-BRIDGE-001"]');
    await bridgeBox.check();
    const checked = await page.evaluate((): string[] => {
      const root = document.querySelector('[data-builder-hook="product-list"]');
      if (!root) throw new Error('Missing builder product list.');
      return Array.from(root.querySelectorAll('input[type="checkbox"]'))
        .filter((element) => (element as HTMLInputElement).checked && !(element as HTMLInputElement).hasAttribute('data-product'))
        .map((element) => (element as HTMLInputElement).value);
    });
    expect(checked).toContain('SYN-BRIDGE-001');

    // A malformed saved project fails to open atomically and keeps the loaded project.
    // Ticking the product above dirtied the job, so opening raises the inline
    // Save/Discard/Keep-editing guard first: discard explicitly, then the
    // failed open must keep the previous project intact.
    const badPath = test.info().outputPath('not-a-product.logo-project');
    await writeFile(badPath, '{"product": {"id": 7}}');
    await page.locator('[data-builder-hook="job-open-file"]').setInputFiles(badPath);
    await expect(page.locator('[data-builder-hook="builder-alert"]')).toContainText('unsaved changes');
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText('Could not load not-a-product.logo-project');
    const kept = await page.evaluate((): string[] => {
      const root = document.querySelector('[data-builder-hook="product-list"]');
      if (!root) throw new Error('Missing builder product list.');
      return Array.from(root.querySelectorAll('input[type="checkbox"]')).map((element) => (element as HTMLInputElement).value);
    });
    expect(kept).toContain('SYN-BRIDGE-001');

    const { issuedProjectId } = await issueCustomerFile(page, 'BRIDGE-JOB-1');
    const officeCopy = await readOfficeCopy(page, 'office-copy.logo-project');
    const issued = await parseProjectPackage(officeCopy, { sha256 });
    expect(issued.project.revision).toBe(1);
    expect(issued.project.confirmation).toBeUndefined();
    expect(issued.project.review).toBeUndefined();
    const imported = issued.project.products.find((product) => product.id === 'SYN-BRIDGE-001');
    assert.ok(imported, 'issued project should contain the imported prepared product');
    expect(imported.regions.map((region) => region.id)).toEqual(['SYN-BRIDGE-CHEST']);
    expect(imported.regions[0]?.name).toBe('Chest');
    expect(imported.regions[0]?.safeArea).toEqual([[-100, -80], [100, -80], [100, 80], [-100, 80]]);
    expect(imported.regions[0]?.exclusions).toEqual([[[10, 10], [20, 10], [20, 20], [10, 20]]]);
    expect(imported.regions[0]?.calibrationRef).toEqual({ calibrationId: 'CAL-SYN-B1', version: 'v1' });
    expect(imported.regions[0]?.allowedMethods).toEqual(['embroidery', 'print']);
    expect(imported.calibrations).toEqual([{ id: 'CAL-SYN-B1', version: 'v1', description: expect.stringContaining('provisional') }]);
    const preparedConfigs = issued.project.configurations.filter((config) => config.productId === 'SYN-BRIDGE-001');
    expect(preparedConfigs).toHaveLength(1);
    expect(preparedConfigs[0]?.placements).toEqual([]);
    const sidecarAsset = issued.assets.find((asset) => asset.path === 'prepared/syn-bridge-001.bridge-sidecar.json');
    assert.ok(sidecarAsset, 'issued package should carry the bridge sidecar as evidence');
    const sidecar = JSON.parse(Buffer.from(sidecarAsset.bytes).toString('utf8')) as {
      labels: { product: { id: string } };
      limitations: string[];
    };
    expect(sidecar.labels.product.id).toBe('SYN-BRIDGE-001');
    expect(sidecar.limitations.join(' ')).toMatch(/planar/i);
    // The original area-bundle export ships VERBATIM: byte-identical to the
    // conversion input, with a matching SHA-256 — complete source evidence,
    // including the named exclusion identities the canonical polygons cannot
    // represent.
    const bundleAsset = issued.assets.find((asset) => asset.path === 'prepared/syn-bridge-001.area-bundle.json');
    assert.ok(bundleAsset, 'issued package should carry the original area-bundle export as evidence');
    const bundleText = Buffer.from(bundleAsset.bytes).toString('utf8');
    const fixtureText = readFileSync('e2e/fixtures/bridge-area-bundle.json', 'utf8');
    expect(bundleText).toBe(fixtureText);
    const fixtureEnvelope = JSON.parse(readFileSync('e2e/fixtures/prepared-bridge-product.json', 'utf8')) as { areaBundleSha256: string };
    expect(createHash('sha256').update(bundleText, 'utf8').digest('hex')).toBe(fixtureEnvelope.areaBundleSha256);
    const areaBundle = JSON.parse(bundleText) as {
      areas: Array<{ regionId: string; safePolygon: Array<{ x: number; y: number }> | null; exclusions: Array<{ id: string; name: string; polygon: Array<{ x: number; y: number }> }> }>;
    };
    const areaRecord = areaBundle.areas.find((area) => area.regionId === 'SYN-BRIDGE-CHEST');
    assert.ok(areaRecord, 'original export preserves the converted region record');
    expect(areaRecord.safePolygon).toHaveLength(4);
    expect(areaRecord.exclusions).toEqual([{ id: 'hole', name: 'Button hole', polygon: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }] }]);

    // The delivered self-contained customer file embeds the same bytes.
    const customerHtml = await readCustomerFile(page, 'OPEN_LOGO_CONFIGURATOR.html');
    const embedded = extractEmbeddedProjectPackage(customerHtml);
    assert.ok(embedded, 'customer HTML should embed the issued project package');
    const embeddedParsed = await parseProjectPackage(embedded, { sha256 });
    expect(embeddedParsed.project.products.map((product) => product.id)).toContain('SYN-BRIDGE-001');
    expect(embeddedParsed.assets.map((asset) => asset.path)).toContain('prepared/syn-bridge-001.bridge-sidecar.json');
    expect(embeddedParsed.assets.map((asset) => asset.path)).toContain('prepared/syn-bridge-001.area-bundle.json');

    await page.screenshot({ path: test.info().outputPath('prepared-import-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('prepared-import-mobile.png'), fullPage: true });
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

async function issuePreparedDelivery(page: Page, job: string): Promise<{
  issuedProjectId: string;
  preparedConfigId: string;
  uploadedLogoId: string;
  officeCopy: Uint8Array;
  customerHtml: Uint8Array;
}> {
  await createFromCatalogue(page);
  await importPreparedFixture(page);
  // The bridge fixture carries no logos: upload a real raster mark, which is
  // selected automatically; the customer places it below.
  const png = await syntheticPngBytes(page);
  await (await shown(page, 'logo-file')).setInputFiles({ name: 'bridge-mark.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(await shown(page, 'logo-status')).toContainText('Added bridge-mark.png');
  // Empty start: the opened project arrives unselected; select everything
  // deliberately before issuing.
  await selectAllLists(page);
  const { issuedProjectId } = await issueCustomerFile(page, job);
  const officeCopy = await readOfficeCopy(page, 'office-copy.logo-project');
  const officeParsed = await parseProjectPackage(officeCopy, { sha256 });
  const preparedConfig = officeParsed.project.configurations.find((config) => config.productId === 'SYN-BRIDGE-001');
  assert.ok(preparedConfig, 'issued project should configure the imported prepared product');
  const uploadedLogo = officeParsed.project.logos.find((logo) => logo.name === 'bridge mark');
  assert.ok(uploadedLogo, 'issued project should carry the uploaded raster logo');
  const customerHtml = await readCustomerFile(page, 'OPEN_LOGO_CONFIGURATOR.html');
  return { issuedProjectId, preparedConfigId: preparedConfig.id, uploadedLogoId: uploadedLogo.id, officeCopy, customerHtml };
}

async function placeConfirmAndSubmit(
  editor: Page,
  htmlPath: string,
  issuedProjectId: string,
  preparedConfigId: string,
  uploadedLogoId: string,
  outputPath: (name: string) => string,
): Promise<Uint8Array> {
  await editor.goto(pathToFileURL(htmlPath).href);
  await expect(editor.locator('[data-customer-hook="project-id"]')).toHaveText(issuedProjectId);
  await selectCustomerOption(editor, 'configuration', preparedConfigId);
  await selectCustomerOption(editor, 'region', 'SYN-BRIDGE-CHEST');
  await selectCustomerOption(editor, 'logo', uploadedLogoId);
  await selectCustomerOption(editor, 'method', 'embroidery');
  await revealCustomerControl(editor, 'x-mm');
  // Unsafe geometry first: centre (15, 15) with a 50x30 footprint overlaps the
  // forbidden hole (x 10..20, y 10..20), so the editor must report Fits: no
  // and keep confirmation/submission disabled. No control is bypassed.
  await editor.locator('[data-customer-hook="x-mm"]').fill('15');
  await editor.locator('[data-customer-hook="y-mm"]').fill('15');
  await revealCustomerControl(editor, 'width-mm');
  await editor.locator('[data-customer-hook="width-mm"]').fill('50');
  await revealCustomerControl(editor, 'height-mm');
  await editor.locator('[data-customer-hook="height-mm"]').fill('30');
  await revealCustomerControl(editor, 'add');
  await editor.locator('[data-customer-hook="add"]').click();
  await expect(editor.locator('[data-customer-hook="placement"] option')).toHaveCount(2);
  await expect(editor.locator('[data-customer-hook="geometry"]')).toHaveClass(/\binvalid\b/);
  await expect(editor.locator('[data-customer-hook="geometry-technical"]')).toContainText('Fits: no — footprint overlaps exclusions[0]');
  await expect(editor.locator('[data-customer-hook="confirm"]')).toBeDisabled();
  await expect(editor.locator('[data-customer-hook="submit"]')).toBeDisabled();
  await revealCustomerControl(editor, 'remove');
  await editor.locator('[data-customer-hook="remove"]').click();
  await expect(editor.locator('[data-customer-hook="placement"] option')).toHaveCount(1);
  // Safe geometry: centre (-40, -30) with the same size stays clear of the
  // hole and inside the safe area.
  await revealCustomerControl(editor, 'x-mm');
  await editor.locator('[data-customer-hook="x-mm"]').fill('-40');
  await editor.locator('[data-customer-hook="y-mm"]').fill('-30');
  await revealCustomerControl(editor, 'width-mm');
  await editor.locator('[data-customer-hook="width-mm"]').fill('50');
  await revealCustomerControl(editor, 'height-mm');
  await editor.locator('[data-customer-hook="height-mm"]').fill('30');
  await revealCustomerControl(editor, 'add');
  await editor.locator('[data-customer-hook="add"]').click();
  await expect(editor.locator('[data-customer-hook="placement"] option')).toHaveCount(2);
  await expect(editor.locator('[data-customer-hook="review"]')).toContainText('Center: -40.0 mm, -30.0 mm');
  await expect(editor.locator('[data-customer-hook="review"]')).toContainText('Width × height: 50.0 mm × 30.0 mm');
  await expect(editor.locator('[data-customer-hook="review-reference"]')).toContainText('Frame: FRAME-SYN-BRIDGE');
  await expect(editor.locator('[data-customer-hook="review-reference"]')).toContainText('Calibration: CAL-SYN-B1 v1');
  await revealCustomerControl(editor, 'confirmed-by');
  await editor.locator('[data-customer-hook="confirmed-by"]').fill('synthetic bridge reviewer');
  await revealCustomerControl(editor, 'confirm');
  await editor.locator('[data-customer-hook="confirm"]').click();
  await expect(editor.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed: version');
  const downloadPromise = editor.waitForEvent('download');
  await revealCustomerControl(editor, 'submit');
  await editor.locator('[data-customer-hook="submit"]').click();
  const download = await downloadPromise;
  const returnPath = outputPath('bridge-return.logo-project');
  await download.saveAs(returnPath);
  return new Uint8Array(await readFile(returnPath));
}

test('customer places in the prepared mm region, confirms, saves and reopens', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  const directory = await mkdtemp(join(tmpdir(), 'LogoTool prepared bridge roundtrip '));
  try {
    const { issuedProjectId, preparedConfigId, uploadedLogoId, customerHtml } = await issuePreparedDelivery(page, 'BRIDGE-JOB-2');
    const htmlPath = join(directory, 'OPEN_LOGO_CONFIGURATOR.html');
    await writeFile(htmlPath, customerHtml);
    const editor = await context.newPage();
    attachProbe(editor, probe);
    const returnBytes = await placeConfirmAndSubmit(editor, htmlPath, issuedProjectId, preparedConfigId, uploadedLogoId, (name) => test.info().outputPath(name));
    await editor.screenshot({ path: test.info().outputPath('prepared-customer-desktop.png'), fullPage: true });

    // Reopen the saved return: confirmation and exact mm review survive.
    await editor.locator('[data-customer-hook="file-input"]').setInputFiles(test.info().outputPath('bridge-return.logo-project'));
    await expect(editor.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed: version');
    await selectCustomerOption(editor, 'configuration', preparedConfigId);
    await expect(editor.locator('[data-customer-hook="review"]')).toContainText('Center: -40.0 mm, -30.0 mm');
    await editor.setViewportSize({ width: 390, height: 844 });
    expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await editor.screenshot({ path: test.info().outputPath('prepared-customer-mobile.png'), fullPage: true });
    await editor.close();
    expect(returnBytes.length).toBeGreaterThan(0);
    expectOfflineClean(probe);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await context.close();
  }
});

test('baseline review of the prepared-product return yields a consistent candidate', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  const directory = await mkdtemp(join(tmpdir(), 'LogoTool prepared bridge review '));
  try {
    const { issuedProjectId, preparedConfigId, uploadedLogoId, officeCopy, customerHtml } = await issuePreparedDelivery(page, 'BRIDGE-JOB-3');
    const htmlPath = join(directory, 'OPEN_LOGO_CONFIGURATOR.html');
    await writeFile(htmlPath, customerHtml);
    const editor = await context.newPage();
    attachProbe(editor, probe);
    const returnBytes = await placeConfirmAndSubmit(editor, htmlPath, issuedProjectId, preparedConfigId, uploadedLogoId, (name) => test.info().outputPath(name));
    await editor.close();

    // Branch review of the prepared-product return: the office copy plus the
    // customer return open in the approval branch, the validated changes show,
    // Use installs them, and the Step 3 review diagnostic candidate matches the
    // returned project bytes exactly.
    const reviewer = await context.newPage();
    attachProbe(reviewer, probe);
    await gotoBuilder(reviewer);
    await reviewer.locator('[data-builder-hook="job-landing-create"]').click();
    await expect(reviewer.locator('[data-job-step="prepare"]')).toBeVisible();
    await reviewer.locator('[data-builder-hook="job-response"]').click();
    const reviewBranch = reviewer.locator('[data-job-branch="approval"]');
    await expect(reviewBranch).toBeVisible();
    await reviewBranch.locator('input[aria-label="Choose the saved office copy for this job"]').setInputFiles({
      name: 'office-copy.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(officeCopy),
    });
    const responseStatus = reviewBranch.locator('section[aria-label="Customer response"] [role="status"]');
    await expect(responseStatus).toContainText('Office copy loaded');
    await reviewBranch.locator('input[aria-label="Choose the returned customer file"]').setInputFiles({
      name: 'bridge-return.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(returnBytes),
    });
    await expect(responseStatus).toContainText('Response checked against the office copy');
    await expect(responseStatus).toContainText('choose Use customer changes or Keep current job');
    await reviewBranch.getByRole('button', { name: 'Use customer changes', exact: true }).click();
    await expect(reviewer.locator('[data-job-step="placements"]')).toBeVisible();
    // Explicit inclusion for the scoped review: Use installs the validated
    // content unselected, and the review document/candidate covers only
    // checked products/setups. Tick everything deliberately, as on Step 1.
    await reviewer.locator('[data-builder-hook="job-step-1"]').click();
    await expect(reviewer.locator('[data-job-step="prepare"]')).toBeVisible();
    for (const listHook of ['product-list', 'logo-list', 'configuration-list']) {
      const list = reviewer.locator(`[data-builder-hook="${listHook}"]`);
      const boxes = list.locator('input[type="checkbox"]');
      for (let index = 0; index < await boxes.count(); index += 1) {
        const box = boxes.nth(index);
        if (await box.isVisible() && await box.isEnabled()) await box.check();
      }
    }
    await reviewer.locator('[data-builder-hook="job-step-3"]').click();
    await expect(reviewer.locator('[data-job-step="review"]')).toBeVisible();
    const reviewStep = reviewer.locator('[data-job-step="review"]');
    await reviewStep.locator('summary', { hasText: 'More output options' }).click();
    const candidateTextPromise = reviewer.waitForEvent('download');
    await reviewStep.getByRole('button', { name: 'Save diagnostic data', exact: true }).click();
    const candidateDownload = await candidateTextPromise;
    const candidatePath = await candidateDownload.path();
    assert.ok(candidatePath, 'candidate JSON download should be retained');
    const candidateJson = JSON.parse(await readFile(candidatePath, 'utf8')) as {
      status: string;
      digest: string;
      configurations: Array<{
        productId: string;
        placements: Array<{ pos: { xMm: number; yMm: number }; widthMm: number; heightMm: number; regionId: string }>;
      }>;
    };
    expect(candidateJson.status).toBe('candidate-pending-review');
    const returned = await parseProjectPackage(returnBytes, { sha256 });
    const expected = buildCandidateExport(returned.project, sha256Text);
    expect(candidateJson.digest).toBe(expected.digest);
    const prepared = candidateJson.configurations.find((config) => config.productId === 'SYN-BRIDGE-001');
    assert.ok(prepared, 'candidate should carry the imported product configuration');
    expect(prepared.placements).toHaveLength(1);
    expect(prepared.placements[0]).toMatchObject({
      regionId: 'SYN-BRIDGE-CHEST',
      pos: { xMm: -40, yMm: -30 },
      widthMm: 50,
      heightMm: 30,
    });
    await reviewer.close();
    expectOfflineClean(probe);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await context.close();
  }
});

test('rejects tampered evidence digests before the station ever sees them', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await createFromCatalogue(page);
    await importPreparedFixture(page);

    // Tampered digest: identical evidence text but a forged SHA-256. The
    // developer-side build hashes the exact bytes it would package and
    // refuses before anything reaches the station; the previously opened
    // project stays intact and the forgery is absent.
    const tamperedPath = test.info().outputPath('tampered-digest.json');
    const forged = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
      product: { id: string };
      sidecar: { labels: { product: { id: string } } };
      areaBundleSha256: string;
    };
    forged.product.id = 'SYN-BRIDGE-FORGED';
    forged.sidecar.labels.product.id = 'SYN-BRIDGE-FORGED';
    forged.areaBundleSha256 = 'cd'.repeat(32);
    await writeFile(tamperedPath, JSON.stringify(forged));
    await expect(buildPreparedProjectPackage(tamperedPath)).rejects.toThrow('evidence hash mismatch');
    const kept = await page.evaluate((): string[] => {
      const root = document.querySelector('[data-builder-hook="product-list"]');
      if (!root) throw new Error('Missing builder product list.');
      return Array.from(root.querySelectorAll('input[type="checkbox"]')).map((element) => (element as HTMLInputElement).value);
    });
    expect(kept).toContain('SYN-BRIDGE-001');
    expect(kept.filter((id) => id === 'SYN-BRIDGE-001')).toHaveLength(1);
    expect(kept).not.toContain('SYN-BRIDGE-FORGED');
    await expect(await shown(page, 'source-status')).toContainText('Loaded prepared-bridge.logo-project');
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});
