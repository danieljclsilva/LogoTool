import { gotoBuilder, revealBuilderControl, revealCustomerControl, selectCustomerOption } from './helpers.js';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { buildCandidateExport } from '../src/core/index.js';
import type { Sha256HexFn } from '../src/core/index.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';

// Whole-workflow browser QA: one coherent user journey per issued format,
// spanning artifacts issued by the internal builder (never isolated unit
// examples, never direct core mutation). Each journey covers: Builder Create
// (primary path) with a prepared-product import plus a locally synthesized
// raster logo, issue in one format, real offline customer editing with
// unsafe-fit rejection and reconfirmation, draft/return downloads, reopen,
// fresh staff review with candidate + operation document, invalid/wrong-file
// preservation, a downloaded full-reviewer proposal loop, and mobile shots.
// Only tracked synthetic fixtures are used (e2e/fixtures/*, examples/*,
// dist/trusted-issued.logo-project as the wrong-baseline fixture); the only
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

function review(page: Page, name: string) {
  return page.locator(`[data-review-hook="${name}"]`);
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

async function openReviewDisclosure(page: Page, hook: string): Promise<void> {
  const target = review(page, hook);
  const details = target.locator('xpath=ancestor::details[1]');
  if ((await details.count()) > 0 && (await details.getAttribute('open')) === null) {
    await details.locator(':scope > summary').click();
  }
  await expect(target).toBeVisible();
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

async function runUserWorkflow(browser: Browser, format: 'self' | 'hybrid'): Promise<void> {
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
      entryPoint: 'file://dist/internal-builder.html',
      format,
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
    await gotoBuilder(page);
    await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
    await expect(page.locator('[data-builder-step="open"]')).toBeVisible();
    await shoot(page, `${format}-01-start`);

    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await expect(await shown(page, 'catalogue-note')).toContainText('not for production');

    // Import the prepared inspector-bridge product through the real file input.
    await (await shown(page, 'prepared-product-file')).setInputFiles(FIXTURE_PATH);
    await expect(await shown(page, 'product-status')).toContainText(
      'Imported prepared product SYN-BRIDGE-001',
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
      `Issued ${issuedProjectId} revision 1`,
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
      `Issued ${otherProjectId} revision 1`,
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
    await gotoBuilder(fresh);
    await (await shown(fresh, 'mode-review')).click();
    await expect(fresh.locator('[data-builder-step="office"]')).toBeVisible();
    await expect(fresh.locator('[data-builder-step="office"]')).toContainText('Choose office copy');
    await (await shown(fresh, 'baseline-file')).setInputFiles(
      test.info().outputPath(`${jobRef}-office-copy.logo-project`),
    );
    await expect(await shown(fresh, 'baseline-load-status')).toContainText('Loaded saved baseline');
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

    // Download the full reviewer and continue the loop inside it.
    await (await shown(fresh, 'step-check')).click();
    const reviewerHtml = await downloadTo(fresh, `${jobRef}-reviewer.html`, () =>
      shown(fresh, 'reviewer-copy').then((control) => control.click()),
    );
    const reviewerPath = join(directory, 'full reviewer.html');
    await writeFile(reviewerPath, reviewerHtml.bytes);
    const reviewerUrl = pathToFileURL(reviewerPath).href;

    const reviewer = await context.newPage();
    watchPage(reviewer, probe);
    await reviewer.goto(reviewerUrl);
    await expect(reviewer.locator('h1')).toHaveText('Review a customer return');
    await review(reviewer, 'baseline-file').setInputFiles({
      name: `${jobRef}-office-copy.logo-project`,
      mimeType: 'application/zip',
      buffer: Buffer.from(officeCopy.bytes),
    });
    await expect(review(reviewer, 'status')).toContainText('Opened the saved copy');
    await review(reviewer, 'return-file').setInputFiles({
      name: `${jobRef}-return.logo-project`,
      mimeType: 'application/zip',
      buffer: Buffer.from(returned.bytes),
    });
    await expect(review(reviewer, 'review-panel')).toBeVisible();
    await expect(review(reviewer, 'confirmation')).toContainText(
      `Current for revision ${returnedProject.revision}`,
    );
    await expect(review(reviewer, 'geometry')).toContainText('Valid:');
    await expect(review(reviewer, 'differences')).toContainText('ISSUED');
    await expect(review(reviewer, 'differences')).toContainText('RETURNED');

    await review(reviewer, 'reviewer').fill('Local reviewer');
    await review(reviewer, 'decision').selectOption('changesRequested');
    await review(reviewer, 'note').fill('Move the first bridge mark slightly.');
    await review(reviewer, 'record-review').click();
    await expect(review(reviewer, 'internal-review')).toContainText('changesRequested');

    await openReviewDisclosure(reviewer, 'save-proposal');
    const proposalX = Number(await review(reviewer, 'x').inputValue());
    await review(reviewer, 'x').fill(String(proposalX + 2));
    await review(reviewer, 'instructions').fill('Revised proposal instructions.');
    const proposal = await downloadTo(reviewer, `${jobRef}-proposal.logo-project`, () =>
      review(reviewer, 'save-proposal').click(),
    );
    const revised = (await parseProjectPackage(proposal.bytes, { sha256: sha256bytes })).project;
    // Proposal inputs auto-apply per changed field (x, then instructions),
    // so the two edits land as two successive revisions.
    expect(revised.revision).toBe(returnedProject.revision + 2);
    expect(revised.confirmation).toBeUndefined();
    expect(revised.instructions).toBe('Revised proposal instructions.');
    const revisedBridge = revised.configurations.find((entry) => entry.id === bridgeConfigId);
    assert.ok(revisedBridge && revisedBridge.placements.length > 0, 'proposal should keep bridge placements');
    await shoot(reviewer, `${format}-11-reviewer-proposal`);

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

    // Fresh reviewer against the original baseline: approve, still pending production.
    const final = await context.newPage();
    watchPage(final, probe);
    await final.goto(reviewerUrl);
    await expect(final.locator('h1')).toHaveText('Review a customer return');
    await review(final, 'baseline-file').setInputFiles({
      name: `${jobRef}-office-copy.logo-project`,
      mimeType: 'application/zip',
      buffer: Buffer.from(officeCopy.bytes),
    });
    await expect(review(final, 'status')).toContainText('Opened the saved copy');
    await review(final, 'return-file').setInputFiles({
      name: `${jobRef}-reconfirmed.logo-project`,
      mimeType: 'application/zip',
      buffer: Buffer.from(reconfirmed.bytes),
    });
    await expect(review(final, 'review-panel')).toBeVisible();
    await expect(review(final, 'confirmation')).toContainText(`Current for revision ${revised.revision}`);
    await expect(review(final, 'geometry')).toContainText('Valid:');
    await review(final, 'reviewer').fill('Final reviewer');
    await review(final, 'decision').selectOption('approved');
    await review(final, 'note').fill('Internal workflow approval; still pending production.');
    await review(final, 'record-review').click();
    await expect(review(final, 'internal-review')).toContainText('approved');
    await expect(review(final, 'status')).toContainText('not a production release');
    await shoot(final, `${format}-12-reconfirmed-review`);

    const reviewedDownload = await downloadTo(final, `${jobRef}-reviewed.logo-project`, () =>
      review(final, 'save-reviewed').click(),
    );
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

    await openReviewDisclosure(final, 'candidate-download');
    const finalCandidateFile = await downloadTo(final, `${jobRef}-final-candidate.json`, () =>
      review(final, 'candidate-download').click(),
    );
    const finalCandidate = JSON.parse(Buffer.from(finalCandidateFile.bytes).toString('utf8')) as {
      revision: number;
      digest: string;
      status: string;
    };
    expect(finalCandidate.revision).toBe(revised.revision);
    expect(finalCandidate.status).toBe('candidate-pending-review');
    expect(finalCandidate.digest).toBe(buildCandidateExport(reconfirmedProject, sha256text).digest);
    await expect(review(final, 'candidate-status')).toContainText('candidate-pending-review');
    // The operator sheet carries business data only: no review status, no
    // digest, no customer notes (the reconfirmed project instructions stay
    // source context). Nothing is authored on this read-only page, so every
    // logo honestly reports setup needed.
    await expect(review(final, 'operation-document-container').locator('.opsheet').first()).toBeVisible();
    await expect(review(final, 'operation-document-container')).not.toContainText('Status: candidate-pending-review');
    await expect(review(final, 'operation-document-container')).not.toContainText('candidate-pending-review');
    await expect(review(final, 'operation-document-container')).not.toContainText(finalCandidate.digest);
    await expect(review(final, 'operation-document-container')).not.toContainText('Revised proposal instructions.');
    await expect(review(final, 'operation-document-container')).toContainText('setup needed before production');

    await final.setViewportSize({ width: 390, height: 844 });
    expect(await final.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shoot(final, `${format}-13-review-mobile`);

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
