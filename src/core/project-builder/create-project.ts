/**
 * Create-a-project core: build a fresh synthetic draft project directly from
 * prepared product/logo definitions (no source customer project involved).
 *
 * Pure TypeScript: no DOM/Node/Three/React. No timestamps, no randomness.
 * Never mutates inputs. Never touches schema versions.
 *
 * Fresh draft shape: revision 1, one zero-placement configuration per product
 * variant (deterministic `example-config-N` ids ordered by product then
 * variant), no instructions/confirmation/review/history/baseline. Caller
 * inputs are deep-cloned; duplicate ids and builder-limit breaches are
 * rejected up front, and the assembled draft is validated via the existing
 * `validateProject` contract (which also rejects unknown refs).
 */

import { isRecord } from "../guards.js";
import type {
  Configuration,
  LogoDefinition,
  ProductDefinition,
  ProjectDocument,
  ValidationError,
} from "../types.js";
import { SCHEMA_VERSION } from "../types.js";
import { validateProject } from "../validate.js";
import { BUILDER_LIMITS } from "./index.js";

export interface CreateProjectInput {
  products: readonly ProductDefinition[];
  logos?: readonly LogoDefinition[];
  projectId: string;
  /** Defaults to true when omitted (fixtures are synthetic). */
  synthetic?: boolean;
}

export type CreateProjectResult =
  | { ok: true; project: ProjectDocument }
  | { ok: false; errors: ValidationError[] };

function fail(errors: ValidationError[], code: string, path: string, message: string): void {
  errors.push({ code, path, message });
}

/** Length/whitespace rule mirrors `checkIdChars` + `validateIdentity` in `./index.ts`. */
function checkProjectId(value: unknown, errors: ValidationError[]): string | undefined {
  if (typeof value !== "string") {
    fail(errors, "bad-id", "projectId", "projectId must be a string");
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > BUILDER_LIMITS.maxIdChars) {
    fail(
      errors,
      "bad-id",
      "projectId",
      `projectId must be 1..${BUILDER_LIMITS.maxIdChars} chars after trimming`,
    );
    return undefined;
  }
  if (trimmed !== value) {
    fail(errors, "bad-id", "projectId", "projectId must not have leading or trailing whitespace");
    return undefined;
  }
  return trimmed;
}

export function createProjectFromDefinitions(input: CreateProjectInput): CreateProjectResult {
  const errors: ValidationError[] = [];
  if (!isRecord(input)) {
    fail(errors, "bad-shape", "input", "input must be an object");
    return { ok: false, errors };
  }

  const { products: productsValue, logos: logosValue = [], projectId: projectIdValue } = input as {
    products: unknown;
    logos?: unknown;
    projectId: unknown;
  };
  const syntheticValue: unknown = input.synthetic;
  let synthetic = true;
  if (syntheticValue !== undefined) {
    if (typeof syntheticValue !== "boolean") {
      fail(errors, "bad-shape", "synthetic", "synthetic must be a boolean");
    } else {
      synthetic = syntheticValue;
    }
  }

  const projectId = checkProjectId(projectIdValue, errors);

  if (!Array.isArray(productsValue)) {
    fail(errors, "bad-shape", "products", "products must be an array");
  } else {
    if (productsValue.length < 1) {
      fail(errors, "empty-selection", "products", "at least 1 product is required");
    }
    if (productsValue.length > BUILDER_LIMITS.maxProducts) {
      fail(errors, "too-many", "products", `at most ${BUILDER_LIMITS.maxProducts} products`);
    }
    const seen = new Set<string>();
    productsValue.forEach((entry: unknown, i: number) => {
      if (!isRecord(entry) || typeof entry["id"] !== "string") return;
      const id = entry["id"];
      if (seen.has(id)) {
        fail(errors, "duplicate-id", `products[${i}].id`, `duplicate product id "${id}"`);
      } else {
        seen.add(id);
      }
    });
  }

  if (!Array.isArray(logosValue)) {
    fail(errors, "bad-shape", "logos", "logos must be an array");
  } else {
    if (logosValue.length > BUILDER_LIMITS.maxLogos) {
      fail(errors, "too-many", "logos", `at most ${BUILDER_LIMITS.maxLogos} logos`);
    }
    const seen = new Set<string>();
    logosValue.forEach((entry: unknown, i: number) => {
      if (!isRecord(entry) || typeof entry["id"] !== "string") return;
      const id = entry["id"];
      if (seen.has(id)) {
        fail(errors, "duplicate-id", `logos[${i}].id`, `duplicate logo id "${id}"`);
      } else {
        seen.add(id);
      }
    });
  }

  // Configuration budget: one generated configuration per product variant.
  // Malformed variants are left for validateProject; only well-formed string
  // ids count toward the limit here.
  if (Array.isArray(productsValue)) {
    let variantCount = 0;
    for (const entry of productsValue) {
      if (!isRecord(entry) || !Array.isArray(entry["variants"])) continue;
      for (const variant of entry["variants"]) {
        if (isRecord(variant) && typeof variant["id"] === "string") {
          variantCount += 1;
        }
      }
    }
    if (variantCount > BUILDER_LIMITS.maxConfigurations) {
      fail(
        errors,
        "too-many",
        "configurations",
        `at most ${BUILDER_LIMITS.maxConfigurations} configurations (one per product variant)`,
      );
    }
  }

  if (errors.length > 0 || projectId === undefined) {
    return { ok: false, errors };
  }

  // Reject non-JSON/invalid numbers before cloning can erase or rewrite them.
  const seen = new Set<object>();
  function jsonSafe(value: unknown, depth = 0): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || depth > 64 || seen.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    seen.add(value);
    const valid = Object.values(value).every(item => jsonSafe(item, depth + 1));
    seen.delete(value);
    return valid;
  }
  try {
    if (!jsonSafe(productsValue) || !jsonSafe(logosValue)) throw new Error('non-JSON definitions');
  } catch {
    return { ok: false, errors: [{code:'bad-shape',path:'definitions',message:'Prepared definitions must contain finite JSON data without cycles.'}] };
  }
  const products = JSON.parse(JSON.stringify(productsValue)) as ProductDefinition[];
  const logos = JSON.parse(JSON.stringify(logosValue)) as LogoDefinition[];

  // One deterministic zero-placement configuration per well-formed variant,
  // ordered by product then variant. Malformed products/variants are skipped
  // here and rejected by validateProject below (never fabricated into
  // valid-looking output).
  const configurations: Configuration[] = [];
  let nextId = 1;
  for (const entry of productsValue as unknown[]) {
    if (!isRecord(entry)) continue;
    const entryProductId: unknown = entry["id"];
    const entryVariants: unknown = entry["variants"];
    if (typeof entryProductId !== "string" || !Array.isArray(entryVariants)) continue;
    for (const rawVariant of entryVariants) {
      if (!isRecord(rawVariant) || typeof rawVariant["id"] !== "string") continue;
      configurations.push({
        id: `example-config-${nextId++}`,
        productId: entryProductId,
        variantId: rawVariant["id"],
        placements: [],
      });
    }
  }

  const project: ProjectDocument = {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    synthetic,
    description:
      `Prepared catalogue draft ${projectId}. Zero placements; confirmation and ` +
      `internal review history reset before customer handoff.`,
    revision: 1,
    products,
    logos,
    configurations,
  };

  const validation = validateProject(project);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  return { ok: true, project };
}
