/**
 * Structural + referential validation for LogoTool provisional documents.
 *
 * Entry points: `validateProduct`, `validateLogos`, `validateProject`.
 * Every function returns `{ ok, errors }` with coded errors
 * `{ code, path, message }`; paths are JSON-pointer-like
 * (`products[0].regions[1].safeArea`). Every entry point is defensive over
 * unknown input: malformed nested definitions yield errors, never throws,
 * for any parsed-JSON input.
 *
 * Structural shape comes from the same real JSON Schema contracts used at
 * runtime (`src/core/contracts.ts`, Ajv 2020-12 strict over the checked-in
 * `schemas/*.schema.json`): unknown fields — including any legacy shapes
 * such as `confirmationHistory`, `internalReview`, or flat placement
 * `xMm`/`yMm` — are rejected by `additionalProperties: false`, never
 * accepted or migrated. There is no released legacy format.
 *
 * Semantic rules enforced on top of the structural contract:
 * - Unsupported/missing `schemaVersion` (literal "0.1.0-provisional").
 * - Duplicate ids (products, variants, regions, calibrations, logos,
 *   configurations, placement ids within one configuration).
 * - Dangling refs (productId, variantId, regionId, logoId).
 * - Non-finite numbers, non-positive width/height, bad rotation
 *   (non-number, non-finite, or outside (-180, 180]).
 * - Malformed region frame, unresolvable calibrationRef, bad method
 *   (not in region `allowedMethods`), region not supported by the variant.
 * - Safe-area polygon with fewer than 3 finite points; malformed exclusions.
 * - Nested `pos` is authoritative; any own flat placement coordinate
 *   property is a shape error, never silently accepted.
 * - Zero placements valid; repeated same `logoId` valid (no uniqueness check).
 * - `validateProject(doc, baseline)` additionally runs the baseline tamper
 *   check (see workflow.ts) when a baseline is supplied.
 *
 * Pure apart from the Ajv contract import: no crypto, no DOM / React /
 * Three.js, no Node APIs.
 */

import { DIGEST_HEX_PATTERN, REVIEW_DECISIONS, SCHEMA_VERSION } from "./types.js";
import type { ValidationError, ValidationResult } from "./types.js";
import { isRecord } from "./guards.js";
import { checkAgainstBaseline } from "./workflow.js";
import type { IssuedBaseline } from "./types.js";
import {
  checkLogoContract,
  checkProductContract,
  checkProjectContract,
} from "./contracts.js";

const PRODUCT_KIND_SET: Record<string, true> = {
  "upper-body": true,
  "lower-body": true,
  "full-body": true,
  headwear: true,
  other: true,
};

const ASSET_ROLE_SET: Record<string, true> = {
  original: true,
  reference: true,
  proposal: true,
  proof: true,
  production: true,
};

const KIND_LABEL = "upper-body|lower-body|full-body|headwear|other";
const ROLE_LABEL = "original|reference|proposal|proof|production";


function fail(
  errors: ValidationError[],
  code: string,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function checkVersion(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (value !== SCHEMA_VERSION) {
    fail(
      errors,
      "unsupported-schema-version",
      path,
      `unsupported schemaVersion ${JSON.stringify(value) ?? "unknown"}; expected "${SCHEMA_VERSION}"`,
    );
  }
}

function checkIdList(
  ids: string[],
  path: string,
  errors: ValidationError[],
  what: string,
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      fail(errors, "duplicate-id", path, `duplicate ${what} id "${id}"`);
    } else {
      seen.add(id);
    }
  }
}

function checkDigestShape(
  value: unknown,
  path: string,
  errors: ValidationError[],
): value is string {
  if (typeof value !== "string" || !DIGEST_HEX_PATTERN.test(value)) {
    fail(
      errors,
      "bad-digest",
      path,
      "digest must be lowercase SHA-256 hex ([0-9a-f]{64})",
    );
    return false;
  }
  return true;
}

function checkPositiveDimension(
  value: unknown,
  path: string,
  errors: ValidationError[],
  what: string,
): void {
  if (typeof value !== "number" || Number.isNaN(value)) {
    if (typeof value === "number") {
      fail(errors, "nonfinite-number", path, `${what} must be finite`);
    } else {
      fail(errors, "bad-shape", path, `${what} must be a number`);
    }
    return;
  }
  if (!Number.isFinite(value)) {
    fail(errors, "nonfinite-number", path, `${what} must be finite`);
    return;
  }
  if (value <= 0) {
    fail(errors, "nonpositive-dimension", path, `${what} must be > 0`);
  }
}

function checkPoint(
  value: unknown,
  path: string,
  errors: ValidationError[],
  what: string,
): void {
  if (!Array.isArray(value) || value.length !== 2) {
    fail(errors, "bad-shape", path, `${what} must be an [x, y] pair`);
    return;
  }
  const [x, y]: unknown[] = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    fail(errors, "nonfinite-number", path, `${what} coordinates must be finite numbers`);
  }
}

function checkPolygon(
  value: unknown,
  path: string,
  errors: ValidationError[],
  what: string,
  code: string,
): void {
  if (!Array.isArray(value) || value.length < 3) {
    fail(errors, code, path, `${what} polygon needs at least 3 points`);
    return;
  }
  value.forEach((point: unknown, i: number) => {
    checkPoint(point, `${path}[${i}]`, errors, `${what} point`);
  });
}

function checkStringList(
  value: unknown,
  path: string,
  errors: ValidationError[],
  what: string,
  minItems: number,
): value is string[] {
  if (!Array.isArray(value) || value.length < minItems) {
    fail(
      errors,
      "bad-shape",
      path,
      `${what} needs at least ${minItems} entr${minItems === 1 ? "y" : "ies"}`,
    );
    return false;
  }
  let clean = true;
  value.forEach((entry: unknown, i: number) => {
    if (!isNonEmptyString(entry)) {
      fail(errors, "bad-shape", `${path}[${i}]`, `${what} entries must be non-empty strings`);
      clean = false;
    }
  });
  return clean;
}

function checkAssetUri(uri: string, path: string, errors: ValidationError[]): void {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri) || uri.startsWith("/")) {
    fail(
      errors,
      "bad-shape",
      path,
      "asset uri must be a relative in-package path (never absolute or remote)",
    );
  }
}

function validateCalibrationRef(
  value: unknown,
  path: string,
  errors: ValidationError[],
  calibrations: Map<string, Set<string>>,
): void {
  if (!isRecord(value)) {
    fail(errors, "bad-shape", path, "calibrationRef must be an object");
    return;
  }
  const id = value["calibrationId"];
  const version = value["version"];
  if (!isNonEmptyString(id) || !isNonEmptyString(version)) {
    fail(
      errors,
      "bad-shape",
      path,
      "calibrationRef needs non-empty calibrationId and version strings",
    );
    return;
  }
  const versions = calibrations.get(id);
  if (versions === undefined || !versions.has(version)) {
    fail(
      errors,
      "unknown-calibration",
      path,
      `unknown calibration "${id}" version "${version}" (no matching product calibration entry)`,
    );
  }
}

function validateRegionFrame(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (!isRecord(value)) {
    fail(errors, "bad-frame", path, "region frame must be an object");
    return;
  }
  if (!isNonEmptyString(value["frameId"])) {
    fail(errors, "bad-frame", `${path}.frameId`, "frame.frameId must be a non-empty string");
  }
  if (!isNonEmptyString(value["originDescription"])) {
    fail(
      errors,
      "bad-frame",
      `${path}.originDescription`,
      "frame.originDescription must be a non-empty string",
    );
  }
  const axes = value["axes"];
  if (!isRecord(axes)) {
    fail(errors, "bad-frame", `${path}.axes`, "frame.axes must be an object");
    return;
  }
  if (!isNonEmptyString(axes["xPositive"])) {
    fail(
      errors,
      "bad-frame",
      `${path}.axes.xPositive`,
      "frame.axes.xPositive must be a non-empty direction label",
    );
  }
  if (!isNonEmptyString(axes["yPositive"])) {
    fail(
      errors,
      "bad-frame",
      `${path}.axes.yPositive`,
      "frame.axes.yPositive must be a non-empty direction label",
    );
  }
}

interface RegionIndex {
  path: string;
  allowedMethods: Set<string>;
}

interface ProductIndex {
  path: string;
  variantRegions: Map<string, Set<string>>;
}

function validateProductAt(value: unknown, basePath: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isRecord(value)) {
    fail(errors, "bad-shape", basePath, "product must be an object");
    return errors;
  }
  checkVersion(value["schemaVersion"], `${basePath}.schemaVersion`, errors);
  if (!isNonEmptyString(value["id"])) {
    fail(errors, "bad-shape", `${basePath}.id`, "product id must be a non-empty string");
  }
  const kind: unknown = value["kind"];
  if (typeof kind !== "string" || PRODUCT_KIND_SET[kind] !== true) {
    fail(errors, "bad-shape", `${basePath}.kind`, `product kind must be one of ${KIND_LABEL}`);
  }

  const variants = value["variants"];
  const variantIds: string[] = [];
  const variantRegions = new Map<string, Set<string>>();
  if (!Array.isArray(variants) || variants.length < 1) {
    fail(errors, "bad-shape", `${basePath}.variants`, "product needs at least 1 variant");
  } else {
    variants.forEach((variant: unknown, i: number) => {
      const path = `${basePath}.variants[${i}]`;
      if (!isRecord(variant)) {
        fail(errors, "bad-shape", path, "variant must be an object");
        return;
      }
      const id = variant["id"];
      if (!isNonEmptyString(id)) {
        fail(errors, "bad-shape", `${path}.id`, "variant id must be a non-empty string");
        return;
      }
      variantIds.push(id);
      const regionIds = variant["regionIds"];
      if (!checkStringList(regionIds, `${path}.regionIds`, errors, "variant regionIds", 1)) {
        variantRegions.set(id, new Set<string>());
      } else {
        variantRegions.set(id, new Set<string>(regionIds));
      }
      const overrides = variant["placementOverrides"];
      if (overrides !== undefined) {
        if (!Array.isArray(overrides)) {
          fail(errors, "bad-shape", `${path}.placementOverrides`, "placementOverrides must be an array");
        } else {
          overrides.forEach((override: unknown, k: number) => {
            const opath = `${path}.placementOverrides[${k}]`;
            if (!isRecord(override) || !isNonEmptyString(override["regionId"])) {
              fail(errors, "bad-shape", opath, "placementOverride needs a non-empty regionId");
              return;
            }
            if (override["widthMm"] !== undefined) {
              checkPositiveDimension(override["widthMm"], `${opath}.widthMm`, errors, "override widthMm");
            }
            if (override["heightMm"] !== undefined) {
              checkPositiveDimension(override["heightMm"], `${opath}.heightMm`, errors, "override heightMm");
            }
          });
        }
      }
    });
    checkIdList(variantIds, `${basePath}.variants`, errors, "variant");
  }

  const calibrations = value["calibrations"];
  const calibrationVersions = new Map<string, Set<string>>();
  if (!Array.isArray(calibrations) || calibrations.length < 1) {
    fail(errors, "bad-shape", `${basePath}.calibrations`, "product needs at least 1 calibration");
  } else {
    const ids: string[] = [];
    calibrations.forEach((entry: unknown, i: number) => {
      const path = `${basePath}.calibrations[${i}]`;
      if (!isRecord(entry)) {
        fail(errors, "bad-shape", path, "calibration must be an object");
        return;
      }
      const id = entry["id"];
      const version = entry["version"];
      if (!isNonEmptyString(id) || !isNonEmptyString(version)) {
        fail(errors, "bad-shape", path, "calibration needs non-empty id and version strings");
        return;
      }
      ids.push(id);
      let versions = calibrationVersions.get(id);
      if (versions === undefined) {
        versions = new Set<string>();
        calibrationVersions.set(id, versions);
      }
      versions.add(version);
    });
    checkIdList(ids, `${basePath}.calibrations`, errors, "calibration");
  }

  const regions = value["regions"];
  const regionIds: string[] = [];
  if (!Array.isArray(regions) || regions.length < 1) {
    fail(errors, "bad-shape", `${basePath}.regions`, "product needs at least 1 region");
  } else {
    regions.forEach((region: unknown, i: number) => {
      const path = `${basePath}.regions[${i}]`;
      if (!isRecord(region)) {
        fail(errors, "bad-shape", path, "region must be an object");
        return;
      }
      const id = region["id"];
      if (!isNonEmptyString(id)) {
        fail(errors, "bad-shape", `${path}.id`, "region id must be a non-empty string");
        return;
      }
      regionIds.push(id);
      validateRegionFrame(region["frame"], `${path}.frame`, errors);
      validateCalibrationRef(region["calibrationRef"], `${path}.calibrationRef`, errors, calibrationVersions);
      checkPolygon(region["safeArea"], `${path}.safeArea`, errors, "safeArea", "bad-safe-area");
      const exclusions = region["exclusions"];
      if (exclusions !== undefined) {
        if (!Array.isArray(exclusions)) {
          fail(errors, "bad-shape", `${path}.exclusions`, "exclusions must be an array of polygons");
        } else {
          exclusions.forEach((polygon: unknown, k: number) => {
            checkPolygon(polygon, `${path}.exclusions[${k}]`, errors, "exclusion", "bad-polygon");
          });
        }
      }
      checkStringList(region["allowedMethods"], `${path}.allowedMethods`, errors, "allowedMethods", 1);
    });
    checkIdList(regionIds, `${basePath}.regions`, errors, "region");
  }

  const regionIdSet = new Set<string>(regionIds);
  if (Array.isArray(variants)) {
    variants.forEach((variant: unknown, i: number) => {
      if (!isRecord(variant) || !isNonEmptyString(variant["id"])) return;
      const path = `${basePath}.variants[${i}]`;
      const regionIdsValue = variant["regionIds"];
      if (Array.isArray(regionIdsValue)) {
        regionIdsValue.forEach((regionId: unknown, k: number) => {
          if (
            isNonEmptyString(regionId) &&
            !regionIdSet.has(regionId)
          ) {
            fail(
              errors,
              "dangling-ref",
              `${path}.regionIds[${k}]`,
              `variant "${variant["id"] as string}" references unknown region "${regionId}"`,
            );
          }
        });
      }
      const overrides = variant["placementOverrides"];
      if (Array.isArray(overrides)) {
        overrides.forEach((override: unknown, k: number) => {
          if (
            isRecord(override) &&
            isNonEmptyString(override["regionId"]) &&
            !regionIdSet.has(override["regionId"] as string)
          ) {
            fail(
              errors,
              "dangling-ref",
              `${path}.placementOverrides[${k}].regionId`,
              `placementOverride references unknown region "${override["regionId"] as string}"`,
            );
          }
        });
      }
    });
  }
  return errors;
}

/** Validate a single product definition (contract first, then semantics). */
export function validateProduct(product: unknown): ValidationResult {
  const errors = checkProductContract(product);
  errors.push(...validateProductAt(product, "product"));
  return { ok: errors.length === 0, errors };
}

function validateLogoAt(value: unknown, basePath: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isRecord(value)) {
    fail(errors, "bad-shape", basePath, "logo must be an object");
    return errors;
  }
  checkVersion(value["schemaVersion"], `${basePath}.schemaVersion`, errors);
  if (!isNonEmptyString(value["id"])) {
    fail(errors, "bad-shape", `${basePath}.id`, "logo id must be a non-empty string");
  }
  const role = value["role"];
  if (role !== undefined && (typeof role !== "string" || ASSET_ROLE_SET[role] !== true)) {
    fail(errors, "bad-shape", `${basePath}.role`, `logo role must be one of ${ROLE_LABEL}`);
  }
  for (const dim of ["knownWidthMm", "knownHeightMm"] as const) {
    if (value[dim] !== undefined) {
      checkPositiveDimension(value[dim], `${basePath}.${dim}`, errors, `logo ${dim}`);
    }
  }
  const assets = value["assets"];
  if (!Array.isArray(assets) || assets.length < 1) {
    fail(errors, "bad-shape", `${basePath}.assets`, "logo needs at least 1 asset");
    return errors;
  }
  assets.forEach((asset: unknown, i: number) => {
    const path = `${basePath}.assets[${i}]`;
    if (!isRecord(asset)) {
      fail(errors, "bad-shape", path, "asset must be an object");
      return;
    }
    const uri = asset["uri"];
    if (!isNonEmptyString(uri)) {
      fail(errors, "bad-shape", `${path}.uri`, "asset uri must be a non-empty string");
    } else {
      checkAssetUri(uri, `${path}.uri`, errors);
    }
    const assetRole: unknown = asset["role"];
    if (typeof assetRole !== "string" || ASSET_ROLE_SET[assetRole] !== true) {
      fail(errors, "bad-shape", `${path}.role`, `asset role must be one of ${ROLE_LABEL}`);
    }
    if (!isNonEmptyString(asset["mediaType"])) {
      fail(errors, "bad-shape", `${path}.mediaType`, "asset mediaType must be a non-empty string");
    }
    if (asset["sha256Hex"] !== undefined) {
      checkDigestShape(asset["sha256Hex"], `${path}.sha256Hex`, errors);
    }
    if (asset["widthPx"] !== undefined) {
      checkPositiveDimension(asset["widthPx"], `${path}.widthPx`, errors, "asset widthPx");
    }
    if (asset["heightPx"] !== undefined) {
      checkPositiveDimension(asset["heightPx"], `${path}.heightPx`, errors, "asset heightPx");
    }
  });
  return errors;
}

/** Validate a logo list. Empty is valid (a draft may carry no artwork yet). */
export function validateLogos(logos: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!Array.isArray(logos)) {
    fail(errors, "bad-shape", "logos", "logos must be an array");
    return { ok: false, errors };
  }
  const ids: string[] = [];
  logos.forEach((logo: unknown, i: number) => {
    errors.push(...checkLogoContract(logo));
    errors.push(...validateLogoAt(logo, `logos[${i}]`));
    if (isRecord(logo) && isNonEmptyString(logo["id"])) {
      ids.push(logo["id"]);
    }
  });
  checkIdList(ids, "logos", errors, "logo");
  return { ok: errors.length === 0, errors };
}

function validateConfirmationShape(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (!isRecord(value)) {
    fail(errors, "bad-shape", path, "confirmation must be an object");
    return;
  }
  if (!Number.isInteger(value["revision"]) || (value["revision"] as number) < 1) {
    fail(errors, "bad-revision", `${path}.revision`, "confirmation revision must be an integer >= 1");
  }
  checkDigestShape(value["digest"], `${path}.digest`, errors);
  if (!isNonEmptyString(value["confirmedBy"])) {
    fail(errors, "bad-shape", `${path}.confirmedBy`, "confirmedBy must be a non-empty string");
  }
  if (!isNonEmptyString(value["confirmedAt"])) {
    fail(errors, "bad-shape", `${path}.confirmedAt`, "confirmedAt must be a non-empty string");
  }
}

function validateReviewShape(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (!isRecord(value)) {
    fail(errors, "bad-shape", path, "review must be an object");
    return;
  }
  if (!Number.isInteger(value["revision"]) || (value["revision"] as number) < 1) {
    fail(errors, "bad-revision", `${path}.revision`, "review revision must be an integer >= 1");
  }
  checkDigestShape(value["digest"], `${path}.digest`, errors);
  const decision: unknown = value["decision"];
  if (typeof decision !== "string" || REVIEW_DECISIONS.indexOf(decision as (typeof REVIEW_DECISIONS)[number]) < 0) {
    fail(errors, "bad-shape", `${path}.decision`, "review decision must be one of pending|approved|changesRequested");
  }
  if (!isNonEmptyString(value["reviewer"])) {
    fail(errors, "bad-shape", `${path}.reviewer`, "reviewer must be a non-empty string");
  }
  if (!isNonEmptyString(value["at"])) {
    fail(errors, "bad-shape", `${path}.at`, "review at must be a non-empty string");
  }
  if (value["note"] !== undefined && typeof value["note"] !== "string") {
    fail(errors, "bad-shape", `${path}.note`, "review note must be a string");
  }
}

function validatePlacement(
  value: unknown,
  path: string,
  errors: ValidationError[],
  logoIds: Set<string>,
  product: ProductIndex | undefined,
  productId: string,
  variantId: string,
  regions: Map<string, RegionIndex>,
): void {
  if (!isRecord(value)) {
    fail(errors, "bad-shape", path, "placement must be an object");
    return;
  }
  if ("xMm" in value || "yMm" in value) {
    fail(
      errors,
      "bad-shape",
      path,
      "flat xMm/yMm is not supported; use nested pos { xMm, yMm }",
    );
  }
  const logoId = value["logoId"];
  if (!isNonEmptyString(logoId)) {
    fail(errors, "bad-shape", `${path}.logoId`, "logoId must be a non-empty string");
  } else if (!logoIds.has(logoId)) {
    fail(errors, "dangling-ref", `${path}.logoId`, `placement references unknown logo "${logoId}"`);
  }
  const regionId = value["regionId"];
  const region: RegionIndex | undefined =
    isNonEmptyString(regionId) ? regions.get(regionId) : undefined;
  if (!isNonEmptyString(regionId)) {
    fail(errors, "bad-shape", `${path}.regionId`, "regionId must be a non-empty string");
  } else if (region === undefined) {
    fail(
      errors,
      "dangling-ref",
      `${path}.regionId`,
      `placement references unknown region "${regionId}" for product "${productId}"`,
    );
  }
  if (product !== undefined && isNonEmptyString(regionId) && region !== undefined) {
    const supported = product.variantRegions.get(variantId);
    if (supported !== undefined && !supported.has(regionId)) {
      fail(
        errors,
        "unsupported-region-for-variant",
        `${path}.regionId`,
        `region "${regionId}" is not supported by variant "${variantId}"`,
      );
    }
  }
  const method = value["method"];
  if (!isNonEmptyString(method)) {
    fail(errors, "bad-shape", `${path}.method`, "method must be a non-empty string");
  } else if (region !== undefined && !region.allowedMethods.has(method)) {
    fail(
      errors,
      "unsupported-method",
      `${path}.method`,
      `method "${method}" is not in region "${regionId as string}" allowedMethods`,
    );
  }
  const pos = value["pos"];
  if (!isRecord(pos)) {
    fail(errors, "bad-shape", `${path}.pos`, "pos must be an object { xMm, yMm }");
  } else {
    if (!isFiniteNumber(pos["xMm"]) || !isFiniteNumber(pos["yMm"])) {
      fail(errors, "nonfinite-number", `${path}.pos`, "pos xMm/yMm must be finite numbers");
    }
  }
  checkPositiveDimension(value["widthMm"], `${path}.widthMm`, errors, "widthMm");
  checkPositiveDimension(value["heightMm"], `${path}.heightMm`, errors, "heightMm");
  const rotation = value["rotationDeg"];
  if (typeof rotation !== "number") {
    fail(errors, "bad-rotation", `${path}.rotationDeg`, "rotationDeg must be a number");
  } else if (!Number.isFinite(rotation)) {
    fail(errors, "bad-rotation", `${path}.rotationDeg`, "rotationDeg must be finite");
  } else if (!(rotation > -180 && rotation <= 180)) {
    fail(
      errors,
      "bad-rotation",
      `${path}.rotationDeg`,
      "rotationDeg must be in (-180, 180] (clockwise-positive facing the region)",
    );
  }
  if (value["id"] !== undefined && !isNonEmptyString(value["id"])) {
    fail(errors, "bad-shape", `${path}.id`, "placement id must be a non-empty string");
  }
  if (value["instructions"] !== undefined && typeof value["instructions"] !== "string") {
    fail(errors, "bad-shape", `${path}.instructions`, "placement instructions must be a string");
  }
}

/**
 * Validate a full project document, optionally against an issued baseline.
 * Zero placements valid; repeated same logoId valid.
 */
export function validateProject(project: unknown, baseline?: IssuedBaseline): ValidationResult {
  const errors: ValidationError[] = checkProjectContract(project);
  if (!isRecord(project)) {
    fail(errors, "bad-shape", "project", "project must be an object");
    return { ok: false, errors };
  }
  checkVersion(project["schemaVersion"], "schemaVersion", errors);
  if (!isNonEmptyString(project["projectId"])) {
    fail(errors, "bad-shape", "projectId", "projectId must be a non-empty string");
  }
  const revision = project["revision"];
  const revisionOk = Number.isInteger(revision) && (revision as number) >= 1;
  if (!revisionOk) {
    fail(errors, "bad-revision", "revision", "revision must be an integer >= 1");
  }
  if (project["synthetic"] !== undefined && typeof project["synthetic"] !== "boolean") {
    fail(errors, "bad-shape", "synthetic", "synthetic must be a boolean");
  }
  if (project["description"] !== undefined && typeof project["description"] !== "string") {
    fail(errors, "bad-shape", "description", "description must be a string");
  }
  if (project["instructions"] !== undefined && typeof project["instructions"] !== "string") {
    fail(errors, "bad-shape", "instructions", "instructions must be a string");
  }

  const productIds: string[] = [];
  const productIndexes = new Map<string, ProductIndex>();
  const products = project["products"];
  if (!Array.isArray(products) || products.length < 1) {
    fail(errors, "bad-shape", "products", "project needs at least 1 product snapshot");
  } else {
    products.forEach((product: unknown, i: number) => {
      const path = `products[${i}]`;
      errors.push(...validateProductAt(product, path));
      if (isRecord(product) && isNonEmptyString(product["id"])) {
        productIds.push(product["id"]);
        const variantRegions = new Map<string, Set<string>>();
        const variants = product["variants"];
        if (Array.isArray(variants)) {
          for (const variant of variants) {
            if (isRecord(variant) && isNonEmptyString(variant["id"])) {
              const regionIds = variant["regionIds"];
              variantRegions.set(
                variant["id"],
                Array.isArray(regionIds)
                  ? new Set<string>(regionIds.filter(isNonEmptyString))
                  : new Set<string>(),
              );
            }
          }
        }
        productIndexes.set(product["id"], { path, variantRegions });
      }
    });
    checkIdList(productIds, "products", errors, "product");
  }

  const logoIds = new Set<string>();
  const logos = project["logos"];
  if (!Array.isArray(logos)) {
    fail(errors, "bad-shape", "logos", "logos must be an array");
  } else {
    const ids: string[] = [];
    logos.forEach((logo: unknown, i: number) => {
      errors.push(...validateLogoAt(logo, `logos[${i}]`));
      if (isRecord(logo) && isNonEmptyString(logo["id"])) {
        ids.push(logo["id"]);
        logoIds.add(logo["id"]);
      }
    });
    checkIdList(ids, "logos", errors, "logo");
  }

  const configurations = project["configurations"];
  if (!Array.isArray(configurations)) {
    fail(errors, "bad-shape", "configurations", "configurations must be an array");
  } else {
    const configIds: string[] = [];
    configurations.forEach((configuration: unknown, i: number) => {
      const path = `configurations[${i}]`;
      if (!isRecord(configuration)) {
        fail(errors, "bad-shape", path, "configuration must be an object");
        return;
      }
      const configId = configuration["id"];
      if (!isNonEmptyString(configId)) {
        fail(errors, "bad-shape", `${path}.id`, "configuration id must be a non-empty string");
      } else {
        configIds.push(configId);
      }
      const productId = configuration["productId"];
      const product: ProductIndex | undefined =
        isNonEmptyString(productId) ? productIndexes.get(productId) : undefined;
      if (!isNonEmptyString(productId)) {
        fail(errors, "bad-shape", `${path}.productId`, "productId must be a non-empty string");
      } else if (product === undefined) {
        fail(errors, "dangling-ref", `${path}.productId`, `configuration references unknown product "${productId}"`);
      }
      const variantId = configuration["variantId"];
      if (!isNonEmptyString(variantId)) {
        fail(errors, "bad-shape", `${path}.variantId`, "variantId must be a non-empty string");
      } else if (product !== undefined && !product.variantRegions.has(variantId)) {
        fail(
          errors,
          "dangling-ref",
          `${path}.variantId`,
          `configuration references unknown variant "${variantId}" for product "${productId as string}"`,
        );
      }
      const regions = new Map<string, RegionIndex>();
      if (product !== undefined && Array.isArray(products)) {
        const productDoc: unknown = products.find(
          (entry: unknown) => isRecord(entry) && entry["id"] === productId,
        );
        if (isRecord(productDoc) && Array.isArray(productDoc["regions"])) {
          for (const region of productDoc["regions"] as unknown[]) {
            if (isRecord(region) && isNonEmptyString(region["id"])) {
              const allowed = region["allowedMethods"];
              regions.set(region["id"], {
                path,
                allowedMethods: new Set<string>(
                  Array.isArray(allowed) ? (allowed as unknown[]).filter(isNonEmptyString) : [],
                ),
              });
            }
          }
        }
      }
      const placements = configuration["placements"];
      if (!Array.isArray(placements)) {
        fail(errors, "bad-shape", `${path}.placements`, "placements must be an array (zero placements valid)");
        return;
      }
      const placementIds: string[] = [];
      placements.forEach((placement: unknown, j: number) => {
        validatePlacement(
          placement,
          `${path}.placements[${j}]`,
          errors,
          logoIds,
          product,
          isNonEmptyString(productId) ? productId : "",
          isNonEmptyString(variantId) ? variantId : "",
          regions,
        );
        if (isRecord(placement) && isNonEmptyString(placement["id"])) {
          placementIds.push(placement["id"]);
        }
      });
      checkIdList(placementIds, `${path}.placements`, errors, "placement");
    });
    checkIdList(configIds, "configurations", errors, "configuration");
  }

  const confirmation = project["confirmation"];
  if (confirmation !== undefined) {
    validateConfirmationShape(confirmation, "confirmation", errors);
    if (
      isRecord(confirmation) &&
      Number.isInteger(confirmation["revision"]) &&
      revisionOk &&
      confirmation["revision"] !== revision
    ) {
      fail(
        errors,
        "confirmation-mismatch",
        "confirmation.revision",
        "confirmation revision must equal the current project revision (content changes invalidate confirmation)",
      );
    }
  }
  const history = project["history"];
  if (history !== undefined) {
    if (!Array.isArray(history)) {
      fail(errors, "bad-shape", "history", "history must be an array");
    } else {
      history.forEach((entry: unknown, i: number) => {
        validateConfirmationShape(entry, `history[${i}]`, errors);
      });
    }
  }
  if (project["review"] !== undefined) {
    validateReviewShape(project["review"], "review", errors);
  }
  const reviewHistory = project["reviewHistory"];
  if (reviewHistory !== undefined) {
    if (!Array.isArray(reviewHistory)) {
      fail(errors, "bad-shape", "reviewHistory", "reviewHistory must be an array");
    } else {
      reviewHistory.forEach((entry: unknown, i: number) => {
        validateReviewShape(entry, `reviewHistory[${i}]`, errors);
      });
    }
  }
  if (project["issuedBaselineHash"] !== undefined) {
    checkDigestShape(project["issuedBaselineHash"], "issuedBaselineHash", errors);
  }

  if (baseline !== undefined) {
    errors.push(...checkAgainstBaseline(project, baseline).errors);
  }
  return { ok: errors.length === 0, errors };
}

export type { ValidationError, ValidationResult };
