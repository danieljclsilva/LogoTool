import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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
  waitRestoreReady,
} from './helpers.js';
import { loadFixtures, parsePlacementBundle } from './fixtures.js';

async function seedThreePlacements(page: Page): Promise<string> {
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
  return savePlacementBundle(page);
}

test('placement restore race: busy locks and obsolete reads stay inert', async ({
  browser,
}) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    const { glbBuffer, sessionText, areaText } = await loadFixtures();
    await gotoInspector(page);
    await ingestGlb(page, glbBuffer);
    await restoreSession(page, sessionText);
    await restoreAreaBundle(page, areaText);
    const original = await seedThreePlacements(page);
    expect(parsePlacementBundle(original).placements).toHaveLength(3);

    // Defer File.text so both restores queue behind pending reads.
    await page.evaluate(() => {
      const native = File.prototype.text;
      const pending: Array<{ resolve: () => Promise<void> }> = [];
      (window as unknown as { qaPending: Array<{ resolve: () => Promise<void> }> }).qaPending =
        pending;
      File.prototype.text = function text(this: File) {
        return new Promise<string>((resolve, reject) => {
          pending.push({
            resolve: async () => {
              try {
                resolve(await native.call(this));
              } catch (error) {
                reject(error);
              }
            },
          });
        });
      };
    });
    const queueRestore = async (text: string) => {
      await hook(page, 'calibration', 'placement-restore-file').setInputFiles({
        name: 'placement-bundle.json',
        mimeType: 'application/json',
        buffer: Buffer.from(text),
      });
      await hook(page, 'calibration', 'placement-restore-button').click();
    };
    await queueRestore(original);
    await page.waitForFunction(
      () =>
        (window as unknown as { qaPending?: unknown[] }).qaPending?.length ===
        1,
    );
    await expect(hook(page, 'calibration', 'restore-button')).toBeDisabled();
    await expect(
      hook(page, 'calibration', 'area-restore-button'),
    ).toBeDisabled();
    for (const name of ['placement-add', 'placement-update', 'placement-delete',
      'placement-x', 'placement-y', 'placement-w', 'placement-h', 'placement-rot',
      'placement-logo', 'placement-region']) {
      await expect(hook(page, 'placement', name)).toBeDisabled();
    }
    await expect(
      hook(page, 'calibration', 'placement-export-button'),
    ).toBeDisabled();

    // A newer restore supersedes the pending one while the lock holds.
    await ingestGlb(page, glbBuffer);
    await queueRestore(original);
    await page.waitForFunction(
      () =>
        (window as unknown as { qaPending?: unknown[] }).qaPending?.length ===
        2,
    );
    await page.evaluate(
      () =>
        (
          window as unknown as {
            qaPending: Array<{ resolve: () => Promise<void> }>;
          }
        ).qaPending[0]?.resolve(),
    );
    // The completed obsolete read must not unlock the newer restore.
    await expect(
      hook(page, 'calibration', 'placement-restore-button'),
    ).toBeDisabled();
    await page.evaluate(
      () =>
        (
          window as unknown as {
            qaPending: Array<{ resolve: () => Promise<void> }>;
          }
        ).qaPending[1]?.resolve(),
    );
    await waitRestoreReady(page, 'placement-restore-button');
    expect(await savePlacementBundle(page)).toBe(original);

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});
