/**
 * Bounded pure intake planner for Tranche A (in-place product photos).
 *
 * Pure TypeScript: no DOM, browser, Three.js, or network imports. The caller
 * (UI boundary) reads files, decodes rasters, and commits bytes; this module
 * only validates a candidate photo and plans the deterministic manifest,
 * asset-path, and mapping-invalidation outcome. It never mutates its input.
 *
 * View identity (provisional intake-UX contract, see
 * `src/core/presentation-views/`): entries are keyed by a STABLE slug id
 * (`viewId`, or the legacy `side` alias `front|back|left|right`) plus an
 * optional MUTABLE human `label` used for display only. Renaming a label
 * (see `renameIntakeViewLabel`) preserves identity and therefore preserves
 * every calibration, anchor and mapping bound to the view.
 *
 * Rules:
 * - `add` attaches a previously absent view/scope and starts unmeasured: it
 *   refuses an occupied view id, never copies geometry, and invalidates
 *   nothing.
 * - `replace` supersedes a view/scope photo: manifest entry count is kept,
 *   a fresh collision-safe asset path is always minted (the prior path is
 *   never reused, since it may be shared), only mappings bound to the
 *   replaced photo/scope/view/image are invalidated (labels never
 *   invalidate), and the prior image path is reported as `replacedAssetPath`
 *   so the caller can preserve the superseded bytes as evidence.
 * - Product-wide and variant-scoped records never shadow each other: scope
 *   matching is exact (`variantId` present and equal, or both absent).
 * - Asset paths are collision-safe: a clashed path gains a numeric suffix and
 *   an unrelated asset is never overwritten.
 * - Manifests stay bounded and deterministic: the 32-entry global budget is
 *   authoritative, each product/variant scope holds at most 12 image views
 *   (provisional; legacy fixed-side scopes hold at most 4), duplicate view
 *   identity is rejected, and serialization sorts by
 *   (productId, variantId, view, image). Failures are atomic: invalid input
 *   leaves every previous entry unchanged.
 */

import { MAX_PREVIEW_BYTES, readRasterHeader } from "../../assets/raster-header.js";
import {
  isPresentationViewId,
  parsePresentationManifest,
  presentationMappingKey,
  renameManifestViewLabel,
  samePresentationScope,
} from "../presentation-views/index.js";
import { isLegacyViewId } from "../presentation-views/index.js";
import { PRESENTATION_VIEW_LIMITS } from "../presentation-views/types.js";
import type {
  IntakeManifestAny,
  IntakeManifestModel,
  IntakeManifestReference,
  IntakeManifestV2,
  IntakeManifestView,
  PhotoIntakeErrorCode,
  PhotoIntakeInput,
  PhotoIntakeMappingRef,
  PhotoIntakeMode,
  PhotoMediaShort,
  PhotoSide,
  PhotoViewId,
  PlanPhotoIntakeResult,
  RenameIntakeViewInput,
  RenameIntakeViewResult,
} from "./types.js";

export type {
  IntakeManifestAny,
  IntakeManifestModel,
  IntakeManifestReference,
  IntakeManifestV2,
  IntakeManifestView,
  PhotoIntakeErrorCode,
  PhotoIntakeInput,
  PhotoIntakeMappingRef,
  PhotoIntakeMode,
  PhotoMediaShort,
  PhotoSide,
  PhotoViewId,
  PlanPhotoIntakeResult,
  RenameIntakeViewInput,
  RenameIntakeViewResult,
} from "./types.js";
export type {
  IntakeManifestVNext,
} from "./types.js";

/** Intake planner bounds: the 32-entry global presentation budget is authoritative. */
export const PHOTO_INTAKE_LIMITS = {
  manifestBudget: 32,
  maxPathSuffix: 65536,
  /** Provisional per-scope named-view cap (see presentation-views contracts). */
  maxViewsPerScope: PRESENTATION_VIEW_LIMITS.maxViewsPerScope,
} as const;

const SIDES: ReadonlyArray<PhotoSide> = ["front", "back", "left", "right"];
const MODES: ReadonlyArray<PhotoIntakeMode> = ["add", "replace"];
const MEDIA: ReadonlyArray<PhotoMediaShort> = ["png", "jpeg", "webp"];

function fail(code: PhotoIntakeErrorCode, message: string): PlanPhotoIntakeResult {
  return { ok: false, code, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPhotoSide(value: unknown): value is PhotoSide {
  return value === "front" || value === "back" || value === "left" || value === "right";
}

function isIntakeMode(value: unknown): value is PhotoIntakeMode {
  return value === "add" || value === "replace";
}

function isMediaShort(value: unknown): value is PhotoMediaShort {
  return value === "png" || value === "jpeg" || value === "webp";
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Same product-path slug as the internal builder (`presentation/<safe>/…`). */
function safeProductSegment(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned === "" ? "product" : cleaned;
}

function extensionForMedia(media: PhotoMediaShort): string {
  if (media === "jpeg") return ".jpg";
  if (media === "webp") return ".webp";
  return ".png";
}

function longMediaType(media: PhotoMediaShort): "image/png" | "image/jpeg" | "image/webp" {
  if (media === "jpeg") return "image/jpeg";
  if (media === "webp") return "image/webp";
  return "image/png";
}

/** Exact scope match: product-wide and variant-scoped records never shadow. */
function sameScope(entryVariantId: string | undefined, inputVariantId: string | undefined): boolean {
  return samePresentationScope(entryVariantId, inputVariantId);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareViews(a: IntakeManifestView, b: IntakeManifestView): number {
  return compareStrings(a.productId, b.productId)
    || compareStrings(a.variantId ?? "", b.variantId ?? "")
    || compareStrings(a.view, b.view)
    || compareStrings(a.image, b.image);
}

function compareModels(a: IntakeManifestModel, b: IntakeManifestModel): number {
  return compareStrings(a.productId, b.productId)
    || compareStrings(a.variantId ?? "", b.variantId ?? "")
    || compareStrings(a.model, b.model);
}

function compareReferences(a: IntakeManifestReference, b: IntakeManifestReference): number {
  return compareStrings(a.productId, b.productId)
    || compareStrings(a.variantId ?? "", b.variantId ?? "")
    || compareStrings(a.image, b.image);
}

/**
 * Resolve the stable view id for one intake: the preferred `viewId` slug,
 * or the legacy `side` alias. Exactly one must be supplied; a present-but-
 * disagreeing pair is malformed (never guessed).
 */
function resolveViewId(input: PhotoIntakeInput): { ok: true; viewId: string } | { ok: false; result: PlanPhotoIntakeResult } {
  const rawSide: unknown = (input as { side?: unknown }).side;
  const rawViewId: unknown = (input as { viewId?: unknown }).viewId;
  const sideSupplied = rawSide !== undefined;
  const viewSupplied = rawViewId !== undefined;
  if (!sideSupplied && !viewSupplied) {
    return {
      ok: false,
      result: fail("malformed", "supply exactly one view identity: viewId (preferred slug) or side (legacy front|back|left|right)"),
    };
  }
  if (viewSupplied) {
    if (!isPresentationViewId(rawViewId)) {
      return {
        ok: false,
        result: fail("malformed", "viewId must be a stable 1..48-char [a-z0-9-] slug (never the mutable human label)"),
      };
    }
    if (sideSupplied) {
      if (!isPhotoSide(rawSide)) {
        return { ok: false, result: fail("malformed", "side must be one of front|back|left|right") };
      }
      if (rawSide !== rawViewId) {
        return { ok: false, result: fail("malformed", `viewId "${rawViewId}" disagrees with legacy side "${rawSide}"; supply one view identity`) };
      }
    }
    return { ok: true, viewId: rawViewId };
  }
  if (!isPhotoSide(rawSide)) {
    return { ok: false, result: fail("malformed", "side must be one of front|back|left|right") };
  }
  return { ok: true, viewId: rawSide };
}

/**
 * Claim a collision-safe asset path: the base path when free, otherwise the
 * first free `stem-2.ext`, `stem-3.ext`, … suffix. Returns null when exhausted.
 */
function claimAssetPath(base: string, occupied: ReadonlySet<string>): string | null {
  if (!occupied.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot < 0 ? base : base.slice(0, dot);
  const ext = dot < 0 ? "" : base.slice(dot);
  for (let n = 2; n <= PHOTO_INTAKE_LIMITS.maxPathSuffix; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return null;
}

function isValidMappingRef(entry: unknown): entry is PhotoIntakeMappingRef {
  if (typeof entry !== "object" || entry === null) return false;
  const item = entry as Record<string, unknown>;
  if (!isNonEmptyString(item["productId"])) return false;
  if (item["variantId"] !== undefined && !isNonEmptyString(item["variantId"])) return false;
  if (!isNonEmptyString(item["regionId"])) return false;
  if (typeof item["view"] !== "string" || item["view"].length === 0) return false;
  if (!isNonEmptyString(item["image"])) return false;
  return true;
}

/**
 * Bounded manifest reader for intake: v2 (legacy) and v3 (v-next) manifests
 * with flexible named views; anything else reads as null so planning fails
 * atomically as malformed.
 */
export function parseIntakeManifest(raw: unknown): IntakeManifestAny | null {
  return parsePresentationManifest(raw);
}

/**
 * Rename a view's human label WITHOUT touching its identity, image path, or
 * any other entry. The input manifest is never mutated; calibration,
 * anchors, safe areas and photo-mappings bound to the view id stay valid —
 * labels never invalidate physical evidence. Atomic: any invalid input
 * reports a failure and changes nothing.
 */
export function renameIntakeViewLabel(
  existingManifest: unknown,
  target: RenameIntakeViewInput,
): RenameIntakeViewResult {
  try {
    if (typeof target !== "object" || target === null) {
      return { ok: false, code: "malformed", message: "rename target must be an object" };
    }
    const manifest = parsePresentationManifest(existingManifest);
    if (manifest === null) {
      return { ok: false, code: "malformed", message: "existing presentation manifest is missing or invalid" };
    }
    const outcome = renameManifestViewLabel(
      manifest,
      {
        productId: target.productId,
        ...(target.variantId !== undefined ? { variantId: target.variantId } : {}),
        view: target.view,
      },
      target.label,
    );
    if (!outcome.ok) {
      if (outcome.code === "unknown-view") {
        return { ok: false, code: "unknown-view", message: outcome.message };
      }
      return { ok: false, code: "malformed", message: outcome.message };
    }
    return { ok: true, manifest: outcome.manifest };
  } catch (error) {
    return { ok: false, code: "malformed", message: `view rename failed validation (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Plan an in-place photo intake for an existing product scope. Pure and
 * deterministic: the same input always yields a deep-equal result, and the
 * input is never mutated. Callers still own async file reading, decoding,
 * byte persistence, and the package build/reparse/commit roundtrip.
 */
export function planPhotoIntake(input: PhotoIntakeInput): PlanPhotoIntakeResult {
  try {
    if (typeof input !== "object" || input === null) {
      return fail("malformed", "photo intake input must be an object");
    }
    if (!isNonEmptyString(input.productId)) {
      return fail("malformed", "productId must be a non-empty string");
    }
    if (input.variantId !== undefined && !isNonEmptyString(input.variantId)) {
      return fail("malformed", "variantId must be a non-empty string when present");
    }
    const resolved = resolveViewId(input);
    if (!resolved.ok) return resolved.result;
    const viewId = resolved.viewId;
    if (!isIntakeMode(input.mode)) {
      return fail("malformed", "mode must be one of add|replace");
    }
    if (!isNonEmptyString(input.fileName)) {
      return fail("malformed", "fileName must be a non-empty string");
    }
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) {
      return fail("malformed", "bytes must be a non-empty Uint8Array");
    }
    if (input.bytes.length > MAX_PREVIEW_BYTES) {
      return fail("oversized", `photo exceeds ${MAX_PREVIEW_BYTES} bytes; rejected before intake`);
    }
    if (!isPositiveInt(input.widthPx) || !isPositiveInt(input.heightPx)) {
      return fail("malformed", "widthPx and heightPx must be positive integers");
    }
    if (!isMediaShort(input.mediaType)) {
      return fail("malformed", "mediaType must be one of png|jpeg|webp");
    }
    const header = readRasterHeader(input.bytes);
    if (header === null) {
      return fail("malformed", "unsupported or corrupt image; supply PNG, JPEG, or WebP bytes with verifiable dimensions");
    }
    if (header.width !== input.widthPx || header.height !== input.heightPx) {
      return fail("malformed", `decoded dimensions ${input.widthPx}x${input.heightPx} do not match the raster header ${header.width}x${header.height}`);
    }
    if (header.mediaType !== longMediaType(input.mediaType)) {
      return fail("malformed", `declared media ${input.mediaType} does not match the raster signature ${header.mediaType}`);
    }
    if (!Array.isArray(input.existingMappings)) {
      return fail("malformed", "existingMappings must be an array");
    }
    if (!Array.isArray(input.existingAssetPaths)) {
      return fail("malformed", "existingAssetPaths must be an array");
    }
    const manifest = parsePresentationManifest(input.existingManifest);
    if (manifest === null) {
      return fail("malformed", "existing presentation manifest is missing or invalid; supply the current v2/v3 manifest");
    }
    const entryCount = manifest.views.length + (manifest.models?.length ?? 0) + (manifest.references?.length ?? 0);
    if (entryCount > PHOTO_INTAKE_LIMITS.manifestBudget) {
      return fail("budget-exceeded", `presentation manifest already holds ${entryCount} entries, over the ${PHOTO_INTAKE_LIMITS.manifestBudget}-entry budget`);
    }
    const scopeKnown = manifest.views.some((entry) => entry.productId === input.productId && sameScope(entry.variantId, input.variantId))
      || (manifest.models ?? []).some((entry) => entry.productId === input.productId && sameScope(entry.variantId, input.variantId))
      || (manifest.references ?? []).some((entry) => entry.productId === input.productId && sameScope(entry.variantId, input.variantId));
    if (!scopeKnown) {
      const scope = input.variantId === undefined ? input.productId : `${input.productId}/${input.variantId}`;
      return fail("unknown-product-scope", `unknown product scope "${scope}"; intake targets an existing product or variant scope only`);
    }
    const prior = manifest.views.find(
      (entry) => entry.productId === input.productId && sameScope(entry.variantId, input.variantId) && entry.view === viewId,
    );
    if (input.mode === "add" && prior !== undefined) {
      return fail("side-occupied", `view "${viewId}" already has a photo for this product scope; use mode "replace" to supersede it`);
    }
    if (input.mode === "replace" && prior === undefined) {
      return fail("side-empty", `view "${viewId}" has no photo for this product scope; use mode "add" to attach it`);
    }
    if (input.mode === "add" && entryCount + 1 > PHOTO_INTAKE_LIMITS.manifestBudget) {
      return fail("budget-exceeded", `presentation manifest would hold ${entryCount + 1} entries, over the ${PHOTO_INTAKE_LIMITS.manifestBudget}-entry budget; previous entries are unchanged`);
    }
    if (input.mode === "add") {
      const scopeViews = manifest.views.filter(
        (entry) => entry.productId === input.productId && sameScope(entry.variantId, input.variantId),
      ).length;
      if (scopeViews + 1 > PHOTO_INTAKE_LIMITS.maxViewsPerScope) {
        return fail("view-budget-exceeded", `product scope already holds ${scopeViews} views, over the ${PHOTO_INTAKE_LIMITS.maxViewsPerScope}-view per-scope budget; previous entries are unchanged`);
      }
    }

    const occupied = new Set<string>();
    for (const path of input.existingAssetPaths) {
      if (typeof path === "string") occupied.add(path);
    }
    const extension = extensionForMedia(input.mediaType);
    let assetPath: string;
    let replacedAssetPath: string | undefined;
    if (input.mode === "replace" && prior !== undefined) {
      // Replace always mints a fresh collision-safe path, even when the
      // raster family matches: the prior image path may be shared by other
      // views/scopes, and committing new bytes there would silently overwrite
      // an unrelated photo. The prior path counts as occupied so the claim
      // below can never return it. The superseded path is reported as
      // replacedAssetPath so the caller retains the exact original bytes.
      replacedAssetPath = prior.image;
      occupied.add(prior.image);
      const base = `presentation/${safeProductSegment(input.productId)}/${viewId}${extension}`;
      const claimed = claimAssetPath(base, occupied);
      if (claimed === null) {
        return fail("malformed", `no free asset path for view "${viewId}"; previous entries are unchanged`);
      }
      assetPath = claimed;
    } else {
      const base = `presentation/${safeProductSegment(input.productId)}/${viewId}${extension}`;
      const claimed = claimAssetPath(base, occupied);
      if (claimed === null) {
        return fail("malformed", `no free asset path for view "${viewId}"; previous entries are unchanged`);
      }
      assetPath = claimed;
    }

    let nextViews: IntakeManifestView[];
    if (input.mode === "replace" && prior !== undefined) {
      // Replace keeps the entry count and the entry's label; geometry is never
      // copied — the replacement starts unmeasured until staff set it up.
      nextViews = manifest.views.map((entry) => {
        if (entry !== prior) return entry;
        return {
          productId: entry.productId,
          ...(entry.variantId !== undefined ? { variantId: entry.variantId } : {}),
          view: entry.view,
          image: assetPath,
          ...(entry.label !== undefined ? { label: entry.label } : {}),
        };
      });
    } else {
      // Add keeps every unrelated view verbatim; the new view carries no
      // label or geometry — the caller assigns human labels at the boundary.
      const added: IntakeManifestView = input.variantId === undefined
        ? { productId: input.productId, view: viewId, image: assetPath }
        : { productId: input.productId, variantId: input.variantId, view: viewId, image: assetPath };
      nextViews = [...manifest.views, added];
    }
    nextViews.sort(compareViews);
    const nextModels = [...(manifest.models ?? [])].sort(compareModels);
    const nextReferences = [...(manifest.references ?? [])].sort(compareReferences);
    // Version escalates to v-next only when a genuinely flexible (non-legacy)
    // view id is present; pure legacy four-side manifests stay version 2 so
    // existing issued/prepared projects keep opening compatibly.
    const nextVersion = (manifest.version === 3 || nextViews.some((entry) => !isLegacyViewId(entry.view))) ? 3 : 2;
    const nextManifest: IntakeManifestAny = nextVersion === 3
      ? {
        version: 3,
        views: nextViews,
        ...(nextModels.length > 0 ? { models: nextModels } : {}),
        ...(nextReferences.length > 0 ? { references: nextReferences } : {}),
      }
      : {
        version: 2,
        views: nextViews,
        ...(nextModels.length > 0 ? { models: nextModels } : {}),
        ...(nextReferences.length > 0 ? { references: nextReferences } : {}),
      };

    let invalidatedMappingKeys: string[] = [];
    if (input.mode === "replace" && prior !== undefined) {
      const keys = new Set<string>();
      for (const entry of input.existingMappings) {
        if (!isValidMappingRef(entry)) continue;
        if (entry.productId !== input.productId) continue;
        if (!sameScope(entry.variantId, input.variantId)) continue;
        if (entry.view !== viewId) continue;
        if (entry.image !== prior.image) continue;
        keys.add(presentationMappingKey(entry.productId, entry.variantId, entry.regionId, entry.view, entry.image));
      }
      invalidatedMappingKeys = [...keys].sort(compareStrings);
    }

    if (replacedAssetPath !== undefined) {
      return { ok: true, assetPath, manifest: nextManifest, invalidatedMappingKeys, replacedAssetPath };
    }
    return { ok: true, assetPath, manifest: nextManifest, invalidatedMappingKeys };
  } catch (error) {
    return fail("malformed", `photo intake failed validation (${error instanceof Error ? error.message : String(error)})`);
  }
}
