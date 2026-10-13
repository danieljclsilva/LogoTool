import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "fflate";
import type { ProjectDocument } from "../src/core/types.js";
import {
  PROJECT_PACKAGE_FORMAT_VERSION,
  PROJECT_PACKAGE_LIMITS,
  createProjectPackage,
  parseProjectPackage,
  type ProjectPackageAssetInput,
} from "../src/packaging/project-package/index.js";

const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const sha256 = async (bytes: Uint8Array): Promise<string> => hashBytes(bytes);

function readProject(): ProjectDocument {
  const text = readFileSync(
    new URL("../../examples/projects/project-multi.project.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as ProjectDocument;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectWithMatchingAssetDigests(): ProjectDocument {
  const project = readProject();
  for (const logo of project.logos) {
    const ref = logo.assets[0]!;
    ref.sha256Hex = hashBytes(readBytes(ref.uri));
  }
  return project;
}

function readBytes(path: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../../examples/${path}`, import.meta.url)),
  );
}

function referencedInputs(project: ProjectDocument): ProjectPackageAssetInput[] {
  const paths = new Set(project.logos.flatMap((logo) => logo.assets.map((asset) => asset.uri)));
  return [...paths].sort().map((path) => ({ path, bytes: readBytes(path) }));
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

interface TestAssetIndex {
  path: string;
  kind: "referenced" | "additional";
  size: number;
  sha256Hex: string;
}

interface TestManifest {
  format: string;
  formatVersion: string;
  project: ProjectDocument;
  assets: TestAssetIndex[];
}

interface ZipFixtureEntry {
  path: string;
  bytes: Uint8Array;
  method?: 0 | 8;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function buildZip(entries: readonly ZipFixtureEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const prepared = sorted.map((entry) => {
    const name = new TextEncoder().encode(entry.path);
    const deflated = entry.method === 8 ? deflateSync(entry.bytes, { level: 6 }) : entry.bytes;
    const method = entry.method ?? 0;
    return {
      name,
      bytes: entry.bytes,
      compressed: deflated,
      method,
      crc: crc32(entry.bytes),
      localOffset: 0,
    };
  });
  let localSize = 0;
  let centralSize = 0;
  for (const entry of prepared) {
    entry.localOffset = localSize;
    localSize += 30 + entry.name.length + entry.compressed.length;
    centralSize += 46 + entry.name.length;
  }
  const archive = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(archive.buffer);
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value >>> 0, true);
  let offset = 0;
  for (const entry of prepared) {
    u32(offset, 0x04034b50);
    u16(offset + 4, entry.method === 0 ? 10 : 20);
    u16(offset + 6, 0x0800);
    u16(offset + 8, entry.method);
    u16(offset + 10, 0);
    u16(offset + 12, 0x21);
    u32(offset + 14, entry.crc);
    u32(offset + 18, entry.compressed.length);
    u32(offset + 22, entry.bytes.length);
    u16(offset + 26, entry.name.length);
    u16(offset + 28, 0);
    archive.set(entry.name, offset + 30);
    archive.set(entry.compressed, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.compressed.length;
  }
  const centralOffset = offset;
  for (const entry of prepared) {
    u32(offset, 0x02014b50);
    u16(offset + 4, 20);
    u16(offset + 6, entry.method === 0 ? 10 : 20);
    u16(offset + 8, 0x0800);
    u16(offset + 10, entry.method);
    u16(offset + 12, 0);
    u16(offset + 14, 0x21);
    u32(offset + 16, entry.crc);
    u32(offset + 20, entry.compressed.length);
    u32(offset + 24, entry.bytes.length);
    u16(offset + 28, entry.name.length);
    u16(offset + 30, 0);
    u16(offset + 32, 0);
    u16(offset + 34, 0);
    u16(offset + 36, 0);
    u32(offset + 38, 0x20);
    u32(offset + 42, entry.localOffset);
    archive.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  u32(offset, 0x06054b50);
  u16(offset + 4, 0);
  u16(offset + 6, 0);
  u16(offset + 8, prepared.length);
  u16(offset + 10, prepared.length);
  u32(offset + 12, centralSize);
  u32(offset + 16, centralOffset);
  u16(offset + 20, 0);
  return archive;
}

function rawPackage(
  project: ProjectDocument,
  files: readonly ProjectPackageAssetInput[],
  options: {
    manifest?: Partial<TestManifest>;
    manifestBytes?: Uint8Array;
    extraArchiveFiles?: readonly ZipFixtureEntry[];
    deflatedPaths?: ReadonlySet<string>;
  } = {},
): Uint8Array {
  const assets: TestAssetIndex[] = files.map((file) => ({
    path: file.path,
    kind: project.logos.some((logo) => logo.assets.some((asset) => asset.uri === file.path))
      ? "referenced"
      : "additional",
    size: file.bytes.length,
    sha256Hex: hashBytes(file.bytes),
  }));
  const manifest: TestManifest = {
    format: "logo-project",
    formatVersion: PROJECT_PACKAGE_FORMAT_VERSION,
    project,
    assets,
    ...options.manifest,
  };
  const manifestBytes = options.manifestBytes ?? new TextEncoder().encode(canonicalJson(manifest));
  const zipEntries: ZipFixtureEntry[] = [
    { path: "manifest.json", bytes: manifestBytes, method: options.deflatedPaths?.has("manifest.json") ? 8 : 0 },
    ...files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      method: options.deflatedPaths?.has(file.path) ? 8 as const : 0 as const,
    })),
    ...(options.extraArchiveFiles ?? []),
  ];
  return buildZip(zipEntries);
}

interface EntryOffsets {
  central: number;
  local: number;
  name: number;
  nameLength: number;
}

function entryOffsets(archive: Uint8Array, path: string): EntryOffsets {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  const entryCount = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  for (let index = 0; index < entryCount; index++) {
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameOffset = cursor + 46;
    const name = new TextDecoder().decode(archive.subarray(nameOffset, nameOffset + nameLength));
    if (name === path) {
      return {
        central: cursor,
        local: view.getUint32(cursor + 42, true),
        name: nameOffset,
        nameLength,
      };
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`missing ZIP fixture entry ${path}`);
}

function mutate(archive: Uint8Array, action: (copy: Uint8Array, entry: EntryOffsets) => void, path = "manifest.json"): Uint8Array {
  const copy = new Uint8Array(archive);
  action(copy, entryOffsets(copy, path));
  return copy;
}

function setEntryU32(archive: Uint8Array, path: string, centralField: number, localField: number, value: number): Uint8Array {
  return mutate(archive, (copy, entry) => {
    const view = new DataView(copy.buffer);
    view.setUint32(entry.central + centralField, value >>> 0, true);
    view.setUint32(entry.local + localField, value >>> 0, true);
  }, path);
}


describe("provisional .logo-project ZIP transport", () => {
  it("creates deterministic binary ZIPs and round-trips all project and physical bytes exactly", async () => {
    const project = projectWithMatchingAssetDigests();
    project.history = [{
      revision: 2,
      digest: "a".repeat(64),
      confirmedBy: "synthetic-prior-customer",
      confirmedAt: "2025-12-31T00:00:00.000Z",
    }];
    project.reviewHistory = [{
      revision: 2,
      digest: "b".repeat(64),
      decision: "changesRequested",
      reviewer: "synthetic-prior-reviewer",
      at: "2025-12-31T01:00:00.000Z",
      note: "Synthetic historical review.",
    }];
    const assets = referencedInputs(project);
    const additionalAssets = [{ path: "notes/synthetic.txt", bytes: new TextEncoder().encode("synthetic-only note") }];
    const first = await createProjectPackage({ project, assets, additionalAssets }, { sha256 });
    const second = await createProjectPackage({ project, assets, additionalAssets }, { sha256 });
    assert.deepEqual(first, second);
    assert.equal(new DataView(first.buffer, first.byteOffset).getUint32(0, true), 0x04034b50);

    const result = await parseProjectPackage(first, { sha256 });
    assert.deepEqual(result.project, project);
    assert.deepEqual(result.assets.map(({ path, kind }) => ({ path, kind })), [
      { path: "logos/syn-mark-a.svg", kind: "referenced" },
      { path: "logos/syn-mark-b.svg", kind: "referenced" },
      { path: "notes/synthetic.txt", kind: "additional" },
    ]);
    for (const asset of result.assets) {
      const source = [...assets, ...additionalAssets].find((candidate) => candidate.path === asset.path)!;
      assert.deepEqual(asset.bytes, source.bytes);
    }
    assert.deepEqual(result.project.confirmation, project.confirmation);
    assert.deepEqual(result.project.review, project.review);
    assert.deepEqual(result.project.history, project.history);
    assert.deepEqual(result.project.reviewHistory, project.reviewHistory);
  });
  it("snapshots project and asset bytes before awaiting the injected hasher", async () => {
    const project = projectWithMatchingAssetDigests();
    const originalProject = clone(project);
    const assets = referencedInputs(project);
    const originalAssets = assets.map((asset) => ({ path: asset.path, bytes: new Uint8Array(asset.bytes) }));
    let mutateCallerInputs = true;
    const mutatingHasher = async (bytes: Uint8Array): Promise<string> => {
      if (mutateCallerInputs) {
        mutateCallerInputs = false;
        project.description = "changed while package hashing was pending";
        for (const asset of assets) {
          if (asset.bytes.length > 0) asset.bytes[0] = asset.bytes[0]! ^ 0xff;
        }
      }
      await Promise.resolve();
      return hashBytes(bytes);
    };
    const archive = await createProjectPackage({ project, assets }, { sha256: mutatingHasher });
    const result = await parseProjectPackage(archive, { sha256 });
    assert.deepEqual(result.project, originalProject);
    assert.notEqual(project.description, originalProject.description);
    for (const asset of result.assets) {
      const original = originalAssets.find((candidate) => candidate.path === asset.path)!;
      assert.deepEqual(asset.bytes, original.bytes);
    }
  });
  it("round-trips valid projects with no referenced assets", async () => {
    const project = JSON.parse(
      readFileSync(
        new URL("../../examples/projects/project-empty.project.json", import.meta.url),
        "utf8",
      ),
    ) as ProjectDocument;
    const archive = await createProjectPackage({ project, assets: [] }, { sha256 });
    const result = await parseProjectPackage(archive, { sha256 });
    assert.deepEqual(result.project, project);
    assert.deepEqual(result.assets, []);
  });
  it("requires the exact unique referenced set and rejects duplicate, unexpected, or colliding inputs", async () => {
    const project = projectWithMatchingAssetDigests();
    const assets = referencedInputs(project);
    const sharedProject = projectWithMatchingAssetDigests();
    sharedProject.logos[1]!.assets[0]!.uri = sharedProject.logos[0]!.assets[0]!.uri;
    await assert.rejects(
      createProjectPackage({ project: sharedProject, assets: referencedInputs(sharedProject) }, { sha256 }),
      /conflicting SHA-256 digests/,
    );
    await assert.rejects(createProjectPackage({ project, assets: assets.slice(1) }, { sha256 }), /missing|exactly/);
    await assert.rejects(
      createProjectPackage({ project, assets: [...assets, assets[0]!] }, { sha256 }),
      /exactly|duplicate/,
    );
    await assert.rejects(
      createProjectPackage({ project, assets: assets.map((asset) => ({ ...asset, path: "unexpected.svg" })) }, { sha256 }),
      /unexpected|duplicate/,
    );
    await assert.rejects(
      createProjectPackage({ project, assets, additionalAssets: [{ path: assets[0]!.path.toUpperCase(), bytes: new Uint8Array() }] }, { sha256 }),
      /colliding|duplicate|case-insensitive/,
    );
    await assert.rejects(
      createProjectPackage({ project, assets, additionalAssets: [{ path: "../private.svg", bytes: new Uint8Array() }] }, { sha256 }),
      /unsafe|portable/,
    );
  });

  it("rejects invalid, unknown, and dangling domain data without rewriting the project", async () => {
    const assets = referencedInputs(projectWithMatchingAssetDigests());
    const unknown = projectWithMatchingAssetDigests() as ProjectDocument & { internalFlag?: boolean };
    unknown.internalFlag = true;
    await assert.rejects(createProjectPackage({ project: unknown, assets }, { sha256 }), /invalid project/);

    const dangling = projectWithMatchingAssetDigests();
    dangling.configurations[0]!.productId = "SYN-UNKNOWN-PRODUCT";
    await assert.rejects(createProjectPackage({ project: dangling, assets: referencedInputs(dangling) }, { sha256 }), /invalid project/);

    const badPath = projectWithMatchingAssetDigests();
    badPath.logos[0]!.assets[0]!.uri = "../escape.svg";
    await assert.rejects(createProjectPackage({ project: badPath, assets: [{ path: "../escape.svg", bytes: new Uint8Array() }, assets[1]!] }, { sha256 }), /unsafe|portable/);
  });

  it("rejects malformed, non-canonical, wrong-version, and invalid-domain manifests", async () => {
    const project = projectWithMatchingAssetDigests();
    const files = referencedInputs(project);

    await assert.rejects(
      parseProjectPackage(rawPackage(project, files, { manifestBytes: new TextEncoder().encode("{" ) }), { sha256 }),
      /malformed/,
    );
    const manifest: TestManifest = {
      format: "logo-project",
      formatVersion: PROJECT_PACKAGE_FORMAT_VERSION,
      project,
      assets: files.map((file) => ({
        path: file.path,
        kind: "referenced",
        size: file.bytes.length,
        sha256Hex: hashBytes(file.bytes),
      })),
    };
    const nonCanonical = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    await assert.rejects(parseProjectPackage(rawPackage(project, files, { manifestBytes: nonCanonical }), { sha256 }), /not canonical/);
    const duplicateKey = new TextEncoder().encode(`{"format":"logo-project","formatVersion":"${PROJECT_PACKAGE_FORMAT_VERSION}","formatVersion":"${PROJECT_PACKAGE_FORMAT_VERSION}","project":${canonicalJson(project)},"assets":[]}`);
    await assert.rejects(parseProjectPackage(rawPackage(project, files, { manifestBytes: duplicateKey }), { sha256 }), /not canonical/);
    await assert.rejects(
      parseProjectPackage(rawPackage(project, files, { manifest: { formatVersion: "9.9.9" } }), { sha256 }),
      /version/,
    );
    const wrongFormat = rawPackage(project, files, { manifest: { format: "unrecognized" } });
    await assert.rejects(parseProjectPackage(wrongFormat, { sha256 }), /format/);
    const missingFormat = rawPackage(project, files, {
      manifestBytes: new TextEncoder().encode(canonicalJson({
        formatVersion: PROJECT_PACKAGE_FORMAT_VERSION,
        project,
        assets: manifest.assets,
      })),
    });
    await assert.rejects(parseProjectPackage(missingFormat, { sha256 }), /format/);

    const invalidProject = clone(project) as ProjectDocument & { unexpected?: string };
    invalidProject.unexpected = "not in the provisional domain";
    await assert.rejects(
      parseProjectPackage(rawPackage(project, files, { manifest: { project: invalidProject } }), { sha256 }),
      /invalid project/,
    );
    const dangling = clone(project);
    dangling.configurations[0]!.variantId = "UNKNOWN-VARIANT";
    await assert.rejects(
      parseProjectPackage(rawPackage(project, files, { manifest: { project: dangling } }), { sha256 }),
      /invalid project/,
    );
  });

  it("checks manifest/reference/archive exactness and additional-only indexing", async () => {
    const project = projectWithMatchingAssetDigests();
    const files = referencedInputs(project);
    const omitted = rawPackage(project, files, { manifest: { assets: [] } });
    await assert.rejects(parseProjectPackage(omitted, { sha256 }), /missing referenced asset/);
    const missingPhysical = rawPackage(project, files.slice(1), {
      manifest: {
        assets: files.map((file) => ({
          path: file.path,
          kind: "referenced",
          size: file.bytes.length,
          sha256Hex: hashBytes(file.bytes),
        })),
      },
    });
    await assert.rejects(parseProjectPackage(missingPhysical, { sha256 }), /missing indexed asset/);
    const indexedLess = rawPackage(project, files, {
      extraArchiveFiles: [{ path: "extra.txt", bytes: new TextEncoder().encode("unexpected") }],
    });
    await assert.rejects(parseProjectPackage(indexedLess, { sha256 }), /unindexed asset/);

    const changedKind = rawPackage(project, files, {
      manifest: {
        assets: files.map((file) => ({
          path: file.path,
          kind: "additional",
          size: file.bytes.length,
          sha256Hex: hashBytes(file.bytes),
        })),
      },
    });
    await assert.rejects(parseProjectPackage(changedKind, { sha256 }), /kind does not match/);

    const additional = { path: "notes/unmapped.bin", bytes: new Uint8Array([0, 255, 10]) };
    const validExtra = rawPackage(project, [...files, additional]);
    const parsed = await parseProjectPackage(validExtra, { sha256 });
    assert.equal(parsed.assets.find((asset) => asset.path === additional.path)?.kind, "additional");
    assert.deepEqual(parsed.assets.find((asset) => asset.path === additional.path)?.bytes, additional.bytes);
  });

  it("rejects duplicate, unsafe, encrypted, symlink, unsupported, and mismatched ZIP structures", async () => {
    const project = projectWithMatchingAssetDigests();
    const files = referencedInputs(project);
    const duplicate = rawPackage(project, files, {
      extraArchiveFiles: [{ path: files[0]!.path, bytes: files[0]!.bytes }],
    });
    await assert.rejects(parseProjectPackage(duplicate, { sha256 }), /duplicate|sorted/);
    const caseCollision = rawPackage(project, files, {
      extraArchiveFiles: [{ path: files[0]!.path.toUpperCase(), bytes: files[0]!.bytes }],
    });
    await assert.rejects(parseProjectPackage(caseCollision, { sha256 }), /case-insensitive-colliding/);
    const unsafe = rawPackage(project, files, {
      extraArchiveFiles: [{ path: "../outside.txt", bytes: new Uint8Array([1]) }],
    });
    await assert.rejects(parseProjectPackage(unsafe, { sha256 }), /unsafe|portable/);

    const good = rawPackage(project, files);
    const encrypted = mutate(good, (copy, entry) => {
      const view = new DataView(copy.buffer);
      view.setUint16(entry.central + 8, 0x0801, true);
      view.setUint16(entry.local + 6, 0x0801, true);
    });
    await assert.rejects(parseProjectPackage(encrypted, { sha256 }), /encrypted|non-UTF-8/);

    const unsupported = mutate(good, (copy, entry) => {
      const view = new DataView(copy.buffer);
      view.setUint16(entry.central + 10, 99, true);
      view.setUint16(entry.local + 8, 99, true);
    }, files[0]!.path);
    await assert.rejects(parseProjectPackage(unsupported, { sha256 }), /compression method/);

    const symlink = mutate(good, (copy, entry) => {
      const view = new DataView(copy.buffer);
      view.setUint16(entry.central + 4, 0x0314, true);
      view.setUint32(entry.central + 38, ((0xa1ff << 16) >>> 0), true);
    }, files[0]!.path);
    await assert.rejects(parseProjectPackage(symlink, { sha256 }), /symlink|non-regular/);

    const localMismatch = mutate(good, (copy, entry) => {
      const view = new DataView(copy.buffer);
      view.setUint16(entry.local + 8, 8, true);
    }, files[0]!.path);
    await assert.rejects(parseProjectPackage(localMismatch, { sha256 }), /disagree/);

    const invalidUtf8 = mutate(good, (copy, entry) => {
      copy[entry.name] = 0xff;
    }, files[0]!.path);
    await assert.rejects(parseProjectPackage(invalidUtf8, { sha256 }), /UTF-8/);
    const wrongCrc = mutate(good, (copy, entry) => {
      const view = new DataView(copy.buffer);
      view.setUint32(entry.central + 16, view.getUint32(entry.central + 16, true) ^ 1, true);
      view.setUint32(entry.local + 14, view.getUint32(entry.local + 14, true) ^ 1, true);
    }, files[0]!.path);
    await assert.rejects(parseProjectPackage(wrongCrc, { sha256 }), /CRC-32 mismatch/);
  });

  it("rejects manifest digest and byte-length mismatches and caps actual decompression", async () => {
    const project = projectWithMatchingAssetDigests();
    const files = referencedInputs(project);
    const wrongDigest = rawPackage(project, files, {
      manifest: {
        assets: files.map((file) => ({
          path: file.path,
          kind: "referenced",
          size: file.bytes.length,
          sha256Hex: "0".repeat(64),
        })),
      },
    });
    await assert.rejects(parseProjectPackage(wrongDigest, { sha256 }), /SHA-256 mismatch/);
    const wrongProjectDigest = clone(project);
    wrongProjectDigest.logos[0]!.assets[0]!.sha256Hex = "0".repeat(64);
    await assert.rejects(
      parseProjectPackage(rawPackage(project, files, { manifest: { project: wrongProjectDigest } }), { sha256 }),
      /project asset digest/,
    );
    const wrongManifestLength = rawPackage(project, files, {
      manifest: {
        assets: files.map((file) => ({
          path: file.path,
          kind: "referenced",
          size: file.bytes.length + 1,
          sha256Hex: hashBytes(file.bytes),
        })),
      },
    });
    await assert.rejects(parseProjectPackage(wrongManifestLength, { sha256 }), /size mismatch/);

    const expandedPath = files[0]!.path;
    const compressed = rawPackage(project, files, { deflatedPaths: new Set([expandedPath]) });
    const bombBytes = new Uint8Array(1024 * 1024);
    const bombFiles = files.map((file) =>
      file.path === expandedPath ? { path: file.path, bytes: bombBytes } : file,
    );
    const bomb = rawPackage(project, bombFiles, {
      manifest: {
        assets: bombFiles.map((file) => ({
          path: file.path,
          kind: "referenced",
          size: file.path === expandedPath ? 1 : file.bytes.length,
          sha256Hex: hashBytes(file.bytes),
        })),
      },
      deflatedPaths: new Set([expandedPath]),
    });
    const forgedOutput = setEntryU32(bomb, expandedPath, 24, 22, 1);
    await assert.rejects(parseProjectPackage(forgedOutput, { sha256 }), /decompressed size|declared limit/);

    const truncated = new Uint8Array(compressed);
    const compressedAsset = entryOffsets(truncated, expandedPath);
    const compressedByte = compressedAsset.local + 30 + compressedAsset.nameLength;
    const originalByte = truncated[compressedByte];
    if (originalByte === undefined) throw new Error("compressed asset fixture is truncated");
    truncated[compressedByte] = originalByte ^ 0xff;
    await assert.rejects(parseProjectPackage(truncated, { sha256 }), /deflate|CRC|invalid/);
  });

  it("enforces archive, manifest, per-asset, aggregate, entry-count, and path-length limits", async () => {
    const oversizedArchive = new Uint8Array(PROJECT_PACKAGE_LIMITS.maxArchiveBytes + 1);
    await assert.rejects(parseProjectPackage(oversizedArchive, { sha256 }), /archive exceeds/);

    const project = projectWithMatchingAssetDigests();
    const files = referencedInputs(project);
    const good = rawPackage(project, files);
    const oversizedManifest = setEntryU32(
      good,
      "manifest.json",
      24,
      22,
      PROJECT_PACKAGE_LIMITS.maxManifestBytes + 1,
    );
    await assert.rejects(parseProjectPackage(oversizedManifest, { sha256 }), /manifest.json.*exceeds|manifest exceeds/);

    const oversizedAsset = setEntryU32(
      good,
      files[0]!.path,
      24,
      22,
      PROJECT_PACKAGE_LIMITS.maxAssetBytes + 1,
    );
    await assert.rejects(parseProjectPackage(oversizedAsset, { sha256 }), /declared uncompressed size/);

    const aggregateFiles = [
      ...files,
      { path: "extra/a.bin", bytes: new Uint8Array([1]) },
      { path: "extra/b.bin", bytes: new Uint8Array([2]) },
    ];
    const aggregate = rawPackage(project, aggregateFiles, {
      deflatedPaths: new Set(aggregateFiles.map((file) => file.path)),
    });
    let forgedTotal = aggregate;
    for (const file of aggregateFiles.slice(0, 3)) {
      forgedTotal = setEntryU32(
        forgedTotal,
        file.path,
        24,
        22,
        PROJECT_PACKAGE_LIMITS.maxAssetBytes - 1,
      );
    }
    await assert.rejects(parseProjectPackage(forgedTotal, { sha256 }), /total asset bytes/);

    const decompressedFiles = [
      ...files,
      { path: "extra/total-limit.bin", bytes: new Uint8Array([3]) },
    ];
    const totalBudgetArchive = rawPackage(project, decompressedFiles, {
      deflatedPaths: new Set(["manifest.json", ...decompressedFiles.map((file) => file.path)]),
    });
    let overTotalBudget = totalBudgetArchive;
    for (const [index, file] of decompressedFiles.entries()) {
      overTotalBudget = setEntryU32(
        overTotalBudget,
        file.path,
        24,
        22,
        index < 2 ? PROJECT_PACKAGE_LIMITS.maxAssetBytes - 1 : 7 * 1024 * 1024,
      );
    }
    overTotalBudget = setEntryU32(
      overTotalBudget,
      "manifest.json",
      24,
      22,
      PROJECT_PACKAGE_LIMITS.maxManifestBytes,
    );
    await assert.rejects(parseProjectPackage(overTotalBudget, { sha256 }), /total uncompressed bytes/);

    const tooMany = [
      ...files,
      ...Array.from({ length: PROJECT_PACKAGE_LIMITS.maxEntries }, (_, index) => ({
        path: `unindexed/${String(index).padStart(3, "0")}.bin`,
        bytes: new Uint8Array(),
      })),
    ];
    await assert.rejects(parseProjectPackage(rawPackage(project, tooMany), { sha256 }), /entry count/);

    const longPath = "p".repeat(PROJECT_PACKAGE_LIMITS.maxPathBytes + 1);
    await assert.rejects(
      parseProjectPackage(rawPackage(project, files, { extraArchiveFiles: [{ path: longPath, bytes: new Uint8Array() }] }), { sha256 }),
      /path exceeds/,
    );
  });

  it("checks creation-side entry, path, individual-byte, aggregate-byte, and manifest limits", async () => {
    const project = projectWithMatchingAssetDigests();
    const assets = referencedInputs(project);
    const extraCount = PROJECT_PACKAGE_LIMITS.maxEntries;
    await assert.rejects(
      createProjectPackage({
        project,
        assets,
        additionalAssets: Array.from({ length: extraCount }, (_, index) => ({
          path: `extra/${index}.bin`,
          bytes: new Uint8Array(),
        })),
      }, { sha256 }),
      /entry count/,
    );
    await assert.rejects(
      createProjectPackage({ project, assets, additionalAssets: [{ path: "p".repeat(PROJECT_PACKAGE_LIMITS.maxPathBytes + 1), bytes: new Uint8Array() }] }, { sha256 }),
      /path exceeds/,
    );
    await assert.rejects(
      createProjectPackage({ project, assets: assets.map((asset) => ({ ...asset, bytes: new Uint8Array(PROJECT_PACKAGE_LIMITS.maxAssetBytes + 1) })) }, { sha256 }),
      /exactly|asset.*exceeds/,
    );

    const shared = new Uint8Array(PROJECT_PACKAGE_LIMITS.maxAssetBytes);
    await assert.rejects(
      createProjectPackage({
        project,
        assets,
        additionalAssets: ["one", "two", "three"].map((name) => ({ path: `extra/${name}.bin`, bytes: shared })),
      }, { sha256 }),
      /total asset bytes/,
    );

    const tooLargeManifest = clone(project);
    tooLargeManifest.description = "x".repeat(PROJECT_PACKAGE_LIMITS.maxManifestBytes + 1);
    await assert.rejects(
      createProjectPackage({ project: tooLargeManifest, assets }, { sha256 }),
      /manifest exceeds/,
    );
  });
});
