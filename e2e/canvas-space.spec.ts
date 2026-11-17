// Staff canvas space (1290x700): canvas keeps >=315px in normal and
// enlarged views while footer actions stay reachable; navigation never
// shifts the canvas or mutates geometry. Synthetic model-only fixtures,
// offline file:// built station. Zero console/page errors, zero HTTP(S).
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  addProductAndOpenSetup,
  assertCleanProbe,
  chooseModelTool,
  gotoBuilder,
  openOfflineContext,
  revealModelViewControls,
} from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const ms = (page: Page, name: string) => page.locator(`[data-model-setup-hook="${name}"]`);

async function stageModelProduct(page: Page): Promise<void> {
  await gotoBuilder(page);
  await b(page, 'job-landing-create').click();
  await b(page, 'customer-name').fill('Synthetic canvas space');
  await b(page, 'job-ref').fill('CANVAS-1290');
  await b(page, 'intake-mode-model').check();
  await b(page, 'product-file').setInputFiles({
    name: 'canvas-cube.glb',
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from(cubeGlb(false, false)),
  });
  await expect(b(page, 'intake-model-status')).toContainText('ready');
  await b(page, 'product-name').fill('Canvas product');
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

async function drawRectangleArea(page: Page, name: string): Promise<void> {
  const canvas = b(page, 'product-model-canvas');
  await chooseModelTool(page, 'rectangle');
  await ms(page, 'area-name').fill(name);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.44, box.y + box.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 4 });
  await page.mouse.up();
  await expect(ms(page, 'area-list')).toContainText(name);
}

async function saveJobProducts(page: Page, info: TestInfo, name: string): Promise<string> {
  const download = page.waitForEvent('download');
  await b(page, 'job-save').click();
  const path = info.outputPath(name);
  await (await download).saveAs(path);
  const parsed = await parseProjectPackage(new Uint8Array(await readFile(path)), {
    sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
  });
  return JSON.stringify(parsed.project.products);
}

async function assertCanvasAndFooter(page: Page, label: string, info: TestInfo): Promise<void> {
  const canvas = b(page, 'product-model-canvas');
  const save = b(page, 'model-setup-save');
  await save.scrollIntoViewIfNeeded();
  // Recapture simultaneously after any scroll: pre-scroll boxes are stale
  // once scrollIntoView moves the layout viewport.
  const [box, saveBox, footerBox] = await Promise.all([
    canvas.boundingBox(),
    save.boundingBox(),
    page.locator('.product-model-footer').boundingBox(),
  ]);
  expect(box!.height).toBeGreaterThanOrEqual(315);
  await expect(save).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(save).toBeInViewport({ ratio: 1 });
  for (const action of ['editor-to-prepare', 'editor-to-approval', 'editor-to-review']) {
    const button = b(page, action);
    await expect(button).toBeVisible();
    await expect(button).toBeInViewport({ ratio: 1 });
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const viewport = page.viewportSize()!;
  expect(saveBox!.x).toBeGreaterThanOrEqual(0);
  expect(saveBox!.y).toBeGreaterThanOrEqual(0);
  expect(saveBox!.x + saveBox!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(viewport.height + 1);
  // 44px minimum touch targets for primary footer + navigation controls.
  expect(saveBox!.height).toBeGreaterThanOrEqual(44);
  for (const name of ['view-front', 'view-back']) {
    const control = ms(page, name);
    if (await control.isVisible()) {
      const controlBox = await control.boundingBox();
      if (controlBox) {
        expect(controlBox.height).toBeGreaterThanOrEqual(44);
        expect(controlBox.width).toBeGreaterThanOrEqual(44);
      }
    }
  }
  if (footerBox && box) {
    // Footer never covers the canvas: no area overlap.
    const overlapX = Math.min(box.x + box.width, footerBox.x + footerBox.width) - Math.max(box.x, footerBox.x);
    const overlapY = Math.min(box.y + box.height, footerBox.y + footerBox.height) - Math.max(box.y, footerBox.y);
    expect(overlapX <= 1 || overlapY <= 1).toBe(true);
  }
  await test.info().attach(`canvas-space-${label}`, {
    contentType: 'application/json',
    body: JSON.stringify({ canvas: box, save: saveBox, footer: footerBox }, null, 2),
  });
  await page.screenshot({ path: info.outputPath(`canvas-space-${label}.png`) });
}

test('staff canvas space at 1290x700: normal and enlarged keep canvas, footer, geometry', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { context, page, probe } = await openOfflineContext(browser, { width: 1290, height: 700 });
  try {
    await stageModelProduct(page);
    await fitReference(page);
    await drawRectangleArea(page, 'Chest');
    await b(page, 'model-setup-save').click();
    await expect(b(page, 'model-setup-status')).toContainText('Saved 3D setup');
    await expect(b(page, 'model-setup-status')).toContainText('Provisional');
    await expect(ms(page, 'status')).toHaveText('');

    // Normal view bounds + footer reachability.
    await assertCanvasAndFooter(page, '1290x700-normal', info);
    const canvas = b(page, 'product-model-canvas');
    const beforeNormal = (await canvas.boundingBox())!;
    const productsBefore = await saveJobProducts(page, info, 'canvas-before.logo-project');

    // Opening View and applying Fit preserve the canvas bounds and physical data.
    const toggle = ms(page, 'view-toggle');
    if (await toggle.isVisible()) {
      await toggle.click();
      await expect(ms(page, 'camera-controls')).toBeVisible();
      const openBox = (await canvas.boundingBox())!;
      expect(Math.abs(openBox.y - beforeNormal.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(openBox.height - beforeNormal.height)).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
      const closedBox = (await canvas.boundingBox())!;
      expect(Math.abs(closedBox.y - beforeNormal.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(closedBox.height - beforeNormal.height)).toBeLessThanOrEqual(1);
    }
    await revealModelViewControls(page);
    await ms(page, 'view-front').click();
    await page.locator('[data-model-setup-hook="viewbar"] [data-ps-view="fit"]').click();
    const afterNav = (await canvas.boundingBox())!;
    expect(Math.abs(afterNav.y - beforeNormal.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterNav.height - beforeNormal.height)).toBeLessThanOrEqual(1);
    expect(await saveJobProducts(page, info, 'canvas-after-nav.logo-project')).toBe(productsBefore);

    // Enlarged view keeps the same canvas/footer/geometry guards.
    await b(page, 'product-model-expand').click();
    await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
    await assertCanvasAndFooter(page, '1290x700-enlarged', info);
    const beforeEnlarged = (await canvas.boundingBox())!;
    expect(beforeEnlarged.height).toBeGreaterThanOrEqual(315);
    if (await toggle.isVisible()) {
      await toggle.click();
      const enlargedOpen = (await canvas.boundingBox())!;
      expect(Math.abs(enlargedOpen.y - beforeEnlarged.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(enlargedOpen.height - beforeEnlarged.height)).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
    }
    await revealModelViewControls(page);
    await page.locator('[data-model-setup-hook="viewbar"] [data-ps-view="fit"]').click();
    const enlargedAfterNav = (await canvas.boundingBox())!;
    expect(Math.abs(enlargedAfterNav.height - beforeEnlarged.height)).toBeLessThanOrEqual(1);
    expect(await saveJobProducts(page, info, 'canvas-enlarged-after-nav.logo-project')).toBe(productsBefore);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    assertCleanProbe(probe);
  } finally {
    await context.close();
  }
});


async function assertUnobscuredModelAfterFit(page: Page, label: string, info: TestInfo): Promise<void> {
  await revealModelViewControls(page);
  const navigation = ms(page, 'camera-controls');
  await expect(navigation).toBeVisible();
  await page.locator('[data-model-setup-hook="viewbar"] [data-ps-view="fit"]').click();
  await expect(navigation).toBeHidden();
  await expect(ms(page, 'view-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(ms(page, 'view-toggle')).toBeFocused();
  const model = await b(page, 'product-model-canvas').evaluate(async (node) => {
    const canvas = node as HTMLCanvasElement;
    await new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())));
    // Read the GL buffer directly so HTML overlays cannot conceal model pixels.
    const image = new Image();
    const loaded = new Promise<void>((resolveImage, rejectImage) => {
      image.onload = () => resolveImage();
      image.onerror = () => rejectImage(new Error('Could not read the synthetic model image.'));
    });
    image.src = canvas.toDataURL('image/png');
    await loaded;
    const probe = document.createElement('canvas');
    probe.width = image.naturalWidth;
    probe.height = image.naturalHeight;
    const context = probe.getContext('2d');
    if (!context) throw new Error('2D readback context unavailable.');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
    let left = probe.width;
    let top = probe.height;
    let right = -1;
    let bottom = -1;
    let count = 0;
    for (let y = 0; y < probe.height; y += 1) {
      for (let x = 0; x < probe.width; x += 1) {
        const index = (y * probe.width + x) * 4;
        // The fixture's blue cube is distinct from the white background/markers.
        if (pixels[index + 2]! <= pixels[index + 1]! || pixels[index + 2]! <= pixels[index]!) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
        count += 1;
      }
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.x + left * rect.width / probe.width,
      y: rect.y + top * rect.height / probe.height,
      width: (right - left + 1) * rect.width / probe.width,
      height: (bottom - top + 1) * rect.height / probe.height,
      count,
      canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
  expect(model.count).toBeGreaterThan(500);
  expect(model.x).toBeGreaterThan(model.canvas.x + 1);
  expect(model.y).toBeGreaterThan(model.canvas.y + 1);
  expect(model.x + model.width).toBeLessThan(model.canvas.x + model.canvas.width - 1);
  expect(model.y + model.height).toBeLessThan(model.canvas.y + model.canvas.height - 1);
  const trigger = (await ms(page, 'view-toggle').boundingBox())!;
  const overlapX = Math.min(model.x + model.width, trigger.x + trigger.width) - Math.max(model.x, trigger.x);
  const overlapY = Math.min(model.y + model.height, trigger.y + trigger.height) - Math.max(model.y, trigger.y);
  expect(overlapX <= 0 || overlapY <= 0).toBe(true);
  await info.attach(`unobscured-model-${label}`, { contentType: 'application/json', body: JSON.stringify({ model, trigger }, null, 2) });
  await page.screenshot({ path: info.outputPath(`unobscured-model-${label}.png`) });
}

for (const viewport of [{ width: 1290, height: 700 }, { width: 390, height: 844 }]) {
  test(`Fit leaves the complete model clear of View controls at ${viewport.width}`, async ({ browser }, info) => {
    test.setTimeout(90_000);
    const { context, page, probe } = await openOfflineContext(browser, viewport);
    try {
      await stageModelProduct(page);
      await assertUnobscuredModelAfterFit(page, `${viewport.width}-normal`, info);
      const canvas = b(page, 'product-model-canvas');
      const before = (await canvas.boundingBox())!;
      await ms(page, 'view-toggle').focus();
      await page.keyboard.press('Enter');
      await expect(ms(page, 'camera-controls')).toBeVisible();
      for (const control of await ms(page, 'camera-controls').locator('button,select').all()) {
        await expect(control).toBeVisible();
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await page.keyboard.press('Escape');
      await expect(ms(page, 'camera-controls')).toBeHidden();
      await expect(ms(page, 'view-toggle')).toBeFocused();
      expect((await canvas.boundingBox())!.height).toBe(before.height);
      await b(page, 'product-model-expand').click();
      await assertUnobscuredModelAfterFit(page, `${viewport.width}-enlarged`, info);
      assertCleanProbe(probe);
    } finally {
      await context.close();
    }
  });
}
