/**
 * Setup-calibration provisional pure kernel: unified Images / 3D reference +
 * scale + named safe-areas draft state.
 *
 * Pure TypeScript only: no React, no Three.js, no DOM/browser/Node/provider
 * imports. All inputs are plain data; callers own persistence, hashing and UI.
 *
 * Coordinate frames (kept separate by construction, never conflated):
 * - `SetupPoint2D` lives in caller-declared 2D native units: image-UV pixels
 *   or planar display units. These are NOT millimetres and NOT asset units.
 * - `SetupPoint3D` lives in caller-declared 3D native units: actual 3D surface
 *   coordinates in whatever unit the asset uses (NOT millimetres).
 * - `mmPerUnit` converts ONE native frame to millimetres. A fit must never
 *   mix 2D and 3D spans: each span's endpoints must share a dimensionality,
 *   and every span in one `fitScaleFromReferences` call must share it too.
 *   The bundle `mode` ("images" | "model") declares which frame the spans use.
 * - `NamedSafeArea.points` live in setup-frame millimetres under a front-on
 *   planar assumption. They are NOT geodesic paths on curved surfaces.
 *
 * Honest limits (also surfaced to callers, never approval claims):
 * - 3D span distances are straight-line chords (`Math.hypot`), NOT geodesic
 *   or surface-arc lengths. Curved-surface mapping is out of scope.
 * - The scale fit reuses `fitUniformScale` from `src/core/calibration/`: one
 *   unweighted isotropic (single-scalar) least-squares fit over straight-line
 *   spans. It cannot detect anisotropy, shear, rotation or directional
 *   distortion, even with N spans.
 * - Consistency gating reuses the kernel prototype defaults (0.5 mm absolute /
 *   1% relative). These are prototype thresholds, NOT observed production or
 *   decoration tolerances. An inconsistent fit never blocks drafting of spans
 *   themselves, but `fitScaleFromReferences` refuses to return a scale for it.
 * - This module has NO approval flags at all: there is nothing to forge. Every
 *   output is a provisional draft pending human review. Callers must state
 *   "pending review, not production-approved" wherever the bundle is surfaced.
 * - Safe-area ring validation reuses `validateSafePolygon` from
 *   `src/core/geometry/` (numeric epsilon 1e-9, not clearance).
 */

import { fitUniformScale, type CalibrationEvidence } from "../calibration/index.js";
import { validateSafePolygon } from "../geometry/index.js";
import { stableStringify } from "../calibration-session/index.js";

/** Provisional envelope version for `SetupCalibrationBundle`. */
export const SETUP_CALIBRATION_VERSION = "0.1.0-provisional-setup-calibration" as const;

/** Native-frame declaration for the bundle's spans. */
export type SetupCalibrationMode = "images" | "model";

/** 2D native point: image-UV or planar display units (NOT mm). Finite required. */
export interface SetupPoint2D {
  x: number;
  y: number;
}

/** 3D native point: actual 3D surface coordinates (NOT mm). Finite required. */
export interface SetupPoint3D {
  x: number;
  y: number;
  z: number;
}

export type SetupPoint = SetupPoint2D | SetupPoint3D;

/**
 * One known physical reference: two clicked points (A/B) plus the real-world
 * straight-line distance between them in millimetres. Both endpoints must
 * share a dimensionality (both 2D or both 3D); `lengthMm` must be > 0.
 */
export interface ReferenceSpan {
  id: string;
  a: SetupPoint;
  b: SetupPoint;
  lengthMm: number;
}

/** Named safe area in setup-frame millimetres (front-on planar assumption). */
export interface NamedSafeArea {
  id: string;
  name: string;
  points: Array<{ x: number; y: number }>;
}

export interface SetupCalibrationBundle {
  version: typeof SETUP_CALIBRATION_VERSION;
  mode: SetupCalibrationMode;
  spans: ReferenceSpan[];
  mmPerUnit: number | null;
  areas: NamedSafeArea[];
}

export type FitScaleResult =
  | { ok: true; mmPerUnit: number; perSpan: Array<{ id: string; mmPerUnit: number }> }
  | { ok: false; error: string };

export type ParseSetupCalibrationResult =
  | { ok: true; bundle: SetupCalibrationBundle }
  | { ok: false; error: string };

export type MigrateLegacyCombinedResult =
  | { ok: true; bundle: SetupCalibrationBundle; notes: string[] }
  | { ok: false; error: string };

/** Bounded-import policy for `parseSetupCalibration` / `migrateLegacyCombined`. */
export const SETUP_LIMITS = {
  /** Max accepted input text (UTF-16 code units; bounds memory before parse). */
  maxChars: 1048576,
  maxSpans: 128,
  maxAreas: 64,
  maxVerticesPerArea: 512,
  maxNameLength: 80,
  maxIdLength: 256,
} as const;

/**
 * Native-unit coincidence threshold: endpoints at or below this distance in
 * native units cannot establish a scale direction. A numeric conditioning
 * threshold, not a physical tolerance.
 */
const COINCIDENCE_EPS_NATIVE = 1e-9;

/** Scaffold identities used ONLY to route spans through `fitUniformScale`. */
const FIT_SCAFFOLD = {
  calibrationId: "setup-calibration-scale-fit",
  frameId: "setup-calibration-frame",
  product: "setup-calibration",
  assetFullSha256: "0".repeat(64),
  provisionalVersion: SETUP_CALIBRATION_VERSION,
} as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= SETUP_LIMITS.maxIdLength;
}

/** Dimensionality of a setup point, or null when it is not a finite point. */
function pointKind(point: unknown): "2d" | "3d" | null {
  if (!isPlainObject(point)) return null;
  if (!isFiniteNumber(point["x"]) || !isFiniteNumber(point["y"])) return null;
  const z: unknown = "z" in point ? point["z"] : undefined;
  if (z === undefined) return "2d";
  return isFiniteNumber(z) ? "3d" : null;
}

function copyPoint(point: SetupPoint): SetupPoint {
  if (pointKind(point) === "3d") {
    const p = point as SetupPoint3D;
    return { x: p.x, y: p.y, z: p.z };
  }
  const p = point as SetupPoint2D;
  return { x: p.x, y: p.y };
}

/** Euclidean native distance; 3D spans use the straight-line chord. */
function nativeDistance(a: SetupPoint, b: SetupPoint): number {
  const ka = pointKind(a);
  const kb = pointKind(b);
  if (ka === null || kb === null || ka !== kb) return NaN;
  if (ka === "3d") {
    const p = a as SetupPoint3D;
    const q = b as SetupPoint3D;
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  }
  const p = a as SetupPoint2D;
  const q = b as SetupPoint2D;
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/**
 * Validate one reference span. Rejects empty ids, non-finite coordinates,
 * mixed 2D/3D endpoints, coincident A/B (distance <= 1e-9 native units) and
 * non-positive/non-finite `lengthMm`. Returns a human reason, or null when valid.
 */
export function validateReferenceSpan(span: ReferenceSpan): string | null {
  if (!isPlainObject(span)) return "reference span must be an object";
  if (!isValidId(span["id"])) return "reference span id must be a non-empty string";
  const record = span as unknown as Record<string, unknown>;
  const ka = pointKind(record["a"]);
  const kb = pointKind(record["b"]);
  if (ka === null) return `span "${span["id"]}" endpoint A must be a 2D { x, y } or 3D { x, y, z } point of finite numbers`;
  if (kb === null) return `span "${span["id"]}" endpoint B must be a 2D { x, y } or 3D { x, y, z } point of finite numbers`;
  if (ka !== kb) {
    return `span "${span["id"]}" mixes 2D and 3D endpoints; one span must stay in a single native frame`;
  }
  const dist = nativeDistance(span.a, span.b);
  if (!Number.isFinite(dist)) return `span "${span["id"]}" has a non-finite native distance`;
  if (!(dist > COINCIDENCE_EPS_NATIVE)) {
    return `span "${span["id"]}" endpoints A/B are coincident (native distance ${dist} <= ${COINCIDENCE_EPS_NATIVE}); two distinct clicks are required`;
  }
  if (!isFiniteNumber(span.lengthMm)) return `span "${span["id"]}" lengthMm must be a finite number`;
  if (!(span.lengthMm > 0)) return `span "${span["id"]}" lengthMm must be > 0 mm`;
  return null;
}

/**
 * Euclidean native distance of a span (planar for 2D, straight-line chord for
 * 3D — NOT geodesic). Returns null when the span is invalid or coincident.
 */
export function spanNativeDistance(span: ReferenceSpan): number | null {
  if (validateReferenceSpan(span) !== null) return null;
  const dist = nativeDistance(span.a, span.b);
  if (!Number.isFinite(dist) || !(dist > COINCIDENCE_EPS_NATIVE)) return null;
  return dist;
}

/** Pure multiply with finite guards; throws on non-finite input or overflow. */
export function distanceMm(nativeDist: number, mmPerUnit: number): number {
  if (!isFiniteNumber(nativeDist)) throw new Error("distanceMm: nativeDist must be a finite number");
  if (!isFiniteNumber(mmPerUnit)) throw new Error("distanceMm: mmPerUnit must be a finite number");
  const result = nativeDist * mmPerUnit;
  if (!Number.isFinite(result)) throw new Error("distanceMm exceeds finite numeric range");
  return result;
}

function toFitVec3(point: SetupPoint): { x: number; y: number; z: number } {
  if (pointKind(point) === "3d") {
    const p = point as SetupPoint3D;
    return { x: p.x, y: p.y, z: p.z };
  }
  const p = point as SetupPoint2D;
  // 2D native units ride the z=0 plane of the scaffold fit; the fitted scalar
  // is frame-agnostic (mm per native unit) and the scaffold is discarded.
  return { x: p.x, y: p.y, z: 0 };
}

/**
 * Fit one uniform mm-per-native-unit scale over the given spans by reusing
 * the `fitUniformScale` kernel (unweighted isotropic least-squares over
 * straight-line spans; a single span yields exactly lengthMm/nativeDist).
 * Requires at least one valid span; rejects empty input, any invalid span,
 * duplicate ids, mixed 2D/3D frames, and spans that disagree beyond the
 * prototype threshold (kernel defaults: max(0.5 mm absolute, 1% relative) per
 * span — a prototype setting, not a production tolerance). Deterministic:
 * spans are processed and reported sorted by id.
 */
export function fitScaleFromReferences(spans: readonly ReferenceSpan[]): FitScaleResult {
  if (!Array.isArray(spans)) return { ok: false, error: "reference spans must be an array" };
  if (spans.length === 0) return { ok: false, error: "at least one reference span is required" };
  const seen = new Set<string>();
  let frame: "2d" | "3d" | null = null;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i] as ReferenceSpan;
    const reason = validateReferenceSpan(span);
    if (reason !== null) return { ok: false, error: `reference span ${i}: ${reason}` };
    if (seen.has(span.id)) return { ok: false, error: `duplicate reference span id "${span.id}"` };
    seen.add(span.id);
    const kind = pointKind(span.a) as "2d" | "3d";
    if (frame === null) frame = kind;
    else if (frame !== kind) {
      return { ok: false, error: "reference spans mix 2D (image/display) and 3D (model) frames; fit one frame at a time" };
    }
  }
  const sorted = [...spans].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const first = sorted[0] as ReferenceSpan;
  const evidence: CalibrationEvidence = {
    calibrationId: FIT_SCAFFOLD.calibrationId,
    frameId: FIT_SCAFFOLD.frameId,
    assetFullSha256: FIT_SCAFFOLD.assetFullSha256,
    product: FIT_SCAFFOLD.product,
    // Scaffold variant records the native frame only; it is discarded with
    // the scaffold and never represents a real product variant.
    variant: frame === "3d" ? "model" : "images",
    pairs: sorted.flatMap((span, index) => [
      { id: `span-${index}-a`, model: toFitVec3(span.a) },
      { id: `span-${index}-b`, model: toFitVec3(span.b) },
    ]),
    measuredDistanceMm: first.lengthMm,
    pairIds: ["span-0-a", "span-0-b"],
    provisionalVersion: FIT_SCAFFOLD.provisionalVersion,
    extraMeasurements: sorted.slice(1).map((span, index) => ({
      pairIds: [`span-${index + 1}-a`, `span-${index + 1}-b`] as [string, string],
      distanceMm: span.lengthMm,
    })),
  };
  let scaleMmPerUnit: number;
  let maxResidualMm: number;
  let inconsistent: boolean;
  try {
    const fit = fitUniformScale(evidence);
    scaleMmPerUnit = fit.scaleMmPerUnit;
    maxResidualMm = fit.maxResidualMm;
    inconsistent = fit.inconsistent;
  } catch (error) {
    return { ok: false, error: `scale fit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (inconsistent) {
    return {
      ok: false,
      error:
        `reference spans are inconsistent beyond the prototype threshold ` +
        `(max residual ${maxResidualMm} mm; allowed max(0.5 mm absolute, 1% relative) per span; ` +
        `prototype setting, not a production tolerance); re-measure before using any scale`,
    };
  }
  const perSpan: Array<{ id: string; mmPerUnit: number }> = [];
  for (const span of sorted) {
    const dist = spanNativeDistance(span) as number;
    const ratio = span.lengthMm / dist;
    if (!Number.isFinite(ratio) || !(ratio > 0)) {
      return { ok: false, error: `scale arithmetic exceeds finite range for span "${span.id}"` };
    }
    perSpan.push({ id: span.id, mmPerUnit: ratio });
  }
  return { ok: true, mmPerUnit: scaleMmPerUnit, perSpan };
}

/**
 * Validate one named safe area against already-taken ids. Requires a unique
 * non-blank id, a non-blank name of at most 80 chars, and 3..512 finite
 * vertices forming a valid non-self-crossing non-zero-area ring (reuses
 * `validateSafePolygon`; no partial acceptance). Returns a human reason, or
 * null when valid.
 */
export function validateNamedSafeArea(area: NamedSafeArea, existingIds: readonly string[]): string | null {
  if (!isPlainObject(area)) return "safe area must be an object";
  const record = area as unknown as Record<string, unknown>;
  if (!isValidId(record["id"])) return "safe area id must be a non-empty string";
  const id = record["id"] as string;
  if (existingIds.includes(id)) return `duplicate safe area id "${id}"`;
  const name = record["name"];
  if (typeof name !== "string" || name.trim().length === 0) return `safe area "${id}" name must be a non-empty string`;
  if (name.length > SETUP_LIMITS.maxNameLength) {
    return `safe area "${id}" name exceeds ${SETUP_LIMITS.maxNameLength} characters`;
  }
  const points = record["points"];
  if (!Array.isArray(points)) return `safe area "${id}" points must be an array`;
  if (points.length < 3) return `safe area "${id}" must have at least 3 vertices`;
  if (points.length > SETUP_LIMITS.maxVerticesPerArea) {
    return `safe area "${id}" exceeds ${SETUP_LIMITS.maxVerticesPerArea} vertices`;
  }
  for (let i = 0; i < points.length; i++) {
    const p: unknown = points[i];
    if (!isPlainObject(p) || !isFiniteNumber(p["x"]) || !isFiniteNumber(p["y"])) {
      return `safe area "${id}" vertex ${i} must be a finite { x, y } point (frame mm)`;
    }
  }
  const check = validateSafePolygon(area.points);
  if (!check.ok) return `safe area "${id}" invalid: ${check.errors.join("; ")}`;
  return null;
}

function copySpan(span: ReferenceSpan): ReferenceSpan {
  return { id: span.id, a: copyPoint(span.a), b: copyPoint(span.b), lengthMm: span.lengthMm };
}

function copyArea(area: NamedSafeArea): NamedSafeArea {
  return {
    id: area.id,
    name: area.name,
    points: area.points.map((p) => ({ x: p.x, y: p.y })),
  };
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** Strict internal span check returning a deep copy (unknown props ignored). */
function readSpan(value: unknown, label: string): { ok: true; span: ReferenceSpan } | { ok: false; error: string } {
  if (!isPlainObject(value)) return { ok: false, error: `${label} must be an object` };
  const candidate: ReferenceSpan = {
    id: typeof value["id"] === "string" ? value["id"] : "",
    a: value["a"] as SetupPoint,
    b: value["b"] as SetupPoint,
    lengthMm: value["lengthMm"] as number,
  };
  const reason = validateReferenceSpan(candidate);
  if (reason !== null) return { ok: false, error: `${label}: ${reason}` };
  return { ok: true, span: copySpan(candidate) };
}

/** Strict internal area check returning a deep copy (unknown props ignored). */
function readArea(
  value: unknown,
  label: string,
  takenIds: readonly string[],
): { ok: true; area: NamedSafeArea } | { ok: false; error: string } {
  if (!isPlainObject(value)) return { ok: false, error: `${label} must be an object` };
  const rawPoints: unknown = value["points"];
  const points = Array.isArray(rawPoints)
    ? rawPoints.map((p) => (isPlainObject(p) ? { x: p["x"] as number, y: p["y"] as number } : { x: NaN, y: NaN }))
    : [];
  const candidate: NamedSafeArea = {
    id: typeof value["id"] === "string" ? value["id"] : "",
    name: typeof value["name"] === "string" ? value["name"] : "",
    points,
  };
  const reason = validateNamedSafeArea(candidate, takenIds);
  if (reason !== null) return { ok: false, error: `${label}: ${reason}` };
  return { ok: true, area: copyArea(candidate) };
}

/**
 * Deterministic bundle text: spans/areas sorted by id, stable key order,
 * 2-space indent, no timestamps. Throws on invalid bundles (never serializes
 * a draft that would fail `parseSetupCalibration`).
 */
export function serializeSetupCalibration(bundle: SetupCalibrationBundle): string {
  if (!isPlainObject(bundle)) throw new Error("setup calibration bundle must be an object");
  const record = bundle as unknown as Record<string, unknown>;
  if (record["version"] !== SETUP_CALIBRATION_VERSION) {
    throw new Error("setup calibration bundle version must match " + SETUP_CALIBRATION_VERSION);
  }
  if (record["mode"] !== "images" && record["mode"] !== "model") {
    throw new Error('setup calibration bundle mode must be "images" or "model"');
  }
  if (!Array.isArray(record["spans"]) || !Array.isArray(record["areas"])) {
    throw new Error("setup calibration bundle spans and areas must be arrays");
  }
  if (record["mmPerUnit"] !== null && (!isFiniteNumber(record["mmPerUnit"]) || !(record["mmPerUnit"] as number > 0))) {
    throw new Error("setup calibration bundle mmPerUnit must be null or a finite number > 0");
  }
  const spans: ReferenceSpan[] = [];
  const spanIds = new Set<string>();
  for (let i = 0; i < (record["spans"] as unknown[]).length; i++) {
    const read = readSpan((record["spans"] as unknown[])[i], `spans[${i}]`);
    if (!read.ok) throw new Error(read.error);
    if (spanIds.has(read.span.id)) throw new Error(`duplicate reference span id "${read.span.id}"`);
    spanIds.add(read.span.id);
    spans.push(read.span);
  }
  const areas: NamedSafeArea[] = [];
  const areaIds = new Set<string>();
  for (let i = 0; i < (record["areas"] as unknown[]).length; i++) {
    const read = readArea((record["areas"] as unknown[])[i], `areas[${i}]`, [...areaIds]);
    if (!read.ok) throw new Error(read.error);
    areaIds.add(read.area.id);
    areas.push(read.area);
  }
  const expectedKind = (record["mode"] as string) === "images" ? "2d" : "3d";
  for (const span of spans) {
    if (pointKind(span.a) !== expectedKind || pointKind(span.b) !== expectedKind) {
      throw new Error(`span "${span.id}" frame does not match bundle mode "${record["mode"]}"`);
    }
  }
  const ordered = {
    version: SETUP_CALIBRATION_VERSION,
    mode: record["mode"] as SetupCalibrationMode,
    spans: sortById(spans),
    mmPerUnit: record["mmPerUnit"] as number | null,
    areas: sortById(areas),
  };
  // Stable key order at every level; pretty text is canonical (roundtrips byte-identical).
  return JSON.stringify(JSON.parse(stableStringify(ordered)), null, 2);
}

/**
 * Parse setup-calibration JSON (a JSON string or an already-parsed value).
 * Bounded before validation (<=1 MiB text, <=128 spans, <=64 areas, <=512
 * vertices per area). Unknown properties are ignored. The bundle carries NO
 * approval flags — parsed output is always a provisional draft pending human
 * review; callers must say so wherever it is surfaced.
 */
export function parseSetupCalibration(json: unknown): ParseSetupCalibrationResult {
  const fail = (error: string): ParseSetupCalibrationResult => ({ ok: false, error });
  let value: unknown = json;
  if (typeof value === "string") {
    if (value.length > SETUP_LIMITS.maxChars) {
      return fail(`setup calibration file exceeds ${SETUP_LIMITS.maxChars} characters`);
    }
    try {
      value = JSON.parse(value);
    } catch {
      return fail("setup calibration file is not valid JSON");
    }
  }
  if (!isPlainObject(value)) return fail("setup calibration bundle must be an object");
  if (value["version"] !== SETUP_CALIBRATION_VERSION) {
    return fail("unknown or mismatched setup-calibration version");
  }
  const mode = value["mode"];
  if (mode !== "images" && mode !== "model") {
    return fail('setup calibration mode must be "images" or "model"');
  }
  const mmPerUnit = value["mmPerUnit"];
  if (mmPerUnit !== null && (!isFiniteNumber(mmPerUnit) || !(mmPerUnit > 0))) {
    return fail("setup calibration mmPerUnit must be null or a finite number > 0");
  }
  const rawSpans = value["spans"];
  const rawAreas = value["areas"];
  if (!Array.isArray(rawSpans)) return fail("setup calibration spans must be an array");
  if (!Array.isArray(rawAreas)) return fail("setup calibration areas must be an array");
  if (rawSpans.length > SETUP_LIMITS.maxSpans) {
    return fail(`setup calibration exceeds ${SETUP_LIMITS.maxSpans} spans`);
  }
  if (rawAreas.length > SETUP_LIMITS.maxAreas) {
    return fail(`setup calibration exceeds ${SETUP_LIMITS.maxAreas} areas`);
  }
  const spans: ReferenceSpan[] = [];
  const spanIds = new Set<string>();
  for (let i = 0; i < rawSpans.length; i++) {
    const read = readSpan(rawSpans[i], `spans[${i}]`);
    if (!read.ok) return fail(read.error);
    if (spanIds.has(read.span.id)) return fail(`duplicate reference span id "${read.span.id}"`);
    spanIds.add(read.span.id);
    spans.push(read.span);
  }
  const areas: NamedSafeArea[] = [];
  const areaIds = new Set<string>();
  for (let i = 0; i < rawAreas.length; i++) {
    const read = readArea(rawAreas[i], `areas[${i}]`, [...areaIds]);
    if (!read.ok) return fail(read.error);
    areaIds.add(read.area.id);
    areas.push(read.area);
  }
  const expectedKind = mode === "images" ? "2d" : "3d";
  for (const span of spans) {
    if (pointKind(span.a) !== expectedKind || pointKind(span.b) !== expectedKind) {
      return fail(`span "${span.id}" frame does not match bundle mode "${mode}"`);
    }
  }
  return {
    ok: true,
    bundle: {
      version: SETUP_CALIBRATION_VERSION,
      mode,
      spans: sortById(spans),
      mmPerUnit,
      areas: sortById(areas),
    },
  };
}

/**
 * Provisional compat import for an older combined model+photos setup shape.
 *
 * Recognized (anything else is an explicit error, never guessed): a plain
 * object carrying reference spans in at least one of `spans`, `model.spans`
 * or `photos[i].spans`, and/or named areas in `areas` or `model.areas`, with
 * an optional explicit `mode`. Unknown properties are ignored.
 *
 * Geometry is preserved verbatim (coordinates are copied, never invented or
 * converted). A carried `mmPerUnit` is DISCARDED and the scale is recomputed
 * locally with `fitScaleFromReferences` (left null when spans disagree). All
 * spans must share one native frame — a legacy file mixing 2D (image/display)
 * and 3D (model) spans is rejected with instructions to split by frame. The
 * result is a provisional draft pending review; `notes` records every
 * inference (mode inference, discarded scale, unset scale) so callers can
 * surface it honestly.
 */
export function migrateLegacyCombined(input: unknown): MigrateLegacyCombinedResult {
  const fail = (error: string): MigrateLegacyCombinedResult => ({ ok: false, error });
  if (!isPlainObject(input)) return fail("legacy combined setup must be an object");
  const spanSources: Array<{ source: string; value: unknown }> = [];
  const areaSources: Array<{ source: string; value: unknown }> = [];
  if (Array.isArray(input["spans"])) {
    input["spans"].forEach((v, i) => spanSources.push({ source: `spans[${i}]`, value: v }));
  }
  const model = input["model"];
  if (isPlainObject(model)) {
    if (Array.isArray(model["spans"])) {
      model["spans"].forEach((v, i) => spanSources.push({ source: `model.spans[${i}]`, value: v }));
    }
    if (Array.isArray(model["areas"])) {
      model["areas"].forEach((v, i) => areaSources.push({ source: `model.areas[${i}]`, value: v }));
    }
  }
  let photoSpanCount = 0;
  if (Array.isArray(input["photos"])) {
    input["photos"].forEach((photo, pi) => {
      if (isPlainObject(photo) && Array.isArray(photo["spans"])) {
        photo["spans"].forEach((v, i) => spanSources.push({ source: `photos[${pi}].spans[${i}]`, value: v }));
        photoSpanCount += (photo["spans"] as unknown[]).length;
      }
    });
  }
  if (Array.isArray(input["areas"])) {
    input["areas"].forEach((v, i) => areaSources.push({ source: `areas[${i}]`, value: v }));
  }
  if (spanSources.length === 0 && areaSources.length === 0) {
    return fail("unrecognized legacy combined shape: no spans (spans, model.spans, photos[].spans) or areas (areas, model.areas) found");
  }
  if (spanSources.length > SETUP_LIMITS.maxSpans) {
    return fail(`legacy combined setup exceeds ${SETUP_LIMITS.maxSpans} spans`);
  }
  if (areaSources.length > SETUP_LIMITS.maxAreas) {
    return fail(`legacy combined setup exceeds ${SETUP_LIMITS.maxAreas} areas`);
  }
  const notes: string[] = [
    "provisional legacy migration; output is a draft pending human review and is never production-approved",
  ];
  const spans: ReferenceSpan[] = [];
  const spanIds = new Set<string>();
  for (const entry of spanSources) {
    const read = readSpan(entry.value, entry.source);
    if (!read.ok) return fail(`legacy ${read.error}`);
    if (spanIds.has(read.span.id)) return fail(`legacy duplicate reference span id "${read.span.id}"`);
    spanIds.add(read.span.id);
    spans.push(read.span);
  }
  const areas: NamedSafeArea[] = [];
  const areaIds = new Set<string>();
  for (const entry of areaSources) {
    const read = readArea(entry.value, entry.source, [...areaIds]);
    if (!read.ok) return fail(`legacy ${read.error}`);
    areaIds.add(read.area.id);
    areas.push(read.area);
  }
  const kinds = new Set(spans.map((s) => pointKind(s.a)));
  if (kinds.size > 1) {
    return fail("legacy combined setup mixes 2D (image/display) and 3D (model) spans; split by frame and migrate each separately");
  }
  const rawMode = input["mode"];
  let mode: SetupCalibrationMode | null =
    rawMode === "images" || rawMode === "model" ? rawMode : null;
  if (mode === null) {
    if (photoSpanCount > 0) {
      mode = "images";
      notes.push('mode "images" inferred from photo-sourced spans (no explicit mode in legacy input)');
    } else if (spans.length > 0 && kinds.has("3d")) {
      mode = "model";
      notes.push('mode "model" inferred from 3D spans (no explicit mode in legacy input)');
    } else if (spans.length > 0 && kinds.has("2d")) {
      mode = "images";
      notes.push('mode "images" inferred from 2D spans (no explicit mode in legacy input)');
    } else {
      return fail('legacy combined setup has no mode: declare "images" or "model" explicitly');
    }
  }
  const expectedKind = mode === "images" ? "2d" : "3d";
  for (const span of spans) {
    if (pointKind(span.a) !== expectedKind) {
      return fail(`legacy span "${span.id}" frame does not match mode "${mode}"; split by frame and migrate each separately`);
    }
  }
  if ("mmPerUnit" in input || (isPlainObject(model) && "mmPerUnit" in model)) {
    notes.push("legacy mmPerUnit discarded; scale is recomputed locally and stays pending review");
  }
  let mmPerUnit: number | null = null;
  if (spans.length > 0) {
    const fit = fitScaleFromReferences(spans);
    if (fit.ok) {
      mmPerUnit = fit.mmPerUnit;
      notes.push(`scale recomputed locally from ${spans.length} span(s) (pending review, not production-approved)`);
    } else {
      notes.push(`scale left unset: ${fit.error}`);
    }
  }
  return {
    ok: true,
    bundle: {
      version: SETUP_CALIBRATION_VERSION,
      mode,
      spans: sortById(spans),
      mmPerUnit,
      areas: sortById(areas),
    },
    notes,
  };
}
