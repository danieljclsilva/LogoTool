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
export class ModelViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly wrapper: THREE.Group;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly loader = new GLTFLoader();
  private rafId = 0;
  private disposed = false;
  /** Incremented per showModel/clear call; stale async parses bail out. */
  private generation = 0;
  private wireframe = false;
  private status: ViewerStatus = { kind: 'empty' };
  private onStatus: ((status: ViewerStatus) => void) | null = null;

  private constructor(
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    background: number,
  ) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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
    this.applyWireframe(this.wrapper, this.wireframe);
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
    const box = new THREE.Box3().setFromObject(this.wrapper);
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

  /** Toggle flat wireframe rendering on all model materials. */
  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    this.applyWireframe(this.wrapper, enabled);
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
    this.controls.dispose();
    this.renderer.dispose();
  }

  private clearModel(): void {
    for (let i = this.wrapper.children.length - 1; i >= 0; i--) {
      const child = this.wrapper.children[i];
      if (child === undefined) continue;
      this.wrapper.remove(child);
      disposeObject(child);
    }
    this.wrapper.position.set(0, 0, 0);
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
