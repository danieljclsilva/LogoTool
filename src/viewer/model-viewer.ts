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
}

/** Pointer-down/up pair for click-vs-drag surface-pick gating. */
export interface SurfaceClickSample {
  downX: number;
  downY: number;
  upX: number;
  upY: number;
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

export class ModelViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly wrapper: THREE.Group;
  private readonly markerGroup: THREE.Group;
  private readonly markerGeometry: THREE.SphereGeometry;
  private readonly markerMaterial: THREE.MeshBasicMaterial;
  private readonly axesGroup: THREE.Group;
  private readonly placementGroup: THREE.Group;
  private readonly safeAreaGroup: THREE.Group;
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
    this.axesXMaterial = new THREE.LineBasicMaterial({ color: 0xff0000 });
    this.axesYMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00 });
    this.markerGeometry = new THREE.SphereGeometry(1, 16, 12);
    this.markerMaterial = new THREE.MeshBasicMaterial({ color: 0xff4444, depthTest: true });

    // Simple key/fill lighting; materials come from the GLB itself.
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-3, -1, -2);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.3));

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
      if (child !== this.markerGroup && child !== this.axesGroup && child !== this.placementGroup && child !== this.safeAreaGroup) this.applyWireframe(child, this.wireframe);
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
  }

  /** Restore the default camera framing for the current model. */
  resetView(): void {
    this.fitView();
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
   * Raycast the asset model at canvas client coords; returns the hit in
   * wrapper-local (unframed asset-scene root) coords, or null on any miss
   * or bad input. Never throws. Marker meshes are never hit-tested.
   */
  pickSurface(clientX: number, clientY: number): { modelPosition: { x: number; y: number; z: number } } | null {
    try {
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
      const targets: THREE.Object3D[] = [];
      for (const child of this.wrapper.children) {
        if (child !== this.markerGroup && child !== this.axesGroup && child !== this.placementGroup && child !== this.safeAreaGroup) targets.push(child);
      }
      if (targets.length === 0) return null;
      const hits = raycaster.intersectObjects(targets, true);
      const hit = hits.find(candidate => candidate.object instanceof THREE.Mesh);
      if (hit === undefined) return null;
      const local = this.wrapper.worldToLocal(hit.point.clone());
      if (!Number.isFinite(local.x) || !Number.isFinite(local.y) || !Number.isFinite(local.z)) return null;
      return { modelPosition: { x: local.x, y: local.y, z: local.z } };
    } catch {
      return null;
    }
  }

  /**
   * Replace the anchor marker set. Positions are wrapper-local model coords
   * so markers ride wrapper transforms. Entries with nonfinite coords are
   * skipped. Empty array clears markers. Never mutates the model subtree.
   */
  setAnchorMarkers(anchors: Array<{ id: string; model: { x: number; y: number; z: number } }>): void {
    try {
      this.clearMarkers();
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
   * Show or hide anchor markers without touching staged data. Visibility is
   * render-only: markers stay registered and keep riding wrapper transforms.
   * Never throws.
   */
  setAnchorsVisible(visible: boolean): void {
    try {
      if (!this.disposed) this.markerGroup.visible = visible === true;
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
      if (child === this.markerGroup || child === this.axesGroup || child === this.placementGroup || child === this.safeAreaGroup) continue;
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
      this.clearSafeAreas();
      if (this.disposed) return;
      if (!Array.isArray(items) || items.length === 0) return;
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
        const outlineGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x0b6cab, depthTest: true });
        this.safeAreaGroup.add(new THREE.LineLoop(outlineGeometry, outlineMaterial));
        const fillGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const triangles: number[] = [];
        for (let index = 1; index + 1 < points.length; index += 1) {
          triangles.push(0, index, index + 1);
        }
        fillGeometry.setIndex(triangles);
        fillGeometry.computeVertexNormals();
        const fillMaterial = new THREE.MeshBasicMaterial({
          color: 0x0b6cab,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        this.safeAreaGroup.add(new THREE.Mesh(fillGeometry, fillMaterial));
      }
    } catch {
      return;
    }
  }

  /** Remove safe-area overlay lines/meshes and dispose their geometries/materials. */
  private clearSafeAreas(): void {
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
          entry.dispose();
        }
      }
    }
  }
  /** Toggle flat wireframe rendering on model materials; markers unaffected. */
  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    for (const child of this.wrapper.children) {
      if (child !== this.markerGroup && child !== this.axesGroup && child !== this.placementGroup && child !== this.safeAreaGroup) this.applyWireframe(child, enabled);
    }
  }

  getWireframe(): boolean {
    return this.wireframe;
  }

  getStatus(): ViewerStatus {
    return this.status;
  }

  /** Stop rendering, release GPU resources, detach listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
    this.controls.dispose();
    this.renderer.dispose();
  }

  private clearModel(): void {
    for (let i = this.wrapper.children.length - 1; i >= 0; i--) {
      const child = this.wrapper.children[i];
      if (child === undefined || child === this.markerGroup || child === this.axesGroup || child === this.placementGroup || child === this.safeAreaGroup) continue;
      this.wrapper.remove(child);
      disposeObject(child);
    }
    this.clearMarkers();
    this.clearAxes();
    this.clearPlacements();
    this.clearSafeAreas();
    this.wrapper.position.set(0, 0, 0);
  }

  /** Bounding box of the asset model only; markers never contribute. */
  private modelBBox(): THREE.Box3 {
    const box = new THREE.Box3();
    box.makeEmpty();
    for (const child of this.wrapper.children) {
      if (child === this.markerGroup || child === this.axesGroup || child === this.placementGroup || child === this.safeAreaGroup) continue;
      box.expandByObject(child);
    }
    return box;
  }

  /** Remove marker meshes; shared geometry/material are retained. */
  private clearMarkers(): void {
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

  /** Remove overlay lines/meshes and dispose their geometries/materials. */
  private clearPlacements(): void {
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
      const offset = this.camera.position.clone().sub(this.controls.target);
      const length = offset.length();
      this.resize();
      this.fitView();
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
    } catch {
      return;
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    this.controls.update();
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
