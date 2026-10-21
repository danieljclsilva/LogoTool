import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildCandidateExport,
  confirmRevision,
  contentDigest,
  importCustomerReturn,
  newRevision,
  serializeExport,
} from '../src/core/index.js';
import type { ProjectDocument, Sha256HexFn } from '../src/core/index.js';
import {
  createProjectPackage,
  parseProjectPackage,
} from '../src/packaging/project-package/index.js';
import type { ProjectPackageAsset, ProjectPackageAssetInput } from '../src/packaging/project-package/index.js';
import { assertCleanProbe, downloadText } from './helpers.js';
import type { Probe } from './helpers.js';

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

function makeCandidateReturn(project: ProjectDocument): ProjectDocument {
  const revised = newRevision(project, (draft) => {
    draft.configurations[0]!.placements[0]!.pos.xMm += 1;
    draft.instructions = 'Synthetic candidate return instructions.';
  });
  return confirm(revised);
}

function makeZeroAndRepeatedReturn(project: ProjectDocument): ProjectDocument {
  const revised = newRevision(project, (draft) => {
    draft.configurations[1]!.placements = [];
    draft.instructions = 'Return with repeated artwork and an explicit zero-placement configuration.';
  });
  return confirm(revised);
}

async function setArchive(page: Page, role: 'baseline' | 'return', name: string, bytes: Uint8Array): Promise<void> {
  await page.locator(`[data-review-hook="${role}-file"]`).setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer: Buffer.from(bytes),
  });
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

function attachProbe(page: Page): Probe {
  const probe: Probe = { consoleErrors: [], pageErrors: [], httpRequests: [] };
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
      project: test.info().project.name,
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
  await expect(page.locator('h1')).toHaveText('Review a customer return');
  await expect(page.locator('#customer-return-review')).toBeVisible();
  return { context, page, probe };
}
async function readCandidateJson(page: Page): Promise<string> {
  await openTechnicalDetails(page);
  return downloadText(page, () => page.locator('[data-review-hook="candidate-download"]').click());
}

function candidateSummaryLocator(page: Page) {
  return page.locator('[data-review-hook="candidate-summary"]');
}

function candidateStatusLocator(page: Page) {
  return page.locator('[data-review-hook="candidate-status"]');
}

test('preview matches core export after import (desktop 1280×900)', async ({ browser }) => {
  const viewport = { width: 1280, height: 900 };
  await attachEnvironment(browser, viewport);
  const baseline = await readTrustedBaseline();
  const returnProject = makeCandidateReturn(baseline.project);
  const returnBytes = await pack(returnProject, baseline.assets);

  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued-baseline.logo-project', baseline.bytes);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('Opened the saved copy');
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeHidden();

    await setArchive(page, 'return', 'customer-return.logo-project', returnBytes);
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeVisible();
    await openTechnicalDetails(page);

    await expect(candidateStatusLocator(page)).toContainText('candidate-pending-review');
    await expect(candidateStatusLocator(page)).toContainText('0.1.0-provisional');

    const imported = importCustomerReturn(returnProject, baseline.project, sha256Text);
    if (!imported.ok) throw new Error(imported.errors.map((e) => e.message).join('; '));
    const expected = buildCandidateExport(imported.project, sha256Text);
    const expectedText = serializeExport(expected);

    await expect(candidateSummaryLocator(page)).toContainText(expected.projectId);
    await expect(candidateSummaryLocator(page)).toContainText(String(expected.revision));
    await expect(candidateSummaryLocator(page)).toContainText(expected.digest);
    await expect(candidateSummaryLocator(page)).toContainText(expected.instructions ?? '');

    const firstConfig = expected.configurations[0]!;
    const firstPlacement = firstConfig.placements[0]!;
    const configs = page.locator('[data-review-hook="candidate-configurations"]');
    await expect(configs).toContainText(firstConfig.productId);
    await expect(configs).toContainText(firstConfig.variantId);
    await expect(configs).toContainText(firstPlacement.logoId);
    await expect(configs).toContainText(firstPlacement.regionId);
    await expect(configs).toContainText(firstPlacement.method);
    await expect(configs).toContainText(firstPlacement.frame.frameId);
    await expect(configs).toContainText(firstPlacement.frame.originDescription);
    await expect(configs).toContainText(firstPlacement.frame.axes.xPositive);
    await expect(configs).toContainText(firstPlacement.frame.axes.yPositive);
    await expect(configs).toContainText(firstPlacement.calibration.calibrationId);
    await expect(configs).toContainText(firstPlacement.calibration.version);
    await expect(configs).toContainText(firstPlacement.artwork.assets[0]!.uri);
    await expect(configs).toContainText(firstPlacement.artwork.assets[0]!.mediaType);
    for (const configuration of expected.configurations) {
      for (const placement of configuration.placements) {
        for (const value of [placement.pos.xMm, placement.pos.yMm, placement.widthMm, placement.heightMm]) {
          await expect(configs).toContainText(`${value} mm`);
        }
        await expect(configs).toContainText(`${placement.rotationDeg}°`);
        await expect(configs).toContainText(placement.frame.referencePoint);
        await expect(configs).toContainText(placement.frame.rotationConvention);
        if (placement.instructions) await expect(configs).toContainText(placement.instructions);
        for (const asset of placement.artwork.assets) {
          await expect(configs).toContainText(asset.role);
          if (asset.sha256Hex) await expect(configs).toContainText(asset.sha256Hex);
        }
      }
    }
    await candidateSummaryLocator(page).scrollIntoViewIfNeeded();
    await test.info().attach('candidate-desktop', { body: await page.screenshot(), contentType: 'image/png' });
    await configs.locator('h4').first().scrollIntoViewIfNeeded();
    await test.info().attach('candidate-desktop-measurements', { body: await page.screenshot(), contentType: 'image/png' });

    const downloadedText = await readCandidateJson(page);
    expect(downloadedText).toBe(expectedText);

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('zero placements and repeated artwork (desktop 1280×900)', async ({ browser }) => {
  const viewport = { width: 1280, height: 900 };
  await attachEnvironment(browser, viewport);
  const baseline = await readTrustedBaseline();
  const returnProject = makeZeroAndRepeatedReturn(baseline.project);
  const returnBytes = await pack(returnProject, baseline.assets);

  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued-baseline.logo-project', baseline.bytes);
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeHidden();
    await setArchive(page, 'return', 'zero-repeated-return.logo-project', returnBytes);
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeVisible();
    await openTechnicalDetails(page);

    const imported = importCustomerReturn(returnProject, baseline.project, sha256Text);
    if (!imported.ok) throw new Error(imported.errors.map((e) => e.message).join('; '));
    const expected = buildCandidateExport(imported.project, sha256Text);
    const expectedText = serializeExport(expected);

    const configs = page.locator('[data-review-hook="candidate-configurations"]');
    const repeatedConfig = expected.configurations[0]!;
    expect(repeatedConfig.placements.length).toBeGreaterThanOrEqual(2);
    expect(repeatedConfig.placements.every((placement) => placement.logoId === repeatedConfig.placements[0]!.logoId)).toBe(true);

    await expect(configs).toContainText(repeatedConfig.placements[0]!.logoId);
    await expect(configs).toContainText('1. Placement');
    await expect(configs).toContainText('2. Placement');

    const zeroConfig = expected.configurations[1]!;
    expect(zeroConfig.placements).toHaveLength(0);
    await expect(configs).toContainText(zeroConfig.id);
    await expect(configs).toContainText('0 placements');

    const downloadedText = await readCandidateJson(page);
    expect(downloadedText).toBe(expectedText);

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('pending status survives internal approval (desktop 1280×900)', async ({ browser }) => {
  const viewport = { width: 1280, height: 900 };
  await attachEnvironment(browser, viewport);
  const baseline = await readTrustedBaseline();
  const returnProject = makeCandidateReturn(baseline.project);
  const returnBytes = await pack(returnProject, baseline.assets);

  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued-baseline.logo-project', baseline.bytes);
    await setArchive(page, 'return', 'customer-return.logo-project', returnBytes);
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeVisible();

    await page.locator('[data-review-hook="reviewer"]').fill('Local reviewer');
    await page.locator('[data-review-hook="note"]').fill('Synthetic internal approval.');
    await page.locator('[data-review-hook="record-review"]').click();

    await expect(page.locator('[data-review-hook="internal-review"]')).toContainText('approved');
    await openTechnicalDetails(page);
    await expect(candidateStatusLocator(page)).toContainText('candidate-pending-review');

    const downloadedText = await readCandidateJson(page);
    const downloaded = JSON.parse(downloadedText) as { status: string };
    expect(downloaded.status).toBe('candidate-pending-review');

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('failed load preserves last valid candidate and atomic download (mobile 390×844)', async ({ browser }) => {
  const viewport = { width: 390, height: 844 };
  await attachEnvironment(browser, viewport);
  const baseline = await readTrustedBaseline();
  const validReturn = makeCandidateReturn(baseline.project);
  const validBytes = await pack(validReturn, baseline.assets);

  const tamperedReturn = structuredClone(validReturn);
  tamperedReturn.products[0]!.name = 'Tampered synthetic product definition';
  const tamperedBytes = await pack(confirm(tamperedReturn), baseline.assets);

  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued-baseline.logo-project', baseline.bytes);
    await setArchive(page, 'return', 'valid-return.logo-project', validBytes);
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeVisible();
    await openTechnicalDetails(page);
    const imported = importCustomerReturn(validReturn, baseline.project, sha256Text);
    if (!imported.ok) throw new Error(imported.errors.map((e) => e.message).join('; '));
    const expected = buildCandidateExport(imported.project, sha256Text);
    const expectedText = serializeExport(expected);

    const beforeText = await readCandidateJson(page);
    expect(beforeText).toBe(expectedText);

    await setArchive(page, 'return', 'tampered-definition.logo-project', tamperedBytes);
    await expect(page.locator('[data-review-hook="status"]')).toContainText(/rejected|asset comparison differs/);

    await expect(candidateStatusLocator(page)).toContainText('candidate-pending-review');
    await expect(candidateSummaryLocator(page)).toContainText(expected.projectId);
    await expect(candidateSummaryLocator(page)).toContainText(String(expected.revision));
    await expect(candidateSummaryLocator(page)).toContainText(expected.digest);
    await expect(page.locator('[data-review-hook="candidate-download"]')).toBeEnabled();

    const afterText = await readCandidateJson(page);
    expect(afterText).toBe(expectedText);

    await candidateSummaryLocator(page).scrollIntoViewIfNeeded();
    await test.info().attach('candidate-mobile', { body: await page.screenshot(), contentType: 'image/png' });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewport.width);

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('preview clears when no valid pair (desktop 1280×900)', async ({ browser }) => {
  const viewport = { width: 1280, height: 900 };
  await attachEnvironment(browser, viewport);
  const baseline = await readTrustedBaseline();
  const returnProject = makeCandidateReturn(baseline.project);
  const returnBytes = await pack(returnProject, baseline.assets);

  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued-baseline.logo-project', baseline.bytes);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('Opened the saved copy');
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeHidden();
    await setArchive(page, 'return', 'customer-return.logo-project', returnBytes);
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeVisible();
    await openTechnicalDetails(page);
    await expect(candidateStatusLocator(page)).toContainText('candidate-pending-review');

    // Reset the reviewer so no valid pair exists, then load only a return file.
    await page.goto(REVIEW_HTML);
    await expect(page.locator('h1')).toHaveText('Review a customer return');
    await setArchive(page, 'return', 'customer-return.logo-project', returnBytes);
    await expect(page.locator('[data-review-hook="status"]')).toContainText('Opened the returned file');
    await expect(page.locator('[data-review-hook="review-panel"]')).toBeHidden();
    await expect(candidateStatusLocator(page)).toBeEmpty();

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('revised proposal refreshes exact preview and export, safely displaying instruction text', async ({ browser }) => {
  const viewport = { width: 1280, height: 900 };
  await attachEnvironment(browser, viewport);
  const baseline = await readTrustedBaseline();
  const returned = makeCandidateReturn(baseline.project);
  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued.logo-project', baseline.bytes);
    await setArchive(page, 'return', 'return.logo-project', await pack(returned, baseline.assets));
    await openTechnicalDetails(page);
    await openProposalEditor(page);
    await expect(page.locator('[data-review-hook="candidate-download"]')).toBeEnabled();
    const instructions = '<img src="https://example.invalid/never-fetch" onerror="throw 1">\nKeep both lines.';
    await page.locator('[data-review-hook="x"]').fill('21.125');
    await page.locator('[data-review-hook="x"]').press('Tab');
    await page.locator('[data-review-hook="instructions"]').fill(instructions);
    await page.locator('[data-review-hook="instructions"]').press('Tab');
    // Proposal edits auto-apply per changed field (x, then instructions), so
    // the two edits land as two successive revisions before the download.
    await expect(page.locator('[data-review-hook="status"]')).toContainText('Applied revised proposal as revision');
    const proposalDownload = page.waitForEvent('download');
    await page.locator('[data-review-hook="save-proposal"]').click();
    const proposal = await proposalDownload;
    const proposalPath = await proposal.path();
    if (!proposalPath) throw new Error('Missing proposal download');
    const parsedProposal = await parseProjectPackage(new Uint8Array(await readFile(proposalPath)), { sha256: sha256Bytes });
    const imported = importCustomerReturn(returned, baseline.project, sha256Text);
    if (!imported.ok) throw new Error('Unexpected rejected synthetic return');
    const once = newRevision(imported.project, (draft) => {
      draft.configurations[0]!.placements[0]!.pos.xMm = 21.125;
    });
    const revised = newRevision(once, (draft) => {
      draft.instructions = instructions;
    });
    expect(parsedProposal.project).toEqual(revised);
    await expect(page.locator('[data-review-hook="confirmation"]')).toContainText('No customer confirmation');
    await expect(candidateSummaryLocator(page)).toContainText(instructions);
    await expect(page.locator('[data-review-hook="candidate-configurations"]')).toContainText('21.125 mm');
    expect(await readCandidateJson(page)).toBe(serializeExport(buildCandidateExport(revised, sha256Text)));
    expect(await page.locator('[data-review-hook="candidate-summary"] img').count()).toBe(0);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('obsolete candidate hashing is discarded without overwriting replacement status or locks', async ({ browser }) => {
  const viewport = { width: 1280, height: 900 };
  await attachEnvironment(browser, viewport);
  const baseline = await readTrustedBaseline();
  const returned = makeCandidateReturn(baseline.project);
  const replacement = makeZeroAndRepeatedReturn(baseline.project);
  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued.logo-project', baseline.bytes);
    await setArchive(page, 'return', 'return.logo-project', await pack(returned, baseline.assets));
    await openTechnicalDetails(page);
    await expect(page.locator('[data-review-hook="candidate-download"]')).toBeEnabled();
    await page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let holdNext = true;
      crypto.subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>) => {
        const result = await original(...args);
        if (holdNext) {
          holdNext = false;
          document.body.dataset.candidateDigest = 'held';
          await new Promise<void>((resolve) => document.addEventListener('release-candidate-digest', () => resolve(), { once: true }));
          document.body.dataset.candidateDigest = 'released';
        }
        return result;
      };
    });
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    await page.locator('[data-review-hook="candidate-download"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-candidate-digest', 'held');
    await expect(page.locator('[data-review-hook="candidate-download"]')).toBeDisabled();
    // Deliver a replacement change during the disabled interval to exercise
    // the generation guard, rather than depending on human file-picker timing.
    await page.evaluate((bytes) => {
      const input = document.querySelector<HTMLInputElement>('[data-review-hook="return-file"]')!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'replacement.logo-project'));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, Array.from(await pack(replacement, baseline.assets)));
    await expect(page.locator('[data-review-hook="return-name"]')).toContainText('replacement.logo-project');
    await expect(page.locator('[data-review-hook="candidate-download"]')).toBeEnabled();
    const statusBefore = await page.locator('[data-review-hook="status"]').textContent();
    await page.evaluate(() => document.dispatchEvent(new Event('release-candidate-digest')));
    await expect(page.locator('body')).toHaveAttribute('data-candidate-digest', 'released');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(downloads).toBe(0);
    expect(await page.locator('[data-review-hook="status"]').textContent()).toBe(statusBefore);
    expect(await readCandidateJson(page)).toBe(serializeExport(buildCandidateExport(replacement, sha256Text)));
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('candidate hash failure unlocks controls and allows an unchanged retry', async ({ browser }) => {
  const viewport = { width: 390, height: 844 };
  await attachEnvironment(browser, viewport);
  const baseline = await readTrustedBaseline();
  const returned = makeCandidateReturn(baseline.project);
  const { context, page, probe } = await openReviewer(browser, viewport);
  try {
    await setArchive(page, 'baseline', 'issued.logo-project', baseline.bytes);
    await setArchive(page, 'return', 'return.logo-project', await pack(returned, baseline.assets));
    await openTechnicalDetails(page);
    await expect(page.locator('[data-review-hook="candidate-download"]')).toBeEnabled();
    await page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>) => {
        crypto.subtle.digest = original;
        throw new Error('Synthetic digest failure');
      };
    });
    await page.locator('[data-review-hook="candidate-download"]').click();
    await expect(page.locator('[data-review-hook="status"]')).toContainText('Export data download failed: Synthetic digest failure');
    await expect(page.locator('[data-review-hook="candidate-download"]')).toBeEnabled();
    expect(await readCandidateJson(page)).toBe(serializeExport(buildCandidateExport(returned, sha256Text)));
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
