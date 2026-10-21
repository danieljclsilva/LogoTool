import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { BUILDER_URL, gotoBuilder, revealBuilderControl } from './helpers.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { extractEmbeddedProjectPackage } from '../src/packaging/self-contained-html/index.js';

// Create-a-project acceptance (Phase "Create" extension of the guided
// proof-desk redesign). Opens the already-built dist/internal-builder.html
// offline through file:// (the spec never rebuilds; `npm run build` runs
// first). Every test asserts zero console/page errors and zero HTTP(S)
// requests.
//
// Start screen (src/ui/internal-builder/template.html):
// - step-open tab reads "Start" ([data-builder-hook="step-open"], panel
//   [data-builder-step="open"] aria "Start"). Primary
//   [data-builder-hook="start-create"] ("Create a project") starts a genuinely
//   new EMPTY draft: nothing is pre-selected, so bundled examples can never
//   leak into a real job. [data-builder-hook="demo-create"] ("Try demo data")
//   explicitly opts into the synthetic example selection. No uploading or
//   opening an existing job; NO setInputFiles for a project is used to reach
//   Choose items on this path.
// - [data-builder-hook="start-open-toggle"] is the summary of the Open-existing
//   <details>, which stays OPEN by default, so source-choose/source-drop stay
//   visible and the old Open flows are untouched.
// - Choose items carries [data-builder-hook="catalogue-note"] ("Example
//   products — not for production.", hidden unless catalogue-created),
//   [data-builder-hook="logo-add"] + [data-builder-hook="logo-file"] (accepts
//   PNG/JPEG/WebP; setInputFiles via the real file chooser) and
//   [data-builder-hook="logo-status"]. Imported logos render as normal checked
//   rows in logo-list with readable names; selection/identity/generation flows
//   are the existing guided ones (steps choose/details/send + More options).
// - EVERY builder interaction goes through revealBuilderControl(page, name)
//   (e2e/helpers.ts): real step/mode/disclosure navigation. Tests never force
//   hidden fields visible and never touch internal-builder.spec.ts or
//   presentation-assets.spec.ts flows.

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

/** Reveal a builder control through real step/mode/disclosure navigation. */
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
      entryPoint: 'file://dist/internal-builder.html',
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
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
  await expect(page.locator('[data-builder-step="open"]')).toBeVisible();
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

/** Generate via the real primary action. */
async function createCustomerFile(page: Page, issuedProjectId: string): Promise<void> {
  await (await shown(page, 'step-details')).click();
  const primary = await shown(page, 'generate');
  await expect(primary).toContainText('Create customer file');
  await primary.click();
  await expect(await shown(page, 'generate-status')).toContainText(
    `Issued ${issuedProjectId} revision 1`,
  );
  await expect(await shown(page, 'baseline-status')).toContainText(
    `Retained issued baseline: ${issuedProjectId} revision 1`,
  );
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
  await (await shown(page, 'step-details')).click();
  await expect(page.locator('[data-builder-step="details"]')).toBeVisible();
  await (await shown(page, 'customer-name')).fill(customer);
  await (await shown(page, 'job-ref')).fill(job);
  await (await shown(page, 'issued-by')).fill(by);
}

async function readProjectId(page: Page): Promise<string> {
  // Pure read: inputValue works on hidden steps, so never navigate here —
  // callers asserting post-generation state must stay on Save & send.
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

test('create starts a fresh example draft without opening a project file', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    // Start screen: primary Create, secondary open-existing disclosure that
    // stays open so the old chooser/dropzone remain visible.
    await expect(page.locator('[data-builder-step="open"]')).toHaveAttribute('aria-label', 'Start');
    await expect(builder(page, 'step-open')).toContainText('Start');
    await expect(await shown(page, 'start-create')).toContainText('Create a project');
    await expect(builder(page, 'start-open-toggle')).toBeVisible();
    await expect(builder(page, 'source-choose')).toBeHidden();
    await expect(builder(page, 'source-drop')).toBeHidden();
    await expect(page.locator('[data-builder-step="choose"]')).toBeHidden();

    // Create WITHOUT setInputFiles for any project file. New drafts start
    // empty: nothing is pre-selected, so the operator cannot accidentally
    // issue bundled mock items as a real job.
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await expect(await shown(page, 'catalogue-note')).toBeVisible();
    await expect(await shown(page, 'catalogue-note')).toHaveText('Example products — not for production.');
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual([]);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual([]);
    // Explicit demo opt-in restores the full example selection.
    await (await shown(page, 'demo-create')).click();
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(EXPECTED_PRODUCTS);
    for (const productId of EXPECTED_PRODUCTS) {
      expect((await variantIds(page, productId)).length).toBeGreaterThan(0);
    }
    expect((await variantIds(page, 'SYN-TEE-001')).sort()).toEqual(['SYN-TEE-M', 'SYN-TEE-XL']);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(EXAMPLE_LOGO_IDS);
    await expect(await shown(page, 'product-list')).toContainText('Synthetic Tee');
    await expect(await shown(page, 'logo-list')).toContainText('Synthetic Mark B');
    // New drafts clear identity inputs; the issued ID is a fresh local ID.
    await (await shown(page, 'step-details')).click();
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
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    // Narrow the selection: tee + cap products, synthetic mark A only.
    await setListSelection(page, 'product-list', ['SYN-TEE-001', 'SYN-CAP-001']);
    await setListSelection(page, 'logo-list', ['SYN-LOGO-A']);
    await selectConfigurationsForProducts(page, ['SYN-TEE-001', 'SYN-CAP-001']);
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, 'Acme Athletics', jobRef, 'Internal operator');
    const issuedProjectId = await readProjectId(page);
    expect(issuedProjectId.length).toBeGreaterThan(0);
    await createCustomerFile(page, issuedProjectId);

    const baseline = await readDownload(page, `${jobRef}-issued-baseline.logo-project`, () =>
      shown(page, 'download-baseline').then((control) => control.click()));
    expect(baseline.name).toBe(`${jobRef}-issued-baseline.logo-project`);
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
      shown(page, 'download-package').then((control) => control.click()));
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    const embedded = extractEmbeddedProjectPackage(html.bytes);
    assert.ok(embedded, 'self-contained customer file should embed the issued project package');
    expect(Buffer.from(embedded)).toEqual(Buffer.from(baseline.bytes));

    // Hybrid ZIP carries the configurator plus the exact same project file.
    await (await shown(page, 'step-details')).click();
    await (await shown(page, 'format-hybrid')).check();
    await createCustomerFile(page, issuedProjectId);
    const hybrid = await readDownload(page, `${jobRef}.zip`, () =>
      shown(page, 'download-package').then((control) => control.click()));
    expect(hybrid.name).toBe(`${jobRef}.zip`);
    const entries = unzipSync(hybrid.bytes);
    const names = Object.keys(entries).sort();
    expect(names).toEqual([`${jobRef}.logo-project`, 'OPEN_LOGO_CONFIGURATOR.html']);
    const entry = Object.keys(entries).find((name) => name.endsWith('.logo-project'));
    assert.ok(entry, 'hybrid ZIP should contain a .logo-project entry');
    expect(Buffer.from(entries[entry]!)).toEqual(Buffer.from(baseline.bytes));

    // Repeated generation with unchanged input is byte-identical.
    await createCustomerFile(page, issuedProjectId);
    expect(await readProjectId(page)).toBe(issuedProjectId);
    const repeated = await readDownload(page, 'repeated.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()));
    expect(Buffer.from(repeated.bytes)).toEqual(Buffer.from(baseline.bytes));

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
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await setListSelection(page, 'product-list', ['SYN-TEE-001']);
    await setListSelection(page, 'logo-list', []);
    await selectConfigurationsForProducts(page, ['SYN-TEE-001']);
    const png = await syntheticPngBytes(page);
    // Real file chooser wired to logo-file (never setInputFiles for a project
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
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, 'Acme Athletics', jobRef, 'Internal operator');
    const issuedProjectId = await readProjectId(page);
    await createCustomerFile(page, issuedProjectId);

    const baseline = await readDownload(page, `${jobRef}-issued-baseline.logo-project`, () =>
      shown(page, 'download-baseline').then((control) => control.click()));
    const parsed = await parseProjectPackage(baseline.bytes, { sha256 });
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
    // confirm, and review the return against the saved office copy.
    directory = await mkdtemp(join(tmpdir(), 'logotool-create-journey-'));
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      shown(page, 'download-package').then((control) => control.click()));
    const htmlPath = join(directory, 'OPEN_LOGO_CONFIGURATOR.html');
    await writeFile(htmlPath, html.bytes);
    const editorPage = await context.newPage();
    attachPageProbe(editorPage, probe);
    await editorPage.goto(pathToFileURL(htmlPath).href);
    await expect(editorPage.locator('[data-customer-hook="project-id"]')).toHaveText(issuedProjectId);
    await expect(editorPage.locator('[data-customer-hook="revision"]')).toHaveText('1');
    // One workspace: width is editable alongside position; Continue adds the
    // new logo and moves to the combined review step.
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
    const checkedReturn = await parseProjectPackage(returned.bytes,{sha256});
    expect(checkedReturn.project.configurations.flatMap(item=>item.placements)[0]).toMatchObject({logoId:logo.id,widthMm:60,heightMm:30});
    expect(Buffer.from(checkedReturn.assets.find(item=>item.path===logo.assets[0]!.uri)!.bytes)).toEqual(Buffer.from(png));
    await editorPage.close();

    const fresh = await context.newPage();
    attachPageProbe(fresh, probe);
    await fresh.goto(BUILDER_URL);
    await revealBuilderControl(fresh, 'mode-review');
    await builder(fresh, 'mode-review').click();
    await revealBuilderControl(fresh, 'baseline-file');
    await builder(fresh, 'baseline-file').setInputFiles({
      name: baseline.name, mimeType: 'application/zip', buffer: Buffer.from(baseline.bytes),
    });
    await expect(builder(fresh, 'baseline-load-status')).toContainText('Loaded saved baseline');
    await revealBuilderControl(fresh, 'return-file');
    await builder(fresh, 'return-file').setInputFiles({
      name: 'created-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returned.bytes),
    });
    await revealBuilderControl(fresh,'review-panel');
    await expect(builder(fresh, 'review-panel')).toBeVisible();
    await expect(builder(fresh, 'review-changes')).toContainText('Created-project customer note.');
    await fresh.close();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('create supports zero logos and distinct duplicate logo filenames', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await setListSelection(page, 'product-list', ['SYN-CAP-001']);
    await setListSelection(page, 'logo-list', []);
    await selectConfigurationsForProducts(page, ['SYN-CAP-001']);
    const png = await syntheticPngBytes(page);
    const jpeg = await syntheticJpegBytes(page);
    await addLogo(page, 'crest.png', 'image/png', png);
    await addLogo(page, 'crest.png', 'image/jpeg', jpeg);
    const importedIds = await checkedTopLevelIds(page, 'logo-list', EXAMPLE_LOGO_IDS);
    expect(importedIds).toHaveLength(2);
    expect(new Set(importedIds).size).toBe(2);
    for (const id of importedIds) expect(id).toMatch(/^customer-logo-/);
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, 'Acme Athletics', 'CREATE-DUP-01', 'Internal operator');
    const issuedProjectId = await readProjectId(page);
    await createCustomerFile(page, issuedProjectId);
    const baseline = await readDownload(page, 'created-dup.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()));
    const parsed = await parseProjectPackage(baseline.bytes, { sha256 });
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
    await (await shown(page, 'step-choose')).click();
    await setListSelection(page, 'logo-list', EXAMPLE_LOGO_IDS);
    await (await shown(page, 'builder-next')).click();
    await createCustomerFile(page, issuedProjectId);
    const zero = await readDownload(page, 'created-zero.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()));
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
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    // Empty start: take the explicit demo selection, then add the job logo.
    await (await shown(page, 'demo-create')).click();
    const png = await syntheticPngBytes(page);
    await addLogo(page, 'first.png', 'image/png', png);
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, 'First Customer', 'FIRST-JOB', 'First operator');
    await (await shown(page,'project-id')).fill('MANUAL-FIRST-JOB');
    const firstDraftId = await readProjectId(page);
    await createCustomerFile(page, firstDraftId);
    await expect(page.locator('[data-builder-step="send"]')).toBeVisible();

    // A new Create discards the previous draft: identity cleared, fresh issue
    // ID, empty selection that never leaks the previous job, no carried-over
    // imported logos. The demo catalogue is an explicit opt-in again.
    await (await shown(page, 'step-open')).click();
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await expect(await shown(page, 'catalogue-note')).toBeVisible();
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual([]);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual([]);
    await (await shown(page, 'demo-create')).click();
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(EXPECTED_PRODUCTS);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(EXAMPLE_LOGO_IDS);
    await (await shown(page, 'step-details')).click();
    await expect(await shown(page, 'customer-name')).toHaveValue('');
    await expect(await shown(page, 'job-ref')).toHaveValue('');
    await expect(await shown(page, 'issued-by')).toHaveValue('');
    const secondDraftId = await readProjectId(page);
    expect(secondDraftId.length).toBeGreaterThan(0);
    expect(secondDraftId).not.toBe(firstDraftId);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('hostile logo uploads retain prior good state with zero errors or requests', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    // Explicit demo opt-in restores the example selection under test.
    await (await shown(page, 'demo-create')).click();
    const png = await syntheticPngBytes(page);
    await addLogo(page, 'good.png', 'image/png', png);
    const goodIds = await checkedTopLevelIds(page, 'logo-list');
    expect(goodIds.length).toBe(3);

    const oversizedPixels=new Uint8Array(png);new DataView(oversizedPixels.buffer).setUint32(16,65535);
    const hostile: Array<{ name: string; mimeType: string; bytes: Uint8Array }> = [
      {name:'oversized-pixels.png',mimeType:'image/png',bytes:oversizedPixels},
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
    // A new-job event deliberately supersedes an unfinished decode. UI controls
    // remain locked during reading; dispatch exercises the stale-result guard.
    await page.evaluate(() => document.querySelector('[data-builder-hook="start-create"]')!.dispatchEvent(new MouseEvent('click')));
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await expect(builder(page,'logo-status')).toBeEmpty();
    await page.evaluate(() => {
      const gate = globalThis as unknown as { holdDecode: { release: () => void } };
      gate.holdDecode.release();
    });
    await expect.poll(() => page.evaluate(() => {
      const gate = globalThis as unknown as { holdDecode?: { done: boolean } };
      return gate.holdDecode?.done;
    })).toBe(true);
    // The stale decode must not install anything; the fresh empty draft only
    // regains the examples through the explicit demo opt-in.
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual([]);
    expect(await page.locator('[data-builder-hook="logo-list"]').getByText('held', { exact: false }).count()).toBe(0);
    await (await shown(page, 'demo-create')).click();
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(EXAMPLE_LOGO_IDS);
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
      await (await shown(page, 'start-create')).click();
      await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
      await expect(await shown(page, 'catalogue-note')).toContainText('Example products — not for production.');
      await setListSelection(page, 'product-list', ['SYN-TEE-001']);
      await setListSelection(page, 'logo-list', ['SYN-LOGO-A']);
      await selectConfigurationsForProducts(page, ['SYN-TEE-001']);
      await addLogo(page, 'viewport.png', 'image/png', await syntheticPngBytes(page));
      await (await shown(page, 'builder-next')).click();
      await fillIdentity(page, 'Acme Athletics', `CREATE-${viewport.width}`, 'Internal operator');
      const issuedProjectId = await readProjectId(page);
      await createCustomerFile(page, issuedProjectId);
      const baseline = await readDownload(page, `viewport-${viewport.width}.logo-project`, () =>
        shown(page, 'download-baseline').then((control) => control.click()));
      const parsed = await parseProjectPackage(baseline.bytes, { sha256 });
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

test('adding artwork preserves product, option, setup and logo choices', async ({browser}) => {
  const {context,page,probe}=await openBuilder(browser);
  try {
    await builder(page,'start-create').click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await setListSelection(page,'product-list',['SYN-TEE-001']);
    await setListSelection(page,'logo-list',[]);
    const setups=await shown(page,'configuration-list');
    const all=await setups.locator('input').evaluateAll(nodes=>nodes.map(node=>({id:(node as HTMLInputElement).value,text:node.parentElement!.textContent!})));
    const wanted=all.find(item=>item.text.includes('SYN-TEE-M'))!;
    await setListSelection(page,'configuration-list',[wanted.id]);
    const products=await checkedTopLevelIds(page,'product-list');
    await addLogo(page,'one.png','image/png',await syntheticPngBytes(page));
    const first=await checkedTopLevelIds(page,'logo-list');
    expect(first).toHaveLength(1);
    await setListSelection(page,'logo-list',[]);
    await addLogo(page,'two.jpg','image/jpeg',await syntheticJpegBytes(page));
    expect(await checkedTopLevelIds(page,'product-list')).toEqual(products);
    expect(await checkedTopLevelIds(page,'configuration-list')).toEqual([wanted.id]);
    const selected=await checkedTopLevelIds(page,'logo-list');expect(selected).toHaveLength(1);expect(selected[0]).not.toBe(first[0]);
    await builder(page,'builder-next').filter({visible:true}).click();
    await fillIdentity(page,'Subset customer','SYN-SUBSET','Example staff');
    const id=await readProjectId(page);await createCustomerFile(page,id);
    const download=await readDownload(page,'subset.logo-project',()=>builder(page,'download-baseline').click());
    const parsed=await parseProjectPackage(download.bytes,{sha256});
    expect(parsed.project.products.map(item=>item.id)).toEqual(['SYN-TEE-001']);
    expect(parsed.project.configurations.map(item=>item.id)).toEqual([wanted.id]);
    expect(parsed.project.logos.map(item=>item.id)).toEqual(selected);
    const jpeg=parsed.project.logos[0]!.assets[0]!;expect(jpeg.mediaType).toBe('image/jpeg');expect(jpeg.uri).toMatch(/\.jpg$/);
    await readDownload(page,'subset.html',()=>builder(page,'download-package').click());
    const editor=await context.newPage();attachPageProbe(editor,probe);
    await editor.goto(pathToFileURL(test.info().outputPath('subset.html')).href);
    await expect(editor.locator('[data-customer-hook="logo-thumb"]')).toBeVisible();
    await expect.poll(()=>editor.locator('[data-customer-hook="logo-thumb"]').evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(24);
    await editor.close();
    expectOfflineClean(probe);
  } finally {await context.close();}
});
