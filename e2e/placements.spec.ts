import { expect, test } from '@playwright/test';
import {
  addPlacement,
  assertCleanProbe,
  gotoInspector,
  hook,
  ingestGlb,
  openOfflineContext,
  restoreAreaBundle,
  restoreSession,
  savePlacementBundle,
} from './helpers.js';
import { loadFixtures, parsePlacementBundle } from './fixtures.js';

test('placements: empty export, multi-add, statuses, numeric update', async ({
  browser,
}) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    const { glbBuffer, sessionText, areaText } = await loadFixtures();
    await gotoInspector(page);
    await ingestGlb(page, glbBuffer);
    await restoreSession(page, sessionText);
    await restoreAreaBundle(page, areaText);

    const empty = await savePlacementBundle(page);
    expect(parsePlacementBundle(empty).placements).toHaveLength(0);

    await addPlacement(page, {
      logo: 'SYN-LOGO-A',
      region: 'back',
      x: 25,
      y: 25,
      w: 10,
      h: 6,
      rot: 30,
    });
    await expect(hook(page, 'placement', 'placement-list')).toContainText(
      'PLC-0001',
    );
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

    const exported = await savePlacementBundle(page);
    const bundle = parsePlacementBundle(exported);
    expect(bundle.placements).toHaveLength(3);
    expect(bundle.statuses.filter((status) => status.fits)).toHaveLength(2);
    expect(bundle.placements[0]?.rotationDeg).toBe(30);
    expect(bundle.placements[1]?.logoId).toBe('SYN-LOGO-B');
    // Numeric update: the third add auto-selects PLC-0003, so editing x and
    // clicking update must change the exact downloaded bytes.
    await hook(page, 'placement', 'placement-x').fill('81');
    await hook(page, 'placement', 'placement-update').click();
    const updated = await savePlacementBundle(page);
    expect(updated).not.toBe(exported);
    expect(parsePlacementBundle(updated).placements[2]?.xMm).toBe(81);
    const statusText = await hook(
      page,
      'placement',
      'placement-status',
    ).innerText();
    expect(statusText).toMatch(/does not fit/);
    expect(statusText).toMatch(/exclusion/);
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});
