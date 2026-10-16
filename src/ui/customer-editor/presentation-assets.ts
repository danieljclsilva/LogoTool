import { readRasterHeader, MAX_PREVIEW_BYTES, MAX_PREVIEW_PIXELS } from '../../assets/raster-header.js';
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
 * raster images, stored as `additional` (never `referenced`) entries inside
 * `.logo-project`. Only paths explicitly present in the opened package are
 * used; product/variant ids must match the current selection; no filename
 * inference, no hardcoded product behaviour, no remote URLs.
 */

export interface PresentationReferenceEntry {
  productId: string;
  variantId?: string;
  image: string;
  label?: string;
}

export interface PresentationManifest {
  version: 1;
  references: PresentationReferenceEntry[];
}

export interface PresentationSelection {
  /** Explicit package path of the validated raster image, or null. */
  imagePath: string | null;
  label: string | null;
  /** Concise warning when the manifest existed but yielded no usable image. */
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

function isRemoteUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('//')
  );
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
  if (record['version'] !== 1 || !Array.isArray(record['references'])) return null;
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
    if (isRemoteUrl(item['image']) || !item['image'].startsWith('presentation/') || item['image'].split('/').some((part) => part === '' || part === '.' || part === '..') || item['image'].includes('\\') || item['image'].includes(':')) return null;
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

export const PRESENTATION_MANIFEST_PATH = 'presentation/preview.json';
export const PRESENTATION_MAX_IMAGE_BYTES = MAX_PREVIEW_BYTES;
export const PRESENTATION_MAX_IMAGE_PIXELS = MAX_PREVIEW_PIXELS;

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
    return { imagePath: null, label: null, warning: `Reference preview unavailable: ${errorMessage(error)}` };
  }
}

/** Preserve only explicitly selected, bounded optional reference images when issuing a job. */
export function selectPresentationPackageAssets(
  assets: readonly { path: string; bytes: Uint8Array; kind?: string }[],
  configurations: readonly { productId: string; variantId: string }[],
): Array<{ path: string; bytes: Uint8Array }> {
  const manifest = parsePresentationManifest(assets.find((asset) => asset.path === PRESENTATION_MANIFEST_PATH && asset.kind === 'additional')?.bytes);
  if (!manifest) return [];
  const retained = manifest.references.filter((entry) => configurations.some((configuration) =>
    configuration.productId === entry.productId && (entry.variantId === undefined || configuration.variantId === entry.variantId)))
    .filter((entry) => {
      const asset = assets.find((candidate) => candidate.path === entry.image && candidate.kind === 'additional');
      return asset !== undefined && readRasterHeader(asset.bytes)?.mediaType === ALLOWLISTED_MEDIA[extensionOf(entry.image)];
    });
  if (!retained.length) return [];
  const paths = [...new Set(retained.map((entry) => entry.image))].sort();
  return [{ path: PRESENTATION_MANIFEST_PATH, bytes: new TextEncoder().encode(JSON.stringify({ version: 1, references: retained })) },
    ...paths.map((path) => ({ path, bytes: assets.find((asset) => asset.path === path)!.bytes }))];
}
