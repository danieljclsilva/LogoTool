import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import { decodeJobSidecar, OPERATOR_JOB_SIDECAR_PATH } from '../src/core/operator-job/index.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { assertCleanProbe, gotoBuilder, openOfflineContext } from './helpers.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function png(page: Page, colour: string): Promise<Buffer> {
  const encoded = await page.evaluate(fill => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 40;
    const context = canvas.getContext('2d')!;
    context.fillStyle = fill;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, colour);
  return Buffer.from(encoded, 'base64');
}

async function expectIntake(page: Page, productCount: number): Promise<void> {
  await expect(page.locator('[data-product-card]')).toHaveCount(productCount);
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
  await expect(b(page, 'product-editor')).toBeHidden();
  await expect(b(page, 'add-product-disclosure')).toHaveAttribute('open', '');
  await expect(b(page, 'product-name')).toHaveValue('');
  await expect(b(page, 'product-name')).toBeFocused();
  await expect(b(page, 'logo-add')).toBeVisible();
  for (const box of await b(page, 'product-list').locator('input[type="checkbox"]').all()) {
    await expect(box).toBeChecked();
  }
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`batch intake collects two products and two logos before setup at ${viewport.width}`, async ({ browser }, info) => {
    const { context, page, probe } = await openOfflineContext(browser, viewport);
    try {
      await gotoBuilder(page);
      await b(page, 'job-landing-create').click();
      await b(page, 'customer-name').fill('Synthetic batch customer');
      await b(page, 'job-ref').fill('BATCH-INTAKE');
      const photo = await png(page, '#226644');
      const model = Buffer.from(cubeGlb());
      const logos = [await png(page, '#aa3311'), await png(page, '#1144aa')];
      const view = page.locator('[data-view-row]').first();
      await view.locator('input[type="file"]').setInputFiles({ name: 'trousers.png', mimeType: 'image/png', buffer: photo });
      await expect(view.locator('.view-row-state')).toContainText('ready');
      await b(page, 'product-name').fill('Photo trousers');
      await expect(b(page, 'product-add')).toHaveText('Add product');
      await b(page, 'product-add').click();
      await expectIntake(page, 1);
      await expect(b(page, 'product-status')).toContainText('Add more products and logos here');

      await b(page, 'intake-mode-model').check();
      await b(page, 'product-file').setInputFiles({ name: 'jacket.glb', mimeType: 'model/gltf-binary', buffer: model });
      await expect(b(page, 'intake-model-status')).toContainText('ready');
      await b(page, 'product-name').fill('Model jacket');
      await b(page, 'product-add').click();
      await expectIntake(page, 2);

      for (const [index, bytes] of logos.entries()) {
        const chooserPromise = page.waitForEvent('filechooser');
        await b(page, 'logo-add').click();
        await (await chooserPromise).setFiles({ name: `crest-${index + 1}.png`, mimeType: 'image/png', buffer: bytes });
        await expect(b(page, 'logo-status')).toContainText(`Added crest-${index + 1}.png`);
        await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
        await expect(b(page, 'product-editor')).toBeHidden();
      }
      await expect(b(page, 'logo-list').locator('input[type="checkbox"]')).toHaveCount(2);
      for (const box of await b(page, 'logo-list').locator('input[type="checkbox"]').all()) await expect(box).toBeChecked();
      await page.screenshot({ path: info.outputPath('batch-prepare.png'), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

      const downloadPromise = page.waitForEvent('download');
      await b(page, 'job-save').click();
      const path = info.outputPath('batch.logo-project');
      await (await downloadPromise).saveAs(path);
      const bytes = new Uint8Array(await readFile(path));
      const saved = await parseProjectPackage(bytes, { sha256 });
      expect(saved.project.products.map(product => product.name)).toEqual(['Photo trousers', 'Model jacket']);
      expect(saved.project.logos).toHaveLength(2);
      expect(saved.project.configurations.flatMap(configuration => configuration.placements)).toHaveLength(0);
      for (const original of [photo, model, ...logos]) {
        expect(saved.assets.some(asset => Buffer.from(asset.bytes).equals(original))).toBe(true);
      }
      const metadata = decodeJobSidecar(saved.assets.find(asset => asset.path === OPERATOR_JOB_SIDECAR_PATH)!.bytes)!;
      expect(metadata.inclusion.includedProducts).toEqual(saved.project.products.map(product => product.id));
      expect(metadata.inclusion.includedConfigurations).toEqual(saved.project.configurations.map(configuration => configuration.id));
      expect(metadata.inclusion.logoIds).toEqual(saved.project.logos.map(logo => logo.id));

      await b(page, 'job-open-file').setInputFiles({ name: 'batch.logo-project', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
      await expect(b(page, 'source-status')).toContainText('Loaded batch.logo-project');
      await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
      await expect(page.locator('[data-product-card]')).toHaveCount(2);
      await expect(b(page, 'logo-list').locator('input[type="checkbox"]:checked')).toHaveCount(2);
      await expect(b(page, 'product-editor')).toBeHidden();
      await page.getByRole('button', { name: 'Open setup for Model jacket', exact: true }).click();
      await expect(b(page, 'product-editor')).toBeVisible();
      await expect(b(page, 'workspace-product')).toHaveValue(saved.project.products[1]!.id);
      await expect(b(page, 'product-model-canvas')).toBeVisible();
      assertCleanProbe(probe);
    } finally {
      await context.close();
    }
  });
}
