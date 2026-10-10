/**
 * calibration-session — pure draft/session state for the offline calibration panel.
 *
 * Browser/Three-free: draft validation, deterministic evidence assembly,
 * snapshot-based stale-fit detection, and deterministic export shaping. The
 * fitting kernel in `src/core/calibration` is unchanged and remains the only
 * fit authority; this module never fits, never approves, never timestamps.
 */

import type {
  CalibrationEvidence,
  UniformFitResult,
} from "../calibration/index.js";

/** Provisional session envelope version (session envelope, not kernel schema). */
export const SESSION_SCHEMA_VERSION =
  "0.1.0-provisional-calibration-session" as const;

export interface SessionVec3 {
  x: number;
  y: number;
  z: number;
}

export interface DraftAnchor {
  id: string;
  model: SessionVec3;
  semanticRole?: string;
}

export interface DraftMeasurement {
  /** Canonical sorted anchor ids (a <= b). */
  a: string;
  b: string;
  distanceMm: number;
}

export interface SessionFields {
  product: string;
  variant: string;
  calibrationId: string;
  frameId: string;
  provisionalVersion: string;
  toleranceMm: number;
  relativeTolerance: number;
  assetFullSha256: string;
}

export interface SessionExport {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  evidence: CalibrationEvidence;
  fit: UniformFitResult;
}

export type AddAnchorResult =
  | { ok: true; anchors: DraftAnchor[] }
  | { ok: false; error: string };

export type AddMeasurementResult =
  | { ok: true; measurements: DraftMeasurement[] }
  | { ok: false; error: string };

export type BuildEvidenceResult =
  | { ok: true; evidence: CalibrationEvidence }
  | { ok: false; error: string };

function isFiniteVec3(value: unknown): value is SessionVec3 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["x"] === "number" &&
    Number.isFinite(v["x"]) &&
    typeof v["y"] === "number" &&
    Number.isFinite(v["y"]) &&
    typeof v["z"] === "number" &&
    Number.isFinite(v["z"])
  );
}

/** Canonical sorted anchor-id tuple; JSON form matches the kernel pair id. */
export function canonicalPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** Canonical per-measurement id: JSON-encoded sorted anchor ids. */
export function measurementKey(a: string, b: string): string {
  return JSON.stringify(canonicalPair(a, b));
}

export function sortAnchors(anchors: DraftAnchor[]): DraftAnchor[] {
  return [...anchors].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export function sortMeasurements(
  measurements: DraftMeasurement[],
): DraftMeasurement[] {
  return [...measurements].sort((x, y) => {
    const kx = measurementKey(x.a, x.b);
    const ky = measurementKey(y.a, y.b);
    if (kx !== ky) return kx < ky ? -1 : 1;
    return x.distanceMm < y.distanceMm
      ? -1
      : x.distanceMm > y.distanceMm
        ? 1
        : 0;
  });
}

/** Validate + append an anchor; immutable, deterministically sorted. */
export function addAnchor(
  anchors: DraftAnchor[],
  anchor: DraftAnchor,
): AddAnchorResult {
  const id = anchor.id.trim();
  if (id.length === 0) {
    return { ok: false, error: "anchor id must be a non-empty string" };
  }
  if (anchors.some((a) => a.id === id)) {
    return { ok: false, error: `duplicate anchor id "${id}"` };
  }
  if (!isFiniteVec3(anchor.model)) {
    return {
      ok: false,
      error: `anchor "${id}" model must be a 3D vector of finite numbers`,
    };
  }
  const role =
    anchor.semanticRole === undefined ? "" : anchor.semanticRole.trim();
  const next: DraftAnchor = {
    id,
    model: { x: anchor.model.x, y: anchor.model.y, z: anchor.model.z },
    ...(role.length > 0 ? { semanticRole: role } : {}),
  };
  return { ok: true, anchors: sortAnchors([...anchors, next]) };
}

/**
 * Validate + append a measurement; immutable. Repeated pairs are allowed
 * (each repeat constrains the unweighted kernel fit individually).
 */
export function addMeasurement(
  measurements: DraftMeasurement[],
  anchors: DraftAnchor[],
  measurement: { a: string; b: string; distanceMm: number },
): AddMeasurementResult {
  const known = new Set(anchors.map((a) => a.id));
  if (!known.has(measurement.a)) {
    return {
      ok: false,
      error: `measurement references unknown anchor id "${measurement.a}"`,
    };
  }
  if (!known.has(measurement.b)) {
    return {
      ok: false,
      error: `measurement references unknown anchor id "${measurement.b}"`,
    };
  }
  if (measurement.a === measurement.b) {
    return {
      ok: false,
      error: "measurement must reference two distinct anchors",
    };
  }
  if (
    typeof measurement.distanceMm !== "number" ||
    !Number.isFinite(measurement.distanceMm) ||
    !(measurement.distanceMm > 0)
  ) {
    return { ok: false, error: "measured distance must be a number > 0 (mm)" };
  }
  const [a, b] = canonicalPair(measurement.a, measurement.b);
  return {
    ok: true,
    measurements: [
      ...measurements,
      { a, b, distanceMm: measurement.distanceMm },
    ],
  };
}

/** Remove an anchor and cascade-drop every measurement referencing it. */
export function removeAnchor(
  anchors: DraftAnchor[],
  measurements: DraftMeasurement[],
  id: string,
): { anchors: DraftAnchor[]; measurements: DraftMeasurement[] } {
  return {
    anchors: anchors.filter((a) => a.id !== id),
    measurements: measurements.filter((m) => m.a !== id && m.b !== id),
  };
}

/** Remove one measurement by index (repeats are distinct entries). */
export function removeMeasurement(
  measurements: DraftMeasurement[],
  index: number,
): DraftMeasurement[] {
  if (!Number.isInteger(index) || index < 0 || index >= measurements.length) {
    return [...measurements];
  }
  return measurements.filter((_, i) => i !== index);
}

/**
 * Assemble kernel evidence from a draft. Anchors sort by id; measurements
 * sort by (pair key, distance) so the first measurement is a deterministic
 * primary. Field emptiness is NOT checked here — the kernel validator owns
 * that at fit time; only the measurement presence (needed for pairIds) is.
 */
export function buildEvidence(
  fields: SessionFields,
  anchors: DraftAnchor[],
  measurements: DraftMeasurement[],
): BuildEvidenceResult {
  const ordered = sortMeasurements(
    measurements.map((entry) => {
      const [canonA, canonB] = canonicalPair(entry.a, entry.b);
      return { a: canonA, b: canonB, distanceMm: entry.distanceMm };
    }),
  );
  const first = ordered[0];
  if (first === undefined) {
    return {
      ok: false,
      error: "at least one known-distance measurement is required",
    };
  }
  const pairs = sortAnchors(anchors).map((a) => ({
    id: a.id,
    model: { x: a.model.x, y: a.model.y, z: a.model.z },
    ...(a.semanticRole !== undefined
      ? { semanticRole: a.semanticRole }
      : {}),
  }));
  const rest = ordered.slice(1);
  const evidence: CalibrationEvidence = {
    calibrationId: fields.calibrationId,
    frameId: fields.frameId,
    assetFullSha256: fields.assetFullSha256,
    product: fields.product,
    variant: fields.variant,
    pairs,
    measuredDistanceMm: first.distanceMm,
    pairIds: [first.a, first.b],
    provisionalVersion: fields.provisionalVersion,
    toleranceMm: fields.toleranceMm,
    relativeTolerance: fields.relativeTolerance,
    ...(rest.length > 0
      ? {
          extraMeasurements: rest.map((m) => ({
            pairIds: [m.a, m.b] as [string, string],
            distanceMm: m.distanceMm,
          })),
        }
      : {}),
  };
  return { ok: true, evidence };
}

/** Deterministic JSON: sorted object keys, array order preserved. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("stableStringify: non-finite number");
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error("stableStringify: unserializable value");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/** Snapshot the evidence at fit time; render compares against the draft. */
export function snapshotEvidence(evidence: CalibrationEvidence): string {
  return stableStringify(evidence);
}

/** A fit is current only when a snapshot exists and matches the draft. */
export function isFitCurrent(
  evidence: CalibrationEvidence | null,
  fitSnapshot: string | null,
): boolean {
  if (evidence === null || fitSnapshot === null) return false;
  return snapshotEvidence(evidence) === fitSnapshot;
}

/** Deterministic envelope; key order is fixed: schemaVersion, evidence, fit. */
export function buildSessionExport(
  evidence: CalibrationEvidence,
  fit: UniformFitResult,
): SessionExport {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    evidence,
    fit,
  };
}

/** Deterministic file text: stable construction order, 2-space indent. */
export function serializeSessionExport(session: SessionExport): string {
  return JSON.stringify(session, null, 2);
}
