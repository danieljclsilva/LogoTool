import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { installRenderingProbe } from './rendering-probe.js';
import { addProductAndOpenSetup, assertCleanProbe, chooseModelTool, gotoBuilder, openOfflineContext, revealModelViewControls } from './helpers.js';
import { cubeGlb } from './fixtures/setup-calibration-glb.js';
import { customerModelPackage } from './fixtures/customer-model-package.js';
import { createSelfContainedHtml } from '../src/packaging/self-contained-html/index.js';
import { unzipSync } from 'fflate';

const builder = (page: Page, hook: string) => page.locator(`[data-builder-hook="${hook}"]`);
const setup = (page: Page, hook: string) => page.locator(`[data-model-setup-hook="${hook}"]`);
const customer = (page: Page, hook: string) => page.locator(`[data-customer-hook="${hook}"]`);
const pause = (ms: number) => new Promise(resolvePause => setTimeout(resolvePause, ms));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

async function sample(page: Page, info: TestInfo, screen: string): Promise<void> {
  await pause(1500);
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const before = await session.send('Performance.getMetrics');
  await page.evaluate(() => window.__logoRenderingProbe.reset());
  await pause(4000);
  const measurement = await page.evaluate(() => window.__logoRenderingProbe.snapshot());
  const after = await session.send('Performance.getMetrics');
  const metrics = (values: typeof before.metrics) => Object.fromEntries(values.map(item => [item.name, item.value]));
  const first = metrics(before.metrics);
  const last = metrics(after.metrics);
  const report = JSON.stringify({ screen, viewport: page.viewportSize(), measurement, taskDurationSeconds: last.TaskDuration! - first.TaskDuration!,
      scriptDurationSeconds: last.ScriptDuration! - first.ScriptDuration!, jsHeapUsedBytes: last.JSHeapUsedSize,
      nodeCount: last.Nodes, sourceCommit }, null, 2);
  await writeFile(info.outputPath(`rendering-profile-${screen}.json`), report);
  await info.attach(`rendering-profile-${screen}`, { contentType: 'application/json', body: report });
  await session.detach();
}

test('Experiment 0 probe counts RAF, draws, cancellation and context loss', async ({ browser }) => {
  const { context, page, probe } = await openOfflineContext(browser);
  try {
    await context.addInitScript(installRenderingProbe);
    await page.goto('about:blank');
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const gl = canvas.getContext('webgl2')!;
      if (!gl) throw new Error('WebGL2 unavailable in instrumentation control.');
      gl.clear(gl.COLOR_BUFFER_BIT);
      const program = gl.createProgram()!;
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, '#version 300 es\nvoid main(){gl_Position=vec4(0,0,0,1);gl_PointSize=1.0;}'],
        [gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float;out vec4 color;void main(){color=vec4(1); }'],
      ] as const) {
        const shader = gl.createShader(kind)!;
        gl.shaderSource(shader, source); gl.compileShader(shader); gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Control shader could not link.');
      gl.useProgram(program);
      const cancelled = requestAnimationFrame(() => { throw new Error('Cancelled callback ran.'); });
      cancelAnimationFrame(cancelled);
      await new Promise<void>(resolveFrame => requestAnimationFrame(() => { gl.drawArrays(gl.POINTS, 0, 1); resolveFrame(); }));
      const snapshot = window.__logoRenderingProbe.snapshot();
      gl.getExtension('WEBGL_lose_context')!.loseContext();
      return snapshot;
    }) as { contexts: Array<{ clearPasses: number; drawCalls: number; renderedFrames: number }>; liveRafCallbacks: number };
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]!.clearPasses).toBe(1);
    expect(result.contexts[0]!.drawCalls).toBe(1);
    expect(result.contexts[0]!.renderedFrames).toBe(1);
    expect(result.liveRafCallbacks).toBe(0);
    await expect.poll(() => page.evaluate(() => window.__logoRenderingProbe.snapshot()) as Promise<{ contextEvents: unknown[] }>).toMatchObject({ contextEvents: [expect.objectContaining({ event: 'webglcontextlost' })] });
    // The deliberate loss emits a browser warning, which the error probe excludes.
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('Experiment 0 staff screen and hidden-viewer idle measurements', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { context, page, probe } = await openOfflineContext(browser, { width: 1290, height: 700 });
  try {
    await context.addInitScript(installRenderingProbe);
    await gotoBuilder(page);
    await sample(page, info, 'staff-landing');
    await builder(page, 'job-landing-create').click();
    await builder(page, 'customer-name').fill('Synthetic rendering profile');
    await builder(page, 'job-ref').fill('RENDER-PROFILE');
    await sample(page, info, 'staff-prepare-empty');
    await builder(page, 'intake-mode-model').check();
    await builder(page, 'product-file').setInputFiles({ name: 'profile.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(cubeGlb(false, false)) });
    await expect(builder(page, 'intake-model-status')).toContainText('ready');
    await builder(page, 'product-name').fill('Synthetic profile product');
    await addProductAndOpenSetup(page);
    await sample(page, info, 'staff-setup-model');
    await revealModelViewControls(page);
    await setup(page, 'view-front').click();
    await page.locator('[data-model-setup-hook="viewbar"] [data-ps-view="fit"]').click();
    await setup(page, 'context-measure').click();
    await setup(page, 'ref-pick-a').click();
    const canvas = builder(page, 'product-model-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.47, box.y + box.height * 0.5);
    await page.mouse.click(box.x + box.width * 0.53, box.y + box.height * 0.5);
    await setup(page, 'ref-mm').fill('300');
    await setup(page, 'ref-fit').click();
    await chooseModelTool(page, 'rectangle');
    await setup(page, 'area-name').fill('Chest');
    await page.mouse.move(box.x + box.width * 0.44, box.y + box.height * 0.42);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 4 });
    await page.mouse.up();
    await expect(setup(page, 'area-list')).toContainText('Chest');
    await builder(page, 'model-setup-save').click();
    await builder(page, 'editor-logos').click();
    await sample(page, info, 'staff-logos');
    await builder(page, 'job-step-1').click();
    await sample(page, info, 'staff-prepare-after-model');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('Experiment 0 customer proof, diagram, review and replacement idle measurements', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { context, page, probe } = await openOfflineContext(browser, { width: 1280, height: 900 });
  try {
    await context.addInitScript(installRenderingProbe);
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
      const graphics = canvas.getContext('2d')!; graphics.fillStyle = '#ff00ff'; graphics.fillRect(0, 0, 100, 100);
      return canvas.toDataURL().split(',')[1]!;
    });
    const fixture = await customerModelPackage(new Uint8Array(Buffer.from(png, 'base64')));
    const html = createSelfContainedHtml({ html: await readFile(resolve('dist/dev/customer-configurator.html'), 'utf8'), projectPackage: fixture.bytes });
    const path = info.outputPath('profile-customer.html');
    await writeFile(path, html);
    await page.goto(pathToFileURL(path).href);
    await expect(page.locator('[data-placement-hook="pw-model-workbench"]')).toHaveAttribute('data-ready', 'true');
    await sample(page, info, 'customer-proof');
    await customer(page, 'primary-next').click();
    await sample(page, info, 'customer-review');
    await customer(page, 'step-edit').click();
    const archive = unzipSync(new Uint8Array(await readFile(resolve('dist/dev/synthetic-customer-prototype.zip'))));
    const draft = archive['SYNTHETIC-CUSTOMER.logo-project']!;
    await customer(page, 'file-input').setInputFiles({ name: 'diagram.logo-project', mimeType: 'application/zip', buffer: Buffer.from(draft) });
    await expect(customer(page, 'status')).toContainText('Opened diagram.logo-project');
    await expect(customer(page, 'canvas')).toBeVisible();
    await sample(page, info, 'customer-diagram-after-proof');
    for (let index = 0; index < 2; index += 1) {
      await customer(page, 'file-input').setInputFiles({ name: `replacement-${index}.logo-project`, mimeType: 'application/zip', buffer: Buffer.from(fixture.bytes) });
      await expect(customer(page, 'status')).toContainText(`Opened replacement-${index}.logo-project`);
      await expect(page.locator('[data-placement-hook="pw-model-workbench"]')).toHaveAttribute('data-ready', 'true');
    }
    await sample(page, info, 'customer-after-two-replacements');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});

test('Experiment 0 staff document review and reframe context lifecycle', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const { context, page, probe } = await openOfflineContext(browser, { width: 1440, height: 900 });
  try {
    await context.addInitScript(installRenderingProbe);
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
      const graphics = canvas.getContext('2d')!; graphics.fillStyle = '#ff00ff'; graphics.fillRect(0, 0, 100, 100);
      return canvas.toDataURL().split(',')[1]!;
    });
    const fixture = await customerModelPackage(new Uint8Array(Buffer.from(png, 'base64')));
    await gotoBuilder(page);
    await builder(page, 'job-open-file').setInputFiles({ name: 'profile-document.logo-project', mimeType: 'application/zip', buffer: Buffer.from(fixture.bytes) });
    await expect(builder(page, 'source-status')).toContainText('Loaded profile-document.logo-project');
    await builder(page, 'customer-name').fill('Synthetic document profile');
    await builder(page, 'job-ref').fill('PROFILE-DOC');
    await builder(page, 'issued-by').fill('Synthetic observer');
    for (const checkbox of await page.locator('[data-job-step="prepare"] input[type="checkbox"]:visible').all()) await checkbox.check();
    await builder(page, 'job-to-placements').click();
    await expect(page.locator('[data-placement-hook="pw-model-workbench"]')).toHaveAttribute('data-ready', 'true');
    await builder(page, 'job-step-3').click();
    await expect(page.locator('[data-doc-review-preview]')).toBeVisible();
    await sample(page, info, 'staff-document-review');
    for (let index = 0; index < 2; index += 1) {
      await page.getByRole('button', { name: 'Reframe to current camera' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Adjust document model view' });
      await expect(dialog).toBeVisible();
      await sample(page, info, `staff-document-reframe-${index + 1}`);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    await sample(page, info, 'staff-document-after-reframe-cycles');
    assertCleanProbe(probe);
  } finally { await context.close(); }
});
