import { expect, test } from '@playwright/test';
import {
  assertCleanProbe,
  gotoInspector,
  hook,
  ingestGlb,
  openOfflineContext,
} from './helpers.js';
import { loadFixtures } from './fixtures.js';

test('inspector smoke: identity, ingest, offline cleanliness, layout', async ({
  browser,
}, testInfo) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await gotoInspector(page);
    await expect(page).toHaveTitle(/Logo Station/);
    expect(
      await hook(page, 'placement', 'placement-panel').innerText(),
    ).toBeTruthy();
    await expect(page.locator('body')).not.toContainText(
      /Webpack Error|Vite Error|Unhandled Runtime Error/,
    );

    const tools = page.locator('details').filter({ has: hook(page, 'inspector', 'wireframe-button') });
    await expect(tools).not.toHaveAttribute('open', '');
    await expect(hook(page, 'inspector', 'wireframe-button')).toBeHidden();
    await expect(hook(page, 'calibration', 'product-id')).toBeVisible();
    await expect(hook(page, 'calibration', 'region-frame-id')).toBeVisible();
    await tools.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(hook(page, 'inspector', 'wireframe-button')).toBeVisible();
    await tools.locator('summary').click();
    await expect(hook(page, 'inspector', 'wireframe-button')).toBeHidden();

    const { glbBuffer } = await loadFixtures();
    await ingestGlb(page, glbBuffer);
    await expect(hook(page, 'inspector', 'status')).toContainText(/^Showing/);

    await hook(page, 'placement', 'placement-panel').scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('smoke-desktop.png') });

    await testInfo.attach('desktop', { path: testInfo.outputPath('smoke-desktop.png'), contentType: 'image/png' });

    await page.setViewportSize({ width: 390, height: 844 });
    await hook(page, 'placement', 'placement-status').scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('smoke-mobile.png') });

    await testInfo.attach('mobile', { path: testInfo.outputPath('smoke-mobile.png'), contentType: 'image/png' });
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});
