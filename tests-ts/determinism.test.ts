import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildCandidateExport,
  serializeExport,
  type ProjectDocument,
} from "../src/core/index.js";

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readProject(name: string): ProjectDocument {
  const text = readFileSync(
    new URL(`../../examples/projects/${name}`, import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as ProjectDocument;
}

describe("determinism: candidate export is byte-stable and status-locked", () => {
  it("building twice serializes byte-identical", () => {
    const project = readProject("project-multi.project.json");
    const first = serializeExport(buildCandidateExport(project, hashText));
    const second = serializeExport(buildCandidateExport(project, hashText));
    assert.equal(first, second);
  });

  it("status is always candidate-pending-review", () => {
    for (const name of ["project-multi.project.json", "project-empty.project.json"]) {
      const candidate = buildCandidateExport(readProject(name), hashText);
      assert.equal(candidate.status, "candidate-pending-review");
    }
  });

  it("requestedStatus approved throws", () => {
    const project = readProject("project-empty.project.json");
    assert.throws(
      () => buildCandidateExport(project, hashText, { requestedStatus: "approved" }),
      /candidate-pending-review/,
    );
  });

  it("tampered content changes the export digest", () => {
    const project = readProject("project-multi.project.json");
    const before = buildCandidateExport(project, hashText).digest;
    const tampered = JSON.parse(JSON.stringify(project)) as ProjectDocument;
    const placement = tampered.configurations[0]?.placements[0];
    assert.ok(placement);
    placement.rotationDeg = 45;
    const after = buildCandidateExport(tampered, hashText).digest;
    assert.notEqual(before, after);
  });
});
