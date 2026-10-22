import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import { createProjectFromDefinitions } from '../src/core/project-builder/create-project.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import {
  BUILDER_URL,
  STATION_DIR,
  STATION_FILENAME,
  STATION_PATH,
  assertStationPresent,
  gotoStation,
  openOfflineContext,
  revealBuilderControl,
} from './helpers.js';
import { countPdfPages, makePngs, makeReturnBytes, openCheckWithReturn, readMediaBox } from './sheet-fixtures.js';

const sha256bytes: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

// Single-entry acceptance for the Logo Station distribution: the shipped
// dist/station/ folder exposes exactly one staff entry, the fresh-copied
// entry runs the normal prepare→issue flow for BOTH customer formats with
// no dependency on the repository checkout, rejected inputs keep state, and
// no staff action navigates to (or downloads) another staff HTML page.

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

/** Explicit synthetic fixture package (no demo UI in the station). */
async function syntheticCataloguePackage(): Promise<Uint8Array> {
  const { readdir: readDir, readFile: readBytes } = await import('node:fs/promises');
  const productFiles = (await readDir(resolve(process.cwd(), 'examples/products')))
    .filter((file: string) => file.endsWith('.product.json'))
    .sort();
  const products = await Promise.all(productFiles.map(async (file: string) =>
    JSON.parse(await readBytes(resolve(process.cwd(), `examples/products/${file}`), 'utf8'))));
  products.sort((left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const logos = await Promise.all(['syn-mark-a.logo.json', 'syn-mark-b.logo.json'].map(async (file: string) =>
    JSON.parse(await readBytes(resolve(process.cwd(), `examples/logos/${file}`), 'utf8'))));
  logos.sort((left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const assetPaths = [...new Set(logos.flatMap((logo: { assets: Array<{ uri: string }> }) => logo.assets.map((asset) => asset.uri)))].sort();
  const assets = await Promise.all(assetPaths.map(async (uri) => ({
    path: uri,
    bytes: new Uint8Array(await readBytes(resolve(process.cwd(), 'examples', uri as string))),
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

/** Tick every checkbox in a selection list with real change events. */
async function checkAllBoxes(page: Page, listHook: string): Promise<void> {
  await (await shown(page, listHook)).locator('input[type="checkbox"]').evaluateAll((nodes) => {
    for (const node of nodes) {
      const box = node as HTMLInputElement;
      if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  // Several steps expose same-named Continue buttons (only the visible
  // step's control applies); follow the suite convention of filtering them.
  return ['builder-next', 'builder-back'].includes(name)
    ? builder(page, name).filter({ visible: true }).first()
    : builder(page, name);
}

test('station entry is the single obvious staff page with no legacy sidecars', async ({ browser }, info) => {
  await test.info().attach('station-entry-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform, release: release(), arch: process.arch,
      browser: browser.browserType().name(), browserVersion: browser.version(),
      viewport: { width: 1280, height: 900 }, offline: true, entryPoint: BUILDER_URL,
    }, null, 2),
  });
  await assertStationPresent();
  // Exactly one root entry plus an optional assets support folder — no
  // customer examples, reviewers, inspectors or scratch projects alongside.
  const topLevel = (await readdir(STATION_DIR)).sort();
  expect(topLevel[0]).toBe(STATION_FILENAME);
  for (const entry of topLevel.slice(1)) {
    assert.ok(!entry.endsWith('.html'), `no sidecar staff page alongside the station: ${entry}`);
  }
  expect(topLevel.length).toBeLessThanOrEqual(2);

  const { context, page, probe } = await openOfflineContext(browser);
  const navigated: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigated.push(frame.url());
  });
  try {
    await gotoStation(page);
    await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
    await expect(page.locator('header.station-header')).toContainText('Logo Station');
    // No links to legacy staff pages anywhere in the station UI.
    const legacyHrefs = await page.locator('a[href]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href') ?? '').filter((href) => href.endsWith('.html')),
    );
    expect(legacyHrefs).toEqual([]);
    // The advanced reviewer download is a file, never a navigation: the
    // committed URL must stay the station entry throughout the smoke flow.
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    for (const url of navigated) {
      expect(url).toBe(page.url());
      assert.ok(!/asset-inspector|customer-configurator|customer-return-review|project-package-inspector|internal-builder\.html/.test(url), `staff flow must not open another staff page: ${url}`);
    }
    await page.screenshot({ path: info.outputPath('station-entry.png'), fullPage: true });
    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.httpRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test('fresh-copied station issues both customer formats offline with no repo dependency', async ({ browser }, info) => {
  const probe = { pageErrors: [] as string[], consoleErrors: [] as string[], httpRequests: [] as string[] };
  let stationCopy = '';
  let context: BrowserContext | null = null;
  try {
    // Fresh copy with spaces in the path: proves no dependency on the repo
    // checkout or any other dist output.
    stationCopy = await mkdtemp(join(tmpdir(), 'Logo Station copy '));
    await cp(STATION_DIR, stationCopy, { recursive: true });
    const copiedEntry = pathToFileURL(join(stationCopy, STATION_FILENAME)).href;
    await test.info().attach('station-fresh-copy-environment', {
      contentType: 'application/json',
      body: JSON.stringify({
        os: process.platform, release: release(), arch: process.arch,
        browser: browser.browserType().name(), browserVersion: browser.version(),
        viewport: { width: 1280, height: 900 }, offline: true, entryPoint: copiedEntry,
      }, null, 2),
    });
    context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    context.on('request', (request) => {
      if (/^https?:/.test(request.url())) probe.httpRequests.push(request.url());
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') probe.consoleErrors.push(message.text());
    });
    const navigated: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigated.push(frame.url());
    });
    await page.goto(copiedEntry);
    await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();

    // Rejected input keeps state: an invalid project file changes nothing.
    await (await shown(page, 'source-file')).setInputFiles({
      name: 'bad-source.logo-project', mimeType: 'application/zip', buffer: Buffer.from('not a logo project'),
    });
    await expect(await shown(page, 'source-status')).toContainText('Could not load bad-source.logo-project');
    await expect(builder(page, 'source-status')).toContainText('The previous source remains unchanged.');

    // Normal path still works afterwards: an explicit synthetic fixture
    // package (same example definitions the old embedded catalogue
    // carried) → select all → details → issue.
    await openSyntheticCatalogue(page);
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await checkAllBoxes(page, 'configuration-list');
    await (await shown(page, 'builder-next')).click();
    await expect(page.locator('[data-builder-step="details"]')).toBeVisible();
    await (await shown(page, 'customer-name')).fill('Station Smoke');
    await (await shown(page, 'job-ref')).fill('STATION-SMOKE-01');
    await (await shown(page, 'issued-by')).fill('Lead check');

    for (const format of ['self', 'hybrid'] as const) {
      const control = await shown(page, format === 'self' ? 'format-self' : 'format-hybrid');
      await control.check();
      await (await shown(page, 'generate')).click();
      await expect(await shown(page, 'generate-status')).toContainText('revision 1');
      await expect(page.locator('[data-builder-step="send"]')).toBeVisible();
      const officeEvent = page.waitForEvent('download');
      await (await shown(page, 'download-baseline')).click();
      const office = await officeEvent;
      assert.ok(office.suggestedFilename().endsWith('.logo-project'), 'office copy is a project package');
      const deliveryEvent = page.waitForEvent('download');
      await (await shown(page, 'download-package')).click();
      const delivery = await deliveryEvent;
      const deliveryPath = await delivery.path();
      assert.ok(deliveryPath, 'delivery download path is available');
      if (format === 'self') {
        expect(delivery.suggestedFilename()).toBe('OPEN_LOGO_CONFIGURATOR.html');
        // The delivered file opens standalone, offline, outside the repo.
        const outDir = await mkdtemp(join(tmpdir(), 'station self-contained '));
        const outPath = join(outDir, 'OPEN_LOGO_CONFIGURATOR.html');
        await writeFile(outPath, await readFile(deliveryPath));
        const customer = await context.newPage();
        customer.on('pageerror', (error) => probe.pageErrors.push(String(error)));
        customer.on('console', (message) => {
          if (message.type() === 'error') probe.consoleErrors.push(message.text());
        });
        await customer.goto(pathToFileURL(outPath).href);
        await expect(customer.locator('body')).not.toBeEmpty();
        await customer.close();
      } else {
        assert.ok(delivery.suggestedFilename().endsWith('.zip'), 'hybrid delivery is a ZIP');
        const entries = unzipSync(new Uint8Array(await readFile(deliveryPath)));
        const names = Object.keys(entries);
        assert.ok(names.includes('OPEN_LOGO_CONFIGURATOR.html'), 'hybrid ZIP carries the customer HTML');
        assert.ok(names.some((name) => name.endsWith('.logo-project')), 'hybrid ZIP carries the project');
        const outDir = await mkdtemp(join(tmpdir(), 'station hybrid '));
        await writeFile(join(outDir, 'OPEN_LOGO_CONFIGURATOR.html'), Buffer.from(entries['OPEN_LOGO_CONFIGURATOR.html']!));
        const customer = await context.newPage();
        customer.on('pageerror', (error) => probe.pageErrors.push(String(error)));
        customer.on('console', (message) => {
          if (message.type() === 'error') probe.consoleErrors.push(message.text());
        });
        await customer.goto(pathToFileURL(join(outDir, 'OPEN_LOGO_CONFIGURATOR.html')).href);
        await expect(customer.locator('body')).not.toBeEmpty();
        await customer.close();
      }
      await page.screenshot({ path: info.outputPath(`station-fresh-copy-${format}.png`), fullPage: true });
      if (format === 'self') {
        await (await shown(page, 'step-details')).click();
        await (await shown(page, 'project-id-new')).click();
      }
    }
    // No needless reload: the just-issued office copy is retained in-session,
    // so the send rail jumps straight to the return step.
    await (await shown(page, 'send-to-review')).click();
    await expect(page.locator('[data-builder-mode-panel="review"]')).toBeVisible();

    // Same-station return → check → department authoring → branded PDF, all
    // on the fresh copy with no repo dependence (trusted synthetic fixture).
    const pngs = await makePngs(page);
    const { baseline, returned } = await makeReturnBytes(pngs);
    await openCheckWithReturn(page, baseline, returned);

    const openSetup = async (): Promise<void> => {
      await page.evaluate(() => {
        const d = document.querySelector('[data-builder-hook="anchor-disclosure"]');
        if (d instanceof HTMLDetailsElement && !d.open) d.open = true;
      });
    };
    const pickOption = async (hook: string, fragment: string): Promise<void> => {
      const pair = [hook, fragment.toLowerCase()] as [string, string];
      const value = await page.evaluate(([name, frag]: [string, string]) => {
        const sel = document.querySelector<HTMLSelectElement>(`select[data-builder-hook="${name}"]`);
        return Array.from(sel?.options ?? [])
          .find((o) => o.text.toLowerCase().includes(frag) || o.value.toLowerCase().includes(frag))?.value ?? '';
      }, pair);
      assert.ok(value, `setup offers an option matching ${fragment} for ${hook}`);
      await page.locator(`[data-builder-hook="${hook}"]`).selectOption(value);
    };
    await (await shown(page, 'sheet-instructions')).fill(
      'Press the chest emblem at 160°C for 15 seconds with medium pressure, then press the back emblem at 150°C for 12 seconds. Allow the garment to cool flat for one minute and check all four edges visually before packing.',
    );
    await (await shown(page, 'sheet-customer')).fill('Fresh Copy Athletics');
    await (await shown(page, 'sheet-reference')).fill('FRESH-01');
    await openSetup();
    await pickOption('anchor-side', 'front');
    await pickOption('anchor-region', 'Chest');
    const overlayFront = page.locator('[data-builder-hook="anchor-setup"] svg.anchor-setup-overlay');
    await expect(overlayFront).toBeVisible({ timeout: 15000 });
    await overlayFront.scrollIntoViewIfNeeded();
    await overlayFront.click({ position: { x: 160, y: 128 } });
    await expect(page.getByLabel('Measurement 1 anchor for logo 1')).toContainText('Anchor', { timeout: 15000 });
    await pickOption('anchor-side', 'back');
    await pickOption('anchor-region', 'Back');
    const overlayBack = page.locator('[data-builder-hook="anchor-setup"] svg.anchor-setup-overlay');
    await expect(overlayBack).toBeVisible({ timeout: 15000 });
    await overlayBack.scrollIntoViewIfNeeded();
    await overlayBack.click({ position: { x: 160, y: 128 } });
    await expect(page.getByLabel('Measurement 1 anchor for logo 2')).toContainText('Anchor', { timeout: 15000 });
    await page.getByLabel(/Name for anchor at/).fill('Pocket top');
    await page.getByLabel(/Name for anchor at/).press('Tab');
    await page.getByLabel('Business code for logo 1').fill('FRESH-CHEST-01');
    await page.getByLabel('Business code for logo 2').fill('FRESH-BACK-01');
    await page.getByLabel('Measurement 1 anchor for logo 1').selectOption({ label: 'Anchor 1' });
    await page.getByLabel('Add measurement for logo 1').click();
    await page.getByLabel('Measurement 2 anchor for logo 1').selectOption({ label: 'Anchor 1' });
    await page.getByLabel('Measurement 2 edge for logo 1').selectOption('maxY');
    await page.getByLabel('Measurement 2 convention for logo 1').selectOption('dy');
    await page.getByLabel('Measurement 1 anchor for logo 2').selectOption({ label: 'Pocket top' });
    await page.getByLabel('Add measurement for logo 2').click();
    await page.getByLabel('Measurement 2 anchor for logo 2').selectOption({ label: 'Pocket top' });
    await page.getByLabel('Measurement 2 edge for logo 2').selectOption('maxY');
    await page.getByLabel('Measurement 2 convention for logo 2').selectOption('dy');
    await (await shown(page, 'preview-document')).click();
    const operation = await shown(page, 'operation-container');
    await expect(operation.locator('.opsheet').first()).toBeVisible();
    await expect(operation.locator('figure.opsheet-photo')).toHaveCount(2);
    await expect(operation.locator('line.opsheet-arrow')).toHaveCount(4);
    await expect(operation.locator('.opsheet-unfinished')).toHaveCount(0);
    await expect(operation.locator('.opsheet-status')).toHaveCount(0);
    await expect(operation).toContainText('FRESH-CHEST-01');
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
    expect(countPdfPages(new Uint8Array(pdf))).toBe(1);
    const mediaBox = readMediaBox(new Uint8Array(pdf));
    assert.ok(mediaBox, 'PDF carries a MediaBox');
    expect(Math.abs(mediaBox[0] - 841.89)).toBeLessThan(1);
    expect(Math.abs(mediaBox[1] - 595.28)).toBeLessThan(1);
    const operatorEvent = page.waitForEvent('download');
    await (await shown(page, 'operator-download')).click();
    const operatorFile = await operatorEvent;
    const operatorPath = await operatorFile.path();
    assert.ok(operatorPath, 'operator download path is available');
    const operatorView = JSON.parse(await readFile(operatorPath, 'utf8')) as {
      format: string;
      products: Array<{ logos: Array<{ measurements: unknown[] }> }>;
    };
    expect(operatorView.format).toBe('operation-export/1');
    expect(operatorView.products[0]!.logos[0]!.measurements).toHaveLength(2);
    expect(operatorView.products[0]!.logos[1]!.measurements).toHaveLength(2);
    await page.screenshot({ path: info.outputPath('station-fresh-copy-sheet.png'), fullPage: true });

    // In-station revised proposal + decision on the same page, same update.
    await (await shown(page, 'proposal-config')).selectOption('SYN-CFG-TEE-M');
    await (await shown(page, 'proposal-placement')).selectOption('0');
    const stationProposalX = Number(await builder(page, 'proposal-x').inputValue());
    await (await shown(page, 'proposal-x')).fill(String(stationProposalX + 2));
    await (await shown(page, 'proposal-instructions')).fill('Fresh-copy proposal note.');
    await (await shown(page, 'proposal-apply')).click();
    await expect(await shown(page, 'proposal-status')).toContainText('Applied revised proposal as update 3');
    const proposalEvent = page.waitForEvent('download');
    await (await shown(page, 'proposal-download')).click();
    const proposalFile = await proposalEvent;
    assert.ok(/-r3-proposal\.logo-project$/.test(proposalFile.suggestedFilename()), `human proposal filename, saw ${proposalFile.suggestedFilename()}`);
    const proposalPath = await proposalFile.path();
    assert.ok(proposalPath, 'proposal download path is available');
    const proposalProject = (await parseProjectPackage(new Uint8Array(await readFile(proposalPath)), { sha256: sha256bytes })).project;
    expect(proposalProject.revision).toBe(3);
    expect(proposalProject.confirmation).toBeUndefined();
    await (await shown(page, 'review-decision-reviewer')).fill('Fresh-copy lead');
    await (await shown(page, 'review-decision-choice')).selectOption('changesRequested');
    await (await shown(page, 'review-decision-note')).fill('Check the moved mark.');
    await (await shown(page, 'review-decision-record')).click();
    await expect(await shown(page, 'review-decision-status')).toContainText('Recorded changesRequested for update 3');
    await page.screenshot({ path: info.outputPath('station-fresh-copy-proposal.png'), fullPage: true });
    for (const url of navigated) {
      assert.ok(!/asset-inspector|customer-configurator|customer-return-review|project-package-inspector|internal-builder\.html/.test(url), `fresh station flow must not open another staff page: ${url}`);
    }
    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.httpRequests).toEqual([]);
  } finally {
    if (context) await context.close();
    if (stationCopy) await rm(stationCopy, { recursive: true, force: true });
  }
});

test('station stays readable on a narrow viewport', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser, { width: 390, height: 844 });
  try {
    await gotoStation(page);
    await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('station-narrow.png'), fullPage: true });
    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.httpRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
