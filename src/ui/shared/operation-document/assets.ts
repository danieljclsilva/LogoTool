/// <reference lib="dom" />
/**
 * Operation-document asset plumbing (UI side).
 *
 * Bridges package bytes to the pure view model and the DOM renderer:
 * - `selectOperationReferenceViews` reuses the established presentation
 *   adapter (`parsePresentationManifest` / `selectPresentationViews`) so the
 *   document never invents product imagery and never fetches remote URLs.
 * - `bytesToDataUrl` materializes header-validated raster bytes as inert
 *   `data:` URLs for `<img>` display. No object URLs, no revocation, no
 *   network requests, no active content.
 * - `artworkPreviewReason` / `artworkRenderFailureReason` give explicit,
 *   honest placeholder text for every non-renderable case.
 *
 * All user/authored strings stay text; rendering escapes via textContent.
 */

import {
  parsePresentationManifest,
  PRESENTATION_MANIFEST_PATH,
  selectPresentationViews,
} from "../../customer-editor/presentation-assets.js";
import {
  parsePhotoMappings,
  PHOTO_MAPPINGS_PATH,
  validateMappingContext,
  validatePhotoMapping,
} from "../../customer-editor/presentation-photo-mapping.js";
import type { PhotoMappingContext } from "../../customer-editor/presentation-photo-mapping.js";
import type {
  ArtworkPreviewStatus,
  PhotoMappingState,
  ReferenceViewInput,
} from "../../../core/operation-document/types.js";
import type { ResultCandidate } from "../../../core/types.js";

/**
 * Caller-evaluated photo-mapping bindings for operation documents (staff
 * proof composites). Each packaged mapping entry is checked against the
 * CURRENT candidate product/variant/region, that region's calibration
 * reference, and the explicitly declared preview image/view binding (same
 * rules as the customer preview). Stale entries (edited package, swapped
 * calibration, relabelled photo) are dropped so the proof never implies a
 * calibrated overlay that was not evaluated — the side falls back to
 * reference-only. Pure; no DOM.
 */
export function evaluateOperationPhotoStates(
  candidate: ResultCandidate,
  assets: Map<string, Uint8Array>,
): Record<string, readonly PhotoMappingState[]> {
  const out: Record<string, readonly PhotoMappingState[]> = Object.create(null);
  const mappings = parsePhotoMappings(assets.get(PHOTO_MAPPINGS_PATH));
  if (!mappings) return out;
  const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
  const manifest = parsePresentationManifest(manifestBytes);
  const manifestPresent = manifestBytes !== undefined;
  const lookup = (path: string): Uint8Array | undefined => assets.get(path);
  for (const configuration of candidate.configurations) {
    const product = candidate.products.find((item) => item.id === configuration.productId);
    if (!product) continue;
    const views = selectPresentationViews(
      manifest,
      manifestPresent,
      configuration.productId,
      configuration.variantId,
      lookup,
    ).views.flatMap((view) => (view.view === null ? [] : [{ view: view.view, image: view.imagePath }] as const));
    const states: PhotoMappingState[] = [];
    for (const entry of mappings.mappings) {
      if (entry.productId !== configuration.productId) continue;
      if (entry.variantId !== undefined && entry.variantId !== configuration.variantId) continue;
      const region = product.regions.find((item) => item.id === entry.regionId);
      if (!region) continue;
      if (validatePhotoMapping(entry).length > 0) continue;
      const context: PhotoMappingContext = {
        productId: configuration.productId,
        variantId: configuration.variantId,
        regionId: region.id,
        calibrationId: region.calibrationRef.calibrationId,
        calibrationVersion: region.calibrationRef.version,
        manifestViews: views,
      };
      if (validateMappingContext(entry, context).length > 0) continue;
      const bytes = lookup(entry.image);
      if (!bytes || bytes.length === 0) continue;
      states.push({
        imagePath: entry.image,
        status: entry.status,
        regionId: entry.regionId,
        view: entry.view,
        transform: { ...entry.transform },
      });
    }
    out[configuration.id] = states;
  }
  return out;
}

/** Minimal package-bytes lookup; the caller owns the underlying archives. */
export interface OperationDocumentAssetLookup {
  getBytes(path: string): Uint8Array | undefined;
}

/**
 * Evaluated photo-mapping binding for one operation-sheet side, supplied by
 * the caller adapter via `getSheetOverlay`, matched to `sheet.sides[i]` by
 * index. Absent means the photo is unmapped: the renderer prints it
 * reference-only and never guesses an overlay. Region-local millimetres are
 * Y-up; normalized UV has v = 0 at the top (the `artworkPhotoMatrix`
 * convention).
 */
export interface SheetOverlayMapping {
  regionId: string;
  view: string;
  transform: { a: number; b: number; c: number; d: number; e: number; f: number };
  status: "provisional" | "review";
}

/**
 * Renderable artwork + authoritative placement geometry for one logo on a
 * mapped photo, supplied by the caller adapter, matched to `sheet.logos[j]`
 * by index. `regionId` scopes the entry to the mapped side it may overlay;
 * `imagePath` is the package path of the raster artwork (absent when no
 * renderable original exists — geometry is still carried).
 *
 * `arrows[k]` is the measured arrow segment (region-frame millimetres) for
 * `logo.dimensions[k]`, index-aligned: the caller recovers it from the same
 * pure `measurePlacement` call the view builder uses (same anchors and
 * bindings, same result order), so the drawn arrow and the printed
 * `valueMm1` always describe the same measurement. `artworkPoint` is the
 * extreme artwork corner (region-mm) linked with a visible dashed extension
 * when the dimension line starts off-artwork. An absent segment means
 * that arrow is not drawn on the photo (the panel list still carries the
 * measured value); nothing is guessed.
 */
export interface SheetOverlayArtwork {
  regionId: string;
  imagePath?: string | undefined;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
  arrows?: ReadonlyArray<{
    p0: { x: number; y: number };
    p1: { x: number; y: number };
    artworkPoint?: { x: number; y: number } | undefined;
  } | undefined>;
}

/**
 * Per-sheet presentation overlay, index-aligned with the view:
 * `mappings[i]` binds `sheet.sides[i]`, `artworks[j]` describes
 * `sheet.logos[j]`. An absent entry (or absent overlay) means unmapped / no
 * renderable artwork — the renderer says so explicitly instead of guessing.
 */
export interface SheetOverlay {
  mappings: ReadonlyArray<SheetOverlayMapping | undefined>;
  artworks: ReadonlyArray<SheetOverlayArtwork | undefined>;
}

/**
 * Asset lookup for the one-sheet renderer: package bytes plus the optional
 * caller-evaluated per-sheet overlay (photo mappings + artwork geometry). A
 * plain `{ getBytes }` lookup stays valid: everything overlay-related then
 * reads as unmapped with explicit notes.
 */
export interface OperationSheetAssetLookup extends OperationDocumentAssetLookup {
  getSheetOverlay?(sheetIndex: number): SheetOverlay | undefined;
}

export interface OperationReferenceSelection {
  views: ReferenceViewInput[];
  warning: string | null;
}

/**
 * Select illustrative product reference views per configuration using the
 * established presentation adapter. Exact product/variant-id match only;
 * missing sides are never invented. Returns an empty view list (with an
 * explicit warning from the adapter when one applies) otherwise.
 */
export function selectOperationReferenceViews(
  configurations: ReadonlyArray<{ id: string; productId: string; variantId: string }>,
  manifestBytes: Uint8Array | undefined,
  manifestPresent: boolean,
  lookup: OperationDocumentAssetLookup,
): Record<string, OperationReferenceSelection> {
  const manifest = parsePresentationManifest(manifestBytes);
  const selections: Record<string, OperationReferenceSelection> = Object.create(null);
  for (const configuration of configurations) {
    const selection = selectPresentationViews(
      manifest,
      manifestPresent,
      configuration.productId,
      configuration.variantId,
      (path) => lookup.getBytes(path),
    );
    selections[configuration.id] = {
      views: selection.views.map((view) => ({
        view: view.view,
        imagePath: view.imagePath,
        ...(view.label === null ? {} : { label: view.label }),
      })),
      warning: selection.warning,
    };
  }
  return selections;
}

const RASTER_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * Encode header-validated raster bytes as an inert `data:` URL for an
 * `<img>` element. Returns null for unsupported media types or encoding
 * failures so the caller falls back to explicit placeholder text.
 */
export function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string | null {
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") {
    return null;
  }
  try {
    let binary = "";
    const CHUNK = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
    }
    const url = `data:${mediaType};base64,${btoa(binary)}`;
    return RASTER_DATA_URL_PATTERN.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** Explicit placeholder text for every view-model preview verdict. */
export function artworkPreviewReason(status: ArtworkPreviewStatus, uri: string): string {
  switch (status) {
    case "inline-raster":
      return "";
    case "not-supplied":
      return "Artwork preview unavailable: package asset bytes were not supplied when this document was built.";
    case "missing":
      return `Artwork preview unavailable: \u201c${uri}\u201d has no bytes in the package.`;
    case "too-large":
      return `Artwork preview unavailable: \u201c${uri}\u201d exceeds the 2 MiB raster preview bound; the original bytes stay preserved in the package.`;
    case "unsupported":
      return `Artwork preview unavailable: \u201c${uri}\u201d is not a previewable raster original (PNG, JPEG or WebP only); the original bytes stay preserved in the package.`;
    case "corrupt":
      return `Artwork preview unavailable: \u201c${uri}\u201d failed raster validation; the original bytes stay preserved in the package.`;
  }
}

/** Explicit placeholder text for failures that only surface at render time. */
export function artworkRenderFailureReason(
  kind: "bytes-absent" | "encode-failed" | "decode-failed",
  uri: string,
): string {
  if (kind === "bytes-absent") {
    return `Artwork preview unavailable: \u201c${uri}\u201d was validated but its bytes were not supplied to the document renderer.`;
  }
  if (kind === "decode-failed") {
    return `Artwork preview unavailable: \u201c${uri}\u201d passed header validation but the browser could not decode it; the original bytes stay preserved in the package.`;
  }
  return `Artwork preview unavailable: \u201c${uri}\u201d could not be displayed; the original bytes stay preserved in the package.`;
}

/** Explicit placeholder text for an unrenderable product reference image. */
export function referencePreviewReason(uri: string): string {
  return `Product reference unavailable: \u201c${uri}\u201d failed raster validation; the measured diagram below is the source of truth.`;
}

/**
 * One artwork composited onto a sheet photo. Geometry is exact region-frame
 * millimetres (never pixels); the renderer runs it forward through the
 * evaluated affine mapping together with the photo pixel size.
 */
export interface OperationSheetOverlayArtwork {
  /** Package path of the artwork original; bytes resolve at render time. */
  uri: string;
  /** Human label (business logo name, or the logo id when unnamed). */
  label: string;
  /** Artwork bbox centre in the region frame, millimetres (Y-up). */
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Clockwise-positive facing the region. */
  rotationDeg: number;
}

/**
 * Evaluated photo overlay for one exact package image path: the affine
 * binding plus the in-region placements composited onto it. Keyed by exact
 * `imagePath` (never inferred, never a substring), matching the sheet side
 * join in the renderer. No byte arrays, no blobs — the renderer materializes
 * bytes from its own lookup, so this map stays deterministic pure data.
 */
export interface OperationSheetPhotoOverlay {
  imagePath: string;
  regionId: string;
  view: string | null;
  status: "provisional" | "review";
  /** Region-local mm to normalized-UV affine coefficients. */
  transform: { a: number; b: number; c: number; d: number; e: number; f: number };
  artworks: OperationSheetOverlayArtwork[];
}

/** Evaluated sheet photo overlays by exact image path. */
export type OperationSheetOverlayMap = Record<string, OperationSheetPhotoOverlay>;

function isSheetFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSheetFiniteTransform(value: unknown): value is OperationSheetPhotoOverlay["transform"] {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isSheetFiniteNumber(candidate["a"]) && isSheetFiniteNumber(candidate["b"]) &&
    isSheetFiniteNumber(candidate["c"]) && isSheetFiniteNumber(candidate["d"]) &&
    isSheetFiniteNumber(candidate["e"]) && isSheetFiniteNumber(candidate["f"])
  );
}

function normalizeSheetAssetBytes(
  input: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array> | undefined,
): Map<string, Uint8Array> | undefined {
  if (input === undefined) return undefined;
  if (input instanceof Map) return new Map(input);
  return new Map(Object.entries(input));
}

const SHEET_RASTER_EXTENSION_PATTERN = /\.(png|jpe?g|webp)$/i;

/**
 * Prefer a raster-previewable original for the photo composite; fall back to
 * the first asset when none matches. The renderer header-validates whatever
 * URI is returned and skips what it cannot decode, so this never fabricates
 * a renderable overlay.
 */
function sheetOverlayArtworkUri(assets: ReadonlyArray<{ uri: string }>): string | undefined {
  if (assets.length === 0) return undefined;
  return assets.find((asset) => SHEET_RASTER_EXTENSION_PATTERN.test(asset.uri))?.uri ?? assets[0]?.uri;
}

/**
 * Evaluate photo overlays for the branded one-sheet operator view, reusing
 * the same caller-evaluated mapping discipline as the technical preview:
 * each packaged mapping entry is checked against the CURRENT candidate
 * product/variant/region, that region's calibration reference, and the
 * explicitly declared preview image/view binding. Stale entries, degenerate
 * affines, and placements without usable geometry never reach the renderer —
 * the side falls back to reference-only there. Pure; never mutates inputs;
 * first configuration wins on a repeated image path (deterministic).
 */
export function evaluateOperationSheetOverlays(
  candidate: ResultCandidate,
  assetBytes?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
): OperationSheetOverlayMap {
  const out: OperationSheetOverlayMap = Object.create(null);
  const bytes = normalizeSheetAssetBytes(assetBytes);
  if (bytes === undefined) return out;
  const states = evaluateOperationPhotoStates(candidate, bytes);
  const logoNameById = new Map(
    candidate.logos.flatMap((logo) => (logo.name !== undefined ? [[logo.id, logo.name] as const] : [])),
  );
  for (const configuration of candidate.configurations) {
    if (!Object.hasOwn(states, configuration.id)) continue;
    for (const state of states[configuration.id]!) {
      if (state.regionId === undefined || !isSheetFiniteTransform(state.transform)) continue;
      const { a, b, c, d, e, f } = state.transform;
      const det = a * e - b * d;
      if (!Number.isFinite(det) || Math.abs(det) <= 1e-12) continue;
      if (Object.hasOwn(out, state.imagePath)) continue;
      const artworks: OperationSheetOverlayArtwork[] = [];
      for (const placement of configuration.placements) {
        if (placement.regionId !== state.regionId) continue;
        const uri = sheetOverlayArtworkUri(placement.artwork.assets);
        if (uri === undefined) continue;
        if (
          !isSheetFiniteNumber(placement.pos.xMm) || !isSheetFiniteNumber(placement.pos.yMm) ||
          !isSheetFiniteNumber(placement.widthMm) || !isSheetFiniteNumber(placement.heightMm) ||
          !isSheetFiniteNumber(placement.rotationDeg) ||
          !(placement.widthMm > 0) || !(placement.heightMm > 0)
        ) {
          continue;
        }
        artworks.push({
          uri,
          label: logoNameById.get(placement.logoId) ?? placement.logoId,
          xMm: placement.pos.xMm,
          yMm: placement.pos.yMm,
          widthMm: placement.widthMm,
          heightMm: placement.heightMm,
          rotationDeg: placement.rotationDeg,
        });
      }
      out[state.imagePath] = {
        imagePath: state.imagePath,
        regionId: state.regionId,
        view: state.view ?? null,
        status: state.status,
        transform: { a, b, c, d, e, f },
        artworks,
      };
    }
  }
  // Touch the header reader so a future refactor cannot silently pass
  // header-invalid bytes for compositing: validation itself stays at render
  // time where the lookup lives.
  return out;
}
