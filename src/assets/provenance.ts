/**
 * Sidecar asset-record ingestion.
 *
 * `ingestAsset` parses a GLB container (`./glb.js`), validates the glTF
 * payload against the self-contained subset (`./validate.js`), and returns a
 * deterministic sidecar `AssetRecord` plus any validation issues.
 *
 * Byte ownership: the caller's `bytes` are never mutated, copied into the
 * record, or retained — the record is metadata only (byte length, digest,
 * GLB framing facts, counts, visualization-only bounds). Callers keep
 * owning (and preserving) the original bytes.
 *
 * Identity: `assetId` derives deterministically from the SHA-256 digest, so
 * identical bytes and identical supplied metadata produce `JSON.stringify`-identical records. The
 * digest itself comes from an injected sync `hasher` over the raw bytes or
 * from an externally provided `sha256Hex`; when neither is available
 * ingestion fails with an explicit error instead of hashing implicitly
 * (domain code stays independent of node:crypto / SubtleCrypto).
 *
 * No millimetre derivation: the record carries no `*Mm` fields. Optional
 * `declaredPositionAccessorBounds` echoes the payload's own declared accessor
 * min/max triples verbatim for visualization only — never a calibration or
 * placement input.
 *
 * Portable: imports the shared guard plus sibling modules only; no Node
 * fs/crypto, no browser/Three.js APIs.
 */

import { isRecord } from "../core/guards.js";
import { parseGlb } from "./glb.js";
import { DEFAULT_MAX_BYTES, validateSelfContained } from "./validate.js";
import type {
  AssetIssue,
  ValidateSelfContainedOptions,
} from "./validate.js";

export const ASSET_SCHEMA_VERSION = "0.1.0-provisional-asset" as const;
export const ASSET_MEDIA_TYPE = "model/gltf-binary" as const;
const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type AssetSource = "manually-imported" | "synthetic-generated";

export interface AssetBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface AssetRecord {
  schemaVersion: typeof ASSET_SCHEMA_VERSION;
  assetId: string;
  source: AssetSource;
  generatedBy?: string;
  originalFilename?: string;
  mediaType: string;
  byteLength: number;
  sha256Hex: string;
  recordedAt: string;
  operator: string;
  productId?: string;
  variantId?: string;
  calibrationStatus: "uncalibrated";
  glb: {
    version: 2;
    jsonByteLength: number;
    hasBinChunk: boolean;
    nodeCount?: number;
    meshCount?: number;
  };
  declaredPositionAccessorBounds?: AssetBounds | null;
}

export interface IngestAssetInput {
  bytes: Uint8Array;
  filename?: string;
  mediaType?: string;
  source: AssetSource;
  generatedBy?: string;
  productId?: string;
  variantId?: string;
  recordedAt: string;
  operator: string;
  sha256Hex?: string;
  hasher?: (bytes: Uint8Array) => string;
}

export interface IngestAssetResult {
  record: AssetRecord;
  issues: AssetIssue[];
}

function fail(message: string): never {
  throw new Error(`asset-ingest: ${message}`);
}

function countOf(json: Record<string, unknown>, key: string): number | null {
  const raw = json[key];
  return Array.isArray(raw) ? raw.length : null;
}

/**
 * Echo the payload's own declared POSITION bounds verbatim when the meshes
 * reference an accessor carrying a valid 3-triple `min`/`max`. Returns null
 * when no such declaration exists. Visualization only — never calibration.
 */
function declaredBounds(json: Record<string, unknown>): AssetBounds | null {
  const accessorsRaw = json["accessors"];
  const meshesRaw = json["meshes"];
  if (!Array.isArray(accessorsRaw) || !Array.isArray(meshesRaw)) return null;
  const positioned = new Set<number>();
  for (const mesh of meshesRaw) {
    if (!isRecord(mesh) || !Array.isArray(mesh["primitives"])) continue;
    for (const primitive of mesh["primitives"] as unknown[]) {
      if (!isRecord(primitive) || !isRecord(primitive["attributes"])) continue;
      const ref = primitive["attributes"]["POSITION"];
      if (
        typeof ref === "number" &&
        Number.isInteger(ref) &&
        ref >= 0 &&
        ref < accessorsRaw.length
      ) {
        positioned.add(ref);
      }
    }
  }
  const triple = (value: unknown): [number, number, number] | null =>
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
      ? [value[0] as number, value[1] as number, value[2] as number]
      : null;
  for (const index of positioned) {
    const accessor = accessorsRaw[index];
    if (!isRecord(accessor)) continue;
    const min = triple(accessor["min"]);
    const max = triple(accessor["max"]);
    if (min !== null && max !== null) return { min, max };
  }
  return null;
}

export function ingestAsset(
  input: IngestAssetInput,
  opts?: ValidateSelfContainedOptions,
): IngestAssetResult {
  if (!isRecord(input as unknown as Record<string, unknown>)) {
    fail("input must be an object.");
  }
  if (!(input.bytes instanceof Uint8Array)) {
    fail("`bytes` must be a Uint8Array.");
  }
  if (input.bytes.byteLength > (opts?.maxBytes ?? DEFAULT_MAX_BYTES)) fail('GLB exceeds the intake byte limit.');
  if (input.source !== "manually-imported" && input.source !== "synthetic-generated") {
    fail('`source` must be "manually-imported" or "synthetic-generated".');
  }
  if (typeof input.recordedAt !== "string" || input.recordedAt.length === 0) {
    fail("`recordedAt` must be a non-empty string.");
  }
  if (typeof input.operator !== "string" || input.operator.length === 0) {
    fail("`operator` must be a non-empty string.");
  }

  let sha256Hex = input.sha256Hex;
  if (sha256Hex === undefined) {
    if (input.hasher === undefined) {
      fail(
        "no digest available: provide `sha256Hex` or inject a sync `hasher`.",
      );
    }
    try {
      sha256Hex = input.hasher(input.bytes);
    } catch (error) {
      fail(
        `hasher threw (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  if (typeof sha256Hex !== "string" || !DIGEST_HEX_PATTERN.test(sha256Hex)) {
    fail("digest must be lowercase SHA-256 hex ([0-9a-f]{64}).");
  }
  const digest: string = sha256Hex;

  const parsed = parseGlb(input.bytes);
  const issues: AssetIssue[] = validateSelfContained(parsed.json, opts);
  const json = parsed.json as Record<string, unknown>;
  if (isRecord(json) && Array.isArray(json.buffers)) {
    const first = json.buffers[0];
    if (isRecord(first) && first.uri === undefined && typeof first.byteLength === 'number') {
      const length = parsed.binChunkLength;
      if (length === null || length < first.byteLength || length > first.byteLength + 3) {
        issues.push({code: 'asset-bin-length-mismatch', path: 'buffers/0/byteLength', message: 'Embedded buffer length does not match the BIN chunk (allowing up to three padding bytes).'});
      }
    }
  }


  const record: AssetRecord = {
    schemaVersion: ASSET_SCHEMA_VERSION,
    assetId: `asset-${digest.slice(0, 32)}`,
    source: input.source,
    mediaType: input.mediaType ?? ASSET_MEDIA_TYPE,
    byteLength: input.bytes.length,
    sha256Hex: digest,
    recordedAt: input.recordedAt,
    operator: input.operator,
    calibrationStatus: "uncalibrated",
    glb: {
      version: 2,
      jsonByteLength: parsed.jsonByteLength,
      hasBinChunk: parsed.binChunkLength !== null,
    },
    declaredPositionAccessorBounds: isRecord(json) ? declaredBounds(json) : null,
  };
  if (input.generatedBy !== undefined) record.generatedBy = input.generatedBy;
  if (input.filename !== undefined) record.originalFilename = input.filename;
  if (input.productId !== undefined) record.productId = input.productId;
  if (input.variantId !== undefined) record.variantId = input.variantId;
  if (isRecord(json)) {
    const nodeCount = countOf(json, "nodes");
    const meshCount = countOf(json, "meshes");
    if (nodeCount !== null) record.glb.nodeCount = nodeCount;
    if (meshCount !== null) record.glb.meshCount = meshCount;
  }
  return { record, issues };
}
