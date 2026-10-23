/**
 * Visual anchor-to-logo-edge dimension resolver contract (Tranche B).
 *
 * Pure data: no DOM, browser, Three.js, pixels, or service dependencies.
 * All positions are authoritative physical millimetres in one explicitly
 * selected region frame. Pointer coordinates only select identities (which
 * anchor, which artwork edge); the dimension itself is canonical
 * millimetre arithmetic. The caller keeps `logoRef` (placement identity):
 * the resolved binding carries anchorId/edge/convention only.
 */

import type {
  ArtworkEdge,
  MeasurementConvention,
  MeasurementPoint,
} from "../operation-measurements/types.js";

/** One named anchor candidate in the region frame, millimetres. */
export interface VisualAnchorInput {
  id: string;
  posMm: readonly [number, number];
}

/** Logo footprint to measure from, in the region frame, millimetres. */
export interface VisualFootprintInput {
  centerMm: readonly [number, number];
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
}

export interface ResolveVisualDimensionInput {
  anchors: readonly VisualAnchorInput[];
  footprint: VisualFootprintInput;
  /** Pointer position (region-frame mm) used to pick the anchor identity. */
  anchorClickMm: readonly [number, number];
  /** Pointer position (region-frame mm) used to pick the artwork edge. */
  edgeClickMm: readonly [number, number];
  convention: MeasurementConvention;
  /** Maximum pointer-to-anchor distance that still selects, millimetres. */
  snapTolMm: number;
  /**
   * Optional maximum pointer-to-artwork-edge distance that still selects,
   * millimetres. When absent, the nearest edge always resolves (legacy
   * behavior: a click anywhere still picks an edge). When present it must
   * be finite and >= 0; a click landing farther from its resolved edge is
   * rejected with `edge-too-far` instead of silently binding a far edge.
   */
  maxEdgeDistMm?: number;
}

/**
 * Staff-chosen binding: anchor identity + artwork edge + convention.
 * No logoRef: placement identity stays with the caller.
 */
export interface VisualDimensionBinding {
  anchorId: string;
  edge: ArtworkEdge;
  convention: MeasurementConvention;
}

export type VisualDimensionErrorCode =
  | "no-anchors"
  | "none-in-tolerance"
  | "incompatible-edge-or-convention"
  | "edge-too-far"
  | "non-finite";

export interface VisualDimensionOk {
  ok: true;
  binding: VisualDimensionBinding;
  /** Signed for dx/dy, unsigned (>= 0) for shortest-to-edge. Millimetres. */
  valueMm: number;
  /**
   * Pointer-to-representative-segment distance for the resolved edge,
   * millimetres: how far the edge click landed from the artwork side it
   * selected. Present on every success so the UI can render hit feedback.
   * Gating only: dx/dy keep the existing extent/supporting-line convention
   * and `valueMm` arithmetic unchanged by this revision.
   */
  edgeDistanceMm: number;
  /**
   * The measured segment, ALWAYS artwork→anchor: `endpoints[1]` is the
   * anchor point (region-frame mm) and `endpoints[0]` is the artwork-side
   * point. The drawable arrow runs artwork to anchor.
   */
  endpoints: [MeasurementPoint, MeasurementPoint];
}

export interface VisualDimensionError {
  ok: false;
  code: VisualDimensionErrorCode;
  message: string;
}

export type VisualDimensionResult = VisualDimensionOk | VisualDimensionError;
