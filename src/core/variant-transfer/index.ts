/**
 * Provisional pure variant-transfer kernel — deterministic, immutable transfer
 * of 0..N logo draft placements across explicitly supplied source/target
 * variant planar region contexts. Pending-review draft output only; never
 * approved. Full scope stays provisional while Phase 1 discovery is incomplete.
 */

import type { CalibrationEvidence } from "../calibration/index.js";
import { stableStringify } from "../calibration-session/index.js";
import type { PlanarRegionRecord } from "../planar-region/index.js";
import {
  buildAreaBundle,
  type AreasMap,
} from "../region-areas/index.js";
import {
  buildPlacementBundle,
  validateDraftLogo,
  validateDraftPlacement,
  type DraftLogo,
  type DraftPlacement,
  type LogosMap,
  type PlacementBundle,
  type PlacementsMap,
} from "../logo-placements/index.js";

/** Provisional variant-transfer envelope version. */
export const VARIANT_TRANSFER_VERSION =
  "0.1.0-provisional-variant-transfer" as const;

/** Provisional draft guards (pending review): bounds before kernel work. */
export const VARIANT_TRANSFER_LIMITS = {
  maxPlacements: 256,
  maxLogos: 64,
  maxRegions: 128,
  maxRules: 128,
  maxOverrides: 256,
  maxIdLength: 256,
  maxDimMm: 100000,
  maxCoordMm: 1000000,
} as const;

/** One side (source or target) of a variant transfer. */
export interface VariantTransferContext {
  product: string;
  variant: string;
  evidence: CalibrationEvidence;
  fit: { scaleMmPerUnit: number; inconsistent: boolean; assetFullSha256: string };
  regions: PlanarRegionRecord[];
  areas: AreasMap;
  evidenceSnapshot: string;
}

/** Caller-supplied mm reference frame for normalized-position mapping. */
export interface ReferenceRect {
  originXmm: number;
  originYmm: number;
  widthMm: number;
  heightMm: number;
}

export type TransferRuleStrategy = "absolute-position" | "normalized-position";

export interface RegionTransferRule {
  sourceRegionId: string;
  targetRegionId: string;
  strategy: TransferRuleStrategy;
  sourceFrameConvention: string;
  targetFrameConvention: string;
  sourceRef?: ReferenceRect;
  targetRef?: ReferenceRect;
  /** Default false; true allowed ONLY with normalized-position. */
  proportionalDimensions?: boolean;
}

export interface PlacementTransferOverride {
  placementId: string;
  targetRegionId: string;
  xMm: number;
  yMm: number;
  /** Default: copy source. */
  widthMm?: number;
  /** Default: copy source. */
  heightMm?: number;
  /** Default: copy source. */
  rotationDeg?: number;
}

export interface TransferRequest {
  /** When present must equal VARIANT_TRANSFER_VERSION, else fail. */
  transferVersion?: string;
  source: VariantTransferContext;
  sourceLogos: LogosMap;
  sourcePlacements: PlacementsMap;
  target: VariantTransferContext;
  rules: RegionTransferRule[];
  overrides?: PlacementTransferOverride[];
}

export type TransferStrategyUsed = TransferRuleStrategy | "override";

export interface VariantTransferRecord {
  sourcePlacementId: string;
  targetPlacementId: string;
  sourceRegionId: string;
  targetRegionId: string;
  strategy: TransferStrategyUsed;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
}

export interface VariantTransferSourceInfo {
  product: string;
  variant: string;
  evidenceSnapshot: string;
  regionIds: string[];
  frameIds: string[];
  placementIds: string[];
}

export interface VariantTransferBundle {
  schemaVersion: typeof VARIANT_TRANSFER_VERSION;
  pendingReview: true;
  productionApproved: false;
  source: VariantTransferSourceInfo;
  target: PlacementBundle;
  transfers: VariantTransferRecord[];
  limitations: string[];
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= VARIANT_TRANSFER_LIMITS.maxIdLength
  );
}

/** Copy finite JSON data without invoking toJSON or losing invalid values. */
function copyInput(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error("non-JSON value");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("non-JSON object");
  }
  if (ancestors.has(value)) throw new Error("cyclic input");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, (entry: unknown) => copyInput(entry, ancestors));
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) out[key] = copyInput(entry, ancestors);
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function copyLogo(logo: DraftLogo): DraftLogo {
  const out: DraftLogo = { id: logo.id, name: logo.name };
  if (logo.widthPx !== undefined) out.widthPx = logo.widthPx;
  if (logo.heightPx !== undefined) out.heightPx = logo.heightPx;
  return out;
}

function copyPlacement(placement: DraftPlacement): DraftPlacement {
  return {
    id: placement.id,
    logoId: placement.logoId,
    regionId: placement.regionId,
    xMm: placement.xMm,
    yMm: placement.yMm,
    widthMm: placement.widthMm,
    heightMm: placement.heightMm,
    rotationDeg: placement.rotationDeg,
  };
}

/**
 * Null-prototype-safe map copies with fresh values, so ids such as
 * "__proto__" round-trip as real keys instead of prototype assignments.
 */
function copyLogos(logos: LogosMap): LogosMap {
  const out: LogosMap = Object.create(null);
  for (const [key, logo] of Object.entries(logos)) {
    out[key] = copyLogo(logo);
  }
  return out;
}

function copyPlacements(placements: PlacementsMap): PlacementsMap {
  const out: PlacementsMap = Object.create(null);
  for (const [key, placement] of Object.entries(placements)) {
    out[key] = copyPlacement(placement);
  }
  return out;
}


function checkReferenceRect(
  value: unknown,
  label: string,
): { ok: true; ref: ReferenceRect } | { ok: false; error: string } {
  if (!isPlainObject(value)) return err(`${label} must be an object`);
  for (const key of ["originXmm", "originYmm"] as const) {
    const coord: unknown = value[key];
    if (!isFiniteNumber(coord)) {
      return err(`${label} ${key} must be a finite number`);
    }
    if (Math.abs(coord) > VARIANT_TRANSFER_LIMITS.maxCoordMm) {
      return err(
        `${label} ${key} exceeds ${VARIANT_TRANSFER_LIMITS.maxCoordMm} mm in magnitude`,
      );
    }
  }
  for (const key of ["widthMm", "heightMm"] as const) {
    const dim: unknown = value[key];
    if (!isFiniteNumber(dim) || !(dim > 0)) {
      return err(`${label} ${key} must be a finite number > 0`);
    }
    if (dim > VARIANT_TRANSFER_LIMITS.maxDimMm) {
      return err(
        `${label} ${key} must be at most ${VARIANT_TRANSFER_LIMITS.maxDimMm} mm`,
      );
    }
  }
  const ref = value as unknown as ReferenceRect;
  return {
    ok: true,
    ref: {
      originXmm: ref.originXmm,
      originYmm: ref.originYmm,
      widthMm: ref.widthMm,
      heightMm: ref.heightMm,
    },
  };
}

function checkRule(
  value: unknown,
  index: number,
): { ok: true; rule: RegionTransferRule } | { ok: false; error: string } {
  if (!isPlainObject(value)) return err(`rule ${index} must be an object`);
  if (!isValidId(value["sourceRegionId"])) {
    return err(`rule ${index} sourceRegionId must be a non-empty string of at most 256 chars`);
  }
  if (!isValidId(value["targetRegionId"])) {
    return err(`rule ${index} targetRegionId must be a non-empty string of at most 256 chars`);
  }
  const strategy: unknown = value["strategy"];
  if (strategy !== "absolute-position" && strategy !== "normalized-position") {
    return err(`rule ${index} strategy must be "absolute-position" or "normalized-position"`);
  }
  for (const key of ["sourceFrameConvention", "targetFrameConvention"] as const) {
    if (!isValidId(value[key])) {
      return err(`rule ${index} ${key} must be a non-empty string of at most 256 chars`);
    }
  }
  const rule = value as unknown as RegionTransferRule;
  let sourceRef: ReferenceRect | undefined;
  let targetRef: ReferenceRect | undefined;
  if (value["sourceRef"] !== undefined) {
    const checked = checkReferenceRect(value["sourceRef"], `rule ${index} sourceRef`);
    if (!checked.ok) return checked;
    sourceRef = checked.ref;
  }
  if (value["targetRef"] !== undefined) {
    const checked = checkReferenceRect(value["targetRef"], `rule ${index} targetRef`);
    if (!checked.ok) return checked;
    targetRef = checked.ref;
  }
  let proportionalDimensions = false;
  if (value["proportionalDimensions"] !== undefined) {
    if (typeof value["proportionalDimensions"] !== "boolean") {
      return err(`rule ${index} proportionalDimensions must be a boolean when present`);
    }
    proportionalDimensions = value["proportionalDimensions"];
  }
  if (proportionalDimensions && strategy === "absolute-position") {
    return err(`rule ${index} proportionalDimensions:true requires normalized-position`);
  }
  if (strategy === "normalized-position") {
    if (sourceRef === undefined || targetRef === undefined) {
      return err(`rule ${index} normalized-position requires both sourceRef and targetRef`);
    }
  }
  return {
    ok: true,
    rule: {
      sourceRegionId: rule.sourceRegionId,
      targetRegionId: rule.targetRegionId,
      strategy,
      sourceFrameConvention: rule.sourceFrameConvention,
      targetFrameConvention: rule.targetFrameConvention,
      ...(sourceRef !== undefined ? { sourceRef } : {}),
      ...(targetRef !== undefined ? { targetRef } : {}),
      ...(value["proportionalDimensions"] !== undefined
        ? { proportionalDimensions }
        : {}),
    },
  };
}

function checkOverride(
  value: unknown,
  index: number,
):
  | { ok: true; override: PlacementTransferOverride }
  | { ok: false; error: string } {
  if (!isPlainObject(value)) return err(`override ${index} must be an object`);
  if (!isValidId(value["placementId"])) {
    return err(`override ${index} placementId must be a non-empty string of at most 256 chars`);
  }
  if (!isValidId(value["targetRegionId"])) {
    return err(`override ${index} targetRegionId must be a non-empty string of at most 256 chars`);
  }
  for (const key of ["xMm", "yMm"] as const) {
    if (!isFiniteNumber(value[key])) {
      return err(`override ${index} ${key} must be a finite number`);
    }
  }
  const override = value as unknown as PlacementTransferOverride;
  for (const key of ["widthMm", "heightMm"] as const) {
    const dim: unknown = value[key];
    if (dim !== undefined && (!isFiniteNumber(dim) || !(dim > 0))) {
      return err(`override ${index} ${key} must be a finite number > 0 when present`);
    }
  }
  if (
    value["rotationDeg"] !== undefined &&
    (!isFiniteNumber(value["rotationDeg"]) ||
      !(value["rotationDeg"] > -180) ||
      !(value["rotationDeg"] <= 180))
  ) {
    return err(`override ${index} rotationDeg must be in (-180, 180] when present`);
  }
  return {
    ok: true,
    override: {
      placementId: override.placementId,
      targetRegionId: override.targetRegionId,
      xMm: override.xMm,
      yMm: override.yMm,
      ...(override.widthMm !== undefined ? { widthMm: override.widthMm } : {}),
      ...(override.heightMm !== undefined ? { heightMm: override.heightMm } : {}),
      ...(override.rotationDeg !== undefined ? { rotationDeg: override.rotationDeg } : {}),
    },
  };
}

function checkContextShape(value: unknown, label: string): { ok: true } | { ok: false; error: string } {
  if (!isPlainObject(value)) return err(`${label} must be an object`);
  if (!isValidId(value["product"])) {
    return err(`${label} product must be a non-empty string of at most 256 chars`);
  }
  if (!isValidId(value["variant"])) {
    return err(`${label} variant must be a non-empty string of at most 256 chars`);
  }
  if (!isPlainObject(value["evidence"])) return err(`${label} evidence must be an object`);
  if (!isPlainObject(value["fit"])) return err(`${label} fit must be an object`);
  if (!Array.isArray(value["regions"])) return err(`${label} regions must be an array`);
  if (
    typeof value["areas"] !== "object" ||
    value["areas"] === null ||
    Array.isArray(value["areas"])
  ) {
    return err(`${label} areas must be an object`);
  }
  if (typeof value["evidenceSnapshot"] !== "string" || value["evidenceSnapshot"].length === 0) {
    return err(`${label} evidenceSnapshot must be a non-empty string`);
  }
  return { ok: true };
}

/**
 * Deterministic, immutable transfer of 0..N logo draft placements across
 * explicitly supplied source/target variant planar region contexts. Atomic:
 * any validation failure yields a single error string with no partial output.
 */
export function transferPlacements(
  request: TransferRequest,
): { ok: true; bundle: VariantTransferBundle } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } =>
    err(`cannot transfer placements: ${error}`);
  if (!isPlainObject(request)) return fail("request must be an object");
  const raw = request as unknown as Record<string, unknown>;
  if (raw["transferVersion"] !== undefined && raw["transferVersion"] !== VARIANT_TRANSFER_VERSION) {
    return fail("transferVersion must equal the provisional variant-transfer version");
  }
  const shapeSource = checkContextShape(raw["source"], "source");
  if (!shapeSource.ok) return fail(shapeSource.error);
  const shapeTarget = checkContextShape(raw["target"], "target");
  if (!shapeTarget.ok) return fail(shapeTarget.error);
  if (
    typeof raw["sourceLogos"] !== "object" ||
    raw["sourceLogos"] === null ||
    Array.isArray(raw["sourceLogos"])
  ) {
    return fail("sourceLogos must be an object");
  }
  if (
    typeof raw["sourcePlacements"] !== "object" ||
    raw["sourcePlacements"] === null ||
    Array.isArray(raw["sourcePlacements"])
  ) {
    return fail("sourcePlacements must be an object");
  }
  if (!Array.isArray(raw["rules"])) return fail("rules must be an array");
  if (raw["overrides"] !== undefined && !Array.isArray(raw["overrides"])) {
    return fail("overrides must be an array when present");
  }

  // Validate and copy raw data without invoking JSON hooks or converting
  // malformed values to null. Optional undefined values remain optional.
  let cloned: unknown;
  try {
    cloned = copyInput(request);
  } catch {
    return fail("request must be JSON-compatible with finite numbers only");
  }
  const req = cloned as TransferRequest;
  const source = req.source;
  const target = req.target;
  const sourceLogos = req.sourceLogos;
  const sourcePlacements = req.sourcePlacements;
  const rulesInput = req.rules;
  const overridesInput = req.overrides ?? [];
  // Context product/variant must bound nonblank (checkContextShape above)
  // AND exactly match the calibration evidence on the same side; a forged
  // or copy-pasted label fails atomically before any kernel work.
  if (source.evidence.product !== source.product) {
    return fail("source product must exactly match source evidence product");
  }
  if (source.evidence.variant !== source.variant) {
    return fail("source variant must exactly match source evidence variant");
  }
  if (target.evidence.product !== target.product) {
    return fail("target product must exactly match target evidence product");
  }
  if (target.evidence.variant !== target.variant) {
    return fail("target variant must exactly match target evidence variant");
  }

  // Limits.
  const logoEntries = Object.entries(sourceLogos);
  if (logoEntries.length > VARIANT_TRANSFER_LIMITS.maxLogos) {
    return fail(`too many logos (${logoEntries.length} > ${VARIANT_TRANSFER_LIMITS.maxLogos})`);
  }
  const placementEntries = Object.entries(sourcePlacements);
  if (placementEntries.length > VARIANT_TRANSFER_LIMITS.maxPlacements) {
    return fail(
      `too many placements (${placementEntries.length} > ${VARIANT_TRANSFER_LIMITS.maxPlacements})`,
    );
  }
  if (source.regions.length > VARIANT_TRANSFER_LIMITS.maxRegions) {
    return fail(
      `too many source regions (${source.regions.length} > ${VARIANT_TRANSFER_LIMITS.maxRegions})`,
    );
  }
  if (target.regions.length > VARIANT_TRANSFER_LIMITS.maxRegions) {
    return fail(
      `too many target regions (${target.regions.length} > ${VARIANT_TRANSFER_LIMITS.maxRegions})`,
    );
  }
  if (rulesInput.length > VARIANT_TRANSFER_LIMITS.maxRules) {
    return fail(`too many rules (${rulesInput.length} > ${VARIANT_TRANSFER_LIMITS.maxRules})`);
  }
  if (overridesInput.length > VARIANT_TRANSFER_LIMITS.maxOverrides) {
    return fail(
      `too many overrides (${overridesInput.length} > ${VARIANT_TRANSFER_LIMITS.maxOverrides})`,
    );
  }

  // Rules/overrides shape + duplicates.
  const rules: RegionTransferRule[] = [];
  const ruleBySource: Record<string, RegionTransferRule> = Object.create(null);
  for (let i = 0; i < rulesInput.length; i += 1) {
    const checked = checkRule(rulesInput[i], i);
    if (!checked.ok) return fail(checked.error);
    if (Object.hasOwn(ruleBySource, checked.rule.sourceRegionId)) {
      return fail(`duplicate rule for sourceRegionId "${checked.rule.sourceRegionId}"`);
    }
    ruleBySource[checked.rule.sourceRegionId] = checked.rule;
    rules.push(checked.rule);
  }
  const overrides: PlacementTransferOverride[] = [];
  const overrideByPlacement: Record<string, PlacementTransferOverride> = Object.create(null);
  for (let i = 0; i < overridesInput.length; i += 1) {
    const checked = checkOverride(overridesInput[i], i);
    if (!checked.ok) return fail(checked.error);
    if (Object.hasOwn(overrideByPlacement, checked.override.placementId)) {
      return fail(`duplicate override for placementId "${checked.override.placementId}"`);
    }
    overrideByPlacement[checked.override.placementId] = checked.override;
    overrides.push(checked.override);
  }

  // Region-membership checks (ids harvested defensively; builders re-verify records).
  const sourceRegionIds = source.regions
    .filter((r): r is PlanarRegionRecord => isPlainObject(r))
    .map((r) => r.regionId);
  const targetRegionIds = target.regions
    .filter((r): r is PlanarRegionRecord => isPlainObject(r))
    .map((r) => r.regionId);
  for (const rule of rules) {
    if (!sourceRegionIds.includes(rule.sourceRegionId)) {
      return fail(`rule sourceRegionId "${rule.sourceRegionId}" is not in source regions`);
    }
    if (!targetRegionIds.includes(rule.targetRegionId)) {
      return fail(`rule targetRegionId "${rule.targetRegionId}" is not in target regions`);
    }
    if (rule.strategy === "absolute-position" && rule.sourceFrameConvention !== rule.targetFrameConvention) {
      return fail(
        `rule for sourceRegionId "${rule.sourceRegionId}" absolute-position requires matching frame conventions`,
      );
    }
  }
  for (const override of overrides) {
    if (!Object.hasOwn(sourcePlacements, override.placementId)) {
      return fail(`override for unknown placementId "${override.placementId}"`);
    }
    if (!targetRegionIds.includes(override.targetRegionId)) {
      return fail(`override targetRegionId "${override.targetRegionId}" is not in target regions`);
    }
  }

  // Source currentness via buildAreaBundle (fit re-verified, snapshot match).
  const sourceBuilt = buildAreaBundle(
    source.evidence,
    source.fit,
    source.regions,
    source.areas,
    source.evidenceSnapshot,
  );
  if (!sourceBuilt.ok) return fail(sourceBuilt.error);

  // Source logo/placement structural revalidation (key !== id mismatches fail).
  for (const [key, logo] of logoEntries) {
    const check = validateDraftLogo(logo);
    if (!check.ok) return fail(`invalid source logo "${key}": ${check.error}`);
    if (key !== (logo as DraftLogo).id) {
      return fail(`source logo-map key "${key}" does not match logo id`);
    }
  }
  for (const [key, placement] of placementEntries) {
    if (!isPlainObject(placement)) {
      return fail(`invalid source placement "${key}": placement must be an object`);
    }
    if (key !== (placement as DraftPlacement).id) {
      return fail(`source placement-map key "${key}" does not match placement id`);
    }
    const check = validateDraftPlacement(placement, sourceLogos, sourceRegionIds);
    if (!check.ok) return fail(`invalid source placement "${key}": ${check.error}`);
  }

  // Per-placement resolution (override takes precedence over the rule for its
  // source region) with transfer math.
  const transferred: PlacementsMap = Object.create(null);
  const transfers: VariantTransferRecord[] = [];
  const sortedIds = placementEntries.map(([key]) => key).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of sortedIds) {
    const src = sourcePlacements[id] as DraftPlacement;
    const override = Object.hasOwn(overrideByPlacement, id) ? overrideByPlacement[id] : undefined;
    let targetRegionId: string;
    let strategy: TransferStrategyUsed;
    let xMm: number;
    let yMm: number;
    let widthMm = src.widthMm;
    let heightMm = src.heightMm;
    // Rotation is clockwise-positive facing the region on both sides, so it
    // copies verbatim. Limitation: mirrored frames are not compensated — a
    // mirrored target frame would need a handedness flip, which this
    // provisional kernel does not attempt.
    let rotationDeg = src.rotationDeg;
    if (override !== undefined) {
      strategy = "override";
      targetRegionId = override.targetRegionId;
      xMm = override.xMm;
      yMm = override.yMm;
      if (override.widthMm !== undefined) widthMm = override.widthMm;
      if (override.heightMm !== undefined) heightMm = override.heightMm;
      if (override.rotationDeg !== undefined) rotationDeg = override.rotationDeg;
    } else {
      const rule = Object.hasOwn(ruleBySource, src.regionId) ? ruleBySource[src.regionId] : undefined;
      if (rule === undefined) {
        return fail(`source placement "${id}" has neither rule nor override`);
      }
      strategy = rule.strategy;
      targetRegionId = rule.targetRegionId;
      if (rule.strategy === "absolute-position") {
        // Absolute-position copies mm offsets only after the exact
        // frame-convention match verified above.
        xMm = src.xMm;
        yMm = src.yMm;
      } else {
        // Normalized-position uses ONLY caller-supplied refs (never
        // safe-polygon bounding boxes).
        const sRef = rule.sourceRef as ReferenceRect;
        const tRef = rule.targetRef as ReferenceRect;
        const u = (src.xMm - sRef.originXmm) / sRef.widthMm;
        const v = (src.yMm - sRef.originYmm) / sRef.heightMm;
        xMm = tRef.originXmm + u * tRef.widthMm;
        yMm = tRef.originYmm + v * tRef.heightMm;
        if (rule.proportionalDimensions === true) {
          widthMm = src.widthMm * (tRef.widthMm / sRef.widthMm);
          heightMm = src.heightMm * (tRef.heightMm / sRef.heightMm);
        }
      }
    }
    for (const [label, value] of [
      ["xMm", xMm],
      ["yMm", yMm],
      ["widthMm", widthMm],
      ["heightMm", heightMm],
      ["rotationDeg", rotationDeg],
    ] as Array<[string, number]>) {
      if (!isFiniteNumber(value)) {
        return fail(`transfer of placement "${id}" produced non-finite ${label}`);
      }
    }
    if (
      Math.abs(xMm) > VARIANT_TRANSFER_LIMITS.maxCoordMm ||
      Math.abs(yMm) > VARIANT_TRANSFER_LIMITS.maxCoordMm
    ) {
      return fail(`transfer of placement "${id}" exceeds coordinate bounds`);
    }
    if (
      !(widthMm > 0) ||
      widthMm > VARIANT_TRANSFER_LIMITS.maxDimMm ||
      !(heightMm > 0) ||
      heightMm > VARIANT_TRANSFER_LIMITS.maxDimMm
    ) {
      return fail(`transfer of placement "${id}" has out-of-bounds dimensions`);
    }
    if (!(rotationDeg > -180) || !(rotationDeg <= 180)) {
      return fail(`transfer of placement "${id}" has out-of-range rotationDeg`);
    }
    transferred[id] = {
      id,
      logoId: src.logoId,
      regionId: targetRegionId,
      xMm,
      yMm,
      widthMm,
      heightMm,
      rotationDeg,
    };
    transfers.push({
      sourcePlacementId: id,
      targetPlacementId: id,
      sourceRegionId: src.regionId,
      targetRegionId,
      strategy,
      xMm,
      yMm,
      widthMm,
      heightMm,
      rotationDeg,
    });
  }

  // Target currentness + verdicts by building the target through
  // buildPlacementBundle (never trust supplied statuses; wellformed unsafe
  // candidates stay fits:false pending-review drafts).
  const copiedLogos = copyLogos(sourceLogos);
  const targetBuilt = buildPlacementBundle(
    target.evidence,
    target.fit,
    target.regions,
    target.areas,
    copiedLogos,
    copyPlacements(transferred),
    target.evidenceSnapshot,
  );
  if (!targetBuilt.ok) return fail(targetBuilt.error);

  transfers.sort((a, b) => (a.sourcePlacementId < b.sourcePlacementId ? -1 : a.sourcePlacementId > b.sourcePlacementId ? 1 : 0));
  const bundle: VariantTransferBundle = {
    schemaVersion: VARIANT_TRANSFER_VERSION,
    pendingReview: true,
    productionApproved: false,
    source: {
      product: source.product,
      variant: source.variant,
      evidenceSnapshot: source.evidenceSnapshot,
      regionIds: sortedUnique(sourceRegionIds),
      frameIds: sortedUnique(
        source.regions
          .filter((r): r is PlanarRegionRecord => isPlainObject(r))
          .map((r) => r.frameId)
          .filter((f): f is string => typeof f === "string"),
      ),
      placementIds: sortedUnique(placementEntries.map(([key]) => key)),
    },
    target: targetBuilt.bundle,
    transfers,
    limitations: [
      "provisional variant-transfer draft; not production approved",
      "rotation copies verbatim; mirrored frames are not compensated",
      "wellformed unsafe candidates stay fits:false pending-review drafts",
    ],
  };
  return { ok: true, bundle };
}

/** Deterministic bundle text: stable key order, 2-space indent. */
export function serializeTransferBundle(bundle: VariantTransferBundle): string {
  const ordered = {
    schemaVersion: bundle.schemaVersion,
    pendingReview: bundle.pendingReview,
    productionApproved: bundle.productionApproved,
    source: bundle.source,
    target: bundle.target,
    transfers: bundle.transfers,
    limitations: bundle.limitations,
  };
  return JSON.stringify(JSON.parse(stableStringify(ordered)), null, 2);
}
