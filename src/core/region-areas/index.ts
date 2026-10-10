/**
 * Region safe-areas — pure draft state for authored planar-frame mm polygons.
 *
 * A `RegionAreaRecord` binds one authored planar frame (`regionId`/`frameId`)
 * to an optional safe polygon plus zero or more named exclusion polygons, all
 * in frame millimetres. Polygons are implicitly closed rings; either winding
 * is accepted, including concave shapes.
 *
 * Union-obstacle semantics: exclusions are validated individually (each must
 * be a simple non-zero-area ring) but are NOT required to sit inside the safe
 * polygon and MAY overlap each other. Overlap / outside-safe exclusions are
 * retained as authored and act as unioned obstacles in `footprintFits`: any
 * footprint contact with any exclusion fails. Callers that want strict
 * containment must enforce it before calling `addExclusion`.
 *
 * Same-ID recreation after removal gets NO inheritance: `pruneAreas` drops
 * records whose region no longer exists, and the caller removes the stale
 * record first, so a recreated region with a reused id can never reattach to
 * a previous safe polygon or exclusions.
 *
 * Bundles are export-only drafts (`pendingReview: true`,
 * `productionApproved: false`, never endorsed for production). There is
 * intentionally no restore path. A `safePolygon` of `null` (unconfigured
 * frame) is allowed through export and marks the bundle as draft-only.
 *
 * Pure module: no browser/Node/fs/Three imports.
 */

import {
  footprintFits,
  validateSafePolygon,
  type GeoPoint,
} from "../geometry/index.js";
import {
  buildRegionBundle,
  type PlanarRegionRecord,
} from "../planar-region/index.js";
import {
  fitUniformScale,
  type CalibrationEvidence,
  type UniformFitResult,
} from "../calibration/index.js";
import {
  snapshotEvidence,
  stableStringify,
  type SessionExport,
} from "../calibration-session/index.js";

/** Provisional area-bundle envelope version (never restored into drafts). */
export const AREA_BUNDLE_VERSION = "0.1.0-provisional-region-areas" as const;

export const AREA_LIMITS = {
  MAX_TEXT_LENGTH: 65536,
  MAX_VERTICES: 512,
  MAX_EXCLUSIONS_PER_REGION: 64,
  MAX_ID_LENGTH: 256,
  MAX_NAME_LENGTH: 256,
} as const;

export interface AreaExclusion {
  id: string;
  name: string;
  polygon: GeoPoint[];
}

export interface RegionAreaRecord {
  regionId: string;
  frameId: string;
  /** stableStringify(region) captured when the safe polygon was authored. */
  frameSnapshot: string;
  safePolygon: GeoPoint[] | null;
  exclusions: AreaExclusion[];
}

export interface AreaBundle {
  schemaVersion: typeof AREA_BUNDLE_VERSION;
  pendingReview: true;
  productionApproved: false;
  session: SessionExport;
  regions: PlanarRegionRecord[];
  areas: RegionAreaRecord[];
  limitations: string[];
}

export type AreasMap = Record<string, RegionAreaRecord>;

function err(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFinitePoint(value: unknown): value is GeoPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y)
  );
}

function vertexCount(polygon: unknown[]): number {
  const first = polygon[0];
  const last = polygon.at(-1);
  return polygon.length - (polygon.length > 1 && isFinitePoint(first) && isFinitePoint(last) && first.x === last.x && first.y === last.y ? 1 : 0);
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= AREA_LIMITS.MAX_ID_LENGTH
  );
}

function isValidName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= AREA_LIMITS.MAX_NAME_LENGTH
  );
}

function copyPolygon(poly: GeoPoint[]): GeoPoint[] {
  return poly.map((p) => ({ x: p.x, y: p.y }));
}

function copyExclusion(ex: AreaExclusion): AreaExclusion {
  return { id: ex.id, name: ex.name, polygon: copyPolygon(ex.polygon) };
}

function copyRecord(record: RegionAreaRecord): RegionAreaRecord {
  return {
    regionId: record.regionId,
    frameId: record.frameId,
    frameSnapshot: record.frameSnapshot,
    safePolygon: record.safePolygon === null ? null : copyPolygon(record.safePolygon),
    exclusions: record.exclusions.map(copyExclusion),
  };
}

function copyAreas(areas: AreasMap): AreasMap {
  const out: AreasMap = Object.create(null) as AreasMap;
  for (const [key, record] of Object.entries(areas)) {
    out[key] = copyRecord(record);
  }
  return out;
}

function existingArea(areas: AreasMap, regionId: string): RegionAreaRecord | undefined {
  return Object.hasOwn(areas, regionId) ? areas[regionId] : undefined;
}

function matchesFrame(area: RegionAreaRecord, region: PlanarRegionRecord): boolean {
  return area.regionId === region.regionId && area.frameId === region.frameId &&
    area.frameSnapshot === stableStringify(region);
}

function blankRecord(region: PlanarRegionRecord): RegionAreaRecord {
  return {
    regionId: region.regionId,
    frameId: region.frameId,
    frameSnapshot: stableStringify(region),
    safePolygon: null,
    exclusions: [],
  };
}

export type ParsePolygonResult =
  | { ok: true; polygon: GeoPoint[] }
  | { ok: false; error: string };

/**
 * Parse authored polygon text. Accepts JSON `[[x, y], ...]` or
 * `[{ x, y }, ...]`; coordinates must be JSON numbers (numeric strings are
 * rejected), finite, and form a valid ring per `validateSafePolygon`. An
 * optional single repeated closing vertex is accepted and stripped; winding
 * and full precision are preserved. Never mutates its input.
 */
export function parsePolygonText(text: string): ParsePolygonResult {
  if (typeof text !== "string") return err("polygon text must be a string");
  if (text.length > AREA_LIMITS.MAX_TEXT_LENGTH) {
    return err(
      `polygon text exceeds ${AREA_LIMITS.MAX_TEXT_LENGTH} characters`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err("polygon text must be a JSON array of [x, y] or { x, y } vertices");
  }
  if (!Array.isArray(parsed)) {
    return err("polygon text must be a JSON array of [x, y] or { x, y } vertices");
  }
  const points: GeoPoint[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const v = parsed[i];
    let x: unknown;
    let y: unknown;
    if (Array.isArray(v)) {
      if (v.length !== 2) {
        return err(`vertex ${i} must be an [x, y] pair or { x, y } point`);
      }
      x = v[0];
      y = v[1];
    } else if (typeof v === "object" && v !== null && "x" in v && "y" in v) {
      x = v.x;
      y = v.y;
    } else {
      return err(`vertex ${i} must be an [x, y] pair or { x, y } point`);
    }
    if (typeof x !== "number" || typeof y !== "number") {
      return err(`vertex ${i} coordinates must be numbers`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return err(`vertex ${i} coordinates must be finite numbers`);
    }
    points.push({ x, y });
  }
  // Tolerate one explicit closing vertex repeating the first point.
  if (
    points.length > 1 &&
    points[points.length - 1]!.x === points[0]!.x &&
    points[points.length - 1]!.y === points[0]!.y
  ) {
    points.pop();
  }
  if (points.length < 3) {
    return err("polygon must have at least 3 vertices");
  }
  if (points.length > AREA_LIMITS.MAX_VERTICES) {
    return err(
      `polygon exceeds ${AREA_LIMITS.MAX_VERTICES} vertices`,
    );
  }
  const check = validateSafePolygon(points);
  if (!check.ok) {
    return err(check.errors.join("; "));
  }
  return { ok: true, polygon: points };
}

export type SetSafePolygonResult =
  | { ok: true; areas: AreasMap; polygon: GeoPoint[] }
  | { ok: false; areas: AreasMap; error: string };

/**
 * Replace the safe polygon for a region. On parse/validation failure the
 * prior state is preserved untouched (the returned `areas` equals the input
 * contents). Success rebinds `frameSnapshot` to the current region.
 */
export function setSafePolygon(
  areas: AreasMap,
  region: PlanarRegionRecord,
  text: string,
): SetSafePolygonResult {
  const parsed = parsePolygonText(text);
  if (!parsed.ok) {
    return { ok: false, areas, error: parsed.error };
  }
  const prior = existingArea(areas, region.regionId);
  if (prior !== undefined && !matchesFrame(prior, region)) {
    return { ok: false, areas, error: "area frame binding is stale; remove and recreate the region" };
  }
  const next = copyAreas(areas);
  const prev = next[region.regionId] ?? blankRecord(region);
  next[region.regionId] = {
    regionId: region.regionId,
    frameId: region.frameId,
    frameSnapshot: stableStringify(region),
    safePolygon: copyPolygon(parsed.polygon),
    exclusions: prev.exclusions.map(copyExclusion),
  };
  return { ok: true, areas: next, polygon: copyPolygon(parsed.polygon) };
}

/** Clear the safe polygon; exclusions and the frame binding are kept. */
export function clearSafePolygon(
  areas: AreasMap,
  region: PlanarRegionRecord,
): { areas: AreasMap } {
  const next = copyAreas(areas);
  const prior = next[region.regionId];
  const prev = prior !== undefined && matchesFrame(prior, region) ? prior : blankRecord(region);
  next[region.regionId] = {
    regionId: region.regionId,
    frameId: region.frameId,
    frameSnapshot: stableStringify(region),
    safePolygon: null,
    exclusions: prev.exclusions.map(copyExclusion),
  };
  return { areas: next };
}

export type AddExclusionResult =
  | { ok: true; areas: AreasMap; exclusion: AreaExclusion }
  | { ok: false; areas: AreasMap; error: string };

/**
 * Add a named exclusion to a region. Each exclusion is validated
 * individually via `validateSafePolygon`; overlapping or outside-safe
 * exclusions are retained (union-obstacle semantics, see module doc).
 * Failure preserves the prior state.
 */
export function addExclusion(
  areas: AreasMap,
  region: PlanarRegionRecord,
  id: string,
  name: string,
  text: string,
): AddExclusionResult {
  if (!isValidId(id)) {
    return {
      ok: false,
      areas,
      error: `exclusion id must be a non-empty string of at most ${AREA_LIMITS.MAX_ID_LENGTH} chars`,
    };
  }
  if (!isValidName(name)) {
    return {
      ok: false,
      areas,
      error: `exclusion name must be a non-empty string of at most ${AREA_LIMITS.MAX_NAME_LENGTH} chars`,
    };
  }
  const prev = existingArea(areas, region.regionId);
  if (prev !== undefined && !matchesFrame(prev, region)) {
    return { ok: false, areas, error: "area frame binding is stale; remove and recreate the region" };
  }
  const current = prev ? prev.exclusions : [];
  if (current.some((ex) => ex.id === id)) {
    return { ok: false, areas, error: `exclusion id "${id}" already exists` };
  }
  if (current.length >= AREA_LIMITS.MAX_EXCLUSIONS_PER_REGION) {
    return {
      ok: false,
      areas,
      error: `region exceeds ${AREA_LIMITS.MAX_EXCLUSIONS_PER_REGION} exclusions`,
    };
  }
  const parsed = parsePolygonText(text);
  if (!parsed.ok) {
    return { ok: false, areas, error: parsed.error };
  }
  const next = copyAreas(areas);
  const base = next[region.regionId] ?? blankRecord(region);
  const exclusion: AreaExclusion = {
    id,
    name,
    polygon: copyPolygon(parsed.polygon),
  };
  next[region.regionId] = {
    regionId: region.regionId,
    frameId: region.frameId,
    frameSnapshot: stableStringify(region),
    safePolygon: base.safePolygon === null ? null : copyPolygon(base.safePolygon),
    exclusions: [...base.exclusions.map(copyExclusion), copyExclusion(exclusion)],
  };
  return { ok: true, areas: next, exclusion: copyExclusion(exclusion) };
}

export type RemoveExclusionResult =
  | { ok: true; areas: AreasMap }
  | { ok: false; areas: AreasMap; error: string };

/** Remove one exclusion by id; unknown ids fail without touching state. */
export function removeExclusion(
  areas: AreasMap,
  region: PlanarRegionRecord,
  id: string,
): RemoveExclusionResult {
  const prev = existingArea(areas, region.regionId);
  if (!prev || !prev.exclusions.some((ex) => ex.id === id)) {
    return { ok: false, areas, error: `exclusion id "${id}" not found` };
  }
  if (!matchesFrame(prev, region)) {
    return { ok: false, areas, error: "area frame binding is stale; remove and recreate the region" };
  }
  const next = copyAreas(areas);
  next[region.regionId] = { ...copyRecord(prev), exclusions: prev.exclusions.filter((ex) => ex.id !== id).map(copyExclusion) };
  return { ok: true, areas: next };
}

/**
 * Drop area records whose regionId has no matching region. Returns a pruned
 * copy; the input is never mutated. Callers remove the stale record first,
 * so a recreated region reusing an id starts with no inherited areas.
 */
export function pruneAreas(
  regions: PlanarRegionRecord[],
  areas: AreasMap,
): AreasMap {
  const live = new Map(regions.map((r) => [r.regionId, r]));
  const out: AreasMap = Object.create(null) as AreasMap;
  for (const [key, record] of Object.entries(areas)) {
    const region = live.get(record.regionId);
    if (region !== undefined && matchesFrame(record, region)) {
      out[key] = copyRecord(record);
    }
  }
  return out;
}

export type CheckFootprintResult =
  | { ok: true; fits: boolean; reason: string }
  | { ok: false; fits: false; error: string };

/** Check a footprint against the saved safe polygon + exclusions. */
export function checkFootprint(
  area: RegionAreaRecord | null,
  footprintText: string,
): CheckFootprintResult {
  if (area === null || area === undefined) {
    return { ok: true, fits: false, reason: "no safe region configured for this frame" };
  }
  if (area.safePolygon === null) {
    return { ok: true, fits: false, reason: "no safe polygon configured for this frame" };
  }
  const parsed = parsePolygonText(footprintText);
  if (!parsed.ok) {
    return { ok: false, fits: false, error: parsed.error };
  }
  const result = footprintFits({
    safe: area.safePolygon,
    exclusions: area.exclusions.map((ex) => ex.polygon),
    footprint: parsed.polygon,
  });
  return { ok: true, fits: result.fits, reason: result.reason };
}

export type BuildAreaBundleResult =
  | { ok: true; bundle: AreaBundle }
  | { ok: false; error: string };

/**
 * Build a deterministic export bundle. The region bundle is rebuilt via
 * `buildRegionBundle` (the supplied fit is re-verified, never trusted), the
 * evidence snapshot must match, and every area record must bind to its
 * region via `frameSnapshot === stableStringify(region)`. Areas sort by
 * regionId, exclusions by id; everything is deep-copied with no timestamps.
 */
export function buildAreaBundle(
  evidence: CalibrationEvidence,
  fit: { scaleMmPerUnit: number; inconsistent: boolean; assetFullSha256: string },
  regions: PlanarRegionRecord[],
  areas: AreasMap,
  evidenceSnapshot: string,
): BuildAreaBundleResult {
  if (typeof evidenceSnapshot !== "string" || evidenceSnapshot.length === 0) {
    return err("evidenceSnapshot must be a non-empty string");
  }
  if (typeof areas !== "object" || areas === null || Array.isArray(areas)) {
    return err("areas must be an object");
  }
  let recomputed: UniformFitResult;
  try {
    recomputed = fitUniformScale(evidence);
  } catch (e) {
    return err(
      `cannot build area bundle: calibration fit failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (recomputed.inconsistent) {
    return err("cannot build area bundle: calibration fit is inconsistent");
  }
  if (evidenceSnapshot !== snapshotEvidence(evidence)) {
    return err("cannot build area bundle: snapshot does not match calibration evidence");
  }
  if (
    typeof fit !== "object" ||
    fit === null ||
    fit.inconsistent !== recomputed.inconsistent ||
    fit.assetFullSha256 !== recomputed.assetFullSha256 ||
    recomputed.scaleMmPerUnit !== fit.scaleMmPerUnit
  ) {
    return err("cannot build area bundle: provided fit references do not match recomputed fit");
  }

  const rebuilt = buildRegionBundle(evidence, fit, regions, evidenceSnapshot);
  if (!rebuilt.ok) {
    return err(`cannot build area bundle: ${rebuilt.error}`);
  }

  const byId = new Map(regions.map((r) => [r.regionId, r]));
  const records: RegionAreaRecord[] = [];
  const seenRegions = new Set<string>();
  for (const [key, record] of Object.entries(areas)) {
    const check = validateAreaRecord(record);
    if (!check.ok) {
      return err(`cannot build area bundle: invalid area record: ${check.error}`);
    }
    if (key !== record.regionId || seenRegions.has(record.regionId)) {
      return err("cannot build area bundle: duplicate or mismatched area-map region key");
    }
    seenRegions.add(record.regionId);
    const region = byId.get(record.regionId);
    if (!region) {
      return err(
        `cannot build area bundle: area "${record.regionId}" has no matching region`,
      );
    }
    if (record.frameId !== region.frameId || record.frameSnapshot !== stableStringify(region)) {
      return err(
        `cannot build area bundle: area "${record.regionId}" frame snapshot is stale`,
      );
    }
    if (record.safePolygon !== null) {
      const safe = validateSafePolygon(record.safePolygon);
      if (!safe.ok) {
        return err(
          `cannot build area bundle: area "${record.regionId}" safe polygon invalid: ${safe.errors.join("; ")}`,
        );
      }
    }
    const seen = new Set<string>();
    for (const ex of record.exclusions) {
      if (seen.has(ex.id)) {
        return err(
          `cannot build area bundle: area "${record.regionId}" has duplicate exclusion id "${ex.id}"`,
        );
      }
      seen.add(ex.id);
      const valid = validateSafePolygon(ex.polygon);
      if (!valid.ok) {
        return err(
          `cannot build area bundle: area "${record.regionId}" exclusion "${ex.id}" invalid: ${valid.errors.join("; ")}`,
        );
      }
    }
    const copied = copyRecord(record);
    copied.exclusions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    records.push(copied);
  }
  for (const region of rebuilt.bundle.regions) {
    if (!seenRegions.has(region.regionId)) records.push(blankRecord(region));
  }
  records.sort((a, b) => (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0));

  const session = JSON.parse(JSON.stringify(rebuilt.bundle.session)) satisfies SessionExport;
  const limitations = [
    ...rebuilt.bundle.limitations,
    "provisional safe-area draft; not production approved",
    "unconfigured frames (no safe polygon) are draft-only placeholders",
  ];
  return {
    ok: true,
    bundle: {
      schemaVersion: AREA_BUNDLE_VERSION,
      pendingReview: true,
      productionApproved: false,
      session,
      regions: rebuilt.bundle.regions,
      areas: records,
      limitations,
    },
  };
}

/** Deterministic bundle text: stable key order, 2-space indent. */
export function serializeAreaBundle(bundle: AreaBundle): string {
  const ordered = {
    schemaVersion: bundle.schemaVersion,
    pendingReview: bundle.pendingReview,
    productionApproved: bundle.productionApproved,
    session: bundle.session,
    regions: bundle.regions,
    areas: bundle.areas,
    limitations: bundle.limitations,
  };
  return JSON.stringify(JSON.parse(stableStringify(ordered)), null, 2);
}

/** Structural validation of one area record (semantic checks happen at build). */
export function validateAreaRecord(
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) {
    return err("area record must be an object");
  }
  if (!("regionId" in value) || !isValidId(value.regionId)) return err("regionId must be a non-empty string of at most 256 chars");
  if (!("frameId" in value) || !isValidId(value.frameId)) return err("frameId must be a non-empty string of at most 256 chars");
  if (!("frameSnapshot" in value) || typeof value.frameSnapshot !== "string" || value.frameSnapshot.length === 0) {
    return err("frameSnapshot must be a non-empty string");
  }
  const safe: unknown = "safePolygon" in value ? value.safePolygon : undefined;
  if (safe !== null) {
    if (!Array.isArray(safe)) return err("safePolygon must be null or an array of { x, y } points");
    if (vertexCount(safe) > AREA_LIMITS.MAX_VERTICES) {
      return err(`safePolygon exceeds ${AREA_LIMITS.MAX_VERTICES} vertices`);
    }
    for (const p of safe) {
      if (!isFinitePoint(p)) {
        return err("safePolygon vertices must be finite { x, y } points");
      }
    }
  }
  if (!("exclusions" in value) || !Array.isArray(value.exclusions)) return err("exclusions must be an array");
  const exclusions: unknown[] = value.exclusions;
  if (exclusions.length > AREA_LIMITS.MAX_EXCLUSIONS_PER_REGION) {
    return err(`exclusions exceed ${AREA_LIMITS.MAX_EXCLUSIONS_PER_REGION} entries`);
  }
  for (const ex of exclusions) {
    if (typeof ex !== "object" || ex === null) return err("exclusion must be an object");
    if (!("id" in ex) || !isValidId(ex.id)) return err("exclusion id must be a non-empty string of at most 256 chars");
    if (!("name" in ex) || !isValidName(ex.name)) return err("exclusion name must be a non-empty string of at most 256 chars");
    if (!("polygon" in ex) || !Array.isArray(ex.polygon)) return err("exclusion polygon must be an array of { x, y } points");
    const poly: unknown[] = ex.polygon;
    if (vertexCount(poly) > AREA_LIMITS.MAX_VERTICES) {
      return err(`exclusion polygon exceeds ${AREA_LIMITS.MAX_VERTICES} vertices`);
    }
    for (const p of poly) {
      if (!isFinitePoint(p)) {
        return err("exclusion polygon vertices must be finite { x, y } points");
      }
    }
  }
  return { ok: true };
}
