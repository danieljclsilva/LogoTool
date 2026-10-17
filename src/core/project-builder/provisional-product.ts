/**
 * Provisional (preview-only) product factory for LogoTool multiview builder imports.
 *
 * Pure TypeScript: no DOM/Node/Three. Deterministic, JSON-safe, never throws
 * on parsed-JSON input, never mutates input.
 *
 * The returned product carries NO physical measurements: it is the all-empty
 * preview-only shape (`regions: []`, `calibrations: []`, every variant
 * `regionIds: []`) with a single default variant. Preview-only products
 * cannot host placements: with no regions there is nothing to place on, and
 * validation rejects any placement referencing them. Passes `validateProject`
 * with zero placements.
 */

import { isRecord } from "../guards.js";
import type { ProductDefinition, ProductKind, ValidationError } from "../types.js";
import { SCHEMA_VERSION } from "../types.js";
import { BUILDER_LIMITS } from "./index.js";

export interface ProvisionalProductInput {
  id: string;
  name?: string;
  kind?: ProductKind;
}

export type ProvisionalProductResult =
  | { ok: true; product: ProductDefinition }
  | { ok: false; errors: ValidationError[] };

const KIND_SET: Record<string, true> = {
  "upper-body": true,
  "lower-body": true,
  "full-body": true,
  headwear: true,
  other: true,
};

function fail(errors: ValidationError[], code: string, path: string, message: string): void {
  errors.push({ code, path, message });
}

function checkId(id: unknown, errors: ValidationError[]): string | undefined {
  if (typeof id !== "string") {
    fail(errors, "bad-id", "input.id", "product id must be a string");
    return undefined;
  }
  if (id.length < 1 || id.length > BUILDER_LIMITS.maxIdChars) {
    fail(errors, "bad-id", "input.id", `product id must be 1..${BUILDER_LIMITS.maxIdChars} chars`);
    return undefined;
  }
  if (id.trim() !== id) {
    fail(errors, "bad-id", "input.id", "product id must not have leading or trailing whitespace");
    return undefined;
  }
  return id;
}

/**
 * Structural preview-only check: regions AND calibrations both empty.
 * Never name-substring heuristics; the all-empty shape is the contract.
 */
export function isPreviewOnlyProduct(product: unknown): boolean {
  if (!isRecord(product)) return false;
  const regions = product["regions"];
  const calibrations = product["calibrations"];
  return Array.isArray(regions) && regions.length === 0 && Array.isArray(calibrations) && calibrations.length === 0;
}

/**
 * True when the configuration's product resolves and is preview-only.
 * Preview-only configurations cannot host placements.
 */
export function isPreviewOnlyConfiguration(project: unknown, configuration: unknown): boolean {
  if (!isRecord(project) || !isRecord(configuration)) return false;
  const products = project["products"];
  const productId = configuration["productId"];
  if (!Array.isArray(products) || typeof productId !== "string") return false;
  const product = products.find((entry) => isRecord(entry) && entry["id"] === productId);
  return isPreviewOnlyProduct(product);
}

export function createProvisionalProduct(input: unknown): ProvisionalProductResult {
  const errors: ValidationError[] = [];
  if (!isRecord(input)) {
    fail(errors, "bad-shape", "input", "input must be an object");
    return { ok: false, errors };
  }
  const id = checkId(input["id"], errors);
  let name: string | undefined;
  const nameValue: unknown = input["name"];
  if (nameValue !== undefined) {
    if (typeof nameValue !== "string" || nameValue.length < 1 || nameValue.length > BUILDER_LIMITS.maxIdChars) {
      fail(errors, "bad-shape", "input.name", `product name must be 1..${BUILDER_LIMITS.maxIdChars} chars`);
    } else if (nameValue.trim() !== nameValue) {
      fail(errors, "bad-shape", "input.name", "product name must not have leading or trailing whitespace");
    } else {
      name = nameValue;
    }
  }
  let kind: ProductKind = "other";
  const kindValue: unknown = input["kind"];
  if (kindValue !== undefined) {
    if (typeof kindValue !== "string" || KIND_SET[kindValue] !== true) {
      fail(errors, "bad-shape", "input.kind", "product kind must be one of upper-body|lower-body|full-body|headwear|other");
    } else {
      kind = kindValue as ProductKind;
    }
  }
  if (errors.length > 0 || id === undefined) {
    return { ok: false, errors };
  }
  const productName = name ?? `Provisional uncalibrated product ${id}`;
  const product: ProductDefinition = {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: productName,
    kind,
    variants: [
      {
        id: `${id}-default`,
        regionIds: [],
      },
    ],
    regions: [],
    calibrations: [],
  };
  return { ok: true, product };
}
