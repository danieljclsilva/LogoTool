import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitUniformScale, type CalibrationEvidence } from "../src/core/calibration/index.js";
import { buildEvidence, snapshotEvidence, stableStringify } from "../src/core/calibration-session/index.js";
import {
  createPlanarRegion,
  type PlanarRegionAnchor,
  type PlanarRegionInput,
  type PlanarRegionRecord,
} from "../src/core/planar-region/index.js";
import {
  AREA_BUNDLE_VERSION,
  AREA_LIMITS,
  addExclusion,
  buildAreaBundle,
  checkFootprint,
  clearSafePolygon,
  parsePolygonText,
  pruneAreas,
  removeExclusion,
  serializeAreaBundle,
  setSafePolygon,
  validateAreaRecord,
  type AddExclusionResult,
  type AreasMap,
  type SetSafePolygonResult,
} from "../src/core/region-areas/index.js";

const input: PlanarRegionInput = { regionId: "front", frameId: "front-mm", originAnchorId: "O", xAnchorId: "X", yAnchorId: "Y", offPlaneToleranceMm: 0.01 };
const anchors = (): PlanarRegionAnchor[] => [
  { id: "O", model: { x: 0, y: 0, z: 0 } }, { id: "X", model: { x: 10, y: 0, z: 0 } }, { id: "Y", model: { x: 3, y: 5, z: 0 } },
];
function evidence(points = anchors(), overrides: Partial<CalibrationEvidence> = {}): CalibrationEvidence {
  const built = buildEvidence({ product: "synthetic-tee", variant: "M", calibrationId: "cal-1", frameId: "asset-root", provisionalVersion: "draft-1",
    assetFullSha256: "ab".repeat(32), toleranceMm: 0.5, relativeTolerance: 0.01 }, points, [{ a: "O", b: "X", distanceMm: 100 }]);
  assert.ok(built.ok); return { ...built.evidence, ...overrides };
}
function makeRegion(spec: PlanarRegionInput = input): PlanarRegionRecord {
  const ev = evidence();
  const made = createPlanarRegion(spec, anchors(), ev, snapshotEvidence(ev));
  assert.ok(made.ok); return made.region;
}
function makeContext() {
  const ev = evidence();
  const r1 = makeRegion();
  const backMade = createPlanarRegion({ ...input, regionId: "back", frameId: "back-mm", originAnchorId: "X", xAnchorId: "O" }, anchors(), ev, snapshotEvidence(ev));
  assert.ok(backMade.ok);
  const r2 = backMade.region;
  const fit = fitUniformScale(ev);
  const snap = snapshotEvidence(ev);
  return { ev, fit, snap, r1, r2 };
}
const SAFE = "[[0,0],[100,0],[100,100],[0,100]]";
function requireAreas(out: SetSafePolygonResult): AreasMap {
  if (!out.ok) throw new Error(out.error);
  return out.areas;
}
function requireAdded(out: AddExclusionResult): AreasMap {
  if (!out.ok) throw new Error(out.error);
  return out.areas;
}
function setSafe(areas: AreasMap, region: PlanarRegionRecord, text = SAFE): AreasMap {
  return requireAreas(setSafePolygon(areas, region, text));
}

describe("parsePolygonText", () => {
  it("accepts both JSON shapes", () => {
    const a = parsePolygonText(SAFE);
    const b = parsePolygonText('[{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":100},{"x":0,"y":100}]');
    assert.ok(a.ok && b.ok);
    assert.deepEqual(a.polygon, b.polygon);
  });
  it("rejects invalid text, numeric strings, nonfinite, limits", () => {
    assert.equal(parsePolygonText("nope").ok, false);
    assert.equal(parsePolygonText("{}").ok, false);
    assert.equal(parsePolygonText("[[0,0],[1,1]]").ok, false);
    assert.equal(parsePolygonText('[["0","0"],["100","0"],["100","100"],["0","100"]]').ok, false);
    assert.equal(parsePolygonText('[[0,0],[null,0],[100,100],[0,100]]').ok, false);
    assert.equal(parsePolygonText('[[0,0],[1e999,0],[100,100],[0,100]]').ok, false);
    assert.equal(parsePolygonText("x".repeat(AREA_LIMITS.MAX_TEXT_LENGTH + 1)).ok, false);
    const big = `[${Array.from({ length: AREA_LIMITS.MAX_VERTICES + 1 }, (_, i) => `[${i},${(i * 7919) % 1000}]`).join(",")}]`;
    assert.equal(parsePolygonText(big).ok, false);
  });
  it("rejects self-crossing, duplicate, zero-area rings", () => {
    assert.equal(parsePolygonText("[[0,0],[100,100],[100,0],[0,100]]").ok, false);
    assert.equal(parsePolygonText("[[0,0],[50,50],[100,0],[50,50],[100,100],[0,100]]").ok, false);
    assert.equal(parsePolygonText("[[0,0],[50,0],[100,0]]").ok, false);
  });
  it("normalizes repeated closure, preserves precision and winding", () => {
    const cw = parsePolygonText("[[0,0],[0,100],[100,100],[100,0]]");
    const closed = parsePolygonText("[[0,0],[100,0],[100,100],[0,100],[0,0]]");
    assert.ok(cw.ok && closed.ok);
    if (cw.ok && closed.ok) {
      assert.deepEqual(cw.polygon, [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }]);
      assert.deepEqual(closed.polygon, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
    }
    const precise = parsePolygonText("[[0.1,0.2],[100.123456789,0.2],[100.123456789,100.987654321],[0.1,100.987654321]]");
    assert.ok(precise.ok);
    if (precise.ok) assert.equal(precise.polygon[1]!.x, 100.123456789);
  });
});

describe("safe polygon and exclusions", () => {
  it("sets/clears safely with no partial replace on failure", () => {
    const r = makeRegion();
    let areas: AreasMap = {};
    areas = setSafe(areas, r);
    const before = JSON.stringify(areas);
    const bad = setSafePolygon(areas, r, "garbage");
    assert.equal(bad.ok, false);
    assert.equal(JSON.stringify(bad.areas), before);
    assert.equal(JSON.stringify(areas), before);
    areas = clearSafePolygon(areas, r).areas;
    assert.equal(areas[r.regionId]!.safePolygon, null);
    assert.deepEqual(areas[r.regionId]!.exclusions, []);
  });
  it("adds/removes exclusions, validates individually, isolates regions", () => {
    const { r1, r2 } = makeContext();
    let areas: AreasMap = {};
    areas = setSafe(areas, r1);
    areas = setSafe(areas, r2);
    const added = addExclusion(areas, r1, "hole", "Button hole", "[[10,10],[20,10],[20,20],[10,20]]");
    assert.ok(added.ok);
    areas = added.areas;
    assert.equal(areas[r2.regionId]!.exclusions.length, 0);
    assert.equal(addExclusion(areas, r1, "hole", "Dup", "[[30,30],[40,30],[40,40],[30,40]]").ok, false);
    assert.equal(addExclusion(areas, r1, "bad", "Bad", "nope").ok, false);
    assert.equal(addExclusion(areas, r1, "", "Empty id", "[[30,30],[40,30],[40,40],[30,40]]").ok, false);
    assert.equal(addExclusion(areas, r1, "n", "", "[[30,30],[40,30],[40,40],[30,40]]").ok, false);
    assert.equal(addExclusion(areas, r1, "self", "Self-crossing", "[[0,0],[10,10],[10,0],[0,10]]").ok, false);
    // Overlapping + outside-safe exclusions retained (union-obstacle semantics).
    const overlap = addExclusion(areas, r1, "big", "Overlapping", "[[-50,-50],[200,-50],[200,200],[-50,200]]");
    assert.ok(overlap.ok);
    areas = overlap.areas;
    assert.equal(areas[r1.regionId]!.exclusions.length, 2);
    assert.equal(removeExclusion(areas, r1, "missing").ok, false);
    const removed = removeExclusion(areas, r1, "big");
    assert.ok(removed.ok);
    assert.equal(removed.areas[r1.regionId]!.exclusions.length, 1);
  });
  it("prunes stale records with no inheritance on same-id recreate", () => {
    const r = makeRegion();
    let areas: AreasMap = setSafe({}, r);
    const pruned = pruneAreas([], areas);
    assert.deepEqual(Object.keys(pruned), []);
    // Caller removes first; recreated region starts clean.
    const repruned = pruneAreas([r], pruned);
    assert.deepEqual(Object.keys(repruned), []);
    const kept = pruneAreas([r], areas);
    assert.ok(kept[r.regionId]);
    assert.notEqual(kept, areas);
  });
});

describe("checkFootprint", () => {
  it("handles missing configuration without throwing", () => {
    const missing = checkFootprint(null, SAFE);
    assert.equal(missing.ok, true);
    if (missing.ok) assert.equal(missing.fits, false);
    const r = makeRegion();
    const empty = checkFootprint({ regionId: r.regionId, frameId: r.frameId, frameSnapshot: "s", safePolygon: null, exclusions: [] }, SAFE);
    assert.equal(empty.ok, true);
    if (empty.ok) assert.equal(empty.fits, false);
    const areas = setSafe({}, r);
    const badText = checkFootprint(areas[r.regionId]!, "nope");
    assert.equal(badText.ok, false);
  });
  it("allows safe-boundary contact but escapes concave gaps", () => {
    const r = makeRegion();
    const areas = setSafe({}, r, "[[-10,0],[10,0],[10,10],[2,10],[2,4],[-2,4],[-2,10],[-10,10]]");
    const area = areas[r.regionId]!;
    const onEdge = checkFootprint(area, "[[0,0],[10,0],[10,2],[0,2]]");
    assert.equal(onEdge.ok, true);
    if (onEdge.ok) assert.equal(onEdge.fits, true);
    // Vertices all inside/on the C arms, but the bar spans the notch gap.
    const spanning = checkFootprint(area, "[[-10,5],[10,5],[10,7],[-10,7]]");
    assert.equal(spanning.ok, true);
    if (spanning.ok) assert.equal(spanning.fits, false);
    const outside = checkFootprint(area, "[[50,50],[60,50],[60,60],[50,60]]");
    assert.equal(outside.ok, true);
    if (outside.ok) assert.equal(outside.fits, false);
  });
  it("rejects exclusion touch, crossing and enclosure", () => {
    const r = makeRegion();
    let areas = setSafe({}, r);
    areas = requireAdded(addExclusion(areas, r, "hole", "Hole", "[[40,40],[60,40],[60,60],[40,60]]"));
    const area = () => areas[r.regionId]!;
    const touch = checkFootprint(area(), "[[0,0],[40,0],[40,40],[0,40]]");
    assert.equal(touch.ok, true);
    if (touch.ok) assert.equal(touch.fits, false);
    const cross = checkFootprint(area(), "[[0,50],[100,50],[100,55],[0,55]]");
    assert.equal(cross.ok, true);
    if (cross.ok) assert.equal(cross.fits, false);
    const enclose = checkFootprint(area(), "[[0,0],[100,0],[100,100],[0,100]]");
    assert.equal(enclose.ok, true);
    if (enclose.ok) assert.equal(enclose.fits, false);
    const clear = checkFootprint(area(), "[[0,0],[30,0],[30,30],[0,30]]");
    assert.equal(clear.ok, true);
    if (clear.ok) assert.equal(clear.fits, true);
  });
});

describe("area bundle", () => {
  it("builds deterministically with sorted records and draft-only flags", () => {
    const { ev, fit, snap, r1, r2 } = makeContext();
    let areas: AreasMap = {};
    areas = setSafe(areas, r2, "[[0,0],[50,0],[50,50],[0,50]]");
    areas = setSafe(areas, r1);
    const added = addExclusion(areas, r2, "b-hole", "B hole", "[[5,5],[10,5],[10,10],[5,10]]");
    assert.ok(added.ok);
    areas = added.areas;
    const first = buildAreaBundle(ev, fit, [r1, r2], areas, snap);
    const second = buildAreaBundle(ev, fit, [r2, r1], areas, snap);
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok) {
      assert.equal(serializeAreaBundle(first.bundle), serializeAreaBundle(second.bundle));
      assert.deepEqual(first.bundle.areas.map((a) => a.regionId), ["back", "front"]);
      assert.equal(first.bundle.schemaVersion, AREA_BUNDLE_VERSION);
      assert.equal(first.bundle.pendingReview, true);
      assert.equal(first.bundle.productionApproved, false);
      assert.ok(!("timestamp" in first.bundle) && !JSON.stringify(first.bundle).includes("timestamp"));
      const parsed = JSON.parse(serializeAreaBundle(first.bundle));
      assert.equal(parsed.schemaVersion, AREA_BUNDLE_VERSION);
    }
  });
  it("allows null safe polygons as draft-only placeholders", () => {
    const { ev, fit, snap, r1 } = makeContext();
    const areas: AreasMap = {
      [r1.regionId]: { regionId: r1.regionId, frameId: r1.frameId, frameSnapshot: stableStringify(r1), safePolygon: null, exclusions: [] },
    };
    const built = buildAreaBundle(ev, fit, [r1], areas, snap);
    assert.ok(built.ok);
  });
  it("rejects stale frame snapshots, missing and duplicate regions", () => {
    const { ev, fit, snap, r1 } = makeContext();
    const areas = setSafe({}, r1);
    const stale = { ...areas[r1.regionId]!, frameSnapshot: "old" };
    assert.equal(buildAreaBundle(ev, fit, [r1], { [r1.regionId]: stale }, snap).ok, false);
    assert.equal(buildAreaBundle(ev, fit, [], areas, snap).ok, false);
    const dup: AreasMap = { a: areas[r1.regionId]!, b: areas[r1.regionId]! };
    void dup;
    const dupRegions = buildAreaBundle(ev, fit, [r1, r1], areas, snap);
    assert.equal(dupRegions.ok, false);
    const tampered = { ...r1, origin: { x: 999, y: 0, z: 0 } };
    assert.equal(buildAreaBundle(ev, fit, [tampered], areas, snap).ok, false);
  });
  it("distrusts forged fits and approvals, rejects inconsistent snapshots", () => {
    const { ev, fit, snap, r1 } = makeContext();
    const areas = setSafe({}, r1);
    for (const supplied of [{ ...fit, scaleMmPerUnit: 42 }, { ...fit, assetFullSha256: "ff".repeat(32) }, { ...fit, inconsistent: true }]) {
      assert.equal(buildAreaBundle(ev, supplied, [r1], areas, snap).ok, false);
    }
    assert.equal(buildAreaBundle(ev, fit, [r1], areas, "forged").ok, false);
    const bad = evidence(anchors(), { extraMeasurements: [{ pairIds: ["O", "X"], distanceMm: 1000 }] });
    assert.equal(buildAreaBundle(bad, fitUniformScale(bad), [], {}, snapshotEvidence(bad)).ok, false);
    // Forged approval flags in the input map cannot leak: output always draft-only.
    const built = buildAreaBundle(ev, fit, [r1], areas, snap);
    assert.ok(built.ok);
    if (built.ok) {
      assert.equal(built.bundle.pendingReview, true);
      assert.equal(built.bundle.productionApproved, false);
    }
  });
  it("rejects duplicate exclusion ids and invalid polygons at build", () => {
    const { ev, fit, snap, r1 } = makeContext();
    let areas = setSafe({}, r1);
    areas = requireAdded(addExclusion(areas, r1, "a", "A", "[[10,10],[20,10],[20,20],[10,20]]"));
    const dup = { ...areas[r1.regionId]!, exclusions: [areas[r1.regionId]!.exclusions[0]!, areas[r1.regionId]!.exclusions[0]!] };
    assert.equal(buildAreaBundle(ev, fit, [r1], { [r1.regionId]: dup }, snap).ok, false);
    const badPoly = { ...areas[r1.regionId]!, safePolygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    assert.equal(buildAreaBundle(ev, fit, [r1], { [r1.regionId]: badPoly }, snap).ok, false);
  });
  it("keeps inputs immutable and never partially replaces", () => {
    const { ev, fit, snap, r1, r2 } = makeContext();
    let areas: AreasMap = setSafe({}, r1);
    const before = JSON.stringify({ areas, r1, ev });
    const built = buildAreaBundle(ev, fit, [r1, r2], areas, snap);
    assert.ok(built.ok);
    assert.equal(JSON.stringify({ areas, r1, ev }), before);
    if (built.ok) {
      built.bundle.areas[0]!.regionId = "forged";
      built.bundle.regions[0]!.origin.x = 888;
      assert.equal(JSON.stringify({ areas, r1, ev }), before);
    }
    assert.equal(validateAreaRecord(areas[r1.regionId]).ok, true);
    assert.equal(validateAreaRecord(null).ok, false);
  });
});

describe("area binding regressions", () => {
  it("supports region IDs that collide with object prototype names", () => {
    for (const id of ["__proto__", "constructor", "toString"]) {
      const r = makeRegion({ ...input, regionId: id });
      let areas = setSafe({}, r);
      areas = requireAdded(addExclusion(areas, r, "pocket", "Synthetic pocket", "[[10,10],[20,10],[20,20],[10,20]]"));
      assert.ok(Object.hasOwn(areas, id));
      assert.equal(areas[id]!.exclusions.length, 1);
      assert.equal(checkFootprint(areas[id]!, "[[1,1],[2,1],[2,2],[1,2]]").ok, true);
      const ev = evidence();
      assert.ok(buildAreaBundle(ev, fitUniformScale(ev), [r], areas, snapshotEvidence(ev)).ok);
    }
  });
  it("rejects edits against stale bindings rather than reattaching old polygons", () => {
    const r = makeRegion(), areas = setSafe({}, r);
    const changed = { ...r, frameId: "new-frame" };
    assert.equal(setSafePolygon(areas, changed, SAFE).ok, false);
    assert.equal(addExclusion(areas, changed, "p", "Pocket", SAFE).ok, false);
    assert.equal(clearSafePolygon(areas, changed).areas[r.regionId]!.safePolygon, null);
    assert.deepEqual(pruneAreas([changed], areas), Object.create(null));
  });
  it("rejects mismatched record IDs and duplicate area-map aliases at export", () => {
    const { ev, fit, snap, r1 } = makeContext();
    const areas = setSafe({}, r1), record = areas.front!;
    assert.equal(buildAreaBundle(ev, fit, [r1], {front: {...record, frameId:"forged"}}, snap).ok, false);
    assert.equal(buildAreaBundle(ev, fit, [r1], {front:record, alias:record}, snap).ok, false);
  });
  it("makes unconfigured frames explicit null-safe placeholders", () => {
    const { ev, fit, snap, r1, r2 } = makeContext();
    const built = buildAreaBundle(ev, fit, [r1,r2], setSafe({}, r1), snap);
    assert.ok(built.ok);
    assert.deepEqual(built.bundle.areas.map(r=>r.regionId), ["back","front"]);
    assert.equal(built.bundle.areas[0]!.safePolygon, null);
    assert.equal(built.bundle.areas[0]!.frameId, r2.frameId);
  });
  it("rejects whitespace IDs and names without mutating the saved area", () => {
    const r = makeRegion(), areas = setSafe({}, r), before = JSON.stringify(areas);
    assert.equal(addExclusion(areas, r, " ", "Pocket", SAFE).ok, false);
    assert.equal(addExclusion(areas, r, "p", " ", SAFE).ok, false);
    assert.equal(JSON.stringify(areas), before);
  });
  it("enforces vertex limits for exported arrays including optional closure", () => {
    const r = makeRegion();
    const ring = Array.from({length: AREA_LIMITS.MAX_VERTICES+1}, (_,i)=>({x:i,y:i%2}));
    const record = {regionId:r.regionId, frameId:r.frameId, frameSnapshot:stableStringify(r), safePolygon:ring, exclusions:[]};
    assert.equal(validateAreaRecord(record).ok, false);
    ring[ring.length-1] = {...ring[0]!};
    assert.equal(validateAreaRecord(record).ok, true);
  });
});
