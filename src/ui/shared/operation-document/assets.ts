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
  selectPresentationViews,
} from "../../customer-editor/presentation-assets.js";
import type {
  ArtworkPreviewStatus,
  ReferenceViewInput,
} from "../../../core/operation-document/types.js";

/** Minimal package-bytes lookup; the caller owns the underlying archives. */
export interface OperationDocumentAssetLookup {
  getBytes(path: string): Uint8Array | undefined;
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
