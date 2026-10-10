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
import { validateCalibrationEvidence } from "../calibration/index.js";

/** Provisional session envelope version (session envelope, not kernel schema). */
export const SESSION_SCHEMA_VERSION =
  "0.1.0-provisional-calibration-session" as const;

export interface SessionVec3 {
  x: number;
  y: number;
  z: number;
}

export interface SessionPoint2 {
  x: number;
  y: number;
}

export interface DraftAnchor {
  id: string;
  model: SessionVec3;
  semanticRole?: string;
  /**
   * Informational 2D physical-mm coordinates. Carried through restore and
   * evidence assembly for downstream region geometry; never affect the fit.
   */
  physical?: SessionPoint2;
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

function isFinitePoint2(value: unknown): value is SessionPoint2 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["x"] === "number" &&
    Number.isFinite(v["x"]) &&
    typeof v["y"] === "number" &&
    Number.isFinite(v["y"])
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
  if (anchor.physical !== undefined && !isFinitePoint2(anchor.physical)) {
    return {
      ok: false,
      error: `anchor "${id}" physical must be a 2D point of finite numbers (mm)`,
    };
  }
  const role =
    anchor.semanticRole === undefined ? "" : anchor.semanticRole.trim();
  const next: DraftAnchor = {
    id,
    model: { x: anchor.model.x, y: anchor.model.y, z: anchor.model.z },
    ...(role.length > 0 ? { semanticRole: role } : {}),
    ...(anchor.physical !== undefined
      ? {
          physical: { x: anchor.physical.x, y: anchor.physical.y },
        }
      : {}),
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
    ...(a.physical !== undefined
      ? { physical: { x: a.physical.x, y: a.physical.y } }
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
/**
 * Restore limits + policy for `parseSessionRestore` (provisional only).
 *
 * - The import is a *draft restore*, never a finalized calibration: the
 *   envelope `fit` block must be present but its VALUES ARE ENTIRELY
 *   DISREGARDED (a forged file could claim any scale or approval). The caller
 *   must rebuild evidence and recompute with the existing `fitUniformScale`
 *   kernel, which always reports `pendingReview` and never approves.
 * - `maxBytes` is enforced as `text.length` (UTF-16 code units). Pure-domain
 *   code has no byte API (`TextEncoder`/`Buffer` are Node/browser surface);
 *   for ASCII-only session JSON one unit is one UTF-8 byte, and otherwise the
 *   count still bounds resident memory before `JSON.parse`.
 * - `maxTextLength` bounds every free-form string carried into the draft
 *   (product/variant/calibrationId/frameId/provisionalVersion, anchor ids and
 *   semantic roles); `maxAnchors` / `maxMeasurements` bound pair and
 *   (primary + extras) measurement counts. Bounds run BEFORE kernel
 *   validation so hostile files fail fast with clear errors.
 * - Evidence itself is validated by the existing kernel
 *   `validateCalibrationEvidence`; the loaded asset hash must then match
 *   exactly (`evidence.assetFullSha256 === expectedAssetSha256`, full-string
 *   equality, so a malformed expected hash is also a mismatch).
 * - Missing optional tolerances default to the kernel prototype defaults
 *   (0.5mm absolute / 0.01 relative); missing extraMeasurements restores the
 *   primary measurement only. The draft is rebuilt through the existing
 *   `addAnchor` / `addMeasurement` / sort helpers so output is canonical, and
 *   every object is freshly copied — inputs are never mutated.
 */
export const RESTORE_LIMITS = {
  maxBytes: 1048576,
  maxAnchors: 512,
  maxMeasurements: 2048,
  maxTextLength: 256,
} as const;

export interface RestoredDraft {
  fields: SessionFields;
  anchors: DraftAnchor[];
  measurements: DraftMeasurement[];
}

export type ParseSessionRestoreResult =
  | { ok: true; draft: RestoredDraft }
  | { ok: false; error: string };

function restoreError(error: string): ParseSessionRestoreResult {
  return { ok: false, error };
}

function restoreTextBound(
  record: Record<string, unknown>,
  key: string,
  label: string,
): ParseSessionRestoreResult | null {
  const value = record[key];
  if (
    typeof value === "string" &&
    value.length > RESTORE_LIMITS.maxTextLength
  ) {
    return restoreError(
      `session restore: ${label} exceeds ${RESTORE_LIMITS.maxTextLength} characters`,
    );
  }
  return null;
}

/**
 * Parse a provisional session file back into a canonical draft. The envelope
 * `fit` block is required to be present but never read: every fit is
 * recomputed locally by the caller with `fitUniformScale` and stays
 * pending-review. Never mutates its inputs; every returned object is fresh.
 */
export function parseSessionRestore(
  text: string,
  expectedAssetSha256: string,
): ParseSessionRestoreResult {
  if (typeof text !== "string") {
    return restoreError("session restore: input must be a JSON string");
  }
  if (text.length > RESTORE_LIMITS.maxBytes) {
    return restoreError(
      `session restore: file exceeds ${RESTORE_LIMITS.maxBytes} characters`,
    );
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return restoreError("session restore: file is not valid JSON");
  }
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope)
  ) {
    return restoreError("session restore: envelope must be an object");
  }
  const root = envelope as Record<string, unknown>;
  if (root["schemaVersion"] !== SESSION_SCHEMA_VERSION) {
    return restoreError("unknown or mismatched session version");
  }
  const evidenceValue = root["evidence"];
  if (
    typeof evidenceValue !== "object" ||
    evidenceValue === null ||
    Array.isArray(evidenceValue)
  ) {
    return restoreError("session restore: envelope evidence must be an object");
  }
  // The fit block must be present, but its contents are never trusted: the
  // panel recomputes the fit from the restored evidence. Not read below.
  const fitValue = root["fit"];
  if (
    typeof fitValue !== "object" ||
    fitValue === null ||
    Array.isArray(fitValue)
  ) {
    return restoreError("session restore: envelope fit must be an object");
  }
  const raw = evidenceValue as Record<string, unknown>;
  for (const key of [
    "product",
    "variant",
    "calibrationId",
    "frameId",
    "provisionalVersion",
  ] as const) {
    const bound = restoreTextBound(raw, key, `evidence.${key}`);
    if (bound !== null) return bound;
  }
  const pairsValue = raw["pairs"];
  if (Array.isArray(pairsValue)) {
    if (pairsValue.length > RESTORE_LIMITS.maxAnchors) {
      return restoreError(
        `session restore: too many anchors (${pairsValue.length} > ${RESTORE_LIMITS.maxAnchors})`,
      );
    }
    for (let index = 0; index < pairsValue.length; index++) {
      const pair = pairsValue[index];
      if (typeof pair === "object" && pair !== null) {
        const record = pair as Record<string, unknown>;
        const idBound = restoreTextBound(record, "id", `pairs[${index}].id`);
        if (idBound !== null) return idBound;
        const roleBound = restoreTextBound(
          record,
          "semanticRole",
          `pairs[${index}].semanticRole`,
        );
        if (roleBound !== null) return roleBound;
      }
    }
  }
  const extrasValue = raw["extraMeasurements"];
  let extraCount = 0;
  if (extrasValue !== undefined && Array.isArray(extrasValue)) {
    extraCount = extrasValue.length;
    if (1 + extraCount > RESTORE_LIMITS.maxMeasurements) {
      return restoreError(`session restore: too many measurements (${1 + extraCount} > ${RESTORE_LIMITS.maxMeasurements})`);
    }
    for (let index = 0; index < extrasValue.length; index++) {
      const extra = extrasValue[index];
      if (typeof extra === "object" && extra !== null) {
        const pairIds = (extra as Record<string, unknown>)["pairIds"];
        if (Array.isArray(pairIds)) {
          for (let slot = 0; slot < pairIds.length; slot++) {
            const ref = pairIds[slot];
            if (
              typeof ref === "string" &&
              ref.length > RESTORE_LIMITS.maxTextLength
            ) {
              return restoreError(
                `session restore: extraMeasurements[${index}].pairIds[${slot}] exceeds ${RESTORE_LIMITS.maxTextLength} characters`,
              );
            }
          }
        }
      }
    }
  }
  const totalMeasurements = 1 + extraCount;
  if (totalMeasurements > RESTORE_LIMITS.maxMeasurements) {
    return restoreError(
      `session restore: too many measurements (${totalMeasurements} > ${RESTORE_LIMITS.maxMeasurements})`,
    );
  }
  const candidate = evidenceValue as CalibrationEvidence;
  const validation = validateCalibrationEvidence(candidate);
  if (!validation.ok) {
    return restoreError(`session restore: ${validation.errors.join("; ")}`);
  }
  if (expectedAssetSha256 !== candidate.assetFullSha256) {
    return restoreError(
      "session restore: asset hash does not match the loaded asset",
    );
  }
  const fields: SessionFields = {
    product: candidate.product,
    variant: candidate.variant,
    calibrationId: candidate.calibrationId,
    frameId: candidate.frameId,
    provisionalVersion: candidate.provisionalVersion,
    toleranceMm: candidate.toleranceMm ?? 0.5,
    relativeTolerance: candidate.relativeTolerance ?? 0.01,
    assetFullSha256: candidate.assetFullSha256,
  };
  let anchors: DraftAnchor[] = [];
  for (const pair of candidate.pairs) {
    const added = addAnchor(anchors, {
      id: pair.id,
      model: { x: pair.model.x, y: pair.model.y, z: pair.model.z },
      ...(pair.semanticRole !== undefined
        ? { semanticRole: pair.semanticRole }
        : {}),
      ...(pair.physical !== undefined
        ? { physical: { x: pair.physical.x, y: pair.physical.y } }
        : {}),
    });
    if (!added.ok) return restoreError(`session restore: ${added.error}`);
    anchors = added.anchors;
  }
  let measurements: DraftMeasurement[] = [];
  const restoreMeasurement = (
    pairIds: [string, string],
    distanceMm: number,
  ): ParseSessionRestoreResult | null => {
    const added = addMeasurement(measurements, anchors, {
      a: pairIds[0],
      b: pairIds[1],
      distanceMm,
    });
    if (!added.ok) return restoreError(`session restore: ${added.error}`);
    measurements = added.measurements;
    return null;
  };
  const primary = restoreMeasurement(
    candidate.pairIds,
    candidate.measuredDistanceMm,
  );
  if (primary !== null) return primary;
  for (const extra of candidate.extraMeasurements ?? []) {
    const failed = restoreMeasurement(extra.pairIds, extra.distanceMm);
    if (failed !== null) return failed;
  }
  return {
    ok: true,
    draft: {
      fields,
      anchors: sortAnchors(anchors),
      measurements: sortMeasurements(measurements),
    },
  };
}
