/**
 * Operation-document view model.
 *
 * Pure structural description of what appears in the internal pending-review
 * operation document. Derived from a `ResultCandidate` snapshot; no DOM,
 * browser, or PDF dependencies.
 */

import type {
  AssetRole,
  ExportCalibration,
  ExportFrame,
  ResultCandidate,
} from "../types.js";
import type {
  AnchorDef,
  DimensionBinding,
  MeasurementPoint,
} from "../operation-measurements/types.js";

export interface OperationDocument {
  /** Document identity and review status. */
  identity: OperationIdentity;
  /** Human-readable limitations printed on every document. */
  limitations: string[];
  /** Compact operator proof summary (display-rounded), ahead of the exact appendix. */
  proof: OperationProofConfiguration[];
  /** Per-configuration pages/sections. */
  configurations: OperationConfiguration[];
  /** Raw project instructions, if any. */
  projectInstructions?: string;
}

/**
 * Display-only photo state for one reference side. `reference-only` means no
 * evaluated photo-mapping binds the view: the photo is an unmapped contextual
 * image and never a placement proof. `mapped-*` states require an explicitly
 * supplied, adapter-evaluated binding (see `PhotoMappingState`).
 */
export type ProofPhotoState = "reference-only" | "mapped-provisional" | "mapped-review";

/** Millimetre-to-photo affine coefficients (region-local mm to normalized UV). */
export interface PhotoMappingTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** One placement row of the compact proof summary (display-rounded, 1 decimal). */
export interface OperationProofPlacement {
  logoId: string;
  /** Business logo name from the logo definition, if supplied. */
  logoName: string | null;
  regionId: string;
  regionName: string | null;
  method: string;
  /** 1-decimal display strings; the canonical exact values stay in the appendix. */
  widthMm1: string;
  heightMm1: string;
  centreX1: string;
  centreY1: string;
  rotationDeg: number;
  /**
   * Exact canonical values, reported separately from the display-rounded
   * fields above: the mapped photo-proof renderer consumes these (never the
   * rounded strings), so the overlay matches the appendix to full precision.
   */
  pos: { xMm: number; yMm: number };
  widthMm: number;
  heightMm: number;
  /** Concise artwork verdict, e.g. "2 assets, 2 previewable" or "no artwork assets". */
  artworkStatus: string;
  /**
   * Package paths of header-validated raster originals for this logo, for
   * mapped photo-proof compositing. Empty when none is renderable. The
   * renderer materializes bytes supplied separately; no blobs live here.
   */
  artworkUris: string[];
}

/** One reference side of the compact proof summary. */
export interface OperationProofSide {
  /** Presentation side, or null for a legacy single reference. */
  view: string | null;
  label: string | null;
  imagePath: string;
  photoState: ProofPhotoState;
  /** Explicit adapter warning for this side, if any. */
  note: string | null;
  /**
   * Evaluated mapping binding for this exact image path (region, side and
   * affine transform), present only when the caller evaluated one. The
   * renderer draws the mapped photo proof from it; absent means text-only.
   */
  mapping?: {
    regionId: string;
    view: string;
    transform: PhotoMappingTransform;
    status: "provisional" | "review";
  } | null;
}

/** Compact per-configuration proof summary (one entry per configuration). */
export interface OperationProofConfiguration {
  configurationId: string;
  productId: string;
  variantId: string;
  productName?: string;
  variantName?: string;
  placements: OperationProofPlacement[];
  /** One entry per supplied reference view; empty when no photos are supplied. */
  sides: OperationProofSide[];
}

export interface OperationIdentity {
  projectId: string;
  revision: number;
  digest: string;
  /** First 16 hex characters of the digest for prominent display; full digest stays in `digest`. */
  shortDigest: string;
  schemaVersion: string;
  /** Optional ISO 8601 UTC timestamp; injected by caller, no default clock. */
  generatedAt?: string;
  /** Always candidate-pending-review in this bounded slice. */
  reviewStatus: string;
  /** Calibration/physical validation caveat. */
  calibrationStatus: string;
  /** Separate local customer confirmation evidence, if present. */
  customerConfirmation?: string;
  /** Separate local internal review evidence, if present. */
  internalReview?: string;
}

export interface OperationConfiguration {
  /** 0-based index used only for stable ordering; display uses 1-based. */
  index: number;
  id: string;
  productId: string;
  variantId: string;
  productName?: string;
  variantName?: string;
  placements: OperationPlacement[];
  /** Illustrative product reference views selected by the caller via the presentation adapter. */
  referenceViews: OperationReferenceView[];
  /**
   * Explicit reference status: adapter warning when present, otherwise an
   * explicit "not supplied" note when no views matched, else null.
   */
  referenceNote: string | null;
}

/**
 * Bounded artwork-preview verdict for one package asset. Pure metadata only:
 * the renderer materializes bytes supplied separately, so domain data never
 * carries Base64 blobs. Only `inline-raster` may render as an image.
 */
export type ArtworkPreviewStatus =
  | "inline-raster"
  | "not-supplied"
  | "missing"
  | "too-large"
  | "unsupported"
  | "corrupt";

export interface ArtworkPreview {
  status: ArtworkPreviewStatus;
  /** Validated raster media type, present only for `inline-raster`. */
  mediaType?: string;
  /** Validated pixel dimensions, present only for `inline-raster`. */
  widthPx?: number;
  /** Validated pixel dimensions, present only for `inline-raster`. */
  heightPx?: number;
  /** Observed byte length, present when bytes were found. */
  byteLength?: number;
}

export interface OperationArtworkAsset {
  uri: string;
  role: AssetRole;
  /** Declared media type from the export; shown as inert text only. */
  mediaType: string;
  sha256Hex?: string;
  description?: string;
  preview: ArtworkPreview;
}

export interface OperationArtwork {
  logoId: string;
  role?: AssetRole;
  assets: OperationArtworkAsset[];
}

export interface OperationReferenceView {
  /** Presentation side (`front`/`back`/`left`/`right`), or null for a legacy single reference. */
  view: string | null;
  imagePath: string;
  label: string | null;
  preview: ArtworkPreview;
}

export interface OperationPlacement {
  /** 1-based placement number, consistent across tables and diagrams. */
  displayIndex: number;
  id?: string;
  configurationId: string;
  productId: string;
  variantId: string;
  logoId: string;
  regionId: string;
  method: string;
  pos: { xMm: number; yMm: number };
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
  instructions?: string;
  frame: ExportFrame;
  calibration: ExportCalibration;
  /** Region display name resolved from the product snapshot; null when not supplied. */
  regionName: string | null;
  artwork: OperationArtwork;
  /** Pre-computed planar diagram data in frame millimetres. */
  diagram: PlacementDiagram;
}

export interface PlacementDiagram {
  /** SVG viewBox in frame millimetres. */
  viewBox: { minX: number; minY: number; width: number; height: number };
  /** Safe-region polygon in frame millimetres. Empty = unavailable. */
  safePolygon: Point2d[];
  /** True when the safe polygon came from a resolved region definition. */
  safeSupplied: boolean;
  /** Exclusion polygons in frame millimetres. */
  exclusions: DiagramExclusion[];
  /** Rotated artwork-bbox footprint corners in frame millimetres, clockwise. */
  footprint: Point2d[];
  /** Frame axes indicator in viewBox coordinates. */
  axes: DiagramAxes;
}

export interface DiagramExclusion {
  id: string;
  name: string;
  polygon: Point2d[];
}

export interface Point2d {
  x: number;
  y: number;
}

export interface DiagramAxes {
  originX: number;
  originY: number;
  xEndX: number;
  xEndY: number;
  yEndX: number;
  yEndY: number;
  xLabel: string;
  yLabel: string;
}

/** One caller-selected product reference view (via the presentation adapter). */
export interface ReferenceViewInput {
  view: string | null;
  imagePath: string;
  label?: string | null;
}

/** Input to the operation-document builder. */
export interface BuildOperationDocumentInput {
  candidate: ResultCandidate;
  /** Optional ISO timestamp; caller-supplied, no default clock. */
  generatedAt?: string;
  /** Optional local customer confirmation summary. */
  customerConfirmation?: string | undefined;
  /** Optional local internal review summary. */
  internalReview?: string | undefined;
  /**
   * Package asset bytes by package path (referenced + additional). Read-only;
   * never mutated. Absent entirely means previews were not supplied.
   */
  assetBytes?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  /**
   * Per-configuration product reference selections from the presentation
   * adapter (`selectOperationReferenceViews`). Key: configuration id.
   */
  referenceViews?: Record<string, readonly ReferenceViewInput[]>;
  /** Per-configuration reference warnings from the adapter. Key: configuration id. */
  referenceWarnings?: Record<string, string>;
  /**
   * Per-configuration caller-evaluated photo-mapping bindings, aligned with
   * `referenceViews` by exact `imagePath`. Key: configuration id. Absent
   * means no mapping was evaluated: every supplied view reads
   * `reference-only`, never a calibrated overlay.
   */
  photoStates?: Record<string, readonly PhotoMappingState[]>;
}

/** One caller-evaluated photo-mapping binding for a reference view. */
export interface PhotoMappingState {
  /**
   * Exact presentation image path this mapping binds. Must equal the
   * reference view's `imagePath` exactly; never inferred, never a substring.
   */
  imagePath: string;
  /** Mapping review status from the photo-mapping adapter. */
  status: "provisional" | "review";
  /** Region this mapping binds (caller's current product/variant context). */
  regionId?: string;
  /** Declared preview side this mapping binds. */
  view?: string;
  /** Region-local mm to normalized-UV affine coefficients. */
  transform?: PhotoMappingTransform;
}

/** Independent version of the one-sheet operational view contract. */
export type OperationSheetViewVersion = "operation-sheet-view/1";

export interface OperationSheetJob {
  customer?: string;
  reference?: string;
  article?: string;
}

export interface OperationSheetSide {
  /** Presentation side (`front`/`back`/`left`/`right`), or null when undeclared. */
  view: string | null;
  imagePath: string;
  label?: string;
}

export interface OperationSheetDimension {
  label: string;
  /** Exact millimetres from the pure edge-to-anchor calculation. */
  valueMm: number;
  /** Display-only 1-decimal rounding of `valueMm` (rounded only at display). */
  valueMm1: string;
  fromAnchor: string;
  toEdge: string;
  /**
   * Arrow honesty threaded from the edge measurement: false means the
   * drawable dimension line starts off-artwork and `artworkPoint` carries
   * the extreme corner a renderer links with a visible extension.
   * Millimetres only; no pixel logic.
   */
  touchesArtwork?: boolean;
  /**
   * Extreme artwork corner nearest the dimension-line start; present only
   * when `touchesArtwork` is false.
   */
  artworkPoint?: MeasurementPoint;
}

export interface OperationSheetLogo {
  logoName: string;
  /**
   * Department-editable business code for the operator sheet (from
   * `SheetLogoExtras.businessCode`): shown and exported as the logo's code.
   * Falls back to the logo name, then `Logo N` (1-based placement order).
   * Never the raw customer logo id.
   */
  logoCode: string;
  /** Region display name, or the region id when no name is supplied. */
  side: string;
  /**
   * Human sentence built from the measured dimensions
   * ("45.0 mm — <label>; ..."), or an explicit unfinished note naming what
   * is missing. Never a guessed position.
   */
  positionText: string;
  method: string;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
  dimensions: OperationSheetDimension[];
  /** Explicit unfinished reasons; empty when every binding measured. */
  unfinished: string[];
  methodParams?: Record<string, string>;
  colours?: string[];
}

export interface OperationSheet {
  productId: string;
  variantId: string;
  productName?: string;
  variantName?: string;
  sides: OperationSheetSide[];
  /** One entry per placement, in placement order (0..N; empty = explicit zero). */
  logos: OperationSheetLogo[];
  /**
   * Department-authored operational text ONLY (from
   * `BuildOperationSheetViewInput.operationalInstructions`). The renderer
   * prints these as the operational instructions; customer notes live in
   * `sourceNotes` and are context only — never merged here, never printed
   * as operational.
   */
  instructions: string[];
  /**
   * Separately-labelled source context the department reviewed:
   * per-placement customer notes in placement order, plus the
   * project-level customer notes when present. Context only; the renderer
   * must not print these as operational instructions.
   */
  sourceNotes: { placement: string[]; project?: string };
}

/**
 * Minimal human-facing one-sheet operational view: one sheet per configured
 * product/variant with reference sides, per-logo anchor dimensions, and
 * instructions. Versioned independently of any Odoo production schema.
 */
export interface OperationSheetView {
  version: OperationSheetViewVersion;
  job: OperationSheetJob;
  sheets: OperationSheet[];
}

export interface SheetLogoExtras {
  methodParams?: Record<string, string>;
  colours?: string[];
  /**
   * Department-editable business code printed and exported as the logo's
   * code (`OperationSheetLogo.logoCode`). Never a raw customer logo id:
   * caller-supplied only, never generated.
   */
  businessCode?: string;
}

/** Input to the one-sheet view builder. */
export interface BuildOperationSheetViewInput {
  candidate: ResultCandidate;
  /** Authored anchors with explicit product/variant/region/frame/calibration scope. */
  anchors: readonly AnchorDef[];
  /** Per-configuration dimension bindings. Key: configuration id. */
  bindings: Record<string, readonly DimensionBinding[]>;
  job?: OperationSheetJob;
  /** Per-configuration reference sides. Key: configuration id. */
  sides?: Record<string, readonly ReferenceViewInput[]>;
  /**
   * Optional caller-supplied per-logo extras (method settings, colour
   * references). Keyed configuration id -> logoRef (same selector as
   * `DimensionBinding.logoRef`). Malformed extras are omitted, never guessed.
   */
  extras?: Record<string, Record<string, SheetLogoExtras>>;
  /**
   * Department-authored operational text (from the local draft sidecar).
   * This is the ONLY source of `OperationSheet.instructions` on every
   * sheet: customer notes stay in `OperationSheet.sourceNotes` and are
   * never merged into operational instructions. Caller must never relabel
   * unreviewed customer text as operational.
   */
  operationalInstructions?: readonly string[];
}
