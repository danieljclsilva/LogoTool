/// <reference lib="dom" />
import { readRasterHeader, MAX_PREVIEW_BYTES, MAX_PREVIEW_PIXELS } from '../../assets/raster-header.js';
import { parsePhotoMappings, serializePhotoMappings, validatePhotoMapping, PHOTO_MAPPINGS_PATH } from './presentation-photo-mapping.js';
import { parseGlb } from '../../assets/glb.js';
import { validateSelfContained } from '../../assets/validate.js';
/**
 * PROVISIONAL presentation-only adapter for optional reference imagery.
 *
 * Boundary: this module is presentation-only and external to the canonical
 * production/domain schema. It never mutates the project, never influences
 * geometry/validation/export, and never fabricates a garment-photo calibrated
 * placement mapping. The measured placement diagram (exact domain millimetres)
 * remains the source of truth; a reference photo is shown only as an
 * unmapped contextual image and NEVER gets a pretend live logo overlay.
 *
 * Package shape: an optional `presentation/preview.json` manifest plus
 * raster images and optional GLB models, stored as `additional` (never
 * `referenced`) entries inside `.logo-project`. Only paths explicitly present
 * in the opened package are used; product/variant ids must match the current
 * selection; no filename inference, no hardcoded product behaviour, no
 * remote URLs.
 */

export interface PresentationReferenceEntry {
  productId: string;
  variantId?: string;
  image: string;
  label?: string;
}

export type PresentationViewSide = 'front' | 'back' | 'left' | 'right';

export interface PresentationMultiviewEntry {
  productId: string;
  variantId?: string;
  view: PresentationViewSide;
  image: string;
  label?: string;
}

export interface PresentationModelEntry {
  productId: string;
  variantId?: string;
  model: string;
  label?: string;
}

export interface PresentationManifestV1 {
  version: 1;
  references: PresentationReferenceEntry[];
}

export interface PresentationManifestV2 {
  version: 2;
  views: PresentationMultiviewEntry[];
  models?: PresentationModelEntry[];
  /**
   * Preserved v1 references carried forward verbatim when a v2 manifest
   * upgrades history. v1 entries have no side, so they are kept as-is
   * (never converted into sided views) and selected as `view: null`.
   */
  references?: PresentationReferenceEntry[];
}

export type PresentationManifest = PresentationManifestV1 | PresentationManifestV2;

export interface PresentationSelection {
  /** Explicit package path of the validated raster image, or null. */
  imagePath: string | null;
  label: string | null;
  /** Concise warning when the manifest existed but yielded no usable image. */
  warning: string | null;
}

export interface PresentationViewSelection {
  view: PresentationViewSide | null;
  imagePath: string;
  label: string | null;
}

export interface PresentationViewsSelection {
  views: PresentationViewSelection[];
  warning: string | null;
}

export interface PresentationModelSelection {
  /** Explicit package path of the validated GLB model, or null. */
  modelPath: string | null;
  label: string | null;
  /** Concise warning when the manifest existed but yielded no usable model. */
  warning: string | null;
}

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_REFERENCES = 32;

const ALLOWLISTED_MEDIA: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const VIEW_SIDE_LOOKUP: Record<string, true> = { front: true, back: true, left: true, right: true };
const SIDE_ORDER: PresentationViewSide[] = ['front', 'back', 'left', 'right'];

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

function isValidPresentationPath(value: string): boolean {
  if (value.length === 0) return false;
  const lower = value.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('//')
  ) return false;
  if (!value.startsWith('presentation/')) return false;
  if (value.includes('\\') || value.includes(':')) return false;
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  return true;
}

/**
 * Parse and validate an optional presentation manifest. Returns null when
 * absent or invalid (invalid metadata is dropped, never thrown past the UI).
 */
export function parsePresentationManifest(manifestBytes: Uint8Array | undefined): PresentationManifest | null {
  if (!manifestBytes || manifestBytes.length === 0) return null;
  if (manifestBytes.length > MAX_MANIFEST_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record['version'] === 1) {
    if (!Array.isArray(record['references'])) return null;
    const references = record['references'] as unknown[];
    if (references.length > MAX_REFERENCES) return null;
    const valid: PresentationReferenceEntry[] = [];
    for (const entry of references) {
      if (typeof entry !== 'object' || entry === null) return null;
      const item = entry as Record<string, unknown>;
      if (typeof item['productId'] !== 'string' || item['productId'].length === 0) return null;
      if (item['variantId'] !== undefined && typeof item['variantId'] !== 'string') return null;
      if (typeof item['image'] !== 'string' || item['image'].length === 0) return null;
      if (item['label'] !== undefined && typeof item['label'] !== 'string') return null;
      if (!isValidPresentationPath(item['image'])) return null;
      if (ALLOWLISTED_MEDIA[extensionOf(item['image'])] === undefined) return null;
      valid.push({
        productId: item['productId'],
        ...(typeof item['variantId'] === 'string' ? { variantId: item['variantId'] } : {}),
        image: item['image'],
        ...(typeof item['label'] === 'string' ? { label: item['label'] } : {}),
      });
    }
    return { version: 1, references: valid };
  }
  if (record['version'] === 2) {
    if (!Array.isArray(record['views'])) return null;
    if (record['models'] !== undefined && !Array.isArray(record['models'])) return null;
    if (record['references'] !== undefined && !Array.isArray(record['references'])) return null;
    const viewsRaw = record['views'] as unknown[];
    const modelsRaw = (record['models'] ?? []) as unknown[];
    const referencesRaw = (record['references'] ?? []) as unknown[];
    if (viewsRaw.length + modelsRaw.length + referencesRaw.length === 0) return null;
    if (viewsRaw.length + modelsRaw.length + referencesRaw.length > MAX_REFERENCES) return null;
    const views: PresentationMultiviewEntry[] = [];
    for (const entry of viewsRaw) {
      if (typeof entry !== 'object' || entry === null) return null;
      const item = entry as Record<string, unknown>;
      if (typeof item['productId'] !== 'string' || item['productId'].length === 0) return null;
      if (item['variantId'] !== undefined && typeof item['variantId'] !== 'string') return null;
      if (typeof item['view'] !== 'string' || VIEW_SIDE_LOOKUP[item['view']] !== true) return null;
      if (typeof item['image'] !== 'string' || item['image'].length === 0) return null;
      if (item['label'] !== undefined && typeof item['label'] !== 'string') return null;
      if (!isValidPresentationPath(item['image'])) return null;
      if (ALLOWLISTED_MEDIA[extensionOf(item['image'])] === undefined) return null;
      views.push({
        productId: item['productId'],
        ...(typeof item['variantId'] === 'string' ? { variantId: item['variantId'] } : {}),
        view: item['view'] as PresentationViewSide,
        image: item['image'],
        ...(typeof item['label'] === 'string' ? { label: item['label'] } : {}),
      });
    }
    const models: PresentationModelEntry[] = [];
    for (const entry of modelsRaw) {
      if (typeof entry !== 'object' || entry === null) return null;
      const item = entry as Record<string, unknown>;
      if (typeof item['productId'] !== 'string' || item['productId'].length === 0) return null;
      if (item['variantId'] !== undefined && typeof item['variantId'] !== 'string') return null;
      if (typeof item['model'] !== 'string' || item['model'].length === 0) return null;
      if (item['label'] !== undefined && typeof item['label'] !== 'string') return null;
      if (!isValidPresentationPath(item['model'])) return null;
      if (extensionOf(item['model']) !== '.glb') return null;
      models.push({
        productId: item['productId'],
        ...(typeof item['variantId'] === 'string' ? { variantId: item['variantId'] } : {}),
        model: item['model'],
        ...(typeof item['label'] === 'string' ? { label: item['label'] } : {}),
      });
    }
    const references: PresentationReferenceEntry[] = [];
    for (const entry of referencesRaw) {
      if (typeof entry !== 'object' || entry === null) return null;
      const item = entry as Record<string, unknown>;
      if (typeof item['productId'] !== 'string' || item['productId'].length === 0) return null;
      if (item['variantId'] !== undefined && typeof item['variantId'] !== 'string') return null;
      if (typeof item['image'] !== 'string' || item['image'].length === 0) return null;
      if (item['label'] !== undefined && typeof item['label'] !== 'string') return null;
      if (!isValidPresentationPath(item['image'])) return null;
      if (ALLOWLISTED_MEDIA[extensionOf(item['image'])] === undefined) return null;
      references.push({
        productId: item['productId'],
        ...(typeof item['variantId'] === 'string' ? { variantId: item['variantId'] } : {}),
        image: item['image'],
        ...(typeof item['label'] === 'string' ? { label: item['label'] } : {}),
      });
    }
    if (views.length + models.length + references.length === 0) return null;
    const out: PresentationManifestV2 = { version: 2, views };
    if (models.length > 0) out.models = models;
    if (references.length > 0) out.references = references;
    return out;
  }
  return null;
}

export interface PresentationAssetLookup {
  (path: string): Uint8Array | undefined;
}

/**
 * Select the reference image for the current product/variant. Exact-id match
 * only; variant-scoped entries win over product-wide ones. Returns a warning
 * (not an image) when the manifest exists but nothing matches or validates.
 */
export function selectPresentationReference(
  manifest: PresentationManifest | null,
  manifestPresent: boolean,
  productId: string,
  variantId: string,
  lookup: PresentationAssetLookup,
): PresentationSelection {
  if (!manifestPresent) return { imagePath: null, label: null, warning: null };
  if (!manifest) return { imagePath: null, label: null, warning: 'Reference preview data was invalid and has been ignored.' };
  if (manifest.version === 2) {
    const candidates = manifest.views.filter((entry) => entry.productId === productId);
    if (candidates.length === 0) {
      return { imagePath: null, label: null, warning: `No reference image supplied for this product in the package.` };
    }
    const scoped = candidates.find((entry) => entry.variantId === variantId)
      ?? candidates.find((entry) => entry.variantId === undefined);
    if (!scoped) {
      return { imagePath: null, label: null, warning: `No reference image supplied for this product option in the package.` };
    }
    const bytes = lookup(scoped.image);
    if (!bytes || bytes.length === 0 || bytes.length > PRESENTATION_MAX_IMAGE_BYTES) {
      return { imagePath: null, label: null, warning: `Reference image “${scoped.image}” is missing or too large; showing the measured diagram instead.` };
    }
    if (ALLOWLISTED_MEDIA[extensionOf(scoped.image)] === undefined) {
      return { imagePath: null, label: null, warning: `Reference image “${scoped.image}” is not a supported raster format; showing the measured diagram instead.` };
    }
    return { imagePath: scoped.image, label: scoped.label ?? null, warning: null };
  }
  const candidates = manifest.references.filter((entry) => entry.productId === productId);
  if (candidates.length === 0) {
    return { imagePath: null, label: null, warning: `No reference image supplied for this product in the package.` };
  }
  const scoped = candidates.find((entry) => entry.variantId === variantId)
    ?? candidates.find((entry) => entry.variantId === undefined);
  if (!scoped) {
    return { imagePath: null, label: null, warning: `No reference image supplied for this product option in the package.` };
  }
  const bytes = lookup(scoped.image);
  if (!bytes || bytes.length === 0 || bytes.length > PRESENTATION_MAX_IMAGE_BYTES) {
    return { imagePath: null, label: null, warning: `Reference image “${scoped.image}” is missing or too large; showing the measured diagram instead.` };
  }
  if (ALLOWLISTED_MEDIA[extensionOf(scoped.image)] === undefined) {
    return { imagePath: null, label: null, warning: `Reference image “${scoped.image}” is not a supported raster format; showing the measured diagram instead.` };
  }
  return { imagePath: scoped.image, label: scoped.label ?? null, warning: null };
}

/**
 * Select the per-side reference views for the current product/variant.
 * Exact-id match only; per side, variant-scoped entries win over
 * product-wide ones. v1 manifests map to a single `view: null` entry with
 * the same label semantics as `selectPresentationReference`. Views whose
 * bytes are missing, oversized or undecodable are omitted with a warning;
 * missing sides are never invented.
 */
export function selectPresentationViews(
  manifest: PresentationManifest | null,
  manifestPresent: boolean,
  productId: string,
  variantId: string,
  lookup: PresentationAssetLookup,
): PresentationViewsSelection {
  if (!manifestPresent) return { views: [], warning: null };
  if (!manifest) return { views: [], warning: 'Reference preview data was invalid and has been ignored.' };
  if (manifest.version === 1) {
    const single = selectPresentationReference(manifest, true, productId, variantId, lookup);
    if (!single.imagePath) return { views: [], warning: single.warning };
    return { views: [{ view: null, imagePath: single.imagePath, label: single.label }], warning: null };
  }
  const candidates = manifest.views.filter((entry) => entry.productId === productId);
  // A valid one-input package may simply have no views (model-only) or no
  // views for this product — that is benign, not a warning.
  if (candidates.length === 0) {
    return { views: [], warning: null };
  }
  const perSide: Record<PresentationViewSide, PresentationMultiviewEntry | undefined> = { front: undefined, back: undefined, left: undefined, right: undefined };
  for (const entry of candidates) {
    if (entry.variantId !== undefined && entry.variantId !== variantId) continue;
    const current = perSide[entry.view];
    if (current === undefined || (current.variantId === undefined && entry.variantId === variantId)) {
      perSide[entry.view] = entry;
    }
  }
  if (perSide.front === undefined && perSide.back === undefined && perSide.left === undefined && perSide.right === undefined) {
    return { views: [], warning: null };
  }
  const views: PresentationViewSelection[] = [];
  const dropped: string[] = [];
  for (const side of SIDE_ORDER) {
    const entry = perSide[side];
    if (!entry) continue;
    const bytes = lookup(entry.image);
    if (!bytes || bytes.length === 0 || bytes.length > PRESENTATION_MAX_IMAGE_BYTES) {
      dropped.push(entry.image);
      continue;
    }
    if (ALLOWLISTED_MEDIA[extensionOf(entry.image)] === undefined) {
      dropped.push(entry.image);
      continue;
    }
    if (readRasterHeader(bytes)?.mediaType !== ALLOWLISTED_MEDIA[extensionOf(entry.image)]) {
      dropped.push(entry.image);
      continue;
    }
    views.push({ view: entry.view, imagePath: entry.image, label: entry.label ?? null });
  }
  if (views.length === 0) {
    return { views: [], warning: `Reference image “${dropped[0] ?? candidates[0]!.image}” is missing or too large; showing the measured diagram instead.` };
  }
  if (dropped.length > 0) {
    return { views, warning: `Reference image “${dropped[0]}” is missing or too large; showing the measured diagram instead.` };
  }
  return { views, warning: null };
}

/**
 * Select the reference GLB model for the current product/variant. Exact-id
 * match only; variant-scoped entries win over product-wide ones. The model
 * must be present, within the model byte bound, `.glb`-suffixed, and pass the
 * full self-contained subset check (blocking `validateSelfContained` issues;
 * `-advisory` notes pass). External-URI models are rejected with a warning.
 * Returns a warning (not a path) otherwise.
 */
export function selectPresentationModel(
  manifest: PresentationManifest | null,
  manifestPresent: boolean,
  productId: string,
  variantId: string,
  lookup: PresentationAssetLookup,
): PresentationModelSelection {
  if (!manifestPresent) return { modelPath: null, label: null, warning: null };
  if (!manifest) return { modelPath: null, label: null, warning: 'Reference preview data was invalid and has been ignored.' };
  if (manifest.version !== 2 || !manifest.models || manifest.models.length === 0) {
    // A valid one-input package may be image-only — benign, not a warning.
    return { modelPath: null, label: null, warning: null };
  }
  const candidates = manifest.models.filter((entry) => entry.productId === productId);
  if (candidates.length === 0) {
    return { modelPath: null, label: null, warning: null };
  }
  const scoped = candidates.find((entry) => entry.variantId === variantId)
    ?? candidates.find((entry) => entry.variantId === undefined);
  if (!scoped) {
    return { modelPath: null, label: null, warning: null };
  }
  const bytes = lookup(scoped.model);
  if (!bytes || bytes.length === 0 || bytes.length > PRESENTATION_MAX_MODEL_BYTES) {
    return { modelPath: null, label: null, warning: `Reference model “${scoped.model}” is missing or too large; showing the measured diagram instead.` };
  }
  if (extensionOf(scoped.model) !== '.glb') {
    return { modelPath: null, label: null, warning: `Reference model “${scoped.model}” is not a supported model format; showing the measured diagram instead.` };
  }
  let parsed: { json: unknown };
  try {
    parsed = parseGlb(bytes);
  } catch {
    return { modelPath: null, label: null, warning: `Reference model “${scoped.model}” is not a valid model; showing the measured diagram instead.` };
  }
  const blocking = validateSelfContained(parsed.json).filter((issue) => !issue.code.endsWith('-advisory'));
  if (blocking.length > 0) {
    const external = blocking.some((issue) => issue.code === 'asset-external-uri');
    return { modelPath: null, label: null, warning: `Reference model “${scoped.model}” is not a self-contained model${external ? ' (external reference)' : ''}; showing the measured diagram instead.` };
  }
  return { modelPath: scoped.model, label: scoped.label ?? null, warning: null };
}

export const PRESENTATION_MANIFEST_PATH = 'presentation/preview.json';
export const PRESENTATION_MAX_IMAGE_BYTES = MAX_PREVIEW_BYTES;
export const PRESENTATION_MAX_IMAGE_PIXELS = MAX_PREVIEW_PIXELS;
export const PRESENTATION_MAX_MODEL_BYTES = 16 * 1024 * 1024;

/**
 * Decode a validated raster package asset to a blob URL for display.
 * Rejects SVG/HTML/remote content; enforces byte and pixel bounds; revokes
 * nothing (caller owns prior URLs). Returns null on any failure.
 */
export async function decodePresentationRaster(
  bytes: Uint8Array,
  fileExtension: string,
): Promise<{ url: string; mediaType: string } | null> {
  try {
    const mediaType = ALLOWLISTED_MEDIA[fileExtension.toLowerCase()];
    if (!mediaType || bytes.length === 0 || bytes.length > PRESENTATION_MAX_IMAGE_BYTES) return null;
    const header = readRasterHeader(bytes);
    if (!header || header.mediaType !== mediaType) return null;
    const blob = new Blob([bytes as BlobPart], { type: mediaType });
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width; const height = bitmap.height;
    bitmap.close();
    if (width !== header.width || height !== header.height || width * height > PRESENTATION_MAX_IMAGE_PIXELS) return null;
    return { url: URL.createObjectURL(blob), mediaType };
  } catch {
    return null;
  }
}

/**
 * Validate hostile-input handling without a DOM: parse + select against
 * synthetic bytes. Used by Node unit tests (no browser, no network).
 */
export function describePresentationInputs(input: {
  manifestBytes?: Uint8Array;
  manifestPresent: boolean;
  productId: string;
  variantId: string;
  assets: ReadonlyMap<string, Uint8Array>;
}): PresentationSelection {
  try {
    const manifest = parsePresentationManifest(input.manifestBytes);
    return selectPresentationReference(
      manifest,
      input.manifestPresent,
      input.productId,
      input.variantId,
      (path) => input.assets.get(path),
    );
  } catch (error) {
    return { imagePath: null, label: null, warning: `Reference preview unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Preserve only explicitly selected, bounded optional reference images when issuing a job. */
export function selectPresentationPackageAssets(
  assets: readonly { path: string; bytes: Uint8Array; kind?: string }[],
  configurations: readonly { productId: string; variantId: string }[],
): Array<{ path: string; bytes: Uint8Array }> {
  const manifest = parsePresentationManifest(assets.find((asset) => asset.path === PRESENTATION_MANIFEST_PATH && asset.kind === 'additional')?.bytes);
  const mappings = parsePhotoMappings(assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes);
  if (!manifest) return [];
  /**
   * Photo-mapping passthrough: optional `presentation/photo-mappings.json`
   * entries travel as an additional asset, filtered by issued configuration
   * and restricted to retained raster images. Malformed files are dropped;
   * v1/v2 reader output is otherwise byte-identical to before.
   */
  const selectMappingAssets = (retainedRasterPaths: ReadonlySet<string>): Array<{ path: string; bytes: Uint8Array }> => {
    if (!mappings) return [];
    const retained = mappings.mappings.filter((entry) =>
      validatePhotoMapping(entry).length === 0 &&
      retainedRasterPaths.has(entry.image) &&
      configurations.some((configuration) =>
        configuration.productId === entry.productId &&
        (entry.variantId === undefined || configuration.variantId === entry.variantId)));
    if (retained.length === 0) return [];
    return [{ path: PHOTO_MAPPINGS_PATH, bytes: serializePhotoMappings({ version: 1, mappings: retained }) }];
  };
  if (manifest.version === 2) {
    const retainedViews = manifest.views.filter((entry) => configurations.some((configuration) =>
      configuration.productId === entry.productId && (entry.variantId === undefined || configuration.variantId === entry.variantId)))
      .filter((entry) => {
        const asset = assets.find((candidate) => candidate.path === entry.image && candidate.kind === 'additional');
        return asset !== undefined && readRasterHeader(asset.bytes)?.mediaType === ALLOWLISTED_MEDIA[extensionOf(entry.image)];
      });
    const retainedModels = (manifest.models ?? []).filter((entry) => configurations.some((configuration) =>
      configuration.productId === entry.productId && (entry.variantId === undefined || configuration.variantId === entry.variantId)))
      .filter((entry) => {
        const asset = assets.find((candidate) => candidate.path === entry.model && candidate.kind === 'additional');
        if (asset === undefined || asset.bytes.length === 0 || asset.bytes.length > PRESENTATION_MAX_MODEL_BYTES) return false;
        if (extensionOf(entry.model) !== '.glb') return false;
        let parsed: { json: unknown };
        try {
          parsed = parseGlb(asset.bytes);
        } catch {
          return false;
        }
        return validateSelfContained(parsed.json).filter((issue) => !issue.code.endsWith('-advisory')).length === 0;
      });
    const retainedReferences = (manifest.references ?? []).filter((entry) => configurations.some((configuration) =>
      configuration.productId === entry.productId && (entry.variantId === undefined || configuration.variantId === entry.variantId)))
      .filter((entry) => {
        const asset = assets.find((candidate) => candidate.path === entry.image && candidate.kind === 'additional');
        return asset !== undefined && readRasterHeader(asset.bytes)?.mediaType === ALLOWLISTED_MEDIA[extensionOf(entry.image)];
      });
    if (retainedViews.length === 0 && retainedModels.length === 0 && retainedReferences.length === 0) return [];
    const sortedViews = [...retainedViews].sort((a, b) => (a.image < b.image ? -1 : a.image > b.image ? 1 : 0));
    const sortedModels = [...retainedModels].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    const sortedReferences = [...retainedReferences].sort((a, b) => (a.image < b.image ? -1 : a.image > b.image ? 1 : 0));
    const rewritten: { version: 2; views: typeof sortedViews; models?: typeof sortedModels; references?: typeof sortedReferences } = { version: 2, views: sortedViews };
    if (sortedModels.length > 0) rewritten.models = sortedModels;
    if (sortedReferences.length > 0) rewritten.references = sortedReferences;
    const paths = [...new Set([...sortedViews.map((entry) => entry.image), ...sortedModels.map((entry) => entry.model), ...sortedReferences.map((entry) => entry.image)])].sort();
    const rasterPaths = new Set([...sortedViews.map((entry) => entry.image), ...sortedReferences.map((entry) => entry.image)]);
    return [{ path: PRESENTATION_MANIFEST_PATH, bytes: new TextEncoder().encode(JSON.stringify(rewritten)) },
      ...selectMappingAssets(rasterPaths),
      ...paths.map((path) => ({ path, bytes: assets.find((asset) => asset.path === path)!.bytes }))];
  }
  const retained = manifest.references.filter((entry) => configurations.some((configuration) =>
    configuration.productId === entry.productId && (entry.variantId === undefined || configuration.variantId === entry.variantId)))
    .filter((entry) => {
      const asset = assets.find((candidate) => candidate.path === entry.image && candidate.kind === 'additional');
      return asset !== undefined && readRasterHeader(asset.bytes)?.mediaType === ALLOWLISTED_MEDIA[extensionOf(entry.image)];
    });
  if (!retained.length) return [];
  const paths = [...new Set(retained.map((entry) => entry.image))].sort();
  return [{ path: PRESENTATION_MANIFEST_PATH, bytes: new TextEncoder().encode(JSON.stringify({ version: 1, references: retained })) },
    ...selectMappingAssets(new Set(paths)),
    ...paths.map((path) => ({ path, bytes: assets.find((asset) => asset.path === path)!.bytes }))];
}
