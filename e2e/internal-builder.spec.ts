import { gotoBuilder, revealBuilderControl, revealCustomerControl } from './helpers.js';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { extractEmbeddedProjectPackage } from '../src/packaging/self-contained-html/index.js';
import { confirmRevision, contentDigest, newRevision } from '../src/core/index.js';
import type { ProjectDocument, Sha256HexFn } from '../src/core/index.js';

// Internal-builder acceptance (guided proof-desk redesign). Opens the
// already-built dist/internal-builder.html offline through file:// (the spec
// never rebuilds; `npm run build` runs first). Every test asserts zero
// console/page errors and zero HTTP(S) requests.
//
// Guided UI (src/ui/internal-builder/template.html):
// - Header modes Prepare a project / Review a return
//   ([data-builder-hook="mode-prepare"/"mode-review"], panels
//   [data-builder-mode-panel="prepare"/"review"]). Review mode never shows
//   source/identity panels.
// - Prepare steps Open project / Choose items / Customer details / Save & send
//   ([data-builder-hook="step-open"/"step-choose"/"step-details"/"step-send"],
//   panels [data-builder-step="open"/...]). builder-next/builder-back move
//   between steps without mutating selections or outputs; tabs/mode switches
//   alone never invalidate generated downloads.
// - Review steps Office copy / Customer return / Check & prepare
//   (step-office/step-return/step-check). Fresh sessions prominently offer
//   `Choose office copy` first, never behind an advanced disclosure.
// - EVERY builder interaction goes through revealBuilderControl(page, name)
//   (e2e/helpers.ts): real mode/step/disclosure navigation, keyboard-capable.
//   Tests never force hidden fields visible.
// - source-status: `Loaded <file>: project <id> revision <rev>, …` on success;
//   `Could not load <file>: <detail>.` on failure (previous source kept, error
//   actionable even if the current step differs).
// - Choose items: product rows are top-level product checkboxes plus nested
//   variant checkboxes (`[data-product]`); logo list is flat;
//   configuration-list lives inside the collapsed `Choose specific setups`
//   disclosure. Nothing is pre-selected on source load (empty start); the
//   operator ticks products/logos/setups deliberately or uses Try demo data.
//   counts the actual selection; selection-error reports invalid selections
//   here, so Continue never needs job identity.
// - Customer details shows only Customer name / Job reference / Prepared by.
//   The issued project ID is generated automatically (fresh local ID, stable
//   across navigation and repeated generation, never the source ID) and lives
//   with the format choice behind More options; manual overrides are kept.
//   Format defaults to self-contained HTML; ZIP is the More-options
//   alternative. `Create customer file` is the single primary; success reads
//   `Issued <id> revision 1 …` and advances to Save & send.
// - Save & send offers TWO plain file actions: `Save office copy` (the
//   retained issued baseline, byte-identical to the issued project — save it
//   before closing, browser memory is lost) and `Save customer file` (the
//   delivery in the selected format, sent manually; the app never sends).
//   File details (file-details) discloses the job/customer summary and sizes.
// - Check & prepare shows readable filenames (review-files), exact changes and
//   customer confirmation/fit (review-changes), explicit pending-review
//   status, primary Print / save PDF and secondary Save production data
//   (candidate JSON). No approval or Odoo sending is claimed anywhere.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

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

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

/** Reveal a builder control through real mode/disclosure navigation. */
async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return ['builder-next','builder-back'].includes(name)
    ? builder(page,name).filter({visible:true}).first()
    : builder(page,name);
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
  await gotoBuilder(page);
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
  await expect(page.locator('[data-builder-step="open"]')).toBeVisible();
  return { context, page, probe };
}

async function freshBuilderPage(context: BrowserContext, probe: Probe): Promise<Page> {
  const fresh = await context.newPage();
  attachPageProbe(fresh, probe);
  await gotoBuilder(fresh);
  return fresh;
}

async function loadSourceFile(page: Page, path: string, fileName: string): Promise<void> {
  await (await shown(page, 'source-file')).setInputFiles(path);
  await expect(await shown(page, 'source-status')).toContainText(`Loaded ${fileName}`);
}

async function dropSourceFile(page: Page, bytes: Uint8Array, fileName: string): Promise<void> {
  // During a deliberately held read, inject the replacement event directly
  // to exercise the stale-completion guard; normal drops navigate to Open.
  if (await builder(page,'step-open').isEnabled()) await builder(page,'step-open').click();
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
  await expect(await shown(page, 'source-status')).toContainText(`Loaded ${fileName}`);
}

async function variantIds(page: Page, productId: string): Promise<string[]> {
  return page.evaluate((product: string): string[] => {
    const root = document.querySelector('[data-builder-hook="product-list"]');
    if (!root) throw new Error('Missing builder product list.');
    return Array.from(root.querySelectorAll(`input[type="checkbox"][data-product="${product}"]`))
      .map((element) => (element as HTMLInputElement).value);
  }, productId);
}

async function setChecked(box: Locator, checked: boolean): Promise<void> {
  // Deliberate selection must produce the same change events as real human
  // toggles: Playwright check()/uncheck() are silent no-ops when the box
  // already matches, which would hide deliberate setup narrowing from the
  // automatic-inclusion tracking.
  await box.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.checked = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

async function setListSelection(page: Page, listHook: string, ids: string[]): Promise<void> {
  const list = await shown(page, listHook);
  const boxes = list.locator('input[type="checkbox"]');
  const count = await boxes.count();
  const seen: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    const value = (await box.getAttribute('value')) ?? '';
    const nestedProduct = await box.getAttribute('data-product');
    // The product list nests variant checkboxes (data-product set) under each
    // product. Product selection implies its variants (new empty-start UX
    // leaves every box unchecked; variants of a chosen product must be
    // ticked deliberately, mirroring the old all-checked default).
    // Dispatched assignments (never visibility-gated) keep hidden nested
    // boxes consistent too, in DOM order, as parents toggle.
    if (nestedProduct !== null) {
      await setChecked(box, ids.includes(nestedProduct));
      continue;
    }
    seen.push(value);
    await setChecked(box, ids.includes(value));
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

/** Details-step helpers return to Customer details first (real tab nav). */
async function gotoDetails(page: Page): Promise<void> {
  await (await shown(page, 'step-details')).click();
  await expect(page.locator('[data-builder-step="details"]')).toBeVisible();
}

async function fillIdentity(page: Page, customer: string, job: string, by: string, projectId?: string): Promise<void> {
  await gotoDetails(page);
  await (await shown(page, 'customer-name')).fill(customer);
  await (await shown(page, 'job-ref')).fill(job);
  await (await shown(page, 'issued-by')).fill(by);
  // The issued project ID is technical and lives behind More options; only
  // override the automatic value when a test needs a fixed ID.
  if (projectId !== undefined) await (await shown(page, 'project-id')).fill(projectId);
}

async function readProjectId(page: Page): Promise<string> {
  // Pure read: inputValue works on hidden steps, so never navigate here —
  // callers asserting post-generation state must stay on Save & send.
  await revealBuilderControl(page, 'project-id');
  return builder(page, 'project-id').inputValue();
}

async function chooseFormat(page: Page, format: 'self' | 'hybrid'): Promise<void> {
  await gotoDetails(page);
  const target = await shown(page, `format-${format}`);
  await target.check();
  await expect(target).toBeChecked();
}

async function createCustomerFile(page: Page, issuedProjectId: string): Promise<void> {
  // Generation lives on Customer details; return there explicitly so repeat
  // generation from Save & send works through real tab navigation.
  await (await shown(page, 'step-details')).click();
  const primary = await shown(page, 'generate');
  await expect(primary).toContainText('Create customer file');
  await primary.click();
  await expect(await shown(page, 'generate-status')).toContainText(
    `Issued ${issuedProjectId} revision 1`,
  );
  await expect(await shown(page, 'baseline-status')).toContainText(
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

test('guided preparation flows from open to deliberate selection to details', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    // Initial view is Open project only: future steps stay hidden, with a
    // prominent chooser and dropzone plus one short sentence.
    await expect(builder(page, 'start-create')).toBeVisible();
    await builder(page,'start-open-toggle').click();
    await expect(builder(page, 'source-choose')).toBeVisible();
    await expect(builder(page, 'source-drop')).toBeVisible();
    await expect(page.locator('[data-builder-step="choose"]')).toBeHidden();
    await expect(page.locator('[data-builder-step="details"]')).toBeHidden();
    await expect(page.locator('[data-builder-step="send"]')).toBeHidden();
    await expect(page.locator('[data-builder-mode-panel="review"]')).toBeHidden();

    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await expect(builder(page, 'source-status')).toContainText(
      'Loaded trusted-issued.logo-project: project SYN-PROJ-MULTI-001 revision 1',
    );
    // A successful load progresses to Choose items.
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    // The new-source action stays easy to find after loading.
    await expect(await shown(page, 'new-source')).toBeVisible();
    expect(await variantIds(page, 'SYN-TEE-001')).toEqual(['SYN-TEE-M', 'SYN-TEE-XL']);
    expect(await variantIds(page, 'SYN-TR-001')).toEqual(['SYN-TR-REG', 'SYN-TR-SHORT']);
    // Empty start: nothing is pre-selected on source load. The operator ticks
    // what the customer needs; here the full catalogue is chosen deliberately.
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual([]);
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);
    // Choosing setups opens its disclosure; collapse it again so the
    // default journey keeps technical setups out of sight.
    await page.locator('details', { has: page.locator('[data-builder-hook="configuration-list"]') }).locator('summary').click();
    // The deliberate selection above is reflected; names stay readable.
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(FULL_PRODUCTS);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(FULL_LOGOS);
    expect(await checkedTopLevelIds(page, 'configuration-list')).toEqual(FULL_CONFIGURATIONS);
    await expect(await shown(page, 'product-list')).toContainText('Synthetic Tee');
    await expect(await shown(page, 'logo-list')).toContainText('Synthetic Mark B');
    // The rail summary counts the actual selection; advanced setups stay
    // collapsed and out of the default journey.
    await expect(await shown(page, 'selection-summary')).toContainText('2 products');
    await expect(builder(page, 'selection-summary')).toContainText('2 logos');
    await expect(builder(page, 'configuration-list')).toBeHidden();

    // Continue reaches Customer details without needing job identity yet.
    await (await shown(page, 'builder-next')).click();
    await expect(page.locator('[data-builder-step="details"]')).toBeVisible();
    await expect(await shown(page, 'customer-name')).toBeVisible();
    await expect(await shown(page, 'job-ref')).toBeVisible();
    await expect(await shown(page, 'issued-by')).toBeVisible();
    // The technical ID and format choice are not part of the default journey.
    await expect(builder(page, 'project-id')).toBeHidden();
    await expect(builder(page, 'format-self')).toBeHidden();
    await expect(builder(page, 'format-hybrid')).toBeHidden();

    // Back does not mutate selections; validation appears here on Choose items.
    await (await shown(page, 'builder-back')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(FULL_PRODUCTS);
    await setListSelection(page, 'product-list', []);
    await expect(await shown(page, 'selection-summary')).toContainText('0 products');
    await expect(await shown(page, 'selection-error')).not.toBeEmpty();
    await expect(await shown(page, 'builder-next')).toBeDisabled();
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await expect(await shown(page, 'builder-next')).toBeEnabled();
    await (await shown(page, 'builder-next')).click();
    await expect(page.locator('[data-builder-step="details"]')).toBeVisible();

    await fillIdentity(page, CUSTOMER, 'BUILDER-PREVIEW', ISSUED_BY);
    // More options opens from the keyboard and reveals the automatic ID,
    // which is fresh and never silently reuses the source project ID.
    const moreOptions = page.locator('details', { has: page.locator('[data-builder-hook="project-id"]') });
    await expect(moreOptions).not.toHaveAttribute('open', '');
    await moreOptions.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(builder(page, 'project-id')).toBeVisible();
    const autoId = await builder(page, 'project-id').inputValue();
    expect(autoId.length).toBeGreaterThan(0);
    expect(autoId).not.toContain('SYN-PROJ-MULTI-001');

    const generatedId = autoId;
    await createCustomerFile(page, generatedId);
    // Success advances to Save & send: exactly two plain file actions.
    await expect(page.locator('[data-builder-step="send"]')).toBeVisible();
    await expect(await shown(page, 'download-baseline')).toContainText('Save office copy');
    await expect(await shown(page, 'download-package')).toContainText('Save customer file');
    await expect(await shown(page, 'download-baseline')).toBeEnabled();
    await expect(await shown(page, 'download-package')).toBeEnabled();
    await expect(await shown(page, 'baseline-status')).toContainText('bytes');
    // File details discloses the job/customer summary and exact sizes.
    await expect(await shown(page, 'file-details')).toContainText('BUILDER-PREVIEW');
    await expect(builder(page, 'file-details')).toContainText(CUSTOMER);

    await page.screenshot({ path: test.info().outputPath('builder-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Guided step navigation stays reachable on a narrow viewport.
    await (await shown(page, 'builder-back')).click();
    await expect(page.locator('[data-builder-step="details"]')).toBeVisible();
    await (await shown(page, 'step-send')).click();
    await expect(page.locator('[data-builder-step="send"]')).toBeVisible();
    await expect(await shown(page, 'download-package')).toBeEnabled();
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
    await expect(await shown(page, 'selection-summary')).toContainText('1 product');
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, CUSTOMER, jobRef, ISSUED_BY, issuedProjectId);
    // Self-contained HTML is the default; the ZIP alternative is chosen here
    // from More options, which chooseFormat opens through real navigation.
    await chooseFormat(page, 'hybrid');
    await createCustomerFile(page, issuedProjectId);
    await expect(page.locator('[data-builder-step="send"]')).toBeVisible();
    await expect(await shown(page, 'download-package')).toContainText('Save customer file');
    await expect(await shown(page, 'download-baseline')).toContainText('Save office copy');

    const downloaded = await readDownload(page, `${jobRef}.zip`, () =>
      shown(page, 'download-package').then((control) => control.click()),
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
      await editor.locator('[data-customer-hook="instructions"]').press('Tab');
      // Note edits auto-apply as a new revision (no separate Apply step).
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
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, CUSTOMER, jobRef, ISSUED_BY);
    // Self-contained HTML is the default without opening More options.
    await expect(builder(page, 'format-self')).toBeChecked();
    const issuedProjectId = await readProjectId(page);
    expect(issuedProjectId.length).toBeGreaterThan(0);
    await createCustomerFile(page, issuedProjectId);
    // Single-file mode: `Save customer file` delivers the self-contained HTML
    // the customer opens directly.
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      shown(page, 'download-package').then((control) => control.click()),
    );
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    await expect(await shown(page, 'baseline-status')).toContainText('bytes');
    const extra = await readDownload(page, 'extra.logo-project', () =>
      shown(page, 'download-html').then((control) => control.click()),
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
    await expect(await shown(page, 'selection-summary')).toContainText('0 logos');
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, CUSTOMER, jobRef, ISSUED_BY, issuedProjectId);
    await chooseFormat(page, 'hybrid');
    await createCustomerFile(page, issuedProjectId);
    const downloaded = await readDownload(page, `${jobRef}.zip`, () =>
      shown(page, 'download-package').then((control) => control.click()),
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

test('checking a prepared product and variant includes its setups without opening specific setups', async ({ browser }) => {
  // Release-blocking regression (native acceptance): ticking a prepared
  // product + variant must make its existing setups issuable WITHOUT opening
  // the collapsed Choose specific setups disclosure. Otherwise the issue
  // silently ships configurations: [] and drops every photo/model/mapping.
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    const base = await parseProjectPackage(new Uint8Array(await readFile(ALT_SOURCE_PATH)), { sha256 });
    const config = base.project.configurations.find((item) => item.id === 'SYN-CFG-CAP-OS')!;
    const product = base.project.products.find((item) => item.id === config.productId)!;
    const region = product.regions.find((item) => item.id === 'SYN-CAP-FRONT')!;
    const pngBase64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 20; canvas.height = 10;
      const context2d = canvas.getContext('2d')!;
      context2d.fillStyle = '#12394b'; context2d.fillRect(0, 0, 20, 10);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    const png = new Uint8Array(Buffer.from(pngBase64, 'base64'));
    const xs = region.safeArea.map((point) => point[0]);
    const ys = region.safeArea.map((point) => point[1]);
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const sourceBytes = await createProjectPackage({
      project: base.project,
      assets: base.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
      additionalAssets: [
        { path: 'presentation/preview.json', bytes: new TextEncoder().encode(JSON.stringify({ version: 2, views: [{ productId: product.id, variantId: config.variantId, view: 'front', image: 'presentation/front.png' }] })) },
        { path: 'presentation/front.png', bytes: png },
        {
          path: 'presentation/photo-mappings.json',
          bytes: new TextEncoder().encode(JSON.stringify({
            version: 1,
            mappings: [{
              productId: product.id, variantId: config.variantId, regionId: region.id,
              view: 'front', image: 'presentation/front.png',
              transform: { a: 1 / (maxX - minX), b: 0, c: -minX / (maxX - minX), d: 0, e: -1 / (maxY - minY), f: maxY / (maxY - minY) },
              calibrationId: region.calibrationRef.calibrationId, calibrationVersion: region.calibrationRef.version,
              status: 'provisional',
            }],
          })),
        },
      ],
    }, { sha256 });
    directory = await mkdtemp(join(tmpdir(), 'logotool-auto-include-'));
    const sourcePath = join(directory, 'prepared-cap.logo-project');
    await writeFile(sourcePath, sourceBytes);
    await loadSourceFile(page, sourcePath, 'prepared-cap.logo-project');
    // Tick ONLY product + variant through visible controls. The setups
    // disclosure is never opened here.
    await setListSelection(page, 'product-list', ['SYN-CAP-001']);
    await expect(await shown(page, 'selection-summary')).toContainText('1 product');
    await expect(await shown(page, 'builder-next')).toBeEnabled();
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, CUSTOMER, 'BLD-AUTO-01', ISSUED_BY, 'ACME-BLD-AUTO-01');
    await createCustomerFile(page, 'ACME-BLD-AUTO-01');
    const baseline = await readDownload(page, 'auto-issue.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()),
    );
    const issued = await parseProjectPackage(baseline.bytes, { sha256 });
    // The matching zero-placement setup shipped (not configurations: []),
    // with photos/model evidence and the mapping retained.
    expect(issued.project.configurations.map((entry) => entry.id)).toEqual(['SYN-CFG-CAP-OS']);
    expect(issued.project.configurations.flatMap((entry) => entry.placements)).toHaveLength(0);
    const mappingBytes = issued.assets.find((asset) => asset.path === 'presentation/photo-mappings.json')?.bytes;
    assert.ok(mappingBytes, 'issued package retains the photo mapping');
    assert.ok(issued.assets.some((asset) => asset.path === 'presentation/front.png'), 'issued package retains the photo');
    assert.ok(issued.assets.some((asset) => asset.path === 'presentation/preview.json'), 'issued package retains the manifest');
    // The customer file opens editable with the mapped side available.
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      shown(page, 'download-package').then((control) => control.click()),
    );
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    const htmlPath = join(directory, 'issued-auto.html');
    await writeFile(htmlPath, html.bytes);
    const editor = await context.newPage();
    attachPageProbe(editor, probe);
    await editor.goto(pathToFileURL(htmlPath).href);
    await expect(editor.locator('[data-customer-hook="project-id"]')).toHaveText('ACME-BLD-AUTO-01');
    await expect(editor.locator('[data-customer-hook="side-front"]')).toBeEnabled();
    await editor.close();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('fractional millimetres render rounded once in staff return comparisons', async ({ browser }) => {
  // Staff "What changed" copy rounds display values (108.1 mm, never
  // 108.11145510835912 mm); canonical bytes and the technical appendix keep
  // full precision.
  const sha256Text: Sha256HexFn = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  const issuedBytes = new Uint8Array(await readFile(TRUSTED_SOURCE_PATH));
  const issued = await parseProjectPackage(issuedBytes, { sha256 });
  const fractional = newRevision(issued.project, (draft: ProjectDocument) => {
    const placement = draft.configurations[0]!.placements[0]!;
    placement.pos.xMm = -65.123456;
    placement.pos.yMm = 30.987654;
    placement.widthMm = 108.11145510835912;
    placement.heightMm = 40.22222222222222;
    placement.rotationDeg = 15.55555555555555;
  });
  const digest = contentDigest(fractional, sha256Text);
  const confirmed = confirmRevision(fractional, {
    confirmedBy: 'Synthetic customer',
    confirmedAt: '2026-10-13T12:00:00.000Z',
    digestOf: digest,
  }, sha256Text);
  assert.ok(confirmed.ok, 'synthetic confirmation must bind');
  const returnedBytes = await createProjectPackage({
    project: confirmed.project,
    assets: issued.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
    additionalAssets: issued.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes })),
  }, { sha256 });
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'baseline-file')).setInputFiles({ name: 'office-copy.logo-project', mimeType: 'application/zip', buffer: Buffer.from(issuedBytes) });
    await expect(await shown(page, 'baseline-load-status')).toContainText('Loaded saved baseline');
    await (await shown(page, 'step-return')).click();
    await (await shown(page, 'return-file')).setInputFiles({ name: 'fractional-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returnedBytes) });
    await expect(await shown(page, 'review-panel')).toBeVisible();
    const changes = builder(page, 'review-changes');
    await expect(changes).toContainText('108.1 \u00d7');
    await expect(changes).toContainText('-65.1, 31.0');
    await expect(changes).toContainText('15.6\u00b0');
    await expect(changes).not.toContainText('108.11145510835912');
    await expect(changes).not.toContainText('30.987654');
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
    await (await shown(page, 'source-file')).setInputFiles(badPath);
    // The failure stays actionable even though loading advanced to Choose items.
    await expect(await shown(page, 'source-status')).toContainText('Could not load bad-source.logo-project');
    await expect(builder(page, 'source-status')).toContainText('The previous source remains unchanged.');
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual(FULL_PRODUCTS);
    expect(await checkedTopLevelIds(page, 'logo-list')).toEqual(FULL_LOGOS);
    expect(await checkedTopLevelIds(page, 'configuration-list')).toEqual(FULL_CONFIGURATIONS);
    await expect(await shown(page, 'product-list')).toContainText('Synthetic Tee');

    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    // A fresh source load starts empty again; re-select deliberately.
    expect(await checkedTopLevelIds(page, 'product-list')).toEqual([]);
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);
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
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, CUSTOMER, 'BLD-STALE-01', ISSUED_BY, 'ACME-BLD-STALE-01');
    await chooseFormat(page, 'hybrid');
    await createCustomerFile(page, 'ACME-BLD-STALE-01');
    await expect(await shown(page, 'download-package')).toBeEnabled();
    await expect(await shown(page, 'download-baseline')).toBeEnabled();
    await expect(builder(page, 'baseline-status')).toContainText('Retained issued baseline');

    const altBytes = new Uint8Array(await readFile(ALT_SOURCE_PATH));
    await dropSourceFile(page, altBytes, ALT_SOURCE_NAME);
    await expect(await shown(page, 'product-list')).toContainText('Synthetic Cap');
    await expect(builder(page, 'download-package')).toBeDisabled();
    await expect(builder(page, 'download-html')).toBeDisabled();
    await expect(builder(page, 'download-baseline')).toBeDisabled();
    await expect(builder(page, 'review-panel')).toBeHidden();
    await expect(await shown(page, 'baseline-status')).toContainText('No issued baseline retained');
    await expect(await shown(page, 'size-estimate')).toHaveText('No issued package generated yet.');
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('saves two files, opens the customer file, and reviews the return against the office copy', async ({ browser }) => {
  const jobRef = 'BLD-BASE-01';
  const issuedProjectId = 'ACME-BLD-BASE-01';
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, CUSTOMER, jobRef, ISSUED_BY, issuedProjectId);
    await createCustomerFile(page, issuedProjectId);
    await expect(page.locator('[data-builder-step="send"]')).toBeVisible();

    // Save & send names the two files and their purposes in plain language.
    await expect(await shown(page, 'download-baseline')).toContainText('Save office copy');
    await expect(await shown(page, 'download-package')).toContainText('Save customer file');
    await expect(await shown(page, 'baseline-status')).toContainText('before closing');
    const baseline = await readDownload(page, `${jobRef}-issued-baseline.logo-project`, () =>
      shown(page, 'download-baseline').then((control) => control.click()),
    );
    expect(baseline.name).toBe(`${jobRef}-issued-baseline.logo-project`);
    // Default single-file mode: the customer file is the self-contained HTML.
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      shown(page, 'download-package').then((control) => control.click()),
    );
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    const embedded = extractEmbeddedProjectPackage(html.bytes);
    assert.ok(embedded, 'generated self-contained HTML should embed the issued project package');
    expect(Buffer.from(baseline.bytes)).toEqual(Buffer.from(embedded));

    // Extract and open the real customer file, edit it, and return it.
    directory = await mkdtemp(join(tmpdir(), 'logotool-builder-return-'));
    const htmlPath = join(directory, 'issued-for-return.html');
    await writeFile(htmlPath, html.bytes);
    const editorPage = await context.newPage();
    attachPageProbe(editorPage, probe);
    await editorPage.goto(pathToFileURL(htmlPath).href);
    await expect(editorPage.locator('[data-customer-hook="project-id"]')).toHaveText(issuedProjectId);
    await revealCustomerControl(editorPage, 'instructions');
    await editorPage.locator('[data-customer-hook="instructions"]').fill('Builder return instructions.');
    await editorPage.locator('[data-customer-hook="instructions"]').press('Tab');
    // Note edits auto-apply as a new revision (no separate Apply step).
    await expect(editorPage.locator('[data-customer-hook="revision"]')).toHaveText('2');
    await revealCustomerControl(editorPage, 'confirmed-by');
    await editorPage.locator('[data-customer-hook="confirmed-by"]').fill('Builder accept tester');
    await revealCustomerControl(editorPage, 'confirm');
    await editorPage.locator('[data-customer-hook="confirm"]').click();
    await expect(editorPage.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed: version');
    const returned = await readDownload(editorPage, 'builder-return.logo-project', () =>
      editorPage.locator('[data-customer-hook="submit"]').click(),
    );
    // A further edit saved as a draft (never reconfirmed) also returns
    // cleanly: confirmation is customer-side data, never internal authority.
    await revealCustomerControl(editorPage, 'instructions');
    await editorPage.locator('[data-customer-hook="instructions"]').fill('Second unconfirmed edit.');
    await editorPage.locator('[data-customer-hook="instructions"]').press('Tab');
    await expect(editorPage.locator('[data-customer-hook="revision"]')).toHaveText('3');
    await revealCustomerControl(editorPage, 'save');
    const unconfirmed = await readDownload(editorPage, 'builder-return-unconfirmed.logo-project', () =>
      editorPage.locator('[data-customer-hook="save"]').click(),
    );
    await editorPage.close();

    // Review mode is separate from preparation: no source/identity panels.
    await (await shown(page, 'mode-review')).click();
    await expect(page.locator('[data-builder-mode-panel="review"]')).toBeVisible();
    await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeHidden();
    // The generated baseline is already the review context after issuing.
    await (await shown(page, 'return-file')).setInputFiles({
      name: 'builder-return.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(returned.bytes),
    });
    await expect(await shown(page, 'review-panel')).toBeVisible();
    await expect(builder(page, 'review-panel')).toContainText('Builder return instructions.');
    await expect(builder(page, 'review-panel')).toContainText('ISSUED');
    await expect(builder(page, 'review-panel')).toContainText('RETURNED');
    await expect(await shown(page, 'review-files')).toContainText('builder-return.logo-project');
    await expect(builder(page, 'return-status')).toContainText('Internal review is pending.');
    await expect(builder(page, 'ticket-summary')).toContainText(issuedProjectId);
    // The unconfirmed return stays safe: pending review, never approved.
    await (await shown(page, 'return-file')).setInputFiles({
      name: 'builder-return-unconfirmed.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(unconfirmed.bytes),
    });
    await expect(await shown(page, 'review-panel')).toBeVisible();
    await expect(builder(page, 'review-panel')).toContainText('Second unconfirmed edit.');
    await expect(builder(page,'review-changes')).toContainText('Customer confirmation is missing or out of date.');
    await expect(builder(page, 'return-status')).toContainText('Internal review is pending.');

    // Fresh session: Review asks for the office copy FIRST, with no advanced
    // help, and restores the exact saved bytes for the return check.
    const fresh = await freshBuilderPage(context, probe);
    await (await shown(fresh, 'mode-review')).click();
    await expect(fresh.locator('[data-builder-step="office"]')).toBeVisible();
    await expect(fresh.locator('[data-builder-step="office"]')).toContainText('Choose office copy');
    await expect(fresh.locator('[data-builder-step="check"]')).toBeHidden();
    await (await shown(fresh, 'baseline-file')).setInputFiles({ name: baseline.name, mimeType: 'application/zip', buffer: Buffer.from(baseline.bytes) });
    await expect(await shown(fresh, 'baseline-load-status')).toContainText('Loaded saved baseline');
    // Loading a saved baseline never implies a customer delivery exists.
    await expect(builder(fresh, 'download-package')).toBeDisabled();
    // The office-copy download lives on Save & send: visit it explicitly.
    await (await shown(fresh, 'step-office')).click();
    const restored = await readDownload(fresh, 'restored-baseline.logo-project', () =>
      shown(fresh, 'office-download').then((control) => control.click()),
    );
    expect(Buffer.from(restored.bytes)).toEqual(Buffer.from(baseline.bytes));
    await (await shown(fresh, 'step-return')).click();
    await (await shown(fresh, 'return-file')).setInputFiles({ name: 'builder-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returned.bytes) });
    await expect(await shown(fresh, 'review-panel')).toBeVisible();
    await expect(await shown(fresh, 'review-changes')).toContainText('Builder return instructions.');
    const candidateFile = await readDownload(fresh, 'candidate.json', () =>
      shown(fresh, 'candidate-download').then((control) => control.click()),
    );
    const candidate = JSON.parse(new TextDecoder().decode(candidateFile.bytes)) as { revision: number; digest: string };
    expect(candidate.revision).toBe(2);
    // The one-sheet operator preview prints business data only: no digest,
    // revision, or config ids — and customer notes are source context, never
    // printed as operational instructions.
    await (await shown(fresh, 'preview-document')).click();
    await expect(builder(fresh, 'operation-container').locator('.opsheet').first()).toBeVisible();
    await expect(builder(fresh, 'operation-container')).not.toContainText(candidate.digest);
    await expect(builder(fresh, 'operation-container')).not.toContainText('Builder return instructions.');
    await expect(builder(fresh, 'operation-container')).toContainText('setup needed before production');
    const printStyle = await fresh.locator('#internal-builder-operation-styles').textContent();
    expect(printStyle).toContain('A4 landscape');
    await fresh.emulateMedia({ media: 'print' });
    await expect(fresh.locator('main#internal-builder')).toBeHidden();
    await expect(fresh.locator('.opsheet').first()).toBeVisible();
    await fresh.emulateMedia({ media: 'screen' });
    await expect(await shown(fresh, 'handoff-summary')).toContainText(candidateFile.name);
    await expect(builder(fresh, 'handoff-summary')).toContainText('builder-return.logo-project');
    // The standalone reviewer download lives on Save & send: visit it explicitly.
    await (await shown(fresh, 'step-check')).click();
    const reviewer = await readDownload(fresh, 'reviewer.html', () =>
      shown(fresh, 'reviewer-copy').then((control) => control.click()),
    );
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
    await (await shown(fresh, 'step-return')).click();
    await expect(await shown(fresh, 'return-file')).toBeVisible();
    await fresh.screenshot({ path: test.info().outputPath('builder-return-mobile.png'), fullPage: true });
    // Explicitly selecting a saved baseline replaces the generated review context.
    await (await shown(page, 'baseline-file')).setInputFiles(TRUSTED_SOURCE_PATH);
    await expect(await shown(page, 'baseline-load-status')).toContainText('Loaded saved baseline');
    await expect(builder(page, 'download-package')).toBeDisabled();
    await (await shown(page, 'return-file')).setInputFiles(TRUSTED_SOURCE_PATH);
    await expect(await shown(page, 'ticket-summary')).toContainText('SYN-PROJ-MULTI-001');
    const priorSummary = await (await shown(page, 'ticket-summary')).textContent();
    await (await shown(page, 'return-file')).setInputFiles({ name: 'wrong-issue.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returned.bytes) });
    await expect(await shown(page, 'return-status')).toContainText('baseline-project-mismatch');
    await expect(builder(page, 'ticket-summary')).toHaveText(priorSummary!);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('keeps the automatic project ID stable and regenerates deterministic delivery bytes', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await loadSourceFile(page, TRUSTED_SOURCE_PATH, TRUSTED_SOURCE_NAME);
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, CUSTOMER, 'CON', ISSUED_BY);
    const firstId = await readProjectId(page);
    expect(firstId.length).toBeGreaterThan(0);
    // Step and mode navigation alone never change the prepared issue.
    await (await shown(page, 'builder-back')).click();
    await (await shown(page, 'builder-next')).click();
    await (await shown(page, 'mode-review')).click();
    await (await shown(page, 'mode-prepare')).click();
    await (await shown(page, 'step-details')).click();
    await expect(page.locator('[data-builder-step="details"]')).toBeVisible();
    expect(await readProjectId(page)).toBe(firstId);
    // Explicit new-ID action hands back a fresh usable ID.
    await (await shown(page, 'project-id-new')).click();
    const freshId = await readProjectId(page);
    expect(freshId.length).toBeGreaterThan(0);

    for (const format of ['self', 'hybrid'] as const) {
      await chooseFormat(page, format);
      await createCustomerFile(page, freshId);
      const first = await readDownload(page, `first-${format}`, () =>
        shown(page, 'download-package').then((control) => control.click()),
      );
      // Repeated generation with unchanged input reuses the ID and the bytes.
      await createCustomerFile(page, freshId);
      expect(await readProjectId(page)).toBe(freshId);
      const second = await readDownload(page, `second-${format}`, () =>
        shown(page, 'download-package').then((control) => control.click()),
      );
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
      await gotoDetails(page);
      const edit = await shown(page, 'customer-name');
      await edit.fill(`${CUSTOMER} changed`);
      await expect(builder(page, 'download-html')).toBeDisabled();
      await expect(builder(page, 'download-baseline')).toBeDisabled();
      await edit.fill(CUSTOMER);
    }
    // Manual override is kept across navigation and used for the next issue.
    await fillIdentity(page, CUSTOMER, 'CON', ISSUED_BY, ISSUED_PROJECT_ID);
    await (await shown(page, 'builder-back')).click();
    await (await shown(page, 'builder-next')).click();
    expect(await readProjectId(page)).toBe(ISSUED_PROJECT_ID);
    await createCustomerFile(page, ISSUED_PROJECT_ID);
    // Empty and overlong IDs are rejected with no baseline retained.
    for (const badId of ['', '   ', 'x'.repeat(257)]) {
      await gotoDetails(page);
      await (await shown(page, 'project-id')).fill(badId);
      await (await shown(page, 'generate')).click();
      await expect(await shown(page, 'generate-status')).toContainText('Issue rejected');
      await expect(builder(page, 'download-baseline')).toBeDisabled();
    }
    await gotoDetails(page);
    await (await shown(page, 'project-id')).fill(ISSUED_PROJECT_ID);
    await createCustomerFile(page, ISSUED_PROJECT_ID);
    await (await shown(page, 'step-choose')).click();
    const logoList = await shown(page, 'logo-list');
    await logoList.locator('input').first().uncheck();
    await expect(builder(page, 'download-package')).toBeDisabled();
    await createCustomerFile(page, ISSUED_PROJECT_ID);
    await chooseFormat(page, 'self');
    await expect(builder(page, 'download-package')).toBeDisabled();
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
    await expect(await shown(page, 'source-status')).toContainText('rejected before reading');
    expect(await page.evaluate(() => (window as Window & { oversizedRead?: boolean }).oversizedRead)).toBeUndefined();
    await (await shown(page, 'source-file')).setInputFiles({ name: 'unreadable.logo-project', mimeType: 'application/zip', buffer: Buffer.from('bad') });
    await expect(await shown(page, 'source-status')).toContainText('synthetic read failure');
    await (await shown(page, 'source-file')).setInputFiles({ name: 'held.logo-project', mimeType: 'application/zip', buffer: Buffer.from(await readFile(TRUSTED_SOURCE_PATH)) });
    await expect(builder(page, 'source-choose')).toBeDisabled();
    await dropSourceFile(page, new Uint8Array(await readFile(ALT_SOURCE_PATH)), ALT_SOURCE_NAME);
    await page.evaluate(() => (window as Window & { releaseRead?: () => void }).releaseRead!());
    await expect.poll(() => page.evaluate(() => (window as Window & { oldReadDone?: boolean }).oldReadDone)).toBe(true);
    await expect(await shown(page, 'source-status')).toContainText(`Loaded ${ALT_SOURCE_NAME}`);
    await expect(builder(page, 'source-choose')).toBeEnabled();
    // The zero-placement source carries one product/option/setup and no
    // logos; select it deliberately before issuing.
    await setListSelection(page, 'product-list', ['SYN-CAP-001']);
    await setListSelection(page, 'logo-list', []);
    await setListSelection(page, 'configuration-list', ['SYN-CFG-CAP-OS']);
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, CUSTOMER, 'ZERO-SOURCE', ISSUED_BY);
    const zeroId = await readProjectId(page);
    await createCustomerFile(page, zeroId);
    const baseline = await readDownload(page, 'zero.logo-project', () =>
      shown(page, 'download-baseline').then((control) => control.click()),
    );
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
    await setListSelection(page, 'product-list', FULL_PRODUCTS);
    await setListSelection(page, 'logo-list', FULL_LOGOS);
    await setListSelection(page, 'configuration-list', FULL_CONFIGURATIONS);
    await (await shown(page, 'builder-next')).click();
    await fillIdentity(page, CUSTOMER, 'HASH-RACE', ISSUED_BY);
    const racedId = await readProjectId(page);
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
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'customer-name')).toBeDisabled();
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-builder-hook="customer-name"]')!;
      input.value = 'Changed while hashing'; input.dispatchEvent(new Event('input'));
      (window as Window & { releaseHash?: () => void }).releaseHash!();
    });
    await expect.poll(() => page.evaluate(() => (window as Window & { hashDone?: boolean }).hashDone)).toBe(true);
    await expect(builder(page, 'download-baseline')).toBeDisabled();
    await page.evaluate(() => { (window as Window & { rejectNext?: boolean }).rejectNext = true; });
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('synthetic hash failure');
    await expect(await shown(page, 'customer-name')).toBeEnabled();
    await createCustomerFile(page, racedId);
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

for (const viewport of [{width:1536,height:1024},{width:390,height:844}]) {
  test(`staff journey needs no technical settings (${viewport.width}px)`, async ({browser}) => {
    const {context,page,probe} = await openBuilder(browser,viewport);
    try {
      await expect(builder(page,'step-send')).toBeDisabled();
      await builder(page,'start-open-toggle').click();
      const chooser = page.waitForEvent('filechooser');
      await builder(page,'source-choose').click(); await (await chooser).setFiles(TRUSTED_SOURCE_PATH);
      await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
      // Empty start: select the catalogue deliberately before refining it.
      await setListSelection(page, 'product-list', ['SYN-TEE-001', 'SYN-TR-001']);
      await setListSelection(page, 'logo-list', ['SYN-LOGO-A', 'SYN-LOGO-B']);
      await setListSelection(page, 'configuration-list', ['SYN-CFG-TEE-M', 'SYN-CFG-TR-REG']);
      // Choosing setups opens its disclosure; collapse it again so the
      // default journey keeps technical IDs out of the visible step text.
      await page.locator('details', { has: page.locator('[data-builder-hook="configuration-list"]') }).locator('summary').click();
      const product = builder(page,'product-list').locator('input[value="SYN-TR-001"]:not([data-product])');
      await product.uncheck(); await expect(builder(page,'selection-summary')).toContainText('1 product');
      await expect(builder(page,'selection-summary')).toContainText('2 options');
      await product.check(); await expect(builder(page,'selection-summary')).toContainText('4 options');
      expect(await page.locator('[data-builder-step="choose"]').innerText()).not.toContain('SYN-TEE-001');
      await builder(page,'builder-next').filter({visible:true}).click();
      await expect(page.locator('input[type="text"]:visible')).toHaveCount(3);
      await expect(builder(page,'project-id')).toBeHidden();
      await builder(page,'generate').click();
      await expect(builder(page,'builder-alert')).toBeVisible();
      await expect(builder(page,'builder-alert')).toContainText('customer name');
      await expect(builder(page,'customer-name')).toBeFocused();
      await builder(page,'customer-name').fill('Example staff workflow');
      await builder(page,'job-ref').fill('SYN-GUIDED');
      await builder(page,'issued-by').fill('Example staff');
      const id=await builder(page,'project-id').inputValue();
      await builder(page,'generate').click();
      await expect(page.locator('[data-builder-step="send"]')).toBeVisible();
      await expect(builder(page,'builder-alert')).toBeHidden();
      const baseline=await readDownload(page,'office.logo-project',()=>builder(page,'download-baseline').click());
      const html=await readDownload(page,'customer.html',()=>builder(page,'download-package').click());
      expect(Buffer.from(extractEmbeddedProjectPackage(html.bytes)!)).toEqual(Buffer.from(baseline.bytes));
      const parsed=await parseProjectPackage(new Uint8Array(baseline.bytes),{sha256});
      expect(parsed.project.projectId).toBe(id);
      await builder(page,'mode-review').click(); await expect(builder(page,'office-summary')).toContainText('SYN-GUIDED-issued-baseline');
      await builder(page,'mode-prepare').click(); await expect(builder(page,'download-package')).toBeEnabled();
      await builder(page,'source-file').setInputFiles({name:'bad-replacement.logo-project',mimeType:'application/zip',buffer:Buffer.from('invalid')});
      await expect(builder(page,'builder-alert')).toContainText('bad-replacement');
      await expect(builder(page,'builder-alert')).toBeVisible();
      const retained=await readDownload(page,'retained.logo-project',()=>builder(page,'download-baseline').click());
      expect(Buffer.from(retained.bytes)).toEqual(Buffer.from(baseline.bytes));
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expectOfflineClean(probe);
    } finally {await context.close();}
  });
}
