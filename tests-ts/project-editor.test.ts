import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateProject, type ProjectDocument } from "../src/core/index.js";
import {
  addPlacement,
  assertProjectEditorLimits,
  evaluateProjectGeometry,
  placementSelector,
  PROJECT_EDITOR_LIMITS,
  removePlacement,
  setProjectInstructions,
  updatePlacement,
} from "../src/core/project-editor/index.js";
import type { Placement, PointMm } from "../src/core/types.js";

function readProject(name: string): ProjectDocument {
  const text = readFileSync(new URL(`../../examples/projects/${name}`, import.meta.url), "utf8");
  return JSON.parse(text) as ProjectDocument;
}

function cloneOf(project: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(project)) as ProjectDocument;
}

function geometryProject(): ProjectDocument {
  const project = readProject("project-multi.project.json");
  project.configurations[0]!.placements = [placement()];
  return project;
}

function placement(overrides: Partial<Placement> = {}): Placement {
  return {
    id: "editor-test-placement",
    logoId: "SYN-LOGO-A",
    regionId: "SYN-TEE-CHEST",
    method: "embroidery",
    pos: { xMm: 0, yMm: 0 },
    widthMm: 4,
    heightMm: 2,
    rotationDeg: 0,
    ...overrides,
  };
}


const CONFIGURATION_ID = "SYN-CFG-TEE-M";

describe("immutable project editor helpers", () => {
  it("adds, updates, and removes placements in the selected configuration immutably", () => {
    const original = readProject("project-multi.project.json");
    const before = cloneOf(original);
    const addedPlacement = placement({
      id: "editor-added",
      logoId: "SYN-LOGO-B",
      regionId: "SYN-TR-THIGH-L",
      method: "print",
      pos: { xMm: 1, yMm: 2 },
    });
    const added = addPlacement(original, "SYN-CFG-TR-REG", addedPlacement);

    assert.equal(added.revision, original.revision + 1);
    assert.equal(original.configurations[1]!.placements.length, 1);
    assert.equal(added.configurations[1]!.placements.length, 2);
    assert.notEqual(added.configurations[1]!.placements[1], addedPlacement);
    assert.notEqual(added.configurations[1]!.placements[1]!.pos, addedPlacement.pos);
    assert.deepEqual(original, before);
    assert.deepEqual(added.products, original.products);
    assert.deepEqual(added.logos, original.logos);

    addedPlacement.pos.xMm = 99;
    assert.equal(added.configurations[1]!.placements[1]!.pos.xMm, 1);

    const updated = updatePlacement(added, "SYN-CFG-TR-REG", placementSelector(added.configurations[1]!.placements[1]!, 1), {
      pos: { xMm: 3, yMm: 4 },
      instructions: "Synthetic adjustment",
    });
    assert.equal(updated.revision, added.revision + 1);
    assert.deepEqual(updated.configurations[1]!.placements[1]!.pos, { xMm: 3, yMm: 4 });
    assert.equal(updated.configurations[1]!.placements[1]!.instructions, "Synthetic adjustment");
    assert.deepEqual(added.configurations[1]!.placements[1]!.pos, { xMm: 1, yMm: 2 });
    assert.deepEqual(updated.products, added.products);

    const removed = removePlacement(updated, "SYN-CFG-TR-REG", placementSelector(updated.configurations[1]!.placements[1]!, 1));
    assert.equal(removed.revision, updated.revision + 1);
    assert.equal(removed.configurations[1]!.placements.length, 1);
    assert.equal(updated.configurations[1]!.placements.length, 2);
  });

  it("edits id-less placements through stable configuration-local index selectors", () => {
    const original = readProject("project-multi.project.json");
    const beforePos = { ...original.configurations[0]!.placements[0]!.pos };
    const updated = updatePlacement(original, CONFIGURATION_ID, placementSelector(original.configurations[0]!.placements[0]!, 0), {
      pos: { xMm: 12, yMm: 14 },
    });
    assert.deepEqual(updated.configurations[0]!.placements[0]!.pos, { xMm: 12, yMm: 14 });
    assert.deepEqual(original.configurations[0]!.placements[0]!.pos, beforePos);

    const removed = removePlacement(updated, CONFIGURATION_ID, placementSelector(updated.configurations[0]!.placements[1]!, 1));
    assert.equal(removed.configurations[0]!.placements.length, 1);
    assert.equal(updated.configurations[0]!.placements.length, 2);
  });

  it("distinguishes id-less indexes from reserved-looking and quoted valid IDs", () => {
    const project = geometryProject();
    const idless = placement({ pos: { xMm: 0, yMm: 0 } });
    delete idless.id;
    const reservedLooking = placement({ id: "@index:0", pos: { xMm: 5, yMm: 0 } });
    const quoted = placement({ id: "quote'\"\\backslash", pos: { xMm: 10, yMm: 0 } });
    project.configurations[0]!.placements = [idless, reservedLooking, quoted];

    const moveIdless = updatePlacement(project, CONFIGURATION_ID, placementSelector(idless, 0), { pos: { xMm: 1, yMm: 0 } });
    const moveReserved = updatePlacement(moveIdless, CONFIGURATION_ID, placementSelector(moveIdless.configurations[0]!.placements[1]!, 1), { pos: { xMm: 2, yMm: 0 } });
    const moveQuoted = updatePlacement(moveReserved, CONFIGURATION_ID, placementSelector(moveReserved.configurations[0]!.placements[2]!, 2), { pos: { xMm: 3, yMm: 0 } });
    assert.deepEqual(moveQuoted.configurations[0]!.placements.map((item) => item.pos.xMm), [1, 2, 3]);
    assert.equal(moveQuoted.configurations[0]!.placements[1]!.id, "@index:0");
    assert.equal(moveQuoted.configurations[0]!.placements[2]!.id, "quote'\"\\backslash");
    assert.deepEqual(evaluateProjectGeometry(moveQuoted).placements
      .filter((item) => item.configurationId === CONFIGURATION_ID)
      .map((item) => item.placementIndex), [0, 1, 2]);
  });

  it("returns the exact project object for no-op edits", () => {
    const project = readProject("project-multi.project.json");
    const first = project.configurations[0]!.placements[0]!;
    assert.equal(
      updatePlacement(project, CONFIGURATION_ID, placementSelector(first, 0), {
        pos: { ...first.pos },
        widthMm: first.widthMm,
      }),
      project,
    );
    assert.equal(updatePlacement(project, CONFIGURATION_ID, placementSelector(first, 0), { rotationDeg: -0 }), project);
    assert.equal(removePlacement(project, CONFIGURATION_ID, { kind: "id", id: "absent-placement" }), project);
    assert.equal(setProjectInstructions(project, project.instructions), project);
    assert.equal(project.revision, 3);
  });

  it("sets and clears project instructions as content revisions", () => {
    const project = readProject("project-empty.project.json");
    const updated = setProjectInstructions(project, "Synthetic customer request");
    assert.equal(updated.instructions, "Synthetic customer request");
    assert.equal(updated.revision, project.revision + 1);
    const cleared = setProjectInstructions(updated, undefined);
    assert.equal(Object.hasOwn(cleared, "instructions"), false);
    assert.equal(cleared.revision, updated.revision + 1);
    assert.deepEqual(project.instructions, "Synthetic fixture instructions: blank draft awaiting customer choices.");
  });

  it("routes mutations through newRevision approval invalidation and history", () => {
    const approved = readProject("project-multi.project.json");
    const oldConfirmation = approved.confirmation;
    const oldReview = approved.review;
    assert.ok(oldConfirmation);
    assert.ok(oldReview);

    const updated = setProjectInstructions(approved, "Updated synthetic instructions");
    assert.equal(updated.revision, approved.revision + 1);
    assert.equal(updated.confirmation, undefined);
    assert.equal(updated.review, undefined);
    assert.deepEqual(updated.history?.[0], oldConfirmation);
    assert.deepEqual(updated.reviewHistory?.[0], oldReview);
    assert.equal(approved.confirmation, oldConfirmation);
    assert.equal(approved.review, oldReview);
    assert.equal(validateProject(updated).ok, true);
  });

  it("retains zero-configuration and zero-placement projects", () => {
    const project = readProject("project-empty.project.json");
    assert.deepEqual(evaluateProjectGeometry(project), { ok: true, placements: [] });

    const noConfigurations = cloneOf(project);
    noConfigurations.configurations = [];
    assert.equal(validateProject(noConfigurations).ok, true);
    assert.deepEqual(evaluateProjectGeometry(noConfigurations), { ok: true, placements: [] });
    const editedWithoutConfigurations = setProjectInstructions(noConfigurations, "Synthetic zero-config draft");
    assert.equal(editedWithoutConfigurations.revision, noConfigurations.revision + 1);
    assert.equal(editedWithoutConfigurations.configurations.length, 0);
    assert.throws(() => addPlacement(noConfigurations, "missing", placement()), /unknown configuration/);

    const multi = readProject("project-multi.project.json");
    const geometry = evaluateProjectGeometry(multi);
    assert.equal(geometry.placements.length, 3);
    assert.equal(geometry.placements.every((entry) => entry.configurationId.length > 0), true);
  });

  it("rejects structurally invalid method and reference edits", () => {
    const project = readProject("project-multi.project.json");
    assert.throws(
      () => addPlacement(project, CONFIGURATION_ID, placement({ id: "bad-method", method: "laser" })),
      /unsupported-method/,
    );
    assert.throws(
      () => addPlacement(project, CONFIGURATION_ID, placement({ id: "bad-logo", logoId: "missing-logo" })),
      /dangling-ref/,
    );
  });
});

describe("project geometry verdicts", () => {
  it("checks the full rotated box against a concave safe-area notch", () => {
    const project = geometryProject();
    const region = project.products[0]!.regions.find((entry) => entry.id === "SYN-TEE-CHEST")!;
    region.safeArea = [
      [0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10],
    ];
    project.configurations[0]!.placements[0] = placement({
      pos: { xMm: 5, yMm: 3.5 },
      widthMm: 2,
      heightMm: 2,
    });

    assert.equal(validateProject(project).ok, true);
    const result = evaluateProjectGeometry(project);
    assert.equal(result.ok, false);
    assert.equal(result.placements[0]!.ok, false);
    assert.match(result.placements[0]!.reason, /safe region/);
  });

  it("rejects exclusion boundary touch and overlap", () => {
    for (const [label, xMm] of [["touch", 3], ["overlap", 3.5]] as const) {
      const project = geometryProject();
      const region = project.products[0]!.regions.find((entry) => entry.id === "SYN-TEE-CHEST")!;
      region.exclusions = [[[4, 4], [6, 4], [6, 6], [4, 6]]];
      project.configurations[0]!.placements[0] = placement({
        pos: { xMm, yMm: 5 },
        widthMm: 2,
        heightMm: label === "overlap" ? 1 : 2,
      });

      const result = evaluateProjectGeometry(project);
      assert.equal(result.ok, false, label);
      assert.equal(result.placements[0]!.ok, false, label);
      if (label === "touch") {
        assert.match(result.placements[0]!.reason, /touch|intersect/, label);
      } else {
        assert.match(result.placements[0]!.reason, /overlaps/, label);
      }
    }
  });

  it("uses clockwise-positive rotation for the physical footprint", () => {
    const project = geometryProject();
    const region = project.products[0]!.regions.find((entry) => entry.id === "SYN-TEE-CHEST")!;
    region.safeArea = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
    project.configurations[0]!.placements[0] = placement({
      widthMm: 4,
      heightMm: 2,
      rotationDeg: 90,
    });

    const result = evaluateProjectGeometry(project).placements[0]!;
    assert.equal(result.ok, true);
    const expected: PointMm[] = [[-1, 2], [-1, -2], [1, -2], [1, 2]];
    result.footprint.forEach(([x, y], index) => {
      assert.ok(Math.abs(x - expected[index]![0]) < 1e-12);
      assert.ok(Math.abs(y - expected[index]![1]) < 1e-12);
    });
    assert.deepEqual(result.centerMm, { xMm: 0, yMm: 0 });
    assert.deepEqual(result.frame, region.frame);
    assert.deepEqual(result.calibration, region.calibrationRef);
  });

  it("allows geometry-invalid drafts to be edited while reporting fit separately", () => {
    const project = geometryProject();
    const invalidDraft = updatePlacement(project, CONFIGURATION_ID, placementSelector(project.configurations[0]!.placements[0]!, 0), {
      pos: { xMm: 200, yMm: 200 },
    });
    assert.equal(validateProject(invalidDraft).ok, true);
    const result = evaluateProjectGeometry(invalidDraft);
    assert.equal(result.ok, false);
    assert.equal(result.placements[0]!.ok, false);
    assert.match(result.placements[0]!.reason, /outside|leaves/);
  });
  it("rejects over-budget geometry before evaluating every project region", () => {
    const project = geometryProject();
    const unusedRegion = project.products[1]!.regions[1]!;
    unusedRegion.safeArea = Array.from({ length: PROJECT_EDITOR_LIMITS.maxVerticesPerRing + 1 }, (_, index) => [index, index] as PointMm);
    assert.throws(() => evaluateProjectGeometry(project), /512-vertex/);

    const overCoordinate = geometryProject();
    overCoordinate.products[0]!.regions[0]!.safeArea[0]![0] = PROJECT_EDITOR_LIMITS.maxCoordinateMm + 1;
    assert.throws(() => assertProjectEditorLimits(overCoordinate), /runtime bounds/);

    const overDimension = geometryProject();
    overDimension.configurations[0]!.placements[0]!.widthMm = PROJECT_EDITOR_LIMITS.maxDimensionMm + 1;
    assert.throws(() => evaluateProjectGeometry(overDimension), /geometry runtime bounds/);
  });

  it("bounds repeated polygon work even when individual counts fit", () => {
    const project = geometryProject();
    const region = project.products[0]!.regions.find((entry) => entry.id === "SYN-TEE-CHEST")!;
    region.safeArea = Array.from({ length: 512 }, (_, index): PointMm => {
      const angle = index * Math.PI * 2 / 512;
      return [100 * Math.cos(angle), 100 * Math.sin(angle)];
    });
    project.configurations[0]!.placements = Array.from({ length: 32 }, (_, index) => placement({ id: `work-${index}` }));
    assert.throws(() => evaluateProjectGeometry(project), /combined geometry-work/);
    project.configurations[0]!.placements = [placement()];
    assertProjectEditorLimits(project);
    assert.equal(evaluateProjectGeometry(project).placements[0]!.ok, true);
  });

  it("rejects the placement-count boundary without mutating its source project", () => {
    const project = readProject("project-multi.project.json");
    project.configurations[0]!.placements = Array.from({ length: PROJECT_EDITOR_LIMITS.maxPlacements - 1 }, (_, index) => placement({ id: `budget-${index}` }));
    assertProjectEditorLimits(project);
    const revision = project.revision;
    assert.throws(
      () => addPlacement(project, CONFIGURATION_ID, placement({ id: "budget-overflow" })),
      /256 placements/,
    );
    assert.equal(project.configurations[0]!.placements.length, PROJECT_EDITOR_LIMITS.maxPlacements - 1);
    assert.equal(project.revision, revision);
  });
});
