import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPlanarMapping,
  fitUniformScale,
  validateCalibrationEvidence,
  type CalibrationEvidence,
} from "../src/core/calibration/index.js";

function baseEvidence(overrides: Partial<CalibrationEvidence> = {}): CalibrationEvidence {
  return {
    calibrationId: "syn-calibration", frameId: "syn-frame",
    assetFullSha256: "ab".repeat(32),
    product: "plaque",
    variant: "a4",
    pairs: [
      { id: "left", model: { x: 0, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
      { id: "right", model: { x: 10, y: 0, z: 0 }, physical: { x: 100, y: 0 } },
    ],
    measuredDistanceMm: 100,
    pairIds: ["left", "right"],
    provisionalVersion: "prov-1",
    ...overrides,
  };
}

describe("calibration: validateCalibrationEvidence", () => {
  it("accepts a minimal valid evidence", () => {
    assert.equal(validateCalibrationEvidence(baseEvidence()).ok, true);
  });

  it("rejects bad sha, empty strings, negative distance, bad tolerances", () => {
    const badSha = validateCalibrationEvidence(baseEvidence({ assetFullSha256: "AB".repeat(32) }));
    assert.equal(badSha.ok, false);
    if (!badSha.ok) assert.match(badSha.errors.join(";"), /assetFullSha256/);

    const emptyProduct = validateCalibrationEvidence(baseEvidence({ product: "  " }));
    assert.equal(emptyProduct.ok, false);

    const negDist = validateCalibrationEvidence(baseEvidence({ measuredDistanceMm: -5 }));
    assert.equal(negDist.ok, false);
    if (!negDist.ok) assert.match(negDist.errors.join(";"), /> 0/);

    const negTol = validateCalibrationEvidence(baseEvidence({ toleranceMm: -1 }));
    assert.equal(negTol.ok, false);

    const nanTol = validateCalibrationEvidence(
      baseEvidence({ relativeTolerance: Number.POSITIVE_INFINITY }),
    );
    assert.equal(nanTol.ok, false);
  });

  it("rejects duplicate, empty, and unknown anchor ids", () => {
    const dup = validateCalibrationEvidence(
      baseEvidence({
        pairs: [
          { id: "a", model: { x: 0, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
          { id: "a", model: { x: 1, y: 0, z: 0 }, physical: { x: 1, y: 0 } },
        ],
        pairIds: ["a", "a"],
      }),
    );
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.match(dup.errors.join(";"), /distinct|duplicated/);

    const empty = validateCalibrationEvidence(
      baseEvidence({
        pairs: [
          { id: "", model: { x: 0, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
          { id: "b", model: { x: 1, y: 0, z: 0 }, physical: { x: 1, y: 0 } },
        ],
      }),
    );
    assert.equal(empty.ok, false);

    const unknown = validateCalibrationEvidence(baseEvidence({ pairIds: ["left", "ghost"] }));
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.errors.join(";"), /unknown anchor id "ghost"/);
  });

  it("rejects nonfinite coords, too few pairs, zero spans, same-anchor refs", () => {
    const nonfinite = validateCalibrationEvidence(
      baseEvidence({
        pairs: [
          { id: "a", model: { x: Number.NaN, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
          { id: "b", model: { x: 1, y: 0, z: 0 }, physical: { x: 0, y: Number.POSITIVE_INFINITY } },
        ],
      }),
    );
    assert.equal(nonfinite.ok, false);
    if (!nonfinite.ok) assert.match(nonfinite.errors.join(";"), /finite/);

    const onePair = validateCalibrationEvidence(
      baseEvidence({
        pairs: [{ id: "solo", model: { x: 0, y: 0, z: 0 }, physical: { x: 0, y: 0 } }],
        pairIds: ["solo", "missing"],
      }),
    );
    assert.equal(onePair.ok, false);

    const zeroSpan = validateCalibrationEvidence(
      baseEvidence({
        pairs: [
          { id: "a", model: { x: 2, y: 2, z: 2 }, physical: { x: 0, y: 0 } },
          { id: "b", model: { x: 2, y: 2, z: 2 }, physical: { x: 1, y: 0 } },
        ],
        pairIds: ["a", "b"],
      }),
    );
    assert.equal(zeroSpan.ok, false);
    if (!zeroSpan.ok) assert.match(zeroSpan.errors.join(";"), /zero or non-finite/);

    const sameRef = validateCalibrationEvidence(baseEvidence({ pairIds: ["left", "left"] }));
    assert.equal(sameRef.ok, false);
  });

  it("rejects malformed extraMeasurements", () => {
    const bad = validateCalibrationEvidence(
      baseEvidence({
        extraMeasurements: [{ pairIds: ["left", "left"], distanceMm: -2 }],
      }),
    );
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.match(bad.errors.join(";"), /distinct/);
      assert.match(bad.errors.join(";"), /> 0/);
    }
  });
});

describe("calibration: fitUniformScale", () => {
  it("fits single-pair scale as measured/model", () => {
    const r = fitUniformScale(baseEvidence());
    assert.equal(r.scaleMmPerUnit, 10);
    assert.equal(r.perPair.length, 1);
    assert.equal(r.maxResidualMm, 0);
    assert.equal(r.inconsistent, false);
    assert.equal(r.productionApproved, false);
    assert.equal(r.pendingReview, true);
    assert.equal(r.provisionalVersion, "prov-1");
    assert.ok(r.limitations.length >= 2);
    assert.match(r.limitations.join(" "), /anisotropy/);
  });

  it("fits multiple scales consistently", () => {
    for (const scale of [0.25, 2, 40]) {
      const r = fitUniformScale(
        baseEvidence({
          pairs: [
            { id: "a", model: { x: 0, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
            { id: "b", model: { x: 4, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
          ],
          measuredDistanceMm: 4 * scale,
          pairIds: ["a", "b"],
        }),
      );
      assert.ok(Math.abs(r.scaleMmPerUnit - scale) < 1e-12);
      assert.equal(r.inconsistent, false);
      assert.equal(r.productionApproved, false);
      assert.equal(r.pendingReview, true);
    }
  });

  it("least-squares over primary + extras; reversed refs give the same span", () => {
    const mk = (pairIds: [string, string]) =>
      baseEvidence({
        pairs: [
          { id: "a", model: { x: 0, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
          { id: "b", model: { x: 10, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
          { id: "c", model: { x: 0, y: 20, z: 0 }, physical: { x: 0, y: 0 } },
        ],
        measuredDistanceMm: 100,
        pairIds,
        provisionalVersion: "prov-1",
        extraMeasurements: [{ pairIds: ["a", "c"], distanceMm: 200 }],
      });
    const fwd = fitUniformScale(mk(["a", "b"]));
    const rev = fitUniformScale(mk(["b", "a"]));
    assert.equal(fwd.scaleMmPerUnit, 10);
    assert.equal(rev.scaleMmPerUnit, 10);
    assert.equal(fwd.inconsistent, false);
    // Per-pair rows sorted by id, deterministic regardless of input order.
    assert.deepEqual(
      fwd.perPair.map((p) => p.id),
      [JSON.stringify(["a", "b"]), JSON.stringify(["a", "c"])],
    );
    assert.deepEqual(
      rev.perPair.map((p) => p.id),
      [JSON.stringify(["a", "b"]), JSON.stringify(["a", "c"])],
    );
    assert.ok(Math.abs(fwd.maxResidualMm) < 1e-12);
  });

  it("least-squares compromise when spans disagree; flags inconsistency", () => {
    // model spans 10 and 20; measurements imply scales 10 and 11.
    const r = fitUniformScale(
      baseEvidence({
        pairs: [
          { id: "a", model: { x: 0, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
          { id: "b", model: { x: 10, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
          { id: "c", model: { x: 0, y: 20, z: 0 }, physical: { x: 0, y: 0 } },
        ],
        measuredDistanceMm: 100,
        pairIds: ["a", "b"],
        extraMeasurements: [{ pairIds: ["a", "c"], distanceMm: 220 }],
      }),
    );
    const expected = (10 * 100 + 20 * 220) / (10 * 10 + 20 * 20);
    assert.ok(Math.abs(r.scaleMmPerUnit - expected) < 1e-12);
    assert.equal(r.inconsistent, true);
    assert.equal(r.productionApproved, false);
    assert.equal(r.pendingReview, true);
    assert.ok(r.maxResidualMm > 0.5);
  });

  it("custom FitOptions tolerances widen/narrow the inconsistency verdict", () => {
    const ev = baseEvidence({
      pairs: [
        { id: "a", model: { x: 0, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
        { id: "b", model: { x: 10, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
        { id: "c", model: { x: 0, y: 20, z: 0 }, physical: { x: 0, y: 0 } },
      ],
      measuredDistanceMm: 100,
      pairIds: ["a", "b"],
      extraMeasurements: [{ pairIds: ["a", "c"], distanceMm: 205 }],
    });
    const strict = fitUniformScale(ev);
    assert.equal(strict.inconsistent, true);
    const loose = fitUniformScale(ev, { toleranceMm: 50, relativeTolerance: 1 });
    assert.equal(loose.inconsistent, false);
    assert.equal(loose.productionApproved, false);
    assert.equal(loose.pendingReview, true);
    assert.throws(() => fitUniformScale(ev, { toleranceMm: -1 }), /toleranceMm/);
  });

  it("output is order-independent (pairs and extras shuffled)", () => {
    const anchors = [
      { id: "a", model: { x: 0, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
      { id: "b", model: { x: 10, y: 0, z: 0 }, physical: { x: 0, y: 0 } },
      { id: "c", model: { x: 0, y: 20, z: 0 }, physical: { x: 0, y: 0 } },
    ] as CalibrationEvidence["pairs"];
    const first = fitUniformScale(
      baseEvidence({
        pairs: anchors,
        pairIds: ["a", "b"],
        extraMeasurements: [{ pairIds: ["a", "c"], distanceMm: 200 }],
      }),
    );
    const third = fitUniformScale(
      baseEvidence({
        pairs: [...anchors].reverse(),
        measuredDistanceMm: 100,
        pairIds: ["b", "a"],
        extraMeasurements: [{ pairIds: ["c", "a"], distanceMm: 200 }],
      }),
    );
    assert.deepEqual(
      first.perPair.map((p) => [p.id, p.predictedDistanceMm, p.residualMm]),
      third.perPair.map((p) => [p.id, p.predictedDistanceMm, p.residualMm]),
    );
    assert.equal(first.scaleMmPerUnit, third.scaleMmPerUnit);
  });

  it("throws on invalid evidence or zero span", () => {
    assert.throws(() => fitUniformScale(baseEvidence({ measuredDistanceMm: 0 })), /invalid/);
    assert.throws(
      () =>
        fitUniformScale(
          baseEvidence({
            pairs: [
              { id: "a", model: { x: 1, y: 1, z: 1 }, physical: { x: 0, y: 0 } },
              { id: "b", model: { x: 1, y: 1, z: 1 }, physical: { x: 0, y: 0 } },
            ],
            pairIds: ["a", "b"],
          }),
        ),
      /invalid/,
    );
  });
});

describe("calibration: createPlanarMapping", () => {
  it("roundtrips on the identity plane", () => {
    const m = createPlanarMapping({
      frameId: "test-plane", origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      mmPerModelUnit: 10,
      offPlaneToleranceMm: 0.5,
    });
    assert.deepEqual(m.normal, { x: 0, y: 0, z: 1 });
    const model = m.toModel({ x: 30, y: 40 });
    assert.deepEqual(model, { x: 3, y: 4, z: 0 });
    const back = m.toPhysicalMm(model);
    assert.ok(!("error" in back));
    if (!("error" in back)) {
      assert.ok(Math.abs(back.point.x - 30) < 1e-9);
      assert.ok(Math.abs(back.point.y - 40) < 1e-9);
      assert.ok(back.offPlaneMm < 1e-9);
    }
  });

  it("roundtrips on translated/rotated planes", () => {
    const inv = 1 / Math.SQRT2;
    const cases = [
      {
        frameId: "test-plane", origin: { x: 5, y: -3, z: 2 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        mmPerModelUnit: 25.4,
      },
      {
        // 45-degree rotated in-plane axes.
        frameId: "test-plane", origin: { x: 0, y: 0, z: 7 },
        xAxis: { x: inv, y: inv, z: 0 },
        yAxis: { x: -inv, y: inv, z: 0 },
        mmPerModelUnit: 2,
      },
      {
        // Vertical (x-z) plane: normal is -y.
        frameId: "test-plane", origin: { x: 1, y: 2, z: 3 },
        xAxis: { x: 0, y: 0, z: 1 },
        yAxis: { x: 1, y: 0, z: 0 },
        mmPerModelUnit: 5,
      },
    ];
    for (const frame of cases) {
      const mapping = createPlanarMapping({ ...frame, offPlaneToleranceMm: 0.25 });
      for (const p of [
        { x: 0, y: 0 },
        { x: 12.5, y: -7.25 },
        { x: 200, y: 150 },
      ]) {
        const back = mapping.toPhysicalMm(mapping.toModel(p));
        assert.ok(!("error" in back), `roundtrip failed for ${JSON.stringify(frame)}`);
        if (!("error" in back)) {
          assert.ok(Math.abs(back.point.x - p.x) < 1e-9, `x drifted: ${back.point.x} vs ${p.x}`);
          assert.ok(Math.abs(back.point.y - p.y) < 1e-9, `y drifted: ${back.point.y} vs ${p.y}`);
        }
      }
    }
  });

  it("normalizes non-unit axes (scale preserved)", () => {
    const m = createPlanarMapping({
      frameId: "test-plane", origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 3, y: 0, z: 0 },
      yAxis: { x: 0, y: 0, z: 4 },
      mmPerModelUnit: 10,
      offPlaneToleranceMm: 1,
    });
    // u = 10/10 = 1 along +x, w = 20/10 = 2 along +z.
    assert.deepEqual(m.toModel({ x: 10, y: 20 }), { x: 1, y: 0, z: 2 });
  });

  it("rejects off-plane points beyond tolerance (no silent projection)", () => {
    const m = createPlanarMapping({
      frameId: "test-plane", origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      mmPerModelUnit: 10,
      offPlaneToleranceMm: 0.5,
    });
    const onPlane = m.toPhysicalMm({ x: 1, y: 2, z: 0.04 });
    assert.ok(!("error" in onPlane));
    const off = m.toPhysicalMm({ x: 1, y: 2, z: 5 });
    assert.ok("error" in off);
    if ("error" in off) assert.match(off.error, /off-plane/);
    // Boundary: exactly at tolerance passes.
    const edge = m.toPhysicalMm({ x: 0, y: 0, z: 0.05 });
    assert.ok(!("error" in edge));
  });

  it("throws on degenerate, non-orthogonal, or malformed frames", () => {
    const good = {
      frameId: "test-plane", origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      mmPerModelUnit: 10,
      offPlaneToleranceMm: 0.5,
    };
    assert.throws(() => createPlanarMapping({ ...good, xAxis: { x: 0, y: 0, z: 0 } }), /nonzero/);
    assert.throws(() => createPlanarMapping({ ...good, yAxis: { x: 1, y: 0, z: 0 } }), /orthogonal/);
    assert.throws(() => createPlanarMapping({ ...good, mmPerModelUnit: 0 }), /mmPerModelUnit/);
    assert.throws(
      () => createPlanarMapping({ ...good, mmPerModelUnit: Number.NaN }),
      /mmPerModelUnit/,
    );
    assert.throws(
      () => createPlanarMapping({ ...good, offPlaneToleranceMm: -1 }),
      /offPlaneToleranceMm/,
    );
    assert.throws(
      () =>
        createPlanarMapping({
          ...good,
          frameId: "test-plane", origin: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 },
        }),
      /origin/,
    );
    assert.throws(
      () =>
        createPlanarMapping({
          ...good,
          xAxis: { x: 1, y: 1, z: 0 },
          yAxis: { x: 1, y: 0.999999, z: 0 },
        }),
      /orthogonal/,
    );
  });

  it("toModel/toPhysicalMm validate inputs", () => {
    const m = createPlanarMapping({
      frameId: "test-plane", origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      mmPerModelUnit: 10,
      offPlaneToleranceMm: 1,
    });
    assert.throws(() => m.toModel({ x: Number.NaN, y: 0 }), /finite/);
    assert.throws(() => m.toPhysicalMm({ x: 0, y: 0, z: Number.NaN }), /finite/);
  });
});

describe('calibration: independent review regressions', () => {
  it('returns validation errors for null anchors instead of throwing', () => {
    const evidence = baseEvidence();
    evidence.pairs.unshift(null as unknown as typeof evidence.pairs[number]);
    assert.equal(validateCalibrationEvidence(evidence).ok, false);
  });
  it('anchors can be marked without inventing physical coordinates', () => {
    const evidence = baseEvidence({pairs: [{id: 'left', semanticRole: 'datum', model: {x: 0, y: 0, z: 0}}, {id: 'right', semanticRole: 'arbitrary-landmark', model: {x: 10, y: 0, z: 0}}]});
    const result = fitUniformScale(evidence);
    assert.equal(result.scaleMmPerUnit, 10);
    assert.equal(result.assetFullSha256, evidence.assetFullSha256);
    assert.equal(result.calibrationId, evidence.calibrationId);
    assert.equal(result.frameId, evidence.frameId);
    assert.equal(result.variant, evidence.variant);
    assert.equal(result.productionApproved, false);
    assert.equal(validateCalibrationEvidence({...evidence, frameId: ''}).ok, false);
  });
  it('whole fit result is identical after measurement reordering and pair reversal', () => {
    const first = baseEvidence({extraMeasurements: [{pairIds: ['left', 'right'], distanceMm: 1e16}, {pairIds: ['right', 'left'], distanceMm: 3.2}]});
    const second = baseEvidence({pairIds: ['right', 'left'], extraMeasurements: [...first.extraMeasurements!].reverse()});
    assert.deepEqual(fitUniformScale(first), fitUniformScale(second));
  });
  it('anchor IDs containing separators do not collide', () => {
    const result = fitUniformScale(baseEvidence({pairs: [
      {id: 'a|b', model: {x: 0, y: 0, z: 0}}, {id: 'c', model: {x: 1, y: 0, z: 0}},
      {id: 'a', model: {x: 0, y: 1, z: 0}}, {id: 'b|c', model: {x: 1, y: 1, z: 0}},
    ],pairIds: ['a|b', 'c'], measuredDistanceMm: 10, extraMeasurements: [{pairIds: ['a', 'b|c'], distanceMm: 10}]}));
    assert.equal(new Set(result.perPair.map(row => row.id)).size, 2);
  });
  it('rejects arithmetic overflow and underflow rather than returning nonfinite fits', () => {
    assert.throws(() => fitUniformScale(baseEvidence({measuredDistanceMm: 1e308})), /numeric range/);
    assert.throws(() => fitUniformScale(baseEvidence({pairs: [{id: 'left', model: {x: 0, y: 0, z: 0}}, {id: 'right', model: {x: 1e-200, y: 0, z: 0}}]})), /numeric range/);
  });
  it('normalizes accepted near-orthogonal axes to a reversible orthonormal frame', () => {
    const mapping = createPlanarMapping({frameId: 'plane', origin: {x: 0, y: 0, z: 0}, xAxis: {x: 1, y: 0, z: 0}, yAxis: {x: 5e-7, y: 1, z: 0}, mmPerModelUnit: 1, offPlaneToleranceMm: 0});
    const point = {x: 1e6, y: 2e6};
    const back = mapping.toPhysicalMm(mapping.toModel(point));
    assert.ok(!('error' in back)); if (!('error' in back)) assert.deepEqual(back.point, point);
  });
  it('rejects mapping overflow from finite values in both directions', () => {
    const spec = {frameId: 'plane', origin: {x: 0, y: 0, z: 0}, xAxis: {x: 1, y: 0, z: 0}, yAxis: {x: 0, y: 1, z: 0}, mmPerModelUnit: 1e-300, offPlaneToleranceMm: 0};
    assert.throws(() => createPlanarMapping(spec).toModel({x: 1e300, y: 0}), /numeric range/);
    assert.throws(() => createPlanarMapping({...spec, mmPerModelUnit: 1e300}).toPhysicalMm({x: 1e300, y: 0, z: 0}), /numeric range/);
  });
});
