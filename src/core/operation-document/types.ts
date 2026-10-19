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

export interface OperationDocument {
  /** Document identity and review status. */
  identity: OperationIdentity;
  /** Human-readable limitations printed on every document. */
  limitations: string[];
  /** Per-configuration pages/sections. */
  configurations: OperationConfiguration[];
  /** Raw project instructions, if any. */
  projectInstructions?: string;
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
}
