import { test, expect, type Page } from '@playwright/test';
import { gotoBuilder, openOfflineContext, assertCleanProbe } from './helpers.js';
import { customerModelPackage } from './fixtures/customer-model-package.js';
const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const pw = (page: Page, name: string) => page.locator(`[data-placement-hook="${name}"]`);
const ms = (page: Page, name: string) => page.locator(`[data-model-setup-hook="${name}"]`);
async function openModel(page: Page) {
  await gotoBuilder(page);
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    canvas.getContext('2d')!.fillRect(0, 0, 100, 100); return canvas.toDataURL().split(',')[1]!;
  });
  const pkg = await customerModelPackage(new Uint8Array(Buffer.from(image, 'base64')));
  await b(page, 'job-open-file').setInputFiles({ name: 'round2.logo-project', mimeType: 'application/zip', buffer: Buffer.from(pkg.bytes) });
  await b(page, 'product-list').getByRole('checkbox').first().check();
  await b(page, 'job-step-2').click();
}

test('round 2 calibration warning is advisory, value-scoped and dismissible', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser, { width: 1290, height: 700 });
  try {
    await openModel(page); await b(page, 'editor-setup').click(); await ms(page, 'context-measure').click();
    await ms(page, 'ref-mm').fill('22000'); await ms(page, 'ref-fit').click();
    await expect(ms(page, 'calibration-warning')).toContainText('22,000 mm');
    await expect(ms(page, 'ref-fit')).toBeEnabled();
    await ms(page, 'calibration-warning-dismiss').click();
    await ms(page, 'ref-fit').click(); await expect(ms(page, 'calibration-warning')).toHaveCount(0);
    await ms(page, 'ref-mm').fill('23000'); await ms(page, 'ref-fit').click();
    await expect(ms(page, 'calibration-warning')).toContainText('23,000 mm');
    await ms(page, 'ref-mm').fill('300'); await ms(page, 'ref-fit').click();
    await expect(ms(page, 'calibration-warning')).toHaveCount(0);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

for (const viewport of [{ width: 1290, height: 700 }, { width: 1440, height: 900 }]) {
  test(`round 2 dock, footer, header and field order at ${viewport.width}`, async ({ browser }) => {
    const { context, page, probe } = await openOfflineContext(browser, viewport);
    try {
      await openModel(page); await b(page, 'editor-logos').click(); await pw(page, 'pw-model-details').click();
      await pw(page, 'pw-placement-list').getByRole('button').first().click();
      const panel = page.locator('#placement-context');
      await expect(panel).toHaveAttribute('aria-label', 'Placement details');
      expect(await panel.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await expect(panel.locator('.canvas-context-content')).toHaveCSS('overflow-y', 'visible');
      const canvas = (await b(page, 'product-model-canvas').boundingBox())!;
      const dock = (await panel.boundingBox())!;
      expect(canvas.x + canvas.width).toBeLessThanOrEqual(dock.x);
      const rows = await pw(page, 'pw-placement-list').getByRole('button').all();
      for (const row of rows) {
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(60);
        await expect(row).toHaveAttribute('title', /artwork/);
      }
      await pw(page, 'pw-width').focus(); await page.keyboard.press('Tab'); await expect(pw(page, 'pw-height')).toBeFocused();
      await pw(page, 'pw-height').focus(); await page.keyboard.press('Tab'); await expect(pw(page, 'pw-keep')).toBeFocused();
      await page.keyboard.press('Tab'); await expect(pw(page, 'pw-rotation')).toBeFocused();
      await panel.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await pw(page, 'pw-remove').scrollIntoViewIfNeeded();
      await expect(pw(page, 'pw-remove')).toBeInViewport({ ratio: 1 });
      for (const enlarged of [false, true]) {
        if (enlarged) await b(page, 'product-model-expand').click();
        await expect(pw(page, 'pw-review')).toBeInViewport();
        await expect(pw(page, 'pw-back')).toBeInViewport();
        await expect(b(page, 'job-save')).toBeInViewport();
        await expect(page.getByRole('button', { name: 'Undo last placement or setup change', exact: true })).toBeInViewport();
        expect(await b(page, 'job-save').evaluate(node => Boolean(node.closest('.station-header')))).toBe(true);
      }
      await pw(page, 'pw-remove').click(); await expect(pw(page, 'pw-placement-list').getByRole('button')).toHaveCount(1);
      await page.getByRole('button', { name: 'Undo last placement or setup change', exact: true }).click();
      await expect(pw(page, 'pw-placement-list').getByRole('button')).toHaveCount(2);
      assertCleanProbe(probe);
    } finally { await context.close(); }
  });
}

test('round 2 pristine Prepare has neutral validation and a ready disabled reason', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser, { width: 768, height: 1024 });
  try {
    await gotoBuilder(page); await expect(b(page, 'job-save')).toBeDisabled();
    await b(page, 'job-landing-create').click(); await expect(b(page, 'selection-error')).toBeEmpty();
    await expect(b(page, 'job-prepare-gate')).toContainText('Include at least one product');
    await expect(b(page, 'product-list')).toContainText('No products yet.');
    await expect(b(page, 'intake-view-count')).toHaveText('0 of 12 views');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});


test('round 2 new placements start locked and save styling follows clean and pending edits', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser, { width: 1290, height: 700 });
  try {
    await openModel(page); await b(page, 'editor-logos').click(); await pw(page, 'pw-model-details').click();
    await pw(page, 'pw-add-placement').click();
    await expect(pw(page, 'pw-add-keep')).toBeChecked();
    await pw(page, 'pw-add-cancel').click();
    const download = page.waitForEvent('download'); await b(page, 'job-save').click(); await download;
    await expect(b(page, 'job-save')).not.toHaveClass(/is-dirty/);
    await pw(page, 'pw-placement-list').getByRole('button').first().click();
    await pw(page, 'pw-width').fill('');
    await expect(b(page, 'job-save')).toHaveClass(/is-dirty/);
    await expect(pw(page, 'pw-apply')).toBeDisabled();
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
