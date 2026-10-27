/// <reference lib="dom" />
import { ModelViewer, type SurfaceArtworkItem } from '../../viewer/model-viewer.js';
import { modelPointFromMm, regionMmFromModel, type ModelPoint, type ModelRegionFrame } from '../../core/model-placement/index.js';
import { rotatedFootprintCorners } from '../../core/operation-measurements/index.js';
import type { Placement } from '../../core/types.js';

export interface ModelPlacementRegion { id: string; frame: ModelRegionFrame; pointsModel: ModelPoint[] }
export interface ModelPlacementScene { key: string; bytes: Uint8Array; regions: ModelPlacementRegion[] }
export interface ModelPlacementItem { index: number; placement: Placement; imageSrc: string | null; fits: boolean }
interface ViewData { scene: ModelPlacementScene; items: ModelPlacementItem[]; selectedIndex: number; activeRegionId: string | null; revision: string; status: string }
export interface ModelPlacementView {
  element: HTMLElement;
  update(data: ViewData): void;
  destroy(): void;
}

/** Persistent camera + local raster assets. Only release commits canonical mm. */
export function createModelPlacementView(callbacks: {
  select(index: number): void;
  move(index: number, pos: { xMm: number; yMm: number }): void;
  status(message: string): void;
  expand(): void;
  isExpanded(): boolean;
  toggleDetails(): boolean;
  save?(): void;
}): ModelPlacementView {
  const element = document.createElement('section'); element.className = 'model-placement-workbench';
  element.setAttribute('data-placement-hook', 'pw-model-workbench');
  const bar = document.createElement('div'); bar.className = 'model-placement-toolbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Product placement controls');
  const stage = document.createElement('div'); stage.className = 'model-placement-stage';
  const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', 'Place logos directly on the product'); canvas.setAttribute('data-placement-hook', 'pw-model-canvas');
  stage.append(canvas);
  const hint = document.createElement('p'); hint.className = 'pw-muted';
  hint.textContent = 'Drag a logo to move it; drag empty product to rotate. Move logo lets you click a new spot. Sizes and positions stay in millimetres.';
  const notice = document.createElement('p'); notice.className = 'pw-muted'; notice.textContent = 'Provisional surface preview — verify physical measurements before production.';
  const state = document.createElement('p'); state.className = 'pw-status pw-muted'; state.setAttribute('role', 'status'); state.setAttribute('data-placement-hook', 'pw-model-status');
  element.append(bar, stage, hint, notice, state);
  let viewer: ModelViewer | null = null;
  let data: ViewData | null = null;
  let key = '', generation = 0, disposed = false, ready = false, forceRotate = false, placeMode = false;
  let artworkSignature = '';
  const images = new Map<string, HTMLImageElement | null>();
  const aborter = new AbortController();
  let active: { index: number; pointer: number; frame: ModelRegionFrame; offset: { xMm: number; yMm: number }; startX: number; startY: number; revision: string; preview: { xMm: number; yMm: number } | null } | null = null;
  let frameRequest = 0;
  const buttons: HTMLButtonElement[] = [];
  function button(label: string, action: () => void, hook: string): HTMLButtonElement {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'pw-secondary'; node.textContent = label;
    node.setAttribute('data-placement-hook', hook); node.addEventListener('click', action); bar.append(node); buttons.push(node); return node;
  }
  const rotate = button('Rotate', () => { forceRotate = true; placeMode = false; syncTools(); }, 'pw-model-rotate');
  const move = button('Move logo', () => { forceRotate = false; placeMode = true; syncTools(); }, 'pw-model-move');
  button('Front', () => viewer?.setViewSide('front'), 'pw-model-front');
  button('Back', () => viewer?.setViewSide('back'), 'pw-model-back');
  button('Fit', () => viewer?.resetZoom(), 'pw-model-fit');
  button('−', () => zoom(-1), 'pw-model-zoom-out').setAttribute('aria-label', 'Zoom out product');
  button('+', () => zoom(1), 'pw-model-zoom-in').setAttribute('aria-label', 'Zoom in product');
  const expand = button('Enlarge workspace', () => { callbacks.expand(); syncTools(); }, 'pw-model-expand');
  const details = button('Logo details', () => { details.setAttribute('aria-expanded', String(callbacks.toggleDetails())); }, 'pw-model-details');
  details.classList.add('model-placement-details-button'); details.setAttribute('aria-expanded', 'false');
  if (callbacks.save) button('Save job', () => callbacks.save?.(), 'pw-model-save-job');
  function syncTools(): void {
    rotate.setAttribute('aria-pressed', String(forceRotate)); move.setAttribute('aria-pressed', String(placeMode));
    move.disabled = data === null || data.selectedIndex < 0;
    expand.textContent = callbacks.isExpanded() ? 'Close enlarged view' : 'Enlarge workspace';
    expand.setAttribute('aria-expanded', String(callbacks.isExpanded()));
    state.textContent = placeMode ? 'Click the product to position the selected logo.' : data?.status || 'Drag a logo to move it, or rotate the product.';
  }
  function zoom(direction: number): void {
    const steps = [50, 75, 100, 125, 150, 200, 300, 400];
    const i = steps.indexOf(viewer?.getZoomPercent() ?? 100);
    viewer?.setZoomPercent(steps[Math.min(steps.length - 1, Math.max(0, i + direction))]!);
  }
  function regionFor(item: ModelPlacementItem): ModelPlacementRegion | undefined { return data?.scene.regions.find((region) => region.id === item.placement.regionId); }
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
  function paint(preview?: { index: number; pos: { xMm: number; yMm: number } }): void {
    if (!viewer || !ready || !data || disposed) return;
    const signature = JSON.stringify([data.scene.regions, data.items.map((item) => [item.index, item.placement, item.fits, item.imageSrc, item.imageSrc ? images.get(item.imageSrc)?.complete : false]), data.selectedIndex, preview]);
    if (signature === artworkSignature) return;
    const overlays: SurfaceArtworkItem[] = [];
    for (const item of data.items) {
      const region = regionFor(item);
      if (!region || !item.imageSrc) continue;
      const image = loadImage(item.imageSrc); if (!image) continue;
      const p = item.placement;
      const pos = preview?.index === item.index ? preview.pos : p.pos;
      const corners = rotatedFootprintCorners(pos.xMm, pos.yMm, p.widthMm, p.heightMm, p.rotationDeg)
        .map((point) => modelPointFromMm(region.frame, point.x, point.y));
      if (corners.some((point) => point === null)) continue;
      const reach = Math.max(...region.pointsModel.map((point) => Math.hypot(point.x - region.frame.origin.x, point.y - region.frame.origin.y, point.z - region.frame.origin.z))) * 3;
      const anchor = region.pointsModel[0]; if (!anchor) continue;
      overlays.push({ id: String(item.index), cornersModel: corners as ModelPoint[], anchorModel: anchor, depthModel: Math.max(reach, p.widthMm / region.frame.mmPerUnit), image, fits: item.fits, selected: item.index === data.selectedIndex });
    }
    viewer.setSurfaceArtworkOverlays(overlays);
    element.dataset.projectedArtworkCount = String(overlays.length);
    element.dataset.artworkCount = String(viewer.getSurfaceArtworkCount());
    artworkSignature = signature;
  }
  function cancel(): void {
    const old = active; active = null; viewer?.setOrbitEnabled(true);
    if (old) { try { canvas.releasePointerCapture(old.pointer); } catch { /* released already */ } }
    if (frameRequest) cancelAnimationFrame(frameRequest); frameRequest = 0;
    artworkSignature = ''; paint();
  }
  function hitItem(point: ModelPoint): ModelPlacementItem | undefined {
    let best: ModelPlacementItem | undefined, distance = Infinity;
    for (const item of data?.items ?? []) {
      const region = regionFor(item); if (!region) continue;
      const mm = regionMmFromModel(region.frame, point); if (!mm) continue;
      const p = item.placement, dx = mm.xMm - p.pos.xMm, dy = mm.yMm - p.pos.yMm, rad = p.rotationDeg * Math.PI / 180;
      const x = dx * Math.cos(rad) - dy * Math.sin(rad), y = dx * Math.sin(rad) + dy * Math.cos(rad);
      if (Math.abs(x) > p.widthMm / 2 || Math.abs(y) > p.heightMm / 2) continue;
      const onPlane = modelPointFromMm(region.frame, mm.xMm, mm.yMm); if (!onPlane) continue;
      const depth = Math.hypot(point.x - onPlane.x, point.y - onPlane.y, point.z - onPlane.z);
      if (depth < distance) { distance = depth; best = item; }
    }
    return best;
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (!viewer || !ready || !data || forceRotate || event.button !== 0 || !event.isPrimary) return;
    const hit = viewer.pickSurface(event.clientX, event.clientY); if (!hit) return;
    const item = placeMode ? data.items.find((entry) => entry.index === data?.selectedIndex) : hitItem(hit.modelPosition);
    if (!item) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (item.index !== data.selectedIndex) { callbacks.select(item.index); return; }
    const region = regionFor(item); if (!region) return;
    const mm = regionMmFromModel(region.frame, hit.modelPosition); if (!mm) return;
    active = { index: item.index, pointer: event.pointerId, frame: region.frame, offset: placeMode ? { xMm: 0, yMm: 0 } : { xMm: item.placement.pos.xMm - mm.xMm, yMm: item.placement.pos.yMm - mm.yMm }, startX: event.clientX, startY: event.clientY, revision: data.revision, preview: null };
    viewer.setOrbitEnabled(false); canvas.setPointerCapture(event.pointerId);
  }, { capture: true, signal: aborter.signal });
  canvas.addEventListener('pointermove', (event) => {
    if (!active || active.pointer !== event.pointerId || !viewer) return;
    const hit = viewer.pickSurface(event.clientX, event.clientY);
    const mm = hit ? regionMmFromModel(active.frame, hit.modelPosition) : null;
    active.preview = mm ? { xMm: mm.xMm + active.offset.xMm, yMm: mm.yMm + active.offset.yMm } : null;
    if (!frameRequest) frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (active?.preview) paint({ index: active.index, pos: active.preview });
    });
  }, { signal: aborter.signal });
  canvas.addEventListener('pointerup', (event) => {
    const drag = active; if (!drag || drag.pointer !== event.pointerId || !viewer || !data) return;
    const hit = viewer.pickSurface(event.clientX, event.clientY);
    const mm = hit ? regionMmFromModel(drag.frame, hit.modelPosition) : null;
    const commit = mm && drag.revision === data.revision && (placeMode || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4);
    cancel();
    if (commit && mm) callbacks.move(drag.index, { xMm: mm.xMm + drag.offset.xMm, yMm: mm.yMm + drag.offset.yMm });
    else if (!hit) { state.textContent = 'Move cancelled: release on the product surface. Position unchanged.'; callbacks.status(state.textContent); }
    placeMode = false; syncTools();
  }, { signal: aborter.signal });
  canvas.addEventListener('pointercancel', cancel, { signal: aborter.signal });
  canvas.addEventListener('lostpointercapture', () => { if (active) cancel(); }, { signal: aborter.signal });
  window.addEventListener('blur', cancel, { signal: aborter.signal });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && active) { cancel(); callbacks.status('Move cancelled. Position unchanged.'); } }, { signal: aborter.signal });
  function paintAreas(): void {
    if (!viewer || !data || !ready) return;
    viewer.setSafeAreaOverlays(data.scene.regions.map((region) => ({ id: region.id, pointsModel: region.pointsModel, selected: region.id === data?.activeRegionId })));
  }
  return {
    element,
    update(next) {
      if (disposed) return;
      if (active && (data?.revision !== next.revision || data?.selectedIndex !== next.selectedIndex || data?.activeRegionId !== next.activeRegionId)) cancel();
      data = next;
      for (const src of images.keys()) if (!next.items.some((item) => item.imageSrc === src)) images.delete(src);
      if (key !== next.scene.key) {
        key = next.scene.key; const token = ++generation; ready = false;
        images.clear(); artworkSignature = '';
        if (!viewer) viewer = ModelViewer.attach({ canvas, container: stage, background: 0xffffff }).viewer;
        if (!viewer) { state.textContent = 'The product view needs WebGL. Set up the product or use another supported browser.'; return; }
        state.textContent = 'Loading product…';
        void viewer.showModel(next.scene.bytes.slice()).then((result) => {
          if (disposed || token !== generation) return;
          ready = result.kind === 'ready';
          if (!ready) { state.textContent = 'The product model could not be opened.'; return; }
          paintAreas(); paint(); syncTools(); element.dataset.ready = 'true';
        });
      } else { paintAreas(); paint(); syncTools(); }
    },
    destroy() { disposed = true; ++generation; cancel(); aborter.abort(); viewer?.dispose(); viewer = null; images.clear(); element.remove(); },
  };
}
