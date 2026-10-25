import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  displayScopeTitle,
  displayVariantName,
} from "../src/core/operation-document/index.js";
import type { ProductDefinition } from "../src/core/index.js";

function product(names: Array<string | undefined>): ProductDefinition {
  return {
    schemaVersion: "0.1.0-provisional",
    id: "jacket",
    name: "Team jacket",
    kind: "upper-body",
    variants: names.map((name, index) => ({
      id: `variant-${index + 1}`,
      ...(name !== undefined ? { name } : {}),
      regionIds: [],
    })),
    regions: [],
    calibrations: [],
  };
}

describe("operator display labels (never raw variant ids)", () => {
  it("named variants keep their human names", () => {
    const item = product(["Crown", undefined]);
    assert.equal(displayVariantName(item, "variant-1"), "Crown");
    assert.equal(displayVariantName(item, "variant-2"), "Option 2");
    assert.equal(
      displayScopeTitle(item, "jacket", "variant-2"),
      "Team jacket / Option 2",
    );
  });

  it("a single unnamed variant collapses to the product name alone", () => {
    const item = product([undefined]);
    assert.equal(displayVariantName(item, "variant-1"), null);
    assert.equal(displayScopeTitle(item, "jacket", "variant-1"), "Team jacket");
  });

  it("unknown variants and missing products never leak ids", () => {
    const item = product(["Crown", "Sleeve"]);
    assert.equal(displayVariantName(item, "nope"), "Option 1");
    assert.equal(displayVariantName(undefined, "anything"), null);
    assert.equal(displayScopeTitle(undefined, "raw-id", "raw-variant"), "raw-id");
  });
});
