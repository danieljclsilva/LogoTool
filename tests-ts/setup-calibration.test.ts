import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  distanceMm,
  fitScaleFromReferences,
  migrateLegacyCombined,
  parseSetupCalibration,
  serializeSetupCalibration,
  SETUP_CALIBRATION_VERSION,
  spanNativeDistance,
  validateNamedSafeArea,
  validateReferenceSpan,
  type NamedSafeArea,
  type ReferenceSpan,
  type SetupCalibrationBundle,
} from "../src/core/setup-calibration/index.js";

function span2D(id: string, ax: number, ay: number, bx: number, by: number, lengthMm: number): ReferenceSpan {
  return { id, a: { x: ax, y: ay }, b: { x: bx, y: by }, lengthMm };
}

function span3D(
  id: string,
  a: [number, number, number],
  b: [number, number, number],
  lengthMm: number,
): ReferenceSpan {
  return { id, a: { x: a[0], y: a[1], z: a[2] }, b: { x: b[0], y: b[1], z: b[2] }, lengthMm };
}

function squareArea(id: string, name: string, size: number): NamedSafeArea {
  return {
    id,
    name,
    points: [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: size },
      { x: 0, y: size },
    ],
  };
}

function bundle(overrides: Partial<SetupCalibrationBundle> = {}): SetupCalibrationBundle {
  return {
    version: SETUP_CALIBRATION_VERSION,
    mode: "images",
    spans: [span2D("ref-a", 0, 0, 400, 0, 100)],
    mmPerUnit: 0.25,
    areas: [squareArea("chest", "Chest", 100)],
    ...overrides,
  };
}

describe("setup-calibration: two-click A/B reference spans", () => {
  it("accepts a 2D happy-path span and fits the exact scale", () => {
    const span = span2D("ref-a", 0, 0, 400, 0, 100);
    assert.equal(validateReferenceSpan(span), null);
    assert.equal(spanNativeDistance(span), 400);
    const fit = fitScaleFromReferences([span]);
    assert.equal(fit.ok, true);
    if (!fit.ok) return;
    assert.equal(fit.mmPerUnit, 0.25);
    assert.deepEqual(fit.perSpan, [{ id: "ref-a", mmPerUnit: 0.25 }]);
  });

  it("accepts a 3D happy-path span using the straight-line chord", () => {
    const span = span3D("m1", [0, 0, 0], [0, 3, 4], 50);
    assert.equal(validateReferenceSpan(span), null);
    assert.equal(spanNativeDistance(span), 5);
    const fit = fitScaleFromReferences([span]);
    assert.equal(fit.ok, true);
    if (!fit.ok) return;
    assert.equal(fit.mmPerUnit, 10);
  });

  it("rejects empty ids, non-finite coords, bad lengths and mixed endpoints", () => {
    assert.match(validateReferenceSpan(span2D("  ", 0, 0, 1, 0, 10)) ?? "", /id/);
    const nan: ReferenceSpan = { id: "x", a: { x: NaN, y: 0 }, b: { x: 1, y: 0 }, lengthMm: 10 };
    assert.match(validateReferenceSpan(nan) ?? "", /finite/);
    assert.match(validateReferenceSpan(span2D("x", 0, 0, 1, 0, 0)) ?? "", /> 0/);
    assert.match(validateReferenceSpan(span2D("x", 0, 0, 1, 0, -5)) ?? "", /> 0/);
    assert.match(
      validateReferenceSpan(span2D("x", 0, 0, 1, 0, Number.POSITIVE_INFINITY)) ?? "",
      /finite/,
    );
    const mixed: ReferenceSpan = { id: "x", a: { x: 0, y: 0 }, b: { x: 1, y: 0, z: 0 }, lengthMm: 10 };
    assert.match(validateReferenceSpan(mixed) ?? "", /single native frame/);
  });

  it("rejects coincident A/B with null distance (zero and near-zero)", () => {
    const zero = span2D("z", 5, 5, 5, 5, 10);
    assert.match(validateReferenceSpan(zero) ?? "", /coincident/);
    assert.equal(spanNativeDistance(zero), null);
    const near = span2D("n", 0, 0, 1e-10, 0, 10);
    assert.match(validateReferenceSpan(near) ?? "", /coincident/);
    assert.equal(spanNativeDistance(near), null);
    assert.equal(spanNativeDistance(span2D("bad", 0, 0, 1, 0, 0)), null);
  });
});

describe("setup-calibration: scale behaviour", () => {
  it("is zoom-invariant: display zoom rescales units, mm stay identical", () => {
    const base = span2D("base", 10, 20, 110, 20, 50);
    const zoomed4x = span2D("zoom", 40, 80, 440, 80, 50);
    const f1 = fitScaleFromReferences([base]);
    const f2 = fitScaleFromReferences([zoomed4x]);
    assert.equal(f1.ok, true);
    assert.equal(f2.ok, true);
    if (!f1.ok || !f2.ok) return;
    assert.equal(f1.mmPerUnit, 0.5);
    assert.equal(f2.mmPerUnit, 0.125);
    // Same physical length recovered from either frame.
    assert.equal(distanceMm(100, f1.mmPerUnit), distanceMm(400, f2.mmPerUnit));
    assert.equal(distanceMm(100, f1.mmPerUnit), 50);
  });

  it("fits consistent multi-span references with deterministic id ordering", () => {
    const spans = [span2D("z-second", 0, 0, 200, 0, 50), span2D("a-first", 0, 0, 400, 0, 100)];
    const fit = fitScaleFromReferences(spans);
    assert.equal(fit.ok, true);
    if (!fit.ok) return;
    assert.equal(fit.mmPerUnit, 0.25);
    assert.deepEqual(
      fit.perSpan.map((p) => p.id),
      ["a-first", "z-second"],
    );
  });

  it("rejects inconsistent spans beyond the prototype threshold", () => {
    const fit = fitScaleFromReferences([
      span2D("ok", 0, 0, 400, 0, 100),
      span2D("off", 0, 0, 400, 0, 200),
    ]);
    assert.equal(fit.ok, false);
    if (fit.ok) return;
    assert.match(fit.error, /prototype/);
  });

  it("rejects empty input, duplicate ids and mixed 2D/3D frames", () => {
    assert.equal(fitScaleFromReferences([]).ok, false);
    const dup = fitScaleFromReferences([
      span2D("same", 0, 0, 10, 0, 5),
      span2D("same", 0, 0, 20, 0, 10),
    ]);
    assert.equal(dup.ok, false);
    if (dup.ok) return;
    assert.match(dup.error, /duplicate/);
    const mixed = fitScaleFromReferences([
      span2D("two", 0, 0, 10, 0, 5),
      span3D("three", [0, 0, 0], [1, 0, 0], 5),
    ]);
    assert.equal(mixed.ok, false);
    if (mixed.ok) return;
    assert.match(mixed.error, /one frame/);
  });

  it("distanceMm is a finite-guarded pure multiply", () => {
    assert.equal(distanceMm(400, 0.25), 100);
    assert.throws(() => distanceMm(Number.NaN, 0.25), /finite/);
    assert.throws(() => distanceMm(1, Number.POSITIVE_INFINITY), /finite/);
  });
});

describe("setup-calibration: named safe areas", () => {
  it("accepts several areas and allows renames without self-collision", () => {
    const ids: string[] = [];
    assert.equal(validateNamedSafeArea(squareArea("chest", "Chest", 100), ids), null);
    ids.push("chest");
    assert.equal(validateNamedSafeArea(squareArea("back", "Back", 80), ids), null);
    // Renaming "chest" while it keeps its own id: caller excludes self.
    assert.equal(validateNamedSafeArea(squareArea("chest", "Chest front", 100), []), null);
  });

  it("rejects duplicate ids, blank/oversized names and bad vertex counts", () => {
    assert.match(validateNamedSafeArea(squareArea("chest", "Other", 10), ["chest"]) ?? "", /duplicate/);
    assert.match(validateNamedSafeArea(squareArea("a", "   ", 10), []) ?? "", /name/);
    assert.match(validateNamedSafeArea(squareArea("a", "n".repeat(81), 10), []) ?? "", /80/);
    const two: NamedSafeArea = { id: "a", name: "A", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    assert.match(validateNamedSafeArea(two, []) ?? "", /at least 3/);
    const many: NamedSafeArea = {
      id: "a",
      name: "A",
      points: Array.from({ length: 513 }, (_, i) => ({ x: i, y: (i * i) % 7 })),
    };
    assert.match(validateNamedSafeArea(many, []) ?? "", /512/);
  });

  it("rejects self-crossing, zero-area and non-finite rings with no partial acceptance", () => {
    const bowtie: NamedSafeArea = {
      id: "bt",
      name: "Bowtie",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ],
    };
    assert.match(validateNamedSafeArea(bowtie, []) ?? "", /self-intersecting/);
    const flat: NamedSafeArea = {
      id: "fl",
      name: "Flat",
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ],
    };
    assert.match(validateNamedSafeArea(flat, []) ?? "", /zero area/);
    const bad: NamedSafeArea = {
      id: "nf",
      name: "Bad",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: Number.NaN },
      ],
    };
    assert.match(validateNamedSafeArea(bad, []) ?? "", /finite/);
  });
});

describe("setup-calibration: serialize / parse roundtrip", () => {
  it("roundtrips deterministically with sorted spans and areas", () => {
    const original = bundle({
      spans: [span2D("z", 0, 0, 200, 0, 50), span2D("a", 0, 0, 400, 0, 100)],
      areas: [squareArea("z-back", "Back", 80), squareArea("a-chest", "Chest", 100)],
    });
    const text = serializeSetupCalibration(original);
    const parsed = parseSetupCalibration(text);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(
      parsed.bundle.spans.map((s) => s.id),
      ["a", "z"],
    );
    assert.deepEqual(
      parsed.bundle.areas.map((a) => a.id),
      ["a-chest", "z-back"],
    );
    assert.equal(serializeSetupCalibration(parsed.bundle), text);
    // Caller input order never leaks into the canonical text.
    const reordered = bundle({
      spans: [span2D("a", 0, 0, 400, 0, 100), span2D("z", 0, 0, 200, 0, 50)],
      areas: [squareArea("a-chest", "Chest", 100), squareArea("z-back", "Back", 80)],
    });
    assert.equal(serializeSetupCalibration(reordered), text);
  });

  it("carries no approval flags and ignores unknown properties", () => {
    const text = serializeSetupCalibration(bundle());
    // No approval machinery at all: nothing to forge, nothing to trust.
    assert.doesNotMatch(text.toLowerCase(), /approv/);
    assert.doesNotMatch(text.toLowerCase(), /pendingreview/);
    const parsed = parseSetupCalibration({
      version: SETUP_CALIBRATION_VERSION,
      mode: "images",
      spans: [],
      mmPerUnit: null,
      areas: [],
      productionApproved: true,
      pendingReview: false,
      forged: { scale: 999 },
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.bundle, {
      version: SETUP_CALIBRATION_VERSION,
      mode: "images",
      spans: [],
      mmPerUnit: null,
      areas: [],
    });
  });

  it("rejects bounds violations, version/mode errors and frame mismatches", () => {
    assert.equal(parseSetupCalibration("not json").ok, false);
    assert.equal(parseSetupCalibration({ version: "9.9.9", mode: "images", spans: [], mmPerUnit: null, areas: [] }).ok, false);
    assert.equal(parseSetupCalibration({ version: SETUP_CALIBRATION_VERSION, mode: "side", spans: [], mmPerUnit: null, areas: [] }).ok, false);
    assert.equal(parseSetupCalibration(bundle({ mmPerUnit: -1 })).ok, false);
    // 3D spans under images mode are incoherent.
    const mismatch = bundle({ spans: [span3D("m", [0, 0, 0], [1, 0, 0], 10)] });
    assert.equal(parseSetupCalibration(JSON.parse(JSON.stringify(mismatch))).ok, false);
    const tooManySpans = bundle({
      spans: Array.from({ length: 129 }, (_, i) => span2D(`s-${i}`, 0, 0, 10 + i, 0, 5)),
    });
    assert.match(
      (parseSetupCalibration(JSON.parse(JSON.stringify(tooManySpans))) as { ok: false; error: string }).error,
      /128/,
    );
    const tooManyAreas = bundle({
      areas: Array.from({ length: 65 }, (_, i) => squareArea(`a-${i}`, `A ${i}`, 10 + i)),
    });
    assert.equal(parseSetupCalibration(JSON.parse(JSON.stringify(tooManyAreas))).ok, false);
    const tooManyVerts: NamedSafeArea = {
      id: "big",
      name: "Big",
      points: Array.from({ length: 513 }, (_, i) => ({ x: i, y: (i * i) % 11 })),
    };
    assert.equal(parseSetupCalibration({ ...bundle(), areas: [JSON.parse(JSON.stringify(tooManyVerts))] }).ok, false);
    assert.equal(parseSetupCalibration("x".repeat(1048577)).ok, false);
    assert.throws(() => serializeSetupCalibration(bundle({ mode: "side" as "images" })), /mode/);
  });
});

describe("setup-calibration: legacy combined migration", () => {
  it("migrates a model+photos shape, recomputing scale and noting inferences", () => {
    const result = migrateLegacyCombined({
      model: { spans: [{ id: "m1", a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 2 }, lengthMm: 100 }] },
      photos: [{ id: "front", spans: [] }],
      mode: "model",
      mmPerUnit: 12345,
      extra: "ignored",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.bundle.mode, "model");
    assert.equal(result.bundle.mmPerUnit, 50);
    assert.ok(result.notes.join(" ").length > 0);
    assert.match(result.notes.join("\n"), /recomputed locally/);
    assert.match(result.notes.join("\n"), /pending/);
  });

  it("infers images mode from photo spans and preserves areas verbatim", () => {
    const area = squareArea("front-logo", "Front logo", 120);
    const result = migrateLegacyCombined({
      photos: [{ id: "front", spans: [span2D("p1", 0, 0, 300, 0, 150)] }],
      areas: [JSON.parse(JSON.stringify(area))],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.bundle.mode, "images");
    assert.equal(result.bundle.mmPerUnit, 0.5);
    assert.deepEqual(result.bundle.areas, [area]);
    assert.match(result.notes.join("\n"), /inferred/);
  });

  it("rejects unrecognized shapes, bad geometry and mixed frames explicitly", () => {
    assert.equal(migrateLegacyCombined({ hello: 1 }).ok, false);
    assert.equal(migrateLegacyCombined(null).ok, false);
    const badSpan = migrateLegacyCombined({ spans: [span2D("x", 0, 0, 0, 0, 10)] });
    assert.equal(badSpan.ok, false);
    if (badSpan.ok) return;
    assert.match(badSpan.error, /coincident/);
    const mixed = migrateLegacyCombined({
      mode: "images",
      spans: [span2D("two", 0, 0, 10, 0, 5), span3D("three", [0, 0, 0], [1, 0, 0], 5)],
    });
    assert.equal(mixed.ok, false);
    if (mixed.ok) return;
    assert.match(mixed.error, /frame/);
  });

  it("leaves scale unset (with a note) when legacy spans disagree", () => {
    const result = migrateLegacyCombined({
      mode: "images",
      spans: [span2D("a", 0, 0, 100, 0, 50), span2D("b", 0, 0, 100, 0, 500)],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.bundle.mmPerUnit, null);
    assert.match(result.notes.join("\n"), /unset/);
    // Coordinates are preserved verbatim, never converted.
    assert.deepEqual(result.bundle.spans[0]?.a, { x: 0, y: 0 });
  });
});
