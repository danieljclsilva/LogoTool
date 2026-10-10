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
  parseSessionRestore,
  removeAnchor,
  removeMeasurement,
  RESTORE_LIMITS,
  SESSION_SCHEMA_VERSION,
  serializeSessionExport,
  snapshotEvidence,
  sortAnchors,
  sortMeasurements,
  stableStringify,
  type DraftAnchor,
  type SessionExport,
  type SessionFields,
} from "../src/core/calibration-session/index.js";
import {
  fitUniformScale,
  validateCalibrationEvidence,
  type CalibrationEvidence,
} from "../src/core/calibration/index.js";

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

const OTHER_SHA = "cd".repeat(32);

function restoreAnchors(): DraftAnchor[] {
  return [
    { id: "a", model: { x: 0, y: 0, z: 0 } },
    { id: "b", model: { x: 10, y: 0, z: 0 } },
  ];
}

function exportText(
  evidenceOverrides: Partial<CalibrationEvidence> = {},
  fitOverrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
): string {
  const built = buildEvidence(fields(), restoreAnchors(), [
    { a: "a", b: "b", distanceMm: 100 },
  ]);
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("fixture evidence failed");
  const fit = fitUniformScale(built.evidence);
  const session = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    evidence: { ...built.evidence, ...evidenceOverrides },
    fit: { ...fit, ...fitOverrides },
    ...envelopeOverrides,
  };
  return JSON.stringify(session);
}

function assertRestoreError(
  text: string,
  sha: string,
  pattern: RegExp,
): string {
  const parsed = parseSessionRestore(text, sha);
  assert.equal(parsed.ok, false);
  if (parsed.ok) throw new Error("expected restore failure");
  assert.match(parsed.error, pattern);
  return parsed.error;
}

describe("calibration-session: restore input shape", () => {
  it("rejects non-JSON, non-object, and incomplete envelopes", () => {
    assertRestoreError("{truncated", SHA, /not valid JSON/);
    const nonString = parseSessionRestore(42 as unknown as string, SHA);
    assert.equal(nonString.ok, false);
    assertRestoreError('"just a string"', SHA, /envelope must be an object/);
    assertRestoreError("[1,2]", SHA, /envelope must be an object/);
    assertRestoreError(
      JSON.stringify({
        schemaVersion: SESSION_SCHEMA_VERSION,
        fit: {},
      }),
      SHA,
      /evidence must be an object/,
    );
    assertRestoreError(
      JSON.stringify({
        schemaVersion: SESSION_SCHEMA_VERSION,
        evidence: "not-an-object",
        fit: {},
      }),
      SHA,
      /evidence must be an object/,
    );
    assertRestoreError(
      JSON.stringify({
        schemaVersion: SESSION_SCHEMA_VERSION,
        evidence: {},
        fit: {},
      }),
      SHA,
      /pairs must be an array/,
    );
    const nullFit = JSON.parse(exportText()) as Record<string, unknown>;
    nullFit["fit"] = null;
    assertRestoreError(JSON.stringify(nullFit), SHA, /fit must be an object/);
  });

  it("rejects missing and unknown session versions", () => {
    const missing = JSON.parse(exportText()) as Record<string, unknown>;
    delete missing["schemaVersion"];
    assertRestoreError(
      JSON.stringify(missing),
      SHA,
      /unknown or mismatched session version/,
    );
    assertRestoreError(
      exportText({}, {}, { schemaVersion: "9.9.9-future" }),
      SHA,
      /unknown or mismatched session version/,
    );
    assertRestoreError(
      exportText({}, {}, { schemaVersion: 3 }),
      SHA,
      /unknown or mismatched session version/,
    );
  });
});

describe("calibration-session: restore trust policy", () => {
  it("rejects malformed runtime evidence before any draft is returned", () => {
    const invalid: [Record<string, unknown>, RegExp][] = [
      [{ product: " " }, /product/],
      [{ assetFullSha256: "bad" }, /assetFullSha256/],
      [{ pairIds: ["a", "missing"] }, /unknown anchor/],
      [{ pairIds: ["a", "a"] }, /distinct anchors/],
      [{ measuredDistanceMm: 0 }, /must be > 0/],
      [{ toleranceMm: -1 }, /toleranceMm/],
      [{ relativeTolerance: null }, /relativeTolerance/],
      [{ extraMeasurements: [null] }, /extraMeasurements/],
      [{ pairs: [{ id: "a", model: { x: 0, y: 0, z: 0 } },
                 { id: "a", model: { x: 1, y: 0, z: 0 } }] }, /duplicated/],
      [{ pairs: [{ id: "a", model: { x: "0", y: 0, z: 0 } },
                 { id: "b", model: { x: 1, y: 0, z: 0 } }] }, /finite numbers/],
    ];
    for (const [override, pattern] of invalid) {
      assertRestoreError(exportText(override as Partial<CalibrationEvidence>), SHA, pattern);
    }
  });

  it("rejects hash mismatch including case-differing hex", () => {
    assertRestoreError(exportText(), OTHER_SHA, /asset hash does not match/);
    assertRestoreError(
      exportText(),
      SHA.toUpperCase(),
      /asset hash does not match/,
    );
    assertRestoreError(exportText(), "not-a-hash", /asset hash does not match/);
  });

  it("disregards forged fit values and refits locally", () => {
    const forged = exportText(
      {},
      {
        scaleMmPerUnit: 12345,
        productionApproved: true,
        pendingReview: false,
        inconsistent: false,
      },
    );
    const parsed = parseSessionRestore(forged, SHA);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(JSON.stringify(parsed.draft).includes("12345"), false);
    const rebuilt = buildEvidence(
      parsed.draft.fields,
      parsed.draft.anchors,
      parsed.draft.measurements,
    );
    assert.equal(rebuilt.ok, true);
    if (!rebuilt.ok) return;
    const refit = fitUniformScale(rebuilt.evidence);
    assert.notEqual(refit.scaleMmPerUnit, 12345);
    assert.equal(refit.productionApproved, false);
    assert.equal(refit.pendingReview, true);
  });

  it("roundtrips export->parse->evidence->fit byte-identically, incl. repeats and inconsistent fits", () => {
    const built = buildEvidence(fields(), restoreAnchors(), [
      { a: "a", b: "b", distanceMm: 100 },
      { a: "b", b: "a", distanceMm: 118 },
    ]);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const fit = fitUniformScale(built.evidence);
    assert.equal(fit.inconsistent, true);
    const session: SessionExport = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      evidence: built.evidence,
      fit,
    };
    const first = serializeSessionExport(session);
    const parsed = parseSessionRestore(first, SHA);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const rebuilt = buildEvidence(
      parsed.draft.fields,
      parsed.draft.anchors,
      parsed.draft.measurements,
    );
    assert.equal(rebuilt.ok, true);
    if (!rebuilt.ok) return;
    const refit = fitUniformScale(rebuilt.evidence);
    const second = serializeSessionExport({
      schemaVersion: SESSION_SCHEMA_VERSION,
      evidence: rebuilt.evidence,
      fit: refit,
    });
    assert.equal(second, first);
  });
});

describe("calibration-session: restore physical and defaults", () => {
  it("preserves optional physical and rejects non-finite physical", () => {
    const built = buildEvidence(
      fields(),
      [
        { id: "a", model: { x: 0, y: 0, z: 0 }, physical: { x: 1, y: 2 } },
        { id: "b", model: { x: 10, y: 0, z: 0 } },
      ],
      [{ a: "a", b: "b", distanceMm: 100 }],
    );
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.deepEqual(built.evidence.pairs[0]?.physical, { x: 1, y: 2 });
    const session: SessionExport = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      evidence: built.evidence,
      fit: fitUniformScale(built.evidence),
    };
    const parsed = parseSessionRestore(serializeSessionExport(session), SHA);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.draft.anchors.find((a) => a.id === "a")?.physical, {
      x: 1,
      y: 2,
    });
    assert.equal(
      parsed.draft.anchors.find((a) => a.id === "b")?.physical,
      undefined,
    );
    const plain = buildEvidence(fields(), restoreAnchors(), [
      { a: "a", b: "b", distanceMm: 100 },
    ]);
    assert.equal(plain.ok, true);
    if (!plain.ok) return;
    assert.equal("physical" in plain.evidence.pairs[0]!, false);
    const bad = exportText({
      pairs: [
        { id: "a", model: { x: 0, y: 0, z: 0 }, physical: { x: NaN, y: 0 } },
        { id: "b", model: { x: 10, y: 0, z: 0 } },
      ],
    });
    assertRestoreError(bad, SHA, /physical/);
    const direct = addAnchor([], {
      id: "a",
      model: { x: 0, y: 0, z: 0 },
      physical: { x: Number.POSITIVE_INFINITY, y: 0 },
    });
    assert.equal(direct.ok, false);
  });

  it("applies kernel tolerance defaults when omitted", () => {
    const without = JSON.parse(exportText()) as {
      evidence: Record<string, unknown>;
    };
    delete without.evidence["toleranceMm"];
    delete without.evidence["relativeTolerance"];
    const parsed = parseSessionRestore(JSON.stringify(without), SHA);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.draft.fields.toleranceMm, 0.5);
    assert.equal(parsed.draft.fields.relativeTolerance, 0.01);
    assert.equal(parsed.draft.measurements.length, 1);
  });
});

describe("calibration-session: restore limits", () => {
  it("rejects oversize text, too many anchors/measurements, and overlong strings", () => {
    assert.equal(RESTORE_LIMITS.maxBytes, 1048576);
    assert.equal(RESTORE_LIMITS.maxAnchors, 512);
    assert.equal(RESTORE_LIMITS.maxMeasurements, 2048);
    assert.equal(RESTORE_LIMITS.maxTextLength, 256);
    assertRestoreError("x".repeat(RESTORE_LIMITS.maxBytes + 1), SHA, /exceeds/);
    assertRestoreError(
      exportText({ product: "p".repeat(RESTORE_LIMITS.maxTextLength + 1) }),
      SHA,
      /exceeds/,
    );
    const tooManyAnchors = Array.from(
      { length: RESTORE_LIMITS.maxAnchors + 1 },
      (_v, i) => ({ id: `a${i}`, model: { x: i, y: 0, z: 0 } }),
    );
    assertRestoreError(
      exportText({ pairs: tooManyAnchors } as Partial<CalibrationEvidence>),
      SHA,
      /too many anchors/,
    );
    const tooManyExtras = Array.from(
      { length: RESTORE_LIMITS.maxMeasurements },
      () => ({ pairIds: ["a", "b"] as ["a", "b"], distanceMm: 100 }),
    );
    assertRestoreError(
      exportText({
        extraMeasurements: tooManyExtras,
      } as Partial<CalibrationEvidence>),
      SHA,
      /too many measurements/,
    );
    assertRestoreError(
      exportText({
        pairs: [
          { id: `a${"x".repeat(300)}`, model: { x: 0, y: 0, z: 0 } },
          { id: "b", model: { x: 10, y: 0, z: 0 } },
        ],
      } as Partial<CalibrationEvidence>),
      SHA,
      /exceeds/,
    );
  });

  it("leaves frozen inputs unmutated and returns fresh objects", () => {
    const built = buildEvidence(fields(), restoreAnchors(), [
      { a: "a", b: "b", distanceMm: 100 },
    ]);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const session: SessionExport = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      evidence: built.evidence,
      fit: fitUniformScale(built.evidence),
    };
    const text = serializeSessionExport(session);
    const frozen = JSON.parse(text) as SessionExport;
    const before = JSON.stringify(frozen);
    Object.freeze(frozen);
    Object.freeze(frozen.evidence);
    Object.freeze(frozen.evidence.pairs);
    const refrozen = JSON.stringify(frozen);
    const parsed = parseSessionRestore(refrozen, SHA);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(JSON.stringify(frozen), before);
    assert.equal(validateCalibrationEvidence(frozen.evidence).ok, true);
    assert.notEqual(parsed.draft.anchors, frozen.evidence.pairs);
    assert.notEqual(parsed.draft.fields, frozen.evidence);
    parsed.draft.anchors[0]!.id = "mutated";
    parsed.draft.fields.product = "mutated";
    parsed.draft.measurements.push({ a: "a", b: "b", distanceMm: 1 });
    assert.equal(frozen.evidence.pairs[0]!.id, "a");
    assert.equal(JSON.stringify(frozen), before);
  });
});
