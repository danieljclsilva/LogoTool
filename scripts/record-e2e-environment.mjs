import { chromium } from '@playwright/test';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { release, arch } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { experimentSettings } from './experiment-settings.mjs';
import { execFileSync } from 'node:child_process';

const project = process.argv[2];
const channels = { chromium: undefined, chrome: 'chrome', msedge: 'msedge' };
if (!Object.hasOwn(channels, project)) throw new Error(`Unsupported browser project ${project}`);
const directory = resolve('ci-evidence', project);
await mkdir(directory, { recursive: true });
const evidence = {
  project, shard: process.env.TEST_SHARD ?? '1/1', ...experimentSettings(), retries: 0, platform: process.platform, release: release(), arch: arch(),
  node: process.version, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workflowCommit: process.env.GITHUB_SHA ?? null,
  runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null,
  viewport: { width: 1280, height: 900 }, offline: true,
  entryPoint: 'file://…/dist/station/Logo%20Station.html',
  pageErrors: [], consoleErrors: [], httpRequests: [],
};
let browser;
try {
  browser = await chromium.launch({ channel: channels[project] });
  evidence.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: evidence.viewport, offline: true });
  context.on('request', request => {
    if (/^https?:/.test(request.url())) evidence.httpRequests.push(request.url());
  });
  const page = await context.newPage();
  page.on('pageerror', error => evidence.pageErrors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') evidence.consoleErrors.push(message.text());
  });
  await page.goto(pathToFileURL(resolve('dist/station/Logo Station.html')).href);
  await page.locator('[data-builder-hook="job-landing-create"]').waitFor();
  evidence.title = await page.title();
  evidence.webgl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return { supported: false };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const info = { supported: true, version: gl.getParameter(gl.VERSION),
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  });
  if (evidence.pageErrors.length || evidence.consoleErrors.length || evidence.httpRequests.length) {
    throw new Error('Offline entry reported errors or HTTP(S) requests. Inspect environment.json.');
  }
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed';
  evidence.error = String(error);
  throw error;
} finally {
  await writeFile(resolve(directory, 'environment.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### ${project} offline entry\n\n` +
      `Result **${evidence.result}**. Browser ${evidence.browserVersion ?? 'launch failed'}. ` +
      `OS ${evidence.platform} ${evidence.release}. Viewport 1280×900. Offline file entry.\n\n` +
      `Inspect the uploaded environment and Playwright results for each attempt.\n`);
  }
  await browser?.close();
}
