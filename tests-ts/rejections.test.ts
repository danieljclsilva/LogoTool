import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateProject,
  type ProjectDocument,
  type ValidationError,
} from "../src/core/index.js";

function readProject(): ProjectDocument {
  const text = readFileSync(
    new URL("../../examples/projects/project-multi.project.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as ProjectDocument;
}

function cloneProject(): ProjectDocument {
  return JSON.parse(JSON.stringify(readProject())) as ProjectDocument;
}

function firstPlacement(project: ProjectDocument): Record<string, unknown> {
  const configuration = project.configurations[0];
  assert.ok(configuration);
  const placement = configuration.placements[0];
  assert.ok(placement);
  return placement as unknown as Record<string, unknown>;
}

function codes(errors: ValidationError[]): string {
  return errors.map((e) => `${e.code}@${e.path}`).join(", ");
}

function expectRejected(project: unknown, code: string, pathPart: string): void {
  const result = validateProject(project);
  assert.equal(result.ok, false, `expected rejection ${code}@${pathPart}, got ok`);
  assert.ok(
    result.errors.some((e) => e.code === code && e.path.includes(pathPart)),
    `expected ${code}@*${pathPart}*, got: ${codes(result.errors)}`,
  );
  for (const e of result.errors) {
    assert.ok(e.code.length > 0 && e.path.length > 0 && e.message.length > 0);
  }
}

describe("rejections: malformed content fails with code + path", () => {
  it("duplicate configuration ids rejected", () => {
    const project = cloneProject();
    const first = project.configurations[0];
    const second = project.configurations[1];
    assert.ok(first && second);
    second.id = first.id;
    expectRejected(project, "duplicate-id", "configurations");
  });

  it("duplicate placement ids within one configuration rejected", () => {
    const project = cloneProject();
    const configuration = project.configurations[0];
    assert.ok(configuration);
    const a = configuration.placements[0];
    const b = configuration.placements[1];
    assert.ok(a && b);
    a.id = "P-DUP";
    b.id = "P-DUP";
    expectRejected(project, "duplicate-id", "placements");
  });

  it("dangling logoId rejected", () => {
    const project = cloneProject();
    firstPlacement(project)["logoId"] = "NO-SUCH-LOGO";
    expectRejected(project, "dangling-ref", "logoId");
  });

  it("dangling regionId rejected", () => {
    const project = cloneProject();
    firstPlacement(project)["regionId"] = "NO-SUCH-REGION";
    expectRejected(project, "dangling-ref", "regionId");
  });

  it("dangling variantId rejected", () => {
    const project = cloneProject();
    assert.ok(project.configurations[0]);
    project.configurations[0].variantId = "NO-SUCH-VARIANT";
    expectRejected(project, "dangling-ref", "variantId");
  });

  it("zero widthMm rejected", () => {
    const project = cloneProject();
    firstPlacement(project)["widthMm"] = 0;
    expectRejected(project, "nonpositive-dimension", "widthMm");
  });

  it("negative heightMm rejected", () => {
    const project = cloneProject();
    firstPlacement(project)["heightMm"] = -5;
    expectRejected(project, "nonpositive-dimension", "heightMm");
  });

  it("NaN widthMm rejected as nonfinite", () => {
    const project = cloneProject();
    firstPlacement(project)["widthMm"] = Number.NaN;
    expectRejected(project, "nonfinite-number", "widthMm");
  });

  it("Infinity heightMm rejected as nonfinite", () => {
    const project = cloneProject();
    firstPlacement(project)["heightMm"] = Number.POSITIVE_INFINITY;
    expectRejected(project, "nonfinite-number", "heightMm");
  });

  it("unsupported schemaVersion rejected", () => {
    const project = cloneProject();
    (project as unknown as Record<string, unknown>)["schemaVersion"] = "9.9.9-future";
    expectRejected(project, "unsupported-schema-version", "schemaVersion");
  });

  it("unknown calibrationRef rejected", () => {
    const project = cloneProject();
    const region = project.products[0]?.regions[0] as unknown as Record<string, unknown>;
    assert.ok(region);
    region["calibrationRef"] = { calibrationId: "CAL-NOPE", version: "v9" };
    expectRejected(project, "unknown-calibration", "calibrationRef");
  });

  it("flat xMm/yMm alongside nested pos rejected", () => {
    const project = cloneProject();
    const placement = firstPlacement(project);
    placement["xMm"] = 0;
    placement["yMm"] = 10;
    expectRejected(project, "bad-shape", "placements[0]");
  });

  it("rotation 180 is valid but 180.5 is out of range", () => {
    const okProject = cloneProject();
    firstPlacement(okProject)["rotationDeg"] = 180;
    assert.equal(validateProject(okProject).ok, true);
    const badProject = cloneProject();
    firstPlacement(badProject)["rotationDeg"] = 180.5;
    expectRejected(badProject, "bad-rotation", "rotationDeg");
  });

  it("rotation NaN rejected", () => {
    const project = cloneProject();
    firstPlacement(project)["rotationDeg"] = Number.NaN;
    expectRejected(project, "bad-rotation", "rotationDeg");
  });

  it("rotation -180 rejected (range is (-180, 180])", () => {
    const project = cloneProject();
    firstPlacement(project)["rotationDeg"] = -180;
    expectRejected(project, "bad-rotation", "rotationDeg");
  });
});
