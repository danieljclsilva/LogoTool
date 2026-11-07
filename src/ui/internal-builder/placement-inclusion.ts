import { displayVariantName } from '../../core/operation-document/index.js';
import type { ProjectDocument } from '../../core/types.js';

/**
 * Placement inclusion rule — pure domain helper (no DOM, no browser APIs).
 *
 * Step 1 (Prepare job) inclusion governs NEW placement creation only:
 * a placement may be created for (productId, configurationId) exactly when
 * both ids are included. A null/undefined scope means the unrestricted full
 * catalogue (valid standalone callers). A selection-read failure is
 * fail-closed: callers surface PLACEMENT_INCLUSION_UNAVAILABLE_MESSAGE and
 * block creation without saving or misrepresenting the job.
 */

/** Included Step 1 scope for placement creation. */
export interface PlacementInclusionScope {
  readonly productIds: readonly string[];
  readonly configurationIds: readonly string[];
}

/** Fail-closed message shared by every creation path on read failure. */
export const PLACEMENT_INCLUSION_UNAVAILABLE_MESSAGE =
  'Product inclusion is unavailable, so new placements are blocked. Reopen Prepare job and try again.';

/**
 * Whether a NEW placement may be created for the given product/configuration.
 * A null/undefined scope is the valid unrestricted legacy (full catalogue).
 * Otherwise both the product and the configuration must be included.
 */
export function isPlacementCreationAllowed(
  productId: string,
  configurationId: string,
  scope: PlacementInclusionScope | null | undefined,
): boolean {
  if (scope === null || scope === undefined) return true;
  return scope.productIds.includes(productId) && scope.configurationIds.includes(configurationId);
}

/**
 * Call `reader()` and pass through its result (including null/undefined).
 * When `reader()` throws, rethrow as the shared unavailable error so every
 * creation path fails closed with the same message.
 */
export function readInclusionScopeOrThrow(
  reader: () => PlacementInclusionScope | null | undefined,
): PlacementInclusionScope | null {
  try {
    const scope = reader();
    return scope ?? null;
  } catch (error) {
    throw new Error(PLACEMENT_INCLUSION_UNAVAILABLE_MESSAGE, {
      cause: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** One omitted product/option group with existing placements. */
export interface OmittedPlacementGroup {
  readonly productId: string;
  readonly productName: string;
  readonly variantId: string;
  readonly optionName: string | null;
  readonly placementCount: number;
}

/**
 * Aggregate configs present in the full job but absent from the scoped set,
 * grouped by product+variant with summed placement counts. Zero-count groups
 * are dropped. Stable order: productName, then optionName (null first), then
 * productId, then variantId. Labels follow the shared operator display rules.
 */
export function summarizeOmittedPlacements(
  fullProject: Pick<ProjectDocument, 'products' | 'configurations'>,
  scopedConfigurationIds: ReadonlySet<string> | readonly string[],
): OmittedPlacementGroup[] {
  const scoped = scopedConfigurationIds instanceof Set
    ? scopedConfigurationIds
    : new Set(scopedConfigurationIds);
  const byKey = new Map<string, OmittedPlacementGroup>();
  for (const config of fullProject.configurations) {
    if (scoped.has(config.id)) continue;
    const count = config.placements.length;
    if (count <= 0) continue;
    const product = fullProject.products.find((entry) => entry.id === config.productId);
    const rawProductName = product?.name?.trim() ?? '';
    const productName = rawProductName !== '' ? rawProductName : config.productId;
    const optionName = displayVariantName(product, config.variantId);
    const key = JSON.stringify([config.productId, config.variantId]);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        productId: config.productId,
        productName,
        variantId: config.variantId,
        optionName,
        placementCount: count,
      });
    } else {
      byKey.set(key, { ...existing, placementCount: existing.placementCount + count });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.productName !== b.productName) return a.productName < b.productName ? -1 : 1;
    const aOption = a.optionName ?? '';
    const bOption = b.optionName ?? '';
    if (aOption !== bOption) return aOption < bOption ? -1 : 1;
    if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;
    if (a.variantId !== b.variantId) return a.variantId < b.variantId ? -1 : 1;
    return 0;
  });
}
