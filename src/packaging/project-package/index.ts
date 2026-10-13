/**
 * Provisional, data-only .logo-project ZIP transport.
 *
 * ZIP parsing first validates the complete classic (non-Zip64) central directory
 * and every local header, including all declared sizes and the archive-wide
 * budgets before allocating any decompressed file. Each DEFLATE stream is fed
 * to pinned fflate 0.8.2 `Inflate` in chunks of at most 64 compressed bytes.
 * Its fixed 32 KiB history and at most one incomplete stored block (65,535
 * data bytes plus a 5-byte header) mean one push can release at most
 * 65,535 + 64 * 1,032 = 131,583 bytes: a 258-byte length/distance pair
 * needs at least two input bits. fflate reserves at most another 128 KiB
 * beyond the current output position per match; with that reserve, its
 * temporary output slice, and the at-most-65,604-byte pending input, its
 * decoder-side transient allocation stays below 1 MiB per entry. Output is
 * written into a destination allocated only after the declared size has been
 * checked against the per-file and aggregate limits; the callback aborts
 * immediately if actual output exceeds that exact destination. Thus forged
 * ZIP sizes cannot cause a decompressor-sized allocation or evade the actual
 * output budget. Asset bytes are returned as inert bytes; this module never
 * interprets, executes, or renders them.
 */

import { deflateSync, Inflate } from "fflate";
import type { ProjectDocument, ValidationResult } from "../../core/types.js";
import { validateProject } from "../../core/validate.js";

export const PROJECT_PACKAGE_FORMAT_VERSION = "0.1.0-provisional" as const;
const PROJECT_PACKAGE_FORMAT = "logo-project" as const;

export const PROJECT_PACKAGE_LIMITS = Object.freeze({
  maxArchiveBytes: 48 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  maxAssetBytes: 16 * 1024 * 1024,
  maxTotalAssetBytes: 40 * 1024 * 1024,
  // Applies to all file output, including the manifest.
  maxTotalDecompressedBytes: 42 * 1024 * 1024,
  maxEntries: 256,
  maxPathBytes: 1024,
});

export interface ProjectPackageAssetInput {
  path: string;
  bytes: Uint8Array;
}

export interface ProjectPackageAsset {
  path: string;
  bytes: Uint8Array;
  kind: "referenced" | "additional";
}

export type ProjectPackageSha256 = (bytes: Uint8Array) => Promise<string>;

interface ManifestAsset {
  path: string;
  kind: "referenced" | "additional";
  size: number;
  sha256Hex: string;
}

interface ProjectPackageManifest {
  format: typeof PROJECT_PACKAGE_FORMAT;
  formatVersion: typeof PROJECT_PACKAGE_FORMAT_VERSION;
  project: ProjectDocument;
  assets: ManifestAsset[];
}

interface PreparedEntry {
  name: Uint8Array;
  method: 0 | 8;
  crc: number;
  compressed: Uint8Array;
  uncompressedSize: number;
  localOffset: number;
}

interface CentralEntry {
  path: string;
  name: Uint8Array;
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataOffset: number;
}

interface InflateInternals {
  p: Uint8Array;
  s: { f?: number; p?: number };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const UTF8_FLAG = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const CRC_TABLE = makeCrcTable();

function packageError(message: string): Error {
  return new Error(`project package: ${message}`);
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff]!;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Serialize JSON with sorted object keys while preserving every array order. */
function canonicalJson(value: unknown): string {
  const active = new WeakSet<object>();
  const visit = (item: unknown): string => {
    if (item === null) return "null";
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw packageError("project contains a non-finite number");
      return JSON.stringify(item) ?? "null";
    }
    if (typeof item !== "object") throw packageError("project contains a non-JSON value");
    if (active.has(item)) throw packageError("project contains a cycle");
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const ownKeys = Object.keys(item);
        if (ownKeys.length !== item.length) throw packageError("project contains a sparse or decorated array");
        const values = new Array<string>(item.length);
        for (let index = 0; index < item.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(item, index)) {
            throw packageError("project contains a sparse array");
          }
          values[index] = visit(item[index]);
        }
        return `[${values.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw packageError("project contains a non-plain object");
      }
      if (Object.getOwnPropertySymbols(item).length !== 0) {
        throw packageError("project contains symbol fields");
      }
      const keys = Object.keys(item).sort(compareText);
      const ownKeys = Reflect.ownKeys(item);
      if (ownKeys.length !== keys.length) throw packageError("project contains non-enumerable fields");
      const fields: string[] = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw packageError("project contains accessor fields");
        }
        fields.push(`${JSON.stringify(key)}:${visit(descriptor.value)}`);
      }
      return `{${fields.join(",")}}`;
    } finally {
      active.delete(item);
    }
  };
  return visit(value);
}

function validProject(value: unknown): asserts value is ProjectDocument {
  let result: ValidationResult;
  try {
    result = validateProject(value);
  } catch (error) {
    throw packageError(`project validation failed: ${errorMessage(error)}`);
  }
  if (!result.ok) {
    const detail = result.errors
      .slice(0, 8)
      .map((entry) => `${entry.path}: ${entry.message}`)
      .join("; ");
    throw packageError(`invalid project document${detail ? ` (${detail})` : ""}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function referencedAssets(project: ProjectDocument): Map<string, string | undefined> {
  const referenced = new Map<string, string | undefined>();
  for (const logo of project.logos) {
    for (const asset of logo.assets) {
      validatePortablePath(asset.uri);
      if (referenced.has(asset.uri)) {
        const previous = referenced.get(asset.uri);
        if (previous !== undefined && asset.sha256Hex !== undefined && previous !== asset.sha256Hex) {
          throw packageError(`project declares conflicting SHA-256 digests for shared asset "${asset.uri}"`);
        }
        if (previous === undefined && asset.sha256Hex !== undefined) referenced.set(asset.uri, asset.sha256Hex);
      } else {
        referenced.set(asset.uri, asset.sha256Hex);
      }
    }
  }
  return referenced;
}

function validatePortablePath(path: string, allowManifest = false): Uint8Array {
  if (typeof path !== "string" || path.length === 0) throw packageError("asset path must be a non-empty string");
  const name = encoder.encode(path);
  if (decoder.decode(name) !== path) throw packageError("asset path contains invalid Unicode");
  if (name.length > PROJECT_PACKAGE_LIMITS.maxPathBytes) {
    throw packageError(`asset path exceeds ${PROJECT_PACKAGE_LIMITS.maxPathBytes} UTF-8 bytes`);
  }
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("*") ||
    path.includes('"') ||
    path.includes("<") ||
    path.includes(">") ||
    path.includes("|") ||
    /%(?:2e|2f|5c|00|3a|3f|23|25)/iu.test(path) ||
    path.normalize("NFC") !== path ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(path)
  ) {
    throw packageError(`unsafe or non-portable asset path "${path}"`);
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === ".." || /[ .]$/u.test(segment)) {
      throw packageError(`unsafe or non-portable asset path "${path}"`);
    }
    const deviceBase = segment.split(".", 1)[0]!.toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(deviceBase)) {
      throw packageError(`asset path uses a reserved device name: "${path}"`);
    }
  }
  if (!allowManifest && path.toLowerCase() === "manifest.json") {
    throw packageError('asset path "manifest.json" is reserved for the package manifest');
  }
  return name;
}

function validatePathSet(paths: readonly string[], allowManifest = false): void {
  const folded = new Map<string, string>();
  const foldedNames = new Set<string>();
  for (const path of paths) {
    validatePortablePath(path, allowManifest && path === "manifest.json");
    const key = path.normalize("NFC").toLowerCase();
    const previous = folded.get(key);
    if (previous !== undefined) {
      throw packageError(`duplicate or case-insensitive-colliding asset paths "${previous}" and "${path}"`);
    }
    folded.set(key, path);
    foldedNames.add(key);
  }
  for (const path of paths) {
    const parts = path.toLowerCase().split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (foldedNames.has(parent)) {
        throw packageError(`asset file path collides with directory prefix "${parent}"`);
      }
    }
  }
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function canonicalManifest(project: ProjectDocument, assets: ManifestAsset[]): Uint8Array {
  const manifest: ProjectPackageManifest = {
    format: PROJECT_PACKAGE_FORMAT,
    formatVersion: PROJECT_PACKAGE_FORMAT_VERSION,
    project,
    assets,
  };
  const bytes = encoder.encode(canonicalJson(manifest));
  if (bytes.length > PROJECT_PACKAGE_LIMITS.maxManifestBytes) {
    throw packageError(`manifest exceeds ${PROJECT_PACKAGE_LIMITS.maxManifestBytes} bytes`);
  }
  return bytes;
}

function makeZip(entries: readonly { path: string; bytes: Uint8Array }[]): Uint8Array {
  const prepared: PreparedEntry[] = [];
  let totalUncompressed = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const deflated = deflateSync(entry.bytes, { level: 6 });
    const useDeflate = deflated.length < entry.bytes.length;
    const compressed = useDeflate ? deflated : entry.bytes;
    const method: 0 | 8 = useDeflate ? 8 : 0;
    totalUncompressed += entry.bytes.length;
    if (totalUncompressed > PROJECT_PACKAGE_LIMITS.maxTotalDecompressedBytes) {
      throw packageError("total uncompressed bytes exceed package limits");
    }
    prepared.push({
      name,
      method,
      crc: crc32(entry.bytes),
      compressed,
      uncompressedSize: entry.bytes.length,
      localOffset: 0,
    });
  }
  let localBytes = 0;
  let centralBytes = 0;
  for (const entry of prepared) {
    entry.localOffset = localBytes;
    localBytes += 30 + entry.name.length + entry.compressed.length;
    centralBytes += 46 + entry.name.length;
  }
  const totalBytes = localBytes + centralBytes + 22;
  if (totalBytes > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    throw packageError(`archive exceeds ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes} bytes`);
  }
  const output = new Uint8Array(totalBytes);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const entry of prepared) {
    writeU32(view, offset, LOCAL_SIGNATURE);
    writeU16(view, offset + 4, entry.method === 0 ? 10 : 20);
    writeU16(view, offset + 6, UTF8_FLAG);
    writeU16(view, offset + 8, entry.method);
    writeU16(view, offset + 10, DOS_TIME);
    writeU16(view, offset + 12, DOS_DATE);
    writeU32(view, offset + 14, entry.crc);
    writeU32(view, offset + 18, entry.compressed.length);
    writeU32(view, offset + 22, entry.uncompressedSize);
    writeU16(view, offset + 26, entry.name.length);
    writeU16(view, offset + 28, 0);
    output.set(entry.name, offset + 30);
    output.set(entry.compressed, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.compressed.length;
  }
  const centralOffset = offset;
  for (const entry of prepared) {
    writeU32(view, offset, CENTRAL_SIGNATURE);
    writeU16(view, offset + 4, 20);
    writeU16(view, offset + 6, entry.method === 0 ? 10 : 20);
    writeU16(view, offset + 8, UTF8_FLAG);
    writeU16(view, offset + 10, entry.method);
    writeU16(view, offset + 12, DOS_TIME);
    writeU16(view, offset + 14, DOS_DATE);
    writeU32(view, offset + 16, entry.crc);
    writeU32(view, offset + 20, entry.compressed.length);
    writeU32(view, offset + 24, entry.uncompressedSize);
    writeU16(view, offset + 28, entry.name.length);
    writeU16(view, offset + 30, 0);
    writeU16(view, offset + 32, 0);
    writeU16(view, offset + 34, 0);
    writeU16(view, offset + 36, 0);
    writeU32(view, offset + 38, 0x20);
    writeU32(view, offset + 42, entry.localOffset);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  writeU32(view, offset, END_SIGNATURE);
  writeU16(view, offset + 4, 0);
  writeU16(view, offset + 6, 0);
  writeU16(view, offset + 8, prepared.length);
  writeU16(view, offset + 10, prepared.length);
  writeU32(view, offset + 12, centralBytes);
  writeU32(view, offset + 16, centralOffset);
  writeU16(view, offset + 20, 0);
  return output;
}

/** Create a deterministic provisional `.logo-project` ZIP archive. */
export async function createProjectPackage(
  input: {
    project: unknown;
    assets: readonly ProjectPackageAssetInput[];
    additionalAssets?: readonly ProjectPackageAssetInput[];
  },
  options: { sha256: ProjectPackageSha256 },
): Promise<Uint8Array> {
  validProject(input.project);
  if (typeof options?.sha256 !== "function") throw packageError("a SHA-256 function is required");
  if (!Array.isArray(input.assets) || (input.additionalAssets !== undefined && !Array.isArray(input.additionalAssets))) {
    throw packageError("assets and additionalAssets must be arrays");
  }
  const project = JSON.parse(canonicalJson(input.project)) as ProjectDocument;
  const referenced = referencedAssets(project);
  const primary = input.assets;
  const additional = input.additionalAssets ?? [];
  if (primary.length !== referenced.size) {
    throw packageError(`referenced assets must contain exactly ${referenced.size} unique paths`);
  }
  if (primary.length + additional.length + 1 > PROJECT_PACKAGE_LIMITS.maxEntries) {
    throw packageError(`entry count exceeds ${PROJECT_PACKAGE_LIMITS.maxEntries}`);
  }
  const inputByPath = new Map<string, { input: ProjectPackageAssetInput; kind: "referenced" | "additional" }>();
  for (const asset of primary) {
    validatePortablePath(asset.path);
    if (referenced.has(asset.path)) {
      if (inputByPath.has(asset.path)) throw packageError(`duplicate asset input path "${asset.path}"`);
      inputByPath.set(asset.path, { input: asset, kind: "referenced" });
    } else {
      throw packageError(`unexpected referenced asset "${asset.path}"`);
    }
  }
  for (const path of referenced.keys()) {
    if (!inputByPath.has(path)) throw packageError(`missing referenced asset "${path}"`);
  }
  for (const asset of additional) {
    validatePortablePath(asset.path);
    if (inputByPath.has(asset.path)) throw packageError(`duplicate or colliding asset input path "${asset.path}"`);
    inputByPath.set(asset.path, { input: asset, kind: "additional" });
  }
  validatePathSet([...inputByPath.keys()]);

  let totalAssetBytes = 0;
  for (const { input: asset } of inputByPath.values()) {
    if (!(asset.bytes instanceof Uint8Array)) throw packageError(`asset "${asset.path}" bytes must be a Uint8Array`);
    if (asset.bytes.length > PROJECT_PACKAGE_LIMITS.maxAssetBytes) {
      throw packageError(`asset "${asset.path}" exceeds ${PROJECT_PACKAGE_LIMITS.maxAssetBytes} bytes`);
    }
    totalAssetBytes += asset.bytes.length;
    if (totalAssetBytes > PROJECT_PACKAGE_LIMITS.maxTotalAssetBytes) {
      throw packageError(`total asset bytes exceed ${PROJECT_PACKAGE_LIMITS.maxTotalAssetBytes}`);
    }
  }

  const assetSnapshots = [...inputByPath].map(([path, record]) => ({
    path,
    kind: record.kind,
    bytes: new Uint8Array(record.input.bytes),
  }));
  const manifestAssets: ManifestAsset[] = [];
  const packageEntries: { path: string; bytes: Uint8Array }[] = [];
  for (const record of assetSnapshots.sort((a, b) => compareText(a.path, b.path))) {
    const { path, kind, bytes } = record;
    let digest: string;
    try {
      digest = await options.sha256(bytes);
    } catch (error) {
      throw packageError(`SHA-256 failed for "${path}": ${errorMessage(error)}`);
    }
    if (!HEX_SHA256.test(digest)) throw packageError(`SHA-256 returned an invalid lowercase digest for "${path}"`);
    const expected = referenced.get(path);
    if (kind === "referenced" && expected !== undefined && expected !== digest) {
      throw packageError(`project asset digest does not match bytes for "${path}"`);
    }
    manifestAssets.push({ path, kind, size: bytes.length, sha256Hex: digest });
    packageEntries.push({ path, bytes });
  }
  const manifestBytes = canonicalManifest(project, manifestAssets);
  if (totalAssetBytes + manifestBytes.length > PROJECT_PACKAGE_LIMITS.maxTotalDecompressedBytes) {
    throw packageError(`total decompressed bytes exceed ${PROJECT_PACKAGE_LIMITS.maxTotalDecompressedBytes}`);
  }
  packageEntries.push({ path: "manifest.json", bytes: manifestBytes });
  packageEntries.sort((a, b) => compareText(a.path, b.path));
  return makeZip(packageEntries);
}

function parseZip(bytes: Uint8Array): CentralEntry[] {
  if (!(bytes instanceof Uint8Array)) throw packageError("archive bytes must be a Uint8Array");
  if (bytes.length > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    throw packageError(`archive exceeds ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes} bytes`);
  }
  if (bytes.length < 22) throw packageError("archive is truncated or not a ZIP file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = bytes.length - 22;
  if (readU32(view, eocdOffset) !== END_SIGNATURE) {
    throw packageError("ZIP end record is missing, has a comment, or has trailing data");
  }
  const diskNumber = readU16(view, eocdOffset + 4);
  const centralDisk = readU16(view, eocdOffset + 6);
  const entriesOnDisk = readU16(view, eocdOffset + 8);
  const entryCount = readU16(view, eocdOffset + 10);
  const centralSize = readU32(view, eocdOffset + 12);
  const centralOffset = readU32(view, eocdOffset + 16);
  const commentLength = readU16(view, eocdOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || commentLength !== 0) {
    throw packageError("multi-disk ZIP archives and ZIP comments are unsupported");
  }
  if (entryCount === 0 || entryCount > PROJECT_PACKAGE_LIMITS.maxEntries) {
    throw packageError(`entry count is invalid or exceeds ${PROJECT_PACKAGE_LIMITS.maxEntries}`);
  }
  if (centralOffset + centralSize !== eocdOffset || centralOffset > eocdOffset) {
    throw packageError("central directory bounds are invalid");
  }

  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  let totalAssets = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocdOffset || readU32(view, cursor) !== CENTRAL_SIGNATURE) {
      throw packageError("central directory entry is truncated or malformed");
    }
    const madeBy = readU16(view, cursor + 4);
    const versionNeeded = readU16(view, cursor + 6);
    const flags = readU16(view, cursor + 8);
    const methodValue = readU16(view, cursor + 10);
    const time = readU16(view, cursor + 12);
    const date = readU16(view, cursor + 14);
    const crc = readU32(view, cursor + 16);
    const compressedSize = readU32(view, cursor + 20);
    const uncompressedSize = readU32(view, cursor + 24);
    const nameLength = readU16(view, cursor + 28);
    const extraLength = readU16(view, cursor + 30);
    const entryCommentLength = readU16(view, cursor + 32);
    const diskStart = readU16(view, cursor + 34);
    const externalAttributes = readU32(view, cursor + 38);
    const localOffset = readU32(view, cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > eocdOffset) throw packageError("central directory variable fields exceed archive bounds");
    if (extraLength !== 0 || entryCommentLength !== 0) throw packageError("ZIP extra fields and per-file comments are unsupported");
    if (flags !== UTF8_FLAG) throw packageError("encrypted, descriptor-based, or non-UTF-8 ZIP entries are unsupported");
    if (methodValue !== 0 && methodValue !== 8) throw packageError(`unsupported ZIP compression method ${methodValue}`);
    const method = methodValue as 0 | 8;
    if (versionNeeded !== (method === 0 ? 10 : 20) || (madeBy & 0xff) > 20) {
      throw packageError("unsupported ZIP version or structure");
    }
    const hostOs = madeBy >>> 8;
    if (hostOs !== 0 && hostOs !== 3) throw packageError("unsupported ZIP host operating system");
    if (time !== DOS_TIME || date !== DOS_DATE) throw packageError("ZIP entries must use the canonical fixed timestamp");
    if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw packageError("multi-disk and ZIP64 entries are unsupported");
    }
    const dosAttributes = externalAttributes & 0xff;
    if ((dosAttributes & (0x08 | 0x10)) !== 0) throw packageError("directory and volume-label entries are unsupported");
    const unixMode = externalAttributes >>> 16;
    if (hostOs === 0 && unixMode !== 0) throw packageError("unsupported DOS entry attributes");
    if (hostOs === 3 && unixMode !== 0 && ((unixMode & 0xf000) !== 0x8000 || (unixMode & 0x7000) !== 0)) {
      throw packageError("symlinks and non-regular ZIP entries are unsupported");
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let path: string;
    try {
      path = decoder.decode(nameBytes);
    } catch {
      throw packageError("ZIP path is not valid UTF-8");
    }
    const reencoded = encoder.encode(path);
    if (!sameBytes(nameBytes, reencoded)) throw packageError("ZIP path is not canonical UTF-8");
    validatePortablePath(path, path === "manifest.json");
    if (index > 0 && compareText(entries[index - 1]!.path, path) >= 0) {
      throw packageError("ZIP entries are duplicate or not sorted by path");
    }
    if (uncompressedSize > (path === "manifest.json" ? PROJECT_PACKAGE_LIMITS.maxManifestBytes : PROJECT_PACKAGE_LIMITS.maxAssetBytes)) {
      throw packageError(`declared uncompressed size for "${path}" exceeds its limit`);
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw packageError(`stored ZIP entry "${path}" has mismatched sizes`);
    }
    if (method === 8 && compressedSize === 0) throw packageError(`deflated ZIP entry "${path}" has no compressed data`);
    totalUncompressed += uncompressedSize;
    if (path !== "manifest.json") totalAssets += uncompressedSize;
    if (totalAssets > PROJECT_PACKAGE_LIMITS.maxTotalAssetBytes) {
      throw packageError(`declared total asset bytes exceed ${PROJECT_PACKAGE_LIMITS.maxTotalAssetBytes}`);
    }
    if (totalUncompressed > PROJECT_PACKAGE_LIMITS.maxTotalDecompressedBytes) {
      throw packageError("declared total uncompressed bytes exceed package limits");
    }
    entries.push({ path, name: nameBytes, method, crc, compressedSize, uncompressedSize, localOffset, dataOffset: 0 });
    cursor = recordEnd;
  }
  if (cursor !== eocdOffset || cursor - centralOffset !== centralSize) {
    throw packageError("central directory count or size does not match its entries");
  }
  validatePathSet(entries.map((entry) => entry.path), true);
  if (!entries.some((entry) => entry.path === "manifest.json")) throw packageError('archive is missing "manifest.json"');

  let localCursor = 0;
  for (const entry of entries) {
    const offset = entry.localOffset;
    if (offset !== localCursor || offset + 30 > centralOffset || readU32(view, offset) !== LOCAL_SIGNATURE) {
      throw packageError(`local ZIP record for "${entry.path}" is missing, overlapping, or out of order`);
    }
    const versionNeeded = readU16(view, offset + 4);
    const flags = readU16(view, offset + 6);
    const method = readU16(view, offset + 8);
    const time = readU16(view, offset + 10);
    const date = readU16(view, offset + 12);
    const crc = readU32(view, offset + 14);
    const compressedSize = readU32(view, offset + 18);
    const uncompressedSize = readU32(view, offset + 22);
    const nameLength = readU16(view, offset + 26);
    const extraLength = readU16(view, offset + 28);
    const nameEnd = offset + 30 + nameLength;
    const dataOffset = nameEnd + extraLength;
    const recordEnd = dataOffset + compressedSize;
    if (extraLength !== 0 || recordEnd > centralOffset) throw packageError(`local ZIP record for "${entry.path}" has unsupported or out-of-bounds fields`);
    if (
      versionNeeded !== (entry.method === 0 ? 10 : 20) ||
      flags !== UTF8_FLAG ||
      method !== entry.method ||
      time !== DOS_TIME ||
      date !== DOS_DATE ||
      crc !== entry.crc ||
      compressedSize !== entry.compressedSize ||
      uncompressedSize !== entry.uncompressedSize
    ) {
      throw packageError(`local and central ZIP records disagree for "${entry.path}"`);
    }
    const localName = bytes.subarray(offset + 30, nameEnd);
    if (!sameBytes(localName, entry.name)) throw packageError(`local ZIP path disagrees for "${entry.path}"`);
    entry.dataOffset = dataOffset;
    localCursor = recordEnd;
  }
  if (localCursor !== centralOffset) throw packageError("local ZIP records do not exactly fill the data section");
  return entries;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function inflateEntry(bytes: Uint8Array, entry: CentralEntry): Uint8Array {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  const output = new Uint8Array(entry.uncompressedSize);
  if (entry.method === 0) {
    output.set(compressed);
  } else {
    let written = 0;
    const inflater = new Inflate((chunk) => {
      if (chunk.length > output.length - written) {
        throw packageError(`actual decompressed size for "${entry.path}" exceeds its declared limit`);
      }
      output.set(chunk, written);
      written += chunk.length;
    });
    try {
      for (let offset = 0; offset < compressed.length; offset += 64) {
        const end = Math.min(offset + 64, compressed.length);
        inflater.push(compressed.subarray(offset, end), end === compressed.length);
      }
      const internals = inflater as unknown as InflateInternals;
      if (internals.s.f !== 1) throw packageError(`deflate stream for "${entry.path}" has no final block`);
      if (internals.p.length > 1) throw packageError(`deflate stream for "${entry.path}" contains trailing compressed bytes`);
      if (written !== output.length) {
        throw packageError(`actual decompressed size for "${entry.path}" does not match its declaration`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("project package:")) throw error;
      throw packageError(`invalid deflate stream for "${entry.path}": ${errorMessage(error)}`);
    }
  }
  if (crc32(output) !== entry.crc) throw packageError(`CRC-32 mismatch for "${entry.path}"`);
  return output;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw packageError(`${label} has missing or unknown fields`);
  }
}

function parseManifest(bytes: Uint8Array): ProjectPackageManifest {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw packageError("manifest is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw packageError(`manifest JSON is malformed: ${errorMessage(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw packageError("manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest["format"] !== PROJECT_PACKAGE_FORMAT) {
    throw packageError(`unsupported or missing package format "${String(manifest["format"])}"`);
  }
  exactObjectKeys(manifest, ["format", "formatVersion", "project", "assets"], "manifest");
  if (manifest["formatVersion"] !== PROJECT_PACKAGE_FORMAT_VERSION) {
    throw packageError(`unsupported package format version "${String(manifest["formatVersion"])}"`);
  }
  if (!Array.isArray(manifest["assets"])) throw packageError("manifest assets index must be an array");
  if (manifest["assets"].length + 1 > PROJECT_PACKAGE_LIMITS.maxEntries) {
    throw packageError(`manifest asset count exceeds ${PROJECT_PACKAGE_LIMITS.maxEntries - 1}`);
  }
  const assets: ManifestAsset[] = [];
  for (const item of manifest["assets"]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw packageError("manifest asset index entries must be objects");
    }
    const record = item as Record<string, unknown>;
    exactObjectKeys(record, ["path", "kind", "size", "sha256Hex"], "manifest asset index entry");
    if (typeof record["path"] !== "string") throw packageError("manifest asset path must be a string");
    if (record["kind"] !== "referenced" && record["kind"] !== "additional") {
      throw packageError(`manifest asset "${record["path"]}" has an invalid kind`);
    }
    if (!Number.isSafeInteger(record["size"]) || (record["size"] as number) < 0) {
      throw packageError(`manifest asset "${record["path"]}" has an invalid size`);
    }
    if (typeof record["sha256Hex"] !== "string" || !HEX_SHA256.test(record["sha256Hex"])) {
      throw packageError(`manifest asset "${record["path"]}" has an invalid SHA-256 digest`);
    }
    validatePortablePath(record["path"]);
    assets.push({
      path: record["path"],
      kind: record["kind"],
      size: record["size"] as number,
      sha256Hex: record["sha256Hex"],
    });
  }
  for (let index = 1; index < assets.length; index++) {
    if (compareText(assets[index - 1]!.path, assets[index]!.path) >= 0) {
      throw packageError("manifest assets are duplicate or not sorted by path");
    }
  }
  validatePathSet(assets.map((asset) => asset.path));
  const project = manifest["project"];
  validProject(project);
  const canonical = encoder.encode(canonicalJson({
    format: manifest["format"],
    formatVersion: manifest["formatVersion"],
    project,
    assets: manifest["assets"],
  }));
  if (!sameBytes(canonical, bytes)) throw packageError("manifest JSON is not canonical");
  return {
    format: PROJECT_PACKAGE_FORMAT,
    formatVersion: PROJECT_PACKAGE_FORMAT_VERSION,
    project,
    assets,
  };
}

/** Parse and validate a package without interpreting or rendering its assets. */
export async function parseProjectPackage(
  bytes: Uint8Array,
  options: { sha256: ProjectPackageSha256 },
): Promise<{ project: ProjectDocument; assets: ProjectPackageAsset[] }> {
  if (typeof options?.sha256 !== "function") throw packageError("a SHA-256 function is required");
  const entries = parseZip(bytes);
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const manifestEntry = entriesByPath.get("manifest.json");
  if (!manifestEntry) throw packageError('archive is missing "manifest.json"');
  const manifestBytes = inflateEntry(bytes, manifestEntry);
  if (manifestBytes.length > PROJECT_PACKAGE_LIMITS.maxManifestBytes) {
    throw packageError(`manifest exceeds ${PROJECT_PACKAGE_LIMITS.maxManifestBytes} bytes`);
  }
  const manifest = parseManifest(manifestBytes);
  const referenced = referencedAssets(manifest.project);
  const manifestPaths = new Set<string>();
  for (const asset of manifest.assets) {
    manifestPaths.add(asset.path);
    const archiveEntry = entriesByPath.get(asset.path);
    if (!archiveEntry) throw packageError(`archive is missing indexed asset "${asset.path}"`);
    if (archiveEntry.uncompressedSize !== asset.size) {
      throw packageError(`declared size mismatch for asset "${asset.path}"`);
    }
    const isReferenced = referenced.has(asset.path);
    if ((asset.kind === "referenced") !== isReferenced) {
      throw packageError(`asset kind does not match project references for "${asset.path}"`);
    }
  }
  for (const path of referenced.keys()) {
    if (!manifestPaths.has(path)) throw packageError(`manifest is missing referenced asset "${path}"`);
  }
  for (const path of entriesByPath.keys()) {
    if (path !== "manifest.json" && !manifestPaths.has(path)) {
      throw packageError(`archive contains unindexed asset "${path}"`);
    }
  }
  if (manifest.assets.length !== entries.length - 1) {
    throw packageError("archive and manifest asset entry counts do not match");
  }

  const assets: ProjectPackageAsset[] = [];
  for (const asset of manifest.assets) {
    const entry = entriesByPath.get(asset.path)!;
    const assetBytes = inflateEntry(bytes, entry);
    let digest: string;
    try {
      digest = await options.sha256(assetBytes);
    } catch (error) {
      throw packageError(`SHA-256 failed for "${asset.path}": ${errorMessage(error)}`);
    }
    if (!HEX_SHA256.test(digest) || digest !== asset.sha256Hex) {
      throw packageError(`SHA-256 mismatch for asset "${asset.path}"`);
    }
    const declaredProjectDigest = referenced.get(asset.path);
    if (asset.kind === "referenced" && declaredProjectDigest !== undefined && declaredProjectDigest !== digest) {
      throw packageError(`project asset digest does not match bytes for "${asset.path}"`);
    }
    assets.push({ path: asset.path, bytes: assetBytes, kind: asset.kind });
  }
  return { project: manifest.project, assets };
}
