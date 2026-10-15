import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { buildCandidateExport } from "../src/core/index.js";
import type { ProjectDocument, Region, Sha256HexFn } from "../src/core/index.js";
import { buildOperationDocument } from "../src/core/operation-document/index.js";

const sha256Text: Sha256HexFn = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function makeChestRegion(extra?: Partial<Region>): Region {
  return {
    id: "chest",
    name: "Chest",
    frame: {
      frameId: "chest-frame",
      originDescription: "Centre of chest",
      axes: { xPositive: "wearer right", yPositive: "wearer up" },
    },
    calibrationRef: { calibrationId: "cal-1", version: "v1" },
    safeArea: [
      [0, 0],
      [200, 0],
      [200, 150],
      [0, 150],
    ],
    allowedMethods: ["embroider", "print"],
    ...extra,
  };
}

function makeProject(): ProjectDocument {
  const region = makeChestRegion();
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "opdoc-test",
    revision: 1,
    products: [{
      schemaVersion: "0.1.0-provisional",
      id: "polo",
      name: "Polo shirt",
      kind: "upper-body",
      variants: [
        { id: "m", name: "Medium", regionIds: ["chest"] },
        { id: "l", name: "Large", regionIds: ["chest"] },
      ],
      regions: [region],
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
    configurations: [
      {
        id: "cfg-m",
        productId: "polo",
        variantId: "m",
        placements: [{
          logoId: "logo-a",
          regionId: "chest",
          method: "embroider",
          pos: { xMm: 100, yMm: 75 },
          widthMm: 60,
          heightMm: 40,
          rotationDeg: 30,
        }],
      },
      {
        id: "cfg-l",
        productId: "polo",
        variantId: "l",
        placements: [],
      },
    ],
  };
}

describe("buildOperationDocument", () => {
  it("produces identity from candidate and optional review evidence", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({
      candidate,
      generatedAt: "2026-10-15T10:00:00.000Z",
      customerConfirmation: "Confirmed by Synthetic customer",
      internalReview: "approved by reviewer (workflow only)",
    });

    assert.equal(doc.identity.projectId, project.projectId);
    assert.equal(doc.identity.revision, project.revision);
    assert.equal(doc.identity.digest, candidate.digest);
    assert.equal(doc.identity.schemaVersion, "0.1.0-provisional");
    assert.equal(doc.identity.reviewStatus, "candidate-pending-review");
    assert.equal(doc.identity.generatedAt, "2026-10-15T10:00:00.000Z");
    assert.equal(doc.identity.customerConfirmation, "Confirmed by Synthetic customer");
    assert.equal(doc.identity.internalReview, "approved by reviewer (workflow only)");
    assert.ok(doc.identity.calibrationStatus.includes("unresolved"));
  });

  it("omits generatedAt and review evidence when not supplied", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    assert.equal(doc.identity.generatedAt, undefined);
    assert.equal(doc.identity.customerConfirmation, undefined);
    assert.equal(doc.identity.internalReview, undefined);
  });

  it("lists required limitations", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    const text = doc.limitations.join(" ");
    assert.ok(text.includes("Illustrative"));
    assert.ok(text.includes("not to scale"));
    assert.ok(text.includes("footprints only"));
    assert.ok(text.includes("Product views"));
    assert.ok(text.includes("Calibration"));
    assert.ok(text.includes("candidate-pending-review"));
  });

  it("preserves all configurations including zero placements", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    assert.equal(doc.configurations.length, 2);
    const cfg0 = doc.configurations[0]!;
    const cfg1 = doc.configurations[1]!;
    assert.equal(cfg0.id, "cfg-m");
    assert.equal(cfg0.placements.length, 1);
    assert.equal(cfg1.id, "cfg-l");
    assert.equal(cfg1.placements.length, 0);
  });

  it("keeps exact unrounded mm dimensions and consistent 1-based numbering", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    const placement = doc.configurations[0]!.placements[0]!;
    assert.equal(placement.displayIndex, 1);
    assert.equal(placement.pos.xMm, 100);
    assert.equal(placement.pos.yMm, 75);
    assert.equal(placement.widthMm, 60);
    assert.equal(placement.heightMm, 40);
    assert.equal(placement.rotationDeg, 30);
  });

  it("computes rotated footprint and non-empty diagram viewBox", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    const placement = doc.configurations[0]!.placements[0]!;
    assert.equal(placement.diagram.footprint.length, 4);
    assert.ok(placement.diagram.viewBox.width > 0);
    assert.ok(placement.diagram.viewBox.height > 0);
    assert.equal(placement.diagram.safePolygon.length, 4);
  });

  it("maps exclusion polygons and axes labels from the region", () => {
    const region = makeChestRegion({
      exclusions: [
        [
          [50, 50],
          [80, 50],
          [80, 80],
          [50, 80],
        ],
      ],
    });
    const project: ProjectDocument = {
      schemaVersion: "0.1.0-provisional",
      projectId: "opdoc-exclusions",
      revision: 1,
      products: [{
        schemaVersion: "0.1.0-provisional",
        id: "polo",
        name: "Polo shirt",
        kind: "upper-body",
        variants: [{ id: "m", name: "Medium", regionIds: ["chest"] }],
        regions: [region],
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
          widthMm: 60,
          heightMm: 40,
          rotationDeg: 30,
        }],
      }],
    };
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    const placement = doc.configurations[0]!.placements[0]!;
    assert.equal(placement.diagram.exclusions.length, 1);
    assert.equal(placement.diagram.exclusions[0]!.polygon.length, 4);
    assert.equal(placement.diagram.axes.xLabel, "wearer right");
    assert.equal(placement.diagram.axes.yLabel, "wearer up");
  });
  it("keeps true datum and exclusions inside the diagram and rotates clockwise in physical Y-up", () => {
    const project = makeProject();
    project.products[0]!.regions[0]!.safeArea = [[100,100], [300,100], [300,300], [100,300]];
    project.products[0]!.regions[0]!.exclusions = [[[400,400], [410,400], [410,410], [400,410]]];
    const placement = project.configurations[0]!.placements[0]!;
    placement.pos = { xMm: 150.123456789, yMm: 175.987654321 };
    placement.widthMm = 60.123456789;
    placement.rotationDeg = 90;
    const candidate = buildCandidateExport(project, sha256Text);
    const original = JSON.stringify(candidate);
    const doc = buildOperationDocument({ candidate });
    assert.equal(JSON.stringify(candidate), original);
    assert.deepEqual(doc, buildOperationDocument({ candidate }));
    const result = doc.configurations[0]!.placements[0]!;
    assert.equal(result.widthMm, 60.123456789);
    assert.equal(result.diagram.axes.originX, 0);
    assert.equal(result.diagram.axes.originY, 0);
    const corner = result.diagram.footprint[0]!;
    assert.ok(Math.abs(corner.x - (placement.pos.xMm - placement.heightMm / 2)) < 1e-10);
    assert.ok(Math.abs(corner.y - (placement.pos.yMm + placement.widthMm / 2)) < 1e-10);
    const box = result.diagram.viewBox;
    assert.ok(box.minX < 0 && box.minY < 0);
    assert.ok(box.minX + box.width > 410 && box.minY + box.height > 410);
  });

});
