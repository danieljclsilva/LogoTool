// Editor guidance readability (contract logotool-context-controls-20261107):
// synthetic model-only staff UI over offline file:// built Logo Station.
// Desktop 1280x720 asserts the longest mode hint (Rectangle) and a genuinely
// generated long status (verbose safe-area name via Polygon Finish/error) fit
// the stable 48px three-line paragraph without moving the canvas mid-gesture.
// Phone 390x844 asserts full 14px tool labels and contextual-only authoring
// fields, with >=180px model height (normal idle/drawing) and the unchanged
// >45% enlarged guard. Synthetic fixtures only; no network, no Odoo.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addProductAndOpenSetup, chooseModelTool, revealModelViewControls, gotoBuilder, openOfflineContext, assertCleanProbe } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const ms = (page: Page, name: string) => page.locator(`[data-model-setup-hook="${name}"]`);

async function stageModelProduct(page: Page): Promise<void> {
  await gotoBuilder(page);
  await b(page, 'job-landing-create').click();
  await b(page, 'customer-name').fill('Synthetic guidance audit');
  await b(page, 'job-ref').fill('GUIDANCE-1280');
  await b(page, 'intake-mode-model').check();
  await b(page, 'product-file').setInputFiles({
    name: 'guidance-cube.glb',
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from(cubeGlb(false, false)),
  });
  await expect(b(page, 'intake-model-status')).toContainText('ready');
  await b(page, 'product-name').fill('Guidance product');
  await addProductAndOpenSetup(page);
  await expect(b(page, 'product-editor')).toBeVisible();
  await expect(b(page, 'product-model-canvas')).toBeVisible();
}

async function fitReference(page: Page): Promise<void> {
  const canvas = b(page, 'product-model-canvas');
  await revealModelViewControls(page);
  await ms(page, 'view-front').click();
  await page.locator('[data-model-setup-hook="viewbar"] [data-ps-view="fit"]').click();
  await ms(page, 'context-measure').click();
  await ms(page, 'ref-pick-a').click();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.47, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.53, box.y + box.height * 0.5);
  await ms(page, 'ref-mm').fill('300');
  await ms(page, 'ref-fit').click();
  await expect(ms(page, 'reference-scale')).toContainText('scale 1 unit =');
}

async function guidanceMetrics(page: Page, hook: 'mode-hint' | 'status') {
  return ms(page, hook).evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    const textRect = range.getBoundingClientRect();
    return {
      text: (node.textContent ?? '').slice(0, 500),
      textLength: (node.textContent ?? '').length,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      height: rect.height,
      clientHeight: (node as HTMLElement).clientHeight,
      scrollHeight: (node as HTMLElement).scrollHeight,
      overflowY: style.overflowY,
      tabindex: (node as HTMLElement).tabIndex,
      hidden: (node as HTMLElement).hidden,
      fits: (node as HTMLElement).scrollHeight <= (node as HTMLElement).clientHeight + 1,
      textTop: textRect.top,
      textBottom: textRect.bottom,
      paraTop: rect.top,
      paraBottom: rect.bottom,
      textInside: textRect.top >= rect.top - 1 && textRect.bottom <= rect.bottom + 1,
    };
  });
}

test('editor guidance at 1280x720 fits stable three-line row in normal/enlarged views', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { context, page, probe } = await openOfflineContext(browser, { width: 1280, height: 720 });
  try {
    await stageModelProduct(page);
    const canvas = b(page, 'product-model-canvas');
    const normalHeight = (await canvas.boundingBox())!.height;
    expect(normalHeight).toBeGreaterThanOrEqual(180);
    await expect(b(page, 'model-setup-save')).toBeVisible();

    // Longest mode hint: Rectangle.
    await chooseModelTool(page, 'rectangle');
    await expect(ms(page, 'tool-rectangle')).toHaveAttribute('aria-pressed', 'true');
    const hint = ms(page, 'mode-hint');
    await expect(hint).toContainText('Rectangle: drag diagonally');
    // Remeasure after the tool-layout transition so canvas coordinates stay trusted.
    const rectBox = (await canvas.boundingBox())!;
    const hintMetrics = await guidanceMetrics(page, 'mode-hint');
    expect(hintMetrics.fontSize).toBe('12px');
    expect(hintMetrics.lineHeight).toBe('16px');
    expect(Math.round(hintMetrics.height)).toBeGreaterThanOrEqual(47);
    expect(Math.round(hintMetrics.height)).toBeLessThanOrEqual(49);
    expect(hintMetrics.fits).toBe(true);
    expect(hintMetrics.textInside).toBe(true);
    expect(hintMetrics.tabindex).toBeGreaterThanOrEqual(0);
    await test.info().attach('guidance-1280-normal-rect-hint', {
      contentType: 'application/json',
      body: JSON.stringify({ hintMetrics, canvasRect: rectBox }, null, 2),
    });
    await page.screenshot({ path: info.outputPath('guidance-1280-normal-rect-hint.png') });

    // Genuinely generated long status: verbose name through Polygon Finish error.
    await fitReference(page);
    await chooseModelTool(page, 'freehand');
    if (await ms(page, 'tool-picker').isVisible()) await expect(ms(page, 'tool-picker')).toBeFocused();
    await expect(ms(page, 'tool-freehand')).toHaveAttribute('aria-pressed', 'true');
    const verbose = 'Upper left chest panel '.repeat(18).trim();
    await ms(page, 'area-name').fill(verbose);
    await canvas.scrollIntoViewIfNeeded();
    const before = (await canvas.boundingBox())!;
    await page.mouse.click(before.x + before.width * 0.48, before.y + before.height * 0.48);
    await page.mouse.click(before.x + before.width * 0.52, before.y + before.height * 0.48);
    await expect(ms(page, 'status')).toContainText('point 2');
    const during = (await canvas.boundingBox())!;
    // Stable command row: adding points must not move the canvas.
    expect(Math.abs(during.y - before.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(during.height - before.height)).toBeLessThanOrEqual(1);
    await ms(page, 'area-finish').click();
    const status = ms(page, 'status');
    await expect(status).toContainText(verbose);
    const statusMetrics = await guidanceMetrics(page, 'status');
    expect(statusMetrics.fits).toBe(true);
    expect(statusMetrics.textInside).toBe(true);
    expect(statusMetrics.tabindex).toBeGreaterThanOrEqual(0);
    expect(statusMetrics.fontSize).toBe('12px');
    const after = (await canvas.boundingBox())!;
    expect(after.height).toBeGreaterThan(0);
    await expect(canvas).toBeVisible();
    await expect(b(page, 'model-setup-save')).toBeVisible();
    await test.info().attach('guidance-1280-normal-long-status', {
      contentType: 'application/json',
      body: JSON.stringify({ statusMetrics, canvasBefore: before, canvasAfter: after }, null, 2),
    });
    await page.screenshot({ path: info.outputPath('guidance-1280-normal-long-status.png') });

    // Enlarged view keeps the same stable guidance and canvas guard.
    await b(page, 'product-model-expand').click();
    await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
    const enlargedStatus = await guidanceMetrics(page, 'status');
    expect(enlargedStatus.fits).toBe(true);
    expect(enlargedStatus.textInside).toBe(true);
    await info.attach('guidance-1280-enlarged-long-status', {
      contentType: 'application/json', body: JSON.stringify(enlargedStatus, null, 2),
    });
    await page.screenshot({ path: info.outputPath('guidance-1280-enlarged-long-status.png') });
    await chooseModelTool(page, 'rectangle');
    await expect(ms(page, 'mode-hint')).toContainText('Rectangle: drag diagonally');
    const enlargedHint = await guidanceMetrics(page, 'mode-hint');
    expect(enlargedHint.fits).toBe(true);
    const enlargedCanvas = (await canvas.boundingBox())!;
    expect(enlargedCanvas.height).toBeGreaterThan(720 * 0.45);
    await expect(b(page, 'model-setup-save')).toBeVisible();
    await test.info().attach('guidance-1280-enlarged', {
      contentType: 'application/json',
      body: JSON.stringify({ enlargedHint, enlargedCanvas }, null, 2),
    });
    await page.screenshot({ path: info.outputPath('guidance-1280-enlarged.png') });

    // Longer operator-entered names remain keyboard-scrollable beyond the reserved row.
    await chooseModelTool(page, 'freehand');
    await ms(page, 'area-name').fill('Upper left chest panel '.repeat(50).trim());
    await ms(page, 'area-finish').click();
    await expect(status).toContainText('Pick at least 3 surface points');
    await status.focus();
    await page.keyboard.press('End');
    await expect.poll(() => status.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await info.attach('guidance-keyboard-overflow', {
      contentType: 'application/json', body: JSON.stringify(await guidanceMetrics(page, 'status'), null, 2),
    });

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});

test('phone editor at 390x844 keeps full tool labels and contextual authoring fields', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { context, page, probe } = await openOfflineContext(browser, { width: 390, height: 844 });
  try {
    await stageModelProduct(page);
    const canvas = b(page, 'product-model-canvas');
    const toolLabels: Array<{ tool: string; label: string }> = [
      { tool: 'rotate', label: 'Rotate model' },
      { tool: 'edit', label: 'Edit outline' },
      { tool: 'rectangle', label: 'Rectangle' },
      { tool: 'freehand', label: 'Polygon' },
    ];
    const picker = ms(page, 'tool-picker');
    await expect(picker).toBeVisible();
    await expect(picker.locator('option')).toHaveText(toolLabels.map(entry => entry.label));
    expect((await picker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await picker.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
    await expect(picker).toBeInViewport({ ratio: 1 });
    await expect(ms(page, 'camera-controls')).toBeHidden();
    await expect(ms(page, 'view-toggle')).toHaveAttribute('aria-expanded', 'false');
    // Idle Rotate/Pan owns no command strip: vertical space is reclaimed.
    await expect(ms(page, 'tool-rotate')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.product-model-toolbar .model-setup-command-strip')).toHaveAttribute('data-tool', 'rotate');
    await expect(page.locator('.product-model-toolbar .model-setup-command-strip')).toBeHidden();
    await expect(ms(page, 'area-name')).toBeHidden();
    await expect(ms(page, 'outline-actions')).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, 0));
    const idleVisible = await canvas.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    });
    expect(idleVisible).toBeGreaterThanOrEqual(180);
    await test.info().attach('phone-390-normal-idle', {
      contentType: 'application/json',
      body: JSON.stringify({ idleVisible }, null, 2),
    });
    await page.screenshot({ path: info.outputPath('phone-390-normal-idle.png') });

    // Polygon owns name + drawing commands; Edit-only outline stays hidden.
    await chooseModelTool(page, 'freehand');
    if (await ms(page, 'tool-picker').isVisible()) await expect(ms(page, 'tool-picker')).toBeFocused();
    await expect(ms(page, 'tool-freehand')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.product-model-toolbar .model-setup-command-strip')).toHaveAttribute('data-tool', 'freehand');
    await expect(ms(page, 'area-name')).toBeVisible();
    await expect(ms(page, 'area-finish')).toBeVisible();
    await expect(ms(page, 'outline-actions')).toBeHidden();
    await ms(page, 'area-name').fill('Phone audit area');
    await canvas.scrollIntoViewIfNeeded();
    const phoneBox = (await canvas.boundingBox())!;
    await page.mouse.click(phoneBox.x + phoneBox.width * 0.48, phoneBox.y + phoneBox.height * 0.48);
    await page.mouse.click(phoneBox.x + phoneBox.width * 0.52, phoneBox.y + phoneBox.height * 0.48);
    await expect(ms(page, 'status')).toContainText('point 2');
    await page.evaluate(() => window.scrollTo(0, 0));
    const drawingVisible = await canvas.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    });
    expect(drawingVisible).toBeGreaterThanOrEqual(180);
    // Header + camera rows stay in single scrollable rows with 44px targets.
    for (const strip of await page.locator('.product-editor .product-editor-tool-scroll, .product-editor .model-setup-camera-controls').all()) {
      if (await strip.evaluate((node) => getComputedStyle(node).display !== 'flex')) continue;
      const overflow = await strip.evaluate((node) => getComputedStyle(node).overflowX);
      expect(['auto', 'scroll']).toContain(overflow);
      for (const control of await strip.locator('button, select, input').all()) {
        if (await control.isDisabled()) continue;
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
    await test.info().attach('phone-390-normal-drawing', {
      contentType: 'application/json',
      body: JSON.stringify({ drawingVisible }, null, 2),
    });
    const beforeView = (await canvas.boundingBox())!;
    await revealModelViewControls(page);
    await expect(ms(page, 'camera-controls')).toBeVisible();
    for (const control of await ms(page, 'camera-controls').locator('button, select').all()) {
      if (await control.isDisabled()) continue;
      await control.focus();
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Escape');
    await expect(ms(page, 'camera-controls')).toBeHidden();
    await expect(ms(page, 'status')).toContainText('point 2');
    expect((await canvas.boundingBox())!.height).toBe(beforeView.height);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath('phone-390-normal-drawing.png') });

    // Enlarged phone keeps the unchanged >45% canvas guard with full labels.
    await b(page, 'product-model-expand').click();
    await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
    const enlargedBox = (await canvas.boundingBox())!;
    expect(enlargedBox.height).toBeGreaterThan(844 * 0.45);
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue('freehand');
    await revealModelViewControls(page);
    await expect(ms(page, 'camera-controls')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(ms(page, 'camera-controls')).toBeHidden();
    await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
    await expect(ms(page, 'status')).toContainText('point 2');
    await test.info().attach('phone-390-enlarged', {
      contentType: 'application/json',
      body: JSON.stringify({ enlargedHeight: enlargedBox.height }, null, 2),
    });
    await page.screenshot({ path: info.outputPath('phone-390-enlarged.png') });

    await chooseModelTool(page, 'edit');
    await expect(ms(page, 'outline-actions')).toBeVisible();
    await expect(ms(page, 'area-name')).toBeHidden();
    await expect(ms(page, 'areas-actions')).toBeHidden();
    for (const control of await ms(page, 'outline-actions').getByRole('button').all()) {
      await control.focus();
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});
