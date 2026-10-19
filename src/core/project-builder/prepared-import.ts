/**
 * Prepared-product import — pure kernel for Builder intake of
 * inspector-bridge output (or any externally prepared product definition).
 *
 * Pure TypeScript: no DOM/Node/Three/React. No timestamps, no randomness.
 * Never mutates inputs. Never touches schema versions.
 *
 * A prepared product carries real authored millimetre geometry (regions with
 * safe areas, calibration refs, explicit methods). This module validates a
 * candidate product through the existing `validateProduct` contract and
 * appends it to a project with one zero-placement configuration per variant,
 * mirroring `createProjectFromDefinitions`. Sidecar evidence (bridge mapping
 * details the canonical schema cannot represent) and the original area-bundle
 * export are validated as bounded JSON and returned alongside for the caller
 * to package as additional assets — neither is merged into the canonical
 * project. The original export preserves complete source evidence (including
 * named exclusion identities the canonical polygons cannot represent).
 *
 * Rejections (all atomic, no partial append):
 * - candidate fails `validateProduct` (covers schema, finite numbers,
 *   safe-area shape, calibration refs, methods, preview-only-shape rules);
 * - product id already present in the project;
 * - product carries no regions or no variants that support a region (it
 *   could not host placements, so intake refuses it);
 * - generated configuration ids would exceed builder configuration limits;
 * - sidecar or area bundle is not bounded JSON (oversized or non-finite/cyclic).
 * Production approval is never conferred: intake preserves the candidate's
 * own description and marks nothing approved.
 *
 * Confirmation hygiene: appending alters project content, so the returned
 * project must be re-issued (fresh revision, cleared confirmation/review
 * histories) before any customer handoff. The Builder does this through the
 * existing `buildIssuedProject` contract (revision 1, approvals cleared);
 * this module never reuses a stale confirmation itself.
 */

import { isRecord } from "../guards.js";
import type {
  Configuration,
  ProductDefinition,
  ProjectDocument,
  ValidationError,
  ValidationResult,
} from "../types.js";
import { validateProduct, validateProject } from "../validate.js";
import { BUILDER_LIMITS } from "./index.js";

export const PREPARED_IMPORT_LIMITS = {
  /** Must agree with the bridge's total-sidecar ceiling (pinned by test). */
  maxSidecarChars: 262144,
  maxSidecarDepth: 32,
  /** Original area-bundle evidence text (verbatim bytes, well within package asset limits). */
  maxAreaBundleChars: 1048576,
  /**
   * Whole prepared-product file bound, mirroring the Builder UI pre-read
   * bound and the converter envelope ceiling (all three pinned to agree).
   * The converter enforces this BEFORE its exclusive install so its output
   * is always consumable by the Builder import below.
   */
  maxImportFileBytes: 1048576,
} as const;

export type AppendPreparedProductResult =
  | { ok: true; project: ProjectDocument; sidecar: unknown; areaBundleText: string | null; areaBundleSha256: string | null }
  | { ok: false; errors: ValidationError[] };

function fail(errors: ValidationError[], code: string, path: string, message: string): void {
  errors.push({ code, path, message });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonSafeDepth(value: unknown, depth: number, maxDepth: number, seen: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > maxDepth || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => jsonSafeDepth(item, depth + 1, maxDepth, seen));
  seen.delete(value);
  return valid;
}

function jsonSafe(value: unknown, depth: number, seen: Set<object>): boolean {
  return jsonSafeDepth(value, depth, PREPARED_IMPORT_LIMITS.maxSidecarDepth, seen);
}

/**
 * Bounded-JSON evidence check shared by the sidecar and the original
 * area-bundle export. Validates shape BEFORE serializing (JSON.stringify
 * throws on cyclic input and BigInt), then checks the serialized length.
 * Never throws: hostile input yields an error string, valid input yields
 * its canonical text.
 */
function checkBoundedEvidence(
  value: unknown,
  path: "sidecar" | "areaBundle",
  maxChars: number,
  maxDepth: number,
): { ok: true; text: string } | { ok: false; error: ValidationError } {
  if (!jsonSafeDepth(value, 0, maxDepth, new Set())) {
    return { ok: false, error: { code: "bad-shape", path, message: `${path} must contain finite JSON data without cycles` } };
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined || text.length > maxChars) {
    return { ok: false, error: { code: "too-large", path, message: `${path} must stringify to at most ${maxChars} chars` } };
  }
  return { ok: true, text };
}

/**
 * Normalize the accepted file shapes:
 * - a bare `ProductDefinition`;
 * - an envelope `{ product, sidecar?, areaBundleText?, areaBundleSha256? }`
 *   as emitted by the conversion entrypoint
 *   (`scripts/convert-area-bundle.mjs`).
 * Anything else is a shape error. The sidecar must be bounded JSON when
 * present; the area-bundle text must be bounded valid JSON with a matching
 * 64-hex SHA-256 when present (both-or-neither). The text ships verbatim as
 * evidence — never re-serialized — so original bytes are preserved exactly.
 *
 * Verification boundary (honest): this pure module performs STRUCTURAL and
 * boundedness checks only — the digest is format-checked (64 lowercase hex),
 * never cryptographically verified, because pure core takes no hash function
 * for evidence bytes here by design. The caller MUST hash the exact bytes it
 * packages and compare against the supplied digest before committing (the
 * Builder does this with its async hasher and discards obsolete hashes).
 * Treat `areaBundleSha256` as a claim until that caller-side check passes.
 */
export function parsePreparedImport(input: unknown): {
  ok: true;
  product: ProductDefinition;
  sidecar: unknown;
  areaBundleText: string | null;
  areaBundleSha256: string | null;
} | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (!isRecord(input)) {
    fail(errors, "bad-shape", "input", "prepared product file must be a JSON object");
    return { ok: false, errors };
  }
  const hasProduct = Object.hasOwn(input, "product");
  const candidate: unknown = hasProduct ? input["product"] : input;
  let sidecar: unknown;
  let areaBundleText: string | null = null;
  let areaBundleSha256: string | null = null;
  if (hasProduct) {
    sidecar = input["sidecar"];
    if (sidecar !== undefined) {
      const checked = checkBoundedEvidence(sidecar, "sidecar", PREPARED_IMPORT_LIMITS.maxSidecarChars, PREPARED_IMPORT_LIMITS.maxSidecarDepth);
      if (!checked.ok) {
        errors.push(checked.error);
        return { ok: false, errors };
      }
    }
    const text: unknown = input["areaBundleText"];
    const sha: unknown = input["areaBundleSha256"];
    if (text !== undefined || sha !== undefined) {
      if (typeof text !== "string" || text.length === 0 || text.length > PREPARED_IMPORT_LIMITS.maxAreaBundleChars) {
        fail(errors, "too-large", "areaBundleText", `area bundle text must be 1..${PREPARED_IMPORT_LIMITS.maxAreaBundleChars} chars of valid JSON`);
        return { ok: false, errors };
      }
      let parsedText: unknown;
      try {
        parsedText = JSON.parse(text);
      } catch {
        fail(errors, "bad-shape", "areaBundleText", "area bundle text must be valid JSON");
        return { ok: false, errors };
      }
      if (typeof parsedText !== "object" || parsedText === null || Array.isArray(parsedText)) {
        fail(errors, "bad-shape", "areaBundleText", "area bundle text must be a JSON object");
        return { ok: false, errors };
      }
      if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
        fail(errors, "bad-shape", "areaBundleSha256", "area bundle SHA-256 must be 64 lowercase hex chars alongside area bundle text");
        return { ok: false, errors };
      }
      areaBundleText = text;
      areaBundleSha256 = sha;
    }
  }
  const check = validateProduct(candidate);
  if (!check.ok) return { ok: false, errors: check.errors };
  return { ok: true, product: candidate as ProductDefinition, sidecar, areaBundleText, areaBundleSha256 };
}

function nextConfigId(taken: Set<string>): string {
  let next = 1;
  while (taken.has(`prepared-config-${next}`)) next += 1;
  return `prepared-config-${next++}`;
}

/**
 * Append one prepared product to a project (pure; inputs never mutated).
 * Generates one zero-placement configuration per variant that supports at
 * least one region, ordered by variant. Returns the new project plus the
 * validated sidecar and original area-bundle export for the caller to
 * package as additional assets.
 */
export function appendPreparedProduct(
  project: ProjectDocument,
  input: unknown,
): AppendPreparedProductResult {
  const errors: ValidationError[] = [];
  const structural = validateProject(project);
  if (!structural.ok) return { ok: false, errors: structural.errors };
  const parsed = parsePreparedImport(input);
  if (!parsed.ok) return parsed;

  const existingIds = new Set(project.products.map((product) => product.id));
  if (existingIds.has(parsed.product.id)) {
    fail(errors, "duplicate-id", "product.id", `product id "${parsed.product.id}" is already in this project`);
    return { ok: false, errors };
  }
  if (parsed.product.regions.length < 1) {
    fail(errors, "empty-selection", "product.regions", "prepared product carries no regions and cannot host placements");
    return { ok: false, errors };
  }
  const usableVariants = parsed.product.variants.filter((variant) => variant.regionIds.length > 0);
  if (usableVariants.length < 1) {
    fail(errors, "empty-selection", "product.variants", "no variant supports a region; the product cannot host placements");
    return { ok: false, errors };
  }

  const taken = new Set(project.configurations.map((config) => config.id));
  if (taken.size + usableVariants.length > BUILDER_LIMITS.maxConfigurations) {
    fail(errors, "too-many", "configurations", `importing ${usableVariants.length} variant(s) would exceed the ${BUILDER_LIMITS.maxConfigurations} configuration limit`);
    return { ok: false, errors };
  }

  const next = clone(project);
  next.products.push(clone(parsed.product));
  const configurations: Configuration[] = usableVariants.map((variant) => {
    const id = nextConfigId(taken);
    taken.add(id);
    return { id, productId: parsed.product.id, variantId: variant.id, placements: [] };
  });
  next.configurations.push(...configurations);

  const validation: ValidationResult = validateProject(next);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return {
    ok: true,
    project: next,
    sidecar: parsed.sidecar === undefined ? null : clone(parsed.sidecar),
    areaBundleText: parsed.areaBundleText,
    areaBundleSha256: parsed.areaBundleSha256,
  };
}

/**
 * Package-evidence path convention for bridge sidecars and original
 * area-bundle exports. The filename segment is a sanitized derivative of the
 * product id for portability; the authoritative product binding is the
 * `labels.product.id` field INSIDE the sidecar JSON (never the filename).
 * Two product ids sanitizing to the same segment collide: the caller must
 * reject an evidence path that already exists in the project before
 * committing.
 */
export const PREPARED_EVIDENCE_PREFIX = "prepared/" as const;
export const PREPARED_SIDECAR_SUFFIX = ".bridge-sidecar.json" as const;
export const PREPARED_AREA_BUNDLE_SUFFIX = ".area-bundle.json" as const;

function evidenceSegment(productId: string): string {
  const cleaned = productId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned === "" ? "product" : cleaned;
}

export function sidecarAssetPath(productId: string): string {
  return `${PREPARED_EVIDENCE_PREFIX}${evidenceSegment(productId)}${PREPARED_SIDECAR_SUFFIX}`;
}

export function areaBundleAssetPath(productId: string): string {
  return `${PREPARED_EVIDENCE_PREFIX}${evidenceSegment(productId)}${PREPARED_AREA_BUNDLE_SUFFIX}`;
}

/** Both evidence paths derived for one imported product (sidecar + original export). */
export function preparedEvidencePaths(productId: string): { sidecar: string; areaBundle: string } {
  return { sidecar: sidecarAssetPath(productId), areaBundle: areaBundleAssetPath(productId) };
}

/**
 * Select the sidecar evidence texts to ship with an issued package: only
 * sidecars whose embedded `labels.product.id` matches an issued
 * configuration's product. Pure over decoded texts (the caller owns byte
 * decoding); never throws — unparseable or misshapen entries are skipped.
 * Output sorted by path for deterministic packaging.
 */
export function selectPreparedSidecarAssets(
  entries: readonly { path: string; text: string }[],
  configurations: readonly { productId: string }[],
): Array<{ path: string }> {
  const wanted = new Set(configurations.map((config) => config.productId));
  const selected: Array<{ path: string }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.path !== "string" || typeof entry.text !== "string") continue;
    if (!entry.path.startsWith(PREPARED_EVIDENCE_PREFIX) || !entry.path.endsWith(PREPARED_SIDECAR_SUFFIX)) continue;
    if (seen.has(entry.path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.text);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const labels = parsed["labels"];
    if (!isRecord(labels)) continue;
    const product = labels["product"];
    if (!isRecord(product)) continue;
    const id = product["id"];
    if (typeof id !== "string" || !wanted.has(id)) continue;
    seen.add(entry.path);
    selected.push({ path: entry.path });
  }
  selected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return selected;
}
