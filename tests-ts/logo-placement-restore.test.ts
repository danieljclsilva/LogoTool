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
  addPlacement,
  buildPlacementBundle,
  PLACEMENT_BUNDLE_VERSION,
  serializePlacementBundle,
  type LogosMap,
  type PlacementsMap,
} from "../src/core/logo-placements/index.js";
import {
  parsePlacementRestore,
  PLACEMENT_RESTORE_LIMITS,
} from "../src/core/logo-placement-restore/index.js";

const SHA = "ab".repeat(32);
const WRONG_SHA = "00".repeat(32);
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
  return {
    ev,
    fit,
    snap,
    front: mkRegion("front", "front-mm"),
    back: mkRegion("back", "back-mm"),
  };
}

const LOGOS: LogosMap = {
  crest: { id: "crest", name: "Crest" },
  wordmark: { id: "wordmark", name: "Wordmark" },
};

function bundleText(): string {
  const { ev, fit, snap, front, back } = context();
  let areas: AreasMap = {};
  const safe = setSafePolygon(areas, front, SQUARE_SAFE);
  assert.ok(safe.ok);
  areas = safe.areas;
  const hole = addExclusion(areas, front, "hole", "Hole", HOLE);
  assert.ok(hole.ok);
  areas = hole.areas;
  areas = { ...areas };
  let placements: PlacementsMap = {};
  for (const spec of [
    { id: "a", logoId: "crest", regionId: "front", xMm: 50, yMm: 50, widthMm: 20, heightMm: 10, rotationDeg: 0 },
    { id: "b", logoId: "crest", regionId: "back", xMm: 50, yMm: 50, widthMm: 20, heightMm: 10, rotationDeg: 33.7 },
    { id: "c", logoId: "wordmark", regionId: "front", xMm: 70, yMm: 70, widthMm: 10, heightMm: 10, rotationDeg: -90 },
  ] as const) {
    const out = addPlacement(placements, { ...spec }, LOGOS, ["front", "back"]);
    assert.ok(out.ok);
    placements = out.placements;
  }
  const built = buildPlacementBundle(ev, fit, [front, back], areas, LOGOS, placements, snap);
  assert.ok(built.ok);
  return serializePlacementBundle(built.bundle);
}

function mutate(text: string, fn: (envelope: Record<string, unknown>) => void): string {
  const envelope = JSON.parse(text) as Record<string, unknown>;
  fn(envelope);
  return JSON.stringify(envelope);
}

describe("logo-placement-restore", () => {
  it("roundtrips build -> serialize -> parse -> rebuild with identical placements/statuses", () => {
    const text = bundleText();
    const parsed = parsePlacementRestore(text, SHA);
    assert.ok(parsed.ok);
    assert.deepEqual(
      Object.keys(parsed.draft.placements).sort(),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      parsed.bundle.placements.map((p) => p.id),
      ["a", "b", "c"],
    );
    const rebuiltText = serializePlacementBundle(parsed.bundle);
    const reparsed = parsePlacementRestore(rebuiltText, SHA);
    assert.ok(reparsed.ok);
    assert.deepEqual(reparsed.bundle.placements, parsed.bundle.placements);
    assert.deepEqual(reparsed.bundle.statuses, parsed.bundle.statuses);
    assert.equal(reparsed.bundle.pendingReview, true);
    assert.equal(reparsed.bundle.productionApproved, false);
  });
  it("roundtrips an empty placement bundle", () => {
    const { ev, fit, snap, front } = context();
    let areas: AreasMap = {};
    const safe = setSafePolygon(areas, front, CONCAVE_SAFE);
    assert.ok(safe.ok);
    areas = safe.areas;
    const built = buildPlacementBundle(ev, fit, [front], areas, {}, {}, snap);
    assert.ok(built.ok);
    const parsed = parsePlacementRestore(serializePlacementBundle(built.bundle), SHA);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.bundle.placements, []);
    assert.deepEqual(parsed.bundle.statuses, []);
  });
  it("recomputes forged fit scale and forces pending review", () => {
    const text = bundleText();
    const forgedFit = mutate(text, (envelope) => {
      const session = envelope["session"] as Record<string, unknown>;
      const fit = session["fit"] as Record<string, unknown>;
      fit["scaleMmPerUnit"] = 1234.5;
    });
    // The forged scale never survives: restore recomputes the real fit.
    const reparsed = parsePlacementRestore(forgedFit, SHA);
    assert.ok(reparsed.ok);
    assert.notEqual(reparsed.fit.scaleMmPerUnit, 1234.5);

    const forgedApproval = mutate(text, (envelope) => {
      envelope["productionApproved"] = true;
      envelope["pendingReview"] = false;
    });
    const approval = parsePlacementRestore(forgedApproval, SHA);
    assert.ok(approval.ok);
    assert.equal(approval.bundle.productionApproved, false);
    assert.equal(approval.bundle.pendingReview, true);

    const forgedStatus = mutate(text, (envelope) => {
      const statuses = envelope["statuses"] as Array<Record<string, unknown>>;
      for (const status of statuses) {
        status["fits"] = true;
        status["reason"] = "forged";
        status["footprint"] = [{ x: -9999, y: -9999 }];
      }
    });
    const forged = parsePlacementRestore(forgedStatus, SHA);
    assert.ok(forged.ok);
    // Supplied status/footprint claims are never echoed: every status is
    // recomputed with a real 4-corner footprint and a kernel reason.
    assert.ok(
      forged.bundle.statuses.every(
        (s) => s.footprint.length === 4 && s.reason !== "forged",
      ),
    );
  });
  it("fails atomically on wrong asset hash, truncated JSON, and missing keys", () => {
    const text = bundleText();
    assert.equal(parsePlacementRestore(text, WRONG_SHA).ok, false);
    assert.equal(parsePlacementRestore(text.slice(0, text.length >> 1), SHA).ok, false);
    assert.equal(parsePlacementRestore("not json", SHA).ok, false);
    const missing = mutate(text, (envelope) => {
      delete envelope["placements"];
    });
    const result = parsePlacementRestore(missing, SHA);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && typeof result.error === "string");
  });
  it("fails on hostile shapes without throwing and with a single error string", () => {
    const hostile = ["", "   \n  ", "[1,2]", '"123"', "123", "null", "{oops", "undefined", "[]"];
    for (const bad of hostile) {
      assert.doesNotThrow(() => {
        const result = parsePlacementRestore(bad, SHA);
        assert.equal(result.ok, false);
        assert.ok(!result.ok && typeof result.error === "string");
      });
    }
    const wrongVersion = mutate(bundleText(), (envelope) => {
      envelope["schemaVersion"] = "9.9.9-final";
    });
    assert.equal(parsePlacementRestore(wrongVersion, SHA).ok, false);
  });
  it("fails on nonfinite/overflow, dangling refs, dup ids, and over-limit counts", () => {
    // NaN/Infinity never survive JSON text, so nonfinite arrives as an
    // out-of-band value which must still fail structurally.
    const nanText = bundleText().replace('"xMm": 50', '"xMm": "NaN"');
    assert.equal(parsePlacementRestore(nanText, SHA).ok, false);
    const overflow = mutate(bundleText(), (envelope) => {
      const placements = envelope["placements"] as Array<Record<string, unknown>>;
      (placements[0] as Record<string, unknown>)["widthMm"] = 1e308;
    });
    assert.equal(parsePlacementRestore(overflow, SHA).ok, false);
    const inconsistent = mutate(bundleText(), (envelope) => {
      const session = envelope["session"] as Record<string, unknown>;
      const evidence = session["evidence"] as Record<string, unknown>;
      // A second measurement contradicting the primary forces an inconsistent
      // recomputed fit (tolerance 0.5mm vs 50mm conflict).
      evidence["extraMeasurements"] = [{ pairIds: ["O", "X"], distanceMm: 150 }];
    });
    assert.equal(parsePlacementRestore(inconsistent, SHA).ok, false);
    const danglingLogo = mutate(bundleText(), (envelope) => {
      (envelope["logos"] as unknown[]).length = 0;
    });
    assert.equal(parsePlacementRestore(danglingLogo, SHA).ok, false);
    const danglingRegion = mutate(bundleText(), (envelope) => {
      const placements = envelope["placements"] as Array<Record<string, unknown>>;
      (placements[0] as Record<string, unknown>)["regionId"] = "nowhere";
    });
    assert.equal(parsePlacementRestore(danglingRegion, SHA).ok, false);
    const dup = mutate(bundleText(), (envelope) => {
      const placements = envelope["placements"] as unknown[];
      placements.push(placements[0]);
    });
    assert.equal(parsePlacementRestore(dup, SHA).ok, false);
    const many = mutate(bundleText(), (envelope) => {
      const placements = envelope["placements"] as Array<Record<string, unknown>>;
      const template = { ...(placements[0] as Record<string, unknown>) };
      const extra: unknown[] = [];
      for (let i = 0; i < PLACEMENT_RESTORE_LIMITS.maxPlacements + 1; i++) {
        extra.push({ ...template, id: `bulk-${i}` });
      }
      envelope["placements"] = extra;
    });
    assert.equal(parsePlacementRestore(many, SHA).ok, false);
  });
  it("roundtrips __proto__ ids safely and rejects duplicates", () => {
    const { ev, fit, snap, front } = context();
    let areas: AreasMap = {};
    const safe = setSafePolygon(areas, front, SQUARE_SAFE);
    assert.ok(safe.ok);
    areas = safe.areas;
    // JSON.parse yields an own "__proto__" key; an object literal would set
    // the prototype instead.
    const protoLogos: LogosMap = JSON.parse('{"__proto__":{"id":"__proto__","name":"Proto"}}');
    const protoPlaced = addPlacement(
      {},
      {
        id: "__proto__",
        logoId: "__proto__",
        regionId: "front",
        xMm: 50,
        yMm: 50,
        widthMm: 10,
        heightMm: 10,
        rotationDeg: 0,
      },
      protoLogos,
      ["front"],
    );
    assert.ok(protoPlaced.ok);
    const built = buildPlacementBundle(ev, fit, [front], areas, protoLogos, protoPlaced.placements, snap);
    assert.ok(built.ok);
    const parsed = parsePlacementRestore(serializePlacementBundle(built.bundle), SHA);
    assert.ok(parsed.ok);
    assert.equal(Object.getPrototypeOf(parsed.draft.placements), null);
    assert.ok(Object.hasOwn(parsed.draft.placements, "__proto__"));
    assert.ok(Object.hasOwn(parsed.draft.logos, "__proto__"));
    const dup = mutate(serializePlacementBundle(built.bundle), (envelope) => {
      const placements = envelope["placements"] as unknown[];
      placements.push(placements[0]);
    });
    assert.equal(parsePlacementRestore(dup, SHA).ok, false);
  });
  it("is deterministic: serialize twice byte-identical with stable key order", () => {
    const first = bundleText();
    const second = bundleText();
    assert.equal(first, second);
    const parsed = parsePlacementRestore(first, SHA);
    assert.ok(parsed.ok);
    assert.equal(serializePlacementBundle(parsed.bundle), first);
    // stableStringify sorts keys alphabetically.
    assert.ok(first.indexOf('"areas"') < first.indexOf('"logos"'));
    assert.ok(first.indexOf('"logos"') < first.indexOf('"placements"'));
    assert.ok(first.indexOf('"pendingReview"') < first.indexOf('"productionApproved"'));
  });
  it("rejects stale frame snapshots and inconsistent fits", () => {
    const stale = mutate(bundleText(), (envelope) => {
      const regions = envelope["regions"] as Array<Record<string, unknown>>;
      (regions[0] as Record<string, unknown>)["frameId"] = "changed-frame";
    });
    assert.equal(parsePlacementRestore(stale, SHA).ok, false);
  });
  it("enforces the char limit with a single error", () => {
    const big = `{"schemaVersion":${JSON.stringify(PLACEMENT_BUNDLE_VERSION)},"pad":"${"x".repeat(PLACEMENT_RESTORE_LIMITS.maxChars)}"}`;
    assert.ok(big.length > PLACEMENT_RESTORE_LIMITS.maxChars);
    const result = parsePlacementRestore(big, SHA);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && typeof result.error === "string");
  });
  it("never echoes supplied productionApproved/pendingReview as authority", () => {
    void PLACEMENT_BUNDLE_VERSION;
    const forged = mutate(bundleText(), (envelope) => {
      envelope["productionApproved"] = true;
      envelope["pendingReview"] = "yes";
    });
    const parsed = parsePlacementRestore(forged, SHA);
    assert.ok(parsed.ok);
    assert.equal(parsed.bundle.productionApproved, false);
    assert.equal(parsed.bundle.pendingReview, true);
  });
});
