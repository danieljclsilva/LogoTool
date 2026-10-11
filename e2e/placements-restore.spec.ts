import { expect, test } from '@playwright/test';
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
import {
  loadFixtures,
  mutatePlacementBundle,
  parsePlacementBundle,
} from './fixtures.js';

test('placement restore: roundtrip, forged recompute, atomic, stale lock', async ({
  browser,
}) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    const { glbBuffer, sessionText, areaText } = await loadFixtures();
    await gotoInspector(page);
    await ingestGlb(page, glbBuffer);
    await restoreSession(page, sessionText);
    await restoreAreaBundle(page, areaText);

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
    const original = await savePlacementBundle(page);
    expect(parsePlacementBundle(original).placements).toHaveLength(3);

    // Roundtrip plus camera-button stability.
    await restorePlacementBundle(page, original);
    expect(await savePlacementBundle(page)).toBe(original);
    await hook(page, 'inspector', 'fit-button').click();
    await hook(page, 'inspector', 'reset-button').click();
    expect(await savePlacementBundle(page)).toBe(original);

    // Fresh-context reopen of the same bytes.
    const second = await openOfflineContext(browser);
    try {
      const fixtures = await loadFixtures();
      await gotoInspector(second.page);
      await ingestGlb(second.page, fixtures.glbBuffer);
      await restorePlacementBundle(second.page, original);
      expect(await savePlacementBundle(second.page)).toBe(original);
      assertCleanProbe(second.probe);
    } finally {
      await second.context.close();
    }

    // Forged approval/fit/status are recomputed, never retained.
    const forged = mutatePlacementBundle(original, (bundle) => {
      bundle.productionApproved = true;
      bundle.session.fit.productionApproved = true;
      bundle.session.fit.scaleMmPerUnit = 999;
      bundle.statuses = [];
    });
    await restorePlacementBundle(page, forged);
    expect(await savePlacementBundle(page)).toBe(original);

    // Malformed/dangling/wrong-asset restores fail atomically.
    const failures = [
      '{broken',
      mutatePlacementBundle(original, (bundle) => { bundle.schemaVersion = 'future'; }),
      mutatePlacementBundle(original, (bundle) => {
        bundle.placements[0]!.logoId = 'missing';
      }),
      mutatePlacementBundle(original, (bundle) => {
        bundle.placements[0]!.widthMm = 0;
      }),
      mutatePlacementBundle(original, (bundle) => {
        bundle.regions[0]!.origin.x += 1;
      }),
      mutatePlacementBundle(original, (bundle) => {
        bundle.session.evidence.assetFullSha256 = '0'.repeat(64);
      }),
    ];
    for (const text of failures) {
      await restorePlacementBundle(page, text);
      await expect(hook(page, 'calibration', 'status')).toContainText(
        /failed/i,
      );
      expect(await savePlacementBundle(page)).toBe(original);
    }

    // Stale product-id locks export; restoring the bundle recovers.
    await hook(page, 'calibration', 'product-id').fill('STALE');
    await expect(
      hook(page, 'calibration', 'placement-export-button'),
    ).toBeDisabled();
    await expect(hook(page, 'placement', 'placement-context')).toContainText(
      /stale/i,
    );
    await restorePlacementBundle(page, original);
    expect(await savePlacementBundle(page)).toBe(original);

    // Save twice byte-equal, and zero-placement restore roundtrips.
    expect(await savePlacementBundle(page)).toBe(original);
    const empty = mutatePlacementBundle(original, (bundle) => {
      bundle.placements = [];
    });
    await restorePlacementBundle(page, empty);
    const emptySaved = await savePlacementBundle(page);
    expect(parsePlacementBundle(emptySaved).placements).toHaveLength(0);
    await restorePlacementBundle(page, emptySaved);
    expect(await savePlacementBundle(page)).toBe(emptySaved);
    await expect(hook(page, 'placement', 'placement-list')).toContainText(
      /No placements/,
    );

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});
