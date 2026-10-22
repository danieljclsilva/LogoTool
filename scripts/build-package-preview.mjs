// Dev-only package preview generator: developer/test utilities, synthetic
// fixtures and customer-format reference builds. Writes ONLY under dist/dev/
// (never the station distribution, never legacy dist-root pages).
//
// Station assembly (embedded editor/reviewer markers, catalogue, brand mark)
// lives in scripts/station-assembly.mjs and is shared with the production
// station generator — this script consumes buildInlineHtml() for the two
// dev-only customer reference pages and performs no station construction.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { createProjectPackage } from '../dist/src/packaging/project-package/index.js';
import { createSelfContainedHtml } from '../dist/src/packaging/self-contained-html/index.js';
import {
  buildInlineHtml,
  comparePaths,
  loadStationBrand,
} from './station-assembly.mjs';

const root = process.cwd();
const devDir = resolve(root, 'dist/dev');
const bundled = await build({
  entryPoints: ['src/ui/project-package-inspector/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
  minify: true,
  legalComments: 'inline',
});
const template = await readFile(
  'src/ui/project-package-inspector/template.html',
  'utf8',
);
const marker = '<!-- APP_SCRIPT -->';
if (template.split(marker).length !== 2) {
  throw new Error('Project package inspector template must contain one APP_SCRIPT marker');
}
const inlineScript = bundled.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = template.replace(marker, () => inlineScript);
const htmlBytes = new TextEncoder().encode(html);
const brand = await loadStationBrand();
const customerHtmlBytes = await buildInlineHtml(
  'src/ui/customer-editor/main.ts',
  'src/ui/customer-editor/template.html',
  'customer editor',
  brand,
);
const returnReviewHtmlBytes = await buildInlineHtml(
  'src/ui/customer-return-review/main.ts',
  'src/ui/customer-return-review/template.html',
  'customer return review',
  brand,
);

const sha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
const project = JSON.parse(
  await readFile('examples/projects/project-multi.project.json', 'utf8'),
);
const referencedPaths = new Set(
  project.logos.flatMap((logo) => logo.assets.map((asset) => asset.uri)),
);
const assets = await Promise.all(
  [...referencedPaths].sort(comparePaths).map(async (assetPath) => {
    if (!assetPath.startsWith('logos/') || assetPath.includes('..') || assetPath.includes('\\')) {
      throw new Error(`Unexpected synthetic fixture asset path: ${assetPath}`);
    }
    return {
      path: assetPath,
      bytes: new Uint8Array(await readFile(resolve(root, 'examples', assetPath))),
    };
  }),
);
const projectPackage = await createProjectPackage(
  { project, assets },
  { sha256 },
);
const issuedProject = structuredClone(project);
issuedProject.revision = 1;
issuedProject.description = 'Synthetic authored issue clone. Confirmation and internal review history were deliberately reset before customer handoff.';
delete issuedProject.confirmation;
delete issuedProject.review;
delete issuedProject.history;
delete issuedProject.reviewHistory;
delete issuedProject.issuedBaselineHash;
const issuedProjectPackage = await createProjectPackage(
  { project: issuedProject, assets },
  { sha256 },
);
const zeroProject = JSON.parse(
  await readFile('examples/projects/project-empty.project.json', 'utf8'),
);
const zeroProjectPackage = await createProjectPackage(
  { project: zeroProject, assets: [] },
  { sha256 },
);
const selfContainedHtmlBytes = await createSelfContainedHtml({
  html: customerHtmlBytes,
  projectPackage: issuedProjectPackage,
});

await mkdir(devDir, { recursive: true });
await writeFile(resolve(devDir, 'project-package-inspector.html'), htmlBytes);
await writeFile(resolve(devDir, 'synthetic-zero-placement.logo-project'), zeroProjectPackage);
await writeFile(resolve(devDir, 'customer-configurator.html'), customerHtmlBytes);
await writeFile(resolve(devDir, 'synthetic-customer-self-contained.html'), selfContainedHtmlBytes);
await writeFile(resolve(devDir, 'customer-return-review.html'), returnReviewHtmlBytes);
await writeFile(resolve(devDir, 'trusted-issued.logo-project'), issuedProjectPackage);
const hybridEntries = [
  ['OPEN_LOGO_CONFIGURATOR.html', htmlBytes],
  ['SYNTHETIC_PACKAGE_TRANSPORT_PREVIEW.logo-project', projectPackage],
].sort(([left], [right]) => comparePaths(left, right));
const hybridZip = zipSync(Object.fromEntries(hybridEntries), {
  level: 6,
  mtime: new Date(2000, 0, 1, 0, 0, 0),
});
await writeFile(resolve(devDir, 'synthetic-package-transport-preview.zip'), hybridZip);
const customerHybridEntries = [
  ['customer-configurator.html', customerHtmlBytes],
  ['SYNTHETIC-CUSTOMER.logo-project', issuedProjectPackage],
].sort(([left], [right]) => comparePaths(left, right));
const customerHybridZip = zipSync(Object.fromEntries(customerHybridEntries), {
  level: 6,
  mtime: new Date(2000, 0, 1, 0, 0, 0),
});
await writeFile(resolve(devDir, 'synthetic-customer-prototype.zip'), customerHybridZip);
console.log(
  'Built dev-only dist/dev transport preview, inline synthetic customer editor/reviewer, self-contained customer HTML, hybrid customer prototype ZIP, and trusted issued baseline.',
);
