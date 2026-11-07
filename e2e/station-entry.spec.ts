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
  assertStationPresent,
  gotoStation,
  openOfflineContext,
  revealBuilderControl,
} from './helpers.js';
import { countPdfPages } from './sheet-fixtures.js';

const sha256bytes: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

// Single-entry acceptance for the Logo Station distribution: the shipped
// dist/station/ folder exposes exactly one staff entry, the fresh-copied
// entry runs the normal prepare→issue flow for BOTH customer formats with
// no dependency on the repository checkout, rejected inputs keep state, and
// no staff action navigates to (or downloads) another staff HTML page.
// The operator job shell contract: landing "Prepare an operational document",
// three steps (Prepare job → Set up & place logos → Review document), and the
// "Send for customer approval" branch for both customer file formats.

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
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

function reviewHost(page: Page) {
  return builder(page, 'job-review-host');
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

/** Open the explicit synthetic fixture through the real Open job chooser. */
async function openSyntheticCatalogue(page: Page): Promise<void> {
  const bytes = await syntheticCataloguePackage();
  await builder(page, 'job-open-file').setInputFiles({
    name: 'synthetic-catalogue.logo-project', mimeType: 'application/zip', buffer: Buffer.from(bytes),
  });
  await expect(builder(page, 'source-status')).toContainText('Loaded synthetic-catalogue.logo-project');
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
}

/** Tick every checkbox in a selection list with real change events. */
async function checkAllBoxes(page: Page, listHook: string): Promise<void> {
  await builder(page, listHook).locator('input[type="checkbox"]').evaluateAll((nodes) => {
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
  return builder(page, name);
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
    // The landing is the single obvious entry: no legacy mode panels, an
    // operational-document heading, and the Create/Open job actions.
    await expect(page.locator('[data-job-landing]')).toBeVisible();
    await expect(page.locator('[data-job-landing]')).toContainText('Prepare an operational document');
    await expect(page.locator('[data-job-landing]')).toContainText('Create a job or open a saved job to begin.');
    await expect(builder(page, 'job-landing-create')).toContainText('Create job');
    await expect(builder(page, 'job-landing-open')).toBeVisible();
    await expect(builder(page, 'job-landing-response')).toBeVisible();
    await expect(page.locator('header.station-header')).toContainText('Logo Station');
    await expect(page.locator('[data-job-shell]')).toBeHidden();
    // No links to legacy staff pages anywhere in the station UI.
    const legacyHrefs = await page.locator('a[href]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href') ?? '').filter((href) => href.endsWith('.html')),
    );
    expect(legacyHrefs).toEqual([]);
    // The header job actions stay available; opening the shell keeps the
    // committed station URL (never another staff HTML page).
    await builder(page, 'job-landing-create').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(page.locator('[data-job-step="prepare"]')).toContainText('Prepare the job');
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
    await expect(page.locator('[data-job-landing]')).toBeVisible();

    // Rejected input keeps state: an invalid project file changes nothing.
    // (The header Open job input feeds the same loader as the landing Open.)
    await builder(page, 'job-open-file').setInputFiles({
      name: 'bad-source.logo-project', mimeType: 'application/zip', buffer: Buffer.from('not a logo project'),
    });
    await expect(builder(page, 'source-status')).toContainText('Could not load bad-source.logo-project');
    await expect(builder(page, 'source-status')).toContainText('The previous source remains unchanged.');
    await expect(page.locator('[data-job-landing]')).toBeVisible();

    // Normal path still works afterwards: create a job, open an explicit
    // synthetic fixture package (same example definitions the old embedded
    // catalogue carried), select all, identify, and issue.
    await builder(page, 'job-landing-create').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await openSyntheticCatalogue(page);
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await checkAllBoxes(page, 'configuration-list');
    await (await shown(page, 'customer-name')).fill('Station Smoke');
    await (await shown(page, 'job-ref')).fill('STATION-SMOKE-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await expect(builder(page, 'job-to-placements')).toBeEnabled();
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await (await pshown(page, 'pw-product-select')).selectOption({ index: 0 });
    const optionSelect = placement(page, 'pw-option-select');
    if (await optionSelect.count() > 0) await optionSelect.selectOption({ index: 0 });
    await expect(await pshown(page, 'pw-empty-placements')).toContainText('No logo placements for this option.');
    await (await pshown(page, 'pw-approval')).click();
    await expect(branch(page)).toContainText('Send for customer approval');

    for (const format of ['self', 'hybrid'] as const) {
      const issueId = await createBranchIssue(page);
      expect(issueId.length).toBeGreaterThan(0);
      const officeEvent = page.waitForEvent('download');
      await branch(page).getByRole('button', { name: 'Save office copy' }).click();
      const office = await officeEvent;
      assert.ok(office.suggestedFilename().endsWith('.logo-project'), 'office copy is a project package');
      const officePath = test.info().outputPath(`station-office-${format}.logo-project`);
      await office.saveAs(officePath);
      const issued = (await parseProjectPackage(new Uint8Array(await readFile(officePath)), { sha256: sha256bytes })).project;
      expect(issued.projectId).toBe(issueId);
      expect(issued.revision).toBe(1);
      const deliveryEvent = page.waitForEvent('download');
      await branch(page).getByRole('button', { name: 'Save customer file' }).click();
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
        // Switch to the ZIP format under More options for the second issue:
        // the branch asks for a fresh customer file for the new format.
        // The earlier issue left More options open: only open it when
        // closed, never blind-toggle it shut before using its controls.
        const freshCopyOptions = branch(page).locator('details', { hasText: 'More options' });
        if (!await freshCopyOptions.evaluate((element) => (element as HTMLDetailsElement).open)) {
          await branch(page).locator('summary', { hasText: 'More options' }).click();
        }
        await branch(page).getByRole('radio', { name: 'ZIP file with the setup files inside' }).check();
        await expect(branch(page)).toContainText('Format changed. Create the customer file again.');
      }
    }

    // Step 3 reviews the actual operational document for the issued job:
    // zero-placement options print their explicit no-placement statement.
    await builder(page, 'job-step-3').click();
    await expect(page.locator('[data-job-step="review"]')).toBeVisible();
    await expect(reviewHost(page)).toContainText('Review operational document');
    await expect(reviewHost(page)).toContainText('Customer: Station Smoke');
    await expect(reviewHost(page)).toContainText('Job: STATION-SMOKE-01');
    const preview = reviewHost(page).locator('[data-doc-review-preview]');
    await expect(preview.locator('.opsheet').first()).toBeVisible();
    await expect(preview).toContainText('No logos configured on this sheet');
    await expect(reviewHost(page).getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
    await reviewHost(page).locator('[data-doc-review-instructions]').fill(
      'Press the chest emblem at 160°C for 15 seconds with medium pressure.',
    );
    await reviewHost(page).locator('[data-doc-review-instructions]').press('Tab');
    await expect(preview).toContainText('Press the chest emblem at 160°C');
    // Operator handoff for the exact preview snapshot.
    await reviewHost(page).locator('summary', { hasText: 'More output options' }).click();
    const operatorEvent = page.waitForEvent('download');
    await reviewHost(page).getByRole('button', { name: 'Save operator data' }).click();
    const operatorFile = await operatorEvent;
    const operatorPath = await operatorFile.path();
    assert.ok(operatorPath, 'operator download path is available');
    const operatorView = JSON.parse(await readFile(operatorPath, 'utf8')) as {
      format: string;
      products: Array<{ logos: Array<{ measurements: unknown[] }> }>;
    };
    expect(operatorView.format).toBe('operation-export/1');
    expect(operatorView.products.length).toBeGreaterThan(0);
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
    const sheetCount = await preview.locator('section.opsheet').count();
    assert.ok(sheetCount >= 1, 'expected at least one operation sheet');
    // Exact pagination: one landscape A4 page per sheet, no blank
    // first/trailing pages (the print host zeroes page chrome so the sheet
    // paginates exactly).
    const pdfPages = countPdfPages(new Uint8Array(pdf));
    expect(pdfPages).toBe(sheetCount);
    // Emulated print carries the actual sheet and excludes the UI chrome.
    await page.emulateMedia({ media: 'print' });
    await expect(preview).toContainText('No logos configured on this sheet');
    await expect(preview.locator('section.opsheet').first()).toBeVisible();
    await expect(page.locator('header.station-header')).toBeHidden();
    await expect(page.locator('[data-job-step="prepare"]')).toBeHidden();
    await expect(page.locator('[data-job-step="placements"]')).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
    await page.screenshot({ path: info.outputPath('station-fresh-copy-sheet.png'), fullPage: true });

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
    await expect(page.locator('[data-job-landing]')).toBeVisible();
    await expect(page.locator('[data-job-landing]')).toContainText('Prepare an operational document');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await builder(page, 'job-landing-create').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('station-narrow.png'), fullPage: true });
    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.httpRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
