/**
 * Internal offline builder: carve a customer-facing issued project out of an
 * internal source project by selecting products/variants/logos/configurations.
 *
 * Pure TypeScript: no DOM/Node/Three/React. No timestamps, no randomness.
 * Never mutates inputs. Never touches schema versions.
 */

import { isRecord } from "../guards.js";
import type {
  Configuration,
  ProductDefinition,
  ProjectDocument,
  ValidationError,
  ValidationResult,
} from "../types.js";
import { validateProject } from "../validate.js";

export interface BuilderSelection {
  productIds: string[];
  variantIdsByProduct?: Record<string, string[]>;
  logoIds: string[];
  configurationIds?: string[];
}

export interface BuilderIdentity {
  customerLabel: string;
  jobReference: string;
  issuedBy: string;
  /** Explicit issued project id. The source projectId is only a suggestion/default and is never carried over. */
  projectId: string;
}

export type BuilderIssueResult =
  | { ok: true; project: ProjectDocument }
  | { ok: false; errors: ValidationError[] };

export interface BuilderSourceSummary {
  productIds: string[];
  products: { id: string; name: string; variantIds: string[] }[];
  logoIds: string[];
  configurationIds: string[];
  placementCount: number;
  assetPaths: string[];
  revision: number;
  projectId: string;
}

export const BUILDER_LIMITS = {
  maxProducts: 64,
  maxLogos: 64,
  maxConfigurations: 64,
  maxIdChars: 256,
} as const;

function fail(errors: ValidationError[], code: string, path: string, message: string): void {
  errors.push({ code, path, message });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function checkIdChars(id: string, path: string, errors: ValidationError[]): boolean {
  if (id.length < 1 || id.length > BUILDER_LIMITS.maxIdChars) {
    fail(
      errors,
      "bad-id",
      path,
      `id must be 1..${BUILDER_LIMITS.maxIdChars} chars`,
    );
    return false;
  }
  return true;
}

/**
 * Summarize a source project for builder UI listing. Defensive: missing
 * arrays degrade to empty rather than throwing.
 */
export function summarizeSourceProject(project: ProjectDocument): BuilderSourceSummary {
  const snapshot = clone(project);
  const products = Array.isArray(snapshot.products) ? snapshot.products : [];
  const logos = Array.isArray(snapshot.logos) ? snapshot.logos : [];
  const configurations = Array.isArray(snapshot.configurations)
    ? snapshot.configurations
    : [];
  const productIds: string[] = [];
  const productSummaries: BuilderSourceSummary["products"] = [];
  for (const product of products) {
    productIds.push(product.id);
    const variants = Array.isArray(product.variants) ? product.variants : [];
    productSummaries.push({
      id: product.id,
      name: typeof product.name === "string" ? product.name : product.id,
      variantIds: variants.map((variant) => variant.id),
    });
  }
  const logoIds = logos.map((logo) => logo.id);
  const configurationIds = configurations.map((configuration) => configuration.id);
  let placementCount = 0;
  for (const configuration of configurations) {
    if (Array.isArray(configuration.placements)) {
      placementCount += configuration.placements.length;
    }
  }
  const assetSet = new Set<string>();
  for (const logo of logos) {
    if (!Array.isArray(logo.assets)) continue;
    for (const asset of logo.assets) {
      if (typeof asset.uri === "string") assetSet.add(asset.uri);
    }
  }
  return {
    productIds,
    products: productSummaries,
    logoIds,
    configurationIds,
    placementCount,
    assetPaths: [...assetSet].sort(),
    revision: snapshot.revision,
    projectId: snapshot.projectId,
  };
}

/** Validate a builder selection against a source project (no mutation). */
export function validateBuilderSelection(
  project: ProjectDocument,
  selection: BuilderSelection,
): ValidationResult {
  const errors: ValidationError[] = [];
  const structural = validateProject(project);
  if (!structural.ok) {
    return structural;
  }
  if (!isRecord(selection)) {
    fail(errors, "bad-shape", "selection", "selection must be an object");
    return { ok: false, errors };
  }

  const sourceProductIds = new Set<string>(project.products.map((p) => p.id));
  const sourceLogoIds = new Set<string>(project.logos.map((l) => l.id));
  const sourceConfigById = new Map<string, Configuration>();
  for (const config of project.configurations) {
    sourceConfigById.set(config.id, config);
  }
  const variantsByProduct = new Map<string, Set<string>>();
  for (const product of project.products) {
    variantsByProduct.set(product.id, new Set(product.variants.map((v) => v.id)));
  }

  // --- productIds ---
  const productIds: unknown = selection.productIds;
  if (!Array.isArray(productIds)) {
    fail(errors, "bad-shape", "selection.productIds", "productIds must be an array");
  } else {
    if (productIds.length < 1) {
      fail(errors, "empty-selection", "selection.productIds", "select at least 1 product");
    }
    if (productIds.length > BUILDER_LIMITS.maxProducts) {
      fail(
        errors,
        "too-many",
        "selection.productIds",
        `at most ${BUILDER_LIMITS.maxProducts} products`,
      );
    }
    const seen = new Set<string>();
    productIds.forEach((id: unknown, i: number) => {
      const path = `selection.productIds[${i}]`;
      if (typeof id !== "string") {
        fail(errors, "bad-shape", path, "product id must be a string");
        return;
      }
      checkIdChars(id, path, errors);
      if (seen.has(id)) {
        fail(errors, "duplicate-id", path, `duplicate product id "${id}"`);
      } else {
        seen.add(id);
      }
      if (!sourceProductIds.has(id)) {
        fail(errors, "unknown-id", path, `unknown product id "${id}"`);
      }
    });
  }

  // --- logoIds ---
  const logoIds: unknown = selection.logoIds;
  if (!Array.isArray(logoIds)) {
    fail(errors, "bad-shape", "selection.logoIds", "logoIds must be an array");
  } else {
    // 0..N logos valid (no-artwork issue); entries still validated below.
    if (logoIds.length > BUILDER_LIMITS.maxLogos) {
      fail(
        errors,
        "too-many",
        "selection.logoIds",
        `at most ${BUILDER_LIMITS.maxLogos} logos`,
      );
    }
    const seen = new Set<string>();
    logoIds.forEach((id: unknown, i: number) => {
      const path = `selection.logoIds[${i}]`;
      if (typeof id !== "string") {
        fail(errors, "bad-shape", path, "logo id must be a string");
        return;
      }
      checkIdChars(id, path, errors);
      if (seen.has(id)) {
        fail(errors, "duplicate-id", path, `duplicate logo id "${id}"`);
      } else {
        seen.add(id);
      }
      if (!sourceLogoIds.has(id)) {
        fail(errors, "unknown-id", path, `unknown logo id "${id}"`);
      }
    });
  }

  // Selected sets (best-effort string members only) for cross checks.
  const selectedProducts = new Set<string>(
    Array.isArray(productIds) ? productIds.filter((id): id is string => typeof id === "string") : [],
  );

  // --- variantIdsByProduct ---
  const variantMap: unknown = selection.variantIdsByProduct;
  // Surviving variants per selected product (explicit subset or all).
  const survivingByProduct = new Map<string, Set<string>>();
  for (const productId of selectedProducts) {
    if (!sourceProductIds.has(productId)) continue;
    survivingByProduct.set(
      productId,
      new Set<string>([...(variantsByProduct.get(productId) ?? new Set<string>())]),
    );
  }
  if (variantMap !== undefined) {
    if (!isRecord(variantMap)) {
      fail(
        errors,
        "bad-shape",
        "selection.variantIdsByProduct",
        "variantIdsByProduct must be an object",
      );
    } else {
      for (const productId of Object.keys(variantMap)) {
        const subset: unknown = variantMap[productId];
        const basePath = `selection.variantIdsByProduct.${productId}`;
        if (!sourceProductIds.has(productId)) {
          fail(errors, "unknown-id", basePath, `unknown product id "${productId}"`);
          continue;
        }
        if (!selectedProducts.has(productId)) {
          fail(
            errors,
            "not-selected",
            basePath,
            `product "${productId}" has a variant subset but is not selected`,
          );
          continue;
        }
        if (!Array.isArray(subset)) {
          fail(errors, "bad-shape", basePath, "variant subset must be an array");
          continue;
        }
        if (subset.length < 1) {
          fail(
            errors,
            "empty-selection",
            basePath,
            `variant subset for product "${productId}" must keep at least 1 variant`,
          );
          continue;
        }
        const known = variantsByProduct.get(productId) ?? new Set<string>();
        const seen = new Set<string>();
        subset.forEach((variantId: unknown, i: number) => {
          const path = `${basePath}[${i}]`;
          if (typeof variantId !== "string") {
            fail(errors, "bad-shape", path, "variant id must be a string");
            return;
          }
          checkIdChars(variantId, path, errors);
          if (seen.has(variantId)) {
            fail(errors, "duplicate-id", path, `duplicate variant id "${variantId}"`);
          } else {
            seen.add(variantId);
          }
          if (!known.has(variantId)) {
            fail(
              errors,
              "unknown-id",
              path,
              `unknown variant "${variantId}" for product "${productId}"`,
            );
          }
        });
        survivingByProduct.set(
          productId,
          new Set<string>(subset.filter((v): v is string => typeof v === "string")),
        );
      }
    }
  }

  // --- configurationIds ---
  const configurationIds: unknown = selection.configurationIds;
  if (configurationIds !== undefined) {
    if (!Array.isArray(configurationIds)) {
      fail(
        errors,
        "bad-shape",
        "selection.configurationIds",
        "configurationIds must be an array",
      );
    } else {
      if (configurationIds.length > BUILDER_LIMITS.maxConfigurations) {
        fail(
          errors,
          "too-many",
          "selection.configurationIds",
          `at most ${BUILDER_LIMITS.maxConfigurations} configurations`,
        );
      }
      const seen = new Set<string>();
      configurationIds.forEach((id: unknown, i: number) => {
        const path = `selection.configurationIds[${i}]`;
        if (typeof id !== "string") {
          fail(errors, "bad-shape", path, "configuration id must be a string");
          return;
        }
        checkIdChars(id, path, errors);
        if (seen.has(id)) {
          fail(errors, "duplicate-id", path, `duplicate configuration id "${id}"`);
        } else {
          seen.add(id);
        }
        const source = sourceConfigById.get(id);
        if (source === undefined) {
          fail(errors, "unknown-id", path, `unknown configuration id "${id}"`);
          return;
        }
        if (!selectedProducts.has(source.productId)) {
          fail(
            errors,
            "not-selected",
            path,
            `configuration "${id}" references unselected product "${source.productId}"`,
          );
        } else {
          const surviving = survivingByProduct.get(source.productId);
          if (surviving !== undefined && !surviving.has(source.variantId)) {
            fail(
              errors,
              "not-selected",
              path,
              `configuration "${id}" references pruned variant "${source.variantId}"`,
            );
          }
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateIdentity(identity: unknown, errors: ValidationError[]): void {
  if (!isRecord(identity)) {
    fail(errors, "bad-shape", "identity", "identity must be an object");
    return;
  }
  // Policy: UI trims before calling core; core validates the trimmed value
  // (1..256 chars) and rejects surrounding whitespace so `" x "` never
  // silently becomes `"x"`. Trimmed values are used on issue.
  for (const field of ["customerLabel", "jobReference", "issuedBy", "projectId"] as const) {
    const value: unknown = identity[field];
    const path = `identity.${field}`;
    if (typeof value !== "string") {
      fail(errors, "bad-identity", path, `${field} must be a string`);
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 256) {
      fail(errors, "bad-identity", path, `${field} must be 1..256 chars after trimming`);
      continue;
    }
    if (trimmed !== value) {
      fail(errors, "bad-identity", path, `${field} must not have leading or trailing whitespace`);
    }
  }
}

/**
 * Build a fresh customer-facing issue (revision exactly 1, approvals cleared)
 * from a source project plus a validated selection and identity.
 */
export function buildIssuedProject(
  project: ProjectDocument,
  selection: BuilderSelection,
  identity: BuilderIdentity,
): BuilderIssueResult {
  const structural = validateProject(project);
  if (!structural.ok) {
    return { ok: false, errors: structural.errors };
  }
  const selectionCheck = validateBuilderSelection(project, selection);
  if (!selectionCheck.ok) {
    return { ok: false, errors: selectionCheck.errors };
  }
  const identityErrors: ValidationError[] = [];
  validateIdentity(identity, identityErrors);
  if (identityErrors.length > 0) {
    return { ok: false, errors: identityErrors };
  }

  const source = clone(project);
  const selectedProducts = new Set<string>(selection.productIds);
  const selectedLogos = new Set<string>(selection.logoIds);

  const survivingByProduct = new Map<string, Set<string>>();
  for (const product of source.products) {
    if (!selectedProducts.has(product.id)) continue;
    const explicit = selection.variantIdsByProduct && Object.hasOwn(selection.variantIdsByProduct, product.id) ? selection.variantIdsByProduct[product.id] : undefined;
    survivingByProduct.set(
      product.id,
      explicit !== undefined
        ? new Set<string>(explicit)
        : new Set<string>(product.variants.map((v) => v.id)),
    );
  }

  // Products: keep selected; prune variants; prune overrides to product regions.
  const prunedProducts: ProductDefinition[] = [];
  for (const product of source.products) {
    if (!selectedProducts.has(product.id)) continue;
    const surviving = survivingByProduct.get(product.id) ?? new Set<string>();
    const regionIds = new Set<string>(product.regions.map((r) => r.id));
    const variants = product.variants
      .filter((variant) => surviving.has(variant.id))
      .map((variant) => {
        const copy = clone(variant);
        if (copy.placementOverrides !== undefined) {
          copy.placementOverrides = copy.placementOverrides.filter((override) =>
            regionIds.has(override.regionId),
          );
          if (copy.placementOverrides.length === 0) {
            delete copy.placementOverrides;
          }
        }
        return copy;
      });
    prunedProducts.push({ ...clone(product), variants });
  }

  const prunedLogos = source.logos.filter((logo) => selectedLogos.has(logo.id)).map(clone);

  // Variant support lookup for placement filtering.
  const variantRegions = new Map<string, Map<string, Set<string>>>();
  for (const product of prunedProducts) {
    const perVariant = new Map<string, Set<string>>();
    for (const variant of product.variants) {
      perVariant.set(variant.id, new Set<string>(variant.regionIds));
    }
    variantRegions.set(product.id, perVariant);
  }
  const productRegionIds = new Map<string, Set<string>>();
  for (const product of prunedProducts) {
    productRegionIds.set(product.id, new Set<string>(product.regions.map((r) => r.id)));
  }

  // Configurations: explicit subset or surviving product+variant refs.
  let keptConfigs: Configuration[];
  if (selection.configurationIds !== undefined) {
    const wanted = new Set<string>(selection.configurationIds);
    keptConfigs = source.configurations
      .filter((config) => wanted.has(config.id))
      .map(clone);
  } else {
    keptConfigs = source.configurations
      .filter((config) => {
        if (!selectedProducts.has(config.productId)) return false;
        const surviving = survivingByProduct.get(config.productId);
        if (surviving === undefined || !surviving.has(config.variantId)) return false;
        return true;
      })
      .map(clone);
  }

  // Automatic selection includes an editable zero-placement configuration for
  // every selected variant, even when no default placement existed in source.
  if (selection.configurationIds === undefined) {
    const ids = new Set(source.configurations.map((config) => config.id));
    let nextId = 1;
    for (const product of prunedProducts) {
      for (const variant of product.variants) {
        if (keptConfigs.some((config) => config.productId === product.id && config.variantId === variant.id)) continue;
        while (ids.has(`builder-config-${nextId}`)) nextId += 1;
        const id = `builder-config-${nextId++}`;
        ids.add(id);
        keptConfigs.push({ id, productId: product.id, variantId: variant.id, placements: [] });
      }
    }
  }
  if (keptConfigs.length > BUILDER_LIMITS.maxConfigurations) {
    return { ok: false, errors: [{ code: "too-many", path: "configurations", message: "Issued configuration count exceeds builder limit" }] };
  }

  // Placements: keep only when the logo is selected and the region survives
  // on the product and the surviving variant supports it. Zero is valid.
  for (const config of keptConfigs) {
    const regions = productRegionIds.get(config.productId) ?? new Set<string>();
    const perVariant = variantRegions.get(config.productId);
    const supported = perVariant?.get(config.variantId) ?? new Set<string>();
    config.placements = config.placements.filter(
      (placement) =>
        selectedLogos.has(placement.logoId) &&
        regions.has(placement.regionId) &&
        supported.has(placement.regionId),
    );
  }

  const customerLabel = identity.customerLabel.trim();
  const jobReference = identity.jobReference.trim();
  const issuedBy = identity.issuedBy.trim();
  const issuedProjectId = identity.projectId.trim();
  const issued: ProjectDocument = {
    schemaVersion: source.schemaVersion,
    projectId: issuedProjectId,
    ...(source.synthetic !== undefined ? { synthetic: source.synthetic } : {}),
    description:
      `Internal-builder issue ${issuedProjectId} for ${customerLabel} / ${jobReference} ` +
      `by ${issuedBy}. Confirmation and internal review history reset before customer handoff.`,
    revision: 1,
    products: prunedProducts,
    logos: prunedLogos,
    configurations: keptConfigs,
    ...(source.instructions !== undefined ? { instructions: source.instructions } : {}),
  };

  const validation = validateProject(issued);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  return { ok: true, project: issued };
}

/**
 * Prune a full asset set down to the URIs referenced by an issued project.
 * Preserves the exact input `bytes` references, sorts by path, throws on
 * duplicate input paths, and throws on any missing referenced asset URI
 * (never silently omits).
 */
export function selectIssuedAssets(
  allAssets: readonly { path: string; bytes: Uint8Array }[],
  issuedProject: ProjectDocument,
): { path: string; bytes: Uint8Array }[] {
  const referenced = new Set<string>();
  for (const logo of issuedProject.logos ?? []) {
    for (const asset of logo.assets ?? []) {
      if (typeof asset.uri === "string") referenced.add(asset.uri);
    }
  }
  const seen = new Set<string>();
  for (const entry of allAssets) {
    if (seen.has(entry.path)) {
      throw new Error(`selectIssuedAssets: duplicate asset path "${entry.path}"`);
    }
    seen.add(entry.path);
  }
  for (const uri of referenced) {
    if (!seen.has(uri)) {
      throw new Error(`selectIssuedAssets: missing asset "${uri}"`);
    }
  }
  return allAssets
    .filter((entry) => referenced.has(entry.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => ({ path: entry.path, bytes: entry.bytes }));
}
