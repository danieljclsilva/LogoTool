import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fitUniformScale,
  type CalibrationEvidence,
} from "../src/core/calibration/index.js";
import {
  buildEvidence,
  snapshotEvidence,
  type DraftAnchor,
  type SessionFields,
} from "../src/core/calibration-session/index.js";
import {
  createPlanarRegion,
  type PlanarRegionInput,
  type PlanarRegionRecord,
} from "../src/core/planar-region/index.js";
import {
  addExclusion,
  buildAreaBundle,
  clearSafePolygon,
  serializeAreaBundle,
  setSafePolygon,
  type AreasMap,
} from "../src/core/region-areas/index.js";
import { AREA_RESTORE_LIMITS } from "../src/core/region-areas-restore/index.js";
import {
  buildPreparedProductFromAreaBundle,
  type BridgeLabels,
  type BridgeRegionLabel,
} from "../src/core/inspector-bridge/index.js";
import { SCHEMA_VERSION } from "../src/core/types.js";
import { validateProduct, validateProject } from "../src/core/validate.js";
import { createProjectFromDefinitions } from "../src/core/project-builder/create-project.js";

const SHA = "ab".repeat(32);
const WRONG_SHA = "cd".repeat(32);

// Proven simple concave chevron + rectangular hole (mirror restore fixtures).
const CHEVRON_TEXT = "[[0,0],[50,50],[100,0],[100,100],[0,100]]";
const HOLE_TEXT = "[[10,10],[20,10],[20,20],[10,20]]";
// Full-precision triangle (always simple when vertices are distinct).
const PRECISE_TEXT = JSON.stringify([
  { x: 0.123456789012345, y: -0.987654321098765 },
  { x: 100.00000000000001, y: 0.3333333333333333 },
  { x: -50.5, y: 86.12345678901234 },
]);
const PRECISE_EXPECTED = [
  [0.123456789012345, -0.987654321098765],
  [100.00000000000001, 0.3333333333333333],
  [-50.5, 86.12345678901234],
];

function fields(): SessionFields {
  return {
    product: "synthetic-tee",
    variant: "M",
    calibrationId: "CAL-1",
    frameId: "asset-root",
    provisionalVersion: "v1",
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
    { id: "Z", model: { x: 0, y: 0, z: 5 } },
  ];
}

function makeEvidence(): CalibrationEvidence {
  const built = buildEvidence(fields(), anchors(), [
    { a: "O", b: "X", distanceMm: 100 },
    { a: "O", b: "Y", distanceMm: 10 * Math.hypot(3, 5) },
  ]);
  assert.ok(built.ok);
  return built.evidence;
}

function makeRegion(
  ev: CalibrationEvidence,
  snap: string,
  spec: PlanarRegionInput,
): PlanarRegionRecord {
  const made = createPlanarRegion(spec, anchors(), ev, snap);
  assert.ok(made.ok);
  return made.region;
}

const FRONT_SPEC: PlanarRegionInput = {
  regionId: "front",
  frameId: "front-mm",
  originAnchorId: "O",
  xAnchorId: "X",
  yAnchorId: "Y",
  offPlaneToleranceMm: 0.01,
};

const BACK_SPEC: PlanarRegionInput = {
  regionId: "back",
  frameId: "back-mm",
  originAnchorId: "X",
  xAnchorId: "O",
  yAnchorId: "Y",
  offPlaneToleranceMm: 0.01,
};

const SIDE_SPEC: PlanarRegionInput = {
  regionId: "side",
  frameId: "side-mm",
  originAnchorId: "O",
  xAnchorId: "Z",
  yAnchorId: "Y",
  offPlaneToleranceMm: 0.01,
};

/** Single region with a concave safe polygon plus one exclusion. */
function singleRegionInput(): { input: unknown; ev: CalibrationEvidence } {
  const ev = makeEvidence();
  const fit = fitUniformScale(ev);
  const snap = snapshotEvidence(ev);
  const region = makeRegion(ev, snap, FRONT_SPEC);
  let areas: AreasMap = {};
  const safe = setSafePolygon(areas, region, CHEVRON_TEXT);
  assert.ok(safe.ok);
  areas = safe.areas;
  const hole = addExclusion(areas, region, "hole", "Button hole", HOLE_TEXT);
  assert.ok(hole.ok);
  areas = hole.areas;
  const built = buildAreaBundle(ev, fit, [region], areas, snap);
  assert.ok(built.ok);
  return { input: JSON.parse(serializeAreaBundle(built.bundle)), ev };
}

/** Two regions: concave+exclusion front, full-precision triangle back. */
function twoRegionInput(): { input: unknown; ev: CalibrationEvidence } {
  const ev = makeEvidence();
  const fit = fitUniformScale(ev);
  const snap = snapshotEvidence(ev);
  const front = makeRegion(ev, snap, FRONT_SPEC);
  const back = makeRegion(ev, snap, BACK_SPEC);
  let areas: AreasMap = {};
  const safeFront = setSafePolygon(areas, front, CHEVRON_TEXT);
  assert.ok(safeFront.ok);
  areas = safeFront.areas;
  const hole = addExclusion(areas, front, "hole", "Button hole", HOLE_TEXT);
  assert.ok(hole.ok);
  areas = hole.areas;
  const safeBack = setSafePolygon(areas, back, PRECISE_TEXT);
  assert.ok(safeBack.ok);
  areas = safeBack.areas;
  const built = buildAreaBundle(ev, fit, [front, back], areas, snap);
  assert.ok(built.ok);
  return { input: JSON.parse(serializeAreaBundle(built.bundle)), ev };
}

/** Three configured regions for subset/variant tests. */
function threeRegionInput(): { input: unknown; ev: CalibrationEvidence } {
  const ev = makeEvidence();
  const fit = fitUniformScale(ev);
  const snap = snapshotEvidence(ev);
  const specs = [FRONT_SPEC, BACK_SPEC, SIDE_SPEC];
  const made = specs.map((spec) => makeRegion(ev, snap, spec));
  let areas: AreasMap = {};
  for (const region of made) {
    const safe = setSafePolygon(areas, region, CHEVRON_TEXT);
    assert.ok(safe.ok);
    areas = safe.areas;
  }
  const built = buildAreaBundle(ev, fit, made, areas, snap);
  assert.ok(built.ok);
  return { input: JSON.parse(serializeAreaBundle(built.bundle)), ev };
}

function regionLabel(id: string): BridgeRegionLabel {
  return {
    originDescription: `Synthetic datum for ${id}; +x right, +y up facing the region; mm.`,
    axes: { xPositive: "right", yPositive: "up" },
    allowedMethods: ["embroidery", "print"],
  };
}

function labelsFor(regionIds: string[]): BridgeLabels {
  const regions: Record<string, BridgeRegionLabel> = {};
  for (const id of regionIds) regions[id] = regionLabel(id);
  return {
    product: { id: "SYN-BRIDGE-001", name: "Synthetic Bridged Tee", kind: "upper-body" },
    variants: [{ id: "SYN-V1", name: "Variant one" }],
    regions,
  };
}

function mutableEnvelope(input: unknown): {
  schemaVersion: unknown;
  session: { evidence: Record<string, unknown>; fit: Record<string, unknown> };
  regions: Record<string, unknown>[];
  areas: Record<string, unknown>[];
} {
  return JSON.parse(JSON.stringify(input)) as {
    schemaVersion: unknown;
    session: { evidence: Record<string, unknown>; fit: Record<string, unknown> };
    regions: Record<string, unknown>[];
    areas: Record<string, unknown>[];
  };
}

describe("inspector-bridge: area bundle to prepared product", () => {
  it("converts a single region and passes validateProduct", () => {
    const { input } = singleRegionInput();
    const result = buildPreparedProductFromAreaBundle(input, labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.product.schemaVersion, SCHEMA_VERSION);
    assert.equal(result.product.id, "SYN-BRIDGE-001");
    assert.equal(result.product.name, "Synthetic Bridged Tee");
    assert.equal(result.product.kind, "upper-body");
    assert.equal(result.product.regions.length, 1);
    assert.equal(result.product.regions[0]!.id, "front");
    assert.equal(result.product.regions[0]!.frame.frameId, "front-mm");
    assert.equal(result.product.calibrations.length, 1);
    assert.equal(validateProduct(result.product).ok, true);
  });

  it("carries exact full-precision safe polygons, concave rings, and exclusions", () => {
    const { input } = twoRegionInput();
    const result = buildPreparedProductFromAreaBundle(input, labelsFor(["front", "back"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const front = result.product.regions.find((r) => r.id === "front");
    const back = result.product.regions.find((r) => r.id === "back");
    assert.deepEqual(front!.safeArea, [[0, 0], [50, 50], [100, 0], [100, 100], [0, 100]]);
    assert.deepEqual(front!.exclusions, [[[10, 10], [20, 10], [20, 20], [10, 20]]]);
    assert.deepEqual(back!.safeArea, PRECISE_EXPECTED);
    assert.deepEqual(back!.exclusions, []);
  });

  it("carries calibration identity/version with a provisional, never-approved description", () => {
    const { input, ev } = singleRegionInput();
    const result = buildPreparedProductFromAreaBundle(input, labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const region = result.product.regions[0]!;
    assert.deepEqual(region.calibrationRef, {
      calibrationId: ev.calibrationId,
      version: ev.provisionalVersion,
    });
    const calibration = result.product.calibrations[0]!;
    assert.equal(calibration.id, ev.calibrationId);
    assert.equal(calibration.version, ev.provisionalVersion);
    assert.match(calibration.description ?? "", /provisional/);
    assert.match(calibration.description ?? "", /pending human review/);
    assert.match(calibration.description ?? "", /never production-approved/);
  });

  it("converts multiple regions with variant subsets and default-to-all variants", () => {
    const { input } = threeRegionInput();
    const labels = labelsFor(["front", "back", "side"]);
    labels.variants = [
      { id: "V-ALL" },
      { id: "V-FRONT", regionIds: ["front"] },
      { id: "V-BACK-SIDE", name: "Back and side", regionIds: ["back", "side"] },
    ];
    const result = buildPreparedProductFromAreaBundle(input, labels, {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.product.regions.map((r) => r.id),
      ["back", "front", "side"],
    );
    const byId = new Map(result.product.variants.map((v) => [v.id, v.regionIds]));
    assert.deepEqual(byId.get("V-ALL"), ["back", "front", "side"]);
    assert.deepEqual(byId.get("V-FRONT"), ["front"]);
    assert.deepEqual(byId.get("V-BACK-SIDE"), ["back", "side"]);
    assert.equal(validateProduct(result.product).ok, true);
  });

  it("feeds zero-placement downstream projects via createProjectFromDefinitions", () => {
    const { input } = twoRegionInput();
    const labels = labelsFor(["front", "back"]);
    labels.variants = [{ id: "V-A" }, { id: "V-B", regionIds: ["front"] }];
    const result = buildPreparedProductFromAreaBundle(input, labels, {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(!("logos" in result.product));
    const created = createProjectFromDefinitions({
      products: [result.product],
      projectId: "BRIDGE-DOWNSTREAM-001",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.project.configurations.length, 2);
    for (const config of created.project.configurations) {
      assert.deepEqual(config.placements, []);
    }
    assert.equal(validateProject(created.project).ok, true);
  });

  it("supports a downstream placement using the prepared frame and method", () => {
    const { input } = singleRegionInput();
    const result = buildPreparedProductFromAreaBundle(input, labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const product = result.product;
    const region = product.regions[0]!;
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      projectId: "BRIDGE-PLACE-001",
      revision: 1,
      products: [product],
      logos: [
        {
          schemaVersion: SCHEMA_VERSION,
          id: "SYN-LOGO-A",
          assets: [{ uri: "assets/mark-a.png", role: "original", mediaType: "image/png" }],
        },
      ],
      configurations: product.variants.map((variant, i) => ({
        id: `cfg-${i + 1}`,
        productId: product.id,
        variantId: variant.id,
        placements: [
          {
            logoId: "SYN-LOGO-A",
            regionId: region.id,
            method: region.allowedMethods[0]!,
            pos: { xMm: 50, yMm: 60 },
            widthMm: 30,
            heightMm: 10,
            rotationDeg: 0,
          },
        ],
      })),
    };
    assert.equal(validateProject(doc).ok, true);
  });

  it("emits a bounded deterministic sidecar with recomputed fit evidence", () => {
    const { input, ev } = singleRegionInput();
    const labels = labelsFor(["front"]);
    const result = buildPreparedProductFromAreaBundle(input, labels, {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const sidecar = result.sidecar;
    assert.equal(sidecar.schemaVersion, "0.1.0-provisional-inspector-bridge");
    assert.equal(sidecar.sourceBundleVersion, "0.1.0-provisional-region-areas");
    assert.equal(sidecar.evidenceSnapshot, snapshotEvidence(ev));
    const expectedFit = fitUniformScale(ev);
    assert.equal(sidecar.fit.scaleMmPerUnit, expectedFit.scaleMmPerUnit);
    assert.equal(sidecar.fit.measurementCount, expectedFit.perPair.length);
    assert.equal(sidecar.fit.inconsistent, false);
    const limitations = sidecar.limitations.join(" ");
    assert.match(limitations, /planar-only/i);
    assert.match(limitations, /out of scope/);
    assert.match(limitations, /3D/);
    assert.match(limitations, /share one inspector calibration/);
    assert.match(limitations, new RegExp(ev.product));
    assert.match(limitations, new RegExp(ev.variant));
    assert.match(limitations, /not independently measured/);
    // The converted sidecar must always fit the Builder intake bound.
    assert.ok(JSON.stringify(sidecar).length <= 262144);
    assert.equal(sidecar.regions.length, 1);
    assert.equal(sidecar.regions[0]!.regionId, "front");
    assert.equal(sidecar.regions[0]!.mmPerModelUnit, expectedFit.scaleMmPerUnit);
    assert.deepEqual(sidecar.labels.variants, [
      { id: "SYN-V1", name: "Variant one", regionIds: ["front"] },
    ]);
    assert.deepEqual(sidecar.labels.product, {
      id: "SYN-BRIDGE-001",
      name: "Synthetic Bridged Tee",
      kind: "upper-body",
    });
  });

  it("is byte-identical across runs and never mutates inputs", () => {
    const { input } = twoRegionInput();
    const labels = labelsFor(["front", "back"]);
    const beforeInput = JSON.stringify(input);
    const beforeLabels = JSON.stringify(labels);
    const first = buildPreparedProductFromAreaBundle(input, labels, {
      expectedAssetSha256: SHA,
    });
    const second = buildPreparedProductFromAreaBundle(input, labels, {
      expectedAssetSha256: SHA,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(JSON.stringify(first.product), JSON.stringify(second.product));
    assert.equal(JSON.stringify(first.sidecar), JSON.stringify(second.sidecar));
    assert.equal(JSON.stringify(input), beforeInput);
    assert.equal(JSON.stringify(labels), beforeLabels);
  });

  it("rejects a null safe polygon and names the region", () => {
    const ev = makeEvidence();
    const fit = fitUniformScale(ev);
    const snap = snapshotEvidence(ev);
    const front = makeRegion(ev, snap, FRONT_SPEC);
    const back = makeRegion(ev, snap, BACK_SPEC);
    let areas: AreasMap = {};
    const safe = setSafePolygon(areas, front, CHEVRON_TEXT);
    assert.ok(safe.ok);
    areas = safe.areas;
    areas = clearSafePolygon(areas, back).areas;
    const built = buildAreaBundle(ev, fit, [front, back], areas, snap);
    assert.ok(built.ok);
    const input = JSON.parse(serializeAreaBundle(built.bundle));
    const result = buildPreparedProductFromAreaBundle(input, labelsFor(["front", "back"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.code === "unconfigured-frame"));
    assert.ok(result.errors.some((e) => e.message.includes('"back"')));
  });

  it("rejects stale frame geometry atomically", () => {
    const { input } = singleRegionInput();
    const tampered = mutableEnvelope(input);
    const origin = tampered.regions[0]!["origin"] as Record<string, unknown>;
    origin["x"] = 123.456;
    const result = buildPreparedProductFromAreaBundle(tampered, labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length > 0);
  });

  it("rejects version mismatch", () => {
    const { input } = singleRegionInput();
    const tampered = mutableEnvelope(input);
    tampered.schemaVersion = "9.9.9-future";
    const result = buildPreparedProductFromAreaBundle(tampered, labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length > 0);
  });

  it("rejects asset-hash mismatch", () => {
    const { input } = singleRegionInput();
    const result = buildPreparedProductFromAreaBundle(input, labelsFor(["front"]), {
      expectedAssetSha256: WRONG_SHA,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length > 0);
  });

  it("recomputes a forged fit instead of importing it", () => {
    const { input, ev } = singleRegionInput();
    const tampered = mutableEnvelope(input);
    const forgedScale = (tampered.session.fit["scaleMmPerUnit"] as number) * 2 + 1;
    tampered.session.fit["scaleMmPerUnit"] = forgedScale;
    const result = buildPreparedProductFromAreaBundle(tampered, labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const expectedFit = fitUniformScale(ev);
    assert.equal(result.sidecar.fit.scaleMmPerUnit, expectedFit.scaleMmPerUnit);
    assert.notEqual(result.sidecar.fit.scaleMmPerUnit, forgedScale);
    assert.equal(validateProduct(result.product).ok, true);
  });

  it("rejects forged evidence measurements", () => {
    const { input } = singleRegionInput();
    const tampered = mutableEnvelope(input);
    tampered.session.evidence["measuredDistanceMm"] = 999;
    const result = buildPreparedProductFromAreaBundle(tampered, labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length > 0);
  });

  it("rejects forged frame snapshots", () => {
    const { input } = singleRegionInput();
    const tampered = mutableEnvelope(input);
    tampered.areas[0]!["frameSnapshot"] = "forged-snapshot";
    const result = buildPreparedProductFromAreaBundle(tampered, labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length > 0);
  });

  it("rejects malformed envelopes atomically", () => {
    const { input } = singleRegionInput();
    for (const bad of [{}, null, [], "nope", 42]) {
      const result = buildPreparedProductFromAreaBundle(bad, labelsFor(["front"]), {
        expectedAssetSha256: SHA,
      });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
      if (!result.ok) assert.ok(result.errors.length > 0);
    }
    void input;
  });

  it("rejects missing product id and bad kind", () => {
    const { input } = singleRegionInput();
    const missingId = labelsFor(["front"]);
    (missingId.product as { id?: unknown }).id = "   ";
    const first = buildPreparedProductFromAreaBundle(input, missingId, {
      expectedAssetSha256: SHA,
    });
    assert.equal(first.ok, false);
    if (!first.ok) assert.ok(first.errors.some((e) => e.path === "labels.product.id"));

    const badKind = labelsFor(["front"]);
    (badKind.product as { kind?: unknown }).kind = "spaceship";
    const second = buildPreparedProductFromAreaBundle(input, badKind, {
      expectedAssetSha256: SHA,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.ok(second.errors.some((e) => e.path === "labels.product.kind"));
  });

  it("rejects blank originDescription and empty allowedMethods", () => {
    const { input } = singleRegionInput();
    const blankOrigin = labelsFor(["front"]);
    blankOrigin.regions["front"]!.originDescription = "";
    const first = buildPreparedProductFromAreaBundle(input, blankOrigin, {
      expectedAssetSha256: SHA,
    });
    assert.equal(first.ok, false);
    if (!first.ok) {
      assert.ok(first.errors.some((e) => e.path === "labels.regions.front.originDescription"));
    }

    const emptyMethods = labelsFor(["front"]);
    emptyMethods.regions["front"]!.allowedMethods = [];
    const second = buildPreparedProductFromAreaBundle(input, emptyMethods, {
      expectedAssetSha256: SHA,
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.ok(second.errors.some((e) => e.path === "labels.regions.front.allowedMethods"));
    }
  });

  it("never defaults allowedMethods when the label is omitted", () => {
    const { input } = singleRegionInput();
    const labels = labelsFor(["front"]);
    const { allowedMethods: _dropped, ...rest } = labels.regions["front"]!;
    void _dropped;
    labels.regions["front"] = rest as BridgeRegionLabel;
    const result = buildPreparedProductFromAreaBundle(input, labels, {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some(
          (e) => e.path === "labels.regions.front.allowedMethods" && e.code === "missing-label",
        ),
      );
    }
  });

  it("rejects zero variants and duplicate variant ids", () => {
    const { input } = singleRegionInput();
    const empty = labelsFor(["front"]);
    empty.variants = [];
    const first = buildPreparedProductFromAreaBundle(input, empty, {
      expectedAssetSha256: SHA,
    });
    assert.equal(first.ok, false);

    const dupes = labelsFor(["front"]);
    dupes.variants = [{ id: "V-1" }, { id: "V-1" }];
    const second = buildPreparedProductFromAreaBundle(input, dupes, {
      expectedAssetSha256: SHA,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.ok(second.errors.some((e) => e.code === "duplicate-id"));
  });

  it("rejects unknown variant region ids", () => {
    const { input } = singleRegionInput();
    const labels = labelsFor(["front"]);
    labels.variants = [{ id: "V-1", regionIds: ["nose-cone"] }];
    const result = buildPreparedProductFromAreaBundle(input, labels, {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "unknown-region"));
  });

  it("rejects missing and extra region labels", () => {
    const { input } = twoRegionInput();
    const missing = labelsFor(["front", "back"]);
    delete missing.regions["back"];
    const first = buildPreparedProductFromAreaBundle(input, missing, {
      expectedAssetSha256: SHA,
    });
    assert.equal(first.ok, false);
    if (!first.ok) {
      assert.ok(first.errors.some((e) => e.path === "labels.regions.back"));
    }

    const extra = labelsFor(["front", "back"]);
    extra.regions["sleeve"] = regionLabel("sleeve");
    const second = buildPreparedProductFromAreaBundle(input, extra, {
      expectedAssetSha256: SHA,
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.ok(second.errors.some((e) => e.code === "unknown-region"));
    }
  });

  it("rejects oversized text and too many variants", () => {
    const { input } = singleRegionInput();
    const oversized = labelsFor(["front"]);
    oversized.regions["front"]!.originDescription = "x".repeat(2049);
    const first = buildPreparedProductFromAreaBundle(input, oversized, {
      expectedAssetSha256: SHA,
    });
    assert.equal(first.ok, false);
    if (!first.ok) assert.ok(first.errors.some((e) => e.code === "label-too-long"));

    const many = labelsFor(["front"]);
    many.variants = Array.from({ length: 65 }, (_, i) => ({ id: `V-${i}`, regionIds: ["front"] }));
    const second = buildPreparedProductFromAreaBundle(input, many, {
      expectedAssetSha256: SHA,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.ok(second.errors.some((e) => e.code === "too-many"));
  });

  it("rejects oversized bundle text and non-JSON-safe input", () => {
    const { input } = singleRegionInput();
    const padded = `${JSON.stringify({})}${" ".repeat(AREA_RESTORE_LIMITS.maxChars + 1)}`;
    void input;
    const first = buildPreparedProductFromAreaBundle(JSON.parse(padded), labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(first.ok, false);

    const base = mutableEnvelope(singleRegionInput().input);
    (base as Record<string, unknown>)["pendingReview"] = Number.NaN;
    const second = buildPreparedProductFromAreaBundle(base, labelsFor(["front"]), {
      expectedAssetSha256: SHA,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.ok(second.errors.some((e) => e.code === "bad-shape"));
  });

  it("rejects conflicting calibration notes across regions sharing one calibration", () => {
    const { input } = twoRegionInput();
    const labels = labelsFor(["front", "back"]);
    labels.regions["front"]!.calibrationDescription = "note one";
    labels.regions["back"]!.calibrationDescription = "note two";
    const result = buildPreparedProductFromAreaBundle(input, labels, {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((e) => e.code === "conflicting-label"));
  });

  it("folds a shared calibration note into the provisional description", () => {
    const { input } = twoRegionInput();
    const labels = labelsFor(["front", "back"]);
    labels.regions["front"]!.calibrationDescription = "synthetic bench check";
    labels.regions["back"]!.calibrationDescription = "synthetic bench check";
    const result = buildPreparedProductFromAreaBundle(input, labels, {
      expectedAssetSha256: SHA,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.product.calibrations[0]!.description ?? "", /synthetic bench check/);
    assert.match(result.product.calibrations[0]!.description ?? "", /never production-approved/);
  });
});
