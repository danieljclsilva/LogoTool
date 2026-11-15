// Disabled-reason tooltips: bound zoom buttons and refresh-created action
// controls must expose stable aria-describedby reasons, preserve base titles,
// never use aria-description, and clean up in place. Harness pattern only:
// repo-local esbuild bundle of e2e/fixtures/setup-calibration-harness.ts,
// inlined into temp HTML (#stage/#gl/#setup), opened via file:// in an
// offline context. Synthetic cube GLB only. No webServer, no fixed scratch
// files, no live Odoo.
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { release } from 'node:os';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

const VIEWPORT = { width: 1280, height: 900 };

function modelSetup(page: Page, name: string) {
  return page.locator(`[data-model-setup-hook="${name}"]`);
}

function zoomOut(page: Page) {
  return page.locator('[data-ps-view="zoom-out"]');
}

function zoomIn(page: Page) {
  return page.locator('[data-ps-view="zoom-in"]');
}

function zoomSelect(page: Page) {
  return page.locator('[data-ps-view="zoom"]');
}

function reason(page: Page, id: string) {
  return page.locator(`#${id}`);
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

async function attachEnv(
  info: import('@playwright/test').TestInfo,
  browser: Browser,
  viewport: { width: number; height: number },
  scope: string,
): Promise<void> {
  await info.attach('offline-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform, release: release(), arch: process.arch,
      project: info.project.name, browserVersion: browser.version(),
      viewport, offline: true, entryPoint: 'file://', scope,
    }, null, 2),
  });
}

/** Build the self-contained harness page (repo-local esbuild, inlined IIFE). */
async function openHarness(
  browser: Browser,
  viewport: { width: number; height: number },
  fileName: string,
): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  const entry = resolve(process.cwd(), 'e2e/fixtures/setup-calibration-harness.ts');
  const bundled = buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const first = bundled.outputFiles[0];
  if (!first) throw new Error('esbuild produced no output for the setup-calibration harness.');
  const js = String(first.text).replace(/<\/script/gi, '<\\/script');
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>disabled-reasons harness</title><style>' +
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

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.networkRequests).toEqual([]);
}

async function loadCube(page: Page): Promise<void> {
  const glbBase64 = Buffer.from(cubeGlb()).toString('base64');
  expect(await hCall<string>(page, 'loadGlb', glbBase64)).toBe('ready');
  await expect(modelSetup(page, 'pending-banner')).toContainText('pending review');
}

/** Disabled title mirrors the specific reason; base title restored on enable. */
async function expectDisabledTitle(page: Page, control: ReturnType<Page['locator']>, reasonId: string): Promise<void> {
  const title = await control.getAttribute('title');
  const reasonText = (await reason(page, reasonId).count()) > 0
    ? await reason(page, reasonId).textContent()
    : null;
  expect(reasonText).not.toBeNull();
  expect(title).toBe(reasonText);
  expect(await reason(page, reasonId).getAttribute('hidden')).not.toBeNull();
  expect(await control.getAttribute('aria-description')).toBeNull();
}

test('zoom-out bound exposes stable describedby reason and restores cleanly', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const viewport = { ...VIEWPORT };
  const { context, page, probe } = await openHarness(browser, viewport, 'disabled-reasons-zoom-out.html');
  try {
    await attachEnv(info, browser, viewport, 'disabled zoom-out reason');
    await loadCube(page);

    const out = zoomOut(page);
    const into = zoomIn(page);
    const select = zoomSelect(page);

    // Initial zoom 100: both directions enabled, no bound reasons.
    await expect(select).toHaveValue('100');
    await expect(out).toBeEnabled();
    await expect(into).toBeEnabled();
    await expect(out).toHaveAttribute('aria-label', 'Zoom out');
    await expect(into).toHaveAttribute('aria-label', 'Zoom in');
    expect((await out.getAttribute('aria-describedby')) ?? '').not.toContain('model-setup-reason-');
    expect((await into.getAttribute('aria-describedby')) ?? '').not.toContain('model-setup-reason-');
    await expect(reason(page, 'model-setup-reason-zoom-out')).toHaveCount(0);
    await expect(reason(page, 'model-setup-reason-zoom-in')).toHaveCount(0);
    expect(await out.getAttribute('aria-description')).toBeNull();
    expect(await page.locator('[aria-description]').count()).toBe(0);

    // Seed an unrelated describedby token: the bound reason must join it,
    // never clobber it. Mark the node to prove syncViewbar patches in place.
    await out.evaluate((el) => el.setAttribute('aria-describedby', 'custom-token'));
    await out.evaluate((el) => { (el as HTMLElement).dataset.probeKeep = 'kept'; });

    // Drive to the min bound through the real UI (100 -> 75 -> 50).
    await out.click();
    await expect(select).toHaveValue('75');
    await out.click();
    await expect(select).toHaveValue('50');

    // In-place update: same node, now disabled with the stable reason.
    await expect(out).toHaveAttribute('data-probe-keep', 'kept');
    await expect(out).toBeDisabled();
    await expect(into).toBeEnabled();
    const described = (await out.getAttribute('aria-describedby')) ?? '';
    expect(described.split(/\s+/)).toContain('model-setup-reason-zoom-out');
    expect(described).toContain('custom-token');
    const reasonOut = reason(page, 'model-setup-reason-zoom-out');
    await expect(reasonOut).toHaveCount(1);
    await expect(reasonOut).toHaveText('Already at minimum zoom (50%).');
    await expect(reasonOut).toHaveAttribute('hidden', '');
    await expect(out).toHaveAttribute('aria-label', 'Zoom out');
    await expectDisabledTitle(page, out, 'model-setup-reason-zoom-out');
    // Scoped to the viewbar mount (fallback bar sits beside #stage).
    expect(await reasonOut.evaluate((el) => el.closest('[data-model-setup-hook="viewbar"], [data-ps-viewbar]') !== null)).toBe(true);
    // Zoom-in stays reason-free.
    expect((await into.getAttribute('aria-describedby')) ?? '').not.toContain('model-setup-reason-');
    expect(await page.locator('[aria-description]').count()).toBe(0);

    // Zoom back out of the bound: reason removed, unrelated token kept.
    await into.click();
    await expect(select).toHaveValue('75');
    await expect(out).toBeEnabled();
    await expect(out).toHaveAttribute('data-probe-keep', 'kept');
    const restored = (await out.getAttribute('aria-describedby')) ?? '';
    expect(restored).not.toContain('model-setup-reason-zoom-out');
    expect(restored).toContain('custom-token');
    await expect(reason(page, 'model-setup-reason-zoom-out')).toHaveCount(0);
    await expect(out).toHaveAttribute('aria-label', 'Zoom out');
    const restoredTitle = await out.getAttribute('title');
    if (restoredTitle !== null) expect(restoredTitle).not.toContain('Already at');
    expect(await out.getAttribute('aria-description')).toBeNull();
    expect(await page.locator('[aria-description]').count()).toBe(0);

    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('zoom-in bound exposes stable describedby reason and restores cleanly', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const viewport = { ...VIEWPORT };
  const { context, page, probe } = await openHarness(browser, viewport, 'disabled-reasons-zoom-in.html');
  try {
    await attachEnv(info, browser, viewport, 'disabled zoom-in reason');
    await loadCube(page);

    const out = zoomOut(page);
    const into = zoomIn(page);
    const select = zoomSelect(page);

    await expect(select).toHaveValue('100');
    await expect(out).toBeEnabled();
    await expect(into).toBeEnabled();
    await expect(reason(page, 'model-setup-reason-zoom-in')).toHaveCount(0);

    await into.evaluate((el) => el.setAttribute('aria-describedby', 'custom-token'));
    await into.evaluate((el) => { (el as HTMLElement).dataset.probeKeep = 'kept'; });

    // Drive to the max bound through the zoom select.
    await select.selectOption('400');
    await expect(select).toHaveValue('400');

    await expect(into).toHaveAttribute('data-probe-keep', 'kept');
    await expect(into).toBeDisabled();
    await expect(out).toBeEnabled();
    const described = (await into.getAttribute('aria-describedby')) ?? '';
    expect(described.split(/\s+/)).toContain('model-setup-reason-zoom-in');
    expect(described).toContain('custom-token');
    const reasonIn = reason(page, 'model-setup-reason-zoom-in');
    await expect(reasonIn).toHaveCount(1);
    await expect(reasonIn).toHaveText('Already at maximum zoom (400%).');
    await expect(reasonIn).toHaveAttribute('hidden', '');
    await expect(into).toHaveAttribute('aria-label', 'Zoom in');
    await expectDisabledTitle(page, into, 'model-setup-reason-zoom-in');
    expect(await reasonIn.evaluate((el) => el.closest('[data-model-setup-hook="viewbar"], [data-ps-viewbar]') !== null)).toBe(true);
    expect((await out.getAttribute('aria-describedby')) ?? '').not.toContain('model-setup-reason-');
    expect(await page.locator('[aria-description]').count()).toBe(0);

    // Step back down: reason removed, unrelated token kept, node gone.
    await out.click();
    await expect(select).toHaveValue('300');
    await expect(into).toBeEnabled();
    await expect(into).toHaveAttribute('data-probe-keep', 'kept');
    const restored = (await into.getAttribute('aria-describedby')) ?? '';
    expect(restored).not.toContain('model-setup-reason-zoom-in');
    expect(restored).toContain('custom-token');
    await expect(reason(page, 'model-setup-reason-zoom-in')).toHaveCount(0);
    await expect(into).toHaveAttribute('aria-label', 'Zoom in');
    const restoredTitle = await into.getAttribute('title');
    if (restoredTitle !== null) expect(restoredTitle).not.toContain('Already at');
    expect(await into.getAttribute('aria-description')).toBeNull();
    expect(await page.locator('[aria-description]').count()).toBe(0);

    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('refresh-created controls expose stable describedby reasons', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const viewport = { ...VIEWPORT };
  const { context, page, probe } = await openHarness(browser, viewport, 'disabled-reasons-refresh.html');
  try {
    await attachEnv(info, browser, viewport, 'disabled refresh-path reasons');
    await loadCube(page);

    // Finish area: disabled with no open drawing (refresh path, not viewbar).
    const finish = modelSetup(page, 'area-finish');
    await expect(finish).toBeDisabled();
    await expect(finish).toContainText('Finish area');
    const finishDescribed = (await finish.getAttribute('aria-describedby')) ?? '';
    expect(finishDescribed.split(/\s+/)).toContain('model-setup-reason-area-finish');
    const reasonFinish = reason(page, 'model-setup-reason-area-finish');
    await expect(reasonFinish).toHaveCount(1);
    await expect(reasonFinish).toContainText('Draw an outline first');
    await expect(reasonFinish).toHaveAttribute('hidden', '');
    await expectDisabledTitle(page, finish, 'model-setup-reason-area-finish');
    // Scoped to the view container + viewbar mount (command strip renders
    // into the viewbar author-tools, not #setup).
    expect(await reasonFinish.evaluate((el) =>
      el.closest('#setup, [data-model-setup-hook="viewbar"], [data-ps-viewbar]') !== null)).toBe(true);

    // Recompute: disabled with zero stale areas (refresh path).
    const recompute = modelSetup(page, 'areas-recompute');
    await expect(recompute).toBeDisabled();
    const recomputeDescribed = (await recompute.getAttribute('aria-describedby')) ?? '';
    expect(recomputeDescribed.split(/\s+/)).toContain('model-setup-reason-areas-recompute');
    const reasonRecompute = reason(page, 'model-setup-reason-areas-recompute');
    await expect(reasonRecompute).toHaveCount(1);
    await expect(reasonRecompute).toContainText('No stale areas');
    await expect(reasonRecompute).toHaveAttribute('hidden', '');
    const recomputeTitle = await recompute.getAttribute('title');
    const recomputeReasonText = await reasonRecompute.textContent();
    expect(recomputeTitle).toBe(recomputeReasonText);
    expect(await recompute.getAttribute('aria-description')).toBeNull();
    expect(await reasonRecompute.evaluate((el) =>
      el.closest('#setup, [data-model-setup-hook="viewbar"], [data-ps-viewbar]') !== null)).toBe(true);

    // No aria-description anywhere on the harness page.
    expect(await page.locator('[aria-description]').count()).toBe(0);

    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});
