/**
 * Provisional logo-placement restore — pure core parser (Phase 6, slice 1 —
 * provisional, pending review; never production approved).
 *
 * Rebuilds every authority locally (session draft, evidence, fit, regions,
 * areas, logos, placements, statuses); imported fit/approval/status/
 * footprint claims are never trusted. Restores are atomic (all-or-nothing):
 * any malformed or reference-invalid input fails with a single error string
 * and no partial state.
 */

import {
  buildEvidence,
  parseSessionRestore,
  snapshotEvidence,
  stableStringify,
  type DraftAnchor,
  type DraftMeasurement,
  type SessionFields,
} from "../calibration-session/index.js";
import {
  fitUniformScale,
  validateCalibrationEvidence,
  type CalibrationEvidence,
  type UniformFitResult,
} from "../calibration/index.js";
import type { PlanarRegionRecord } from "../planar-region/index.js";
import {
  validateAreaRecord,
  type AreasMap,
  type RegionAreaRecord,
} from "../region-areas/index.js";
import {
  buildPlacementBundle,
  PLACEMENT_BUNDLE_VERSION,
  validateDraftLogo,
  validateDraftPlacement,
  type LogosMap,
  type PlacementBundle,
  type PlacementsMap,
} from "../logo-placements/index.js";

export const PLACEMENT_RESTORE_LIMITS = {
  maxChars: 8388608,
  maxPlacements: 256,
  maxLogos: 64,
  maxRegions: 128,
  maxIdLength: 256,
  maxVerticesPerRing: 512,
  maxExclusionsPerRegion: 64,
  maxTotalVertices: 65536,
} as const;

export interface PlacementRestoreDraft {
  fields: SessionFields;
  anchors: DraftAnchor[];
  measurements: DraftMeasurement[];
  regions: PlanarRegionRecord[];
  areas: AreasMap;
  logos: LogosMap;
  placements: PlacementsMap;
}

export type ParsePlacementRestoreResult =
  | {
      ok: true;
      draft: PlacementRestoreDraft;
      evidence: CalibrationEvidence;
      fit: UniformFitResult;
      bundle: PlacementBundle;
    }
  | { ok: false; error: string };

function fail(error: string): ParsePlacementRestoreResult {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= PLACEMENT_RESTORE_LIMITS.maxIdLength
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

export function parsePlacementRestore(
  text: string,
  currentAssetFullSha256: string,
): ParsePlacementRestoreResult {
  if (typeof text !== "string") {
    return fail("placement restore: input must be a JSON string");
  }
  if (text.length > PLACEMENT_RESTORE_LIMITS.maxChars) {
    return fail(
      `placement restore: file exceeds ${PLACEMENT_RESTORE_LIMITS.maxChars} characters`,
    );
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return fail("placement restore: file is not valid JSON");
  }
  if (!isPlainObject(envelope)) {
    return fail("placement restore: envelope must be an object");
  }
  if (envelope["schemaVersion"] !== PLACEMENT_BUNDLE_VERSION) {
    return fail("placement restore: unknown or mismatched placement bundle version");
  }
  for (const key of [
    "pendingReview",
    "productionApproved",
    "session",
    "regions",
    "areas",
    "logos",
    "placements",
  ] as const) {
    if (!(key in envelope)) {
      return fail(`placement restore: envelope is missing "${key}"`);
    }
  }
  // Imported approval flags are structurally required but never echoed.
  const sessionValue = envelope["session"];
  if (!isPlainObject(sessionValue)) {
    return fail("placement restore: envelope session must be an object");
  }
  const regionsValue = envelope["regions"];
  const areasValue = envelope["areas"];
  const logosValue = envelope["logos"];
  const placementsValue = envelope["placements"];
  if (!Array.isArray(regionsValue)) {
    return fail("placement restore: envelope regions must be an array");
  }
  if (!Array.isArray(areasValue)) {
    return fail("placement restore: envelope areas must be an array");
  }
  if (!Array.isArray(logosValue)) {
    return fail("placement restore: envelope logos must be an array");
  }
  if (!Array.isArray(placementsValue)) {
    return fail("placement restore: envelope placements must be an array");
  }
  if (regionsValue.length > PLACEMENT_RESTORE_LIMITS.maxRegions) {
    return fail(
      `placement restore: too many regions (${regionsValue.length} > ${PLACEMENT_RESTORE_LIMITS.maxRegions})`,
    );
  }
  if (areasValue.length !== regionsValue.length) {
    return fail(
      `placement restore: areas count (${areasValue.length}) must equal regions count (${regionsValue.length})`,
    );
  }
  if (logosValue.length > PLACEMENT_RESTORE_LIMITS.maxLogos) {
    return fail(
      `placement restore: too many logos (${logosValue.length} > ${PLACEMENT_RESTORE_LIMITS.maxLogos})`,
    );
  }
  if (placementsValue.length > PLACEMENT_RESTORE_LIMITS.maxPlacements) {
    return fail(
      `placement restore: too many placements (${placementsValue.length} > ${PLACEMENT_RESTORE_LIMITS.maxPlacements})`,
    );
  }

  // Nested session restore (inherits its own limits); values recomputed below.
  let nestedText: string;
  try {
    nestedText = JSON.stringify(sessionValue);
  } catch {
    return fail("placement restore: envelope session is not serializable");
  }
  const restored = parseSessionRestore(nestedText, currentAssetFullSha256);
  if (!restored.ok) {
    return fail(`placement restore: ${restored.error}`);
  }
  const draft = restored.draft;

  const builtEvidence = buildEvidence(draft.fields, draft.anchors, draft.measurements);
  if (!builtEvidence.ok) {
    return fail(`placement restore: ${builtEvidence.error}`);
  }
  const evidence = builtEvidence.evidence;
  const evidenceCheck = validateCalibrationEvidence(evidence);
  if (!evidenceCheck.ok) {
    return fail(`placement restore: ${evidenceCheck.errors.join("; ")}`);
  }
  let fit: UniformFitResult;
  try {
    fit = fitUniformScale(evidence);
  } catch (e) {
    return fail(
      `placement restore: calibration fit failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (fit.inconsistent) {
    return fail("placement restore: calibration fit is inconsistent");
  }
  const snapshot = snapshotEvidence(evidence);

  // Cheap region pre-checks (limits before kernel): valid ids + dup detection
  // with null-prototype-safe lookups so __proto__ ids behave as real ids.
  const regionById: Record<string, Record<string, unknown>> = Object.create(null);
  const regionIds: string[] = [];
  const seenFrameIds: Record<string, true> = Object.create(null);
  for (let i = 0; i < regionsValue.length; i++) {
    const entry = regionsValue[i];
    if (!isPlainObject(entry)) {
      return fail(`placement restore: regions[${i}] must be an object`);
    }
    const regionId = entry["regionId"];
    const frameId = entry["frameId"];
    if (!isValidId(regionId)) {
      return fail(
        `placement restore: regions[${i}].regionId must be a non-empty string of at most 256 chars`,
      );
    }
    if (!isValidId(frameId)) {
      return fail(
        `placement restore: regions[${i}].frameId must be a non-empty string of at most 256 chars`,
      );
    }
    if (Object.hasOwn(regionById, regionId)) {
      return fail(`placement restore: duplicate regionId "${regionId}"`);
    }
    if (Object.hasOwn(seenFrameIds, frameId)) {
      return fail(`placement restore: duplicate frameId "${frameId}"`);
    }
    regionById[regionId] = entry;
    regionIds.push(regionId);
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
      return { ok: false, error: `placement restore: ${label} must be an array` };
    }
    for (const point of polygon) {
      if (!isFinitePoint(point)) {
        return {
          ok: false,
          error: `placement restore: ${label} vertices must be finite { x, y } points`,
        };
      }
    }
    const count = logicalVertexCount(polygon);
    if (count > PLACEMENT_RESTORE_LIMITS.maxVerticesPerRing) {
      return {
        ok: false,
        error: `placement restore: ${label} exceeds ${PLACEMENT_RESTORE_LIMITS.maxVerticesPerRing} vertices`,
      };
    }
    return { ok: true, count };
  };
  for (let i = 0; i < areasValue.length; i++) {
    const entry = areasValue[i];
    const structural = validateAreaRecord(entry);
    if (!structural.ok) {
      return fail(`placement restore: areas[${i}] invalid: ${structural.error}`);
    }
    const record: RegionAreaRecord = entry as RegionAreaRecord;
    if (Object.hasOwn(areasMap, record.regionId)) {
      return fail(`placement restore: duplicate area for region "${record.regionId}"`);
    }
    const region = regionById[record.regionId];
    const regionFrameId = region !== undefined && "frameId" in region ? region.frameId : undefined;
    if (region === undefined || regionFrameId === undefined) {
      return fail(
        `placement restore: area "${record.regionId}" has no matching region`,
      );
    }
    if (record.frameId !== regionFrameId) {
      return fail(
        `placement restore: area "${record.regionId}" frame binding is stale`,
      );
    }
    let frameSnapshot: string;
    try {
      frameSnapshot = stableStringify(region);
    } catch {
      return fail(
        `placement restore: area "${record.regionId}" frame snapshot is not serializable`,
      );
    }
    if (record.frameSnapshot !== frameSnapshot) {
      return fail(
        `placement restore: area "${record.regionId}" frame snapshot is stale`,
      );
    }
    if (record.safePolygon !== null) {
      const counted = countRing(
        record.safePolygon,
        `area "${record.regionId}" safe polygon`,
      );
      if (!counted.ok) return fail(counted.error);
      totalVertices += counted.count;
      if (totalVertices > PLACEMENT_RESTORE_LIMITS.maxTotalVertices) {
        return fail(
          `placement restore: total polygon vertices exceed ${PLACEMENT_RESTORE_LIMITS.maxTotalVertices}`,
        );
      }
    }
    if (record.exclusions.length > PLACEMENT_RESTORE_LIMITS.maxExclusionsPerRegion) {
      return fail(
        `placement restore: area "${record.regionId}" exceeds ${PLACEMENT_RESTORE_LIMITS.maxExclusionsPerRegion} exclusions`,
      );
    }
    const seenExclusions: Record<string, true> = Object.create(null);
    for (const exclusion of record.exclusions) {
      if (Object.hasOwn(seenExclusions, exclusion.id)) {
        return fail(
          `placement restore: area "${record.regionId}" has duplicate exclusion id "${exclusion.id}"`,
        );
      }
      seenExclusions[exclusion.id] = true;
      const counted = countRing(
        exclusion.polygon,
        `area "${record.regionId}" exclusion "${exclusion.id}" polygon`,
      );
      if (!counted.ok) return fail(counted.error);
      totalVertices += counted.count;
      if (totalVertices > PLACEMENT_RESTORE_LIMITS.maxTotalVertices) {
        return fail(
          `placement restore: total polygon vertices exceed ${PLACEMENT_RESTORE_LIMITS.maxTotalVertices}`,
        );
      }
    }
    areasMap[record.regionId] = record;
  }
  for (const regionId of Object.keys(regionById)) {
    if (!Object.hasOwn(areasMap, regionId)) {
      return fail(`placement restore: missing area for region "${regionId}"`);
    }
  }

  // Cheap logo pre-checks: structural validity + dup detection on a
  // null-prototype map (map-key aliasing rejected). validateDraftLogo narrows
  // plain objects only, so recover the typed id/entries through `in` checks.
  const logosMap: LogosMap = Object.create(null);
  for (let i = 0; i < logosValue.length; i++) {
    const entry = logosValue[i];
    const structural = validateDraftLogo(entry);
    if (!structural.ok) {
      return fail(`placement restore: logos[${i}] invalid: ${structural.error}`);
    }
    if (!isPlainObject(entry) || !isValidId(entry["id"])) {
      return fail(`placement restore: logos[${i}] invalid: logo id must be a non-empty string of at most 256 chars`);
    }
    const logoId: string = entry["id"];
    if (Object.hasOwn(logosMap, logoId)) {
      return fail(`placement restore: duplicate logo id "${logoId}"`);
    }
    const logoName: unknown = entry["name"];
    if (typeof logoName !== "string") {
      return fail(`placement restore: logos[${i}] invalid: logo is malformed`);
    }
    const widthPx: unknown = entry["widthPx"];
    const heightPx: unknown = entry["heightPx"];
    if (
      (widthPx !== undefined && typeof widthPx !== "number") ||
      (heightPx !== undefined && typeof heightPx !== "number")
    ) {
      return fail(`placement restore: logos[${i}] invalid: logo is malformed`);
    }
    const logo = {
      id: logoId,
      name: logoName,
      ...(typeof widthPx === "number" ? { widthPx } : {}),
      ...(typeof heightPx === "number" ? { heightPx } : {}),
    };
    logosMap[logoId] = logo;
  }

  // Cheap placement pre-checks: full structural + dangling-reference checks
  // against the restored logo/region ids before the expensive builders.
  const placementsMap: PlacementsMap = Object.create(null);
  for (let i = 0; i < placementsValue.length; i++) {
    const entry = placementsValue[i];
    if (!isPlainObject(entry)) {
      return fail(`placement restore: placements[${i}] must be an object`);
    }
    const id: unknown = entry["id"];
    if (!isValidId(id)) {
      return fail(
        `placement restore: placements[${i}].id must be a non-empty string of at most 256 chars`,
      );
    }
    const placementId: string = id;
    if (Object.hasOwn(placementsMap, placementId)) {
      return fail(`placement restore: duplicate placement id "${placementId}"`);
    }
    const check = validateDraftPlacement(entry, logosMap, regionIds);
    if (!check.ok) {
      return fail(`placement restore: placements[${i}] invalid: ${check.error}`);
    }
    const logoId: unknown = entry["logoId"];
    const regionId: unknown = entry["regionId"];
    const xMm: unknown = entry["xMm"];
    const yMm: unknown = entry["yMm"];
    const widthMm: unknown = entry["widthMm"];
    const heightMm: unknown = entry["heightMm"];
    const rotationDeg: unknown = entry["rotationDeg"];
    if (
      typeof logoId !== "string" ||
      typeof regionId !== "string" ||
      typeof xMm !== "number" ||
      typeof yMm !== "number" ||
      typeof widthMm !== "number" ||
      typeof heightMm !== "number" ||
      typeof rotationDeg !== "number"
    ) {
      return fail(`placement restore: placements[${i}] invalid: placement is malformed`);
    }
    placementsMap[placementId] = {
      id: placementId,
      logoId,
      regionId,
      xMm,
      yMm,
      widthMm,
      heightMm,
      rotationDeg,
    };
  }

  // Canonical verification: rebuild everything through the existing builders.
  // Supplied fit/status/footprint/approval values are never read — the bundle
  // below recomputes fit, regions, areas, footprints, and statuses locally.
  // A JSON round-trip yields freshly typed region inputs without asserting
  // shapes the parser has not yet fully validated.
  const regionInputs: PlanarRegionRecord[] = JSON.parse(JSON.stringify(regionsValue));
  const rebuilt = buildPlacementBundle(
    evidence,
    {
      scaleMmPerUnit: fit.scaleMmPerUnit,
      inconsistent: fit.inconsistent,
      assetFullSha256: fit.assetFullSha256,
    },
    regionInputs,
    areasMap,
    logosMap,
    placementsMap,
    snapshot,
  );
  if (!rebuilt.ok) {
    return fail(`placement restore: ${rebuilt.error}`);
  }
  const bundle = rebuilt.bundle;
  const outAreas: AreasMap = Object.create(null);
  for (const record of bundle.areas) {
    outAreas[record.regionId] = record;
  }
  const outLogos: LogosMap = Object.create(null);
  for (const logo of bundle.logos) {
    outLogos[logo.id] = logo;
  }
  const outPlacements: PlacementsMap = Object.create(null);
  for (const placement of bundle.placements) {
    outPlacements[placement.id] = placement;
  }
  return {
    ok: true,
    draft: {
      fields: draft.fields,
      anchors: draft.anchors,
      measurements: draft.measurements,
      regions: bundle.regions,
      areas: outAreas,
      logos: outLogos,
      placements: outPlacements,
    },
    evidence,
    fit,
    bundle,
  };
}
