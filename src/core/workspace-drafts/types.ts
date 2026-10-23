/**
 * Scoped-draft retirement policy types (Tranche C1).
 *
 * Pure data: no DOM, browser, Three.js, network, or `src/ui/**` dependencies.
 * Keys are the `viewIdentityKey` strings owned by
 * `src/ui/internal-builder/product-setup-view.ts`: a JSON array of
 * `[photoId, sourceRev, productId, variantId, regionId, frameId,
 * calibrationId, calibrationVersion, side, transformKey]` where `photoId`
 * is `${imagePath}#${bytes.length}:${fnvHash}`. This module only decides
 * keep/drop; the UI wires the decision to its staged-edit buckets.
 */

export interface DraftIdentityParts {
  photoId: string;
  imagePath: string;
  sourceRev: string;
  productId: string;
  variantId: string;
  regionId: string;
  frameId: string;
  calibrationId: string;
  calibrationVersion: string;
  side: string;
  transformKey: string;
}

export type DraftRetirementEvent =
  | { kind: "source-replaced"; sourceRev: string }
  | { kind: "photo-replaced"; productId: string; variantId?: string; imagePath: string }
  | { kind: "scope-removed"; productId: string; variantId?: string; regionId?: string }
  | {
    kind: "binding-invalidated";
    productId: string;
    variantId?: string;
    regionId?: string;
    view?: string;
    imagePath?: string;
  };

export interface DraftRetirement {
  retired: string[];
  kept: string[];
}
