import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createProvisionalProduct } from "../src/core/project-builder/provisional-product.js";
import { validateProduct, validateProject } from "../src/core/validate.js";
import { addPlacement, placementSelector, updatePlacement } from "../src/core/project-editor/index.js";
import { buildCandidateExport } from "../src/core/export.js";
import { confirmRevision } from "../src/core/revisions.js";
import { parseGlb } from "../src/assets/glb.js";
import { validateSelfContained } from "../src/assets/validate.js";
import type { Placement, ProductDefinition, ProjectDocument } from "../src/core/types.js";
import { isRecord } from "../src/core/guards.js";
import {
  parsePresentationManifest,
  selectPresentationModel,
  selectPresentationPackageAssets,
  PRESENTATION_MANIFEST_PATH,
} from "../src/ui/customer-editor/presentation-assets.js";
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function provisionalProduct(id = "PREV-ONLY-1"): ProductDefinition {
  const made = createProvisionalProduct({ id });
  if (!made.ok) throw new Error("expected provisional product");
  return made.product;
}

function provisionalProject(product: ProductDefinition): ProjectDocument {
  return {
    schemaVersion: product.schemaVersion,
    projectId: "PREV-ONLY-PROJECT",
    synthetic: true,
    description: "preview-only draft",
    revision: 1,
    products: [product],
    logos: [],
    configurations: [{
      id: "cfg-preview",
      productId: product.id,
      variantId: product.variants[0]!.id,
      placements: [],
    }],
  } as ProjectDocument;
}

function placementOn(logoId: string): Placement {
  return {
    id: "p-preview",
    logoId,
    regionId: "NO-SUCH-REGION",
    method: "embroidery",
    pos: { xMm: 0, yMm: 0 },
    widthMm: 4,
    heightMm: 2,
    rotationDeg: 0,
  };
}

describe("preview-only: all-empty valid, partial-empty invalid, placements unrepresentable", () => {
  it("all-empty product validates; partial-empty shapes fail with preview-only-shape", () => {
    const product = provisionalProduct();
    assert.equal(validateProduct(product).ok, true);

    const noRegions = JSON.parse(JSON.stringify(product)) as ProductDefinition;
    const calibrated = JSON.parse(readFileSync(
      new URL("../../examples/products/syn-tee-001.product.json", import.meta.url),
      "utf8",
    )) as ProductDefinition;
    noRegions.calibrations = [...calibrated.calibrations];
    noRegions.regions = [];
    const noRegionsResult = validateProduct(noRegions);
    assert.equal(noRegionsResult.ok, false);
    assert.ok(noRegionsResult.errors.some((e) => e.code === "preview-only-shape"));

    const noCalibrations = JSON.parse(JSON.stringify(calibrated)) as ProductDefinition;
    noCalibrations.calibrations = [];
    const noCalResult = validateProduct(noCalibrations);
    assert.equal(noCalResult.ok, false);
    assert.ok(noCalResult.errors.some((e) => e.code === "preview-only-shape"));

    const emptyVariantIds = JSON.parse(JSON.stringify(calibrated)) as ProductDefinition;
    emptyVariantIds.variants[0]!.regionIds = [];
    const emptyVariantResult = validateProduct(emptyVariantIds);
    assert.equal(emptyVariantResult.ok, false);
    assert.ok(emptyVariantResult.errors.some((e) => e.code === "preview-only-shape"));
  });

  it("zero-placement preview-only project validates; any placement fails", () => {
    const product = provisionalProduct();
    const project = provisionalProject(product);
    assert.equal(validateProject(project).ok, true);

    const logo = JSON.parse(readFileSync(
      new URL("../../examples/logos/syn-mark-a.logo.json", import.meta.url),
      "utf8",
    )) as ProjectDocument["logos"][number];
    const withLogo = { ...project, logos: [logo] } as ProjectDocument;
    withLogo.configurations[0]!.placements = [placementOn(logo.id)];
    const result = validateProject(withLogo);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "dangling-ref" && e.path.includes("regionId")));
  });

  it("add/update placement on preview-only targets throws preview-only-unprepared-region", () => {
    const product = provisionalProduct();
    const project = provisionalProject(product);
    assert.throws(() => addPlacement(project, "cfg-preview", placementOn("SYN-LOGO-A")), /preview-only-unprepared-region/);
    const withPlacement = JSON.parse(JSON.stringify(project)) as ProjectDocument;
    withPlacement.configurations[0]!.placements = [{
      logoId: "SYN-LOGO-A",
      regionId: "NO-SUCH-REGION",
      method: "embroidery",
      pos: { xMm: 0, yMm: 0 },
      widthMm: 4,
      heightMm: 2,
      rotationDeg: 0,
    }];
    assert.throws(
      () => updatePlacement(withPlacement, "cfg-preview", { kind: "index", index: 0 }, { pos: { xMm: 1, yMm: 1 } }),
      /preview-only-unprepared-region/,
    );
    void placementSelector;
  });

  it("confirmRevision throws on preview-only placements (defense in depth)", () => {
    const product = provisionalProduct();
    const project = provisionalProject(product);
    project.configurations[0]!.placements = [{
      logoId: "SYN-LOGO-A",
      regionId: "NO-SUCH-REGION",
      method: "embroidery",
      pos: { xMm: 0, yMm: 0 },
      widthMm: 4,
      heightMm: 2,
      rotationDeg: 0,
    }];
    assert.throws(
      () => confirmRevision(project, { confirmedBy: "synthetic-customer", digestOf: "0".repeat(64) }, hashText),
      /preview-only product/,
    );
  });

  it("candidate export of preview-only config has zero placements and no frame/calibration leakage", () => {
    const product = provisionalProduct();
    const project = provisionalProject(product);
    const candidate = buildCandidateExport(project, hashText);
    assert.equal(candidate.configurations.length, 1);
    assert.deepEqual(candidate.configurations[0]!.placements, []);
    assert.ok(!JSON.stringify(candidate.configurations[0]).includes("frameId"));
    assert.ok(!JSON.stringify(candidate.configurations[0]).includes("calibrationId"));

    const bad = JSON.parse(JSON.stringify(project)) as ProjectDocument;
    bad.configurations[0]!.placements = [{
      logoId: "SYN-LOGO-A",
      regionId: "NO-SUCH-REGION",
      method: "embroidery",
      pos: { xMm: 0, yMm: 0 },
      widthMm: 4,
      heightMm: 2,
      rotationDeg: 0,
    }];
    assert.throws(() => buildCandidateExport(bad, hashText), /preview-only product/);
  });

  it("logos present with zero placements still exports fine; calibrated products unaffected", () => {
    const empty = JSON.parse(readFileSync(
      new URL("../../examples/projects/project-empty.project.json", import.meta.url),
      "utf8",
    )) as ProjectDocument;
    const logo = JSON.parse(readFileSync(
      new URL("../../examples/logos/syn-mark-a.logo.json", import.meta.url),
      "utf8",
    )) as ProjectDocument["logos"][number];
    const withLogos = { ...empty, logos: [logo] } as ProjectDocument;
    assert.equal(validateProject(withLogos).ok, true);
    const candidate = buildCandidateExport(withLogos, hashText);
    assert.equal(candidate.configurations[0]!.placements.length, 0);

    const multi = JSON.parse(readFileSync(
      new URL("../../examples/projects/project-multi.project.json", import.meta.url),
      "utf8",
    )) as ProjectDocument;
    assert.equal(validateProject(multi).ok, true);
    const multiCandidate = buildCandidateExport(multi, hashText);
    assert.ok(multiCandidate.configurations.some((c) => c.placements.length > 0));
  });
});

describe("hardening: external-reference GLBs rejected at the read boundary", () => {
  function glbJsonBytes(payload: unknown): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const padded = json.length + ((4 - (json.length % 4)) % 4);
    const total = 12 + 8 + padded;
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, padded, true);
    view.setUint32(16, 0x4e4f534a, true);
    bytes.set(json, 20);
    bytes.fill(0x20, 20 + json.length);
    return bytes;
  }

  function makePixel(): Uint8Array {
    const pixel = new Uint8Array(33);
    const view = new DataView(pixel.buffer);
    pixel.set([137, 80, 78, 71, 13, 10, 26, 10]);
    view.setUint32(8, 13);
    view.setUint32(12, 0x49484452);
    view.setUint32(16, 20);
    view.setUint32(20, 10);
    return pixel;
  }

  function setBufferUri(payload: Record<string, unknown>, uri: string): void {
    const buffers = payload["buffers"];
    if (Array.isArray(buffers)) {
      const first = buffers[0];
      if (isRecord(first)) first["uri"] = uri;
    }
  }
  function minimalPayload(): Record<string, unknown> {
    return {
      asset: { version: "2.0" },
      scene: 0,
      buffers: [{ byteLength: 72 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 36 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 1], max: [1, 1, 1] },
      ],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0 } }] },
        { primitives: [{ attributes: { POSITION: 1 } }] },
      ],
      nodes: [{ mesh: 0 }, { mesh: 1 }],
      scenes: [{ nodes: [0, 1] }],
    };
  }

  it("header-valid GLB with sibling/absolute URIs yields a blocking external-uri issue (advisories alone pass)", () => {
    for (const uri of ["model.bin", "https://example.invalid/model.bin"]) {
      const payload = minimalPayload();
      setBufferUri(payload, uri);
      const parsed = parseGlb(glbJsonBytes(payload));
      const issues = validateSelfContained(parsed.json);
      assert.ok(issues.some((issue) => issue.code === "asset-external-uri"), `expected asset-external-uri for ${uri}`);
      assert.ok(issues.filter((issue) => !issue.code.endsWith("-advisory")).length > 0);
    }
    const clean = validateSelfContained(parseGlb(glbJsonBytes(minimalPayload())).json);
    assert.deepEqual(clean, []);
  });

  it("read-boundary model selection drops the external-uri model with a warning and no path", () => {
    const payload = minimalPayload();
    setBufferUri(payload, "model.bin");
    const lookup = (path: string): Uint8Array | undefined =>
      path === "presentation/model.glb" ? glbJsonBytes(payload) : undefined;
    const manifest = parsePresentationManifest(new TextEncoder().encode(JSON.stringify({
      version: 2,
      views: [],
      models: [{ productId: "p", variantId: "v", model: "presentation/model.glb" }],
    })));
    const selected = selectPresentationModel(manifest, true, "p", "v", lookup);
    assert.equal(selected.modelPath, null);
    assert.match(selected.warning ?? "", /external reference|self-contained/i);
    const untouched = parsePresentationManifest(new TextEncoder().encode(JSON.stringify({
      version: 2,
      views: [],
      models: [{ productId: "p", variantId: "v", model: "presentation/model.glb" }],
    })));
    assert.notEqual(untouched, null);
  });

  it("package-asset retention drops the external-uri model entry while keeping a valid raster view", () => {
    const payload = minimalPayload();
    setBufferUri(payload, "model.bin");
    const pixel = makePixel();
    const manifestBytes = new TextEncoder().encode(JSON.stringify({
      version: 2,
      views: [{ productId: "p", variantId: "v", view: "front", image: "presentation/front.png" }],
      models: [{ productId: "p", variantId: "v", model: "presentation/model.glb" }],
    }));
    const out = selectPresentationPackageAssets([
      { path: PRESENTATION_MANIFEST_PATH, bytes: manifestBytes, kind: "additional" },
      { path: "presentation/front.png", bytes: pixel, kind: "additional" },
      { path: "presentation/model.glb", bytes: glbJsonBytes(payload), kind: "additional" },
    ], [{ productId: "p", variantId: "v" }]);
    const rewrittenText = new TextDecoder().decode(out[0]!.bytes);
    const rewritten = JSON.parse(rewrittenText) as { views: Array<{ image: string }>; models?: unknown[] };
    assert.deepEqual(rewritten.views.map((entry) => entry.image), ["presentation/front.png"]);
    assert.ok(!("models" in rewritten) || (rewritten.models ?? []).length === 0);
    assert.deepEqual(out.slice(1).map((entry) => entry.path), ["presentation/front.png"]);
  });
});

describe("hardening: artwork-bearing project with a preview-only product", () => {
  function mixedProject(): ProjectDocument {
    const empty = JSON.parse(readFileSync(
      new URL("../../examples/projects/project-empty.project.json", import.meta.url),
      "utf8",
    )) as ProjectDocument;
    const preview = provisionalProduct("PREV-ONLY-1");
    const logoA = JSON.parse(readFileSync(
      new URL("../../examples/logos/syn-mark-a.logo.json", import.meta.url),
      "utf8",
    )) as ProjectDocument["logos"][number];
    const logoB = JSON.parse(readFileSync(
      new URL("../../examples/logos/syn-mark-b.logo.json", import.meta.url),
      "utf8",
    )) as ProjectDocument["logos"][number];
    return {
      ...structuredClone(empty),
      projectId: "SYN-PROJ-HARDEN-PREV",
      products: [...structuredClone(empty).products, preview],
      logos: [logoA, logoB],
      configurations: [
        ...structuredClone(empty).configurations,
        { id: "cfg-preview", productId: preview.id, variantId: preview.variants[0]!.id, placements: [] },
      ],
    } as ProjectDocument;
  }

  it("validateProject accepts artwork + empty preview-only config; a preview-only placement fails dangling-ref", () => {
    const project = mixedProject();
    assert.equal(validateProject(project).ok, true);
    const bad = structuredClone(project);
    bad.configurations.find((entry) => entry.id === "cfg-preview")!.placements = [placementOn("SYN-LOGO-A")];
    const result = validateProject(bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === "dangling-ref" && e.path.includes("regionId")));
  });

  it("addPlacement throws on the preview-only config yet adds on the calibrated one; confirmRevision defends in depth", () => {
    const project = mixedProject();
    assert.throws(() => addPlacement(project, "cfg-preview", placementOn("SYN-LOGO-A")), /preview-only-unprepared-region/);
    const cap = project.configurations[0]!;
    const fitting = {
      ...placementOn("SYN-LOGO-A"),
      regionId: "SYN-CAP-FRONT",
      method: "embroidery",
      widthMm: 20,
      heightMm: 10,
    };
    const next = addPlacement(project, cap.id, fitting);
    assert.equal(next.configurations.find((entry) => entry.id === cap.id)!.placements.length, 1);
    const tampered = structuredClone(next);
    tampered.configurations.find((entry) => entry.id === "cfg-preview")!.placements = [placementOn("SYN-LOGO-A")];
    assert.throws(
      () => confirmRevision(tampered, { confirmedBy: "synthetic-customer", digestOf: "0".repeat(64) }, hashText),
      /preview-only product/,
    );
  });

  it("candidate export carries the calibrated placement; the preview-only config exports empty without leakage", () => {
    const project = mixedProject();
    const cap = project.configurations[0]!;
    const withPlacement = addPlacement(project, cap.id, {
      ...placementOn("SYN-LOGO-A"),
      regionId: "SYN-CAP-FRONT",
      method: "embroidery",
      widthMm: 20,
      heightMm: 10,
    });
    const candidate = buildCandidateExport(withPlacement, hashText);
    const calibrated = candidate.configurations.find((entry) => entry.id === cap.id)!;
    const preview = candidate.configurations.find((entry) => entry.id === "cfg-preview")!;
    assert.equal(calibrated.placements.length, 1);
    assert.ok(JSON.stringify(calibrated.placements[0]).includes("frameId"));
    assert.deepEqual(preview.placements, []);
    assert.ok(!JSON.stringify(preview).includes("frameId"));
  });
});
