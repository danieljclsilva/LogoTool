/**
 * setup-calibration-harness.ts — self-contained browser entry for
 * e2e/setup-calibration.spec.ts (W3-owned).
 *
 * Mounts the REAL ModelViewer plus the NEW model-setup-view against a
 * synthetic GLB loaded at runtime. No images, no network, no server: the
 * spec bundles this file with repo-local esbuild, inlines the IIFE into a
 * generated HTML page, and opens it through file:// in an offline context.
 * Synthetic fixtures only.
 */
import { ModelViewer } from '../../src/viewer/model-viewer.js';
import { createModelSetupView } from '../../src/ui/internal-builder/model-setup-view.js';
import type { ModelSetupSnapshot } from '../../src/ui/internal-builder/model-setup-view.js';

declare global {
  // eslint-disable-next-line no-unused-vars
  interface Window {
    __setupHarness: unknown;
  }
}

const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
const stage = document.getElementById('stage') as HTMLElement | null;
const host = document.getElementById('setup') as HTMLElement | null;

if (!canvas || !stage || !host) {
  throw new Error('setup-calibration harness: missing #gl, #stage or #setup nodes.');
}

let viewer: ModelViewer | null = null;
let lastSnapshot: ModelSetupSnapshot | null = null;
let lastStatusText = '';
const activeProductId: string | null = 'SYN-BOX';

const attached = ModelViewer.attach({ canvas, container: stage, background: 0xffffff });
viewer = attached.viewer;

const handle = createModelSetupView(
  host,
  () => viewer,
  () => canvas,
  () => ({
    products: [{ productId: 'SYN-BOX', productName: 'Syn Box', modelPath: 'harness/model.glb' }],
    activeProductId,
    assetKey: 'harness-asset-1',
  }),
  {
    onStatus: (message: string): void => {
      lastStatusText = message;
    },
    onChange: (snapshot: ModelSetupSnapshot): void => {
      lastSnapshot = snapshot;
    },
  },
  location.hash === '#context' ? { contextHost: stage } : {},
);
handle.refresh();

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

window.__setupHarness = {
  /** Count real projection/pick work, without wall-clock performance thresholds. */
  async profileFrames(mode: string): Promise<{ projections: number; picks: number }> {
    if (!viewer) throw new Error('No viewer');
    const live = viewer;
    const project = live.projectToClient;
    const pick = live.pickSurface;
    let projections = 0, picks = 0;
    live.projectToClient = function (...args) { projections++; return project.apply(this, args); };
    live.pickSurface = function (...args) { picks++; return pick.apply(this, args); };
    try {
      if (mode === 'zoom') live.setZoomPercent(live.getZoomPercent() === 100 ? 150 : 100);
      for (let frame = 0; frame < 20; frame++) {
        if (mode === 'moving') live.setZoomPercent(110 + frame * 2);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      return { projections, picks };
    } finally { live.projectToClient = project; live.pickSurface = pick; }
  },
  attachKind(): string {
    return attached.status.kind;
  },
  async loadGlb(base64: string): Promise<string> {
    if (!viewer) return 'no-viewer';
    const status = await viewer.showModel(base64ToBytes(base64));
    handle.refresh();
    return status.kind;
  },
  anchorsVisible(): boolean {
    return viewer !== null && viewer.getAnchorsVisible();
  },
  safeAreasVisible(): boolean {
    return viewer !== null && viewer.getSafeAreasVisible();
  },
  productVisible(): boolean {
    return viewer !== null && viewer.getProductVisible();
  },
  /**
   * Actual rendered pixels differing from the white stage background
   * (sampled every 4th pixel). Proves the model mesh really paints (or is
   * really gone) rather than trusting a flag. -1 when no viewer is live.
   */
  nonBackgroundPixels(): number {
    if (!viewer) return -1;
    const source = canvas as HTMLCanvasElement;
    const width = source.width;
    const height = source.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return -1;
    const probe = document.createElement('canvas');
    probe.width = width;
    probe.height = height;
    const context = probe.getContext('2d', { willReadFrequently: true });
    if (!context) return -1;
    context.drawImage(source, 0, 0);
    const data = context.getImageData(0, 0, width, height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (255 - r + (255 - g) + (255 - b) > 48) count += 1;
    }
    return count;
  },
  lastStatus(): string {
    return lastStatusText;
  },
  lastSnapshot(): ModelSetupSnapshot | null {
    return lastSnapshot;
  },
  referenceOverlay(): boolean {
    return viewer !== null && viewer.hasReferenceOverlay();
  },
  safeAreaOverlays(): number {
    return viewer !== null ? viewer.safeAreaOverlayCount() : -1;
  },
  projectProbe(): { x: number; y: number } | null {
    const point = viewer?.projectToClient({ x: 0.2, y: 0.1, z: 0.5 });
    const rect = canvas.getBoundingClientRect();
    return point ? { x: point.x - rect.x, y: point.y - rect.y } : null;
  },
  restore(text: string): boolean {
    return handle.hydrateFromJson(text).ok;
  },
  front(): void { viewer?.setViewSide('front'); },
  back(): void { viewer?.setViewSide('back'); },
  centerPixel(): number[] {
    const probe = document.createElement('canvas');
    probe.width = canvas.width; probe.height = canvas.height;
    const context = probe.getContext('2d');
    if (!context) return [];
    context.drawImage(canvas, 0, 0);
    return Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data);
  },
  canvasBox(): { x: number; y: number; width: number; height: number } | null {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  },
};
