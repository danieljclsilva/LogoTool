import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rotatedFootprintCorners } from "../src/core/operation-measurements/index.js";
import {
  cornerSafeMeasurements,
  footprintCornersMm,
  rotationSnapDeg,
  snapFootprint,
  resizeFromCornerMm,
} from "../src/core/placement-manipulation/index.js";
import type { Footprint, MmPolygon } from "../src/core/placement-manipulation/index.js";

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

// Concave L-shape: bottom bar [0,10]x[0,5] plus left bar [0,5]x[5,10].
const L_SHAPE: MmPolygon = [
  [0, 0],
  [10, 0],
  [10, 5],
  [5, 5],
  [5, 10],
  [0, 10],
];

const SQUARE: MmPolygon = [
  [-10, -10],
  [10, -10],
  [10, 10],
  [-10, 10],
];

describe("footprintCornersMm matches operation-measurements convention", () => {
  it("zero rotation is an exact axis-aligned box", () => {
    const f: Footprint = { cx: 10, cy: 20, widthMm: 40, heightMm: 20, rotationDeg: 0 };
    const got = footprintCornersMm(f);
    assert.deepEqual(got, [
      { x: -10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      { x: -10, y: 30 },
    ]);
  });

  it("agrees with rotatedFootprintCorners for rotated cases", () => {
    for (const rotationDeg of [90, 33, -17.5, 180]) {
      const f: Footprint = { cx: 4, cy: -6, widthMm: 40, heightMm: 20, rotationDeg };
      const got = footprintCornersMm(f);
      const want = rotatedFootprintCorners(4, -6, 40, 20, rotationDeg);
      assert.equal(got.length, 4);
      for (let i = 0; i < 4; i += 1) {
        assert.ok(
          approx(got[i]!.x, want[i]!.x) && approx(got[i]!.y, want[i]!.y),
          `corner ${i} at rotation ${rotationDeg}`,
        );
      }
    }
  });

  it("90-degree hand computation: local (dx,dy) -> (cx+dy, cy-dx)", () => {
    const f: Footprint = { cx: 0, cy: 0, widthMm: 10, heightMm: 6, rotationDeg: 90 };
    const got = footprintCornersMm(f);
    const want = [
      { x: -3, y: 5 },
      { x: -3, y: -5 },
      { x: 3, y: -5 },
      { x: 3, y: 5 },
    ];
    for (let i = 0; i < 4; i += 1) {
      assert.ok(approx(got[i]!.x, want[i]!.x) && approx(got[i]!.y, want[i]!.y), `corner ${i}`);
    }
  });
});

describe("cornerSafeMeasurements on arbitrary concave polygons", () => {
  it("measures true point-to-segment distances (hand-computed)", () => {
    // Point footprint (3,2): nearest boundary is bottom edge y=0 at (3,0), d=2.
    const f: Footprint = { cx: 3, cy: 2, widthMm: 0, heightMm: 0, rotationDeg: 0 };
    const got = cornerSafeMeasurements(f, L_SHAPE);
    assert.equal(got.length, 4);
    for (const m of got) {
      assert.deepEqual(m.nearest, { x: 3, y: 0 });
      assert.equal(m.edgeIndex, 0);
      assert.ok(approx(m.distanceMm, 2));
    }
  });

  it("finds the reflex-notch edges of a concave polygon", () => {
    // Point footprint (7,8): nearest is the notch wall x=5 at (5,8), d=2 (edge 3).
    const f: Footprint = { cx: 7, cy: 8, widthMm: 0, heightMm: 0, rotationDeg: 0 };
    const got = cornerSafeMeasurements(f, L_SHAPE);
    assert.equal(got.length, 4);
    assert.deepEqual(got[0]!.nearest, { x: 5, y: 8 });
    assert.equal(got[0]!.edgeIndex, 3);
    assert.ok(approx(got[0]!.distanceMm, 2));
  });

  it("breaks equidistant ties deterministically (first edge wins)", () => {
    // (7,7) is d=2 from both edge 2 (notch floor) and edge 3 (notch wall).
    const f: Footprint = { cx: 7, cy: 7, widthMm: 0, heightMm: 0, rotationDeg: 0 };
    const got = cornerSafeMeasurements(f, L_SHAPE);
    assert.deepEqual(got[0]!.nearest, { x: 7, y: 5 });
    assert.equal(got[0]!.edgeIndex, 2);
    assert.ok(approx(got[0]!.distanceMm, 2));
  });

  it("measures rotated footprint corners against a square", () => {
    const f: Footprint = { cx: 0, cy: 0, widthMm: 10, heightMm: 6, rotationDeg: 90 };
    const got = cornerSafeMeasurements(f, SQUARE);
    assert.equal(got.length, 4);
    // corner0 (-3,5) -> top edge (edge 2) at (-3,10), d=5.
    assert.ok(approx(got[0]!.corner.x, -3) && approx(got[0]!.corner.y, 5));
    assert.ok(approx(got[0]!.nearest.x, -3) && approx(got[0]!.nearest.y, 10));
    assert.equal(got[0]!.edgeIndex, 2);
    assert.ok(approx(got[0]!.distanceMm, 5));
    // corner1 (-3,-5) -> bottom edge (edge 0) at (-3,-10), d=5.
    assert.ok(approx(got[1]!.nearest.x, -3) && approx(got[1]!.nearest.y, -10));
    assert.equal(got[1]!.edgeIndex, 0);
    assert.ok(approx(got[1]!.distanceMm, 5));
    for (const m of got) {
      assert.ok(Number.isFinite(m.distanceMm) && m.distanceMm >= 0);
    }
  });

  it("returns [] for invalid polygons without throwing", () => {
    const f: Footprint = { cx: 0, cy: 0, widthMm: 10, heightMm: 10, rotationDeg: 0 };
    assert.deepEqual(cornerSafeMeasurements(f, []), []);
    assert.deepEqual(
      cornerSafeMeasurements(f, [
        [0, 0],
        [1, 1],
      ]),
      [],
    );
    assert.deepEqual(
      cornerSafeMeasurements(f, [[Number.NaN, 0], [1, 0], [0, 1]] as unknown as MmPolygon),
      [],
    );
    assert.deepEqual(
      cornerSafeMeasurements(f, "nope" as unknown as MmPolygon),
      [],
    );
  });
});

describe("snapFootprint", () => {
  const rect: MmPolygon = [
    [0, 0],
    [100, 0],
    [100, 60],
    [0, 60],
  ];

  it("snaps the centre to the safe polygon centre within tolerance", () => {
    const f: Footprint = { cx: 50.5, cy: 29.2, widthMm: 20, heightMm: 10, rotationDeg: 0 };
    const got = snapFootprint(f, rect);
    assert.equal(got.cx, 50);
    assert.equal(got.cy, 30);
    assert.equal(got.snappedPosition, true);
    assert.ok(got.guides.some((g) => g.kind === "v-center" && g.valueMm === 50));
    assert.ok(got.guides.some((g) => g.kind === "h-center" && g.valueMm === 30));
  });

  it("aligns the footprint with real safe sides and leaves distant centres alone", () => {
    const edge = snapFootprint(
      { cx: 11.2, cy: 54, widthMm: 20, heightMm: 10, rotationDeg: 0 },
      rect,
    );
    assert.equal(edge.cx, 10);
    assert.equal(edge.cy, 55);
    assert.equal(edge.snappedPosition, true);
    assert.ok(edge.guides.some((g) => g.kind === "v-edge"));
    assert.ok(edge.guides.some((g) => g.kind === "h-edge"));

    const far = snapFootprint(
      { cx: 80, cy: 20, widthMm: 20, heightMm: 10, rotationDeg: 0 },
      rect,
    );
    assert.equal(far.cx, 80);
    assert.equal(far.cy, 20);
    assert.equal(far.snappedPosition, false);
  });


  it("never snaps the logo centre onto a boundary or a bounding-box fiction", () => {
    const f: Footprint = { cx: 1.2, cy: 40, widthMm: 20, heightMm: 10, rotationDeg: 0 };
    const got = snapFootprint(f, rect);
    assert.equal(got.cx, 1.2);
    const diamond: MmPolygon = [[0, 50], [50, 0], [0, -50], [-50, 0]];
    const diagonal = snapFootprint({ cx: 24, cy: 15, widthMm: 10, heightMm: 10, rotationDeg: 0 }, diamond);
    assert.ok(approx(diagonal.cx, 24.5));
    assert.ok(approx(diagonal.cy, 15.5));
    assert.ok(diagonal.guides.some((g) => g.fromMm && g.toMm));
    const reversed = snapFootprint({ cx: 24, cy: 15, widthMm: 10, heightMm: 10, rotationDeg: 0 }, [...diamond].reverse());
    assert.ok(approx(reversed.cx, diagonal.cx) && approx(reversed.cy, diagonal.cy));
  });

  it("uses polygon centroid rather than bbox centre for triangular areas", () => {
    const triangle: MmPolygon = [[0, 0], [120, 0], [0, 120]];
    const got = snapFootprint({ cx: 40.5, cy: 39.5, widthMm: 10, heightMm: 10, rotationDeg: 0 }, triangle);
    assert.equal(got.cx, 40);
    assert.equal(got.cy, 40);
  });

  it("unsnapped escape disables all snapping", () => {
    const f: Footprint = { cx: 50.5, cy: 29.2, widthMm: 20, heightMm: 10, rotationDeg: 1.5 };
    const got = snapFootprint(f, rect, { unsnapped: true });
    assert.equal(got.cx, 50.5);
    assert.equal(got.cy, 29.2);
    assert.equal(got.rotationDeg, 1.5);
    assert.equal(got.snappedPosition, false);
    assert.equal(got.snappedRotation, false);
    assert.deepEqual(got.guides, []);
  });

  it("snaps near-cardinal rotations and normalizes output", () => {
    const got = snapFootprint(
      { cx: 80, cy: 20, widthMm: 20, heightMm: 10, rotationDeg: 1.5 },
      rect,
    );
    assert.equal(got.rotationDeg, 0);
    assert.equal(got.snappedRotation, true);
    assert.ok(got.guides.some((g) => g.kind === "angle"));

    const wrapped = snapFootprint(
      { cx: 80, cy: 20, widthMm: 20, heightMm: 10, rotationDeg: 190 },
      rect,
    );
    assert.ok(wrapped.rotationDeg > -180 && wrapped.rotationDeg <= 180);
    assert.ok(approx(wrapped.rotationDeg, -170));
  });

  it("never mutates inputs and always returns finite numbers", () => {
    const f: Footprint = { cx: 50.5, cy: 29.2, widthMm: 20, heightMm: 10, rotationDeg: 1.5 };
    const before = JSON.stringify(f);
    const got = snapFootprint(f, rect);
    assert.equal(JSON.stringify(f), before);
    for (const v of [got.cx, got.cy, got.rotationDeg, got.widthMm, got.heightMm]) {
      assert.ok(Number.isFinite(v));
    }
  });

  it("is total on garbage input and invalid polygons", () => {
    const bad = snapFootprint(
      { cx: Number.NaN, cy: 1, widthMm: -5, heightMm: 2, rotationDeg: Number.NaN },
      [],
    );
    assert.ok(Number.isFinite(bad.cx));
    assert.ok(Number.isFinite(bad.rotationDeg));
    assert.equal(bad.snappedPosition, false);
    // Cardinal rotation snap still applies with an invalid polygon.
    const card = snapFootprint(
      { cx: 80, cy: 20, widthMm: 20, heightMm: 10, rotationDeg: 1 },
      [],
    );
    assert.equal(card.rotationDeg, 0);
    assert.equal(card.snappedRotation, true);
  });
});

describe("rotationSnapDeg", () => {
  it("snaps to safe-polygon edge angles", () => {
    // Diamond edges sit at +/-45 degrees in footprint-rotation terms.
    const diamond: MmPolygon = [
      [0, 50],
      [50, 0],
      [0, -50],
      [-50, 0],
    ];
    const got = rotationSnapDeg(44, diamond, 2);
    assert.equal(got.snapped, true);
    assert.ok(approx(got.rotationDeg, 45));
    assert.ok(got.guides.some((g) => g.kind === "angle"));
  });

  it("leaves distant rotations alone and honors the escape flag", () => {
    const rect: MmPolygon = [
      [0, 0],
      [100, 0],
      [100, 60],
      [0, 60],
    ];
    const miss = rotationSnapDeg(45, rect, 2);
    assert.equal(miss.snapped, false);
    assert.ok(approx(miss.rotationDeg, 45));
    assert.deepEqual(miss.guides, []);

    const escaped = rotationSnapDeg(1.5, rect, 2, true);
    assert.equal(escaped.snapped, false);
    assert.ok(approx(escaped.rotationDeg, 1.5));
    assert.deepEqual(escaped.guides, []);
  });
});


describe("resizeFromCornerMm", () => {
  it("keeps the opposite physical corner fixed for every handle and rotation", () => {
    for (const rotationDeg of [0, 33, -90, 179]) for (let corner = 0; corner < 4; corner++) {
      const base = { cx: 20, cy: -15, widthMm: 80, heightMm: 40, rotationDeg };
      const before = footprintCornersMm(base);
      const desired = { ...base, widthMm: 120, heightMm: 60 };
      const local = footprintCornersMm(desired)[corner]!;
      const pointer = { x: before[corner]!.x + (local.x - before[corner]!.x) * 2,
        y: before[corner]!.y + (local.y - before[corner]!.y) * 2 };
      const resized = resizeFromCornerMm(base, corner, pointer);
      const after = footprintCornersMm(resized);
      assert.ok(approx(resized.widthMm, 120)); assert.ok(approx(resized.heightMm, 60));
      const fixed = (corner + 2) % 4;
      assert.ok(approx(after[fixed]!.x, before[fixed]!.x));
      assert.ok(approx(after[fixed]!.y, before[fixed]!.y));
      assert.ok(approx(after[corner]!.x, pointer.x)); assert.ok(approx(after[corner]!.y, pointer.y));
    }
  });
  it("clamps a crossing handle without flipping or moving its opposite corner", () => {
    const base = { cx: 0, cy: 0, widthMm: 40, heightMm: 20, rotationDeg: 0 };
    const resized = resizeFromCornerMm(base, 2, { x: -100, y: -100 });
    assert.equal(resized.widthMm, 1); assert.equal(resized.heightMm, 1);
    assert.deepEqual(footprintCornersMm(resized)[0], { x: -20, y: -10 });
  });
});
