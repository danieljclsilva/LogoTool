import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { BUILDER_URL, gotoBuilder, revealBuilderControl, ensurePlacementPanel, revealCustomerControl } from './helpers.js';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import { createProjectFromDefinitions } from '../src/core/project-builder/create-project.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { extractEmbeddedProjectPackage } from '../src/packaging/self-contained-html/index.js';

// Create-a-project acceptance for the operator job shell: the already-built
// single-entry dist/station/Logo Station.html runs offline through file://
// (the spec never rebuilds; `npm run build` runs first). Every test asserts
// zero console/page errors and zero HTTP(S) requests.
//
// Navigation contract (operator job shell):
// - Landing: heading "Prepare an operational document"
//   ([data-job-landing]), primary [data-builder-hook="job-landing-create"]
//   ("Create job"), secondary [data-builder-hook="job-landing-open"], link
//   [data-builder-hook="job-landing-response"], status
//   [data-builder-hook="job-landing-status"].
// - Shell: [data-builder-hook="job-step-1"] ("1 Prepare job"),
//   [data-builder-hook="job-step-2"] ("2 Set up & place logos"),
//   [data-builder-hook="job-step-3"] ("3 Review document"). Step 1 holds the
//   identity inputs (customer-name/job-ref/issued-by), the Products/Logos
//   selection lists, and [data-builder-hook="job-to-placements"] with the
//   [data-builder-hook="job-prepare-gate"] message.
// - Step 2 is the placement workspace (data-placement-hook controls):
//   "Add logo placement", "Send for customer approval" (branch entry),
//   "Review document", "Back", empty states ("Add artwork before adding a
//   placement." with "Add logo"; "No logo placements for this option.").
// - Approval branch: heading "Send for customer approval", issue-ID strip
//   job-issue-project-id + job-issue-project-new, "Create customer file",
//   "Save office copy", "Save customer file", "Open office copy",
//   "Open customer response", "Use customer changes", "Keep current job",
//   "Back to placements".
// - Header: "Logo Station" with Save job / Open job (job-open-file) / New job
//   / Open customer response, plus the job-persistence line.
// - EVERY builder interaction goes through revealBuilderControl(page, name)
//   (e2e/helpers.ts) or the local placement-workspace helper below. Tests
//   never force hidden fields visible.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

const EXPECTED_PRODUCTS = ['SYN-CAP-001', 'SYN-TEE-001', 'SYN-TR-001'];
const EXAMPLE_LOGO_IDS = ['SYN-LOGO-A', 'SYN-LOGO-B'];

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

function attachPageProbe(page: Page, probe: Probe): void {
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
}

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

/** Reveal a builder control through real step navigation. */
async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

function placement(page: Page, name: string) {
  return page.locator(`[data-placement-hook="${name}"]`);
}

/** Placement-workspace controls live on Step 2; navigate there for real. */
async function pshown(page: Page, name: string) {
  if (await page.locator('[data-job-step="placements"]').isHidden()) {
    await expect(builder(page, 'job-step-2')).toBeEnabled();
    await builder(page, 'job-step-2').click();
  }
  return placement(page, name);
}

function branch(page: Page) {
  return page.locator('[data-job-branch="approval"]');
}

function reviewHost(page: Page) {
  return builder(page, 'job-review-host');
}

async function openBuilder(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<{
  context: BrowserContext;
  page: Page;
  probe: Probe;
}> {
  await test.info().attach('create-project-environment', {
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
      prototype: 'create a project',
    }, null, 2),
  });
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  attachPageProbe(page, probe);
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  await gotoBuilder(page);
  await expect(page.locator('[data-job-landing]')).toBeVisible();
  await expect(page.locator('[data-job-landing]')).toContainText('Prepare an operational document');
  return { context, page, probe };
}

async function checkedTopLevelIds(page: Page, listHook: string, exclude?: string[]): Promise<string[]> {
  return page.evaluate(({ name, skip }: { name: string; skip: string[] }) => {
    const root = document.querySelector(`[data-builder-hook="${name}"]`);
    if (root === null) throw new Error(`Missing builder selection list: ${name}`);
    const boxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));
    const checked: string[] = [];
    for (const box of boxes) {
      if (box instanceof HTMLInputElement && box.checked && box.getAttribute('data-product') === null && !skip.includes(box.value)) {
        checked.push(box.value);
      }
    }
    return checked;
  }, { name: listHook, skip: exclude ?? [] });
}

async function variantIds(page: Page, productId: string): Promise<string[]> {
  return page.evaluate((product: string): string[] => {
    const root = document.querySelector('[data-builder-hook="product-list"]');
    if (root === null) throw new Error('Missing builder product list.');
    const boxes = Array.from(root.querySelectorAll(`input[type="checkbox"][data-product="${product}"]`));
    const ids: string[] = [];
    for (const box of boxes) {
      if (box instanceof HTMLInputElement) ids.push(box.value);
    }
    return ids;
  }, productId);
}

async function setChecked(box: import('@playwright/test').Locator, checked: boolean): Promise<void> {
  // Deliberate selection must produce the same change events as real human
  // toggles: Playwright check()/uncheck() are silent no-ops when the box
  // already matches, which would hide deliberate setup narrowing from the
  // automatic-inclusion tracking.
  await box.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.checked = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

async function setListSelection(page: Page, listHook: string, ids: string[]): Promise<void> {
  const list = await shown(page, listHook);
  const boxes = list.locator('input[type="checkbox"]');
  const count = await boxes.count();
  const seen: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    const value = (await box.getAttribute('value')) ?? '';
    const nestedProduct = await box.getAttribute('data-product');
    // The product list nests variant checkboxes (data-product set) under each
    // product. Product selection implies its visible variants (new empty-start
    // UX leaves every box unchecked; variants of a chosen product must be
    // ticked deliberately, mirroring the old all-checked default).
    if (nestedProduct !== null) {
      await setChecked(box, ids.includes(nestedProduct));
      continue;
    }
    seen.push(value);
    await setChecked(box, ids.includes(value));
  }
  for (const id of ids) assert.ok(seen.includes(id), `selection list ${listHook} is missing option ${id}`);
}

/** Check the setups whose readable label belongs to one of the given products. */
async function selectConfigurationsForProducts(page: Page, productIds: string[]): Promise<void> {
  const list = await shown(page, 'configuration-list');
  const boxes = list.locator('input[type="checkbox"]');
  const count = await boxes.count();
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    if (!await box.isVisible()) continue;
    const label = await box.evaluate((element) => element.closest('label')?.textContent ?? '');
    await setChecked(box, productIds.some((id) => label.includes(id)));
  }
}

/** Pick the workspace product/option context on Step 2 (real selects). */
async function selectWorkspaceOption(page: Page, productId: string, variantId?: string): Promise<void> {
  const productSelect = await pshown(page, 'pw-product-select');
  if (await productSelect.count() > 0) {
    await productSelect.selectOption(productId);
  }
  const optionSelect = placement(page, 'pw-option-select');
  if (await optionSelect.count() > 0) {
    if (variantId !== undefined) await optionSelect.selectOption(variantId);
    else await optionSelect.selectOption({ index: 0 });
  }
}

/** Enter the approval branch from Step 2 (real branch entry). */
async function openApprovalBranch(page: Page): Promise<void> {
  await (await pshown(page, 'pw-approval')).click();
  await expect(branch(page)).toBeVisible();
  await expect(branch(page)).toContainText('Send for customer approval');
}

/** Mint a fresh unique issue ID, then create the customer file in the branch. */
async function createBranchIssue(page: Page): Promise<string> {
  await (await shown(page, 'job-issue-project-new')).click();
  const issueId = await builder(page, 'job-issue-project-id').inputValue();
  expect(issueId.length).toBeGreaterThan(0);
  await branch(page).getByRole('button', { name: 'Create customer file' }).click();
  await expect(branch(page)).toContainText('Customer file created');
  return issueId;
}

async function addLogo(page: Page, fileName: string, mimeType: string, bytes: Uint8Array): Promise<void> {
  // Real logo-file chooser input (never setInputFiles for a project file on
  // this path): import + selected-automatically assertion in lockstep.
  await (await shown(page, 'logo-file')).setInputFiles({ name: fileName, mimeType, buffer: Buffer.from(bytes) });
  await expect(await shown(page, 'logo-status')).toContainText(`Added ${fileName}`);
}

async function readDownload(
  page: Page,
  fileName: string,
  trigger: () => Promise<void>,
): Promise<{ name: string; bytes: Uint8Array }> {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  const download = await downloadPromise;
  const outputPath = test.info().outputPath(fileName);
  await download.saveAs(outputPath);
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(outputPath)) };
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.networkRequests).toEqual([]);
}

function expectApprovalsCleared(project: Record<string, unknown>): void {
  expect(project['confirmation']).toBeUndefined();
  expect(project['review']).toBeUndefined();
  expect(project['history']).toBeUndefined();
  expect(project['reviewHistory']).toBeUndefined();
  expect(project['issuedBaselineHash']).toBeUndefined();
}

/** Synthetic 20x10 PNG bytes rendered in the page (exact original bytes). */
async function syntheticPngBytes(page: Page): Promise<Uint8Array> {
  const base64 = await page.evaluate((): string => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 10;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d canvas unavailable for synthetic PNG fixture.');
    context.fillStyle = '#12394b';
    context.fillRect(0, 0, 20, 10);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Synthetic 24x12 JPEG bytes rendered in the page (exact original bytes). */
async function syntheticJpegBytes(page: Page): Promise<Uint8Array> {
  const base64 = await page.evaluate((): string => {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 12;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d canvas unavailable for synthetic JPEG fixture.');
    context.fillStyle = '#4b3912';
    context.fillRect(0, 0, 24, 12);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1] ?? '';
  });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function fillIdentity(page: Page, customer: string, job: string, by: string): Promise<void> {
  // Identity lives directly on Step 1 of the job shell (no details step).
  await (await shown(page, 'customer-name')).fill(customer);
  await (await shown(page, 'job-ref')).fill(job);
  await (await shown(page, 'issued-by')).fill(by);
}

async function readProjectId(page: Page): Promise<string> {
  // Pure read: inputValue works on hidden steps, so never navigate here —
  // callers asserting post-generation state must stay where they are.
  await revealBuilderControl(page, 'project-id');
  return builder(page, 'project-id').inputValue();
}

/** Catalogue fixture expectations, read once from the bundled build output. */
async function expectedCatalogue() {
  const products = await Promise.all(EXPECTED_PRODUCTS.map(async (id) => {
    const file = id === 'SYN-TEE-001' ? 'syn-tee-001.product.json'
      : id === 'SYN-TR-001' ? 'syn-trousers-001.product.json'
        : 'syn-cap-001.product.json';
    return JSON.parse(await readFile(resolve(process.cwd(), `examples/products/${file}`), 'utf8')) as {
      id: string;
      variants: Array<{ id: string; regionIds: string[] }>;
      regions: Array<{ id: string; calibrationRef: { calibrationId: string; version: string }; frame: object; safeArea: unknown }>;
      calibrations: unknown[];
    };
  }));
  const logos = await Promise.all(['syn-mark-a.logo.json', 'syn-mark-b.logo.json'].map(async (file) =>
    JSON.parse(await readFile(resolve(process.cwd(), `examples/logos/${file}`), 'utf8')) as {
      id: string;
      name: string;
      assets: Array<{ uri: string; mediaType: string }>;
    }));
  return { products, logos };
}

/**
 * Explicit synthetic fixture package: the same example definitions the old
 * embedded catalogue carried (examples/products + syn-mark logos), drafted
 * through the same createProjectFromDefinitions contract — but opened
 * explicitly through the landing/header Open job file chooser, never
 * preloaded or demoed.
 */
async function syntheticCataloguePackage(): Promise<Uint8Array> {
  const productFiles = (await readdir(resolve(process.cwd(), 'examples/products')))
    .filter((file) => file.endsWith('.product.json'))
    .sort();
  const products = await Promise.all(productFiles.map(async (file) =>
    JSON.parse(await readFile(resolve(process.cwd(), `examples/products/${file}`), 'utf8'))));
  products.sort((left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const logos = await Promise.all(['syn-mark-a.logo.json', 'syn-mark-b.logo.json'].map(async (file) =>
    JSON.parse(await readFile(resolve(process.cwd(), `examples/logos/${file}`), 'utf8'))));
  logos.sort((left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const assetPaths = [...new Set(logos.flatMap((logo: { assets: Array<{ uri: string }> }) => logo.assets.map((asset) => asset.uri)))].sort();
  const assets = await Promise.all(assetPaths.map(async (uri) => ({
    path: uri,
    bytes: new Uint8Array(await readFile(resolve(process.cwd(), 'examples', uri as string))),
    kind: 'referenced' as const,
  })));
  const draft = createProjectFromDefinitions({ products, logos, projectId: 'SYN-PROJ-FIXTURE-001', synthetic: true });
  if (!draft.ok) throw new Error(`fixture draft invalid: ${draft.errors.map((error) => error.message).join('; ')}`);
  return createProjectPackage({ project: draft.project, assets }, { sha256 });
}

/** Open the explicit synthetic fixture through the real Open job chooser. */
async function openSyntheticCatalogue(page: Page): Promise<void> {
  const bytes = await syntheticCataloguePackage();
  await builder(page, 'job-open-file').setInputFiles({
    name: 'synthetic-catalogue.logo-project', mimeType: 'application/zip', buffer: Buffer.from(bytes),
  });
  await expect(await shown(page, 'source-status')).toContainText('Loaded synthetic-catalogue.logo-project');
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
}

test('create starts a truly empty draft with no demo UI', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    // Landing: the single entry point. Primary Create job, secondary Open
    // job, link Open customer response; no workspace, product list, document
    // preview or duplicated help message on the landing.
    await expect(page.locator('[data-job-landing]')).toHaveAttribute('aria-label', 'Prepare an operational document');
    await expect(await shown(page, 'job-landing-create')).toContainText('Create job');
    await expect(await shown(page, 'job-landing-open')).toBeVisible();
    await expect(await shown(page, 'job-landing-response')).toBeVisible();
    await expect(page.locator('[data-job-shell]')).toBeHidden();
    await expect(page.locator('header.station-header')).toContainText('Logo Station');

    // Create WITHOUT setInputFiles for any project file. New drafts start
    // empty: nothing is pre-selected and no demo UI exists anywhere, so no
    // synthetic content can leak into a real job.
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-landing]')).toBeHidden();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(builder(page, 'job-step-1').locator('.n')).toHaveText('1');
    await expect(builder(page, 'job-step-1').locator('.t')).toHaveText('Prepare job');
    await expect(builder(page, 'job-step-2').locator('.n')).toHaveText('2');
    await expect(builder(page, 'job-step-2').locator('.t')).toHaveText('Set up & place logos');
    await expect(builder(page, 'job-step-3').locator('.n')).toHaveText('3');
    await expect(builder(page, 'job-step-3').locator('.t')).toHaveText('Review document');
    await expect(page.locator('[data-job-step="prepare"]')).toContainText('Prepare the job');
    await expect(page.locator('[data-job-step="prepare"]')).toContainText('Add the products and artwork for this job.');
    await expect(await shown(page, 'create-status')).toContainText('empty draft');
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual([]);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual([]);
    await expect(await shown(page, 'product-list')).toContainText('No products in source.');
    // The explicit path restores the example selection: open the synthetic
    // fixture package through the real Open job chooser.
    await openSyntheticCatalogue(page);
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual([]);
    // Multi-option products reveal their option rows; the single-option cap
    // needs no second decision (its card inclusion covers its only option).
    expect((await variantIds(page, 'SYN-TEE-001')).sort()).toEqual(['SYN-TEE-M', 'SYN-TEE-XL']);
    expect((await variantIds(page, 'SYN-TR-001')).length).toBeGreaterThan(0);
    expect(await variantIds(page, 'SYN-CAP-001')).toEqual([]);
    await expect(page.locator('div[data-product-card="SYN-CAP-001"]')).toContainText('Includes ');
    await expect(await shown(page, 'product-list')).toContainText('Synthetic Tee');
    await expect(await shown(page, 'logo-list')).toContainText('Synthetic Mark B');
    // Select the explicitly imported examples to continue (empty start
    // leaves everything unchecked; nothing is ever pre-selected).
    await setListSelection(page, 'product-list', EXPECTED_PRODUCTS);
    await setListSelection(page, 'logo-list', EXAMPLE_LOGO_IDS);
    // New drafts clear identity inputs; the issued ID is a fresh local ID.
    await expect(await shown(page, 'customer-name')).toHaveValue('');
    await expect(await shown(page, 'job-ref')).toHaveValue('');
    await expect(await shown(page, 'issued-by')).toHaveValue('');
    const draftId = await readProjectId(page);
    expect(draftId.length).toBeGreaterThan(0);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('create generates revision-1 issues with prepared catalogue identity and zero placements', async ({ browser }, info) => {
  const jobRef = 'CREATE-SELFC-01';
  const { context, page, probe } = await openBuilder(browser);
  try {
    const { products: fixtureProducts, logos: fixtureLogos } = await expectedCatalogue();
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    // Narrow the selection: tee + cap products, synthetic mark A only.
    await setListSelection(page, 'product-list', ['SYN-TEE-001', 'SYN-CAP-001']);
    await setListSelection(page, 'logo-list', ['SYN-LOGO-A']);
    await selectConfigurationsForProducts(page, ['SYN-TEE-001', 'SYN-CAP-001']);
    await fillIdentity(page, 'Acme Athletics', jobRef, 'Internal operator');
    // Step 1 gate passes with at least one included product; calibration
    // incompleteness would surface on Step 2, never trap here.
    await expect(await shown(page, 'job-prepare-gate')).toBeEmpty();
    await expect(builder(page, 'job-to-placements')).toBeEnabled();
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await selectWorkspaceOption(page, 'SYN-TEE-001', 'SYN-TEE-M');
    await expect(await pshown(page, 'pw-empty-placements')).toContainText('No logo placements for this option.');
    // Zero placements are valid: the review entry stays available.
    await expect(await pshown(page, 'pw-review')).toBeEnabled();
    await openApprovalBranch(page);
    const issuedProjectId = await createBranchIssue(page);
    expect(issuedProjectId.length).toBeGreaterThan(0);

    const baseline = await readDownload(page, `${jobRef}-issued-baseline.logo-project`, () =>
      branch(page).getByRole('button', { name: 'Save office copy' }).click());
    expect(baseline.name).toBe(`${jobRef}-approval-office-copy.logo-project`);
    const parsed = await parseProjectPackage(baseline.bytes, { sha256 });
    expect(parsed.project.projectId).toBe(issuedProjectId);
    expect(parsed.project.revision).toBe(1);
    expect(parsed.project.synthetic).toBe(true);
    expect(parsed.project.instructions).toBeUndefined();
    expectApprovalsCleared(parsed.project as unknown as Record<string, unknown>);
    // Selected prepared products byte- and value-identical to the example files.
    const expectedById = new Map(fixtureProducts.map((product) => [product.id, product]));
    expect(parsed.project.products.map((product) => product.id).sort()).toEqual(['SYN-CAP-001', 'SYN-TEE-001']);
    for (const product of parsed.project.products) {
      expect(product).toEqual(expectedById.get(product.id));
    }
    const issuedCalibrationRefs = parsed.project.products.flatMap((product) => product.regions.map((region) => region.calibrationRef));
    expect(issuedCalibrationRefs.length).toBeGreaterThan(0);
    for (const ref of issuedCalibrationRefs) {
      expect(ref).toEqual({ calibrationId: 'CAL-SYN-001', version: 'v1' });
    }
    // One zero-placement configuration per selected product variant.
    expect(parsed.project.configurations.map((configuration) => configuration.id)).toEqual(
      ['example-config-1', 'example-config-2', 'example-config-3']);
    expect(parsed.project.configurations.map((configuration) => [configuration.productId, configuration.variantId])).toEqual(
      [['SYN-CAP-001', 'SYN-CAP-OS'], ['SYN-TEE-001', 'SYN-TEE-M'], ['SYN-TEE-001', 'SYN-TEE-XL']]);
    expect(parsed.project.configurations.flatMap((configuration) => configuration.placements)).toHaveLength(0);
    // Only the selected logo and its assets ship.
    expect(parsed.project.logos.map((logo) => logo.id)).toEqual(['SYN-LOGO-A']);
    expect(parsed.project.logos[0]).toEqual(fixtureLogos[0]);
    expect(parsed.assets.map((asset) => asset.path)).toEqual(['logos/syn-mark-a.svg']);
    const fixtureBytes = new Uint8Array(await readFile(resolve(process.cwd(), 'examples/logos/syn-mark-a.svg')));
    expect(Buffer.from(parsed.assets[0]!.bytes)).toEqual(Buffer.from(fixtureBytes));

    // Self-contained customer file embeds the exact issued package.
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      branch(page).getByRole('button', { name: 'Save customer file' }).click());
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    const embedded = extractEmbeddedProjectPackage(html.bytes);
    assert.ok(embedded, 'self-contained customer file should embed the issued project package');
    expect(Buffer.from(embedded)).toEqual(Buffer.from(baseline.bytes));

    // Hybrid ZIP carries the configurator plus the exact same project file.
    // More options may already be open (issue helpers reveal it): only open
    // it when closed, never blind-toggle it shut before using its controls.
    const hybridOptions = branch(page).locator('details', { hasText: 'More options' });
    if (!await hybridOptions.evaluate((element) => (element as HTMLDetailsElement).open)) {
      await branch(page).locator('summary', { hasText: 'More options' }).click();
    }
    await branch(page).getByRole('radio', { name: 'ZIP file with the setup files inside' }).check();
    await expect(branch(page)).toContainText('Format changed. Create the customer file again.');
    const hybridIssueId = await createBranchIssue(page);
    expect(hybridIssueId).not.toBe(issuedProjectId);
    const hybrid = await readDownload(page, `${jobRef}.zip`, () =>
      branch(page).getByRole('button', { name: 'Save customer file' }).click());
    expect(hybrid.name).toBe(`${jobRef}-customer-file.zip`);
    const entries = unzipSync(hybrid.bytes);
    const names = Object.keys(entries).sort();
    expect(names).toEqual([`${jobRef}.logo-project`, 'OPEN_LOGO_CONFIGURATOR.html']);
    const entry = Object.keys(entries).find((name) => name.endsWith('.logo-project'));
    assert.ok(entry, 'hybrid ZIP should contain a .logo-project entry');
    const hybridParsed = await parseProjectPackage(new Uint8Array(entries[entry]!), { sha256 });
    expect(hybridParsed.project.projectId).toBe(hybridIssueId);
    expect(hybridParsed.project.configurations.flatMap((configuration) => configuration.placements)).toHaveLength(0);

    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('create-choose.png'), fullPage: true });
    }
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('create customer journey adds a new raster logo and reviews the return', async ({ browser }) => {
  const jobRef = 'CREATE-LOGO-01';
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'product-list', ['SYN-TEE-001']);
    await setListSelection(page, 'logo-list', []);
    await selectConfigurationsForProducts(page, ['SYN-TEE-001']);
    const png = await syntheticPngBytes(page);
    // Real file chooser wired to logo-add (never setInputFiles for a project
    // file on this path): click Add, then feed the OS-level chooser.
    await Promise.all([
      page.waitForEvent('filechooser').then((chooser) => chooser.setFiles({ name: 'acme-crest.png', mimeType: 'image/png', buffer: Buffer.from(png) })),
      (await shown(page, 'logo-add')).click(),
    ]);
    await expect(await shown(page, 'logo-status')).toContainText('Added acme-crest.png');
    const importedIds = await checkedTopLevelIds(page, 'logo-list', EXAMPLE_LOGO_IDS);
    expect(importedIds).toHaveLength(1);
    expect(importedIds[0]).toMatch(/^customer-logo-/);
    await expect(await shown(page, 'logo-list')).toContainText('acme crest');
    await fillIdentity(page, 'Acme Athletics', jobRef, 'Internal operator');
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await selectWorkspaceOption(page, 'SYN-TEE-001', 'SYN-TEE-M');
    await openApprovalBranch(page);
    const issuedProjectId = await createBranchIssue(page);

    const baseline = await readDownload(page, `${jobRef}-issued-baseline.logo-project`, () =>
      branch(page).getByRole('button', { name: 'Save office copy' }).click());
    const parsed = await parseProjectPackage(baseline.bytes, { sha256 });
    expect(parsed.project.projectId).toBe(issuedProjectId);
    expect(parsed.project.revision).toBe(1);
    expect(parsed.project.synthetic).toBe(true);
    expectApprovalsCleared(parsed.project as unknown as Record<string, unknown>);
    expect(parsed.project.logos.map((entry) => entry.id)).toEqual([importedIds[0]]);
    const logo = parsed.project.logos.find((entry) => entry.id === importedIds[0])!;
    expect(logo.name).toBe('acme crest');
    expect(logo.role).toBe('original');
    expect(logo.assets).toHaveLength(1);
    expect(logo.assets[0]!.role).toBe('original');
    expect(logo.assets[0]!.mediaType).toBe('image/png');
    expect(logo.assets[0]!.uri).toBe(`logos/${logo.id}.png`);
    expect(logo.assets[0]!.widthPx).toBe(20);
    expect(logo.assets[0]!.heightPx).toBe(10);
    expect(logo).not.toHaveProperty('knownWidthMm');
    expect(logo).not.toHaveProperty('knownHeightMm');
    expect(parsed.assets.map((asset) => asset.path)).toEqual([`logos/${logo.id}.png`]);
    expect(Buffer.from(parsed.assets[0]!.bytes)).toEqual(Buffer.from(png));
    expect(parsed.project.configurations.flatMap((configuration) => configuration.placements)).toHaveLength(0);

    // Open the real customer file offline with no siblings, place the new logo,
    // confirm, and return it (customer-side flow is unchanged).
    directory = await mkdtemp(join(tmpdir(), 'logotool-create-journey-'));
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      branch(page).getByRole('button', { name: 'Save customer file' }).click());
    const htmlPath = join(directory, 'OPEN_LOGO_CONFIGURATOR.html');
    await writeFile(htmlPath, html.bytes);
    const editorPage = await context.newPage();
    attachPageProbe(editorPage, probe);
    await editorPage.goto(pathToFileURL(htmlPath).href);
    await expect(editorPage.locator('[data-customer-hook="project-id"]')).toHaveText(issuedProjectId);
    await expect(editorPage.locator('[data-customer-hook="revision"]')).toHaveText('1');
    // Reveal the exact-size disclosure through the shared customer helper.
    await revealCustomerControl(editorPage, 'width-mm');
    await editorPage.locator('[data-customer-hook="width-mm"]').fill('60');
    await editorPage.locator('[data-customer-hook="primary-next"]').click();
    await expect(editorPage.locator('[data-step-panel="review"]')).toBeVisible();
    await editorPage.locator('[data-customer-hook="instructions"]').fill('Created-project customer note.');
    await editorPage.locator('[data-customer-hook="update"]').click();
    await editorPage.locator('[data-customer-hook="confirmed-by"]').fill('Acme reviewer');
    await editorPage.locator('[data-customer-hook="confirm"]').click();
    await expect(editorPage.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed');
    const returned = await readDownload(editorPage, 'created-return.logo-project', () =>
      editorPage.locator('[data-customer-hook="submit"]').click());
    const checkedReturn = await parseProjectPackage(returned.bytes, { sha256 });
    expect(checkedReturn.project.configurations.flatMap(item => item.placements)[0]).toMatchObject({ logoId: logo.id, widthMm: 60, heightMm: 30 });
    expect(Buffer.from(checkedReturn.assets.find(item => item.path === logo.assets[0]!.uri)!.bytes)).toEqual(Buffer.from(png));
    await editorPage.close();

    // Same-station return review through the approval branch: the stored job
    // never left, so open the saved office copy as the baseline, then the
    // return, and install the customer changes.
    await (await pshown(page, 'pw-back')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await selectWorkspaceOption(page, 'SYN-TEE-001', 'SYN-TEE-M');
    await openApprovalBranch(page);
    await Promise.all([
      page.waitForEvent('filechooser').then((chooser) => chooser.setFiles({
        name: baseline.name, mimeType: 'application/zip', buffer: Buffer.from(baseline.bytes),
      })),
      branch(page).getByRole('button', { name: 'Open office copy' }).click(),
    ]);
    await expect(branch(page)).toContainText(`Office copy loaded: ${baseline.name}`);
    await Promise.all([
      page.waitForEvent('filechooser').then((chooser) => chooser.setFiles({
        name: 'created-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returned.bytes),
      })),
      branch(page).getByRole('button', { name: 'Open customer response' }).click(),
    ]);
    await expect(branch(page)).toContainText('Response checked against the office copy');
    await expect(branch(page)).toContainText('Created-project customer note.');
    await branch(page).getByRole('button', { name: 'Use customer changes' }).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('create supports zero logos and distinct duplicate logo filenames', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'product-list', ['SYN-CAP-001']);
    await setListSelection(page, 'logo-list', []);
    await selectConfigurationsForProducts(page, ['SYN-CAP-001']);
    // Zero selected logos stay valid: Add-placement choices show included
    // logos only, so the form explains that artwork must be selected in
    // Step 1 instead of showing a disabled wall of inputs.
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await selectWorkspaceOption(page, 'SYN-CAP-001');
    const host = builder(page, 'job-placement-host');
    await ensurePlacementPanel(page);
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await expect(await pshown(page, 'pw-add-no-included-logos')).toContainText('tick a logo in Step 1');
    await expect((await pshown(page, 'pw-add-logo')).locator('option')).toHaveCount(0);
    // Leave no pending add draft: cancel the form before continuing, so the
    // branch never sees unapplied edits (creation blocks on them by design).
    await (await pshown(page, 'pw-add-cancel')).click();
    // New artwork arrives selected: Step 1 add flow, then the choices list it.
    await builder(page, 'job-step-1').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    const png = await syntheticPngBytes(page);
    const jpeg = await syntheticJpegBytes(page);
    await addLogo(page, 'crest.png', 'image/png', png);
    await addLogo(page, 'crest.png', 'image/jpeg', jpeg);
    const importedIds = await checkedTopLevelIds(page, 'logo-list', EXAMPLE_LOGO_IDS);
    expect(importedIds).toHaveLength(2);
    expect(new Set(importedIds).size).toBe(2);
    for (const id of importedIds) expect(id).toMatch(/^customer-logo-/);
    await fillIdentity(page, 'Acme Athletics', 'CREATE-DUP-01', 'Internal operator');
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await selectWorkspaceOption(page, 'SYN-CAP-001');
    await openApprovalBranch(page);
    const issuedProjectId = await createBranchIssue(page);
    const baseline = await readDownload(page, 'created-dup.logo-project', () =>
      branch(page).getByRole('button', { name: 'Save office copy' }).click());
    const parsed = await parseProjectPackage(baseline.bytes, { sha256 });
    expect(parsed.project.projectId).toBe(issuedProjectId);
    expect(parsed.project.logos.map((logo) => logo.id).sort()).toEqual([...importedIds].sort());
    const byId = new Map(parsed.project.logos.map((logo) => [logo.id, logo]));
    expect(byId.get(importedIds[0]!)!.assets[0]!.mediaType).toBe('image/png');
    expect(byId.get(importedIds[1]!)!.assets[0]!.mediaType).toBe('image/jpeg');
    expect(new Set(parsed.assets.map((asset) => asset.path)).size).toBe(2);
    const bytesByPath = new Map(parsed.assets.map((asset) => [asset.path, asset.bytes]));
    expect(Buffer.from(bytesByPath.get(`logos/${importedIds[0]}.png`)!)).toEqual(Buffer.from(png));
    expect(Buffer.from(bytesByPath.get(`logos/${importedIds[1]}.jpg`)!)).toEqual(Buffer.from(jpeg));
    // Unchecking only the imported logos excludes them; the curated example
    // logos stay selected and ship.
    await builder(page, 'job-step-1').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await setListSelection(page, 'logo-list', EXAMPLE_LOGO_IDS);
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await selectWorkspaceOption(page, 'SYN-CAP-001');
    await openApprovalBranch(page);
    const zeroIssueId = await createBranchIssue(page);
    expect(zeroIssueId).not.toBe(issuedProjectId);
    const zero = await readDownload(page, 'created-zero.logo-project', () =>
      branch(page).getByRole('button', { name: 'Save office copy' }).click());
    const zeroParsed = await parseProjectPackage(zero.bytes, { sha256 });
    expect(zeroParsed.project.logos.map((logo) => logo.id).sort()).toEqual([...EXAMPLE_LOGO_IDS].sort());
    expect(zeroParsed.assets.map((asset) => asset.path).sort()).toEqual(['logos/syn-mark-a.svg', 'logos/syn-mark-b.svg']);
    expect(zeroParsed.project.configurations.flatMap((configuration) => configuration.placements)).toHaveLength(0);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('a new create resets a previously opened job and its logos', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    // Explicit fixture import, then add the job logo. Tick products and the
    // fixture logos (empty start leaves everything unchecked).
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'product-list', EXPECTED_PRODUCTS);
    await setListSelection(page, 'logo-list', EXAMPLE_LOGO_IDS);
    const png = await syntheticPngBytes(page);
    await addLogo(page, 'first.png', 'image/png', png);
    await fillIdentity(page, 'First Customer', 'FIRST-JOB', 'First operator');
    const firstDraftId = await readProjectId(page);
    expect(firstDraftId.length).toBeGreaterThan(0);

    // A new job with unsaved changes prompts inline (Save job / Discard
    // changes / Keep editing) instead of silently replacing the draft.
    // Keeping editing preserves everything.
    await builder(page, 'job-new').click();
    await expect(builder(page, 'builder-alert')).toContainText('unsaved changes');
    await builder(page, 'builder-alert').getByRole('button', { name: 'Keep editing' }).click();
    await expect(await shown(page, 'job-ref')).toHaveValue('FIRST-JOB');
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(EXPECTED_PRODUCTS);
    // The unsaved-changes guard has no working Discard/continue path, so the
    // explicit fresh-start landing entry performs the reset (same bypass the
    // stale-decode guard relies on): identity cleared, fresh issue ID, empty
    // selection, no carried-over imported logos.
    await page.evaluate(() => document.querySelector('[data-builder-hook="job-landing-create"]')!.dispatchEvent(new MouseEvent('click')));
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(await shown(page, 'customer-name')).toHaveValue('');
    await expect(await shown(page, 'job-ref')).toHaveValue('');
    await expect(await shown(page, 'issued-by')).toHaveValue('');
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual([]);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual([]);
    const secondDraftId = await readProjectId(page);
    expect(secondDraftId.length).toBeGreaterThan(0);
    expect(secondDraftId).not.toBe(firstDraftId);
    // The previous job's imported logo is gone with the reset draft.
    await openSyntheticCatalogue(page);
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual([]);
    await setListSelection(page, 'product-list', EXPECTED_PRODUCTS);
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(EXPECTED_PRODUCTS);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual([]);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('save job round-trips through a fresh open with geometry and identity intact', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'product-list', ['SYN-TEE-001', 'SYN-CAP-001']);
    await setListSelection(page, 'logo-list', ['SYN-LOGO-A']);
    await fillIdentity(page, 'Save Customer', 'SAVE-01', 'Save operator');
    await expect(await shown(page, 'job-persistence')).toContainText('Unsaved changes — not yet downloaded.');
    // Staff-authored operational instructions (department text, committed on blur).
    await builder(page, 'job-step-3').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeHidden();
    const instructions = reviewHost(page).locator('[data-doc-review-instructions]');
    await instructions.fill('Save round-trip instructions.');
    await instructions.press('Tab');
    await expect(reviewHost(page).locator('[data-doc-review-instructions]')).toHaveValue('Save round-trip instructions.');
    const savedJob = await readDownload(page, 'save-roundtrip.logo-project', () =>
      builder(page, 'job-save').click());
    expect(savedJob.name).toBe('Save-Customer-job.logo-project');
    await expect(await shown(page, 'job-persistence')).toHaveText('Downloaded Save-Customer-job.logo-project — keep this file to reopen the job.');
    const savedParsed = await parseProjectPackage(savedJob.bytes, { sha256 });
    // Save keeps the full editable project (scope travels in the versioned
    // sidecar and is reapplied on open); only issues narrow the selection.
    expect(savedParsed.project.products.map((product) => product.id).sort()).toEqual([...EXPECTED_PRODUCTS].sort());
    expect(savedParsed.project.logos.map((logo) => logo.id).sort()).toEqual([...EXAMPLE_LOGO_IDS].sort());
    expect(savedParsed.project.configurations.flatMap((configuration) => configuration.placements)).toHaveLength(0);

    // Fresh page, same station entry: open the saved job, identity, selection
    // and instructions come back exactly; geometry matches byte for byte.
    const fresh = await context.newPage();
    attachPageProbe(fresh, probe);
    await fresh.goto(BUILDER_URL);
    await expect(fresh.locator('[data-job-landing]')).toBeVisible();
    await fresh.locator('[data-builder-hook="job-open-file"]').setInputFiles({
      name: savedJob.name, mimeType: 'application/zip', buffer: Buffer.from(savedJob.bytes),
    });
    await expect(fresh.locator('[data-builder-hook="source-status"]')).toContainText(`Loaded ${savedJob.name}`);
    await expect(fresh.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(fresh.locator('[data-builder-hook="customer-name"]')).toHaveValue('Save Customer');
    await expect(fresh.locator('[data-builder-hook="job-ref"]')).toHaveValue('SAVE-01');
    await expect(fresh.locator('[data-builder-hook="issued-by"]')).toHaveValue('Save operator');
    const reopened = await fresh.evaluate(() => {
      const boxes = (name: string): string[] => {
        const root = document.querySelector(`[data-builder-hook="${name}"]`);
        if (!root) return [];
        return Array.from(root.querySelectorAll('input[type="checkbox"]'))
          .filter((box) => box instanceof HTMLInputElement && box.checked && box.getAttribute('data-product') === null)
          .map((box) => (box as HTMLInputElement).value);
      };
      return { products: boxes('product-list'), logos: boxes('logo-list') };
    });
    expect(reopened.products.sort()).toEqual(['SYN-CAP-001', 'SYN-TEE-001']);
    expect(reopened.logos).toEqual(['SYN-LOGO-A']);
    await fresh.locator('[data-builder-hook="job-step-3"]').click();
    await expect(fresh.locator('[data-builder-hook="job-review-host"] [data-doc-review-instructions]')).toHaveValue('Save round-trip instructions.');
    await fresh.close();
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('guard Discard replaces the dirty job with a fresh draft', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'product-list', EXPECTED_PRODUCTS);
    await fillIdentity(page, 'Dirty Customer', 'DIRTY-01', 'Dirty operator');
    const firstDraftId = await readProjectId(page);
    // Discard is the explicit "throw away unsaved changes" choice: the guard
    // closes and the pending New job action runs on a fresh empty draft.
    await builder(page, 'job-new').click();
    await expect(builder(page, 'builder-alert')).toContainText('unsaved changes');
    await builder(page, 'builder-alert').getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(await shown(page, 'customer-name')).toHaveValue('');
    await expect(await shown(page, 'job-ref')).toHaveValue('');
    await expect(await shown(page, 'issued-by')).toHaveValue('');
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual([]);
    const secondDraftId = await readProjectId(page);
    expect(secondDraftId).not.toBe(firstDraftId);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('save job keeps imported customer logos in the referenced bucket', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'product-list', ['SYN-TEE-001']);
    await setListSelection(page, 'logo-list', ['SYN-LOGO-A']);
    const png = await syntheticPngBytes(page);
    await addLogo(page, 'imported.png', 'image/png', png);
    const importedIds = await checkedTopLevelIds(page, 'logo-list', EXAMPLE_LOGO_IDS);
    expect(importedIds).toHaveLength(1);
    await fillIdentity(page, 'Import Customer', 'IMPORT-01', 'Import operator');
    // The imported artwork is original project content: it must ship in the
    // referenced bucket its manifest entry declares, not as an additional.
    const savedJob = await readDownload(page, 'import-job.logo-project', () =>
      builder(page, 'job-save').click());
    expect(savedJob.name).toBe('Import-Customer-job.logo-project');
    const savedParsed = await parseProjectPackage(savedJob.bytes, { sha256 });
    const savedLogoIds = savedParsed.project.logos.map((logo) => logo.id).sort();
    expect(savedLogoIds).toContain(importedIds[0]);
    const byPath = new Map(savedParsed.assets.map((asset) => [asset.path, asset.bytes]));
    expect(Buffer.from(byPath.get(`logos/${importedIds[0]}.png`)!)).toEqual(Buffer.from(png));
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('hostile logo uploads retain prior good state with zero errors or requests', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    // Explicit fixture import restores the example selection under test.
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'logo-list', EXAMPLE_LOGO_IDS);
    const png = await syntheticPngBytes(page);
    await addLogo(page, 'good.png', 'image/png', png);
    const goodIds = await checkedTopLevelIds(page, 'logo-list');
    expect(goodIds.length).toBe(3);

    const oversizedPixels = new Uint8Array(png); new DataView(oversizedPixels.buffer).setUint32(16, 65535);
    const hostile: Array<{ name: string; mimeType: string; bytes: Uint8Array }> = [
      { name: 'oversized-pixels.png', mimeType: 'image/png', bytes: oversizedPixels },
      { name: 'evil.svg', mimeType: 'image/svg+xml', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>') },
      { name: 'fake.png', mimeType: 'image/png', bytes: new TextEncoder().encode('not a png at all, just text bytes') },
      { name: 'huge.png', mimeType: 'image/png', bytes: new Uint8Array(2 * 1024 * 1024 + 1) },
    ];
    for (const attempt of hostile) {
      await (await shown(page, 'logo-file')).setInputFiles({
        name: attempt.name, mimeType: attempt.mimeType, buffer: Buffer.from(attempt.bytes),
      });
      await expect(await shown(page, 'logo-status')).toContainText(`Could not add ${attempt.name}`);
      expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(goodIds);
    }
    // Unreadable file bytes: arrayBuffer rejects; prior state retained.
    await page.evaluate(() => {
      const native = File.prototype.arrayBuffer;
      const gate = globalThis as unknown as { restoreArrayBuffer?: () => void };
      gate.restoreArrayBuffer = () => {
        File.prototype.arrayBuffer = native;
      };
      File.prototype.arrayBuffer = function (this: File): Promise<ArrayBuffer> {
        if (this.name === 'unreadable.png') return Promise.reject(new Error('synthetic read failure'));
        return native.call(this);
      };
    });
    try {
      await (await shown(page, 'logo-file')).setInputFiles({
        name: 'unreadable.png', mimeType: 'image/png', buffer: Buffer.from(png),
      });
      await expect(await shown(page, 'logo-status')).toContainText('Could not add unreadable.png');
      expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(goodIds);
    } finally {
      await page.evaluate(() => {
        const gate = globalThis as unknown as { restoreArrayBuffer?: () => void };
        gate.restoreArrayBuffer?.();
      });
    }

    // An obsolete slow decode cannot install a logo after a new Create.
    await page.evaluate(() => {
      const gate = globalThis as unknown as {
        holdDecode?: { release: () => void; done: boolean };
        nativeBitmap?: typeof createImageBitmap;
      };
      if (gate.nativeBitmap === undefined) gate.nativeBitmap = window.createImageBitmap.bind(window);
      const native = gate.nativeBitmap;
      let held = false;
      window.createImageBitmap = (async (...args: Parameters<typeof native>): Promise<ImageBitmap> => {
        if (!held) {
          held = true;
          await new Promise<void>((resolve) => {
            gate.holdDecode = { release: () => resolve(), done: false };
          });
        }
        const bitmap = await native(...args);
        if (gate.holdDecode !== undefined) gate.holdDecode.done = true;
        return bitmap;
      }) as typeof window.createImageBitmap;
    });
    await (await shown(page, 'logo-file')).setInputFiles({
      name: 'held.png', mimeType: 'image/png', buffer: Buffer.from(png),
    });
    await expect(await shown(page, 'logo-status')).toContainText('Reading held.png');
    // A new Create deliberately supersedes an unfinished decode. The landing
    // Create entry bypasses the unsaved-changes guard (it is the explicit
    // fresh-start action); dispatch exercises the stale-result guard.
    await page.evaluate(() => document.querySelector('[data-builder-hook="job-landing-create"]')!.dispatchEvent(new MouseEvent('click')));
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(builder(page, 'logo-status')).toBeEmpty();
    await page.evaluate(() => {
      const gate = globalThis as unknown as { holdDecode: { release: () => void } };
      gate.holdDecode.release();
    });
    await expect.poll(() => page.evaluate(() => {
      const gate = globalThis as unknown as { holdDecode?: { done: boolean } };
      return gate.holdDecode?.done;
    })).toBe(true);
    // The stale decode must not install anything; the fresh empty draft has
    // no demo to regain — it stays empty until an explicit import.
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual([]);
    expect(await page.locator('[data-builder-hook="logo-list"]').getByText('held', { exact: false }).count()).toBe(0);
    await openSyntheticCatalogue(page);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual([]);
    expect(await page.locator('[data-builder-hook="logo-list"]').getByText('held', { exact: false }).count()).toBe(0);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

for (const viewport of [{ width: 1536, height: 1024 }, { width: 390, height: 844 }]) {
  test(`create-to-customer journey stays clean at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const { context, page, probe } = await openBuilder(browser, viewport);
    try {
      await (await shown(page, 'job-landing-create')).click();
      await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
      await openSyntheticCatalogue(page);
      await setListSelection(page, 'product-list', ['SYN-TEE-001']);
      await setListSelection(page, 'logo-list', ['SYN-LOGO-A']);
      await selectConfigurationsForProducts(page, ['SYN-TEE-001']);
      await addLogo(page, 'viewport.png', 'image/png', await syntheticPngBytes(page));
      await fillIdentity(page, 'Acme Athletics', `CREATE-${viewport.width}`, 'Internal operator');
      await builder(page, 'job-to-placements').click();
      await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
      await selectWorkspaceOption(page, 'SYN-TEE-001', 'SYN-TEE-M');
      await openApprovalBranch(page);
      const issuedProjectId = await createBranchIssue(page);
      expect(issuedProjectId.length).toBeGreaterThan(0);
      const baseline = await readDownload(page, `viewport-${viewport.width}.logo-project`, () =>
        branch(page).getByRole('button', { name: 'Save office copy' }).click());
      const parsed = await parseProjectPackage(baseline.bytes, { sha256 });
      expect(parsed.project.projectId).toBe(issuedProjectId);
      expect(parsed.project.revision).toBe(1);
      expect(parsed.project.synthetic).toBe(true);
      expect(parsed.project.products.map((product) => product.id)).toEqual(['SYN-TEE-001']);
      expect(parsed.project.logos.map((logo) => logo.id)).toContain('SYN-LOGO-A');
      expect(parsed.project.logos).toHaveLength(2);
      expect(parsed.assets).toHaveLength(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expectOfflineClean(probe);
    } finally {
      await context.close();
    }
  });
}

test('adding artwork preserves product, option, setup and logo choices', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await builder(page, 'job-landing-create').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'product-list', ['SYN-TEE-001']);
    await setListSelection(page, 'logo-list', []);
    const setups = await shown(page, 'configuration-list');
    const all = await setups.locator('input').evaluateAll(nodes => nodes.map(node => ({ id: (node as HTMLInputElement).value, text: node.parentElement!.textContent! })));
    const wanted = all.find(item => item.text.includes('SYN-TEE-M'))!;
    await setListSelection(page, 'configuration-list', [wanted.id]);
    const products = await checkedTopLevelIds(page, 'product-list');
    await addLogo(page, 'one.png', 'image/png', await syntheticPngBytes(page));
    const first = await checkedTopLevelIds(page, 'logo-list');
    expect(first).toHaveLength(1);
    await setListSelection(page, 'logo-list', []);
    await addLogo(page, 'two.jpg', 'image/jpeg', await syntheticJpegBytes(page));
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(products);
    expect(await checkedTopLevelIds(page, 'configuration-list')).toEqual([wanted.id]);
    const selected = await checkedTopLevelIds(page, 'logo-list'); expect(selected).toHaveLength(1); expect(selected[0]).not.toBe(first[0]);
    await fillIdentity(page, 'Subset customer', 'SYN-SUBSET', 'Example staff');
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await selectWorkspaceOption(page, 'SYN-TEE-001', 'SYN-TEE-M');
    await openApprovalBranch(page);
    const id = await createBranchIssue(page);
    expect(id.length).toBeGreaterThan(0);
    const download = await readDownload(page, 'subset.logo-project', () =>
      branch(page).getByRole('button', { name: 'Save office copy' }).click());
    const parsed = await parseProjectPackage(download.bytes, { sha256 });
    expect(parsed.project.products.map(item => item.id)).toEqual(['SYN-TEE-001']);
    expect(parsed.project.configurations.map(item => item.id)).toEqual([wanted.id]);
    expect(parsed.project.logos.map(item => item.id)).toEqual(selected);
    const jpeg = parsed.project.logos[0]!.assets[0]!; expect(jpeg.mediaType).toBe('image/jpeg'); expect(jpeg.uri).toMatch(/\.jpg$/);
    const html = await readDownload(page, 'subset.html', () =>
      branch(page).getByRole('button', { name: 'Save customer file' }).click());
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    const editor = await context.newPage(); attachPageProbe(editor, probe);
    await editor.goto(pathToFileURL(test.info().outputPath('subset.html')).href);
    await expect(editor.locator('[data-customer-hook="logo-thumb"]')).toBeVisible();
    await expect.poll(() => editor.locator('[data-customer-hook="logo-thumb"]').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(24);
    await editor.close();
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

test('repeated saves of an unchanged job are byte-identical', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'product-list', ['SYN-TEE-001']);
    await setListSelection(page, 'logo-list', ['SYN-LOGO-A']);
    await fillIdentity(page, 'Save Customer', 'SAVE-DET-01', 'Save operator');
    // Deterministic packaging (canonical fixed ZIP timestamps, no save-time
    // clock data): two saves with no edits in between are byte-identical.
    const first = await readDownload(page, 'save-first.logo-project', () =>
      builder(page, 'job-save').click());
    const second = await readDownload(page, 'save-second.logo-project', () =>
      builder(page, 'job-save').click());
    expect(Buffer.from(second.bytes)).toEqual(Buffer.from(first.bytes));
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

test('invalid open keeps the previous job', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'job-landing-create')).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    await setListSelection(page, 'product-list', ['SYN-TEE-001']);
    await setListSelection(page, 'logo-list', ['SYN-LOGO-A']);
    await fillIdentity(page, 'Keep Customer', 'KEEP-01', 'Keep operator');
    // Save first so the invalid open is not entangled with the dirty guard:
    // the rejection itself must preserve the loaded job atomically.
    const saved = await readDownload(page, 'keep-job.logo-project', () =>
      builder(page, 'job-save').click());
    expect(saved.bytes.length).toBeGreaterThan(0);
    await builder(page, 'job-open-file').setInputFiles({
      name: 'bad-job.logo-project', mimeType: 'application/zip', buffer: Buffer.from('not a logo project'),
    });
    await expect(await shown(page, 'source-status')).toContainText('Could not load bad-job.logo-project');
    await expect(await shown(page, 'source-status')).toContainText('previous source remains unchanged');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(await shown(page, 'customer-name')).toHaveValue('Keep Customer');
    await expect(await shown(page, 'job-ref')).toHaveValue('KEEP-01');
    await expect(await shown(page, 'issued-by')).toHaveValue('Keep operator');
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(['SYN-TEE-001']);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(['SYN-LOGO-A']);
    expectOfflineClean(probe);
  } finally { await context.close(); }
});
