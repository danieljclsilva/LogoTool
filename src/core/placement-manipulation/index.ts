/**
 * Pure placement-manipulation geometry for logo footprints.
 *
 * No DOM, browser, Three.js, pixel, or service imports. All values are
 * physical millimetres in a Y-up frame. Rotation is clockwise-positive,
 * consistent with `rotatedFootprintCorners` in operation-measurements:
 * `x' = cx + dx*cos + dy*sin`, `y' = cy - dx*sin + dy*cos`.
 *
 * Every function is total: invalid input never throws; helpers clamp or
 * return the input unchanged with finite numbers.
 */

import { footprintFits } from "../geometry/index.js";

export interface MmPoint {
  x: number;
  y: number;
}

export type MmPolygon = Array<[number, number]>;

export interface Footprint {
  cx: number;
  cy: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
}

export interface CornerMeasurement {
  cornerIndex: 0 | 1 | 2 | 3;
  corner: MmPoint;
  nearest: MmPoint;
  edgeIndex: number;
  distanceMm: number;
}

export interface AlignGuide {
  kind: "v-center" | "h-center" | "v-edge" | "h-edge" | "angle";
  valueMm?: number;
  angleDeg?: number;
  label: string;
  /** Actual safe boundary for oblique edge guides (physical mm). */
  fromMm?: MmPoint;
  toMm?: MmPoint;
}

export interface SnapResult {
  cx: number;
  cy: number;
  rotationDeg: number;
  widthMm: number;
  heightMm: number;
  snappedPosition: boolean;
  snappedRotation: boolean;
  guides: AlignGuide[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeFootprint(f: Footprint): Footprint {
  const base = (f ?? {}) as Partial<Footprint>;
  const cx = isFiniteNumber(base.cx) ? base.cx : 0;
  const cy = isFiniteNumber(base.cy) ? base.cy : 0;
  const rawW = isFiniteNumber(base.widthMm) ? base.widthMm : 0;
  const rawH = isFiniteNumber(base.heightMm) ? base.heightMm : 0;
  const widthMm = rawW >= 0 ? rawW : 0;
  const heightMm = rawH >= 0 ? rawH : 0;
  const rotationDeg = normalizeDeg(isFiniteNumber(base.rotationDeg) ? base.rotationDeg : 0);
  return { cx, cy, widthMm, heightMm, rotationDeg };
}

/**
 * Normalize degrees to (-180, 180]. Non-finite input yields 0.
 */
export function normalizeDeg(deg: number): number {
  if (!isFiniteNumber(deg)) return 0;
  let n = ((deg % 360) + 360) % 360;
  if (n > 180) n -= 360;
  return n === 0 ? 0 : n; // collapse -0 to 0
}

/** Circular distance between two degree values, in [0, 180]. */
function angularDistance(a: number, b: number): number {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

/**
 * Rotated footprint corners in frame millimetres, clockwise order starting
 * at local (-hw, -hh). Same convention as operation-measurements
 * `rotatedFootprintCorners`.
 */
export function footprintCornersMm(f: Footprint): [MmPoint, MmPoint, MmPoint, MmPoint] {
  const s = sanitizeFootprint(f);
  const halfW = s.widthMm / 2;
  const halfH = s.heightMm / 2;
  const rad = (s.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const locals: Array<[number, number]> = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ];
  return locals.map(([dx, dy]) => ({
    x: s.cx + dx * cos + dy * sin,
    y: s.cy - dx * sin + dy * cos,
  })) as [MmPoint, MmPoint, MmPoint, MmPoint];
}

function isValidSafePolygon(safe: unknown): safe is Array<[number, number]> {
  if (!Array.isArray(safe) || safe.length < 3) return false;
  for (const pt of safe) {
    if (!Array.isArray(pt) || pt.length < 2) return false;
    if (!isFiniteNumber(pt[0]) || !isFiniteNumber(pt[1])) return false;
  }
  return true;
}

function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (!(lenSq > 0) || !Number.isFinite(lenSq)) return { x: ax, y: ay };
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (!Number.isFinite(t)) t = 0;
  t = Math.min(1, Math.max(0, t));
  return { x: ax + t * dx, y: ay + t * dy };
}

/**
 * For each of the 4 rotated footprint corners, the nearest point on the
 * safe-area polygon boundary (true point-to-segment against every edge,
 * so concave polygons are handled exactly). Invalid polygons (< 3 points
 * or non-finite) yield [] and never throw.
 */
export function cornerSafeMeasurements(f: Footprint, safe: MmPolygon): CornerMeasurement[] {
  if (!isValidSafePolygon(safe)) return [];
  const corners = footprintCornersMm(f);
  const n = safe.length;
  const out: CornerMeasurement[] = [];
  for (let c = 0; c < 4; c += 1) {
    const corner = corners[c] as MmPoint;
    let bestDist = Number.POSITIVE_INFINITY;
    let best: MmPoint = { x: safe[0]?.[0] ?? 0, y: safe[0]?.[1] ?? 0 };
    let bestEdge = 0;
    for (let e = 0; e < n; e += 1) {
      const a = safe[e] as [number, number];
      const b = safe[(e + 1) % n] as [number, number];
      const q = closestPointOnSegment(corner.x, corner.y, a[0], a[1], b[0], b[1]);
      const dx = corner.x - q.x;
      const dy = corner.y - q.y;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        best = q;
        bestEdge = e;
      }
    }
    if (!Number.isFinite(bestDist)) bestDist = 0;
    out.push({
      cornerIndex: c as 0 | 1 | 2 | 3,
      corner: { x: corner.x, y: corner.y },
      nearest: { x: best.x, y: best.y },
      edgeIndex: bestEdge,
      distanceMm: bestDist,
    });
  }
  return out;
}

/** Area centroid and winding, translated for numerical stability. */
function polygonCentre(safe: MmPolygon): { x: number; y: number; winding: number } | null {
  const [ox, oy] = safe[0]!;
  let area2 = 0, x = 0, y = 0;
  for (let i = 0; i < safe.length; i++) {
    const a = safe[i]!, b = safe[(i + 1) % safe.length]!;
    const ax = a[0] - ox, ay = a[1] - oy, bx = b[0] - ox, by = b[1] - oy;
    const cross = ax * by - bx * ay;
    area2 += cross; x += (ax + bx) * cross; y += (ay + by) * cross;
  }
  if (!Number.isFinite(area2) || Math.abs(area2) < 1e-9) return null;
  return { x: ox + x / (3 * area2), y: oy + y / (3 * area2), winding: Math.sign(area2) };
}

/** Rotation candidates from safe-polygon edge directions, in footprint-rotation degrees. */
function safeEdgeAngles(safe: Array<[number, number]>): number[] {
  const out: number[] = [];
  const n = safe.length;
  for (let e = 0; e < n; e += 1) {
    const a = safe[e] as [number, number];
    const b = safe[(e + 1) % n] as [number, number];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (!(dx * dx + dy * dy > 0)) continue;
    // Width-axis alignment: local x-axis (1,0) maps to (cos t, -sin t),
    // so t = atan2(-dy, dx). Also include the perpendicular (height-axis).
    const t = (Math.atan2(-dy, dx) * 180) / Math.PI;
    out.push(normalizeDeg(t), normalizeDeg(t + 90));
  }
  return out;
}

function resolveTol(value: unknown, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  if (value < 0) return fallback;
  return value;
}

/**
 * Snap a rotation to the nearest safe-polygon edge angle or cardinal
 * (0/90/-90/180) within `tolDeg` (default 2). `unsnapped` disables all
 * snapping. Never throws; non-finite input yields 0.
 */
export function rotationSnapDeg(
  rotationDeg: number,
  safe: MmPolygon,
  tolDeg?: number,
  unsnapped?: boolean,
): { rotationDeg: number; snapped: boolean; guides: AlignGuide[] } {
  const current = normalizeDeg(isFiniteNumber(rotationDeg) ? rotationDeg : 0);
  if (unsnapped === true) return { rotationDeg: current, snapped: false, guides: [] };
  const tol = resolveTol(tolDeg, 2);
  const valid = isValidSafePolygon(safe);
  // Cardinals first so ties prefer them; -90 included as the 90-family twin.
  const candidates: Array<{ angle: number; label: string }> = [
    { angle: 0, label: "snapped rotation to 0\u00B0" },
    { angle: 90, label: "snapped rotation to 90\u00B0" },
    { angle: -90, label: "snapped rotation to -90\u00B0" },
    { angle: 180, label: "snapped rotation to 180\u00B0" },
  ];
  if (valid) {
    const seen = new Set(candidates.map((c) => c.angle));
    for (const a of safeEdgeAngles(safe)) {
      if (seen.has(a)) continue;
      seen.add(a);
      candidates.push({ angle: a, label: `snapped rotation to safe edge angle ${a}\u00B0` });
    }
  }
  let best: { angle: number; label: string } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = angularDistance(current, c.angle);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (best !== null && bestDist <= tol) {
    return {
      rotationDeg: best.angle,
      snapped: true,
      guides: [{ kind: "angle", angleDeg: best.angle, label: best.label }],
    };
  }
  return { rotationDeg: current, snapped: false, guides: [] };
}

/**
 * Align the logo centre to the polygon centroid, or its footprint to an
 * actual safe-boundary segment. Snapping never moves a fitting footprint
 * outside the polygon. Boundary distances and guide endpoints are mm.
 */
export function snapFootprint(
  f: Footprint,
  safe: MmPolygon,
  opts?: { translateTolMm?: number; rotateTolDeg?: number; unsnapped?: boolean },
): SnapResult {
  const s = sanitizeFootprint(f);
  const result = (cx: number, cy: number, rotationDeg: number, guides: AlignGuide[], snappedRotation = false): SnapResult => ({
    cx, cy, rotationDeg, widthMm: s.widthMm, heightMm: s.heightMm,
    snappedPosition: guides.some((guide) => guide.kind !== "angle"), snappedRotation, guides,
  });
  if (opts?.unsnapped === true) return result(s.cx, s.cy, s.rotationDeg, []);
  const tol = resolveTol(opts?.translateTolMm, 2);
  const rot = rotationSnapDeg(s.rotationDeg, safe, opts?.rotateTolDeg);
  let cx = s.cx, cy = s.cy;
  const guides: AlignGuide[] = [];
  if (isValidSafePolygon(safe)) {
    const polygon = safe.map(([x, y]) => ({ x, y }));
    const fits = (x: number, y: number): boolean => footprintFits({
      safe: polygon, footprint: footprintCornersMm({ ...s, cx: x, cy: y, rotationDeg: rot.rotationDeg }),
    }).fits;
    const centre = polygonCentre(safe);
    if (centre) {
      if (Math.abs(cx - centre.x) <= tol && fits(centre.x, cy)) {
        cx = centre.x;
        guides.push({ kind: "v-center", valueMm: cx, label: "Aligned with safe-area centre" });
      }
      if (Math.abs(cy - centre.y) <= tol && fits(cx, centre.y)) {
        cy = centre.y;
        guides.push({ kind: "h-center", valueMm: cy, label: "Aligned with safe-area centre" });
      }
      // Up to two independent boundary contacts allow corner alignment.
      const used = new Set<number>();
      for (let pass = 0; pass < 2; pass++) {
        const corners = footprintCornersMm({ ...s, cx, cy, rotationDeg: rot.rotationDeg });
        let best: { x: number; y: number; edge: number; distance: number; guide: AlignGuide } | null = null;
        for (let i = 0; i < safe.length; i++) {
          if (used.has(i)) continue;
          const a = safe[i]!, b = safe[(i + 1) % safe.length]!;
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
          if (!(len > 1e-9)) continue;
          const nx = -dy / len * centre.winding, ny = dx / len * centre.winding;
          if (guides.some((g) => (g.kind === "v-center" && Math.abs(nx) > 1e-9) ||
            (g.kind === "h-center" && Math.abs(ny) > 1e-9))) continue;
          const distance = Math.min(...corners.map((p) => (p.x - a[0]) * nx + (p.y - a[1]) * ny));
          if (Math.abs(distance) > tol || (best && Math.abs(distance) >= best.distance)) continue;
          const x = cx - distance * nx, y = cy - distance * ny;
          if (!fits(x, y)) continue;
          const touchesSegment = corners.some((point) => {
            const shifted = { x: point.x - distance * nx, y: point.y - distance * ny };
            const nearest = closestPointOnSegment(shifted.x, shifted.y, a[0], a[1], b[0], b[1]);
            return Math.hypot(shifted.x - nearest.x, shifted.y - nearest.y) < 1e-7;
          });
          if (!touchesSegment) continue;
          // Whole-polygon containment also catches concave notch escapes.
          const vertical = Math.abs(dx) < 1e-9, horizontal = Math.abs(dy) < 1e-9;
          best = { x, y, edge: i, distance: Math.abs(distance), guide: {
            kind: vertical ? "v-edge" : "h-edge",
            ...(vertical ? { valueMm: a[0] } : horizontal ? { valueMm: a[1] } : {}),
            fromMm: { x: a[0], y: a[1] }, toMm: { x: b[0], y: b[1] },
            label: `Aligned with safe-area side ${i + 1}`,
          } };
        }
        if (!best) break;
        used.add(best.edge); cx = best.x; cy = best.y; guides.push(best.guide);
      }
    }
  }
  return result(cx, cy, rot.rotationDeg, [...guides, ...rot.guides], rot.snapped);
}

/** Opposite corner remains fixed; crossing it clamps the dragged size to 1mm. */
export function resizeFromCornerMm(base: Footprint, corner: number, pointer: MmPoint): Footprint {
  if (!Number.isInteger(corner) || corner < 0 || corner > 3 ||
    ![pointer.x, pointer.y].every(Number.isFinite)) return { ...base };
  const radians = base.rotationDeg * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const sx = corner === 1 || corner === 2 ? 1 : -1, sy = corner >= 2 ? 1 : -1;
  const opposite = footprintCornersMm(base)[(corner + 2) % 4]!;
  const dx = pointer.x - opposite.x, dy = pointer.y - opposite.y;
  const widthMm = Math.min(5000, Math.max(1, sx * (dx * cos - dy * sin)));
  const heightMm = Math.min(5000, Math.max(1, sy * (dx * sin + dy * cos)));
  return { cx: opposite.x + sx * widthMm / 2 * cos + sy * heightMm / 2 * sin,
    cy: opposite.y - sx * widthMm / 2 * sin + sy * heightMm / 2 * cos,
    widthMm, heightMm, rotationDeg: base.rotationDeg };
}
