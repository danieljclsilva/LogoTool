/** Calibrated planar region <-> native model conversion; no display units. */
export interface ModelPoint { x: number; y: number; z: number }
export interface ModelRegionFrame {
  origin: ModelPoint;
  xDir: ModelPoint;
  yDir: ModelPoint;
  normal: ModelPoint;
  mmPerUnit: number;
}
const finitePoint = (p: ModelPoint): boolean => [p.x, p.y, p.z].every(Number.isFinite);
const dot = (a: ModelPoint, b: ModelPoint): number => a.x * b.x + a.y * b.y + a.z * b.z;
export function validModelFrame(f: ModelRegionFrame): boolean {
  return Number.isFinite(f.mmPerUnit) && f.mmPerUnit > 0 &&
    [f.origin, f.xDir, f.yDir, f.normal].every(finitePoint) &&
    [f.xDir, f.yDir, f.normal].every((axis) => Math.abs(dot(axis, axis) - 1) < 1e-6) &&
    Math.abs(dot(f.xDir, f.yDir)) < 1e-6 && Math.abs(dot(f.xDir, f.normal)) < 1e-6 && Math.abs(dot(f.yDir, f.normal)) < 1e-6 &&
    dot({ x: f.xDir.y * f.yDir.z - f.xDir.z * f.yDir.y, y: f.xDir.z * f.yDir.x - f.xDir.x * f.yDir.z, z: f.xDir.x * f.yDir.y - f.xDir.y * f.yDir.x }, f.normal) > 1 - 1e-6;
}
export function modelPointFromMm(f: ModelRegionFrame, xMm: number, yMm: number): ModelPoint | null {
  if (!validModelFrame(f) || !Number.isFinite(xMm) || !Number.isFinite(yMm)) return null;
  const x = xMm / f.mmPerUnit, y = yMm / f.mmPerUnit;
  const p = { x: f.origin.x + x * f.xDir.x + y * f.yDir.x, y: f.origin.y + x * f.xDir.y + y * f.yDir.y, z: f.origin.z + x * f.xDir.z + y * f.yDir.z };
  return finitePoint(p) ? p : null;
}
/** Orthogonal planar projection of a real surface hit, not a surface-arc map. */
export function regionMmFromModel(f: ModelRegionFrame, point: ModelPoint): { xMm: number; yMm: number } | null {
  if (!validModelFrame(f) || !finitePoint(point)) return null;
  const delta = { x: point.x - f.origin.x, y: point.y - f.origin.y, z: point.z - f.origin.z };
  const xMm = dot(delta, f.xDir) * f.mmPerUnit, yMm = dot(delta, f.yDir) * f.mmPerUnit;
  return Number.isFinite(xMm) && Number.isFinite(yMm) ? { xMm, yMm } : null;
}
export function modelAreaRegionId(areaId: string, scopeSuffix: string): string {
  const slug = areaId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'area';
  return `region-${slug}-${scopeSuffix}`;
}
