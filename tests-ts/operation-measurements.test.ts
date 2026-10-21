import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { buildCandidateExport } from "../src/core/index.js";
import type {
  Placement,
  ProductDefinition,
  ProjectDocument,
  Region,
  Sha256HexFn,
} from "../src/core/index.js";
import {
  isOperationDraft,
  isStaleDraft,
  measureEdgeToAnchor,
  measurePlacement,
  rotatedFootprintCorners,
  OPERATION_DRAFT_NUMBER,
  OPERATION_DRAFT_VERSION,
} from "../src/core/operation-measurements/index.js";
import type {
  AnchorDef,
  DimensionBinding,
  OperationDraft,
} from "../src/core/operation-measurements/types.js";

const sha256Text: Sha256HexFn = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function makeChestRegion(): Region {
  return {
    id: "chest",
    name: "Chest",
    frame: {
      frameId: "chest-frame",
      originDescription: "Centre of chest",
      axes: { xPositive: "wearer right", yPositive: "wearer up" },
    },
    calibrationRef: { calibrationId: "cal-1", version: "v1" },
    safeArea: [
      [0, 0],
      [200, 0],
      [200, 150],
      [0, 150],
    ],
    allowedMethods: ["embroider", "print"],
  };
}

function makeProduct(): ProductDefinition {
  return {
    schemaVersion: "0.1.0-provisional",
    id: "polo",
    name: "Polo shirt",
    kind: "upper-body",
    variants: [{ id: "m", name: "Medium", regionIds: ["chest"] }],
    regions: [makeChestRegion()],
    calibrations: [{ id: "cal-1", version: "v1" }],
  };
}

function makeProject(placements: Placement[]): ProjectDocument {
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "measure-test",
    revision: 1,
    products: [makeProduct()],
    logos: [
      {
        schemaVersion: "0.1.0-provisional",
        id: "logo-a",
        name: "Logo A",
        assets: [{
          uri: "logo-a.svg",
          role: "reference",
          mediaType: "image/svg+xml",
          sha256Hex: "a".repeat(64),
        }],
      },
      {
        schemaVersion: "0.1.0-provisional",
        id: "logo-b",
        name: "Logo B",
        assets: [{
          uri: "logo-b.svg",
          role: "reference",
          mediaType: "image/svg+xml",
          sha256Hex: "b".repeat(64),
        }],
      },
    ],
    configurations: [{
      id: "cfg-m",
      productId: "polo",
      variantId: "m",
      placements,
    }],
  };
}

function makeAnchor(extra?: Partial<AnchorDef>): AnchorDef {
  return {
    id: "cf",
    name: "Centre front",
    productId: "polo",
    variantId: "m",
    regionId: "chest",
    frameId: "chest-frame",
    calibrationId: "cal-1",
    calibrationVersion: "v1",
    posMm: [100, 150],
    ...extra,
  };
}

function makeBinding(extra?: Partial<DimensionBinding>): DimensionBinding {
  return {
    logoRef: "logo-a",
    anchorId: "cf",
    edge: "maxY",
    convention: "dy",
    label: "centre front to top edge, vertical",
    ...extra,
  };
}

describe("rotatedFootprintCorners", () => {
  it("is axis-aligned at rotation 0", () => {
    assert.deepEqual(rotatedFootprintCorners(0, 0, 60, 40, 0), [
      { x: -30, y: -20 },
      { x: 30, y: -20 },
      { x: 30, y: 20 },
      { x: -30, y: 20 },
    ]);
  });

  it("rotates clockwise in a Y-up frame (90 deg swaps extents)", () => {
    const corners = rotatedFootprintCorners(10, 20, 60, 40, 90);
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    for (const [actual, expected] of [
      [Math.min(...xs), 10 - 20],
      [Math.max(...xs), 10 + 20],
      [Math.min(...ys), 20 - 30],
      [Math.max(...ys), 20 + 30],
    ] as const) {
      assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~= ${expected}`);
    }
  });

  it("rotation 180 preserves extents of a centred rectangle", () => {
    const plain = rotatedFootprintCorners(0, 0, 60, 40, 0);
    const turned = rotatedFootprintCorners(0, 0, 60, 40, 180);
    const extent = (corners: { x: number; y: number }[]): number[] => [
      Math.min(...corners.map((corner) => corner.x)),
      Math.max(...corners.map((corner) => corner.x)),
      Math.min(...corners.map((corner) => corner.y)),
      Math.max(...corners.map((corner) => corner.y)),
    ];
    const [actual, expected] = [extent(turned), extent(plain)];
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) => {
      assert.ok(Math.abs(value - expected[index]!) < 1e-9, `${value} ~= ${expected[index]}`);
    });
  });
});

describe("measureEdgeToAnchor", () => {
  const footprint = rotatedFootprintCorners(0, 0, 60, 40, 0);

  it("measures signed dx to the min-X extent", () => {
    const measured = measureEdgeToAnchor(footprint, { x: -50, y: 10 }, { edge: "minX", convention: "dx" });
    assert.equal(measured.ok, true);
    assert.equal(measured.ok && measured.valueMm, -20);
    assert.deepEqual(measured.ok && measured.endpoints, [{ x: -30, y: 10 }, { x: -50, y: 10 }]);
    assert.ok(measured.ok && measured.edgeDescription.includes("horizontally"));
  });

  it("measures signed dx to the max-X extent", () => {
    const measured = measureEdgeToAnchor(footprint, { x: 50, y: -5 }, { edge: "maxX", convention: "dx" });
    assert.equal(measured.ok, true);
    assert.equal(measured.ok && measured.valueMm, 20);
    assert.deepEqual(measured.ok && measured.endpoints, [{ x: 30, y: -5 }, { x: 50, y: -5 }]);
  });

  it("measures signed dy (positive above, negative below)", () => {
    const above = measureEdgeToAnchor(footprint, { x: 5, y: 45 }, { edge: "maxY", convention: "dy" });
    assert.equal(above.ok, true);
    assert.equal(above.ok && above.valueMm, 25);
    const below = measureEdgeToAnchor(footprint, { x: 5, y: -30 }, { edge: "minY", convention: "dy" });
    assert.equal(below.ok, true);
    assert.equal(below.ok && below.valueMm, -10);
    assert.ok(below.ok && below.edgeDescription.includes("vertically"));
  });

  it("uses rotated extents for dx/dy under 90-degree rotation", () => {
    const turned = rotatedFootprintCorners(0, 0, 60, 40, 90);
    const measured = measureEdgeToAnchor(turned, { x: -50, y: 10 }, { edge: "minX", convention: "dx" });
    assert.equal(measured.ok, true);
    assert.ok(measured.ok && Math.abs(measured.valueMm - -30) < 1e-9);
  });

  it("shortest-to-edge equals the perpendicular gap for an aligned anchor", () => {
    const measured = measureEdgeToAnchor(footprint, { x: -50, y: 0 }, { edge: "minX", convention: "shortest-to-edge" });
    assert.equal(measured.ok, true);
    assert.equal(measured.ok && measured.valueMm, 20);
    assert.deepEqual(measured.ok && measured.endpoints, [{ x: -30, y: 0 }, { x: -50, y: 0 }]);
  });

  it("shortest-to-edge clamps to the finite segment past a corner", () => {
    const measured = measureEdgeToAnchor(footprint, { x: -50, y: -30 }, { edge: "minX", convention: "shortest-to-edge" });
    assert.equal(measured.ok, true);
    assert.ok(measured.ok && Math.abs(measured.valueMm - Math.hypot(20, 10)) < 1e-9);
    assert.deepEqual(measured.ok && measured.endpoints, [{ x: -30, y: -20 }, { x: -50, y: -30 }]);
  });

  it("shortest-to-edge is deterministic and non-negative", () => {
    const turned = rotatedFootprintCorners(7, -3, 60, 40, 30);
    const anchor = { x: -40, y: 25 };
    const first = measureEdgeToAnchor(turned, anchor, { edge: "minY", convention: "shortest-to-edge" });
    const second = measureEdgeToAnchor(turned, anchor, { edge: "minY", convention: "shortest-to-edge" });
    assert.deepEqual(first, second);
    assert.ok(first.ok && first.valueMm >= 0);
  });

  it("rejects footprints with fewer than 3 corners without reshaping", () => {
    const two = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const twoResult = measureEdgeToAnchor(two, { x: 0, y: 0 }, { edge: "minX", convention: "dx" });
    assert.equal(twoResult.ok, false);
    if (!twoResult.ok) assert.ok(twoResult.error.includes("at least 3 corners"));
    const oneResult = measureEdgeToAnchor([{ x: 0, y: 0 }], { x: 0, y: 0 }, { edge: "minY", convention: "dy" });
    assert.equal(oneResult.ok, false);
  });

  it("rejects any non-finite corner without filtering it away", () => {
    const base = rotatedFootprintCorners(0, 0, 60, 40, 30);
    for (let i = 0; i < base.length; i += 1) {
      const nanCorner = base.map((corner, index) => (index === i ? { x: Number.NaN, y: corner.y } : corner));
      const nanResult = measureEdgeToAnchor(nanCorner, { x: 0, y: 0 }, { edge: "minX", convention: "dx" });
      assert.equal(nanResult.ok, false, `NaN corner at position ${i} must be rejected`);
      if (!nanResult.ok) assert.ok(nanResult.error.includes("finite"));
      const infCorner = base.map((corner, index) => (index === i ? { x: corner.x, y: Number.POSITIVE_INFINITY } : corner));
      const infResult = measureEdgeToAnchor(infCorner, { x: 0, y: 0 }, { edge: "maxY", convention: "dy" });
      assert.equal(infResult.ok, false, `infinite corner at position ${i} must be rejected`);
    }
    // Three finite corners plus one bad corner is rejected, never reshaped to a triangle.
    const mixed = [...rotatedFootprintCorners(0, 0, 60, 40, 0), { x: 5, y: Number.NaN }];
    assert.equal(
      measureEdgeToAnchor(mixed, { x: 0, y: 0 }, { edge: "minX", convention: "dx" }).ok,
      false,
    );
  });

  it("rejects dx/dy edges on the wrong axis in ordinary language", () => {
    const cases = [
      { edge: "minY", convention: "dx", word: "horizontally" },
      { edge: "maxY", convention: "dx", word: "horizontally" },
      { edge: "minX", convention: "dy", word: "vertically" },
      { edge: "maxX", convention: "dy", word: "vertically" },
    ] as const;
    for (const { edge, convention, word } of cases) {
      const result = measureEdgeToAnchor(footprint, { x: 0, y: 0 }, { edge, convention });
      assert.equal(result.ok, false, `${convention}+${edge} must be rejected`);
      if (!result.ok) assert.ok(result.error.includes(word), result.error);
    }
  });

  it("measures every valid edge/convention combination", () => {
    const dxMin = measureEdgeToAnchor(footprint, { x: -50, y: 10 }, { edge: "minX", convention: "dx" });
    assert.equal(dxMin.ok, true);
    if (dxMin.ok) assert.equal(dxMin.valueMm, -20);
    const dxMax = measureEdgeToAnchor(footprint, { x: 50, y: -5 }, { edge: "maxX", convention: "dx" });
    assert.equal(dxMax.ok, true);
    if (dxMax.ok) assert.equal(dxMax.valueMm, 20);
    const dyMin = measureEdgeToAnchor(footprint, { x: 5, y: -30 }, { edge: "minY", convention: "dy" });
    assert.equal(dyMin.ok, true);
    if (dyMin.ok) assert.equal(dyMin.valueMm, -10);
    const dyMax = measureEdgeToAnchor(footprint, { x: 5, y: 45 }, { edge: "maxY", convention: "dy" });
    assert.equal(dyMax.ok, true);
    if (dyMax.ok) assert.equal(dyMax.valueMm, 25);
    for (const edge of ["minX", "maxX", "minY", "maxY"] as const) {
      const result = measureEdgeToAnchor(footprint, { x: 0, y: 0 }, { edge, convention: "shortest-to-edge" });
      assert.equal(result.ok, true, `shortest-to-edge accepts ${edge}`);
      if (result.ok) assert.ok(result.valueMm >= 0);
    }
  });

  it("marks orthogonal arrows touching when the anchor ordinate is within the edge span", () => {
    const dx = measureEdgeToAnchor(footprint, { x: -50, y: 10 }, { edge: "minX", convention: "dx" });
    assert.equal(dx.ok, true);
    if (dx.ok) {
      assert.equal(dx.touchesArtwork, true);
      assert.equal(dx.artworkPoint, undefined);
      assert.ok(dx.edgeDescription.includes("to the left artwork edge"), dx.edgeDescription);
      assert.ok(dx.edgeDescription.includes("horizontally"), dx.edgeDescription);
    }
    const dy = measureEdgeToAnchor(footprint, { x: 5, y: 45 }, { edge: "maxY", convention: "dy" });
    assert.equal(dy.ok, true);
    if (dy.ok) {
      assert.equal(dy.touchesArtwork, true);
      assert.equal(dy.artworkPoint, undefined);
      assert.ok(dy.edgeDescription.includes("to the top artwork edge"), dy.edgeDescription);
      assert.ok(dy.edgeDescription.includes("vertically"), dy.edgeDescription);
    }
  });

  it("marks rotated extended arrows with the nearest extreme corner", () => {
    const turned = rotatedFootprintCorners(0, 0, 60, 40, 30);
    const minX = Math.min(...turned.map((corner) => corner.x));
    const extreme = turned.filter((corner) => Math.abs(corner.x - minX) <= 1e-9);
    assert.equal(extreme.length, 1, "30-degree rotation has a single extreme corner");
    const outside = measureEdgeToAnchor(turned, { x: -100, y: 100 }, { edge: "minX", convention: "dx" });
    assert.equal(outside.ok, true);
    if (outside.ok) {
      assert.equal(outside.valueMm, -100 - minX);
      assert.equal(outside.touchesArtwork, false);
      assert.deepEqual(outside.artworkPoint, extreme[0]);
      assert.ok(
        outside.edgeDescription.includes("supporting line extended beyond the artwork edge"),
        outside.edgeDescription,
      );
    }
    // An anchor ordinate through the extreme corner still touches the artwork.
    const through = measureEdgeToAnchor(
      turned,
      { x: extreme[0]!.x - 25, y: extreme[0]!.y },
      { edge: "minX", convention: "dx" },
    );
    assert.equal(through.ok, true);
    if (through.ok) {
      assert.equal(through.touchesArtwork, true);
      assert.equal(through.artworkPoint, undefined);
      assert.ok(through.edgeDescription.includes("to the left artwork edge"), through.edgeDescription);
    }
    // Same honesty vertically: anchor x outside the rotated top-edge span.
    const maxY = Math.max(...turned.map((corner) => corner.y));
    const topExtreme = turned.filter((corner) => Math.abs(corner.y - maxY) <= 1e-9);
    const dyOutside = measureEdgeToAnchor(turned, { x: 100, y: 200 }, { edge: "maxY", convention: "dy" });
    assert.equal(dyOutside.ok, true);
    if (dyOutside.ok) {
      assert.equal(dyOutside.touchesArtwork, false);
      assert.deepEqual(dyOutside.artworkPoint, topExtreme[0]);
      assert.ok(
        dyOutside.edgeDescription.includes("supporting line extended beyond the artwork edge"),
        dyOutside.edgeDescription,
      );
    }
  });

  it("shortest-to-edge lands on the finite segment with an honest label", () => {
    const turned = rotatedFootprintCorners(7, -3, 60, 40, 30);
    const anchor = { x: -40, y: 25 };
    const result = measureEdgeToAnchor(turned, anchor, { edge: "minY", convention: "shortest-to-edge" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.valueMm >= 0);
      assert.equal(result.touchesArtwork, true);
      assert.equal(result.artworkPoint, undefined);
      assert.equal(
        result.edgeDescription,
        "shortest distance to the bottom edge (nearest point on that edge)",
      );
      // The reported artwork-side endpoint lies on the footprint boundary.
      const closest = result.endpoints[0]!;
      let nearest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < turned.length; i += 1) {
        const start = turned[i]!;
        const end = turned[(i + 1) % turned.length]!;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSq = dx * dx + dy * dy;
        const t = Math.min(1, Math.max(0, ((closest.x - start.x) * dx + (closest.y - start.y) * dy) / lengthSq));
        nearest = Math.min(nearest, Math.hypot(closest.x - (start.x + t * dx), closest.y - (start.y + t * dy)));
      }
      assert.ok(nearest <= 1e-9, `closest point must lie on the segment (gap ${nearest})`);
    }
  });

  it("refuses invalid bindings and geometry instead of fabricating", () => {
    assert.deepEqual(
      measureEdgeToAnchor(footprint, { x: 0, y: 0 }, { edge: "left" as never, convention: "dx" }).ok,
      false,
    );
    assert.deepEqual(
      measureEdgeToAnchor(footprint, { x: 0, y: 0 }, { edge: "minX", convention: "dist" as never }).ok,
      false,
    );
    assert.equal(
      measureEdgeToAnchor(footprint, { x: Number.NaN, y: 0 }, { edge: "minX", convention: "dx" }).ok,
      false,
    );
    assert.equal(
      measureEdgeToAnchor([], { x: 0, y: 0 }, { edge: "minX", convention: "dx" }).ok,
      false,
    );
    assert.equal(
      measureEdgeToAnchor(
        [{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }],
        { x: 0, y: 0 },
        { edge: "minX", convention: "dx" },
      ).ok,
      false,
    );
  });
});

describe("measurePlacement", () => {
  const placement: Placement = {
    logoId: "logo-a",
    regionId: "chest",
    method: "embroider",
    pos: { xMm: 100, yMm: 75 },
    widthMm: 60,
    heightMm: 40,
    rotationDeg: 0,
  };

  function candidateFor(extraPlacements: Placement[] = []) {
    return buildCandidateExport(makeProject([placement, ...extraPlacements]), sha256Text);
  }

  it("measures dy from the anchor to the max-Y extent in millimetres", () => {
    const candidate = candidateFor();
    const exportPlacement = candidate.configurations[0]!.placements[0]!;
    const result = measurePlacement(candidate, exportPlacement, [makeAnchor()], [makeBinding()]);
    assert.deepEqual(result.unfinished, []);
    assert.equal(result.dimensions.length, 1);
    // Footprint top edge at y = 75 + 20 = 95; anchor at y = 150.
    assert.equal(result.dimensions[0]!.valueMm, 55);
    assert.equal(result.dimensions[0]!.label, "centre front to top edge, vertical");
    assert.equal(result.dimensions[0]!.fromAnchor, "Centre front");
    assert.ok(result.dimensions[0]!.toEdge.includes("max-Y"));
  });

  it("reports missing anchors as unfinished, never fabricated", () => {
    const candidate = candidateFor();
    const exportPlacement = candidate.configurations[0]!.placements[0]!;
    const result = measurePlacement(candidate, exportPlacement, [], [makeBinding()]);
    assert.deepEqual(result.dimensions, []);
    assert.equal(result.unfinished.length, 1);
    assert.ok(result.unfinished[0]!.includes('unknown anchor "cf"'));
  });

  it("reports stale variant scope as unfinished", () => {
    const candidate = candidateFor();
    const exportPlacement = candidate.configurations[0]!.placements[0]!;
    const result = measurePlacement(
      candidate,
      exportPlacement,
      [makeAnchor({ id: "stale", variantId: "xl" })],
      [makeBinding({ anchorId: "stale" })],
    );
    assert.deepEqual(result.dimensions, []);
    assert.ok(result.unfinished[0]!.includes('variant "xl"'));
  });

  it("reports wrong frame and stale calibration without internal ids", () => {
    const candidate = candidateFor();
    const exportPlacement = candidate.configurations[0]!.placements[0]!;
    const wrongFrame = measurePlacement(
      candidate, exportPlacement, [makeAnchor({ frameId: "other-frame" })], [makeBinding()],
    );
    assert.deepEqual(wrongFrame.dimensions, []);
    assert.ok(wrongFrame.unfinished[0]!.includes("frame"), wrongFrame.unfinished[0]);
    assert.ok(wrongFrame.unfinished[0]!.includes("Chest"), wrongFrame.unfinished[0]);
    assert.ok(!wrongFrame.unfinished[0]!.includes("other-frame"), wrongFrame.unfinished[0]);
    const staleCal = measurePlacement(
      candidate, exportPlacement, [makeAnchor({ calibrationVersion: "v9" })], [makeBinding()],
    );
    assert.deepEqual(staleCal.dimensions, []);
    assert.ok(staleCal.unfinished[0]!.includes("stale"), staleCal.unfinished[0]);
    assert.ok(!staleCal.unfinished[0]!.includes("v9"), staleCal.unfinished[0]);
    assert.ok(!staleCal.unfinished[0]!.includes("cal-1"), staleCal.unfinished[0]);
  });

  it("reports wrong-axis bindings as unfinished, never fabricated", () => {
    const candidate = candidateFor();
    const exportPlacement = candidate.configurations[0]!.placements[0]!;
    const result = measurePlacement(
      candidate,
      exportPlacement,
      [makeAnchor()],
      [{ ...makeBinding(), edge: "minY", convention: "dx", label: "wrong axis" }],
    );
    assert.deepEqual(result.dimensions, []);
    assert.equal(result.unfinished.length, 1);
    assert.ok(result.unfinished[0]!.includes("horizontally"), result.unfinished[0]);
  });

  it("threads arrow honesty through resolved dimensions", () => {
    const candidate = candidateFor();
    const exportPlacement = candidate.configurations[0]!.placements[0]!;
    const result = measurePlacement(candidate, exportPlacement, [makeAnchor()], [makeBinding()]);
    assert.deepEqual(result.unfinished, []);
    assert.equal(result.dimensions.length, 1);
    assert.equal(result.dimensions[0]!.touchesArtwork, true);
    assert.equal(result.dimensions[0]!.artworkPoint, undefined);
    assert.ok(result.dimensions[0]!.toEdge.includes("to the top artwork edge"), result.dimensions[0]!.toEdge);
    assert.ok(result.dimensions[0]!.toEdge.includes("max-Y"), result.dimensions[0]!.toEdge);
  });

  it("orders endpoints artwork-to-anchor for every convention on a rotated footprint", () => {
    const rotated: Placement = {
      logoId: "logo-a",
      regionId: "chest",
      method: "embroider",
      pos: { xMm: 100, yMm: 75 },
      widthMm: 60,
      heightMm: 40,
      rotationDeg: 30,
    };
    const candidate = candidateFor([rotated]);
    const exportPlacement = candidate.configurations[0]!.placements[1]!;
    const anchorDef = makeAnchor();
    const anchorPoint = { x: anchorDef.posMm[0], y: anchorDef.posMm[1] };
    const result = measurePlacement(candidate, exportPlacement, [anchorDef], [
      { logoRef: "logo-a#1", anchorId: "cf", edge: "minX", convention: "dx", label: "dx gap" },
      { logoRef: "logo-a#1", anchorId: "cf", edge: "maxY", convention: "dy", label: "dy gap" },
      { logoRef: "logo-a#1", anchorId: "cf", edge: "minX", convention: "shortest-to-edge", label: "short gap" },
    ]);
    assert.deepEqual(result.unfinished, []);
    assert.equal(result.dimensions.length, 3);
    const footprint = rotatedFootprintCorners(100, 75, 60, 40, 30);
    for (const dimension of result.dimensions) {
      // The p1-label rule names fromAnchor: p1 must be the true anchor.
      assert.deepEqual(dimension.endpoints[1], anchorPoint, `${dimension.label}: endpoints[1] is the anchor`);
      assert.equal(dimension.fromAnchor, "Centre front");
    }
    const [dx, dy, short] = result.dimensions as [typeof result.dimensions[number], typeof result.dimensions[number], typeof result.dimensions[number]];
    // Artwork-side starts: dx/dy on the anchor-ordinate extent line...
    assert.deepEqual(dx!.endpoints[0], { x: Math.min(...footprint.map((corner) => corner.x)), y: anchorPoint.y });
    assert.deepEqual(dy!.endpoints[0], { x: anchorPoint.x, y: Math.max(...footprint.map((corner) => corner.y)) });
    // ...shortest on the finite footprint segment.
    const closest = short!.endpoints[0]!;
    let nearest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < footprint.length; i += 1) {
      const start = footprint[i]!;
      const end = footprint[(i + 1) % footprint.length]!;
      const ex = end.x - start.x;
      const ey = end.y - start.y;
      const lengthSq = ex * ex + ey * ey;
      const t = Math.min(1, Math.max(0, ((closest.x - start.x) * ex + (closest.y - start.y) * ey) / lengthSq));
      nearest = Math.min(nearest, Math.hypot(closest.x - (start.x + t * ex), closest.y - (start.y + t * ey)));
    }
    assert.ok(nearest <= 1e-9, `shortest artwork-side point must lie on the segment (gap ${nearest})`);
  });

  it("reports invalid bindings as unfinished", () => {
    const candidate = candidateFor();
    const exportPlacement = candidate.configurations[0]!.placements[0]!;
    const result = measurePlacement(
      candidate,
      exportPlacement,
      [makeAnchor()],
      [{ ...makeBinding(), edge: "left" as never }],
    );
    assert.deepEqual(result.dimensions, []);
    assert.ok(result.unfinished[0]!.includes("invalid binding"));
  });

  it("marks empty binding lists unfinished without numbers", () => {
    const candidate = candidateFor();
    const exportPlacement = candidate.configurations[0]!.placements[0]!;
    const result = measurePlacement(candidate, exportPlacement, [makeAnchor()], []);
    assert.deepEqual(result.dimensions, []);
    assert.ok(result.unfinished[0]!.includes("no anchor bindings"));
  });

  it("measures each logo independently (one failure never affects another)", () => {
    const second: Placement = {
      logoId: "logo-b",
      regionId: "chest",
      method: "print",
      pos: { xMm: 50, yMm: 50 },
      widthMm: 40,
      heightMm: 20,
      rotationDeg: 0,
    };
    const candidate = candidateFor([second]);
    const [first, other] = candidate.configurations[0]!.placements;
    const shared = makeAnchor({ posMm: [0, 50] });
    const bad = measurePlacement(candidate, first!, [shared], [{ ...makeBinding(), anchorId: "missing" }]);
    assert.deepEqual(bad.dimensions, []);
    assert.equal(bad.unfinished.length, 1);
    const good = measurePlacement(
      candidate,
      other!,
      [shared],
      [{ ...makeBinding(), logoRef: "logo-b", edge: "minX", convention: "dx", label: "left gap" }],
    );
    assert.deepEqual(good.unfinished, []);
    // Footprint left extent at x = 50 - 20 = 30; anchor at x = 0.
    assert.equal(good.dimensions[0]!.valueMm, -30);
  });

  it("resolves repeated-logo occurrences via logoId#n", () => {
    const repeat: Placement = {
      logoId: "logo-a",
      regionId: "chest",
      method: "embroider",
      pos: { xMm: 150, yMm: 75 },
      widthMm: 60,
      heightMm: 40,
      rotationDeg: 0,
    };
    const candidate = candidateFor([repeat]);
    const [first, second] = candidate.configurations[0]!.placements;
    const anchor = makeAnchor({ posMm: [200, 75] });
    const firstResult = measurePlacement(
      candidate, first!, [anchor], [{ ...makeBinding(), edge: "maxX", convention: "dx" }],
    );
    // First footprint right extent at x = 130; anchor at 200.
    assert.equal(firstResult.dimensions[0]!.valueMm, 70);
    const secondResult = measurePlacement(
      candidate, second!, [anchor], [{ ...makeBinding(), logoRef: "logo-a#1", edge: "maxX", convention: "dx" }],
    );
    // Second footprint right extent at x = 180; anchor at 200.
    assert.equal(secondResult.dimensions[0]!.valueMm, 20);
  });

  it("versions the local draft contract independently", () => {
    assert.equal(OPERATION_DRAFT_VERSION, "operation-draft/1");
    assert.equal(OPERATION_DRAFT_NUMBER, 1);
  });
});

function makeDraft(extra?: Partial<OperationDraft>): OperationDraft {
  return {
    version: "operation-draft/1",
    draftVersion: 1,
    sourceRevision: 1,
    sourceDigest: "d".repeat(64),
    job: { customer: "Synthetic customer", reference: "REF-1", article: "Art-1" },
    operationalInstructions: "Press at the supplied settings; check by eye.",
    anchors: [makeAnchor()],
    dimensions: [makeBinding()],
    ...extra,
  };
}

describe("operation draft sidecar", () => {
  it("accepts a well-formed draft and reads it as fresh for its source", () => {
    const draft = makeDraft();
    assert.equal(isOperationDraft(draft), true);
    assert.equal(isStaleDraft(draft, "d".repeat(64), 1), false);
  });

  it("marks digest or revision drift stale, never rebuildable silently", () => {
    const draft = makeDraft();
    assert.equal(isStaleDraft(draft, "e".repeat(64), 1), true);
    assert.equal(isStaleDraft(draft, "d".repeat(64), 2), true);
    assert.equal(isStaleDraft(draft, "e".repeat(64), 2), true);
  });

  it("refuses malformed drafts as stale instead of rebuilding from them", () => {
    const draft = makeDraft();
    assert.equal(isOperationDraft(null), false);
    assert.equal(isStaleDraft(null, draft.sourceDigest, draft.sourceRevision), true);
    assert.equal(isStaleDraft(undefined, draft.sourceDigest, draft.sourceRevision), true);
    assert.equal(isStaleDraft({ ...draft, version: "operation-draft/9" }, draft.sourceDigest, draft.sourceRevision), true);
    assert.equal(isStaleDraft({ ...draft, draftVersion: 2 }, draft.sourceDigest, draft.sourceRevision), true);
    assert.equal(isStaleDraft({ ...draft, sourceDigest: "" }, "", draft.sourceRevision), true);
    assert.equal(isStaleDraft({ ...draft, dimensions: "x" }, draft.sourceDigest, draft.sourceRevision), true);
    assert.equal(isStaleDraft({ ...draft, anchors: "x" }, draft.sourceDigest, draft.sourceRevision), true);
    assert.equal(
      isStaleDraft(
        { ...draft, methodParams: { temperature: 145 } },
        draft.sourceDigest,
        draft.sourceRevision,
      ),
      true,
    );
    assert.equal(
      isStaleDraft(
        { ...draft, job: { customer: 7 } },
        draft.sourceDigest,
        draft.sourceRevision,
      ),
      true,
    );
  });

  it("accepts optional multi-sheet scope, method params and edit notes", () => {
    const draft = makeDraft({
      configurationId: "cfg-m",
      methodParams: { temperature: "145 C", time: "15 s" },
      updatedNote: "Added the pocket-top anchor.",
    });
    assert.equal(isOperationDraft(draft), true);
    assert.equal(isStaleDraft(draft, draft.sourceDigest, draft.sourceRevision), false);
    const minimal = makeDraft({ job: {} });
    assert.equal(isOperationDraft({ ...minimal, job: {} }), true);
  });
});
