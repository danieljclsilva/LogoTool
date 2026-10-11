import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from '@playwright/test';
import { release } from 'node:os';
import type { Browser, BrowserContext, Page } from '@playwright/test';

export const INSPECTOR_URL = pathToFileURL(
  resolve(process.cwd(), 'dist/asset-inspector.html'),
).href;

export interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  httpRequests: string[];
}

export function hook(
  page: Page,
  group: 'inspector' | 'calibration' | 'area' | 'placement',
  name: string,
) {
  const attr =
    group === 'inspector'
      ? 'data-inspector-hook'
      : group === 'calibration'
        ? 'data-calibration-hook'
        : group === 'area'
          ? 'data-area-hook'
          : 'data-placement-hook';
  return page.locator(`[${attr}="${name}"]`);
}

export async function openOfflineContext(
  browser: Browser,
  viewport?: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  const context = await browser.newContext({
    offline: true,
    acceptDownloads: true,
    viewport: viewport ?? { width: 1280, height: 900 },
  });
  await test.info().attach('offline-environment', {
    contentType: 'application/json',
    body: JSON.stringify({ os: process.platform, release: release(), arch: process.arch,
      project: test.info().project.name, browserVersion: browser.version(),
      viewport: viewport ?? { width: 1280, height: 900 }, offline: true,
      entryPoint: 'file://', scope: 'internal inspector' }, null, 2),
  });
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], httpRequests: [] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) probe.httpRequests.push(request.url());
  });
  return { context, page, probe };
}

export async function gotoInspector(page: Page): Promise<void> {
  await page.goto(INSPECTOR_URL);
}

export async function ingestGlb(page: Page, glb: Buffer): Promise<void> {
  await hook(page, 'inspector', 'file-input').setInputFiles({
    name: 'synthetic-block.glb',
    mimeType: 'model/gltf-binary',
    buffer: glb,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-inspector-hook="status"]')
        ?.textContent?.startsWith('Showing') === true,
  );
}

export async function restoreSession(page: Page, sessionText: string): Promise<void> {
  await hook(page, 'calibration', 'restore-file').setInputFiles({
    name: 'session.json',
    mimeType: 'application/json',
    buffer: Buffer.from(sessionText),
  });
  await hook(page, 'calibration', 'restore-button').click();
  await waitRestoreReady(page, 'restore-button');
}

export async function restoreAreaBundle(page: Page, areaText: string): Promise<void> {
  await hook(page, 'calibration', 'area-restore-file').setInputFiles({
    name: 'area-bundle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(areaText),
  });
  await hook(page, 'calibration', 'area-restore-button').click();
  await waitRestoreReady(page, 'area-restore-button');
}

export async function restorePlacementBundle(
  page: Page,
  bundleText: string,
): Promise<void> {
  await hook(page, 'calibration', 'placement-restore-file').setInputFiles({
    name: 'placement-bundle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(bundleText),
  });
  await hook(page, 'calibration', 'placement-restore-button').click();
  await waitRestoreReady(page, 'placement-restore-button');
}

export async function waitRestoreReady(
  page: Page,
  button: 'restore-button' | 'area-restore-button' | 'placement-restore-button',
): Promise<void> {
  await page.waitForFunction(
    (name) =>
      document.querySelector(
        `[data-calibration-hook="${name}"]`,
      ) instanceof HTMLButtonElement &&
      !(
        document.querySelector(
          `[data-calibration-hook="${name}"]`,
        ) as HTMLButtonElement
      ).disabled,
    button,
  );
}

export async function downloadText(
  page: Page,
  trigger: () => Promise<void>,
): Promise<string> {
  const event = page.waitForEvent('download');
  await trigger();
  const download = await event;
  const path = await download.path();
  if (path === null) throw new Error('Download path unavailable.');
  return readFile(path, 'utf8');
}

export async function savePlacementBundle(page: Page): Promise<string> {
  return downloadText(page, () =>
    hook(page, 'calibration', 'placement-export-button').click(),
  );
}

export async function saveAreaBundle(page: Page): Promise<string> {
  return downloadText(page, () =>
    hook(page, 'area', 'area-export').click(),
  );
}

export function assertCleanProbe(probe: Probe): void {
  if (probe.pageErrors.length > 0)
    throw new Error(`page errors: ${JSON.stringify(probe.pageErrors)}`);
  if (probe.consoleErrors.length > 0)
    throw new Error(`console errors: ${JSON.stringify(probe.consoleErrors)}`);
  if (probe.httpRequests.length > 0)
    throw new Error(`network requests: ${JSON.stringify(probe.httpRequests)}`);
}

export interface PlacementEditorOptions {
  logo: string;
  region: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

export async function setPlacementEditor(
  page: Page,
  options: PlacementEditorOptions,
): Promise<void> {
  await hook(page, 'placement', 'placement-logo').selectOption(options.logo);
  await hook(page, 'placement', 'placement-region').selectOption(options.region);
  await hook(page, 'placement', 'placement-x').fill(String(options.x));
  await hook(page, 'placement', 'placement-y').fill(String(options.y));
  await hook(page, 'placement', 'placement-w').fill(String(options.w));
  await hook(page, 'placement', 'placement-h').fill(String(options.h));
  await hook(page, 'placement', 'placement-rot').fill(String(options.rot));
}

export async function addPlacement(
  page: Page,
  options: PlacementEditorOptions,
): Promise<void> {
  await setPlacementEditor(page, options);
  await hook(page, 'placement', 'placement-add').click();
}
