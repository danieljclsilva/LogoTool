import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { addProductAndOpenSetup, chooseModelTool, revealModelViewControls, gotoBuilder, openOfflineContext, assertCleanProbe } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const ms = (page: Page, name: string) => page.locator(`[data-model-setup-hook="${name}"]`);
const pw = (page: Page, name: string) => page.locator(`[data-placement-hook="${name}"]`);

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`one editing workspace preserves canvas, areas and logos at ${viewport.width}×${viewport.height}`, async ({ browser }, info) => {
    test.setTimeout(60_000);
    const { context, page, probe } = await openOfflineContext(browser, viewport);
    page.setDefaultTimeout(10_000);
    try {
      await gotoBuilder(page);
      await b(page, 'job-landing-create').click();
      await b(page, 'customer-name').fill('Synthetic unified editor');
      await b(page, 'job-ref').fill('SYN-UNIFIED');
      await b(page, 'intake-mode-model').check();
      await b(page, 'product-file').setInputFiles({ name: 'synthetic.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(cubeGlb()) });
      await expect(b(page, 'intake-model-status')).toContainText('ready');
      await b(page, 'product-name').fill('Synthetic product');
      await addProductAndOpenSetup(page);
      await expect(b(page, 'product-editor')).toBeVisible();
      await expect(b(page, 'customer-name')).toBeHidden();
      const png = await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 80; c.height = 40;
        c.getContext('2d')!.fillRect(0, 0, 80, 40); return c.toDataURL().split(',')[1]!;
      });
      await b(page, 'logo-file').setInputFiles({ name: 'test-mark.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await expect(b(page, 'logo-status')).toContainText('Added');
      await b(page, 'product-model-expand').click();
      await revealModelViewControls(page);
      await ms(page, 'view-front').click();
      await page.locator('[data-model-setup-hook="viewbar"] [data-ps-view="fit"]').click();
      const canvas = b(page, 'product-model').locator('canvas');
      const canvasHandle = await canvas.elementHandle();
      const box = (await canvas.boundingBox())!;
      expect(box.width).toBeGreaterThan(viewport.width * .85);
      expect(box.height).toBeGreaterThan(viewport.height * .45);
      await expect(ms(page, 'ref-pick-a')).toBeHidden();
      await ms(page, 'context-measure').click();
      await expect(ms(page, 'ref-pick-a')).toBeVisible();
      await ms(page, 'context-measure').press('Escape');
      await expect(ms(page, 'ref-pick-a')).toBeHidden();
      await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
      await ms(page, 'context-measure').click();
      await ms(page, 'ref-pick-a').click();
      await expect(ms(page, 'ref-pick-a')).toBeHidden();
      await page.mouse.click(box.x + box.width * .45, box.y + box.height * .5);
      await page.mouse.click(box.x + box.width * .55, box.y + box.height * .5);
      await ms(page, 'ref-mm').fill('200');
      await ms(page, 'ref-fit').click();
      await chooseModelTool(page, 'rectangle');
      // Remeasure after the tool-layout transition: contextual authoring shows
      // the Rectangle name/commands, which can shift the stage geometry.
      const drawBox = (await canvas.boundingBox())!;
      expect(drawBox.width).toBeGreaterThan(viewport.width * .85);
      expect(drawBox.height).toBeGreaterThan(viewport.height * .45);
      await page.mouse.move(drawBox.x + drawBox.width * .42, drawBox.y + drawBox.height * .4);
      await page.mouse.down();
      await page.mouse.move(drawBox.x + drawBox.width * .58, drawBox.y + drawBox.height * .6, { steps: 5 });
      await page.mouse.up();
      await expect(ms(page, 'canvas-handle-corner-0')).toBeVisible();
      await b(page, 'model-setup-save').click();
      await expect(b(page, 'model-setup-status')).toContainText('Saved 3D setup');
      await page.screenshot({ path: info.outputPath('setup.png') });
      const save = async (name: string) => {
        const download = page.waitForEvent('download'); await b(page, 'job-save').click();
        const path = info.outputPath(name); await (await download).saveAs(path);
        return parseProjectPackage(new Uint8Array(await readFile(path)), {
          sha256: async bytes => createHash('sha256').update(bytes).digest('hex'),
        });
      };
      const before = await save('before.zip');
      await b(page, 'editor-logos').click();
      await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-ready', 'true');
      expect(await pw(page, 'pw-model-canvas').evaluate((el, original) => el === original, canvasHandle)).toBe(true);
      await expect(pw(page, 'pw-add-placement')).toBeHidden();
      await pw(page, 'pw-model-details').click();
      await pw(page, 'pw-artwork-grid').getByRole('button', { name: /Place .* provisional preview/ }).first().click();
      await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-artwork-count', '1');
      await page.locator('#placement-context [data-canvas-context-dismiss]').click();
      await expect(pw(page, 'pw-add-placement')).toBeHidden();
      const reviewBox = (await pw(page, 'pw-review').boundingBox())!;
      expect(reviewBox.y + reviewBox.height).toBeLessThan(viewport.height - 8);
      await page.screenshot({ path: info.outputPath('logos.png') });
      await b(page, 'editor-setup').click();
      expect(await canvas.evaluate((el, original) => el === original, canvasHandle)).toBe(true);
      await expect(ms(page, 'canvas-handle-corner-0')).toBeVisible();
      const after = await save('after.zip');
      expect(after.project.products).toEqual(before.project.products);
      expect(after.project.configurations.flatMap(c => c.placements)).toHaveLength(1);
      await b(page, 'editor-logos').click();
      await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-artwork-count', '1');
      await expect(b(page, 'product-model').locator('canvas')).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      assertCleanProbe(probe);
    } finally { await context.close(); }
  });
}
