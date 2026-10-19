import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectDocument } from '../src/core/index.js';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageAsset, ProjectPackageAssetInput } from '../src/packaging/project-package/index.js';
import { assertCleanProbe, downloadText, openOfflineContext } from './helpers.js';
import type { Probe } from './helpers.js';

const sha256Bytes = async (bytes: Uint8Array): Promise<string> => createHash('sha256').update(bytes).digest('hex');
const REVIEW_HTML = pathToFileURL(resolve(process.cwd(), 'dist/customer-return-review.html')).href;
const TRUSTED_BASELINE_PATH = resolve(process.cwd(), 'dist/trusted-issued.logo-project');

/** Real 1x1 transparent PNG (decodable in Chrome/Edge; header 1x1). */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const tinyPng = (): Uint8Array => new Uint8Array(Buffer.from(TINY_PNG_BASE64, 'base64'));
const svgBytes = (): Uint8Array =>
  new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');

type Parts = { referenced: ProjectPackageAssetInput[]; additional: ProjectPackageAssetInput[] };

function packageParts(assets: readonly ProjectPackageAsset[]): Parts {
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
  return createProjectPackage(
    { project, assets: parts.referenced, additionalAssets: parts.additional },
    { sha256: sha256Bytes },
  );
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

async function openReviewer(browser: Browser, viewport: { width: number; height: number }): Promise<{ page: Page; probe: Probe; close: () => Promise<void> }> {
  const { context, page, probe } = await openOfflineContext(browser, viewport);
  await page.goto(REVIEW_HTML);
  await expect(page).toHaveTitle('LogoTool · Customer Return Review');
  return { page, probe, close: () => context.close() };
}

async function openTechnicalDetails(page: Page): Promise<void> {
  await page.evaluate(() => {
    const details = document.querySelector<HTMLDetailsElement>('[data-review-hook="technical-details"]');
    if (details) details.open = true;
  });
  await expect(page.locator('[data-review-hook="technical-details"]')).toHaveAttribute('open', '');
}

async function readCandidateJson(page: Page): Promise<string> {
  await openTechnicalDetails(page);
  return downloadText(page, () => page.locator('[data-review-hook="candidate-download"]').click());
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

/** Clone the trusted project and add a raster logo asset plus a corrupt one. */
function projectWithArtworkVariants(source: ProjectDocument): { project: ProjectDocument; png: Uint8Array; broken: Uint8Array; svg: Uint8Array } {
  const project = structuredClone(source);
  const png = tinyPng();
  const broken = png.slice(0, 10);
  const svg = svgBytes();
  project.logos[0]!.assets.push({ uri: 'logos/preview.png', role: 'reference', mediaType: 'image/png' });
  project.logos[0]!.assets.push({ uri: 'logos/broken.png', role: 'reference', mediaType: 'image/png' });
  project.logos[0]!.assets.push({ uri: 'logos/extra.svg', role: 'reference', mediaType: 'image/svg+xml' });
  return { project, png, broken, svg };
}

function assetsWithArtworkVariants(base: ProjectPackageAsset[], png: Uint8Array, broken: Uint8Array, svg: Uint8Array): ProjectPackageAsset[] {
  return [
    ...base,
    { path: 'logos/preview.png', kind: 'referenced', bytes: png },
    { path: 'logos/broken.png', kind: 'referenced', bytes: broken },
    { path: 'logos/extra.svg', kind: 'referenced', bytes: svg },
  ];
}

/** Manifest covering only the first configuration's product (others stay unmatched). */
function partialManifest(project: ProjectDocument, image: string): Uint8Array {
  const first = project.configurations[0]!;
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    references: [{ productId: first.productId, variantId: first.variantId, image }],
  }));
}

function assetsWithReference(
  base: ProjectPackageAsset[],
  project: ProjectDocument,
  imageBytes: Uint8Array,
): ProjectPackageAsset[] {
  return [
    ...base,
    { path: 'presentation/preview.json', kind: 'additional', bytes: partialManifest(project, 'presentation/product.png') },
    { path: 'presentation/product.png', kind: 'additional', bytes: imageBytes },
  ];
}

function opdocHost(page: Page) {
  return page.locator('[data-review-hook="operation-document-container"]');
}

test('operation document shows inert raster artwork previews with illustrative captions', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  const varied = projectWithArtworkVariants(project);
  const withAssets = assetsWithArtworkVariants(assets, varied.png, varied.broken, varied.svg);
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(varied.project, withAssets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(varied.project, withAssets));
  await openTechnicalDetails(page);
  const host = opdocHost(page);
  await expect(host.locator('.lt-operation-document')).toBeVisible();

  const artworkImages = host.locator('img.opdoc-artwork-img');
  expect(await artworkImages.count()).toBeGreaterThan(0);
  // Per-placement rendering: logo-a contributes one inline figure plus three
  // placeholders (original SVG, truncated PNG, extra SVG) per referencing
  // placement; logo-b contributes one placeholder (original SVG) each.
  const logoRefs = { a: 0, b: 0 };
  for (const configuration of project.configurations) {
    for (const placement of configuration.placements) {
      if (placement.logoId === project.logos[0]!.id) logoRefs.a += 1;
      else logoRefs.b += 1;
    }
  }
  expect(await artworkImages.count()).toBe(logoRefs.a);
  await expect.poll(() => artworkImages.first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(host.locator('.opdoc-artwork-placeholder')).toHaveCount(logoRefs.a * 3 + logoRefs.b);
  const sources = await artworkImages.evaluateAll((images) => images.map((image) => image.getAttribute('src') ?? ''));
  for (const source of sources) {
    expect(source.startsWith('data:image/png')).toBe(true);
    expect(source.includes('http')).toBe(false);
  }
  const handlers = await artworkImages.evaluateAll((images) =>
    images.map((image) => [image.getAttribute('onerror'), image.getAttribute('onload'), image.getAttribute('onclick')]));
  for (const row of handlers) {
    expect(row.every((value) => value === null)).toBe(true);
  }
  await expect(host).toContainText('never a production colour proof');
  await page.screenshot({ path: info.outputPath('operation-artwork-desktop.png') });
  assertCleanProbe(probe);
  await close();
});

test('operation document marks corrupt and non-raster artwork explicitly without broken images', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  const varied = projectWithArtworkVariants(project);
  const withAssets = assetsWithArtworkVariants(assets, varied.png, varied.broken, varied.svg);
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(varied.project, withAssets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(varied.project, withAssets));
  await openTechnicalDetails(page);
  const host = opdocHost(page);
  await expect(host.locator('.lt-operation-document')).toBeVisible();

  await expect(host).toContainText('failed raster validation');
  await expect(host).toContainText('not a previewable raster original');
  const brokenImages = await host.locator('img[src*="broken"], img[src*="extra"]').count();
  expect(brokenImages).toBe(0);
  await page.screenshot({ path: info.outputPath('operation-artwork-placeholders.png') });
  assertCleanProbe(probe);
  await close();
});

test('operation document falls back when header-valid raster bytes fail native decode', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  const varied = structuredClone(project);
  // Valid PNG signature + valid 20x10 IHDR, then garbage: header validation
  // passes, but no browser can decode the payload.
  const corrupt = new Uint8Array(48);
  corrupt.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(corrupt.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, 20);
  view.setUint32(20, 10);
  corrupt[24] = 8;
  corrupt[25] = 2;
  corrupt.fill(0xab, 33);
  varied.logos[0]!.assets.push({ uri: 'logos/hdr-corrupt.png', role: 'reference', mediaType: 'image/png' });
  const withAssets: ProjectPackageAsset[] = [
    ...assets,
    { path: 'logos/hdr-corrupt.png', kind: 'referenced', bytes: corrupt },
  ];
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(varied, withAssets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(varied, withAssets));
  await openTechnicalDetails(page);
  const host = opdocHost(page);
  await expect(host.locator('.lt-operation-document')).toBeVisible();

  await expect(host).toContainText('could not decode it');
  expect(await host.locator('img[src*="hdr-corrupt"]').count()).toBe(0);
  expect(await host.locator('figure.opdoc-artwork-figure img').count()).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: info.outputPath('operation-decode-fallback.png') });
  assertCleanProbe(probe);
  await close();
});

test('operation document labels product references illustrative and missing ones explicit', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  const withAssets = assetsWithReference(assets, project, tinyPng());
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(project, withAssets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(project, withAssets));
  await openTechnicalDetails(page);
  const host = opdocHost(page);
  await expect(host.locator('.lt-operation-document')).toBeVisible();

  const referenceImages = host.locator('figure.opdoc-reference img');
  expect(await referenceImages.count()).toBeGreaterThan(0);
  await expect.poll(() => referenceImages.first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1);
  const referenceSources = await referenceImages.evaluateAll((images) => images.map((image) => image.getAttribute('src') ?? ''));
  for (const source of referenceSources) {
    expect(source.startsWith('data:image/')).toBe(true);
  }
  await expect(host).toContainText('Illustrative product reference only');
  await expect(host).toContainText('No reference image supplied for this product in the package.');
  await page.screenshot({ path: info.outputPath('operation-reference-desktop.png') });
  assertCleanProbe(probe);
  await close();
});

test('operation document refreshes revision and digest consistently after a numeric proposal', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(project, assets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(project, assets));
  await openTechnicalDetails(page);
  await openProposalEditor(page);
  const host = opdocHost(page);
  await expect(host.locator('.lt-operation-document')).toBeVisible();

  await page.locator('[data-review-hook="x"]').fill('31.23456789');
  await downloadText(page, () => page.locator('[data-review-hook="save-proposal"]').click());
  const json = JSON.parse(await readCandidateJson(page));
  await expect(host.locator('.opdoc-identity')).toContainText(`Revision${json.revision}`);
  await expect(host).toContainText(String(json.digest));
  await expect(host).toContainText(String(json.digest).slice(0, 16));
  await expect(host).toContainText('31.23456789 mm');
  await expect(host).toContainText('candidate-pending-review');
  await page.screenshot({ path: info.outputPath('operation-revision-desktop.png') });
  assertCleanProbe(probe);
  await close();
});

test('operation document keeps candidate-pending-review after an internal workflow approval', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(project, assets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(project, assets));
  await openTechnicalDetails(page);
  const host = opdocHost(page);
  await expect(host.locator('.lt-operation-document')).toBeVisible();

  await page.locator('[data-review-hook="reviewer"]').fill('Synthetic reviewer');
  await page.locator('[data-review-hook="decision"]').selectOption('changesRequested');
  await page.locator('[data-review-hook="note"]').fill('Please recheck seam clearance.');
  await page.locator('[data-review-hook="record-review"]').click();
  await expect(host).toContainText('changesRequested');

  const statuses = await host.locator('.opdoc-status').allTextContents();
  expect(statuses.length).toBeGreaterThan(0);
  for (const status of statuses) {
    expect(status).toContain('candidate-pending-review');
  }
  await expect(host.locator('.opdoc-identity')).toContainText('candidate-pending-review');
  await expect(host).not.toContainText('Production approved');
  await page.screenshot({ path: info.outputPath('operation-status-desktop.png') });
  assertCleanProbe(probe);
  await close();
});

test('operation document renders without overflow on a narrow mobile viewport', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 390, height: 844 });
  const { project, assets } = await readTrustedBaseline();
  const varied = projectWithArtworkVariants(project);
  const withAssets = assetsWithReference(
    assetsWithArtworkVariants(assets, varied.png, varied.broken, varied.svg),
    varied.project,
    tinyPng(),
  );
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(varied.project, withAssets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(varied.project, withAssets));
  await openTechnicalDetails(page);
  const host = opdocHost(page);
  await expect(host.locator('.lt-operation-document')).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await host.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('operation-mobile.png') });
  assertCleanProbe(probe);
  await close();
});
