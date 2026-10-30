/** Pure model polygon plane/projection shared by setup and customer proof. */
import type { SetupPoint3D } from '../setup-calibration/index.js';
export type SetupVec3 = SetupPoint3D;
export interface SetupRegionPlane { origin: SetupVec3; normal: SetupVec3; xDir: SetupVec3; yDir: SetupVec3 }
function isVec3(value: unknown): value is SetupVec3 {
  if (!value || typeof value !== 'object') return false;
  const p = value as SetupVec3;
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}
function sub3(a: SetupVec3, b: SetupVec3): SetupVec3 { return { x: a.x-b.x, y: a.y-b.y, z:a.z-b.z }; }
function cross3(a: SetupVec3, b: SetupVec3): SetupVec3 { return {x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x}; }
function norm3(v: SetupVec3): number { return Math.sqrt(v.x*v.x+v.y*v.y+v.z*v.z); }

/**
 * Region plane for a safe-area polygon via Newell's method (native units):
 * centroid origin, unit normal, in-plane xDir from the first edge projected
 * perpendicular to the normal, yDir = normal × xDir. Returns null when the
 * points are collinear/coincident (no plane). Pure.
 */
export function planeFromPolygon(points: readonly SetupVec3[]): SetupRegionPlane | null {
  if (!Array.isArray(points) || points.length < 3) return null;
  for (const point of points) {
    if (!isVec3(point)) return null;
  }
  const origin: SetupVec3 = { x: 0, y: 0, z: 0 };
  for (const point of points) {
    origin.x += point.x;
    origin.y += point.y;
    origin.z += point.z;
  }
  origin.x /= points.length;
  origin.y /= points.length;
  origin.z /= points.length;
  const normal: SetupVec3 = { x: 0, y: 0, z: 0 };
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current === undefined || next === undefined) return null;
    normal.x += (current.y - next.y) * (current.z + next.z);
    normal.y += (current.z - next.z) * (current.x + next.x);
    normal.z += (current.x - next.x) * (current.y + next.y);
  }
  const normalLength = norm3(normal);
  if (!Number.isFinite(normalLength) || !(normalLength > 1e-12)) return null;
  const unit: SetupVec3 = {
    x: normal.x / normalLength,
    y: normal.y / normalLength,
    z: normal.z / normalLength,
  };
  const first = points[0];
  const second = points[1];
  if (first === undefined || second === undefined) return null;
  const edge = sub3(second, first);
  const along = edge.x * unit.x + edge.y * unit.y + edge.z * unit.z;
  const inPlane: SetupVec3 = {
    x: edge.x - along * unit.x,
    y: edge.y - along * unit.y,
    z: edge.z - along * unit.z,
  };
  const inPlaneLength = norm3(inPlane);
  if (!Number.isFinite(inPlaneLength) || !(inPlaneLength > 1e-12)) return null;
  const xDir: SetupVec3 = {
    x: inPlane.x / inPlaneLength,
    y: inPlane.y / inPlaneLength,
    z: inPlane.z / inPlaneLength,
  };
  const yDir = cross3(unit, xDir);
  if (!isVec3(yDir) || !(norm3(yDir) > 1e-12)) return null;
  return { origin, normal: unit, xDir, yDir };
}

/**
 * Project one 3D safe-area polygon onto its region plane and scale to mm
 * under the fitted scale (native units while `mmPerUnit` is null). Returns
 * the plane plus the 2D ring, or null when degenerate. Pure; shared by the
 * ring check below and by station persistence (projected rings become domain
 * region polygons — an explicit planar projection of surface picks, never a
 * curved-surface claim).
 */
export function projectAreaToMm(
  points: readonly SetupVec3[],
  mmPerUnit: number | null,
): { plane: SetupRegionPlane; ring: Array<{ x: number; y: number }> } | null {
  if (!Array.isArray(points) || points.length < 3) return null;
  for (const point of points) {
    if (!isVec3(point)) return null;
  }
  const plane = planeFromPolygon(points);
  if (plane === null) return null;
  const scale = mmPerUnit !== null ? mmPerUnit : 1;
  const ring = points.map((point) => {
    const dx = point.x - plane.origin.x;
    const dy = point.y - plane.origin.y;
    const dz = point.z - plane.origin.z;
    return {
      x: (dx * plane.xDir.x + dy * plane.xDir.y + dz * plane.xDir.z) * scale,
      y: (dx * plane.yDir.x + dy * plane.yDir.y + dz * plane.yDir.z) * scale,
    };
  });
  for (const vertex of ring) {
    if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) return null;
  }
  return { plane, ring };
}
