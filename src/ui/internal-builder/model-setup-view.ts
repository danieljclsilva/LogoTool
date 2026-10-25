/// <reference lib="dom" />
/**
 * Model-only 3D setup view (W3-owned, staff-only).
 *
 * A 3D model contains all viewpoints, so the model-only workflow requires NO
 * images: there is no image prerequisite here. Reference anchors are actual
 * 3D surface picks — raycast mesh hits in asset (wrapper-local) coordinates
 * via the viewer's pick API — never screen pixels, never model bounds.
 * Distances are straight-line chords between picked surface points, not
 * geodesic surface arcs. Each named safe area's polygon establishes its own
 * region plane (Newell normal + centroid origin); the plane is visually
 * guided by the overlay, needs no photos, and needs no calibration points
 * beyond the polygon itself.
 *
 * Uniform scale (`mmPerUnit`) is zoom/camera invariant because every input is
 * an asset-coordinate surface pick: orbiting, fitting or resizing the view
 * cannot change saved numbers.
 *
 * WIRING (lead-owned, not done here): `main.ts` mounts this view with
 * `createModelSetupView(host, viewerOf, canvasOf, getInput, callbacks)` and
 * provides the `.model-setup-*` CSS classes named in the render code below
 * (layout only: `.model-setup`, `.model-setup-banner`, `.model-setup-row`,
 * `.model-setup-field`, `.model-setup-actions`, `.model-setup-status`,
 * `.model-setup-hint`, `.model-setup-list`). Behaviour and copy need no
 * template changes. This module never touches the template.
 *
 * CONTRACT (W1-owned, landed as `src/core/setup-calibration/index.ts`): this
 * view imports the EXACT contract names `validateReferenceSpan`,
 * `fitScaleFromReferences`, `spanNativeDistance`, `validateNamedSafeArea`
 * (plus their types) and keeps only view-specific 3D geometry local —
 * notably `planeFromPolygon`, because the core contract models safe areas as
 * 2D frame-mm rings while this view authors 3D surface polygons that
 * establish their own region plane. Each polygon is projected onto its plane
 * (scaled to mm under the current fit when calibrated) and then validated
 * through the real `validateNamedSafeArea`, so ring topology (crossing,
 * duplicates, zero area) is kernel-checked, not reimplemented. No production
 * approval is ever claimed: every output stays `pendingReview: true,
 * productionApproved: false`.
 *
 * No files are read except the explicit local setup-restore picker; no
 * fetch, no network, no browser storage of customer data.
 */

import {
  fitScaleFromReferences,
  spanNativeDistance,
  validateNamedSafeArea,
  validateReferenceSpan,
} from '../../core/setup-calibration/index.js';
import type {
  ReferenceSpan,
  SetupPoint3D,
} from '../../core/setup-calibration/index.js';

/** Source of the pure setup-calibration contract used by this view. */
export const MODEL_SETUP_CONTRACT_SOURCE = 'core/setup-calibration' as const;

/** Deterministic setup save/restore envelope version. */
export const MODEL_SETUP_VERSION = '0.1.0-provisional-model-setup' as const;

/** 3D point in asset (wrapper-local model) coordinates. Native units. */
export type SetupVec3 = SetupPoint3D;

/** Fitted uniform scale with the entered span distance (single-span draft). */
export interface SetupScaleFit {
  mmPerUnit: number;
  nativeDistance: number;
  lengthMm: number;
}

/** Region plane derived from a safe-area polygon (native units). */
export interface SetupRegionPlane {
  origin: SetupVec3;
  normal: SetupVec3;
  xDir: SetupVec3;
  yDir: SetupVec3;
}

function isVec3(value: unknown): value is SetupVec3 {
  if (value === null || typeof value !== 'object') return false;
  if (!('x' in value) || !('y' in value) || !('z' in value)) return false;
  const x = value.x;
  const y = value.y;
  const z = value.z;
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof z === 'number' &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(z)
  );
}

function sub3(a: SetupVec3, b: SetupVec3): SetupVec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross3(a: SetupVec3, b: SetupVec3): SetupVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function norm3(v: SetupVec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/* ------------------------------------------------------------------ */
/* View-local 3D geometry (plane derivation; ring checks stay in core). */
/* ------------------------------------------------------------------ */

/**
 * Region plane for a safe-area polygon via Newell's method (native units):
 * centroid origin, unit normal, in-plane xDir from the first edge projected
 * perpendicular to the normal, yDir = normal × xDir. Returns null when the
 * points are collinear/coincident (no plane). Pure.
 */
export function planeFromPolygon(points: readonly SetupVec3[]): SetupRegionPlane | null {
  if (!Array.isArray(points) || points.length < 3) return null;
  for (const point of points) {
    if (!isVec3(point)) return null;
  }
  const origin: SetupVec3 = { x: 0, y: 0, z: 0 };
  for (const point of points) {
    origin.x += point.x;
    origin.y += point.y;
    origin.z += point.z;
  }
  origin.x /= points.length;
  origin.y /= points.length;
  origin.z /= points.length;
  const normal: SetupVec3 = { x: 0, y: 0, z: 0 };
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current === undefined || next === undefined) return null;
    normal.x += (current.y - next.y) * (current.z + next.z);
    normal.y += (current.z - next.z) * (current.x + next.x);
    normal.z += (current.x - next.x) * (current.y + next.y);
  }
  const normalLength = norm3(normal);
  if (!Number.isFinite(normalLength) || !(normalLength > 1e-12)) return null;
  const unit: SetupVec3 = {
    x: normal.x / normalLength,
    y: normal.y / normalLength,
    z: normal.z / normalLength,
  };
  const first = points[0];
  const second = points[1];
  if (first === undefined || second === undefined) return null;
  const edge = sub3(second, first);
  const along = edge.x * unit.x + edge.y * unit.y + edge.z * unit.z;
  const inPlane: SetupVec3 = {
    x: edge.x - along * unit.x,
    y: edge.y - along * unit.y,
    z: edge.z - along * unit.z,
  };
  const inPlaneLength = norm3(inPlane);
  if (!Number.isFinite(inPlaneLength) || !(inPlaneLength > 1e-12)) return null;
  const xDir: SetupVec3 = {
    x: inPlane.x / inPlaneLength,
    y: inPlane.y / inPlaneLength,
    z: inPlane.z / inPlaneLength,
  };
  const yDir = cross3(unit, xDir);
  if (!isVec3(yDir) || !(norm3(yDir) > 1e-12)) return null;
  return { origin, normal: unit, xDir, yDir };
}

/**
 * Project one 3D safe-area polygon onto its region plane and scale to mm
 * under the fitted scale (native units while `mmPerUnit` is null). Returns
 * the plane plus the 2D ring, or null when degenerate. Pure; shared by the
 * ring check below and by station persistence (projected rings become domain
 * region polygons — an explicit planar projection of surface picks, never a
 * curved-surface claim).
 */
export function projectAreaToMm(
  points: readonly SetupVec3[],
  mmPerUnit: number | null,
): { plane: SetupRegionPlane; ring: Array<{ x: number; y: number }> } | null {
  if (!Array.isArray(points) || points.length < 3) return null;
  for (const point of points) {
    if (!isVec3(point)) return null;
  }
  const plane = planeFromPolygon(points);
  if (plane === null) return null;
  const scale = mmPerUnit !== null ? mmPerUnit : 1;
  const ring = points.map((point) => {
    const dx = point.x - plane.origin.x;
    const dy = point.y - plane.origin.y;
    const dz = point.z - plane.origin.z;
    return {
      x: (dx * plane.xDir.x + dy * plane.xDir.y + dz * plane.xDir.z) * scale,
      y: (dx * plane.yDir.x + dy * plane.yDir.y + dz * plane.yDir.z) * scale,
    };
  });
  for (const vertex of ring) {
    if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) return null;
  }
  return { plane, ring };
}

/**
 * Validate one 3D safe-area polygon through the core contract: derive its
 * region plane locally, project the polygon onto plane axes, scale to mm
 * under the current fit (native units while uncalibrated — the kernel's 1e-9
 * numeric epsilon is then unit-relative, noted wherever surfaced), and run
 * the real `validateNamedSafeArea` ring check. Returns a human reason, or
 * null when valid. Pure.
 */
export function checkModelSafeArea(
  id: string,
  name: string,
  points: readonly SetupVec3[],
  existingIds: readonly string[],
  mmPerUnit: number | null,
): string | null {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) return 'Name the safe area (e.g. “Left chest”).';
  if (!Array.isArray(points) || points.length < 3) {
    return `Safe area “${trimmed}” needs at least 3 surface points (have ${Array.isArray(points) ? points.length : 0}).`;
  }
  if (points.length > 512) return `Safe area “${trimmed}” exceeds 512 polygon points.`;
  for (const point of points) {
    if (!isVec3(point)) return `Safe area “${trimmed}” has a non-surface point; re-pick it on the model.`;
  }
  const projected = projectAreaToMm(points, mmPerUnit);
  if (projected === null) {
    return `Safe area “${trimmed}” is degenerate (coincident or collinear points) — pick points that span a patch.`;
  }
  return validateNamedSafeArea({ id, name: trimmed, points: projected.ring }, existingIds);
}

/** Display-only straight-line chord between two asset points (never a fit input). */
function chordNative(a: SetupVec3, b: SetupVec3): number {
  if (!isVec3(a) || !isVec3(b)) return 0;
  const d = norm3(sub3(a, b));
  return Number.isFinite(d) ? d : 0;
}

/* ------------------------------------------------------------------ */
/* View                                                               */
/* ------------------------------------------------------------------ */

/** Structural viewer surface this view needs (satisfied by ModelViewer). */
export interface ModelSetupViewerLike {
  pickSurfaceFromEvent(event: { clientX: number; clientY: number }): { modelPosition: SetupVec3 } | null;
  setAnchorMarkers(anchors: Array<{ id: string; model: SetupVec3 }>): void;
  setSafeAreaOverlays(items: Array<{ id: string; pointsModel: SetupVec3[] }>): void;
  setAnchorsVisible(visible: boolean): void;
  getAnchorsVisible(): boolean;
  setSafeAreasVisible(visible: boolean): void;
  getSafeAreasVisible(): boolean;
  setProductVisible(visible: boolean): void;
  getProductVisible(): boolean;
}

/**
 * One setup scope the view can stage for: a product plus the exact model
 * scope (product-wide, or one variant's own model). Scopes never share
 * drafts: variant-specific models are fully isolated per variant, so one
 * variant's picks can never leak into another's calibration, regions or
 * snapshots.
 */
export interface ModelSetupProduct {
  productId: string;
  productName: string;
  /** Variant owning this scope's model; undefined for a product-wide model. */
  variantId?: string;
  /** Exact `presentation/` model path for this scope (caller-resolved). */
  modelPath: string;
}

export interface ModelSetupInput {
  products: ModelSetupProduct[];
  activeProductId: string | null;
  /** Variant scope of the active entry; null/undefined means product-wide. */
  activeVariantId?: string | null;
  /**
   * Opaque caller-owned asset identity for save/restore binding (e.g.
   * modelPath + byte length + content hash). Restores only reopen against
   * the identical key; null disables the check with a visible note.
   */
  assetKey: string | null;
}

export interface ModelSetupSnapshot {
  productId: string;
  /** Variant owning this snapshot's scope; null for product-wide. */
  variantId: string | null;
  reference: ReferenceSpan | null;
  mmPerUnit: number | null;
  fitStale: boolean;
  areas: Array<{ id: string; name: string; points: SetupVec3[]; status: 'current' | 'stale' }>;
  anchorsVisible: boolean;
  safeAreasVisible: boolean;
  productVisible: boolean;
  pendingReview: true;
  productionApproved: false;
}

export interface ModelSetupCallbacks {
  onStatus(message: string): void;
  onChange(snapshot: ModelSetupSnapshot): void;
  /**
   * Optional scope switch (lead-owned): the view keeps every scope's staged
   * data regardless; when absent, scope buttons only announce preservation
   * without changing the active scope.
   */
  onSelectProduct?: (productId: string, variantId?: string) => void;
}

export interface ModelSetupViewHandle {
  refresh(): void;
  destroy(): void;
  /**
   * Hydrate the ACTIVE product's draft from a previously exported setup JSON
   * envelope (same shape as the view's own download). The imported fit is
   * recomputed locally and areas reopen stale — identical semantics to the
   * file-picker restore, minus file I/O, so the station can reopen master
   * sidecars without a download round-trip. Returns the same user-facing
   * message the restore path paints. No commit; caller persists.
   */
  hydrateFromJson(text: string): { ok: boolean; message: string };
}

type ArmTarget = 'refA' | 'refB' | 'areaPoint' | null;

interface DraftArea {
  id: string;
  name: string;
  points: SetupVec3[];
  status: 'current' | 'stale';
}

interface ProductDraft {
  refA: SetupVec3 | null;
  refB: SetupVec3 | null;
  distanceMmRaw: string;
  fitted: SetupScaleFit | null;
  fitStale: boolean;
  areas: DraftArea[];
  selectedAreaId: string | null;
  drawing: SetupVec3[] | null;
  drawingName: string;
  anchorsVisible: boolean;
  safeAreasVisible: boolean;
  productVisible: boolean;
}

function newDraft(): ProductDraft {
  return {
    refA: null,
    refB: null,
    distanceMmRaw: '',
    fitted: null,
    fitStale: false,
    areas: [],
    selectedAreaId: null,
    drawing: null,
    drawingName: '',
    anchorsVisible: true,
    safeAreasVisible: true,
    productVisible: true,
  };
}

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
  return `model-area-${suffix}`;
}

function formatNative(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return String(Math.round(value * 10000) / 10000);
}

function formatMm(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10}`;
}

const HOOK = 'data-model-setup-hook';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  hook: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.setAttribute(HOOK, hook);
  if (className !== undefined) node.className = className;
  return node;
}

function snapshotOf(productId: string, variantId: string | null, draft: ProductDraft): ModelSetupSnapshot {
  return {
    productId,
    variantId,
    reference:
      draft.refA !== null && draft.refB !== null && draft.distanceMmRaw.trim() !== ''
        ? { id: 'model-ref', a: { ...draft.refA }, b: { ...draft.refB }, lengthMm: Number(draft.distanceMmRaw) }
        : null,
    mmPerUnit: draft.fitted !== null && !draft.fitStale ? draft.fitted.mmPerUnit : null,
    fitStale: draft.fitStale,
    areas: draft.areas.map((area) => ({
      id: area.id,
      name: area.name,
      points: area.points.map((point) => ({ ...point })),
      status: area.status,
    })),
    anchorsVisible: draft.anchorsVisible,
    safeAreasVisible: draft.safeAreasVisible,
    productVisible: draft.productVisible,
    pendingReview: true,
    productionApproved: false,
  };
}

/**
 * Render the model-only 3D setup view into `container`, replacing its
 * contents. `viewerOf`/`canvasOf` stay live so the lead can attach, replace
 * or dispose the viewer without this view holding a stale reference.
 */
export function createModelSetupView(
  container: HTMLElement,
  viewerOf: () => ModelSetupViewerLike | null,
  canvasOf: () => HTMLCanvasElement | null,
  getInput: () => ModelSetupInput,
  callbacks: ModelSetupCallbacks,
): ModelSetupViewHandle {
  let destroyed = false;
  let armed: ArmTarget = null;
  let advancedOpen = false;
  let lastStatus = '';
  const drafts = new Map<string, ProductDraft>();
  let downAt: { x: number; y: number; button: number } | null = null;

  /** Draft identity: product + exact model scope (never shared across variants). */
  const draftKeyFor = (productId: string, variantId: string | null | undefined): string =>
    `${productId}${variantId === undefined || variantId === null ? '' : ` ${variantId}`}`;

  const draftFor = (productId: string, variantId: string | null | undefined): ProductDraft => {
    const key = draftKeyFor(productId, variantId);
    const existing = drafts.get(key);
    if (existing) return existing;
    const fresh = newDraft();
    drafts.set(key, fresh);
    return fresh;
  };

  const paintViewer = (draft: ProductDraft): void => {
    const viewer = viewerOf();
    if (!viewer) return;
    try {
      const markers: Array<{ id: string; model: SetupVec3 }> = [];
      if (draft.refA) markers.push({ id: 'model-ref-a', model: { ...draft.refA } });
      if (draft.refB) markers.push({ id: 'model-ref-b', model: { ...draft.refB } });
      if (draft.drawing) {
        draft.drawing.forEach((point, index) => {
          markers.push({ id: `model-draw-${index}`, model: { ...point } });
        });
      }
      viewer.setAnchorMarkers(markers);
      viewer.setSafeAreaOverlays(
        draft.areas.map((area) => ({ id: area.id, pointsModel: area.points.map((p) => ({ ...p })) })),
      );
      viewer.setAnchorsVisible(draft.anchorsVisible);
      viewer.setSafeAreasVisible(draft.safeAreasVisible);
      viewer.setProductVisible(draft.productVisible);
    } catch {
      return;
    }
  };

  const currentDraft = (): { entry: ModelSetupProduct; draft: ProductDraft } | { error: string } => {
    const input = getInput();
    // Exact scope match only — no first-entry fallback: staging against a
    // scope the caller did not activate would silently mix variant geometry.
    const entry = input.products.find(
      (p) => p.productId === input.activeProductId && (p.variantId ?? null) === (input.activeVariantId ?? null),
    ) ?? null;
    if (entry === null) {
      return { error: 'Choose a product above to set it up on the 3D model.' };
    }
    return { entry, draft: draftFor(entry.productId, entry.variantId ?? null) };
  };

  const emit = (entry: ModelSetupProduct, draft: ProductDraft): void => {
    try {
      callbacks.onChange(snapshotOf(entry.productId, entry.variantId ?? null, draft));
    } catch {
      return;
    }
  };

  function refresh(): void {
    if (destroyed) return;
    container.replaceChildren();
    const root = document.createElement('div');
    root.className = 'model-setup';
    container.append(root);

    const banner = el('p', 'pending-banner', 'model-setup-banner muted');
    banner.textContent =
      'Draft 3D setup — pending review, never production-approved. No images needed: every input below is a 3D surface pick in model coordinates.';
    root.append(banner);

    const statusBox = el('p', 'status', 'model-setup-status muted');
    statusBox.setAttribute('role', 'status');
    statusBox.textContent = lastStatus;
    const paintStatus = (message: string): void => {
      lastStatus = message;
      statusBox.textContent = message;
      try {
        callbacks.onStatus(message);
      } catch {
        return;
      }
    };

    const input = getInput();
    if (input.products.length === 0) {
      const note = el('p', 'empty', 'muted');
      note.textContent = 'Add a real 3D product first — nothing is pre-selected.';
      root.append(note, statusBox);
      return;
    }

    renderProductRow(root, input, paintStatus);
    const resolved = currentDraft();
    if ('error' in resolved) {
      const note = el('p', 'no-product', 'muted');
      note.textContent = resolved.error;
      root.append(note, statusBox);
      return;
    }
    const { entry, draft } = resolved;
    renderReference(root, entry, draft, paintStatus);
    renderAreas(root, entry, draft, paintStatus);
    renderToggles(root, entry, draft, paintStatus);
    renderAdvanced(root, entry, draft, paintStatus);
    root.append(statusBox);
    paintViewer(draft);
  }

  function renderProductRow(
    root: HTMLElement,
    input: ModelSetupInput,
    paintStatus: (message: string) => void,
  ): void {
    // A lone scope needs no selector: the row + hint stay hidden so normal
    // single-product setup is simpler. The station-level "Show product
    // buttons" checkbox is separate and untouched.
    if (input.products.length <= 1) return;
    const row = el('div', 'product-row', 'model-setup-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Setup product');
    const isActiveEntry = (product: ModelSetupProduct): boolean =>
      product.productId === input.activeProductId &&
      (product.variantId ?? null) === (input.activeVariantId ?? null);
    for (const product of input.products) {
      const button = el('button', 'product-button', 'btn-secondary');
      button.type = 'button';
      button.textContent = product.productName !== '' ? product.productName : product.productId;
      button.setAttribute('aria-pressed', isActiveEntry(product) ? 'true' : 'false');
      if (isActiveEntry(product)) button.classList.add('is-selected');
      button.addEventListener('click', () => {
        armed = null;
        if (!isActiveEntry(product)) {
          try {
            callbacks.onSelectProduct?.(product.productId, product.variantId);
          } catch {
            return;
          }
        }
        paintStatus(
          `Staged setup for other scopes is kept — now editing “${button.textContent}”.`,
        );
        try {
          callbacks.onChange(snapshotOf(product.productId, product.variantId ?? null, draftFor(product.productId, product.variantId ?? null)));
        } catch {
          return;
        }
        refresh();
      });
      row.append(button);
    }
    const hint = el('p', 'product-hint', 'model-setup-hint muted');
    hint.textContent = 'Switching scopes keeps every staged reference and area — nothing is discarded.';
    root.append(row, hint);
  }

  function renderReference(
    root: HTMLElement,
    entry: ModelSetupProduct,
    draft: ProductDraft,
    paintStatus: (message: string) => void,
  ): void {
    const section = el('section', 'reference-section', '');
    const title = document.createElement('h4');
    title.textContent = 'Reference distance (two surface picks + real millimetres)';
    section.append(title);
    const intro = el('p', 'reference-intro', 'muted');
    intro.textContent =
      'Click two distinct points on the model surface (A, then B), enter their real distance, and fit the uniform scale. Straight-line chord — not a surface arc.';
    section.append(intro);

    const row = el('div', 'reference-row', 'model-setup-row');
    const pickA = el('button', 'ref-pick-a', 'btn-secondary');
    pickA.type = 'button';
    pickA.textContent = armed === 'refA' ? 'Click point A on the model… (Esc cancels)' : 'Pick A on model';
    pickA.setAttribute('aria-pressed', armed === 'refA' ? 'true' : 'false');
    pickA.addEventListener('click', () => {
      armed = armed === 'refA' ? null : 'refA';
      paintStatus(
        armed === 'refA'
          ? 'Armed: click point A directly on the 3D surface. Drags and misses are ignored.'
          : 'Pick cancelled.',
      );
      refresh();
    });
    const pickB = el('button', 'ref-pick-b', 'btn-secondary');
    pickB.type = 'button';
    pickB.textContent = armed === 'refB' ? 'Click point B on the model… (Esc cancels)' : 'Pick B on model';
    pickB.setAttribute('aria-pressed', armed === 'refB' ? 'true' : 'false');
    pickB.addEventListener('click', () => {
      armed = armed === 'refB' ? null : 'refB';
      paintStatus(
        armed === 'refB'
          ? 'Armed: click point B directly on the 3D surface. Drags and misses are ignored.'
          : 'Pick cancelled.',
      );
      refresh();
    });
    row.append(pickA, pickB);
    section.append(row);

    const form = el('div', 'reference-form', 'model-setup-row');
    const mmLabel = document.createElement('label');
    mmLabel.className = 'model-setup-field';
    mmLabel.textContent = 'Real A→B distance (mm)';
    const mmInput = document.createElement('input');
    mmInput.type = 'number';
    mmInput.min = '0';
    mmInput.step = 'any';
    mmInput.placeholder = 'e.g. 470';
    mmInput.value = draft.distanceMmRaw;
    mmInput.setAttribute(HOOK, 'ref-mm');
    mmInput.setAttribute('aria-label', 'Real distance between A and B in millimetres');
    mmInput.addEventListener('input', () => {
      draft.distanceMmRaw = mmInput.value;
      if (draft.fitted) {
        draft.fitStale = true;
        for (const area of draft.areas) area.status = 'stale';
      }
    });
    mmInput.addEventListener('change', () => {
      // Blur/change fires synchronously inside a trusted click's
      // mousedown→mouseup window (the click first moves focus here): a
      // re-render now would detach the pressed button and swallow the click
      // — for mouse users too, not just automation. State above is already
      // current from `input` events, so repaint ONLY when visible state
      // actually transitioned.
      const wasStale = draft.fitStale;
      const wasAreasStale = draft.areas.some((area) => area.status === 'stale');
      draft.distanceMmRaw = mmInput.value;
      if (draft.fitted) {
        draft.fitStale = true;
        for (const area of draft.areas) area.status = 'stale';
      }
      const visibleChanged =
        draft.fitStale !== wasStale ||
        draft.areas.some((area) => area.status === 'stale') !== wasAreasStale;
      if (!visibleChanged) return;
      paintStatus('Millimetre entry changed — re-fit below. Dependent areas are marked stale until recomputed.');
      emit(entry, draft);
      refresh();
    });
    mmLabel.append(mmInput);
    form.append(mmLabel);
    section.append(form);

    const actions = el('div', 'reference-actions', 'model-setup-actions');
    const fit = el('button', 'ref-fit', 'btn-primary');
    fit.type = 'button';
    fit.textContent = draft.fitted ? 'Re-fit scale' : 'Fit scale';
    fit.addEventListener('click', () => {
      const lengthMm = Number(draft.distanceMmRaw);
      if (!draft.refA || !draft.refB) {
        paintStatus('Pick both A and B on the model surface before fitting.');
        refresh();
        return;
      }
      const span: ReferenceSpan = {
        id: 'model-ref',
        a: { ...draft.refA },
        b: { ...draft.refB },
        lengthMm,
      };
      const reason = validateReferenceSpan(span);
      if (reason !== null) {
        paintStatus(`Reference refused: ${reason}.`);
        refresh();
        return;
      }
      const outcome = fitScaleFromReferences([span]);
      if (!outcome.ok) {
        paintStatus(`Scale not fitted: ${outcome.error}. Your picks are intact — fix the entry and fit again.`);
        refresh();
        return;
      }
      const native = spanNativeDistance(span) ?? 0;
      draft.fitted = { mmPerUnit: outcome.mmPerUnit, nativeDistance: native, lengthMm };
      draft.fitStale = false;
      for (const area of draft.areas) area.status = 'stale';
      paintStatus(
        draft.areas.length > 0
          ? `Scale fitted: 1 model unit = ${formatMm(outcome.mmPerUnit)} mm. ${draft.areas.length} area(s) marked stale — recompute them explicitly below.`
          : `Scale fitted: 1 model unit = ${formatMm(outcome.mmPerUnit)} mm. Pending review, not production-approved.`,
      );
      emit(entry, draft);
      refresh();
    });
    const clear = el('button', 'ref-clear', 'btn-secondary');
    clear.type = 'button';
    clear.textContent = 'Clear reference';
    clear.addEventListener('click', () => {
      draft.refA = null;
      draft.refB = null;
      draft.distanceMmRaw = '';
      draft.fitted = null;
      draft.fitStale = false;
      for (const area of draft.areas) area.status = 'stale';
      armed = null;
      paintStatus('Reference cleared. Dependent areas are marked stale until recomputed.');
      emit(entry, draft);
      refresh();
    });
    actions.append(fit, clear);
    section.append(actions);

    const scale = el('p', 'reference-scale', 'muted');
    if (draft.fitted) {
      const stale = draft.fitStale ? ' (stale — reference edited, re-fit)' : '';
      scale.textContent =
        `Chord A→B: ${formatNative(draft.fitted.nativeDistance)} units · ` +
        `entered ${formatMm(draft.fitted.lengthMm)} mm · ` +
        `scale 1 unit = ${formatMm(draft.fitted.mmPerUnit)} mm${stale}. ` +
        `Uniform scale only; one span cannot prove shape correctness.`;
    } else {
      scale.textContent = 'No scale fitted yet — areas stay uncalibrated until the reference above fits.';
    }
    section.append(scale);
    root.append(section);
  }

  function renderAreas(
    root: HTMLElement,
    entry: ModelSetupProduct,
    draft: ProductDraft,
    paintStatus: (message: string) => void,
  ): void {
    const section = el('section', 'areas-section', '');
    const title = document.createElement('h4');
    title.textContent = 'Named safe areas on the model';
    section.append(title);
    const intro = el('p', 'areas-intro', 'muted');
    intro.textContent =
      'Each area is a polygon of surface picks; its polygon establishes the region plane. No default polygon is invented. Editing or recalibrating the reference marks areas stale — recompute them explicitly.';
    section.append(intro);

    const form = el('div', 'areas-form', 'model-setup-row');
    const nameLabel = document.createElement('label');
    nameLabel.className = 'model-setup-field';
    nameLabel.textContent = 'Area name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'e.g. Left chest';
    nameInput.autocomplete = 'off';
    nameInput.value = draft.drawing ? draft.drawingName : '';
    nameInput.setAttribute(HOOK, 'area-name');
    nameInput.setAttribute('aria-label', 'Safe-area name');
    nameInput.addEventListener('input', () => {
      draft.drawingName = nameInput.value;
    });
    nameLabel.append(nameInput);
    form.append(nameLabel);
    section.append(form);

    const actions = el('div', 'areas-actions', 'model-setup-actions');
    const start = el('button', 'area-start', 'btn-secondary');
    start.type = 'button';
    start.textContent = draft.drawing ? `Adding points… (${draft.drawing.length} picked, Esc cancels)` : 'Start area (click surface points)';
    start.disabled = draft.drawing !== null;
    start.addEventListener('click', () => {
      draft.drawing = [];
      draft.drawingName = nameInput.value;
      armed = 'areaPoint';
      paintStatus('Drawing: click at least 3 surface points on the model, then Finish area.');
      refresh();
    });
    const finish = el('button', 'area-finish', 'btn-primary');
    finish.type = 'button';
    finish.textContent = 'Finish area';
    finish.disabled = draft.drawing === null;
    finish.addEventListener('click', () => {
      const points = draft.drawing ?? [];
      const name = (draft.drawingName || nameInput.value).trim();
      if (points.length < 3) {
        paintStatus(`Pick at least 3 surface points for “${name || 'the area'}” (have ${points.length}).`);
        refresh();
        return;
      }
      if (draft.areas.some((a) => a.name.trim().toLowerCase() === name.toLowerCase() && name !== '')) {
        paintStatus(`Another area is already called “${name}” — choose a distinct name.`);
        refresh();
        return;
      }
      const existingIds = draft.areas.map((a) => a.id);
      const savedId = newAreaId();
      const reason = checkModelSafeArea(
        savedId,
        name,
        points.map((p) => ({ ...p })),
        existingIds,
        draft.fitted && !draft.fitStale ? draft.fitted.mmPerUnit : null,
      );
      if (reason !== null) {
        paintStatus(reason);
        refresh();
        return;
      }
      draft.areas.push({
        id: savedId,
        name: name.trim(),
        points: points.map((p) => ({ ...p })),
        status: draft.fitted && !draft.fitStale ? 'current' : 'stale',
      });
      draft.selectedAreaId = savedId;
      draft.drawing = null;
      draft.drawingName = '';
      armed = null;
      paintStatus(
        draft.fitted && !draft.fitStale
          ? `Safe area “${name.trim()}” saved (${points.length} points, plane established). Pending review.`
          : `Safe area “${name.trim()}” saved (${points.length} points) but the reference is uncalibrated — fit the scale, then recompute.`,
      );
      emit(entry, draft);
      refresh();
    });
    const cancel = el('button', 'area-cancel', 'btn-secondary');
    cancel.type = 'button';
    cancel.textContent = 'Cancel drawing';
    cancel.disabled = draft.drawing === null;
    cancel.addEventListener('click', () => {
      draft.drawing = null;
      armed = null;
      paintStatus('Drawing cancelled; nothing was committed.');
      refresh();
    });
    actions.append(start, finish, cancel);
    section.append(actions);

    const list = el('div', 'area-list', 'model-setup-list');
    if (draft.areas.length === 0) {
      const empty = el('p', 'area-empty', 'muted');
      empty.textContent = 'No safe areas yet.';
      list.append(empty);
    }
    for (const area of draft.areas) {
      const row = el('div', 'area-row', 'model-setup-row');
      const select = el('button', 'area-select', 'btn-secondary');
      select.type = 'button';
      const mmNote =
        draft.fitted && !draft.fitStale
          ? ` · longest chord ${formatMm(longestChord(area.points) * draft.fitted.mmPerUnit)} mm`
          : '';
      select.textContent = `${draft.selectedAreaId === area.id ? '● ' : '○ '}${area.name} (${area.points.length} pts${area.status === 'stale' ? ', stale' : ''}${mmNote})`;
      select.setAttribute('aria-pressed', draft.selectedAreaId === area.id ? 'true' : 'false');
      select.addEventListener('click', () => {
        draft.selectedAreaId = area.id;
        paintStatus(
          area.status === 'stale'
            ? `Selected “${area.name}” — stale: recompute after the current calibration.`
            : `Selected “${area.name}”.`,
        );
        refresh();
      });
      const remove = el('button', 'area-delete', 'btn-secondary');
      remove.type = 'button';
      remove.textContent = `Delete “${area.name}”`;
      remove.setAttribute('aria-label', `Delete safe area ${area.name}`);
      remove.addEventListener('click', () => {
        draft.areas = draft.areas.filter((a) => a.id !== area.id);
        if (draft.selectedAreaId === area.id) draft.selectedAreaId = null;
        paintStatus(`Safe area “${area.name}” deleted. Other areas and the reference are untouched.`);
        emit(entry, draft);
        refresh();
      });
      row.append(select, remove);
      list.append(row);
    }
    section.append(list);

    const recompute = el('button', 'areas-recompute', 'btn-secondary');
    recompute.type = 'button';
    const staleCount = draft.areas.filter((a) => a.status === 'stale').length;
    recompute.textContent = `Recompute ${staleCount} stale area(s) under current calibration`;
    recompute.disabled = staleCount === 0 || draft.fitted === null || draft.fitStale;
    recompute.addEventListener('click', () => {
      if (!draft.fitted || draft.fitStale) {
        paintStatus('Fit the reference scale first — stale areas cannot recompute against a stale fit.');
        refresh();
        return;
      }
      let ok = 0;
      const mmPerUnit = draft.fitted.mmPerUnit;
      for (const area of draft.areas) {
        if (area.status !== 'stale') continue;
        const others = draft.areas.filter((a) => a.id !== area.id).map((a) => a.id);
        const reason = checkModelSafeArea(area.id, area.name, area.points, others, mmPerUnit);
        if (reason === null) {
          area.status = 'current';
          ok += 1;
        }
      }
      paintStatus(
        ok > 0
          ? `${ok} area(s) recomputed under 1 unit = ${formatMm(draft.fitted.mmPerUnit)} mm and marked current. Pending review.`
          : 'No stale area could be recomputed — re-pick degenerate polygons.',
      );
      emit(entry, draft);
      refresh();
    });
    section.append(recompute);
    root.append(section);
  }

  function renderToggles(
    root: HTMLElement,
    entry: ModelSetupProduct,
    draft: ProductDraft,
    paintStatus: (message: string) => void,
  ): void {
    const section = el('section', 'toggles-section', '');
    const title = document.createElement('h4');
    title.textContent = 'Visibility (display only — staged data is always kept)';
    section.append(title);
    const row = el('div', 'toggles-row', 'model-setup-row');
    const anchors = el('button', 'toggle-anchors', 'btn-secondary');
    anchors.type = 'button';
    anchors.textContent = draft.anchorsVisible ? 'Hide anchors' : 'Show anchors';
    anchors.setAttribute('aria-pressed', draft.anchorsVisible ? 'true' : 'false');
    anchors.addEventListener('click', () => {
      draft.anchorsVisible = !draft.anchorsVisible;
      paintStatus(draft.anchorsVisible ? 'Anchors shown. Staged picks are unchanged.' : 'Anchors hidden. Staged picks are kept.');
      emit(entry, draft);
      refresh();
    });
    const safe = el('button', 'toggle-safe', 'btn-secondary');
    safe.type = 'button';
    safe.textContent = draft.safeAreasVisible ? 'Hide safe areas' : 'Show safe areas';
    safe.setAttribute('aria-pressed', draft.safeAreasVisible ? 'true' : 'false');
    safe.addEventListener('click', () => {
      draft.safeAreasVisible = !draft.safeAreasVisible;
      paintStatus(draft.safeAreasVisible ? 'Safe areas shown. Staged polygons are unchanged.' : 'Safe areas hidden. Staged polygons are kept.');
      emit(entry, draft);
      refresh();
    });
    const product = el('button', 'toggle-product', 'btn-secondary');
    product.type = 'button';
    product.textContent = draft.productVisible ? 'Hide product' : 'Show product';
    product.setAttribute('aria-pressed', draft.productVisible ? 'true' : 'false');
    product.addEventListener('click', () => {
      draft.productVisible = !draft.productVisible;
      paintStatus(draft.productVisible ? 'Product shown. Staged reference and areas are unchanged.' : 'Product hidden (geometry only — overlays, camera and staged data are kept). Surface picking is blocked until shown again.');
      emit(entry, draft);
      refresh();
    });
    row.append(anchors, safe, product);
    section.append(row);
    root.append(section);
  }

  /**
   * Advanced disclosure (collapsed by default): the standalone setup-JSON
   * download/import plus the raw A/B coordinate readout. Normal setup stays
   * simple — reference/scale feedback, areas, toggles and the master save
   * (station-level, primary) are outside. All hooks are unchanged, so
   * selectors keep working; disclosure content stays in the DOM when closed.
   */
  function renderAdvanced(
    root: HTMLElement,
    entry: ModelSetupProduct,
    draft: ProductDraft,
    paintStatus: (message: string) => void,
  ): void {
    const details = document.createElement('details');
    details.setAttribute(HOOK, 'advanced-setup');
    // Refreshes rebuild this panel: keep the operator's open/closed choice.
    details.open = advancedOpen;
    details.addEventListener('toggle', () => {
      advancedOpen = details.open;
    });
    const summary = document.createElement('summary');
    summary.setAttribute(HOOK, 'advanced-summary');
    summary.textContent = 'Advanced: setup file & raw coordinates';
    details.append(summary);
    const readout = el('p', 'reference-readout', 'muted');
    const aText = draft.refA ? `A (${formatNative(draft.refA.x)}, ${formatNative(draft.refA.y)}, ${formatNative(draft.refA.z)})` : 'A — not picked';
    const bText = draft.refB ? `B (${formatNative(draft.refB.x)}, ${formatNative(draft.refB.y)}, ${formatNative(draft.refB.z)})` : 'B — not picked';
    readout.textContent = `${aText} · ${bText}`;
    details.append(readout);
    renderSaveRestore(details, entry, draft, paintStatus);
    root.append(details);
  }

  function renderSaveRestore(
    root: HTMLElement,
    entry: ModelSetupProduct,
    draft: ProductDraft,
    paintStatus: (message: string) => void,
  ): void {
    const section = el('section', 'persist-section', '');
    const title = document.createElement('h4');
    title.textContent = 'Save / reopen this setup';
    section.append(title);
    const row = el('div', 'persist-row', 'model-setup-actions');
    const save = el('button', 'setup-save', 'btn-secondary');
    save.type = 'button';
    save.textContent = 'Download setup JSON';
    save.addEventListener('click', () => {
      try {
        const text = serializeSetup(entry, draft);
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${entry.productId}-model-setup.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        paintStatus('Setup downloaded (deterministic JSON, always pending review). Reopen it with the file picker below.');
      } catch (error) {
        paintStatus(`Download failed: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`);
      }
    });
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.setAttribute(HOOK, 'setup-restore-file');
    file.setAttribute('aria-label', 'Choose a previously downloaded setup JSON file');
    const restore = el('button', 'setup-restore', 'btn-secondary');
    restore.type = 'button';
    restore.textContent = 'Reopen downloaded setup';
    restore.addEventListener('click', () => {
      const picked = file.files !== null && file.files.length > 0 ? file.files[0] : null;
      if (!picked) {
        paintStatus('Choose a previously downloaded setup JSON file first.');
        return;
      }
      if (picked.size > 1048576) {
        paintStatus('That file exceeds 1 MiB — choose the setup JSON this panel downloaded.');
        return;
      }
      restore.disabled = true;
      void picked.text().then(
        (text) => {
          restore.disabled = false;
          const outcome = restoreSetup(entry, draft, text);
          paintStatus(outcome.message);
          if (outcome.ok) emit(entry, draft);
          refresh();
        },
        (error: unknown) => {
          restore.disabled = false;
          paintStatus(`Could not read that file (${error instanceof Error ? error.message : String(error)}). Current setup kept.`);
          refresh();
        },
      );
    });
    row.append(save, file, restore);
    section.append(row);
    const note = el('p', 'persist-note', 'muted');
    const input = getInput();
    note.textContent =
      input.assetKey === null
        ? 'No asset identity supplied: reopened setups are NOT hash-bound to this model — verify the model before use.'
        : 'Reopen requires the identical model asset key; the imported fit is always recomputed locally, never trusted.';
    section.append(note);
    root.append(section);
  }

  /** Serialize one product's staged setup deterministically (stable key order). */
  function serializeSetup(entry: ModelSetupProduct, draft: ProductDraft): string {
    const input = getInput();
    const payload: Record<string, unknown> = {
      version: MODEL_SETUP_VERSION,
      productId: entry.productId,
      variantId: entry.variantId ?? null,
      assetKey: input.assetKey,
      reference:
        draft.refA && draft.refB
          ? {
              id: 'model-ref',
              a: { x: draft.refA.x, y: draft.refA.y, z: draft.refA.z },
              b: { x: draft.refB.x, y: draft.refB.y, z: draft.refB.z },
              lengthMm: Number(draft.distanceMmRaw),
            }
          : null,
      fit: draft.fitted
        ? { mmPerUnit: draft.fitted.mmPerUnit, nativeDistance: draft.fitted.nativeDistance }
        : null,
      areas: [...draft.areas]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((area) => ({
          id: area.id,
          name: area.name,
          points: area.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
          status: area.status,
        })),
      flags: { pendingReview: true, productionApproved: false },
    };
    return JSON.stringify(payload, null, 2);
  }

  /** Restore a downloaded setup into the draft; imported fit is recomputed, never trusted. */
  function restoreSetup(
    entry: ModelSetupProduct,
    draft: ProductDraft,
    text: string,
  ): { ok: boolean; message: string } {
    if (text.length > 1048576) {
      return { ok: false, message: 'That file exceeds 1 MiB — current setup kept.' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, message: 'That file is not valid JSON — current setup kept.' };
    }
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, message: 'That file is not a model-setup export — current setup kept.' };
    }
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== MODEL_SETUP_VERSION) {
      return { ok: false, message: 'That file is a different setup version — current setup kept.' };
    }
    if (record['productId'] !== entry.productId) {
      return { ok: false, message: 'That setup belongs to a different product — current setup kept.' };
    }
    if ((record['variantId'] ?? null) !== (entry.variantId ?? null)) {
      return { ok: false, message: 'That setup belongs to a different variant scope — current setup kept.' };
    }
    const input = getInput();
    const fileKey = typeof record['assetKey'] === 'string' || record['assetKey'] === null ? record['assetKey'] : undefined;
    if (fileKey === undefined) return { ok: false, message: 'That file has no asset binding — current setup kept.' };
    if (input.assetKey !== null && fileKey !== input.assetKey) {
      return { ok: false, message: 'That setup was saved against a different model — current setup kept.' };
    }
    const reference = record['reference'];
    let refA: SetupVec3 | null = null;
    let refB: SetupVec3 | null = null;
    let lengthMm = 0;
    if (reference !== null) {
      if (reference === null || typeof reference !== 'object') {
        return { ok: false, message: 'That file has a malformed reference — current setup kept.' };
      }
      const ref = reference as Record<string, unknown>;
      if (!isVec3(ref['a']) || !isVec3(ref['b']) || typeof ref['lengthMm'] !== 'number') {
        return { ok: false, message: 'That file has a malformed reference — current setup kept.' };
      }
      refA = { x: ref['a'].x, y: ref['a'].y, z: ref['a'].z };
      refB = { x: ref['b'].x, y: ref['b'].y, z: ref['b'].z };
      lengthMm = ref['lengthMm'];
      const span: ReferenceSpan = {
        id: typeof ref['id'] === 'string' && ref['id'] !== '' ? ref['id'] : 'model-ref',
        a: refA,
        b: refB,
        lengthMm,
      };
      const reason = validateReferenceSpan(span);
      if (reason !== null) {
        return { ok: false, message: 'That file has an invalid reference span — current setup kept.' };
      }
    }
    const rawAreas = record['areas'];
    if (!Array.isArray(rawAreas) || rawAreas.length > 64) {
      return { ok: false, message: 'That file has malformed safe areas — current setup kept.' };
    }
    interface ParsedArea {
      id: string;
      name: string;
      points: SetupVec3[];
    }
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    const parsedAreas: ParsedArea[] = [];
    for (const rawArea of rawAreas) {
      if (rawArea === null || typeof rawArea !== 'object') {
        return { ok: false, message: 'That file has a malformed safe area — current setup kept.' };
      }
      const item = rawArea as Record<string, unknown>;
      if (typeof item['id'] !== 'string' || typeof item['name'] !== 'string' || !Array.isArray(item['points'])) {
        return { ok: false, message: 'That file has a malformed safe area — current setup kept.' };
      }
      const rawPoints = item['points'] as unknown[];
      if (rawPoints.length < 3 || rawPoints.length > 512) {
        return { ok: false, message: `That file has an unusable area (“${item['name']}”) — current setup kept.` };
      }
      const points: SetupVec3[] = [];
      for (const raw of rawPoints) {
        if (!isVec3(raw)) {
          return { ok: false, message: `That file has an unusable area (“${item['name']}”) — current setup kept.` };
        }
        points.push({ x: raw.x, y: raw.y, z: raw.z });
      }
      if (planeFromPolygon(points) === null) {
        return { ok: false, message: `That file has an unusable area (“${item['name']}”) — current setup kept.` };
      }
      if (seenIds.has(item['id'])) {
        return { ok: false, message: `That file repeats the area id (“${item['id']}”) — current setup kept.` };
      }
      seenIds.add(item['id']);
      const lowered = item['name'].trim().toLowerCase();
      if (seenNames.has(lowered)) {
        return { ok: false, message: `That file repeats the area name “${item['name']}” — current setup kept.` };
      }
      seenNames.add(lowered);
      parsedAreas.push({ id: item['id'], name: item['name'].trim(), points });
    }
    // Recompute the fit locally (imported fit is never trusted), then run
    // the kernel ring check on every area in millimetres. Nothing commits
    // until every record validates.
    let fitted: SetupScaleFit | null = null;
    if (refA && refB) {
      const span: ReferenceSpan = { id: 'model-ref', a: refA, b: refB, lengthMm };
      const outcome = fitScaleFromReferences([span]);
      if (outcome.ok) {
        fitted = {
          mmPerUnit: outcome.mmPerUnit,
          nativeDistance: spanNativeDistance(span) ?? 0,
          lengthMm,
        };
      }
    }
    const areas: DraftArea[] = [];
    for (const parsed of parsedAreas) {
      const others = parsedAreas.filter((a) => a.id !== parsed.id).map((a) => a.id);
      const reason = checkModelSafeArea(
        parsed.id,
        parsed.name,
        parsed.points,
        others,
        fitted ? fitted.mmPerUnit : null,
      );
      if (reason !== null) {
        return { ok: false, message: `That file has an unusable area (“${parsed.name}”) — current setup kept.` };
      }
      areas.push({ id: parsed.id, name: parsed.name, points: parsed.points, status: 'stale' });
    }
    // Commit atomically: references, locally recomputed fit, areas as stale.
    draft.refA = refA;
    draft.refB = refB;
    draft.distanceMmRaw = reference !== null ? String(lengthMm) : '';
    draft.fitted = fitted;
    draft.fitStale = false;
    draft.areas = areas;
    draft.selectedAreaId = areas.length > 0 && areas[0] !== undefined ? areas[0].id : null;
    draft.drawing = null;
    draft.drawingName = '';
    armed = null;
    const keptFit = draft.fitted ? ` Reference and scale recomputed locally (1 unit = ${formatMm(draft.fitted.mmPerUnit)} mm).` : '';
    return {
      ok: true,
      message: `Setup reopened: reference, ${areas.length} area(s) retained as stale — recompute them explicitly.${keptFit} Still pending review.`,
    };
  }

  function longestChord(points: readonly SetupVec3[]): number {
    let best = 0;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        if (a === undefined || b === undefined) continue;
        const d = chordNative(a, b);
        if (d > best) best = d;
      }
    }
    return best;
  }

  function onCanvasDown(event: PointerEvent): void {
    if (destroyed || event.button !== 0) return;
    // Gate on the LIVE canvas (the lead replaces the canvas per viewer
    // attach, so a captured element would go stale).
    if (event.target !== canvasOf()) return;
    downAt = { x: event.clientX, y: event.clientY, button: event.button };
  }

  function onCanvasUp(event: PointerEvent): void {
    if (destroyed) return;
    if (event.target !== canvasOf()) return;
    const down = downAt;
    downAt = null;
    if (armed === null || down === null || event.button !== 0) return;
    const travel = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (!(travel <= 6) || !Number.isFinite(travel)) return;
    const resolved = currentDraft();
    if ('error' in resolved) return;
    const { entry, draft } = resolved;
    const viewer = viewerOf();
    if (!viewer) return;
    // Hidden product blocks surface picking clearly: the raycast target is
    // invisible, so any hit would be a guess — refuse with a route instead.
    // Reference, areas, fit and overlays are untouched; showing the product
    // resumes picking exactly where it left off.
    if (!draft.productVisible) {
      lastStatus = 'Product hidden — show the product to pick surface points. Staged reference and areas are unchanged.';
      refresh();
      return;
    }
    const hit = viewer.pickSurfaceFromEvent(event);
    if (!hit) {
      lastStatus = 'That click missed the model surface — nothing was recorded. Orbit and click the surface itself.';
      refresh();
      return;
    }
    const point: SetupVec3 = { x: hit.modelPosition.x, y: hit.modelPosition.y, z: hit.modelPosition.z };
    if (!isVec3(point)) {
      lastStatus = 'That pick produced no usable surface position — try again.';
      refresh();
      return;
    }
    if (armed === 'refA' || armed === 'refB') {
      const which = armed;
      if (which === 'refA') draft.refA = point;
      else draft.refB = point;
      if (draft.fitted) {
        draft.fitStale = true;
        for (const area of draft.areas) area.status = 'stale';
      }
      armed = which === 'refA' ? 'refB' : null;
      lastStatus =
        which === 'refA'
          ? `Point A recorded (${formatNative(point.x)}, ${formatNative(point.y)}, ${formatNative(point.z)}). Now pick B, or press Escape.`
          : `Point B recorded (${formatNative(point.x)}, ${formatNative(point.y)}, ${formatNative(point.z)}). Enter millimetres and fit.`;
      emit(entry, draft);
      refresh();
      return;
    }
    if (armed === 'areaPoint') {
      if (!draft.drawing) draft.drawing = [];
      draft.drawing.push(point);
      lastStatus = `Area point ${draft.drawing.length} recorded on the surface. Finish at 3 or more.`;
      emit(entry, draft);
      refresh();
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (destroyed || event.key !== 'Escape') return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (armed !== null) {
      armed = null;
      lastStatus = 'Pick cancelled — staged data unchanged.';
      refresh();
    }
  }

  // Document-level pointer gating (see onCanvasDown): survives the lead's
  // per-attach canvas replacement, unlike element-bound listeners.
  document.addEventListener('pointerdown', onCanvasDown);
  document.addEventListener('pointerup', onCanvasUp);
  document.addEventListener('keydown', onKeyDown);

  return {
    refresh,
    hydrateFromJson(text: string): { ok: boolean; message: string } {
      if (destroyed) return { ok: false, message: 'Setup view is closed.' };
      const resolved = currentDraft();
      if ('error' in resolved) return { ok: false, message: resolved.error };
      const outcome = restoreSetup(resolved.entry, resolved.draft, text);
      if (outcome.ok) emit(resolved.entry, resolved.draft);
      lastStatus = outcome.message;
      refresh();
      return outcome;
    },
    destroy(): void {
      destroyed = true;
      armed = null;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onCanvasDown);
      document.removeEventListener('pointerup', onCanvasUp);
      container.replaceChildren();
    },
  };
}
