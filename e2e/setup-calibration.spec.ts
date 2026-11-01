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
async function photoDetails(workspace: ReturnType<Page['locator']>): Promise<void> {
  if (!await workspace.isVisible()) {
    await builder(workspace.page(), 'job-step-2').click();
    await builder(workspace.page(), 'editor-setup').click();
  }
  if (!await workspace.locator('#photo-context').isVisible()) await workspace.locator('[data-fkey="photo-properties"]').click();
}

async function createBranchIssue(page: Page): Promise<void> {
  await (await shown(page, 'job-to-placements')).click();
  await expect(builder(page, 'product-editor')).toHaveAttribute('data-mode', 'logos');
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
  await page.goto(pathToFileURL(outputPath).href + (fileName.includes('contextual-outline') ? '#context' : ''));
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
      await modelSetup(page, 'tool-freehand').click();
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
      await expect(workspace.getByRole('button', { name: 'Safe area', exact: true })).toBeVisible();
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
      await workspace.locator('.product-setup-overlay').first().press('Enter');
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
        await fresh.getByRole('button', {name:/^Open setup for/}).first().click();
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
        await workspace.locator('.product-setup-overlay').first().press('Enter');
      };
      const renameActive = async (name: string) => {
        await workspace.locator('[data-fkey^="psv-area-name-"]').fill(name);
        await workspace.locator('[data-fkey^="psv-area-name-"]').press('Tab');
        await expect(workspace.getByText(`Renamed area to “${name}”.`)).toBeVisible();
      };
      await drawQuad(0.08, 0.28);
      await renameActive('Left chest');
      await photoDetails(workspace);
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
        await fresh.getByRole('button', {name:/^Open setup for/}).first().click();
        await freshWorkspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
        await photoDetails(freshWorkspace);
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
        await builder(page, 'job-step-2').click(); await builder(page, 'editor-setup').click();
        const returnWorkspace = builder(page, 'product-workspace');
        await returnWorkspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
        await photoDetails(returnWorkspace);
        await returnWorkspace.getByRole('button', { name: 'Right chest', exact: true }).click();
        const twinDelete = returnWorkspace.locator('[data-fkey^="psv-area-delete-"]');
        await photoDetails(returnWorkspace);
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
      await workspace.locator('.product-setup-overlay').first().press('Enter');
    };
    await drawQuad(0.08, 0.28);
    await photoDetails(workspace);
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    await drawQuad(0.72, 0.92);
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();

    // Delete the second (sibling) area with no placements anywhere: its
    // region and variant links must vanish — a real delete.
    await workspace.getByRole('button', { name: /Area 2/ }).first().click();
    await photoDetails(workspace);
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
    await workspace.locator('.product-setup-overlay').first().press('Enter');
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
    await photoDetails(workspace);
    await workspace.locator('[data-fkey^="psv-area-name-"]').fill('Stale chest v2');
    await workspace.locator('[data-fkey^="psv-area-name-"]').press('Tab');
    await expect(workspace.getByText('Renamed area to “Stale chest v2”.')).toBeVisible();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
    await (await shown(page, 'job-step-2')).click();
    await expect(builder(page, 'product-editor')).toHaveAttribute('data-mode', 'logos');
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
      await workspace.locator('.product-setup-overlay').first().press('Enter');
    };
    await drawQuad(0.2, 0.4);
    await photoDetails(workspace);
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
    await builder(page, 'job-step-2').click(); await builder(page, 'editor-setup').click();
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
    await builder(page, 'job-step-2').click(); await builder(page, 'editor-setup').click();

    const workspace = builder(page, 'product-workspace');
    const variantSelect = builder(page, 'workspace-variant');
    const drawQuad = async (x0: number, x1: number) => {
      const stage = workspace.locator('.product-setup-overlay').first();
      for (const [fx, fy] of [[x0, 0.3], [x1, 0.3], [x1, 0.7], [x0, 0.7]] as const) {
        await stage.scrollIntoViewIfNeeded();
        const box = (await stage.boundingBox())!;
        await stage.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
      }
      await workspace.locator('.product-setup-overlay').first().press('Enter');
    };
    // Variant B stages an area FIRST (bucket seeds with no siblings).
    await variantSelect.selectOption('P-SHARED-02-B');
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await photoDetails(workspace);
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    await drawQuad(0.6, 0.9);
    // Variant A stages and SAVES another area meanwhile.
    await variantSelect.selectOption('P-SHARED-02-A');
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await photoDetails(workspace);
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
    await expect(page.getByText('This product uses a 3D model — set it up on the model below (no photos needed). Staged 3D references and areas save to the master with “Save 3D setup”.', { exact: true })).toHaveCount(0);
    const rectangleButton = (await modelPane.locator('[data-model-setup-hook="tool-rectangle"]').boundingBox())!;
    const freehandButton = (await modelPane.locator('[data-model-setup-hook="tool-freehand"]').boundingBox())!;
    expect(Math.abs(rectangleButton.y - freehandButton.y)).toBeLessThan(1);
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
    const ms = (name: string) => modelPane.locator(`[data-model-setup-hook="${name}"]`);
    await ms('context-measure').click();
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
    await ms('tool-freehand').click();
    await surfaceClick(0.44, 0.44);
    await surfaceClick(0.56, 0.44);
    await surfaceClick(0.56, 0.52);
    await surfaceClick(0.44, 0.52);
    await page.keyboard.press('Enter');
    await expect(ms('area-list')).toContainText('Chest');
    await ms('context-more').click();
    await expect(ms('setup-save')).toBeVisible();
    await modelPane.locator('[data-canvas-context-dismiss]').click();
    await ms('tool-edit').click();
    await builder(page, 'product-model-expand').click();
    await ms('context-areas').click();
    await expect(ms('area-rename')).toBeVisible();
    await expect(ms('canvas-handle-corner-0')).toBeVisible();
    const outlineDesktop = info.outputPath('station-outline-enlarged.png');
    await page.screenshot({path:outlineDesktop});
    await info.attach('station-outline-enlarged', {path:outlineDesktop,contentType:'image/png'});
    await page.setViewportSize({width:390,height:844});
    await ms('area-rename').scrollIntoViewIfNeeded();
    await expect(ms('area-rename')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await modelPane.locator('[data-canvas-context-dismiss]').click();
    const outlineNarrow = info.outputPath('station-outline-narrow.png');
    await page.screenshot({path:outlineNarrow});
    await info.attach('station-outline-narrow', {path:outlineNarrow,contentType:'image/png'});
    await page.setViewportSize(viewport);
    await builder(page, 'product-model-expand').click();
    await ms('tool-rotate').click();
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
    await expect(builder(page, 'product-editor').locator('.editor-provisional')).toBeVisible();
    const canvas = modelPane.locator('canvas');
    const surfaceClick = async (fx: number, fy: number) => {
      await canvas.scrollIntoViewIfNeeded();
      const box = (await canvas.boundingBox())!;
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    };
    const ms = (name: string) => modelPane.locator(`[data-model-setup-hook="${name}"]`);
    await ms('context-measure').click();
    await ms('ref-pick-a').click();
    await surfaceClick(0.5, 0.5);
    await surfaceClick(0.6, 0.5);
    await ms('ref-mm').fill('470');
    await ms('ref-fit').click();
    await expect(ms('reference-scale')).toContainText('scale 1 unit =');

    const drawArea = async (name: string, quad: ReadonlyArray<readonly [number, number]>) => {
      await ms('area-name').fill(name);
      await ms('tool-freehand').click();
      for (const [fx, fy] of quad) await surfaceClick(fx, fy);
      await page.keyboard.press('Enter');
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
    await ms('context-areas').click();
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
    await ms('context-measure').click();
    await ms('ref-mm').fill('500');
    await ms('ref-fit').click();
    await expect(ms('reference-scale')).toContainText('scale 1 unit =');
    await ms('context-areas').click();
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
    await modelSetup(first.page, 'tool-freehand').click();
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
    await modelSetup(page, 'tool-freehand').click();
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
      await fresh.getByRole('button', {name:/^Open setup for/}).first().click();
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

test('product-setup tools: dotted reference, rectangle to independent polygon, edge insertion, rollback, zoom, visibility, point drawing', async ({ browser }, info) => {
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
    await expect(workspace.locator('.product-setup-midpoint').first()).toBeVisible();

    const readCorners = async (): Promise<Array<[number, number]>> => {
      await photoDetails(workspace);
      await workspace.locator('.product-setup-advanced summary').click();
      const text = await workspace.locator('.product-setup-advanced-list').first().textContent() ?? '';
      await workspace.locator('.product-setup-advanced summary').click();
      const found: Array<[number, number]> = [];
      for (const match of text.matchAll(/Corner \d+: (-?[\d.]+), (-?[\d.]+) mm/g)) {
        found.push([Number(match[1]), Number(match[2])]);
      }
      await workspace.locator('#photo-context [data-canvas-context-dismiss]').click();
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

    // Once nonrectangular, ALL corners stay independently editable.
    for (const index of [1, 2, 3]) expect(corners200[index]).toEqual(corners100[index]);
    const secondHandle = workspace.locator('.product-setup-vertex').first();
    await secondHandle.scrollIntoViewIfNeeded();
    const secondBox = (await secondHandle.boundingBox())!;
    await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(secondBox.x + secondBox.width / 2 + 10, secondBox.y + secondBox.height / 2 + 8, { steps: 4 });
    await page.mouse.up();
    const beforeInsert = await readCorners();
    expect(beforeInsert[0]).not.toEqual(corners200[0]);
    for (const index of [1, 2, 3]) expect(beforeInsert[index]).toEqual(corners200[index]);
    await workspace.locator('.product-setup-midpoint').first().click();
    let afterSide = await readCorners();
    expect(afterSide).toHaveLength(5);
    expect(afterSide[0]).toEqual(beforeInsert[0]);
    expect(afterSide.slice(2)).toEqual(beforeInsert.slice(1));

    // Dense photo rings: enlarged hit targets overlap, but the nearest
    // visible square owns the edit even when an edge target is painted later.
    for (let count = 0; count < 3; count += 1) await workspace.locator('.product-setup-midpoint').first().click();
    const denseBefore = await readCorners(); expect(denseBefore).toHaveLength(8);
    const denseHandle = workspace.locator('.product-setup-vertex').first();
    await denseHandle.scrollIntoViewIfNeeded(); const denseBox = (await denseHandle.boundingBox())!;
    await page.mouse.move(denseBox.x+denseBox.width/2,denseBox.y+denseBox.height/2); await page.mouse.down();
    await page.mouse.move(denseBox.x+denseBox.width/2-8,denseBox.y+denseBox.height/2-8,{steps:4}); await page.mouse.up();
    afterSide = await readCorners(); expect(afterSide[0]).not.toEqual(denseBefore[0]);
    expect(afterSide.slice(1)).toEqual(denseBefore.slice(1));

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
    await expect(workspace.getByText('Safe-area tool: drag a corner, use an edge handle to insert, or pick a corner below. Photo clicks never alter the polygon here.')).toBeVisible();
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

    // Polygon is click-only; Backspace undoes, first white square closes.
    await workspace.getByRole('button', { name: 'Reset to saved' }).click();
    await expect(workspace.getByRole('button', { name: 'Area 1' })).toHaveCount(0);
    await workspace.getByRole('button', { name: 'Polygon', exact: true }).click();
    const tapPolygon = async (fx: number, fy: number) => {
      await stage.scrollIntoViewIfNeeded(); const box = (await stage.boundingBox())!;
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    };
    await tapPolygon(.55,.2); await tapPolygon(.75,.2); await tapPolygon(.78,.5);
    await stage.press('Backspace');
    await expect(workspace.locator('.product-setup-draw')).toHaveCount(2);
    await tapPolygon(.78,.5); await tapPolygon(.6,.72);
    await expect(workspace.locator('.product-setup-draw')).toHaveCount(4);
    await workspace.locator('.product-setup-draw-first').click();
    await expect(workspace.getByText(/Staged a drawn safe area with 4 corners/)).toBeVisible();
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

test('model tools: independent polygon corners, insertion, rollback, point drawing and zoom', async ({ browser }, info) => {
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
    const cameraBefore = await hCall<{ x: number; y: number }>(page, 'projectProbe');
    await dragCanvas(0.36, 0.38, 0.46, 0.52);
    const cameraAfter = await hCall<{ x: number; y: number }>(page, 'projectProbe');
    expect(Math.hypot(cameraAfter.x - cameraBefore.x, cameraAfter.y - cameraBefore.y)).toBeLessThan(0.01);
    await expect(modelSetup(page, 'area-list')).toContainText('Rect1');
    const afterRect = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    assert.ok(afterRect, 'snapshot after rectangle drag');
    expect(afterRect.areas).toHaveLength(1);
    expect(afterRect.areas[0]!.points).toHaveLength(4);
    expect(await hCall<number>(page, 'safeAreaOverlays')).toBeGreaterThan(0);
    expect(await hCall<boolean>(page, 'referenceOverlay')).toBe(true);
    await page.getByText('Edit individual corners', { exact: true }).click();
    await expect(modelSetup(page, 'area-handles')).toBeVisible();
    const fillShot = info.outputPath('model-tools-rectangle.png');
    await page.screenshot({ path: fillShot });
    await info.attach('model-tools-rectangle', { path: fillShot, contentType: 'image/png' });

    // Drag exactly one white square: rectangle becomes a general polygon.
    const original = afterRect.areas[0]!.points;
    const dragCorner = async (dx: number, dy: number) => {
      const handle = modelSetup(page, 'canvas-handle-corner-0');
      await expect(handle).toBeVisible();
      const hb = (await handle.boundingBox())!;
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
      await page.mouse.move(hb.x + hb.width / 2 + dx, hb.y + hb.height / 2 + dy, { steps: 5 }); await page.mouse.up();
    };
    await dragCorner(8, 8);
    await expect(modelSetup(page, 'status')).toContainText('Corner moved');
    const firstEdit = (await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!.points;
    expect(firstEdit[0]).not.toEqual(original[0]); expect(firstEdit.slice(1)).toEqual(original.slice(1));
    await dragCorner(7, -3);
    const secondEdit = (await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!.points;
    expect(secondEdit[0]).not.toEqual(firstEdit[0]); expect(secondEdit.slice(1)).toEqual(original.slice(1));
    // Invalid surface release cannot replace the valid area.
    const box = await canvasBox();
    const handle = modelSetup(page, 'canvas-handle-corner-0');
    await expect(handle).toBeVisible();
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x+hb.width/2,hb.y+hb.height/2); await page.mouse.down();
    await page.mouse.move(box.x+box.width*.97,box.y+box.height*.95,{steps:4}); await page.mouse.up();
    expect((await hCall<HarnessSnapshot>(page,'lastSnapshot')).areas[0]!.points).toEqual(secondEdit);
    // Escape rolls back a valid preview as well.
    await expect(modelSetup(page,'canvas-handle-corner-0')).toBeVisible();
    const cancelHandle = (await modelSetup(page,'canvas-handle-corner-0').boundingBox())!;
    await page.mouse.move(cancelHandle.x+cancelHandle.width/2,cancelHandle.y+cancelHandle.height/2); await page.mouse.down();
    await page.mouse.move(cancelHandle.x+cancelHandle.width/2+10,cancelHandle.y+cancelHandle.height/2+4,{steps:3});
    await page.keyboard.press('Escape'); await page.mouse.up();
    expect((await hCall<HarnessSnapshot>(page,'lastSnapshot')).areas[0]!.points).toEqual(secondEdit);
    // Move across the opposite edge to make a true self-crossing polygon.
    // A neighbour-centre release is unsuitable: fractional pointer rounding
    // can leave a tiny valid gap in one browser rather than an exact duplicate.
    const sourceHandle = (await modelSetup(page,'canvas-handle-corner-0').boundingBox())!;
    const neighbour = (await modelSetup(page,'canvas-handle-corner-1').boundingBox())!;
    const opposite = (await modelSetup(page,'canvas-handle-corner-2').boundingBox())!;
    const startX = sourceHandle.x+sourceHandle.width/2, startY = sourceHandle.y+sourceHandle.height/2;
    const midX = (neighbour.x+neighbour.width/2+opposite.x+opposite.width/2)/2;
    const midY = (neighbour.y+neighbour.height/2+opposite.y+opposite.height/2)/2;
    await page.mouse.move(startX,startY); await page.mouse.down();
    await page.mouse.move(midX+(midX-startX)*.2,midY+(midY-startY)*.2,{steps:4}); await page.mouse.up();
    expect((await hCall<HarnessSnapshot>(page,'lastSnapshot')).areas[0]!.points).toEqual(secondEdit);
    // Edge square inserts a real surface point and preserves existing points.
    await modelSetup(page, 'canvas-handle-side-0').click();
    const inserted = (await hCall<HarnessSnapshot>(page,'lastSnapshot')).areas[0]!.points;
    expect(inserted).toHaveLength(5); expect(inserted[0]).toEqual(secondEdit[0]); expect(inserted.slice(2)).toEqual(secondEdit.slice(1));
    await modelSetup(page, 'canvas-handle-corner-1').focus(); await page.keyboard.press('Delete');
    expect((await hCall<HarnessSnapshot>(page,'lastSnapshot')).areas[0]!.points).toEqual(secondEdit);
    // No pointer-move trace: dragging in Polygon mode adds no points or area.
    await modelSetup(page,'tool-freehand').click();
    await dragCanvas(.38,.4,.44,.5);
    expect((await hCall<HarnessSnapshot>(page,'lastSnapshot')).areas).toHaveLength(1);
    await expect(modelSetup(page,'live-outline').locator('rect')).toHaveCount(0);
    await modelSetup(page,'area-name').fill('Clicked polygon');
    await harnessClick(page,.38,.4); await harnessClick(page,.44,.4); await harnessClick(page,.44,.5);
    await page.keyboard.press('Backspace');
    await expect(modelSetup(page,'live-outline').locator('g')).toHaveCount(2);
    await modelSetup(page,'area-undo').press('Enter');
    await expect(modelSetup(page,'live-outline').locator('g')).toHaveCount(1);
    await harnessClick(page,.44,.4); await harnessClick(page,.44,.5); await harnessClick(page,.38,.5);
    await modelSetup(page,'drawing-close').click();
    await expect(modelSetup(page,'area-list')).toContainText('Clicked polygon');
    const clicked = await hCall<HarnessSnapshot>(page,'lastSnapshot');
    expect(clicked.areas).toHaveLength(2); expect(clicked.areas[1]!.points).toHaveLength(4);
    // Restore the exact native-coordinate snapshot and keep editing it.
    await modelSetup(page,'advanced-summary').click();
    const downloadEvent = page.waitForEvent('download'); await modelSetup(page,'setup-save').click();
    const savedPath = await (await downloadEvent).path(); assert.ok(savedPath);
    const savedText = await readFile(savedPath,'utf8');
    expect(await hCall<boolean>(page,'restore',savedText)).toBe(true);
    const reopened = await hCall<HarnessSnapshot>(page,'lastSnapshot');
    for (const area of clicked.areas) expect(reopened.areas.find((item) => item.id === area.id)?.points).toEqual(area.points);
    await expect(modelSetup(page,'canvas-handle-corner-0')).toBeVisible();
    const handlesShot = info.outputPath('model-tools-handles.png');
    await page.screenshot({ path: handlesShot });

    // Zoom is display-only: scale identical, label intact, picks still work.
    expect((await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.mmPerUnit).toBe(fittedScale);
    await modelSetup(page, 'viewbar').locator('[data-ps-view="zoom"]').selectOption('200');
    await expect(modelSetup(page, 'viewbar').locator('[data-ps-view="zoom"]')).toHaveValue('200');
    expect((await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.mmPerUnit).toBe(fittedScale);
    expect(await hCall<boolean>(page, 'referenceOverlay')).toBe(true);
    await expect(modelSetup(page, 'reference-scale')).toContainText('scale 1 unit =');
    // Escape leaves drawing mode; selecting Freehand again is sufficient.
    await modelSetup(page, 'tool-freehand').click();
    await page.keyboard.press('Escape');
    await expect(modelSetup(page, 'tool-rotate')).toHaveAttribute('aria-pressed', 'true');
    // Fresh surface picks at 200%: three magnified clicks still validate.
    await modelSetup(page, 'tool-freehand').click();
    await modelSetup(page, 'area-name').fill('Zoomface');
    await harnessClick(page, 0.5, 0.48);
    await harnessClick(page, 0.54, 0.48);
    await harnessClick(page, 0.52, 0.54);
    await page.keyboard.press('Enter');
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
      await photoDetails(workspace);
      await workspace.locator('.product-setup-advanced summary').click();
      const text = await workspace.locator('.product-setup-advanced-list').first().textContent() ?? '';
      await workspace.locator('.product-setup-advanced summary').click();
      const found: Array<[number, number]> = [];
      for (const match of text.matchAll(/Corner \d+: (-?[\d.]+), (-?[\d.]+) mm/g)) {
        found.push([Number(match[1]), Number(match[2])]);
      }
      await workspace.locator('#photo-context [data-canvas-context-dismiss]').click();
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

test('model safe-area fill follows a raised fold without changing saved coordinates or painting the back', async ({ browser }, info) => {
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openHarness(browser, viewport, 'raised-fold.html');
  try {
    await attachEnv(info, browser, viewport, 'raised mesh surface overlay');
    expect(await hCall<string>(page, 'loadGlb', Buffer.from(cubeGlb(true)).toString('base64'))).toBe('ready');
    await hCall(page, 'front');
    await expect.poll(() => hCall<number>(page, 'nonBackgroundPixels')).toBeGreaterThan(500);
    const bareFront = await hCall<number[]>(page, 'centerPixel');
    await hCall(page, 'back');
    // Wait for the renderer after changing views, not a fixed-duration sleep.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const bareBack = await hCall<number[]>(page, 'centerPixel');
    await hCall(page, 'front');
    const corners = [
      { x: -0.45, y: -0.45, z: 0.5 }, { x: 0.45, y: -0.45, z: 0.5 },
      { x: 0.45, y: 0.45, z: 0.5 }, { x: -0.45, y: 0.45, z: 0.5 },
    ];
    const setup = { version: '0.1.0-provisional-model-setup', productId: 'SYN-BOX', variantId: null, assetKey: 'harness-asset-1',
      reference: { id: 'reference', a: corners[0], b: corners[1], lengthMm: 1300 },
      areas: [{ id: 'fold-area', name: 'Fold panel', points: corners }],
    };
    expect(await hCall<boolean>(page, 'restore', JSON.stringify(setup))).toBe(true);
    // The centre is 0.15 model units ABOVE the old flat fan. It must still
    // carry the blue area tint because the new skin uses the asset triangles.
    await expect.poll(async () => {
      const pixel = await hCall<number[]>(page, 'centerPixel');
      return pixel.slice(0, 3).reduce((sum, v, i) => sum + Math.abs(v - bareFront[i]!), 0);
    }).toBeGreaterThan(15);
    expect((await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!.points).toEqual(corners);
    const screenshot = info.outputPath('model-raised-fold.png');
    await page.locator('[data-model-setup-hook="viewbar"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot });
    await info.attach('raised-fold-overlay', { path: screenshot, contentType: 'image/png' });
    await hCall(page, 'back');
    await expect.poll(() => hCall<number[]>(page, 'centerPixel')).toEqual(bareBack);
    expect((await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!.points).toEqual(corners);
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

test('model rectangle drag on a non-planar surface stages a visible area (perimeter fallback)', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openHarness(browser, viewport, 'setup-harness-curved-rectangle.html');
  try {
    await attachEnv(info, browser, viewport, 'model curved-surface rectangle fallback');
    await assertHarness(page);
    expect(await hCall<string>(page, 'attachKind')).toBe('empty');
    // Non-planar synthetic surface: the front face is a raised pyramid, so a
    // flat 4-corner rectangle cannot sit on it (press/release face normals
    // diverge). The drag must fall back to a surface-following perimeter ring
    // of real raycast picks and still stage a visible named area.
    expect(await hCall<string>(page, 'loadGlb', Buffer.from(cubeGlb(true)).toString('base64'))).toBe('ready');

    await modelSetup(page, 'ref-pick-a').click();
    await harnessClick(page, 0.5, 0.5);
    await expect(modelSetup(page, 'reference-readout')).toContainText('A (');
    // Recording A auto-arms B: click the surface directly (clicking Pick B
    // now would disarm it).
    await harnessClick(page, 0.58, 0.5);
    await expect(modelSetup(page, 'reference-readout')).toContainText('B (');
    await modelSetup(page, 'ref-mm').fill('250');
    await modelSetup(page, 'ref-fit').click();
    await expect(modelSetup(page, 'reference-scale')).toContainText('scale 1 unit =');

    const canvasBox = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
      await page.locator('#gl').scrollIntoViewIfNeeded();
      return page.evaluate((): { x: number; y: number; width: number; height: number } => {
        const api = (window as unknown as { __setupHarness: { canvasBox(): { x: number; y: number; width: number; height: number } | null } }).__setupHarness;
        const rect = api.canvasBox();
        if (!rect) throw new Error('harness canvas has no box.');
        return rect;
      });
    };
    await modelSetup(page, 'area-name').fill('CurvedRect');
    await modelSetup(page, 'tool-rectangle').click();
    {
      const box = await canvasBox();
      await page.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.38);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.46, box.y + box.height * 0.52, { steps: 6 });
      await page.mouse.up();
    }
    await expect(modelSetup(page, 'area-list')).toContainText('CurvedRect');
    const snapshot = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
    assert.ok(snapshot && snapshot.areas.length === 1, 'one staged area on the curved surface');
    expect(snapshot.areas[0]!.points.length).toBeGreaterThan(4);
    expect(snapshot.areas[0]!.status).toBe('current');
    expect(await hCall<number>(page, 'safeAreaOverlays')).toBeGreaterThan(0);
    await expect(modelSetup(page, 'status')).toContainText('added');
    // An off-model release must preserve the exact previously staged geometry.
    await modelSetup(page, 'tool-rectangle').click();
    {
      const box = await canvasBox();
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.45);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.98, box.y + box.height * 0.98, { steps: 6 });
      await page.mouse.up();
    }
    await expect(modelSetup(page, 'status')).toContainText('Release missed');
    expect((await hCall<HarnessSnapshot | null>(page, 'lastSnapshot'))?.areas).toEqual(snapshot.areas);
    // Surface-following rings with more than four points remain editable.
    await modelSetup(page,'tool-rotate').click();
    const corner = modelSetup(page,'canvas-handle-corner-0'); await expect(corner).toBeVisible();
    const handle = (await corner.boundingBox())!;
    await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2); await page.mouse.down();
    await page.mouse.move(handle.x+handle.width/2+7,handle.y+handle.height/2+2,{steps:4}); await page.mouse.up();
    await expect(modelSetup(page,'status')).toContainText('Corner moved');
    const edited = (await hCall<HarnessSnapshot>(page,'lastSnapshot')).areas[0]!.points;
    expect(edited).toHaveLength(snapshot.areas[0]!.points.length);
    expect(edited[0]).not.toEqual(snapshot.areas[0]!.points[0]);
    expect(edited.slice(1)).toEqual(snapshot.areas[0]!.points.slice(1));
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

for (const viewport of VIEWPORTS) {
  test(`model clicked outlines accept optional names and avoid name collisions (${viewport.label})`, async ({ browser }, info) => {
    const { context, page, probe } = await openHarness(browser, viewport, `setup-unnamed-${viewport.label}.html`);
    try {
      await attachEnv(info, browser, viewport, 'model optional area name');
      expect(await hCall<string>(page, 'loadGlb', Buffer.from(cubeGlb()).toString('base64'))).toBe('ready');
      const draw = async (name: string): Promise<void> => {
        await modelSetup(page, 'tool-freehand').click();
        await modelSetup(page, 'area-name').fill(name);
        for (const [x, y] of [[0.44, 0.44], [0.56, 0.44], [0.56, 0.52], [0.44, 0.52]]) {
          await harnessClick(page, x!, y!);
        }
        await modelSetup(page, 'area-finish').click();
      };
      await draw('');
      await expect(modelSetup(page, 'area-list')).toContainText('Safe area 1');
      // The next automatic candidate must skip a manually entered name,
      // including a different case, rather than rejecting an optional field.
      await draw('safe area 3');
      await draw('   ');
      await expect(modelSetup(page, 'area-list')).toContainText('Safe area 4');
      const snapshot = await hCall<HarnessSnapshot | null>(page, 'lastSnapshot');
      expect(snapshot?.areas.map((area) => area.name)).toEqual(['Safe area 1', 'safe area 3', 'Safe area 4']);
      expect(snapshot?.areas.every((area) => area.points.length === 4)).toBe(true);
      expectOfflineClean(probe);
    } finally { await context.close(); }
  });
}

// Regression: dense polygons must not raycast every handle on idle frames.
test('dense model area keeps exact points while idle and zoom avoid repeated picking', async ({ browser }, info) => {
  const viewport = {width:1280,height:900};
  const {context,page,probe} = await openHarness(browser,viewport,'dense-points.html');
  try {
    await attachEnv(info,browser,viewport,'64-point polygon idle and zoom work');
    expect(await hCall<string>(page,'loadGlb',Buffer.from(cubeGlb()).toString('base64'))).toBe('ready');
    await hCall(page,'front');
    const points = Array.from({length:64},(_,i)=>({x:.22*Math.cos(i*Math.PI/32),y:.22*Math.sin(i*Math.PI/32),z:.5}));
    const setup = {version:'0.1.0-provisional-model-setup',productId:'SYN-BOX',assetKey:'harness-asset-1',reference:null,areas:[{id:'dense',name:'Dense ring',points}]};
    expect(await hCall<boolean>(page,'restore',JSON.stringify(setup))).toBe(true);
    await page.locator('#gl').scrollIntoViewIfNeeded();
    await expect(modelSetup(page,'canvas-handle-corner-0')).toBeVisible();
    // Let resize/orbit damping settle before counting idle frame work.
    await hCall(page,'profileFrames','idle');
    const idle = await hCall<{projections:number;picks:number}>(page,'profileFrames','idle');
    await info.attach('idle-work',{body:JSON.stringify(idle),contentType:'application/json'});
    expect(idle.picks).toBe(0);
    expect(idle.projections).toBeLessThan(5);
    const before = await hCall<HarnessSnapshot>(page,'lastSnapshot');
    const zoom = await hCall<{projections:number;picks:number}>(page,'profileFrames','zoom');
    await info.attach('zoom-work',{body:JSON.stringify(zoom),contentType:'application/json'});
    // One changed view may check all 128 handles; 20 identical frames may not.
    expect(zoom.projections).toBeGreaterThan(0);
    expect(zoom.projections).toBeLessThan(64*2*5);
    expect(zoom.picks).toBeLessThan(64*2*5);
    const moving = await hCall<{projections:number;picks:number}>(page,'profileFrames','moving');
    await info.attach('moving-zoom-work',{body:JSON.stringify(moving),contentType:'application/json'});
    await writeFile(info.outputPath('point-work.json'),JSON.stringify({idle,zoom,moving},null,2));
    expect(moving.picks).toBeLessThan(64*2*3);
    expect((await hCall<HarnessSnapshot>(page,'lastSnapshot')).areas).toEqual(before.areas);
    await expect(modelSetup(page,'canvas-handle-corner-0')).toBeVisible();
    await page.screenshot({path:info.outputPath('dense-zoom.png')});
    await hCall(page,'back');
    await expect(modelSetup(page,'canvas-handle-corner-0')).toBeHidden();
    expect((await hCall<HarnessSnapshot>(page,'lastSnapshot')).areas[0]!.points).toEqual(points);
    expectOfflineClean(probe);
  } finally {await context.close();}
});


test('contextual outline editor: More, rename, direct points, bends and persistence', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const viewport = { width: 1280, height: 900 };
  const { context, page, probe } = await openHarness(browser, viewport, 'contextual-outline.html');
  try {
    await attachEnv(info, browser, viewport, 'contextual on-model outline editor');
    expect(await hCall<string>(page, 'loadGlb', Buffer.from(cubeGlb()).toString('base64'))).toBe('ready');
    await modelSetup(page, 'context-more').click();
    await expect(modelSetup(page, 'setup-save')).toBeVisible();
    await expect(modelSetup(page, 'reference-readout')).toBeVisible();
    await modelSetup(page, 'context-measure').click();
    await modelSetup(page, 'ref-pick-a').click();
    await harnessClick(page, .5, .5); await harnessClick(page, .58, .5);
    await modelSetup(page, 'context-measure').click();
    await modelSetup(page, 'ref-mm').fill('250'); await modelSetup(page, 'ref-fit').click();
    await page.locator('[data-canvas-context-dismiss]').click();
    await modelSetup(page, 'area-name').fill('Chest');
    await modelSetup(page, 'tool-rectangle').click();
    await page.locator('#gl').scrollIntoViewIfNeeded();
    const box = (await page.locator('#gl').boundingBox())!;
    await page.mouse.move(box.x + box.width*.36, box.y + box.height*.38); await page.mouse.down();
    await page.mouse.move(box.x + box.width*.46, box.y + box.height*.52, {steps:6}); await page.mouse.up();
    const original = (await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!;
    expect(original.points).toHaveLength(4);
    await modelSetup(page, 'context-areas').click();
    await modelSetup(page, 'area-rename').fill('  Left chest  '); await modelSetup(page, 'area-rename-apply').click();
    const renamed = (await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!;
    expect(renamed.name).toBe('Left chest'); expect(renamed.id).toBe(original.id); expect(renamed.points).toEqual(original.points);
    await modelSetup(page, 'area-rename').fill('   '); await modelSetup(page, 'area-rename-apply').click();
    expect((await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!.name).toBe('Left chest');
    await page.locator('[data-canvas-context-dismiss]').click();
    await modelSetup(page, 'tool-edit').click();
    await modelSetup(page, 'canvas-handle-side-0').click();
    expect((await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!.points).toHaveLength(5);
    await modelSetup(page, 'canvas-handle-corner-1').click();
    await modelSetup(page, 'handle-remove').click();
    expect((await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!.points).toHaveLength(4);
    await modelSetup(page, 'outline-curve').click();
    await modelSetup(page, 'canvas-handle-side-0').click();
    await expect(modelSetup(page, 'curve-bend-handle')).toBeVisible();
    const diamond = (await modelSetup(page, 'curve-bend-handle').boundingBox())!;
    await page.mouse.move(diamond.x+diamond.width/2, diamond.y+diamond.height/2); await page.mouse.down();
    await page.mouse.move(diamond.x+diamond.width/2+8, diamond.y+diamond.height/2+12, {steps:5}); await page.mouse.up();
    await expect(modelSetup(page, 'live-outline')).toBeVisible();
    // Editing preview cannot alter a persisted snapshot.
    expect((await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!.points).toEqual(renamed.points);
    await modelSetup(page, 'curve-apply').click();
    const curved = (await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!;
    expect(curved.points.length).toBeGreaterThan(4); expect(curved.id).toBe(original.id);
    await modelSetup(page, `canvas-handle-side-${curved.points.length - 1}`).click();
    await page.keyboard.press('Escape');
    await expect(modelSetup(page, 'curve-bend-handle')).toBeHidden();
    expect((await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!.points).toEqual(curved.points);
    await modelSetup(page, 'context-more').click();
    const downloadPromise = page.waitForEvent('download'); await modelSetup(page, 'setup-save').click();
    const path = await (await downloadPromise).path(); assert.ok(path);
    expect(await hCall<boolean>(page, 'restore', await readFile(path, 'utf8'))).toBe(true);
    const restored = (await hCall<HarnessSnapshot>(page, 'lastSnapshot')).areas[0]!;
    expect(restored.name).toBe('Left chest'); expect(restored.points).toEqual(curved.points);
    await page.locator('[data-canvas-context-dismiss]').click();
    await modelSetup(page, 'outline-point').click();
    const desktopShot = info.outputPath('outline-desktop.png'); await page.screenshot({path:desktopShot});
    await info.attach('outline-desktop', {path:desktopShot,contentType:'image/png'});
    await page.setViewportSize({width:390,height:844});
    await modelSetup(page, 'context-areas').click();
    await expect(modelSetup(page, 'area-rename')).toBeVisible();
    await modelSetup(page, 'area-rename').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const narrowShot = info.outputPath('outline-narrow.png'); await page.screenshot({path:narrowShot});
    await info.attach('outline-narrow', {path:narrowShot,contentType:'image/png'});
    expectOfflineClean(probe);
  } finally { await context.close(); }
});
