import { expect, test } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import type { ProjectDocument } from '../src/core/types.js';
import {
  PROJECT_PACKAGE_LIMITS,
  createProjectPackage,
  parseProjectPackage,
} from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import {
  MAX_EMBEDDED_PROJECT_BASE64_CHARS,
  EMBEDDED_PROJECT_MARKER,
  EMBEDDED_PROJECT_SCRIPT_ID,
  createSelfContainedHtml,
  extractEmbeddedProjectPackage,
} from '../src/packaging/self-contained-html/index.js';

const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
const SELF_CONTAINED_ENTRY = 'synthetic-customer-self-contained.html';
const CUSTOMER_HTML_ENTRY = 'customer-configurator.html';

declare global {
  interface Window {
    __deferredDigestState?: { started: () => boolean; completed: () => boolean; release: () => void };
  }
}

interface Probe {
  pageErrors: string[];
  consoleErrors: string[];
  networkRequests: string[];
}

async function copyArtifactToTemp(): Promise<{ directory: string; htmlPath: string }> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'LogoTool self-contained customer '));
  const htmlPath = join(directory, 'synthetic customer self-contained.html');
  await fs.copyFile(resolve('dist', SELF_CONTAINED_ENTRY), htmlPath);
  return { directory, htmlPath };
}

async function openOfflineEditor(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<{
  context: BrowserContext;
  page: Page;
  probe: Probe;
}> {
  await test.info().attach('self-contained-environment', {
    contentType: 'application/json',
    body: JSON.stringify({ os: process.platform, release: release(), arch: process.arch,
      browser: test.info().project.name, browserVersion: browser.version(), viewport,
      offline: true, entryPoint: 'file://', prototype: 'synthetic self-contained editor' }, null, 2),
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

async function choosePackage(page: Page, path: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-customer-hook="choose"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path);
  await expect(page.locator('[data-customer-hook="project-id"]')).not.toHaveText('Not loaded');
}

async function dropPackage(page: Page, bytes: Uint8Array, fileName: string): Promise<void> {
  await page.evaluate(({ base64, name }) => {
    const binary = atob(base64);
    const data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], name, { type: 'application/zip' }));
    const target = document.querySelector<HTMLElement>('[data-customer-hook="dropzone"]');
    if (!target) throw new Error('Missing customer package drop target.');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { base64: Buffer.from(bytes).toString('base64'), name: fileName });
  await expect(page.locator('[data-customer-hook="status"]')).toContainText(`Loaded ${fileName}`);
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

async function captureBothViewports(page: Page, info: TestInfo): Promise<void> {
  const directory = info.outputPath('self-contained-customer-screenshots');
  await fs.mkdir(directory, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#customer-editor h1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const desktopPath = join(directory, 'self-contained-1280x900.png');
  await page.screenshot({ path: desktopPath, fullPage: true });
  await info.attach('self-contained-desktop', { path: desktopPath, contentType: 'image/png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const mobilePath = join(directory, 'self-contained-390x844.png');
  await page.screenshot({ path: mobilePath, fullPage: true });
  await info.attach('self-contained-mobile', { path: mobilePath, contentType: 'image/png' });
  await info.attach('self-contained-viewport-evidence', { contentType: 'application/json',
    body: JSON.stringify({ viewports: [{ width: 1280, height: 900 }, { width: 390, height: 844 }], offline: true }) });
  await page.setViewportSize({ width: 1280, height: 900 });
}

function expectOfflineClean(probe: Probe): void {
  expect(probe.pageErrors).toEqual([]);
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.networkRequests).toEqual([]);
}

async function setNumber(page: Page, hook: string, value: number): Promise<void> {
  await page.locator(`[data-customer-hook="${hook}"]`).fill(String(value));
}

async function readProjectJson(name: string): Promise<ProjectDocument> {
  const text = await fs.readFile(resolve('examples', 'projects', `${name}.project.json`), 'utf8');
  return JSON.parse(text) as ProjectDocument;
}

async function buildSelfContainedFromProject(
  project: ProjectDocument,
  assets: { path: string; bytes: Uint8Array }[],
): Promise<Uint8Array> {
  const projectPackage = await createProjectPackage({ project, assets }, { sha256 });
  const htmlBytes = await fs.readFile(resolve('dist', CUSTOMER_HTML_ENTRY));
  return createSelfContainedHtml({ html: htmlBytes, projectPackage });
}

async function createReplacementPackage(sourceBytes: Uint8Array, projectId: string): Promise<Uint8Array> {
  const parsed = await parseProjectPackage(sourceBytes, { sha256 });
  const project = structuredClone(parsed.project) as ProjectDocument;
  project.projectId = projectId;
  delete project.confirmation;
  delete project.review;
  delete project.history;
  delete project.reviewHistory;
  delete project.issuedBaselineHash;
  const references = parsed.assets
    .filter((asset) => asset.kind === 'referenced')
    .map(({ path, bytes }) => ({ path, bytes }));
  const additional = parsed.assets
    .filter((asset) => asset.kind === 'additional')
    .map(({ path, bytes }) => ({ path, bytes }));
  return createProjectPackage({ project, assets: references, additionalAssets: additional }, { sha256 });
}

async function createMalformedSelfContained(variant: 'invalid-base64' | 'invalid-package' | 'oversized' | 'duplicate'): Promise<Uint8Array> {
  const htmlBytes = await fs.readFile(resolve('dist', CUSTOMER_HTML_ENTRY));
  const html = htmlBytes.toString('utf8');
  const payload = variant === 'oversized' ? 'A'.repeat(MAX_EMBEDDED_PROJECT_BASE64_CHARS + 4)
    : variant === 'invalid-base64' ? '!!!!'
    : Buffer.from('not a valid logo-project package').toString('base64');
  const replacement = `<script id="${EMBEDDED_PROJECT_SCRIPT_ID}" type="application/x-logo-project">${payload}</script>`;
  const outputHtml = html.replace(EMBEDDED_PROJECT_MARKER, variant === 'duplicate' ? replacement + replacement : replacement);
  return Buffer.from(outputHtml);
}

test('auto-loads the exact embedded project, revision, and asset count', async ({ browser }, info) => {
  const { directory, htmlPath } = await copyArtifactToTemp();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    expect(await fs.readdir(directory)).toEqual(['synthetic customer self-contained.html']);
    await page.goto(pathToFileURL(htmlPath).href);
    await expect(page).toHaveTitle(/Synthetic Customer Editor/);
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText('1');
    await expect(page.locator('[data-customer-hook="asset-count"]')).toHaveText('2');
    await expect(page.locator('[data-customer-hook="status"]')).toContainText('Loaded embedded-issued.logo-project');
    await expect(page.locator('[data-customer-hook="configuration"] option')).toHaveCount(2);
    const draftPath = join(directory, 'initial draft.logo-project');
    const savedBytes = await saveDownloadedFile(page, draftPath, () => page.locator('[data-customer-hook="save"]').click());
    const issuedBytes = await fs.readFile(resolve('dist/trusted-issued.logo-project'));
    const embeddedBytes = extractEmbeddedProjectPackage(await fs.readFile(htmlPath));
    expect(Buffer.from(embeddedBytes!)).toEqual(issuedBytes);
    const saved = await parseProjectPackage(savedBytes, { sha256 });
    const issued = await parseProjectPackage(issuedBytes, { sha256 });
    expect(saved).toEqual(issued);
    await captureBothViewports(page, info);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('edit, confirm, save, and reopen round-trips values through the embedded package', async ({ browser }) => {
  const { directory, htmlPath } = await copyArtifactToTemp();
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await page.goto(pathToFileURL(htmlPath).href);
    await expect(page).toHaveTitle(/Synthetic Customer Editor/);
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText('1');
    await expect(page.locator('[data-customer-hook="asset-count"]')).toHaveText('2');

    await setNumber(page, 'x-mm', 4);
    await setNumber(page, 'y-mm', 12);
    await setNumber(page, 'width-mm', 76);
    await setNumber(page, 'height-mm', 38);
    await setNumber(page, 'rotation', 15);
    await page.locator('[data-customer-hook="placement-instructions"]').fill('Keep the seam clear.');
    await page.locator('[data-customer-hook="instructions"]').fill('Self-contained edit instructions.');
    await page.locator('[data-customer-hook="update"]').click();
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText('2');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 4 mm, 12 mm');

    await page.locator('[data-customer-hook="confirmed-by"]').fill('self-contained reviewer');
    await page.locator('[data-customer-hook="confirm"]').click();
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('Current confirmation');

    const savedPath = join(directory, 'self-contained return.logo-project');
    const savedBytes = await saveDownloadedFile(page, savedPath, async () => {
      await page.locator('[data-customer-hook="submit"]').click();
    });

    const saved = await parseProjectPackage(new Uint8Array(savedBytes), { sha256 });
    expect(saved.project.projectId).toBe('SYN-PROJ-MULTI-001');
    expect(saved.project.revision).toBe(2);
    expect(saved.project.instructions).toBe('Self-contained edit instructions.');
    expect(saved.project.confirmation?.revision).toBe(2);
    const issuedBytes = await fs.readFile(resolve('dist/trusted-issued.logo-project'));
    const issued = await parseProjectPackage(issuedBytes, { sha256 });
    expect(saved.assets).toEqual(issued.assets);
    expect(saved.project.products).toEqual(issued.project.products);
    expect(saved.project.logos).toEqual(issued.project.logos);
    const reviewedConfiguration = saved.project.configurations.find((configuration) => configuration.id === 'SYN-CFG-TEE-M');
    expect(reviewedConfiguration?.placements[0]?.instructions).toBe('Keep the seam clear.');
    expect(reviewedConfiguration?.placements[0]?.pos).toEqual({ xMm: 4, yMm: 12 });
    expect(reviewedConfiguration?.placements[0]?.widthMm).toBe(76);
    expect(reviewedConfiguration?.placements[0]?.heightMm).toBe(38);
    expect(reviewedConfiguration?.placements[0]?.rotationDeg).toBe(15);

    await page.locator('[data-customer-hook="file-input"]').setInputFiles(savedPath);
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-MULTI-001');
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText('2');
    await expect(page.locator('[data-customer-hook="confirmation"]')).toContainText('Current confirmation');
    await expect(page.locator('[data-customer-hook="review"]')).toContainText('Center: 4 mm, 12 mm');
    await expect(page.locator('[data-customer-hook="instructions"]')).toHaveValue('Self-contained edit instructions.');

    const reviewPage = await context.newPage();
    reviewPage.on('pageerror', (error) => probe.pageErrors.push(String(error)));
    reviewPage.on('console', (message) => { if (message.type() === 'error') probe.consoleErrors.push(message.text()); });
    await reviewPage.goto(pathToFileURL(resolve('dist/customer-return-review.html')).href);
    await reviewPage.locator('[data-review-hook="baseline-file"]').setInputFiles(resolve('dist/trusted-issued.logo-project'));
    await expect(reviewPage.locator('[data-review-hook="status"]')).toContainText('Loaded baseline');
    await reviewPage.locator('[data-review-hook="return-file"]').setInputFiles(savedPath);
    await expect(reviewPage.locator('[data-review-hook="confirmation"]')).toContainText('Current for revision 2');
    await expect(reviewPage.locator('[data-review-hook="geometry"]')).toContainText('Valid:');
    await expect(reviewPage.locator('[data-review-hook="revisions"]')).toHaveText('1 / 2');
    await reviewPage.close();

    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('zero-placement self-contained HTML loads with no placements and usable chooser', async ({ browser }, info) => {
  const project = await readProjectJson('project-empty');
  const html = await buildSelfContainedFromProject(project, []);
  const directory = await fs.mkdtemp(join(tmpdir(), 'LogoTool zero placement self-contained '));
  const htmlPath = join(directory, 'zero placement.html');
  await fs.writeFile(htmlPath, html);
  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await page.goto(pathToFileURL(htmlPath).href);
    await expect(page).toHaveTitle(/Synthetic Customer Editor/);
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-EMPTY-001');
    await expect(page.locator('[data-customer-hook="revision"]')).toHaveText('1');
    await expect(page.locator('[data-customer-hook="asset-count"]')).toHaveText('0');
    await expect(page.locator('[data-customer-hook="configuration"] option')).toHaveCount(1);
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveCount(1);
    await expect(page.locator('[data-customer-hook="placement"] option')).toHaveText('No placements');
    await expect(page.locator('[data-customer-hook="canvas"] polygon.safe-area')).toHaveCount(1);
    await expect(page.locator('[data-customer-hook="canvas"] polygon.footprint')).toHaveCount(0);
    await expect(page.locator('[data-customer-hook="choose"]')).toBeVisible();
    await captureBothViewports(page, info);
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('malformed embedded data shows a useful error and leaves the chooser usable', async ({ browser }) => {
  for (const variant of ['invalid-base64', 'invalid-package', 'oversized', 'duplicate'] as const) {
    const html = await createMalformedSelfContained(variant);
    const directory = await fs.mkdtemp(join(tmpdir(), `LogoTool malformed self-contained ${variant} `));
    const htmlPath = join(directory, 'malformed.html');
    await fs.writeFile(htmlPath, html);
    const { context, page, probe } = await openOfflineEditor(browser);
    try {
      await page.goto(pathToFileURL(htmlPath).href);
      await expect(page).toHaveTitle(/Synthetic Customer Editor/);
      if (variant === 'duplicate') {
        await expect(page.locator('[data-customer-hook="status"]')).toContainText('invalid or duplicated');
      } else if (variant === 'oversized') {
        await expect(page.locator('[data-customer-hook="status"]')).toContainText('exceeds archive size limit');
      } else if (variant === 'invalid-base64') {
        await expect(page.locator('[data-customer-hook="status"]')).toContainText('could not be decoded');
      } else {
        await expect(page.locator('[data-customer-hook="status"]')).toContainText('Could not load embedded-issued.logo-project');
      }
      await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('Not loaded');
      await expect(page.locator('[data-customer-hook="choose"]')).toBeEnabled();
      await choosePackage(page, resolve('dist/trusted-issued.logo-project'));
      await expect(page.locator('[data-customer-hook="status"]')).toContainText('Loaded trusted-issued.logo-project');
      expectOfflineClean(probe);
    } finally {
      await context.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('oversized embedded data is rejected by the packaging boundary and never shipped', async () => {
  const htmlBytes = await fs.readFile(resolve('dist', CUSTOMER_HTML_ENTRY));
  const oversized = new Uint8Array(PROJECT_PACKAGE_LIMITS.maxArchiveBytes + 1);
  expect(() => createSelfContainedHtml({ html: htmlBytes, projectPackage: oversized })).toThrow(
    new RegExp(`exceeds ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes} bytes`),
  );

  const artifact = await fs.readFile(resolve('dist', SELF_CONTAINED_ENTRY));
  const extracted = extractEmbeddedProjectPackage(artifact);
  expect(extracted).not.toBeNull();
  expect(extracted!.length).toBeLessThanOrEqual(PROJECT_PACKAGE_LIMITS.maxArchiveBytes);
});

test('deterministic obsolete startup replacement wins over a delayed embedded digest', async ({ browser }) => {
  const { directory, htmlPath } = await copyArtifactToTemp();
  const artifactBytes = await fs.readFile(resolve('dist', SELF_CONTAINED_ENTRY));
  const issuedBytes = extractEmbeddedProjectPackage(artifactBytes);
  assert.ok(issuedBytes, 'The shipped self-contained artifact must contain an embedded package.');
  const replacementBytes = await createReplacementPackage(issuedBytes, 'SYN-PROJ-REPLACEMENT-001');

  const { context, page, probe } = await openOfflineEditor(browser);
  try {
    await page.addInitScript(`
      const nativeDigest = SubtleCrypto.prototype.digest;
      let deferredResolve = null;
      let started = false;
      let completed = false;
      let calls = 0;
      SubtleCrypto.prototype.digest = function (...args) {
        calls += 1;
        if (calls !== 2) return nativeDigest.apply(this, args);
        started = true;
        const { promise, resolve, reject } = Promise.withResolvers();
        deferredResolve = () => {
          Object.defineProperty(SubtleCrypto.prototype, 'digest', { configurable: true, writable: true, value: nativeDigest });
          nativeDigest.apply(this, args).then((value) => { resolve(value); completed = true; }, reject);
        };
        return promise;
      };
      window.__deferredDigestState = {
        started: () => started,
        completed: () => completed,
        release: () => { if (deferredResolve) deferredResolve(); },
      };
    `);
    await page.goto(pathToFileURL(htmlPath).href);
    await expect(page).toHaveTitle(/Synthetic Customer Editor/);
    await page.waitForFunction(() => window.__deferredDigestState?.started() === true);
    await dropPackage(page, replacementBytes, 'replacement logo-project.logo-project');
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-REPLACEMENT-001');
    await page.evaluate(() => window.__deferredDigestState?.release());
    await page.waitForFunction(() => window.__deferredDigestState?.completed() === true);
    await expect(page.locator('[data-customer-hook="project-id"]')).toHaveText('SYN-PROJ-REPLACEMENT-001');
    expectOfflineClean(probe);
  } finally {
    await context.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
