/**
 * model-viewer.ts — Three.js GLB preview for the internal asset prototype.
 *
 * DOM and Three.js imports are isolated to this module so the lead can wire
 * it under a separate tsconfig that includes DOM libs and the `three`
 * dependency. Nothing else in `src/` may import browser or Three.js APIs.
 *
 * Data flow (parse-from-memory only):
 *   already-validated GLB bytes (Uint8Array) -> GLTFLoader.parse ->
 *   scene graph attached to an internal wrapper group -> rendered with
 *   OrbitControls for orbit. The loader NEVER fetches a URL: no
 *   `load()`, no `fetch()`, no sibling-asset resolution. External resources
 *   must already have been rejected by the asset-ingestion validator before
 *   bytes reach this viewer.
 *
 * Framing transforms (fit/reset) apply to the internal wrapper group only;
 * the parsed model subtree is never mutated, so the same bytes always
 * produce the same scene content.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

/** Failure modes surfaced to the embedding UI. Never throws raw. */
export type ViewerStatus =
  | { kind: 'ready' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'webgl-unavailable'; message: string }
  | { kind: 'parse-failed'; message: string };

export interface ModelViewerOptions {
  /** Canvas to render into. The viewer takes over its size via the container. */
  canvas: HTMLCanvasElement;
  /** Element the canvas fills; observed for resizes. Defaults to canvas parent. */
  container?: HTMLElement;
  /** Scene background. Defaults to a neutral dark grey. */
  background?: number;
}
export interface RegionAxesFrame {
  origin: { x: number; y: number; z: number };
  xDir: { x: number; y: number; z: number };
  yDir: { x: number; y: number; z: number };
  lengthMm: number;
  mmPerModelUnit: number;
}
/** One named safe-area polygon on the model in wrapper-local model coords. */
export interface SafeAreaOverlayItem {
  id: string;
  pointsModel: Array<{ x: number; y: number; z: number }>;
  /**
   * Optional selection flag (additive): a selected area renders with a
   * distinct outline/fill so it stays distinguishable over the product.
   * Missing/false keeps the default blue treatment.
   */
  selected?: boolean;
}

/**
 * Reference measurement overlay: two surface endpoints plus the human label
 * computed by the embedding view (`Enter distance` until a positive finite
 * length is entered, else e.g. `1,300 mm`). The viewer never invents the
 * text — it only renders the supplied string over a white backing.
 */
export interface ReferenceOverlay {
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
  label: string;
}

/** Discrete display-zoom steps (% of the fitted product view). */
export const VIEW_ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300, 400] as const;
export type ViewZoomPercent = (typeof VIEW_ZOOM_STEPS)[number];

/** Pointer-down/up pair for click-vs-drag surface-pick gating. */
export interface SurfaceClickSample {
  downX: number;
  downY: number;
  upX: number;
  upY: number;
}

/**
 * Detailed surface pick: wrapper-local hit position plus the wrapper-local
 * face normal at the hit. Normals come from the actual mesh triangle, never
 * from fitted geometry. Null-safe; never throws at the call site.
 */
export interface SurfacePickDetailed {
  modelPosition: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

/**
 * Pure click-vs-drag gate for armed surface picking: only a primary-button
 * press/release with pointer travel at or below `maxPx` counts as a surface
 * pick (mirrors the calibration panel's 6px rule). Nonfinite input never
 * counts. Pure; no DOM.
 */
export function isSurfaceClick(sample: SurfaceClickSample, maxPx = 6): boolean {
  if (sample === null || typeof sample !== 'object') return false;
  const { downX, downY, upX, upY } = sample;
  if (!Number.isFinite(downX) || !Number.isFinite(downY)) return false;
  if (!Number.isFinite(upX) || !Number.isFinite(upY)) return false;
  if (!Number.isFinite(maxPx) || maxPx < 0) return false;
  return Math.hypot(upX - downX, upY - downY) <= maxPx;
}

/** One logo-placement overlay quad in wrapper-local model coords. */
export interface PlacementOverlayItem {
  id: string;
  regionId: string;
  cornersModel: Array<{ x: number; y: number; z: number }>;
  fits: boolean;
  selected: boolean;
  /**
   * Opaque artwork identity token selecting the procedural preview texture
   * (e.g. `mark-a` / `mark-b` from the placement panel). Optional so older
   * callers still compile; missing/empty/unknown tokens fall back to the
   * default variant. Never affects geometry — corners alone drive position.
   */
  art?: string;
}

/** Real artwork, projected onto the asset's triangles for display only. */
export interface SurfaceArtworkItem {
  id: string;
  cornersModel: Array<{ x: number; y: number; z: number }>;
  anchorModel: { x: number; y: number; z: number };
  depthModel: number;
  image: CanvasImageSource;
  selected: boolean;
  fits: boolean;
}

const FIT_DISTANCE_FACTOR = 1.15;
const NEAR_FACTOR = 1 / 100;
const FAR_FACTOR = 100;

/**
 * Minimal GLB preview: orbit, fit/reset, wireframe toggle.
 *
 * Usage:
 *   const viewer = ModelViewer.attach({ canvas });
 *   await viewer.showModel(glbBytes); // already-validated bytes
 *   viewer.setWireframe(true);
 *   viewer.dispose();
 */
/** Product side presets for multiview showcase framing. */
export type ViewerSide = 'front' | 'back' | 'left' | 'right';

/** Presentation-only lighting multiplier bounds (operator brightness). */
export const MODEL_LIGHTING_MIN = 0.25;
export const MODEL_LIGHTING_MAX = 3;
export const MODEL_LIGHTING_DEFAULT = 1;
/** Exact pre-lighting base intensities (frozen defaults; never restyled). */
export const MODEL_LIGHTING_BASE_KEY = 1.2;
export const MODEL_LIGHTING_BASE_FILL = 0.4;
export const MODEL_LIGHTING_BASE_AMBIENT = 0.3;

/** Normalize a persisted lighting multiplier; invalid values reset to default. */
export function normalizeModelLighting(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MODEL_LIGHTING_MIN && value <= MODEL_LIGHTING_MAX
    ? value
    : MODEL_LIGHTING_DEFAULT;
}

/**
 * Pointer-gesture reservation for the shared camera tools (frozen for A).
 *
 * - `select`: left-drag orbits; logo hit-testing is live. Default.
 * - `pan`: left-drag pans; viewer hit-tests (`pickSurface*`,
 *   `intersectRegionPlane`) return null so a pan gesture can never start or
 *   move a logo. Worker A must switch to `pan` BEFORE logo hit-testing to
 *   reserve the gesture, and back to `select` to edit.
 */
export type ViewerInteractionMode = 'select' | 'pan';

/** Plain camera snapshot for A (pan/orbit/fit/focus tools) and C. */
export interface ViewerCameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  zoomPct: number;
  mode: ViewerInteractionMode;
  fov?: number;
  up?: { x: number; y: number; z: number };
}

/** Clean product render request for C (operator document views). */
export interface CleanCaptureOptions {
  width?: number;
  height?: number;
  /** Committed production revision the caller rendered from; echoed back. */
  revision: string;
}

/** Clean product render: handles/overlays/safe-areas hidden, mm untouched. */
export interface CleanCaptureResult {
  revision: string;
  dataURL: string;
  width: number;
  height: number;
}

export class ModelViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly wrapper: THREE.Group;
  private readonly markerGroup: THREE.Group;
  private readonly markerGeometry: THREE.PlaneGeometry;
  private readonly markerMaterial: THREE.MeshBasicMaterial;
  /**
   * Exact last-mounted anchor set (perf only): identical re-sends skip the
   * marker rebuild. Positions ride wrapper transforms, so no per-refresh
   * work is needed. Never affects mm.
   */
  private anchorSignature = '';
  private readonly axesGroup: THREE.Group;
  private readonly placementGroup: THREE.Group;
  private readonly safeAreaGroup: THREE.Group;
  private safeAreaSignature = '';
  /**
   * Split overlay identity (perf only): geometry (ids + 3D points) vs
   * selection styling. A selection-only change repaints material color and
   * the baked 2D outline in place — no mesh raycasts, no DecalGeometry
   * rebuild, no stored-geometry change. Never affects mm or history.
   */
  private safeAreaGeoSignature = '';
  private safeAreaSelSignature = '';
  private safeAreaBuilt: Array<{
    id: string;
    selected: boolean;
    material: THREE.MeshBasicMaterial;
    texture: THREE.CanvasTexture;
    repaint: (selected: boolean) => void;
  }> = [];
  private readonly referenceGroup: THREE.Group;
  /** Midpoint label sprite for the reference overlay (null when cleared). */
  private referenceLabel: THREE.Sprite | null = null;
  /**
   * Exact last-built reference overlay (endpoints + verbatim label). A
   * refresh that re-sends identical data skips the line/label rebuild
   * (perf only); visibility still follows the anchors layer. Never
   * affects mm.
   */
  private referenceSignature = '';
  /**
   * Fitted camera distance backing the % zoom readout: 100% is the fitted
   * product view. Zoom only moves the camera — native coords and mm values
   * are never scaled.
   */
  private fitDistance = 0;
  private zoomPct = 100;
  /** True while setZoomPercent moves the camera (ignores the echo). */
  private applyingZoom = false;
  private readonly axesXMaterial: THREE.LineBasicMaterial;
  private readonly axesYMaterial: THREE.LineBasicMaterial;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly loader = new GLTFLoader();
  private rafId = 0;
  private disposed = false;
  /** Incremented per showModel/clear call; stale async parses bail out. */
  private generation = 0;
  private wireframe = false;
  /**
   * Product-geometry visibility (render-only): the parsed model subtree is
   * shown/hidden without touching overlays, camera, framing bounds or
   * staged data. Re-applied whenever a model (or proxy) is attached, so a
   * replacement model cannot silently reset a hidden product.
   */
  private productVisible = true;
  private status: ViewerStatus = { kind: 'empty' };
  private onStatus: ((status: ViewerStatus) => void) | null = null;
  /**
   * Gesture reservation (frozen for A): `pan` reserves left-drag/touch for
   * camera panning and nulls viewer hit-tests. Never affects mm or history.
   */
  private interactionMode: ViewerInteractionMode = 'select';
  /** Monotonic capture token: a newer capture (or model swap) voids older ones. */
  private captureToken = 0;
  private surfaceArtworkItems: SurfaceArtworkItem[] = [];
  /**
   * Monotonic camera/viewport revision for overlay gating (overlay-only).
   * Bumped in the render loop only when the camera position/target or the
   * canvas size actually changes, so idle frames share one revision and
   * views can skip projection/raycast work. Never affects mm or history.
   */
  private viewRevision = 0;
  private lastViewKey = '';
  private readonly keyLight: THREE.DirectionalLight;
  private readonly fillLight: THREE.DirectionalLight;
  private readonly ambientLight: THREE.AmbientLight;
  /** Presentation-only brightness multiplier (default 1; never affects mm). */
  private lighting = MODEL_LIGHTING_DEFAULT;

  private constructor(
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    background: number,
  ) {
    this.container = container;
    // preserveDrawingBuffer lets tests and acceptance scripts read back
    // rendered pixels for visual proof (no second GL context needed). The
    // buffer is still presented every frame; cost is one retained frame.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(1.5, 1.2, 1.8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // Keep the % readout consistent when the operator dollies with the
    // wheel: report the actual percentage relative to whole-product Fit without
    // moving the camera. Programmatic zoom applies set their own echo guard.
    this.controls.addEventListener('change', () => {
      try {
        if (this.applyingZoom || this.disposed || this.fitDistance <= 0) return;
        const dist = this.camera.position.distanceTo(this.controls.target);
        if (!Number.isFinite(dist) || dist <= 0) return;
        const implied = (this.fitDistance / dist) * 100;
        if (!Number.isFinite(implied)) return;
        this.zoomPct = Math.max(1, Math.round(implied));
      } catch {
        return;
      }
    });
    this.wrapper = new THREE.Group();
    this.wrapper.name = 'model-viewer-wrapper';
    this.scene.add(this.wrapper);
    this.markerGroup = new THREE.Group();
    this.markerGroup.name = 'anchor-markers';
    this.wrapper.add(this.markerGroup);
    this.axesGroup = new THREE.Group();
    this.axesGroup.name = 'region-axes';
    this.wrapper.add(this.axesGroup);
    this.placementGroup = new THREE.Group();
    this.placementGroup.name = 'placement-overlays';
    this.wrapper.add(this.placementGroup);
    this.safeAreaGroup = new THREE.Group();
    this.safeAreaGroup.name = 'safe-area-overlays';
    this.wrapper.add(this.safeAreaGroup);
    this.referenceGroup = new THREE.Group();
    this.referenceGroup.name = 'reference-overlay';
    this.wrapper.add(this.referenceGroup);
    this.axesXMaterial = new THREE.LineBasicMaterial({ color: 0xff0000 });
    this.axesYMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00 });
    this.markerGeometry = new THREE.PlaneGeometry(1, 1);
    this.markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false });

    // Simple key/fill lighting; materials come from the GLB itself.
    const key = new THREE.DirectionalLight(0xffffff, MODEL_LIGHTING_BASE_KEY);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    this.keyLight = key;
    const fill = new THREE.DirectionalLight(0xffffff, MODEL_LIGHTING_BASE_FILL);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);
    this.fillLight = fill;
    const ambient = new THREE.AmbientLight(0xffffff, MODEL_LIGHTING_BASE_AMBIENT);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    } else {
      this.resizeObserver = null;
      window.addEventListener('resize', this.resizeBound);
    }
    this.loop();
  }

  private readonly resizeBound = (): void => this.resize();
  /**
   * Optional per-frame hook for projected HTML overlays (e.g. draggable
   * rectangle handles). Overlay-only: never throws into the loop, cleared on
   * dispose. The view owns positioning/visibility; the viewer only yields a
   * post-camera-update tick so overlays track orbit/zoom/resize.
   */
  onFrame: (() => void) | null = null;

  /**
   * Attach to a canvas. Returns the viewer, or a webgl-unavailable status
   * when the browser cannot create a GL context (no throw).
   */
  static attach(
    options: ModelViewerOptions,
    onStatus?: (status: ViewerStatus) => void,
  ): { viewer: ModelViewer | null; status: ViewerStatus } {
    const container = options.container ?? options.canvas.parentElement ?? document.body;
    try {
      const viewer = new ModelViewer(
        options.canvas,
        container,
        options.background ?? 0x1e1e1e,
      );
      if (onStatus) viewer.onStatus = onStatus;
      viewer.setStatus({ kind: 'empty' });
      return { viewer, status: viewer.status };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status: ViewerStatus = {
        kind: 'webgl-unavailable',
        message: `Could not create WebGL renderer: ${detail}`,
      };
      onStatus?.(status);
      return { viewer: null, status };
    }
  }

  /**
   * Parse already-validated GLB bytes from memory and display them.
   * Replaces any previous model (GPU resources disposed). Stale parses —
   * an earlier call resolving after a newer one — are discarded via the
   * generation token and dispose their parsed scene without attaching it.
   */
  async showModel(bytes: Uint8Array): Promise<ViewerStatus> {
    if (this.disposed) return this.status;
    const generation = ++this.generation;
    // Exact-length owned copy: GLTFLoader retains the buffer for textures,
    // and a fresh allocation is known to be backed by an ArrayBuffer.
    const owned = new ArrayBuffer(bytes.length);
    new Uint8Array(owned).set(bytes);
    this.setStatus({ kind: 'loading' });
    let parsed: GLTF;
    try {
      parsed = await this.loader.parseAsync(owned, '');
    } catch (error) {
      if (generation !== this.generation || this.disposed) {
        return this.status;
      }
      return this.setStatus({
        kind: 'parse-failed',
        message: `Could not parse GLB bytes: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (generation !== this.generation || this.disposed) {
      disposeObject(parsed.scene);
      return this.status;
    }
    this.clearModel();
    this.wrapper.add(parsed.scene);
    for (const child of this.wrapper.children) {
      if (child !== this.markerGroup && child !== this.axesGroup && child !== this.placementGroup && child !== this.safeAreaGroup && child !== this.referenceGroup) this.applyWireframe(child, this.wireframe);
    }
    this.applyProductVisibility();
    // A parsed-but-empty (or single-point-degenerate) scene paints a blank
    // canvas: surface it as a failure so the embedding UI never shows blank
    // success. Flat planes and lines keep a nonzero diagonal and still pass.
    const extents = this.modelBBox().getSize(new THREE.Vector3());
    if (extents.length() <= 0) {
      this.clearModel();
      return this.setStatus({
        kind: 'parse-failed',
        message: 'Could not parse GLB bytes: scene contains no renderable geometry',
      });
    }
    this.fitView();
    return this.setStatus({ kind: 'ready' });
  }

  /** Remove the current model and free its GPU resources. */
  clear(): void {
    ++this.generation;
    this.clearModel();
    this.setStatus({ kind: 'empty' });
  }

  /** Frame the current model in the camera (wrapper transform only). */
  fitView(): void {
    const box = this.modelBBox();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = size.length() / 2;
    if (!Number.isFinite(radius) || radius <= 0) return;
    // Recenter the wrapper so the model sits at the origin of the view;
    // the parsed subtree itself is untouched.
    this.wrapper.position.sub(center);
    const halfVertical = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * this.camera.aspect);
    const distance = radius / Math.sin(Math.min(halfVertical, halfHorizontal)) * FIT_DISTANCE_FACTOR;
    const direction = new THREE.Vector3(1, 0.75, 1.2).normalize();
    this.camera.position.copy(direction.multiplyScalar(distance));
    this.camera.near = Math.max(distance * NEAR_FACTOR, 0.001);
    this.camera.far = distance * FAR_FACTOR;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    // 100% is this fitted view; the distance backs the % zoom readout.
    this.fitDistance = distance;
    this.zoomPct = 100;
  }

  /** Tight, orientation-preserving presentation fit. Camera only; no mesh/mm changes. */
  fitCurrentView(margin = 0.08): void {
    if (this.disposed) return;
    const box = this.modelBBox(); if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (direction.lengthSq() === 0) direction.set(0, 0, 1);
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const extent = 1 - Math.min(0.3, Math.max(0.02, margin));
    let low = 0, high = Math.max(box.getSize(new THREE.Vector3()).length() * 10, 1);
    for (let i = 0; i < 32; i++) {
      const distance = (low + high) / 2;
      this.camera.position.copy(center).addScaledVector(direction, distance);
      this.camera.lookAt(center); this.camera.updateMatrixWorld(true);
      const fits = corners.every((corner) => {
        const depth = corner.clone().sub(this.camera.position).dot(direction.clone().negate());
        const projected = corner.clone().project(this.camera);
        return depth > 0 && Math.abs(projected.x) <= extent && Math.abs(projected.y) <= extent;
      });
      if (fits) high = distance; else low = distance;
    }
    this.camera.position.copy(center).addScaledVector(direction, high);
    this.controls.target.copy(center); this.fitDistance = high; this.zoomPct = 100;
    this.camera.near = Math.max(high * NEAR_FACTOR, 0.001); this.camera.far = high * FAR_FACTOR;
    this.camera.updateProjectionMatrix(); this.controls.update();
  }

  /** Restore the default camera framing for the current model. */
  resetView(): void {
    this.fitView();
  }

  /**
   * Focus the camera on one selected surface polygon (camera only).
   *
   * Camera-only helper for "Focus this area": frames the supplied
   * wrapper-local surface points by moving the camera/target along a view
   * direction, leaving the wrapper transform, stored mm, fitDistance and the
   * zoom baseline untouched (Fit/reset still frame the whole product at
   * 100%). Input is never mutated. Returns false (no-op) when the model is
   * unloaded, the points are missing/degenerate/nonfinite, the resolved
   * distance is unusable, orbit is suspended for an active gesture, or the
   * viewer is disposed. Never throws.
   *
   * Direction: when a wrapper-local outward region normal is supplied, the
   * camera moves to the outward side (resolved against the nearest mesh
   * face, so a back-side patch actually faces the viewer); otherwise the
   * current camera direction is kept.
   */
  focusSurfacePoints(
    pointsModel: Array<{ x: number; y: number; z: number }>,
    normalModel?: { x: number; y: number; z: number },
  ): boolean {
    try {
      if (this.disposed) return false;
      // An active draw/edit gesture suspends orbit (controls disabled): a
      // focus then would fight the gesture, so refuse safely.
      try {
        if (this.controls.enabled === false) return false;
      } catch {
        return false;
      }
      if (!Array.isArray(pointsModel) || pointsModel.length < 3) return false;
      if (pointsModel.length > 512) return false;
      const local: THREE.Vector3[] = [];
      for (const point of pointsModel) {
        if (!isVec3(point)) return false;
        local.push(new THREE.Vector3(point.x, point.y, point.z));
      }
      let longest = 0;
      for (let i = 0; i < local.length; i += 1) {
        for (let j = i + 1; j < local.length; j += 1) {
          const distance = local[i]!.distanceTo(local[j]!);
          if (Number.isFinite(distance) && distance > longest) longest = distance;
        }
      }
      if (!Number.isFinite(longest) || !(longest > 1e-9)) return false;
      const areaNormal = new THREE.Vector3();
      const origin = local[0]!;
      for (let i = 1; i + 1 < local.length; i += 1) {
        areaNormal.add(new THREE.Vector3().crossVectors(
          local[i]!.clone().sub(origin), local[i + 1]!.clone().sub(origin),
        ));
      }
      if (areaNormal.length() <= longest * longest * 1e-8) return false;
      const box = this.modelBBox();
      if (box.isEmpty()) return false;
      this.scene.updateMatrixWorld(true);
      this.camera.updateMatrixWorld();
      const modelDiag = box.getSize(new THREE.Vector3()).length();
      if (!Number.isFinite(modelDiag) || !(modelDiag > 0)) return false;
      // View direction: outward normal when supplied, else current direction.
      let direction: THREE.Vector3;
      if (normalModel !== undefined && normalModel !== null) {
        if (!isVec3(normalModel)) return false;
        const candidate = new THREE.Vector3(normalModel.x, normalModel.y, normalModel.z);
        if (!Number.isFinite(candidate.length()) || candidate.lengthSq() < 1e-12) return false;
        candidate.normalize();
        let worldNormal: THREE.Vector3;
        try {
          worldNormal = candidate.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(this.wrapper.matrixWorld)).normalize();
        } catch {
          return false;
        }
        if (!Number.isFinite(worldNormal.length()) || worldNormal.lengthSq() < 1e-12) return false;
        // Resolve winding against the closest real mesh face: the stored
        // frame normal may point into the product. Probe both sides from the
        // polygon centre along the supplied axis and adopt the nearest face
        // normal so back areas land on the outward side.
        try {
          const reach = Math.max(1e-6, modelDiag * 2);
          const worldPoints = local.map((point) => this.wrapper.localToWorld(point.clone()));
          const probeCenter = new THREE.Box3().setFromPoints(worldPoints).getCenter(new THREE.Vector3());
          const probe = new THREE.Raycaster();
          let closest = Infinity;
          let outward: THREE.Vector3 | null = null;
          for (const sign of [1, -1]) {
            probe.set(
              probeCenter.clone().addScaledVector(worldNormal, reach * sign),
              worldNormal.clone().multiplyScalar(-sign),
            );
            for (const hit of probe.intersectObjects(this.modelTargets(), true)) {
              if (!(hit.object instanceof THREE.Mesh) || !hit.face) continue;
              const gap = hit.point.distanceToSquared(probeCenter);
              if (gap < closest) {
                closest = gap;
                outward = hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
              }
            }
          }
          if (outward !== null && outward.lengthSq() > 1e-12) {
            outward.normalize();
            worldNormal = outward;
          }
        } catch {
          /* keep the supplied world normal */
        }
        direction = worldNormal;
      } else {
        direction = this.camera.position.clone().sub(this.controls.target);
        if (!Number.isFinite(direction.length()) || direction.lengthSq() < 1e-12) {
          direction = new THREE.Vector3(0, 0, 1);
        } else {
          direction.normalize();
        }
      }
      const worldPoints = local.map((point) => this.wrapper.localToWorld(point.clone()));
      const focusBox = new THREE.Box3().setFromPoints(worldPoints);
      if (focusBox.isEmpty()) return false;
      const center = focusBox.getCenter(new THREE.Vector3());
      const size = focusBox.getSize(new THREE.Vector3());
      if (![center.x, center.y, center.z, size.x, size.y, size.z].every(Number.isFinite)) return false;
      // A surface patch belongs near the loaded product. Refuse corrupt
      // remote coordinates before moving the camera or changing its target.
      if (box.distanceToPoint(center) > modelDiag) return false;
      const radius = size.length() / 2;
      if (!Number.isFinite(radius) || !(radius > 1e-9)) return false;
      const halfVertical = THREE.MathUtils.degToRad(this.camera.fov / 2);
      if (!Number.isFinite(halfVertical) || !(halfVertical > 0)) return false;
      const halfHorizontal = Math.atan(Math.tan(halfVertical) * this.camera.aspect);
      if (!Number.isFinite(halfHorizontal) || !(halfHorizontal > 0)) return false;
      // Padding so the whole polygon plus its outline sits inside the view.
      const padded = radius * 1.35;
      const distance = padded / Math.sin(Math.min(halfVertical, halfHorizontal));
      if (!Number.isFinite(distance) || !(distance > 0)) return false;
      // Bound the dolly so degenerate/oversized input cannot strand the
      // camera or collapse the depth range. Wrapper/mm untouched.
      const clamped = Math.min(Math.max(distance, modelDiag * 0.05), modelDiag * 20);
      if (!Number.isFinite(clamped) || !(clamped > 0)) return false;
      const savedFit = this.fitDistance;

      this.applyingZoom = true;
      try {
        this.camera.position.copy(center).addScaledVector(direction.clone().normalize(), clamped);
        this.controls.target.copy(center);
        this.camera.near = Math.max(clamped * NEAR_FACTOR, 0.001);
        this.camera.far = clamped * FAR_FACTOR;
        this.camera.updateProjectionMatrix();
        this.controls.update();
      } finally {
        this.applyingZoom = false;
        this.fitDistance = savedFit;
        this.zoomPct = Math.max(1, Math.round((savedFit / clamped) * 100));
      }
      return true;
    } catch {
      try {
        this.applyingZoom = false;
      } catch {
        /* guard restore is best-effort */
      }
      return false;
    }
  }

  /**
   * Replace the reference measurement overlay: a dashed straight chord
   * between two wrapper-local surface points plus a midpoint label with a
   * white backing. The label text arrives from the embedding view (never
   * invented here). Null/invalid clears the overlay. The group rides wrapper
   * transforms, so the line and label follow orbit, pan, zoom and resizes;
   * the label keeps a constant CSS size via the render loop. Render-only:
   * never mutates the model, never participates in raycasts or framing.
   * Never throws.
   */
  setReferenceOverlay(ref: ReferenceOverlay | null): void {
    try {
      if (this.disposed) return;
      if (ref === null || typeof ref !== 'object' || !isVec3(ref.a) || !isVec3(ref.b) || typeof ref.label !== 'string') {
        this.referenceSignature = '';
        this.clearReference();
        return;
      }
      const signature = JSON.stringify({ a: ref.a, b: ref.b, label: ref.label });
      if (signature === this.referenceSignature && this.referenceLabel !== null) {
        // Identical endpoints + label: keep the mounted line/label, only
        // re-sync layer visibility (display-only, no rebuild).
        this.referenceGroup.visible = this.markerGroup.visible;
        return;
      }
      this.clearReference();
      if (this.disposed) return;
      const a = new THREE.Vector3(ref.a.x, ref.a.y, ref.a.z);
      const b = new THREE.Vector3(ref.b.x, ref.b.y, ref.b.z);
      const chord = a.distanceTo(b);
      if (!Number.isFinite(chord)) return;
      const modelSize = this.modelBBox().getSize(new THREE.Vector3()).length();
      const base = Number.isFinite(modelSize) && modelSize > 0 ? modelSize : Math.max(chord, 1e-6);
      const dash = chord > 0 ? Math.max(chord * 0.05, base * 0.004) : base * 0.01;
      const lineGeometry = new THREE.BufferGeometry().setFromPoints([a, b]);
      const lineMaterial = new THREE.LineDashedMaterial({
        color: 0xffc400,
        dashSize: dash,
        gapSize: dash * 0.6,
        depthTest: false,
        transparent: true,
      });
      const line = new THREE.Line(lineGeometry, lineMaterial);
      line.computeLineDistances();
      line.renderOrder = 10;
      this.referenceGroup.add(line);
      const { sprite } = makeReferenceLabelSprite(ref.label);
      sprite.position.copy(a).add(b).multiplyScalar(0.5);
      this.referenceGroup.add(sprite);
      this.referenceLabel = sprite;
      this.referenceSignature = signature;
      this.updateReferenceLabelScale();
      // The connecting measurement belongs to the anchors layer.
      this.referenceGroup.visible = this.markerGroup.visible;
    } catch {
      return;
    }
  }

  /** Remove the reference line/label and dispose their GPU resources. */
  private clearReference(): void {
    this.referenceLabel = null;
    this.referenceSignature = '';
    for (let i = this.referenceGroup.children.length - 1; i >= 0; i--) {
      const child = this.referenceGroup.children[i];
      if (child === undefined) continue;
      this.referenceGroup.remove(child);
      if (child instanceof THREE.Sprite) {
        const material = child.material;
        if (material.map !== null) material.map.dispose();
        material.dispose();
        continue;
      }
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        const material = child.material;
        (Array.isArray(material) ? material : [material]).forEach((entry) => entry.dispose());
      }
    }
  }

  /** Keep the reference label at a constant CSS size (~18px tall). */
  private updateReferenceLabelScale(): void {
    const sprite = this.referenceLabel;
    if (sprite === null) return;
    try {
      const heightPx = this.renderer.domElement.clientHeight || 1;
      sprite.getWorldPosition(scratchVector);
      const dist = this.camera.position.distanceTo(scratchVector);
      if (!Number.isFinite(dist) || dist <= 0) return;
      const worldH =
        ((2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / heightPx) * 18;
      if (!Number.isFinite(worldH) || worldH <= 0) return;
      const aspect =
        typeof sprite.userData['labelAspect'] === 'number'
          ? (sprite.userData['labelAspect'] as number)
          : 2;
      sprite.scale.set(worldH * aspect, worldH, 1);
    } catch {
      return;
    }
  }

  /**
   * Set the display zoom to one of 50|75|100|125|150|200|300|400 (% of the
   * fitted view). Camera only — native coords and mm values are untouched.
   * Invalid, nonfinite or unsupported values are ignored. Never throws.
   */
  setZoomPercent(pct: number): void {
    try {
      if (this.disposed) return;
      if (typeof pct !== 'number' || !(VIEW_ZOOM_STEPS as readonly number[]).includes(pct)) return;
      this.zoomPct = pct;
      this.applyZoomDistance();
    } catch {
      return;
    }
  }

  /** Current camera zoom percentage relative to whole-product Fit. */
  getZoomPercent(): number {
    try {
      return this.zoomPct;
    } catch {
      return 100;
    }
  }

  /**
   * Monotonic camera/viewport revision (overlay gating only). The render
   * loop bumps it only when the camera position/target or canvas size
   * actually changes, so idle frames share one revision and views can skip
   * projection/raycast work without timers. Camera only; never throws.
   */
  getViewRevision(): number {
    try {
      return this.disposed ? 0 : this.viewRevision;
    } catch {
      return 0;
    }
  }

  /** Refit the product view and read 100%. Camera only. Never throws. */
  resetZoom(): void {
    try {
      if (this.disposed) return;
      this.fitView();
      this.zoomPct = 100;
    } catch {
      return;
    }
  }

  /** Move the camera to the stored zoom step along the current direction. */
  private applyZoomDistance(): void {
    if (this.fitDistance <= 0) return;
    const want = (this.fitDistance * 100) / this.zoomPct;
    if (!Number.isFinite(want) || want <= 0) return;
    scratchVector.copy(this.camera.position).sub(this.controls.target);
    if (!Number.isFinite(scratchVector.length()) || scratchVector.length() <= 0) return;
    scratchVector.normalize();
    this.applyingZoom = true;
    try {
      this.camera.position.copy(this.controls.target.clone().addScaledVector(scratchVector, want));
      this.camera.near = Math.max(want * NEAR_FACTOR, 0.001);
      this.camera.far = want * FAR_FACTOR;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    } finally {
      this.applyingZoom = false;
    }
  }

  /**
   * Move the camera to an axis-aligned side preset (front +z, back -z,
   * left -x, right +x) at the current target distance, looking at the
   * origin. Wrapper/camera only — the parsed subtree is never mutated.
   * Invalid input is ignored. Never throws.
   */
  setViewSide(side: ViewerSide): void {
    try {
      if (this.disposed) return;
      if (side !== 'front' && side !== 'back' && side !== 'left' && side !== 'right') return;
      const distance = this.camera.position.distanceTo(this.controls.target);
      if (!Number.isFinite(distance) || distance <= 0) return;
      const direction = side === 'front'
        ? new THREE.Vector3(0, 0, 1)
        : side === 'back'
          ? new THREE.Vector3(0, 0, -1)
          : side === 'left'
            ? new THREE.Vector3(-1, 0, 0)
            : new THREE.Vector3(1, 0, 0);
      this.camera.position.copy(direction.multiplyScalar(distance));
      this.camera.near = Math.max(distance * NEAR_FACTOR, 0.001);
      this.camera.far = distance * FAR_FACTOR;
      this.camera.updateProjectionMatrix();
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    } catch {
      return;
    }
  }

  /**
   * Enable or disable orbit interaction without touching scene content.
   * Used to lock the 2D model projection while keeping 3D orbitable.
   * Never throws.
   */
  setOrbitEnabled(enabled: boolean): void {
    try {
      if (!this.disposed) this.controls.enabled = enabled === true;
    } catch {
      return;
    }
  }

  /**
   * Reserve the primary gesture (frozen for A).
   *
   * `pan` maps left-drag/one-finger touch to OrbitControls pan AND makes
   * `pickSurface`, `pickSurfaceDetailed`, `pickSurfaceFromEvent` and
   * `intersectRegionPlane` return null, so a reserved pan can never start,
   * move or resize a logo. `select` restores left-drag orbit and live
   * hit-testing. Camera/viewport only — mm, frames and history untouched.
   * Invalid input is ignored. Never throws.
   */
  setInteractionMode(mode: ViewerInteractionMode): void {
    try {
      if (this.disposed) return;
      if (mode !== 'select' && mode !== 'pan') return;
      this.interactionMode = mode;
      if (mode === 'pan') {
        this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
        this.controls.touches.ONE = THREE.TOUCH.PAN;
      } else {
        this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        this.controls.touches.ONE = THREE.TOUCH.ROTATE;
      }
      this.controls.update();
    } catch {
      return;
    }
  }

  /** Current gesture reservation (`select` after attach; never throws). */
  getInteractionMode(): ViewerInteractionMode {
    try {
      return this.interactionMode;
    } catch {
      return 'select';
    }
  }

  /**
   * Enable/disable OrbitControls panning without touching scene content.
   * Independent of the gesture reservation above. Never throws.
   */
  setPanEnabled(enabled: boolean): void {
    try {
      if (!this.disposed) this.controls.enablePan = enabled === true;
    } catch {
      return;
    }
  }

  /** Current OrbitControls pan flag (true after attach; never throws). */
  getPanEnabled(): boolean {
    try {
      return this.controls.enablePan === true;
    } catch {
      return false;
    }
  }

  /**
   * Snapshot the camera for A/C (position, pan target, zoom step, mode).
   * Camera/viewport only — production mm, frames and history are untouched.
   * Null when disposed. Never throws.
   */
  getCameraState(): ViewerCameraState | null {
    try {
      if (this.disposed) return null;
      const position = this.camera.position;
      const target = this.controls.target;
      if (![position.x, position.y, position.z, target.x, target.y, target.z].every(Number.isFinite)) return null;
      return {
        position: { x: position.x, y: position.y, z: position.z },
        target: { x: target.x, y: target.y, z: target.z },
        zoomPct: this.zoomPct,
        mode: this.interactionMode,
        fov: this.camera.fov,
        up: { x: this.camera.up.x, y: this.camera.up.y, z: this.camera.up.z },
      };
    } catch {
      return null;
    }
  }

  /**
   * Restore a camera snapshot (frozen for A/C document views and tools).
   * Applies position + pan target exactly, then re-applies the stored zoom
   * step only when it is a supported step; otherwise the % readout follows
   * the restored distance via the existing change listener. Applies the
   * stored gesture mode last. Camera/viewport only — mm never mutated.
   * Returns false (no-op) on disposed viewer or invalid state. Never throws.
   */
  setCameraState(state: ViewerCameraState): boolean {
    try {
      if (this.disposed) return false;
      if (state === null || typeof state !== 'object') return false;
      const { position, target, zoomPct, mode } = state;
      if (!isVec3(position) || !isVec3(target)) return false;
      if (mode !== 'select' && mode !== 'pan') return false;
      const distance = Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z);
      if (!Number.isFinite(distance) || distance <= 0) return false;
      if (state.fov !== undefined && (!Number.isFinite(state.fov) || state.fov <= 0 || state.fov >= 180)) return false;
      if (state.up !== undefined && (!isVec3(state.up) || Math.hypot(state.up.x, state.up.y, state.up.z) <= 0)) return false;
      this.camera.position.set(position.x, position.y, position.z);
      this.controls.target.set(target.x, target.y, target.z);
      if (state.fov !== undefined) this.camera.fov = state.fov;
      if (state.up !== undefined) this.camera.up.set(state.up.x, state.up.y, state.up.z);
      this.camera.near = Math.max(distance * NEAR_FACTOR, 0.001);
      this.camera.far = distance * FAR_FACTOR;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      if (typeof zoomPct === 'number' && (VIEW_ZOOM_STEPS as readonly number[]).includes(zoomPct)) {
        // Position already contains the exact dolly distance. Reapplying a
        // rounded zoom step here would alter the persisted camera pose.
        this.zoomPct = zoomPct;
      }
      this.setInteractionMode(mode);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Render a clean product view for C (operator document views).
   *
   * Hides anchor markers, region axes, selection outlines and
   * safe areas and the reference line, renders once at the requested pixel
   * size off the live viewport, then restores every layer flag, the renderer
   * size and the camera aspect. The camera never moves and mm is untouched.
   *
   * Stale rejection: each call takes a capture token; when a newer capture
   * starts, the model swaps, or the viewer disposes before the render
   * completes, the older call resolves null. Callers must also discard
   * results whose `revision` no longer matches the committed revision.
   * Null on bad input (including empty revision), stale capture or any
   * failure. Never throws.
   */
  async captureCleanView(options: CleanCaptureOptions): Promise<CleanCaptureResult | null> {
    if (this.disposed) return null;
    if (options === null || typeof options !== 'object') return null;
    const revision: unknown = options.revision;
    if (typeof revision !== 'string' || revision.length === 0) return null;
    const clamp = (value: unknown, fallback: number): number => {
      const floored = typeof value === 'number' ? Math.floor(value) : fallback;
      if (!Number.isFinite(floored)) return fallback;
      return Math.min(2048, Math.max(64, floored));
    };
    const width = clamp(options.width, this.container.clientWidth || 800);
    const height = clamp(options.height, this.container.clientHeight || 600);
    const token = ++this.captureToken;
    const generation = this.generation;
    // Await before mutating live renderer/layer state. Overlapping calls
    // supersede earlier requests without interleaved hide/restore sections.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (token !== this.captureToken || generation !== this.generation || this.disposed) return null;
    const artwork = this.surfaceArtworkItems;
    if (artwork.length > 0) this.setSurfaceArtworkOverlays(artwork.map((item) => ({ ...item, selected: false, fits: true })));
    const layers = [this.markerGroup, this.axesGroup, this.safeAreaGroup, this.referenceGroup];
    const wasVisible = layers.map((layer) => layer.visible);
    for (const layer of layers) layer.visible = false;
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevPixelRatio = this.renderer.getPixelRatio();
    const prevAspect = this.camera.aspect;
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.scene.updateMatrixWorld(true);
      this.renderer.render(this.scene, this.camera);
      const dataURL = this.renderer.domElement.toDataURL('image/png');
      if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/png')) return null;
      return { revision, dataURL, width, height };
    } catch {
      return null;
    } finally {
      if (artwork.length > 0 && !this.disposed) this.setSurfaceArtworkOverlays(artwork);
      for (let i = 0; i < layers.length; i += 1) {
        const layer = layers[i];
        if (layer !== undefined && wasVisible[i] !== undefined) layer.visible = wasVisible[i]!;
      }
      try {
        this.renderer.setPixelRatio(prevPixelRatio);
        this.renderer.setSize(Math.max(1, Math.floor(prevSize.x)), Math.max(1, Math.floor(prevSize.y)), false);
        this.camera.aspect = prevAspect;
        this.camera.updateProjectionMatrix();
        this.controls.update();
      } catch {
        /* restore-only; the outer result already decided */
      }
    }
  }

  /**
   * Display a validated raster image as an orbitable textured-plane proxy.
   * The plane is sized to the image aspect and centered at the origin.
   * Previous content (model or proxy) is disposed via clearModel, exactly
   * like showModel; the embedding UI must label this
   * `Proxy - not reconstructed geometry`. Generation-guarded; failure
   * yields a parse-failed status, never a throw.
   */
  async showImageProxy(bytes: Uint8Array, label: string): Promise<ViewerStatus> {
    if (this.disposed) return this.status;
    const generation = ++this.generation;
    // Exact-length owned copy: the blob below must not retain the caller's
    // buffer, mirroring the showModel copy pattern.
    const owned = new Uint8Array(bytes.length);
    owned.set(bytes);
    // The human label stays with the embedding UI caption; kept as a
    // parameter for API symmetry with captioned views.
    void label;
    this.setStatus({ kind: 'loading' });
    let bitmap: ImageBitmap | null = null;
    try {
      if (owned.length === 0) throw new Error('empty image bytes');
      const blob = new Blob([owned as BlobPart]);
      const objectUrl = URL.createObjectURL(blob);
      try {
        const response = await fetch(objectUrl);
        if (!response.ok) throw new Error(`proxy fetch failed with status ${response.status}`);
        bitmap = await createImageBitmap(await response.blob());
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      if (generation !== this.generation || this.disposed) {
        if (bitmap !== null) bitmap.close();
        return this.status;
      }
      const width = bitmap.width;
      const height = bitmap.height;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('decoded image has no usable dimensions');
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('2d canvas context unavailable');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      bitmap = null;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      const aspect = width / height;
      const planeWidth = aspect >= 1 ? 2 : 2 * aspect;
      const planeHeight = aspect >= 1 ? 2 / aspect : 2;
      const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
      const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
      this.clearModel();
      if (generation !== this.generation || this.disposed) {
        geometry.dispose();
        texture.dispose();
        material.dispose();
        return this.status;
      }
      this.wrapper.add(new THREE.Mesh(geometry, material));
      this.applyProductVisibility();
      this.fitView();
      this.controls.enabled = true;
      return this.setStatus({ kind: 'ready' });
    } catch (error) {
      if (bitmap !== null) {
        try { bitmap.close(); } catch { /* already closed */ }
      }
      if (generation !== this.generation || this.disposed) return this.status;
      return this.setStatus({
        kind: 'parse-failed',
        message: `Could not show image proxy: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Model-subtree render targets for picking and occlusion: every wrapper
   * child except the editor overlay groups (markers, axes, placements,
   * safe areas, reference). Overlays never occlude, never hit-test.
   */
  private modelTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    for (const child of this.wrapper.children) {
      if (child !== this.markerGroup && child !== this.axesGroup && child !== this.placementGroup && child !== this.safeAreaGroup && child !== this.referenceGroup) targets.push(child);
    }
    return targets;
  }

  /**
   * Occlusion tolerance in model units: a surface point counts as visible
   * when the nearest garment hit along the camera ray is within this of the
   * point itself. Scales with the fitted model (0.2% of its diagonal) so
   * thin synthetic shells (gap >> tolerance) cull correctly while exact
   * on-surface corners survive float noise. Never throws.
   */
  private occlusionEpsilon(): number {
    try {
      const size = this.modelBBox().getSize(new THREE.Vector3()).length();
      if (!Number.isFinite(size) || size <= 0) return 1e-6;
      return Math.max(size * 0.002, 1e-9);
    } catch {
      return 1e-6;
    }
  }

  /**
   * True when garment geometry hides a world-space surface point from the
   * camera: a nearer mesh hit exists beyond the occlusion tolerance. False
   * when the point's own triangle is hit first (or nothing is loaded, in
   * which case projection keeps its legacy unoccluded behavior). Never throws.
   */
  private surfacePointOccluded(worldPoint: THREE.Vector3): boolean {
    try {
      const targets = this.modelTargets();
      if (targets.length === 0) return false;
      this.scene.updateMatrixWorld(true);
      this.camera.updateMatrixWorld();
      const offset = worldPoint.clone().sub(this.camera.position);
      const distance = offset.length();
      if (!Number.isFinite(distance) || distance <= 0) return false;
      offset.normalize();
      const raycaster = new THREE.Raycaster(this.camera.position.clone(), offset, 0, distance);
      const hits = raycaster.intersectObjects(targets, true);
      const hit = hits.find((candidate) => candidate.object instanceof THREE.Mesh);
      if (!hit) return false;
      return hit.distance < distance - this.occlusionEpsilon();
    } catch {
      return false;
    }
  }

  /**
   * Whether a wrapper-local surface point with its wrapper-local outward
   * normal currently faces the operator (frozen for A hit-test gating).
   *
   * False when the normal points away from the camera (dot <= 0) OR when
   * nearer garment geometry occludes the point (rear handles/labels on a
   * thin shell read false from the far side). True only for a front-facing,
   * unoccluded point. Null on disposed viewer or bad input. Null-safe.
   *
   * The caller maps regionId + mm to model coords (e.g. via
   * modelPointFromMm) and supplies the region/face normal: this viewer never
   * touches mm, regions or calibration frames.
   */
  isSurfaceFacing(
    point: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number },
  ): boolean | null {
    try {
      if (this.disposed) return null;
      if (!isVec3(point) || !isVec3(normal)) return null;
      this.scene.updateMatrixWorld(true);
      this.camera.updateMatrixWorld();
      const worldPoint = this.wrapper.localToWorld(new THREE.Vector3(point.x, point.y, point.z));
      const worldNormal = new THREE.Vector3(normal.x, normal.y, normal.z)
        .transformDirection(this.wrapper.matrixWorld);
      if (worldNormal.lengthSq() <= 0) return null;
      worldNormal.normalize();
      // The calibrated frame normal may wind into the product. Resolve its
      // sign from the closest actual mesh face, independently of the camera.
      const reach = Math.max(1e-6, this.modelBBox().getSize(new THREE.Vector3()).length() * 2);
      const probe = new THREE.Raycaster();
      let closest = Infinity;
      let surfaceNormal: THREE.Vector3 | null = null;
      let surfacePoint: THREE.Vector3 | null = null;
      for (const sign of [1, -1]) {
        probe.set(worldPoint.clone().addScaledVector(worldNormal, reach * sign), worldNormal.clone().multiplyScalar(-sign));
        for (const hit of probe.intersectObjects(this.modelTargets(), true)) {
          if (!(hit.object instanceof THREE.Mesh) || !hit.face) continue;
          const gap = hit.point.distanceToSquared(worldPoint);
          if (gap < closest) {
            closest = gap;
            surfacePoint = hit.point.clone();
            surfaceNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
          }
        }
      }
      if (surfaceNormal) worldNormal.copy(surfaceNormal);
      if (surfacePoint) worldPoint.copy(surfacePoint);
      const toCamera = this.camera.position.clone().sub(worldPoint);
      const distance = toCamera.length();
      if (!Number.isFinite(distance) || distance <= 0) return null;
      toCamera.normalize();
      if (worldNormal.dot(toCamera) <= 0) return false;
      return !this.surfacePointOccluded(worldPoint);
    } catch {
      return null;
    }
  }

  /**
   * Shared raycast gate: canvas client coords to the first Mesh hit,
   * excluding marker/overlay groups. Null on any miss or bad input.
   */
  private raycastMesh(clientX: number, clientY: number): THREE.Intersection | null {
    if (this.disposed) return null;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
    if (rect.width <= 0 || rect.height <= 0) return null;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    if (px < 0 || py < 0 || px > rect.width || py > rect.height) return null;
    if (this.wrapper.children.length === 0) return null;
    this.scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    const ndc = new THREE.Vector2((px / rect.width) * 2 - 1, -((py / rect.height) * 2 - 1));
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    const targets = this.modelTargets();
    if (targets.length === 0) return null;
    const hits = raycaster.intersectObjects(targets, true);
    const hit = hits.find(candidate => candidate.object instanceof THREE.Mesh);
    return hit ?? null;
  }

  /**
   * Raycast the asset model at canvas client coords; returns the hit in
   * wrapper-local (unframed asset-scene root) coords, or null on any miss
   * or bad input. Null while the `pan` gesture is reserved (see
   * setInteractionMode): a reserved pan can never pick a logo. Never throws.
   * Marker meshes are never hit-tested.
   */
  pickSurface(clientX: number, clientY: number): { modelPosition: { x: number; y: number; z: number } } | null {
    try {
      if (this.interactionMode === 'pan') return null;
      const hit = this.raycastMesh(clientX, clientY);
      if (hit === null) return null;
      const local = this.wrapper.worldToLocal(hit.point.clone());
      if (!Number.isFinite(local.x) || !Number.isFinite(local.y) || !Number.isFinite(local.z)) return null;
      return { modelPosition: { x: local.x, y: local.y, z: local.z } };
    } catch {
      return null;
    }
  }

  /**
   * Intersect a pointer ray with an already calibrated region plane. Used
   * for resize/rotation handles that can lie beyond the product silhouette.
   * Returns native model coordinates; physical conversion remains owned by
   * the calibrated region mapping. Null while the `pan` gesture is reserved,
   * when the region plane faces away from the camera (rear-view drags can
   * no longer move a front placement), and on parallel rays, misses or bad
   * input. Camera/viewport only — never mutates mm. Never throws.
   */
  intersectRegionPlane(clientX: number, clientY: number, frame: {
    origin: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
  }): { x: number; y: number; z: number } | null {
    if (this.disposed || !frame || !frame.origin || !frame.normal) return null;
    if (this.interactionMode === 'pan') return null;
    const { origin, normal } = frame;
    if (![clientX, clientY, origin.x, origin.y, origin.z, normal.x, normal.y, normal.z].every(Number.isFinite)) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const n = new THREE.Vector3(normal.x, normal.y, normal.z);
    if (n.lengthSq() < 1e-12) return null;
    this.scene.updateMatrixWorld(); this.camera.updateMatrixWorld();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(
      (clientX - rect.left) / rect.width * 2 - 1,
      1 - (clientY - rect.top) / rect.height * 2,
    ), this.camera);
    const ray = raycaster.ray.clone().applyMatrix4(this.wrapper.matrixWorld.clone().invert());
    n.normalize();
    if (Math.abs(ray.direction.dot(n)) < 1e-6) return null;
    // Rear-facing region planes reject handle drags: a front placement's
    // calibration plane points away from a back-view camera, so every drag
    // ray would otherwise resolve through the garment. The wrapper carries
    // translation only, so direction transforms are exact.
    try {
      if (this.isSurfaceFacing(origin, normal) === false) return null;
    } catch {
      return null;
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(origin.x, origin.y, origin.z));
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    return hit && [hit.x, hit.y, hit.z].every(Number.isFinite) ? { x: hit.x, y: hit.y, z: hit.z } : null;
  }

  /**
   * Replace the anchor marker set. Positions are wrapper-local model coords
   * so markers ride wrapper transforms. Entries with nonfinite coords are
   * skipped. Empty array clears markers. Never mutates the model subtree.
   */
  setAnchorMarkers(anchors: Array<{ id: string; model: { x: number; y: number; z: number } }>): void {
    try {
      const signature = JSON.stringify(Array.isArray(anchors) ? anchors : []);
      if (signature === this.anchorSignature && !this.disposed) return;
      this.clearMarkers();
      this.anchorSignature = signature;
      if (this.disposed) return;
      if (!Array.isArray(anchors) || anchors.length === 0) return;
      const size = this.modelBBox().getSize(new THREE.Vector3()).length();
      const radius = Number.isFinite(size) && size > 0 ? size * 0.015 : 0.02;
      for (const anchor of anchors) {
        if (anchor === null || typeof anchor !== 'object') continue;
        if (!('model' in anchor)) continue;
        const model = anchor.model;
        if (model === null || typeof model !== 'object') continue;
        if (!('x' in model) || !('y' in model) || !('z' in model)) continue;
        const mx = model.x;
        const my = model.y;
        const mz = model.z;
        if (typeof mx !== 'number' || typeof my !== 'number' || typeof mz !== 'number') continue;
        if (!Number.isFinite(mx) || !Number.isFinite(my) || !Number.isFinite(mz)) continue;
        const marker = new THREE.Mesh(this.markerGeometry, this.markerMaterial);
        marker.position.set(mx, my, mz);
        marker.scale.setScalar(radius);
        marker.renderOrder = 12;
        this.markerGroup.add(marker);
      }
    } catch {
      return;
    }
  }

  /**
   * Raycast the asset model from a pointer/mouse event's client coords.
   * Minimal convenience over {@link pickSurface}: extracts `clientX/clientY`
   * and delegates, returning null on any miss or bad input. Never throws.
   */
  pickSurfaceFromEvent(event: { clientX: number; clientY: number }): { modelPosition: { x: number; y: number; z: number } } | null {
    try {
      if (event === null || typeof event !== 'object') return null;
      return this.pickSurface(event.clientX, event.clientY);
    } catch {
      return null;
    }
  }

  /**
   * Raycast with the wrapper-local face normal of the actual mesh triangle.
   * Same gating and target filtering as {@link pickSurface}; the normal is
   * the geometric face normal transformed into wrapper-local coords (the
   * wrapper carries translation only, so direction is exact). Null on any
   * miss, bad input, face-less hit or nonfinite component. Never throws.
   */
  pickSurfaceDetailed(clientX: number, clientY: number): SurfacePickDetailed | null {
    try {
      if (this.interactionMode === 'pan') return null;
      const hit = this.raycastMesh(clientX, clientY);
      if (hit === null || !hit.face) return null;
      const local = this.wrapper.worldToLocal(hit.point.clone());
      if (!Number.isFinite(local.x) || !Number.isFinite(local.y) || !Number.isFinite(local.z)) return null;
      const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      const toLocal = this.wrapper.getWorldQuaternion(new THREE.Quaternion()).invert();
      const normal = worldNormal.applyQuaternion(toLocal);
      if (!Number.isFinite(normal.x) || !Number.isFinite(normal.y) || !Number.isFinite(normal.z)) return null;
      if (normal.lengthSq() <= 0) return null;
      normal.normalize();
      return {
        modelPosition: { x: local.x, y: local.y, z: local.z },
        normal: { x: normal.x, y: normal.y, z: normal.z },
      };
    } catch {
      return null;
    }
  }

  /**
   * Project a wrapper-local model point to canvas client coords (CSS px).
   * Inverse of picking: used to position overlay corners/handles/labels and
   * to verify computed edges against the actual surface. Besides frustum
   * clipping, the point must be garment-visible from the camera: when nearer
   * model geometry occludes it (e.g. a front placement seen from the back of
   * a thin shell), this returns null so every handle, label and hit-test
   * anchored to it culls with the surface instead of bleeding through.
   * Callers already treat null as "hide the overlay". With no model loaded
   * the legacy unoccluded projection applies. Null when disposed, on bad
   * input, when the point is behind the camera, or when occluded. Camera
   * only — mm untouched. Never throws.
   */
  projectToClient(model: { x: number; y: number; z: number }, checkOcclusion = true): { x: number; y: number } | null {
    try {
      if (this.disposed) return null;
      if (model === null || typeof model !== 'object') return null;
      if (!Number.isFinite(model.x) || !Number.isFinite(model.y) || !Number.isFinite(model.z)) return null;
      const world = this.wrapper.localToWorld(new THREE.Vector3(model.x, model.y, model.z));
      // Garment occlusion (issue 5): a point hidden behind nearer geometry
      // (rear view of a front placement) projects to null so HTML handles,
      // labels and selection hit-tests cull with the visible surface.
      this.scene.updateMatrixWorld(true);
      this.camera.updateMatrixWorld();
      if (checkOcclusion && this.surfacePointOccluded(world.clone())) return null;
      const ndc = world.project(this.camera);
      if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) return null;
      if (ndc.z > 1 || ndc.z < -1) return null;
      const rect = this.renderer.domElement.getBoundingClientRect();
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = rect.left + (ndc.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-ndc.y * 0.5 + 0.5) * rect.height;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    } catch {
      return null;
    }
  }

  /**
   * Show or hide anchor markers without touching staged data. Visibility is
   * render-only: markers stay registered and keep riding wrapper transforms.
   * Never throws.
   */
  setAnchorsVisible(visible: boolean): void {
    try {
      if (this.disposed) return;
      // Anchors layer: endpoint markers plus the connecting measurement.
      const shown = visible === true;
      this.markerGroup.visible = shown;
      this.referenceGroup.visible = shown;
    } catch {
      return;
    }
  }

  /** Current anchor-marker visibility (false after dispose guard trips). */
  getAnchorsVisible(): boolean {
    try {
      return this.markerGroup.visible === true;
    } catch {
      return false;
    }
  }

  /**
   * Show or hide safe-area overlays (plus region axes and placement overlays,
   * which share the same visual layer) without touching staged data. Never
   * throws.
   */
  setSafeAreasVisible(visible: boolean): void {
    try {
      if (this.disposed) return;
      const shown = visible === true;
      this.safeAreaGroup.visible = shown;
      this.axesGroup.visible = shown;
      this.placementGroup.visible = shown;
    } catch {
      return;
    }
  }

  /** Current safe-area overlay visibility. */
  getSafeAreasVisible(): boolean {
    try {
      return this.safeAreaGroup.visible === true;
    } catch {
      return false;
    }
  }

  /** Number of mounted safe-area overlay primitives (lines + fills). */
  safeAreaOverlayCount(): number {
    try {
      return this.safeAreaGroup.children.length;
    } catch {
      return 0;
    }
  }

  /** True while the dashed A/B reference line + label are mounted. */
  hasReferenceOverlay(): boolean {
    try {
      return this.referenceGroup.children.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Show or hide the product geometry (parsed model/proxy subtree) without
   * touching overlays, camera, framing bounds or staged data. Render-only:
   * the subtree stays registered, markers/overlays keep riding wrapper
   * transforms, and raycast entry points are unchanged (callers gate picks
   * explicitly). Never throws.
   */
  setProductVisible(visible: boolean): void {
    try {
      if (this.disposed) return;
      this.productVisible = visible === true;
      this.applyProductVisibility();
    } catch {
      return;
    }
  }

  /** Current product-geometry visibility (false after dispose guard trips). */
  getProductVisible(): boolean {
    try {
      return this.productVisible === true;
    } catch {
      return false;
    }
  }

  /** Apply the product flag to the model subtree only; overlays untouched. */
  private applyProductVisibility(): void {
    for (const child of this.wrapper.children) {
      if (child === this.markerGroup || child === this.axesGroup || child === this.placementGroup || child === this.safeAreaGroup || child === this.referenceGroup) continue;
      child.visible = this.productVisible;
    }
  }

  /**
   * Replace the named safe-area polygon overlay set. Points are wrapper-local
   * model coords (3D surface picks in asset coordinates); each polygon draws
   * as an outline loop plus a translucent fill in its own group, so overlays
   * never mutate the model subtree, never participate in raycasts or framing
   * bounds, and never receive wireframe. Entries with fewer than 3 finite
   * points are skipped. Empty array clears overlays. Never throws.
   */
  setSafeAreaOverlays(items: SafeAreaOverlayItem[]): void {
    try {
      const geoSig = JSON.stringify(
        (Array.isArray(items) ? items : []).map((item) => ({
          id: item !== null && typeof item === 'object' ? (item as { id: unknown }).id ?? null : null,
          pointsModel: item !== null && typeof item === 'object' ? (item as { pointsModel: unknown }).pointsModel ?? null : null,
        })),
      );
      const selSig = JSON.stringify(
        (Array.isArray(items) ? items : []).map((item) => [
          item !== null && typeof item === 'object' ? (item as { id: unknown }).id ?? null : null,
          item !== null && typeof item === 'object' && (item as { selected: unknown }).selected === true,
        ]),
      );
      if (!this.disposed && geoSig === this.safeAreaGeoSignature && this.safeAreaBuilt.length > 0) {
        // Geometry identical (exact signature match): selection-only styling.
        if (selSig === this.safeAreaSelSignature) return;
        const byId = new Map<string, boolean>();
        for (const item of items) {
          if (item !== null && typeof item === 'object' && typeof item.id === 'string') byId.set(item.id, item.selected === true);
        }
        for (const built of this.safeAreaBuilt) {
          const selected = byId.get(built.id) === true;
          if (built.selected === selected) continue;
          built.selected = selected;
          built.material.color.set(selected ? 0x0072ce : 0x0b6cab);
          built.repaint(selected);
          built.texture.needsUpdate = true;
        }
        this.safeAreaSelSignature = selSig;
        this.safeAreaSignature = JSON.stringify(items);
        return;
      }
      const signature = JSON.stringify(items);
      if (signature === this.safeAreaSignature) return;
      this.clearSafeAreas();
      if (this.disposed) return;
      if (!Array.isArray(items) || items.length === 0) return;
      this.scene.updateMatrixWorld(true);
      const meshes: THREE.Mesh[] = [];
      for (const child of this.wrapper.children) {
        if ([this.markerGroup, this.axesGroup, this.placementGroup, this.safeAreaGroup, this.referenceGroup].includes(child as THREE.Group)) continue;
        child.traverse((object) => {
          if (object instanceof THREE.Mesh && object.geometry.getAttribute('position')) meshes.push(object);
        });
      }
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue;
        if (!('pointsModel' in item)) continue;
        const raw: unknown = item.pointsModel;
        if (!Array.isArray(raw) || raw.length < 3) continue;
        const points: THREE.Vector3[] = [];
        let valid = true;
        for (const corner of raw) {
          if (!isVec3(corner)) { valid = false; break; }
          points.push(new THREE.Vector3(corner.x, corner.y, corner.z));
        }
        if (!valid || points.length < 3) continue;
        const built = this.addSurfaceArea(points, item.selected === true, meshes);
        if (built !== null && typeof item.id === 'string') {
          this.safeAreaBuilt.push({ id: item.id, selected: item.selected === true, ...built });
        }
      }
      this.safeAreaSignature = signature;
      this.safeAreaGeoSignature = geoSig;
      this.safeAreaSelSignature = selSig;
    } catch {
      return;
    }
  }

  /**
   * Visual skin only: clip actual asset triangles to a polygon mask. A flat
   * triangle fan cuts through garment folds; a decal follows those triangles
   * instead. This never edits picked points, region planes or millimetres.
   */
  private addSurfaceArea(
    native: THREE.Vector3[],
    selected: boolean,
    meshes: THREE.Mesh[],
  ): { material: THREE.MeshBasicMaterial; texture: THREE.CanvasTexture; repaint: (selected: boolean) => void } | null {
    const points = native.map((point) => point.clone().applyMatrix4(this.wrapper.matrixWorld));
    const origin = points[0]!;
    const u = points[1]!.clone().sub(origin).normalize();
    const normal = new THREE.Vector3();
    for (let i = 1; i + 1 < points.length; i += 1) {
      normal.add(new THREE.Vector3().crossVectors(points[i]!.clone().sub(origin), points[i + 1]!.clone().sub(origin)));
    }
    if (normal.lengthSq() < 1e-16) return null;
    normal.normalize();
    const reach = new THREE.Box3().setFromPoints(points).getSize(new THREE.Vector3()).length();
    if (!(reach > 0)) return null;
    // Orient toward the mesh's own outward face, not the camera or polygon
    // winding. Search both directions so saved back-side areas stay back-side.
    const ray = new THREE.Raycaster();
    let nearest = Infinity;
    let outward: THREE.Vector3 | null = null;
    for (const sign of [1, -1]) {
      ray.set(origin.clone().addScaledVector(normal, reach * sign), normal.clone().multiplyScalar(-sign));
      for (const hit of ray.intersectObjects(meshes, false)) {
        const distance = hit.point.distanceToSquared(origin);
        if (hit.face && distance < nearest) {
          nearest = distance;
          const attribute = (hit.object as THREE.Mesh).geometry.getAttribute('normal');
          outward = (attribute
            ? new THREE.Vector3().fromBufferAttribute(attribute, hit.face.a)
                .add(new THREE.Vector3().fromBufferAttribute(attribute, hit.face.b))
                .add(new THREE.Vector3().fromBufferAttribute(attribute, hit.face.c))
            : hit.face.normal.clone()).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
        }
      }
    }
    if (outward === null || nearest > (reach * 0.02) ** 2) return null;
    if (normal.dot(outward) < 0) normal.negate();
    // Keep the first edge as x, but make the basis exactly orthonormal.
    u.addScaledVector(normal, -u.dot(normal)).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    const local = points.map((point) => {
      const delta = point.clone().sub(origin);
      return new THREE.Vector3(delta.dot(u), delta.dot(v), delta.dot(normal));
    });
    const bounds = new THREE.Box3().setFromPoints(local);
    const size = bounds.getSize(new THREE.Vector3());
    if (!(size.x > 0 && size.y > 0)) return null;
    size.x *= 1.02; size.y *= 1.02;
    size.z = Math.max(size.x, size.y, size.z * 2);
    const center = bounds.getCenter(new THREE.Vector3());
    const position = origin.clone().addScaledVector(u, center.x).addScaledVector(v, center.y).addScaledVector(normal, center.z);
    const orientation = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, normal));
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const repaint = (isSelected: boolean): void => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.beginPath();
      local.forEach((point, index) => {
        const x = ((point.x - center.x) / size.x + 0.5) * canvas.width;
        const y = (0.5 - (point.y - center.y) / size.y) * canvas.height;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.closePath();
      context.fillStyle = isSelected ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.18)';
      context.fill();
      context.strokeStyle = '#ffffff'; context.lineWidth = isSelected ? 4 : 3; context.stroke();
    };
    repaint(selected);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      color: selected ? 0x0072ce : 0x0b6cab, map: texture,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const inverse = this.wrapper.matrixWorld.clone().invert();
    let used = false;
    for (const mesh of meshes) {
      const geometry = new DecalGeometry(mesh, position, orientation, size);
      const positions = geometry.getAttribute('position');
      const normals = geometry.getAttribute('normal');
      const kept: number[] = [];
      // Don't paint the opposite side of thin garments in the projector box.
      for (let i = 0; i + 2 < positions.count; i += 3) {
        const facing = normals ? new THREE.Vector3().fromBufferAttribute(normals, i) :
          new THREE.Vector3().subVectors(new THREE.Vector3().fromBufferAttribute(positions, i + 1), new THREE.Vector3().fromBufferAttribute(positions, i))
            .cross(new THREE.Vector3().subVectors(new THREE.Vector3().fromBufferAttribute(positions, i + 2), new THREE.Vector3().fromBufferAttribute(positions, i)));
        if (facing.dot(normal) > 0) kept.push(i, i + 1, i + 2);
      }
      if (kept.length === 0) { geometry.dispose(); continue; }
      geometry.setIndex(kept);
      geometry.applyMatrix4(inverse);
      this.safeAreaGroup.add(new THREE.Mesh(geometry, material));
      used = true;
    }
    if (!used) { texture.dispose(); material.dispose(); return null; }
    return { material, texture, repaint };
  }

  /** Remove safe-area overlay lines/meshes and dispose their geometries/materials. */
  private clearSafeAreas(): void {
    this.safeAreaSignature = '';
    this.safeAreaGeoSignature = '';
    this.safeAreaSelSignature = '';
    this.safeAreaBuilt = [];
    const disposed = new Set<THREE.Material>();
    for (let i = this.safeAreaGroup.children.length - 1; i >= 0; i--) {
      const child = this.safeAreaGroup.children[i];
      if (child === undefined) continue;
      this.safeAreaGroup.remove(child);
      if (child instanceof THREE.LineLoop || child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const material = child.material;
        const materials = Array.isArray(material) ? material : [material];
        for (const entry of materials) {
          if (entry === undefined) continue;
          if (disposed.has(entry)) continue;
          disposed.add(entry);
          if (entry instanceof THREE.MeshBasicMaterial) entry.map?.dispose();
          entry.dispose();
        }
      }
    }
  }
  /** Toggle flat wireframe rendering on model materials; markers unaffected. */
  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    for (const child of this.wrapper.children) {
      if (child !== this.markerGroup && child !== this.axesGroup && child !== this.placementGroup && child !== this.safeAreaGroup && child !== this.referenceGroup) this.applyWireframe(child, enabled);
    }
  }

  getWireframe(): boolean {
    return this.wireframe;
  }

  /**
   * Presentation-only brightness multiplier (0.25..3, default 1). Scales the
   * exact default key/fill/ambient intensities (1.2/.4/.3); materials,
   * textures, background, camera, picking and mm are untouched. Bounded and
   * finite: invalid values reset to default. Never throws.
   */
  setLighting(multiplier: number): void {
    try {
      if (this.disposed) return;
      this.lighting = normalizeModelLighting(multiplier);
      this.keyLight.intensity = MODEL_LIGHTING_BASE_KEY * this.lighting;
      this.fillLight.intensity = MODEL_LIGHTING_BASE_FILL * this.lighting;
      this.ambientLight.intensity = MODEL_LIGHTING_BASE_AMBIENT * this.lighting;
    } catch {
      return;
    }
  }

  /** Current presentation-only lighting multiplier (1 after attach). */
  getLighting(): number {
    try {
      return this.disposed ? MODEL_LIGHTING_DEFAULT : this.lighting;
    } catch {
      return MODEL_LIGHTING_DEFAULT;
    }
  }

  getStatus(): ViewerStatus {
    return this.status;
  }

  /** Stop rendering, release GPU resources, detach listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onFrame = null;
    ++this.generation;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.resizeBound);
    this.clearModel();
    if (this.markerGroup.parent !== null) this.markerGroup.parent.remove(this.markerGroup);
    this.markerGeometry.dispose();
    this.markerMaterial.dispose();
    if (this.axesGroup.parent !== null) this.axesGroup.parent.remove(this.axesGroup);
    this.axesXMaterial.dispose();
    this.axesYMaterial.dispose();
    if (this.placementGroup.parent !== null) this.placementGroup.parent.remove(this.placementGroup);
    this.clearPlacements();
    if (this.safeAreaGroup.parent !== null) this.safeAreaGroup.parent.remove(this.safeAreaGroup);
    this.clearSafeAreas();
    if (this.referenceGroup.parent !== null) this.referenceGroup.parent.remove(this.referenceGroup);
    this.clearReference();
    this.controls.dispose();
    this.renderer.dispose();
  }

  private clearModel(): void {
    for (let i = this.wrapper.children.length - 1; i >= 0; i--) {
      const child = this.wrapper.children[i];
      if (child === undefined || child === this.markerGroup || child === this.axesGroup || child === this.placementGroup || child === this.safeAreaGroup || child === this.referenceGroup) continue;
      this.wrapper.remove(child);
      disposeObject(child);
    }
    this.clearMarkers();
    this.clearAxes();
    this.clearPlacements();
    this.clearSafeAreas();
    this.clearReference();
    this.wrapper.position.set(0, 0, 0);
  }

  /** Bounding box of the asset model only; markers never contribute. */
  private modelBBox(): THREE.Box3 {
    const box = new THREE.Box3();
    box.makeEmpty();
    for (const child of this.wrapper.children) {
      if (child === this.markerGroup || child === this.axesGroup || child === this.placementGroup || child === this.safeAreaGroup || child === this.referenceGroup) continue;
      box.expandByObject(child);
    }
    return box;
  }

  /** Remove marker meshes; shared geometry/material are retained. */
  private clearMarkers(): void {
    this.anchorSignature = '';
    for (let i = this.markerGroup.children.length - 1; i >= 0; i--) {
      const child = this.markerGroup.children[i];
      if (child === undefined) continue;
      this.markerGroup.remove(child);
    }
  }
  /**
   * Replace the planar-region axes overlay. Null clears it. Invalid frames
   * clear the overlay and return without throwing. Length is explicit mm
   * converted through mmPerModelUnit; never derived from the model bbox.
   */
  setRegionAxes(frame: RegionAxesFrame | null): void {
    try {
      this.clearAxes();
      if (this.disposed) return;
      if (frame === null || typeof frame !== 'object') return;
      const origin = frame.origin;
      const xDir = frame.xDir;
      const yDir = frame.yDir;
      const { lengthMm, mmPerModelUnit } = frame;
      if (!isVec3(origin) || !isVec3(xDir) || !isVec3(yDir)) { this.clearAxes(); return; }
      if (!Number.isFinite(lengthMm) || lengthMm <= 0) { this.clearAxes(); return; }
      if (!Number.isFinite(mmPerModelUnit) || mmPerModelUnit <= 0) { this.clearAxes(); return; }
      const xn = Math.sqrt(xDir.x * xDir.x + xDir.y * xDir.y + xDir.z * xDir.z);
      const yn = Math.sqrt(yDir.x * yDir.x + yDir.y * yDir.y + yDir.z * yDir.z);
      if (!Number.isFinite(xn) || xn <= 0 || !Number.isFinite(yn) || yn <= 0) { this.clearAxes(); return; }
      const lengthUnits = lengthMm / mmPerModelUnit;
      if (!Number.isFinite(lengthUnits) || lengthUnits <= 0) { this.clearAxes(); return; }
      const xEnd = {
        x: origin.x + (xDir.x / xn) * lengthUnits,
        y: origin.y + (xDir.y / xn) * lengthUnits,
        z: origin.z + (xDir.z / xn) * lengthUnits,
      };
      const yEnd = {
        x: origin.x + (yDir.x / yn) * lengthUnits,
        y: origin.y + (yDir.y / yn) * lengthUnits,
        z: origin.z + (yDir.z / yn) * lengthUnits,
      };
      if (!isVec3(xEnd) || !isVec3(yEnd)) { this.clearAxes(); return; }
      const xGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(origin.x, origin.y, origin.z),
        new THREE.Vector3(xEnd.x, xEnd.y, xEnd.z),
      ]);
      this.axesGroup.add(new THREE.Line(xGeometry, this.axesXMaterial));
      const yGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(origin.x, origin.y, origin.z),
        new THREE.Vector3(yEnd.x, yEnd.y, yEnd.z),
      ]);
      this.axesGroup.add(new THREE.Line(yGeometry, this.axesYMaterial));
    } catch {
      this.clearAxes();
      return;
    }
  }

  /** Remove axis lines and dispose their geometries; materials are retained. */
  private clearAxes(): void {
    for (let i = this.axesGroup.children.length - 1; i >= 0; i--) {
      const child = this.axesGroup.children[i];
      if (child === undefined) continue;
      this.axesGroup.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
      }
    }
  }
  /**
   * Replace the logo-placement overlay set. Positions are wrapper-local
   * model coords (mapped by the caller via the region planar mapping
   * `toModel`); overlays live in their own group and never mutate the model
   * subtree. Entries with non-quad or nonfinite coords are skipped. Empty
   * array clears overlays. Never throws.
   */
  setPlacementOverlays(items: PlacementOverlayItem[]): void {
    try {
      this.clearPlacements();
      if (this.disposed) return;
      if (!Array.isArray(items) || items.length === 0) return;
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue;
        if (!('cornersModel' in item)) continue;
        const corners: unknown = item.cornersModel;
        if (!Array.isArray(corners) || corners.length !== 4) continue;
        const points: THREE.Vector3[] = [];
        let valid = true;
        for (const corner of corners) {
          if (!isVec3(corner)) { valid = false; break; }
          points.push(new THREE.Vector3(corner.x, corner.y, corner.z));
        }
        if (!valid || points.length !== 4) continue;
        const fits = 'fits' in item && item.fits === true;
        const selected = 'selected' in item && item.selected === true;
        const color = fits ? 0x2ecc71 : 0xe74c3c;
        const outlineGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const outlineMaterial = new THREE.LineBasicMaterial({ color, depthTest: true });
        this.placementGroup.add(new THREE.LineLoop(outlineGeometry, outlineMaterial));
        if (selected) {
          const centroid = new THREE.Vector3(0, 0, 0);
          for (const point of points) centroid.add(point);
          centroid.multiplyScalar(0.25);
          const haloPoints = points.map((point) =>
            new THREE.Vector3().subVectors(point, centroid).multiplyScalar(1.03).add(centroid),
          );
          const haloGeometry = new THREE.BufferGeometry().setFromPoints(haloPoints);
          const haloMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: true });
          this.placementGroup.add(new THREE.LineLoop(haloGeometry, haloMaterial));
        }
        const fillGeometry = new THREE.BufferGeometry().setFromPoints(points);
        fillGeometry.setIndex([0, 1, 2, 0, 2, 3]);
        fillGeometry.computeVertexNormals();
        const fillMaterial = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.25,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        this.placementGroup.add(new THREE.Mesh(fillGeometry, fillMaterial));
        // Textured artwork preview (append-only): same quad, procedurally
        // drawn from the opaque `art` token. Geometry is untouched — the
        // plane reuses the exact corner positions; only appearance varies.
        // Never throws: any texture failure leaves the outline+fill above.
        try {
          const art = 'art' in item && typeof item.art === 'string' ? item.art : '';
          const artGeometry = new THREE.BufferGeometry().setFromPoints(points);
          artGeometry.setIndex([0, 1, 2, 0, 2, 3]);
          // UV mapping rationale documented at createPlacementArtTexture.
          artGeometry.setAttribute('uv', new THREE.Float32BufferAttribute([
            0, 0,
            1, 0,
            1, 1,
            0, 1,
          ], 2));
          artGeometry.computeVertexNormals();
          const artTexture = createPlacementArtTexture(art);
          const artMaterial = new THREE.MeshBasicMaterial({
            map: artTexture,
            transparent: true,
            opacity: 0.95,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits: -4,
          });
          const artMesh = new THREE.Mesh(artGeometry, artMaterial);
          // Keep the exact calibrated quad; a depth-buffer bias makes the
          // preview visible on either face without moving it into the mesh.
          this.placementGroup.add(artMesh);
        } catch {
          // Outline + fill already added; artwork is preview-only.
        }
      }
    } catch {
      return;
    }
  }

  /**
   * Artwork faces the real outside surface, with its width along region +x.
   *
   * Each item is projected independently from its own anchor/normal/depth:
   * the projector binds to the intended shell (per-mesh outward check plus
   * per-triangle facing filter), so opposite-shell triangles of thin/folded
   * garments are never painted and adding another logo — in either add
   * order — never changes an existing item's visibility. Occlusion between
   * the two sides at view time comes from real depth testing (art materials
   * keep depthTest enabled), not from DoubleSide assumptions.
   */
  setSurfaceArtworkOverlays(items: SurfaceArtworkItem[]): void {
    this.clearPlacements();
    this.surfaceArtworkItems = items.slice();
    if (this.disposed) return;
    this.scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    for (const child of this.wrapper.children) {
      if ([this.markerGroup, this.axesGroup, this.placementGroup, this.safeAreaGroup, this.referenceGroup].includes(child as THREE.Group)) continue;
      child.traverse((node) => { if (node instanceof THREE.Mesh) meshes.push(node); });
    }
    for (const item of items) {
      if (item.cornersModel.length !== 4 || !item.cornersModel.every(isVec3) || !isVec3(item.anchorModel) || !(item.depthModel > 0)) continue;
      const points = item.cornersModel.map((p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(this.wrapper.matrixWorld));
      const u = points[1]!.clone().sub(points[0]!);
      const v = points[3]!.clone().sub(points[0]!);
      const width = u.length(), height = v.length();
      if (!(width > 0 && height > 0)) continue;
      u.normalize(); v.normalize();
      const normal = new THREE.Vector3().crossVectors(u, v).normalize();
      const anchor = new THREE.Vector3(item.anchorModel.x, item.anchorModel.y, item.anchorModel.z).applyMatrix4(this.wrapper.matrixWorld);
      const worldScale = new THREE.Vector3().setFromMatrixScale(this.wrapper.matrixWorld).x;
      const depth = item.depthModel * Math.abs(worldScale);
      const ray = new THREE.Raycaster();
      let nearest = Infinity;
      let outward: THREE.Vector3 | null = null;
      for (const sign of [1, -1]) {
        ray.set(anchor.clone().addScaledVector(normal, depth * sign), normal.clone().multiplyScalar(-sign));
        for (const hit of ray.intersectObjects(meshes, false)) {
          const distance = hit.point.distanceToSquared(anchor);
          if (hit.face && distance < nearest) {
            nearest = distance;
            const attribute = (hit.object as THREE.Mesh).geometry.getAttribute('normal');
            outward = (attribute
              ? new THREE.Vector3().fromBufferAttribute(attribute, hit.face.a)
                .add(new THREE.Vector3().fromBufferAttribute(attribute, hit.face.b))
                .add(new THREE.Vector3().fromBufferAttribute(attribute, hit.face.c))
              : hit.face.normal.clone()).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
          }
        }
      }
      if (!outward) continue;
      // The patch plane supplies the projection direction. A single anchor
      // triangle on a garment fold only chooses its sign, not a new axis.
      const facingDirection = normal.clone().multiplyScalar(normal.dot(outward) < 0 ? -1 : 1);
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024;
      const ctx = canvas.getContext('2d'); if (!ctx) continue;
      ctx.drawImage(item.image, 0, 0, 1024, 1024);
      if (item.selected || !item.fits) {
        ctx.strokeStyle = item.fits ? '#0072ce' : '#d20a2e'; ctx.lineWidth = 8; ctx.strokeRect(4, 4, 1016, 1016);
      }
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      // depthWrite TRUE (unlike safe-area skins): coplanar opposite-side
      // decals must resolve by real depth testing, never by transparent
      // draw order, so either add order occludes identically. polygonOffset
      // keeps each decal ahead of its own shell against z-fighting.
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      const center = points[0]!.clone().add(points[2]!).multiplyScalar(0.5);
      // Polygon winding can point a saved plane into the garment. Orient the
      // raster toward the actual outside face so lettering is not mirrored.
      // Flipping the projector's height axis does not change its rectangular
      // footprint, centre, physical dimensions or persisted frame.
      const imageNormal = facingDirection;
      const imageUp = new THREE.Vector3().crossVectors(imageNormal, u).normalize();
      const orientation = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, imageUp, imageNormal));
      const inverse = this.wrapper.matrixWorld.clone().invert();
      let used = false;
      // Per-item state only (anchor, facing, material): adding another logo
      // never changes an existing item's visibility, in either add order.
      const shellProbe = new THREE.Raycaster();
      for (const mesh of meshes) {
        // Bind the projector to the intended shell: skip meshes whose own
        // nearest face along the projection axis points away (opposite shell
        // of a thin/folded garment inside the projector box). The surviving
        // per-triangle facing filter below then keeps only outward faces.
        try {
          shellProbe.set(
            anchor.clone().addScaledVector(facingDirection, Math.max(depth, 1e-9)),
            facingDirection.clone().negate(),
          );
          const shellHits = shellProbe.intersectObject(mesh, false);
          const shellHit = shellHits.find((candidate) => candidate.face !== null && candidate.face !== undefined);
          if (shellHit?.face) {
            const attribute = (shellHit.object as THREE.Mesh).geometry.getAttribute('normal');
            const shellNormal = (attribute
              ? new THREE.Vector3().fromBufferAttribute(attribute, shellHit.face.a)
              : shellHit.face.normal.clone()
            ).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(shellHit.object.matrixWorld)).normalize();
            if (shellNormal.dot(facingDirection) <= 0) continue;
          }
        } catch {
          continue;
        }
        const geometry = new DecalGeometry(mesh, center, orientation, new THREE.Vector3(width, height, depth));
        const normals = geometry.getAttribute('normal');
        const positions = geometry.getAttribute('position');
        const kept: number[] = [];
        for (let i = 0; i + 2 < positions.count; i += 3) {
          const face = normals ? new THREE.Vector3().fromBufferAttribute(normals, i) :
            new THREE.Vector3().subVectors(new THREE.Vector3().fromBufferAttribute(positions, i + 1), new THREE.Vector3().fromBufferAttribute(positions, i))
              .cross(new THREE.Vector3().subVectors(new THREE.Vector3().fromBufferAttribute(positions, i + 2), new THREE.Vector3().fromBufferAttribute(positions, i)));
          if (face.dot(facingDirection) > 0) kept.push(i, i + 1, i + 2);
        }
        if (kept.length === 0) { geometry.dispose(); continue; }
        geometry.setIndex(kept); geometry.applyMatrix4(inverse);
        const overlay = new THREE.Mesh(geometry, material); overlay.name = `surface-artwork:${item.id}`;
        overlay.renderOrder = 10;
        this.placementGroup.add(overlay); used = true;
      }
      if (!used) { texture.dispose(); material.dispose(); }
    }
  }

  getSurfaceArtworkCount(): number {
    return this.placementGroup.children.filter((node) => node.name.startsWith('surface-artwork:')).length;
  }

  /** Remove overlay lines/meshes and dispose their geometries/materials. */
  private clearPlacements(): void {
    this.surfaceArtworkItems = [];
    for (let i = this.placementGroup.children.length - 1; i >= 0; i--) {
      const child = this.placementGroup.children[i];
      if (child === undefined) continue;
      this.placementGroup.remove(child);
      if (child instanceof THREE.LineLoop || child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const material = child.material;
        const materials = Array.isArray(material) ? material : [material];
        for (const entry of materials) {
          if (entry === undefined) continue;
          // Material.dispose() leaves textures alive: release the artwork
          // CanvasTexture explicitly (art meshes are the only textured
          // children; line/fill materials have no map).
          if (entry instanceof THREE.MeshBasicMaterial && entry.map !== null) {
            entry.map.dispose();
          }
          entry.dispose();
        }
      }
    }
  }


  private applyWireframe(root: THREE.Object3D, enabled: boolean): void {
    root.traverse((child: THREE.Object3D) => {
      if (!('material' in child)) return;
      const material = child.material;
      if (material === undefined) return;
      const materials = Array.isArray(material) ? material : [material];
      for (const candidate of materials) {
        if ('wireframe' in candidate && typeof candidate.wireframe === 'boolean') {
          candidate.wireframe = enabled;
        }
      }
    });
  }

  private resize(): void {
    if (this.disposed) return;
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Re-measure the container and refit the current content. Call after the
   * canvas wrap becomes visible (e.g. mode switch from flat to 3D) because
   * a hidden container measures 0x0 and leaves a stale viewport behind.
   * Never throws.
   */
  refreshSize(): void {
    try {
      if (this.disposed) return;
      // Preserve the EXACT view direction across resizes: fitView resets the
      // camera to its diagonal default, so re-apply the normalized prior
      // direction at the newly fitted distance instead of snapping to the
      // nearest side (which loses arbitrary orbit positions and can blank a
      // side-on view through residual OrbitControls state).
      const keepZoom = this.zoomPct;
      const offset = this.camera.position.clone().sub(this.controls.target);
      const length = offset.length();
      this.resize();
      this.fitView();
      this.zoomPct = keepZoom;
      if (!Number.isFinite(length) || length <= 0) return;
      const fitted = this.camera.position.distanceTo(this.controls.target);
      if (!Number.isFinite(fitted) || fitted <= 0) return;
      offset.normalize();
      this.camera.position.copy(this.controls.target.clone().addScaledVector(offset, fitted));
      this.camera.near = Math.max(fitted * NEAR_FACTOR, 0.001);
      this.camera.far = fitted * FAR_FACTOR;
      this.camera.updateProjectionMatrix();
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      // A resize refits the framing bounds: re-apply the stored zoom step so
      // the readout (and view) survive narrow/wide layout changes.
      if (keepZoom !== 100) this.applyZoomDistance();
    } catch {
      return;
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    this.controls.update();
    try {
      const canvas = this.renderer.domElement;
      const w = canvas.clientWidth || 0;
      const h = canvas.clientHeight || 0;
      const p = this.camera.position;
      const t = this.controls.target;
      const key = `${p.x}|${p.y}|${p.z}|${t.x}|${t.y}|${t.z}|${w}x${h}`;
      if (key !== this.lastViewKey) {
        this.lastViewKey = key;
        this.viewRevision += 1;
      }
    } catch {
      /* revision is advisory; the frame still renders */
    }
    try {
      this.onFrame?.();
    } catch {
      /* overlay-only; never breaks rendering */
    }
    this.updateReferenceLabelScale();
    // White squares retain a compact 6 CSS-pixel side while the camera moves.
    const canvasHeight = this.renderer.domElement.clientHeight || 1;
    const inverseParent = this.markerGroup.getWorldQuaternion(new THREE.Quaternion()).invert();
    const facing = inverseParent.multiply(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    for (const marker of this.markerGroup.children) {
      marker.quaternion.copy(facing);
      marker.getWorldPosition(scratchVector);
      const distance = this.camera.position.distanceTo(scratchVector);
      const size = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / canvasHeight * 6;
      if (Number.isFinite(size) && size > 0) marker.scale.setScalar(size);
    }
    this.renderer.render(this.scene, this.camera);
  };

  private setStatus(status: ViewerStatus): ViewerStatus {
    this.status = status;
    this.onStatus?.(status);
    return status;
  }
}
/**
 * Procedural preview texture for one placement-overlay artwork token.
 *
 * Variants (opaque `art` strings; unknown/empty tokens fall back to mark-a):
 *   - mark-a: teal ground, diagonal split (dark band toward uv top-right),
 *     off-center disc toward uv top-left. Asymmetric in both axes.
 *   - mark-b: amber ground, chevron apex toward uv top, corner bar along the
 *     uv bottom edge. Asymmetric in both axes.
 *
 * Why asymmetric: a symmetric fill cannot show whether the quad is rotated
 * or mirrored; these marks make clockwise rotation verifiable — rotating the
 * placement moves the disc/chevron to a visibly different corner.
 *
 * Orientation contract (matches the uv assignment in setPlacementOverlays):
 * footprint corners arrive in frozen order [(-w/2,-h/2), (w/2,-h/2),
 * (w/2,h/2), (-w/2,h/2)] in the region frame (+x right, +y up facing the
 * region), i.e. index 0 = region bottom-left, index 2 = region top-right.
 * UVs are corner[0]=(0,0), corner[1]=(1,0), corner[2]=(1,1), corner[3]=(0,1),
 * so texture v=0 sits at region −y (bottom) and v=1 at region +y (top).
 * CanvasTexture keeps flipY=true (three.js default): uv (0,0) samples the
 * canvas row drawn at y=height-1 (canvas bottom), uv (1,1) the row at y=0
 * (canvas top). Therefore drawing the artwork upright on the canvas (motif
 * toward canvas y=0) renders it upright facing the region with +y up —
 * no canvas-row inversion is applied below.
 */
function createPlacementArtTexture(art: string): THREE.CanvasTexture {
  const variant: 'mark-a' | 'mark-b' = art === 'mark-b' ? 'mark-b' : 'mark-a';
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas context unavailable');
  ctx.fillStyle = variant === 'mark-b' ? '#8a5a00' : '#0a5a5a';
  ctx.fillRect(0, 0, size, size);
  if (variant === 'mark-a') {
    // Diagonal split: dark band across the uv top-right half (canvas top-right).
    ctx.fillStyle = '#062a3a';
    ctx.beginPath();
    ctx.moveTo(size * 0.35, size);
    ctx.lineTo(size, size * 0.35);
    ctx.lineTo(size, 0);
    ctx.lineTo(size * 0.75, 0);
    ctx.lineTo(0, size * 0.75);
    ctx.lineTo(0, size);
    ctx.closePath();
    ctx.fill();
    // Off-center disc toward uv top-left = canvas top-left (x small, y small).
    ctx.fillStyle = '#e8f4ff';
    ctx.beginPath();
    ctx.arc(size * 0.28, size * 0.26, size * 0.13, 0, Math.PI * 2);
    ctx.fill();
    // Anchor square at uv bottom-right for second-axis asymmetry.
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(size * 0.78, size * 0.78, size * 0.12, size * 0.12);
  } else {
    // Chevron apex toward uv top = canvas top (y small).
    ctx.strokeStyle = '#10243a';
    ctx.lineWidth = size * 0.07;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(size * 0.12, size * 0.52);
    ctx.lineTo(size * 0.5, size * 0.14);
    ctx.lineTo(size * 0.88, size * 0.52);
    ctx.stroke();
    // Corner bar along the uv bottom edge = canvas bottom (y near height).
    ctx.fillStyle = '#10243a';
    ctx.fillRect(size * 0.08, size * 0.86, size * 0.34, size * 0.07);
    // Disc toward uv top-right for second-axis asymmetry.
    ctx.fillStyle = '#fff4d6';
    ctx.beginPath();
    ctx.arc(size * 0.78, size * 0.24, size * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  // Border + uv-origin tick: white frame with a red tick at the uv origin
  // corner (bottom-left) so orientation is checkable at a glance.
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, size * 0.012);
  ctx.strokeRect(0, 0, size, size);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, size - size * 0.09, size * 0.09, size * 0.09);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}


type Vec3Like = { x: number; y: number; z: number };

/** Scratch vector for per-frame label math (never retained). */
const scratchVector = new THREE.Vector3();

/**
 * Midpoint label sprite for the reference overlay: dark text over an opaque
 * white rounded backing so it stays readable over any product. The caller
 * rescales it per frame for a constant CSS size.
 */
function makeReferenceLabelSprite(text: string): { sprite: THREE.Sprite } {
  const font = '600 30px system-ui, -apple-system, "Segoe UI", sans-serif';
  const measurer = document.createElement('canvas').getContext('2d');
  if (measurer === null) throw new Error('2d canvas context unavailable');
  measurer.font = font;
  const words = text === '' ? ' ' : text;
  const textWidth = Math.ceil(measurer.measureText(words).width);
  const padX = 18;
  const padY = 12;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(8, textWidth + padX * 2);
  canvas.height = 30 + padY * 2;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2d canvas context unavailable');
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  traceRoundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  traceRoundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 10);
  ctx.stroke();
  ctx.font = font;
  ctx.fillStyle = '#111111';
  ctx.textBaseline = 'middle';
  ctx.fillText(words, padX, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
  );
  sprite.renderOrder = 11;
  sprite.userData['labelAspect'] = canvas.width / canvas.height;
  return { sprite };
}

/** Round-rect path without relying on CanvasRenderingContext2D.roundRect. */
function traceRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Finite-component vector check; unknown shapes rejected without throwing. */
function isVec3(value: unknown): value is Vec3Like {
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


/** Dispose geometries/materials/textures held by a detached subtree. */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((child: THREE.Object3D) => {
    if ('geometry' in child && child.geometry instanceof THREE.BufferGeometry) {
      child.geometry.dispose();
    }
    if (!('material' in child) || child.material === undefined) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}
