import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { contentDigest, newRevision } from "../src/core/index.js";
import type { ProjectDocument, Sha256HexFn } from "../src/core/index.js";
import {
  applyInstructionsUpdate,
  applyPlacementAdd,
  applyPlacementRemove,
  applyPlacementUpdate,
  createEmptyJobMetadata,
  decodeJobPackage,
  decodeJobSidecar,
  encodeJobPackage,
  encodeJobSidecar,
  isOperatorJobMetadata,
  isStaleJobMetadata,
  markDependentMeasurementsUnresolved,
  OPERATOR_JOB_SIDECAR_PATH,
  rebaseJobMetadata,
  toSheetBindings,
  type JobMeasurementBinding,
  type OperatorJobMetadata,
} from "../src/core/operator-job/index.js";
import type { AnchorDef } from "../src/core/operation-measurements/types.js";

const sha256Hex: Sha256HexFn = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function makeProject(): ProjectDocument {
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "job-test",
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
        id: "place-1",
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

const anchor: AnchorDef = {
  id: "a1",
  name: "Centre front",
  productId: "polo",
  variantId: "m",
  regionId: "chest",
  frameId: "chest-frame",
  calibrationId: "cal-1",
  calibrationVersion: "v1",
  posMm: [100, 140],
};

function boundBinding(): JobMeasurementBinding {
  return {
    configurationId: "cfg-m",
    productId: "polo",
    variantId: "m",
    regionId: "chest",
    frameId: "chest-frame",
    calibrationId: "cal-1",
    calibrationVersion: "v1",
    logoRef: "place-1",
    anchorId: "a1",
    edge: "minX",
    convention: "dx",
    label: "centre to left edge",
    status: "bound",
  };
}

function filledMetadata(): OperatorJobMetadata {
  return {
    ...createEmptyJobMetadata(),
    identity: { customer: "Acme", jobReference: "J-1", preparedBy: "Op" },
    inclusion: { includedProducts: ["polo"], includedConfigurations: ["cfg-m"] },
    instructions: "Sew flat, check twice.",
    techniqueSettings: { "cfg-m": { "place-1": { businessCode: "B1" } } },
    anchors: [anchor],
    bindings: [boundBinding()],
  };
}

describe("operator job sidecar round-trip", () => {
  it("encodes and reopens metadata with no invented measurements", () => {
    const project = makeProject();
    const digest = contentDigest(project, sha256Hex);
    const rebased = rebaseJobMetadata(filledMetadata(), project.revision, digest);
    assert.equal(isStaleJobMetadata(rebased, digest, project.revision), false);

    const bytes = encodeJobSidecar(rebased);
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 0);
    // Deterministic: repeated encoding is byte-identical.
    assert.deepEqual(encodeJobSidecar(rebased), bytes);

    const parsed = decodeJobSidecar(bytes);
    assert.ok(isOperatorJobMetadata(parsed));
    assert.deepEqual(parsed, rebased);

    const { referencedAssets, additionalAssets } = encodeJobPackage({
      assets: new Map([["logo-a.svg", new Uint8Array([9, 9])]]),
      metadata: rebased,
    });
    assert.deepEqual(referencedAssets.map((entry) => entry.path), ["logo-a.svg"]);
    assert.deepEqual(additionalAssets.map((entry) => entry.path), [OPERATOR_JOB_SIDECAR_PATH]);

    const reopened = decodeJobPackage({
      project,
      sidecarBytes: additionalAssets[0]!.bytes,
      sha256Hex,
    });
    assert.deepEqual(reopened.metadata, rebased);
    assert.deepEqual(reopened.warnings, []);
    assert.equal(reopened.metadata.bindings[0]!.status, "bound");
  });

  it("refuses to encode structurally invalid metadata", () => {
    const broken = filledMetadata() as unknown as Record<string, unknown>;
    broken["version"] = "operator-job/99";
    assert.throws(
      () => encodeJobSidecar(broken as unknown as OperatorJobMetadata),
      /structurally invalid/,
    );
  });
});

describe("legacy job files without a sidecar", () => {
  it("opens with empty metadata and never invented measurements", () => {
    const project = makeProject();
    const reopened = decodeJobPackage({ project });
    assert.deepEqual(reopened.metadata, createEmptyJobMetadata());
    assert.deepEqual(reopened.metadata.bindings, []);
    assert.deepEqual(reopened.metadata.anchors, []);
    assert.ok(reopened.warnings.length >= 1);
    assert.match(reopened.warnings.join(" "), /no operator job sidecar/i);
  });

  it("opens malformed sidecars with empty metadata, not guessed content", () => {
    const project = makeProject();
    const reopened = decodeJobPackage({
      project,
      sidecarBytes: new Uint8Array([123, 1, 2, 3]),
      sha256Hex,
    });
    assert.deepEqual(reopened.metadata, createEmptyJobMetadata());
    assert.ok(reopened.warnings.length >= 1);
  });
});

describe("markDependentMeasurementsUnresolved", () => {
  it("marks bindings unresolved when their region is removed, without mutating input", () => {
    const metadata = rebaseJobMetadata(filledMetadata(), 1, "d".repeat(64));
    const scopeRemoved = JSON.parse(JSON.stringify(makeProject())) as ProjectDocument;
    scopeRemoved.products[0]!.regions = [];
    const { metadata: marked, newlyUnresolved } = markDependentMeasurementsUnresolved(
      metadata,
      scopeRemoved,
    );
    assert.equal(marked.bindings[0]!.status, "unresolved");
    assert.match(marked.bindings[0]!.unresolvedReason ?? "", /region "chest"/);
    assert.equal(newlyUnresolved.length, 1);
    // Input untouched.
    assert.equal(metadata.bindings[0]!.status, "bound");
    assert.equal(metadata.bindings[0]!.unresolvedReason, undefined);
  });

  it("marks bindings unresolved when their placement is removed", () => {
    const project = makeProject();
    const metadata = rebaseJobMetadata(
      filledMetadata(),
      project.revision,
      contentDigest(project, sha256Hex),
    );
    const emptied = newRevision(project, (draft) => {
      draft.configurations[0]!.placements = [];
    });
    const { metadata: marked, newlyUnresolved } = markDependentMeasurementsUnresolved(
      metadata,
      emptied,
    );
    assert.equal(marked.bindings[0]!.status, "unresolved");
    assert.match(newlyUnresolved[0] ?? "", /placement "place-1"/);
  });

  it("keeps already-unresolved bindings and their recorded reasons", () => {
    const metadata = filledMetadata();
    metadata.bindings[0]!.status = "unresolved";
    metadata.bindings[0]!.unresolvedReason = "earlier scope change";
    const { metadata: marked, newlyUnresolved } = markDependentMeasurementsUnresolved(
      metadata,
      makeProject(),
    );
    assert.equal(marked.bindings[0]!.status, "unresolved");
    assert.equal(marked.bindings[0]!.unresolvedReason, "earlier scope change");
    assert.deepEqual(newlyUnresolved, []);
  });

  it("exposes only bound bindings as sheet inputs", () => {
    const metadata = filledMetadata();
    const scopeRemoved = JSON.parse(JSON.stringify(makeProject())) as ProjectDocument;
    scopeRemoved.products[0]!.regions = [];
    const { metadata: marked } = markDependentMeasurementsUnresolved(metadata, scopeRemoved);
    assert.deepEqual(toSheetBindings(marked), {});
    const sheetBindings = toSheetBindings(metadata);
    assert.deepEqual(Object.keys(sheetBindings), ["cfg-m"]);
    assert.equal(sheetBindings["cfg-m"]![0]!.logoRef, "place-1");
  });
});

describe("dirty-transaction helpers (one Apply = one revision; no-op stays no-op)", () => {
  it("update: identical patch is a no-op, changed patch is one revision", () => {
    const project = makeProject();
    const same = applyPlacementUpdate(
      project,
      "cfg-m",
      { kind: "id", id: "place-1" },
      { pos: { xMm: 100, yMm: 75 } },
    );
    assert.equal(same.dirty, false);
    assert.equal(same.project, project);

    const changed = applyPlacementUpdate(
      project,
      "cfg-m",
      { kind: "id", id: "place-1" },
      { pos: { xMm: 101, yMm: 76 }, widthMm: 41 },
    );
    assert.equal(changed.dirty, true);
    assert.equal(changed.project.revision, project.revision + 1);
    assert.deepEqual(changed.project.configurations[0]!.placements[0]!.pos, { xMm: 101, yMm: 76 });
    // Original untouched (immutable editor semantics preserved).
    assert.deepEqual(project.configurations[0]!.placements[0]!.pos, { xMm: 100, yMm: 75 });
  });

  it("remove: absent selector is a no-op; present selector removes once", () => {
    const project = makeProject();
    const missed = applyPlacementRemove(project, "cfg-m", { kind: "id", id: "missing" });
    assert.equal(missed.dirty, false);
    assert.equal(missed.project, project);
    assert.equal(missed.value, false);

    const hit = applyPlacementRemove(project, "cfg-m", { kind: "id", id: "place-1" });
    assert.equal(hit.dirty, true);
    assert.equal(hit.value, true);
    assert.equal(hit.project.revision, project.revision + 1);
    assert.deepEqual(hit.project.configurations[0]!.placements, []);
  });

  it("add and instructions follow the same transaction contract", () => {
    const project = makeProject();
    const added = applyPlacementAdd(project, "cfg-m", {
      id: "place-2",
      logoId: "logo-a",
      regionId: "chest",
      method: "print",
      pos: { xMm: 50, yMm: 50 },
      widthMm: 20,
      heightMm: 10,
      rotationDeg: 0,
    });
    assert.equal(added.dirty, true);
    assert.equal(added.project.revision, project.revision + 1);
    assert.equal(added.project.configurations[0]!.placements.length, 2);

    const sameText = applyInstructionsUpdate(project, project.instructions);
    assert.equal(sameText.dirty, false);
    assert.equal(sameText.project, project);

    const changedText = applyInstructionsUpdate(added.project, "New staff note.");
    assert.equal(changedText.dirty, true);
    assert.equal(changedText.project.revision, added.project.revision + 1);
    assert.equal(changedText.project.instructions, "New staff note.");
  });
});
