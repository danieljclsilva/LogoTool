import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from '@playwright/test';
import { release } from 'node:os';
import type { Browser, BrowserContext, Page } from '@playwright/test';

export const INSPECTOR_URL = pathToFileURL(
  resolve(process.cwd(), 'dist/dev/asset-inspector.html'),
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

// Single-entry Logo Station canonical outputs. Declared before BUILDER_URL
// so the long-standing builder entry below aliases the shipped station.
export const STATION_FILENAME = 'Logo Station.html';
export const STATION_DIR = resolve(process.cwd(), 'dist/station');
export const STATION_PATH = resolve(STATION_DIR, STATION_FILENAME);
export const STATION_URL = pathToFileURL(STATION_PATH).href;

// Canonical staff entry: the single-entry Logo Station. Every builder spec
// exercises the shipped station output through the long-standing
// BUILDER_URL/gotoBuilder names — a green suite can never mask a broken
// station build with a legacy sidecar page. (Dev-only inspector output
// keeps its own INSPECTOR_URL above.)
export const BUILDER_URL = STATION_URL;

export async function gotoBuilder(page: Page): Promise<void> {
  await page.goto(BUILDER_URL);
}

/** Navigate the guided builder to the mode/disclosure holding a control. */
export async function revealBuilderControl(page: Page, name: string): Promise<void> {
  const selector = `[data-builder-hook="${name}"]`;
  const control = page.locator(selector).first();
  const mode = await control.evaluate(
    (element) => element.closest('[data-builder-mode-panel]')?.getAttribute('data-builder-mode-panel'),
  );
  if (mode) {
    const panel = page.locator(`[data-builder-mode-panel="${mode}"]`).first();
    if (!await panel.isVisible()) {
      await page.locator(`[data-builder-hook="mode-${mode}"]`).first().click();
      await panel.first().waitFor({ state: 'visible' });
    }
  }
  // Status assertions can inspect hidden context without changing the journey.
  // Interactive controls and disclosed review content use real step navigation.
  if (!await control.isDisabled() && !name.endsWith('status') && !['builder-next','builder-back','size-estimate','handoff-summary'].includes(name)) {
    const step = await control.evaluate(element => element.closest('[data-builder-step]')?.getAttribute('data-builder-step'));
    if (step && !await page.locator(`[data-builder-step="${step}"]`).isVisible()) {
      const tabs: Record<string,string> = {open:'open',choose:'choose',details:'details',send:'send',office:'office',return:'return',check:'check'};
      await page.locator(`[data-builder-hook="step-${tabs[step]}"]`).click();
    }
  }
  await revealControl(page, selector);
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

/** Open only the disclosures that contain the control this flow needs. */
export async function revealControl(page: Page, selector: string): Promise<void> {
  const ancestors = page.locator(selector).locator('xpath=ancestor::details');
  for (let index = 0; index < await ancestors.count(); index += 1) {
    const details = ancestors.nth(index);
    if (!await details.evaluate((element) => (element as HTMLDetailsElement).open)) {
      await details.locator(':scope > summary').focus();
      await page.keyboard.press('Enter');
    }
  }
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
  await revealControl(page, '[data-calibration-hook="area-restore-button"]');
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
  await revealControl(page, '[data-calibration-hook="placement-restore-button"]');
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
  await revealControl(page, '[data-calibration-hook="placement-export-button"]');
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

/** Navigate only to the step/disclosure containing the requested customer control. */
export async function revealCustomerControl(page: Page, name: string): Promise<void> {
  const selector = `[data-customer-hook="${name}"]`;
  const control = page.locator(selector);
  const step = await control.evaluate((element) => element.closest('[data-step-panel]')?.getAttribute('data-step-panel'));
  if (step && !await page.locator(`[data-step-panel="${step}"]`).isVisible()) {
    await page.locator(`[data-customer-hook="step-${step}"]`).click();
    await page.locator(`[data-step-panel="${step}"]`).waitFor({ state: 'visible' });
  }
  await revealControl(page, selector);
}

export async function selectCustomerOption(page: Page, name: string, value: string): Promise<void> {
  if (name === 'placement' && value === '') {
    await page.locator('[data-customer-hook="add-another"]').click();
    return;
  }
  await revealCustomerControl(page, name);
  const select = page.locator(`[data-customer-hook="${name}"]`);
  if (await select.isVisible()) await select.selectOption(value);
  else if (await select.inputValue() !== value) throw new Error(`Fixed ${name} does not offer ${value}`);
}

// Dev-only outputs (canonical copies under dist/dev/). No generated staff
// HTML or fixture remains at the dist root: the production station lives
// ONLY at dist/station/, dev utilities/fixtures ONLY under dist/dev/.
export const DEV_DIR = resolve(process.cwd(), 'dist/dev');
export const DEV_INSPECTOR_URL = pathToFileURL(resolve(DEV_DIR, 'asset-inspector.html')).href;
export const DEV_PACKAGE_INSPECTOR_URL = pathToFileURL(
  resolve(DEV_DIR, 'project-package-inspector.html'),
).href;
export const DEV_CUSTOMER_EDITOR_URL = pathToFileURL(
  resolve(DEV_DIR, 'customer-configurator.html'),
).href;
export const DEV_RETURN_REVIEW_URL = pathToFileURL(
  resolve(DEV_DIR, 'customer-return-review.html'),
).href;

/** Fail clearly when the station entry is missing instead of opening a blank page. */
export async function assertStationPresent(): Promise<void> {
  try {
    await readFile(STATION_PATH);
  } catch {
    throw new Error(
      `Station entry missing at ${STATION_PATH}. Run "npm run build:station" (or "npm run build") first.`,
    );
  }
}

export async function gotoStation(page: Page): Promise<void> {
  await assertStationPresent();
  await page.goto(STATION_URL);
}
