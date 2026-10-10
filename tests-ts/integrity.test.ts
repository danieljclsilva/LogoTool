import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildCandidateExport, canonicalize, checkAgainstBaseline, checkProjectContract,
  confirmRevision, contentDigest, hasCurrentInternalApproval, importCustomerReturn,
  newRevision, recordInternalReview, serializeExport, validateProject,
  type ProjectDocument,
} from "../src/core/index.js";

const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture(empty = false): ProjectDocument {
  return JSON.parse(readFileSync(new URL(`../../examples/projects/project-${empty ? "empty" : "multi"}.project.json`, import.meta.url), "utf8")) as ProjectDocument;
}
function approved(): ProjectDocument {
  const project = fixture();
  assert.equal(recordInternalReview(project, { decision: "approved", reviewer: "Synthetic reviewer", at: "2026-10-10T12:00:00Z", digestOf: contentDigest(project, hash) }, hash).ok, true);
  return project;
}

describe("operational content and history integrity", () => {
  for (const [name, mutate] of [
    ["project instructions", (p: ProjectDocument) => { p.instructions = "Different application instructions"; }],
    ["artwork", (p: ProjectDocument) => { p.logos[0]!.assets[0]!.sha256Hex = "f".repeat(64); }],
    ["calibration", (p: ProjectDocument) => { p.products[0]!.calibrations[0]!.description = "Changed calibration"; }],
    ["placement instructions", (p: ProjectDocument) => { p.configurations[0]!.placements[0]!.instructions = "Changed handling"; }],
  ] as const) {
    it(`${name} changes stale current approval and confirmation`, () => {
      const project = approved();
      const before = contentDigest(project, hash);
      mutate(project);
      assert.notEqual(contentDigest(project, hash), before);
      assert.notEqual(project.confirmation!.digest, contentDigest(project, hash));
      assert.equal(hasCurrentInternalApproval(project, hash), false);
    });
  }
  it("new revision preserves original evidence even if mutator rewrites it", () => {
    const project = approved();
    project.history = [clone(project.confirmation!)];
    project.reviewHistory = [clone(project.review!)];
    const saved = clone(project);
    const next = newRevision(project, draft => {
      draft.instructions = "New instructions";
      draft.confirmation!.confirmedBy = "Rewritten";
      draft.review!.reviewer = "Rewritten";
      draft.history![0]!.confirmedBy = "Rewritten history";
      draft.reviewHistory![0]!.reviewer = "Rewritten history";
      delete draft.confirmation;
      delete draft.review;
    });
    assert.equal(next.revision, project.revision + 1);
    assert.equal(next.confirmation, undefined);
    assert.equal(next.review, undefined);
    assert.deepEqual(next.history, [...saved.history!, saved.confirmation!]);
    assert.deepEqual(next.reviewHistory, [...saved.reviewHistory!, saved.review!]);
    assert.deepEqual(project, saved);
  });
  it("rejects invalid content and manipulated revision counters", () => {
    assert.throws(() => newRevision(fixture(), p => { p.configurations[0]!.placements[0]!.widthMm = -1; }), /invalid content/);
    assert.throws(() => newRevision(fixture(), p => { p.revision += 2; }), /revision counter/);
  });
  it("invalid hasher output cannot establish confirmation or review", () => {
    const project = fixture();
    const input = { digestOf: contentDigest(project, hash), confirmedBy: "Synthetic customer" };
    assert.equal(confirmRevision(project, input, () => "bad").ok, false);
    assert.equal(recordInternalReview(project, { ...input, decision: "approved", reviewer: "Synthetic reviewer" }, () => "bad").ok, false);
    assert.throws(() => contentDigest(project, () => "bad"), /hasher/);
  });
  it("invalid content cannot be confirmed, reviewed or exported", () => {
    const project = fixture();
    project.configurations[0]!.placements[0]!.widthMm = -1;
    const digestOf = contentDigest(project, hash);
    assert.equal(confirmRevision(project, { confirmedBy: "Synthetic customer", digestOf }, hash).ok, false);
    assert.equal(recordInternalReview(project, { reviewer: "Synthetic reviewer", decision: "approved", digestOf }, hash).ok, false);
    assert.throws(() => buildCandidateExport(project, hash), /invalid content/);
  });
});

describe("untrusted customer-return boundary", () => {
  it("discards injected review and keeps only trusted issued history", () => {
    const issued = approved();
    const returned = newRevision(issued, p => { p.instructions = "Changed instructions"; });
    assert.equal(confirmRevision(returned, { confirmedBy: "Synthetic customer", digestOf: contentDigest(returned, hash) }, hash).ok, true);
    returned.review = { revision: returned.revision, digest: contentDigest(returned, hash), reviewer: "Customer-injected reviewer", decision: "approved", at: "2026-10-10" };
    returned.reviewHistory = [clone(returned.review)];
    const result = importCustomerReturn(returned, issued, hash);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.project.review, undefined);
    assert.equal(hasCurrentInternalApproval(result.project, hash), false);
    assert.deepEqual(result.project.reviewHistory, [...(issued.reviewHistory ?? []), issued.review]);
    assert.deepEqual(result.project.confirmation, returned.confirmation);
    assert.equal(validateProject(result.project).ok, true);
  });
  it("supports importing an unconfirmed draft without approval", () => {
    const issued = fixture(true);
    const result = importCustomerReturn(clone(issued), issued, hash);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(hasCurrentInternalApproval(result.project, hash), false);
  });
  it("rejects stale confirmation after direct instruction edits", () => {
    const issued = fixture();
    const returned = clone(issued);
    returned.instructions = "Edited without reconfirmation";
    const result = importCustomerReturn(returned, issued, hash);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some(e => e.code === "stale-confirmation"));
  });
  it("requires changed content to advance the issued revision", () => {
    const issued = fixture(true);
    const returned = clone(issued);
    returned.instructions = "Changed draft";
    const result = importCustomerReturn(returned, issued, hash);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some(e => e.code === "invalid-return-revision"));
  });
  it("rejects changed artwork, identity and duplicate baseline IDs", () => {
    const issued = fixture();
    const artwork = clone(issued);
    artwork.logos[0]!.assets[0]!.sha256Hex = "f".repeat(64);
    assert.equal(importCustomerReturn(artwork, issued, hash).ok, false);
    const identity = clone(issued);
    identity.projectId = "different";
    assert.equal(importCustomerReturn(identity, issued, hash).ok, false);
    const duplicates = clone(issued);
    duplicates.products.push(clone(duplicates.products[0]!));
    assert.equal(checkAgainstBaseline(duplicates, issued).ok, false);
  });
});

describe("candidate interpretation and schema parity", () => {
  it("checks variant applicability, permitted methods and physical references", () => {
    const otherVariant = fixture();
    otherVariant.configurations[0]!.variantId = "SYN-TEE-XL";
    assert.equal(validateProject(otherVariant).ok, false, "XL excludes the back region");
    otherVariant.configurations[0]!.placements.pop();
    assert.equal(validateProject(otherVariant).ok, true);
    otherVariant.configurations[0]!.placements[0]!.method = "unconfigured-method";
    assert.equal(validateProject(otherVariant).ok, false);
    const badFrame = fixture();
    badFrame.products[0]!.regions[0]!.frame.frameId = "";
    assert.equal(validateProject(badFrame).ok, false);
    const badProduct = fixture();
    badProduct.configurations[0]!.productId = "unknown-product";
    assert.equal(validateProject(badProduct).ok, false);
  });
  it("candidate snapshots cannot mutate authoritative project data", () => {
    const project = fixture();
    const before = clone(project);
    const candidate = buildCandidateExport(project, hash);
    candidate.configurations[0]!.placements[0]!.frame.axes.xPositive = "changed";
    candidate.products[0]!.regions[0]!.frame.axes.xPositive = "changed";
    candidate.logos[0]!.assets[0]!.uri = "changed.svg";
    assert.deepEqual(project, before);
  });
  it("retains empty configurations and all physical/operational context", () => {
    const empty = buildCandidateExport(fixture(true), hash);
    assert.equal(empty.configurations.length, 1);
    assert.equal(empty.configurations[0]!.placements.length, 0);
    assert.equal(empty.configurations[0]!.variantId, fixture(true).configurations[0]!.variantId);
    const project = fixture();
    project.instructions = "Project handling";
    project.configurations[0]!.placements[0]!.instructions = "Placement handling";
    const candidate = buildCandidateExport(project, hash);
    assert.equal(candidate.instructions, project.instructions);
    const placement = candidate.configurations[0]!.placements[0]!;
    assert.equal(placement.instructions, "Placement handling");
    assert.equal(placement.frame.unit, "mm");
    assert.equal(placement.frame.referencePoint, "artwork-bbox-center");
    assert.equal(placement.calibration.version, project.products[0]!.regions[0]!.calibrationRef.version);
    assert.ok(placement.artwork.assets.some(a => a.role === "original" && a.sha256Hex));
    assert.equal(serializeExport(candidate), serializeExport(buildCandidateExport(project, hash)));
  });
  for (const [name, mutate] of [
    ["unknown project field", (p: Record<string, any>) => { p.internalReview = {}; }],
    ["unknown placement field", (p: Record<string, any>) => { p.configurations[0].placements[0].xMm = 3; }],
    ["malformed regions", (p: Record<string, any>) => { p.products[0].regions = null; }],
    ["malformed variant", (p: Record<string, any>) => { p.products[0].variants[0] = null; }],
  ] as const) {
    it(`${name} is rejected by schema and runtime without throwing`, () => {
      const project = fixture() as unknown as Record<string, any>;
      mutate(project);
      assert.ok(checkProjectContract(project).length > 0);
      assert.equal(validateProject(project).ok, false);
    });
  }
  it("fixture originals exist and match asset hashes", () => {
    for (const logo of fixture().logos) for (const asset of logo.assets) {
      const bytes = readFileSync(new URL(`../../examples/${asset.uri}`, import.meta.url));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256Hex);
    }
  });
});

describe("exact canonical JSON", () => {
  it("preserves special JSON keys without changing prototypes", () => {
    const original: unknown = JSON.parse('{"__proto__":{"value":1},"constructor":"c","a":2}');
    assert.deepEqual(JSON.parse(canonicalize(original)), original);
  });
  it("rejects lossy non-JSON values", () => {
    for (const value of [NaN, Infinity, undefined, { field: undefined }, new Date(), new Array(2)]) {
      assert.throws(() => canonicalize(value), /rejects/);
    }
  });
});
