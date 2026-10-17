import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LogoDefinition, ProductDefinition } from "../src/core/types.js";
import { validateProject } from "../src/core/validate.js";
import { BUILDER_LIMITS } from "../src/core/project-builder/index.js";
import { createProjectFromDefinitions } from "../src/core/project-builder/create-project.js";

const PRODUCT_FILES = [
  "examples/products/syn-cap-001.product.json",
  "examples/products/syn-tee-001.product.json",
  "examples/products/syn-trousers-001.product.json",
];

const LOGO_FILES = [
  "examples/logos/syn-mark-a.logo.json",
  "examples/logos/syn-mark-b.logo.json",
];

function readJsonFile<T>(relativePath: string): T {
  const text = readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
  return JSON.parse(text) as T;
}

function readProducts(): ProductDefinition[] {
  return PRODUCT_FILES.map((file) => readJsonFile<ProductDefinition>(file)).sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function readLogos(): LogoDefinition[] {
  return LOGO_FILES.map((file) => readJsonFile<LogoDefinition>(file)).sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

// Ordered by product then variant, matching readProducts() id-sorted order.
const EXPECTED_CONFIGS: [string, string][] = [
  ["SYN-CAP-001", "SYN-CAP-OS"],
  ["SYN-TEE-001", "SYN-TEE-M"],
  ["SYN-TEE-001", "SYN-TEE-XL"],
  ["SYN-TR-001", "SYN-TR-REG"],
  ["SYN-TR-001", "SYN-TR-SHORT"],
];

describe("create-project: fresh draft from prepared definitions", () => {
  it("builds a revision-1 draft with one zero-placement config per variant", () => {
    const products = readProducts();
    const logos = readLogos();
    const result = createProjectFromDefinitions({
      products,
      logos,
      projectId: "EXAMPLE-DRAFT-001",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const project = result.project;
    assert.equal(project.revision, 1);
    assert.equal(project.projectId, "EXAMPLE-DRAFT-001");
    assert.equal(project.synthetic, true);
    assert.deepEqual(
      project.configurations.map((config) => config.id),
      ["example-config-1", "example-config-2", "example-config-3", "example-config-4", "example-config-5"],
    );
    assert.deepEqual(
      project.configurations.map((config) => [config.productId, config.variantId]),
      EXPECTED_CONFIGS,
    );
    for (const config of project.configurations) {
      assert.deepEqual(config.placements, []);
    }
    assert.deepEqual(project.products, products);
    assert.deepEqual(project.logos, logos);
    assert.match(project.description ?? "", /reset/);
    assert.equal(project.instructions, undefined);
    assert.equal(project.confirmation, undefined);
    assert.equal(project.review, undefined);
    assert.equal(project.history, undefined);
    assert.equal(project.reviewHistory, undefined);
    assert.equal(project.issuedBaselineHash, undefined);
    assert.equal(validateProject(project).ok, true);
  });

  it("never mutates its inputs", () => {
    const input = { products: readProducts(), logos: readLogos(), projectId: "NO-MUTATE" };
    const before = JSON.stringify(input);
    const result = createProjectFromDefinitions(input);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(input), before);
  });

  it("deep-clones caller inputs", () => {
    const products = readProducts();
    const logos = readLogos();
    const result = createProjectFromDefinitions({
      products,
      logos,
      projectId: "CLONE-CHECK",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    products[0]!.id = "MUTATED-PRODUCT";
    products.length = 0;
    logos.length = 0;
    assert.equal(result.project.products.length, 3);
    assert.equal(result.project.products[0]!.id, "SYN-CAP-001");
    assert.equal(result.project.logos.length, 2);
  });

  it("is deterministic for identical input", () => {
    const first = createProjectFromDefinitions({
      products: readProducts(),
      logos: readLogos(),
      projectId: "DETERMINISTIC",
    });
    const second = createProjectFromDefinitions({
      products: readProducts(),
      logos: readLogos(),
      projectId: "DETERMINISTIC",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(JSON.stringify(first.project), JSON.stringify(second.project));
  });

  it("defaults synthetic to true and preserves an explicit false", () => {
    const defaulted = createProjectFromDefinitions({
      products: readProducts(),
      projectId: "SYN-DEFAULT",
    });
    assert.equal(defaulted.ok, true);
    if (!defaulted.ok) return;
    assert.equal(defaulted.project.synthetic, true);
    assert.deepEqual(defaulted.project.logos, []);

    const explicit = createProjectFromDefinitions({
      products: readProducts(),
      logos: readLogos(),
      projectId: "SYN-EXPLICIT",
      synthetic: false,
    });
    assert.equal(explicit.ok, true);
    if (!explicit.ok) return;
    assert.equal(explicit.project.synthetic, false);
  });

  it("rejects empty products but allows empty logos", () => {
    const emptyProducts = createProjectFromDefinitions({ products: [], projectId: "EMPTY-P" });
    assert.equal(emptyProducts.ok, false);
    if (emptyProducts.ok) return;
    assert.ok(emptyProducts.errors.some((error) => error.code === "empty-selection"));

    const noLogos = createProjectFromDefinitions({
      products: readProducts(),
      logos: [],
      projectId: "EMPTY-L",
    });
    assert.equal(noLogos.ok, true);
  });

  it("rejects bad project ids", () => {
    for (const projectId of ["", "   ", " padded ", "x".repeat(BUILDER_LIMITS.maxIdChars + 1)]) {
      const result = createProjectFromDefinitions({
        products: readProducts(),
        projectId,
      });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(projectId)}`);
    }
  });

  it("rejects duplicate product and logo ids", () => {
    const products = readProducts();
    const duplicatedProducts = createProjectFromDefinitions({
      products: [...products, products[0]!],
      projectId: "DUPLICATE-P",
    });
    assert.equal(duplicatedProducts.ok, false);
    if (duplicatedProducts.ok) return;
    assert.ok(duplicatedProducts.errors.some((error) => error.code === "duplicate-id"));

    const logos = readLogos();
    const duplicatedLogos = createProjectFromDefinitions({
      products,
      logos: [...logos, logos[0]!],
      projectId: "DUPLICATE-L",
    });
    assert.equal(duplicatedLogos.ok, false);
    if (duplicatedLogos.ok) return;
    assert.ok(duplicatedLogos.errors.some((error) => error.code === "duplicate-id"));
  });

  it("rejects unknown refs surfaced by project validation", () => {
    const products = readProducts();
    products
      .find((product) => product.id === "SYN-TEE-001")!
      .variants[0]!.regionIds.push("NO-SUCH-REGION");
    const result = createProjectFromDefinitions({ products, projectId: "UNKNOWN-REF" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length > 0);
  });

  it("enforces the 64/64/64 builder limits", () => {
    const baseProduct = readProducts()[0]!;
    const manyProducts = Array.from(
      { length: BUILDER_LIMITS.maxProducts + 1 },
      (_, i) => ({ ...baseProduct, id: `SYN-PAD-${i}` }),
    );
    const tooManyProducts = createProjectFromDefinitions({
      products: manyProducts,
      projectId: "LIMIT-P",
    });
    assert.equal(tooManyProducts.ok, false);
    if (!tooManyProducts.ok) {
      assert.ok(tooManyProducts.errors.some((error) => error.code === "too-many"));
    }

    const baseLogo = readLogos()[0]!;
    const manyLogos = Array.from(
      { length: BUILDER_LIMITS.maxLogos + 1 },
      (_, i) => ({ ...baseLogo, id: `SYN-LOGO-PAD-${i}` }),
    );
    const tooManyLogos = createProjectFromDefinitions({
      products: readProducts(),
      logos: manyLogos,
      projectId: "LIMIT-L",
    });
    assert.equal(tooManyLogos.ok, false);
    if (!tooManyLogos.ok) {
      assert.ok(tooManyLogos.errors.some((error) => error.code === "too-many"));
    }

    const capped = readProducts();
    capped.find((product) => product.id === "SYN-CAP-001")!.variants = Array.from(
      { length: BUILDER_LIMITS.maxConfigurations + 1 },
      (_, i) => ({ id: `SYN-CAP-V-${i}`, regionIds: ["SYN-CAP-FRONT"] }),
    );
    const tooManyConfigs = createProjectFromDefinitions({
      products: capped,
      projectId: "LIMIT-C",
    });
    assert.equal(tooManyConfigs.ok, false);
    if (!tooManyConfigs.ok) {
      assert.ok(tooManyConfigs.errors.some((error) => error.code === "too-many"));
    }
  });
});

it('rejects non-JSON definition data before cloning can rewrite it', () => {
  for (const invalid of [NaN, Infinity, undefined, 1n]) {
    const products=readProducts();
    (products[0] as unknown as Record<string,unknown>)['name']=invalid;
    const result=createProjectFromDefinitions({products,projectId:'INVALID-JSON'});
    assert.equal(result.ok,false);
  }
  const cyclic=readProducts();
  (cyclic[0] as unknown as Record<string,unknown>)['name']=cyclic;
  assert.equal(createProjectFromDefinitions({products:cyclic,projectId:'CYCLIC'}).ok,false);
});
