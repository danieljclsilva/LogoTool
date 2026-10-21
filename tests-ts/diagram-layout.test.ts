import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  layoutDiagram,
  type DiagramArrowLayout,
  type DiagramLayout,
} from "../src/ui/shared/operation-document/diagram-layout.js";

/**
 * Pure-math regressions for the exterior dimension lanes (no DOM).
 *
 * Lane deltas are asserted against the mapped inputs: a lane is the original
 * segment translated by one perpendicular vector, never re-projected, so the
 * delta must survive up to floating-point rounding (1e-9 absolute covers the
 * single rounding of the offset addition on these magnitudes; the old
 * extent-projection failure was off by whole hundreds of pixels).
 */

function laneDelta(lane: DiagramArrowLayout): [number, number] {
  return [lane.x2 - lane.x1, lane.y2 - lane.y1];
}

function assertDelta(actual: [number, number], expected: [number, number]): void {
  assert.ok(
    Math.abs(actual[0] - expected[0]) <= 1e-9 && Math.abs(actual[1] - expected[1]) <= 1e-9,
    `lane delta [${actual}] preserves mapped delta [${expected}]`,
  );
}

function assertLabelOutside(layout: DiagramLayout, lane: DiagramArrowLayout): void {
  const left = layout.frameX;
  const right = layout.frameX + layout.photoW;
  const top = layout.top;
  const bottom = layout.top + layout.photoH;
  const outside = lane.ly < top || lane.ly > bottom || lane.lx < left || lane.lx > right;
  assert.ok(outside, `gutter label (${lane.lx}, ${lane.ly}) sits outside the photo rect`);
}

function assertWitness(
  layout: DiagramLayout,
  lane: DiagramArrowLayout,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
): void {
  // One addition each, recomputed identically here, so these are bit-exact:
  // witness ends are the true mapped points, never clamped or projected.
  assert.equal(lane.w0.x2, layout.frameX + p0.x);
  assert.equal(lane.w0.y2, layout.top + p0.y);
  assert.equal(lane.w1.x2, layout.frameX + p1.x);
  assert.equal(lane.w1.y2, layout.top + p1.y);
}

describe("layoutDiagram", () => {
  it("rejects non-positive photo dimensions", () => {
    assert.equal(layoutDiagram(0, 10, []), null);
    assert.equal(layoutDiagram(20, -1, []), null);
  });

  it("translates the root diagonal without reshaping it", () => {
    // Root R1 repro: p0(300,400)->p1(600,600) drew [300,0]; it must draw [300,200].
    const p0 = { x: 300, y: 400 };
    const p1 = { x: 600, y: 600 };
    const layout = layoutDiagram(1000, 800, [{ p0, p1, label: "1 · 20.0 mm" }]);
    assert.ok(layout, "layout exists");
    assert.equal(layout.arrows.length, 1);
    const lane = layout.arrows[0]!;
    assert.equal(lane.axis, "h");
    assert.equal(lane.coincident, false);
    assertDelta(laneDelta(lane), [300, 200]);
    assert.ok(Math.abs(lane.y2 - lane.y1) > 199, "vertical span survives (old code collapsed it to 0)");
    assert.ok(lane.y1 < layout.top && lane.y2 < layout.top, "whole lane sits above the photo rect");
    assertLabelOutside(layout, lane);
    assertWitness(layout, lane, p0, p1);
  });

  it("draws no invented span for a zero measurement", () => {
    // Root R1 repro: p0==p1(400,400) became a 61.89px span; now it is one point.
    const p = { x: 400, y: 400 };
    const layout = layoutDiagram(1000, 800, [{ p0: p, p1: p, label: "2 · 0.0 mm" }]);
    assert.ok(layout, "layout exists");
    assert.equal(layout.arrows.length, 1);
    const lane = layout.arrows[0]!;
    assert.equal(lane.coincident, true);
    assert.equal(lane.x1, lane.x2);
    assert.equal(lane.y1, lane.y2);
    assert.equal(lane.x1, layout.frameX + 400);
    assert.equal(lane.y1, layout.top + 400);
    // The leader still reaches the true point; the caller draws the open
    // circle there instead of any arrow line.
    assert.equal(lane.w0.x2, layout.frameX + 400);
    assert.equal(lane.w0.y2, layout.top + 400);
    // Nearest gutter for (400,400) in a 1000px photo is the top one.
    assert.equal(lane.axis, "h");
    assertLabelOutside(layout, lane);
  });

  it("preserves a rotated segment through the same vector path", () => {
    const angle = Math.PI / 18;
    const p0 = { x: 100, y: 500 };
    const p1 = { x: 100 + 300 * Math.cos(angle), y: 500 + 300 * Math.sin(angle) };
    const layout = layoutDiagram(1000, 800, [{ p0, p1, label: "3 · 45.0 mm" }]);
    assert.ok(layout, "layout exists");
    const lane = layout.arrows[0]!;
    assert.equal(lane.axis, "h");
    assert.equal(lane.coincident, false);
    assertDelta(laneDelta(lane), [p1.x - p0.x, p1.y - p0.y]);
    assert.ok(lane.y1 < layout.top && lane.y2 < layout.top, "whole lane sits above the photo rect");
    assertLabelOutside(layout, lane);
    assertWitness(layout, lane, p0, p1);
  });

  it("preserves a sheared segment through the same vector path", () => {
    const p0 = { x: 200, y: 300 };
    const p1 = { x: 470, y: 335 };
    const layout = layoutDiagram(1000, 800, [{ p0, p1, label: "4 · 75.0 mm" }]);
    assert.ok(layout, "layout exists");
    const lane = layout.arrows[0]!;
    assert.equal(lane.axis, "h");
    assertDelta(laneDelta(lane), [270, 35]);
    assert.ok(lane.y1 < layout.top && lane.y2 < layout.top, "whole lane sits above the photo rect");
    assertLabelOutside(layout, lane);
    assertWitness(layout, lane, p0, p1);
  });

  it("offsets vertical-dominant segments toward the right gutter", () => {
    const p0 = { x: 900, y: 100 };
    const p1 = { x: 920, y: 700 };
    const layout = layoutDiagram(1000, 800, [{ p0, p1, label: "5 · 60.0 mm" }]);
    assert.ok(layout, "layout exists");
    const lane = layout.arrows[0]!;
    assert.equal(lane.axis, "v");
    assert.equal(lane.coincident, false);
    assertDelta(laneDelta(lane), [20, 600]);
    assert.ok(
      lane.x1 > layout.frameX + 1000 && lane.x2 > layout.frameX + 1000,
      "whole lane sits right of the photo rect",
    );
    assert.equal(lane.rotate, true);
    assertLabelOutside(layout, lane);
    assertWitness(layout, lane, p0, p1);
  });

  it("stacks mixed lanes with every label outside the photo", () => {
    const zero = { x: 1500, y: 1200 };
    const inputs = [
      { p0: { x: 300, y: 400 }, p1: { x: 600, y: 600 }, label: "1 · 20.0 mm" },
      { p0: { x: 1500, y: 200 }, p1: { x: 1560, y: 900 }, label: "2 · 45.0 mm" },
      { p0: { x: 200, y: 1100 }, p1: { x: 900, y: 1150 }, label: "3 · 75.0 mm" },
      { p0: zero, p1: zero, label: "4 · 0.0 mm" },
    ];
    const layout = layoutDiagram(2000, 1600, inputs);
    assert.ok(layout, "layout exists");
    assert.equal(layout.arrows.length, 4);
    const expected: Array<[number, number]> = [[300, 200], [60, 700], [700, 50], [0, 0]];
    layout.arrows.forEach((lane, index) => {
      assertDelta(laneDelta(lane), expected[index]!);
      assertLabelOutside(layout, lane);
    });
    assert.equal(layout.arrows[3]!.coincident, true);
    // The viewBox fits every lane end instead of clipping.
    for (const lane of layout.arrows) {
      for (const [x, y] of [[lane.x1, lane.y1], [lane.x2, lane.y2], [lane.lx, lane.ly]] as const) {
        assert.ok(x >= 0 && x <= layout.viewW && y >= 0 && y <= layout.viewH, `(${x}, ${y}) fits the viewBox`);
      }
    }
  });
});
