import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { addProductAndOpenSetup, gotoBuilder, openOfflineContext, assertCleanProbe } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const pw = (page: Page, name: string) => page.locator(`[data-placement-hook="${name}"]`);
async function saveJob(page: Page, info: TestInfo, name: string) {
  const download = page.waitForEvent('download');
  await b(page, 'job-save').click();
  const path = info.outputPath(name);
  await (await download).saveAs(path);
  return { path, parsed: await parseProjectPackage(new Uint8Array(await readFile(path)), { sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex') }) };
}

test('placement UX: tray provisional preview, unified lock, unblocked drag (1280x900)', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { context, page, probe } = await openOfflineContext(browser, { width: 1280, height: 900 });
  try {
    await gotoBuilder(page);
    await b(page, 'job-landing-create').click();
    await b(page, 'customer-name').fill('Synthetic placement UX');
    await b(page, 'job-ref').fill('SYN-UX-A');
    await b(page, 'intake-mode-model').check();
    const png = await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 100; image.height = 50;
      const ctx = image.getContext('2d')!; ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 100, 50);
      return image.toDataURL().split(',')[1]!;
    });
    await b(page, 'product-file').setInputFiles({ name: 'fold.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(cubeGlb(true, false)) });
    await expect(b(page, 'intake-model-status')).toContainText('ready');
    await b(page, 'product-name').fill('Synthetic UX product');
    await addProductAndOpenSetup(page);
    const setupCanvas = b(page, 'product-model').locator('canvas');
    const clickSurface = async (x: number, y: number) => {
      const box = (await setupCanvas.boundingBox())!;
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    };
    await b(page, 'product-model-expand').click();
    {
      // model-setup hooks live under data-model-setup-hook
      const ms = (name: string) => page.locator(`[data-model-setup-hook="${name}"]`);
      await ms('ref-pick-a').click();
      await clickSurface(.5, .5); await clickSurface(.56, .5);
      await ms('ref-mm').fill('300'); await ms('ref-fit').click();
      await ms('area-name').fill('Chest'); await ms('tool-rectangle').click();
      const box = (await setupCanvas.boundingBox())!;
      await page.mouse.move(box.x + box.width * .44, box.y + box.height * .42); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .55, box.y + box.height * .55, { steps: 4 });
      await page.mouse.up();
      await expect(ms('area-list')).toContainText('Chest');
    }
    await b(page, 'model-setup-save').click();
    await expect(b(page, 'model-setup-status')).toContainText('Saved 3D setup');
    await b(page, 'product-model-expand').click();
    await b(page, 'logo-file').setInputFiles({ name: 'synthetic-mark.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(b(page, 'logo-status')).toContainText('Added');
    await b(page, 'job-to-placements').click();
    await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-ready', 'true');

    // Visual artwork tray: thumbnail + name + Place action.
    await expect(pw(page, 'pw-artwork-tray')).toBeVisible();
    const place = pw(page, 'pw-artwork-grid').getByRole('button', { name: /Place .* provisional preview/ }).first();
    await place.click();
    // Immediate provisional preview: placement listed, artwork rendered.
    await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-artwork-count', /[1-9]/);
    await expect(pw(page, 'pw-placement-list').getByRole('button').first()).toBeVisible();
    // The preview is a valid draft placement with an explicit region-approved
    // default method; unknown physical size remains visibly provisional.
    await expect(pw(page, 'pw-provisional-size')).toBeVisible();
    const method = pw(page, 'pw-method');
    await expect(method).toHaveValue('embroidery');
    await method.selectOption('heat-seal');
    await pw(page, 'pw-apply').click();
    await expect(pw(page, 'pw-unresolved-method')).toHaveCount(0);
    await expect(pw(page, 'pw-review')).toBeEnabled();

    // Unified lock: checking Keep proportions then editing height scales width.
    await pw(page, 'pw-keep').check();
    const widthBefore = Number(await pw(page, 'pw-width').inputValue());
    const heightBefore = Number(await pw(page, 'pw-height').inputValue());
    await pw(page, 'pw-height').fill(String(Math.round(heightBefore * 1.25 * 100) / 100));
    const widthLive = Number(await pw(page, 'pw-width').inputValue());
    const heightLive = Number(await pw(page, 'pw-height').inputValue());
    expect(widthLive).toBeCloseTo((widthBefore / heightBefore) * heightLive, 1);
    await expect(pw(page, 'pw-apply').first()).toBeVisible();
    await pw(page, 'pw-apply').click();
    // Lock persists across the commit (Apply must not clear it).
    await expect(pw(page, 'pw-keep')).toBeChecked();
    const saved = await saveJob(page, info, 'locked.logo-project');
    const placed = saved.parsed.project.configurations[0]!.placements[0]!;
    expect(placed.widthMm).toBeCloseTo(widthLive, 1);
    expect(placed.heightMm).toBeCloseTo(heightLive, 1);
    expect(placed.method).toBe('heat-seal');

    // Drag works with staged edits present (no pending Apply gate).
    await pw(page, 'pw-height').fill(String(heightLive + 5));
    const corner = pw(page, 'pw-model-corner-2');
    await expect(corner).toBeVisible();
    const handle = (await corner.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 12, handle.y + handle.height / 2 + 12, { steps: 4 });
    await page.mouse.up();
    const dragged = await saveJob(page, info, 'dragged-pending.logo-project');
    const after = dragged.parsed.project.configurations[0]!.placements[0]!;
    expect(after.widthMm).not.toBe(placed.widthMm);
    expect(dragged.parsed.project.revision).toBe(saved.parsed.project.revision + 1);

    // Pan tool reserves pointer before logo hit testing; Fit never mutates mm.
    await pw(page, 'pw-model-pan').click();
    await expect(pw(page, 'pw-model-pan')).toHaveAttribute('aria-pressed', 'true');
    await pw(page, 'pw-model-fit').click();
    const fitted = await saveJob(page, info, 'fitted.logo-project');
    expect(fitted.parsed.project.configurations).toEqual(dragged.parsed.project.configurations);

    // Native drag/drop uses the calibrated surface under the actual drop point.
    const canvas = pw(page, 'pw-model-canvas');
    const canvasBox = (await canvas.boundingBox())!;
    await pw(page, 'pw-artwork-grid').getByRole('button', { name: /Use artwork/ }).first().dragTo(canvas, {
      targetPosition: { x: canvasBox.width * .53, y: canvasBox.height * .48 },
    });
    await expect(pw(page, 'pw-placement-list').getByRole('button')).toHaveCount(2);
    const dropped = await saveJob(page, info, 'dropped.logo-project');
    const droppedPlacement = dropped.parsed.project.configurations[0]!.placements[1]!;
    expect(droppedPlacement.pos).not.toEqual(placed.pos);
    expect(dropped.parsed.project.revision).toBe(fitted.parsed.project.revision + 1);

    // Operator history restores canonical placements, not a historical approval/revision.
    await page.getByRole('button', { name: 'Undo last placement or setup change' }).click();
    const undone = await saveJob(page, info, 'undo-drop.logo-project');
    expect(undone.parsed.project.configurations[0]!.placements).toEqual(fitted.parsed.project.configurations[0]!.placements);
    expect(undone.parsed.project.revision).toBe(dropped.parsed.project.revision + 1);
    await page.getByRole('button', { name: 'Redo last undone change' }).click();
    const redone = await saveJob(page, info, 'redo-drop.logo-project');
    expect(redone.parsed.project.configurations).toEqual(dropped.parsed.project.configurations);
    expect(redone.parsed.project.revision).toBe(undone.parsed.project.revision + 1);

    // Additional methods use the operator's actual name, with no guessed settings.
    await pw(page, 'pw-more-methods').locator('summary').click();
    await pw(page, 'pw-custom-method-name').fill('Adhesive badge');
    await pw(page, 'pw-custom-method-use').click();
    const custom = await saveJob(page, info, 'named-method.logo-project');
    expect(custom.parsed.project.configurations[0]!.placements[1]!.method).toBe('Adhesive badge');
    expect(custom.parsed.project.configurations[0]!.placements[1]!.pos).toEqual(droppedPlacement.pos);
    expect(custom.parsed.project.products[0]!.regions.some((region) => region.allowedMethods.includes('Adhesive badge'))).toBe(true);
    await page.getByRole('button', { name: 'Undo last placement or setup change' }).click();
    const methodUndone = await saveJob(page, info, 'undo-method.logo-project');
    expect(methodUndone.parsed.project.configurations).toEqual(redone.parsed.project.configurations);

    // Core controls and persistent actions fit common desktop viewports.
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1536, height: 864 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      const rail = page.locator('.pw-rail-content'); await rail.evaluate((el) => { el.scrollTop = 0; });
      await expect.poll(async () => Math.round((await canvas.boundingBox())!.height)).toBeGreaterThan(viewport.height * .5);
      for (const hook of ['pw-width', 'pw-height', 'pw-method', 'pw-keep', 'pw-rotation', 'pw-review']) {
        await expect(pw(page, hook), `${hook} fully visible at ${viewport.width}`).toBeInViewport({ ratio: 1 });
        const box = (await pw(page, hook).boundingBox())!;
        expect(box.y, `${hook} top at ${viewport.width}`).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height, `${hook} bottom at ${viewport.width}`).toBeLessThanOrEqual(viewport.height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: info.outputPath(`placement-${viewport.width}x${viewport.height}.png`) });
      const normal = (await canvas.boundingBox())!;
      await pw(page, 'pw-model-expand').click();
      const enlarged = (await canvas.boundingBox())!;
      expect(enlarged.width * enlarged.height).toBeGreaterThanOrEqual(normal.width * normal.height);
      await pw(page, 'pw-model-expand').click();
    }
    await assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});
