import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addAnchor,
  addMeasurement,
  buildEvidence,
  buildSessionExport,
  canonicalPair,
  isFitCurrent,
  measurementKey,
  removeAnchor,
  removeMeasurement,
  SESSION_SCHEMA_VERSION,
  serializeSessionExport,
  snapshotEvidence,
  sortAnchors,
  sortMeasurements,
  stableStringify,
  type SessionFields,
} from "../src/core/calibration-session/index.js";
import { fitUniformScale } from "../src/core/calibration/index.js";

const SHA = "ab".repeat(32);

function fields(overrides: Partial<SessionFields> = {}): SessionFields {
  return {
    product: "plaque",
    variant: "a4",
    calibrationId: "cal-1",
    frameId: "frame-1",
    provisionalVersion: "prov-1",
    toleranceMm: 0.5,
    relativeTolerance: 0.01,
    assetFullSha256: SHA,
    ...overrides,
  };
}

describe("calibration-session: anchor drafting", () => {
  it("rejects duplicate ids and blank ids", () => {
    const first = addAnchor([], {
      id: "a",
      model: { x: 0, y: 0, z: 0 },
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(
      first.anchors.map((a) => a.id),
      ["a"],
    );
    const dup = addAnchor(first.anchors, {
      id: "a",
      model: { x: 1, y: 0, z: 0 },
    });
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.match(dup.error, /duplicate anchor id/);
    const blank = addAnchor(first.anchors, {
      id: "   ",
      model: { x: 1, y: 0, z: 0 },
    });
    assert.equal(blank.ok, false);
    const nonfinite = addAnchor(first.anchors, {
      id: "b",
      model: { x: Number.NaN, y: 0, z: 0 },
    });
    assert.equal(nonfinite.ok, false);
  });

  it("trims ids/roles and sorts deterministically", () => {
    const withRole = addAnchor([], {
      id: "  b ",
      model: { x: 1, y: 2, z: 3 },
      semanticRole: "  corner  ",
    });
    assert.equal(withRole.ok, true);
    if (!withRole.ok) return;
    assert.equal(withRole.anchors[0]?.id, "b");
    assert.equal(withRole.anchors[0]?.semanticRole, "corner");
    const second = addAnchor(withRole.anchors, {
      id: "a",
      model: { x: 0, y: 0, z: 0 },
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(
      second.anchors.map((a) => a.id),
      ["a", "b"],
    );
    assert.deepEqual(
      sortAnchors(second.anchors).map((a) => a.id),
      ["a", "b"],
    );
  });

  it("removing an anchor cascades to referencing measurements", () => {
    const anchors = [
      { id: "a", model: { x: 0, y: 0, z: 0 } },
      { id: "b", model: { x: 10, y: 0, z: 0 } },
      { id: "c", model: { x: 0, y: 5, z: 0 } },
    ];
    const m1 = addMeasurement([], anchors, { a: "a", b: "b", distanceMm: 100 });
    assert.equal(m1.ok, true);
    if (!m1.ok) return;
    const m2 = addMeasurement(m1.measurements, anchors, {
      a: "a",
      b: "c",
      distanceMm: 50,
    });
    assert.equal(m2.ok, true);
    if (!m2.ok) return;
    const next = removeAnchor(anchors, m2.measurements, "a");
    assert.deepEqual(
      next.anchors.map((a) => a.id),
      ["b", "c"],
    );
    assert.deepEqual(next.measurements, []);
  });
});

describe("calibration-session: measurements", () => {
  const anchors = [
    { id: "a", model: { x: 0, y: 0, z: 0 } },
    { id: "b", model: { x: 10, y: 0, z: 0 } },
  ];

  it("rejects same-anchor, unknown, and nonpositive distances", () => {
    const same = addMeasurement([], anchors, {
      a: "a",
      b: "a",
      distanceMm: 10,
    });
    assert.equal(same.ok, false);
    if (!same.ok) assert.match(same.error, /distinct/);
    const unknown = addMeasurement([], anchors, {
      a: "a",
      b: "ghost",
      distanceMm: 10,
    });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.error, /unknown anchor/);
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rejected = addMeasurement([], anchors, {
        a: "a",
        b: "b",
        distanceMm: bad,
      });
      assert.equal(rejected.ok, false);
    }
  });

  it("canonicalizes pair order and allows repeats", () => {
    const first = addMeasurement([], anchors, {
      a: "b",
      b: "a",
      distanceMm: 100,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual([first.measurements[0]?.a, first.measurements[0]?.b], [
      "a",
      "b",
    ]);
    const repeat = addMeasurement(first.measurements, anchors, {
      a: "a",
      b: "b",
      distanceMm: 101,
    });
    assert.equal(repeat.ok, true);
    if (!repeat.ok) return;
    assert.equal(repeat.measurements.length, 2);
    assert.deepEqual(canonicalPair("b", "a"), ["a", "b"]);
    assert.equal(measurementKey("b", "a"), measurementKey("a", "b"));
  });

  it("removeMeasurement drops one entry by index", () => {
    const first = addMeasurement([], anchors, {
      a: "a",
      b: "b",
      distanceMm: 100,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = addMeasurement(first.measurements, anchors, {
      a: "a",
      b: "b",
      distanceMm: 101,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(removeMeasurement(second.measurements, 0), [
      { a: "a", b: "b", distanceMm: 101 },
    ]);
    assert.equal(removeMeasurement(second.measurements, 9).length, 2);
  });
});

describe("calibration-session: evidence and staleness", () => {
  const anchors = [
    { id: "b", model: { x: 10, y: 0, z: 0 } },
    { id: "a", model: { x: 0, y: 0, z: 0 } },
  ];

  it("requires at least one measurement", () => {
    const built = buildEvidence(fields(), anchors, []);
    assert.equal(built.ok, false);
  });

  it("orders anchors/measurements deterministically", () => {
    const built = buildEvidence(fields(), anchors, [
      { a: "a", b: "b", distanceMm: 102 },
      { a: "a", b: "b", distanceMm: 100 },
    ]);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.deepEqual(
      built.evidence.pairs.map((p) => p.id),
      ["a", "b"],
    );
    assert.equal(built.evidence.measuredDistanceMm, 100);
    assert.deepEqual(built.evidence.pairIds, ["a", "b"]);
    assert.equal(built.evidence.extraMeasurements?.length, 1);
    // Same draft in different input order assembles identical evidence.
    const reordered = buildEvidence(fields(), [...anchors].reverse(), [
      { a: "b", b: "a", distanceMm: 100 },
      { a: "b", b: "a", distanceMm: 102 },
    ]);
    assert.equal(reordered.ok, true);
    if (!reordered.ok) return;
    assert.equal(
      snapshotEvidence(reordered.evidence),
      snapshotEvidence(built.evidence),
    );
    assert.deepEqual(
      sortMeasurements([
        { a: "a", b: "b", distanceMm: 102 },
        { a: "a", b: "b", distanceMm: 100 },
      ]).map((m) => m.distanceMm),
      [100, 102],
    );
  });

  it("snapshot comparison invalidates stale fits", () => {
    const built = buildEvidence(fields(), anchors, [
      { a: "a", b: "b", distanceMm: 100 },
    ]);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const snapshot = snapshotEvidence(built.evidence);
    assert.equal(isFitCurrent(built.evidence, snapshot), true);
    assert.equal(isFitCurrent(built.evidence, null), false);
    assert.equal(isFitCurrent(null, snapshot), false);
    const drifted = buildEvidence(fields({ product: "other" }), anchors, [
      { a: "a", b: "b", distanceMm: 100 },
    ]);
    assert.equal(drifted.ok, true);
    if (!drifted.ok) return;
    assert.equal(isFitCurrent(drifted.evidence, snapshot), false);
  });

  it("stableStringify sorts keys and preserves array order", () => {
    assert.equal(
      stableStringify({ b: 1, a: 2, nested: { d: 4, c: 3 } }),
      '{"a":2,"b":1,"nested":{"c":3,"d":4}}',
    );
    assert.equal(stableStringify([2, 1]), "[2,1]");
  });
});

describe("calibration-session: export shape", () => {
  it("builds a deterministic pending-review envelope without timestamps", () => {
    const built = buildEvidence(fields(), [
      { id: "a", model: { x: 0, y: 0, z: 0 } },
      { id: "b", model: { x: 10, y: 0, z: 0 } },
    ], [{ a: "a", b: "b", distanceMm: 100 }]);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const fit = fitUniformScale(built.evidence);
    assert.equal(fit.pendingReview, true);
    assert.equal(fit.productionApproved, false);
    const session = buildSessionExport(built.evidence, fit);
    assert.equal(session.schemaVersion, SESSION_SCHEMA_VERSION);
    assert.equal(
      session.schemaVersion,
      "0.1.0-provisional-calibration-session",
    );
    assert.deepEqual(Object.keys(session), [
      "schemaVersion",
      "evidence",
      "fit",
    ]);
    const text = serializeSessionExport(session);
    assert.match(text, /pendingReview/);
    assert.ok(!("createdAt" in session) && !("timestamp" in session));
    assert.equal(text.includes("createdAt"), false);
    assert.equal(serializeSessionExport(session), text);
    const parsed = JSON.parse(text) as {
      schemaVersion: string;
      evidence: { assetFullSha256: string };
      fit: { pendingReview: boolean; productionApproved: boolean };
    };
    assert.equal(parsed.schemaVersion, SESSION_SCHEMA_VERSION);
    assert.equal(parsed.evidence.assetFullSha256, SHA);
    assert.equal(parsed.fit.pendingReview, true);
    assert.equal(parsed.fit.productionApproved, false);
  });
});
