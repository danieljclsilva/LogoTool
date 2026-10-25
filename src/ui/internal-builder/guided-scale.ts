/// <reference lib="dom" />
/**
 * Guided scale setup for the Images (photo) path (lead-owned, staff-only).
 *
 * When a product Images view has no evaluated photo mapping, the workspace
 * cannot author millimetres yet. This panel captures the missing evidence
 * visually. The PRIMARY flow is a two-click reference span: the operator
 * clicks point A then point B on the actual photo, sees both endpoints plus
 * the connecting line plus the entered positive millimetre length, and the
 * panel derives ONE uniform scale (mm per native photo pixel, zoom and
 * viewport invariant — geometry lives in normalized UV / pixel-native units,
 * never CSS pixels) through the W1 setup-calibration kernel
 * (`validateReferenceSpan` + `fitScaleFromReferences`, adapted by
 * {@link validateImageSpan}). Zero, coincident or otherwise invalid spans
 * are refused with actionable messages; nothing is guessed from pixels.
 *
 * Front-on planar assumption (honest boundary): a single span sets a uniform
 * scale only. It cannot solve perspective, tilt or lens distortion — the
 * photo must be taken straight-on (fronto-parallel). Angled photos need the
 * Advanced rectangle below, and EVERY result stays pending review, never
 * production approval.
 *
 * The ADVANCED flow keeps the original four-corner known-rectangle mapping
 * intact: the operator clicks C1..C4 in photo order, enters width + height,
 * declares orientation, and the caller solves the affine photo mapping
 * through {@link guidedCorrespondences} plus the existing
 * `solveAffineFromCorrespondences`. One length alone is refused there, never
 * inferred from pixels.
 *
 * Recalibrating (a new scale) explicitly invalidates dependent safe areas:
 * they are keyed to the calibration identity and dropped, never silently
 * reinterpreted — the workspace states this in its own copy.
 *
 * No files, no fetch, no persistence here: the caller owns the photo bytes
 * and the commit. The host container (`data-builder-hook="guided-scale"`)
 * is lead-owned in the template; this module builds every node
 * programmatically and never touches the template.
 */
import type { PhotoMappingCorrespondence } from '../customer-editor/presentation-photo-mapping.js';
import {
  PRODUCT_SETUP_FIT_MIN_PX,
  PRODUCT_SETUP_FIT_VH,
  PRODUCT_SETUP_ZOOM_STEPS,
  clampZoomPercentage,
  fitPhotoBox,
  stepZoomPercentage,
} from './product-setup-view.js';
import {
  fitScaleFromReferences,
  spanNativeDistance,
  validateReferenceSpan,
} from '../../core/setup-calibration/index.js';
import type { ProductSetupScope } from './product-setup-view.js';

export type GuidedScaleOrientation = 'photo-up' | 'photo-down';

export interface GuidedScalePhoto {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  label: string;
}

export interface GuidedScaleRequest {
  scope: ProductSetupScope;
  photo: GuidedScalePhoto;
  /** Exact `presentation/` raster path the mapping will reference. */
  imagePath: string;
}

export interface GuidedScaleCommit {
  cornersUv: Array<{ u: number; v: number }>;
  widthMm: number;
  heightMm: number;
  orientation: GuidedScaleOrientation;
}

/**
 * Primary two-click reference-span commit: normalized-UV endpoints A and B
 * on the actual photo plus the declared real length in millimetres. The
 * caller derives the uniform calibration from it (scale = mm /
 * pixel-native distance); this panel never invents translation, rotation or
 * approval. Pure data; no DOM.
 */
export interface GuidedScaleSpanCommit {
  aUv: ReferenceEndpointUv;
  bUv: ReferenceEndpointUv;
  lengthMm: number;
}

export type GuidedScaleOutcome =
  | { ok: true }
  | { ok: false; error: string };

export interface GuidedScaleCallbacks {
  /**
   * Solve + create calibration/region/mapping atomically, or neither.
   * Resolve `{ ok: true }` only after durable persistence; failure keeps
   * the panel open with the operator's corners intact.
   */
  onCommit(
    request: GuidedScaleRequest,
    commit: GuidedScaleCommit,
  ): GuidedScaleOutcome | Promise<GuidedScaleOutcome>;
  /**
   * Commit a primary two-click reference span (optional; lead-wired).
   * Resolve `{ ok: true }` only after durable persistence; failure keeps
   * the panel open with points A/B and the entered length intact. When the
   * caller has not wired this yet, the panel validates locally, shows the
   * derived uniform scale, and says so honestly instead of committing.
   */
  onSpanCommit?: (
    request: GuidedScaleRequest,
    span: GuidedScaleSpanCommit,
  ) => GuidedScaleOutcome | Promise<GuidedScaleOutcome>;
  onCancel(): void;
  onStatus(message: string): void;
}

export interface GuidedScaleHandle {
  show(request: GuidedScaleRequest): void;
  hide(): void;
  refresh(): void;
  destroy(): void;
}

/**
 * Region-frame (Y-up) millimetre corners C1..C4 for a W×H rectangle.
 * Photo-up: the photo top edge is the area top (C1 = top-left = (0, H)).
 * Photo-down: the photo is rotated 180° relative to the area, so the photo
 * top-left corner is the area BOTTOM-right: C1 = (W, 0), C2 = (0, 0),
 * C3 = (0, H), C4 = (W, H). Both axes flip; a Y-only flip would mirror the
 * area, not rotate it. Pure; no DOM.
 */
export function guidedMmCorners(
  widthMm: number,
  heightMm: number,
  orientation: GuidedScaleOrientation,
): Array<{ x: number; y: number }> {
  if (orientation === 'photo-down') {
    return [
      { x: widthMm, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: heightMm },
      { x: widthMm, y: heightMm },
    ];
  }
  return [
    { x: 0, y: heightMm },
    { x: widthMm, y: heightMm },
    { x: widthMm, y: 0 },
    { x: 0, y: 0 },
  ];
}

/**
 * Build the four UV↔mm correspondences for the solver from clicked photo
 * corners (C1..C4 in photo order) and the declared rectangle. Returns an
 * error string instead of pairs when the input is unusable — the caller
 * surfaces it verbatim. Pure; no DOM.
 */
export function guidedCorrespondences(
  cornersUv: ReadonlyArray<{ u: number; v: number }>,
  widthMm: number,
  heightMm: number,
  orientation: GuidedScaleOrientation,
): { ok: true; pairs: PhotoMappingCorrespondence[] } | { ok: false; error: string } {
  if (cornersUv.length !== 4) {
    return { ok: false, error: `Click all 4 rectangle corners on the photo first (have ${cornersUv.length}).` };
  }
  for (let index = 0; index < 4; index += 1) {
    const corner = cornersUv[index]!;
    if (!Number.isFinite(corner.u) || !Number.isFinite(corner.v)) {
      return { ok: false, error: `Corner C${index + 1} is not a finite photo position; re-click it.` };
    }
    if (corner.u < 0 || corner.u > 1 || corner.v < 0 || corner.v > 1) {
      return { ok: false, error: `Corner C${index + 1} lies outside the photo; click inside the photo.` };
    }
  }
  if (!Number.isFinite(widthMm) || !(widthMm > 0)) {
    return { ok: false, error: 'Enter the rectangle width in millimetres (a number greater than 0).' };
  }
  if (!Number.isFinite(heightMm) || !(heightMm > 0)) {
    return { ok: false, error: 'Enter the rectangle height in millimetres (a number greater than 0).' };
  }
  const mm = guidedMmCorners(widthMm, heightMm, orientation);
  return {
    ok: true,
    pairs: mm.map((point, index) => ({
      uv: { u: cornersUv[index]!.u, v: cornersUv[index]!.v },
      mm: { xMm: point.x, yMm: point.y },
    })),
  };
}

// ---------------------------------------------------------------------------
// W1 setup-calibration kernel (Images span adapter).
//
// The pure kernel (`src/core/setup-calibration`, owned by W1) validates
// reference spans and fits the uniform scale; this panel only adapts its
// photo-click state (normalized UV + native photo size + entered mm) into
// the kernel's `ReferenceSpan` shape — pixel-native `{ x, y }` endpoints
// plus the declared length — and surfaces kernel reasons verbatim. ONLY the
// three function names imported above come from the W1 module; the photo-UI
// concerns below (missing-click and length-entry messages, the station
// 100000 mm entry bound, UV→pixel adaptation) stay local. Structural typing
// keeps this panel decoupled from kernel types.
// ---------------------------------------------------------------------------

/** One clicked endpoint of a reference span, in normalized photo UV. */
export interface ReferenceEndpointUv {
  u: number;
  v: number;
}

/** Native photo size for span math (pixel-native units, never CSS pixels). */
export interface ReferenceSpanPhoto {
  widthPx: number;
  heightPx: number;
}

/** Upper bound for an entered reference length, matching the station commit bound. */
export const MAX_REFERENCE_SPAN_MM = 100000;

/**
 * Grouped millimetre label for a reference length (`1,300 mm`; decimals
 * keep their fraction). Null unless the length is a positive finite number —
 * callers show `Enter distance` instead. Pure; no DOM. (This panel keeps its
 * own copy; product-setup-view.ts carries the same small helper for its
 * saved-span label, and the lead dedupes at integration if ever shared.)
 */
export function formatSpanLengthMm(lengthMm: number): string | null {
  if (!Number.isFinite(lengthMm) || !(lengthMm > 0)) return null;
  const rounded = Math.round(lengthMm * 100) / 100;
  const [int, frac] = String(rounded).split('.');
  const grouped = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${frac !== undefined ? `.${frac}` : ''} mm`;
}

/**
 * Midpoint label for a reference span: the grouped length once a positive
 * finite length is entered, else `Enter distance` — never an invented
 * length. Pure; no DOM.
 */
export function spanLengthLabel(lengthMm: number): string {
  return formatSpanLengthMm(lengthMm) ?? 'Enter distance';
}

/**
 * Adapt clicked UV endpoints + entered length into the kernel's
 * `ReferenceSpan` shape (pixel-native points; structurally typed, no kernel
 * type import). Pure; no DOM.
 */
export function buildImageSpan(
  id: string,
  aUv: ReferenceEndpointUv,
  bUv: ReferenceEndpointUv,
  photo: ReferenceSpanPhoto,
  lengthMm: number,
): { id: string; a: { x: number; y: number }; b: { x: number; y: number }; lengthMm: number } {
  return {
    id,
    a: { x: aUv.u * photo.widthPx, y: aUv.v * photo.heightPx },
    b: { x: bUv.u * photo.widthPx, y: bUv.v * photo.heightPx },
    lengthMm,
  };
}

/**
 * Validate the panel's two-click span state through the W1 kernel, with
 * photo-UI messages for missing clicks and length entry. Missing A/B and
 * unusable lengths are refused locally with actionable wording; geometry
 * (finite, single-frame, coincident) is refused by the kernel and surfaced
 * verbatim. Returns the kernel span plus its native-pixel distance. Pure.
 */
export function validateImageSpan(
  aUv: ReferenceEndpointUv | null,
  bUv: ReferenceEndpointUv | null,
  lengthMm: number,
  photo: ReferenceSpanPhoto,
): { ok: true; span: { id: string; a: { x: number; y: number }; b: { x: number; y: number }; lengthMm: number }; nativePx: number } | { ok: false; error: string } {
  if (aUv === null) {
    return { ok: false, error: 'Click point A on the photo first (the start of the known length).' };
  }
  if (bUv === null) {
    return { ok: false, error: 'Click point B on the photo next (the other end of the known length).' };
  }
  if (!Number.isFinite(lengthMm)) {
    return { ok: false, error: 'Enter the real length in millimetres (a number greater than 0).' };
  }
  if (!(lengthMm > 0)) {
    return { ok: false, error: 'Enter the real length in millimetres (a number greater than 0, e.g. 1300).' };
  }
  if (lengthMm > MAX_REFERENCE_SPAN_MM) {
    return { ok: false, error: `Enter the real length in millimetres (at most ${MAX_REFERENCE_SPAN_MM}).` };
  }
  const span = buildImageSpan('span-ab', aUv, bUv, photo, lengthMm);
  const reason = validateReferenceSpan(span);
  if (reason !== null) return { ok: false, error: reason };
  const nativePx = spanNativeDistance(span);
  if (nativePx === null || !(nativePx > 0)) {
    return { ok: false, error: 'Points A and B do not span a usable photo distance — re-click two distinct points.' };
  }
  return { ok: true, span, nativePx };
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

function sideLabel(side: string): string {
  switch (side) {
    case 'front': return 'Front';
    case 'back': return 'Back';
    case 'left': return 'Left';
    case 'right': return 'Right';
    default: return side;
  }
}

/**
 * Display title for one guided-scale request: the explicit caller view label
 * when present (flexible named views), else the legacy side label. Labels
 * are display-only; identity stays in `scope.viewId`/side. Pure.
 */
export function guidedViewTitle(scope: ProductSetupScope): string {
  const label = scope.viewLabel?.trim();
  const view = label && label.length > 0 ? label : sideLabel(scope.side);
  const regionName = scope.regionName?.trim() || '';
  return regionName !== '' ? `${regionName} · ${view} view` : `the ${view} view`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Render the guided-scale panel into `host`. The host is shown/hidden by
 * the caller (`hidden` attribute); this module only fills/clears it.
 */
export function createGuidedScale(
  host: HTMLElement,
  callbacks: GuidedScaleCallbacks,
): GuidedScaleHandle {
  let destroyed = false;
  let request: GuidedScaleRequest | null = null;
  let corners: Array<{ x: number; y: number }> = [];
  let pending = false;
  /** Primary two-click reference span, in photo-native display units. */
  let spanA: { x: number; y: number } | null = null;
  let spanB: { x: number; y: number } | null = null;
  let spanPending = false;
  let natural: { width: number; height: number } | null = null;
  /**
   * Local span-stage zoom (100 = fitted photo view) plus display-only layer
   * flags. Same steps/semantics as the calibrated editing stage, but local
   * to this panel — no shared state. Zoom never touches native UV math or
   * millimetres; visibility never deletes points or the entered length.
   */
  let spanZoom = 100;
  let spanShowAnchors = true;
  let spanShowAreas = true;
  let spanShowProduct = true;
  /** Stashed span-length text so re-renders never wipe the entered length. */
  let spanMmText = '';
  /**
   * Resize observer for constant-CSS-pixel span markers (same strategy as
   * the product-setup stage): re-runs the marker layout pass when the
   * overlay box changes. Observes the svg element only (child repaints never
   * resize it, so no feedback loop). Torn down on hide/destroy/refresh.
   */
  let spanResize: ResizeObserver | null = null;
  /**
   * Fit observers + window-resize listeners for the bounded span/rectangle
   * stages (recompute the shared photo/overlay box on viewport/container
   * change). Same teardown path as the marker observer.
   */
  let spanFitObservers: ResizeObserver[] = [];
  let spanFitWindowCleanups: Array<() => void> = [];

  function disconnectSpanResize(): void {
    try {
      spanResize?.disconnect();
    } catch {
      /* best-effort teardown */
    }
    spanResize = null;
    for (const observer of spanFitObservers) {
      try {
        observer.disconnect();
      } catch {
        /* best-effort teardown */
      }
    }
    spanFitObservers = [];
    for (const cleanup of spanFitWindowCleanups) {
      try {
        cleanup();
      } catch {
        /* best-effort teardown */
      }
    }
    spanFitWindowCleanups = [];
  }

  function observeSpanOverlay(): void {
    const box = currentSpanBox();
    if (!box) return;
    layoutSpanMarkers(box.svg);
    if (typeof ResizeObserver === 'function') {
      spanResize = new ResizeObserver(() => {
        const live = currentSpanBox();
        if (live && live.svg.isConnected) layoutSpanMarkers(live.svg);
        else disconnectSpanResize();
      });
      spanResize.observe(box.svg);
    }
  }

  function currentPhotoBox(): { img: HTMLImageElement; svg: SVGSVGElement } | null {
    const section = host.querySelector<HTMLElement>('.guided-scale-rect');
    const img = section?.querySelector<HTMLImageElement>('.guided-scale-photo') ?? null;
    const svg = section?.querySelector<SVGSVGElement>('.guided-scale-overlay') ?? null;
    return img && svg ? { img, svg } : null;
  }

  function currentSpanBox(): { img: HTMLImageElement; svg: SVGSVGElement } | null {
    const section = host.querySelector<HTMLElement>('.guided-scale-span');
    const img = section?.querySelector<HTMLImageElement>('.guided-scale-photo') ?? null;
    const svg = section?.querySelector<SVGSVGElement>('.guided-scale-span-overlay') ?? null;
    return img && svg ? { img, svg } : null;
  }

  function photoToUv(event: MouseEvent, svg: SVGSVGElement): { u: number; v: number } | null {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      u: (event.clientX - rect.left) / rect.width,
      v: (event.clientY - rect.top) / rect.height,
    };
  }

  function paintMarkers(): void {
    const box = currentPhotoBox();
    if (!box || !natural) return;
    const { svg } = box;
    svg.replaceChildren();
    corners.forEach((corner, index) => {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(corner.x));
      circle.setAttribute('cy', String(corner.y));
      circle.setAttribute('r', '9');
      circle.setAttribute('class', `guided-scale-corner${index === 0 ? ' is-first' : ''}`);
      svg.append(circle);
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', String(corner.x + 13));
      label.setAttribute('y', String(corner.y + 5));
      label.setAttribute('class', 'guided-scale-label');
      label.textContent = `C${index + 1}`;
      svg.append(label);
    });
    if (corners.length >= 2 && natural) {
      const poly = document.createElementNS(SVG_NS, 'polyline');
      poly.setAttribute(
        'points',
        corners.map((corner) => `${corner.x},${corner.y}`).join(' ') +
        (corners.length === 4 ? ` ${corners[0]!.x},${corners[0]!.y}` : ''),
      );
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', '#0b6cab');
      poly.setAttribute('stroke-width', '2');
      poly.setAttribute('stroke-dasharray', '8 5');
      svg.prepend(poly);
    }
  }

  function setStatus(message: string): void {
    const line = host.querySelector<HTMLElement>('[data-guided="status"]');
    if (line) line.textContent = message;
    callbacks.onStatus(message);
  }

  function readForm(): { widthMm: number; heightMm: number; orientation: GuidedScaleOrientation } {
    const widthInput = host.querySelector<HTMLInputElement>('[data-guided="width"]');
    const heightInput = host.querySelector<HTMLInputElement>('[data-guided="height"]');
    const orientationInput = host.querySelector<HTMLSelectElement>('[data-guided="orientation"]');
    return {
      widthMm: widthInput ? widthInput.valueAsNumber : NaN,
      heightMm: heightInput ? heightInput.valueAsNumber : NaN,
      orientation: orientationInput && orientationInput.value === 'photo-down' ? 'photo-down' : 'photo-up',
    };
  }

  function toDisplayCoords(uv: { u: number; v: number }): { x: number; y: number } | null {
    if (!natural) return null;
    return { x: uv.u * natural.width, y: uv.v * natural.height };
  }

  function toSpanUv(point: { x: number; y: number }): { u: number; v: number } {
    if (!natural) return { u: NaN, v: NaN };
    return { u: point.x / natural.width, v: point.y / natural.height };
  }

  function readSpanMm(): number {
    const input = host.querySelector<HTMLInputElement>('[data-guided="span-mm"]');
    return input ? input.valueAsNumber : NaN;
  }

  /**
   * Bounded contain-fit box shared by the photo and its click overlay
   * (white side space is fine): available stage width AND ~60vh so a
   * portrait photo never pushes the preview past the viewport, scaled by
   * the zoom percentage with internal stage scrolling when magnified.
   * Display-only: UV math and millimetres never scale. Pure layout; no
   * geometry, no state.
   */
  function layoutGuidedFit(
    stage: HTMLElement,
    box: HTMLElement,
    photoW: number,
    photoH: number,
    zoomPct: number,
  ): void {
    stage.style.overflow = 'auto';
    stage.style.maxHeight = '60vh';
    const availW = stage.clientWidth;
    const viewportH = typeof window === 'undefined' ? 0 : window.innerHeight;
    const availH = Math.max(
      viewportH > 0 ? viewportH * PRODUCT_SETUP_FIT_VH : PRODUCT_SETUP_FIT_MIN_PX,
      PRODUCT_SETUP_FIT_MIN_PX,
    );
    const fitted = availW > 0 ? fitPhotoBox(photoW, photoH, availW, availH) : null;
    const scale = clampZoomPercentage(zoomPct) / 100;
    if (fitted !== null) {
      const width = fitted.width * scale;
      box.style.width = `${width}px`;
      box.style.height = `${fitted.height * scale}px`;
      box.style.margin = width < availW - 0.5 ? '0 auto' : '';
    } else {
      box.style.width = zoomPct !== 100 ? `${clampZoomPercentage(zoomPct)}%` : '';
      box.style.height = '';
      box.style.margin = '';
    }
  }

  /**
   * Observe one guided stage for fit recomputation (container/viewport
   * change). The signature guard keeps the observer from looping: an
   * unchanged box writes no styles, so no further resize fires. Display
   * only; UV math untouched. Disposed via disconnectSpanResize.
   */
  function observeGuidedFit(
    stage: HTMLElement,
    box: HTMLElement,
    photoW: number,
    photoH: number,
    zoomOf: () => number,
  ): void {
    let lastFit = '';
    const apply = (): void => {
      if (destroyed || !box.isConnected) return;
      const availW = stage.clientWidth;
      const signature = `${availW}x${zoomOf()}@${typeof window === 'undefined' ? 0 : window.innerHeight}`;
      if (signature === lastFit) return;
      lastFit = signature;
      layoutGuidedFit(stage, box, photoW, photoH, zoomOf());
    };
    apply();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onResize = (): void => {
        lastFit = '';
        apply();
      };
      window.addEventListener('resize', onResize);
      spanFitWindowCleanups.push(() => {
        window.removeEventListener('resize', onResize);
      });
    }
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        apply();
      });
      observer.observe(stage);
      spanFitObservers.push(observer);
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (!destroyed) {
          lastFit = '';
          apply();
        }
      });
    }
  }

  /**
   * Apply the local span-stage zoom without rebuilding (display-only, so the
   * entered length and points are never disturbed): the bounded fitted box
   * scales by percentage so the stage scrolls inside instead of overflowing
   * the page. The overlay stays exactly on the photo rect, so UV math is
   * untouched.
   */
  function applySpanZoom(): void {
    const section = host.querySelector<HTMLElement>('.guided-scale-span');
    const stage = section?.querySelector<HTMLElement>('.guided-scale-stage') ?? null;
    const box = section?.querySelector<HTMLElement>('.guided-scale-zoombox') ?? null;
    if (!stage || !box || !request) return;
    layoutGuidedFit(stage, box, request.photo.widthPx, request.photo.heightPx, spanZoom);
  }

  /** Keep the photo box on the photo rect while the photo itself is hidden. */
  function applySpanProduct(): void {
    const section = host.querySelector<HTMLElement>('.guided-scale-span');
    const box = section?.querySelector<HTMLElement>('.guided-scale-zoombox') ?? null;
    const img = section?.querySelector<HTMLImageElement>('.guided-scale-photo') ?? null;
    if (!box || !img || !request) return;
    if (spanShowProduct) {
      img.style.display = '';
      box.style.aspectRatio = '';
    } else {
      img.style.display = 'none';
      box.style.aspectRatio = `${request.photo.widthPx} / ${request.photo.heightPx}`;
    }
  }

  /** Sync the zoom readout + bound buttons with the local zoom state. */
  function paintSpanView(): void {
    const pct = clampZoomPercentage(spanZoom);
    const select = host.querySelector<HTMLSelectElement>('[data-ps-view="zoom"]');
    if (select) select.value = String(pct);
    const out = host.querySelector<HTMLButtonElement>('[data-ps-view="zoom-out"]');
    if (out) out.disabled = pct <= PRODUCT_SETUP_ZOOM_STEPS[0]!;
    const zin = host.querySelector<HTMLButtonElement>('[data-ps-view="zoom-in"]');
    if (zin) zin.disabled = pct >= PRODUCT_SETUP_ZOOM_STEPS[PRODUCT_SETUP_ZOOM_STEPS.length - 1]!;
  }

  function formatScale(scaleMmPerPx: number): string {
    if (!Number.isFinite(scaleMmPerPx) || !(scaleMmPerPx > 0)) return '—';
    const rounded = Math.round(scaleMmPerPx * 1000) / 1000;
    return `${rounded} mm per photo pixel`;
  }

  /** CSS pixels per overlay viewBox unit (fit letterboxing), or null. */
  function spanCssScale(svg: SVGSVGElement): number | null {
    const rect = svg.getBoundingClientRect();
    const box = svg.viewBox.baseVal;
    if (!(rect.width > 0) || !(box.width > 0)) return null;
    const scale = rect.width / box.width;
    return scale > 0 && Number.isFinite(scale) ? scale : null;
  }

  /**
   * Keep span markers/labels at constant rendered sizes (same data-markr /
   * data-markfont / data-markstroke strategy as the product-setup stage):
   * dots, halo widths, label sizes and dash patterns hold their CSS-pixel
   * sizes on high-res photos and narrow stages. Geometry is never touched.
   */
  function layoutSpanMarkers(svg: SVGSVGElement): void {
    const scale = spanCssScale(svg);
    if (scale === null) return;
    const units = (cssPx: number): string => String(cssPx / scale);
    svg.querySelectorAll('[data-markr]').forEach((node) => {
      const want = Number((node as Element).getAttribute('data-markr'));
      if (Number.isFinite(want)) node.setAttribute('r', units(want));
    });
    svg.querySelectorAll('[data-markfont]').forEach((node) => {
      const el = node as Element;
      const want = Number(el.getAttribute('data-markfont'));
      if (Number.isFinite(want)) node.setAttribute('font-size', String(want / scale));
      const cx = Number(el.getAttribute('data-markcx'));
      const cy = Number(el.getAttribute('data-markcy'));
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        // Endpoint tags sit right/below their dot; the midpoint length
        // label floats above the span line via data-markdy.
        const dyRaw = Number(el.getAttribute('data-markdy'));
        const dy = Number.isFinite(dyRaw) ? dyRaw : 4;
        node.setAttribute('x', String(cx + 12 / scale));
        node.setAttribute('y', String(cy + dy / scale));
      }
    });
    svg.querySelectorAll('[data-markstroke]').forEach((node) => {
      const want = Number((node as Element).getAttribute('data-markstroke'));
      if (Number.isFinite(want)) node.setAttribute('stroke-width', String(want / scale));
    });
    svg.querySelectorAll('[data-markdash]').forEach((node) => {
      const raw = (node as Element).getAttribute('data-markdash') ?? '';
      const parts = raw.trim().split(/[\s,]+/).map(Number)
        .filter((n) => Number.isFinite(n) && n >= 0);
      if (parts.length > 0) node.setAttribute('stroke-dasharray', parts.map((n) => String(n / scale)).join(' '));
    });
  }

  /**
   * Paint the A/B endpoints, the connecting span line and the entered-length
   * label. All geometry is pixel-native viewBox units (never CSS pixels), so
   * the span reads identically at any zoom or viewport size. The line is a
   * dotted ~2-CSS-px stroke and the label reads `Enter distance` until a
   * positive finite length is entered, else e.g. `1,300 mm`, updating live
   * on every input without needing blur.
   */
  function paintSpan(): void {
    const box = currentSpanBox();
    if (!box || !natural) return;
    const { svg } = box;
    svg.replaceChildren();
    const mm = readSpanMm();
    const mmText = spanLengthLabel(mm);
    // The Anchors visibility toggle hides endpoints + line + label without
    // deleting them; the scale preview below keeps working from the state.
    if (spanShowAnchors) {
      if (spanA && spanB) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(spanA.x));
      line.setAttribute('y1', String(spanA.y));
      line.setAttribute('x2', String(spanB.x));
      line.setAttribute('y2', String(spanB.y));
      // Contract classes for the Images reference overlay; the legacy class
      // stays so existing styles keep applying.
      line.setAttribute('class', 'guided-scale-span-line product-setup-refline');
      line.setAttribute('stroke', '#0b6cab');
      line.setAttribute('fill', 'none');
      // Initial viewBox-unit fallbacks; layoutSpanMarkers() below refines
      // them to constant CSS pixels once the overlay is measurable.
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '7 5');
      line.setAttribute('data-markstroke', '2');
      line.setAttribute('data-markdash', '7 5');
      svg.append(line);
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', String((spanA.x + spanB.x) / 2 + 13));
      label.setAttribute('y', String((spanA.y + spanB.y) / 2 - 10));
      // Legacy label styling (white backing) plus the contract class.
      label.setAttribute('class', 'guided-scale-label product-setup-reflabel');
      label.setAttribute('data-markfont', '12');
      label.setAttribute('data-markstroke', '3');
      label.setAttribute('data-markdy', '-10');
      label.setAttribute('data-markcx', String((spanA.x + spanB.x) / 2));
      label.setAttribute('data-markcy', String((spanA.y + spanB.y) / 2));
      label.textContent = mmText;
      svg.append(label);
    }
    const points: Array<{ point: { x: number; y: number }; tag: string }> = [];
    if (spanA) points.push({ point: spanA, tag: 'A' });
    if (spanB) points.push({ point: spanB, tag: 'B' });
    points.forEach(({ point, tag }) => {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(point.x));
      circle.setAttribute('cy', String(point.y));
      circle.setAttribute('r', '8');
      circle.setAttribute('data-markr', '8');
      circle.setAttribute('class', `guided-scale-corner${tag === 'A' ? ' is-first' : ''}`);
      svg.append(circle);
      const tagLabel = document.createElementNS(SVG_NS, 'text');
      tagLabel.setAttribute('x', String(point.x + 13));
      tagLabel.setAttribute('y', String(point.y + 5));
      tagLabel.setAttribute('class', 'guided-scale-label');
      tagLabel.setAttribute('data-markfont', '12');
      tagLabel.setAttribute('data-markcx', String(point.x));
      tagLabel.setAttribute('data-markcy', String(point.y));
      tagLabel.textContent = tag;
      svg.append(tagLabel);
    });
    } // spanShowAnchors: hidden hides endpoints + line + label, keeps state.
    layoutSpanMarkers(svg);
    const preview = host.querySelector<HTMLElement>('[data-guided="span-scale"]');
    if (preview) {
      if (spanA && spanB && natural) {
        const checked = validateImageSpan(toSpanUv(spanA), toSpanUv(spanB), mm, {
          widthPx: natural.width,
          heightPx: natural.height,
        });
        preview.textContent = checked.ok
          ? `Scale preview: ${formatScale(mm / checked.nativePx)} — uniform over the whole photo, identical at any zoom. Front-on assumption; pending review, never production approval.`
          : `Scale preview unavailable: ${checked.error}`;
      } else if (spanA === null || spanB === null) {
        preview.textContent = 'Scale preview: click point A, then point B, on the known length in the photo.';
      } else {
        preview.textContent = 'Scale preview: enter the real length in millimetres (e.g. 1300) once A and B are placed.';
      }
    }
  }

  function paintSpanButtons(): void {
    const create = host.querySelector<HTMLButtonElement>('[data-guided="span-create"]');
    if (create) {
      create.disabled = spanPending || spanA === null || spanB === null;
      create.textContent = spanPending ? 'Creating…' : 'Create calibration';
    }
    const undo = host.querySelector<HTMLButtonElement>('[data-guided="span-undo"]');
    if (undo) undo.disabled = spanPending || (spanA === null && spanB === null);
    const clear = host.querySelector<HTMLButtonElement>('[data-guided="span-clear"]');
    if (clear) clear.disabled = spanPending || (spanA === null && spanB === null);
  }

  function clearSpanPoints(message: string): void {
    spanA = null;
    spanB = null;
    paintSpan();
    paintSpanButtons();
    setStatus(message);
  }

  async function onSpanCreate(): Promise<void> {
    if (spanPending || destroyed || !request || !natural) return;
    const active = request;
    const mm = readSpanMm();
    const checked = validateImageSpan(
      spanA ? toSpanUv(spanA) : null,
      spanB ? toSpanUv(spanB) : null,
      mm,
      { widthPx: natural.width, heightPx: natural.height },
    );
    if (!checked.ok) {
      setStatus(checked.error);
      return;
    }
    const fitted = fitScaleFromReferences([checked.span]);
    if (!fitted.ok) {
      setStatus(fitted.error);
      return;
    }
    const scaleMmPerPx = fitted.mmPerUnit;
    if (!callbacks.onSpanCommit) {
      setStatus(
        `Not committed: the span is valid (${mm} mm over ${Math.round(checked.nativePx)} photo pixels ≈ ${formatScale(scaleMmPerPx)}, uniform, front-on assumption, pending review — never production approval), ` +
        'but station span calibration is not wired yet, so nothing was saved. Use the Advanced rectangle below to commit, or wait for wiring. Points A/B and the length are intact.',
      );
      return;
    }
    spanPending = true;
    paintSpanButtons();
    setStatus('Creating the calibration…');
    let outcome: GuidedScaleOutcome;
    try {
      outcome = await callbacks.onSpanCommit(active, {
        aUv: toSpanUv(spanA!),
        bUv: toSpanUv(spanB!),
        lengthMm: mm,
      });
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    spanPending = false;
    if (destroyed) return;
    paintSpanButtons();
    if (outcome.ok) {
      clearSpanPoints('Calibration created from the reference span (pending review — never production approval). Dependent safe areas restart from the saved setup.');
      return;
    }
    const reason = outcome.error.replace(/\.+$/, '');
    setStatus(`Not created: ${reason}. Points A/B and the length are intact — fix the values and try again.`);
  }

  async function onCreate(): Promise<void> {
    if (pending || destroyed || !request) return;
    const active = request;
    const form = readForm();
    const built = guidedCorrespondences(
      corners.map((corner) => {
        if (!natural) return { u: NaN, v: NaN };
        return { u: corner.x / natural.width, v: corner.y / natural.height };
      }),
      form.widthMm,
      form.heightMm,
      form.orientation,
    );
    if (!built.ok) {
      setStatus(built.error);
      return;
    }
    pending = true;
    paintButtons();
    setStatus('Creating the measured area…');
    let outcome: GuidedScaleOutcome;
    try {
      outcome = await callbacks.onCommit(active, {
        cornersUv: built.pairs.map((pair) => ({ ...pair.uv })),
        widthMm: form.widthMm,
        heightMm: form.heightMm,
        orientation: form.orientation,
      });
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    pending = false;
    if (destroyed) return;
    paintButtons();
    if (outcome.ok) {
      corners = [];
      paintMarkers();
      return;
    }
    const reason = outcome.error.replace(/\.+$/, '');
    setStatus(`Not created: ${reason}. Your corners are intact — fix the values and try again.`);
  }

  function paintButtons(): void {
    const create = host.querySelector<HTMLButtonElement>('[data-guided="create"]');
    if (create) {
      create.disabled = pending || corners.length !== 4;
      create.textContent = pending ? 'Creating…' : 'Create measured area';
    }
    const undo = host.querySelector<HTMLButtonElement>('[data-guided="undo"]');
    if (undo) undo.disabled = pending || corners.length === 0;
    const clear = host.querySelector<HTMLButtonElement>('[data-guided="clear"]');
    if (clear) clear.disabled = pending || corners.length === 0;
  }

  function renderSpanViewbar(section: HTMLElement, figure: HTMLElement): void {
    // Same view controls as the calibrated editing stage (same selectors so
    // lead CSS/mount works; same 50–400% + Fit steps; 100% = fitted photo).
    // Display-only: zoom never touches UV math or mm; Anchors hides A/B +
    // line + label without deleting them; Safe areas is harmless here (no
    // areas on this panel yet); Product hides only the photo.
    const bar = document.createElement('div');
    bar.className = 'guided-scale-viewbar';
    bar.setAttribute('data-ps-viewbar', '');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Span stage view controls');
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'btn-secondary';
    zoomOut.textContent = '−';
    zoomOut.setAttribute('aria-label', 'Zoom out');
    zoomOut.setAttribute('data-ps-view', 'zoom-out');
    zoomOut.addEventListener('click', () => {
      spanZoom = stepZoomPercentage(spanZoom, -1);
      applySpanZoom();
      paintSpanView();
    });
    const zoomSelect = document.createElement('select');
    zoomSelect.setAttribute('aria-label', 'Zoom percentage (100% is the fitted photo view)');
    zoomSelect.setAttribute('data-ps-view', 'zoom');
    for (const step of PRODUCT_SETUP_ZOOM_STEPS) {
      const option = document.createElement('option');
      option.value = String(step);
      option.textContent = `${step}%`;
      zoomSelect.append(option);
    }
    zoomSelect.addEventListener('change', () => {
      spanZoom = clampZoomPercentage(Number(zoomSelect.value));
      applySpanZoom();
      paintSpanView();
    });
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'btn-secondary';
    zoomIn.textContent = '+';
    zoomIn.setAttribute('aria-label', 'Zoom in');
    zoomIn.setAttribute('data-ps-view', 'zoom-in');
    zoomIn.addEventListener('click', () => {
      spanZoom = stepZoomPercentage(spanZoom, 1);
      applySpanZoom();
      paintSpanView();
    });
    const zoomFit = document.createElement('button');
    zoomFit.type = 'button';
    zoomFit.className = 'btn-secondary';
    zoomFit.textContent = 'Fit';
    zoomFit.setAttribute('aria-label', 'Fit the photo view (100%)');
    zoomFit.setAttribute('data-ps-view', 'fit');
    zoomFit.addEventListener('click', () => {
      spanZoom = 100;
      applySpanZoom();
      paintSpanView();
    });
    bar.append(zoomOut, zoomSelect, zoomIn, zoomFit);
    const visToggle = (
      label: string,
      view: 'vis-anchors' | 'vis-areas' | 'vis-product',
      pressed: () => boolean,
      onFlip: () => void,
    ): void => {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn-secondary';
      toggle.textContent = label;
      toggle.setAttribute('aria-pressed', pressed() ? 'true' : 'false');
      toggle.setAttribute('data-ps-view', view);
      toggle.addEventListener('click', () => {
        onFlip();
        toggle.setAttribute('aria-pressed', pressed() ? 'true' : 'false');
      });
      bar.append(toggle);
    };
    visToggle('Anchors', 'vis-anchors', () => spanShowAnchors, () => {
      spanShowAnchors = !spanShowAnchors;
      paintSpan();
      setStatus(spanShowAnchors
        ? 'Span overlay shown; nothing was changed.'
        : 'Span overlay hidden; points A/B and the length are kept, only the display changed.');
    });
    visToggle('Safe areas', 'vis-areas', () => spanShowAreas, () => {
      spanShowAreas = !spanShowAreas;
      setStatus(spanShowAreas
        ? 'Safe-areas layer shown; this panel stages no safe areas yet.'
        : 'Safe-areas layer hidden; this panel stages no safe areas yet.');
    });
    visToggle('Product', 'vis-product', () => spanShowProduct, () => {
      spanShowProduct = !spanShowProduct;
      applySpanProduct();
      setStatus(spanShowProduct
        ? 'Product photo shown; nothing was changed.'
        : 'Product photo hidden; the span overlay remains, only the display changed.');
    });
    section.insertBefore(bar, figure);
  }

  function renderSpanSection(parent: HTMLElement, active: GuidedScaleRequest): void {
    const section = document.createElement('section');
    section.className = 'guided-scale-span';
    const heading = document.createElement('h5');
    heading.className = 'guided-scale-subtitle';
    heading.textContent = 'Reference length (uniform scale)';
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent =
      'Click point A, then point B, on a length you can measure on the actual photo (for example a chest width), then enter its real length. ' +
      'The line between A and B plus the entered length stay visible; one uniform scale covers the whole photo.';
    const figure = document.createElement('figure');
    figure.className = 'guided-scale-figure';
    const stage = document.createElement('div');
    stage.className = 'guided-scale-stage';
    const img = document.createElement('img');
    img.className = 'guided-scale-photo';
    const fallbackLabel = active.scope.viewLabel?.trim() || sideLabel(active.scope.side);
    img.alt = active.photo.label || `${fallbackLabel} product photo for measuring`;
    img.draggable = false;
    const media = guessMediaType(active.photo.bytes);
    if (media !== '') {
      let binary = '';
      const bytes = active.photo.bytes;
      const chunk = 8192;
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
      }
      img.src = `data:${media};base64,${btoa(binary)}`;
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'guided-scale-overlay guided-scale-span-overlay');
    svg.setAttribute('viewBox', `0 0 ${active.photo.widthPx} ${active.photo.heightPx}`);
    svg.setAttribute('role', 'button');
    svg.setAttribute('aria-label', 'Product photo: click point A, then point B, of the known reference length');
    svg.setAttribute('data-guided', 'span-overlay');
    svg.tabIndex = 0;
    const placeAt = (event: MouseEvent): void => {
      if (spanPending) return;
      const uv = photoToUv(event, svg);
      if (!uv) return;
      if (uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1) return;
      const display = toDisplayCoords(uv);
      if (!display) return;
      if (spanA === null) {
        spanA = display;
        setStatus('Point A placed. Click point B (the other end of the known length).');
      } else if (spanB === null) {
        spanB = display;
        setStatus('Points A and B placed. Enter the real length, check the scale preview, then create the calibration.');
      } else {
        spanB = display;
        setStatus('Point B moved. Check the scale preview, then create the calibration.');
      }
      paintSpan();
      paintSpanButtons();
    };
    svg.addEventListener('click', placeAt);
    svg.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && spanA !== null && spanB !== null) {
        event.preventDefault();
        void onSpanCreate();
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && (spanA !== null || spanB !== null)) {
        event.preventDefault();
        if (spanB !== null) {
          spanB = null;
          setStatus('Removed point B. Click point B again.');
        } else {
          spanA = null;
          setStatus('Removed point A. Click point A first.');
        }
        paintSpan();
        paintSpanButtons();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearSpanPoints('Reference points cleared. Click point A first.');
      }
    });
    // Zoom sizing box: at 100% the content fits the stage; when magnified
    // the box scales by percentage so the stage scrolls inside instead of
    // overflowing the page. Display-only: UV math and mm never scale.
    const zoombox = document.createElement('div');
    zoombox.className = 'guided-scale-zoombox';
    zoombox.style.position = 'relative';
    zoombox.append(img, svg);
    stage.append(zoombox);
    figure.append(stage);
    section.append(heading, hint, figure);
    renderSpanViewbar(section, figure);

    const form = document.createElement('div');
    form.className = 'product-setup-list';
    const mmLabel = document.createElement('label');
    mmLabel.className = 'product-setup-field product-setup-number';
    mmLabel.textContent = 'Real length A→B (mm)';
    const mmInput = document.createElement('input');
    mmInput.type = 'number';
    mmInput.min = '0';
    mmInput.step = 'any';
    mmInput.placeholder = 'e.g. 1300';
    mmInput.setAttribute('data-guided', 'span-mm');
    mmInput.setAttribute('aria-label', 'Real length between point A and point B in millimetres');
    mmInput.value = spanMmText;
    mmInput.addEventListener('input', () => {
      spanMmText = mmInput.value;
      paintSpan();
    });
    mmLabel.append(mmInput);
    form.append(mmLabel);
    section.append(form);

    const preview = document.createElement('p');
    preview.className = 'muted';
    preview.setAttribute('data-guided', 'span-scale');
    preview.setAttribute('role', 'status');
    section.append(preview);

    const actions = document.createElement('div');
    actions.className = 'product-setup-actions';
    const undoButton = document.createElement('button');
    undoButton.type = 'button';
    undoButton.className = 'btn-secondary';
    undoButton.setAttribute('data-guided', 'span-undo');
    undoButton.textContent = 'Undo point';
    undoButton.addEventListener('click', () => {
      if (spanPending) return;
      if (spanB !== null) {
        spanB = null;
        setStatus('Removed point B. Click point B again.');
      } else if (spanA !== null) {
        spanA = null;
        setStatus('Removed point A. Click point A first.');
      } else return;
      paintSpan();
      paintSpanButtons();
    });
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'btn-secondary';
    clearButton.setAttribute('data-guided', 'span-clear');
    clearButton.textContent = 'Clear points';
    clearButton.addEventListener('click', () => {
      if (spanPending) return;
      clearSpanPoints('Reference points cleared. Click point A first.');
    });
    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'btn-primary';
    createButton.setAttribute('data-guided', 'span-create');
    createButton.textContent = 'Create calibration';
    createButton.addEventListener('click', () => void onSpanCreate());
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn-secondary';
    cancelButton.setAttribute('data-guided', 'cancel');
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => {
      if (spanPending || pending) return;
      spanA = null;
      spanB = null;
      corners = [];
      callbacks.onCancel();
    });
    actions.append(undoButton, clearButton, createButton, cancelButton);
    section.append(actions);
    parent.append(section);
    // Bounded contain-fit span stage, initialized AFTER mount so the first
    // visible box is already fitted (no detached clientWidth-0 pass, no
    // delayed sizing jump): photo + overlay share one measured box,
    // recomputed on container/viewport change; zoom rescales it.
    observeGuidedFit(stage, zoombox, active.photo.widthPx, active.photo.heightPx, () => spanZoom);
  }

  function render(): void {
    disconnectSpanResize();
    host.replaceChildren();
    if (!request) return;
    const active = request;
    const title = document.createElement('h4');
    title.className = 'guided-scale-title';
    title.textContent = `Measure ${guidedViewTitle(active.scope)}`;
    const intro = document.createElement('p');
    intro.className = 'muted';
    intro.textContent =
      'This Images view has no measured area yet, so positions cannot be stored in millimetres. ' +
      'Measure it with a reference length below — nothing is guessed from the photo itself. ' +
      'The photo must be taken straight-on: a single span sets a uniform scale only and cannot correct perspective or tilt. ' +
      'Every calibration stays pending review and is never production approval. ' +
      'Recalibrating later restarts dependent safe areas from the saved setup instead of reinterpreting them.';
    host.append(title, intro);
    natural = { width: active.photo.widthPx, height: active.photo.heightPx };

    renderSpanSection(host, active);

    const rectSection = document.createElement('section');
    rectSection.className = 'guided-scale-rect';
    const rectHeading = document.createElement('h5');
    rectHeading.className = 'guided-scale-subtitle';
    rectHeading.textContent = 'Advanced: rectangle mapping (affine)';
    const rectNote = document.createElement('p');
    rectNote.className = 'muted';
    rectNote.textContent =
      'For rotated or slightly angled photos: click the 4 corners of a rectangle you can measure (C1 top-left, C2 top-right, C3 bottom-right, C4 bottom-left as seen here), ' +
      'enter its real width and height, and declare which way is up. The existing affine solver fits the full mapping; one length alone is refused, never inferred from pixels. ' +
      'Same pending-review status — never production approval.';
    rectSection.append(rectHeading, rectNote);
    const figure = document.createElement('figure');
    figure.className = 'guided-scale-figure';
    const stage = document.createElement('div');
    stage.className = 'guided-scale-stage';
    const img = document.createElement('img');
    img.className = 'guided-scale-photo';
    const fallbackLabel = active.scope.viewLabel?.trim() || sideLabel(active.scope.side);
    img.alt = active.photo.label || `${fallbackLabel} product photo for measuring`;
    img.draggable = false;
    const media = guessMediaType(active.photo.bytes);
    if (media !== '') {
      let binary = '';
      const bytes = active.photo.bytes;
      const chunk = 8192;
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
      }
      img.src = `data:${media};base64,${btoa(binary)}`;
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'guided-scale-overlay');
    svg.setAttribute('viewBox', `0 0 ${active.photo.widthPx} ${active.photo.heightPx}`);
    svg.setAttribute('role', 'button');
    svg.setAttribute('aria-label', 'Product photo: click to place rectangle corners C1 to C4 in order');
    svg.tabIndex = 0;
    const placeAt = (event: MouseEvent): void => {
      if (pending || corners.length >= 4) return;
      const uv = photoToUv(event, svg);
      if (!uv) return;
      if (uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1) return;
      const display = toDisplayCoords(uv);
      if (!display) return;
      corners = [...corners, display];
      paintMarkers();
      paintButtons();
      setStatus(
        corners.length === 4
          ? 'Four corners placed. Enter width + height, check the orientation, then create the measured area.'
          : `Corner C${corners.length} placed. Click corner C${corners.length + 1} (${corners.length === 1 ? 'top-right' : corners.length === 2 ? 'bottom-right' : 'bottom-left'} as seen here).`,
      );
    };
    svg.addEventListener('click', placeAt);
    svg.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && corners.length === 4) {
        event.preventDefault();
        void onCreate();
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && corners.length > 0) {
        event.preventDefault();
        corners = corners.slice(0, -1);
        paintMarkers();
        paintButtons();
        setStatus(corners.length === 0 ? 'Corners cleared. Click C1 (top-left as seen here).' : `Removed the last corner (${corners.length} placed).`);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        corners = [];
        paintMarkers();
        paintButtons();
        setStatus('Corners cleared. Click C1 (top-left as seen here).');
      }
    });
    // Same bounded contain-fit box as the span stage (photo + overlay share
    // one measured box at Fit; no zoom controls here, always 100%).
    const zoombox = document.createElement('div');
    zoombox.className = 'guided-scale-zoombox';
    zoombox.style.position = 'relative';
    zoombox.append(img, svg);
    stage.append(zoombox);
    figure.append(stage);

    const form = document.createElement('div');
    form.className = 'product-setup-list';
    const widthLabel = document.createElement('label');
    widthLabel.className = 'product-setup-field product-setup-number';
    widthLabel.textContent = 'Rectangle width (mm, C1→C2 edge)';
    const widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.min = '0';
    widthInput.step = 'any';
    widthInput.placeholder = 'e.g. 280';
    widthInput.setAttribute('data-guided', 'width');
    widthInput.setAttribute('aria-label', 'Rectangle width in millimetres, the C1 to C2 edge');
    widthLabel.append(widthInput);
    const heightLabel = document.createElement('label');
    heightLabel.className = 'product-setup-field product-setup-number';
    heightLabel.textContent = 'Rectangle height (mm, C2→C3 edge)';
    const heightInput = document.createElement('input');
    heightInput.type = 'number';
    heightInput.min = '0';
    heightInput.step = 'any';
    heightInput.placeholder = 'e.g. 200';
    heightInput.setAttribute('data-guided', 'height');
    heightInput.setAttribute('aria-label', 'Rectangle height in millimetres, the C2 to C3 edge');
    heightLabel.append(heightInput);
    const orientationLabel = document.createElement('label');
    orientationLabel.className = 'product-setup-field';
    orientationLabel.textContent = 'Orientation';
    const orientationSelect = document.createElement('select');
    orientationSelect.setAttribute('data-guided', 'orientation');
    orientationSelect.setAttribute('aria-label', 'Which photo edge is the top of the measured area');
    for (const [value, label] of [
      ['photo-up', 'Photo top is the TOP of the area'],
      ['photo-down', 'Photo top is the BOTTOM (photo is upside-down)'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      orientationSelect.append(option);
    }
    orientationLabel.append(orientationSelect);
    form.append(widthLabel, heightLabel, orientationLabel);

    const actions = document.createElement('div');
    actions.className = 'product-setup-actions';
    const undoButton = document.createElement('button');
    undoButton.type = 'button';
    undoButton.className = 'btn-secondary';
    undoButton.setAttribute('data-guided', 'undo');
    undoButton.textContent = 'Undo corner';
    undoButton.addEventListener('click', () => {
      if (pending || corners.length === 0) return;
      corners = corners.slice(0, -1);
      paintMarkers();
      paintButtons();
      setStatus(corners.length === 0 ? 'Corners cleared. Click C1 (top-left as seen here).' : `Removed the last corner (${corners.length} placed).`);
    });
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'btn-secondary';
    clearButton.setAttribute('data-guided', 'clear');
    clearButton.textContent = 'Clear corners';
    clearButton.addEventListener('click', () => {
      if (pending) return;
      corners = [];
      paintMarkers();
      paintButtons();
      setStatus('Corners cleared. Click C1 (top-left as seen here).');
    });
    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'btn-primary';
    createButton.setAttribute('data-guided', 'create');
    createButton.textContent = 'Create measured area';
    createButton.addEventListener('click', () => void onCreate());
    actions.append(undoButton, clearButton, createButton);
    rectSection.append(figure, form, actions);

    const status = document.createElement('p');
    status.className = 'muted product-setup-status';
    status.setAttribute('data-guided', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Click point A on the known length first. Advanced rectangle: click C1 (top-left as seen in its photo); both width and height are required — one length cannot determine the affine mapping.';

    host.append(rectSection, status);
    // Same contain-fit init AFTER mount for the rectangle stage (fixed 100%,
    // no zoom controls): first visible box already fitted, observer retained
    // for later viewport changes.
    observeGuidedFit(stage, zoombox, active.photo.widthPx, active.photo.heightPx, () => 100);
    paintSpan();
    paintSpanButtons();
    paintMarkers();
    paintButtons();
    observeSpanOverlay();
    applySpanZoom();
    applySpanProduct();
    paintSpanView();
  }

  return {
    show(next: GuidedScaleRequest): void {
      if (destroyed) return;
      request = next;
      corners = [];
      pending = false;
      spanA = null;
      spanB = null;
      spanPending = false;
      spanZoom = 100;
      spanShowAnchors = true;
      spanShowAreas = true;
      spanShowProduct = true;
      spanMmText = '';
      natural = { width: next.photo.widthPx, height: next.photo.heightPx };
      host.hidden = false;
      render();
    },
    hide(): void {
      request = null;
      corners = [];
      pending = false;
      spanA = null;
      spanB = null;
      spanPending = false;
      disconnectSpanResize();
      host.replaceChildren();
      host.hidden = true;
    },
    refresh(): void {
      if (destroyed || !request) return;
      render();
    },
    destroy(): void {
      destroyed = true;
      request = null;
      disconnectSpanResize();
      host.replaceChildren();
    },
  };
}
