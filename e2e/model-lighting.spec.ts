import {expect, test, type Page, type Locator} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import { addProductAndOpenSetup,gotoBuilder, openOfflineContext, assertCleanProbe} from './helpers.js';
import {customerModelPackage} from './fixtures/customer-model-package.js';
import {parseProjectPackage} from '../src/packaging/project-package/index.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const pw = (page: Page, name: string) => page.locator(`[data-placement-hook="${name}"]`);
const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function mark(page: Page): Promise<Uint8Array> {
  return Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 100, 100);
    return canvas.toDataURL().split(',')[1]!;
  }), 'base64');
}

/** Measure only the synthetic blue garment, excluding white background/artwork. */
async function blueLuminance(canvas: Locator): Promise<number> {
  return canvas.evaluate(async element => {
    if (element instanceof HTMLImageElement) await element.decode();
    const source = element as HTMLCanvasElement, copy = document.createElement('canvas');
    copy.width = source.width; copy.height = source.height;
    const ctx = copy.getContext('2d')!; ctx.drawImage(source, 0, 0, copy.width, copy.height);
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let total = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]!, g = pixels[i + 1]!, blue = pixels[i + 2]!;
      if (blue > 35 && blue > r * 1.3 && blue > g * 1.1) { total += (r + g + blue) / 3; count++; }
    }
    return count > 100 ? total / count : 0;
  });
}

async function openPrepared(page: Page, bytes: Uint8Array, name = 'lighting.logo-project') {
  await b(page, 'job-open-file').setInputFiles({name, mimeType: 'application/zip', buffer: Buffer.from(bytes)});
  await expect(b(page, 'source-status')).toContainText(`Loaded ${name}`);
  for (const box of await page.locator('[data-job-step=prepare] input[type=checkbox]:visible').all()) await box.check();
  await b(page, 'job-to-placements').click();
  await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-ready', 'true');
}

async function save(page: Page, path: string) {
  const event = page.waitForEvent('download'); await b(page, 'job-save').click();
  await (await event).saveAs(path);
  return parseProjectPackage(new Uint8Array(await readFile(path)), {sha256});
}

for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
  test(`model lighting visibly changes and survives save/reopen at ${viewport.width}x${viewport.height}`, async ({browser}, info) => {
    test.setTimeout(60_000);
    const {context, page, probe} = await openOfflineContext(browser, viewport);
    try {
      const fixture = await customerModelPackage(await mark(page));
      await gotoBuilder(page); await openPrepared(page, fixture.bytes);
      const control = b(page, 'model-lighting');
      await expect(control).toBeVisible(); await expect(control).toHaveValue('100');
      await pw(page, 'pw-model-front').click();
      const canvas = pw(page, 'pw-model-canvas'), originalCanvas = await canvas.elementHandle();
      await canvas.click({position: {x: (await canvas.boundingBox())!.width / 2, y: (await canvas.boundingBox())!.height / 2}});
      await expect(pw(page, 'pw-model-corner-0')).toBeVisible();
      await expect.poll(() => blueLuminance(canvas)).toBeGreaterThan(20);
      const normal = await blueLuminance(canvas);
      const before = await save(page, info.outputPath('before.logo-project'));
      const cornerBefore = (await pw(page, 'pw-model-corner-0').boundingBox())!;
      const frameBefore = (await canvas.boundingBox())!;
      await control.focus(); await control.press('End');
      await expect(control).toHaveValue('300');
      await expect(b(page, 'model-lighting-value')).toContainText('300');
      await expect.poll(() => blueLuminance(canvas)).toBeGreaterThan(normal + 5);
      expect(await canvas.evaluate((el, old) => el === old, originalCanvas)).toBe(true);
      const cornerAfter = await pw(page, 'pw-model-corner-0').boundingBox();
      const frameAfter = (await canvas.boundingBox())!;
      expect(cornerAfter!.x - frameAfter.x).toBeCloseTo(cornerBefore.x - frameBefore.x, 0);
      expect(cornerAfter!.y - frameAfter.y).toBeCloseTo(cornerBefore.y - frameBefore.y, 0);
      const savedPath = info.outputPath('brighter.logo-project'), saved = await save(page, savedPath);
      expect(saved.project.products).toEqual(before.project.products);
      expect(saved.project.configurations).toEqual(before.project.configurations);
      const manifest = JSON.parse(new TextDecoder().decode(saved.assets.find(a => a.path === 'presentation/preview.json')!.bytes));
      expect(manifest.models[0].lighting).toBe(3);
      const originalModel = before.assets.find(a => a.path.endsWith('.glb'))!;
      expect(saved.assets.find(a => a.path === originalModel.path)!.bytes).toEqual(originalModel.bytes);
      await page.screenshot({path: info.outputPath('lighting-brighter.png')});
      await openPrepared(page, new Uint8Array(await readFile(savedPath)), 'brighter.logo-project');
      await expect(control).toHaveValue('300');
      await b(page, 'editor-setup').click(); await expect(control).toHaveValue('300');
      await b(page, 'editor-logos').click(); await expect(control).toHaveValue('300');
      await b(page, 'model-lighting-reset').click(); await expect(control).toHaveValue('100');
      await expect.poll(() => blueLuminance(canvas)).toBeLessThan(normal + 5);
      // Opening an old project never inherits another model's display settings.
      await control.focus(); await control.press('End');
      await save(page, info.outputPath('switch-from-bright.logo-project'));
      await openPrepared(page, fixture.bytes, 'legacy-default.logo-project');
      await expect(control).toHaveValue('100');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      assertCleanProbe(probe);
    } finally { await context.close(); }
  });
}

test('customer issue inherits model lighting while keeping the limited customer controls', async ({browser}, info) => {
  test.setTimeout(60_000);
  const staff = await openOfflineContext(browser, {width: 1440, height: 900});
  const customer = await openOfflineContext(browser, {width: 1440, height: 900});
  const page = staff.page, editor = customer.page;
  try {
    const fixture = await customerModelPackage(await mark(page));
    await gotoBuilder(page);
    await b(page, 'job-open-file').setInputFiles({name: 'source.logo-project', mimeType: 'application/zip', buffer: Buffer.from(fixture.bytes)});
    await expect(b(page, 'source-status')).toContainText('Loaded source.logo-project');
    await b(page, 'customer-name').fill('Synthetic lighting customer');
    await b(page, 'job-ref').fill('SYN-LIGHTING'); await b(page, 'issued-by').fill('Synthetic operator');
    for (const box of await page.locator('[data-job-step=prepare] input[type=checkbox]:visible').all()) await box.check();
    await b(page, 'job-to-placements').click();
    await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-ready', 'true');
    await b(page, 'model-lighting').focus(); await b(page, 'model-lighting').press('End');
    await page.getByRole('button', {name: 'Send for customer approval', exact: true}).click();
    const branch = page.locator('[data-job-branch=approval]');
    await branch.getByText('More options', {exact: true}).click(); await b(page, 'job-issue-project-new').click();
    await branch.getByRole('button', {name: 'Create customer file', exact: true}).click();
    await expect(branch).toContainText('Customer file created');
    const event = page.waitForEvent('download'); await branch.getByRole('button', {name: 'Save customer file', exact: true}).click();
    const html = info.outputPath('customer-lighting.html'); await (await event).saveAs(html);
    await editor.goto(pathToFileURL(html).href);
    await expect(pw(editor, 'pw-model-workbench')).toHaveAttribute('data-artwork-count', '2');
    const canvas = pw(editor, 'pw-model-canvas'); await expect.poll(() => blueLuminance(canvas)).toBeGreaterThan(20);
    const bright = await blueLuminance(canvas);
    await expect(editor.getByRole('slider', {name: /lighting/i})).toHaveCount(0);
    await editor.locator('[data-customer-hook=file-input]').setInputFiles({name: 'legacy.logo-project', mimeType: 'application/zip', buffer: Buffer.from(fixture.bytes)});
    await expect(pw(editor, 'pw-model-workbench')).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => blueLuminance(canvas)).toBeLessThan(bright - 5);
    assertCleanProbe(staff.probe); assertCleanProbe(customer.probe);
  } finally { await customer.context.close(); await staff.context.close(); }
});

test('changing lighting refreshes cached document images without changing the physical revision', async ({browser}, info) => {
  test.setTimeout(60_000);
  const {context, page, probe} = await openOfflineContext(browser, {width: 1440, height: 900});
  try {
    const fixture = await customerModelPackage(await mark(page));
    await gotoBuilder(page); await openPrepared(page, fixture.bytes);
    const before = await save(page, info.outputPath('document-before.logo-project'));
    await b(page, 'model-lighting').focus(); await b(page, 'model-lighting').press('Home');
    await b(page, 'job-step-3').click();
    const picture = page.locator('[data-doc-review-preview] img[alt*="model view with applied artwork"]').first();
    await expect(picture).toBeVisible();
    await expect.poll(() => blueLuminance(picture)).toBeGreaterThan(10);
    const dim = await blueLuminance(picture), oldImage = await picture.getAttribute('src');
    await b(page, 'job-step-2').click(); await b(page, 'editor-logos').click();
    await b(page, 'model-lighting').focus(); await b(page, 'model-lighting').press('End');
    await b(page, 'job-step-3').click();
    await expect.poll(() => picture.getAttribute('src')).not.toBe(oldImage);
    await expect.poll(() => blueLuminance(picture)).toBeGreaterThan(dim + 5);
    const after = await save(page, info.outputPath('document-after.logo-project'));
    expect(after.project.revision).toBe(before.project.revision);
    expect(after.project.products).toEqual(before.project.products);
    expect(after.project.configurations).toEqual(before.project.configurations);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('lighting is available immediately after model intake without calibration or areas', async ({browser}) => {
  const {context, page, probe} = await openOfflineContext(browser, {width: 390, height: 844});
  try {
    const fixture = await customerModelPackage(await mark(page));
    const parsed = await parseProjectPackage(fixture.bytes, {sha256});
    const model = parsed.assets.find(asset => asset.path.endsWith('.glb'))!;
    await gotoBuilder(page); await b(page, 'job-landing-create').click();
    await b(page, 'intake-mode-model').check();
    await b(page, 'product-file').setInputFiles({name: 'new-model.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(model.bytes)});
    await expect(b(page, 'intake-model-status')).toContainText('ready');
    await b(page, 'product-name').fill('Synthetic uncalibrated model'); await addProductAndOpenSetup(page);
    await expect(b(page, 'model-lighting')).toBeVisible();
    await expect(b(page, 'model-lighting')).toHaveValue('100');
    await b(page, 'model-lighting').focus(); await b(page, 'model-lighting').press('End');
    await expect(b(page, 'model-lighting-value')).toContainText('300');
    await b(page, 'model-lighting-reset').click(); await expect(b(page, 'model-lighting')).toHaveValue('100');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
