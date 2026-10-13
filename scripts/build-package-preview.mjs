import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { createProjectPackage } from '../dist/src/packaging/project-package/index.js';

const root = process.cwd();
const outputDir = resolve(root, 'dist');
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
const zeroProject = JSON.parse(
  await readFile('examples/projects/project-empty.project.json', 'utf8'),
);
const zeroProjectPackage = await createProjectPackage(
  { project: zeroProject, assets: [] },
  { sha256 },
);

await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'project-package-inspector.html'), htmlBytes);
await writeFile(resolve(outputDir, 'synthetic-zero-placement.logo-project'), zeroProjectPackage);
const hybridEntries = [
  ['OPEN_LOGO_CONFIGURATOR.html', htmlBytes],
  ['SYNTHETIC_PACKAGE_TRANSPORT_PREVIEW.logo-project', projectPackage],
].sort(([left], [right]) => comparePaths(left, right));
const hybridZip = zipSync(Object.fromEntries(hybridEntries), {
  level: 6,
  mtime: new Date(2000, 0, 1, 0, 0, 0),
});
await writeFile(resolve(outputDir, 'synthetic-package-transport-preview.zip'), hybridZip);
console.log(
  'Built ignored dist/project-package-inspector.html, synthetic-zero-placement.logo-project, and synthetic-package-transport-preview.zip (transport preview; not a customer editor).',
);

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
