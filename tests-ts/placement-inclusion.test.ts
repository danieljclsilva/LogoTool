import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PLACEMENT_INCLUSION_UNAVAILABLE_MESSAGE,
  isPlacementCreationAllowed,
  readInclusionScopeOrThrow,
  summarizeOmittedPlacements,
  type PlacementInclusionScope,
} from "../src/ui/internal-builder/placement-inclusion.js";
import type {
  Configuration,
  Placement,
  ProductDefinition,
  ProductVariant,
  ProjectDocument,
} from "../src/core/types.js";

const SCHEMA_VERSION = "0.1.0-provisional" as const;

function makeVariant(id: string, name?: string): ProductVariant {
  return name === undefined
    ? { id, regionIds: ["front"] }
    : { id, name, regionIds: ["front"] };
}

function makeProduct(id: string, name: string, variants: ProductVariant[]): ProductDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    kind: "upper-body",
    variants,
    regions: [],
    calibrations: [],
  };
}

function makePlacement(id: string): Placement {
  return {
    id,
    logoId: "crest",
    regionId: "front",
    method: "print",
    pos: { xMm: 50, yMm: 50 },
    widthMm: 20,
    heightMm: 10,
    rotationDeg: 0,
  };
}

function makeConfiguration(
  id: string,
  productId: string,
  variantId: string,
  placementCount: number,
): Configuration {
  const placements: Placement[] = [];
  for (let index = 0; index < placementCount; index += 1) {
    placements.push(makePlacement(`${id}-p${index + 1}`));
  }
  return { id, productId, variantId, placements };
}

function makeProject(
  products: ProductDefinition[],
  configurations: Configuration[],
): ProjectDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "inclusion-job",
    revision: 1,
    products,
    logos: [],
    configurations,
  };
}

/** Two products, three options: A/Small holds 2, A/Large holds 0, B/Medium holds 2. */
function twoProductJob(): ProjectDocument {
  const tee = makeProduct("product-a", "Tee", [
    makeVariant("variant-a1", "Small"),
    makeVariant("variant-a2", "Large"),
  ]);
  const hoodie = makeProduct("product-b", "Hoodie", [makeVariant("variant-b1", "Medium")]);
  return makeProject(
    [tee, hoodie],
    [
      makeConfiguration("cfg-a1", "product-a", "variant-a1", 2),
      makeConfiguration("cfg-a2", "product-a", "variant-a2", 0),
      makeConfiguration("cfg-b1", "product-b", "variant-b1", 2),
    ],
  );
}

describe("isPlacementCreationAllowed", () => {
  const scope: PlacementInclusionScope = {
    productIds: ["product-a", "product-b"],
    configurationIds: ["cfg-a1", "cfg-a2"],
  };

  it("allows an included product and option", () => {
    assert.equal(isPlacementCreationAllowed("product-a", "cfg-a1", scope), true);
  });

  it("blocks an excluded product even when the option id is listed", () => {
    const listedElsewhere: PlacementInclusionScope = {
      productIds: ["product-a"],
      configurationIds: ["cfg-a1", "cfg-b1"],
    };
    assert.equal(isPlacementCreationAllowed("product-b", "cfg-b1", listedElsewhere), false);
  });

  it("blocks an excluded option while its product stays included", () => {
    assert.equal(isPlacementCreationAllowed("product-b", "cfg-b1", scope), false);
  });

  it("blocks everything when the scope is present but empty", () => {
    const empty: PlacementInclusionScope = { productIds: [], configurationIds: [] };
    assert.equal(isPlacementCreationAllowed("product-a", "cfg-a1", empty), false);
  });

  it("treats null and undefined scopes as unrestricted legacy callers", () => {
    assert.equal(isPlacementCreationAllowed("product-a", "cfg-a1", null), true);
    assert.equal(isPlacementCreationAllowed("product-a", "cfg-a1", undefined), true);
  });
});

describe("readInclusionScopeOrThrow", () => {
  it("passes a resolved scope through untouched", () => {
    const scope: PlacementInclusionScope = {
      productIds: ["product-a"],
      configurationIds: ["cfg-a1"],
    };
    assert.equal(readInclusionScopeOrThrow(() => scope), scope);
  });

  it("passes a null (unrestricted) scope through", () => {
    assert.equal(readInclusionScopeOrThrow(() => null), null);
  });

  it("throws the shared unavailable message when the reader throws", () => {
    assert.throws(
      () =>
        readInclusionScopeOrThrow(() => {
          throw new Error("storage offline");
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === PLACEMENT_INCLUSION_UNAVAILABLE_MESSAGE,
    );
  });
});

describe("summarizeOmittedPlacements", () => {
  it("reports one group per omitted option holding placements", () => {
    const groups = summarizeOmittedPlacements(twoProductJob(), ["cfg-a1", "cfg-a2"]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0], {
      productId: "product-b",
      productName: "Hoodie",
      variantId: "variant-b1",
      optionName: "Medium",
      placementCount: 2,
    });
  });

  it("is option-accurate when the product is included but one variant is omitted", () => {
    const groups = summarizeOmittedPlacements(twoProductJob(), ["cfg-a2", "cfg-b1"]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0], {
      productId: "product-a",
      productName: "Tee",
      variantId: "variant-a1",
      optionName: "Small",
      placementCount: 2,
    });
  });

  it("emits no line for omitted options with zero placements", () => {
    assert.deepEqual(summarizeOmittedPlacements(twoProductJob(), ["cfg-a1", "cfg-b1"]), []);
  });

  it("returns an empty diff when nothing with placements is omitted", () => {
    assert.deepEqual(
      summarizeOmittedPlacements(twoProductJob(), ["cfg-a1", "cfg-a2", "cfg-b1"]),
      [],
    );
  });

  it("aggregates placements by product and variant", () => {
    const project = twoProductJob();
    project.configurations.push(makeConfiguration("cfg-a1b", "product-a", "variant-a1", 3));
    const groups = summarizeOmittedPlacements(project, ["cfg-a2", "cfg-b1"]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.productId, "product-a");
    assert.equal(groups[0]?.variantId, "variant-a1");
    assert.equal(groups[0]?.placementCount, 5);
  });

  it("uses a null option name for a single unnamed option", () => {
    const cap = makeProduct("product-c", "Cap", [makeVariant("variant-c1")]);
    const project = makeProject(
      [...twoProductJob().products, cap],
      [
        ...twoProductJob().configurations,
        makeConfiguration("cfg-c1", "product-c", "variant-c1", 1),
      ],
    );
    const groups = summarizeOmittedPlacements(project, [
      "cfg-a1",
      "cfg-a2",
      "cfg-b1",
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.productId, "product-c");
    assert.equal(groups[0]?.optionName, null);
    assert.equal(groups[0]?.placementCount, 1);
  });
  it("distinguishes multiple unnamed options using shared display labels", () => {
    const project = twoProductJob();
    for (const variant of project.products[0]!.variants) delete variant.name;
    project.configurations[1]!.placements = [makePlacement("second-option")];
    const groups = summarizeOmittedPlacements(project, ["cfg-b1"]);
    assert.deepEqual(groups.map(group => [group.optionName, group.placementCount]), [["Option 1", 2], ["Option 2", 1]]);
  });

});
