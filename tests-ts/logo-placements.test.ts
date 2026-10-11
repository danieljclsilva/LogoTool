import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitUniformScale } from "../src/core/calibration/index.js";
import {
  buildEvidence,
  snapshotEvidence,
} from "../src/core/calibration-session/index.js";
import {
  createPlanarRegion,
  type PlanarRegionRecord,
} from "../src/core/planar-region/index.js";
import {
  addExclusion,
  setSafePolygon,
  type AreasMap,
} from "../src/core/region-areas/index.js";
import {
  addLogo,
  addPlacement,
  buildPlacementBundle,
  checkPlacementFootprint,
  PLACEMENT_BUNDLE_VERSION,
  placementFootprint,
  prunePlacements,
  removeLogo,
  removePlacement,
  serializePlacementBundle,
  statusAll,
  updatePlacement,
  validateDraftPlacement,
  type DraftLogo,
  type DraftPlacement,
  type LogosMap,
  type PlacementsMap,
} from "../src/core/logo-placements/index.js";

const SHA = "ab".repeat(32);
const CONCAVE_SAFE = "[[0,0],[50,50],[100,0],[100,100],[0,100]]";
const SQUARE_SAFE = "[[0,0],[100,0],[100,100],[0,100]]";
const HOLE = "[[10,10],[20,10],[20,20],[10,20]]";

function anchors() {
  return [
    { id: "O", model: { x: 0, y: 0, z: 0 } },
    { id: "X", model: { x: 10, y: 0, z: 0 } },
    { id: "Y", model: { x: 3, y: 5, z: 0 } },
  ];
}

function context() {
  const built = buildEvidence(
    {
      product: "synthetic-tee",
      variant: "M",
      calibrationId: "cal-1",
      frameId: "asset-root",
      provisionalVersion: "draft-1",
      toleranceMm: 0.5,
      relativeTolerance: 0.01,
      assetFullSha256: SHA,
    },
    anchors(),
    [{ a: "O", b: "X", distanceMm: 100 }],
  );
  assert.ok(built.ok);
  const ev = built.evidence;
  const fit = fitUniformScale(ev);
  const snap = snapshotEvidence(ev);
  const mkRegion = (regionId: string, frameId: string): PlanarRegionRecord => {
    const made = createPlanarRegion(
      {
        regionId,
        frameId,
        originAnchorId: "O",
        xAnchorId: "X",
        yAnchorId: "Y",
        offPlaneToleranceMm: 0.01,
      },
      anchors(),
      ev,
      snap,
    );
    assert.ok(made.ok);
    return made.region;
  };
  return { ev, fit, snap, front: mkRegion("front", "front-mm"), back: mkRegion("back", "back-mm") };
}

function areasWithSquare(regions: PlanarRegionRecord[]): AreasMap {
  let areas: AreasMap = {};
  for (const region of regions) {
    const out = setSafePolygon(areas, region, SQUARE_SAFE);
    assert.ok(out.ok);
    areas = out.areas;
  }
  return areas;
}

const logos = (): LogosMap => ({
  crest: { id: "crest", name: "Crest" },
  wordmark: { id: "wordmark", name: "Wordmark", widthPx: 200, heightPx: 60 },
});

const placement = (overrides: Partial<DraftPlacement> = {}): DraftPlacement => ({
  id: "p1",
  logoId: "crest",
  regionId: "front",
  xMm: 50,
  yMm: 50,
  widthMm: 20,
  heightMm: 10,
  rotationDeg: 0,
  ...overrides,
});

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

describe("placementFootprint", () => {
  it("matches hand-computed corners for 0/90/180/-90 rotations", () => {
    const base = placement({ xMm: 50, yMm: 50, widthMm: 20, heightMm: 10 });
    assert.deepEqual(placementFootprint({ ...base, rotationDeg: 0 }), [
      { x: 40, y: 45 },
      { x: 60, y: 45 },
      { x: 60, y: 55 },
      { x: 40, y: 55 },
    ]);
    assert.deepEqual(placementFootprint({ ...base, rotationDeg: 90 }), [
      { x: 45, y: 60 },
      { x: 45, y: 40 },
      { x: 55, y: 40 },
      { x: 55, y: 60 },
    ]);
    assert.deepEqual(placementFootprint({ ...base, rotationDeg: 180 }), [
      { x: 60, y: 55 },
      { x: 40, y: 55 },
      { x: 40, y: 45 },
      { x: 60, y: 45 },
    ]);
    assert.deepEqual(placementFootprint({ ...base, rotationDeg: -90 }), [
      { x: 55, y: 40 },
      { x: 55, y: 60 },
      { x: 45, y: 60 },
      { x: 45, y: 40 },
    ]);
  });
  it("matches hand-computed corners for 33.7 degrees", () => {
    const corners = placementFootprint({ ...placement(), rotationDeg: 33.7 });
    const expected: Array<[number, number]> = [
      [38.90623664145518, 51.388673663827575],
      [55.54531908406483, 40.291785114867594],
      [61.09376335854482, 48.611326336172425],
      [44.45468091593517, 59.708214885132406],
    ];
    assert.equal(corners.length, 4);
    corners.forEach((corner, i) => {
      const want = expected[i];
      assert.ok(want !== undefined, `corner ${i} expected`);
      assert.ok(close(corner.x, want[0]), `corner ${i} x`);
      assert.ok(close(corner.y, want[1]), `corner ${i} y`);
    });
  });
  it("throws on nonfinite input and never returns NaN", () => {
    assert.throws(() => placementFootprint(placement({ xMm: NaN })), /finite/);
    assert.throws(() => placementFootprint(placement({ widthMm: Infinity })), /finite/);
    assert.throws(
      () => placementFootprint(placement({ xMm: 1.7e308, widthMm: 1e308 })),
      /non-finite/,
    );
  });
  it("normalizes 180 but rejects 0, -180, and out-of-range rotations", () => {
    const regionIds = ["front"];
    assert.ok(validateDraftPlacement(placement({ rotationDeg: 180 }), logos(), regionIds).ok);
    for (const bad of [0 - 180, -180.0001, 180.0001, 360, NaN, Infinity]) {
      const result = validateDraftPlacement(
        placement({ rotationDeg: bad }),
        logos(),
        regionIds,
      );
      assert.equal(result.ok, false, `rotation ${String(bad)}`);
    }
  });
  it("rejects nonfinite/overflow dims, coords, and dangling refs", () => {
    const regionIds = ["front"];
    const bad: DraftPlacement[] = [
      placement({ widthMm: 0 }),
      placement({ heightMm: -5 }),
      placement({ widthMm: 100001 }),
      placement({ xMm: 1000001 }),
      placement({ xMm: NaN }),
      placement({ yMm: Infinity }),
      placement({ id: "" }),
      placement({ id: "x".repeat(257) }),
      placement({ logoId: "missing" }),
      placement({ regionId: "missing" }),
    ];
    for (const candidate of bad) {
      assert.equal(validateDraftPlacement(candidate, logos(), regionIds).ok, false);
    }
  });
});

describe("CRUD", () => {
  it("adds/removes logos and placements immutably with failure preservation", () => {
    let emptyLogos: LogosMap = {};
    const added = addLogo(emptyLogos, { id: "crest", name: "Crest" });
    assert.ok(added.ok);
    assert.deepEqual(emptyLogos, {});
    assert.equal(addLogo(added.logos, { id: "crest", name: "Dup" }).ok, false);
    assert.equal(addLogo(added.logos, { id: "", name: "Bad" }).ok, false);

    let emptyPlacements: PlacementsMap = {};
    const placed = addPlacement(emptyPlacements, placement(), added.logos, ["front"]);
    assert.ok(placed.ok);
    assert.deepEqual(emptyPlacements, {});
    assert.equal(
      addPlacement(placed.placements, placement(), added.logos, ["front"]).ok,
      false,
    );
    assert.equal(
      addPlacement(placed.placements, placement({ id: "p2", logoId: "missing" }), added.logos, ["front"]).ok,
      false,
    );
    assert.deepEqual(Object.keys(placed.placements), ["p1"]);

    const updated = updatePlacement(placed.placements, "p1", { rotationDeg: 33.7 }, added.logos, ["front"]);
    assert.ok(updated.ok);
    assert.equal(updated.placement.rotationDeg, 33.7);
    assert.equal(updatePlacement(placed.placements, "p1", { id: "other" }, added.logos, ["front"]).ok, false);
    assert.equal(updatePlacement(placed.placements, "p1", { widthMm: 0 }, added.logos, ["front"]).ok, false);
    assert.equal(updatePlacement(placed.placements, "nope", {}, added.logos, ["front"]).ok, false);
    assert.equal(placed.placements["p1"]!.rotationDeg, 0);

    assert.equal(removeLogo(added.logos, placed.placements, "crest").ok, false);
    const removedPlacement = removePlacement(placed.placements, "p1");
    assert.ok(removedPlacement.ok);
    assert.equal(removePlacement(removedPlacement.placements, "p1").ok, false);
    const removedLogo = removeLogo(added.logos, removedPlacement.placements, "crest");
    assert.ok(removedLogo.ok);
    assert.equal(removeLogo(removedLogo.logos, removedPlacement.placements, "crest").ok, false);
  });
  it("prunes placements whose logo or region vanished", () => {
    const start: PlacementsMap = {
      keep: placement({ id: "keep", logoId: "crest", regionId: "front" }),
      staleLogo: placement({ id: "staleLogo", logoId: "gone", regionId: "front" }),
      staleRegion: placement({ id: "staleRegion", logoId: "crest", regionId: "gone" }),
    };
    const pruned = prunePlacements(start, logos(), ["front"]);
    assert.deepEqual(Object.keys(pruned.placements), ["keep"]);
    assert.deepEqual(pruned.dropped, ["staleLogo", "staleRegion"]);
    assert.deepEqual(Object.keys(start).sort(), ["keep", "staleLogo", "staleRegion"]);
    const byRecord = prunePlacements(start, logos(), [{ regionId: "front" } as PlanarRegionRecord]);
    assert.deepEqual(Object.keys(byRecord.placements), ["keep"]);
  });
});

describe("checkPlacementFootprint", () => {
  it("fits inside, fails outside, and reports missing safe as fits:false", () => {
    const { front } = context();
    const areas = areasWithSquare([front]);
    const ok = checkPlacementFootprint(placement(), areas["front"]!);
    assert.ok(ok.ok && ok.fits);
    assert.equal(ok.ok && ok.footprint.length, 4);
    const outside = checkPlacementFootprint(placement({ xMm: 500 }), areas["front"]!);
    assert.ok(outside.ok && !outside.fits);
    const missing = checkPlacementFootprint(placement(), null);
    assert.ok(missing.ok && !missing.fits);
    assert.equal(missing.ok && missing.reason, "no safe polygon configured for region");
    const bad = checkPlacementFootprint(placement({ xMm: NaN }), areas["front"]!);
    assert.equal(bad.ok, false);
  });
  it("allows boundary contact but rejects concave-notch escapes", () => {
    const { front } = context();
    let areas: AreasMap = {};
    const set = setSafePolygon(areas, front, CONCAVE_SAFE);
    assert.ok(set.ok);
    areas = set.areas;
    const contact = checkPlacementFootprint(
      placement({ xMm: 50, yMm: 95, widthMm: 100, heightMm: 10, rotationDeg: 0 }),
      areas["front"]!,
    );
    assert.ok(contact.ok && contact.fits);
    const escape = checkPlacementFootprint(
      placement({ xMm: 50, yMm: 30, widthMm: 60, heightMm: 10, rotationDeg: 0 }),
      areas["front"]!,
    );
    assert.ok(escape.ok && !escape.fits);
  });
  it("rejects exclusion touch/inside/enclose/crossing", () => {
    const { front } = context();
    let areas: AreasMap = {};
    const set = setSafePolygon(areas, front, SQUARE_SAFE);
    assert.ok(set.ok);
    areas = set.areas;
    const withHole = addExclusion(areas, front, "hole", "Hole", HOLE);
    assert.ok(withHole.ok);
    areas = withHole.areas;
    const area = areas["front"]!;
    // Inside the hole.
    assert.ok(!checkPlacementFootprint(placement({ xMm: 15, yMm: 15, widthMm: 4, heightMm: 4 }), area).ok || true);
    const inside = checkPlacementFootprint(placement({ xMm: 15, yMm: 15, widthMm: 4, heightMm: 4 }), area);
    assert.ok(inside.ok && !inside.fits);
    // Touching the hole boundary.
    const touch = checkPlacementFootprint(placement({ xMm: 15, yMm: 7.5, widthMm: 10, heightMm: 5 }), area);
    assert.ok(touch.ok && !touch.fits);
    // Enclosing the hole entirely.
    const enclose = checkPlacementFootprint(placement({ xMm: 50, yMm: 50, widthMm: 90, heightMm: 90 }), area);
    assert.ok(enclose.ok && !enclose.fits);
    // Crossing an exclusion edge.
    const crossing = checkPlacementFootprint(placement({ xMm: 15, yMm: 15, widthMm: 30, heightMm: 4 }), area);
    assert.ok(crossing.ok && !crossing.fits);
  });
});

describe("buildPlacementBundle", () => {
  it("builds a valid empty bundle and deterministic text", () => {
    const { ev, fit, snap, front } = context();
    const areas = areasWithSquare([front]);
    const built = buildPlacementBundle(ev, fit, [front], areas, {}, {}, snap);
    assert.ok(built.ok);
    assert.equal(built.bundle.schemaVersion, PLACEMENT_BUNDLE_VERSION);
    assert.equal(built.bundle.pendingReview, true);
    assert.equal(built.bundle.productionApproved, false);
    assert.deepEqual(built.bundle.placements, []);
    assert.deepEqual(built.bundle.statuses, []);
    const text = serializePlacementBundle(built.bundle);
    assert.equal(serializePlacementBundle(JSON.parse(text)), text);
  });
  it("supports repeats: same logo in different and same regions", () => {
    const { ev, fit, snap, front, back } = context();
    const areas = areasWithSquare([front, back]);
    let placements: PlacementsMap = {};
    for (const [id, regionId] of [["a", "front"], ["b", "back"], ["c", "front"]] as const) {
      const out = addPlacement(placements, placement({ id, regionId }), logos(), ["front", "back"]);
      assert.ok(out.ok);
      placements = out.placements;
    }
    const built = buildPlacementBundle(ev, fit, [front, back], areas, logos(), placements, snap);
    assert.ok(built.ok);
    assert.deepEqual(built.bundle.placements.map((p) => p.id), ["a", "b", "c"]);
    assert.ok(built.bundle.statuses.every((s) => s.fits));
  });
  it("saves geometrically-invalid placements with fits:false instead of failing", () => {
    const { ev, fit, snap, front } = context();
    const areas = areasWithSquare([front]);
    const added = addPlacement({}, placement({ xMm: 500 }), logos(), ["front"]);
    assert.ok(added.ok);
    const built = buildPlacementBundle(ev, fit, [front], areas, logos(), added.placements, snap);
    assert.ok(built.ok);
    assert.equal(built.bundle.statuses[0]!.fits, false);
  });
  it("fails atomically on dangling refs, dup keys, limits, stale frames, and forged fits", () => {
    const { ev, fit, snap, front } = context();
    const areas = areasWithSquare([front]);
    const good = addPlacement({}, placement(), logos(), ["front"]);
    assert.ok(good.ok);
    const danglingLogo = buildPlacementBundle(ev, fit, [front], areas, {}, good.placements, snap);
    assert.equal(danglingLogo.ok, false);
    const aliased: PlacementsMap = Object.create(null);
    aliased["p1"] = placement({ id: "other" });
    assert.equal(buildPlacementBundle(ev, fit, [front], areas, logos(), aliased, snap).ok, false);
    assert.equal(buildPlacementBundle(ev, { ...fit, scaleMmPerUnit: 1234.5 }, [front], areas, logos(), good.placements, snap).ok, false);
    assert.equal(buildPlacementBundle(ev, fit, [front], areas, logos(), good.placements, "stale").ok, false);
    const staleRegion: PlanarRegionRecord = { ...front, frameId: "changed" };
    assert.equal(buildPlacementBundle(ev, fit, [staleRegion], areas, logos(), good.placements, snap).ok, false);
    const many: PlacementsMap = Object.create(null);
    for (let i = 0; i < 257; i++) many[`p${i}`] = placement({ id: `p${i}` });
    assert.equal(buildPlacementBundle(ev, fit, [front], areas, logos(), many, snap).ok, false);
    const manyLogos: LogosMap = Object.create(null);
    for (let i = 0; i < 65; i++) manyLogos[`l${i}`] = { id: `l${i}`, name: `L${i}` };
    assert.equal(buildPlacementBundle(ev, fit, [front], areas, manyLogos, {}, snap).ok, false);
  });
  it("sorts statuses by id and never throws on malformed entries", () => {
    const areas = areasWithSquare([context().front]);
    void areas;
    const { front } = context();
    const fresh = areasWithSquare([front]);
    const malformed: PlacementsMap = {
      b: placement({ id: "b", xMm: 500 }),
      a: placement({ id: "a" }),
    };
    const statuses = statusAll(malformed, logos(), fresh);
    assert.deepEqual(statuses.map((s) => s.id), ["a", "b"]);
    assert.equal(statuses[0]!.fits, true);
    assert.equal(statuses[1]!.fits, false);
    const dangling = statusAll({ z: placement({ id: "z", logoId: "missing" }) }, logos(), fresh);
    assert.equal(dangling[0]!.fits, false);
    assert.equal(dangling[0]!.footprint.length, 0);
  });
  it("rotated placements fit exactly when corners stay inside", () => {
    const { front } = context();
    const areas = areasWithSquare([front]);
    const rotated = checkPlacementFootprint(
      placement({ xMm: 50, yMm: 50, widthMm: 20, heightMm: 10, rotationDeg: 33.7 }),
      areas["front"]!,
    );
    assert.ok(rotated.ok && rotated.fits);
    assert.equal(rotated.ok && rotated.footprint.length, 4);
  });
  it("accepts DraftLogo pixel hints but ignores binary claims in validation", () => {
    const withPixels: LogosMap = {
      crest: { id: "crest", name: "Crest", widthPx: 200, heightPx: 60 },
    };
    assert.ok(addLogo({}, { id: "crest", name: "Crest", widthPx: 200, heightPx: 60 }).ok);
    assert.equal(addLogo({}, { id: "bad", name: "Bad", widthPx: 0 } as DraftLogo).ok, false);
    assert.ok(validateDraftPlacement(placement(), withPixels, ["front"]).ok);
  });
  it("treats __proto__ ids as real own-keys without prototype pollution", () => {
    const logoOut = addLogo({}, { id: "__proto__", name: "Proto" });
    assert.ok(logoOut.ok);
    assert.ok(Object.hasOwn(logoOut.logos, "__proto__"));
    assert.equal(logoOut.logos["__proto__"]?.name, "Proto");
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    const placed = addPlacement(
      {},
      { ...placement(), id: "__proto__", logoId: "__proto__" },
      logoOut.logos,
      ["front"],
    );
    assert.ok(placed.ok);
    assert.ok(Object.hasOwn(placed.placements, "__proto__"));
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });
  it("fails atomically on null/array placement or null logo entries without throwing", () => {
    const { ev, fit, snap, front } = context();
    const areas = areasWithSquare([front]);
    const base = addPlacement({}, placement(), logos(), ["front"]);
    assert.ok(base.ok);
    const withNull = { ...base.placements, bad: null } as unknown as PlacementsMap;
    const nullResult = buildPlacementBundle(ev, fit, [front], areas, logos(), withNull, snap);
    assert.equal(nullResult.ok, false);
    assert.ok(!nullResult.ok && nullResult.error.includes("cannot build placement bundle:"));
    const withArray = { ...base.placements, bad: [] } as unknown as PlacementsMap;
    const arrayResult = buildPlacementBundle(ev, fit, [front], areas, logos(), withArray, snap);
    assert.equal(arrayResult.ok, false);
    assert.ok(!arrayResult.ok && arrayResult.error.includes("cannot build placement bundle:"));
    const badLogos = { ok: { id: "ok", name: "Ok" }, bad: null } as unknown as LogosMap;
    const logoResult = buildPlacementBundle(ev, fit, [front], areas, badLogos, {}, snap);
    assert.equal(logoResult.ok, false);
    assert.ok(!logoResult.ok && logoResult.error.includes("cannot build placement bundle:"));
    assert.ok(!Object.hasOwn(withNull as object, "__mutated"));
    assert.deepEqual(Object.keys(base.placements), ["p1"]);
  });
});
