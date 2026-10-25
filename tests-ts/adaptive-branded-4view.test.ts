import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  operationSheetPageCount,
  renderOperationSheet,
} from "../src/ui/shared/operation-document/renderer.js";
import type { OperationSheetView } from "../src/core/operation-document/types.js";
import type {
  OperationSheetAssetLookup,
  SheetOverlay,
} from "../src/ui/shared/operation-document/assets.js";

/* Minimal deterministic DOM shim (mirrors tests-ts/operation-sheet.test.ts).
 * No innerHTML; renderer text reaches the page via textContent only. */

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

/** Minimal header-valid PNG: real IHDR values, unchecked CRC. */
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

/**
 * Lead-owned coverage: 5 mixed logos across 4 printable views (front hosts
 * two logos on ONE shared proof; back/left/right host one each). Guards the
 * 4-view grouping the renderer worker left untested: relevant proofs per
 * page group, no cross-view ref repeats, card exact-once, announced count
 * equals rendered pages.
 */
function makeFourView(): { view: OperationSheetView; lookup: OperationSheetAssetLookup } {
  const view: OperationSheetView = {
    version: "operation-sheet-view/1",
    job: { customer: "Lead QA", reference: "LEAD-4VIEW-01", article: "Field Jacket" },
    sheets: [{
      productId: "jacket",
      variantId: "m",
      productName: "Field Jacket",
      variantName: "M",
      variantDisplay: "M",
      sides: [
        { view: "front", imagePath: "presentation/front.png", label: "Front" },
        { view: "back", imagePath: "presentation/back.png", label: "Back" },
        { view: "left", imagePath: "presentation/left.png", label: "Left" },
        { view: "right", imagePath: "presentation/right.png", label: "Right" },
      ],
      logos: [
        {
          logoName: "Chest A", logoCode: "CODE-1", side: "Chest",
          positionText: "10.0 mm — anchor", method: "embroider",
          widthMm: 60, heightMm: 40, rotationDeg: 0, dimensions: [{
            label: "chest a dx", valueMm: 10, valueMm1: "10.0",
            fromAnchor: "Anchor F", toEdge: "to the left artwork edge (min-X), measured horizontally",
          }],
          unfinished: [],
        },
        {
          logoName: "Chest B", logoCode: "CODE-2", side: "Chest",
          positionText: "11.0 mm — anchor", method: "embroider",
          widthMm: 50, heightMm: 30, rotationDeg: 0, dimensions: [{
            label: "chest b dx", valueMm: 11, valueMm1: "11.0",
            fromAnchor: "Anchor F2", toEdge: "to the right artwork edge (max-X), measured horizontally",
          }],
          unfinished: [],
        },
        {
          logoName: "Back C", logoCode: "CODE-3", side: "Back",
          positionText: "12.0 mm — anchor", method: "print",
          widthMm: 120, heightMm: 60, rotationDeg: 0, dimensions: [{
            label: "back c dy", valueMm: 12, valueMm1: "12.0",
            fromAnchor: "Anchor B", toEdge: "to the top artwork edge (max-Y), measured vertically",
          }],
          unfinished: [],
        },
        {
          logoName: "Sleeve L", logoCode: "CODE-4", side: "Left sleeve",
          positionText: "13.0 mm — anchor", method: "print",
          widthMm: 40, heightMm: 20, rotationDeg: 0, dimensions: [{
            label: "left d dx", valueMm: 13, valueMm1: "13.0",
            fromAnchor: "Anchor L", toEdge: "to the left artwork edge (min-X), measured horizontally",
          }],
          unfinished: [],
        },
        {
          logoName: "Sleeve R", logoCode: "CODE-5", side: "Right sleeve",
          positionText: "14.0 mm — anchor", method: "print",
          widthMm: 40, heightMm: 20, rotationDeg: 0, dimensions: [{
            label: "right e dx", valueMm: 14, valueMm1: "14.0",
            fromAnchor: "Anchor R", toEdge: "to the left artwork edge (min-X), measured horizontally",
          }],
          unfinished: [],
        },
      ],
      instructions: ["Press per temp chart."],
      sourceNotes: { placement: [] },
    }],
  };
  const regions = ["CHEST", "CHEST", "BACK", "LEFT", "RIGHT"];
  const overlay: SheetOverlay = {
    mappings: (["front", "back", "left", "right"] as const).map((side, i) => ({
      regionId: ["CHEST", "BACK", "LEFT", "RIGHT"][i]!,
      view: side,
      transform: { a: 0.005, b: 0, c: 0, d: 0, e: -0.006, f: 1 },
      status: "provisional" as const,
    })),
    artworks: regions.map((regionId, i) => ({
      regionId,
      imagePath: `logos/art-${i}.png`,
      xMm: 100, yMm: 75, widthMm: 60, heightMm: 40, rotationDeg: 0,
      arrows: [{ p0: { x: 130, y: 75 }, p1: { x: 150, y: 75 } }],
    })),
  };
  const assets: Record<string, Uint8Array> = {
    "presentation/front.png": pngBytes(200, 160),
    "presentation/back.png": pngBytes(200, 160),
    "presentation/left.png": pngBytes(200, 160),
    "presentation/right.png": pngBytes(200, 160),
    "logos/art-0.png": pngBytes(8, 4),
    "logos/art-1.png": pngBytes(8, 4),
    "logos/art-2.png": pngBytes(8, 4),
    "logos/art-3.png": pngBytes(8, 4),
    "logos/art-4.png": pngBytes(8, 4),
  };
  const lookup: OperationSheetAssetLookup = {
    getBytes: (path) => assets[path],
    getSheetOverlay: (sheetIndex) => (sheetIndex === 0 ? overlay : undefined),
  };
  return { view, lookup };
}

describe("adaptive 4-view grouping (lead-owned)", () => {
  it("stages four relevant proofs with side-exclusive refs, exact-once cards, matching page count", () => {
    const { view, lookup } = makeFourView();
    const document = new FakeDocument();
    const fragment = renderOperationSheet(
      view,
      document as unknown as Document,
      lookup,
    ) as unknown as FakeFragment;
    const pages = findAllByClass(fragment, "opsheet");
    assert.ok(pages.length >= 1, "renders at least one page");
    assert.equal(
      operationSheetPageCount(view, lookup),
      pages.length,
      "announced count with the same lookup equals rendered pages",
    );

    // All four relevant views print; the two front logos share ONE proof.
    const figures = findAllByClass(fragment, "opsheet-photo");
    const captions = figures.map((figure) =>
      findAllByClass(figure, "opsheet-caption").map(textOf).join(""),
    );
    assert.deepEqual(
      [...captions].sort(),
      ["Back", "Front", "Left", "Right"],
      "every relevant view prints exactly once",
    );

    // Side-exclusive refs: front carries 1+2 only; others carry their own.
    const labelsByCaption = new Map<string, string[]>();
    for (const figure of figures) {
      const caption = findAllByClass(figure, "opsheet-caption").map(textOf).join("");
      const refs = findAllByClass(figure, "opsheet-dim-label").map((label) =>
        textOf(label).split("·")[0]!.trim(),
      );
      labelsByCaption.set(caption, refs);
    }
    assert.deepEqual(labelsByCaption.get("Front"), ["1", "2"]);
    assert.deepEqual(labelsByCaption.get("Back"), ["3"]);
    assert.deepEqual(labelsByCaption.get("Left"), ["4"]);
    assert.deepEqual(labelsByCaption.get("Right"), ["5"]);

    // Card exact-once: each business code heads exactly one plain card and
    // each dimension line appears exactly once across all pages.
    const headings = findAllByClass(fragment, "opsheet-logo-name").map(textOf);
    assert.deepEqual(headings, ["CODE-1", "CODE-2", "CODE-3", "CODE-4", "CODE-5"]);
    const dimLines = findAllByClass(fragment, "opsheet-dim-value").map(textOf);
    assert.equal(dimLines.length, 5);
    const refs = dimLines.map((line) => line.trim().split(" ")[0]);
    assert.deepEqual(refs, ["1", "2", "3", "4", "5"]);

    // Relevant proof per page group: every figure ref on a page is backed
    // by that same page's panel lines.
    for (const page of pages) {
      const pageRefs = new Set(
        findAllByClass(page, "opsheet-dim-value").map((item) => textOf(item).trim().split(" ")[0]),
      );
      for (const label of findAllByClass(page, "opsheet-dim-label")) {
        const ref = textOf(label).split("·")[0]!.trim();
        assert.ok(pageRefs.has(ref), `page figure ref ${ref} is backed by its page panel`);
      }
    }
  });
});
