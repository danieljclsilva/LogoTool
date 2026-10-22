/**
 * Bounded pure intake planner for Tranche A (in-place product photos).
 *
 * Pure TypeScript: no DOM, browser, Three.js, or network imports. The caller
 * (UI boundary) reads files, decodes rasters, and commits bytes; this module
 * only validates a candidate photo and plans the deterministic manifest,
 * asset-path, and mapping-invalidation outcome. It never mutates its input.
 *
 * Rules:
 * - `add` attaches a previously absent side/scope and starts unmeasured: it
 *   refuses an occupied side, never copies geometry, and invalidates nothing.
 * - `replace` supersedes a side/scope photo: manifest entry count is kept,
 *   a fresh collision-safe asset path is always minted (the prior path is
 *   never reused, since it may be shared), only mappings bound to the
 *   replaced photo/scope are invalidated, and the prior image path is
 *   reported as `replacedAssetPath` so the caller can preserve the
 *   superseded bytes as evidence.
 * - Product-wide and variant-scoped records never shadow each other: scope
 *   matching is exact (`variantId` present and equal, or both absent).
 * - Asset paths are collision-safe: a clashed path gains a numeric suffix and
 *   an unrelated asset is never overwritten.
 */

import { MAX_PREVIEW_BYTES, readRasterHeader } from "../../assets/raster-header.js";
import type {
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
  PlanPhotoIntakeResult,
} from "./types.js";

export type {
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
  PlanPhotoIntakeResult,
} from "./types.js";

/** Intake planner bounds: the 32-entry presentation budget is authoritative. */
export const PHOTO_INTAKE_LIMITS = {
  manifestBudget: 32,
  maxPathSuffix: 65536,
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

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
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

/** Same path semantics as the presentation manifest reader. */
function isValidPresentationPath(value: string): boolean {
  if (value.length === 0) return false;
  const lower = value.toLowerCase();
  if (
    lower.startsWith("http://")
    || lower.startsWith("https://")
    || lower.startsWith("data:")
    || lower.startsWith("blob:")
    || lower.startsWith("//")
  ) return false;
  if (!value.startsWith("presentation/")) return false;
  if (value.includes("\\") || value.includes(":")) return false;
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  return true;
}

const RASTER_EXTENSIONS: Record<string, true> = {
  ".png": true,
  ".jpg": true,
  ".jpeg": true,
  ".webp": true,
};

function parseViewEntry(entry: unknown): IntakeManifestView | null {
  if (typeof entry !== "object" || entry === null) return null;
  const item = entry as Record<string, unknown>;
  if (!isNonEmptyString(item["productId"])) return null;
  if (item["variantId"] !== undefined && !isNonEmptyString(item["variantId"])) return null;
  if (!isPhotoSide(item["view"])) return null;
  if (!isNonEmptyString(item["image"])) return null;
  if (!isValidPresentationPath(item["image"])) return null;
  if (RASTER_EXTENSIONS[extensionOf(item["image"])] !== true) return null;
  if (item["label"] !== undefined && typeof item["label"] !== "string") return null;
  return {
    productId: item["productId"],
    ...(isNonEmptyString(item["variantId"]) ? { variantId: item["variantId"] } : {}),
    view: item["view"],
    image: item["image"],
    ...(typeof item["label"] === "string" ? { label: item["label"] } : {}),
  };
}

function parseModelEntry(entry: unknown): IntakeManifestModel | null {
  if (typeof entry !== "object" || entry === null) return null;
  const item = entry as Record<string, unknown>;
  if (!isNonEmptyString(item["productId"])) return null;
  if (item["variantId"] !== undefined && !isNonEmptyString(item["variantId"])) return null;
  if (!isNonEmptyString(item["model"])) return null;
  if (!isValidPresentationPath(item["model"])) return null;
  if (extensionOf(item["model"]) !== ".glb") return null;
  if (item["label"] !== undefined && typeof item["label"] !== "string") return null;
  return {
    productId: item["productId"],
    ...(isNonEmptyString(item["variantId"]) ? { variantId: item["variantId"] } : {}),
    model: item["model"],
    ...(typeof item["label"] === "string" ? { label: item["label"] } : {}),
  };
}

function parseReferenceEntry(entry: unknown): IntakeManifestReference | null {
  if (typeof entry !== "object" || entry === null) return null;
  const item = entry as Record<string, unknown>;
  if (!isNonEmptyString(item["productId"])) return null;
  if (item["variantId"] !== undefined && !isNonEmptyString(item["variantId"])) return null;
  if (!isNonEmptyString(item["image"])) return null;
  if (!isValidPresentationPath(item["image"])) return null;
  if (RASTER_EXTENSIONS[extensionOf(item["image"])] !== true) return null;
  if (item["label"] !== undefined && typeof item["label"] !== "string") return null;
  return {
    productId: item["productId"],
    ...(isNonEmptyString(item["variantId"]) ? { variantId: item["variantId"] } : {}),
    image: item["image"],
    ...(typeof item["label"] === "string" ? { label: item["label"] } : {}),
  };
}

function parseManifest(raw: unknown): IntakeManifestV2 | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== 2) return null;
  if (!Array.isArray(record["views"])) return null;
  if (record["models"] !== undefined && !Array.isArray(record["models"])) return null;
  if (record["references"] !== undefined && !Array.isArray(record["references"])) return null;
  const views: IntakeManifestView[] = [];
  for (const entry of record["views"] as unknown[]) {
    const parsed = parseViewEntry(entry);
    if (parsed === null) return null;
    views.push(parsed);
  }
  const models: IntakeManifestModel[] = [];
  for (const entry of (record["models"] ?? []) as unknown[]) {
    const parsed = parseModelEntry(entry);
    if (parsed === null) return null;
    models.push(parsed);
  }
  const references: IntakeManifestReference[] = [];
  for (const entry of (record["references"] ?? []) as unknown[]) {
    const parsed = parseReferenceEntry(entry);
    if (parsed === null) return null;
    references.push(parsed);
  }
  if (views.length + models.length + references.length === 0) return null;
  const manifest: IntakeManifestV2 = { version: 2, views };
  if (models.length > 0) manifest.models = models;
  if (references.length > 0) manifest.references = references;
  return manifest;
}

/** Exact scope match: product-wide and variant-scoped records never shadow. */
function sameScope(entryVariantId: string | undefined, inputVariantId: string | undefined): boolean {
  return entryVariantId === inputVariantId;
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

/** Same mapping identity as the internal builder (product/variant/region/view/image). */
function mappingKeyOf(productId: string, variantId: string | undefined, regionId: string, view: string, image: string): string {
  return `${productId}\0${variantId ?? ""}\0${regionId}\0${view}\0${image}`;
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
    if (!isPhotoSide(input.side)) {
      return fail("malformed", "side must be one of front|back|left|right");
    }
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
    const manifest = parseManifest(input.existingManifest);
    if (manifest === null) {
      return fail("malformed", "existing presentation manifest is missing or invalid; supply the current v2 manifest");
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
      (entry) => entry.productId === input.productId && sameScope(entry.variantId, input.variantId) && entry.view === input.side,
    );
    if (input.mode === "add" && prior !== undefined) {
      return fail("side-occupied", `side "${input.side}" already has a photo for this product scope; use mode "replace" to supersede it`);
    }
    if (input.mode === "replace" && prior === undefined) {
      return fail("side-empty", `side "${input.side}" has no photo for this product scope; use mode "add" to attach it`);
    }
    if (input.mode === "add" && entryCount + 1 > PHOTO_INTAKE_LIMITS.manifestBudget) {
      return fail("budget-exceeded", `presentation manifest would hold ${entryCount + 1} entries, over the ${PHOTO_INTAKE_LIMITS.manifestBudget}-entry budget; previous entries are unchanged`);
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
      // sides/scopes, and committing new bytes there would silently overwrite
      // an unrelated photo. The prior path counts as occupied so the claim
      // below can never return it. The superseded path is reported as
      // replacedAssetPath so the caller retains the exact original bytes.
      replacedAssetPath = prior.image;
      occupied.add(prior.image);
      const base = `presentation/${safeProductSegment(input.productId)}/${input.side}${extension}`;
      const claimed = claimAssetPath(base, occupied);
      if (claimed === null) {
        return fail("malformed", `no free asset path for side "${input.side}"; previous entries are unchanged`);
      }
      assetPath = claimed;
    } else {
      const base = `presentation/${safeProductSegment(input.productId)}/${input.side}${extension}`;
      const claimed = claimAssetPath(base, occupied);
      if (claimed === null) {
        return fail("malformed", `no free asset path for side "${input.side}"; previous entries are unchanged`);
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
      // Add keeps every unrelated view verbatim; the new side carries no
      // label or geometry — the caller assigns human labels at the boundary.
      const added: IntakeManifestView = input.variantId === undefined
        ? { productId: input.productId, view: input.side, image: assetPath }
        : { productId: input.productId, variantId: input.variantId, view: input.side, image: assetPath };
      nextViews = [...manifest.views, added];
    }
    nextViews.sort(compareViews);
    const nextModels = [...(manifest.models ?? [])].sort(compareModels);
    const nextReferences = [...(manifest.references ?? [])].sort(compareReferences);
    const nextManifest: IntakeManifestV2 = { version: 2, views: nextViews };
    if (nextModels.length > 0) nextManifest.models = nextModels;
    if (nextReferences.length > 0) nextManifest.references = nextReferences;

    let invalidatedMappingKeys: string[] = [];
    if (input.mode === "replace" && prior !== undefined) {
      const keys = new Set<string>();
      for (const entry of input.existingMappings) {
        if (!isValidMappingRef(entry)) continue;
        if (entry.productId !== input.productId) continue;
        if (!sameScope(entry.variantId, input.variantId)) continue;
        if (entry.view !== input.side) continue;
        if (entry.image !== prior.image) continue;
        keys.add(mappingKeyOf(entry.productId, entry.variantId, entry.regionId, entry.view, entry.image));
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
