/**
 * Oriented planar region frames authored from calibration anchors.
 *
 * Pure core kernel: no browser/Node/Three/DOM imports. All data is copied
 * in and out; caller inputs are never mutated. No timestamps, no randomness.
 *
 * Core validation here can only gate structural consistency — it can never
 * endorse production use. Every bundle produced by this module carries
 * `pendingReview: true` and `productionApproved: false`; production approval
 * is a human review decision outside core.
 */

import {
  createPlanarMapping,
  fitUniformScale,
  type CalibrationEvidence,
  type PlanarMapping,
  type UniformFitResult,
} from "../calibration/index.js";

import { snapshotEvidence, stableStringify, buildSessionExport, type SessionExport } from "../calibration-session/index.js";

export interface PlanarRegionVec3 { x: number; y: number; z: number }
export interface PlanarRegionRecord {
  regionId: string; frameId: string;
  originAnchorId: string; xAnchorId: string; yAnchorId: string;
  origin: PlanarRegionVec3; xAxis: PlanarRegionVec3; yAxis: PlanarRegionVec3; normal: PlanarRegionVec3;
  mmPerModelUnit: number; offPlaneToleranceMm: number;
  assetFullSha256: string; product: string; variant: string;
  calibrationId: string; calibrationFrameId: string; provisionalVersion: string;
  sourceEvidenceSnapshot: string;
}
export interface RegionAxesFrame {
  origin: PlanarRegionVec3; xDir: PlanarRegionVec3; yDir: PlanarRegionVec3;
  lengthMm: number; mmPerModelUnit: number;
}

export const PLANAR_REGION_BUNDLE_VERSION = "0.1.0-provisional-planar-regions" as const;

export interface PlanarRegionInput {
  regionId: string;
  frameId: string;
  originAnchorId: string;
  xAnchorId: string;
  yAnchorId: string;
  offPlaneToleranceMm: number;
}

export interface PlanarRegionAnchor {
  id: string;
  model: PlanarRegionVec3;
}

export interface RegionBundle {
  schemaVersion: typeof PLANAR_REGION_BUNDLE_VERSION;
  pendingReview: true;
  productionApproved: false;
  session: SessionExport;
  regions: PlanarRegionRecord[];
  limitations: string[];
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ID_LENGTH = 256;
/** Minimum |yPerp| / |oyRaw| accepted; below this the axes are treated as (near-)collinear. */
const MIN_PERP_RATIO = 1e-6;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isFiniteVec3(value: unknown): value is PlanarRegionVec3 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v["x"]) && isFiniteNumber(v["y"]) && isFiniteNumber(v["z"]);
}

function copyVec3(v: PlanarRegionVec3): PlanarRegionVec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function dot(a: PlanarRegionVec3, b: PlanarRegionVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: PlanarRegionVec3, b: PlanarRegionVec3): PlanarRegionVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function norm(v: PlanarRegionVec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

export function createPlanarRegion(
  input: PlanarRegionInput,
  anchors: PlanarRegionAnchor[],
  evidence: CalibrationEvidence,
  evidenceSnapshot: string,
): { ok: true; region: PlanarRegionRecord; mapping: PlanarMapping } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return err("planar region input must be an object");
  if (!isValidId(input.regionId)) return err("regionId must be a non-empty string of at most 256 chars");
  if (!isValidId(input.frameId)) return err("frameId must be a non-empty string of at most 256 chars");
  if (!isValidId(input.originAnchorId)) return err("originAnchorId must be a non-empty string of at most 256 chars");
  if (!isValidId(input.xAnchorId)) return err("xAnchorId must be a non-empty string of at most 256 chars");
  if (!isValidId(input.yAnchorId)) return err("yAnchorId must be a non-empty string of at most 256 chars");
  if (
    input.originAnchorId === input.xAnchorId ||
    input.originAnchorId === input.yAnchorId ||
    input.xAnchorId === input.yAnchorId
  ) {
    return err("origin, x, and y anchor ids must be pairwise distinct");
  }
  if (!isFiniteNumber(input.offPlaneToleranceMm) || input.offPlaneToleranceMm < 0) {
    return err("offPlaneToleranceMm must be a finite number >= 0");
  }

  if (typeof evidence !== "object" || evidence === null) return err("evidence must be an object");
  if (!isValidId(evidence.calibrationId)) return err("evidence calibrationId must be a non-empty string of at most 256 chars");
  if (!isValidId(evidence.frameId)) return err("evidence frameId must be a non-empty string of at most 256 chars");
  if (!isValidId(evidence.product)) return err("evidence product must be a non-empty string of at most 256 chars");
  if (!isValidId(evidence.variant)) return err("evidence variant must be a non-empty string of at most 256 chars");
  if (!isValidId(evidence.provisionalVersion)) return err("evidence provisionalVersion must be a non-empty string of at most 256 chars");
  if (typeof evidence.assetFullSha256 !== "string" || !SHA256_HEX_PATTERN.test(evidence.assetFullSha256)) {
    return err("evidence assetFullSha256 must match /^[0-9a-f]{64}$/");
  }
  if (typeof evidenceSnapshot !== "string" || evidenceSnapshot.length === 0) {
    return err("evidenceSnapshot must be a non-empty string");
  }

  if (!Array.isArray(anchors)) return err("anchors must be an array");
  const findAnchor = (id: string): PlanarRegionAnchor | undefined =>
    anchors.find((a) => typeof a === "object" && a !== null && a.id === id);
  const oAnchor = findAnchor(input.originAnchorId);
  const xAnchor = findAnchor(input.xAnchorId);
  const yAnchor = findAnchor(input.yAnchorId);
  if (oAnchor === undefined) return err(`origin anchor "${input.originAnchorId}" not found`);
  if (xAnchor === undefined) return err(`x anchor "${input.xAnchorId}" not found`);
  if (yAnchor === undefined) return err(`y anchor "${input.yAnchorId}" not found`);
  if (!isFiniteVec3(oAnchor.model)) return err("origin anchor model must be a 3D vector of finite numbers");
  if (!isFiniteVec3(xAnchor.model)) return err("x anchor model must be a 3D vector of finite numbers");
  if (!isFiniteVec3(yAnchor.model)) return err("y anchor model must be a 3D vector of finite numbers");

  let fit: UniformFitResult;
  try {
    fit = fitUniformScale(evidence);
  } catch (e) {
    return err(`cannot create region: calibration fit failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (evidenceSnapshot !== snapshotEvidence(evidence)) {
    return err("cannot create region: snapshot does not match calibration evidence");
  }
  for (const anchor of [oAnchor, xAnchor, yAnchor]) {
    const source = evidence.pairs.find(pair => pair.id === anchor.id);
    if (source === undefined || stableStringify(source.model) !== stableStringify(anchor.model)) {
      return err(`cannot create region: anchor "${anchor.id}" does not match calibration evidence`);
    }
  }
  // Consistency is never approval: an inconsistent fit blocks region creation.
  if (fit.inconsistent) return err("cannot create region: calibration fit is inconsistent");
  if (!isFiniteNumber(fit.scaleMmPerUnit) || !(fit.scaleMmPerUnit > 0)) {
    return err("cannot create region: calibration fit scale must be a finite number > 0");
  }
  if (fit.assetFullSha256 !== evidence.assetFullSha256) {
    return err("cannot create region: calibration fit sha does not match evidence sha");
  }

  const O = copyVec3(oAnchor.model);
  const X = copyVec3(xAnchor.model);
  const Y = copyVec3(yAnchor.model);
  const ox: PlanarRegionVec3 = { x: X.x - O.x, y: X.y - O.y, z: X.z - O.z };
  const oyRaw: PlanarRegionVec3 = { x: Y.x - O.x, y: Y.y - O.y, z: Y.z - O.z };
  if (!isFiniteVec3(ox) || !isFiniteVec3(oyRaw)) {
    return err("cannot create region: anchor span is nonfinite (possible arithmetic overflow)");
  }
  const nx = norm(ox);
  const nyRaw = norm(oyRaw);
  if (!Number.isFinite(nx) || !(nx > 0)) return err("cannot create region: origin-to-X span must be nonzero and finite");
  if (!Number.isFinite(nyRaw) || !(nyRaw > 0)) return err("cannot create region: origin-to-Y span must be nonzero and finite");

  const xHat: PlanarRegionVec3 = { x: ox.x / nx, y: ox.y / nx, z: ox.z / nx };
  if (!isFiniteVec3(xHat)) return err("cannot create region: X axis normalization is nonfinite");
  const d = dot(oyRaw, xHat);
  if (!Number.isFinite(d)) return err("cannot create region: axis projection is nonfinite");
  // yPerp points toward the Y anchor by construction: it is the component of
  // the raw origin->Y vector orthogonal to xHat (Gram-Schmidt projection).
  // Orthogonality of the raw inputs is never assumed.
  const yPerp: PlanarRegionVec3 = {
    x: oyRaw.x - d * xHat.x,
    y: oyRaw.y - d * xHat.y,
    z: oyRaw.z - d * xHat.z,
  };
  if (!isFiniteVec3(yPerp)) {
    return err("cannot create region: Y perpendicular is nonfinite (possible arithmetic overflow)");
  }
  const nPerp = norm(yPerp);
  if (!Number.isFinite(nPerp)) return err("cannot create region: Y perpendicular norm is nonfinite");
  if (!(nPerp / nyRaw >= MIN_PERP_RATIO)) {
    return err("cannot create region: Y anchor is coincident, collinear, or near-parallel with the X axis");
  }
  const yHat: PlanarRegionVec3 = { x: yPerp.x / nPerp, y: yPerp.y / nPerp, z: yPerp.z / nPerp };
  if (!isFiniteVec3(yHat)) return err("cannot create region: Y axis normalization is nonfinite");

  let mapping: PlanarMapping;
  try {
    mapping = createPlanarMapping({
      frameId: input.frameId,
      origin: copyVec3(O),
      xAxis: copyVec3(xHat),
      yAxis: copyVec3(yHat),
      mmPerModelUnit: fit.scaleMmPerUnit,
      offPlaneToleranceMm: input.offPlaneToleranceMm,
    });
  } catch (e) {
    return err(`cannot create region: planar mapping failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const region: PlanarRegionRecord = {
    regionId: input.regionId,
    frameId: input.frameId,
    originAnchorId: input.originAnchorId,
    xAnchorId: input.xAnchorId,
    yAnchorId: input.yAnchorId,
    origin: copyVec3(O),
    xAxis: copyVec3(xHat),
    yAxis: copyVec3(yHat),
    normal: copyVec3(mapping.normal),
    mmPerModelUnit: fit.scaleMmPerUnit,
    offPlaneToleranceMm: input.offPlaneToleranceMm,
    assetFullSha256: evidence.assetFullSha256,
    product: evidence.product,
    variant: evidence.variant,
    calibrationId: evidence.calibrationId,
    calibrationFrameId: evidence.frameId,
    provisionalVersion: evidence.provisionalVersion,
    sourceEvidenceSnapshot: evidenceSnapshot,
  };
  return { ok: true, region, mapping };
}

export function regionToAxesFrame(region: PlanarRegionRecord): RegionAxesFrame {
  return {
    origin: copyVec3(region.origin),
    xDir: copyVec3(region.xAxis),
    yDir: copyVec3(region.yAxis),
    lengthMm: 100,
    mmPerModelUnit: region.mmPerModelUnit,
  };
}

export function probeRegionPoint(
  region: PlanarRegionRecord,
  modelPoint: PlanarRegionVec3,
): { point: { x: number; y: number }; offPlaneMm: number } | { error: string } {
  if (!isFiniteVec3(modelPoint)) return { error: "modelPoint must be a 3D vector of finite numbers" };
  // Rebuild the mapping from the record's own stored fields; never trust an
  // external mapping object.
  try {
  const mapping = createPlanarMapping({
    frameId: region.frameId,
    origin: copyVec3(region.origin),
    xAxis: copyVec3(region.xAxis),
    yAxis: copyVec3(region.yAxis),
    mmPerModelUnit: region.mmPerModelUnit,
    offPlaneToleranceMm: region.offPlaneToleranceMm,
  });
  return mapping.toPhysicalMm(copyVec3(modelPoint));
  } catch (error) {
    return { error: `invalid region: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function isRegionStale(region: PlanarRegionRecord, currentEvidenceSnapshot: string): boolean {
  return region.sourceEvidenceSnapshot !== currentEvidenceSnapshot;
}

export function buildRegionBundle(
  evidence: CalibrationEvidence,
  fit: { scaleMmPerUnit: number; inconsistent: boolean; assetFullSha256: string },
  regions: PlanarRegionRecord[],
  evidenceSnapshot: string,
): { ok: true; bundle: RegionBundle } | { ok: false; error: string } {
  if (typeof evidenceSnapshot !== "string" || evidenceSnapshot.length === 0) {
    return err("evidenceSnapshot must be a non-empty string");
  }
  if (!Array.isArray(regions)) return err("regions must be an array");

  let recomputed: UniformFitResult;
  try {
    recomputed = fitUniformScale(evidence);
  } catch (e) {
    return err(`cannot build bundle: calibration fit failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (recomputed.inconsistent) return err("cannot build bundle: calibration fit is inconsistent");
  if (evidenceSnapshot !== snapshotEvidence(evidence)) return err("cannot build bundle: snapshot does not match calibration evidence");
  if (typeof fit !== "object" || fit === null || fit.inconsistent !== recomputed.inconsistent || fit.assetFullSha256 !== recomputed.assetFullSha256) {
    return err("cannot build bundle: provided fit references do not match recomputed fit");
  }
  // The external fit object is never authoritative: it must match a locally
  // recomputed fit exactly.
  if (recomputed.scaleMmPerUnit !== fit.scaleMmPerUnit) {
    return err("cannot build bundle: provided fit scale does not match the recomputed fit");
  }

  const seen = new Set<string>();
  const frames = new Set<string>();
  for (const r of regions) {
    const check = validateRegionRecord(r);
    if (!check.ok) return err(`cannot build bundle: invalid region record: ${check.error}`);
    const rec = r as PlanarRegionRecord;
    if (seen.has(rec.regionId)) return err(`cannot build bundle: duplicate regionId "${rec.regionId}"`);
    seen.add(rec.regionId);
    if (frames.has(rec.frameId)) return err(`cannot build bundle: duplicate frameId "${rec.frameId}"`);
    frames.add(rec.frameId);
    if (rec.sourceEvidenceSnapshot !== evidenceSnapshot) {
      return err(`cannot build bundle: region "${rec.regionId}" source snapshot does not match`);
    }
    const rebuilt = createPlanarRegion({ regionId: rec.regionId, frameId: rec.frameId,
      originAnchorId: rec.originAnchorId, xAnchorId: rec.xAnchorId, yAnchorId: rec.yAnchorId,
      offPlaneToleranceMm: rec.offPlaneToleranceMm }, evidence.pairs, evidence, evidenceSnapshot);
    if (!rebuilt.ok) return err(`cannot build bundle: ${rebuilt.error}`);
    if (stableStringify(rec) !== stableStringify(rebuilt.region)) {
      return err(`cannot build bundle: region "${rec.regionId}" geometry or references differ from source evidence`);
    }
  }

  const sorted = [...regions]
    .sort((a, b) => (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0))
    .map((r) => ({
      ...r,
      origin: copyVec3(r.origin),
      xAxis: copyVec3(r.xAxis),
      yAxis: copyVec3(r.yAxis),
      normal: copyVec3(r.normal),
    }));

  // Canonical deep copy of the session so later caller mutation cannot leak in.
  const session = JSON.parse(JSON.stringify(buildSessionExport(evidence, recomputed))) as SessionExport;

  return {
    ok: true,
    bundle: {
      schemaVersion: PLANAR_REGION_BUNDLE_VERSION,
      pendingReview: true,
      productionApproved: false,
      session,
      regions: sorted,
      limitations: [
        "provisional planar frame draft; not production approved",
        "planar mapping cannot model curved surfaces",
      ],
    },
  };
}

export function serializeRegionBundle(bundle: RegionBundle): string {
  const ordered = {
    schemaVersion: bundle.schemaVersion,
    pendingReview: bundle.pendingReview,
    productionApproved: bundle.productionApproved,
    session: bundle.session,
    regions: bundle.regions,
    limitations: bundle.limitations,
  };
  return JSON.stringify(JSON.parse(stableStringify(ordered)), null, 2);
}

export function validateRegionRecord(value: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return err("region record must be an object");
  const v = value as Record<string, unknown>;
  for (const key of ["regionId", "frameId", "originAnchorId", "xAnchorId", "yAnchorId"] as const) {
    if (!isValidId(v[key])) return err(`${key} must be a non-empty string of at most 256 chars`);
  }
  for (const key of ["origin", "xAxis", "yAxis", "normal"] as const) {
    if (!isFiniteVec3(v[key])) return err(`${key} must be a 3D vector of finite numbers`);
  }
  if (!isFiniteNumber(v["mmPerModelUnit"]) || !(v["mmPerModelUnit"] as number > 0)) {
    return err("mmPerModelUnit must be a finite number > 0");
  }
  if (!isFiniteNumber(v["offPlaneToleranceMm"]) || (v["offPlaneToleranceMm"] as number) < 0) {
    return err("offPlaneToleranceMm must be a finite number >= 0");
  }
  if (typeof v["assetFullSha256"] !== "string" || !SHA256_HEX_PATTERN.test(v["assetFullSha256"] as string)) {
    return err("assetFullSha256 must match /^[0-9a-f]{64}$/");
  }
  for (const key of ["product", "variant", "calibrationId", "calibrationFrameId", "provisionalVersion"] as const) {
    if (!isValidId(v[key])) return err(`${key} must be a non-empty string of at most 256 chars`);
  }
  if (typeof v["sourceEvidenceSnapshot"] !== "string" || (v["sourceEvidenceSnapshot"] as string).length === 0) {
    return err("sourceEvidenceSnapshot must be a non-empty string");
  }
  return { ok: true };
}
