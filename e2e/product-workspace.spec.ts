import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gotoBuilder, openOfflineContext, assertCleanProbe } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const ms = (page: Page, name: string) => page.locator(`[data-model-setup-hook="${name}"]`);
const pw = (page: Page, name: string) => page.locator(`[data-placement-hook="${name}"]`);
async function saveJob(page: Page, info: TestInfo, name: string, keyboard = false) {
  const download = page.waitForEvent('download');
  const button = b(page, 'job-save');
  if (keyboard) { await button.evaluate((node) => (node as HTMLElement).focus({ preventScroll: true })); await button.press('Enter'); }
  else await button.click();
  const path = info.outputPath(name);
  await (await download).saveAs(path);
  return { path, parsed: await parseProjectPackage(new Uint8Array(await readFile(path)), { sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex') }) };
}
for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`product workspace: live outline, enlarged controls, artwork and physical movement (${viewport.width})`, async ({ browser }, info) => {
    test.setTimeout(120_000);
    const { context, page, probe } = await openOfflineContext(browser, viewport);
    try {
      await gotoBuilder(page);
      await b(page, 'job-landing-create').click();
      await b(page, 'customer-name').fill('Synthetic product workspace');
      await b(page, 'job-ref').fill('SYN-WORKSPACE');
      await b(page, 'intake-mode-model').check();
      // No normals: imported garments can use derivative normals. Decals must
      // still render using actual triangle positions, not disappear silently.
      await b(page, 'product-file').setInputFiles({ name: 'fold.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(cubeGlb(true, false)) });
      await expect(b(page, 'intake-model-status')).toContainText('ready');
      await b(page, 'product-name').fill('Synthetic folded product');
      await b(page, 'product-add').click();
      const setup = b(page, 'product-model');
      const canvas = setup.locator('canvas');
      const clickSurface = async (x: number, y: number) => {
        const box = (await canvas.boundingBox())!;
        await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      };
      const normalHeight = (await canvas.boundingBox())!.height;
      if (viewport.width >= 700) expect(normalHeight).toBeGreaterThanOrEqual(viewport.height * .6);
      await b(page, 'product-model-expand').click();
      await ms(page, 'view-front').click();
      await page.locator('[data-model-setup-hook="viewbar"] [data-ps-view="fit"]').click();
      await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
      await expect(b(page, 'product-model-expand')).toHaveAccessibleName('Close enlarged product workspace');
      expect((await canvas.boundingBox())!.height).toBeGreaterThan(normalHeight);

      await ms(page, 'context-measure').click();
      for (const hook of ['ref-pick-a', 'ref-pick-b', 'ref-mm', 'ref-fit', 'tool-rectangle']) {
        const control = ms(page, hook);
        expect(await setup.locator(`[data-model-setup-hook="${hook}"]`).count()).toBe(1);
        await expect(control).toBeVisible();
      }
      const stageBox = (await canvas.boundingBox())!;
      expect(stageBox.height).toBeGreaterThanOrEqual(180);
      if (viewport.width >= 700) expect(stageBox.y).toBeLessThan(150);
      // Polygon cancellation belongs to the editor, not the enclosing dialog.

      await ms(page, 'tool-freehand').click();
      await clickSurface(.48,.48); await clickSurface(.52,.48);
      await page.keyboard.press('Escape');
      await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
      await expect(ms(page, 'tool-rotate')).toHaveAttribute('aria-pressed', 'true');

      await ms(page, 'context-measure').click();
      await ms(page, 'ref-pick-a').click();

      await clickSurface(.5, .5); await clickSurface(.56, .5);

      await ms(page, 'ref-mm').fill('300'); await ms(page, 'ref-fit').click();
      await expect(ms(page, 'reference-scale')).toContainText('scale 1 unit =');

      await ms(page, 'area-name').fill('Chest'); await ms(page, 'tool-rectangle').click();
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width * .44, box.y + box.height * .42); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .55, box.y + box.height * .55, { steps: 4 });
      await expect(ms(page, 'live-outline').locator('polygon')).toBeVisible();
      await expect(ms(page, 'area-list')).toContainText('No safe areas yet');
      await page.screenshot({ path: info.outputPath('during-draw.png') });
      await page.mouse.up();
      await expect(ms(page, 'area-list')).toContainText('Chest');
      await b(page, 'model-setup-save').click();
      await expect(b(page, 'model-setup-status')).toContainText('Saved 3D setup');
      await b(page, 'product-model-expand').click();
      const png = await page.evaluate(() => {
        const image = document.createElement('canvas'); image.width = 100; image.height = 50;
        const ctx = image.getContext('2d')!; ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 100, 50); ctx.fillStyle = '#00ffff'; ctx.fillRect(0, 0, 100, 12);
        return image.toDataURL().split(',')[1]!;
      });
      await b(page, 'logo-file').setInputFiles({ name: 'synthetic-mark.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await expect(b(page, 'logo-status')).toContainText('Added');
      await b(page, 'editor-logos').click();
      await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-ready', 'true');
      await expect(pw(page, 'pw-stage-svg')).toHaveCount(0);
      await pw(page, 'pw-model-front').click();
      await pw(page, 'pw-model-details').click();
      await pw(page, 'pw-add-placement').click();
      await pw(page, 'pw-add-width').fill('120'); await pw(page, 'pw-add-height').fill('60');
      await pw(page, 'pw-add-method').selectOption('print'); await pw(page, 'pw-add-confirm').click();
      await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-artwork-count', /[1-9]/);
      const modelCanvas = pw(page, 'pw-model-canvas');
      await modelCanvas.scrollIntoViewIfNeeded();
      await pw(page, 'pw-model-fit').click();
      await page.screenshot({path:info.outputPath('artwork-preview.png')});
      await expect.poll(async () => modelCanvas.evaluate((node) => {
        const copy = document.createElement('canvas'); copy.width = (node as HTMLCanvasElement).width; copy.height = (node as HTMLCanvasElement).height;
        const ctx = copy.getContext('2d')!; ctx.drawImage(node as HTMLCanvasElement, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data; let coloured = 0;
        for (let at = 0; at < pixels.length; at += 4) if (pixels[at]! > 170 && pixels[at + 1]! < 90 && pixels[at + 2]! > 170) coloured++;
        return coloured;
      })).toBeGreaterThan(10);
      // The original image's cyan top stripe must face outside and remain
      // above its magenta body, even when the drawn polygon winds inward.
      const orientation = await modelCanvas.evaluate((node) => {
        const canvas = node as HTMLCanvasElement, copy = document.createElement('canvas');
        copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext('2d')!; ctx.drawImage(canvas, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let topY = 0, topCount = 0, bodyY = 0, bodyCount = 0;
        for (let at = 0; at < pixels.length; at += 4) {
          const y = Math.floor(at / 4 / copy.width);
          if (pixels[at]! < 90 && pixels[at + 1]! > 170 && pixels[at + 2]! > 170) { topY += y; topCount++; }
          if (pixels[at]! > 170 && pixels[at + 1]! < 90 && pixels[at + 2]! > 170) { bodyY += y; bodyCount++; }
        }
        return { topY: topY / topCount, bodyY: bodyY / bodyCount, topCount, bodyCount };
      });
      expect(orientation.topCount).toBeGreaterThan(0);
      expect(orientation.topY).toBeLessThan(orientation.bodyY);
      const precise = pw(page, 'pw-precise-position');
      await precise.locator('summary').click();
      const xBefore = await pw(page, 'pw-x').inputValue(), yBefore = await pw(page, 'pw-y').inputValue();
      await pw(page, 'pw-x').fill(String(Number(xBefore) + 1));
      await expect(precise).toHaveAttribute('open', '');
      await pw(page, 'pw-y').fill(String(Number(yBefore) + 1));
      await expect(precise).toHaveAttribute('open', '');
      await pw(page, 'pw-x').fill(xBefore); await pw(page, 'pw-y').fill(yBefore);
      const original = await saveJob(page, info, 'original.logo-project');
      await b(page, 'product-model-expand').click();
      await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
      await pw(page, 'pw-model-zoom-in').click(); await pw(page, 'pw-model-fit').click();
      const unchanged = await saveJob(page, info, 'zoomed.logo-project');
      expect(unchanged.parsed.project.configurations).toEqual(original.parsed.project.configurations);

      await pw(page, 'pw-placement-list').getByRole('button').first().click();

      if (await page.locator('#placement-context').isVisible()) await page.locator('#placement-context [data-canvas-context-dismiss]').click();
      await pw(page, 'pw-model-move').click();
      const target = (await modelCanvas.boundingBox())!;
      await modelCanvas.click({ position: { x: target.width * .52, y: target.height * .5 } });
      const moved = await saveJob(page, info, 'moved.logo-project');
      const first = original.parsed.project.configurations[0]!.placements[0]!;
      const second = moved.parsed.project.configurations[0]!.placements[0]!;
      expect(second.pos).not.toEqual(first.pos);
      expect(second.widthMm).toBe(first.widthMm); expect(second.heightMm).toBe(first.heightMm); expect(second.rotationDeg).toBe(first.rotationDeg);
      expect(moved.parsed.project.products).toEqual(original.parsed.project.products);
      expect(moved.parsed.project.revision).toBe(original.parsed.project.revision + 1);
      // Locate actual rendered artwork pixels, then drag the visible logo
      // itself. This exercises model hit testing and grab-offset preservation.
      const artworkCentre = await modelCanvas.evaluate((node) => {
        const canvas = node as HTMLCanvasElement, copy = document.createElement('canvas');
        copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext('2d')!; ctx.drawImage(canvas, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let x = 0, y = 0, count = 0;
        for (let at = 0; at < pixels.length; at += 4) if (pixels[at]! > 170 && pixels[at + 1]! < 90 && pixels[at + 2]! > 170) {
          x += (at / 4) % copy.width; y += Math.floor(at / 4 / copy.width); count++;
        }
        const box = canvas.getBoundingClientRect();
        return { x: box.left + x / count * box.width / copy.width, y: box.top + y / count * box.height / copy.height, count };
      });
      expect(artworkCentre.count).toBeGreaterThan(0);
      await page.mouse.move(artworkCentre.x, artworkCentre.y); await page.mouse.down();
      await page.mouse.move(artworkCentre.x + 8, artworkCentre.y, { steps: 4 }); await page.mouse.up();
      let dragged = await saveJob(page, info, 'dragged.logo-project');
      expect(dragged.parsed.project.configurations[0]!.placements[0]!.pos).not.toEqual(second.pos);
      expect(dragged.parsed.project.revision).toBe(moved.parsed.project.revision + 1);
      expect(dragged.parsed.project.products).toEqual(original.parsed.project.products);

      // Direct calibrated on-logo handles: live values are transient, one
      // release commits, camera/view changes never enter physical geometry.
      const firstPlacement = (saved: typeof dragged) => saved.parsed.project.configurations[0]!.placements[0]!;
      const field = async (name: string) => Number(await pw(page, name).inputValue());
      const corner = pw(page, 'pw-model-corner-2');
      await expect(corner).toBeVisible();
      const handle = (await corner.boundingBox())!;
      const resizeStart = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      const opposite = (await pw(page, 'pw-model-corner-0').boundingBox())!;
      const resizeEnd = { x: resizeStart.x + (resizeStart.x - opposite.x - opposite.width / 2) * .2,
        y: resizeStart.y + (resizeStart.y - opposite.y - opposite.height / 2) * .2 };
      const widthBefore = await field('pw-width'), heightBefore = await field('pw-height');
      await page.keyboard.down('Shift');
      await page.mouse.move(resizeStart.x, resizeStart.y); await page.mouse.down();
      await page.mouse.move(resizeEnd.x, resizeEnd.y, { steps: 4 });
      await expect.poll(async () => Math.abs(await field('pw-width') - widthBefore) + Math.abs(await field('pw-height') - heightBefore)).toBeGreaterThan(0.1);
      const liveWidth = await field('pw-width'), liveHeight = await field('pw-height');
      const duringResize = await saveJob(page, info, 'during-resize.logo-project', true);
      expect(duringResize.parsed.project.configurations).toEqual(dragged.parsed.project.configurations);
      await page.mouse.up(); await page.keyboard.up('Shift');
      const resized = await saveJob(page, info, 'resized.logo-project');
      expect(firstPlacement(resized).widthMm).toBeCloseTo(liveWidth, 1);
      expect(firstPlacement(resized).widthMm).toBeGreaterThan(widthBefore);
      expect(firstPlacement(resized).heightMm).toBeGreaterThan(heightBefore);
      expect(firstPlacement(resized).heightMm).toBeCloseTo(liveHeight, 1);
      expect(resized.parsed.project.revision).toBe(dragged.parsed.project.revision + 1);
      expect(resized.parsed.project.products).toEqual(dragged.parsed.project.products);
      // Cancellation restores fields and committed bytes even with capture lost.
      const cancelHandle = (await corner.boundingBox())!;
      await page.mouse.move(cancelHandle.x + cancelHandle.width / 2, cancelHandle.y + cancelHandle.height / 2); await page.mouse.down();
      await page.mouse.move(cancelHandle.x + cancelHandle.width / 2 + 9, cancelHandle.y + cancelHandle.height / 2 + 6, { steps: 4 });
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.mouse.up();
      expect(await field('pw-width')).toBeCloseTo(firstPlacement(resized).widthMm, 1);
      const cancelledResize = await saveJob(page, info, 'cancelled-resize.logo-project');
      expect(cancelledResize.parsed.project.configurations).toEqual(resized.parsed.project.configurations);
      const rotateHandle = (await pw(page, 'pw-model-rotate-handle').boundingBox())!;
      await page.keyboard.down('Shift');
      await page.mouse.move(rotateHandle.x + rotateHandle.width / 2, rotateHandle.y + rotateHandle.height / 2); await page.mouse.down();
      await page.mouse.move(rotateHandle.x + rotateHandle.width / 2 + 25, rotateHandle.y + rotateHandle.height / 2 + 5, { steps: 4 });
      await expect.poll(async () => Math.abs(await field('pw-rotation') - firstPlacement(resized).rotationDeg)).toBeGreaterThan(0.2);
      const rotationPreview = await field('pw-rotation');
      await page.mouse.up(); await page.keyboard.up('Shift');
      const rotated = await saveJob(page, info, 'rotated.logo-project');
      expect(firstPlacement(rotated).rotationDeg).toBeCloseTo(rotationPreview, 1);
      expect(rotated.parsed.project.revision).toBe(resized.parsed.project.revision + 1);
      expect(firstPlacement(rotated).widthMm).toBe(firstPlacement(resized).widthMm);
      expect(firstPlacement(rotated).heightMm).toBe(firstPlacement(resized).heightMm);
      await expect(pw(page, 'pw-model-measure-lines').locator('line')).toHaveCount(5);
      const distanceBoxes = await pw(page, 'pw-model-surface-handles').locator('[data-placement-hook^="pw-model-corner-dist-"]').evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }));
      expect(distanceBoxes).toHaveLength(4);
      for (let i = 0; i < distanceBoxes.length; i++) for (let j = i + 1; j < distanceBoxes.length; j++) {
        const a = distanceBoxes[i]!, c = distanceBoxes[j]!;
        expect(a.right <= c.left || c.right <= a.left || a.bottom <= c.top || c.bottom <= a.top).toBe(true);
      }

      const rotateControl = pw(page, 'pw-model-rotate-handle');
      await rotateControl.focus(); await rotateControl.press(']');
      const stepped = await saveJob(page, info, 'rotation-step.logo-project');
      const expectedRotation = ((rotationPreview + 1 + 540) % 360) - 180;
      expect(firstPlacement(stepped).rotationDeg).toBeCloseTo(expectedRotation, 1);
      dragged = stepped;
      await page.screenshot({ path: info.outputPath('on-product.png') });
      if (await page.locator('#placement-context').isVisible()) await page.locator('#placement-context [data-canvas-context-dismiss]').click();
      await pw(page, 'pw-model-move').click();
      const cancelBox = (await modelCanvas.boundingBox())!;
      await page.mouse.move(cancelBox.x + cancelBox.width * .5, cancelBox.y + cancelBox.height * .5); await page.mouse.down();
      await page.mouse.move(cancelBox.x + cancelBox.width * .53, cancelBox.y + cancelBox.height * .5, { steps: 4 });
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
      await b(page, 'product-model-expand').click();
      const cancelled = await saveJob(page, info, 'cancelled.logo-project');
      expect(cancelled.parsed.project.configurations).toEqual(dragged.parsed.project.configurations);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.reload(); await b(page, 'job-open-file').setInputFiles(dragged.path);
      await expect(b(page, 'model-setup-status')).toContainText('Reopened saved');
      await b(page, 'job-to-placements').click();
      await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-artwork-count', /[1-9]/);
      const reopened = await saveJob(page, info, 'reopened.logo-project');
      expect(reopened.parsed.project.configurations).toEqual(dragged.parsed.project.configurations);
      assertCleanProbe(probe);
    } finally { await context.close(); }
  });
}
