import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import {
  contentDigest,
  confirmRevision,
  newRevision,
} from '../src/core/index.js';
import type { ProjectDocument, Sha256HexFn } from '../src/core/index.js';
import {
  createProjectPackage,
  PROJECT_PACKAGE_LIMITS,
  parseProjectPackage,
} from '../src/packaging/project-package/index.js';
import type { ProjectPackageAsset, ProjectPackageAssetInput } from '../src/packaging/project-package/index.js';

const sha256Bytes = async (bytes: Uint8Array): Promise<string> => createHash('sha256').update(bytes).digest('hex');
const sha256Text: Sha256HexFn = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const REVIEW_HTML = pathToFileURL(resolve(process.cwd(), 'dist/customer-return-review.html')).href;
const TRUSTED_BASELINE_PATH = resolve(process.cwd(), 'dist/trusted-issued.logo-project');

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

async function unpackCustomerApp(): Promise<{ directory: string; htmlPath: string; projectPath: string; projectBytes: Uint8Array }> {
  const archive = new Uint8Array(await readFile(resolve(process.cwd(), 'dist/synthetic-customer-prototype.zip')));
  const entries = unzipSync(archive);
  assert.deepEqual(Object.keys(entries).sort(), ['customer-configurator.html', 'SYNTHETIC-CUSTOMER.logo-project'].sort());
  const html = entries['customer-configurator.html'];
  const project = entries['SYNTHETIC-CUSTOMER.logo-project'];
  assert.ok(html && project);
  const directory = await mkdtemp(join(tmpdir(), 'LogoTool customer roundtrip with spaces '));
  const htmlPath = join(directory, 'customer-configurator.html');
  const projectPath = join(directory, 'SYNTHETIC-CUSTOMER.logo-project');
  const projectBytes = new Uint8Array(project);
  await Promise.all([writeFile(htmlPath, html), writeFile(projectPath, projectBytes)]);
  return { directory, htmlPath, projectPath, projectBytes };
}

function confirm(project: ProjectDocument, confirmedBy = 'Synthetic customer'): ProjectDocument {
  const digest = contentDigest(project, sha256Text);
  const outcome = confirmRevision(project, {
    confirmedBy,
    confirmedAt: '2026-10-13T12:00:00.000Z',
    digestOf: digest,
  }, sha256Text);
  if (!outcome.ok) throw new Error(`synthetic confirmation failed: ${outcome.errors.map((error) => error.message).join('; ')}`);
  return outcome.project;
}

function makeCustomerReturn(project: ProjectDocument): ProjectDocument {
  const revised = newRevision(project, (draft) => {
    const placement = draft.configurations[0]!.placements[0]!;
    placement.pos.xMm += 1;
    draft.instructions = 'Synthetic customer return instructions.';
  });
  const confirmed = confirm(revised);
  const digest = contentDigest(confirmed, sha256Text);
  confirmed.review = {
    revision: confirmed.revision,
    digest,
    decision: 'approved',
    reviewer: 'forged-customer-reviewer',
    at: '2026-10-13T12:01:00.000Z',
    note: 'Forged customer-supplied internal approval.',
  };
  confirmed.reviewHistory = [{
    revision: confirmed.revision,
    digest,
    decision: 'approved',
    reviewer: 'forged-history-reviewer',
    at: '2026-10-13T12:01:00.000Z',
  }];
  return confirmed;
}

async function readDownload(page: Page, trigger: () => Promise<void>): Promise<{ name: string; bytes: Uint8Array }> {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  const download = await downloadPromise;
  const outputPath = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(outputPath);
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(outputPath)) };
}

function attachProbe(page: Page): {
  consoleErrors: string[];
  pageErrors: string[];
  httpRequests: string[];
} {
  const probe = { consoleErrors: [] as string[], pageErrors: [] as string[], httpRequests: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') probe.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => probe.pageErrors.push(error.message));
  page.on('request', (request) => { if (/^https?:/i.test(request.url())) probe.httpRequests.push(request.url()); });
  return probe;
}

async function attachEnvironment(browser: Browser, viewport: { width: number; height: number }): Promise<void> {
  await test.info().attach('offline-review-environment', {
    body: JSON.stringify({
      os: `${process.platform} ${release()} (${process.arch})`,
      browser: browser.browserType().name(),
      browserVersion: browser.version(),
      viewport,
      offline: true,
      entryPoint: REVIEW_HTML,
    }, null, 2),
    contentType: 'application/json',
  });
}

async function openReviewer(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ offline: true, viewport, acceptDownloads: true });
  const page = await context.newPage();
  const probe = attachProbe(page);
  await page.goto(REVIEW_HTML);
  await expect(page.locator('h1')).toHaveText('LogoTool · Customer Return Review');
  await expect(page.locator('#customer-return-review')).toBeVisible();
  return { context, page, probe };
}

async function setArchive(page: Page, role: 'baseline' | 'return', name: string, bytes: Uint8Array): Promise<void> {
  await page.locator(`[data-review-hook="${role}-file"]`).setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
}

async function rejectOversizedFileBeforeRead(page: Page, limit: number): Promise<boolean> {
  return page.evaluate((maxBytes) => {
    const input = document.querySelector<HTMLInputElement>('[data-review-hook="return-file"]');
    if (!input) throw new Error('Missing return project input.');
    (window as Window & { __oversizedReadCalled?: boolean }).__oversizedReadCalled = false;
    const nativeRead = File.prototype.arrayBuffer;
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      writable: true,
      value: function (this: File): Promise<ArrayBuffer> {
        (window as Window & { __oversizedReadCalled?: boolean }).__oversizedReadCalled = true;
        return Promise.reject(new Error('oversized file should not be read'));
      },
    });
    const oversized = new File(['synthetic'], 'oversized-return.logo-project', { type: 'application/zip' });
    Object.defineProperty(oversized, 'size', { configurable: true, value: maxBytes + 1 });
    const transfer = new DataTransfer();
    transfer.items.add(oversized);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    Object.defineProperty(File.prototype, 'arrayBuffer', { configurable: true, writable: true, value: nativeRead });
    return (window as Window & { __oversizedReadCalled?: boolean }).__oversizedReadCalled ?? true;
  }, limit);
}

function withoutEmbeddedAssetDigests(project: ProjectDocument): ProjectDocument {
  for (const logo of project.logos) {
    for (const asset of logo.assets) delete asset.sha256Hex;
  }
  return project;
}

test('internal review imports a confirmed return, discards forged reviews, and sends a new revision back for confirmation', async ({ browser }) => {
  const viewport = { width: 1280, height: 900 };
  await attachEnvironment(browser, viewport);
  const issued = await readTrustedBaseline();
  expect(issued.project.revision).toBe(1);
  expect(issued.project.confirmation).toBeUndefined();
  expect(issued.project.review).toBeUndefined();
  expect(issued.project.history).toBeUndefined();
  expect(issued.project.reviewHistory).toBeUndefined();
  const returnedProject = makeCustomerReturn(issued.project);
  const returnBytes = await pack(returnedProject, issued.assets);
  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued-baseline.logo-project', issued.bytes);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('Loaded baseline');
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeHidden();
    await setArchive(page, 'return', 'customer-return.logo-project', returnBytes);
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeVisible();
    await expect(page.locator('[data-review-hook="confirmation"]')).toContainText('Current for revision');
    await expect(page.locator('[data-review-hook="geometry"]')).toContainText('Valid:');
    await expect(page.locator('[data-review-hook="internal-review"]')).toContainText('Returned review fields were discarded');
    await expect(page.locator('[data-review-hook="internal-review"]')).not.toContainText('forged-customer-reviewer');
    await expect(page.locator('[data-review-hook="differences"]')).toContainText('ISSUED');
    await expect(page.locator('[data-review-hook="differences"]')).toContainText('RETURNED');
    await expect(page.locator('[data-review-hook="differences"]')).toContainText('PROJECT INSTRUCTIONS');

    await page.locator('[data-review-hook="reviewer"]').fill('Local reviewer');
    await page.locator('[data-review-hook="note"]').fill('Synthetic fit and definition review.');
    await page.locator('[data-review-hook="record-review"]').click();
    await expect(page.locator('[data-review-hook="internal-review"]')).toContainText('approved');
    await expect(page.locator('[data-review-hook="status"]')).toContainText('not a production release');

    const reviewedDownload = await readDownload(page, () => page.locator('[data-review-hook="save-reviewed"]').click());
    expect(reviewedDownload.name).toContain('-reviewed-r');
    const reviewed = await parseProjectPackage(reviewedDownload.bytes, { sha256: sha256Bytes });
    expect(reviewed.project.review?.decision).toBe('approved');
    expect(reviewed.project.review?.reviewer).toBe('Local reviewer');
    expect(reviewed.project.reviewHistory?.some((item) => item.reviewer.includes('forged')) ?? false).toBe(false);

    await page.locator('[data-review-hook="decision"]').selectOption('changesRequested');
    await page.locator('[data-review-hook="note"]').fill('Please move the synthetic mark slightly.');
    await page.locator('[data-review-hook="record-review"]').click();
    await expect(page.locator('[data-review-hook="internal-review"]')).toContainText('changesRequested');

    const currentX = Number(await page.locator('[data-review-hook="x"]').inputValue());
    await page.locator('[data-review-hook="x"]').fill(String(currentX + 2));
    await page.locator('[data-review-hook="instructions"]').fill('Revised synthetic proposal instructions.');
    const proposal = await readDownload(page, () => page.locator('[data-review-hook="save-proposal"]').click());
    expect(proposal.name).toContain('-customer-proposal-r');
    const revised = await parseProjectPackage(proposal.bytes, { sha256: sha256Bytes });
    expect(revised.project.revision).toBe(returnedProject.revision + 1);
    expect(revised.project.confirmation).toBeUndefined();
    expect(revised.project.review).toBeUndefined();
    expect(revised.project.history?.some((item) => item.digest === returnedProject.confirmation?.digest)).toBe(true);
    expect(revised.project.reviewHistory?.map((item) => item.decision)).toEqual(['approved', 'changesRequested']);
    expect(revised.project.configurations[0]!.placements[0]!.pos.xMm).toBe(currentX + 2);
    expect(revised.project.instructions).toBe('Revised synthetic proposal instructions.');
    expect(revised.assets.map((asset) => [asset.path, Array.from(asset.bytes)])).toEqual(
      issued.assets.map((asset) => [asset.path, Array.from(asset.bytes)]),
    );
    await page.screenshot({ path: test.info().outputPath('return-review-desktop.png'), fullPage: true });
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.pageErrors).toEqual([]);
    expect(probe.httpRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test('return review rejects tampering, stale confirmation, and old revisions without replacing the valid imported project', async ({ browser }) => {
  const viewport = { width: 390, height: 844 };
  await attachEnvironment(browser, viewport);
  const trusted = await readTrustedBaseline();
  const issuedProject = structuredClone(trusted.project);
  withoutEmbeddedAssetDigests(issuedProject);
  const issuedBytes = await pack(issuedProject, trusted.assets);
  const validReturn = makeCustomerReturn(issuedProject);
  const validBytes = await pack(validReturn, trusted.assets);
  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued-baseline-no-art-digest.logo-project', issuedBytes);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('Loaded baseline');
    expect(await rejectOversizedFileBeforeRead(page, PROJECT_PACKAGE_LIMITS.maxArchiveBytes)).toBe(false);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('rejected before reading');
    await expect(page.locator('[data-review-hook="baseline-name"]')).toContainText('issued-baseline-no-art-digest.logo-project');
    await expect(page.locator('[data-review-hook="return-name"]')).toContainText('No returned project selected');
    const unconfirmed = newRevision(issuedProject, (draft) => {
      draft.instructions = 'Synthetic draft without customer confirmation.';
    });
    const unconfirmedBytes = await pack(unconfirmed, trusted.assets);
    await setArchive(page, 'return', 'unconfirmed-draft.logo-project', unconfirmedBytes);
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeVisible();
    await expect(page.locator('[data-review-hook="confirmation"]')).toContainText('No customer confirmation');
    await page.locator('[data-review-hook="reviewer"]').fill('Local reviewer');
    await expect(page.locator('[data-review-hook="record-review"]')).toBeDisabled();
    await expect(page.locator('[data-review-hook="return-file"]')).toBeEnabled();
    await setArchive(page, 'return', 'valid-return.logo-project', validBytes);
    await expect(page.locator('[data-review-hook="project-id"]')).toHaveText(issuedProject.projectId);
    await expect(page.locator('[data-review-hook="revisions"]')).toHaveText(`${issuedProject.revision} / ${validReturn.revision}`);
    await expect(page.locator('[data-review-hook="return-file"]')).toBeEnabled();
    const invalidFit = newRevision(validReturn, (draft) => {
      draft.configurations[0]!.placements[0]!.pos.xMm = 1000;
    });
    const invalidFitBytes = await pack(confirm(invalidFit), trusted.assets);
    await setArchive(page, 'return', 'validly-confirmed-invalid-fit.logo-project', invalidFitBytes);
    await expect(page.locator('[data-review-hook="geometry"]')).toContainText('Invalid:');
    await expect(page.locator('[data-review-hook="record-review"]')).toBeDisabled();
    await expect(page.locator('[data-review-hook="save-reviewed"]')).toBeDisabled();
    await page.locator('[data-review-hook="decision"]').selectOption('changesRequested');
    await expect(page.locator('[data-review-hook="record-review"]')).toBeEnabled();
    await page.locator('[data-review-hook="record-review"]').click();
    await expect(page.locator('[data-review-hook="internal-review"]')).toContainText('changesRequested');
    await expect(page.locator('[data-review-hook="save-reviewed"]')).toBeEnabled();
    const requestedDownload = await readDownload(page, () => page.locator('[data-review-hook="save-reviewed"]').click());
    const requestedPackage = await parseProjectPackage(requestedDownload.bytes, { sha256: sha256Bytes });
    expect(requestedPackage.project.review?.decision).toBe('changesRequested');
    await expect(page.locator('[data-review-hook="return-file"]')).toBeEnabled();
    await setArchive(page, 'return', 'valid-return.logo-project', validBytes);
    await expect(page.locator('[data-review-hook="geometry"]')).toContainText('Valid:');
    await expect(page.locator('[data-review-hook="return-file"]')).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('return-review-mobile.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    const definitionTamper = newRevision(validReturn, (draft) => {
      draft.products[0]!.name = 'Tampered synthetic product definition';
    });
    const definitionBytes = await pack(confirm(definitionTamper), trusted.assets);
    await setArchive(page, 'return', 'tampered-definition.logo-project', definitionBytes);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('rejected');
    await expect(page.locator('[data-review-hook="return-file"]')).toBeEnabled();
    await expect(page.locator('[data-review-hook="return-name"]')).toContainText('valid-return.logo-project');
    await expect(page.locator('[data-review-hook="revisions"]')).toHaveText(`${issuedProject.revision} / ${validReturn.revision}`);

    const sourceAsset = trusted.assets.find((asset) => asset.kind === 'referenced');
    assert.ok(sourceAsset);
    const changedBytes = new Uint8Array(sourceAsset.bytes);
    changedBytes[0] = changedBytes[0]! ^ 0xff;
    const assetTamperAssets = trusted.assets.map((asset) => asset.path === sourceAsset.path
      ? { ...asset, bytes: changedBytes }
      : asset);
    const assetTamper = await pack(validReturn, assetTamperAssets);
    await setArchive(page, 'return', 'tampered-original-artwork.logo-project', assetTamper);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('asset comparison differs');
    await expect(page.locator('[data-review-hook="return-file"]')).toBeEnabled();
    await expect(page.locator('[data-review-hook="return-name"]')).toContainText('valid-return.logo-project');
    await expect(page.locator('[data-review-hook="revisions"]')).toHaveText(`${issuedProject.revision} / ${validReturn.revision}`);

    const stale = newRevision(validReturn, (draft) => { draft.instructions = 'Content changed after confirmation.'; });
    assert.ok(validReturn.confirmation);
    stale.confirmation = { ...validReturn.confirmation, revision: stale.revision };
    const staleBytes = await pack(stale, trusted.assets);
    await setArchive(page, 'return', 'stale-confirmation.logo-project', staleBytes);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('stale-confirmation');
    await expect(page.locator('[data-review-hook="return-file"]')).toBeEnabled();
    await expect(page.locator('[data-review-hook="revisions"]')).toHaveText(`${issuedProject.revision} / ${validReturn.revision}`);

    const oldRevision = structuredClone(validReturn);
    oldRevision.revision = issuedProject.revision;
    delete oldRevision.confirmation;
    delete oldRevision.review;
    delete oldRevision.reviewHistory;
    const oldRevisionBytes = await pack(oldRevision, trusted.assets);
    await setArchive(page, 'return', 'old-revision.logo-project', oldRevisionBytes);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('invalid-return-revision');
    await expect(page.locator('[data-review-hook="revisions"]')).toHaveText(`${issuedProject.revision} / ${validReturn.revision}`);

    expect(probe.consoleErrors).toEqual([]);
    expect(probe.pageErrors).toEqual([]);
    expect(probe.httpRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test('issued hybrid project returns through review, revised customer confirmation, and internal reimport', async ({ browser }) => {
  const viewport = { width: 1280, height: 900 };
  await attachEnvironment(browser, viewport);
  const customerApp = await unpackCustomerApp();
  const issued = await readTrustedBaseline();
  assert.deepEqual(customerApp.projectBytes, issued.bytes, 'hybrid issue and reviewer baseline must be the same clean package');
  const { context, page: reviewPage, probe: reviewProbe } = await openReviewer(browser, viewport);
  let customerProbe: ReturnType<typeof attachProbe> | null = null;
  try {
    await setArchive(reviewPage, 'baseline', 'locally-issued-baseline.logo-project', issued.bytes);
    await expect(reviewPage.locator('[data-review-hook="status"]')).toContainText('Loaded baseline');

    const customerPage = await context.newPage();
    customerProbe = attachProbe(customerPage);
    const customerUrl = pathToFileURL(customerApp.htmlPath).href;
    await test.info().attach('customer-editor-roundtrip-environment', {
      contentType: 'application/json',
      body: JSON.stringify({
        os: `${process.platform} ${release()} (${process.arch})`,
        browser: browser.browserType().name(),
        browserVersion: browser.version(),
        viewport,
        offline: true,
        entryPoint: customerUrl,
      }, null, 2),
    });
    await customerPage.goto(customerUrl);
    await expect(customerPage.locator('#customer-editor h1')).toHaveText('LogoTool · Synthetic Customer Editor');
    await customerPage.locator('[data-customer-hook="file-input"]').setInputFiles(customerApp.projectPath);
    await expect(customerPage.locator('[data-customer-hook="status"]')).toContainText('Loaded SYNTHETIC-CUSTOMER.logo-project');
    await expect(customerPage.locator('[data-customer-hook="revision"]')).toHaveText('1');
    await customerPage.locator('[data-customer-hook="x-mm"]').fill('2');
    await customerPage.locator('[data-customer-hook="instructions"]').fill('Initial synthetic customer instructions.');
    await customerPage.locator('[data-customer-hook="update"]').click();
    await expect(customerPage.locator('[data-customer-hook="revision"]')).toHaveText('2');
    await expect(customerPage.locator('[data-customer-hook="review"]')).toContainText('Project instructions: Initial synthetic customer instructions.');
    await customerPage.locator('[data-customer-hook="confirmed-by"]').fill('Synthetic Customer');
    await customerPage.locator('[data-customer-hook="confirm"]').click();
    await expect(customerPage.locator('[data-customer-hook="confirmation"]')).toContainText('Current confirmation');
    const initialReturn = await readDownload(customerPage, () => customerPage.locator('[data-customer-hook="submit"]').click());
    const parsedInitialReturn = await parseProjectPackage(initialReturn.bytes, { sha256: sha256Bytes });
    expect(parsedInitialReturn.project.revision).toBe(2);
    expect(parsedInitialReturn.project.confirmation?.revision).toBe(2);
    expect(parsedInitialReturn.project.instructions).toBe('Initial synthetic customer instructions.');
    expect(parsedInitialReturn.assets.map((asset) => [asset.path, Array.from(asset.bytes)])).toEqual(
      issued.assets.map((asset) => [asset.path, Array.from(asset.bytes)]),
    );

    await setArchive(reviewPage, 'return', initialReturn.name, initialReturn.bytes);
    await expect(reviewPage.locator('[data-review-hook="confirmation"]')).toContainText('Current for revision 2');
    await expect(reviewPage.locator('[data-review-hook="geometry"]')).toContainText('Valid:');
    await reviewPage.locator('[data-review-hook="reviewer"]').fill('Local synthetic reviewer');
    await reviewPage.locator('[data-review-hook="decision"]').selectOption('changesRequested');
    await reviewPage.locator('[data-review-hook="note"]').fill('Move the synthetic mark two millimetres.');
    await reviewPage.locator('[data-review-hook="record-review"]').click();
    await expect(reviewPage.locator('[data-review-hook="internal-review"]')).toContainText('changesRequested');
    const currentX = Number(await reviewPage.locator('[data-review-hook="x"]').inputValue());
    await reviewPage.locator('[data-review-hook="x"]').fill(String(currentX + 2));
    await reviewPage.locator('[data-review-hook="instructions"]').fill('Revised synthetic instructions for customer confirmation.');
    const proposal = await readDownload(reviewPage, () => reviewPage.locator('[data-review-hook="save-proposal"]').click());
    const parsedProposal = await parseProjectPackage(proposal.bytes, { sha256: sha256Bytes });
    expect(parsedProposal.project.revision).toBe(3);
    expect(parsedProposal.project.confirmation).toBeUndefined();
    expect(parsedProposal.project.review).toBeUndefined();
    expect(parsedProposal.project.history?.some((entry) => entry.revision === 2)).toBe(true);
    expect(parsedProposal.project.reviewHistory?.some((entry) => entry.decision === 'changesRequested')).toBe(true);

    await customerPage.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: proposal.name,
      mimeType: 'application/zip',
      buffer: Buffer.from(proposal.bytes),
    });
    await expect(customerPage.locator('[data-customer-hook="revision"]')).toHaveText('3');
    await expect(customerPage.locator('[data-customer-hook="confirmation"]')).toContainText('Previous confirmation');
    await customerPage.locator('[data-customer-hook="confirmed-by"]').fill('Synthetic Customer Again');
    await customerPage.locator('[data-customer-hook="confirm"]').click();
    await expect(customerPage.locator('[data-customer-hook="confirmation"]')).toContainText('Current confirmation');
    const reconfirmed = await readDownload(customerPage, () => customerPage.locator('[data-customer-hook="submit"]').click());
    const parsedReconfirmed = await parseProjectPackage(reconfirmed.bytes, { sha256: sha256Bytes });
    expect(parsedReconfirmed.project.revision).toBe(3);
    expect(parsedReconfirmed.project.confirmation?.revision).toBe(3);
    expect(parsedReconfirmed.project.confirmation?.confirmedBy).toBe('Synthetic Customer Again');
    expect(parsedReconfirmed.project.review).toBeUndefined();
    for (let index = 0; index < issued.assets.length; index += 1) {
      assert.deepEqual(parsedReconfirmed.assets[index]?.bytes, issued.assets[index]?.bytes);
    }

    await setArchive(reviewPage, 'return', reconfirmed.name, reconfirmed.bytes);
    await expect(reviewPage.locator('[data-review-hook="revisions"]')).toHaveText('1 / 3');
    await expect(reviewPage.locator('[data-review-hook="confirmation"]')).toContainText('Current for revision 3');
    await expect(reviewPage.locator('[data-review-hook="geometry"]')).toContainText('Valid:');
    await expect(reviewPage.locator('[data-review-hook="internal-review"]')).toContainText('Returned review fields were discarded');
    await reviewPage.screenshot({ path: test.info().outputPath('full-roundtrip-review-desktop.png'), fullPage: true });
    await customerPage.setViewportSize({ width: 390, height: 844 });
    await customerPage.screenshot({ path: test.info().outputPath('full-roundtrip-customer-mobile.png'), fullPage: true });
    await customerPage.setViewportSize(viewport);
    expect(reviewProbe.consoleErrors).toEqual([]);
    expect(reviewProbe.pageErrors).toEqual([]);
    expect(reviewProbe.httpRequests).toEqual([]);
    expect(customerProbe.consoleErrors).toEqual([]);
    expect(customerProbe.pageErrors).toEqual([]);
    expect(customerProbe.httpRequests).toEqual([]);
  } finally {
    await context.close();
    await rm(customerApp.directory, { recursive: true, force: true });
  }
});
