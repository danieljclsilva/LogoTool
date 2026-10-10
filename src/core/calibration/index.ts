/**
 * Phase 5 (partial) pure calibration / region-geometry kernel.
 *
 * Pure TypeScript only: no React, no Three.js, no Node/browser/provider
 * imports. All inputs are plain data; hashing/persistence live elsewhere.
 *
 * Scope:
 * - `validateCalibrationEvidence`: structural + semantic checks for a set of
 *   generic semantic anchors (stable string IDs) plus straight-line physical
 *   measurements in millimetres.
 * - `fitUniformScale`: uniform isotropic (single scalar) least-squares fit of
 *   `scaleMmPerUnit` over the primary measurement plus any optional extra
 *   measurements: s = sum(model_i * measured_i) / sum(model_i^2).
 * - `createPlanarMapping`: orthonormal planar frame mapping 2D physical-mm
 *   points to 3D model coordinates and back, with off-plane rejection.
 *
 * Key limitations (also reported in every `UniformFitResult.limitations`):
 * - A single anchor-pair distance cannot establish anisotropy, shear, or
 *   rotation; directional distortion is undetectable by this kernel. Even
 *   with N measurements only one isotropic scale is fitted.
 * - This kernel never production-approves a calibration: every result is
 *   `{ productionApproved: false, pendingReview: true }`. Human review is
 *   always required. An `inconsistent` fit additionally signals that the
 *   measurements disagree beyond tolerance.
 *
 * The `physical` 2D coordinates carried on each anchor are informational for
 * downstream region geometry; the scale fit uses only the 3D model spans and
 * the straight-line `measuredDistanceMm` / `extraMeasurements` distances.
 */

export interface CalibVec3 {
  x: number;
  y: number;
  z: number;
}

export interface CalibPoint2Mm {
  x: number;
  y: number;
}

export interface AnchorPairInput {
  id: string;
  model: CalibVec3;
  semanticRole?: string;
  physical?: CalibPoint2Mm;
}

export const CALIBRATION_KERNEL_VERSION = "0.1.0-provisional-calibration" as const;

export interface CalibrationEvidence {
  calibrationId: string;
  frameId: string;
  assetFullSha256: string;
  product: string;
  variant: string;
  pairs: AnchorPairInput[];
  measuredDistanceMm: number;
  pairIds: [string, string];
  provisionalVersion: string;
  toleranceMm?: number;
  relativeTolerance?: number;
  extraMeasurements?: { pairIds: [string, string]; distanceMm: number }[];
}

export interface FitOptions {
  toleranceMm?: number;
  relativeTolerance?: number;
}

export interface PairResidual {
  id: string;
  pairIds: [string, string];
  modelDistance: number;
  measuredDistanceMm: number;
  predictedDistanceMm: number;
  residualMm: number;
}

export interface UniformFitResult {
  schemaVersion: typeof CALIBRATION_KERNEL_VERSION;
  calibrationId: string;
  frameId: string;
  assetFullSha256: string;
  product: string;
  variant: string;
  toleranceMm: number;
  relativeTolerance: number;
  scaleMmPerUnit: number;
  perPair: PairResidual[];
  maxResidualMm: number;
  inconsistent: boolean;
  productionApproved: false;
  pendingReview: true;
  limitations: string[];
  provisionalVersion: string;
}

export interface PlanarFrameSpec {
  frameId: string;
  origin: CalibVec3;
  xAxis: CalibVec3;
  yAxis: CalibVec3;
  mmPerModelUnit: number;
  offPlaneToleranceMm: number;
}

export interface PlanarMapping {
  frameId: string;
  toModel(p: CalibPoint2Mm): CalibVec3;
  toPhysicalMm(m: CalibVec3): { point: CalibPoint2Mm; offPlaneMm: number } | { error: string };
  normal: CalibVec3;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Maximum |dot(xHat, yHat)| accepted as orthogonal (axes are normalized first). */
const ORTHOGONAL_DOT_TOLERANCE = 1e-6;

const DEFAULT_TOLERANCE_MM = 0.5;
const DEFAULT_RELATIVE_TOLERANCE = 0.01;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteVec3(value: unknown): value is CalibVec3 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v["x"]) && isFiniteNumber(v["y"]) && isFiniteNumber(v["z"]);
}

function isFinitePoint2(value: unknown): value is CalibPoint2Mm {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return isFiniteNumber(p["x"]) && isFiniteNumber(p["y"]);
}

function modelDistance(a: CalibVec3, b: CalibVec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.hypot(dx, dy, dz);
}

function dot(a: CalibVec3, b: CalibVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: CalibVec3, b: CalibVec3): CalibVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function norm(v: CalibVec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** Canonical per-measurement id: JSON-encoded sorted anchor IDs. */
function measurementId(pairIds: [string, string]): string {
  const [a, b] = pairIds;
  return JSON.stringify(a <= b ? [a, b] : [b, a]);
}

export function validateCalibrationEvidence(
  ev: CalibrationEvidence,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof ev !== "object" || ev === null) {
    return { ok: false, errors: ["calibration evidence must be an object"] };
  }

  if (typeof ev.assetFullSha256 !== "string" || !SHA256_HEX_PATTERN.test(ev.assetFullSha256)) {
    errors.push("assetFullSha256 must be 64 lowercase hex characters");
  }
  if (!isNonEmptyString(ev.product)) {
    errors.push("product must be a non-empty string");
  }
  if (!isNonEmptyString(ev.variant)) {
    errors.push("variant must be a non-empty string");
  }
  if (!isNonEmptyString(ev.provisionalVersion)) {
    errors.push("provisionalVersion must be a non-empty string");
  }

  if (!isNonEmptyString(ev.calibrationId)) errors.push('calibrationId must be a non-empty string');
  if (!isNonEmptyString(ev.frameId)) errors.push('frameId must be a non-empty string');
  const knownIds = new Set<string>();
  let pairsUsable = false;
  if (!Array.isArray(ev.pairs) || ev.pairs.length < 2) {
    errors.push("pairs must be an array with at least 2 anchors");
  } else {
    pairsUsable = true;
    const seen = new Set<string>();
    ev.pairs.forEach((pair, index) => {
      const label = `pairs[${index}]`;
      if (typeof pair !== "object" || pair === null) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (!isNonEmptyString(pair.id)) {
        errors.push(`${label}.id must be a non-empty string`);
      } else if (seen.has(pair.id)) {
        errors.push(`${label}.id "${pair.id}" is duplicated`);
      } else {
        seen.add(pair.id);
        knownIds.add(pair.id);
      }
      if (!isFiniteVec3(pair.model)) {
        errors.push(`${label}.model must be a 3D vector of finite numbers`);
      }
      if (pair.semanticRole !== undefined && !isNonEmptyString(pair.semanticRole)) errors.push(`${label}.semanticRole must be a non-empty string`);
      if (pair.physical !== undefined && !isFinitePoint2(pair.physical)) {
        errors.push(`${label}.physical must be a 2D point of finite numbers (mm)`);
      }
    });
  }

  const checkPairRef = (ref: unknown, label: string): void => {
    if (
      !Array.isArray(ref) ||
      ref.length !== 2 ||
      !isNonEmptyString(ref[0]) ||
      !isNonEmptyString(ref[1])
    ) {
      errors.push(`${label} must be a tuple of 2 non-empty anchor id strings`);
      return;
    }
    const [a, b] = ref as [string, string];
    if (a === b) {
      errors.push(`${label} must reference two distinct anchors`);
      return;
    }
    if (pairsUsable) {
      if (!knownIds.has(a)) errors.push(`${label} references unknown anchor id "${a}"`);
      if (!knownIds.has(b)) errors.push(`${label} references unknown anchor id "${b}"`);
    }
  };

  checkPairRef(ev.pairIds, "pairIds");

  if (!isFiniteNumber(ev.measuredDistanceMm)) {
    errors.push("measuredDistanceMm must be a finite number");
  } else if (!(ev.measuredDistanceMm > 0)) {
    errors.push("measuredDistanceMm must be > 0");
  }

  if (ev.toleranceMm !== undefined) {
    if (!isFiniteNumber(ev.toleranceMm)) {
      errors.push("toleranceMm must be a finite number");
    } else if (ev.toleranceMm < 0) {
      errors.push("toleranceMm must be >= 0");
    }
  }
  if (ev.relativeTolerance !== undefined) {
    if (!isFiniteNumber(ev.relativeTolerance)) {
      errors.push("relativeTolerance must be a finite number");
    } else if (ev.relativeTolerance < 0) {
      errors.push("relativeTolerance must be >= 0");
    }
  }

  if (ev.extraMeasurements !== undefined) {
    if (!Array.isArray(ev.extraMeasurements)) {
      errors.push("extraMeasurements must be an array when present");
    } else {
      ev.extraMeasurements.forEach((extra, index) => {
        const label = `extraMeasurements[${index}]`;
        if (typeof extra !== "object" || extra === null) {
          errors.push(`${label} must be an object`);
          return;
        }
        checkPairRef(extra.pairIds, `${label}.pairIds`);
        if (!isFiniteNumber(extra.distanceMm)) {
          errors.push(`${label}.distanceMm must be a finite number`);
        } else if (!(extra.distanceMm > 0)) {
          errors.push(`${label}.distanceMm must be > 0`);
        }
      });
    }
  }

  // Zero-span check: every spanned anchor pair must have a positive finite
  // model distance (only when both endpoints resolved to finite vectors).
  if (pairsUsable) {
    const byId = new Map<string, CalibVec3>();
    for (const pair of ev.pairs) {
      if (typeof pair === "object" && pair !== null && isNonEmptyString(pair.id) && isFiniteVec3(pair.model)) {
        byId.set(pair.id, pair.model);
      }
    }
    const checkSpan = (ref: unknown, label: string): void => {
      if (!Array.isArray(ref) || ref.length !== 2) return;
      const [a, b] = ref as [string, string];
      const va = byId.get(a);
      const vb = byId.get(b);
      if (va === undefined || vb === undefined) return;
      const span = modelDistance(va, vb);
      if (!(span > 0) || !Number.isFinite(span)) {
        errors.push(`${label} spans a zero or non-finite model distance ("${a}" to "${b}")`);
      }
    };
    checkSpan(ev.pairIds, "pairIds");
    if (Array.isArray(ev.extraMeasurements)) {
      ev.extraMeasurements.forEach((extra, index) => {
        if (typeof extra === "object" && extra !== null) {
          checkSpan(extra.pairIds, `extraMeasurements[${index}].pairIds`);
        }
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

export function fitUniformScale(ev: CalibrationEvidence, opts?: FitOptions): UniformFitResult {
  const validation = validateCalibrationEvidence(ev);
  if (!validation.ok) {
    throw new Error(`invalid calibration evidence: ${validation.errors.join("; ")}`);
  }
  const options: FitOptions = opts ?? {};
  const toleranceMm = options.toleranceMm ?? ev.toleranceMm ?? DEFAULT_TOLERANCE_MM;
  const relativeTolerance = options.relativeTolerance ?? ev.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE;
  if (!isFiniteNumber(toleranceMm) || toleranceMm < 0) {
    throw new Error("FitOptions.toleranceMm must be a finite number >= 0");
  }
  if (!isFiniteNumber(relativeTolerance) || relativeTolerance < 0) {
    throw new Error("FitOptions.relativeTolerance must be a finite number >= 0");
  }

  const byId = new Map<string, CalibVec3>();
  for (const pair of ev.pairs) {
    byId.set(pair.id, pair.model);
  }

  const measurements: { pairIds: [string, string]; modelDist: number; measured: number }[] = [];
  const pushMeasurement = (pairIds: [string, string], measured: number): void => {
    const [a, b] = pairIds;
    const va = byId.get(a);
    const vb = byId.get(b);
    if (va === undefined || vb === undefined) {
      throw new Error(`unknown anchor id in measurement ("${a}" to "${b}")`);
    }
    const span = modelDistance(va, vb);
    if (!(span > 0) || !Number.isFinite(span)) {
      throw new Error(`measurement spans a zero or non-finite model distance ("${a}" to "${b}")`);
    }
    measurements.push({ pairIds: a <= b ? [a, b] : [b, a], modelDist: span, measured });
  };
  pushMeasurement(ev.pairIds, ev.measuredDistanceMm);
  for (const extra of ev.extraMeasurements ?? []) {
    pushMeasurement(extra.pairIds, extra.distanceMm);
  }

  // Canonical order also controls floating-point summation, not only display order.
  measurements.sort((a, b) => {
    const idA = measurementId(a.pairIds), idB = measurementId(b.pairIds);
    return idA < idB ? -1 : idA > idB ? 1 : a.measured < b.measured ? -1 : a.measured > b.measured ? 1 : 0;
  });
  let numerator = 0;
  let denominator = 0;
  for (const m of measurements) {
    numerator += m.modelDist * m.measured;
    denominator += m.modelDist * m.modelDist;
  }
  const scaleMmPerUnit = numerator / denominator;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !(scaleMmPerUnit > 0) || !Number.isFinite(scaleMmPerUnit)) {
    throw new Error('calibration arithmetic exceeds finite positive numeric range');
  }

  const perPair: PairResidual[] = measurements.map((m) => {
    const predicted = scaleMmPerUnit * m.modelDist;
    if (!Number.isFinite(predicted) || !Number.isFinite(predicted - m.measured)) throw new Error('calibration residual exceeds finite numeric range');
    return {
      id: measurementId(m.pairIds),
      pairIds: m.pairIds,
      modelDistance: m.modelDist,
      measuredDistanceMm: m.measured,
      predictedDistanceMm: predicted,
      residualMm: predicted - m.measured,
    };
  });
  perPair.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let maxResidualMm = 0;
  let inconsistent = false;
  for (const row of perPair) {
    const abs = Math.abs(row.residualMm);
    if (abs > maxResidualMm) maxResidualMm = abs;
    const allowed = Math.max(toleranceMm, relativeTolerance * row.measuredDistanceMm);
    if (!Number.isFinite(allowed)) throw new Error('calibration tolerance exceeds finite numeric range');
    if (abs > allowed) inconsistent = true;
  }

  const limitations: string[] = [
    "Uniform isotropic scale only: a single anchor-pair distance cannot establish anisotropy, shear, or rotation; directional distortion is undetectable by this kernel.",
    "Result is provisional and pending human review; this kernel never production-approves a calibration.",
  ];
  if (measurements.length > 1) {
    limitations.push(
      `Least-squares fit over ${measurements.length} straight-line measurements constrains one isotropic scale; it cannot resolve per-axis or rotational disagreement between spans.`,
    );
  }

  return {
    schemaVersion: CALIBRATION_KERNEL_VERSION,
    calibrationId: ev.calibrationId, frameId: ev.frameId,
    assetFullSha256: ev.assetFullSha256, product: ev.product, variant: ev.variant,
    toleranceMm, relativeTolerance,
    scaleMmPerUnit,
    perPair,
    maxResidualMm,
    inconsistent,
    productionApproved: false,
    pendingReview: true,
    limitations,
    provisionalVersion: ev.provisionalVersion,
  };
}

export function createPlanarMapping(spec: PlanarFrameSpec): PlanarMapping {
  if (typeof spec !== "object" || spec === null) {
    throw new Error("planar frame spec must be an object");
  }
  if (!isNonEmptyString(spec.frameId)) throw new Error('planar frame frameId must be a non-empty string');
  if (!isFiniteVec3(spec.origin)) {
    throw new Error("planar frame origin must be a 3D vector of finite numbers");
  }
  if (!isFiniteVec3(spec.xAxis) || !(norm(spec.xAxis) > 0) || !Number.isFinite(norm(spec.xAxis))) {
    throw new Error("planar frame xAxis must be a nonzero finite vector");
  }
  if (!isFiniteVec3(spec.yAxis) || !(norm(spec.yAxis) > 0) || !Number.isFinite(norm(spec.yAxis))) {
    throw new Error("planar frame yAxis must be a nonzero finite vector");
  }
  if (!isFiniteNumber(spec.mmPerModelUnit) || !(spec.mmPerModelUnit > 0)) {
    throw new Error("planar frame mmPerModelUnit must be a finite number > 0");
  }
  if (!isFiniteNumber(spec.offPlaneToleranceMm) || spec.offPlaneToleranceMm < 0) {
    throw new Error("planar frame offPlaneToleranceMm must be a finite number >= 0");
  }

  const nx = norm(spec.xAxis);
  const ny = norm(spec.yAxis);
  const xHat: CalibVec3 = { x: spec.xAxis.x / nx, y: spec.xAxis.y / nx, z: spec.xAxis.z / nx };
  let yHat: CalibVec3 = { x: spec.yAxis.x / ny, y: spec.yAxis.y / ny, z: spec.yAxis.z / ny };
  const alignment = Math.abs(dot(xHat, yHat));
  if (!Number.isFinite(alignment) || alignment > ORTHOGONAL_DOT_TOLERANCE) {
    throw new Error(
      `planar frame axes must be orthogonal (|dot| ${alignment} exceeds ${ORTHOGONAL_DOT_TOLERANCE})`,
    );
  }

  // Accepted near-orthogonal input must still produce an orthonormal inverse.
  const projection = dot(xHat, yHat);
  const correctedY = {x: yHat.x - projection * xHat.x, y: yHat.y - projection * xHat.y, z: yHat.z - projection * xHat.z};
  const correctedNorm = norm(correctedY);
  yHat = {x: correctedY.x / correctedNorm, y: correctedY.y / correctedNorm, z: correctedY.z / correctedNorm};
  const frameId = spec.frameId;
  const origin: CalibVec3 = { x: spec.origin.x, y: spec.origin.y, z: spec.origin.z };
  const normal: CalibVec3 = cross(xHat, yHat);
  const mm = spec.mmPerModelUnit;
  const tolerance = spec.offPlaneToleranceMm;

  return {
    frameId,
    normal: { x: normal.x, y: normal.y, z: normal.z },
    toModel(p: CalibPoint2Mm): CalibVec3 {
      if (!isFinitePoint2(p)) {
        throw new Error("toModel point must be a 2D point of finite numbers (mm)");
      }
      const u = p.x / mm;
      const w = p.y / mm;
      const result = {
        x: origin.x + u * xHat.x + w * yHat.x,
        y: origin.y + u * xHat.y + w * yHat.y,
        z: origin.z + u * xHat.z + w * yHat.z,
      };
      if (!isFiniteVec3(result)) throw new Error('toModel exceeds finite numeric range');
      return result;
    },
    toPhysicalMm(
      m: CalibVec3,
    ): { point: CalibPoint2Mm; offPlaneMm: number } | { error: string } {
      if (!isFiniteVec3(m)) {
        throw new Error("toPhysicalMm point must be a 3D vector of finite numbers");
      }
      const dx = m.x - origin.x;
      const dy = m.y - origin.y;
      const dz = m.z - origin.z;
      const delta: CalibVec3 = { x: dx, y: dy, z: dz };
      const point: CalibPoint2Mm = {
        x: dot(delta, xHat) * mm,
        y: dot(delta, yHat) * mm,
      };
      // Magnitude of the perpendicular component, in mm.
      const offPlaneMm = Math.abs(dot(delta, normal) * mm);
      if (!isFinitePoint2(point) || !Number.isFinite(offPlaneMm)) throw new Error('toPhysicalMm exceeds finite numeric range');
      if (offPlaneMm > tolerance) {
        return {
          error: `point is ${offPlaneMm} mm off-plane (tolerance ${tolerance} mm); refusing silent projection`,
        };
      }
      return { point, offPlaneMm };
    },
  };
}
