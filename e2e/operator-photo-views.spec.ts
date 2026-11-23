import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import {
  addProductAndOpenSetup,
  ensurePlacementPanel,
  gotoBuilder,
  openOfflineContext,
  revealBuilderControl,
  type Probe,
} from './helpers.js';

// Phase 2 operator photo-view isolation (regression-owned): a fresh Images
// job with two separately measured views (Front/Back, independently
// calibrated) and one logo placement per region. Selecting a placement must
// bring its view into context — on a photo only geometry bound to that exact
// calibrated view renders (overlay + one area polygon + that placement's
// footprint), with no projection of one region into another frame, and saved
// millimetre values never mutate on navigation. Normal UI only (no direct
// API shortcuts), synthetic fixtures only, offline file:// throughout.

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

function pw(page: Page, name: string) {
  return page.locator(`[data-placement-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openStation(
  browser: Browser,
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page; probe: Probe }> {
  const { context, page, probe } = await openOfflineContext(browser, viewport);
  await gotoBuilder(page);
  await expect(page.locator('[data-job-landing]')).toBeVisible();
  await builder(page, 'job-landing-create').click();
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
  return { context, page, probe };
}

/** Synthetic PNG bytes with a distinct fill, size and letter mark. */
async function syntheticPng(
  page: Page,
  fill: string,
  w: number,
  h: number,
  letter: string,
): Promise<Uint8Array> {
  const base64 = await page.evaluate(
    ({ color, width, height, mark }): string => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('2d canvas unavailable for synthetic PNG fixture.');
      context.fillStyle = color;
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#ffffff';
      context.fillRect(10, 10, Math.min(90, width - 20), Math.min(60, height - 20));
      context.fillStyle = '#000000';
      context.font = 'bold 40px sans-serif';
      context.fillText(mark, 28, 55);
      return canvas.toDataURL('image/png').split(',')[1] ?? '';
    },
    { color: fill, width: w, height: h, mark: letter },
  );
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Measure one intake view through the guided rectangle + atomic save. */
async function measureView(
  page: Page,
  label: string,
  widthMm: string,
  heightMm: string,
): Promise<void> {
  const workspace = builder(page, 'product-workspace');
  await workspace.getByRole('tab', { name: label }).click();
  await workspace.getByRole('button', { name: 'Set up scale' }).click();
  const guided = builder(page, 'guided-scale');
  await expect(guided).toBeVisible();
  const overlay = guided.locator('.guided-scale-overlay[aria-label*="rectangle corners"]');
  await expect(overlay).toBeVisible();
  const box = (await overlay.boundingBox())!;
  const corner = async (fx: number, fy: number) => {
    await overlay.click({
      position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) },
    });
  };
  await corner(0.25, 0.25);
  await corner(0.75, 0.25);
  await corner(0.75, 0.75);
  await corner(0.25, 0.75);
  await guided.locator('[data-guided="width"]').fill(widthMm);
  await guided.locator('[data-guided="height"]').fill(heightMm);
  await guided.locator('[data-guided="create"]').click();
  await expect(await shown(page, 'workspace-status')).toContainText(
    `Measured the ${label} view: ${widthMm}×${heightMm}`,
  );
  await workspace.getByRole('button', { name: 'Save product setup' }).click();
  await expect(workspace.getByText(/Saved /)).toBeVisible();
}

/** Add one logo placement through the visible add form. Labels are resolved
 *  from the live selects so renames never silently pass the wrong scope. */
async function addPlacementForArea(
  page: Page,
  logoLabel: string,
  areaLabel: string,
  widthMm: string,
  heightMm: string,
): Promise<void> {
  const host = builder(page, 'job-placement-host');
  await ensurePlacementPanel(page);
  await host.getByRole('button', { name: 'Add logo placement' }).click();
  await pw(page, 'pw-add-logo').selectOption({ label: logoLabel });
  const area = pw(page, 'pw-add-area');
  if ((await area.count()) > 0) await area.selectOption({ label: areaLabel });
  const addMethod = pw(page, 'pw-add-method');
  if ((await addMethod.count()) > 0) await addMethod.selectOption('heat-seal');
  const keep = pw(page, 'pw-add-keep');
  if ((await keep.count()) > 0) await keep.uncheck();
  await pw(page, 'pw-add-width').fill(widthMm);
  await pw(page, 'pw-add-height').fill(heightMm);
  await pw(page, 'pw-add-confirm').click();
  await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText(
    logoLabel,
  );
}

async function selectedMm(page: Page): Promise<{ width: string; x: string }> {
  return {
    width: await pw(page, 'pw-width').inputValue(),
    x: await pw(page, 'pw-x').inputValue(),
  };
}

/** After selecting a placement row, exactly its view stays in context. */
async function expectIsolatedView(
  page: Page,
  viewLabel: string,
  logoLabel: string,
  tabHookId: string,
): Promise<void> {
  const host = builder(page, 'job-placement-host');
  await host
    .locator('[data-placement-hook^="pw-placement-row-"]', { hasText: logoLabel })
    .click();
  const tab = host
    .locator('[data-placement-hook^="pw-view-tab-"]')
    .filter({ hasText: viewLabel });
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(await tab.getAttribute('data-placement-hook')).toBe(tabHookId);
  const otherLabel = viewLabel === 'Back' ? 'Front' : 'Back';
  await expect(
    host.locator('[data-placement-hook^="pw-view-tab-"]').filter({ hasText: otherLabel }),
  ).toHaveAttribute('aria-selected', 'false');
  await expect(host.locator('[data-placement-hook="pw-overlay-image"]')).toBeVisible();
  await expect(host.locator('[data-placement-hook="pw-overlay-image"]')).toHaveCount(1);
  const areas = host.locator('polygon[data-placement-hook^="pw-area-"]');
  await expect(areas).toHaveCount(1);
  await expect(areas.locator('title')).toContainText(viewLabel);
  const footprints = host.locator('polygon[data-placement-index]');
  await expect(footprints).toHaveCount(1);
  await expect(footprints.locator('title')).toContainText(logoLabel);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
}

test('operator photo views stay isolated per placement selection', async ({ browser }) => {
  test.setTimeout(45_000);
  const desktop = { width: 1440, height: 900 };
  const { context, page, probe } = await openStation(browser, desktop);
  page.setDefaultTimeout(6000);
  try {
    await (await shown(page, 'customer-name')).fill('Isolation Checks Ltd');
    await (await shown(page, 'job-ref')).fill('ISO-01');

    // Fresh intake: two distinctly named mapped views with distinct bytes.
    const frontPng = await syntheticPng(page, '#1d6f3a', 400, 300, 'F');
    const backPng = await syntheticPng(page, '#6f1d3a', 400, 300, 'B');
    assert.notDeepEqual(
      Array.from(frontPng),
      Array.from(backPng),
      'view photos must differ',
    );
    const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
    await expect(rows).toHaveCount(1);
    await rows.first().locator('input[type="text"]').fill('Front');
    await rows.first().locator('input[type="file"]').setInputFiles({
      name: 'front.png',
      mimeType: 'image/png',
      buffer: Buffer.from(frontPng),
    });
    await expect(rows.first().locator('.view-row-state')).toContainText('ready');
    await (await shown(page, 'product-view-add')).click();
    await expect(rows).toHaveCount(2);
    await rows.nth(1).locator('input[type="text"]').fill('Back');
    await rows.nth(1).locator('input[type="file"]').setInputFiles({
      name: 'back.png',
      mimeType: 'image/png',
      buffer: Buffer.from(backPng),
    });
    await expect(rows.nth(1).locator('.view-row-state')).toContainText('ready');
    await (await shown(page, 'product-name')).fill('Isolation jacket');
    await addProductAndOpenSetup(page);
    await expect(await shown(page, 'product-status')).toContainText('Added');

    const workspace = builder(page, 'product-workspace');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    await expect(workspace.getByRole('tab', { name: 'Back' })).toBeVisible();

    // Each view measured and saved independently.
    await measureView(page, 'Front', '280', '200');
    await measureView(page, 'Back', '280', '200');

    // Two distinct logos (distinct names and bytes).
    const frontLogoPng = await syntheticPng(page, '#d4af37', 200, 120, 'F');
    const backLogoPng = await syntheticPng(page, '#b03030', 160, 160, 'B');
    assert.notDeepEqual(
      Array.from(frontLogoPng),
      Array.from(backLogoPng),
      'logo fixtures must differ',
    );
    await (await shown(page, 'logo-file')).setInputFiles({
      name: 'front-logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(frontLogoPng),
    });
    await expect(await shown(page, 'logo-status')).toContainText('Added front-logo.png');
    await (await shown(page, 'logo-file')).setInputFiles({
      name: 'back-logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(backLogoPng),
    });
    await expect(await shown(page, 'logo-status')).toContainText('Added back-logo.png');

    await (await shown(page, 'job-to-placements')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    const host = builder(page, 'job-placement-host');
    await ensurePlacementPanel(page);

    // Resolve live option labels; the add form must offer both regions.
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    const logoOptions = await pw(page, 'pw-add-logo').locator('option').allInnerTexts();
    const areaOptions = await pw(page, 'pw-add-area').locator('option').allInnerTexts();
    const frontLogoLabel = logoOptions.find((text) => text.toLowerCase().includes('front'))!;
    const backLogoLabel = logoOptions.find((text) => text.toLowerCase().includes('back'))!;
    const frontAreaLabel = areaOptions.find((text) => text.includes('Front'))!;
    const backAreaLabel = areaOptions.find((text) => text.includes('Back'))!;
    assert.ok(frontLogoLabel, 'front logo option exists');
    assert.ok(backLogoLabel, 'back logo option exists');
    assert.ok(frontAreaLabel, 'front region option exists');
    assert.ok(backAreaLabel, 'back region option exists');
    await pw(page, 'pw-add-cancel').click();
    await addPlacementForArea(page, frontLogoLabel, frontAreaLabel, '90', '40');
    await addPlacementForArea(page, backLogoLabel, backAreaLabel, '80', '35');

    // Both placement rows exist.
    const placementRows = host.locator('[data-placement-hook^="pw-placement-row-"]');
    await expect(placementRows).toHaveCount(2);
    await expect(placementRows.filter({ hasText: frontLogoLabel })).toHaveCount(1);
    await expect(placementRows.filter({ hasText: backLogoLabel })).toHaveCount(1);

    // Stable view-tab ids before selection assertions.
    const frontTabHook =
      (await host
        .locator('[data-placement-hook^="pw-view-tab-"]')
        .filter({ hasText: 'Front' })
        .getAttribute('data-placement-hook')) ?? '';
    const backTabHook =
      (await host
        .locator('[data-placement-hook^="pw-view-tab-"]')
        .filter({ hasText: 'Back' })
        .getAttribute('data-placement-hook')) ?? '';
    assert.ok(frontTabHook.startsWith('pw-view-tab-'), 'front tab has a stable id');
    assert.ok(backTabHook.startsWith('pw-view-tab-'), 'back tab has a stable id');
    assert.notEqual(frontTabHook, backTabHook, 'view tabs have distinct ids');

    // Baselines: saved mm per placement before navigation.
    await placementRows.filter({ hasText: frontLogoLabel }).click();
    const frontBaseline = await selectedMm(page);
    await placementRows.filter({ hasText: backLogoLabel }).click();
    const backBaseline = await selectedMm(page);

    // Selecting Back isolates the Back view; mm values are untouched.
    await expectIsolatedView(page, 'Back', backLogoLabel, backTabHook);
    expect(await selectedMm(page)).toEqual(backBaseline);

    // Selecting Front symmetrically isolates the Front view.
    await expectIsolatedView(page, 'Front', frontLogoLabel, frontTabHook);
    expect(await selectedMm(page)).toEqual(frontBaseline);

    // Round trip back to Back: same tab id, same geometry, same mm.
    await expectIsolatedView(page, 'Back', backLogoLabel, backTabHook);
    expect(await selectedMm(page)).toEqual(backBaseline);

    // Direct view navigation also selects the placement shown on the stage.
    await host.getByRole('tab', { name: 'Front', exact: true }).click();
    await expect(placementRows.filter({ hasText: frontLogoLabel })).toHaveClass(/is-selected/);
    expect(await selectedMm(page)).toEqual(frontBaseline);
    await host.getByRole('tab', { name: 'Back', exact: true }).click();
    await expect(placementRows.filter({ hasText: backLogoLabel })).toHaveClass(/is-selected/);
    expect(await selectedMm(page)).toEqual(backBaseline);

    await host.getByRole('button', { name: `Use artwork ${frontLogoLabel}: fills the add form` }).click();
    await expect(pw(page, 'pw-add-logo').locator('option:checked')).toHaveText(frontLogoLabel);
    await expect(pw(page, 'pw-add-area').locator('option:checked')).toHaveText(backAreaLabel);
    await expect(placementRows).toHaveCount(2);
    await pw(page, 'pw-add-cancel').click();
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await expect(pw(page, 'pw-add-logo').locator('option:checked')).toHaveText(backLogoLabel);
    await expect(pw(page, 'pw-add-area').locator('option:checked')).toHaveText(backAreaLabel);
    await pw(page, 'pw-add-cancel').click();

    // Desktop 1440x900: stage + placement form side by side, no overflow.
    const stage = host.locator('[data-placement-hook="pw-stage-svg"]');
    await expect(stage).toBeVisible();
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toBeVisible();
    const stageBox = (await stage.boundingBox())!;
    const listBox = (await host
      .locator('[data-placement-hook="pw-placement-list"]')
      .boundingBox())!;
    const sideBySide =
      stageBox.x + stageBox.width <= listBox.x + 4 ||
      listBox.x + listBox.width <= stageBox.x + 4;
    expect(sideBySide).toBe(true);
    await expectNoHorizontalOverflow(page);

    // Narrow 390x844: stage visible, form reachable, no overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(stage).toBeVisible();
    const narrowList = host.locator('[data-placement-hook="pw-placement-list"]');
    await narrowList.scrollIntoViewIfNeeded();
    await expect(narrowList).toBeVisible();
    await host
      .locator('[data-placement-hook^="pw-placement-row-"]', { hasText: backLogoLabel })
      .scrollIntoViewIfNeeded();
    await expect(
      host.locator('[data-placement-hook^="pw-placement-row-"]', { hasText: backLogoLabel }),
    ).toBeVisible();
    await expect(stage).toBeVisible();
    await expectNoHorizontalOverflow(page);

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.httpRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
