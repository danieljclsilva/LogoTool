import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { gotoBuilder, openOfflineContext, revealBuilderControl } from './helpers.js';
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
  await expect(page.locator('[data-builder-mode-panel="prepare"]')).toBeVisible();
  await expect(page.locator('[data-builder-step="open"]')).toBeVisible();
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

test('visible product chooser stages a file; add alone still reports empty staging', async ({ browser }) => {
  const { context, page, probe } = await openBuilder(browser);
  try {
    await builder(page, 'start-create').click();
    await expect(page.locator('[data-builder-step="choose"]')).toBeVisible();

    // Add with nothing staged still reports the empty-staging message.
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Choose one product file first');

    // The visible chooser is operable while the raw file input stays CSS-hidden.
    const choose = await shown(page, 'product-choose');
    await expect(choose).toBeVisible();
    await expect(choose).toBeEnabled();
    const hiddenBox = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-builder-hook="product-file"]');
      if (!input) throw new Error('Missing product-file input.');
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
    await expect(await shown(page, 'product-status')).toContainText('Staged flat image');

    await (await shown(page, 'product-name')).fill('Operator Provisional');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added preview-only product');
    await expect(await shown(page, 'product-status')).toContainText('no measurements');

    expectOfflineClean(probe);
  } finally { await context.close(); }
});
