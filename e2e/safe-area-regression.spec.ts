import { expect, test } from '@playwright/test';
import {
  assertCleanProbe,
  gotoInspector,
  hook,
  ingestGlb,
  openOfflineContext,
  restoreAreaBundle,
  restoreSession,
  revealControl,
} from './helpers.js';
import { loadFixtures } from './fixtures.js';

async function checkFootprint(
  page: Parameters<typeof gotoInspector>[0],
  polygon: string,
) {
  await revealControl(page, '[data-area-hook="area-footprint-text"]');
  await hook(page, 'area', 'area-footprint-text').fill(polygon);
  await hook(page, 'area', 'area-footprint-check').click();
  return hook(page, 'area', 'area-footprint-verdict').innerText();
}

test('safe areas: rect and concave-with-exclusion verdicts plus preview', async ({
  browser,
}) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    const { glbBuffer, sessionText, areaText } = await loadFixtures();
    await gotoInspector(page);
    await ingestGlb(page, glbBuffer);
    await restoreSession(page, sessionText);
    await restoreAreaBundle(page, areaText);

    await hook(page, 'calibration', 'region-active').selectOption('back');
    await expect(checkFootprint(page, '[[0,0],[10,0],[10,10],[0,10]]')).resolves
      .toMatch(/^Footprint fits/);
    await expect(
      checkFootprint(page, '[[40,40],[90,40],[90,90],[40,90]]'),
    ).resolves.toMatch(/does not fit/);

    await hook(page, 'calibration', 'region-active').selectOption('front');
    await expect(checkFootprint(page, '[[0,0],[10,0],[10,10],[0,10]]')).resolves
      .toMatch(/^Footprint fits/);
    await expect(
      checkFootprint(page, '[[30,60],[70,60],[70,80],[30,80]]'),
    ).resolves.toMatch(/does not fit/);
    // Pocket exclusion overlap must not fit even though the concave safe
    // polygon covers the surrounding band.
    await expect(
      checkFootprint(page, '[[10,10],[30,10],[30,30],[10,30]]'),
    ).resolves.toMatch(/does not fit/);

    await expect(hook(page, 'area', 'area-preview').locator('svg')).toHaveCount(
      1,
    );

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});
