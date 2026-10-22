import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  saveAreaBundle,
  savePlacementBundle,
} from './helpers.js';
import { loadFixtures, parsePlacementBundle } from './fixtures.js';

// Asset replacement must reset calibration/areas/placements state: product id
// emptied and exports disabled; the old saved bundle must fail to restore.
test('asset replacement resets session, areas and placements', async ({
  browser,
}) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    const { glbBuffer, sessionText, areaText } = await loadFixtures();
    await gotoInspector(page);
    await ingestGlb(page, glbBuffer);
    await restoreSession(page, sessionText);
    await restoreAreaBundle(page, areaText);
    const seeded = await saveAreaBundle(page);
    expect(JSON.parse(seeded).areas.length).toBeGreaterThan(0);

    await addPlacement(page, { logo: 'SYN-LOGO-A', region: 'back', x: 25, y: 25, w: 10, h: 6, rot: 30 });
    const savedPlacement = await savePlacementBundle(page);
    expect(parsePlacementBundle(savedPlacement).placements).toHaveLength(1);

    // Ingest a different asset (checked-in tetra) — full reset expected.
    const tetra = await fs.readFile('examples/models/synthetic-tetra.glb');
    await ingestGlb(page, tetra);
    expect(await hook(page, 'calibration', 'product-id').inputValue()).toBe(
      '',
    );
    await expect(hook(page, 'area', 'area-export')).toBeDisabled();
    await expect(
      hook(page, 'calibration', 'placement-export-button'),
    ).toBeDisabled();
    // Restoring the old placement bundle against the new asset must fail
    // atomically (wrong-asset hash).
    await restorePlacementBundle(page, savedPlacement);
    await expect(hook(page, 'calibration', 'status')).toContainText(
      /failed/i,
    );

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

// The built inspector must work from a copied folder (name with spaces,
// no siblings): copy the single HTML file to a temp dir and drive it there.
test('standalone copy runs with no sibling dependencies', async ({
  browser,
}) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'logotool inspector copy '));
  const copied = join(dir, 'asset-inspector.html');
  await fs.copyFile('dist/dev/asset-inspector.html', copied);
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(pathToFileURL(copied).href);
    await expect(page).toHaveTitle(/Logo Station/);
    const { glbBuffer } = await loadFixtures();
    await ingestGlb(page, glbBuffer);
    await expect(hook(page, 'inspector', 'status')).toContainText(/^Showing/);
    assertCleanProbe(probe);
  } finally {
    await context.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
