import { revealCustomerControl, selectCustomerOption } from './helpers.js';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { extractEmbeddedProjectPackage } from '../src/packaging/self-contained-html/index.js';

// Internal-builder acceptance. Opens the already-built dist/internal-builder.html
// offline through file:// (the spec never rebuilds; `npm run build` runs first).
// Every test asserts zero console/page errors and zero HTTP(S) requests.
//
// Final UI copy (BuilderUI-2, src/ui/internal-builder/template.html):
// - source-status: `Loaded <file>: project <id> revision <rev>, …` on success;
//   `Could not load <file>: <detail>.` on failure (previous source kept).
// - product-list rows are top-level product checkboxes plus nested variant
//   checkboxes (`[data-product]`); logo list is flat; configuration-list lives
//   inside a collapsed advanced <details>. All checked by default on source load.
// - generate-status after generate: `Issued <job> revision 1 …`; the stable
//   wait is baseline-status `Retained issued baseline: <job> revision 1 …`.
// - Primary download-package is format-aware: single-file mode delivers
//   OPEN_LOGO_CONFIGURATOR.html (customer opens it directly, nothing to
//   unzip); hybrid mode delivers `<JOB>.zip` (OPEN_LOGO_CONFIGURATOR.html +
//   `<JOB>.logo-project`). download-html is the secondary advanced file
//   (configurator alone in hybrid mode, project file alone in single-file
//   mode); download-baseline is `<JOB>-issued-baseline.logo-project`,
//   byte-identical to the generated package, and its button stays visible
//   outside any disclosure.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

const BUILDER_HTML = pathToFileURL(resolve(process.cwd(), 'dist/internal-builder.html')).href;
const TRUSTED_SOURCE_PATH = resolve(process.cwd(), 'dist/trusted-issued.logo-project');
const TRUSTED_SOURCE_NAME = 'trusted-issued.logo-project';
const ALT_SOURCE_PATH = resolve(process.cwd(), 'dist/synthetic-zero-placement.logo-project');
const ALT_SOURCE_NAME = 'synthetic-zero-placement.logo-project';

const CUSTOMER = 'Acme Athletics';
const ISSUED_BY = 'Internal operator';
const ISSUED_PROJECT_ID = 'ACME-BLD-001';

const FULL_PRODUCTS = ['SYN-TEE-001', 'SYN-TR-001'];
const FULL_LOGOS = ['SYN-LOGO-A', 'SYN-LOGO-B'];
const FULL_CONFIGURATIONS = ['SYN-CFG-TEE-M', 'SYN-CFG-TR-REG'];

function expectedDescription(issuedProjectId: string, customer: string, job: string, by: string): string {
  return `Internal-builder issue ${issuedProjectId} for ${customer} / ${job} by ${by}. Confirmation and internal review history reset before customer handoff.`;
}

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

function attachPageProbe(page: Page, probe: Probe): void {
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
}

async function openBuilder(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<{
  context: BrowserContext;
  page: Page;
  probe: Probe;
}> {
  await test.info().attach('internal-builder-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform,
      release: release(),
      arch: process.arch,
      browser: browser.browserType().name(),
      browserVersion: browser.version(),
      viewport,
      offline: true,
      entryPoint: 'file://dist/internal-builder.html',
      prototype: 'internal builder',
    }, null, 2),
  });
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  attachPageProbe(page, probe);
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  await page.goto(BUILDER_HTML);
  await expect(page).toHaveTitle('LogoTool · Internal Builder');
  await expect(page.locator('h1')).toHaveText('Prepare a customer project');
  await expect(page.locator('[data-builder-hook="source-file"]')).toBeAttached();
  await expect(page.locator('[data-builder-hook="generate"]')).toBeVisible();
  return { context, page, probe };
}

async function loadSourceFile(page: Page, path: string, fileName: string): Promise<void> {
  await page.locator('[data-builder-hook="source-file"]').setInputFiles(path);
  await expect(page.locator('[data-builder-hook="source-status"]')).toContainText(`Loaded ${fileName}`);
}

async function dropSourceFile(page: Page, bytes: Uint8Array, fileName: string): Promise<void> {
  await page.evaluate(({ base64, name }) => {
    const binary = atob(base64);
    const data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], name, { type: 'application/zip' }));
    const target = document.querySelector<HTMLElement>('[data-builder-hook="source-drop"]');
    if (!target) throw new Error('Missing builder source drop target.');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { base64: Buffer.from(bytes).toString('base64'), name: fileName });
  await expect(page.locator('[data-builder-hook="source-status"]')).toContainText(`Loaded ${fileName}`);
}

async function variantIds(page: Page, productId: string): Promise<string[]> {
  return page.evaluate((product: string): string[] => {
    const root = document.querySelector('[data-builder-hook="product-list"]');
    if (!root) throw new Error('Missing builder product list.');
    return Array.from(root.querySelectorAll(`input[type="checkbox"][data-product="${product}"]`))
      .map((element) => (element as HTMLInputElement).value);
  }, productId);
}

async function ensureListVisible(page: Page, listHook: string): Promise<void> {
  // The configurations checklist lives inside a collapsed advanced
// <details>; open the enclosing disclosure before touching its boxes.
  await page.evaluate((hook: string): void => {
    const root = document.querySelector(`[data-builder-hook="${hook}"]`);
    const disclosure = root?.closest('details');
    if (disclosure) disclosure.open = true;
  }, listHook);
}

async function setListSelection(page: Page, listHook: string, ids: string[]): Promise<void> {
  await ensureListVisible(page, listHook);
  const boxes = page.locator(`[data-builder-hook="${listHook}"] input[type="checkbox"]`);
  const count = await boxes.count();
  const seen: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    const value = (await box.getAttribute('value')) ?? '';
    const nestedProduct = await box.getAttribute('data-product');
    // The product list nests variant checkboxes (data-product set) under each
    // product; top-level product selection must not toggle variants.
    if (nestedProduct !== null) continue;
    seen.push(value);
    if (ids.includes(value)) await box.check();
    else await box.uncheck();
  }
  for (const id of ids) assert.ok(seen.includes(id), `selection list ${listHook} is missing option ${id}`);
}

async function checkedTopLevelIds(page: Page, listHook: string): Promise<string[]> {
  return page.evaluate((hook: string): string[] => {
    const root = document.querySelector(`[data-builder-hook="${hook}"]`);
    if (!root) throw new Error(`Missing builder selection list: ${hook}`);
    return Array.from(root.querySelectorAll('input[type="checkbox"]'))
      .filter((element) => (element as HTMLInputElement).checked && !(element as HTMLInputElement).hasAttribute('data-product'))
      .map((element) => (element as HTMLInputElement).value);
  }, listHook);
}

async function fillIdentity(page: Page, customer: string, job: string, by: string, projectId = ISSUED_PROJECT_ID): Promise<void> {
  await page.locator('[data-builder-hook="customer-name"]').fill(customer);
  await page.locator('[data-builder-hook="job-ref"]').fill(job);
  await page.locator('[data-builder-hook="issued-by"]').fill(by);
  await page.locator('[data-builder-hook="project-id"]').fill(projectId);
}

async function chooseFormat(page: Page, format: 'self' | 'hybrid'): Promise<void> {
  const target = page.locator(`[data-builder-hook="format-${format}"]`);
  const tag = await target.evaluate((element) => element.tagName.toLowerCase());
  if (tag === 'input') {
    await target.check();
    await expect(target).toBeChecked();
  } else {
    await target.click();
  }
}

async function generate(page: Page, issuedProjectId: string): Promise<void> {
  await page.locator('[data-builder-hook="generate"]').click();
  await expect(page.locator('[data-builder-hook="generate-status"]')).toContainText(
    `Issued ${issuedProjectId} revision 1`,
  );
  await expect(page.locator('[data-builder-hook="baseline-status"]')).toContainText(
    `Retained issued baseline: ${issuedProjectId} revision 1`,
  );
}

async function readDownload(
  page: Page,
  fileName: string,
  trigger: () => Promise<void>,
): Promise<{ name: string; bytes: Uint8Array }> {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  const download = await downloadPromise;
  const outputPath = test.info().outputPath(fileName);
  await download.saveAs(outputPath);
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(outputPath)) };
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.networkRequests).toEqual([]);
}

function expectApprovalsCleared(project: Record<string, unknown>): void {
  expect(project['confirmation']).toBeUndefined();
  expect(project['review']).toBeUndefined();
  expect(project['history']).toBeUndefined();
  expect(project['reviewHistory']).toBeUndefined();
  expect(project['issuedBaselineHash']).toBeUndefined();
}

test('loads the trusted source and renders product, logo, and configuration selections', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText(
      'Loaded trusted-issued.logo-project: project SYN-PROJ-MULTI-001 revision 1',
    );
    await expect(page.locator('[data-builder-hook="product-list"] input[type="checkbox"]:not([data-product])')).toHaveCount(2);
    expect(await variantIds(page, 'SYN-TEE-001')).toEqual(['SYN-TEE-M', 'SYN-TEE-XL']);
    expect(await variantIds(page, 'SYN-TR-001')).toEqual(['SYN-TR-REG', 'SYN-TR-SHORT']);
    await expect(page.locator('[data-builder-hook="logo-list"] input[type="checkbox"]')).toHaveCount(2);
    await expect(page.locator('[data-builder-hook="configuration-list"] input[type="checkbox"]')).toHaveCount(2);
    // Everything is checked by default on source load.
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(FULL_PRODUCTS);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(FULL_LOGOS);
    expect(await checkedTopLevelIds(page, 'configuration-list')).toEqual(FULL_CONFIGURATIONS);
    // Advanced setups start collapsed; the format choice and the saved review
    // copy button stay visible without opening anything.
    const setupsDisclosure = page.locator('details', { has: page.locator('summary', { hasText: 'Choose specific setups' }) });
    await expect(setupsDisclosure).not.toHaveAttribute('open', '');
    await expect(page.locator('[data-builder-hook="format-self"]')).toBeVisible();
    await expect(page.locator('[data-builder-hook="format-hybrid"]')).toBeVisible();
    await expect(page.locator('[data-builder-hook="format-self"]')).toBeChecked();
    await expect(page.locator('fieldset')).toContainText('(Recommended)');
    await expect(page.locator('[data-builder-hook="download-baseline"]')).toBeVisible();
    await expect(page.locator('.banner').first()).toBeVisible();
    await expect(page.locator('main#internal-builder')).toContainText('Keep this review copy file');
    await expect(page.locator('[data-builder-hook="generate-status"]')).toContainText(
      'Selection valid: 2 products, 2 logos, 2 source configurations.',
    );
    await expect(page.locator('[data-builder-hook="product-list"]')).toContainText('Synthetic Tee (SYN-TEE-001)');
    await expect(page.locator('[data-builder-hook="logo-list"]')).toContainText('SYN-LOGO-B');
    await setupsDisclosure.locator('summary').click();
    await expect(page.locator('[data-builder-hook="configuration-list"]')).toContainText('SYN-CFG-TR-REG');
    await expect(page.locator('[data-builder-hook="size-estimate"]')).toHaveText('No issued package generated yet.');
    await fillIdentity(page, CUSTOMER, 'BUILDER-PREVIEW', ISSUED_BY);
    await generate(page, ISSUED_PROJECT_ID);
    await page.screenshot({ path: test.info().outputPath('builder-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('builder-mobile.png'), fullPage: true });
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('issues a subset hybrid package at revision 1 with approvals cleared', async ({ browser }) => {
  const jobRef = 'BLD-TEST-01';
  const issuedProjectId = 'ACME-BLD-TEST-01';
  const { context, page, probe } = await openBuilder(browser);
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await setListSelection(page, 'product-list', ['SYN-TEE-001']);
    await setListSelection(page, 'logo-list', ['SYN-LOGO-A']);
    await setListSelection(page, 'configuration-list', ['SYN-CFG-TEE-M']);
    await fillIdentity(page, CUSTOMER, jobRef, ISSUED_BY, issuedProjectId);
    await chooseFormat(page, 'hybrid');
    await generate(page, issuedProjectId);
    await expect(page.locator('[data-builder-hook="download-package"]')).toBeEnabled();
    await expect(page.locator('[data-builder-hook="download-baseline"]')).toBeEnabled();
    await expect(page.locator('[data-builder-hook="size-estimate"]')).toContainText('Format: hybrid');

    const downloaded = await readDownload(page, `${jobRef}.zip`, () =>
      page.locator('[data-builder-hook="download-package"]').click(),
    );
    expect(downloaded.name).toBe(`${jobRef}.zip`);
    const entries = unzipSync(downloaded.bytes);
    const names = Object.keys(entries);
    expect(names).toContain('OPEN_LOGO_CONFIGURATOR.html');
    const projectEntry = names.find((name) => name.endsWith('.logo-project'));
    assert.ok(projectEntry, `hybrid ZIP should contain a .logo-project entry, saw: ${names.join(', ')}`);
    const issued = await parseProjectPackage(entries[projectEntry]!, { sha256 });
    expect(issued.project.projectId).toBe(issuedProjectId);
    expect(issued.project.revision).toBe(1);
    expect(issued.project.description).toBe(expectedDescription(issuedProjectId, CUSTOMER, jobRef, ISSUED_BY));
    expect(issued.project.products.map((product) => product.id)).toEqual(['SYN-TEE-001']);
    expect(issued.project.logos.map((logo) => logo.id)).toEqual(['SYN-LOGO-A']);
    expect(issued.project.configurations.map((configuration) => configuration.id)).toEqual(['SYN-CFG-TEE-M']);
    expect(issued.project.configurations.flatMap((configuration) => configuration.placements)).toHaveLength(2);
    expectApprovalsCleared(issued.project as unknown as Record<string, unknown>);
    const directory = await mkdtemp(join(tmpdir(), 'LogoTool generated hybrid with spaces '));
    try {
      const htmlPath = join(directory, 'OPEN_LOGO_CONFIGURATOR.html');
      await writeFile(htmlPath, entries['OPEN_LOGO_CONFIGURATOR.html']!);
      const editor = await context.newPage();
      attachPageProbe(editor, probe);
      await editor.goto(pathToFileURL(htmlPath).href);
      await editor.locator('[data-customer-hook="file-input"]').setInputFiles({ name: projectEntry, mimeType: 'application/zip', buffer: Buffer.from(entries[projectEntry]!) });
      await expect(editor.locator('[data-customer-hook="project-id"]')).toHaveText(issuedProjectId);
      await revealCustomerControl(editor, 'instructions');
      await editor.locator('[data-customer-hook="instructions"]').fill('Hybrid customer change');
      await revealCustomerControl(editor, 'update');
      await editor.locator('[data-customer-hook="update"]').click();
      const saved = await readDownload(editor, 'hybrid-edited.logo-project', () => editor.locator('[data-customer-hook="save"]').click());
      expect((await parseProjectPackage(saved.bytes, { sha256 })).project.instructions).toBe('Hybrid customer change');
      expect(issued.assets.map((asset) => asset.path)).toEqual(['logos/syn-mark-a.svg']);
      await editor.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('issues self-contained HTML that opens standalone and auto-loads the project', async ({ browser }, info) => {
  const jobRef = 'BLD-SELF-01';
  const issuedProjectId = 'ACME-BLD-SELF-01';
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);
    await fillIdentity(page, CUSTOMER, jobRef, ISSUED_BY, issuedProjectId);
    await chooseFormat(page, 'self');
    await generate(page, issuedProjectId);
    await expect(page.locator('[data-builder-hook="download-package"]')).toBeEnabled();
    // Single-file mode: the primary download delivers the self-contained HTML
    // the customer opens directly.
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      page.locator('[data-builder-hook="download-package"]').click(),
    );
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    await expect(page.locator('[data-builder-hook="size-estimate"]')).toContainText('nothing to unzip');
    await page.evaluate(() => { document.querySelector('[data-builder-hook="download-html"]')?.closest('details')?.setAttribute('open', ''); });
    await expect(page.locator('[data-builder-hook="download-html"]')).toBeEnabled();
    const extra = await readDownload(page, 'extra.logo-project', () =>
      page.locator('[data-builder-hook="download-html"]').click(),
    );
    expect(extra.name).toBe(`${jobRef}.logo-project`);
    const embedded = extractEmbeddedProjectPackage(html.bytes);
    assert.ok(embedded, 'generated self-contained HTML should embed the issued project package');
    const embeddedParsed = await parseProjectPackage(embedded, { sha256 });
    expect(embeddedParsed.project.projectId).toBe(issuedProjectId);
    expect(embeddedParsed.project.revision).toBe(1);
    expect(embeddedParsed.project.description).toBe(expectedDescription(issuedProjectId, CUSTOMER, jobRef, ISSUED_BY));
    expectApprovalsCleared(embeddedParsed.project as unknown as Record<string, unknown>);

    directory = await mkdtemp(join(tmpdir(), 'logotool-builder-self-'));
    const htmlPath = join(directory, 'issued-self-contained.html');
    await writeFile(htmlPath, html.bytes);
    const editorPage = await context.newPage();
    attachPageProbe(editorPage, probe);
    await editorPage.goto(pathToFileURL(htmlPath).href);
    await expect(editorPage.locator('[data-customer-hook="project-id"]')).toHaveText(issuedProjectId);
    await expect(editorPage.locator('[data-customer-hook="revision"]')).toHaveText('1');
    await expect(editorPage.locator('[data-customer-hook="status"]')).not.toHaveText('Not loaded');
    const screenshots = info.outputPath('internal-builder-self-contained');
    await mkdir(screenshots, { recursive: true });
    await editorPage.setViewportSize({ width: 1280, height: 900 });
    await editorPage.screenshot({ path: join(screenshots, 'self-contained-1280x900.png'), fullPage: true });
    await editorPage.setViewportSize({ width: 390, height: 844 });
    await editorPage.screenshot({ path: join(screenshots, 'self-contained-390x844.png'), fullPage: true });
    await editorPage.close();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('issues a zero-logo (zero-artwork) selection end to end', async ({ browser }) => {
  const jobRef = 'BLD-ZERO-01';
  const issuedProjectId = 'ACME-BLD-ZERO-01';
  const { context, page, probe } = await openBuilder(browser);
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    // Core now permits logoIds: [] (0..N no-artwork valid): uncheck every
    // logo; product constraints still hold (>=1 product).
    await setListSelection(page, 'product-list', ['SYN-TEE-001']);
    await setListSelection(page, 'logo-list', []);
    await setListSelection(page, 'configuration-list', ['SYN-CFG-TEE-M']);
    await fillIdentity(page, CUSTOMER, jobRef, ISSUED_BY, issuedProjectId);
    await chooseFormat(page, 'hybrid');
    await generate(page, issuedProjectId);
    const downloaded = await readDownload(page, `${jobRef}.zip`, () =>
      page.locator('[data-builder-hook="download-package"]').click(),
    );
    expect(downloaded.name).toBe(`${jobRef}.zip`);
    const entries = unzipSync(downloaded.bytes);
    const projectEntry = Object.keys(entries).find((name) => name.endsWith('.logo-project'));
    assert.ok(projectEntry, 'hybrid ZIP should contain a .logo-project entry');
    const issued = await parseProjectPackage(entries[projectEntry]!, { sha256 });
    expect(issued.project.projectId).toBe(issuedProjectId);
    expect(issued.project.revision).toBe(1);
    expect(issued.project.logos).toHaveLength(0);
    expect(issued.assets).toHaveLength(0);
    expect(issued.project.configurations.map((configuration) => configuration.id)).toEqual(['SYN-CFG-TEE-M']);
    expect(issued.project.configurations.flatMap((configuration) => configuration.placements)).toHaveLength(0);
    expectApprovalsCleared(issued.project as unknown as Record<string, unknown>);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('rejects an invalid source without replacing the loaded selection', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);

    directory = await mkdtemp(join(tmpdir(), 'logotool-builder-bad-'));
    const badPath = join(directory, 'bad-source.logo-project');
    await writeFile(badPath, 'not a logo project');
    await page.locator('[data-builder-hook="source-file"]').setInputFiles(badPath);
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText('Could not load bad-source.logo-project');
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText('The previous source remains unchanged.');
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(FULL_PRODUCTS);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(FULL_LOGOS);
    expect(await checkedTopLevelIds(page, 'configuration-list')).toEqual(FULL_CONFIGURATIONS);
    await expect(page.locator('[data-builder-hook="product-list"]')).toContainText('SYN-TEE-001');

    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(FULL_PRODUCTS);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('clears generated outputs and the baseline when a different source loads', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);
    await fillIdentity(page, CUSTOMER, 'BLD-STALE-01', ISSUED_BY, 'ACME-BLD-STALE-01');
    await chooseFormat(page, 'hybrid');
    await generate(page, 'ACME-BLD-STALE-01');
    await expect(page.locator('[data-builder-hook="download-package"]')).toBeEnabled();
    await expect(page.locator('[data-builder-hook="download-baseline"]')).toBeEnabled();
    await expect(page.locator('[data-builder-hook="baseline-status"]')).toContainText('Retained issued baseline');

    const altBytes = new Uint8Array(await readFile(ALT_SOURCE_PATH));
    await dropSourceFile(page, altBytes, ALT_SOURCE_NAME);
    await expect(page.locator('[data-builder-hook="product-list"]')).toContainText('SYN-CAP-001');
    await expect(page.locator('[data-builder-hook="download-package"]')).toBeDisabled();
    await expect(page.locator('[data-builder-hook="download-html"]')).toBeDisabled();
    await expect(page.locator('[data-builder-hook="download-baseline"]')).toBeDisabled();
    await expect(page.locator('[data-builder-hook="review-panel"]')).toBeHidden();
    await expect(page.locator('[data-builder-hook="baseline-status"]')).toContainText('No issued baseline retained');
    await expect(page.locator('[data-builder-hook="size-estimate"]')).toHaveText('No issued package generated yet.');
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('keeps baseline bytes identical and reviews a customer-edited return', async ({ browser }) => {
  const jobRef = 'BLD-BASE-01';
  const issuedProjectId = 'ACME-BLD-BASE-01';
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);
    await fillIdentity(page, CUSTOMER, jobRef, ISSUED_BY, issuedProjectId);
    await generate(page, issuedProjectId);

    // The saved review copy button stays visible without opening disclosures.
    await expect(page.locator('[data-builder-hook="download-baseline"]')).toBeVisible();
    await expect(page.locator('main#internal-builder')).toContainText('Keep this review copy file');
    await expect(page.locator('[data-builder-hook="download-baseline"]')).toBeEnabled();
    await expect(page.locator('details', { has: page.locator('summary', { hasText: 'Other files and technical details' }) })).not.toHaveAttribute('open', '');
    await expect(page.locator('section[aria-label="Customer return review"] .banner')).toBeVisible();
    const baseline = await readDownload(page, `${jobRef}-issued-baseline.logo-project`, () =>
      page.locator('[data-builder-hook="download-baseline"]').click(),
    );
    expect(baseline.name).toBe(`${jobRef}-issued-baseline.logo-project`);
    // Default single-file mode: primary download is the self-contained HTML.
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      page.locator('[data-builder-hook="download-package"]').click(),
    );
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    const embedded = extractEmbeddedProjectPackage(html.bytes);
    assert.ok(embedded, 'generated self-contained HTML should embed the issued project package');
    expect(Buffer.from(baseline.bytes)).toEqual(Buffer.from(embedded));
    directory = await mkdtemp(join(tmpdir(), 'logotool-builder-return-'));
    const htmlPath = join(directory, 'issued-for-return.html');
    await writeFile(htmlPath, html.bytes);
    const editorPage = await context.newPage();
    attachPageProbe(editorPage, probe);
    await editorPage.goto(pathToFileURL(htmlPath).href);
    await expect(editorPage.locator('[data-customer-hook="project-id"]')).toHaveText(issuedProjectId);
    await revealCustomerControl(editorPage, 'instructions');
    await editorPage.locator('[data-customer-hook="instructions"]').fill('Builder return instructions.');
    await revealCustomerControl(editorPage, 'update');
    await editorPage.locator('[data-customer-hook="update"]').click();
    await expect(editorPage.locator('[data-customer-hook="revision"]')).toHaveText('2');
    await revealCustomerControl(editorPage, 'confirmed-by');
    await editorPage.locator('[data-customer-hook="confirmed-by"]').fill('Builder accept tester');
    await revealCustomerControl(editorPage, 'confirm');
    await editorPage.locator('[data-customer-hook="confirm"]').click();
    await expect(editorPage.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed: version');
    const returned = await readDownload(editorPage, 'builder-return.logo-project', () =>
      editorPage.locator('[data-customer-hook="submit"]').click(),
    );
    await editorPage.close();

    await page.locator('[data-builder-hook="return-file"]').setInputFiles({
      name: 'builder-return.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(returned.bytes),
    });
    await expect(page.locator('[data-builder-hook="review-panel"]')).toBeVisible();
    await expect(page.locator('[data-builder-hook="review-panel"]')).toContainText('Builder return instructions.');
    await expect(page.locator('[data-builder-hook="review-panel"]')).toContainText('ISSUED');
    await expect(page.locator('[data-builder-hook="review-panel"]')).toContainText('RETURNED');
    await expect(page.locator('[data-builder-hook="return-status"]')).toContainText('Internal review is pending.');
    await expect(page.locator('[data-builder-hook="ticket-summary"]')).toContainText(issuedProjectId);
    const fresh = await context.newPage();
    attachPageProbe(fresh, probe);
    await fresh.goto(BUILDER_HTML);
    await fresh.locator('[data-builder-hook="baseline-file"]').setInputFiles({ name: baseline.name, mimeType: 'application/zip', buffer: Buffer.from(baseline.bytes) });
    await expect(fresh.locator('[data-builder-hook="baseline-load-status"]')).toContainText('Loaded saved baseline');
    await expect(fresh.locator('[data-builder-hook="download-package"]')).toBeDisabled();
    const restored = await readDownload(fresh, 'restored-baseline.logo-project', () => fresh.locator('[data-builder-hook="download-baseline"]').click());
    expect(Buffer.from(restored.bytes)).toEqual(Buffer.from(baseline.bytes));
    await fresh.locator('[data-builder-hook="return-file"]').setInputFiles({ name: 'builder-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returned.bytes) });
    await expect(fresh.locator('[data-builder-hook="review-panel"]')).toBeVisible();
    const candidateFile = await readDownload(fresh, 'candidate.json', () => fresh.locator('[data-builder-hook="candidate-download"]').click());
    const candidate = JSON.parse(new TextDecoder().decode(candidateFile.bytes)) as { revision: number; digest: string };
    expect(candidate.revision).toBe(2);
    const printStyle = await fresh.locator('#internal-builder-operation-styles').textContent();
    await expect(fresh.locator('[data-builder-hook="operation-container"]')).toContainText(candidate.digest);
    const decodedStyle = printStyle!.replace(/\\([0-9a-f]+) /gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
    expect(decodedStyle).toContain('Revision 2');
    await fresh.emulateMedia({ media: 'print' });
    await expect(fresh.locator('main#internal-builder')).toBeHidden();
    await expect(fresh.locator('.lt-operation-document')).toBeVisible();
    await fresh.emulateMedia({ media: 'screen' });
    await expect(fresh.locator('[data-builder-hook="handoff-summary"]')).toContainText(candidateFile.name);
    await expect(fresh.locator('[data-builder-hook="handoff-summary"]')).toContainText('builder-return.logo-project');
    await fresh.locator('details').filter({ has: fresh.locator('[data-builder-hook="download-reviewer"]') }).locator('summary').click();
    const reviewer = await readDownload(fresh, 'reviewer.html', () => fresh.locator('[data-builder-hook="download-reviewer"]').click());
    const reviewerPath = join(directory, 'separate-reviewer.html');
    await writeFile(reviewerPath, reviewer.bytes);
    const reviewerPage = await context.newPage();
    attachPageProbe(reviewerPage, probe);
    await reviewerPage.goto(pathToFileURL(reviewerPath).href);
    await expect(reviewerPage.locator('h1')).toHaveText('Review a customer return');
    await reviewerPage.locator('[data-review-hook="baseline-file"]').setInputFiles({ name: baseline.name, mimeType: 'application/zip', buffer: Buffer.from(baseline.bytes) });
    await reviewerPage.locator('[data-review-hook="return-file"]').setInputFiles({ name: 'builder-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returned.bytes) });
    await expect(reviewerPage.locator('[data-review-hook="status"]')).toContainText('Return checked');
    await fresh.screenshot({ path: test.info().outputPath('builder-return-desktop.png'), fullPage: true });
    await fresh.setViewportSize({ width: 390, height: 844 });
    expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await fresh.screenshot({ path: test.info().outputPath('builder-return-mobile.png'), fullPage: true });
    // Explicitly selecting a saved baseline replaces the generated review context.
    await page.locator('[data-builder-hook="baseline-file"]').setInputFiles(TRUSTED_SOURCE_PATH);
    await expect(page.locator('[data-builder-hook="baseline-load-status"]')).toContainText('Loaded saved baseline');
    await expect(page.locator('[data-builder-hook="download-package"]')).toBeDisabled();
    await page.locator('[data-builder-hook="return-file"]').setInputFiles(TRUSTED_SOURCE_PATH);
    await expect(page.locator('[data-builder-hook="ticket-summary"]')).toContainText('SYN-PROJ-MULTI-001');
    const priorSummary = await page.locator('[data-builder-hook="ticket-summary"]').textContent();
    await page.locator('[data-builder-hook="return-file"]').setInputFiles({ name: 'wrong-issue.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returned.bytes) });
    await expect(page.locator('[data-builder-hook="return-status"]')).toContainText('baseline-project-mismatch');
    await expect(page.locator('[data-builder-hook="ticket-summary"]')).toHaveText(priorSummary!);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('invalidates downloads on edits and regenerates deterministic delivery bytes', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await fillIdentity(page, CUSTOMER, 'CON', ISSUED_BY);
    for (const format of ['self', 'hybrid'] as const) {
      await chooseFormat(page, format);
      await generate(page, ISSUED_PROJECT_ID);
      const first = await readDownload(page, `first-${format}`, () => page.locator('[data-builder-hook="download-package"]').click());
      await generate(page, ISSUED_PROJECT_ID);
      const second = await readDownload(page, `second-${format}`, () => page.locator('[data-builder-hook="download-package"]').click());
      if (format === 'self') {
        expect(second.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
        const embedded = extractEmbeddedProjectPackage(second.bytes);
        assert.ok(embedded, 'single-file primary download should embed the issued project package');
      }
      if (format === 'hybrid') {
        expect(second.name).toBe('_CON.zip');
        expect(Object.keys(unzipSync(second.bytes)).sort()).toEqual(['OPEN_LOGO_CONFIGURATOR.html', '_CON.logo-project']);
      }
      expect(Buffer.from(second.bytes)).toEqual(Buffer.from(first.bytes));
      const edit = page.locator('[data-builder-hook="customer-name"]');
      await edit.fill(`${CUSTOMER} changed`);
      await expect(page.locator('[data-builder-hook="download-html"]')).toBeDisabled();
      await expect(page.locator('[data-builder-hook="download-baseline"]')).toBeDisabled();
      await edit.fill(CUSTOMER);
    }
    await generate(page, ISSUED_PROJECT_ID);
    await page.locator('[data-builder-hook="logo-list"] input').first().uncheck();
    await expect(page.locator('[data-builder-hook="download-package"]')).toBeDisabled();
    await generate(page, ISSUED_PROJECT_ID);
    await chooseFormat(page, 'self');
    await expect(page.locator('[data-builder-hook="download-package"]')).toBeDisabled();
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

test('source reads reject oversized and unreadable files and discard obsolete reads', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await page.evaluate(() => {
      const native = File.prototype.arrayBuffer;
      const state = window as Window & { releaseRead?: () => void; oldReadDone?: boolean; oversizedRead?: boolean };
      File.prototype.arrayBuffer = function () {
        if (this.name === 'oversized.logo-project') { state.oversizedRead = true; return Promise.reject(new Error('must not read')); }
        if (this.name === 'unreadable.logo-project') return Promise.reject(new Error('synthetic read failure'));
        if (this.name === 'held.logo-project') return new Promise<ArrayBuffer>((resolve, reject) => { state.releaseRead = () => { void native.call(this).then((bytes) => { state.oldReadDone = true; resolve(bytes); }, reject); }; });
        return native.call(this);
      };
      const file = new File(['x'], 'oversized.logo-project');
      Object.defineProperty(file, 'size', { value: 48 * 1024 * 1024 + 1 });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.querySelector<HTMLInputElement>('[data-builder-hook="source-file"]')!;
      input.files = dt.files; input.dispatchEvent(new Event('change'));
    });
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText('rejected before reading');
    expect(await page.evaluate(() => (window as Window & { oversizedRead?: boolean }).oversizedRead)).toBeUndefined();
    await page.locator('[data-builder-hook="source-file"]').setInputFiles({ name: 'unreadable.logo-project', mimeType: 'application/zip', buffer: Buffer.from('bad') });
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText('synthetic read failure');
    await page.locator('[data-builder-hook="source-file"]').setInputFiles({ name: 'held.logo-project', mimeType: 'application/zip', buffer: Buffer.from(await readFile(TRUSTED_SOURCE_PATH)) });
    await expect(page.locator('[data-builder-hook="source-choose"]')).toBeDisabled();
    await dropSourceFile(page, new Uint8Array(await readFile(ALT_SOURCE_PATH)), ALT_SOURCE_NAME);
    await page.evaluate(() => (window as Window & { releaseRead?: () => void }).releaseRead!());
    await expect.poll(() => page.evaluate(() => (window as Window & { oldReadDone?: boolean }).oldReadDone)).toBe(true);
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText(`Loaded ${ALT_SOURCE_NAME}`);
    await expect(page.locator('[data-builder-hook="source-choose"]')).toBeEnabled();
    await fillIdentity(page, CUSTOMER, 'ZERO-SOURCE', ISSUED_BY);
    await generate(page, ISSUED_PROJECT_ID);
    const baseline = await readDownload(page, 'zero.logo-project', () => page.locator('[data-builder-hook="download-baseline"]').click());
    const parsed = await parseProjectPackage(baseline.bytes, { sha256 });
    expect(parsed.project.logos).toEqual([]);
    expect(parsed.assets).toEqual([]);
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

test('generation locks inputs, rejects obsolete hashing and recovers from hash failures', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await fillIdentity(page, CUSTOMER, 'HASH-RACE', ISSUED_BY);
    await page.evaluate(() => {
      const native = crypto.subtle.digest.bind(crypto.subtle);
      const state = window as Window & { releaseHash?: () => void; hashDone?: boolean; rejectNext?: boolean };
      let held = false;
      crypto.subtle.digest = (algorithm, data) => {
        if (state.rejectNext) { state.rejectNext = false; return Promise.reject(new Error('synthetic hash failure')); }
        if (!held) { held = true; return new Promise<ArrayBuffer>((resolve, reject) => { state.releaseHash = () => { void native(algorithm, data).then((bytes) => { state.hashDone = true; resolve(bytes); }, reject); }; }); }
        return native(algorithm, data);
      };
    });
    await page.locator('[data-builder-hook="generate"]').click();
    await expect(page.locator('[data-builder-hook="customer-name"]')).toBeDisabled();
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-builder-hook="customer-name"]')!;
      input.value = 'Changed while hashing'; input.dispatchEvent(new Event('input'));
      (window as Window & { releaseHash?: () => void }).releaseHash!();
    });
    await expect.poll(() => page.evaluate(() => (window as Window & { hashDone?: boolean }).hashDone)).toBe(true);
    await expect(page.locator('[data-builder-hook="download-baseline"]')).toBeDisabled();
    await page.evaluate(() => { (window as Window & { rejectNext?: boolean }).rejectNext = true; });
    await page.locator('[data-builder-hook="generate"]').click();
    await expect(page.locator('[data-builder-hook="generate-status"]')).toContainText('synthetic hash failure');
    await expect(page.locator('[data-builder-hook="customer-name"]')).toBeEnabled();
    await generate(page, ISSUED_PROJECT_ID);
    expectOfflineClean(probe);
  } finally { await context.close(); }
});
