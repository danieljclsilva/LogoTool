import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { buildCandidateExport } from "../src/core/index.js";
import type { ProjectDocument, Region, Sha256HexFn } from "../src/core/index.js";
import {
  buildOperationSheetView,
  formatMm1,
  OPERATION_SHEET_VIEW_VERSION,
} from "../src/core/operation-document/index.js";
import type { OperationSheetView } from "../src/core/operation-document/types.js";
import type { AnchorDef } from "../src/core/operation-measurements/types.js";
import {
  evaluateOperationSheetOverlays,
  type OperationSheetAssetLookup,
  type SheetOverlay,
} from "../src/ui/shared/operation-document/assets.js";
import {
  operationSheetPageCount,
  operationSheetStyles,
  renderOperationSheet,
} from "../src/ui/shared/operation-document/renderer.js";

const sha256Text: Sha256HexFn = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/* ------------------------------------------------------------------ */
/* Minimal deterministic DOM shim (no DOM library is installed, and no */
/* installs are permitted). It supports exactly what the sheet        */
/* renderer uses; notably it has no innerHTML, so any renderer use of */
/* innerHTML with dynamic strings would fail loudly here.              */
/* ------------------------------------------------------------------ */

class FakeText {
  constructor(public text: string) {}
}

type FakeChild = FakeElement | FakeText;

class FakeNode {
  children: FakeChild[] = [];
  append(...nodes: FakeChild[]): void {
    for (const node of nodes) this.children.push(node);
  }
}

class FakeElement extends FakeNode {
  attrs: Array<[string, string]> = [];
  textValue = "";
  constructor(
    public tag: string,
    public ns: string | null = null,
  ) {
    super();
  }
  set className(value: string) {
    this.setAttribute("class", value);
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  get classList(): { add(...tokens: string[]): void } {
    return {
      add: (...tokens: string[]) => {
        const current = (this.getAttribute("class") ?? "").split(/\s+/).filter((part) => part.length > 0);
        for (const token of tokens) {
          if (!current.includes(token)) current.push(token);
        }
        this.setAttribute("class", current.join(" "));
      },
    };
  }
  set textContent(value: string | null) {
    this.children = [];
    this.textValue = value ?? "";
  }
  setAttribute(key: string, value: string): void {
    const existing = this.attrs.find((entry) => entry[0] === key);
    if (existing) existing[1] = value;
    else this.attrs.push([key, value]);
  }
  getAttribute(key: string): string | undefined {
    return this.attrs.find((entry) => entry[0] === key)?.[1];
  }
  addEventListener(): void {}
  replaceChildren(...nodes: FakeChild[]): void {
    this.children = [...nodes];
    this.textValue = "";
  }
}

class FakeFragment extends FakeNode {}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  createElementNS(ns: string, tag: string): FakeElement {
    return new FakeElement(tag, ns);
  }
  createDocumentFragment(): FakeFragment {
    return new FakeFragment();
  }
}

function textOf(node: FakeNode | FakeText): string {
  if (node instanceof FakeText) return node.text;
  const element = node as FakeElement;
  return element.textValue + element.children.map(textOf).join("");
}

function visitElements(root: FakeNode, visit: (element: FakeElement) => void): void {
  const walk = (node: FakeNode | FakeChild): void => {
    if (node instanceof FakeElement) visit(node);
    if (node instanceof FakeNode) {
      for (const child of node.children) walk(child);
    }
  };
  walk(root);
}

function findAllByClass(root: FakeNode, cls: string): FakeElement[] {
  const out: FakeElement[] = [];
  visitElements(root, (element) => {
    if ((element.getAttribute("class") ?? "").split(/\s+/).includes(cls)) out.push(element);
  });
  return out;
}

function findAllByTag(root: FakeNode, tag: string): FakeElement[] {
  const out: FakeElement[] = [];
  visitElements(root, (element) => {
    if (element.tag === tag) out.push(element);
  });
  return out;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serialize(node: FakeNode | FakeText): string {
  if (node instanceof FakeText) return escapeText(node.text);
  if (node instanceof FakeFragment) return node.children.map(serialize).join("");
  const element = node as FakeElement;
  const attrs = element.attrs.map(([key, value]) => ` ${key}="${escapeText(value)}"`).join("");
  const inner = escapeText(element.textValue) + element.children.map(serialize).join("");
  return `<${element.tag}${attrs}>${inner}</${element.tag}>`;
}

function renderSheet(
  view: OperationSheetView,
  lookup?: OperationSheetAssetLookup,
  brand?: { markDataUrl: string },
): FakeFragment {
  const document = new FakeDocument();
  const fragment = renderOperationSheet(
    view,
    document as unknown as Document,
    lookup,
    brand,
  );
  return fragment as unknown as FakeFragment;
}

/* ------------------------------------------------------------------ */
/* Synthetic fixtures                                                  */
/* ------------------------------------------------------------------ */

function makeChestRegion(): Region {
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
  };
}

const centreFront: AnchorDef = {
  id: "cf",
  name: "Centre front",
  productId: "polo",
  variantId: "m",
  regionId: "chest",
  frameId: "chest-frame",
  calibrationId: "cal-1",
  calibrationVersion: "v1",
  posMm: [150, 75],
};

function makeTwoLogoProject(extraConfigs = false): ProjectDocument {
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "sheet-test-project",
    revision: 1,
    instructions: "Handle with care.",
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
        assets: [{ uri: "logos/mark-a.png", role: "original", mediaType: "image/png" }],
      },
      {
        schemaVersion: "0.1.0-provisional",
        id: "logo-b",
        name: "Logo B",
        assets: [{ uri: "logos/mark-b.png", role: "original", mediaType: "image/png" }],
      },
    ],
    configurations: [
      {
        id: "cfg-m",
        productId: "polo",
        variantId: "m",
        placements: [
          {
            logoId: "logo-a",
            regionId: "chest",
            method: "embroider",
            pos: { xMm: 100, yMm: 75 },
            widthMm: 60,
            heightMm: 40,
            rotationDeg: 0,
            instructions: "Stitch slowly.",
          },
          {
            logoId: "logo-b",
            regionId: "chest",
            method: "print",
            pos: { xMm: 60, yMm: 60 },
            widthMm: 30,
            heightMm: 20,
            rotationDeg: 0,
            instructions: "Press flat.",
          },
        ],
      },
      ...(extraConfigs
        ? [{
            id: "cfg-l",
            productId: "polo",
            variantId: "l",
            placements: [],
          }]
        : []),
    ],
  };
}

function makeTwoLogoView(): OperationSheetView {
  const project = makeTwoLogoProject();
  const candidate = buildCandidateExport(project, sha256Text);
  return buildOperationSheetView({
    candidate,
    anchors: [centreFront],
    bindings: {
      "cfg-m": [
        { logoRef: "logo-a", anchorId: "cf", edge: "maxX", convention: "dx", label: "centre front to right edge, horizontal" },
        { logoRef: "logo-b", anchorId: "cf", edge: "minX", convention: "dx", label: "centre front to left edge, horizontal" },
      ],
    },
    sides: {
      "cfg-m": [
        { view: "front", imagePath: "presentation/front.png", label: "Front" },
        { view: "back", imagePath: "presentation/back.png", label: "Back" },
      ],
    },
    job: { customer: "Synthetic Co", reference: "JOB-1", article: "Polo" },
    extras: { "cfg-m": { "logo-a": { businessCode: "EMB-7", colours: ["navy"], methodParams: { density: "0.4" } } } },
    operationalInstructions: ["Check alignment before pressing."],
  });
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

/* ------------------------------------------------------------------ */
/* Branded sheet contract                                              */
/* ------------------------------------------------------------------ */

describe("operationSheetStyles", () => {
  it("prints A4 landscape with page breaks and no technical metadata", () => {
    const css = operationSheetStyles();
    assert.ok(css.includes("@page"));
    assert.ok(css.includes("size: A4 landscape"));
    assert.ok(css.includes("break-after"));
    assert.ok(css.includes(".opsheet-photo-svg"));
    assert.ok(css.includes("img.opsheet-card-thumb"), "cards preserve artwork aspect");
    assert.ok(css.includes(".opsheet-mark"), "brand mark keeps its display viewport");
    assert.ok(!css.includes("digest"));
    assert.ok(!css.includes("cfg-"));
  });
});

describe("renderOperationSheet", () => {
  it("renders one branded sheet for the ordinary job with no technical ids", () => {
    const view = makeTwoLogoView();
    const root = renderSheet(view);
    const sheets = findAllByClass(root, "opsheet");
    assert.equal(sheets.length, 1);
    assert.ok(sheets[0]!.className.split(/\s+/).includes("opsheet-last"), "single sheet is the last page");
    const html = serialize(root);
    assert.ok(html.includes("Synthetic Co"));
    assert.ok(html.includes("JOB-1"));
    assert.ok(html.includes("Polo shirt / Medium"));
    assert.ok(html.includes("EMB-7"));
    assert.ok(!html.includes("Logo A"), "business code prints alone, no name echo");
    assert.ok(!html.includes("logo-a"), "raw customer logo id never prints");
    assert.ok(html.includes("60.0 \u00d7 40.0 mm"));
    assert.ok(!html.includes("Stitch slowly."), "customer-only placement notes never print");
    assert.ok(!html.includes("Press flat."));
    assert.ok(!html.includes("Handle with care."), "customer-only project notes never print");
    assert.equal(findAllByClass(root, "opsheet-source-notes").length, 0, "no source-context section on the printed sheet");
    const operationalBlocks = findAllByClass(root, "opsheet-instructions");
    assert.equal(operationalBlocks.length, 1);
    const operationalHtml = serialize(operationalBlocks[0]!);
    assert.ok(operationalHtml.includes("Check alignment before pressing."));
    assert.ok(!operationalHtml.includes("Stitch slowly."));
    assert.ok(!operationalHtml.includes("Handle with care."));
    assert.ok(html.includes("navy"));
    assert.ok(html.includes("density: 0.4"));
    assert.equal(findAllByClass(root, "opsheet-status").length, 0, "complete sheet carries no draft badge");
    assert.ok(!html.includes("cfg-m"), "no configuration id on the operator sheet");
    assert.ok(!html.includes("chest-frame"), "no frame id on the operator sheet");
    assert.ok(!html.includes("cal-1"), "no calibration id on the operator sheet");
    assert.ok(!html.includes("digest"), "no digest on the operator sheet");
  });

  it("prints a customer sentence staff explicitly copied into operational instructions", () => {
    const project = makeTwoLogoProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const copied = buildOperationSheetView({
      candidate,
      anchors: [centreFront],
      bindings: {
        "cfg-m": [
          { logoRef: "logo-a", anchorId: "cf", edge: "maxX", convention: "dx", label: "centre front to right edge, horizontal" },
          { logoRef: "logo-b", anchorId: "cf", edge: "minX", convention: "dx", label: "centre front to left edge, horizontal" },
        ],
      },
      sides: {
        "cfg-m": [
          { view: "front", imagePath: "presentation/front.png", label: "Front" },
          { view: "back", imagePath: "presentation/back.png", label: "Back" },
        ],
      },
      operationalInstructions: ["Check alignment before pressing.", "Stitch slowly."],
    });
    const root = renderSheet(copied);
    const operationalBlocks = findAllByClass(root, "opsheet-instructions");
    assert.equal(operationalBlocks.length, 1);
    const operationalHtml = serialize(operationalBlocks[0]!);
    assert.ok(operationalHtml.includes("Stitch slowly."), "staff authorship is the only path onto the sheet");
    assert.ok(operationalHtml.includes("Check alignment before pressing."));
    assert.ok(!serialize(root).includes("Press flat."), "uncopied customer notes still never print");
  });

  it("shows the brand mark only for a valid data URL", () => {
    const view = makeTwoLogoView();
    assert.equal(findAllByTag(renderSheet(view), "img").length, 0);
    const branded = renderSheet(view, undefined, { markDataUrl: "data:image/jpeg;base64,AAA" });
    const marks = findAllByClass(branded, "opsheet-mark");
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.getAttribute("src"), "data:image/jpeg;base64,AAA");
    const rejected = renderSheet(view, undefined, { markDataUrl: "https://example.invalid/mark.jpg" });
    assert.equal(findAllByClass(rejected, "opsheet-mark").length, 0, "remote URLs never render");
  });

  it("escapes untrusted text instead of rendering markup", () => {
    const view = makeTwoLogoView();
    const hostile: OperationSheetView = {
      ...view,
      job: { customer: '<img src="x" onerror="throw 1">', reference: "JOB-1" },
    };
    const root = renderSheet(hostile);
    const html = serialize(root);
    assert.equal(findAllByTag(root, "img").length, 0);
    assert.ok(html.includes("&lt;img src=\"x\""), "markup is escaped, not rendered");
  });

  it("omits supplied sides with no mapped logos and says so explicitly", () => {
    const view = makeTwoLogoView();
    const root = renderSheet(view);
    const html = serialize(root);
    assert.ok(html.includes("2 supplied photo(s) not shown"), "concise omission note names the count");
    assert.ok(!html.includes("has no bytes in the package"), "no per-side placeholders for omitted sides");
    assert.equal(findAllByClass(root, "opsheet-photo").length, 0);
    assert.equal(findAllByClass(root, "opsheet-photo-svg").length, 0);
  });

  it("marks unfinished logos and zero-logo sheets with one concise status", () => {
    const project = makeTwoLogoProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const unfinished = buildOperationSheetView({ candidate, anchors: [], bindings: {} });
    const logo = unfinished.sheets[0]!.logos[0]!;
    assert.ok(logo.positionText.startsWith("unfinished"));
    assert.equal(logo.dimensions[0]?.valueMm1, undefined);
    const root = renderSheet(unfinished);
    const statuses = findAllByClass(root, "opsheet-status");
    assert.equal(statuses.length, 1);
    assert.ok(textOf(statuses[0]!).includes("setup needed before production"));
    assert.ok(serialize(root).includes("Dimensions not set"));

    const zero: OperationSheetView = {
      version: OPERATION_SHEET_VIEW_VERSION,
      job: {},
      sheets: [{
        productId: "polo",
        variantId: "l",
        productName: "Polo shirt",
        variantName: "Large",
        sides: [],
        logos: [],
        instructions: [],
        sourceNotes: { placement: [] },
      }],
    };
    const zeroRoot = renderSheet(zero);
    assert.equal(findAllByClass(zeroRoot, "opsheet").length, 1);
    const zeroHtml = serialize(zeroRoot);
    assert.ok(zeroHtml.includes("No logos configured"));
    assert.ok(zeroHtml.includes("no logos configured on this sheet"));
  });

  it("summarizes multi-sheet jobs so no product/variant is silently lost", () => {
    const project = makeTwoLogoProject(true);
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({ candidate, anchors: [], bindings: {} });
    assert.equal(view.sheets.length, 2);
    const root = renderSheet(view);
    assert.equal(findAllByClass(root, "opsheet").length, 2);
    const html = serialize(root);
    assert.ok(html.includes("2 operation sheets"));
    assert.ok(html.includes("Polo shirt / Medium"));
    assert.ok(html.includes("Polo shirt / Large"));
  });

  it("renders an explicit page for an empty view", () => {
    const empty: OperationSheetView = { version: OPERATION_SHEET_VIEW_VERSION, job: {}, sheets: [] };
    const root = renderSheet(empty);
    assert.equal(findAllByClass(root, "opsheet").length, 1);
    assert.ok(serialize(root).includes("No configurations in this job"));
  });

  it("composites artwork and dimension arrows forward through the evaluated mapping", () => {
    const view = makeTwoLogoView();
    const logo = view.sheets[0]!.logos[0]!;
    assert.equal(logo.dimensions[0]!.valueMm, 20);
    assert.equal(logo.dimensions[0]!.valueMm1, formatMm1(20));
    const assets: Record<string, Uint8Array> = {
      "presentation/front.png": pngBytes(20, 10),
      "presentation/back.png": pngBytes(20, 10),
      "logos/mark-a.png": pngBytes(8, 4),
    };
    const overlay: SheetOverlay = {
      mappings: [
        {
          regionId: "chest",
          view: "front",
          transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
          status: "provisional",
        },
        undefined,
      ],
      artworks: [
        {
          regionId: "chest",
          imagePath: "logos/mark-a.png",
          xMm: 100,
          yMm: 75,
          widthMm: 60,
          heightMm: 40,
          rotationDeg: 0,
          arrows: [{ p0: { x: 130, y: 75 }, p1: { x: 150, y: 75 } }],
        },
        {
          regionId: "chest",
          xMm: 60,
          yMm: 60,
          widthMm: 30,
          heightMm: 20,
          rotationDeg: 0,
        },
      ],
    };
    const lookup: OperationSheetAssetLookup = {
      getBytes: (path) => assets[path],
      getSheetOverlay: (sheetIndex) => (sheetIndex === 0 ? overlay : undefined),
    };
    const root = renderSheet(view, lookup);
    const composites = findAllByClass(root, "opsheet-photo-svg");
    assert.equal(composites.length, 1, "only the mapped side composites");
    assert.equal(findAllByTag(composites[0]!, "image").length, 2, "photo plus one artwork overlay");
    const frames = findAllByClass(composites[0]!, "opsheet-photo-frame");
    assert.equal(frames.length, 1, "photo block is one nested frame");
    assert.equal(frames[0]!.getAttribute("viewBox"), "0 0 20 10");
    const frameY = Number(frames[0]!.getAttribute("y"));
    assert.ok(frameY > 0, "frame sits below the top dimension gutter");
    const arrows = findAllByClass(composites[0]!, "opsheet-arrow");
    assert.equal(arrows.length, 1);
    // True parallel composition: the x extent still carries the exact
    // forward mapping (x = 0.005 * xMm * 20px); the lane copies the mapped
    // delta verbatim and lives in the top gutter.
    assert.equal(Number(arrows[0]!.getAttribute("x1")), 0.005 * 130 * 20);
    assert.equal(Number(arrows[0]!.getAttribute("x2")), 0.005 * 150 * 20);
    assert.equal(
      Number(arrows[0]!.getAttribute("x2")) - Number(arrows[0]!.getAttribute("x1")),
      0.005 * 150 * 20 - 0.005 * 130 * 20,
      "lane delta copies the mapped delta, never re-projected",
    );
    assert.equal(Number(arrows[0]!.getAttribute("y1")), Number(arrows[0]!.getAttribute("y2")));
    assert.ok(Number(arrows[0]!.getAttribute("y1")) < frameY, "dimension line lives in the gutter, never on photo pixels");
    assert.ok((arrows[0]!.getAttribute("marker-start") ?? "").startsWith("url(#"), "arrowhead on the start");
    assert.ok((arrows[0]!.getAttribute("marker-end") ?? "").startsWith("url(#"), "arrowhead on the end");
    const witnesses = findAllByClass(composites[0]!, "opsheet-witness");
    assert.ok(witnesses.length >= arrows.length, "every arrow end links back to its true point");
    assert.equal(Number(witnesses[0]!.getAttribute("x2")), 0.005 * 130 * 20);
    assert.equal(Number(witnesses[0]!.getAttribute("y2")), frameY + (-0.006 * 75 + 1) * 10);
    assert.equal(Number(witnesses[1]!.getAttribute("x2")), 0.005 * 150 * 20);
    assert.equal(Number(witnesses[1]!.getAttribute("y2")), frameY + (-0.006 * 75 + 1) * 10);
    const dimLabels = findAllByClass(composites[0]!, "opsheet-dim-label");
    assert.equal(dimLabels.length, 1);
    assert.equal(textOf(dimLabels[0]!), "1 \u00b7 20.0 mm");
    const markers = findAllByClass(composites[0]!, "opsheet-anchor-marker");
    assert.equal(markers.length, 1, "one short marker per distinct anchor point");
    assert.ok(textOf(markers[0]!).length <= 2, "marker text over the photo is at most 2 characters");
    const keys = findAllByClass(root, "opsheet-anchor-key");
    assert.equal(keys.length, 1, "one anchor legend per sheet");
    assert.equal(textOf(keys[0]!), "A \u2014 Centre front", "legend maps the code back to the full anchor name");
    const panels = findAllByClass(root, "opsheet-logo");
    assert.equal(panels.length, 2);
    const secondDims = findAllByClass(panels[1]!, "opsheet-dim-value");
    assert.ok(secondDims.length >= 1, "second logo carries its measured dimension");
    assert.ok(
      textOf(secondDims[0]!).startsWith("2 \u2014"),
      "dimension refs continue sheet-wide, never restart per logo",
    );
    const html = serialize(root);
    assert.ok(html.includes("Mapped photos are visual trial overlays, not production approval."));
    assert.equal(findAllByClass(root, "opsheet-trial-note").length, 1, "single trial disclaimer per sheet");
    assert.ok(html.includes("20.0 mm"));
    assert.ok(html.includes("1 \u2014 20.0 mm \u2014 Centre front, right edge, horizontal"), "panel line carries ref, value, anchor, and edge");
    assert.ok(html.includes("Centre front"));
    assert.equal(findAllByClass(root, "opsheet-photo").length, 1, "only the logo-hosting side prints");
    assert.ok(!html.includes("reference only, unmapped"), "unmapped back side omitted entirely");
    assert.ok(
      html.includes("no renderable artwork supplied"),
      "logo without artwork bytes gets an explicit panel note",
    );
  });
});

/* ------------------------------------------------------------------ */
/* evaluateOperationSheetOverlays (alternative image-path-keyed        */
/* adapter; kept as a pure fallback alongside the SheetOverlay        */
/* contract above)                                                     */
/* ------------------------------------------------------------------ */

describe("evaluateOperationSheetOverlays", () => {
  const mappingFile = (mappings: unknown[]): Uint8Array =>
    new TextEncoder().encode(JSON.stringify({ version: 1, mappings }));
  const manifestFile = (views: unknown[]): Uint8Array =>
    new TextEncoder().encode(JSON.stringify({ version: 2, views }));
  const viewDecl = { productId: "polo", variantId: "m", view: "front", image: "presentation/front.png" };
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

  function overlayAssets(): Record<string, Uint8Array> {
    return {
      "presentation/preview.json": manifestFile([viewDecl]),
      "presentation/front.png": pngBytes(20, 10),
      "presentation/photo-mappings.json": mappingFile([entry]),
      "logos/mark-a.png": pngBytes(8, 4),
    };
  }

  it("evaluates current bindings with geometry and drops stale ones", () => {
    const project = makeTwoLogoProject();
    project.configurations = [project.configurations[0]!];
    const candidate = buildCandidateExport(project, sha256Text);
    const before = JSON.stringify(candidate);
    const overlays = evaluateOperationSheetOverlays(candidate, overlayAssets());
    assert.deepEqual(Object.keys(overlays), ["presentation/front.png"]);
    const overlay = overlays["presentation/front.png"]!;
    assert.equal(overlay.regionId, "chest");
    assert.equal(overlay.status, "provisional");
    assert.equal(overlay.artworks.length, 2);
    assert.equal(overlay.artworks[0]!.uri, "logos/mark-a.png");
    assert.equal(overlay.artworks[0]!.label, "Logo A");
    assert.equal(JSON.stringify(candidate), before, "never mutates the candidate");
    assert.deepEqual(evaluateOperationSheetOverlays(candidate, overlayAssets()), overlays, "deterministic");

    const stale = evaluateOperationSheetOverlays(candidate, {
      ...overlayAssets(),
      "presentation/photo-mappings.json": mappingFile([{ ...entry, calibrationVersion: "v9" }]),
    });
    assert.deepEqual(Object.keys(stale), [], "stale calibration never evaluates");

    const degenerate = evaluateOperationSheetOverlays(candidate, {
      ...overlayAssets(),
      "presentation/photo-mappings.json": mappingFile([{ ...entry, transform: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 } }]),
    });
    assert.deepEqual(Object.keys(degenerate), [], "degenerate affines never evaluate");

    assert.deepEqual(Object.keys(evaluateOperationSheetOverlays(candidate)), [], "absent bytes yield no overlays");
  });
});

/* ------------------------------------------------------------------ */
/* Adaptive branded composition (Worker V1): proof stage + card rail, */
/* content-aware pagination, thumbnails, footer band                 */
/* ------------------------------------------------------------------ */

function makeDirectView(
  logoCount: number,
  options?: { sides?: number; dimsPerLogo?: number; instructions?: string[] },
): OperationSheetView {
  const dimsPerLogo = options?.dimsPerLogo ?? 1;
  const sideCount = options?.sides ?? 1;
  return {
    version: OPERATION_SHEET_VIEW_VERSION,
    job: { customer: "Synthetic Co", reference: "JOB-9", article: "Polo" },
    sheets: [{
      productId: "polo",
      variantId: "m",
      productName: "Polo shirt",
      variantName: "Medium",
      sides: Array.from({ length: sideCount }, (_, index) => ({
        view: ["front", "back", "left", "right"][index] ?? "front",
        imagePath: `presentation/side-${index}.png`,
        label: `Side ${index + 1}`,
      })),
      logos: Array.from({ length: logoCount }, (_, index) => ({
        logoName: `Logo ${index + 1}`,
        logoCode: `CODE-${index + 1}`,
        side: "Chest",
        positionText: "20.0 mm — Centre front, right edge, horizontal",
        method: "embroider",
        widthMm: 60,
        heightMm: 40,
        rotationDeg: 0,
        dimensions: Array.from({ length: dimsPerLogo }, (_, dim) => ({
          label: `dim ${dim + 1}`,
          valueMm: 20 + dim,
          valueMm1: formatMm1(20 + dim),
          fromAnchor: "Centre front",
          toEdge: "to the right edge, measured horizontally",
        })),
        unfinished: [],
      })),
      instructions: options?.instructions ?? [],
      sourceNotes: { placement: [] },
    }],
  };
}

describe("adaptive branded composition", () => {
  it("stages one proof beside a card rail with thumbnails and a footer band", () => {
    const view = makeTwoLogoView();
    const assets: Record<string, Uint8Array> = {
      "presentation/front.png": pngBytes(20, 10),
      "logos/mark-a.png": pngBytes(8, 4),
    };
    const overlay: SheetOverlay = {
      mappings: [{
        regionId: "chest",
        view: "front",
        transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
        status: "provisional",
      }],
      artworks: [
        {
          regionId: "chest",
          imagePath: "logos/mark-a.png",
          xMm: 100,
          yMm: 75,
          widthMm: 60,
          heightMm: 40,
          rotationDeg: 0,
        },
        {
          regionId: "chest",
          xMm: 60,
          yMm: 60,
          widthMm: 30,
          heightMm: 20,
          rotationDeg: 0,
        },
      ],
    };
    const lookup: OperationSheetAssetLookup = {
      getBytes: (path) => assets[path],
      getSheetOverlay: (sheetIndex) => (sheetIndex === 0 ? overlay : undefined),
    };
    const root = renderSheet(view, lookup, { markDataUrl: "data:image/png;base64,AAA" });
    const stages = findAllByClass(root, "opsheet-stage");
    assert.equal(stages.length, 1);
    assert.ok(
      stages[0]!.className.split(/\s+/).includes("opsheet-views-1"),
      "one printable view picks the large-proof-plus-rail stage",
    );
    assert.equal(findAllByClass(root, "opsheet-cards").length, 1, "logo rail keeps its card container");
    assert.equal(findAllByClass(root, "opsheet-footer-band").length, 1, "the page closes with the red band");
    const thumbs = findAllByClass(root, "opsheet-card-thumb");
    assert.equal(thumbs.length, 1, "only the logo with validated bytes gets a thumbnail, never a fake box");
    assert.equal(thumbs[0]!.getAttribute("width"), "8", "header pixel size travels with the thumb");
    assert.equal(thumbs[0]!.getAttribute("height"), "4", "aspect preserved, never cropped");
    assert.ok(!serialize(root).includes("Logo A"), "thumb alt and notes use the business code, never the raw name");
    assert.equal(operationSheetPageCount(view), findAllByClass(root, "opsheet").length);
  });

  it("announced page count always equals rendered pages, with partitioned continuations", () => {
    // Five logos across two genuinely separate regions: cost budgeting
    // overflows the first page, so the continuation repeats its own
    // relevant proof instead of stranding cards without visual evidence.
    const view = makeDirectView(5, { sides: 2 });
    const assets: Record<string, Uint8Array> = {
      "presentation/side-0.png": pngBytes(20, 10),
      "presentation/side-1.png": pngBytes(20, 10),
      "art/front-a.png": pngBytes(8, 4),
      "art/front-b.png": pngBytes(8, 4),
      "art/front-c.png": pngBytes(8, 4),
      "art/back-a.png": pngBytes(8, 4),
      "art/back-b.png": pngBytes(8, 4),
    };
    const artEntry = (regionId: string, imagePath: string, base: number, yy: number): SheetOverlay["artworks"][number] => ({
      regionId,
      imagePath,
      xMm: 100,
      yMm: 75,
      widthMm: 60,
      heightMm: 40,
      rotationDeg: 0,
      arrows: [{ p0: { x: base, y: yy }, p1: { x: base + 20, y: yy } }],
    });
    const overlay: SheetOverlay = {
      mappings: [
        { regionId: "front-r", view: "front", transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 }, status: "provisional" },
        { regionId: "back-r", view: "back", transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 }, status: "provisional" },
      ],
      artworks: [
        artEntry("front-r", "art/front-a.png", 100, 60),
        artEntry("front-r", "art/front-b.png", 120, 80),
        artEntry("front-r", "art/front-c.png", 140, 100),
        artEntry("back-r", "art/back-a.png", 100, 70),
        artEntry("back-r", "art/back-b.png", 130, 90),
      ],
    };
    const lookup: OperationSheetAssetLookup = {
      getBytes: (path) => assets[path],
      getSheetOverlay: (sheetIndex) => (sheetIndex === 0 ? overlay : undefined),
    };
    assert.equal(operationSheetPageCount(view), 2, "cost budgeting overflows the first page");
    assert.equal(operationSheetPageCount(view, lookup), 2, "counter with asset context matches the render");
    const root = renderSheet(view, lookup);
    const pages = findAllByClass(root, "opsheet");
    assert.equal(pages.length, 2);
    const headings = findAllByClass(root, "opsheet-logo-name").map((h) => textOf(h));
    assert.deepEqual(
      headings,
      ["CODE-1", "CODE-2", "CODE-3", "CODE-4", "CODE-5"],
      "each whole card once with plain identity — no stranded heads",
    );
    assert.ok(serialize(root).includes("(continued)"), "continuations repeat the branded header context");
    assert.equal(findAllByClass(root, "opsheet-footer-band").length, 2, "every page closes with the red band");
    assert.ok(serialize(root).includes("(continued)"), "continuations repeat the branded header context");
    const labelsOf = (page: FakeElement): string[] =>
      findAllByClass(page, "opsheet-dim-label").map((label) => textOf(label));
    // Page one stages the front proof with the front cards' refs only.
    assert.equal(findAllByClass(pages[0]!, "opsheet-photo").length, 1);
    assert.equal(textOf(findAllByClass(pages[0]!, "opsheet-caption")[0]!), "Side 1");
    assert.deepEqual(labelsOf(pages[0]!), ["1 \u00b7 20.0 mm", "2 \u00b7 20.0 mm", "3 \u00b7 20.0 mm"]);
    // The continuation repeats its own relevant proof — never cards-only.
    assert.equal(findAllByClass(pages[1]!, "opsheet-photo").length, 1, "late logos keep matching visual evidence");
    assert.equal(textOf(findAllByClass(pages[1]!, "opsheet-caption")[0]!), "Side 2");
    assert.deepEqual(labelsOf(pages[1]!), ["4 \u00b7 20.0 mm", "5 \u00b7 20.0 mm"]);
    // Sheet-wide refs never restart; legends and trial context travel.
    assert.equal(findAllByClass(root, "opsheet-anchor-key").length, 2, "one filtered legend per proof page");
    assert.equal(findAllByClass(root, "opsheet-trial-note").length, 2, "every proof page carries the trial note");
    const markerIds: string[] = [];
    visitElements(root, (element) => {
      if (element.tag === "marker") markerIds.push(element.getAttribute("id") ?? "?");
    });
    assert.equal(new Set(markerIds).size, markerIds.length, "repeated proofs never duplicate element ids");
  });

  it("budgets measured content costs, not quotas", () => {
    const heavy = makeDirectView(4, { sides: 1, dimsPerLogo: 3 });
    assert.equal(operationSheetPageCount(heavy), 2, "taller 3-dim cards cost out the first page");
    assert.equal(findAllByClass(renderSheet(heavy), "opsheet").length, 2);
    const long = makeDirectView(4, { sides: 1, instructions: ["x".repeat(600)] });
    assert.equal(operationSheetPageCount(long), 2, "a long instruction block costs out the first page");
    assert.equal(findAllByClass(renderSheet(long), "opsheet").length, 2);
    const wide = makeDirectView(4, { sides: 3 });
    assert.equal(operationSheetPageCount(wide), 2, "the 3-view proof grid costs out the first page");
    assert.equal(findAllByClass(renderSheet(wide), "opsheet").length, 2);
    const ordinary = makeDirectView(3, { sides: 2 });
    assert.equal(operationSheetPageCount(ordinary), 1, "ordinary 3-logo jobs stay one page");
    assert.equal(findAllByClass(renderSheet(ordinary), "opsheet").length, 1);
  });

  it("adapts the stage modifier to the printable view count", () => {
    const twoSide: OperationSheetView = {
      ...makeTwoLogoView(),
      sheets: makeTwoLogoView().sheets,
    };
    const assets: Record<string, Uint8Array> = {
      "presentation/front.png": pngBytes(20, 10),
      "presentation/back.png": pngBytes(20, 10),
    };
    const overlay: SheetOverlay = {
      // Genuinely separate regions per side: each logo's art binds exactly
      // one proof, so no dimension repeats across views.
      mappings: [
        { regionId: "front-r", view: "front", transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 }, status: "provisional" },
        { regionId: "back-r", view: "back", transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 }, status: "provisional" },
      ],
      artworks: [
        { regionId: "front-r", xMm: 100, yMm: 75, widthMm: 60, heightMm: 40, rotationDeg: 0 },
        { regionId: "back-r", xMm: 60, yMm: 60, widthMm: 30, heightMm: 20, rotationDeg: 0 },
      ],
    };
    const lookup: OperationSheetAssetLookup = {
      getBytes: (path) => assets[path],
      getSheetOverlay: (sheetIndex) => (sheetIndex === 0 ? overlay : undefined),
    };
    const two = renderSheet(twoSide, lookup);
    assert.equal(findAllByClass(two, "opsheet-photo").length, 2, "both mapped sides print");
    const twoStages = findAllByClass(two, "opsheet-stage");
    assert.equal(twoStages.length, 1);
    assert.ok(twoStages[0]!.className.split(/\s+/).includes("opsheet-views-2"));

    const three = makeDirectView(3, { sides: 3 });
    const threeAssets: Record<string, Uint8Array> = {
      "presentation/side-0.png": pngBytes(20, 10),
      "presentation/side-1.png": pngBytes(20, 10),
      "presentation/side-2.png": pngBytes(20, 10),
    };
    const threeOverlay: SheetOverlay = {
      mappings: [0, 1, 2].map((index) => ({
        regionId: `side-r-${index}`,
        view: ["front", "back", "left"][index]!,
        transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
        status: "provisional" as const,
      })),
      artworks: [0, 1, 2].map((index) => ({
        regionId: `side-r-${index}`,
        xMm: 100,
        yMm: 75,
        widthMm: 60,
        heightMm: 40,
        rotationDeg: 0,
      })),
    };
    const threeLookup: OperationSheetAssetLookup = {
      getBytes: (path) => threeAssets[path],
      getSheetOverlay: (sheetIndex) => (sheetIndex === 0 ? threeOverlay : undefined),
    };
    const threeRoot = renderSheet(three, threeLookup);
    assert.equal(findAllByClass(threeRoot, "opsheet-photo").length, 3, "all three mapped sides print");
    const threeStages = findAllByClass(threeRoot, "opsheet-stage");
    assert.equal(threeStages.length, 1);
    assert.ok(threeStages[0]!.className.split(/\s+/).includes("opsheet-views-3plus"));
    // Tight budget (3+ views) still matches the announced count.
    assert.equal(operationSheetPageCount(three), findAllByClass(threeRoot, "opsheet").length);
  });
});

describe("content-aware planning corrections", () => {
  function regionalOverlay(
    regions: string[],
    arts: Array<{ region: string; image: string; base: number; yy: number }>,
    assets: Record<string, Uint8Array>,
  ): { lookup: OperationSheetAssetLookup; overlay: SheetOverlay } {
    const overlay: SheetOverlay = {
      mappings: regions.map((regionId, index) => ({
        regionId,
        view: ["front", "back", "left", "right"][index]!,
        transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
        status: "provisional" as const,
      })),
      artworks: arts.map((art) => ({
        regionId: art.region,
        imagePath: art.image,
        xMm: 100,
        yMm: 75,
        widthMm: 60,
        heightMm: 40,
        rotationDeg: 0,
        arrows: [{ p0: { x: art.base, y: art.yy }, p1: { x: art.base + 20, y: art.yy } }],
      })),
    };
    const lookup: OperationSheetAssetLookup = {
      getBytes: (path) => assets[path],
      getSheetOverlay: (sheetIndex) => (sheetIndex === 0 ? overlay : undefined),
    };
    return { lookup, overlay };
  }

  it("counts relevant views, not declared ones, when assets are known", () => {
    // Four declared sides; only front/back map logos (LEFT stays unused).
    const view = makeDirectView(2, { sides: 4 });
    const assets: Record<string, Uint8Array> = {
      "presentation/side-0.png": pngBytes(20, 10),
      "presentation/side-1.png": pngBytes(20, 10),
      "art/a.png": pngBytes(8, 4),
      "art/b.png": pngBytes(8, 4),
    };
    const { lookup } = regionalOverlay(
      ["front-r", "back-r", "left-r", "right-r"],
      [
        { region: "front-r", image: "art/a.png", base: 100, yy: 60 },
        { region: "back-r", image: "art/b.png", base: 120, yy: 80 },
      ],
      assets,
    );
    assert.equal(operationSheetPageCount(view, lookup), 1, "two relevant proofs share one rail page");
    const root = renderSheet(view, lookup);
    assert.equal(findAllByClass(root, "opsheet").length, 1);
    assert.equal(findAllByClass(root, "opsheet-photo").length, 2, "only mapped sides print, unused LEFT omitted");
    assert.deepEqual(
      findAllByClass(root, "opsheet-photo").map((f) => textOf(findAllByClass(f, "opsheet-caption")[0]!)),
      ["Side 1", "Side 2"],
    );
    // Without asset context the counter stays conservative, never under-counting.
    assert.ok(operationSheetPageCount(view) >= findAllByClass(root, "opsheet").length);
  });

  it("costs each page group by its own relevant sides", () => {
    // Four views, one logo per side: the first page budgets three proofs,
    // the continuation budgets its own single proof.
    const view = makeDirectView(4, { sides: 4 });
    const assets: Record<string, Uint8Array> = {
      "presentation/side-0.png": pngBytes(20, 10),
      "presentation/side-1.png": pngBytes(20, 10),
      "presentation/side-2.png": pngBytes(20, 10),
      "presentation/side-3.png": pngBytes(20, 10),
      "art/a.png": pngBytes(8, 4),
      "art/b.png": pngBytes(8, 4),
      "art/c.png": pngBytes(8, 4),
      "art/d.png": pngBytes(8, 4),
    };
    const regions = ["r0", "r1", "r2", "r3"];
    const { lookup } = regionalOverlay(
      regions,
      regions.map((region, i) => ({ region, image: `art/${"abcd".charAt(i)}.png`, base: 100 + i * 6, yy: 60 + i * 6 })),
      assets,
    );
    assert.equal(operationSheetPageCount(view, lookup), 2);
    const root = renderSheet(view, lookup);
    const pages = findAllByClass(root, "opsheet");
    assert.equal(pages.length, 2);
    assert.equal(findAllByClass(pages[0]!, "opsheet-photo").length, 3, "first page stages its three relevant proofs");
    assert.deepEqual(
      findAllByClass(pages[0]!, "opsheet-dim-label").map((l) => textOf(l)),
      ["1 · 20.0 mm", "2 · 20.0 mm", "3 · 20.0 mm"],
    );
    assert.equal(findAllByClass(pages[1]!, "opsheet-photo").length, 1, "continuation repeats its own relevant proof");
    assert.deepEqual(
      findAllByClass(pages[1]!, "opsheet-dim-label").map((l) => textOf(l)),
      ["4 · 20.0 mm"],
    );
  });

  it("splits an oversized card with continued identity instead of spilling", () => {
    const view = makeDirectView(1, { sides: 1, dimsPerLogo: 30 });
    const assets: Record<string, Uint8Array> = {
      "presentation/side-0.png": pngBytes(20, 10),
      "art/a.png": pngBytes(8, 4),
    };
    const { lookup } = regionalOverlay(
      ["front-r"],
      [{ region: "front-r", image: "art/a.png", base: 100, yy: 60 }],
      assets,
    );
    // One dimension arrow is not enough to draw thirty lanes distinctly;
    // only the first arrow entry draws, the rest stay honest panel lines.
    void lookup;
    const plain: OperationSheetAssetLookup = { getBytes: (path) => assets[path] };
    const announced = operationSheetPageCount(view, plain);
    assert.ok(announced > 1, `oversized card paginates explicitly, got ${announced}`);
    const root = renderSheet(view, plain);
    assert.equal(findAllByClass(root, "opsheet").length, announced);
    // Every physical dimension line exactly once (ref + value text, not just ref numbers).
    const dimTexts = findAllByClass(root, "opsheet-dim-value").map((e) => textOf(e));
    assert.equal(dimTexts.length, 30, "no dimension omitted or invented");
    assert.equal(new Set(dimTexts).size, 30, "every measurement line exactly once");
    // Only header identity repeats, with a clear continued label; head-only content prints once.
    const headings = findAllByClass(root, "opsheet-logo-name").map((h) => textOf(h));
    assert.ok(headings.length > 1, "split card spans pages");
    assert.ok(headings.every((h) => h === "CODE-1 (continued)"), "every part carries continued identity");
    assert.equal(findAllByTag(root, "img").filter((img) => (img.getAttribute("class") ?? "").includes("opsheet-card-thumb")).length, 0, "no overlay, no thumb");
    assert.equal(findAllByClass(root, "opsheet-photo-note").length, 1, "honest thumbnail note exactly once, on the head part");
    assert.equal(findAllByClass(root, "opsheet-size").length, 1, "size line once");
    assert.equal(findAllByClass(root, "opsheet-method").length, 1, "method line once");
    for (const page of findAllByClass(root, "opsheet")) {
      const labels = new Set(findAllByClass(page, "opsheet-dim-label").map((l) => textOf(l)));
      const panels = new Set(findAllByClass(page, "opsheet-dim-value").map((e) => textOf(e)));
      for (const label of labels) {
        const ref = label.split("·")[0]!.trim();
        assert.ok([...panels].some((line) => line.startsWith(ref + " ")), `figure label ${label} backed by its page's panel`);
      }
    }
    assert.equal(findAllByClass(root, "opsheet-footer-band").length, announced, "every page closed");
  });

  it("costs newline-heavy instructions by paragraph, not by character count", () => {
    // Forty two-character paragraphs: ~100 chars total would budget a
    // single line by character count, but print forty lines.
    const paras: string[] = Array.from({ length: 40 }, (_, i) => `ok${i}`);
    const view = makeDirectView(1, { sides: 1, instructions: paras });
    const announced = operationSheetPageCount(view);
    assert.ok(announced > 1, `paragraph-heavy instructions paginate explicitly, got ${announced}`);
    const root = renderSheet(view);
    assert.equal(findAllByClass(root, "opsheet").length, announced);
    assert.ok(serialize(root).includes("Operational instructions (continued)"), "continuation has identity");
  const h2s = findAllByTag(root, "h2").map((h) => textOf(h));
  assert.equal(h2s.filter((h) => h === "Operational instructions").length, 1, "plain heading exactly once");
  assert.ok(h2s.slice(1).every((h) => h === "Operational instructions (continued)"), "every later block continued");
    const printed = findAllByClass(root, "opsheet-instructions").flatMap((block) =>
      findAllByTag(block, "p").map((p) => textOf(p)),
    );
    assert.deepEqual(printed, paras, "every paragraph exactly once, in order");
  });

  it("grows the header budget for wrapped names instead of overflowing", () => {
    const long: OperationSheetView = {
      ...makeDirectView(1, { sides: 1 }),
      job: { customer: "Acme Athletics Print ".repeat(10).trim(), reference: "JOB-9", article: "Polo" },
    };
    assert.equal(operationSheetPageCount(long), 1, "ordinary job still fits one page");
    const root = renderSheet(long);
    assert.equal(findAllByClass(root, "opsheet").length, 1);
    assert.ok(serialize(root).includes("Acme Athletics Print"), "long name prints in full, never clipped");
  });
});
