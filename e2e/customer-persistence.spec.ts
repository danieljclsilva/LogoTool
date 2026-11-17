import { revealCustomerControl, selectCustomerOption } from './helpers.js';
import { expect, test } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
const HTML_ENTRY = 'customer-configurator.html';
const PROJECT_ENTRY = 'SYNTHETIC-CUSTOMER.logo-project';

interface LocalPrototype {
  directory: string;
  htmlPath: string;
  projectPath: string;
  projectBytes: Buffer;
}

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

async function unpackPrototype(): Promise<LocalPrototype> {
  const archive = new Uint8Array(await fs.readFile(resolve('dist/dev/synthetic-customer-prototype.zip')));
  const entries = unzipSync(archive);
  const names = Object.keys(entries).sort();
  expect(names).toEqual([HTML_ENTRY, PROJECT_ENTRY].sort());
  const directory = await fs.mkdtemp(join(tmpdir(), 'LogoTool persistence with spaces '));
  const htmlPath = join(directory, 'standalone customer configurator.html');
  const projectPath = join(directory, 'SYNTHETIC-CUSTOMER.logo-project');
  const html = entries[HTML_ENTRY];
  const project = entries[PROJECT_ENTRY];
  if (!html || !project) throw new Error('Synthetic customer prototype ZIP is missing its named inline HTML or project package.');
  const projectBytes = Buffer.from(project);
  await Promise.all([
    fs.writeFile(htmlPath, Buffer.from(html)),
    fs.writeFile(projectPath, projectBytes),
  ]);
  return { directory, htmlPath, projectPath, projectBytes };
}

async function openOfflineEditor(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<{
  context: BrowserContext;
  page: Page;
  probe: Probe;
}> {
  const info = test.info();
  await info.attach('customer-persistence-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform,
      release: release(),
      arch: process.arch,
      browser: info.project.name,
      browserVersion: browser.version(),
      viewport,
      offline: true,
      entryPoint: 'file://',
      prototype: 'synthetic customer editor',
    }, null, 2),
  });
  const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport });
  const page = await context.newPage();
  const probe: Probe = { pageErrors: [], consoleErrors: [], networkRequests: [] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.networkRequests.push(request.url());
  });
  return { context, page, probe };
}

async function openPage(page: Page, prototype: LocalPrototype): Promise<void> {
  await page.goto(pathToFileURL(prototype.htmlPath).href);
  await expect(page).toHaveTitle(/logo layout/i);
  await expect(page.locator('.wordmark')).toHaveText('Logo Station');
  await expect(page.locator('[data-customer-hook="choose"]')).toBeVisible();
}

async function choosePackage(page: Page, path: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await revealCustomerControl(page, 'choose');
  await page.locator('[data-customer-hook="choose"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path);
  await expect(page.locator('[data-customer-hook="project-id"]')).not.toHaveText('Not loaded');
}

async function createEmptyReplacementPackage(sourceBytes: Uint8Array): Promise<Uint8Array> {
  const parsed = await parseProjectPackage(sourceBytes, { sha256 });
  const project = {
    ...parsed.project,
    projectId: 'SYN-PROJ-ASYNC-NEW',
    configurations: parsed.project.configurations.map((configuration) => ({ ...configuration, placements: [] })),
  };
  delete (project as { confirmation?: unknown }).confirmation;
  delete (project as { review?: unknown }).review;
  const assets = parsed.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes }));
  const additionalAssets = parsed.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes }));
  return createProjectPackage({ project, assets, additionalAssets }, { sha256 });
}

async function saveDownloadedFile(page: Page, outputPath: string, trigger: () => Promise<void>): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download');
  await trigger();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  assert.ok(downloadedPath, 'Playwright should retain the locally saved package.');
  const bytes = await fs.readFile(downloadedPath);
  await fs.writeFile(outputPath, bytes);
  return bytes;
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.networkRequests).toEqual([]);
}

async function setNumber(page: Page, hook: string, value: number): Promise<void> {
  await revealCustomerControl(page, hook);
  await page.locator(`[data-customer-hook="${hook}"]`).fill(String(value));
  await page.locator(`[data-customer-hook="${hook}"]`).press('Tab');
}

async function isBeforeUnloadDirty(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test('beforeunload tracks pending, applied-awaiting-download, and download-clean', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    expect(await isBeforeUnloadDirty(page)).toBe(false);

    await revealCustomerControl(page, 'width-mm');
    await page.locator('[data-customer-hook="width-mm"]').fill('77');
    expect(await isBeforeUnloadDirty(page)).toBe(true);

    await page.locator('[data-customer-hook="width-mm"]').press('Tab');
    await expect(page.locator('[data-customer-hook="revision"]')).not.toHaveText('');
    expect(await isBeforeUnloadDirty(page)).toBe(true);

    await saveDownloadedFile(page, join(prototype.directory, 'draft clean.logo-project'), async () => {
      await revealCustomerControl(page, 'save');
      await page.locator('[data-customer-hook="save"]').click();
    });
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('download started');
    expect(await page.locator('[data-customer-hook="status"]').textContent() ?? '').not.toContain('Saved your');
    expect(await isBeforeUnloadDirty(page)).toBe(false);

    await setNumber(page, 'height-mm', 29);
    expect(await isBeforeUnloadDirty(page)).toBe(true);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('real reload shows native beforeunload and dismissal keeps work', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    const projectId = await page.locator('[data-customer-hook="project-id"]').textContent();
    await revealCustomerControl(page, 'width-mm');
    await page.locator('[data-customer-hook="width-mm"]').fill('77');
    expect(await isBeforeUnloadDirty(page)).toBe(true);
    const dialogPromise = page.waitForEvent('dialog');
    await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0); });
    const dialog = await dialogPromise;
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText(projectId ?? '');
    expect(await isBeforeUnloadDirty(page)).toBe(true);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('replacement guard cancel preserves project, selection, and history; discard proceeds', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    const projectId = await page.locator('[data-customer-hook="project-id"]').textContent();
    const revision = await page.locator('[data-customer-hook="revision"]').textContent();
    const placementCount = await page.locator('[data-customer-hook="placement"] option').count();
    await selectCustomerOption(page, 'configuration', 'SYN-CFG-TEE-M');
    const selectedBefore = await page.locator('[data-customer-hook="placement"]').inputValue().catch(() => '');

    await setNumber(page, 'x-mm', 9);
    const editedRevision = await page.locator('[data-customer-hook="revision"]').textContent();
    expect(editedRevision).not.toBe(revision);
    await expect(page.locator('[data-customer-hook="undo"]')).toBeEnabled();

    const replacementBytes = await createEmptyReplacementPackage(new Uint8Array(prototype.projectBytes));
    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'replacement while dirty.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(replacementBytes),
    });
    const guard = page.locator('[data-customer-hook="unsaved-guard"]');
    await expect(guard).toBeVisible();
    await expect(guard).toHaveAttribute('role', 'alertdialog');
    await expect(page.locator('[data-customer-hook="unsaved-guard-detail"]')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('[data-customer-hook="unsaved-keep"]')).toBeFocused();
    expect(await guard.evaluate(node => node.parentElement?.id)).toBe('customer-editor');
    const guardBox = (await guard.boundingBox())!;
    const proofBox = (await page.locator('[data-customer-hook="canvas-pane"]').boundingBox())!;
    expect(guardBox.y + guardBox.height).toBeLessThanOrEqual(proofBox.y);

    await page.screenshot({ path: test.info().outputPath('customer-replacement-guard.png') });
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText(projectId ?? '');
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(editedRevision ?? '');
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(placementCount);
    expect(await isBeforeUnloadDirty(page)).toBe(true);

    await page.locator('[data-customer-hook="unsaved-keep"]').click();
    await expect(guard).toBeHidden();
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText(projectId ?? '');
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(editedRevision ?? '');
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(placementCount);
    await expect(page.locator('[data-customer-hook="undo"]')).toBeEnabled();
    await expect(page.locator('[data-customer-hook="placement"]')).toHaveValue(selectedBefore);

    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'replacement while dirty.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(replacementBytes),
    });
    await expect(guard).toBeVisible();
    await page.locator('[data-customer-hook="unsaved-discard"]').click();
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-ASYNC-NEW');
    await expect(guard).toBeHidden();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('guard save-draft downloads then installs the pending file', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    await setNumber(page, 'x-mm', 11);
    const replacementBytes = await createEmptyReplacementPackage(new Uint8Array(prototype.projectBytes));
    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'pending save then load.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(replacementBytes),
    });
    await expect(page.locator('[data-customer-hook="unsaved-guard"]')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-customer-hook="unsaved-save"]').click();
    const download = await downloadPromise;
    expect(await download.path()).not.toBeNull();
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-ASYNC-NEW');
    await expect(page.locator('[data-customer-hook="unsaved-guard"]')).toBeHidden();
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Opened pending save then load.logo-project');
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('confirmation counts as dirty awaiting download; confirmed download cleans until next edit', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    expect(await isBeforeUnloadDirty(page)).toBe(false);
    await revealCustomerControl(page, 'confirmed-by');
    await page.locator('[data-customer-hook="confirmed-by"]').fill('persistence reviewer');
    await revealCustomerControl(page, 'confirm');
    await page.locator('[data-customer-hook="confirm"]').click();
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('Confirmed: version');
    expect(await isBeforeUnloadDirty(page)).toBe(true);
    await expect(page.locator('[data-customer-hook="submit"]')).toBeEnabled();

    await saveDownloadedFile(page, join(prototype.directory, 'confirmed return.logo-project'), async () => {
      await revealCustomerControl(page, 'submit');
      await page.locator('[data-customer-hook="submit"]').click();
    });
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('email attachment');
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('download started');
    expect(await isBeforeUnloadDirty(page)).toBe(false);

    await setNumber(page, 'x-mm', 13);
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText(/no longer counts|Nothing confirmed/i);
    expect(await isBeforeUnloadDirty(page)).toBe(true);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('symmetric ratio lock mirrors width and height; explicit unlock allows distortion', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    await expect(page.locator('[data-customer-hook="precise-size"]')).not.toHaveAttribute('open', '');
    await expect(page.locator('[data-customer-hook="width-mm"]')).toBeVisible();
    await expect(page.locator('[data-customer-hook="height-mm"]')).toBeVisible();
    await expect(page.locator('[data-customer-hook="ratio-lock"]')).toBeVisible();
    await expect(page.locator('[data-customer-hook="rotation"]')).toBeHidden();
    await page.screenshot({ path: test.info().outputPath('customer-desktop-initial.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: test.info().outputPath('customer-phone-initial.png') });
    await page.screenshot({ path: test.info().outputPath('customer-phone-full-page.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    const width0 = Number(await page.locator('[data-customer-hook="width-mm"]').inputValue());
    const height0 = Number(await page.locator('[data-customer-hook="height-mm"]').inputValue());
    expect(width0).toBeGreaterThan(0);
    expect(height0).toBeGreaterThan(0);
    const ratio = width0 / height0;
    await expect(page.locator('[data-customer-hook="ratio-lock"]')).toBeChecked();

    await revealCustomerControl(page, 'width-mm');
    await page.locator('[data-customer-hook="width-mm"]').fill(String(width0 * 2));
    const mirroredHeight = Number(await page.locator('[data-customer-hook="height-mm"]').inputValue());
    expect(mirroredHeight).toBeCloseTo((width0 * 2) / ratio, 6);
    await expect(page.locator('[data-customer-hook="ratio-lock"]')).toBeChecked();
    await page.locator('[data-customer-hook="width-mm"]').press('Tab');
    const revisionAfterWidth = await page.locator('[data-customer-hook="revision"]').textContent();
    expect(revisionAfterWidth).not.toBe('');

    const width1 = Number(await page.locator('[data-customer-hook="width-mm"]').inputValue());
    const height1 = Number(await page.locator('[data-customer-hook="height-mm"]').inputValue());
    expect(width1).toBeCloseTo(width0 * 2, 6);
    expect(height1).toBeCloseTo(width1 / ratio, 6);

    await page.locator('[data-customer-hook="height-mm"]').fill(String(height1 * 2));
    const mirroredWidth = Number(await page.locator('[data-customer-hook="width-mm"]').inputValue());
    expect(mirroredWidth).toBeCloseTo(height1 * 2 * ratio, 6);
    await expect(page.locator('[data-customer-hook="ratio-lock"]')).toBeChecked();
    await page.locator('[data-customer-hook="height-mm"]').press('Tab');
    const width2 = Number(await page.locator('[data-customer-hook="width-mm"]').inputValue());
    const height2 = Number(await page.locator('[data-customer-hook="height-mm"]').inputValue());
    expect(width2).toBeCloseTo(height2 * ratio, 6);

    await page.locator('[data-customer-hook="ratio-lock"]').uncheck();
    await expect(page.locator('[data-customer-hook="ratio-lock"]')).not.toBeChecked();
    await page.locator('[data-customer-hook="width-mm"]').fill('60');
    await page.locator('[data-customer-hook="width-mm"]').press('Tab');
    await page.locator('[data-customer-hook="height-mm"]').fill('15');
    await page.locator('[data-customer-hook="height-mm"]').press('Tab');
    await expect(page.locator('[data-customer-hook="width-mm"]')).toHaveValue('60');
    await expect(page.locator('[data-customer-hook="height-mm"]')).toHaveValue('15');
    await expect(page.locator('[data-customer-hook="ratio-lock"]')).not.toBeChecked();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('discard of invalid replacement preserves pending inputs and unload guard', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    const projectId = await page.locator('[data-customer-hook="project-id"]').textContent();
    const revision = await page.locator('[data-customer-hook="revision"]').textContent();

    await revealCustomerControl(page, 'width-mm');
    await page.locator('[data-customer-hook="width-mm"]').fill('');
    expect(await isBeforeUnloadDirty(page)).toBe(true);
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(revision ?? '');

    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'broken.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from('not a ZIP archive'),
    });
    const guard = page.locator('[data-customer-hook="unsaved-guard"]');
    await expect(guard).toBeVisible();
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText(projectId ?? '');

    await page.locator('[data-customer-hook="unsaved-discard"]').click();
    await expect(page.locator('[data-customer-hook="status"]')).toContainText(/Could not load broken\.logo-project/);
    await expect(guard).toBeHidden();
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText(projectId ?? '');
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText(revision ?? '');
    await expect(page.locator('[data-customer-hook="width-mm"]')).toHaveValue('');
    expect(await isBeforeUnloadDirty(page)).toBe(true);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});

test('superseded pending file during save cannot install the older file', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    const originalId = await page.locator('[data-customer-hook="project-id"]').textContent();
    await setNumber(page, 'x-mm', 11);

    const olderBytes = await createEmptyReplacementPackage(new Uint8Array(prototype.projectBytes));
    const parsed = await parseProjectPackage(new Uint8Array(prototype.projectBytes), { sha256 });
    const newerProject = {
      ...parsed.project,
      projectId: 'SYN-PROJ-ASYNC-NEWER',
      configurations: parsed.project.configurations.map((configuration) => ({ ...configuration, placements: [] })),
    };
    delete (newerProject as { confirmation?: unknown }).confirmation;
    delete (newerProject as { review?: unknown }).review;
    const refAssets = parsed.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes }));
    const addAssets = parsed.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes }));
    const newerBytes = await createProjectPackage({ project: newerProject, assets: refAssets, additionalAssets: addAssets }, { sha256 });

    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'older pending.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(olderBytes),
    });
    const guard = page.locator('[data-customer-hook="unsaved-guard"]');
    await expect(guard).toBeVisible();

    await page.evaluate(() => {
      const deferred = { started: false, release: undefined as unknown as (() => void) | undefined };
      (window as unknown as { __deferredSaveDigest?: typeof deferred }).__deferredSaveDigest = deferred;
      const nativeDigest = SubtleCrypto.prototype.digest;
      Object.defineProperty(SubtleCrypto.prototype, 'digest', {
        configurable: true,
        writable: true,
        value: function (this: SubtleCrypto, algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
          deferred.started = true;
          return new Promise<ArrayBuffer>((resolveDigest, rejectDigest) => {
            deferred.release = () => {
              Object.defineProperty(SubtleCrypto.prototype, 'digest', { configurable: true, writable: true, value: nativeDigest });
              void nativeDigest.call(this, algorithm, data).then(resolveDigest, rejectDigest);
            };
          });
        },
      });
    });
    await page.locator('[data-customer-hook="unsaved-save"]').click();
    await page.waitForFunction(() => (window as unknown as { __deferredSaveDigest?: { started: boolean } }).__deferredSaveDigest?.started === true);

    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'newer pending.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from(newerBytes),
    });
    await expect(guard).toBeVisible();
    await expect(page.locator('[data-customer-hook="unsaved-guard-detail"]')).toContainText('newer pending.logo-project');

    await page.evaluate(() => {
      const deferred = (window as unknown as { __deferredSaveDigest?: { release?: () => void } }).__deferredSaveDigest;
      if (!deferred?.release) throw new Error('The delayed save digest was not ready.');
      deferred.release();
    });
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText(originalId ?? '');
    await expect(page.locator('[data-customer-hook="project-id"]')).not.toHaveText('SYN-PROJ-ASYNC-NEW');
    await expect(guard).toBeVisible();

    await page.locator('[data-customer-hook="unsaved-discard"]').click();
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-ASYNC-NEWER');
    await expect(guard).toBeHidden();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});


test('a guarded newer file supersedes an in-flight discarded replacement', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await openPage(page, prototype);
    await choosePackage(page, prototype.projectPath);
    const originalId = await page.locator('[data-customer-hook="project-id"]').textContent();
    await setNumber(page, 'x-mm', 11);
    await page.evaluate(() => {
      const nativeRead = File.prototype.arrayBuffer;
      Object.defineProperty(File.prototype, 'arrayBuffer', {
        configurable: true,
        value: function (this: File): Promise<ArrayBuffer> {
          if (this.name !== 'older slow.logo-project') return nativeRead.call(this);
          return new Promise((_resolve, reject) => {
            (window as unknown as { rejectOlderRead: () => void }).rejectOlderRead = () => reject(new Error('Older read failed'));
          });
        },
      });
    });
    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'older slow.logo-project', mimeType: 'application/zip', buffer: prototype.projectBytes,
    });
    await page.locator('[data-customer-hook="unsaved-discard"]').click();
    await page.waitForFunction(() => typeof (window as unknown as { rejectOlderRead?: unknown }).rejectOlderRead === 'function');
    await page.locator('[data-customer-hook="file-input"]').setInputFiles({
      name: 'newer waiting.logo-project', mimeType: 'application/zip', buffer: prototype.projectBytes,
    });
    await expect(page.locator('[data-customer-hook="unsaved-guard"]')).toBeVisible();
    await page.evaluate(async () => {
      (window as unknown as { rejectOlderRead: () => void }).rejectOlderRead();
      // Allow the rejected read and load catch to finish their microtasks.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('newer waiting.logo-project');
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText(originalId ?? '');
    expect(await isBeforeUnloadDirty(page)).toBe(true);
    await page.locator('[data-customer-hook="unsaved-keep"]').click();
    await expect(page.locator('[data-customer-hook="save"]')).toBeEnabled();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});


test('rounded dimension text preserves exact package values through linked edits and reopen', async ({ browser }) => {
  const prototype = await unpackPrototype();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    const parsed = await parseProjectPackage(new Uint8Array(prototype.projectBytes), { sha256 });
    const project = structuredClone(parsed.project);
    const placement = project.configurations[0]!.placements[0]!;
    placement.widthMm = 44.99999999999999;
    placement.heightMm = 30;
    delete project.confirmation;
    const assets = parsed.assets.filter(asset => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes }));
    const additionalAssets = parsed.assets.filter(asset => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes }));
    const bytes = await createProjectPackage({ project, assets, additionalAssets }, { sha256 });
    await openPage(page, prototype);
    await page.locator('[data-customer-hook="file-input"]').setInputFiles({ name: 'precision.logo-project', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
    await expect(page.locator('[data-customer-hook="project-id"]')).not.toHaveText('Not loaded');
    const width = page.locator('[data-customer-hook="width-mm"]');
    const height = page.locator('[data-customer-hook="height-mm"]');
    await expect(width).toHaveValue('45');
    await expect(page.locator('[data-customer-hook="mapping-status"]')).toContainText('Use the diagram to position and size your logo.');
    const instructions = (await page.locator('[data-customer-hook="placement-instructions"]').boundingBox())!;
    expect((await height.boundingBox())!.y).toBeLessThan(instructions.y);
    const ratio = placement.widthMm / placement.heightMm;
    await height.fill('20');
    await expect(width).toHaveValue('30');
    await height.press('Tab');
    await height.fill('30');
    await expect(width).toHaveValue('45');
    await height.press('Tab');
    const linked = await saveDownloadedFile(page, join(prototype.directory, 'linked.logo-project'), async () => {
      await revealCustomerControl(page, 'save');
      await page.locator('[data-customer-hook="save"]').click();
    });
    const linkedProject = (await parseProjectPackage(new Uint8Array(linked), { sha256 })).project;
    expect(linkedProject.configurations[0]!.placements[0]!.widthMm).toBe(30 * ratio);
    expect(linkedProject.configurations[0]!.placements[0]!.heightMm).toBe(30);

    await revealCustomerControl(page, 'ratio-lock');
    await page.locator('[data-customer-hook="ratio-lock"]').uncheck();
    const exactWidth = 15.123456789012345;
    const exactHeight = 0.00000001234567890123456;
    await setNumber(page, 'width-mm', exactWidth);
    await setNumber(page, 'height-mm', exactHeight);
    const path = join(prototype.directory, 'precise.logo-project');
    const precise = await saveDownloadedFile(page, path, async () => {
      await revealCustomerControl(page, 'save');
      await page.locator('[data-customer-hook="save"]').click();
    });
    const saved = (await parseProjectPackage(new Uint8Array(precise), { sha256 })).project;
    expect(saved.configurations[0]!.placements[0]!.widthMm).toBe(exactWidth);
    expect(saved.configurations[0]!.placements[0]!.heightMm).toBe(exactHeight);
    await page.locator('[data-customer-hook="file-input"]').setInputFiles(path);
    await expect(width).toHaveValue(String(Number(exactWidth.toPrecision(15))));
    await setNumber(page, 'x-mm', 1);
    const reopened = await saveDownloadedFile(page, join(prototype.directory, 'reopened.logo-project'), async () => {
      await revealCustomerControl(page, 'save');
      await page.locator('[data-customer-hook="save"]').click();
    });
    const reopenedProject = (await parseProjectPackage(new Uint8Array(reopened), { sha256 })).project;
    expect(reopenedProject.configurations[0]!.placements[0]!.widthMm).toBe(exactWidth);
    expect(reopenedProject.configurations[0]!.placements[0]!.heightMm).toBe(exactHeight);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(prototype.directory, { recursive: true, force: true });
  }
});
