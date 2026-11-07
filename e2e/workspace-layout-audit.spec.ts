// Workspace layout audit (Worker B-owned): synthetic model-only staff UI
// layout evidence at exactly 1440x900, 768x1024 and 390x844 over offline
// file://. Captures idle and active polygon/drawing toolbar states in normal
// and enlarged views (four states per viewport) using real intake, trusted
// surface reference picks and tool switches. Reports measured rectangles,
// never resizes the canvas to satisfy metrics. Synthetic fixtures only.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chooseModelTool, revealModelViewControls, assertCleanProbe, gotoBuilder, openOfflineContext } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;

type Mode = 'normal' | 'enlarged';
type ToolbarState = 'idle' | 'active-drawing';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const ms = (page: Page, name: string) => page.locator(`[data-model-setup-hook="${name}"]`);

async function rectOf(
  locator: import('@playwright/test').Locator,
): Promise<Rect | null> {
  const box = await locator.boundingBox();
  if (box === null) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** Stage a synthetic model product through the real intake controls. */
async function stageModelProduct(page: Page): Promise<void> {
  const snapshotHtml = process.env.LOGOTOOL_LAYOUT_AUDIT_HTML;
  if (snapshotHtml) await page.goto(pathToFileURL(resolve(snapshotHtml)).href);
  else await gotoBuilder(page);
  await b(page, 'job-landing-create').click();
  await b(page, 'customer-name').fill('Synthetic layout audit');
  await b(page, 'job-ref').fill('LAYOUT-AUDIT');
  await b(page, 'intake-mode-model').check();
  await b(page, 'product-file').setInputFiles({
    name: 'audit-cube.glb',
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from(cubeGlb(false, false)),
  });
  await expect(b(page, 'intake-model-status')).toContainText('ready');
  await b(page, 'product-name').fill('Audit product');
  await b(page, 'product-add').click();
  await expect(b(page, 'product-editor')).toBeVisible();
  await expect(b(page, 'product-model-canvas')).toBeVisible();
}

/** Fit a synthetic provisional reference through the actual surface controls. */
async function measureSyntheticReference(page: Page): Promise<void> {
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

/** Two points keep the polygon transaction visibly in progress. */
async function addPolygonPoints(page: Page): Promise<void> {
  const canvas = b(page, 'product-model-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * .48, box.y + box.height * .48);
  await page.mouse.click(box.x + box.width * .52, box.y + box.height * .48);
  await expect(ms(page, 'status')).toContainText('point 2');
}

/** Visible top-toolbar controls: wrapping rows allowed, hidden excluded. */
function toolbarControls(page: Page): import('@playwright/test').Locator {
  return page.locator(
    [
      '.product-model-toolbar button',
      '.product-model-toolbar select',
      '.product-model-toolbar input',
      '[data-model-setup-hook="viewbar"] button',
      '[data-model-setup-hook="viewbar"] select',
      '[data-model-setup-hook="viewbar"] input',
      'button[data-model-setup-hook^="tool-"]',
    ].join(', '),
  );
}

async function assertNoToolbarOverlap(page: Page): Promise<Rect[]> {
  const rects = await toolbarControls(page).evaluateAll((nodes) =>
    nodes
      .filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')
      .filter(node => {
        let parent = node.parentElement;
        const rect = node.getBoundingClientRect();
        while (parent && !parent.classList.contains('product-model-toolbar')) {
          const style = getComputedStyle(parent);
          if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
            const clip = parent.getBoundingClientRect();
            if (rect.left < clip.left - 1 || rect.right > clip.right + 1) return false;
          }
          parent = parent.parentElement;
        }
        return true;
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
  );
  const toolbar = (await page.locator('.product-model-toolbar').boundingBox())!;
  for (const rect of rects) {
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.x).toBeGreaterThanOrEqual(toolbar.x - 1);
    expect(rect.x + rect.width).toBeLessThanOrEqual(toolbar.x + toolbar.width + 1);
    expect(rect.y).toBeGreaterThanOrEqual(toolbar.y - 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(toolbar.y + toolbar.height + 1);
  }
  for (const strip of await page.locator('.product-editor .model-setup-camera-controls, .product-editor .product-editor-tool-scroll, .product-editor [data-model-setup-hook="areas-tool-row"], .product-editor .model-setup-command-strip').all()) {
    // Measure both header (editing/lighting) and camera/display scroll rows in
    // normal and enlarged phones: keyboard focus must scroll each action into
    // view with 44px targets and full labels preserved.
    if (await strip.evaluate(node => getComputedStyle(node).display !== 'flex')) continue;
    for (const control of await strip.locator('button, select, input').all()) {
      if (await control.isDisabled() || !await control.isVisible()) continue;
      await control.focus();
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await strip.evaluate(node => { node.scrollLeft = 0; });
  }
  const overlaps: Array<{ first: Rect; second: Rect }> = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const first = rects[i]!;
      const second = rects[j]!;
      const overlapX =
        Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
      const overlapY =
        Math.min(first.y + first.height, second.y + second.height) -
        Math.max(first.y, second.y);
      if (overlapX > 1 && overlapY > 1) overlaps.push({ first, second });
    }
  }
  expect(overlaps).toEqual([]);
  return rects;
}

/** Save stays reachable: visible/enabled, or reachable via real scrolling. */
async function expectSaveReachable(page: Page): Promise<{ visible: boolean; enabled: boolean }> {
  const save = b(page, 'model-setup-save');
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  const visible = await save.isVisible();
  const enabled = await save.isEnabled();
  expect(visible).toBe(true);
  await expect(b(page, 'job-save')).toBeVisible();
  return { visible, enabled };
}

interface LayoutMeasurement {
  viewport: { width: number; height: number };
  mode: Mode;
  toolbar: ToolbarState;
  canvasRect: Rect | null;
  canvasCssHeight: number | null;
  canvasVisibleHeight: number | null;
  canvasBottomBelowViewport: boolean | null;
  toolbarRect: Rect | null;
  toolbarHeight: number | null;
  topBarRect: Rect | null;
  saveSetupRect: Rect | null;
  saveSetupVisible: boolean;
  saveSetupEnabled: boolean;
  jobSaveRect: Rect | null;
  toolbarControlCount: number;
  documentScrollHeight: number;
  documentScrollWidth: number;
  viewportWidth: number;
  entryPoint: string;
  scrollY: number;
  evidence: { initialViewportShot: string; fullPageShot: string | null };
}

async function measureState(
  page: Page,
  viewport: { width: number; height: number },
  mode: Mode,
  toolbar: ToolbarState,
): Promise<LayoutMeasurement> {
  const canvas = b(page, 'product-model-canvas');
  const canvasRect = await rectOf(canvas);
  const canvasVisibleHeight =
    canvasRect === null
      ? null
      : await canvas.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return Math.max(
            0,
            Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
          );
        });
  const canvasBottomBelowViewport =
    canvasRect === null ? null : canvasRect.y + canvasRect.height > viewport.height + 1;
  const toolbarRect = await rectOf(page.locator('[data-model-setup-hook="viewbar"]'));
  const topBarRect = await rectOf(page.locator('.product-model-toolbar'));
  const saveSetupRect = await rectOf(b(page, 'model-setup-save'));
  const jobSaveRect = await rectOf(b(page, 'job-save'));
  const saveSetupVisible = await b(page, 'model-setup-save').isVisible();
  const saveSetupEnabled = await b(page, 'model-setup-save').isEnabled();
  const toolbarControlCount = await toolbarControls(page)
    .evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden').length)
    .catch(() => 0);
  const documentScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const documentScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  return {
    viewport: { ...viewport },
    mode,
    toolbar,
    canvasRect,
    canvasCssHeight: canvasRect?.height ?? null,
    canvasVisibleHeight,
    canvasBottomBelowViewport,
    toolbarRect,
    toolbarHeight: toolbarRect?.height ?? null,
    topBarRect,
    saveSetupRect,
    saveSetupVisible,
    saveSetupEnabled,
    jobSaveRect,
    toolbarControlCount,
    documentScrollHeight,
    documentScrollWidth,
    viewportWidth,
    entryPoint: page.url(),
    scrollY: await page.evaluate(() => window.scrollY),
    evidence: { initialViewportShot: '', fullPageShot: null },
  };
}

async function captureState(
  page: Page,
  viewport: { width: number; height: number },
  mode: Mode,
  toolbar: ToolbarState,
  info: import('@playwright/test').TestInfo,
): Promise<LayoutMeasurement> {
  // Initial-viewport evidence always starts at the top of the document.
  await page.evaluate(() => window.scrollTo(0, 0));
  const slug = `${viewport.width}x${viewport.height}-${mode}-${toolbar}`;
  const initialShot = `${slug}-initial-viewport.png`;
  await page.screenshot({ path: info.outputPath(initialShot) });
  const measurement = await measureState(page, viewport, mode, toolbar);
  measurement.evidence.initialViewportShot = initialShot;
  // Full-page proof when the model extends below the initial phone viewport.
  if (measurement.canvasBottomBelowViewport === true) {
    const fullShot = `${slug}-full-page.png`;
    await page.screenshot({ path: info.outputPath(fullShot), fullPage: true });
    measurement.evidence.fullPageShot = fullShot;
  }
  await test.info().attach(`layout-${slug}`, {
    contentType: 'application/json',
    body: JSON.stringify(measurement, null, 2),
  });
  return measurement;
}

for (const viewport of VIEWPORTS) {
  test(`workspace layout audit at ${viewport.width}x${viewport.height}: idle/active toolbar in normal/enlarged views`, async ({
    browser,
  }, info) => {
    test.setTimeout(120_000);
    const { context, page, probe } = await openOfflineContext(browser, { ...viewport });
    try {
      await stageModelProduct(page);

      // State 1: normal view, idle toolbar (default rotate tool).
      await chooseModelTool(page, 'rotate');
      let measurement = await captureState(page, { ...viewport }, 'normal', 'idle', info);
      expect(measurement.canvasCssHeight).not.toBeNull();
      // 180 is the existing usable-minimum floor (docs/internal-builder.md);
      // it is a floor assertion only, never a typical-size expectation.
      expect(measurement.canvasCssHeight!).toBeGreaterThanOrEqual(180);
      await assertNoToolbarOverlap(page);
      await expectSaveReachable(page);

      // State 2: normal view, active drawing toolbar after trusted picks.
      await measureSyntheticReference(page);
      await chooseModelTool(page, 'freehand');
      await expect(ms(page, 'tool-freehand')).toHaveAttribute('aria-pressed', 'true');
      await ms(page, 'area-name').fill('Audit area');
      await addPolygonPoints(page);
      await expect(ms(page, 'area-finish')).toBeVisible();
      measurement = await captureState(page, { ...viewport }, 'normal', 'active-drawing', info);
      expect(measurement.canvasCssHeight!).toBeGreaterThanOrEqual(180);
      await assertNoToolbarOverlap(page);
      await expectSaveReachable(page);

      // State 3: enlarged view, idle toolbar.
      await b(page, 'product-model-expand').click();
      await expect(b(page, 'product-editor')).toHaveClass(/station-expanded-workspace/);
      await chooseModelTool(page, 'rotate');
      await expect(ms(page, 'tool-rotate')).toHaveAttribute('aria-pressed', 'true');
      measurement = await captureState(page, { ...viewport }, 'enlarged', 'idle', info);
      expect(measurement.canvasCssHeight!).toBeGreaterThanOrEqual(180);
      await assertNoToolbarOverlap(page);
      await expectSaveReachable(page);

      // State 4: enlarged view, active drawing toolbar.
      await chooseModelTool(page, 'freehand');
      await expect(ms(page, 'tool-freehand')).toHaveAttribute('aria-pressed', 'true');
      await addPolygonPoints(page);
      await expect(ms(page, 'area-finish')).toBeVisible();
      measurement = await captureState(page, { ...viewport }, 'enlarged', 'active-drawing', info);
      expect(measurement.canvasCssHeight!).toBeGreaterThanOrEqual(180);
      await assertNoToolbarOverlap(page);
      await expectSaveReachable(page);

      // No horizontal page overflow at any viewport.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
        true,
      );
      assertCleanProbe(probe);
    } finally {
      await context.close();
    }
  });
}
