import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { addProductAndOpenSetup, gotoBuilder, openOfflineContext, revealBuilderControl } from './helpers.js';
import type { Probe } from './helpers.js';

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openBuilder(browser: Browser): Promise<{
  context: BrowserContext; page: Page; probe: Probe;
}> {
  const { context, page, probe } = await openOfflineContext(browser, { width: 1280, height: 900 });
  await gotoBuilder(page);
  await expect(page.getByRole('heading', { name: 'Prepare a customer file' })).toBeVisible();
  return { context, page, probe };
}

async function syntheticPng(page: Page, color: string, width: number, height: number): Promise<Uint8Array> {
  const base64 = await page.evaluate(({ fill, w, h }: { fill: string; w: number; h: number }): string => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d canvas unavailable for synthetic fixture.');
    context.fillStyle = fill;
    context.fillRect(0, 0, w, h);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  }, { fill: color, w: width, h: height });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.httpRequests).toEqual([]);
}

test('visible view chooser stages a file; add alone still reports empty staging', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await builder(page, 'job-landing-create').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();

    // Add with nothing staged still reports the empty-staging message (the
    // Add control stays disabled, so dispatch the click directly).
    await builder(page, 'product-add').dispatchEvent('click');
    await expect(await shown(page, 'product-status')).toContainText('Choose at least one view image');

    // The visible row chooser is operable while the raw file input stays CSS-hidden.
    const row = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]').first();
    const choose = row.getByRole('button', { name: 'Choose view image' });
    await expect(choose).toBeVisible();
    await expect(choose).toBeEnabled();
    const hiddenBox = await row.locator('input[type="file"]').evaluate((input) => {
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      return { width: rect.width, height: rect.height, position: style.position, overflow: style.overflow };
    });
    expect(hiddenBox.width).toBeLessThanOrEqual(1);
    expect(hiddenBox.height).toBeLessThanOrEqual(1);
    expect(hiddenBox.position).toBe('absolute');
    expect(['hidden', 'clip']).toContain(hiddenBox.overflow);

    // Clicking the visible chooser opens the native file chooser; stage a
    // synthetic flat image through it (no real assets, no network).
    const png = await syntheticPng(page, '#12394b', 20, 10);
    const fileChooserPromise = page.waitForEvent('filechooser');
    await choose.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({ name: 'flat.png', mimeType: 'image/png', buffer: Buffer.from(png) });
    await expect(row.locator('.view-row-state')).toContainText('ready');
    await expect(await shown(page, 'product-status')).toContainText('1 view image ready');

    await (await shown(page, 'product-name')).fill('Operator Provisional');
    await addProductAndOpenSetup(page);
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product');
    await expect(await shown(page, 'product-status')).toContainText('no measurements');

    expectOfflineClean(probe);
  } finally { await context.close(); }
});
