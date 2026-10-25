import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCOPE_SAVED_AREA_ID,
  SIBLING_REGION_SEPARATOR,
  areaIdFromSiblingRegionId,
  isSiblingRegionId,
  parseActiveAreasFile,
  retireDeletedRegions,
  scopeOwnerOf,
  seedNamedAreas,
  serializeActiveAreasFile,
  siblingRegionIdFor,
  unseenSiblingIds,
} from "../src/ui/internal-builder/product-setup-view.js";
import type { ProjectDocument } from "../src/core/types.js";

type TestProduct = ProjectDocument["products"][number];

function testProduct(): TestProduct {
  return {
    schemaVersion: "0.1.0-provisional",
    id: "P",
    kind: "other",
    name: "P",
    variants: [
      { id: "V1", name: "V1", regionIds: ["R", "R--area-a2", "R--area-gone"] },
      { id: "V2", name: "V2", regionIds: ["R"] },
    ],
    regions: [
      {
        id: "R",
        name: "Scope",
        frame: { frameId: "F", originDescription: "o", axes: { xPositive: "x", yPositive: "y" } },
        calibrationRef: { calibrationId: "C", version: "1" },
        safeArea: [[0, 0], [1, 0], [1, 1]],
        allowedMethods: ["embroidery"],
      },
      {
        id: "R--area-a2",
        name: "Second",
        frame: { frameId: "F2", originDescription: "o", axes: { xPositive: "x", yPositive: "y" } },
        calibrationRef: { calibrationId: "C", version: "1" },
        safeArea: [[5, 5], [6, 5], [6, 6]],
        allowedMethods: ["embroidery"],
      },
      {
        id: "R--area-gone",
        name: "Gone",
        frame: { frameId: "F3", originDescription: "o", axes: { xPositive: "x", yPositive: "y" } },
        calibrationRef: { calibrationId: "C", version: "1" },
        safeArea: [[9, 9], [10, 9], [10, 10]],
        allowedMethods: ["embroidery"],
      },
    ],
    calibrations: [{ id: "C", version: "1", description: "d" }],
  } as unknown as TestProduct;
}

const corner = (x: number, y: number) => ({ x, y });

describe("named-area seeding and sibling region identity", () => {
  it("legacy seeding (no saved list): one entry from a saved polygon, none when empty", () => {
    const one = seedNamedAreas([corner(0, 0), corner(10, 0), corner(10, 5)], "Front area");
    assert.equal(one.namedAreas.length, 1);
    assert.equal(one.namedAreas[0]!.name, "Front area");
    assert.equal(one.activeAreaId, one.namedAreas[0]!.id);
    const none = seedNamedAreas([], "Front area");
    assert.deepEqual(none, { namedAreas: [], activeAreaId: null });
  });

  it("saved branch seeds verbatim with stable ids and honours a matching active id", () => {
    const saved = {
      areas: [
        { id: "a-1", name: "Left", points: [corner(0, 0), corner(4, 0), corner(4, 4)] },
        { id: "a-2", name: "Right", points: [corner(10, 0), corner(14, 0), corner(14, 4)] },
      ],
      activeAreaId: "a-2" as string | null,
    };
    const seeded = seedNamedAreas([], null, saved);
    // Empty scope polygon: no scope entry is invented.
    assert.deepEqual(seeded.namedAreas.map((entry) => entry.id), ["a-1", "a-2"]);
    assert.equal(seeded.activeAreaId, "a-2");
    // Deep copies: mutating the output leaves the input alone.
    seeded.namedAreas[0]!.points[0]!.x = 999;
    assert.equal(saved.areas[0]!.points[0]!.x, 0);
  });

  it("saved branch prepends the scope entry for a non-empty scope polygon", () => {
    const seeded = seedNamedAreas(
      [corner(1, 1), corner(2, 1), corner(2, 2)],
      "Scope region",
      { areas: [{ id: "a-9", name: "Other", points: [corner(5, 5), corner(6, 5), corner(6, 6)] }], activeAreaId: null },
    );
    assert.deepEqual(seeded.namedAreas.map((entry) => entry.id), [SCOPE_SAVED_AREA_ID, "a-9"]);
    assert.equal(seeded.namedAreas[0]!.name, "Scope region");
    // No provided active id: falls back to the scope entry (first).
    assert.equal(seeded.activeAreaId, SCOPE_SAVED_AREA_ID);
  });

  it("saved branch falls back deterministically on unknown active ids", () => {
    const seeded = seedNamedAreas([], null, {
      areas: [{ id: "a-1", name: "Only", points: [corner(0, 0), corner(1, 0), corner(0, 1)] }],
      activeAreaId: "gone",
    });
    assert.equal(seeded.activeAreaId, "a-1");
  });

  it("identical polygons with different names persist distinctly by stable id", () => {
    const twin = [corner(0, 0), corner(8, 0), corner(8, 8)];
    const seed = (id: string, name: string) => ({ id, name, points: twin.map((p) => ({ ...p })) });
    const leftId = siblingRegionIdFor("region-span-1", "psetup-area-1-aa11");
    const rightId = siblingRegionIdFor("region-span-1", "psetup-area-2-bb22");
    assert.notEqual(leftId, rightId);
    // Seeding keeps both entries verbatim (no dedup by coordinates).
    const seeded = seedNamedAreas([], null, {
      areas: [seed("psetup-area-1-aa11", "Left"), seed("psetup-area-2-bb22", "Twin")],
      activeAreaId: "psetup-area-2-bb22",
    });
    assert.equal(seeded.namedAreas.length, 2);
    assert.deepEqual(seeded.namedAreas[0]!.points, seeded.namedAreas[1]!.points);
    assert.equal(seeded.activeAreaId, "psetup-area-2-bb22");
    // The explicit hint — not polygon content — selects the active entry.
    const hinted = parseActiveAreasFile(serializeActiveAreasFile({ "region-span-1": "psetup-area-2-bb22" }));
    assert.equal(hinted["region-span-1"], "psetup-area-2-bb22");
    // Owner resolution is coordinate-independent too.
    assert.equal(scopeOwnerOf([{ id: "region-span-1" }, { id: leftId }, { id: rightId }], rightId), "region-span-1");
  });

  it("sibling region ids round-trip losslessly for view-generated area ids", () => {
    const scope = "region-span-1";
    for (const areaId of ["psetup-area-1-ab12", "psetup-area-27-00ff", "scope-saved-area"]) {
      const regionId = siblingRegionIdFor(scope, areaId);
      assert.ok(isSiblingRegionId(scope, regionId), regionId);
      assert.equal(areaIdFromSiblingRegionId(scope, regionId), areaId);
    }
    assert.equal(isSiblingRegionId(scope, scope), false);
    assert.equal(isSiblingRegionId(scope, "region-span-1-extra"), false);
    assert.equal(areaIdFromSiblingRegionId(scope, "region-span-1"), null);
    assert.ok(SIBLING_REGION_SEPARATOR.length > 0);
  });

  it("stale-submitter check flags live siblings the bucket never saw", () => {
    // B added by another scope after this bucket seeded [A]: refuse.
    assert.deepEqual(unseenSiblingIds(["s-a", "s-b"], ["s-a"], ["s-a"]), ["s-b"]);
    // B seen at seed and now deleted: a known deletion, not unseen.
    assert.deepEqual(unseenSiblingIds(["s-a", "s-b"], ["s-a"], ["s-a", "s-b"]), []);
    // Steady state and legacy (no seed list) never refuse here.
    assert.deepEqual(unseenSiblingIds(["s-a"], ["s-a"], ["s-a"]), []);
    assert.deepEqual(unseenSiblingIds(["s-a", "s-b"], ["s-a"], undefined), []);
  });

  it("scopeOwnerOf resolves sibling regions to their owning scope, longest wins", () => {
    const regions = [{ id: "R" }, { id: "R--area-x" }, { id: "R--area-x--area-y" }];
    assert.equal(scopeOwnerOf(regions, "R--area-x"), "R");
    assert.equal(scopeOwnerOf(regions, "R--area-x--area-y"), "R--area-x");
    assert.equal(scopeOwnerOf(regions, "R"), null);
    assert.equal(scopeOwnerOf(regions, "OTHER--area-x"), null);
    assert.equal(scopeOwnerOf([], "R--area-x"), null);
  });

  it("retireDeletedRegions removes unreferenced regions with links, retires referenced ones emptied", () => {
    const product = testProduct();
    const referenced = new Set(["R--area-gone"]);
    const fate = retireDeletedRegions(
      product,
      [
        { id: "R--area-a2", name: "Second" },
        { id: "R--area-gone", name: "Gone" },
        { id: "R--area-missing", name: "Missing" },
      ],
      "C",
      "2",
      referenced,
    );
    assert.deepEqual(fate.removed.map((entry) => entry.id), ["R--area-a2"]);
    assert.deepEqual(fate.retired.map((entry) => entry.id), ["R--area-gone"]);
    // Removed: region gone, links gone from every variant.
    assert.ok(!product.regions.some((region) => region.id === "R--area-a2"));
    for (const variant of product.variants) {
      assert.ok(!variant.regionIds.includes("R--area-a2"), variant.id);
    }
    // Retired: region stays emptied with the CURRENT ref, links kept.
    const retired = product.regions.find((region) => region.id === "R--area-gone")!;
    assert.ok(retired, "referenced region stays");
    assert.deepEqual(retired.safeArea, []);
    assert.deepEqual(retired.calibrationRef, { calibrationId: "C", version: "2" });
    assert.ok(product.variants[0]!.regionIds.includes("R--area-gone"));
    // Scope region untouched.
    assert.equal(product.regions.find((region) => region.id === "R")!.safeArea.length, 3);
  });

  it("applySaveOutcome re-baselines to the saved scope polygon, not staged content", async () => {
    const { applySaveOutcome } = await import("../src/ui/internal-builder/product-setup-view.js");
    const staged = [corner(1, 1), corner(2, 1), corner(2, 2)];
    const scope = [corner(0, 0), corner(9, 0), corner(9, 9)];
    const bucket = {
      safeArea: staged.map((p) => ({ ...p })),
      anchors: [],
      dirty: true,
      baseSafeArea: scope.map((p) => ({ ...p })),
      conflicted: false,
    };
    const snapshot = {
      safeArea: staged.map((p) => ({ ...p })),
      anchors: [],
      baseSafeArea: scope.map((p) => ({ ...p })),
    };
    const text = applySaveOutcome(bucket, snapshot, "Scope", { ok: true, scopeSafeArea: scope.map((p) => ({ ...p })) });
    assert.ok(text.includes("Saved Scope"));
    assert.deepEqual(bucket.baseSafeArea, scope);
    assert.deepEqual(bucket.safeArea, staged);
    assert.equal(bucket.dirty, false);
    // The seed baseline advances to exactly what was submitted, so a second
    // save from the same bucket does not mistake its own siblings for
    // another scope's work.
    const submitted = [{ id: "a-1", name: "A", points: staged.map((p) => ({ ...p })) }];
    const advancing = {
      safeArea: staged.map((p) => ({ ...p })),
      anchors: [],
      baseSafeArea: scope.map((p) => ({ ...p })),
      namedAreas: submitted.map((entry) => ({ ...entry, points: entry.points.map((p) => ({ ...p })) })),
    };
    const advancingBucket = {
      safeArea: staged.map((p) => ({ ...p })),
      anchors: [],
      dirty: true,
      baseSafeArea: [{ id: "x" }] as unknown as Array<{ x: number; y: number }>,
      baseNamedAreas: [] as Array<{ id: string; name: string; points: Array<{ x: number; y: number }> }>,
      conflicted: false,
    };
    applySaveOutcome(advancingBucket, advancing, "Scope", { ok: true, scopeSafeArea: scope.map((p) => ({ ...p })) });
    assert.deepEqual(advancingBucket.baseNamedAreas.map((entry) => entry.id), ["a-1"]);
    // Legacy callers without scopeSafeArea keep snapshot baselining.
    const legacyBucket = {
      safeArea: staged.map((p) => ({ ...p })),
      anchors: [],
      dirty: true,
      baseSafeArea: staged.map((p) => ({ ...p })),
      conflicted: false,
    };
    applySaveOutcome(legacyBucket, snapshot, "Scope", { ok: true });
    assert.deepEqual(legacyBucket.baseSafeArea, staged);
  });

  it("active-areas hint file round-trips deterministically and fails soft", () => {
    const bytes = serializeActiveAreasFile({ "region-b": "a-2", "region-a": "a-1" });
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.indexOf('"region-a"') < text.indexOf('"region-b"'), "sorted keys");
    assert.deepEqual(parseActiveAreasFile(bytes), { "region-a": "a-1", "region-b": "a-2" });
    assert.deepEqual(parseActiveAreasFile(undefined), {});
    assert.deepEqual(parseActiveAreasFile(new Uint8Array(0)), {});
    assert.deepEqual(parseActiveAreasFile(new TextEncoder().encode("not json")), {});
    assert.deepEqual(parseActiveAreasFile(new TextEncoder().encode(JSON.stringify({ version: "x", scopes: {} }))), {});
    assert.deepEqual(parseActiveAreasFile(new TextEncoder().encode(JSON.stringify({ version: "active-areas/1", scopes: [] }))), {});
  });
});
