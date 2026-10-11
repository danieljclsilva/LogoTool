/**
 * Provisional logo placements — pure draft state for synthetic logo artwork
 * positioned on calibrated planar regions (Phase 6, slice 1 — provisional,
 * pending review; never production approved).
 *
 * A `DraftLogo` is an independent synthetic logo reference (no binary bytes,
 * no pixels carried here); a `DraftPlacement` centers a w x h millimetre box
 * at `(xMm, yMm)` in a region frame with a clockwise-positive rotation facing
 * the region, normalized to (-180, 180]. Physical convention: region frame
 * +x right, +y up facing the region, all units millimetres.
 *
 * Rotated footprints are always recomputed from placement numbers (a supplied
 * footprint is never authoritative) and validated against the region's safe
 * polygon plus exclusions via the shared `footprintFits` kernel: boundary
 * contact with safe is allowed, any touch/overlap with exclusions fails, and
 * concave-notch escapes fail. Geometrically-invalid-but-wellformed placements
 * (outside safe, exclusion hit) remain saveable/editable with an explicit per
 * placement status (`fits: false` plus reason); malformed or
 * reference-invalid drafts (bad ids, dangling logo/region refs,
 * nonfinite/overflow, duplicate ids) fail atomically with a single error and
 * never produce partial state.
 *
 * Limits below are provisional draft guards (pending review), not schema
 * finalization. Pure module: no DOM/Node/Three imports.
 */

import {
  fitUniformScale,
  type CalibrationEvidence,
} from "../calibration/index.js";
import {
  snapshotEvidence,
  stableStringify,
  type SessionExport,
} from "../calibration-session/index.js";
import {
  footprintFits,
  type GeoPoint,
} from "../geometry/index.js";
import type { PlanarRegionRecord } from "../planar-region/index.js";
import {
  buildAreaBundle,
  type AreasMap,
  type RegionAreaRecord,
} from "../region-areas/index.js";

/** Provisional placement-bundle envelope version (restored only via logo-placement-restore). */
export const PLACEMENT_BUNDLE_VERSION =
  "0.1.0-provisional-logo-placements" as const;

/** Provisional draft guards (pending review): bounds before kernel work. */
export const PLACEMENT_LIMITS = {
  maxChars: 8388608,
  maxPlacements: 256,
  maxLogos: 64,
  maxIdLength: 256,
  maxDimMm: 100000,
  maxCoordMm: 1000000,
} as const;

/** Independent synthetic logo reference (no binary bytes carried). */
export interface DraftLogo {
  id: string;
  name: string;
  widthPx?: number;
  heightPx?: number;
}

/** One w x h mm box centered at (xMm, yMm) with clockwise rotation. */
export interface DraftPlacement {
  id: string;
  logoId: string;
  regionId: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Clockwise-positive facing the region, normalized to (-180, 180]. */
  rotationDeg: number;
}

export type LogosMap = Record<string, DraftLogo>;
export type PlacementsMap = Record<string, DraftPlacement>;

/** Per-placement fit verdict with the recomputed footprint. */
export interface PlacementStatus {
  id: string;
  fits: boolean;
  reason: string;
  footprint: GeoPoint[];
}

export interface PlacementBundle {
  schemaVersion: typeof PLACEMENT_BUNDLE_VERSION;
  pendingReview: true;
  productionApproved: false;
  session: SessionExport;
  regions: PlanarRegionRecord[];
  areas: RegionAreaRecord[];
  logos: DraftLogo[];
  placements: DraftPlacement[];
  statuses: PlacementStatus[];
  limitations: string[];
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= PLACEMENT_LIMITS.maxIdLength
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyLogo(logo: DraftLogo): DraftLogo {
  const out: DraftLogo = { id: logo.id, name: logo.name };
  if (logo.widthPx !== undefined) out.widthPx = logo.widthPx;
  if (logo.heightPx !== undefined) out.heightPx = logo.heightPx;
  return out;
}

function copyPlacement(placement: DraftPlacement): DraftPlacement {
  return {
    id: placement.id,
    logoId: placement.logoId,
    regionId: placement.regionId,
    xMm: placement.xMm,
    yMm: placement.yMm,
    widthMm: placement.widthMm,
    heightMm: placement.heightMm,
    rotationDeg: placement.rotationDeg,
  };
}

/**
 * Null-prototype-safe map copies with fresh values, so ids such as
 * "__proto__" round-trip as real keys instead of prototype assignments.
 */
function copyLogos(logos: LogosMap): LogosMap {
  const out: LogosMap = Object.create(null);
  for (const [key, logo] of Object.entries(logos)) {
    out[key] = copyLogo(logo);
  }
  return out;
}

function copyPlacements(placements: PlacementsMap): PlacementsMap {
  const out: PlacementsMap = Object.create(null);
  for (const [key, placement] of Object.entries(placements)) {
    out[key] = copyPlacement(placement);
  }
  return out;
}

/**
 * Rotated footprint: the 4 corners of the w x h box about (xMm, yMm) under a
 * clockwise rotation of `rotationDeg` degrees. Corner offsets in order are
 * (-w/2,-h/2), (w/2,-h/2), (w/2,h/2), (-w/2,h/2) mapped by
 * x' = x + dx*cos + dy*sin, y' = y - dx*sin + dy*cos. Throws on nonfinite
 * input or a nonfinite (overflowed) corner; never returns NaN.
 */
export function placementFootprint(placement: DraftPlacement): GeoPoint[] {
  const fields: Array<[string, unknown]> = [
    ["xMm", placement.xMm],
    ["yMm", placement.yMm],
    ["widthMm", placement.widthMm],
    ["heightMm", placement.heightMm],
    ["rotationDeg", placement.rotationDeg],
  ];
  for (const [label, value] of fields) {
    if (!isFiniteNumber(value)) {
      throw new Error(
        `placement footprint: ${label} must be a finite number`,
      );
    }
  }
  const theta = (placement.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const halfW = placement.widthMm / 2;
  const halfH = placement.heightMm / 2;
  const offsets: Array<[number, number]> = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ];
  const corners = offsets.map(([dx, dy]) => ({
    x: placement.xMm + dx * cos + dy * sin,
    y: placement.yMm - dx * sin + dy * cos,
  }));
  for (const corner of corners) {
    if (!Number.isFinite(corner.x) || !Number.isFinite(corner.y)) {
      throw new Error(
        "placement footprint: computed corner is non-finite (overflow)",
      );
    }
  }
  return corners;
}

/** Structural validation of one logo (reference checks happen at build). */
export function validateDraftLogo(
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!isPlainObject(value)) return err("logo must be an object");
  if (!isValidId(value["id"])) {
    return err("logo id must be a non-empty string of at most 256 chars");
  }
  const name: unknown = value["name"];
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.length > PLACEMENT_LIMITS.maxIdLength
  ) {
    return err("logo name must be a non-empty string of at most 256 chars");
  }
  for (const key of ["widthPx", "heightPx"] as const) {
    const dim: unknown = value[key];
    if (dim !== undefined) {
      if (!isFiniteNumber(dim) || !(dim > 0)) {
        return err(`logo ${key} must be a finite number > 0 when present`);
      }
    }
  }
  return { ok: true };
}

/**
 * Structural validation of one placement. Numeric bounds, the (-180, 180]
 * rotation range, and id shapes are enforced here; logo/region existence is
 * checked against the supplied maps so dangling references fail atomically
 * at add/update/build/restore time (builders always recheck).
 */
export function validateDraftPlacement(
  value: unknown,
  logos: LogosMap,
  regionIds: readonly string[],
): { ok: true } | { ok: false; error: string } {
  if (!isPlainObject(value)) return err("placement must be an object");
  if (!isValidId(value["id"])) {
    return err("placement id must be a non-empty string of at most 256 chars");
  }
  const logoId: unknown = value["logoId"];
  if (!isValidId(logoId)) {
    return err("placement logoId must be a non-empty string of at most 256 chars");
  }
  const regionId: unknown = value["regionId"];
  if (!isValidId(regionId)) {
    return err(
      "placement regionId must be a non-empty string of at most 256 chars",
    );
  }
  for (const key of ["xMm", "yMm"] as const) {
    const coord: unknown = value[key];
    if (!isFiniteNumber(coord)) {
      return err(`placement ${key} must be a finite number`);
    }
    if (Math.abs(coord) > PLACEMENT_LIMITS.maxCoordMm) {
      return err(
        `placement ${key} exceeds ${PLACEMENT_LIMITS.maxCoordMm} mm in magnitude`,
      );
    }
  }
  for (const key of ["widthMm", "heightMm"] as const) {
    const dim: unknown = value[key];
    if (!isFiniteNumber(dim)) {
      return err(`placement ${key} must be a finite number`);
    }
    if (!(dim > 0) || dim > PLACEMENT_LIMITS.maxDimMm) {
      return err(
        `placement ${key} must be > 0 and at most ${PLACEMENT_LIMITS.maxDimMm} mm`,
      );
    }
  }
  const rotation: unknown = value["rotationDeg"];
  if (!isFiniteNumber(rotation)) {
    return err("placement rotationDeg must be a finite number");
  }
  if (!(rotation > -180) || !(rotation <= 180)) {
    return err("placement rotationDeg must be in (-180, 180]");
  }
  const placementId: unknown = value["id"];
  if (!Object.hasOwn(logos, logoId)) {
    return err(`placement "${String(placementId)}" references unknown logoId "${logoId}"`);
  }
  if (!regionIds.includes(regionId)) {
    return err(
      `placement "${String(placementId)}" references unknown regionId "${regionId}"`,
    );
  }
  return { ok: true };
}

export type AddLogoResult =
  | { ok: true; logos: LogosMap; logo: DraftLogo }
  | { ok: false; logos: LogosMap; error: string };

/** Add a logo; immutable, input preserved untouched on failure. */
export function addLogo(logos: LogosMap, logo: DraftLogo): AddLogoResult {
  const check = validateDraftLogo(logo);
  if (!check.ok) return { ok: false, logos, error: check.error };
  if (Object.hasOwn(logos, logo.id)) {
    return { ok: false, logos, error: `duplicate logo id "${logo.id}"` };
  }
  const next = copyLogos(logos);
  next[logo.id] = copyLogo(logo);
  return { ok: true, logos: next, logo: copyLogo(logo) };
}

export type RemoveLogoResult =
  | { ok: true; logos: LogosMap }
  | { ok: false; logos: LogosMap; error: string };

/** Remove a logo; fails when any placement still references it. */
export function removeLogo(
  logos: LogosMap,
  placements: PlacementsMap,
  id: string,
): RemoveLogoResult {
  if (!Object.hasOwn(logos, id)) {
    return { ok: false, logos, error: `unknown logo id "${id}"` };
  }
  for (const placement of Object.values(placements)) {
    if (placement.logoId === id) {
      return {
        ok: false,
        logos,
        error: `cannot remove logo "${id}": still referenced by placement "${placement.id}"`,
      };
    }
  }
  const next = copyLogos(logos);
  delete next[id];
  return { ok: true, logos: next };
}

export type AddPlacementResult =
  | { ok: true; placements: PlacementsMap; placement: DraftPlacement }
  | { ok: false; placements: PlacementsMap; error: string };

/** Add a placement; immutable, input preserved untouched on failure. */
export function addPlacement(
  placements: PlacementsMap,
  placement: DraftPlacement,
  logos: LogosMap,
  regionIds: readonly string[],
): AddPlacementResult {
  const check = validateDraftPlacement(placement, logos, regionIds);
  if (!check.ok) return { ok: false, placements, error: check.error };
  if (Object.hasOwn(placements, placement.id)) {
    return {
      ok: false,
      placements,
      error: `duplicate placement id "${placement.id}"`,
    };
  }
  const next = copyPlacements(placements);
  next[placement.id] = copyPlacement(placement);
  return { ok: true, placements: next, placement: copyPlacement(placement) };
}

export type UpdatePlacementResult =
  | { ok: true; placements: PlacementsMap; placement: DraftPlacement }
  | { ok: false; placements: PlacementsMap; error: string };

/**
 * Patch a placement by id; immutable, input preserved on failure. The id
 * itself cannot change (a patch carrying a different id fails).
 */
export function updatePlacement(
  placements: PlacementsMap,
  id: string,
  patch: Partial<DraftPlacement>,
  logos: LogosMap,
  regionIds: readonly string[],
): UpdatePlacementResult {
  const current = Object.hasOwn(placements, id) ? placements[id] : undefined;
  if (current === undefined) {
    return { ok: false, placements, error: `unknown placement id "${id}"` };
  }
  if (patch.id !== undefined && patch.id !== id) {
    return { ok: false, placements, error: "placement id cannot change" };
  }
  const merged: DraftPlacement = { ...copyPlacement(current), ...patch, id };
  const check = validateDraftPlacement(merged, logos, regionIds);
  if (!check.ok) return { ok: false, placements, error: check.error };
  const next = copyPlacements(placements);
  next[id] = merged;
  return { ok: true, placements: next, placement: copyPlacement(merged) };
}

export type RemovePlacementResult =
  | { ok: true; placements: PlacementsMap }
  | { ok: false; placements: PlacementsMap; error: string };

/** Remove one placement by id; unknown ids fail without touching state. */
export function removePlacement(
  placements: PlacementsMap,
  id: string,
): RemovePlacementResult {
  if (!Object.hasOwn(placements, id)) {
    return { ok: false, placements, error: `unknown placement id "${id}"` };
  }
  const next = copyPlacements(placements);
  delete next[id];
  return { ok: true, placements: next };
}

/**
 * Drop placements whose logoId has no matching logo or whose regionId is not
 * among the supplied regions. Returns a pruned copy plus the sorted dropped
 * ids; the input is never mutated. Accepts region records or plain ids.
 */
export function prunePlacements(
  placements: PlacementsMap,
  logos: LogosMap,
  regions: readonly PlanarRegionRecord[] | readonly string[],
): { placements: PlacementsMap; dropped: string[] } {
  const regionIds: Record<string, true> = Object.create(null);
  for (const region of regions) {
    regionIds[typeof region === "string" ? region : region.regionId] = true;
  }
  const kept: PlacementsMap = Object.create(null);
  const dropped: string[] = [];
  for (const [key, placement] of Object.entries(placements)) {
    if (
      !Object.hasOwn(logos, placement.logoId) ||
      !Object.hasOwn(regionIds, placement.regionId)
    ) {
      dropped.push(key);
    } else {
      kept[key] = copyPlacement(placement);
    }
  }
  dropped.sort();
  return { placements: kept, dropped };
}

export type CheckPlacementFootprintResult =
  | { ok: true; fits: boolean; reason: string; footprint: GeoPoint[] }
  | { ok: false; error: string };

/**
 * Check one placement against a region area record. The footprint is always
 * recomputed from placement numbers. A null area (or a record with no safe
 * polygon) is a clean `fits: false` verdict, never an error.
 */
export function checkPlacementFootprint(
  placement: DraftPlacement,
  area: RegionAreaRecord | null | undefined,
): CheckPlacementFootprintResult {
  let footprint: GeoPoint[];
  try {
    footprint = placementFootprint(placement);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (area === null || area === undefined || area.safePolygon === null) {
    return {
      ok: true,
      fits: false,
      reason: "no safe polygon configured for region",
      footprint,
    };
  }
  try {
    const result = footprintFits({
      safe: area.safePolygon,
      exclusions: area.exclusions.map((ex) => ex.polygon),
      footprint,
    });
    return {
      ok: true,
      fits: result.fits,
      reason: result.reason,
      footprint,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Status for every placement, sorted by placement id. Malformed entries
 * (bad numbers, dangling refs, nonfinite corners) never throw: they produce
 * `fits: false` with the structural reason and an empty footprint.
 */
export function statusAll(
  placements: PlacementsMap,
  logos: LogosMap,
  areas: AreasMap,
): PlacementStatus[] {
  const regionIds = Object.keys(areas);
  return Object.keys(placements)
    .sort()
    .map((key) => {
      const placement =
        Object.hasOwn(placements, key) ? placements[key] : undefined;
      if (placement === undefined) {
        return { id: key, fits: false, reason: "placement entry is missing", footprint: [] };
      }
      const check = validateDraftPlacement(placement, logos, regionIds);
      if (!check.ok) {
        return { id: placement.id, fits: false, reason: check.error, footprint: [] };
      }
      let footprint: GeoPoint[];
      try {
        footprint = placementFootprint(placement);
      } catch (e) {
        return {
          id: placement.id,
          fits: false,
          reason: e instanceof Error ? e.message : String(e),
          footprint: [],
        };
      }
      const area =
        Object.hasOwn(areas, placement.regionId)
          ? areas[placement.regionId]
          : undefined;
      if (area === undefined || area.safePolygon === null) {
        return {
          id: placement.id,
          fits: false,
          reason: "no safe polygon configured for region",
          footprint,
        };
      }
      try {
        const result = footprintFits({
          safe: area.safePolygon,
          exclusions: area.exclusions.map((ex) => ex.polygon),
          footprint,
        });
        return {
          id: placement.id,
          fits: result.fits,
          reason: result.reason,
          footprint,
        };
      } catch (e) {
        return {
          id: placement.id,
          fits: false,
          reason: e instanceof Error ? e.message : String(e),
          footprint,
        };
      }
    });
}

export type BuildPlacementBundleResult =
  | { ok: true; bundle: PlacementBundle }
  | { ok: false; error: string };

/**
 * Build a deterministic export bundle. The fit is re-verified with
 * `fitUniformScale` (never trusted), regions and areas are rebuilt through
 * `buildAreaBundle` (stale frame snapshots fail), and every logo/placement is
 * revalidated: duplicate ids and dangling logoId/regionId refs fail
 * atomically. Repeated placements of the same logo (same or different
 * regions) are independent and allowed. Logos/placements sort by id;
 * everything is deep-copied with no timestamps. The bundle is always
 * pending-review and never production approved.
 */
export function buildPlacementBundle(
  evidence: CalibrationEvidence,
  fit: {
    scaleMmPerUnit: number;
    inconsistent: boolean;
    assetFullSha256: string;
  },
  regions: PlanarRegionRecord[],
  areas: AreasMap,
  logos: LogosMap,
  placements: PlacementsMap,
  evidenceSnapshot: string,
): BuildPlacementBundleResult {
  if (typeof evidenceSnapshot !== "string" || evidenceSnapshot.length === 0) {
    return err("evidenceSnapshot must be a non-empty string");
  }
  if (!Array.isArray(regions)) return err("regions must be an array");
  if (typeof logos !== "object" || logos === null || Array.isArray(logos)) {
    return err("logos must be an object");
  }
  if (
    typeof placements !== "object" ||
    placements === null ||
    Array.isArray(placements)
  ) {
    return err("placements must be an object");
  }
  const logoEntries = Object.entries(logos);
  if (logoEntries.length > PLACEMENT_LIMITS.maxLogos) {
    return err(
      `cannot build placement bundle: too many logos (${logoEntries.length} > ${PLACEMENT_LIMITS.maxLogos})`,
    );
  }
  const placementEntries = Object.entries(placements);
  if (placementEntries.length > PLACEMENT_LIMITS.maxPlacements) {
    return err(
      `cannot build placement bundle: too many placements (${placementEntries.length} > ${PLACEMENT_LIMITS.maxPlacements})`,
    );
  }

  let recomputed: {
    scaleMmPerUnit: number;
    inconsistent: boolean;
    assetFullSha256: string;
  };
  try {
    recomputed = fitUniformScale(evidence);
  } catch (e) {
    return err(
      `cannot build placement bundle: calibration fit failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (recomputed.inconsistent) {
    return err("cannot build placement bundle: calibration fit is inconsistent");
  }
  if (evidenceSnapshot !== snapshotEvidence(evidence)) {
    return err(
      "cannot build placement bundle: snapshot does not match calibration evidence",
    );
  }
  if (
    typeof fit !== "object" ||
    fit === null ||
    fit.inconsistent !== recomputed.inconsistent ||
    fit.assetFullSha256 !== recomputed.assetFullSha256 ||
    recomputed.scaleMmPerUnit !== fit.scaleMmPerUnit
  ) {
    return err(
      "cannot build placement bundle: provided fit references do not match recomputed fit",
    );
  }

  const seenLogos: Record<string, true> = Object.create(null);
  for (const [key, logo] of logoEntries) {
    const check = validateDraftLogo(logo);
    if (!check.ok) {
      return err(`cannot build placement bundle: invalid logo "${key}": ${check.error}`);
    }
    if (key !== logo.id) {
      return err(
        `cannot build placement bundle: logo-map key "${key}" does not match logo id "${logo.id}"`,
      );
    }
    if (Object.hasOwn(seenLogos, logo.id)) {
      return err(
        `cannot build placement bundle: duplicate logo id "${logo.id}"`,
      );
    }
    seenLogos[logo.id] = true;
  }

  const regionIds = regions.map((region) => region.regionId);
  const seenPlacements: Record<string, true> = Object.create(null);
  for (const [key, placement] of placementEntries) {
    if (!isPlainObject(placement)) {
      return err(
        `cannot build placement bundle: invalid placement "${key}": placement must be an object`,
      );
    }
    if (key !== (placement as DraftPlacement).id) {
      return err(
        `cannot build placement bundle: placement-map key "${key}" does not match placement id`,
      );
    }
    if (Object.hasOwn(seenPlacements, placement.id)) {
      return err(
        `cannot build placement bundle: duplicate placement id "${placement.id}"`,
      );
    }
    seenPlacements[placement.id] = true;
    const check = validateDraftPlacement(placement, logos, regionIds);
    if (!check.ok) {
      return err(
        `cannot build placement bundle: invalid placement "${key}": ${check.error}`,
      );
    }
  }

  const rebuilt = buildAreaBundle(evidence, fit, regions, areas, evidenceSnapshot);
  if (!rebuilt.ok) {
    return err(`cannot build placement bundle: ${rebuilt.error}`);
  }
  const areaBundle = rebuilt.bundle;
  const areaMap: AreasMap = Object.create(null);
  for (const record of areaBundle.areas) {
    areaMap[record.regionId] = record;
  }

  const sortedLogos = logoEntries
    .map(([, logo]) => copyLogo(logo))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedPlacements = placementEntries
    .map(([, placement]) => copyPlacement(placement))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const logoMap: LogosMap = Object.create(null);
  for (const logo of sortedLogos) {
    logoMap[logo.id] = logo;
  }
  const placementMap: PlacementsMap = Object.create(null);
  for (const placement of sortedPlacements) {
    placementMap[placement.id] = placement;
  }
  const statuses = statusAll(placementMap, logoMap, areaMap);

  // JSON round-trips detach every nested object; each target is freshly
  // annotated so no shape assertion is needed on the parsed `any`.
  const session: SessionExport = JSON.parse(JSON.stringify(areaBundle.session));
  const bundleRegions: PlanarRegionRecord[] = JSON.parse(
    JSON.stringify(areaBundle.regions),
  );
  const bundleAreas: RegionAreaRecord[] = JSON.parse(
    JSON.stringify(areaBundle.areas),
  );

  return {
    ok: true,
    bundle: {
      schemaVersion: PLACEMENT_BUNDLE_VERSION,
      pendingReview: true,
      productionApproved: false,
      session,
      regions: bundleRegions,
      areas: bundleAreas,
      logos: sortedLogos,
      placements: sortedPlacements,
      statuses,
      limitations: [
        ...areaBundle.limitations,
        "provisional logo-placement draft; not production approved",
        "previews derive from physical mm via planar mapping; mesh/pixels never authoritative",
      ],
    },
  };
}

/** Deterministic bundle text: stable key order, 2-space indent. */
export function serializePlacementBundle(bundle: PlacementBundle): string {
  const ordered = {
    schemaVersion: bundle.schemaVersion,
    pendingReview: bundle.pendingReview,
    productionApproved: bundle.productionApproved,
    session: bundle.session,
    regions: bundle.regions,
    areas: bundle.areas,
    logos: bundle.logos,
    placements: bundle.placements,
    statuses: bundle.statuses,
    limitations: bundle.limitations,
  };
  return JSON.stringify(JSON.parse(stableStringify(ordered)), null, 2);
}
