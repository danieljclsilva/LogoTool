import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import type { ProjectDocument, Sha256HexFn } from '../src/core/types.js';
import { buildCandidateExport, confirmRevision, contentDigest } from '../src/core/index.js';
import { gotoBuilder, revealBuilderControl, revealCustomerControl, selectCustomerOption } from './helpers.js';

// Operator photo-mapping workflow: builder setup through visible controls,
// issue with serialized mappings, mapped customer photo proof with real PNG
// artwork, inverse-mapping drag, confirm/save/reopen, staff baseline review,
// candidate + operation proof. Synthetic fixtures only; offline file://.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256Text: Sha256HexFn = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return ['builder-next', 'builder-back'].includes(name)
    ? builder(page, name).filter({ visible: true }).first()
    : builder(page, name);
}

async function openBuilder(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await gotoBuilder(page);
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
  return { context, page };
}

async function syntheticPng(page: Page, color: string): Promise<Uint8Array> {
  const base64 = await page.evaluate((fill) => {
    const canvas = document.createElement('canvas');
    canvas.width = 20; canvas.height = 10;
    const context = canvas.getContext('2d')!;
    context.fillStyle = fill; context.fillRect(0, 0, 20, 10);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, color);
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function trustedBase(): Promise<{ project: ProjectDocument; assets: Array<{ path: string; kind: string; bytes: Uint8Array }> }> {
  const parsed = await parseProjectPackage(new Uint8Array(await readFile(resolve('dist/trusted-issued.logo-project'))), { sha256 });
  return { project: parsed.project, assets: parsed.assets as Array<{ path: string; kind: string; bytes: Uint8Array }> };
}

function v2Manifest(productId: string, variantId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 2,
    views: [{ productId, variantId, view: 'front', image: 'presentation/front.png' }],
  }));
}

/** Mapped source package: v2 front view + raster + correct-region mapping. */
async function mappedSource(page: Page): Promise<{ bytes: Uint8Array; png: Uint8Array }> {
  const base = await trustedBase();
  const png = await syntheticPng(page, '#1d6f3a');
  const config = base.project.configurations.find((item) => item.id === 'SYN-CFG-TEE-M')!;
  const bytes = await createProjectPackage({
    project: base.project,
    assets: base.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes: data }) => ({ path, bytes: data })),
    additionalAssets: [
      { path: 'presentation/preview.json', bytes: v2Manifest(config.productId, config.variantId) },
      { path: 'presentation/front.png', bytes: png },
    ],
  }, { sha256 });
  return { bytes, png };
}

async function selectAllLists(page: Page): Promise<void> {
  for (const listHook of ['product-list', 'logo-list', 'configuration-list']) {
    const list = await shown(page, listHook);
    const boxes = list.locator('input[type="checkbox"]');
    const count = await boxes.count();
    for (let index = 0; index < count; index += 1) {
      const box = boxes.nth(index);
      if (await box.isVisible() && await box.isEnabled()) await box.check();
    }
  }
  await page.locator('details', { has: page.locator('[data-builder-hook="configuration-list"]') }).locator('summary').click();
}

async function readDownload(page: Page, fileName: string, trigger: () => Promise<void>): Promise<Uint8Array> {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  const download = await downloadPromise;
  const outputPath = join(await mkdtemp(join(tmpdir(), 'logotool-mapping-flow-')), fileName);
  await download.saveAs(outputPath);
  return new Uint8Array(await readFile(outputPath));
}

test('operator maps a photo, issues it, and the customer proves placement on the mapped photo', async ({ browser }) => {
  test.slow(); // Full operator→customer→staff chain with real hashing and downloads.
  const { context, page } = await openBuilder(browser);
  const probe = { pageErrors: [] as string[], consoleErrors: [] as string[], networkRequests: [] as string[] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') probe.consoleErrors.push(message.text()); });
  context.on('request', (request) => { if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url()); });
  const directory = await mkdtemp(join(tmpdir(), 'LogoTool mapping workflow '));
  try {
    // Source with a declared front photo for tee/M.
    const { bytes: sourceBytes, png } = await mappedSource(page);
    const sourcePath = join(directory, 'mapping-source.logo-project');
    await writeFile(sourcePath, sourceBytes);
    await (await shown(page, 'source-file')).setInputFiles(sourcePath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded mapping-source.logo-project');
    // A raster customer logo for the real artwork overlay.
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'overlay.png', mimeType: 'image/png', buffer: Buffer.from(png) });
    await expect(await shown(page, 'logo-status')).toContainText('Added overlay.png');
    await selectAllLists(page);
    await expect(await shown(page, 'selection-summary')).toContainText('2 products');

    // ---- Operator mapping setup through visible controls. ----
    await (await shown(page, 'mapping-product')).selectOption('SYN-TEE-001');
    await (await shown(page, 'mapping-variant')).selectOption('SYN-TEE-M');
    await (await shown(page, 'mapping-region')).selectOption('SYN-TEE-CHEST');
    await expect(await shown(page, 'mapping-frame')).toContainText('CAL-SYN-001');
    await (await shown(page, 'mapping-side')).selectOption('front');
    await (await shown(page, 'mapping-photo')).selectOption('presentation/front.png');
    // CHEST safe area x in [-100,100], y in [-80,80]: u=(x+100)/200, v=(80-y)/160.
    const corners = [
      { u: '0', v: '1', x: '-100', y: '-80' },
      { u: '1', v: '1', x: '100', y: '-80' },
      { u: '1', v: '0', x: '100', y: '80' },
    ];
    for (let index = 0; index < corners.length; index += 1) {
      const corner = corners[index]!;
      await page.locator(`[aria-label="Reference point ${index + 1} U (0..1)"]`).fill(corner.u);
      await page.locator(`[aria-label="Reference point ${index + 1} V (0..1)"]`).fill(corner.v);
      await page.locator(`[aria-label="Reference point ${index + 1} X millimetres"]`).fill(corner.x);
      await page.locator(`[aria-label="Reference point ${index + 1} Y millimetres"]`).fill(corner.y);
    }
    await (await shown(page, 'mapping-check')).click();
    await expect(await shown(page, 'mapping-status-line')).toContainText('Fit OK over 3 points');
    await (await shown(page, 'mapping-save')).click();
    await expect(await shown(page, 'mapping-status-line')).toContainText('Saved provisional mapping');
    await expect(await shown(page, 'mapping-saved')).toContainText('SYN-TEE-CHEST');
    // A degenerate fit is refused and preserves the staged mapping.
    await page.locator('[aria-label="Reference point 3 X millimetres"]').fill('-100');
    await page.locator('[aria-label="Reference point 3 Y millimetres"]').fill('-80');
    await (await shown(page, 'mapping-check')).click();
    await expect(await shown(page, 'mapping-status-line')).toContainText('Check failed');
    await expect(await shown(page, 'mapping-saved')).toContainText('SYN-TEE-CHEST');

    // ---- Issue with the staged mapping serialized into the package. ----
    await (await shown(page, 'builder-next')).click();
    await (await shown(page, 'customer-name')).fill('Mapping QA');
    await (await shown(page, 'job-ref')).fill('MAP-01');
    await (await shown(page, 'issued-by')).fill('Mapping operator');
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('revision 1');
    const baseline = await readDownload(page, 'mapping-baseline.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()));
    const issued = await parseProjectPackage(baseline, { sha256 });
    const mappingBytes = issued.assets.find((asset) => asset.path === 'presentation/photo-mappings.json')?.bytes;
    assert.ok(mappingBytes, 'issued package carries the staged photo mapping');
    const mappings = JSON.parse(new TextDecoder().decode(mappingBytes));
    assert.equal(mappings.version, 1);
    assert.equal(mappings.mappings.length, 1);
    assert.deepEqual(
      { productId: mappings.mappings[0].productId, regionId: mappings.mappings[0].regionId, view: mappings.mappings[0].view, image: mappings.mappings[0].image, calibrationId: mappings.mappings[0].calibrationId, calibrationVersion: mappings.mappings[0].calibrationVersion, status: mappings.mappings[0].status },
      { productId: 'SYN-TEE-001', regionId: 'SYN-TEE-CHEST', view: 'front', image: 'presentation/front.png', calibrationId: 'CAL-SYN-001', calibrationVersion: 'v1', status: 'provisional' },
    );

    // ---- Customer: mapped photo proof with real PNG artwork. ----
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      shown(page, 'download-package').then((control) => control.click()));
    const htmlPath = join(directory, 'OPEN.html');
    await writeFile(htmlPath, html);
    const customer = await context.newPage();
    customer.on('pageerror', (error) => probe.pageErrors.push(String(error)));
    customer.on('console', (message) => { if (message.type() === 'error') probe.consoleErrors.push(message.text()); });
    await customer.goto(pathToFileURL(htmlPath).href);
    const hook = (name: string) => customer.locator(`[data-customer-hook="${name}"]`);
    await expect(hook('project-id')).not.toHaveText('Not loaded');
    // Place the raster logo on the mapped chest area.
    await selectCustomerOption(customer, 'configuration', 'SYN-CFG-TEE-M');
    await selectCustomerOption(customer, 'region', 'SYN-TEE-CHEST');
    const logoValues = await hook('logo').evaluate((select) => Array.from((select as HTMLSelectElement).options).map((option) => option.value));
    const rasterId = logoValues.find((value) => !value.startsWith('SYN-LOGO'));
    assert.ok(rasterId, `expected an imported raster logo, saw: ${logoValues.join(',')}`);
    await selectCustomerOption(customer, 'logo', rasterId);
    // Start a genuinely new placement so the width edit below does not apply
    // onto the selected existing placement (live auto-apply would retarget it).
    await revealCustomerControl(customer, 'add-another');
    await hook('add-another').click();
    await revealCustomerControl(customer, 'width-mm');
    await hook('width-mm').fill('60');
    await hook('width-mm').press('Tab');
    const placementsBefore = await hook('placement').locator('option').count();
    await revealCustomerControl(customer, 'add');
    await hook('add').click();
    await expect(hook('placement').locator('option')).toHaveCount(placementsBefore + 1);
    // The front side tab is enabled by the validated mapping; photo mode
    // shows the real photo with the actual PNG artwork overlay.
    await expect(hook('side-front')).toBeEnabled();
    await hook('side-front').click();
    await expect(hook('mode-photo')).toBeEnabled();
    await hook('mode-photo').click();
    await expect(hook('reference-img')).toBeVisible();
    await expect.poll(() => hook('reference-img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(20);
    await expect(hook('photo-overlay').locator('image')).toHaveCount(1);
    await expect(hook('mapping-status')).toContainText('visual trial, not production approval');
    // Drag on the mapped photo moves the placement through the inverse mapping.
    const overlay = hook('photo-overlay');
    const box = (await overlay.boundingBox())!;
    const revisionBefore = Number(await hook('revision').textContent());
    const xBefore = Number(await hook('x-mm').inputValue());
    await customer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await customer.mouse.down();
    await customer.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 12, { steps: 3 });
    await customer.mouse.up();
    await expect(hook('revision')).toHaveText(String(revisionBefore + 1));
    expect(Number(await hook('x-mm').inputValue())).not.toBe(xBefore);
    // Confirm and save the return; reopening keeps the confirmation.
    await revealCustomerControl(customer, 'instructions');
    await hook('instructions').fill('Mapped proof instructions.');
    await hook('instructions').press('Tab');
    await revealCustomerControl(customer, 'confirmed-by');
    await hook('confirmed-by').fill('Mapping reviewer');
    await revealCustomerControl(customer, 'confirm');
    await hook('confirm').click();
    await expect(hook('confirmation')).toContainText('Confirmed: version');
    const savedReturn = await (async () => {
      const downloadPromise = customer.waitForEvent('download');
      await revealCustomerControl(customer, 'submit');
      await hook('submit').click();
      const download = await downloadPromise;
      // Descriptive Windows-portable return name (identity + revision).
      expect(download.suggestedFilename()).toMatch(/-r\d+-confirmed-return\.logo-project$/);
      const outputPath = join(directory, 'mapping-return.logo-project');
      await download.saveAs(outputPath);
      return new Uint8Array(await readFile(outputPath));
    })();
    await hook('file-input').setInputFiles({ name: 'mapping-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(savedReturn) });
    await expect(hook('confirmation')).toContainText('Confirmed: version');
    await customer.close();

    // ---- Staff review: baseline holds, candidate matches, proof is provisional. ----
    await (await shown(page, 'mode-review')).click();
    await (await shown(page, 'baseline-file')).setInputFiles({ name: 'mapping-baseline.logo-project', mimeType: 'application/zip', buffer: Buffer.from(baseline) });
    await expect(await shown(page, 'baseline-load-status')).toContainText('Loaded saved baseline');
    await (await shown(page, 'return-file')).setInputFiles({ name: 'mapping-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(savedReturn) });
    await expect(await shown(page, 'review-panel')).toBeVisible();
    await expect(await shown(page, 'review-changes')).toContainText('Mapped proof instructions.');
    const candidateBytes = await readDownload(page, 'mapping-candidate.json', () =>
      shown(page, 'candidate-download').then((control) => control.click()));
    const candidate = JSON.parse(new TextDecoder().decode(candidateBytes));
    const returned = await parseProjectPackage(savedReturn, { sha256 });
    assert.equal(candidate.revision, returned.project.revision);
    assert.equal(candidate.digest, buildCandidateExport(returned.project, sha256Text).digest);
    await (await shown(page, 'preview-document')).click();
    // The one-sheet preview composites the actual mapped PNG artwork (photo
    // + real artwork through the evaluated mapping), never just binding
    // metadata; SVG originals stay unrendered. Captions are side-only with
    // one trial disclaimer for the sheet.
    await expect(page.locator('svg.opsheet-photo-svg').first()).toBeVisible();
    await expect(page.locator('image.opsheet-artwork-overlay')).toHaveCount(1);
    await expect(page.locator('figure.opsheet-photo figcaption').first()).toHaveText('front');
    await expect(page.locator('p.opsheet-trial-note')).toHaveCount(1);
    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale calibration and undeclared photos fall back to the measured diagram', async ({ browser }) => {
  const { context, page } = await openBrowserForCustomer(browser);
  try {
    const base = await trustedBase();
    const png = await syntheticPng(page, '#1d6f3a');
    const config = base.project.configurations.find((item) => item.id === 'SYN-CFG-TEE-M')!;
    const manifest = new TextEncoder().encode(JSON.stringify({
      version: 2,
      views: [{ productId: config.productId, variantId: config.variantId, view: 'front', image: 'presentation/front.png' }],
    }));
    const goodTransform = { a: 1 / 200, b: 0, c: 0.5, d: 0, e: -1 / 160, f: 0.5 };
    const staleCalibration = new TextEncoder().encode(JSON.stringify({
      version: 1,
      mappings: [{
        productId: config.productId, variantId: config.variantId, regionId: 'SYN-TEE-CHEST',
        view: 'front', image: 'presentation/front.png', transform: goodTransform,
        calibrationId: 'CAL-SYN-001', calibrationVersion: 'v9-stale', status: 'provisional',
      }],
    }));
    const staleBytes = await createProjectPackage({
      project: base.project,
      assets: base.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
      additionalAssets: [
        { path: 'presentation/preview.json', bytes: manifest },
        { path: 'presentation/front.png', bytes: png },
        { path: 'presentation/photo-mappings.json', bytes: staleCalibration },
      ],
    }, { sha256 });
    await loadCustomer(page, staleBytes, 'stale-calibration.logo-project');
    const hook = customerHook(page);
    // The stale mapping must not enable the side or the photo mode: the
    // status names the calibration mismatch and the diagram stays authority.
    await expect(hook('side-front')).toBeDisabled();
    await expect(hook('mode-photo')).toBeDisabled();
    await expect(hook('canvas')).toBeVisible();
    await expect(hook('reference-img')).toBeHidden();
    await expect(hook('mapping-status')).toContainText('reference only');

    // Mapping photo that is not a declared preview view also falls back.
    const other = await syntheticPng(page, '#4b3912');
    const undeclared = new TextEncoder().encode(JSON.stringify({
      version: 1,
      mappings: [{
        productId: config.productId, variantId: config.variantId, regionId: 'SYN-TEE-CHEST',
        view: 'front', image: 'presentation/other.png', transform: goodTransform,
        calibrationId: 'CAL-SYN-001', calibrationVersion: 'v1', status: 'provisional',
      }],
    }));
    const undeclaredBytes = await createProjectPackage({
      project: base.project,
      assets: base.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
      additionalAssets: [
        { path: 'presentation/preview.json', bytes: manifest },
        { path: 'presentation/front.png', bytes: png },
        { path: 'presentation/other.png', bytes: other },
        { path: 'presentation/photo-mappings.json', bytes: undeclared },
      ],
    }, { sha256 });
    await loadCustomer(page, undeclaredBytes, 'undeclared-photo.logo-project');
    await expect(hook('side-front')).toBeDisabled();
    await expect(hook('mode-photo')).toBeDisabled();
    await expect(hook('mapping-status')).toContainText('reference only');
  } finally {
    await context.close();
  }
});

test('sheared mapping with a rotated placement still renders the artwork overlay', async ({ browser }) => {
  // Regression against width-axis-only rendering: a sheared invertible
  // affine plus a nonzero placement turn must still produce the true
  // parallelogram overlay (shared matrix path with the proof composite).
  const { context, page } = await openBrowserForCustomer(browser);
  try {
    const base = await trustedBase();
    const png = await syntheticPng(page, '#1d6f3a');
    const project = structuredClone(base.project);
    project.logos.push({
      schemaVersion: project.schemaVersion,
      id: 'SYN-SHEAR-ART',
      name: 'Shear art',
      assets: [{ uri: 'logos/shear.png', role: 'original', mediaType: 'image/png', widthPx: 20, heightPx: 10 }],
    });
    const placement = project.configurations[0]!.placements[0]!;
    placement.logoId = 'SYN-SHEAR-ART';
    placement.regionId = 'SYN-TEE-CHEST';
    placement.rotationDeg = 15;
    const config = project.configurations[0]!;
    const manifest = new TextEncoder().encode(JSON.stringify({
      version: 2,
      views: [{ productId: config.productId, variantId: config.variantId, view: 'front', image: 'presentation/front.png' }],
    }));
    // Sheared but invertible (|det| well above the 1e-12 bound).
    const shear = { a: 1 / 200, b: 0.0008, c: 0.4, d: 0.0005, e: -1 / 160, f: 0.6 };
    const product = project.products.find((item) => item.id === config.productId)!;
    const region = product.regions.find((item) => item.id === 'SYN-TEE-CHEST')!;
    const mappings = new TextEncoder().encode(JSON.stringify({
      version: 1,
      mappings: [{
        productId: config.productId, variantId: config.variantId, regionId: region.id,
        view: 'front', image: 'presentation/front.png', transform: shear,
        calibrationId: region.calibrationRef.calibrationId, calibrationVersion: region.calibrationRef.version,
        status: 'provisional',
      }],
    }));
    const bytes = await createProjectPackage({
      project,
      assets: [
        ...base.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes: data }) => ({ path, bytes: data })),
        { path: 'logos/shear.png', bytes: png },
      ],
      additionalAssets: [
        { path: 'presentation/preview.json', bytes: manifest },
        { path: 'presentation/front.png', bytes: png },
        { path: 'presentation/photo-mappings.json', bytes: mappings },
      ],
    }, { sha256 });
    await loadCustomer(page, bytes, 'sheared-rotated.logo-project');
    const hook = customerHook(page);
    await expect(hook('side-front')).toBeEnabled();
    await hook('side-front').click();
    await expect(hook('mode-photo')).toBeEnabled();
    await hook('mode-photo').click();
    await expect(hook('reference-img')).toBeVisible();
    await expect.poll(() => hook('reference-img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(20);
    // The rotated artwork renders under shear (parallelogram, not axis box).
    await expect(hook('photo-overlay').locator('image')).toHaveCount(1);
    const transform = await hook('photo-overlay').locator('image').getAttribute('transform');
    assert.ok(transform !== null && transform.startsWith('matrix('), `expected an exact affine matrix overlay, saw: ${transform}`);
    await expect(hook('mapping-status')).toContainText('visual trial, not production approval');
  } finally {
    await context.close();
  }
});

test('staged mappings survive Save master, reopen, issue and the mapped photo proof', async ({ browser }) => {
  const { context, page } = await openBuilder(browser);
  try {
    const base = await trustedBase();
    const png = await syntheticPng(page, '#12394b');
    const sourceBytes = await createProjectPackage({
      project: base.project,
      assets: base.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
      additionalAssets: [
        { path: 'presentation/preview.json', bytes: v2Manifest(base.project.configurations[0]!.productId, base.project.configurations[0]!.variantId) },
        { path: 'presentation/front.png', bytes: png },
      ],
    }, { sha256 });
    const directory = await mkdtemp(join(tmpdir(), 'LogoTool master reuse '));
    try {
      const sourcePath = join(directory, 'reuse-source.logo-project');
      await writeFile(sourcePath, sourceBytes);
      // Open through the real native file chooser on the visible action.
      const chooserPromise = page.waitForEvent('filechooser');
      await (await shown(page, 'source-choose')).click();
      await (await chooserPromise).setFiles(sourcePath);
      await expect(await shown(page, 'source-status')).toContainText('Loaded reuse-source.logo-project');
      // Without staged mappings the master saves verbatim.
      const plainMaster = await readDownload(page, 'plain-master.logo-project', () =>
        shown(page, 'save-master').then((control) => control.click()));
      expect(Buffer.from(plainMaster)).toEqual(Buffer.from(sourceBytes));
      // Stage one mapping through the visible setup, then save the master:
      // the mappings file is added while original binaries stay verbatim.
      await (await shown(page, 'mapping-product')).selectOption('SYN-TEE-001');
      await (await shown(page, 'mapping-variant')).selectOption('SYN-TEE-M');
      await (await shown(page, 'mapping-region')).selectOption('SYN-TEE-CHEST');
      await (await shown(page, 'mapping-side')).selectOption('front');
      await (await shown(page, 'mapping-photo')).selectOption('presentation/front.png');
      const corners = [
        { u: '0', v: '1', x: '-100', y: '-80' },
        { u: '1', v: '1', x: '100', y: '-80' },
        { u: '1', v: '0', x: '100', y: '80' },
      ];
      for (let index = 0; index < corners.length; index += 1) {
        const corner = corners[index]!;
        await page.locator(`[aria-label="Reference point ${index + 1} U (0..1)"]`).fill(corner.u);
        await page.locator(`[aria-label="Reference point ${index + 1} V (0..1)"]`).fill(corner.v);
        await page.locator(`[aria-label="Reference point ${index + 1} X millimetres"]`).fill(corner.x);
        await page.locator(`[aria-label="Reference point ${index + 1} Y millimetres"]`).fill(corner.y);
      }
      await (await shown(page, 'mapping-save')).click();
      await expect(await shown(page, 'mapping-status-line')).toContainText('Saved provisional mapping');
      const master = await readDownload(page, 'master.logo-project', () =>
        shown(page, 'save-master').then((control) => control.click()));
      const reparsed = await parseProjectPackage(master, { sha256 });
      const original = await parseProjectPackage(sourceBytes, { sha256 });
      assert.equal(JSON.stringify(reparsed.project), JSON.stringify(original.project));
      const masterMappings = reparsed.assets.find((asset) => asset.path === 'presentation/photo-mappings.json');
      assert.ok(masterMappings, 'master carries the staged mapping file');
      assert.equal(JSON.parse(new TextDecoder().decode(masterMappings.bytes)).mappings.length, 1);
      for (const asset of original.assets) {
        if (asset.path === 'presentation/photo-mappings.json') continue;
        const roundTripped = reparsed.assets.find((entry) => entry.path === asset.path);
        assert.ok(roundTripped, `master keeps ${asset.path}`);
        assert.deepEqual(Array.from(roundTripped.bytes), Array.from(asset.bytes));
      }
      // Routine reuse: a fresh page reopens the saved master, issues WITHOUT
      // re-entering the mapping, and the customer sees the mapped photo proof.
      const fresh = await context.newPage();
      await gotoBuilder(fresh);
      await fresh.locator('[data-builder-hook="source-file"]').setInputFiles({
        name: 'master.logo-project', mimeType: 'application/zip', buffer: Buffer.from(master),
      });
      await expect(fresh.locator('[data-builder-hook="source-status"]')).toContainText('Loaded master.logo-project');
      const freshShown = async (name: string) => {
        await revealBuilderControl(fresh, name);
        return ['builder-next', 'builder-back'].includes(name)
          ? fresh.locator(`[data-builder-hook="${name}"]`).filter({ visible: true }).first()
          : fresh.locator(`[data-builder-hook="${name}"]`);
      };
      const freshLists = ['product-list', 'logo-list', 'configuration-list'] as const;
      for (const listHook of freshLists) {
        const list = await freshShown(listHook);
        const boxes = list.locator('input[type="checkbox"]');
        for (let index = 0; index < await boxes.count(); index += 1) {
          const box = boxes.nth(index);
          if (await box.isVisible() && await box.isEnabled()) await box.check();
        }
      }
      await (await freshShown('builder-next')).click();
      await (await freshShown('customer-name')).fill('Master QA');
      await (await freshShown('job-ref')).fill('MASTER-01');
      await (await freshShown('issued-by')).fill('Master operator');
      await (await freshShown('generate')).click();
      await expect(await freshShown('generate-status')).toContainText('revision 1');
      const issuedMaster = await (async () => {
        const downloadPromise = fresh.waitForEvent('download');
        await (await freshShown('download-baseline')).click();
        const download = await downloadPromise;
        const outputPath = join(directory, 'master-issued.logo-project');
        await download.saveAs(outputPath);
        return new Uint8Array(await readFile(outputPath));
      })();
      const issued = await parseProjectPackage(issuedMaster, { sha256 });
      const issuedMappings = issued.assets.find((asset) => asset.path === 'presentation/photo-mappings.json');
      assert.ok(issuedMappings, 'issued package carries the mapping without re-entry');
      assert.equal(JSON.parse(new TextDecoder().decode(issuedMappings.bytes)).mappings.length, 1);
      await fresh.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    await context.close();
  }
});

test('mapped proof print layout stays compact on two sides', async ({ browser }) => {
  // Focused print-layout check: a two-side mapped return renders bounded
  // side-by-side proof figures with no horizontal spill, on screen and in
  // print media (Playwright print emulation). No giant single-image pages.
  const { context, page } = await openBuilder(browser);
  try {
    const base = await trustedBase();
    const png = await syntheticPng(page, '#1d6f3a');
    const project = structuredClone(base.project);
    project.logos.push({
      schemaVersion: project.schemaVersion,
      id: 'SYN-PRINT-ART',
      name: 'Print art',
      assets: [{ uri: 'logos/print-art.png', role: 'original', mediaType: 'image/png', widthPx: 20, heightPx: 10 }],
    });
    const tee = project.configurations.find((item) => item.id === 'SYN-CFG-TEE-M')!;
    tee.placements[0]!.logoId = 'SYN-PRINT-ART';
    tee.placements[0]!.rotationDeg = 10;
    tee.placements[1]!.logoId = 'SYN-PRINT-ART';
    const manifest = new TextEncoder().encode(JSON.stringify({
      version: 2,
      views: [
        { productId: tee.productId, variantId: tee.variantId, view: 'front', label: 'Front', image: 'presentation/front.png' },
        { productId: tee.productId, variantId: tee.variantId, view: 'back', label: 'Back', image: 'presentation/back.png' },
      ],
    }));
    const product = project.products.find((item) => item.id === tee.productId)!;
    const bboxOf = (regionId: string): { minX: number; maxX: number; minY: number; maxY: number } => {
      const region = product.regions.find((item) => item.id === regionId)!;
      const xs = region.safeArea.map((point) => point[0]);
      const ys = region.safeArea.map((point) => point[1]);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    };
    const entryFor = (regionId: string, view: string, image: string): Record<string, unknown> => {
      const box = bboxOf(regionId);
      const region = product.regions.find((item) => item.id === regionId)!;
      return {
        productId: tee.productId, variantId: tee.variantId, regionId, view, image,
        transform: {
          a: 1 / (box.maxX - box.minX), b: 0, c: -box.minX / (box.maxX - box.minX),
          d: 0, e: -1 / (box.maxY - box.minY), f: box.maxY / (box.maxY - box.minY),
        },
        calibrationId: region.calibrationRef.calibrationId, calibrationVersion: region.calibrationRef.version,
        status: 'provisional',
      };
    };
    const mappings = new TextEncoder().encode(JSON.stringify({
      version: 1,
      mappings: [
        entryFor('SYN-TEE-CHEST', 'front', 'presentation/front.png'),
        entryFor('SYN-TEE-BACK', 'back', 'presentation/back.png'),
      ],
    }));
    const confirmed = confirmRevision(project, {
      confirmedBy: 'Synthetic customer',
      confirmedAt: '2026-10-13T12:00:00.000Z',
      digestOf: contentDigest(project, sha256Text),
    }, sha256Text);
    assert.ok(confirmed.ok, 'synthetic confirmation must bind');
    // Baseline and return carry identical asset sets (definitions and
    // bytes must match exactly); only placements/confirmation may differ.
    const sharedAdditional = [
      { path: 'presentation/preview.json', bytes: manifest },
      { path: 'presentation/front.png', bytes: png },
      { path: 'presentation/back.png', bytes: png },
      { path: 'presentation/photo-mappings.json', bytes: mappings },
    ];
    const sharedReferenced = [
      ...base.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
      { path: 'logos/print-art.png', bytes: png },
    ];
    const returnBytes = await createProjectPackage({
      project: confirmed.project,
      assets: sharedReferenced,
      additionalAssets: sharedAdditional,
    }, { sha256 });
    const baselineBytes = await createProjectPackage({
      project,
      assets: sharedReferenced,
      additionalAssets: sharedAdditional,
    }, { sha256 });
    await (await shown(page, 'mode-review')).click();
    await (await shown(page, 'baseline-file')).setInputFiles({ name: 'baseline.logo-project', mimeType: 'application/zip', buffer: Buffer.from(baselineBytes) });
    await expect(await shown(page, 'baseline-load-status')).toContainText('Loaded saved baseline');
    await (await shown(page, 'return-file')).setInputFiles({ name: 'proof-print-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returnBytes) });
    await expect(await shown(page, 'review-panel')).toBeVisible();
    await (await shown(page, 'preview-document')).click();
    const figures = page.locator('figure.opsheet-photo');
    await expect(figures).toHaveCount(2);
    // Both sides composite their PNG artwork through the evaluated mappings.
    await expect(page.locator('image.opsheet-artwork-overlay')).toHaveCount(2);
    // Bounded figures on screen: well under one viewport per image.
    for (let index = 0; index < 2; index += 1) {
      const svg = figures.nth(index).locator('svg.opsheet-photo-svg');
      await expect(svg).toBeVisible();
      const box = (await svg.boundingBox())!;
      expect(box.height).toBeGreaterThan(0);
      expect(box.height).toBeLessThanOrEqual(360);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('proof-screen.png'), fullPage: true });
    // Same bounds hold in print media; figures print side by side.
    await page.emulateMedia({ media: 'print' });
    for (let index = 0; index < 2; index += 1) {
      const svg = figures.nth(index).locator('svg.opsheet-photo-svg');
      await expect(svg).toBeVisible();
      const box = (await svg.boundingBox())!;
      expect(box.height).toBeGreaterThan(0);
      expect(box.height).toBeLessThanOrEqual(360);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('figure.opsheet-photo figcaption').first()).toHaveText('Front');
    await expect(page.locator('p.opsheet-trial-note')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('proof-print.png'), fullPage: true });
    await page.emulateMedia({ media: 'screen' });
  } finally {
    await context.close();
  }
});

async function openBrowserForCustomer(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(pathToFileURL(resolve(process.cwd(), 'dist/customer-configurator.html')).href);
  return { context, page };
}

function customerHook(page: Page): (name: string) => import('@playwright/test').Locator {
  return (name: string) => page.locator(`[data-customer-hook="${name}"]`);
}

async function loadCustomer(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  await page.locator('[data-customer-hook="file-input"]').setInputFiles({ name, mimeType: 'application/zip', buffer: Buffer.from(bytes) });
  await expect(page.locator('[data-customer-hook="status"]')).toContainText(`Opened ${name}`);
}
