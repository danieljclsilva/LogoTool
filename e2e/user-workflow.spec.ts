import { BUILDER_URL, STATION_DIR, revealBuilderControl, revealCustomerControl, selectCustomerOption } from './helpers.js';
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
import { appendPreparedProduct, preparedEvidencePaths } from '../src/core/project-builder/prepared-import.js';
import { assertProjectEditorLimits } from '../src/core/project-editor/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';

// Whole-workflow browser QA: one coherent user journey per issued format,
// spanning artifacts issued by the operator job shell (never isolated unit
// examples, never direct core mutation). Each journey covers: job-shell
// Create (primary path) with a prepared project opened as an ordinary saved
// job plus a locally synthesized raster logo, zero-placement issue in one
// format (the branch issues CURRENT staff placements; the customer places in
// the customer file as before), real offline customer editing with
// unsafe-fit rejection and reconfirmation, draft/return downloads, reopen,
// same-station branch review with Use/Keep decisions, mismatch/tamper
// preservation, operation-document review with print gating, and mobile shots.
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
  return builder(page, name);
}

function placement(page: Page, name: string) {
  return page.locator(`[data-placement-hook="${name}"]`);
}

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

function branchSummary(page: Page) {
  return branch(page).locator('section[aria-label="Job and selection summary"]');
}

function reviewHost(page: Page) {
  return builder(page, 'job-review-host');
}

function customer(page: Page, name: string) {
  return page.locator(`[data-customer-hook="${name}"]`);
}

async function journeyProjectPackage(): Promise<Uint8Array> {
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
  // The prepared inspector-bridge product joins through the validated
  // developer path (the station offers no prepared import): same append,
  // exact-byte evidence-hash check and evidence packaging the former
  // station control applied.
  const parsed: unknown = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
  const appended = appendPreparedProduct(draft.project, parsed);
  if (!appended.ok) throw new Error(`prepared fixture rejected: ${appended.errors.map((error) => `${error.code} at ${error.path}`).join('; ')}`);
  const bridgeId = appended.project.products[appended.project.products.length - 1]!.id;
  if (appended.areaBundleText === null || appended.areaBundleSha256 === null) {
    throw new Error('prepared fixture carries no verified area-bundle evidence');
  }
  const evidenceBytes = new Uint8Array(Buffer.from(appended.areaBundleText, 'utf8'));
  if (createHash('sha256').update(evidenceBytes).digest('hex') !== appended.areaBundleSha256) {
    throw new Error('prepared fixture evidence hash mismatch');
  }
  const evidencePaths = preparedEvidencePaths(bridgeId);
  const additionalAssets: Array<{ path: string; bytes: Uint8Array }> = [];
  if (appended.sidecar !== null && typeof appended.sidecar === 'object') {
    additionalAssets.push({ path: evidencePaths.sidecar, bytes: new Uint8Array(Buffer.from(JSON.stringify(appended.sidecar, null, 2), 'utf8')) });
  }
  additionalAssets.push({ path: evidencePaths.areaBundle, bytes: evidenceBytes });
  assertProjectEditorLimits(appended.project);
  return createProjectPackage({ project: appended.project, assets, additionalAssets }, { sha256: sha256bytes });
}

/** Open the explicit journey fixture as an ordinary saved job (header Open). */
async function openJourneyProject(page: Page): Promise<void> {
  const bytes = await journeyProjectPackage();
  await builder(page, 'job-open-file').setInputFiles({
    name: 'synthetic-journey.logo-project', mimeType: 'application/zip', buffer: Buffer.from(bytes),
  });
  await expect(await shown(page, 'source-status')).toContainText('Loaded synthetic-journey.logo-project');
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
}

async function setChecked(box: import('@playwright/test').Locator, checked: boolean): Promise<void> {
  await box.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.checked = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
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
    branch(page).getByRole('button', { name: buttonName }).click(),
  ]);
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
  // typing a height after width auto-unlocks and sticks (height input handler), which is
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
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

async function runUserWorkflow(
  browser: Browser,
  format: 'self' | 'hybrid',
  stationUrl: string = BUILDER_URL,
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
    }, null, 2),
  });
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  let directory = '';
  try {
    // ---- Job shell: create a genuinely new job from the landing. ----
    const page = await context.newPage();
    watchPage(page, probe);
    await page.goto(stationUrl);
    await expect(page.locator('[data-job-landing]')).toContainText('Prepare an operational document');
    await shoot(page, `${format}-01-start`);

    await builder(page, 'job-landing-create').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(page.locator('[data-job-step="prepare"]')).toContainText('Prepare the job');
    // Explicit synthetic project (catalogue definitions plus the prepared
    // inspector-bridge product, assembled through the validated developer
    // path) opened as an ordinary saved job through the real chooser.
    await openJourneyProject(page);
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

    // Keep the prepared bridge product plus one prepared tee; drop the rest.
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
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill(jobRef);
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await expect(builder(page, 'job-to-placements')).toBeEnabled();
    await shoot(page, `${format}-02-selection`);
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await selectWorkspaceOption(page, 'SYN-BRIDGE-001');

    // ---- Approval branch: zero-placement issue of current staff geometry. ----
    await openApprovalBranch(page);
    await expect(branch(page)).toContainText(`${CUSTOMER} / job ${jobRef}`);
    if (format === 'hybrid') {
      await branch(page).locator('summary', { hasText: 'More options' }).click();
      await branch(page).getByRole('radio', { name: 'ZIP file with the setup files inside' }).check();
    }
    await shoot(page, `${format}-03-issued`);
    const issuedProjectId = await createBranchIssue(page);

    const officeCopy = await downloadTo(page, `${jobRef}-office-copy.logo-project`, () =>
      branch(page).getByRole('button', { name: 'Save office copy' }).click(),
    );
    const delivery = await downloadTo(page, `${jobRef}-customer-file`, () =>
      branch(page).getByRole('button', { name: 'Save customer file' }).click(),
    );
    if (format === 'hybrid') expect(delivery.name).toBe(`${jobRef}-customer-file.zip`);
    else expect(delivery.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    // Second issue with a fresh ID but an identical selection: same assets,
    // different project. Saved now and used later as the wrong-baseline
    // return probe (same assets so the app reaches the project-identity
    // check instead of stopping at asset comparison).
    // Issued after the delivery download above, so the customer journey keeps
    // the first issue's files.
    const otherProjectId = await createBranchIssue(page);
    assert.ok(otherProjectId.length > 0 && otherProjectId !== issuedProjectId, 'expected a fresh project ID');
    await downloadTo(page, `${jobRef}-office-copy-2.logo-project`, () =>
      branch(page).getByRole('button', { name: 'Save office copy' }).click(),
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

    // ---- Same-station branch review: open the office copy, then the return. ----
    await selectWorkspaceOption(page, 'SYN-BRIDGE-001');
    await openApprovalBranch(page);
    await branchOpenFile(page, 'Open office copy', officeCopy.name, officeCopy.bytes);
    await expect(branch(page)).toContainText(`Office copy loaded: ${officeCopy.name}`);
    await branchOpenFile(page, 'Open customer response', returned.name, returned.bytes);
    await expect(branch(page)).toContainText('Response checked against the office copy');
    await expect(branch(page)).toContainText(`Workflow instructions ${jobRef}.`);
    await expect(branch(page)).toContainText('confirmed by Workflow customer');
    await shoot(page, `${format}-09-response-checked`);

    // Keep current job first: the checked response is discarded without
    // touching the active job; then check again and install it.
    const scopeBefore = await branchSummary(page).textContent();
    await branch(page).getByRole('button', { name: 'Keep current job' }).click();
    await expect(branch(page)).toContainText('Kept the current job.');
    expect(await branchSummary(page).textContent()).toBe(scopeBefore);
    await branchOpenFile(page, 'Open customer response', returned.name, returned.bytes);
    await expect(branch(page)).toContainText('Response checked against the office copy');
    await branch(page).getByRole('button', { name: 'Use customer changes' }).click();
    // Installing the validated response opens Step 2 with the new geometry.
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await selectWorkspaceOption(page, 'SYN-BRIDGE-001');
    // Both customer-authored bridge placements ride along on the option.
    await expect(placement(page, 'pw-placement-list').locator('button')).toHaveCount(2);
    await expect(placement(page, 'pw-placement-list')).toContainText('synthetic raster logo');
    await shoot(page, `${format}-10-installed-placements`);

    // Invalid and wrong-project files preserve the previous good state: the
    // invalid return is rejected before reading, and the second office copy
    // carries the same assets under a different project ID, so the check
    // reaches baseline-project-mismatch without touching the job.
    const summaryAfterInstall = await branchSummary(page).textContent();
    await openApprovalBranch(page);
    await branchOpenFile(
      page,
      'Open customer response',
      'invalid-return.logo-project',
      new TextEncoder().encode('not a logo project'),
    );
    await expect(branch(page)).toContainText('Could not import response invalid-return.logo-project');
    await expect(branch(page)).toContainText('The active job and outputs are unchanged.');
    expect(await branchSummary(page).textContent()).toBe(summaryAfterInstall);
    await branchOpenFile(page, 'Open office copy', `${jobRef}-office-copy-2.logo-project`, new Uint8Array(
      await readFile(test.info().outputPath(`${jobRef}-office-copy-2.logo-project`)),
    ));
    await expect(branch(page)).toContainText(`Office copy loaded: ${jobRef}-office-copy-2.logo-project`);
    await branchOpenFile(page, 'Open customer response', returned.name, returned.bytes);
    await expect(branch(page)).toContainText('Could not import response');
    await expect(branch(page)).toContainText('baseline-project-mismatch');
    await expect(branch(page)).toContainText('The active job and outputs are unchanged.');
    expect(await branchSummary(page).textContent()).toBe(summaryAfterInstall);

    // ---- Step 3: review the actual operational document for the job. ----
    // Installing the response lands like a new source with nothing
    // pre-selected (empty-start UX): re-include the installed products exactly
    // as the operator would before reviewing the installed geometry.
    // Top-level boxes first (variant rows only appear while their product
    // stays checked), then every visible variant box, mirroring deliberate
    // narrowing: untouched setups ride along automatically afterwards.
    await builder(page, 'job-step-1').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    const installedProducts = await shown(page, 'product-list');
    for (const id of ['SYN-BRIDGE-001', 'SYN-TEE-001']) {
      await installedProducts.locator(`input[type="checkbox"][value="${id}"]:not([data-product])`).check();
    }
    for (const id of ['SYN-BRIDGE-001', 'SYN-TEE-001']) {
      const variants = installedProducts.locator(`input[type="checkbox"][data-product="${id}"]`);
      for (let index = 0; index < await variants.count(); index += 1) {
        if (await variants.nth(index).isVisible()) await variants.nth(index).check();
      }
    }
    await builder(page, 'job-step-3').click();
    await expect(page.locator('[data-job-step="review"]')).toBeVisible();
    await expect(reviewHost(page)).toContainText('Review operational document');
    await expect(reviewHost(page)).toContainText(`Customer: ${CUSTOMER}`);
    await expect(reviewHost(page)).toContainText(`Job: ${jobRef}`);
    await expect(reviewHost(page)).toContainText('Products: 2');
    await expect(reviewHost(page)).toContainText('Placements: 3');
    const preview = reviewHost(page).locator('[data-doc-review-preview]');
    await expect(preview.locator('.opsheet').first()).toBeVisible();
    // Placed customer artwork is listed by name; its customer-authored notes
    // stay read-only context and never print as staff instructions.
    await expect(preview).toContainText('Synthetic Mark A');
    await expect(preview).not.toContainText('First bridge mark.');
    await expect(preview).toContainText('No logos configured on this sheet');
    // The operator sheet carries business geometry only: no digest, no
    // customer notes, no review status on the sheet.
    const expectedCandidate = buildCandidateExport(returnedProject, sha256text);
    await expect(preview).not.toContainText(expectedCandidate.digest);
    await expect(preview).not.toContainText(`Workflow instructions ${jobRef}.`);
    // Department-authored instructions print on the sheet; customer notes stay
    // read-only context above and never become staff instructions.
    await reviewHost(page).locator('[data-doc-review-instructions]').fill(
      'Press the bridge emblem at 160°C for 15 seconds with medium pressure.',
    );
    await reviewHost(page).locator('[data-doc-review-instructions]').press('Tab');
    await expect(preview).toContainText('Press the bridge emblem at 160°C');
    // Installed customer geometry carries no staff measurement bindings, so
    // the document is honestly incomplete: complete print stays disabled and
    // the operator uses the explicitly marked Print draft (decision 14 —
    // confirmation never substitutes for staff measurement). The operator
    // adds placement measurements afterwards, or ships the marked draft.
    await expect(reviewHost(page).getByRole('button', { name: 'Print / save PDF' })).toBeDisabled();
    const draftButton = reviewHost(page).getByRole('button', { name: 'Print draft' });
    await expect(draftButton).toBeVisible();
    await expect(draftButton).toBeEnabled();
    await expect(preview).toContainText(/DRAFT/i);
    // The draft control is wired to the browser print dialog (stubbed here —
    // the native dialog itself is never asserted in tests).
    await page.evaluate(() => {
      const gate = globalThis as unknown as { printed?: boolean };
      gate.printed = false;
      globalThis.print = () => { gate.printed = true; };
    });
    await draftButton.click();
    expect(await page.evaluate(() => (globalThis as unknown as { printed?: boolean }).printed)).toBe(true);
    await shoot(page, `${format}-11-review-document`);

    // Structured outputs for the exact preview snapshot: operator data plus
    // the diagnostic candidate (digest must match the returned project).
    await reviewHost(page).locator('summary', { hasText: 'More output options' }).click();
    const operatorFile = await downloadTo(page, `${jobRef}-operator-data.json`, () =>
      reviewHost(page).getByRole('button', { name: 'Save operator data' }).click(),
    );
    expect(operatorFile.name).toBe(`${jobRef}-operator-data.json`);
    const operatorView = JSON.parse(Buffer.from(operatorFile.bytes).toString('utf8')) as { format: string };
    expect(operatorView.format).toBe('operation-export/1');
    const diagnosticFile = await downloadTo(page, `${jobRef}-candidate.json`, () =>
      reviewHost(page).getByRole('button', { name: 'Save diagnostic data' }).click(),
    );
    expect(diagnosticFile.name).toBe(`${jobRef}-candidate.json`);
    const diagnosticJson = JSON.parse(Buffer.from(diagnosticFile.bytes).toString('utf8')) as {
      revision: number;
      digest: string;
      status: string;
    };
    expect(diagnosticJson.status).toBe('candidate-pending-review');
    expect(diagnosticJson.revision).toBe(returnedProject.revision);
    expect(diagnosticJson.digest).toBe(expectedCandidate.digest);

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('header.station-header')).toBeHidden();
    await expect(preview.locator('.opsheet').first()).toBeVisible();
    await page.emulateMedia({ media: 'screen' });

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shoot(page, `${format}-12-review-mobile`);

    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

test('whole-workflow journey through the self-contained customer file', async ({ browser }) => {
  test.setTimeout(300_000);
  await runUserWorkflow(browser, 'self');
});

test('whole-workflow journey through the hybrid ZIP customer file', async ({ browser }) => {
  test.setTimeout(300_000);
  await runUserWorkflow(browser, 'hybrid');
});

for (const format of ['self', 'hybrid'] as const) {
  test(`whole-workflow journey from a fresh station copy (${format} customer file)`, async ({ browser }) => {
    test.setTimeout(300_000);
    // The complete staff journey — prepare, issue, customer edit/confirm,
    // same-station branch review, install, operation-document review — running
    // every staff page from a fresh copy of dist/station with spaces in its
    // path, keeping the actual downloaded customer bytes throughout. No
    // repo-checkout dependence.
    const stationCopy = await mkdtemp(join(tmpdir(), 'Logo Station copy '));
    try {
      await cp(STATION_DIR, stationCopy, { recursive: true });
      await runUserWorkflow(browser, format, pathToFileURL(join(stationCopy, 'Logo Station.html')).href);
    } finally {
      await rm(stationCopy, { recursive: true, force: true });
    }
  });
}
