/**
 * Pure edge-to-anchor geometry for the operation sheet.
 *
 * No DOM, browser, Three.js, pixel, or service imports. All distances are
 * physical millimetres computed from the exact rotated artwork footprint in
 * an explicitly selected region frame. Each logo is measured independently:
 * no shared mutable state, no cross-placement inference.
 */

import type { ExportPlacement, ResultCandidate } from "../types.js";
import type {
  AnchorDef,
  ArtworkEdge,
  DimensionBinding,
  EdgeMeasurement,
  MeasurementConvention,
  MeasurementPoint,
  OperationDraft,
  OperationDraftVersion,
  PlacementMeasure,
  ResolvedDimension,
} from "./types.js";

export type {
  AnchorDef,
  ArtworkEdge,
  DimensionBinding,
  EdgeMeasurement,
  MeasurementConvention,
  MeasurementPoint,
  OperationDraft,
  OperationDraftVersion,
  PlacementMeasure,
  ResolvedDimension,
} from "./types.js";

/** Independent version of the small local operational draft contract. */
export const OPERATION_DRAFT_VERSION: OperationDraftVersion = "operation-draft/1";

/** Numeric draft contract generation; always 1 for `operation-draft/1`. */
export const OPERATION_DRAFT_NUMBER = 1 as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFinitePoint(point: unknown): point is MeasurementPoint {
  if (typeof point !== "object" || point === null) return false;
  const candidate = point as Record<string, unknown>;
  return isFiniteNumber(candidate["x"]) && isFiniteNumber(candidate["y"]);
}

/**
 * Rotated artwork-bbox footprint corners in frame millimetres, clockwise
 * order starting at local (-hw, -hh). Rotation is clockwise-positive facing
 * the region in a Y-up frame: `x' = cx + dx*cos + dy*sin`,
 * `y' = cy - dx*sin + dy*cos`. Identical to the operation-document diagram
 * math so displayed values always equal these pure millimetre calculations.
 */
export function rotatedFootprintCorners(
  centreX: number,
  centreY: number,
  widthMm: number,
  heightMm: number,
  rotationDeg: number,
): MeasurementPoint[] {
  const halfW = widthMm / 2;
  const halfH = heightMm / 2;
  const corners: MeasurementPoint[] = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ];
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return corners.map((corner) => ({
    x: centreX + corner.x * cos + corner.y * sin,
    y: centreY - corner.x * sin + corner.y * cos,
  }));
}

function closestPointOnSegment(
  point: MeasurementPoint,
  start: MeasurementPoint,
  end: MeasurementPoint,
): MeasurementPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (!(lengthSq > 0) || !Number.isFinite(lengthSq)) return { x: start.x, y: start.y };
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
  if (!Number.isFinite(t)) t = 0;
  t = Math.min(1, Math.max(0, t));
  return { x: start.x + t * dx, y: start.y + t * dy };
}

function edgeWord(edge: ArtworkEdge): "left" | "right" | "bottom" | "top" {
  return edge === "minX" ? "left" : edge === "maxX" ? "right" : edge === "minY" ? "bottom" : "top";
}

function edgeTag(edge: ArtworkEdge): string {
  return edge === "minX" ? "min-X" : edge === "maxX" ? "max-X" : edge === "minY" ? "min-Y" : "max-Y";
}

/**
 * Ordinary-language label for an orthogonal (dx/dy) measurement. The honest
 * variant is selected by geometry, never guessed: the line touches the
 * artwork edge, or the supporting line is extended beyond it.
 */
function describeOrthogonal(
  edge: ArtworkEdge,
  convention: "dx" | "dy",
  touchesArtwork: boolean,
): string {
  const axis = convention === "dx" ? "horizontally" : "vertically";
  if (touchesArtwork) {
    return `to the ${edgeWord(edge)} artwork edge (${edgeTag(edge)}), measured ${axis}`;
  }
  return (
    `supporting line extended beyond the artwork edge ` +
    `(${edgeWord(edge)} edge, ${edgeTag(edge)}), measured ${axis}`
  );
}

/** Ordinary-language label for a shortest-to-edge measurement. */
function describeShortest(edge: ArtworkEdge): string {
  return `shortest distance to the ${edgeWord(edge)} edge (nearest point on that edge)`;
}

function isKnownEdge(edge: unknown): edge is ArtworkEdge {
  return edge === "minX" || edge === "maxX" || edge === "minY" || edge === "maxY";
}

function isKnownConvention(convention: unknown): convention is MeasurementConvention {
  return convention === "dx" || convention === "dy" || convention === "shortest-to-edge";
}

/**
 * Measure one edge-to-anchor distance from an exact rotated footprint.
 * Strictly refuses (never fabricates or reshapes) on invalid input: unknown
 * edge/convention, a dx/dy edge on the wrong axis, a non-finite anchor, a
 * footprint with fewer than 3 corners, or any non-finite corner.
 *
 * Endpoint contract (all conventions): `endpoints[1]` is ALWAYS the anchor
 * point; `endpoints[0]` is the artwork-side point. The drawable arrow runs
 * artwork→anchor.
 */
export function measureEdgeToAnchor(
  footprint: readonly MeasurementPoint[],
  anchor: MeasurementPoint,
  binding: { edge: ArtworkEdge; convention: MeasurementConvention },
): EdgeMeasurement {
  if (!isKnownEdge(binding.edge)) {
    return { ok: false, error: `unknown artwork edge "${String(binding.edge)}" (want minX|maxX|minY|maxY)` };
  }
  if (!isKnownConvention(binding.convention)) {
    return { ok: false, error: `unknown measurement convention "${String(binding.convention)}" (want dx|dy|shortest-to-edge)` };
  }
  if (binding.convention === "dx" && binding.edge !== "minX" && binding.edge !== "maxX") {
    return { ok: false, error: `dx measures horizontally, so the edge must be minX or maxX (not "${binding.edge}")` };
  }
  if (binding.convention === "dy" && binding.edge !== "minY" && binding.edge !== "maxY") {
    return { ok: false, error: `dy measures vertically, so the edge must be minY or maxY (not "${binding.edge}")` };
  }
  if (!isFinitePoint(anchor)) {
    return { ok: false, error: "anchor position must be finite { x, y } millimetres" };
  }
  if (footprint.length < 3) {
    return { ok: false, error: "artwork footprint must supply at least 3 corners" };
  }
  if (!footprint.every(isFinitePoint)) {
    return { ok: false, error: "artwork footprint corners must be finite { x, y } millimetres" };
  }
  const corners: MeasurementPoint[] = [...footprint];

  if (binding.convention === "dx" || binding.convention === "dy") {
    const horizontal = binding.convention === "dx";
    const wantMin = binding.edge === "minX" || binding.edge === "minY";
    let extent = wantMin ? Infinity : -Infinity;
    for (const corner of corners) {
      const value = horizontal ? corner.x : corner.y;
      extent = wantMin ? Math.min(extent, value) : Math.max(extent, value);
    }
    if (!Number.isFinite(extent)) {
      return { ok: false, error: "artwork footprint extent is not finite" };
    }
    const anchorPoint: MeasurementPoint = { x: anchor.x, y: anchor.y };
    const lineStart: MeasurementPoint = horizontal
      ? { x: extent, y: anchor.y }
      : { x: anchor.x, y: extent };
    // The drawable line touches the artwork only when its start lies on the
    // footprint boundary (within 1e-9): for an unrotated edge that is the
    // anchor ordinate falling within the edge span; under rotation only an
    // ordinate through the extreme corner still touches.
    let touchesArtwork = false;
    for (let i = 0; i < corners.length; i += 1) {
      const start = corners[i]!;
      const end = corners[(i + 1) % corners.length]!;
      const closest = closestPointOnSegment(lineStart, start, end);
      if (Math.hypot(lineStart.x - closest.x, lineStart.y - closest.y) <= 1e-9) {
        touchesArtwork = true;
        break;
      }
    }
    let artworkPoint: MeasurementPoint | undefined;
    if (!touchesArtwork) {
      const extreme = corners.filter(
        (corner) => Math.abs((horizontal ? corner.x : corner.y) - extent) <= 1e-9,
      );
      const pool = extreme.length > 0 ? extreme : corners;
      let best = pool[0]!;
      let bestDist = Math.hypot(best.x - lineStart.x, best.y - lineStart.y);
      for (const corner of pool) {
        const dist = Math.hypot(corner.x - lineStart.x, corner.y - lineStart.y);
        if (dist < bestDist) {
          bestDist = dist;
          best = corner;
        }
      }
      artworkPoint = { x: best.x, y: best.y };
    }
    const valueMm = horizontal ? anchor.x - extent : anchor.y - extent;
    if (!Number.isFinite(valueMm)) {
      return { ok: false, error: "measurement exceeds finite numeric range" };
    }
    const edgeDescription = describeOrthogonal(binding.edge, binding.convention, touchesArtwork);
    return {
      ok: true,
      valueMm,
      endpoints: [lineStart, anchorPoint],
      edgeDescription,
      touchesArtwork,
      ...(artworkPoint !== undefined ? { artworkPoint } : {}),
    };
  }

  // shortest-to-edge: the footprint side whose midpoint is extreme along the
  // named axis. Ties resolve to the lowest side index (deterministic).
  let bestIndex = 0;
  let bestScore = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const start = corners[i]!;
    const end = corners[(i + 1) % corners.length]!;
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const score = binding.edge === "minX" ? -midX : binding.edge === "maxX" ? midX
      : binding.edge === "minY" ? -midY : midY;
    if (i === 0 || score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  const start = corners[bestIndex]!;
  const end = corners[(bestIndex + 1) % corners.length]!;
  const closest = closestPointOnSegment(anchor, start, end);
  const valueMm = Math.hypot(anchor.x - closest.x, anchor.y - closest.y);
  if (!Number.isFinite(valueMm)) {
    return { ok: false, error: "measurement exceeds finite numeric range" };
  }
  return {
    ok: true,
    valueMm,
    endpoints: [closest, { x: anchor.x, y: anchor.y }],
    edgeDescription: describeShortest(binding.edge),
    touchesArtwork: true,
  };
}

function unfinished(reason: string): PlacementMeasure {
  return { dimensions: [], unfinished: [reason] };
}

function unfinishedAll(reasons: string[]): PlacementMeasure {
  return { dimensions: [], unfinished: [...reasons] };
}

/**
 * Resolvable human names for unfinished reasons. Internal geometry ids
 * (frames, calibrations) and customer logo ids never appear: an internal id
 * is quoted only when the entity itself is unknown and nothing else names
 * it. Product/variant identity stays (relevant production context).
 */
function productNameFor(candidate: ResultCandidate, productId: string): string | null {
  return candidate.products.find((entry) => entry.id === productId)?.name ?? null;
}

function regionNameFor(candidate: ResultCandidate, productId: string, regionId: string): string | null {
  const product = candidate.products.find((entry) => entry.id === productId);
  return product?.regions.find((entry) => entry.id === regionId)?.name ?? null;
}

/**
 * Resolve and measure every binding for one export placement against the
 * candidate's own product/region/frame/calibration snapshots.
 *
 * Each logo is measured independently: one binding's failure never affects
 * another logo or another binding of the same logo. Stale scope (anchor
 * product/variant/region/frame/calibration disagreeing with the placement
 * and its region), missing anchors, invalid bindings, and non-finite
 * geometry all yield explicit unfinished reasons, never guessed numbers.
 */
export function measurePlacement(
  candidate: ResultCandidate,
  placement: ExportPlacement,
  anchors: readonly AnchorDef[],
  bindings: readonly DimensionBinding[],
): PlacementMeasure {
  const product = candidate.products.find((entry) => entry.id === placement.productId);
  if (product === undefined) {
    return unfinished(`unknown product "${placement.productId}" for this placement; no measurement`);
  }
  const region = product.regions.find((entry) => entry.id === placement.regionId);
  if (region === undefined) {
    return unfinished(
      `unknown region "${placement.regionId}" on product ` +
      `"${productNameFor(candidate, placement.productId) ?? placement.productId}"; no measurement`,
    );
  }
  if (!product.variants.some((entry) => entry.id === placement.variantId)) {
    return unfinished(
      `unknown variant "${placement.variantId}" on product ` +
      `"${productNameFor(candidate, placement.productId) ?? placement.productId}"; no measurement`,
    );
  }
  if (placement.frame.frameId !== region.frame.frameId) {
    return unfinished(
      `placement frame does not match the frame of region ` +
      `"${region.name ?? placement.regionId}"; no measurement`,
    );
  }
  if (
    placement.calibration.calibrationId !== region.calibrationRef.calibrationId ||
    placement.calibration.version !== region.calibrationRef.version
  ) {
    return unfinished(
      `placement calibration does not match the calibration of region ` +
      `"${region.name ?? placement.regionId}"; no measurement`,
    );
  }
  if (
    !isFiniteNumber(placement.pos.xMm) || !isFiniteNumber(placement.pos.yMm) ||
    !isFiniteNumber(placement.widthMm) || !isFiniteNumber(placement.heightMm) ||
    !isFiniteNumber(placement.rotationDeg) ||
    !(placement.widthMm > 0) || !(placement.heightMm > 0)
  ) {
    return unfinished("placement size, position, or rotation is not finite (or not positive); no measurement");
  }

  const footprint = rotatedFootprintCorners(
    placement.pos.xMm,
    placement.pos.yMm,
    placement.widthMm,
    placement.heightMm,
    placement.rotationDeg,
  );

  const dimensions: ResolvedDimension[] = [];
  const unfinishedReasons: string[] = [];
  for (const binding of bindings) {
    const tag = `dimension "${binding.label}"`;
    if (!isKnownEdge(binding.edge) || !isKnownConvention(binding.convention)) {
      unfinishedReasons.push(
        `${tag}: invalid binding (edge "${String(binding.edge)}", convention ` +
        `"${String(binding.convention)}"); no measurement`,
      );
      continue;
    }
    const anchor = anchors.find((entry) => entry.id === binding.anchorId);
    if (anchor === undefined) {
      unfinishedReasons.push(`${tag}: unknown anchor "${binding.anchorId}"; no measurement`);
      continue;
    }
    if (anchor.productId !== placement.productId || anchor.variantId !== placement.variantId) {
      unfinishedReasons.push(
        `${tag}: anchor "${anchor.name}" is scoped to product "${anchor.productId}" ` +
        `variant "${anchor.variantId}", not this product "${placement.productId}" ` +
        `variant "${placement.variantId}"; no measurement`,
      );
      continue;
    }
    if (anchor.regionId !== placement.regionId) {
      unfinishedReasons.push(
        `${tag}: anchor "${anchor.name}" is scoped to region ` +
        `"${regionNameFor(candidate, anchor.productId, anchor.regionId) ?? anchor.regionId}", ` +
        `not this region "${region.name ?? placement.regionId}"; no measurement`,
      );
      continue;
    }
    if (anchor.frameId !== region.frame.frameId) {
      unfinishedReasons.push(
        `${tag}: anchor "${anchor.name}" frame does not match the frame of region ` +
        `"${region.name ?? placement.regionId}"; no measurement`,
      );
      continue;
    }
    if (
      anchor.calibrationId !== region.calibrationRef.calibrationId ||
      anchor.calibrationVersion !== region.calibrationRef.version
    ) {
      unfinishedReasons.push(
        `${tag}: anchor "${anchor.name}" calibration is stale for region ` +
        `"${region.name ?? placement.regionId}"; no measurement`,
      );
      continue;
    }
    if (
      !Array.isArray(anchor.posMm) || !isFiniteNumber(anchor.posMm[0]) ||
      !isFiniteNumber(anchor.posMm[1])
    ) {
      unfinishedReasons.push(`${tag}: anchor "${anchor.name}" position is not finite millimetres; no measurement`);
      continue;
    }
    const anchorPoint: MeasurementPoint = { x: anchor.posMm[0], y: anchor.posMm[1] };
    const measured = measureEdgeToAnchor(footprint, anchorPoint, {
      edge: binding.edge,
      convention: binding.convention,
    });
    if (!measured.ok) {
      unfinishedReasons.push(`${tag}: ${measured.error}; no measurement`);
      continue;
    }
    dimensions.push({
      label: binding.label,
      valueMm: measured.valueMm,
      fromAnchor: anchor.name,
      toEdge: measured.edgeDescription,
      endpoints: measured.endpoints,
      touchesArtwork: measured.touchesArtwork,
      ...(measured.artworkPoint !== undefined ? { artworkPoint: { ...measured.artworkPoint } } : {}),
    });
  }
  if (dimensions.length === 0 && unfinishedReasons.length === 0) {
    return unfinishedAll(["no anchor bindings supplied for this placement; unfinished"]);
  }
  return { dimensions, unfinished: unfinishedReasons };
}

function isDraftJob(value: unknown): value is OperationDraft["job"] {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  for (const key of ["customer", "reference", "article"] as const) {
    const entry = candidate[key];
    if (entry !== undefined && typeof entry !== "string") return false;
  }
  return true;
}

function isAnchorList(value: unknown): value is OperationDraft["anchors"] {
  return Array.isArray(value);
}

function isDimensionList(value: unknown): value is OperationDraft["dimensions"] {
  return Array.isArray(value);
}

/**
 * Structural guard for a reopened local draft sidecar. Checks the versioned
 * shape only (never the source binding): a structurally valid draft can still
 * be stale for the current candidate — use `isStaleDraft` for that decision.
 * Never throws; malformed input reads as absent.
 */
export function isOperationDraft(value: unknown): value is OperationDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["version"] === OPERATION_DRAFT_VERSION &&
    candidate["draftVersion"] === OPERATION_DRAFT_NUMBER &&
    isFiniteNumber(candidate["sourceRevision"]) &&
    typeof candidate["sourceDigest"] === "string" &&
    (candidate["sourceDigest"] as string).length > 0 &&
    (candidate["configurationId"] === undefined ||
      typeof candidate["configurationId"] === "string") &&
    isDraftJob(candidate["job"]) &&
    typeof candidate["operationalInstructions"] === "string" &&
    (candidate["methodParams"] === undefined ||
      (typeof candidate["methodParams"] === "object" &&
        candidate["methodParams"] !== null &&
        Object.values(candidate["methodParams"] as Record<string, unknown>).every(
          (entry) => typeof entry === "string",
        ))) &&
    isAnchorList(candidate["anchors"]) &&
    isDimensionList(candidate["dimensions"]) &&
    (candidate["updatedNote"] === undefined || typeof candidate["updatedNote"] === "string")
  );
}

/**
 * Pure staleness check for a saved local draft against the current
 * candidate: stale when the draft is structurally invalid (refuse review,
 * never rebuild from it) or when its recorded source revision/digest no
 * longer matches the candidate. Never throws; never fabricates.
 */
export function isStaleDraft(
  draft: unknown,
  candidateDigest: string,
  candidateRevision: number,
): boolean {
  if (!isOperationDraft(draft)) return true;
  return draft.sourceDigest !== candidateDigest || draft.sourceRevision !== candidateRevision;
}
