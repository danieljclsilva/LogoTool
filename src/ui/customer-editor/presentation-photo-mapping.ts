import { readRasterHeader, MAX_PREVIEW_BYTES } from '../../assets/raster-header.js';

/**
 * OPTIONAL presentation-only photo-mapping adapter.
 *
 * Boundary: presentation-only and external to the canonical production/domain
 * schema. It never mutates the project, never influences geometry/validation/
 * export, and never fabricates a calibrated placement. The measured placement
 * diagram (exact domain millimetres) remains the source of truth.
 *
 * Data contract (`presentation/photo-mappings.json`, kind `additional`):
 * region-mm -> normalized image UV, `u = a*x + b*y + c`, `v = d*x + e*y + f`.
 *
 * Y convention (handled explicitly, never hidden):
 * - Region millimetres are Y-UP (domain frame).
 * - Image UV is normalized with v = 0 at the TOP (raster row 0).
 * The flip is baked into the calibration coefficients (typically `e < 0`);
 * this adapter applies the raw affine with no silent negation, and the
 * inverse is the exact algebraic inverse of the forward map.
 */

export const PHOTO_MAPPINGS_PATH = 'presentation/photo-mappings.json';

const MAX_PHOTO_MAPPINGS_BYTES = 64 * 1024;
const MAX_PHOTO_MAPPINGS = 32;

/**
 * Stable view identity independent of the human label. A mapping stays bound
 * to its exact image + view/viewId + scope when the label is renamed: labels
 * never validate, never invalidate and never identify. Bounded so envelopes
 * stay small and deterministic.
 */
export const MAX_PHOTO_VIEW_ID_LENGTH = 128;
/** Display-only view label bound (labels never affect identity or math). */
export const MAX_PHOTO_VIEW_LABEL_LENGTH = 80;

/** Minimum |determinant| for an invertible mapping. */
const MIN_ABS_DET = 1e-12;

export type PhotoMappingView = 'front' | 'back' | 'left' | 'right';

export type PhotoMappingStatus = 'provisional' | 'review';

export interface PhotoMappingTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface PhotoMappingEntry {
  productId: string;
  variantId?: string;
  regionId: string;
  view: PhotoMappingView;
  /**
   * Stable view identity for flexible named views (W3-owned intake workspace).
   * The legacy `view` bucket above stays for mapping math and backward
   * compatibility; `viewId` is the true identity and defaults to `view` when
   * absent. Identity matching is exact; the display `label` never identifies.
   */
  viewId?: string;
  /** Display-only human label for the view (never validated as identity). */
  label?: string;
  /** Exact `presentation/` raster path; must match the issued image asset. */
  image: string;
  /** Region-mm (Y-up) -> normalized UV (v = 0 at top). */
  transform: PhotoMappingTransform;
  calibrationId: string;
  calibrationVersion: string;
  status: PhotoMappingStatus;
  note?: string;
}

export interface PhotoMappingsV1 {
  version: 1;
  mappings: PhotoMappingEntry[];
}

/**
 * Envelope version 2: same mapping shape, but entries may carry `viewId`
 * (stable identity) and `label` (display-only). Writers emit version 2 only
 * when at least one entry carries view identity; readers accept both
 * versions (see {@link parsePhotoMappings}, which normalizes to the shared
 * entry shape so existing callers keep compiling).
 */
export interface PhotoMappingsV2 {
  version: 2;
  mappings: PhotoMappingEntry[];
}

/** Either accepted photo-mappings envelope version. */
export type PhotoMappings = PhotoMappingsV1 | PhotoMappingsV2;

export interface PhotoMappingSelection {
  mapping: PhotoMappingEntry | null;
  warning: string | null;
}

export interface RegionMmPoint {
  xMm: number;
  yMm: number;
}

export interface NormalizedUv {
  u: number;
  v: number;
}

export interface PresentationAssetLookup {
  (path: string): Uint8Array | undefined;
}

const VIEW_LOOKUP: Record<string, true> = { front: true, back: true, left: true, right: true };
const STATUS_LOOKUP: Record<string, true> = { provisional: true, review: true };

const ALLOWLISTED_MEDIA: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

/**
 * Same path semantics as the presentation manifest reader: relative
 * `presentation/` path, no backslashes/colons/empty/dot segments, no remotes.
 */
function isValidMappingImagePath(value: string): boolean {
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function determinant(t: PhotoMappingTransform): number {
  return t.a * t.e - t.b * t.d;
}

/**
 * Structural + mathematical validation of one mapping entry.
 * Returns error strings; empty means valid. Never throws.
 */
export function validatePhotoMapping(entry: unknown): string[] {
  const errors: string[] = [];
  if (typeof entry !== 'object' || entry === null) return ['mapping must be an object'];
  const item = entry as Record<string, unknown>;
  if (typeof item['productId'] !== 'string' || item['productId'].length === 0) {
    errors.push('productId must be a non-empty string');
  }
  if (item['variantId'] !== undefined && (typeof item['variantId'] !== 'string' || item['variantId'].length === 0)) {
    errors.push('variantId must be a non-empty string when present');
  }
  if (typeof item['regionId'] !== 'string' || item['regionId'].length === 0) {
    errors.push('regionId must be a non-empty string');
  }
  if (typeof item['view'] !== 'string' || VIEW_LOOKUP[item['view']] !== true) {
    errors.push('view must be one of front|back|left|right');
  }
  if (item['viewId'] !== undefined) {
    if (typeof item['viewId'] !== 'string' || item['viewId'].trim().length === 0) {
      errors.push('viewId must be a non-empty string when present');
    } else if (item['viewId'].length > MAX_PHOTO_VIEW_ID_LENGTH) {
      errors.push(`viewId must be at most ${MAX_PHOTO_VIEW_ID_LENGTH} characters`);
    }
  }
  if (item['label'] !== undefined) {
    if (typeof item['label'] !== 'string') {
      errors.push('label must be a string when present');
    } else if (item['label'].length > MAX_PHOTO_VIEW_LABEL_LENGTH) {
      errors.push(`label must be at most ${MAX_PHOTO_VIEW_LABEL_LENGTH} characters`);
    }
  }
  if (typeof item['image'] !== 'string' || item['image'].length === 0) {
    errors.push('image must be a non-empty string');
  } else if (!isValidMappingImagePath(item['image'])) {
    errors.push(`image "${item['image']}" is not a safe presentation/ path`);
  } else if (ALLOWLISTED_MEDIA[extensionOf(item['image'])] === undefined) {
    errors.push(`image "${item['image']}" must be a raster (.png/.jpg/.jpeg/.webp)`);
  }
  const raw = item['transform'];
  if (typeof raw !== 'object' || raw === null) {
    errors.push('transform must be an object {a,b,c,d,e,f}');
  } else {
    const t = raw as Record<string, unknown>;
    let finite = true;
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      if (!isFiniteNumber(t[key])) {
        errors.push(`transform.${key} must be a finite number`);
        finite = false;
      }
    }
    if (finite) {
      const det = (t['a'] as number) * (t['e'] as number) - (t['b'] as number) * (t['d'] as number);
      if (!Number.isFinite(det) || Math.abs(det) <= MIN_ABS_DET) {
        errors.push('transform must be non-degenerate (|det| > 1e-12)');
      }
    }
  }
  if (typeof item['calibrationId'] !== 'string' || item['calibrationId'].length === 0) {
    errors.push('calibrationId must be a non-empty string');
  }
  if (typeof item['calibrationVersion'] !== 'string' || item['calibrationVersion'].length === 0) {
    errors.push('calibrationVersion must be a non-empty string');
  }
  if (typeof item['status'] !== 'string' || STATUS_LOOKUP[item['status']] !== true) {
    errors.push('status must be provisional|review');
  }
  if (item['note'] !== undefined && typeof item['note'] !== 'string') {
    errors.push('note must be a string when present');
  }
  return errors;
}

function toValidatedEntry(item: Record<string, unknown>): PhotoMappingEntry | null {
  if (validatePhotoMapping(item).length > 0) return null;
  const t = item['transform'] as Record<string, number>;
  const entry: PhotoMappingEntry = {
    productId: item['productId'] as string,
    regionId: item['regionId'] as string,
    view: item['view'] as PhotoMappingView,
    image: item['image'] as string,
    transform: {
      a: t['a'] as number,
      b: t['b'] as number,
      c: t['c'] as number,
      d: t['d'] as number,
      e: t['e'] as number,
      f: t['f'] as number,
    },
    calibrationId: item['calibrationId'] as string,
    calibrationVersion: item['calibrationVersion'] as string,
    status: item['status'] as PhotoMappingStatus,
  };
  if (typeof item['variantId'] === 'string') entry.variantId = item['variantId'];
  if (typeof item['viewId'] === 'string') entry.viewId = item['viewId'];
  if (typeof item['label'] === 'string') entry.label = item['label'];
  if (typeof item['note'] === 'string') entry.note = item['note'];
  return entry;
}

/**
 * Parse an optional photo-mappings file. Accepts envelope version 1 and 2
 * (backward reader) and normalizes to the shared entry shape so existing
 * callers keep compiling; entries preserve `viewId`/`label` when present.
 * Returns null when absent or invalid (invalid data is dropped, never thrown
 * past the UI). Never mutates input.
 */
export function parsePhotoMappings(mappingsBytes: Uint8Array | undefined): PhotoMappingsV1 | null {
  if (!mappingsBytes || mappingsBytes.length === 0) return null;
  if (mappingsBytes.length > MAX_PHOTO_MAPPINGS_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mappingsBytes));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record['version'] !== 1 && record['version'] !== 2) return null;
  if (!Array.isArray(record['mappings'])) return null;
  const list = record['mappings'] as unknown[];
  if (list.length === 0 || list.length > MAX_PHOTO_MAPPINGS) return null;
  const mappings: PhotoMappingEntry[] = [];
  for (const candidate of list) {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const entry = toValidatedEntry(candidate as Record<string, unknown>);
    if (!entry) return null;
    mappings.push(entry);
  }
  return { version: 1, mappings };
}

/**
 * Deterministic serialization: entries sorted by
 * (productId, variantId, regionId, view, viewId, image) with fixed key order
 * and no whitespace. Byte-stable across input key order and entry order.
 * Legacy entries (no `viewId`/`label`) serialize to a version-1 envelope
 * byte-identical to previous writers; any view identity upgrades the
 * envelope to version 2 (readers accept both).
 */
export function serializePhotoMappings(mappings: PhotoMappingsV1 | PhotoMappingsV2): Uint8Array {
  const sorted = [...mappings.mappings].sort((x, y) => {
    const keys = [
      [x.productId, y.productId],
      [x.variantId ?? '', y.variantId ?? ''],
      [x.regionId, y.regionId],
      [x.view, y.view],
      [x.viewId ?? '', y.viewId ?? ''],
      [x.image, y.image],
    ] as Array<[string, string]>;
    for (const [a, b] of keys) {
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  });
  const version = sorted.some((entry) => entry.viewId !== undefined || entry.label !== undefined) ? 2 : 1;
  const normalized = sorted.map((entry) => {
    // Fixed key order: legacy order preserved byte-for-byte for legacy
    // entries (`label` slots after `image`, `viewId` after `view`, each only
    // when present).
    const out: Record<string, unknown> = {
      calibrationId: entry.calibrationId,
      calibrationVersion: entry.calibrationVersion,
      image: entry.image,
    };
    if (entry.label !== undefined) out['label'] = entry.label;
    out['productId'] = entry.productId;
    out['regionId'] = entry.regionId;
    out['status'] = entry.status;
    out['transform'] = {
      a: entry.transform.a,
      b: entry.transform.b,
      c: entry.transform.c,
      d: entry.transform.d,
      e: entry.transform.e,
      f: entry.transform.f,
    };
    if (entry.variantId !== undefined) out['variantId'] = entry.variantId;
    out['view'] = entry.view;
    if (entry.viewId !== undefined) out['viewId'] = entry.viewId;
    if (entry.note !== undefined) out['note'] = entry.note;
    return out;
  });
  return new TextEncoder().encode(JSON.stringify({ version, mappings: normalized }));
}

/**
 * Forward map: region millimetres (Y-up) -> normalized UV (v = 0 at top).
 * Returns null for non-finite inputs or a degenerate/non-finite transform.
 */
export function forwardPhotoMapping(entry: PhotoMappingEntry, pointMm: RegionMmPoint): NormalizedUv | null {
  const t = entry.transform;
  if (!isFiniteNumber(pointMm.xMm) || !isFiniteNumber(pointMm.yMm)) return null;
  for (const value of [t.a, t.b, t.c, t.d, t.e, t.f] as const) {
    if (!Number.isFinite(value)) return null;
  }
  const det = determinant(t);
  if (!Number.isFinite(det) || Math.abs(det) <= MIN_ABS_DET) return null;
  const u = t.a * pointMm.xMm + t.b * pointMm.yMm + t.c;
  const v = t.d * pointMm.xMm + t.e * pointMm.yMm + t.f;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return { u, v };
}

/**
 * Inverse map: normalized UV (v = 0 at top) -> region millimetres (Y-up).
 * Exact algebraic inverse of `forwardPhotoMapping`; null when degenerate.
 */
export function inversePhotoMapping(entry: PhotoMappingEntry, uv: NormalizedUv): RegionMmPoint | null {
  const t = entry.transform;
  if (!isFiniteNumber(uv.u) || !isFiniteNumber(uv.v)) return null;
  for (const value of [t.a, t.b, t.c, t.d, t.e, t.f] as const) {
    if (!Number.isFinite(value)) return null;
  }
  const det = determinant(t);
  if (!Number.isFinite(det) || Math.abs(det) <= MIN_ABS_DET) return null;
  const du = uv.u - t.c;
  const dv = uv.v - t.f;
  const xMm = (t.e * du - t.b * dv) / det;
  const yMm = (-t.d * du + t.a * dv) / det;
  if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) return null;
  return { xMm, yMm };
}

/**
 * Correspondence between a normalized image point and an explicitly entered
 * region-millimetre point. Millimetre values are operator-entered against an
 * explicit region frame; they are never derived from pixels.
 */
export interface PhotoMappingCorrespondence {
  uv: { u: number; v: number };
  mm: { xMm: number; yMm: number };
}

/**
 * Solve the affine region-mm (Y-up) -> normalized UV map
 * (`u = a*x+b*y+c`, `v = d*x+e*y+f`) by least squares over caller-supplied
 * correspondences. Pure math: no DOM, no assets, no pixel access.
 *
 * Returns null when the fit is unusable: fewer than 3 usable pairs, any
 * non-finite coordinate, all-collinear (or coincident) mm points, a singular
 * normal system, or a non-finite/non-invertible result
 * (|det| <= 1e-12, same bound as `validatePhotoMapping`).
 */
export function solveAffineFromCorrespondences(
  pairs: PhotoMappingCorrespondence[],
): PhotoMappingTransform | null {
  if (!Array.isArray(pairs) || pairs.length < 3) return null;
  const xMm: number[] = [];
  const ys: number[] = [];
  const us: number[] = [];
  const vs: number[] = [];
  for (const pair of pairs) {
    if (typeof pair !== 'object' || pair === null) return null;
    const u = pair.uv?.u;
    const v = pair.uv?.v;
    const x = pair.mm?.xMm;
    const y = pair.mm?.yMm;
    if (!isFiniteNumber(u) || !isFiniteNumber(v) || !isFiniteNumber(x) || !isFiniteNumber(y)) {
      return null;
    }
    xMm.push(x);
    ys.push(y);
    us.push(u);
    vs.push(v);
  }
  const n = xMm.length;
  // Explicit collinearity refusal (scale-aware): the centered second moments
  // of the mm points must span a genuine area, otherwise the fit has no
  // unique solution regardless of solver behaviour.
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i += 1) {
    meanX += xMm[i]!;
    meanY += ys[i]!;
  }
  meanX /= n;
  meanY /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xMm[i]! - meanX;
    const dy = ys[i]! - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const spread = sxx + syy;
  if (!Number.isFinite(spread) || spread <= 0) return null;
  const planar = sxx * syy - sxy * sxy;
  if (!Number.isFinite(planar) || planar <= 1e-12 * spread * spread) return null;
  // Normal equations M * [a,b,c] = rhsU, M * [d,e,f] = rhsV with
  // M = [[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,N]] over raw (uncentered) moments.
  let Sxx = 0;
  let Syy = 0;
  let Sxy = 0;
  let Sx = 0;
  let Sy = 0;
  let Su = 0;
  let Sv = 0;
  let Sxu = 0;
  let Syu = 0;
  let Sxv = 0;
  let Syv = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xMm[i]!;
    const y = ys[i]!;
    const u = us[i]!;
    const v = vs[i]!;
    Sxx += x * x;
    Syy += y * y;
    Sxy += x * y;
    Sx += x;
    Sy += y;
    Su += u;
    Sv += v;
    Sxu += x * u;
    Syu += y * u;
    Sxv += x * v;
    Syv += y * v;
  }
  const normal: number[][] = [
    [Sxx, Sxy, Sx],
    [Sxy, Syy, Sy],
    [Sx, Sy, n],
  ];
  const abc = solveSymmetric3(normal, [Sxu, Syu, Su]);
  const def = solveSymmetric3(normal, [Sxv, Syv, Sv]);
  if (abc === null || def === null) return null;
  const candidate = { a: abc[0]!, b: abc[1]!, c: abc[2]!, d: def[0]!, e: def[1]!, f: def[2]! };
  for (const value of [candidate.a, candidate.b, candidate.c, candidate.d, candidate.e, candidate.f]) {
    if (!Number.isFinite(value)) return null;
  }
  const det = candidate.a * candidate.e - candidate.b * candidate.d;
  if (!Number.isFinite(det) || Math.abs(det) <= MIN_ABS_DET) return null;
  return candidate;
}

/** Gaussian elimination with partial pivoting for a 3x3 system; null when singular. */
function solveSymmetric3(matrix: number[][], rhs: number[]): [number, number, number] | null {
  const a: number[][] = [
    [matrix[0]![0]!, matrix[0]![1]!, matrix[0]![2]!, rhs[0]!],
    [matrix[1]![0]!, matrix[1]![1]!, matrix[1]![2]!, rhs[1]!],
    [matrix[2]![0]!, matrix[2]![1]!, matrix[2]![2]!, rhs[2]!],
  ];
  let scale = 0;
  for (const row of a) {
    for (const value of row) {
      if (Number.isFinite(value)) scale = Math.max(scale, Math.abs(value));
    }
  }
  if (!(scale > 0)) return null;
  const singularAt = 1e-12 * scale;
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    }
    if (!Number.isFinite(a[pivot]![col]!) || Math.abs(a[pivot]![col]!) <= singularAt) return null;
    if (pivot !== col) {
      const tmp = a[col]!;
      a[col] = a[pivot]!;
      a[pivot] = tmp;
    }
    const divisor = a[col]![col]!;
    for (let row = col + 1; row < 3; row += 1) {
      const factor = a[row]![col]! / divisor;
      if (!Number.isFinite(factor)) return null;
      for (let k = col; k < 4; k += 1) {
        a[row]![k] = a[row]![k]! - factor * a[col]![k]!;
      }
    }
  }
  const out: number[] = [0, 0, 0];
  for (let row = 2; row >= 0; row -= 1) {
    const divisor = a[row]![row]!;
    if (!Number.isFinite(divisor) || Math.abs(divisor) <= singularAt) return null;
    let value = a[row]![3]!;
    for (let k = row + 1; k < 3; k += 1) value -= a[row]![k]! * out[k]!;
    value /= divisor;
    if (!Number.isFinite(value)) return null;
    out[row] = value;
  }
  return [out[0]!, out[1]!, out[2]!];
}
/**
 * Caller-evaluated binding context for one mapping use. The mapping must
 * agree with the CURRENT product/variant/region selection, the region's own
 * calibration reference, and an explicitly declared preview view+image pair.
 * Anything else is stale (edited package, swapped calibration, relabelled
 * photo) and must fall back to the measured diagram.
 */
export interface PhotoMappingContext {
  productId: string;
  variantId: string;
  regionId: string;
  calibrationId: string;
  calibrationVersion: string;
  /** Declared preview views for the configuration; entry view+image must match one exactly. */
  manifestViews: ReadonlyArray<{ view: string; viewId?: string; image: string }>;
}

/**
 * Stable view identity of one mapping entry: the explicit `viewId` when
 * present, else the legacy `view` bucket. Pure. The lead's intake mapping key
 * (`mappingKeyOf`) should incorporate this (not the display label) so file
 * replacement retires only the affected view's evidence.
 */
export function mappingViewIdOf(entry: Pick<PhotoMappingEntry, 'view' | 'viewId'>): string {
  return entry.viewId ?? entry.view;
}

/**
 * Display-only label for one mapping entry: the trimmed `label` when
 * non-blank, else the caller-supplied fallback (legacy bucket text, image
 * path, …). Labels never affect identity, validation or math. Pure.
 */
export function mappingDisplayLabel(
  entry: Pick<PhotoMappingEntry, 'label'>,
  fallback: string,
): string {
  const label = entry.label?.trim() ?? '';
  return label.length > 0 ? label : fallback;
}

/**
 * Context validation of one mapping entry against the current selection,
 * region calibration and declared preview views. Returns error strings;
 * empty means the entry is current. Never throws.
 */
export function validateMappingContext(entry: PhotoMappingEntry, context: PhotoMappingContext): string[] {
  const errors: string[] = [];
  if (entry.productId !== context.productId) {
    errors.push(`mapping product "${entry.productId}" does not match the current product "${context.productId}"`);
  }
  if (entry.variantId !== undefined && entry.variantId !== context.variantId) {
    errors.push(`mapping variant "${entry.variantId}" does not match the current option "${context.variantId}"`);
  }
  if (entry.regionId !== context.regionId) {
    errors.push(`mapping region "${entry.regionId}" does not match the current logo area "${context.regionId}"`);
  }
  if (entry.calibrationId !== context.calibrationId || entry.calibrationVersion !== context.calibrationVersion) {
    errors.push(`mapping calibration ${entry.calibrationId} ${entry.calibrationVersion} does not match the logo area calibration ${context.calibrationId} ${context.calibrationVersion}`);
  }
  const declared = context.manifestViews.some((view) => {
    if (view.image !== entry.image) return false;
    // Labels never validate: only image + view identity bind. When the
    // mapping declares a stable viewId, a manifest viewId must agree when the
    // manifest declares one; otherwise the legacy view bucket must agree.
    if (entry.viewId !== undefined) {
      if (view.viewId !== undefined) return view.viewId === entry.viewId;
      return view.view === entry.view;
    }
    return view.view === entry.view;
  });
  if (!declared) {
    errors.push(`mapping photo "${entry.image}" (${entry.view}) is not a declared preview view for this product option`);
  }
  return errors;
}

/**
 * Artwork-on-photo affine matrix through a validated mapping: artwork-local
 * unit coordinates (s in [0,1] left-to-right, t in [0,1] TOP-to-bottom,
 * matching raster row order) into photo pixels. Composes the authoritative
 * placement (center/size, clockwise-positive rotationDeg facing the region)
 * with the region-mm to normalized-UV affine and the pixel scaling, so
 * rotated artwork under shear, anisotropic scaling or reflection renders as
 * the true parallelogram. A width-axis rect plus a single angle cannot
 * reproduce the four domain footprint corners there. Render as
 * `<image x="0" y="0" width="1" height="1" preserveAspectRatio="none"
 * transform="matrix(a b c d e f)">`. Returns null for degenerate inputs
 * (non-finite, non-positive sizes/photo, singular composition). Pure math.
 */
export interface PhotoArtworkPlacement {
  /** Artwork bbox center in the region frame (mm, Y-up). */
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Clockwise-positive facing the region, (-180, 180]. */
  rotationDeg: number;
}

export interface PhotoArtworkMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function artworkPhotoMatrix(
  transform: PhotoMappingTransform,
  photoWidthPx: number,
  photoHeightPx: number,
  placement: PhotoArtworkPlacement,
): PhotoArtworkMatrix | null {
  const det = determinant(transform);
  if (!Number.isFinite(det) || Math.abs(det) <= MIN_ABS_DET) return null;
  for (const value of [
    transform.a, transform.b, transform.c, transform.d, transform.e, transform.f,
    photoWidthPx, photoHeightPx,
    placement.xMm, placement.yMm, placement.widthMm, placement.heightMm, placement.rotationDeg,
  ]) {
    if (!Number.isFinite(value)) return null;
  }
  if (!(placement.widthMm > 0) || !(placement.heightMm > 0)) return null;
  if (!(photoWidthPx > 0) || !(photoHeightPx > 0)) return null;
  // Artwork-local (s,t) to region mm, matching the domain validator
  // footprint (placementFootprint: x' = x + dx*cos + dy*sin,
  // y' = y - dx*sin + dy*cos with the down axis as dy = -h*(t-.5)):
  // xMm = cx + cos*w*(s-.5) - sin*h*(t-.5)
  // yMm = cy - sin*w*(s-.5) - cos*h*(t-.5).
  // (A +sin x-height term would shear except at multiples of 90 degrees and
  // goes singular at 45 degrees; the validator form stays rigid.)
  const turn = (placement.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const mmToPx = (xMm: number, yMm: number): { x: number; y: number } => ({
    x: (transform.a * xMm + transform.b * yMm + transform.c) * photoWidthPx,
    y: (transform.d * xMm + transform.e * yMm + transform.f) * photoHeightPx,
  });
  const corner = (s: number, t: number): { x: number; y: number } => mmToPx(
    placement.xMm + cos * placement.widthMm * (s - 0.5) - sin * placement.heightMm * (t - 0.5),
    placement.yMm - sin * placement.widthMm * (s - 0.5) - cos * placement.heightMm * (t - 0.5),
  );
  const p00 = corner(0, 0);
  const p10 = corner(1, 0);
  const p01 = corner(0, 1);
  const matrix = {
    a: p10.x - p00.x,
    b: p10.y - p00.y,
    c: p01.x - p00.x,
    d: p01.y - p00.y,
    e: p00.x,
    f: p00.y,
  };
  for (const value of [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]) {
    if (!Number.isFinite(value)) return null;
  }
  // Degenerate composition (zero-area artwork on the photo) is refused.
  const area2 = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(area2) || Math.abs(area2) <= 1e-9) return null;
  return matrix;
}

export function selectPhotoMapping(
  mappings: PhotoMappingsV1 | null,
  manifestPresent: boolean,
  productId: string,
  variantId: string,
  regionId: string,
  view: PhotoMappingView,
  imagePath: string,
  lookup: PresentationAssetLookup,
  context?: PhotoMappingContext,
  viewId?: string,
): PhotoMappingSelection {
  if (!manifestPresent) return { mapping: null, warning: null };
  if (!mappings) {
    return { mapping: null, warning: 'Photo mapping data was invalid and has been ignored.' };
  }
  // Identity-first when the caller declares a stable view id (flexible
  // named views): the legacy `view` bucket is inert and must not filter.
  // Legacy callers (no viewId) keep the exact bucket match.
  const candidates = mappings.mappings.filter((entry) =>
    entry.productId === productId &&
    entry.regionId === regionId &&
    entry.image === imagePath &&
    (viewId !== undefined ? mappingViewIdOf(entry) === viewId : entry.view === view),
  );
  if (candidates.length === 0) {
    return { mapping: null, warning: 'No photo mapping supplied for this region and view; photo is reference only.' };
  }
  const forVariant = candidates.filter((entry) => entry.variantId === variantId);
  const unscoped = candidates.filter((entry) => entry.variantId === undefined);
  // Exact view identity first (stable viewId match), then the legacy
  // unscoped-view fallback so older packages without viewIds keep resolving
  // through their view bucket. Deterministic; never a blend.
  const scoped = viewId !== undefined
    ? forVariant.find((entry) => entry.viewId === viewId)
      ?? unscoped.find((entry) => entry.viewId === viewId)
      ?? forVariant.find((entry) => entry.viewId === undefined)
      ?? unscoped.find((entry) => entry.viewId === undefined)
      ?? null
    : candidates.find((entry) => entry.variantId === variantId)
      ?? candidates.find((entry) => entry.variantId === undefined)
      ?? null;
  if (!scoped) {
    return { mapping: null, warning: 'No photo mapping supplied for this product option; photo is reference only.' };
  }
  if (validatePhotoMapping(scoped).length > 0) {
    return { mapping: null, warning: `Photo mapping for “${imagePath}” is degenerate or invalid and has been ignored; photo is reference only.` };
  }
  if (context !== undefined) {
    const mismatch = validateMappingContext(scoped, context);
    if (mismatch.length > 0) {
      return { mapping: null, warning: `Photo mapping for “${imagePath}” is stale (${mismatch.join('; ')}); photo is reference only.` };
    }
  }
  const bytes = lookup(scoped.image);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_PREVIEW_BYTES) {
    return { mapping: null, warning: `Photo-mapped image “${scoped.image}” is missing or too large; showing the measured diagram instead.` };
  }
  if (ALLOWLISTED_MEDIA[extensionOf(scoped.image)] === undefined) {
    return { mapping: null, warning: `Photo-mapped image “${scoped.image}” is not a supported raster format; showing the measured diagram instead.` };
  }
  if (readRasterHeader(bytes)?.mediaType !== ALLOWLISTED_MEDIA[extensionOf(scoped.image)]) {
    return { mapping: null, warning: `Photo-mapped image “${scoped.image}” is missing or too large; showing the measured diagram instead.` };
  }
  return { mapping: scoped, warning: null };
}

/**
 * Two-click reference-span similarity transform (lead-owned, setup-calibration).
 *
 * Builds the uniform-scale region-mm (Y-up) -> normalized UV map from ONE
 * operator-measured span: clicked photo endpoints A/B plus the declared real
 * straight-line length in millimetres. Pure math; no DOM, no assets.
 *
 * Declared frame convention (operator-determined, never invented silently):
 * the mm origin sits exactly on A and the +x axis runs from A toward B.
 * The scale is uniform (`lengthMm` / pixel-native |AB|); the mapping is a
 * similarity (rotation + uniform scale, no shear, no perspective correction).
 * A single span cannot solve arbitrary perspective — the caller must state
 * the front-on planar assumption wherever this is surfaced. Output is a
 * provisional draft: never production approval.
 *
 * Returns null when the span is unusable: non-finite/out-of-range UV,
 * non-positive/non-finite length, non-positive photo size, or coincident A/B
 * (pixel-native distance <= 1e-9). The result always satisfies
 * `validatePhotoMapping` transform checks (|det| = 1/(s^2*W*H) for scale s;
 * absurd scales whose determinant underflows 1e-12 are refused) and
 * round-trips exactly through `forwardPhotoMapping` / `inversePhotoMapping`
 * (A -> (0,0), B -> (lengthMm, 0)).
 */
export function similarityTransformFromSpan(input: {
  widthPx: number;
  heightPx: number;
  aUv: { u: number; v: number };
  bUv: { u: number; v: number };
  lengthMm: number;
}): PhotoMappingTransform | null {
  const { widthPx: width, heightPx: height, aUv, bUv, lengthMm } = input;
  if (!Number.isFinite(width) || !(width > 0)) return null;
  if (!Number.isFinite(height) || !(height > 0)) return null;
  if (!isFiniteNumber(aUv?.u) || !isFiniteNumber(aUv?.v)) return null;
  if (!isFiniteNumber(bUv?.u) || !isFiniteNumber(bUv?.v)) return null;
  if (aUv.u < 0 || aUv.u > 1 || aUv.v < 0 || aUv.v > 1) return null;
  if (bUv.u < 0 || bUv.u > 1 || bUv.v < 0 || bUv.v > 1) return null;
  if (!Number.isFinite(lengthMm) || !(lengthMm > 0)) return null;
  const dxPx = (bUv.u - aUv.u) * width;
  const dyPx = (bUv.v - aUv.v) * height;
  const nativePx = Math.hypot(dxPx, dyPx);
  if (!Number.isFinite(nativePx) || !(nativePx > 1e-9)) return null;
  const scale = lengthMm / nativePx;
  if (!Number.isFinite(scale) || !(scale > 0)) return null;
  // Millimetres convert to pixels by DIVISION (px offset = mm / scale):
  // x = lengthMm must land exactly on B (offset |AB|_px = lengthMm / scale).
  const perMm = 1 / scale;
  if (!Number.isFinite(perMm) || !(perMm > 0)) return null;
  const transform: PhotoMappingTransform = {
    a: (perMm * dxPx) / (width * nativePx),
    b: (perMm * dyPx) / (width * nativePx),
    c: aUv.u,
    d: (perMm * dyPx) / (height * nativePx),
    e: (-perMm * dxPx) / (height * nativePx),
    f: aUv.v,
  };
  for (const value of [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f]) {
    if (!Number.isFinite(value)) return null;
  }
  const det = transform.a * transform.e - transform.b * transform.d;
  if (!Number.isFinite(det) || Math.abs(det) <= MIN_ABS_DET) return null;
  return transform;
}
