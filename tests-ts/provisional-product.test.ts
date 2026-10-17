import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProjectFromDefinitions } from "../src/core/project-builder/create-project.js";
import {
  createProvisionalProduct,
  isPreviewOnlyConfiguration,
  isPreviewOnlyProduct,
} from "../src/core/project-builder/provisional-product.js";
import { validateProduct, validateProject } from "../src/core/validate.js";

import type { ProductDefinition } from "../src/core/types.js";

function provisionalProject(product: ProductDefinition) {
  return {
    schemaVersion: product.schemaVersion,
    projectId: "PROV-PROJECT-1",
    synthetic: true,
    description: "provisional draft",
    revision: 1,
    products: [product],
    logos: [],
    configurations: [{
      id: "cfg-1",
      productId: product.id,
      variantId: product.variants[0]!.id,
      placements: [],
    }],
  };
}

describe("provisional-product: factory", () => {
  it("builds the all-empty preview-only shape with no invented measurements", () => {
    const first = createProvisionalProduct({ id: "PROV-001", name: "Jacket", kind: "upper-body" });
    const second = createProvisionalProduct({ id: "PROV-001", name: "Jacket", kind: "upper-body" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) throw new Error("expected ok");
    assert.deepEqual(first.product, second.product);
    assert.equal(first.product.variants.length, 1);
    assert.equal(first.product.variants[0]!.id, "PROV-001-default");
    assert.deepEqual(first.product.variants[0]!.regionIds, []);
    assert.deepEqual(first.product.regions, []);
    assert.deepEqual(first.product.calibrations, []);
    const text = JSON.stringify(first.product);
    assert.ok(!text.includes("CAL-UNCALIBRATED"), "no invented calibration ids");
    assert.ok(!text.includes("placeholder-region"), "no invented region ids");
    assert.ok(!text.includes("placeholder-frame"), "no invented frame ids");
    assert.ok(!text.includes("-50"), "no invented measurements");
    assert.ok(validateProduct(first.product).ok);
    assert.ok(validateProject(provisionalProject(first.product)).ok);
    assert.equal(isPreviewOnlyProduct(first.product), true);
  });

  it("detects preview-only structurally, never by name", () => {
    const made = createProvisionalProduct({ id: "PROV-STRUCT" });
    if (!made.ok) throw new Error("expected ok");
    assert.equal(isPreviewOnlyProduct(made.product), true);
    assert.equal(isPreviewOnlyProduct(null), false);
    assert.equal(isPreviewOnlyProduct({ regions: [], calibrations: [{ id: "C", version: "v1" }] }), false);
    assert.equal(isPreviewOnlyProduct({ regions: [], calibrations: [] }), true);
    // A calibrated-looking product whose name mentions "provisional" is NOT preview-only.
    const calibrated = JSON.parse(JSON.stringify(made.product)) as ProductDefinition;
    calibrated.name = "provisional uncalibrated preview-only showcase";
    assert.equal(isPreviewOnlyProduct({ ...calibrated, regions: [{ id: "r" }], calibrations: [] }), false);
    const project = provisionalProject(made.product);
    const configuration = project.configurations[0];
    assert.equal(isPreviewOnlyConfiguration(project, configuration), true);
    assert.equal(isPreviewOnlyConfiguration(project, { productId: "missing" }), false);
  });

  it("defaults name and kind deterministically", () => {
    const result = createProvisionalProduct({ id: "PROV-002" });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("expected ok");
    assert.equal(result.product.kind, "other");
    assert.ok((result.product.name ?? "").toLowerCase().includes("provisional"));
    assert.ok((result.product.name ?? "").toLowerCase().includes("uncalibrated"));
  });

  it("rejects bad ids and kinds, never throws, never mutates", () => {
    for (const bad of ["", " padded ", "x".repeat(257), 42, null, undefined]) {
      const result = createProvisionalProduct({ id: bad as unknown as string });
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("expected failure");
      assert.ok(result.errors.length > 0);
    }
    const kind = createProvisionalProduct({ id: "PROV-003", kind: "spaceship" as never });
    assert.equal(kind.ok, false);
    const frozen = Object.freeze({ id: "PROV-004", name: "N" });
    const made = createProvisionalProduct(frozen);
    assert.equal(made.ok, true);
    assert.deepEqual(frozen, { id: "PROV-004", name: "N" });
    const nonObject = createProvisionalProduct(null);
    assert.equal(nonObject.ok, false);
  });

  it("integrates with createProjectFromDefinitions as zero-placement valid", () => {
    const made = createProvisionalProduct({ id: "PROV-INT-1" });
    if (made.ok !== true) throw new Error("expected ok");
    const draft = createProjectFromDefinitions({ products: [made.product], projectId: "PROV-INT-PROJECT", synthetic: true });
    if (draft.ok !== true) throw new Error(`expected draft: ${JSON.stringify(draft.errors)}`);
    assert.equal(draft.project.configurations.length, 1);
    assert.deepEqual(draft.project.configurations[0]!.placements, []);
  });
});
