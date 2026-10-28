import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_NEW_REGION_METHODS,
  configurePlacementMethod,
  displayPlacementMethod,
  isKnownMethodKey,
  methodLabel,
  normalizeRegionMethods,
  supportedMethodKeys,
} from "../src/core/decoration-methods/index.js";
import {
  canRedoOperatorHistory,
  canUndoOperatorHistory,
  createEmptySession,
  createOperatorHistory,
  pushOperatorHistory,
  redoOperatorHistory,
  undoOperatorHistory,
} from "../src/ui/internal-builder/job-session.js";
import type { ProjectDocument } from "../src/core/index.js";

function makeProject(): ProjectDocument {
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "lead-history-test",
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
        allowedMethods: ["embroidery", "print"],
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
        method: "embroidery",
        pos: { xMm: 100, yMm: 75 },
        widthMm: 120,
        heightMm: 60,
        rotationDeg: 0,
      }],
    }],
  } as unknown as ProjectDocument;
}

describe("lead decoration catalogue", () => {
  it("exposes embroidery, heat-seal, print and other", () => {
    assert.deepEqual(supportedMethodKeys(), ["embroidery", "heat-seal", "print", "other"]);
    assert.ok((DEFAULT_NEW_REGION_METHODS as readonly string[]).includes("heat-seal"));
    assert.equal(methodLabel("heat-seal"), "Heat Seal");
    assert.equal(isKnownMethodKey("heat-seal"), true);
    assert.equal(isKnownMethodKey("glue"), false);
  });
  it("other requires a named method instead of inventing glue settings", () => {
    assert.equal(displayPlacementMethod("other"), "Other");
    assert.equal(displayPlacementMethod("other", "  Supplied Glue  "), "Other — Supplied Glue");
  });
  it("region permissions preserve order and dedupe without defaults", () => {
    assert.deepEqual(normalizeRegionMethods(["print", "embroidery", "print", "  ", 7]), ["print", "embroidery"]);
  });
});

describe("lead operator history", () => {
  it("one push one undo creates a new revision and clears redo on new edit", () => {
    const session = createEmptySession("f", makeProject(), [], new Uint8Array(0));
    const history = createOperatorHistory();
    assert.equal(canUndoOperatorHistory(history), false);
    pushOperatorHistory(history, session, "move");
    session.project.configurations[0]!.placements[0]!.widthMm = 999;
    const before = session.project.revision;
    assert.equal(undoOperatorHistory(history, session), true);
    assert.equal(session.project.configurations[0]!.placements[0]!.widthMm, 120);
    assert.ok(session.project.revision > before);
    assert.equal((session.project as { confirmation?: unknown }).confirmation, undefined);
    assert.equal(canRedoOperatorHistory(history), true);
    assert.equal(redoOperatorHistory(history, session), true);
    assert.equal(session.project.configurations[0]!.placements[0]!.widthMm, 999);
    pushOperatorHistory(history, session, "new-edit");
    assert.equal(canRedoOperatorHistory(history), false);
  });
});


describe("operator history setup integrity", () => {
  it("restores setup assets, dimensions and ID dictionaries atomically through undo/redo", () => {
    const project = makeProject();
    const session = createEmptySession("f", project, [{ path: "presentation/setup.json", bytes: new Uint8Array([1]), kind: "referenced" }], new Uint8Array(0));
    const history = createOperatorHistory();
    session.logoTechnique["__proto__"] = Object.create(null);
    pushOperatorHistory(history, session, "setup");
    session.assets = [{ path: "presentation/setup.json", bytes: new Uint8Array([2]), kind: "referenced" }];
    session.project.products[0]!.regions[0]!.safeArea = [[0, 0], [100, 0], [100, 80], [0, 80]];
    const editedArea = session.project.products[0]!.regions[0]!.safeArea;
    assert.equal(undoOperatorHistory(history, session), true);
    assert.equal(session.assets[0]!.bytes[0], 1);
    assert.equal(Object.getPrototypeOf(session.logoTechnique), null);
    assert.equal(Object.hasOwn(session.logoTechnique, "__proto__"), true);
    assert.equal(session.logoTechnique["constructor"], undefined);
    assert.equal(redoOperatorHistory(history, session), true);
    assert.equal(session.assets[0]!.bytes[0], 2);
    assert.deepEqual(session.project.products[0]!.regions[0]!.safeArea, editedArea);
    assert.ok(session.editCounter >= 2);
  });
  it("does not consume history if the revision cannot advance", () => {
    const session = createEmptySession("f", makeProject(), [], new Uint8Array(0));
    const history = createOperatorHistory();
    pushOperatorHistory(history, session, "edit");
    session.project.revision = Number.MAX_SAFE_INTEGER;
    assert.throws(() => undoOperatorHistory(history, session));
    assert.equal(history.past.length, 1);
    assert.equal(history.future.length, 0);
  });
  it("unknown method keys never resolve inherited object properties", () => {
    assert.equal(methodLabel("constructor"), "constructor");
    assert.equal(methodLabel("__proto__"), "__proto__");
  });
});


describe("explicit additional methods", () => {
  it("enables and selects Heat Seal without rewriting other methods or source", () => {
    const project = makeProject();
    const next = configurePlacementMethod(project, project.configurations[0]!.id, 0, "heat-seal");
    assert.deepEqual(project.products[0]!.regions[0]!.allowedMethods, ["embroidery", "print"]);
    assert.deepEqual(next.products[0]!.regions[0]!.allowedMethods, ["embroidery", "print", "heat-seal"]);
    assert.equal(next.configurations[0]!.placements[0]!.method, "heat-seal");
    assert.equal(next.revision, project.revision + 1);
  });
  it("stores an operator-supplied method name without inventing process settings", () => {
    const project = makeProject();
    const next = configurePlacementMethod(project, project.configurations[0]!.id, 0, "  Adhesive badge  ");
    assert.equal(next.configurations[0]!.placements[0]!.method, "Adhesive badge");
    assert.ok(next.products[0]!.regions[0]!.allowedMethods.includes("Adhesive badge"));
    assert.throws(() => configurePlacementMethod(project, project.configurations[0]!.id, 0, "Other"));
    assert.throws(() => configurePlacementMethod(project, project.configurations[0]!.id, 0, ""));
  });
});
