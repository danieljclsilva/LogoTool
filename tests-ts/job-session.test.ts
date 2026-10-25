import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { contentDigest, newRevision } from "../src/core/index.js";
import type { ProjectDocument, Sha256HexFn } from "../src/core/index.js";
import {
  applyInstructionsUpdate,
  applyPlacementAdd,
  createEmptyJobMetadata,
  decodeJobSidecar,
  encodeJobSidecar,
  rebaseJobMetadata,
} from "../src/core/operator-job/index.js";
import type { AnchorDef } from "../src/core/operation-measurements/types.js";
import type { ProjectPackageAsset } from "../src/packaging/project-package/index.js";
import {
  applySessionAuthoring,
  captureSaveSnapshot,
  cleanSession,
  createEmptySession,
  emptyRecord,
  emptySelection,
  extrasToLogoTechnique,
  isSameSaveSession,
  rebaseSessionAuthoring,
  replaceSessionProject,
  resolveSessionBinding,
  sessionAuthoringFromMetadata,
  sessionDocumentInputs,
  snapshotSessionMetadata,
  techniqueToExtras,
  touchSession,
} from "../src/ui/internal-builder/job-session.js";

const sha256Hex: Sha256HexFn = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function makeProject(): ProjectDocument {
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "job-session-test",
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
        safeArea: [[0, 0], [200, 0], [200, 150], [0, 0]],
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

function filledSession() {
  const session = createEmptySession("job.logo-project", makeProject(), [], new Uint8Array([7]));
  session.instructions = "Sew flat, check twice.";
  session.technique = { temperature: "160", time: "10", pressure: "", colour: "red", thread: "" };
  session.bindings = {
    "cfg-m": [{
      logoRef: "place-1",
      anchorId: "a1",
      edge: "minX",
      convention: "dx",
      label: "centre to left edge",
    }],
  };
  session.logoTechnique = {
    "cfg-m": {
      "place-1": {
        businessCode: "B1",
        temperature: "",
        time: "",
        pressure: "",
        colour: "",
        thread: "",
      },
    },
  };
  session.anchors = [{ ...anchor }];
  session.selection = { productId: "polo", variantId: "m", viewId: null, placementId: "place-1" };
  return session;
}

const assets: ProjectPackageAsset[] = [];

describe("job session snapshot round-trip", () => {
  it("derives persisted metadata from the live fields and reinstalls it", () => {
    const session = filledSession();
    const metadata = snapshotSessionMetadata(
      session,
      { customer: "Acme", jobReference: "J-1", preparedBy: "Op" },
      { includedProducts: ["polo"], includedConfigurations: ["cfg-m"], logoIds: ["logo-a"] },
    );
    assert.equal(metadata.instructions, "Sew flat, check twice.");
    assert.equal(metadata.bindings.length, 1);
    assert.equal(metadata.bindings[0]!.status, "bound");
    assert.equal(metadata.anchors.length, 1);

    const rebased = rebaseJobMetadata(metadata, session.project.revision, contentDigest(session.project, sha256Hex));
    const bytes = encodeJobSidecar(rebased);
    const decoded = decodeJobSidecar(bytes);
    assert.ok(decoded !== null);

    const fresh = createEmptySession("reopened.logo-project", session.project, assets, new Uint8Array());
    applySessionAuthoring(fresh, sessionAuthoringFromMetadata(session.project, decoded));
    assert.equal(fresh.instructions, session.instructions);
    assert.deepEqual(fresh.technique, session.technique);
    assert.deepEqual(fresh.bindings["cfg-m"], session.bindings["cfg-m"]);
    assert.deepEqual(JSON.parse(JSON.stringify(fresh.logoTechnique)), JSON.parse(JSON.stringify(session.logoTechnique)));
    assert.deepEqual(fresh.anchors, session.anchors);
  });

  it("marks bindings unresolved when their scope is gone, without mutating the session", () => {
    const session = filledSession();
    const emptied = JSON.parse(JSON.stringify(makeProject())) as ProjectDocument;
    emptied.products[0]!.regions = [];
    const swapped = createEmptySession("x", emptied, assets, new Uint8Array());
    swapped.bindings = session.bindings;
    swapped.anchors = session.anchors;
    const metadata = snapshotSessionMetadata(swapped, {}, { includedProducts: [], includedConfigurations: [] });
    assert.equal(metadata.bindings[0]!.status, "unresolved");
    assert.match(metadata.bindings[0]!.unresolvedReason ?? "", /no longer on the product|no longer in the job/);
    // Live session untouched (still bound definitions).
    assert.equal(session.bindings["cfg-m"]!.length, 1);

    // Opening keeps only the bound live set; unresolved scope never invents measurements.
    const authoring = sessionAuthoringFromMetadata(emptied, {
      ...createEmptyJobMetadata(),
      bindings: metadata.bindings,
      anchors: session.anchors,
    });
    assert.deepEqual(Object.keys(authoring.bindings), []);
  });

  it("carries the job-wide technique through the reserved section and back", () => {
    const session = filledSession();
    const metadata = snapshotSessionMetadata(session, {}, { includedProducts: [], includedConfigurations: [] });
    const authoring = sessionAuthoringFromMetadata(session.project, metadata);
    assert.deepEqual(authoring.technique, session.technique);
    assert.equal(techniqueToExtras(authoring.technique).methodParams?.["temperature"], "160");
    assert.deepEqual(extrasToLogoTechnique({ businessCode: "B1" }).businessCode, "B1");
  });
});

describe("job session dirty/edit lifecycle", () => {
  it("touch marks dirty and advances the counter; clean keeps history", () => {
    const session = createEmptySession("job.logo-project", makeProject(), assets, new Uint8Array());
    assert.equal(session.dirty, false);
    assert.equal(session.editCounter, 0);
    touchSession(session);
    touchSession(session);
    assert.equal(session.dirty, true);
    assert.equal(session.editCounter, 2);
    cleanSession(session);
    assert.equal(session.dirty, false);
    assert.equal(session.editCounter, 2);
  });

  it("replaceSessionProject returns a new identity with refreshed summary and carried authoring", () => {
    const session = filledSession();
    touchSession(session);
    const next = applyPlacementAdd(
      session.project,
      "cfg-m",
      {
        id: "place-2",
        logoId: "logo-a",
        regionId: "chest",
        method: "print",
        pos: { xMm: 50, yMm: 50 },
        widthMm: 20,
        heightMm: 10,
        rotationDeg: 0,
      },
    ).project;
    const replaced = replaceSessionProject(session, next);
    // New identity: in-flight async staleness guards (`source !== snapshot`)
    // observe the project commit, exactly like the previous `source = {...}`.
    assert.notEqual(replaced, session);
    assert.equal(replaced.project.configurations[0]!.placements.length, 2);
    assert.equal(replaced.summary.configurationIds.length, 1);
    assert.equal(replaced.instructions, "Sew flat, check twice.");
    assert.deepEqual(replaced.selection, { productId: "polo", variantId: "m", viewId: null, placementId: "place-1" });
    assert.equal(replaced.dirty, true);
    assert.equal(replaced.editCounter, 1);
    // The previous session object is untouched (open-rollback holds it by reference).
    assert.equal(session.project.configurations[0]!.placements.length, 1);
  });

  it("instruction no-ops stay clean through the pure transaction helper", () => {
    const session = filledSession();
    const same = applyInstructionsUpdate(session.project, session.project.instructions);
    assert.equal(same.dirty, false);
    assert.equal(same.project, session.project);
  });

  it("sessions are independent records: authoring edits never leak across installs", () => {
    const session = filledSession();
    session.assets.push({ path: "logo-a.svg", bytes: new Uint8Array([1, 2, 3]), kind: "referenced" });
    const reopened = createEmptySession("reopened.logo-project", session.project, [], new Uint8Array());
    applySessionAuthoring(reopened, sessionAuthoringFromMetadata(session.project, snapshotSessionMetadata(
      session,
      {},
      { includedProducts: [], includedConfigurations: [] },
    )));
    reopened.instructions = "changed";
    reopened.bindings["cfg-m"]!.length = 0;
    reopened.anchors.length = 0;
    reopened.selection.productId = "other";
    assert.equal(session.instructions, "Sew flat, check twice.");
    assert.equal(session.bindings["cfg-m"]!.length, 1);
    assert.equal(session.anchors.length, 1);
    assert.equal(session.selection.productId, "polo");
  });

  it("resolveSessionBinding reports missing anchors instead of fabricating", () => {
    const session = filledSession();
    const missing = resolveSessionBinding(
      session.project,
      [],
      "cfg-m",
      session.bindings["cfg-m"]![0]!,
    );
    assert.ok("unresolved" in missing);
  });

  it("rebase keeps instructions while pruning dead anchors, bindings and technique", () => {
    const session = filledSession();
    const response = newRevision(session.project, (draft) => {
      draft.configurations[0]!.placements = [];
    });
    response.products[0]!.regions = [];
    response.products[0]!.variants[0]!.regionIds = [];
    rebaseSessionAuthoring(session, response);
    assert.equal(session.anchors.length, 0);
    assert.deepEqual(Object.keys(session.bindings), ["cfg-m"]);
    assert.deepEqual(Object.keys(session.logoTechnique), []);
    assert.equal(session.instructions, "Sew flat, check twice.");
    assert.equal(emptySelection().productId, "");
  });

  it("document inputs copy the live set so renderers cannot mutate it", () => {
    const session = filledSession();
    const inputs = sessionDocumentInputs(session);
    inputs.bindings["cfg-m"]!.length = 0;
    inputs.extras["cfg-m"] = {};
    assert.equal(session.bindings["cfg-m"]!.length, 1);
    assert.equal(Object.keys(session.logoTechnique).length, 1);
  });

  it("save snapshot freezes project/assets/counter so a stale save cannot mix sessions", () => {
    const sessionA = filledSession();
    touchSession(sessionA);
    const snap = captureSaveSnapshot(sessionA);
    // The live session moves on (edits + a project commit + a session swap).
    touchSession(sessionA);
    const sessionB = replaceSessionProject(sessionA, newRevision(sessionA.project, () => {}));
    assert.equal(isSameSaveSession(sessionA, snap), true);
    assert.equal(isSameSaveSession(sessionB, snap), false);
    assert.equal(snap.editCounter, 1);
    assert.equal(snap.project.revision, 1);
    assert.equal(snap.assets.length, 0);
    // Session B independently advances past the frozen counter: identity, not
    // the counter, distinguishes the save owner.
    touchSession(sessionB);
    assert.equal(sessionB.editCounter, 3);
    assert.equal(isSameSaveSession(sessionB, snap), false);
    // Coinciding counters must not clear another session's dirty state.
    const sessionC = createEmptySession("other.logo-project", makeProject(), [], new Uint8Array());
    touchSession(sessionC);
    assert.equal(sessionC.editCounter, snap.editCounter);
    assert.equal(isSameSaveSession(sessionC, snap) && sessionC.editCounter === snap.editCounter, false);
  });

  it("arbitrary IDs survive the session round-trip and unset keys stay absent", () => {
    const hostile = ["__proto__", "constructor", "toString"];
    // Unset keys on a fresh record read absent (never inherited members),
    // and spreading them stays a safe no-op.
    const empty = emptyRecord<unknown>();
    for (const id of hostile) {
      assert.equal(empty[id], undefined);
      const list = empty[id] as unknown[] | undefined;
      assert.deepEqual([...(list ?? [])], []);
    }
    // Nested assignment of an exact `__proto__` key keeps own data.
    const nested = emptyRecord<{ code: string }>();
    nested["__proto__"] = { code: "nested" };
    assert.deepEqual(Object.keys(nested), ["__proto__"]);
    assert.equal(nested["__proto__"]!.code, "nested");
    const project = makeProject();
    project.configurations = hostile.map((id) => ({
      id,
      productId: "polo",
      variantId: "m",
      placements: [{
        id: `place-${id}`,
        logoId: "logo-a",
        regionId: "chest",
        method: "embroider",
        pos: { xMm: 10, yMm: 10 },
        widthMm: 20,
        heightMm: 10,
        rotationDeg: 0,
      }],
    }));
    const session = createEmptySession("hostile.logo-project", project, [], new Uint8Array());
    session.anchors = [{ ...anchor }];
    for (const id of hostile) {
      session.bindings[id] = [{
        logoRef: `place-${id}`,
        anchorId: "a1",
        edge: "minX",
        convention: "dx",
        label: `binding ${id}`,
      }];
      session.logoTechnique[id] = {
        [`tech-${id}`]: {
          businessCode: `B-${id}`,
          temperature: "",
          time: "",
          pressure: "",
          colour: "",
          thread: "",
        },
      };
    }
    const metadata = snapshotSessionMetadata(
      session,
      {},
      { includedProducts: ["polo"], includedConfigurations: [...hostile] },
    );
    for (const binding of metadata.bindings) {
      assert.equal(binding.status, "bound");
    }
    // Deterministic persisted bytes carry every hostile key as own data.
    const rebased = rebaseJobMetadata(metadata, project.revision, contentDigest(project, sha256Hex));
    const parsed = decodeJobSidecar(encodeJobSidecar(rebased));
    assert.ok(parsed !== null);
    assert.deepEqual(Object.keys(parsed!.techniqueSettings).sort(), ["__proto__", "constructor", "toString"]);
    const reopened = createEmptySession("reopened.logo-project", project, [], new Uint8Array());
    applySessionAuthoring(reopened, sessionAuthoringFromMetadata(project, parsed!));
    for (const id of hostile) {
      assert.equal(reopened.bindings[id]!.length, 1);
      assert.equal(reopened.bindings[id]![0]!.label, `binding ${id}`);
      assert.equal(reopened.logoTechnique[id]![`tech-${id}`]!.businessCode, `B-${id}`);
    }
    const inputs = sessionDocumentInputs(reopened);
    const json = JSON.parse(JSON.stringify(inputs)) as {
      bindings: Record<string, unknown[]>;
      extras: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(json.bindings).sort(), ["__proto__", "constructor", "toString"]);
    assert.deepEqual(Object.keys(json.extras).sort(), ["__proto__", "constructor", "toString"]);
  });
});
