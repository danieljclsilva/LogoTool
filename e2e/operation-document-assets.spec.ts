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

/** Clone the trusted project and declare raster + non-raster logo assets. */
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

/** v2 sided manifest for one product option plus a raster photo. */
function assetsWithReference(
  base: ProjectPackageAsset[],
  project: ProjectDocument,
  view: { productId: string; variantId: string; side: 'front' | 'back' | 'left' | 'right'; label?: string; image: string },
  imageBytes: Uint8Array,
): ProjectPackageAsset[] {
  const manifest = new TextEncoder().encode(JSON.stringify({
    version: 2,
    views: [{ productId: view.productId, variantId: view.variantId, view: view.side, ...(view.label !== undefined ? { label: view.label } : {}), image: view.image }],
  }));
  return [
    ...base,
    { path: 'presentation/preview.json', kind: 'additional', bytes: manifest },
    { path: view.image, kind: 'additional', bytes: imageBytes },
  ];
}

/** Evaluated photo-mapping binding for the trusted tee chest (CAL-SYN-001 v1). */
function assetsWithMapping(base: ProjectPackageAsset[]): ProjectPackageAsset[] {
  const mappings = new TextEncoder().encode(JSON.stringify({
    version: 1,
    mappings: [{
      productId: 'SYN-TEE-001',
      variantId: 'SYN-TEE-M',
      regionId: 'SYN-TEE-CHEST',
      view: 'front',
      image: 'presentation/product.png',
      transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
      calibrationId: 'CAL-SYN-001',
      calibrationVersion: 'v1',
      status: 'provisional',
    }],
  }));
  return [...base, { path: 'presentation/photo-mappings.json', kind: 'additional', bytes: mappings }];
}

function opdocHost(page: Page) {
  return page.locator('[data-review-hook="operation-document-container"]');
}

test('operation sheet composites a mapped photo proof with applied artwork and no artwork panels', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  const varied = projectWithArtworkVariants(project);
  const withPhoto = assetsWithReference(
    assetsWithArtworkVariants(assets, varied.png, varied.broken, varied.svg),
    varied.project,
    { productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', side: 'front', label: 'Front', image: 'presentation/product.png' },
    tinyPng(),
  );
  const withMapping = assetsWithMapping(withPhoto);
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(varied.project, withMapping));
  await setArchive(page, 'return', 'returned.logo-project', await pack(varied.project, withMapping));
  const host = opdocHost(page);
  await expect(host.locator('.opsheet').first()).toBeVisible();

  // The evaluated mapping composites the renderable PNG onto the photo.
  await expect(host.locator('figure.opsheet-photo figcaption')).toHaveText('Front');
  await expect(host).toContainText('Mapped photos are visual trial overlays, not production approval.');
  await expect(host.locator('p.opsheet-trial-note')).toHaveCount(1);
  const overlays = host.locator('image.opsheet-artwork-overlay');
  expect(await overlays.count()).toBe(1);
  const href = await overlays.first().getAttribute('href');
  expect(href?.startsWith('data:image/png')).toBe(true);
  expect(href?.includes('http')).toBe(false);
  // Logo panels carry business data only — never artwork originals.
  expect(await host.locator('figure.opsheet-artwork-figure').count()).toBe(0);
  expect(await host.locator('img[src*="logos/"]').count()).toBe(0);
  await page.screenshot({ path: info.outputPath('operation-mapped-proof.png') });
  assertCleanProbe(probe);
  await close();
});

test('operation sheet omits unmapped photos from print with an explicit note', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  const varied = projectWithArtworkVariants(project);
  const withPhoto = assetsWithReference(
    assetsWithArtworkVariants(assets, varied.png, varied.broken, varied.svg),
    varied.project,
    { productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', side: 'front', image: 'presentation/product.png' },
    tinyPng(),
  );
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(varied.project, withPhoto));
  await setArchive(page, 'return', 'returned.logo-project', await pack(varied.project, withPhoto));
  const host = opdocHost(page);
  await expect(host.locator('.opsheet').first()).toBeVisible();

  // No evaluated mapping: the supplied photo is omitted from the focused
  // print (kept internally) — never a proof, never a silent drop.
  await expect(host).toContainText('1 supplied photo(s) not shown');
  expect(await host.locator('figure.opsheet-photo').count()).toBe(0);
  expect(await host.locator('img.opsheet-photo-img').count()).toBe(0);
  expect(await host.locator('svg.opsheet-photo-svg').count()).toBe(0);
  expect(await host.locator('image.opsheet-artwork-overlay').count()).toBe(0);
  // The trousers sheet has no photo at all: explicit, not silent.
  await expect(host).toContainText('No product photo supplied for this sheet');
  await page.screenshot({ path: info.outputPath('operation-reference-desktop.png') });
  assertCleanProbe(probe);
  await close();
  void info;
});

test('operation sheet explains missing or undecodable artwork bytes instead of guessing an overlay', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  // Declare the PNG asset but ship truncated bytes (the package validator
  // requires the path; the renderer treats undecodable exactly like missing).
  const varied = structuredClone(project);
  varied.logos[0]!.assets.push({ uri: 'logos/preview.png', role: 'reference', mediaType: 'image/png' });
  const broken = tinyPng().slice(0, 10);
  const withAssets: ProjectPackageAsset[] = [
    ...assets,
    { path: 'logos/preview.png', kind: 'referenced', bytes: broken },
  ];
  const withPhoto = assetsWithReference(
    withAssets,
    varied,
    { productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', side: 'front', image: 'presentation/product.png' },
    tinyPng(),
  );
  const withMapping = assetsWithMapping(withPhoto);
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(varied, withMapping));
  await setArchive(page, 'return', 'returned.logo-project', await pack(varied, withMapping));
  const host = opdocHost(page);
  await expect(host.locator('.opsheet').first()).toBeVisible();

  await expect(host).toContainText('are missing or undecodable; size and dimensions below still apply.');
  expect(await host.locator('image.opsheet-artwork-overlay').count()).toBe(0);
  expect(await host.locator('img[src*="logos/"]').count()).toBe(0);
  assertCleanProbe(probe);
  await close();
  void info;
});

test('operation sheet falls back when a mapped product photo fails native decode', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  // Valid PNG signature + valid 20x10 IHDR, then garbage: header validation
  // passes and the evaluated mapping binds the side, but no browser can
  // decode the payload — the print falls back to an explicit note.
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
  const withPhoto = assetsWithReference(
    assets,
    project,
    { productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', side: 'front', image: 'presentation/product.png' },
    corrupt,
  );
  const withMapping = assetsWithMapping(withPhoto);
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(project, withMapping));
  await setArchive(page, 'return', 'returned.logo-project', await pack(project, withMapping));
  const host = opdocHost(page);
  await expect(host.locator('.opsheet').first()).toBeVisible();

  await expect(host).toContainText('could not decode it');
  await expect(host.locator('img.opsheet-photo-img')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('operation-decode-fallback.png') });
  assertCleanProbe(probe);
  await close();
});

test('operation sheet drops revision and digest while the candidate JSON keeps them', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(project, assets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(project, assets));
  await openProposalEditor(page);
  const host = opdocHost(page);
  await expect(host.locator('.opsheet').first()).toBeVisible();

  await page.locator('[data-review-hook="width"]').fill('31.5');
  const json = JSON.parse(await readCandidateJson(page));
  expect(json.revision).toBeGreaterThan(1);
  // The sheet reflects the new geometry but prints no technical envelope.
  await expect(host).toContainText('31.5 × 40.0 mm');
  await expect(host).not.toContainText(String(json.digest));
  await expect(host).not.toContainText('Revision');
  await page.screenshot({ path: info.outputPath('operation-revision-desktop.png') });
  assertCleanProbe(probe);
  await close();
  void info;
});

test('operation sheet keeps draft status after an internal workflow decision', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 1280, height: 900 });
  const { project, assets } = await readTrustedBaseline();
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(project, assets));
  await setArchive(page, 'return', 'returned.logo-project', await pack(project, assets));
  const host = opdocHost(page);
  await expect(host.locator('.opsheet').first()).toBeVisible();

  await page.locator('[data-review-hook="reviewer"]').fill('Synthetic reviewer');
  await page.locator('[data-review-hook="decision"]').selectOption('changesRequested');
  await page.locator('[data-review-hook="note"]').fill('Please recheck seam clearance.');
  await page.locator('[data-review-hook="record-review"]').click();
  // The decision lives in the review panel (page state), never on the sheet.
  await expect(page.locator('[data-review-hook="internal-review"]')).toContainText('changesRequested');
  await expect(host).not.toContainText('Please recheck seam clearance.');
  await expect(host).not.toContainText('changesRequested');
  await expect(host).not.toContainText('Production approved');
  // Nothing is authored on this page: the honest draft badge persists.
  await expect(host.locator('.opsheet-status').first()).toContainText('setup needed before production');
  await page.screenshot({ path: info.outputPath('operation-status-desktop.png') });
  assertCleanProbe(probe);
  await close();
  void info;
});

test('operation sheet renders without overflow on a narrow mobile viewport', async ({ browser }, info) => {
  const { page, probe, close } = await openReviewer(browser, { width: 390, height: 844 });
  const { project, assets } = await readTrustedBaseline();
  const varied = projectWithArtworkVariants(project);
  const withPhoto = assetsWithReference(
    assetsWithArtworkVariants(assets, varied.png, varied.broken, varied.svg),
    varied.project,
    { productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', side: 'front', image: 'presentation/product.png' },
    tinyPng(),
  );
  await setArchive(page, 'baseline', 'issued.logo-project', await pack(varied.project, withPhoto));
  await setArchive(page, 'return', 'returned.logo-project', await pack(varied.project, withPhoto));
  const host = opdocHost(page);
  await expect(host.locator('.opsheet').first()).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await host.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('operation-mobile.png') });
  assertCleanProbe(probe);
  await close();
  void info;
});
