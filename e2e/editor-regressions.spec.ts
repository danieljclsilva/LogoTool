import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gotoBuilder, openOfflineContext, assertCleanProbe } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { parseProjectPackage } from '../src/packaging/project-package/index.js';

const b = (page: Page, name: string) => page.locator(`[data-builder-hook="${name}"]`);
const pw = (page: Page, name: string) => page.locator(`[data-placement-hook="${name}"]`);
const ms = (page: Page, name: string) => page.locator(`[data-model-setup-hook="${name}"]`);
const viewports = [{ width: 1440, height: 900 }, { width: 1440, height: 781 }, { width: 1280, height: 720 }, { width: 390, height: 844 }];

async function createUnconfiguredModel(page: Page, glb = cubeGlb(true, false)) {
  await gotoBuilder(page);
  await b(page, 'job-landing-create').click();
  await b(page, 'customer-name').fill('Synthetic unconfigured product');
  await b(page, 'job-ref').fill('EDITOR-REGRESSION');
  await b(page, 'intake-mode-model').check();
  await b(page, 'product-file').setInputFiles({ name: 'unconfigured.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(glb) });
  await expect(b(page, 'intake-model-status')).toContainText('ready');
  await b(page, 'product-name').fill('Unconfigured jacket');
  await b(page, 'product-add').click();
  await expect(b(page, 'product-editor')).toBeVisible();
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 80; c.height = 40;
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 80, 40);
    return c.toDataURL().split(',')[1]!;
  });
  await b(page, 'logo-file').setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(b(page, 'logo-status')).toContainText('Added');
  return b(page, 'product-model').locator('canvas');
}

for (const viewport of viewports) {
  for (const entry of ['mode', 'prepare'] as const) test(`uncalibrated model remains visible through ${entry} entry at ${viewport.width}×${viewport.height}`, async ({ browser }, info) => {
    const { context, page, probe } = await openOfflineContext(browser, viewport);
    page.setDefaultTimeout(10_000);
    try {
      const canvas = await createUnconfiguredModel(page);
      const original = await canvas.elementHandle();
      if (entry === 'prepare') {
        await b(page, 'job-step-1').click();
        await expect(b(page, 'customer-name')).toBeVisible();
        await b(page, 'job-to-placements').click();
      } else await b(page, 'editor-logos').click();
      await expect(b(page, 'product-editor')).toBeVisible();
      await expect(b(page, 'product-editor')).toHaveAttribute('data-mode', 'logos');
      await expect(pw(page, 'pw-model-workbench')).toHaveAttribute('data-ready', 'true');
      await expect(pw(page, 'pw-stage-svg')).toHaveCount(0);
      await expect(pw(page, 'pw-model-canvas')).toBeVisible();
      expect(await canvas.evaluate((node, saved) => node === saved, original)).toBe(true);
      await pw(page, 'pw-model-front').click();
      await pw(page, 'pw-model-fit').click();
      await expect.poll(() => canvas.evaluate(node => {
        const c = node as HTMLCanvasElement, copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
        const ctx = copy.getContext('2d')!; ctx.drawImage(c, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let coloured = 0; for (let at = 0; at < pixels.length; at += 4) if (pixels[at]! < 220 && pixels[at + 2]! > pixels[at]!) coloured++;
        return coloured;
      })).toBeGreaterThan(100);
      await page.screenshot({path:info.outputPath('unconfigured-logos.png')});
      await pw(page, 'pw-stage-setup').click();
      await expect(b(page, 'product-editor')).toHaveAttribute('data-mode', 'setup');
      expect(await canvas.evaluate((node, saved) => node === saved, original)).toBe(true);
      await b(page, 'editor-logos').click();
      await pw(page, 'pw-model-details').click();
      const place = pw(page, 'pw-artwork-grid').getByRole('button', {name:/Place .* provisional preview/}).first();
      if (await place.isEnabled()) await place.click();
      const download = page.waitForEvent('download');
      await b(page, 'job-save').click();
      const path = info.outputPath('still-unconfigured.logo-project'); await (await download).saveAs(path);
      const saved = await parseProjectPackage(new Uint8Array(await readFile(path)), {sha256:async bytes => createHash('sha256').update(bytes).digest('hex')});
      expect(saved.project.products.flatMap(product => product.regions)).toHaveLength(0);
      expect(saved.project.products.flatMap(product => product.calibrations)).toHaveLength(0);
      expect(saved.project.configurations.flatMap(configuration => configuration.placements)).toHaveLength(0);
      await b(page, 'editor-setup').click();
      await expect(canvas).toBeVisible();
      expect(await canvas.evaluate((node, saved) => node === saved, original)).toBe(true);
      assertCleanProbe(probe);
    } catch (error) { await page.screenshot({path:info.outputPath('failure.png')}).catch(() => {}); throw error; }
    finally { await context.close(); }
  });

  test(`normal editor keeps the page top and actions reachable at ${viewport.width}×${viewport.height}`, async ({ browser }, info) => {
    const { context, page, probe } = await openOfflineContext(browser, viewport);
    page.setDefaultTimeout(10_000);
    try {
      const canvas = await createUnconfiguredModel(page);
      const topIsVisible = async () => {
        const header = (await page.locator('.station-header').boundingBox())!;
        expect(header.y).toBeGreaterThanOrEqual(-1);
        const navigation = (await b(page, 'job-step-2').boundingBox())!;
        expect(navigation.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
        const modes = (await page.locator('.product-editor-modes').boundingBox())!;
        expect(modes.y).toBeGreaterThanOrEqual(navigation.y + navigation.height - 1);
        if (viewport.width > 820) {
          const save = (await b(page, 'model-setup-save').boundingBox())!;
          expect(save.y + save.height).toBeLessThanOrEqual(viewport.height);
          const stage = (await canvas.boundingBox())!;
          expect(stage.y).toBeGreaterThanOrEqual(modes.y + modes.height - 1);
          expect(stage.height).toBeGreaterThan(viewport.height * .35);
        }
      };
      await topIsVisible();
      if (viewport.width > 820) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height - 40 });
        await expect.poll(() => page.locator('.station-header').evaluate(node => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(-1);
        await page.setViewportSize(viewport);
      }
      await ms(page, 'context-measure').click();
      await topIsVisible();
      await page.locator('#model-context [data-canvas-context-dismiss]').click();
      if (viewport.width > 820) {
        await ms(page, 'context-measure').click();
        await ms(page, 'ref-pick-a').click();
        const box = (await canvas.boundingBox())!;
        await page.mouse.click(box.x + box.width * .45, box.y + box.height * .5);
        await page.mouse.click(box.x + box.width * .55, box.y + box.height * .5);
        await ms(page, 'ref-mm').fill('200'); await ms(page, 'ref-fit').click();
        await ms(page, 'tool-rectangle').click();
        await page.mouse.move(box.x + box.width * .44, box.y + box.height * .42); await page.mouse.down();
        await page.mouse.move(box.x + box.width * .56, box.y + box.height * .58, {steps:4}); await page.mouse.up();
        await b(page, 'model-setup-save').click();
        await expect(b(page, 'model-setup-status')).toContainText('Saved 3D setup');
        await topIsVisible();
      }
      await b(page, 'product-model-expand').click();
      await b(page, 'product-model-expand').click();
      await topIsVisible();
      await b(page, 'job-step-1').click();
      await b(page, 'job-to-placements').click();
      await b(page, 'editor-setup').click();
      await topIsVisible();
      await page.screenshot({path:info.outputPath('normal-editor-top.png')});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      assertCleanProbe(probe);
    } catch (error) { await page.screenshot({path:info.outputPath('failure.png')}).catch(() => {}); throw error; }
    finally { await context.close(); }
  });
}

/** Self-contained textured mesh: no network, so texture decode is the only delayed work. */
function texturedCube(png: Uint8Array): Uint8Array {
  const original = Buffer.from(cubeGlb(true, false));
  const jsonLength = original.readUInt32LE(12);
  const gltf = JSON.parse(original.subarray(20, 20 + jsonLength).toString()) as {
    accessors: Array<Record<string, unknown>>; bufferViews: Array<Record<string, unknown>>;
    buffers: Array<{byteLength:number}>; meshes:Array<{primitives:Array<{attributes:Record<string,number>}>}>;
    materials: unknown[]; images?:unknown[]; textures?:unknown[];
  };
  const bin = original.subarray(28 + jsonLength);
  const count = Number(gltf.accessors[0]!.count), uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) { uv[i * 2] = i % 3 === 0 ? 0 : 1; uv[i * 2 + 1] = i % 3 === 2 ? 1 : 0; }
  const uvView = gltf.bufferViews.length;
  gltf.bufferViews.push({buffer:0,byteOffset:bin.length,byteLength:uv.byteLength,target:34962});
  const uvAccessor = gltf.accessors.length;
  gltf.accessors.push({bufferView:uvView,componentType:5126,count,type:'VEC2'});
  gltf.meshes[0]!.primitives[0]!.attributes.TEXCOORD_0 = uvAccessor;
  const imageView = gltf.bufferViews.length;
  gltf.bufferViews.push({buffer:0,byteOffset:bin.length + uv.byteLength,byteLength:png.length});
  gltf.images = [{bufferView:imageView,mimeType:'image/png'}]; gltf.textures = [{source:0}];
  gltf.materials = [{doubleSided:true,pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:1}}];
  const payload = Buffer.concat([bin,Buffer.from(uv.buffer),Buffer.from(png),Buffer.alloc((4-png.length%4)%4)]);
  gltf.buffers[0]!.byteLength = payload.length;
  const json = Buffer.from(JSON.stringify(gltf)), padded = Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const output = Buffer.alloc(28 + padded.length + payload.length);
  output.writeUInt32LE(0x46546c67,0); output.writeUInt32LE(2,4); output.writeUInt32LE(output.length,8);
  output.writeUInt32LE(padded.length,12); output.writeUInt32LE(0x4e4f534a,16); padded.copy(output,20);
  output.writeUInt32LE(payload.length,20+padded.length); output.writeUInt32LE(0x004e4942,24+padded.length); payload.copy(output,28+padded.length);
  return output;
}

test('switching tools during texture loading completes the same model load', async ({browser}, info) => {
  const {context,page,probe} = await openOfflineContext(browser,{width:1280,height:720});
  try {
    await page.addInitScript(() => {
      const original = window.createImageBitmap.bind(window);
      const state = window as unknown as {textureWaiting:boolean;releaseTexture:()=>void};
      const gate = new Promise<void>(resolve => {state.releaseTexture=resolve;});
      window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
        const options=args[1];
        if (options && typeof options==='object' && 'colorSpaceConversion' in options) {
          state.textureWaiting=true;
          return gate.then(() => Reflect.apply(original,window,args) as Promise<ImageBitmap>);
        }
        return Reflect.apply(original,window,args) as Promise<ImageBitmap>;
      }) as typeof createImageBitmap;
    });
    const png = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#274a68'; ctx.fillRect(0, 0, 8, 8);
      return canvas.toDataURL().split(',')[1]!;
    }), 'base64');
    const canvas = await createUnconfiguredModel(page,texturedCube(png));
    await page.waitForFunction(() => (window as unknown as {textureWaiting:boolean}).textureWaiting===true);
    const original = await canvas.elementHandle();
    await b(page,'editor-logos').click();
    await page.evaluate(() => (window as unknown as {releaseTexture:()=>void}).releaseTexture());
    await expect(pw(page,'pw-model-workbench')).toHaveAttribute('data-ready','true');
    expect(await canvas.evaluate((node,saved)=>node===saved,original)).toBe(true);
    await page.screenshot({path:info.outputPath('texture-load-completed.png')});
    assertCleanProbe(probe);
  } finally {await context.close();}
});

for (const viewport of [{width:1440,height:781},{width:1280,height:720},{width:390,height:844}]) {
  test(`Finish area is readable, aligned and clickable at ${viewport.width}×${viewport.height}`, async ({browser}, info) => {
    const {context,page,probe} = await openOfflineContext(browser,viewport);
    try {
      const canvas = await createUnconfiguredModel(page,cubeGlb(false,false));
      await ms(page,'view-front').click();
      await page.locator('[data-model-setup-hook="viewbar"] [data-ps-view="fit"]').click();
      await ms(page,'context-measure').click(); await ms(page,'ref-pick-a').click();
      const tap = async (x:number,y:number) => {
        const box=(await canvas.boundingBox())!;
        await page.mouse.click(box.x+box.width*x,box.y+box.height*y);
      };
      await tap(.45,.5); await tap(.55,.5);
      await ms(page,'ref-mm').fill('200'); await ms(page,'ref-fit').click();
      for (const expanded of [false,true]) {
        if (expanded) await b(page,'product-model-expand').click();
        await ms(page,'tool-freehand').click();
        await ms(page,'area-name').fill(expanded ? 'Enlarged triangle' : 'Normal triangle');
        const finish=ms(page,'area-finish');
        await expect(finish).toBeVisible(); await expect(finish).toHaveText('Finish area');
        const contrast = () => finish.evaluate(node => {
          const style=getComputedStyle(node);
          const luminance=(css:string) => {
            const values=css.match(/[\d.]+/g)!.slice(0,3).map(Number).map(value=>{
              const channel=value/255; return channel<=.04045 ? channel/12.92 : ((channel+.055)/1.055)**2.4;
            });
            return .2126*values[0]!+.7152*values[1]!+.0722*values[2]!;
          };
          const fg=luminance(style.color),bg=luminance(style.backgroundColor);
          return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
        });
        expect(await contrast()).toBeGreaterThanOrEqual(4.5);
        await finish.hover(); expect(await contrast()).toBeGreaterThanOrEqual(4.5);
        await ms(page,'area-cancel').focus(); await page.keyboard.press('Shift+Tab');
        await expect(finish).toBeFocused(); expect(await contrast()).toBeGreaterThanOrEqual(4.5);
        expect(await finish.evaluate(node=>getComputedStyle(node).outlineStyle)).not.toBe('none');
        const controls=await page.locator('[data-model-setup-hook="viewbar"]').locator('button,select,input').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>{
          const rect=n.getBoundingClientRect(); return {y:rect.y,h:rect.height};
        }));
        expect(Math.max(...controls.map(c=>c.h))-Math.min(...controls.map(c=>c.h))).toBeLessThanOrEqual(1);
        for (const first of controls) for (const second of controls) {
          const overlap=Math.min(first.y+first.h,second.y+second.h)-Math.max(first.y,second.y);
          if (overlap>Math.min(first.h,second.h)*.5) expect(Math.abs(first.y-second.y)).toBeLessThanOrEqual(1);
        }
        await tap(.46,.44); await tap(.55,.44);
        await finish.click();
        await expect(ms(page,'status')).toContainText('Pick at least 3');
        await tap(.52,.56);
        await page.screenshot({path:info.outputPath(expanded?'finish-enlarged.png':'finish-normal.png')});
        await finish.click();
        await expect(ms(page,'tool-rotate')).toHaveAttribute('aria-pressed','true');
        await expect(ms(page,'area-list')).toContainText(expanded?'Enlarged triangle':'Normal triangle');
        if (expanded) await b(page,'product-model-expand').click();
      }
      await b(page,'model-setup-save').click();
      await expect(b(page,'model-setup-status')).toContainText('Saved 3D setup');
      const download=page.waitForEvent('download'); await b(page,'job-save').click();
      const path=info.outputPath('finished-areas.logo-project'); await (await download).saveAs(path);
      const saved=await parseProjectPackage(new Uint8Array(await readFile(path)),{sha256:async bytes=>createHash('sha256').update(bytes).digest('hex')});
      expect(saved.project.products[0]!.regions.map(region=>region.safeArea.length)).toEqual([3,3]);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      assertCleanProbe(probe);
    } finally {await context.close();}
  });
}
