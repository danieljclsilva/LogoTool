import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createProjectPackage } from '../src/packaging/project-package/index.js';
import { release } from 'node:os';
import { BUILDER_URL, gotoBuilder, openOfflineContext, revealBuilderControl } from './helpers.js';
import type { Probe } from './helpers.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';

// Visual product setup acceptance through the operator job shell: clean
// empty draft → real product photo upload → honest unmeasured pending →
// guided first measured region (4 photo corners + real width/height) →
// draw safe area + click anchor on the photo → ONE atomic save → per-view
// isolation → Save job → fresh station Open restores the workspace →
// placement + real measurement binding + review document. The prepared
// setup then rides the ordinary job save/reopen path (no separate master
// file, no customer issue/return in this flow). No demo/mock content;
// synthetic fixtures only (in-page canvas PNGs). Offline file://.

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openStation(browser: Browser): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  await test.info().attach('visual-product-setup-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform, release: release(), arch: process.arch,
      browser: browser.browserType().name(), browserVersion: browser.version(),
      viewport: { width: 1280, height: 900 }, offline: true, entryPoint: BUILDER_URL,
    }, null, 2),
  });
  const { context, page, probe } = await openOfflineContext(browser, { width: 1280, height: 900 });
  await gotoBuilder(page);
  await expect(page.locator('[data-job-landing]')).toBeVisible();
  await builder(page, 'job-landing-create').click();
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
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

function pw(page: Page, name: string) {
  return page.locator(`[data-placement-hook="${name}"]`);
}

async function downloadTo(page: Page, button: import('@playwright/test').Locator, outPath: string): Promise<string> {
  const event = page.waitForEvent('download');
  await button.click();
  const download = await event;
  await download.saveAs(outPath);
  return outPath;
}

test('visual setup: upload → guided measure → draw + anchors → save → job roundtrip → review', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const { context, page, probe } = await openStation(browser);
  try {
    // Clean empty draft: no demo, workspace waits for a real product.
    await expect(builder(page, 'demo-create')).toHaveCount(0);
    await expect(await shown(page, 'workspace-status')).toContainText('No product yet');

    // Real fresh upload: two named view images staged through real rows, product added.
    const frontPng = await syntheticPngBytes(page, '#1d6f3a');
    const backPng = await syntheticPngBytes(page, '#6f1d3a');
    const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
    await rows.nth(0).locator('input[type="text"]').fill('Front');
    await rows.nth(0).locator('input[type="file"]').setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: Buffer.from(frontPng) });
    await expect(rows.nth(0).locator('.view-row-state')).toContainText('ready');
    await (await shown(page, 'product-view-add')).click();
    await rows.nth(1).locator('input[type="text"]').fill('Back');
    await rows.nth(1).locator('input[type="file"]').setInputFiles({ name: 'back.png', mimeType: 'image/png', buffer: Buffer.from(backPng) });
    await expect(rows.nth(1).locator('.view-row-state')).toContainText('ready');
    await (await shown(page, 'customer-name')).fill('Visual Customer');
    await (await shown(page, 'job-ref')).fill('VISUAL-01');
    await (await shown(page, 'product-name')).fill('Test Jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product Test Jacket');

    // Honest pending: front view has no scale mapping yet.
    const workspace = builder(page, 'product-workspace');
    await expect(workspace.locator('[role="tablist"]')).toBeVisible();
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    await expect(workspace.getByRole('tab', { name: 'Back' })).toBeVisible();
    // Stable view identity: tab hooks key on the view id (never label text),
    // so legacy sides keep their hooks across renames.
    await expect(workspace.locator('[data-fkey="psv-tab-view-1"]')).toBeVisible();
    await expect(workspace.locator('[data-fkey="psv-tab-view-2"]')).toBeVisible();
    await expect(workspace.getByText('has no scale mapping yet')).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Set up scale' })).toBeVisible();

    // Guided first measured region: click 4 corners, enter real mm, create.
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    await expect(guided).toBeVisible();
    const overlay = guided.locator('.guided-scale-overlay[aria-label*="rectangle corners"]');
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
    // selected; expand before choosing.
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
    // Pointer drag moves staged corner 0 by +2mm in x with y bit-identical
    // (same pointer row through the inverse mapping); untouched corners do
    // not move. This hand-tapped ring is a general polygon (not an exact
    // rectangle), so the free-corner path applies: exact canonical movement.
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

    // Save job → parse the ACTUAL package bytes (region geometry + sidecar
    // anchors): the scope region keeps the measured rectangle; the
    // drawn+dragged polygon persists as a named sibling.
    const jobEvent = page.waitForEvent('download');
    await builder(page, 'job-save').click();
    const job = await jobEvent;
    const jobPath = info.outputPath('visual-setup.job.logo-project');
    await job.saveAs(jobPath);
    await expect(builder(page, 'job-persistence')).toHaveText('Job file download started. Keep the downloaded file to reopen this job.');
    const expectedCorners = stagedAfter;
    const saved = await parseProjectPackage(new Uint8Array(await readFile(jobPath)), { sha256 });
    const savedScope = saved.project.products[0]!.regions[0]!;
    expect(savedScope.id).toBe('region-visual-1');
    expect(savedScope.safeArea).toEqual([[0, 0], [280, 0], [280, 200], [0, 200]]);
    expect(savedScope.calibrationRef.calibrationId).toBe('cal-visual-1');
    const savedSiblings = saved.project.products[0]!.regions.filter((entry) =>
      entry.id.startsWith('region-visual-1--area-'));
    expect(savedSiblings).toHaveLength(1);
    expect(savedSiblings[0]!.safeArea).toHaveLength(4);
    for (let index = 0; index < 4; index += 1) {
      expect(Math.abs(savedSiblings[0]!.safeArea[index]![0] - expectedCorners[index]![0])).toBeLessThan(0.05);
      expect(Math.abs(savedSiblings[0]!.safeArea[index]![1] - expectedCorners[index]![1])).toBeLessThan(0.05);
    }
    expect(savedSiblings[0]!.calibrationRef.calibrationId).toBe('cal-visual-1');
    const sidecarRaw = saved.assets.find((asset) => asset.path === 'presentation/operation-anchors.json');
    assert.ok(sidecarRaw, 'saved job must carry the anchors sidecar');
    const sidecar = JSON.parse(Buffer.from(sidecarRaw.bytes).toString('utf8')) as { anchors: Array<{ name: string }> };
    expect(sidecar.anchors.map((anchor) => anchor.name)).toEqual(['Chest center']);

    // Fresh station → Open job restores identity, card inclusion, workspace.
    const freshContext = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const fresh = await freshContext.newPage();
    const freshProbe: Probe = { pageErrors: [], consoleErrors: [], httpRequests: [] };
    fresh.on('pageerror', (error) => freshProbe.pageErrors.push(String(error)));
    fresh.on('console', (message) => { if (message.type() === 'error') freshProbe.consoleErrors.push(message.text()); });
    freshContext.on('request', (request) => { if (/^https?:/.test(request.url())) freshProbe.httpRequests.push(request.url()); });
    try {
      await gotoBuilder(fresh);
      await fresh.locator('[data-builder-hook="job-landing-open"]').click();
      await fresh.locator('[data-builder-hook="job-open-file"]').setInputFiles(jobPath);
      await expect(fresh.locator('[data-job-step="prepare"]')).toBeVisible();
      await expect(fresh.locator('[data-builder-hook="customer-name"]')).toHaveValue('Visual Customer');
      await expect(fresh.locator('[data-builder-hook="job-ref"]')).toHaveValue('VISUAL-01');
      const jacketCard = fresh.locator('[data-product-card]', { hasText: 'Test Jacket' }).first();
      await expect(jacketCard.locator('input[type="checkbox"]').first()).toBeChecked();
      const freshWorkspace = fresh.locator('[data-builder-hook="product-workspace"]');
      await expect(freshWorkspace.getByRole('button', { name: 'Safe area (4)' })).toBeVisible();
      await expect(freshWorkspace.getByRole('button', { name: 'Anchor' }).first()).toBeVisible();

      // The restored anchor binds a real placement measurement, which flows
      // into the review document with staff-authored instructions.
      const freshLogo = new Uint8Array(Buffer.from((await fresh.evaluate((): string => {
        const canvas = document.createElement('canvas');
        canvas.width = 200; canvas.height = 120;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#d4af37'; context.fillRect(0, 0, 200, 120);
        return canvas.toDataURL('image/png').split(',')[1] ?? '';
      })) as string, 'base64'));
      await fresh.locator('[data-builder-hook="logo-file"]').setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(freshLogo) });
      await expect(fresh.locator('[data-builder-hook="logo-status"]')).toContainText('Added crest.png');
      await fresh.locator('[data-builder-hook="job-to-placements"]').click();
      await expect(fresh.locator('[data-job-step="placements"]')).toBeVisible();
      const freshHost = fresh.locator('[data-builder-hook="job-placement-host"]');
      await freshHost.getByRole('button', { name: 'Add logo placement' }).click();
      await fresh.locator('[data-placement-hook="pw-add-logo"]').selectOption({ label: 'crest' });
      const freshMethod = fresh.locator('[data-placement-hook="pw-add-method"]');
      if ((await freshMethod.count()) > 0) await freshMethod.selectOption({ label: 'print' });
      await fresh.locator('[data-placement-hook="pw-add-width"]').fill('90');
      await fresh.locator('[data-placement-hook="pw-add-height"]').fill('40');
      await fresh.locator('[data-placement-hook="pw-add-confirm"]').click();
      await expect(freshHost.locator('[data-placement-hook="pw-placement-list"]')).toContainText('crest');
      await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
      await freshHost.getByRole('button', { name: 'Add measurement' }).click();
      await fresh.locator('[data-placement-hook="pw-measure-anchor"]').selectOption({ label: 'Chest center' });
      await fresh.locator('[data-placement-hook="pw-measure-edge"]').selectOption({ label: 'left' });
      await fresh.locator('[data-placement-hook="pw-measure-direction"]').selectOption({ label: 'Horizontal' });
      await fresh.locator('[data-placement-hook="pw-measure-save"]').click();
      const freshMeasure = await freshHost.locator('[data-placement-hook="pw-measurements"]').innerText();
      expect(freshMeasure).toMatch(/Chest center to left edge, horizontal/);
      expect(freshMeasure).toMatch(/\d+(\.\d)? mm/);
      await freshHost.getByRole('button', { name: 'Review document' }).click();
      await expect(fresh.locator('[data-job-step="review"]')).toBeVisible();
      const freshReview = fresh.locator('[data-builder-hook="job-review-host"]');
      await freshReview.locator('[data-doc-review-instructions]').fill('Press the chest crest at 160C for 15 seconds.');
      await freshReview.locator('[data-doc-review-instructions]').press('Tab');
      const freshPreview = freshReview.locator('[data-doc-review-preview]');
      await expect(freshPreview).toContainText('Press the chest crest at 160C for 15 seconds.');
      await expect(freshPreview).toContainText('Chest center, left edge, horizontal');
      await expect(freshReview.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
      await freshReview.locator('summary', { hasText: 'More output options' }).click();
      const operatorEvent = fresh.waitForEvent('download');
      await freshReview.getByRole('button', { name: 'Save operator data' }).click();
      const operatorFile = await operatorEvent;
      const operatorPath = await operatorFile.path();
      assert.ok(operatorPath, 'operator download path is available');
      const operatorView = JSON.parse(await readFile(operatorPath, 'utf8')) as {
        format: string;
        products: Array<{ logos: Array<{ measurements: Array<{ anchor: string; distanceMm: number }> }> }>;
      };
      expect(operatorView.format).toBe('operation-export/1');
      expect(operatorView.products[0]!.logos[0]!.measurements).toHaveLength(1);
      expect(operatorView.products[0]!.logos[0]!.measurements[0]!.anchor).toBe('Chest center');
      expect(typeof operatorView.products[0]!.logos[0]!.measurements[0]!.distanceMm).toBe('number');
      expect(freshProbe.pageErrors).toEqual([]);
      expect(freshProbe.consoleErrors).toEqual([]);
      expect(freshProbe.httpRequests).toEqual([]);
    } finally {
      await freshContext.close();
    }

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.httpRequests).toEqual([]);
  } finally {
    await context.close();
  }
});

test('shared region: one safe-area edit reaches both variants, anchors stay per-variant', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { context, page, probe } = await openStation(browser);
  try {
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
    await builder(page, 'job-open-file').setInputFiles(fixturePath);
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
    expect(probe.httpRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
