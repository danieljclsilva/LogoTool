import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gotoBuilder, openOfflineContext, assertCleanProbe } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const pw = (page: Page, name: string) => page.locator(`[data-placement-hook="${name}"]`);

for (const twoSided of [false, true]) test(`GLB-only document (${twoSided ? 'front and back' : 'front only'}): artwork, measured views and offline save/reopen`, async ({ browser }, info) => {
  test.setTimeout(90_000);
  const { context, page, probe } = await openOfflineContext(browser, { width: 1440, height: 900 });
  page.setDefaultTimeout(12_000);
  try {
    await gotoBuilder(page); await b(page, 'job-landing-create').click();
    await b(page, 'customer-name').fill('Synthetic model document'); await b(page, 'job-ref').fill('SYN-MODEL-DOC');
    await b(page, 'intake-mode-model').check();
    await b(page, 'product-file').setInputFiles({ name: 'fold.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(cubeGlb(true, false)) });
    await expect(b(page, 'intake-model-status')).toContainText('ready');
    await b(page, 'product-name').fill('Synthetic folded product'); await b(page, 'product-add').click();
    await b(page, 'product-model-expand').click();
    const canvas = b(page, 'product-model').locator('canvas');
    const ms = (name: string) => page.locator(`[data-model-setup-hook="${name}"]`);
    const box = (await canvas.boundingBox())!;
    await ms('context-measure').click();
    await ms('ref-pick-a').click();
    await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
    await page.mouse.click(box.x + box.width * .56, box.y + box.height * .5);
    await ms('ref-mm').fill('300'); await ms('ref-fit').click();
    await ms('area-name').fill('Chest'); await ms('tool-rectangle').click();
    await page.mouse.move(box.x + box.width * .44, box.y + box.height * .42); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .55, { steps: 4 }); await page.mouse.up();
    await expect(ms('area-list')).toContainText('Chest');
    if (twoSided) {
      // Setup navigation responds at a close zoom without editing saved mm.
      await ms('tool-rotate').click();
      await page.locator('[data-ps-view="zoom-in"]').click();
      await ms('pan').click(); await expect(ms('pan')).toHaveAttribute('aria-pressed', 'true');
      const beforePan = await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5 + 25, { steps: 5 }); await page.mouse.up();
      await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL())).not.toBe(beforePan);
      await ms('tool-rotate').click(); await expect(ms('pan')).toHaveAttribute('aria-pressed', 'false');
      await ms('view-back').click(); await page.locator('[data-ps-view="fit"]').click();
      await ms('area-name').fill('Back'); await ms('tool-rectangle').click();
      await page.mouse.move(box.x + box.width * .44, box.y + box.height * .42); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .55, box.y + box.height * .55, { steps: 4 }); await page.mouse.up();
      await expect(ms('area-list')).toContainText('Back');
    }
    await b(page, 'model-setup-save').click(); await expect(b(page, 'model-setup-status')).toContainText('Saved 3D setup');
    await b(page, 'product-model-expand').click();
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 100; c.height = 50;
      const ctx = c.getContext('2d')!; ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 100, 50); ctx.fillStyle = '#00ffff'; ctx.fillRect(0, 0, 100, 10);
      return c.toDataURL().split(',')[1]!;
    });
    await b(page, 'logo-file').setInputFiles({ name: 'synthetic-mark.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(b(page, 'logo-status')).toContainText('Added'); await b(page, 'editor-logos').click();
    await pw(page, 'pw-model-front').click();
    await pw(page, 'pw-model-details').click();
    await pw(page, 'pw-add-placement').click(); await pw(page, 'pw-add-width').fill('120'); await pw(page, 'pw-add-height').fill('60');
    await pw(page, 'pw-add-method').selectOption('heat-seal'); await pw(page, 'pw-add-confirm').click();
    await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-ready', 'true');
    await pw(page, 'pw-model-anchor-name').fill('Collar centre');
    await pw(page, 'pw-model-anchor-add').click();
    const productCanvas = pw(page, 'pw-model-canvas'), productBox = (await productCanvas.boundingBox())!;
    await page.mouse.click(productBox.x + productBox.width * .45, productBox.y + productBox.height * .55);
    await expect(b(page, 'builder-alert')).toContainText('added. Choose');
    await pw(page, 'pw-measurement-add').click();
    await pw(page, 'pw-measure-anchor').selectOption({ label: 'Collar centre' });
    await pw(page, 'pw-measure-edge').selectOption({ label: 'left' });
    await pw(page, 'pw-measure-direction').selectOption({ label: 'Horizontal' });
    await pw(page, 'pw-measure-save').click();
    await expect(pw(page, 'pw-measurements')).toContainText('mm');
    if (twoSided) {
      await pw(page, 'pw-add-placement').click();
      await pw(page, 'pw-add-area').selectOption({ label: 'Back' });
      await pw(page, 'pw-add-width').fill('180'); await pw(page, 'pw-add-height').fill('90');
      await pw(page, 'pw-add-method').selectOption('embroidery'); await pw(page, 'pw-add-confirm').click();
      await pw(page, 'pw-model-back').click();
      await pw(page, 'pw-model-anchor-name').fill('Back collar'); await pw(page, 'pw-model-anchor-add').click();
      await page.mouse.click(productBox.x + productBox.width * .45, productBox.y + productBox.height * .55);
      await expect(b(page, 'builder-alert')).toContainText('added. Choose');
      await pw(page, 'pw-measurement-add').click(); await pw(page, 'pw-measure-anchor').selectOption({ label: 'Back collar' });
      await pw(page, 'pw-measure-edge').selectOption({ label: 'top' }); await pw(page, 'pw-measure-direction').selectOption({ label: 'Vertical' });
      await pw(page, 'pw-measure-save').click();
    }
    await pw(page, 'pw-review').click();
    const preview = page.locator('[data-doc-review-preview]');
    const images = preview.locator('img[alt*="model view with applied artwork"]');
    await expect(images).toHaveCount(twoSided ? 2 : 1); await expect(images.first()).toBeVisible();
    await expect(preview).not.toContainText('No product photo supplied');
    await expect(preview).not.toContainText('Placement measurements not set');
    await expect(preview.locator('.opsheet-logo-number')).toHaveText(twoSided ? ['1', '2'] : ['1']);
    await expect(preview.locator('.opsheet-dims').first()).toContainText('mm');
    // Test the captured image itself, not just its URL or the live editor.
    const magenta = await images.first().evaluate(async (node) => {
      const img = node as HTMLImageElement; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0); const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
      let count = 0; for (let i = 0; i < bytes.length; i += 4) if (bytes[i]! > 170 && bytes[i + 1]! < 90 && bytes[i + 2]! > 170) count++; return count;
    });
    expect(magenta).toBeGreaterThan(2);
    const save = async (name: string) => {
      const download = page.waitForEvent('download', { timeout: 10_000 }); await b(page, 'job-save').click();
      const path = info.outputPath(name); await (await download).saveAs(path);
      const parsed = await parseProjectPackage(new Uint8Array(await readFile(path)), { sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex') });
      const metadata = parsed.assets.find((asset) => asset.path === 'presentation/model-document-views.json');
      expect(metadata).toBeDefined();
      return { path, project: parsed.project, metadata: JSON.parse(new TextDecoder().decode(metadata!.bytes)) as { views: Array<{ id: string; label: string; camera: unknown }> } };
    };
    const operatorData = async (name: string) => {
      const disclosure = page.locator('summary', { hasText: 'More output options' });
      if (!await disclosure.locator('..').evaluate((node) => (node as HTMLDetailsElement).open)) await disclosure.click();
      const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Save operator data' }).click();
      const path = info.outputPath(name); await (await download).saveAs(path);
      return JSON.parse(await readFile(path, 'utf8')) as { products: Array<{ logos: Array<{ measurements: Array<{ anchor: string; distanceMm: number }> }> }> };
    };
    await expect(preview.locator('.opsheet')).toHaveCount(1);
    const originalMeasurements = await operatorData('original-operator.json');
    const measurement = originalMeasurements.products[0]!.logos[0]!.measurements[0]!;
    expect(measurement.anchor).toBe('Collar centre'); expect(Number.isFinite(measurement.distanceMm)).toBe(true);
    expect(measurement.distanceMm).not.toBe(0);
    await expect(preview.locator('.opsheet-dims').first()).toContainText(measurement.distanceMm.toFixed(1));
    await page.pdf({ path: info.outputPath('model-initial-operation.pdf'), preferCSSPageSize: true, printBackground: true });
    const initial = await save('model-initial.logo-project');
    const rows = page.locator('.doc-review-model-row');
    await rows.first().getByRole('button', { name: 'Reframe to current camera' }).click();
    const dialog = page.getByRole('dialog', { name: 'Adjust document model view' });
    await expect(dialog.getByRole('button', { name: 'Use this view' })).toBeEnabled();
    await dialog.getByLabel('View name').fill('Front detail');
    await dialog.getByRole('button', { name: 'Zoom in' }).click(); await dialog.getByRole('button', { name: 'Pan', exact: true }).click();
    const stage = dialog.locator('canvas'), stageBox = (await stage.boundingBox())!;
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2); await page.mouse.down();
    await page.mouse.move(stageBox.x + stageBox.width / 2 + 12, stageBox.y + stageBox.height / 2 + 8, { steps: 4 }); await page.mouse.up();
    await dialog.getByRole('button', { name: 'Use this view' }).click();
    await expect(preview).toContainText('Front detail');
    await page.getByRole('button', { name: 'Add view from current camera' }).click();
    await expect(dialog.getByRole('button', { name: 'Use this view' })).toBeEnabled();
    await dialog.getByLabel('View name').fill('Front wide'); await dialog.getByRole('button', { name: 'Front', exact: true }).click();
    await dialog.getByRole('button', { name: 'Use this view' }).click();
    await expect.poll(() => images.count()).toBeGreaterThanOrEqual(twoSided ? 3 : 2); await expect(rows).toHaveCount(twoSided ? 3 : 2);
    if (twoSided) await rows.nth(2).getByRole('button', { name: 'Move up' }).click();
    await rows.nth(1).getByRole('button', { name: 'Move up' }).click();
    const adjusted = await save('model-adjusted.logo-project');
    expect(adjusted.project.configurations).toEqual(initial.project.configurations);
    expect(adjusted.project.products).toEqual(initial.project.products);
    expect(adjusted.project.revision).toBe(initial.project.revision);
    expect(adjusted.metadata.views.map((view) => view.label)).toEqual(twoSided ? ['Front wide', 'Front detail', 'Back'] : ['Front wide', 'Front detail']);
    expect(adjusted.metadata.views[1]!.camera).not.toEqual(initial.metadata.views[0]!.camera);
    await page.reload(); await b(page, 'job-open-file').setInputFiles(adjusted.path); await b(page, 'job-to-placements').click(); await pw(page, 'pw-review').click();
    await expect.poll(() => images.count()).toBeGreaterThanOrEqual(twoSided ? 3 : 2); await expect(rows.first()).toContainText('Front wide');
    await expect(rows.filter({ hasText: 'render failed' })).toHaveCount(0);
    expect(await operatorData('reopened-operator.json')).toEqual(originalMeasurements);
    await page.screenshot({ path: info.outputPath('model-document.png'), fullPage: true });
    await page.pdf({ path: info.outputPath('model-operation.pdf'), preferCSSPageSize: true, printBackground: true });
    assertCleanProbe(probe);
  } catch (error) {
    await page.screenshot({ path: info.outputPath('model-document-failure.png'), fullPage: true });
    await info.attach('failed-dom', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
    throw error;
  } finally { await context.close().catch(() => {}); }
});
