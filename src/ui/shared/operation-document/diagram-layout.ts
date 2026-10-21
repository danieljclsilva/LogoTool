/**
 * Fixed-diagram-space math for the exterior technical dimension lanes.
 *
 * Pure; no DOM, no pixels-as-truth, no measurement logic. The caller supplies
 * true mapped photo-pixel points (already forward-mapped through the exact
 * evaluated photo-mapping affine); this module only decides WHERE in the
 * fixed drawing space (photo rectangle plus white gutters around it) the
 * dimension lanes, witness segments, and gutter labels live.
 *
 * Drawing units are photo pixels, so the evaluated mapping math passes
 * through untouched. Print sizing is derived from the FIXED diagram space
 * (the A4-landscape print caps below), never from source-photo pixels:
 * `fontPx` is chosen so gutter labels print at or above ~9pt when the figure
 * renders at its intended print size.
 *
 * Geometry contract:
 * - Every drawn lane is the ORIGINAL mapped segment translated by ONE
 *   perpendicular vector applied to BOTH endpoints. The lane delta is the
 *   mapped delta copied verbatim (`x2 = x1 + dx`, `y2 = y1 + dy`, where
 *   `dx`/`dy` are computed once from the inputs), never re-projected, so a
 *   diagonal such as [300, 200] stays [300, 200] (the old extent-projection
 *   drew [300, 0]) and rotation/shear correctness comes free with no
 *   special-casing.
 * - The offset direction points at the assigned gutter: the perpendicular
 *   with negative photo-y for horizontal-dominant dims (top gutter) or
 *   positive photo-x for vertical-dominant dims (right gutter). The
 *   dominant-axis rule is unchanged: horizontal iff |dx| >= |dy|.
 * - The offset magnitude is the minimum that places the WHOLE lane group
 *   (line plus value-label box) strictly outside the photo rect with a
 *   small margin, stacked monotonically outward so lanes never collide.
 *   Gutters and the viewBox grow to fit; nothing is clamped or shrunk.
 * - Witness segments join each lane end back to its true mapped point
 *   (copied verbatim, never clamped).
 * - Zero-length measurements (p0 ~= p1 within 1e-9) draw NO arrow line: a
 *   zero-length arrow is meaningless and any widened span would invent
 *   geometry. The layout is marked `coincident`; the caller draws one small
 *   open circle at the true point plus the value label in the nearest gutter
 *   with a leader (`w0`) to the point. The logo panel already states the
 *   measured 0.0.
 */

export interface DiagramArrowInput {
  /** True mapped photo-pixel endpoints (drawing transform is free). */
  p0: { x: number; y: number };
  p1: { x: number; y: number };
  /** Gutter label text, e.g. "1 · 20.0 mm". */
  label: string;
}

export interface DiagramArrowLayout {
  axis: "h" | "v";
  /**
   * True when the mapped segment is zero-length (see above): no
   * `line.opsheet-arrow` is drawn. `x1`/`y1`/`x2`/`y2` all equal the true
   * point (drawing coordinates) for the open circle; `w0` is the
   * label-to-point leader (`w1` repeats `w0` and is not drawn).
   */
  coincident: boolean;
  /**
   * Dimension-line endpoints in drawing coordinates. The delta is the mapped
   * delta copied verbatim (never re-projected), so
   * `x2 - x1 === p1.x - p0.x` up to floating-point rounding.
   */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Witness segments: dim-line end back to the true mapped point. */
  w0: { x1: number; y1: number; x2: number; y2: number };
  w1: { x1: number; y1: number; x2: number; y2: number };
  /** Gutter label anchor in drawing coordinates. */
  lx: number;
  ly: number;
  /** Vertical-dim labels read bottom-to-top alongside their lane. */
  rotate: boolean;
}

export interface DiagramLayout {
  photoW: number;
  photoH: number;
  /** Photo-frame x origin in drawing coordinates (grows only when lanes extend left of the photo). */
  frameX: number;
  /** White top gutter height (also the photo-frame y origin). */
  top: number;
  /** White right gutter width. */
  right: number;
  viewW: number;
  viewH: number;
  /** Gutter label size in drawing units (>= ~9pt at intended print size). */
  fontPx: number;
  /** Stroke widths in drawing units (print-safe at intended print size). */
  strokeArrow: number;
  strokeWitness: number;
  /** Arrowhead marker size in drawing units. */
  markerSize: number;
  /** Anchor-marker circle radius in drawing units. */
  anchorR: number;
  /** Zero-measurement open-circle radius in drawing units (rings the point). */
  coincidentR: number;
  arrows: DiagramArrowLayout[];
}

/**
 * Intended print height of one photo figure (mm). The stylesheet caps the
 * rendered SVG at this height. The cap covers the whole figure (photo plus
 * dimension lanes); the photo itself prints larger than under the old
 * gutter-inclusive cap because lanes are extra above/beside it rather than
 * carved out of it — roughly 60mm for deep low-lying dimensions, ~70mm and
 * up for ordinary high-chest jobs with small gutters.
 */
export const DIAGRAM_PRINT_CAP_MM = 84;

/**
 * Narrowest intended print column for one photo figure (mm).
 *
 * Derived from the actual proof-column width in the adaptive FlexiTog
 * stage (A4 landscape content width is 277mm = 297mm minus 2x10mm
 * margins). The stage reserves roughly 60% (~165mm after the stage gap)
 * for proofs: one view fills it, two views split it (~80mm each after
 * figure padding), and 3+ views reflow full-width in rows of three
 * (~88mm each). The tightest routine column is therefore the two-view
 * split at ~80mm, so the label size is solved against 80mm: labels print
 * at or above ~9pt even in the tightest column and only grow in wider
 * ones. Never shrink labels to force a fit.
 */
export const DIAGRAM_MIN_COLUMN_MM = 80;

/** Minimum gutter label height target (mm, ≈9.4pt, above the 9pt floor). */
const LABEL_MIN_MM = 3.3;

/** Squared-tolerance inputs at or below this length count as zero (photo px). */
const ZERO_TOL = 1e-9;

/** Small strict-outside margin beyond the photo rect, in label-size multiples. */
const MARGIN_K = 0.3;
/** Label-centre distance beyond its lane line, in label-size multiples. */
const LIFT_K = 1.1;
/** Separation between stacked lane groups, in label-size multiples. */
const STACK_GAP_K = 0.8;
/** Label half-depth across its reading direction, in label-size multiples. */
const LABEL_ACROSS_K = 0.75;
/** Label end padding along its reading direction, in label-size multiples. */
const LABEL_PAD_K = 0.3;

/** Advance estimate for gutter label measuring (system font stack). */
const ADVANCE = 0.6;

function isFinitePoint(point: { x: number; y: number }): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

interface PlacedPoint {
  x: number;
  y: number;
}

/**
 * Place every lane in photo coordinates for one label size, then fit the
 * drawing frame (photo origin plus gutters) around the photo and all lane
 * content. Deterministic; input order fixes lane order and stacking.
 */
function placeAll(
  photoW: number,
  photoH: number,
  clean: DiagramArrowInput[],
  fontPx: number,
): DiagramLayout {
  const margin = MARGIN_K * fontPx;
  const lift = LIFT_K * fontPx;
  const stackGap = STACK_GAP_K * fontPx;
  const across = LABEL_ACROSS_K * fontPx;
  const pad = LABEL_PAD_K * fontPx;

  // Content bounds in photo coordinates (seeded with the photo corners).
  let minX = 0;
  let minY = 0;
  let maxX = photoW;
  let maxY = photoH;
  const track = (point: PlacedPoint): void => {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  };

  // Placed label boxes per gutter (photo coordinates). A new lane keeps its
  // rigid parallel offset but shifts far enough outward that its label box
  // clears every same-gutter label it would otherwise overlap, so gutter
  // labels can never collide. Lanes at disjoint positions never push each
  // other; the shift only ever grows, so the fixpoint below terminates.
  interface LabelBox {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }
  const placedTop: LabelBox[] = [];
  const placedRight: LabelBox[] = [];

  interface PhotoLane {
    axis: "h" | "v";
    coincident: boolean;
    /** Lane-line ends (photo coordinates); both equal the true point when coincident. */
    a: PlacedPoint;
    delta: PlacedPoint;
    /** True mapped points (photo coordinates). */
    p0: PlacedPoint;
    p1: PlacedPoint;
    /** Label centre (photo coordinates). */
    c: PlacedPoint;
    rotate: boolean;
  }
  const lanes: PhotoLane[] = clean.map((dim) => {
    const dx = dim.p1.x - dim.p0.x;
    const dy = dim.p1.y - dim.p0.y;
    const length = Math.hypot(dx, dy);
    const coincident = !(length > ZERO_TOL);
    let axis: "h" | "v";
    let dir: PlacedPoint;
    let mid: PlacedPoint;
    if (coincident) {
      // Nearest gutter decides the label orientation: distance to the top
      // gutter zone (~p.y) versus the right gutter zone (~photoW - p.x).
      axis = dim.p0.y <= photoW - dim.p0.x ? "h" : "v";
      dir = axis === "h" ? { x: 0, y: -1 } : { x: 1, y: 0 };
      mid = { x: dim.p0.x, y: dim.p0.y };
    } else {
      axis = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
      let nx = -dy / length;
      let ny = dx / length;
      if (axis === "h") {
        // Toward the top gutter: negative photo-y. Non-degenerate because a
        // horizontal-dominant non-zero segment always has dx !== 0.
        if (ny > 0) {
          nx = -nx;
          ny = -ny;
        }
      } else if (nx < 0) {
        // Toward the right gutter: positive photo-x.
        nx = -nx;
        ny = -ny;
      }
      dir = { x: nx, y: ny };
      mid = { x: (dim.p0.x + dim.p1.x) / 2, y: (dim.p0.y + dim.p1.y) / 2 };
    }
    // Outward rate along the offset direction (always positive: 1 for the
    // gutter-normal zero case, >= 1/sqrt(2) for true perpendiculars).
    const rate = axis === "h" ? -dir.y : dir.x;
    const textW = dim.label.length * ADVANCE * fontPx;
    const halfLong = textW / 2 + pad;
    const hw = axis === "h" ? halfLong : across;
    const hh = axis === "h" ? across : halfLong;
    // Label centre at base offset (t = 0); the whole group then shifts rigidly.
    const c0 = { x: mid.x + lift * dir.x, y: mid.y + lift * dir.y };
    const base: PlacedPoint[] = coincident
      ? []
      : [{ x: dim.p0.x, y: dim.p0.y }, { x: dim.p1.x, y: dim.p1.y }];
    const corners: PlacedPoint[] = [
      { x: c0.x - hw, y: c0.y - hh },
      { x: c0.x + hw, y: c0.y - hh },
      { x: c0.x - hw, y: c0.y + hh },
      { x: c0.x + hw, y: c0.y + hh },
    ];
    // Minimum shift placing every sample strictly outside the photo rect
    // with the small margin: past the top edge for the top gutter (the
    // maximum-y sample exits last), past the right edge for the right
    // gutter (the minimum-x sample exits last).
    let required = 0;
    for (const sample of [...base, ...corners]) {
      const need = axis === "h" ? sample.y + margin : photoW + margin - sample.x;
      const candidate = need / rate;
      if (candidate > required) required = candidate;
    }
    const boxAt = (shift: number): LabelBox => {
      const xs = corners.map((corner) => corner.x + shift * dir.x);
      const ys = corners.map((corner) => corner.y + shift * dir.y);
      return {
        x0: Math.min(...xs),
        x1: Math.max(...xs),
        y0: Math.min(...ys),
        y1: Math.max(...ys),
      };
    };
    // Grow the shift until the label box clears the photo (via `required`)
    // and every same-gutter label box it would otherwise overlap. Motion is
    // along one fixed outward ray, so box-vs-box overlap in shift space is
    // one interval per placed box: jumping past it never re-overlaps, and
    // the loop terminates (the cap is far above realistic lane counts).
    const laneBoxes = axis === "h" ? placedTop : placedRight;
    let t = Math.max(required, 0);
    for (let attempt = 0; attempt < 16; attempt++) {
      const box = boxAt(t);
      let advanced = false;
      for (const other of laneBoxes) {
        if (axis === "h") {
          const xOverlap = box.x0 < other.x1 && box.x1 > other.x0;
          const yOverlap = box.y1 > other.y0 - stackGap && box.y0 < other.y1 + stackGap;
          if (xOverlap && yOverlap) {
            const need = (boxAt(0).y1 - other.y0 + stackGap) / rate;
            if (need > t) {
              t = need;
              advanced = true;
            }
          }
        } else {
          const yOverlap = box.y0 < other.y1 && box.y1 > other.y0;
          const xOverlap = box.x1 > other.x0 - stackGap && box.x0 < other.x1 + stackGap;
          if (xOverlap && yOverlap) {
            const need = (other.x1 + stackGap - boxAt(0).x0) / rate;
            if (need > t) {
              t = need;
              advanced = true;
            }
          }
        }
      }
      if (!advanced) break;
    }
    // Rigid shift: line ends, label centre, and (below) label corners all
    // move by the same vector, so the lane delta is preserved exactly.
    const a = coincident
      ? { x: dim.p0.x, y: dim.p0.y }
      : { x: dim.p0.x + t * dir.x, y: dim.p0.y + t * dir.y };
    const c = { x: c0.x + t * dir.x, y: c0.y + t * dir.y };
    const placed: PlacedPoint[] = [
      a,
      coincident ? a : { x: a.x + dx, y: a.y + dy },
      { x: c.x - hw, y: c.y - hh },
      { x: c.x + hw, y: c.y - hh },
      { x: c.x - hw, y: c.y + hh },
      { x: c.x + hw, y: c.y + hh },
      ...base,
    ];
    for (const point of placed) track(point);
    laneBoxes.push(boxAt(t));
    return {
      axis,
      coincident,
      a,
      delta: { x: dx, y: dy },
      p0: { x: dim.p0.x, y: dim.p0.y },
      p1: { x: dim.p1.x, y: dim.p1.y },
      c,
      rotate: axis === "v",
    };
  });

  // The frame grows to fit: photo origin shifts right/down only when lane
  // content escapes the photo rect; gutters cover the rest. Zero lanes keep
  // the R1-compatible origin (frameX 0, top 0).
  const frameX = minX < 0 ? -minX + margin : 0;
  const top = minY < 0 ? -minY + margin : 0;
  const right = Math.max(0, maxX - photoW + margin);
  const bottomExtra = Math.max(0, maxY - photoH + margin);
  const viewW = frameX + photoW + right;
  const viewH = top + photoH + bottomExtra;
  const draw = (point: PlacedPoint): PlacedPoint => ({ x: point.x + frameX, y: point.y + top });

  const arrows: DiagramArrowLayout[] = lanes.map((lane) => {
    const c = draw(lane.c);
    const q0 = draw(lane.p0);
    const q1 = draw(lane.p1);
    if (lane.coincident) {
      const leader = { x1: c.x, y1: c.y, x2: q0.x, y2: q0.y };
      return {
        axis: lane.axis,
        coincident: true,
        x1: q0.x,
        y1: q0.y,
        x2: q0.x,
        y2: q0.y,
        w0: leader,
        w1: leader,
        lx: c.x,
        ly: c.y,
        rotate: lane.rotate,
      };
    }
    const a = draw(lane.a);
    // The delta is copied verbatim from the mapped inputs — never
    // re-projected — so rotation/shear survive the offset bit-for-bit up to
    // floating-point rounding.
    const b = { x: a.x + lane.delta.x, y: a.y + lane.delta.y };
    return {
      axis: lane.axis,
      coincident: false,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      w0: { x1: a.x, y1: a.y, x2: q0.x, y2: q0.y },
      w1: { x1: b.x, y1: b.y, x2: q1.x, y2: q1.y },
      lx: c.x,
      ly: c.y,
      rotate: lane.rotate,
    };
  });

  return {
    photoW,
    photoH,
    frameX,
    top,
    right,
    viewW,
    viewH,
    fontPx,
    strokeArrow: fontPx * 0.12,
    strokeWitness: fontPx * 0.07,
    markerSize: fontPx * 0.55,
    anchorR: fontPx * 0.55,
    coincidentR: fontPx * 0.9,
    arrows,
  };
}

/**
 * Lay out one side figure: photo rectangle plus one exterior gutter lane per
 * drawn arrow. Deterministic; input order fixes lane order. Label anchors
 * always land outside the photo rect; the viewBox grows to fit instead of
 * clipping. Returns null only for non-positive photo dimensions.
 */
export function layoutDiagram(
  photoW: number,
  photoH: number,
  dims: ReadonlyArray<DiagramArrowInput>,
): DiagramLayout | null {
  if (!Number.isFinite(photoW) || !Number.isFinite(photoH) || !(photoW > 0) || !(photoH > 0)) {
    return null;
  }
  const clean = dims.filter((dim) =>
    isFinitePoint(dim.p0) && isFinitePoint(dim.p1) && typeof dim.label === "string",
  );
  // Two-pass font sizing: a photo-proportional seed fixes provisional lanes,
  // then the label size is solved from the FIXED diagram space against both
  // print caps (height-bound and width-bound renderings) with a ~10% margin.
  // Bounded and deterministic.
  const seed = 0.045 * Math.max(photoW, photoH);
  const provisional = placeAll(photoW, photoH, clean, seed);
  const fontPx = Math.max(
    (LABEL_MIN_MM * 1.1 * provisional.viewH) / DIAGRAM_PRINT_CAP_MM,
    (LABEL_MIN_MM * 1.1 * provisional.viewW) / DIAGRAM_MIN_COLUMN_MM,
  );
  return placeAll(photoW, photoH, clean, fontPx);
}

/**
 * Spreadsheet-style anchor code for the n-th distinct anchor on a sheet
 * (0-based): A..Z, AA..AZ, BA.. — always 1–2 characters for the first 702
 * anchors, so marker text never violates the 2-character photo overlay cap.
 */
export function anchorCode(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (index < 0 || !Number.isInteger(index)) return "?";
  if (index < 26) return alphabet[index]!;
  const high = Math.floor(index / 26) - 1;
  const low = index % 26;
  if (high < 26) return `${alphabet[high]!}${alphabet[low]!}`;
  return `${alphabet[high % 26]!}${alphabet[low]!}`.slice(-2);
}
