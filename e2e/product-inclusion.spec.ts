import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import { gotoBuilder, openOfflineContext, assertCleanProbe, ensurePlacementPanel, revealBuilderControl } from './helpers.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const pw = (page: Page, name: string) => page.locator(`[data-placement-hook="${name}"]`);
const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function openFixture(page: Page, keepPlacements = false) {
  const parsed = await parseProjectPackage(new Uint8Array(await readFile('dist/dev/trusted-issued.logo-project')), { sha256 });
  const project = structuredClone(parsed.project);
  delete project.confirmation;
  delete project.history;
  delete project.review;
  delete project.reviewHistory;
  if (!keepPlacements) for (const configuration of project.configurations) configuration.placements = [];
  const a = project.products[0]!;
  const otherVariant = a.variants[1]!;
  const firstConfiguration = project.configurations.find(configuration => configuration.productId === a.id)!;
  project.configurations.push({ ...firstConfiguration, id: 'inclusion-second-option', variantId: otherVariant.id, placements: [] });
  const bytes = await createProjectPackage({
    project,
    assets: parsed.assets.filter(asset => asset.kind !== 'additional').map(({ path, bytes }) => ({ path, bytes })),
    additionalAssets: parsed.assets.filter(asset => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes })),
  }, { sha256 });
  await gotoBuilder(page);
  await b(page, 'job-open-file').setInputFiles({ name: 'synthetic-inclusion.logo-project', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await b(page, 'customer-name').fill('Synthetic inclusion customer');
  await b(page, 'job-ref').fill('INCLUSION-TEST');
  await b(page, 'issued-by').fill('Synthetic operator');
  for (const product of project.products) {
    const card = page.locator(`[data-product-card="${product.id}"]`);
    await card.locator('input[type="checkbox"]').first().check();
    await card.getByRole('checkbox', { name: product.variants[0]!.name!, exact: true }).check();
  }
  await b(page, 'logo-list').locator('input[type="checkbox"]').first().check();
  return { a, b: project.products[1]!, project };
}

async function focusProduct(page: Page, id: string) {
  await b(page, 'job-step-1').click();
  await page.locator(`[data-product-card="${id}"]`).getByRole('button', { name: /Open setup/ }).click();
  await expect(b(page, 'workspace-product')).toHaveValue(id);
  await b(page, 'editor-logos').click();
  await ensurePlacementPanel(page);
}

async function fillAdd(page: Page) {
  await pw(page, 'pw-add-placement').click();
  await pw(page, 'pw-add-logo').selectOption({ index: 0 });
  const method = pw(page, 'pw-add-method');
  if (await method.count()) {
    const value = await method.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).find(Boolean)!);
    await method.selectOption(value);
  }
  await pw(page, 'pw-add-width').fill('30');
  await pw(page, 'pw-add-height').fill('20');
}

async function savedProject(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await b(page, 'job-save').click();
  const download = await downloadPromise;
  const path = test.info().outputPath('office.logo-project');
  await download.saveAs(path);
  return (await parseProjectPackage(new Uint8Array(await readFile(path)), { sha256 })).project;
}

test('inclusion blocks excluded B, recovers on A and issues its intended placement', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    const fixture = await openFixture(page);
    await focusProduct(page, fixture.b.id);
    await b(page, 'job-step-1').click();
    await page.locator(`[data-product-card="${fixture.b.id}"] input[type="checkbox"]`).first().uncheck();
    await b(page, 'job-step-2').click();
    await ensurePlacementPanel(page);
    await expect(b(page, 'workspace-product')).toHaveValue(fixture.b.id);
    await expect(pw(page, 'pw-add-blocked')).toBeVisible();
    await expect(pw(page, 'pw-add-blocked')).toContainText(fixture.b.name!);
    await expect(pw(page, 'pw-add-placement')).toBeDisabled();
    await expect(pw(page, 'pw-add-placement')).toHaveAttribute('aria-describedby', 'placement-exclusion-message');
    for (const place of await page.locator('[data-placement-hook^="pw-artwork-place-"]').all()) await expect(place).toBeDisabled();

    await b(page, 'workspace-product').selectOption(fixture.a.id);
    await ensurePlacementPanel(page);
    await fillAdd(page);
    await pw(page, 'pw-add-confirm').click();
    await expect(page.locator('[data-placement-hook^="pw-placement-row-"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Send for customer approval' }).click();
    await revealBuilderControl(page, 'job-issue-project-new');
    await b(page, 'job-issue-project-new').click();
    const approval = page.locator('[data-customer-approval]');
    const hybrid = approval.getByLabel(/ZIP file/);
    if (!await hybrid.isVisible()) await approval.locator('summary', { hasText: 'More options' }).click();
    await hybrid.check();
    await page.getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(approval).toContainText('Customer file created');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save customer file', exact: true }).click();
    const path = test.info().outputPath('customer.zip');
    await (await downloadPromise).saveAs(path);
    const entries = unzipSync(new Uint8Array(await readFile(path)));
    const entry = Object.keys(entries).find(name => name.endsWith('.logo-project'))!;
    const issued = (await parseProjectPackage(entries[entry]!, { sha256 })).project;
    expect(issued.products.map(product => product.id)).toEqual([fixture.a.id]);
    const placements = issued.configurations.flatMap(configuration => configuration.placements);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ widthMm: 30, heightMm: 20 });
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('inclusion blocks an excluded option and rechecks a stale Add handler', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    const fixture = await openFixture(page);
    await focusProduct(page, fixture.a.id);
    await fillAdd(page);
    const staleSubmit = await pw(page, 'pw-add-confirm').elementHandle();
    await b(page, 'job-step-1').click();
    const card = page.locator(`[data-product-card="${fixture.a.id}"]`);
    await card.getByRole('checkbox', { name: fixture.a.variants[0]!.name!, exact: true }).uncheck();
    await card.getByRole('checkbox', { name: fixture.a.variants[1]!.name!, exact: true }).check();
    // Simulate a queued click from the enabled form before its DOM was replaced.
    await staleSubmit!.dispatchEvent('click');
    await b(page, 'job-step-2').click();
    await ensurePlacementPanel(page);
    await expect(pw(page, 'pw-add-blocked')).toContainText(fixture.a.variants[0]!.name!);
    await expect(pw(page, 'pw-add-placement')).toBeDisabled();
    await pw(page, 'pw-add-cancel').click();
    const saved = await savedProject(page);
    expect(saved.configurations.flatMap(configuration => configuration.placements)).toHaveLength(0);
    await b(page, 'workspace-variant').selectOption(fixture.a.variants[1]!.id);
    await ensurePlacementPanel(page);
    await expect(pw(page, 'pw-add-placement')).toBeEnabled();
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('inclusion keeps existing excluded placements visible and blocks duplication', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    const fixture = await openFixture(page, true);
    await focusProduct(page, fixture.a.id);
    await b(page, 'job-step-1').click();
    await page.locator(`[data-product-card="${fixture.a.id}"] input[type="checkbox"]`).first().uncheck();
    await b(page, 'job-step-2').click();
    await ensurePlacementPanel(page);
    await expect(page.locator('[data-placement-hook^="pw-placement-row-"]')).toHaveCount(2);
    await page.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
    await expect(pw(page, 'pw-duplicate')).toBeDisabled();
    const width = pw(page, 'pw-width');
    await expect(width).toBeEnabled();
    const resizedWidth = Number(await width.inputValue()) * 0.9;
    await width.fill(String(resizedWidth));
    await pw(page, 'pw-apply').click();
    const saved = await savedProject(page);
    const retained = saved.configurations.filter(configuration => configuration.productId === fixture.a.id).flatMap(configuration => configuration.placements);
    expect(retained).toHaveLength(2);
    expect(retained[0]!.widthMm).toBe(resizedWidth);
    await b(page, 'job-step-1').click();
    const card = page.locator(`[data-product-card="${fixture.a.id}"]`);
    await card.locator('input[type="checkbox"]').first().check();
    await card.getByRole('checkbox', { name: fixture.a.variants[0]!.name!, exact: true }).check();
    await b(page, 'job-step-2').click();
    await ensurePlacementPanel(page);
    await page.locator('[data-placement-hook^="pw-placement-row-"]').first().click();
    await expect(pw(page, 'pw-duplicate')).toBeEnabled();
    await pw(page, 'pw-duplicate').click();
    expect((await savedProject(page)).configurations.filter(configuration => configuration.productId === fixture.a.id).flatMap(configuration => configuration.placements)).toHaveLength(3);
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
