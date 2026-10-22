import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Stages the public-safe demo: the built single-entry station HTML,
// byte-for-byte, as a Pages-ready directory holding EXACTLY index.html +
// .nojekyll. Rebuilds the output directory clean on every run so stale
// generated files can never leak into a deployment.
//
// Usage: node scripts/prepare-demo.mjs [stationHtmlPath] [outDir]
// Defaults: dist/station/Logo Station.html -> dist/demo.
// Reads only the given station file; writes only inside outDir. Never
// touches private/, user files, or any other dist output.
const root = process.cwd();
const stationPath = resolve(root, process.argv[2] ?? 'dist/station/Logo Station.html');
const outDir = resolve(root, process.argv[3] ?? 'dist/demo');

// rm -rf on an arbitrary output could wipe the working tree, so refuse
// dangerous destinations BEFORE touching anything: the working directory
// itself, the repository root or anything above it, and any directory
// containing the station source being copied. Comparisons use path.relative
// (no hardcoded separators, no '//' prefix bugs) over both the lexical and
// the symlink-resolved (realpath) forms of each path, so /var vs
// /private/var aliases cannot smuggle an ancestor past the guard.
const existingForms = (p) => {
  const forms = new Set([p]);
  try {
    forms.add(realpathSync(p));
  } catch {
    // May not exist yet (the output directory is created later).
  }
  return [...forms];
};
const containsOrEqual = (dir, candidate) => {
  const rel = relative(dir, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const outForms = existingForms(outDir);
const rootForms = existingForms(root);
const stationForms = existingForms(stationPath);
if (outForms.some((o) => rootForms.some((r) => o === r))) {
  throw new Error(`Refusing: output directory ${outDir} is the working directory.`);
}
if (outForms.some((o) => rootForms.some((r) => containsOrEqual(o, r)))) {
  throw new Error(`Refusing: output directory ${outDir} is or contains the repository.`);
}
if (outForms.some((o) => stationForms.some((s) => containsOrEqual(o, s)))) {
  throw new Error(`Refusing: output directory ${outDir} contains the station source.`);
}

const stationBytes = await readFile(stationPath).catch((error) => {
  throw new Error(
    `Demo staging needs the built station entry at ${stationPath} ` +
    `(run "npm run build:station" first): ${error instanceof Error ? error.message : String(error)}`,
  );
});
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'index.html'), stationBytes);
await writeFile(resolve(outDir, '.nojekyll'), '');

const names = (await readdir(outDir)).sort();
if (names.length !== 2 || names[0] !== '.nojekyll' || names[1] !== 'index.html') {
  throw new Error(`Demo staging produced an unexpected tree: ${JSON.stringify(names)}`);
}
const staged = await readFile(resolve(outDir, 'index.html'));
if (!staged.equals(stationBytes)) {
  throw new Error('Demo staging byte mismatch: dist/demo/index.html differs from the station entry');
}
const sha256 = createHash('sha256').update(staged).digest('hex').slice(0, 12);
console.log(`Staged demo dist/demo/ (index.html ${staged.length} bytes, sha256:${sha256}): ["index.html", ".nojekyll"].`);
