import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { buildCandidateExport } from "../src/core/index.js";
import type { ProjectDocument, Sha256HexFn } from "../src/core/index.js";
import {
  buildOperationSheetView,
  OPERATION_SHEET_VIEW_VERSION,
} from "../src/core/operation-document/index.js";
import type { OperationSheetView } from "../src/core/operation-document/types.js";
import type { OperationSheetAssetLookup } from "../src/ui/shared/operation-document/index.js";
import {
  operationSheetPageCount,
  renderOperationSheet,
} from "../src/ui/shared/operation-document/renderer.js";
import {
  addModelDocumentView,
  adjustModelDocumentView,
  cameraDigest,
  createModelRenderCoordinator,
  defaultModelDocumentViews,
  isModelViewRenderStale,
  MODEL_DOCUMENT_VIEW_VERSION,
  modelViewRenderKey,
  parseModelDocumentView,
  parseModelDocumentViewList,
  removeModelDocumentView,
  reorderModelDocumentViews,
  serializeModelDocumentViews,
} from "../src/core/presentation-views/model-document-views.js";
import type { ModelDocumentView } from "../src/core/presentation-views/model-document-views.js";

const sha256Text: Sha256HexFn = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/* Minimal DOM shim (same contract as operation-sheet.test.ts). */

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

function renderSheet(
  view: OperationSheetView,
  lookup?: OperationSheetAssetLookup,
): FakeFragment {
  const document = new FakeDocument();
  const fragment = renderOperationSheet(
    view,
    document as unknown as Document,
    lookup,
  );
  return fragment as unknown as FakeFragment;
}

function makeView(overrides: Partial<ModelDocumentView> = {}): ModelDocumentView {
  return {
    id: "front",
    productId: "polo",
    variantId: "m",
    camera: {
      position: [0.6, 0.35, 1.4],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: 40,
    },
    associatedRegions: ["chest"],
    modelAssetId: "presentation/model.glb",
    modelRevision: "r1",
    ...overrides,
  };
}

function makeProject(): ProjectDocument {
  return {
    schemaVersion: "0.1.0-provisional",
    projectId: "model-doc-test",
    revision: 7,
    products: [{
      schemaVersion: "0.1.0-provisional",
      id: "polo",
      name: "Polo shirt",
      kind: "upper-body",
      variants: [{ id: "m", name: "Medium", regionIds: ["chest"] }],
      regions: [{
        id: "chest",
        name: "Chest",
        frame: {
          frameId: "chest-frame",
          originDescription: "Centre of chest",
          axes: { xPositive: "wearer right", yPositive: "wearer up" },
        },
        calibrationRef: { calibrationId: "cal-1", version: "v1" },
        safeArea: [[0, 0], [200, 0], [200, 150], [0, 150]],
        allowedMethods: ["embroider", "print"],
      }],
      calibrations: [{ id: "cal-1", version: "v1" }],
    }],
    logos: [{
      schemaVersion: "0.1.0-provisional",
      id: "logo-a",
      name: "Logo A",
      assets: [{ uri: "logos/mark-a.png", role: "original", mediaType: "image/png" }],
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
        rotationDeg: 0,
      }],
    }],
  };
}

describe("model document views (presentation-only, Worker C)", () => {
  it("parses and round-trips a versioned view list", () => {
    const views = defaultModelDocumentViews("polo", "m", "presentation/model.glb", "r1", ["chest"]);
    assert.equal(views.length, 1);
    assert.equal(views[0]!.id, "front");
    const text = serializeModelDocumentViews(views);
    assert.ok(text.includes(MODEL_DOCUMENT_VIEW_VERSION));
    const parsed = parseModelDocumentViewList(JSON.parse(text) as unknown);
    assert.deepEqual(parsed, views);
  });

  it("rejects malformed versions, duplicates and pixel-as-truth cameras", () => {
    assert.equal(parseModelDocumentViewList({ version: "v9", views: [] }), null);
    assert.equal(parseModelDocumentViewList(null), null);
    const view = makeView();
    assert.equal(
      parseModelDocumentViewList({ version: MODEL_DOCUMENT_VIEW_VERSION, views: [view, view] }),
      null,
    );
    assert.equal(parseModelDocumentView({ ...view, camera: { ...(view.camera as object), fov: 0 } }), null);
    assert.equal(parseModelDocumentView({ ...view, id: "Front View!" }), null);
  });

  it("adds, adjusts, reorders and removes views without touching identity", () => {
    const start: ModelDocumentView[] = [];
    const added = addModelDocumentView(start, makeView());
    assert.equal(added.ok, true);
    if (!added.ok) return;
    const second = addModelDocumentView(added.views, makeView({ id: "back", associatedRegions: ["chest"] }));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(addModelDocumentView(second.views, makeView()).ok, false);
    const adjusted = adjustModelDocumentView(
      second.views,
      "front",
      "polo",
      "m",
      { camera: { position: [0, 0, 2], target: [0, 0, 0], up: [0, 1, 0], fov: 35 }, label: "Hero" },
    );
    assert.equal(adjusted.ok, true);
    if (!adjusted.ok) return;
    const front = adjusted.views.find((entry) => entry.id === "front")!;
    assert.equal(front.label, "Hero");
    assert.equal(front.productId, "polo");
    assert.equal(front.modelAssetId, "presentation/model.glb");
    const reordered = reorderModelDocumentViews(adjusted.views, "polo", "m", ["back", "front"]);
    assert.equal(reordered.ok, true);
    if (!reordered.ok) return;
    assert.notEqual(
      serializeModelDocumentViews(reordered.views),
      serializeModelDocumentViews(adjusted.views),
    );
    assert.deepEqual(parseModelDocumentViewList(JSON.parse(serializeModelDocumentViews(reordered.views)))!.map((v) => v.id), ["back", "front"]);
    const removed = removeModelDocumentView(reordered.views, "back", "polo", "m");
    assert.equal(removed.ok, true);
    if (!removed.ok) return;
    assert.equal(removed.views.length, 1);
    assert.equal(removeModelDocumentView(removed.views, "missing", "polo", "m").ok, false);
  });

  it("binds renders to revision + view params and invalidates on change", () => {
    const view = makeView();
    const key = modelViewRenderKey(view, 7);
    assert.equal(modelViewRenderKey(view, 7), key);
    assert.notEqual(modelViewRenderKey(view, 8), key);
    const moved = { ...view, camera: { ...view.camera, fov: 30 } };
    assert.notEqual(modelViewRenderKey(moved, 7), key);
    const render = { revision: 7, cameraKey: cameraDigest(view.camera, view.framing), modelRevision: "r1" };
    assert.equal(isModelViewRenderStale(render, view, 7), false);
    assert.equal(isModelViewRenderStale(render, view, 8), true);
    assert.equal(isModelViewRenderStale(render, moved, 7), true);
    assert.equal(isModelViewRenderStale(render, { ...view, modelRevision: "r2" }, 7), true);
  });

  it("rejects stale async captures and decodes by token", () => {
    const coordinator = createModelRenderCoordinator();
    const first = coordinator.request("cfg-m/front");
    const second = coordinator.request("cfg-m/front");
    assert.equal(coordinator.resolve("cfg-m/front", first), false);
    assert.equal(coordinator.resolve("cfg-m/front", second), true);
    coordinator.cancel("cfg-m/front");
    assert.equal(coordinator.resolve("cfg-m/front", second), false);
  });
});

describe("model-view operation sheets (GLB-only, no photo demand)", () => {
  it("carries operator-ordered model sides into the sheet", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [],
      bindings: {},
      modelViews: {
        "cfg-m": [
          { view: "front", imagePath: "model-view/front.png", modelAssetId: "presentation/model.glb", modelRevision: "r1", regions: ["chest"] },
          { view: "back", imagePath: "model-view/back.png", modelAssetId: "presentation/model.glb", modelRevision: "r1", regions: ["chest"] },
        ],
      },
    });
    const sides = view.sheets[0]!.sides;
    assert.equal(sides.length, 2);
    assert.deepEqual(sides.map((side) => side.view), ["front", "back"]);
    assert.ok(sides.every((side) => side.kind === "model"));
    assert.deepEqual(sides[0]!.regions, ["chest"]);
  });

  it("renders model figures without demanding product photos", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [],
      bindings: {},
      modelViews: {
        "cfg-m": [
          { view: "front", imagePath: "model-view/front.png", modelAssetId: "presentation/model.glb", modelRevision: "r1", regions: ["chest"] },
        ],
      },
    });
    // Production-realistic lookup: the caller-evaluated overlay binds the
    // logo artwork to its region; the model capture arrives revision-bound.
    const lookup: OperationSheetAssetLookup = {
      getBytes: () => undefined,
      getSheetOverlay: () => ({
        mappings: [undefined],
        artworks: [{
          regionId: "chest",
          xMm: 100,
          yMm: 75,
          widthMm: 60,
          heightMm: 40,
          rotationDeg: 0,
        }],
      }),
      getModelViewImage: (path) => path === "model-view/front.png"
        ? { dataUrl: "data:image/png;base64,AAA", width: 320, height: 240, revision: candidate.revision }
        : undefined,
    };
    const root = renderSheet(view, lookup);
    const html = textOf(root);
    assert.ok(!html.includes("No product photo supplied"), "model views replace the photo demand");
    assert.ok(!html.includes("supplied photo(s) not shown"));
    assert.equal(findAllByClass(root, "opsheet-photo").length, 1);
    assert.equal(findAllByClass(root, "opsheet-photo-img").length, 1);
    assert.equal(operationSheetPageCount(view, lookup), 1);
  });

  it("prints an explicit pending note when the render is not captured yet", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({
      candidate,
      anchors: [],
      bindings: {},
      modelViews: {
        "cfg-m": [
          { view: "front", imagePath: "model-view/front.png", modelAssetId: "presentation/model.glb", modelRevision: "r1", regions: ["chest"] },
        ],
      },
    });
    const pending: OperationSheetAssetLookup = {
      getBytes: () => undefined,
      getSheetOverlay: () => ({
        mappings: [undefined],
        artworks: [{
          regionId: "chest",
          xMm: 100,
          yMm: 75,
          widthMm: 60,
          heightMm: 40,
          rotationDeg: 0,
        }],
      }),
    };
    const root = renderSheet(view, pending);
    const html = textOf(root);
    assert.ok(html.includes("not rendered yet"), "pending capture is explicit, never a guessed image");
    assert.ok(!html.includes("No product photo supplied"));
  });

  it("names missing measurements precisely when size is present", () => {
    const project = makeProject();
    const candidate = buildCandidateExport(project, sha256Text);
    const view = buildOperationSheetView({ candidate, anchors: [], bindings: {} });
    const root = renderSheet(view);
    const html = textOf(root);
    assert.ok(html.includes("Placement measurements not set"), "width/height present, bindings missing");
    assert.ok(!html.includes("Dimensions not set"), "no stale dimension wording for sized logos");
  });
});
