// Build the single-entry Logo Station distribution.
//
// Single writer of the production station entry. All assembly logic lives in
// scripts/station-assembly.mjs (shared with the dev-only package-preview
// generator); this script only selects the station output location.
//
// Canonical output:
//   dist/station/Logo Station.html   THE single staff entry (inline IIFE,
//                                    file://-safe: no fetch/import of sibling
//                                    JSON/modules, no CDN/network).
// No assets/ folder: the station is fully inline (no runtime fetch under
// src/ui), so no support folder is shipped. Dev-only outputs are produced
// directly by their own generators under dist/dev/ (never mirrored here).
//
// Usage:
//   node scripts/build-station.mjs [--out <dir>]
//   STATION_DIR=<dir> node scripts/build-station.mjs
//
// --out / STATION_DIR writes ONLY the station entry into <dir> (used by the
// distribution-contract test and fresh-copy offline acceptance).
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  buildStationHtmlBytes,
  comparePaths,
  loadStationBrand,
} from './station-assembly.mjs';

const root = process.cwd();
const STATION_FILENAME = 'Logo Station.html';

const args = process.argv.slice(2);
let outDir = process.env.STATION_DIR;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--help' || arg === '-h') {
    console.log(
      'Usage: node scripts/build-station.mjs [--out <dir>]\n' +
        'Writes dist/station/Logo Station.html (or only the entry into <dir> with --out).',
    );
    process.exit(0);
  }
  if (arg === '--out' || arg === '--out-dir' || arg === '--station-dir') {
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a directory value.`);
    outDir = value;
    index += 1;
  } else if (arg.startsWith('--out=')) {
    outDir = arg.slice('--out='.length);
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}
const customOut = outDir !== undefined && outDir !== '';
const stationDir = resolve(root, customOut ? outDir : 'dist/station');

const brand = await loadStationBrand();
const { stationHtmlBytes } = await buildStationHtmlBytes(root, brand);
if (customOut) {
  await mkdir(stationDir, { recursive: true });
} else {
  // Recreate the station dir so the distribution tree is exact: one root
  // entry, no stale files from earlier builds.
  await rm(stationDir, { recursive: true, force: true });
  await mkdir(stationDir, { recursive: true });
}
const stationPath = join(stationDir, STATION_FILENAME);
await writeFile(stationPath, stationHtmlBytes);
console.log(`Station entry: ${stationPath} (${stationHtmlBytes.length} bytes)`);
if (!customOut) {
  const stationTree = await readdir(stationDir);
  console.log(`Station tree dist/station/: ${JSON.stringify(stationTree.sort(comparePaths))}`);
}
