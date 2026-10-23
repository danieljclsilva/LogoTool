import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveVisualDimension } from "../src/core/visual-dimension/index.js";
import type {
  ResolveVisualDimensionInput,
  VisualAnchorInput,
} from "../src/core/visual-dimension/index.js";

/**
 * Footprint 60x40 centred at (100, 75), rotation 0: extents x 70..130,
 * y 55..95. Anchors sit outside each side.
 */
function makeAnchors(): VisualAnchorInput[] {
  return [
    { id: "w", posMm: [40, 75] },
    { id: "e", posMm: [160, 75] },
    { id: "s", posMm: [100, 20] },
    { id: "n", posMm: [100, 130] },
  ];
}

function makeInput(extra?: Partial<ResolveVisualDimensionInput>): ResolveVisualDimensionInput {
  return {
    anchors: makeAnchors(),
    footprint: { centerMm: [100, 75], widthMm: 60, heightMm: 40, rotationDeg: 0 },
    anchorClickMm: [42, 76],
    edgeClickMm: [68, 75],
    convention: "dx",
    snapTolMm: 10,
    ...extra,
  };
}

describe("resolveVisualDimension", () => {
  it("resolves dx to the left edge with exact millimetres", () => {
    const result = resolveVisualDimension(makeInput());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.binding, { anchorId: "w", edge: "minX", convention: "dx" });
      // Anchor x = 40, min-X extent = 70.
      assert.equal(result.valueMm, -30);
      assert.deepEqual(result.endpoints[1], { x: 40, y: 75 });
      assert.deepEqual(result.endpoints[0], { x: 70, y: 75 });
    }
  });

  it("resolves dx to the right edge", () => {
    const result = resolveVisualDimension(makeInput({
      anchorClickMm: [158, 74],
      edgeClickMm: [132, 75],
    }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.binding, { anchorId: "e", edge: "maxX", convention: "dx" });
      assert.equal(result.valueMm, 30);
      assert.deepEqual(result.endpoints[1], { x: 160, y: 75 });
    }
  });

  it("resolves dy to the bottom and top edges", () => {
    const bottom = resolveVisualDimension(makeInput({
      anchorClickMm: [100, 22],
      edgeClickMm: [100, 53],
      convention: "dy",
    }));
    assert.equal(bottom.ok, true);
    if (bottom.ok) {
      assert.deepEqual(bottom.binding, { anchorId: "s", edge: "minY", convention: "dy" });
      // Anchor y = 20, min-Y extent = 55.
      assert.equal(bottom.valueMm, -35);
      assert.deepEqual(bottom.endpoints, [{ x: 100, y: 55 }, { x: 100, y: 20 }]);
    }
    const top = resolveVisualDimension(makeInput({
      anchorClickMm: [99, 128],
      edgeClickMm: [100, 97],
      convention: "dy",
    }));
    assert.equal(top.ok, true);
    if (top.ok) {
      assert.deepEqual(top.binding, { anchorId: "n", edge: "maxY", convention: "dy" });
      assert.equal(top.valueMm, 35);
    }
  });

  it("rejects dx/dy edges on the wrong axis", () => {
    const cases = [
      { convention: "dx", edgeClickMm: [100, 97] as [number, number], word: "horizontally" },
      { convention: "dx", edgeClickMm: [100, 53] as [number, number], word: "horizontally" },
      { convention: "dy", edgeClickMm: [68, 75] as [number, number], word: "vertically" },
      { convention: "dy", edgeClickMm: [132, 75] as [number, number], word: "vertically" },
    ] as const;
    for (const { convention, edgeClickMm, word } of cases) {
      const result = resolveVisualDimension(makeInput({
        anchorClickMm: [42, 76],
        edgeClickMm,
        convention,
      }));
      assert.equal(result.ok, false, `${convention} + click must be rejected`);
      if (!result.ok) {
        assert.equal(result.code, "incompatible-edge-or-convention");
        assert.ok(result.message.includes(word), result.message);
      }
    }
  });

  it("accepts shortest-to-edge on all four edges", () => {
    const clicks = [
      { edgeClickMm: [68, 75] as [number, number], edge: "minX", anchorId: "w", value: 30 },
      { edgeClickMm: [132, 75] as [number, number], edge: "maxX", anchorId: "e", value: 30 },
      { edgeClickMm: [100, 53] as [number, number], edge: "minY", anchorId: "s", value: 35 },
      { edgeClickMm: [100, 97] as [number, number], edge: "maxY", anchorId: "n", value: 35 },
    ] as const;
    const anchorClicks: Record<string, [number, number]> = {
      w: [42, 76],
      e: [158, 74],
      s: [100, 22],
      n: [99, 128],
    };
    for (const { edgeClickMm, edge, anchorId, value } of clicks) {
      const result = resolveVisualDimension(makeInput({
        anchorClickMm: anchorClicks[anchorId]!,
        edgeClickMm,
        convention: "shortest-to-edge",
      }));
      assert.equal(result.ok, true, `shortest-to-edge accepts ${edge}`);
      if (result.ok) {
        assert.deepEqual(result.binding, { anchorId, edge, convention: "shortest-to-edge" });
        assert.equal(result.valueMm, value);
        assert.ok(result.valueMm >= 0);
      }
    }
  });

  it("resolves the visual left edge under 90-degree rotation", () => {
    const result = resolveVisualDimension({
      anchors: [{ id: "w", posMm: [-50, 0] }],
      footprint: { centerMm: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 90 },
      anchorClickMm: [-49, 1],
      edgeClickMm: [-22, 0],
      convention: "dx",
      snapTolMm: 10,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.binding, { anchorId: "w", edge: "minX", convention: "dx" });
      // Rotated extents: x in [-20, 20]; anchor x = -50.
      assert.ok(Math.abs(result.valueMm - -30) < 1e-9, `${result.valueMm} ~= -30`);
      assert.deepEqual(result.endpoints[1], { x: -50, y: 0 });
    }
  });

  it("is deterministic for a rotated footprint", () => {
    const input = makeInput({
      footprint: { centerMm: [100, 75], widthMm: 60, heightMm: 40, rotationDeg: 30 },
      anchorClickMm: [42, 76],
      edgeClickMm: [60, 80],
      convention: "shortest-to-edge",
    });
    assert.deepEqual(resolveVisualDimension(input), resolveVisualDimension(input));
    assert.deepEqual(resolveVisualDimension(makeInput()), resolveVisualDimension(makeInput()));
  });

  it("selects the nearest anchor and breaks ties by order", () => {
    const nearer = resolveVisualDimension(makeInput({
      anchors: [{ id: "a", posMm: [0, 0] }, { id: "b", posMm: [44, 75] }],
      anchorClickMm: [42, 76],
      edgeClickMm: [68, 75],
    }));
    assert.equal(nearer.ok, true);
    if (nearer.ok) assert.equal(nearer.binding.anchorId, "b");
    const tie = resolveVisualDimension(makeInput({
      anchors: [{ id: "a", posMm: [0, 10] }, { id: "b", posMm: [0, -10] }],
      anchorClickMm: [0, 0],
      edgeClickMm: [68, 75],
      footprint: { centerMm: [100, 0], widthMm: 60, heightMm: 40, rotationDeg: 0 },
    }));
    assert.equal(tie.ok, true);
    if (tie.ok) assert.equal(tie.binding.anchorId, "a");
  });

  it("keeps the tolerance boundary inclusive", () => {
    const onEdge = resolveVisualDimension(makeInput({
      anchors: [{ id: "w", posMm: [40, 75] }],
      anchorClickMm: [45, 75],
      snapTolMm: 5,
    }));
    assert.equal(onEdge.ok, true);
    const outside = resolveVisualDimension(makeInput({
      anchors: [{ id: "w", posMm: [40, 75] }],
      anchorClickMm: [45, 75],
      snapTolMm: 4.999,
    }));
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.equal(outside.code, "none-in-tolerance");
  });

  it("reports a snap miss without fabricating", () => {
    const result = resolveVisualDimension(makeInput({
      anchorClickMm: [0, 0],
      snapTolMm: 5,
    }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "none-in-tolerance");
      assert.ok(result.message.includes("5 mm"), result.message);
    }
  });

  it("reports no anchors without fabricating", () => {
    const result = resolveVisualDimension(makeInput({ anchors: [] }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "no-anchors");
  });

  it("reports non-finite input without fabricating", () => {
    const base = makeInput();
    const cases: Partial<ResolveVisualDimensionInput>[] = [
      { anchorClickMm: [Number.NaN, 0] },
      { edgeClickMm: [0, Number.POSITIVE_INFINITY] },
      { snapTolMm: Number.NaN },
      { footprint: { centerMm: [100, 75], widthMm: 0, heightMm: 40, rotationDeg: 0 } },
      { footprint: { centerMm: [100, 75], widthMm: 60, heightMm: -5, rotationDeg: 0 } },
      { footprint: { centerMm: [0, Number.NaN], widthMm: 60, heightMm: 40, rotationDeg: 0 } },
      { footprint: { centerMm: [100, 75], widthMm: 60, heightMm: 40, rotationDeg: Number.NaN } },
    ];
    for (const patch of cases) {
      const result = resolveVisualDimension({ ...base, ...patch });
      assert.equal(result.ok, false, JSON.stringify(patch));
      if (!result.ok) assert.equal(result.code, "non-finite");
    }
  });

  it("reports an unknown convention as a convention error", () => {
    const result = resolveVisualDimension(makeInput({ convention: "dist" as never }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "incompatible-edge-or-convention");
  });

  it("carries only anchorId/edge/convention in the binding", () => {
    const result = resolveVisualDimension(makeInput());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(Object.keys(result.binding).sort(), ["anchorId", "convention", "edge"]);
      assert.ok(!("logoRef" in result.binding));
    }
  });

  it("reports the exact edge distance when the click is within tolerance", () => {
    const result = resolveVisualDimension(makeInput({ maxEdgeDistMm: 5 }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.binding, { anchorId: "w", edge: "minX", convention: "dx" });
      // Click (68, 75) lands 2 mm off the x = 70 edge segment.
      assert.equal(result.edgeDistanceMm, 2);
      assert.equal(result.valueMm, -30);
    }
  });

  it("keeps the edge tolerance boundary inclusive", () => {
    const onEdge = resolveVisualDimension(makeInput({
      edgeClickMm: [68, 75],
      maxEdgeDistMm: 2,
    }));
    assert.equal(onEdge.ok, true);
    if (onEdge.ok) assert.equal(onEdge.edgeDistanceMm, 2);
    const outside = resolveVisualDimension(makeInput({
      edgeClickMm: [68, 75],
      maxEdgeDistMm: 1.999,
    }));
    assert.equal(outside.ok, false);
    if (!outside.ok) {
      assert.equal(outside.code, "edge-too-far");
      assert.ok(outside.message.includes("2 mm"), outside.message);
      assert.ok(outside.message.includes("1.999 mm"), outside.message);
    }
  });

  it("rejects far clicks per edge instead of binding them", () => {
    const clicks = [
      [60, 75],
      [140, 75],
      [100, 45],
      [100, 105],
    ] as const;
    for (const [x, y] of clicks) {
      const result = resolveVisualDimension(makeInput({
        anchorClickMm: [42, 76],
        edgeClickMm: [x, y],
        convention: "shortest-to-edge",
        maxEdgeDistMm: 5,
      }));
      assert.equal(result.ok, false, `click [${x}, ${y}] must not bind a far edge`);
      if (!result.ok) {
        assert.equal(result.code, "edge-too-far");
        assert.ok(result.message.includes("10 mm"), result.message);
        assert.ok(result.message.includes("5 mm"), result.message);
      }
    }
  });

  it("preserves nearest-edge behavior when maxEdgeDistMm is absent", () => {
    const result = resolveVisualDimension(makeInput({
      anchorClickMm: [42, 76],
      edgeClickMm: [0, 75],
    }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.binding, { anchorId: "w", edge: "minX", convention: "dx" });
      assert.equal(result.edgeDistanceMm, 70);
    }
  });

  it("rejects invalid maxEdgeDistMm as non-finite", () => {
    const base = makeInput({ maxEdgeDistMm: 5 });
    for (const maxEdgeDistMm of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = resolveVisualDimension({ ...base, maxEdgeDistMm });
      assert.equal(result.ok, false, `maxEdgeDistMm ${maxEdgeDistMm} must be rejected`);
      if (!result.ok) assert.equal(result.code, "non-finite");
    }
  });

  it("gates rotated footprint clicks by edge distance", () => {
    const near = resolveVisualDimension({
      anchors: [{ id: "w", posMm: [-50, 0] }],
      footprint: { centerMm: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 90 },
      anchorClickMm: [-49, 1],
      edgeClickMm: [-22, 0],
      convention: "dx",
      snapTolMm: 10,
      maxEdgeDistMm: 2,
    });
    assert.equal(near.ok, true);
    if (near.ok) {
      assert.deepEqual(near.binding, { anchorId: "w", edge: "minX", convention: "dx" });
      assert.equal(near.edgeDistanceMm, 2);
    }
    const far = resolveVisualDimension({
      anchors: [{ id: "w", posMm: [-50, 0] }],
      footprint: { centerMm: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 90 },
      anchorClickMm: [-49, 1],
      edgeClickMm: [-40, 0],
      convention: "dx",
      snapTolMm: 10,
      maxEdgeDistMm: 5,
    });
    assert.equal(far.ok, false);
    if (!far.ok) assert.equal(far.code, "edge-too-far");
  });
});
