import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { buildCandidateExport } from "../src/core/index.js";
import type { ProjectDocument } from "../src/core/index.js";

function readJson(path: string): AnySchema {
  const text = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  return JSON.parse(text) as AnySchema;
}
describe("schema agreement: ajv runtime schemas accept fixtures and exports", () => {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const productSchema = readJson("schemas/product.schema.json");
  const logoSchema = readJson("schemas/logo.schema.json");
  const projectSchema = readJson("schemas/project.schema.json");
  const resultSchema = readJson("schemas/result.schema.json");
  ajv.addSchema(productSchema);
  ajv.addSchema(logoSchema);

  it("product examples validate against the product schema", () => {
    const validate = ajv.compile(productSchema);
    for (const path of [
      "examples/products/syn-tee-001.product.json",
      "examples/products/syn-trousers-001.product.json",
      "examples/products/syn-cap-001.product.json",
    ]) {
      assert.equal(validate(readJson(path)), true, `${path}: ${JSON.stringify(validate.errors)}`);
    }
  });

  it("logo examples validate against the logo schema", () => {
    const validate = ajv.compile(logoSchema);
    for (const path of [
      "examples/logos/syn-mark-a.logo.json",
      "examples/logos/syn-mark-b.logo.json",
    ]) {
      assert.equal(validate(readJson(path)), true, `${path}: ${JSON.stringify(validate.errors)}`);
    }
  });

  it("project examples validate against the project schema", () => {
    const validate = ajv.compile(projectSchema);
    for (const path of [
      "examples/projects/project-multi.project.json",
      "examples/projects/project-empty.project.json",
    ]) {
      assert.equal(validate(readJson(path)), true, `${path}: ${JSON.stringify(validate.errors)}`);
    }
  });

  it("candidate exports validate against the result schema (empty and multi)", () => {
    const validate = ajv.compile(resultSchema);
    for (const path of [
      "examples/projects/project-empty.project.json",
      "examples/projects/project-multi.project.json",
    ]) {
      const project = readJson(path) as ProjectDocument;
      const candidate = buildCandidateExport(project, (text) =>
        createHash("sha256").update(text, "utf8").digest("hex"),
      );
      assert.equal(
        validate(JSON.parse(JSON.stringify(candidate)) as unknown),
        true,
        `${path} export: ${JSON.stringify(validate.errors)}`,
      );
    }
  });
});
