/**
 * Shared validated model-to-millimetre scene resolution (Phase 1 FOUNDATION).
 *
 * Pure, dependency-free resolver for the operator's calibrated 3D model
 * mapping. No Three.js, no DOM, no pixels-as-millimetres, no duplicate
 * geometry: plane projection reuses `projectAreaToMm` from the staff
 * model-setup view, scale/reference checks reuse the core
 * setup-calibration contract, and region identity reuses
 * `modelAreaRegionId` from the core model-placement helper.
 *
 * Frozen API for Phase 2 customer reuse:
 * - `resolveModelPlacementScene(project, lookup, productId, variantId)`
 *   reconstructs the exact display mapping the operator mapping uses
 *   (`jobModelPlacementScene` in the internal builder): `null` when the
 *   scope has no model at all, otherwise a display-only scene with
 *   `regions: []` when no validated calibrated area survives, or the
 *   calibrated regions when every check passes.
 * - `selectValidModelSetupSidecars(assets, project, configurations)`
 *   preserves only the valid, selected product/variant-bound model setup
 *   sidecars through issue packages, retaining exact bytes where valid.
 *
 * Path and hashing conventions mirror the internal builder exactly
 * (`safeProductSegment`, `spanScopeSuffix`, `modelAssetKeyOf` with FNV-1a).
 */

import { fitScaleFromReferences, validateReferenceSpan } from '../core/setup-calibration/index.js';
import type { ReferenceSpan } from '../core/setup-calibration/index.js';
import { modelAreaRegionId } from '../core/model-placement/index.js';
import type { ModelRegionFrame } from '../core/model-placement/index.js';
import type { ProjectDocument } from '../core/types.js';
import { projectAreaToMm } from '../core/model-placement/area-projection.js';
import { parsePresentationManifest as parseFlexiblePresentationManifest } from '../core/presentation-views/index.js';

/** Directory for image span sidecars and model setup sidecars. */
export const MODEL_SETUP_SIDECAR_DIR = 'presentation/setup-calibration' as const;

/** Deterministic model-setup sidecar envelope version. */
export const MODEL_SETUP_SIDECAR_VERSION = 'setup-model-sidecar/1' as const;

/** Byte bound shared with the internal builder (64 KiB). */
export const MODEL_SETUP_SIDECAR_MAX_BYTES = 64 * 1024;

/** Model byte bound shared with the presentation contract (16 MiB). */
export const MODEL_SETUP_MODEL_MAX_BYTES = 16 * 1024 * 1024;

/** Staff 3D-setup envelope version (must match the model-setup view). */
export const MODEL_SETUP_ENVELOPE_VERSION = '0.1.0-provisional-model-setup' as const;

export const PRESENTATION_MANIFEST_PATH = 'presentation/preview.json' as const;

export interface ModelSceneRegion {
  id: string;
  frame: ModelRegionFrame;
  pointsModel: Array<{ x: number; y: number; z: number }>;
}

export interface ModelScene {
  key: string;
  bytes: Uint8Array;
  regions: ModelSceneRegion[];
}

export interface ModelSetupSidecarFile {
  version: typeof MODEL_SETUP_SIDECAR_VERSION;
  kind: 'model';
  productId: string;
  variantId: string | null;
  assetKey: string;
  calibrationId: string;
  setup: unknown;
}

export type AssetLookup = (path: string) => Uint8Array | undefined;

function toLookup(
  assets: ReadonlyMap<string, Uint8Array> | AssetLookup,
): AssetLookup {
  if (typeof assets === 'function') return assets;
  return (path: string) => (assets as ReadonlyMap<string, Uint8Array>).get(path);
}

export function safeProductSegment(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return cleaned === '' ? 'product' : cleaned;
}

export function spanScopeSuffix(variantId: string | undefined): string {
  return variantId === undefined ? 'product' : `variant-${safeProductSegment(variantId)}`;
}

function fnv1a32Hex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function modelAssetKeyOf(modelPath: string, bytes: Uint8Array): string {
  return `${modelPath}#${bytes.length}:${fnv1a32Hex(bytes)}`;
}

export function modelSetupSidecarPathFor(productId: string, variantId: string | undefined): string {
  return `${MODEL_SETUP_SIDECAR_DIR}/${safeProductSegment(productId)}/model.${spanScopeSuffix(variantId)}.model.json`;
}

export function modelCalibrationIdFor(productId: string, variantId: string | undefined): string {
  return `cal-model-${safeProductSegment(productId)}-${spanScopeSuffix(variantId)}`;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function parseModelSetupSidecar(
  bytes: Uint8Array,
): { ok: true; sidecar: ModelSetupSidecarFile } | { ok: false; error: string } {
  if (bytes.length === 0 || bytes.length > MODEL_SETUP_SIDECAR_MAX_BYTES) {
    return fail('model setup sidecar is empty or exceeds the 64 KiB sidecar bound');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('model setup sidecar is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) return fail('model setup sidecar must be an object');
  const record = raw as Record<string, unknown>;
  if (record['version'] !== MODEL_SETUP_SIDECAR_VERSION) return fail('model setup sidecar has an unknown version');
  if (record['kind'] !== 'model') return fail('model setup sidecar has the wrong kind');
  if (typeof record['productId'] !== 'string' || record['productId'].length === 0) {
    return fail('model setup sidecar productId must be a non-empty string');
  }
  if (record['variantId'] !== null && (typeof record['variantId'] !== 'string' || (record['variantId'] as string).length === 0)) {
    return fail('model setup sidecar variantId must be null or a non-empty string');
  }
  if (typeof record['assetKey'] !== 'string' || (record['assetKey'] as string).length === 0) {
    return fail('model setup sidecar assetKey must be a non-empty string');
  }
  if (typeof record['calibrationId'] !== 'string' || (record['calibrationId'] as string).length === 0) {
    return fail('model setup sidecar calibrationId must be a non-empty string');
  }
  if (typeof record['setup'] !== 'object' || record['setup'] === null) {
    return fail('model setup sidecar carries no setup envelope');
  }
  return {
    ok: true,
    sidecar: {
      version: MODEL_SETUP_SIDECAR_VERSION,
      kind: 'model',
      productId: record['productId'] as string,
      variantId: record['variantId'] as string | null,
      assetKey: record['assetKey'] as string,
      calibrationId: record['calibrationId'] as string,
      setup: record['setup'],
    },
  };
}

function parseJsonLenient(bytes: Uint8Array | undefined): unknown {
  if (!bytes || bytes.length === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

interface ModelEntry {
  model: string;
  variantId?: string;
}

function modelEntryFor(
  manifest: ReturnType<typeof parseFlexiblePresentationManifest>,
  productId: string,
  variantId: string | undefined,
): ModelEntry | null {
  if (manifest === null) return null;
  const entries = (manifest.models ?? []).filter((entry) => entry.productId === productId);
  if (entries.length === 0) return null;
  const exact = entries.find((entry) => entry.variantId === variantId);
  const wide = entries.find((entry) => entry.variantId === undefined);
  const chosen = exact ?? wide ?? null;
  if (!chosen) return null;
  return { model: chosen.model, ...(chosen.variantId === undefined ? {} : { variantId: chosen.variantId }) };
}

function isFiniteVec3(value: unknown): value is { x: number; y: number; z: number } {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['x'] === 'number' && Number.isFinite(record['x']) &&
    typeof record['y'] === 'number' && Number.isFinite(record['y']) &&
    typeof record['z'] === 'number' && Number.isFinite(record['z'])
  );
}

interface ValidatedSidecar {
  sidecar: ModelSetupSidecarFile;
  calibrationVersion: string;
  mmPerUnit: number;
  regions: ModelSceneRegion[];
}

/**
 * Validate one sidecar against the live project/model bytes and resolve its
 * calibrated regions. Returns null on any absence or mismatch; the caller
 * then falls back to a display-only scene (resolver) or drops the sidecar
 * (issue retention). Every surface stays provisional pending review.
 */
function validateSidecarForScope(
  project: ProjectDocument,
  productId: string,
  modelScopeVariant: string | undefined,
  modelPath: string,
  modelBytes: Uint8Array,
  sidecarBytes: Uint8Array,
): ValidatedSidecar | null {
  const parsed = parseModelSetupSidecar(sidecarBytes);
  if (!parsed.ok) return null;
  const sidecar = parsed.sidecar;
  const expectedKey = modelAssetKeyOf(modelPath, modelBytes);
  if (sidecar.productId !== productId || sidecar.assetKey !== expectedKey) return null;
  if ((sidecar.variantId ?? undefined) !== modelScopeVariant) return null;
  const product = project.products.find((entry) => entry.id === productId);
  if (!product) return null;
  const calibration = product.calibrations.find((entry) => entry.id === sidecar.calibrationId);
  if (!calibration) return null;
  const setup = sidecar.setup as Record<string, unknown>;
  if (
    setup['version'] !== MODEL_SETUP_ENVELOPE_VERSION ||
    setup['productId'] !== productId ||
    (setup['variantId'] ?? null) !== (modelScopeVariant ?? null) ||
    setup['assetKey'] !== expectedKey ||
    !Array.isArray(setup['areas']) ||
    (setup['areas'] as unknown[]).length > 64
  ) {
    return null;
  }
  const reference = setup['reference'] as ReferenceSpan;
  if (validateReferenceSpan(reference) !== null || !('z' in reference.a) || !('z' in reference.b)) return null;
  const fit = fitScaleFromReferences([reference]);
  if (!fit.ok) return null;
  if (!Number.isFinite(fit.mmPerUnit) || !(fit.mmPerUnit > 0)) return null;
  const rawAreas = setup['areas'] as Array<Record<string, unknown>>;
  const regions: ModelSceneRegion[] = [];
  for (const value of rawAreas) {
    if (!value || typeof value !== 'object') return null;
    const area = value as Record<string, unknown>;
    if (typeof area['id'] !== 'string' || area['status'] !== 'current') return null;
    if (!Array.isArray(area['points']) || (area['points'] as unknown[]).length < 3 || (area['points'] as unknown[]).length > 512) {
      return null;
    }
    const points = area['points'] as unknown[];
    for (const point of points) {
      if (!isFiniteVec3(point)) return null;
    }
    const typed = points as Array<{ x: number; y: number; z: number }>;
    const projected = projectAreaToMm(typed, fit.mmPerUnit);
    if (!projected) return null;
    const regionId = modelAreaRegionId(area['id'] as string, spanScopeSuffix(modelScopeVariant));
    const region = product.regions.find((entry) => entry.id === regionId);
    if (!region) return null;
    // The region must be linked to at least one variant of this product;
    // the resolver itself does not enforce which variant is displayed —
    // scope binding is enforced by the issue-retention filter and the
    // builder's live scene lookup.
    if (
      region.calibrationRef.calibrationId !== sidecar.calibrationId ||
      region.calibrationRef.version !== calibration.version ||
      region.safeArea.length !== projected.ring.length
    ) {
      return null;
    }
    for (let index = 0; index < region.safeArea.length; index += 1) {
      const expected = projected.ring[index]!;
      const actual = region.safeArea[index]!;
      if (Math.abs(actual[0]! - expected.x) >= 1e-6 || Math.abs(actual[1]! - expected.y) >= 1e-6) {
        return null;
      }
    }
    regions.push({
      id: regionId,
      frame: { ...projected.plane, mmPerUnit: fit.mmPerUnit },
      pointsModel: typed.map((point) => ({ ...point })),
    });
  }
  if (regions.length === 0) return null;
  return { sidecar, calibrationVersion: calibration.version, mmPerUnit: fit.mmPerUnit, regions };
}

/**
 * Reconstruct display mapping only from current, asset-bound setup evidence.
 * Pure: `null` when the scope has no model; otherwise a scene that is
 * display-only (`regions: []`) unless every validated calibrated area
 * survives. Never invents millimetres, frames, domain regions or approval.
 */
export function resolveModelPlacementScene(
  project: ProjectDocument,
  assets: ReadonlyMap<string, Uint8Array> | AssetLookup,
  productId: string,
  variantId: string,
): ModelScene | null {
  const lookup = toLookup(assets);
  const product = project.products.find((entry) => entry.id === productId);
  const variant = product?.variants.find((entry) => entry.id === variantId);
  if (!product || !variant) return null;
  const manifest = parseFlexiblePresentationManifest(parseJsonLenient(lookup(PRESENTATION_MANIFEST_PATH)));
  const model = modelEntryFor(manifest, productId, variantId);
  if (!model) return null;
  const bytes = lookup(model.model);
  if (!bytes) return null;
  const key = modelAssetKeyOf(model.model, bytes);
  const displayOnly = (): ModelScene => ({ key, bytes, regions: [] });
  const scopeVariant = model.variantId ?? undefined;
  const candidatePaths = [
    modelSetupSidecarPathFor(product.id, scopeVariant),
    ...(scopeVariant !== undefined ? [modelSetupSidecarPathFor(product.id, undefined)] : []),
  ];
  for (const path of candidatePaths) {
    const sidecarBytes = lookup(path);
    if (!sidecarBytes) continue;
    const validated = validateSidecarForScope(project, product.id, scopeVariant, model.model, bytes, sidecarBytes);
    // Scope check mirrors the builder: a product-wide sidecar never stands
    // in for a variant scope and vice versa (assetKey already binds bytes).
    if (!validated) continue;
    if ((validated.sidecar.variantId ?? undefined) !== scopeVariant) continue;
    // Variant linkage mirrors `jobModelPlacementScene`: only regions linked
    // to the requested variant render; unlinked scopes stay display-only.
    const linked = validated.regions.filter((region) => variant.regionIds.includes(region.id));
    if (linked.length > 0) {
      return { key, bytes, regions: linked };
    }
  }
  // No valid calibrated area: display-only scene with no physical mapping.
  return displayOnly();
}

/**
 * Preserve only valid, selected product/variant-bound model setup sidecars.
 * Each returned entry carries the exact input bytes (no copies, no rewrites).
 * Rejects mismatched, stale, unknown or unselected evidence: unknown
 * products/variants, missing/invalid models, asset-key mismatches, scope
 * mismatches, missing calibrations, stale/non-current areas, size-bound
 * violations and canonical projected-ring disagreements. Never carries
 * unrelated internal files.
 */
export function selectValidModelSetupSidecars(
  assets: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  project: ProjectDocument,
  configurations: ReadonlyArray<{ productId: string; variantId: string }>,
): Array<{ path: string; bytes: Uint8Array }> {
  if (configurations.length === 0) return [];
  const byPath = new Map<string, Uint8Array>();
  for (const asset of assets) {
    if (!byPath.has(asset.path)) byPath.set(asset.path, asset.bytes);
  }
  const manifest = parseFlexiblePresentationManifest(parseJsonLenient(byPath.get(PRESENTATION_MANIFEST_PATH)));
  if (manifest === null) return [];
  const seenConfigs = new Set<string>();
  const outByPath = new Map<string, Uint8Array>();
  for (const configuration of configurations) {
    const configKey = `${configuration.productId}\0${configuration.variantId}`;
    if (seenConfigs.has(configKey)) continue;
    seenConfigs.add(configKey);
    const product = project.products.find((entry) => entry.id === configuration.productId);
    if (!product) continue;
    const variant = product.variants.find((entry) => entry.id === configuration.variantId);
    if (!variant) continue;
    const model = modelEntryFor(manifest, configuration.productId, configuration.variantId);
    if (!model) continue;
    const modelBytes = byPath.get(model.model);
    if (!modelBytes || modelBytes.length === 0 || modelBytes.length > MODEL_SETUP_MODEL_MAX_BYTES) continue;
    const scopeVariant = model.variantId ?? undefined;
    const expectedPath = modelSetupSidecarPathFor(configuration.productId, scopeVariant);
    const sidecarBytes = byPath.get(expectedPath);
    if (!sidecarBytes) continue;
    const validated = validateSidecarForScope(
      project,
      configuration.productId,
      scopeVariant,
      model.model,
      modelBytes,
      sidecarBytes,
    );
    if (!validated) continue;
    // Variant linkage: a calibrated region must be linked to the issued
    // variant for this configuration; otherwise the sidecar is valid for
    // another scope but not this one. Product-wide scopes link every
    // variant explicitly at commit time, so this filters stale unlinks.
    const linked = validated.regions.every((region) => variant.regionIds.includes(region.id));
    if (!linked) continue;
    if (!outByPath.has(expectedPath)) outByPath.set(expectedPath, sidecarBytes);
  }
  return [...outByPath.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([path, bytes]) => ({ path, bytes }));
}
