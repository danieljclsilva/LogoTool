/**
 * Bounded pure presentation-view helpers (intake-UX workstream, provisional).
 *
 * Pure TypeScript: no DOM, browser, Three.js, or network imports. These are
 * the domain-layer authority for flexible named views end to end:
 * intake planning (`src/core/photo-intake`) and the operation-document
 * pass-through (`src/core/operation-document`) build on these primitives so
 * view identity stays stable, bounded and deterministic, while human labels
 * stay mutable display text that never invalidates physical evidence.
 *
 * Backward compatibility: legacy `front`/`back`/`left`/`right` names are
 * valid view ids; legacy v2 manifests (and entries using the legacy `side`
 * field instead of `view`) parse identically to flexible manifests.
 * Model-only manifests carry zero views and select to an explicit
 * "not supplied" note rather than a photo request.
 */

import { isRecord } from "../guards.js";
import type {
  AnyPresentationManifest,
  FlexibleViewSelection,
  PresentationManifestV2,
  PresentationManifestVNext,
  PresentationModelEntry,
  PresentationReferenceEntry,
  PresentationViewEntry,
  PresentationViewScope,
} from "./types.js";
import { PRESENTATION_VIEW_LIMITS } from "./types.js";

export type {
  AnyPresentationManifest,
  FlexibleViewSelection,
  PresentationManifestV2,
  PresentationManifestVNext,
  PresentationModelEntry,
  PresentationReferenceEntry,
  PresentationViewEntry,
  PresentationViewScope,
} from "./types.js";
export { PRESENTATION_VIEW_LIMITS } from "./types.js";
export type {
  ModelDocumentView,
  ModelRenderCoordinator,
  ModelViewCamera,
  ModelViewFraming,
  ModelViewListResult,
  ModelViewPatch,
  ModelViewRender,
} from "./model-document-views.js";
export {
  addModelDocumentView,
  adjustModelDocumentView,
  cameraDigest,
  createModelRenderCoordinator,
  DEFAULT_MODEL_CAMERA,
  defaultModelDocumentViews,
  isModelDocumentViewId,
  isModelDocumentViewLabel,
  isModelViewRenderStale,
  MODEL_DOCUMENT_VIEW_LIMITS,
  MODEL_DOCUMENT_VIEW_VERSION,
  modelViewRenderKey,
  normalizeModelViewMethod,
  parseModelDocumentView,
  parseModelDocumentViewList,
  removeModelDocumentView,
  reorderModelDocumentViews,
  serializeModelDocumentViews,
} from "./model-document-views.js";

/** Legacy fixed side names: valid view ids with legacy default labels. */
export const LEGACY_VIEW_IDS = ["front", "back", "left", "right"] as const;

const LEGACY_LOOKUP: Record<string, true> = {
  front: true,
  back: true,
  left: true,
  right: true,
};

const VIEW_ID_PATTERN = /^[a-z0-9-]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Stable view-id check: 1..48 chars of `[a-z0-9-]`. Labels, display names,
 * paths and free text are never valid ids unless they match this slug form.
 */
export function isPresentationViewId(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length >= 1
    && value.length <= PRESENTATION_VIEW_LIMITS.maxViewIdChars
    && VIEW_ID_PATTERN.test(value)
  );
}

/** Mutable-label check: free text, 1..80 chars when present. */
export function isPresentationViewLabel(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length >= 1
    && value.length <= PRESENTATION_VIEW_LIMITS.maxViewLabelChars
  );
}

/** True for the four legacy fixed side names. */
export function isLegacyViewId(viewId: string): boolean {
  return LEGACY_LOOKUP[viewId] === true;
}

/**
 * Display name for a view id when no explicit label was stored. Legacy ids
 * keep their historical capitalized names; any other id displays as itself.
 * Display-only: never used as identity, never written back into manifests.
 */
export function defaultLabelForViewId(viewId: string): string {
  switch (viewId) {
    case "front": return "Front";
    case "back": return "Back";
    case "left": return "Left";
    case "right": return "Right";
    default: return viewId;
  }
}

/** Exact scope match: product-wide and variant-scoped records never shadow. */
export function samePresentationScope(
  entryVariantId: string | undefined,
  scopeVariantId: string | undefined,
): boolean {
  return entryVariantId === scopeVariantId;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareViewEntries(a: PresentationViewEntry, b: PresentationViewEntry): number {
  return compareStrings(a.productId, b.productId)
    || compareStrings(a.variantId ?? "", b.variantId ?? "")
    || compareStrings(a.view, b.view)
    || compareStrings(a.image, b.image);
}

/**
 * Same path semantics as the presentation manifest readers: relative
 * `presentation/` path, no remotes, no backslashes/colons/empty segments.
 */
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

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

const RASTER_EXTENSIONS: Record<string, true> = {
  ".png": true,
  ".jpg": true,
  ".jpeg": true,
  ".webp": true,
};

/**
 * Parse one named view entry. Accepts the v-next `view` id field and, for
 * backward compatibility, the legacy `side` field (one of the four fixed
 * names) when `view` is absent. Returns null for anything else. Labels are
 * preserved verbatim; no default is invented here.
 */
export function parsePresentationViewEntry(entry: unknown): PresentationViewEntry | null {
  if (!isRecord(entry)) return null;
  const productId = entry["productId"];
  if (!isNonEmptyString(productId)) return null;
  const variantRaw = entry["variantId"];
  if (variantRaw !== undefined && !isNonEmptyString(variantRaw)) return null;
  const rawView = entry["view"];
  const rawSide = entry["side"];
  let view: string | null = null;
  if (rawView !== undefined) {
    if (!isPresentationViewId(rawView)) return null;
    view = rawView;
  } else if (rawSide !== undefined) {
    // Legacy alias reader: `side: front|back|left|right` maps to the same id.
    if (typeof rawSide !== "string" || LEGACY_LOOKUP[rawSide] !== true) return null;
    view = rawSide;
  } else {
    return null;
  }
  const image = entry["image"];
  if (!isNonEmptyString(image)) return null;
  if (!isValidPresentationPath(image)) return null;
  if (RASTER_EXTENSIONS[extensionOf(image)] !== true) return null;
  const label = entry["label"];
  if (label !== undefined && !isPresentationViewLabel(label)) return null;
  return {
    productId,
    ...(isNonEmptyString(variantRaw) ? { variantId: variantRaw } : {}),
    view,
    image,
    ...(typeof label === "string" ? { label } : {}),
  };
}

function parseModelEntry(entry: unknown): PresentationModelEntry | null {
  if (!isRecord(entry)) return null;
  if (!isNonEmptyString(entry["productId"])) return null;
  if (entry["variantId"] !== undefined && !isNonEmptyString(entry["variantId"])) return null;
  if (!isNonEmptyString(entry["model"])) return null;
  if (!isValidPresentationPath(entry["model"])) return null;
  if (extensionOf(entry["model"]) !== ".glb") return null;
  if (entry["label"] !== undefined && typeof entry["label"] !== "string") return null;
  return {
    productId: entry["productId"],
    ...(isNonEmptyString(entry["variantId"]) ? { variantId: entry["variantId"] } : {}),
    model: entry["model"],
    ...(typeof entry["label"] === "string" ? { label: entry["label"] } : {}),
  };
}

function parseReferenceEntry(entry: unknown): PresentationReferenceEntry | null {
  if (!isRecord(entry)) return null;
  if (!isNonEmptyString(entry["productId"])) return null;
  if (entry["variantId"] !== undefined && !isNonEmptyString(entry["variantId"])) return null;
  if (!isNonEmptyString(entry["image"])) return null;
  if (!isValidPresentationPath(entry["image"])) return null;
  if (RASTER_EXTENSIONS[extensionOf(entry["image"])] !== true) return null;
  if (entry["label"] !== undefined && typeof entry["label"] !== "string") return null;
  return {
    productId: entry["productId"],
    ...(isNonEmptyString(entry["variantId"]) ? { variantId: entry["variantId"] } : {}),
    image: entry["image"],
    ...(typeof entry["label"] === "string" ? { label: entry["label"] } : {}),
  };
}

/**
 * Bounded v2/v3 manifest reader. Accepts version 2 (legacy four-side and
 * already-flexible views) and version 3 (v-next flexible views) and
 * normalizes both to the same entry shapes; anything else (v1, unknown
 * versions, empty manifests, over-budget or duplicate-identity entries)
 * reads as null so callers fail atomically without partial application.
 */
export function parsePresentationManifest(raw: unknown): AnyPresentationManifest | null {
  if (!isRecord(raw)) return null;
  const version = raw["version"];
  if (version !== 2 && version !== 3) return null;
  if (!Array.isArray(raw["views"])) return null;
  if (raw["models"] !== undefined && !Array.isArray(raw["models"])) return null;
  if (raw["references"] !== undefined && !Array.isArray(raw["references"])) return null;
  const views: PresentationViewEntry[] = [];
  for (const candidate of raw["views"] as unknown[]) {
    const parsed = parsePresentationViewEntry(candidate);
    if (parsed === null) return null;
    views.push(parsed);
  }
  const models: PresentationModelEntry[] = [];
  for (const candidate of (raw["models"] ?? []) as unknown[]) {
    const parsed = parseModelEntry(candidate);
    if (parsed === null) return null;
    models.push(parsed);
  }
  const references: PresentationReferenceEntry[] = [];
  for (const candidate of (raw["references"] ?? []) as unknown[]) {
    const parsed = parseReferenceEntry(candidate);
    if (parsed === null) return null;
    references.push(parsed);
  }
  const total = views.length + models.length + references.length;
  if (total === 0 || total > PRESENTATION_VIEW_LIMITS.manifestBudget) return null;
  // Duplicate stable identity (product/variant-scope/view) is rejected: two
  // entries must never claim the same view, however their labels compare.
  const seen = new Set<string>();
  for (const entry of views) {
    const key = `${entry.productId}\0${entry.variantId ?? ""}\0${entry.view}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  // Per-scope view cap: at most maxViewsPerScope image views share one
  // product/variant scope (legacy fixed-side scopes hold at most 4).
  const perScope = new Map<string, number>();
  for (const entry of views) {
    const key = `${entry.productId}\0${entry.variantId ?? ""}`;
    const next = (perScope.get(key) ?? 0) + 1;
    if (next > PRESENTATION_VIEW_LIMITS.maxViewsPerScope) return null;
    perScope.set(key, next);
  }
  views.sort(compareViewEntries);
  models.sort((a, b) => compareStrings(a.productId, b.productId)
    || compareStrings(a.variantId ?? "", b.variantId ?? "")
    || compareStrings(a.model, b.model));
  references.sort((a, b) => compareStrings(a.productId, b.productId)
    || compareStrings(a.variantId ?? "", b.variantId ?? "")
    || compareStrings(a.image, b.image));
  if (version === 3) {
    const out: PresentationManifestVNext = { version: 3, views };
    if (models.length > 0) out.models = models;
    if (references.length > 0) out.references = references;
    return out;
  }
  const out: PresentationManifestV2 = { version: 2, views };
  if (models.length > 0) out.models = models;
  if (references.length > 0) out.references = references;
  return out;
}

/**
 * Deterministic serialization: entries sorted by
 * (productId, variantId, view, image) with fixed key order and no
 * whitespace. Byte-stable across input key order and entry order.
 */
export function serializePresentationManifest(manifest: AnyPresentationManifest): string {
  const views = [...manifest.views].sort(compareViewEntries);
  const models = [...(manifest.models ?? [])].sort((a, b) => compareStrings(a.productId, b.productId)
    || compareStrings(a.variantId ?? "", b.variantId ?? "")
    || compareStrings(a.model, b.model));
  const references = [...(manifest.references ?? [])].sort((a, b) => compareStrings(a.productId, b.productId)
    || compareStrings(a.variantId ?? "", b.variantId ?? "")
    || compareStrings(a.image, b.image));
  const normalizedViews = views.map((entry) => {
    const out: Record<string, unknown> = {
      image: entry.image,
      productId: entry.productId,
      view: entry.view,
    };
    if (entry.variantId !== undefined) out["variantId"] = entry.variantId;
    if (entry.label !== undefined) out["label"] = entry.label;
    return out;
  });
  const out: Record<string, unknown> = { version: manifest.version, views: normalizedViews };
  if (models.length > 0) {
    out["models"] = models.map((entry) => {
      const item: Record<string, unknown> = { model: entry.model, productId: entry.productId };
      if (entry.variantId !== undefined) item["variantId"] = entry.variantId;
      if (entry.label !== undefined) item["label"] = entry.label;
      return item;
    });
  }
  if (references.length > 0) {
    out["references"] = references.map((entry) => {
      const item: Record<string, unknown> = { image: entry.image, productId: entry.productId };
      if (entry.variantId !== undefined) item["variantId"] = entry.variantId;
      if (entry.label !== undefined) item["label"] = entry.label;
      return item;
    });
  }
  return JSON.stringify(out);
}

export type RenameViewLabelResult =
  | { ok: true; manifest: AnyPresentationManifest }
  | { ok: false; code: "malformed" | "unknown-view"; message: string };

function renameFail(code: "malformed" | "unknown-view", message: string): RenameViewLabelResult {
  return { ok: false, code, message };
}

/**
 * Rename a view's human label WITHOUT touching its identity, image path, or
 * any other entry. The returned manifest is a fresh copy (input never
 * mutated); calibration, anchors, safe areas and photo-mappings bound to the
 * view id stay valid — labels never invalidate physical evidence.
 * `label: undefined` clears the label back to the id default. Atomic: any
 * invalid input leaves the manifest unchanged and reports a failure.
 */
export function renameManifestViewLabel(
  manifest: AnyPresentationManifest,
  target: PresentationViewScope,
  label: string | undefined,
): RenameViewLabelResult {
  try {
    if (!isRecord(manifest as unknown)) return renameFail("malformed", "manifest must be an object");
    if (!isRecord(target as unknown)) return renameFail("malformed", "target must be an object");
    if (!isNonEmptyString(target.productId)) {
      return renameFail("malformed", "target productId must be a non-empty string");
    }
    if (target.variantId !== undefined && !isNonEmptyString(target.variantId)) {
      return renameFail("malformed", "target variantId must be a non-empty string when present");
    }
    if (!isPresentationViewId(target.view)) {
      return renameFail("malformed", "target view must be a 1..48-char [a-z0-9-] slug");
    }
    if (label !== undefined && !isPresentationViewLabel(label)) {
      return renameFail("malformed", "label must be 1..80 chars of free text, or omitted to clear it");
    }
    const parsed = parsePresentationManifest(JSON.parse(JSON.stringify(manifest)) as unknown);
    if (parsed === null) {
      return renameFail("malformed", "existing presentation manifest is missing or invalid");
    }
    const matches = parsed.views.filter((entry) =>
      entry.productId === target.productId
      && samePresentationScope(entry.variantId, target.variantId)
      && entry.view === target.view
    );
    if (matches.length === 0) {
      const scope = target.variantId === undefined
        ? target.productId
        : `${target.productId}/${target.variantId}`;
      return renameFail("unknown-view", `no view "${target.view}" for product scope "${scope}"`);
    }
    if (matches.length > 1) {
      return renameFail("malformed", `duplicate view identity "${target.view}" for this product scope; refusing to rename`);
    }
    const nextViews = parsed.views.map((entry) => {
      if (
        entry.productId !== target.productId
        || !samePresentationScope(entry.variantId, target.variantId)
        || entry.view !== target.view
      ) return entry;
      const next: PresentationViewEntry = {
        productId: entry.productId,
        ...(entry.variantId !== undefined ? { variantId: entry.variantId } : {}),
        view: entry.view,
        image: entry.image,
      };
      if (label !== undefined) next.label = label;
      return next;
    });
    nextViews.sort(compareViewEntries);
    if (parsed.version === 3) {
      const out: PresentationManifestVNext = { version: 3, views: nextViews };
      if (parsed.models !== undefined) out.models = parsed.models;
      if (parsed.references !== undefined) out.references = parsed.references;
      return { ok: true, manifest: out };
    }
    const out: PresentationManifestV2 = { version: 2, views: nextViews };
    if (parsed.models !== undefined) out.models = parsed.models;
    if (parsed.references !== undefined) out.references = parsed.references;
    return { ok: true, manifest: out };
  } catch (error) {
    return renameFail("malformed", `view rename failed validation (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Mapping/photo identity key for one named view: the exact image path plus
 * the stable view id plus the exact product/variant scope. Labels are never
 * part of the key, so renaming a view never retires or rebinds evidence.
 */
export function presentationMappingKey(
  productId: string,
  variantId: string | undefined,
  regionId: string,
  view: string,
  image: string,
): string {
  return `${productId}\0${variantId ?? ""}\0${regionId}\0${view}\0${image}`;
}

/**
 * Pass-through view selection for one product/variant scope: every matching
 * named view is returned, variant-scoped entries winning over product-wide
 * ones for the same view id (other variants skipped), sorted by view id for
 * determinism. Nothing is relabelled, equal labels across different products
 * are never conflated (selection is always product-scoped), and no view is
 * dropped for exceeding four — the bounded parser already caps scopes.
 *
 * Model-only scopes (zero views) select to an explicit "not supplied" note
 * rather than a photo request: a 3D model already covers all viewpoints.
 */
export function selectFlexibleViewsForScope(
  manifest: AnyPresentationManifest | null,
  manifestPresent: boolean,
  productId: string,
  variantId: string,
): { views: FlexibleViewSelection[]; note: string | null } {
  if (!manifestPresent) return { views: [], note: null };
  if (manifest === null) {
    return { views: [], note: "Reference preview data was invalid and has been ignored." };
  }
  const candidates = manifest.views.filter((entry) => entry.productId === productId);
  if (candidates.length === 0) {
    return { views: [], note: missingViewsNote(manifest, productId, variantId) };
  }
  const perView = new Map<string, PresentationViewEntry>();
  for (const entry of candidates) {
    if (entry.variantId !== undefined && entry.variantId !== variantId) continue;
    const current = perView.get(entry.view);
    if (current === undefined || (current.variantId === undefined && entry.variantId === variantId)) {
      perView.set(entry.view, entry);
    }
  }
  if (perView.size === 0) {
    return { views: [], note: missingViewsNote(manifest, productId, variantId) };
  }
  const views: FlexibleViewSelection[] = [...perView.values()]
    .sort((a, b) => compareStrings(a.view, b.view))
    .map((entry) => ({
      view: entry.view,
      imagePath: entry.image,
      label: entry.label ?? null,
    }));
  return { views, note: null };
}

function missingViewsNote(
  manifest: AnyPresentationManifest,
  productId: string,
  variantId: string,
): string | null {
  // A valid manifest may simply carry no views for this scope. Model-only
  // scopes are benign (never a photo request); imageless Images scopes keep
  // the established explicit wording so missing references stay visible.
  const hasModel = (manifest.models ?? []).some((entry) =>
    entry.productId === productId
    && (entry.variantId === undefined || entry.variantId === variantId)
  );
  if (hasModel) {
    return "No product photos supplied for this product option: model-only product, all viewpoints come from the 3D model; no photos requested.";
  }
  const scopeKnown = manifest.views.some((entry) => entry.productId === productId)
    || (manifest.references ?? []).some((entry) => entry.productId === productId);
  if (!scopeKnown) return null;
  return "No product reference supplied for this product option in the package.";
}
