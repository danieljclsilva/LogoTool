import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { gotoBuilder, revealBuilderControl } from './helpers.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';

// Operator workflow acceptance (lead-owned): the agreed three-step direct
// path (Prepare job → Set logo placements → Review document) without any
// customer file, return, or invented confirmation. Real intake, real setup,
// real placement, real measurement, real technique data; Save job → fresh
// station → Open job restores every field; the optional approval branch
// issues exact current placements and rejects tampered/mismatched returns
// atomically. Synthetic fixtures only; offline file:// throughout.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

const VIEWPORTS = [
  { width: 1280, height: 900, label: 'desktop' },
  { width: 390, height: 844, label: 'mobile' },
];

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

function pw(page: Page, name: string) {
  return page.locator(`[data-placement-hook="${name}"]`);
}

/**
 * Orientation regression for stage artwork: the affine matrix on each
 * rendered placement image must map image UV top-left (0,0) to the
 * top-left footprint vertex, (1,0) to top-right and (0,1) to bottom-left.
 * Footprint polygons list corners as bottom-left, bottom-right,
 * top-right, top-left in the Y-up placement frame, so a vertical mirror
 * (UV origin at bottom-left) fails these checks even when the bbox ratio
 * looks right. Runs against whatever stage mapping is active (calibrated
 * photo overlay or measured mm diagram).
 */
async function expectArtworkOrientation(host: import('@playwright/test').Locator): Promise<void> {
  const verdict = await host.locator('[data-placement-hook="pw-stage-svg"]').evaluate((svg) => {
    const img = svg.querySelector('image[data-placement-hook^="pw-artwork-"]');
    const poly = svg.querySelector('polygon[data-placement-index="0"]');
    if (img === null || poly === null) return 'missing-nodes';
    const m = (img.getAttribute('transform') ?? '').match(/matrix\(([^)]+)\)/);
    const pts = (poly.getAttribute('points') ?? '').trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
    if (!m || pts.length !== 4 || pts.some((point) => point.some((value) => !Number.isFinite(value)))) return 'bad-shape';
    const nums = m[1]!.trim().split(/[\s,]+/).map(Number);
    if (nums.length !== 6 || nums.some((value) => !Number.isFinite(value))) return 'bad-matrix';
    const [a, b, c, d, e, f] = nums as [number, number, number, number, number, number];
    const at = (u: number, v: number): [number, number] => [a * u + c * v + e, b * u + d * v + f];
    const dist = (p: [number, number], q: number[]): number => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!);
    const scale = Math.max(1, Math.hypot(pts[2]![0]! - pts[0]![0]!, pts[2]![1]! - pts[0]![1]!));
    const failures: string[] = [];
    if (dist(at(0, 0), pts[3]!) > scale * 1e-6) failures.push('uv-origin-not-top-left');
    if (dist(at(1, 0), pts[2]!) > scale * 1e-6) failures.push('uv-right-not-top-right');
    if (dist(at(0, 1), pts[0]!) > scale * 1e-6) failures.push('uv-down-not-bottom-left');
    return failures.length === 0 ? 'ok' : `misoriented:${failures.join(',')}`;
  });
  expect(verdict).toBe('ok');
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openStation(browser: Browser, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
  await context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  await gotoBuilder(page);
  await expect(page.locator('[data-job-landing]')).toBeVisible();
  await page.locator('[data-builder-hook="job-landing-create"]').click();
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
  return { context, page, probe };
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.networkRequests).toEqual([]);
}

async function attachEnv(info: import('@playwright/test').TestInfo, browser: Browser, viewport: { width: number; height: number }, scope: string): Promise<void> {
  await info.attach('offline-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform, release: release(), arch: process.arch,
      project: info.project.name, browserVersion: browser.version(),
      viewport, offline: true, entryPoint: 'file://', scope,
    }, null, 2),
  });
}

/** Synthetic PNG bytes rendered in the page (exact original bytes). */
async function syntheticPngBytes(page: Page, fill = '#1d6f3a', w = 400, h = 300): Promise<Uint8Array> {
  const base64 = await page.evaluate(({ color, width, height }: { color: string; width: number; height: number }): string => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d canvas unavailable for synthetic PNG fixture.');
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  }, { color: fill, width: w, height: h });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Stage one Images view through the real intake row (label + file). */
async function stageIntakeImage(page: Page, label: string, fileName: string, bytes: Uint8Array): Promise<void> {
  await shown(page, 'product-view-add');
  const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
  await rows.first().locator('input[type="text"]').fill(label);
  await rows.first().locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(rows.first().locator('.view-row-state')).toContainText('ready');
}

/** Full real setup for one Images product: guided rectangle scale, one
 * named anchor, atomic save. Returns the anchor name. */
async function setupProductWithAnchor(page: Page, anchorName: string): Promise<void> {
  const workspace = builder(page, 'product-workspace');
  await workspace.getByRole('button', { name: 'Set up scale' }).click();
  const guided = builder(page, 'guided-scale');
  await expect(guided).toBeVisible();
  const overlay = guided.locator('.guided-scale-overlay[aria-label*="rectangle corners"]');
  const overlayBox = (await overlay.boundingBox())!;
  const corner = async (fx: number, fy: number) => {
    await overlay.click({ position: { x: Math.round(overlayBox.width * fx), y: Math.round(overlayBox.height * fy) } });
  };
  await corner(0.25, 0.25);
  await corner(0.75, 0.25);
  await corner(0.75, 0.75);
  await corner(0.25, 0.75);
  await guided.locator('[data-guided="width"]').fill('280');
  await guided.locator('[data-guided="height"]').fill('200');
  await guided.locator('[data-guided="create"]').click();
  await expect(await shown(page, 'workspace-status')).toContainText('Measured the Front view: 280×200');
  await workspace.getByRole('button', { name: 'Anchor', exact: true }).click();
  const stage = workspace.locator('.product-setup-overlay').first();
  const stageBox = (await stage.boundingBox())!;
  await stage.click({ position: { x: Math.round(stageBox.width * 0.5), y: Math.round(stageBox.height * 0.5) } });
  await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
  const summary = workspace.locator('summary', { hasText: 'All anchors' });
  if ((await summary.count()) > 0) {
    const open = await summary.first().evaluate((element) => (element.closest('details') as HTMLDetailsElement).open);
    if (!open) await summary.first().click();
  }
  await workspace.getByRole('button', { name: 'Anchor 1', exact: true }).click();
  await workspace.locator('[data-fkey^="psv-anchor-name-"]').fill(anchorName);
  await workspace.locator('[data-fkey^="psv-anchor-name-"]').press('Tab');
  await expect(workspace.getByText(`Renamed anchor to “${anchorName}”.`)).toBeVisible();
  await workspace.getByRole('button', { name: 'Save product setup' }).click();
  await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 1 anchors\)/)).toBeVisible();
}

async function checkProductCard(page: Page, title: string): Promise<void> {
  const card = page.locator('[data-product-card]', { hasText: title }).first();
  await expect(card).toBeVisible();
  await card.locator('input[type="checkbox"]').first().check();
}

async function downloadTo(page: Page, button: import('@playwright/test').Locator, outPath: string): Promise<string> {
  const event = page.waitForEvent('download');
  await button.click();
  const download = await event;
  await download.saveAs(outPath);
  return outPath;
}

test('direct images job: intake, setup, placements, measurement, technique, review, save, reopen', async ({ browser }, info) => {
  test.setTimeout(300_000);
  for (const viewport of VIEWPORTS) {
    const { context, page, probe } = await openStation(browser, viewport);
    try {
      await attachEnv(info, browser, viewport, 'operator direct job');
      // Step 1 headings are single (no duplicated Products/Logos blocks).
      await expect(page.locator('[data-job-step="prepare"] h3', { hasText: /^Products$/ })).toHaveCount(1);
      await expect(page.locator('[data-job-step="prepare"] h3', { hasText: /^Logos$/ })).toHaveCount(1);
      // Primary/secondary action buttons meet the 44px minimum on both viewports.
      const primaryMinHeight = await page.locator('[data-builder-hook="job-to-placements"]').evaluate((node) => parseFloat(getComputedStyle(node as HTMLElement).minHeight));
      expect(primaryMinHeight).toBeGreaterThanOrEqual(44);
      // Landing contract + dirty persistence line.
      await expect(builder(page, 'job-persistence')).toHaveText('');
      // Header Open-customer-response action matches the Save/Open/New job
      // buttons (secondary action styling, never a primary-looking link).
      const jobSaveStyle = await page.locator('[data-builder-hook="job-save"]').evaluate((node) => {
        const style = getComputedStyle(node as HTMLElement);
        return { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color, decoration: style.textDecorationLine };
      });
      const responseStyle = await page.locator('[data-builder-hook="job-response"]').evaluate((node) => {
        const style = getComputedStyle(node as HTMLElement);
        return { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color, decoration: style.textDecorationLine };
      });
      expect(responseStyle.fontSize).toBe(jobSaveStyle.fontSize);
      expect(responseStyle.fontWeight).toBe('400');
      expect(responseStyle.decoration).not.toContain('underline');
      await (await shown(page, 'customer-name')).fill('Acme Ltd');
      await (await shown(page, 'job-ref')).fill('JOB-001');
      await (await shown(page, 'issued-by')).fill('Pat');
      await expect(builder(page, 'job-persistence')).toHaveText('Changes are held in this browser. Save job to keep them.');

      // Two real products; only the first is calibrated below.
      const jacketPng = await syntheticPngBytes(page, '#1d6f3a');
      await stageIntakeImage(page, 'Front', 'front.png', jacketPng);
      await (await shown(page, 'product-name')).fill('Team jacket');
      await (await shown(page, 'product-add')).click();
      await expect(await shown(page, 'product-status')).toContainText('Added');
      await setupProductWithAnchor(page, 'Chest center');

      const capPng = await syntheticPngBytes(page, '#27408b');
      await stageIntakeImage(page, 'Side', 'side.png', capPng);
      await (await shown(page, 'product-name')).fill('Promo cap');
      await (await shown(page, 'product-add')).click();
      await expect(await shown(page, 'product-status')).toContainText('Added');

      // Two real logos through the Step 1 chooser.
      const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
      const starPng = await syntheticPngBytes(page, '#b03030', 160, 160);
      await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
      await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
      await (await shown(page, 'logo-file')).setInputFiles({ name: 'star.png', mimeType: 'image/png', buffer: Buffer.from(starPng) });
      await expect(await shown(page, 'logo-status')).toContainText('Added star.png');

      // Include the jacket; explicitly exclude the cap (unticked products
      // stay in the editable catalogue but leave issue/document outputs).
      const capCard = page.locator('[data-product-card]', { hasText: 'Promo cap' }).first();
      await capCard.locator('input[type="checkbox"]').first().uncheck();
      await expect(builder(page, 'job-prepare-gate')).toHaveText('');
      await (await shown(page, 'job-to-placements')).click();
      await expect(page.locator('[data-job-step="placements"]')).toBeVisible();

      // Same artwork placed twice; stable IDs differ.
      const host = builder(page, 'job-placement-host');
      // Choosers hide by included scope: one included product and one option
      // need no selectors, while the exact selection keeps working underneath.
      await expect(host.locator('[data-placement-hook="pw-product-select"]')).toHaveCount(0);
      await expect(host.locator('[data-placement-hook="pw-option-select"]')).toHaveCount(0);
      await host.getByRole('button', { name: 'Add logo placement' }).click();
      const addMinHeight = await host.locator('[data-placement-hook="pw-add-placement"]').evaluate((node) => parseFloat(getComputedStyle(node as HTMLElement).minHeight));
      expect(addMinHeight).toBeGreaterThanOrEqual(44);
      await pw(page, 'pw-add-logo').selectOption({ label: 'crest' });
      const addMethod = pw(page, 'pw-add-method');
      if ((await addMethod.count()) > 0) await addMethod.selectOption('print');
      await pw(page, 'pw-add-width').fill('90');
      await pw(page, 'pw-add-height').fill('40');
      await pw(page, 'pw-add-confirm').click();
      await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('crest');
      await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
      await host.getByRole('button', { name: 'Duplicate placement' }).click();
      expect(await host.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);
      // Each placed logo renders its actual original raster artwork inside the
      // footprint (beneath the selection outline), not just an outline box.
      const artworks = host.locator('[data-placement-hook="pw-stage-svg"] image[data-placement-hook^="pw-artwork-"]');
      await expect(artworks).toHaveCount(2);
      for (let index = 0; index < 2; index += 1) {
        const href = await artworks.nth(index).getAttribute('href');
        assert.ok(href !== null && href.length > 0, 'stage artwork carries the original bytes');
        expect(href.startsWith('blob:') || href.startsWith('data:')).toBe(true);
        // Affine placement (unit square mapped to the exact footprint quad),
        // so rotation renders through the same canonical geometry.
        const transform = await artworks.nth(index).getAttribute('transform');
        assert.ok(transform !== null && /^matrix\(.+\)$/.test(transform), 'stage artwork uses an affine footprint transform');
      }
      await expect(host.locator('[data-placement-hook="pw-stage-svg"] polygon[data-placement-index="0"]')).toBeVisible();

      // Bound operational measurement from the real setup anchor (each
      // placement carries its own binding).
      await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
      await host.getByRole('button', { name: 'Add measurement' }).click();
      await pw(page, 'pw-measure-anchor').selectOption({ label: 'Chest center' });
      await pw(page, 'pw-measure-edge').selectOption({ label: 'left' });
      await pw(page, 'pw-measure-direction').selectOption({ label: 'Horizontal' });
      await pw(page, 'pw-measure-save').click();
      const measureText = await host.locator('[data-placement-hook="pw-measurements"]').innerText();
      expect(measureText).toMatch(/Chest center to left edge, horizontal/);
      expect(measureText).toMatch(/\d+(\.\d)? mm/);
      await host.locator('[data-placement-hook^="pw-placement-row-"]').nth(1).click();
      await host.getByRole('button', { name: 'Add measurement' }).click();
      await pw(page, 'pw-measure-anchor').selectOption({ label: 'Chest center' });
      await pw(page, 'pw-measure-edge').selectOption({ label: 'left' });
      await pw(page, 'pw-measure-direction').selectOption({ label: 'Horizontal' });
      await pw(page, 'pw-measure-save').click();

      // Per-logo technique data under Production details (first placement).
      await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
      await host.locator('summary', { hasText: 'Production details' }).click();
      await pw(page, 'pw-tech-code-input').fill('CR-01');
      await pw(page, 'pw-tech-code-input').press('Tab');
      await pw(page, 'pw-tech-temperature').fill('160');
      await pw(page, 'pw-tech-temperature').press('Tab');
      await pw(page, 'pw-tech-time').fill('12');
      await pw(page, 'pw-tech-time').press('Tab');
      await pw(page, 'pw-tech-pressure').fill('medium');
      await pw(page, 'pw-tech-pressure').press('Tab');
      await pw(page, 'pw-tech-colour').fill('white');
      await pw(page, 'pw-tech-colour').press('Tab');
      await pw(page, 'pw-tech-thread').fill('Madeira');
      await pw(page, 'pw-tech-thread').press('Tab');

      // Review: the actual operational document, no customer file involved.
      await host.getByRole('button', { name: 'Review document' }).click();
      await expect(page.locator('[data-job-step="review"]')).toBeVisible();
      const reviewHost = builder(page, 'job-review-host');
      await expect(reviewHost.getByRole('heading', { name: 'Review operational document' })).toBeVisible();
      await reviewHost.locator('[data-doc-review-instructions]').fill('Press front logo at 160°C for 12 s, then check alignment.');
      await reviewHost.locator('[data-doc-review-instructions]').press('Tab');
      const previewText = await reviewHost.locator('[data-doc-review-preview]').innerText();
      expect(previewText).toContain('Acme Ltd');
      expect(previewText).toContain('Press front logo');
      expect(previewText).not.toContain('DRAFT');
      // Operator-facing headings never leak internal variant ids: the single
      // unnamed option renders as the product name alone.
      expect(previewText).toContain('Team jacket');
      expect(previewText).not.toMatch(/provisional-product-/);
      expect(previewText).not.toMatch(/customer-logo-[0-9a-f-]{8,}/);
      const summaryText = await reviewHost.innerText();
      expect(summaryText).toMatch(/Placements: 2/);
      await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();

      // Structured operator export carries the authored fields.
      // Open the disclosure robustly: the sheet preview loads artwork
      // asynchronously and layout can settle between click and paint.
      const moreDetails1 = reviewHost.locator('details', { hasText: 'More output options' });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (await moreDetails1.evaluate((d) => (d as HTMLDetailsElement).open)) break;
        await reviewHost.locator('summary', { hasText: 'More output options' }).click();
      }
      await expect(moreDetails1).toHaveAttribute('open', '');
      const operatorPath = await downloadTo(page, reviewHost.getByRole('button', { name: 'Save operator data' }), info.outputPath(`operator-data-${viewport.label}.json`));
      const operatorJson = JSON.parse((await readFile(operatorPath)).toString('utf8')) as { products?: Array<{ product?: string; variant?: string; instructions?: string[]; logos?: Array<{ code?: string; methodParams?: Record<string, string>; colours?: string[]; measurements?: Array<{ anchor?: string; distanceMm?: number }> }> }> };
      expect(operatorJson.products?.[0]?.instructions?.join('\n')).toContain('Press front logo');
      expect(operatorJson.products?.[0]?.product).toBe('Team jacket');
      expect(operatorJson.products?.[0]?.variant).toBe('Team jacket');
      expect(JSON.stringify(operatorJson.products)).not.toMatch(/provisional-product-|customer-logo-[0-9a-f-]{8,}/);
      const firstLogo = operatorJson.products?.[0]?.logos?.[0];
      expect(firstLogo?.code).toBe('CR-01');
      expect(firstLogo?.methodParams?.['temperature']).toBe('160');
      expect(firstLogo?.colours).toEqual(['white']);

      // Diagnostic candidate digest for the reopen comparison.
      const diagPath = await downloadTo(page, reviewHost.getByRole('button', { name: 'Save diagnostic data' }), info.outputPath(`candidate-${viewport.label}.json`));
      const candidateJson = JSON.parse((await readFile(diagPath)).toString('utf8')) as { digest?: string };
      assert.ok(typeof candidateJson.digest === 'string' && candidateJson.digest.length === 64, 'candidate carries a digest');

      // Save job → exact package bytes.
      const jobPath = await downloadTo(page, builder(page, 'job-save'), info.outputPath(`job-${viewport.label}.logo-project`));
      await expect(builder(page, 'job-persistence')).toHaveText('Job file download started. Keep the downloaded file to reopen this job.');
      const savedBytes = new Uint8Array(await readFile(jobPath));
      const saved = await parseProjectPackage(savedBytes, { sha256 });
      expect(saved.project.products).toHaveLength(2);
      const jacketConfig = saved.project.configurations.find((entry) => entry.productId !== undefined);
      assert.ok(jacketConfig, 'saved job carries configurations');
      const crestPlacements = saved.project.configurations.flatMap((entry) => entry.placements).filter((entry) => entry.logoId.includes('customer-logo'));
      expect(crestPlacements).toHaveLength(2);
      expect(new Set(crestPlacements.map((entry) => entry.id)).size).toBe(2);
      for (const placement of crestPlacements) {
        expect(placement.widthMm).toBe(90);
        expect(placement.heightMm).toBe(40);
      }
      const sidecarRaw = saved.assets.find((asset) => asset.path === 'operator/job-metadata.json');
      assert.ok(sidecarRaw, 'saved job carries the operation sidecar');
      const sidecar = JSON.parse(Buffer.from(sidecarRaw.bytes).toString('utf8')) as {
        identity: { customer?: string; jobReference?: string; preparedBy?: string };
        instructions?: string;
        bindings?: Array<{ status: string; frameId: string; calibrationId: string; unresolvedReason?: string; anchorId: string; edge: string; convention: string }>;
        techniqueSettings?: Record<string, Record<string, { businessCode?: string; methodParams?: Record<string, string>; colours?: string[] }>>;
        inclusion?: { includedProducts: string[]; includedConfigurations: string[]; logoIds?: string[] };
        anchors?: Array<{ name: string }>;
      };
      expect(sidecar.identity.customer).toBe('Acme Ltd');
      expect(sidecar.identity.jobReference).toBe('JOB-001');
      expect(sidecar.identity.preparedBy).toBe('Pat');
      expect(sidecar.instructions).toContain('Press front logo');
      expect(sidecar.bindings).toHaveLength(2);
      expect(sidecar.bindings?.[0]?.status).toBe('bound');
      expect(sidecar.bindings?.[0]?.frameId).not.toBe('');
      expect(sidecar.bindings?.[0]?.calibrationId).not.toBe('');
      expect(sidecar.bindings?.[0]?.anchorId).not.toBe('');
      expect(sidecar.anchors?.map((entry) => entry.name)).toContain('Chest center');
      const techValues = Object.values(sidecar.techniqueSettings ?? {}).flatMap((perLogo) => Object.values(perLogo));
      expect(techValues.some((entry) => entry.businessCode === 'CR-01')).toBe(true);
      expect(techValues.some((entry) => entry.methodParams?.['temperature'] === '160')).toBe(true);
      expect(techValues.some((entry) => entry.colours?.[0] === 'white')).toBe(true);
      expect(sidecar.inclusion?.includedProducts).toHaveLength(1);
      // Logo selection persists, including the selected-but-unused artwork.
      expect(sidecar.inclusion?.logoIds).toHaveLength(2);
      const jacketProduct = saved.project.products.find((entry) => (entry.name ?? '').includes('jacket'));
      assert.ok(jacketProduct, 'catalogue keeps the jacket');
      expect(sidecar.inclusion?.includedProducts).toEqual([jacketProduct.id]);

      // Fresh station → Open job restores every field.
      const freshContext = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
      const fresh = await freshContext.newPage();
      const freshProbe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
      fresh.on('pageerror', (error) => freshProbe.pageErrors.push(String(error)));
      fresh.on('console', (message) => { if (message.type() === 'error') freshProbe.consoleErrors.push(message.text()); });
      freshContext.on('request', (request) => { if (/^https?:/i.test(request.url())) freshProbe.networkRequests.push(request.url()); });
      try {
        await gotoBuilder(fresh);
        await fresh.locator('[data-builder-hook="job-landing-open"]').click();
        await fresh.locator('[data-builder-hook="job-open-file"]').setInputFiles(jobPath);
        await expect(fresh.locator('[data-job-step="prepare"]')).toBeVisible();
        await expect(fresh.locator('[data-builder-hook="customer-name"]')).toHaveValue('Acme Ltd');
        await expect(fresh.locator('[data-builder-hook="job-ref"]')).toHaveValue('JOB-001');
        await expect(fresh.locator('[data-builder-hook="issued-by"]')).toHaveValue('Pat');
        const jacketCard = fresh.locator('[data-product-card]', { hasText: 'Team jacket' }).first();
        await expect(jacketCard.locator('input[type="checkbox"]').first()).toBeChecked();
        const capCard = fresh.locator('[data-product-card]', { hasText: 'Promo cap' }).first();
        await expect(capCard.locator('input[type="checkbox"]').first()).not.toBeChecked();
        // Selected artwork restores checked, including the unused star.
        const crestRow = fresh.locator('[data-builder-hook="logo-list"] label', { hasText: 'crest' }).first();
        await expect(crestRow.locator('input[type="checkbox"]')).toBeChecked();
        const starRow = fresh.locator('[data-builder-hook="logo-list"] label', { hasText: 'star' }).first();
        await expect(starRow.locator('input[type="checkbox"]')).toBeChecked();
        await fresh.locator('[data-builder-hook="job-to-placements"]').click();
        const freshHost = fresh.locator('[data-builder-hook="job-placement-host"]');
        expect(await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);
        await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
        const freshMeasure = await freshHost.locator('[data-placement-hook="pw-measurements"]').innerText();
        expect(freshMeasure).toBe(measureText);
        await freshHost.locator('summary', { hasText: 'Production details' }).click();
        await expect(fresh.locator('[data-placement-hook="pw-tech-code-input"]')).toHaveValue('CR-01');
        await expect(fresh.locator('[data-placement-hook="pw-tech-temperature"]')).toHaveValue('160');
        await fresh.locator('[data-placement-hook="pw-review"]').click();
        const freshReview = fresh.locator('[data-builder-hook="job-review-host"]');
        await expect(freshReview.locator('[data-doc-review-instructions]')).toHaveValue('Press front logo at 160°C for 12 s, then check alignment.');
        // Open the disclosure robustly: the sheet preview loads artwork
        // asynchronously and layout can settle between click and paint.
        const moreDetails2 = freshReview.locator('details', { hasText: 'More output options' });
        for (let attempt = 0; attempt < 5; attempt += 1) {
          if (await moreDetails2.evaluate((d) => (d as HTMLDetailsElement).open)) break;
          await freshReview.locator('summary', { hasText: 'More output options' }).click();
        }
        await expect(moreDetails2).toHaveAttribute('open', '');
        const freshDiagPath = await downloadTo(fresh, freshReview.getByRole('button', { name: 'Save diagnostic data' }), info.outputPath(`candidate-reopen-${viewport.label}.json`));
        const freshCandidate = JSON.parse((await readFile(freshDiagPath)).toString('utf8')) as { digest?: string };
        expect(freshCandidate.digest).toBe(candidateJson.digest);

        // Optional approval branch: exact current placements ship; tampered
        // or mismatched returns are rejected atomically. Auto-identity: the
        // first Create allocates a fresh unique issue ID with no Advanced
        // interaction; unchanged reruns keep the ID and bytes; content
        // changes auto-allocate a new ID; a deliberately retyped manual ID
        // under changed content is refused with More-options guidance.
        const branch = fresh.locator('[data-customer-approval]');
        const moreOptions = branch.locator('summary', { hasText: 'More options' });
        const branchMore = branch.locator('details', { hasText: 'More options' });
        await fresh.locator('[data-builder-hook="job-step-2"]').click();
        await freshHost.getByRole('button', { name: 'Send for customer approval' }).click();
        await expect(branch).toContainText('Send for customer approval');
        await expect(moreOptions).toBeVisible();
        // The normal summary carries no issue UUID (advanced-only detail).
        await expect(branch.locator('section[aria-label="Job and selection summary"]')).not.toContainText('issue project');
        await expect(branch).toContainText('Send for customer approval');
        // More options stays collapsed unless the operator opens it.
        await expect(branchMore).not.toHaveAttribute('open', '');
        const branchCreate = fresh.getByRole('button', { name: 'Create customer file', exact: true });
        await branchCreate.click();
        await expect(branch).toContainText('Customer file created');
        const autoId = await fresh.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
        assert.ok(autoId.length > 0, 'first Create auto-allocates a fresh issue ID');
        const officePath = await downloadTo(fresh, fresh.getByRole('button', { name: 'Save office copy', exact: true }), info.outputPath(`office-${viewport.label}.logo-project`));
        const customerPath = await downloadTo(fresh, fresh.getByRole('button', { name: 'Save customer file', exact: true }), info.outputPath(`customer-${viewport.label}.html`));
        expect((await readFile(customerPath)).length).toBeGreaterThan(1000);
        const issued = await parseProjectPackage(new Uint8Array(await readFile(officePath)), { sha256 });
        expect(issued.project.projectId).toBe(autoId);
        const issuedPlacements = issued.project.configurations.flatMap((entry) => entry.placements);
        expect(issuedPlacements).toHaveLength(2);
        expect(issuedPlacements.map((entry) => [entry.widthMm, entry.heightMm])).toEqual([[90, 40], [90, 40]]);
        // Unchanged rerun keeps the ID and the byte-identical office copy.
        await branchCreate.click();
        await expect(branch).toContainText('Customer file created');
        expect(await fresh.locator('[data-builder-hook="job-issue-project-id"]').inputValue()).toBe(autoId);
        const officeRerunPath = await downloadTo(fresh, fresh.getByRole('button', { name: 'Save office copy', exact: true }), info.outputPath(`office-rerun-${viewport.label}.logo-project`));
        expect(Buffer.from(await readFile(officeRerunPath))).toEqual(Buffer.from(await readFile(officePath)));
        // Geometry edit, then regenerate without touching Advanced: a fresh
        // unique issue ID is allocated automatically with the new geometry.
        await expect(branchMore).not.toHaveAttribute('open', '');
        await fresh.locator('[data-builder-hook="job-step-2"]').click();
        await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
        await fresh.locator('[data-placement-hook="pw-width"]').fill('95');
        await fresh.locator('[data-placement-hook="pw-apply"]').first().click();
        await expect(fresh.locator('[data-placement-hook="pw-apply"]')).toHaveCount(0);
        // Post-edit measurement text: distances recompute for the new width.
        await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
        const editedMeasureText = await freshHost.locator('[data-placement-hook="pw-measurements"]').innerText();
        await freshHost.getByRole('button', { name: 'Send for customer approval' }).click();
        await expect(branchMore).not.toHaveAttribute('open', '');
        await branchCreate.click();
        await expect(branch).toContainText('Customer file created');
        const secondId = await fresh.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
        assert.ok(secondId.length > 0 && secondId !== autoId, 'changed content auto-allocates a new issue ID');
        const officeChangedPath = await downloadTo(fresh, fresh.getByRole('button', { name: 'Save office copy', exact: true }), info.outputPath(`office-changed-${viewport.label}.logo-project`));
        const changed = await parseProjectPackage(new Uint8Array(await readFile(officeChangedPath)), { sha256 });
        expect(changed.project.projectId).toBe(secondId);
        expect(changed.project.configurations.flatMap((entry) => entry.placements).map((entry) => entry.widthMm)).toContain(95);
        // Manual override collision: deliberately retyping the now-stale
        // first ID under changed content is refused with More-options guidance.
        await moreOptions.click();
        await expect(branchMore).toHaveAttribute('open', '');
        await expect(branch).toContainText(`Issue project ID: ${secondId}`);
        await fresh.locator('[data-builder-hook="job-issue-project-id"]').fill(autoId);
        await branchCreate.click();
        await expect(branch).toContainText('More options');
        await expect(await fresh.locator('[data-builder-hook="job-issue-project-id"]').inputValue()).toBe(autoId);
        // Recovery through an explicitly minted ID works.
        await fresh.getByRole('button', { name: 'Create a new ID', exact: true }).click();
        const recoveredId = await fresh.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
        assert.ok(recoveredId.length > 0 && recoveredId !== autoId && recoveredId !== secondId, 'explicit new ID mints afresh');
        await branchCreate.click();
        await expect(branch).toContainText('Customer file created');
        // The recovery issue carries the current (edited) geometry: retain
        // its office copy as the baseline for the round-trip below. The
        // earlier officePath holds pre-edit geometry and is stale now.
        const officeCurrentPath = await downloadTo(fresh, fresh.getByRole('button', { name: 'Save office copy', exact: true }), info.outputPath(`office-current-${viewport.label}.logo-project`));
        const tampered = new Uint8Array(await readFile(officeCurrentPath));
        tampered[tampered.length - 10] = tampered[tampered.length - 10]! ^ 0xff;
        await fresh.getByLabel('Choose the saved office copy for this job').setInputFiles(officeCurrentPath);
        // Opening the office copy is asynchronous. Follow the actual enabled
        // response action instead of injecting a file during its busy lock.
        await expect(fresh.locator('[data-customer-approval]')).toContainText('Office copy loaded:');
        await expect(fresh.locator('[data-customer-approval]').getByRole('button', { name: 'Open customer response', exact: true })).toBeEnabled();
        await fresh.getByLabel('Choose the returned customer file').setInputFiles({ name: 'tampered.logo-project', mimeType: 'application/zip', buffer: Buffer.from(tampered) });
        await expect(fresh.locator('[data-customer-approval]')).toContainText('Could not import response');
        // Mismatched baseline: a different valid package is not this issue.
        await fresh.getByLabel('Choose the returned customer file').setInputFiles(jobPath);
        await expect(fresh.locator('[data-customer-approval]')).toContainText(/does not match|baseline|Could not open|not.*issue/i);
        await fresh.locator('[data-builder-hook="job-step-2"]').click();
        expect(await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);
        // No-change response round-trips through Use: identical geometry
        // installs and office-authored measurements, technique and
        // instructions are preserved with recomputed distances.
        await freshHost.getByRole('button', { name: 'Send for customer approval' }).click();
        await fresh.getByLabel('Choose the returned customer file').setInputFiles(officeCurrentPath);
        await expect(fresh.locator('[data-customer-approval]')).toContainText('Response checked against the office copy');
        await fresh.getByRole('button', { name: 'Use customer changes' }).click();
        await expect(fresh.locator('[data-job-step="placements"]')).toBeVisible();
        expect(await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);
        await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
        expect(await freshHost.locator('[data-placement-hook="pw-measurements"]').innerText()).toBe(editedMeasureText);
        // Installing lands unselected: re-include the job exactly, then the
        // preserved staff authoring recompletes the document.
        await fresh.locator('[data-builder-hook="job-step-1"]').click();
        await fresh.locator('[data-product-card]', { hasText: 'Team jacket' }).first().locator('input[type="checkbox"]').first().check();
        await fresh.locator('[data-builder-hook="logo-list"] label', { hasText: 'crest' }).first().locator('input[type="checkbox"]').check();
        await fresh.locator('[data-builder-hook="logo-list"] label', { hasText: 'star' }).first().locator('input[type="checkbox"]').check();
        await fresh.locator('[data-builder-hook="job-step-3"]').click();
        const installedReview = fresh.locator('[data-builder-hook="job-review-host"]');
        await expect(installedReview.locator('[data-doc-review-instructions]')).toHaveValue('Press front logo at 160°C for 12 s, then check alignment.');
        await expect(installedReview.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
        // Open the disclosure robustly: the sheet preview loads artwork
        // asynchronously and layout can settle between click and paint.
        const installedMore = installedReview.locator('details', { hasText: 'More output options' });
        for (let attempt = 0; attempt < 5; attempt += 1) {
          if (await installedMore.evaluate((d) => (d as HTMLDetailsElement).open)) break;
          await installedReview.locator('summary', { hasText: 'More output options' }).click();
        }
        await expect(installedMore).toHaveAttribute('open', '');
        const diagBtn = installedReview.getByRole('button', { name: 'Save diagnostic data' });
        await expect(diagBtn).toBeVisible();
        const installedDiagPath = await downloadTo(fresh, diagBtn, info.outputPath(`candidate-installed-${viewport.label}.json`));
        const installedCandidate = JSON.parse((await readFile(installedDiagPath)).toString('utf8')) as { digest?: string; configurations?: Array<{ placements?: Array<{ widthMm?: number; heightMm?: number }> }> };
        // New issue identity means a new digest; the authored geometry itself
        // round-trips exactly (same placements, same millimetres).
        expect(installedCandidate.digest).not.toBe(candidateJson.digest);
        const installedPlacements = (installedCandidate.configurations ?? []).flatMap((entry) => entry.placements ?? []);
        expect(installedPlacements).toHaveLength(2);
        // Row order is a display concern: compare geometry as a set.
        expect(installedPlacements.map((entry) => entry.widthMm).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([90, 95]);
        expect(installedPlacements.map((entry) => entry.heightMm)).toEqual([40, 40]);
        expectOfflineClean(freshProbe);
      } finally {
        await freshContext.close();
      }

      const shotPath = info.outputPath(`operator-review-${viewport.label}.png`);
      await page.locator('[data-builder-hook="job-step-3"]').click();
      // Emulated print carries the actual sheet and excludes the UI chrome.
      await page.emulateMedia({ media: 'print' });
      const printPreview = page.locator('[data-doc-review-preview]');
      await expect(printPreview).toBeVisible();
      await expect(printPreview).toContainText('Press front logo');
      await expect(printPreview).toContainText('Acme Ltd');
      await expect(page.locator('header.station-header')).toBeHidden();
      await expect(page.locator('[data-job-step="prepare"]')).toBeHidden();
      await expect(page.locator('[data-job-step="placements"]')).toBeHidden();
      await expect(page.locator('[data-doc-review-rail]')).toBeHidden();
      await page.emulateMedia({ media: 'screen' });
      // Step 3 layout contract: one step heading (sheet content keeps its
      // own headers); desktop shows the preview left (2fr) beside the rail
      // (right); narrow stacks main first.
      await expect(page.locator('[data-job-step="review"] h2.doc-review-title')).toHaveCount(1);
      await expect(page.locator('[data-job-step="review"] h2.task-title')).toHaveCount(0);
      const layout = await page.evaluate(() => {
        const rect = (selector: string): { top: number; left: number; bottom: number; width: number } => {
          const node = document.querySelector(selector);
          if (!node) return { top: -1, left: -1, bottom: -1, width: -1 };
          const box = node.getBoundingClientRect();
          return { top: box.top, left: box.left, bottom: box.bottom, width: box.width };
        };
        return {
          main: rect('[data-doc-review-main]'),
          rail: rect('[data-doc-review-rail]'),
          preview: rect('[data-doc-review-preview]'),
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
        };
      });
      expect(layout.main.width).toBeGreaterThan(0);
      expect(layout.rail.width).toBeGreaterThan(0);
      if (viewport.label === 'desktop') {
        expect(layout.main.left).toBeLessThan(layout.rail.left);
        expect(Math.abs(layout.main.top - layout.rail.top)).toBeLessThan(300);
        expect(layout.preview.top).toBeLessThan(900);
      } else {
        expect(layout.main.bottom).toBeLessThanOrEqual(layout.rail.top + 1);
      }
      expect(layout.scrollW).toBeLessThanOrEqual(layout.innerW + 1);
      await page.screenshot({ path: shotPath });
      await info.attach(`operator-review-${viewport.label}`, { path: shotPath, contentType: 'image/png' });
      expectOfflineClean(probe);
    } finally {
      await context.close();
    }
  }
});

test('invalid footprint stays scoped: actionable issue, complete print blocked, draft marked', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = VIEWPORTS[0]!;
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'operator invalid footprint');
    await (await shown(page, 'customer-name')).fill('Acme Ltd');
    await (await shown(page, 'job-ref')).fill('JOB-002');
    const jacketPng = await syntheticPngBytes(page, '#1d6f3a');
    await stageIntakeImage(page, 'Front', 'front.png', jacketPng);
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');
    await setupProductWithAnchor(page, 'Chest center');
    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await checkProductCard(page, 'Team jacket');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    // Oversized footprint: wider than the 280 mm measured region. The fit
    // message names the artwork and the area (spec wording), review carries
    // the exact geometry reason with a Fix link, and complete print is
    // disabled. Blocking items offer no unmarked production output.
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption('print');
    await pw(page, 'pw-add-width').fill('500');
    await pw(page, 'pw-add-height').fill('400');
    await pw(page, 'pw-add-confirm').click();
    await expect(host.locator('[data-placement-hook="pw-validation"]')).toContainText(/extends outside/);
    await host.getByRole('button', { name: 'Review document' }).click();
    await expect(page.locator('[data-job-step="review"]')).toBeVisible();
    let reviewHost = builder(page, 'job-review-host');
    await expect(reviewHost).toContainText(/lies outside the safe region/);
    await expect(reviewHost.getByRole('button', { name: 'Fix' }).first()).toBeVisible();
    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeDisabled();
    // Back to placements: remove the invalid placement and add a valid one
    // with no measurement. Structurally valid but incomplete → explicit
    // Print draft with DRAFT markings, complete print still disabled.
    await reviewHost.getByRole('button', { name: 'Back to placements' }).click();
    await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
    await host.getByRole('button', { name: 'Remove placement' }).click();
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    if ((await addMethod.count()) > 0) await addMethod.selectOption('print');
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await host.getByRole('button', { name: 'Review document' }).click();
    await expect(page.locator('[data-job-step="review"]')).toBeVisible();
    reviewHost = builder(page, 'job-review-host');
    await expect(reviewHost).toContainText(/unfinished/i);
    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeDisabled();
    const draft = reviewHost.getByRole('button', { name: 'Print draft' });
    await expect(draft).toBeEnabled();
    await expect(reviewHost.locator('[data-doc-review-preview]')).toContainText(/DRAFT/i);
    // Unapplied edits never leak: editing without Apply keeps review gated,
    // and Save job offers Apply / Discard / Keep editing.
    await reviewHost.getByRole('button', { name: 'Back to placements' }).click();
    await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
    await pw(page, 'pw-width').fill('95');
    await page.locator('[data-builder-hook="job-step-3"]').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await expect(builder(page, 'builder-alert')).toContainText(/Apply|pending/i);
    await pw(page, 'pw-apply').first().click();
    await page.locator('[data-builder-hook="job-step-3"]').click();
    await expect(page.locator('[data-job-step="review"]')).toBeVisible();
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('zero-placement option stays present and prints its explicit statement', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = VIEWPORTS[0]!;
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'operator zero placements');
    await (await shown(page, 'customer-name')).fill('Acme Ltd');
    await (await shown(page, 'job-ref')).fill('JOB-003');
    const jacketPng = await syntheticPngBytes(page, '#1d6f3a');
    await stageIntakeImage(page, 'Front', 'front.png', jacketPng);
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');
    await setupProductWithAnchor(page, 'Chest center');
    await checkProductCard(page, 'Team jacket');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await expect(host).toContainText('No logo placements for this option.');
    await host.getByRole('button', { name: 'Review document' }).click();
    await expect(page.locator('[data-job-step="review"]')).toBeVisible();
    const reviewHost = builder(page, 'job-review-host');
    await expect(reviewHost).toContainText('No logo placements for this option.');
    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('artwork selection: add choices selected-only, excluded-used stays resolvable', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = VIEWPORTS[0]!;
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'operator artwork selection');
    await (await shown(page, 'customer-name')).fill('Acme Ltd');
    await (await shown(page, 'job-ref')).fill('JOB-004');
    const jacketPng = await syntheticPngBytes(page, '#1d6f3a');
    await stageIntakeImage(page, 'Front', 'front.png', jacketPng);
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');
    await setupProductWithAnchor(page, 'Chest center');
    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    const starPng = await syntheticPngBytes(page, '#b03030', 160, 160);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'star.png', mimeType: 'image/png', buffer: Buffer.from(starPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added star.png');
    await checkProductCard(page, 'Team jacket');
    // Excluding the unused star narrows Add-placement choices to the crest.
    const starRow = page.locator('[data-builder-hook="logo-list"] label', { hasText: 'star' }).first();
    await starRow.locator('input[type="checkbox"]').uncheck();
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    const options = await pw(page, 'pw-add-logo').locator('option').allInnerTexts();
    expect(options).toContain('crest');
    expect(options).not.toContain('star');
    await pw(page, 'pw-add-logo').selectOption({ label: 'crest' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption('print');
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('crest');
    // Excluding the now-used crest keeps the authored placement resolvable
    // and explains the consequence instead of silently deleting it.
    await page.locator('[data-builder-hook="job-step-1"]').click();
    const crestRow = page.locator('[data-builder-hook="logo-list"] label', { hasText: 'crest' }).first();
    await crestRow.locator('input[type="checkbox"]').uncheck();
    await expect(await shown(page, 'selection-error')).toContainText(/not selected|existing placements stay/i);
    await page.locator('[data-builder-hook="job-step-2"]').click();
    expect(await host.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(1);
    // The excluded-but-used placement stays visible with its artwork label.
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('crest');
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('calibrated photo overlay tracks canonical dimensions; unmapped views stay diagram', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const viewport = VIEWPORTS[0]!;
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'operator photo overlay');
    await (await shown(page, 'customer-name')).fill('Acme Ltd');
    await (await shown(page, 'job-ref')).fill('JOB-005');
    // Two real intake views on one product; only the front view is calibrated
    // and photo-mapped below.
    const frontPng = await syntheticPngBytes(page, '#1d6f3a');
    const backPng = await syntheticPngBytes(page, '#27408b');
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-view-add')).click();
    const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
    await rows.nth(1).locator('input[type="text"]').fill('Back');
    await rows.nth(1).locator('input[type="file"]').setInputFiles({ name: 'back.png', mimeType: 'image/png', buffer: Buffer.from(backPng) });
    await expect(rows.nth(1).locator('.view-row-state')).toContainText('ready');
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');
    await setupProductWithAnchor(page, 'Chest center');
    // The rectangle calibration above staged the front-view photo mapping
    // automatically (span/rectangle flows stage it; no manual form exists).
    // Only the calibrated front tab carries the overlay below.
    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    // Exactly one of the two view tabs carries the calibrated overlay.
    const tabs = host.locator('[data-placement-hook^="pw-view-tab-"]');
    await expect(tabs).toHaveCount(2);
    const overlayStates: boolean[] = [];
    for (let index = 0; index < 2; index += 1) {
      await tabs.nth(index).click();
      overlayStates.push((await host.locator('[data-placement-hook="pw-overlay-image"]').count()) > 0);
    }
    expect(overlayStates.filter(Boolean)).toHaveLength(1);
    const mappedTab = overlayStates[0] === true ? 0 : 1;
    await tabs.nth(mappedTab).click();
    const overlay = host.locator('[data-placement-hook="pw-overlay-image"]');
    await expect(overlay).toBeVisible();
    expect(await overlay.getAttribute('width')).toBe('400');
    expect(await overlay.getAttribute('height')).toBe('300');
    await expect(overlay).toHaveAttribute('aria-label', /Provisional calibrated preview/);
    // A 90 mm placement on the 280 mm region renders at the canonical ratio
    // through the overlay mapping — millimetres through the region frame,
    // never from pixels.
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'crest' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption('print');
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('crest');
    const ratio = await host.locator('[data-placement-hook="pw-stage-svg"]').evaluate((svg) => {
      const bbox = (points: string | null): number => {
        if (!points) return 0;
        const xs = points.trim().split(/\s+/).map((pair) => Number(pair.split(',')[0]));
        return Math.max(...xs) - Math.min(...xs);
      };
      const footprint = svg.querySelector('polygon[data-placement-index="0"]');
      const areas = [...svg.querySelectorAll('polygon[data-placement-hook^="pw-area-"]')];
      const area = areas.find((node) => (node as SVGPolygonElement).points.numberOfItems >= 3) ?? areas[0];
      const fw = bbox(footprint?.getAttribute('points') ?? null);
      const aw = bbox(area?.getAttribute('points') ?? null);
      return aw > 0 ? fw / aw : -1;
    });
    expect(ratio).toBeGreaterThan(0.29);
    expect(ratio).toBeLessThan(0.36);
    // Orientation is pinned by matrix UV corners, not just the bbox ratio:
    // UV top-left lands on the top-left footprint vertex (no vertical mirror).
    await expectArtworkOrientation(host);
    // Switching to the unmapped view keeps geometry and selection on the
    // honest measured diagram; switching back restores the overlay.
    const unmappedTab = mappedTab === 0 ? 1 : 0;
    await tabs.nth(unmappedTab).click();
    await expect(host.locator('[data-placement-hook="pw-overlay-image"]')).toHaveCount(0);
    expect(await host.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(1);
    await tabs.nth(mappedTab).click();
    await expect(host.locator('[data-placement-hook="pw-overlay-image"]')).toBeVisible();
    expect(await host.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(1);
    // Camera/view switches never change canonical dimensions: the overlay
    // footprint ratio is identical after the round trip.
    const ratioAfter = await host.locator('[data-placement-hook="pw-stage-svg"]').evaluate((svg) => {
      const bbox = (points: string | null): number => {
        if (!points) return 0;
        const xs = points.trim().split(/\s+/).map((pair) => Number(pair.split(',')[0]));
        return Math.max(...xs) - Math.min(...xs);
      };
      const footprint = svg.querySelector('polygon[data-placement-index="0"]');
      const areas = [...svg.querySelectorAll('polygon[data-placement-hook^="pw-area-"]')];
      const area = areas.find((node) => (node as SVGPolygonElement).points.numberOfItems >= 3) ?? areas[0];
      const fw = bbox(footprint?.getAttribute('points') ?? null);
      const aw = bbox(area?.getAttribute('points') ?? null);
      return aw > 0 ? fw / aw : -1;
    });
    expect(Math.abs(ratioAfter - ratio)).toBeLessThan(0.02);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('primary span calibration drives the photo overlay with no Advanced mapping', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const viewport = VIEWPORTS[0]!;
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'operator span overlay');
    await (await shown(page, 'customer-name')).fill('Acme Ltd');
    await (await shown(page, 'job-ref')).fill('JOB-006');
    // Two real intake views; only the front view is span-calibrated.
    const frontPng = await syntheticPngBytes(page, '#1d6f3a');
    const backPng = await syntheticPngBytes(page, '#27408b');
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-view-add')).click();
    const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
    await rows.nth(1).locator('input[type="text"]').fill('Back');
    await rows.nth(1).locator('input[type="file"]').setInputFiles({ name: 'back.png', mimeType: 'image/png', buffer: Buffer.from(backPng) });
    await expect(rows.nth(1).locator('.view-row-state')).toContainText('ready');
    await (await shown(page, 'product-name')).fill('Span jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');
    // Primary flow only: two-click span + drawn safe area + atomic save.
    // No Advanced mapping UI is touched; the span commit stages a
    // provisional photo mapping for the calibrated view by itself.
    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    const spanOverlay = guided.locator('[data-guided="span-overlay"]');
    await expect(spanOverlay).toBeVisible();
    const spanBox = (await spanOverlay.boundingBox())!;
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.3), y: Math.round(spanBox.height * 0.5) } });
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.7), y: Math.round(spanBox.height * 0.5) } });
    await guided.locator('[data-guided="span-mm"]').fill('1300');
    await guided.locator('[data-guided="span-create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');
    const stage = workspace.locator('.product-setup-overlay').first();
    const stageBox = (await stage.boundingBox())!;
    for (const [fx, fy] of [[0.08, 0.3], [0.28, 0.3], [0.28, 0.7], [0.08, 0.7]] as const) {
      await stage.click({ position: { x: Math.round(stageBox.width * fx), y: Math.round(stageBox.height * fy) } });
    }
    await workspace.getByRole('button', { name: 'Finish safe area' }).click();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \([0-9]+ safe-area corners, [0-9]+ anchors?\)/)).toBeVisible();
    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    // One visible heading for the step (no duplicated shell/module titles).
    await expect(host.locator('h2', { hasText: 'Set logo placements' })).toHaveCount(1);
    expect(await page.locator('[data-job-step="placements"] h2.task-title').count()).toBe(0);
    // The span-calibrated front view renders the photo overlay with the
    // truthful provisional warning; the unmapped back view stays diagram.
    const tabs = host.locator('[data-placement-hook^="pw-view-tab-"]');
    await expect(tabs).toHaveCount(2);
    const overlayStates: boolean[] = [];
    for (let index = 0; index < 2; index += 1) {
      await tabs.nth(index).click();
      overlayStates.push((await host.locator('[data-placement-hook="pw-overlay-image"]').count()) > 0);
    }
    expect(overlayStates.filter(Boolean)).toHaveLength(1);
    const mappedTab = overlayStates[0] === true ? 0 : 1;
    await tabs.nth(mappedTab).click();
    const overlay = host.locator('[data-placement-hook="pw-overlay-image"]');
    await expect(overlay).toBeVisible();
    expect(await overlay.getAttribute('width')).toBe('400');
    expect(await overlay.getAttribute('height')).toBe('300');
    await expect(host.locator('[data-placement-hook="pw-overlay-provisional"]')).toContainText('Provisional calibrated preview');
    // A 90 mm placement on the drawn area tracks canonical millimetres:
    // 20% of the 400 px photo at 1300 mm per 160 px span = 650 mm wide.
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'crest' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption('print');
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('crest');
    const ratio = await host.locator('[data-placement-hook="pw-stage-svg"]').evaluate((svg) => {
      const bbox = (points: string | null): number => {
        if (!points) return 0;
        const xs = points.trim().split(/\s+/).map((pair) => Number(pair.split(',')[0]));
        return Math.max(...xs) - Math.min(...xs);
      };
      const footprint = svg.querySelector('polygon[data-placement-index="0"]');
      const areas = [...svg.querySelectorAll('polygon[data-placement-hook^="pw-area-"]')];
      const area = areas.find((node) => (node as SVGPolygonElement).points.numberOfItems >= 3) ?? areas[0];
      const fw = bbox(footprint?.getAttribute('points') ?? null);
      const aw = bbox(area?.getAttribute('points') ?? null);
      return aw > 0 ? fw / aw : -1;
    });
    expect(ratio).toBeGreaterThan(0.10);
    expect(ratio).toBeLessThan(0.18);
    await expectArtworkOrientation(host);
    // Switching views keeps scoped geometry and selection; the unmapped view
    // stays an honest diagram and the mapped view keeps its overlay.
    await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
    // A rotated placement keeps canonical geometry through the same affine
    // mapping in both modes (matrix UV corners rechecked below).
    await pw(page, 'pw-rotation').fill('30');
    await host.getByRole('button', { name: 'Apply changes' }).click();
    await expectArtworkOrientation(host);
    const unmappedTab = mappedTab === 0 ? 1 : 0;
    await tabs.nth(unmappedTab).click();
    await expect(host.locator('[data-placement-hook="pw-overlay-image"]')).toHaveCount(0);
    expect(await host.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(1);
    await tabs.nth(mappedTab).click();
    await expect(host.locator('[data-placement-hook="pw-overlay-image"]')).toBeVisible();
    expect(await host.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(1);
    expect(await host.locator('[data-placement-hook="pw-overlay-provisional"]')).toContainText('Provisional calibrated preview');
    // Rotated artwork keeps exact UV-corner mapping after the view switch.
    await expectArtworkOrientation(host);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('direct model-only job: calibrated diagram placement without any photo', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const viewport = VIEWPORTS[0]!;
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'operator model-only job');
    await (await shown(page, 'customer-name')).fill('Acme Ltd');
    await (await shown(page, 'job-ref')).fill('JOB-MODEL');
    // Real GLB intake through the Images/3D toggle (model path stages one file).
    const { cubeGlb } = await import('./fixtures/setup-calibration-glb.js');
    await (await shown(page, 'intake-mode-model')).check();
    await (await shown(page, 'product-file')).setInputFiles({ name: 'shell.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(cubeGlb()) });
    await expect(await shown(page, 'intake-model-status')).toContainText('ready');
    await (await shown(page, 'product-name')).fill('Model shell');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');
    // No image UI in model mode: the model pane (not the photo intake) owns setup.
    await expect(builder(page, 'product-model')).toBeVisible();
    await expect(page.locator('[data-builder-hook="product-photo-disclosure"]')).toBeHidden();
    // Two-click surface reference + millimetres, then a named surface area.
    const modelPane = builder(page, 'product-model');
    await expect(modelPane).toBeVisible();
    await expect(builder(page, 'product-model-status')).toContainText('for reference');
    const setupHost = builder(page, 'model-setup');
    await expect(setupHost.locator('[data-model-setup-hook="pending-banner"]')).toContainText('pending review');
    const canvas = modelPane.locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const surfaceClick = async (fx: number, fy: number) => {
      await canvas.scrollIntoViewIfNeeded();
      const box = (await canvas.boundingBox())!;
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    };
    const ms = (name: string) => modelPane.locator(`[data-model-setup-hook="${name}"]`);
    await ms('ref-pick-a').click();
    await surfaceClick(0.5, 0.5);
    await expect(ms('reference-readout')).toContainText('A (');
    await surfaceClick(0.6, 0.5);
    await expect(ms('reference-readout')).toContainText('B (');
    await ms('ref-mm').fill('470');
    await ms('ref-fit').click();
    await expect(ms('reference-scale')).toContainText('scale 1 unit =');
    await ms('area-name').fill('Chest');
    await ms('tool-freehand').click();
    await surfaceClick(0.44, 0.44);
    await surfaceClick(0.56, 0.44);
    await surfaceClick(0.56, 0.52);
    await surfaceClick(0.44, 0.52);
    await ms('area-finish').click();
    await expect(ms('area-list')).toContainText('Chest');
    await (await shown(page, 'model-setup-save')).click();
    await expect(builder(page, 'model-setup-status')).toContainText('Saved 3D setup');
    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    // Exact saved model calibration maps artwork onto the product, without
    // requiring a photograph or changing the canonical region millimetres.
    await expect(host).toContainText('Place logos on the product');
    await expect(host.locator('[data-placement-hook="pw-model-canvas"]')).toBeVisible();
    await expect(host.locator('[data-placement-hook="pw-overlay-image"]')).toHaveCount(0);
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'crest' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption('print');
    await pw(page, 'pw-add-width').fill('60');
    await pw(page, 'pw-add-height').fill('30');
    await pw(page, 'pw-add-confirm').click();
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('crest');
    // No measurement bindings exist for model placements, so review stays
    // honestly incomplete: complete print disabled, marked draft available.
    await host.getByRole('button', { name: 'Review document' }).click();
    await expect(page.locator('[data-job-step="review"]')).toBeVisible();
    const reviewHost = builder(page, 'job-review-host');
    await expect(reviewHost).toContainText(/unfinished|no anchor bindings/i);
    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeDisabled();
    await expect(reviewHost.getByRole('button', { name: 'Print draft' })).toBeEnabled();
    await expect(reviewHost.locator('[data-doc-review-preview]')).toContainText(/DRAFT/i);
    // Save and reopen keeps the exact model geometry with no photo involved.
    const jobPath = await downloadTo(page, builder(page, 'job-save'), info.outputPath('job-model.logo-project'));
    const freshContext = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
    const fresh = await freshContext.newPage();
    const freshProbe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
    fresh.on('pageerror', (error) => freshProbe.pageErrors.push(String(error)));
    fresh.on('console', (message) => {
      if (message.type() === 'error') freshProbe.consoleErrors.push(message.text());
    });
    freshContext.on('request', (request) => {
      if (/^https?:/i.test(request.url())) freshProbe.networkRequests.push(request.url());
    });
    try {
      await gotoBuilder(fresh);
      await fresh.locator('[data-builder-hook="job-landing-open"]').click();
      await fresh.locator('[data-builder-hook="job-open-file"]').setInputFiles(jobPath);
      await expect(fresh.locator('[data-job-step="prepare"]')).toBeVisible();
      await fresh.locator('[data-builder-hook="job-to-placements"]').click();
      const freshHost = fresh.locator('[data-builder-hook="job-placement-host"]');
      expect(await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(1);
      await expect(freshHost).toContainText('Place logos on the product');
      await expect(freshHost.locator('[data-placement-hook="pw-model-workbench"]')).toHaveAttribute('data-artwork-count', /[1-9]/);
      expectOfflineClean(freshProbe);
    } finally {
      await freshContext.close();
    }
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});
