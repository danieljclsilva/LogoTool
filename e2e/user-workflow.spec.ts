import { BUILDER_URL, STATION_DIR, revealBuilderControl, revealCustomerControl, selectCustomerOption } from './helpers.js';
import { countPdfPages } from './sheet-fixtures.js';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { buildCandidateExport } from '../src/core/index.js';
import type { Sha256HexFn } from '../src/core/index.js';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import { createProjectFromDefinitions } from '../src/core/project-builder/create-project.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';

// Whole-workflow browser QA: one coherent user journey per issued format,
// spanning artifacts issued by the internal builder (never isolated unit
// examples, never direct core mutation). Each journey covers: Builder Create
// (primary path) with a prepared-product import plus a locally synthesized
// raster logo, issue in one format, real offline customer editing with
// unsafe-fit rejection and reconfirmation, draft/return downloads, reopen,
// fresh staff review with candidate + operation document, invalid/wrong-file
// preservation, an in-station proposal loop, and mobile shots.
// Only tracked synthetic fixtures are used (e2e/fixtures/*, examples/*,
// dist/dev/trusted-issued.logo-project as the wrong-baseline fixture); the only
// synthesized bytes are a tiny in-spec PNG and downloads preserved under
// test.info().outputPath. Every page asserts zero console/page errors and
// zero HTTP(S) requests.

const sha256bytes: ProjectPackageSha256 = async (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
const sha256text: Sha256HexFn = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const FIXTURE_PATH = resolve(process.cwd(), 'e2e/fixtures/prepared-bridge-product.json');

// Locally synthesized raster logo: a tiny valid 1x1 PNG generated in-spec,
// never an external asset.
const RASTER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const RASTER_NAME = 'synthetic-raster-logo.png';

const CUSTOMER = 'Acme Athletics';
const ISSUED_BY = 'Internal operator';

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

function watchPage(page: Page, probe: Probe): void {
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

function customer(page: Page, name: string) {
  return page.locator(`[data-customer-hook="${name}"]`);
}

async function syntheticCataloguePackage(): Promise<Uint8Array> {
  const productFiles = (await readdir(resolve(process.cwd(), 'examples/products')))
    .filter((file: string) => file.endsWith('.product.json'))
    .sort();
  const products = await Promise.all(productFiles.map(async (file: string) =>
    JSON.parse(await readFile(resolve(process.cwd(), `examples/products/${file}`), 'utf8'))));
  products.sort((left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const logos = await Promise.all(['syn-mark-a.logo.json', 'syn-mark-b.logo.json'].map(async (file: string) =>
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
  return createProjectPackage({ project: draft.project, assets }, { sha256: sha256bytes });
}

async function openSyntheticCatalogue(page: Page): Promise<void> {
  const bytes = await syntheticCataloguePackage();
  await (await shown(page, 'source-file')).setInputFiles({
    name: 'synthetic-catalogue.logo-project', mimeType: 'application/zip', buffer: Buffer.from(bytes),
  });
  await expect(await shown(page, 'source-status')).toContainText('Loaded synthetic-catalogue.logo-project');
  await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
}

async function downloadTo(
  page: Page,
  fileName: string,
  trigger: () => Promise<void>,
): Promise<{ name: string; bytes: Uint8Array }> {
  const event = page.waitForEvent('download');
  await trigger();
  const download = await event;
  const outputPath = test.info().outputPath(fileName);
  await download.saveAs(outputPath);
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(outputPath)) };
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.networkRequests).toEqual([]);
}

async function setCustomerNumber(page: Page, hook: string, value: number): Promise<void> {
  await revealCustomerControl(page, hook);
  await customer(page, hook).fill(String(value));
  // Commit like a human tabbing out (fill alone keeps focus, so `change`
  // would otherwise only fire on the next focus move).
  await customer(page, hook).press('Tab');
}

async function unlockRatioForEdit(page: Page): Promise<void> {
  // New-placement forms render Keep shape CHECKED BUT DISABLED (the app only
  // enables it once an existing placement is selected), so never force it:
  // typing a height auto-unlocks and sticks (height input handler), which is
  // the actual new-placement workflow. Only uncheck when the app has the
  // control enabled, i.e. while editing an existing placement.
  await revealCustomerControl(page, 'ratio-lock');
  const lock = customer(page, 'ratio-lock');
  if (await lock.isEnabled() && await lock.isChecked()) await lock.uncheck();
}

type Point2 = [number, number];

function asPoints(value: unknown): Point2[] {
  assert.ok(Array.isArray(value), 'expected a polygon point list');
  return value.map((entry) => {
    assert.ok(Array.isArray(entry), 'expected a coordinate pair');
    return [Number(entry[0]), Number(entry[1])] as Point2;
  });
}

function bbox(points: Point2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  assert.ok(points.length > 0, 'expected a non-empty polygon');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

async function runUserWorkflow(
  browser: Browser,
  format: 'self' | 'hybrid',
  stationUrl: string = BUILDER_URL,
  withPdf = false,
): Promise<void> {
  const jobRef = format === 'self' ? 'WF-SELF-01' : 'WF-HYB-01';
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  const viewport = { width: 1280, height: 900 };
  await test.info().attach('workflow-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform,
      release: release(),
      arch: process.arch,
      browser: browser.browserType().name(),
      browserVersion: browser.version(),
      viewport,
      offline: true,
      entryPoint: stationUrl,
      format,
      withPdf,
    }, null, 2),
  });
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  let directory = '';
  try {
    // ---- Builder: Start a genuinely new job (primary Create path). ----
    const page = await context.newPage();
    watchPage(page, probe);
    await page.goto(stationUrl);
    await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
    await expect(page.locator('[data-builder-step="open"]')).toBeVisible();
    await shoot(page, `${format}-01-start`);

    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await expect(builder(page, 'demo-create')).toHaveCount(0);
    await expect(await shown(page, 'create-status')).toContainText('empty draft');
    // Explicit synthetic catalogue fixture (same example definitions the old
    // embedded catalogue carried) through the real source chooser.
    await openSyntheticCatalogue(page);

    // Import the prepared inspector-bridge product through the real file input.
    await (await shown(page, 'prepared-product-file')).setInputFiles(FIXTURE_PATH);
    await expect(await shown(page, 'product-status')).toContainText(
      'Imported prepared product with',
    );
    // Add a locally synthesized raster logo through the real file input.
    await (await shown(page, 'logo-file')).setInputFiles({
      name: RASTER_NAME,
      mimeType: 'image/png',
      buffer: RASTER_PNG,
    });
    await expect(await shown(page, 'logo-status')).toContainText(`Added ${RASTER_NAME}`);
    // Deliberately include the example artwork this synthetic journey places
    // (empty start leaves example logos unchecked; the import is auto-checked).
    const logoList = await shown(page, 'logo-list');
    for (const logoId of ['SYN-LOGO-A', 'SYN-LOGO-B']) {
      await logoList.locator(`input[value="${logoId}"]`).check();
    }

    // Keep the imported bridge product plus one prepared tee; drop the rest.
    // Top-level product toggles only: variant boxes live in a container that
    // the app hides as soon as its product is unchecked
    // ([data-options-for] hidden when the product leaves the selection), so
    // touching a nested box after its parent is unchecked would force a
    // hidden control. Dropped-product variants are ignored by readSelection
    // anyway (variants are only read for selected productIds).
    const keptProducts = ['SYN-BRIDGE-001', 'SYN-TEE-001'];
    const productList = await shown(page, 'product-list');
    const productBoxes = productList.locator('input[type="checkbox"]');
    const productCount = await productBoxes.count();
    const seenProducts: string[] = [];
    for (let index = 0; index < productCount; index += 1) {
      const box = productBoxes.nth(index);
      const nested = await box.getAttribute('data-product');
      if (nested !== null) {
        // Variant sub-option: follow its parent product (visible only while
        // the parent stays selected). Empty-start UX leaves all boxes
        // unchecked, so kept products need their variants ticked too.
        if (keptProducts.includes(nested) && await box.isVisible()) await box.check();
        continue;
      }
      const value = (await box.getAttribute('value')) ?? '';
      seenProducts.push(value);
      if (keptProducts.includes(value)) await box.check();
      else await box.uncheck();
    }
    for (const id of keptProducts) assert.ok(seenProducts.includes(id), `product list is missing ${id}`);
    // Keep only setups whose readable label belongs to the kept products.
    const configurationList = await shown(page, 'configuration-list');
    const configurationBoxes = configurationList.locator('input[type="checkbox"]');
    const configurationCount = await configurationBoxes.count();
    const keptConfigurations: string[] = [];
    for (let index = 0; index < configurationCount; index += 1) {
      const box = configurationBoxes.nth(index);
      const value = (await box.getAttribute('value')) ?? '';
      const label = await box.evaluate((element) => element.closest('label')?.textContent ?? '');
      if (keptProducts.some((id) => label.startsWith(id))) {
        await box.check();
        keptConfigurations.push(value);
      } else {
        await box.uncheck();
      }
    }
    assert.ok(keptConfigurations.length >= 3, `expected bridge + tee setups, saw ${keptConfigurations.join(',')}`);
    await expect(await shown(page, 'selection-summary')).toContainText('2 products');
    await expect(await shown(page, 'builder-next')).toBeEnabled();
    await shoot(page, `${format}-02-selection`);
    await (await shown(page, 'builder-next')).click();

    // ---- Builder: customer details + format chosen via More options. ----
    await expect(page.locator('[data-builder-step="details"]')).toBeVisible();
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill(jobRef);
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    const formatControl = await shown(page, format === 'self' ? 'format-self' : 'format-hybrid');
    await formatControl.check();
    await expect(formatControl).toBeChecked();
    const issuedProjectId = await builder(page, 'project-id').inputValue();
    assert.ok(issuedProjectId.length > 0, 'expected an automatic project ID');
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText(
      `Customer file ready (revision 1)`,
    );
    await expect(page.locator('[data-builder-step="send"]')).toBeVisible();
    await shoot(page, `${format}-03-issued`);

    const officeCopy = await downloadTo(page, `${jobRef}-office-copy.logo-project`, () =>
      shown(page, 'download-baseline').then((control) => control.click()),
    );
    const delivery = await downloadTo(page, `${jobRef}-customer-file`, () =>
      shown(page, 'download-package').then((control) => control.click()),
    );
    if (format === 'hybrid') expect(delivery.name).toBe(`${jobRef}.zip`);
    else expect(delivery.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    // Second issue with a fresh ID but an identical selection: same assets,
    // different project. Saved now through the real generate UI and used much
    // later as the wrong-baseline return probe (same assets so the app reaches
    // the project-identity check instead of stopping at asset comparison).
    // Issued after the delivery download above, so the customer journey keeps
    // the first issue's files.
    await (await shown(page, 'step-details')).click();
    await (await shown(page, 'project-id-new')).click();
    const otherProjectId = await builder(page, 'project-id').inputValue();
    assert.ok(otherProjectId.length > 0 && otherProjectId !== issuedProjectId, 'expected a fresh project ID');
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText(
      `Customer file ready (revision 1)`,
    );
    await expect(page.locator('[data-builder-step="send"]')).toBeVisible();
    await downloadTo(page, `${jobRef}-office-copy-2.logo-project`, () =>
      shown(page, 'download-baseline').then((control) => control.click()),
    );
    const issued = await parseProjectPackage(officeCopy.bytes, { sha256: sha256bytes });
    expect(issued.project.projectId).toBe(issuedProjectId);
    expect(issued.project.revision).toBe(1);

    const bridgeProduct = issued.project.products.find((entry) => entry.id === 'SYN-BRIDGE-001');
    assert.ok(bridgeProduct, 'issued project should contain the imported bridge product');
    const bridgeRegion = bridgeProduct.regions.find((entry) => entry.id === 'SYN-BRIDGE-CHEST');
    assert.ok(bridgeRegion, 'issued project should contain the bridge chest region');
    const safeBox = bbox(asPoints(bridgeRegion.safeArea));
    const exclusionBoxes = ((bridgeRegion.exclusions ?? []) as unknown[]).map((polygon) =>
      bbox(asPoints(polygon)),
    );
    const rasterLogo = issued.project.logos.find((entry) => entry.id.startsWith('customer-logo-'));
    assert.ok(rasterLogo, 'issued project should contain the imported raster logo');
    const bridgeConfigs = issued.project.configurations.filter((entry) => entry.productId === 'SYN-BRIDGE-001');
    assert.ok(bridgeConfigs.length >= 1, 'expected a bridge setup');
    const bridgeConfigId = bridgeConfigs[0]!.id;
    const teeConfigs = issued.project.configurations.filter((entry) => entry.productId === 'SYN-TEE-001');
    assert.ok(teeConfigs.length >= 2, `expected two tee setups, saw ${teeConfigs.map((entry) => entry.id).join(',')}`);
    const teeConfigA = teeConfigs[0]!;
    const teeConfigB = teeConfigs[1]!;

    // Safe centres are derived from the issued region bounds (never hard-coded
    // exclusion-unsafe coordinates); the AABB check proves exclusion clearance.
    function safeSpot(width: number, height: number, corner: 'southwest' | 'northeast'): Point2 {
      const box = corner === 'southwest'
        ? { x: safeBox.minX + width / 2 + 10, y: safeBox.minY + height / 2 + 10 }
        : { x: safeBox.maxX - width / 2 - 10, y: safeBox.maxY - height / 2 - 10 };
      const footprint = { minX: box.x - width / 2, maxX: box.x + width / 2, minY: box.y - height / 2, maxY: box.y + height / 2 };
      assert.ok(footprint.minX >= safeBox.minX && footprint.maxX <= safeBox.maxX, 'footprint must stay inside the safe area');
      assert.ok(footprint.minY >= safeBox.minY && footprint.maxY <= safeBox.maxY, 'footprint must stay inside the safe area');
      for (const exclusion of exclusionBoxes) {
        const overlaps = footprint.minX < exclusion.maxX && footprint.maxX > exclusion.minX
          && footprint.minY < exclusion.maxY && footprint.maxY > exclusion.minY;
        assert.ok(!overlaps, 'footprint must clear every exclusion');
      }
      return [box.x, box.y];
    }
    const [p1x, p1y] = safeSpot(50, 30, 'southwest');
    const [p2x, p2y] = safeSpot(40, 20, 'northeast');
    assert.ok(exclusionBoxes.length > 0, 'expected an exclusion to derive the unsafe probe from');
    const unsafeProbe: Point2 = [
      (exclusionBoxes[0]!.minX + exclusionBoxes[0]!.maxX) / 2,
      (exclusionBoxes[0]!.minY + exclusionBoxes[0]!.maxY) / 2,
    ];

    // ---- Delivery: open the exact issued file the customer receives. ----
    directory = await mkdtemp(join(tmpdir(), `LogoTool user workflow ${format} `));
    const editor = await context.newPage();
    watchPage(editor, probe);
    let customerHtmlPath = '';
    if (format === 'self') {
      customerHtmlPath = join(directory, 'OPEN_LOGO_CONFIGURATOR.html');
      await writeFile(customerHtmlPath, delivery.bytes);
      expect(await readdir(directory)).toEqual(['OPEN_LOGO_CONFIGURATOR.html']);
      await editor.goto(pathToFileURL(customerHtmlPath).href);
      await expect(customer(editor, 'project-id')).toHaveText(issuedProjectId);
      await expect(customer(editor, 'revision')).toHaveText('1');
      await expect(customer(editor, 'status')).toContainText('embedded');
    } else {
      const entries = unzipSync(delivery.bytes);
      const names = Object.keys(entries);
      expect(names).toContain('OPEN_LOGO_CONFIGURATOR.html');
      const projectEntry = names.find((name) => name.endsWith('.logo-project'));
      assert.ok(projectEntry, `hybrid ZIP should hold a project entry, saw: ${names.join(', ')}`);
      customerHtmlPath = join(directory, 'OPEN_LOGO_CONFIGURATOR.html');
      await writeFile(customerHtmlPath, entries['OPEN_LOGO_CONFIGURATOR.html']!);
      const projectPath = test.info().outputPath(`${jobRef}.logo-project`);
      await writeFile(projectPath, entries[projectEntry]!);
      expect(await readdir(directory)).toEqual(['OPEN_LOGO_CONFIGURATOR.html']);
      await editor.goto(pathToFileURL(customerHtmlPath).href);
      // The hybrid page must NOT auto-fetch its neighbour: manual Choose project.
      await expect(customer(editor, 'project-id')).toHaveText('Not loaded');
      const chooserPromise = editor.waitForEvent('filechooser');
      await revealCustomerControl(editor, 'choose');
      await customer(editor, 'choose').click();
      await (await chooserPromise).setFiles(projectPath);
      await expect(customer(editor, 'project-id')).toHaveText(issuedProjectId);
      await expect(customer(editor, 'revision')).toHaveText('1');
    }
    await shoot(editor, `${format}-04-customer-loaded`);

    // ---- Customer: two placements on the bridge region (repeat logo). ----
    await selectCustomerOption(editor, 'configuration', bridgeConfigId);
    await selectCustomerOption(editor, 'region', 'SYN-BRIDGE-CHEST');
    await selectCustomerOption(editor, 'logo', rasterLogo.id);
    await selectCustomerOption(editor, 'method', 'embroidery');
    // New placement: Keep shape is checked-but-disabled here, so leave it
    // alone — filling height after width auto-unlocks and sticks.
    await setCustomerNumber(editor, 'x-mm', p1x);
    await setCustomerNumber(editor, 'y-mm', p1y);
    await setCustomerNumber(editor, 'width-mm', 50);
    await setCustomerNumber(editor, 'height-mm', 30);
    // Regression: new-placement guidance must direct at the guided add path,
    // never at the disabled Apply control. Committed edits auto-apply; with
    // no placed logo selected yet they stay pending with an add direction.
    await expect(customer(editor, 'status')).toContainText('not added yet');
    await expect(customer(editor, 'status')).toContainText('Review layout');
    await expect(customer(editor, 'status')).not.toContainText('Apply my changes');
    await expect(customer(editor, 'unsaved-warning')).toContainText('not added yet');
    await expect(customer(editor, 'unsaved-warning')).toContainText('Review layout');
    await expect(customer(editor, 'unsaved-warning')).not.toContainText('Apply my changes');
    await expect(customer(editor, 'update')).toBeDisabled();
    await revealCustomerControl(editor, 'rotation');
    await customer(editor, 'rotation').fill('0');
    await revealCustomerControl(editor, 'placement-instructions');
    await customer(editor, 'placement-instructions').fill('First bridge mark.');
    await revealCustomerControl(editor, 'add');
    await customer(editor, 'add').click();
    await expect(customer(editor, 'placement').locator('option')).toHaveCount(2);
    await expect(customer(editor, 'geometry')).toContainText('Fits: yes');

    await customer(editor, 'add-another').click();
    await selectCustomerOption(editor, 'logo', rasterLogo.id);
    // Same new-placement workflow: width then height (auto-unlock), no lock toggle.
    await setCustomerNumber(editor, 'x-mm', p2x);
    await setCustomerNumber(editor, 'y-mm', p2y);
    await setCustomerNumber(editor, 'width-mm', 40);
    await setCustomerNumber(editor, 'height-mm', 20);
    await revealCustomerControl(editor, 'rotation');
    await customer(editor, 'rotation').fill('0');
    await revealCustomerControl(editor, 'placement-instructions');
    await customer(editor, 'placement-instructions').fill('Repeated bridge mark.');
    await revealCustomerControl(editor, 'add');
    await customer(editor, 'add').click();
    await expect(customer(editor, 'placement').locator('option')).toHaveCount(3);

    // ---- Customer: another logo on the prepared tee, numeric + method. ----
    await selectCustomerOption(editor, 'configuration', teeConfigA.id);
    await selectCustomerOption(editor, 'region', 'SYN-TEE-CHEST');
    await selectCustomerOption(editor, 'logo', 'SYN-LOGO-A');
    await selectCustomerOption(editor, 'method', 'embroidery');
    // New placement again: width then height (auto-unlock), no lock toggle.
    await setCustomerNumber(editor, 'x-mm', 20);
    await setCustomerNumber(editor, 'y-mm', 10);
    await setCustomerNumber(editor, 'width-mm', 60);
    await setCustomerNumber(editor, 'height-mm', 30);
    await revealCustomerControl(editor, 'rotation');
    await customer(editor, 'rotation').fill('15');
    await revealCustomerControl(editor, 'placement-instructions');
    await customer(editor, 'placement-instructions').fill('Tee chest mark.');
    await revealCustomerControl(editor, 'add');
    await customer(editor, 'add').click();
    await expect(customer(editor, 'placement').locator('option')).toHaveCount(2);
    await expect(customer(editor, 'geometry')).toContainText('Fits: yes');
    await expect(customer(editor, 'review')).toContainText('Center: 20.0 mm, 10.0 mm');
    await expect(customer(editor, 'review')).toContainText('Width × height: 60.0 mm × 30.0 mm');
    await expect(customer(editor, 'review')).toContainText('Turn clockwise: 15.0°');

    // Zero-placement setup stays explicit (selected variant included).
    await selectCustomerOption(editor, 'configuration', teeConfigB.id);
    await expect(customer(editor, 'placement').locator('option')).toHaveCount(1);
    await expect(customer(editor, 'placement').locator('option')).toHaveText('No placements');
    const variantValues = await customer(editor, 'variant').evaluate((select) =>
      Array.from((select as HTMLSelectElement).options).map((option) => option.value),
    );
    const firstVariant = variantValues[0];
    assert.ok(firstVariant !== undefined && variantValues.length > 1, 'expected two tee variants to choose from');
    const otherVariant = variantValues.find((value) => value !== firstVariant);
    assert.ok(otherVariant !== undefined, 'expected a second tee variant');
    await selectCustomerOption(editor, 'variant', otherVariant);
    await expect(customer(editor, 'placement').locator('option')).toHaveCount(1);
    await expect(customer(editor, 'placement').locator('option')).toHaveText('No placements');
    await selectCustomerOption(editor, 'configuration', teeConfigA.id);
    await expect(customer(editor, 'review')).toContainText('Center: 20.0 mm, 10.0 mm');

    // ---- Customer: unsafe edit is rejected, then corrected. ----
    await selectCustomerOption(editor, 'configuration', bridgeConfigId);
    await selectCustomerOption(editor, 'placement', '0');
    await setCustomerNumber(editor, 'x-mm', unsafeProbe[0]);
    await setCustomerNumber(editor, 'y-mm', unsafeProbe[1]);
    // Valid edits auto-apply as a new revision (no separate Apply step); the
    // unsafe position is saved but flagged by fit feedback, blocking confirm.
    await expect(customer(editor, 'status')).toContainText('Applied your changes as version');
    await expect(customer(editor, 'unsaved-warning')).toBeHidden();
    await expect(customer(editor, 'geometry')).toContainText('Fits: no');
    await expect(customer(editor, 'confirm')).toBeDisabled();
    await shoot(editor, `${format}-05-unsafe`);
    await setCustomerNumber(editor, 'x-mm', p1x);
    await setCustomerNumber(editor, 'y-mm', p1y);
    await expect(customer(editor, 'geometry')).toContainText('Fits: yes');

    // ---- Customer: instructions, confirmation, invalidation, reconfirm. ----
    await revealCustomerControl(editor, 'instructions');
    await customer(editor, 'instructions').fill(`Workflow instructions ${jobRef}.`);
    await customer(editor, 'instructions').press('Tab');
    // Project-note edits auto-apply as a new revision (no separate Apply).
    await expect(customer(editor, 'status')).toContainText('Applied your changes as version');
    await expect(customer(editor, 'review')).toContainText(`Notes for the whole project: Workflow instructions ${jobRef}.`);
    await revealCustomerControl(editor, 'confirmed-by');
    await customer(editor, 'confirmed-by').fill('Workflow customer');
    await revealCustomerControl(editor, 'confirm');
    await customer(editor, 'confirm').click();
    await expect(customer(editor, 'confirmation')).toContainText('Confirmed: version');
    const confirmedRevision = Number(await customer(editor, 'revision').textContent());
    assert.ok(confirmedRevision > 1, 'edits should have produced new revisions');
    await shoot(editor, `${format}-06-confirmed`);

    await editor.setViewportSize({ width: 390, height: 844 });
    expect(await editor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shoot(editor, `${format}-07-customer-mobile`);
    await editor.setViewportSize(viewport);

    await selectCustomerOption(editor, 'configuration', bridgeConfigId);
    await selectCustomerOption(editor, 'placement', '0');
    // Existing placement selected: the lock is enabled here, so unlock first
    // to change width independently (typing width with the lock on would
    // mirror height and break the 52×30 expectation below).
    await unlockRatioForEdit(editor);
    await setCustomerNumber(editor, 'width-mm', 52);
    // The auto-applied width edit invalidates the confirmation; no Apply click.
    await expect(customer(editor, 'confirmation')).toContainText(/no longer counts/i);
    await expect(customer(editor, 'submit')).toBeDisabled();
    await revealCustomerControl(editor, 'confirm');
    await customer(editor, 'confirm').click();
    await expect(customer(editor, 'confirmation')).toContainText('Confirmed: version');
    await expect(customer(editor, 'submit')).toBeEnabled();

    const draft = await downloadTo(editor, `${jobRef}-draft.logo-project`, async () => {
      await revealCustomerControl(editor, 'save');
      await customer(editor, 'save').click();
    });
    const returned = await downloadTo(editor, `${jobRef}-return.logo-project`, async () => {
      await revealCustomerControl(editor, 'submit');
      await customer(editor, 'submit').click();
    });
    const returnedProject = (await parseProjectPackage(returned.bytes, { sha256: sha256bytes })).project;
    // Descriptive Windows-portable download names: identity + revision, never
    // generic names that browsers deduplicate into ` (5)` collisions.
    expect(draft.name).toMatch(/-r\d+-draft\.logo-project$/);
    expect(returned.name).toMatch(/-r\d+-confirmed-return\.logo-project$/);
    for (const name of [draft.name, returned.name]) {
      assert.ok(!/[<>:"/\\|?*]/.test(name), `download name must be Windows-portable: ${name}`);
      assert.ok(!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name), `download name must avoid reserved device names: ${name}`);
    }
    expect(returnedProject.confirmation?.revision).toBe(returnedProject.revision);
    assert.ok(draft.bytes.length > 0, 'draft download should not be empty');

    // Reopen the exact return: identical numerics and a current confirmation.
    await customer(editor, 'file-input').setInputFiles(test.info().outputPath(`${jobRef}-return.logo-project`));
    await expect(customer(editor, 'project-id')).toHaveText(issuedProjectId);
    await expect(customer(editor, 'revision')).toHaveText(String(returnedProject.revision));
    await expect(customer(editor, 'confirmation')).toContainText('Confirmed: version');
    await selectCustomerOption(editor, 'configuration', bridgeConfigId);
    const fmt1 = (value: number): string => (Math.round(value * 10) / 10).toFixed(1);
    await expect(customer(editor, 'review')).toContainText(`Center: ${fmt1(p1x)} mm, ${fmt1(p1y)} mm`);
    await expect(customer(editor, 'review')).toContainText('Width × height: 52.0 mm × 30.0 mm');
    await expect(customer(editor, 'review')).toContainText(`Notes for the whole project: Workflow instructions ${jobRef}.`);
    await shoot(editor, `${format}-08-reopened`);

    // ---- Fresh staff Builder review: office copy first, then the return. ----
    const fresh = await context.newPage();
    watchPage(fresh, probe);
    await fresh.goto(stationUrl);
    await (await shown(fresh, 'mode-review')).click();
    await expect(fresh.locator('[data-builder-step="office"]')).toBeVisible();
    await expect(fresh.locator('[data-builder-step="office"]')).toContainText('Choose office copy');
    await (await shown(fresh, 'baseline-file')).setInputFiles(
      test.info().outputPath(`${jobRef}-office-copy.logo-project`),
    );
    await expect(await shown(fresh, 'baseline-load-status')).toContainText('Loaded office copy');
    await (await shown(fresh, 'step-return')).click();
    await (await shown(fresh, 'return-file')).setInputFiles(
      test.info().outputPath(`${jobRef}-return.logo-project`),
    );
    await expect(await shown(fresh, 'review-panel')).toBeVisible();
    await expect(await shown(fresh, 'review-changes')).toContainText(`Workflow instructions ${jobRef}.`);
    await expect(await shown(fresh, 'ticket-summary')).toContainText(
      'decision pending (no current internal review)',
    );
    await expect(await shown(fresh, 'return-status')).toContainText('Internal review is pending.');
    await expect(await shown(fresh, 'handoff-summary')).toContainText(`${jobRef}-return.logo-project`);
    await (await shown(fresh, 'step-check')).click();
    await shoot(fresh, `${format}-09-review-diffs`);

    const candidateFile = await downloadTo(fresh, `${jobRef}-candidate.json`, () =>
      shown(fresh, 'candidate-download').then((control) => control.click()),
    );
    const candidateJson = JSON.parse(Buffer.from(candidateFile.bytes).toString('utf8')) as {
      revision: number;
      digest: string;
      status: string;
      configurations: Array<{
        productId: string;
        placements: Array<{
          regionId: string;
          pos: { xMm: number; yMm: number };
          widthMm: number;
          heightMm: number;
        }>;
      }>;
    };
    expect(candidateJson.status).toBe('candidate-pending-review');
    expect(candidateJson.revision).toBe(returnedProject.revision);
    const expectedCandidate = buildCandidateExport(returnedProject, sha256text);
    expect(candidateJson.digest).toBe(expectedCandidate.digest);
    const bridgeCandidate = candidateJson.configurations.find((entry) => entry.productId === 'SYN-BRIDGE-001');
    assert.ok(bridgeCandidate, 'candidate should carry the bridge configuration');
    expect(bridgeCandidate.placements).toHaveLength(2);
    expect(bridgeCandidate.placements[0]).toMatchObject({
      regionId: 'SYN-BRIDGE-CHEST',
      pos: { xMm: p1x, yMm: p1y },
      widthMm: 52,
      heightMm: 30,
    });
    const teeCandidate = candidateJson.configurations.find((entry) => entry.productId === 'SYN-TEE-001');
    assert.ok(teeCandidate, 'candidate should carry the tee configuration');
    expect(teeCandidate.placements).toHaveLength(1);

    // Operation sheet: business identity and unfinished honesty, print CSS.
    // No digest, no customer notes, no review status on the operator sheet.
    await (await shown(fresh, 'preview-document')).click();
    const operation = await shown(fresh, 'operation-container');
    await expect(operation).toBeVisible();
    await expect(operation.locator('.opsheet').first()).toBeVisible();
    await expect(operation).not.toContainText(candidateJson.digest);
    await expect(operation).not.toContainText(`Workflow instructions ${jobRef}.`);
    await expect(operation).not.toContainText('First bridge mark.');
    await expect(operation).not.toContainText('Status: candidate-pending-review');
    await expect(operation).toContainText('setup needed before production');
    await shoot(fresh, `${format}-10-operation-document`);
    if (withPdf) {
      // Department authoring + actual one-page branded PDF on the same page.
      await (await shown(fresh, 'sheet-customer')).fill('Fresh Copy Athletics');
      await (await shown(fresh, 'sheet-reference')).fill(`FRESH-${format}-01`);
      await (await shown(fresh, 'sheet-instructions')).fill(
        'Press the bridge emblem at 160°C for 15 seconds with medium pressure. Check all four edges visually before packing.',
      );
      // The preview button toggles: open it only if a previous block closed it.
      if ((await builder(fresh, 'preview-document').getAttribute('aria-expanded')) !== 'true') {
        await (await shown(fresh, 'preview-document')).click();
      }
      const pdfOperation = await shown(fresh, 'operation-container');
      await expect(pdfOperation).toBeVisible();
      await expect(pdfOperation.locator('.opsheet').first()).toBeVisible();
      const pdfBytes = await fresh.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
      await writeFile(test.info().outputPath(`${format}-fresh-copy.pdf`), pdfBytes);
      // Multi-configuration journey: one branded sheet per product/option.
      // Exact pagination is a contract, not a hope: the 3-sheet set must
      // print exactly 3 pages (the set summary is screen-only so it cannot
      // fragment the first page; every printed page repeats its own header
      // context). Single-sheet exactness is additionally pinned by the
      // station-entry fresh-copy leg and operation-sheet-print.spec.ts.
      const sheetCount = await pdfOperation.locator('section.opsheet').count();
      assert.ok(sheetCount >= 1, 'expected at least one operation sheet');
      expect(countPdfPages(new Uint8Array(pdfBytes))).toBe(sheetCount);
      const pdfOperatorEvent = fresh.waitForEvent('download');
      await (await shown(fresh, 'operator-download')).click();
      const pdfOperatorFile = await pdfOperatorEvent;
      const pdfOperatorPath = await pdfOperatorFile.path();
      assert.ok(pdfOperatorPath, 'operator download path is available');
      const pdfOperatorPayload = JSON.parse(await readFile(pdfOperatorPath, 'utf8')) as { format: string };
      expect(pdfOperatorPayload.format).toBe('operation-export/1');
      await shoot(fresh, `${format}-10b-operation-pdf`);
    }
    await fresh.emulateMedia({ media: 'print' });
    await expect(fresh.locator('main#internal-builder')).toBeHidden();
    await expect(fresh.locator('.opsheet').first()).toBeVisible();
    await fresh.emulateMedia({ media: 'screen' });

    // Invalid and wrong-project files preserve the previous good state: the
    // invalid return is rejected before reading, and the second office copy
    // carries the same assets under a different project ID, so the return
    // check reaches baseline-project-mismatch without touching the summary.
    const priorSummary = await (await shown(fresh, 'ticket-summary')).textContent();
    await (await shown(fresh, 'return-file')).setInputFiles({
      name: 'invalid-return.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from('not a logo project'),
    });
    await expect(await shown(fresh, 'return-status')).toContainText('Could not import return');
    await expect(await shown(fresh, 'return-status')).toContainText('previous valid review remains unchanged');
    await expect(builder(fresh, 'ticket-summary')).toHaveText(priorSummary ?? '');
    await (await shown(fresh, 'return-file')).setInputFiles(
      test.info().outputPath(`${jobRef}-office-copy-2.logo-project`),
    );
    await expect(await shown(fresh, 'return-status')).toContainText('baseline-project-mismatch');
    await expect(builder(fresh, 'ticket-summary')).toHaveText(priorSummary ?? '');

    // In-station revised proposal: no second application. The office revises
    // one bridge placement plus the project note in the same station; the
    // new update needs customer confirmation before any approval.
    await (await shown(fresh, 'step-check')).click();
    await expect(await shown(fresh, 'proposal-current')).toContainText(`Update ${returnedProject.revision}`);
    await (await shown(fresh, 'proposal-config')).selectOption(bridgeConfigId);
    await (await shown(fresh, 'proposal-placement')).selectOption('0');
    const proposalX = Number(await builder(fresh, 'proposal-x').inputValue());
    await (await shown(fresh, 'proposal-x')).fill(String(proposalX + 2));
    await (await shown(fresh, 'proposal-instructions')).fill('Revised proposal instructions.');
    await (await shown(fresh, 'proposal-apply')).click();
    await expect(await shown(fresh, 'proposal-status')).toContainText(
      `Applied revised proposal as update ${returnedProject.revision + 1}`,
    );
    const proposal = await downloadTo(fresh, `${jobRef}-proposal.logo-project`, () =>
      shown(fresh, 'proposal-download').then((control) => control.click()),
    );
    expect(proposal.name).toMatch(/-r\d+-proposal\.logo-project$/);
    const revised = (await parseProjectPackage(proposal.bytes, { sha256: sha256bytes })).project;
    // One in-station apply lands geometry + note as a single new revision.
    expect(revised.revision).toBe(returnedProject.revision + 1);
    expect(revised.confirmation).toBeUndefined();
    expect(revised.instructions).toBe('Revised proposal instructions.');
    const revisedBridge = revised.configurations.find((entry) => entry.id === bridgeConfigId);
    assert.ok(revisedBridge && revisedBridge.placements.length > 0, 'proposal should keep bridge placements');
    expect(revisedBridge.placements[0]!.pos.xMm).toBe(proposalX + 2);
    await shoot(fresh, `${format}-11-station-proposal`);

    // The customer sees the stale confirmation, reconfirms, and returns it.
    await customer(editor, 'file-input').setInputFiles(test.info().outputPath(`${jobRef}-proposal.logo-project`));
    await expect(customer(editor, 'revision')).toHaveText(String(revised.revision));
    await expect(customer(editor, 'confirmation')).toContainText(/no longer counts/i);
    await revealCustomerControl(editor, 'confirmed-by');
    await customer(editor, 'confirmed-by').fill('Workflow customer again');
    await revealCustomerControl(editor, 'confirm');
    await customer(editor, 'confirm').click();
    await expect(customer(editor, 'confirmation')).toContainText('Confirmed: version');
    const reconfirmed = await downloadTo(editor, `${jobRef}-reconfirmed.logo-project`, async () => {
      await revealCustomerControl(editor, 'submit');
      await customer(editor, 'submit').click();
    });
    const reconfirmedProject = (await parseProjectPackage(reconfirmed.bytes, { sha256: sha256bytes })).project;
    expect(reconfirmedProject.revision).toBe(revised.revision);
    expect(reconfirmedProject.confirmation?.revision).toBe(revised.revision);
    expect(reconfirmedProject.confirmation?.confirmedBy).toBe('Workflow customer again');

    // Final staff decision in the same station: import the reconfirmed
    // return, record approval, save the reviewed return. No second page.
    await (await shown(fresh, 'step-return')).click();
    await (await shown(fresh, 'return-file')).setInputFiles(
      test.info().outputPath(`${jobRef}-reconfirmed.logo-project`),
    );
    await expect(await shown(fresh, 'review-panel')).toBeVisible();
    await (await shown(fresh, 'step-check')).click();
    await (await shown(fresh, 'review-decision-reviewer')).fill('Final reviewer');
    await (await shown(fresh, 'review-decision-choice')).selectOption('approved');
    await (await shown(fresh, 'review-decision-note')).fill('Internal workflow approval; still pending production.');
    await (await shown(fresh, 'review-decision-record')).click();
    await expect(await shown(fresh, 'review-decision-status')).toContainText(
      `Recorded approved for update ${revised.revision}`,
    );
    await shoot(fresh, `${format}-12-reconfirmed-review`);

    const reviewedDownload = await downloadTo(fresh, `${jobRef}-reviewed.logo-project`, () =>
      shown(fresh, 'review-decision-download').then((control) => control.click()),
    );
    expect(reviewedDownload.name).toMatch(/-r\d+-reviewed\.logo-project$/);
    const reviewedProject = (await parseProjectPackage(reviewedDownload.bytes, { sha256: sha256bytes })).project;
    expect(reviewedProject.review?.decision).toBe('approved');
    expect(reviewedProject.revision).toBe(revised.revision);
    // The approved artifact descends from the revised proposal (its
    // instructions survive the customer reconfirmation), while the earlier
    // changesRequested page-state decision is rightly not carried as internal
    // authority into the new revision: only the trusted baseline history is
    // preserved on return import.
    expect(reviewedProject.instructions).toBe('Revised proposal instructions.');
    expect(reviewedProject.reviewHistory ?? []).toEqual(issued.project.reviewHistory ?? []);

    const finalCandidateFile = await downloadTo(fresh, `${jobRef}-final-candidate.json`, () =>
      shown(fresh, 'candidate-download').then((control) => control.click()),
    );
    const finalCandidate = JSON.parse(Buffer.from(finalCandidateFile.bytes).toString('utf8')) as {
      revision: number;
      digest: string;
      status: string;
    };
    expect(finalCandidate.revision).toBe(revised.revision);
    expect(finalCandidate.status).toBe('candidate-pending-review');
    expect(finalCandidate.digest).toBe(buildCandidateExport(reconfirmedProject, sha256text).digest);
    // The operator sheet carries business data only: no review status, no
    // digest, no customer notes (the reconfirmed project instructions stay
    // source context). Nothing is authored on this read-only view, so every
    // logo honestly reports setup needed.
    await (await shown(fresh, 'preview-document')).click();
    const finalSheet = await shown(fresh, 'operation-container');
    await expect(finalSheet.locator('.opsheet').first()).toBeVisible();
    await expect(finalSheet).not.toContainText('candidate-pending-review');
    await expect(finalSheet).not.toContainText(finalCandidate.digest);
    await expect(finalSheet).not.toContainText('Revised proposal instructions.');
    await expect(finalSheet).toContainText('setup needed before production');

    await fresh.setViewportSize({ width: 390, height: 844 });
    expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shoot(fresh, `${format}-13-review-mobile`);

    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

test('whole-workflow journey through the self-contained customer file', async ({ browser }) => {
  await runUserWorkflow(browser, 'self');
});

test('whole-workflow journey through the hybrid ZIP customer file', async ({ browser }) => {
  await runUserWorkflow(browser, 'hybrid');
});

for (const format of ['self', 'hybrid'] as const) {
test(`whole-workflow journey from a fresh station copy (${format} customer file)`, async ({ browser }) => {
  // The complete staff journey — prepare, issue, customer edit/confirm,
  // same-station check, in-station proposal, reconfirmation, approval,
  // candidate, operation sheet and PDF — running every staff page from a
  // fresh copy of dist/station with spaces in its path, keeping the actual
  // downloaded customer bytes throughout. No repo-checkout dependence.
  const stationCopy = await mkdtemp(join(tmpdir(), 'Logo Station copy '));
  try {
    await cp(STATION_DIR, stationCopy, { recursive: true });
    await runUserWorkflow(browser, format, pathToFileURL(join(stationCopy, 'Logo Station.html')).href, true);
  } finally {
    await rm(stationCopy, { recursive: true, force: true });
  }
});
}
