import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { buildCandidateExport } from "../src/core/index.js";
import type { ProjectDocument, Region, Sha256HexFn } from "../src/core/index.js";
import {
  buildOperationDocument,
  buildOperationSheetView,
  formatMm1,
  matchLogoRef,
  OPERATION_SHEET_VIEW_VERSION,
} from "../src/core/operation-document/index.js";
import type { AnchorDef } from "../src/core/operation-measurements/types.js";
import { evaluateOperationPhotoStates } from "../src/ui/shared/operation-document/assets.js";

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

function makeProject(): ProjectDocument {
  const region = makeChestRegion();
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "opdoc-test",
    revision: 1,
    products: [{
      schemaVersion: "0.1.0-provisional",
      id: "polo",
      name: "Polo shirt",
      kind: "upper-body",
      variants: [
        { id: "m", name: "Medium", regionIds: ["chest"] },
        { id: "l", name: "Large", regionIds: ["chest"] },
      ],
      regions: [region],
      calibrations: [{ id: "cal-1", version: "v1" }],
    }],
    logos: [{
      schemaVersion: "0.1.0-provisional",
      id: "logo-a",
      name: "Logo A",
      assets: [{
        uri: "logo-a.svg",
        role: "reference",
        mediaType: "image/svg+xml",
        sha256Hex: "a".repeat(64),
      }],
    }],
    configurations: [
      {
        id: "cfg-m",
        productId: "polo",
        variantId: "m",
        placements: [{
          logoId: "logo-a",
          regionId: "chest",
          method: "embroider",
          pos: { xMm: 100, yMm: 75 },
          widthMm: 60,
          heightMm: 40,
          rotationDeg: 30,
        }],
      },
      {
        id: "cfg-l",
        productId: "polo",
        variantId: "l",
        placements: [],
      },
    ],
  };
}

describe("buildOperationDocument", () => {
  it("produces identity from candidate and optional review evidence", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({
      candidate,
      generatedAt: "2026-10-15T10:00:00.000Z",
      customerConfirmation: "Confirmed by Synthetic customer",
      internalReview: "approved by reviewer (workflow only)",
    });

    assert.equal(doc.identity.projectId, project.projectId);
    assert.equal(doc.identity.revision, project.revision);
    assert.equal(doc.identity.digest, candidate.digest);
    assert.equal(doc.identity.schemaVersion, "0.1.0-provisional");
    assert.equal(doc.identity.reviewStatus, "candidate-pending-review");
    assert.equal(doc.identity.generatedAt, "2026-10-15T10:00:00.000Z");
    assert.equal(doc.identity.customerConfirmation, "Confirmed by Synthetic customer");
    assert.equal(doc.identity.internalReview, "approved by reviewer (workflow only)");
    assert.ok(doc.identity.calibrationStatus.includes("unresolved"));
  });

  it("omits generatedAt and review evidence when not supplied", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    assert.equal(doc.identity.generatedAt, undefined);
    assert.equal(doc.identity.customerConfirmation, undefined);
    assert.equal(doc.identity.internalReview, undefined);
  });

  it("lists required limitations", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    const text = doc.limitations.join(" ");
    assert.ok(text.includes("Illustrative"));
    assert.ok(text.includes("not to scale"));
    assert.ok(text.includes("footprints only"));
    assert.ok(text.includes("Product reference views"));
    assert.ok(!text.includes("are absent"), "no blanket absent-claim when views may be present");
    assert.ok(text.includes("Calibration"));
    assert.ok(text.includes("candidate-pending-review"));
  });

  it("states no product photos when none are supplied", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });
    const text = doc.limitations.join(" ");
    assert.ok(text.includes("no product photos are in the package"));
    assert.ok(!text.includes("reference photo"));
  });

  it("states all-unmapped when photos are supplied without evaluated mappings", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({
      candidate,
      referenceViews: {
        "cfg-m": [{ view: "front", imagePath: "presentation/front.png", label: null }],
      },
    });
    const text = doc.limitations.join(" ");
    assert.ok(text.includes("1 reference photo supplied, all unmapped"));
    assert.ok(text.includes("no logo overlay on photos is calibrated"));
    assert.ok(!text.includes("no product photos are in the package"));
  });

  it("carries evaluated mapping bindings and raster artwork paths on the proof", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({
      candidate,
      referenceViews: {
        "cfg-m": [{ view: "front", imagePath: "presentation/front.png", label: null }],
      },
      photoStates: {
        "cfg-m": [{
          imagePath: "presentation/front.png",
          status: "provisional",
          regionId: "chest",
          view: "front",
          transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
        }],
      },
      assetBytes: {
        "presentation/front.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 20, 0, 0, 0, 10, 8, 2, 0, 0, 0, 1, 2, 3, 4]),
      },
    });
    const config = doc.proof.find((entry) => entry.configurationId === "cfg-m")!;
    assert.ok(config, "proof carries the configuration");
    const side = config.sides.find((entry) => entry.imagePath === "presentation/front.png")!;
    assert.ok(side, "proof carries the photo side");
    assert.equal(side.photoState, "mapped-provisional");
    assert.deepEqual(side.mapping, {
      regionId: "chest",
      view: "front",
      transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
      status: "provisional",
    });
    // Degenerate caller bindings never reach the renderer as mappings.
    const degenerate = buildOperationDocument({
      candidate,
      referenceViews: {
        "cfg-m": [{ view: "front", imagePath: "presentation/front.png", label: null }],
      },
      photoStates: {
        "cfg-m": [{
          imagePath: "presentation/front.png",
          status: "provisional",
          regionId: "chest",
          view: "front",
          transform: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 },
        }],
      },
    });
    const degenerateSide = degenerate.proof
      .find((entry) => entry.configurationId === "cfg-m")!
      .sides.find((entry) => entry.imagePath === "presentation/front.png")!;
    assert.equal(degenerateSide.mapping, null);
    assert.equal(degenerateSide.photoState, "mapped-provisional");
  });

  it("states bound mappings when an evaluated photo-mapping entry is supplied", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({
      candidate,
      referenceViews: {
        "cfg-m": [{ view: "front", imagePath: "presentation/front.png", label: null }],
      },
      photoStates: {
        "cfg-m": [{ imagePath: "presentation/front.png", status: "provisional" }],
      },
    });
    const text = doc.limitations.join(" ");
    assert.ok(text.includes("1 bound by evaluated photo-mapping entries (1 provisional, 0 under review)"));
    assert.ok(text.includes("visual trials only, never production approval"));
  });

  it("preserves all configurations including zero placements", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    assert.equal(doc.configurations.length, 2);
    const cfg0 = doc.configurations[0]!;
    const cfg1 = doc.configurations[1]!;
    assert.equal(cfg0.id, "cfg-m");
    assert.equal(cfg0.placements.length, 1);
    assert.equal(cfg1.id, "cfg-l");
    assert.equal(cfg1.placements.length, 0);
  });

  it("keeps exact unrounded mm dimensions and consistent 1-based numbering", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    const placement = doc.configurations[0]!.placements[0]!;
    assert.equal(placement.displayIndex, 1);
    assert.equal(placement.pos.xMm, 100);
    assert.equal(placement.pos.yMm, 75);
    assert.equal(placement.widthMm, 60);
    assert.equal(placement.heightMm, 40);
    assert.equal(placement.rotationDeg, 30);
  });

  it("computes rotated footprint and non-empty diagram viewBox", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    const placement = doc.configurations[0]!.placements[0]!;
    assert.equal(placement.diagram.footprint.length, 4);
    assert.ok(placement.diagram.viewBox.width > 0);
    assert.ok(placement.diagram.viewBox.height > 0);
    assert.equal(placement.diagram.safePolygon.length, 4);
  });

  it("maps exclusion polygons and axes labels from the region", () => {
    const region = makeChestRegion({
      exclusions: [
        [
          [50, 50],
          [80, 50],
          [80, 80],
          [50, 80],
        ],
      ],
    });
    const project: ProjectDocument = {
      schemaVersion: "0.1.0-provisional",
      projectId: "opdoc-exclusions",
      revision: 1,
      products: [{
        schemaVersion: "0.1.0-provisional",
        id: "polo",
        name: "Polo shirt",
        kind: "upper-body",
        variants: [{ id: "m", name: "Medium", regionIds: ["chest"] }],
        regions: [region],
        calibrations: [{ id: "cal-1", version: "v1" }],
      }],
      logos: [{
        schemaVersion: "0.1.0-provisional",
        id: "logo-a",
        name: "Logo A",
        assets: [{
          uri: "logo-a.svg",
          role: "reference",
          mediaType: "image/svg+xml",
          sha256Hex: "a".repeat(64),
        }],
      }],
      configurations: [{
        id: "cfg-m",
        productId: "polo",
        variantId: "m",
        placements: [{
          logoId: "logo-a",
          regionId: "chest",
          method: "embroider",
          pos: { xMm: 100, yMm: 75 },
          widthMm: 60,
          heightMm: 40,
          rotationDeg: 30,
        }],
      }],
    };
    const candidate = buildCandidateExport(project, sha256Text);
    const doc = buildOperationDocument({ candidate });

    const placement = doc.configurations[0]!.placements[0]!;
    assert.equal(placement.diagram.exclusions.length, 1);
    assert.equal(placement.diagram.exclusions[0]!.polygon.length, 4);
    assert.equal(placement.diagram.axes.xLabel, "wearer right");
    assert.equal(placement.diagram.axes.yLabel, "wearer up");
  });
  it("keeps true datum and exclusions inside the diagram and rotates clockwise in physical Y-up", () => {
    const project = makeProject();
    project.products[0]!.regions[0]!.safeArea = [[100,100], [300,100], [300,300], [100,300]];
    project.products[0]!.regions[0]!.exclusions = [[[400,400], [410,400], [410,410], [400,410]]];
    const placement = project.configurations[0]!.placements[0]!;
    placement.pos = { xMm: 150.123456789, yMm: 175.987654321 };
    placement.widthMm = 60.123456789;
    placement.rotationDeg = 90;
    const candidate = buildCandidateExport(project, sha256Text);
    const original = JSON.stringify(candidate);
    const doc = buildOperationDocument({ candidate });
    assert.equal(JSON.stringify(candidate), original);
    assert.deepEqual(doc, buildOperationDocument({ candidate }));
    const result = doc.configurations[0]!.placements[0]!;
    assert.equal(result.widthMm, 60.123456789);
    assert.equal(result.diagram.axes.originX, 0);
    assert.equal(result.diagram.axes.originY, 0);
    const corner = result.diagram.footprint[0]!;
    assert.ok(Math.abs(corner.x - (placement.pos.xMm - placement.heightMm / 2)) < 1e-10);
    assert.ok(Math.abs(corner.y - (placement.pos.yMm + placement.widthMm / 2)) < 1e-10);
    const box = result.diagram.viewBox;
    assert.ok(box.minX < 0 && box.minY < 0);
    assert.ok(box.minX + box.width > 410 && box.minY + box.height > 410);
  });

});

describe("buildOperationSheetView", () => {
  const anchor: AnchorDef = {
    id: "cf",
    name: "Centre front",
    productId: "polo",
    variantId: "m",
    regionId: "chest",
    frameId: "chest-frame",
    calibrationId: "cal-1",
    calibrationVersion: "v1",
    posMm: [100.05, 150],
  };

  it("versions the sheet contract independently and passes the job through", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [],
      bindings: {},
      job: { customer: "Synthetic Co", reference: "JOB-1" },
    });
    assert.equal(view.version, "operation-sheet-view/1");
    assert.equal(OPERATION_SHEET_VIEW_VERSION, "operation-sheet-view/1");
    assert.deepEqual(view.job, { customer: "Synthetic Co", reference: "JOB-1" });
    assert.equal(view.sheets.length, 2);
  });

  it("covers every configuration including explicit zero placements", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({ candidate, anchors: [], bindings: {} });
    const empty = view.sheets.find((sheet) => sheet.variantId === "l")!;
    assert.ok(empty, "zero-placement configuration still yields a sheet");
    assert.deepEqual(empty.logos, []);
  });

  it("maps sides, logo identity, and separately-labelled source notes", () => {
    const project = makeProject();
    project.instructions = "Handle with care.";
    project.configurations[0]!.placements[0]!.instructions = "Stitch slowly.";
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [anchor],
      bindings: {
        "cfg-m": [{
          logoRef: "logo-a",
          anchorId: "cf",
          edge: "maxY",
          convention: "dy",
          label: "centre front to top edge, vertical",
        }],
      },
      sides: { "cfg-m": [{ view: "front", imagePath: "presentation/front.png", label: "Front" }] },
      extras: { "cfg-m": { "logo-a": { methodParams: { density: "0.4" }, colours: ["navy"] } } },
    });
    const sheet = view.sheets[0]!;
    assert.deepEqual(sheet.sides, [{ view: "front", imagePath: "presentation/front.png", label: "Front" }]);
    const logo = sheet.logos[0]!;
    assert.equal(logo.logoName, "Logo A");
    assert.equal(logo.logoCode, "Logo A");
    assert.equal(logo.side, "Chest");
    assert.equal(logo.method, "embroider");
    assert.deepEqual(logo.dimensions.length, 1);
    // No department text was supplied, so there are no operational
    // instructions; customer notes stay in sourceNotes, never merged.
    assert.deepEqual(sheet.instructions, []);
    assert.deepEqual(sheet.sourceNotes, { placement: ["Stitch slowly."], project: "Handle with care." });
    assert.deepEqual(logo.methodParams, { density: "0.4" });
    assert.deepEqual(logo.colours, ["navy"]);
  });

  it("keeps exact millimetres with display rounding applied only at display", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [anchor],
      bindings: {
        "cfg-m": [{
          logoRef: "logo-a",
          anchorId: "cf",
          edge: "maxY",
          convention: "dy",
          label: "centre front to top edge, vertical",
        }],
      },
    });
    const logo = view.sheets[0]!.logos[0]!;
    // Rotation is 30 deg in the shared fixture: max-Y extent is
    // 75 + 30*sin(30) + 20*cos(30); anchor at y = 150.
    const expected = 150 - (75 + 30 * Math.sin(Math.PI / 6) + 20 * Math.cos(Math.PI / 6));
    assert.ok(Math.abs(logo.dimensions[0]!.valueMm - expected) < 1e-9);
    assert.equal(logo.dimensions[0]!.valueMm1, formatMm1(logo.dimensions[0]!.valueMm));
    assert.ok(logo.positionText.includes(`${logo.dimensions[0]!.valueMm1} mm`));
    // The rotated supporting line starts off-artwork here (anchor x 100.05
    // is not on the rotated top edge), so the dimension is honestly marked
    // extended with the extreme corner attached.
    assert.equal(logo.dimensions[0]!.touchesArtwork, false);
    assert.ok(logo.dimensions[0]!.artworkPoint !== undefined);
    assert.ok(logo.dimensions[0]!.toEdge.includes("supporting line extended beyond the artwork edge"));
  });

  it("marks missing bindings unfinished instead of guessing", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({ candidate, anchors: [], bindings: {} });
    const logo = view.sheets[0]!.logos[0]!;
    assert.deepEqual(logo.dimensions, []);
    assert.equal(logo.unfinished.length, 1);
    assert.ok(logo.positionText.startsWith("unfinished"));
  });

  it("keeps stale anchors unfinished while other logos still measure", () => {
    const project = makeProject();
    project.configurations[0]!.placements.push({
      logoId: "logo-a",
      regionId: "chest",
      method: "embroider",
      pos: { xMm: 50, yMm: 50 },
      widthMm: 40,
      heightMm: 20,
      rotationDeg: 0,
    });
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [{ ...anchor, id: "stale", calibrationVersion: "v9" }, anchor],
      bindings: {
        "cfg-m": [
          { logoRef: "logo-a", anchorId: "stale", edge: "maxY", convention: "dy", label: "stale cal" },
          { logoRef: "logo-a#1", anchorId: "cf", edge: "minX", convention: "dx", label: "left gap" },
        ],
      },
    });
    const [first, second] = view.sheets[0]!.logos;
    assert.equal(first!.dimensions.length, 0);
    assert.ok(first!.unfinished[0]!.includes("stale"));
    assert.equal(second!.dimensions.length, 1);
    assert.deepEqual(second!.unfinished, []);
  });

  it("falls back to business codes and positional names when logo names are absent", () => {
    const project = makeProject();
    delete project.products[0]!.regions[0]!.name;
    delete project.logos[0]!.name;
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [],
      bindings: {},
      extras: { "cfg-m": { "logo-a": { methodParams: { density: 7 as never }, colours: "navy" as never, businessCode: "EMB-7" } } },
    });
    const logo = view.sheets[0]!.logos[0]!;
    assert.equal(logo.logoName, "EMB-7");
    assert.equal(logo.logoCode, "EMB-7");
    assert.equal(logo.side, "chest");
    assert.equal(logo.methodParams, undefined);
    assert.equal(logo.colours, undefined);
    assert.ok(logo.positionText.startsWith("unfinished"), logo.positionText);
    assert.ok(!JSON.stringify(logo).includes("logo-a"), "raw customer logo id never leaks");
    // Without a business code either, the positional fallback names the logo.
    const plain = buildOperationSheetView({ candidate, anchors: [], bindings: {} });
    const plainLogo = plain.sheets[0]!.logos[0]!;
    assert.equal(plainLogo.logoName, "Logo 1");
    assert.equal(plainLogo.logoCode, "Logo 1");
    assert.ok(!JSON.stringify(plainLogo).includes("logo-a"), "raw customer logo id never leaks");
  });

  it("is deterministic", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const input = {
      candidate,
      anchors: [anchor],
      bindings: {
        "cfg-m": [{
          logoRef: "logo-a",
          anchorId: "cf",
          edge: "maxY" as const,
          convention: "dy" as const,
          label: "centre front to top edge, vertical",
        }],
      },
    };
    assert.deepEqual(buildOperationSheetView(input), buildOperationSheetView(input));
  });

  it("carries no digests, ids, calibration, frames, timestamps or history", () => {
    const project = makeProject();
    project.instructions = "Keep clear of the seam.";
    project.configurations[0]!.placements[0]!.instructions = "Stitch slowly.";
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [anchor],
      bindings: {
        "cfg-m": [{
          logoRef: "logo-a",
          anchorId: "cf",
          edge: "maxY",
          convention: "dy",
          label: "centre front to top edge, vertical",
        }],
      },
      job: { customer: "Synthetic Co", reference: "JOB-1", article: "Polo" },
      sides: { "cfg-m": [{ view: "front", imagePath: "presentation/front.png", label: "Front" }] },
      extras: { "cfg-m": { "logo-a": { methodParams: { density: "0.4" }, colours: ["navy"] } } },
      operationalInstructions: ["Check by eye before pressing."],
    });
    const text = JSON.stringify(view);
    for (const token of [
      "digest",
      "sha256",
      "shortDigest",
      "calibration",
      "frameId",
      "projectId",
      "configurationId",
      "schemaVersion",
      "generatedAt",
      "byteLength",
      "history",
      "timestamp",
      "revision",
      "status",
    ]) {
      assert.ok(!text.includes(`"${token}"`), `operator view must not carry ${token}`);
    }
  });

  it("keeps customer notes out of operational instructions, carrying them as source notes", () => {
    const project = makeProject();
    project.instructions = "Keep clear of the seam.";
    project.configurations[0]!.placements[0]!.instructions = "Stitch slowly.";
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [],
      bindings: {},
      job: { customer: "", reference: "JOB-1" },
      operationalInstructions: ["Check by eye before pressing."],
    });
    assert.deepEqual(view.job, { reference: "JOB-1" });
    const sheet = view.sheets[0]!;
    // Customer-only sentences are absent from operational instructions
    // unless staff also entered them as department text...
    assert.deepEqual(sheet.instructions, ["Check by eye before pressing."]);
    assert.ok(!sheet.instructions.includes("Stitch slowly."));
    assert.ok(!sheet.instructions.includes("Keep clear of the seam."));
    // ...but stay present as separately-labelled source context.
    assert.deepEqual(sheet.sourceNotes, { placement: ["Stitch slowly."], project: "Keep clear of the seam." });
    // Staff-copied text appears in instructions (allowed: staff entered it).
    const copied = buildOperationSheetView({
      candidate,
      anchors: [],
      bindings: {},
      operationalInstructions: ["Check by eye before pressing.", "Keep clear of the seam."],
    });
    assert.ok(copied.sheets[0]!.instructions.includes("Keep clear of the seam."));
    assert.deepEqual(copied.sheets[0]!.sourceNotes, {
      placement: ["Stitch slowly."],
      project: "Keep clear of the seam.",
    });
  });

  it("never leaks internal ids, digests, calibration, or artwork bytes through the operator view", () => {
    const project = makeProject();
    project.instructions = "Keep clear of the seam.";
    const exportPlacement = project.configurations[0]!.placements[0]!;
    exportPlacement.id = "p1";
    exportPlacement.instructions = "Stitch slowly.";
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [anchor],
      bindings: {
        "cfg-m": [{
          logoRef: "p1",
          anchorId: "cf",
          edge: "maxY",
          convention: "dy",
          label: "centre front to top edge, vertical",
        }],
      },
      job: { customer: "Synthetic Co", reference: "JOB-1", article: "Polo" },
      sides: { "cfg-m": [{ view: "front", imagePath: "presentation/front.png", label: "Front" }] },
      extras: { "cfg-m": { "p1": { businessCode: "EMB-7", colours: ["navy"], methodParams: { density: "0.4" } } } },
      operationalInstructions: ["Check by eye before pressing."],
    });
    const logo = view.sheets[0]!.logos[0]!;
    assert.equal(logo.dimensions.length, 1);
    assert.equal(logo.logoName, "Logo A");
    assert.equal(logo.logoCode, "EMB-7");
    const text = JSON.stringify(view);
    // Internal keys never appear.
    for (const token of [
      "logoId",
      "id",
      "digest",
      "shortDigest",
      "sha256",
      "calibration",
      "frameId",
      "configurationId",
      "projectId",
      "schemaVersion",
      "generatedAt",
      "byteLength",
      "history",
      "timestamp",
      "revision",
      "status",
    ]) {
      assert.ok(!text.includes(`"${token}"`), `operator view must not carry "${token}"`);
    }
    // Internal values never appear: raw logo/placement/configuration ids,
    // geometry ids, digests, artwork URIs. (sides[].imagePath package paths
    // stay — the renderer needs them to fetch bytes; they are relative
    // paths, not ids.)
    for (const secret of [
      candidate.digest,
      "logo-a",
      "p1",
      "cfg-m",
      "cfg-l",
      "chest-frame",
      "cal-1",
      "v1",
      "chest",
      "logo-a.svg",
      "opdoc-test",
      "0.1.0-provisional",
    ]) {
      assert.ok(!text.includes(secret), `operator view must not leak ${secret}`);
    }
    // The operator-relevant content stays: reference path, product identity,
    // department text, source notes, and the business code.
    assert.ok(text.includes("presentation/front.png"));
    assert.equal(view.sheets[0]!.productId, "polo");
    assert.equal(view.sheets[0]!.variantId, "m");
    assert.deepEqual(view.sheets[0]!.instructions, ["Check by eye before pressing."]);
    assert.deepEqual(view.sheets[0]!.sourceNotes, {
      placement: ["Stitch slowly."],
      project: "Keep clear of the seam.",
    });
  });
});

describe("matchLogoRef", () => {
  it("matches logo ids and repeated-logo occurrences without guessing", () => {
    const project = makeProject();
    project.configurations[0]!.placements.push({
      logoId: "logo-a",
      regionId: "chest",
      method: "embroider",
      pos: { xMm: 50, yMm: 50 },
      widthMm: 40,
      heightMm: 20,
      rotationDeg: 0,
    });
    const candidate = buildCandidateExport(project, sha256Text);
    const placements = candidate.configurations[0]!.placements;
    assert.equal(matchLogoRef(placements, "logo-a"), placements[0]);
    assert.equal(matchLogoRef(placements, "logo-a#0"), placements[0]);
    assert.equal(matchLogoRef(placements, "logo-a#1"), placements[1]);
    assert.equal(matchLogoRef(placements, "logo-a#7"), undefined);
    assert.equal(matchLogoRef(placements, "logo-a#x"), undefined);
    assert.equal(matchLogoRef(placements, "missing"), undefined);
    assert.equal(matchLogoRef(placements, ""), undefined);
  });

  it("prefers recorded placement ids over logo ids", () => {
    const project = makeProject();
    project.configurations[0]!.placements[0]!.id = "p1";
    const candidate = buildCandidateExport(project, sha256Text);
    const placements = candidate.configurations[0]!.placements;
    assert.equal(matchLogoRef(placements, "p1"), placements[0]);
  });
});

describe("evaluateOperationPhotoStates", () => {
  const mappingFile = (mappings: unknown[]): Uint8Array =>
    new TextEncoder().encode(JSON.stringify({ version: 1, mappings }));
  const manifestFile = (views: unknown[]): Uint8Array =>
    new TextEncoder().encode(JSON.stringify({ version: 2, views }));
  const entry = {
    productId: "polo",
    variantId: "m",
    regionId: "chest",
    view: "front",
    image: "presentation/front.png",
    transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
    calibrationId: "cal-1",
    calibrationVersion: "v1",
    status: "provisional",
  };
  const view = { productId: "polo", variantId: "m", view: "front", image: "presentation/front.png" };
  const photo = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 20, 0, 0, 0, 10, 8, 2, 0, 0, 0, 1, 2, 3, 4]);

  it("evaluates current bindings with geometry and drops stale ones", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const assets = new Map<string, Uint8Array>([
      ["presentation/preview.json", manifestFile([view])],
      ["presentation/front.png", photo],
      ["presentation/photo-mappings.json", mappingFile([entry])],
    ]);
    const states = evaluateOperationPhotoStates(candidate, assets);
    assert.deepEqual(Object.keys(states).sort(), ["cfg-l", "cfg-m"]);
    assert.equal(states["cfg-m"]!.length, 1);
    assert.deepEqual(states["cfg-m"]![0], {
      imagePath: "presentation/front.png",
      status: "provisional",
      regionId: "chest",
      view: "front",
      transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
    });
    // Stale calibration versions never evaluate.
    const stale = evaluateOperationPhotoStates(candidate, new Map([
      ["presentation/preview.json", manifestFile([view])],
      ["presentation/front.png", photo],
      ["presentation/photo-mappings.json", mappingFile([{ ...entry, calibrationVersion: "v9" }])],
    ]));
    assert.deepEqual(stale["cfg-m"], []);
    // Photos that are not declared preview views never evaluate.
    const undeclared = evaluateOperationPhotoStates(candidate, new Map([
      ["presentation/preview.json", manifestFile([view])],
      ["presentation/other.png", photo],
      ["presentation/photo-mappings.json", mappingFile([{ ...entry, image: "presentation/other.png" }])],
    ]));
    assert.deepEqual(undeclared["cfg-m"], []);
  });
});
