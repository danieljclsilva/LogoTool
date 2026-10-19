import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { buildCandidateExport } from "../src/core/index.js";
import type {
  Configuration,
  ProjectDocument,
  Region,
  Sha256HexFn,
} from "../src/core/index.js";
import { buildOperationDocument } from "../src/core/operation-document/index.js";
import type { BuildOperationDocumentInput } from "../src/core/operation-document/types.js";
import { MAX_PREVIEW_BYTES } from "../src/assets/raster-header.js";

const sha256Text: Sha256HexFn = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function makeChestRegion(extra?: Partial<Region>): Region {
  return {
    id: "chest",
    name: "Chest",
    frame: {
      frameId: "chest-frame",
      originDescription: "Centre of chest",
      axes: { xPositive: "wearer right", yPositive: "wearer up" },
    },
    calibrationRef: { calibrationId: "cal-1", version: "v1" },
    safeArea: [
      [0, 0],
      [200, 0],
      [200, 150],
      [0, 150],
    ],
    allowedMethods: ["embroider", "print"],
    ...extra,
  };
}

/** Minimal header-valid PNG: real IHDR values, unchecked CRC (header-only validation). */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

/** Minimal header-valid JPEG (SOI + SOF0 with explicit dimensions). */
function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    0x00, 0x02, 0x00, 0x03, 0x01, 0x11, 0x00, 0x00,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  assert.equal(bytes.length, 15);
  return bytes;
}

/** Minimal header-valid WebP (VP8X with explicit dimensions). */
function webpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const packedWidth = width - 1;
  const packedHeight = height - 1;
  bytes[24] = packedWidth & 0xff;
  bytes[25] = (packedWidth >> 8) & 0xff;
  bytes[26] = (packedWidth >> 16) & 0xff;
  bytes[27] = packedHeight & 0xff;
  bytes[28] = (packedHeight >> 8) & 0xff;
  bytes[29] = (packedHeight >> 16) & 0xff;
  return bytes;
}

function svgBytes(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
}

function makeProject(extraLogos?: string[]): ProjectDocument {
  const placements: Configuration["placements"] = [
    {
      logoId: "logo-a",
      regionId: "chest",
      method: "embroider",
      pos: { xMm: 100, yMm: 75 },
      widthMm: 60,
      heightMm: 40,
      rotationDeg: 30,
    },
  ];
  for (const logoId of extraLogos ?? []) {
    placements.push({
      logoId,
      regionId: "chest",
      method: "print",
      pos: { xMm: 50, yMm: 50 },
      widthMm: 30,
      heightMm: 20,
      rotationDeg: -15,
    });
  }
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "opdoc-assets",
    revision: 4,
    products: [{
      schemaVersion: "0.1.0-provisional",
      id: "polo",
      name: "Polo shirt",
      kind: "upper-body",
      variants: [
        { id: "m", name: "Medium", regionIds: ["chest"] },
        { id: "l", name: "Large", regionIds: ["chest"] },
      ],
      regions: [makeChestRegion()],
      calibrations: [{ id: "cal-1", version: "v1" }],
    }],
    logos: [
      {
        schemaVersion: "0.1.0-provisional",
        id: "logo-a",
        name: "Logo A",
        assets: [{ uri: "logos/mark.png", role: "original", mediaType: "image/png" }],
      },
      {
        schemaVersion: "0.1.0-provisional",
        id: "logo-b",
        name: "Logo B",
        assets: [{ uri: "logos/other.svg", role: "reference", mediaType: "image/svg+xml" }],
      },
    ],
    configurations: [
      { id: "cfg-m", productId: "polo", variantId: "m", placements: [placements[0]!] },
      {
        id: "cfg-l",
        productId: "polo",
        variantId: "l",
        placements: placements.slice(1).map((placement) => ({ ...placement })),
      },
    ],
  };
}

function inputWithAssets(project: ProjectDocument, assets: Record<string, Uint8Array>): BuildOperationDocumentInput {
  const candidate = buildCandidateExport(project, sha256Text);
  return { candidate, assetBytes: assets };
}

describe("operation-document assets and revisions", () => {
  it("derives from the exact candidate revision and digest with a truncated display form", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });
    assert.equal(doc.identity.projectId, project.projectId);
    assert.equal(doc.identity.revision, project.revision);
    assert.equal(doc.identity.digest, candidate.digest);
    assert.equal(doc.identity.shortDigest, candidate.digest.slice(0, 16));
    assert.equal(doc.identity.shortDigest.length, 16);
    assert.equal(doc.identity.reviewStatus, "candidate-pending-review");

    const revised = structuredClone(project);
    revised.revision += 1;
    revised.instructions = "Handle with care.";
    const nextCandidate = buildCandidateExport(revised, sha256Text);
    const nextDoc = buildOperationDocument({ candidate: nextCandidate });
    assert.equal(nextDoc.identity.revision, project.revision + 1);
    assert.notEqual(nextDoc.identity.digest, doc.identity.digest);
    assert.equal(nextDoc.identity.digest, nextCandidate.digest);
    assert.equal(nextDoc.projectInstructions, "Handle with care.");
    assert.equal(nextDoc.identity.reviewStatus, "candidate-pending-review");
  });

  it("is deterministic and never mutates the candidate or asset inputs", () => {
    const project = makeProject();
    const assets: Record<string, Uint8Array> = { "logos/mark.png": pngBytes(20, 10) };
    const assetSnapshot = JSON.stringify(
      Object.entries(assets).map(([path, bytes]) => [path, bytes.length, bytes[0]]),
    );
    const candidate = buildCandidateExport(project, sha256Text);
    const candidateBefore = JSON.stringify(candidate);
    const first = buildOperationDocument(inputWithAssets(project, assets));
    const second = buildOperationDocument({
      candidate: JSON.parse(candidateBefore),
      assetBytes: { "logos/mark.png": pngBytes(20, 10) },
    });
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(candidate), candidateBefore);
    assert.equal(
      JSON.stringify(Object.entries(assets).map(([path, bytes]) => [path, bytes.length, bytes[0]])),
      assetSnapshot,
    );
  });

  it("numbers placements consistently 1-based per configuration", () => {
    const project = makeProject(["logo-b"]);
    project.configurations[0]!.placements.push({
      logoId: "logo-b",
      regionId: "chest",
      method: "print",
      pos: { xMm: 10, yMm: 10 },
      widthMm: 20,
      heightMm: 10,
      rotationDeg: 0,
    });
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });
    assert.deepEqual(
      doc.configurations.map((configuration) => configuration.placements.map((placement) => placement.displayIndex)),
      [[1, 2], [1]],
    );
  });

  it("marks validated raster originals inline with dimensions, and distinguishes every failure", () => {
    const project = makeProject();
    const assets: Record<string, Uint8Array> = {
      "logos/mark.png": pngBytes(20, 10),
    };
    const doc = buildOperationDocument(inputWithAssets(project, assets));
    const preview = doc.configurations[0]!.placements[0]!.artwork.assets[0]!.preview;
    assert.equal(preview.status, "inline-raster");
    assert.equal(preview.mediaType, "image/png");
    assert.equal(preview.widthPx, 20);
    assert.equal(preview.heightPx, 10);
    assert.equal(preview.byteLength, assets["logos/mark.png"]!.length);
  });

  it("reports not-supplied when no asset bytes are provided, missing when a path is absent", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const withoutMap = buildOperationDocument({ candidate });
    assert.equal(
      withoutMap.configurations[0]!.placements[0]!.artwork.assets[0]!.preview.status,
      "not-supplied",
    );
    const withEmptyMap = buildOperationDocument({ candidate, assetBytes: {} });
    assert.equal(
      withEmptyMap.configurations[0]!.placements[0]!.artwork.assets[0]!.preview.status,
      "missing",
    );
  });

  it("rejects oversized bytes, non-raster originals and corrupt content", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const oversized = new Uint8Array(MAX_PREVIEW_BYTES + 1);
    assert.equal(
      buildOperationDocument({ candidate, assetBytes: { "logos/mark.png": oversized } })
        .configurations[0]!.placements[0]!.artwork.assets[0]!.preview.status,
      "too-large",
    );
    const svgProject = makeProject();
    svgProject.logos[0]!.assets[0]!.uri = "logos/mark.svg";
    const svgCandidate = buildCandidateExport(svgProject, sha256Text);
    assert.equal(
      buildOperationDocument({ candidate: svgCandidate, assetBytes: { "logos/mark.svg": svgBytes() } })
        .configurations[0]!.placements[0]!.artwork.assets[0]!.preview.status,
      "unsupported",
    );
    const truncated = pngBytes(20, 10).slice(0, 10);
    assert.equal(
      buildOperationDocument({ candidate, assetBytes: { "logos/mark.png": truncated } })
        .configurations[0]!.placements[0]!.artwork.assets[0]!.preview.status,
      "corrupt",
    );
  });

  it("treats header/pixel-cap violations as corrupt and accepts JPEG and WebP originals", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const huge = pngBytes(9000, 9000);
    assert.equal(
      buildOperationDocument({ candidate, assetBytes: { "logos/mark.png": huge } })
        .configurations[0]!.placements[0]!.artwork.assets[0]!.preview.status,
      "corrupt",
    );
    const jpegProject = makeProject();
    jpegProject.logos[0]!.assets[0]!.uri = "logos/mark.jpg";
    const jpegCandidate = buildCandidateExport(jpegProject, sha256Text);
    const jpeg = buildOperationDocument({
      candidate: jpegCandidate,
      assetBytes: { "logos/mark.jpg": jpegBytes(3, 2) },
    }).configurations[0]!.placements[0]!.artwork.assets[0]!.preview;
    assert.equal(jpeg.status, "inline-raster");
    assert.equal(jpeg.mediaType, "image/jpeg");
    assert.equal(jpeg.widthPx, 3);
    assert.equal(jpeg.heightPx, 2);
    const webpProject = makeProject();
    webpProject.logos[0]!.assets[0]!.uri = "logos/mark.webp";
    const webpCandidate = buildCandidateExport(webpProject, sha256Text);
    const webp = buildOperationDocument({
      candidate: webpCandidate,
      assetBytes: { "logos/mark.webp": webpBytes(5, 4) },
    }).configurations[0]!.placements[0]!.artwork.assets[0]!.preview;
    assert.equal(webp.status, "inline-raster");
    assert.equal(webp.mediaType, "image/webp");
    assert.equal(webp.widthPx, 5);
    assert.equal(webp.heightPx, 4);
  });

  it("rejects raster bytes whose header disagrees with the file extension", () => {
    const project = makeProject();
    project.logos[0]!.assets[0]!.uri = "logos/mark.jpg";
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({
      candidate,
      assetBytes: { "logos/mark.jpg": pngBytes(4, 4) },
    });
    assert.equal(
      doc.configurations[0]!.placements[0]!.artwork.assets[0]!.preview.status,
      "corrupt",
    );
  });

  it("resolves region names, flags unresolved safe areas and keeps diagram data exact", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });
    const placement = doc.configurations[0]!.placements[0]!;
    assert.equal(placement.regionName, "Chest");
    assert.equal(placement.diagram.safeSupplied, true);
    assert.equal(placement.diagram.safePolygon.length, 4);

    const brokenCandidate = structuredClone(candidate);
    brokenCandidate.products[0]!.regions = [];
    const brokenDoc = buildOperationDocument({ candidate: brokenCandidate });
    const brokenPlacement = brokenDoc.configurations[0]!.placements[0]!;
    assert.equal(brokenPlacement.regionName, null);
    assert.equal(brokenPlacement.diagram.safeSupplied, false);
    assert.equal(brokenPlacement.diagram.safePolygon.length, 0);
    assert.ok(brokenPlacement.diagram.viewBox.width > 0);
  });

  it("scopes reference inputs by own key, including __proto__ configuration ids", () => {
    const project = makeProject();
    project.configurations[0]!.id = "__proto__";
    const candidate = buildCandidateExport(project, sha256Text);
    // Own-key map (as produced by JSON.parse): the hostile id resolves.
    const owned = JSON.parse('{"__proto__": [{"view": "front", "imagePath": "presentation/front.png", "label": "Front"}]}');
    const doc = buildOperationDocument({
      candidate,
      assetBytes: {
        "logos/mark.png": pngBytes(20, 10),
        "presentation/front.png": pngBytes(8, 4),
      },
      referenceViews: owned,
    });
    assert.equal(doc.configurations[0]!.referenceViews.length, 1);
    assert.equal(doc.configurations[0]!.referenceViews[0]!.view, "front");
    assert.equal(doc.configurations[0]!.referenceNote, null);
    // Plain-object map without the key: no prototype leakage, explicit note.
    const plain: Record<string, readonly { view: string | null; imagePath: string; label?: string | null }[]> = {};
    const bare = buildOperationDocument({ candidate, assetBytes: {}, referenceViews: plain });
    assert.deepEqual(bare.configurations[0]!.referenceViews, []);
    assert.equal(bare.configurations[0]!.referenceNote, "No product reference supplied for this configuration in the package.");
  });

  it("carries caller-selected reference views with previews and explicit missing notes", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({
      candidate,
      assetBytes: {
        "logos/mark.png": pngBytes(20, 10),
        "presentation/front.png": pngBytes(8, 4),
      },
      referenceViews: {
        "cfg-m": [{ view: "front", imagePath: "presentation/front.png", label: "Front view" }],
      },
      referenceWarnings: {
        "cfg-l": "Reference image \u201cpresentation/front.png\u201d is missing or too large; showing the measured diagram instead.",
      },
    });
    const first = doc.configurations[0]!;
    assert.equal(first.referenceViews.length, 1);
    assert.equal(first.referenceViews[0]!.view, "front");
    assert.equal(first.referenceViews[0]!.imagePath, "presentation/front.png");
    assert.equal(first.referenceViews[0]!.label, "Front view");
    assert.equal(first.referenceViews[0]!.preview.status, "inline-raster");
    assert.equal(first.referenceNote, null);
    const second = doc.configurations[1]!;
    assert.equal(second.referenceViews.length, 0);
    assert.ok(second.referenceNote!.includes("missing or too large"));
    const unselected = buildOperationDocument({ candidate });
    assert.equal(
      unselected.configurations[0]!.referenceNote,
      "No product reference supplied for this configuration in the package.",
    );
    assert.equal(unselected.configurations[0]!.referenceViews.length, 0);
  });

  it("keeps zero-placement configurations explicit with reference status", () => {
    const project = makeProject();
    project.configurations[1]!.placements = [];
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });
    assert.equal(doc.configurations[1]!.placements.length, 0);
    assert.equal(
      doc.configurations[1]!.referenceNote,
      "No product reference supplied for this configuration in the package.",
    );
  });
});
