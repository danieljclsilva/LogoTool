/**
 * Customer applied-logo 3D proof (Phase 2a).
 *
 * Thin adapter between the customer editor and the shared operator-proven
 * `createModelPlacementView` workbench plus the frozen validated
 * `resolveModelPlacementScene` resolver. No mesh math, no mapping invention,
 * no calibration: scenes come only from the shared resolver, edits route
 * through the editor's existing `updatePlacement`/`installMutation` revision
 * flow, and artwork comes only from bounded local package bytes.
 */
import { createModelPlacementView } from '../internal-builder/model-placement-view.js';
import type {
  ModelPlacementCommitPatch,
  ModelPlacementItem,
  ModelPlacementView,
} from '../internal-builder/model-placement-view.js';
import { resolveModelPlacementScene } from '../model-placement-scene.js';
import type { ModelScene } from '../model-placement-scene.js';
import type { Placement, ProjectDocument } from '../../core/types.js';

export interface CustomerProofAsset {
  path: string;
  bytes: Uint8Array;
}

export interface CustomerModelProofCallbacks {
  select(index: number): void;
  move(index: number, pos: { xMm: number; yMm: number }): void;
  commit(index: number, patch: ModelPlacementCommitPatch): void;
  preview(index: number, patch: ModelPlacementCommitPatch): void;
  status(message: string): void;
  interaction(active: boolean): void;
}

/**
 * Resolve the validated applied-logo scene for one product/variant scope.
 * Returns null when the scope has no model; regions is [] when no
 * calibrated area survived validation (display-only, never a forged
 * mapping). The caller treats regions.length === 0 as "no proof".
 */
export function resolveCustomerModelScene(
  project: ProjectDocument,
  assets: readonly CustomerProofAsset[],
  productId: string,
  variantId: string,
): ModelScene | null {
  const byPath = new Map<string, Uint8Array>();
  for (const asset of assets) {
    if (!byPath.has(asset.path)) byPath.set(asset.path, asset.bytes);
  }
  return resolveModelPlacementScene(project, byPath, productId, variantId);
}

/** True only when the scope has at least one validated calibrated region. */
export function hasCustomerModelProof(scene: ModelScene | null): scene is ModelScene & { regions: NonNullable<ModelScene['regions']> } {
  return scene !== null && scene.regions.length > 0;
}

export interface CustomerProofPlacementItem {
  index: number;
  placement: Placement;
  imageSrc: string | null;
  fits: boolean;
}

/**
 * Mount the shared workbench in limited customer mode. The returned view is
 * standalone (owns its viewer/surface) so the customer editor never mounts a
 * second bare-model viewer for the same proof.
 */
export function mountCustomerModelProof(
  host: HTMLElement,
  callbacks: CustomerModelProofCallbacks,
): ModelPlacementView {
  const view = createModelPlacementView({
    customer: true,
    interaction: callbacks.interaction,
    select: (index) => callbacks.select(index),
    move: (index, pos) => callbacks.move(index, pos),
    commit: (index, patch) => callbacks.commit(index, patch),
    preview: (index, patch) => callbacks.preview(index, patch),
    status: (message) => callbacks.status(message),
    expand: () => undefined,
    isExpanded: () => false,
    toggleDetails: () => false,
  });
  host.append(view.element);
  return view;
}

export type { ModelPlacementCommitPatch, ModelPlacementItem, ModelPlacementView, ModelScene };
