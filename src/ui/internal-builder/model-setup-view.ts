import { formatMeasurement, unusualCalibrationReference } from './measurement-display.js';
import { planeFromPolygon, projectAreaToMm } from '../../core/model-placement/area-projection.js';
export { planeFromPolygon, projectAreaToMm } from '../../core/model-placement/area-projection.js';
import { createCanvasContextPanel } from './canvas-context-panel.js';
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
 * Region plane from one verified surface pick plus its real mesh face
 * normal (native units): the normal comes from the raycast triangle, never
 * from fitted sample geometry, so a straight drag chord on a flat model
 * yields a valid plane instead of a collinear rejection. The in-plane frame
 * is deterministic from the normal alone (least-aligned world axis), never
 * from the drag direction — the drag only supplies the box diagonal, so a
 * drag-aligned frame (which would collapse every box) is never built. When
 * the normal is degenerate, returns null. Pure.
 */
export function planeFromPointNormal(
  origin: SetupVec3,
  normal: SetupVec3,
): SetupRegionPlane | null {
  if (!isVec3(origin) || !isVec3(normal)) return null;
  const normalLength = norm3(normal);
  if (!Number.isFinite(normalLength) || !(normalLength > 1e-12)) return null;
  const unit: SetupVec3 = {
    x: normal.x / normalLength,
    y: normal.y / normalLength,
    z: normal.z / normalLength,
  };
  // Deterministic in-plane xDir: perpendicular to the normal via the
  // least-aligned world axis. Fixed for a given face, independent of any
  // drag, so the diagonal box below spans area for every non-axis-aligned
  // drag (axis-aligned drags are refused with a re-drag message).
  const ax = Math.abs(unit.x);
  const ay = Math.abs(unit.y);
  const az = Math.abs(unit.z);
  const fallback =
    ax <= ay && ax <= az
      ? { x: 1, y: 0, z: 0 }
      : ay <= az
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
  const inPlane = cross3(unit, fallback);
  const inPlaneLength = norm3(inPlane);
  if (!Number.isFinite(inPlaneLength) || !(inPlaneLength > 1e-12)) return null;
  const xDir: SetupVec3 = {
    x: inPlane.x / inPlaneLength,
    y: inPlane.y / inPlaneLength,
    z: inPlane.z / inPlaneLength,
  };
  const yDir = cross3(unit, xDir);
  if (!isVec3(yDir) || !(norm3(yDir) > 1e-12)) return null;
  return { origin: { ...origin }, normal: unit, xDir, yDir };
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

function dot3(a: SetupVec3, b: SetupVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/* ------------------------------------------------------------------ */
/* View-local gesture/shape math (bounded, planar, no invented points). */
/* ------------------------------------------------------------------ */

/** Discrete display-zoom steps (% of the fitted product view). */
const VIEW_ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300, 400] as const;

/** Click-vs-drag gate in CSS px (mirrors the viewer's surface-click rule). */
const CLICK_TRAVEL_PX = 6;

/** Polygon-point bound shared with the kernel ring check. */
const POLYGON_POINT_LIMIT = 512;

/**
 * Reference label text: `Enter distance` until a positive finite length is
 * entered, else e.g. `1,300 mm`. Grouping is manual (deterministic across
 * environments); the viewer renders the string verbatim and never invents it.
 */
export function formatReferenceLengthMm(lengthMm: number): string | null {
  if (typeof lengthMm !== 'number' || !Number.isFinite(lengthMm) || !(lengthMm > 0)) return null;
  const rounded = Math.round(lengthMm * 10) / 10;
  const parts = String(rounded).split('.');
  const int = (parts[0] ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.length > 1 ? `${int}.${parts[1]} mm` : `${int} mm`;
}

function referenceOverlayLabel(distanceMmRaw: string): string {
  return formatReferenceLengthMm(Number(distanceMmRaw)) ?? 'Enter distance';
}


interface PlaneBox2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function toPlane2D(point: SetupVec3, plane: SetupRegionPlane): { x: number; y: number } {
  const dx = point.x - plane.origin.x;
  const dy = point.y - plane.origin.y;
  const dz = point.z - plane.origin.z;
  return {
    x: dx * plane.xDir.x + dy * plane.xDir.y + dz * plane.xDir.z,
    y: dx * plane.yDir.x + dy * plane.yDir.y + dz * plane.yDir.z,
  };
}

function fromPlane2D(plane: SetupRegionPlane, x: number, y: number): SetupVec3 {
  return {
    x: plane.origin.x + plane.xDir.x * x + plane.yDir.x * y,
    y: plane.origin.y + plane.xDir.y * x + plane.yDir.y * y,
    z: plane.origin.z + plane.xDir.z * x + plane.yDir.z * y,
  };
}

function cornersFromBox(plane: SetupRegionPlane, box: PlaneBox2D): SetupVec3[] {
  return [
    fromPlane2D(plane, box.minX, box.minY),
    fromPlane2D(plane, box.maxX, box.minY),
    fromPlane2D(plane, box.maxX, box.maxY),
    fromPlane2D(plane, box.minX, box.maxY),
  ];
}

/**
 * Recognize a stored 4-corner ring as a rectangle: four finite points, right
 * angles and opposite sides within numeric roundoff ONLY (constructed
 * rectangles share exact values; hand picks never qualify, so corner edits
 * on general polygons never silently snap other vertices). Documented
 * tolerance for recognizing stored geometry. Editing never constrains a ring.
 */
export function isRectangleRing(points: readonly SetupVec3[]): boolean {
  if (!Array.isArray(points) || points.length !== 4) return false;
  for (const point of points) {
    if (!isVec3(point)) return false;
  }
  const corners = [points[0], points[1], points[2], points[3]];
  if (corners.some((corner) => corner === undefined)) return false;
  const [c0, c1, c2, c3] = corners as [SetupVec3, SetupVec3, SetupVec3, SetupVec3];
  const edges = [sub3(c1, c0), sub3(c2, c1), sub3(c3, c2), sub3(c0, c3)];
  const lengths = edges.map(norm3);
  if (lengths.some((length) => !Number.isFinite(length) || !(length > 1e-9))) return false;
  for (let index = 0; index < 4; index += 1) {
    const current = edges[index]!;
    const next = edges[(index + 1) % 4]!;
    const cosine = dot3(current, next) / (lengths[index]! * lengths[(index + 1) % 4]!);
    if (!Number.isFinite(cosine) || Math.abs(cosine) > 1e-9) return false;
  }
  const [a, b, c, d] = lengths as [number, number, number, number];
  if (Math.abs(a - c) / Math.max(a, c) > 1e-9) return false;
  if (Math.abs(b - d) / Math.max(b, d) > 1e-9) return false;
  return true;
}

/** Max absolute deviation of samples from a plane (native units). */
function maxPlaneDeviation(points: readonly SetupVec3[], plane: SetupRegionPlane): number {
  let worst = 0;
  for (const point of points) {
    const deviation = Math.abs(
      (point.x - plane.origin.x) * plane.normal.x +
        (point.y - plane.origin.y) * plane.normal.y +
        (point.z - plane.origin.z) * plane.normal.z,
    );
    if (!Number.isFinite(deviation)) return Infinity;
    if (deviation > worst) worst = deviation;
  }
  return worst;
}

/** Screen-space distance from a point to a segment (CSS px). Pure. */
export function pointSegmentDistancePx(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0) || !Number.isFinite(len2)) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface CurveSample2D {
  x: number;
  y: number;
}

/**
 * Interior points of a screen-space quadratic bezier (endpoints excluded).
 * Pure: bending happens in screen space, then the caller raycasts every
 * sample against the live surface — only real surface picks enter stored
 * geometry, so persisted polygons never contain off-surface control points.
 */
export function sampleQuadraticBezier2D(
  a: CurveSample2D,
  control: CurveSample2D,
  b: CurveSample2D,
  interiorCount: number,
): CurveSample2D[] {
  const bounded = Math.max(1, Math.min(32, Math.floor(interiorCount)));
  const out: CurveSample2D[] = [];
  for (let i = 1; i <= bounded; i += 1) {
    const t = i / (bounded + 1);
    const u = 1 - t;
    out.push({
      x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
    });
  }
  return out;
}

type AreaHandleRef = { areaId: string; kind: 'corner' | 'side'; index: number };

/**
 * Replace one independent vertex, or insert one surface pick after an edge.
 * Only real surface picks reach this function. The caller validates the new
 * polygon before replacing the last valid staged area.
 */
function geometryForHandleMove(
  areaPoints: readonly SetupVec3[],
  handle: AreaHandleRef,
  point: SetupVec3,
): SetupVec3[] | null {
  if (areaPoints.length < 3 || !isVec3(point) || handle.index < 0 || handle.index >= areaPoints.length) return null;
  const next = areaPoints.map((vertex) => ({ ...vertex }));
  if (handle.kind === 'corner') next[handle.index] = { ...point };
  else {
    if (next.length >= POLYGON_POINT_LIMIT) return null;
    next.splice(handle.index + 1, 0, { ...point });
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* View                                                               */
/* ------------------------------------------------------------------ */

/** Structural viewer surface this view needs (satisfied by ModelViewer). */
export interface ModelSetupViewerLike {
  pickSurface?(clientX: number, clientY: number): { modelPosition: SetupVec3 } | null;
  pickSurfaceFromEvent(event: { clientX: number; clientY: number }): { modelPosition: SetupVec3 } | null;
  setAnchorMarkers(anchors: Array<{ id: string; model: SetupVec3 }>): void;
  setSafeAreaOverlays(items: Array<{ id: string; pointsModel: SetupVec3[]; selected?: boolean }>): void;
  /**
   * Detailed pick with the real mesh face normal (wrapper-local). Optional
   * so older satisfies still compile; the view falls back to position-only
   * picks with an explicit surface-uncertainty message where normals are
   * required.
   */
  pickSurfaceDetailed?(clientX: number, clientY: number): { modelPosition: SetupVec3; normal: SetupVec3 } | null;
  /**
   * Project a wrapper-local model point to canvas client coords (CSS px).
   * Optional; the view falls back to an explicit unverifiable message where
   * surface verification is required.
   */
  projectToClient?(model: SetupVec3): { x: number; y: number } | null;
  setAnchorsVisible(visible: boolean): void;
  getAnchorsVisible(): boolean;
  setSafeAreasVisible(visible: boolean): void;
  getSafeAreasVisible(): boolean;
  setProductVisible(visible: boolean): void;
  getProductVisible(): boolean;
  /** Monotonic camera/viewport revision for overlay gating (optional). */
  getViewRevision?(): number;
  /**
   * Additive viewer controls (optional so older satisfies still compile).
   * Reference overlay renders the supplied label verbatim; zoom is
   * display/camera only; orbit suspends only around draw/edit gestures.
   */
  setReferenceOverlay?(ref: { a: SetupVec3; b: SetupVec3; label: string } | null): void;
  setZoomPercent?(pct: number): void;
  getZoomPercent?(): number;
  resetZoom?(): void;
  fitCurrentView?(): void;
  setViewSide?(side: 'front' | 'back' | 'left' | 'right'): void;
  setOrbitEnabled?(enabled: boolean): void;
  setInteractionMode?(mode: 'select' | 'pan'): void;
  /**
   * Camera-only focus for the selected safe area (optional): frames the
   * supplied wrapper-local polygon without touching mm, fit or history.
   * Returns false when unavailable (no model, degenerate points, or an
   * active gesture suspending orbit). Never throws.
   */
  focusSurfacePoints?(
    pointsModel: Array<{ x: number; y: number; z: number }>,
    normalModel?: { x: number; y: number; z: number },
  ): boolean;
  /**
   * Optional per-frame hook for projected HTML overlays (overlay-only).
   * The view sets/clears it as the live viewer attaches; the viewer never
   * depends on it.
   */
  onFrame?: (() => void) | null;
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
  /**
   * Lead-owned operator history: the committed-setup save path lives with
   * the lead caller (main.ts savebar), which owns the session mutation
   * boundary — this view only stages drafts and emits snapshots, so it
   * never calls this itself. Optional until the lead wires it.
   */
  pushHistory?(label: string): void;
}

export interface ModelSetupViewHandle {
  refresh(): void;
  setActive(active: boolean): void;
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

/** Polygon uses deliberate point clicks; rectangle creates a starting outline; edit reshapes the selected area on the model. */
type AreaTool = 'rotate' | 'edit' | 'freehand' | 'rectangle';

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
  areaTool: AreaTool;
  /** Armed polygon handle awaiting a surface pick (UI-only, never saved). */
  handleArm: AreaHandleRef | null;
  /**
   * Armed curve edge awaiting a bend commit (UI-only, never saved): bending
   * samples the visible surface and bakes plain polygon points — no curve or
   * tangent metadata is stored, so save/restore stays a pure point polygon.
   */
  curveArm: { areaId: string; edge: number } | null;
  /** Bend offset for the armed curve edge, in screen px (UI-only, never saved). */
  curveBendPx: number;
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
    areaTool: 'rotate',
    handleArm: null,
    curveArm: null,
    curveBendPx: 28,
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
  return formatMeasurement(value);
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
  options: { contextHost?: HTMLElement } = {},
): ModelSetupViewHandle {
  let destroyed = false;
  let active = true;
  let contextPanel: ReturnType<typeof createCanvasContextPanel> | null = null;
  let contextTask: 'measure' | 'areas' | 'more' = 'measure';
  const dismissedCalibrationWarnings = new Map<string, Set<number>>();
  let viewControlsOpen = false;
  let viewControls: HTMLElement | null = null;
  let viewToggle: HTMLButtonElement | null = null;
  const setViewControlsOpen = (open: boolean): void => {
    viewControlsOpen = open;
    viewControls?.classList.toggle('is-open', open);
    viewToggle?.setAttribute('aria-expanded', String(open));
  };
  const originalParent = container.parentElement;
  const originalNext = container.nextSibling;
  const applyContextTask = (): void => {
    if (!contextPanel) return;
    for (const child of container.querySelectorAll<HTMLElement>('.model-setup > *')) {
      const hook = child.getAttribute(HOOK);
      child.hidden = contextTask === 'measure' ? hook !== 'reference-section'
        : contextTask === 'areas' ? hook !== 'areas-section' : hook !== 'advanced';
    }
    if (contextTask === 'more') {
      const details = container.querySelector<HTMLDetailsElement>('[data-model-setup-hook="advanced"]');
      if (details) details.open = true;
    }
  };
  const openContext = (task: typeof contextTask): void => {
    setViewControlsOpen(false);
    contextTask = task; applyContextTask();
    contextPanel?.open(task === 'measure' ? 'Measure' : task === 'areas' ? 'Safe areas' : 'More setup options');
  };
  const mountContext = (): void => {
    if (!options.contextHost) return;
    const toolbar = document.querySelector<HTMLElement>('[data-model-setup-hook="viewbar"]'); if (!toolbar) return;
    if (!contextPanel) {
      contextPanel = createCanvasContextPanel({ host: options.contextHost, toolbar, id: 'model-context', label: 'Measure',
        onVisibilityChange: () => {
          const scope = currentDraft();
          if (!('error' in scope)) syncReferenceOverlay(scope.draft);
        },
      });
      contextPanel.content.append(container);
      contextPanel.trigger.setAttribute(HOOK, 'context-measure');
      contextPanel.trigger.addEventListener('click', () => openContext('measure'));
    }
    toolbar.prepend(contextPanel.trigger);
    for (const task of ['areas','more'] as const) {
      const button = el('button', `context-${task}`, 'btn-secondary'); button.type = 'button';
      button.textContent = task === 'areas' ? 'Areas' : 'More';
      button.setAttribute('aria-controls', contextPanel.element.id);
      button.addEventListener('click', () => openContext(task));
      (toolbar.querySelector('[data-model-setup-hook="camera-controls"]') ?? toolbar).append(button);
    }
    applyContextTask();
  };
  const syncOverflow = (): void => {
    container.toggleAttribute('data-more-controls', container.scrollHeight - container.clientHeight - container.scrollTop > 8);
  };
  const resizeObserver = new ResizeObserver(syncOverflow); resizeObserver.observe(container);
  container.addEventListener('scroll', syncOverflow, { passive: true });
  let armed: ArmTarget = null;
  let advancedOpen = false;
  let handleDetailsOpen = false;
  let curveDetailsOpen = false;
  let outlineAction: 'point' | 'curve' = 'point';
  let lastStatus = '';
  const drafts = new Map<string, ProductDraft>();
  let downAt: { x: number; y: number; button: number; pointerId: number } | null = null;
  /**
   * Live drag/edit preview in native coords (render-only): folded into the
   * safe-area overlays by paintViewer, discarded on release/cancel. Stored
   * polygons are only ever replaced by one explicit release commit.
   */
  let livePreview: SetupVec3[] | null = null;
  let drawingOutline: SVGSVGElement | null = null;
  let outlineSignature = '';
  let outlineDraft: ProductDraft | null = null;

  // Immediate display-only guide. It is never read back into saved geometry:
  // release still verifies actual surface picks through the existing resolver.
  const paintDrawingOutline = (points: SetupVec3[] | null, rectangle?: { x0: number; y0: number; x1: number; y1: number }): void => {
    const canvas = canvasOf();
    const stage = canvas?.parentElement;
    if (!canvas || !stage) return;
    const box = canvas.getBoundingClientRect();
    const projected = rectangle ? [
      { x: rectangle.x0, y: rectangle.y0 }, { x: rectangle.x1, y: rectangle.y0 },
      { x: rectangle.x1, y: rectangle.y1 }, { x: rectangle.x0, y: rectangle.y1 },
    ] : (points ?? []).map((point) => viewerOf()?.projectToClient?.(point) ?? null)
      .filter((point): point is { x: number; y: number } => point !== null);
    const signature = JSON.stringify([box.width, box.height, projected.map((point) => [point.x - box.left, point.y - box.top])]);
    if (signature === outlineSignature && drawingOutline?.parentElement === stage) {
      // Same coordinates, same stage: still restore visibility. The outline
      // may have been hidden during camera movement, deactivation or a mode
      // switch, and must reappear when repainted — not wait for new points.
      if (drawingOutline) drawingOutline.style.display = projected.length === 0 ? 'none' : '';
      return;
    }
    outlineSignature = signature;
    if (drawingOutline?.parentElement !== stage) {
      drawingOutline?.remove();
      drawingOutline = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      drawingOutline.setAttribute(HOOK, 'live-outline');
      drawingOutline.setAttribute('aria-label', 'Safe area drawing preview');
      drawingOutline.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
      stage.append(drawingOutline);
    }
    drawingOutline.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    drawingOutline.replaceChildren();
    drawingOutline.style.display = projected.length === 0 ? 'none' : '';
    if (projected.length === 0) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', projected.length >= 3 ? 'polygon' : 'polyline');
    line.setAttribute('points', projected.map((point) => `${point.x - box.left},${point.y - box.top}`).join(' '));
    line.setAttribute('fill', projected.length >= 3 ? 'rgba(0,114,206,.2)' : 'none');
    line.setAttribute('stroke', '#0072ce'); line.setAttribute('stroke-width', '2.5');
    drawingOutline.append(line);
    projected.forEach((point, index) => {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      dot.setAttribute('x', String(point.x - box.left - 4)); dot.setAttribute('y', String(point.y - box.top - 4));
      dot.setAttribute('width', '8'); dot.setAttribute('height', '8'); dot.setAttribute('fill', '#fff');
      dot.setAttribute('stroke', '#0072ce'); dot.setAttribute('stroke-width', '1.5'); group.append(dot);
      if (index === 0 && !rectangle) {
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        hit.setAttribute('x', String(point.x - box.left - 12)); hit.setAttribute('y', String(point.y - box.top - 12));
        hit.setAttribute('width', '24'); hit.setAttribute('height', '24'); hit.setAttribute('fill', 'transparent');
        hit.style.pointerEvents = 'all'; hit.style.cursor = 'pointer';
        hit.setAttribute(HOOK, 'drawing-close'); hit.setAttribute('role', 'button'); hit.setAttribute('tabindex', '0');
        hit.setAttribute('aria-label', 'Close polygon at first corner');
        const close = (event: Event): void => { event.preventDefault(); event.stopPropagation(); document.querySelector<HTMLButtonElement>('[data-model-setup-hook="area-finish"]')?.click(); };
        hit.addEventListener('click', close);
        hit.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') close(event); });
        group.append(hit);
      }
      drawingOutline!.append(group);
    });
  };
  /** Active canvas gesture (rectangle drag or independent corner drag). */
  let gesture:
    | { kind: 'rect'; entry: ModelSetupProduct; draft: ProductDraft; corner0: SetupVec3; normal0: SetupVec3 | null; misses: number; downX: number; downY: number }
    | { kind: 'handle'; entry: ModelSetupProduct; draft: ProductDraft; handle: AreaHandleRef }
    | null = null;
  /**
   * Pressed (not yet dragged) direct canvas handle: a press on a visible
   * projected handle suspends orbit at once; crossing CLICK_TRAVEL_PX turns
   * it into a `handle` gesture, release without travel arms it for
   * click-to-move. Escape/pointercancel roll it back with no commit.
   */
  let pendingHandle: { ref: AreaHandleRef; x: number; y: number } | null = null;
  /** Projected HTML handle overlay (corners + side midpoints), cached nodes. */
  let handleLayer: HTMLDivElement | null = null;
  let handleDots: HTMLDivElement[] = [];
  /** Live viewer currently carrying this view's frame hook (if any). */
  let framedViewer: ModelSetupViewerLike | null = null;
  /**
   * Camera-settle gating for the projected handle overlay (perf only).
   * The overlay hides immediately while the camera moves (no projection or
   * surface picks) and the expensive occlusion/pick pass runs once after
   * the camera settles. Stored mm, saved points and curved samples are
   * untouched; pointerdown still re-verifies against the live surface.
   */
  let lastFrameRevision = -1;
  let lastFrameDraftKey = '';
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while orbit is suspended for a draw/edit gesture (restored after). */
  let orbitSuspended = false;
  let panMode = false;
  /** Lead-provided viewbar mount fallback created inside the stage. */
  let ownedViewbar: HTMLElement | null = null;

  const suspendOrbit = (): void => {
    try {
      viewerOf()?.setOrbitEnabled?.(false);
      orbitSuspended = true;
    } catch {
      return;
    }
  };

  const restoreOrbit = (): void => {
    if (!orbitSuspended) return;
    orbitSuspended = false;
    try {
      viewerOf()?.setOrbitEnabled?.(true);
    } catch {
      return;
    }
  };

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
    outlineDraft = draft;
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
      // Reference connecting measurement: dashed A/B chord plus a midpoint
      // label. Missing endpoints clear it (stays incomplete); the label reads
      // `Enter distance` until a positive finite length is entered. Riding
      // the wrapper group, it follows camera/wrapper transforms.
      try {
        viewer.setReferenceOverlay?.(
          contextTask === 'measure' && (!options.contextHost || contextPanel?.isOpen() || armed === 'refA' || armed === 'refB') && draft.areaTool === 'rotate' && draft.refA !== null && draft.refB !== null
            ? {
                a: { ...draft.refA },
                b: { ...draft.refB },
                label: referenceOverlayLabel(draft.distanceMmRaw),
              }
            : null,
        );
      } catch {
        return;
      }
      const overlays = draft.areas.map((area) => ({
        id: area.id,
        selected: area.id === draft.selectedAreaId,
        pointsModel: area.points.map((p) => ({ ...p })),
      }));
      // Draft/preview polygons connect while drawing and fill from 3 points;
      // the product stays visible through the translucent fill.
      const staged = livePreview ?? draft.drawing;
      if (staged !== null && staged.length >= 3) {
        overlays.push({ id: 'model-area-draft', selected: false, pointsModel: staged.map((p) => ({ ...p })) });
      }
      viewer.setSafeAreaOverlays(overlays);
      viewer.setAnchorsVisible(draft.anchorsVisible);
      viewer.setSafeAreasVisible(draft.safeAreasVisible);
      viewer.setProductVisible(draft.productVisible);
      if (gesture === null) paintDrawingOutline(draft.safeAreasVisible && draft.productVisible ? draft.drawing : null);
    } catch {
      return;
    }
  };

  /** Refresh the reference label without rebuilding the form (keeps focus). */
  const syncReferenceOverlay = (draft: ProductDraft): void => {
    try {
      viewerOf()?.setReferenceOverlay?.(
        contextTask === 'measure' && (!options.contextHost || contextPanel?.isOpen() || armed === 'refA' || armed === 'refB') && draft.areaTool === 'rotate' && draft.refA !== null && draft.refB !== null
          ? {
              a: { ...draft.refA },
              b: { ...draft.refB },
              label: referenceOverlayLabel(draft.distanceMmRaw),
            }
          : null,
      );
    } catch {
      return;
    }
  };

  /** Client-space press tolerance (CSS px) for direct canvas handles. */
  const CANVAS_HANDLE_HIT_PX = 11;

  /** Layout-affecting handle state (positions/visibility; selection excluded). */
  let lastHandleLayoutSig = '';

  /** Last laid-out handle models (null = hidden that pass); press-checked. */
  let handleModelsCache: Array<SetupVec3 | null> = [];

  /**
   * Candidate handle positions: polygon vertices then edge midpoints. Midpoints
   * are re-picked on the visible model before insertion; never saved as chords.
   */
  function areaHandleModels(points: readonly SetupVec3[]): SetupVec3[] {
    const models: SetupVec3[] = points.map((point) => ({ ...point }));
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      models.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
    }
    return models;
  }

  function areaHandleRefFor(index: number, areaId: string, count: number): AreaHandleRef {
    return index < count ? { areaId, kind: 'corner', index } : { areaId, kind: 'side', index: index - count };
  }

  /** Press on a visible projected handle: press-direct, never via buttons. */
  function onHandleDown(event: PointerEvent, index: number): void {
    if (destroyed || !active || event.button !== 0) return;
    // Armed reference/polygon modes own every press: visible handles are
    // already hidden then, and a stray press never hijacks them.
    if (armed !== null || gesture !== null || pendingHandle !== null) return;
    const resolved = currentDraft();
    if ('error' in resolved) return;
    const { draft } = resolved;
    const viewer = viewerOf();
    if (!viewer) return;
    const area = draft.areas.find((candidate) => candidate.id === draft.selectedAreaId);
    if (!area || area.points.length < 3) return;
    if (!draft.safeAreasVisible || !draft.productVisible) return;
    // Comfortable hit targets overlap on dense rings. Resolve by distance to
    // the visible handle centres instead of DOM stacking order, so a press
    // on a particular white square cannot move its neighbour or insert a point.
    let closest = Infinity;
    for (let candidate = 0; candidate < handleModelsCache.length; candidate += 1) {
      const position = handleModelsCache[candidate];
      if (!position || handleDots[candidate]?.style.display === 'none') continue;
      const projected = viewer.projectToClient?.(position); if (!projected) continue;
      const distance = Math.hypot(projected.x - event.clientX, projected.y - event.clientY);
      if (distance < closest) { closest = distance; index = candidate; }
    }
    const model = handleModelsCache[index] ?? null;
    if (!model) return;
    // Live surface check: the press must resolve to this handle's own
    // surface point — never a backface, an occluder or a miss.
    const projected = viewer.projectToClient?.(model);
    const hit = projected ? safePick(viewer, projected.x, projected.y) : null;
    if (!hit) return;
    const tol = Math.max(1e-9, longestChord(area.points) * 0.01);
    if (chordNative(hit, model) > tol) return;
    const ref = areaHandleRefFor(index, area.id, area.points.length);
    if (ref.kind === 'side' && draft.areaTool === 'edit' && outlineAction === 'curve') {
      draft.curveArm = { areaId: area.id, edge: ref.index };
      draft.handleArm = null; draft.curveBendPx = 0;
      event.preventDefault(); event.stopPropagation(); refresh(); return;
    }
    if (ref.kind === 'side') {
      const outcome = commitHandlePoint(draft, ref, model);
      lastStatus = outcome.message;
      if (outcome.ok) emit(resolved.entry, draft);
      event.preventDefault(); event.stopPropagation(); refresh(); return;
    }
    pendingHandle = { ref, x: event.clientX, y: event.clientY };
    suspendOrbit();
    event.preventDefault();
    event.stopPropagation();
    try {
      (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is best-effort; document gating still ends the press */
    }
  }

  /** Create (once) and attach the projected handle overlay to the stage. */
  function ensureHandleLayer(stage: HTMLElement, count: number): HTMLDivElement {
    if (
      handleLayer !== null &&
      handleLayer.parentElement === stage &&
      handleDots.length === count * 2
    ) {
      if (handleLayer.nextSibling !== null) stage.append(handleLayer);
      return handleLayer;
    }
    try {
      handleLayer?.remove();
    } catch {
      /* best-effort teardown */
    }
    handleLayer = null;
    handleDots = [];
    handleModelsCache = [];
    lastHandleLayoutSig = '';
    const layer = document.createElement('div');
    layer.setAttribute(HOOK, 'canvas-handles');
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.pointerEvents = 'none';
    layer.style.display = 'none';
    for (let index = 0; index < count * 2; index += 1) {
      const corner = index < count;
      const dot = document.createElement('div');
      dot.setAttribute(HOOK, corner ? `canvas-handle-corner-${index}` : `canvas-handle-side-${index - count}`);
      dot.setAttribute('role', 'button');
      dot.tabIndex = 0;
      dot.style.position = 'absolute';
      dot.style.pointerEvents = 'auto';
      dot.style.touchAction = 'none';
      dot.style.cursor = 'grab';
      // Corners render above sides so a close press resolves to the corner
      // deterministically.
      dot.style.zIndex = corner ? '3' : '2';
      const hit = corner ? CANVAS_HANDLE_HIT_PX * 2 + 2 : CANVAS_HANDLE_HIT_PX * 2;
      dot.style.width = `${hit}px`;
      dot.style.height = `${hit}px`;
      dot.style.transform = 'translate(-50%, -50%)';
      const square = document.createElement('span');
      square.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:${corner ? 9 : 6}px;height:${corner ? 9 : 6}px;background:#fff;border:1.5px solid #0b6cab;box-shadow:0 0 1px #192d3d;pointer-events:none`;
      if (!corner) { square.textContent = '+'; square.style.cssText += ';width:14px;height:14px;line-height:12px;text-align:center;font-size:14px;color:#0b6cab'; }
      dot.append(square);
      dot.addEventListener('keydown', (event) => {
        const resolved = currentDraft(); if ('error' in resolved) return;
        const { entry, draft } = resolved;
        const area = draft.areas.find((item) => item.id === draft.selectedAreaId); if (!area) return;
        const ref = areaHandleRefFor(index, area.id, area.points.length);
        if ((event.key === 'Delete' || event.key === 'Backspace') && ref.kind === 'corner') {
          event.preventDefault(); event.stopPropagation();
          const next = area.points.filter((_, at) => at !== ref.index);
          const reason = checkModelSafeArea(area.id, area.name, next, [], draft.fitted && !draft.fitStale ? draft.fitted.mmPerUnit : null);
          if (reason) lastStatus = `${reason} Previous area kept.`;
          else { area.points = next; lastStatus = 'Corner removed. Staged; save the setup to keep it.'; emit(entry, draft); }
          refresh(); return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation();
          if (ref.kind === 'side' && draft.areaTool === 'edit' && outlineAction === 'curve') {
            draft.curveArm = { areaId: area.id, edge: ref.index }; draft.handleArm = null; draft.curveBendPx = 0;
          } else if (ref.kind === 'side') {
            const model = handleModelsCache[index]; if (!model) return;
            const outcome = commitHandlePoint(draft, ref, model); lastStatus = outcome.message;
            if (outcome.ok) emit(entry, draft);
          } else { draft.handleArm = ref; lastStatus = 'Corner selected: click its new position on the model. Escape cancels.'; }
          refresh();
        }
      });
      dot.style.display = 'none';
      dot.addEventListener('pointerdown', (event) => onHandleDown(event, index));
      layer.append(dot);
      handleDots.push(dot);
    }
    stage.append(layer);
    handleLayer = layer;
    return layer;
  }

  /**
   * Position independent corner and insertion handles for the selected polygon,
   * adjacent to its actual polygon at a constant CSS hit size. Runs on every
   * refresh and on every viewer frame (orbit/zoom/resize/orbit-damping all
   * reposition by the next frame). A handle shows only while its own surface
   * point both projects and re-picks within tolerance — occluded, backface
   * or missed handles hide instead of guessing. Display-only; stored
   * polygons change only through the existing handle-gesture commit.
   *
   * Exact view/geometry signatures reuse layout on selection-only refreshes;
   * all real presses still verify the live surface.
   */
  function handleLayoutSig(
    revision: number,
    draft: ProductDraft,
    area: { id: string; points: SetupVec3[] },
  ): string {
    return [
      revision,
      area.id,
      JSON.stringify(area.points),
      draft.safeAreasVisible,
      draft.productVisible,
      armed ?? '',
      panMode,
      gesture !== null,
      pendingHandle !== null,
    ].join('|');
  }

  /** Selection/text-only repaint for laid-out dots: no projection, no picks. */
  function paintHandleSelection(draft: ProductDraft, rect: { id: string; name: string; points: SetupVec3[] }): void {
    for (let index = 0; index < handleDots.length; index += 1) {
      const dot = handleDots[index];
      if (!dot) continue;
      const ref = areaHandleRefFor(index, rect.id, rect.points.length);
      const selected = ref.kind === 'corner' && draft.handleArm?.areaId === rect.id && draft.handleArm.index === ref.index;
      dot.setAttribute('aria-pressed', String(selected));
      const square = dot.firstElementChild as HTMLElement | null;
      if (square) {
        square.style.background = selected ? '#0072ce' : '#fff';
        if (ref.kind === 'side') square.textContent = draft.areaTool === 'edit' && outlineAction === 'curve' ? '⌁' : '+';
      }
      dot.setAttribute(
        'aria-label',
        ref.kind === 'corner'
          ? `Drag corner ${ref.index + 1} of “${rect.name}” on the model. Delete removes.`
          : `${draft.areaTool === 'edit' && outlineAction === 'curve' ? 'Bend' : 'Insert a corner on'} edge ${ref.index + 1} of “${rect.name}”`,
      );
    }
  }

  function syncHandleLayer(): void {
    if (destroyed) {
      return;
    }
    const viewer = viewerOf();
    const canvas = canvasOf();
    const stage = canvas?.parentElement ?? null;
    if (!viewer || !canvas || !stage || canvas.getClientRects().length === 0) {
      if (handleLayer !== null) handleLayer.style.display = 'none';
      lastHandleLayoutSig = '';
      return;
    }
    const resolved = currentDraft();
    const draft = 'error' in resolved ? null : resolved.draft;
    const area = draft?.areas.find((candidate) => candidate.id === draft.selectedAreaId) ?? null;
    const rect = area !== null && area.points.length >= 3 ? area : null;
    const layer = ensureHandleLayer(stage, rect?.points.length ?? 0);
    const shown =
      rect !== null &&
      draft !== null &&
      draft.safeAreasVisible &&
      draft.productVisible &&
      armed === null &&
      !panMode &&
      gesture === null &&
      pendingHandle === null &&
      typeof viewer.projectToClient === 'function';
    layer.style.display = shown ? '' : 'none';
    if (!shown || rect === null || draft === null) {
      lastHandleLayoutSig = '';
      return;
    }
    const revision = frameRevision();
    const layoutSig = handleLayoutSig(revision, draft, rect);
    // Legacy adapters without a revision retain exact per-frame layout.
    if (revision >= 0 && layoutSig === lastHandleLayoutSig) {
      paintHandleSelection(draft, rect);
      return;
    }
    const models = areaHandleModels(rect.points);
    const tol = Math.max(1e-9, longestChord(rect.points) * 0.01);
    const layerRect = layer.getBoundingClientRect();
    handleModelsCache = models.map((model) => ({ ...model }));
    models.forEach((model, index) => {
      const dot = handleDots[index];
      if (!dot) return;
      let client: { x: number; y: number } | null = null;
      try {
        client = viewer.projectToClient!(model);
      } catch {
        client = null;
      }
      let visible = client !== null;
      if (visible && client !== null) {
        const hit = safePick(viewer, client.x, client.y);
        visible = hit !== null && (index >= rect.points.length || chordNative(hit, model) <= tol);
        if (visible && hit !== null && index >= rect.points.length) handleModelsCache[index] = { ...hit };
      }
      if (!visible || client === null) {
        dot.style.display = 'none';
        handleModelsCache[index] = null;
        return;
      }
      dot.style.display = '';
      dot.style.left = `${client.x - layerRect.left}px`;
      dot.style.top = `${client.y - layerRect.top}px`;
      const ref = areaHandleRefFor(index, rect.id, rect.points.length);
      const selected = ref.kind === 'corner' && draft.handleArm?.areaId === rect.id && draft.handleArm.index === ref.index;
      dot.setAttribute('aria-pressed', String(selected));
      const square = dot.firstElementChild as HTMLElement | null;
      if (square) {
        square.style.background = selected ? '#0072ce' : '#fff';
        if (ref.kind === 'side') square.textContent = draft.areaTool === 'edit' && outlineAction === 'curve' ? '⌁' : '+';
      }
      dot.setAttribute(
        'aria-label',
        ref.kind === 'corner'
          ? `Drag corner ${ref.index + 1} of “${rect.name}” on the model. Delete removes.`
          : `${draft.areaTool === 'edit' && outlineAction === 'curve' ? 'Bend' : 'Insert a corner on'} edge ${ref.index + 1} of “${rect.name}”`,
      );
    });
    lastHandleLayoutSig = layoutSig;
  }

  /** Cheap draft identity for frame gating (no projection, no picks). */
  function frameDraftKey(): string {
    try {
      const resolved = currentDraft();
      if ('error' in resolved) return 'error';
      const draft = resolved.draft;
      const area = draft.areas.find((candidate) => candidate.id === draft.selectedAreaId) ?? null;
      return `${draft.selectedAreaId ?? ''}:${area?.points.length ?? 0}:${draft.safeAreasVisible}:${draft.productVisible}:${armed ?? ''}:${panMode}:${gesture !== null}:${pendingHandle !== null}:${draft.areaTool}:${draft.curveArm ? `${draft.curveArm.edge}@${draft.curveBendPx}` : ''}`;
    } catch {
      return '';
    }
  }

  function frameRevision(): number {
    try {
      const viewer = viewerOf();
      const revision = viewer?.getViewRevision?.();
      return typeof revision === 'number' && Number.isFinite(revision) ? revision : -1;
    } catch {
      return -1;
    }
  }

  /** Record that handles are settled for the current revision/draft (idle skips). */
  function noteHandlesSettled(): void {
    lastFrameRevision = frameRevision();
    lastFrameDraftKey = frameDraftKey();
    if (settleTimer !== null) {
      try { clearTimeout(settleTimer); } catch { /* timer already fired */ }
      settleTimer = null;
    }
  }

  /** Keep the frame hook on the live viewer (viewer swaps are lead-owned). */
  function wireHandleFrame(): void {
    const live = viewerOf();
    if (live !== framedViewer) {
      try {
        if (framedViewer) framedViewer.onFrame = null;
      } catch {
        /* best-effort teardown */
      }
      framedViewer = live;
      lastHandleLayoutSig = '';
      // A new live viewer starts unsettled so the next frame lays out once.
      lastFrameRevision = -1;
      lastFrameDraftKey = '';
      if (live) {
        try {
          live.onFrame = () => {
            if (destroyed || !active) return;
            const revision = frameRevision();
            if (revision < 0) {
              // Older viewer without a revision: preserve legacy per-frame
              // behavior (correctness first; no gating possible).
              syncHandleLayer();
              syncCurveHandle();
              if (gesture === null && outlineDraft?.drawing?.length && outlineDraft.safeAreasVisible && outlineDraft.productVisible && canvasOf()?.getClientRects().length) paintDrawingOutline(outlineDraft.drawing);
              return;
            }
            const draftKey = frameDraftKey();
            if (revision === lastFrameRevision && draftKey === lastFrameDraftKey) return;
            // Camera or draft moved: hide immediately (no projection or
            // surface picks while moving) and run the expensive
            // occlusion/pick pass once after the camera settles. Pointer
            // presses still re-verify against the live surface exactly.
            lastFrameRevision = revision;
            lastFrameDraftKey = draftKey;
            if (handleLayer) handleLayer.style.display = 'none';
            if (curveHandleEl) curveHandleEl.style.display = 'none';
            if (drawingOutline) drawingOutline.style.display = 'none';
            if (settleTimer !== null) {
              try { clearTimeout(settleTimer); } catch { /* timer already fired */ }
              settleTimer = null;
            }
            settleTimer = setTimeout(() => {
              settleTimer = null;
              if (destroyed || !active) return;
              try { syncHandleLayer(); } catch { /* overlay-only */ }
              try { syncCurveHandle(); } catch { /* overlay-only */ }
              try {
                if (gesture === null && outlineDraft?.drawing?.length && outlineDraft.safeAreasVisible && outlineDraft.productVisible && canvasOf()?.getClientRects().length) paintDrawingOutline(outlineDraft.drawing);
              } catch { /* overlay-only */ }
            }, 120);
          };
        } catch {
          framedViewer = null;
        }
      }
    }
  }

  /** Screen-space endpoints of the armed curve edge (null when unavailable). */
  function curveEdgeScreen(
    draft: ProductDraft,
  ): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
    const viewer = viewerOf();
    const arm = draft.curveArm;
    if (!viewer || !arm || typeof viewer.projectToClient !== 'function') return null;
    const area = draft.areas.find((candidate) => candidate.id === arm.areaId);
    if (!area || area.points.length < 3) return null;
    const count = area.points.length;
    const a = area.points[((arm.edge % count) + count) % count]!;
    const b = area.points[(arm.edge + 1) % count]!;
    try {
      const from = viewer.projectToClient(a);
      const to = viewer.projectToClient(b);
      if (!from || !to) return null;
      const tolerance = Math.max(1e-9, longestChord(area.points) * .01);
      const ah = safePick(viewer, from.x, from.y), bh = safePick(viewer, to.x, to.y);
      if (!ah || !bh || chordNative(a, ah) > tolerance || chordNative(b, bh) > tolerance) return null;
      return { from, to };
    } catch {
      return null;
    }
  }

  /** Screen-space control point for the armed curve edge (null when unavailable). */
  function curveControlScreen(draft: ProductDraft): { x: number; y: number } | null {
    const edge = curveEdgeScreen(draft);
    if (!edge) return null;
    const dx = edge.to.x - edge.from.x;
    const dy = edge.to.y - edge.from.y;
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || !(len > 1)) return null;
    return {
      x: (edge.from.x + edge.to.x) / 2 + (-dy / len) * draft.curveBendPx,
      y: (edge.from.y + edge.to.y) / 2 + (dx / len) * draft.curveBendPx,
    };
  }

  /** Draggable bend diamond for the armed curve edge (display-only handle). */
  let curveHandleEl: HTMLDivElement | null = null;
  let curveDrag: { startX: number; startY: number; startBend: number } | null = null;

  /** Position the bend diamond at the armed edge's screen control point. */
  function syncCurveHandle(): void {
    if (destroyed) return;
    const viewer = viewerOf();
    const canvas = canvasOf();
    const stage = canvas?.parentElement ?? null;
    if (!viewer || !canvas || !stage || canvas.getClientRects().length === 0) {
      if (curveHandleEl !== null) curveHandleEl.style.display = 'none';
      return;
    }
    const resolved = currentDraft();
    const draft = 'error' in resolved ? null : resolved.draft;
    const arm = draft?.curveArm ?? null;
    const area = arm && draft ? draft.areas.find((candidate) => candidate.id === arm.areaId) ?? null : null;
    const point = draft && area ? curveControlScreen(draft) : null;
    const shown =
      point !== null &&
      area !== null &&
      draft !== null &&
      draft.safeAreasVisible &&
      draft.productVisible &&
      armed === null &&
      !panMode &&
      gesture === null &&
      pendingHandle === null;
    if (!shown || point === null || area === null || draft === null || arm === null) {
      if (curveHandleEl !== null) curveHandleEl.style.display = 'none';
      return;
    }
    const live: ProductDraft = draft;
    if (curveHandleEl === null || curveHandleEl.parentElement !== stage) {
      try {
        curveHandleEl?.remove();
      } catch {
        /* best-effort teardown */
      }
      const diamond = document.createElement('div');
      diamond.setAttribute(HOOK, 'curve-bend-handle');
      diamond.setAttribute('role', 'slider');
      diamond.tabIndex = 0;
      diamond.style.position = 'absolute';
      diamond.style.pointerEvents = 'auto';
      diamond.style.touchAction = 'none';
      diamond.style.cursor = 'grab';
      diamond.style.width = '26px';
      diamond.style.height = '26px';
      diamond.style.transform = 'translate(-50%, -50%) rotate(45deg)';
      diamond.style.background = '#ffd21f';
      diamond.style.border = '2px solid #0b6cab';
      diamond.style.zIndex = '4';
      diamond.setAttribute('aria-valuemin', String(-CURVE_BEND_LIMIT_PX));
      diamond.setAttribute('aria-valuemax', String(CURVE_BEND_LIMIT_PX));
      diamond.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const resolved = currentDraft(); if ('error' in resolved) return;
        const live = resolved.draft;
        event.preventDefault();
        event.stopPropagation();
        curveDrag = { startX: event.clientX, startY: event.clientY, startBend: live.curveBendPx };
        suspendOrbit();
        try {
          (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
        } catch {
          /* capture is best-effort */
        }
      });
      diamond.addEventListener('keydown', (event) => {
        const resolved = currentDraft(); if ('error' in resolved) return;
        const live = resolved.draft;
        const step = event.shiftKey ? 12 : 4;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          const delta = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : step;
          live.curveBendPx = Math.max(-CURVE_BEND_LIMIT_PX, Math.min(CURVE_BEND_LIMIT_PX, live.curveBendPx + delta));
          const slider = document.querySelector<HTMLInputElement>('[data-model-setup-hook="curve-bend"]');
          if (slider) slider.value = String(live.curveBendPx);
          lastStatus = `Bend ${Math.round(live.curveBendPx)} px — Apply bend to bake surface points, or Escape to cancel.`;
          syncCurveHandle();
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          document.querySelector<HTMLButtonElement>('[data-model-setup-hook="curve-apply"]')?.click();
        }
      });
      diamond.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.querySelector<HTMLButtonElement>('[data-model-setup-hook="curve-apply"]')?.click();
      });
      stage.append(diamond);
      curveHandleEl = diamond;
    }
    const edge = curveEdgeScreen(draft);
    if (edge) {
      const samples = sampleQuadraticBezier2D(edge.from, point, edge.to, CURVE_INTERIOR_SAMPLES);
      const hits = samples.map(sample => safePick(viewer, sample.x, sample.y));
      if (hits.every((hit): hit is SetupVec3 => hit !== null)) {
        const preview = area.points.flatMap((vertex, index) => index === arm.edge ? [vertex, ...hits] : [vertex]);
        paintDrawingOutline(preview);
      } else paintDrawingOutline(null);
    }
    const layerRect = stage.getBoundingClientRect();
    curveHandleEl.style.display = '';
    curveHandleEl.style.left = `${point.x - layerRect.left}px`;
    curveHandleEl.style.top = `${point.y - layerRect.top}px`;
    curveHandleEl.setAttribute(
      'aria-label',
      `Bend handle for edge ${arm.edge + 1} of “${area.name}”. Arrow keys adjust the bend, double-click applies it.`,
    );
    curveHandleEl.setAttribute('aria-valuenow', String(Math.round(live.curveBendPx)));
    curveHandleEl.setAttribute('aria-valuetext', `${Math.round(live.curveBendPx)} pixels`);
  }

  /**
   * Double-click an edge of the selected area to insert a real surface point
   * exactly on the model (no buttons required). Misses and invalid outlines
   * keep the old geometry.
   */
  function onCanvasDoubleClick(event: MouseEvent): void {
    if (destroyed || !active || panMode) return;
    if (event.button !== 0) return;
    if (event.target !== canvasOf()) return;
    if (armed !== null || gesture !== null || pendingHandle !== null || curveDrag !== null) return;
    const resolved = currentDraft();
    if ('error' in resolved) return;
    const { entry, draft } = resolved;
    const viewer = viewerOf();
    if (!viewer || typeof viewer.projectToClient !== 'function') return;
    const area = draft.areas.find((candidate) => candidate.id === draft.selectedAreaId);
    if (!area || area.points.length < 3 || draft.areaTool !== 'edit') return;
    if (!draft.safeAreasVisible || !draft.productVisible) return;
    // Projection-first pass (no surface picks): rank edges by screen
    // distance, then verify the nearest verifying edge only. Press-time
    // verification is unchanged — an edge still commits only when both of
    // its corners re-pick within tolerance and the click itself hits the
    // live surface — but a dense ring no longer raycasts every endpoint.
    const tolerance = Math.max(1e-9, longestChord(area.points) * .01);
    const candidates: Array<{ edge: number; dist: number; from: { x: number; y: number }; to: { x: number; y: number } }> = [];
    for (let edge = 0; edge < area.points.length; edge += 1) {
      const a = area.points[edge]!;
      const b = area.points[(edge + 1) % area.points.length]!;
      let from: { x: number; y: number } | null = null;
      let to: { x: number; y: number } | null = null;
      try {
        from = viewer.projectToClient(a);
        to = viewer.projectToClient(b);
      } catch {
        continue;
      }
      if (from === null || to === null) continue;
      candidates.push({
        edge,
        dist: pointSegmentDistancePx(event.clientX, event.clientY, from.x, from.y, to.x, to.y),
        from,
        to,
      });
    }
    candidates.sort((x, y) => x.dist - y.dist);
    let bestEdge = -1;
    for (const candidate of candidates) {
      if (candidate.dist >= 28) break;
      const a = area.points[candidate.edge]!;
      const b = area.points[(candidate.edge + 1) % area.points.length]!;
      const ah = safePick(viewer, candidate.from.x, candidate.from.y);
      const bh = safePick(viewer, candidate.to.x, candidate.to.y);
      if (!ah || !bh || chordNative(a, ah) > tolerance || chordNative(b, bh) > tolerance) continue;
      bestEdge = candidate.edge;
      break;
    }
    if (bestEdge < 0) return;
    const hit = safePick(viewer, event.clientX, event.clientY);
    if (hit === null) {
      lastStatus = 'That double-click missed the model surface — nothing was inserted. Click the surface itself.';
      refresh();
      return;
    }
    const outcome = commitHandlePoint(draft, { areaId: area.id, kind: 'side', index: bestEdge }, hit);
    lastStatus = outcome.message;
    if (outcome.ok) emit(entry, draft);
    refresh();
  }

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

  /** Roll back any active canvas gesture without touching staged data. */
  const cancelGestureSilent = (): void => {
    if (downAt !== null) {
      try { canvasOf()?.releasePointerCapture(downAt.pointerId); } catch { /* already released */ }
    }
    downAt = null;
    gesture = null;
    pendingHandle = null;
    curveDrag = null;
    livePreview = null;
    restoreOrbit();
  };

  /** Rename the selected area: trim, reject empty/duplicates, keep id+geometry. */
  const renameSelectedArea = (
    draft: ProductDraft,
    areaId: string,
    raw: string,
  ): { ok: boolean; message: string } => {
    const area = draft.areas.find((candidate) => candidate.id === areaId);
    if (area === undefined) return { ok: false, message: 'That area is no longer staged — nothing changed.' };
    const next = typeof raw === 'string' ? raw.trim() : '';
    if (next === '') {
      return { ok: false, message: `Enter a name for the selected area — “${area.name}” kept unchanged.` };
    }
    if (draft.areas.some((other) => other.id !== area.id && other.name.trim().toLowerCase() === next.toLowerCase())) {
      return { ok: false, message: `Another area is already called “${next}” — “${area.name}” kept unchanged. Choose a distinct name.` };
    }
    if (next === area.name) return { ok: false, message: `Already called “${next}” — nothing changed.` };
    const others = draft.areas.filter((candidate) => candidate.id !== area.id).map((candidate) => candidate.id);
    const reason = checkModelSafeArea(
      area.id,
      next,
      area.points,
      others,
      draft.fitted && !draft.fitStale ? draft.fitted.mmPerUnit : null,
    );
    if (reason !== null) return { ok: false, message: `${reason} “${area.name}” kept unchanged.` };
    const old = area.name;
    area.name = next;
    return {
      ok: true,
      message: `Renamed “${old}” to “${next}”. Area id and outline unchanged. Staged; save the setup to keep it.`,
    };
  };

  /** Remove one corner of a staged area (minimum 3 vertices kept). */
  const removeAreaCorner = (
    draft: ProductDraft,
    areaId: string,
    index: number,
  ): { ok: boolean; message: string } => {
    const area = draft.areas.find((candidate) => candidate.id === areaId);
    if (area === undefined) return { ok: false, message: 'That area is no longer staged — nothing changed.' };
    if (index < 0 || index >= area.points.length) {
      return { ok: false, message: `That corner is no longer staged — “${area.name}” kept unchanged.` };
    }
    if (area.points.length <= 3) {
      return { ok: false, message: `“${area.name}” already has 3 corners — removal would leave fewer than 3. Outline unchanged.` };
    }
    const next = area.points.filter((_, at) => at !== index);
    const others = draft.areas.filter((candidate) => candidate.id !== area.id).map((candidate) => candidate.id);
    const reason = checkModelSafeArea(
      area.id,
      area.name,
      next,
      others,
      draft.fitted && !draft.fitStale ? draft.fitted.mmPerUnit : null,
    );
    if (reason !== null) return { ok: false, message: `${reason} “${area.name}” kept unchanged.` };
    area.points = next;
    draft.curveArm = null;
    if (draft.handleArm?.areaId === area.id) draft.handleArm = null;
    return {
      ok: true,
      message: `Corner ${index + 1} removed — “${area.name}” has ${next.length} corners. Staged; save the setup to keep it.`,
    };
  };

  /**
   * Bend one edge of a staged area: sample a screen-space quadratic curve
   * (straight endpoints, perpendicular control offset) and raycast every
   * interior sample against the live surface. Only real surface picks enter
   * the polygon; a miss, an invisible edge or a failed ring check keeps the
   * old geometry atomically. Persisted output is plain polygon points — bend
   * settings are UI-only and never stored.
   */
  const CURVE_INTERIOR_SAMPLES = 7;
  const CURVE_BEND_LIMIT_PX = 160;

  const commitCurveBend = (
    draft: ProductDraft,
    areaId: string,
    edge: number,
    bendPx: number,
  ): { ok: boolean; message: string } => {
    const viewer = viewerOf();
    const area = draft.areas.find((candidate) => candidate.id === areaId);
    if (area === undefined) return { ok: false, message: 'That area is no longer staged — nothing changed.' };
    if (!viewer) return { ok: false, message: `No live preview — “${area.name}” kept unchanged.` };
    if (typeof viewer.projectToClient !== 'function' || (viewer.pickSurface === undefined && viewer.pickSurfaceFromEvent === undefined)) {
      return { ok: false, message: `The preview cannot verify the surface here — “${area.name}” kept unchanged.` };
    }
    const count = area.points.length;
    if (count < 3 || edge < 0 || edge >= count) {
      return { ok: false, message: `That edge is no longer staged — “${area.name}” kept unchanged.` };
    }
    const start = area.points[edge]!;
    const end = area.points[(edge + 1) % count]!;
    let from: { x: number; y: number } | null = null;
    let to: { x: number; y: number } | null = null;
    try {
      from = viewer.projectToClient(start);
      to = viewer.projectToClient(end);
    } catch {
      from = null;
      to = null;
    }
    const endpointsVisible = curveEdgeScreen({ ...draft, curveArm: { areaId, edge } });
    if (from === null || to === null || !endpointsVisible || !draft.productVisible || !draft.safeAreasVisible) {
      return { ok: false, message: `Edge ${edge + 1} is not currently visible — orbit until both corners show, then apply again. “${area.name}” kept unchanged.` };
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || !(len > 8)) {
      return { ok: false, message: `Edge ${edge + 1} is too short on screen — zoom in or bend a longer edge. “${area.name}” kept unchanged.` };
    }
    const bend = Number.isFinite(bendPx) ? Math.max(-CURVE_BEND_LIMIT_PX, Math.min(CURVE_BEND_LIMIT_PX, bendPx)) : 0;
    const control = {
      x: (from.x + to.x) / 2 + (-dy / len) * bend,
      y: (from.y + to.y) / 2 + (dx / len) * bend,
    };
    const layout = sampleQuadraticBezier2D(from, control, to, CURVE_INTERIOR_SAMPLES);
    const samples: SetupVec3[] = [];
    for (let i = 0; i < layout.length; i += 1) {
      const spot = layout[i]!;
      const hit = safePick(viewer, spot.x, spot.y);
      if (hit === null) {
        return {
          ok: false,
          message: `Bend sample ${i + 1} of ${layout.length} missed the model surface — keep the whole bent edge on one visible patch. “${area.name}” kept unchanged.`,
        };
      }
      samples.push(hit);
    }
    const next: SetupVec3[] = [];
    for (let i = 0; i < count; i += 1) {
      next.push({ ...area.points[i]! });
      if (i === edge) {
        for (const sample of samples) {
          const last = next[next.length - 1]!;
          if (chordNative(last, sample) > 1e-9 && chordNative(sample, end) > 1e-9) next.push({ ...sample });
        }
      }
    }
    if (next.length <= count) {
      return { ok: false, message: `That bend produced no distinct surface points — try a larger bend. “${area.name}” kept unchanged.` };
    }
    if (next.length > POLYGON_POINT_LIMIT) {
      return { ok: false, message: `That bend would exceed ${POLYGON_POINT_LIMIT} outline points — “${area.name}” kept unchanged.` };
    }
    const others = draft.areas.filter((candidate) => candidate.id !== area.id).map((candidate) => candidate.id);
    const reason = checkModelSafeArea(
      area.id,
      area.name,
      next,
      others,
      draft.fitted && !draft.fitStale ? draft.fitted.mmPerUnit : null,
    );
    if (reason !== null) return { ok: false, message: `${reason} “${area.name}” kept unchanged.` };
    area.points = next;
    draft.curveArm = null;
    draft.handleArm = null;
    return {
      ok: true,
      message: `Edge ${edge + 1} of “${area.name}” curved with ${next.length - count} surface points baked in (${next.length} corners). Staged; save the setup to keep it.`,
    };
  };

  const commitHandlePoint = (
    draft: ProductDraft,
    handle: AreaHandleRef,
    point: SetupVec3,
  ): { ok: boolean; message: string } => {
    const area = draft.areas.find((candidate) => candidate.id === handle.areaId);
    if (area === undefined) return { ok: false, message: 'That area is no longer staged — nothing changed.' };
    const next = geometryForHandleMove(area.points, handle, point);
    if (next === null) {
      return { ok: false, message: `That move would collapse or invert “${area.name}” — kept unchanged.` };
    }
    const others = draft.areas.filter((candidate) => candidate.id !== area.id).map((candidate) => candidate.id);
    const reason = checkModelSafeArea(
      area.id,
      area.name,
      next,
      others,
      draft.fitted && !draft.fitStale ? draft.fitted.mmPerUnit : null,
    );
    if (reason !== null) return { ok: false, message: `${reason} “${area.name}” kept unchanged.` };
    area.points = next;
    draft.curveArm = null;
    return {
      ok: true,
      message: `${handle.kind === 'corner' ? 'Corner moved' : 'Corner inserted'} — “${area.name}” has ${next.length} independent corners. Staged; save the setup to keep it.`,
    };
  };

  /**
   * Resolve a rectangle drag to four surface-verified corners. The region
   * plane comes from the press point plus its REAL mesh face normal (never
   * from fitted sample geometry, so a straight diagonal drag on a flat
   * model works instead of dying on collinearity). Support is then proven,
   * not inferred: both endpoint normals must agree, independent off-chord
   * surface samples must lie on the plane, and every candidate corner and
   * edge midpoint is re-projected to the screen and re-picked — any miss or
   * deviation rejects the drag with a surface-specific explanation while the
   * previous draft is preserved. Never invents surface points.
   */
  const resolveDragRectangle = (
    viewer: ModelSetupViewerLike,
    press: { point: SetupVec3; normal: SetupVec3 | null },
    release: { point: SetupVec3; normal: SetupVec3 | null },
    downClient: { x: number; y: number },
    upClient: { x: number; y: number },
  ): { corners: SetupVec3[] } | { error: string } => {
    const corner0 = press.point;
    const releasePoint = release.point;
    const diag = chordNative(corner0, releasePoint);
    if (!(diag > 1e-9)) {
      return { error: 'That drag has zero size — press at one corner and drag to the opposite corner. Previous draft kept.' };
    }
    if (press.normal === null || release.normal === null) {
      return { error: 'The surface orientation under this drag is unavailable — start and end the drag on the model face. Previous draft kept.' };
    }
    const agreement =
      dot3(press.normal, release.normal) / (norm3(press.normal) * norm3(release.normal));
    if (!Number.isFinite(agreement) || agreement < 0.9986) {
      return { error: 'The surface curves under this drag (start/end face normals diverge) — a flat rectangle cannot sit here. Previous draft kept.' };
    }
    const plane = planeFromPointNormal(corner0, press.normal);
    if (plane === null) {
      return { error: 'The press point and normal cannot span a plane — start the drag on the model face. Previous draft kept.' };
    }
    // Independent support samples: raycast positions offset PERPENDICULAR to
    // the drag chord (never on it), so coplanar-but-off-chord surface is
    // proven rather than assumed. Any miss or off-plane sample rejects.
    const dragLenPx = Math.hypot(upClient.x - downClient.x, upClient.y - downClient.y);
    if (!(dragLenPx > 4)) {
      return { error: 'That drag is too short on screen — press at one corner and drag to the opposite corner. Previous draft kept.' };
    }
    if (viewer.pickSurface === undefined) {
      return { error: 'The preview cannot sample the surface here — end the drag on the model face. Previous draft kept.' };
    }
    const pickAt = (clientX: number, clientY: number): SetupVec3 | null => {
      try {
        const hit = viewer.pickSurface?.(clientX, clientY) ?? null;
        return hit !== null && isVec3(hit.modelPosition) ? { ...hit.modelPosition } : null;
      } catch {
        return null;
      }
    };
    const offPx = Math.min(64, Math.max(8, dragLenPx * 0.15));
    const perpX = -(upClient.y - downClient.y) / dragLenPx;
    const perpY = (upClient.x - downClient.x) / dragLenPx;
    const support: SetupVec3[] = [];
    for (const fraction of [0.25, 0.5, 0.75]) {
      for (const side of [1, -1]) {
        const clientX = downClient.x + (upClient.x - downClient.x) * fraction + perpX * offPx * side;
        const clientY = downClient.y + (upClient.y - downClient.y) * fraction + perpY * offPx * side;
        const hit = pickAt(clientX, clientY);
        if (hit === null) {
          return { error: 'The surface beside this drag is missing or holed — a flat rectangle cannot span it. Previous draft kept.' };
        }
        support.push(hit);
      }
    }
    const supportDeviation = maxPlaneDeviation(support, plane);
    const supportTol = diag * 0.002;
    if (!Number.isFinite(supportDeviation) || supportDeviation > supportTol) {
      return { error: `The surface beside this drag leaves the press plane (off by up to ${formatNative(supportDeviation)} units) — a flat rectangle cannot sit here. Previous draft kept.` };
    }
    const c0 = toPlane2D(corner0, plane);
    const c1 = toPlane2D(releasePoint, plane);
    const minSize = Math.max(1e-9, diag * 0.005);
    if (Math.abs(c1.x - c0.x) < minSize || Math.abs(c1.y - c0.y) < minSize) {
      return { error: 'That drag runs parallel to the surface frame — press at one corner and drag diagonally to the opposite corner. Previous draft kept.' };
    }
    const corners = cornersFromBox(plane, {
      minX: Math.min(c0.x, c1.x),
      minY: Math.min(c0.y, c1.y),
      maxX: Math.max(c0.x, c1.x),
      maxY: Math.max(c0.y, c1.y),
    });
    // Verify every candidate corner and edge midpoint against the ACTUAL
    // surface: project back to the screen and re-pick. A hole, curve or face
    // edge under any of the eight points rejects the drag — computed corners
    // are never trusted without a surface hit.
    if (viewer.projectToClient === undefined) {
      return { error: 'The preview cannot verify this rectangle against the surface — end the drag on the model face. Previous draft kept.' };
    }
    const verifyTol = Math.max(1e-9, diag * 0.005);
    const verifyPoints: Array<{ point: SetupVec3; label: string }> = corners.map((corner, index) => ({
      point: corner,
      label: `corner ${index + 1}`,
    }));
    for (let index = 0; index < 4; index += 1) {
      const a = corners[index]!;
      const b = corners[(index + 1) % 4]!;
      verifyPoints.push({
        point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
        label: `edge ${index + 1}-${((index + 1) % 4) + 1} midpoint`,
      });
    }
    for (const candidate of verifyPoints) {
      let client: { x: number; y: number } | null = null;
      try {
        client = viewer.projectToClient(candidate.point);
      } catch {
        client = null;
      }
      const hit = client === null ? null : pickAt(client.x, client.y);
      if (hit === null || chordNative(hit, candidate.point) > verifyTol) {
        return { error: `The rectangle ${candidate.label} leaves the model surface here (hole, curve or face edge) — a flat rectangle cannot sit here. Previous draft kept.` };
      }
    }
    return { corners };
  };

  /**
   * Surface-following fallback for a rectangle drag whose planar 4-corner
   * resolve failed (for example, on a curved garment).
   * Samples the screen-space rectangle PERIMETER with real raycast surface
   * picks only — every returned point is an actual mesh hit, never invented
   * fill. Order follows the perimeter; a missed sample rejects the ring.
   * Sampling does not certify the interior or establish a curved physical map.
   * Returns a miss error naming the failing sample (actionable re-drag
   * route), or a ring that still runs through the kernel ring check by the
   * caller (a degenerate projection is refused there, not here).
   */
  const resolveDragPerimeter = (
    viewer: ModelSetupViewerLike,
    downClient: { x: number; y: number },
    upClient: { x: number; y: number },
  ): { ring: SetupVec3[] } | { error: string } => {
    const PER_EDGE = 8;
    const total = PER_EDGE * 4;
    const corners = [
      { x: downClient.x, y: downClient.y },
      { x: upClient.x, y: downClient.y },
      { x: upClient.x, y: upClient.y },
      { x: downClient.x, y: upClient.y },
    ];
    const ring: SetupVec3[] = [];
    for (let edge = 0; edge < 4; edge += 1) {
      const from = corners[edge]!;
      const to = corners[(edge + 1) % 4]!;
      for (let step = 0; step < PER_EDGE; step += 1) {
        const fraction = step / PER_EDGE;
        const clientX = from.x + (to.x - from.x) * fraction;
        const clientY = from.y + (to.y - from.y) * fraction;
        let hit: SetupVec3 | null = null;
        try {
          const raw = viewer.pickSurface?.(clientX, clientY) ?? null;
          hit = raw !== null && isVec3(raw.modelPosition) ? { ...raw.modelPosition } : null;
        } catch {
          hit = null;
        }
        if (hit === null) {
          return {
            error: `That drag leaves the model surface (perimeter sample ${edge * PER_EDGE + step + 1} of ${total} missed) — keep the whole rectangle on one surface patch. Previous draft kept.`,
          };
        }
        const last = ring[ring.length - 1] ?? null;
        if (last === null || chordNative(last, hit) > 1e-9) ring.push(hit);
      }
    }
    if (ring.length >= 2) {
      const first = ring[0]!;
      const last = ring[ring.length - 1]!;
      if (chordNative(first, last) <= 1e-9) ring.pop();
    }
    return { ring };
  };

  const newAreaName = (draft: ProductDraft): string => {
    const entered = draft.drawingName.trim();
    if (entered !== '') return entered;
    let number = draft.areas.length + 1;
    while (draft.areas.some((area) => area.name.trim().toLowerCase() === `safe area ${number}`)) number += 1;
    return `Safe area ${number}`;
  };

  /**
   * Stage one released drag/handle result as a single edit: create the area
   * when it is a valid named ring, else stash the corners as an open drawing
   * (or keep the prior drawing) — never replacing the last valid area.
   */
  const stageReleasedCorners = (
    entry: ModelSetupProduct,
    draft: ProductDraft,
    corners: SetupVec3[],
    source: 'rectangle drag',
  ): string => {
    const name = newAreaName(draft);
    if (name !== '' && !draft.areas.some((area) => area.name.toLowerCase() === name.toLowerCase())) {
      const savedId = newAreaId();
      const reason = checkModelSafeArea(
        savedId,
        name,
        corners.map((point) => ({ ...point })),
        draft.areas.map((area) => area.id),
        draft.fitted && !draft.fitStale ? draft.fitted.mmPerUnit : null,
      );
      if (reason === null) {
        draft.areas.push({ id: savedId, name, points: corners.map((point) => ({ ...point })), status: draft.fitted && !draft.fitStale ? 'current' : 'stale' });
        draft.selectedAreaId = savedId;
        draft.handleArm = null;
        draft.drawing = null;
        draft.drawingName = '';
        // A completed area can be edited immediately. Choose a tool again
        // for another outline; ordinary drags return to model navigation.
        draft.areaTool = 'rotate';
        armed = null;
        emit(entry, draft);
        return draft.fitted && !draft.fitStale
          ? `Safe area “${name}” added (${corners.length} points). Staged — save the setup to keep it. Pending review.`
          : `Safe area “${name}” saved from the ${source} but the reference is uncalibrated — fit the scale, then recompute.`;
      }
      if (draft.drawing === null || draft.drawing.length === 0) draft.drawing = corners.map((point) => ({ ...point }));
      return `${reason} Previous valid areas kept; the ${source} corners are staged as an open drawing for inspection.`;
    }
    if (draft.drawing === null || draft.drawing.length === 0) {
      draft.drawing = corners.map((point) => ({ ...point }));
      draft.handleArm = null;
      const why =
        name === ''
          ? 'Name it above, then Finish area.'
          : `Another area is already called “${name}” — rename, then Finish area.`;
      return `Rectangle staged (${corners.length} surface points). ${why}`;
    }
    return `Kept the ${draft.drawing.length} staged drawing point(s) — the ${source} was set aside to protect them. Finish or Cancel the drawing first.`;
  };

  function refresh(): void {
    if (destroyed || !active) return;
    requestAnimationFrame(() => { if (!destroyed) syncOverflow(); });
    if (armed !== null) panMode = false;
    viewerOf()?.setInteractionMode?.(panMode ? 'pan' : 'select');
    document.querySelector('[data-model-setup-hook="commit-tools"]')?.replaceChildren();
    container.replaceChildren();
    const root = document.createElement('div');
    root.className = 'model-setup';
    container.append(root);

    const banner = el('p', 'pending-banner', 'model-setup-banner muted');
    banner.textContent =
      'Draft 3D setup — pending review.';
    root.append(banner);

    const statusBox = el('p', 'status', 'model-setup-status muted');
    statusBox.setAttribute('role', 'status');
    statusBox.setAttribute('tabindex', '0');
    statusBox.textContent = lastStatus;
    const paintStatus = (message: string): void => {
      lastStatus = message;
      statusBox.textContent = message;
      statusBox.hidden = message.length === 0;
      const hint = document.querySelector<HTMLElement>('[data-model-setup-hook="mode-hint"]');
      if (hint) hint.hidden = message.length > 0;
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
      wireHandleFrame();
      syncHandleLayer();
      syncCurveHandle();
      noteHandlesSettled();
      return;
    }

    if (!options.contextHost) renderProductRow(root, input, paintStatus);
    const resolved = currentDraft();
    if ('error' in resolved) {
      const note = el('p', 'no-product', 'muted');
      note.textContent = resolved.error;
      root.append(note, statusBox);
      wireHandleFrame();
      syncHandleLayer();
      syncCurveHandle();
      noteHandlesSettled();
      return;
    }
    const { entry, draft } = resolved;
    renderViewbar({ entry, draft }, paintStatus);
    renderReference(root, entry, draft, paintStatus);
    renderAreas(root, entry, draft, paintStatus);
    renderAdvanced(root, entry, draft, paintStatus);
    mountContext();
    const controls = document.querySelector('[data-model-setup-hook="feedback"]') ??
      document.querySelector('[data-model-setup-hook="author-tools"]');
    // Keep action feedback beside the surface, rather than below long lists.
    statusBox.hidden = lastStatus.length === 0;
    if (controls) controls.append(statusBox);
    else root.append(statusBox);
    paintViewer(draft);
    wireHandleFrame();
    syncHandleLayer();
    syncCurveHandle();
    for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-model-setup-hook][disabled]')) {
      const reason = control.title || (control.getAttribute(HOOK)?.startsWith('outline-')
        ? 'Choose Edit outline and select a safe area first.'
        : 'Complete the current measurement or select the relevant safe area first.');
      control.title = reason;
      control.setAttribute('aria-description', reason);
    }
    noteHandlesSettled();
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
        cancelGestureSilent();
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
    title.textContent = 'Calibrate scale';
    section.append(title);
    const intro = el('p', 'reference-intro', 'muted');
    intro.textContent =
      'Click two distinct points on the model surface (A, then B), enter their real distance, and fit the uniform scale. Straight-line chord — not a surface arc.';
    const help = document.createElement('details');
    const helpTitle = document.createElement('summary'); helpTitle.textContent = 'ⓘ How to calibrate';
    help.append(helpTitle, intro); section.append(help);

    const row = el('div', 'reference-row', 'model-setup-row');
    const pickA = el('button', 'ref-pick-a', 'btn-secondary');
    pickA.type = 'button';
    pickA.textContent = armed === 'refA' ? 'Click point A on the model… (Esc cancels)' : 'Pick A on model';
    pickA.setAttribute('aria-pressed', armed === 'refA' ? 'true' : 'false');
    pickA.addEventListener('click', () => {
      armed = armed === 'refA' ? null : 'refA';
      contextPanel?.close();
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
      contextPanel?.close();
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
      // The overlay label updates while typing (no blur, no re-render, so
      // the field keeps focus).
      syncReferenceOverlay(draft);
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
    const details = document.createElement('details');
    const detailsTitle = document.createElement('summary');
    detailsTitle.textContent = 'Scale details';
    details.append(detailsTitle, scale);
    const summary = el('p', 'scale-summary', 'muted');
    summary.textContent = draft.fitted
      ? `Reference fitted at ${formatMm(draft.fitted.lengthMm)} mm${draft.fitStale ? ' — re-fit after editing' : ''}. Pending review, not production-approved.`
      : 'Measure a known distance to set the scale.';
    section.append(summary, details);
    const fittedLength = draft.fitted?.lengthMm;
    const warningKey = `${entry.productId}\0${entry.variantId ?? ''}`;
    if (fittedLength !== undefined && !draft.fitStale && unusualCalibrationReference(fittedLength) &&
        !dismissedCalibrationWarnings.get(warningKey)?.has(fittedLength)) {
      const warning = el('div', 'calibration-warning', 'calibration-warning');
      warning.setAttribute('role', 'status');
      const message = document.createElement('p');
      message.textContent = `This reference represents ${formatMeasurement(fittedLength)} mm ${fittedLength >= 1000 ? `(${formatMeasurement(fittedLength / 1000)} m)` : ''}. Check the units (mm) and the physical distance. You can continue.`;
      const dismiss = el('button', 'calibration-warning-dismiss', 'btn-secondary');
      dismiss.type = 'button';
      dismiss.textContent = 'Dismiss size warning';
      dismiss.addEventListener('click', () => {
        const values = dismissedCalibrationWarnings.get(warningKey) ?? new Set<number>();
        values.add(fittedLength);
        dismissedCalibrationWarnings.set(warningKey, values);
        warning.remove();
      });
      warning.append(message, dismiss);
      section.append(warning);
    }
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
    intro.textContent = 'Name areas for different logo positions. Select an area to edit it; save the setup when you are done.';
    section.append(intro);

    // Keep primary authoring actions beside the model. Inactive groups
    // retain their layout footprint so changing tools cannot shift a pick.
    const toolRow = el('div', 'areas-tool-row', 'model-setup-row');
    toolRow.setAttribute('role', 'group');
    toolRow.setAttribute('aria-label', 'Safe-area authoring tool');
    const activateTool = (tool: ProductDraft['areaTool']): void => {
      cancelGestureSilent();
      panMode = false;
      contextPanel?.close();
      setViewControlsOpen(false);
      draft.areaTool = tool;
      draft.handleArm = null;
      draft.curveArm = null;
      draft.drawing = tool === 'freehand' ? [] : null;
      armed = tool === 'freehand' ? 'areaPoint' : null;
      paintStatus(tool === 'edit' && draft.selectedAreaId === null
        ? 'Edit outline: select an area below first, then drag its white squares on the model.' : '');
      refresh();
    };
    const toolChoice = el('label', 'tool-picker-label', 'model-setup-tool-picker-label');
    toolChoice.textContent = 'Tool';
    toolChoice.style.display = 'none';
    const toolPicker = el('select', 'tool-picker');
    toolPicker.setAttribute('aria-label', 'Safe-area tool');
    for (const tool of ['rotate', 'edit', 'rectangle', 'freehand'] as const) {
      const label = tool === 'rotate' ? 'Rotate model' : tool === 'edit' ? 'Edit outline' : tool === 'freehand' ? 'Polygon' : 'Rectangle';
      const option = document.createElement('option');
      option.value = tool;
      option.textContent = label;
      toolPicker.append(option);
      const button = el('button', `tool-${tool}`, 'btn-secondary');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.setAttribute('data-ps-tool', tool);
      button.setAttribute('aria-pressed', String(draft.areaTool === tool));
      if (draft.areaTool === tool) button.classList.add('is-selected');
      button.addEventListener('click', () => activateTool(tool));
      toolRow.append(button);
    }
    toolPicker.value = draft.areaTool;
    toolPicker.addEventListener('change', () => {
      activateTool(toolPicker.value as ProductDraft['areaTool']);
      document.querySelector<HTMLSelectElement>('[data-model-setup-hook="tool-picker"]')?.focus({ preventScroll: true });
    });
    toolChoice.append(toolPicker);
    const modes = el('div', 'outline-actions', 'model-setup-row');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Outline editing mode (Edit outline tool)');
    const outlineEnabled = draft.areaTool === 'edit';
    for (const mode of ['point', 'curve'] as const) {
      const button = el('button', `outline-${mode}`, 'btn-secondary'); button.type = 'button';
      button.textContent = mode === 'point' ? 'Add points' : 'Bend edge';
      button.setAttribute('aria-label', button.textContent);
      button.title = button.textContent;
      button.setAttribute('aria-pressed', String(outlineEnabled && outlineAction === mode));
      button.disabled = !outlineEnabled;
      if (outlineEnabled && outlineAction === mode) button.classList.add('is-selected');
      button.addEventListener('click', () => { cancelGestureSilent(); draft.curveArm = null; draft.handleArm = null; outlineAction = mode; refresh(); });
      modes.append(button);
    }
    const authorTools = document.querySelector('[data-model-setup-hook="author-tools"]');
    const commands = el('div', 'command-strip', 'model-setup-command-strip');
    commands.setAttribute('data-tool', draft.areaTool);
    (authorTools ?? section).append(toolChoice, toolRow, commands);
    commands.append(modes);
    modes.style.visibility = outlineEnabled ? '' : 'hidden';
    if (draft.areaTool === 'rectangle') {
      const rectHint = el('p', 'areas-rect-hint', 'model-setup-hint muted');
      rectHint.textContent =
        'Rectangle corners resolve on a consistent planar model surface patch (verified from actual surface samples). On curved patches the drag follows the surface as a multi-point ring instead — every point a real surface pick. Misses keep the previous draft with an explanation.';
      section.append(rectHint);
    }
    if (draft.areaTool === 'edit') {
      const editHint = el('p', 'areas-edit-hint', 'model-setup-hint muted');
      editHint.textContent =
        'Drag points to reshape. Click + to add a point. Choose Bend edge, then click its + to adjust a curve. Select a point to remove it. Escape cancels.';
      section.append(editHint);
    }

    const form = el('div', 'areas-form', 'model-setup-row');
    const nameLabel = document.createElement('label');
    nameLabel.className = 'model-setup-field';
    nameLabel.textContent = 'New area name (optional)';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'e.g. Left chest';
    nameInput.autocomplete = 'off';
    nameInput.title = 'Name the new safe area (optional)';
    nameInput.value = draft.drawingName;
    nameInput.setAttribute(HOOK, 'area-name');
    nameInput.setAttribute('aria-label', 'Safe-area name');
    // Fixed layout: the name field stays mounted for every tool and is only
    // disabled while Edit outline owns the panel (it names new drawings).
    nameInput.disabled = draft.areaTool === 'edit';
    nameInput.addEventListener('input', () => {
      draft.drawingName = nameInput.value;
    });
    nameLabel.append(nameInput);
    form.append(nameLabel);
    form.style.visibility = outlineEnabled ? 'hidden' : '';
    commands.append(form);

    const actions = el('div', 'areas-actions', 'model-setup-actions');
    const finish = el('button', 'area-finish', 'btn-primary');
    finish.type = 'button';
    finish.textContent = 'Finish area';
    finish.disabled = draft.drawing === null;
    finish.addEventListener('click', () => {
      const points = draft.drawing ?? [];
      const name = newAreaName(draft);
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
      draft.areaTool = 'rotate';
      paintStatus(
        draft.fitted && !draft.fitStale
          ? `Safe area “${name.trim()}” saved (${points.length} points, surface mapped). Pending review.`
          : `Safe area “${name.trim()}” saved (${points.length} points) but the reference is uncalibrated — fit the scale, then recompute.`,
      );
      emit(entry, draft);
      refresh();
    });
    const cancel = el('button', 'area-cancel', 'btn-secondary');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.setAttribute('aria-label', 'Cancel drawing');
    cancel.title = cancel.textContent;
    cancel.disabled = draft.drawing === null;
    cancel.addEventListener('click', () => {
      draft.drawing = null;
      armed = null;
      draft.areaTool = 'rotate';
      paintStatus('Drawing cancelled; nothing was committed.');
      refresh();
    });
    const undo = el('button', 'area-undo', 'btn-secondary'); undo.type = 'button'; undo.textContent = 'Undo'; undo.disabled = !draft.drawing?.length;
    undo.setAttribute('aria-label', 'Undo point'); undo.title = 'Undo point';
    undo.addEventListener('click', () => { draft.drawing?.pop(); lastStatus = 'Last corner undone.'; refresh(); });
    actions.append(finish, undo, cancel);
    actions.style.visibility = draft.areaTool === 'freehand' ? '' : 'hidden';
    commands.append(actions);

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
        draft.curveArm = null;
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
        if (draft.curveArm?.areaId === area.id) draft.curveArm = null;
        if (draft.handleArm?.areaId === area.id) draft.handleArm = null;
        paintStatus(`Safe area “${area.name}” deleted. Other areas and the reference are untouched.`);
        emit(entry, draft);
        refresh();
      });
      row.append(select, remove);
      list.append(row);
    }
    section.append(list);

    // Camera-only focus for the selected safe area (user button only: no
    // auto-focus on selection; mm/geometry/revisions untouched).
    const focusRow = el('div', 'area-focus-row', 'model-setup-row');
    const focusButton = el('button', 'focus-area', 'btn-secondary');
    focusButton.type = 'button';
    focusButton.textContent = 'Focus this area';
    focusButton.setAttribute('aria-label', 'Focus this area in the 3D preview (camera only)');
    focusButton.title = 'Focus this area in the 3D preview (camera only)';
    const focusBlocked = gesture !== null || pendingHandle !== null || curveDrag !== null;
    const focusSelected = draft.areas.find((area) => area.id === draft.selectedAreaId);
    focusButton.disabled = focusSelected === undefined || focusBlocked || !draft.productVisible || !viewerOf()?.focusSurfacePoints;
    focusButton.addEventListener('click', () => {
      const current = draft.areas.find((area) => area.id === draft.selectedAreaId);
      if (current === undefined) {
        paintStatus('Select a safe area first — then Focus this area.');
        refresh();
        return;
      }
      if (gesture !== null || pendingHandle !== null || curveDrag !== null) {
        paintStatus('Finish the active drag first — then Focus this area.');
        refresh();
        return;
      }
      const viewer = viewerOf();
      if (!viewer || typeof viewer.focusSurfacePoints !== 'function') {
        paintStatus('No live preview — show the product, then Focus this area.');
        refresh();
        return;
      }
      let normal: SetupVec3 | undefined;
      try {
        const plane = planeFromPolygon(current.points);
        if (plane && isVec3(plane.normal)) normal = { ...plane.normal };
      } catch {
        normal = undefined;
      }
      let moved = false;
      try {
        moved =
          normal !== undefined
            ? viewer.focusSurfacePoints(
                current.points.map((point) => ({ ...point })),
                { ...normal },
              )
            : viewer.focusSurfacePoints(current.points.map((point) => ({ ...point })));
      } catch {
        moved = false;
      }
      paintStatus(
        moved
          ? `Focused “${current.name}” — camera only; measurements unchanged. Fit restores the product view.`
          : 'Could not focus that area — show the product and pick a spanning patch.',
      );
      refresh();
    });
    focusRow.append(focusButton);
    const cameraControls = document.querySelector('[data-model-setup-hook="camera-controls"]');
    if (cameraControls) cameraControls.prepend(focusRow);
    else (authorTools ?? section).append(focusRow);

    // Rename + accessible corner/curve editing for the selected area.
    // Direct square handles on the model remain the primary controls.
    const selected = draft.areas.find((area) => area.id === draft.selectedAreaId);
    const editSlot = el('div', 'edit-actions-slot', 'model-setup-edit-slot');
    commands.append(editSlot);
    editSlot.style.visibility = draft.areaTool === 'edit' ? '' : 'hidden';
    if (selected === undefined) {
      const placeholder = el('button', 'handle-remove', 'btn-secondary');
      placeholder.type = 'button'; placeholder.textContent = 'Remove selected corner'; placeholder.disabled = true;
      editSlot.append(placeholder);
    }
    if (selected !== undefined && selected.points.length >= 3) {
      const renameRow = el('div', 'area-rename-row', 'model-setup-row');
      const renameLabel = document.createElement('label');
      renameLabel.className = 'model-setup-field';
      renameLabel.textContent = 'Rename selected area';
      const renameInput = document.createElement('input');
      renameInput.type = 'text';
      renameInput.value = selected.name;
      renameInput.autocomplete = 'off';
      renameInput.setAttribute(HOOK, 'area-rename');
      renameInput.setAttribute('aria-label', `Rename selected area (currently “${selected.name}”)`);
      renameLabel.append(renameInput);
      const renameApply = el('button', 'area-rename-apply', 'btn-secondary');
      renameApply.type = 'button';
      renameApply.textContent = 'Rename area';
      renameApply.addEventListener('click', () => {
        const outcome = renameSelectedArea(draft, selected.id, renameInput.value);
        if (outcome.ok) emit(entry, draft);
        paintStatus(outcome.message);
        refresh();
      });
      renameRow.append(renameLabel, renameApply);
      section.append(renameRow);

      const details = document.createElement('details'); details.open = handleDetailsOpen;
      details.addEventListener('toggle', () => { if (details.isConnected) handleDetailsOpen = details.open; });
      const summary = document.createElement('summary'); summary.textContent = 'Edit individual corners'; details.append(summary);
      const handles = el('div', 'area-handles', 'model-setup-row');
      handles.setAttribute('role', 'group');
      handles.setAttribute('aria-label', `Polygon handles for “${selected.name}”`);
      const hint = el('span', 'area-handles-hint', 'muted');
      hint.textContent = `Prefer Edit outline on the model: drag large white squares, click small edge squares (or double-click an edge) to insert, click a corner square to select it for removal below. Delete key removes the selected corner too.`;
      handles.append(hint);
      for (let index = 0; index < selected.points.length; index += 1) {
        const corner = el('button', `handle-corner-${index}`, 'btn-secondary');
        corner.type = 'button';
        corner.textContent = `Corner ${index + 1}`;
        const isArmed =
          draft.handleArm !== null &&
          draft.handleArm.areaId === selected.id &&
          draft.handleArm.kind === 'corner' &&
          draft.handleArm.index === index;
        corner.setAttribute('aria-pressed', isArmed ? 'true' : 'false');
        if (isArmed) corner.classList.add('is-selected');
        corner.addEventListener('click', () => {
          armed = null;
          draft.handleArm =
            isArmed ? null : { areaId: selected.id, kind: 'corner' as const, index };
          cancelGestureSilent();
          lastStatus = isArmed
            ? 'Handle disarmed — staged data unchanged.'
            : `Corner ${index + 1} armed: drag it on the model surface (orbit is suspended while dragging), or click its new position. Esc cancels.`;
          refresh();
        });
        handles.append(corner);
      }
      for (let index = 0; index < selected.points.length; index += 1) {
        const side = el('button', `handle-side-${index}`, 'btn-secondary');
        side.type = 'button';
        side.textContent = `Add on edge ${index + 1}`;
        const isArmed =
          draft.handleArm !== null &&
          draft.handleArm.areaId === selected.id &&
          draft.handleArm.kind === 'side' &&
          draft.handleArm.index === index;
        side.setAttribute('aria-pressed', isArmed ? 'true' : 'false');
        if (isArmed) side.classList.add('is-selected');
        side.addEventListener('click', () => {
          armed = null;
          draft.handleArm =
            isArmed ? null : { areaId: selected.id, kind: 'side' as const, index };
          cancelGestureSilent();
          lastStatus = isArmed
            ? 'Handle disarmed — staged data unchanged.'
            : `Edge selected: click the surface to insert a corner. Esc cancels.`;
          refresh();
        });
        handles.append(side);
      }
      details.append(handles); section.append(details);

      const armedCornerIndex =
        draft.handleArm !== null && draft.handleArm.areaId === selected.id && draft.handleArm.kind === 'corner'
          ? draft.handleArm.index
          : null;
      const removeRow = el('div', 'area-remove-row', 'model-setup-row');
      const removeSelected = el('button', 'handle-remove', 'btn-secondary');
      removeSelected.type = 'button';
      removeSelected.textContent = armedCornerIndex === null ? 'Remove selected corner' : `Remove corner ${armedCornerIndex + 1}`;
      removeSelected.disabled = armedCornerIndex === null;
      removeSelected.hidden = draft.curveArm !== null;
      removeSelected.setAttribute(
        'aria-label',
        armedCornerIndex === null
          ? `Remove the selected corner of “${selected.name}” (select a corner first)`
          : `Remove corner ${armedCornerIndex + 1} of “${selected.name}”`,
      );
      removeSelected.addEventListener('click', () => {
        if (armedCornerIndex === null) return;
        const outcome = removeAreaCorner(draft, selected.id, armedCornerIndex);
        if (outcome.ok) emit(entry, draft);
        paintStatus(outcome.message);
        refresh();
      });
      const removeHint = el('span', 'area-remove-hint', 'muted');
      removeHint.textContent =
        armedCornerIndex === null
          ? ''
          : `Corner ${armedCornerIndex + 1} selected — removal keeps the outline valid (minimum 3 corners).`;
      removeRow.append(removeSelected, removeHint);
      // Reuse the fixed toolbar slot; explanatory text stays in Areas.
      editSlot.append(removeSelected);
      section.append(removeHint);

      const curveDetails = document.createElement('details');
      curveDetails.open = curveDetailsOpen;
      curveDetails.addEventListener('toggle', () => {
        if (curveDetails.isConnected) curveDetailsOpen = curveDetails.open;
      });
      const curveSummary = document.createElement('summary');
      curveSummary.textContent = 'Choose edge by number';
      curveDetails.append(curveSummary);
      const curveHint = el('p', 'curve-hint', 'muted');
      curveHint.textContent = 'Or choose Bend edge above and click its + on the model. Drag the yellow diamond, then Apply bend.';
      curveDetails.append(curveHint);
      const edgeRow = el('div', 'curve-edge-row', 'model-setup-row');
      edgeRow.setAttribute('role', 'group');
      edgeRow.setAttribute('aria-label', `Curve edges of “${selected.name}”`);
      for (let edge = 0; edge < selected.points.length; edge += 1) {
        const bendButton = el('button', `curve-arm-${edge}`, 'btn-secondary');
        bendButton.type = 'button';
        bendButton.textContent = `Bend edge ${edge + 1}`;
        const isArmed =
          draft.curveArm !== null && draft.curveArm.areaId === selected.id && draft.curveArm.edge === edge;
        bendButton.setAttribute('aria-pressed', isArmed ? 'true' : 'false');
        if (isArmed) bendButton.classList.add('is-selected');
        bendButton.addEventListener('click', () => {
          armed = null;
          draft.handleArm = null;
          cancelGestureSilent();
          draft.curveArm = isArmed ? null : { areaId: selected.id, edge };
          lastStatus = isArmed
            ? 'Bend disarmed — outline unchanged.'
            : `Edge ${edge + 1} armed: drag the diamond handle on the model or move the slider, then Apply bend. Escape cancels.`;
          refresh();
        });
        edgeRow.append(bendButton);
      }
      curveDetails.append(edgeRow);
      const armedCurveEdge =
        draft.curveArm !== null && draft.curveArm.areaId === selected.id ? draft.curveArm.edge : null;
      if (armedCurveEdge !== null) {
        const bendRow = el('div', 'curve-bend-row', 'model-setup-row');
        const bendLabel = document.createElement('label');
        bendLabel.className = 'model-setup-field';
        bendLabel.textContent = 'Curvature';
        const bendInput = document.createElement('input');
        bendInput.type = 'range';
        bendInput.min = String(-CURVE_BEND_LIMIT_PX);
        bendInput.max = String(CURVE_BEND_LIMIT_PX);
        bendInput.step = '1';
        bendInput.value = String(draft.curveBendPx);
        bendInput.setAttribute(HOOK, 'curve-bend');
        bendInput.setAttribute('aria-label', `Bend amount for edge ${armedCurveEdge + 1} in screen pixels`);
        bendInput.addEventListener('input', () => {
          const value = Number(bendInput.value);
          if (Number.isFinite(value)) draft.curveBendPx = value;
          syncCurveHandle();
        });
        bendLabel.append(bendInput);
        const bendApply = el('button', 'curve-apply', 'btn-primary');
        bendApply.type = 'button';
        bendApply.textContent = 'Apply bend';
        bendApply.addEventListener('click', () => {
          const outcome = commitCurveBend(draft, selected.id, armedCurveEdge, draft.curveBendPx);
          if (outcome.ok) emit(entry, draft);
          paintStatus(outcome.message);
          refresh();
        });
        const bendCancel = el('button', 'curve-cancel', 'btn-secondary');
        bendCancel.type = 'button';
        bendCancel.textContent = 'Cancel bend';
        bendCancel.setAttribute('aria-label', bendCancel.textContent);
        bendCancel.title = bendCancel.textContent;
        bendCancel.addEventListener('click', () => {
          draft.curveArm = null;
          lastStatus = 'Bend cancelled — outline unchanged.';
          refresh();
        });
        bendRow.append(bendLabel, bendApply, bendCancel);
        // Reuse the reserved edit row instead of moving the model when
        // the bend preview exposes its Apply and Cancel actions.
        bendRow.classList.add('model-setup-bend-actions');
        editSlot.append(bendRow);
      }
      section.append(curveDetails);
    }

    const recompute = el('button', 'areas-recompute', 'btn-secondary');
    recompute.type = 'button';
    const staleCount = draft.areas.filter((a) => a.status === 'stale').length;
    recompute.textContent = `Recompute ${staleCount} stale area(s)`;
    recompute.title = 'Recompute these areas under the current calibration';
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
    const commitTools = document.querySelector('[data-model-setup-hook="commit-tools"]');
    if (staleCount > 0 && (!draft.fitted || draft.fitStale)) {
      const fit = el('button', 'areas-fit-scale', 'btn-secondary');
      fit.type = 'button';
      fit.textContent = 'Fit scale to use these areas';
      fit.addEventListener('click', () => {
        openContext('measure');
        paintStatus('Your areas are kept. Pick two reference points and enter their real distance, fit the scale, then recompute and save the setup.');
      });
      (commitTools ?? section).append(fit);
    }
    if (commitTools) { recompute.hidden = staleCount === 0; commitTools.append(recompute); }
    else section.append(recompute);
    root.append(section);
  }

  /**
   * View controls adjacent to the preview (zoom + visibility), rendered into
   * the lead-provided mount `[data-model-setup-hook="viewbar"]` directly
   * above the canvas. Fallback: when the lead mount is absent, create the
   * same hooked node as the canvas's previous sibling so controls still sit
   * adjacent to the preview, never beneath the reference/area forms. The
   * visibility controls below were removed to avoid duplication: hiding a
   * layer is display-only and never discards staged data.
   */
  function renderViewbar(
    scope: { entry: ModelSetupProduct; draft: ProductDraft } | null,
    paintStatus: (message: string) => void,
  ): void {
    let mount = document.querySelector('[data-model-setup-hook="viewbar"]');
    if (mount === null) {
      const canvas = canvasOf();
      const stage = canvas !== null && canvas.parentElement !== null ? canvas.parentElement : null;
      if (stage === null) return;
      const bar = document.createElement('div');
      bar.setAttribute(HOOK, 'viewbar');
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', '3D preview view controls');
      stage.parentElement?.insertBefore(bar, stage);
      ownedViewbar = bar;
      mount = bar;
    } else if (ownedViewbar !== null && mount !== ownedViewbar) {
      // The lead mount arrived after the fallback: retire the fallback so
      // controls are never duplicated.
      ownedViewbar.remove();
      ownedViewbar = null;
    }
    mount.replaceChildren();
    const tools = el('div', 'author-tools', 'model-setup-author-tools');
    mount.append(tools);
    const cameraControls = el('div', 'camera-controls', 'model-setup-camera-controls');
    cameraControls.setAttribute('role', 'group');
    cameraControls.setAttribute('aria-label', 'Camera and display controls (scroll for more)');
    cameraControls.id = 'model-setup-view-controls';
    viewControls = cameraControls;
    const toggle = el('button', 'view-toggle', 'model-setup-view-toggle');
    toggle.type = 'button';
    toggle.textContent = 'View';
    toggle.style.display = 'none';
    toggle.setAttribute('aria-label', 'View controls');
    toggle.setAttribute('aria-controls', cameraControls.id);
    viewToggle = toggle;
    toggle.addEventListener('click', () => setViewControlsOpen(!viewControlsOpen));
    setViewControlsOpen(viewControlsOpen);
    mount.append(toggle, cameraControls);
    const modeHint = el('p', 'mode-hint', 'muted');
    modeHint.setAttribute('tabindex', '0');
    const tool = scope?.draft.areaTool ?? 'rotate';
    modeHint.textContent = panMode ? 'Pan model: drag to reposition the view. Measurements stay unchanged.' : tool === 'rotate' ? 'Rotate model: drag to inspect. Choose Edit outline to reshape the selected area, Rectangle or Polygon to draw.'
      : tool === 'edit' ? 'Drag points to reshape. Click + to add, or choose Bend edge. Select a point to remove it.'
      : tool === 'rectangle' ? 'Rectangle: drag diagonally on the model; flat patches add one 4-corner area, curved patches follow the surface. Release to add.'
      : 'Polygon: click to add corners; click the first square or Enter to close. Backspace undoes; Escape cancels.';
    // Hint and action feedback share one fixed row. A status message takes
    // priority without adding a second row or moving the model.
    const feedback = el('div', 'feedback', 'model-setup-feedback');
    modeHint.hidden = lastStatus.length > 0;
    feedback.append(modeHint);
    tools.append(feedback);
    const viewer = viewerOf();
    const zoomOf = (): number => {
      try {
        return viewer?.getZoomPercent?.() ?? 100;
      } catch {
        return 100;
      }
    };
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.textContent = '−';
    zoomOut.setAttribute('data-ps-view', 'zoom-out');
    zoomOut.setAttribute('aria-label', 'Zoom out');
    zoomOut.addEventListener('click', () => {
      stepZoom(-1);
      syncViewbar(scope);
    });
    const zoomSelect = document.createElement('select');
    zoomSelect.setAttribute('data-ps-view', 'zoom');
    zoomSelect.setAttribute('aria-label', 'Zoom percentage (camera readout)');
    for (const step of VIEW_ZOOM_STEPS) {
      const option = document.createElement('option');
      option.value = String(step);
      option.textContent = `${step}%`;
      zoomSelect.append(option);
    }
    zoomSelect.value = String(zoomOf());
    zoomSelect.addEventListener('change', () => {
      try {
        viewer?.setZoomPercent?.(Number(zoomSelect.value));
      } catch {
        return;
      }
      syncViewbar(scope);
    });
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.textContent = '+';
    zoomIn.setAttribute('data-ps-view', 'zoom-in');
    zoomIn.setAttribute('aria-label', 'Zoom in');
    zoomIn.addEventListener('click', () => {
      stepZoom(1);
      syncViewbar(scope);
    });
    const fit = document.createElement('button');
    fit.type = 'button';
    fit.textContent = 'Fit';
    fit.setAttribute('data-ps-view', 'fit');
    fit.setAttribute('aria-label', 'Fit product view (100%)');
    fit.addEventListener('click', () => {
      try {
        if (viewer?.fitCurrentView) viewer.fitCurrentView(); else viewer?.resetZoom?.();
      } catch {
        return;
      }
      syncViewbar(scope);
    });
    const pan = el('button', 'pan', 'btn-secondary');
    pan.type = 'button'; pan.textContent = 'Pan'; pan.setAttribute('aria-pressed', String(panMode));
    pan.addEventListener('click', () => {
      cancelGestureSilent(); armed = null;
      const current = currentDraft(); if (!('error' in current)) { current.draft.handleArm = null; current.draft.areaTool = 'rotate'; }
      panMode = !panMode; refresh();
    });
    cameraControls.append(zoomOut, zoomSelect, zoomIn, fit, pan);
    for (const side of ['front', 'back'] as const) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = side === 'front' ? 'Front' : 'Back';
      button.setAttribute(HOOK, `view-${side}`);
      button.disabled = !viewer?.setViewSide;
      button.addEventListener('click', () => viewerOf()?.setViewSide?.(side));
      cameraControls.append(button);
    }
    const toggles: Array<{ view: string; hook: string; label: string; pressed: boolean }> = [
      {
        view: 'vis-anchors',
        hook: 'toggle-anchors',
        label: 'Anchors',
        pressed: scope?.draft.anchorsVisible ?? true,
      },
      {
        view: 'vis-areas',
        hook: 'toggle-safe',
        label: 'Safe areas',
        pressed: scope?.draft.safeAreasVisible ?? true,
      },
      {
        view: 'vis-product',
        hook: 'toggle-product',
        label: 'Product',
        pressed: scope?.draft.productVisible ?? true,
      },
    ];
    for (const toggle of toggles) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = toggle.label;
      button.setAttribute('data-ps-view', toggle.view);
      button.setAttribute(HOOK, toggle.hook);
      button.setAttribute('aria-pressed', toggle.pressed ? 'true' : 'false');
      button.disabled = scope === null;
      button.addEventListener('click', () => {
        if (scope === null) return;
        const { entry, draft } = scope;
        if (toggle.view === 'vis-anchors') draft.anchorsVisible = !draft.anchorsVisible;
        else if (toggle.view === 'vis-areas') draft.safeAreasVisible = !draft.safeAreasVisible;
        else draft.productVisible = !draft.productVisible;
        button.setAttribute(
          'aria-pressed',
          (toggle.view === 'vis-anchors'
            ? draft.anchorsVisible
            : toggle.view === 'vis-areas'
              ? draft.safeAreasVisible
              : draft.productVisible
          ).toString(),
        );
        paintStatus(
          toggle.view === 'vis-anchors'
            ? draft.anchorsVisible
              ? 'Anchors shown (reference endpoints plus the connecting measurement). Staged picks are unchanged.'
              : 'Anchors hidden (reference endpoints plus the connecting measurement). Staged picks are kept.'
            : toggle.view === 'vis-areas'
              ? draft.safeAreasVisible
                ? 'Safe areas shown (fills, outlines and handles). Staged polygons are unchanged.'
                : 'Safe areas hidden (fills, outlines and handles). Staged polygons are kept.'
              : draft.productVisible
                ? 'Product shown. Staged reference and areas are unchanged.'
                : 'Product hidden (geometry only — overlays, camera and staged data are kept). Surface picking is blocked until shown again.',
        );
        emit(entry, draft);
        paintViewer(draft);
      });
      cameraControls.append(button);
    }
    syncViewbar(scope);
  }

  /** Step the display zoom through the supported values (camera only). */
  function stepZoom(direction: -1 | 1): void {
    try {
      const viewer = viewerOf();
      if (!viewer?.setZoomPercent) return;
      let current = 100;
      try {
        current = viewer.getZoomPercent?.() ?? 100;
      } catch {
        current = 100;
      }
      let index = (VIEW_ZOOM_STEPS as readonly number[]).indexOf(current);
      if (index < 0) {
        let best = 0;
        let bestErr = Infinity;
        VIEW_ZOOM_STEPS.forEach((step, stepIndex) => {
          const err = Math.abs(step - current);
          if (err < bestErr) {
            bestErr = err;
            best = stepIndex;
          }
        });
        index = best;
      }
      const next = VIEW_ZOOM_STEPS[Math.min(VIEW_ZOOM_STEPS.length - 1, Math.max(0, index + direction))];
      if (next !== undefined) viewer.setZoomPercent(next);
    } catch {
      return;
    }
  }

  /** Patch zoom readout/disabled state in place (no rebuild, keeps focus). */
  function syncViewbar(scope: { entry: ModelSetupProduct; draft: ProductDraft } | null): void {
    try {
      const mount = document.querySelector('[data-model-setup-hook="viewbar"]');
      if (mount === null) return;
      let zoom = 100;
      try {
        zoom = viewerOf()?.getZoomPercent?.() ?? 100;
      } catch {
        zoom = 100;
      }
      const select = mount.querySelector<HTMLSelectElement>('[data-ps-view="zoom"]');
      if (select !== null) {
        if (!Array.from(select.options).some((option) => option.value === String(zoom))) {
          const current = document.createElement('option');
          current.value = String(zoom); current.textContent = `${zoom}%`;
          current.dataset.currentZoom = 'true';
          select.querySelectorAll('[data-current-zoom]').forEach((option) => option.remove());
          select.append(current);
        }
        select.value = String(zoom);
      }
      const out = mount.querySelector<HTMLButtonElement>('[data-ps-view="zoom-out"]');
      if (out !== null) out.disabled = zoom <= VIEW_ZOOM_STEPS[0]!;
      const into = mount.querySelector<HTMLButtonElement>('[data-ps-view="zoom-in"]');
      if (into !== null) into.disabled = zoom >= VIEW_ZOOM_STEPS[VIEW_ZOOM_STEPS.length - 1]!;
      void scope;
    } catch {
      return;
    }
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
    // Hook MUST stay `advanced`: the enlarged-workspace More task shows only
    // the child whose hook is exactly `advanced` (see applyContextTask), so a
    // different hook here renders an empty More panel.
    details.setAttribute(HOOK, 'advanced');
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
    cancelGestureSilent(); draft.handleArm = null; draft.curveArm = null;
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

  /** Raycast one surface pick; null on any miss or bad input. Never throws. */
  function safePick(
    viewer: ModelSetupViewerLike,
    clientX: number,
    clientY: number,
  ): SetupVec3 | null {
    try {
      const hit =
        viewer.pickSurface?.(clientX, clientY) ??
        viewer.pickSurfaceFromEvent({ clientX, clientY });
      if (hit === null || typeof hit !== 'object') return null;
      if (!isVec3(hit.modelPosition)) return null;
      return { x: hit.modelPosition.x, y: hit.modelPosition.y, z: hit.modelPosition.z };
    } catch {
      return null;
    }
  }

  /**
   * Detailed surface pick (position + real mesh face normal), or null when
   * the viewer has no detailed API or the pick misses/is degenerate.
   * Never throws; never invents points or normals.
   */
  function safePickDetailed(
    viewer: ModelSetupViewerLike,
    clientX: number,
    clientY: number,
  ): { point: SetupVec3; normal: SetupVec3 } | null {
    try {
      const detailed = viewer.pickSurfaceDetailed?.(clientX, clientY) ?? null;
      if (detailed === null || typeof detailed !== 'object') return null;
      if (!isVec3(detailed.modelPosition) || !isVec3(detailed.normal)) return null;
      if (!(norm3(detailed.normal) > 1e-12)) return null;
      return {
        point: { x: detailed.modelPosition.x, y: detailed.modelPosition.y, z: detailed.modelPosition.z },
        normal: { x: detailed.normal.x, y: detailed.normal.y, z: detailed.normal.z },
      };
    } catch {
      return null;
    }
  }

  function maybeStartGesture(event: PointerEvent): void {
    if (gesture !== null || downAt === null) return;
    if (armed !== null && !(armed === 'areaPoint')) return;
    const resolved = currentDraft();
    if ('error' in resolved) return;
    const { entry, draft } = resolved;
    if (draft.productVisible !== true) {
      lastStatus = 'Product hidden — show the product to pick surface points. Staged reference and areas are unchanged.';
      refresh();
      return;
    }
    const viewer = viewerOf();
    if (!viewer) return;
    const start = safePick(viewer, downAt.x, downAt.y);
    if (start === null) return; // press missed: orbit continues, release reports it.
    if (draft.handleArm !== null && armed === null) {
      gesture = { kind: 'handle', entry, draft, handle: { ...draft.handleArm } };
    } else if (draft.areaTool === 'rectangle' && armed === null) {
      const detailed = safePickDetailed(viewer, downAt.x, downAt.y);
      gesture = {
        kind: 'rect',
        entry,
        draft,
        corner0: start,
        normal0: detailed?.normal ?? null,
        misses: 0,
        downX: downAt.x,
        downY: downAt.y,
      };

    } else {
      return;
    }
    suspendOrbit();
    try {
      canvasOf()?.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
  }

  function updateGesture(event: PointerEvent): void {
    if (gesture === null) return;
    const viewer = viewerOf();
    if (!viewer) return;
    const hit = safePick(viewer, event.clientX, event.clientY);
    if (gesture.kind === 'rect') {
      if (hit === null) {
        gesture.misses += 1;
        return;
      }
      paintDrawingOutline(null, { x0: gesture.downX, y0: gesture.downY, x1: event.clientX, y1: event.clientY });
      return;
    }
    const active = gesture;
    if (active.kind !== 'handle') return;
    const area = active.draft.areas.find((candidate) => candidate.id === active.handle.areaId);
    if (area === undefined || hit === null) {
      if (hit === null) livePreview = null;
      paintViewer(active.draft);
      return;
    }
    const next = geometryForHandleMove(area.points, active.handle, hit);
    livePreview = next !== null && next.length >= 3 ? next : null;
    paintViewer(active.draft);
  }

  function finishGesture(event: PointerEvent): void {
    const active = gesture;
    gesture = null;
    restoreOrbit();
    livePreview = null;
    try {
      canvasOf()?.releasePointerCapture(event.pointerId);
    } catch {
      // Capture already released (or never acquired): the release commit
      // below must still run exactly once.
    }
    if (active === null) return;
    const viewer = viewerOf();
    if (viewer === null) return;
    const release = safePick(viewer, event.clientX, event.clientY);
    if (active.kind === 'rect') {
      if (release === null) {
        lastStatus = 'Release missed the model surface — end the drag on the model. Previous draft kept.';
        refresh();
        return;
      }
      const releaseDetailed = safePickDetailed(viewer, event.clientX, event.clientY);
      const resolved = resolveDragRectangle(
        viewer,
        { point: active.corner0, normal: active.normal0 },
        { point: release, normal: releaseDetailed?.normal ?? null },
        { x: active.downX, y: active.downY },
        { x: event.clientX, y: event.clientY },
      );
      // One staged edit per release; failures preserve the last valid draft.
      // A planar 4-corner resolve fails on curved garments (normals diverge,
      // off-plane support, unverifiable corners): fall back to a
      // surface-following perimeter ring built only from real raycast hits,
      // so a rectangle drag still authors a visible named area instead of
      // dying on curvature. The kernel ring check still gates the result.
      if ('corners' in resolved) {
        lastStatus = stageReleasedCorners(active.entry, active.draft, resolved.corners, 'rectangle drag');
      } else {
        const perimeter = resolveDragPerimeter(
          viewer,
          { x: active.downX, y: active.downY },
          { x: event.clientX, y: event.clientY },
        );
        if ('ring' in perimeter && perimeter.ring.length >= 3) {
          lastStatus = stageReleasedCorners(active.entry, active.draft, perimeter.ring, 'rectangle drag');
        } else {
          lastStatus = 'error' in perimeter ? perimeter.error : resolved.error;
        }
      }
      refresh();
      return;
    }
    const area = active.draft.areas.find((candidate) => candidate.id === active.handle.areaId);
    if (area === undefined) {
      lastStatus = 'That area is no longer staged — nothing changed.';
      refresh();
      return;
    }
    if (release === null) {
      lastStatus = `Release missed the model surface — “${area.name}” kept unchanged.`;
      refresh();
      return;
    }
    const outcome = commitHandlePoint(active.draft, active.handle, release);
    active.draft.handleArm = null;
    lastStatus = outcome.message;
    if (outcome.ok) emit(active.entry, active.draft);
    refresh();
  }

  function onCanvasDown(event: PointerEvent): void {
    if (destroyed || !active || event.button !== 0 || !event.isPrimary) return;
    // Gate on the LIVE canvas (the lead replaces the canvas per viewer
    // attach, so a captured element would go stale).
    if (event.target !== canvasOf()) return;
    setViewControlsOpen(false);
    if (panMode) return;
    contextPanel?.close();
    downAt = { x: event.clientX, y: event.clientY, button: event.button, pointerId: event.pointerId };
    const resolved = currentDraft();
    if ('error' in resolved) return;
    const draft = resolved.draft;
    if (draft.productVisible && (armed !== null || draft.handleArm !== null || draft.areaTool === 'rectangle')) {
      // Capture phase runs BEFORE OrbitControls receives pointerdown, so it
      // cannot rotate the surface under the first drawing movement.
      suspendOrbit();
      try { canvasOf()?.setPointerCapture(event.pointerId); } catch { /* no capture */ }
    }
  }

  function onCanvasMove(event: PointerEvent): void {
    if (!active || panMode) return;
    if (destroyed) return;
    // A dragged bend diamond adjusts the armed edge's screen-space offset.
    // Commits happen only through Apply bend (atomic, surface-verified).
    if (curveDrag !== null) {
      const resolved = currentDraft();
      if ('error' in resolved) {
        curveDrag = null;
        restoreOrbit();
        return;
      }
      const edge = curveEdgeScreen(resolved.draft);
      if (edge !== null) {
        const dx = edge.to.x - edge.from.x;
        const dy = edge.to.y - edge.from.y;
        const len = Math.hypot(dx, dy);
        if (len > 1) {
          const along =
            (event.clientX - curveDrag.startX) * (-dy / len) + (event.clientY - curveDrag.startY) * (dx / len);
          resolved.draft.curveBendPx = Math.max(
            -CURVE_BEND_LIMIT_PX,
            Math.min(CURVE_BEND_LIMIT_PX, curveDrag.startBend + along),
          );
          const slider = document.querySelector<HTMLInputElement>('[data-model-setup-hook="curve-bend"]');
          if (slider) slider.value = String(Math.round(resolved.draft.curveBendPx));
        }
      }
      syncCurveHandle();
      return;
    }
    // A pressed direct handle turns into a handle gesture past the travel
    // threshold; orbit was already suspended at press, so the camera cannot
    // rotate under the drag.
    if (pendingHandle !== null) {
      const travel = Math.hypot(event.clientX - pendingHandle.x, event.clientY - pendingHandle.y);
      if (!Number.isFinite(travel) || !(travel > CLICK_TRAVEL_PX)) return;
      const resolved = currentDraft();
      if ('error' in resolved) {
        pendingHandle = null;
        restoreOrbit();
        return;
      }
      const { entry, draft } = resolved;
      gesture = { kind: 'handle', entry, draft, handle: { ...pendingHandle.ref } };
      pendingHandle = null;
      updateGesture(event);
      return;
    }
    if (gesture !== null) {
      updateGesture(event);
      return;
    }
    if (downAt === null || (event.buttons & 1) !== 1) return;
    if (event.target !== canvasOf()) return;
    const travel = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
    if (!Number.isFinite(travel) || !(travel > CLICK_TRAVEL_PX)) return;
    maybeStartGesture(event);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (destroyed || (gesture === null && pendingHandle === null && downAt === null && curveDrag === null)) return;
    void event;
    gesture = null;
    pendingHandle = null;
    downAt = null;
    curveDrag = null;
    livePreview = null;
    restoreOrbit();
    lastStatus = 'Edit cancelled (pointer interrupted) — staged data unchanged.';
    refresh();
  }

  function onCanvasUp(event: PointerEvent): void {
    if (!active || panMode) return;
    if (destroyed) return;
    // A dragged bend diamond ends as a preview value: Apply bend commits.
    if (curveDrag !== null) {
      curveDrag = null;
      restoreOrbit();
      const resolved = currentDraft();
      if (!('error' in resolved)) {
        lastStatus = `Bend ${Math.round(resolved.draft.curveBendPx)} px — Apply bend to bake surface points, or Cancel bend.`;
      }
      refresh();
      return;
    }
    if (gesture === null && pendingHandle === null) {
      restoreOrbit();
      try { canvasOf()?.releasePointerCapture(event.pointerId); } catch { /* no capture */ }
    }
    // A pressed direct handle released without a drag arms it for
    // click-to-move (the existing button-fallback path takes it over).
    if (pendingHandle !== null) {
      const pending = pendingHandle;
      pendingHandle = null;
      restoreOrbit();
      const resolved = currentDraft();
      if (!('error' in resolved)) {
        resolved.draft.handleArm = { ...pending.ref };
        armed = null;
        lastStatus = pending.ref.kind === 'corner'
          ? `Corner ${pending.ref.index + 1} armed: drag it on the model surface, or click its new position. Esc cancels.`
          : `Side ${pending.ref.index + 1} armed: drag it on the model surface (the opposite side stays fixed), or click its new position. Esc cancels.`;
      }
      refresh();
      return;
    }
    // A captured gesture drag keeps the canvas as target; plain clicks must
    // land on the live canvas.
    if (gesture === null && event.target !== canvasOf()) return;
    const down = downAt;
    downAt = null;
    if (gesture !== null) {
      finishGesture(event);
      return;
    }
    if (down === null || event.button !== 0) return;
    const travel = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (!Number.isFinite(travel)) return;
    const resolved = currentDraft();
    if ('error' in resolved) return;
    const { entry, draft } = resolved;
    const viewer = viewerOf();
    if (!viewer) return;
    if (travel > CLICK_TRAVEL_PX) {
      // A draw-intent press suspends orbit and captures the pointer, so a
      // missed press otherwise ends in a silent no-op with a frozen camera.
      // Name the miss explicitly; plain navigation drags stay silent.
      const drawIntent = armed !== null || draft.handleArm !== null || draft.areaTool !== 'rotate';
      if (gesture === null && pendingHandle === null && drawIntent) {
        lastStatus =
          armed === 'refA' || armed === 'refB'
            ? 'Reference points use clicks — click directly on the model without dragging. Nothing recorded.'
            : armed === 'areaPoint'
              ? 'Polygon uses point clicks. Click to add a corner; dragging adds no points.'
              : 'That press missed the model surface — start the drag on the model itself. Staged data kept.';
        refresh();
      }
      return;
    }
    if (armed === null) {
      // Unarmed taps: handle click-to-move, rectangle tap hint, else orbit.
      if (!(travel <= CLICK_TRAVEL_PX)) return;
      // Hidden product blocks surface picking clearly: the raycast target is
      // invisible, so any hit would be a guess — refuse with a route instead.
      // Reference, areas, fit and overlays are untouched; showing the product
      // resumes picking exactly where it left off.
      if (!draft.productVisible) {
        lastStatus = 'Product hidden — show the product to pick surface points. Staged reference and areas are unchanged.';
        refresh();
        return;
      }
      const hit = safePick(viewer, event.clientX, event.clientY);
      if (hit === null) {
        // Taps off the surface are orbit intent — stay silent unless a handle,
        // a rectangle tap or an edit tap expected a pick.
        if (draft.handleArm !== null || draft.areaTool === 'rectangle' || draft.areaTool === 'edit') {
          lastStatus = 'That click missed the model surface — nothing was recorded. Orbit and click the surface itself.';
          refresh();
        }
        return;
      }
      if (draft.handleArm !== null) {
        const outcome = commitHandlePoint(draft, draft.handleArm, hit);
        draft.handleArm = null;
        lastStatus = outcome.message;
        if (outcome.ok) emit(entry, draft);
        refresh();
        return;
      }
      if (draft.areaTool === 'rectangle') {
        lastStatus = 'Taps do not create rectangles — press at one corner, drag to the opposite corner, release.';
        refresh();
      }
      if (draft.areaTool === 'edit') {
        lastStatus = 'Edit outline: drag a white square, or double-click an edge to insert a corner on the model.';
        refresh();
      }
      return;
    }
    if (!(travel <= CLICK_TRAVEL_PX)) return;
    // Hidden product blocks surface picking clearly: the raycast target is
    // invisible, so any hit would be a guess — refuse with a route instead.
    // Reference, areas, fit and overlays are untouched; showing the product
    // resumes picking exactly where it left off.
    if (!draft.productVisible) {
      lastStatus = 'Product hidden — show the product to pick surface points. Staged reference and areas are unchanged.';
      refresh();
      return;
    }
    const hit = safePick(viewer, event.clientX, event.clientY);
    if (!hit) {
      lastStatus = 'That click missed the model surface — nothing was recorded. Orbit and click the surface itself.';
      refresh();
      return;
    }
    const point: SetupVec3 = { x: hit.x, y: hit.y, z: hit.z };
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
      if (which === 'refB') openContext('measure');
      return;
    }
    if (armed === 'areaPoint') {
      if (!draft.drawing) draft.drawing = [];
      if (draft.drawing.length >= POLYGON_POINT_LIMIT) { lastStatus = 'Polygon limit reached (512 points). Finish or undo a corner.'; refresh(); return; }
      draft.drawing.push(point);
      lastStatus = `Area point ${draft.drawing.length} recorded on the surface. Finish at 3 or more.`;
      emit(entry, draft);
      refresh();
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (destroyed || !active) return;
    if (event.key === 'Escape' && viewControlsOpen && viewToggle?.getClientRects().length) {
      setViewControlsOpen(false);
      viewToggle?.focus({ preventScroll: true });
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    const resolvedDrawing = currentDraft();
    const drawing = 'error' in resolvedDrawing ? null : resolvedDrawing.draft;
    if (drawing?.areaTool === 'freehand' && drawing.drawing !== null) {
      if (event.key === 'Enter') {
        if (target instanceof HTMLButtonElement) return;
        event.preventDefault(); event.stopImmediatePropagation();
        document.querySelector<HTMLButtonElement>('[data-model-setup-hook="area-finish"]')?.click(); return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault(); event.stopImmediatePropagation(); drawing.drawing.pop();
        lastStatus = `Last corner undone (${drawing.drawing.length} points).`; refresh(); return;
      }
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); cancelGestureSilent();
        drawing.drawing = null; drawing.areaTool = 'rotate'; armed = null;
        lastStatus = 'Drawing cancelled; nothing was committed.'; refresh(); return;
      }
    }
    // Delete/Backspace removes the selected (armed) corner anywhere outside
    // text fields — the same action as the visible Remove button. Polygon
    // drawing keeps Backspace for undo, so it is excluded here.
    if ((event.key === 'Delete' || event.key === 'Backspace') && drawing !== null) {
      const leavingDrawingAlone = drawing.areaTool === 'freehand' && drawing.drawing !== null;
      const arm = drawing.handleArm;
      if (!leavingDrawingAlone && arm !== null && arm.kind === 'corner') {
        const area = drawing.areas.find((candidate) => candidate.id === arm.areaId);
        if (area !== undefined && 'entry' in resolvedDrawing) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const outcome = removeAreaCorner(drawing, arm.areaId, arm.index);
          if (outcome.ok) emit(resolvedDrawing.entry, drawing);
          lastStatus = outcome.message;
          refresh();
          return;
        }
      }
    }
    if (event.key !== 'Escape') return;
    if (gesture !== null || pendingHandle !== null || downAt !== null || armed !== null || drawing?.handleArm || drawing?.curveArm || curveDrag !== null) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
    // Escape/pointercancel rolls back any draw/edit gesture: staged data is
    // untouched because commits happen only on release.
    if (gesture !== null || pendingHandle !== null || downAt !== null) {
      cancelGestureSilent();
      armed = null;
      const current = currentDraft();
      if (!('error' in current) && current.draft.areaTool !== 'edit') current.draft.areaTool = 'rotate';
      restoreOrbit();
      lastStatus = 'Edit cancelled — staged data unchanged.';
      refresh();
      return;
    }
    if (armed !== null) {
      armed = null;
      const current = currentDraft();
      if (!('error' in current) && current.draft.areaTool !== 'edit') current.draft.areaTool = 'rotate';
      lastStatus = 'Pick cancelled — staged data unchanged.';
      refresh();
      return;
    }
    const resolved = currentDraft();
    if (!('error' in resolved)) {
      let cleared: string | null = null;
      if (resolved.draft.curveArm !== null) {
        cancelGestureSilent();
        resolved.draft.curveArm = null;
        cleared = 'Bend cancelled — outline unchanged.';
      }
      if (resolved.draft.handleArm !== null) {
        resolved.draft.handleArm = null;
        cleared = cleared ?? 'Handle disarmed — staged data unchanged.';
      }
      if (cleared !== null) {
        lastStatus = cleared;
        refresh();
      }
    }
  }

  // Document-level pointer gating (see onCanvasDown): survives the lead's
  // per-attach canvas replacement, unlike element-bound listeners.
  document.addEventListener('pointerdown', onCanvasDown, true);
  document.addEventListener('pointermove', onCanvasMove);
  document.addEventListener('pointerup', onCanvasUp);
  document.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('dblclick', onCanvasDoubleClick);
  document.addEventListener('keydown', onKeyDown, true);

  return {
    refresh,
    setActive(next) {
      if (active === next) return;
      active = next;
      if (!active) {
        cancelGestureSilent(); contextPanel?.close(); setViewControlsOpen(false);
        if (settleTimer !== null) {
          try { clearTimeout(settleTimer); } catch { /* timer already fired */ }
          settleTimer = null;
        }
        lastFrameRevision = -1;
        lastFrameDraftKey = '';
        if (handleLayer) handleLayer.style.display = 'none';
        if (curveHandleEl) curveHandleEl.style.display = 'none';
        if (drawingOutline) drawingOutline.style.display = 'none';
      } else { framedViewer = null; refresh(); }
    },
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
      if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
      if (contextPanel) {
        if (originalParent) originalParent.insertBefore(container, originalNext?.parentNode === originalParent ? originalNext : null);
        contextPanel.destroy(); contextPanel = null;
      }
      resizeObserver.disconnect(); container.removeEventListener('scroll', syncOverflow);
      viewerOf()?.setInteractionMode?.('select');
      armed = null;
      pendingHandle = null;
      cancelGestureSilent();
      try {
        if (framedViewer) framedViewer.onFrame = null;
      } catch {
        /* best-effort teardown */
      }
      framedViewer = null;
      try {
        handleLayer?.remove();
      } catch {
        /* best-effort teardown */
      }
      handleLayer = null;
      drawingOutline?.remove(); drawingOutline = null;
      handleDots = [];
      handleModelsCache = [];
      document.removeEventListener('dblclick', onCanvasDoubleClick);
      curveHandleEl?.remove(); curveHandleEl = null;
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onCanvasDown, true);
      document.removeEventListener('pointermove', onCanvasMove);
      document.removeEventListener('pointerup', onCanvasUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      if (ownedViewbar !== null) {
        ownedViewbar.remove();
        ownedViewbar = null;
      }
      container.replaceChildren();
    },
  };
}
