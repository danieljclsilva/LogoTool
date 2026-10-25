/**
 * LogoTool provisional core domain types.
 *
 * Canonical field set (no legacy aliases — there is no released legacy
 * format, so unknown fields, including any legacy shapes, are rejected):
 * - `history`: superseded customer confirmations.
 * - `review`: current internal review (never conferred by opening/importing).
 * - `reviewHistory`: superseded internal reviews.
 * - `Placement.pos`: nested `{ xMm, yMm }` is authoritative; flat `xMm`/`yMm`
 *   on a placement is invalid (rejected, never migrated).
 */

export const SCHEMA_VERSION = "0.1.0-provisional" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/** Lowercase SHA-256 hex ([0-9a-f]{64}). */
export const DIGEST_HEX_PATTERN: RegExp = /^[0-9a-f]{64}$/;

export type ProductKind =
  | "upper-body"
  | "lower-body"
  | "full-body"
  | "headwear"
  | "other";

export interface VariantPlacementOverride {
  regionId: string;
  widthMm?: number;
  heightMm?: number;
}

export interface ProductVariant {
  id: string;
  name?: string;
  /** Subset of the enclosing product's region ids supported by this variant. */
  regionIds: string[];
  placementOverrides?: VariantPlacementOverride[];
}

/** Free-text direction labels for the region frame axes. */
export interface RegionFrameAxes {
  xPositive: string;
  yPositive: string;
}

export interface RegionFrame {
  frameId: string;
  originDescription: string;
  axes: RegionFrameAxes;
}

export interface CalibrationRef {
  calibrationId: string;
  version: string;
}

export interface Calibration {
  id: string;
  version: string;
  description?: string;
}

/** [x, y] pair in the region frame, millimetres. */
export type PointMm = [number, number];

export interface Region {
  id: string;
  name?: string;
  frame: RegionFrame;
  calibrationRef: CalibrationRef;
  /** Safe-area polygon in the region frame (mm): [] (unconfigured — draw before production) or >=3 finite points. */
  safeArea: PointMm[];
  exclusions?: PointMm[][];
  allowedMethods: string[];
}

export interface ProductDefinition {
  schemaVersion: SchemaVersion;
  id: string;
  name?: string;
  kind: ProductKind;
  variants: ProductVariant[];
  regions: Region[];
  calibrations: Calibration[];
}

export type AssetRole =
  | "original"
  | "reference"
  | "proposal"
  | "proof"
  | "production";

export interface AssetRef {
  /** Relative in-package path (portable; never absolute or remote). */
  uri: string;
  role: AssetRole;
  mediaType: string;
  sha256Hex?: string;
  widthPx?: number;
  heightPx?: number;
  /**
   * Optional note, e.g. marking a reference-only external pointer as
   * unresolved and never production artwork.
   */
  description?: string;
}

export interface LogoDefinition {
  schemaVersion: SchemaVersion;
  id: string;
  name?: string;
  /** Logo-level role hint; per-asset roles stay on `assets[]`. */
  role?: AssetRole;
  assets: AssetRef[];
  knownWidthMm?: number;
  knownHeightMm?: number;
}

/** Artwork bbox center in the region frame (mm). */
export interface PlacementPos {
  xMm: number;
  yMm: number;
}

export interface Placement {
  /** Optional placement id; when present, ids must be unique per configuration. */
  id?: string;
  logoId: string;
  regionId: string;
  method: string;
  pos: PlacementPos;
  widthMm: number;
  heightMm: number;
  /** Clockwise-positive facing the region, normalized to (-180, 180]. */
  rotationDeg: number;
  instructions?: string;
}

export interface Configuration {
  id: string;
  productId: string;
  variantId: string;
  placements: Placement[];
}

export interface CustomerConfirmation {
  revision: number;
  digest: string;
  confirmedBy: string;
  confirmedAt: string;
}

export const REVIEW_DECISIONS = [
  "pending",
  "approved",
  "changesRequested",
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface InternalReview {
  revision: number;
  digest: string;
  decision: ReviewDecision;
  reviewer: string;
  at: string;
  note?: string;
}

export interface ProjectDocument {
  schemaVersion: SchemaVersion;
  projectId: string;
  synthetic?: boolean;
  description?: string;
  /** Content revision counter. Every content mutation yields a new revision. */
  revision: number;
  /** Embedded product definition snapshots (baseline for tamper checks). */
  products: ProductDefinition[];
  logos: LogoDefinition[];
  configurations: Configuration[];
  instructions?: string;
  /** Customer confirmation binding { revision, digest }. Absent = draft. */
  confirmation?: CustomerConfirmation;
  /**
   * Current internal review, separate from customer confirmation. Never
   * conferred by opening, validating, or importing: only `recordInternalReview`
   * creates it; import retains prior reviews only as history.
   */
  review?: InternalReview;
  /** Superseded prior confirmations (invalidated by later content changes). */
  history?: CustomerConfirmation[];
  /** Superseded prior internal reviews. */
  reviewHistory?: InternalReview[];
  /** Optional hash of the issued baseline for identity checks. */
  issuedBaselineHash?: string;
}

/**
 * Operational content envelope covered by the content digest: everything a
 * customer can see or change that affects production output (schema version,
 * identity, product/logo snapshots, configurations, project instructions).
 * Excludes bookkeeping: revision counter, confirmation, reviews/histories,
 * non-operational descriptions/markers, baseline hashes.
 */
export interface ContentEnvelope {
  schemaVersion: SchemaVersion;
  projectId: string;
  products: ProductDefinition[];
  logos: LogoDefinition[];
  configurations: Configuration[];
  instructions?: string;
}
/**
 * Trusted issued-baseline input for `importCustomerReturn`: the internal
 * definitions the return is compared against, plus the trusted internal
 * review history (the return's own review history is never trusted).
 */
export interface IssuedBaseline {
  projectId: string;
  products: ProductDefinition[];
  logos: LogoDefinition[];
}
/** Trusted, internally stored issued project, never a customer-supplied baseline. */
export type CustomerReturnInput = ProjectDocument;

export type ImportOutcome =
  | { ok: true; project: ProjectDocument }
  | { ok: false; errors: ValidationError[] };


/** Physical frame + measurement convention snapshot for one export placement. */
export interface ExportFrame {
  frameId: string;
  originDescription: string;
  axes: RegionFrameAxes;
  /** Physical unit of every placement measurement. Always millimetres. */
  unit: "mm";
  /** What `pos` denotes in the frame. Always the artwork bbox center. */
  referencePoint: "artwork-bbox-center";
  /** Rotation convention. Always clockwise degrees facing the region. */
  rotationConvention: "clockwise-deg-facing-region";
}

export interface ExportCalibration {
  calibrationId: string;
  version: string;
}

/** Artwork snapshot so the export resolves to actual artwork, not just an id. */
export interface ExportArtwork {
  logoId: string;
  role?: AssetRole;
  assets: AssetRef[];
}

export interface ExportPlacement {
  id?: string;
  configurationId: string;
  productId: string;
  variantId: string;
  logoId: string;
  regionId: string;
  method: string;
  pos: PlacementPos;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
  instructions?: string;
  frame: ExportFrame;
  calibration: ExportCalibration;
  artwork: ExportArtwork;
}

export interface ExportConfiguration {
  id: string;
  productId: string;
  variantId: string;
  productName?: string;
  variantName?: string;
  /** Placements for this configuration; empty array = explicit zero placements. */
  placements: ExportPlacement[];
}

export type CandidateStatus = "candidate-pending-review";

export interface ResultCandidate {
  schemaVersion: SchemaVersion;
  status: CandidateStatus;
  projectId: string;
  revision: number;
  digest: string;
  instructions?: string;
  /** Product snapshots to resolve regions, frames and calibration refs. */
  products: ProductDefinition[];
  /** Logo snapshots to resolve actual artwork (usable originals included). */
  logos: LogoDefinition[];
  /**
   * Per-configuration output. Every configuration appears here, including
   * ones with zero placements — flattened placement lists alone would lose
   * the selection context of empty configurations.
   */
  configurations: ExportConfiguration[];
}

export interface ValidationError {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/**
 * Injected SHA-256 hasher: canonical UTF-8 text -> lowercase hex digest.
 * Core takes this as a callback parameter so domain code stays independent
 * of node:crypto and browser SubtleCrypto alike. Core validates the result
 * shape and rejects invalid hasher output instead of trusting it.
 */
export type Sha256HexFn = (canonicalText: string) => string;
