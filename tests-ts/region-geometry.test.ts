import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateSafePolygon,
  pointInPolygon,
  footprintFits,
} from "../src/core/index.js";
import type { GeoPoint } from "../src/core/index.js";

const square: GeoPoint[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

const squareCW: GeoPoint[] = [
  { x: 0, y: 0 },
  { x: 0, y: 10 },
  { x: 10, y: 10 },
  { x: 10, y: 0 },
];

const triangle: GeoPoint[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 5, y: 8 },
];

// Concave arrow/C-shape: notch cut out of the top edge.
const concave: GeoPoint[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 6, y: 10 },
  { x: 6, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 10 },
  { x: 0, y: 10 },
];

describe("validateSafePolygon accepts good rings", () => {
  it("accepts a square", () => {
    assert.deepEqual(validateSafePolygon(square), { ok: true });
  });

  it("accepts a triangle", () => {
    assert.deepEqual(validateSafePolygon(triangle), { ok: true });
  });

  it("accepts a concave polygon", () => {
    assert.deepEqual(validateSafePolygon(concave), { ok: true });
  });

  it("accepts either winding", () => {
    assert.deepEqual(validateSafePolygon(squareCW), { ok: true });
  });

  it("accepts explicit closure repeating the first vertex", () => {
    assert.deepEqual(
      validateSafePolygon([...square, { x: 0, y: 0 }]),
      { ok: true },
    );
  });
});

describe("validateSafePolygon rejects bad rings", () => {
  it("rejects a bowtie (self-intersecting) polygon", () => {
    const bowtie: GeoPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    const result = validateSafePolygon(bowtie);
    assert.equal(result.ok, false);
    assert.ok(
      result.ok === false &&
        result.errors.some((message) => message.includes("self-intersecting")),
    );
  });

  it("rejects fewer than 3 vertices", () => {
    assert.deepEqual(
      validateSafePolygon([{ x: 0, y: 0 }]).ok,
      false,
    );
    assert.deepEqual(
      validateSafePolygon([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]).ok,
      false,
    );
  });

  it("rejects duplicate vertices", () => {
    const result = validateSafePolygon([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]);
    assert.equal(result.ok, false);
    assert.ok(
      result.ok === false &&
        result.errors.some((message) => message.includes("duplicate")),
    );
  });

  it("rejects zero-area (collinear) rings", () => {
    const result = validateSafePolygon([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
    assert.equal(result.ok, false);
    assert.ok(
      result.ok === false &&
        result.errors.some((message) => message.includes("zero area")),
    );
  });

  it("rejects non-finite coordinates", () => {
    assert.equal(
      validateSafePolygon([
        { x: 0, y: 0 },
        { x: NaN, y: 0 },
        { x: 0, y: 5 },
      ]).ok,
      false,
    );
    assert.equal(
      validateSafePolygon([
        { x: 0, y: 0 },
        { x: Infinity, y: 0 },
        { x: 0, y: 5 },
      ]).ok,
      false,
    );
  });

  it("rejects a spike folding back on itself", () => {
    const result = validateSafePolygon([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 5, y: 0 },
      { x: 0, y: 10 },
    ]);
    assert.equal(result.ok, false);
  });
});

describe("pointInPolygon classification", () => {
  it("classifies inside / outside / on-edge", () => {
    assert.equal(pointInPolygon(square, { x: 5, y: 5 }), "inside");
    assert.equal(pointInPolygon(square, { x: 15, y: 5 }), "outside");
    assert.equal(pointInPolygon(square, { x: 0, y: 5 }), "on-edge");
    assert.equal(pointInPolygon(square, { x: 0, y: 0 }), "on-edge");
    assert.equal(pointInPolygon(square, { x: 5, y: 0 }), "on-edge");
  });

  it("handles concave notches", () => {
    // (5, 7) sits in the notch carved out of the top — outside the ring.
    assert.equal(pointInPolygon(concave, { x: 5, y: 7 }), "outside");
    assert.equal(pointInPolygon(concave, { x: 2, y: 5 }), "inside");
    assert.equal(pointInPolygon(concave, { x: 5, y: 2 }), "inside");
  });

  it("matches for either winding", () => {
    assert.equal(pointInPolygon(squareCW, { x: 5, y: 5 }), "inside");
    assert.equal(pointInPolygon(squareCW, { x: 15, y: 5 }), "outside");
  });

  it("treats near-edge points as on-edge within eps", () => {
    assert.equal(pointInPolygon(square, { x: 5, y: 1e-10 }), "on-edge");
    assert.equal(
      pointInPolygon(square, { x: 5, y: 1e-10 }, 1e-12),
      "inside",
    );
  });
});

describe("eps validation", () => {
  it("throws on non-finite or negative eps", () => {
    assert.throws(() => validateSafePolygon(square, NaN), Error);
    assert.throws(() => validateSafePolygon(square, Infinity), Error);
    assert.throws(() => validateSafePolygon(square, -1), Error);
    assert.throws(() => pointInPolygon(square, { x: 5, y: 5 }, NaN), Error);
    assert.throws(() => pointInPolygon(square, { x: 5, y: 5 }, -0.5), Error);
    assert.throws(
      () => footprintFits({ safe: square, footprint: triangle, eps: NaN }),
      Error,
    );
  });
});

describe("footprintFits containment", () => {
  it("fits a small footprint fully inside the safe region", () => {
    const result = footprintFits({
      safe: square,
      footprint: [
        { x: 2, y: 2 },
        { x: 4, y: 2 },
        { x: 4, y: 4 },
        { x: 2, y: 4 },
      ],
    });
    assert.equal(result.fits, true);
  });

  it("allows safe boundary contact (on-edge counts inside)", () => {
    const result = footprintFits({
      safe: square,
      footprint: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 5 },
        { x: 0, y: 5 },
      ],
    });
    assert.equal(result.fits, true);
  });

  it("rejects a footprint vertex outside the safe region", () => {
    const result = footprintFits({
      safe: square,
      footprint: [
        { x: 5, y: 5 },
        { x: 15, y: 5 },
        { x: 5, y: 9 },
      ],
    });
    assert.equal(result.fits, false);
    assert.match(result.reason, /outside the safe region/);
  });

  it("detects a concave-notch escape via edge crossing", () => {
    // All four vertices are inside the C-shape arms/below the notch, but the
    // top edge spans across the notch (outside the ring).
    const escaping: GeoPoint[] = [
      { x: 2, y: 8 },
      { x: 8, y: 8 },
      { x: 8, y: 2 },
      { x: 2, y: 2 },
    ];
    assert.equal(pointInPolygon(concave, { x: 5, y: 8 }), "outside");
    const result = footprintFits({ safe: concave, footprint: escaping });
    assert.equal(result.fits, false);
    assert.match(result.reason, /footprint edge.*safe region/);
  });

  it("rejects exclusion boundary contact", () => {
    const result = footprintFits({
      safe: square,
      exclusions: [
        [
          { x: 6, y: 6 },
          { x: 8, y: 6 },
          { x: 8, y: 8 },
          { x: 6, y: 8 },
        ],
      ],
      footprint: [
        { x: 1, y: 1 },
        { x: 6, y: 1 },
        { x: 6, y: 6 },
        { x: 1, y: 6 },
      ],
    });
    assert.equal(result.fits, false);
    assert.match(result.reason, /exclusions\[0\]/);
  });

  it("rejects a footprint overlapping an exclusion", () => {
    const result = footprintFits({
      safe: square,
      exclusions: [
        [
          { x: 6, y: 6 },
          { x: 8, y: 6 },
          { x: 8, y: 8 },
          { x: 6, y: 8 },
        ],
      ],
      footprint: [
        { x: 5, y: 5 },
        { x: 9, y: 5 },
        { x: 9, y: 9 },
        { x: 5, y: 9 },
      ],
    });
    assert.equal(result.fits, false);
    assert.match(result.reason, /exclusions\[0\]/);
  });

  it("rejects a footprint enclosing an exclusion even with vertices outside it", () => {
    const result = footprintFits({
      safe: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      exclusions: [
        [
          { x: 9, y: 9 },
          { x: 11, y: 9 },
          { x: 11, y: 11 },
          { x: 9, y: 11 },
        ],
      ],
      footprint: [
        { x: 5, y: 5 },
        { x: 15, y: 5 },
        { x: 15, y: 15 },
        { x: 5, y: 15 },
      ],
    });
    assert.equal(result.fits, false);
    assert.match(result.reason, /exclusions\[0\]/);
  });

  it("rejects a footprint edge crossing an exclusion", () => {
    const result = footprintFits({
      safe: square,
      exclusions: [
        [
          { x: 4, y: 4 },
          { x: 6, y: 4 },
          { x: 6, y: 6 },
          { x: 4, y: 6 },
        ],
      ],
      footprint: [
        { x: 1, y: 5 },
        { x: 9, y: 5 },
        { x: 9, y: 7 },
        { x: 1, y: 7 },
      ],
    });
    assert.equal(result.fits, false);
    assert.match(result.reason, /exclusions\[0\]/);
  });

  it("fits when the footprint avoids the exclusion", () => {
    const result = footprintFits({
      safe: square,
      exclusions: [
        [
          { x: 7, y: 7 },
          { x: 9, y: 7 },
          { x: 9, y: 9 },
          { x: 7, y: 9 },
        ],
      ],
      footprint: [
        { x: 1, y: 1 },
        { x: 4, y: 1 },
        { x: 4, y: 4 },
        { x: 1, y: 4 },
      ],
    });
    assert.equal(result.fits, true);
  });

  it("rejects invalid safe / footprint / exclusion inputs without claiming decoration clearance", () => {
    const badSafe = footprintFits({ safe: [{ x: 0, y: 0 }], footprint: triangle });
    assert.equal(badSafe.fits, false);
    assert.match(badSafe.reason, /safe polygon invalid/);
    const badFootprint = footprintFits({
      safe: square,
      footprint: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ],
    });
    assert.equal(badFootprint.fits, false);
    assert.match(badFootprint.reason, /footprint invalid/);
    const badExclusion = footprintFits({
      safe: square,
      exclusions: [[{ x: 0, y: 0 }]],
      footprint: triangle,
    });
    assert.equal(badExclusion.fits, false);
    assert.match(badExclusion.reason, /exclusion invalid/);
    for (const reason of [badSafe.reason, badFootprint.reason, badExclusion.reason]) {
      assert.doesNotMatch(reason, /clearance/i);
      assert.doesNotMatch(reason, /curved/i);
      assert.doesNotMatch(reason, /decoration/i);
    }
  });
});

describe('region geometry: independent review regressions', () => {
  const points = (values: number[][]) => values.map(([x, y]) => ({x: x!, y: y!}));
  it('rejects a footprint spanning a concave void whose vertices all touch safe edges', () => {
    const safe = points([[0,0],[10,0],[10,10],[6,10],[6,4],[4,4],[4,10],[0,10]]);
    assert.equal(footprintFits({safe, footprint: points([[4,5],[6,5],[6,8],[4,8]])}).fits, false);
    // An edge along the actual bottom of the notch is valid boundary contact.
    assert.equal(footprintFits({safe, footprint: points([[2,2],[8,2],[8,4],[2,4]])}).fits, true);
  });
  it('checks every edge interval, including a narrow off-centre concave notch', () => {
    const safe = points([[0,0],[100,0],[100,100],[91,100],[91,10],[90,10],[90,100],[0,100]]);
    assert.equal(footprintFits({safe, footprint: points([[1,20],[99,20],[99,30],[1,30]])}).fits, false);
  });
  it('normalizes explicit closure consistently in all region rings', () => {
    const safe = points([[0,0],[10,0],[10,10],[0,10],[0,0]]);
    const footprint = points([[1,1],[2,1],[2,2],[1,2],[1,1]]);
    const exclusions = [points([[7,7],[8,7],[8,8],[7,8],[7,7]])];
    assert.equal(footprintFits({safe, footprint, exclusions}).fits, true);
  });
  it('computes area relative to a distant datum without cancellation', () => {
    const square = points([[1e12,1e12],[1e12+10,1e12],[1e12+10,1e12+10],[1e12,1e12+10]]);
    assert.equal(validateSafePolygon(square).ok, true);
    assert.equal(pointInPolygon(square, {x: 1e12+5, y: 1e12+5}), 'inside');
  });
  it('rejects polygons beyond finite arithmetic and invalid public point queries', () => {
    assert.equal(validateSafePolygon(points([[0,0],[1e200,0],[1e200,1],[0,1]]),0).ok, false);
    assert.throws(() => pointInPolygon(points([[0,0],[2,2],[0,2],[2,0]]),{x:1,y:1}), /zero area|self-intersecting/);
  });
});
