/// <reference lib="dom" />
/** Local model document views. Cameras are presentation metadata; physical mm never change here. */
import { ModelViewer, normalizeModelLighting, type ViewerCameraState, type SurfaceArtworkItem } from '../../viewer/model-viewer.js';
import type { ProjectDocument, Configuration, ResultCandidate } from '../../core/types.js';
import { modelPointFromMm } from '../../core/model-placement/index.js';
import { matchLogoRef, formatMm1 } from '../../core/operation-document/index.js';
import type { AnchorDef, DimensionBinding, ResolvedDimension } from '../../core/operation-measurements/types.js';
import { measurePlacement, rotatedFootprintCorners } from '../../core/operation-measurements/index.js';
import {
  parseModelDocumentViewList, serializeModelDocumentViews, cameraDigest, modelViewRenderKey,
  type ModelDocumentView, type ModelViewCamera,
} from '../../core/presentation-views/model-document-views.js';
import type { ModelPlacementScene } from './model-placement-view.js';
import type { DocumentReviewModelView, DocumentReviewDeps } from './document-review.js';

export const MODEL_DOCUMENT_VIEWS_PATH = 'presentation/model-document-views.json';
interface Deps {
  active?(): boolean;
  project(): ProjectDocument | null;
  scene(productId: string, variantId: string): ModelPlacementScene | null;
  logo(logoId: string): { src: string } | null;
  metadata(): Uint8Array | undefined;
  persist(bytes: Uint8Array): void;
  changed(): void;
  status(message: string): void;
}
const fromViewer = (state: ViewerCameraState): ModelViewCamera => ({
  position: [state.position.x, state.position.y, state.position.z],
  target: [state.target.x, state.target.y, state.target.z],
  up: state.up ? [state.up.x, state.up.y, state.up.z] : [0, 1, 0], fov: state.fov ?? 45,
});
const toViewer = (camera: ModelViewCamera): ViewerCameraState => ({
  position: { x: camera.position[0], y: camera.position[1], z: camera.position[2] },
  target: { x: camera.target[0], y: camera.target[1], z: camera.target[2] },
  up: { x: camera.up[0], y: camera.up[1], z: camera.up[2] }, fov: camera.fov, zoomPct: 0, mode: 'select',
});
interface MeasurementInput { candidate: ResultCandidate | null; anchors: readonly AnchorDef[]; bindings: Record<string, readonly DimensionBinding[]> }
interface RenderDimension { regionId: string; ref: number; dimension: ResolvedDimension }
const scoped = (view: ModelDocumentView, config: Configuration): boolean =>
  view.productId === config.productId && view.variantId === config.variantId;

export function createModelDocumentController(deps: Deps): {
  snapshot(project: ProjectDocument, measurements?: MeasurementInput): Record<string, readonly DocumentReviewModelView[]>;
  ops: NonNullable<DocumentReviewDeps['modelViewOps']>;
} {
  const renders = new Map<string, DocumentReviewModelView>();
  const pending = new Set<string>();
  const bitmaps = new Map<string, Promise<HTMLImageElement>>();
  let queue: Promise<void> = Promise.resolve();
  let renderViewer: ModelViewer | null = null, renderScene = '';
  let renderHost: HTMLElement | null = null;
  let editor: HTMLDialogElement | null = null;
  let editorViewer: ModelViewer | null = null;
  let owner = '';
  let source: ProjectDocument | null = null, sourceEpoch = 0;
  const snapshotSources = new WeakMap<ProjectDocument, ProjectDocument>();

  function readViews(): ModelDocumentView[] {
    const bytes = deps.metadata();
    if (!bytes) return [];
    if (bytes.length > 512 * 1024) throw new Error('Saved document views exceed the supported metadata size.');
    const parsed = parseModelDocumentViewList(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
    if (!parsed) throw new Error('Saved document views could not be read. The original metadata is preserved.');
    return parsed;
  }
  function saveViews(views: ModelDocumentView[]): void {
    deps.persist(new TextEncoder().encode(serializeModelDocumentViews(views)));
    deps.changed();
  }
  function image(src: string): Promise<HTMLImageElement> {
    let found = bitmaps.get(src);
    if (!found) {
      found = new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('Artwork could not be decoded.')); img.src = src; });
      bitmaps.set(src, found);
    }
    return found;
  }
  async function artwork(viewer: ModelViewer, scene: ModelPlacementScene, config: Configuration): Promise<void> {
    const items: SurfaceArtworkItem[] = [];
    for (const placement of config.placements) {
      const region = scene.regions.find((r) => r.id === placement.regionId);
      const logo = deps.logo(placement.logoId);
      if (!region || !logo) throw new Error('A placed logo has no calibrated model mapping or artwork preview.');
      const corners = rotatedFootprintCorners(placement.pos.xMm, placement.pos.yMm, placement.widthMm, placement.heightMm, placement.rotationDeg)
        .map((p) => modelPointFromMm(region.frame, p.x, p.y));
      if (corners.some((p) => p === null) || !region.pointsModel[0]) throw new Error('The artwork cannot be mapped to this model.');
      const reach = Math.max(...region.pointsModel.map((p) => Math.hypot(p.x - region.frame.origin.x, p.y - region.frame.origin.y, p.z - region.frame.origin.z))) * 3;
      items.push({ id: placement.id ?? String(items.length), cornersModel: corners as NonNullable<typeof corners[number]>[],
        anchorModel: region.pointsModel[0], depthModel: Math.max(reach, placement.widthMm / region.frame.mmPerUnit),
        image: await image(logo.src), selected: false, fits: true });
    }
    viewer.setSurfaceArtworkOverlays(items);
  }
  async function hiddenViewer(scene: ModelPlacementScene): Promise<ModelViewer> {
    if (!renderViewer) {
      renderHost = document.createElement('div');
      renderHost.style.cssText = 'position:fixed;left:-10000px;top:0;width:720px;height:960px;pointer-events:none';
      renderHost.setAttribute('aria-hidden', 'true');
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:100%;height:100%'; renderHost.append(canvas); document.body.append(renderHost);
      renderViewer = ModelViewer.attach({ canvas, container: renderHost, background: 0xffffff }).viewer;
      if (!renderViewer) throw new Error('WebGL is required to render model document views.');
    }
    if (renderScene !== scene.key) {
      const result = await renderViewer.showModel(scene.bytes.slice());
      if (result.kind !== 'ready') throw new Error('The document model could not be opened.');
      renderScene = scene.key;
    }
    // Presentation-only brightness follows the saved model entry; the cached
    // model is reused and the camera is never touched here.
    try { renderViewer.setLighting(normalizeModelLighting(scene.lighting)); } catch { /* lighting is advisory */ }
    return renderViewer;
  }
  function sameSource(project: ProjectDocument, config: Configuration, scene: ModelPlacementScene): boolean {
    const live = deps.project();
    const liveScene = deps.scene(config.productId, config.variantId);
    return live === (snapshotSources.get(project) ?? project) && live?.projectId === project.projectId && live.revision === project.revision
      && liveScene?.key === scene.key
      && normalizeModelLighting(liveScene.lighting) === normalizeModelLighting(scene.lighting);
  }
  function enqueue(key: string, work: () => Promise<void>): void {
    if (pending.has(key)) return;
    pending.add(key);
    queue = queue.then(work).catch((error: unknown) => deps.status(error instanceof Error ? error.message : String(error)))
      .finally(() => pending.delete(key));
  }
  function defaultViews(project: ProjectDocument, config: Configuration, scene: ModelPlacementScene): void {
    enqueue(`defaults:${owner}:${config.id}`, async () => {
      const viewer = await hiddenViewer(scene);
      viewer.resetView(); viewer.setViewSide('front'); viewer.fitCurrentView();
      if (!sameSource(project, config, scene)) return;
      const regions = [...new Set(config.placements.map((p) => p.regionId))];
      const remaining = new Set(regions.length > 0 ? regions : scene.regions.map((r) => r.id));
      const added: ModelDocumentView[] = [];
      for (const side of ['front', 'back', 'left', 'right'] as const) {
        viewer.setViewSide(side); viewer.fitCurrentView();
        const state = viewer.getCameraState(); if (!state) throw new Error('The default model camera is unavailable.');
        const visible = [...remaining].filter((id) => {
          const region = scene.regions.find((r) => r.id === id);
          return region?.pointsModel[0] && viewer.isSurfaceFacing(region.pointsModel[0], region.frame.normal) !== false;
        });
        if (visible.length > 0 || (side === 'front' && remaining.size === 0)) {
          added.push({ id: side, label: side[0]!.toUpperCase() + side.slice(1), productId: config.productId, variantId: config.variantId,
            modelAssetId: scene.key, modelRevision: scene.key, camera: fromViewer(state), associatedRegions: visible });
          for (const id of visible) remaining.delete(id);
        }
        if (remaining.size === 0) break;
      }
      if (remaining.size > 0) deps.status('Some placed areas are hidden in standard views. Add an adjusted document view for them.');
      const current = readViews();
      if (!current.some((v) => scoped(v, config)) && sameSource(project, config, scene)) saveViews([...current, ...added]);
    });
  }
  async function annotate(dataUrl: string, viewer: ModelViewer, scene: ModelPlacementScene, config: Configuration, view: ModelDocumentView, dimensions: RenderDimension[]): Promise<string> {
    if (!renderHost) return dataUrl;
    const picture = new Image(); picture.src = dataUrl; await picture.decode();
    const canvas = document.createElement('canvas'); canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
    const ctx = canvas.getContext('2d'); if (!ctx) return dataUrl; ctx.drawImage(picture, 0, 0);
    const bounds = renderHost.getBoundingClientRect();
    const projectPoint = (regionId: string, point: { x: number; y: number }): { x: number; y: number } | null => {
      if (!view.associatedRegions.includes(regionId)) return null;
      const region = scene.regions.find((r) => r.id === regionId); if (!region) return null;
      const model = modelPointFromMm(region.frame, point.x, point.y); if (!model) return null;
      const client = viewer.projectToClient(model, false); if (!client) return null;
      return { x: (client.x - bounds.left) * canvas.width / bounds.width, y: (client.y - bounds.top) * canvas.height / bounds.height };
    };
    const within = (point: { x: number; y: number }): boolean => point.x >= 0 && point.x <= canvas.width && point.y >= 0 && point.y <= canvas.height;
    const labels: Array<{ x: number; y: number; w: number; h: number }> = [];
    ctx.font = '600 40px system-ui, sans-serif'; ctx.lineWidth = 2.5; ctx.strokeStyle = '#155b7d';
    for (const item of dimensions) {
      const a = projectPoint(item.regionId, item.dimension.endpoints[0]), b = projectPoint(item.regionId, item.dimension.endpoints[1]);
      if (!a || !b || !within(a) || !within(b)) continue;
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy); if (length < 1) continue;
      ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const angle = Math.atan2(dy, dx);
      for (const [point, direction] of [[a, angle], [b, angle + Math.PI]] as const) {
        ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(point.x + 11 * Math.cos(direction + .4), point.y + 11 * Math.sin(direction + .4));
        ctx.moveTo(point.x, point.y); ctx.lineTo(point.x + 11 * Math.cos(direction - .4), point.y + 11 * Math.sin(direction - .4)); ctx.stroke();
      }
      if (item.dimension.artworkPoint) {
        const edge = projectPoint(item.regionId, item.dimension.artworkPoint);
        if (edge) { ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(edge.x, edge.y); ctx.lineTo(a.x, a.y); ctx.stroke(); ctx.setLineDash([]); }
      }
      const text = `${item.ref} — ${formatMm1(item.dimension.valueMm)} mm`;
      const w = ctx.measureText(text).width + 14, h = 50;
      const x = Math.min(canvas.width - w - 4, Math.max(4, (a.x + b.x - w) / 2));
      let y = Math.max(4, Math.min(canvas.height - h - 4, (a.y + b.y) / 2 - h - 6));
      for (let tries = 0; tries < 8 && labels.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y); tries++) y = Math.min(canvas.height - h - 4, y + h + 5);
      labels.push({ x, y, w, h }); ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, w, h); ctx.fillStyle = '#155b7d'; ctx.fillText(text, x + 7, y + 38);
      ctx.fillStyle = '#fff'; ctx.fillRect(b.x - 4, b.y - 4, 8, 8); ctx.strokeRect(b.x - 4, b.y - 4, 8, 8);
    }
    // These numbers match the explicit placement numbers on the logo panels.
    config.placements.forEach((placement, index) => {
      const corner = rotatedFootprintCorners(placement.pos.xMm, placement.pos.yMm, placement.widthMm, placement.heightMm, placement.rotationDeg)[3]!;
      const point = projectPoint(placement.regionId, corner); if (!point || !within(point)) return;
      const x = Math.max(24, Math.min(canvas.width - 24, point.x - 24)), y = Math.max(24, Math.min(canvas.height - 24, point.y - 24));
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 23, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#155b7d'; ctx.font = '600 34px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(index + 1), x, y + 11); ctx.textAlign = 'start';
    });
    return canvas.toDataURL('image/png');
  }

  function capture(project: ProjectDocument, config: Configuration, scene: ModelPlacementScene, view: ModelDocumentView, dimensions: RenderDimension[]): DocumentReviewModelView {
    const key = JSON.stringify([owner, config.id, modelViewRenderKey(view, project.revision), normalizeModelLighting(scene.lighting), dimensions]);
    const cached = renders.get(key);
    if (cached) return cached;
    const result: DocumentReviewModelView = { view, render: null, status: 'pending' }; renders.set(key, result);
    enqueue(key, async () => {
      try {
        const viewer = await hiddenViewer(scene);
        await artwork(viewer, scene, config);
        if (!sameSource(project, config, scene)) { renders.delete(key); return; }
        if (!viewer.setCameraState(toViewer(view.camera))) throw new Error('The saved document camera is invalid.');
        const shot = await viewer.captureCleanView({ revision: String(project.revision), width: 720, height: 960 });
        const live = readViews().find((v) => scoped(v, config) && v.id === view.id);
        if (!sameSource(project, config, scene) || !live || modelViewRenderKey(live, project.revision) !== modelViewRenderKey(view, project.revision)) { renders.delete(key); return; }
        if (!shot) throw new Error('The model view could not be captured.');
        const annotated = await annotate(shot.dataURL, viewer, scene, config, view, dimensions);
        if (!sameSource(project, config, scene)) { renders.delete(key); return; }
        result.status = 'ready'; result.render = { dataUrl: annotated, width: shot.width, height: shot.height, revision: project.revision, cameraKey: cameraDigest(view.camera, view.framing) };
      } catch (error) { result.status = 'failed'; result.note = error instanceof Error ? error.message : String(error); }
      deps.changed();
    });
    // Old revision renders are disposable derived data; bound retained PNG memory.
    if (renders.size > 48) for (const old of [...renders.keys()].slice(0, renders.size - 48)) renders.delete(old);
    return result;
  }
  function configFor(id: string): Configuration | undefined { return deps.project()?.configurations.find((c) => c.id === id); }
  function edit(configId: string, viewId?: string): void {
    const config = configFor(configId), project = deps.project(); if (!config || !project) return;
    const scene = deps.scene(config.productId, config.variantId); if (!scene) return;
    if (editor) editor.close();
    const dialog = document.createElement('dialog'); editor = dialog;
    dialog.setAttribute('aria-label', 'Adjust document model view');
    dialog.style.cssText = 'width:min(1000px,92vw);max-height:92vh;padding:16px;border:1px solid #c6ced6;border-radius:10px;color:#192d3d';
    const title = document.createElement('h3'); title.textContent = viewId ? 'Adjust document view' : 'Add document view'; title.style.margin = '0 0 8px';
    const tools = document.createElement('div'); tools.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px';
    const stage = document.createElement('div'); stage.style.cssText = 'width:min(100%,43.5vh,405px);aspect-ratio:3/4;margin:0 auto;position:relative;border:1px solid #e4e8ec';
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:100%;height:100%;touch-action:none'; canvas.setAttribute('aria-label', 'Adjust product rotation, zoom and position for the document'); stage.append(canvas);
    const label = document.createElement('label'); label.textContent = 'View name '; const name = document.createElement('input'); name.maxLength = 80;
    const views = readViews(), original = views.find((v) => scoped(v, config) && v.id === viewId);
    name.value = original?.label ?? original?.id ?? 'Product view'; label.append(name);
    const state = document.createElement('p'); state.setAttribute('role', 'status'); state.textContent = 'Opening model…';
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px';
    const button = (host: HTMLElement, text: string, run: () => void): HTMLButtonElement => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.style.cssText = 'min-height:40px;padding:6px 12px'; b.onclick = run; host.append(b); return b; };
    let ready = false;
    for (const side of ['front', 'back', 'left', 'right'] as const) button(tools, side[0]!.toUpperCase() + side.slice(1), () => editorViewer?.setViewSide(side));
    button(tools, 'Rotate', () => editorViewer?.setInteractionMode('select'));
    button(tools, 'Pan', () => editorViewer?.setInteractionMode('pan'));
    button(tools, 'Fit', () => editorViewer?.fitCurrentView());
    button(tools, 'Zoom in', () => editorViewer?.setZoomPercent(Math.min(400, (editorViewer?.getZoomPercent() ?? 100) * 1.25)));
    button(tools, 'Zoom out', () => editorViewer?.setZoomPercent(Math.max(50, (editorViewer?.getZoomPercent() ?? 100) / 1.25)));
    button(actions, 'Cancel', () => dialog.close());
    const save = button(actions, 'Use this view', () => {
      if (!ready || !sameSource(project, config, scene)) { state.textContent = 'The job changed while adjusting this view. Close and reopen it.'; return; }
      const camera = editorViewer?.getCameraState(); if (!camera) return;
      const current = readViews(), own = current.filter((v) => scoped(v, config));
      if (!original && own.length >= 12) { state.textContent = 'This option already has 12 document views. Remove a view first.'; return; }
      let id = original?.id ?? 'view-1';
      if (!original) { let n = 1; while (own.some((v) => v.id === id)) id = `view-${++n}`; }
      const associatedRegions = scene.regions.filter((r) => r.pointsModel[0] && editorViewer?.isSurfaceFacing(r.pointsModel[0], r.frame.normal) !== false).map((r) => r.id);
      const next: ModelDocumentView = { id, label: name.value.trim() || 'Product view', productId: config.productId, variantId: config.variantId,
        modelAssetId: scene.key, modelRevision: scene.key, camera: fromViewer(camera), associatedRegions };
      const index = current.findIndex((v) => scoped(v, config) && v.id === id);
      if (index >= 0) current[index] = next; else current.push(next);
      saveViews(current); dialog.close();
    }); save.disabled = true;
    dialog.append(title, tools, stage, label, state, actions); document.body.append(dialog); dialog.showModal();
    const attached = ModelViewer.attach({ canvas, container: stage, background: 0xffffff }); editorViewer = attached.viewer;
    dialog.addEventListener('close', () => { if (editor === dialog) { editorViewer?.dispose(); editorViewer = null; editor = null; } dialog.remove(); }, { once: true });
    const viewer = editorViewer;
    void (async () => {
      try {
        if (!viewer || (await viewer.showModel(scene.bytes.slice())).kind !== 'ready') throw new Error('The model could not be opened.');
        try { viewer.setLighting(normalizeModelLighting(scene.lighting)); } catch { /* lighting is advisory */ }
        await artwork(viewer, scene, config);
        if (!dialog.isConnected) return;
        if (original) viewer.setCameraState(toViewer(original.camera)); else { viewer.setViewSide('front'); viewer.fitCurrentView(); }
        state.textContent = 'Rotate, pan or zoom the model. Only this document view changes.'; ready = true; save.disabled = false;
      } catch (error) { state.textContent = error instanceof Error ? error.message : String(error); }
    })();
  }
  return {
    snapshot(project, measurements) {
      if (deps.active?.() === false) return Object.create(null) as Record<string, readonly DocumentReviewModelView[]>;
      const currentSource = deps.project();
      if (!currentSource) return Object.create(null) as Record<string, readonly DocumentReviewModelView[]>;
      snapshotSources.set(project, currentSource);
      if (source !== currentSource) {
        source = currentSource; sourceEpoch++; renders.clear(); bitmaps.clear(); renderScene = '';
      }
      owner = `${project.projectId}:${sourceEpoch}`;
      const out: Record<string, readonly DocumentReviewModelView[]> = Object.create(null);
      let views: ModelDocumentView[];
      try { views = readViews(); } catch (error) { deps.status(error instanceof Error ? error.message : String(error)); return out; }
      for (const config of project.configurations) {
        const scene = deps.scene(config.productId, config.variantId); if (!scene) continue;
        const own = views.filter((v) => scoped(v, config));
        if (own.length === 0 && deps.metadata() === undefined) defaultViews(project, config, scene);
        const dimensions: RenderDimension[] = [];
        const candidateConfig = measurements?.candidate?.configurations.find((entry) => entry.id === config.id);
        if (candidateConfig && measurements?.candidate) {
          let ref = 1;
          for (const placement of candidateConfig.placements) {
            const bindings = (measurements.bindings[config.id] ?? []).filter((binding) => matchLogoRef(candidateConfig.placements, binding.logoRef) === placement);
            const measured = measurePlacement(measurements.candidate, placement, measurements.anchors, bindings);
            for (const dimension of measured.dimensions) dimensions.push({ regionId: placement.regionId, ref: ref++, dimension });
          }
        }
        out[config.id] = own.map((view) => view.modelRevision === scene.key
          ? capture(project, config, scene, view, dimensions)
          : { view, render: null, status: 'failed', note: 'The model was replaced. Adjust this view against the current product.' });
      }
      return out;
    },
    ops: {
      add: (configId) => edit(configId), reframe: (configId, id) => edit(configId, id),
      remove(configId, id) { const config = configFor(configId); if (!config) return; saveViews(readViews().filter((v) => !(scoped(v, config) && v.id === id))); },
      move(configId, id, direction) {
        const config = configFor(configId); if (!config) return;
        const current = readViews(); const indices = current.flatMap((v, i) => scoped(v, config) ? [i] : []);
        const ownIndex = indices.findIndex((i) => current[i]!.id === id), target = ownIndex + direction;
        if (ownIndex < 0 || target < 0 || target >= indices.length) return;
        const a = indices[ownIndex]!, b = indices[target]!; [current[a], current[b]] = [current[b]!, current[a]!]; saveViews(current);
      },
      retry(configId, id) { const config = configFor(configId); if (!config) return; for (const [key, entry] of renders) if (scoped(entry.view, config) && entry.view.id === id) renders.delete(key); deps.changed(); },
    },
  };
}
