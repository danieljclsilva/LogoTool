/**
 * Convert a validated inspector area-bundle export into a Builder-ready
 * prepared product definition (offline, local, no network).
 *
 * This is the documented local entrypoint from inspector calibration exports
 * to the Builder's prepared-product import: it runs the pure
 * `buildPreparedProductFromAreaBundle` kernel over an actual area-bundle
 * export plus explicit operator labels, so the Builder never has to trust a
 * hand-authored product file. Inputs must be produced from the real inspector
 * session (calibration/region-area exports); labels supply every product,
 * variant, frame and method identity — nothing is invented.
 *
 * PREREQUISITE: run `npm run build` first — this script imports the compiled
 * kernel from `dist/` and refuses to run against a missing build.
 *
 * Usage:
 *   node scripts/convert-area-bundle.mjs \
 *     --area-bundle <area-bundle.json> \
 *     --labels <bridge-labels.json> \
 *     --expected-asset-sha256 <64 hex chars> \
 *     --out <prepared-product.json>
 *
 * - `--area-bundle`: inspector area-bundle export JSON (exact bytes are
 *   verified by the kernel: envelope version + asset-hash match).
 * - `--labels`: `{ "labels": BridgeLabels }` — explicit product/variant/
 *   region labels; see `src/core/inspector-bridge/index.ts`.
 * - `--expected-asset-sha256`: full SHA-256 of the calibrated asset; must
 *   match the bundle's evidence hash exactly.
 * - `--out`: written `{ "product", "sidecar", "areaBundleText",
 *   "areaBundleSha256" }` — the exact file the Builder's prepared-product
 *   import accepts. `areaBundleText` decodes the VERBATIM source export text
 *   (strict UTF-8, fatal on malformed sequences; a leading BOM is supported
 *   explicitly and preserved) and `areaBundleSha256` its SHA-256, so original
 *   evidence (including named exclusion identities the canonical polygons
 *   cannot represent) travels byte-identically with the product instead of a
 *   re-serialized reduction. Anything that cannot round-trip byte-identically
 *   is rejected, never silently repaired.
 *
 * Safety: each input is `stat`-checked (regular file, pre-read size bound)
 * before reading; unknown, duplicated or valueless flags are usage errors;
 * `--out` must not alias any input and is created exclusively (`wx`, via an
 * atomic temp-file rename), so existing/source/label files are never
 * overwritten and no partial output is left behind.
 *
 * Bounded: inputs above 8 MiB are rejected before reading; the kernel
 * enforces its own envelope/version/hash/geometry limits and fails
 * atomically. The final envelope is additionally capped at the shared
 * `maxImportFileBytes` Builder intake bound (imported from the compiled core
 * alongside the evidence-text bound) and the evidence text at the shared
 * intake bound — oversized conversions are rejected with an actionable error
 * before the exclusive install. Deterministic: identical inputs yield
 * byte-identical output.
 *
 * Exit codes: 0 converted; 1 conversion rejected by the kernel; 2 usage or
 * filesystem error.
 */

import { createHash } from 'node:crypto';
import { link, open, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BOM = '\uFEFF';

const KNOWN_FLAGS = new Set(['--area-bundle', '--labels', '--expected-asset-sha256', '--out']);

function usage() {
  return [
    'usage: node scripts/convert-area-bundle.mjs --area-bundle <path> --labels <path>',
    '         --expected-asset-sha256 <hex> --out <path>',
    'Prerequisite: npm run build (imports the compiled kernel from dist/).',
  ].join('\n');
}

function failUsage(message) {
  console.error(`error: ${message}\n${usage()}`);
  process.exit(2);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) failUsage(`unexpected positional argument "${token}"`);
    const flag = token.split('=')[0];
    if (!KNOWN_FLAGS.has(flag)) failUsage(`unknown flag "${token}"`);
    if (Object.hasOwn(values, flag)) failUsage(`duplicate flag "${flag}"`);
    let value;
    if (token.includes('=')) {
      value = token.slice(flag.length + 1);
    } else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === '') failUsage(`flag "${flag}" requires a value`);
    values[flag] = value;
  }
  for (const flag of KNOWN_FLAGS) {
    if (!Object.hasOwn(values, flag)) failUsage(`missing required flag "${flag}"`);
  }
  return values;
}

/**
 * Decode UTF-8 bytes strictly, then JSON-parse. Decoding uses fatal:true
 * (malformed sequences throw instead of silently becoming U+FFFD) and
 * ignoreBOM:true (a leading BOM is preserved as U+FEFF rather than dropped),
 * so the returned text always re-encodes to the exact input bytes. A single
 * leading BOM is stripped ONLY for parsing — never from the returned text —
 * keeping the verbatim-source guarantee: TextEncoder(text) === input bytes.
 */
function decodeJsonBytes(bytes, what) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${what} is not valid UTF-8; refusing to convert lossy input`);
  }
  const parseText = text.startsWith(BOM) ? text.slice(1) : text;
  try {
    return { value: JSON.parse(parseText), text };
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

async function readBoundedFile(path, what) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new Error(`cannot stat ${what} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!info.isFile()) {
    throw new Error(`${what} at ${path} is not a regular file; refusing to read`);
  }
  if (info.size === 0 || info.size > MAX_INPUT_BYTES) {
    throw new Error(`${what} at ${path} is empty or exceeds ${MAX_INPUT_BYTES} bytes; rejected before reading`);
  }
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_INPUT_BYTES) {
      throw new Error(`${what} at ${path} grew beyond ${MAX_INPUT_BYTES} bytes while reading; rejected`);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!SHA256_HEX_PATTERN.test(args['--expected-asset-sha256'])) {
    failUsage('--expected-asset-sha256 must be 64 lowercase hex chars');
  }
  const areaBundlePath = resolve(args['--area-bundle']);
  const labelsPath = resolve(args['--labels']);
  const outPath = resolve(args['--out']);
  if (outPath === areaBundlePath || outPath === labelsPath) {
    console.error(`error: --out must not alias an input file (${outPath}); refusing to overwrite source evidence`);
    process.exit(2);
  }

  let kernel;
  let intakeLimits;
  try {
    const require = createRequire(import.meta.url);
    kernel = require('../dist/src/core/inspector-bridge/index.js');
    intakeLimits = require('../dist/src/core/project-builder/prepared-import.js').PREPARED_IMPORT_LIMITS;
  } catch (error) {
    console.error(`error: compiled kernel unavailable (run \`npm run build\` first): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  let areaBundleBytes;
  try {
    areaBundleBytes = await readBoundedFile(areaBundlePath, 'area bundle');
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  let areaBundle;
  let areaBundleText;
  try {
    const decoded = decodeJsonBytes(areaBundleBytes, 'area bundle');
    areaBundle = decoded.value;
    areaBundleText = decoded.text;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  let labelsFile;
  try {
    const labelsBytes = await readBoundedFile(labelsPath, 'labels file');
    labelsFile = decodeJsonBytes(labelsBytes, 'labels file').value;
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  if (typeof labelsFile !== 'object' || labelsFile === null || Array.isArray(labelsFile)) {
    console.error('error: labels file must be a JSON object with a "labels" property');
    process.exit(2);
  }
  if (typeof labelsFile.labels !== 'object' || labelsFile.labels === null || Array.isArray(labelsFile.labels)) {
    console.error('error: labels file must be a JSON object with a "labels" property');
    process.exit(2);
  }

  const outcome = kernel.buildPreparedProductFromAreaBundle(areaBundle, labelsFile.labels, {
    expectedAssetSha256: args['--expected-asset-sha256'],
  });
  if (!outcome.ok) {
    console.error(`conversion rejected: ${outcome.errors.map((error) => `${error.code} at ${error.path}: ${error.message}`).join('; ')}`);
    process.exit(1);
  }

  // Align the final envelope with what the Builder intake accepts (shared
  // exported limits, not a parallel local guess): the area-bundle text must
  // fit the intake evidence bound, and the whole envelope must fit the
  // Builder's prepared-import file bound. Reject cleanly BEFORE the exclusive
  // install so oversized conversions never leave output behind.
  if (areaBundleText.length > intakeLimits.maxAreaBundleChars) {
    console.error(`error: source evidence text is ${areaBundleText.length} chars, above the Builder intake bound of ${intakeLimits.maxAreaBundleChars}; split the bundle or shorten labels and re-export from the inspector`);
    process.exit(2);
  }
  const output = {
    product: outcome.product,
    sidecar: outcome.sidecar,
    areaBundleText,
    areaBundleSha256: createHash('sha256').update(areaBundleBytes).digest('hex'),
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  const maxEnvelopeBytes = intakeLimits.maxImportFileBytes;
  if (Buffer.byteLength(serialized, 'utf8') > maxEnvelopeBytes) {
    console.error(`error: converted envelope is ${Buffer.byteLength(serialized, 'utf8')} bytes, above the Builder prepared-import file bound of ${maxEnvelopeBytes}; split the bundle into fewer regions and convert each separately`);
    process.exit(2);
  }
  // Temp file lives next to the target; final install uses link() so an
  // output that appears concurrently is never overwritten: EEXIST means
  // refusal, and no partial output is ever left at the target path.
  const temporary = `${outPath}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  let outExists = false;
  try {
    await stat(outPath);
    outExists = true;
  } catch (error) {
    if (error instanceof Error && error.code !== 'ENOENT') {
      console.error(`error: cannot stat output ${outPath}: ${error.message}`);
      process.exit(2);
    }
  }
  if (outExists) {
    console.error(`error: refusing to overwrite existing output ${outPath}; remove it first or choose another path`);
    process.exit(2);
  }
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try {
      await handle.writeFile(serialized, 'utf8');
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, outPath);
    } catch (error) {
      if (error instanceof Error && error.code === 'EEXIST') {
        console.error(`error: refusing to overwrite existing output ${outPath}; remove it first or choose another path`);
      } else {
        console.error(`error: could not install output ${outPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await unlink(temporary);
      } catch {
        // Best effort: leave no partial output behind.
      }
      process.exit(2);
    }
    await unlink(temporary);
  } catch (error) {
    console.error(`error: could not write output ${outPath}: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await unlink(temporary);
    } catch {
      // Best effort: leave no partial output behind.
    }
    process.exit(2);
  }
  console.log(`wrote ${outPath}: product ${outcome.product.id}, ${outcome.product.regions.length} region(s), sidecar + verbatim original area bundle preserved`);
}

await main();
