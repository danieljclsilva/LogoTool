/**
 * Edge-to-anchor measurement contract types.
 *
 * Pure data: no DOM, browser, Three.js, pixels, or service dependencies.
 * All positions are authoritative physical millimetres in an explicitly
 * selected region frame. Photo-mapping pixels never enter this math, even
 * under shear/anisotropic photo affines: the photo overlay is a separate,
 * presentation-only concern.
 *
 * Measurement convention (unambiguous):
 * - `dx`: signed horizontal (frame X-axis) distance from the artwork's
 *   supporting X extent to the anchor: `valueMm = anchor.x - extentX`, where
 *   `extentX` is the minimum footprint X for edge `minX` or the maximum
 *   footprint X for edge `maxX`. Positive means the anchor lies toward +X
 *   from the artwork. The reported segment runs horizontally at anchor
 *   height, from the extent line to the anchor. `dx` rejects any edge other
 *   than `minX`/`maxX` (never silently relabels a Y edge as an X extent).
 * - `dy`: signed vertical (frame Y-axis) distance from the artwork's
 *   supporting Y extent to the anchor: `valueMm = anchor.y - extentY`
 *   (`minY`/`maxY` select the extent). Positive means the anchor lies toward
 *   +Y from the artwork. The reported segment runs vertically at anchor
 *   X, from the extent line to the anchor. `dy` rejects any edge other than
 *   `minY`/`maxY`.
 * - `shortest-to-edge`: unsigned Euclidean distance from the anchor to the
 *   closest point on the selected finite artwork edge segment. The named
 *   edge resolves to the rotated-footprint side whose midpoint is extreme
 *   along that axis (smallest midpoint X for `minX`, and so on; ties resolve
 *   to the lowest side index so the choice is deterministic). The reported
 *   segment runs from the anchor to that closest point. Accepts all four
 *   edges.
 *
 * For rotated artwork the `dx`/`dy` extents are the axis-aligned bounding
 * extents of the rotated footprint; only `shortest-to-edge` touches the true
 * rotated edge segment. An orthogonal dimension line starts on the artwork
 * boundary only when the anchor ordinate falls within the measured edge's
 * span (`touchesArtwork: true`); otherwise the supporting line is extended
 * beyond the artwork and `artworkPoint` carries the extreme corner a
 * renderer links with a visible extension. The `edgeDescription` on every
 * result states which case was measured, in ordinary language.
 *
 * Stale or mismatched scope (wrong product/variant/region/frame/calibration),
 * missing anchors, and invalid bindings never fabricate a number: resolution
 * reports them as explicit unfinished reasons instead.
 */

export type OperationDraftVersion = "operation-draft/1";

export interface AnchorDef {
  id: string;
  name: string;
  productId: string;
  variantId: string;
  regionId: string;
  frameId: string;
  calibrationId: string;
  calibrationVersion: string;
  /** Anchor position in the region frame, millimetres: [xMm, yMm]. */
  posMm: [number, number];
}

export type ArtworkEdge = "minX" | "maxX" | "minY" | "maxY";

export type MeasurementConvention = "dx" | "dy" | "shortest-to-edge";

export interface DimensionBinding {
  /**
   * Placement selector within one configuration: the placement `id` when one
   * is recorded, otherwise `logoId` for the first placement of that logo, or
   * `logoId#n` (0-based) for the nth placement of a repeated logo.
   */
  logoRef: string;
  anchorId: string;
  edge: ArtworkEdge;
  convention: MeasurementConvention;
  /** Operator-facing label, e.g. "centre front to left edge, horizontal". */
  label: string;
}

/** One point in the region frame, millimetres. */
export interface MeasurementPoint {
  x: number;
  y: number;
}

export interface EdgeMeasurementOk {
  ok: true;
  /** Signed for dx/dy, unsigned (>= 0) for shortest-to-edge. Millimetres. */
  valueMm: number;
  /**
   * The measured segment, ALWAYS artwork→anchor: `endpoints[1]` is the
   * anchor point (region-frame mm) and `endpoints[0]` is the artwork-side
   * point (the supporting-extent line point for dx/dy; the closest finite-
   * edge point for shortest-to-edge). The drawable arrow runs artwork to
   * anchor; the `fromAnchor` name label belongs at `endpoints[1]`.
   */
  endpoints: [MeasurementPoint, MeasurementPoint];
  /** Ordinary-language description of what was measured (never just "X"/"Y"). */
  edgeDescription: string;
  /**
   * Arrow honesty for dx/dy: true when the segment start (`endpoints[0]`)
   * coincides with an actual footprint point within 1e-9, i.e. the anchor
   * ordinate falls within the measured edge's span. False when the
   * supporting line is extended beyond the artwork — then `artworkPoint`
   * carries the extreme corner a renderer links with a visible extension.
   * Always true for shortest-to-edge (its endpoint is the closest point on
   * the finite edge by construction).
   */
  touchesArtwork: boolean;
  /**
   * Extreme artwork corner nearest the segment start. Present only when
   * `touchesArtwork` is false.
   */
  artworkPoint?: MeasurementPoint;
}

export interface EdgeMeasurementError {
  ok: false;
  error: string;
}

export type EdgeMeasurement = EdgeMeasurementOk | EdgeMeasurementError;

export interface ResolvedDimension {
  label: string;
  valueMm: number;
  /** Anchor display name the distance was measured from. */
  fromAnchor: string;
  /** Ordinary-language description of the artwork edge/extent measured to. */
  toEdge: string;
  /**
   * The measured segment, ALWAYS artwork→anchor: `endpoints[1]` is the
   * anchor point (region-frame mm) named by `fromAnchor`; `endpoints[0]`
   * is the artwork-side point.
   */
  endpoints: [MeasurementPoint, MeasurementPoint];
  /**
   * Arrow honesty threaded from the edge measurement: false means the
   * drawable dimension line starts off-artwork and `artworkPoint` carries
   * the extreme corner a renderer links with a visible extension.
   */
  touchesArtwork: boolean;
  /** Extreme artwork corner nearest the dimension-line start; only when `touchesArtwork` is false. */
  artworkPoint?: MeasurementPoint;
}

export interface PlacementMeasure {
  dimensions: ResolvedDimension[];
  /** Explicit unfinished reasons; empty when every binding measured. */
  unfinished: string[];
}

/**
 * Small local operational draft sidecar: provisional workflow metadata the
 * logo department saves and reopens while authoring an operation sheet. This
 * is local workflow state only, bound to one source revision/digest — never
 * an Odoo/production schema and never production truth.
 *
 * A draft targets exactly one operation sheet (one configuration):
 * - ordinary single-configuration jobs omit `configurationId`;
 * - multi-sheet jobs persist one draft per sheet, each with its own
 *   `configurationId` selecting the sheet it targets.
 *
 * `dimensions` is the flat staff-chosen binding list for that sheet; the view
 * builder consumes it as `bindings: { [configurationId]: dimensions }`
 * (or `{ [soleConfigId]: dimensions }` when `configurationId` is absent).
 * Missing/stale anchors or bindings stay unset on rebuild — a reopened draft
 * never fabricates numbers.
 */
export interface OperationDraftJob {
  customer?: string;
  reference?: string;
  article?: string;
}

export interface OperationDraft {
  version: OperationDraftVersion;
  /** Numeric contract generation; always 1 for `operation-draft/1`. */
  draftVersion: 1;
  /** Candidate revision this draft was saved against (`ResultCandidate.revision`). */
  sourceRevision: number;
  /** Candidate digest this draft was saved against (`ResultCandidate.digest`). */
  sourceDigest: string;
  /**
   * Configuration (sheet) this draft targets. Absent means the job's sole
   * configuration; multi-sheet jobs store one draft per sheet with this set.
   */
  configurationId?: string;
  job: OperationDraftJob;
  /** Department-authored operational text (separate from customer notes). */
  operationalInstructions: string;
  /** Supplied technique settings only (temperature/time/pressure/colour/thread). */
  methodParams?: Record<string, string>;
  /** Authored anchors in authoritative region-frame millimetres. */
  anchors: AnchorDef[];
  /** Staff-chosen dimension bindings for the targeted sheet. */
  dimensions: DimensionBinding[];
  /** Optional free-text note about the latest local edit. */
  updatedNote?: string;
}
