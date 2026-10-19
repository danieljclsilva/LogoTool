/**
 * Inspector-to-Builder bridge — pure kernel converting a validated inspector
 * calibration/region-area export into a prepared product definition usable by
 * the Builder (`createProjectFromDefinitions`).
 *
 * Pure TypeScript only: no DOM, Node, Three.js, React, timestamps, randomness,
 * or network. Never mutates inputs. Deterministic: identical inputs yield
 * byte-identical outputs. JSON-safe output (plain data, finite numbers).
 *
 * Authority model:
 * - The area bundle is parsed through the EXISTING restore contract
 *   (`parseAreaBundleRestore`): exact envelope-version match, exact asset-hash
 *   match, structural validation through the existing kernels, and a locally
 *   recomputed uniform-scale fit. Imported fit/approval/status flags are never
 *   trusted and never copied into the product.
 * - Every caller-supplied label is explicit: there are no invented defaults.
 *   Missing/blank product ids, kinds, variant ids, frame origins, axis
 *   labels, or method lists fail instead of silently defaulting.
 * - Production approval is never conferred: the calibration description marks
 *   the fit as inspector-derived, provisional, and pending human review.
 * - Failures are atomic: any malformed/stale/mismatched input yields
 *   `{ ok: false, errors }` with no partial product.
 *
 * Limitations (also reported in every sidecar):
 * - Planar-only mapping: region geometry applies to the authored planar
 *   frame in millimetres. Curved/3D surface mapping is out of scope: this
 *   bridge carries no mesh, UV, or deformation data, and downstream placements
 *   apply to the planar frame, not to a 3D garment surface.
 * - Uniform isotropic scale only (inherited from the calibration kernel).
 * - The product carries no logos: 0..N logos attach downstream by
 *   logoId/regionId; the product only constrains placement frames.
 */

import { fitUniformScale } from "../calibration/index.js";
import {
  snapshotEvidence,
  stableStringify,
} from "../calibration-session/index.js";
import { isRecord } from "../guards.js";
import { BUILDER_LIMITS } from "../project-builder/index.js";
import { AREA_BUNDLE_VERSION } from "../region-areas/index.js";
import {
  AREA_RESTORE_LIMITS,
  parseAreaBundleRestore,
} from "../region-areas-restore/index.js";
import {
  SCHEMA_VERSION,
  type Calibration,
  type PointMm,
  type ProductDefinition,
  type ProductKind,
  type Region,
  type ValidationError,
} from "../types.js";
import { validateProduct } from "../validate.js";

/** Provisional bridge sidecar version (bridge envelope, not canonical schema). */
export const INSPECTOR_BRIDGE_VERSION =
  "0.1.0-provisional-inspector-bridge" as const;

/**
 * Bridge limits. Reused where an existing kernel already owns the bound;
 * new caps are marked NEW below.
 * - `maxRegions`: reused from `AREA_RESTORE_LIMITS.maxRegions` (restore
 *   already enforces it; re-checked here for a clear bridge error path).
 * - `maxVariants`: reused from `BUILDER_LIMITS.maxConfigurations` (one
 *   downstream configuration per variant in `createProjectFromDefinitions`).
 * - `maxIdChars`: reused from `BUILDER_LIMITS.maxIdChars`.
 * - `maxTextChars` (NEW): free-text labels — origin descriptions, axis
 *   labels, names, calibration notes. Oversized input fails, never truncates.
 * - `maxMethodsPerRegion` (NEW): allowed-method entries per region.
 * - `maxSnapshotChars` (NEW): canonical evidence-snapshot string carried in
 *   the sidecar. Oversized input fails, never truncates.
 */
export const BRIDGE_LIMITS = {
  maxRegions: AREA_RESTORE_LIMITS.maxRegions,
  maxVariants: BUILDER_LIMITS.maxConfigurations,
  maxIdChars: BUILDER_LIMITS.maxIdChars,
  maxTextChars: 2048,
  maxMethodsPerRegion: 64,
  maxSnapshotChars: 262144,
  /**
   * NEW: total sidecar JSON ceiling. Matches the Builder intake bound
   * (`PREPARED_IMPORT_LIMITS.maxSidecarChars`) so conversion output is always
   * consumable: conversion fails visibly here instead of producing a file the
   * Builder must reject. Keep the two constants in agreement (pinned by test).
   */
  maxSidecarChars: 262144,
} as const;

const PRODUCT_KINDS: readonly ProductKind[] = [
  "upper-body",
  "lower-body",
  "full-body",
  "headwear",
  "other",
];

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface BridgeProductLabel {
  id: string;
  name?: string;
  kind: ProductKind;
}

export interface BridgeVariantLabel {
  id: string;
  name?: string;
  /**
   * Explicit subset of the converted region ids. When omitted, the variant
   * supports all converted regions. An explicit empty list is rejected.
   */
  regionIds?: string[];
}

export interface BridgeRegionAxesLabel {
  xPositive: string;
  yPositive: string;
}

export interface BridgeRegionLabel {
  name?: string;
  originDescription: string;
  axes: BridgeRegionAxesLabel;
  /** Explicit non-empty method list. Never defaulted. */
  allowedMethods: string[];
  /** Optional caller note folded into the provisional calibration description. */
  calibrationDescription?: string;
}

/**
 * All labels explicit, no invented defaults. `regions` must carry exactly
 * the converted region ids as keys — no missing, no extra entries.
 */
export interface BridgeLabels {
  product: BridgeProductLabel;
  variants: BridgeVariantLabel[];
  regions: Record<string, BridgeRegionLabel>;
}

export interface BridgeOptions {
  /** Full lowercase SHA-256 of the asset the bundle was authored against. */
  expectedAssetSha256: string;
}

export interface BridgeFitSummary {
  scaleMmPerUnit: number;
  measurementCount: number;
  maxResidualMm: number;
  inconsistent: boolean;
  toleranceMm: number;
  relativeTolerance: number;
  limitations: string[];
}

export interface BridgeRegionSidecar {
  regionId: string;
  frameId: string;
  /** Canonical `stableStringify(region)` the area record was bound to. */
  frameSnapshot: string;
  origin: { x: number; y: number; z: number };
  xAxis: { x: number; y: number; z: number };
  yAxis: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  mmPerModelUnit: number;
  offPlaneToleranceMm: number;
}

export interface ResolvedBridgeLabels {
  product: { id: string; name?: string; kind: ProductKind };
  variants: { id: string; name?: string; regionIds: string[] }[];
  regions: Record<string, BridgeRegionLabel>;
}

/** Everything the canonical schema cannot represent, JSON-safe + bounded. */
export interface BridgeSidecar {
  schemaVersion: typeof INSPECTOR_BRIDGE_VERSION;
  sourceBundleVersion: typeof AREA_BUNDLE_VERSION;
  /** Canonical evidence snapshot the fit was recomputed from (bounded). */
  evidenceSnapshot: string;
  fit: BridgeFitSummary;
  regions: BridgeRegionSidecar[];
  limitations: string[];
  /** The exact (resolved) labels used: omitted variant regionIds filled in. */
  labels: ResolvedBridgeLabels;
}

export type BuildPreparedProductResult =
  | { ok: true; product: ProductDefinition; sidecar: BridgeSidecar }
  | { ok: false; errors: ValidationError[] };

function fail(
  errors: ValidationError[],
  code: string,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasSurroundingWhitespace(value: string): boolean {
  return value !== value.trim();
}

/**
 * Strict JSON-safety guard for the unknown bundle input: rejects functions,
 * symbols, bigints, non-finite numbers, cycles, class instances, and
 * `undefined` inside arrays (which `JSON.stringify` would silently rewrite to
 * `null`). Plain-object `undefined` values are tolerated as absent (both this
 * module and the restore parser treat them as missing).
 */
function isJsonSafeInput(value: unknown, seen: Set<object>, depth: number): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (value === undefined) return true;
  if (typeof value !== "object") return false;
  if (depth > 64 || seen.has(value)) return false;
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      for (const entry of value) {
        if (entry === undefined) return false;
        if (!isJsonSafeInput(entry, seen, depth + 1)) return false;
      }
      return true;
    } finally {
      seen.delete(value);
    }
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  seen.add(value);
  try {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      if (!isJsonSafeInput(entry, seen, depth + 1)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

function checkLabelId(
  value: unknown,
  path: string,
  errors: ValidationError[],
  what: string,
): string | undefined {
  if (!isNonBlankString(value)) {
    fail(errors, "missing-label", path, `${what} must be a non-empty string (no invented defaults)`);
    return undefined;
  }
  if (value.length > BRIDGE_LIMITS.maxIdChars) {
    fail(
      errors,
      "label-too-long",
      path,
      `${what} exceeds ${BRIDGE_LIMITS.maxIdChars} characters`,
    );
    return undefined;
  }
  if (hasSurroundingWhitespace(value)) {
    fail(errors, "bad-label", path, `${what} must not have leading or trailing whitespace`);
    return undefined;
  }
  return value;
}

function checkLabelText(
  value: unknown,
  path: string,
  errors: ValidationError[],
  what: string,
): string | undefined {
  if (!isNonBlankString(value)) {
    fail(errors, "missing-label", path, `${what} must be a non-empty string (no invented defaults)`);
    return undefined;
  }
  if (value.length > BRIDGE_LIMITS.maxTextChars) {
    fail(
      errors,
      "label-too-long",
      path,
      `${what} exceeds ${BRIDGE_LIMITS.maxTextChars} characters`,
    );
    return undefined;
  }
  return value;
}

function checkOptionalName(
  value: unknown,
  path: string,
  errors: ValidationError[],
  what: string,
): string | undefined {
  if (value === undefined) return undefined;
  return checkLabelText(value, path, errors, what);
}

/** Prototype-safe assignment for caller-controlled keys. */
function setOwn(
  target: Record<string, BridgeRegionLabel>,
  key: string,
  value: BridgeRegionLabel,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function buildPreparedProductFromAreaBundle(
  input: unknown,
  labels: unknown,
  opts: { expectedAssetSha256: string },
): BuildPreparedProductResult {
  const errors: ValidationError[] = [];

  const expectedSha: unknown =
    typeof opts === "object" && opts !== null
      ? (opts as Record<string, unknown>)["expectedAssetSha256"]
      : undefined;
  if (typeof expectedSha !== "string" || !SHA256_HEX_PATTERN.test(expectedSha)) {
    fail(
      errors,
      "bad-asset-hash",
      "opts.expectedAssetSha256",
      "expectedAssetSha256 must be 64 lowercase hex characters",
    );
    return { ok: false, errors };
  }

  if (!isJsonSafeInput(input, new Set<object>(), 0)) {
    fail(
      errors,
      "bad-shape",
      "bundle",
      "area bundle input must be JSON-safe parsed data (finite numbers, no cycles/classes/functions)",
    );
    return { ok: false, errors };
  }
  let bundleText: string;
  try {
    const encoded = JSON.stringify(input);
    if (typeof encoded !== "string") {
      fail(errors, "bad-shape", "bundle", "area bundle input must serialize to a JSON object");
      return { ok: false, errors };
    }
    bundleText = encoded;
  } catch {
    fail(errors, "bad-shape", "bundle", "area bundle input is not serializable");
    return { ok: false, errors };
  }
  if (bundleText.length > AREA_RESTORE_LIMITS.maxChars) {
    fail(
      errors,
      "too-large",
      "bundle",
      `area bundle exceeds ${AREA_RESTORE_LIMITS.maxChars} characters`,
    );
    return { ok: false, errors };
  }

  const restored = parseAreaBundleRestore(bundleText, expectedSha);
  if (!restored.ok) {
    fail(errors, "bundle-rejected", "bundle", `area bundle rejected: ${restored.error}`);
    return { ok: false, errors };
  }
  const { evidence, fit, regions, areas } = restored;

  // Recompute the fit locally through the sole fit authority; the restored
  // fit is cross-checked but never trusted for output values.
  let recomputedScale = 0;
  let measurementCount = 0;
  try {
    const recomputed = fitUniformScale(evidence);
    recomputedScale = recomputed.scaleMmPerUnit;
    measurementCount = recomputed.perPair.length;
    if (
      recomputed.scaleMmPerUnit !== fit.scaleMmPerUnit ||
      recomputed.inconsistent !== fit.inconsistent ||
      recomputed.assetFullSha256 !== fit.assetFullSha256
    ) {
      fail(errors, "stale-fit", "bundle.session.fit", "recomputed fit does not match the restored bundle fit");
      return { ok: false, errors };
    }
    if (recomputed.inconsistent) {
      fail(errors, "inconsistent-fit", "bundle.session.fit", "calibration fit is inconsistent; cannot prepare a product");
      return { ok: false, errors };
    }
  } catch (e) {
    fail(
      errors,
      "bad-fit",
      "bundle.session.evidence",
      `calibration fit failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { ok: false, errors };
  }

  // ---- Labels (all explicit; every missing/blank label is an error). ----
  if (!isRecord(labels)) {
    fail(errors, "bad-shape", "labels", "labels must be an object");
    return { ok: false, errors };
  }

  const productValue = labels["product"];
  if (!isRecord(productValue)) {
    fail(errors, "missing-label", "labels.product", "labels.product must be an object");
    return { ok: false, errors };
  }
  const productId = checkLabelId(productValue["id"], "labels.product.id", errors, "labels.product.id");
  const productKindValue = productValue["kind"];
  let productKind: ProductKind | undefined;
  if (typeof productKindValue !== "string" || !PRODUCT_KINDS.includes(productKindValue as ProductKind)) {
    fail(
      errors,
      "missing-label",
      "labels.product.kind",
      "labels.product.kind must be one of upper-body|lower-body|full-body|headwear|other (no invented defaults)",
    );
  } else {
    productKind = productKindValue as ProductKind;
  }
  const productName = checkOptionalName(productValue["name"], "labels.product.name", errors, "labels.product.name");

  const variantsValue = labels["variants"];
  if (!Array.isArray(variantsValue)) {
    fail(errors, "missing-label", "labels.variants", "labels.variants must be a non-empty array (no invented defaults)");
    return { ok: false, errors };
  }
  if (variantsValue.length < 1) {
    fail(errors, "missing-label", "labels.variants", "at least 1 variant is required");
  }
  if (variantsValue.length > BRIDGE_LIMITS.maxVariants) {
    fail(
      errors,
      "too-many",
      "labels.variants",
      `at most ${BRIDGE_LIMITS.maxVariants} variants`,
    );
  }
  const seenVariantIds = new Set<string>();
  interface ParsedVariant {
    id: string;
    name?: string;
    regionIds?: string[];
  }
  const parsedVariants: ParsedVariant[] = [];
  variantsValue.forEach((entry: unknown, i: number) => {
    const path = `labels.variants[${i}]`;
    if (!isRecord(entry)) {
      fail(errors, "missing-label", path, "variant must be an object");
      parsedVariants.push({ id: "", regionIds: [] });
      return;
    }
    const id = checkLabelId(entry["id"], `${path}.id`, errors, "variant id");
    if (id !== undefined) {
      if (seenVariantIds.has(id)) {
        fail(errors, "duplicate-id", `${path}.id`, `duplicate variant id "${id}"`);
      } else {
        seenVariantIds.add(id);
      }
    }
    const name = checkOptionalName(entry["name"], `${path}.name`, errors, "variant name");
    let regionIds: string[] | undefined;
    const regionIdsValue = entry["regionIds"];
    if (regionIdsValue !== undefined) {
      if (!Array.isArray(regionIdsValue)) {
        fail(errors, "bad-label", `${path}.regionIds`, "variant regionIds must be an array of region ids when present");
      } else if (regionIdsValue.length < 1) {
        fail(errors, "bad-label", `${path}.regionIds`, "variant regionIds must list at least 1 region (omit to support all converted regions)");
      } else {
        const collected: string[] = [];
        const seen = new Set<string>();
        regionIdsValue.forEach((ref: unknown, k: number) => {
          const refId = checkLabelId(ref, `${path}.regionIds[${k}]`, errors, "variant region id");
          if (refId === undefined) return;
          if (seen.has(refId)) {
            fail(errors, "duplicate-id", `${path}.regionIds[${k}]`, `duplicate variant region id "${refId}"`);
            return;
          }
          seen.add(refId);
          collected.push(refId);
        });
        regionIds = collected;
      }
    }
    const parsed: ParsedVariant = { id: id ?? "" };
    if (name !== undefined) parsed.name = name;
    if (regionIds !== undefined) parsed.regionIds = regionIds;
    parsedVariants.push(parsed);
  });

  const regionsValue = labels["regions"];
  if (!isRecord(regionsValue)) {
    fail(errors, "missing-label", "labels.regions", "labels.regions must be an object keyed by region id");
    return { ok: false, errors };
  }
  const convertedIds = regions.map((r) => r.regionId);
  if (convertedIds.length > BRIDGE_LIMITS.maxRegions) {
    fail(errors, "too-many", "bundle.regions", `at most ${BRIDGE_LIMITS.maxRegions} regions`);
  }
  const convertedSet = new Set<string>(convertedIds);
  const labelEntries = Object.entries(regionsValue as Record<string, unknown>);
  const labelKeySet = new Set<string>(labelEntries.map(([key]) => key));
  for (const id of convertedIds) {
    if (!labelKeySet.has(id)) {
      fail(errors, "missing-label", `labels.regions.${id}`, `missing region label for converted region "${id}" (no invented defaults)`);
    }
  }
  for (const [key] of labelEntries) {
    if (!convertedSet.has(key)) {
      fail(errors, "unknown-region", `labels.regions.${key}`, `region label "${key}" has no matching converted region`);
    }
  }

  interface ParsedRegionLabel {
    name?: string;
    originDescription: string;
    xPositive: string;
    yPositive: string;
    allowedMethods: string[];
    calibrationDescription?: string;
  }
  const parsedRegionLabels = new Map<string, ParsedRegionLabel>();
  for (const [key, value] of labelEntries) {
    const path = `labels.regions.${key}`;
    if (!convertedSet.has(key) || !isRecord(value)) {
      if (convertedSet.has(key)) {
        fail(errors, "missing-label", path, `region label for "${key}" must be an object`);
      }
      continue;
    }
    const name = checkOptionalName(value["name"], `${path}.name`, errors, `region "${key}" name`);
    const originDescription = checkLabelText(
      value["originDescription"],
      `${path}.originDescription`,
      errors,
      `region "${key}" originDescription`,
    );
    const axesValue = value["axes"];
    let xPositive: string | undefined;
    let yPositive: string | undefined;
    if (!isRecord(axesValue)) {
      fail(errors, "missing-label", `${path}.axes`, `region "${key}" axes must be an object { xPositive, yPositive }`);
    } else {
      xPositive = checkLabelText(axesValue["xPositive"], `${path}.axes.xPositive`, errors, `region "${key}" axes.xPositive`);
      yPositive = checkLabelText(axesValue["yPositive"], `${path}.axes.yPositive`, errors, `region "${key}" axes.yPositive`);
    }
    const methodsValue = value["allowedMethods"];
    let allowedMethods: string[] | undefined;
    if (!Array.isArray(methodsValue)) {
      fail(
        errors,
        "missing-label",
        `${path}.allowedMethods`,
        `region "${key}" allowedMethods must be a non-empty explicit list (never defaulted)`,
      );
    } else if (methodsValue.length < 1) {
      fail(
        errors,
        "missing-label",
        `${path}.allowedMethods`,
        `region "${key}" allowedMethods must list at least 1 method (never defaulted)`,
      );
    } else if (methodsValue.length > BRIDGE_LIMITS.maxMethodsPerRegion) {
      fail(
        errors,
        "too-many",
        `${path}.allowedMethods`,
        `region "${key}" allowedMethods exceeds ${BRIDGE_LIMITS.maxMethodsPerRegion} entries`,
      );
    } else {
      const collected: string[] = [];
      const seen = new Set<string>();
      methodsValue.forEach((method: unknown, k: number) => {
        if (typeof method !== "string" || method.trim().length === 0) {
          fail(errors, "bad-label", `${path}.allowedMethods[${k}]`, `region "${key}" allowedMethods entries must be non-empty strings`);
          return;
        }
        if (method.length > BRIDGE_LIMITS.maxIdChars) {
          fail(errors, "label-too-long", `${path}.allowedMethods[${k}]`, `region "${key}" method exceeds ${BRIDGE_LIMITS.maxIdChars} characters`);
          return;
        }
        if (seen.has(method)) {
          fail(errors, "duplicate-id", `${path}.allowedMethods[${k}]`, `region "${key}" duplicate method "${method}"`);
          return;
        }
        seen.add(method);
        collected.push(method);
      });
      allowedMethods = collected;
    }
    const calibrationDescription = checkOptionalName(
      value["calibrationDescription"],
      `${path}.calibrationDescription`,
      errors,
      `region "${key}" calibrationDescription`,
    );
    if (
      originDescription !== undefined &&
      xPositive !== undefined &&
      yPositive !== undefined &&
      allowedMethods !== undefined
    ) {
      const parsed: ParsedRegionLabel = {
        originDescription,
        xPositive,
        yPositive,
        allowedMethods,
      };
      if (name !== undefined) parsed.name = name;
      if (calibrationDescription !== undefined) parsed.calibrationDescription = calibrationDescription;
      parsedRegionLabels.set(key, parsed);
    }
  }

  // Variant regionIds must be subsets of the converted region ids.
  const resolvedVariantRegions = new Map<string, string[]>();
  parsedVariants.forEach((variant, i) => {
    const path = `labels.variants[${i}].regionIds`;
    const resolved = variant.regionIds ?? [...convertedIds];
    if (variant.regionIds !== undefined) {
      variant.regionIds.forEach((ref, k) => {
        if (!convertedSet.has(ref)) {
          fail(errors, "unknown-region", `${path}[${k}]`, `variant "${variant.id}" references unknown region "${ref}"`);
        }
      });
    }
    resolvedVariantRegions.set(variant.id, resolved);
  });

  // One calibration entry: all converted regions share the restored evidence.
  const calibrationNotes = new Set<string>();
  for (const [key, parsed] of parsedRegionLabels) {
    if (parsed.calibrationDescription !== undefined) {
      if (calibrationNotes.size > 0 && !calibrationNotes.has(parsed.calibrationDescription)) {
        fail(
          errors,
          "conflicting-label",
          `labels.regions.${key}.calibrationDescription`,
          "regions sharing one calibration must carry identical calibrationDescription notes",
        );
      }
      calibrationNotes.add(parsed.calibrationDescription);
    }
  }

  if (errors.length > 0 || productId === undefined || productKind === undefined) {
    return { ok: false, errors };
  }

  // ---- Conversion: one Region per PlanarRegionRecord + RegionAreaRecord. ----
  const productRegions: Region[] = [];
  const sidecarRegions: BridgeRegionSidecar[] = [];
  for (const region of regions) {
    const areaPath = `bundle.areas.${region.regionId}`;
    if (!Object.hasOwn(areas, region.regionId)) {
      fail(errors, "stale-frame", areaPath, `region "${region.regionId}" has no matching area record`);
      continue;
    }
    const area = areas[region.regionId];
    if (area === undefined || area.regionId !== region.regionId || area.frameId !== region.frameId) {
      fail(errors, "stale-frame", areaPath, `region "${region.regionId}" area frame binding is stale`);
      continue;
    }
    let frameSnapshot: string;
    try {
      frameSnapshot = stableStringify(region);
    } catch {
      fail(errors, "stale-frame", areaPath, `region "${region.regionId}" frame snapshot is not serializable`);
      continue;
    }
    if (area.frameSnapshot !== frameSnapshot) {
      fail(errors, "stale-frame", `${areaPath}.frameSnapshot`, `region "${region.regionId}" frame snapshot is stale`);
      continue;
    }
    if (area.safePolygon === null) {
      fail(
        errors,
        "unconfigured-frame",
        `${areaPath}.safePolygon`,
        `region "${region.regionId}" has no safe polygon (unconfigured draft-only frame cannot host placements)`,
      );
      continue;
    }
    const label = parsedRegionLabels.get(region.regionId);
    if (label === undefined) {
      fail(errors, "missing-label", `labels.regions.${region.regionId}`, `missing region label for converted region "${region.regionId}"`);
      continue;
    }
    const toPoint = (p: { x: number; y: number }): PointMm => [p.x, p.y];
    const built: Region = {
      id: region.regionId,
      frame: {
        frameId: region.frameId,
        originDescription: label.originDescription,
        axes: { xPositive: label.xPositive, yPositive: label.yPositive },
      },
      calibrationRef: {
        calibrationId: evidence.calibrationId,
        version: evidence.provisionalVersion,
      },
      safeArea: area.safePolygon.map(toPoint),
      exclusions: area.exclusions.map((ex) => ex.polygon.map(toPoint)),
      allowedMethods: [...label.allowedMethods],
    };
    if (label.name !== undefined) {
      built.name = label.name;
    }
    productRegions.push(built);
    sidecarRegions.push({
      regionId: region.regionId,
      frameId: region.frameId,
      frameSnapshot,
      origin: { x: region.origin.x, y: region.origin.y, z: region.origin.z },
      xAxis: { x: region.xAxis.x, y: region.xAxis.y, z: region.xAxis.z },
      yAxis: { x: region.yAxis.x, y: region.yAxis.y, z: region.yAxis.z },
      normal: { x: region.normal.x, y: region.normal.y, z: region.normal.z },
      mmPerModelUnit: region.mmPerModelUnit,
      offPlaneToleranceMm: region.offPlaneToleranceMm,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const note = [...calibrationNotes][0];
  const calibrationDescription =
    `Inspector-derived provisional calibration "${evidence.calibrationId}" ` +
    `version "${evidence.provisionalVersion}"; uniform scale ${recomputedScale} mm ` +
    `per model unit over ${measurementCount} measurement(s) ` +
    `(max residual ${fit.maxResidualMm} mm); pending human review; ` +
    `never production-approved.` +
    (note !== undefined ? ` Inspector note: ${note}` : "");
  const calibration: Calibration = {
    id: evidence.calibrationId,
    version: evidence.provisionalVersion,
    description: calibrationDescription,
  };

  const productVariants = parsedVariants.map((variant) => {
    const resolved = resolvedVariantRegions.get(variant.id) ?? [...convertedIds];
    const out: { id: string; name?: string; regionIds: string[] } = {
      id: variant.id,
      regionIds: [...resolved],
    };
    if (variant.name !== undefined) out.name = variant.name;
    return out;
  });

  const product: ProductDefinition = {
    schemaVersion: SCHEMA_VERSION,
    id: productId,
    kind: productKind,
    variants: productVariants,
    regions: productRegions,
    calibrations: [calibration],
  };
  if (productName !== undefined) {
    product.name = productName;
  }

  // Authority: the prepared definition must satisfy the canonical contract.
  const contract = validateProduct(product);
  if (!contract.ok) {
    return { ok: false, errors: contract.errors };
  }

  // ---- Sidecar (JSON-safe, deterministic key order, bounded). ----
  let evidenceSnapshot: string;
  try {
    evidenceSnapshot = snapshotEvidence(evidence);
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: "bad-shape",
          path: "bundle.session.evidence",
          message: "calibration evidence snapshot is not serializable",
        },
      ],
    };
  }
  if (evidenceSnapshot.length > BRIDGE_LIMITS.maxSnapshotChars) {
    return {
      ok: false,
      errors: [
        {
          code: "too-large",
          path: "bundle.session.evidence",
          message: `evidence snapshot exceeds ${BRIDGE_LIMITS.maxSnapshotChars} characters`,
        },
      ],
    };
  }

  const resolvedRegions: Record<string, BridgeRegionLabel> = {};
  const sortedRegionKeys = [...parsedRegionLabels.keys()].sort();
  for (const key of sortedRegionKeys) {
    const parsed = parsedRegionLabels.get(key);
    if (parsed === undefined) continue;
    const label: BridgeRegionLabel = {
      originDescription: parsed.originDescription,
      axes: { xPositive: parsed.xPositive, yPositive: parsed.yPositive },
      allowedMethods: [...parsed.allowedMethods],
    };
    if (parsed.name !== undefined) label.name = parsed.name;
    if (parsed.calibrationDescription !== undefined) {
      label.calibrationDescription = parsed.calibrationDescription;
    }
    setOwn(resolvedRegions, key, label);
  }
  const resolvedProduct: { id: string; name?: string; kind: ProductKind } = {
    id: productId,
    kind: productKind,
  };
  if (productName !== undefined) {
    resolvedProduct.name = productName;
  }
  const resolvedLabels: ResolvedBridgeLabels = {
    product: resolvedProduct,
    variants: productVariants.map((v) => {
      const out: { id: string; name?: string; regionIds: string[] } = {
        id: v.id,
        regionIds: [...v.regionIds],
      };
      if (v.name !== undefined) out.name = v.name;
      return out;
    }),
    regions: resolvedRegions,
  };

  const sidecar: BridgeSidecar = {
    schemaVersion: INSPECTOR_BRIDGE_VERSION,
    sourceBundleVersion: AREA_BUNDLE_VERSION,
    evidenceSnapshot,
    fit: {
      scaleMmPerUnit: recomputedScale,
      measurementCount,
      maxResidualMm: fit.maxResidualMm,
      inconsistent: fit.inconsistent,
      toleranceMm: fit.toleranceMm,
      relativeTolerance: fit.relativeTolerance,
      limitations: [...fit.limitations],
    },
    regions: sidecarRegions,
    limitations: [
      "Bridge output is a provisional prepared definition; not production-approved and pending human review.",
      "Planar-only mapping: region geometry applies to the authored planar frame in millimetres.",
      "Curved/3D surface mapping is out of scope: this bridge carries no mesh, UV, or deformation data; downstream placements apply to the planar frame, not to a 3D garment surface.",
      "Uniform isotropic scale only: a single anchor-pair distance cannot establish anisotropy, shear, or rotation.",
      `All listed variants share one inspector calibration derived from evidence product "${evidence.product}" variant "${evidence.variant}"; variants are setup groupings, not independently measured calibrations. Independent physical calibration per variant remains unvalidated.`,
      "Product carries no logos: 0..N logos attach downstream by logoId/regionId; the product only constrains placement frames.",
    ],
    labels: resolvedLabels,
  };

  let sidecarText: string;
  try {
    sidecarText = JSON.stringify(sidecar);
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: "bad-shape",
          path: "sidecar",
          message: "converted sidecar is not serializable",
        },
      ],
    };
  }
  if (sidecarText.length > BRIDGE_LIMITS.maxSidecarChars) {
    return {
      ok: false,
      errors: [
        {
          code: "too-large",
          path: "sidecar",
          message: `converted sidecar exceeds ${BRIDGE_LIMITS.maxSidecarChars} characters (Builder intake bound); split the bundle or shorten labels`,
        },
      ],
    };
  }

  return { ok: true, product, sidecar };
}
