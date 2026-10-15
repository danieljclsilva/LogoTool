import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ProjectDocument } from "../src/core/types.js";
import { validateProject } from "../src/core/validate.js";
import { importCustomerReturn } from "../src/core/workflow.js";
import {
  BUILDER_LIMITS,
  buildIssuedProject,
  selectIssuedAssets,
  summarizeSourceProject,
  validateBuilderSelection,
  type BuilderIdentity,
  type BuilderSelection,
} from "../src/core/project-builder/index.js";

const IDENTITY: BuilderIdentity = {
  customerLabel: "Acme Corp",
  jobReference: "JOB-001",
  issuedBy: "internal-operator",
  projectId: "ACME-ISSUE-001",
};

const EXPECTED_DESCRIPTION =
  "Internal-builder issue ACME-ISSUE-001 for Acme Corp / JOB-001 by internal-operator. " +
  "Confirmation and internal review history reset before customer handoff.";

function readProject(): ProjectDocument {
  const text = readFileSync(
    new URL("../../examples/projects/project-multi.project.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as ProjectDocument;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fullSelection(): BuilderSelection {
  return {
    productIds: ["SYN-TEE-001", "SYN-TR-001"],
    logoIds: ["SYN-LOGO-A", "SYN-LOGO-B"],
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Uint8Array) return `bytes:${value.length}`;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function readAssetBytes(uri: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../../examples/${uri}`, import.meta.url)),
  );
}

describe("project-builder: issue a customer project from a source project", () => {
  it("summarizes the source project", () => {
    const summary = summarizeSourceProject(readProject());
    assert.deepEqual(summary.productIds, ["SYN-TEE-001", "SYN-TR-001"]);
    assert.deepEqual(summary.logoIds, ["SYN-LOGO-A", "SYN-LOGO-B"]);
    assert.deepEqual(summary.configurationIds, ["SYN-CFG-TEE-M", "SYN-CFG-TR-REG"]);
    assert.equal(summary.placementCount, 3);
    assert.equal(summary.revision, 3);
    assert.equal(summary.projectId, "SYN-PROJ-MULTI-001");
    assert.ok(summary.assetPaths.includes("logos/syn-mark-a.svg"));
    assert.ok(summary.assetPaths.includes("logos/syn-mark-b.svg"));
  });

  it("full-selection roundtrip: revision 1, approvals cleared, description set", () => {
    const result = buildIssuedProject(readProject(), fullSelection(), IDENTITY);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const issued = result.project;
    assert.equal(issued.revision, 1);
    assert.equal(issued.description, EXPECTED_DESCRIPTION);
    assert.equal(issued.confirmation, undefined);
    assert.equal(issued.review, undefined);
    assert.equal(issued.history, undefined);
    assert.equal(issued.reviewHistory, undefined);
    assert.equal(issued.issuedBaselineHash, undefined);
    assert.equal(issued.projectId, "ACME-ISSUE-001");
    assert.equal(issued.products.length, 2);
    assert.equal(issued.logos.length, 2);
    assert.equal(issued.configurations.length, 4);
    assert.equal(
      issued.configurations.reduce((n, c) => n + c.placements.length, 0),
      3,
    );
    assert.equal(
      issued.instructions,
      readProject().instructions,
    );
    assert.equal(validateProject(issued).ok, true);
  });

  it("product/logo subset prunes products, logos, configs and placements", () => {
    const result = buildIssuedProject(
      readProject(),
      { productIds: ["SYN-TEE-001"], logoIds: ["SYN-LOGO-A"] },
      IDENTITY,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.project.products.map((p) => p.id),
      ["SYN-TEE-001"],
    );
    assert.deepEqual(
      result.project.logos.map((l) => l.id),
      ["SYN-LOGO-A"],
    );
    assert.deepEqual(
      result.project.configurations.map((c) => c.id),
      ["SYN-CFG-TEE-M", "builder-config-1"],
    );
    assert.equal(validateProject(result.project).ok, true);
  });

  it("logo subset drops placements using unselected logos; zero placements valid", () => {
    const result = buildIssuedProject(
      readProject(),
      {
        productIds: ["SYN-TEE-001", "SYN-TR-001"],
        logoIds: ["SYN-LOGO-A"],
      },
      IDENTITY,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const trousers = result.project.configurations.find((c) => c.id === "SYN-CFG-TR-REG");
    assert.ok(trousers);
    assert.deepEqual(trousers.placements, []);
    const tee = result.project.configurations.find((c) => c.id === "SYN-CFG-TEE-M");
    assert.ok(tee);
    assert.equal(tee.placements.length, 2);
    assert.equal(validateProject(result.project).ok, true);
  });

  it("variant subset prunes variants and drops configs on pruned variants", () => {
    const source = readProject();
    const result = buildIssuedProject(
      source,
      {
        productIds: ["SYN-TEE-001", "SYN-TR-001"],
        variantIdsByProduct: { "SYN-TEE-001": ["SYN-TEE-M"] },
        logoIds: ["SYN-LOGO-A", "SYN-LOGO-B"],
      },
      IDENTITY,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tee = result.project.products.find((p) => p.id === "SYN-TEE-001");
    assert.ok(tee);
    assert.deepEqual(
      tee.variants.map((v) => v.id),
      ["SYN-TEE-M"],
    );
    assert.ok(
      result.project.configurations.some((c) => c.id === "SYN-CFG-TEE-M"),
    );
    assert.equal(validateProject(result.project).ok, true);

    const xlOnly = buildIssuedProject(
      source,
      {
        productIds: ["SYN-TEE-001"],
        variantIdsByProduct: { "SYN-TEE-001": ["SYN-TEE-XL"] },
        logoIds: ["SYN-LOGO-A", "SYN-LOGO-B"],
      },
      IDENTITY,
    );
    assert.equal(xlOnly.ok, true);
    if (!xlOnly.ok) return;
    const teeXl = xlOnly.project.products.find((p) => p.id === "SYN-TEE-001");
    assert.ok(teeXl);
    assert.deepEqual(
      teeXl.variants.map((v) => v.id),
      ["SYN-TEE-XL"],
    );
    // TEE-M config referenced the pruned variant, so default filtering drops it.
    assert.deepEqual(
      xlOnly.project.configurations.map((c) => [c.variantId, c.placements]),
      [["SYN-TEE-XL", []]],
    );
    assert.equal(validateProject(xlOnly.project).ok, true);
  });

  it("explicit configuration subset keeps only the listed configurations", () => {
    const result = buildIssuedProject(
      readProject(),
      {
        ...fullSelection(),
        configurationIds: ["SYN-CFG-TR-REG"],
      },
      IDENTITY,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.project.configurations.map((c) => c.id),
      ["SYN-CFG-TR-REG"],
    );
    assert.equal(validateProject(result.project).ok, true);
  });

  it("rejects unknown, duplicate and empty selections", () => {
    const source = readProject();
    const cases: { selection: BuilderSelection; path: string; code: string }[] = [
      {
        selection: { productIds: ["NOPE"], logoIds: ["SYN-LOGO-A"] },
        path: "selection.productIds[0]",
        code: "unknown-id",
      },
      {
        selection: {
          productIds: ["SYN-TEE-001", "SYN-TEE-001"],
          logoIds: ["SYN-LOGO-A"],
        },
        path: "selection.productIds[1]",
        code: "duplicate-id",
      },
      {
        selection: { productIds: [], logoIds: ["SYN-LOGO-A"] },
        path: "selection.productIds",
        code: "empty-selection",
      },
      // NOTE: logoIds: [] is valid (0..N no-artwork issue); covered below.
      {
        selection: { productIds: ["SYN-TEE-001"], logoIds: ["NOPE"] },
        path: "selection.logoIds[0]",
        code: "unknown-id",
      },
      {
        selection: { productIds: ["SYN-TEE-001"], logoIds: ["SYN-LOGO-A", "SYN-LOGO-A"] },
        path: "selection.logoIds[1]",
        code: "duplicate-id",
      },
      {
        selection: {
          productIds: ["SYN-TEE-001"],
          variantIdsByProduct: { "SYN-TEE-001": ["NOPE"] },
          logoIds: ["SYN-LOGO-A"],
        },
        path: "selection.variantIdsByProduct.SYN-TEE-001[0]",
        code: "unknown-id",
      },
      {
        selection: {
          productIds: ["SYN-TEE-001"],
          variantIdsByProduct: { "SYN-TEE-001": ["SYN-TEE-M", "SYN-TEE-M"] },
          logoIds: ["SYN-LOGO-A"],
        },
        path: "selection.variantIdsByProduct.SYN-TEE-001[1]",
        code: "duplicate-id",
      },
      {
        selection: {
          productIds: ["SYN-TEE-001"],
          variantIdsByProduct: { "SYN-TEE-001": [] },
          logoIds: ["SYN-LOGO-A"],
        },
        path: "selection.variantIdsByProduct.SYN-TEE-001",
        code: "empty-selection",
      },
      {
        selection: {
          productIds: ["SYN-TEE-001"],
          variantIdsByProduct: { "SYN-TR-001": ["SYN-TR-REG"] },
          logoIds: ["SYN-LOGO-A"],
        },
        path: "selection.variantIdsByProduct.SYN-TR-001",
        code: "not-selected",
      },
      {
        selection: {
          ...fullSelection(),
          configurationIds: ["NOPE"],
        },
        path: "selection.configurationIds[0]",
        code: "unknown-id",
      },
      {
        selection: {
          ...fullSelection(),
          configurationIds: ["SYN-CFG-TEE-M", "SYN-CFG-TEE-M"],
        },
        path: "selection.configurationIds[1]",
        code: "duplicate-id",
      },
      {
        selection: {
          productIds: ["SYN-TR-001"],
          logoIds: ["SYN-LOGO-A", "SYN-LOGO-B"],
          configurationIds: ["SYN-CFG-TEE-M"],
        },
        path: "selection.configurationIds[0]",
        code: "not-selected",
      },
      {
        selection: {
          productIds: ["SYN-TEE-001"],
          variantIdsByProduct: { "SYN-TEE-001": ["SYN-TEE-XL"] },
          logoIds: ["SYN-LOGO-A"],
          configurationIds: ["SYN-CFG-TEE-M"],
        },
        path: "selection.configurationIds[0]",
        code: "not-selected",
      },
    ];
    for (const { selection, path, code } of cases) {
      const check = validateBuilderSelection(source, selection);
      assert.equal(check.ok, false, path);
      if (!check.ok) {
        assert.ok(
          check.errors.some((e) => e.path === path && e.code === code),
          `${code}@${path}: ${JSON.stringify(check.errors)}`,
        );
      }
      const issued = buildIssuedProject(source, selection, IDENTITY);
      assert.equal(issued.ok, false, path);
    }
  });

  it("rejects bad identity strings", () => {
    const source = readProject();
    const bad: { identity: BuilderIdentity; path: string }[] = [
      {
        identity: { ...IDENTITY, customerLabel: "" },
        path: "identity.customerLabel",
      },
      {
        identity: { ...IDENTITY, customerLabel: "   " },
        path: "identity.customerLabel",
      },
      {
        identity: { ...IDENTITY, jobReference: "x".repeat(257) },
        path: "identity.jobReference",
      },
      {
        identity: { ...IDENTITY, issuedBy: "" },
        path: "identity.issuedBy",
      },
      {
        identity: { ...IDENTITY, issuedBy: " lead " },
        path: "identity.issuedBy",
      },
      {
        identity: { ...IDENTITY, projectId: "" },
        path: "identity.projectId",
      },
      {
        identity: { ...IDENTITY, projectId: "   " },
        path: "identity.projectId",
      },
      {
        identity: { ...IDENTITY, projectId: "x".repeat(257) },
        path: "identity.projectId",
      },
      {
        identity: { ...IDENTITY, projectId: " PADDED " },
        path: "identity.projectId",
      },
    ];
    for (const { identity, path } of bad) {
      const result = buildIssuedProject(source, fullSelection(), identity);
      assert.equal(result.ok, false, path);
      if (!result.ok) {
        assert.ok(
          result.errors.some((e) => e.path === path && e.code === "bad-identity"),
          `${path}: ${JSON.stringify(result.errors)}`,
        );
      }
    }
    const boundary: BuilderIdentity = {
      customerLabel: "x".repeat(256),
      jobReference: "y".repeat(256),
      issuedBy: "z".repeat(256),
      projectId: "w".repeat(256),
    };
    assert.equal(buildIssuedProject(source, fullSelection(), boundary).ok, true);
  });

  it("never mutates its inputs", () => {
    const source = readProject();
    const selection = fullSelection();
    const before = canonicalJson({ source, selection, identity: IDENTITY });
    const result = buildIssuedProject(source, selection, IDENTITY);
    assert.equal(result.ok, true);
    assert.equal(canonicalJson({ source, selection, identity: IDENTITY }), before);
  });

  it("is deterministic: identical inputs yield identical canonical JSON", () => {
    const first = buildIssuedProject(readProject(), fullSelection(), IDENTITY);
    const second = buildIssuedProject(readProject(), fullSelection(), IDENTITY);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(canonicalJson(first.project), canonicalJson(second.project));
  });

  it("selectIssuedAssets prunes to referenced URIs, preserves bytes, sorts by path", () => {
    const issuedResult = buildIssuedProject(
      readProject(),
      { productIds: ["SYN-TEE-001"], logoIds: ["SYN-LOGO-A"] },
      IDENTITY,
    );
    assert.equal(issuedResult.ok, true);
    if (!issuedResult.ok) return;
    const bytesA = readAssetBytes("logos/syn-mark-a.svg");
    const bytesB = readAssetBytes("logos/syn-mark-b.svg");
    const unused = new Uint8Array([1, 2, 3]);
    const selected = selectIssuedAssets(
      [
        { path: "logos/syn-mark-b.svg", bytes: bytesB },
        { path: "extra/unused.bin", bytes: unused },
        { path: "logos/syn-mark-a.svg", bytes: bytesA },
      ],
      issuedResult.project,
    );
    assert.deepEqual(
      selected.map((entry) => entry.path),
      ["logos/syn-mark-a.svg"],
    );
    assert.ok(selected[0]?.bytes === bytesA);

    const fullIssued = buildIssuedProject(readProject(), fullSelection(), IDENTITY);
    assert.equal(fullIssued.ok, true);
    if (!fullIssued.ok) return;
    const both = selectIssuedAssets(
      [
        { path: "logos/syn-mark-b.svg", bytes: bytesB },
        { path: "logos/syn-mark-a.svg", bytes: bytesA },
      ],
      fullIssued.project,
    );
    assert.deepEqual(
      both.map((entry) => entry.path),
      ["logos/syn-mark-a.svg", "logos/syn-mark-b.svg"],
    );
    assert.ok(both[0]?.bytes === bytesA);
    assert.ok(both[1]?.bytes === bytesB);

    assert.throws(() =>
      selectIssuedAssets(
        [
          { path: "logos/syn-mark-a.svg", bytes: bytesA },
          { path: "logos/syn-mark-a.svg", bytes: bytesA },
        ],
        fullIssued.project,
      ),
    );
  });

  it("issues the explicit identity projectId deterministically (source ID not carried over)", () => {
    const source = readProject();
    const first = buildIssuedProject(source, fullSelection(), {
      ...IDENTITY,
      projectId: "ACME-ISSUE-002",
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.project.projectId, "ACME-ISSUE-002");
    assert.notEqual(first.project.projectId, source.projectId);
    assert.equal(first.project.revision, 1);
    assert.ok(first.project.description?.includes("ACME-ISSUE-002"));
    const second = buildIssuedProject(readProject(), fullSelection(), {
      ...IDENTITY,
      projectId: "ACME-ISSUE-002",
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(canonicalJson(second.project), canonicalJson(first.project));
  });

  it("logoIds: [] validates and issues with zero surviving placements and pruned assets", () => {
    const source = readProject();
    const selection: BuilderSelection = {
      productIds: ["SYN-TEE-001", "SYN-TR-001"],
      logoIds: [],
    };
    assert.equal(validateBuilderSelection(source, selection).ok, true);
    const result = buildIssuedProject(source, selection, IDENTITY);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.project.logos, []);
    assert.equal(
      result.project.configurations.reduce((n, c) => n + c.placements.length, 0),
      0,
    );
    assert.equal(validateProject(result.project).ok, true);
    // Zero surviving asset refs: selectIssuedAssets returns [] on the same
    // inputs that would resolve for a full issue.
    const bytesA = readAssetBytes("logos/syn-mark-a.svg");
    const bytesB = readAssetBytes("logos/syn-mark-b.svg");
    assert.deepEqual(
      selectIssuedAssets(
        [
          { path: "logos/syn-mark-a.svg", bytes: bytesA },
          { path: "logos/syn-mark-b.svg", bytes: bytesB },
        ],
        result.project,
      ),
      [],
    );
  });

  it("cross-rejects issues with different projectIds via importCustomerReturn", () => {
    const hash = (text: string): string =>
      createHash("sha256").update(text, "utf8").digest("hex");
    const first = buildIssuedProject(readProject(), fullSelection(), {
      ...IDENTITY,
      projectId: "ACME-ISSUE-A",
    });
    const second = buildIssuedProject(readProject(), fullSelection(), {
      ...IDENTITY,
      projectId: "ACME-ISSUE-B",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(importCustomerReturn(clone(first.project), first.project, hash).ok, true);
    // Same returned content against the other issue's baseline must fail on identity.
    const cross = importCustomerReturn(clone(first.project), second.project, hash);
    assert.equal(cross.ok, false);
    if (!cross.ok) {
      assert.ok(
        cross.errors.some((e) => e.path === "projectId"),
        JSON.stringify(cross.errors),
      );
    }
    const crossBack = importCustomerReturn(clone(second.project), first.project, hash);
    assert.equal(crossBack.ok, false);
  });

  it("selectIssuedAssets throws on a missing referenced asset URI", () => {
    const fullIssued = buildIssuedProject(readProject(), fullSelection(), IDENTITY);
    assert.equal(fullIssued.ok, true);
    if (!fullIssued.ok) return;
    const bytesA = readAssetBytes("logos/syn-mark-a.svg");
    assert.throws(
      () =>
        selectIssuedAssets([{ path: "logos/syn-mark-a.svg", bytes: bytesA }], fullIssued.project),
      /selectIssuedAssets: missing asset "logos\/syn-mark-b\.svg"/,
    );
  });

  it("exposes builder limits matching the contract", () => {
    assert.equal(BUILDER_LIMITS.maxLogos, 64);
    assert.equal(BUILDER_LIMITS.maxConfigurations, 64);
    assert.equal(BUILDER_LIMITS.maxIdChars, 256);
  });
});
