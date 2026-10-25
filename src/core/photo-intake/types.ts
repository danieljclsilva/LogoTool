/**
 * Bounded pure intake planner types for Tranche A (in-place product photos).
 *
 * Plain JSON-compatible structural types only. The manifest and photo-mapping
 * shapes here are minimal local contracts for the planner; the UI-layer
 * manifest/mapping types remain the authority for rendering and package IO
 * and are never imported (`src/ui/**` is excluded from the build).
 *
 * View identity (provisional intake-UX contract, see
 * `src/core/presentation-views/`): views are keyed by a STABLE slug id
 * (`view`/`viewId`, 1..48 chars of `[a-z0-9-]`) that never changes on rename,
 * plus a MUTABLE human `label` (free text, 1..80 chars when present) used
 * for display only. Legacy fixed sides (`front`/`back`/`left`/`right`) are
 * valid view ids and parse identically to before.
 */

import type {
  AnyPresentationManifest,
  PresentationManifestV2,
  PresentationManifestVNext,
  PresentationModelEntry,
  PresentationReferenceEntry,
  PresentationViewEntry,
} from "../presentation-views/types.js";

/**
 * Legacy fixed product side. Deprecated as intake identity: prefer the
 * flexible `viewId` slug (which accepts these same four names as ordinary
 * view ids). Retained so previously issued/prepared projects and existing
 * callers keep compiling and parsing identically.
 */
export type PhotoSide = "front" | "back" | "left" | "right";

/**
 * Stable view identity slug for intake (1..48 chars, `[a-z0-9-]`).
 * The four legacy side names are valid view ids.
 */
export type PhotoViewId = string;

/** Intake mode: attach a previously absent view, or supersede its photo. */
export type PhotoIntakeMode = "add" | "replace";

/** Short media names accepted at the intake boundary (decoded by the caller). */
export type PhotoMediaShort = "png" | "jpeg" | "webp";

/** Minimal structural photo-mapping reference used for invalidation. */
export interface PhotoIntakeMappingRef {
  productId: string;
  variantId?: string;
  regionId: string;
  /** Stable view id (never the mutable human label). */
  view: string;
  image: string;
}

export interface PhotoIntakeInput {
  productId: string;
  variantId?: string;
  /**
   * Legacy fixed side (deprecated). Exactly one of `side` / `viewId` must
   * be supplied: `viewId` takes precedence when both are present and agree,
   * and any disagreement is a malformed failure (never guessed).
   */
  side?: PhotoSide;
  /**
   * Preferred stable view identity slug (1..48 chars, `[a-z0-9-]`), e.g.
   * `"crown"`, `"sleeve"` or a legacy `"front"`. Exactly one of `side` /
   * `viewId` must be supplied.
   */
  viewId?: PhotoViewId;
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

/**
 * Minimal structural intake view entry: the stable `view` id plus the
 * mutable human `label`. Alias of the provisional presentation-view entry
 * so intake planning and the presentation helpers share one identity.
 */
export type IntakeManifestView = PresentationViewEntry;

/** Minimal structural intake model entry (preserved verbatim). */
export type IntakeManifestModel = PresentationModelEntry;

/** Minimal structural intake reference entry (preserved verbatim). */
export type IntakeManifestReference = PresentationReferenceEntry;

/**
 * Minimal structural intake manifest (legacy version 2). `view` entries may
 * already carry flexible ids; pure legacy four-side manifests parse
 * identically to before.
 */
export type IntakeManifestV2 = PresentationManifestV2;

/**
 * V-next intake manifest (version 3): identical to v2 except the version
 * marker declares genuinely flexible view ids. Readers accept both.
 */
export type IntakeManifestVNext = PresentationManifestVNext;

/** Any manifest version the intake planner accepts. */
export type IntakeManifestAny = AnyPresentationManifest;

export type PhotoIntakeErrorCode =
  | "malformed"
  | "oversized"
  | "side-occupied"
  | "side-empty"
  | "unknown-product-scope"
  | "budget-exceeded"
  | "view-budget-exceeded"
  | "duplicate-view"
  | "unknown-view";

export type PlanPhotoIntakeResult =
  | {
    ok: true;
    assetPath: string;
    manifest: IntakeManifestAny;
    invalidatedMappingKeys: string[];
    replacedAssetPath?: string;
  }
  | {
    ok: false;
    code: PhotoIntakeErrorCode;
    message: string;
  };

/** Target scope for a label-only view rename. */
export interface RenameIntakeViewInput {
  productId: string;
  variantId?: string;
  /** Stable view id (never the mutable label). */
  view: PhotoViewId;
  /** New human label (1..80 chars), or omitted to clear it. */
  label?: string;
}

export type RenameIntakeViewResult =
  | { ok: true; manifest: IntakeManifestAny }
  | { ok: false; code: PhotoIntakeErrorCode; message: string };
