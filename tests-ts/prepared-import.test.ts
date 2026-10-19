import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitUniformScale } from "../src/core/calibration/index.js";
import {
  buildEvidence,
  snapshotEvidence,
} from "../src/core/calibration-session/index.js";
import { createPlanarRegion } from "../src/core/planar-region/index.js";
import {
  addExclusion,
  buildAreaBundle,
  serializeAreaBundle,
  setSafePolygon,
  type AreasMap,
} from "../src/core/region-areas/index.js";
import { appendPreparedProduct, parsePreparedImport, selectPreparedSidecarAssets, sidecarAssetPath, areaBundleAssetPath, preparedEvidencePaths, PREPARED_IMPORT_LIMITS } from "../src/core/project-builder/prepared-import.js";
import { BRIDGE_LIMITS, buildPreparedProductFromAreaBundle } from "../src/core/inspector-bridge/index.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildIssuedProject } from "../src/core/project-builder/index.js";
import { createProjectFromDefinitions } from "../src/core/project-builder/create-project.js";
import { validateProject } from "../src/core/validate.js";

const ASSET = "ab".repeat(32);
const CHEVRON = "[[0,0],[50,50],[100,0],[100,100],[0,100]]";
const HOLE = "[[10,10],[20,10],[20,20],[10,20]]";

function areaBundleInput(): unknown {
  const fields = {
    product: "synthetic-tee",
    variant: "M",
    calibrationId: "CAL-B1",
    frameId: "asset-root",
    provisionalVersion: "v1",
    toleranceMm: 0.5,
    relativeTolerance: 0.01,
    assetFullSha256: ASSET,
  };
  const anchors = [
    { id: "O", model: { x: 0, y: 0, z: 0 } },
    { id: "X", model: { x: 10, y: 0, z: 0 } },
    { id: "Y", model: { x: 3, y: 5, z: 0 } },
  ];
  const built = buildEvidence(fields, anchors, [{ a: "O", b: "X", distanceMm: 100 }]);
  assert.ok(built.ok);
  const ev = built.evidence;
  const fit = fitUniformScale(ev);
  const snap = snapshotEvidence(ev);
  const made = createPlanarRegion(
    { regionId: "R1", frameId: "F1", originAnchorId: "O", xAnchorId: "X", yAnchorId: "Y", offPlaneToleranceMm: 0.01 },
    anchors,
    ev,
    snap,
  );
  assert.ok(made.ok);
  let areas: AreasMap = {};
  const safe = setSafePolygon(areas, made.region, CHEVRON);
  assert.ok(safe.ok);
  areas = safe.areas;
  const hole = addExclusion(areas, made.region, "hole", "Hole", HOLE);
  assert.ok(hole.ok);
  areas = hole.areas;
  const bundle = buildAreaBundle(ev, fit, [made.region], areas, snap);
  assert.ok(bundle.ok);
  return JSON.parse(serializeAreaBundle(bundle.bundle));
}

function bridgeProduct() {
  const outcome = buildPreparedProductFromAreaBundle(areaBundleInput(), {
    product: { id: "P-B1", name: "Bridge Product", kind: "upper-body" },
    variants: [{ id: "P-B1-V1", name: "Default" }],
    regions: {
      R1: {
        name: "Chest",
        originDescription: "Synthetic datum at chest centre; +x right, +y up; mm.",
        axes: { xPositive: "right", yPositive: "up" },
        allowedMethods: ["embroidery"],
      },
    },
  }, { expectedAssetSha256: ASSET });
  if (!outcome.ok) throw new Error(`bridge failed: ${JSON.stringify(outcome.errors)}`);
  return outcome;
}

function emptyProject() {
  return JSON.parse(JSON.stringify({
    schemaVersion: "0.1.0-provisional",
    projectId: "TEST",
    revision: 1,
    products: [
      {
        schemaVersion: "0.1.0-provisional",
        id: "BASE",
        kind: "other",
        variants: [{ id: "BASE-V", regionIds: ["BASE-R"] }],
        regions: [
          {
            id: "BASE-R",
            frame: {
              frameId: "FRAME-BASE",
              originDescription: "Synthetic base datum; mm.",
              axes: { xPositive: "right", yPositive: "up" },
            },
            calibrationRef: { calibrationId: "CAL-BASE", version: "v1" },
            safeArea: [[0, 0], [10, 0], [10, 10]],
            allowedMethods: ["print"],
          },
        ],
        calibrations: [{ id: "CAL-BASE", version: "v1" }],
      },
    ],
    logos: [],
    configurations: [{ id: "base-config", productId: "BASE", variantId: "BASE-V", placements: [] }],
  }));
}

describe("prepared-import", () => {
  it("appends a bridge product with one zero-placement config per variant", () => {
    const { product, sidecar } = bridgeProduct();
    const outcome = appendPreparedProduct(emptyProject(), { product, sidecar });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error("append failed");
    assert.equal(outcome.project.products.length, 2);
    assert.equal(outcome.project.configurations.length, 2);
    const imported = outcome.project.configurations.find((config) => config.productId === "P-B1");
    assert.ok(imported !== undefined);
    assert.deepEqual(imported.placements, []);
    assert.equal(imported.variantId, "P-B1-V1");
    assert.equal(validateProject(outcome.project).ok, true);
  });

  it("accepts a bare product definition without envelope", () => {
    const { product } = bridgeProduct();
    const outcome = appendPreparedProduct(emptyProject(), JSON.parse(JSON.stringify(product)));
    assert.equal(outcome.ok, true);
  });

  it("rejects duplicate product ids", () => {
    const { product } = bridgeProduct();
    const first = appendPreparedProduct(emptyProject(), { product });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("setup failed");
    const second = appendPreparedProduct(first.project, { product });
    assert.equal(second.ok, false);
  });

  it("rejects products that fail validateProduct", () => {
    const outcome = appendPreparedProduct(emptyProject(), { id: "nope" });
    assert.equal(outcome.ok, false);
  });

  it("rejects regionless products", () => {
    const outcome = appendPreparedProduct(emptyProject(), {
      schemaVersion: "0.1.0-provisional",
      id: "EMPTY",
      kind: "other",
      variants: [{ id: "EMPTY-V", regionIds: [] }],
      regions: [],
      calibrations: [],
    });
    assert.equal(outcome.ok, false);
  });

  it("rejects hostile sidecars without throwing: cyclic, BigInt, non-finite", () => {
    const { product } = bridgeProduct();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicResult = parsePreparedImport({ product, sidecar: cyclic });
    assert.equal(cyclicResult.ok, false);
    const big = parsePreparedImport({ product, sidecar: { value: BigInt(10) } });
    assert.equal(big.ok, false);
    const nan = parsePreparedImport({ product, sidecar: { value: Number.NaN } });
    assert.equal(nan.ok, false);
    const good = appendPreparedProduct(emptyProject(), { product, sidecar: { note: "kept" } });
    assert.equal(good.ok, true);
    if (good.ok) assert.deepEqual(good.sidecar, { note: "kept" });
  });

  it("format-checks the evidence digest without verifying it (caller hashes)", () => {
    // Honest boundary: core accepts any well-formed hex digest, including one
    // that does not match the text. Cryptographic verification belongs to the
    // caller (the Builder hashes the exact packaged bytes and compares before
    // committing); core must never claim a match it did not compute.
    const { product } = bridgeProduct();
    const text = '{"schemaVersion":"0.1.0-provisional-region-areas","regions":[]}';
    const matching = parsePreparedImport({ product, areaBundleText: text, areaBundleSha256: "ab".repeat(32) });
    assert.equal(matching.ok, true);
    const mismatched = parsePreparedImport({ product, areaBundleText: text, areaBundleSha256: "ff".repeat(32) });
    assert.equal(mismatched.ok, true);
    if (mismatched.ok) {
      assert.equal(mismatched.areaBundleText, text);
      assert.equal(mismatched.areaBundleSha256, "ff".repeat(32));
    }
  });

  it("never mutates inputs", () => {
    const { product } = bridgeProduct();
    const base = emptyProject();
    const frozen = JSON.parse(JSON.stringify(base));
    const outcome = appendPreparedProduct(base, { product });
    assert.equal(outcome.ok, true);
    assert.deepEqual(base, frozen);
  });

  it("passes the original area-bundle export through verbatim as bounded evidence", () => {
    const { product, sidecar } = bridgeProduct();
    const text = '{"schemaVersion":"0.1.0-provisional-region-areas","regions":[]}';
    const sha = "ab".repeat(32);
    const outcome = appendPreparedProduct(emptyProject(), { product, sidecar, areaBundleText: text, areaBundleSha256: sha });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error("append failed");
    assert.equal(outcome.areaBundleText, text);
    assert.equal(outcome.areaBundleSha256, sha);
    const big = appendPreparedProduct(emptyProject(), { product, areaBundleText: `{"blob":"${"x".repeat(2 * 1024 * 1024)}"}`, areaBundleSha256: sha });
    assert.equal(big.ok, false);
    assert.equal(parsePreparedImport({ product, areaBundleText: "not json", areaBundleSha256: sha }).ok, false);
    assert.equal(parsePreparedImport({ product, areaBundleText: "[1,2]", areaBundleSha256: sha }).ok, false);
    assert.equal(parsePreparedImport({ product, areaBundleText: text }).ok, false);
    assert.equal(parsePreparedImport({ product, areaBundleText: text, areaBundleSha256: "xyz" }).ok, false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(parsePreparedImport({ product, sidecar: cyclic }).ok, false);
  });

  it("checked-in product fixture is genuine conversion output, not hand-authored", () => {
    const areaBundle = JSON.parse(readFileSync("e2e/fixtures/bridge-area-bundle.json", "utf8"));
    const labelsFile = JSON.parse(readFileSync("e2e/fixtures/bridge-labels.json", "utf8"));
    const expected = JSON.parse(readFileSync("e2e/fixtures/prepared-bridge-product.json", "utf8"));
    const outcome = buildPreparedProductFromAreaBundle(areaBundle, labelsFile.labels, {
      expectedAssetSha256: "ab".repeat(32),
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error("fixture conversion failed");
    assert.deepEqual(outcome.product, expected.product);
    assert.deepEqual(outcome.sidecar, expected.sidecar);
    assert.deepEqual(JSON.parse(expected.areaBundleText), areaBundle);
    assert.equal(
      createHash("sha256").update(expected.areaBundleText, "utf8").digest("hex"),
      expected.areaBundleSha256,
    );
  });

  it("bridge total-sidecar ceiling agrees with the intake bound", () => {
    assert.equal(BRIDGE_LIMITS.maxSidecarChars, PREPARED_IMPORT_LIMITS.maxSidecarChars);
    assert.ok(sidecarAssetPath("P-B1").endsWith(".bridge-sidecar.json"));
    assert.ok(areaBundleAssetPath("P-B1").endsWith(".area-bundle.json"));
    assert.deepEqual(preparedEvidencePaths("P-B1"), {
      sidecar: "prepared/p-b1.bridge-sidecar.json",
      areaBundle: "prepared/p-b1.area-bundle.json",
    });
  });

  it("selects sidecars by embedded product binding, sorted and deduplicated", () => {
    const { product, sidecar } = bridgeProduct();
    const text = JSON.stringify(sidecar);
    const entries = [
      { path: "prepared/other.bridge-sidecar.json", text: JSON.stringify({ labels: { product: { id: "OTHER" } } }) },
      { path: "prepared/b.bridge-sidecar.json", text },
      { path: "prepared/a.bridge-sidecar.json", text: "not json" },
      { path: "presentation/front.png", text },
      { path: "prepared/b.bridge-sidecar.json", text },
    ];
    const selected = selectPreparedSidecarAssets(entries, [{ productId: "P-B1" }, { productId: "OTHER" }]);
    assert.deepEqual(selected, [
      { path: "prepared/b.bridge-sidecar.json" },
      { path: "prepared/other.bridge-sidecar.json" },
    ]);
    assert.deepEqual(selectPreparedSidecarAssets(entries, [{ productId: "NONE" }]), []);
    assert.deepEqual(selectPreparedSidecarAssets([], [{ productId: "P-B1" }]), []);
    assert.ok(sidecarAssetPath("P-B1") === "prepared/p-b1.bridge-sidecar.json");
    assert.ok(sidecarAssetPath("  ") === "prepared/product.bridge-sidecar.json");
  });

  it("stale confirmation/review never survive re-issue after import", () => {
    const { product } = bridgeProduct();
    const base = emptyProject();
    base.confirmation = { revision: 1, digest: "ab".repeat(32), confirmedBy: "Someone", confirmedAt: "2026-01-01T00:00:00.000Z" };
    base.review = { revision: 1, digest: "ab".repeat(32), decision: "approved", reviewer: "R", at: "2026-01-01T00:00:00.000Z" };
    const appended = appendPreparedProduct(base, { product });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("setup failed");
    const issued = buildIssuedProject(
      appended.project,
      { productIds: ["BASE", "P-B1"], logoIds: [] },
      { customerLabel: "C", jobReference: "J", issuedBy: "I", projectId: "ISSUE-1" },
    );
    assert.equal(issued.ok, true);
    if (!issued.ok) throw new Error("issue failed");
    assert.equal(issued.project.revision, 1);
    assert.equal(issued.project.confirmation, undefined);
    assert.equal(issued.project.review, undefined);
    assert.equal(issued.project.reviewHistory, undefined);
  });

  it("imported product feeds createProjectFromDefinitions downstream", () => {
    const { product } = bridgeProduct();
    const appended = appendPreparedProduct(emptyProject(), { product });
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("setup failed");
    const draft = createProjectFromDefinitions({ products: appended.project.products, logos: [], projectId: "DOWN" });
    assert.equal(draft.ok, true);
  });
});
