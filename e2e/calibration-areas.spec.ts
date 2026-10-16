import { expect, test } from '@playwright/test';
import {
  assertCleanProbe,
  gotoInspector,
  hook,
  ingestGlb,
  openOfflineContext,
  restoreAreaBundle,
  restoreSession,
  saveAreaBundle,
} from './helpers.js';
import { loadFixtures, mutateAreaBundle, parseAreaBundle } from './fixtures.js';

async function openLabelsDetails(page: Parameters<typeof restoreSession>[0]): Promise<void> {
  await expect(page.locator('[data-calibration-hook="product-id"]')).toBeVisible();
}
async function authorRegionsAndAreas(page: Parameters<typeof restoreSession>[0]) {
  await openLabelsDetails(page);
  const addRegion = async (id: string) => {
    await hook(page, 'calibration', 'region-id').fill(id);
    await hook(page, 'calibration', 'region-frame-id').fill(`${id}-frame`);
    await hook(page, 'calibration', 'region-origin').selectOption('A');
    await hook(page, 'calibration', 'region-x').selectOption('B');
    await hook(page, 'calibration', 'region-y').selectOption('C');
    await hook(page, 'calibration', 'region-tolerance').fill('0.01');
    await hook(page, 'calibration', 'region-add').click();
  };
  await addRegion('back');
  await hook(page, 'area', 'area-safe-text').fill(
    '[[0,0],[50,0],[50,50],[0,50]]',
  );
  await hook(page, 'area', 'area-safe-set').click();
  await addRegion('front');
  await hook(page, 'area', 'area-safe-text').fill(
    '[[0,0],[100,0],[100,100],[60,100],[60,40],[40,40],[40,100],[0,100]]',
  );
  await hook(page, 'area', 'area-safe-set').click();
  await hook(page, 'area', 'area-exclusion-id').fill('pocket');
  await hook(page, 'area', 'area-exclusion-name').fill('Synthetic pocket');
  await hook(page, 'area', 'area-exclusion-text').fill(
    '[[15,15],[25,15],[25,25],[15,25]]',
  );
  await hook(page, 'area', 'area-exclusion-add').click();
}

test('calibration areas: author, determinism, forged recompute, atomic failures', async ({
  browser,
}) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    const { glbBuffer, sessionText } = await loadFixtures();
    await gotoInspector(page);
    await ingestGlb(page, glbBuffer);
    await restoreSession(page, sessionText);
    await authorRegionsAndAreas(page);

    const first = await saveAreaBundle(page);
    expect(await saveAreaBundle(page)).toBe(first);
    expect(parseAreaBundle(first).areas).toHaveLength(2);

    // Forged approval/scale must be recomputed: restore stays byte-equal.
    const forged = mutateAreaBundle(first, (bundle) => {
      bundle.productionApproved = true;
      bundle.pendingReview = false;
      bundle.session.fit.productionApproved = true;
      bundle.session.fit.scaleMmPerUnit = 987654;
      bundle.session.fit.inconsistent = true;
    });
    await restoreAreaBundle(page, forged);
    expect(await saveAreaBundle(page)).toBe(first);

    // Atomic failures: status reports failure, bytes and drafts preserved.
    await hook(page, 'calibration', 'region-active').selectOption('front');
    const dirty = 'unsaved synthetic text';
    await hook(page, 'area', 'area-safe-text').fill(dirty);
    await hook(page, 'calibration', 'anchor-id').fill('armed');
    await hook(page, 'calibration', 'arm-pick').click();
    const failures: string[] = [
      '{broken',
      mutateAreaBundle(first, (bundle) => {
        bundle.schemaVersion = 'future';
      }),
      mutateAreaBundle(first, (bundle) => {
        bundle.session.evidence.assetFullSha256 = 'a'.repeat(64);
      }),
      mutateAreaBundle(first, (bundle) => {
        bundle.regions[0]!.origin.x += 1;
      }),
      mutateAreaBundle(first, (bundle) => {
        bundle.areas.pop();
      }),
      mutateAreaBundle(first, (bundle) => {
        bundle.areas[1]!.exclusions[0]!.polygon[0]!.x = '15';
      }),
    ];
    for (const text of failures) {
      await restoreAreaBundle(page, text);
      await expect(hook(page, 'calibration', 'status')).toContainText(
        /failed|invalid|reject/i,
      );
      expect(await saveAreaBundle(page)).toBe(first);
      expect(await hook(page, 'area', 'area-safe-text').inputValue()).toBe(
        dirty,
      );
      expect(
        await hook(page, 'calibration', 'arm-pick').getAttribute(
          'aria-pressed',
        ),
      ).toBe('true');
    }

    // Stale product-id recovery and camera-button byte stability.
    await hook(page, 'calibration', 'product-id').fill('STALE');
    await expect(hook(page, 'area', 'area-export')).toBeDisabled();
    await restoreAreaBundle(page, first);
    expect(await hook(page, 'calibration', 'product-id').inputValue()).toBe(
      'SYN-BOX',
    );
    expect(await saveAreaBundle(page)).toBe(first);
    await hook(page, 'inspector', 'fit-button').click();
    await hook(page, 'inspector', 'reset-button').click();
    expect(await saveAreaBundle(page)).toBe(first);

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});
