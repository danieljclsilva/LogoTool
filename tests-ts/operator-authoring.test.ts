import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { confirmRevision, contentDigest, newRevision } from "../src/core/index.js";
import type { ProjectDocument, Sha256HexFn } from "../src/core/index.js";
import { importCustomerReturn } from "../src/core/workflow.js";
import {
  createCustomerResponseAuthoringContext,
  createOperatorAuthoringContext,
  isAuthoringContext,
  sharedExportInputs,
} from "../src/core/operator-authoring/index.js";

const sha256Hex: Sha256HexFn = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function makeProject(): ProjectDocument {
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "authoring-test",
    revision: 1,
    products: [{
      schemaVersion: "0.1.0-provisional",
      id: "polo",
      name: "Polo shirt",
      kind: "upper-body",
      variants: [{ id: "m", name: "Medium", regionIds: ["chest"] }],
      regions: [{
        id: "chest",
        name: "Chest",
        frame: {
          frameId: "chest-frame",
          originDescription: "Centre of chest",
          axes: { xPositive: "wearer right", yPositive: "wearer up" },
        },
        calibrationRef: { calibrationId: "cal-1", version: "v1" },
        safeArea: [[0, 0], [200, 0], [200, 150], [0, 150]],
        allowedMethods: ["embroider", "print"],
      }],
      calibrations: [{ id: "cal-1", version: "v1" }],
    }],
    logos: [{
      schemaVersion: "0.1.0-provisional",
      id: "logo-a",
      name: "Logo A",
      assets: [{
        uri: "logo-a.svg",
        role: "reference",
        mediaType: "image/svg+xml",
        sha256Hex: "a".repeat(64),
      }],
    }],
    configurations: [{
      id: "cfg-m",
      productId: "polo",
      variantId: "m",
      placements: [{
        logoId: "logo-a",
        regionId: "chest",
        method: "embroider",
        pos: { xMm: 100, yMm: 75 },
        widthMm: 40,
        heightMm: 20,
        rotationDeg: 0,
      }],
    }],
  };
}

const tinyAssets = new Map<string, Uint8Array>([
  ["logo-a.svg", new Uint8Array([1, 2, 3])],
]);

describe("operator authoring context (local direct path)", () => {
  it("builds its candidate without any customer return", () => {
    const project = makeProject();
    const ctx = createOperatorAuthoringContext({
      project,
      assets: tinyAssets,
      identity: { customer: "Acme", jobReference: "J-1", preparedBy: "Op" },
      sha256Hex,
    });
    assert.equal(ctx.kind, "operator");
    assert.equal(ctx.candidate.status, "candidate-pending-review");
    assert.equal(ctx.digest, ctx.candidate.digest);
    assert.equal(ctx.digest, contentDigest(project, sha256Hex));
    assert.equal(ctx.candidate.configurations.length, 1);
    assert.equal(ctx.candidate.configurations[0]!.placements.length, 1);
    // No return/confirmation provenance is fabricated on the local path.
    assert.ok(!("baselineFileName" in ctx));
    assert.ok(!("returnFileName" in ctx));
    assert.ok(!("confirmation" in ctx));
    assert.equal(ctx.project.confirmation, undefined);
    assert.ok(isAuthoringContext(ctx));
  });

  it("snapshots the project instead of aliasing it", () => {
    const project = makeProject();
    const ctx = createOperatorAuthoringContext({ project, sha256Hex });
    project.configurations[0]!.placements.length = 0;
    assert.equal(ctx.project.configurations[0]!.placements.length, 1);
    assert.equal(ctx.candidate.configurations[0]!.placements.length, 1);
  });
});

describe("customer-response authoring context (validated boundary)", () => {
  function confirmedReturn(): { issued: ProjectDocument; moved: ProjectDocument } {
    const issued = makeProject();
    const moved = newRevision(issued, (draft) => {
      draft.configurations[0]!.placements[0]!.pos = { xMm: 110, yMm: 80 };
    });
    const digest = contentDigest(moved, sha256Hex);
    const confirmed = confirmRevision(
      moved,
      { confirmedBy: "synthetic-customer", confirmedAt: "2026-10-25T00:00:00.000Z", digestOf: digest },
      sha256Hex,
    );
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) throw new Error("fixture confirmation failed");
    return { issued, moved: confirmed.project };
  }

  it("wraps the genuine validated import result", () => {
    const { issued, moved } = confirmedReturn();
    const outcome = importCustomerReturn(moved, issued, sha256Hex);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error("fixture import failed");
    const ctx = createCustomerResponseAuthoringContext({
      importOutcome: outcome,
      issuedBaseline: issued,
      baselineFileName: "office-copy.logo-project",
      returnFileName: "customer-return.logo-project",
      assets: tinyAssets,
      sha256Hex,
    });
    assert.equal(ctx.kind, "customer-response");
    assert.equal(ctx.digest, ctx.candidate.digest);
    assert.equal(ctx.baselineDigest, contentDigest(issued, sha256Hex));
    assert.equal(ctx.baselineFileName, "office-copy.logo-project");
    assert.equal(ctx.returnFileName, "customer-return.logo-project");
    assert.equal(ctx.geometryOk, true);
    assert.equal(ctx.confirmation?.digest, contentDigest(moved, sha256Hex));
    assert.equal(ctx.candidate.configurations[0]!.placements[0]!.pos.xMm, 110);
    assert.ok(isAuthoringContext(ctx));
  });

  it("reports geometryOk false for a valid but non-fitting return", () => {
    const issued = makeProject();
    const moved = newRevision(issued, (draft) => {
      draft.configurations[0]!.placements[0]!.pos = { xMm: 900, yMm: 900 };
    });
    const digest = contentDigest(moved, sha256Hex);
    const confirmed = confirmRevision(
      moved,
      { confirmedBy: "synthetic-customer", digestOf: digest },
      sha256Hex,
    );
    assert.equal(confirmed.ok, true);
    if (!confirmed.ok) throw new Error("fixture confirmation failed");
    const outcome = importCustomerReturn(confirmed.project, issued, sha256Hex);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error("fixture import failed");
    const ctx = createCustomerResponseAuthoringContext({
      importOutcome: outcome,
      issuedBaseline: issued,
      baselineFileName: "office-copy.logo-project",
      returnFileName: "customer-return.logo-project",
      sha256Hex,
    });
    assert.equal(ctx.geometryOk, false);
    assert.equal(ctx.candidate.status, "candidate-pending-review");
  });

  it("rejects failed validation outcomes instead of importing them", () => {
    const issued = makeProject();
    const tampered = JSON.parse(JSON.stringify(makeProject())) as ProjectDocument;
    tampered.products[0]!.name = "Renamed polo";
    const outcome = importCustomerReturn(tampered, issued, sha256Hex);
    assert.equal(outcome.ok, false);
    assert.throws(
      () =>
        createCustomerResponseAuthoringContext({
          importOutcome: outcome,
          issuedBaseline: issued,
          baselineFileName: "office-copy.logo-project",
          returnFileName: "customer-return.logo-project",
          sha256Hex,
        }),
      /successful importCustomerReturn outcome/,
    );
  });
});

describe("shared export inputs", () => {
  it("returns the same { candidate, digest, referenceViews } shape for both kinds", () => {
    const project = makeProject();
    const operator = createOperatorAuthoringContext({ project, sha256Hex });
    const issued = makeProject();
    const outcome = importCustomerReturn(makeProject(), issued, sha256Hex);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) throw new Error("fixture import failed");
    const response = createCustomerResponseAuthoringContext({
      importOutcome: outcome,
      issuedBaseline: issued,
      baselineFileName: "office-copy.logo-project",
      returnFileName: "customer-return.logo-project",
      sha256Hex,
    });
    for (const ctx of [operator, response] as const) {
      const inputs = sharedExportInputs(ctx);
      assert.deepEqual(Object.keys(inputs).sort(), ["candidate", "digest", "referenceViews"]);
      assert.equal(inputs.digest, inputs.candidate.digest);
      assert.deepEqual(inputs.referenceViews, {});
    }
  });
});
