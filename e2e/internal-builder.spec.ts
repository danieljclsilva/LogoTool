import { gotoBuilder, revealBuilderControl, revealCustomerControl } from './helpers.js';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { extractEmbeddedProjectPackage } from '../src/packaging/self-contained-html/index.js';
import { confirmRevision, contentDigest, newRevision } from '../src/core/index.js';
import type { ProjectDocument, Sha256HexFn } from '../src/core/index.js';

// Internal-builder acceptance, migrated to the operator job shell. Opens the
// already-built dist/station/Logo Station.html offline through file:// (the
// spec never rebuilds; `npm run build` runs first). Every test asserts zero
// console/page errors and zero HTTP(S) requests.
//
// Shell contract (mirrors e2e/operator-workflow.spec.ts):
// - Landing ([data-job-landing], job-landing-create/open/response) → shell
//   (job-step-1 "1 Prepare job", job-step-2 "2 Set logo placements",
//   job-step-3 "3 Review document").
// - Step 1: customer-name/job-ref/issued-by + Products (product-list,
//   add-product-disclosure, configuration-list) + Logos + setup workspace +
//   job-to-placements + job-prepare-gate. No mode-prepare/mode-review,
//   step-open/choose/details/send, builder-next/back, new-source,
//   start-create/source-choose legacy hooks.
// - Approval branch: "Send for customer approval" → job-issue-project-new
//   (fresh ID), "Create customer file", "Save office copy"/"Save customer
//   file" downloads, office/response file inputs by aria-label, "Use customer
//   changes"/"Keep current job", rejection text "Could not import".
// - Header: job-save/job-open/job-new/job-response + job-open-file (hidden
//   input; setInputFiles works).
// - Legacy send/office/return/check sections stay hidden.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

const CUSTOMER = 'Acme Athletics';
const ISSUED_BY = 'Internal operator';

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

function pw(page: Page, name: string) {
  return page.locator(`[data-placement-hook="${name}"]`);
}

/** Reveal a job-shell control through real step/disclosure navigation. */
async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openStation(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<{
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
      entryPoint: 'file://dist/station/Logo Station.html',
      prototype: 'operator job shell',
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
  await expect(page.locator('[data-job-landing]')).toBeVisible();
  await page.locator('[data-builder-hook="job-landing-create"]').click();
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
  return { context, page, probe };
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
 * named anchor, atomic save. Returns nothing; the anchor name is asserted
 * by callers through status text. */
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
  await expect(await shown(page, 'workspace-status')).toContainText(/Measured the .* view: 280×200/);
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

/** Add one Images product with a named view, then set it up. The product
 * card checkbox arrives checked for a fresh product; callers untick to
 * exclude. */
async function addSetupProduct(page: Page, productName: string, viewLabel: string, fill: string, anchorName: string): Promise<void> {
  const png = await syntheticPngBytes(page, fill);
  await stageIntakeImage(page, viewLabel, `${productName.replace(/\s+/g, '-').toLowerCase()}.png`, png);
  await (await shown(page, 'product-name')).fill(productName);
  await (await shown(page, 'product-add')).click();
  await expect(await shown(page, 'product-status')).toContainText('Added');
  await setupProductWithAnchor(page, anchorName);
}

async function addLogo(page: Page, fileName: string, fill: string): Promise<void> {
  const png = await syntheticPngBytes(page, fill, 200, 120);
  await (await shown(page, 'logo-file')).setInputFiles({ name: fileName, mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(await shown(page, 'logo-status')).toContainText(`Added ${fileName}`);
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

/** Step navigation that never clicks the already-current (disabled) tab. */
async function gotoJobStep(page: Page, step: 1 | 2 | 3): Promise<void> {
  const names = { 1: 'prepare', 2: 'placements', 3: 'review' } as const;
  if (await page.locator(`[data-job-step="${names[step]}"]`).isVisible()) return;
  await page.locator(`[data-builder-hook="job-step-${step}"]`).click();
  await expect(page.locator(`[data-job-step="${names[step]}"]`)).toBeVisible();
}
/** Enter the approval branch from placements and mint a fresh issue ID. */
async function openApprovalBranch(page: Page): Promise<void> {
  await gotoJobStep(page, 2);
  await builder(page, 'job-placement-host').getByRole('button', { name: 'Send for customer approval' }).click();
  await expect(page.locator('[data-builder-hook="job-approval-host"]')).toBeVisible();
}

async function createCustomerFile(page: Page): Promise<void> {
  const create = page.getByRole('button', { name: 'Create customer file', exact: true });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator('[data-customer-approval]')).toContainText('Customer file created');
}

async function chooseApprovalFormat(page: Page, format: 'self' | 'hybrid'): Promise<void> {
  const approval = page.locator('[data-customer-approval]');
  const target = format === 'hybrid' ? approval.getByLabel(/ZIP file/) : approval.getByLabel(/One file/);
  if (!await target.isVisible()) {
    await approval.locator('summary', { hasText: 'More options' }).click();
  }
  await target.check();
}

test('guided preparation flows from open to deliberate selection to details', async ({ browser }) => {
  const { context, page, probe } = await openStation(browser);
  try {
    // Landing offers exactly the shell entry points; no workspace leaks.
    await expect(page.locator('[data-job-landing]')).toBeHidden();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(page.locator('[data-job-step="placements"]')).toBeHidden();
    await expect(page.locator('[data-job-step="review"]')).toBeHidden();
    // Step tabs carry the exact shell labels.
    await expect(builder(page, 'job-step-1')).toContainText('Prepare job');
    await expect(builder(page, 'job-step-2')).toContainText('Set logo placements');
    await expect(builder(page, 'job-step-3')).toContainText('Review document');
    // Identity lives in Step 1; the technical issue ID is branch-only.
    await expect(await shown(page, 'customer-name')).toBeVisible();
    await expect(await shown(page, 'job-ref')).toBeVisible();
    await expect(await shown(page, 'issued-by')).toBeVisible();
    await expect(builder(page, 'job-issue-project-id')).toBeHidden();
    // Legacy wizard sections stay hidden on the operator path.
    for (const gone of ['mode-prepare', 'mode-review', 'step-open', 'step-choose', 'step-details', 'step-send', 'builder-next', 'builder-back', 'new-source', 'start-create', 'source-choose']) {
      await expect(builder(page, gone)).toBeHidden();
    }
    // Header actions + visually hidden job file input.
    await expect(builder(page, 'job-save')).toContainText('Save job');
    await expect(builder(page, 'job-open')).toContainText('Open job');
    await expect(builder(page, 'job-new')).toContainText('New job');
    await expect(builder(page, 'job-response')).toContainText('Open customer response');
    // job-open-file is visually hidden (1px clipped input; setInputFiles works).
    const openBox = await builder(page, 'job-open-file').boundingBox();
    expect(openBox === null || openBox.width <= 1).toBe(true);
    // Empty job gates placements with a scoped message, not a banner.
    await expect(await shown(page, 'job-prepare-gate')).toContainText('Include at least one product');
    await expect(await shown(page, 'job-to-placements')).toBeDisabled();

    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BUILDER-PREVIEW');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await expect(builder(page, 'job-persistence')).toHaveText('Changes are held in this browser. Save job to keep them.');

    // Deliberate selection: nothing is pre-selected; ticking products and
    // logos by hand enables the placements step.
    await addSetupProduct(page, 'Synthetic Tee', 'Front', '#1d6f3a', 'Chest center');
    await addSetupProduct(page, 'Synthetic Shell', 'Side', '#27408b', 'Hem mark');
    await addLogo(page, 'marka.png', '#d4af37');
    await addLogo(page, 'markb.png', '#b03030');
    const shellCard = page.locator('[data-product-card]', { hasText: 'Synthetic Shell' }).first();
    await shellCard.locator('input[type="checkbox"]').first().uncheck();
    await expect(await shown(page, 'job-prepare-gate')).toHaveText('');
    await expect(await shown(page, 'job-to-placements')).toBeEnabled();
    await (await shown(page, 'job-to-placements')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    // Back preserves the deliberate selection.
    await gotoJobStep(page, 1);
    const teeCard = page.locator('[data-product-card]', { hasText: 'Synthetic Tee' }).first();
    await expect(teeCard.locator('input[type="checkbox"]').first()).toBeChecked();
    await expect(shellCard.locator('input[type="checkbox"]').first()).not.toBeChecked();

    await page.screenshot({ path: test.info().outputPath('builder-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await gotoJobStep(page, 2);
    await gotoJobStep(page, 1);
    await page.screenshot({ path: test.info().outputPath('builder-mobile.png'), fullPage: true });
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('issues a subset hybrid package at revision 1 with approvals cleared', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BLD-TEST-01');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await addSetupProduct(page, 'Synthetic Tee', 'Front', '#1d6f3a', 'Chest center');
    await addSetupProduct(page, 'Synthetic Trouser', 'Side', '#27408b', 'Hem mark');
    await addLogo(page, 'marka.png', '#d4af37');
    await addLogo(page, 'markb.png', '#b03030');
    // Subset: exclude the second product; it stays in the catalogue.
    await page.locator('[data-product-card]', { hasText: 'Synthetic Trouser' }).first().locator('input[type="checkbox"]').first().uncheck();
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'marka' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('marka');

    await openApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    const issuedProjectId = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
    expect(issuedProjectId.length).toBeGreaterThan(0);
    await chooseApprovalFormat(page, 'hybrid');
    await createCustomerFile(page);

    const downloaded = await readDownload(page, 'BLD-TEST-01.zip', () =>
      page.getByRole('button', { name: 'Save customer file', exact: true }).click(),
    );
    expect(downloaded.name).toMatch(/\.zip$/);
    const entries = unzipSync(downloaded.bytes);
    const names = Object.keys(entries);
    expect(names).toContain('OPEN_LOGO_CONFIGURATOR.html');
    const projectEntry = names.find((name) => name.endsWith('.logo-project'));
    assert.ok(projectEntry, `hybrid ZIP should contain a .logo-project entry, saw: ${names.join(', ')}`);
    const issued = await parseProjectPackage(entries[projectEntry]!, { sha256 });
    expect(issued.project.projectId).toBe(issuedProjectId);
    expect(issued.project.revision).toBe(1);
    expect(issued.project.products.map((product) => product.name)).toContain('Synthetic Tee');
    expect(issued.project.products.map((product) => product.name)).not.toContain('Synthetic Trouser');
    expect(issued.project.logos.map((logo) => logo.name)).toContain('marka');
    expect(issued.project.configurations.flatMap((configuration) => configuration.placements)).toHaveLength(1);
    expectApprovalsCleared(issued.project as unknown as Record<string, unknown>);
    expect(issued.assets.length).toBeGreaterThan(0);

    const office = await readDownload(page, 'office-copy.logo-project', () =>
      page.getByRole('button', { name: 'Save office copy', exact: true }).click(),
    );
    expect(office.name).toMatch(/\.logo-project$/);
    expect(Buffer.from(office.bytes)).toEqual(Buffer.from(entries[projectEntry]!));

    // The customer ZIP entry opens standalone in the customer editor.
    const directory = await mkdtemp(join(tmpdir(), 'logotool-generated-hybrid-'));
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
      const saved = await readDownload(editor, 'hybrid-edited.logo-project', () => editor.locator('[data-customer-hook="save"]').click());
      expect((await parseProjectPackage(saved.bytes, { sha256 })).project.instructions).toBe('Hybrid customer change');
      await editor.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('issues self-contained HTML that opens standalone and auto-loads the project', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  let directory = '';
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BLD-SELF-01');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await addSetupProduct(page, 'Synthetic Tee', 'Front', '#1d6f3a', 'Chest center');
    await addSetupProduct(page, 'Synthetic Trouser', 'Side', '#27408b', 'Hem mark');
    await addLogo(page, 'marka.png', '#d4af37');
    await addLogo(page, 'markb.png', '#b03030');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'marka' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('marka');

    await openApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    const issuedProjectId = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
    expect(issuedProjectId.length).toBeGreaterThan(0);
    // Self-contained HTML is the default format (no More options needed).
    await createCustomerFile(page);
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      page.getByRole('button', { name: 'Save customer file', exact: true }).click(),
    );
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    const embedded = extractEmbeddedProjectPackage(html.bytes);
    assert.ok(embedded, 'generated self-contained HTML should embed the issued project package');
    const embeddedParsed = await parseProjectPackage(embedded, { sha256 });
    expect(embeddedParsed.project.projectId).toBe(issuedProjectId);
    expect(embeddedParsed.project.revision).toBe(1);
    expectApprovalsCleared(embeddedParsed.project as unknown as Record<string, unknown>);

    const office = await readDownload(page, 'office-copy.logo-project', () =>
      page.getByRole('button', { name: 'Save office copy', exact: true }).click(),
    );
    expect(Buffer.from(office.bytes)).toEqual(Buffer.from(embedded));

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
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BLD-ZERO-01');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    // Zero artwork is valid: add the product, add no logos, add no placements.
    await addSetupProduct(page, 'Synthetic Tee', 'Front', '#1d6f3a', 'Chest center');
    await expect(await shown(page, 'logo-status')).toHaveText('');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await expect(host).toContainText('No logo placements for this option.');
    await openApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    const issuedProjectId = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
    await chooseApprovalFormat(page, 'hybrid');
    await createCustomerFile(page);
    const downloaded = await readDownload(page, 'BLD-ZERO-01.zip', () =>
      page.getByRole('button', { name: 'Save customer file', exact: true }).click(),
    );
    const entries = unzipSync(downloaded.bytes);
    const projectEntry = Object.keys(entries).find((name) => name.endsWith('.logo-project'));
    assert.ok(projectEntry, 'hybrid ZIP should contain a .logo-project entry');
    const issued = await parseProjectPackage(entries[projectEntry]!, { sha256 });
    expect(issued.project.projectId).toBe(issuedProjectId);
    expect(issued.project.revision).toBe(1);
    expect(issued.project.logos).toHaveLength(0);
    expect(issued.assets.filter((asset) => asset.path.startsWith('logos/'))).toHaveLength(0);
    expect(issued.project.configurations.flatMap((configuration) => configuration.placements)).toHaveLength(0);
    expectApprovalsCleared(issued.project as unknown as Record<string, unknown>);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('checking a prepared product and variant includes its setups without opening specific setups', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BLD-AUTO-01');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    // Prepare one product through the real workspace; the collapsed
    // "Choose specific setups" disclosure is never opened here.
    await addSetupProduct(page, 'Prepared Cap', 'Front', '#12394b', 'Crown center');
    await addLogo(page, 'capmark.png', '#d4af37');
    await expect(await shown(page, 'job-prepare-gate')).toHaveText('');
    await (await shown(page, 'job-to-placements')).click();
    // The matching setup shipped automatically: a placement can target the
    // prepared option without any disclosure detour.
    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'capmark' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) {
      const first = await addMethod.locator('option').nth(1).getAttribute('value');
      if (first) await addMethod.selectOption(first);
    }
    await pw(page, 'pw-add-width').fill('60');
    await pw(page, 'pw-add-height').fill('30');
    await pw(page, 'pw-add-confirm').click();
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('capmark');

    await openApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    await createCustomerFile(page);
    const office = await readDownload(page, 'auto-issue.logo-project', () =>
      page.getByRole('button', { name: 'Save office copy', exact: true }).click(),
    );
    const issued = await parseProjectPackage(office.bytes, { sha256 });
    expect(issued.project.configurations).toHaveLength(1);
    expect(issued.project.configurations.flatMap((entry) => entry.placements)).toHaveLength(1);
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('fractional millimetres render rounded once in staff return comparisons', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BLD-FRAC-01');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await addSetupProduct(page, 'Fraction Tee', 'Front', '#1d6f3a', 'Chest center');
    await addLogo(page, 'fracmark.png', '#d4af37');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'fracmark' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
    await pw(page, 'pw-add-width').fill('100');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await openApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    await createCustomerFile(page);
    const office = await readDownload(page, 'frac-office.logo-project', () =>
      page.getByRole('button', { name: 'Save office copy', exact: true }).click(),
    );
    const officeDir = await mkdtemp(join(tmpdir(), 'logotool-frac-'));
    const officePath = join(officeDir, 'frac-office.logo-project');
    await writeFile(officePath, office.bytes);
    try {
      // Craft a fractional return from the exact issued baseline.
      const sha256Text: Sha256HexFn = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
      const issued = await parseProjectPackage(office.bytes, { sha256 });
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

      await page.getByLabel('Choose the saved office copy for this job').setInputFiles(officePath);
      await expect(page.locator('[data-customer-approval]')).toContainText('Office copy loaded: frac-office.logo-project');
      await page.getByLabel('Choose the returned customer file').setInputFiles({ name: 'fractional-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returnedBytes) });
      const approval = page.locator('[data-customer-approval]');
      await expect(approval).toContainText('108.1');
      await expect(approval).toContainText('-65.1, 31.0');
      await expect(approval).not.toContainText('108.11145510835912');
      await expect(approval).not.toContainText('30.987654');
    } finally { await rm(officeDir, { recursive: true, force: true }); }
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('rejects an invalid source without replacing the loaded selection', async ({ browser }) => {
  const { context, page, probe } = await openStation(browser);
  let directory = '';
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BLD-KEEP-01');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await addSetupProduct(page, 'Kept Tee', 'Front', '#1d6f3a', 'Chest center');
    await addLogo(page, 'keptmark.png', '#d4af37');
    const saved = await readDownload(page, 'kept-job.logo-project', () =>
      builder(page, 'job-save').click(),
    );
    expect(saved.name).toMatch(/\.logo-project$/);

    directory = await mkdtemp(join(tmpdir(), 'logotool-builder-bad-'));
    const badPath = join(directory, 'bad-source.logo-project');
    await writeFile(badPath, 'not a logo project');
    await builder(page, 'job-open-file').setInputFiles(badPath);
    // The failure stays actionable and the previous job is intact.
    await expect(builder(page, 'builder-alert')).toContainText('Could not open bad-source.logo-project');
    await expect(builder(page, 'builder-alert')).toContainText('previous job is still available');
    await expect(await shown(page, 'customer-name')).toHaveValue(CUSTOMER);
    await expect(await shown(page, 'job-ref')).toHaveValue('BLD-KEEP-01');
    await expect(await shown(page, 'product-list')).toContainText('Kept Tee');
    await expect(await shown(page, 'logo-list')).toContainText('keptmark');

    // The intact job still saves byte-identical bytes.
    const again = await readDownload(page, 'kept-job-again.logo-project', () =>
      builder(page, 'job-save').click(),
    );
    expect(Buffer.from(again.bytes)).toEqual(Buffer.from(saved.bytes));
    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('clears generated outputs and the baseline when a different source loads', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BLD-STALE-01');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await addSetupProduct(page, 'Stale Tee', 'Front', '#1d6f3a', 'Chest center');
    await addLogo(page, 'stalemark.png', '#d4af37');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'stalemark' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
    await pw(page, 'pw-add-width').fill('80');
    await pw(page, 'pw-add-height').fill('30');
    await pw(page, 'pw-add-confirm').click();
    await openApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    await createCustomerFile(page);
    await expect(page.locator('[data-customer-approval]')).toContainText('Customer file created');

    // A new job with unsaved changes prompts; discarding clears every
    // generated output and returns to an empty job.
    await builder(page, 'job-new').click();
    await expect(page.getByRole('button', { name: 'Discard changes' })).toBeVisible();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    await expect(await shown(page, 'customer-name')).toHaveValue('');
    await expect(await shown(page, 'job-prepare-gate')).toContainText('Include at least one product');
    // The approval branch holds no stale outputs from the discarded job.
    await expect(page.locator('[data-job-branch="approval"]')).not.toContainText('Customer file created');
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('saves two files, opens the customer file, and reviews the return against the office copy', async ({ browser }) => {
  test.setTimeout(300_000);
  const { context, page, probe } = await openStation(browser);
  let directory = '';
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BLD-BASE-01');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await addSetupProduct(page, 'Base Tee', 'Front', '#1d6f3a', 'Chest center');
    await addSetupProduct(page, 'Base Trouser', 'Side', '#27408b', 'Hem mark');
    await addLogo(page, 'basea.png', '#d4af37');
    await addLogo(page, 'baseb.png', '#b03030');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'basea' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'baseb' });
    if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
    await pw(page, 'pw-add-width').fill('70');
    await pw(page, 'pw-add-height').fill('35');
    await pw(page, 'pw-add-confirm').click();
    expect(await host.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);

    await openApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    const issuedProjectId = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
    await createCustomerFile(page);
    const baseline = await readDownload(page, 'base-office.logo-project', () =>
      page.getByRole('button', { name: 'Save office copy', exact: true }).click(),
    );
    const html = await readDownload(page, 'OPEN_LOGO_CONFIGURATOR.html', () =>
      page.getByRole('button', { name: 'Save customer file', exact: true }).click(),
    );
    expect(html.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
    const embedded = extractEmbeddedProjectPackage(html.bytes);
    assert.ok(embedded, 'generated self-contained HTML should embed the issued project package');
    expect(Buffer.from(baseline.bytes)).toEqual(Buffer.from(embedded));

    // Extract and open the real customer file, edit it, and return it.
    directory = await mkdtemp(join(tmpdir(), 'logotool-builder-return-'));
    const htmlPath = join(directory, 'issued-for-return.html');
    await writeFile(htmlPath, html.bytes);
    const baselinePath = join(directory, baseline.name);
    await writeFile(baselinePath, baseline.bytes);
    const editorPage = await context.newPage();
    attachPageProbe(editorPage, probe);
    await editorPage.goto(pathToFileURL(htmlPath).href);
    await expect(editorPage.locator('[data-customer-hook="project-id"]')).toHaveText(issuedProjectId);
    await revealCustomerControl(editorPage, 'instructions');
    await editorPage.locator('[data-customer-hook="instructions"]').fill('Builder return instructions.');
    await editorPage.locator('[data-customer-hook="instructions"]').press('Tab');
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

    // The unconfirmed return stays safe: pending, never approved. Check
    // it before consuming the confirmed return below.
    await page.getByLabel('Choose the saved office copy for this job').setInputFiles(baselinePath);
    await expect(page.locator('[data-customer-approval]')).toContainText(`Office copy loaded: ${baseline.name}`);
    await page.getByLabel('Choose the returned customer file').setInputFiles({
      name: 'builder-return-unconfirmed.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(unconfirmed.bytes),
    });
    const approval = page.locator('[data-customer-approval]');
    await expect(approval).toContainText('Second unconfirmed edit.');
    await expect(approval).toContainText(/none; draft only|missing or out of date|not confirmed|pending/i);
    await expect(page.getByRole('button', { name: 'Use customer changes', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Keep current job', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Keep current job', exact: true }).click();

    // Review the confirmed return against the saved office copy (the branch
    // is still open with the office copy loaded; just swap the response).
    await page.getByLabel('Choose the returned customer file').setInputFiles({
      name: 'builder-return.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(returned.bytes),
    });
    await expect(approval).toContainText('Builder return instructions.');
    await expect(page.getByRole('button', { name: 'Use customer changes', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Use customer changes', exact: true }).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    expect(await builder(page, 'job-placement-host').locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);

    // A mismatched baseline is rejected atomically; the job is unchanged.
    await builder(page, 'job-placement-host').getByRole('button', { name: 'Send for customer approval' }).click();
    const otherJob = await readDownload(page, 'other-job.logo-project', () =>
      builder(page, 'job-save').click(),
    );
    const otherPath = join(directory, 'other-job.logo-project');
    await writeFile(otherPath, otherJob.bytes);
    // Reloading a different office copy than the response baseline fails
    // closed without touching the live job.
    await page.getByLabel('Choose the saved office copy for this job').setInputFiles(otherPath);
    await expect(page.locator('[data-customer-approval]')).toContainText('Office copy loaded: other-job.logo-project');
    await page.getByLabel('Choose the returned customer file').setInputFiles({
      name: 'builder-return.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(returned.bytes),
    });
    await expect(approval).toContainText('Could not import');
    expect(await builder(page, 'job-placement-host').locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('keeps the automatic project ID stable and regenerates deterministic delivery bytes', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('CON');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await addSetupProduct(page, 'Determin Tee', 'Front', '#1d6f3a', 'Chest center');
    await addLogo(page, 'determmark.png', '#d4af37');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'determmark' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await openApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    const firstId = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
    expect(firstId.length).toBeGreaterThan(0);
    // Step navigation alone never changes the prepared issue ID.
    await gotoJobStep(page, 3);
    await gotoJobStep(page, 2);
    await builder(page, 'job-placement-host').getByRole('button', { name: 'Send for customer approval' }).click();
    expect(await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue()).toBe(firstId);
    // Explicit new-ID action hands back a fresh usable ID.
    await (await shown(page, 'job-issue-project-new')).click();
    const freshId = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
    expect(freshId.length).toBeGreaterThan(0);
    expect(freshId).not.toBe(firstId);

    for (const format of ['self', 'hybrid'] as const) {
      await chooseApprovalFormat(page, format);
      await createCustomerFile(page);
      const first = await readDownload(page, `first-${format}`, () =>
        page.getByRole('button', { name: 'Save customer file', exact: true }).click(),
      );
      // Repeated generation with unchanged input reuses the ID and bytes.
      await createCustomerFile(page);
      expect(await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue()).toBe(freshId);
      const second = await readDownload(page, `second-${format}`, () =>
        page.getByRole('button', { name: 'Save customer file', exact: true }).click(),
      );
      if (format === 'self') {
        expect(second.name).toBe('OPEN_LOGO_CONFIGURATOR.html');
        const embedded = extractEmbeddedProjectPackage(second.bytes);
        assert.ok(embedded, 'single-file primary download should embed the issued project package');
      }
      if (format === 'hybrid') {
        expect(second.name).toMatch(/\.zip$/);
        expect(Object.keys(unzipSync(second.bytes)).sort()).toEqual([`${second.name.replace(/-customer-file\.zip$/, '')}.logo-project`, 'OPEN_LOGO_CONFIGURATOR.html'].sort());
      }
      expect(Buffer.from(second.bytes)).toEqual(Buffer.from(first.bytes));
    }

    // Save-job determinism: two saves with no edits are byte-identical.
    const saveFirst = await readDownload(page, 'save-first.logo-project', () => builder(page, 'job-save').click());
    const saveSecond = await readDownload(page, 'save-second.logo-project', () => builder(page, 'job-save').click());
    expect(Buffer.from(saveSecond.bytes)).toEqual(Buffer.from(saveFirst.bytes));

    // Content edits invalidate prior files and require regeneration.
    await gotoJobStep(page, 1);
    await (await shown(page, 'customer-name')).fill(`${CUSTOMER} changed`);
    await openApprovalBranch(page);
    await expect(page.locator('[data-customer-approval]')).toContainText(/changed|stale/i);
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

test('source reads reject oversized and unreadable files and discard obsolete reads', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('BLD-LIMIT-01');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await addSetupProduct(page, 'Limit Tee', 'Front', '#1d6f3a', 'Chest center');
    await addLogo(page, 'limitmark.png', '#d4af37');
    const saved = await readDownload(page, 'limit-job.logo-project', () => builder(page, 'job-save').click());

    await page.evaluate(() => {
      const native = File.prototype.arrayBuffer;
      const state = window as Window & { releaseRead?: () => void; oldReadDone?: boolean; oversizedRead?: boolean };
      File.prototype.arrayBuffer = function (this: File) {
        if (this.name === 'oversized.logo-project') { state.oversizedRead = true; return Promise.reject(new Error('must not read')); }
        if (this.name === 'unreadable.logo-project') return Promise.reject(new Error('synthetic read failure'));
        if (this.name === 'held.logo-project') return new Promise<ArrayBuffer>((resolve, reject) => { state.releaseRead = () => { void (native.call(this) as unknown as Promise<ArrayBuffer>).then((bytes) => { state.oldReadDone = true; resolve(bytes); }, reject); }; });
        return native.call(this);
      };
      const file = new File(['x'], 'oversized.logo-project');
      Object.defineProperty(file, 'size', { value: 48 * 1024 * 1024 + 1 });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.querySelector<HTMLInputElement>('[data-builder-hook="job-open-file"]')!;
      input.files = dt.files; input.dispatchEvent(new Event('change'));
    });
    await expect(builder(page, 'builder-alert')).toContainText('Could not open oversized.logo-project');
    await expect(await shown(page, 'source-status')).toContainText('rejected before reading');
    expect(await page.evaluate(() => (window as Window & { oversizedRead?: boolean }).oversizedRead)).toBeUndefined();
    // The live job survives the rejected open.
    await expect(await shown(page, 'customer-name')).toHaveValue(CUSTOMER);
    await expect(await shown(page, 'product-list')).toContainText('Limit Tee');

    await builder(page, 'job-open-file').setInputFiles({ name: 'unreadable.logo-project', mimeType: 'application/zip', buffer: Buffer.from('bad') });
    await expect(builder(page, 'builder-alert')).toContainText('Could not open unreadable.logo-project');
    await expect(await shown(page, 'customer-name')).toHaveValue(CUSTOMER);

    // A deliberately held read cannot overwrite a newer successful open:
    // the stale completion is discarded and the newer job wins. Both opens
    // start from a clean job so no replace prompt intervenes.
    await (await shown(page, 'job-ref')).fill('BLD-LIMIT-02');
    const newer = await readDownload(page, 'limit-job-newer.logo-project', () => builder(page, 'job-save').click());
    await builder(page, 'job-open-file').setInputFiles({ name: 'held.logo-project', mimeType: 'application/zip', buffer: Buffer.from(saved.bytes) });
    const otherDir = await mkdtemp(join(tmpdir(), 'logotool-stale-'));
    try {
      const otherPath = join(otherDir, 'other.logo-project');
      await writeFile(otherPath, newer.bytes);
      await builder(page, 'job-open-file').setInputFiles(otherPath);
      await expect(await shown(page, 'job-ref')).toHaveValue('BLD-LIMIT-02');
      await page.evaluate(() => (window as Window & { releaseRead?: () => void }).releaseRead!());
      await expect.poll(() => page.evaluate(() => (window as Window & { oldReadDone?: boolean }).oldReadDone)).toBe(true);
      await expect(await shown(page, 'job-ref')).toHaveValue('BLD-LIMIT-02');
      await expect(await shown(page, 'product-list')).toContainText('Limit Tee');
    } finally { await rm(otherDir, { recursive: true, force: true }); }
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

test('generation locks inputs, rejects obsolete hashing and recovers from hash failures', async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill(CUSTOMER);
    await (await shown(page, 'job-ref')).fill('HASH-RACE');
    await (await shown(page, 'issued-by')).fill(ISSUED_BY);
    await addSetupProduct(page, 'Hash Tee', 'Front', '#1d6f3a', 'Chest center');
    await addLogo(page, 'hashmark.png', '#d4af37');
    await (await shown(page, 'job-to-placements')).click();
    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-logo').selectOption({ label: 'hashmark' });
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    await pw(page, 'pw-add-confirm').click();
    await openApprovalBranch(page);
    await (await shown(page, 'job-issue-project-new')).click();
    const racedId = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
    await page.evaluate(() => {
      const native = crypto.subtle.digest.bind(crypto.subtle);
      const state = window as Window & { releaseHash?: () => void; hashDone?: boolean; rejectNext?: boolean };
      let held = false;
      crypto.subtle.digest = ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
        if (state.rejectNext) { state.rejectNext = false; return Promise.reject(new Error('synthetic hash failure')); }
        if (!held) { held = true; return new Promise<ArrayBuffer>((resolve, reject) => { state.releaseHash = () => { void native(algorithm, data).then((bytes) => { state.hashDone = true; resolve(bytes); }, reject); }; }); }
        return native(algorithm, data);
      }) as typeof crypto.subtle.digest;
    });
    await page.getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(page.locator('[data-customer-approval]')).toContainText('Creating customer file');
    await expect(page.getByRole('button', { name: 'Create customer file', exact: true })).toBeDisabled();
    await page.evaluate(() => {
      (window as Window & { releaseHash?: () => void }).releaseHash!();
    });
    await expect.poll(() => page.evaluate(() => (window as Window & { hashDone?: boolean }).hashDone)).toBe(true);
    await expect(page.locator('[data-customer-approval]')).toContainText('Customer file created');
    expect(await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue()).toBe(racedId);
    await page.evaluate(() => { (window as Window & { rejectNext?: boolean }).rejectNext = true; });
    await page.getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(page.locator('[data-customer-approval]')).toContainText('synthetic hash failure');
    await createCustomerFile(page);
    expectOfflineClean(probe);
  } finally { await context.close(); }
});

for (const viewport of [{ width: 1536, height: 1024 }, { width: 390, height: 844 }]) {
  test(`staff journey needs no technical settings (${viewport.width}px)`, async ({ browser }) => {
    const { context, page, probe } = await openStation(browser, viewport);
    try {
      // No technical ID or format choice on the default Prepare journey.
      await expect(builder(page, 'job-issue-project-id')).toBeHidden();
      await expect(builder(page, 'job-to-placements')).toBeDisabled();
      await (await shown(page, 'customer-name')).fill('Example staff workflow');
      await (await shown(page, 'job-ref')).fill('SYN-GUIDED');
      await (await shown(page, 'issued-by')).fill('Example staff');
      await addSetupProduct(page, 'Guided Tee', 'Front', '#1d6f3a', 'Chest center');
      await addLogo(page, 'guidedmark.png', '#d4af37');
      await expect(await shown(page, 'job-to-placements')).toBeEnabled();
      await (await shown(page, 'job-to-placements')).click();
      await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
      const host = builder(page, 'job-placement-host');
      await host.getByRole('button', { name: 'Add logo placement' }).click();
      await pw(page, 'pw-add-logo').selectOption({ label: 'guidedmark' });
      const addMethod = pw(page, 'pw-add-method');
      if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
      await pw(page, 'pw-add-width').fill('90');
      await pw(page, 'pw-add-height').fill('40');
      await pw(page, 'pw-add-confirm').click();
      await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('guidedmark');

      // Missing identity blocks the branch with a focused field, not a dump.
      await gotoJobStep(page, 1);
      await (await shown(page, 'customer-name')).fill('');
      await openApprovalBranch(page);
      await page.getByRole('button', { name: 'Create customer file', exact: true }).click();
      await expect(page.locator('[data-customer-approval]')).toContainText(/Customer file not created|Customer name/i);
      await expect(await shown(page, 'customer-name')).toBeFocused();
      await (await shown(page, 'customer-name')).fill('Example staff workflow');

      await openApprovalBranch(page);
      await (await shown(page, 'job-issue-project-new')).click();
      const id = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
      await createCustomerFile(page);
      const office = await readDownload(page, 'office.logo-project', () =>
        page.getByRole('button', { name: 'Save office copy', exact: true }).click(),
      );
      const html = await readDownload(page, 'customer.html', () =>
        page.getByRole('button', { name: 'Save customer file', exact: true }).click(),
      );
      expect(Buffer.from(extractEmbeddedProjectPackage(html.bytes)!)).toEqual(Buffer.from(office.bytes));
      const parsed = await parseProjectPackage(new Uint8Array(office.bytes), { sha256 });
      expect(parsed.project.projectId).toBe(id);

      // An invalid job file never replaces the live job or its outputs.
      await gotoJobStep(page, 1);
      const beforeBad = await readDownload(page, 'before-bad.logo-project', () => builder(page, 'job-save').click());
      await builder(page, 'job-open-file').setInputFiles({ name: 'bad-replacement.logo-project', mimeType: 'application/zip', buffer: Buffer.from('invalid') });
      await expect(builder(page, 'builder-alert')).toContainText('bad-replacement');
      const retained = await readDownload(page, 'retained.logo-project', () => builder(page, 'job-save').click());
      expect(Buffer.from(retained.bytes)).toEqual(Buffer.from(beforeBad.bytes));
      expect((await parseProjectPackage(retained.bytes, { sha256 })).project.products.length).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expectOfflineClean(probe);
    } finally { await context.close(); }
  });
}
