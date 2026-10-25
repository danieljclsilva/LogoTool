import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { gotoBuilder, revealBuilderControl, revealCustomerControl, selectCustomerOption } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';

// Setup-calibration acceptance (W3-owned): photo-based Images setup on the
// real station, model-only 3D calibration through a self-contained harness
// (real ModelViewer + new model-setup-view, synthetic GLB, no images), and
// prepared-master save/reopen retention. Offline file:// throughout; every
// test asserts zero console/page errors and zero HTTP(S) requests, with
// desktop 1280x900 + mobile 390x844 evidence where the flow is viewport
// sensitive. Synthetic fixtures only; nothing here is production approval.

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

function modelSetup(page: Page, name: string) {
  return page.locator(`[data-model-setup-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return ['builder-next', 'builder-back'].includes(name)
    ? builder(page, name).filter({ visible: true }).first()
    : builder(page, name);
}

/** Scope for the optional customer-approval branch UI (§7 of the UX spec). */
function approval(page: Page) {
  return page.locator('[data-customer-approval]');
}

/** Enter the approval branch from placements and issue the current job
 * (branch-scoped buttons only: legacy generate/download hooks are gone). */
async function createBranchIssue(page: Page): Promise<void> {
  await (await shown(page, 'job-to-placements')).click();
  await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
  await builder(page, 'job-placement-host').getByRole('button', { name: 'Send for customer approval' }).click();
  await expect(approval(page)).toBeVisible();
  await (await shown(page, 'job-issue-project-new')).click();
  await approval(page).getByRole('button', { name: 'Create customer file', exact: true }).click();
  await expect(approval(page)).toContainText('Customer file created');
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

/** Stage one Images view through the real intake row (label + file). */
async function stageIntakeImage(page: Page, label: string, fileName: string, bytes: Uint8Array): Promise<void> {
  // Reveal first: opening a saved project folds the intake disclosure, and
  // its rows are unreachable while folded.
  await shown(page, 'product-view-add');
  const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
  await rows.first().locator('input[type="text"]').fill(label);
  await rows.first().locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(rows.first().locator('.view-row-state')).toContainText('ready');
}

/** Stage a 3D model through the real Images/3D toggle (model panel). */
async function stageIntakeModel(page: Page, fileName: string, bytes: Uint8Array): Promise<void> {
  await (await shown(page, 'intake-mode-model')).check();
  await (await shown(page, 'product-file')).setInputFiles({ name: fileName, mimeType: 'model/gltf-binary', buffer: Buffer.from(bytes) });
  await expect(await shown(page, 'intake-model-status')).toContainText('ready');
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

interface HarnessSnapshot {
  productId: string;
  reference: { id: string; a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number }; lengthMm: number } | null;
  mmPerUnit: number | null;
  areas: Array<{ id: string; name: string; points: Array<{ x: number; y: number; z: number }>; status: string }>;
}

async function assertHarness(page: Page): Promise<void> {
  await page.evaluate((): void => {
    const api = (window as unknown as { __setupHarness: unknown }).__setupHarness;
    if (!api) throw new Error('setup-calibration harness not mounted.');
  });
}

/** Call one harness method in-page (proxied objects lose functions across evaluate). */
async function hCall<R>(page: Page, method: string, arg?: string): Promise<R> {
  return page.evaluate(
    ([name, value]): R => {
      const api = (window as unknown as { __setupHarness: Record<string, (input?: string) => R> }).__setupHarness;
      const fn = api[name];
      if (typeof fn !== 'function') throw new Error(`harness has no method ${name}.`);
      return fn(value);
    },
    [method, arg] as [string, string | undefined],
  );
}

/** Build the self-contained harness page (repo-local esbuild, inlined IIFE). */
async function openHarness(browser: Browser, viewport: { width: number; height: number }, fileName: string): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  const entry = resolve(process.cwd(), 'e2e/fixtures/setup-calibration-harness.ts');
  const bundled = buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const js = String(bundled.outputFiles[0]!.text).replace(/<\/script/gi, '<\\/script');
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>setup-calibration harness</title><style>' +
    '*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif}' +
    '#stage{width:min(720px,100%);height:60vh;min-height:320px;border:1px solid #ccc}' +
    '#stage canvas{width:100%;height:100%;display:block}' +
    '#setup{padding:8px}.muted{color:#555}' +
    '</style></head><body><div id="stage"><canvas id="gl"></canvas></div>' +
    '<div id="setup"></div><script>' + js + '</script></body></html>';
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
  const outputPath = test.info().outputPath(fileName);
  await writeFile(outputPath, html);
  await page.goto(pathToFileURL(outputPath).href);
  await expect(modelSetup(page, 'pending-banner')).toContainText('pending review');
  return { context, page, probe };
}

async function harnessClick(page: Page, fx: number, fy: number): Promise<void> {
  // The canvas must be inside the viewport: clicking a panel button below
  // the stage scrolls it out of view, and viewport-space clicks above the
  // fold hit no element at all (silent no-op, never a surface pick).
  await page.locator('#gl').scrollIntoViewIfNeeded();
  const box = await page.evaluate((): { x: number; y: number; width: number; height: number } => {
    const api = (window as unknown as { __setupHarness: { canvasBox(): { x: number; y: number; width: number; height: number } | null } }).__setupHarness;
    const rect = api.canvasBox();
    if (!rect) throw new Error('harness canvas has no box.');
    return rect;
  });
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

/** Fill a customer numeric field the way a human tabs out (commits change). */
async function setCustomerNumber(page: Page, hook: string, value: number): Promise<void> {
  await revealCustomerControl(page, hook);
  await page.locator(`[data-customer-hook="${hook}"]`).fill(String(value));
  await page.locator(`[data-customer-hook="${hook}"]`).press('Tab');
}

test('images setup: guided measure + mm + safe area + anchors + tool toggles + atomic save', async ({ browser }, info) => {
  test.setTimeout(180_000);
  for (const viewport of VIEWPORTS) {
    const { context, page, probe } = await openStation(browser, viewport);
    try {
      await attachEnv(info, browser, viewport, 'station images setup');
      await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();

      const frontPng = await syntheticPngBytes(page, '#1d6f3a');
      await stageIntakeImage(page, 'Front', 'front.png', frontPng);
      await (await shown(page, 'product-name')).fill('Setup Jacket');
      await (await shown(page, 'product-add')).click();
      await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Setup Jacket');

      const workspace = builder(page, 'product-workspace');
      await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
      // Stable view identity: the tab hook keys on the view id (never label).
      await expect(workspace.locator('[data-fkey="psv-tab-view-1"]')).toBeVisible();
      await expect(workspace.getByText('has no scale mapping yet')).toBeVisible();
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

      // Anchor tool: place one anchor on the actual photo and rename it.
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
      await workspace.locator('[data-fkey^="psv-anchor-name-"]').fill('Chest center');
      await workspace.locator('[data-fkey^="psv-anchor-name-"]').press('Tab');
      await expect(workspace.getByText('Renamed anchor to “Chest center”.')).toBeVisible();

      // Tool toggles: Safe area ⇄ Anchor both stay available, data preserved.
      await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
      await expect(workspace.getByRole('button', { name: 'Safe area (4)', exact: true })).toBeVisible();
      await workspace.getByRole('button', { name: 'Anchor (1)', exact: true }).click();
      await expect(workspace.getByRole('button', { name: /Anchor \(1\)/ })).toBeVisible();

      // ONE atomic save persists the measured safe area + anchor together.
      await workspace.getByRole('button', { name: 'Save product setup' }).click();
      await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 1 anchors\)/)).toBeVisible();
      await expect(await shown(page, 'workspace-status')).toContainText('4 safe-area corners, 1 anchors');

      const shotPath = info.outputPath(`images-setup-${viewport.label}.png`);
      await page.screenshot({ path: shotPath });
      await info.attach(`images-setup-${viewport.label}`, { path: shotPath, contentType: 'image/png' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      expectOfflineClean(probe);
    } finally {
      await context.close();
    }
  }
});

test('model-only 3D calibration: A/B surface picks + mm + named area + toggles (no images)', async ({ browser }, info) => {
  test.setTimeout(180_000);
  for (const viewport of VIEWPORTS) {
    const { context, page, probe } = await openHarness(browser, viewport, `setup-harness-${viewport.label}.html`);
    try {
      await attachEnv(info, browser, viewport, 'model-only setup-calibration harness');
      await assertHarness(page);
      expect(await hCall<string>(page, 'attachKind')).toBe('empty');
      const glbBase64 = Buffer.from(cubeGlb()).toString('base64');
      expect(await hCall<string>(page, 'loadGlb', glbBase64)).toBe('ready');

      // Coincident picks are rejected before any valid fit.
      await modelSetup(page, 'ref-pick-a').click();
      await harnessClick(page, 0.5, 0.5);
      await expect(modelSetup(page, 'reference-readout')).toContainText('A (');
      await harnessClick(page, 0.5, 0.5);
      await modelSetup(page, 'ref-mm').fill('100');
      await modelSetup(page, 'ref-fit').click();
      await expect(modelSetup(page, 'status')).toContainText('coincide');

      // Distinct surface picks + real millimetres fit a uniform scale.
      await modelSetup(page, 'ref-pick-b').click();
      await harnessClick(page, 0.58, 0.5);
      await expect(modelSetup(page, 'reference-readout')).toContainText('B (');
      await modelSetup(page, 'ref-fit').click();
      await expect(modelSetup(page, 'reference-scale')).toContainText('scale 1 unit =');

      // Invalid millimetre entries are refused without losing the picks.
      await modelSetup(page, 'ref-mm').fill('0');
      await modelSetup(page, 'ref-fit').click();
      await expect(modelSetup(page, 'status')).toContainText('> 0');
      await expect(modelSetup(page, 'reference-readout')).toContainText('A (');
      await modelSetup(page, 'ref-mm').fill('100');
      await modelSetup(page, 'ref-fit').click();
      await expect(modelSetup(page, 'reference-scale')).toContainText('scale 1 unit =');
      const fittedScale = (await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.mmPerUnit ?? null;
      assert.ok(typeof fittedScale === 'number' && fittedScale > 0, 'fitted mm-per-unit is positive');
      expect((await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.reference?.lengthMm).toBe(100);

      // Named safe area from surface picks; plane established, current fit.
      await modelSetup(page, 'area-name').fill('Left chest');
      await modelSetup(page, 'area-start').click();
      await harnessClick(page, 0.42, 0.42);
      await harnessClick(page, 0.58, 0.42);
      await harnessClick(page, 0.58, 0.58);
      await harnessClick(page, 0.42, 0.58);
      await modelSetup(page, 'area-finish').click();
      await expect(modelSetup(page, 'area-list')).toContainText('Left chest');
      await expect(modelSetup(page, 'area-list')).toContainText('(4 pts');
      const snapshot = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
      assert.ok(snapshot && snapshot.areas.length === 1 && snapshot.areas[0]!.points.length === 4, 'one 4-point area staged');
      expect(snapshot.areas[0]!.status).toBe('current');

      // Visibility toggles are display-only: staged data is preserved.
      await modelSetup(page, 'toggle-anchors').click();
      expect(await hCall<boolean>(page, 'anchorsVisible')).toBe(false);
      await modelSetup(page, 'toggle-anchors').click();
      expect(await hCall<boolean>(page, 'anchorsVisible')).toBe(true);
      await modelSetup(page, 'toggle-safe').click();
      expect(await hCall<boolean>(page, 'safeAreasVisible')).toBe(false);
      await modelSetup(page, 'toggle-safe').click();
      expect(await hCall<boolean>(page, 'safeAreasVisible')).toBe(true);
      const afterToggle = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
      assert.ok(afterToggle?.reference && afterToggle.areas.length === 1, 'toggles preserve staged data');

      const shotPath = info.outputPath(`model-setup-${viewport.label}.png`);
      await page.screenshot({ path: shotPath });
      await info.attach(`model-setup-${viewport.label}`, { path: shotPath, contentType: 'image/png' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      expectOfflineClean(probe);
    } finally {
      await context.close();
    }
  }
});

test('images span setup: two-click reference + drawn area + atomic save creates region', async ({ browser }, info) => {
  test.setTimeout(180_000);
  for (const viewport of VIEWPORTS) {
    const { context, page, probe } = await openStation(browser, viewport);
    try {
      await attachEnv(info, browser, viewport, 'station images span setup');
      await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
      const frontPng = await syntheticPngBytes(page, '#8f2a4d');
      await stageIntakeImage(page, 'Front', 'front.png', frontPng);
      await (await shown(page, 'product-name')).fill('Span Jacket');
      await (await shown(page, 'product-add')).click();
      await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Span Jacket');

      // Primary flow: two clicks A/B on the actual photo + real millimetres.
      const workspace = builder(page, 'product-workspace');
      await workspace.getByRole('button', { name: 'Set up scale' }).click();
      const guided = builder(page, 'guided-scale');
      await expect(guided).toBeVisible();
      const spanOverlay = guided.locator('[data-guided="span-overlay"]');
      await expect(spanOverlay).toBeVisible();
      const spanBox = (await spanOverlay.boundingBox())!;
      const spanClick = async (fx: number, fy: number) => {
        await spanOverlay.click({ position: { x: Math.round(spanBox.width * fx), y: Math.round(spanBox.height * fy) } });
      };
      await spanClick(0.3, 0.5);
      await spanClick(0.7, 0.5);
      await guided.locator('[data-guided="span-mm"]').fill('1300');
      await guided.locator('[data-guided="span-create"]').click();
      await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');

      // No safe polygon was invented: draw one explicitly by clicking the
      // photo, finish it, then save once.
      const stage = workspace.locator('.product-setup-overlay').first();
      await expect(workspace.getByText('Safe areas (none yet)')).toBeVisible();
      // Re-measure and scroll before EVERY corner: each click re-renders and
      // restores focus, which scrolls — stale viewport boxes click thin air.
      const drawClick = async (fx: number, fy: number) => {
        await stage.scrollIntoViewIfNeeded();
        const box = (await stage.boundingBox())!;
        await stage.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
      };
      await drawClick(0.3, 0.3);
      await drawClick(0.7, 0.3);
      await drawClick(0.7, 0.7);
      await drawClick(0.3, 0.7);
      await workspace.getByRole('button', { name: 'Finish safe area' }).click();
      await workspace.getByRole('button', { name: 'Save product setup' }).click();
      await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();

      // The master carries the calibration record, the span sidecar and the
      // created region + mapping — all deterministic and pending review.
      const masterEvent = page.waitForEvent('download');
      await (await shown(page, 'save-master')).click();
      await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
      const master = await masterEvent;
      const masterPath = info.outputPath(`span-setup-master-${viewport.label}.logo-project`);
      await master.saveAs(masterPath);
      const parsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
      const product = parsed.project.products[0]!;
      // Span evidence is keyed per photo scope (manifest entries always carry
      // their variant): match by prefix/suffix and assert the linkage, not
      // literal ids.
      const calibration = product.calibrations.find((entry) => entry.id.startsWith('cal-span-view-1'));
      assert.ok(calibration, 'master must carry the span calibration record');
      expect(calibration.version).toBe('1');
      assert.ok(calibration.description?.includes('Front'), 'calibration names the photo view');
      const sidecar = parsed.assets.find((asset) => /\/view-1\..*\.images\.json$/.test(asset.path));
      assert.ok(sidecar, 'master must carry the span sidecar');
      const sidecarJson = JSON.parse(Buffer.from(sidecar.bytes).toString('utf8')) as {
        kind: string; calibrationId: string; bundle: { mode: string; spans: unknown[]; mmPerUnit: number };
      };
      expect(sidecarJson.kind).toBe('images');
      expect(sidecarJson.calibrationId).toBe(calibration.id);
      expect(sidecarJson.bundle.mode).toBe('images');
      expect(sidecarJson.bundle.spans).toHaveLength(1);
      assert.ok(sidecarJson.bundle.mmPerUnit > 0, 'sidecar carries a positive fitted scale');
      const region = product.regions.find((entry) => entry.id === 'region-span-1');
      assert.ok(region, 'save must create the span region');
      expect(region.safeArea).toHaveLength(4);
      expect(region.calibrationRef.calibrationId).toBe(calibration.id);

      // Reopen the master fresh: the measured area, safe polygon and
      // calibration return intact.
      const freshContext = await browser.newContext({ offline: true, viewport });
      const fresh = await freshContext.newPage();
      try {
        await gotoBuilder(fresh);
        await fresh.locator('[data-builder-hook="job-open-file"]').setInputFiles(masterPath);
        await expect(builder(fresh, 'source-status')).toContainText('.logo-project');
        const freshWorkspace = builder(fresh, 'product-workspace');
        await expect(freshWorkspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
      } finally {
        await freshContext.close();
      }
      const shotPath = info.outputPath(`images-span-${viewport.label}.png`);
      await page.screenshot({ path: shotPath });
      await info.attach(`images-span-${viewport.label}`, { path: shotPath, contentType: 'image/png' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      expectOfflineClean(probe);
    } finally {
      await context.close();
    }
  }
});

test('images two named areas: draw, rename, save, reopen, issue, customer places in both', async ({ browser }, info) => {
  test.setTimeout(240_000);
  for (const viewport of VIEWPORTS) {
    const { context, page, probe } = await openStation(browser, viewport);
    try {
      await attachEnv(info, browser, viewport, 'station two named image areas');
      await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
      const frontPng = await syntheticPngBytes(page, '#5a2a6f');
      await stageIntakeImage(page, 'Front', 'front.png', frontPng);
      await (await shown(page, 'product-name')).fill('Two Area Jacket');
      await (await shown(page, 'product-add')).click();
      await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Two Area Jacket');

      const workspace = builder(page, 'product-workspace');
      await workspace.getByRole('button', { name: 'Set up scale' }).click();
      const guided = builder(page, 'guided-scale');
      const spanOverlay = guided.locator('[data-guided="span-overlay"]');
      const spanBox = (await spanOverlay.boundingBox())!;
      await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.3), y: Math.round(spanBox.height * 0.5) } });
      await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.7), y: Math.round(spanBox.height * 0.5) } });
      await guided.locator('[data-guided="span-mm"]').fill('1300');
      await guided.locator('[data-guided="span-create"]').click();
      await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');

      // Draw TWO named areas, renaming each explicitly. (Identical-polygon
      // twins cannot be drawn by mouse — clicks land on the existing
      // area's corner handles by design — so same-shape survival is proven
      // at the contract level in workspace-named-areas.test.ts instead:
      // sibling ids derive from stable area ids, never coordinates, and the
      // explicit active hint disambiguates without comparing polygons.)
      const stage = workspace.locator('.product-setup-overlay').first();
      const drawQuad = async (x0: number, x1: number) => {
        for (const [fx, fy] of [[x0, 0.3], [x1, 0.3], [x1, 0.7], [x0, 0.7]] as const) {
          await stage.scrollIntoViewIfNeeded();
          const box = (await stage.boundingBox())!;
          await stage.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
        }
        await workspace.getByRole('button', { name: 'Finish safe area' }).click();
      };
      const renameActive = async (name: string) => {
        await workspace.locator('[data-fkey^="psv-area-name-"]').fill(name);
        await workspace.locator('[data-fkey^="psv-area-name-"]').press('Tab');
        await expect(workspace.getByText(`Renamed area to “${name}”.`)).toBeVisible();
      };
      await drawQuad(0.08, 0.28);
      await renameActive('Left chest');
      await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
      await drawQuad(0.72, 0.92);
      await renameActive('Right chest');
      // The second finished area is active; make it explicit all the same.
      await workspace.getByRole('button', { name: 'Right chest', exact: true }).click();

      await workspace.getByRole('button', { name: 'Save product setup' }).click();
      await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
      // (The view's async settlement text carries counts only; sibling
      // persistence is proven by the master parse below, not status text.)

      // Master roundtrip: scope region plus the renamed sibling survive with
      // exact polygons; the active area is the scope polygon on reopen.
      const masterEvent = page.waitForEvent('download');
      await (await shown(page, 'save-master')).click();
      await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
      const master = await masterEvent;
      const masterPath = info.outputPath(`two-areas-master-${viewport.label}.logo-project`);
      await master.saveAs(masterPath);
      const parsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
      const product = parsed.project.products[0]!;
      // Scope holds the FIRST-drawn area (selection-independent binding);
      // the twin persists as a sibling with an identical polygon but its own
      // id and name — coordinates alone could never tell them apart.
      const scopeRegion = product.regions.find((entry) => entry.id === 'region-span-1');
      assert.ok(scopeRegion, 'master must carry the scope region');
      expect(scopeRegion.name).toBe('Left chest');
      expect(scopeRegion.safeArea).toHaveLength(4);
      const siblings = product.regions.filter((entry) => entry.id.startsWith('region-span-1--area-'));
      expect(siblings).toHaveLength(1);
      expect(siblings[0]!.name).toBe('Right chest');
      expect(siblings[0]!.safeArea).toHaveLength(4);
      expect(JSON.stringify(siblings[0]!.safeArea)).not.toBe(JSON.stringify(scopeRegion.safeArea));
      expect(siblings[0]!.calibrationRef).toEqual(scopeRegion.calibrationRef);
      // Explicit active-area hint survives identical polygons.
      const activeRaw = parsed.assets.find((asset) => asset.path.endsWith('/active-areas.json'));
      assert.ok(activeRaw, 'master must carry the active-area hint');
      const activeHint = JSON.parse(Buffer.from(activeRaw.bytes).toString('utf8')) as {
        version: string; scopes: Record<string, string>;
      };
      expect(activeHint.version).toBe('active-areas/1');
      const hintedId = activeHint.scopes['region-span-1'];
      assert.ok(typeof hintedId === 'string' && hintedId.length > 0, 'active id recorded for the scope');

      const freshContext = await browser.newContext({ offline: true, viewport });
      const fresh = await freshContext.newPage();
      try {
        await gotoBuilder(fresh);
        await fresh.locator('[data-builder-hook="job-open-file"]').setInputFiles(masterPath);
        await expect(builder(fresh, 'source-status')).toContainText('.logo-project');
        const freshWorkspace = builder(fresh, 'product-workspace');
        await freshWorkspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
        const areaPicks = freshWorkspace.locator('[data-fkey^="psv-area-pick-"]');
        await expect(areaPicks).toHaveCount(2);
        // Scope entry first, then persisted siblings by region id; the active
        // row follows the explicit hint, not polygon content.
        await expect(areaPicks).toContainText(['Left chest', 'Right chest']);
        await expect(freshWorkspace.locator('.product-setup-row.is-selected')).toContainText('Right chest');
      } finally {
        await freshContext.close();
      }

      // Issue with one logo: BOTH areas must reach the customer artifact as
      // usable placement options, and the customer places in each.
      const logoPng = await syntheticPngBytes(page, '#c8a028');
      await (await shown(page, 'logo-file')).setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: Buffer.from(logoPng) });
      await expect(await shown(page, 'logo-status')).toContainText('Added mark.png');
      const checkAll = async (listHook: string) => {
        await builder(page, listHook).locator('input[type="checkbox"]').evaluateAll((nodes) => {
          for (const node of nodes) {
            const box = node as HTMLInputElement;
            if (!box.checked) {
              box.checked = true;
              box.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        });
      };
      await checkAll('product-list');
      await checkAll('logo-list');
      await (await shown(page, 'job-step-1')).click();
      await (await shown(page, 'customer-name')).fill('Two Areas Co');
      await (await shown(page, 'job-ref')).fill(`TWO-AREAS-${viewport.label}`);
      await (await shown(page, 'issued-by')).fill('Lead check');
      await createBranchIssue(page);
      const baselineEvent = page.waitForEvent('download');
      await approval(page).getByRole('button', { name: 'Save office copy', exact: true }).click();
      const baselineDownload = await baselineEvent;
      const baselinePath = info.outputPath(`two-areas-issued-${viewport.label}.logo-project`);
      await baselineDownload.saveAs(baselinePath);
      const issued = await parseProjectPackage(new Uint8Array(await readFile(baselinePath)), { sha256 });
      const issuedProduct = issued.project.products[0]!;
      const issuedNames = issuedProduct.regions.map((entry) => entry.name ?? entry.id).sort();
      expect(issuedNames).toEqual(['Left chest', 'Right chest']);
      // Every issued region carries its actual photo mapping (customer binds
      // photo preview per regionId — no region may fall back silently).
      const issuedMappingsRaw = issued.assets.find((asset) => asset.path === 'presentation/photo-mappings.json');
      assert.ok(issuedMappingsRaw, 'issued package must carry photo mappings');
      const issuedMappings = JSON.parse(Buffer.from(issuedMappingsRaw.bytes).toString('utf8')) as {
        mappings: Array<{ regionId: string; image: string }>;
      };
      for (const region of issuedProduct.regions) {
        assert.ok(
          issuedMappings.mappings.some((entry) => entry.regionId === region.id),
          `issued mappings must cover region ${region.id}`,
        );
      }
      const issuedConfig = issued.project.configurations[0]!;
      const issuedLogo = issued.project.logos[0]!;
      const customerEvent = page.waitForEvent('download');
      await approval(page).getByRole('button', { name: 'Save customer file', exact: true }).click();
      const customerDownload = await customerEvent;
      const customerPath = info.outputPath(`two-areas-customer-${viewport.label}.html`);
      await customerDownload.saveAs(customerPath);

      const customerContext = await browser.newContext({ offline: true, viewport });
      const customerPage = await customerContext.newPage();
      const customerProbe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
      customerPage.on('pageerror', (error) => customerProbe.pageErrors.push(String(error)));
      customerPage.on('console', (message) => {
        if (message.type() === 'error') customerProbe.consoleErrors.push(String(message.text()));
      });
      customerContext.on('request', (request) => {
        if (/^https?:/i.test(request.url())) customerProbe.networkRequests.push(request.url());
      });
      try {
        await customerPage.goto(pathToFileURL(customerPath).href);
        const customer = (name: string) => customerPage.locator(`[data-customer-hook="${name}"]`);
        await expect(customer('project-id')).toHaveText(issued.project.projectId);
        await selectCustomerOption(customerPage, 'configuration', issuedConfig.id);
        const regionOptions = customer('region').locator('option');
        await expect(regionOptions).toHaveCount(2);
        await expect(customer('region')).toContainText('Left chest');
        await expect(customer('region')).toContainText('Right chest');
        // Place one logo in EACH area: both are usable, both fit.
        const placeIn = async (regionId: string, cx: number, cy: number) => {
          await selectCustomerOption(customerPage, 'region', regionId);
          await selectCustomerOption(customerPage, 'logo', issuedLogo.id);
          await selectCustomerOption(customerPage, 'method', 'embroidery');
          await setCustomerNumber(customerPage, 'x-mm', Math.round(cx));
          await setCustomerNumber(customerPage, 'y-mm', Math.round(cy));
          await setCustomerNumber(customerPage, 'width-mm', 60);
          await setCustomerNumber(customerPage, 'height-mm', 30);
          await revealCustomerControl(customerPage, 'rotation');
          await customer('rotation').fill('0');
          await revealCustomerControl(customerPage, 'add');
          await customer('add').click();
          await expect(customer('geometry')).toContainText('Fits: yes');
        };
        const leftRegion = issuedProduct.regions.find((entry) => entry.name === 'Left chest')!;
        const rightRegion = issuedProduct.regions.find((entry) => entry.name === 'Right chest')!;
        const centerOf = (polygon: unknown): [number, number] => {
          assert.ok(Array.isArray(polygon) && polygon.length > 0, 'expected a saved polygon');
          let sx = 0;
          let sy = 0;
          for (const point of polygon as Array<[number, number]>) {
            sx += point[0];
            sy += point[1];
          }
          return [sx / (polygon as unknown[]).length, sy / (polygon as unknown[]).length];
        };
        await placeIn(leftRegion.id, ...centerOf(leftRegion.safeArea));
        await customer('add-another').click();
        await placeIn(rightRegion.id, ...centerOf(rightRegion.safeArea));
        await expect(customer('placement').locator('option')).toHaveCount(3);
        const shotPath = info.outputPath(`two-areas-customer-${viewport.label}.png`);
        await customerPage.screenshot({ path: shotPath });
        await info.attach(`two-areas-customer-${viewport.label}`, { path: shotPath, contentType: 'image/png' });
        // Desktop only: confirm in the LIVE session (placements are
        // in-memory until downloaded) and take the confirmed return file.
        if (viewport.label === 'desktop') {
          await revealCustomerControl(customerPage, 'confirmed-by');
          await customer('confirmed-by').fill('Area reviewer');
          await revealCustomerControl(customerPage, 'confirm');
          await customer('confirm').click();
          await expect(customer('confirmation')).toContainText('Confirmed: version');
          const returnEvent = customerPage.waitForEvent('download');
          await revealCustomerControl(customerPage, 'submit');
          await customer('submit').click();
          const returnDownload = await returnEvent;
          const desktopReturnPath = info.outputPath('two-areas-return.logo-project');
          await returnDownload.saveAs(desktopReturnPath);
          const returned = await parseProjectPackage(new Uint8Array(await readFile(desktopReturnPath)), { sha256 });
          expect(returned.project.configurations[0]!.placements).toHaveLength(2);
        }
      } finally {
        await customerContext.close();
      }
      expect(customerProbe.pageErrors).toEqual([]);
      expect(customerProbe.consoleErrors).toEqual([]);
      expect(customerProbe.networkRequests).toEqual([]);
      if (viewport.label === 'desktop') {
        // Reopen the RETURN as a source project: both placements are office
        // state now. Deleting the referenced second area must retire its
        // region (not remove it, not keep stale geometry).
        await page.locator('[data-builder-hook="job-open-file"]').setInputFiles(info.outputPath('two-areas-return.logo-project'));
        // Retained replacement guard (Journey E): Discard reproduces the old
        // silent replace before asserting the reopen.
        await expect(builder(page, 'builder-alert')).toContainText('unsaved changes');
        await builder(page, 'builder-alert').getByRole('button', { name: 'Discard changes' }).click();
        await expect(await shown(page, 'source-status')).toContainText('.logo-project');
        const returnWorkspace = builder(page, 'product-workspace');
        await returnWorkspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
        await returnWorkspace.getByRole('button', { name: 'Right chest', exact: true }).click();
        const twinDelete = returnWorkspace.locator('[data-fkey^="psv-area-delete-"]');
        await twinDelete.click();
        await expect(returnWorkspace.locator('[data-fkey^="psv-area-pick-"]')).toHaveCount(1);
        await returnWorkspace.getByRole('button', { name: 'Save product setup' }).click();
        // (The view's async settlement text carries counts only; the retire
        // is proven by the master parse below, not status text.)
        await expect(returnWorkspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
        const retiredMasterEvent = page.waitForEvent('download');
        await (await shown(page, 'save-master')).click();
        const retiredMaster = await retiredMasterEvent;
        const retiredPath = info.outputPath('two-areas-retired.logo-project');
        await retiredMaster.saveAs(retiredPath);
        const retired = await parseProjectPackage(new Uint8Array(await readFile(retiredPath)), { sha256 });
        const retiredProduct = retired.project.products[0]!;
        const retiredTwin = retiredProduct.regions.find((entry) => entry.name === 'Right chest');
        assert.ok(retiredTwin, 'referenced deleted area stays as a retired region');
        expect(retiredTwin.safeArea).toEqual([]);
        const placementsKept = retired.project.configurations[0]!.placements.filter(
          (entry) => entry.regionId === retiredTwin.id);
        expect(placementsKept).toHaveLength(1);
      }

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      expectOfflineClean(probe);
    } finally {
      await context.close();
    }
  }
});

test('images delete unreferenced area: region and links gone, customer cannot select it', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'station delete unreferenced area');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    const frontPng = await syntheticPngBytes(page, '#6f5a2a');
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-name')).fill('Delete Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Delete Jacket');

    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    const spanOverlay = guided.locator('[data-guided="span-overlay"]');
    const spanBox = (await spanOverlay.boundingBox())!;
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.3), y: Math.round(spanBox.height * 0.5) } });
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.7), y: Math.round(spanBox.height * 0.5) } });
    await guided.locator('[data-guided="span-mm"]').fill('1300');
    await guided.locator('[data-guided="span-create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');

    const stage = workspace.locator('.product-setup-overlay').first();
    const drawQuad = async (x0: number, x1: number) => {
      for (const [fx, fy] of [[x0, 0.3], [x1, 0.3], [x1, 0.7], [x0, 0.7]] as const) {
        await stage.scrollIntoViewIfNeeded();
        const box = (await stage.boundingBox())!;
        await stage.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
      }
      await workspace.getByRole('button', { name: 'Finish safe area' }).click();
    };
    await drawQuad(0.08, 0.28);
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    await drawQuad(0.72, 0.92);
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();

    // Delete the second (sibling) area with no placements anywhere: its
    // region and variant links must vanish — a real delete.
    await workspace.getByRole('button', { name: /Area 2/ }).first().click();
    await workspace.locator('[data-fkey^="psv-area-delete-"]').click();
    await expect(workspace.locator('[data-fkey^="psv-area-pick-"]')).toHaveCount(1);
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    // The view's async settlement text carries counts only; the removal is
    // proven by the master parse below.
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
    const masterPath = info.outputPath('delete-area-master.logo-project');
    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    const master = await masterEvent;
    await master.saveAs(masterPath);
    const parsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    const product = parsed.project.products[0]!;
    expect(product.regions).toHaveLength(1);
    expect(product.regions[0]!.id).toBe('region-span-1');
    for (const variant of product.variants) {
      expect(variant.regionIds).toEqual(['region-span-1']);
    }

    // Issue with one logo: the customer offers exactly the surviving area —
    // the removed one cannot be selected.
    const logoPng = await syntheticPngBytes(page, '#c8a028');
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: Buffer.from(logoPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added mark.png');
    await (await shown(page, 'job-step-1')).click();
    await builder(page, 'product-list').locator('input[type="checkbox"]').evaluateAll((nodes) => {
      for (const node of nodes) {
        const box = node as HTMLInputElement;
        if (!box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    await builder(page, 'logo-list').locator('input[type="checkbox"]').evaluateAll((nodes) => {
      for (const node of nodes) {
        const box = node as HTMLInputElement;
        if (!box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    await (await shown(page, 'job-step-1')).click();
    await (await shown(page, 'customer-name')).fill('Delete Co');
    await (await shown(page, 'job-ref')).fill('DELETE-AREA-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await createBranchIssue(page);
    const customerEvent = page.waitForEvent('download');
    await approval(page).getByRole('button', { name: 'Save customer file', exact: true }).click();
    const customerDownload = await customerEvent;
    const customerPath = info.outputPath('delete-area-customer.html');
    await customerDownload.saveAs(customerPath);
    const customerContext = await browser.newContext({ offline: true, viewport });
    const customerPage = await customerContext.newPage();
    try {
      await customerPage.goto(pathToFileURL(customerPath).href);
      const customer = (name: string) => customerPage.locator(`[data-customer-hook="${name}"]`);
      await expect(customer('project-id')).toBeAttached();
      const options = customer('region').locator('option');
      await expect(options).toHaveCount(1);
    } finally {
      await customerContext.close();
    }
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('images setup edit invalidates generated outputs: download disabled until regenerate', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'setup edit invalidates generated outputs');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    const frontPng = await syntheticPngBytes(page, '#2a6f5a');
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-name')).fill('Stale Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Stale Jacket');

    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    const spanOverlay = guided.locator('[data-guided="span-overlay"]');
    const spanBox = (await spanOverlay.boundingBox())!;
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.3), y: Math.round(spanBox.height * 0.5) } });
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.7), y: Math.round(spanBox.height * 0.5) } });
    await guided.locator('[data-guided="span-mm"]').fill('1300');
    await guided.locator('[data-guided="span-create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');

    const stage = workspace.locator('.product-setup-overlay').first();
    for (const [fx, fy] of [[0.2, 0.3], [0.5, 0.3], [0.5, 0.7], [0.2, 0.7]] as const) {
      await stage.scrollIntoViewIfNeeded();
      const box = (await stage.boundingBox())!;
      await stage.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
    }
    await workspace.getByRole('button', { name: 'Finish safe area' }).click();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();

    // Issue a customer file in the branch: the download gate opens.
    const logoPng = await syntheticPngBytes(page, '#c8a028');
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: Buffer.from(logoPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added mark.png');
    await (await shown(page, 'job-step-1')).click();
    for (const listHook of ['product-list', 'logo-list']) {
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
    await (await shown(page, 'job-step-1')).click();
    await (await shown(page, 'customer-name')).fill('Stale Co');
    await (await shown(page, 'job-ref')).fill('STALE-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await createBranchIssue(page);
    await expect(approval(page).getByRole('button', { name: 'Save customer file', exact: true })).toBeEnabled();

    // Edit the setup (rename + save commits a new source package): the old
    // generated delivery must go stale — download disabled until regen.
    await (await shown(page, 'job-step-1')).click();
    await workspace.locator('[data-fkey^="psv-area-name-"]').fill('Stale chest v2');
    await workspace.locator('[data-fkey^="psv-area-name-"]').press('Tab');
    await expect(workspace.getByText('Renamed area to “Stale chest v2”.')).toBeVisible();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
    await (await shown(page, 'job-step-2')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await builder(page, 'job-placement-host').getByRole('button', { name: 'Send for customer approval' }).click();
    await expect(approval(page)).toContainText('Previously saved files are stale');
    await expect(approval(page).getByRole('button', { name: 'Save customer file', exact: true })).toBeDisabled();
    await expect(approval(page).getByRole('button', { name: 'Save office copy', exact: true })).toBeDisabled();

    // Regenerate under a fresh issue ID: the gate reopens and the download
    // carries the new area name.
    await (await shown(page, 'job-issue-project-new')).click();
    await approval(page).getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(approval(page)).toContainText('Customer file created');
    await expect(approval(page).getByRole('button', { name: 'Save customer file', exact: true })).toBeEnabled();
    const customerEvent = page.waitForEvent('download');
    await approval(page).getByRole('button', { name: 'Save customer file', exact: true }).click();
    const customerDownload = await customerEvent;
    const customerPath = info.outputPath('stale-regenerated-customer.html');
    await customerDownload.saveAs(customerPath);
    const customerContext = await browser.newContext({ offline: true, viewport });
    const customerPage = await customerContext.newPage();
    try {
      await customerPage.goto(pathToFileURL(customerPath).href);
      await expect(customerPage.locator('[data-customer-hook="region"]')).toContainText('Stale chest v2');
    } finally {
      await customerContext.close();
    }
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('images span span-reference retires on photo replacement, no stale calibration reuse', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'span evidence retires on photo replace');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    const frontPng = await syntheticPngBytes(page, '#7a3a5a');
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-name')).fill('Replace Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Replace Jacket');

    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    const spanOverlay = guided.locator('[data-guided="span-overlay"]');
    const spanBox = (await spanOverlay.boundingBox())!;
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.3), y: Math.round(spanBox.height * 0.5) } });
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.7), y: Math.round(spanBox.height * 0.5) } });
    await guided.locator('[data-guided="span-mm"]').fill('1300');
    await guided.locator('[data-guided="span-create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');

    // Replace the same view image through its real in-place row: mapping AND
    // span sidecar retire, the new photo starts unmeasured, and no stale
    // calibration is reused.
    const frontPng2 = await syntheticPngBytes(page, '#3a7a5a');
    await page.locator('[data-in-place-view="view-1"] input[type="file"]').setInputFiles({ name: 'front-v2.png', mimeType: 'image/png', buffer: Buffer.from(frontPng2) });
    await expect(await shown(page, 'product-photo-status')).toContainText('Replaced view image \u201cFront\u201d on');
    await expect(await shown(page, 'product-photo-status')).toContainText('span reference was retired');
    await expect(workspace.getByText('has no scale mapping yet')).toBeVisible();
    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master = await masterEvent;
    const masterPath = info.outputPath('span-replaced-master.logo-project');
    await master.saveAs(masterPath);
    const parsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    assert.ok(
      !parsed.assets.some((asset) => asset.path.endsWith('.images.json')),
      'replaced span sidecar must not survive in the master',
    );
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('images span recalibration from sibling-owned mapping resolves the owning scope', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'span recalibration via sibling mapping');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    const frontPng = await syntheticPngBytes(page, '#4a6a8a');
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-name')).fill('Recal Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Recal Jacket');

    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    const spanOverlay = guided.locator('[data-guided="span-overlay"]');
    const spanBox = (await spanOverlay.boundingBox())!;
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.3), y: Math.round(spanBox.height * 0.5) } });
    await spanOverlay.click({ position: { x: Math.round(spanBox.width * 0.7), y: Math.round(spanBox.height * 0.5) } });
    await guided.locator('[data-guided="span-mm"]').fill('1300');
    await guided.locator('[data-guided="span-create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');

    // Draw TWO areas and save, so a sibling region AND its mapping exist
    // (a lone drawn area becomes the scope area itself, correctly).
    const stage = workspace.locator('.product-setup-overlay').first();
    const drawQuad = async (x0: number, x1: number) => {
      for (const [fx, fy] of [[x0, 0.3], [x1, 0.3], [x1, 0.7], [x0, 0.7]] as const) {
        await stage.scrollIntoViewIfNeeded();
        const box = (await stage.boundingBox())!;
        await stage.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
      }
      await workspace.getByRole('button', { name: 'Finish safe area' }).click();
    };
    await drawQuad(0.2, 0.4);
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    await drawQuad(0.6, 0.8);
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    const master = await masterEvent;
    const masterPath = info.outputPath('recal-master.logo-project');
    await master.saveAs(masterPath);
    const parsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    const siblingId = parsed.project.products[0]!.regions.map((entry) => entry.id)
      .find((id) => id.startsWith('region-span-1--area-'));
    assert.ok(siblingId, 'master must carry a sibling region');

    // Craft the sibling-only state: drop the SCOPE mapping, keep the sibling
    // mapping, repackage byte-valid. No UI can produce this; the station must
    // still route the owning scope (never the sibling id).
    const { createProjectPackage } = await import('../src/packaging/project-package/index.js');
    const mappingsRaw = parsed.assets.find((asset) => asset.path === 'presentation/photo-mappings.json')!;
    const mappingsJson = JSON.parse(Buffer.from(mappingsRaw.bytes).toString('utf8')) as {
      version: 1; mappings: Array<Record<string, unknown>>;
    };
    const siblingOnly = mappingsJson.mappings.filter((entry) => entry['regionId'] === siblingId);
    assert.ok(siblingOnly.length >= 1, 'sibling mapping must exist before crafting');
    const craftedBytes = await createProjectPackage(
      {
        project: parsed.project,
        assets: parsed.assets.filter((asset) => (asset as { kind?: string }).kind !== 'additional')
          .map(({ path, bytes }) => ({ path, bytes })),
        additionalAssets: [
          ...parsed.assets.filter((asset) => (asset as { kind?: string }).kind === 'additional' && asset.path !== 'presentation/photo-mappings.json')
            .map(({ path, bytes }) => ({ path, bytes })),
          { path: 'presentation/photo-mappings.json', bytes: new TextEncoder().encode(JSON.stringify({ version: 1, mappings: siblingOnly })) },
        ],
      },
      { sha256 },
    );
    const craftedPath = info.outputPath('recal-sibling-only.logo-project');
    await writeFile(craftedPath, craftedBytes);
    await page.locator('[data-builder-hook="job-open-file"]').setInputFiles(craftedPath);
    // Retained replacement guard (Journey E): Discard reproduces the old
    // silent replace before asserting the reopen.
    await expect(builder(page, 'builder-alert')).toContainText('unsaved changes');
    await builder(page, 'builder-alert').getByRole('button', { name: 'Discard changes' }).click();
    await expect(await shown(page, 'source-status')).toContainText('.logo-project');
    // The scope view is honestly unmeasured (sibling mapping rejected as
    // scope) and routes back to setup — not confused into the sibling.
    await expect(workspace.getByText('has no scale mapping yet')).toBeVisible();
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided2 = builder(page, 'guided-scale');
    const spanOverlay2 = guided2.locator('[data-guided="span-overlay"]');
    const spanBox2 = (await spanOverlay2.boundingBox())!;
    await spanOverlay2.click({ position: { x: Math.round(spanBox2.width * 0.25), y: Math.round(spanBox2.height * 0.5) } });
    await spanOverlay2.click({ position: { x: Math.round(spanBox2.width * 0.75), y: Math.round(spanBox2.height * 0.5) } });
    await guided2.locator('[data-guided="span-mm"]').fill('1400');
    await guided2.locator('[data-guided="span-create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');

    const recalMasterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    const recalMaster = await recalMasterEvent;
    const recalPath = info.outputPath('recal-master-2.logo-project');
    await recalMaster.saveAs(recalPath);
    const recalibrated = await parseProjectPackage(new Uint8Array(await readFile(recalPath)), { sha256 });
    const recalProduct = recalibrated.project.products[0]!;
    const recalCal = recalProduct.calibrations.find((entry) => entry.id.startsWith('cal-span-view-1'))!;
    expect(recalCal.version).toBe('2');
    // The scope mapping is back with the new transform; the sibling mapping
    // was rewritten (not duplicated); the sibling polygon was cleared with
    // its ref bumped — never left stale under the old frame.
    const recalMappingsRaw = recalibrated.assets.find((asset) => asset.path === 'presentation/photo-mappings.json')!;
    const recalMappings = JSON.parse(Buffer.from(recalMappingsRaw.bytes).toString('utf8')) as {
      mappings: Array<{ regionId: string; calibrationVersion: string; transform: unknown }>;
    };
    const scopeMapping = recalMappings.mappings.find((entry) => entry.regionId === 'region-span-1');
    const siblingMapping = recalMappings.mappings.find((entry) => entry.regionId === siblingId);
    assert.ok(scopeMapping, 'scope mapping restored');
    assert.ok(siblingMapping, 'sibling mapping rewritten');
    expect(scopeMapping.calibrationVersion).toBe('2');
    expect(siblingMapping.calibrationVersion).toBe('2');
    expect(JSON.stringify(siblingMapping.transform)).toBe(JSON.stringify(scopeMapping.transform));
    expect(recalibrated.project.products[0]!.regions.filter((entry) => entry.id === siblingId)).toHaveLength(1);
    const recalSibling = recalProduct.regions.find((entry) => entry.id === siblingId)!;
    expect(recalSibling.safeArea).toEqual([]);
    expect(recalSibling.calibrationRef.version).toBe('2');
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('images shared scope: stale sibling submitter is refused, reset recovers', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'stale sibling submitter guard');
    // Crafted fixture: one product, two variants sharing ONE measured region
    // and photo (mirrors the shared-region fixture pattern).
    const png = await syntheticPngBytes(page, '#1d3a6f', 40, 30);
    const { createProjectPackage: createPackage } = await import('../src/packaging/project-package/index.js');
    const region = {
      id: 'region-shared-2',
      name: 'Shared chest',
      frame: {
        frameId: 'frame-shared-2',
        originDescription: 'Lower-left corner of the measured rectangle',
        axes: { xPositive: 'right', yPositive: 'up' },
      },
      calibrationRef: { calibrationId: 'cal-shared-2', version: '1' },
      safeArea: [[0, 0], [280, 0], [280, 200], [0, 200]],
      allowedMethods: ['embroidery', 'print'],
    };
    const project = {
      schemaVersion: '0.1.0-provisional',
      projectId: 'SYN-PROJ-SHARED-002',
      revision: 1,
      products: [{
        schemaVersion: '0.1.0-provisional',
        id: 'P-SHARED-02',
        name: 'Shared product',
        kind: 'other',
        variants: [
          { id: 'P-SHARED-02-A', regionIds: ['region-shared-2'] },
          { id: 'P-SHARED-02-B', regionIds: ['region-shared-2'] },
        ],
        regions: [region],
        calibrations: [{ id: 'cal-shared-2', version: '1', description: 'shared visual trial' }],
      }],
      logos: [],
      configurations: [
        { id: 'cfg-shared-a', productId: 'P-SHARED-02', variantId: 'P-SHARED-02-A', placements: [] },
        { id: 'cfg-shared-b', productId: 'P-SHARED-02', variantId: 'P-SHARED-02-B', placements: [] },
      ],
    };
    const mappingFor = (variantId: string) => ({
      productId: 'P-SHARED-02',
      variantId,
      regionId: 'region-shared-2',
      view: 'front',
      image: 'presentation/front.png',
      transform: { a: 1 / 280, b: 0, c: 0, d: 0, e: -1 / 200, f: 1 },
      calibrationId: 'cal-shared-2',
      calibrationVersion: '1',
      status: 'provisional',
    });
    const packageBytes = await createPackage({
      project,
      assets: [],
      additionalAssets: [
        { path: 'presentation/front.png', bytes: png },
        {
          path: 'presentation/preview.json',
          bytes: new TextEncoder().encode(JSON.stringify({
            version: 2,
            views: [
              { productId: 'P-SHARED-02', variantId: 'P-SHARED-02-A', view: 'front', image: 'presentation/front.png' },
              { productId: 'P-SHARED-02', variantId: 'P-SHARED-02-B', view: 'front', image: 'presentation/front.png' },
            ],
          })),
        },
        {
          path: 'presentation/photo-mappings.json',
          bytes: new TextEncoder().encode(JSON.stringify({
            version: 1,
            mappings: [mappingFor('P-SHARED-02-A'), mappingFor('P-SHARED-02-B')],
          })),
        },
      ],
    }, { sha256 });
    const fixturePath = info.outputPath('shared-stale.logo-project');
    await writeFile(fixturePath, packageBytes);
    await page.locator('[data-builder-hook="job-open-file"]').setInputFiles(fixturePath);
    await expect(await shown(page, 'source-status')).toContainText('.logo-project');

    const workspace = builder(page, 'product-workspace');
    const variantSelect = builder(page, 'workspace-variant');
    const drawQuad = async (x0: number, x1: number) => {
      const stage = workspace.locator('.product-setup-overlay').first();
      for (const [fx, fy] of [[x0, 0.3], [x1, 0.3], [x1, 0.7], [x0, 0.7]] as const) {
        await stage.scrollIntoViewIfNeeded();
        const box = (await stage.boundingBox())!;
        await stage.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
      }
      await workspace.getByRole('button', { name: 'Finish safe area' }).click();
    };
    // Variant B stages an area FIRST (bucket seeds with no siblings).
    await variantSelect.selectOption('P-SHARED-02-B');
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    await drawQuad(0.6, 0.9);
    // Variant A stages and SAVES another area meanwhile.
    await variantSelect.selectOption('P-SHARED-02-A');
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    await drawQuad(0.1, 0.4);
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
    // Variant B saves with a stale seed that never saw A's sibling: refused,
    // nothing reverted. Reset resynchronises, then saving succeeds.
    await variantSelect.selectOption('P-SHARED-02-B');
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Save failed.*changed underneath/)).toBeVisible();
    await workspace.getByRole('button', { name: 'Reset to saved' }).click();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('station 3D setup: model-only mount + surface reference + save to master + reopen', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'station model-only setup');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await stageIntakeModel(page, 'box.glb', cubeGlb());
    await (await shown(page, 'product-name')).fill('Model Box');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Model Box');

    // The model pane mounts the 3D setup view: no images anywhere.
    const modelPane = builder(page, 'product-model');
    await expect(modelPane).toBeVisible();
    await expect(builder(page, 'product-model-status')).toContainText('for reference');
    const setupHost = builder(page, 'model-setup');
    await expect(setupHost.locator('[data-model-setup-hook="pending-banner"]')).toContainText('pending review');
    expect(await workspaceHasNoPhotoTabs(page)).toBe(true);

    // Two surface picks + millimetres on the station canvas.
    const canvas = modelPane.locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const surfaceClick = async (fx: number, fy: number) => {
      await canvas.scrollIntoViewIfNeeded();
      const box = (await canvas.boundingBox())!;
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    };
    const ms = (name: string) => setupHost.locator(`[data-model-setup-hook="${name}"]`);
    await ms('ref-pick-a').click();
    await surfaceClick(0.5, 0.5);
    await expect(ms('reference-readout')).toContainText('A (');
    // Point A auto-arms point B: click the surface directly, no second button
    // (clicking Pick B now would disarm it).
    await surfaceClick(0.6, 0.5);
    await expect(ms('reference-readout')).toContainText('B (');
    await ms('ref-mm').fill('470');
    await ms('ref-fit').click();
    await expect(ms('reference-scale')).toContainText('scale 1 unit =');

    // One named area from surface picks, then explicit save to the master.
    await ms('area-name').fill('Chest');
    await ms('area-start').click();
    await surfaceClick(0.44, 0.44);
    await surfaceClick(0.56, 0.44);
    await surfaceClick(0.56, 0.52);
    await surfaceClick(0.44, 0.52);
    await ms('area-finish').click();
    await expect(ms('area-list')).toContainText('Chest');
    await (await shown(page, 'model-setup-save')).click();
    await expect(builder(page, 'model-setup-status')).toContainText('Saved 3D setup');

    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master = await masterEvent;
    const masterPath = info.outputPath('station-model-master.logo-project');
    await master.saveAs(masterPath);
    const parsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    const product = parsed.project.products[0]!;
    const calibration = product.calibrations.find((entry) => entry.id.startsWith('cal-model-'));
    assert.ok(calibration, 'master must carry the 3D calibration record');
    const sidecar = parsed.assets.find((asset) => asset.path.endsWith('.model.json'));
    assert.ok(sidecar, 'master must carry the model setup sidecar');
    const sidecarJson = JSON.parse(Buffer.from(sidecar.bytes).toString('utf8')) as {
      kind: string; setup: { areas: unknown[]; reference: { lengthMm: number } };
    };
    expect(sidecarJson.kind).toBe('model');
    expect(sidecarJson.setup.areas).toHaveLength(1);
    expect(sidecarJson.setup.reference.lengthMm).toBe(470);
    // Each saved area becomes a domain region (plane-projected ring, linked
    // to the 3D calibration) — usable calibrated geometry in the issue.
    expect(product.regions).toHaveLength(1);
    const region = product.regions[0]!;
    expect(region.name).toBe('Chest');
    expect(region.safeArea).toHaveLength(4);
    expect(region.calibrationRef.calibrationId).toBe(calibration.id);
    expect(product.variants[0]!.regionIds).toContain(region.id);

    // Reopen the master fresh: the saved 3D setup returns intact.
    const freshContext = await browser.newContext({ offline: true, viewport });
    const fresh = await freshContext.newPage();
    try {
      await gotoBuilder(fresh);
      await fresh.locator('[data-builder-hook="job-open-file"]').setInputFiles(masterPath);
      await expect(builder(fresh, 'source-status')).toContainText('.logo-project');
      await expect(builder(fresh, 'model-setup-status')).toContainText('Reopened saved 3D setup');
      await expect(builder(fresh, 'model-setup').locator('[data-model-setup-hook="area-list"]')).toContainText('Chest');
    } finally {
      await freshContext.close();
    }

    // Issue with one logo and inspect the generated customer artifact: the
    // projected region frame, calibration and model bytes must reach
    // downstream (not just descriptions), and the customer places in it.
    const logoPng = await syntheticPngBytes(page, '#c8a028');
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: Buffer.from(logoPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added mark.png');
    await builder(page, 'product-list').locator('input[type="checkbox"]').evaluateAll((nodes) => {
      for (const node of nodes) {
        const box = node as HTMLInputElement;
        if (!box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    await builder(page, 'logo-list').locator('input[type="checkbox"]').evaluateAll((nodes) => {
      for (const node of nodes) {
        const box = node as HTMLInputElement;
        if (!box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    await (await shown(page, 'job-step-1')).click();
    await (await shown(page, 'customer-name')).fill('Model Box Co');
    await (await shown(page, 'job-ref')).fill('MODEL-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await createBranchIssue(page);
    const baselineEvent = page.waitForEvent('download');
    await approval(page).getByRole('button', { name: 'Save office copy', exact: true }).click();
    const baselineDownload = await baselineEvent;
    const baselinePath = info.outputPath('station-model-issued.logo-project');
    await baselineDownload.saveAs(baselinePath);
    const issued = await parseProjectPackage(new Uint8Array(await readFile(baselinePath)), { sha256 });
    const issuedProduct = issued.project.products[0]!;
    const issuedRegion = issuedProduct.regions.find((entry) => entry.name === 'Chest')!;
    assert.ok(issuedRegion, 'issued customer file must carry the projected region');
    expect(issuedRegion.safeArea).toHaveLength(4);
    expect(issuedRegion.frame.originDescription).toContain('Centroid');
    expect(issuedRegion.calibrationRef.calibrationId).toBe(calibration.id);
    assert.ok(
      issued.assets.some((asset) => asset.path.endsWith('.glb')),
      'issued customer file must carry the model bytes',
    );
    const issuedConfig = issued.project.configurations[0]!;
    const issuedLogo = issued.project.logos[0]!;
    const customerEvent = page.waitForEvent('download');
    await approval(page).getByRole('button', { name: 'Save customer file', exact: true }).click();
    const customerDownload = await customerEvent;
    const customerPath = info.outputPath('station-model-customer.html');
    await customerDownload.saveAs(customerPath);

    const customerContext = await browser.newContext({ offline: true, viewport });
    const customerPage = await customerContext.newPage();
    const customerProbe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
    customerPage.on('pageerror', (error) => customerProbe.pageErrors.push(String(error)));
    customerPage.on('console', (message) => {
      if (message.type() === 'error') customerProbe.consoleErrors.push(String(message.text()));
    });
    customerContext.on('request', (request) => {
      if (/^https?:/i.test(request.url())) customerProbe.networkRequests.push(request.url());
    });
    try {
      await customerPage.goto(pathToFileURL(customerPath).href);
      const customer = (name: string) => customerPage.locator(`[data-customer-hook="${name}"]`);
      await expect(customer('project-id')).toHaveText(issued.project.projectId);
      await selectCustomerOption(customerPage, 'configuration', issuedConfig.id);
      await expect(customer('region').locator('option')).toHaveCount(1);
      await expect(customer('region')).toContainText('Chest');
      // The customer places in the projected region through the normal
      // schematic diagram: region frame data (not just descriptions) drives
      // the fit check below.
      await selectCustomerOption(customerPage, 'region', issuedRegion.id);
      await selectCustomerOption(customerPage, 'logo', issuedLogo.id);
      await selectCustomerOption(customerPage, 'method', 'embroidery');
      let sx = 0;
      let sy = 0;
      for (const point of issuedRegion.safeArea as Array<[number, number]>) {
        sx += point[0];
        sy += point[1];
      }
      await setCustomerNumber(customerPage, 'x-mm', Math.round(sx / issuedRegion.safeArea.length));
      await setCustomerNumber(customerPage, 'y-mm', Math.round(sy / issuedRegion.safeArea.length));
      await setCustomerNumber(customerPage, 'width-mm', 20);
      await setCustomerNumber(customerPage, 'height-mm', 10);
      await revealCustomerControl(customerPage, 'rotation');
      await customer('rotation').fill('0');
      await revealCustomerControl(customerPage, 'add');
      await customer('add').click();
      await expect(customer('geometry')).toContainText('Fits: yes');
      const shotPath = info.outputPath('station-model-customer.png');
      await customerPage.screenshot({ path: shotPath });
      await info.attach('station-model-customer', { path: shotPath, contentType: 'image/png' });
    } finally {
      await customerContext.close();
    }
    expect(customerProbe.pageErrors).toEqual([]);
    expect(customerProbe.consoleErrors).toEqual([]);
    expect(customerProbe.networkRequests).toEqual([]);

    const shotPath = info.outputPath('station-model-setup.png');
    await page.screenshot({ path: shotPath });
    await info.attach('station-model-setup', { path: shotPath, contentType: 'image/png' });
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

/** True when the photo workspace shows no view tabs (model-only product). */
async function workspaceHasNoPhotoTabs(page: Page): Promise<boolean> {
  return builder(page, 'product-workspace').getByRole('tab').count().then((count) => count === 0);
}

test('station 3D delete + resave: unreferenced region removed with links, issue works', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'station model area deletion');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await stageIntakeModel(page, 'box.glb', cubeGlb());
    await (await shown(page, 'product-name')).fill('Delete Box');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Delete Box');

    const modelPane = builder(page, 'product-model');
    await expect(modelPane).toBeVisible();
    const setupHost = builder(page, 'model-setup');
    await expect(setupHost.locator('[data-model-setup-hook="pending-banner"]')).toBeVisible();
    const canvas = modelPane.locator('canvas');
    const surfaceClick = async (fx: number, fy: number) => {
      await canvas.scrollIntoViewIfNeeded();
      const box = (await canvas.boundingBox())!;
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    };
    const ms = (name: string) => setupHost.locator(`[data-model-setup-hook="${name}"]`);
    await ms('ref-pick-a').click();
    await surfaceClick(0.5, 0.5);
    await surfaceClick(0.6, 0.5);
    await ms('ref-mm').fill('470');
    await ms('ref-fit').click();
    await expect(ms('reference-scale')).toContainText('scale 1 unit =');

    const drawArea = async (name: string, quad: ReadonlyArray<readonly [number, number]>) => {
      await ms('area-name').fill(name);
      await ms('area-start').click();
      for (const [fx, fy] of quad) await surfaceClick(fx, fy);
      await ms('area-finish').click();
      await expect(ms('area-list')).toContainText(name);
    };
    await drawArea('Chest', [[0.44, 0.44], [0.56, 0.44], [0.56, 0.52], [0.44, 0.52]]);
    await drawArea('Side panel', [[0.45, 0.45], [0.55, 0.45], [0.55, 0.51], [0.45, 0.51]]);
    await (await shown(page, 'model-setup-save')).click();
    await expect(builder(page, 'model-setup-status')).toContainText('Saved 3D setup');
    const masterOne = await readMaster(page, info, 'delete-master-1.logo-project');
    const parsedOne = await parseProjectPackage(new Uint8Array(await readFile(masterOne)), { sha256 });
    const productOne = parsedOne.project.products[0]!;
    expect(productOne.regions).toHaveLength(2);
    const calOne = productOne.calibrations.find((entry) => entry.id.startsWith('cal-model-'))!;
    expect(calOne.version).toBe('1');

    // Delete the second area and re-save: with no placements anywhere its
    // region and variant links vanish — a real delete, not retained geometry.
    await setupHost.getByRole('button', { name: /Side panel/ }).first().click();
    await setupHost.getByRole('button', { name: /Delete.*Side panel/ }).click();
    await expect(ms('area-list')).not.toContainText('Side panel');
    await (await shown(page, 'model-setup-save')).click();
    await expect(builder(page, 'model-setup-status')).toContainText('Removed 1 deleted area');
    const masterTwo = await readMaster(page, info, 'delete-master-2.logo-project');
    const parsedTwo = await parseProjectPackage(new Uint8Array(await readFile(masterTwo)), { sha256 });
    const productTwo = parsedTwo.project.products[0]!;
    expect(productTwo.regions).toHaveLength(1);
    expect(productTwo.regions[0]!.name).toBe('Chest');
    for (const variant of productTwo.variants) {
      expect(variant.regionIds).toEqual([productTwo.regions[0]!.id]);
    }
    const calTwo = productTwo.calibrations.find((entry) => entry.id === calOne.id)!;
    expect(calTwo.version).toBe('1');

    // Change the reference (new millimetres): version bumps with a single
    // live region recomputed under the new scale.
    await ms('ref-mm').fill('500');
    await ms('ref-fit').click();
    await expect(ms('reference-scale')).toContainText('scale 1 unit =');
    await ms('areas-recompute').click();
    await expect(ms('area-list')).not.toContainText('stale');
    await (await shown(page, 'model-setup-save')).click();
    await expect(builder(page, 'model-setup-status')).toContainText('Reference changed');
    const masterThree = await readMaster(page, info, 'delete-master-3.logo-project');
    const parsedThree = await parseProjectPackage(new Uint8Array(await readFile(masterThree)), { sha256 });
    const productThree = parsedThree.project.products[0]!;
    const calThree = productThree.calibrations.find((entry) => entry.id === calOne.id)!;
    expect(calThree.version).toBe('2');
    expect(productThree.regions).toHaveLength(1);
    const chestTwo = productTwo.regions.find((entry) => entry.name === 'Chest')!;
    const chestThree = productThree.regions.find((entry) => entry.name === 'Chest')!;
    expect(chestThree.calibrationRef.version).toBe('2');
    expect(JSON.stringify(chestThree.safeArea)).not.toBe(JSON.stringify(chestTwo.safeArea));

    // Issue with zero logos: only the surviving region ships.
    await (await shown(page, 'job-step-1')).click();
    await builder(page, 'product-list').locator('input[type="checkbox"]').evaluateAll((nodes) => {
      for (const node of nodes) {
        const box = node as HTMLInputElement;
        if (!box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    await (await shown(page, 'job-step-1')).click();
    await (await shown(page, 'customer-name')).fill('Delete Co');
    await (await shown(page, 'job-ref')).fill('DELETE-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await createBranchIssue(page);
    const baselineEvent = page.waitForEvent('download');
    await approval(page).getByRole('button', { name: 'Save office copy', exact: true }).click();
    const baselineDownload = await baselineEvent;
    const baselinePath = info.outputPath('delete-issued.logo-project');
    await baselineDownload.saveAs(baselinePath);
    const issued = await parseProjectPackage(new Uint8Array(await readFile(baselinePath)), { sha256 });
    const issuedNames = issued.project.products[0]!.regions.map((entry) => entry.name ?? entry.id).sort();
    expect(issuedNames).toEqual(['Chest']);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

/** Download the prepared master and return its output path. */
async function readMaster(page: Page, info: import('@playwright/test').TestInfo, fileName: string): Promise<string> {
  await revealBuilderControl(page, 'save-master');
  const masterEvent = page.waitForEvent('download');
  await page.locator('[data-builder-hook="save-master"]').click();
  const master = await masterEvent;
  const masterPath = info.outputPath(fileName);
  await master.saveAs(masterPath);
  await expect(page.locator('[data-builder-hook="master-status"]')).toContainText('Saved prepared master');
  return masterPath;
}

test('model setup save/reopen roundtrip retains references, calibration and areas', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const first = await openHarness(browser, viewport, 'setup-harness-roundtrip-a.html');
  let savedText = '';
  let savedScale = 0;
  try {
    await attachEnv(info, browser, viewport, 'model setup save/reopen roundtrip');
    await assertHarness(first.page);
    expect(await hCall<string>(first.page, 'loadGlb', Buffer.from(cubeGlb()).toString('base64'))).toBe('ready');
    await modelSetup(first.page, 'ref-pick-a').click();
    await harnessClick(first.page, 0.5, 0.5);
    // Point A auto-arms point B: click the surface directly, no second button.
    await harnessClick(first.page, 0.58, 0.5);
    await modelSetup(first.page, 'ref-mm').fill('250');
    await modelSetup(first.page, 'ref-fit').click();
    await expect(modelSetup(first.page, 'reference-scale')).toContainText('scale 1 unit =');
    await modelSetup(first.page, 'area-name').fill('Front panel');
    await modelSetup(first.page, 'area-start').click();
    await harnessClick(first.page, 0.42, 0.42);
    await harnessClick(first.page, 0.58, 0.42);
    await harnessClick(first.page, 0.58, 0.58);
    await modelSetup(first.page, 'area-finish').click();
    await expect(modelSetup(first.page, 'area-list')).toContainText('Front panel');
    savedScale = (await hCall<HarnessSnapshot | null>(first.page, 'lastSnapshot'))?.mmPerUnit ?? 0;
    assert.ok(savedScale > 0, 'scale fitted before save');
    const downloadEvent = first.page.waitForEvent('download');
    // Standalone setup JSON lives behind the Advanced disclosure.
    await modelSetup(first.page, 'advanced-summary').click();
    await modelSetup(first.page, 'setup-save').click();
    const download = await downloadEvent;
    const downloadPath = await download.path();
    assert.ok(downloadPath, 'setup download has a path');
    savedText = await readFile(downloadPath, 'utf8');
    const saved = JSON.parse(savedText) as { version: string; flags: { pendingReview: boolean; productionApproved: boolean }; reference: unknown; areas: unknown[] };
    expect(saved.version).toBe('0.1.0-provisional-model-setup');
    expect(saved.flags).toEqual({ pendingReview: true, productionApproved: false });
    expect(saved.areas).toHaveLength(1);
    expectOfflineClean(first.probe);
  } finally {
    await first.context.close();
  }

  const second = await openHarness(browser, viewport, 'setup-harness-roundtrip-b.html');
  try {
    await assertHarness(second.page);
    expect(await hCall<string>(second.page, 'loadGlb', Buffer.from(cubeGlb()).toString('base64'))).toBe('ready');
    // Standalone setup JSON lives behind the Advanced disclosure.
    await modelSetup(second.page, 'advanced-summary').click();
    await modelSetup(second.page, 'setup-restore-file').setInputFiles({ name: 'syn-box-model-setup.json', mimeType: 'application/json', buffer: Buffer.from(savedText) });
    await modelSetup(second.page, 'setup-restore').click();
    await expect(modelSetup(second.page, 'status')).toContainText('Setup reopened');
    await expect(modelSetup(second.page, 'reference-readout')).toContainText('A (');
    await expect(modelSetup(second.page, 'area-list')).toContainText('Front panel');
    // Restored areas reopen explicitly stale; recompute marks them current.
    await expect(modelSetup(second.page, 'area-list')).toContainText('stale');
    const reopened = await hCall<HarnessSnapshot | null>(second.page, 'lastSnapshot');
    assert.ok(reopened?.reference && reopened.reference.lengthMm === 250, 'reference retained');
    expect(reopened.mmPerUnit).toBe(savedScale);
    expect(reopened.areas).toHaveLength(1);
    await modelSetup(second.page, 'areas-recompute').click();
    await expect(modelSetup(second.page, 'area-list')).not.toContainText('stale');
    // Tampered product binding is refused atomically, prior state kept.
    const tampered = { ...(JSON.parse(savedText) as Record<string, unknown>), productId: 'OTHER' };
    await modelSetup(second.page, 'setup-restore-file').setInputFiles({ name: 'tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered)) });
    await modelSetup(second.page, 'setup-restore').click();
    await expect(modelSetup(second.page, 'status')).toContainText('different product');
    await expect(modelSetup(second.page, 'area-list')).toContainText('Front panel');
    expectOfflineClean(second.probe);
  } finally {
    await second.context.close();
  }
  void info;
});

test('model product visibility: hide/show mesh keeps reference, areas and fit', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openHarness(browser, viewport, 'setup-harness-product-visibility.html');
  try {
    await attachEnv(info, browser, viewport, 'model product visibility toggle');
    await assertHarness(page);
    expect(await hCall<string>(page, 'loadGlb', Buffer.from(cubeGlb()).toString('base64'))).toBe('ready');
    // Single scope: no redundant product selector; toggles stay visible.
    await expect(modelSetup(page, 'product-row')).toHaveCount(0);
    await expect(modelSetup(page, 'toggle-product')).toBeVisible();
    // Baseline: the mesh actually paints (not a flag assertion).
    await expect.poll(async () => hCall<number>(page, 'nonBackgroundPixels')).toBeGreaterThan(500);
    expect(await hCall<boolean>(page, 'productVisible')).toBe(true);
    // Hide overlays first to isolate mesh pixels, then hide the product.
    await modelSetup(page, 'toggle-anchors').click();
    await modelSetup(page, 'toggle-safe').click();
    await modelSetup(page, 'toggle-product').click();
    await expect(modelSetup(page, 'toggle-product')).toHaveAttribute('aria-pressed', 'false');
    await expect(modelSetup(page, 'status')).toContainText('Product hidden');
    expect(await hCall<boolean>(page, 'productVisible')).toBe(false);
    await expect.poll(async () => hCall<number>(page, 'nonBackgroundPixels')).toBeLessThan(50);
    // Hidden picking is blocked clearly: armed A records nothing.
    await modelSetup(page, 'ref-pick-a').click();
    await harnessClick(page, 0.5, 0.5);
    await expect(modelSetup(page, 'status')).toContainText('Product hidden — show the product to pick surface points');
    expect((await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.reference).toBe(null);
    // Show again: the mesh paints, picking resumes, nothing was lost.
    await modelSetup(page, 'toggle-product').click();
    await expect(modelSetup(page, 'toggle-product')).toHaveAttribute('aria-pressed', 'true');
    expect(await hCall<boolean>(page, 'productVisible')).toBe(true);
    await expect.poll(async () => hCall<number>(page, 'nonBackgroundPixels')).toBeGreaterThan(500);
    // The refused arm is still live: one surface click records A directly.
    await expect(modelSetup(page, 'ref-pick-a')).toContainText('Click point A on the model');
    await harnessClick(page, 0.5, 0.5);
    await harnessClick(page, 0.58, 0.5);
    await modelSetup(page, 'ref-mm').fill('250');
    await modelSetup(page, 'ref-fit').click();
    await expect(modelSetup(page, 'reference-scale')).toContainText('scale 1 unit =');
    await modelSetup(page, 'area-name').fill('Front panel');
    await modelSetup(page, 'area-start').click();
    await harnessClick(page, 0.42, 0.42);
    await harnessClick(page, 0.58, 0.42);
    await harnessClick(page, 0.58, 0.58);
    await modelSetup(page, 'area-finish').click();
    await expect(modelSetup(page, 'area-list')).toContainText('Front panel');
    const fitted = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    assert.ok(fitted?.reference && fitted.reference.lengthMm === 250, 'reference fitted');
    assert.ok((fitted?.mmPerUnit ?? 0) > 0, 'scale fitted');
    // Hide with staged data: mesh goes (pixels), reference/areas/fit stay.
    await modelSetup(page, 'toggle-product').click();
    await expect.poll(async () => hCall<number>(page, 'nonBackgroundPixels')).toBeLessThan(50);
    await expect(modelSetup(page, 'reference-scale')).toContainText('scale 1 unit =');
    await expect(modelSetup(page, 'area-list')).toContainText('Front panel');
    const hidden = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    assert.ok(hidden?.reference && hidden.reference.lengthMm === 250, 'reference preserved while hidden');
    expect(hidden.mmPerUnit).toBe(fitted.mmPerUnit);
    expect(hidden.areas).toHaveLength(1);
    // Show restores the mesh; staged data untouched throughout.
    await modelSetup(page, 'toggle-product').click();
    await expect.poll(async () => hCall<number>(page, 'nonBackgroundPixels')).toBeGreaterThan(500);
    await expect(modelSetup(page, 'area-list')).toContainText('Front panel');
    const restored = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    assert.ok(restored, 'snapshot present after re-show');
    expect(restored.mmPerUnit).toBe(fitted.mmPerUnit);
    expect(restored.areas).toHaveLength(1);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('prepared-master save/reopen retains references, calibration and areas', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'station prepared-master roundtrip');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    const frontPng = await syntheticPngBytes(page, '#2a4d8f');
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-name')).fill('Master Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Master Jacket');

    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    const overlay = guided.locator('.guided-scale-overlay[aria-label*="rectangle corners"]');
    const overlayBox = (await overlay.boundingBox())!;
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]] as const) {
      await overlay.click({ position: { x: Math.round(overlayBox.width * fx), y: Math.round(overlayBox.height * fy) } });
    }
    await guided.locator('[data-guided="width"]').fill('200');
    await guided.locator('[data-guided="height"]').fill('150');
    await guided.locator('[data-guided="create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Measured the Front view: 200×150');

    await workspace.getByRole('button', { name: 'Anchor', exact: true }).click();
    const stage = workspace.locator('.product-setup-overlay').first();
    const stageBox = (await stage.boundingBox())!;
    await stage.click({ position: { x: Math.round(stageBox.width * 0.5), y: Math.round(stageBox.height * 0.5) } });
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 1 anchors\)/)).toBeVisible();

    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master = await masterEvent;
    const masterPath = info.outputPath('setup-calibration-master.logo-project');
    await master.saveAs(masterPath);
    const before = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    const beforeRegion = before.project.products[0]!.regions[0]!;
    expect(beforeRegion.safeArea).toHaveLength(4);
    const calibrationId = beforeRegion.calibrationRef.calibrationId;
    expect(calibrationId.length).toBeGreaterThan(0);
    const sidecarRaw = before.assets.find((asset) => asset.path === 'presentation/operation-anchors.json');
    assert.ok(sidecarRaw, 'master must carry the anchors sidecar');
    const sidecar = JSON.parse(Buffer.from(sidecarRaw.bytes).toString('utf8')) as { anchors: Array<{ name: string }> };
    expect(sidecar.anchors).toHaveLength(1);

    // Reopen the saved master in a FRESH page: references, calibration and
    // areas return intact; re-saving keeps the same physical geometry.
    const freshContext = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
    const fresh = await freshContext.newPage();
    fresh.on('pageerror', (error) => probe.pageErrors.push(String(error)));
    fresh.on('console', (message) => {
      if (message.type() === 'error') probe.consoleErrors.push(message.text());
    });
    try {
      await gotoBuilder(fresh);
      await fresh.locator('[data-builder-hook="job-open-file"]').setInputFiles(masterPath);
      await expect(builder(fresh, 'source-status')).toContainText('.logo-project');
      const freshWorkspace = builder(fresh, 'product-workspace');
      await expect(freshWorkspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
      await expect(freshWorkspace.getByRole('button', { name: 'Anchor (1)', exact: true })).toBeVisible();
      const reopened = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
      const afterRegion = reopened.project.products[0]!.regions[0]!;
      expect(afterRegion.calibrationRef.calibrationId).toBe(calibrationId);
      expect(afterRegion.safeArea).toEqual(beforeRegion.safeArea);
    } finally {
      await freshContext.close();
    }
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('product-setup tools: dotted reference, rectangle + side edit, rollback, zoom-invariant picking, visibility, freehand', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'product-setup tools journey');
    const frontPng = await syntheticPngBytes(page, '#2a6f4d');
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-name')).fill('Tool Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Tool Jacket');

    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    const spanOverlay = guided.locator('[data-guided="span-overlay"]');
    await expect(spanOverlay).toBeVisible();
    // Float-precise taps (not integer-rounded clicks): the mm assertions
    // below need sub-pixel endpoint precision.
    const tapSpan = async (fx: number, fy: number) => {
      await spanOverlay.scrollIntoViewIfNeeded();
      const box = (await spanOverlay.boundingBox())!;
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.mouse.down();
      await page.mouse.up();
    };
    await tapSpan(0.3, 0.5);
    await tapSpan(0.7, 0.5);
    await guided.locator('[data-guided="span-mm"]').fill('1300');
    await guided.locator('[data-guided="span-create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');

    // Dotted A/B line + entered length on the calibrated stage (400x300
    // photo, A at 0.3W, B at 0.7W: scale is 1300/160 = 8.125 mm/px).
    await expect(workspace.locator('.product-setup-refline')).toBeVisible();
    await expect(workspace.locator('.product-setup-reflabel')).toContainText('1,300 mm');

    // Rectangle drag commits one exact four-corner area with side handles.
    await workspace.getByRole('button', { name: 'Safe area', exact: true }).click();
    await workspace.getByRole('button', { name: 'Rectangle' }).click();
    const stage = workspace.locator('.product-setup-overlay').first();
    const dragStage = async (x1: number, y1: number, x2: number, y2: number) => {
      await stage.scrollIntoViewIfNeeded();
      const box = (await stage.boundingBox())!;
      await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 5 });
      await page.mouse.up();
    };
    await dragStage(0.1, 0.1, 0.4, 0.4);
    await expect(workspace.getByText(/Staged a drawn safe area with 4 corners/)).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Area 1', exact: true })).toBeVisible();
    await expect(workspace.locator('.product-setup-sidehandle').first()).toBeVisible();

    const readCorners = async (): Promise<Array<[number, number]>> => {
      await workspace.locator('.product-setup-advanced summary').click();
      const text = await workspace.locator('.product-setup-advanced-list').first().textContent() ?? '';
      await workspace.locator('.product-setup-advanced summary').click();
      const found: Array<[number, number]> = [];
      for (const match of text.matchAll(/Corner \d+: (-?[\d.]+), (-?[\d.]+) mm/g)) {
        found.push([Number(match[1]), Number(match[2])]);
      }
      return found;
    };
    const corners100 = await readCorners();
    expect(corners100).toHaveLength(4);
    // (0.4-0.1)*400 = 120 photo px wide -> 975mm; (0.4-0.1)*300 = 90 -> 731.25mm.
    const span = (cs: Array<[number, number]>, axis: 0 | 1): number =>
      Math.max(...cs.map((c) => c[axis])) - Math.min(...cs.map((c) => c[axis]));
    expect(Math.abs(span(corners100, 0) - 975)).toBeLessThan(1);
    expect(Math.abs(span(corners100, 1) - 731.25)).toBeLessThan(1);
    // Independent checks on the tool-created ring: exact right angles and
    // parallel opposite sides (display rounding only, far below hand-tap
    // deviations).
    {
      const edgeAt = (i: number): [number, number] => [
        corners100[(i + 1) % 4]![0] - corners100[i]![0],
        corners100[(i + 1) % 4]![1] - corners100[i]![1],
      ];
      const ringEdges = [edgeAt(0), edgeAt(1), edgeAt(2), edgeAt(3)];
      const edgeLen = (e: [number, number]): number => Math.hypot(e[0], e[1]);
      for (let i = 0; i < 4; i += 1) {
        const a = ringEdges[i]!;
        const b = ringEdges[(i + 1) % 4]!;
        expect(Math.abs((a[0] * b[0] + a[1] * b[1]) / (edgeLen(a) * edgeLen(b)))).toBeLessThan(0.001);
        const c = ringEdges[(i + 2) % 4]!;
        expect(Math.hypot(a[0] + c[0], a[1] + c[1]) / edgeLen(a)).toBeLessThan(0.001);
      }
    }

    // Zoom is display-only: 200% keeps the label, and corner picking uses
    // the inverse of the actual view transform.
    await workspace.locator('[data-ps-view="zoom"]').selectOption('200');
    await expect(workspace.locator('[data-ps-view="zoom"]')).toHaveValue('200');
    await expect(workspace.locator('.product-setup-refline')).toBeVisible();
    await expect(workspace.locator('.product-setup-reflabel')).toContainText('1,300 mm');
    const zoomedBox = (await stage.boundingBox())!;
    const mmPerCssPx = (400 * 8.125) / zoomedBox.width;
    const handle = workspace.locator('.product-setup-vertex').first();
    // The zoomed stage scrolls internally: bring the handle itself into
    // the scrollport before measuring, or the drag targets a clipped point.
    await handle.scrollIntoViewIfNeeded();
    const handleBox = (await handle.boundingBox())!;
    const dxPx = 40;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + dxPx, handleBox.y + handleBox.height / 2, { steps: 5 });
    await page.mouse.up();
    const corners200 = await readCorners();
    const actualDx = corners200[0]![0] - corners100[0]![0];
    const predictedDx = dxPx * mmPerCssPx;
    expect(Math.abs(actualDx - predictedDx) / predictedDx).toBeLessThan(0.15);
    expect(Math.abs(corners200[0]![1] - corners100[0]![1])).toBeLessThan(0.5);
    expect(Math.abs(corners200[2]![0] - corners100[2]![0])).toBeLessThan(0.05);
    expect(Math.abs(corners200[2]![1] - corners100[2]![1])).toBeLessThan(0.05);
    await workspace.locator('[data-ps-view="zoom"]').selectOption('100');

    // Side drag moves that side's two corners, opposite side fixed, x fixed.
    const beforeSide = await readCorners();
    await stage.scrollIntoViewIfNeeded();
    const sideHandle = workspace.locator('.product-setup-sidehandle').first();
    const sideBox = (await sideHandle.boundingBox())!;
    await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y + sideBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y + sideBox.height / 2 + 25, { steps: 5 });
    await page.mouse.up();
    await expect(workspace.getByText(/Moved side 1/)).toBeVisible();
    const afterSide = await readCorners();
    const dy0 = afterSide[0]![1] - beforeSide[0]![1];
    const dy1 = afterSide[1]![1] - beforeSide[1]![1];
    expect(dy0).toBeLessThan(-5);
    expect(dy1).toBeLessThan(-5);
    expect(Math.abs(dy0 - dy1)).toBeLessThan(1);
    for (const index of [0, 1, 2, 3]) {
      expect(Math.abs(afterSide[index]![0] - beforeSide[index]![0])).toBeLessThan(0.05);
    }
    for (const index of [2, 3]) {
      expect(Math.abs(afterSide[index]![1] - beforeSide[index]![1])).toBeLessThan(0.05);
    }

    // Escape mid-drag restores the previous draft exactly.
    const beforeEscape = await readCorners();
    await stage.scrollIntoViewIfNeeded();
    const cornerHandle = workspace.locator('.product-setup-vertex').first();
    const cornerBox = (await cornerHandle.boundingBox())!;
    await page.mouse.move(cornerBox.x + cornerBox.width / 2, cornerBox.y + cornerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cornerBox.x + cornerBox.width / 2 + 30, cornerBox.y + cornerBox.height / 2, { steps: 3 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await readCorners()).toEqual(beforeEscape);

    // Taps do not create rectangles.
    await stage.click({ position: { x: 100, y: 100 } });
    await expect(workspace.getByText('Safe-area tool: drag a corner, use a side handle, or pick a corner below. Photo clicks never alter the polygon here.')).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Area 2' })).toHaveCount(0);

    // Visibility is display-only: hiding layers keeps staged geometry.
    await workspace.locator('[data-ps-view="vis-anchors"]').click();
    await expect(workspace.locator('.product-setup-refline')).toHaveCount(0);
    await workspace.locator('[data-ps-view="vis-anchors"]').click();
    await expect(workspace.locator('.product-setup-refline')).toBeVisible();
    await workspace.locator('[data-ps-view="vis-product"]').click();
    await expect(workspace.locator('.product-setup-photo')).toBeHidden();
    await expect(workspace.locator('.product-setup-refline')).toBeVisible();
    await workspace.locator('[data-ps-view="vis-product"]').click();
    await expect(workspace.locator('.product-setup-photo')).toBeVisible();
    expect(await readCorners()).toEqual(afterSide);

    // Reset to the saved (empty) setup, then freehand-trace a second area.
    await workspace.getByRole('button', { name: 'Reset to saved' }).click();
    await expect(workspace.getByRole('button', { name: 'Area 1' })).toHaveCount(0);
    await workspace.getByRole('button', { name: 'Freehand' }).click();
    await stage.scrollIntoViewIfNeeded();
    const traceBox = (await stage.boundingBox())!;
    const traceTo = (fx: number, fy: number): { x: number; y: number } => ({ x: traceBox.x + traceBox.width * fx, y: traceBox.y + traceBox.height * fy });
    const start = traceTo(0.55, 0.2);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const [fx, fy] of [[0.75, 0.2], [0.78, 0.5], [0.6, 0.72], [0.55, 0.2]] as const) {
      const point = traceTo(fx, fy);
      await page.mouse.move(point.x, point.y, { steps: 4 });
    }
    await page.mouse.up();
    await expect(workspace.getByText(/Staged a drawn safe area with \d+ corners/)).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Area 1', exact: true })).toBeVisible();

    // ONE atomic save persists the traced area; screenshot the real overlay.
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* safe-area corners/)).toBeVisible();
    // Evidence must show the stage: bring the toolbar + actual overlay back
    // into view (the save bar below scrolled it away) before capturing.
    await workspace.locator('[data-ps-viewbar]').scrollIntoViewIfNeeded();
    await stage.scrollIntoViewIfNeeded();
    await expect(workspace.locator('.product-setup-overlay')).toBeVisible();
    const shotPath = info.outputPath('product-setup-tools-journey.png');
    await page.screenshot({ path: shotPath });
    await info.attach('product-setup-tools-journey', { path: shotPath, contentType: 'image/png' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('model tools: dotted reference line, rectangle drag, side edit, interrupted trace rejected, zoom display-only', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openHarness(browser, viewport, 'setup-harness-model-tools.html');
  try {
    await attachEnv(info, browser, viewport, 'model tools journey');
    await assertHarness(page);
    expect(await hCall<string>(page, 'attachKind')).toBe('empty');
    expect(await hCall<string>(page, 'loadGlb', Buffer.from(cubeGlb()).toString('base64'))).toBe('ready');

    // Reference: two real surface picks + entered length → dashed line.
    await modelSetup(page, 'ref-pick-a').click();
    await harnessClick(page, 0.5, 0.5);
    await expect(modelSetup(page, 'status')).toContainText('Point A recorded');
    // Recording A auto-arms B: pick directly.
    await harnessClick(page, 0.58, 0.5);
    await expect(modelSetup(page, 'status')).toContainText('Point B recorded');
    await modelSetup(page, 'ref-mm').fill('250');
    await modelSetup(page, 'ref-fit').click();
    await expect(modelSetup(page, 'reference-scale')).toContainText('scale 1 unit =');
    const fitted = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    assert.ok(fitted?.reference && fitted.reference.lengthMm === 250, 'reference fitted');
    const fittedScale = fitted.mmPerUnit;
    assert.ok((fittedScale ?? 0) > 0, 'scale fitted');
    expect(await hCall<boolean>(page, 'referenceOverlay')).toBe(true);
    const refShot = info.outputPath('model-tools-reference.png');
    await page.screenshot({ path: refShot });
    await info.attach('model-tools-reference', { path: refShot, contentType: 'image/png' });

    const canvasBox = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
      await page.locator('#gl').scrollIntoViewIfNeeded();
      return page.evaluate((): { x: number; y: number; width: number; height: number } => {
        const api = (window as unknown as { __setupHarness: { canvasBox(): { x: number; y: number; width: number; height: number } | null } }).__setupHarness;
        const rect = api.canvasBox();
        if (!rect) throw new Error('harness canvas has no box.');
        return rect;
      });
    };
    const dragCanvas = async (x1: number, y1: number, x2: number, y2: number) => {
      const box = await canvasBox();
      await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 6 });
      await page.mouse.up();
    };

    // Rectangle tool: a diagonal drag on the planar face creates one
    // verified four-corner area with fills and side handles. (Front-left
    // face spans roughly x 0.30–0.50: stay left of the vertical edge.)
    await modelSetup(page, 'area-name').fill('Rect1');
    await modelSetup(page, 'tool-rectangle').click();
    await dragCanvas(0.36, 0.38, 0.46, 0.52);
    await expect(modelSetup(page, 'area-list')).toContainText('Rect1');
    const afterRect = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    assert.ok(afterRect, 'snapshot after rectangle drag');
    expect(afterRect.areas).toHaveLength(1);
    expect(afterRect.areas[0]!.points).toHaveLength(4);
    expect(await hCall<number>(page, 'safeAreaOverlays')).toBeGreaterThan(0);
    expect(await hCall<boolean>(page, 'referenceOverlay')).toBe(true);
    await expect(modelSetup(page, 'area-handles')).toBeVisible();
    const fillShot = info.outputPath('model-tools-rectangle.png');
    await page.screenshot({ path: fillShot });
    await info.attach('model-tools-rectangle', { path: fillShot, contentType: 'image/png' });

    // Side edit DIRECT: drag the visible side-0 midpoint on the model
    // itself — no form button. Exactly that side's two corners move, the
    // opposite side stays fixed.
    const rectBefore = afterRect.areas[0]!.points.map((p) => ({ ...p }));
    {
      const handle = modelSetup(page, 'canvas-handle-side-0');
      await expect(handle).toBeVisible();
      const handleBox = (await handle.boundingBox())!;
      const box = await canvasBox();
      const dx = box.width * 0.02;
      const dy = box.height * 0.02;
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + dx, handleBox.y + handleBox.height / 2 + dy, { steps: 5 });
      await page.mouse.up();
    }
    await expect(modelSetup(page, 'status')).toContainText('Side moved');
    const afterSide = (await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.areas[0]?.points;
    assert.ok(afterSide && afterSide.length === 4, 'four points after side edit');
    const moved = [0, 1, 2, 3].filter((i) => {
      const a = rectBefore[i]!;
      const b = afterSide[i]!;
      return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 1e-9;
    });
    expect(moved).toHaveLength(2);
    // The moved pair must be one side (adjacent indices); the other side stays fixed.
    const gap = (moved[1]! - moved[0]! + 4) % 4;
    expect([1, 3]).toContain(gap);

    // Escape mid-drag restores the staged polygon exactly.
    await modelSetup(page, 'handle-corner-0').click();
    const escapeBox = await canvasBox();
    await page.mouse.move(escapeBox.x + escapeBox.width * 0.41, escapeBox.y + escapeBox.height * 0.45);
    await page.mouse.down();
    await page.mouse.move(escapeBox.x + escapeBox.width * 0.44, escapeBox.y + escapeBox.height * 0.48, { steps: 3 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(modelSetup(page, 'status')).toContainText('Edit cancelled');
    const afterEscape = (await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.areas[0]?.points;
    assert.ok(afterEscape && afterEscape.length === 4, 'four points after escape');
    for (let i = 0; i < 4; i += 1) {
      const a = afterSide[i]!;
      const b = afterEscape[i]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeLessThan(1e-12);
    }

    // Corner edit DIRECT: drag the visible corner-0 dot on the model
    // itself — no form button. Corner 0 moves, opposite corner 2 stays
    // fixed, and the ring stays a 4-corner rectangle with side handles.
    const cornerBefore = (await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.areas[0]?.points;
    assert.ok(cornerBefore && cornerBefore.length === 4, 'four points before corner edit');
    {
      const handle = modelSetup(page, 'canvas-handle-corner-0');
      await expect(handle).toBeVisible();
      const handleBox = (await handle.boundingBox())!;
      const box = await canvasBox();
      const dx = box.width * 0.02;
      const dy = box.height * 0.02;
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2 + dx, handleBox.y + handleBox.height / 2 + dy, { steps: 5 });
      await page.mouse.up();
    }
    await expect(modelSetup(page, 'status')).toContainText('Corner moved');
    const afterCorner = (await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.areas[0]?.points;
    assert.ok(afterCorner && afterCorner.length === 4, 'four points after corner edit');
    const cornerMoved = [0, 1, 2, 3].filter((i) => {
      const a = cornerBefore[i]!;
      const b = afterCorner[i]!;
      return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 1e-9;
    });
    expect(cornerMoved).toContain(0);
    expect(cornerMoved).not.toContain(2);
    expect(Math.hypot(
      afterCorner[2]!.x - cornerBefore[2]!.x,
      afterCorner[2]!.y - cornerBefore[2]!.y,
      afterCorner[2]!.z - cornerBefore[2]!.z,
    )).toBeLessThan(1e-9);
    expect((await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.areas[0]?.status).toBe('current');
    await expect(modelSetup(page, 'area-handles')).toBeVisible();
    const handlesShot = info.outputPath('model-tools-handles.png');
    await page.screenshot({ path: handlesShot });
    await info.attach('model-tools-handles', { path: handlesShot, contentType: 'image/png' });

    // Interrupted freehand trace: leaving the surface discards the whole
    // stroke and retains the previous draft (gap 2 proof on real canvas).
    await modelSetup(page, 'tool-freehand').click();
    await modelSetup(page, 'area-name').fill('Trace1');
    await modelSetup(page, 'area-start').click();
    const traceBox = await canvasBox();
    await page.mouse.move(traceBox.x + traceBox.width * 0.45, traceBox.y + traceBox.height * 0.45);
    await page.mouse.down();
    await page.mouse.move(traceBox.x + traceBox.width * 0.5, traceBox.y + traceBox.height * 0.45, { steps: 2 });
    // Off the model: across empty stage background (a genuine miss).
    await page.mouse.move(traceBox.x + traceBox.width * 0.95, traceBox.y + traceBox.height * 0.9, { steps: 4 });
    await page.mouse.up();
    await expect(modelSetup(page, 'status')).toContainText('left the model surface');
    await expect(modelSetup(page, 'status')).toContainText('discarded');
    const afterTrace = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    expect(afterTrace?.areas).toHaveLength(1);
    expect(afterTrace?.areas[0]?.name).toBe('Rect1');
    // Nothing was stashed: Finish stays disabled until a clean trace starts.
    await expect(modelSetup(page, 'area-finish')).toBeDisabled();

    // Valid freehand drag-trace: one press-drag-release loop wholly on the
    // known planar face (same front-left face as the rectangle above)
    // stages one closed named valid area on release — the requested
    // drag-trace success proof on the real WebGL canvas.
    await modelSetup(page, 'area-name').fill('DragTrace');
    await modelSetup(page, 'area-start').click();
    {
      const box = await canvasBox();
      const pt = (fx: number, fy: number): { x: number; y: number } => ({
        x: box.x + box.width * fx,
        y: box.y + box.height * fy,
      });
      const start = pt(0.38, 0.4);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (const [fx, fy] of [[0.44, 0.4], [0.44, 0.5], [0.38, 0.5], [0.38, 0.4]] as const) {
        const p = pt(fx, fy);
        await page.mouse.move(p.x, p.y, { steps: 4 });
      }
      await page.mouse.up();
    }
    await expect(modelSetup(page, 'area-list')).toContainText('DragTrace');
    const afterDrag = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    assert.ok(afterDrag, 'snapshot after drag trace');
    expect(afterDrag.areas).toHaveLength(2);
    const dragArea = afterDrag.areas.find((area) => area.name === 'DragTrace');
    assert.ok(dragArea, 'drag trace stages DragTrace');
    expect(dragArea.points.length).toBeGreaterThanOrEqual(3);
    expect(dragArea.status).toBe('current');
    // The successful trace stages the area but leaves its drawing session
    // open under the existing session model (area-start stays armed);
    // cancel it via the existing control so the click-based zoom proof below
    // can start a fresh drawing. Staged areas are untouched.
    await modelSetup(page, 'area-cancel').click();
    await expect(modelSetup(page, 'area-list')).toContainText('DragTrace');

    // Zoom is display-only: scale identical, label intact, picks still work.
    expect((await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.mmPerUnit).toBe(fittedScale);
    await modelSetup(page, 'viewbar').locator('[data-ps-view="zoom"]').selectOption('200');
    await expect(modelSetup(page, 'viewbar').locator('[data-ps-view="zoom"]')).toHaveValue('200');
    expect((await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.mmPerUnit).toBe(fittedScale);
    expect(await hCall<boolean>(page, 'referenceOverlay')).toBe(true);
    await expect(modelSetup(page, 'reference-scale')).toContainText('scale 1 unit =');
    // Fresh surface picks at 200%: three magnified clicks still validate.
    await modelSetup(page, 'tool-freehand').click();
    await modelSetup(page, 'area-name').fill('Zoomface');
    await modelSetup(page, 'area-start').click();
    await harnessClick(page, 0.5, 0.48);
    await harnessClick(page, 0.54, 0.48);
    await harnessClick(page, 0.52, 0.54);
    await modelSetup(page, 'area-finish').click();
    await expect(modelSetup(page, 'area-list')).toContainText('Zoomface');
    const zoomed = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    expect(zoomed?.areas).toHaveLength(3);
    expect(zoomed?.mmPerUnit).toBe(fittedScale);
    const zoomShot = info.outputPath('model-tools-zoom200.png');
    await page.screenshot({ path: zoomShot });
    await info.attach('model-tools-zoom200', { path: zoomShot, contentType: 'image/png' });
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('product-setup tools wrap cleanly at 390x844 with real overlays', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const viewport = { width: 390, height: 844 };
  const { context, page, probe } = await openStation(browser, viewport);
  try {
    await attachEnv(info, browser, viewport, 'product-setup tools narrow');
    const frontPng = await syntheticPngBytes(page, '#3a6f2a', 300, 900);
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-name')).fill('Narrow Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Narrow Jacket');

    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    const spanOverlay = guided.locator('[data-guided="span-overlay"]');
    await expect(spanOverlay).toBeVisible();
    const tapSpan = async (fx: number, fy: number) => {
      await spanOverlay.scrollIntoViewIfNeeded();
      const box = (await spanOverlay.boundingBox())!;
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.mouse.down();
      await page.mouse.up();
    };
    await tapSpan(0.3, 0.5);
    await tapSpan(0.7, 0.5);
    await guided.locator('[data-guided="span-mm"]').fill('1300');
    await guided.locator('[data-guided="span-create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Calibration created from the reference span');

    // Reference line + label survive on the narrow calibrated stage.
    await expect(workspace.locator('.product-setup-refline')).toBeVisible();
    await expect(workspace.locator('.product-setup-reflabel')).toContainText('1,300 mm');

    // Rectangle creation works narrow; the toolbar wraps without page scroll.
    await workspace.getByRole('button', { name: 'Safe area', exact: true }).click();
    await workspace.getByRole('button', { name: 'Rectangle' }).click();
    const stage = workspace.locator('.product-setup-overlay').first();
    await stage.scrollIntoViewIfNeeded();
    const stageBox = (await stage.boundingBox())!;
    await page.mouse.move(stageBox.x + stageBox.width * 0.15, stageBox.y + stageBox.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.width * 0.45, stageBox.y + stageBox.height * 0.45, { steps: 5 });
    await page.mouse.up();
    await expect(workspace.getByText(/Staged a drawn safe area with 4 corners/)).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Area 1', exact: true })).toBeVisible();
    await expect(workspace.locator('[data-ps-viewbar]')).toBeVisible();
    // Portrait Fit on a real calibrated stage: the bounded stage contains
    // the whole photo + overlay (toolbar adjacent above), and staged mm
    // survive zoom + viewport resize (reuse the 300x900 portrait fixture).
    const narrowStage = workspace.locator('.product-setup-stage').first();
    const narrowPhoto = workspace.locator('.product-setup-photo').first();
    const narrowViewbar = workspace.locator('[data-ps-viewbar]').first();
    const cornersOf = async (): Promise<Array<[number, number]>> => {
      await workspace.locator('.product-setup-advanced summary').click();
      const text = await workspace.locator('.product-setup-advanced-list').first().textContent() ?? '';
      await workspace.locator('.product-setup-advanced summary').click();
      const found: Array<[number, number]> = [];
      for (const match of text.matchAll(/Corner \d+: (-?[\d.]+), (-?[\d.]+) mm/g)) {
        found.push([Number(match[1]), Number(match[2])]);
      }
      return found;
    };
    const stageFit = (await narrowStage.boundingBox())!;
    const photoFit = (await narrowPhoto.boundingBox())!;
    const overlayFit = (await stage.boundingBox())!;
    expect(stageFit.height).toBeLessThanOrEqual(viewport.height * 0.6 + 2);
    expect(photoFit.height).toBeLessThanOrEqual(stageFit.height + 1);
    expect(photoFit.width).toBeLessThanOrEqual(stageFit.width + 1);
    for (const [a, b] of [
      [overlayFit.x, photoFit.x],
      [overlayFit.y, photoFit.y],
      [overlayFit.width, photoFit.width],
      [overlayFit.height, photoFit.height],
    ] as const) {
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    }
    const barBox = (await narrowViewbar.boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(stageFit.y + 1);
    const cornersFit = await cornersOf();
    expect(cornersFit).toHaveLength(4);
    await workspace.locator('[data-ps-view="zoom"]').selectOption('50');
    expect(await cornersOf()).toEqual(cornersFit);
    await workspace.locator('[data-ps-view="zoom"]').selectOption('200');
    expect(await cornersOf()).toEqual(cornersFit);
    await workspace.locator('[data-ps-view="zoom"]').selectOption('100');
    const stageRefit = (await narrowStage.boundingBox())!;
    expect(stageRefit.height).toBeLessThanOrEqual(viewport.height * 0.6 + 2);
    await page.setViewportSize({ width: 390, height: 700 });
    const stageResized = (await narrowStage.boundingBox())!;
    expect(stageResized.height).toBeLessThanOrEqual(700 * 0.6 + 2);
    expect(await cornersOf()).toEqual(cornersFit);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // Evidence must show the stage: bring the toolbar + actual overlay back
    // into view before capturing.
    await narrowViewbar.scrollIntoViewIfNeeded();
    await narrowStage.scrollIntoViewIfNeeded();
    const narrowShot = info.outputPath('product-setup-tools-narrow.png');
    await page.screenshot({ path: narrowShot });
    await info.attach('product-setup-tools-narrow', { path: narrowShot, contentType: 'image/png' });
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});
