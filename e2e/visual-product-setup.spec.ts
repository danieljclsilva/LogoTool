import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createProjectPackage } from '../src/packaging/project-package/index.js';
import { release } from 'node:os';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { pathToFileURL } from 'node:url';
import { BUILDER_URL, gotoBuilder, revealBuilderControl, revealCustomerControl, selectCustomerOption } from './helpers.js';
import { countPdfPages } from './sheet-fixtures.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';

// Visual product setup acceptance (lead-owned): the main staff path on a
// release-clean station. Clean empty draft → real product photo upload →
// honest unmeasured pending → guided first measured region (4 photo corners
// + real width/height + orientation through the existing affine solver) →
// draw safe area + click anchor on the photo → ONE atomic save → per-view
// isolation → prepared-master roundtrip → issue BOTH customer formats.
// No demo/mock content anywhere; synthetic fixtures only (in-page canvas
// PNGs, tracked example SVGs are never loaded here). Offline file://.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return ['builder-next', 'builder-back'].includes(name)
    ? builder(page, name).filter({ visible: true }).first()
    : builder(page, name);
}

async function openBuilder(browser: Browser): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  // Bounded actions: a missing locator must fail fast with the real step
  // visible, never hang to the overall test timeout (action default is 0).
  await context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(String(message.text()));
  });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  await gotoBuilder(page);
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
  return { context, page, probe };
}

/** Synthetic PNG bytes rendered in the page (exact original bytes). Defaults
 * to a realistic 400x300 product photo so viewBox-unit markers/handles stay
 * proportional; tiny rasters would make every handle cover the photo. */
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

async function shownFresh(freshPage: Page, name: string) {
  await revealBuilderControl(freshPage, name);
  return ['builder-next', 'builder-back'].includes(name)
    ? builder(freshPage, name).filter({ visible: true }).first()
    : builder(freshPage, name);
}

/** Fill a customer field the way a human tabs out (reveals + commits change). */
async function cfill(page: import('@playwright/test').Page, hook: string, value: string): Promise<void> {
  const target = page.locator(`[data-customer-hook="${hook}"]`);
  await revealCustomerControl(page, hook);
  await target.fill(value);
  await target.press('Tab');
}

async function checkAllBoxes(page: Page, listHook: string): Promise<void> {
  await (await shown(page, listHook)).locator('input[type="checkbox"]').evaluateAll((nodes) => {
    for (const node of nodes) {
      const box = node as HTMLInputElement;
      if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
}

test('visual setup: upload → guided measure → draw + anchors → save → master roundtrip → both formats', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openBuilder(browser);
  try {
    // Clean empty draft: no demo, workspace waits for a real product.
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();
    await expect(builder(page, 'demo-create')).toHaveCount(0);
    await expect(await shown(page, 'workspace-status')).toContainText('Add a real product first');

    // Real fresh upload: front + back photos staged, product added.
    const frontPng = await syntheticPngBytes(page, '#1d6f3a');
    const backPng = await syntheticPngBytes(page, '#6f1d3a');
    await (await shown(page, 'product-file')).setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: Buffer.from(frontPng) });
    await (await shown(page, 'product-view-back-file')).setInputFiles({ name: 'back.png', mimeType: 'image/png', buffer: Buffer.from(backPng) });
    await (await shown(page, 'product-name')).fill('Test Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Test Jacket');

    // Honest pending: front view has no scale mapping yet.
    const workspace = builder(page, 'product-workspace');
    await expect(workspace.locator('[role="tablist"]')).toBeVisible();
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    await expect(workspace.getByRole('tab', { name: 'Back' })).toBeVisible();
    await expect(workspace.getByText('has no scale mapping yet')).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Set up scale' })).toBeVisible();

    // Guided first measured region: click 4 corners, enter real mm, create.
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    await expect(guided).toBeVisible();
    const overlay = guided.locator('.guided-scale-overlay');
    await expect(overlay).toBeVisible();
    const box = (await overlay.boundingBox())!;
    const corner = async (fx: number, fy: number) => {
      await overlay.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
    };
    await corner(0.25, 0.25);
    await corner(0.75, 0.25);
    await corner(0.75, 0.75);
    await corner(0.25, 0.75);
    await guided.locator('[data-guided="width"]').fill('280');
    await guided.locator('[data-guided="height"]').fill('200');
    await guided.locator('[data-guided="create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Measured the Front view: 280×200');
    await expect(await shown(page, 'workspace-status')).toContainText('max residual');

    // Measured front: the guided rectangle ships as the default 4-corner
    // safe area, so the Anchor tool is active and drawing starts from edits.
    await expect(workspace.getByText('has no scale mapping yet')).toHaveCount(0);
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    const stage = workspace.locator('.product-setup-overlay').first();
    await expect(stage).toBeVisible();
    const tap = async (fx: number, fy: number) => {
      const live = (await stage.boundingBox())!;
      await stage.click({ position: { x: Math.round(live.width * fx), y: Math.round(live.height * fy) } });
    };
    // Pick lists collapse behind "All …" disclosures while an item is
    // selected (Tranche C contextual controls); expand before choosing.
    const openPickList = async (prefix: 'All anchors' | 'All corners'): Promise<void> => {
      const summary = workspace.locator('summary', { hasText: prefix });
      if ((await summary.count()) === 0) return;
      const open = await summary.first().evaluate((element) => (element.closest('details') as HTMLDetailsElement).open);
      if (!open) await summary.first().click();
    };

    // Safe-area tool: corner removal is validated (needs at least 3), then
    // Reset to saved restores the guided rectangle.
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await workspace.locator('.product-setup-panel').getByRole('button', { name: 'Corner 4', exact: true }).click();
    await workspace.getByRole('button', { name: 'Remove safe-area corner 4', exact: true }).click();
    await workspace.locator('.product-setup-panel').getByRole('button', { name: 'Corner 3', exact: true }).click();
    await workspace.getByRole('button', { name: 'Remove safe-area corner 3', exact: true }).click();
    await expect(workspace.getByText('Corner removal refused: a safe area needs at least 3 corners.')).toBeVisible();
    await workspace.getByRole('button', { name: 'Reset to saved' }).click();
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();

    // Keyboard geometry access: select corner 1, nudge +1mm in x.
    await workspace.locator('.product-setup-vertex').first().click();
    await workspace.locator('.product-setup-vertex.is-selected').press('ArrowRight');

    // Anchor tool (default after measure): click the product to place one,
    // rename it, refuse a duplicate name, remove the spare.
    await workspace.getByRole('button', { name: 'Anchor', exact: true }).click();
    await tap(0.5, 0.5);
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    await openPickList('All anchors');
    await workspace.getByRole('button', { name: 'Anchor 1', exact: true }).click();
    await workspace.locator('[data-fkey^="psv-anchor-name-"]').fill('Chest center');
    await workspace.locator('[data-fkey^="psv-anchor-name-"]').press('Tab');
    await expect(workspace.getByText('Renamed anchor to “Chest center”.')).toBeVisible();
    // Anchor serials continue from the anchor count: with 'Chest center'
    // taken, the spare is 'Anchor 2'.
    await tap(0.6, 0.6);
    await expect(workspace.getByText('Created “Anchor 2”')).toBeVisible();
    await openPickList('All anchors');
    await workspace.getByRole('button', { name: 'Anchor 2', exact: true }).click();
    await workspace.locator('[data-fkey^="psv-anchor-name-"]').fill('Chest center');
    await workspace.locator('[data-fkey^="psv-anchor-name-"]').press('Tab');
    await expect(workspace.getByText('Anchor not renamed: another anchor is already called “Chest center”.')).toBeVisible();
    await workspace.getByRole('button', { name: /Remove anchor/ }).click();
    await expect(workspace.getByText('Removed anchor “Anchor 2”.')).toBeVisible();

    // Draw a NEW safe area over the staged polygon. Cancellation before any
    // click keeps the previous polygon; an invalid finish is refused; a
    // valid finish replaces it (still unstaged until Save).
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    await expect(workspace.getByText('Drawing safe area (0 corners — nothing committed)')).toBeVisible();
    await stage.press('Escape');
    await expect(workspace.getByText('Drawing cancelled; nothing was committed.')).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Draw new safe area' })).toBeVisible();
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    await tap(0.3, 0.3);
    await tap(0.7, 0.3);
    await stage.press('Enter');
    await expect(workspace.getByText('Drawing not finished: add at least 1 more corner before finishing (Enter closes with 3 or more).')).toBeVisible();
    await stage.press('Escape');
    await expect(workspace.getByText('Drawing cancelled; nothing was committed.')).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    await workspace.getByRole('button', { name: 'Draw new safe area' }).click();
    await tap(0.3, 0.3);
    await tap(0.7, 0.3);
    await tap(0.7, 0.7);
    await tap(0.3, 0.7);
    await stage.press('Enter');
    await expect(workspace.getByText('Staged a drawn safe area with 4 corners. Save product setup to commit it.')).toBeVisible();

    // Read back the staged corners (exact millimetres depend on integer
    // click rounding through the guided fit, so later assertions compare
    // against these read values, not hand-computed fractions).
    await workspace.locator('.product-setup-advanced summary').click();
    const readCorners = async (): Promise<Array<[number, number]>> => {
      const text = await workspace.locator('.product-setup-advanced-list').first().textContent() ?? '';
      const found: Array<[number, number]> = [];
      for (const match of text.matchAll(/Corner \d+: (-?[\d.]+), (-?[\d.]+) mm/g)) {
        found.push([Number(match[1]), Number(match[2])]);
      }
      return found;
    };
    const stagedBefore = await readCorners();
    expect(stagedBefore).toHaveLength(4);

    // Pointer drag moves staged corner 0 by +2mm in x.
    await stage.scrollIntoViewIfNeeded();
    const dragHandle = workspace.locator('.product-setup-vertex').first();
    const dragBox = (await dragHandle.boundingBox())!;
    const stageBox2 = (await stage.boundingBox())!;
    // The guided rectangle spans half the photo width (UV 0.25→0.75), so
    // 280mm maps to half the stage: per-mm display scale uses half width.
    const dxPx = Math.round((2 * stageBox2.width * 0.5) / 280);
    await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + dragBox.width / 2 + dxPx, dragBox.y + dragBox.height / 2, { steps: 5 });
    await page.mouse.up();
    const stagedAfter = await readCorners();
    expect(stagedAfter).toHaveLength(4);
    expect(stagedAfter[0]![0] - stagedBefore[0]![0]).toBeGreaterThan(1.5);
    expect(stagedAfter[0]![0] - stagedBefore[0]![0]).toBeLessThan(2.5);
    expect(Math.abs(stagedAfter[0]![1] - stagedBefore[0]![1])).toBeLessThan(0.05);
    for (const index of [1, 2, 3]) {
      expect(Math.abs(stagedAfter[index]![0] - stagedBefore[index]![0])).toBeLessThan(0.05);
      expect(Math.abs(stagedAfter[index]![1] - stagedBefore[index]![1])).toBeLessThan(0.05);
    }

    // ONE atomic save persists the edited safe area + anchor together.
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 1 anchors\)/)).toBeVisible();
    await expect(await shown(page, 'workspace-status')).toContainText('4 safe-area corners, 1 anchors');
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('visual-setup-saved.png') });
    }

    // Per-view isolation: back is still honestly unmeasured; front keeps edits.
    await workspace.getByRole('tab', { name: 'Back' }).click();
    await expect(workspace.getByText('has no scale mapping yet')).toBeVisible();
    await workspace.getByRole('tab', { name: 'Front' }).click();
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    await expect(workspace.getByRole('button', { name: /Anchor \(1\)/ })).toBeVisible();

    // Prepared-master roundtrip: save, parse the ACTUAL master bytes
    // (region geometry + sidecar anchors), reopen, workspace restored.
    const masterEvent = page.waitForEvent('download');
    await (await shown(page, 'save-master')).click();
    await expect(await shown(page, 'master-status')).toContainText('Saved prepared master');
    const master = await masterEvent;
    const masterPath = info.outputPath('visual-setup-master.logo-project');
    await master.saveAs(masterPath);
    // Save the staged corners for the roundtrip assertions below.
    const expectedCorners = stagedAfter;
    const masterParsed = await parseProjectPackage(new Uint8Array(await readFile(masterPath)), { sha256 });
    const masterRegion = masterParsed.project.products[0]!.regions[0]!;
    expect(masterRegion.safeArea).toHaveLength(4);
    for (let index = 0; index < 4; index += 1) {
      expect(Math.abs(masterRegion.safeArea[index]![0] - expectedCorners[index]![0])).toBeLessThan(0.05);
      expect(Math.abs(masterRegion.safeArea[index]![1] - expectedCorners[index]![1])).toBeLessThan(0.05);
    }
    expect(masterRegion.calibrationRef.calibrationId).toBe('cal-visual-1');
    const sidecarRaw = masterParsed.assets.find((asset) => asset.path === 'presentation/operation-anchors.json');
    assert.ok(sidecarRaw, 'master must carry the anchors sidecar');
    const sidecar = JSON.parse(Buffer.from(sidecarRaw.bytes).toString('utf8')) as { anchors: Array<{ name: string }> };
    expect(sidecar.anchors.map((anchor) => anchor.name)).toEqual(['Chest center']);
    await (await shown(page, 'source-file')).setInputFiles(masterPath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded visual-setup-master.logo-project');
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Anchor (1)', exact: true })).toBeVisible();

    // Issue BOTH customer formats from the measured setup, with ordinary
    // product/variant/logo selection only (setups ride along automatically).
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(frontPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await (await shown(page, 'builder-next')).click();
    await expect(await shown(page, 'generate-status')).toContainText('included automatically');
    await (await shown(page, 'customer-name')).fill('Visual Customer');
    await (await shown(page, 'job-ref')).fill('VISUAL-01');
    await (await shown(page, 'issued-by')).fill('Lead check');
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('Customer file ready (revision 1)');
    const baselineEvent = page.waitForEvent('download');
    await (await shown(page, 'download-baseline')).click();
    const baseline = await baselineEvent;
    const baselinePath = info.outputPath('visual-issued.logo-project');
    await baseline.saveAs(baselinePath);
    const parsed = await parseProjectPackage(new Uint8Array(await readFile(baselinePath)), { sha256 });
    expect(parsed.project.revision).toBe(1);
    expect(parsed.project.products).toHaveLength(1);
    const region = parsed.project.products[0]!.regions[0]!;
    expect(region.safeArea).toHaveLength(4);
    for (let index = 0; index < 4; index += 1) {
      expect(Math.abs(region.safeArea[index]![0] - expectedCorners[index]![0])).toBeLessThan(0.05);
      expect(Math.abs(region.safeArea[index]![1] - expectedCorners[index]![1])).toBeLessThan(0.05);
    }
    expect(region.calibrationRef.calibrationId).toBe('cal-visual-1');
    const issuedProductId = parsed.project.products[0]!.id;
    const issuedVariantId = parsed.project.products[0]!.variants[0]!.id;
    const issuedConfigId = parsed.project.configurations[0]!.id;
    const issuedLogoId = parsed.project.logos[0]!.id;
    // The issued baseline doubles as the office copy for staff review.
    const officePath = baselinePath;

    const htmlEvent = page.waitForEvent('download');
    await (await shown(page, 'download-package')).click();
    const html = await htmlEvent;
    assert.ok(html.suggestedFilename().endsWith('.html'), 'self-contained customer file downloads');
    const htmlPath = info.outputPath('visual-customer.html');
    await html.saveAs(htmlPath);

    await (await shown(page, 'step-details')).click();
    await (await shown(page, 'format-hybrid')).check();
    await (await shown(page, 'generate')).click();
    await expect(await shown(page, 'generate-status')).toContainText('Customer file ready (revision 1)');
    const zipEvent = page.waitForEvent('download');
    await (await shown(page, 'download-package')).click();
    const zip = await zipEvent;
    const zipPath = info.outputPath('visual-hybrid.zip');
    await zip.saveAs(zipPath);
    const entries = unzipSync(new Uint8Array(await readFile(zipPath)));
    expect(Object.keys(entries).sort()).toEqual(['OPEN_LOGO_CONFIGURATOR.html', 'VISUAL-01.logo-project']);

    // The customer opens the ACTUAL generated file, places the logo on the
    // guided region, confirms and returns it.
    const editor = await context.newPage();
    editor.on('pageerror', (error) => probe.pageErrors.push(String(error)));
    editor.on('console', (message) => {
      if (message.type() === 'error') probe.consoleErrors.push(message.text());
    });
    await editor.goto(pathToFileURL(htmlPath).href);
    const customer = (name: string) => editor.locator(`[data-customer-hook="${name}"]`);
    await expect(customer('project-id')).toHaveText(parsed.project.projectId);
    await selectCustomerOption(editor, 'configuration', issuedConfigId);
    await selectCustomerOption(editor, 'region', 'region-visual-1');
    await selectCustomerOption(editor, 'logo', issuedLogoId);
    await selectCustomerOption(editor, 'method', 'embroidery');
    await cfill(editor, 'x-mm', '140');
    await cfill(editor, 'y-mm', '100');
    await cfill(editor, 'width-mm', '60');
    await cfill(editor, 'height-mm', '30');
    await cfill(editor, 'rotation', '0');
    await cfill(editor, 'placement-instructions', 'Chest crest.');
    await revealCustomerControl(editor, 'add');
    await customer('add').click();
    await expect(customer('geometry')).toContainText('Fits: yes');
    await expect(customer('review')).toContainText('Center: 140.0 mm, 100.0 mm');
    await expect(customer('review')).toContainText('Width × height: 60.0 mm × 30.0 mm');
    await cfill(editor, 'confirmed-by', 'Visual Customer');
    await revealCustomerControl(editor, 'confirm');
    await customer('confirm').click();
    await expect(customer('confirmation')).toContainText('Confirmed: version');
    const returnEvent = editor.waitForEvent('download');
    await revealCustomerControl(editor, 'submit');
    await customer('submit').click();
    const returned = await returnEvent;
    const returnPath = info.outputPath('visual-return.logo-project');
    await returned.saveAs(returnPath);
    const returnedProject = (await parseProjectPackage(new Uint8Array(await readFile(returnPath)), { sha256 })).project;
    expect(returnedProject.confirmation?.revision).toBe(returnedProject.revision);
    const returnedPlacement = returnedProject.configurations[0]!.placements[0]!;
    expect(returnedPlacement.pos).toMatchObject({ xMm: 140, yMm: 100 });
    expect(returnedPlacement.widthMm).toBe(60);
    expect(returnedPlacement.heightMm).toBe(30);
    await editor.close();

    // Same-station review: office copy + return → accept → candidate JSON →
    // operation sheet + exact one-page branded PDF + minimal operator JSON.
    const fresh = await context.newPage();
    fresh.on('pageerror', (error) => probe.pageErrors.push(String(error)));
    fresh.on('console', (message) => {
      if (message.type() === 'error') probe.consoleErrors.push(message.text());
    });
    await fresh.goto(BUILDER_URL);
    await expect(fresh.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
    await (await shownFresh(fresh, 'mode-review')).click();
    await (await shownFresh(fresh, 'baseline-file')).setInputFiles(officePath);
    await expect(await shownFresh(fresh, 'baseline-load-status')).toContainText('Loaded office copy');
    await (await shownFresh(fresh, 'step-return')).click();
    await (await shownFresh(fresh, 'return-file')).setInputFiles(returnPath);
    await expect(await shownFresh(fresh, 'review-panel')).toBeVisible();
    await (await shownFresh(fresh, 'step-check')).click();
    await (await shownFresh(fresh, 'review-decision-reviewer')).fill('Visual reviewer');
    await (await shownFresh(fresh, 'review-decision-choice')).selectOption('approved');
    await (await shownFresh(fresh, 'review-decision-note')).fill('Guided geometry accepted.');
    await (await shownFresh(fresh, 'review-decision-record')).click();
    await expect(await shownFresh(fresh, 'review-decision-status')).toContainText('Recorded approved');
    const reviewedEvent = fresh.waitForEvent('download');
    await (await shownFresh(fresh, 'review-decision-download')).click();
    const reviewed = await reviewedEvent;
    const reviewedPath = info.outputPath('visual-reviewed.logo-project');
    await reviewed.saveAs(reviewedPath);
    const reviewedProject = (await parseProjectPackage(new Uint8Array(await readFile(reviewedPath)), { sha256 })).project;
    expect(reviewedProject.review?.decision).toBe('approved');

    const candidateEvent = fresh.waitForEvent('download');
    await (await shownFresh(fresh, 'candidate-download')).click();
    const candidateFile = await candidateEvent;
    const candidatePath = info.outputPath('visual-candidate.json');
    await candidateFile.saveAs(candidatePath);
    const candidateJson = JSON.parse(await readFile(candidatePath, 'utf8')) as {
      revision: number; digest: string; status: string;
      configurations: Array<{ productId: string; placements: Array<{ regionId: string; pos: { xMm: number; yMm: number }; widthMm: number; heightMm: number }> }>;
    };
    expect(candidateJson.status).toBe('candidate-pending-review');
    expect(candidateJson.revision).toBe(returnedProject.revision);
    const candidateConfig = candidateJson.configurations.find((entry) => entry.productId === issuedProductId);
    assert.ok(candidateConfig, 'candidate should carry the guided configuration');
    expect(candidateConfig.placements).toHaveLength(1);
    expect(candidateConfig.placements[0]).toMatchObject({
      regionId: 'region-visual-1', pos: { xMm: 140, yMm: 100 }, widthMm: 60, heightMm: 30,
    });

    await (await shownFresh(fresh, 'preview-document')).click();
    const operation = await shownFresh(fresh, 'operation-container');
    await expect(operation.locator('.opsheet').first()).toBeVisible();
    // Human job fields on the real sheet (no anchor dimensions were authored
    // in this synthetic run, so the sheet stays honestly pending-production).
    await (await shownFresh(fresh, 'sheet-customer')).fill('Visual Customer');
    await (await shownFresh(fresh, 'sheet-reference')).fill('VISUAL-01');
    await (await shownFresh(fresh, 'sheet-instructions')).fill('Press the chest crest at 160C for 15 seconds.');
    await expect(operation).toContainText('Visual Customer');
    await expect(operation).toContainText('VISUAL-01');
    await expect(operation).toContainText('setup needed before production');
    const sheetCount = await operation.locator('section.opsheet').count();
    assert.ok(sheetCount >= 1, 'expected at least one operation sheet');
    const pdfBytes = await fresh.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
    await writeFile(info.outputPath('visual-sheet.pdf'), pdfBytes);
    expect(countPdfPages(new Uint8Array(pdfBytes))).toBe(sheetCount);
    const operatorEvent = fresh.waitForEvent('download');
    await (await shownFresh(fresh, 'operator-download')).click();
    const operatorFile = await operatorEvent;
    const operatorPath = info.outputPath('visual-operator.json');
    await operatorFile.saveAs(operatorPath);
    const operatorPayload = JSON.parse(await readFile(operatorPath, 'utf8')) as { format: string };
    expect(operatorPayload.format).toBe('operation-export/1');
    await fresh.close();

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test('shared region: one safe-area edit reaches both variants, anchors stay per-variant', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { context, page, probe } = await openBuilder(browser);
  try {
    await (await shown(page, 'start-create')).click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();

    // Crafted fixture: product P with variants A/B sharing ONE measured
    // region R (280x200), one photo, one evaluated mapping per variant.
    const png = await syntheticPngBytes(page, '#1d3a6f', 40, 30);
    const region = {
      id: 'region-shared-1',
      name: 'Shared chest',
      frame: {
        frameId: 'frame-shared-1',
        originDescription: 'Lower-left corner of the measured rectangle',
        axes: { xPositive: 'right', yPositive: 'up' },
      },
      calibrationRef: { calibrationId: 'cal-shared-1', version: '1' },
      safeArea: [[0, 0], [280, 0], [280, 200], [0, 200]],
      allowedMethods: ['embroidery', 'print'],
    };
    const project = {
      schemaVersion: '0.1.0-provisional',
      projectId: 'SYN-PROJ-SHARED-001',
      revision: 1,
      products: [{
        schemaVersion: '0.1.0-provisional',
        id: 'P-SHARED-01',
        name: 'Shared product',
        kind: 'other',
        variants: [
          { id: 'P-SHARED-01-A', regionIds: ['region-shared-1'] },
          { id: 'P-SHARED-01-B', regionIds: ['region-shared-1'] },
        ],
        regions: [region],
        calibrations: [{ id: 'cal-shared-1', version: '1', description: 'shared visual trial' }],
      }],
      logos: [],
      configurations: [
        { id: 'cfg-shared-a', productId: 'P-SHARED-01', variantId: 'P-SHARED-01-A', placements: [] },
        { id: 'cfg-shared-b', productId: 'P-SHARED-01', variantId: 'P-SHARED-01-B', placements: [] },
      ],
    };
    const mappingFor = (variantId: string) => ({
      productId: 'P-SHARED-01',
      variantId,
      regionId: 'region-shared-1',
      view: 'front',
      image: 'presentation/front.png',
      transform: { a: 1 / 280, b: 0, c: 0, d: 0, e: -1 / 200, f: 1 },
      calibrationId: 'cal-shared-1',
      calibrationVersion: '1',
      status: 'provisional',
    });
    const bytes = await createProjectPackage({
      project,
      assets: [],
      additionalAssets: [
        { path: 'presentation/front.png', bytes: png },
        {
          path: 'presentation/preview.json',
          bytes: new TextEncoder().encode(JSON.stringify({
            version: 2,
            views: [
              { productId: 'P-SHARED-01', variantId: 'P-SHARED-01-A', view: 'front', image: 'presentation/front.png' },
              { productId: 'P-SHARED-01', variantId: 'P-SHARED-01-B', view: 'front', image: 'presentation/front.png' },
            ],
          })),
        },
        {
          path: 'presentation/photo-mappings.json',
          bytes: new TextEncoder().encode(JSON.stringify({
            version: 1,
            mappings: [mappingFor('P-SHARED-01-A'), mappingFor('P-SHARED-01-B')],
          })),
        },
      ],
    }, { sha256 });
    const fixturePath = info.outputPath('shared-region.logo-project');
    await writeFile(fixturePath, Buffer.from(bytes));
    await (await shown(page, 'source-file')).setInputFiles(fixturePath);
    await expect(await shown(page, 'source-status')).toContainText('Loaded shared-region.logo-project');

    const workspace = builder(page, 'product-workspace');
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    await workspace.getByRole('button', { name: 'Safe area (4)', exact: true }).click();

    // Edit under variant A: select corner 1, nudge +1mm in x via keyboard.
    await workspace.locator('.product-setup-vertex').first().click();
    await workspace.locator('.product-setup-vertex.is-selected').press('ArrowRight');
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText('Saved Shared chest (shared by 2 options) · Front (4 safe-area corners, 0 anchors).')).toBeVisible();

    // Variant B shows the SAME shared safe area; its anchors stay its own.
    await (await shown(page, 'workspace-variant')).selectOption('P-SHARED-01-B');
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    await workspace.getByRole('button', { name: 'Anchor', exact: true }).click();
    const stage = workspace.locator('.product-setup-overlay').first();
    const stageBox = (await stage.boundingBox())!;
    await stage.click({ position: { x: Math.round(stageBox.width * 0.5), y: Math.round(stageBox.height * 0.5) } });
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved Shared chest.*\(4 safe-area corners, 1 anchors\)/)).toBeVisible();

    // Back on A: shared edit retained, B's anchor absent (per-variant).
    await (await shown(page, 'workspace-variant')).selectOption('P-SHARED-01-A');
    await expect(workspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Anchor', exact: true })).toBeVisible();

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
