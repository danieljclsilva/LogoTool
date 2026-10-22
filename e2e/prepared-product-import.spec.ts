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
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { extractEmbeddedProjectPackage } from '../src/packaging/self-contained-html/index.js';

// Prepared-product import roundtrip (inspector bridge -> Builder -> customer
// file -> placements in the same mm regions -> confirm/save/reopen ->
// baseline review -> candidate JSON consistent). Opens built pages and
// generated packages through file:// in offline contexts with synthetic
// fixtures only. Every test asserts zero console/page errors and zero
// HTTP(S) requests.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256Text: Sha256HexFn = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const FIXTURE_PATH = resolve(process.cwd(), 'e2e/fixtures/prepared-bridge-product.json');
const REVIEW_HTML = pathToFileURL(resolve(process.cwd(), 'dist/dev/customer-return-review.html')).href;

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
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
  return { context, page, probe };
}

async function createFromCatalogue(page: Page): Promise<void> {
  await (await shown(page, 'start-create')).click();
  await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
}

async function importPreparedFixture(page: Page): Promise<void> {
  // The Add button opens the native file picker for human operators; the
  // file input itself drives the import, so automation sets files directly.
  await expect(await shown(page, 'prepared-product-add')).toBeEnabled();
  await (await shown(page, 'prepared-product-file')).setInputFiles(FIXTURE_PATH);
  await expect(await shown(page, 'product-status')).toContainText('Imported prepared product with');
}

async function issueCustomerFile(page: Page, job: string): Promise<{ issuedProjectId: string }> {
  await (await shown(page, 'step-details')).click();
  await (await shown(page, 'customer-name')).fill(CUSTOMER);
  await (await shown(page, 'job-ref')).fill(job);
  await (await shown(page, 'issued-by')).fill(ISSUED_BY);
  await revealBuilderControl(page, 'project-id');
  const issuedProjectId = await builder(page, 'project-id').inputValue();
  assert.ok(issuedProjectId.length > 0);
  await (await shown(page, 'generate')).click();
  await expect(await shown(page, 'generate-status')).toContainText(`Customer file ready (revision 1)`);
  return { issuedProjectId };
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

test('imports a prepared product and issues it with exact mm geometry and sidecar evidence', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await createFromCatalogue(page);
    await importPreparedFixture(page);
    // The imported product is listed and selected for the issue.
    const checked = await page.evaluate((): string[] => {
      const root = document.querySelector('[data-builder-hook="product-list"]');
      if (!root) throw new Error('Missing builder product list.');
      return Array.from(root.querySelectorAll('input[type="checkbox"]'))
        .filter((element) => (element as HTMLInputElement).checked && !(element as HTMLInputElement).hasAttribute('data-product'))
        .map((element) => (element as HTMLInputElement).value);
    });
    expect(checked).toContain('SYN-BRIDGE-001');

    // A malformed file fails atomically and keeps the imported product.
    const badPath = test.info().outputPath('not-a-product.json');
    await writeFile(badPath, '{"product": {"id": 7}}');
    await (await shown(page, 'prepared-product-file')).setInputFiles(badPath);
    await expect(await shown(page, 'product-status')).toContainText('Could not import prepared product');
    const kept = await page.evaluate((): string[] => {
      const root = document.querySelector('[data-builder-hook="product-list"]');
      if (!root) throw new Error('Missing builder product list.');
      return Array.from(root.querySelectorAll('input[type="checkbox"]')).map((element) => (element as HTMLInputElement).value);
    });
    expect(kept).toContain('SYN-BRIDGE-001');

    const { issuedProjectId } = await issueCustomerFile(page, 'BRIDGE-JOB-1');
    const officeCopy = await readDownload(page, 'office-copy.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()),
    );
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
    const customerHtml = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      shown(page, 'download-package').then((control) => control.click()),
    );
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
  // Empty start: the imported product arrives unselected; select everything
  // deliberately before issuing.
  await selectAllLists(page);
  const { issuedProjectId } = await issueCustomerFile(page, job);
  const officeCopy = await readDownload(page, 'office-copy.logo-project', () =>
    shown(page, 'download-baseline').then((control) => control.click()),
  );
  const officeParsed = await parseProjectPackage(officeCopy, { sha256 });
  const preparedConfig = officeParsed.project.configurations.find((config) => config.productId === 'SYN-BRIDGE-001');
  assert.ok(preparedConfig, 'issued project should configure the imported prepared product');
  const uploadedLogo = officeParsed.project.logos.find((logo) => logo.name === 'bridge mark');
  assert.ok(uploadedLogo, 'issued project should carry the uploaded raster logo');
  const customerHtml = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
    shown(page, 'download-package').then((control) => control.click()),
  );
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
  await expect(editor.locator('[data-customer-hook="geometry"]')).toContainText('Fits: no');
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

test('customer places in the imported mm region, confirms, saves and reopens', async ({ browser }) => {
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

    // Baseline review in the standalone reviewer: candidate JSON is consistent.
    const reviewer = await context.newPage();
    attachProbe(reviewer, probe);
    await reviewer.goto(REVIEW_HTML);
    await expect(reviewer.locator('h1')).toHaveText('Review a customer return');
    await reviewer.locator('[data-review-hook="baseline-file"]').setInputFiles({
      name: 'office-copy.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(officeCopy),
    });
    await expect(reviewer.locator('[data-review-hook="status"]')).toContainText('Opened the saved copy');
    await reviewer.locator('[data-review-hook="return-file"]').setInputFiles({
      name: 'bridge-return.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(returnBytes),
    });
    await expect(reviewer.locator('[data-review-hook="review-panel"]')).toBeVisible();
    await expect(reviewer.locator('[data-review-hook="candidate-status"]')).toContainText('candidate-pending-review');
    // The candidate download lives inside the collapsed Technical details
    // disclosure; expand it through its summary like a human operator.
    await reviewer.evaluate(() => {
      const details = document.querySelector<HTMLDetailsElement>('[data-review-hook="technical-details"]');
      if (!details) throw new Error('Missing technical details disclosure.');
      details.open = true;
    });
    await expect(reviewer.locator('[data-review-hook="technical-details"]')).toHaveAttribute('open', '');
    const candidateTextPromise = reviewer.waitForEvent('download');
    await reviewer.locator('[data-review-hook="candidate-download"]').click();
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

test('rejects tampered evidence digests and discards obsolete evidence hashes', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await createFromCatalogue(page);
    await importPreparedFixture(page);

    // Tampered digest: identical evidence text but a forged SHA-256 under a
    // distinct product id (reusing the imported id would fail earlier on
    // duplicate-id, never reaching the cryptographic check). The hash check —
    // not the kernel's format check — must reject it before anything is
    // committed; the previous source stays intact and the forgery is absent.
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
    await (await shown(page, 'prepared-product-file')).setInputFiles(tamperedPath);
    await expect(await shown(page, 'product-status')).toContainText('evidence hash mismatch');
    const kept = await page.evaluate((): string[] => {
      const root = document.querySelector('[data-builder-hook="product-list"]');
      if (!root) throw new Error('Missing builder product list.');
      return Array.from(root.querySelectorAll('input[type="checkbox"]')).map((element) => (element as HTMLInputElement).value);
    });
    expect(kept).toContain('SYN-BRIDGE-001');
    expect(kept.filter((id) => id === 'SYN-BRIDGE-001')).toHaveLength(1);
    expect(kept).not.toContain('SYN-BRIDGE-FORGED');

    // Obsolete hash: hold the first SubtleCrypto digest (the evidence hash),
    // obsolete the import by staging a product, then release. The late hash
    // must be discarded: no second product, no success status, prior source
    // and outputs preserved.
    const secondPath = test.info().outputPath('second-product.json');
    const second = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { product: { id: string } };
    second.product.id = 'SYN-BRIDGE-002';
    await writeFile(secondPath, JSON.stringify(second));
    await page.evaluate(() => {
      const native = crypto.subtle.digest.bind(crypto.subtle);
      const state = window as Window & { releaseDigest?: () => void; digestHeld?: boolean; digestDone?: boolean };
      let held = false;
      crypto.subtle.digest = (algorithm, data) => {
        if (!held) {
          held = true;
          state.digestHeld = true;
          return new Promise<ArrayBuffer>((resolve, reject) => { state.releaseDigest = () => { void native(algorithm, data).then((bytes) => { state.digestDone = true; resolve(bytes); }, reject); }; });
        }
        return native(algorithm, data);
      };
    });
    await (await shown(page, 'prepared-product-file')).setInputFiles(secondPath);
    await expect(await shown(page, 'product-status')).toContainText('Reading prepared product');
    // Wait until the evidence hash is actually held before obsoleting the
    // import: the release below must free a stale hash, not win a race.
    await expect.poll(() => page.evaluate(() => (window as Window & { digestHeld?: boolean }).digestHeld)).toBe(true);
    await (await shown(page, 'product-file')).setInputFiles({
      name: 'synthetic-block.glb',
      mimeType: 'model/gltf-binary',
      buffer: Buffer.from(readFileSync('examples/models/synthetic-block.glb')),
    });
    await expect(await shown(page, 'product-status')).toContainText('Staged 3D model');
    await page.evaluate(() => (window as Window & { releaseDigest?: () => void }).releaseDigest!());
    await expect.poll(() => page.evaluate(() => (window as Window & { digestDone?: boolean }).digestDone)).toBe(true);
    const products = await page.evaluate((): string[] => {
      const root = document.querySelector('[data-builder-hook="product-list"]');
      if (!root) throw new Error('Missing builder product list.');
      return Array.from(root.querySelectorAll('input[type="checkbox"]')).map((element) => (element as HTMLInputElement).value);
    });
    expect(products).not.toContain('SYN-BRIDGE-002');
    expect(products).toContain('SYN-BRIDGE-001');
    expect(await shown(page, 'product-status')).not.toContainText('Imported prepared product SYN-BRIDGE-002');
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});
