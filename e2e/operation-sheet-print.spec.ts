import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILDER_URL, gotoBuilder, openOfflineContext, revealBuilderControl } from './helpers.js';
import type { Probe } from './helpers.js';
import { countPdfPages, makePngs, makeReturnBytes, openCheckWithReturn, readMediaBox } from './sheet-fixtures.js';

interface Opened {
  context: BrowserContext;
  page: Page;
  probe: Probe;
}

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

/** Manual measurement lists live under Advanced disclosures now (the visual
 *  picker is the primary path); open them before driving the selects. */
async function openAdvancedRows(page: Page): Promise<void> {
  const summaries = page.locator('div[data-measurement-row] > details[data-measurement-advanced] > summary');
  const count = await summaries.count();
  for (let i = 0; i < count; i += 1) {
    const summary = summaries.nth(i);
    const open = await summary.evaluate((element) => (element.closest('details') as HTMLDetailsElement).open);
    if (!open) await summary.click();
  }
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openBuilder(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<Opened> {
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
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
  return { context, page, probe };
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.httpRequests).toEqual([]);
}

/**
 * Exterior-label contract: no rendered SVG text longer than 2 characters may
 * sit on top of the photo pixels (short A/B anchor markers are the only
 * exception, at true anchor points). Gutters carry everything else.
 */
async function expectExteriorLabels(page: Page, figure: ReturnType<Page['locator']>): Promise<void> {
  const photoBox = await figure.locator('svg.opsheet-photo-frame').boundingBox();
  assert.ok(photoBox, 'photo frame has a box');
  const texts = await figure.locator('svg.opsheet-photo-svg text').evaluateAll((els) =>
    els.map((element) => {
      const rect = (element as unknown as SVGGraphicsElement).getBoundingClientRect();
      return { text: element.textContent ?? '', x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  for (const item of texts) {
    if (item.text.trim().length <= 2) continue;
    const overlaps = item.x < photoBox.x + photoBox.width && item.x + item.width > photoBox.x &&
      item.y < photoBox.y + photoBox.height && item.y + item.height > photoBox.y;
    expect(overlaps, `label outside photo rect: ${item.text}`).toBe(false);
  }
}

/** Every dimension arrow carries visible arrowheads at both ends, plus witness lines back to the true points. */
async function expectArrowheads(page: Page, figure: ReturnType<Page['locator']>, arrows: number): Promise<void> {
  const lines = figure.locator('line.opsheet-arrow');
  await expect(lines).toHaveCount(arrows);
  const markers = await lines.evaluateAll((els) => els.map((el) => [el.getAttribute('marker-start'), el.getAttribute('marker-end')] as const));
  for (const [start, end] of markers) {
    assert.ok(start && start.startsWith('url(#'), 'arrowhead on the start');
    assert.ok(end && end.startsWith('url(#'), 'arrowhead on the end');
  }
  expect(await figure.locator('line.opsheet-witness').count()).toBeGreaterThanOrEqual(arrows);
}

test('one branded operation sheet prints exactly one A4 landscape page with operator data', async ({ browser }, info) => {
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    const pngs = await makePngs(page);
    const { baseline, returned } = await makeReturnBytes(pngs);
    await openCheckWithReturn(page, baseline, returned);

    // Department authorship: job identity + operational instructions.
    // Customer notes stay source context and never print as instructions.
    await (await shown(page, 'sheet-customer')).fill('Acme Athletics Print');
    await (await shown(page, 'sheet-reference')).fill('PRINT-JOB-01');
    await (await shown(page, 'sheet-instructions')).fill('Press at 160°C for 15 seconds. Check by eye.');
    await (await shown(page, 'preview-document')).click();
    const operation = await shown(page, 'operation-container');
    await expect(operation.locator('.opsheet').first()).toBeVisible();

    await expect(operation).toContainText('Acme Athletics Print');
    await expect(operation).toContainText('PRINT-JOB-01');
    await expect(operation).toContainText('Press at 160°C for 15 seconds. Check by eye.');
    await expect(operation).toContainText('Synthetic Chest Emblem Extended Product Line for Field Trials');
    await expect(operation).toContainText('80.0 × 40.0 mm');
    // No technical envelope and no customer notes on the operator sheet.
    await expect(operation).not.toContainText('Builder trial customer note.');
    await expect(operation).not.toContainText('candidate-pending-review');
    await expect(operation.locator('.opsheet-status').first()).toContainText('setup needed before production');
    await expect(operation.locator('.opsheet')).toHaveCount(1);
    // Three photos supplied, but only the two sides hosting selected logos print.
    await expect(operation.locator('figure.opsheet-photo')).toHaveCount(2);
    // Captions are side-only; the trial disclaimer prints exactly once.
    expect(await operation.locator('figure.opsheet-photo figcaption').evaluateAll((els) => els.map((e) => e.textContent))).toEqual(['Front', 'Back']);
    await expect(operation.locator('p.opsheet-trial-note')).toHaveCount(1);
    // Mapped artwork composites render with no dimensions yet: no arrows,
    // no labels anywhere near the photos.
    await expect(operation.locator('line.opsheet-arrow')).toHaveCount(0);
    await expect(operation.locator('text.opsheet-dim-label')).toHaveCount(0);
    await expect(operation.locator('g.opsheet-anchor-marker')).toHaveCount(0);
    // A single sheet needs no amount summary (nothing can be silently lost).
    await expect(operation.locator('.opsheet-set-summary')).toHaveCount(0);

    await page.screenshot({ path: info.outputPath('operation-sheet-desktop.png'), fullPage: true });

    // Minimal operator JSON: business data only, no ids.
    const download = page.waitForEvent('download');
    await (await shown(page, 'operator-download')).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('PRINT-JOB-01-operator.json');
    const downloadPath = await file.path();
    assert.ok(downloadPath, 'operator download path is available');
    const operatorView = JSON.parse(await readFile(downloadPath, 'utf8')) as {
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
    expect(operatorView.products[0]!.product).toBe('Synthetic Tee');
    expect(operatorView.products[0]!.variant).toBe('Size M');
    expect(operatorView.products[0]!.logos).toHaveLength(2);
    expect(operatorView.products[0]!.logos[0]!.code).toBe('Synthetic Chest Emblem Extended Product Line for Field Trials');
    expect(operatorView.products[0]!.logos[0]!.measurements).toEqual([]);
    expect(operatorView.products[0]!.instructions).toEqual(['Press at 160°C for 15 seconds. Check by eye.']);
    const serialized = JSON.stringify(operatorView);
    for (const token of ['"logoId"', '"configurationId"', '"frameId"', '"calibrationId"', '"digest"', '"schemaVersion"', '"history"', '"productId"', '"variantId"', '"logoName"', '"sides"', '"sourceNotes"', '"positionText"', '"unfinished"', '"valueMm1"', '"touchesArtwork"', '"artworkPoint"', '"version"', '"revision"', '"status"', 'SYN-LOGO-A', 'SYN-LOGO-C', 'SYN-CFG-TEE-M', 'SYN-TEE-CHEST', 'SYN-TEE-BACK', 'CAL-SYN-001', 'logos/chest.png', 'logos/back.png']) {
      expect(serialized.includes(token), `operator JSON must not leak ${token}`).toBe(false);
    }

    // Exactly one A4 landscape page at default print settings.
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
    directory = await mkdtemp(join(tmpdir(), 'logotool-sheet-pdf-'));
    const pdfPath = join(directory, 'operation-sheet.pdf');
    await writeFile(pdfPath, pdf);
    await info.attach('operation-sheet-pdf', { path: pdfPath, contentType: 'application/pdf' });
    expect(countPdfPages(new Uint8Array(pdf))).toBe(1);
    const mediaBox = readMediaBox(new Uint8Array(pdf));
    assert.ok(mediaBox, 'PDF carries a MediaBox');
    // A4 landscape: 841.89 x 595.28 pt (±1 pt tolerance for engine rounding).
    expect(Math.abs(mediaBox[0] - 841.89)).toBeLessThan(1);
    expect(Math.abs(mediaBox[1] - 595.28)).toBeLessThan(1);

    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('two dimensions on the same logo print, measure and export together', async ({ browser }, info) => {
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    const pngs = await makePngs(page);
    const { baseline, returned } = await makeReturnBytes(pngs);
    await openCheckWithReturn(page, baseline, returned);

    // Create one anchor on the mapped front photo (inverse-mapped to mm).
    await page.locator('[data-builder-hook="anchor-disclosure"] summary').click();
    const sideValue = await page.evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>('select[data-builder-hook="anchor-side"]');
      return Array.from(sel?.options ?? []).find((o) => o.text.toLowerCase().includes('front') || o.value.toLowerCase().includes('front'))?.value ?? '';
    });
    assert.ok(sideValue, 'setup offers the mapped front side');
    await page.locator('[data-builder-hook="anchor-side"]').selectOption(sideValue);
    const regionValue = await page.evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>('select[data-builder-hook="anchor-region"]');
      return Array.from(sel?.options ?? []).find((o) => o.text.includes('Chest') || o.value.includes('CHEST'))?.value ?? '';
    });
    assert.ok(regionValue, 'setup offers the chest region');
    await page.locator('[data-builder-hook="anchor-region"]').selectOption(regionValue);
    const overlay = page.locator('[data-builder-hook="anchor-setup"] svg.anchor-setup-overlay');
    await expect(overlay).toBeVisible({ timeout: 15000 });
    await overlay.scrollIntoViewIfNeeded();
    await overlay.click({ position: { x: 200, y: 160 } });
    await page.waitForTimeout(1500);
    const row1Anchor = page.getByLabel('Measurement 1 anchor for logo 1');
    await expect(row1Anchor).toContainText('Anchor', { timeout: 15000 });

    // Row 1: horizontal distance to the left edge.
    await openAdvancedRows(page);
    await row1Anchor.selectOption({ label: 'Anchor 1' });
    const row1Result = page.getByLabel('Measurement 1 result for logo 1');
    await expect(row1Result).toContainText('mm');
    await expect(row1Result).not.toContainText('setup needed');

    // Row 2: vertical distance to the top edge on the SAME logo.
    await page.getByLabel('Add measurement for logo 1').click();
    await openAdvancedRows(page);
    const row2Anchor = page.getByLabel('Measurement 2 anchor for logo 1');
    await row2Anchor.selectOption({ label: 'Anchor 1' });
    await page.getByLabel('Measurement 2 edge for logo 1').selectOption('maxY');
    await page.getByLabel('Measurement 2 direction for logo 1').selectOption('dy');
    const row2Result = page.getByLabel('Measurement 2 result for logo 1');
    await expect(row2Result).toContainText('mm');
    await expect(row2Result).not.toContainText('setup needed');

    // Both dimensions print on the sheet with honest edge language.
    await (await shown(page, 'preview-document')).click();
    const operation = await shown(page, 'operation-container');
    const firstLogo = operation.locator('article.opsheet-logo').first();
    await expect(firstLogo.locator('ul.opsheet-dims li')).toHaveCount(2);
    const dimTexts = await firstLogo.locator('ul.opsheet-dims li').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    expect(dimTexts).toHaveLength(2);
    expect(dimTexts[0]).toMatch(/^1 — -?[\d.]+ mm — .+, left edge, horizontal( \(extended\))?$/);
    expect(dimTexts[1]).toMatch(/^2 — -?[\d.]+ mm — .+, top edge, vertical( \(extended\))?$/);
    await expect(firstLogo).not.toContainText('to to');
    await expect(firstLogo).not.toContainText('(min-X)');
    await expect(firstLogo).not.toContainText('(max-Y)');
    // Both arrows draw from the evaluated mapping onto the photo, each with
    // visible arrowheads at both ends, witness lines, and one deduped anchor.
    await expect(operation.locator('line.opsheet-arrow')).toHaveCount(2);
    const frontFigure = operation.locator('figure.opsheet-photo').first();
    await expect(firstLogo.locator('h3.opsheet-logo-name')).toHaveText('Synthetic Chest Emblem Extended Product Line for Field Trials');
    await expect(operation.locator('figure.opsheet-photo')).toHaveCount(2);
    await expectExteriorLabels(page, frontFigure);
    await expectArrowheads(page, frontFigure, 2);
    await expect(frontFigure.locator('g.opsheet-anchor-marker')).toHaveCount(1);
    await expect(frontFigure.locator('g.opsheet-anchor-marker')).toContainText('A');
    // One anchor legend maps the code back to the full name.
    await expect(operation.locator('p.opsheet-anchor-key')).toHaveCount(1);
    await expect(operation.locator('p.opsheet-anchor-key').first()).toContainText('A');
    await expect(operation.locator('p.opsheet-anchor-key').first()).toContainText('Anchor 1');
    await page.screenshot({ path: info.outputPath('operation-sheet-two-dims.png'), fullPage: true });

    // Both dimensions export in the focused operator JSON (business data only).
    const download = page.waitForEvent('download');
    await (await shown(page, 'operator-download')).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('operation-sheet-operator.json');
    const downloadPath = await file.path();
    assert.ok(downloadPath, 'operator download path is available');
    const operatorView = JSON.parse(await readFile(downloadPath, 'utf8')) as {
      format: string;
      products: Array<{ logos: Array<{ code: string; measurements: Array<{ anchor: string; logoEdge: string; distanceMm: number }> }> }>;
    };
    expect(operatorView.format).toBe('operation-export/1');
    expect(operatorView.products[0]!.logos[0]!.measurements).toHaveLength(2);
    expect(operatorView.products[0]!.logos[0]!.measurements.every((m) => typeof m.distanceMm === 'number' && m.anchor.length > 0)).toBe(true);

    // Still exactly one A4 landscape page with measured content.
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
    directory = await mkdtemp(join(tmpdir(), 'logotool-sheet-pdf2-'));
    const pdfPath = join(directory, 'operation-sheet-two-dims.pdf');
    await writeFile(pdfPath, pdf);
    await info.attach('operation-sheet-two-dims-pdf', { path: pdfPath, contentType: 'application/pdf' });
    expect(countPdfPages(new Uint8Array(pdf))).toBe(1);

    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('fully configured two-view sheet prints complete with no unfinished items', async ({ browser }, info) => {
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    const pngs = await makePngs(page);
    const { baseline, returned } = await makeReturnBytes(pngs);
    await openCheckWithReturn(page, baseline, returned);

    const openSetup = async (): Promise<void> => {
      await page.evaluate(() => {
        const d = document.querySelector('[data-builder-hook="anchor-disclosure"]');
        if (d instanceof HTMLDetailsElement && !d.open) d.open = true;
      });
    };
    const pickOption = async (hook: string, fragment: string): Promise<void> => {
      const pair = [hook, fragment.toLowerCase()] as [string, string];
      const value = await page.evaluate(([name, frag]: [string, string]) => {
        const sel = document.querySelector<HTMLSelectElement>(`select[data-builder-hook="${name}"]`);
        return Array.from(sel?.options ?? [])
          .find((o) => o.text.toLowerCase().includes(frag) || o.value.toLowerCase().includes(frag))?.value ?? '';
      }, pair);
      assert.ok(value, `setup offers an option matching ${fragment} for ${hook}`);
      await page.locator(`[data-builder-hook="${hook}"]`).selectOption(value);
    };

    // Author department instructions (~220 chars) + job identity.
    await (await shown(page, 'sheet-instructions')).fill(
      'Press the chest emblem at 160°C for 15 seconds with medium pressure, then press the back emblem at 150°C for 12 seconds. Allow the garment to cool flat for one minute and check all four edges visually before packing.',
    );
    await (await shown(page, 'sheet-customer')).fill('Acme Athletics Full');
    await (await shown(page, 'sheet-reference')).fill('FULL-JOB-01');

    // Chest anchor on the front photo.
    await openSetup();
    await pickOption('anchor-side', 'front');
    await pickOption('anchor-region', 'Chest');
    const overlayFront = page.locator('[data-builder-hook="anchor-setup"] svg.anchor-setup-overlay');
    await expect(overlayFront).toBeVisible({ timeout: 15000 });
    await overlayFront.scrollIntoViewIfNeeded();
    await overlayFront.click({ position: { x: 160, y: 128 } });
    await expect(page.getByLabel('Measurement 1 anchor for logo 1')).toContainText('Anchor', { timeout: 15000 });

    // Back anchor on the back photo.
    await pickOption('anchor-side', 'back');
    await pickOption('anchor-region', 'Back');
    const overlayBack = page.locator('[data-builder-hook="anchor-setup"] svg.anchor-setup-overlay');
    await expect(overlayBack).toBeVisible({ timeout: 15000 });
    await overlayBack.scrollIntoViewIfNeeded();
    await overlayBack.click({ position: { x: 160, y: 128 } });
    await expect(page.getByLabel('Measurement 1 anchor for logo 2')).toContainText('Anchor', { timeout: 15000 });
    // Give the back anchor a distinct business name (anchor names are
    // scoped per region; the sheet must name each anchor unambiguously).
    await page.getByLabel(/Name for anchor at/).fill('Pocket top');
    await page.getByLabel(/Name for anchor at/).press('Tab');
    await expect(page.getByLabel('Measurement 1 anchor for logo 2')).toContainText('Pocket top');

    // Explicit business codes: the printed headings show the code alone.
    await page.getByLabel('Business code for logo 1').fill('LOGO-SYN-CHEST-EMB-AK-01');
    await page.getByLabel('Business code for logo 2').fill('LOGO-SYN-BACK-EMB-AK-01');

    // Two measurements on the chest logo (dx + dy).
    await openAdvancedRows(page);
    await page.getByLabel('Measurement 1 anchor for logo 1').selectOption({ label: 'Anchor 1' });
    await page.getByLabel('Add measurement for logo 1').click();
    await openAdvancedRows(page);
    await page.getByLabel('Measurement 2 anchor for logo 1').selectOption({ label: 'Anchor 1' });
    await page.getByLabel('Measurement 2 edge for logo 1').selectOption('maxY');
    await page.getByLabel('Measurement 2 direction for logo 1').selectOption('dy');
    await expect(page.getByLabel('Measurement 2 result for logo 1')).toContainText('mm');

    // Two measurements on the back logo (dx + dy).
    await openAdvancedRows(page);
    await page.getByLabel('Measurement 1 anchor for logo 2').selectOption({ label: 'Pocket top' });
    await page.getByLabel('Add measurement for logo 2').click();
    await openAdvancedRows(page);
    await page.getByLabel('Measurement 2 anchor for logo 2').selectOption({ label: 'Pocket top' });
    await page.getByLabel('Measurement 2 edge for logo 2').selectOption('maxY');
    await page.getByLabel('Measurement 2 direction for logo 2').selectOption('dy');
    await expect(page.getByLabel('Measurement 2 result for logo 2')).toContainText('mm');

    // Fully configured: two mapped composites, four arrows, no unfinished.
    // Three photos are supplied but the left reference hosts no logos and has
    // no mapping: only front+back print (2 figures); left stays internal.
    await (await shown(page, 'preview-document')).click();
    const operation = await shown(page, 'operation-container');
    await expect(operation.locator('.opsheet').first()).toBeVisible();
    await expect(operation.locator('figure.opsheet-photo')).toHaveCount(2);
    await expect(operation.locator('image.opsheet-artwork-overlay')).toHaveCount(2);
    await expect(operation.locator('line.opsheet-arrow')).toHaveCount(4);
    // Business codes print alone (no duplicated full names).
    const headings = await operation.locator('article.opsheet-logo h3.opsheet-logo-name').evaluateAll((els) => els.map((e) => e.textContent));
    expect(headings).toEqual(['LOGO-SYN-CHEST-EMB-AK-01', 'LOGO-SYN-BACK-EMB-AK-01']);
    await expect(operation).not.toContainText('Synthetic Chest Emblem');
    await expect(operation).not.toContainText('Synthetic Back Emblem');
    // One concise dimension line each: value + anchor + edge, no doubled
    // "to to", no technical edge tags.
    const dimLines = await operation.locator('article.opsheet-logo ul.opsheet-dims li').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    expect(dimLines).toHaveLength(4);
    // Dimension refs are unique sheet-wide (1..4), never restarted per logo.
    expect(dimLines.map((line) => line.trim().split(' ')[0])).toEqual(['1', '2', '3', '4']);
    for (const line of dimLines) {
      expect(line).toMatch(/-?\d+\.\d mm — .+, (left|right|top|bottom) edge, (horizontal|vertical)/);
      expect(line.includes('to to')).toBe(false);
      expect(/\(min|max\)-[XY]/.test(line)).toBe(false);
    }
    // Captions are side-only; the trial disclaimer prints exactly once.
    expect(await operation.locator('figure.opsheet-photo figcaption').evaluateAll((els) => els.map((e) => e.textContent))).toEqual(['Front', 'Back']);
    await expect(operation.locator('p.opsheet-trial-note')).toHaveCount(1);
    // The anchor legend maps each short code back to its full name.
    await expect(operation.locator('p.opsheet-anchor-key')).toHaveCount(1);
    await expect(operation.locator('p.opsheet-anchor-key')).toContainText('Anchor 1');
    await expect(operation.locator('p.opsheet-anchor-key')).toContainText('Pocket top');
    await expect(operation.locator('.opsheet-unfinished')).toHaveCount(0);
    await expect(operation.locator('.opsheet-status')).toHaveCount(0);
    // Exterior labels: no long text over photo pixels; arrows carry heads.
    for (const [figureIndex, arrowCount, markerText] of [[0, 2, 'A'], [1, 2, 'B']] as const) {
      const figure = operation.locator('figure.opsheet-photo').nth(figureIndex);
      await expectExteriorLabels(page, figure);
      await expectArrowheads(page, figure, arrowCount);
      await expect(figure.locator('g.opsheet-anchor-marker')).toHaveCount(1);
      await expect(figure.locator('g.opsheet-anchor-marker')).toContainText(markerText);
    }
    await expect(operation).toContainText('Press the chest emblem at 160°C');
    await expect(operation).not.toContainText('Builder trial customer note.');
    await page.screenshot({ path: info.outputPath('operation-sheet-full.png'), fullPage: true });

    // Operator JSON carries the focused payload: business data only, no ids.
    const download = page.waitForEvent('download');
    await (await shown(page, 'operator-download')).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('FULL-JOB-01-operator.json');
    const downloadPath = await file.path();
    assert.ok(downloadPath, 'operator download path is available');
    const operatorView = JSON.parse(await readFile(downloadPath, 'utf8')) as {
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
    const sheetProducts = operatorView.products;
    expect(sheetProducts).toHaveLength(1);
    expect(sheetProducts[0]!.product).toBe('Synthetic Tee');
    expect(sheetProducts[0]!.variant).toBe('Size M');
    const [chestLogo, backLogo] = sheetProducts[0]!.logos;
    expect(chestLogo!.code).toBe('LOGO-SYN-CHEST-EMB-AK-01');
    expect(backLogo!.code).toBe('LOGO-SYN-BACK-EMB-AK-01');
    expect(chestLogo!.measurements).toHaveLength(2);
    expect(backLogo!.measurements).toHaveLength(2);
    for (const measurement of [...chestLogo!.measurements, ...backLogo!.measurements]) {
      expect(typeof measurement.distanceMm).toBe('number');
      expect(Number.isFinite(measurement.distanceMm)).toBe(true);
      expect(measurement.anchor.length).toBeGreaterThan(0);
      expect(measurement.logoEdge.length).toBeGreaterThan(0);
    }
    expect(sheetProducts[0]!.instructions).toEqual([expect.stringContaining('Press the chest emblem')]);
    const serialized = JSON.stringify(operatorView);
    for (const token of ['"logoId"', '"configurationId"', '"frameId"', '"calibrationId"', '"digest"', '"schemaVersion"', '"history"', '"productId"', '"variantId"', '"logoName"', '"sides"', '"sourceNotes"', '"positionText"', '"unfinished"', '"valueMm1"', '"touchesArtwork"', '"artworkPoint"', '"version"', '"revision"', '"status"', 'SYN-LOGO-A', 'SYN-LOGO-C', 'SYN-CFG-TEE-M', 'SYN-TEE-CHEST', 'SYN-TEE-BACK', 'CAL-SYN-001', 'logos/chest.png', 'logos/back.png'] as const) {
      expect(serialized.includes(token), `operator JSON must not leak ${token}`).toBe(false);
    }

    // Still exactly one A4 landscape page when fully configured.
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
    directory = await mkdtemp(join(tmpdir(), 'logotool-sheet-pdf-full-'));
    const pdfPath = join(directory, 'operation-sheet-full.pdf');
    await writeFile(pdfPath, pdf);
    await info.attach('operation-sheet-full-pdf', { path: pdfPath, contentType: 'application/pdf' });
    expect(countPdfPages(new Uint8Array(pdf))).toBe(1);
    const mediaBox = readMediaBox(new Uint8Array(pdf));
    assert.ok(mediaBox, 'PDF carries a MediaBox');
    expect(Math.abs(mediaBox[0] - 841.89)).toBeLessThan(1);
    expect(Math.abs(mediaBox[1] - 595.28)).toBeLessThan(1);

    expectOfflineClean(probe);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test('operation sheet stays readable on a narrow viewport without horizontal overflow', async ({ browser }, info) => {
  const { context, page, probe } = await openBuilder(browser, { width: 390, height: 844 });
  try {
    const pngs = await makePngs(page);
    const { baseline, returned } = await makeReturnBytes(pngs);
    await openCheckWithReturn(page, baseline, returned);
    await (await shown(page, 'preview-document')).click();
    const operation = await shown(page, 'operation-container');
    await expect(operation.locator('.opsheet').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await operation.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('operation-sheet-narrow.png'), fullPage: true });
    expectOfflineClean(probe);
  } finally {
    await context.close();
  }
});
