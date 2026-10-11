import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  addPlacement,
  assertCleanProbe,
  gotoInspector,
  hook,
  ingestGlb,
  openOfflineContext,
  restoreAreaBundle,
  restorePlacementBundle,
  restoreSession,
  savePlacementBundle,
  waitRestoreReady,
} from './helpers.js';
import {
  loadFixtures,
  mutatePlacementBundle,
  parsePlacementBundle,
} from './fixtures.js';

/**
 * placements-drag.spec.ts — direct dragging of planar logo footprints in the
 * inspector 2D mm preview (Phase 6 bounded slice, offline synthetic only).
 *
 * DOM contract (UI worker guarantees; missing selectors fail explicitly):
 * - container `[data-placement-hook="placement-preview2d"]` role="group"
 *   (never role="img") with a clear aria-label.
 * - per region `svg[data-region-id="<id>"]` role="group" with an accessible
 *   label and data-min-y / data-max-y (mm bounds for the y-inversion mapping).
 * - per footprint `[data-placement-id="<id>"]` (attrs on the footprint polygon
 *   itself) tabindex="0" role="button", aria-pressed + data-selected,
 *   accessible name containing id + region, visible and hittable
 *   (fill transparent + pointer-events all, cursor grab, touch-action none).
 * - numeric hooks placement-x/placement-y, status placement-status,
 *   note placement-note stay working (numeric editing is the keyboard
 *   alternative); static drag instructions live in the fragment.
 *
 * Scroll discipline (every test): the preview is scrolled into view before
 * reading geometry or issuing pointer math, and geometry is re-resolved after
 * every export-helper click (Playwright auto-scrolls the clicked export
 * button into view, and focusing a control for keyboard activation scrolls
 * too). Release re-reads its coordinates against the current SVG rectangle
 * and frozen viewBox; pointer math after a scroll MUST re-resolve first.
 *
 * Mid-gesture UI triggers avoid the mouse: with pointer capture held by the
 * preview container, a real locator.click() mid-drag would retarget its
 * down/up through the container and commit (or swallow) the gesture. File
 * inputs (setInputFiles), keyboard fills, and keyboard button activation
 * (focus + Enter) carry no pointer events and leave the gesture undisturbed.
 *
 * Conventions: no network, no fixed sleeps (expect polling / waitForFunction
 * only), synthetic fixtures only, unique screenshot names per test+project.
 *
 * Tolerance: TOL_MM (0.05mm). Pointer px map to mm through the exact same
 * uniform letterbox transform the app uses (same rect, same viewBox, same
 * y-flip), so committed values agree to float rounding; anything looser is
 * called out per test. Nothing here exceeds 0.5mm.
 */
const TOL_MM = 0.05;

interface Seeded {
  context: BrowserContext;
  page: Page;
  probe: { pageErrors: string[]; consoleErrors: string[]; httpRequests: string[] };
  close: () => Promise<void>;
}

async function seedDragScene(
  browser: Browser,
  viewport?: { width: number; height: number },
): Promise<Seeded> {
  const { context, page, probe } = await openOfflineContext(browser, viewport);
  const fixtures = await loadFixtures();
  await gotoInspector(page);
  await ingestGlb(page, fixtures.glbBuffer);
  await restoreSession(page, fixtures.sessionText);
  await restoreAreaBundle(page, fixtures.areaText);
  // A: back region, rotated 30. B: front sibling. C: front, rotated 90.
  await addPlacement(page, {
    logo: 'SYN-LOGO-A',
    region: 'back',
    x: 25,
    y: 25,
    w: 10,
    h: 6,
    rot: 30,
  });
  await addPlacement(page, {
    logo: 'SYN-LOGO-B',
    region: 'front',
    x: 20,
    y: 20,
    w: 10,
    h: 6,
    rot: 45,
  });
  await addPlacement(page, {
    logo: 'SYN-LOGO-A',
    region: 'front',
    x: 80,
    y: 20,
    w: 10,
    h: 6,
    rot: 90,
  });
  await expect(hook(page, 'placement', 'placement-list')).toContainText('PLC-0003');
  return { context, page, probe, close: () => context.close() };
}

async function requireDragContract(page: Page): Promise<void> {
  await hook(page, 'placement', 'placement-preview2d').scrollIntoViewIfNeeded();
  const container = hook(page, 'placement', 'placement-preview2d');
  await expect(
    container,
    'contract: preview2d container [data-placement-hook="placement-preview2d"] is missing',
  ).toBeVisible();
  await expect(
    container,
    'contract: preview2d container MUST be role="group" (never role="img")',
  ).toHaveAttribute('role', 'group');
  for (const regionId of ['back', 'front']) {
    const svg = page.locator(`svg[data-region-id="${regionId}"]`);
    await expect(
      svg,
      `contract: svg[data-region-id="${regionId}"] is missing`,
    ).toBeVisible();
    await expect(
      svg,
      `contract: svg[data-region-id="${regionId}"] MUST expose data-min-y/data-max-y`,
    ).toHaveAttribute('data-min-y', /.+/);
    await expect(
      svg,
      `contract: svg[data-region-id="${regionId}"] MUST expose data-min-y/data-max-y`,
    ).toHaveAttribute('data-max-y', /.+/);
  }
  for (const id of ['PLC-0001', 'PLC-0002', 'PLC-0003']) {
    const fp = page.locator(`[data-placement-id="${id}"]`);
    await expect(
      fp,
      `contract: footprint [data-placement-id="${id}"] is missing`,
    ).toBeVisible();
    await expect(
      fp,
      `contract: footprint ${id} MUST be focusable (tabindex 0)`,
    ).toHaveAttribute('tabindex', '0');
    await expect(
      fp,
      `contract: footprint ${id} MUST be role="button"`,
    ).toHaveAttribute('role', 'button');
    const label = await fp.getAttribute('aria-label');
    expect(
      label,
      `contract: footprint ${id} accessible name MUST contain id + region`,
    ).toMatch(new RegExp(`${id}.+(back|front)`));
  }
}

/**
 * Export via the repo helper, then re-scroll: the helper's click
 * auto-scrolls the calibration export button into view, invalidating any
 * previously resolved pointer geometry.
 */
async function saveThenRescroll(page: Page): Promise<string> {
  const text = await savePlacementBundle(page);
  await hook(page, 'placement', 'placement-preview2d').scrollIntoViewIfNeeded();
  return text;
}

/** Uniform px-per-mm scale of a letterboxed mm svg + rendered offsets. */
async function svgScale(page: Page, regionId: string): Promise<{ s: number }> {
  await hook(page, 'placement', 'placement-preview2d').scrollIntoViewIfNeeded();
  return page.evaluate((rid) => {
    const svg = document.querySelector(
      `svg[data-region-id="${rid}"]`,
    ) as SVGSVGElement | null;
    if (!svg) throw new Error(`svg[data-region-id="${rid}"] missing`);
    const vb = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const s = Math.min(rect.width / vb.width, rect.height / vb.height);
    if (!Number.isFinite(s) || s <= 0) throw new Error('non-finite svg scale');
    return { s };
  }, regionId);
}

/** Scroll the footprint into view, then re-resolve its viewport centre. */
async function footprintCentre(
  page: Page,
  id: string,
): Promise<{ x: number; y: number }> {
  const fp = page.locator(`[data-placement-id="${id}"]`);
  await fp.scrollIntoViewIfNeeded();
  const box = await fp.boundingBox();
  expect(box, `footprint ${id} has no bounding box`).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/**
 * Punctuation-id geometry without CSS escaping: match by attribute equality
 * in-page (ids containing quotes/backslashes would need escaping in a
 * `[data-placement-id="..."]` selector; equality needs none).
 */
async function footprintCentreByAttr(
  page: Page,
  id: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate((wanted) => {
    const els = Array.from(document.querySelectorAll('[data-placement-id]'));
    const el = els.find((e) => e.getAttribute('data-placement-id') === wanted);
    if (!el) throw new Error(`footprint ${wanted} missing`);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0)
      throw new Error(`footprint ${wanted} has no rendered box`);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
}

/**
 * Export without touching the mouse: keyboard activation (focus + Enter)
 * fires the same download handler as a click but carries no pointer events,
 * so an active pointer-capture drag is left undisturbed. Needed for
 * mid-gesture exports — a real locator.click() mid-drag would retarget its
 * down/up through the capturing preview container and commit the gesture
 * before the download handler runs. Focus uses preventScroll so the preview
 * geometry resolved before the gesture stays valid; the caller re-scrolls
 * after release.
 */
async function saveViaKeyboard(page: Page): Promise<string> {
  const button = hook(page, 'calibration', 'placement-export-button');
  await expect(button, 'export must stay enabled during a drag').toBeEnabled();
  await button.evaluate((el) => {
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  });
  await expect(button, 'export must stay focused').toBeFocused();
  const event = page.waitForEvent('download');
  await button.press('Enter');
  const download = await event;
  const path = await download.path();
  if (path === null) throw new Error('Download path unavailable.');
  return readFile(path, 'utf8');
}

/** Polling numeric-field assertion (fields update on pointermove delivery). */
async function expectFieldsNear(
  page: Page,
  wantX: number,
  wantY: number,
  tol: number,
  label: string,
): Promise<void> {
  await expect(async () => {
    const xText = await hook(page, 'placement', 'placement-x').inputValue();
    const yText = await hook(page, 'placement', 'placement-y').inputValue();
    expect(
      Math.abs(Number(xText) - wantX),
      `${label}: placement-x ${xText} far from ${wantX}`,
    ).toBeLessThan(tol);
    expect(
      Math.abs(Number(yText) - wantY),
      `${label}: placement-y ${yText} far from ${wantY}`,
    ).toBeLessThan(tol);
  }).toPass();
}

/**
 * Record the gesture's real pointerId: a one-shot pointerdown listener on
 * the preview container captures it before mouse.down(). Synthetic events
 * below reuse this id — never pointerId 0.
 */
async function armPointerIdCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __dragPid?: number | null };
    w.__dragPid = null;
    document
      .querySelector('[data-placement-hook="placement-preview2d"]')
      ?.addEventListener(
        'pointerdown',
        (e) => {
          if (e instanceof PointerEvent) w.__dragPid = e.pointerId;
        },
        { once: true },
      );
  });
}

async function readPointerId(page: Page): Promise<number> {
  const pid = await page.evaluate(
    () => (window as unknown as { __dragPid?: number | null }).__dragPid,
  );
  if (typeof pid !== 'number')
    throw new Error('gesture pointerId was not captured');
  return pid;
}

async function shoot(page: Page, name: string): Promise<void> {
  await hook(page, 'placement', 'placement-preview2d').scrollIntoViewIfNeeded();
  const shot = await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  await test.info().attach(`${name}-${test.info().project.name}`, {
    body: shot,
    contentType: 'image/png',
  });
}

test('drag: basic move commits mm delta, fields + verdict update', async ({
  browser,
}) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    const beforeText = await saveThenRescroll(page);
    const before = parsePlacementBundle(beforeText);
    const aBefore = before.placements[0]!;
    const { s } = await svgScale(page, 'back');
    // Known mm delta: +8mm x, +4mm y. Screen y grows down while mm y grows
    // up, so the pointer must move up for +y.
    const dxMm = 8;
    const dyMm = 4;
    const dxPx = dxMm * s;
    const dyPx = -dyMm * s;
    const start = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dxPx / 2, start.y + dyPx / 2, { steps: 4 });
    // DURING the drag (before release): live fields track the halfway
    // candidate while committed bytes stay at baseline.
    await expectFieldsNear(
      page,
      aBefore.xMm + dxMm / 2,
      aBefore.yMm + dyMm / 2,
      TOL_MM,
      'mid-drag fields',
    );
    await expect(
      hook(page, 'placement', 'placement-status'),
      'mid-drag status still names the dragged placement',
    ).toContainText('PLC-0001');
    expect(
      await saveViaKeyboard(page),
      'mid-drag export MUST yield baseline (candidate is uncommitted)',
    ).toBe(beforeText);
    // Continue the SAME gesture (no release: release would commit) to the
    // full delta. Keyboard focus used preventScroll, so the held pointer
    // geometry is still valid.
    await page.mouse.move(start.x + dxPx, start.y + dyPx, { steps: 8 });
    // Pre-release: fields track the full candidate.
    await expectFieldsNear(
      page,
      aBefore.xMm + dxMm,
      aBefore.yMm + dyMm,
      TOL_MM,
      'pre-release fields',
    );
    await page.mouse.up();
    // Numeric fields reflect the commit; verdict names the placement + fits.
    await expectFieldsNear(
      page,
      aBefore.xMm + dxMm,
      aBefore.yMm + dyMm,
      TOL_MM,
      'committed fields',
    );
    const first = await saveThenRescroll(page);
    expect(
      await saveThenRescroll(page),
      'export MUST be deterministic (save twice byte-equal)',
    ).toBe(first);
    const after = parsePlacementBundle(first);
    const aAfter = after.placements[0]!;
    expect(Math.abs(aAfter.xMm - (aBefore.xMm + dxMm))).toBeLessThan(TOL_MM);
    expect(Math.abs(aAfter.yMm - (aBefore.yMm + dyMm))).toBeLessThan(TOL_MM);
    // Untouched aspects of A + siblings unchanged.
    expect(aAfter.widthMm).toBe(aBefore.widthMm);
    expect(aAfter.heightMm).toBe(aBefore.heightMm);
    expect(aAfter.rotationDeg).toBe(aBefore.rotationDeg);
    expect(aAfter.logoId).toBe(aBefore.logoId);
    expect(aAfter.regionId).toBe(aBefore.regionId);
    expect(after.placements[1]).toEqual(before.placements[1]);
    expect(after.placements[2]).toEqual(before.placements[2]);
    const statusText = await hook(
      page,
      'placement',
      'placement-status',
    ).innerText();
    expect(statusText).toMatch(/PLC-0001/);
    expect(statusText).toMatch(/fits/);
    await expect(hook(page, 'placement', 'placement-note')).toContainText(
      /moved \(draft only\)/,
    );
    await shoot(page, 'drag-basic');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});

test('drag: letterboxed mapping stays correct on small viewport', async ({
  browser,
}) => {
  // Mobile viewport exercises heavy letterboxing of the mm svg.
  const seeded = await seedDragScene(browser, { width: 390, height: 844 });
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    await page.evaluate(() => {
      const el = document.querySelector(
        '[data-placement-hook="placement-preview2d"]',
      ) as HTMLElement | null;
      if (el) el.style.setProperty('max-width', '220px');
    });
    await expect(page.locator('svg[data-region-id="front"]')).toBeVisible();
    const before = parsePlacementBundle(await saveThenRescroll(page));
    const bBefore = before.placements[1]!;
    const { s } = await svgScale(page, 'front');
    const dxMm = 3;
    const start = await footprintCentre(page, 'PLC-0002');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + (dxMm * s) / 2, start.y, { steps: 3 });
    // DURING the drag: fields track the halfway candidate.
    await expectFieldsNear(
      page,
      bBefore.xMm + dxMm / 2,
      bBefore.yMm,
      0.1,
      'letterbox mid-drag fields',
    );
    await page.mouse.move(start.x + dxMm * s, start.y, { steps: 5 });
    await expectFieldsNear(
      page,
      bBefore.xMm + dxMm,
      bBefore.yMm,
      0.1,
      'letterbox pre-release fields',
    );
    await page.mouse.up();
    const first = await saveThenRescroll(page);
    expect(
      await saveThenRescroll(page),
      'letterbox export MUST be deterministic',
    ).toBe(first);
    const after = parsePlacementBundle(first);
    // 0.1mm (not 0.05): the 220px-wide letterboxed svg resolves sub-pixel
    // centres through boundingBox, adding one extra rounding step.
    expect(
      Math.abs(after.placements[1]!.xMm - (bBefore.xMm + dxMm)),
    ).toBeLessThan(0.1);
    expect(Math.abs(after.placements[1]!.yMm - bBefore.yMm)).toBeLessThan(0.1);
    expect(after.placements[0]).toEqual(before.placements[0]);
    expect(after.placements[2]).toEqual(before.placements[2]);
    await shoot(page, 'drag-letterbox');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});

test('drag: off-centre grab preserves grab offset', async ({ browser }) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    const before = parsePlacementBundle(await saveThenRescroll(page));
    const aBefore = before.placements[0]!;
    const { s } = await svgScale(page, 'back');
    const fp = page.locator('[data-placement-id="PLC-0001"]');
    await fp.scrollIntoViewIfNeeded();
    const box = await fp.boundingBox();
    expect(box, 'footprint PLC-0001 has no bounding box').not.toBeNull();
    // Grab inside the footprint but away from its centre.
    const grab = { x: box!.x + box!.width * 0.25, y: box!.y + box!.height * 0.3 };
    const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    const grabOffset = { x: grab.x - centre.x, y: grab.y - centre.y };
    expect(
      Math.abs(grabOffset.x) + Math.abs(grabOffset.y),
      'grab point must be off-centre for this test',
    ).toBeGreaterThan(1);
    // Move the pointer by a known px delta; the centre must translate by the
    // pointer-mm delta (grab offset preserved), not snap to the pointer.
    const dxPx = 6 * s;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + dxPx, grab.y, { steps: 6 });
    await expectFieldsNear(
      page,
      aBefore.xMm + 6,
      aBefore.yMm,
      TOL_MM,
      'grab-offset pre-release fields',
    );
    await page.mouse.up();
    const first = await saveThenRescroll(page);
    expect(
      await saveThenRescroll(page),
      'grab-offset export MUST be deterministic',
    ).toBe(first);
    const after = parsePlacementBundle(first);
    expect(Math.abs(after.placements[0]!.xMm - (aBefore.xMm + 6))).toBeLessThan(
      TOL_MM,
    );
    expect(Math.abs(after.placements[0]!.yMm - aBefore.yMm)).toBeLessThan(
      TOL_MM,
    );
    expect(after.placements[1]).toEqual(before.placements[1]);
    expect(after.placements[2]).toEqual(before.placements[2]);
    await shoot(page, 'drag-graboffset');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});

test('drag: rotated placement out of safe bounds, multi-step x+y deltas', async ({
  browser,
}) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    // Front safe polygon cut-out: the x40-60/y40-100 notch is outside the
    // safe area. Dragging rotated PLC-0003 (80,20) to (50,70) in several
    // steps leaves the safe polygon; both axes assert precisely.
    const before = parsePlacementBundle(await saveThenRescroll(page));
    const cBefore = before.placements[2]!;
    const { s } = await svgScale(page, 'front');
    const dxMm = 50 - cBefore.xMm;
    const dyMm = 70 - cBefore.yMm;
    const dxPx = dxMm * s;
    const dyPx = -dyMm * s;
    const start = await footprintCentre(page, 'PLC-0003');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const STEPS = 6;
    for (let i = 1; i <= STEPS; i += 1) {
      await page.mouse.move(
        start.x + (dxPx * i) / STEPS,
        start.y + (dyPx * i) / STEPS,
        { steps: 2 },
      );
      if (i === 3) {
        await expectFieldsNear(
          page,
          cBefore.xMm + dxMm / 2,
          cBefore.yMm + dyMm / 2,
          TOL_MM,
          'multi-step mid-drag fields',
        );
      }
    }
    // Pre-release: live fields carry the full out-of-safe candidate, both
    // axes; committed bytes are asserted only after release.
    await expectFieldsNear(
      page,
      cBefore.xMm + dxMm,
      cBefore.yMm + dyMm,
      TOL_MM,
      'multi-step pre-release fields',
    );
    await page.mouse.up();
    const statusText = await hook(
      page,
      'placement',
      'placement-status',
    ).innerText();
    expect(statusText).toMatch(/PLC-0003/);
    expect(statusText).toMatch(/does not fit/);
    const stroke = await page
      .locator('[data-placement-id="PLC-0003"]')
      .evaluate((el) => getComputedStyle(el).stroke || el.getAttribute('stroke'));
    expect(String(stroke ?? '').toLowerCase()).toMatch(/red|255,\s*0,\s*0|ff0000/);
    const first = await saveThenRescroll(page);
    expect(
      await saveThenRescroll(page),
      'out-of-safe export MUST be deterministic',
    ).toBe(first);
    const after = parsePlacementBundle(first);
    expect(after.placements[2]!.rotationDeg).toBe(90);
    expect(Math.abs(after.placements[2]!.xMm - 50)).toBeLessThan(TOL_MM);
    expect(Math.abs(after.placements[2]!.yMm - 70)).toBeLessThan(TOL_MM);
    // Sibling unaffected.
    expect(after.placements[0]).toEqual(before.placements[0]);
    expect(after.placements[1]).toEqual(before.placements[1]);
    await shoot(page, 'drag-validation');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});

test('drag: Escape cancels to baseline with note, then re-drag commits', async ({
  browser,
}) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    const baseline = await saveThenRescroll(page);
    const baselineParsed = parsePlacementBundle(baseline);
    const aBefore = baselineParsed.placements[0]!;
    const { s } = await svgScale(page, 'back');
    const start = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 10 * s, start.y, { steps: 5 });
    // The candidate is live in the fields before cancellation.
    await expect(hook(page, 'placement', 'placement-x')).not.toHaveValue(
      String(aBefore.xMm),
    );
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(
      await saveThenRescroll(page),
      'Escape mid-drag MUST restore baseline bytes',
    ).toBe(baseline);
    await expect(hook(page, 'placement', 'placement-note')).toContainText(
      /cancel/i,
    );
    // The panel accepts a new gesture after the cancellation: a fresh drag
    // commits its delta.
    const { s: s2 } = await svgScale(page, 'back');
    const restart = await footprintCentre(page, 'PLC-0001');
    const dxMm = 4;
    await page.mouse.move(restart.x, restart.y);
    await page.mouse.down();
    await page.mouse.move(restart.x + dxMm * s2, restart.y, { steps: 5 });
    await page.mouse.up();
    const after = parsePlacementBundle(await saveThenRescroll(page));
    expect(
      Math.abs(after.placements[0]!.xMm - (aBefore.xMm + dxMm)),
    ).toBeLessThan(TOL_MM);
    expect(Math.abs(after.placements[0]!.yMm - aBefore.yMm)).toBeLessThan(
      TOL_MM,
    );
    await shoot(page, 'drag-cancel-escape');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});

test('drag: pointercancel + wrong-button/non-primary never mutate', async ({
  browser,
}) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    const baseline = await saveThenRescroll(page);
    const { s } = await svgScale(page, 'back');

    // (a) pointercancel path: cancel mid-gesture restores baseline. A genuine
    // OS-level pointercancel is not producible for a headless mouse, so the
    // event is dispatched — but with the gesture's REAL captured pointerId,
    // never pointerId 0.
    const start = await footprintCentre(page, 'PLC-0001');
    await armPointerIdCapture(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 8 * s, start.y, { steps: 4 });
    const pid = await readPointerId(page);
    await page.evaluate((realPid) => {
      const init = {
        bubbles: true,
        isPrimary: true,
        pointerId: realPid,
        pointerType: 'mouse',
      };
      const fp = document.querySelector('[data-placement-id="PLC-0001"]');
      const container = document.querySelector(
        '[data-placement-hook="placement-preview2d"]',
      );
      for (const target of [fp, container]) {
        target?.dispatchEvent(new PointerEvent('pointercancel', init));
      }
    }, pid);
    await page.mouse.up();
    expect(
      await saveThenRescroll(page),
      'pointercancel mid-drag MUST restore baseline bytes',
    ).toBe(baseline);
    await expect(hook(page, 'placement', 'placement-note')).toContainText(
      /cancel/i,
    );

    // (b) right-button pointerdown must not start a drag.
    const reResolved = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(reResolved.x, reResolved.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(reResolved.x + 40, reResolved.y, { steps: 3 });
    await page.mouse.up({ button: 'right' });
    expect(
      await saveThenRescroll(page),
      'right-button drag MUST NOT mutate placements',
    ).toBe(baseline);

    // (c) non-primary pointerdown must not start a drag.
    await page.evaluate(() => {
      const fp = document.querySelector('[data-placement-id="PLC-0001"]');
      fp?.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          isPrimary: false,
          button: 0,
          clientX: 100,
          clientY: 100,
          pointerId: 999,
          pointerType: 'touch',
        }),
      );
      document.querySelector('[data-placement-hook="placement-preview2d"]')
        ?.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            isPrimary: false,
            button: 0,
            clientX: 200,
            clientY: 100,
            pointerId: 999,
            pointerType: 'touch',
          }),
        );
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          isPrimary: false,
          button: 0,
          clientX: 200,
          clientY: 100,
          pointerId: 999,
          pointerType: 'touch',
        }),
      );
    });
    expect(
      await saveThenRescroll(page),
      'non-primary pointer sequence MUST NOT mutate placements',
    ).toBe(baseline);
    await shoot(page, 'drag-cancel-paths');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});

test('drag: real lostpointercapture + focus-loss handler cancel, then re-drag', async ({
  browser,
}) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    const baseline = await saveThenRescroll(page);
    const baselineParsed = parsePlacementBundle(baseline);
    const aBefore = baselineParsed.placements[0]!;
    const { s } = await svgScale(page, 'back');

    // (a) REAL lostpointercapture: releasePointerCapture only clears PENDING
    // capture — the browser fires lostpointercapture before the NEXT pointer
    // event (W3C Pointer Events 3 §4.1.3.2, §9.3). No synthetic dispatch.
    const start = await footprintCentre(page, 'PLC-0001');
    await armPointerIdCapture(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 8 * s, start.y, { steps: 4 });
    const pid = await readPointerId(page);
    const hadCapture = await page.evaluate((realPid) => {
      const el = document.querySelector<HTMLElement>(
        '[data-placement-hook="placement-preview2d"]',
      );
      try {
        return el?.hasPointerCapture(realPid) ?? false;
      } catch {
        return false;
      }
    }, pid);
    expect(hadCapture, 'gesture MUST hold real pointer capture').toBe(true);
    await page.evaluate((realPid) => {
      document
        .querySelector<HTMLElement>(
          '[data-placement-hook="placement-preview2d"]',
        )
        ?.releasePointerCapture(realPid);
    }, pid);
    // The release only clears PENDING capture: the browser fires a genuine
    // lostpointercapture before the NEXT pointer event (W3C Pointer Events 3
    // §4.1.3.2, §9.3). This held-button move drives that real loss through
    // the panel handler (no synthetic dispatch, no sleeps).
    await page.mouse.move(start.x + 8 * s + 1, start.y, { steps: 1 });
    await expect(hook(page, 'placement', 'placement-note')).toContainText(
      /capture lost/,
    );
    await page.mouse.up();
    expect(
      await saveThenRescroll(page),
      'lostpointercapture mid-drag MUST restore baseline bytes',
    ).toBe(baseline);
    await expect(hook(page, 'placement', 'placement-note')).toContainText(
      /capture lost/,
    );

    // (b) REAL window blur via a second same-context page: bringing another
    // page to front moves browser focus and fires a genuine window blur on
    // the inspector page (window.blur() is a no-op in headless). The helper
    // page closes afterwards; focus returning never resurrects the drag.
    const { s: s2 } = await svgScale(page, 'back');
    const restart = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(restart.x, restart.y);
    await page.mouse.down();
    await page.mouse.move(restart.x + 6 * s2, restart.y, { steps: 4 });
    const helper = await seeded.context.newPage();
    await helper.goto('about:blank');
    await helper.bringToFront();
    // Headless focus transitions may not blur the page; if the genuine path
    // did not fire within a short window, drive the same handler through a
    // dispatched blur (handler-level coverage, labelled as such).
    const blurred = await page
      .waitForFunction(
        () =>
          document
            .querySelector('[data-placement-hook="placement-note"]')
            ?.textContent?.toLowerCase()
            .includes('lost focus') === true,
        undefined,
        { timeout: 3000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!blurred) {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    }
    await test.info().attach('focus-loss-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        mode: blurred ? 'browser-focus-transition' : 'dispatched-blur-handler',
        osLevelFocusLossVerified: false,
      }, null, 2),
    });
    await expect(hook(page, 'placement', 'placement-note')).toContainText(
      /lost focus/,
    );
    await page.mouse.up();
    await helper.close();
    await page.bringToFront();
    expect(
      await saveThenRescroll(page),
      'window blur mid-drag MUST restore baseline bytes',
    ).toBe(baseline);
    await expect(hook(page, 'placement', 'placement-note')).toContainText(
      /lost focus/,
    );

    // The panel accepts a new gesture after both cancellations.
    const { s: s3 } = await svgScale(page, 'back');
    const third = await footprintCentre(page, 'PLC-0001');
    const dxMm = 5;
    await page.mouse.move(third.x, third.y);
    await page.mouse.down();
    await page.mouse.move(third.x + dxMm * s3, third.y, { steps: 5 });
    await page.mouse.up();
    const after = parsePlacementBundle(await saveThenRescroll(page));
    expect(
      Math.abs(after.placements[0]!.xMm - (aBefore.xMm + dxMm)),
    ).toBeLessThan(TOL_MM);
    expect(Math.abs(after.placements[0]!.yMm - aBefore.yMm)).toBeLessThan(
      TOL_MM,
    );
    await shoot(page, 'drag-cancel-capture-blur');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});

test('drag: mid-drag invalidation aborts late commit', async ({ browser }) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  const fixtures = await loadFixtures();
  try {
    await requireDragContract(page);
    const baseline = await saveThenRescroll(page);
    const productBefore = await hook(
      page,
      'calibration',
      'product-id',
    ).inputValue();
    expect(productBefore.trim(), 'seeded product-id must be non-empty').not.toBe(
      '',
    );

    // (a) Stale product-id lock mid-gesture (evaluate-set + input event:
    // no pointer events, so the held drag stays alive while the host's
    // input→render path marks the fit stale). Late pointerup must not apply.
    const { s } = await svgScale(page, 'back');
    const start = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 6 * s, start.y, { steps: 3 });
    await page.evaluate(() => {
      const input = document.querySelector(
        '[data-calibration-hook="product-id"]',
      );
      if (!(input instanceof HTMLInputElement)) throw new Error('product-id missing');
      input.focus({ preventScroll: true });
      input.value = 'STALE';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(
      hook(page, 'calibration', 'placement-export-button'),
    ).toBeDisabled();
    await page.mouse.up();
    await expect(hook(page, 'placement', 'placement-context')).toContainText(
      /stale/i,
    );
    await page.evaluate((back) => {
      const input = document.querySelector(
        '[data-calibration-hook="product-id"]',
      );
      if (!(input instanceof HTMLInputElement)) throw new Error('product-id missing');
      input.focus({ preventScroll: true });
      input.value = back;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, productBefore);
    await expect(
      hook(page, 'calibration', 'placement-export-button'),
    ).toBeEnabled();
    await hook(page, 'placement', 'placement-preview2d').scrollIntoViewIfNeeded();
    expect(
      await saveThenRescroll(page),
      'late pointerup after stale invalidation MUST NOT apply (bytes unchanged)',
    ).toBe(baseline);

    // (b) restoreBusy DURING an active drag: the restore file read holds the
    // busy lock mid-gesture (placements-race covers the lock outside
    // gestures; this covers it under one). The file input is set BEFORE the
    // gesture starts (setInputFiles carries no pointer events and never
    // disturbs a later drag); the button is then activated by keyboard
    // (Space on a type=button fires click with no pointer events), so the
    // gesture is undisturbed. Late pointerup must not apply.
    await hook(page, 'calibration', 'placement-restore-file').setInputFiles({
      name: 'placement-bundle.json',
      mimeType: 'application/json',
      buffer: Buffer.from(baseline),
    });
    const { s: sb } = await svgScale(page, 'back');
    const dragStart = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 8 * sb, dragStart.y, { steps: 4 });
    const restoreButton = hook(
      page,
      'calibration',
      'placement-restore-button',
    );
    await restoreButton.evaluate((el) => {
      if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    });
    await restoreButton.press(' ');
    // The small bundle restores fast: either the busy lock is still held
    // (editor disabled) or the atomic swap already landed (editor enabled,
    // generation bumped). Both invalidate the gesture — the late pointerup
    // must not apply either way. Branch on the observed lock state.
    const sawBusy = await hook(page, 'placement', 'placement-x')
      .isDisabled()
      .catch(() => false);
    if (sawBusy) {
      await expect(
        hook(page, 'calibration', 'placement-export-button'),
        'restore must hold the busy lock mid-gesture',
      ).toBeDisabled();
      // Keep the gesture alive across the busy window, then release: the
      // restore swaps the draft (generation bump), so the late pointerup
      // must not apply.
      await page.mouse.move(dragStart.x + 10 * sb, dragStart.y, { steps: 2 });
      await waitRestoreReady(page, 'placement-restore-button');
      await expect(
        hook(page, 'calibration', 'placement-export-button'),
      ).toBeEnabled();
    }
    await expect(
      hook(page, 'calibration', 'placement-export-button'),
    ).toBeEnabled();
    await page.mouse.up();
    await hook(page, 'placement', 'placement-preview2d').scrollIntoViewIfNeeded();
    // The restore replaced the draft with the baseline text AND bumped the
    // generation; a late commit of the moved candidate would differ, so
    // equality proves the late pointerup never applied.
    expect(
      await saveThenRescroll(page),
      'late pointerup across a restoreBusy window MUST NOT apply',
    ).toBe(baseline);

    // (c) Asset replacement mid-gesture: ingesting a different VALID asset
    // resets the placement draft (generation bump, gesture cleared).
    // synthetic-tetra.glb validates clean (zero errors/warnings); a
    // byte-flipped variant instead trips ACCESSOR_INDEX_OOB rejection, so it
    // must never be used here. setInputFiles carries no pointer events, so
    // the held gesture is undisturbed; the late pointerup must not commit
    // anywhere. Then re-seed and prove recovery with a fresh committing drag.
    const tetra = await readFile('examples/models/synthetic-tetra.glb');
    const { s: sc } = await svgScale(page, 'back');
    const swapStart = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(swapStart.x, swapStart.y);
    await page.mouse.down();
    await page.mouse.move(swapStart.x + 8 * sc, swapStart.y, { steps: 4 });
    await hook(page, 'inspector', 'file-input').setInputFiles({
      name: 'synthetic-tetra.glb',
      mimeType: 'model/gltf-binary',
      buffer: tetra,
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-inspector-hook="status"]')
          ?.textContent?.startsWith('Showing') === true,
    );
    await page.mouse.up();
    await hook(page, 'placement', 'placement-preview2d').scrollIntoViewIfNeeded();
    await expect(
      hook(page, 'calibration', 'placement-export-button'),
    ).toBeDisabled();
    await expect(hook(page, 'placement', 'placement-list')).toContainText(
      /No placements/,
    );
    // Re-seed the original scene and restore the baseline bundle. The
    // mouse button is still held from the swap gesture: release it BEFORE
    // re-seeding (a held button turns every helper click into a drag leg).
    // The swap already cleared the gesture, so this release is inert.
    await page.mouse.up();
    await ingestGlb(page, fixtures.glbBuffer);
    await restoreSession(page, fixtures.sessionText);
    await restoreAreaBundle(page, fixtures.areaText);
    await restorePlacementBundle(page, baseline);
    await requireDragContract(page);
    expect(
      await saveThenRescroll(page),
      're-seeded scene MUST equal the pre-swap baseline',
    ).toBe(baseline);
    // Fresh gesture post-invalidation commits.
    const { s: sd } = await svgScale(page, 'back');
    const fresh = await footprintCentre(page, 'PLC-0001');
    const dxMm = 2;
    await page.mouse.move(fresh.x, fresh.y);
    await page.mouse.down();
    await page.mouse.move(fresh.x + dxMm * sd, fresh.y, { steps: 4 });
    await page.mouse.up();
    const after = parsePlacementBundle(await saveThenRescroll(page));
    const aBefore = parsePlacementBundle(baseline).placements[0]!;
    expect(
      Math.abs(after.placements[0]!.xMm - (aBefore.xMm + dxMm)),
    ).toBeLessThan(TOL_MM);

    await shoot(page, 'drag-invalidation');
    assertCleanProbe(probe);
    expect(
      baseline,
      'baseline sanity: seeded bundle MUST hold 3 placements',
    ).toMatch(/PLC-0003/);
  } finally {
    await seeded.close();
  }
});

test('drag: mid-drag export yields baseline; save/restore roundtrips', async ({
  browser,
}) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    const aSeeded = parsePlacementBundle(await saveThenRescroll(page))
      .placements[0]!;
    // Commit a drag, then prove determinism + roundtrip.
    const { s } = await svgScale(page, 'back');
    const dxMm = 8;
    const dyMm = 4;
    const start = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dxMm * s, start.y - dyMm * s, { steps: 8 });
    await page.mouse.up();
    const committed = await saveThenRescroll(page);
    expect(
      await saveThenRescroll(page),
      'committed export MUST be deterministic (save twice byte-equal)',
    ).toBe(committed);
    const cAfter = parsePlacementBundle(committed).placements[0]!;
    expect(Math.abs(cAfter.xMm - (aSeeded.xMm + dxMm))).toBeLessThan(TOL_MM);
    expect(Math.abs(cAfter.yMm - (aSeeded.yMm + dyMm))).toBeLessThan(TOL_MM);

    // Same-page restore roundtrip.
    await restorePlacementBundle(page, committed);
    await requireDragContract(page);
    expect(
      await saveThenRescroll(page),
      'same-page restore MUST roundtrip byte-equal',
    ).toBe(committed);

    // Fresh-context reopen of the same bytes (placements-restore.spec.ts
    // convention: ingest + restore placement bundle, no session/area needed).
    const second = await openOfflineContext(browser);
    try {
      const fixtures = await loadFixtures();
      await gotoInspector(second.page);
      await ingestGlb(second.page, fixtures.glbBuffer);
      await restorePlacementBundle(second.page, committed);
      expect(
        await savePlacementBundle(second.page),
        'fresh-context restore MUST roundtrip byte-equal',
      ).toBe(committed);
      assertCleanProbe(second.probe);
    } finally {
      await second.context.close();
    }

    // Export DURING a new gesture yields the pre-drag (committed) bytes;
    // release then commits the delta on top.
    const { s: s2 } = await svgScale(page, 'back');
    const preDrag = parsePlacementBundle(await saveThenRescroll(page))
      .placements[0]!;
    const mid = await footprintCentre(page, 'PLC-0001');
    const dx2 = 3;
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(mid.x + dx2 * s2, mid.y, { steps: 5 });
    expect(
      await saveViaKeyboard(page),
      'mid-gesture save MUST yield pre-drag bytes',
    ).toBe(committed);
    await page.mouse.up();
    const first = await saveThenRescroll(page);
    expect(
      await saveThenRescroll(page),
      'post-release export MUST be deterministic',
    ).toBe(first);
    expect(first, 'release MUST commit a delta over the mid-drag save').not.toBe(
      committed,
    );
    const mAfter = parsePlacementBundle(first).placements[0]!;
    expect(Math.abs(mAfter.xMm - (preDrag.xMm + dx2))).toBeLessThan(TOL_MM);
    expect(Math.abs(mAfter.yMm - preDrag.yMm)).toBeLessThan(TOL_MM);
    await shoot(page, 'drag-roundtrip');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});
test('drag: out-of-limit release never mutates; release without move preserves centre', async ({
  browser,
}) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    const baseline = await saveThenRescroll(page);
    const aBefore = parsePlacementBundle(baseline).placements[0]!;
    const { s } = await svgScale(page, 'back');

    // (a) Drag far past the core coordinate limit (+1,000,000mm): the move
    // gate ignores out-of-limit points, so the fields keep tracking the last
    // good candidate and release commits nothing beyond the limit.
    const start = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 50 * s, start.y, { steps: 3 });
    const midX = Number(await hook(page, 'placement', 'placement-x').inputValue());
    expect(
      Math.abs(midX - (aBefore.xMm + 50)),
      'in-limit move MUST track the candidate live',
    ).toBeLessThan(TOL_MM);
    // Now fling far beyond maxCoordMm in a single jump: the gate must ignore
    // it (fields stay at the last good candidate, no crash, no mutation).
    await page.mouse.move(start.x + 2_000_000 * s, start.y, { steps: 1 });
    const heldX = Number(await hook(page, 'placement', 'placement-x').inputValue());
    expect(
      Math.abs(heldX - (aBefore.xMm + 50)),
      'out-of-limit jump MUST NOT reach the fields',
    ).toBeLessThan(TOL_MM);
    await page.mouse.up();
    const afterFling = parsePlacementBundle(await saveThenRescroll(page));
    expect(
      Math.abs(afterFling.placements[0]!.xMm - (aBefore.xMm + 50)),
      'out-of-limit release MUST fall back to the last good candidate',
    ).toBeLessThan(TOL_MM);

    // (b) Down + up with no move: release applies the down-anchored candidate
    // (baseline centre preserved through the grab offset), not a zero move.
    const bBefore = parsePlacementBundle(await saveThenRescroll(page)).placements[0]!;
    const centre = await footprintCentre(page, 'PLC-0001');
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.up();
    const afterTap = parsePlacementBundle(await saveThenRescroll(page));
    expect(
      Math.abs(afterTap.placements[0]!.xMm - bBefore.xMm),
      'tap release MUST preserve centre x',
    ).toBeLessThan(TOL_MM);
    expect(
      Math.abs(afterTap.placements[0]!.yMm - bBefore.yMm),
      'tap release MUST preserve centre y',
    ).toBeLessThan(TOL_MM);
    await shoot(page, 'drag-limits');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});

test('drag: punctuation placement id restores, resolves, and drags', async ({
  browser,
}) => {
  const seeded = await seedDragScene(browser);
  const { page, probe } = seeded;
  try {
    await requireDragContract(page);
    const baseline = await saveThenRescroll(page);
    // Punctuation id incl. a real double quote AND backslash (plus brackets,
    // parens, single quote, slash): restore validation imposes no character
    // class (non-empty, <=256 chars). Panel + spec resolve footprints by
    // attribute equality (never a CSS selector), so quoting needs no escape.
    const PUNCT = `PLC-[B]-("x"\\'y'/1)`;
    const punctuated = mutatePlacementBundle(baseline, (bundle) => {
      const first = bundle.placements.find((entry) => entry.id === 'PLC-0001');
      if (!first) throw new Error('seeded PLC-0001 missing from bundle');
      first.id = PUNCT;
      for (const status of bundle.statuses) {
        if (status.id === 'PLC-0001') status.id = PUNCT;
      }
    });
    await restorePlacementBundle(page, punctuated);
    const restored = await saveThenRescroll(page);
    const restoredIds = parsePlacementBundle(restored).placements.map((entry) => entry.id);
    expect(
      restoredIds,
      'restore MUST accept the punctuation id',
    ).toContain(PUNCT);
    expect(
      await saveThenRescroll(page),
      'punctuated export MUST be deterministic',
    ).toBe(restored);
    await expect(hook(page, 'placement', 'placement-list')).toContainText(
      PUNCT,
    );
    // Footprint resolves by attribute equality (no CSS escaping needed) and
    // its accessible name carries id + region.
    const label = await page.evaluate((wanted) => {
      const els = Array.from(document.querySelectorAll('[data-placement-id]'));
      const el = els.find(
        (e) => e.getAttribute('data-placement-id') === wanted,
      );
      if (!el) throw new Error(`footprint ${wanted} missing`);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return el.getAttribute('aria-label') ?? '';
    }, PUNCT);
    expect(
      label,
      'punctuated footprint name MUST contain id + region',
    ).toContain(PUNCT);
    expect(label, 'punctuated footprint name MUST name a region').toMatch(
      /back|front/,
    );
    // A small drag commits the RIGHT placement: only the punctuated entry
    // moves, siblings are byte-equal. (Bundle order is id-sorted, so look the
    // punctuated entry up by id rather than by index.)
    const restoredById = Object.fromEntries(
      parsePlacementBundle(restored).placements.map((entry) => [entry.id, entry]),
    );
    const pBefore = restoredById[PUNCT]!;
    const { s } = await svgScale(page, 'back');
    const dxMm = 5;
    const start = await footprintCentreByAttr(page, PUNCT);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dxMm * s, start.y, { steps: 5 });
    await page.mouse.up();
    const first = await saveThenRescroll(page);
    expect(
      await saveThenRescroll(page),
      'punctuated export MUST be deterministic',
    ).toBe(first);
    const afterById = Object.fromEntries(
      parsePlacementBundle(first).placements.map((entry) => [entry.id, entry]),
    );
    expect(Math.abs(afterById[PUNCT]!.xMm - (pBefore.xMm + dxMm))).toBeLessThan(
      TOL_MM,
    );
    expect(Math.abs(afterById[PUNCT]!.yMm - pBefore.yMm)).toBeLessThan(
      TOL_MM,
    );
    for (const entry of parsePlacementBundle(first).placements) {
      if (entry.id === PUNCT) continue;
      expect(entry, `sibling ${entry.id} MUST be byte-equal`).toEqual(
        restoredById[entry.id],
      );
    }
    await shoot(page, 'drag-punctuation');
    assertCleanProbe(probe);
  } finally {
    await seeded.close();
  }
});

// NOTE (deferred coverage, not silently skipped): genuine OS-level touch
// pointercancel (device interruption) has no headless-mouse equivalent, so
// that path uses a dispatched event with the gesture's real pointerId;
// lostpointercapture uses the browser's real capture machinery
// (releasePointerCapture + a held-button move to process the pending loss,
// W3C Pointer Events 3 §4.1.3.2/§9.3) and blur uses a real same-context
// helper page brought to front, with a recorded dispatched-handler fallback
// when headless focus does not transition (window.blur() is a no-op here).
// replaceDraft/reset/prune host-render aborts beyond the restoreBusy,
// stale-lock, and asset-swap paths exercised above need host hooks this spec
// does not own.
