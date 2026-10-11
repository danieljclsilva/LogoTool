import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fitUniformScale,
  type CalibrationEvidence,
  type UniformFitResult,
} from "../src/core/calibration/index.js";
import {
  buildEvidence,
  snapshotEvidence,
  stableStringify,
  type DraftAnchor,
  type SessionFields,
} from "../src/core/calibration-session/index.js";
import {
  createPlanarRegion,
  type PlanarRegionInput,
  type PlanarRegionRecord,
} from "../src/core/planar-region/index.js";
import {
  AREA_BUNDLE_VERSION,
  addExclusion,
  buildAreaBundle,
  clearSafePolygon,
  serializeAreaBundle,
  setSafePolygon,
  type AreaBundle,
  type AreasMap,
} from "../src/core/region-areas/index.js";
import {
  AREA_RESTORE_LIMITS,
  parseAreaBundleRestore,
} from "../src/core/region-areas-restore/index.js";

const SHA = "ab".repeat(32);
const WRONG_SHA = "00".repeat(32);
// Concave chevron (simple, nonzero area, either winding accepted).
const CONCAVE_SAFE = "[[0,0],[50,50],[100,0],[100,100],[0,100]]";
const HOLE = "[[10,10],[20,10],[20,20],[10,20]]";

interface MutableTestExclusion {
  id: string;
  name: string;
  polygon: unknown;
}

interface MutableTestArea {
  regionId: string;
  frameId: string;
  frameSnapshot: string;
  safePolygon: unknown;
  exclusions: MutableTestExclusion[];
}

interface MutableTestRegion {
  regionId: string;
  frameId: string;
  origin: { x: unknown; y: unknown; z: unknown };
  originAnchorId: string;
  [key: string]: unknown;
}

interface MutableTestSession {
  evidence: Record<string, unknown>;
  fit: Record<string, unknown>;
  [key: string]: unknown;
}

interface MutableTestEnvelope {
  schemaVersion: unknown;
  pendingReview: unknown;
  productionApproved: unknown;
  session: MutableTestSession;
  regions: MutableTestRegion[];
  areas: MutableTestArea[];
  limitations: unknown;
  [key: string]: unknown;
}

// Boundary parse: raw JSON text is validated member-by-member by parseAreaBundleRestore.
function mutableEnvelope(text: string): MutableTestEnvelope {
  return JSON.parse(text) as unknown as MutableTestEnvelope;
}

function fields(): SessionFields {
  return {
    product: "synthetic-tee",
    variant: "M",
    calibrationId: "cal-1",
    frameId: "asset-root",
    provisionalVersion: "draft-1",
    toleranceMm: 0.5,
    relativeTolerance: 0.01,
    assetFullSha256: SHA,
  };
}

function anchors(): DraftAnchor[] {
  return [
    { id: "O", model: { x: 0, y: 0, z: 0 } },
    { id: "X", model: { x: 10, y: 0, z: 0 } },
    { id: "Y", model: { x: 3, y: 5, z: 0 } },
  ];
}

function evidence(): CalibrationEvidence {
  const built = buildEvidence(fields(), anchors(), [{ a: "O", b: "X", distanceMm: 100 }]);
  assert.ok(built.ok);
  return built.evidence;
}

function region(ev: CalibrationEvidence, snap: string, spec: PlanarRegionInput): PlanarRegionRecord {
  const made = createPlanarRegion(spec, anchors(), ev, snap);
  assert.ok(made.ok);
  return made.region;
}

function twoRegionBundle(): { text: string; bundle: AreaBundle; ev: CalibrationEvidence; fit: UniformFitResult } {
  const ev = evidence();
  const fit = fitUniformScale(ev);
  const snap = snapshotEvidence(ev);
  const r1 = region(ev, snap, {
    regionId: "front", frameId: "front-mm",
    originAnchorId: "O", xAnchorId: "X", yAnchorId: "Y", offPlaneToleranceMm: 0.01,
  });
  const r2 = region(ev, snap, {
    regionId: "back", frameId: "back-mm",
    originAnchorId: "X", xAnchorId: "O", yAnchorId: "Y", offPlaneToleranceMm: 0.01,
  });
  let areas: AreasMap = {};
  const safe = setSafePolygon(areas, r1, CONCAVE_SAFE);
  assert.ok(safe.ok);
  areas = safe.areas;
  const hole = addExclusion(areas, r1, "hole", "Button hole", HOLE);
  assert.ok(hole.ok);
  areas = hole.areas;
  areas = clearSafePolygon(areas, r2).areas;
  const built = buildAreaBundle(ev, fit, [r1, r2], areas, snap);
  assert.ok(built.ok);
  return { text: serializeAreaBundle(built.bundle), bundle: built.bundle, ev, fit };
}

function ring(n: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) pts.push({ x: i, y: (i * 7919) % 1000 });
  return pts;
}

function safeAreaOf(envelope: MutableTestEnvelope): MutableTestArea {
  const found = envelope.areas.find((a) => a.safePolygon !== null);
  if (found === undefined) throw new Error("fixture must have a safe area");
  return found;
}

function firstRegionOf(envelope: MutableTestEnvelope): MutableTestRegion {
  const found = envelope.regions[0];
  if (found === undefined) throw new Error("fixture must have a region");
  return found;
}

function firstAreaOf(envelope: MutableTestEnvelope): MutableTestArea {
  const found = envelope.areas[0];
  if (found === undefined) throw new Error("fixture must have an area");
  return found;
}

describe("region-areas-restore", () => {
  it("exposes the agreed limits", () => {
    assert.deepStrictEqual(AREA_RESTORE_LIMITS, {
      maxChars: 8388608,
      maxRegions: 128,
      maxVerticesPerRing: 512,
      maxExclusionsPerRegion: 64,
      maxTotalVertices: 65536,
    });
  });

  it("roundtrips concave safe + exclusion + explicit null-safe region", () => {
    const { text, fit } = twoRegionBundle();
    const parsed = parseAreaBundleRestore(text, SHA);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.deepStrictEqual(parsed.regions.map((r) => r.regionId), ["back", "front"]);
    assert.deepStrictEqual(Object.keys(parsed.areas).sort(), ["back", "front"]);
    assert.equal(Object.getPrototypeOf(parsed.areas), null);
    const front = parsed.areas["front"];
    if (front === undefined) throw new Error("restored front area is missing");
    assert.deepStrictEqual(front.safePolygon, [
      { x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ]);
    assert.equal(front.exclusions.length, 1);
    const frontHole = front.exclusions[0];
    if (frontHole === undefined) throw new Error("restored exclusion is missing");
    assert.deepStrictEqual(frontHole.polygon, [
      { x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 },
    ]);
    const back = parsed.areas["back"];
    if (back === undefined) throw new Error("restored back area is missing");
    assert.equal(back.safePolygon, null);
    assert.deepStrictEqual(back.exclusions, []);
    assert.equal(parsed.fit.scaleMmPerUnit, fit.scaleMmPerUnit);
    assert.equal(parsed.fit.pendingReview, true);
    assert.equal(parsed.fit.productionApproved, false);
    assert.equal(parsed.bundle.pendingReview, true);
    assert.equal(parsed.bundle.productionApproved, false);
    assert.equal(parsed.bundle.schemaVersion, AREA_BUNDLE_VERSION);
    assert.equal(parsed.draft.fields.assetFullSha256, SHA);
    assert.equal(parsed.draft.anchors.length, 3);
    // Save-load-save bytes are stable.
    assert.equal(serializeAreaBundle(parsed.bundle), text);
  });

  it("matches whatever the builder does for 0 regions", () => {
    const ev = evidence();
    const fit = fitUniformScale(ev);
    const snap = snapshotEvidence(ev);
    const built = buildAreaBundle(ev, fit, [], {}, snap);
    if (!built.ok) {
      assert.equal(parseAreaBundleRestore("{}", SHA).ok, false);
      return;
    }
    const text = serializeAreaBundle(built.bundle);
    const parsed = parseAreaBundleRestore(text, SHA);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.deepStrictEqual(parsed.regions, []);
    assert.deepStrictEqual(Object.keys(parsed.areas), []);
    assert.equal(serializeAreaBundle(parsed.bundle), text);
  });

  it("canonical output equals a fresh buildAreaBundle result", () => {
    const { text } = twoRegionBundle();
    const parsed = parseAreaBundleRestore(text, SHA);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const rebuilt = buildAreaBundle(
      parsed.evidence,
      {
        scaleMmPerUnit: parsed.fit.scaleMmPerUnit,
        inconsistent: parsed.fit.inconsistent,
        assetFullSha256: parsed.fit.assetFullSha256,
      },
      parsed.regions,
      parsed.areas,
      snapshotEvidence(parsed.evidence),
    );
    assert.ok(rebuilt.ok);
    if (!rebuilt.ok) return;
    assert.deepStrictEqual(parsed.bundle, rebuilt.bundle);
  });

  it("is immutable: mutating source and output keeps re-parse stable", () => {
    const { text, bundle } = twoRegionBundle();
    const textCopy = text;
    const parsed = parseAreaBundleRestore(text, SHA);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const canonical = serializeAreaBundle(parsed.bundle);
    assert.equal(canonical, text);
    // Mutate the source bundle object the text was serialized from.
    const sourceArea = bundle.areas[0];
    if (sourceArea === undefined) throw new Error("fixture must have an area");
    sourceArea.safePolygon = null;
    const sourceRegion = bundle.regions[0];
    if (sourceRegion === undefined) throw new Error("fixture must have a region");
    sourceRegion.frameId = "mutated-frame";
    bundle.session.fit.scaleMmPerUnit = -1;
    const afterSourceMutation = parseAreaBundleRestore(text, SHA);
    assert.ok(afterSourceMutation.ok);
    if (afterSourceMutation.ok) {
      assert.equal(serializeAreaBundle(afterSourceMutation.bundle), text);
    }
    // Mutate the parsed output.
    parsed.bundle.areas.length = 0;
    parsed.bundle.regions.pop();
    const front = parsed.areas["front"];
    if (front === undefined) throw new Error("restored front area is missing");
    front.safePolygon = null;
    front.exclusions.length = 0;
    const again = parseAreaBundleRestore(text, SHA);
    assert.ok(again.ok);
    if (again.ok) assert.equal(serializeAreaBundle(again.bundle), text);
    assert.equal(text, textCopy);
  });

  it("canonicalizes reordered regions and areas", () => {
    const { text } = twoRegionBundle();
    const m = mutableEnvelope(text);
    m.regions.reverse();
    m.areas.reverse();
    const parsed = parseAreaBundleRestore(JSON.stringify(m), SHA);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.deepStrictEqual(parsed.regions.map((r) => r.regionId), ["back", "front"]);
    assert.deepStrictEqual(parsed.bundle.areas.map((a) => a.regionId), ["back", "front"]);
    assert.equal(serializeAreaBundle(parsed.bundle), text);
  });

  it("recomputes forged fit scale and forces pending review", () => {
    const { text, fit } = twoRegionBundle();
    const m = mutableEnvelope(text);
    m.session.fit["scaleMmPerUnit"] = 1234.5;
    m.pendingReview = false;
    m.productionApproved = true;
    m.session.fit["pendingReview"] = false;
    m.session.fit["productionApproved"] = true;
    const parsed = parseAreaBundleRestore(JSON.stringify(m), SHA);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.fit.scaleMmPerUnit, fit.scaleMmPerUnit);
    assert.notEqual(parsed.fit.scaleMmPerUnit, 1234.5);
    assert.equal(parsed.fit.scaleMmPerUnit, fitUniformScale(parsed.evidence).scaleMmPerUnit);
    assert.equal(parsed.fit.pendingReview, true);
    assert.equal(parsed.fit.productionApproved, false);
    assert.equal(parsed.bundle.pendingReview, true);
    assert.equal(parsed.bundle.productionApproved, false);
    assert.equal(parsed.bundle.session.fit.scaleMmPerUnit, fit.scaleMmPerUnit);
    assert.equal(parsed.bundle.session.fit.pendingReview, true);
    assert.equal(parsed.bundle.session.fit.productionApproved, false);
  });

  it("rejects hash mismatch, malformed expected hash, and bad versions", () => {
    const { text } = twoRegionBundle();
    assert.equal(parseAreaBundleRestore(text, WRONG_SHA).ok, false);
    assert.equal(parseAreaBundleRestore(text, "not-a-hash").ok, false);
    assert.equal(parseAreaBundleRestore(text, "").ok, false);
    for (const version of ["9.9.9-future", "0.1.0-provisional-planar-regions", "", null]) {
      const m = mutableEnvelope(text);
      m.schemaVersion = version;
      assert.equal(parseAreaBundleRestore(JSON.stringify(m), SHA).ok, false);
    }
  });

  it("requires every structural envelope field", () => {
    const { text } = twoRegionBundle();
    for (const key of ["pendingReview", "productionApproved", "session", "regions", "areas", "limitations"]) {
      const m = mutableEnvelope(text);
      delete m[key];
      assert.equal(parseAreaBundleRestore(JSON.stringify(m), SHA).ok, false);
    }
    const sessionArray = mutableEnvelope(text);
    const sessionKey: string = "session";
    sessionArray[sessionKey] = [];
    assert.equal(parseAreaBundleRestore(JSON.stringify(sessionArray), SHA).ok, false);
    const regionsObject = mutableEnvelope(text);
    const regionsKey: string = "regions";
    regionsObject[regionsKey] = {};
    assert.equal(parseAreaBundleRestore(JSON.stringify(regionsObject), SHA).ok, false);
  });

  it("rejects bad region vectors and dangling anchor refs", () => {
    const { text } = twoRegionBundle();
    const badVector = mutableEnvelope(text);
    const badVectorRegion = firstRegionOf(badVector);
    badVectorRegion.origin.x = "bad";
    // Areas order is canonical (back, front); fix whichever area binds region 0.
    for (const area of badVector.areas) {
      if (area.regionId === badVectorRegion.regionId) area.frameSnapshot = stableStringify(badVectorRegion);
    }
    assert.equal(parseAreaBundleRestore(JSON.stringify(badVector), SHA).ok, false);

    const badRef = mutableEnvelope(text);
    const badRefRegion = firstRegionOf(badRef);
    badRefRegion.originAnchorId = "ghost-anchor";
    for (const area of badRef.areas) {
      if (area.regionId === badRefRegion.regionId) area.frameSnapshot = stableStringify(badRefRegion);
    }
    assert.equal(parseAreaBundleRestore(JSON.stringify(badRef), SHA).ok, false);
  });

  it("rejects stale frame bindings and snapshots", () => {
    const { text } = twoRegionBundle();
    const staleSnapshot = mutableEnvelope(text);
    firstAreaOf(staleSnapshot).frameSnapshot = "stale-snapshot";
    assert.equal(parseAreaBundleRestore(JSON.stringify(staleSnapshot), SHA).ok, false);
    const staleFrame = mutableEnvelope(text);
    firstAreaOf(staleFrame).frameId = "other-frame";
    assert.equal(parseAreaBundleRestore(JSON.stringify(staleFrame), SHA).ok, false);
  });

  it("rejects invalid tolerances", () => {
    const { text } = twoRegionBundle();
    const negative = mutableEnvelope(text);
    negative.session.evidence["toleranceMm"] = -1;
    assert.equal(parseAreaBundleRestore(JSON.stringify(negative), SHA).ok, false);
    const numericString = mutableEnvelope(text);
    numericString.session.evidence["relativeTolerance"] = "0.01";
    assert.equal(parseAreaBundleRestore(JSON.stringify(numericString), SHA).ok, false);
  });

  it("rejects invalid polygons that pass structural checks", () => {
    const { text } = twoRegionBundle();
    const crossing = mutableEnvelope(text);
    safeAreaOf(crossing).safePolygon = [
      { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 },
    ];
    assert.equal(parseAreaBundleRestore(JSON.stringify(crossing), SHA).ok, false);
    const zeroArea = mutableEnvelope(text);
    safeAreaOf(zeroArea).safePolygon = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];
    assert.equal(parseAreaBundleRestore(JSON.stringify(zeroArea), SHA).ok, false);
    const numericString = mutableEnvelope(text);
    safeAreaOf(numericString).safePolygon = [
      { x: "0", y: "0" }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ];
    assert.equal(parseAreaBundleRestore(JSON.stringify(numericString), SHA).ok, false);
    const nonFinite = mutableEnvelope(text);
    safeAreaOf(nonFinite).safePolygon = [
      { x: 1e400, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ];
    assert.doesNotThrow(() => {
      assert.equal(parseAreaBundleRestore(JSON.stringify(nonFinite), SHA).ok, false);
    });
  });

  it("rejects duplicate exclusion ids", () => {
    const { text } = twoRegionBundle();
    const m = mutableEnvelope(text);
    const area = safeAreaOf(m);
    const firstExclusion = area.exclusions[0];
    if (firstExclusion === undefined) throw new Error("fixture must have an exclusion");
    area.exclusions.push({ ...firstExclusion });
    assert.equal(parseAreaBundleRestore(JSON.stringify(m), SHA).ok, false);
  });

  it("rejects missing, extra, duplicate, and ghost areas", () => {
    const { text } = twoRegionBundle();
    const missing = mutableEnvelope(text);
    missing.areas.pop();
    assert.equal(parseAreaBundleRestore(JSON.stringify(missing), SHA).ok, false);

    const extra = mutableEnvelope(text);
    const extraFirst = firstAreaOf(extra);
    extra.areas.push({ ...extraFirst, regionId: "ghost" });
    assert.equal(parseAreaBundleRestore(JSON.stringify(extra), SHA).ok, false);

    const ghostSwap = mutableEnvelope(text);
    firstAreaOf(ghostSwap).regionId = "ghost";
    assert.equal(parseAreaBundleRestore(JSON.stringify(ghostSwap), SHA).ok, false);

    const duplicate = mutableEnvelope(text);
    const dupA = firstAreaOf(duplicate);
    const dupB = duplicate.areas[1];
    if (dupB === undefined) throw new Error("fixture must have two areas");
    dupB.regionId = dupA.regionId;
    dupB.frameId = dupA.frameId;
    dupB.frameSnapshot = dupA.frameSnapshot;
    assert.equal(parseAreaBundleRestore(JSON.stringify(duplicate), SHA).ok, false);
  });

  it("rejects duplicate region and frame ids", () => {
    const { text } = twoRegionBundle();
    const dupRegion = mutableEnvelope(text);
    const dupRegionFirst = firstRegionOf(dupRegion);
    dupRegion.regions.push({ ...dupRegionFirst, frameId: "another-frame" });
    dupRegion.areas.push({ ...firstAreaOf(dupRegion) });
    assert.equal(parseAreaBundleRestore(JSON.stringify(dupRegion), SHA).ok, false);

    const dupFrame = mutableEnvelope(text);
    const dupFrameFirst = firstRegionOf(dupFrame);
    dupFrame.regions.push({ ...dupFrameFirst, regionId: "another-region" });
    dupFrame.areas.push({ ...firstAreaOf(dupFrame), regionId: "another-region" });
    assert.equal(parseAreaBundleRestore(JSON.stringify(dupFrame), SHA).ok, false);
  });

  it("fails over-limit inputs without partial state", () => {
    const { text } = twoRegionBundle();
    const tooMany = mutableEnvelope(text);
    tooMany.regions = [];
    tooMany.areas = [];
    for (let i = 0; i < 129; i++) {
      tooMany.regions.push({
        regionId: `r-${i}`,
        frameId: `f-${i}`,
        origin: { x: 0, y: 0, z: 0 },
        originAnchorId: "O",
      });
      tooMany.areas.push({
        regionId: `r-${i}`,
        frameId: `f-${i}`,
        frameSnapshot: "x",
        safePolygon: null,
        exclusions: [],
      });
    }
    const overRegions = parseAreaBundleRestore(JSON.stringify(tooMany), SHA);
    assert.equal(overRegions.ok, false);
    if (!overRegions.ok) assert.match(overRegions.error, /too many regions/);

    const tooLong = mutableEnvelope(text);
    safeAreaOf(tooLong).safePolygon = ring(513);
    assert.equal(parseAreaBundleRestore(JSON.stringify(tooLong), SHA).ok, false);

    const tooManyExclusions = mutableEnvelope(text);
    const crowded = safeAreaOf(tooManyExclusions);
    crowded.exclusions = Array.from({ length: 65 }, (_, i) => ({
      id: `ex-${i}`,
      name: `Exclusion ${i}`,
      polygon: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }],
    }));
    assert.equal(parseAreaBundleRestore(JSON.stringify(tooManyExclusions), SHA).ok, false);

    const heavy = mutableEnvelope(text);
    for (const area of heavy.areas) {
      area.safePolygon = ring(512);
      area.exclusions = Array.from({ length: 64 }, (_, i) => ({
        id: `hex-${area.regionId}-${i}`,
        name: `Heavy ${i}`,
        polygon: ring(512),
      }));
    }
    const overTotal = parseAreaBundleRestore(JSON.stringify(heavy), SHA);
    assert.equal(overTotal.ok, false);
    if (!overTotal.ok) assert.match(overTotal.error, /total polygon vertices/);

    const oversize = "x".repeat(AREA_RESTORE_LIMITS.maxChars + 1);
    const overText = parseAreaBundleRestore(oversize, SHA);
    assert.equal(overText.ok, false);
    if (!overText.ok) {
      assert.equal(overText.error, `area restore: file exceeds ${AREA_RESTORE_LIMITS.maxChars} characters`);
    }
    // No partial state: a valid file still restores afterwards.
    assert.ok(parseAreaBundleRestore(text, SHA).ok);
  });

  it("never throws on hostile envelope shapes", () => {
    const hostile = ["", "   \n  ", "[1,2]", '"123"', "123", "null", "{oops", "[{\"a\":1}]", "undefined"];
    for (const bad of hostile) {
      assert.doesNotThrow(() => {
        assert.equal(parseAreaBundleRestore(bad, SHA).ok, false);
      });
    }
    assert.doesNotThrow(() => {
      assert.equal(parseAreaBundleRestore(123 as unknown as string, SHA).ok, false);
    });
    assert.doesNotThrow(() => {
      const m = mutableEnvelope(twoRegionBundle().text);
      firstAreaOf(m).safePolygon = [{ x: 1e999, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 1, y: 2 }];
      assert.equal(parseAreaBundleRestore(JSON.stringify(m), SHA).ok, false);
    });
  });

  it("roundtrips __proto__ region ids safely and rejects duplicates", () => {
    const ev = evidence();
    const fit = fitUniformScale(ev);
    const snap = snapshotEvidence(ev);
    const made = createPlanarRegion(
      {
        regionId: "__proto__", frameId: "proto-frame",
        originAnchorId: "O", xAnchorId: "X", yAnchorId: "Y", offPlaneToleranceMm: 0.01,
      },
      anchors(),
      ev,
      snap,
    );
    assert.ok(made.ok);
    let areas: AreasMap = {};
    const safe = setSafePolygon(areas, made.region, "[[0,0],[100,0],[100,100],[0,100]]");
    assert.ok(safe.ok);
    areas = safe.areas;
    const built = buildAreaBundle(ev, fit, [made.region], areas, snap);
    assert.ok(built.ok);
    const text = serializeAreaBundle(built.bundle);
    const parsed = parseAreaBundleRestore(text, SHA);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(Object.getPrototypeOf(parsed.areas), null);
    assert.ok(Object.hasOwn(parsed.areas, "__proto__"));
    const protoArea = parsed.areas["__proto__"];
    if (protoArea === undefined) throw new Error("restored __proto__ area is missing");
    assert.deepStrictEqual(protoArea.safePolygon, [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ]);
    assert.equal(serializeAreaBundle(parsed.bundle), text);

    const dup = mutableEnvelope(text);
    const dupFirstRegion = firstRegionOf(dup);
    dup.regions.push({ ...dupFirstRegion, frameId: "proto-frame-2" });
    dup.areas.push({ ...firstAreaOf(dup) });
    assert.equal(parseAreaBundleRestore(JSON.stringify(dup), SHA).ok, false);
  });
});
