import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  checkAgainstBaseline,
  confirmRevision,
  contentDigest,
  hasCurrentInternalApproval,
  newRevision,
  recordInternalReview,
  validateProject,
  type IssuedBaseline,
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

function cloneOf(project: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(project)) as ProjectDocument;
}

function issuedFrom(project: ProjectDocument): IssuedBaseline {
  return {
    projectId: project.projectId,
    products: cloneOf(project).products,
    logos: cloneOf(project).logos,
  };
}

const WRONG_DIGEST = "0".repeat(64);

describe("workflow: confirm binds digest, revision rotates, internal workflow approval", () => {
  it("confirmRevision rejects a wrong digest", () => {
    const draft = readProject("project-empty.project.json");
    const outcome = confirmRevision(
      draft,
      { confirmedBy: "synthetic-customer", digestOf: WRONG_DIGEST },
      hashText,
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.errors.some((e) => e.code === "digest-mismatch"));
    }
  });

  it("confirmRevision records the exact current digest", () => {
    const draft = readProject("project-empty.project.json");
    const digest = contentDigest(draft, hashText);
    const outcome = confirmRevision(
      draft,
      { confirmedBy: "synthetic-customer", confirmedAt: "2026-02-01T00:00:00.000Z", digestOf: digest },
      hashText,
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.project.confirmation?.digest, digest);
      assert.equal(outcome.project.confirmation?.revision, draft.revision);
      assert.equal(validateProject(outcome.project).ok, true);
    }
  });

  it("newRevision after a content change invalidates confirmation and keeps history", () => {
    const confirmed = readProject("project-multi.project.json");
    const priorDigest = confirmed.confirmation?.digest;
    assert.ok(priorDigest);
    const next = newRevision(confirmed, (draft) => {
      const placement = draft.configurations[0]?.placements[0];
      assert.ok(placement);
      placement.widthMm = 81;
    });
    assert.equal(next.revision, confirmed.revision + 1);
    assert.equal(next.confirmation, undefined);
    assert.ok(Array.isArray(next.history));
    assert.ok(next.history?.some((entry) => entry.digest === priorDigest));
    // The rotated prior confirmation no longer matches the new revision.
    const staleCheck = validateProject(next);
    assert.equal(staleCheck.ok, true, JSON.stringify(staleCheck.errors));
  });

  it("customer confirmation alone is never internally approved", () => {
    const draft = readProject("project-empty.project.json");
    const digest = contentDigest(draft, hashText);
    const outcome = confirmRevision(
      draft,
      { confirmedBy: "synthetic-customer", digestOf: digest },
      hashText,
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(hasCurrentInternalApproval(outcome.project, hashText), false);
    }
  });

  it("approved internal review on the current digest is internally approved", () => {
    const project = readProject("project-multi.project.json");
    const digest = contentDigest(project, hashText);
    const outcome = recordInternalReview(
      project,
      { decision: "approved", reviewer: "synthetic-qa", digestOf: digest },
      hashText,
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(hasCurrentInternalApproval(outcome.project, hashText), true);
    }
  });

  it("stale-digest internal review fails", () => {
    const project = readProject("project-multi.project.json");
    const outcome = recordInternalReview(
      project,
      { decision: "approved", reviewer: "synthetic-qa", digestOf: WRONG_DIGEST },
      hashText,
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.ok(outcome.errors.some((e) => e.code === "digest-mismatch"));
    }
  });

  it("clone without changes (import/open path) never creates approval", () => {
    const project = readProject("project-multi.project.json");
    const opened = cloneOf(project);
    assert.equal(hasCurrentInternalApproval(opened, hashText), false);
    assert.notEqual(opened.review?.decision, "approved");
  });
});

describe("workflow: baseline tamper checks", () => {
  it("untampered project passes checkAgainstBaseline", () => {
    const project = readProject("project-multi.project.json");
    const result = checkAgainstBaseline(project, issuedFrom(project));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("tampered calibration version fails with baseline-tamper", () => {
    const project = readProject("project-multi.project.json");
    const issued = issuedFrom(project);
    const calibration = project.products[0]?.calibrations[0];
    assert.ok(calibration);
    calibration.version = "v-tampered";
    const result = checkAgainstBaseline(project, issued);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "baseline-tamper"));
  });

  it("tampered region safeArea fails with baseline-tamper", () => {
    const project = readProject("project-multi.project.json");
    const issued = issuedFrom(project);
    const region = project.products[0]?.regions[0];
    assert.ok(region);
    region.safeArea = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    const result = checkAgainstBaseline(project, issued);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "baseline-tamper"));
  });
});
