/**
 * Unified candidate/committed edit transaction for logo placements.
 *
 * Pure millimetre geometry: no DOM, browser, Three.js, pixel, or service
 * imports. One transaction owns the committed geometry, a live candidate,
 * and the ratio policy shared by numeric fields, corner drags, buttons,
 * and keyboard steps.
 *
 * Rules (see implementation-plan phases A/B):
 * - width and height edits BOTH consult the ratio lock.
 * - toggling the lock never alters geometry (no visual rollback).
 * - the lock is an editing preference: it survives commits and selection
 *   changes; callers persist `policy` per placement.
 * - a pointer gesture commits once on release; Escape/blur/lost-capture
 *   cancels back to the committed base.
 * - invalid or partial number text stays local (`parseSizeField` -> null)
 *   and never enters canonical production data.
 * - resetting to the original artwork ratio is a separate explicit action.
 */

import {
  footprintCornersMm,
  normalizeDeg,
  resizeFromCornerMm,
  type Footprint,
} from "./index.js";

/** Committed placement geometry in region millimetres. */
export interface EditGeometry {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
}

/**
 * Ratio policy: `locked` gates proportional edits; `ratio` is width/height
 * of the placement the lock was taken against. A non-finite or
 * non-positive ratio behaves as unlocked (never throws, never NaNs).
 */
export interface RatioPolicy {
  locked: boolean;
  ratio: number;
}

/** One live edit: committed base + transient candidate + policy. */
export interface EditTransaction {
  base: EditGeometry;
  candidate: EditGeometry;
  policy: RatioPolicy;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeGeom(g: EditGeometry): EditGeometry {
  const base = (g ?? {}) as Partial<EditGeometry>;
  const xMm = isFiniteNumber(base.xMm) ? base.xMm : 0;
  const yMm = isFiniteNumber(base.yMm) ? base.yMm : 0;
  const rawW = isFiniteNumber(base.widthMm) ? base.widthMm : 0;
  const rawH = isFiniteNumber(base.heightMm) ? base.heightMm : 0;
  return {
    xMm,
    yMm,
    widthMm: rawW > 0 ? Math.min(5000, rawW) : 0,
    heightMm: rawH > 0 ? Math.min(5000, rawH) : 0,
    rotationDeg: normalizeDeg(isFiniteNumber(base.rotationDeg) ? base.rotationDeg : 0),
  };
}

function sanitizePolicy(policy?: Partial<RatioPolicy> | null): RatioPolicy {
  const locked = policy?.locked === true;
  const ratio = policy !== null && policy !== undefined && isFiniteNumber(policy.ratio) &&
      (policy.ratio as number) > 0
    ? (policy.ratio as number)
    : NaN;
  return { locked: locked && Number.isFinite(ratio), ratio };
}

/** Start a live edit from committed geometry with an optional persisted policy. */
export function beginEdit(committed: EditGeometry, policy?: Partial<RatioPolicy> | null): EditTransaction {
  const base = sanitizeGeom(committed);
  return { base, candidate: { ...base }, policy: sanitizePolicy(policy) };
}

/** Lock ratio for the CURRENT candidate dimensions (both axes share it). */
export function policyForLock(geom: EditGeometry): RatioPolicy {
  const g = sanitizeGeom(geom);
  if (!(g.widthMm > 0) || !(g.heightMm > 0)) return { locked: false, ratio: NaN };
  return { locked: true, ratio: g.widthMm / g.heightMm };
}

/**
 * Toggle the ratio lock. Never alters geometry: locking captures the
 * current candidate ratio, unlocking keeps it for re-locking. No rollback.
 */
export function toggleLock(edit: EditTransaction, locked: boolean): EditTransaction {
  if (locked) {
    const ratio = edit.candidate.widthMm > 0 && edit.candidate.heightMm > 0
      ? edit.candidate.widthMm / edit.candidate.heightMm
      : edit.policy.ratio;
    return { ...edit, policy: sanitizePolicy({ locked: Number.isFinite(ratio) && ratio > 0, ratio }) };
  }
  return { ...edit, policy: { ...edit.policy, locked: false } };
}

/**
 * Separate explicit action: re-anchor the lock ratio to the ORIGINAL
 * artwork ratio without touching committed or candidate geometry.
 */
export function resetToArtworkRatio(
  edit: EditTransaction,
  artworkWidthMm: number,
  artworkHeightMm: number,
): EditTransaction {
  if (!(artworkWidthMm > 0) || !(artworkHeightMm > 0) ||
    !Number.isFinite(artworkWidthMm) || !Number.isFinite(artworkHeightMm)) {
    return { ...edit };
  }
  return {
    ...edit,
    policy: { locked: edit.policy.locked, ratio: artworkWidthMm / artworkHeightMm },
  };
}

function applyRatioLocked(candidate: EditGeometry, ratio: number, changed: "width" | "height"): EditGeometry {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return candidate;
  if (changed === "width") {
    if (!(candidate.widthMm > 0)) return candidate;
    return { ...candidate, heightMm: Math.min(5000, Math.max(1, candidate.widthMm / ratio)) };
  }
  if (!(candidate.heightMm > 0)) return candidate;
  return { ...candidate, widthMm: Math.min(5000, Math.max(1, candidate.heightMm * ratio)) };
}

/** Numeric width edit: consults the lock (height follows). Non-positive widths are clamped to 1. */
export function setCandidateWidth(edit: EditTransaction, widthMm: number): EditTransaction {
  if (!isFiniteNumber(widthMm)) return { ...edit };
  const candidate = { ...edit.candidate, widthMm: Math.min(5000, Math.max(1, widthMm)) };
  return {
    ...edit,
    candidate: edit.policy.locked ? applyRatioLocked(candidate, edit.policy.ratio, "width") : candidate,
  };
}

/** Numeric height edit: consults the lock (width follows). Fixes the width-only lock bug. */
export function setCandidateHeight(edit: EditTransaction, heightMm: number): EditTransaction {
  if (!isFiniteNumber(heightMm)) return { ...edit };
  const candidate = { ...edit.candidate, heightMm: Math.min(5000, Math.max(1, heightMm)) };
  return {
    ...edit,
    candidate: edit.policy.locked ? applyRatioLocked(candidate, edit.policy.ratio, "height") : candidate,
  };
}

/** Uniform grow/shrink step shared by buttons, keyboard, and sliders. */
export function scaleCandidate(edit: EditTransaction, factor: number): EditTransaction {
  if (!isFiniteNumber(factor) || !(factor > 0)) return { ...edit };
  const widthMm = Math.min(5000, Math.max(1, edit.candidate.widthMm * factor));
  const heightMm = Math.min(5000, Math.max(1, edit.candidate.heightMm * factor));
  return { ...edit, candidate: { ...edit.candidate, widthMm, heightMm } };
}

/** Rotation/centre edits never consult the ratio lock. */
export function setCandidateRotation(edit: EditTransaction, rotationDeg: number): EditTransaction {
  if (!isFiniteNumber(rotationDeg)) return { ...edit };
  return { ...edit, candidate: { ...edit.candidate, rotationDeg: normalizeDeg(rotationDeg) } };
}

export function setCandidateCentre(edit: EditTransaction, xMm: number, yMm: number): EditTransaction {
  if (!isFiniteNumber(xMm) || !isFiniteNumber(yMm)) return { ...edit };
  return { ...edit, candidate: { ...edit.candidate, xMm, yMm } };
}

/**
 * Corner drag in region millimetres. Unlocked: opposite-corner-anchored
 * free resize. Locked: uniform scale from the opposite corner so the
 * policy ratio is preserved exactly.
 */
export function resizeCorner(
  edit: EditTransaction,
  corner: 0 | 1 | 2 | 3,
  pointerMm: { xMm: number; yMm: number },
): EditTransaction {
  if (!Number.isInteger(corner) || corner < 0 || corner > 3) return { ...edit };
  if (!isFiniteNumber(pointerMm?.xMm) || !isFiniteNumber(pointerMm?.yMm)) return { ...edit };
  const base: Footprint = {
    cx: edit.candidate.xMm,
    cy: edit.candidate.yMm,
    widthMm: edit.candidate.widthMm,
    heightMm: edit.candidate.heightMm,
    rotationDeg: edit.candidate.rotationDeg,
  };
  if (!edit.policy.locked) {
    const resized = resizeFromCornerMm(base, corner, { x: pointerMm.xMm, y: pointerMm.yMm });
    return {
      ...edit,
      candidate: {
        ...edit.candidate,
        xMm: resized.cx,
        yMm: resized.cy,
        widthMm: resized.widthMm,
        heightMm: resized.heightMm,
        rotationDeg: resized.rotationDeg,
      },
    };
  }
  // Locked: uniform scale anchored at the opposite corner.
  const corners = footprintCornersMm(base);
  const opposite = corners[(corner + 2) % 4]!;
  const radians = (base.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const dx = pointerMm.xMm - opposite.x, dy = pointerMm.yMm - opposite.y;
  const sx = corner === 1 || corner === 2 ? 1 : -1;
  const sy = corner >= 2 ? 1 : -1;
  const alongW = sx * (dx * cos - dy * sin);
  const alongH = sy * (dx * sin + dy * cos);
  const w0 = base.widthMm > 0 ? base.widthMm : 1;
  const h0 = base.heightMm > 0 ? base.heightMm : 1;
  const scale = Math.min(5000 / Math.max(w0, h0), Math.max(1 / Math.max(w0, h0), alongW / w0, alongH / h0));
  if (!Number.isFinite(scale) || !(scale > 0)) return { ...edit };
  const widthMm = Math.min(5000, Math.max(1, w0 * scale));
  const heightMm = Math.min(5000, Math.max(1, h0 * scale));
  return {
    ...edit,
    candidate: {
      ...edit.candidate,
      xMm: opposite.x + ((sx * widthMm) / 2) * cos + ((sy * heightMm) / 2) * sin,
      yMm: opposite.y - ((sx * widthMm) / 2) * sin + ((sy * heightMm) / 2) * cos,
      widthMm,
      heightMm,
    },
  };
}

/** Commit once: the candidate becomes the new committed geometry. Policy persists untouched. */
export function commitEdit(edit: EditTransaction): EditGeometry {
  return { ...sanitizeGeom(edit.candidate) };
}

/** Cancel: drop the candidate, return the committed base unchanged. Policy persists untouched. */
export function cancelEdit(edit: EditTransaction): EditGeometry {
  return { ...edit.base };
}

/** True when the candidate differs from the committed base. */
export function editDiffers(edit: EditTransaction): boolean {
  const a = edit.base, c = edit.candidate;
  return (
    Math.abs(a.xMm - c.xMm) > 1e-9 ||
    Math.abs(a.yMm - c.yMm) > 1e-9 ||
    Math.abs(a.widthMm - c.widthMm) > 1e-9 ||
    Math.abs(a.heightMm - c.heightMm) > 1e-9 ||
    Math.abs(normalizeDeg(a.rotationDeg - c.rotationDeg)) > 1e-9
  );
}

/**
 * Parse a millimetre number field. Blank, non-numeric, or non-finite
 * text yields null so invalid partial input stays local and never
 * enters canonical production data.
 */
export function parseSizeField(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Provisional starting size for artwork with no known millimetre
 * dimensions: aspect-preserving, fitted to the calibrated region span.
 * Known mm sizes pass through unchanged. Never invents calibration;
 * callers must supply the region span (null span yields a null size).
 */
export function provisionalSizeMm(
  safeSpanMm: { spanX: number; spanY: number } | null,
  aspectWidthOverHeight: number | null,
  knownMm: { widthMm: number; heightMm: number } | null,
): { widthMm: number; heightMm: number } | null {
  if (knownMm !== null && knownMm.widthMm > 0 && knownMm.heightMm > 0 &&
    Number.isFinite(knownMm.widthMm) && Number.isFinite(knownMm.heightMm)) {
    return { widthMm: knownMm.widthMm, heightMm: knownMm.heightMm };
  }
  if (safeSpanMm === null || !(safeSpanMm.spanX > 0) || !(safeSpanMm.spanY > 0) ||
    !Number.isFinite(safeSpanMm.spanX) || !Number.isFinite(safeSpanMm.spanY)) {
    return null;
  }
  const fitW = safeSpanMm.spanX * 0.5;
  const fitH = safeSpanMm.spanY * 0.5;
  const round2 = (v: number): number => Math.round(v * 100) / 100;
  if (aspectWidthOverHeight !== null && Number.isFinite(aspectWidthOverHeight) && aspectWidthOverHeight > 0) {
    const heightMm = Math.min(5000, Math.max(1, Math.min(fitH, fitW / aspectWidthOverHeight)));
    const widthMm = Math.min(5000, Math.max(1, heightMm * (aspectWidthOverHeight as number)));
    return { widthMm: round2(widthMm), heightMm: round2(heightMm) };
  }
  const side = Math.min(5000, Math.max(1, Math.min(fitW, fitH)));
  return { widthMm: round2(side), heightMm: round2(side) };
}
