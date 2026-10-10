import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  canonicalize,
  contentDigest,
  validateProject,
  type ProjectDocument,
} from "../src/core/index.js";

function readFixture(path: string): ProjectDocument {
  const text = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(text);
  return parsed as ProjectDocument;
}

describe("round trip: fixtures validate and survive canonical re-parse", () => {
  it("project-multi validates ok", () => {
    const project = readFixture("examples/projects/project-multi.project.json");
    const result = validateProject(project);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("project-empty validates ok with zero placements and no confirmation", () => {
    const project = readFixture("examples/projects/project-empty.project.json");
    const result = validateProject(project);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const placements = project.configurations.flatMap((c) => c.placements);
    assert.equal(placements.length, 0);
    assert.equal(project.confirmation, undefined);
    assert.equal(project.review, undefined);
  });

  it("canonicalize -> parse -> validate stays ok for both fixtures", () => {
    for (const path of [
      "examples/projects/project-multi.project.json",
      "examples/projects/project-empty.project.json",
    ]) {
      const project = readFixture(path);
      const reparsed: unknown = JSON.parse(canonicalize(project));
      const result = validateProject(reparsed);
      assert.equal(result.ok, true, `${path}: ${JSON.stringify(result.errors)}`);
    }
  });

  it("multi confirmation.digest equals recomputed operational content digest", () => {
    const project = readFixture("examples/projects/project-multi.project.json");
    assert.ok(project.confirmation, "multi fixture must carry confirmation");
    const viaRevision = contentDigest(project, (text) =>
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
    const viaCurrent = contentDigest(project, (text) =>
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
    assert.equal(viaRevision, viaCurrent);
    assert.equal(project.confirmation?.digest, viaCurrent);
    assert.equal(project.confirmation?.revision, project.revision);
  });

  it("multi fixture covers products, variants, regions and repeated logos", () => {
    const project = readFixture("examples/projects/project-multi.project.json");
    assert.equal(project.configurations.length, 2);
    const placements = project.configurations.flatMap((c) => c.placements);
    assert.equal(placements.length, 3);
    const chestCopies = placements.filter((p) => p.logoId === "SYN-LOGO-A");
    assert.equal(chestCopies.length, 2, "same logoId must appear twice");
    const distinctRegions = placements
      .map((p) => p.regionId)
      .filter((id, i, all) => all.indexOf(id) === i);
    assert.equal(distinctRegions.length, 3, "placements must span three distinct regions");
    const distinctProducts = project.configurations
      .map((c) => c.productId)
      .filter((id, i, all) => all.indexOf(id) === i);
    assert.equal(distinctProducts.length, 2, "must span two products");
  });
});
