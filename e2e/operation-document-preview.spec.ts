import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { release } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { ProjectDocument } from '../src/core/index.js';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageAsset, ProjectPackageAssetInput } from '../src/packaging/project-package/index.js';
import { assertCleanProbe, downloadText } from './helpers.js';
import type { Probe } from './helpers.js';

const sha256Bytes = async (bytes: Uint8Array): Promise<string> => createHash('sha256').update(bytes).digest('hex');
const REVIEW_HTML = pathToFileURL(resolve(process.cwd(), 'dist/dev/customer-return-review.html')).href;
const TRUSTED_BASELINE_PATH = resolve(process.cwd(), 'dist/dev/trusted-issued.logo-project');

type PackageParts = { referenced: ProjectPackageAssetInput[]; additional: ProjectPackageAssetInput[] };

function packageParts(assets: readonly ProjectPackageAsset[]): PackageParts {
  const referenced: ProjectPackageAssetInput[] = [];
  const additional: ProjectPackageAssetInput[] = [];
  for (const asset of assets) {
    const input = { path: asset.path, bytes: asset.bytes };
    (asset.kind === 'referenced' ? referenced : additional).push(input);
  }
  return { referenced, additional };
}

async function pack(project: ProjectDocument, assets: readonly ProjectPackageAsset[]): Promise<Uint8Array> {
  const parts = packageParts(assets);
  return createProjectPackage({ project, assets: parts.referenced, additionalAssets: parts.additional }, { sha256: sha256Bytes });
}

async function readTrustedBaseline(): Promise<{ bytes: Uint8Array; project: ProjectDocument; assets: ProjectPackageAsset[] }> {
  const bytes = new Uint8Array(await readFile(TRUSTED_BASELINE_PATH));
  const parsed = await parseProjectPackage(bytes, { sha256: sha256Bytes });
  return { bytes, project: parsed.project, assets: parsed.assets };
}

async function setArchive(page: Page, role: 'baseline' | 'return', name: string, bytes: Uint8Array): Promise<void> {
  await page.locator(`[data-review-hook="${role}-file"]`).setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
}

function attachProbe(page: Page): Probe {
  const probe: Probe = { pageErrors: [], consoleErrors: [], httpRequests: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => probe.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      probe.httpRequests.push(url);
    }
  });
  return probe;
}

async function openReviewer(browser: Browser, viewport: { width: number; height: number }): Promise<{ page: Page; probe: Probe }> {
  const context = await browser.newContext({ viewport, offline: true });
  const page = await context.newPage();
  const probe = attachProbe(page);
  await test.info().attach("offline-environment", { contentType: "application/json", body: JSON.stringify({ os: process.platform, release: release(), arch: process.arch, browserVersion: browser.version(), project: test.info().project.name, viewport, offline: true, entryPoint: REVIEW_HTML }) });
  await page.goto(REVIEW_HTML);
  await expect(page).toHaveTitle("LogoTool · Customer Return Review");
  return { page, probe };
}

async function readCandidateJson(page: Page): Promise<string> {
  await openTechnicalDetails(page);
  return downloadText(page, () => page.locator('[data-review-hook="candidate-download"]').click());
}

async function openTechnicalDetails(page: Page): Promise<void> {
  await page.evaluate(() => {
    const details = document.querySelector<HTMLDetailsElement>('[data-review-hook="technical-details"]');
    if (details) details.open = true;
  });
  await expect(page.locator('[data-review-hook="technical-details"]')).toHaveAttribute('open', '');
}

async function openProposalEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const summaries = Array.from(document.querySelectorAll('details > summary'));
    const match = summaries.find((item) => item.textContent?.includes('Suggest a revised layout'));
    const disclosure = match?.closest('details');
    if (disclosure) disclosure.open = true;
  });
  await expect(page.locator('[data-review-hook="save-proposal"]')).toBeEnabled();
}

test('operation sheet shows business identity, mm sizes and unfinished notes without technical ids', async ({ browser }) => {
  const { page, probe } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  await setArchive(page, 'baseline', 'trusted-issued.logo-project', await pack(project, assets));
  await setArchive(page, 'return', 'trusted-return.logo-project', await pack(project, assets));

  const host = page.locator('[data-review-hook="operation-document-container"]');
  await expect(host).not.toHaveAttribute('hidden');
  await expect(host.locator('.opsheet').first()).toBeVisible();
  // One sheet per configured product/variant; business names, never ids.
  await expect(host.locator('.opsheet')).toHaveCount(project.configurations.length);
  await expect(host).toContainText('Synthetic Tee / Size M');
  await expect(host).toContainText('Synthetic Mark A');
  await expect(host).toContainText('80.0 × 40.0 mm');
  await expect(host).toContainText('Synthetic Trousers / Regular');
  await expect(host).toContainText('Synthetic Mark B');
  await expect(host).toContainText('60.0 × 30.0 mm');
  // This read-only page authors nothing: every logo honestly reports setup needed.
  await expect(host).toContainText('Placement measurements not set — setup needed.');
  await expect(host).toContainText('setup needed before production');
  // No technical envelope on the operator sheet: no digest, revision, config,
  // logo, region, frame or calibration ids, no review status, no customer notes.
  const json = JSON.parse(await readCandidateJson(page));
  for (const secret of [json.digest, 'SYN-CFG-TEE-M', 'SYN-CFG-TR-REG', 'SYN-LOGO-A', 'SYN-LOGO-B', 'SYN-TEE-CHEST', 'CAL-SYN-001', 'candidate-pending-review']) {
    await expect(host).not.toContainText(secret);
  }
  await expect(host).not.toContainText('Synthetic fixture instructions');

  assertCleanProbe(probe);
  await page.context().close();
});

test('zero-placement configuration is shown explicitly', async ({ browser }) => {
  const { page, probe } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  await setArchive(page, 'baseline', 'trusted-issued.logo-project', await pack(project, assets));

  const revised = structuredClone(project);
  revised.revision += 1;
  revised.configurations.forEach((configuration) => { configuration.placements = []; });
  await setArchive(page, 'return', 'zero-return.logo-project', await pack(revised, assets));

  const host = page.locator('[data-review-hook="operation-document-container"]');
  await expect(host).toContainText('0 logos');
  await expect(host.locator('.opsheet')).toHaveCount(revised.configurations.length);
  assertCleanProbe(probe);
  await page.context().close();
});

test('print media hides main reviewer UI and shows the operation sheet', async ({ browser }) => {
  const { page, probe } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  await setArchive(page, 'baseline', 'trusted-issued.logo-project', await pack(project, assets));
  await setArchive(page, 'return', 'trusted-return.logo-project', await pack(project, assets));
  await page.locator('[data-review-hook="operation-document-container"]').waitFor({ state: 'visible' });
  await page.emulateMedia({ media: 'print' });

  const mainBox = await page.locator('main').boundingBox();
  expect(mainBox?.width ?? 0).toBe(0);

  const host = page.locator('[data-review-hook="operation-document-container"]');
  await expect(host).toBeVisible();
  await expect(host.locator('.opsheet').first()).toBeVisible();
  const hostBox = await host.boundingBox();
  expect(hostBox && hostBox.width > 0 && hostBox.height > 0).toBe(true);

  await page.emulateMedia({ media: 'screen' });
  assertCleanProbe(probe);
  await page.context().close();
});

test('operation sheet refreshes placement width after a revised proposal and never prints customer notes', async ({ browser }, info) => {
  const { page, probe } = await openReviewer(browser, { width: 390, height: 844 });
  const { project, assets } = await readTrustedBaseline();
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(project, assets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(project, assets));
  await openProposalEditor(page);
  const host = page.locator('[data-review-hook="operation-document-container"]');
  await expect(host).toBeVisible();
  // Untrusted payload: must never execute and never reach the printed sheet
  // (customer notes are source context, not operational instructions here).
  const instructions = '<img src="https://invalid.test/logo" onerror="window.bad=true">\n' + 'Synthetic handling instruction. '.repeat(120);
  await page.locator('[data-review-hook="instructions"]').fill(instructions);
  await page.locator('[data-review-hook="width"]').fill('31.5');
  const json = JSON.parse(await readCandidateJson(page));
  expect(json.revision).toBeGreaterThan(1);
  expect(json.instructions).toContain('Synthetic handling instruction.');
  // The sheet reflects the new geometry but prints no customer notes.
  await expect(host).toContainText('31.5 × 40.0 mm');
  await expect(host).not.toContainText('https://invalid.test/logo');
  await expect(host).not.toContainText('Synthetic handling instruction.');
  // The only images on the sheet are the inlined FlexiTog brand marks.
  await expect(host.locator('img.opsheet-mark')).toHaveCount(2);
  await expect(host.locator('img[src*="logos/"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { bad?: boolean }).bad)).toBe(undefined);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { (window as unknown as { printCalls: number }).printCalls = 0; window.print = () => { (window as unknown as { printCalls: number }).printCalls++; }; });
  await page.locator('[data-review-hook="operation-document-print"]').click();
  expect(await page.evaluate(() => (window as unknown as { printCalls: number }).printCalls)).toBe(1);
  await host.scrollIntoViewIfNeeded();
  await test.info().attach('operation-mobile', { body: await page.screenshot(), contentType: 'image/png' });
  assertCleanProbe(probe);
  await page.context().close();
  void info;
});


test('operation sheet stays free of review state after an internal workflow decision', async ({ browser }) => {
  const { page, probe } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(project, assets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(project, assets));
  const host = page.locator('[data-review-hook="operation-document-container"]');
  await page.locator('[data-review-hook="reviewer"]').fill('Synthetic reviewer');
  await page.locator('[data-review-hook="decision"]').selectOption('changesRequested');
  await page.locator('[data-review-hook="note"]').fill('Please recheck seam clearance.');
  await page.locator('[data-review-hook="record-review"]').click();
  // The decision lives in the review panel (page state), never on the sheet.
  await expect(page.locator('[data-review-hook="internal-review"]')).toContainText('changesRequested');
  await expect(host).not.toContainText('Please recheck seam clearance.');
  await expect(host).not.toContainText('changesRequested');
  await expect(host).not.toContainText('candidate-pending-review');
  await expect(host).not.toContainText('Production approved');
  // The sheet keeps its honest draft badge: nothing is authored on this page.
  await expect(host).toContainText('setup needed before production');
  await page.reload();
  await setArchive(page, 'return', 'returned.logo-project', await pack(project, assets));
  await expect(page.locator('[data-review-hook="status"]')).toContainText('Opened the returned file');
  await expect(host).toBeHidden();
  await expect(host).toBeEmpty();
  await expect(page.locator('[data-review-hook="operation-document-print"]')).toBeDisabled();
  assertCleanProbe(probe);
  await page.context().close();
});
