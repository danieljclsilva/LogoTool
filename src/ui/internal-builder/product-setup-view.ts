/// <reference lib="dom" />
/**
 * Visual product-setup workspace (one staff entry, operation-sheet first).
 *
 * Tabbed product views (Front/Back/Left/Right, only views present in the
 * input) around a large white photo stage with two explicit tools:
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
 * (photoId + sourceRev + full scope ids + frame/calibration versions +
 * transform coefficients), so switching tabs retains staged edits while ANY
 * asset/scope/mapping/source change re-initialises from caller state —
 * stale geometry is dropped, never reinterpreted. ONE atomic **Save product
 * setup** awaits the caller's explicit acknowledgement: while pending the
 * Save control is disabled against overlap, edits stay live, failure keeps
 * the draft dirty and intact, and success is announced only on `{ ok: true }`.
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
  validateSafeAreaPolygon,
} from './anchor-setup.js';
import type {
  AnchorSetupMm,
  AnchorSetupPhoto,
} from './anchor-setup.js';
import type { AnchorDef } from '../../core/operation-measurements/types.js';

/** Product views, in tab order. Tabs render only for views present in input. */
export type ProductSetupSide = PhotoMappingView;

export const PRODUCT_SETUP_SIDES: readonly ProductSetupSide[] = ['front', 'back', 'left', 'right'];

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
}

/** Short human label for headings/captions: never ids, never jargon. */
export function shortScopeLabel(scope: ProductSetupScope): string {
  const side = sideLabel(scope.side);
  if (scope.regionName === null || scope.regionName.trim().length === 0) return `${side} view`;
  return `${scope.regionName} · ${side}`;
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
export function resolveInitialSide(
  input: ProductSetupWorkspaceInput,
  current: ProductSetupSide | null,
): ProductSetupSide | null {
  const present = PRODUCT_SETUP_SIDES.filter((side) => input.views[side] !== undefined);
  if (current !== null && present.includes(current)) return current;
  if (input.initialSide !== undefined && present.includes(input.initialSide)) return input.initialSide;
  return present[0] ?? null;
}

/** Stable transform fingerprint for draft-bucket identity (exact coefficients, or null). */
export function transformKeyOf(transform: PhotoMappingTransform | null): string {
  if (!transform) return 'null';
  return JSON.stringify([transform.a, transform.b, transform.c, transform.d, transform.e, transform.f]);
}

/**
 * Stable identity for one view's staged edits. Same photoId + sourceRev +
 * full scope (including the tab side) + transform → same key (drafts
 * retained, e.g. across tab switches). ANY change (photo swap, calibration
 * bump, new source project, re-evaluated mapping, side) → a different key,
 * so the view re-initialises from caller state and never reinterprets stale
 * geometry. Byte length is deliberately NOT part of the key.
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
    view.scope.side,
    transformKeyOf(view.transform),
  ]);
}

export interface StoredEdits {
  safeArea: AnchorSetupMm[];
  anchors: AnchorDef[];
  dirty: boolean;
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
}

/** Explicit save acknowledgement the view awaits (sync or async). */
export type ProductSetupSaveResult =
  | { ok: true }
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
): { ok: true; result: ProductSetupResult } | { ok: false; error: string } {
  const check = validateSafeAreaPolygon([...safeArea]);
  if (!check.ok) return { ok: false, error: `the safe area is invalid — ${check.reason}` };
  const problem = validateAnchors(anchors);
  if (problem) return { ok: false, error: problem };
  return {
    ok: true,
    result: {
      safeArea: safeArea.map((corner) => ({ ...corner })),
      anchors: anchors.map((anchor) => ({
        ...anchor,
        posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number],
      })),
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
      if (outcome.ok) return { ok: true };
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
 */
export function applySaveOutcome(
  bucket: StoredEdits,
  snapshot: ProductSetupResult,
  scopeLabel: string,
  outcome: ProductSetupSaveResult,
): string {
  if (outcome.ok) {
    const liveJson = JSON.stringify({ safeArea: bucket.safeArea, anchors: bucket.anchors });
    if (liveJson === JSON.stringify(snapshot)) {
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
  getWorkspaceInput: () => ProductSetupWorkspaceInput | { error: string },
  callbacks: ProductSetupCallbacks,
): ProductSetupViewHandle {
  let destroyed = false;
  let tool: ProductSetupTool | null = null;
  let selectedSide: ProductSetupSide | null = null;
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
  let selectedAnchorId: string | null = null;
  let selectedCorner: number | null = null;
  /** Active tab's edit-bucket key, for container-level drawing cancellation. */
  let activeKey: string | null = null;
  /** Latest render's status painter (container Escape has no render closure). */
  let paintRef: ((message: string) => void) | null = null;
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
    const presentSides = PRODUCT_SETUP_SIDES.filter((side) => input.views[side] !== undefined);
    if (presentSides.length === 0) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = 'No product views are available yet.';
      root.append(note, statusBox);
      return;
    }
    // Identity set for every present view: retains staged edits per view,
    // drops anything whose asset/scope/mapping/source changed or vanished.
    const identityBySide = new Map<ProductSetupSide, string>();
    const errorMarks: string[] = [];
    for (const side of presentSides) {
      const selected = selectWorkspaceView(input, side);
      if (isProductSetupPhotoView(selected)) {
        identityBySide.set(side, viewIdentityKey(selected));
      } else {
        errorMarks.push(`error:${side}:${selected.error}`);
      }
    }
    const identityKeys = new Set(identityBySide.values());
    store.retainBuckets(identityKeys);
    store.retainDrafts(identityKeys);
    for (const redrawKey of [...redrawKeys]) {
      if (!identityKeys.has(redrawKey)) redrawKeys.delete(redrawKey);
    }
    const projectKey = JSON.stringify([...identityKeys].sort().concat(errorMarks.sort()));
    if (tabProjectKey !== projectKey) {
      tabProjectKey = projectKey;
      selectedSide = null;
      tool = null;
      selectedAnchorId = null;
      selectedCorner = null;
      selectionContext = null;
    }
    const side = resolveInitialSide(input, selectedSide);
    if (side === null) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = 'No product views are available yet.';
      root.append(note, statusBox);
      return;
    }
    selectedSide = side;
    const selected = selectWorkspaceView(input, side);
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
    const key = viewIdentityKey(view);
    activeKey = key;
    identityKeys.add(key);
    const bucket = store.bucketFor(key, () => ({
      safeArea: view.safeArea.map((point) => ({ ...point })),
      anchors: view.anchors.map((anchor) => ({
        ...anchor,
        posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number],
      })),
      dirty: false,
    }));
    const activeTool: ProductSetupTool = tool ??
      (bucket.safeArea.length === 0 ? 'safe-area' : 'anchor');
    tool = activeTool;
    const context = `${key} ${activeTool}`;
    if (selectionContext !== context) {
      selectionContext = context;
      selectedAnchorId = null;
      selectedCorner = null;
    }

    renderTabs(root, presentSides, side, (next) => {
      selectedSide = next;
      const upcoming = selectWorkspaceView(input, next);
      paintStatus(isProductSetupPhotoView(upcoming)
        ? `Viewing ${shortScopeLabel(upcoming.scope)}; staged edits are kept per view.`
        : upcoming.error);
      refresh();
    });
    renderToolbar(root, activeTool, bucket, (next) => {
      tool = next;
      paintStatus(next === 'safe-area'
        ? 'Safe-area tool: click the photo to draw, drag corners to edit. Anchor clicks do nothing here.'
        : 'Anchor tool: click the photo to place a named anchor. Safe-area clicks do nothing here.');
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

    renderStage(root, view, side, key, bucket, activeTool, paintStatus);
    if (activeTool === 'safe-area') {
      renderSafePanel(root, view, side, key, bucket, paintStatus);
    } else {
      renderAnchorPanel(root, view, key, bucket, paintStatus);
    }
    renderSaveBar(root, tabScope, key, bucket, paintStatus);
    root.append(statusBox);
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
    sides: readonly ProductSetupSide[],
    selected: ProductSetupSide,
    onSelect: (side: ProductSetupSide) => void,
  ): void {
    const tabs = document.createElement('div');
    tabs.className = 'product-setup-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Product views');
    for (const side of sides) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = side === selected ? 'product-setup-tab is-active' : 'product-setup-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', side === selected ? 'true' : 'false');
      tab.setAttribute('data-fkey', `psv-tab-${side}`);
      tab.textContent = sideLabel(side);
      tab.addEventListener('click', () => onSelect(side));
      tabs.append(tab);
    }
    root.append(tabs);
  }

  function renderToolbar(
    root: HTMLElement,
    activeTool: ProductSetupTool,
    bucket: StoredEdits,
    onSelect: (next: ProductSetupTool) => void,
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
    root.append(bar);
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = activeTool === 'safe-area'
      ? 'Safe-area tool: draw a fresh polygon or drag corners. Photo clicks never place anchors here; Enter finishes a drawing, Escape cancels.'
      : 'Anchor tool: click the product to place a named anchor; drag, rename or delete it. Photo clicks never touch the safe area here.';
    root.append(hint);
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
    paintStatus: (message: string) => void,
  ): void {
    const scope = view.scope;
    const figure = document.createElement('figure');
    figure.className = 'product-setup-figure';
    const caption = document.createElement('figcaption');
    caption.className = 'muted';
    caption.textContent = `${shortScopeLabel(scope)} — millimetres come from the evaluated mapping.`;
    figure.append(caption);

    const stage = document.createElement('div');
    stage.className = 'product-setup-stage';
    const image = document.createElement('img');
    image.className = 'product-setup-photo';
    const headerUrl = bytesToDataUrl(view.photo.bytes, guessMediaType(view.photo.bytes));
    if (headerUrl) {
      image.src = headerUrl;
      image.alt = `${view.photo.label} (${shortScopeLabel(scope)} setup reference)`;
      image.draggable = false;
      stage.append(image);
    } else {
      const missing = document.createElement('p');
      missing.className = 'muted';
      missing.textContent = 'Photo bytes are missing or undecodable; setup needs a readable product photo.';
      stage.append(missing);
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
    svg.setAttribute(
      'aria-label',
      `${shortScopeLabel(scope)} overlay (${activeTool === 'safe-area' ? 'safe-area' : 'anchor'} tool active)`,
    );
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
        if (dragAnchor !== null || dragVertex !== null) return;
        if (store.draftFor(key) !== undefined) {
          store.dropDraft(key);
          redrawKeys.delete(key);
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
    stage.append(svg);
    figure.append(stage);
    root.append(figure);

    const safePolygon = document.createElementNS(svgNS, 'polygon');
    safePolygon.setAttribute('class', 'product-setup-safe');
    svg.append(safePolygon);
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
    const markerById = new Map<string, { dot: SVGCircleElement; tag: SVGTextElement; marker: SVGGElement }>();
    const anchorsLayer = document.createElementNS(svgNS, 'g');
    anchorsLayer.setAttribute('class', 'product-setup-anchors');
    svg.append(anchorsLayer);

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
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', String(px.x));
        dot.setAttribute('cy', String(px.y));
        dot.setAttribute('r', '9');
        dot.setAttribute('class', 'product-setup-dot');
        const tag = document.createElementNS(svgNS, 'text');
        tag.setAttribute('x', String(px.x + 12));
        tag.setAttribute('y', String(px.y + 4));
        tag.setAttribute('class', 'product-setup-tag');
        tag.textContent = anchor.name;
        marker.append(dot, tag);
        markerById.set(anchor.id, { dot: dot as SVGCircleElement, tag: tag as SVGTextElement, marker: marker as SVGGElement });
        marker.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          selectedAnchorId = anchor.id;
          dragAnchor = anchor.id;
          (marker as SVGGElement).setPointerCapture?.(event.pointerId);
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
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', String(px.x));
        dot.setAttribute('cy', String(px.y));
        dot.setAttribute('r', '6');
        dot.setAttribute('class', 'product-setup-dot is-reference');
        anchorsLayer.append(dot);
      }
    });

    if (activeTool === 'safe-area') {
      renderSafeHandles(svgNS, svg, view, side, key, bucket, paintStatus);
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
          live.tag.setAttribute('x', String(px.x + 12));
          live.tag.setAttribute('y', String(px.y + 4));
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
        paintStatus(`Created “${created.name}”. Rename it below if needed.`);
        refresh();
        return;
      }
      // Safe-area tool: an existing polygon is edited via its handles, so a
      // bare photo click only ever extends a fresh drawing — either when no
      // polygon is staged yet, or while an explicit redraw is in progress.
      if (bucket.safeArea.length > 0 && !redrawKeys.has(key)) {
        paintStatus('Safe-area tool: drag a corner, use a “+” handle, or pick a corner below. Photo clicks never alter the polygon here.');
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
  }

  function renderSafeHandles(
    svgNS: string,
    svg: SVGSVGElement,
    view: ProductSetupPhotoView,
    side: ProductSetupSide,
    key: string,
    bucket: StoredEdits,
    paintStatus: (message: string) => void,
  ): void {
    const vertexLayer = document.createElementNS(svgNS, 'g');
    vertexLayer.setAttribute('class', 'product-setup-vertices');
    svg.append(vertexLayer);
    bucket.safeArea.forEach((point, index) => {
      const px = workspaceMmToPhoto(view, side, point);
      if (!px) return;
      const handle = document.createElementNS(svgNS, 'circle') as SVGCircleElement;
      handle.setAttribute('class', selectedCorner === index
        ? 'product-setup-vertex is-selected'
        : 'product-setup-vertex');
      handle.setAttribute('cx', String(px.x));
      handle.setAttribute('cy', String(px.y));
      handle.setAttribute('r', '7');
      handle.setAttribute('tabindex', '0');
      handle.setAttribute('role', 'button');
      handle.setAttribute('data-fkey', `psv-vertex-${key}-${index}`);
      handle.setAttribute(
        'aria-label',
        `Safe-area corner ${index + 1}. Arrow keys move, Delete removes.`,
      );
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectedCorner = index;
        dragVertex = index;
        pendingVertexBase = null;
        pendingVertexHandle = handle as SVGCircleElement;
        (handle as SVGCircleElement).setPointerCapture?.(event.pointerId);
      });
      handle.addEventListener('click', (event) => {
        event.stopPropagation();
        selectedCorner = index;
        paintStatus(`Selected safe-area corner ${index + 1}.`);
        refresh();
      });
      handle.addEventListener('keydown', (event) => {
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
      vertexLayer.append(handle);
    });

    if (bucket.safeArea.length >= 3) {
      const midLayer = document.createElementNS(svgNS, 'g');
      midLayer.setAttribute('class', 'product-setup-midpoints');
      svg.append(midLayer);
      bucket.safeArea.forEach((point, index) => {
        const next = bucket.safeArea[(index + 1) % bucket.safeArea.length]!;
        const mid: AnchorSetupMm = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
        const px = workspaceMmToPhoto(view, side, mid);
        if (!px) return;
        const plus = document.createElementNS(svgNS, 'circle') as SVGCircleElement;
        plus.setAttribute('class', 'product-setup-midpoint');
        plus.setAttribute('cx', String(px.x));
        plus.setAttribute('cy', String(px.y));
        plus.setAttribute('r', '5');
        plus.setAttribute('tabindex', '0');
        plus.setAttribute('role', 'button');
        plus.setAttribute('data-fkey', `psv-insert-${key}-${index}`);
        plus.setAttribute('aria-label', `Insert a safe-area corner on edge ${index + 1}.`);
        const insert = (): void => {
          const base = bucket.safeArea.map((corner) => ({ ...corner }));
          base.splice(index + 1, 0, { ...mid });
          const check = validateSafeAreaPolygon(base);
          if (!check.ok) {
            paintStatus(`Corner not inserted: ${check.reason}`);
            return;
          }
          bucket.safeArea = base;
          bucket.dirty = true;
          selectedCorner = index + 1;
          paintStatus(`Inserted a corner on edge ${index + 1}.`);
          refresh();
        };
        plus.addEventListener('click', (event) => {
          event.stopPropagation();
          insert();
        });
        plus.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            insert();
          }
        });
        midLayer.append(plus);
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
    const line = document.createElementNS(svgNS, 'polyline');
    line.setAttribute('class', 'product-setup-draft');
    const linePts: string[] = [];
    for (const corner of draft) {
      const px = workspaceMmToPhoto(view, side, corner);
      if (!px) continue;
      linePts.push(`${px.x},${px.y}`);
    }
    if (draft.length >= 3 && linePts.length === draft.length && linePts[0] !== undefined) {
      linePts.push(linePts[0]);
    }
    line.setAttribute('points', linePts.join(' '));
    draftLayer.append(line);
    draft.forEach((corner, index) => {
      const px = workspaceMmToPhoto(view, side, corner);
      if (!px) return;
      const handle = document.createElementNS(svgNS, 'circle') as SVGCircleElement;
      handle.setAttribute('class', index === 0 ? 'product-setup-draw product-setup-draw-first' : 'product-setup-draw');
      handle.setAttribute('cx', String(px.x));
      handle.setAttribute('cy', String(px.y));
      handle.setAttribute('r', index === 0 ? '10' : '7');
      handle.setAttribute('tabindex', '0');
      handle.setAttribute('role', 'button');
      handle.setAttribute('data-fkey', `psv-draw-${key}-${index}`);
      handle.setAttribute(
        'aria-label',
        index === 0
          ? 'First draft corner. Activate to finish the safe area.'
          : `Draft corner ${index + 1}.`,
      );
      handle.addEventListener('click', (event) => {
        event.stopPropagation();
        if (index === 0) {
          const live = store.bucketFor(key, () => emptyBucket(view));
          finishDraft(key, live, store.draftFor(key) ?? draft, paintStatus);
        }
      });
      handle.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && index === 0) {
          event.preventDefault();
          event.stopPropagation();
          const live = store.bucketFor(key, () => emptyBucket(view));
          finishDraft(key, live, store.draftFor(key) ?? draft, paintStatus);
        }
      });
      draftLayer.append(handle);
    });
  }

  function emptyBucket(view: ProductSetupPhotoView): StoredEdits {
    return {
      safeArea: view.safeArea.map((point) => ({ ...point })),
      anchors: view.anchors.map((anchor) => ({
        ...anchor,
        posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number],
      })),
      dirty: false,
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
    bucket.safeArea = draft.map((corner) => ({ ...corner }));
    bucket.dirty = true;
    store.dropDraft(key);
    redrawKeys.delete(key);
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
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent = 'Click the photo to add corners. Finish with Enter, the first (larger) corner, or a double-click; Escape cancels with no commit.';
      panel.append(hint);
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
        selectedCorner = null;
        paintStatus('Drawing cancelled; nothing was committed.');
        refresh();
      });
      actions.append(finish, cancel);
      panel.append(actions);
      root.append(panel);
      return;
    }
    heading.textContent = bucket.safeArea.length > 0
      ? `Safe area (${bucket.safeArea.length} corners${bucket.dirty ? ', staged edits' : ''})`
      : 'Safe area (none yet)';
    panel.append(heading);
    if (bucket.safeArea.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = `No safe area for ${shortScopeLabel(view.scope)} yet. Click the photo to start drawing one.`;
      panel.append(empty);
      root.append(panel);
      return;
    }
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = redrawKeys.has(key)
      ? 'Drawing a replacement: click the photo to add corners. The current polygon stays staged until the new drawing finishes — Escape cancels and keeps it.'
      : 'Drag corners on the photo, or pick one below to remove it.';
    panel.append(hint);
    if (!redrawKeys.has(key)) {
      const redrawActions = document.createElement('div');
      redrawActions.className = 'product-setup-actions actions';
      const redraw = document.createElement('button');
      redraw.type = 'button';
      redraw.className = 'btn-secondary';
      redraw.textContent = 'Draw new safe area';
      redraw.setAttribute('data-fkey', `psv-draw-new-${key}`);
      redraw.addEventListener('click', () => {
        redrawKeys.add(key);
        store.setDraft(key, []);
        selectedCorner = null;
        tool = 'safe-area';
        paintStatus('Draw a new safe area: click the photo to add corners. The current polygon stays staged until the new drawing finishes — Escape cancels and keeps it.');
        refresh();
        container.querySelector<SVGSVGElement>('.product-setup-overlay')?.focus();
      });
      redrawActions.append(redraw);
      panel.append(redrawActions);
    }
    const list = document.createElement('div');
    list.className = 'product-setup-list';
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
      if (index === selectedCorner) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn-secondary product-setup-remove';
        remove.textContent = 'Remove corner';
        remove.setAttribute('aria-label', `Remove safe-area corner ${index + 1}`);
        remove.setAttribute('data-fkey', `psv-corner-remove-${key}-${index}`);
        remove.addEventListener('click', () => {
          removeCorner(bucket, index, paintStatus);
        });
        row.append(remove);
      }
      list.append(row);
    });
    panel.append(list);
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
      empty.textContent = `No anchors for ${shortScopeLabel(view.scope)} yet. Click the product photo to place the first one.`;
      panel.append(empty);
      root.append(panel);
      return;
    }
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Pick an anchor to rename or remove it, or drag it on the photo.';
    panel.append(hint);
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
      if (anchor.id === selectedAnchorId) {
        const nameLabel = document.createElement('label');
        nameLabel.className = 'product-setup-field';
        const nameCaption = document.createElement('span');
        nameCaption.textContent = 'Name';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = anchor.name;
        nameInput.maxLength = 80;
        nameInput.setAttribute('data-fkey', `psv-anchor-name-${anchor.id}`);
        nameInput.setAttribute('aria-label', `Name for anchor “${anchor.name}”`);
        nameInput.addEventListener('change', () => {
          const next = bucket.anchors.map((entry) => (
            entry.id === anchor.id ? { ...entry, name: nameInput.value.trim() } : entry
          ));
          const problem = validateAnchors(next);
          if (problem) {
            paintStatus(`Anchor not renamed: ${problem}`);
            nameInput.value = anchor.name;
            return;
          }
          bucket.anchors = next;
          bucket.dirty = true;
          paintStatus(`Renamed anchor to “${nameInput.value.trim()}”.`);
          refresh();
        });
        nameLabel.append(nameCaption, nameInput);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn-secondary product-setup-remove';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove anchor “${anchor.name}”`);
        remove.setAttribute('data-fkey', `psv-anchor-remove-${anchor.id}`);
        remove.addEventListener('click', () => {
          removeAnchor(bucket, anchor.id, paintStatus);
        });
        row.append(nameLabel, remove);
      }
      list.append(row);
    });
    panel.append(list);
    renderAdvanced(panel, view, anchorCoordinateRows(bucket.anchors));
    root.append(panel);
  }

  function renderSaveBar(
    root: HTMLElement,
    tabScope: ProductSetupScope,
    key: string,
    bucket: StoredEdits,
    paintStatus: (message: string) => void,
  ): void {
    const bar = document.createElement('div');
    bar.className = 'product-setup-savebar';
    const state = document.createElement('span');
    state.className = 'muted';
    state.textContent = saver.isPending
      ? 'Saving… edits stay live.'
      : bucket.dirty ? 'Staged edits — not saved yet.' : 'Matches the saved setup.';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn-primary';
    save.textContent = saver.isPending ? 'Saving…' : 'Save product setup';
    save.disabled = saver.isPending;
    save.setAttribute('data-fkey', `psv-save-${key}`);
    save.addEventListener('click', () => {
      if (saver.isPending) return;
      const validated = validateSaveRequest(bucket.safeArea, bucket.anchors);
      if (!validated.ok) {
        paintStatus(`Product setup not saved: ${validated.error}`);
        return;
      }
      // Snapshot at click time: edits made while the save is in flight stay
      // live in the bucket and are never clobbered by this save's outcome.
      const snapshot = validated.result;
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
      selectedAnchorId = null;
      selectedCorner = null;
      paintStatus('Staged edits discarded; showing the saved setup.');
      refresh();
    });
    bar.append(state, save, reset);
    root.append(bar);
  }

  function destroy(): void {
    destroyed = true;
    document.removeEventListener('keydown', cancelOnEscape);
    container.removeEventListener('keydown', cancelDrawingOnEscape);
    container.replaceChildren();
  }

  return { refresh, destroy };
}
