/**
 * LogoTool provisional core domain: public API.
 *
 * Pure domain logic for the offline Logo Station configurator.
 * No React / Three.js / DOM / Node-fs / Node-crypto imports anywhere under
 * `src/core` — hashing is always an injected `Sha256HexFn` callback, and the
 * JSON Schema contracts are checked-in JSON modules (no filesystem access).
 */
export type {
  AssetRef,
  AssetRole,
  Calibration,
  CalibrationRef,
  CandidateStatus,
  Configuration,
  ContentEnvelope,
  CustomerConfirmation,
  CustomerReturnInput,
  ExportArtwork,
  ExportCalibration,
  ExportConfiguration,
  ExportFrame,
  ExportPlacement,
  ImportOutcome,
  InternalReview,
  IssuedBaseline,
  LogoDefinition,
  Placement,
  PlacementPos,
  PointMm,
  ProductDefinition,
  ProductKind,
  ProductVariant,
  ProjectDocument,
  Region,
  RegionFrame,
  RegionFrameAxes,
  ResultCandidate,
  ReviewDecision,
  SchemaVersion,
  Sha256HexFn,
  ValidationError,
  ValidationResult,
  VariantPlacementOverride,
} from "./types.js";
export {
  DIGEST_HEX_PATTERN,
  REVIEW_DECISIONS,
  SCHEMA_VERSION,
} from "./types.js";
export { canonicalize, toCanonicalForm } from "./canonical.js";
export {
  checkLogoContract,
  checkProductContract,
  checkProjectContract,
  checkResultContract,
} from "./contracts.js";
export { contentDigest, contentEnvelope } from "./content.js";
export { validateLogos, validateProduct, validateProject } from "./validate.js";
export type { ConfirmInput, ConfirmOutcome } from "./revisions.js";
export {
  confirmRevision,
  newRevision,
} from "./revisions.js";
export type {
  ReviewInput,
  ReviewOutcome,
} from "./workflow.js";
export {
  checkAgainstBaseline,
  importCustomerReturn,
  recordInternalReview,
} from "./workflow.js";
export type { CandidateExportOptions } from "./export.js";
export {
  buildCandidateExport,
  hasCurrentInternalApproval,
  serializeExport,
} from "./export.js";
export type {
  AnchorPairInput,
  CalibPoint2Mm,
  CalibVec3,
  CalibrationEvidence,
  FitOptions,
  PairResidual,
  PlanarFrameSpec,
  PlanarMapping,
  UniformFitResult,
} from "./calibration/index.js";
export {
  CALIBRATION_KERNEL_VERSION,
  createPlanarMapping,
  fitUniformScale,
  validateCalibrationEvidence,
} from "./calibration/index.js";
export type { GeoPoint, PolygonCheck } from "./geometry/index.js";
export { footprintFits, pointInPolygon, validateSafePolygon } from "./geometry/index.js";
