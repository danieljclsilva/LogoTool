/// <reference lib="dom" />
/**
 * Visual anchor + safe-area setup (one-time product setup, reusable).
 *
 * Small setup mode for the internal builder's review/prepare flow. The
 * operator picks a mapped product photo and a region, then clicks the
 * PRODUCT PHOTO to create named anchors: the click is inverse-mapped
 * through the caller-evaluated photo-mapping affine into region-local
 * millimetres (never guessed from photo bounds). Anchors drag with the
 * pointer, move with the keyboard, and can be removed; numeric advanced
 * inputs stay available but pointer actions are real.
 *
 * Safe-area polygon vertices render as a reference overlay with the same
 * drag/keyboard/remove handling, but edits stage a *proposal note* only:
 * the issued product is never mutated here. Applying a safe-area change
 * stays on the existing validated prepared-product import path.
 *
 * Pointer drags (vertices and anchor markers) paint directly on every
 * pointermove — attribute/geometry updates only, no re-render — and commit
 * exactly once on pointerup. Escape or pointercancel aborts the drag with
 * no commit.
 *
 * Editing overlays in this module never reach the final operation sheet:
 * the sheet carries only named anchors (via the dimension chooser) and the
 * measured arrows the renderer draws per Worker B's API.
 *
 * Pure UI state in, caller-owned state out: this module never reads files,
 * never fetches, and never persists (no browser storage of customer data).
 */

import {
  forwardPhotoMapping,
  inversePhotoMapping,
} from '../customer-editor/presentation-photo-mapping.js';
import type {
  PhotoMappingTransform,
  PhotoMappingView,
} from '../customer-editor/presentation-photo-mapping.js';
import { bytesToDataUrl } from '../shared/operation-document/index.js';
import type { AnchorDef } from '../../core/operation-measurements/types.js';

export interface AnchorSetupScope {
  productId: string;
  variantId: string;
  regionId: string;
  frameId: string;
  calibrationId: string;
  calibrationVersion: string;
  regionName: string | null;
}

export interface AnchorSetupPhoto {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  label: string;
}

export interface AnchorSetupMm {
  x: number;
  y: number;
}

/** Live inputs for one setup session. The caller owns every value. */
export interface AnchorSetupInput {
  /** Mapped product photo (header-validated raster bytes + pixel size). */
  photo: AnchorSetupPhoto;
  /** Caller-evaluated mapping for this exact photo (region mm -> UV). */
  transform: PhotoMappingTransform;
  mappingStatus: 'provisional' | 'review';
  /** Declared preview side of the photo. */
  view: PhotoMappingView;
  /** Current region scope for new anchors + safe-area reference. */
  scope: AnchorSetupScope;
  /** Original region safe-area polygon, region-local millimetres. */
  safeArea: ReadonlyArray<AnchorSetupMm>;
  /** Anchors already authored for this scope (other scopes untouched). */
  anchors: readonly AnchorDef[];
  /** Staged safe-area edits, or null when unmodified. */
  stagedSafeArea: ReadonlyArray<AnchorSetupMm> | null;
}

export interface AnchorSetupCallbacks {
  /** Scope anchors after any anchor add/move/rename/remove. */
  onAnchorsChange(anchors: AnchorDef[]): void;
  /** Safe-area proposal after any vertex move/remove/reset (null = clean). */
  onSafeAreaProposal(staged: AnchorSetupMm[] | null, note: string | null): void;
  /** Human status line for the caller to display. */
  onStatus(message: string): void;
}

export interface AnchorSetupHandle {
  /** Re-render from the latest caller state (sheet/side/region change). */
  refresh(): void;
  /** Remove all listeners created by this setup. */
  destroy(): void;
}

function isFiniteMm(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function displayMm1(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(Math.round(value * 10) / 10).toFixed(1)}`;
}

// ---- Pure safe-area geometry (DOM-free; unit-tested without a browser). ----

/** Outcome of validating a candidate safe-area polygon (region-frame mm). */
export type SafeAreaValidation =
  | { ok: true; reason: null }
  | { ok: false; reason: string };

/** Signed polygon area via the shoelace sum, in square millimetres. */
export function polygonSignedAreaMm(points: ReadonlyArray<AnchorSetupMm>): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function orientationMm(a: AnchorSetupMm, b: AnchorSetupMm, c: AnchorSetupMm): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegmentMm(a: AnchorSetupMm, b: AnchorSetupMm, c: AnchorSetupMm): boolean {
  return (
    Math.min(a.x, c.x) <= b.x && b.x <= Math.max(a.x, c.x) &&
    Math.min(a.y, c.y) <= b.y && b.y <= Math.max(a.y, c.y)
  );
}

/** True when the closed segments p1–p2 and p3–p4 touch or cross. */
export function segmentsIntersectMm(
  p1: AnchorSetupMm,
  p2: AnchorSetupMm,
  p3: AnchorSetupMm,
  p4: AnchorSetupMm,
): boolean {
  const d1 = orientationMm(p3, p4, p1);
  const d2 = orientationMm(p3, p4, p2);
  const d3 = orientationMm(p1, p2, p3);
  const d4 = orientationMm(p1, p2, p4);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  if (d1 === 0 && onSegmentMm(p3, p1, p4)) return true;
  if (d2 === 0 && onSegmentMm(p3, p2, p4)) return true;
  if (d3 === 0 && onSegmentMm(p1, p3, p2)) return true;
  if (d4 === 0 && onSegmentMm(p1, p4, p2)) return true;
  return false;
}

/** True when any two non-adjacent polygon edges touch or cross. */
export function polygonIsSelfIntersecting(points: ReadonlyArray<AnchorSetupMm>): boolean {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    const a1 = points[i]!;
    const a2 = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j += 1) {
      if (j === i + 1) continue;
      if (i === 0 && j === n - 1) continue;
      const b1 = points[j]!;
      const b2 = points[(j + 1) % n]!;
      if (segmentsIntersectMm(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * Validate a candidate safe-area polygon. Refuses degenerate (<3 or
 * coincident corners), non-finite, zero-area and self-intersecting
 * polygons with a concise actionable reason; never throws.
 */
export function validateSafeAreaPolygon(
  points: ReadonlyArray<AnchorSetupMm>,
): SafeAreaValidation {
  if (points.length < 3) {
    return { ok: false, reason: 'at least 3 finite corners are required (click the photo to add more corners).' };
  }
  for (let i = 0; i < points.length; i += 1) {
    const corner = points[i]!;
    if (!isFiniteMm(corner.x) || !isFiniteMm(corner.y)) {
      return { ok: false, reason: `corner ${i + 1} is not a finite millimetre position (move it onto the mapped photo).` };
    }
  }
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) <= 1e-9) {
      const next = ((i + 1) % points.length) + 1;
      return { ok: false, reason: `corners ${i + 1} and ${next} coincide (move or remove one).` };
    }
  }
  if (Math.abs(polygonSignedAreaMm(points)) <= 1e-9) {
    return { ok: false, reason: 'the polygon has zero area — corners must span a real area (move a corner).' };
  }
  if (polygonIsSelfIntersecting(points)) {
    return { ok: false, reason: 'polygon edges cross — move a corner so no edges cross.' };
  }
  return { ok: true, reason: null };
}

/**
 * Close/finish rule for an in-progress drawing: finishing is offered once
 * at least 3 finite corners exist. Full geometry (area, crossings) is
 * validated on commit by {@link validateSafeAreaPolygon}.
 */
export function canCloseDrawnPolygon(
  corners: ReadonlyArray<AnchorSetupMm>,
): SafeAreaValidation {
  if (corners.length < 3) {
    const missing = 3 - corners.length;
    return {
      ok: false,
      reason: `add at least ${missing} more corner${missing === 1 ? '' : 's'} before finishing (Enter closes with 3 or more).`,
    };
  }
  for (let i = 0; i < corners.length; i += 1) {
    const corner = corners[i]!;
    if (!isFiniteMm(corner.x) || !isFiniteMm(corner.y)) {
      return { ok: false, reason: `corner ${i + 1} is not finite (re-place it before finishing).` };
    }
  }
  return { ok: true, reason: null };
}

let anchorCounter = 0;

function newAnchorId(): string {
  anchorCounter += 1;
  let suffix = `${anchorCounter}`;
  try {
    const bytes = new Uint8Array(2);
    globalThis.crypto?.getRandomValues?.(bytes);
    suffix = `${anchorCounter}-${bytes[0]!.toString(16).padStart(2, '0')}${bytes[1]!.toString(16).padStart(2, '0')}`;
  } catch {
    suffix = `${anchorCounter}-${Math.floor(Math.random() * 65536).toString(16)}`;
  }
  return `anchor-${suffix}`;
}

/**
 * Render the visual setup into `container`, replacing its contents.
 * The caller re-renders the sheet preview from `onAnchorsChange`.
 */
export function createAnchorSetup(
  container: HTMLElement,
  getInput: () => AnchorSetupInput | { error: string },
  callbacks: AnchorSetupCallbacks,
): AnchorSetupHandle {
  let destroyed = false;
  let dragAnchor: string | null = null;
  let dragVertex: number | null = null;
  /** Region-mm under the pointer for the in-flight anchor drag (commit on release). */
  let pendingAnchorMm: AnchorSetupMm | null = null;
  /** Working copy of the polygon for the in-flight vertex drag (commit on release). */
  let pendingVertexBase: AnchorSetupMm[] | null = null;
  /** Live vertex handle for direct position updates during a drag. */
  let pendingVertexHandle: SVGCircleElement | null = null;
  /**
   * Active fresh-polygon drawing (region-frame mm corners), or null when no
   * drawing is in flight. Survives refresh() so each click repaints; dropped
   * when the scope changes, cancelled by Escape, committed by Finish/Enter/
   * first-handle-click/double-click. Never commits invalid geometry.
   */
  let drawCorners: AnchorSetupMm[] | null = null;
  let drawScopeKey: string | null = null;

  /** Escape aborts any in-flight drag with no commit (handlers re-render). */
  const cancelDragOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || destroyed) return;
    if (dragAnchor === null && dragVertex === null) {
      const target = event.target;
      const editable = target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (drawCorners !== null && !editable) {
        drawCorners = null;
        drawScopeKey = null;
        refresh();
      }
      return;
    }
    dragAnchor = null;
    dragVertex = null;
    pendingAnchorMm = null;
    pendingVertexBase = null;
    pendingVertexHandle = null;
    refresh();
  };
  document.addEventListener('keydown', cancelDragOnEscape);

  function scopeKeyOf(scope: AnchorSetupScope): string {
    return `${scope.productId} ${scope.variantId} ${scope.regionId}`;
  }

  function mappingEntryFor(input: AnchorSetupInput): Parameters<typeof inversePhotoMapping>[0] {
    return {
      productId: input.scope.productId,
      variantId: input.scope.variantId,
      regionId: input.scope.regionId,
      view: input.view,
      image: '',
      transform: { ...input.transform },
      calibrationId: input.scope.calibrationId,
      calibrationVersion: input.scope.calibrationVersion,
      status: input.mappingStatus,
    };
  }

  function photoToMm(
    input: AnchorSetupInput,
    px: number,
    py: number,
  ): AnchorSetupMm | null {
    const uv = { u: px / input.photo.widthPx, v: py / input.photo.heightPx };
    const mm = inversePhotoMapping(mappingEntryFor(input), uv);
    if (!mm || !isFiniteMm(mm.xMm) || !isFiniteMm(mm.yMm)) return null;
    return { x: mm.xMm, y: mm.yMm };
  }

  function mmToPhoto(
    input: AnchorSetupInput,
    mm: AnchorSetupMm,
  ): { x: number; y: number } | null {
    const uv = forwardPhotoMapping(mappingEntryFor(input), { xMm: mm.x, yMm: mm.y });
    if (!uv) return null;
    return { x: uv.u * input.photo.widthPx, y: uv.v * input.photo.heightPx };
  }

  function validateAnchorName(name: string, anchors: readonly AnchorDef[], selfId: string): string | null {
    const trimmed = name.trim();
    if (trimmed.length === 0) return 'Anchor name must not be empty.';
    if (trimmed.length > 80) return 'Anchor name must be 80 characters or fewer.';
    if (anchors.some((entry) => entry.id !== selfId && entry.name === trimmed)) {
      return `Another anchor is already called “${trimmed}”.`;
    }
    return null;
  }

  function commitAnchors(input: AnchorSetupInput, next: AnchorDef[]): void {
    for (const anchor of next) {
      if (anchor.id.trim().length === 0 || anchor.name.trim().length === 0) {
        callbacks.onStatus('Anchor not saved: names must not be empty.');
        return;
      }
      if (!Array.isArray(anchor.posMm) || !isFiniteMm(anchor.posMm[0]) || !isFiniteMm(anchor.posMm[1])) {
        callbacks.onStatus(`Anchor “${anchor.name}” not saved: position must be finite millimetres.`);
        return;
      }
    }
    callbacks.onAnchorsChange(next);
  }

  function proposeSafeArea(
    input: AnchorSetupInput,
    staged: AnchorSetupMm[] | null,
  ): void {
    if (staged === null) {
      callbacks.onSafeAreaProposal(null, null);
      return;
    }
    const check = validateSafeAreaPolygon(staged);
    if (!check.ok) {
      callbacks.onStatus(`Safe-area proposal refused: ${check.reason}`);
      return;
    }
    const corners = staged.map((point) => `(${displayMm1(point.x)}, ${displayMm1(point.y)})`).join(', ');
    const note =
      `Proposed safe-area edit for region “${input.scope.regionName ?? input.scope.regionId}” ` +
      `(${staged.length} corners, staged in the editor, not applied): ${corners} mm. ` +
      `Apply it from Prepare → Choose items → “Anchor + safe-area setup (product preparation)”; the issued product is unchanged.`;
    callbacks.onSafeAreaProposal(staged, note);
  }

  function eventPhotoPoint(svg: SVGSVGElement, event: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const width = viewBox && viewBox.width > 0 ? viewBox.width : rect.width;
    const height = viewBox && viewBox.height > 0 ? viewBox.height : rect.height;
    return {
      x: (event.clientX - rect.left) * (width / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (height / Math.max(1, rect.height)),
    };
  }

  function setStatusElement(box: HTMLElement, message: string): void {
    box.textContent = message;
  }

  function refresh(): void {
    if (destroyed) return;
    const active = document.activeElement;
    const focusKey = active instanceof Element ? active.getAttribute('data-fkey') : null;
    dragAnchor = null;
    dragVertex = null;
    pendingAnchorMm = null;
    pendingVertexBase = null;
    pendingVertexHandle = null;
    container.replaceChildren();
    const resolved = getInput();
    if (!('photo' in resolved)) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = resolved.error;
      container.append(note);
      return;
    }
    const input = resolved;
    const inputScopeKey = scopeKeyOf(input.scope);
    if (drawCorners !== null && drawScopeKey !== inputScopeKey) {
      drawCorners = null;
      drawScopeKey = null;
    }
    const drawing = drawCorners !== null;

    const statusBox = document.createElement('p');
    statusBox.className = 'muted';
    statusBox.setAttribute('role', 'status');
    const paintPageStatus = (message: string): void => {
      setStatusElement(statusBox, message);
      callbacks.onStatus(message);
    };

    const figure = document.createElement('figure');
    figure.className = 'anchor-setup-figure';
    const caption = document.createElement('figcaption');
    caption.className = 'muted';
    caption.textContent =
      `${input.photo.label} — click the photo to place a named anchor ` +
      `(inverse-mapped to region “${input.scope.regionName ?? input.scope.regionId}” millimetres, ` +
      `mapping ${input.mappingStatus}). Photo clicks never measure from pixels; ` +
      `millimetres come only from the evaluated mapping.`;
    figure.append(caption);

    const stage = document.createElement('div');
    stage.className = 'anchor-setup-stage';
    const image = document.createElement('img');
    image.className = 'anchor-setup-photo';
    const headerUrl = bytesToDataUrl(input.photo.bytes, guessMediaType(input.photo.bytes));
    if (headerUrl) {
      image.src = headerUrl;
      image.alt = `${input.photo.label} (anchor setup reference)`;
      image.draggable = false;
      stage.append(image);
    } else {
      const missing = document.createElement('p');
      missing.className = 'muted';
      missing.textContent = 'Photo bytes are missing or undecodable; anchors can still be entered numerically below.';
      stage.append(missing);
    }

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg') as SVGSVGElement;
    svg.setAttribute('viewBox', `0 0 ${input.photo.widthPx} ${input.photo.heightPx}`);
    svg.setAttribute('class', 'anchor-setup-overlay');
    svg.setAttribute('role', 'group');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('data-fkey', `anchor-setup-stage-${input.scope.regionId}`);
    svg.setAttribute('aria-label', `Anchor setup overlay for region ${input.scope.regionName ?? input.scope.regionId}`);
    svg.addEventListener('keydown', (event) => {
      if (drawCorners === null) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        finishDrawing(input, paintPageStatus, refresh);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        drawCorners = null;
        drawScopeKey = null;
        paintPageStatus('Drawing cancelled; nothing was committed.');
        refresh();
      }
    });
    stage.append(svg);
    figure.append(stage);
    container.append(figure, statusBox);

    const safePolygon = document.createElementNS(svgNS, 'polygon');
    safePolygon.setAttribute('class', 'anchor-setup-safe');
    svg.append(safePolygon);

    const paintSafe = (points: ReadonlyArray<AnchorSetupMm>): void => {
      const mapped: string[] = [];
      for (const point of points) {
        const px = mmToPhoto(input, point);
        if (!px) return;
        mapped.push(`${px.x},${px.y}`);
      }
      safePolygon.setAttribute('points', mapped.join(' '));
    };
    paintSafe(input.stagedSafeArea ?? input.safeArea);

    // Vertex handles for the staged (or original) safe-area polygon.
    const vertexLayer = document.createElementNS(svgNS, 'g');
    vertexLayer.setAttribute('class', 'anchor-setup-vertices');
    svg.append(vertexLayer);

    const stagedOrOriginal = input.stagedSafeArea ?? input.safeArea;
    const paintVertices = (): void => {
      vertexLayer.replaceChildren();
      const points = input.stagedSafeArea ?? input.safeArea;
      points.forEach((point, index) => {
        const px = mmToPhoto(input, point);
        if (!px) return;
        const handle = document.createElementNS(svgNS, 'circle');
        handle.setAttribute('class', 'anchor-setup-vertex');
        handle.setAttribute('cx', String(px.x));
        handle.setAttribute('cy', String(px.y));
        handle.setAttribute('r', '7');
        handle.setAttribute('tabindex', '0');
        handle.setAttribute('role', 'button');
        handle.setAttribute('data-fkey', `vertex-${input.scope.regionId}-${index}`);
        handle.setAttribute(
          'aria-label',
          `Safe-area corner ${index + 1} at ${displayMm1(point.x)}, ${displayMm1(point.y)} millimetres. Arrow keys move, Delete removes.`,
        );
        handle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          dragVertex = index;
          pendingVertexBase = null;
          pendingVertexHandle = handle as SVGCircleElement;
          (handle as SVGCircleElement).setPointerCapture?.(event.pointerId);
        });
        handle.addEventListener('keydown', (event) => {
          const step = event.shiftKey ? 10 : 1;
          let dx = 0;
          let dy = 0;
          if (event.key === 'ArrowLeft') dx = -step;
          else if (event.key === 'ArrowRight') dx = step;
          else if (event.key === 'ArrowUp') dy = step;
          else if (event.key === 'ArrowDown') dy = -step;
          else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            removeVertex(input, index, paintPageStatus, refresh);
            return;
          } else return;
          event.preventDefault();
          moveVertex(input, index, dx, dy, paintPageStatus, refresh);
        });
        vertexLayer.append(handle);
      });
    };
    paintVertices();

    if (drawing) {
      // In-progress fresh polygon: open polyline plus one handle per draft
      // corner. The first corner doubles as the close/finish handle.
      const draft = drawCorners ?? [];
      const draftLayer = document.createElementNS(svgNS, 'g');
      draftLayer.setAttribute('class', 'anchor-setup-drawing');
      svg.append(draftLayer);
      const line = document.createElementNS(svgNS, 'polyline');
      line.setAttribute('class', 'anchor-setup-draft');
      const linePts: string[] = [];
      for (const corner of draft) {
        const px = mmToPhoto(input, corner);
        if (!px) continue;
        linePts.push(`${px.x},${px.y}`);
      }
      if (draft.length >= 3 && linePts.length === draft.length && linePts[0] !== undefined) {
        linePts.push(linePts[0]);
      }
      line.setAttribute('points', linePts.join(' '));
      draftLayer.append(line);
      draft.forEach((corner, index) => {
        const px = mmToPhoto(input, corner);
        if (!px) return;
        const handle = document.createElementNS(svgNS, 'circle');
        handle.setAttribute('class', index === 0 ? 'anchor-setup-draw anchor-setup-draw-first' : 'anchor-setup-draw');
        handle.setAttribute('cx', String(px.x));
        handle.setAttribute('cy', String(px.y));
        handle.setAttribute('r', index === 0 ? '10' : '7');
        handle.setAttribute('tabindex', '0');
        handle.setAttribute('role', 'button');
        handle.setAttribute('data-fkey', `draw-corner-${input.scope.regionId}-${index}`);
        handle.setAttribute(
          'aria-label',
          index === 0
            ? `First draft corner at ${displayMm1(corner.x)}, ${displayMm1(corner.y)} millimetres. Activate to finish the safe area.`
            : `Draft corner ${index + 1} at ${displayMm1(corner.x)}, ${displayMm1(corner.y)} millimetres.`,
        );
        handle.addEventListener('click', (event) => {
          event.stopPropagation();
          if (index === 0) finishDrawing(input, paintPageStatus, refresh);
        });
        handle.addEventListener('keydown', (event) => {
          if ((event.key === 'Enter' || event.key === ' ') && index === 0) {
            event.preventDefault();
            finishDrawing(input, paintPageStatus, refresh);
          }
        });
        draftLayer.append(handle);
      });
    } else if (stagedOrOriginal.length >= 3) {
      // Edge-midpoint handles insert a corner into the staged polygon with
      // one click/Enter (a proposal only — the approved product is unchanged).
      const midLayer = document.createElementNS(svgNS, 'g');
      midLayer.setAttribute('class', 'anchor-setup-midpoints');
      svg.append(midLayer);
      stagedOrOriginal.forEach((point, index) => {
        const next = stagedOrOriginal[(index + 1) % stagedOrOriginal.length]!;
        const mid: AnchorSetupMm = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
        const px = mmToPhoto(input, mid);
        if (!px) return;
        const plus = document.createElementNS(svgNS, 'circle');
        plus.setAttribute('class', 'anchor-setup-midpoint');
        plus.setAttribute('cx', String(px.x));
        plus.setAttribute('cy', String(px.y));
        plus.setAttribute('r', '5');
        plus.setAttribute('tabindex', '0');
        plus.setAttribute('role', 'button');
        plus.setAttribute('data-fkey', `vertex-insert-${input.scope.regionId}-${index}`);
        plus.setAttribute(
          'aria-label',
          `Insert a safe-area corner on edge ${index + 1} (stages a proposal).`,
        );
        const insert = (): void => {
          insertVertex(input, index, mid, paintPageStatus, refresh);
        };
        plus.addEventListener('click', (event) => {
          event.stopPropagation();
          insert();
        });
        plus.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            insert();
          }
        });
        midLayer.append(plus);
      });
    }

    // Anchor markers (id -> live elements for drag painting).
    const anchorLayer = document.createElementNS(svgNS, 'g');
    anchorLayer.setAttribute('class', 'anchor-setup-anchors');
    svg.append(anchorLayer);
    const markerById = new Map<string, { dot: SVGCircleElement; tag: SVGTextElement; marker: SVGGElement }>();

    const paintAnchors = (): void => {
      anchorLayer.replaceChildren();
      markerById.clear();
      input.anchors.forEach((anchor) => {
        const px = mmToPhoto(input, { x: anchor.posMm[0]!, y: anchor.posMm[1]! });
        if (!px) return;
        const marker = document.createElementNS(svgNS, 'g');
        marker.setAttribute('class', 'anchor-setup-anchor');
        marker.setAttribute('tabindex', '0');
        marker.setAttribute('role', 'button');
        marker.setAttribute('data-fkey', `anchor-marker-${anchor.id}`);
        marker.setAttribute(
          'aria-label',
          `Anchor “${anchor.name}” at ${displayMm1(anchor.posMm[0]!)}, ${displayMm1(anchor.posMm[1]!)} millimetres. Arrow keys move, pointer drags.`,
        );
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', String(px.x));
        dot.setAttribute('cy', String(px.y));
        dot.setAttribute('r', '9');
        dot.setAttribute('class', 'anchor-setup-dot');
        const tag = document.createElementNS(svgNS, 'text');
        tag.setAttribute('x', String(px.x + 12));
        tag.setAttribute('y', String(px.y + 4));
        tag.setAttribute('class', 'anchor-setup-tag');
        tag.textContent = anchor.name;
        marker.append(dot, tag);
        markerById.set(anchor.id, { dot: dot as SVGCircleElement, tag: tag as SVGTextElement, marker: marker as SVGGElement });
        marker.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          dragAnchor = anchor.id;
          (marker as SVGGElement).setPointerCapture?.(event.pointerId);
        });
        marker.addEventListener('keydown', (event) => {
          const step = event.shiftKey ? 10 : 1;
          let dx = 0;
          let dy = 0;
          if (event.key === 'ArrowLeft') dx = -step;
          else if (event.key === 'ArrowRight') dx = step;
          else if (event.key === 'ArrowUp') dy = step;
          else if (event.key === 'ArrowDown') dy = -step;
          else return;
          event.preventDefault();
          const next = input.anchors.map((entry) => (
            entry.id === anchor.id
              ? { ...entry, posMm: [entry.posMm[0]! + dx, entry.posMm[1]! + dy] as [number, number] }
              : entry
          ));
          commitAnchors(input, next);
          refresh();
        });
        anchorLayer.append(marker);
      });
    };
    paintAnchors();

    // Drags paint DIRECTLY onto the live overlay (no refresh): listeners and
    // focus survive every pointermove, so a drag never dies after the first
    // move event. Anchor drags move the marker; vertex drags move the handle
    // and repaint the polygon from a working copy. Commit (or abort) happens
    // exactly once on pointerup / pointercancel / Escape.
    const movePhotoPoint = (event: PointerEvent): void => {
      if (dragAnchor === null && dragVertex === null) return;
      const photo = eventPhotoPoint(svg, event);
      const mm = photoToMm(input, photo.x, photo.y);
      if (!mm) {
        paintPageStatus('Pointer position is outside the evaluated mapping; nothing was moved.');
        return;
      }
      if (dragAnchor !== null) {
        const live = markerById.get(dragAnchor);
        const px = mmToPhoto(input, mm);
        if (live && px) {
          live.dot.setAttribute('cx', String(px.x));
          live.dot.setAttribute('cy', String(px.y));
          live.tag.setAttribute('x', String(px.x + 12));
          live.tag.setAttribute('y', String(px.y + 4));
          live.marker.setAttribute(
            'aria-label',
            `Anchor at ${displayMm1(mm.x)}, ${displayMm1(mm.y)} millimetres. Arrow keys move, pointer drags.`,
          );
        }
        pendingAnchorMm = mm;
      } else if (dragVertex !== null) {
        if (pendingVertexBase === null) {
          pendingVertexBase = [...(input.stagedSafeArea ?? input.safeArea)];
        }
        const index = dragVertex;
        const base = pendingVertexBase;
        if (index < 0 || index >= base.length) return;
        base[index] = mm;
        const px = mmToPhoto(input, mm);
        if (pendingVertexHandle && px) {
          pendingVertexHandle.setAttribute('cx', String(px.x));
          pendingVertexHandle.setAttribute('cy', String(px.y));
          pendingVertexHandle.setAttribute(
            'aria-label',
            `Safe-area corner ${index + 1} at ${displayMm1(mm.x)}, ${displayMm1(mm.y)} millimetres. Arrow keys move, Delete removes.`,
          );
        }
        const repainted: string[] = [];
        for (const point of base) {
          const corner = mmToPhoto(input, point);
          if (!corner) return;
          repainted.push(`${corner.x},${corner.y}`);
        }
        safePolygon.setAttribute('points', repainted.join(' '));
      }
    };

    svg.addEventListener('pointermove', movePhotoPoint);
    const endDrag = (event: PointerEvent): void => {
      if (dragAnchor === null && dragVertex === null) return;
      const id = dragAnchor;
      const mm = pendingAnchorMm;
      const vertexIndex = dragVertex;
      const vertexBase = pendingVertexBase;
      dragAnchor = null;
      dragVertex = null;
      pendingAnchorMm = null;
      pendingVertexBase = null;
      pendingVertexHandle = null;
      event.preventDefault();
      if (id !== null && mm !== null) {
        const next = input.anchors.map((entry) => (
          entry.id === id ? { ...entry, posMm: [mm.x, mm.y] as [number, number] } : entry
        ));
        commitAnchors(input, next);
      } else if (vertexIndex !== null && vertexBase !== null) {
        // Single commit for the whole drag; validity is re-checked here so a
        // degenerate drop restores the polygon instead of staging it.
        const check = validateSafeAreaPolygon(vertexBase);
        if (check.ok) {
          proposeSafeArea(input, vertexBase);
        } else {
          paintPageStatus(`Safe-area proposal refused: ${check.reason}`);
        }
      }
      refresh();
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', () => {
      // Abort: no commit, re-render restores the pre-drag geometry.
      dragAnchor = null;
      dragVertex = null;
      pendingAnchorMm = null;
      pendingVertexBase = null;
      pendingVertexHandle = null;
      refresh();
    });

    // Click (no drag) on empty photo area creates a named anchor — unless a
    // fresh-polygon drawing is in flight, in which case clicks stage corners.
    let downAt: { x: number; y: number } | null = null;
    svg.addEventListener('pointerdown', (event) => {
      downAt = { x: event.clientX, y: event.clientY };
    });
    svg.addEventListener('click', (event) => {
      if (dragAnchor !== null || dragVertex !== null) return;
      if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 6) return;
      if ((event.target as Element).closest?.('.anchor-setup-anchor, .anchor-setup-vertex, .anchor-setup-midpoint')) return;
      const draft = drawCorners;
      if (draft !== null) {
        // Fresh-polygon draw mode: clicks stage draft corners (same
        // inverse-mapped mm math as anchor clicks), never anchors.
        if ((event.target as Element).closest?.('.anchor-setup-draw')) return;
        const photo = eventPhotoPoint(svg, event);
        const mm = photoToMm(input, photo.x, photo.y);
        if (!mm) {
          paintPageStatus('Corner not added: the click falls outside the evaluated mapping.');
          return;
        }
        drawCorners = [...draft, mm];
        drawScopeKey = inputScopeKey;
        paintPageStatus(
          `Draft corner ${drawCorners.length} at ${displayMm1(mm.x)}, ${displayMm1(mm.y)} mm. ` +
          `Finish with Enter, the first corner, or a double-click; Escape cancels with no commit.`,
        );
        refresh();
        return;
      }
      const photo = eventPhotoPoint(svg, event);
      const mm = photoToMm(input, photo.x, photo.y);
      if (!mm) {
        paintPageStatus('No anchor created: the click falls outside the evaluated mapping. Choose the mapped region instead of guessing.');
        return;
      }
      const used = new Set(input.anchors.map((entry) => entry.name));
      let serial = input.anchors.length + 1;
      while (used.has(`Anchor ${serial}`)) serial += 1;
      const created: AnchorDef = {
        id: newAnchorId(),
        name: `Anchor ${serial}`,
        productId: input.scope.productId,
        variantId: input.scope.variantId,
        regionId: input.scope.regionId,
        frameId: input.scope.frameId,
        calibrationId: input.scope.calibrationId,
        calibrationVersion: input.scope.calibrationVersion,
        posMm: [mm.x, mm.y],
      };
      commitAnchors(input, [...input.anchors, created]);
      paintPageStatus(
        `Created “${created.name}” at ${displayMm1(mm.x)}, ${displayMm1(mm.y)} mm in region ` +
        `“${input.scope.regionName ?? input.scope.regionId}”. Rename it below if needed.`,
      );
      refresh();
    });

    // Double-click closes an in-progress drawing. The double-click's two
    // clicks each staged a corner, so the trailing duplicate is dropped.
    svg.addEventListener('dblclick', (event) => {
      const draft = drawCorners;
      if (draft === null) return;
      event.preventDefault();
      drawCorners = draft.length >= 4 ? draft.slice(0, -1) : draft.slice();
      drawScopeKey = inputScopeKey;
      finishDrawing(input, paintPageStatus, refresh);
    });

    renderAnchorList(input, paintPageStatus, refresh, commitAnchors, scopeKeyOf(input.scope));
    renderVertexPanel(input, paintPageStatus, refresh, proposeSafeArea);
    if (focusKey) {
      const next = container.querySelector(`[data-fkey="${focusKey.replace(/"/g, '')}"]`);
      if (next instanceof HTMLElement || next instanceof SVGElement) {
        (next as HTMLElement).focus();
      }
    }
  }

  function renderAnchorList(
    input: AnchorSetupInput,
    paintPageStatus: (message: string) => void,
    refreshSelf: () => void,
    commit: (scopeInput: AnchorSetupInput, next: AnchorDef[]) => void,
    scopeKey: string,
  ): void {
    void scopeKey;
    const heading = document.createElement('h4');
    heading.className = 'anchor-setup-heading';
    heading.textContent = `Anchors in region “${input.scope.regionName ?? input.scope.regionId}” (${input.anchors.length})`;
    container.append(heading);
    if (input.anchors.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No anchors yet for this region. Click the photo above to place the first one.';
      container.append(empty);
    }
    const list = document.createElement('div');
    list.className = 'anchor-setup-list';
    input.anchors.forEach((anchor) => {
      const row = document.createElement('div');
      row.className = 'anchor-setup-row';
      const nameLabel = document.createElement('label');
      nameLabel.className = 'anchor-setup-field';
      const nameCaption = document.createElement('span');
      nameCaption.textContent = 'Name';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = anchor.name;
      nameInput.maxLength = 80;
      nameInput.setAttribute('data-fkey', `anchor-name-${anchor.id}`);
      nameInput.setAttribute('aria-label', `Name for anchor at ${displayMm1(anchor.posMm[0]!)}, ${displayMm1(anchor.posMm[1]!)} millimetres`);
      nameInput.addEventListener('change', () => {
        const problem = validateAnchorName(nameInput.value, input.anchors, anchor.id);
        if (problem) {
          paintPageStatus(`Anchor not renamed: ${problem}`);
          nameInput.value = anchor.name;
          return;
        }
        const next = input.anchors.map((entry) => (
          entry.id === anchor.id ? { ...entry, name: nameInput.value.trim() } : entry
        ));
        commit(input, next);
        refreshSelf();
      });
      nameLabel.append(nameCaption, nameInput);
      const coordLabel = (axis: 'x' | 'y', value: number): HTMLElement => {
        const field = document.createElement('label');
        field.className = 'anchor-setup-field anchor-setup-number';
        const caption = document.createElement('span');
        caption.textContent = axis === 'x' ? 'X mm' : 'Y mm';
        const number = document.createElement('input');
        number.type = 'number';
        number.step = 'any';
        number.value = String(value);
        number.setAttribute('aria-label', `Anchor “${anchor.name}” ${axis === 'x' ? 'X' : 'Y'} in millimetres`);
        number.setAttribute('data-fkey', `anchor-${axis}-${anchor.id}`);
        number.addEventListener('change', () => {
          const parsed = number.valueAsNumber;
          if (!Number.isFinite(parsed)) {
            paintPageStatus(`Anchor “${anchor.name}” not moved: enter a finite millimetre value.`);
            number.value = String(value);
            return;
          }
          const next = input.anchors.map((entry) => (
            entry.id === anchor.id
              ? { ...entry, posMm: (axis === 'x' ? [parsed, entry.posMm[1]!] : [entry.posMm[0]!, parsed]) as [number, number] }
              : entry
          ));
          commit(input, next);
          refreshSelf();
        });
        field.append(caption, number);
        return field;
      };
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary anchor-setup-remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove anchor “${anchor.name}”`);
      remove.setAttribute('data-fkey', `anchor-remove-${anchor.id}`);
      remove.addEventListener('click', () => {
        commit(input, input.anchors.filter((entry) => entry.id !== anchor.id));
        paintPageStatus(`Removed anchor “${anchor.name}”. Dimensions that used it now report “setup needed”.`);
        refreshSelf();
      });
      row.append(nameLabel, coordLabel('x', anchor.posMm[0]!), coordLabel('y', anchor.posMm[1]!), remove);
      list.append(row);
    });
    container.append(list);
  }

  function renderVertexPanel(
    input: AnchorSetupInput,
    paintPageStatus: (message: string) => void,
    refreshSelf: () => void,
    propose: (scopeInput: AnchorSetupInput, staged: AnchorSetupMm[] | null) => void,
  ): void {
    const draft = drawCorners;
    if (draft !== null) {
      renderDrawingPanel(input, draft, paintPageStatus, refreshSelf);
      return;
    }
    const heading = document.createElement('h4');
    heading.className = 'anchor-setup-heading';
    const points = input.stagedSafeArea ?? input.safeArea;
    heading.textContent = input.stagedSafeArea
      ? `Safe-area proposal (${points.length} corners, staged — product unchanged)`
      : `Safe area (${points.length} corners, reference only)`;
    container.append(heading);
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent =
      'Corner handles drag on the photo and move with arrow keys like anchors; ' +
      '“+” edge handles insert a corner. ' +
      'Removing, moving or inserting a corner stages a proposal: the issued product keeps its approved safe area. ' +
      'To apply a staged proposal, open the source in Prepare → Choose items → “Anchor + safe-area setup (product preparation)”.';
    container.append(hint);
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (input.stagedSafeArea) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'btn-secondary';
      reset.textContent = 'Discard safe-area proposal';
      reset.addEventListener('click', () => {
        propose(input, null);
        paintPageStatus('Safe-area proposal discarded; the approved safe area is unchanged.');
        refreshSelf();
      });
      actions.append(reset);
    }
    if (actions.childNodes.length > 0) container.append(actions);
    if (points.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'This region carries no safe-area polygon yet. Draw one fresh on the photo: every click stages a corner in region millimetres.';
      container.append(empty);
      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'btn-secondary';
      start.textContent = 'Draw safe area';
      start.setAttribute('data-fkey', `draw-start-${input.scope.regionId}`);
      start.addEventListener('click', () => {
        drawCorners = [];
        drawScopeKey = scopeKeyOf(input.scope);
        paintPageStatus(
          'Drawing: click the product photo to add safe-area corners. ' +
          'Finish with Enter, the first corner, or a double-click; Escape cancels with no commit.',
        );
        refreshSelf();
      });
      const startActions = document.createElement('div');
      startActions.className = 'actions';
      startActions.append(start);
      container.append(startActions);
      return;
    }
    const list = document.createElement('div');
    list.className = 'anchor-setup-list';
    points.forEach((point, index) => {
      const row = document.createElement('div');
      row.className = 'anchor-setup-row';
      const label = document.createElement('span');
      label.className = 'muted';
      label.textContent = `Corner ${index + 1}: ${displayMm1(point.x)}, ${displayMm1(point.y)} mm`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary anchor-setup-remove';
      remove.textContent = 'Remove corner';
      remove.setAttribute('aria-label', `Remove safe-area corner ${index + 1} (stages a proposal)`);
      remove.setAttribute('data-fkey', `vertex-remove-${input.scope.regionId}-${index}`);
      remove.addEventListener('click', () => {
        removeVertex(input, index, paintPageStatus, refreshSelf);
      });
      row.append(label, remove);
      list.append(row);
    });
    container.append(list);
  }

  function renderDrawingPanel(
    input: AnchorSetupInput,
    draft: AnchorSetupMm[],
    paintPageStatus: (message: string) => void,
    refreshSelf: () => void,
  ): void {
    const heading = document.createElement('h4');
    heading.className = 'anchor-setup-heading';
    heading.textContent = `Drawing safe area (${draft.length} corner${draft.length === 1 ? '' : 's'} — nothing committed)`;
    container.append(heading);
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent =
      'Click the product photo to add corners in region millimetres. ' +
      'Finish with Enter, the first (larger) corner, or a double-click; Escape cancels with no commit. ' +
      'Invalid geometry (fewer than 3 corners, zero area, crossing edges) is refused and the draft stays open.';
    container.append(hint);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const finish = document.createElement('button');
    finish.type = 'button';
    finish.className = 'btn-secondary';
    finish.textContent = 'Finish safe area';
    finish.setAttribute('data-fkey', `draw-finish-${input.scope.regionId}`);
    finish.addEventListener('click', () => {
      finishDrawing(input, paintPageStatus, refreshSelf);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = 'Cancel drawing';
    cancel.setAttribute('data-fkey', `draw-cancel-${input.scope.regionId}`);
    cancel.addEventListener('click', () => {
      drawCorners = null;
      drawScopeKey = null;
      paintPageStatus('Drawing cancelled; nothing was committed.');
      refreshSelf();
    });
    actions.append(finish, cancel);
    container.append(actions);
    if (draft.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No corners yet — click the photo above to place the first one.';
      container.append(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'anchor-setup-list';
    draft.forEach((corner, index) => {
      const row = document.createElement('div');
      row.className = 'anchor-setup-row';
      const label = document.createElement('span');
      label.className = 'muted';
      label.textContent = `Draft corner ${index + 1}: ${displayMm1(corner.x)}, ${displayMm1(corner.y)} mm`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary anchor-setup-remove';
      remove.textContent = 'Remove corner';
      remove.setAttribute('aria-label', `Remove draft corner ${index + 1}`);
      remove.setAttribute('data-fkey', `draw-remove-${input.scope.regionId}-${index}`);
      remove.addEventListener('click', () => {
        const next = drawCorners;
        if (!next) return;
        next.splice(index, 1);
        drawCorners = [...next];
        paintPageStatus(`Removed draft corner ${index + 1} (nothing committed).`);
        refreshSelf();
      });
      row.append(label, remove);
      list.append(row);
    });
    container.append(list);
  }

  function finishDrawing(
    input: AnchorSetupInput,
    paintPageStatus: (message: string) => void,
    refreshSelf: () => void,
  ): void {
    const draft = drawCorners;
    if (draft === null) return;
    const closable = canCloseDrawnPolygon(draft);
    if (!closable.ok) {
      paintPageStatus(`Drawing not finished: ${closable.reason}`);
      return;
    }
    const check = validateSafeAreaPolygon(draft);
    if (!check.ok) {
      paintPageStatus(`Safe-area drawing refused: ${check.reason} Move or remove a corner, or press Escape to cancel.`);
      return;
    }
    const committed = draft.map((corner) => ({ ...corner }));
    drawCorners = null;
    drawScopeKey = null;
    proposeSafeArea(input, committed);
    paintPageStatus(
      `Staged a drawn safe area with ${committed.length} corners (proposal only; the approved product is unchanged).`,
    );
    refreshSelf();
  }

  function insertVertex(
    input: AnchorSetupInput,
    edgeIndex: number,
    mid: AnchorSetupMm,
    paintPageStatus: (message: string) => void,
    refreshSelf: () => void,
  ): void {
    const base = [...(input.stagedSafeArea ?? input.safeArea)];
    if (edgeIndex < 0 || edgeIndex >= base.length) return;
    base.splice(edgeIndex + 1, 0, { ...mid });
    proposeSafeArea(input, base);
    paintPageStatus(
      `Staged an inserted corner on edge ${edgeIndex + 1} at ${displayMm1(mid.x)}, ${displayMm1(mid.y)} mm ` +
      `(proposal only; product unchanged).`,
    );
    refreshSelf();
  }

  function moveVertex(
    input: AnchorSetupInput,
    index: number,
    dx: number,
    dy: number,
    paintPageStatus: (message: string) => void,
    refreshSelf: () => void,
  ): void {
    const base = [...(input.stagedSafeArea ?? input.safeArea)];
    const current = base[index];
    if (!current) return;
    base[index] = { x: current.x + dx, y: current.y + dy };
    proposeSafeArea(input, base);
    paintPageStatus(
      `Staged safe-area corner ${index + 1} at ${displayMm1(base[index]!.x)}, ${displayMm1(base[index]!.y)} mm ` +
      `(proposal only; product unchanged).`,
    );
    refreshSelf();
  }

  function removeVertex(
    input: AnchorSetupInput,
    index: number,
    paintPageStatus: (message: string) => void,
    refreshSelf: () => void,
  ): void {
    const base = [...(input.stagedSafeArea ?? input.safeArea)];
    if (base.length <= 3) {
      paintPageStatus('Corner removal refused: a safe area needs at least 3 corners.');
      return;
    }
    if (index < 0 || index >= base.length) return;
    base.splice(index, 1);
    proposeSafeArea(input, base);
    paintPageStatus(`Staged removal of safe-area corner ${index + 1} (proposal only; product unchanged).`);
    refreshSelf();
  }

  function destroy(): void {
    destroyed = true;
    document.removeEventListener('keydown', cancelDragOnEscape);
    container.replaceChildren();
  }

  return { refresh, destroy };
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
