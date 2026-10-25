/**
 * PROVISIONAL bounded presentation-view contracts (intake-UX workstream).
 *
 * Draft status: subject to the Phase 1 Odoo-discovery exit gate; do not treat
 * as final and do not finalize any Odoo/production schema from these shapes.
 * Physical domain data (millimetres, frames, calibration) stays independent
 * of these presentation-only view identities: labels never invalidate
 * measurements, and invalidation keys bind the exact image path + stable
 * view id + product/variant scope only.
 *
 * Identity model:
 * - `view` is the STABLE view identity: a bounded slug (`[a-z0-9-]`, 1..48
 *   chars). It is the key used by manifests, intake planning, calibration
 *   sidecars and photo-mapping invalidation. It never changes on rename.
 * - `label` is the MUTABLE human name (free text, 1..80 chars when present).
 *   Renaming a label preserves identity and therefore preserves every
 *   calibration, anchor and mapping bound to the view id.
 * - Legacy fixed sides (`front`/`back`/`left`/`right`) are valid view ids.
 *   Legacy manifests that used those names parse identically to view ids
 *   `front`/`back`/`left`/`right`; `defaultLabelForViewId` supplies the
 *   legacy display names when no explicit label was stored.
 *
 * Bounds (provisional, deterministic, enforced by the parsers/planners):
 * - 32 total presentation entries per manifest (existing global budget).
 * - 12 views per product/variant scope (allows >= 5 named views; legacy
 *   fixed-side products can hold at most 4 per scope, so legacy data always
 *   fits).
 * - View ids 1..48 chars; labels 1..80 chars; duplicates of
 *   (productId, variantId-scope, view) are rejected; serialization sorts by
 *   (productId, variantId, view, image).
 */

export const PRESENTATION_VIEW_LIMITS = {
  /** Existing global presentation budget: views + models + references. */
  manifestBudget: 32,
  /** Max image views per product/variant scope (product-wide or one variant). */
  maxViewsPerScope: 12,
  /** Stable view-id slug length bound. */
  maxViewIdChars: 48,
  /** Mutable human-label length bound. */
  maxViewLabelChars: 80,
} as const;

/**
 * Stable view identity slug. Validated form: 1..48 chars of `[a-z0-9-]`.
 * Kept as `string` (not a branded type) so legacy `front`/`back`/`left`/
 * `right` manifests and structural test fixtures keep compiling.
 */
export type PresentationViewId = string;

/** Mutable human view name (free text, 1..80 chars when present). */
export type PresentationViewLabel = string;

/** One named image view of a product/variant scope. */
export interface PresentationViewEntry {
  productId: string;
  variantId?: string;
  /** Stable identity slug; never the mutable human label. */
  view: PresentationViewId;
  /** Exact `presentation/` raster path. */
  image: string;
  /** Mutable human name; absent means "display the default for the id". */
  label?: PresentationViewLabel;
}

/** One 3D-model entry of a product/variant scope (preserved verbatim). */
export interface PresentationModelEntry {
  productId: string;
  variantId?: string;
  model: string;
  label?: string;
}

/** One legacy single-reference entry (preserved verbatim, never converted). */
export interface PresentationReferenceEntry {
  productId: string;
  variantId?: string;
  image: string;
  label?: string;
}

/**
 * Legacy v2 presentation manifest shape. `view` entries may already carry
 * flexible ids; pure legacy four-side manifests parse identically to before.
 */
export interface PresentationManifestV2 {
  version: 2;
  views: PresentationViewEntry[];
  models?: PresentationModelEntry[];
  references?: PresentationReferenceEntry[];
}

/**
 * V-next presentation manifest: identical to v2 except the version marker
 * declares that view ids are genuinely flexible (arbitrary slugs, not just
 * the four legacy side names). Readers must accept both versions.
 */
export interface PresentationManifestVNext {
  version: 3;
  views: PresentationViewEntry[];
  models?: PresentationModelEntry[];
  references?: PresentationReferenceEntry[];
}

/** Any manifest version the bounded readers accept. */
export type AnyPresentationManifest = PresentationManifestV2 | PresentationManifestVNext;

/** Product/variant/view scope selecting exactly one named view. */
export interface PresentationViewScope {
  productId: string;
  variantId?: string;
  view: PresentationViewId;
}

/** Caller-facing selection of one named view (pass-through, never dropped). */
export interface FlexibleViewSelection {
  /** Stable view id (never the mutable label). */
  view: PresentationViewId;
  imagePath: string;
  label: string | null;
}
