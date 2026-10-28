import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { BUILDER_URL, gotoBuilder, openOfflineContext, revealBuilderControl } from './helpers.js';
import type { Probe } from './helpers.js';

// Visual operation dimensions acceptance through the operator job shell:
// one calibrated product with a named setup anchor, two placed logos, FOUR
// real measurement rows through the placement measurement selects (dx + dy
// per logo) → bindings in the operator JSON → an incompatible
// direction/edge pair is refused with guidance → Save job/reopen keeps all
// four rows → the review sheet lists all four. Synthetic fixtures only
// (in-page canvas PNGs). Offline file://, zero console/page errors, zero
// HTTP(S).

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

function pw(page: Page, name: string) {
  return page.locator(`[data-placement-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openStation(browser: Browser): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  await test.info().attach('visual-dimensions-environment', {
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

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.httpRequests).toEqual([]);
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

async function downloadTo(page: Page, button: import('@playwright/test').Locator, outPath: string): Promise<string> {
  const event = page.waitForEvent('download');
  await button.click();
  const download = await event;
  await download.saveAs(outPath);
  return outPath;
}

/**
 * Headless-provable print contract: the sheet renders on screen, the
 * station chrome hides under print media, and the one-page A4-landscape
 * CSS rules plus the renderer's own page budget are present.
 */
async function expectPrintContract(page: Page, reviewHost: ReturnType<typeof builder>): Promise<void> {
  const preview = reviewHost.locator('[data-doc-review-preview]');
  await expect(preview.locator('.opsheet').first()).toBeVisible();
  await expect(preview).toContainText('1 printed page(s)');
  const styleText = await page.evaluate(() => [...document.querySelectorAll('style')].map((node) => node.textContent ?? '').join('\n'));
  expect(styleText).toContain('@page { size: A4 landscape;');
  expect(styleText).toMatch(/\.opsheet\s*\{[^}]*break-after:\s*page/);
  await page.emulateMedia({ media: 'print' });
  try {
    await expect(page.locator('header.station-header')).toBeHidden();
    await expect(page.locator('.job-steps')).toBeHidden();
    await expect(page.locator('[data-job-step="prepare"]')).toBeHidden();
    await expect(page.locator('[data-job-step="placements"]')).toBeHidden();
    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeHidden();
  } finally {
    await page.emulateMedia({ media: 'screen' });
  }
  await expect(preview.locator('.opsheet').first()).toBeVisible();
}

test('four select-based measurements across two logos print and export', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill('Acme Athletics');
    await (await shown(page, 'job-ref')).fill('DIMS-01');
    const jacketPng = await syntheticPngBytes(page, '#1d6f3a');
    await shown(page, 'product-view-add');
    const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
    await rows.first().locator('input[type="text"]').fill('Front');
    await rows.first().locator('input[type="file"]').setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: Buffer.from(jacketPng) });
    await expect(rows.first().locator('.view-row-state')).toContainText('ready');
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');

    // One named anchor on the calibrated front view.
    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    await expect(guided).toBeVisible();
    const overlay = guided.locator('.guided-scale-overlay[aria-label*="rectangle corners"]');
    const overlayBox = (await overlay.boundingBox())!;
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]] as const) {
      await overlay.click({ position: { x: Math.round(overlayBox.width * fx), y: Math.round(overlayBox.height * fy) } });
    }
    await guided.locator('[data-guided="width"]').fill('280');
    await guided.locator('[data-guided="height"]').fill('200');
    await guided.locator('[data-guided="create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Measured the Front view: 280×200');
    await workspace.getByRole('button', { name: 'Anchor', exact: true }).click();
    const stage = workspace.locator('.product-setup-overlay').first();
    const stageBox = (await stage.boundingBox())!;
    await stage.click({ position: { x: Math.round(stageBox.width * 0.5), y: Math.round(stageBox.height * 0.5) } });
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 1 anchors\)/)).toBeVisible();

    // Two logos through the Step 1 chooser.
    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    const starPng = await syntheticPngBytes(page, '#b03030', 160, 160);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'star.png', mimeType: 'image/png', buffer: Buffer.from(starPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added star.png');

    await (await shown(page, 'job-to-placements')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    const host = builder(page, 'job-placement-host');

    // Two placements of the two artworks.
    for (const [logo, width, height] of [['crest', '90', '40'], ['star', '60', '30']] as const) {
      await host.getByRole('button', { name: 'Add logo placement' }).click();
      await pw(page, 'pw-add-logo').selectOption({ label: logo });
      const addMethod = pw(page, 'pw-add-method');
      if ((await addMethod.count()) > 0) await addMethod.selectOption('print');
      await pw(page, 'pw-add-width').fill(width);
      await pw(page, 'pw-add-height').fill(height);
      await pw(page, 'pw-add-confirm').click();
      await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText(logo);
    }

    // Four real measurement rows: dx + dy per logo, from the setup anchor.
    const bind = async (logoLabel: string, edgeLabel: string, directionLabel: string): Promise<void> => {
      await host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: logoLabel }).click();
      await host.getByRole('button', { name: 'Add measurement' }).click();
      await pw(page, 'pw-measure-anchor').selectOption({ label: 'Anchor 1' });
      await pw(page, 'pw-measure-edge').selectOption({ label: edgeLabel });
      await pw(page, 'pw-measure-direction').selectOption({ label: directionLabel });
      await pw(page, 'pw-measure-save').click();
      await expect(host.locator('[data-placement-hook="pw-measurements"]')).toContainText(/mm/);
    };
    await bind('crest', 'left', 'Horizontal');
    await bind('crest', 'top', 'Vertical');
    await bind('star', 'right', 'Horizontal');
    await bind('star', 'bottom', 'Vertical');
    await host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'crest' }).click();
    const crestRows = await host.locator('[data-placement-hook="pw-measurements"]').innerText();
    expect(crestRows).toMatch(/Anchor 1 to left edge, horizontal/);
    expect(crestRows).toMatch(/\d+(\.\d)? mm/);
    await host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'star' }).click();
    const starRows = await host.locator('[data-placement-hook="pw-measurements"]').innerText();
    expect(starRows).toMatch(/Anchor 1 to right edge, horizontal/);
    expect(starRows).toMatch(/Anchor 1 to bottom edge, vertical/);
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('visual-dimensions-four-rows.png'), fullPage: true });
    }

    // Incompatible convention is refused with guidance, nothing is stored.
    await host.getByRole('button', { name: 'Add measurement' }).click();
    await pw(page, 'pw-measure-anchor').selectOption({ label: 'Anchor 1' });
    await pw(page, 'pw-measure-edge').selectOption({ label: 'top' });
    await pw(page, 'pw-measure-direction').selectOption({ label: 'Horizontal' });
    await pw(page, 'pw-measure-save').click();
    await expect(host.locator('[data-placement-hook="pw-measure-notice"]')).toContainText(/not compatible|Horizontal measures/i);
    await host.locator('[data-placement-hook="pw-measure-cancel"]').click();
    await expect(host.locator('[data-placement-hook="pw-measure-form"]')).toHaveCount(0);
    await expect(host.locator('[data-placement-hook="pw-measurements"]')).not.toContainText('top edge, horizontal');

    // All four bindings export in the minimal operator JSON with numbers.
    // Save the job first so the reopen comparison below restores everything.
    const jobEvent = page.waitForEvent('download');
    await builder(page, 'job-save').click();
    const job = await jobEvent;
    const jobPath = info.outputPath('visual-dimensions.job.logo-project');
    await job.saveAs(jobPath);

    await host.getByRole('button', { name: 'Review document' }).click();
    await expect(page.locator('[data-job-step="review"]')).toBeVisible();
    const reviewHost = builder(page, 'job-review-host');
    await reviewHost.locator('[data-doc-review-instructions]').fill('Press the chest emblem, then the star, checking all four edges.');
    await reviewHost.locator('[data-doc-review-instructions]').press('Tab');
    const preview = reviewHost.locator('[data-doc-review-preview]');
    await expect(preview.locator('ul.opsheet-dims li')).toHaveCount(4);
    const dimTexts = await preview.locator('ul.opsheet-dims li').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    expect(dimTexts).toHaveLength(4);
    expect(dimTexts.map((line) => line.trim().split(' ')[0])).toEqual(['1', '2', '3', '4']);
    expect(dimTexts[0]).toMatch(/left edge, horizontal/);
    expect(dimTexts[1]).toMatch(/top edge, vertical/);
    expect(dimTexts[2]).toMatch(/right edge, horizontal/);
    expect(dimTexts[3]).toMatch(/bottom edge, vertical/);
    await expect(preview).toContainText('Press the chest emblem');
    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
    await expectPrintContract(page, reviewHost);
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('visual-dimensions-sheet.png'), fullPage: true });
    }

    await reviewHost.locator('summary', { hasText: 'More output options' }).click();
    const operatorPath = await downloadTo(page, reviewHost.getByRole('button', { name: 'Save operator data' }), info.outputPath('visual-dimensions-operator-data.json'));
    const operatorView = JSON.parse(await readFile(operatorPath, 'utf8')) as {
      format: string;
      products: Array<{ logos: Array<{ code: string; measurements: Array<{ anchor: string; logoEdge: string; distanceMm: number }> }> }>;
    };
    expect(operatorView.format).toBe('operation-export/1');
    const logos = operatorView.products[0]!.logos;
    expect(logos).toHaveLength(2);
    expect(logos[0]!.measurements).toHaveLength(2);
    expect(logos[1]!.measurements).toHaveLength(2);
    for (const logo of logos) {
      for (const measurement of logo.measurements) {
        expect(typeof measurement.distanceMm).toBe('number');
        expect(Number.isFinite(measurement.distanceMm)).toBe(true);
        assert.ok(measurement.anchor.length > 0, 'binding carries an anchor');
      }
    }
    const edges = logos.flatMap((logo) => logo.measurements.map((m) => m.logoEdge));
    expect(edges.some((text) => text.includes('left'))).toBe(true);
    expect(edges.some((text) => text.includes('top'))).toBe(true);
    expect(edges.some((text) => text.includes('right'))).toBe(true);
    expect(edges.some((text) => text.includes('bottom'))).toBe(true);
    const diagPath = await downloadTo(page, reviewHost.getByRole('button', { name: 'Save diagnostic data' }), info.outputPath('visual-dimensions-candidate.json'));
    const candidateJson = JSON.parse(await readFile(diagPath, 'utf8')) as { digest?: string };
    assert.ok(typeof candidateJson.digest === 'string' && candidateJson.digest.length === 64, 'candidate carries a digest');

    // Fresh station → Open job keeps all four rows byte-for-byte.
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
      await fresh.locator('[data-builder-hook="job-to-placements"]').click();
      const freshHost = fresh.locator('[data-builder-hook="job-placement-host"]');
      expect(await freshHost.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);
      await freshHost.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'crest' }).click();
      expect(await freshHost.locator('[data-placement-hook="pw-measurements"]').innerText()).toBe(crestRows);
      await freshHost.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'star' }).click();
      expect(await freshHost.locator('[data-placement-hook="pw-measurements"]').innerText()).toBe(starRows);
      expect(freshProbe.pageErrors).toEqual([]);
      expect(freshProbe.consoleErrors).toEqual([]);
      expect(freshProbe.httpRequests).toEqual([]);
    } finally {
      await freshContext.close();
    }

    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});
