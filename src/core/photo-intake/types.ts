/**
 * Bounded pure intake planner types for Tranche A (in-place product photos).
 *
 * Plain JSON-compatible structural types only. The manifest and photo-mapping
 * shapes here are minimal local contracts for the planner; the UI-layer
 * manifest/mapping types remain the authority for rendering and package IO
 * and are never imported (`src/ui/**` is excluded from the build).
 */

/** Named product side a photo attaches to. */
export type PhotoSide = "front" | "back" | "left" | "right";

/** Intake mode: attach a previously absent side, or supersede its photo. */
export type PhotoIntakeMode = "add" | "replace";

/** Short media names accepted at the intake boundary (decoded by the caller). */
export type PhotoMediaShort = "png" | "jpeg" | "webp";

/** Minimal structural photo-mapping reference used for invalidation. */
export interface PhotoIntakeMappingRef {
  productId: string;
  variantId?: string;
  regionId: string;
  view: string;
  image: string;
}

export interface PhotoIntakeInput {
  productId: string;
  variantId?: string;
  side: PhotoSide;
  mode: PhotoIntakeMode;
  fileName: string;
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  mediaType: PhotoMediaShort;
  existingManifest: unknown;
  existingMappings: PhotoIntakeMappingRef[];
  existingAssetPaths: string[];
}

/** Minimal structural v2 presentation view entry. */
export interface IntakeManifestView {
  productId: string;
  variantId?: string;
  view: PhotoSide;
  image: string;
  label?: string;
}

/** Minimal structural v2 presentation model entry (preserved verbatim). */
export interface IntakeManifestModel {
  productId: string;
  variantId?: string;
  model: string;
  label?: string;
}

/** Minimal structural v2 presentation reference entry (preserved verbatim). */
export interface IntakeManifestReference {
  productId: string;
  variantId?: string;
  image: string;
  label?: string;
}

/** Minimal structural v2 presentation manifest. */
export interface IntakeManifestV2 {
  version: 2;
  views: IntakeManifestView[];
  models?: IntakeManifestModel[];
  references?: IntakeManifestReference[];
}

export type PhotoIntakeErrorCode =
  | "malformed"
  | "oversized"
  | "side-occupied"
  | "side-empty"
  | "unknown-product-scope"
  | "budget-exceeded";

export type PlanPhotoIntakeResult =
  | {
    ok: true;
    assetPath: string;
    manifest: IntakeManifestV2;
    invalidatedMappingKeys: string[];
    replacedAssetPath?: string;
  }
  | {
    ok: false;
    code: PhotoIntakeErrorCode;
    message: string;
  };
