/// <reference lib="dom" />
/**
 * Visual product-setup workspace (one staff entry, operation-sheet first).
 *
 * Tabbed product views (flexible named views in caller order — legacy
 * Front/Back/Left/Right plus any caller-named views — only views present in
 * the input) around a large white photo stage with two explicit tools:
 * **Safe area** (draw a fresh polygon by clicks, close/finish, drag/insert/
 * remove vertices, keyboard throughout) and **Anchor** (click to place named
 * anchors, drag/rename/delete, keyboard throughout).
 *
 * Each view carries its OWN actual scope (product/variant/region/frame/
 * calibration/side): front and back views genuinely differ, so rendering,
 * anchor creation, saving and scale routing always use the active tab's
 * scope — a side string is never swapped onto another view's scope.
 *
 * Tool-mode separation: photo clicks only ever act in the active tool —
 * switching tabs or dragging markers can never create geometry. All geometry
 * stays in region-frame millimetres via the same caller-evaluated
 * photo-mapping affine plumbing as `anchor-setup.ts`; photo pixels are
 * display only, and nothing here reads files, fetches, or persists (no
 * browser storage of customer data).
 *
 * Normal panels stay minimal (short human labels, selected-item rename +
 * remove, direct canvas handles); coordinate tables and mapping metadata
 * live in ONE contextual Advanced disclosure per panel. Keyboard geometry
 * access (arrows/Delete/Enter/Escape on handles, focus restoration) works
 * throughout.
 *
 * Scoped staging: edits are keyed by stable caller-provided identity
 * (photoId + sourceRev + full scope ids + stable view id + frame/calibration
 * versions + transform coefficients), so switching tabs retains staged edits
 * while ANY asset/scope/mapping/source change re-initialises from caller
 * state — stale geometry is dropped, never reinterpreted. Tab titles are
 * human labels (display only); renames preserve buckets, calibration and
 * anchors. ONE atomic **Save product setup** awaits the caller's explicit acknowledgement: while pending the
 * Save control is disabled against overlap, edits stay live, failure keeps
 * the draft dirty and intact, and success is announced only on `{ ok: true }`.
 *
 * Named safe areas: each view stages 0..N named safe polygons authored on
 * the photo under the CURRENT calibration — never a single-area assumption,
 * and never an invented default polygon when a fresh calibration carries no
 * saved area (the list then starts empty). One area is active at a time;
 * its polygon is the staged `safeArea` that Save commits. Select list,
 * rename, delete, redraw and draw-new are all staged edits. Area names and
 * non-active areas are session-staged alongside the bucket (the save payload
 * carries them as an optional additive field for later persistence wiring);
 * recalibration (a new identity key) restarts from the caller's saved setup
 * only — staged extras are dropped, never reinterpreted — and the panel
 * states this up front.
 *
 * Layer visibility (anchors layer, safe-areas layer) is toggled by
 * data-preserving checkboxes: hiding never deletes staged geometry, and
 * starting a drawing auto-shows its layer with a status note.
 *
 * Calibration honesty: millimetres come only from the caller-evaluated
 * mapping, which stays pending review — this view never claims production
 * approval.
 */

import {
  forwardPhotoMapping,
  inversePhotoMapping,
} from '../customer-editor/presentation-photo-mapping.js';
import type {
  PhotoMappingTransform,
  PhotoMappingView,
} from '../customer-editor/presentation-photo-mapping.js';
import { bytesToDataUrl } from '../shared/operation-document/index.js';
import {
  canCloseDrawnPolygon,
  polygonSignedAreaMm,
  validateSafeAreaPolygon,
} from './anchor-setup.js';
import type {
  AnchorSetupMm,
  AnchorSetupPhoto,
} from './anchor-setup.js';
import type { AnchorDef } from '../../core/operation-measurements/types.js';
import type { ProjectDocument } from '../../core/types.js';
import {
  SETUP_LIMITS,
  validateNamedSafeArea,
} from '../../core/setup-calibration/index.js';
import type { DraftRetirementEvent } from '../../core/workspace-drafts/types.js';
import { applyRetirementEvents, parseDraftIdentityKey } from '../../core/workspace-drafts/index.js';

// (No logo selection in this view: logos live in Choose/Check per-logo cards,
// so only anchors and safe-area corners get selection controls here.)

/** Product views, in tab order. Tabs render only for views present in input. */
export type ProductSetupSide = PhotoMappingView;

export const PRODUCT_SETUP_SIDES: readonly ProductSetupSide[] = ['front', 'back', 'left', 'right'];

/** Upper bound for named workspace views (flexible identity stays bounded). */
export const MAX_PRODUCT_SETUP_VIEWS = 32;
/** Stable view-id bound: explicit, deterministic, independent of labels. */
export const MAX_PRODUCT_SETUP_VIEW_ID_LENGTH = 128;
/** Display-only view-label bound (labels never affect identity or math). */
export const MAX_PRODUCT_SETUP_VIEW_LABEL_LENGTH = 80;

function sideLabel(side: ProductSetupSide): string {
  switch (side) {
    case 'front': return 'Front';
    case 'back': return 'Back';
    case 'left': return 'Left';
    case 'right': return 'Right';
  }
}

/** Actual scope for ONE view. Front/back views genuinely differ — never swap sides across scopes. */
export interface ProductSetupScope {
  productId: string;
  variantId: string;
  regionId: string;
  frameId: string;
  calibrationId: string;
  calibrationVersion: string;
  regionName: string | null;
  side: ProductSetupSide;
  /**
   * Stable view identity, independent of the human label. Renaming the label
   * preserves the staged bucket, calibration and identity. Defaults to `side`
   * when absent (legacy 4-side projects); distinct named views sharing one
   * legacy side bucket (e.g. a detail of the front photo) carry distinct ids.
   */
  viewId?: string;
  /**
   * Display-only human label for the view tab. Never validated, never part of
   * the identity key, never compared across scopes. Defaults to the legacy
   * side label when absent.
   */
  viewLabel?: string | null;
}

/**
 * Stable identity of one view's scope: the explicit `viewId` when present
 * and valid, else the legacy `side`. Pure. Renames never change this, so
 * staged buckets, calibration and anchors survive relabelling.
 */
export function scopeViewId(scope: ProductSetupScope): string {
  const id = scope.viewId?.trim() ?? '';
  if (id.length > 0 && id.length <= MAX_PRODUCT_SETUP_VIEW_ID_LENGTH) return id;
  return scope.side;
}

/** Human label for one view's scope: the explicit label, else the side label. Pure; display only. */
export function scopeViewLabel(scope: ProductSetupScope): string {
  const label = scope.viewLabel?.trim() ?? '';
  if (label.length > 0) {
    return label.length <= MAX_PRODUCT_SETUP_VIEW_LABEL_LENGTH
      ? label
      : label.slice(0, MAX_PRODUCT_SETUP_VIEW_LABEL_LENGTH);
  }
  return sideLabel(scope.side);
}

/** Short human label for headings/captions: never ids, never jargon. */
export function shortScopeLabel(scope: ProductSetupScope): string {
  const label = scopeViewLabel(scope);
  if (scope.regionName === null || scope.regionName.trim().length === 0) return `${label} view`;
  return `${scope.regionName} · ${label}`;
}

/** Caller-owned state for one side view, including its actual scope + identities. */
export interface ProductSetupPhotoView {
  /** The actual scope for THIS view (region/frame/calibration included). */
  scope: ProductSetupScope;
  /**
   * Caller-owned asset/content identity for the photo (e.g. package path +
   * digest when real assets are wired). Opaque string — never byte length.
   */
  photoId: string;
  /** Caller-owned source-project session identity (project reopen = new rev). */
  sourceRev: string;
  /** Mapped product photo (header-validated raster bytes + pixel size). */
  photo: AnchorSetupPhoto;
  /** Caller-evaluated mapping for this exact photo, or null when missing. */
  transform: PhotoMappingTransform | null;
  mappingStatus: 'provisional' | 'review';
  /** Approved safe-area polygon, region-local millimetres. */
  safeArea: ReadonlyArray<AnchorSetupMm>;
  /** Anchors already authored for this scope (other scopes untouched). */
  anchors: readonly AnchorDef[];
  /**
   * Sibling named areas persisted for this scope (same calibration/frame,
   * caller-owned sibling regions) — seeded verbatim into staging so renames
   * and multiple polygons survive save/reopen. Absent means the legacy
   * single-area shape: seed one entry from `safeArea` (or none when empty).
   */
  savedAreas?: ReadonlyArray<{ id: string; name: string; points: ReadonlyArray<AnchorSetupMm> }>;
  /** Id of the active entry within `savedAreas`; null/undefined selects by rule. */
  savedActiveAreaId?: string | null;
  /**
   * Saved two-click reference span evidence for this exact calibrated view
   * (native photo UV endpoints + declared millimetre length + calibration
   * binding). Additive and optional: the lead wires it from the span sidecar
   * bound to this exact asset/view/calibration at integration. Absent (or
   * stale) means no reference overlay is drawn — this view never fabricates
   * A/B endpoints from measurement anchors or safe-area bboxes. Never part
   * of the staged identity key: photoId + calibration already bind it.
   */
  referenceSpan?: ProductSetupReferenceSpan | null;
}

export type ProductSetupViewState = ProductSetupPhotoView | { error: string };

export function isProductSetupPhotoView(state: ProductSetupViewState): state is ProductSetupPhotoView {
  return 'photo' in state;
}

/** Live inputs for the workspace. The caller owns every value. */
export interface ProductSetupWorkspaceInput {
  /** First-tab hint only (used until the operator picks a tab). */
  initialSide?: ProductSetupSide;
  /** Actual views present, keyed by side. Absent sides render no tab. */
  views: { [K in ProductSetupSide]?: ProductSetupViewState };
  /**
   * Scoped-draft retirement events for this refresh (filled by the caller;
   * e.g. photo replacement or binding invalidation). Applied to staged
   * buckets, drawing drafts and redraw markers; unparseable keys never match.
   */
  retirements?: readonly DraftRetirementEvent[];
  /**
   * Shared-region notice (e.g. an edit reaching other options), rendered as
   * an explicit warning line in the save bar when present.
   */
  sharedNotice?: string;
}

/**
 * One flexible named view for the V2 workspace input: a stable identity plus
 * a display-only label plus the view state itself. The tab title is `label`;
 * the identity key is `id` (never label text), so renaming preserves the
 * staged bucket, calibration and anchors.
 */
export interface ProductSetupNamedInputView {
  /** Stable view id (1..128 chars, explicit, deterministic). */
  id: string;
  /** Human tab label (display only; renames never invalidate). */
  label: string;
  /** The view state (photo view or error), as in the legacy input. */
  state: ProductSetupViewState;
}

/**
 * Flexible workspace input (V2) for the lead/Worker2 manifest mapping. Tabs
 * are driven by `views` in array order (bounded, deduplicated, deterministic
 * — see {@link listWorkspaceViews}); the legacy side-keyed input keeps
 * working unchanged. Either shape reaches the view; the caller never imports
 * UI types into core (this interface is plain data).
 */
export interface ProductSetupWorkspaceInputV2 {
  /** First-tab hint by stable view id (used until the operator picks a tab). */
  initialViewId?: string;
  /** Named views present, in tab order. Absent ids render no tab. */
  views: ProductSetupNamedInputView[];
  /** Scoped-draft retirement events for this refresh (same as legacy). */
  retirements?: readonly DraftRetirementEvent[];
  /** Shared-region notice, rendered as an explicit warning line when present. */
  sharedNotice?: string;
}

/** Either accepted workspace input shape (legacy side-keyed or V2 named). */
export type ProductSetupWorkspaceInputAny =
  | ProductSetupWorkspaceInput
  | ProductSetupWorkspaceInputV2;

/** One normalized tab: stable id, display label, and view state. Pure data. */
export interface ProductSetupListedView {
  id: string;
  label: string;
  state: ProductSetupViewState;
}

/**
 * Normalize a caller view id: trimmed, 1..128 chars, else null (dropped,
 * never invented). Pure.
 */
export function normalizeProductSetupViewId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PRODUCT_SETUP_VIEW_ID_LENGTH) return null;
  return trimmed;
}

/**
 * Normalize a caller view label: trimmed display text capped at 80 chars,
 * falling back to `fallback` when blank. Pure; display only.
 */
export function normalizeProductSetupViewLabel(label: unknown, fallback: string): string {
  const text = typeof label === 'string' ? label.trim() : '';
  if (text.length === 0) return fallback;
  return text.length <= MAX_PRODUCT_SETUP_VIEW_LABEL_LENGTH
    ? text
    : text.slice(0, MAX_PRODUCT_SETUP_VIEW_LABEL_LENGTH);
}

/**
 * Normalize either input shape into the ordered tab list: stable ids,
 * display labels, first-wins dedupe by id, bounded to
 * {@link MAX_PRODUCT_SETUP_VIEWS} (never drops below 5 valid views by
 * itself — the bound is 32; excess entries are dropped deterministically
 * from the tail). Legacy inputs list in `PRODUCT_SETUP_SIDES` order with
 * scope-driven ids/labels; V2 inputs list in array order. Pure; no DOM.
 */
export function listWorkspaceViews(input: ProductSetupWorkspaceInputAny): ProductSetupListedView[] {
  const listed: ProductSetupListedView[] = [];
  const rawViews = (input as Partial<ProductSetupWorkspaceInputV2>).views;
  if (Array.isArray(rawViews)) {
    for (const entry of rawViews) {
      if (entry === null || typeof entry !== 'object') continue;
      const candidate = entry as Partial<ProductSetupNamedInputView>;
      const id = normalizeProductSetupViewId(candidate.id);
      if (id === null || candidate.state === undefined) continue;
      if (listed.some((existing) => existing.id === id)) continue;
      listed.push({
        id,
        label: normalizeProductSetupViewLabel(candidate.label, id),
        state: candidate.state,
      });
      if (listed.length >= MAX_PRODUCT_SETUP_VIEWS) break;
    }
    return listed;
  }
  if (rawViews === null || typeof rawViews !== 'object') return [];
  const v1 = input as ProductSetupWorkspaceInput;
  for (const side of PRODUCT_SETUP_SIDES) {
    const raw = v1.views[side];
    if (raw === undefined) continue;
    if (isProductSetupPhotoView(raw)) {
      const id = scopeViewId(raw.scope);
      if (listed.some((existing) => existing.id === id)) continue;
      listed.push({ id, label: scopeViewLabel(raw.scope), state: raw });
    } else {
      if (listed.some((existing) => existing.id === side)) continue;
      listed.push({ id: side, label: sideLabel(side), state: raw });
    }
    if (listed.length >= MAX_PRODUCT_SETUP_VIEWS) break;
  }
  return listed;
}

/**
 * Resolve one tab's usable view by stable id, or an error when the id is
 * absent or the view itself carries an error. Always feeds
 * rendering/saving/anchor work — never a swapped top-level scope.
 */
export function selectWorkspaceViewById(
  input: ProductSetupWorkspaceInputAny,
  id: string,
): ProductSetupPhotoView | { error: string } {
  const found = listWorkspaceViews(input).find((entry) => entry.id === id);
  if (!found) return { error: `The “${id}” view is unavailable for this product.` };
  return found.state;
}

/**
 * Resolve one tab's usable view, or an error when the side is absent or the
 * view itself carries an error. Always feeds rendering/saving/anchor work —
 * never a swapped top-level scope.
 */
export function selectWorkspaceView(
  input: ProductSetupWorkspaceInput,
  side: ProductSetupSide,
): ProductSetupPhotoView | { error: string } {
  const raw = input.views[side];
  if (raw === undefined) return { error: `The ${sideLabel(side)} view is unavailable for this product.` };
  return raw;
}

/** Pick the tab: keep the operator's choice when present, else the hint, else the first view. */
export function resolveInitialView(
  input: ProductSetupWorkspaceInputAny,
  current: string | null,
): string | null {
  const present = listWorkspaceViews(input).map((entry) => entry.id);
  if (current !== null && present.includes(current)) return current;
  const hint = Array.isArray((input as ProductSetupWorkspaceInputV2).views)
    ? (input as ProductSetupWorkspaceInputV2).initialViewId
    : (input as ProductSetupWorkspaceInput).initialSide;
  if (hint !== undefined && present.includes(hint)) return hint;
  return present[0] ?? null;
}

/** Pick the tab: keep the operator's choice when present, else the hint, else the first view. */
export function resolveInitialSide(
  input: ProductSetupWorkspaceInput,
  current: ProductSetupSide | null,
): ProductSetupSide | null {
  const resolved = resolveInitialView(input, current);
  if (resolved === null) return null;
  return PRODUCT_SETUP_SIDES.includes(resolved as ProductSetupSide)
    ? (resolved as ProductSetupSide)
    : null;
}

/** Stable transform fingerprint for draft-bucket identity (exact coefficients, or null). */
export function transformKeyOf(transform: PhotoMappingTransform | null): string {
  if (!transform) return 'null';
  return JSON.stringify([transform.a, transform.b, transform.c, transform.d, transform.e, transform.f]);
}

/**
 * Stable identity for one view's staged edits. Same photoId + sourceRev +
 * full scope (including the stable view id, which equals the tab side for
 * legacy views) + transform → same key (drafts retained, e.g. across tab
 * switches and label renames). ANY change (photo swap, calibration bump, new
 * source project, re-evaluated mapping, view) → a different key, so the view
 * re-initialises from caller state and never reinterprets stale geometry.
 * Byte length is deliberately NOT part of the key.
 *
 * The key stays a 10-string JSON array (slot 8 is the stable view id) so the
 * `workspace-drafts` retirement parser keeps matching: file replacement
 * retires only the affected view's evidence, and labels never invalidate.
 * Legacy views (no explicit `viewId`) produce byte-identical keys to before.
 */
export function viewIdentityKey(view: ProductSetupPhotoView): string {
  return JSON.stringify([
    view.photoId,
    view.sourceRev,
    view.scope.productId,
    view.scope.variantId,
    view.scope.regionId,
    view.scope.frameId,
    view.scope.calibrationId,
    view.scope.calibrationVersion,
    scopeViewId(view.scope),
    transformKeyOf(view.transform),
  ]);
}

export interface StoredEdits {
  safeArea: AnchorSetupMm[];
  anchors: AnchorDef[];
  dirty: boolean;
  /**
   * Live saved safe area this bucket was last reconciled with (deep copy).
   * Baseline-aware shared geometry: when another scope saves the shared
   * region, an UNEDITED bucket (safeArea deep-equals base) adopts live while
   * keeping staged per-scope anchors; an EDITED bucket whose live moved is
   * a conflict — saving is blocked until Reset, never silently overwritten.
   * Updated on init, live-adopt, and successful save of this bucket.
   */
  baseSafeArea: AnchorSetupMm[];
  /** True while the bucket is edited AND live moved underneath (see above). */
  conflicted: boolean;
  /**
   * Named safe areas staged for this calibration identity (0..N). The
   * ACTIVE entry's polygon mirrors `safeArea` (see {@link syncActiveArea});
   * selecting another entry swaps the staged polygon. Seeded from the
   * caller's saved area only — a fresh calibration with no saved area
   * starts with an empty list, never an invented polygon. Dropped with the
   * bucket on recalibration, never reinterpreted.
   *
   * Optional so pre-existing caller/test literals without staged areas keep
   * compiling: absent means no staged areas. View buckets always set it.
   */
  namedAreas?: NamedSafeArea[];
  /** Id of the active named area; absent/null when the list is empty. */
  activeAreaId?: string | null;
  /**
   * Deep copy of the named-area list as SEEDED (before any staged edit).
   * The caller compares it against live siblings to refuse stale submitters
   * that never saw another scope's save — the sibling analogue of
   * `baseSafeArea`. Absent on older buckets means no baseline: only the
   * session baseline guard applies.
   */
  baseNamedAreas?: NamedSafeArea[];
  /**
   * Data-preserving layer visibility (render-only; hiding never deletes).
   * Absent means visible.
   */
  showAnchors?: boolean;
  showAreas?: boolean;
  /**
   * Product-photo visibility (render-only; hiding the photo keeps every
   * overlay, staged polygon, anchor and draft intact). Absent means visible.
   */
  showProduct?: boolean;
}

/**
 * One named safe area staged under the current calibration. Deliberately the
 * same shape as the kernel's `NamedSafeArea` (`{ id, name, points }` in
 * setup-frame millimetres under the front-on planar assumption), so staged
 * entries pass straight into the W1 `validateNamedSafeArea` without
 * conversion; structural typing keeps this view decoupled from kernel types.
 */
export interface NamedSafeArea {
  id: string;
  name: string;
  points: AnchorSetupMm[];
}

function cloneSafeArea(area: ReadonlyArray<AnchorSetupMm>): AnchorSetupMm[] {
  return area.map((point) => ({ ...point }));
}

function sameSafeArea(a: ReadonlyArray<AnchorSetupMm>, b: ReadonlyArray<AnchorSetupMm>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Session edit store keyed by {@link viewIdentityKey}. Pure; no DOM. */
export interface WorkspaceEditStore {
  bucketFor(key: string, init: () => StoredEdits): StoredEdits;
  dropBucket(key: string): void;
  retainBuckets(keep: ReadonlySet<string>): void;
  draftFor(key: string): AnchorSetupMm[] | undefined;
  setDraft(key: string, draft: AnchorSetupMm[]): void;
  dropDraft(key: string): void;
  retainDrafts(keep: ReadonlySet<string>): void;
}

export function createWorkspaceEditStore(): WorkspaceEditStore {
  const buckets = new Map<string, StoredEdits>();
  const drafts = new Map<string, AnchorSetupMm[]>();
  return {
    bucketFor(key: string, init: () => StoredEdits): StoredEdits {
      const existing = buckets.get(key);
      if (existing) return existing;
      const fresh = init();
      buckets.set(key, fresh);
      return fresh;
    },
    dropBucket(key: string): void {
      buckets.delete(key);
    },
    retainBuckets(keep: ReadonlySet<string>): void {
      for (const key of [...buckets.keys()]) {
        if (!keep.has(key)) buckets.delete(key);
      }
    },
    draftFor(key: string): AnchorSetupMm[] | undefined {
      return drafts.get(key);
    },
    setDraft(key: string, draft: AnchorSetupMm[]): void {
      drafts.set(key, draft);
    },
    dropDraft(key: string): void {
      drafts.delete(key);
    },
    retainDrafts(keep: ReadonlySet<string>): void {
      for (const key of [...drafts.keys()]) {
        if (!keep.has(key)) drafts.delete(key);
      }
    },
  };
}

export interface ProductSetupResult {
  safeArea: AnchorSetupMm[];
  anchors: AnchorDef[];
  /**
   * Saved safe area the staged edits started from (deep copy). The caller
   * refuses the commit when live moved underneath — the async shared-region
   * guard against silent overwrites.
   */
  baseSafeArea: AnchorSetupMm[];
  /**
   * All named areas at save time (deep copy). The caller persists every
   * entry as sibling domain regions (same frame/calibration) plus the
   * scope-entry polygon into the scope region — renames and multiple
   * polygons survive save/reopen. Entries whose polygon deep-equals
   * `safeArea` identify the staged polygon; absence means legacy
   * single-area staging.
   */
  namedAreas?: NamedSafeArea[];
  /**
   * Deep copy of the named-area list as SEEDED, for the caller's
   * stale-submitter guard (refuse when live siblings contain entries this
   * bucket never saw). Absent means legacy: only the session guard applies.
   */
  baseNamedAreas?: NamedSafeArea[];
  /**
   * Explicit id of the staged active area (Codex P1: never inferred by the
   * caller). The caller uses it for status and active-area bookkeeping; the
   * scope region always carries the scope-entry polygon, never the selection.
   */
  activeAreaId?: string | null;
}

/** Explicit save acknowledgement the view awaits (sync or async). */
export type ProductSetupSaveResult =
  | { ok: true; scopeSafeArea?: AnchorSetupMm[] }
  | { ok: false; error: string };

export interface ProductSetupCallbacks {
  /**
   * Atomically persist safe area + anchors for the saved tab scope — or
   * neither. Return `{ ok: true }` only after durable persistence;
   * `{ ok: false; error }` (or a rejecting promise) keeps the view's draft
   * dirty and intact. May be sync or async; the view awaits either.
   */
  onSave(scope: ProductSetupScope, result: ProductSetupResult): ProductSetupSaveResult | Promise<ProductSetupSaveResult>;
  /** Human status line for the caller to display. */
  onStatus(message: string): void;
  /** Photo has no evaluated mapping for this tab scope; caller routes to scale setup. */
  onScaleNeeded(scope: ProductSetupScope): void;
}

export interface ProductSetupViewHandle {
  /** Re-render from the latest caller state (scope/side/photo change). */
  refresh(): void;
  /** Remove all listeners created by this view. */
  destroy(): void;
}

type ProductSetupTool = 'safe-area' | 'anchor';

/** Validate a save request and build the deep-copied payload. Pure; no DOM. */
export function validateSaveRequest(
  safeArea: ReadonlyArray<AnchorSetupMm>,
  anchors: readonly AnchorDef[],
  baseSafeArea?: ReadonlyArray<AnchorSetupMm>,
): { ok: true; result: ProductSetupResult } | { ok: false; error: string } {
  const check = validateSafeAreaPolygon([...safeArea]);
  if (!check.ok) return { ok: false, error: `the safe area is invalid — ${check.reason}` };
  const problem = validateAnchors(anchors);
  if (problem) return { ok: false, error: problem };
  const base = baseSafeArea ?? safeArea;
  return {
    ok: true,
    result: {
      safeArea: safeArea.map((corner) => ({ ...corner })),
      anchors: anchors.map((anchor) => ({
        ...anchor,
        posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number],
      })),
      baseSafeArea: base.map((corner) => ({ ...corner })),
    },
  };
}

export function validateAnchors(anchors: readonly AnchorDef[]): string | null {
  const seen = new Set<string>();
  for (const anchor of anchors) {
    const name = anchor.name.trim();
    if (name.length === 0) return 'anchor names must not be empty.';
    if (name.length > 80) return `anchor “${name}” exceeds 80 characters.`;
    if (seen.has(name)) return `another anchor is already called “${name}”.`;
    seen.add(name);
    if (!Number.isFinite(anchor.posMm[0]) || !Number.isFinite(anchor.posMm[1])) {
      return `anchor “${name}” has a non-finite millimetre position.`;
    }
  }
  return null;
}

// NOTE (W1 kernel): named-area validation delegates to the provisional
// `src/core/setup-calibration` kernel (`validateNamedSafeArea`), owned by W1.
// Signature: `(area: { id, name, points }, existingIds: readonly string[])`
// returns a human reason string, or null when valid. It enforces unique ids,
// a non-blank name (≤80 chars) and a valid non-crossing non-zero-area ring,
// but NOT name uniqueness across areas — the rename handler below checks
// that locally (exact match, excluding the edited entry) before delegating.

let areaCounter = 0;

function newAreaId(): string {
  areaCounter += 1;
  let suffix = `${areaCounter}`;
  try {
    const bytes = new Uint8Array(2);
    globalThis.crypto?.getRandomValues?.(bytes);
    suffix = `${areaCounter}-${bytes[0]!.toString(16).padStart(2, '0')}${bytes[1]!.toString(16).padStart(2, '0')}`;
  } catch {
    suffix = `${areaCounter}-${Math.floor(Math.random() * 65536).toString(16)}`;
  }
  return `psetup-area-${suffix}`;
}

/** Next collision-free area name (`Area N`, skipping taken names). Pure. */
export function nextAreaName(takenNames: ReadonlyArray<string>): string {
  const taken = new Set(takenNames);
  let serial = taken.size + 1;
  while (taken.has(`Area ${serial}`)) serial += 1;
  return `Area ${serial}`;
}

/**
 * Seed the staged named-area list from caller state ONLY: the caller's saved
 * sibling list verbatim when supplied (stable ids, renames and multiple
 * polygons survive save/reopen), plus — when the saved scope polygon is
 * non-empty — a leading scope entry mirroring it, so a previously drawn
 * polygon is never duplicated into a sibling nor silently dropped. Without
 * supplied siblings, one entry mirrors a non-empty saved polygon, otherwise
 * an empty list — never an invented default polygon on a new calibration.
 * The active id is honoured when it matches an entry, else the scope entry,
 * else the first entry. Pure; no DOM.
 */
export function seedNamedAreas(
  savedSafeArea: ReadonlyArray<AnchorSetupMm>,
  regionName: string | null,
  saved?: { areas: ReadonlyArray<{ id: string; name: string; points: ReadonlyArray<AnchorSetupMm> }>; activeAreaId: string | null | undefined },
): { namedAreas: NamedSafeArea[]; activeAreaId: string | null } {
  if (saved !== undefined) {
    const areas = saved.areas.map((area) => ({
      id: area.id,
      name: area.name,
      points: area.points.map((point) => ({ ...point })),
    }));
    if (savedSafeArea.length > 0) {
      areas.unshift({
        id: SCOPE_SAVED_AREA_ID,
        name: regionName?.trim() ? regionName.trim() : 'Saved area',
        points: savedSafeArea.map((point) => ({ ...point })),
      });
    }
    const active = saved.activeAreaId ?? null;
    return {
      namedAreas: areas,
      activeAreaId: active !== null && areas.some((entry) => entry.id === active)
        ? active
        : (areas[0]?.id ?? null),
    };
  }
  if (savedSafeArea.length === 0) return { namedAreas: [], activeAreaId: null };
  const entry: NamedSafeArea = {
    id: newAreaId(),
    name: regionName?.trim() ? regionName.trim() : 'Saved area',
    points: savedSafeArea.map((point) => ({ ...point })),
  };
  return { namedAreas: [entry], activeAreaId: entry.id };
}

/**
 * Stable staged id for the scope-polygon entry (see {@link seedNamedAreas}).
 * Never a domain region id; the scope polygon always persists in its own
 * region, never in a sibling.
 */
export const SCOPE_SAVED_AREA_ID = 'scope-saved-area';

/** Sibling-region id separator: `<scope region id>--area-<safe area id>`. */
export const SIBLING_REGION_SEPARATOR = '--area-';

/** Deterministic sibling domain-region id for one staged area. Pure. */
export function siblingRegionIdFor(scopeRegionId: string, areaId: string): string {
  const safe = areaId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `${scopeRegionId}${SIBLING_REGION_SEPARATOR}${safe === '' ? 'area' : safe}`;
}

/** True when a domain region id is a sibling of the given scope region. Pure. */
export function isSiblingRegionId(scopeRegionId: string, regionId: string): boolean {
  return regionId.startsWith(`${scopeRegionId}${SIBLING_REGION_SEPARATOR}`);
}

/** Recover the staged area id from a sibling region id (lossless for view-generated ids). Pure. */
export function areaIdFromSiblingRegionId(scopeRegionId: string, regionId: string): string | null {
  const prefix = `${scopeRegionId}${SIBLING_REGION_SEPARATOR}`;
  if (!regionId.startsWith(prefix)) return null;
  const rest = regionId.slice(prefix.length);
  return rest.length > 0 ? rest : null;
}

/**
 * Live sibling region ids the submitter never saw: present live, absent from
 * both the submission and the submitter's seed-time list. A non-empty result
 * means another scope saved first — the submitter must re-open instead of
 * silently reverting it. Empty base (legacy callers) disables the check and
 * leaves the session baseline guard in charge. Pure.
 */
export function unseenSiblingIds(
  liveIds: ReadonlyArray<string>,
  submittedIds: ReadonlyArray<string>,
  baseIds: ReadonlyArray<string> | undefined,
): string[] {
  if (baseIds === undefined) return [];
  const base = new Set(baseIds);
  const submitted = new Set(submittedIds);
  return liveIds.filter((id) => !submitted.has(id) && !base.has(id));
}

/**
 * Scope region owning a sibling region id: the longest known region id such
 * that `<scope>--area-<rest>`. Null when the id is not a sibling of any
 * known region. Pure; the lead uses it to route sibling-owned mappings back
 * to their owning scope instead of mistaking a sibling for a scope.
 */
export function scopeOwnerOf(
  regions: ReadonlyArray<{ id: string }>,
  regionId: string,
): string | null {
  let best: string | null = null;
  for (const region of regions) {
    const prefix = `${region.id}${SIBLING_REGION_SEPARATOR}`;
    if (regionId.startsWith(prefix) && regionId.length > prefix.length &&
      (best === null || region.id.length > best.length)) {
      best = region.id;
    }
  }
  return best;
}

/** Region ids referenced by any placement of one product (must never dangle). Pure. */
export function referencedRegionIds(project: ProjectDocument, productId: string): Set<string> {
  const used = new Set<string>();
  for (const config of project.configurations) {
    if (config.productId !== productId) continue;
    for (const placement of config.placements) used.add(placement.regionId);
  }
  return used;
}

/**
 * Delete/retire regions whose areas left the setup (Codex deletion rule).
 * Unreferenced regions are flagged for REMOVAL with their variant links
 * (real delete); referenced ones are flagged for RETIREMENT in place
 * (emptied polygon so nothing new fits, current calibration ref so the
 * project stays valid, links kept so placed data stays resolvable and
 * geometry gates mark it invalid). Pure mutation of the caller's draft
 * product; returns names for status. Never relabels stale geometry as
 * current calibration output: retired polygons are emptied, not kept.
 */
export function retireDeletedRegions(
  nextProduct: ProjectDocument['products'][number],
  orphans: ReadonlyArray<{ id: string; name: string }>,
  calibrationId: string,
  version: string,
  referenced: ReadonlySet<string>,
): { removed: Array<{ id: string; name: string }>; retired: Array<{ id: string; name: string }> } {
  const removed: Array<{ id: string; name: string }> = [];
  const retired: Array<{ id: string; name: string }> = [];
  for (const orphan of orphans) {
    const live = nextProduct.regions.find((entry) => entry.id === orphan.id);
    if (!live) continue;
    if (referenced.has(orphan.id)) {
      live.safeArea = [];
      live.calibrationRef = { calibrationId, version };
      retired.push({ id: orphan.id, name: orphan.name });
    } else {
      nextProduct.regions = nextProduct.regions.filter((entry) => entry.id !== orphan.id);
      for (const linked of nextProduct.variants) {
        linked.regionIds = linked.regionIds.filter((id) => id !== orphan.id);
      }
      removed.push({ id: orphan.id, name: orphan.name });
    }
  }
  return { removed, retired };
}

/** Version marker for the per-product explicit active-area hint file. */
export const ACTIVE_AREAS_VERSION = 'active-areas/1';
/** Bounds for the hint file (display hint only; never fails a save/load). */
export const ACTIVE_AREAS_LIMITS = {
  maxBytes: 8 * 1024,
  maxScopes: 256,
  maxIdLength: 256,
} as const;

/**
 * Read an active-area hint file: scope-region id -> staged area id, or {}
 * on any mismatch (version, shape, bounds). Never throws, never fails a
 * save/load — seeding falls back deterministically without it. Pure.
 */
export function parseActiveAreasFile(bytes: Uint8Array | undefined): Record<string, string> {
  if (!bytes || bytes.length === 0 || bytes.length > ACTIVE_AREAS_LIMITS.maxBytes) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  if (record['version'] !== ACTIVE_AREAS_VERSION) return {};
  const scopes = record['scopes'];
  if (typeof scopes !== 'object' || scopes === null || Array.isArray(scopes)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scopes as Record<string, unknown>)) {
    if (Object.keys(out).length >= ACTIVE_AREAS_LIMITS.maxScopes) break;
    if (typeof key !== 'string' || key.length === 0 || key.length > ACTIVE_AREAS_LIMITS.maxIdLength) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > ACTIVE_AREAS_LIMITS.maxIdLength) continue;
    out[key] = value;
  }
  return out;
}

/** Deterministic serialization (sorted scope keys). Pure. */
export function serializeActiveAreasFile(scopes: Record<string, string>): Uint8Array {
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(scopes).sort()) ordered[key] = scopes[key]!;
  return new TextEncoder().encode(JSON.stringify({ version: ACTIVE_AREAS_VERSION, scopes: ordered }));
}

/**
 * Mirror the staged `safeArea` polygon back into the active named entry
 * (deep copy). No-op when no area is active or no areas are staged (older
 * caller/test buckets carry none). Pure; no DOM.
 */
export function syncActiveArea(bucket: StoredEdits): void {
  const id = bucket.activeAreaId ?? null;
  if (id === null) return;
  const areas = bucket.namedAreas ?? [];
  const active = areas.find((entry) => entry.id === id);
  if (active) active.points = bucket.safeArea.map((corner) => ({ ...corner }));
}

/** Staged named areas (absent on older buckets means none). Pure. */
export function namedAreasOf(bucket: StoredEdits): NamedSafeArea[] {
  return bucket.namedAreas ?? [];
}

/** True unless the caller explicitly hid the layer. Pure. */
export function layerVisible(bucket: StoredEdits, layer: 'showAnchors' | 'showAreas'): boolean {
  return (bucket[layer] ?? true) !== false;
}

/**
 * Save state machine: serialises saves (no overlap), never rejects, and
 * reports malformed callback results as failure. Pure; no DOM — the view
 * derives the disabled Save control from `isPending`.
 */
export class ProductSetupSaver {
  private pending = false;

  get isPending(): boolean {
    return this.pending;
  }

  async run(
    task: () => ProductSetupSaveResult | Promise<ProductSetupSaveResult>,
  ): Promise<ProductSetupSaveResult> {
    if (this.pending) return { ok: false, error: 'A save is already in progress.' };
    this.pending = true;
    try {
      const outcome = await task();
      if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
        return { ok: false, error: 'The save callback returned no usable result.' };
      }
      if (outcome.ok) {
        const rebased = outcome.scopeSafeArea?.map((corner) => ({ ...corner }));
        return rebased === undefined ? { ok: true } : { ok: true, scopeSafeArea: rebased };
      }
      const reason = typeof outcome.error === 'string' && outcome.error.length > 0
        ? outcome.error
        : 'The save callback reported failure.';
      return { ok: false, error: reason };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.pending = false;
    }
  }
}

/**
 * Apply a settled save outcome to a staged bucket. Pure; returns the exact
 * status text the view shows. Success clears the dirty flag ONLY when the
 * bucket still equals the click-time snapshot (mid-save edits stay staged,
 * never clobbered); failure always keeps the draft dirty and intact.
 *
 * Re-baselining tracks the SAVED SCOPE polygon (`outcome.scopeSafeArea`,
 * falling back to the snapshot for legacy single-polygon callers), never
 * the staged polygon: with named areas the staged selection legitimately
 * differs from the scope region, and re-baselining to staged content would
 * make the next render misread it as a live change and adopt-revert it.
 */
export function applySaveOutcome(
  bucket: StoredEdits,
  snapshot: ProductSetupResult,
  scopeLabel: string,
  outcome: ProductSetupSaveResult,
): string {
  if (outcome.ok) {
    const liveJson = JSON.stringify({ safeArea: bucket.safeArea, anchors: bucket.anchors });
    const snapshotJson = JSON.stringify({ safeArea: snapshot.safeArea, anchors: snapshot.anchors });
    // The commit wrote exactly the snapshot: re-baseline shared geometry so
    // later cross-scope saves adopt cleanly instead of conflicting.
    const rebased = outcome.scopeSafeArea ?? snapshot.safeArea;
    bucket.baseSafeArea = rebased.map((corner) => ({ ...corner }));
    bucket.conflicted = false;
    // Advance the named-area seed baseline to exactly what was submitted:
    // without this, a second save from the same bucket would mistake its
    // own previously saved siblings for another scope's work and refuse.
    // Legacy snapshots without named areas leave the baseline untouched.
    if (snapshot.namedAreas !== undefined) {
      bucket.baseNamedAreas = snapshot.namedAreas.map((area) => ({
        ...area,
        points: area.points.map((corner) => ({ ...corner })),
      }));
    }
    if (liveJson === snapshotJson) {
      bucket.dirty = false;
      return `Saved ${scopeLabel} (${snapshot.safeArea.length} safe-area corners, ${snapshot.anchors.length} anchors).`;
    }
    bucket.dirty = true;
    return `Saved ${scopeLabel}, but newer edits arrived during the save ` +
      `and are still staged — save again to include them.`;
  }
  bucket.dirty = true;
  const reason = outcome.error.replace(/\.+$/, '');
  return `Save failed: ${reason}. Your edits are intact.`;
}

function displayMm1(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(Math.round(value * 10) / 10).toFixed(1)}`;
}

/**
 * Format a millimetre value for a precision number input. Finite values use
 * their shortest round-trip form so committing without edits is lossless;
 * non-finite values yield `''` (never committed). Pure; unit-tested.
 */
export function formatPrecisionMm(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(value);
}

/**
 * Parse a precision number-input string. Leading/trailing whitespace is
 * ignored; empty, non-numeric or non-finite input yields `null` so the caller
 * can refuse with the existing validator wording and keep the old value.
 * Pure; unit-tested.
 */
export function parsePrecisionMm(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// ---- Images reference overlay, zoom and safe-area drawing tools ----
// Additive Worker A helpers for the Images photo path. Each stays small and
// local to this view (mirroring guided-scale.ts where ultrapure overlap
// exists); the lead extracts ONE shared helper at integration only if real
// duplication appears. All pure; no DOM.

/** Zoom steps for the photo stage (percent; 100% = fitted product view). */
export const PRODUCT_SETUP_ZOOM_STEPS: readonly number[] = [50, 75, 100, 125, 150, 200, 300, 400];

/** Nearest zoom step for any input (NaN snaps to 100 = Fit). Pure. */
export function clampZoomPercentage(pct: number): number {
  if (!Number.isFinite(pct)) return 100;
  let best = PRODUCT_SETUP_ZOOM_STEPS[0]!;
  for (const step of PRODUCT_SETUP_ZOOM_STEPS) {
    if (Math.abs(step - pct) < Math.abs(best - pct)) best = step;
  }
  return best;
}

/** Step the zoom from `current` in `direction`, clamped at the bounds. Pure. */
export function stepZoomPercentage(current: number, direction: 1 | -1): number {
  const steps = PRODUCT_SETUP_ZOOM_STEPS;
  const clamped = clampZoomPercentage(current);
  const index = steps.indexOf(clamped);
  const next = index + direction;
  if (next < 0) return steps[0]!;
  if (next >= steps.length) return steps[steps.length - 1]!;
  return steps[next]!;
}

/**
 * Fraction of the viewport height bounding the fitted photo stage (~60vh:
 * 55–65vh on desktop, clamped to a sensible 320px minimum on short/narrow
 * viewports). Shared by the calibrated stage and the guided-scale panel.
 */
export const PRODUCT_SETUP_FIT_VH = 0.6;
/** Minimum fitted-stage height in CSS px (narrow/short viewports). */
export const PRODUCT_SETUP_FIT_MIN_PX = 320;

/** Contain-fit photo box in CSS px (aspect preserved, never cropped). Pure. */
export interface ProductSetupFitBox {
  width: number;
  height: number;
}

/**
 * Contain-fit `photoW × photoH` into `availW × availH` (both CSS px).
 * The photo and its SVG overlay share this ONE measured box — white side
 * space is fine — so event coordinates keep mapping to the actual rendered
 * photo (never an overlay stretched across letterboxes). Null unless every
 * input is finite and positive. Pure; no DOM.
 */
export function fitPhotoBox(
  photoW: number,
  photoH: number,
  availW: number,
  availH: number,
): ProductSetupFitBox | null {
  for (const value of [photoW, photoH, availW, availH]) {
    if (!Number.isFinite(value) || !(value > 0)) return null;
  }
  const scale = Math.min(availW / photoW, availH / photoH);
  if (!Number.isFinite(scale) || !(scale > 0)) return null;
  return { width: photoW * scale, height: photoH * scale };
}

/** Safe-area drawing mode inside the Safe area tool. */
export type ProductSetupSafeDrawMode = 'freehand' | 'rectangle';

/**
 * Grouped millimetre label for a reference length (`1,300 mm`; decimals
 * keep their fraction). Null unless the length is a positive finite number —
 * callers show `Enter distance` instead. Pure; no DOM.
 */
export function formatReferenceLengthMm(lengthMm: number): string | null {
  if (!Number.isFinite(lengthMm) || !(lengthMm > 0)) return null;
  const rounded = Math.round(lengthMm * 100) / 100;
  const [int, frac] = String(rounded).split('.');
  const grouped = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${frac !== undefined ? `.${frac}` : ''} mm`;
}

/**
 * Midpoint label for a reference span: the grouped length once a positive
 * finite length is known, else `Enter distance` — never an invented length.
 * Pure; no DOM.
 */
export function referenceSpanLabel(lengthMm: number): string {
  return formatReferenceLengthMm(lengthMm) ?? 'Enter distance';
}

/**
 * Saved two-click reference span evidence for ONE calibrated Images view:
 * native photo UV endpoints A/B (zoom/viewport invariant, never CSS pixels)
 * plus the declared real length in millimetres, bound to the exact
 * calibration that derived the view's mapping. The lead fills this from the
 * span sidecar (`presentation/setup-calibration/*` native pixel endpoints ÷
 * photo size = UV, plus lengthMm + calibrationId/version) at integration.
 */
export interface ProductSetupReferenceSpan {
  aUv: { u: number; v: number };
  bUv: { u: number; v: number };
  lengthMm: number;
  calibrationId: string;
  calibrationVersion: string;
}

/** Usable saved-span overlay in photo pixels (native UV × photo size). */
export interface ProductSetupReferenceOverlay {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  lengthMm: number;
}

/**
 * Usable saved-span overlay for one calibrated view, or null when missing
 * or stale (calibration mismatch, out-of-photo UV, coincident endpoints).
 * The view never fabricates A/B from measurement anchors or safe-area
 * bboxes: null draws nothing. Pure; no DOM.
 */
export function usableReferenceSpan(view: ProductSetupPhotoView): ProductSetupReferenceOverlay | null {
  const span = view.referenceSpan;
  if (span === undefined || span === null) return null;
  if (span.calibrationId !== view.scope.calibrationId ||
    span.calibrationVersion !== view.scope.calibrationVersion) return null;
  for (const end of [span.aUv, span.bUv]) {
    if (!end || !Number.isFinite(end.u) || !Number.isFinite(end.v)) return null;
    if (end.u < 0 || end.u > 1 || end.v < 0 || end.v > 1) return null;
  }
  const ax = span.aUv.u * view.photo.widthPx;
  const ay = span.aUv.v * view.photo.heightPx;
  const bx = span.bUv.u * view.photo.widthPx;
  const by = span.bUv.v * view.photo.heightPx;
  if (Math.hypot(bx - ax, by - ay) <= 1e-9) return null;
  return { ax, ay, bx, by, lengthMm: span.lengthMm };
}

function rdpKeep(
  points: ReadonlyArray<AnchorSetupMm>,
  first: number,
  last: number,
  eps: number,
  keep: boolean[],
): void {
  let maxDist = 0;
  let split = -1;
  const ax = points[first]!.x;
  const ay = points[first]!.y;
  const bx = points[last]!.x;
  const by = points[last]!.y;
  const base = Math.hypot(bx - ax, by - ay);
  for (let i = first + 1; i < last; i += 1) {
    const px = points[i]!.x;
    const py = points[i]!.y;
    const dist = base <= 1e-12
      ? Math.hypot(px - ax, py - ay)
      : Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / base;
    if (dist > maxDist) {
      maxDist = dist;
      split = i;
    }
  }
  if (split !== -1 && maxDist > eps) {
    keep[split] = true;
    rdpKeep(points, first, split, eps, keep);
    rdpKeep(points, split, last, eps, keep);
  }
}

/**
 * Simplify a sampled freehand trace (Ramer–Douglas–Peucker) within the
 * existing polygon-point bound (`SETUP_LIMITS.maxVerticesPerArea`, 512):
 * drops non-finite and consecutive-coincident samples, then tightens the
 * tolerance until the ring fits the bound. The result still needs
 * {@link validateSafeAreaPolygon} — simplification never invents validity.
 * Pure; no DOM.
 */
export function simplifyFreehandTrace(
  points: ReadonlyArray<AnchorSetupMm>,
  maxPoints: number = SETUP_LIMITS.maxVerticesPerArea,
): AnchorSetupMm[] {
  const cleaned: AnchorSetupMm[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const prev = cleaned[cleaned.length - 1];
    if (prev && Math.hypot(point.x - prev.x, point.y - prev.y) <= 1e-9) continue;
    cleaned.push({ x: point.x, y: point.y });
  }
  if (cleaned.length > 2) {
    const first = cleaned[0]!;
    const last = cleaned[cleaned.length - 1]!;
    if (Math.hypot(last.x - first.x, last.y - first.y) <= 1e-9) cleaned.pop();
  }
  if (cleaned.length <= 2 || cleaned.length <= maxPoints) return cleaned;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of cleaned) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  let eps = Math.max(diagonal * 0.0025, 1e-9);
  for (let guard = 0; guard < 32; guard += 1) {
    const keep = cleaned.map(() => false);
    keep[0] = true;
    keep[keep.length - 1] = true;
    rdpKeep(cleaned, 0, cleaned.length - 1, eps, keep);
    const simplified = cleaned.filter((_, index) => keep[index]);
    if (simplified.length <= maxPoints) return simplified;
    eps *= 2;
  }
  return [cleaned[0]!, cleaned[cleaned.length - 1]!];
}

/**
 * True when four finite cyclic millimetre points form a rectangle within the
 * documented tolerance: non-zero area, every interior angle within
 * `angleToleranceDeg` (default 0.5°) of 90°, and opposite sides matching
 * within `sideToleranceRatio` (default 0.5%, floor 1e-6 mm). Either winding
 * is accepted; general quadrilaterals fail. Reopened rectangular geometry
 * passing this check regains side handles; anything else keeps the general
 * vertex/insert handles. Pure; no DOM.
 */
/**
 * Recognize a stored 4-corner ring as a rectangle for side-handle editing.
 * Tolerance is numeric roundoff ONLY (genuinely constructed rectangles share
 * exact coordinate values, so angles are exactly 90° and opposite sides
 * exactly equal up to float error): hand-tapped or traced quads — however
 * close — are general polygons and keep vertex handles, so corner edits
 * never silently snap their other vertices. Callers may pass wider
 * tolerances explicitly for display/classification purposes, but side-handle
 * recognition must stay at roundoff.
 */
export function isRectanglePoints(
  points: ReadonlyArray<AnchorSetupMm>,
  angleToleranceDeg = 1e-6,
  sideToleranceRatio = 1e-9,
): boolean {
  if (points.length !== 4) return false;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  }
  if (Math.abs(polygonSignedAreaMm(points)) <= 1e-9) return false;
  const angleTol = (angleToleranceDeg * Math.PI) / 180;
  const edges: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const current = points[i]!;
    const next = points[(i + 1) % 4]!;
    const len = Math.hypot(next.x - current.x, next.y - current.y);
    if (!(len > 1e-9)) return false;
    edges.push(len);
  }
  for (let i = 0; i < 4; i += 1) {
    const prev = points[(i + 3) % 4]!;
    const current = points[i]!;
    const next = points[(i + 1) % 4]!;
    const v1x = prev.x - current.x;
    const v1y = prev.y - current.y;
    const v2x = next.x - current.x;
    const v2y = next.y - current.y;
    const cross = v1x * v2y - v1y * v2x;
    const dot = v1x * v2x + v1y * v2y;
    const angle = Math.atan2(Math.abs(cross), dot);
    if (Math.abs(angle - Math.PI / 2) > angleTol + 1e-12) return false;
  }
  const sideOk = (a: number, b: number): boolean =>
    Math.abs(a - b) <= Math.max(sideToleranceRatio * Math.max(a, b), 1e-6);
  return sideOk(edges[0]!, edges[2]!) && sideOk(edges[1]!, edges[3]!);
}

/** The stored sourceRev for one identity key, or `null` when unparseable
 *  (unparseable keys are kept, never silently discarded). Pure. */
function sourceRevOfIdentityKey(key: string): string | null {
  return parseDraftIdentityKey(key)?.sourceRev ?? null;
}

/** Coordinate-table rows for the Advanced disclosure (never the normal panel). Pure. */
export function safeAreaCoordinateRows(safeArea: ReadonlyArray<AnchorSetupMm>): string[] {
  return safeArea.map((point, index) =>
    `Corner ${index + 1}: ${displayMm1(point.x)}, ${displayMm1(point.y)} mm`);
}

/** Coordinate-table rows for the Advanced disclosure (never the normal panel). Pure. */
export function anchorCoordinateRows(anchors: readonly AnchorDef[]): string[] {
  return anchors.map((anchor) =>
    `${anchor.name}: ${displayMm1(anchor.posMm[0]!)}, ${displayMm1(anchor.posMm[1]!)} mm`);
}

let anchorCounter = 0;

function newAnchorId(): string {
  anchorCounter += 1;
  let suffix = `${anchorCounter}`;
  try {
    const bytes = new Uint8Array(2);
    globalThis.crypto?.getRandomValues?.(bytes);
    suffix = `${anchorCounter}-${bytes[0]!.toString(16).padStart(2, '0')}${bytes[1]!.toString(16).padStart(2, '0')}`;
  } catch {
    suffix = `${anchorCounter}-${Math.floor(Math.random() * 65536).toString(16)}`;
  }
  return `psetup-anchor-${suffix}`;
}

/** Header-sniff the raster media type for a data-URL render (no guessing). */
function guessMediaType(bytes: Uint8Array): string {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return '';
}

type MappingEntry = Parameters<typeof inversePhotoMapping>[0];

/** Caller-evaluated mapping entry for one view. Pure; shared with tests. */
export function workspaceMappingEntry(
  scope: ProductSetupScope,
  side: ProductSetupSide,
  transform: PhotoMappingTransform,
  status: 'provisional' | 'review',
): MappingEntry {
  return {
    productId: scope.productId,
    variantId: scope.variantId,
    regionId: scope.regionId,
    view: side,
    image: '',
    transform: { ...transform },
    calibrationId: scope.calibrationId,
    calibrationVersion: scope.calibrationVersion,
    status,
  };
}

/** Inverse-map a photo pixel into the view's region-frame mm. Pure. */
export function workspacePhotoToMm(
  view: ProductSetupPhotoView,
  side: ProductSetupSide,
  px: number,
  py: number,
): AnchorSetupMm | null {
  if (!view.transform) return null;
  const uv = { u: px / view.photo.widthPx, v: py / view.photo.heightPx };
  const mm = inversePhotoMapping(
    workspaceMappingEntry(view.scope, side, view.transform, view.mappingStatus),
    uv,
  );
  if (!mm || !Number.isFinite(mm.xMm) || !Number.isFinite(mm.yMm)) return null;
  return { x: mm.xMm, y: mm.yMm };
}

/** Forward-map region-frame mm onto the view's photo pixels. Pure. */
export function workspaceMmToPhoto(
  view: ProductSetupPhotoView,
  side: ProductSetupSide,
  mm: AnchorSetupMm,
): { x: number; y: number } | null {
  if (!view.transform) return null;
  const uv = forwardPhotoMapping(
    workspaceMappingEntry(view.scope, side, view.transform, view.mappingStatus),
    { xMm: mm.x, yMm: mm.y },
  );
  if (!uv) return null;
  return { x: uv.u * view.photo.widthPx, y: uv.v * view.photo.heightPx };
}

/**
 * Render the visual product-setup workspace into `container`, replacing its
 * contents. The lead provides the mount point (`data-builder-hook=
 * "product-workspace"`) and all `product-setup-*` CSS; this module builds
 * every node programmatically and never touches the template.
 */
export function createProductSetupView(
  container: HTMLElement,
  getWorkspaceInput: () => ProductSetupWorkspaceInput | ProductSetupWorkspaceInputV2 | { error: string },
  callbacks: ProductSetupCallbacks,
): ProductSetupViewHandle {
  let destroyed = false;
  let tool: ProductSetupTool | null = null;
  let selectedViewId: string | null = null;
  let tabProjectKey: string | null = null;
  const store = createWorkspaceEditStore();
  const saver = new ProductSetupSaver();
  /**
   * Views with an in-progress redraw: the staged polygon stays intact while
   * the operator draws its replacement; only a valid finish swaps it in.
   * Cancel/Escape/invalid finish keep the previous polygon. Pruned with the
   * edit store on every refresh.
   */
  const redrawKeys = new Set<string>();
  /**
   * Pending drawing mode per view key: `new` stages a FRESH named area on
   * finish (the staged polygon stays intact until then), `replace` overwrites
   * the selected entry's polygon. Pruned everywhere `redrawKeys` is pruned.
   */
  const drawModes = new Map<string, { kind: 'new' } | { kind: 'replace'; targetId: string }>();
  /**
   * Every identity key ever staged in this session. Pruned ONLY on real
   * source-session replacement (sourceRev mismatch) or explicit caller
   * retirement events — never for merely being absent while the operator
   * views another product/variant/side, so switching back restores the
   * correct scoped draft via the existing bucketFor identity.
   */
  const knownKeys = new Set<string>();
  let selectedAnchorId: string | null = null;
  let selectedCorner: number | null = null;
  /** Active tab's edit-bucket key, for container-level drawing cancellation. */
  let activeKey: string | null = null;
  /** Latest render's status painter (container Escape has no render closure). */
  let paintRef: ((message: string) => void) | null = null;
  /**
   * Zoom percentage per staged view key (100 = fitted product view).
   * Display-only: never applied to mm, geometry or saved areas. Pruned with
   * the edit store on source replacement/retirement.
   */
  const zoomByKey = new Map<string, number>();
  /**
   * Safe-area drawing mode per staged view key. Freehand keeps
   * press-drag-trace plus click-corners and Finish; rectangle is
   * press-drag-release only. Pruned with the edit store.
   */
  const safeModeByKey = new Map<string, ProductSetupSafeDrawMode>();
  /**
   * Last status message, owned OUTSIDE refresh(). Every render rebuilds the
   * status node, so actions must paint-then-refresh without losing the
   * acknowledgement: each new statusBox initialises from lastStatus,
   * including async save settlements.
   */
  let lastStatus = '';  let selectionContext: string | null = null;
  let dragAnchor: string | null = null;
  let dragVertex: number | null = null;
  let pendingAnchorMm: AnchorSetupMm | null = null;
  let pendingVertexBase: AnchorSetupMm[] | null = null;
  let pendingVertexHandle: SVGCircleElement | null = null;
  /**
   * Resize observer for constant-CSS-pixel stage markers (Tranche C scale
   * fix, same strategy as the operation pick markers): dots, hit targets
   * and focus rings keep rendered sizes on high-res photos and narrow
   * stages. Re-attached to each render's overlay; torn down on refresh and
   * destroy so no observer outlives its SVG. Positions are never touched —
   * geometry stays canonical.
   */
  let stageResize: ResizeObserver | null = null;
  /**
   * Fit observer + window-resize listener for the bounded contain-fit stage
   * (recomputes the shared photo/overlay box on viewport/container change).
   * Torn down with the marker observer on every refresh and on destroy.
   */
  let fitResize: ResizeObserver | null = null;
  let fitWindowCleanup: (() => void) | null = null;

  function disconnectStageResize(): void {
    try {
      stageResize?.disconnect();
    } catch {
      /* best-effort teardown */
    }
    stageResize = null;
    try {
      fitResize?.disconnect();
    } catch {
      /* best-effort teardown */
    }
    fitResize = null;
    try {
      fitWindowCleanup?.();
    } catch {
      /* best-effort teardown */
    }
    fitWindowCleanup = null;
  }

  /** CSS pixels per overlay viewBox unit (meet letterboxing), or null. */
  function stageCssScale(svg: SVGSVGElement): number | null {
    const rect = svg.getBoundingClientRect();
    const box = svg.viewBox.baseVal;
    if (!(rect.width > 0) || !(rect.height > 0) || !(box.width > 0) || !(box.height > 0)) return null;
    const scale = Math.min(rect.width / box.width, rect.height / box.height);
    return scale > 0 && Number.isFinite(scale) ? scale : null;
  }

  /** Apply constant rendered sizes to marked stage targets. */
  function layoutStageMarkers(svg: SVGSVGElement): void {
    const scale = stageCssScale(svg);
    if (scale === null) return;
    const units = (cssPx: number): string => String(cssPx / scale);
    svg.querySelectorAll('[data-markr]').forEach((node) => {
      const want = Number((node as Element).getAttribute('data-markr'));
      if (Number.isFinite(want)) node.setAttribute('r', units(want));
    });
    svg.querySelectorAll('[data-marksquare]').forEach((node) => {
      const side = Number(node.getAttribute('data-marksquare'));
      const cx = Number(node.getAttribute('cx')), cy = Number(node.getAttribute('cy'));
      if (![side, cx, cy].every(Number.isFinite)) return;
      node.setAttribute('x', String(cx - side / scale / 2));
      node.setAttribute('y', String(cy - side / scale / 2));
      node.setAttribute('width', units(side));
      node.setAttribute('height', units(side));
    });
    svg.querySelectorAll('[data-markhit]').forEach((node) => {
      const want = Number((node as Element).getAttribute('data-markhit'));
      if (Number.isFinite(want)) node.setAttribute('r', units(want));
    });
    svg.querySelectorAll('[data-markfont]').forEach((node) => {
      const el = node as Element;
      const want = Number(el.getAttribute('data-markfont'));
      if (Number.isFinite(want)) node.setAttribute('font-size', String(want / scale));
      // Label offsets stay a constant rendered distance from the marker so
      // text never slides under its dot on small-scale renders. The midpoint
      // reference label floats above its line via data-markdy.
      const cx = Number(el.getAttribute('data-markcx'));
      const cy = Number(el.getAttribute('data-markcy'));
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        const dyRaw = Number(el.getAttribute('data-markdy'));
        const dy = Number.isFinite(dyRaw) ? dyRaw : 4;
        node.setAttribute('x', String(cx + 12 / scale));
        node.setAttribute('y', String(cy + dy / scale));
      }
    });
    svg.querySelectorAll('[data-markstroke]').forEach((node) => {
      const want = Number((node as Element).getAttribute('data-markstroke'));
      if (Number.isFinite(want)) node.setAttribute('stroke-width', String(want / scale));
    });
    // Dotted reference spans keep a constant CSS-pixel dash pattern under
    // zoom/resize: each dash component counter-scales like stroke widths.
    svg.querySelectorAll('[data-markdash]').forEach((node) => {
      const raw = (node as Element).getAttribute('data-markdash') ?? '';
      const parts = raw.trim().split(/[\s,]+/).map(Number)
        .filter((n) => Number.isFinite(n) && n >= 0);
      if (parts.length > 0) node.setAttribute('stroke-dasharray', parts.map((n) => String(n / scale)).join(' '));
    });
  }

  function observeStageMarkers(svg: SVGSVGElement): void {
    layoutStageMarkers(svg);
    if (typeof ResizeObserver === 'function') {
      stageResize = new ResizeObserver(() => {
        if (svg.isConnected) layoutStageMarkers(svg);
        else disconnectStageResize();
      });
      stageResize.observe(svg);
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (!destroyed && svg.isConnected) layoutStageMarkers(svg);
      });
    }
  }

  /**
   * Observe the stage for fit recomputation (container/viewport change):
   * applies once now, on stage resize, on window resize and on the next
   * frame (first layout). Display-only; picking inverts the actual view
   * transform and mm never scale. Disposed via disconnectStageResize.
   */
  function observeStageFit(stage: HTMLElement, apply: () => void): void {
    apply();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onResize = (): void => {
        apply();
      };
      window.addEventListener('resize', onResize);
      fitWindowCleanup = (): void => {
        window.removeEventListener('resize', onResize);
      };
    }
    if (typeof ResizeObserver === 'function') {
      fitResize = new ResizeObserver(() => {
        apply();
      });
      fitResize.observe(stage);
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (!destroyed) apply();
      });
    }
  }

  const cancelOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || destroyed) return;
    const target = event.target;
    const editable = target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    if (editable) return;
    if (dragAnchor !== null || dragVertex !== null) {
      dragAnchor = null;
      dragVertex = null;
      pendingAnchorMm = null;
      pendingVertexBase = null;
      pendingVertexHandle = null;
      refresh();
    }
  };
  document.addEventListener('keydown', cancelOnEscape);

  /**
   * Workspace-level drawing cancellation: Escape aborts an in-progress
   * drawing even when focus never reached the photo (e.g. right after
   * pressing Draw new, or while a panel button has focus). Text inputs,
   * selects and editable text are never hijacked. The staged polygon is
   * untouched — cancellation only drops the uncommitted draft.
   */
  const cancelDrawingOnEscape = (event: KeyboardEvent): void => {
    if (destroyed || event.key !== 'Escape') return;
    const target = event.target;
    const editable = target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (editable) return;
    const current = activeKey;
    if (current === null || store.draftFor(current) === undefined) return;
    store.dropDraft(current);
    redrawKeys.delete(current);
    drawModes.delete(current);
    selectedCorner = null;
    if (paintRef !== null) paintRef('Drawing cancelled; nothing was committed.');
    refresh();
  };
  container.addEventListener('keydown', cancelDrawingOnEscape);

  function setStatusElement(box: HTMLElement, message: string): void {
    box.textContent = message;
  }

  function refresh(): void {
    if (destroyed) return;
    disconnectStageResize();
    // Preserve the magnified stage's scroll position across re-renders so
    // zoom + pan survive selections and commits.
    const prevStage = container.querySelector('.product-setup-stage');
    const prevScroll = prevStage !== null
      ? { left: prevStage.scrollLeft, top: prevStage.scrollTop }
      : null;
    const active = document.activeElement;
    const focusKey = active instanceof Element ? active.getAttribute('data-fkey') : null;
    dragAnchor = null;
    dragVertex = null;
    pendingAnchorMm = null;
    pendingVertexBase = null;
    pendingVertexHandle = null;
    container.replaceChildren();
    const resolved = getWorkspaceInput();
    const root = document.createElement('div');
    root.className = 'product-setup';
    container.append(root);

    const statusBox = document.createElement('p');
    statusBox.className = 'product-setup-status muted';
    statusBox.setAttribute('role', 'status');
    setStatusElement(statusBox, lastStatus);
    const paintStatus = (message: string): void => {
      lastStatus = message;
      setStatusElement(statusBox, message);
      callbacks.onStatus(message);
    };
    paintRef = paintStatus;

    if (!('views' in resolved)) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = resolved.error;
      root.append(note, statusBox);
      return;
    }
    const input = resolved;
    const listed = listWorkspaceViews(input);
    const isNamedInput = Array.isArray((input as ProductSetupWorkspaceInputV2).views);
    if (listed.length === 0) {
      const note = document.createElement('p');
      note.className = 'muted';
      // Model-only products (named input, no view images) never request
      // photos: a neutral note, never a photo-missing error.
      note.textContent = isNamedInput
        ? 'No view images are staged for this product, so there is nothing to calibrate here.'
        : 'No product views are available yet.';
      root.append(note, statusBox);
      return;
    }
    // Identity set for every present view: seeds the session-known staged
    // edits below. Same-sourceRev keys are NEVER pruned for merely being
    // absent from the current input — switching product/variant/view
    // restores via the existing bucketFor identity. Only real
    // source-session replacement and explicit retirement events drop work.
    // Identity is the stable view id (never label text): renames keep buckets.
    const identityById = new Map<string, string>();
    const errorMarks: string[] = [];
    for (const entry of listed) {
      if (isProductSetupPhotoView(entry.state)) {
        identityById.set(entry.id, viewIdentityKey(entry.state));
      } else {
        errorMarks.push(`error:${entry.id}:${entry.state.error}`);
      }
    }
    const identityKeys = new Set(identityById.values());
    for (const known of identityKeys) knownKeys.add(known);
    // First present view's sourceRev (skipped when no usable view is present).
    let currentRev: string | null = null;
    for (const entry of listed) {
      if (isProductSetupPhotoView(entry.state)) {
        currentRev = entry.state.sourceRev;
        break;
      }
    }
    if (currentRev !== null) {
      for (const known of [...knownKeys]) {
        const rev = sourceRevOfIdentityKey(known);
        if (rev !== null && rev !== currentRev) {
          knownKeys.delete(known);
          store.dropBucket(known);
          store.dropDraft(known);
          redrawKeys.delete(known);
          drawModes.delete(known);
          zoomByKey.delete(known);
          safeModeByKey.delete(known);
        }
      }
    }
    const retirements = input.retirements ?? [];
    if (retirements.length > 0) {
      const { retired } = applyRetirementEvents([...knownKeys], retirements);
      for (const key of retired) {
        knownKeys.delete(key);
        store.dropBucket(key);
        store.dropDraft(key);
        redrawKeys.delete(key);
        drawModes.delete(key);
        zoomByKey.delete(key);
        safeModeByKey.delete(key);
      }
    }
    const projectKey = JSON.stringify([...identityKeys].sort().concat(errorMarks.sort()));
    if (tabProjectKey !== projectKey) {
      tabProjectKey = projectKey;
      selectedViewId = null;
      tool = null;
      selectedAnchorId = null;
      selectedCorner = null;
      selectionContext = null;
    }
    const viewId = resolveInitialView(input, selectedViewId);
    if (viewId === null) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = 'No product views are available yet.';
      root.append(note, statusBox);
      return;
    }
    selectedViewId = viewId;
    const selected = selectWorkspaceViewById(input, viewId);
    if (!isProductSetupPhotoView(selected)) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = selected.error;
      root.append(note, statusBox);
      return;
    }
    const view = selected;
    // THE active tab scope: every render/save/anchor below uses view.scope.
    const tabScope = view.scope;
    // Legacy mapping-math bucket for the affine photo plumbing (stable side
    // string); view identity rides the scope's stable view id, never this.
    const side: ProductSetupSide = view.scope.side;
    const key = viewIdentityKey(view);
    activeKey = key;
    const bucket = store.bucketFor(key, () => {
      const seeded = seedNamedAreas(
        view.safeArea,
        view.scope.regionName,
        view.savedAreas !== undefined
          ? { areas: view.savedAreas, activeAreaId: view.savedActiveAreaId ?? null }
          : undefined,
      );
      return {
        safeArea: view.safeArea.map((point) => ({ ...point })),
        anchors: view.anchors.map((anchor) => ({
          ...anchor,
          posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number],
        })),
        dirty: false,
        baseSafeArea: view.safeArea.map((point) => ({ ...point })),
        conflicted: false,
        namedAreas: seeded.namedAreas,
        activeAreaId: seeded.activeAreaId,
        baseNamedAreas: seeded.namedAreas.map((area) => ({
          ...area,
          points: area.points.map((point) => ({ ...point })),
        })),
        showAnchors: true,
        showAreas: true,
        showProduct: true,
      };
    });
    // Baseline-aware shared geometry (Tranche C data-loss guard): the saved
    // region may have moved under another scope since this bucket staged.
    // Unedited buckets adopt live (keeping staged per-scope anchors);
    // edited buckets with moved live are a conflict, surfaced at the save
    // bar and enforced at commit — never silently overwritten or discarded.
    // NOTE: adoption covers the scope polygon and anchors only; the staged
    // named-area list is never merged with live siblings (that would silently
    // resurrect deleted areas or drop new ones). Sibling divergence is
    // refused at save time instead (stale-list guard).
    if (!sameSafeArea(bucket.safeArea, bucket.baseSafeArea)) {
      bucket.conflicted = !sameSafeArea(view.safeArea, bucket.baseSafeArea);
    } else if (!sameSafeArea(view.safeArea, bucket.baseSafeArea)) {
      bucket.safeArea = cloneSafeArea(view.safeArea);
      bucket.baseSafeArea = cloneSafeArea(view.safeArea);
      bucket.conflicted = false;
      if (bucket.anchors.length > 0 || bucket.dirty) {
        paintStatus(
          `Shared area updated from “${view.scope.regionName ?? view.scope.regionId}” — staged anchors kept. ` +
          'Review before saving.',
        );
      }
    } else {
      bucket.conflicted = false;
    }
    const activeTool: ProductSetupTool = tool ??
      (bucket.safeArea.length === 0 ? 'safe-area' : 'anchor');
    tool = activeTool;
    const context = `${key} ${activeTool}`;
    if (selectionContext !== context) {
      selectionContext = context;
      selectedAnchorId = null;
      selectedCorner = null;
    }

    renderTabs(root, listed, viewId, (next) => {
      selectedViewId = next;
      const upcoming = selectWorkspaceViewById(input, next);
      paintStatus(isProductSetupPhotoView(upcoming)
        ? `Viewing ${shortScopeLabel(upcoming.scope)}; staged edits are kept per view.`
        : upcoming.error);
      refresh();
    });
    renderToolbar(root, key, activeTool, safeModeByKey.get(key) ?? 'freehand', zoomByKey.get(key) ?? 100, bucket, paintStatus, (next) => {
      tool = next;
      paintStatus(next === 'safe-area'
        ? 'Safe-area tool: click the photo to draw, drag corners to edit. Anchor clicks do nothing here.'
        : 'Anchor tool: click the photo to place a named anchor. Safe-area clicks do nothing here.');
      refresh();
    }, (mode) => {
      safeModeByKey.set(key, mode);
      if (tool !== 'safe-area') tool = 'safe-area';
      paintStatus(mode === 'freehand'
        ? 'Freehand: press, drag to trace and release to close one area — or click corners and Finish. A tap is not a stroke.'
        : 'Rectangle: press at one corner, drag to the opposite corner, release to commit one four-corner area.');
      refresh();
    }, (pct) => {
      // Purely display: no status churn, no mm impact; the readout is the
      // select value itself, so it stays consistent by construction.
      zoomByKey.set(key, clampZoomPercentage(pct));
      refresh();
    });

    if (!view.transform) {
      const pending = document.createElement('div');
      pending.className = 'product-setup-panel';
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent =
        `${shortScopeLabel(tabScope)} has no scale mapping yet, so millimetres ` +
        `cannot be measured here. Set up the scale first — nothing is guessed from pixels.`;
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn-secondary';
      go.textContent = 'Set up scale';
      go.setAttribute('data-fkey', `psv-scale-${key}`);
      go.addEventListener('click', () => {
        callbacks.onScaleNeeded(tabScope);
      });
      pending.append(note, go);
      root.append(pending, statusBox);
      restoreFocus(focusKey);
      return;
    }

    renderStage(root, view, side, key, bucket, activeTool, safeModeByKey.get(key) ?? 'freehand', zoomByKey.get(key) ?? 100, paintStatus);
    if (activeTool === 'safe-area') {
      renderSafePanel(root, view, side, key, bucket, paintStatus);
    } else {
      renderAnchorPanel(root, view, key, bucket, paintStatus);
    }
    renderSaveBar(root, tabScope, key, bucket, paintStatus, input.sharedNotice);
    root.append(statusBox);
    const stageSvg = root.querySelector<SVGSVGElement>('svg.product-setup-overlay');
    if (stageSvg) observeStageMarkers(stageSvg);
    if (prevScroll !== null) {
      const nextStage = root.querySelector('.product-setup-stage');
      if (nextStage !== null) {
        nextStage.scrollLeft = prevScroll.left;
        nextStage.scrollTop = prevScroll.top;
      }
    }
    restoreFocus(focusKey);
  }

  function restoreFocus(focusKey: string | null): void {
    if (!focusKey) return;
    const next = container.querySelector(`[data-fkey="${focusKey.replace(/"/g, '')}"]`);
    if (next instanceof HTMLElement || next instanceof SVGElement) {
      (next as HTMLElement).focus();
    }
  }

  function renderTabs(
    root: HTMLElement,
    listed: readonly ProductSetupListedView[],
    selected: string,
    onSelect: (id: string) => void,
  ): void {
    const tabs = document.createElement('div');
    tabs.className = 'product-setup-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Product views');
    for (const entry of listed) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = entry.id === selected ? 'product-setup-tab is-active' : 'product-setup-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', entry.id === selected ? 'true' : 'false');
      // Stable identity key (the view id, never label text): renames keep
      // every `psv-tab-*` hook stable, and legacy sides keep their old hooks.
      tab.setAttribute('data-fkey', `psv-tab-${entry.id}`);
      tab.textContent = entry.label;
      tab.addEventListener('click', () => onSelect(entry.id));
      tabs.append(tab);
    }
    root.append(tabs);
  }

  function renderToolbar(
    root: HTMLElement,
    key: string,
    activeTool: ProductSetupTool,
    safeMode: ProductSetupSafeDrawMode,
    zoomPct: number,
    bucket: StoredEdits,
    paintStatus: (message: string) => void,
    onSelect: (next: ProductSetupTool) => void,
    onMode: (mode: ProductSetupSafeDrawMode) => void,
    onZoom: (pct: number) => void,
  ): void {
    const bar = document.createElement('div');
    bar.className = 'product-setup-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Product setup tools');
    const safeButton = document.createElement('button');
    safeButton.type = 'button';
    safeButton.className = activeTool === 'safe-area' ? 'product-setup-tool is-active' : 'product-setup-tool';
    safeButton.setAttribute('aria-pressed', activeTool === 'safe-area' ? 'true' : 'false');
    safeButton.setAttribute('data-fkey', 'psv-tool-safe-area');
    safeButton.textContent = `Safe area${bucket.safeArea.length > 0 ? ` (${bucket.safeArea.length})` : ''}`;
    safeButton.addEventListener('click', () => {
      if (activeTool !== 'safe-area') onSelect('safe-area');
    });
    const anchorButton = document.createElement('button');
    anchorButton.type = 'button';
    anchorButton.className = activeTool === 'anchor' ? 'product-setup-tool is-active' : 'product-setup-tool';
    anchorButton.setAttribute('aria-pressed', activeTool === 'anchor' ? 'true' : 'false');
    anchorButton.setAttribute('data-fkey', 'psv-tool-anchor');
    anchorButton.textContent = `Anchor${bucket.anchors.length > 0 ? ` (${bucket.anchors.length})` : ''}`;
    anchorButton.addEventListener('click', () => {
      if (activeTool !== 'anchor') onSelect('anchor');
    });
    bar.append(safeButton, anchorButton);
    if (activeTool === 'safe-area') {
      const modes: Array<{ mode: ProductSetupSafeDrawMode; label: string; hint: string }> = [
        { mode: 'freehand', label: 'Freehand', hint: 'Freehand: press, drag to trace and release to close one area — or click corners and Finish. A tap is not a stroke.' },
        { mode: 'rectangle', label: 'Rectangle', hint: 'Rectangle: press at one corner, drag to the opposite corner, release to commit one four-corner area.' },
      ];
      for (const entry of modes) {
        const modeButton = document.createElement('button');
        modeButton.type = 'button';
        modeButton.className = safeMode === entry.mode ? 'product-setup-tool is-active' : 'product-setup-tool';
        modeButton.setAttribute('aria-pressed', safeMode === entry.mode ? 'true' : 'false');
        modeButton.setAttribute('data-ps-tool', entry.mode);
        modeButton.setAttribute('data-fkey', `psv-tool-${entry.mode}`);
        modeButton.textContent = entry.label;
        modeButton.addEventListener('click', () => {
          if (safeModeByKey.get(key) !== entry.mode) onMode(entry.mode);
        });
        bar.append(modeButton);
      }
    }
    root.append(bar);
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = activeTool === 'safe-area'
      ? (safeMode === 'freehand'
        ? 'Safe-area tool · Freehand: drag to trace a closed area, or click corners and Finish; a tap is not a stroke. Photo clicks never place anchors here; Enter finishes a drawing, Escape cancels.'
        : 'Safe-area tool · Rectangle: press at one corner and drag to the opposite corner; release commits one area. Photo clicks never place anchors here; Escape cancels a drag.')
      : 'Anchor tool: click the product to place a named anchor; drag, rename or delete it. Photo clicks never touch the safe area here.';
    root.append(hint);
    // View controls: zoom steps plus display-only visibility toggles. The
    // lead mounts this bar directly above the stage; the exact
    // `data-ps-view` / `data-ps-tool` selectors above are the contract.
    // Hiding a layer only skips its stage rendering — staged geometry,
    // endpoints, names and dirty drafts are never deleted by a toggle.
    const viewbar = document.createElement('div');
    viewbar.className = 'product-setup-viewbar';
    viewbar.setAttribute('data-ps-viewbar', '');
    viewbar.setAttribute('role', 'toolbar');
    viewbar.setAttribute('aria-label', 'Stage view controls');
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'product-setup-viewbtn';
    zoomOut.textContent = '−';
    zoomOut.setAttribute('aria-label', 'Zoom out');
    zoomOut.setAttribute('data-ps-view', 'zoom-out');
    zoomOut.disabled = zoomPct <= PRODUCT_SETUP_ZOOM_STEPS[0]!;
    zoomOut.addEventListener('click', () => onZoom(stepZoomPercentage(zoomPct, -1)));
    const zoomSelect = document.createElement('select');
    zoomSelect.className = 'product-setup-viewzoom';
    zoomSelect.setAttribute('aria-label', 'Zoom percentage (100% is the fitted product view)');
    zoomSelect.setAttribute('data-ps-view', 'zoom');
    zoomSelect.setAttribute('data-fkey', `psv-zoom-${key}`);
    for (const step of PRODUCT_SETUP_ZOOM_STEPS) {
      const option = document.createElement('option');
      option.value = String(step);
      option.textContent = `${step}%`;
      zoomSelect.append(option);
    }
    zoomSelect.value = String(clampZoomPercentage(zoomPct));
    zoomSelect.addEventListener('change', () => {
      onZoom(Number(zoomSelect.value));
    });
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'product-setup-viewbtn';
    zoomIn.textContent = '+';
    zoomIn.setAttribute('aria-label', 'Zoom in');
    zoomIn.setAttribute('data-ps-view', 'zoom-in');
    zoomIn.disabled = zoomPct >= PRODUCT_SETUP_ZOOM_STEPS[PRODUCT_SETUP_ZOOM_STEPS.length - 1]!;
    zoomIn.addEventListener('click', () => onZoom(stepZoomPercentage(zoomPct, 1)));
    const zoomFit = document.createElement('button');
    zoomFit.type = 'button';
    zoomFit.className = 'product-setup-viewbtn';
    zoomFit.textContent = 'Fit';
    zoomFit.setAttribute('aria-label', 'Fit the product view (100%)');
    zoomFit.setAttribute('data-ps-view', 'fit');
    zoomFit.addEventListener('click', () => onZoom(100));
    viewbar.append(zoomOut, zoomSelect, zoomIn, zoomFit);
    const visToggle = (
      label: string,
      view: 'vis-anchors' | 'vis-areas' | 'vis-product',
      pressed: boolean,
      onFlip: () => void,
    ): void => {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = pressed ? 'product-setup-viewbtn is-active' : 'product-setup-viewbtn';
      toggle.textContent = label;
      toggle.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      toggle.setAttribute('data-ps-view', view);
      toggle.setAttribute('data-fkey', `psv-vis-${view}-${key}`);
      toggle.addEventListener('click', () => {
        onFlip();
        refresh();
      });
      viewbar.append(toggle);
    };
    visToggle('Anchors', 'vis-anchors', layerVisible(bucket, 'showAnchors'), () => {
      bucket.showAnchors = !bucket.showAnchors;
      paintStatus(bucket.showAnchors
        ? 'Anchors layer shown; nothing was changed.'
        : 'Anchors layer hidden; staged anchors and the reference line are kept, only the display changed.');
    });
    visToggle('Safe areas', 'vis-areas', layerVisible(bucket, 'showAreas'), () => {
      bucket.showAreas = !bucket.showAreas;
      paintStatus(bucket.showAreas
        ? 'Safe-areas layer shown; nothing was changed.'
        : 'Safe-areas layer hidden; staged areas are kept, only the display changed.');
    });
    visToggle('Product', 'vis-product', bucket.showProduct ?? true, () => {
      bucket.showProduct = !(bucket.showProduct ?? true);
      paintStatus(bucket.showProduct
        ? 'Product photo shown; nothing was changed.'
        : 'Product photo hidden; overlays and staged geometry are kept, only the display changed.');
    });
    root.append(viewbar);
  }

  function eventPhotoPoint(svg: SVGSVGElement, event: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const width = viewBox && viewBox.width > 0 ? viewBox.width : rect.width;
    const height = viewBox && viewBox.height > 0 ? viewBox.height : rect.height;
    return {
      x: (event.clientX - rect.left) * (width / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (height / Math.max(1, rect.height)),
    };
  }

  function renderStage(
    root: HTMLElement,
    view: ProductSetupPhotoView,
    side: ProductSetupSide,
    key: string,
    bucket: StoredEdits,
    activeTool: ProductSetupTool,
    drawMode: ProductSetupSafeDrawMode,
    zoomPct: number,
    paintStatus: (message: string) => void,
  ): void {
    const scope = view.scope;
    const figure = document.createElement('figure');
    figure.className = 'product-setup-figure';
    const caption = document.createElement('figcaption');
    caption.className = 'muted';
    caption.textContent = `${shortScopeLabel(scope)} — millimetres come from the evaluated mapping, which stays pending review and is never production approval.`;
    figure.append(caption);

    const stage = document.createElement('div');
    stage.className = 'product-setup-stage';
    // Bounded contain-fit stage: the photo and its SVG overlay share ONE
    // measured fitted box (available stage width AND ~60vh, so a portrait
    // photo never pushes the preview past the viewport), scaled by the zoom
    // percentage with internal stage scrolling when magnified. Display-only:
    // picking uses the inverse of the actual view transform and mm never
    // scales with zoom. No object-fit letterboxing inside the box itself, so
    // event coordinates keep mapping to the actual rendered photo.
    const zoombox = document.createElement('div');
    zoombox.className = 'product-setup-zoombox';
    zoombox.style.position = 'relative';
    stage.style.overflow = 'auto';
    stage.style.maxHeight = '60vh';
    // Fill the fitted box from live stage/viewport sizes (px-exact). The
    // signature guard keeps the stage ResizeObserver from looping: an
    // unchanged box writes no styles, so no further resize fires.
    let lastFit = '';
    const layoutFit = (): void => {
      if (destroyed || !zoombox.isConnected) return;
      const availW = stage.clientWidth;
      const viewportH = typeof window === 'undefined' ? 0 : window.innerHeight;
      const availH = Math.max(
        viewportH > 0 ? viewportH * PRODUCT_SETUP_FIT_VH : PRODUCT_SETUP_FIT_MIN_PX,
        PRODUCT_SETUP_FIT_MIN_PX,
      );
      const fitted = availW > 0
        ? fitPhotoBox(view.photo.widthPx, view.photo.heightPx, availW, availH)
        : null;
      const scale = clampZoomPercentage(zoomPct) / 100;
      if (fitted !== null) {
        const width = fitted.width * scale;
        const height = fitted.height * scale;
        const signature = `${width.toFixed(2)}x${height.toFixed(2)}@${availW}`;
        if (signature === lastFit) return;
        lastFit = signature;
        zoombox.style.width = `${width}px`;
        zoombox.style.height = `${height}px`;
        // White side space at Fit is fine: centre a narrower box in the
        // full-width stage instead of stretching the overlay.
        zoombox.style.margin = width < availW - 0.5 ? '0 auto' : '';
      } else if (lastFit !== 'fluid') {
        // Unmeasurable stage (detached/zero-size): fluid photo width so the
        // content still paints; the next resize pass refits it.
        lastFit = 'fluid';
        zoombox.style.width = zoomPct !== 100 ? `${clampZoomPercentage(zoomPct)}%` : '';
        zoombox.style.height = '';
        zoombox.style.margin = '';
      }
    };
    const image = document.createElement('img');
    image.className = 'product-setup-photo';
    const headerUrl = bytesToDataUrl(view.photo.bytes, guessMediaType(view.photo.bytes));
    if (headerUrl) {
      image.src = headerUrl;
      image.alt = `${view.photo.label} (${shortScopeLabel(scope)} setup reference)`;
      image.draggable = false;
      // Product visibility is display-only: overlays stay painted and staged
      // geometry is untouched.
      if (!(bucket.showProduct ?? true)) image.style.display = 'none';
      zoombox.append(image);
    } else {
      const missing = document.createElement('p');
      missing.className = 'muted';
      missing.textContent = 'View-image bytes are missing or undecodable; setup needs a readable view image.';
      zoombox.append(missing);
      stage.append(zoombox);
      figure.append(stage);
      root.append(figure);
      return;
    }

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg') as SVGSVGElement;
    svg.setAttribute('viewBox', `0 0 ${view.photo.widthPx} ${view.photo.heightPx}`);
    svg.setAttribute('class', 'product-setup-overlay');
    svg.setAttribute('role', 'group');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('data-fkey', `psv-stage-${key}`);
    svg.setAttribute('data-tool', activeTool);
    svg.setAttribute(
      'aria-label',
      `${shortScopeLabel(scope)} overlay (${activeTool === 'safe-area' ? 'safe-area' : 'anchor'} tool active)`,
    );
    // In-progress freehand-trace / rectangle gestures (one per render; a
    // refresh rebuilds the svg, so no gesture survives re-render). Previews
    // paint directly with no commit; pointerup commits ONE staged area,
    // pointercancel/Escape roll back with no commit.
    let trace: {
      startX: number; startY: number; points: AnchorSetupMm[];
      outOfScope: boolean; tracing: boolean; preview: SVGPolygonElement | null;
    } | null = null;
    let rectDrag: {
      start: AnchorSetupMm; startX: number; startY: number;
      lastX: number; lastY: number; end: AnchorSetupMm | null;
      preview: SVGPolygonElement | null;
    } | null = null;
    const discardGesture = (message: string): void => {
      trace = null;
      rectDrag = null;
      paintStatus(message);
      refresh();
    };
    svg.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && activeTool === 'safe-area') {
        const draft = store.draftFor(key);
        if (draft !== undefined) {
          event.preventDefault();
          finishDraft(key, bucket, draft, paintStatus);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (trace !== null || rectDrag !== null) {
          discardGesture('Drawing cancelled; nothing was committed.');
          return;
        }
        if (dragAnchor !== null || dragVertex !== null) return;
        if (store.draftFor(key) !== undefined) {
          store.dropDraft(key);
          redrawKeys.delete(key);
          drawModes.delete(key);
          selectedCorner = null;
          paintStatus('Drawing cancelled; nothing was committed.');
          refresh();
        }
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (event.key === 'ArrowLeft') dx = -step;
      else if (event.key === 'ArrowRight') dx = step;
      else if (event.key === 'ArrowUp') dy = step;
      else if (event.key === 'ArrowDown') dy = -step;
      else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        if (activeTool === 'anchor' && selectedAnchorId !== null) {
          removeAnchor(bucket, selectedAnchorId, paintStatus);
        } else if (activeTool === 'safe-area' && selectedCorner !== null) {
          removeCorner(bucket, selectedCorner, paintStatus);
        }
        return;
      } else return;
      event.preventDefault();
      if (activeTool === 'anchor' && selectedAnchorId !== null) {
        moveAnchorKey(bucket, selectedAnchorId, dx, dy, paintStatus);
      } else if (activeTool === 'safe-area' && selectedCorner !== null) {
        moveCornerKey(bucket, selectedCorner, dx, dy, paintStatus);
      }
    });
    zoombox.append(svg);
    stage.append(zoombox);
    figure.append(stage);
    root.append(figure);
    observeStageFit(stage, layoutFit);

    const safePolygon = document.createElementNS(svgNS, 'polygon');
    // The staged polygon is the selected named area; lead CSS keeps the
    // translucent fill distinct from inactive areas via `is-selected`.
    safePolygon.setAttribute('class', 'product-setup-safe is-selected');
    // Layer visibility is render-only: a hidden layer stays staged, and its
    // detached nodes are simply not painted (drag math below still works).
    if (layerVisible(bucket, 'showAreas')) svg.append(safePolygon);
    const paintSafe = (points: ReadonlyArray<AnchorSetupMm>): void => {
      const mapped: string[] = [];
      for (const point of points) {
        const px = workspaceMmToPhoto(view, side, point);
        if (!px) return;
        mapped.push(`${px.x},${px.y}`);
      }
      safePolygon.setAttribute('points', mapped.join(' '));
    };
    paintSafe(bucket.safeArea);

    // Drags paint directly onto the live overlay (no re-render) and commit
    // exactly once on pointerup; pointercancel/Escape abort with no commit.
    const markerById = new Map<string, { dot: SVGRectElement; tag: SVGTextElement; marker: SVGGElement }>();
    const anchorsLayer = document.createElementNS(svgNS, 'g');
    anchorsLayer.setAttribute('class', 'product-setup-anchors');
    if (layerVisible(bucket, 'showAnchors')) svg.append(anchorsLayer);

    bucket.anchors.forEach((anchor) => {
      const px = workspaceMmToPhoto(view, side, { x: anchor.posMm[0]!, y: anchor.posMm[1]! });
      if (!px) return;
      if (activeTool === 'anchor') {
        const marker = document.createElementNS(svgNS, 'g');
        marker.setAttribute('class', selectedAnchorId === anchor.id
          ? 'product-setup-anchor is-selected'
          : 'product-setup-anchor');
        marker.setAttribute('tabindex', '0');
        marker.setAttribute('role', 'button');
        marker.setAttribute('data-fkey', `psv-anchor-${anchor.id}`);
        marker.setAttribute(
          'aria-label',
          `Anchor “${anchor.name}”. Arrow keys move, pointer drags, Delete removes.`,
        );
        const dot = document.createElementNS(svgNS, 'rect');
        dot.setAttribute('cx', String(px.x));
        dot.setAttribute('cy', String(px.y));
        dot.setAttribute('r', '9');
        dot.setAttribute('data-marksquare', '7');
        dot.setAttribute('class', 'product-setup-dot');
        // Comfortable hit target: transparent, constant-CSS-px hit area that
        // bubbles to the marker handlers (no handler changes needed).
        const hit = document.createElementNS(svgNS, 'circle');
        hit.setAttribute('cx', String(px.x));
        hit.setAttribute('cy', String(px.y));
        hit.setAttribute('r', '9');
        hit.setAttribute('data-markhit', '12');
        hit.setAttribute('fill', '#000');
        hit.setAttribute('fill-opacity', '0');
        hit.setAttribute('pointer-events', 'all');
        const tag = document.createElementNS(svgNS, 'text');
        tag.setAttribute('x', String(px.x + 12));
        tag.setAttribute('y', String(px.y + 4));
        tag.setAttribute('class', 'product-setup-tag');
        // Label sizes are viewBox-relative in this renderer (like geometry),
        // so the layout pass counter-scales them to constant rendered px.
        tag.setAttribute('data-markfont', '10');
        tag.setAttribute('data-markstroke', '4');
        tag.setAttribute('data-markcx', String(px.x));
        tag.setAttribute('data-markcy', String(px.y));
        tag.textContent = anchor.name;
        marker.append(hit, dot, tag);
        markerById.set(anchor.id, { dot: dot as SVGRectElement, tag: tag as SVGTextElement, marker: marker as SVGGElement });
        marker.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          selectedAnchorId = anchor.id;
          dragAnchor = anchor.id;
          (marker as SVGGElement).setPointerCapture?.(event.pointerId);
          // preventDefault above suppresses native focus-on-press (and the
          // compatibility click), so focus explicitly: later refreshes
          // restore it via data-fkey, keeping arrow-key nudges available
          // right after a pointer selection.
          (marker as unknown as HTMLElement).focus?.();
        });
        marker.addEventListener('click', (event) => {
          event.stopPropagation();
          selectedAnchorId = anchor.id;
          paintStatus(`Selected anchor “${anchor.name}”. Rename or remove it below.`);
          refresh();
        });
        marker.addEventListener('keydown', (event) => {
          const step = event.shiftKey ? 10 : 1;
          let dx = 0;
          let dy = 0;
          if (event.key === 'ArrowLeft') dx = -step;
          else if (event.key === 'ArrowRight') dx = step;
          else if (event.key === 'ArrowUp') dy = step;
          else if (event.key === 'ArrowDown') dy = -step;
          else return;
          event.preventDefault();
          event.stopPropagation();
          moveAnchorKey(bucket, anchor.id, dx, dy, paintStatus);
        });
        anchorsLayer.append(marker);
      } else {
        const dot = document.createElementNS(svgNS, 'rect');
        dot.setAttribute('cx', String(px.x));
        dot.setAttribute('cy', String(px.y));
        dot.setAttribute('r', '6');
        dot.setAttribute('data-marksquare', '7');
        dot.setAttribute('class', 'product-setup-dot is-reference');
        anchorsLayer.append(dot);
      }
    });

    // Saved reference-span evidence (lead-wired from the span sidecar bound
    // to this exact asset/view/calibration): dotted A/B line + readable
    // midpoint label with white backing as soon as both endpoints exist.
    // Missing or stale evidence draws nothing — never a fabricated line.
    // Lives on the anchors layer, so `vis-anchors` hides it without data loss.
    const savedSpan = usableReferenceSpan(view);
    if (savedSpan !== null) {
      const refGroup = document.createElementNS(svgNS, 'g');
      refGroup.setAttribute('class', 'product-setup-reference');
      const refLine = document.createElementNS(svgNS, 'line');
      refLine.setAttribute('x1', String(savedSpan.ax));
      refLine.setAttribute('y1', String(savedSpan.ay));
      refLine.setAttribute('x2', String(savedSpan.bx));
      refLine.setAttribute('y2', String(savedSpan.by));
      refLine.setAttribute('class', 'product-setup-refline');
      refLine.setAttribute('stroke', '#0b6cab');
      refLine.setAttribute('fill', 'none');
      refLine.setAttribute('stroke-width', '2');
      refLine.setAttribute('stroke-dasharray', '7 5');
      refLine.setAttribute('data-markstroke', '2');
      refLine.setAttribute('data-markdash', '7 5');
      refGroup.append(refLine);
      const midX = (savedSpan.ax + savedSpan.bx) / 2;
      const midY = (savedSpan.ay + savedSpan.by) / 2;
      const refLabel = document.createElementNS(svgNS, 'text');
      refLabel.setAttribute('x', String(midX + 12));
      refLabel.setAttribute('y', String(midY - 8));
      // Anchor-tag styling carries the white backing; the contract class
      // lets lead CSS target the measurement label.
      refLabel.setAttribute('class', 'product-setup-tag product-setup-reflabel');
      refLabel.setAttribute('data-markfont', '10');
      refLabel.setAttribute('data-markstroke', '4');
      refLabel.setAttribute('data-markcx', String(midX));
      refLabel.setAttribute('data-markcy', String(midY));
      refLabel.setAttribute('data-markdy', '-8');
      refLabel.textContent = referenceSpanLabel(savedSpan.lengthMm);
      refGroup.append(refLabel);
      const ends: Array<{ x: number; y: number; tag: string }> = [
        { x: savedSpan.ax, y: savedSpan.ay, tag: 'A' },
        { x: savedSpan.bx, y: savedSpan.by, tag: 'B' },
      ];
      for (const end of ends) {
        const dot = document.createElementNS(svgNS, 'rect');
        dot.setAttribute('cx', String(end.x));
        dot.setAttribute('cy', String(end.y));
        dot.setAttribute('r', '7');
        dot.setAttribute('data-marksquare', '7');
        dot.setAttribute('class', 'product-setup-dot is-reference');
        refGroup.append(dot);
        const tag = document.createElementNS(svgNS, 'text');
        tag.setAttribute('x', String(end.x + 12));
        tag.setAttribute('y', String(end.y + 4));
        tag.setAttribute('class', 'product-setup-tag');
        tag.setAttribute('data-markfont', '10');
        tag.setAttribute('data-markcx', String(end.x));
        tag.setAttribute('data-markcy', String(end.y));
        tag.textContent = end.tag;
        refGroup.append(tag);
      }
      anchorsLayer.append(refGroup);
    }

    if (activeTool === 'safe-area' && layerVisible(bucket, 'showAreas')) {
      renderSafeHandles(svgNS, svg, view, side, key, bucket, paintStatus, (points) => {
        const mapped: string[] = [];
        for (const point of points) {
          const px = workspaceMmToPhoto(view, side, point);
          if (!px) return;
          mapped.push(`${px.x},${px.y}`);
        }
        safePolygon.setAttribute('points', mapped.join(' '));
      });
      // Non-selected staged areas render as translucent outlines with
      // readable names; selection stays independent of the fills (clicks pass
      // through: pointer-events are none via the safe-area styling).
      for (const area of namedAreasOf(bucket)) {
        if (area.id === (bucket.activeAreaId ?? null)) continue;
        const mapped: string[] = [];
        let outside = false;
        for (const point of area.points) {
          const px = workspaceMmToPhoto(view, side, point);
          if (!px) {
            outside = true;
            break;
          }
          mapped.push(`${px.x},${px.y}`);
        }
        if (outside || mapped.length === 0) continue;
        const other = document.createElementNS(svgNS, 'polygon');
        other.setAttribute('class', 'product-setup-safe is-inactive');
        other.setAttribute('points', mapped.join(' '));
        svg.append(other);
        const first = workspaceMmToPhoto(view, side, area.points[0]!);
        if (first) {
          const name = document.createElementNS(svgNS, 'text');
          name.setAttribute('x', String(first.x + 12));
          name.setAttribute('y', String(first.y + 4));
          name.setAttribute('class', 'product-setup-tag');
          name.setAttribute('data-markfont', '12');
          name.setAttribute('data-markcx', String(first.x));
          name.setAttribute('data-markcy', String(first.y));
          name.textContent = area.name;
          svg.append(name);
        }
      }
      const draft = store.draftFor(key);
      if (draft !== undefined) {
        renderDraft(svgNS, svg, view, side, key, draft, paintStatus);
      }
    }

    svg.addEventListener('pointermove', (event) => {
      if (dragAnchor === null && dragVertex === null) return;
      const photo = eventPhotoPoint(svg, event);
      const mm = workspacePhotoToMm(view, side, photo.x, photo.y);
      if (!mm) {
        paintStatus('Pointer position is outside the evaluated mapping; nothing was moved.');
        return;
      }
      if (dragAnchor !== null) {
        const live = markerById.get(dragAnchor);
        const px = workspaceMmToPhoto(view, side, mm);
        if (live && px) {
          live.dot.setAttribute('cx', String(px.x));
          live.dot.setAttribute('cy', String(px.y));
          live.tag.setAttribute('data-markcx', String(px.x));
          live.tag.setAttribute('data-markcy', String(px.y));
          layoutStageMarkers(svg);
        }
        pendingAnchorMm = mm;
      } else if (dragVertex !== null) {
        if (pendingVertexBase === null) {
          pendingVertexBase = bucket.safeArea.map((point) => ({ ...point }));
        }
        const base = pendingVertexBase;
        const index = dragVertex;
        if (index < 0 || index >= base.length) return;
        base[index] = mm;
        const px = workspaceMmToPhoto(view, side, mm);
        if (pendingVertexHandle && px) {
          pendingVertexHandle.setAttribute('cx', String(px.x));
          pendingVertexHandle.setAttribute('cy', String(px.y));
        }
        const repainted: string[] = [];
        for (const point of base) {
          const corner = workspaceMmToPhoto(view, side, point);
          if (!corner) return;
          repainted.push(`${corner.x},${corner.y}`);
        }
        safePolygon.setAttribute('points', repainted.join(' '));
      }
    });
    const endDrag = (event: PointerEvent): void => {
      if (dragAnchor === null && dragVertex === null) return;
      const id = dragAnchor;
      const mm = pendingAnchorMm;
      const vertexIndex = dragVertex;
      const vertexBase = pendingVertexBase;
      dragAnchor = null;
      dragVertex = null;
      pendingAnchorMm = null;
      pendingVertexBase = null;
      pendingVertexHandle = null;
      event.preventDefault();
      if (id !== null && mm !== null) {
        const next = bucket.anchors.map((entry) => (
          entry.id === id ? { ...entry, posMm: [mm.x, mm.y] as [number, number] } : entry
        ));
        const problem = validateAnchors(next);
        if (problem) {
          paintStatus(`Anchor not moved: ${problem}`);
        } else {
          bucket.anchors = next;
          bucket.dirty = true;
          selectedAnchorId = id;
        }
      } else if (vertexIndex !== null && vertexBase !== null) {
        const check = validateSafeAreaPolygon(vertexBase);
        if (check.ok) {
          bucket.safeArea = vertexBase;
          syncActiveArea(bucket);
          bucket.dirty = true;
          selectedCorner = vertexIndex;
        } else {
          paintStatus(`Safe-area change refused: ${check.reason}`);
        }
      }
      refresh();
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', () => {
      dragAnchor = null;
      dragVertex = null;
      pendingAnchorMm = null;
      pendingVertexBase = null;
      pendingVertexHandle = null;
      refresh();
    });

    let downAt: { x: number; y: number } | null = null;
    svg.addEventListener('pointerdown', (event) => {
      downAt = { x: event.clientX, y: event.clientY };
    });
    svg.addEventListener('click', (event) => {
      if (dragAnchor !== null || dragVertex !== null) return;
      if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 6) return;
      const target = event.target as Element;
      if (target.closest?.('.product-setup-anchor, .product-setup-vertex, .product-setup-midpoint, .product-setup-draw')) return;
      const photo = eventPhotoPoint(svg, event);
      const mm = workspacePhotoToMm(view, side, photo.x, photo.y);
      if (!mm) {
        paintStatus(activeTool === 'anchor'
          ? 'No anchor created: the click falls outside the evaluated mapping.'
          : 'Corner not added: the click falls outside the evaluated mapping.');
        return;
      }
      if (activeTool === 'anchor') {
        const used = new Set(bucket.anchors.map((entry) => entry.name));
        let serial = bucket.anchors.length + 1;
        while (used.has(`Anchor ${serial}`)) serial += 1;
        const created: AnchorDef = {
          id: newAnchorId(),
          name: `Anchor ${serial}`,
          productId: scope.productId,
          variantId: scope.variantId,
          regionId: scope.regionId,
          frameId: scope.frameId,
          calibrationId: scope.calibrationId,
          calibrationVersion: scope.calibrationVersion,
          posMm: [mm.x, mm.y],
        };
        bucket.anchors = [...bucket.anchors, created];
        bucket.dirty = true;
        selectedAnchorId = created.id;
        if (!layerVisible(bucket, 'showAnchors')) {
          bucket.showAnchors = true;
          paintStatus(`Created “${created.name}”. The anchors layer was hidden, so it is shown again; nothing was deleted. Rename it below if needed.`);
        } else {
          paintStatus(`Created “${created.name}”. Rename it below if needed.`);
        }
        refresh();
        return;
      }
      // Safe-area tool: an existing polygon is edited via its handles, so a
      // bare photo click only ever extends a fresh drawing — either when no
      // polygon is staged yet, or while an explicit redraw is in progress.
      // Rectangle mode never invents click corners: taps only restate the
      // drag hint (press at one corner, drag to the opposite corner).
      if (bucket.safeArea.length > 0 && !redrawKeys.has(key)) {
        paintStatus('Safe-area tool: drag a corner, use a side handle, or pick a corner below. Photo clicks never alter the polygon here.');
        return;
      }
      if (activeTool === 'safe-area' && drawMode === 'rectangle') {
        paintStatus('Rectangle tool: press at one corner and drag to the opposite corner; release commits one area. Taps never alter the polygon here.');
        return;
      }
      const draft = store.draftFor(key) ?? [];
      store.setDraft(key, [...draft, mm]);
      paintStatus(
        `Draft corner ${draft.length + 1}. Finish with Enter, the first corner, or a double-click; Escape cancels with no commit.`,
      );
      refresh();
    });
    svg.addEventListener('dblclick', (event) => {
      if (activeTool !== 'safe-area') return;
      const draft = store.draftFor(key);
      if (draft === undefined) return;
      event.preventDefault();
      // The double-click's two clicks each staged a corner, so the trailing
      // duplicate is dropped before finishing.
      const trimmed = draft.length >= 4 ? draft.slice(0, -1) : draft.slice();
      finishDraft(key, bucket, trimmed, paintStatus);
    });

    // Freehand trace + rectangle drag gestures (safe-area tool only). Taps
    // (at most 6 CSS px) fall through to the click handler above — a tap is
    // never a stroke, and rectangle mode never invents click corners. Longer
    // presses paint a live closed filled preview and commit ONE staged area
    // on release; Escape/pointercancel roll back with no commit.
    if (activeTool === 'safe-area' && layerVisible(bucket, 'showAreas')) {
      const drawable = bucket.safeArea.length === 0 || redrawKeys.has(key);
      const paintPreview = (
        preview: SVGPolygonElement | null,
        corners: ReadonlyArray<AnchorSetupMm>,
      ): SVGPolygonElement | null => {
        if (corners.length === 0) return preview;
        let node = preview;
        if (!node || !node.isConnected) {
          node = document.createElementNS(svgNS, 'polygon') as SVGPolygonElement;
          node.setAttribute('class', 'product-setup-safe product-setup-gesture');
          svg.append(node);
        }
        const mapped: string[] = [];
        for (const corner of corners) {
          const px = workspaceMmToPhoto(view, side, corner);
          if (!px) return node;
          mapped.push(`${px.x},${px.y}`);
        }
        node.setAttribute('points', mapped.join(' '));
        return node;
      };
      svg.addEventListener('pointerdown', (event) => {
        if (!drawable || trace !== null || rectDrag !== null) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const target = event.target as Element;
        // Handles own their drags; gestures start on the bare photo only.
        if (target.closest?.('.product-setup-anchor, .product-setup-vertex, .product-setup-midpoint, .product-setup-draw')) return;
        const photo = eventPhotoPoint(svg, event);
        const mm = workspacePhotoToMm(view, side, photo.x, photo.y);
        if (!mm) {
          paintStatus(drawMode === 'rectangle'
            ? 'Rectangle not started: the press falls outside the evaluated mapping.'
            : 'Trace not started: the press falls outside the evaluated mapping.');
          return;
        }
        try {
          svg.setPointerCapture(event.pointerId);
        } catch {
          /* capture is best-effort; the gesture still ends on pointerup */
        }
        if (drawMode === 'rectangle') {
          rectDrag = { start: mm, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, end: null, preview: null };
        } else {
          trace = {
            startX: event.clientX, startY: event.clientY,
            points: [{ ...mm }], outOfScope: false, tracing: false, preview: null,
          };
        }
      });
      svg.addEventListener('pointermove', (event) => {
        if (!svg.isConnected) return;
        if (rectDrag !== null) {
          if (Math.hypot(event.clientX - rectDrag.startX, event.clientY - rectDrag.startY) <= 6) return;
          const photo = eventPhotoPoint(svg, event);
          const mm = workspacePhotoToMm(view, side, photo.x, photo.y);
          if (!mm) return;
          const start = rectDrag.start;
          // Live closed filled preview: press corner to opposite corner.
          rectDrag.preview = paintPreview(rectDrag.preview, [
            { x: Math.min(start.x, mm.x), y: Math.min(start.y, mm.y) },
            { x: Math.max(start.x, mm.x), y: Math.min(start.y, mm.y) },
            { x: Math.max(start.x, mm.x), y: Math.max(start.y, mm.y) },
            { x: Math.min(start.x, mm.x), y: Math.max(start.y, mm.y) },
          ]);
          return;
        }
        if (trace !== null) {
          if (Math.hypot(event.clientX - trace.startX, event.clientY - trace.startY) <= 6) return;
          trace.tracing = true;
          const photo = eventPhotoPoint(svg, event);
          const mm = workspacePhotoToMm(view, side, photo.x, photo.y);
          if (!mm) {
            trace.outOfScope = true;
            return;
          }
          const last = trace.points[trace.points.length - 1];
          if (!last || Math.hypot(mm.x - last.x, mm.y - last.y) > 1e-9) {
            trace.points.push({ ...mm });
            trace.preview = paintPreview(trace.preview, trace.points);
          }
        }
      });
      const commitGesture = (): void => {
        if (!svg.isConnected) {
          trace = null;
          rectDrag = null;
          return;
        }
        if (rectDrag !== null) {
          const gesture = rectDrag;
          rectDrag = null;
          gesture.preview?.remove();
          // A tap falls through to the click handler's rectangle hint; only
          // a real drag commits.
          if (Math.hypot(gesture.lastX - gesture.startX, gesture.lastY - gesture.startY) <= 6) return;
          const end = gesture.end;
          if (!end) {
            paintStatus('Rectangle not committed: the release falls outside the evaluated mapping. The last valid area is kept.');
            return;
          }
          const x0 = Math.min(gesture.start.x, end.x);
          const x1 = Math.max(gesture.start.x, end.x);
          const y0 = Math.min(gesture.start.y, end.y);
          const y1 = Math.max(gesture.start.y, end.y);
          if (!(x1 - x0 > 1e-9) || !(y1 - y0 > 1e-9)) {
            paintStatus('Rectangle rejected: zero-size — press at one corner and drag to the opposite corner. The last valid area is kept.');
            return;
          }
          const corners = [
            { x: x0, y: y0 },
            { x: x1, y: y0 },
            { x: x1, y: y1 },
            { x: x0, y: y1 },
          ];
          const check = validateSafeAreaPolygon(corners);
          if (!check.ok) {
            paintStatus(`Rectangle rejected: ${check.reason} The last valid area is kept.`);
            return;
          }
          if (bucket.safeArea.length > 0 && !redrawKeys.has(key)) {
            paintStatus('Safe-area tool: drag a corner or side handle, use Redraw selected, or pick a corner below. Photo drags never alter the polygon here.');
            return;
          }
          finishDraft(key, bucket, corners, paintStatus);
          return;
        }
        if (trace !== null) {
          const gesture = trace;
          trace = null;
          gesture.preview?.remove();
          // A tap falls through to the click handler (freehand corners); only
          // a real stroke commits.
          if (!gesture.tracing) return;
          if (gesture.outOfScope) {
            paintStatus('Freehand trace left the mapped photo area, so nothing was committed. The previous draft is intact.');
            return;
          }
          if (gesture.points.length < 3) {
            paintStatus('Freehand trace is too short to close an area — tap to add a corner, or drag a longer trace. The previous draft is intact.');
            return;
          }
          const ring = simplifyFreehandTrace(gesture.points);
          if (ring.length < 3) {
            paintStatus('Freehand trace is degenerate (no usable area), so nothing was committed. The previous draft is intact.');
            return;
          }
          const check = validateSafeAreaPolygon(ring);
          if (!check.ok) {
            const kind = /cross/.test(check.reason) ? 'self-crossing' : 'degenerate';
            paintStatus(`Freehand trace ${kind} — not committed: ${check.reason} The previous draft is intact.`);
            return;
          }
          if (bucket.safeArea.length > 0 && !redrawKeys.has(key)) {
            paintStatus('Safe-area tool: drag a corner, use a side handle, or pick a corner below. Photo drags never alter the polygon here.');
            return;
          }
          finishDraft(key, bucket, ring, paintStatus);
        }
      };
      svg.addEventListener('pointerup', (event) => {
        if (rectDrag !== null) {
          rectDrag.lastX = event.clientX;
          rectDrag.lastY = event.clientY;
          const photo = eventPhotoPoint(svg, event);
          rectDrag.end = workspacePhotoToMm(view, side, photo.x, photo.y);
        }
        if (trace === null && rectDrag === null) return;
        commitGesture();
      });
      svg.addEventListener('pointercancel', () => {
        if (trace === null && rectDrag === null) return;
        trace = null;
        rectDrag = null;
        // The shared pointercancel listener below refreshes (dropping the
        // preview); only the status is set here so it lands on the new box.
        paintStatus('Drawing cancelled; nothing was committed.');
      });
    }
  }

  function renderSafeHandles(
    svgNS: string,
    svg: SVGSVGElement,
    view: ProductSetupPhotoView,
    side: ProductSetupSide,
    key: string,
    bucket: StoredEdits,
    paintStatus: (message: string) => void,
    repaintSafe: (points: ReadonlyArray<AnchorSetupMm>) => void,
  ): void {
    // Rectangular staged geometry (including reopened saved rectangles that
    // pass the documented tolerance check) gets corner + side-midpoint
    // handles that preserve the rectangle while dragging; general polygons
    // keep the vertex + insert handles. Saved rectangles stay ordinary
    // polygons — no parallel schema.
    const rectangular = bucket.safeArea.length === 4 && isRectanglePoints(bucket.safeArea);
    const cornerDots: Array<{ dot: SVGCircleElement; hit: SVGCircleElement }> = [];
    const sideDots: Array<{ dot: SVGCircleElement; hit: SVGCircleElement }> = [];
    /**
     * Live repaint during rectangle-corner/side drags (no re-render):
     * polygon plus every handle follows the working ring. Commit happens
     * once on pointerup; cancel/Escape refresh back to the staged polygon.
     */
    const repaintHandles = (working: ReadonlyArray<AnchorSetupMm>): void => {
      repaintSafe(working);
      working.forEach((point, index) => {
        const px = workspaceMmToPhoto(view, side, point);
        const dot = cornerDots[index];
        if (!px || !dot) return;
        dot.dot.setAttribute('cx', String(px.x));
        dot.dot.setAttribute('cy', String(px.y));
        dot.hit.setAttribute('cx', String(px.x));
        dot.hit.setAttribute('cy', String(px.y));
      });
      if (rectangular) {
        working.forEach((point, index) => {
          const next = working[(index + 1) % working.length]!;
          const mid: AnchorSetupMm = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
          const px = workspaceMmToPhoto(view, side, mid);
          const dot = sideDots[index];
          if (!px || !dot) return;
          dot.dot.setAttribute('cx', String(px.x));
          dot.dot.setAttribute('cy', String(px.y));
          dot.hit.setAttribute('cx', String(px.x));
          dot.hit.setAttribute('cy', String(px.y));
        });
      }
      layoutStageMarkers(svg);
    };
    // Project p onto the line through `from` in direction `from`→`dir`.
    // Used by rectangle-preserving drags (opposite side/corner fixed).
    const projectOnto = (from: AnchorSetupMm, dir: AnchorSetupMm, p: AnchorSetupMm): AnchorSetupMm => {
      const vx = dir.x - from.x;
      const vy = dir.y - from.y;
      const len2 = vx * vx + vy * vy;
      if (!(len2 > 1e-18)) return { ...dir };
      const t = ((p.x - from.x) * vx + (p.y - from.y) * vy) / len2;
      return { x: from.x + vx * t, y: from.y + vy * t };
    };
    let rectCorner: { index: number; base: AnchorSetupMm[]; working: AnchorSetupMm[] } | null = null;
    let rectSide: { index: number; working: AnchorSetupMm[] } | null = null;
    const vertexLayer = document.createElementNS(svgNS, 'g');
    vertexLayer.setAttribute('class', 'product-setup-vertices');
    svg.append(vertexLayer);
    bucket.safeArea.forEach((point, index) => {
      const px = workspaceMmToPhoto(view, side, point);
      if (!px) return;
      const group = document.createElementNS(svgNS, 'g') as SVGGElement;
      group.setAttribute('tabindex', '0');
      group.setAttribute('role', 'button');
      group.setAttribute('data-fkey', `psv-vertex-${key}-${index}`);
      group.setAttribute(
        'aria-label',
        rectangular
          ? `Rectangle corner ${index + 1}. Dragging keeps the rectangle; arrow keys move precisely, Delete removes.`
          : `Safe-area corner ${index + 1}. Arrow keys move, Delete removes.`,
      );
      if (rectangular) group.setAttribute('data-ps-handle', `corner-${index + 1}`);
      const handle = document.createElementNS(svgNS, 'circle') as SVGCircleElement;
      handle.setAttribute('class', selectedCorner === index
        ? 'product-setup-vertex is-selected'
        : 'product-setup-vertex');
      handle.setAttribute('cx', String(px.x));
      handle.setAttribute('cy', String(px.y));
      handle.setAttribute('r', '7');
      handle.setAttribute('data-markr', '7');
      const vhit = document.createElementNS(svgNS, 'circle');
      vhit.setAttribute('cx', String(px.x));
      vhit.setAttribute('cy', String(px.y));
      vhit.setAttribute('r', '7');
      vhit.setAttribute('data-markhit', '12');
      vhit.setAttribute('fill', '#000');
      vhit.setAttribute('fill-opacity', '0');
      vhit.setAttribute('pointer-events', 'all');
      group.append(vhit, handle);
      if (rectangular) cornerDots.push({ dot: handle, hit: vhit as SVGCircleElement });
      group.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectedCorner = index;
        if (rectangular) {
          // Corner drag preserves the rectangle: the opposite corner stays
          // fixed while the adjacent corners project onto their edges.
          rectCorner = {
            index,
            base: bucket.safeArea.map((corner) => ({ ...corner })),
            working: bucket.safeArea.map((corner) => ({ ...corner })),
          };
          (group as SVGGElement).setPointerCapture?.(event.pointerId);
          (group as unknown as HTMLElement).focus?.();
          return;
        }
        dragVertex = index;
        pendingVertexBase = null;
        pendingVertexHandle = handle as SVGCircleElement;
        (handle as SVGCircleElement).setPointerCapture?.(event.pointerId);
        // preventDefault above suppresses native focus-on-press: focus
        // explicitly so arrow keys keep working after a pointer selection.
        (group as unknown as HTMLElement).focus?.();
      });
      group.addEventListener('pointermove', (event) => {
        if (rectCorner === null || rectCorner.index !== index || !rectangular) return;
        const photo = eventPhotoPoint(svg, event);
        const mm = workspacePhotoToMm(view, side, photo.x, photo.y);
        if (!mm || !svg.isConnected) return;
        // Opposite corner fixed; adjacent corners project so every angle
        // stays 90° for any rectangle orientation.
        const base = rectCorner.base;
        const o = base[(index + 2) % 4]!;
        const a = projectOnto(o, base[(index + 1) % 4]!, mm);
        const b = projectOnto(o, base[(index + 3) % 4]!, mm);
        const working = rectCorner.working;
        working[(index + 1) % 4] = a;
        working[(index + 3) % 4] = b;
        working[index] = { x: a.x + b.x - o.x, y: a.y + b.y - o.y };
        repaintHandles(working);
      });
      const endRectCorner = (commit: boolean): void => {
        if (rectCorner === null || rectCorner.index !== index) return;
        const working = rectCorner.working;
        rectCorner = null;
        if (!commit || !svg.isConnected) {
          refresh();
          return;
        }
        const check = validateSafeAreaPolygon(working);
        if (!check.ok) {
          paintStatus(`Corner not moved: ${check.reason}`);
          refresh();
          return;
        }
        bucket.safeArea = working.map((corner) => ({ ...corner }));
        syncActiveArea(bucket);
        bucket.dirty = true;
        selectedCorner = index;
        paintStatus(`Moved corner ${index + 1} (rectangle kept).`);
        refresh();
      };
      group.addEventListener('pointerup', () => endRectCorner(true));
      group.addEventListener('pointercancel', () => endRectCorner(false));
      group.addEventListener('click', (event) => {
        event.stopPropagation();
        selectedCorner = index;
        paintStatus(`Selected safe-area corner ${index + 1}.`);
        refresh();
      });
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          // Cancel an in-progress rectangle-corner drag, restoring the
          // previous draft (pointer capture keeps focus on this handle).
          event.preventDefault();
          event.stopPropagation();
          endRectCorner(false);
          return;
        }
        const step = event.shiftKey ? 10 : 1;
        let dx = 0;
        let dy = 0;
        if (event.key === 'ArrowLeft') dx = -step;
        else if (event.key === 'ArrowRight') dx = step;
        else if (event.key === 'ArrowUp') dy = step;
        else if (event.key === 'ArrowDown') dy = -step;
        else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          event.stopPropagation();
          removeCorner(bucket, index, paintStatus);
          return;
        } else return;
        event.preventDefault();
        event.stopPropagation();
        moveCornerKey(bucket, index, dx, dy, paintStatus);
      });
      vertexLayer.append(group);
    });

    if (bucket.safeArea.length === 4 && rectangular) {
      // Side-midpoint handles: dragging a side moves that side's two corners
      // along the side normal (opposite side fixed), preserving the
      // rectangle. Keyboard adjustments stay on the existing corner point
      // controls; Enter here selects the side's first corner instead.
      const sideLayer = document.createElementNS(svgNS, 'g');
      sideLayer.setAttribute('class', 'product-setup-midpoints');
      svg.append(sideLayer);
      bucket.safeArea.forEach((point, index) => {
        const next = bucket.safeArea[(index + 1) % 4]!;
        const mid: AnchorSetupMm = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
        const px = workspaceMmToPhoto(view, side, mid);
        if (!px) return;
        const sideGroup = document.createElementNS(svgNS, 'g') as SVGGElement;
        sideGroup.setAttribute('tabindex', '0');
        sideGroup.setAttribute('role', 'button');
        sideGroup.setAttribute('data-fkey', `psv-side-${key}-${index}`);
        sideGroup.setAttribute('data-ps-handle', `side-${index + 1}`);
        sideGroup.setAttribute('aria-label', `Move side ${index + 1} (keeps the rectangle).`);
        const sideDot = document.createElementNS(svgNS, 'circle') as SVGCircleElement;
        sideDot.setAttribute('class', 'product-setup-midpoint product-setup-sidehandle');
        sideDot.setAttribute('cx', String(px.x));
        sideDot.setAttribute('cy', String(px.y));
        sideDot.setAttribute('r', '5');
        sideDot.setAttribute('data-markr', '6');
        const sideHit = document.createElementNS(svgNS, 'circle');
        sideHit.setAttribute('cx', String(px.x));
        sideHit.setAttribute('cy', String(px.y));
        sideHit.setAttribute('r', '5');
        sideHit.setAttribute('data-markhit', '12');
        sideHit.setAttribute('fill', '#000');
        sideHit.setAttribute('fill-opacity', '0');
        sideHit.setAttribute('pointer-events', 'all');
        sideGroup.append(sideHit, sideDot);
        sideDots.push({ dot: sideDot, hit: sideHit as SVGCircleElement });
        sideGroup.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          selectedCorner = index;
          rectSide = {
            index,
            working: bucket.safeArea.map((corner) => ({ ...corner })),
          };
          (sideGroup as SVGGElement).setPointerCapture?.(event.pointerId);
          (sideGroup as unknown as HTMLElement).focus?.();
        });
        sideGroup.addEventListener('pointermove', (event) => {
          if (rectSide === null || rectSide.index !== index) return;
          const photo = eventPhotoPoint(svg, event);
          const mm = workspacePhotoToMm(view, side, photo.x, photo.y);
          if (!mm || !svg.isConnected) return;
          const working = rectSide.working;
          const edge = working[index]!;
          const after = working[(index + 1) % 4]!;
          const dx = after.x - edge.x;
          const dy = after.y - edge.y;
          const len = Math.hypot(dx, dy);
          if (!(len > 1e-9)) return;
          // Move both side corners along the edge normal; the opposite side
          // stays fixed so the ring remains a rectangle.
          const nx = -dy / len;
          const ny = dx / len;
          const t = (mm.x - edge.x) * nx + (mm.y - edge.y) * ny;
          working[index] = { x: edge.x + nx * t, y: edge.y + ny * t };
          working[(index + 1) % 4] = { x: after.x + nx * t, y: after.y + ny * t };
          repaintHandles(working);
        });
        const endRectSide = (commit: boolean): void => {
          if (rectSide === null || rectSide.index !== index) return;
          const working = rectSide.working;
          rectSide = null;
          if (!commit || !svg.isConnected) {
            refresh();
            return;
          }
          const check = validateSafeAreaPolygon(working);
          if (!check.ok) {
            paintStatus(`Side not moved: ${check.reason}`);
            refresh();
            return;
          }
          bucket.safeArea = working.map((corner) => ({ ...corner }));
          syncActiveArea(bucket);
          bucket.dirty = true;
          selectedCorner = index;
          paintStatus(`Moved side ${index + 1} (rectangle kept).`);
          refresh();
        };
        sideGroup.addEventListener('pointerup', () => endRectSide(true));
        sideGroup.addEventListener('pointercancel', () => endRectSide(false));
        sideGroup.addEventListener('click', (event) => {
          event.stopPropagation();
          selectedCorner = index;
          paintStatus(`Selected safe-area corner ${index + 1} (first corner of side ${index + 1}). Adjust it in the corner list below.`);
          refresh();
        });
        sideGroup.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            // Cancel an in-progress side drag, restoring the previous draft.
            event.preventDefault();
            event.stopPropagation();
            endRectSide(false);
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            selectedCorner = index;
            paintStatus(`Selected safe-area corner ${index + 1} (first corner of side ${index + 1}). Adjust it in the corner list below.`);
            refresh();
          }
        });
        sideLayer.append(sideGroup);
      });
    }

    if (bucket.safeArea.length >= 3 && !rectangular) {
      const midLayer = document.createElementNS(svgNS, 'g');
      midLayer.setAttribute('class', 'product-setup-midpoints');
      svg.append(midLayer);
      bucket.safeArea.forEach((point, index) => {
        const next = bucket.safeArea[(index + 1) % bucket.safeArea.length]!;
        const mid: AnchorSetupMm = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
        const px = workspaceMmToPhoto(view, side, mid);
        if (!px) return;
        const insertGroup = document.createElementNS(svgNS, 'g') as SVGGElement;
        insertGroup.setAttribute('tabindex', '0');
        insertGroup.setAttribute('role', 'button');
        insertGroup.setAttribute('data-fkey', `psv-insert-${key}-${index}`);
        insertGroup.setAttribute('aria-label', `Insert a safe-area corner on edge ${index + 1}.`);
        const plus = document.createElementNS(svgNS, 'circle') as SVGCircleElement;
        plus.setAttribute('class', 'product-setup-midpoint');
        plus.setAttribute('cx', String(px.x));
        plus.setAttribute('cy', String(px.y));
        plus.setAttribute('r', '5');
        plus.setAttribute('data-markr', '6');
        const plusHit = document.createElementNS(svgNS, 'circle');
        plusHit.setAttribute('cx', String(px.x));
        plusHit.setAttribute('cy', String(px.y));
        plusHit.setAttribute('r', '5');
        plusHit.setAttribute('data-markhit', '12');
        plusHit.setAttribute('fill', '#000');
        plusHit.setAttribute('fill-opacity', '0');
        plusHit.setAttribute('pointer-events', 'all');
        insertGroup.append(plusHit, plus);
        const insert = (): void => {
          const base = bucket.safeArea.map((corner) => ({ ...corner }));
          base.splice(index + 1, 0, { ...mid });
          const check = validateSafeAreaPolygon(base);
          if (!check.ok) {
            paintStatus(`Corner not inserted: ${check.reason}`);
            return;
          }
          bucket.safeArea = base;
          syncActiveArea(bucket);
          bucket.dirty = true;
          selectedCorner = index + 1;
          paintStatus(`Inserted a corner on edge ${index + 1}.`);
          refresh();
        };
        insertGroup.addEventListener('click', (event) => {
          event.stopPropagation();
          insert();
        });
        insertGroup.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            insert();
          }
        });
        midLayer.append(insertGroup);
      });
    }
  }

  function renderDraft(
    svgNS: string,
    svg: SVGSVGElement,
    view: ProductSetupPhotoView,
    side: ProductSetupSide,
    key: string,
    draft: AnchorSetupMm[],
    paintStatus: (message: string) => void,
  ): void {
    const draftLayer = document.createElementNS(svgNS, 'g');
    draftLayer.setAttribute('class', 'product-setup-drawing');
    svg.append(draftLayer);
    const linePts: string[] = [];
    for (const corner of draft) {
      const px = workspaceMmToPhoto(view, side, corner);
      if (!px) continue;
      linePts.push(`${px.x},${px.y}`);
    }
    // The draft connects while drawing and fills from 3 points (closed
    // polygon with a translucent fill; fewer than 3 points stay an open
    // polyline). The fill is inline so it holds even before lead CSS lands.
    if (draft.length >= 3 && linePts.length === draft.length && linePts[0] !== undefined) {
      const closed = document.createElementNS(svgNS, 'polygon') as SVGPolygonElement;
      closed.setAttribute('class', 'product-setup-draft is-closed');
      closed.setAttribute('points', [...linePts, linePts[0]].join(' '));
      closed.style.fill = 'rgba(11, 108, 171, 0.18)';
      draftLayer.append(closed);
    } else {
      const line = document.createElementNS(svgNS, 'polyline');
      line.setAttribute('class', 'product-setup-draft');
      line.setAttribute('points', linePts.join(' '));
      draftLayer.append(line);
    }
    draft.forEach((corner, index) => {
      const px = workspaceMmToPhoto(view, side, corner);
      if (!px) return;
      const drawGroup = document.createElementNS(svgNS, 'g') as SVGGElement;
      drawGroup.setAttribute('tabindex', '0');
      drawGroup.setAttribute('role', 'button');
      drawGroup.setAttribute('data-fkey', `psv-draw-${key}-${index}`);
      drawGroup.setAttribute(
        'aria-label',
        index === 0
          ? 'First draft corner. Activate to finish the safe area.'
          : `Draft corner ${index + 1}.`,
      );
      const handle = document.createElementNS(svgNS, 'circle') as SVGCircleElement;
      handle.setAttribute('class', index === 0 ? 'product-setup-draw product-setup-draw-first' : 'product-setup-draw');
      handle.setAttribute('cx', String(px.x));
      handle.setAttribute('cy', String(px.y));
      handle.setAttribute('r', index === 0 ? '10' : '7');
      handle.setAttribute('data-markr', index === 0 ? '8' : '7');
      const drawHit = document.createElementNS(svgNS, 'circle');
      drawHit.setAttribute('cx', String(px.x));
      drawHit.setAttribute('cy', String(px.y));
      drawHit.setAttribute('r', '7');
      drawHit.setAttribute('data-markhit', '12');
      drawHit.setAttribute('fill', '#000');
      drawHit.setAttribute('fill-opacity', '0');
      drawHit.setAttribute('pointer-events', 'all');
      drawGroup.append(drawHit, handle);
      drawGroup.addEventListener('click', (event) => {
        event.stopPropagation();
        if (index === 0) {
          const live = store.bucketFor(key, () => emptyBucket(view));
          finishDraft(key, live, store.draftFor(key) ?? draft, paintStatus);
        }
      });
      drawGroup.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && index === 0) {
          event.preventDefault();
          event.stopPropagation();
          const live = store.bucketFor(key, () => emptyBucket(view));
          finishDraft(key, live, store.draftFor(key) ?? draft, paintStatus);
        }
      });
      draftLayer.append(drawGroup);
    });
  }

  function emptyBucket(view: ProductSetupPhotoView): StoredEdits {
    const seeded = seedNamedAreas(
      view.safeArea,
      view.scope.regionName,
      view.savedAreas !== undefined
        ? { areas: view.savedAreas, activeAreaId: view.savedActiveAreaId ?? null }
        : undefined,
    );
    return {
      safeArea: view.safeArea.map((point) => ({ ...point })),
      anchors: view.anchors.map((anchor) => ({
        ...anchor,
        posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number],
      })),
      dirty: false,
      baseSafeArea: view.safeArea.map((point) => ({ ...point })),
      conflicted: false,
      namedAreas: seeded.namedAreas,
      activeAreaId: seeded.activeAreaId,
      baseNamedAreas: seeded.namedAreas.map((area) => ({
        ...area,
        points: area.points.map((point) => ({ ...point })),
      })),
      showAnchors: true,
      showAreas: true,
      showProduct: true,
    };
  }

  function finishDraft(
    key: string,
    bucket: StoredEdits,
    draft: AnchorSetupMm[],
    paintStatus: (message: string) => void,
  ): void {
    const closable = canCloseDrawnPolygon(draft);
    if (!closable.ok) {
      paintStatus(`Drawing not finished: ${closable.reason}`);
      return;
    }
    const check = validateSafeAreaPolygon(draft);
    if (!check.ok) {
      paintStatus(`Safe-area drawing refused: ${check.reason} Press Escape to cancel and redraw.`);
      return;
    }
    const polygon = draft.map((corner) => ({ ...corner }));
    const mode = drawModes.get(key) ?? { kind: 'new' as const };
    if (mode.kind === 'replace') {
      const target = namedAreasOf(bucket).find((entry) => entry.id === mode.targetId);
      if (target) {
        target.points = polygon.map((corner) => ({ ...corner }));
        bucket.activeAreaId = target.id;
        bucket.safeArea = polygon;
        bucket.dirty = true;
        store.dropDraft(key);
        redrawKeys.delete(key);
        drawModes.delete(key);
        selectedCorner = null;
        paintStatus(`Redrew area “${target.name}” with ${polygon.length} corners. Save product setup to commit it.`);
        refresh();
        return;
      }
    }
    // First finished area on an unconfigured scope takes the stable
    // scope-entry id: the scope region always carries exactly the
    // scope-entry polygon, so selection can never relocate placements.
    const takesScopeId =
      !namedAreasOf(bucket).some((area) => area.id === SCOPE_SAVED_AREA_ID) &&
      bucket.safeArea.length === 0;
    const entry: NamedSafeArea = {
      id: takesScopeId ? SCOPE_SAVED_AREA_ID : newAreaId(),
      name: nextAreaName(namedAreasOf(bucket).map((area) => area.name)),
      points: polygon.map((corner) => ({ ...corner })),
    };
    bucket.namedAreas = [...namedAreasOf(bucket), entry];
    bucket.activeAreaId = entry.id;
    bucket.safeArea = polygon;
    bucket.dirty = true;
    store.dropDraft(key);
    redrawKeys.delete(key);
    drawModes.delete(key);
    selectedCorner = null;
    paintStatus(`Staged a drawn safe area with ${draft.length} corners. Save product setup to commit it.`);
    refresh();
  }

  function moveAnchorKey(
    bucket: StoredEdits,
    id: string,
    dx: number,
    dy: number,
    paintStatus: (message: string) => void,
  ): void {
    const anchor = bucket.anchors.find((entry) => entry.id === id);
    if (!anchor) return;
    const next = bucket.anchors.map((entry) => (
      entry.id === id
        ? { ...entry, posMm: [entry.posMm[0]! + dx, entry.posMm[1]! + dy] as [number, number] }
        : entry
    ));
    const problem = validateAnchors(next);
    if (problem) {
      paintStatus(`Anchor not moved: ${problem}`);
      return;
    }
    bucket.anchors = next;
    bucket.dirty = true;
    paintStatus(`Moved anchor “${anchor.name}”.`);
    refresh();
  }

  function moveCornerKey(
    bucket: StoredEdits,
    index: number,
    dx: number,
    dy: number,
    paintStatus: (message: string) => void,
  ): void {
    const current = bucket.safeArea[index];
    if (!current) return;
    const base = bucket.safeArea.map((corner) => ({ ...corner }));
    base[index] = { x: current.x + dx, y: current.y + dy };
    const check = validateSafeAreaPolygon(base);
    if (!check.ok) {
      paintStatus(`Corner not moved: ${check.reason}`);
      return;
    }
    bucket.safeArea = base;
    syncActiveArea(bucket);
    bucket.dirty = true;
    paintStatus(`Moved corner ${index + 1}.`);
    refresh();
  }

  function removeAnchor(
    bucket: StoredEdits,
    id: string,
    paintStatus: (message: string) => void,
  ): void {
    const anchor = bucket.anchors.find((entry) => entry.id === id);
    bucket.anchors = bucket.anchors.filter((entry) => entry.id !== id);
    bucket.dirty = true;
    if (selectedAnchorId === id) selectedAnchorId = null;
    paintStatus(anchor ? `Removed anchor “${anchor.name}”.` : 'Removed anchor.');
    refresh();
  }

  function removeCorner(
    bucket: StoredEdits,
    index: number,
    paintStatus: (message: string) => void,
  ): void {
    if (bucket.safeArea.length <= 3) {
      paintStatus('Corner removal refused: a safe area needs at least 3 corners.');
      return;
    }
    const base = bucket.safeArea.map((corner) => ({ ...corner }));
    if (index < 0 || index >= base.length) return;
    base.splice(index, 1);
    const check = validateSafeAreaPolygon(base);
    if (!check.ok) {
      paintStatus(`Corner not removed: ${check.reason}`);
      return;
    }
    bucket.safeArea = base;
    syncActiveArea(bucket);
    bucket.dirty = true;
    if (selectedCorner === index) selectedCorner = null;
    paintStatus(`Removed corner ${index + 1}.`);
    refresh();
  }

  function renderAdvanced(
    panel: HTMLElement,
    view: ProductSetupPhotoView,
    rows: readonly string[],
  ): void {
    const details = document.createElement('details');
    details.className = 'product-setup-advanced';
    details.setAttribute('data-fkey', `psv-advanced-${viewIdentityKey(view)}`);
    const summary = document.createElement('summary');
    summary.textContent = 'Advanced';
    details.append(summary);
    const mapping = document.createElement('p');
    mapping.className = 'muted';
    mapping.textContent =
      `Mapping: ${view.mappingStatus}; frame ${view.scope.frameId}; ` +
      `calibration ${view.scope.calibrationId} @ ${view.scope.calibrationVersion}; photo ${view.photo.label}.`;
    details.append(mapping);
    if (rows.length > 0) {
      const list = document.createElement('ul');
      list.className = 'product-setup-advanced-list';
      for (const row of rows) {
        const item = document.createElement('li');
        item.className = 'muted';
        item.textContent = row;
        list.append(item);
      }
      details.append(list);
    }
    panel.append(details);
  }

  /**
   * Native millimetre precision field (keyboard accessible): commits on
   * change; the commit callback parses with {@link parsePrecisionMm} and
   * refuses with the existing validator wording, keeping the old value.
   * Uses only the DOM APIs this file already uses.
   */
  function mmField(
    host: HTMLElement,
    caption: string,
    fkey: string,
    ariaLabel: string,
    value: number,
    commit: (parsed: number | null) => void,
  ): void {
    const wrap = document.createElement('label');
    wrap.className = 'product-setup-field';
    const text = document.createElement('span');
    text.textContent = caption;
    const field = document.createElement('input');
    field.type = 'number';
    field.value = formatPrecisionMm(value);
    field.setAttribute('data-fkey', fkey);
    field.setAttribute('aria-label', ariaLabel);
    field.addEventListener('change', () => {
      commit(parsePrecisionMm(field.value));
    });
    wrap.append(text, field);
    host.append(wrap);
  }

  function renderSafePanel(
    root: HTMLElement,
    view: ProductSetupPhotoView,
    side: ProductSetupSide,
    key: string,
    bucket: StoredEdits,
    paintStatus: (message: string) => void,
  ): void {
    void side;
    const panel = document.createElement('div');
    panel.className = 'product-setup-panel';
    const heading = document.createElement('h4');
    heading.className = 'product-setup-heading';
    const draft = store.draftFor(key);
    if (draft !== undefined) {
      heading.textContent = `Drawing safe area (${draft.length} corner${draft.length === 1 ? '' : 's'} — nothing committed)`;
      panel.append(heading);
      const actions = document.createElement('div');
      actions.className = 'product-setup-actions actions';
      const finish = document.createElement('button');
      finish.type = 'button';
      finish.className = 'btn-secondary';
      finish.textContent = 'Finish safe area';
      finish.setAttribute('data-fkey', `psv-draw-finish-${key}`);
      finish.addEventListener('click', () => {
        finishDraft(key, bucket, store.draftFor(key) ?? draft, paintStatus);
      });
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn-secondary';
      cancel.textContent = 'Cancel drawing';
      cancel.setAttribute('data-fkey', `psv-draw-cancel-${key}`);
      cancel.addEventListener('click', () => {
        store.dropDraft(key);
        redrawKeys.delete(key);
        drawModes.delete(key);
        selectedCorner = null;
        paintStatus('Drawing cancelled; nothing was committed.');
        refresh();
      });
      actions.append(finish, cancel);
      panel.append(actions);
      root.append(panel);
      return;
    }
    const stagedAreas = namedAreasOf(bucket);
    const stagedActiveId = bucket.activeAreaId ?? null;
    const activeEntry = stagedActiveId !== null
      ? stagedAreas.find((entry) => entry.id === stagedActiveId) ?? null
      : null;
    heading.textContent = stagedAreas.length > 0
      ? `Safe areas (${stagedAreas.length}${bucket.dirty ? ', staged edits' : ''})`
      : 'Safe areas (none yet)';
    panel.append(heading);
    const bound = document.createElement('p');
    bound.className = 'muted';
    bound.textContent =
      'Areas are stored in millimetres under this calibration (pending review — never production approval). ' +
      'Recalibrating restarts from the saved setup only: staged extra areas are dropped, never reinterpreted. ' +
      'Names and non-selected areas stay staged in this session; Save commits the selected area’s polygon plus anchors.';
    panel.append(bound);
    if (stagedAreas.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = `No safe areas for ${shortScopeLabel(view.scope)} yet. Click the view image to start drawing one — a fresh calibration never invents a polygon.`;
      panel.append(empty);
      root.append(panel);
      return;
    }
    const startDrawing = (mode: { kind: 'new' } | { kind: 'replace'; targetId: string }, message: string): void => {
      redrawKeys.add(key);
      drawModes.set(key, mode);
      store.setDraft(key, []);
      selectedCorner = null;
      tool = 'safe-area';
      if (!layerVisible(bucket, 'showAreas')) {
        bucket.showAreas = true;
        paintStatus(`${message} The safe-areas layer was hidden, so it is shown again; nothing was deleted.`);
      } else {
        paintStatus(message);
      }
      refresh();
      container.querySelector<SVGSVGElement>('.product-setup-overlay')?.focus();
    };
    const areaList = document.createElement('div');
    areaList.className = 'product-setup-list';
    stagedAreas.forEach((area) => {
      const row = document.createElement('div');
      row.className = area.id === stagedActiveId ? 'product-setup-row is-selected' : 'product-setup-row';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'btn-secondary product-setup-pick';
      pick.textContent = area.name;
      pick.setAttribute('aria-pressed', area.id === stagedActiveId ? 'true' : 'false');
      pick.setAttribute('data-fkey', `psv-area-pick-${key}-${area.id}`);
      pick.addEventListener('click', () => {
        if (stagedActiveId !== area.id) {
          bucket.activeAreaId = area.id;
          if (!sameSafeArea(bucket.safeArea, area.points)) {
            bucket.safeArea = area.points.map((corner) => ({ ...corner }));
            bucket.dirty = true;
          }
          selectedCorner = null;
          paintStatus(`Selected area “${area.name}” (${area.points.length} corners). Save commits this polygon.`);
          refresh();
          return;
        }
        paintStatus(`Area “${area.name}” is already selected.`);
        refresh();
      });
      row.append(pick);
      areaList.append(row);
    });
    panel.append(areaList);
    if (activeEntry !== null) {
      const current = document.createElement('div');
      current.className = 'product-setup-current';
      const nameLabel = document.createElement('label');
      nameLabel.className = 'product-setup-field';
      const nameCaption = document.createElement('span');
      nameCaption.textContent = 'Area name';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = activeEntry.name;
      nameInput.maxLength = 80;
      nameInput.setAttribute('data-fkey', `psv-area-name-${key}-${activeEntry.id}`);
      nameInput.setAttribute('aria-label', `Name for safe area with ${activeEntry.points.length} corners`);
      nameInput.addEventListener('change', () => {
        const wanted = nameInput.value.trim();
        if (namedAreasOf(bucket).some((area) => area.id !== activeEntry.id && area.name === wanted)) {
          paintStatus(`Area not renamed: another area is already called “${wanted}”.`);
          nameInput.value = activeEntry.name;
          return;
        }
        const reason = validateNamedSafeArea(
          {
            id: activeEntry.id,
            name: wanted,
            points: activeEntry.points.map((point) => ({ ...point })),
          },
          namedAreasOf(bucket)
            .filter((area) => area.id !== activeEntry.id)
            .map((area) => area.id),
        );
        if (reason !== null) {
          paintStatus(`Area not renamed: ${reason}`);
          nameInput.value = activeEntry.name;
          return;
        }
        activeEntry.name = wanted;
        bucket.dirty = true;
        paintStatus(`Renamed area to “${wanted}”.`);
        refresh();
      });
      nameLabel.append(nameCaption, nameInput);
      current.append(nameLabel);
      const redrawSelected = document.createElement('button');
      redrawSelected.type = 'button';
      redrawSelected.className = 'btn-secondary';
      redrawSelected.textContent = 'Redraw selected';
      redrawSelected.setAttribute('aria-label', `Redraw the polygon of area “${activeEntry.name}”`);
      redrawSelected.setAttribute('data-fkey', `psv-area-redraw-${key}-${activeEntry.id}`);
      redrawSelected.addEventListener('click', () => {
        startDrawing(
          { kind: 'replace', targetId: activeEntry.id },
          `Redraw area “${activeEntry.name}”: click the photo to add corners. The current polygon stays staged until the new drawing finishes — Escape cancels and keeps it.`,
        );
      });
      const removeArea = document.createElement('button');
      removeArea.type = 'button';
      removeArea.className = 'btn-secondary product-setup-remove';
      removeArea.textContent = 'Delete area';
      removeArea.setAttribute('aria-label', `Delete safe area “${activeEntry.name}”`);
      removeArea.setAttribute('data-fkey', `psv-area-delete-${key}-${activeEntry.id}`);
      removeArea.addEventListener('click', () => {
        const removed = activeEntry.name;
        bucket.namedAreas = namedAreasOf(bucket).filter((area) => area.id !== activeEntry.id);
        const next = namedAreasOf(bucket)[0] ?? null;
        if (next) {
          bucket.activeAreaId = next.id;
          bucket.safeArea = next.points.map((corner) => ({ ...corner }));
          selectedCorner = null;
          bucket.dirty = true;
          paintStatus(`Deleted area “${removed}”. Selected “${next.name}” instead.`);
        } else {
          bucket.activeAreaId = null;
          bucket.safeArea = [];
          selectedCorner = null;
          bucket.dirty = true;
          paintStatus(`Deleted area “${removed}”. No areas remain — draw one to stage a polygon.`);
        }
        refresh();
      });
      current.append(redrawSelected, removeArea);
      panel.append(current);
    }
    if (!redrawKeys.has(key)) {
      const redrawActions = document.createElement('div');
      redrawActions.className = 'product-setup-actions actions';
      const redraw = document.createElement('button');
      redraw.type = 'button';
      redraw.className = 'btn-secondary';
      redraw.textContent = 'Draw new safe area';
      redraw.setAttribute('data-fkey', `psv-draw-new-${key}`);
      redraw.addEventListener('click', () => {
        startDrawing(
          { kind: 'new' },
          'Draw a new safe area: click the photo to add corners. The current polygon stays staged until the new drawing finishes — Escape cancels and keeps it.',
        );
      });
      redrawActions.append(redraw);
      panel.append(redrawActions);
    }
    const list = document.createElement('div');
    list.className = 'product-setup-list';
    const hasSelection = selectedCorner !== null &&
      selectedCorner >= 0 &&
      selectedCorner < bucket.safeArea.length;
    if (hasSelection) {
      // Selected-corner precision controls stay visible above the collapsed
      // pick list; every hook below keeps its existing data-fkey.
      const current = document.createElement('div');
      current.className = 'product-setup-current';
      const index = selectedCorner as number;
      const point = bucket.safeArea[index]!;
      const commitAxis = (axis: 'x' | 'y'): ((parsed: number | null) => void) => (parsed) => {
        const base = bucket.safeArea.map((corner) => ({ ...corner }));
        base[index] = {
          x: axis === 'x' ? (parsed ?? Number.NaN) : point.x,
          y: axis === 'y' ? (parsed ?? Number.NaN) : point.y,
        };
        const check = validateSafeAreaPolygon(base);
        if (!check.ok) {
          paintStatus(`Corner not moved: ${check.reason}`);
          refresh();
          return;
        }
        bucket.safeArea = base;
        syncActiveArea(bucket);
        bucket.dirty = true;
        paintStatus(`Moved corner ${index + 1}.`);
        refresh();
      };
      // Exact values stay exact, but the numeric fields live under an
      // opt-in disclosure so the normal row stays quiet.
      const precision = document.createElement('details');
      precision.className = 'product-setup-precision';
      const precisionTitle = document.createElement('summary');
      precisionTitle.textContent = 'Precision';
      precision.append(precisionTitle);
      mmField(
        precision,
        'X (mm)',
        `psv-corner-x-${key}-${index}`,
        `X millimetres for safe-area corner ${index + 1}`,
        point.x,
        commitAxis('x'),
      );
      mmField(
        precision,
        'Y (mm)',
        `psv-corner-y-${key}-${index}`,
        `Y millimetres for safe-area corner ${index + 1}`,
        point.y,
        commitAxis('y'),
      );
      current.append(precision);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary product-setup-remove';
      remove.textContent = 'Remove corner';
      remove.setAttribute('aria-label', `Remove safe-area corner ${index + 1}`);
      remove.setAttribute('data-fkey', `psv-corner-remove-${key}-${index}`);
      remove.addEventListener('click', () => {
        removeCorner(bucket, index, paintStatus);
      });
      current.append(remove);
      panel.append(current);
      const details = document.createElement('details');
      details.className = 'product-setup-all';
      const summary = document.createElement('summary');
      summary.textContent = `All corners (${bucket.safeArea.length})`;
      details.append(summary, list);
      panel.append(details);
    }
    bucket.safeArea.forEach((_point, index) => {
      const row = document.createElement('div');
      row.className = index === selectedCorner ? 'product-setup-row is-selected' : 'product-setup-row';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'btn-secondary product-setup-pick';
      pick.textContent = `Corner ${index + 1}`;
      pick.setAttribute('aria-pressed', index === selectedCorner ? 'true' : 'false');
      pick.setAttribute('data-fkey', `psv-corner-pick-${key}-${index}`);
      pick.addEventListener('click', () => {
        selectedCorner = index;
        paintStatus(`Selected safe-area corner ${index + 1}.`);
        refresh();
      });
      row.append(pick);
      list.append(row);
    });
    if (!hasSelection) {
      panel.append(list);
    }
    renderAdvanced(panel, view, safeAreaCoordinateRows(bucket.safeArea));
    root.append(panel);
  }

  function renderAnchorPanel(
    root: HTMLElement,
    view: ProductSetupPhotoView,
    key: string,
    bucket: StoredEdits,
    paintStatus: (message: string) => void,
  ): void {
    const panel = document.createElement('div');
    panel.className = 'product-setup-panel';
    const heading = document.createElement('h4');
    heading.className = 'product-setup-heading';
    heading.textContent = `Anchors (${bucket.anchors.length}${bucket.dirty ? ', staged edits' : ''})`;
    panel.append(heading);
    if (bucket.anchors.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = `No anchors for ${shortScopeLabel(view.scope)} yet. Click the view image to place the first one.`;
      panel.append(empty);
      root.append(panel);
      return;
    }
    const selected = selectedAnchorId !== null
      ? bucket.anchors.find((entry) => entry.id === selectedAnchorId) ?? null
      : null;
    if (selected !== null) {
      // No logo selection in this view (logos live in Choose/Check per-logo
      // cards): the selected anchor's name/remove/precision controls stay
      // visible above while its pick list renders collapsed. Every hook below
      // keeps its existing data-fkey, so at most one of each exists.
      const current = document.createElement('div');
      current.className = 'product-setup-current';
      const nameLabel = document.createElement('label');
      nameLabel.className = 'product-setup-field';
      const nameCaption = document.createElement('span');
      nameCaption.textContent = 'Name';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = selected.name;
      nameInput.maxLength = 80;
      nameInput.setAttribute('data-fkey', `psv-anchor-name-${selected.id}`);
      nameInput.setAttribute('aria-label', `Name for anchor “${selected.name}”`);
      nameInput.addEventListener('change', () => {
        const next = bucket.anchors.map((entry) => (
          entry.id === selected.id ? { ...entry, name: nameInput.value.trim() } : entry
        ));
        const problem = validateAnchors(next);
        if (problem) {
          paintStatus(`Anchor not renamed: ${problem}`);
          nameInput.value = selected.name;
          return;
        }
        bucket.anchors = next;
        bucket.dirty = true;
        paintStatus(`Renamed anchor to “${nameInput.value.trim()}”.`);
        refresh();
      });
      nameLabel.append(nameCaption, nameInput);
      current.append(nameLabel);
      const commitAxis = (axis: 0 | 1): ((parsed: number | null) => void) => (parsed) => {
        const next = bucket.anchors.map((entry) => (
          entry.id === selected.id
            ? {
              ...entry,
              posMm: [
                axis === 0 ? (parsed ?? Number.NaN) : entry.posMm[0]!,
                axis === 1 ? (parsed ?? Number.NaN) : entry.posMm[1]!,
              ] as [number, number],
            }
            : entry
        ));
        const problem = validateAnchors(next);
        if (problem) {
          paintStatus(`Anchor not moved: ${problem}`);
          refresh();
          return;
        }
        bucket.anchors = next;
        bucket.dirty = true;
        paintStatus(`Moved anchor “${selected.name}”.`);
        refresh();
      };
      // Exact values stay exact, but the numeric fields live under an
      // opt-in disclosure so the normal row stays quiet.
      const precision = document.createElement('details');
      precision.className = 'product-setup-precision';
      const precisionTitle = document.createElement('summary');
      precisionTitle.textContent = 'Precision';
      precision.append(precisionTitle);
      mmField(
        precision,
        'X (mm)',
        `psv-anchor-x-${selected.id}`,
        `X millimetres for anchor “${selected.name}”`,
        selected.posMm[0]!,
        commitAxis(0),
      );
      mmField(
        precision,
        'Y (mm)',
        `psv-anchor-y-${selected.id}`,
        `Y millimetres for anchor “${selected.name}”`,
        selected.posMm[1]!,
        commitAxis(1),
      );
      current.append(precision);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary product-setup-remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove anchor “${selected.name}”`);
      remove.setAttribute('data-fkey', `psv-anchor-remove-${selected.id}`);
      remove.addEventListener('click', () => {
        removeAnchor(bucket, selected.id, paintStatus);
      });
      current.append(remove);
      panel.append(current);
    }
    const list = document.createElement('div');
    list.className = 'product-setup-list';
    bucket.anchors.forEach((anchor) => {
      const row = document.createElement('div');
      row.className = anchor.id === selectedAnchorId ? 'product-setup-row is-selected' : 'product-setup-row';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'btn-secondary product-setup-pick';
      pick.textContent = anchor.name;
      pick.setAttribute('aria-pressed', anchor.id === selectedAnchorId ? 'true' : 'false');
      pick.setAttribute('data-fkey', `psv-anchor-pick-${anchor.id}`);
      pick.addEventListener('click', () => {
        selectedAnchorId = anchor.id;
        paintStatus(`Selected anchor “${anchor.name}”.`);
        refresh();
      });
      row.append(pick);
      list.append(row);
    });
    if (selected !== null) {
      const details = document.createElement('details');
      details.className = 'product-setup-all';
      const summary = document.createElement('summary');
      summary.textContent = `All anchors (${bucket.anchors.length})`;
      details.append(summary, list);
      panel.append(details);
    } else {
      panel.append(list);
    }
    renderAdvanced(panel, view, anchorCoordinateRows(bucket.anchors));
    root.append(panel);
  }

  function renderSaveBar(
    root: HTMLElement,
    tabScope: ProductSetupScope,
    key: string,
    bucket: StoredEdits,
    paintStatus: (message: string) => void,
    sharedNotice: string | undefined,
  ): void {
    const bar = document.createElement('div');
    bar.className = 'product-setup-savebar';
    const state = document.createElement('span');
    state.className = 'muted';
    state.textContent = saver.isPending
      ? 'Saving… edits stay live.'
      : bucket.dirty ? 'Staged edits — not saved yet.' : 'Matches the saved setup.';
    bar.append(state);
    if (sharedNotice !== undefined && sharedNotice.trim().length > 0) {
      const notice = document.createElement('p');
      notice.className = 'product-setup-shared-notice';
      notice.textContent = sharedNotice;
      bar.append(notice);
    }
    if (bucket.conflicted) {
      const conflict = document.createElement('p');
      conflict.className = 'product-setup-conflict';
      conflict.setAttribute('role', 'alert');
      conflict.textContent =
        'The saved area changed on another option since these edits started — ' +
        'saving now would silently overwrite it, so Save stays off. ' +
        'Reset to saved reloads the saved area (discards staged edits), or re-apply the edit on the new area.';
      bar.append(conflict);
    }
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn-primary';
    save.textContent = saver.isPending ? 'Saving…' : 'Save product setup';
    save.disabled = saver.isPending || bucket.conflicted;
    save.setAttribute('data-fkey', `psv-save-${key}`);
    save.addEventListener('click', () => {
      if (saver.isPending || bucket.conflicted) return;
      const validated = validateSaveRequest(bucket.safeArea, bucket.anchors, bucket.baseSafeArea);
      if (!validated.ok) {
        paintStatus(`Product setup not saved: ${validated.error}`);
        return;
      }
      // Snapshot at click time: edits made while the save is in flight stay
      // live in the bucket and are never clobbered by this save's outcome.
      const snapshot = validated.result;
      // Named areas ride along explicitly (stable ids + explicit active id —
      // the caller persists siblings by id and the scope-entry polygon into
      // the scope region, never inferring the active area by coordinates).
      syncActiveArea(bucket);
      snapshot.namedAreas = namedAreasOf(bucket).map((area) => ({
        id: area.id,
        name: area.name,
        points: area.points.map((corner) => ({ ...corner })),
      }));
      snapshot.activeAreaId = bucket.activeAreaId ?? null;
      snapshot.baseNamedAreas = (bucket.baseNamedAreas ?? []).map((area) => ({
        id: area.id,
        name: area.name,
        points: area.points.map((corner) => ({ ...corner })),
      }));
      const scopeSnapshot: ProductSetupScope = { ...tabScope };
      const scopeLabel = shortScopeLabel(scopeSnapshot);
      // Mark pending synchronously BEFORE any re-render, so the rebuilt Save
      // control disables and shows its Saving state (the saver flags pending
      // before its first await; the saver also starts the callback now).
      const pending = saver.run(() => callbacks.onSave(scopeSnapshot, snapshot));
      paintStatus('Saving product setup…');
      refresh();
      void pending.then((outcome) => {
        if (destroyed) return;
        paintStatus(applySaveOutcome(bucket, snapshot, scopeLabel, outcome));
        refresh();
      });
    });
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn-secondary';
    reset.textContent = 'Reset to saved';
    reset.setAttribute('data-fkey', `psv-reset-${key}`);
    reset.addEventListener('click', () => {
      store.dropBucket(key);
      store.dropDraft(key);
      redrawKeys.delete(key);
      drawModes.delete(key);
      selectedAnchorId = null;
      selectedCorner = null;
      paintStatus('Staged edits discarded; showing the saved setup.');
      refresh();
    });
    bar.append(save, reset);
    root.append(bar);
  }

  function destroy(): void {
    destroyed = true;
    disconnectStageResize();
    document.removeEventListener('keydown', cancelOnEscape);
    container.removeEventListener('keydown', cancelDrawingOnEscape);
    container.replaceChildren();
  }

  return { refresh, destroy };
}
