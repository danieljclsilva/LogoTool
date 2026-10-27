import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { release } from 'node:os';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import { gotoBuilder, revealBuilderControl } from './helpers.js';

// Visual placement acceptance (lead-owned slice): direct on-logo pointer
// handles on the photo/diagram stage. Synthetic fixtures only, offline
// file:// throughout. Every test asserts zero console/page errors and zero
// HTTP(S) requests.

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

function pw(page: Page, name: string) {
  return page.locator(`[data-placement-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openStation(browser: Browser): Promise<{ context: BrowserContext; page: Page; probe: { pageErrors: string[]; consoleErrors: string[]; networkRequests: string[] } }> {
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const probe = { pageErrors: [] as string[], consoleErrors: [] as string[], networkRequests: [] as string[] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  await gotoBuilder(page);
  await expect(page.locator('[data-job-landing]')).toBeVisible();
  await page.locator('[data-builder-hook="job-landing-create"]').click();
  await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
  return { context, page, probe };
}

async function syntheticPngBytes(page: Page, fill = '#1d6f3a', w = 400, h = 300): Promise<Uint8Array> {
  const base64 = await page.evaluate(({ color, width, height }: { color: string; width: number; height: number }): string => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d canvas unavailable for synthetic PNG fixture.');
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  }, { color: fill, width: w, height: h });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

test('visual placement: photo/diagram handles move, resize, rotate, cancel, siblings', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const { context, page, probe } = await openStation(browser);
  try {
    await info.attach('offline-environment', {
      contentType: 'application/json',
      body: JSON.stringify({
        os: process.platform, release: release(), arch: process.arch,
        browserVersion: browser.version(), viewport: { width: 1280, height: 900 },
        offline: true, entryPoint: 'file://', scope: 'visual-placement-handles',
      }, null, 2),
    });
    await (await shown(page, 'customer-name')).fill('Visual Handles Ltd');
    await (await shown(page, 'job-ref')).fill('VIS-001');
    const jacketPng = await syntheticPngBytes(page, '#1d6f3a');
    await shown(page, 'product-view-add');
    const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
    await rows.first().locator('input[type="text"]').fill('Front');
    await rows.first().locator('input[type="file"]').setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: Buffer.from(jacketPng) });
    await expect(rows.first().locator('.view-row-state')).toContainText('ready');
    await (await shown(page, 'product-name')).fill('Team jacket');
    await (await shown(page, 'product-add')).click();
    await expect(await shown(page, 'product-status')).toContainText('Added');

    // Calibrated 280x200 mm rectangle + one anchor (rect corners double as the safe area).
    const workspace = builder(page, 'product-workspace');
    await workspace.getByRole('button', { name: 'Set up scale' }).click();
    const guided = builder(page, 'guided-scale');
    await expect(guided).toBeVisible();
    const overlay = guided.locator('.guided-scale-overlay[aria-label*="rectangle corners"]');
    const overlayBox = (await overlay.boundingBox())!;
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]] as Array<[number, number]>) {
      await overlay.click({ position: { x: Math.round(overlayBox.width * fx), y: Math.round(overlayBox.height * fy) } });
    }
    await guided.locator('[data-guided="width"]').fill('280');
    await guided.locator('[data-guided="height"]').fill('200');
    await guided.locator('[data-guided="create"]').click();
    await expect(await shown(page, 'workspace-status')).toContainText('Measured the Front view: 280×200');
    await workspace.getByRole('button', { name: 'Anchor', exact: true }).click();
    const stage = workspace.locator('.product-setup-overlay').first();
    const stageBox = (await stage.boundingBox())!;
    await stage.click({ position: { x: Math.round(stageBox.width * 0.5), y: Math.round(stageBox.height * 0.5) } });
    await expect(workspace.getByText('Created “Anchor 1”')).toBeVisible();
    await workspace.getByRole('button', { name: 'Save product setup' }).click();
    await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 1 anchors\)/)).toBeVisible();

    const crestPng = await syntheticPngBytes(page, '#d4af37', 200, 120);
    await (await shown(page, 'logo-file')).setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: Buffer.from(crestPng) });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await (await shown(page, 'job-to-placements')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();

    const host = builder(page, 'job-placement-host');
    await host.getByRole('button', { name: 'Add logo placement' }).click();
    await pw(page, 'pw-add-width').fill('90');
    await pw(page, 'pw-add-height').fill('40');
    const addMethod = pw(page, 'pw-add-method');
    if ((await addMethod.count()) > 0) await addMethod.selectOption({ label: 'print' });
    await pw(page, 'pw-add-confirm').click();
    await expect(host.locator('[data-placement-hook="pw-placement-list"]')).toContainText('crest');
    await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();

    const svg = host.locator('[data-placement-hook="pw-stage-svg"]');
    await expect(svg).toBeVisible();
    await expect(svg.locator('polygon[data-placement-index="0"]')).toBeVisible();

    // Handles, corner measurements and white-square anchors render.
    for (let i = 0; i < 4; i += 1) {
      await expect(host.locator(`[data-placement-hook="pw-resize-handle-${i}"]`)).toBeVisible();
    }
    await expect(host.locator('[data-placement-hook="pw-rotate-handle"]')).toBeVisible();
    await expect(host.locator('[data-placement-hook^="pw-corner-dist-"]')).toHaveCount(4);
    const anchorRect = host.locator('[data-placement-hook^="pw-anchor-"]').first();
    await expect(anchorRect).toBeVisible();
    expect(await anchorRect.evaluate((node) => node.tagName.toLowerCase())).toBe('rect');
    expect(await anchorRect.evaluate((node) => (node as SVGRectElement).getAttribute('fill'))).toBe('#fff');
    const labelSizes = await svg.evaluate((node) => {
      const texts = Array.from(node.querySelectorAll('text'));
      const anchor = texts.filter((t) => (t.textContent ?? '').includes('mm') && !(t.getAttribute('data-placement-hook') ?? '').startsWith('pw-corner-dist'));
      const corner = texts.filter((t) => (t.getAttribute('data-placement-hook') ?? '').startsWith('pw-corner-dist'));
      const size = (t: SVGTextElement): number => parseFloat(t.getAttribute('font-size') ?? '0');
      return {
        anchor: anchor.map(size),
        corner: corner.map(size),
      };
    });
    expect(labelSizes.corner.length).toBe(4);
    if (labelSizes.anchor.length > 0) {
      expect(Math.max(...labelSizes.corner)).toBeLessThan(Math.min(...labelSizes.anchor));
    }

    const readNum = async (hook: string): Promise<number> => Number(await pw(page, hook).inputValue());
    const saveProject = async (name: string, keyboard = false) => {
      const downloadEvent = page.waitForEvent('download');
      const button = builder(page, 'job-save');
      if (keyboard) { await button.evaluate((node) => (node as HTMLElement).focus({ preventScroll: true })); await button.press('Enter'); }
      else await button.click();
      const file = info.outputPath(name); await (await downloadEvent).saveAs(file);
      return (await parseProjectPackage(new Uint8Array(await readFile(file)), {
        sha256: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
      })).project;
    };
    const original = await saveProject('photo-original.logo-project');


    // Move: drag the footprint, live fields follow, commit lands on pointerup.
    const beforeX = await readNum('pw-x');
    const beforeY = await readNum('pw-y');
    await svg.scrollIntoViewIfNeeded();
    const polyBox = (await svg.locator('polygon[data-placement-index="0"]').boundingBox())!;
    const startX = polyBox.x + polyBox.width / 2;
    const startY = polyBox.y + polyBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY + 10, { steps: 6 });
    const duringMove = await saveProject('photo-during-move.logo-project', true);
    expect(duringMove.configurations).toEqual(original.configurations);
    const liveX = await readNum('pw-x');
    expect(Math.abs(liveX - beforeX)).toBeGreaterThan(0.5);
    await page.mouse.up();
    const afterX = await readNum('pw-x');
    expect(Math.abs(afterX - beforeX)).toBeGreaterThan(0.5);

    // Resize: drag corner handle 3 outward; width/height commit together.
    const beforeW = await readNum('pw-width');
    const beforeH = await readNum('pw-height');
    const cornerBox = (await host.locator('[data-placement-hook="pw-resize-handle-2"]').boundingBox())!;
    await page.mouse.move(cornerBox.x + cornerBox.width / 2, cornerBox.y + cornerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cornerBox.x + cornerBox.width / 2 + 30, cornerBox.y + cornerBox.height / 2 - 30, { steps: 6 });
    await page.mouse.up();
    expect(Math.abs((await readNum('pw-width')) - beforeW)).toBeGreaterThan(0.5);
    expect(Math.abs((await readNum('pw-height')) - beforeH)).toBeGreaterThan(0.5);

    // Rotate: drag the rotate handle; rotation commits.
    const beforeR = await readNum('pw-rotation');
    const rotBox = (await host.locator('[data-placement-hook="pw-rotate-handle"]').boundingBox())!;
    await page.mouse.move(rotBox.x + rotBox.width / 2, rotBox.y + rotBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rotBox.x + rotBox.width / 2 + 45, rotBox.y + rotBox.height / 2 - 10, { steps: 6 });
    await page.mouse.up();
    expect(Math.abs((await readNum('pw-rotation')) - beforeR)).toBeGreaterThan(0.2);

    // Sibling preservation: duplicate, then move the first; the second keeps its size text.
    await host.getByRole('button', { name: 'Duplicate placement' }).click();
    expect(await host.locator('[data-placement-hook^="pw-placement-row-"]').count()).toBe(2);
    const siblingBaseline = await saveProject('photo-siblings.logo-project');
    const siblingText = await host.locator('[data-placement-hook^="pw-placement-row-"]').nth(1).innerText();
    await host.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
    await svg.scrollIntoViewIfNeeded();
    const polyBox2 = (await svg.locator('polygon[data-placement-index="0"]').boundingBox())!;
    await page.mouse.move(polyBox2.x + polyBox2.width / 2, polyBox2.y + polyBox2.height / 2);
    await page.mouse.down();
    await page.mouse.move(polyBox2.x + polyBox2.width / 2 - 25, polyBox2.y + polyBox2.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(await host.locator('[data-placement-hook^="pw-placement-row-"]').nth(1).innerText()).toBe(siblingText);
    const afterSiblingMove = await saveProject('photo-sibling-moved.logo-project');
    expect(afterSiblingMove.configurations[0]!.placements[1]).toEqual(siblingBaseline.configurations[0]!.placements[1]);
    expect(afterSiblingMove.configurations[0]!.placements[0]!.pos).not.toEqual(siblingBaseline.configurations[0]!.placements[0]!.pos);

    // Escape cancels a drag without committing.
    const cancelX = await readNum('pw-x');
    await svg.scrollIntoViewIfNeeded();
    const polyBox3 = (await svg.locator('polygon[data-placement-index="0"]').boundingBox())!;
    await page.mouse.move(polyBox3.x + polyBox3.width / 2, polyBox3.y + polyBox3.height / 2);
    await page.mouse.down();
    await page.mouse.move(polyBox3.x + polyBox3.width / 2 + 50, polyBox3.y + polyBox3.height / 2, { steps: 4 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(Math.abs((await readNum('pw-x')) - cancelX)).toBeLessThan(0.5);

    // Shift-drag (unsnapped fine adjust) still commits without errors.
    const shiftX = await readNum('pw-x');
    await svg.scrollIntoViewIfNeeded();
    const polyBox4 = (await svg.locator('polygon[data-placement-index="0"]').boundingBox())!;
    await page.mouse.move(polyBox4.x + polyBox4.width / 2, polyBox4.y + polyBox4.height / 2);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(polyBox4.x + polyBox4.width / 2 + 24, polyBox4.y + polyBox4.height / 2 + 6, { steps: 4 });
    await page.keyboard.up('Shift');
    await page.mouse.up();
    expect(Math.abs((await readNum('pw-x')) - shiftX)).toBeGreaterThan(0.2);

    // Centre guides appear near the safe-area centre, and Shift releases snapping.
    await svg.scrollIntoViewIfNeeded();
    const safeCentre = await svg.locator('polygon[data-placement-hook^="pw-area-"]').first().evaluate((node) => {
      const polygon = node as SVGPolygonElement;
      const points = [...polygon.points];
      const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      const screen = new DOMPoint(x, y).matrixTransform(polygon.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
    const snapBox = (await svg.locator('polygon[data-placement-index="0"]').boundingBox())!;
    await page.mouse.move(snapBox.x + snapBox.width / 2, snapBox.y + snapBox.height / 2); await page.mouse.down();
    await page.mouse.move(safeCentre.x + 1, safeCentre.y + 1, { steps: 4 });
    await expect(host.locator('[data-placement-hook="pw-snap-guide"]')).not.toHaveCount(0);
    await page.keyboard.down('Shift');
    await page.mouse.move(safeCentre.x + 1.2, safeCentre.y + 1.2);
    await expect(host.locator('[data-placement-hook="pw-snap-guide"]')).toHaveCount(0);
    await page.mouse.up(); await page.keyboard.up('Shift');
    // Keyboard equivalents keep the visual handles accessible.
    const rotationBeforeKey = await readNum('pw-rotation');
    await pw(page, 'pw-rotate-handle').focus(); await pw(page, 'pw-rotate-handle').press(']');
    expect(await readNum('pw-rotation')).toBeCloseTo(rotationBeforeKey + 1, 1);
    await page.screenshot({ path: info.outputPath('visual-photo-handles.png') });

    // Safe-area warning path stays intact: an oversized width blocks Apply.
    await pw(page, 'pw-width').fill('900');
    await expect(host.getByRole('button', { name: 'Apply changes' })).toBeVisible();
    await host.getByRole('button', { name: 'Apply changes' }).click();

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
    await context.close();
  } catch (error) {
    await page.screenshot({ path: info.outputPath('visual-photo-failure.png') });
    await context.close();
    throw error;
  }
});
