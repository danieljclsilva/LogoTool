import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateProject,
  type ProjectDocument,
} from "../src/core/index.js";
import { evaluateProjectGeometry } from "../src/core/project-editor/index.js";

/**
 * Unconfigured regions (lead-owned): a calibrated region may carry
 * `safeArea: []` — no safe polygon invented. Nothing fits until the operator
 * draws it; the all-or-nothing preview-only invariant is unaffected.
 */
function readProject(): ProjectDocument {
  const text = readFileSync(
    new URL("../../examples/projects/project-multi.project.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as ProjectDocument;
}

function firstRegion(project: ProjectDocument) {
  const region = project.products[0]!.regions[0]!;
  assert.ok(region.safeArea.length >= 3, "fixture region starts configured");
  return region;
}

describe("unconfigured region safe areas", () => {
  it("validateProject accepts safeArea [] with calibration and variant linkage", () => {
    const project = readProject();
    firstRegion(project).safeArea = [];
    const result = validateProject(project);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("validateProject still rejects 1- and 2-point safe areas", () => {
    for (const points of [[[0, 0]], [[0, 0], [10, 0]]] as [number, number][][]) {
      const project = readProject();
      firstRegion(project).safeArea = points;
      const result = validateProject(project);
      assert.equal(result.ok, false);
      assert.ok(
        result.errors.some((entry) => entry.code === "bad-safe-area" || entry.code === "schema-reject"),
        JSON.stringify(result.errors),
      );
    }
  });

  it("preview-only invariant is intact: all-empty passes, calibrations-only fails", () => {
    const empty = readProject();
    for (const product of empty.products) {
      product.regions = [];
      product.calibrations = [];
      for (const variant of product.variants) {
        variant.regionIds = [];
        (variant as { placementOverrides?: unknown }).placementOverrides = [];
      }
    }
    empty.configurations = [];
    assert.equal(validateProject(empty).ok, true, "all-empty stays preview-only");

    const partial = readProject();
    const product = partial.products[0]!;
    product.regions = [];
    for (const variant of product.variants) {
      variant.regionIds = [];
      (variant as { placementOverrides?: unknown }).placementOverrides = [];
    }
    partial.configurations = [];
    const result = validateProject(partial);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((entry) => entry.code === "preview-only-shape"),
      JSON.stringify(result.errors),
    );
  });

  it("geometry evaluation reports fits:false (never throws) for placements in [] regions", () => {
    const project = readProject();
    const region = firstRegion(project);
    region.safeArea = [];
    const result = evaluateProjectGeometry(project);
    const scoped = result.placements.filter(
      (entry) => entry.frame.frameId === region.frame.frameId,
    );
    assert.ok(scoped.length > 0, "fixture has placements in the first region");
    for (const entry of scoped) {
      assert.equal(entry.ok, false);
    }
  });

  it("limits accept empty rings without throwing", async () => {
    const { assertProjectEditorLimits } = await import("../src/core/project-editor/index.js");
    const project = readProject();
    firstRegion(project).safeArea = [];
    assertProjectEditorLimits(project);
  });
});
