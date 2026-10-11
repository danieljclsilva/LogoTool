/**
 * Provisional local area-bundle restore — pure core parser (Phase 5, provisional only).
 *
 * Rebuilds every authority locally (session draft, evidence, fit, regions,
 * areas); imported fit/approval/status flags are never trusted.
 */

import {
  buildEvidence,
  parseSessionRestore,
  snapshotEvidence,
  stableStringify,
  type RestoredDraft as SessionRestoreDraft,
} from "../calibration-session/index.js";
import {
  fitUniformScale,
  validateCalibrationEvidence,
  type CalibrationEvidence,
  type UniformFitResult,
} from "../calibration/index.js";
import type { PlanarRegionRecord } from "../planar-region/index.js";
import {
  AREA_BUNDLE_VERSION,
  buildAreaBundle,
  validateAreaRecord,
  type AreaBundle,
  type AreasMap,
  type RegionAreaRecord,
} from "../region-areas/index.js";

export const AREA_RESTORE_LIMITS = {
  maxChars: 8388608,
  maxRegions: 128,
  maxVerticesPerRing: 512,
  maxExclusionsPerRegion: 64,
  maxTotalVertices: 65536,
} as const;

export type ParseAreaBundleRestoreResult =
  | {
      ok: true;
      draft: SessionRestoreDraft;
      evidence: CalibrationEvidence;
      fit: UniformFitResult;
      regions: PlanarRegionRecord[];
      areas: AreasMap;
      bundle: AreaBundle;
    }
  | { ok: false; error: string };

function fail(error: string): ParseAreaBundleRestoreResult {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256
  );
}

function isFinitePoint(value: unknown): value is { x: number; y: number } {
  if (typeof value !== "object" || value === null) return false;
  if (!("x" in value) || !("y" in value)) return false;
  const x = value.x;
  const y = value.y;
  return (
    typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y)
  );
}

/** Logical vertex count with closing-vertex normalization (mirrors region-areas). */
function logicalVertexCount(polygon: unknown[]): number {
  if (polygon.length === 0) return 0;
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  const closed =
    polygon.length > 1 &&
    isFinitePoint(first) &&
    isFinitePoint(last) &&
    first.x === last.x &&
    first.y === last.y;
  return polygon.length - (closed ? 1 : 0);
}

export function parseAreaBundleRestore(
  text: string,
  currentAssetFullSha256: string,
): ParseAreaBundleRestoreResult {
  if (typeof text !== "string") {
    return fail("area restore: input must be a JSON string");
  }
  if (text.length > AREA_RESTORE_LIMITS.maxChars) {
    return fail(
      `area restore: file exceeds ${AREA_RESTORE_LIMITS.maxChars} characters`,
    );
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return fail("area restore: file is not valid JSON");
  }
  if (!isPlainObject(envelope)) {
    return fail("area restore: envelope must be an object");
  }
  if (envelope["schemaVersion"] !== AREA_BUNDLE_VERSION) {
    return fail("area restore: unknown or mismatched area bundle version");
  }
  for (const key of [
    "pendingReview",
    "productionApproved",
    "session",
    "regions",
    "areas",
    "limitations",
  ] as const) {
    if (!(key in envelope)) {
      return fail(`area restore: envelope is missing "${key}"`);
    }
  }
  // Imported approval claims are structurally required but never echoed.
  const sessionValue = envelope["session"];
  if (!isPlainObject(sessionValue)) {
    return fail("area restore: envelope session must be an object");
  }
  const regionsValue = envelope["regions"];
  const areasValue = envelope["areas"];
  if (!Array.isArray(regionsValue)) {
    return fail("area restore: envelope regions must be an array");
  }
  if (!Array.isArray(areasValue)) {
    return fail("area restore: envelope areas must be an array");
  }
  if (regionsValue.length > AREA_RESTORE_LIMITS.maxRegions) {
    return fail(
      `area restore: too many regions (${regionsValue.length} > ${AREA_RESTORE_LIMITS.maxRegions})`,
    );
  }
  if (areasValue.length !== regionsValue.length) {
    return fail(
      `area restore: areas count (${areasValue.length}) must equal regions count (${regionsValue.length})`,
    );
  }

  // Nested session restore (inherits its own limits); values recomputed below.
  let nestedText: string;
  try {
    nestedText = JSON.stringify(sessionValue);
  } catch {
    return fail("area restore: envelope session is not serializable");
  }
  const restored = parseSessionRestore(nestedText, currentAssetFullSha256);
  if (!restored.ok) {
    return fail(`area restore: ${restored.error}`);
  }
  const draft = restored.draft;

  const builtEvidence = buildEvidence(draft.fields, draft.anchors, draft.measurements);
  if (!builtEvidence.ok) {
    return fail(`area restore: ${builtEvidence.error}`);
  }
  const evidence = builtEvidence.evidence;
  const evidenceCheck = validateCalibrationEvidence(evidence);
  if (!evidenceCheck.ok) {
    return fail(`area restore: ${evidenceCheck.errors.join("; ")}`);
  }
  let fit: UniformFitResult;
  try {
    fit = fitUniformScale(evidence);
  } catch (e) {
    return fail(
      `area restore: calibration fit failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (fit.inconsistent) {
    return fail("area restore: calibration fit is inconsistent");
  }
  const snapshot = snapshotEvidence(evidence);

  // Cheap region pre-checks (limits before kernel): valid ids + dup detection
  // with null-prototype-safe lookups so __proto__ ids behave as real ids.
  const regionById: Record<string, Record<string, unknown>> = Object.create(null);
  const seenFrameIds: Record<string, true> = Object.create(null);
  for (let i = 0; i < regionsValue.length; i++) {
    const entry = regionsValue[i];
    if (!isPlainObject(entry)) {
      return fail(`area restore: regions[${i}] must be an object`);
    }
    const regionId = entry["regionId"];
    const frameId = entry["frameId"];
    if (!isValidId(regionId)) {
      return fail(
        `area restore: regions[${i}].regionId must be a non-empty string of at most 256 chars`,
      );
    }
    if (!isValidId(frameId)) {
      return fail(
        `area restore: regions[${i}].frameId must be a non-empty string of at most 256 chars`,
      );
    }
    if (Object.hasOwn(regionById, regionId)) {
      return fail(`area restore: duplicate regionId "${regionId}"`);
    }
    if (Object.hasOwn(seenFrameIds, frameId)) {
      return fail(`area restore: duplicate frameId "${frameId}"`);
    }
    regionById[regionId] = entry;
    seenFrameIds[frameId] = true;
  }

  // Cheap area pre-checks: structural validity + ring/total limits before the
  // expensive builders, plus exact 1:1 region coverage (no missing/duplicate/
  // extra area records) on a null-prototype map (map-key aliasing rejected).
  const areasMap: AreasMap = Object.create(null) as AreasMap;
  let totalVertices = 0;
  const countRing = (
    polygon: unknown,
    label: string,
  ): { ok: true; count: number } | { ok: false; error: string } => {
    if (!Array.isArray(polygon)) {
      return { ok: false, error: `area restore: ${label} must be an array` };
    }
    for (const point of polygon) {
      if (!isFinitePoint(point)) {
        return {
          ok: false,
          error: `area restore: ${label} vertices must be finite { x, y } points`,
        };
      }
    }
    const count = logicalVertexCount(polygon);
    if (count > AREA_RESTORE_LIMITS.maxVerticesPerRing) {
      return {
        ok: false,
        error: `area restore: ${label} exceeds ${AREA_RESTORE_LIMITS.maxVerticesPerRing} vertices`,
      };
    }
    return { ok: true, count };
  };
  for (let i = 0; i < areasValue.length; i++) {
    const entry = areasValue[i];
    const structural = validateAreaRecord(entry);
    if (!structural.ok) {
      return fail(`area restore: areas[${i}] invalid: ${structural.error}`);
    }
    // Schema-parsed above by validateAreaRecord; recover its static shape here.
    const record: RegionAreaRecord = entry as RegionAreaRecord;
    if (Object.hasOwn(areasMap, record.regionId)) {
      return fail(`area restore: duplicate area for region "${record.regionId}"`);
    }
    const region = regionById[record.regionId];
    const regionFrameId = region !== undefined && "frameId" in region ? region.frameId : undefined;
    if (region === undefined || regionFrameId === undefined) {
      return fail(
        `area restore: area "${record.regionId}" has no matching region`,
      );
    }
    if (record.frameId !== regionFrameId) {
      return fail(
        `area restore: area "${record.regionId}" frame binding is stale`,
      );
    }
    let frameSnapshot: string;
    try {
      frameSnapshot = stableStringify(region);
    } catch {
      return fail(
        `area restore: area "${record.regionId}" frame snapshot is not serializable`,
      );
    }
    if (record.frameSnapshot !== frameSnapshot) {
      return fail(
        `area restore: area "${record.regionId}" frame snapshot is stale`,
      );
    }
    if (record.safePolygon !== null) {
      const counted = countRing(
        record.safePolygon,
        `area "${record.regionId}" safe polygon`,
      );
      if (!counted.ok) return fail(counted.error);
      totalVertices += counted.count;
      if (totalVertices > AREA_RESTORE_LIMITS.maxTotalVertices) {
        return fail(
          `area restore: total polygon vertices exceed ${AREA_RESTORE_LIMITS.maxTotalVertices}`,
        );
      }
    }
    if (record.exclusions.length > AREA_RESTORE_LIMITS.maxExclusionsPerRegion) {
      return fail(
        `area restore: area "${record.regionId}" exceeds ${AREA_RESTORE_LIMITS.maxExclusionsPerRegion} exclusions`,
      );
    }
    const seenExclusions: Record<string, true> = Object.create(null);
    for (const exclusion of record.exclusions) {
      if (Object.hasOwn(seenExclusions, exclusion.id)) {
        return fail(
          `area restore: area "${record.regionId}" has duplicate exclusion id "${exclusion.id}"`,
        );
      }
      seenExclusions[exclusion.id] = true;
      const counted = countRing(
        exclusion.polygon,
        `area "${record.regionId}" exclusion "${exclusion.id}" polygon`,
      );
      if (!counted.ok) return fail(counted.error);
      totalVertices += counted.count;
      if (totalVertices > AREA_RESTORE_LIMITS.maxTotalVertices) {
        return fail(
          `area restore: total polygon vertices exceed ${AREA_RESTORE_LIMITS.maxTotalVertices}`,
        );
      }
    }
    // Canonical copies come from buildAreaBundle below; hold the raw validated record.
    areasMap[record.regionId] = record;
  }
  for (const regionId of Object.keys(regionById)) {
    if (!Object.hasOwn(areasMap, regionId)) {
      return fail(`area restore: missing area for region "${regionId}"`);
    }
  }

  // Canonical verification: rebuild everything through the existing builders.
  // Every region entry passed isPlainObject above and is re-validated inside
  // buildRegionBundle, so recover the static input shape once here.
  const regionInputs: PlanarRegionRecord[] = regionsValue as PlanarRegionRecord[];
  const rebuilt = buildAreaBundle(
    evidence,
    {
      scaleMmPerUnit: fit.scaleMmPerUnit,
      inconsistent: fit.inconsistent,
      assetFullSha256: fit.assetFullSha256,
    },
    regionInputs,
    areasMap,
    snapshot,
  );
  if (!rebuilt.ok) {
    return fail(`area restore: ${rebuilt.error}`);
  }
  const bundle = rebuilt.bundle;
  const outAreas: AreasMap = Object.create(null);
  for (const record of bundle.areas) {
    outAreas[record.regionId] = record;
  }
  return {
    ok: true,
    draft,
    evidence,
    fit,
    regions: bundle.regions,
    areas: outAreas,
    bundle,
  };
}
