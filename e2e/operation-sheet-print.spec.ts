import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { BUILDER_URL, gotoBuilder, openOfflineContext, revealBuilderControl } from './helpers.js';
import { countPdfPages, readMediaBox } from './sheet-fixtures.js';
import type { Probe } from './helpers.js';

// Operation sheet acceptance through the operator job shell: the Step 3
// review module is the print path (window.print with print CSS; the native
// dialog is never asserted). Department-authored instructions plus real
// measurement bindings from product setup flow into the shared
// A4-landscape renderer; operator/diagnostic exports carry the same
// snapshot. Synthetic fixtures only. Offline file:// throughout.
//
// Print contract (verified end to end here): the sheet renders on screen,
// the chrome hides under print media, and the generated PDF carries exactly
// one A4 landscape page per rendered sheet with real content (no blank
// first/trailing pages, MediaBox matches A4 landscape).

interface Opened {
  context: BrowserContext;
  page: Page;
  probe: Probe;
}

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

async function openStation(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<Opened> {
  await test.info().attach('operation-sheet-print-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform, release: release(), arch: process.arch,
      browser: browser.browserType().name(), browserVersion: browser.version(),
      viewport, offline: true, entryPoint: BUILDER_URL,
    }, null, 2),
  });
  const { context, page, probe } = await openOfflineContext(browser, viewport);
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

/** Stage one Images view through the real intake row (label + file). */
async function stageIntakeImage(page: Page, label: string, fileName: string, bytes: Uint8Array): Promise<void> {
  await shown(page, 'product-view-add');
  const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
  await rows.first().locator('input[type="text"]').fill(label);
  await rows.first().locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(rows.first().locator('.view-row-state')).toContainText('ready');
}

/**
 * Full real setup for one Images product view: guided rectangle scale, one
 * named anchor, atomic save. Returns nothing; the anchor name is asserted
 * downstream through the placement measurement bindings.
 */
async function setupViewWithAnchor(page: Page, viewTab: string, anchorName: string, widthMm: string, heightMm: string): Promise<void> {
  const workspace = builder(page, 'product-workspace');
  if (viewTab !== '') await workspace.getByRole('tab', { name: viewTab }).click();
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
  await guided.locator('[data-guided="width"]').fill(widthMm);
  await guided.locator('[data-guided="height"]').fill(heightMm);
  await guided.locator('[data-guided="create"]').click();
  await expect(await shown(page, 'workspace-status')).toContainText(`Measured the ${viewTab === '' ? 'Front' : viewTab} view: ${widthMm}×${heightMm}`);
  await workspace.getByRole('button', { name: 'Anchor', exact: true }).click();
  const stage = workspace.locator('.product-setup-overlay').first();
  const stageBox = (await stage.boundingBox())!;
  await stage.click({ position: { x: Math.round(stageBox.width * 0.5), y: Math.round(stageBox.height * 0.5) } });
  await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
  if (anchorName !== 'Anchor 1') {
    const summary = workspace.locator('summary', { hasText: 'All anchors' });
    if ((await summary.count()) > 0) {
      const open = await summary.first().evaluate((element) => (element.closest('details') as HTMLDetailsElement).open);
      if (!open) await summary.first().click();
    }
    await workspace.getByRole('button', { name: 'Anchor 1', exact: true }).click();
    await workspace.locator('[data-fkey^="psv-anchor-name-"]').fill(anchorName);
    await workspace.locator('[data-fkey^="psv-anchor-name-"]').press('Tab');
    await expect(workspace.getByText(`Renamed anchor to “${anchorName}”.`)).toBeVisible();
  }
  await workspace.getByRole('button', { name: 'Save product setup' }).click();
  await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 1 anchors\)/)).toBeVisible();
}

/** Add one placement on the current product; picks the safe area when several exist. */
async function addPlacement(page: Page, logoLabel: string, areaLabel: string | null, widthMm: string, heightMm: string): Promise<void> {
  const host = builder(page, 'job-placement-host');
  await host.getByRole('button', { name: 'Add logo placement' }).click();
  await pw(page, 'pw-add-logo').selectOption({ label: logoLabel });
  const area = pw(page, 'pw-add-area');
  if (areaLabel !== null && (await area.count()) > 0) await area.selectOption({ label: areaLabel });
  const addMethod = pw(page, 'pw-add-method');
  if ((await addMethod.count()) > 0) await addMethod.selectOption('print');
  await pw(page, 'pw-add-width').fill(widthMm);
  await pw(page, 'pw-add-height').fill(heightMm);
  await pw(page, 'pw-add-confirm').click();
  await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText(logoLabel);
}

/** Bind one operational measurement from a real setup anchor (select path). */
async function addMeasurement(page: Page, anchorLabel: string, edgeLabel: string, directionLabel: string): Promise<string> {
  const host = builder(page, 'job-placement-host');
  await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
  await host.getByRole('button', { name: 'Add measurement' }).click();
  await pw(page, 'pw-measure-anchor').selectOption({ label: anchorLabel });
  await pw(page, 'pw-measure-edge').selectOption({ label: edgeLabel });
  await pw(page, 'pw-measure-direction').selectOption({ label: directionLabel });
  await pw(page, 'pw-measure-save').click();
  const text = await host.locator('[data-placement-hook="pw-measurements"]').innerText();
  expect(text).toMatch(new RegExp(`${anchorLabel} to ${edgeLabel} edge, ${directionLabel.toLowerCase()}`));
  expect(text).toMatch(/\d+(\.\d)? mm/);
  return text;
}

/** Fill a per-logo technique field under Production details (change events save). */
async function fillTechnique(page: Page, hook: string, value: string): Promise<void> {
  const host = builder(page, 'job-placement-host');
  const details = pw(page, 'pw-production-details').first();
  const wasOpen = await details.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!wasOpen) {
    await host.locator('summary', { hasText: 'Production details' }).click();
  }
  const input = pw(page, hook);
  await pw(page, hook).fill(value);
  await pw(page, hook).press('Tab');
}

/** Open Step 3 with staff-authored instructions; returns the review host. */
async function reviewWithInstructions(page: Page, instructions: string): Promise<ReturnType<typeof builder>> {
  const host = builder(page, 'job-placement-host');
  await host.getByRole('button', { name: 'Review document' }).click();
  await expect(page.locator('[data-job-step="review"]')).toBeVisible();
  const reviewHost = builder(page, 'job-review-host');
  await expect(reviewHost.getByRole('heading', { name: 'Review operational document' })).toBeVisible();
  await reviewHost.locator('[data-doc-review-instructions]').fill(instructions);
  await reviewHost.locator('[data-doc-review-instructions]').press('Tab');
  return reviewHost;
}

async function downloadTo(page: Page, button: import('@playwright/test').Locator, outPath: string): Promise<string> {
  const event = page.waitForEvent('download');
  await button.click();
  const download = await event;
  await download.saveAs(outPath);
  return outPath;
}

/**
 * Print contract: the sheet renders on screen, the station chrome hides
 * under print media, and the generated PDF carries exactly one A4
 * landscape page per rendered sheet with real content.
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
    await expect(preview.locator('.opsheet').first()).toBeVisible();
    // Actual generated PDF: exact page per sheet, A4 landscape MediaBox.
    const pdf = new Uint8Array(await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true }));
    expect(pdf.byteLength).toBeGreaterThan(10_000);
    const sheetCount = await preview.locator('section.opsheet').count();
    expect(countPdfPages(pdf)).toBe(sheetCount);
    const mediaBox = readMediaBox(pdf);
    assert.ok(mediaBox !== null, 'PDF carries a MediaBox');
    expect(Math.abs(mediaBox[0] - 841.89)).toBeLessThan(1);
    expect(Math.abs(mediaBox[1] - 595.28)).toBeLessThan(1);
  } finally {
    await page.emulateMedia({ media: 'screen' });
  }
  await expect(preview.locator('.opsheet').first()).toBeVisible();
}

test('department-authored sheet prints one A4 page with operator data', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill('Acme Athletics Print');
    await (await shown(page, 'job-ref')).fill('PRINT-JOB-01');
    const jacketPng = await syntheticPngBytes(page, '#1d6f3a');
    await stageIntakeImage(page, 'Front', 'front.png', jacketPng);
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');
    const card = page.locator('[data-product-card]', { hasText: 'Team jacket' }).first();
    await expect(card.locator('input[type="checkbox"]').first()).toBeChecked();
    await setupViewWithAnchor(page, '', 'Chest center', '280', '200');

    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    const starPng = await syntheticPngBytes(page, '#b03030', 160, 160);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'star.png', mimeType: 'image/png', buffer: Buffer.from(starPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added star.png');

    await (await shown(page, 'job-to-placements')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await addPlacement(page, 'crest', null, '80', '40');
    await addPlacement(page, 'star', null, '60', '30');
    const measurementText = await addMeasurement(page, 'Chest center', 'left', 'Horizontal');
    expect(measurementText).toMatch(/Chest center to left edge, horizontal/);
    // Every placed logo needs its own binding: measure the second logo too.
    const host2 = builder(page, 'job-placement-host');
    await host2.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'star' }).click();
    await host2.getByRole('button', { name: 'Add measurement' }).click();
    await pw(page, 'pw-measure-anchor').selectOption({ label: 'Chest center' });
    await pw(page, 'pw-measure-edge').selectOption({ label: 'right' });
    await pw(page, 'pw-measure-direction').selectOption({ label: 'Horizontal' });
    await pw(page, 'pw-measure-save').click();
    await expect(host2.locator('[data-placement-hook="pw-measurements"]')).toContainText(/Chest center to right edge, horizontal/);
    await builder(page, 'job-placement-host').locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'crest' }).click();
    await fillTechnique(page, 'pw-tech-code-input', 'CHEST-01');
    await fillTechnique(page, 'pw-tech-temperature', '160');

    const reviewHost = await reviewWithInstructions(page, 'Press at 160°C for 15 seconds. Check by eye.');
    const preview = reviewHost.locator('[data-doc-review-preview]');
    await expect(preview).toContainText('Acme Athletics Print');
    await expect(preview).toContainText('PRINT-JOB-01');
    await expect(preview).toContainText('Press at 160°C for 15 seconds. Check by eye.');
    await expect(preview).toContainText('Team jacket');
    await expect(preview).toContainText('80.0 × 40.0 mm');
    await expect(preview).toContainText('CHEST-01');
    await expect(preview).toContainText('Chest center, left edge, horizontal');
    await expect(preview).toContainText('Chest center, right edge, horizontal');
    await expect(preview).not.toContainText('DRAFT');
    await expect(preview.locator('.opsheet')).toHaveCount(1);
    expect(await preview.locator('figure.opsheet-photo figcaption').evaluateAll((els) => els.map((e) => e.textContent))).toEqual([]);
    await page.screenshot({ path: info.outputPath('operation-sheet-desktop.png'), fullPage: true });

    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
    await expectPrintContract(page, reviewHost);

    // Minimal operator JSON: business data only, no ids.
    await reviewHost.locator('summary', { hasText: 'More output options' }).click();
    const operatorPath = await downloadTo(page, reviewHost.getByRole('button', { name: 'Save operator data' }), info.outputPath('PRINT-JOB-01-operator-data.json'));
    const operatorView = JSON.parse(await readFile(operatorPath, 'utf8')) as {
      format: string;
      job: { customer?: string; reference?: string };
      products: Array<{
        product: string;
        variant: string;
        logos: Array<{ code: string; side: string; method: string; widthMm: number; heightMm: number; measurements: Array<{ anchor: string; logoEdge: string; distanceMm: number }> }>;
        instructions: string[];
      }>;
    };
    expect(operatorView.format).toBe('operation-export/1');
    expect(operatorView.job).toEqual({ customer: 'Acme Athletics Print', reference: 'PRINT-JOB-01' });
    expect(operatorView.products).toHaveLength(1);
    expect(operatorView.products[0]!.product).toBe('Team jacket');
    expect(operatorView.products[0]!.logos).toHaveLength(2);
    expect(operatorView.products[0]!.logos[0]!.widthMm).toBe(80);
    expect(operatorView.products[0]!.logos[0]!.heightMm).toBe(40);
    expect(operatorView.products[0]!.logos[0]!.code).toBe('CHEST-01');
    expect(operatorView.products[0]!.logos[0]!.measurements).toHaveLength(1);
    expect(operatorView.products[0]!.logos[0]!.measurements[0]!.anchor).toBe('Chest center');
    expect(typeof operatorView.products[0]!.logos[0]!.measurements[0]!.distanceMm).toBe('number');
    expect(operatorView.products[0]!.instructions).toEqual(['Press at 160°C for 15 seconds. Check by eye.']);
    const serialized = JSON.stringify(operatorView);
    for (const token of ['"logoId"', '"configurationId"', '"frameId"', '"calibrationId"', '"digest"', '"schemaVersion"', '"history"', '"productId"', '"variantId"', '"logoName"', '"sides"', '"sourceNotes"', '"positionText"', '"unfinished"', '"valueMm1"', '"touchesArtwork"', '"artworkPoint"', '"version"', '"revision"', '"status"', 'crest.png', 'star.png']) {
      expect(serialized.includes(token), `operator JSON must not leak ${token}`).toBe(false);
    }

    const diagPath = await downloadTo(page, reviewHost.getByRole('button', { name: 'Save diagnostic data' }), info.outputPath('candidate.json'));
    const candidateJson = JSON.parse(await readFile(diagPath, 'utf8')) as { digest?: string };
    assert.ok(typeof candidateJson.digest === 'string' && candidateJson.digest.length === 64, 'candidate carries a digest');

    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('two dimensions on the same logo print, measure and export together', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill('Acme Athletics Two');
    await (await shown(page, 'job-ref')).fill('PRINT-JOB-02');
    const jacketPng = await syntheticPngBytes(page, '#1d6f3a');
    await stageIntakeImage(page, 'Front', 'front.png', jacketPng);
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');
    await setupViewWithAnchor(page, '', 'Anchor 1', '280', '200');

    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');

    await (await shown(page, 'job-to-placements')).click();
    await addPlacement(page, 'crest', null, '90', '40');
    const host = builder(page, 'job-placement-host');
    await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
    // Row 1: horizontal distance to the left edge.
    await host.getByRole('button', { name: 'Add measurement' }).click();
    await pw(page, 'pw-measure-anchor').selectOption({ label: 'Anchor 1' });
    await pw(page, 'pw-measure-edge').selectOption({ label: 'left' });
    await pw(page, 'pw-measure-direction').selectOption({ label: 'Horizontal' });
    await pw(page, 'pw-measure-save').click();
    await expect(host.locator('[data-placement-hook="pw-measurements"]')).toContainText(/Anchor 1 to left edge, horizontal/);
    // Row 2: vertical distance to the top edge on the SAME logo.
    await host.getByRole('button', { name: 'Add measurement' }).click();
    await pw(page, 'pw-measure-anchor').selectOption({ label: 'Anchor 1' });
    await pw(page, 'pw-measure-edge').selectOption({ label: 'top' });
    await pw(page, 'pw-measure-direction').selectOption({ label: 'Vertical' });
    await pw(page, 'pw-measure-save').click();
    const rowsText = await host.locator('[data-placement-hook="pw-measurements"]').innerText();
    expect(rowsText).toMatch(/Anchor 1 to left edge, horizontal/);
    expect(rowsText).toMatch(/Anchor 1 to top edge, vertical/);

    const reviewHost = await reviewWithInstructions(page, 'Press the chest emblem at 160°C for 15 seconds.');
    const preview = reviewHost.locator('[data-doc-review-preview]');
    const firstLogo = preview.locator('article.opsheet-logo').first();
    await expect(firstLogo.locator('ul.opsheet-dims li')).toHaveCount(2);
    const dimTexts = await firstLogo.locator('ul.opsheet-dims li').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    expect(dimTexts).toHaveLength(2);
    expect(dimTexts[0]).toMatch(/^1 — -?[\d.]+ mm — .+, left edge, horizontal$/);
    expect(dimTexts[1]).toMatch(/^2 — -?[\d.]+ mm — .+, top edge, vertical$/);
    await expect(firstLogo).not.toContainText('to to');
    await expect(firstLogo).not.toContainText('(min-X)');
    await expect(firstLogo).not.toContainText('(max-Y)');
    await expect(preview).toContainText('Anchor 1');
    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
    await expectPrintContract(page, reviewHost);
    await page.screenshot({ path: info.outputPath('operation-sheet-two-dims.png'), fullPage: true });

    // Both dimensions export in the focused operator JSON (business data only).
    await reviewHost.locator('summary', { hasText: 'More output options' }).click();
    const operatorPath = await downloadTo(page, reviewHost.getByRole('button', { name: 'Save operator data' }), info.outputPath('PRINT-JOB-02-operator-data.json'));
    const operatorView = JSON.parse(await readFile(operatorPath, 'utf8')) as {
      format: string;
      products: Array<{ logos: Array<{ code: string; measurements: Array<{ anchor: string; logoEdge: string; distanceMm: number }> }> }>;
    };
    expect(operatorView.format).toBe('operation-export/1');
    expect(operatorView.products[0]!.logos[0]!.measurements).toHaveLength(2);
    expect(operatorView.products[0]!.logos[0]!.measurements.every((m) => typeof m.distanceMm === 'number' && m.anchor.length > 0)).toBe(true);

    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('fully configured two-view sheet prints complete with no unfinished items', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await (await shown(page, 'customer-name')).fill('Acme Athletics Full');
    await (await shown(page, 'job-ref')).fill('FULL-JOB-01');
    const frontPng = await syntheticPngBytes(page, '#dfe7ec');
    const backPng = await syntheticPngBytes(page, '#e8e2d5');
    await stageIntakeImage(page, 'Front', 'front.png', frontPng);
    await (await shown(page, 'product-view-add')).click();
    const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
    await rows.nth(1).locator('input[type="text"]').fill('Back');
    await rows.nth(1).locator('input[type="file"]').setInputFiles({ name: 'back.png', mimeType: 'image/png', buffer: Buffer.from(backPng) });
    await expect(rows.nth(1).locator('.view-row-state')).toContainText('ready');
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');

    // One named anchor per measured view, saved atomically with the setup.
    await setupViewWithAnchor(page, 'Front', 'Chest center', '280', '200');
    await setupViewWithAnchor(page, 'Back', 'Pocket top', '220', '180');

    const chestPng = await syntheticPngBytes(page, '#1d6f3a', 200, 120);
    const backArtPng = await syntheticPngBytes(page, '#7a1f1f', 160, 120);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'chest.png', mimeType: 'image/png', buffer: Buffer.from(chestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added chest.png');
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'backart.png', mimeType: 'image/png', buffer: Buffer.from(backArtPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added backart.png');

    await (await shown(page, 'job-to-placements')).click();
    await addPlacement(page, 'chest', 'Front measured area', '90', '40');
    const host = builder(page, 'job-placement-host');
    await host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'chest' }).click();
    await fillTechnique(page, 'pw-tech-code-input', 'LOGO-CHEST-01');
    await host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'chest' }).click();
    await host.getByRole('button', { name: 'Add measurement' }).click();
    await pw(page, 'pw-measure-anchor').selectOption({ label: 'Chest center' });
    await pw(page, 'pw-measure-edge').selectOption({ label: 'left' });
    await pw(page, 'pw-measure-direction').selectOption({ label: 'Horizontal' });
    await pw(page, 'pw-measure-save').click();
    await host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'chest' }).click();
    await host.getByRole('button', { name: 'Add measurement' }).click();
    await pw(page, 'pw-measure-anchor').selectOption({ label: 'Chest center' });
    await pw(page, 'pw-measure-edge').selectOption({ label: 'top' });
    await pw(page, 'pw-measure-direction').selectOption({ label: 'Vertical' });
    await pw(page, 'pw-measure-save').click();

    await addPlacement(page, 'backart', 'Back measured area', '60', '30');
    await host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'backart' }).click();
    await fillTechnique(page, 'pw-tech-code-input', 'LOGO-BACK-01');
    await host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'backart' }).click();
    await host.getByRole('button', { name: 'Add measurement' }).click();
    await pw(page, 'pw-measure-anchor').selectOption({ label: 'Pocket top' });
    await pw(page, 'pw-measure-edge').selectOption({ label: 'right' });
    await pw(page, 'pw-measure-direction').selectOption({ label: 'Horizontal' });
    await pw(page, 'pw-measure-save').click();
    await host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: 'backart' }).click();
    await host.getByRole('button', { name: 'Add measurement' }).click();
    await pw(page, 'pw-measure-anchor').selectOption({ label: 'Pocket top' });
    await pw(page, 'pw-measure-edge').selectOption({ label: 'top' });
    await pw(page, 'pw-measure-direction').selectOption({ label: 'Vertical' });
    await pw(page, 'pw-measure-save').click();

    // Fully configured: four bound dimensions, business codes as headings.
    const reviewHost = await reviewWithInstructions(page, 'Press the chest emblem at 160°C for 15 seconds with medium pressure, then press the back emblem at 150°C for 12 seconds.');
    const preview = reviewHost.locator('[data-doc-review-preview]');
    const dimLines = await preview.locator('article.opsheet-logo ul.opsheet-dims li').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    expect(dimLines).toHaveLength(4);
    expect(dimLines.map((line) => line.trim().split(' ')[0])).toEqual(['1', '2', '3', '4']);
    for (const line of dimLines) {
      expect(line).toMatch(/-?[\d.]+ mm — .+, (left|right|top|bottom) edge, (horizontal|vertical)/);
      expect(line.includes('to to')).toBe(false);
      expect(/\(min|max\)-[XY]/.test(line)).toBe(false);
    }
    const headings = await preview.locator('article.opsheet-logo h3.opsheet-logo-name').evaluateAll((els) => els.map((e) => e.textContent));
    expect(headings).toEqual(['LOGO-CHEST-01', 'LOGO-BACK-01']);
    await expect(preview.locator('.opsheet-unfinished')).toHaveCount(0);
    // One product ships one sheet carrying both configured logos.
    await expect(preview.locator('.opsheet')).toHaveCount(1);
    await expect(preview).toContainText('Press the chest emblem at 160°C');
    await expect(reviewHost.getByRole('button', { name: 'Print / save PDF' })).toBeEnabled();
    await expectPrintContract(page, reviewHost);
    await page.screenshot({ path: info.outputPath('operation-sheet-full.png'), fullPage: true });

    // Operator JSON carries the focused payload: business data only, no ids.
    await reviewHost.locator('summary', { hasText: 'More output options' }).click();
    const operatorPath = await downloadTo(page, reviewHost.getByRole('button', { name: 'Save operator data' }), info.outputPath('FULL-JOB-01-operator-data.json'));
    const operatorView = JSON.parse(await readFile(operatorPath, 'utf8')) as {
      format: string;
      job: { customer?: string; reference?: string };
      products: Array<{
        product: string;
        variant: string;
        logos: Array<{ code: string; side: string; method: string; widthMm: number; heightMm: number; measurements: Array<{ anchor: string; logoEdge: string; distanceMm: number }> }>;
        instructions: string[];
      }>;
    };
    expect(operatorView.format).toBe('operation-export/1');
    expect(operatorView.job).toEqual({ customer: 'Acme Athletics Full', reference: 'FULL-JOB-01' });
    expect(operatorView.products).toHaveLength(1);
    expect(operatorView.products[0]!.product).toBe('Team jacket');
    const [chestLogo, backLogo] = operatorView.products[0]!.logos;
    expect(chestLogo!.code).toBe('LOGO-CHEST-01');
    expect(backLogo!.code).toBe('LOGO-BACK-01');
    expect(chestLogo!.measurements).toHaveLength(2);
    expect(backLogo!.measurements).toHaveLength(2);
    for (const measurement of [...chestLogo!.measurements, ...backLogo!.measurements]) {
      expect(typeof measurement.distanceMm).toBe('number');
      expect(Number.isFinite(measurement.distanceMm)).toBe(true);
      expect(measurement.anchor.length).toBeGreaterThan(0);
      expect(measurement.logoEdge.length).toBeGreaterThan(0);
    }
    expect(operatorView.products[0]!.instructions).toEqual([expect.stringContaining('Press the chest emblem')]);
    const serialized = JSON.stringify(operatorView);
    for (const token of ['"logoId"', '"configurationId"', '"frameId"', '"calibrationId"', '"digest"', '"schemaVersion"', '"history"', '"productId"', '"variantId"', '"logoName"', '"sides"', '"sourceNotes"', '"positionText"', '"unfinished"', '"valueMm1"', '"touchesArtwork"', '"artworkPoint"', '"version"', '"revision"', '"status"'] as const) {
      expect(serialized.includes(token), `operator JSON must not leak ${token}`).toBe(false);
    }

    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});

test('operation sheet stays readable on a narrow viewport without horizontal overflow', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openStation(browser, { width: 390, height: 844 });
  try {
    await (await shown(page, 'customer-name')).fill('Acme Athletics Narrow');
    await (await shown(page, 'job-ref')).fill('NARROW-01');
    const jacketPng = await syntheticPngBytes(page, '#1d6f3a');
    await stageIntakeImage(page, 'Front', 'front.png', jacketPng);
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');
    await setupViewWithAnchor(page, '', 'Chest center', '280', '200');
    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await (await shown(page, 'job-to-placements')).click();
    await addPlacement(page, 'crest', null, '90', '40');
    await addMeasurement(page, 'Chest center', 'left', 'Horizontal');
    const reviewHost = await reviewWithInstructions(page, 'Press the crest.');
    const preview = reviewHost.locator('[data-doc-review-preview]');
    await expect(preview.locator('.opsheet').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('operation-sheet-narrow.png'), fullPage: true });
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});
