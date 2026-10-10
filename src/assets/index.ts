/**
 * Portable external-GLB asset ingestion: public API.
 *
 * Re-exports the Phase 4 partial slice: GLB container parsing, the
 * self-contained subset validator, sidecar provenance ingestion, and the
 * synthetic model-generator stub. No Node fs/crypto, no browser/Three.js
 * imports anywhere under `src/assets` — hashing stays an injected callback.
 */
export { parseGlb } from "./glb.js";
export type { GlbCodedError, GlbParsed } from "./glb.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DATA_URI_BYTES,
  MAX_ARRAY_ITEMS,
  validateSelfContained,
} from "./validate.js";
export type {
  AssetIssue,
  ValidateSelfContainedOptions,
} from "./validate.js";
export {
  ASSET_MEDIA_TYPE,
  ASSET_SCHEMA_VERSION,
  ingestAsset,
} from "./provenance.js";
export type {
  AssetBounds,
  AssetRecord,
  AssetSource,
  IngestAssetInput,
  IngestAssetResult,
} from "./provenance.js";
export { SyntheticModelGenerator } from "./generator.js";
export type {
  GeneratorInput,
  GeneratorOutput,
  ModelGenerator,
} from "./generator.js";
export { ingestValidatedAsset } from './validated-ingest.js';
