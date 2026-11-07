import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gotoBuilder, openOfflineContext, assertCleanProbe, ensurePlacementPanel, revealBuilderControl } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const pw = (page: Page, name: string) => page.locator(`[data-placement-hook="${name}"]`);
const fixture = resolve('dist/dev/trusted-issued.logo-project');
const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function openJob(page: Page): Promise<void> {
  await gotoBuilder(page);
  await b(page, 'job-open-file').setInputFiles(fixture);
  await expect(b(page, 'product-list')).toContainText('Synthetic Tee');
}

async function saveJob(page: Page, info: TestInfo, fileName: string) {
  const downloadPromise = page.waitForEvent('download');
  await b(page, 'job-save').click();
  const download = await downloadPromise;
  const path = info.outputPath(fileName);
  await download.saveAs(path);
  return {
    path,
    fileName: download.suggestedFilename(),
    parsed: await parseProjectPackage(new Uint8Array(await readFile(path)), { sha256 }),
  };
}

async function unloadPrevented(page: Page): Promise<boolean> {
  // BeforeUnloadEvent has no public constructor in Chromium. A cancellable
  // Event exercises the handler independently of dialog/user-activation rules.
  return page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
}

async function expectCloseWarning(page: Page): Promise<void> {
  const dialogPromise = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  expect(page.isClosed()).toBe(false);
}

test('station UX: real close warnings for dirty and pending placement edits, clean close without prompt', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await openJob(page);
    expect(await unloadPrevented(page)).toBe(false);
    await b(page, 'customer-name').fill('Synthetic unsaved customer');
    expect(await unloadPrevented(page)).toBe(true);
    await expectCloseWarning(page);
    // Discard through the normal Open guard, returning to a clean fixture.
    await b(page, 'job-open-file').setInputFiles(fixture);
    await b(page, 'builder-alert').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(b(page, 'job-persistence')).toHaveText('');
    for (const checkbox of await b(page, 'product-list').locator('input[type=checkbox]').all()) await checkbox.check();
    await saveJob(page, info, 'clean-before-placement.logo-project');
    await b(page, 'job-step-2').click();
    await ensurePlacementPanel(page);
    await pw(page, 'pw-placement-list').getByRole('button').first().click();
    const width = pw(page, 'pw-width');
    const originalWidth = await width.inputValue();
    await width.fill('');
    expect(await unloadPrevented(page)).toBe(true);
    await expectCloseWarning(page);
    await width.fill(originalWidth);
    expect(await unloadPrevented(page)).toBe(false);
    let dialogCount = 0;
    page.on('dialog', async (dialog) => { dialogCount += 1; await dialog.dismiss(); });
    const closed = page.waitForEvent('close');
    await page.close({ runBeforeUnload: true });
    await closed;
    expect(dialogCount).toBe(0);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  test(`station UX: readable persistence follows Save through download, edit and reopen at ${viewport.width}`, async ({ browser }, info) => {
    const { context, page, probe } = await openOfflineContext(browser, viewport);
    try {
      await openJob(page);
      await b(page, 'customer-name').fill('Synthetic UX');
      const status = b(page, 'job-persistence');
      await expect(status).toHaveText('Unsaved changes — not yet downloaded.');
      const assertReadable = async () => {
        await expect(status).toBeVisible();
        expect(await status.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth &&
            node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight;
        })).toBe(true);
        expect(await b(page, 'job-save').evaluate((node) => node.nextElementSibling?.getAttribute('data-builder-hook'))).toBe('job-persistence');
      };
      await assertReadable();
      const saved = await saveJob(page, info, 'ux.logo-project');
      await expect(status).toHaveText(`Downloaded ${saved.fileName} — keep this file to reopen the job.`);
      await assertReadable();
      await b(page, 'job-step-2').click();
      await expect(page.locator('.product-editor-modes').locator('[data-builder-hook="job-persistence"]')).toHaveCount(1);
      await assertReadable();
      await page.screenshot({ path: info.outputPath('persistence-editor.png') });
      await b(page, 'job-step-1').click();
      await b(page, 'job-ref').fill('NEW-REFERENCE');
      await expect(status).toHaveText('Unsaved changes — not yet downloaded.');
      await b(page, 'job-open-file').setInputFiles(saved.path);
      await b(page, 'builder-alert').getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(b(page, 'customer-name')).toHaveValue('Synthetic UX');
      await expect(b(page, 'job-ref')).not.toHaveValue('NEW-REFERENCE');
      await expect(status).toHaveText('');
      assertCleanProbe(probe);
    } finally { await context.close(); }
  });
}

for (const mode of ['images', 'model'] as const) {
  test(`station UX: retains both staged modes and Add includes only ${mode}, releasing thumbnails`, async ({ browser }, info) => {
    const { context, page, probe } = await openOfflineContext(browser);
    try {
      await gotoBuilder(page);
      await b(page, 'job-landing-create').click();
      await page.evaluate(() => {
        const created: string[] = [];
        const revoked: string[] = [];
        const originalCreate = URL.createObjectURL.bind(URL);
        const originalRevoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = (blob) => { const url = originalCreate(blob); created.push(url); return url; };
        URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
        Object.assign(window, { stationUxUrls: { created, revoked } });
      });
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 10;
        canvas.getContext('2d')!.fillRect(0, 0, 20, 10);
        return canvas.toDataURL().split(',')[1]!;
      });
      const row = b(page, 'product-view-rows').locator('[data-view-row]').first();
      await row.locator('input[type="file"]').setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await expect(row.locator('.view-row-state')).toContainText('ready');
      const thumbnailUrl = await row.locator('img').getAttribute('src');
      expect(thumbnailUrl).toMatch(/^blob:/);
      await b(page, 'intake-mode-model').check();
      await b(page, 'product-file').setInputFiles({ name: 'cube.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(cubeGlb(true, false)) });
      await expect(b(page, 'intake-model-status')).toContainText('ready');
      let dialogCount = 0;
      page.on('dialog', async (dialog) => { dialogCount += 1; await dialog.dismiss(); });
      for (let count = 0; count < 3; count += 1) {
        await b(page, 'intake-mode-images').check();
        await expect(b(page, 'product-status')).toContainText('kept if you switch back');
        await expect(row.locator('img')).toHaveAttribute('src', thumbnailUrl!);
        await b(page, 'intake-mode-model').check();
        await expect(b(page, 'product-status')).toContainText('kept if you switch back');
        await expect(b(page, 'intake-model-status')).toContainText('cube.glb ready');
      }
      expect(dialogCount).toBe(0);
      const urls = () => page.evaluate(() => (window as unknown as { stationUxUrls: { created: string[]; revoked: string[] } }).stationUxUrls);
      expect((await urls()).revoked).not.toContain(thumbnailUrl);
      expect((await urls()).created.filter((url) => url === thumbnailUrl)).toHaveLength(1);
      await b(page, `intake-mode-${mode}`).check();
      await b(page, 'product-name').fill('Synthetic selected mode');
      await b(page, 'product-add').click();
      await expect(b(page, 'product-status')).toContainText('Added');
      expect((await urls()).revoked.filter((url) => url === thumbnailUrl)).toHaveLength(1);
      const saved = await saveJob(page, info, `${mode}.logo-project`);
      const mediaPaths = saved.parsed.assets.map((asset) => asset.path).filter((path) => /\.(png|glb)$/.test(path));
      expect(mediaPaths).toHaveLength(1);
      expect(mediaPaths[0]).toMatch(mode === 'model' ? /\.glb$/ : /\.png$/);
      await b(page, 'job-step-1').click();
      await revealBuilderControl(page, 'intake-mode-model');
      await b(page, 'intake-mode-model').check();
      await expect(b(page, 'intake-model-status')).toHaveText('No 3D model staged yet.');
      await b(page, 'intake-mode-images').check();
      await expect(row.locator('img')).toHaveCount(0);
      assertCleanProbe(probe);
    } finally { await context.close(); }
  });
}

test('station UX: download failure shows a plain headline and escaped technical disclosure', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await openJob(page);
    await b(page, 'customer-name').fill('Synthetic failure');
    const technical = 'Synthetic download failure <img src="https://invalid.example/" onerror="alert(1)">';
    await page.evaluate((message) => { HTMLAnchorElement.prototype.click = () => { throw new Error(message); }; }, technical);
    await b(page, 'job-save').click();
    const alert = b(page, 'builder-alert');
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert.locator(':scope > p')).toHaveText('The job could not be saved. Previous state is unchanged.');
    await expect(alert.locator('pre')).toHaveText(technical);
    await expect(alert.locator('pre')).toBeHidden();
    await alert.getByText('Technical details', { exact: true }).click();
    await expect(alert.locator('pre')).toBeVisible();
    await expect(alert.locator('img')).toHaveCount(0);
    await expect(b(page, 'job-persistence')).toHaveText('Unsaved changes — not yet downloaded.');
    await page.screenshot({ path: info.outputPath('error-details.png') });
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('station UX: invalid placement fields explain disabled Apply and recover without losing edits', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await openJob(page);
    for (const checkbox of await b(page, 'product-list').locator('input[type=checkbox]').all()) await checkbox.check();
    await b(page, 'job-step-2').click();
    await ensurePlacementPanel(page);
    await pw(page, 'pw-placement-list').getByRole('button').first().click();
    const originalWidth = await pw(page, 'pw-width').inputValue();
    await pw(page, 'pw-width').fill('0');
    await expect(pw(page, 'pw-width')).toHaveAttribute('aria-invalid', 'true');
    await expect(pw(page, 'pw-width')).toHaveAttribute('aria-describedby', 'pw-width-error');
    await expect(pw(page, 'pw-width-error')).toContainText('greater than 0 mm');
    await expect(pw(page, 'pw-apply')).toBeDisabled();
    await expect(pw(page, 'pw-apply')).toHaveAttribute('aria-describedby', 'pw-apply-reason');
    await expect(pw(page, 'pw-apply-reason')).toContainText('Width');
    await b(page, 'job-save').click();
    await expect(b(page, 'builder-alert')).toContainText('pending');
    await page.screenshot({ path: info.outputPath('inline-error.png') });
    await pw(page, 'pw-width').fill(String(Number(originalWidth) + 1));
    await expect(pw(page, 'pw-width')).toHaveAttribute('aria-invalid', 'false');
    await expect(pw(page, 'pw-width-error')).toHaveCount(0);
    await expect(pw(page, 'pw-apply')).toBeEnabled();
    await pw(page, 'pw-apply').click();
    await expect(pw(page, 'pw-apply')).toHaveCount(0);
    const saved = await saveJob(page, info, 'placement-corrected.logo-project');
    expect(saved.parsed.project.configurations[0]!.placements[0]!.widthMm).toBe(Number(originalWidth) + 1);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
