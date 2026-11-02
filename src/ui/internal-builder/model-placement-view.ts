/// <reference lib="dom" />
import { ModelViewer, normalizeModelLighting, type SurfaceArtworkItem } from '../../viewer/model-viewer.js';
import { modelPointFromMm, regionMmFromModel, type ModelPoint, type ModelRegionFrame } from '../../core/model-placement/index.js';
import { rotatedFootprintCorners } from '../../core/operation-measurements/index.js';
import { normalizeDeg, rotationSnapDeg, snapFootprint, cornerSafeMeasurements, type AlignGuide, type MmPolygon } from '../../core/placement-manipulation/index.js';
import {
  beginEdit,
  resizeCorner as resizeCornerTx,
  scaleCandidate as scaleCandidateTx,
  setCandidateHeight as setCandidateHeightTx,
  setCandidateWidth as setCandidateWidthTx,
  type RatioPolicy,
} from '../../core/placement-manipulation/edit-transaction.js';
import { pointInPolygon } from '../../core/geometry/index.js';
import type { Placement } from '../../core/types.js';

export interface ModelPlacementRegion { id: string; frame: ModelRegionFrame; pointsModel: ModelPoint[] }
export interface ModelPlacementScene {
  key: string;
  bytes: Uint8Array;
  regions: ModelPlacementRegion[];
  /** Presentation-only lighting multiplier for this scope (default 1 when absent). */
  lighting?: number;
}
export interface ModelPlacementItem {
  index: number;
  placement: Placement;
  imageSrc: string | null;
  fits: boolean;
  /**
   * Persisted ratio policy for unified candidate/committed edits (owner:
   * placement-workspace ratioLocks, survives commits and selection).
   * Null/undefined means unlocked free-form editing.
   */
  lock?: { ratio: number } | null;
}
interface ViewData { anchors?: Array<{ id: string; model: ModelPoint; regionId?: string }>; scene: ModelPlacementScene; items: ModelPlacementItem[]; selectedIndex: number; activeRegionId: string | null; revision: string; status: string }
/** Geometry patch for a committed resize/rotate/move. Only changed fields are set. */
export interface ModelPlacementCommitPatch { pos?: { xMm: number; yMm: number }; widthMm?: number; heightMm?: number; rotationDeg?: number }
export interface ModelPlacementView {
  element: HTMLElement;
  update(data: ViewData | null): void;
  beginAnchorPick(name: string): void;
  dropPoint(clientX: number, clientY: number): { regionId: string; pos: { xMm: number; yMm: number } } | null;
  destroy(): void;
}

/** Committed geometry snapshot plus a live transient candidate, all in region millimetres. */
interface PreviewGeom { xMm: number; yMm: number; widthMm: number; heightMm: number; rotationDeg: number }
type ActiveOp =
  | { mode: 'move'; index: number; pointer: number; frame: ModelRegionFrame; safe: MmPolygon; base: PreviewGeom; offset: { xMm: number; yMm: number }; startX: number; startY: number; revision: string; geom: PreviewGeom | null }
  | { mode: 'adjust'; index: number; revision: string; safe: MmPolygon; base: PreviewGeom; geom: PreviewGeom; control: HTMLElement | null }
  | { mode: 'resize-surface'; index: number; pointer: number; frame: ModelRegionFrame; safe: MmPolygon; base: PreviewGeom; geom: PreviewGeom; corner: 0 | 1 | 2 | 3; grabOffset: { xMm: number; yMm: number }; captureEl: HTMLElement; revision: string }
  | { mode: 'spin-surface'; index: number; pointer: number; frame: ModelRegionFrame; safe: MmPolygon; base: PreviewGeom; geom: PreviewGeom; offsetDeg: number; captureEl: HTMLElement; revision: string };

export interface ModelPlacementSharedSurface {
  canvas: HTMLCanvasElement;
  stage: HTMLElement;
  getViewer(): ModelViewer | null;
  isActive(): boolean;
}

/** Persistent camera + local raster assets. Only release commits canonical mm. */
export function createModelPlacementView(callbacks: {
  select(index: number): void;
  anchor?(regionId: string, pos: { xMm: number; yMm: number }, name: string): void;
  move(index: number, pos: { xMm: number; yMm: number }): void;
  status(message: string): void;
  expand(): void;
  isExpanded(): boolean;
  toggleDetails(): boolean;
  save?(): void;
  commit?(index: number, patch: ModelPlacementCommitPatch): void;
  /** Advisory live preview (mm); never staged or committed by the receiver. */
  preview?(index: number, patch: ModelPlacementCommitPatch): void;
  /**
   * Limited customer proof mode: hide operator-only toolbar controls
   * (rotate/pan/move-logo/expand/details/save), the fallback precise
   * numeric toolbar, measurement lines/corner-distance labels and
   * reference/anchor affordances. Retains Front/Back/Fit/Zoom, on-surface
   * selection/drag, corner resize handles and keyboard equivalents.
   * Default false preserves operator behavior.
   */
  customer?: boolean;
  /** Notify consumers while a pointer/keyboard transaction owns the scene. */
  interaction?(active: boolean): void;
  /**
   * OPTIONAL borrowed surface (root-owned unified workspace). When provided,
   * use those actual existing DOM canvas/stage and the provided viewer.
   * Never reparent the external stage, never attach another ModelViewer,
   * never call showModel(), never dispose the shared viewer. Root loads the
   * asset and owns lifetime; getViewer() returns null until its model is
   * ready. Ordinary standalone behavior without sharedSurface is unchanged.
   */
  sharedSurface?: ModelPlacementSharedSurface;
}): ModelPlacementView {
  const shared = callbacks.sharedSurface ?? null;
  const customer = callbacks.customer === true;
  const element = document.createElement('section'); element.className = 'model-placement-workbench';
  element.setAttribute('data-placement-hook', 'pw-model-workbench');
  const bar = document.createElement('div'); bar.className = 'model-placement-toolbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Product placement controls');
  const stage = shared?.stage ?? document.createElement('div'); if (!shared) stage.className = 'model-placement-stage';
  const canvas = shared?.canvas ?? document.createElement('canvas');
  if (!shared) { canvas.setAttribute('aria-label', 'Place logos directly on the product'); stage.append(canvas); }
  canvas.setAttribute('data-placement-hook', 'pw-model-canvas');
  // On-surface overlay: corner resize handles + rotation handle + corner-distance labels,
  // positioned each frame from calibrated mm via viewer.projectToClient. Pointer-events
  // stay on the small controls only so canvas drag/orbit is unaffected.
  const overlay = document.createElement('div');
  overlay.setAttribute('data-placement-hook', 'pw-model-surface-handles');
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;display:none;';
  const overlaySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlaySvg.setAttribute('data-placement-hook', 'pw-model-measure-lines');
  overlaySvg.setAttribute('aria-hidden', 'true');
  overlaySvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  overlay.append(overlaySvg);
  stage.append(overlay);
  const handles = document.createElement('div'); handles.className = 'model-placement-handles';
  handles.setAttribute('data-placement-hook', 'pw-model-handles');
  handles.setAttribute('role', 'group'); handles.setAttribute('aria-label', 'Selected logo size and rotation');
  const hint = document.createElement('p'); hint.className = 'pw-muted';
  hint.textContent = 'Drag a logo to move it; drag empty product to rotate. Move logo lets you click a new spot. Use the size and rotation handles for fine changes. Hold Shift for unsnapped fine adjustment. Sizes and positions stay in millimetres.';
  const notice = document.createElement('p'); notice.className = 'pw-muted'; notice.textContent = 'Provisional surface preview — verify physical measurements before production.';
  const state = document.createElement('p'); state.className = 'pw-status pw-muted'; state.setAttribute('role', 'status'); state.setAttribute('data-placement-hook', 'pw-model-status');
  element.append(bar, ...(shared ? [] : [stage]), handles, hint, notice, state);
  let viewer: ModelViewer | null = null;
  let data: ViewData | null = null;
  let key = '', generation = 0, disposed = false, ready = false, forceRotate = false, placeMode = false, panMode = false;
  let artworkSignature = '';
  let anchorName: string | null = null;
  const images = new Map<string, HTMLImageElement | null>();
  const aborter = new AbortController();
  let active: ActiveOp | null = null;
  let fineHeld = false;
  let frameRequest = 0;
  const buttons: HTMLButtonElement[] = [];
  /**
   * Borrowed-surface helpers (root-owned unified workspace). Standalone path
   * (shared === null) keeps the previous behavior verbatim: own viewer,
   * own stage/canvas, own lifetime.
   */
  function viewerOf(): ModelViewer | null { return shared ? shared.getViewer() : viewer; }
  function stageOf(): HTMLElement { return shared ? shared.stage : stage; }
  function sharedActive(): boolean { return shared === null || shared.isActive(); }
  if (shared) {
    // The shared canvas can carry both the builder hook and the placement
    // hook; never remove or reparent root-owned DOM here.
    try {
      if (!shared.canvas.hasAttribute('data-placement-hook')) shared.canvas.setAttribute('data-placement-hook', 'pw-model-canvas');
    } catch { /* placement hook is advisory */ }
    // Own overlay may live on the shared stage (positioned host owned by
    // root); the external stage itself is never reparented into element.
    try { shared.stage.append(overlay); } catch { /* overlay stays local */ }
  }
  function button(label: string, action: (event: MouseEvent) => void, hook: string): HTMLButtonElement {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'pw-secondary'; node.textContent = label;
    node.setAttribute('data-placement-hook', hook); node.addEventListener('click', action); bar.append(node); buttons.push(node); return node;
  }
  const rotate = button('Rotate', () => { anchorName = null; forceRotate = true; placeMode = false; panMode = false; syncTools(); }, 'pw-model-rotate');
  const pan = button('Pan', () => { anchorName = null; forceRotate = false; placeMode = false; panMode = true; syncTools(); }, 'pw-model-pan');
  const move = button('Move logo', () => { anchorName = null; forceRotate = false; placeMode = true; panMode = false; syncTools(); }, 'pw-model-move');
  move.title = 'Select or move: click a logo to select it, drag it to move it';
  button('Front', () => { if (sharedActive()) viewerOf()?.setViewSide('front'); }, 'pw-model-front');
  button('Back', () => { if (sharedActive()) viewerOf()?.setViewSide('back'); }, 'pw-model-back');
  button('Fit', () => { if (sharedActive()) viewerOf()?.fitCurrentView(); }, 'pw-model-fit');
  const focusArea = button('Focus this area', () => {
    if (!sharedActive()) return;
    const activeViewer = viewerOf();
    if (!activeViewer || !data || !ready) { state.textContent = 'No live preview — show the product, then Focus this area.'; return; }
    if (active) { state.textContent = 'Finish the active drag first — then Focus this area.'; return; }
    const region = data.scene.regions.find((entry) => entry.id === data?.activeRegionId);
    if (!region) { state.textContent = 'Select a placement area first — then Focus this area.'; return; }
    try {
      const focus = activeViewer.focusSurfacePoints;
      if (typeof focus !== 'function') { state.textContent = 'No live preview — show the product, then Focus this area.'; return; }
      const points = region.pointsModel.map((point) => ({ ...point }));
      const moved = focus.call(activeViewer, points, { ...region.frame.normal });
      state.textContent = moved
        ? 'Focused the active area — camera only; measurements unchanged. Fit restores the product view.'
        : 'Could not focus that area — show the product and pick a spanning patch.';
    } catch {
      state.textContent = 'Could not focus that area — show the product and pick a spanning patch.';
    }
  }, 'pw-model-focus-area');
  focusArea.title = 'Focus this area in the 3D preview (camera only)';
  button('−', () => zoom(-1), 'pw-model-zoom-out').setAttribute('aria-label', 'Zoom out product');
  button('+', () => zoom(1), 'pw-model-zoom-in').setAttribute('aria-label', 'Zoom in product');
  const expand = button('Enlarge workspace', () => { callbacks.expand(); syncTools(); }, 'pw-model-expand');
  const details = button('Logo details', () => { details.setAttribute('aria-expanded', String(callbacks.toggleDetails())); }, 'pw-model-details');
  details.classList.add('model-placement-details-button'); details.setAttribute('aria-expanded', 'false');
  if (callbacks.save) button('Save job', () => callbacks.save?.(), 'pw-model-save-job');
  if (customer) {
    // Limited proof: operator-only gesture modes and workspace chrome stay
    // hidden. Auto gestures already default forceRotate=false, so logo drag
    // versus empty-product orbit keeps working without the mode buttons.
    for (const node of [rotate, pan, move, expand, details]) node.style.display = 'none';
    const saveButton = bar.querySelector<HTMLButtonElement>('[data-placement-hook="pw-model-save-job"]');
    if (saveButton) saveButton.style.display = 'none';
    hint.textContent = 'Drag a logo to move it inside its allowed area; drag a corner to resize. Hold Shift for fine adjustment.';
    handles.replaceChildren();
    handles.hidden = true;
    overlaySvg.style.display = 'none';
  }
  function syncTools(): void {
    rotate.setAttribute('aria-pressed', String(forceRotate)); move.setAttribute('aria-pressed', String(placeMode));
    pan.setAttribute('aria-pressed', String(panMode));
    viewerOf()?.setInteractionMode(panMode ? 'pan' : 'select');
    move.disabled = data === null || data.selectedIndex < 0;
    try {
      const region = data?.scene.regions.find((entry) => entry.id === data?.activeRegionId) ?? null;
      focusArea.disabled = data === null || region === null || active !== null || !ready;
    } catch {
      /* focus gating is advisory */
    }
    expand.textContent = callbacks.isExpanded() ? 'Close enlarged view' : 'Enlarge workspace';
    expand.setAttribute('aria-expanded', String(callbacks.isExpanded()));
    if (!active) {
      state.textContent = panMode
        ? 'Drag to pan the product; scroll to zoom. Choose Rotate or Move logo to edit again.'
        : placeMode
          ? 'Click the product to position the selected logo.'
          : data?.status || 'Drag a logo to move it, or rotate the product.';
    }
  }
  function zoom(direction: number): void {
    if (shared && !shared.isActive()) return;
    const steps = [50, 75, 100, 125, 150, 200, 300, 400];
    const i = steps.indexOf(viewerOf()?.getZoomPercent() ?? 100);
    viewerOf()?.setZoomPercent(steps[Math.min(steps.length - 1, Math.max(0, i + direction))]!);
  }
  let visibleCameraKey = '';
  const regionVisibility = new Map<string, boolean>();
  function regionVisible(region: ModelPlacementRegion): boolean {
    const activeViewer = viewerOf();
    if (!activeViewer || !data) return false;
    const state = activeViewer.getCameraState();
    const key = JSON.stringify([data.scene.key, data.scene.regions.map((r) => [r.id, r.pointsModel[0], r.frame.normal]), state?.position, state?.target]);
    if (key !== visibleCameraKey) { visibleCameraKey = key; regionVisibility.clear(); }
    const cached = regionVisibility.get(region.id); if (cached !== undefined) return cached;
    const anchor = region.pointsModel[0];
    const visible = !anchor || activeViewer.isSurfaceFacing(anchor, region.frame.normal) !== false;
    regionVisibility.set(region.id, visible); return visible;
  }
  function regionFor(item: ModelPlacementItem): ModelPlacementRegion | undefined { return data?.scene.regions.find((region) => region.id === item.placement.regionId); }
  function selectedItem(): ModelPlacementItem | undefined { return data?.items.find((entry) => entry.index === data?.selectedIndex); }
  function committedGeom(item: ModelPlacementItem): PreviewGeom {
    const p = item.placement;
    return { xMm: p.pos.xMm, yMm: p.pos.yMm, widthMm: p.widthMm, heightMm: p.heightMm, rotationDeg: normalizeDeg(p.rotationDeg) };
  }
  /** Region outline in frame millimetres; [] when unmappable so snapping degrades gracefully. Never fabricates calibration. */
  function safeMmFor(region: ModelPlacementRegion): MmPolygon {
    const out: Array<[number, number]> = [];
    for (const point of region.pointsModel) {
      const mm = regionMmFromModel(region.frame, point);
      if (mm) out.push([mm.xMm, mm.yMm]);
    }
    return out;
  }
  const round2 = (v: number): number => Math.round(v * 100) / 100;
  /** Ratio policy for unified edits: persisted per placement by the workspace (survives commits/selection). */
  function policyForItem(item: ModelPlacementItem): RatioPolicy {
    const ratio = item.lock?.ratio;
    if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) return { locked: true, ratio };
    return { locked: false, ratio: NaN };
  }
  function policyForIndex(index: number): RatioPolicy {
    const item = data?.items.find((entry) => entry.index === index);
    return item ? policyForItem(item) : { locked: false, ratio: NaN };
  }
  function previewStatus(geom: PreviewGeom, snapped: boolean): string {
    return `Preview — X ${geom.xMm.toFixed(1)} mm · Y ${geom.yMm.toFixed(1)} mm · W ${geom.widthMm.toFixed(1)} mm · H ${geom.heightMm.toFixed(1)} mm · R ${normalizeDeg(geom.rotationDeg).toFixed(1)}°${snapped ? ' (snapped; hold Shift for fine)' : ''}`;
  }
  // ---- Resize/rotate handles (keyboard-accessible HTML controls) ----
  function handleSlider(hook: string, label: string, min: number, max: number, step: number): HTMLInputElement {
    const wrap = document.createElement('label'); wrap.className = 'model-placement-handle';
    const caption = document.createElement('span'); caption.textContent = label; caption.className = 'pw-muted';
    const input = document.createElement('input'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.setAttribute('data-placement-hook', hook); input.setAttribute('aria-label', label); input.disabled = true;
    wrap.append(caption, input); handles.append(wrap);
    return input;
  }
  function handleButton(label: string, hook: string, action: (event: MouseEvent) => void): HTMLButtonElement {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'pw-secondary'; node.textContent = label;
    node.setAttribute('data-placement-hook', hook); node.addEventListener('click', action); node.disabled = true;
    handles.append(node); buttons.push(node); return node;
  }
  const widthSlider = handleSlider('pw-model-handle-width', 'Width (mm)', 1, 400, 0.5);
  const heightSlider = handleSlider('pw-model-handle-height', 'Height (mm)', 1, 400, 0.5);
  const rotationSlider = handleSlider('pw-model-handle-rotation', 'Rotation (°)', -180, 180, 0.5);
  const growButton = handleButton('Grow', 'pw-model-handle-grow', (event) => stepSize(event, 1.05));
  const shrinkButton = handleButton('Shrink', 'pw-model-handle-shrink', (event) => stepSize(event, 1 / 1.05));
  const rotateCcw = handleButton('⟲ 1°', 'pw-model-handle-rotate-ccw', (event) => stepRotation(event, -1));
  const rotateCw = handleButton('⟳ 1°', 'pw-model-handle-rotate-cw', (event) => stepRotation(event, 1));
  const handleControls: HTMLElement[] = [widthSlider, heightSlider, rotationSlider, growButton, shrinkButton, rotateCcw, rotateCw];
  function setHandlesEnabled(enabled: boolean): void { for (const control of handleControls) (control as HTMLInputElement | HTMLButtonElement).disabled = !enabled; }
  function spanOf(safe: MmPolygon): { x: number; y: number } {
    if (safe.length < 3) return { x: 0, y: 0 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of safe) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    return { x: maxX - minX, y: maxY - minY };
  }
  /** Refresh handle enablement and slider positions from committed geometry (or live preview for idle controls). */
  function syncHandles(): void {
    if (shared) { handles.replaceChildren(); handles.hidden = true; return; }
    if (customer) { handles.hidden = true; return; }
    const item = selectedItem();
    const region = item ? regionFor(item) : undefined;
    if (!item || !region || (active && active.mode !== 'adjust')) { setHandlesEnabled(false); return; }
    setHandlesEnabled(true);
    const shown = active?.mode === 'adjust' && active.index === item.index ? active.geom : committedGeom(item);
    const span = spanOf(safeMmFor(region));
    const maxDim = Math.max(8, span.x, span.y, shown.widthMm, shown.heightMm);
    for (const [slider, value] of [[widthSlider, shown.widthMm], [heightSlider, shown.heightMm]] as Array<[HTMLInputElement, number]>) {
      slider.max = String(Math.ceil(maxDim));
      if (active?.mode !== 'adjust' || active.control !== slider) slider.value = String(value);
    }
    if (active?.mode !== 'adjust' || active.control !== rotationSlider) rotationSlider.value = String(normalizeDeg(shown.rotationDeg));
  }
  function snapCandidate(safe: MmPolygon, geom: PreviewGeom, unsnapped: boolean): { geom: PreviewGeom; snapped: boolean; guides: AlignGuide[] } {
    const snapped = snapFootprint(
      { cx: geom.xMm, cy: geom.yMm, widthMm: geom.widthMm, heightMm: geom.heightMm, rotationDeg: geom.rotationDeg },
      safe, { unsnapped, rotateTolDeg: 0 },
    );
    return {
      geom: { xMm: round2(snapped.cx), yMm: round2(snapped.cy), widthMm: geom.widthMm, heightMm: geom.heightMm, rotationDeg: normalizeDeg(snapped.rotationDeg) },
      snapped: snapped.snappedPosition || snapped.snappedRotation,
      guides: unsnapped ? [] : snapped.guides,
    };
  }
  /** Last snap guides in mm for the overlay (advisory; cleared on commit/cancel). */
  let lastGuides: AlignGuide[] = [];
  /** Advisory live preview for numeric fields; never staged or committed here. */
  function emitPreview(index: number, geom: PreviewGeom): void {
    try {
      callbacks.preview?.(index, {
        pos: { xMm: geom.xMm, yMm: geom.yMm },
        widthMm: geom.widthMm, heightMm: geom.heightMm, rotationDeg: normalizeDeg(geom.rotationDeg),
      });
    } catch { /* preview is advisory only */ }
  }
  /** Live transient preview only — never exported. Committed on slider release / button commit. */
  function previewAdjust(patch: Partial<PreviewGeom>, control: HTMLElement | null, unsnapped: boolean): void {
    const item = selectedItem(); if (!item) return;
    const region = regionFor(item); if (!region) return;
    if (active && active.mode !== 'adjust') return;
    if (active?.mode === 'adjust' && active.index !== item.index) cancel();
    const safe = safeMmFor(region);
    const base = active?.mode === 'adjust' && active.index === item.index ? active.base : committedGeom(item);
    const raw: PreviewGeom = { ...(active?.mode === 'adjust' && active.index === item.index ? active.geom : base), ...patch };
    raw.widthMm = Math.min(5000, Math.max(1, raw.widthMm));
    raw.heightMm = Math.min(5000, Math.max(1, raw.heightMm));
    let geom: PreviewGeom; let snapped: boolean; let guides: AlignGuide[];
    if (patch.rotationDeg !== undefined && patch.xMm === undefined && patch.yMm === undefined && patch.widthMm === undefined && patch.heightMm === undefined) {
      const rot = rotationSnapDeg(raw.rotationDeg, safe, 2, unsnapped);
      geom = { ...raw, rotationDeg: normalizeDeg(rot.rotationDeg) }; snapped = rot.snapped; guides = unsnapped ? [] : rot.guides;
    } else {
      if (patch.widthMm !== undefined || patch.heightMm !== undefined) {
        // Unified transaction: both axes consult the persisted ratio lock.
        let tx = beginEdit(base, policyForItem(item));
        if (patch.widthMm !== undefined) tx = setCandidateWidthTx(tx, patch.widthMm);
        if (patch.heightMm !== undefined) tx = setCandidateHeightTx(tx, patch.heightMm);
        geom = { ...tx.candidate };
        snapped = false; guides = [];
      } else { const out = snapCandidate(safe, raw, unsnapped); geom = out.geom; snapped = out.snapped; guides = out.guides; }
    }
    active = { mode: 'adjust', index: item.index, revision: data?.revision ?? '', safe, base, geom, control };
    callbacks.interaction?.(true);
    lastGuides = guides;
    artworkSignature = ''; paint({ index: item.index, geom });
    state.textContent = previewStatus(geom, snapped);
    emitPreview(item.index, geom);
    syncHandles();
  }
  function stepSize(event: MouseEvent, factor: number): void {
    const item = selectedItem(); if (!item) return;
    const fine = event.shiftKey || event.altKey || fineHeld;
    const from = active?.mode === 'adjust' && active.index === item.index ? active.geom : committedGeom(item);
    const scale = fine ? (factor > 1 ? 1.01 : 1 / 1.01) : factor;
    previewAdjust({ widthMm: round2(from.widthMm * scale), heightMm: round2(from.heightMm * scale) }, null, fine);
    commitAdjust();
  }
  function stepRotation(event: MouseEvent, deltaDeg: number): void {
    const item = selectedItem(); if (!item) return;
    const from = active?.mode === 'adjust' && active.index === item.index ? active.geom : committedGeom(item);
    previewAdjust({ rotationDeg: normalizeDeg(from.rotationDeg + deltaDeg) }, null, true);
    commitAdjust();
  }
  /** Commit the live preview once; restores committed geometry on stale revision. */
  function buildPatch(base: PreviewGeom, geom: PreviewGeom): ModelPlacementCommitPatch {
    const patch: ModelPlacementCommitPatch = {};
    if (Math.abs(geom.xMm - base.xMm) > 1e-9 || Math.abs(geom.yMm - base.yMm) > 1e-9) patch.pos = { xMm: geom.xMm, yMm: geom.yMm };
    if (Math.abs(geom.widthMm - base.widthMm) > 1e-9) patch.widthMm = geom.widthMm;
    if (Math.abs(geom.heightMm - base.heightMm) > 1e-9) patch.heightMm = geom.heightMm;
    if (Math.abs(normalizeDeg(geom.rotationDeg - base.rotationDeg)) > 1e-9) patch.rotationDeg = normalizeDeg(geom.rotationDeg);
    return patch;
  }
  function dispatchPatch(index: number, patch: ModelPlacementCommitPatch): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    if (keys.length === 1 && patch.pos) { callbacks.move(index, patch.pos); return; }
    if (callbacks.commit) { callbacks.commit(index, patch); return; }
    if (patch.pos) callbacks.move(index, patch.pos);
    callbacks.status('Size and rotation edits need workspace support in this build; position saved, size unchanged.');
  }
  function commitAdjust(): void {
    if (active?.mode !== 'adjust' || !data) return;
    const op = active; const item = data.items.find((entry) => entry.index === op.index);
    if (!item || op.revision !== data.revision) {
      cancel();
      if (item && op.revision !== data?.revision) callbacks.status('Edit cancelled: the job changed. Position unchanged.');
      return;
    }
    const patch = buildPatch(op.base, op.geom);
    cancel();
    dispatchPatch(op.index, patch);
  }
  for (const [slider, field] of [[widthSlider, 'widthMm'], [heightSlider, 'heightMm'], [rotationSlider, 'rotationDeg']] as Array<[HTMLInputElement, 'widthMm' | 'heightMm' | 'rotationDeg']>) {
    slider.addEventListener('input', () => {
      const value = Number(slider.value); if (!Number.isFinite(value)) return;
      previewAdjust({ [field]: field === 'rotationDeg' ? normalizeDeg(value) : value } as Partial<PreviewGeom>, slider, fineHeld);
    });
    slider.addEventListener('change', () => commitAdjust());
    slider.addEventListener('blur', () => { if (active?.mode === 'adjust' && active.control === slider) cancel(); });
    slider.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && active?.mode === 'adjust') { event.preventDefault(); cancel(); callbacks.status('Resize cancelled. Size unchanged.'); slider.blur(); }
    });
  }
  window.addEventListener('keydown', (event) => { if (event.key === 'Shift' || event.key === 'Alt') fineHeld = true; }, { signal: aborter.signal });
  window.addEventListener('keyup', (event) => { if (event.key === 'Shift' || event.key === 'Alt') fineHeld = false; }, { signal: aborter.signal });
  window.addEventListener('blur', () => { fineHeld = false; }, { signal: aborter.signal });
  // ---- On-surface pointer handles (corners + rotate), positioned per frame ----
  type SurfaceCorner = 0 | 1 | 2 | 3;
  const cornerCursors = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize'];
  const cornerButtons: HTMLButtonElement[] = [];
  const cornerLabels: HTMLDivElement[] = [];
  const cornerLabelText = ['', '', '', ''];
  function surfaceButton(hook: string, label: string, text: string, cursor: string): HTMLButtonElement {
    const node = document.createElement('button'); node.type = 'button';
    node.setAttribute('data-placement-hook', hook); node.setAttribute('aria-label', label);
    node.textContent = text; node.tabIndex = 0;
    // Large invisible pointer target (32px) around a compact visible core
    // (10px outline square): touch-friendly without covering the artwork.
    node.style.cssText = `position:absolute;transform:translate(-50%,-50%);pointer-events:auto;touch-action:none;cursor:${cursor};` +
      'width:32px;height:32px;min-width:32px;min-height:32px;padding:0;line-height:1;background:rgba(255,255,255,0.01);border:0;color:#1d4ed8;font-size:10px;' +
      'outline:2px solid #2563eb;outline-offset:-11px;border-radius:1px;';
    overlay.append(node);
    return node;
  }
  const spinButton = surfaceButton('pw-model-rotate-handle', 'Rotate logo on the product: drag, or press [ and ]', '⟳', 'grab');
  spinButton.style.outline = 'none';
  spinButton.style.borderRadius = '50%'; spinButton.style.width = '32px'; spinButton.style.height = '32px';
  spinButton.style.background = '#fff'; spinButton.style.border = '2px solid #2563eb';
  for (let corner = 0 as SurfaceCorner; corner < 4; corner = (corner + 1) as SurfaceCorner) {
    const node = surfaceButton(`pw-model-corner-${corner}`, `Resize logo from corner ${corner + 1} on the product: drag, or press plus and minus`, '⤢', cornerCursors[corner] ?? 'nwse-resize');
    cornerButtons.push(node);
    const tag = document.createElement('div');
    tag.setAttribute('data-placement-hook', `pw-model-corner-dist-${corner}`);
    tag.setAttribute('aria-hidden', 'true');
    tag.style.cssText = 'position:absolute;transform:translate(-50%,-130%);pointer-events:none;white-space:nowrap;' +
      'font-size:10px;line-height:1.4;padding:0 4px;background:rgba(255,255,255,.92);border:1px solid #cbd5e1;border-radius:4px;color:#334155;';
    overlay.append(tag); cornerLabels.push(tag);
    const captured = corner;
    node.addEventListener('pointerdown', (event) => surfacePointerDown(event, 'resize-surface', node, captured));
    node.addEventListener('pointermove', surfacePointerMove);
    node.addEventListener('pointerup', surfacePointerUp);
    node.addEventListener('pointercancel', () => cancel());
    node.addEventListener('lostpointercapture', () => { if (active && active.mode !== 'move' && active.mode !== 'adjust') cancel(); });
    node.addEventListener('keydown', surfaceKey);
  }
  spinButton.addEventListener('pointerdown', (event) => surfacePointerDown(event, 'spin-surface', spinButton));
  spinButton.addEventListener('pointermove', surfacePointerMove);
  spinButton.addEventListener('pointerup', surfacePointerUp);
  spinButton.addEventListener('pointercancel', () => cancel());
  spinButton.addEventListener('lostpointercapture', () => { if (active && active.mode !== 'move' && active.mode !== 'adjust') cancel(); });
  spinButton.addEventListener('keydown', surfaceKey);
  function shownGeomFor(item: ModelPlacementItem): PreviewGeom {
    if (active && active.index === item.index && active.geom) return active.geom;
    return committedGeom(item);
  }
  /** Reposition overlay controls from calibrated mm; follows orbit/zoom/resize. Hides when unprojectable. */
  function positionOverlay(): void {
    paintAnchors();
    const activeViewer = viewerOf();
    if (!activeViewer || !ready || !data || disposed || forceRotate || placeMode || panMode || anchorName !== null || !sharedActive()) { overlay.style.display = 'none'; return; }
    const item = selectedItem(); const region = item ? regionFor(item) : undefined;
    if (!item || !region) { overlay.style.display = 'none'; return; }
    if (!regionVisible(region)) { overlay.style.display = 'none'; return; }
    const shown = shownGeomFor(item);
    const cornersMm = rotatedFootprintCorners(shown.xMm, shown.yMm, shown.widthMm, shown.heightMm, shown.rotationDeg);
    const stageRect = stageOf().getBoundingClientRect();
    if (!Number.isFinite(stageRect.width) || stageRect.width <= 0) { overlay.style.display = 'none'; return; }
    const pts: Array<{ x: number; y: number } | null> = cornersMm.map((corner) => {
      const mp = modelPointFromMm(region.frame, corner.x, corner.y); if (!mp) return null;
      const client = activeViewer.projectToClient(mp, false); if (!client) return null;
      return { x: client.x - stageRect.left, y: client.y - stageRect.top };
    });
    if (pts.some((point) => point === null)) { overlay.style.display = 'none'; return; }
    overlay.style.display = 'block';
    overlaySvg.setAttribute('width', String(Math.round(stageRect.width)));
    overlaySvg.setAttribute('height', String(Math.round(stageRect.height)));
    overlaySvg.setAttribute('viewBox', `0 0 ${stageRect.width} ${stageRect.height}`);
    while (overlaySvg.firstChild) overlaySvg.removeChild(overlaySvg.firstChild);
    const projectStage = (xMm: number, yMm: number): { x: number; y: number } | null => {
      const mp = modelPointFromMm(region.frame, xMm, yMm); if (!mp) return null;
      const client = activeViewer.projectToClient(mp, false); if (!client) return null;
      return { x: client.x - stageRect.left, y: client.y - stageRect.top };
    };
    const drawLine = (a: { x: number; y: number } | null, b: { x: number; y: number } | null, stroke: string, dash: string, width: number): void => {
      if (!a || !b) return;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
      line.setAttribute('stroke', stroke); line.setAttribute('stroke-width', String(width));
      if (dash) line.setAttribute('stroke-dasharray', dash);
      overlaySvg.append(line);
    };
    const centrePx = { x: (pts[0]!.x + pts[2]!.x) / 2, y: (pts[0]!.y + pts[2]!.y) / 2 };
    const widthVector = { x: pts[2]!.x - pts[3]!.x, y: pts[2]!.y - pts[3]!.y };
    const heightVector = { x: pts[3]!.x - pts[0]!.x, y: pts[3]!.y - pts[0]!.y };
    const wLength = Math.hypot(widthVector.x, widthVector.y), hLength = Math.hypot(heightVector.x, heightVector.y);
    const displayCorners = pts.map((point, i) => {
      if (!point) return null;
      const sx = i === 1 || i === 2 ? 1 : -1, sy = i >= 2 ? 1 : -1;
      const extendW = Math.max(0, 16 - wLength / 2), extendH = Math.max(0, 16 - hLength / 2);
      return { x: point.x + sx * widthVector.x / Math.max(wLength, 1e-9) * extendW + sy * heightVector.x / Math.max(hLength, 1e-9) * extendH,
        y: point.y + sx * widthVector.y / Math.max(wLength, 1e-9) * extendW + sy * heightVector.y / Math.max(hLength, 1e-9) * extendH };
    });
    for (let i = 0; i < 4; i += 1) {
      const point = displayCorners[i]; const node = cornerButtons[i]; const tag = cornerLabels[i];
      if (!point || !node || !tag) continue;
      node.style.display = ''; tag.style.display = customer ? 'none' : '';
      node.style.left = `${point.x}px`; node.style.top = `${point.y}px`;
      const right = i === 1 || i === 2, upper = i >= 2;
      tag.style.left = `${point.x + (right ? 9 : -9)}px`;
      tag.style.top = `${point.y + (upper ? -9 : 9)}px`;
      tag.style.transform = `translate(${right ? '0' : '-100%'},${upper ? '-100%' : '0'})`;
    }
    try {
      const measures = cornerSafeMeasurements(
        { cx: shown.xMm, cy: shown.yMm, widthMm: shown.widthMm, heightMm: shown.heightMm, rotationDeg: shown.rotationDeg },
        safeMmFor(region),
      );
      for (const measure of measures) {
        const tag = cornerLabels[measure.cornerIndex]; if (!tag) continue;
        const text = `${measure.distanceMm.toFixed(1)}mm`;
        if (cornerLabelText[measure.cornerIndex] !== text) { cornerLabelText[measure.cornerIndex] = text; tag.textContent = text; }
        drawLine(projectStage(measure.corner.x, measure.corner.y), projectStage(measure.nearest.x, measure.nearest.y), '#6d4c00', '4 3', 1.5);
      }
    } catch { /* labels are advisory; never block handles */ }
    // Keep all four compact values readable even when the artwork projects
    // to only a few pixels, or rotation brings adjacent corners together.
    const occupied: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (let i = 0; i < cornerLabels.length; i++) {
      const tag = cornerLabels[i]!, point = displayCorners[i]; if (!point) continue;
      const right = i === 1 || i === 2, upper = i >= 2;
      const width = tag.offsetWidth, height = tag.offsetHeight;
      const x = point.x + (right ? 10 : -10 - width);
      let y = point.y + (upper ? -10 - height : 10);
      for (let attempt = 0; attempt < 8; attempt++) {
        if (!occupied.some((box) => x < box.x + box.width + 3 && x + width + 3 > box.x &&
          y < box.y + box.height + 3 && y + height + 3 > box.y)) break;
        y += (upper ? -1 : 1) * (height + 4);
      }
      tag.style.transform = 'none'; tag.style.left = `${x}px`; tag.style.top = `${y}px`;
      occupied.push({ x, y, width, height });
    }
    try {
      const span = Math.max(shown.widthMm, shown.heightMm, 8);
      for (const guide of lastGuides) {
        if (guide.fromMm && guide.toMm) {
          drawLine(projectStage(guide.fromMm.x, guide.fromMm.y), projectStage(guide.toMm.x, guide.toMm.y), '#0b6cab', '6 4', 2);
        } else if (guide.valueMm !== undefined && (guide.kind === 'v-center' || guide.kind === 'v-edge')) {
          drawLine(projectStage(guide.valueMm, shown.yMm - span), projectStage(guide.valueMm, shown.yMm + span), '#0b6cab', '6 4', 1.5);
        } else if (guide.valueMm !== undefined && (guide.kind === 'h-center' || guide.kind === 'h-edge')) {
          drawLine(projectStage(shown.xMm - span, guide.valueMm), projectStage(shown.xMm + span, guide.valueMm), '#0b6cab', '6 4', 1.5);
        }
      }
    } catch { /* guides are advisory; never block handles */ }
    // A fixed screen-space gap keeps rotation usable even for tiny artwork;
    // the pointer still resolves through the calibrated plane on drag.
    const top = { x: (displayCorners[2]!.x + displayCorners[3]!.x) / 2, y: (displayCorners[2]!.y + displayCorners[3]!.y) / 2 };
    const centre = centrePx;
    const dx = top.x - centre.x, dy = top.y - centre.y, len = Math.hypot(dx, dy);
    const rotate = { x: top.x + (len > 1e-6 ? dx / len : 0) * 28,
      y: top.y + (len > 1e-6 ? dy / len : -1) * 28 };
    drawLine(top, rotate, '#64748b', '', 1);
    spinButton.style.display = 'block';
    spinButton.style.left = `${rotate.x}px`; spinButton.style.top = `${rotate.y}px`;
  }
  /** Opposite-corner-anchored resize is owned by the shared edit transaction. */
  function planeMm(clientX: number, clientY: number, frame: ModelRegionFrame): { xMm: number; yMm: number } | null {
    const activeViewer = viewerOf();
    if (!activeViewer) return null;
    const point = activeViewer.intersectRegionPlane(clientX, clientY, frame);
    if (!point) return null;
    return regionMmFromModel(frame, point);
  }
  function surfacePointerDown(event: PointerEvent, mode: 'resize-surface' | 'spin-surface', captureEl: HTMLElement, corner?: SurfaceCorner): void {
    // Gated by workspace activity: an inactive borrowed controller never
    // intercepts setup picks or mutates shared overlays.
    if (!sharedActive()) return;
    // Direct manipulation is primary: no hidden pending-field Apply gate blocks
    // handle drags. Staged numeric edits are reconciled by the workspace commit.
    const activeViewer = viewerOf();
    if (!activeViewer || !ready || !data || event.button !== 0 || !event.isPrimary) return;
    if (active) cancel();
    const item = selectedItem(); if (!item) return;
    const region = regionFor(item); if (!region) return;
    event.preventDefault(); event.stopPropagation();
    const base = committedGeom(item);
    const safe = safeMmFor(region);
    if (mode === 'spin-surface') {
      const mm = planeMm(event.clientX, event.clientY, region.frame); if (!mm) return;
      const dx = mm.xMm - base.xMm, dy = mm.yMm - base.yMm;
      if (Math.hypot(dx, dy) < 1e-6) return;
      const grabAngle = normalizeDeg((Math.atan2(dx, dy) * 180) / Math.PI);
      active = { mode, index: item.index, pointer: event.pointerId, frame: region.frame, safe, base, geom: { ...base }, offsetDeg: normalizeDeg(base.rotationDeg - grabAngle), captureEl, revision: data.revision };
    } else {
      const mm = planeMm(event.clientX, event.clientY, region.frame); if (!mm) return;
      const cornerIndex = corner ?? 0;
      const actual = rotatedFootprintCorners(base.xMm, base.yMm, base.widthMm, base.heightMm, base.rotationDeg)[cornerIndex]!;
      active = { mode, index: item.index, pointer: event.pointerId, frame: region.frame, safe, base, geom: { ...base }, corner: cornerIndex,
        grabOffset: { xMm: actual.x - mm.xMm, yMm: actual.y - mm.yMm }, captureEl, revision: data.revision };
    }
    callbacks.interaction?.(true);
    viewerOf()?.setOrbitEnabled(false);
    try { captureEl.setPointerCapture(event.pointerId); } catch { /* drag continues without capture */ }
    syncHandles();
  }
  function surfacePointerMove(event: PointerEvent): void {
    if (!sharedActive()) return;
    const op = active;
    if (!op || (op.mode !== 'resize-surface' && op.mode !== 'spin-surface') || op.pointer !== event.pointerId || !viewerOf() || !data) return;
    const mm = planeMm(event.clientX, event.clientY, op.frame);
    if (!mm) return;
    const unsnapped = event.shiftKey || event.altKey || fineHeld;
    if (op.mode === 'spin-surface') {
      const dx = mm.xMm - op.base.xMm, dy = mm.yMm - op.base.yMm;
      if (Math.hypot(dx, dy) < 1e-6) return;
      const pointerAngle = normalizeDeg((Math.atan2(dx, dy) * 180) / Math.PI);
      const rot = rotationSnapDeg(normalizeDeg(pointerAngle + op.offsetDeg), op.safe, 2, unsnapped);
      op.geom = { ...op.base, rotationDeg: normalizeDeg(rot.rotationDeg) };
      lastGuides = unsnapped ? [] : rot.guides;
      artworkSignature = ''; paint({ index: op.index, geom: op.geom });
      state.textContent = previewStatus(op.geom, rot.snapped);
      emitPreview(op.index, op.geom);
    } else {
      // Unified transaction: locked corner drags scale uniformly from the
      // opposite corner so the persisted ratio is preserved exactly.
      const tx = resizeCornerTx(
        beginEdit(
          { xMm: op.base.xMm, yMm: op.base.yMm, widthMm: op.base.widthMm,
            heightMm: op.base.heightMm, rotationDeg: op.base.rotationDeg },
          policyForIndex(op.index),
        ),
        op.corner,
        { xMm: mm.xMm + op.grabOffset.xMm, yMm: mm.yMm + op.grabOffset.yMm },
      );
      const next = tx.candidate;
      op.geom = { xMm: next.xMm, yMm: next.yMm, widthMm: next.widthMm,
        heightMm: next.heightMm, rotationDeg: next.rotationDeg };
      lastGuides = [];
      artworkSignature = ''; paint({ index: op.index, geom: op.geom });
      state.textContent = previewStatus(op.geom, false);
      emitPreview(op.index, op.geom);
    }
    syncHandles();
  }
  function surfacePointerUp(event: PointerEvent): void {
    if (!sharedActive()) return;
    const op = active;
    if (!op || (op.mode !== 'resize-surface' && op.mode !== 'spin-surface') || op.pointer !== event.pointerId || !data) return;
    surfacePointerMove(event);
    const item = data.items.find((entry) => entry.index === op.index);
    const stale = op.revision !== data.revision;
    const patch = item && !stale ? buildPatch(op.base, op.geom) : null;
    cancel();
    if (!item || stale || !patch) {
      if (stale) callbacks.status('Edit cancelled: the job changed. Position unchanged.');
      return;
    }
    dispatchPatch(op.index, patch);
  }
  /** Keyboard equivalents for on-surface handles: arrows nudge, +/- size, [/] rotate. */
  function surfaceKey(event: KeyboardEvent): void {
    if (!sharedActive()) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const item = selectedItem(); if (!item) return;
    const fine = event.shiftKey || event.altKey || fineHeld;
    const from = active?.mode === 'adjust' && active.index === item.index ? active.geom : committedGeom(item);
    const step = event.shiftKey ? 0.1 : 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
      previewAdjust({ xMm: round2(from.xMm + dx), yMm: round2(from.yMm + dy) }, target, fine);
      commitAdjust();
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      const scale = fine ? 1.01 : 1.05;
      previewAdjust({ widthMm: round2(from.widthMm * scale), heightMm: round2(from.heightMm * scale) }, target, fine);
      commitAdjust();
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      const scale = fine ? 1 / 1.01 : 1 / 1.05;
      previewAdjust({ widthMm: round2(from.widthMm * scale), heightMm: round2(from.heightMm * scale) }, target, fine);
      commitAdjust();
    } else if (event.key === '[') {
      event.preventDefault();
      previewAdjust({ rotationDeg: normalizeDeg(from.rotationDeg - 1) }, target, true);
      commitAdjust();
    } else if (event.key === ']') {
      event.preventDefault();
      previewAdjust({ rotationDeg: normalizeDeg(from.rotationDeg + 1) }, target, true);
      commitAdjust();
    }
  }
  function loadImage(src: string): HTMLImageElement | null {
    if (images.has(src)) return images.get(src) ?? null;
    // Package-owned in-memory URI only; artwork must never fetch a server.
    images.set(src, null);
    if (!/^(?:data:image\/(?:png|jpeg|webp);base64,|blob:)/i.test(src)) return null;
    const image = new Image();
    image.onload = () => { if (!disposed && data?.items.some((item) => item.imageSrc === src)) { images.set(src, image); artworkSignature = ''; paint(); } };
    image.onerror = () => { if (!disposed && data?.items.some((item) => item.imageSrc === src)) state.textContent = 'Artwork could not be decoded; original project data is unchanged.'; };
    image.src = src;
    return null;
  }
  function paint(preview?: { index: number; geom: PreviewGeom }): void {
    const activeViewer = viewerOf();
    if (!activeViewer || !ready || !data || disposed || !sharedActive()) return;
    const signature = JSON.stringify([data.scene.regions, data.items.map((item) => [item.index, item.placement, item.fits, item.imageSrc, item.imageSrc ? images.get(item.imageSrc)?.complete : false]), data.selectedIndex, preview]);
    if (signature === artworkSignature) return;
    const overlays: SurfaceArtworkItem[] = [];
    for (const item of data.items) {
      const region = regionFor(item);
      if (!region || !item.imageSrc) continue;
      const image = loadImage(item.imageSrc); if (!image) continue;
      const p = item.placement;
      const shown: PreviewGeom = preview?.index === item.index
        ? preview.geom
        : { xMm: p.pos.xMm, yMm: p.pos.yMm, widthMm: p.widthMm, heightMm: p.heightMm, rotationDeg: p.rotationDeg };
      const corners = rotatedFootprintCorners(shown.xMm, shown.yMm, shown.widthMm, shown.heightMm, shown.rotationDeg)
        .map((point) => modelPointFromMm(region.frame, point.x, point.y));
      if (corners.some((point) => point === null)) continue;
      const reach = Math.max(...region.pointsModel.map((point) => Math.hypot(point.x - region.frame.origin.x, point.y - region.frame.origin.y, point.z - region.frame.origin.z))) * 3;
      const anchor = region.pointsModel[0]; if (!anchor) continue;
      overlays.push({ id: String(item.index), cornersModel: corners as ModelPoint[], anchorModel: anchor, depthModel: Math.max(reach, shown.widthMm / region.frame.mmPerUnit), image, fits: item.fits, selected: item.index === data.selectedIndex });
    }
    viewerOf()?.setSurfaceArtworkOverlays(overlays);
    element.dataset.projectedArtworkCount = String(overlays.length);
    element.dataset.artworkCount = String(activeViewer.getSurfaceArtworkCount());
    artworkSignature = signature;
  }
  function cancel(): void {
    const old = active; active = null; callbacks.interaction?.(false); fineHeld = false; lastGuides = []; viewerOf()?.setOrbitEnabled(true);
    if (old && old.mode === 'move') { try { (shared?.canvas ?? canvas).releasePointerCapture(old.pointer); } catch { /* released already */ } }
    else if (old && (old.mode === 'resize-surface' || old.mode === 'spin-surface')) { try { old.captureEl.releasePointerCapture(old.pointer); } catch { /* released already */ } }
    if (frameRequest) cancelAnimationFrame(frameRequest); frameRequest = 0;
    artworkSignature = ''; paint(); positionOverlay();
    if (old && !disposed) {
      const item = data?.items.find((entry) => entry.index === old.index);
      if (item) emitPreview(old.index, committedGeom(item));
      syncTools(); syncHandles();
    }
  }
  /**
   * Logo hit test at client coords using the actual mesh triangle normal:
   * regions whose calibrated outward normal faces away from the picked
   * face (opposite shell) never own the pointer. Falls back to the
   * position-only pick when detailed normals are unavailable.
   */
  function hitItem(clientX: number, clientY: number): ModelPlacementItem | undefined {
    if (!sharedActive()) return undefined;
    const activeViewer = viewerOf();
    if (!activeViewer) return undefined;
    let normal: { x: number; y: number; z: number } | null = null;
    let point: { x: number; y: number; z: number } | null = null;
    try {
      const detailed = typeof activeViewer.pickSurfaceDetailed === 'function'
        ? activeViewer.pickSurfaceDetailed(clientX, clientY)
        : null;
      if (detailed !== null) { normal = detailed.normal; point = detailed.modelPosition; }
      else point = activeViewer.pickSurface(clientX, clientY)?.modelPosition ?? null;
    } catch { return undefined; }
    if (!point) return undefined;
    let best: ModelPlacementItem | undefined, distance = Infinity;
    for (const item of data?.items ?? []) {
      const region = regionFor(item); if (!region) continue;
      const mm = regionMmFromModel(region.frame, point); if (!mm) continue;
      const p = item.placement, dx = mm.xMm - p.pos.xMm, dy = mm.yMm - p.pos.yMm, rad = p.rotationDeg * Math.PI / 180;
      const x = dx * Math.cos(rad) - dy * Math.sin(rad), y = dx * Math.sin(rad) + dy * Math.cos(rad);
      if (Math.abs(x) > p.widthMm / 2 || Math.abs(y) > p.heightMm / 2) continue;
      const onPlane = modelPointFromMm(region.frame, mm.xMm, mm.yMm); if (!onPlane) continue;
      const depth = Math.hypot(point.x - onPlane.x, point.y - onPlane.y, point.z - onPlane.z);
      // Calibration plane winding is arbitrary. Cull by the actual visible
      // garment surface, not the sign of its coordinate-frame normal.
      if (!regionVisible(region)) continue;
      if (depth < distance) { distance = depth; best = item; }
    }
    return best;
  }
  function canvasDown(event: PointerEvent): void {
    // Gated by workspace activity: an inactive borrowed controller never
    // intercepts setup picks or starts placement gestures.
    if (!sharedActive()) return;
    // Pan tool reserves pointer before logo hit testing: navigation reaches
    // OrbitControls untouched. Right/middle drags always pan/zoom natively.
    const activeViewer = viewerOf();
    if (!activeViewer || !ready || !data || forceRotate || panMode || event.button !== 0 || !event.isPrimary) return;
    if (anchorName !== null) {
      const region = data.scene.regions.find((entry) => entry.id === data?.activeRegionId);
      const hit = activeViewer.pickSurface(event.clientX, event.clientY);
      if (!region || !regionVisible(region)) { callbacks.status('Choose a visible calibrated area before adding a reference point.'); return; }
      if (!hit) { callbacks.status('Reference point missed the product. Click directly on its surface; Escape cancels.'); return; }
      const mm = regionMmFromModel(region.frame, hit.modelPosition); if (!mm) { callbacks.status('That surface point could not be mapped to the calibrated area.'); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      const name = anchorName; anchorName = null; callbacks.anchor?.(region.id, mm, name); return;
    }
    if (active?.mode === 'adjust') cancel();
    const item = placeMode ? data.items.find((entry) => entry.index === data?.selectedIndex) : hitItem(event.clientX, event.clientY);
    if (!item) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (item.index !== data.selectedIndex) { callbacks.select(item.index); return; }
    const region = regionFor(item); if (!region) return;
    const surface = activeViewer.pickSurface(event.clientX, event.clientY); if (!surface) return;
    const mm = regionMmFromModel(region.frame, surface.modelPosition); if (!mm) return;
    active = { mode: 'move', index: item.index, pointer: event.pointerId, frame: region.frame, safe: safeMmFor(region), base: committedGeom(item), offset: placeMode ? { xMm: 0, yMm: 0 } : { xMm: item.placement.pos.xMm - mm.xMm, yMm: item.placement.pos.yMm - mm.yMm }, startX: event.clientX, startY: event.clientY, revision: data.revision, geom: null };
    callbacks.interaction?.(true);
    viewerOf()?.setOrbitEnabled(false);
    try { (event.currentTarget as HTMLCanvasElement | null)?.setPointerCapture(event.pointerId); } catch { /* drag continues without capture */ }
    syncHandles();
  }
  canvas.addEventListener('pointerdown', canvasDown, { capture: true, signal: aborter.signal });
  // Borrowed canvas: same placement gesture, gated by isActive() inside.
  // Never reparented; removed via the shared abort signal on destroy.
  function canvasMove(event: PointerEvent): void {
    if (!sharedActive()) return;
    if (!active || active.mode !== 'move' || active.pointer !== event.pointerId || !viewerOf()) return;
    const activeViewer = viewerOf();
    const hit = activeViewer?.pickSurface(event.clientX, event.clientY);
    const mm = hit ? regionMmFromModel(active.frame, hit.modelPosition) : null;
    const raw = mm ? { xMm: mm.xMm + active.offset.xMm, yMm: mm.yMm + active.offset.yMm } : null;
    const unsnapped = event.shiftKey || event.altKey;
    const snapped = raw ? snapCandidate(active.safe, { ...active.base, xMm: raw.xMm, yMm: raw.yMm }, unsnapped) : null;
    active.geom = snapped?.geom ?? null;
    lastGuides = snapped?.guides ?? [];
    if (!frameRequest) frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (active?.mode === 'move' && active.geom) {
        paint({ index: active.index, geom: active.geom });
        state.textContent = previewStatus(active.geom, false);
        emitPreview(active.index, active.geom);
      }
    });
  }
  canvas.addEventListener('pointermove', canvasMove, { signal: aborter.signal });
  function canvasUp(event: PointerEvent): void {
    if (!sharedActive()) return;
    const drag = active; if (!drag || drag.mode !== 'move' || drag.pointer !== event.pointerId || !viewerOf() || !data) return;
    const activeViewer = viewerOf();
    const hit = activeViewer?.pickSurface(event.clientX, event.clientY);
    const mm = hit ? regionMmFromModel(drag.frame, hit.modelPosition) : null;
    const commit = mm && drag.revision === data.revision && (placeMode || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4);
    let snapped: { xMm: number; yMm: number } | null = null;
    if (commit && mm) {
      const unsnapped = event.shiftKey || event.altKey;
      const out = snapCandidate(drag.safe, { ...drag.base, xMm: mm.xMm + drag.offset.xMm, yMm: mm.yMm + drag.offset.yMm }, unsnapped);
      snapped = { xMm: out.geom.xMm, yMm: out.geom.yMm };
    }
    cancel();
    if (snapped) callbacks.move(drag.index, snapped);
    else if (!hit) { state.textContent = 'Move cancelled: release on the product surface. Position unchanged.'; callbacks.status(state.textContent); }
    placeMode = false; syncTools();
  }
  canvas.addEventListener('pointerup', canvasUp, { signal: aborter.signal });
  canvas.addEventListener('pointercancel', () => { if (sharedActive()) cancel(); }, { signal: aborter.signal });
  canvas.addEventListener('lostpointercapture', () => { if (sharedActive() && active) cancel(); }, { signal: aborter.signal });
  window.addEventListener('blur', () => { if (sharedActive()) cancel(); }, { signal: aborter.signal });
  document.addEventListener('keydown', (event) => {
    if (!sharedActive()) return;
    if (event.key === 'Escape' && (anchorName !== null || active !== null)) { event.preventDefault(); event.stopImmediatePropagation(); }
    if (event.key === 'Escape' && anchorName !== null) { anchorName = null; state.textContent = 'Reference point cancelled.'; }
    if (event.key === 'Escape' && active) {
      const wasMove = active.mode === 'move';
      cancel(); callbacks.status(wasMove ? 'Move cancelled. Position unchanged.' : 'Resize cancelled. Size unchanged.');
    }
  }, { capture: true, signal: aborter.signal });
  let markerSignature = '';
  function paintAnchors(): void {
    const activeViewer = viewerOf();
    if (!activeViewer || !data || !ready || !sharedActive()) return;
    const anchors = (data.anchors ?? []).filter((anchor) => {
      const region = data?.scene.regions.find((entry) => entry.id === anchor.regionId);
      return !region || regionVisible(region);
    });
    const signature = JSON.stringify(anchors);
    if (signature === markerSignature) return;
    markerSignature = signature; activeViewer.setAnchorMarkers(anchors);
  }
  function paintAreas(): void {
    const activeViewer = viewerOf();
    if (!activeViewer || !data || !ready || !sharedActive()) return;
    paintAnchors();
    activeViewer.setSafeAreaOverlays(data.scene.regions.map((region) => ({ id: region.id, pointsModel: region.pointsModel, selected: region.id === data?.activeRegionId })));
  }
  return {
    element,
    beginAnchorPick(name) { anchorName = name; panMode = false; forceRotate = false; placeMode = false; syncTools(); state.textContent = 'Click the product to set a named physical reference point. Escape cancels.'; },
    dropPoint(clientX, clientY) {
      if (!sharedActive()) return null;
      const activeViewer = viewerOf();
      if (!activeViewer || !ready || !data) return null;
      const mode = activeViewer.getInteractionMode();
      activeViewer.setInteractionMode('select');
      try {
        const hit = activeViewer.pickSurface(clientX, clientY); if (!hit) return null;
        let best: { regionId: string; pos: { xMm: number; yMm: number }; gap: number; inside: boolean } | null = null;
        for (const region of data.scene.regions) {
          if (!regionVisible(region)) continue;
          const mm = regionMmFromModel(region.frame, hit.modelPosition); if (!mm) continue;
          const safe = safeMmFor(region).map(([x, y]) => ({ x, y }));
          const inside = pointInPolygon(safe, { x: mm.xMm, y: mm.yMm }) !== 'outside';
          const n = region.frame.normal, origin = region.frame.origin;
          const gap = Math.abs((hit.modelPosition.x - origin.x) * n.x + (hit.modelPosition.y - origin.y) * n.y + (hit.modelPosition.z - origin.z) * n.z);
          if (!best || (inside && !best.inside) || (inside === best.inside && gap < best.gap)) best = { regionId: region.id, pos: mm, gap, inside };
        }
        return best ? { regionId: best.regionId, pos: best.pos } : null;
      } finally { activeViewer.setInteractionMode(mode); }
    },
    update(next: ViewData | null) {
      if (disposed) return;
      // Borrowed surface (root-owned unified workspace): never attach a
      // viewer, never showModel/fit/reset (camera and geometry stay owned by
      // root), never dispose the shared viewer. Take turns owning onFrame.
      if (shared) {
        if (next === null || !shared.isActive()) {
          // Inactive: drop own gestures/overlay/data safely. Clear only the
          // artwork slot (owned by placement); leave the shared viewer's
          // model, camera and foreign setup overlays intact.
          if (active) cancel();
          data = null;
          ready = false;
          artworkSignature = '';
          markerSignature = '';
          overlay.style.display = 'none';
          try { shared.getViewer()?.setSurfaceArtworkOverlays([]); } catch { /* foreign viewer state stays intact */ }
          element.removeAttribute('data-ready');
          syncTools(); syncHandles();
          return;
        }
        if (active && (data?.revision !== next.revision || data?.selectedIndex !== next.selectedIndex || data?.activeRegionId !== next.activeRegionId)) cancel();
        data = next;
        for (const src of images.keys()) if (!next.items.some((item) => item.imageSrc === src)) images.delete(src);
        const borrowed = shared.getViewer();
        // Rewire onFrame on EVERY active update (even a repeated scene key):
        // setup and placement take turns owning the frame callback.
        if (borrowed) {
          // Calibration belongs to the measurement tools. Its centred label
          // otherwise hides small logos on the shared surface. Setup restores
          // the staged reference when its tools become active again.
          borrowed.setReferenceOverlay(null);
          // Presentation-only brightness follows the saved model entry.
          // Camera and geometry stay exactly as root left them.
          try { borrowed.setLighting(normalizeModelLighting(next.scene.lighting)); } catch { /* lighting is advisory */ }
          ready = true;
          try { borrowed.onFrame = () => positionOverlay(); } catch { /* frame callback is advisory */ }
        } else {
          ready = false;
        }
        // Same scene key: no reload, no camera touch — geometry and camera
        // orientation/target/zoom stay exactly as root left them.
        key = next.scene.key;
        if (ready) {
          paintAreas(); paint(); positionOverlay(); syncTools(); syncHandles(); element.dataset.ready = 'true';
        } else {
          state.textContent = 'Loading product…';
          syncTools(); syncHandles();
        }
        return;
      }
      if (next === null) {
        if (active) cancel();
        data = null;
        ready = false;
        element.dataset.ready = 'false';
        artworkSignature = '';
        overlay.style.display = 'none';
        syncTools(); syncHandles();
        return;
      }
      if (active && (data?.revision !== next.revision || data?.selectedIndex !== next.selectedIndex || data?.activeRegionId !== next.activeRegionId)) cancel();
      data = next;
      for (const src of images.keys()) if (!next.items.some((item) => item.imageSrc === src)) images.delete(src);
      if (key !== next.scene.key) {
        key = next.scene.key; const token = ++generation; ready = false; element.dataset.ready = 'false';
        images.clear(); artworkSignature = ''; markerSignature = '';
        if (!viewer) viewer = ModelViewer.attach({ canvas, container: stage, background: 0xffffff }).viewer;
        if (!viewer) { state.textContent = 'The product view needs WebGL. Set up the product or use another supported browser.'; return; }
        try { viewer.setLighting(normalizeModelLighting(next.scene.lighting)); } catch { /* lighting is advisory */ }
        viewer.onFrame = () => positionOverlay();
        state.textContent = 'Loading product…';
        void viewer.showModel(next.scene.bytes.slice()).then((result) => {
          if (disposed || token !== generation) return;
          ready = result.kind === 'ready';
          if (!ready) { state.textContent = 'The product model could not be opened.'; return; }
          try { viewer?.setLighting(normalizeModelLighting(next.scene.lighting)); } catch { /* lighting is advisory */ }
          if (customer) { viewer?.setViewSide('front'); viewer?.fitCurrentView(); }
          paintAreas(); paint(); positionOverlay(); syncTools(); syncHandles(); element.dataset.ready = 'true';
        });
      } else {
        try { viewer?.setLighting(normalizeModelLighting(next.scene.lighting)); } catch { /* lighting is advisory */ }
        paintAreas(); paint(); positionOverlay(); syncTools(); syncHandles();
      }
    },
    destroy() {
      disposed = true; ++generation;
      if (shared) {
        // Borrowed surface: abort only own listeners/overlays. The shared
        // viewer, its model/camera and the shared canvas/stage stay intact
        // for root; foreign setup overlays are never touched.
        if (active) cancel();
        try { aborter.abort(); } catch { /* listeners already released */ }
        try { shared.getViewer()?.setSurfaceArtworkOverlays([]); } catch { /* foreign viewer state stays intact */ }
        try { overlay.remove(); } catch { /* overlay already detached */ }
        images.clear();
        try { element.remove(); } catch { /* host teardown owns the rest */ }
        viewer = null;
        return;
      }
      cancel(); aborter.abort(); viewer?.dispose(); viewer = null; images.clear(); element.remove();
    },
  };
}
