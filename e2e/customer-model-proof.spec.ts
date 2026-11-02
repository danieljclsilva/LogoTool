import {expect,test,type Page,type TestInfo} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openOfflineContext,assertCleanProbe,gotoBuilder,revealCustomerControl} from './helpers.js';
import {customerModelPackage} from './fixtures/customer-model-package.js';
import {createSelfContainedHtml} from '../src/packaging/self-contained-html/index.js';
import {parseProjectPackage} from '../src/packaging/project-package/index.js';
import {createProjectPackage} from '../src/packaging/project-package/index.js';
import {resolveModelPlacementScene} from '../src/ui/model-placement-scene.js';
const c=(page:Page,name:string)=>page.locator(`[data-customer-hook="${name}"]`);
const m=(page:Page,name:string)=>page.locator(`[data-placement-hook="${name}"]`);
const sha256=async(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function artwork(page:Page){return new Uint8Array(Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=100;canvas.height=100;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#ff00ff';ctx.fillRect(0,0,100,100);return canvas.toDataURL().split(',')[1]!;}),'base64'));}
async function saveDraft(page:Page,path:string){const event=page.waitForEvent('download');await c(page,'save-draft-top').click();await(await event).saveAs(path);return parseProjectPackage(new Uint8Array(await readFile(path)),{sha256});}
async function centre(page:Page){const a=(await m(page,'pw-model-corner-0').boundingBox())!,b=(await m(page,'pw-model-corner-2').boundingBox())!;return{x:(a.x+a.width/2+b.x+b.width/2)/2,y:(a.y+a.height/2+b.y+b.height/2)/2};}

for(const viewport of [{width:1440,height:900},{width:390,height:844}])test(`customer model proof pointer edits preserve mapping and constraints at ${viewport.width}x${viewport.height}`,async({browser},info)=>{
  test.setTimeout(60_000);const{context,page,probe}=await openOfflineContext(browser,viewport);
  try{
    const fixture=await customerModelPackage(await artwork(page));
    const path=info.outputPath('customer-proof.html');await writeFile(path,createSelfContainedHtml({html:await readFile(resolve('dist/dev/customer-configurator.html'),'utf8'),projectPackage:fixture.bytes}));
    await page.goto(pathToFileURL(path).href);
    await expect(m(page,'pw-model-workbench')).toHaveAttribute('data-ready','true');
    await expect(m(page,'pw-model-workbench')).toHaveAttribute('data-artwork-count','2');
    await expect(m(page,'pw-model-move')).toBeHidden();await expect(m(page,'pw-model-corner-dist-0')).toBeHidden();
    await m(page,'pw-model-front').click();await expect(m(page,'pw-model-corner-0')).toBeVisible();
    const canvas=m(page,'pw-model-canvas');await canvas.scrollIntoViewIfNeeded();
    expect(await canvas.evaluate(node=>{const s=node as HTMLCanvasElement,t=document.createElement('canvas');t.width=s.width;t.height=s.height;const x=t.getContext('2d')!;x.drawImage(s,0,0);const p=x.getImageData(0,0,t.width,t.height).data;let n=0;for(let i=0;i<p.length;i+=4)if(p[i]!>150&&p[i+2]!>150&&p[i+1]!<110)n++;return n;})).toBeGreaterThan(100);
    const start=await centre(page);await page.mouse.move(start.x,start.y);await page.mouse.down();
    await expect(c(page,'save-draft-top')).toBeDisabled();await expect(c(page,'step-review')).toBeDisabled();
    await page.mouse.move(start.x+10,start.y,{steps:6});await page.mouse.up();
    const corner=(await m(page,'pw-model-corner-0').boundingBox())!;await page.mouse.move(corner.x+corner.width/2,corner.y+corner.height/2);await page.mouse.down();await page.mouse.move(corner.x+corner.width/2+4,corner.y+corner.height/2-4,{steps:5});await page.mouse.up();
    const draft=await saveDraft(page,info.outputPath('edited.logo-project'));
    const before=fixture.project.configurations[0]!.placements[0]!,after=draft.project.configurations[0]!.placements[0]!;
    expect(after.pos).not.toEqual(before.pos);expect(after.widthMm).not.toBe(before.widthMm);expect(after.widthMm/after.heightMm).toBeCloseTo(1,8);
    expect(after.id).toBe(before.id);expect(after.method).toBe(before.method);expect(after.instructions).toBe(before.instructions);expect(draft.project.products).toEqual(fixture.project.products);
    expect(draft.assets.some(a=>a.path.includes('setup-calibration'))).toBe(true);
    const cancelled=(await m(page,'pw-model-corner-0').boundingBox())!;
    await page.mouse.move(cancelled.x+cancelled.width/2,cancelled.y+cancelled.height/2);await page.mouse.down();
    await page.mouse.move(cancelled.x+cancelled.width/2+6,cancelled.y+cancelled.height/2-6,{steps:4});
    await page.keyboard.press('Escape');await page.mouse.up();
    expect(Number(await c(page,'width-mm').inputValue())).toBeCloseTo(after.widthMm,8);
    await expect(c(page,'save-draft-top')).toBeEnabled();
    // Camera zoom is a view operation; it must not store a new physical size.
    await m(page,'pw-model-zoom-in').click();await m(page,'pw-model-zoom-out').click();
    await m(page,'pw-model-focus-area').click();
    await expect(m(page,'pw-model-status')).toContainText('Focused');
    await m(page,'pw-model-fit').click();
    const unchanged=await saveDraft(page,info.outputPath('cancelled.logo-project'));
    expect(unchanged.project.configurations).toEqual(draft.project.configurations);
    const bad=(await m(page,'pw-model-corner-0').boundingBox())!;await page.mouse.move(bad.x+bad.width/2,bad.y+bad.height/2);await page.mouse.down();await page.mouse.move(bad.x+bad.width/2-150,bad.y+bad.height/2+150,{steps:6});await page.mouse.up();
    await expect(c(page,'status')).toContainText('previous placement is kept');
    const kept=await saveDraft(page,info.outputPath('kept.logo-project'));expect(kept.project.configurations).toEqual(draft.project.configurations);
    await page.screenshot({path:info.outputPath('customer-model-proof.png')});
    await c(page,'file-input').setInputFiles(info.outputPath('edited.logo-project'));await expect(m(page,'pw-model-workbench')).toHaveAttribute('data-artwork-count','2');
    expect(Number(await c(page,'width-mm').inputValue())).toBeCloseTo(after.widthMm,8);
    await m(page,'pw-model-back').click();await expect(m(page,'pw-model-corner-0')).toBeHidden();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);assertCleanProbe(probe);
  }finally{await context.close();}
});

test('model without mapping stays honest and does not invent a customer edit surface',async({browser},info)=>{
  const{context,page,probe}=await openOfflineContext(browser);
  try{const fixture=await customerModelPackage(await artwork(page),false);await page.goto(pathToFileURL(resolve('dist/dev/customer-configurator.html')).href);await c(page,'file-input').setInputFiles({name:'without-mapping.logo-project',mimeType:'application/zip',buffer:Buffer.from(fixture.bytes)});await expect(c(page,'width-mm')).toHaveValue('40');await expect(m(page,'pw-model-workbench')).toHaveCount(0);await expect(c(page,'mode-diagram')).toHaveAttribute('aria-pressed','true');assertCleanProbe(probe);}finally{await context.close();}
});

type ParsedPackage = Awaited<ReturnType<typeof parseProjectPackage>>;

/** Shared issue → customer mutate → confirm → return → adopt → save flow.
 * `preselectPlacement` populates a Step 2 field draft before adoption (the
 * stale-draft trigger); false covers the empty-selection adoption path. */
async function runAdoptionFlow(
  staffPage: Page,
  editorPage: Page,
  info: TestInfo,
  tag: string,
  preselectPlacement: boolean,
): Promise<{ office: ParsedPackage; returned: ParsedPackage; adopted: ParsedPackage }> {
  const page = staffPage, editor = editorPage;
  const download = async (p: Page, label: string, name: string) => {
    const event = p.waitForEvent('download');
    await p.getByRole('button', { name: label, exact: true }).click();
    const path = info.outputPath(`${tag}-${name}`);
    await (await event).saveAs(path);
    return path;
  };
  const fixture = await customerModelPackage(await artwork(page));
  await gotoBuilder(page);
  await page.locator('[data-builder-hook=job-open-file]').setInputFiles({ name: 'prepared.logo-project', mimeType: 'application/zip', buffer: Buffer.from(fixture.bytes) });
  await expect(page.locator('[data-builder-hook=source-status]')).toContainText('Loaded prepared.logo-project');
  await page.locator('[data-builder-hook=customer-name]').fill('Synthetic customer');
  await page.locator('[data-builder-hook=job-ref]').fill('SYN-MODEL-PROOF');
  await page.locator('[data-builder-hook=issued-by]').fill('Synthetic operator');
  for (const box of await page.locator('[data-job-step=prepare] input[type=checkbox]:visible').all()) await box.check();
  await page.locator('[data-builder-hook=job-to-placements]').click();
  if (preselectPlacement) {
    // Populate a Step 2 field draft for placement-0 (chest): viewing it
    // mirrors the committed values locally without creating pending edits.
    await m(page, 'pw-model-details').click();
    await page.locator('[data-placement-hook="pw-placement-row-placement-0"]').click();
    await expect(page.locator('[data-placement-hook="pw-width"]')).toHaveValue('40');
    await page.locator('[data-canvas-context-dismiss]').filter({ visible: true }).click();
  }
  await page.getByRole('button', { name: 'Send for customer approval', exact: true }).click();
  const branch = page.locator('[data-job-branch=approval]');
  await branch.getByText('More options', { exact: true }).click();
  await page.locator('[data-builder-hook=job-issue-project-new]').click();
  await branch.getByRole('button', { name: 'Create customer file', exact: true }).click();
  await expect(branch).toContainText('Customer file created');
  const officePath = await download(page, 'Save office copy', 'issued-office.logo-project');
  const htmlPath = await download(page, 'Save customer file', 'issued-customer.html');
  const office = await parseProjectPackage(new Uint8Array(await readFile(officePath)), { sha256 });
  await editor.goto(pathToFileURL(htmlPath).href);
  await expect(m(editor, 'pw-model-workbench')).toHaveAttribute('data-artwork-count', '2');
  // Mutate the SAME placement the operator viewed (placement-0): numeric
  // width plus instructions, so adoption must rebase the mirrored draft.
  await revealCustomerControl(editor, 'width-mm');
  await expect(c(editor, 'width-mm')).toHaveValue('40');
  await c(editor, 'placement-instructions').fill('Placeholder');
  await c(editor, 'width-mm').fill('48');
  await c(editor, 'width-mm').press('Tab');
  const note = 'Please align the chest artwork with the seam. <test> remains literal.';
  await c(editor, 'placement-instructions').fill(note);
  // One click commits the focused textarea and opens review.
  await editor.getByRole('button', { name: 'Review layout', exact: true }).click();
  await expect(editor.locator('[data-step-panel=review]')).toBeVisible();
  await expect(c(editor, 'review')).toContainText(note);
  await expect(c(editor, 'review')).not.toContainText(office.project.configurations[0]!.variantId);
  await c(editor, 'confirmed-by').fill('Synthetic customer');
  await c(editor, 'confirm').click();
  const returnPath = await download(editor, 'Save confirmed return file', 'customer-return.logo-project');
  const returned = await parseProjectPackage(new Uint8Array(await readFile(returnPath)), { sha256 });
  expect(returned.project.products).toEqual(office.project.products);
  expect(returned.project.configurations[0]!.placements[0]!.instructions).toBe(note);
  expect(returned.project.configurations[0]!.placements[0]!.widthMm).toBe(48);
  const originalMapping = office.assets.find(a => a.path.includes('setup-calibration'))!;
  expect(returned.assets.find(a => a.path === originalMapping.path)?.bytes).toEqual(originalMapping.bytes);
  const alteredAssets = returned.assets.map(a => a.path === originalMapping.path ? { ...a, bytes: new TextEncoder().encode('{}') } : a);
  const forged = await createProjectPackage({ project: returned.project, assets: alteredAssets.filter(a => a.kind === 'referenced'), additionalAssets: alteredAssets.filter(a => a.kind !== 'referenced') }, { sha256 });
  await branch.getByLabel('Choose the saved office copy for this job', { exact: true }).setInputFiles(officePath);
  const response = branch.locator('section[aria-label="Customer response"]');
  await expect(response).toContainText('Office copy loaded');
  await branch.getByLabel('Choose the returned customer file', { exact: true }).setInputFiles({ name: 'altered.logo-project', mimeType: 'application/zip', buffer: Buffer.from(forged) });
  await expect(response).toContainText('asset comparison differs');
  await expect(branch.getByRole('button', { name: 'Use customer changes', exact: true })).toBeHidden();
  await branch.getByLabel('Choose the returned customer file', { exact: true }).setInputFiles(returnPath);
  await expect(response).toContainText('Response checked against the office copy');
  await expect(response).toContainText('Before: Prepared chest instruction.');
  await expect(response).toContainText('After: ' + note);
  await branch.getByRole('button', { name: 'Use customer changes', exact: true }).click();
  await expect(m(page, 'pw-model-workbench')).toHaveAttribute('data-artwork-count', '2');
  // Adoption preserves the issued inclusion: 1 product + 2 logos + 1 setup.
  const boxes = page.locator('[data-job-step=prepare] input[type=checkbox]');
  expect(await boxes.count()).toBe(4);
  expect(await boxes.evaluateAll((list) => list.filter((node) => node instanceof HTMLInputElement && node.checked).length)).toBe(4);
  // Adoption must not manufacture pending edits: Save job downloads directly
  // instead of raising the unapplied-placement guard.
  const saveEvent = page.waitForEvent('download', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Save job', exact: true }).click();
  const adoptedPath = info.outputPath(`${tag}-adopted.logo-project`);
  await (await saveEvent).saveAs(adoptedPath);
  const adopted = await parseProjectPackage(new Uint8Array(await readFile(adoptedPath)), { sha256 });
  const cfg = adopted.project.configurations[0]!;
  const scene = resolveModelPlacementScene(adopted.project, new Map(adopted.assets.map(a => [a.path, a.bytes])), cfg.productId, cfg.variantId);
  expect(scene?.regions).toHaveLength(2);
  expect(adopted.project.configurations).toEqual(returned.project.configurations);
  expect(adopted.project.products).toEqual(returned.project.products);
  expect(adopted.project.logos).toEqual(returned.project.logos);
  return { office, returned, adopted };
}

test('adopted return with a populated field draft keeps inclusion and saves cleanly', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const staff = await openOfflineContext(browser, { width: 1440, height: 900 });
  const customer = await openOfflineContext(browser, { width: 1440, height: 900 });
  const page = staff.page, editor = customer.page;
  try {
    const { adopted } = await runAdoptionFlow(page, editor, info, 'draft', true);
    // Legitimate dirty-draft protection: a real operator edit must still guard.
    await m(page, 'pw-model-details').click();
    await page.locator('[data-placement-hook="pw-placement-row-placement-0"]').click();
    await page.locator('[data-placement-hook="pw-width"]').fill('44');
    await page.locator('[data-placement-hook="pw-width"]').press('Tab');
    await page.getByRole('button', { name: 'Save job', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Discard pending edits' })).toBeVisible();
    const retry = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Discard pending edits' }).click();
    const discardedPath = info.outputPath('draft-discarded.logo-project');
    await (await retry).saveAs(discardedPath);
    const discarded = await parseProjectPackage(new Uint8Array(await readFile(discardedPath)), { sha256 });
    expect(discarded.project.configurations).toEqual(adopted.project.configurations);
    // Reissue works without manual reselection after adoption.
    await page.getByRole('button', { name: 'Send for customer approval', exact: true }).click();
    const branch = page.locator('[data-job-branch=approval]');
    await branch.getByRole('button', { name: 'Create customer file', exact: true }).click();
    await expect(branch).toContainText('Customer file created');
    assertCleanProbe(staff.probe); assertCleanProbe(customer.probe);
  } finally { await customer.context.close(); await staff.context.close(); }
});

test('adopted return without a prior field draft keeps inclusion and saves cleanly', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const staff = await openOfflineContext(browser, { width: 1440, height: 900 });
  const customer = await openOfflineContext(browser, { width: 1440, height: 900 });
  try {
    await runAdoptionFlow(staff.page, customer.page, info, 'nodraft', false);
    assertCleanProbe(staff.probe); assertCleanProbe(customer.probe);
  } finally { await customer.context.close(); await staff.context.close(); }
});
