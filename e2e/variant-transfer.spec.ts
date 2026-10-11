import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
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
} from './helpers.js';
import { loadFixtures } from './fixtures.js';
import { parseAreaBundleRestore } from '../src/core/region-areas-restore/index.js';
import { buildEvidence, snapshotEvidence, stableStringify } from '../src/core/calibration-session/index.js';
import { fitUniformScale } from '../src/core/calibration/index.js';
import { createPlanarRegion } from '../src/core/planar-region/index.js';
import { buildAreaBundle, serializeAreaBundle, type AreasMap } from '../src/core/region-areas/index.js';
declare global {
  interface Window {
    qaPending?: Array<{ resolve: () => void }>;
  }
}

/**
 * Provisional Phase 7 variant-transfer UI: capture a frozen source snapshot,
 * author an explicit current target, supply rules/overrides, run an atomic
 * draft transfer, and export a deterministic pending-review bundle.
 */

type TransferHookName =
  | 'transfer-panel'
  | 'transfer-source-status'
  | 'transfer-capture-button'
  | 'transfer-clear-button'
  | 'transfer-target-summary'
  | 'transfer-rules-text'
  | 'transfer-overrides-text'
  | 'transfer-run-button'
  | 'transfer-status'
  | 'transfer-result-list'
  | 'transfer-preview'
  | 'transfer-export-button';

function thook(page: Page, name: TransferHookName) {
  return page.locator(`[data-transfer-hook="${name}"]`);
}

async function downloadTransfer(page: Page): Promise<string> {
  const event = page.waitForEvent('download');
  await thook(page, 'transfer-export-button').click();
  const download = await event;
  const path = await download.path();
  if (path === null) throw new Error('Download path unavailable.');
  return readFile(path, 'utf8');
}

interface TransferRecordJson {
  sourcePlacementId: string;
  targetPlacementId: string;
  sourceRegionId: string;
  targetRegionId: string;
  strategy: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
}

interface TransferBundleJson {
  schemaVersion: string;
  pendingReview: boolean;
  productionApproved: boolean;
  transfers: TransferRecordJson[];
  source: { product: string; variant: string };
  target: {
    session: { evidence: { variant: string }; fit: { scaleMmPerUnit: number } };
    placements: Array<{ id: string; xMm: number; yMm: number; widthMm: number; heightMm: number; rotationDeg: number }>;
    statuses: Array<{ id: string; fits: boolean; reason: string }>;
  };
}

function parseTransferBundle(text: string): TransferBundleJson {
  return JSON.parse(text) as TransferBundleJson;
}

const FRAME = 'centre-mm-y-up';
const ABSOLUTE_RULE = JSON.stringify([
  {
    sourceRegionId: 'front',
    targetRegionId: 'front',
    strategy: 'absolute-position',
    sourceFrameConvention: FRAME,
    targetFrameConvention: FRAME,
  },
]);

const WORKED_SOURCE_REF = {
  originXmm: 0,
  originYmm: 0,
  widthMm: 200,
  heightMm: 100,
};
const WORKED_TARGET_REF = {
  originXmm: 10,
  originYmm: 20,
  widthMm: 300,
  heightMm: 150,
};

function normalizedRules(proportional: boolean): string {
  return JSON.stringify([
    {
      sourceRegionId: 'front',
      targetRegionId: 'front',
      strategy: 'normalized-position',
      sourceFrameConvention: FRAME,
      targetFrameConvention: FRAME,
      sourceRef: WORKED_SOURCE_REF,
      targetRef: WORKED_TARGET_REF,
      ...(proportional ? { proportionalDimensions: true } : {}),
    },
  ]);
}

async function shoot(page: Page, name: string): Promise<void> {
  const desktopPath = test.info().outputPath(`${name}-1280x900.png`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await thook(page, 'transfer-result-list').scrollIntoViewIfNeeded();
  await page.screenshot({ path: desktopPath });
  await test.info().attach(`${name}-desktop`, { path: desktopPath, contentType: 'image/png' });
  const mobilePath = test.info().outputPath(`${name}-390x844.png`);
  await page.setViewportSize({ width: 390, height: 844 });
  await thook(page, 'transfer-result-list').scrollIntoViewIfNeeded();
  await page.screenshot({ path: mobilePath });
  await test.info().attach(`${name}-mobile`, { path: mobilePath, contentType: 'image/png' });
  await test.info().attach('offline-note', {
    contentType: 'application/json',
    body: JSON.stringify({ entryPoint: 'file://', scope: 'internal inspector', offline: true, shot: name }, null, 2),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Independently calibrated synthetic target: same asset, distinct variant and scale. */
async function targetVariantFixture(): Promise<{ text: string; scale: number }> {
  const fixtures = await loadFixtures();
  const source = parseAreaBundleRestore(fixtures.areaText, fixtures.expectedHash);
  if (!source.ok) throw new Error(source.error);
  const measurements = source.draft.measurements.map(m => ({ ...m, distanceMm: m.distanceMm * 1.5 }));
  const built = buildEvidence({ ...source.draft.fields, variant: 'SYN-V2', calibrationId: 'syn-target-calibration' }, source.draft.anchors, measurements);
  if (!built.ok) throw new Error(built.error);
  const evidence = built.evidence;
  const snapshot = snapshotEvidence(evidence);
  const fit = fitUniformScale(evidence);
  const regions = source.regions.map(region => {
    const created = createPlanarRegion(region, source.draft.anchors, evidence, snapshot);
    if (!created.ok) throw new Error(created.error);
    return created.region;
  });
  const areas: AreasMap = Object.create(null);
  for (const region of regions) {
    const original = source.areas[region.regionId]!;
    areas[region.regionId] = { ...original, frameSnapshot: stableStringify(region) };
  }
  const bundle = buildAreaBundle(evidence, fit, regions, areas, snapshot);
  if (!bundle.ok) throw new Error(bundle.error);
  return { text: serializeAreaBundle(bundle.bundle), scale: fit.scaleMmPerUnit };
}

async function seedInspector(browser: Browser, viewport?: { width: number; height: number }) {
  const { context, page, probe } = await openOfflineContext(browser, viewport);
  const { glbBuffer, sessionText, areaText } = await loadFixtures();
  await gotoInspector(page);
  await ingestGlb(page, glbBuffer);
  await restoreSession(page, sessionText);
  await restoreAreaBundle(page, areaText);
  await expect(thook(page, 'transfer-panel')).toBeVisible();
  return { context, page, probe, glbBuffer, sessionText, areaText };
}

async function captureWith(
  page: Page,
  placements: Array<{ logo: string; region: string; x: number; y: number; w: number; h: number; rot: number }>,
): Promise<void> {
  for (const p of placements) {
    await addPlacement(page, p);
  }
  await thook(page, 'transfer-capture-button').click();
  await expect(thook(page, 'transfer-source-status')).toContainText('FROZEN');
}

async function fillRulesAndRun(page: Page, rules: string, overrides = '[]'): Promise<void> {
  await thook(page, 'transfer-rules-text').fill(rules);
  await thook(page, 'transfer-overrides-text').fill(overrides);
  await thook(page, 'transfer-run-button').click();
}

test('transfer absolute: verbatim geometry, pending-review envelope, deterministic bytes', async ({ browser }) => {
  const { context, page, probe } = await seedInspector(browser);
  try {
    await captureWith(page, [{ logo: 'SYN-LOGO-A', region: 'front', x: 30, y: 40, w: 80, h: 40, rot: 0 }]);
    await fillRulesAndRun(page, ABSOLUTE_RULE);
    await expect(thook(page, 'transfer-status')).toContainText(/Transferred 1/);
    const listText = await thook(page, 'transfer-result-list').innerText();
    for (const token of ['30', '40', '80']) expect(listText).toContain(token);

    const first = await downloadTransfer(page);
    const bundle = parseTransferBundle(first);
    expect(bundle.pendingReview).toBe(true);
    expect(bundle.productionApproved).toBe(false);
    expect(bundle.transfers).toHaveLength(1);
    const record = bundle.transfers[0]!;
    expect(record.strategy).toBe('absolute-position');
    expect(record.xMm).toBe(30);
    expect(record.yMm).toBe(40);
    expect(record.widthMm).toBe(80);
    expect(record.heightMm).toBe(40);

    // Determinism: rerun + re-export must be byte-identical.
    await thook(page, 'transfer-run-button').click();
    const second = await downloadTransfer(page);
    expect(second).toBe(first);
    await shoot(page, 'absolute');
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('transfer normalized: fixed-size keeps dims, proportional scales (worked rects)', async ({ browser }) => {
  const { context, page, probe } = await seedInspector(browser);
  try {
    // Worked example: source centre (50,25) size 80x40, S=(0,0,200,100), T=(10,20,300,150).
    await captureWith(page, [{ logo: 'SYN-LOGO-A', region: 'front', x: 50, y: 25, w: 80, h: 40, rot: 0 }]);
    await fillRulesAndRun(page, normalizedRules(false));
    await expect(thook(page, 'transfer-status')).toContainText(/Transferred 1/);
    const fixed = parseTransferBundle(await downloadTransfer(page));
    expect(fixed.transfers[0]!.xMm).toBeCloseTo(85, 9);
    expect(fixed.transfers[0]!.yMm).toBeCloseTo(57.5, 9);
    expect(fixed.transfers[0]!.widthMm).toBe(80);
    expect(fixed.transfers[0]!.heightMm).toBe(40);

    await fillRulesAndRun(page, normalizedRules(true));
    await expect(thook(page, 'transfer-status')).toContainText(/Transferred 1/);
    const scaled = parseTransferBundle(await downloadTransfer(page));
    expect(scaled.transfers[0]!.xMm).toBeCloseTo(85, 9);
    expect(scaled.transfers[0]!.yMm).toBeCloseTo(57.5, 9);
    expect(scaled.transfers[0]!.widthMm).toBeCloseTo(120, 9);
    expect(scaled.transfers[0]!.heightMm).toBeCloseTo(60, 9);
    await shoot(page, 'normalized');
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('transfer override: exact mm position/size/rotation win over rule', async ({ browser }) => {
  const { context, page, probe } = await seedInspector(browser);
  try {
    await captureWith(page, [{ logo: 'SYN-LOGO-A', region: 'front', x: 30, y: 40, w: 80, h: 40, rot: 0 }]);
    await fillRulesAndRun(
      page,
      ABSOLUTE_RULE,
      JSON.stringify([
        { placementId: 'PLC-0001', targetRegionId: 'front', xMm: 11, yMm: 22, widthMm: 33, heightMm: 44, rotationDeg: 15 },
      ]),
    );
    await expect(thook(page, 'transfer-status')).toContainText(/Transferred 1/);
    const bundle = parseTransferBundle(await downloadTransfer(page));
    const record = bundle.transfers[0]!;
    expect(record.strategy).toBe('override');
    expect(record.xMm).toBe(11);
    expect(record.yMm).toBe(22);
    expect(record.widthMm).toBe(33);
    expect(record.heightMm).toBe(44);
    expect(record.rotationDeg).toBe(15);
    await shoot(page, 'override');
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('transfer multiple placements together; zero placements export empty; unsafe stays pendingReview with fits:false', async ({
  browser,
}) => {
  const { context, page, probe } = await seedInspector(browser);
  try {
    await captureWith(page, [
      { logo: 'SYN-LOGO-A', region: 'back', x: 25, y: 25, w: 10, h: 6, rot: 30 },
      { logo: 'SYN-LOGO-B', region: 'front', x: 20, y: 20, w: 10, h: 6, rot: 45 },
      { logo: 'SYN-LOGO-A', region: 'front', x: 80, y: 20, w: 10, h: 6, rot: 90 },
    ]);
    await fillRulesAndRun(
      page,
      JSON.stringify([
        { sourceRegionId: 'front', targetRegionId: 'front', strategy: 'absolute-position', sourceFrameConvention: FRAME, targetFrameConvention: FRAME },
        { sourceRegionId: 'back', targetRegionId: 'back', strategy: 'absolute-position', sourceFrameConvention: FRAME, targetFrameConvention: FRAME },
      ]),
    );
    await expect(thook(page, 'transfer-status')).toContainText(/Transferred 3/);
    const multi = parseTransferBundle(await downloadTransfer(page));
    expect(multi.transfers).toHaveLength(3);
    expect(multi.target.statuses.filter((s) => s.fits)).toHaveLength(2);

    // Zero placements: delete each committed placement through its Select
    // button, then capture the empty live draft.
    await thook(page, 'transfer-clear-button').click();
    await expect(thook(page, 'transfer-source-status')).toContainText('No source snapshot');
    for (let i = 0; i < 3; i += 1) {
      await hook(page, 'placement', 'placement-list').getByRole('button').first().click();
      await hook(page, 'placement', 'placement-delete').click();
    }
    await expect(hook(page, 'placement', 'placement-list')).toContainText('No placements');
    await thook(page, 'transfer-capture-button').click();
    const frozenEmpty = await thook(page, 'transfer-source-status').innerText();
    expect(frozenEmpty).toContain('FROZEN');
    expect(frozenEmpty).toContain('0 placement(s)');
    await fillRulesAndRun(page, ABSOLUTE_RULE);
    await expect(thook(page, 'transfer-status')).toContainText(/Transferred 0/);
    expect(parseTransferBundle(await downloadTransfer(page)).transfers).toHaveLength(0);

    // Unsafe: a fitting source geometry maps onto an exclusion at the target
    // via an override, so the target verdict is fits:false (pending review).
    // Placement ids keep incrementing across deletes, so read the live id.
    await thook(page, 'transfer-clear-button').click();
    await addPlacement(page, { logo: 'SYN-LOGO-A', region: 'front', x: 20, y: 20, w: 10, h: 6, rot: 0 });
    const liveList = await hook(page, 'placement', 'placement-list').innerText();
    const liveId = liveList.match(/PLC-\d+/)?.[0];
    if (liveId === undefined) throw new Error('No live placement id found.');
    await thook(page, 'transfer-capture-button').click();
    await fillRulesAndRun(
      page,
      ABSOLUTE_RULE,
      JSON.stringify([
        { placementId: liveId, targetRegionId: 'front', xMm: 20, yMm: 20, widthMm: 10, heightMm: 6, rotationDeg: 0 },
      ]),
    );
    await expect(thook(page, 'transfer-status')).toContainText(/Transferred 1/);
    const unsafe = parseTransferBundle(await downloadTransfer(page));
    expect(unsafe.pendingReview).toBe(true);
    expect(unsafe.productionApproved).toBe(false);
    expect(unsafe.target.statuses.filter((s) => !s.fits).length).toBeGreaterThan(0);
    const unsafeStatus = unsafe.target.statuses.find((s) => !s.fits);
    expect(unsafeStatus?.reason).toBeTruthy();
    await shoot(page, 'multi-zero-unsafe');
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('transfer source snapshot survives target asset replacement; result invalidates until rerun', async ({
  browser,
}) => {
  const { context, page, probe } = await seedInspector(browser);
  try {
    const { glbBuffer, sessionText, areaText } = await loadFixtures();
    await captureWith(page, [{ logo: 'SYN-LOGO-A', region: 'front', x: 30, y: 40, w: 80, h: 40, rot: 0 }]);
    const frozenBefore = await thook(page, 'transfer-source-status').innerText();
    await fillRulesAndRun(page, ABSOLUTE_RULE);
    await expect(thook(page, 'transfer-export-button')).toBeEnabled();
    const bytesBefore = await downloadTransfer(page);

    // Asset-replacement path: same bytes re-ingested + same session/areas restored.
    // Replacement resets the live placement draft (asset swap clears committed
    // state); the frozen source must survive that reset untouched.
    await ingestGlb(page, glbBuffer);
    await restoreSession(page, sessionText);
    await restoreAreaBundle(page, areaText);
    await expect(hook(page, 'placement', 'placement-list')).toContainText('No placements');
    await expect(thook(page, 'transfer-source-status')).toHaveText(frozenBefore);
    await expect(thook(page, 'transfer-source-status')).toContainText('1 placement(s)');
    // Re-author the same live target geometry, then rerun: bytes must match.
    await addPlacement(page, { logo: 'SYN-LOGO-A', region: 'front', x: 30, y: 40, w: 80, h: 40, rot: 0 });
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();
    await expect(thook(page, 'transfer-status')).toContainText(/Stale|stale|changed|rerun|Run again/);
    await thook(page, 'transfer-run-button').click();
    await expect(thook(page, 'transfer-export-button')).toBeEnabled();
    expect(await downloadTransfer(page)).toBe(bytesBefore);

    // Editing the live target invalidates the prior result and disables export.
    await hook(page, 'placement', 'placement-x').fill('31');
    await hook(page, 'placement', 'placement-update').click();
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();
    await expect(thook(page, 'transfer-status')).toContainText(/Stale|stale|changed|rerun|Run again/);

    // Rerun re-enables export. The frozen source is unchanged (original
    // numbers), so the rerun still exports the source geometry.
    await thook(page, 'transfer-run-button').click();
    await expect(thook(page, 'transfer-export-button')).toBeEnabled();
    expect(parseTransferBundle(await downloadTransfer(page)).transfers[0]!.xMm).toBe(30);
    await shoot(page, 'source-survives');
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('transfer frozen source numeric preservation across a different target region', async ({ browser }) => {
  const { context, page, probe } = await seedInspector(browser);
  try {
    // Source lives in front; the target mapping lands it in back with
    // verbatim numbers — a genuinely different physical context, not an
    // identical-asset roundtrip.
    await captureWith(page, [{ logo: 'SYN-LOGO-A', region: 'front', x: 30, y: 40, w: 20, h: 12, rot: 0 }]);
    const crossRule = JSON.stringify([
      {
        sourceRegionId: 'front',
        targetRegionId: 'back',
        strategy: 'absolute-position',
        sourceFrameConvention: FRAME,
        targetFrameConvention: FRAME,
      },
    ]);
    await fillRulesAndRun(page, crossRule);
    await expect(thook(page, 'transfer-status')).toContainText(/Transferred 1/);
    const bundle = parseTransferBundle(await downloadTransfer(page));
    expect(bundle.source.product).toBe('SYN-BOX');
    expect(bundle.source.variant).toBe('SYN-V1');
    const record = bundle.transfers[0]!;
    expect(record.sourceRegionId).toBe('front');
    expect(record.targetRegionId).toBe('back');
    expect(record.xMm).toBe(30);
    expect(record.yMm).toBe(40);
    expect(record.widthMm).toBe(20);
    expect(record.heightMm).toBe(12);
    // Frozen source still shows the original front snapshot.
    await expect(thook(page, 'transfer-source-status')).toContainText('front');
    await shoot(page, 'frozen-source-cross-region');
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('transfer between independently calibrated variants preserves source and leaves target draft unchanged', async ({ browser }) => {
  const { context, page, probe } = await seedInspector(browser);
  try {
    await captureWith(page, [{ logo: 'SYN-LOGO-A', region: 'front', x: 50, y: 25, w: 80, h: 40, rot: 15 }]);
    const sourceSummary = await thook(page, 'transfer-source-status').innerText();
    const target = await targetVariantFixture();
    await restoreAreaBundle(page, target.text);
    await expect(thook(page, 'transfer-target-summary')).toContainText('SYN-V2');
    await expect(thook(page, 'transfer-source-status')).toHaveText(sourceSummary);
    const draftBefore = await savePlacementBundle(page);
    await fillRulesAndRun(page, normalizedRules(true));
    const bundle = parseTransferBundle(await downloadTransfer(page));
    expect(bundle.source.variant).toBe('SYN-V1');
    expect(bundle.target.session.evidence.variant).toBe('SYN-V2');
    expect(bundle.target.session.fit.scaleMmPerUnit).toBe(target.scale);
    expect(bundle.transfers[0]).toMatchObject({ xMm: 85, yMm: 57.5, widthMm: 120, heightMm: 60, rotationDeg: 15 });
    expect(await savePlacementBundle(page)).toBe(draftBefore);
    await shoot(page, 'distinct-variants');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('transfer drag locks discard results and recover after cancellation without capturing a candidate', async ({ browser }) => {
  const { context, page, probe } = await seedInspector(browser);
  try {
    await captureWith(page, [{ logo: 'SYN-LOGO-A', region: 'front', x: 80, y: 20, w: 10, h: 6, rot: 0 }]);
    await fillRulesAndRun(page, ABSOLUTE_RULE);
    const baseline = await downloadTransfer(page);
    const footprint = hook(page, 'placement', 'placement-preview2d').locator('[data-placement-id="PLC-0001"]');
    await footprint.scrollIntoViewIfNeeded();
    const box = await footprint.boundingBox();
    if (box === null) throw new Error('Missing footprint bounds');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 5);
    for (const name of ['transfer-capture-button', 'transfer-run-button', 'transfer-export-button'] as const) {
      await expect(thook(page, name)).toBeDisabled();
    }
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(thook(page, 'transfer-capture-button')).toBeEnabled();
    await expect(thook(page, 'transfer-run-button')).toBeEnabled();
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();
    await thook(page, 'transfer-run-button').click();
    expect(await downloadTransfer(page)).toBe(baseline);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('transfer ignores an obsolete restore read after target asset replacement', async ({ browser }) => {
  const { context, page, probe, glbBuffer, areaText } = await seedInspector(browser);
  try {
    await captureWith(page, [{ logo: 'SYN-LOGO-A', region: 'front', x: 30, y: 40, w: 20, h: 12, rot: 0 }]);
    await fillRulesAndRun(page, ABSOLUTE_RULE);
    const baseline = await downloadTransfer(page);
    const oldDraft = await savePlacementBundle(page);
    await page.evaluate(() => {
      const native = File.prototype.text;
      window.qaPending = [];
      File.prototype.text = function() {
        return new Promise<string>((resolve, reject) => {
          window.qaPending!.push({ resolve: () => native.call(this).then(resolve, reject) });
        });
      };
    });
    await hook(page, 'calibration', 'placement-restore-file').setInputFiles({ name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(oldDraft) });
    await hook(page, 'calibration', 'placement-restore-button').click();
    await page.waitForFunction(() => window.qaPending?.length === 1);
    await expect(thook(page, 'transfer-capture-button')).toBeDisabled();
    await ingestGlb(page, glbBuffer);
    await page.evaluate(() => window.qaPending![0]!.resolve());
    // The obsolete file read has completed; rebuild the new target independently.
    await hook(page, 'calibration', 'area-restore-file').setInputFiles({ name: 'new.json', mimeType: 'application/json', buffer: Buffer.from(areaText) });
    await hook(page, 'calibration', 'area-restore-button').click();
    await page.waitForFunction(() => window.qaPending?.length === 2);
    await page.evaluate(() => window.qaPending![1]!.resolve());
    await expect(thook(page, 'transfer-run-button')).toBeEnabled();
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();
    await thook(page, 'transfer-run-button').click();
    expect(await downloadTransfer(page)).toBe(baseline);
    expect(JSON.parse(await savePlacementBundle(page)).placements).toEqual([]);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('transfer atomic failures: bad rules JSON, missing mapping, stale calibration, busy restore, post-run edits', async ({
  browser,
}) => {
  const { context, page, probe } = await seedInspector(browser);
  try {
    await captureWith(page, [{ logo: 'SYN-LOGO-A', region: 'front', x: 30, y: 40, w: 80, h: 40, rot: 0 }]);

    // 1. Invalid rules JSON (not JSON): run fails, export disabled, no bundle.
    await fillRulesAndRun(page, 'not-json{{{');
    await expect(thook(page, 'transfer-status')).toContainText(/invalid JSON|not run|failed/i);
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();

    // 2. Missing mapping: placement region has no rule and no override.
    await fillRulesAndRun(
      page,
      JSON.stringify([
        { sourceRegionId: 'back', targetRegionId: 'back', strategy: 'absolute-position', sourceFrameConvention: FRAME, targetFrameConvention: FRAME },
      ]),
    );
    await expect(thook(page, 'transfer-status')).toContainText(/no rule|missing|mapping|failed|not run/i);
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();

    // 3. Valid run, then stale target via calibration-id edit (identity is
    // part of the target signature but not of the fit evidence).
    await fillRulesAndRun(page, ABSOLUTE_RULE);
    await expect(thook(page, 'transfer-export-button')).toBeEnabled();
    await hook(page, 'calibration', 'calibration-id').fill('STALE-CALIBRATION');
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();
    await expect(thook(page, 'transfer-status')).toContainText(/Stale|stale|changed|rerun|Run again/);

    // 4. Target area edit invalidates the stored result until rerun.
    await hook(page, 'calibration', 'calibration-id').fill('syn-calibration');
    await fillRulesAndRun(page, ABSOLUTE_RULE);
    await expect(thook(page, 'transfer-export-button')).toBeEnabled();
    await hook(page, 'area', 'area-safe-text').fill('[[0,0],[10,0],[10,10],[0,10]]');
    await hook(page, 'area', 'area-safe-set').click();
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();

    // 5. Busy restore: deferred File.text keeps run/export disabled while the
    // read is pending; resolving it completes the restore, which swaps the
    // draft and leaves the prior result stale until rerun.
    await hook(page, 'area', 'area-safe-text').fill('');
    await fillRulesAndRun(page, ABSOLUTE_RULE);
    await expect(thook(page, 'transfer-export-button')).toBeEnabled();
    await page.evaluate(() => {
      const native = File.prototype.text;
      const pending: Array<{ resolve: () => void }> = [];
      window.qaPending = pending;
      File.prototype.text = function text(this: File) {
        return new Promise<string>((resolvePromise, reject) => {
          pending.push({
            resolve: () => {
              native.call(this).then(resolvePromise, reject);
            },
          });
        });
      };
    });
    const placementExport = await savePlacementBundle(page);
    const queuePlacementRestore = restorePlacementBundle(page, placementExport);
    await page.waitForFunction(() => (window.qaPending?.length ?? 0) === 1);
    await expect(thook(page, 'transfer-run-button')).toBeDisabled();
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();
    await expect(thook(page, 'transfer-status')).toContainText(/restore|Stale|busy|running|Run again/i);
    await page.evaluate(() => window.qaPending?.[0]?.resolve());
    await queuePlacementRestore;
    // The restore swapped the draft: prior result is stale until rerun.
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();
    await expect(thook(page, 'transfer-status')).toContainText(/Stale|stale|changed|rerun|Run again|restored/i);
    await thook(page, 'transfer-run-button').click();
    await expect(thook(page, 'transfer-export-button')).toBeEnabled();

    // 6. Rule edit after run disables export until rerun; override edit too.
    await thook(page, 'transfer-rules-text').fill(`${ABSOLUTE_RULE} `);
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();
    await thook(page, 'transfer-run-button').click();
    await expect(thook(page, 'transfer-export-button')).toBeEnabled();
    await thook(page, 'transfer-overrides-text').fill('[] ');
    await expect(thook(page, 'transfer-export-button')).toBeDisabled();
    await shoot(page, 'atomic-failures');
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});
