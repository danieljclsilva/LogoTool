/**
 * Pure planar (2D, millimetre-unit) polygon kernel for safe-region geometry.
 *
 * Units: all coordinates are millimetres. `eps` is an absolute tolerance in
 * millimetres used only for coincidence / boundary-contact tests (point within
 * `eps` of an edge counts as on-edge; vertices within `eps` count as
 * duplicates). Interior/exterior classification itself uses exact arithmetic
 * once the boundary band is excluded. Default `eps` is 1e-9 mm.
 *
 * Ring convention: polygons are implicitly closed rings; a trailing vertex
 * repeating the first point (explicit closure) is accepted and ignored.
 * Either winding (clockwise or counter-clockwise) is accepted, including
 * concave polygons.
 *
 * Boundary rules: contact with the safe-region boundary is allowed (on-edge
 * counts as inside for the safe region). Any contact with an exclusion
 * region — vertex inside, vertex on its boundary, or edge touch/cross — fails.
 *
 * This kernel is purely planar: it knows nothing about decoration methods,
 * ink/thread clearance, or curved garment surfaces. Any such allowances must
 * be applied by the caller before invoking these functions.
 */

export interface GeoPoint {
  x: number;
  y: number;
}

export type PolygonCheck = { ok: true } | { ok: false; errors: string[] };

const DEFAULT_EPS = 1e-9;

function resolveEps(eps: number = DEFAULT_EPS): number {
  if (typeof eps !== "number" || !Number.isFinite(eps) || eps < 0) {
    throw new Error(`eps must be a finite number >= 0, got ${String(eps)}`);
  }
  return eps;
}

function isFinitePoint(p: GeoPoint): p is GeoPoint {
  return (
    p !== null &&
    typeof p === "object" &&
    typeof (p as GeoPoint).x === "number" &&
    typeof (p as GeoPoint).y === "number" &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y)
  );
}

function dist(a: GeoPoint, b: GeoPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Signed cross product (b - o) x (c - o); twice the signed triangle area. */
function cross(o: GeoPoint, b: GeoPoint, c: GeoPoint): number {
  return (b.x - o.x) * (c.y - o.y) - (b.y - o.y) * (c.x - o.x);
}

/** True when p lies on segment a-b within the eps band (mm). */
function pointOnSegment(p: GeoPoint, a: GeoPoint, b: GeoPoint, eps: number): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) {
    return dist(p, a) <= eps;
  }
  const len = Math.sqrt(len2);
  // Perpendicular distance from p to the supporting line.
  if (Math.abs(cross(a, b, p)) / len > eps) {
    return false;
  }
  // Projection parameter within [0, len], expanded by eps on both ends.
  const dot = (p.x - a.x) * abx + (p.y - a.y) * aby;
  return dot >= -eps * len && dot <= len2 + eps * len;
}

/**
 * True when segments p1-p2 and q1-q2 touch or cross in any way, including
 * shared endpoints and collinear overlap. Near-touches within eps count.
 */
function segmentsTouchOrCross(
  p1: GeoPoint,
  p2: GeoPoint,
  q1: GeoPoint,
  q2: GeoPoint,
  eps: number,
): boolean {
  const lenP = dist(p1, p2);
  const lenQ = dist(q1, q2);
  if (lenP <= eps || lenQ <= eps) {
    return true;
  }
  const o1 = cross(q1, q2, p1);
  const o2 = cross(q1, q2, p2);
  const o3 = cross(p1, p2, q1);
  const o4 = cross(p1, p2, q2);
  // |orient| / line-length is the point-to-line distance; compare to eps.
  const s1 = Math.abs(o1) <= eps * lenQ;
  const s2 = Math.abs(o2) <= eps * lenQ;
  const s3 = Math.abs(o3) <= eps * lenP;
  const s4 = Math.abs(o4) <= eps * lenP;
  if (!s1 && !s2 && !s3 && !s4) {
    return o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0;
  }
  return (
    pointOnSegment(p1, q1, q2, eps) ||
    pointOnSegment(p2, q1, q2, eps) ||
    pointOnSegment(q1, p1, p2, eps) ||
    pointOnSegment(q2, p1, p2, eps)
  );
}

/**
 * True only for a transversal crossing: the segments pass through each other.
 * Any endpoint contact within eps (shared vertices, touching, collinear
 * overlap) returns false so that allowed boundary contact is not flagged.
 */
function edgesProperlyCross(
  p1: GeoPoint,
  p2: GeoPoint,
  q1: GeoPoint,
  q2: GeoPoint,
  eps: number,
): boolean {
  if (
    pointOnSegment(p1, q1, q2, eps) ||
    pointOnSegment(p2, q1, q2, eps) ||
    pointOnSegment(q1, p1, p2, eps) ||
    pointOnSegment(q2, p1, p2, eps)
  ) {
    return false;
  }
  const o1 = cross(q1, q2, p1);
  const o2 = cross(q1, q2, p2);
  const o3 = cross(p1, p2, q1);
  const o4 = cross(p1, p2, q2);
  return o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0;
}

function signedArea2(ring: GeoPoint[]): number {
  // Translate before multiplying to avoid cancellation from a distant datum.
  const origin = ring[0]!;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    sum += (a.x - origin.x) * (b.y - origin.y) - (b.x - origin.x) * (a.y - origin.y);
  }
  return sum;
}

function normalizedRing(poly: GeoPoint[], eps: number): GeoPoint[] {
  return dist(poly[0]!, poly[poly.length - 1]!) <= eps ? poly.slice(0, -1) : poly;
}

/** Divide an edge at every safe-boundary intersection; test each open interval. */
function edgeStaysInside(a: GeoPoint, b: GeoPoint, safe: GeoPoint[], eps: number): boolean {
  const rx = b.x - a.x, ry = b.y - a.y;
  const len2 = rx * rx + ry * ry;
  const cuts = [0, 1];
  for (let i = 0; i < safe.length; i++) {
    const c = safe[i]!, d = safe[(i + 1) % safe.length]!;
    const sx = d.x - c.x, sy = d.y - c.y;
    const qx = c.x - a.x, qy = c.y - a.y;
    const determinant = rx * sy - ry * sx;
    if (determinant !== 0) {
      const t = (qx * sy - qy * sx) / determinant;
      const u = (qx * ry - qy * rx) / determinant;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) cuts.push(t);
    } else {
      // Collinear segments and vertex-only contacts also delimit intervals.
      for (const point of [c, d]) {
        if (pointOnSegment(point, a, b, eps)) {
          cuts.push(Math.max(0, Math.min(1, ((point.x - a.x) * rx + (point.y - a.y) * ry) / len2)));
        }
      }
    }
  }
  cuts.sort((x, y) => x - y);
  for (let i = 1; i < cuts.length; i++) {
    const left = cuts[i - 1]!, right = cuts[i]!;
    if (right <= left) continue;
    const t = left + (right - left) / 2;
    if (classifyPoint(safe, {x: a.x + t * rx, y: a.y + t * ry}, eps) === 'outside') return false;
  }
  return true;
}

function perimeter(ring: GeoPoint[]): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    total += dist(ring[i]!, ring[(i + 1) % ring.length]!);
  }
  return total;
}

/**
 * True when the path u -> s -> v reverses direction (spike): v lies on
 * segment s-u beyond s, or u lies on segment s-v beyond s. A straight
 * collinear continuation (s between u and v) returns false.
 */
function isSpike(s: GeoPoint, u: GeoPoint, v: GeoPoint, eps: number): boolean {
  if (dist(v, s) > eps && pointOnSegment(v, s, u, eps)) {
    return true;
  }
  if (dist(u, s) > eps && pointOnSegment(u, s, v, eps)) {
    return true;
  }
  return false;
}

/** Simplicity of a normalized ring: "ok", edge "crossing", or adjacent "spike". */
function checkSimplicity(ring: GeoPoint[], eps: number): "ok" | "crossing" | "spike" {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a1 = ring[i]!;
    const a2 = ring[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      const b1 = ring[j]!;
      const b2 = ring[(j + 1) % n]!;
      if (j === i + 1) {
        // Adjacent edges sharing a2.
        if (isSpike(a2, a1, b2, eps)) {
          return "spike";
        }
      } else if (i === 0 && j === n - 1) {
        // Wrap-adjacent edges sharing ring[0] (= a1 = b2).
        if (isSpike(a1, a2, b1, eps)) {
          return "spike";
        }
      } else if (segmentsTouchOrCross(a1, a2, b1, b2, eps)) {
        return "crossing";
      }
    }
  }
  return "ok";
}

/** Shared ring validator; `label` prefixes each message ("safe polygon", ...). */
function checkRing(poly: GeoPoint[], eps: number, label: string): string[] {
  if (!Array.isArray(poly) || poly.length < 3) {
    return [`${label} must have at least 3 vertices`];
  }
  for (const p of poly) {
    if (!isFinitePoint(p)) {
      return [`${label} vertices must be finite { x, y } points`];
    }
  }
  const errors: string[] = [];
  // Tolerate explicit closure: a trailing vertex repeating the first point.
  let ring = poly;
  if (dist(poly[0]!, poly[poly.length - 1]!) <= eps) {
    ring = poly.slice(0, -1);
    if (ring.length < 3) {
      return [`${label} must have at least 3 unique vertices`];
    }
  }
  let duplicate = false;
  for (let i = 0; i < ring.length && !duplicate; i++) {
    for (let j = i + 1; j < ring.length; j++) {
      if (dist(ring[i]!, ring[j]!) <= eps) {
        duplicate = true;
        break;
      }
    }
  }
  if (duplicate) {
    errors.push(`${label} has duplicate vertices within eps`);
  }
  // Zero area: |area| within an eps-wide strip of the polygon's own perimeter.
  const area = signedArea2(ring), length = perimeter(ring);
  if (!Number.isFinite(area) || !Number.isFinite(length) || !Number.isFinite(eps * length) || ring.some((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    return !Number.isFinite((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  })) return [`${label} exceeds finite geometry arithmetic range`];
  if (Math.abs(area) <= eps * length) {
    errors.push(`${label} has zero area`);
  }
  const simplicity = checkSimplicity(ring, eps);
  if (simplicity === "crossing") {
    errors.push(`${label} is self-intersecting`);
  } else if (simplicity === "spike") {
    errors.push(`${label} folds back on itself`);
  }
  return errors;
}

/**
 * Validate a safe-region polygon: finite coordinates, at least 3 unique
 * vertices (within eps), nonzero area, and a simple (non-self-intersecting)
 * ring. Either winding and concave shapes are accepted.
 */
export function validateSafePolygon(poly: GeoPoint[], eps: number = DEFAULT_EPS): PolygonCheck {
  const tol = resolveEps(eps);
  const errors = checkRing(poly, tol, "safe polygon");
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Classify a point against a simple polygon: "on-edge" within the eps band
 * (mm), otherwise exact ray-cast "inside" / "outside" (either winding).
 * Behaviour is defined for simple polygons; validate first.
 */
function classifyPoint(
  poly: GeoPoint[],
  pt: GeoPoint,
  eps: number = DEFAULT_EPS,
): "inside" | "outside" | "on-edge" {
  const tol = resolveEps(eps);
  if (!Array.isArray(poly) || poly.length < 3) {
    throw new Error("pointInPolygon needs a polygon with at least 3 vertices");
  }
  if (!isFinitePoint(pt)) {
    throw new Error("pointInPolygon needs a finite { x, y } query point");
  }
  poly = normalizedRing(poly, tol);
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    if (pointOnSegment(pt, poly[i]!, poly[(i + 1) % n]!, tol)) {
      return "on-edge";
    }
  }
  let inside = false;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    if (a.y > pt.y !== b.y > pt.y) {
      const xCross = a.x + ((pt.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (pt.x < xCross) {
        inside = !inside;
      }
    }
  }
  return inside ? "inside" : "outside";
}

/** Validated public point query; invalid rings never silently classify. */
export function pointInPolygon(poly: GeoPoint[], pt: GeoPoint, eps: number = DEFAULT_EPS): 'inside' | 'outside' | 'on-edge' {
  const tol = resolveEps(eps);
  const errors = checkRing(poly, tol, 'polygon');
  if (errors.length) throw new Error(errors.join('; '));
  return classifyPoint(poly, pt, tol);
}

/**
 * Whole-footprint containment: every footprint vertex must lie inside or on
 * the safe boundary (boundary contact allowed), no footprint edge may
 * properly cross a safe edge (catches concave-notch escapes that vertex
 * checks alone miss), and the footprint must not touch or overlap any
 * exclusion region. A footprint enclosing an exclusion fails even when all
 * footprint vertices lie outside it.
 */
export function footprintFits(args: {
  safe: GeoPoint[];
  exclusions?: GeoPoint[][];
  footprint: GeoPoint[];
  eps?: number;
}): { fits: boolean; reason: string } {
  if (args === null || typeof args !== 'object') throw new Error('footprint arguments must be an object');
  const tol = resolveEps(args.eps);
  const safeErrors = checkRing(args.safe, tol, "safe polygon");
  if (safeErrors.length > 0) {
    return { fits: false, reason: `safe polygon invalid: ${safeErrors.join("; ")}` };
  }
  const footprintErrors = checkRing(args.footprint, tol, "footprint");
  if (footprintErrors.length > 0) {
    return { fits: false, reason: `footprint invalid: ${footprintErrors.join("; ")}` };
  }
  const exclusions = args.exclusions ?? [];
  if (!Array.isArray(exclusions)) {
    throw new Error("exclusions must be an array of polygons");
  }
  for (let k = 0; k < exclusions.length; k++) {
    const exclusionErrors = checkRing(exclusions[k]!, tol, `exclusions[${k}]`);
    if (exclusionErrors.length > 0) {
      return { fits: false, reason: `exclusion invalid: ${exclusionErrors.join("; ")}` };
    }
  }

  const safe = normalizedRing(args.safe, tol);
  const footprint = normalizedRing(args.footprint, tol);
  const exclusionRings = exclusions.map(ring => normalizedRing(ring, tol));
  for (const v of footprint) {
    if (classifyPoint(safe, v, tol) === "outside") {
      return { fits: false, reason: `footprint vertex (${v.x}, ${v.y}) lies outside the safe region` };
    }
  }
  for (let i = 0; i < footprint.length; i++) {
    const p1 = footprint[i]!;
    const p2 = footprint[(i + 1) % footprint.length]!;
    if (!edgeStaysInside(p1, p2, safe, tol)) return {fits: false, reason: 'footprint edge leaves the safe region'};
    for (let j = 0; j < safe.length; j++) {
      const q1 = safe[j]!;
      const q2 = safe[(j + 1) % safe.length]!;
      if (edgesProperlyCross(p1, p2, q1, q2, tol)) {
        return { fits: false, reason: "footprint edge crosses the safe region boundary" };
      }
    }
  }

  for (let k = 0; k < exclusionRings.length; k++) {
    const exclusion = exclusionRings[k]!;
    for (const v of footprint) {
      const rel = classifyPoint(exclusion, v, tol);
      if (rel === "on-edge") {
        return { fits: false, reason: `footprint touches exclusions[${k}] boundary` };
      }
      if (rel === "inside") {
        return { fits: false, reason: `footprint overlaps exclusions[${k}]` };
      }
    }
    for (const v of exclusion) {
      if (classifyPoint(footprint, v, tol) === "inside") {
        return { fits: false, reason: `footprint overlaps exclusions[${k}]` };
      }
    }
    for (let i = 0; i < footprint.length; i++) {
      const p1 = footprint[i]!;
      const p2 = footprint[(i + 1) % footprint.length]!;
      for (let j = 0; j < exclusion.length; j++) {
        const q1 = exclusion[j]!;
        const q2 = exclusion[(j + 1) % exclusion.length]!;
        if (segmentsTouchOrCross(p1, p2, q1, q2, tol)) {
          return { fits: false, reason: `footprint boundary intersects exclusions[${k}] boundary` };
        }
      }
    }
  }

  return { fits: true, reason: "footprint fits inside the safe region with all exclusion regions avoided" };
}
