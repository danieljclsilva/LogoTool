/**
 * Pure visual anchor-to-logo-edge dimension resolver (Tranche B).
 *
 * No DOM, browser, Three.js, pixel, or service imports. Pointer coordinates
 * only select identities (which anchor, which artwork edge); the dimension
 * itself is computed from canonical millimetres by `measureEdgeToAnchor`,
 * reusing its exact edge/convention compatibility rules and millimetre
 * arithmetic. No new rounding, no pixel-distance export, no schema changes.
 * `logoRef` stays with the caller: the binding carries
 * anchorId/edge/convention only.
 *
 * Resolution order (deterministic; ties keep the lowest index/order):
 * 1. the nearest finite anchor to `anchorClickMm` must lie within
 *    `snapTolMm`, otherwise `none-in-tolerance`;
 * 2. the nearest artwork edge to `edgeClickMm`: each named edge is
 *    represented by the rotated-footprint side whose midpoint is extreme
 *    along that axis (smallest midpoint X for `minX`, and so on; ties
 *    resolve to the lowest side index), mirroring `measureEdgeToAnchor`,
 *    so the measured arrow always relates to the clicked side;
 * 3. when `maxEdgeDistMm` is present, the click must lie within it of the
 *    resolved edge's representative segment (boundary inclusive),
 *    otherwise `edge-too-far` — a blank-garment click never silently binds
 *    a far edge. This gates selection only: dx/dy keep the existing
 *    extent/supporting-line convention and measurement arithmetic;
 * 4. the resolved edge must be compatible with `convention` (`dx` only
 *    `minX`/`maxX`, `dy` only `minY`/`maxY`; `shortest-to-edge` accepts
 *    any edge), otherwise `incompatible-edge-or-convention`.
 */

import {
  measureEdgeToAnchor,
  rotatedFootprintCorners,
} from "../operation-measurements/index.js";
import type {
  ArtworkEdge,
  MeasurementConvention,
  MeasurementPoint,
} from "../operation-measurements/types.js";
import type {
  ResolveVisualDimensionInput,
  VisualDimensionBinding,
  VisualDimensionErrorCode,
  VisualDimensionResult,
} from "./types.js";

export type {
  ResolveVisualDimensionInput,
  VisualAnchorInput,
  VisualDimensionBinding,
  VisualDimensionError,
  VisualDimensionErrorCode,
  VisualDimensionOk,
  VisualDimensionResult,
  VisualFootprintInput,
} from "./types.js";

/** Fixed edge order for representative-segment choice and tie-breaking. */
const EDGE_ORDER: readonly ArtworkEdge[] = ["minX", "maxX", "minY", "maxY"];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFinitePair(value: unknown): value is readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const pair = value as readonly unknown[];
  return isFiniteNumber(pair[0]) && isFiniteNumber(pair[1]);
}

function isFinitePoint(point: MeasurementPoint): boolean {
  return isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function fail(code: VisualDimensionErrorCode, message: string): VisualDimensionResult {
  return { ok: false, code, message };
}

function pointToSegmentDistance(
  point: MeasurementPoint,
  start: MeasurementPoint,
  end: MeasurementPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (!(lengthSq > 0) || !Number.isFinite(lengthSq)) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
  if (!Number.isFinite(t)) t = 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

/**
 * Representative side for a named edge: the footprint side whose midpoint
 * is extreme along that axis. Identical rule to `measureEdgeToAnchor`
 * (lowest side index wins ties) so the resolved edge always measures the
 * clicked side, including under rotation.
 */
function representativeSide(corners: readonly MeasurementPoint[], edge: ArtworkEdge): number {
  let bestIndex = 0;
  let bestScore = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const start = corners[i]!;
    const end = corners[(i + 1) % corners.length]!;
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const score = edge === "minX" ? -midX : edge === "maxX" ? midX
      : edge === "minY" ? -midY : midY;
    if (i === 0 || score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** Same compatibility rule as `measureEdgeToAnchor`: never relabels axes. */
function isCompatible(edge: ArtworkEdge, convention: MeasurementConvention): boolean {
  if (convention === "dx") return edge === "minX" || edge === "maxX";
  if (convention === "dy") return edge === "minY" || edge === "maxY";
  return true;
}

function edgeWord(edge: ArtworkEdge): "left" | "right" | "bottom" | "top" {
  return edge === "minX" ? "left" : edge === "maxX" ? "right" : edge === "minY" ? "bottom" : "top";
}

export function resolveVisualDimension(input: ResolveVisualDimensionInput): VisualDimensionResult {
  const convention: unknown = input.convention;
  if (convention !== "dx" && convention !== "dy" && convention !== "shortest-to-edge") {
    return fail(
      "incompatible-edge-or-convention",
      `unknown measurement convention "${String(convention)}" (want dx|dy|shortest-to-edge)`,
    );
  }
  const footprint = input.footprint;
  if (
    footprint === null ||
    typeof footprint !== "object" ||
    !isFinitePair(footprint.centerMm) ||
    !isFiniteNumber(footprint.widthMm) ||
    !isFiniteNumber(footprint.heightMm) ||
    !(footprint.widthMm > 0) ||
    !(footprint.heightMm > 0) ||
    !isFiniteNumber(footprint.rotationDeg)
  ) {
    return fail(
      "non-finite",
      "logo footprint must be finite with positive width/height millimetres and a finite rotation",
    );
  }
  if (!isFinitePair(input.anchorClickMm) || !isFinitePair(input.edgeClickMm)) {
    return fail("non-finite", "pointer positions must be finite [x, y] millimetres");
  }
  if (!isFiniteNumber(input.snapTolMm) || !(input.snapTolMm >= 0)) {
    return fail("non-finite", "snap tolerance must be finite millimetres >= 0");
  }
  const maxEdgeDist: number | undefined = input.maxEdgeDistMm;
  if (maxEdgeDist !== undefined && (!isFiniteNumber(maxEdgeDist) || !(maxEdgeDist >= 0))) {
    return fail("non-finite", "edge tolerance must be finite millimetres >= 0");
  }
  const anchors = input.anchors;
  if (!Array.isArray(anchors) || anchors.length === 0) {
    return fail("no-anchors", "no anchors are defined on this view; place a named anchor first");
  }

  const anchorClick: MeasurementPoint = { x: input.anchorClickMm[0], y: input.anchorClickMm[1] };
  let bestAnchor = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i]!;
    if (typeof anchor.id !== "string" || anchor.id.length === 0) continue;
    if (!isFinitePair(anchor.posMm)) continue;
    const dist = Math.hypot(anchor.posMm[0] - anchorClick.x, anchor.posMm[1] - anchorClick.y);
    if (Number.isFinite(dist) && dist < bestDist) {
      bestDist = dist;
      bestAnchor = i;
    }
  }
  if (bestAnchor < 0 || !(bestDist <= input.snapTolMm)) {
    return fail(
      "none-in-tolerance",
      `no anchor within ${input.snapTolMm} mm of the chosen point; click an existing named anchor`,
    );
  }
  const selected = anchors[bestAnchor]!;
  const anchorPoint: MeasurementPoint = { x: selected.posMm[0], y: selected.posMm[1] };

  const corners = rotatedFootprintCorners(
    footprint.centerMm[0],
    footprint.centerMm[1],
    footprint.widthMm,
    footprint.heightMm,
    footprint.rotationDeg,
  );
  if (corners.length < 3 || !corners.every(isFinitePoint)) {
    return fail("non-finite", "logo footprint corners must be finite { x, y } millimetres");
  }

  const edgeClick: MeasurementPoint = { x: input.edgeClickMm[0], y: input.edgeClickMm[1] };
  let edge: ArtworkEdge = EDGE_ORDER[0]!;
  let edgeDist = Number.POSITIVE_INFINITY;
  for (const candidate of EDGE_ORDER) {
    const side = representativeSide(corners, candidate);
    const start = corners[side]!;
    const end = corners[(side + 1) % corners.length]!;
    const dist = pointToSegmentDistance(edgeClick, start, end);
    if (Number.isFinite(dist) && dist < edgeDist) {
      edgeDist = dist;
      edge = candidate;
    }
  }

  if (maxEdgeDist !== undefined && !(edgeDist <= maxEdgeDist)) {
    return fail(
      "edge-too-far",
      `edge click is ${edgeDist} mm from the ${edgeWord(edge)} artwork edge ` +
      `(tolerance ${maxEdgeDist} mm); click the logo edge itself`,
    );
  }

  if (!isCompatible(edge, convention)) {
    const axis = convention === "dx" ? "horizontally" : "vertically";
    const want = convention === "dx" ? "left or right" : "bottom or top";
    return fail(
      "incompatible-edge-or-convention",
      `${convention} measures ${axis}, so choose the ${want} artwork edge ` +
      `(not the clicked ${edgeWord(edge)} edge)`,
    );
  }

  const measured = measureEdgeToAnchor(corners, anchorPoint, { edge, convention });
  if (!measured.ok) {
    return fail("non-finite", measured.error);
  }
  const binding: VisualDimensionBinding = { anchorId: selected.id, edge, convention };
  return {
    ok: true,
    binding,
    valueMm: measured.valueMm,
    edgeDistanceMm: edgeDist,
    endpoints: [{ x: measured.endpoints[0].x, y: measured.endpoints[0].y }, { x: measured.endpoints[1].x, y: measured.endpoints[1].y }],
  };
}
