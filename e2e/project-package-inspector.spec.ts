import { expect, test } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  PROJECT_PACKAGE_LIMITS,
  createProjectPackage,
  parseProjectPackage,
} from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { newRevision } from '../src/core/revisions.js';

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');

interface LocalPreview {
  directory: string;
  htmlPath: string;
  projectPath: string;
  emptyProjectPath: string;
  projectBytes: Buffer;
  emptyProjectBytes: Buffer;
}

async function unpackPreview(): Promise<LocalPreview> {
  const archive = await fs.readFile(resolve('dist/synthetic-package-transport-preview.zip'));
  const entries = unzipSync(archive);
  const names = Object.keys(entries);
  const htmlName = names.find((name) => name.endsWith('.html'));
  const projectName = names.find((name) => name.endsWith('.logo-project'));
  if (!htmlName || !projectName) throw new Error('Synthetic transport preview ZIP must contain its HTML and project package.');
  expect(names).toHaveLength(2);

  const directory = await fs.mkdtemp(join(tmpdir(), 'LogoTool package inspector with spaces '));
  const htmlPath = join(directory, 'standalone project inspector.html');
  const projectPath = join(directory, 'synthetic multi-project.logo-project');
  const emptyProjectPath = join(directory, 'synthetic zero-placement.logo-project');
  const projectBytes = Buffer.from(entries[projectName]!);
  const emptyProjectBytes = await fs.readFile(resolve('dist/synthetic-zero-placement.logo-project'));
  await Promise.all([
    fs.writeFile(htmlPath, Buffer.from(entries[htmlName]!)),
    fs.writeFile(projectPath, projectBytes),
    fs.writeFile(emptyProjectPath, emptyProjectBytes),
  ]);
  return { directory, htmlPath, projectPath, emptyProjectPath, projectBytes, emptyProjectBytes };
}

async function attachEnvironment(browser: Browser): Promise<void> {
  const info = test.info();
  await info.attach('project-package-inspector-environment', {
    contentType: 'application/json',
    body: JSON.stringify({
      os: process.platform,
      release: release(),
      arch: process.arch,
      browser: info.project.name,
      browserVersion: browser.version(),
      viewport: { width: 1280, height: 900 },
      offline: true,
      entryPoint: 'file://',
      scope: 'project-package inspector',
    }, null, 2),
  });
}

async function openOfflineInspector(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
  probe: { pageErrors: string[]; consoleErrors: string[]; httpRequests: string[] };
}> {
  await attachEnvironment(browser);
  const context = await browser.newContext({
    offline: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const probe = { pageErrors: [] as string[], consoleErrors: [] as string[], httpRequests: [] as string[] };
  page.on('pageerror', (error) => probe.pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') probe.consoleErrors.push(message.text());
  });
  context.on('request', (request) => {
    if (/^https?:/i.test(request.url())) probe.httpRequests.push(request.url());
  });
  return { context, page, probe };
}

async function dropPackage(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  await page.evaluate(({ base64, fileName }) => {
    const binary = atob(base64);
    const contents = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const file = new File([contents], fileName, { type: 'application/zip' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const target = document.querySelector<HTMLElement>('[data-package-hook="dropzone"]');
    if (!target) throw new Error('Missing project package drop target.');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { base64: Buffer.from(bytes).toString('base64'), fileName: name });
}

interface ControlledFileRead {
  started: boolean;
  release?: () => void;
}

interface DigestCompletion {
  expected: number;
  completed: number;
  complete: boolean;
}

async function dropControlledPackageRead(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  await page.evaluate(({ base64, fileName }) => {
    const binary = atob(base64);
    const contents = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const file = new File([contents], fileName, { type: 'application/zip' });
    const readState: ControlledFileRead = { started: false };
    (window as Window & { __controlledPackageRead?: ControlledFileRead }).__controlledPackageRead = readState;
    const nativeRead = File.prototype.arrayBuffer;
    const controlledRead: typeof File.prototype.arrayBuffer = function (this: File) {
      if (this.name !== fileName) return nativeRead.call(this);
      readState.started = true;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        readState.release = () => {
          Object.defineProperty(File.prototype, 'arrayBuffer', {
            configurable: true,
            writable: true,
            value: nativeRead,
          });
          void nativeRead.call(this).then(resolve, reject);
        };
      });
    };
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      writable: true,
      value: controlledRead,
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const target = document.querySelector<HTMLElement>('[data-package-hook="dropzone"]');
    if (!target) throw new Error('Missing project package drop target.');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { base64: Buffer.from(bytes).toString('base64'), fileName: name });
}

async function trackPackageDigestCompletion(page: Page, expectedDigests: number): Promise<void> {
  await page.evaluate((expected) => {
    const tracker: DigestCompletion = { expected, completed: 0, complete: false };
    (window as Window & { __obsoleteDigestCompletion?: DigestCompletion }).__obsoleteDigestCompletion = tracker;
    const nativeDigest = SubtleCrypto.prototype.digest;
    const trackedDigest: typeof SubtleCrypto.prototype.digest = function (this: SubtleCrypto, algorithm, data) {
      return nativeDigest.call(this, algorithm, data).then((digest) => {
        tracker.completed += 1;
        tracker.complete = tracker.completed === tracker.expected;
        return digest;
      });
    };
    Object.defineProperty(SubtleCrypto.prototype, 'digest', {
      configurable: true,
      writable: true,
      value: trackedDigest,
    });
  }, expectedDigests);
}

async function createMixedProjectPackage(local: LocalPreview): Promise<string> {
  const source = await parseProjectPackage(new Uint8Array(local.projectBytes), { sha256 });
  const emptiedConfiguration = source.project.configurations[0];
  if (!emptiedConfiguration) throw new Error('Synthetic multi-project fixture needs a configuration to clear.');
  const project = newRevision(source.project, (draft) => {
    const configuration = draft.configurations.find((candidate) => candidate.id === emptiedConfiguration.id);
    if (!configuration) throw new Error('Synthetic configuration disappeared during test fixture creation.');
    configuration.placements = [];
  });
  const bytes = await createProjectPackage({
    project,
    assets: source.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes: assetBytes }) => ({ path, bytes: assetBytes })),
    additionalAssets: source.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes: assetBytes }) => ({ path, bytes: assetBytes })),
  }, { sha256 });
  const filePath = join(local.directory, 'synthetic mixed-placement project.logo-project');
  await fs.writeFile(filePath, Buffer.from(bytes));
  return filePath;
}

async function dropOversizedPackage(page: Page, archiveLimit: number): Promise<void> {
  await page.evaluate((limit) => {
    const file = new File([new Uint8Array([0])], 'oversized.logo-project', { type: 'application/zip' });
    Object.defineProperty(file, 'size', { configurable: true, value: limit + 1 });
    (window as Window & { __oversizedFileReadCalled?: boolean }).__oversizedFileReadCalled = false;
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: () => {
        (window as Window & { __oversizedFileReadCalled?: boolean }).__oversizedFileReadCalled = true;
        return Promise.reject(new Error('Oversized file should not be read.'));
      },
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const target = document.querySelector<HTMLElement>('[data-package-hook="dropzone"]');
    if (!target) throw new Error('Missing project package drop target.');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, archiveLimit);
}

function expectOfflineClean(probe: { pageErrors: string[]; consoleErrors: string[]; httpRequests: string[] }): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.httpRequests).toEqual([]);
}

test('standalone transport preview opens offline, loads by chooser and drop, and round-trips the package', async ({ browser }) => {
  const local = await unpackPreview();
  const { context, page, probe } = await openOfflineInspector(browser);
  try {
    await page.goto(pathToFileURL(local.htmlPath).href);
    await expect(page).toHaveTitle(/Project Package Transport Preview/);
    await expect(page.getByText('Transport preview only — not a customer editor.')).toBeVisible();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-package-hook="choose"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(local.projectPath);
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    await expect(page.locator('[data-package-hook="project-revision"]')).toHaveText('3');
    await expect(page.locator('[data-package-hook="confirmation"]')).toContainText(/untrusted metadata only — not evidence of approval/i);
    await expect(page.locator('[data-package-hook="review"]')).toContainText(/Pending internal review/);
    await expect(page.locator('[data-package-hook="review"]')).toContainText(/untrusted metadata/);
    await expect(page.locator('[data-package-hook="placement-rows"] tr')).toHaveCount(3);
    await expect(page.locator('[data-package-hook="placement-rows"]')).toContainText('0 mm');
    await expect(page.locator('[data-package-hook="asset-rows"] tr')).toHaveCount(2);
    await expect(page.locator('#project-package-inspector img, #project-package-inspector svg, #project-package-inspector iframe, #project-package-inspector object, #project-package-inspector embed, #project-package-inspector canvas')).toHaveCount(0);

    const original = await parseProjectPackage(new Uint8Array(local.projectBytes), { sha256 });
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-package-hook="save"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('project-package.logo-project');
    const downloadedPath = await download.path();
    assert.ok(downloadedPath, 'Playwright should retain the downloaded package file.');
    const downloadedBytes = await fs.readFile(downloadedPath);
    expect(downloadedBytes).toEqual(local.projectBytes);
    const saved = await parseProjectPackage(new Uint8Array(downloadedBytes), { sha256 });
    expect(saved.project).toEqual(original.project);
    expect(saved.assets.map((asset) => ({ path: asset.path, kind: asset.kind }))).toEqual(
      original.assets.map((asset) => ({ path: asset.path, kind: asset.kind })),
    );
    for (let index = 0; index < original.assets.length; index += 1) {
      assert.deepEqual(saved.assets[index]?.bytes, original.assets[index]?.bytes);
    }
    const savedPath = join(local.directory, download.suggestedFilename());
    await fs.writeFile(savedPath, downloadedBytes);
    await page.locator('[data-package-hook="file-input"]').setInputFiles(savedPath);
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    await expect(page.locator('[data-package-hook="source-name"]')).toHaveText('project-package.logo-project');
    await expect(page.locator('[data-package-hook="placement-rows"] tr')).toHaveCount(3);
    await expect(page.locator('[data-package-hook="asset-rows"] tr')).toHaveCount(2);

    await dropPackage(page, new Uint8Array(local.projectBytes), 'dropped synthetic project.logo-project');
    await expect(page.locator('[data-package-hook="source-name"]')).toHaveText('dropped synthetic project.logo-project');
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(local.directory, { recursive: true, force: true });
  }
});

test('invalid and superseded asynchronous loads never replace a valid project', async ({ browser }) => {
  const local = await unpackPreview();
  const obsoleteAssetCount = (await parseProjectPackage(new Uint8Array(local.projectBytes), { sha256 })).assets.length;
  const { context, page, probe } = await openOfflineInspector(browser);
  try {
    await page.goto(pathToFileURL(local.htmlPath).href);
    await page.locator('[data-package-hook="file-input"]').setInputFiles(local.projectPath);
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    const currentSource = await page.locator('[data-package-hook="source-name"]').textContent();

    await page.locator('[data-package-hook="file-input"]').setInputFiles({
      name: 'broken.logo-project',
      mimeType: 'application/zip',
      buffer: Buffer.from('not a ZIP archive'),
    });
    await expect(page.locator('[data-package-hook="status"]')).toContainText(/Could not load broken\.logo-project/);
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    await expect(page.locator('[data-package-hook="source-name"]')).toHaveText(currentSource ?? '');

    await dropOversizedPackage(page, PROJECT_PACKAGE_LIMITS.maxArchiveBytes);
    await expect(page.locator('[data-package-hook="status"]')).toContainText(/exceeds the .*byte limit/);
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    expect(await page.evaluate(() => (window as Window & { __oversizedFileReadCalled?: boolean }).__oversizedFileReadCalled)).toBe(false);

    await dropControlledPackageRead(page, new Uint8Array(local.projectBytes), 'obsolete controlled project.logo-project');
    await page.waitForFunction(() => (window as Window & { __controlledPackageRead?: ControlledFileRead }).__controlledPackageRead?.started === true);
    await dropPackage(page, new Uint8Array(local.emptyProjectBytes), 'newest zero-placement project.logo-project');
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-EMPTY-001');
    await expect(page.locator('[data-package-hook="source-name"]')).toHaveText('newest zero-placement project.logo-project');

    await trackPackageDigestCompletion(page, obsoleteAssetCount);
    await page.evaluate(() => {
      const state = (window as Window & { __controlledPackageRead?: ControlledFileRead }).__controlledPackageRead;
      if (!state?.release) throw new Error('The controlled obsolete file read was not ready to release.');
      state.release();
    });
    await page.waitForFunction(() => (window as Window & { __obsoleteDigestCompletion?: DigestCompletion }).__obsoleteDigestCompletion?.complete === true);
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-EMPTY-001');
    await expect(page.locator('[data-package-hook="source-name"]')).toHaveText('newest zero-placement project.logo-project');
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(local.directory, { recursive: true, force: true });
  }
});

test('zero-placement configurations are named in empty and mixed projects', async ({ browser }) => {
  const local = await unpackPreview();
  const { context, page, probe } = await openOfflineInspector(browser);
  try {
    await page.goto(pathToFileURL(local.htmlPath).href);
    await page.locator('[data-package-hook="file-input"]').setInputFiles(local.emptyProjectPath);
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-EMPTY-001');
    await expect(page.locator('[data-package-hook="placement-empty"]')).toHaveText('No placements are defined in this project.');
    await expect(page.locator('[data-package-hook="placement-table"]')).toBeVisible();
    await expect(page.locator('[data-package-hook="placement-rows"] tr')).toHaveCount(1);
    const emptyConfiguration = page.locator('[data-package-hook="zero-placement-configuration"]');
    await expect(emptyConfiguration).toHaveCount(1);
    await expect(emptyConfiguration).toContainText('SYN-CFG-CAP-OS');
    await expect(emptyConfiguration).toContainText('Synthetic Cap (SYN-CAP-001) / One size (SYN-CAP-OS)');
    await expect(page.locator('[data-package-hook="confirmation"]')).toContainText(/None recorded/);
    await expect(page.locator('[data-package-hook="review"]')).toContainText(/Pending internal review/);

    const mixedProjectPath = await createMixedProjectPackage(local);
    await page.locator('[data-package-hook="file-input"]').setInputFiles(mixedProjectPath);
    await expect(page.locator('[data-package-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    await expect(page.locator('[data-package-hook="placement-rows"] tr')).toHaveCount(2);
    const mixedEmptyConfiguration = page.locator('[data-package-hook="zero-placement-configuration"]');
    await expect(mixedEmptyConfiguration).toHaveCount(1);
    await expect(mixedEmptyConfiguration).toContainText('SYN-CFG-TEE-M');
    await expect(mixedEmptyConfiguration).toContainText('Synthetic Tee (SYN-TEE-001) / Size M (SYN-TEE-M)');
    await expect(page.locator('[data-package-hook="placement-empty"]')).toBeHidden();
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(local.directory, { recursive: true, force: true });
  }
});
