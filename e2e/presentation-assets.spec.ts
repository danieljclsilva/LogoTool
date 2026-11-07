import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectDocument } from '../src/core/types.js';
import { gotoBuilder, revealBuilderControl, openOfflineContext, assertCleanProbe, revealCustomerControl } from './helpers.js';
import type { Page } from '@playwright/test';

const sha256 = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const editor = pathToFileURL(resolve('dist/dev/customer-configurator.html')).href;
const hook = (page: Page, name: string) => page.locator(`[data-customer-hook="${name}"]`);
async function syntheticPng(page: Page): Promise<Uint8Array> {
  const base64 = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 10; const context = canvas.getContext('2d')!; context.fillStyle = '#12394b'; context.fillRect(0,0,20,10); return canvas.toDataURL('image/png').split(',')[1]!; });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
async function fixture() { return parseProjectPackage(new Uint8Array(await readFile(resolve('dist/dev/trusted-issued.logo-project'))), { sha256 }); }
async function packageWith(project: ProjectDocument, assets: Awaited<ReturnType<typeof fixture>>['assets'], additional: Array<{ path: string; bytes: Uint8Array }>) {
  return createProjectPackage({ project, assets: assets.filter(asset => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })), additionalAssets: additional }, { sha256 });
}
function manifest(project: ProjectDocument, image = 'presentation/product.png') {
  return new TextEncoder().encode(JSON.stringify({ version: 1, references: [{ productId: project.configurations[0]!.productId, variantId: project.configurations[0]!.variantId, image }] }));
}
async function load(page: Page, bytes: Uint8Array, name = 'synthetic.logo-project') {
  await hook(page,'file-input').setInputFiles({ name, mimeType:'application/zip', buffer:Buffer.from(bytes) });
  await expect(hook(page,'status')).toContainText(`Opened ${name}`);
}
async function downloadBytes(page: Page, trigger: () => Promise<void>): Promise<Uint8Array> {
  const event = page.waitForEvent('download'); await trigger(); const download = await event; return new Uint8Array(await readFile((await download.path())!));
}

async function setChecked(box: import('@playwright/test').Locator, checked: boolean): Promise<void> {
  // Configuration choices must produce real change events even when the box
  // already matches (Playwright check()/uncheck() are silent no-ops then),
  // so deliberate setup narrowing is never mistaken for automatic inclusion.
  await box.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.checked = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

/** Check every builder selection box (empty start leaves all unchecked). */
async function selectAllLists(page: Page): Promise<void> {
  for (const listHook of ['product-list', 'logo-list', 'configuration-list']) {
    await revealBuilderControl(page, listHook);
    const list = page.locator(`[data-builder-hook="${listHook}"]`);
    const boxes = list.locator('input[type="checkbox"]');
    const count = await boxes.count();
    for (let index = 0; index < count; index += 1) {
      const box = boxes.nth(index);
      if (listHook === 'configuration-list') await setChecked(box, true);
      else if (await box.isVisible() && await box.isEnabled()) await box.check();
    }
  }
}

test('reference view and artwork thumbnail display safely; view changes preserve exact saved bytes', async ({ browser }, info) => {
  const { context, page, probe } = await openOfflineContext(browser, { width:1536,height:1024 });
  try {
    await page.goto(editor); const source = await fixture(); const png = await syntheticPng(page);
    const firstLogo = source.project.logos[0]!;
    firstLogo.assets.push({ uri:'logos/synthetic-preview.png',role:'reference',mediaType:'image/png',widthPx:20,heightPx:10 });
    source.assets.push({ path:'logos/synthetic-preview.png',kind:'referenced',bytes:png });
    const bytes = await packageWith(source.project,source.assets,[{ path:'presentation/preview.json',bytes:manifest(source.project) },{ path:'presentation/product.png',bytes:png }]);
    await load(page,bytes);
    // Legacy unmapped reference: the measured diagram stays the authority;
    // the photo has no mapping, so photo mode is disabled with a reason and
    // the diagram fallback is explicit.
    await expect(hook(page,'logo-thumb')).toBeVisible(); await expect(hook(page,'canvas')).toBeVisible();
    await expect(hook(page,'reference-img')).toBeHidden();
    await expect(hook(page,'mode-photo')).toBeDisabled();
    await expect(hook(page,'mapping-status')).toContainText('Reference only');
    const before = await downloadBytes(page,() => hook(page,'save-draft-top').click());
    await hook(page,'mode-diagram').click(); await expect(hook(page,'canvas')).toBeVisible();
    await expect(hook(page,'mode-photo')).toBeDisabled();
    const after = await downloadBytes(page,() => hook(page,'save-draft-top').click());
    expect(Buffer.from(before)).toEqual(Buffer.from(bytes)); expect(Buffer.from(after)).toEqual(Buffer.from(before));
    await page.screenshot({ path:info.outputPath('synthetic-reference.png') }); assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('bad optional images, remote references and oversized raster dimensions keep physical drafts usable', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor); const source = await fixture(); const png = await syntheticPng(page);
    const oversized = new Uint8Array(png); new DataView(oversized.buffer).setUint32(16,65535);
    const variants = [
      [{ path:'presentation/preview.json',bytes:manifest(source.project,'https://example.invalid/image.png') }],
      [{ path:'presentation/preview.json',bytes:manifest(source.project) },{ path:'presentation/product.png',bytes:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/never"/></svg>') }],
      [{ path:'presentation/preview.json',bytes:manifest(source.project) },{ path:'presentation/product.png',bytes:oversized }],
      [{ path:'presentation/preview.json',bytes:new Uint8Array(65537) }],
    ];
    for (let index=0;index<variants.length;index++) {
      await load(page,await packageWith(source.project,source.assets,variants[index]!),`invalid-preview-${index}.logo-project`);
      // Unusable references fall back to the measured diagram with an honest
      // reference-only status; the physical draft stays usable.
      await expect(hook(page,'reference-img')).toBeHidden();
      await expect(hook(page,'canvas')).toBeVisible(); await expect(hook(page,'save-draft-top')).toBeEnabled();
      await expect(hook(page,'mapping-status')).toContainText('Reference only');
      await expect(hook(page,'revision')).toHaveText(String(source.project.revision));
    }
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('fixed product, artwork, area and method do not become redundant selectors', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor); const source = await fixture(); const project = structuredClone(source.project);
    const configuration = project.configurations[0]!; const product = project.products[0]!; const variant = product.variants.find(item => item.id === configuration.variantId)!;
    configuration.placements = configuration.placements.slice(0,1); project.configurations = [configuration]; project.products = [product]; product.variants = [variant]; variant.regionIds = [configuration.placements[0]!.regionId]; product.regions = product.regions.filter(item => variant.regionIds.includes(item.id)); product.regions[0]!.allowedMethods = [configuration.placements[0]!.method]; project.logos = [project.logos.find(item => item.id === configuration.placements[0]!.logoId)!];
    const referenced = new Set(project.logos.flatMap(logo => logo.assets.map(asset => asset.uri)));
    await load(page,await packageWith(project,source.assets.filter(asset => referenced.has(asset.path)),[]));
    await expect(page.locator('[data-step-panel="edit"]')).toBeVisible();
    for (const name of ['configuration','product','variant','region','logo','placement','method']) await expect(hook(page,name)).toBeHidden();
    await expect(hook(page,'width-mm')).toBeHidden();
    await revealCustomerControl(page, 'width-mm');
    await expect(hook(page,'width-mm')).toBeVisible();
    await expect(hook(page,'height-mm')).toBeVisible();
    for (const name of ['configuration','product','variant','region','logo','placement','method']) await expect(hook(page,name)).toBeHidden();
    await expect(hook(page,'job-choices')).toBeHidden(); assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('Builder prunes unselected reference images and preserves the selected image through delivery and return', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  let directory = '';
  try {
    await gotoBuilder(page);
    await expect(page.locator('[data-job-landing]')).toBeVisible();
    await page.locator('[data-builder-hook="job-landing-create"]').click();
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    const source = await fixture(); const png = await syntheticPng(page);
    const references = source.project.configurations.map((configuration,index) => ({ productId:configuration.productId,variantId:configuration.variantId,image:`presentation/product-${index}.png` }));
    const bytes = await packageWith(source.project,source.assets,[{ path:'presentation/preview.json',bytes:new TextEncoder().encode(JSON.stringify({ version:1,references })) },...references.map(entry => ({ path:entry.image,bytes:png })),{ path:'presentation/unrelated.png',bytes:png }]);
    const show = async (name: string) => { await revealBuilderControl(page, name); const visible = page.locator(`[data-builder-hook="${name}"]`).filter({ visible: true }); if ((await visible.count()) > 0) return visible; return page.locator(`[data-builder-hook="${name}"]`); };
    await page.locator('[data-builder-hook="job-open-file"]').setInputFiles({ name:'synthetic-reference-source.logo-project',mimeType:'application/zip',buffer:Buffer.from(bytes) });
    await expect(page.locator('[data-builder-hook="source-status"]')).toContainText('Loaded');
    await expect(page.locator('[data-job-step="prepare"]')).toBeVisible();
    // Empty start: select everything deliberately before refining.
    await selectAllLists(page);
    await expect(await show('selection-summary')).toContainText('2 products');
    const secondProduct = source.project.products[1]!.id;
    await (await show('product-list')).locator(`input[value="${secondProduct}"]:not([data-product])`).uncheck();
    await expect(await show('selection-summary')).toContainText('1 product');
    // Identity lives directly on Step 1 (Prepare the job) in the job shell.
    for (const [name,value] of Object.entries({ 'customer-name':'Synthetic visual customer','job-ref':'VISUAL-QA','issued-by':'Synthetic QA' })) await (await show(name)).fill(value);
    // Approval branch: Step 1 -> placements (explicit scope where offered) ->
    // Send for customer approval, with a fresh issue ID for this delivery.
    await page.locator('[data-builder-hook="job-to-placements"]').click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    for (const selectHook of ['pw-product-select', 'pw-option-select']) {
      const select = page.locator(`[data-placement-hook="${selectHook}"]`);
      if (await select.count() > 0) {
        const value = await select.evaluate((element) => (element as HTMLSelectElement).options[0]?.value ?? '');
        if (value !== '') await select.selectOption(value);
      }
    }
    await page.getByRole('button', { name: 'Send for customer approval' }).click();
    const branch = page.locator('[data-job-branch="approval"]');
    await expect(branch).toBeVisible();
    await expect(branch.getByRole('heading', { name: 'Send for customer approval' })).toBeVisible();
    await (await show('job-issue-project-new')).click();
    const issueId = await page.locator('[data-builder-hook="job-issue-project-id"]').inputValue();
    expect(issueId.length).toBeGreaterThan(0);
    await branch.getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(branch.getByText('Customer file created')).toBeVisible();
    await expect(branch.getByRole('button', { name: 'Save office copy', exact: true })).toBeVisible();
    await expect(branch.getByRole('button', { name: 'Save customer file', exact: true })).toBeVisible();
    const baseline = await downloadBytes(page,() => branch.getByRole('button', { name: 'Save office copy', exact: true }).click());
    const parsed = await parseProjectPackage(baseline,{ sha256 });
    const retainedManifest = JSON.parse(new TextDecoder().decode(parsed.assets.find(asset => asset.path === 'presentation/preview.json')!.bytes));
    expect(retainedManifest.references).toHaveLength(1);
    expect(parsed.assets.some(asset => asset.path === 'presentation/product-1.png')).toBe(false);
    expect(parsed.assets.some(asset => asset.path === 'presentation/unrelated.png')).toBe(false);
    const html = await downloadBytes(page,() => branch.getByRole('button', { name: 'Save customer file', exact: true }).click());
    directory = await mkdtemp(join(tmpdir(),'LogoTool reference delivery ')); const htmlPath = join(directory,'OPEN.html'); await writeFile(htmlPath,html);
    const customer = await context.newPage(); customer.on('pageerror',error => probe.pageErrors.push(String(error))); customer.on('console',message => { if(message.type()==='error') probe.consoleErrors.push(message.text()); });
    await customer.goto(pathToFileURL(htmlPath).href); await expect(hook(customer,'reference-img')).toBeHidden();
    await expect(hook(customer,'mapping-status')).toContainText('Reference only');
    await revealCustomerControl(customer, 'width-mm');
    await hook(customer,'width-mm').fill('60'); await hook(customer,'width-mm').press('Tab');
    await hook(customer,'primary-next').click();
    await hook(customer,'confirmed-by').fill('Synthetic reviewer'); await hook(customer,'confirm').click();
    const returned = await downloadBytes(customer,() => hook(customer,'submit').click());
    const parsedReturn = await parseProjectPackage(returned,{ sha256 });
    expect(parsedReturn.assets.filter(asset => asset.kind==='additional')).toEqual(parsed.assets.filter(asset => asset.kind==='additional'));
    // Branch response review: the stored office copy is the baseline, the
    // return validates against it, and installing lands on Step 2.
    await branch.getByLabel('Choose the saved office copy for this job').setInputFiles({ name:'reference-office-copy.logo-project',mimeType:'application/zip',buffer:Buffer.from(baseline) });
    await expect(branch).toContainText('Office copy loaded');
    await branch.getByLabel('Choose the returned customer file').setInputFiles({ name:'reference-return.logo-project',mimeType:'application/zip',buffer:Buffer.from(returned) });
    await expect(branch).toContainText('Response checked against the office copy');
    await branch.getByRole('button', { name: 'Use customer changes' }).click();
    await expect(page.locator('[data-job-step="placements"]')).toBeVisible();
    assertCleanProbe(probe);
  } finally { await context.close(); if(directory) await rm(directory,{recursive:true,force:true}); }
});

test('obsolete image decoding cannot install a reference after a different package opens', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor); const source = await fixture(); const png = await syntheticPng(page);
    const bytes = await packageWith(source.project,source.assets,[{ path:'presentation/preview.json',bytes:manifest(source.project) },{ path:'presentation/product.png',bytes:png }]);
    await load(page,bytes,'first-reference.logo-project');
    // Unmapped legacy references never decode for display: the diagram stays
    // authoritative and no stale photo can install.
    await expect(hook(page,'canvas')).toBeVisible(); await expect(hook(page,'reference-img')).toBeHidden();
    const replacement = structuredClone(source.project); replacement.projectId = 'SYN-NO-REFERENCE';
    await load(page,await packageWith(replacement,source.assets,[]),'replacement.logo-project');
    await expect(hook(page,'project-id')).toHaveText('SYN-NO-REFERENCE'); await expect(hook(page,'reference-img')).toBeHidden();
    await expect(hook(page,'mode-photo')).toBeDisabled(); assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('guided primary actions create zero and repeated placements without duplicates', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor); const source = await fixture();
    source.project.configurations = [source.project.configurations[0]!];
    source.project.configurations[0]!.placements = [];
    await load(page,await packageWith(source.project,source.assets,[]));
    for (let count=1; count<=2; count++) {
      if (count===2) await hook(page,'add-another').click();
      // Reveal the exact-size disclosure for the active placement draft.
      await expect(page.locator('[data-step-panel="edit"]')).toBeVisible();
      await revealCustomerControl(page, 'width-mm');
      await hook(page,'width-mm').fill('40');
      await hook(page,'width-mm').press('Tab');
      await hook(page,'primary-next').click();
      await expect(page.locator('[data-step-panel="review"]')).toBeVisible();
      const bytes = await downloadBytes(page,()=>hook(page,'save-draft-top').click());
      const saved = await parseProjectPackage(bytes,{sha256});
      expect(saved.project.configurations[0]!.placements).toHaveLength(count);
      expect(saved.project.configurations[0]!.placements.every(item=>item.widthMm===40)).toBe(true);
      const repeated = await downloadBytes(page,()=>hook(page,'save-draft-top').click());
      expect(Buffer.from(repeated)).toEqual(Buffer.from(bytes));
    }
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('keyboard 3D-mode switch cancels an unfinished drag without changing saved bytes', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await page.goto(editor); const source = await fixture(); const png = await syntheticPng(page);
    await load(page,await packageWith(source.project,source.assets,[{path:'presentation/preview.json',bytes:manifest(source.project)},{path:'presentation/product.png',bytes:png}]));
    await expect(hook(page,'canvas')).toBeVisible();
    const before = await downloadBytes(page,()=>hook(page,'save-draft-top').click());
    const footprint = hook(page,'canvas').locator('.footprint.selected'); const box = (await footprint.boundingBox())!;
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down(); await page.mouse.move(box.x+box.width/2+20,box.y+box.height/2+10);
    // Switching to 3D mode cancels the drag (keyboard activation: canvas
    // pointer capture retargets synthetic mouse events, so a real keyboard
    // press is the honest visible control here).
    await hook(page,'mode-3d').focus(); await page.keyboard.press('Enter'); await page.mouse.up();
    await expect(hook(page,'mode-3d-pane')).toBeVisible();
    await page.mouse.up();
    await expect(hook(page,'status')).toContainText('Move cancelled');
    const after = await downloadBytes(page,()=>hook(page,'save-draft-top').click());
    expect(Buffer.from(after)).toEqual(Buffer.from(before));
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
