import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import {
  addProductAndOpenSetup,
  gotoBuilder,
  revealBuilderControl,
  revealCustomerControl,
  selectCustomerOption,
} from './helpers.js';

// Fresh direct-photo handoff: normal operator flow (new job -> two Images
// rows labelled Front/Back -> scale rectangle + Save product setup on each
// view -> one artwork logo -> standalone customer file) must yield both
// photos in the customer proof by saved label with one correct overlay each.
// Public UI outcome only: visible labels, enabled photo control, overlay
// count, trial-copy mapping status. Synthetic fixtures only; offline file://.

const sha256: ProjectPackageSha256 = async (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
const digestOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return builder(page, name);
}

async function openBuilder(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
  probe: { pageErrors: string[]; consoleErrors: string[]; networkRequests: string[] };
}> {
  const context = await browser.newContext({
    offline: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  });
  await context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const probe = { pageErrors: [] as string[], consoleErrors: [] as string[], networkRequests: [] as string[] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(String(message.text()));
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

/** Two synthetic photos with distinct marks (white patch + letter in opposite corners). */
async function syntheticPhoto(
  page: Page,
  fill: string,
  seed: 'front' | 'back' | 'crest',
): Promise<Uint8Array> {
  const base64 = await page.evaluate(
    ({ color, mark }: { color: string; mark: string }): string => {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('2d canvas unavailable for synthetic PNG fixture.');
      context.fillStyle = color;
      context.fillRect(0, 0, 400, 300);
      context.fillStyle = '#ffffff';
      if (mark === 'front') context.fillRect(20, 20, 120, 80);
      else if (mark === 'back') context.fillRect(260, 200, 120, 80);
      else context.fillRect(140, 110, 120, 80);
      context.fillStyle = '#000000';
      context.font = 'bold 48px sans-serif';
      if (mark === 'front') context.fillText('F', 48, 80);
      else if (mark === 'back') context.fillText('B', 288, 260);
      else context.fillText('C', 168, 170);
      return canvas.toDataURL('image/png').split(',')[1] ?? '';
    },
    { color: fill, mark: seed },
  );
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function checkAllBoxes(page: Page, listHook: string): Promise<void> {
  const list = await shown(page, listHook);
  if ((await list.count()) === 0) return;
  await list.locator('input[type="checkbox"]').evaluateAll((nodes) => {
    for (const node of nodes) {
      const box = node as HTMLInputElement;
      if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
}

test('fresh two-photo handoff shows both saved views with one overlay each', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page, probe } = await openBuilder(browser);
  const directory = await mkdtemp(join(tmpdir(), 'LogoTool-fresh-photo-'));
  try {
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();

    // Fresh intake: two Images rows labelled Front and Back.
    const rows = page.locator('[data-builder-hook="product-view-rows"] [data-view-row]');
    await expect(rows).toHaveCount(1);
    await (await shown(page, 'product-view-add')).click();
    await expect(rows).toHaveCount(2);
    const frontPng = await syntheticPhoto(page, '#1d6f3a', 'front');
    const backPng = await syntheticPhoto(page, '#6f1d3a', 'back');
    assert.notDeepEqual(Array.from(frontPng), Array.from(backPng), 'synthetic photos must differ');
    const labels = ['Front', 'Back'];
    const photoLabels = [...labels, 'Sleeve'];
    const sleevePng = await syntheticPhoto(page, '#4b3912', 'crest');
    await (await shown(page, 'product-view-add')).click();
    await expect(rows).toHaveCount(3);
    const pngs = [frontPng, backPng, sleevePng];
    for (let index = 0; index < photoLabels.length; index += 1) {
      const row = rows.nth(index);
      await row.locator('input[type="text"]').fill(photoLabels[index]!);
      await row.locator('input[type="file"]').setInputFiles({
        name: `${photoLabels[index]!.toLowerCase()}.png`,
        mimeType: 'image/png',
        buffer: Buffer.from(pngs[index]!),
      });
      await expect(row.locator('.view-row-state')).toContainText('ready');
    }
    await (await shown(page, 'product-name')).fill('Fresh Photo Jacket');
    await addProductAndOpenSetup(page);
    await expect(builder(page, 'product-status')).toContainText(
      'Added preview-only product Fresh Photo Jacket',
    );
    const productId: string = await builder(page, 'workspace-product').evaluate(
      (element) => (element as HTMLSelectElement).value,
    );
    assert.ok(productId.length > 0, 'workspace product must be selected');

    // Both tabs exist under the saved human labels.
    const workspace = builder(page, 'product-workspace');
    await expect(workspace.getByRole('tab', { name: 'Front' })).toBeVisible();
    await expect(workspace.getByRole('tab', { name: 'Back' })).toBeVisible();

    // Scale rectangle + Save product setup on each view.
    for (const label of labels) {
      await workspace.getByRole('tab', { name: label }).click();
      await workspace.getByRole('button', { name: 'Set up scale' }).click();
      const guided = builder(page, 'guided-scale');
      await expect(guided).toBeVisible();
      const overlay = guided.locator('.guided-scale-overlay[aria-label*="rectangle corners"]');
      await expect(overlay).toBeVisible();
      const box = (await overlay.boundingBox())!;
      const corner = async (fx: number, fy: number) => {
        await overlay.click({
          position: { x: Math.round(box.width * fx), y: Math.round(box.height * fy) },
        });
      };
      await corner(0.25, 0.25);
      await corner(0.75, 0.25);
      await corner(0.75, 0.75);
      await corner(0.25, 0.75);
      await guided.locator('[data-guided="width"]').fill('280');
      await guided.locator('[data-guided="height"]').fill('200');
      await guided.locator('[data-guided="create"]').click();
      await expect(await shown(page, 'workspace-status')).toContainText(
        `Measured the ${label} view: 280×200`,
      );
      await workspace.getByRole('button', { name: 'Save product setup' }).click();
      await expect(workspace.getByText(/Saved .* \(4 safe-area corners, 0 anchors\)/)).toBeVisible();
    }

    // One artwork logo; two placements (one per measured region) happen in
    // the customer proof below.
    const crestPng = await syntheticPhoto(page, '#8a6d1d', 'crest');
    await (await shown(page, 'logo-file')).setInputFiles({
      name: 'crest.png',
      mimeType: 'image/png',
      buffer: Buffer.from(crestPng),
    });
    await expect(await shown(page, 'logo-status')).toContainText('Added crest.png');
    await checkAllBoxes(page, 'product-list');
    await checkAllBoxes(page, 'logo-list');
    await checkAllBoxes(page, 'configuration-list');
    await (await shown(page, 'job-step-1')).click();
    await (await shown(page, 'customer-name')).fill('Fresh Photo Customer');
    await (await shown(page, 'job-ref')).fill('FRESH-01');
    await (await shown(page, 'issued-by')).fill('Fresh operator');

    // Standalone customer file via the approval branch.
    await (await shown(page, 'job-to-placements')).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    await builder(page, 'job-placement-host')
      .getByRole('button', { name: 'Send for customer approval' })
      .click();
    const approval = page.locator('[data-customer-approval]');
    await expect(approval).toBeVisible();
    const proofNotice = approval.getByRole('region', { name: 'Customer photo availability' });
    await expect(proofNotice).toContainText('Sleeve needs a current photo mapping');
    await expect(proofNotice).not.toContainText('Front needs a current photo mapping');
    await expect(proofNotice).not.toContainText('Back needs a current photo mapping');
    await (await shown(page, 'job-issue-project-new')).click();
    const issueId = await builder(page, 'job-issue-project-id').inputValue();
    expect(issueId.length).toBeGreaterThan(0);
    await approval.getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(approval).toContainText('Customer file created');
    const downloadBranch = async (fileName: string, button: string): Promise<Uint8Array> => {
      const event = page.waitForEvent('download');
      await approval.getByRole('button', { name: button, exact: true }).click();
      const download = await event;
      const outputPath = join(directory, fileName);
      await download.saveAs(outputPath);
      return new Uint8Array(await readFile(outputPath));
    };
    const officeCopy = await downloadBranch('fresh-office.logo-project', 'Save office copy');
    const standalone = await downloadBranch(
      'OPEN_LOGO_CONFIGURATOR.html',
      'Save customer file',
    );

    // Issued package: v3 manifest with stable ids view-1/view-2 and saved
    // labels Front/Back; v2 mappings keyed by matching viewId.
    const parsed = await parseProjectPackage(officeCopy, { sha256 });
    const manifestRaw = parsed.assets.find((asset) => asset.path === 'presentation/preview.json');
    assert.ok(manifestRaw, 'issued package carries the presentation manifest');
    const manifest = JSON.parse(Buffer.from(manifestRaw.bytes).toString('utf8')) as {
      version: number;
      views: Array<{ productId: string; view: string; image: string; label?: string }>;
    };
    expect(manifest.version).toBe(3);
    expect(manifest.views).toHaveLength(3);
    expect(new Set(manifest.views.map((entry) => entry.view))).toEqual(
      new Set(['view-1', 'view-2', 'view-3']),
    );
    expect(manifest.views.map((entry) => entry.label).sort()).toEqual(['Back', 'Front', 'Sleeve']);
    const mappingsRaw = parsed.assets.find(
      (asset) => asset.path === 'presentation/photo-mappings.json',
    );
    assert.ok(mappingsRaw, 'issued package carries the photo mappings');
    const mappingsDoc = JSON.parse(Buffer.from(mappingsRaw.bytes).toString('utf8')) as {
      version: number;
      mappings: Array<{
        productId: string;
        regionId: string;
        view: string;
        viewId?: string;
        image: string;
        calibrationId: string;
        calibrationVersion: string;
      }>;
    };
    expect(mappingsDoc.version).toBe(2);
    expect(mappingsDoc.mappings).toHaveLength(2);
    expect(new Set(mappingsDoc.mappings.map((entry) => entry.viewId))).toEqual(
      new Set(['view-1', 'view-2']),
    );
    const product = parsed.project.products.find((item) => item.id === productId)!;
    assert.ok(product, 'issued product survives');
    expect(product.regions.map((entry) => entry.id).sort()).toEqual(
      mappingsDoc.mappings.map((entry) => entry.regionId).sort(),
    );
    for (const entry of mappingsDoc.mappings) {
      const manifestView = manifest.views.find((view) => view.view === entry.viewId)!;
      assert.ok(manifestView, `mapping viewId ${entry.viewId} is a declared view`);
      assert.equal(entry.image, manifestView.image, 'mapping image matches the declared view image');
      const region = product.regions.find((item) => item.id === entry.regionId)!;
      assert.ok(region, 'mapping region travels with the issue');
      expect(region.safeArea).toHaveLength(4);
      assert.equal(region.calibrationRef.calibrationId, entry.calibrationId);
      assert.equal(region.calibrationRef.version, entry.calibrationVersion);
    }
    const imageDigests = manifest.views.map((view) => {
      const bytes = parsed.assets.find((asset) => asset.path === view.image)?.bytes;
      assert.ok(bytes, `image bytes ship for ${view.image}`);
      return digestOf(bytes);
    });
    assert.notEqual(imageDigests[0], imageDigests[1], 'the two view photos must differ');
    const configId = parsed.project.configurations[0]!.id;
    const logoId =
      parsed.project.logos.find((logo) => (logo.name ?? '').toLowerCase().includes('crest'))?.id ??
      parsed.project.logos[0]!.id;
    const regionIds = [...product.regions.map((region) => region.id)].sort();
    expect(regionIds).toHaveLength(2);
    const labelForRegion = (regionId: string): string => {
      const entry = mappingsDoc.mappings.find((item) => item.regionId === regionId)!;
      return manifest.views.find((view) => view.view === entry.viewId)?.label ?? entry.viewId ?? '';
    };

    // Customer proof: both photos by saved label with one correct overlay each.
    const customerPath = join(directory, 'OPEN_LOGO_CONFIGURATOR.html');
    await writeFile(customerPath, standalone);
    const editor = await context.newPage();
    editor.on('pageerror', (error) => probe.pageErrors.push(String(error)));
    editor.on('console', (message) => {
      if (message.type() === 'error') probe.consoleErrors.push(String(message.text()));
    });
    try {
      await editor.goto(pathToFileURL(customerPath).href);
      await expect(editor.locator('[data-customer-hook="project-id"]')).toHaveText(
        parsed.project.projectId,
      );
      await selectCustomerOption(editor, 'configuration', configId);
      const hook = (name: string) => editor.locator(`[data-customer-hook="${name}"]`);

      const placeIn = async (regionId: string): Promise<void> => {
        await selectCustomerOption(editor, 'region', regionId);
        await selectCustomerOption(editor, 'logo', logoId);
        await selectCustomerOption(editor, 'method', 'embroidery');
        await revealCustomerControl(editor, 'x-mm');
        await editor.locator('[data-customer-hook="x-mm"]').fill('140');
        await editor.locator('[data-customer-hook="y-mm"]').fill('100');
        await editor.locator('[data-customer-hook="width-mm"]').fill('50');
        await editor.locator('[data-customer-hook="height-mm"]').fill('30');
        await revealCustomerControl(editor, 'add');
        await editor.locator('[data-customer-hook="add"]').click();
      };
      await placeIn(regionIds[0]!);
      await expect(hook('placement').locator('option')).toHaveCount(2);
      await revealCustomerControl(editor, 'add-another');
      await hook('add-another').click();
      await placeIn(regionIds[1]!);
      await expect(hook('placement').locator('option')).toHaveCount(3);

      // The supplied but unmapped side cannot be used as a measured proof.
      await expect(hook('side-tabs').getByRole('button', { name: 'Sleeve', exact: true })).toBeDisabled();
      await expect(hook('side-front')).toContainText('Front');
      await expect(hook('side-back')).toContainText('Back');

      for (let index = 0; index < regionIds.length; index += 1) {
        const regionId = regionIds[index]!;
        const expectedLabel = labelForRegion(regionId);
        expect(['Front', 'Back']).toContain(expectedLabel);
        const view = hook('side-tabs').getByRole('button', { name: expectedLabel, exact: true });
        await expect(view).toBeVisible();
        await view.click();
        await expect(view).toHaveAttribute('aria-pressed', 'true');
        await expect(hook('placement')).toHaveValue(String(index));
        await expect(hook('mode-photo')).toHaveAttribute('aria-pressed', 'true');
        await expect(hook('reference-img')).toBeVisible();
        await expect
          .poll(() =>
            hook('reference-img').evaluate(
              (image) => (image as HTMLImageElement).naturalWidth,
            ),
          )
          .toBe(400);
        await expect(hook('photo-overlay').locator('image')).toHaveCount(1);
        await expect(hook('mapping-status')).toHaveText(
          `Mapped photo (visual trial, not production approval) · ${expectedLabel}.`,
        );
        await expect(editor.locator('[data-customer-hook="view-caption"]')).toContainText(
          expectedLabel,
        );
        await expect(hook('mapping-status')).not.toContainText('Use the diagram');
      }
    } finally {
      await editor.close();
    }

    // Both views travel inside the standalone customer HTML (operation
    // document input), not just the office copy.
    const { extractEmbeddedProjectPackage } = await import(
      '../src/packaging/self-contained-html/index.js'
    );
    const embedded = extractEmbeddedProjectPackage(standalone);
    assert.ok(embedded, 'standalone HTML embeds the project package');
    const selfParsed = await parseProjectPackage(embedded, { sha256 });
    const selfManifestRaw = selfParsed.assets.find(
      (asset) => asset.path === 'presentation/preview.json',
    );
    assert.ok(selfManifestRaw, 'embedded package carries the presentation manifest');
    const selfManifest = JSON.parse(Buffer.from(selfManifestRaw.bytes).toString('utf8')) as {
      views: Array<{ view: string; label?: string }>;
    };
    expect(selfManifest.views).toHaveLength(3);
    expect(selfManifest.views.map((entry) => entry.label).sort()).toEqual(['Back', 'Front', 'Sleeve']);

    expect(probe.pageErrors).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    expect(probe.networkRequests).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await context.close();
  }
});
