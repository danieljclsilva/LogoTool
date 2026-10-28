/**
 * Versioned presentation-only model document views (operator UX workstream).
 *
 * Pure TypeScript: no DOM, browser, Three.js, or network imports. These are
 * the domain-layer authority for GLB-derived operational document views:
 * stable view identity plus a presentation-only camera pose, kept strictly
 * separate from physical production data (millimetres, frames, calibration).
 * Camera state never affects production geometry, and production edits never
 * mutate a saved view's camera — renders bind to an explicit revision and
 * are invalidated after dependent changes.
 *
 * Identity model (mirrors `src/core/presentation-views`):
 * - `id` is the STABLE view identity: a bounded slug (`[a-z0-9-]`, 1..48
 *   chars). It is the key used by sheets, render caches and invalidation.
 *   It never changes on relabel or camera adjustment.
 * - `label` is the MUTABLE human name (free text, 1..80 chars when present).
 *
 * Versioning: `MODEL_DOCUMENT_VIEW_VERSION` guards every persisted list, so
 * a future contract change fails atomically instead of half-applying.
 * Legacy image-only projects are untouched: an empty model-view list means
 * "no model views", and photo sides keep working as before.
 */

import { isRecord } from "../guards.js";

/** Independent version of the model-document-view contract. */
export const MODEL_DOCUMENT_VIEW_VERSION = "model-document-view/1" as const;

/** Bounds for model document views (deterministic, enforced by parsers). */
export const MODEL_DOCUMENT_VIEW_LIMITS = {
  /** Max model views per product/variant scope (operator-manageable). */
  maxViewsPerScope: 12,
  /** Stable view-id slug length bound. */
  maxViewIdChars: 48,
  /** Mutable human-label length bound. */
  maxViewLabelChars: 80,
  /** Max associated regions/placements per view (keeps sheets readable). */
  maxAssociationsPerView: 24,
} as const;

/** Presentation-only camera pose. Display units only — never millimetres. */
export interface ModelViewCamera {
  /** Camera position in viewer display space (opaque triple, not mm). */
  position: readonly [number, number, number];
  /** Orbit target in viewer display space (opaque triple, not mm). */
  target: readonly [number, number, number];
  /** Camera up vector in viewer display space. */
  up: readonly [number, number, number];
  /** Vertical field of view in degrees. */
  fov: number;
}

/** Optional framing hints for the renderer (display-only, never mm). */
export interface ModelViewFraming {
  /** 0..1 crop margin around the product, when supplied. */
  margin?: number;
  /** Desired aspect hint (`"wide"` for the landscape stage). */
  aspect?: "wide" | "square";
}

/**
 * One operator-managed model document view. Presentation-only metadata:
 * stable identity, product/variant scope, camera pose, framing, explicit
 * associated regions/placements (which logos this view backs), and the
 * model asset binding (asset id + asset revision the camera was framed
 * against). No pixels, no millimetres, no mesh transforms.
 */
export interface ModelDocumentView {
  /** Stable identity slug (`[a-z0-9-]`, 1..48 chars). */
  id: string;
  productId: string;
  variantId?: string;
  /** Mutable human name; absent means "display the id default". */
  label?: string;
  camera: ModelViewCamera;
  framing?: ModelViewFraming;
  /** Region ids this view backs (explicit, never inferred). */
  associatedRegions: readonly string[];
  /** Placement ids (or logoRefs) this view backs, when narrowed further. */
  associatedPlacements?: readonly string[];
  /** Package model asset identity the camera was framed against. */
  modelAssetId: string;
  /** Model asset revision the camera was framed against. */
  modelRevision: string;
}

/** One captured product render bound to a committed revision + view params. */
export interface ModelViewRender {
  /** Stable view id this render was captured for. */
  viewId: string;
  /** Canonical committed revision the artwork was rendered from. */
  revision: number;
  /** Camera digest the render was captured with (see `cameraDigest`). */
  cameraKey: string;
  /** Model asset revision the render was decoded from. */
  modelRevision: string;
  status: "ready" | "pending" | "failed";
  /** Inert display data URL plus header size, when ready. */
  dataUrl?: string;
  widthPx?: number;
  heightPx?: number;
  /** Honest reason when not ready (never a guessed image). */
  note?: string;
}

const VIEW_ID_PATTERN = /^[a-z0-9-]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteTriple(value: unknown): value is readonly [number, number, number] {
  return (
    Array.isArray(value)
    && value.length === 3
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

/**
 * Stable view-id check: 1..48 chars of `[a-z0-9-]`. Labels, display names
 * and free text are never valid ids unless they match this slug form.
 */
export function isModelDocumentViewId(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length >= 1
    && value.length <= MODEL_DOCUMENT_VIEW_LIMITS.maxViewIdChars
    && VIEW_ID_PATTERN.test(value)
  );
}

/** Mutable-label check: free text, 1..80 chars when present. */
export function isModelDocumentViewLabel(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length >= 1
    && value.length <= MODEL_DOCUMENT_VIEW_LIMITS.maxViewLabelChars
  );
}

function isModelViewCamera(value: unknown): value is ModelViewCamera {
  if (!isRecord(value)) return false;
  if (!isFiniteTriple(value["position"])) return false;
  if (!isFiniteTriple(value["target"])) return false;
  if (!isFiniteTriple(value["up"])) return false;
  const fov = value["fov"];
  return typeof fov === "number" && Number.isFinite(fov) && fov > 0 && fov < 180;
}

function isModelViewFraming(value: unknown): value is ModelViewFraming {
  if (!isRecord(value)) return false;
  if (value["margin"] !== undefined) {
    const margin = value["margin"];
    if (typeof margin !== "number" || !Number.isFinite(margin) || margin < 0 || margin > 1) return false;
  }
  if (value["aspect"] !== undefined && value["aspect"] !== "wide" && value["aspect"] !== "square") {
    return false;
  }
  return true;
}

function isStringList(value: unknown, max: number): value is readonly string[] {
  return (
    Array.isArray(value)
    && value.length <= max
    && value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

/**
 * Parse one model document view. Returns null for anything malformed —
 * callers fail atomically without partial application. Inputs are never
 * mutated; the returned view is a fresh copy.
 */
export function parseModelDocumentView(entry: unknown): ModelDocumentView | null {
  if (!isRecord(entry)) return null;
  if (!isModelDocumentViewId(entry["id"])) return null;
  if (!isNonEmptyString(entry["productId"])) return null;
  const variantRaw = entry["variantId"];
  if (variantRaw !== undefined && !isNonEmptyString(variantRaw)) return null;
  if (!isModelViewCamera(entry["camera"])) return null;
  const framingRaw = entry["framing"];
  if (framingRaw !== undefined && !isModelViewFraming(framingRaw)) return null;
  if (!isStringList(entry["associatedRegions"], MODEL_DOCUMENT_VIEW_LIMITS.maxAssociationsPerView)) {
    return null;
  }
  const placementsRaw = entry["associatedPlacements"];
  if (
    placementsRaw !== undefined
    && !isStringList(placementsRaw, MODEL_DOCUMENT_VIEW_LIMITS.maxAssociationsPerView)
  ) {
    return null;
  }
  if (!isNonEmptyString(entry["modelAssetId"])) return null;
  if (!isNonEmptyString(entry["modelRevision"])) return null;
  const label = entry["label"];
  if (label !== undefined && !isModelDocumentViewLabel(label)) return null;
  const camera = entry["camera"] as ModelViewCamera;
  const out: ModelDocumentView = {
    id: entry["id"] as string,
    productId: entry["productId"] as string,
    camera: {
      position: [...camera.position] as [number, number, number],
      target: [...camera.target] as [number, number, number],
      up: [...camera.up] as [number, number, number],
      fov: camera.fov,
    },
    associatedRegions: [...(entry["associatedRegions"] as readonly string[])],
    modelAssetId: entry["modelAssetId"] as string,
    modelRevision: entry["modelRevision"] as string,
  };
  if (isNonEmptyString(variantRaw)) out.variantId = variantRaw;
  if (typeof label === "string") out.label = label;
  if (framingRaw !== undefined) out.framing = { ...(framingRaw as ModelViewFraming) };
  if (placementsRaw !== undefined) {
    out.associatedPlacements = [...(placementsRaw as readonly string[])];
  }
  return out;
}

/**
 * Parse a versioned model-view list. Accepted shape:
 * `{ version: "model-document-view/1", views: [...] }`. Anything else
 * (wrong version, over-budget, duplicate ids within a scope) reads as null.
 * View order is authored presentation data and survives save/reopen.
 */
export function parseModelDocumentViewList(raw: unknown): ModelDocumentView[] | null {
  if (!isRecord(raw)) return null;
  if (raw["version"] !== MODEL_DOCUMENT_VIEW_VERSION) return null;
  if (!Array.isArray(raw["views"])) return null;
  const views: ModelDocumentView[] = [];
  for (const candidate of raw["views"] as unknown[]) {
    const parsed = parseModelDocumentView(candidate);
    if (parsed === null) return null;
    views.push(parsed);
  }
  if (views.length > 256) return null;
  const counts = new Map<string, number>();
  for (const view of views) {
    const scope = JSON.stringify([view.productId, view.variantId ?? null]);
    const count = (counts.get(scope) ?? 0) + 1;
    if (count > MODEL_DOCUMENT_VIEW_LIMITS.maxViewsPerScope) return null;
    counts.set(scope, count);
  }
  const seen = new Set<string>();
  for (const view of views) {
    const key = `${view.productId}\0${view.variantId ?? ""}\0${view.id}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return views;
}

function compareModelViews(a: ModelDocumentView, b: ModelDocumentView): number {
  if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;
  const av = a.variantId ?? "";
  const bv = b.variantId ?? "";
  if (av !== bv) return av < bv ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Deterministic serialization with fixed key order and authored array order.
 */
export function serializeModelDocumentViews(views: readonly ModelDocumentView[]): string {
  const normalized = views.map((view) => {
    const out: Record<string, unknown> = {
      associatedRegions: [...view.associatedRegions],
      camera: {
        fov: view.camera.fov,
        position: [...view.camera.position],
        target: [...view.camera.target],
        up: [...view.camera.up],
      },
      id: view.id,
      modelAssetId: view.modelAssetId,
      modelRevision: view.modelRevision,
      productId: view.productId,
    };
    if (view.variantId !== undefined) out["variantId"] = view.variantId;
    if (view.label !== undefined) out["label"] = view.label;
    if (view.framing !== undefined) out["framing"] = { ...view.framing };
    if (view.associatedPlacements !== undefined) {
      out["associatedPlacements"] = [...view.associatedPlacements];
    }
    return out;
  });
  return JSON.stringify({ version: MODEL_DOCUMENT_VIEW_VERSION, views: normalized });
}

/** Default presentation-only camera: front three-quarter, 40° vertical fov. */
export const DEFAULT_MODEL_CAMERA: ModelViewCamera = {
  position: [0.6, 0.35, 1.4],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fov: 40,
};

/**
 * The operator's useful starting view for a model scope: one front view
 * with the default camera. Front-only jobs need nothing more; front/back
 * jobs add a second view explicitly.
 */
export function defaultModelDocumentViews(
  productId: string,
  variantId: string | undefined,
  modelAssetId: string,
  modelRevision: string,
  regionIds: readonly string[],
): ModelDocumentView[] {
  const view: ModelDocumentView = {
    id: "front",
    productId,
    camera: {
      position: [...DEFAULT_MODEL_CAMERA.position] as [number, number, number],
      target: [...DEFAULT_MODEL_CAMERA.target] as [number, number, number],
      up: [...DEFAULT_MODEL_CAMERA.up] as [number, number, number],
      fov: DEFAULT_MODEL_CAMERA.fov,
    },
    associatedRegions: [...regionIds],
    modelAssetId,
    modelRevision,
  };
  if (variantId !== undefined) view.variantId = variantId;
  return [view];
}

export type ModelViewListResult =
  | { ok: true; views: ModelDocumentView[] }
  | { ok: false; code: "malformed" | "duplicate" | "unknown-view" | "over-budget"; message: string };

function listFail(
  code: "malformed" | "duplicate" | "unknown-view" | "over-budget",
  message: string,
): ModelViewListResult {
  return { ok: false, code, message };
}

function cloneViews(views: readonly ModelDocumentView[]): ModelDocumentView[] {
  return views.map((view) => {
    const parsed = parseModelDocumentView(JSON.parse(JSON.stringify(view)) as unknown);
    // parseModelDocumentView is total over the serialized shape; a failure
    // here means the in-memory list was already invalid — callers treat it
    // as malformed rather than crashing.
    if (parsed === null) throw new Error(`invalid in-memory model view "${view.id}"`);
    return parsed;
  });
}

function checkBudget(views: readonly ModelDocumentView[]): boolean {
  return views.length <= MODEL_DOCUMENT_VIEW_LIMITS.maxViewsPerScope;
}

/** Add one operator view. Duplicate ids within the scope are rejected. */
export function addModelDocumentView(
  views: readonly ModelDocumentView[],
  view: ModelDocumentView,
): ModelViewListResult {
  try {
    const parsed = parseModelDocumentView(JSON.parse(JSON.stringify(view)) as unknown);
    if (parsed === null) return listFail("malformed", "new model view is missing or invalid");
    const next = cloneViews(views);
    const clash = next.some((entry) =>
      entry.productId === parsed.productId
      && (entry.variantId ?? "") === (parsed.variantId ?? "")
      && entry.id === parsed.id
    );
    if (clash) return listFail("duplicate", `model view "${parsed.id}" already exists for this product option`);
    next.push(parsed);
    if (!checkBudget(next)) return listFail("over-budget", "too many model views for this product option");
    return { ok: true, views: next };
  } catch (error) {
    return listFail("malformed", `add model view failed (${error instanceof Error ? error.message : String(error)})`);
  }
}

export interface ModelViewPatch {
  label?: string | undefined;
  camera?: ModelViewCamera;
  framing?: ModelViewFraming | undefined;
  associatedRegions?: readonly string[];
  associatedPlacements?: readonly string[] | undefined;
}

/**
 * Adjust one operator view's presentation metadata (camera, framing,
 * associations, label). Product/variant scope and model binding are NOT
 * patchable here — reframing against a different asset is a remove + add so
 * the binding stays explicit.
 */
export function adjustModelDocumentView(
  views: readonly ModelDocumentView[],
  id: string,
  productId: string,
  variantId: string | undefined,
  patch: ModelViewPatch,
): ModelViewListResult {
  try {
    if (!isModelDocumentViewId(id)) return listFail("malformed", "view id must be a 1..48-char [a-z0-9-] slug");
    const next = cloneViews(views);
    const index = next.findIndex((entry) =>
      entry.id === id && entry.productId === productId && (entry.variantId ?? "") === (variantId ?? "")
    );
    if (index < 0) return listFail("unknown-view", `no model view "${id}" for this product option`);
    const current = next[index]!;
    if (patch.camera !== undefined && !isModelViewCamera(patch.camera)) {
      return listFail("malformed", "camera must carry finite position/target/up triples and a 0..180° fov");
    }
    if (patch.framing !== undefined && !isModelViewFraming(patch.framing)) {
      return listFail("malformed", "framing must carry an optional 0..1 margin and wide/square aspect");
    }
    if (
      patch.associatedRegions !== undefined
      && !isStringList(patch.associatedRegions, MODEL_DOCUMENT_VIEW_LIMITS.maxAssociationsPerView)
    ) {
      return listFail("malformed", "associated regions must be a bounded list of non-empty ids");
    }
    if (
      patch.associatedPlacements !== undefined
      && !isStringList(patch.associatedPlacements, MODEL_DOCUMENT_VIEW_LIMITS.maxAssociationsPerView)
    ) {
      return listFail("malformed", "associated placements must be a bounded list of non-empty ids");
    }
    if (patch.label !== undefined && !isModelDocumentViewLabel(patch.label)) {
      return listFail("malformed", "label must be 1..80 chars of free text, or omitted to clear it");
    }
    const updated: ModelDocumentView = {
      ...current,
      camera: patch.camera !== undefined
        ? {
          position: [...patch.camera.position] as [number, number, number],
          target: [...patch.camera.target] as [number, number, number],
          up: [...patch.camera.up] as [number, number, number],
          fov: patch.camera.fov,
        }
        : current.camera,
      associatedRegions: patch.associatedRegions !== undefined
        ? [...patch.associatedRegions]
        : current.associatedRegions,
    };
    if (patch.framing !== undefined) updated.framing = { ...patch.framing };
    if (patch.associatedPlacements !== undefined) {
      updated.associatedPlacements = [...patch.associatedPlacements];
    }
    if (patch.label !== undefined) updated.label = patch.label;
    next[index] = updated;
    return { ok: true, views: next };
  } catch (error) {
    return listFail("malformed", `adjust model view failed (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Remove one operator view by stable id. */
export function removeModelDocumentView(
  views: readonly ModelDocumentView[],
  id: string,
  productId: string,
  variantId: string | undefined,
): ModelViewListResult {
  try {
    const next = cloneViews(views).filter((entry) =>
      !(entry.id === id && entry.productId === productId && (entry.variantId ?? "") === (variantId ?? ""))
    );
    if (next.length === views.length) {
      return listFail("unknown-view", `no model view "${id}" for this product option`);
    }
    return { ok: true, views: next };
  } catch (error) {
    return listFail("malformed", `remove model view failed (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Reorder operator views for one product/variant scope. `order` must name
 * exactly the scope's view ids, each once. Display order only — identity,
 * camera and bindings are untouched.
 */
export function reorderModelDocumentViews(
  views: readonly ModelDocumentView[],
  productId: string,
  variantId: string | undefined,
  order: readonly string[],
): ModelViewListResult {
  try {
    const scoped = cloneViews(views).filter((entry) =>
      entry.productId === productId && (entry.variantId ?? "") === (variantId ?? "")
    );
    if (order.length !== scoped.length) {
      return listFail("malformed", "reorder must name every view of this product option exactly once");
    }
    const ids = new Set(order);
    if (ids.size !== order.length || scoped.some((entry) => !ids.has(entry.id))) {
      return listFail("malformed", "reorder must name every view of this product option exactly once");
    }
    const rank = new Map(order.map((id, index) => [id, index] as const));
    const next = cloneViews(views);
    next.sort((a, b) => {
      const aScoped = a.productId === productId && (a.variantId ?? "") === (variantId ?? "");
      const bScoped = b.productId === productId && (b.variantId ?? "") === (variantId ?? "");
      if (aScoped && bScoped) return (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
      return compareModelViews(a, b);
    });
    return { ok: true, views: next };
  } catch (error) {
    return listFail("malformed", `reorder model views failed (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Stable digest of a view's camera + framing: part of the render binding so
 * a camera tweak invalidates the cached render. Display numbers rounded to
 * 6 decimals (presentation-only; production mm precision is untouched).
 */
export function cameraDigest(camera: ModelViewCamera, framing?: ModelViewFraming): string {
  const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
  const payload = {
    fov: round6(camera.fov),
    framing: framing === undefined ? null : {
      ...(framing.margin !== undefined ? { margin: round6(framing.margin) } : {}),
      ...(framing.aspect !== undefined ? { aspect: framing.aspect } : {}),
    },
    position: camera.position.map(round6),
    target: camera.target.map(round6),
    up: camera.up.map(round6),
  };
  return JSON.stringify(payload);
}

/**
 * Render cache key binding a capture to everything it depends on: the
 * stable view id, the committed revision (artwork), the camera digest (view
 * params) and the model asset revision (decode source). Any dependent change
 * produces a different key, so stale renders can never match.
 */
export function modelViewRenderKey(
  view: Pick<ModelDocumentView, "id" | "modelAssetId" | "modelRevision"> & { camera: ModelViewCamera; framing?: ModelViewFraming },
  revision: number,
): string {
  return [
    view.id,
    view.modelAssetId,
    view.modelRevision,
    String(revision),
    cameraDigest(view.camera, view.framing),
  ].join("\0");
}

/**
 * True when a cached render is unusable for the current state: revision
 * moved on, the view's camera/framing changed, or the model asset changed.
 * Pure; callers drop stale entries (or mark them pending) instead of
 * printing them.
 */
export function isModelViewRenderStale(
  render: Pick<ModelViewRender, "revision" | "cameraKey" | "modelRevision">,
  view: Pick<ModelDocumentView, "modelRevision"> & { camera: ModelViewCamera; framing?: ModelViewFraming },
  currentRevision: number,
): boolean {
  if (render.revision !== currentRevision) return true;
  if (render.modelRevision !== view.modelRevision) return true;
  return render.cameraKey !== cameraDigest(view.camera, view.framing);
}

/**
 * Monotonic async coordinator: every capture/decode request takes a token,
 * and only the latest token for a key may settle. Late resolutions from a
 * superseded capture or a slow asset decode report `false` from `resolve`
 * and must be discarded, never painted.
 *
 * Pure (no promises/timers); the caller owns the async work and consults
 * `resolve` on completion.
 */
export interface ModelRenderCoordinator {
  /** Issue a request token for `key`, superseding any earlier token. */
  request(key: string): number;
  /** True when `token` is still the latest for `key` (settles the render). */
  resolve(key: string, token: number): boolean;
  /** Drop all outstanding requests for `key` (e.g. view removed). */
  cancel(key: string): void;
}

export function createModelRenderCoordinator(): ModelRenderCoordinator {
  let nextToken = 1;
  const latest = new Map<string, number>();
  return {
    request(key: string): number {
      const token = nextToken;
      nextToken += 1;
      latest.set(key, token);
      return token;
    },
    resolve(key: string, token: number): boolean {
      return latest.get(key) === token;
    },
    cancel(key: string): void {
      latest.delete(key);
    },
  };
}

/**
 * Decoration-method passthrough for model-view relevance copy. The
 * lead-owned method catalogue (`src/core/decoration-methods`) is
 * authoritative when landed; until then this accepts the settled methods
 * (embroidery, heat-seal, print) plus any other explicitly named method and
 * rejects only empty strings. No invented temperature/time/pressure or
 * physical limits live here.
 */
const SETTLED_METHODS: ReadonlySet<string> = new Set(["embroidery", "heat-seal", "print"]);

export function normalizeModelViewMethod(method: unknown): string | null {
  if (typeof method !== "string") return null;
  const trimmed = method.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  if (SETTLED_METHODS.has(trimmed)) return trimmed;
  return trimmed;
}
