import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDraftIdentityKey } from "../src/core/workspace-drafts/index.js";
import {
  parsePhotoMappings,
  serializePhotoMappings,
  validateMappingContext,
} from "../src/ui/customer-editor/presentation-photo-mapping.js";
import {
  MAX_PRODUCT_SETUP_VIEWS,
  listWorkspaceViews,
  resolveInitialView,
  scopeViewId,
  scopeViewLabel,
  selectWorkspaceViewById,
  viewIdentityKey,
} from "../src/ui/internal-builder/product-setup-view.js";
import type {
  ProductSetupPhotoView,
  ProductSetupScope,
  ProductSetupWorkspaceInput,
  ProductSetupWorkspaceInputV2,
} from "../src/ui/internal-builder/product-setup-view.js";

function scopeFixture(overrides: Partial<ProductSetupScope> = {}): ProductSetupScope {
  return {
    productId: "P",
    variantId: "V",
    regionId: "R",
    frameId: "F",
    calibrationId: "C",
    calibrationVersion: "1",
    regionName: null,
    side: "front",
    ...overrides,
  };
}

function viewFixture(overrides: Partial<ProductSetupPhotoView> = {}): ProductSetupPhotoView {
  return {
    scope: scopeFixture(),
    photoId: "presentation/front.png#10:abc",
    sourceRev: "proj#open-1",
    photo: { bytes: new Uint8Array([1]), widthPx: 40, heightPx: 30, label: "front" },
    transform: { a: 1 / 280, b: 0, c: 0, d: 0, e: -1 / 200, f: 1 },
    mappingStatus: "provisional",
    safeArea: [],
    anchors: [],
    ...overrides,
  };
}

function legacyInput(): ProductSetupWorkspaceInput {
  return {
    views: {
      front: viewFixture(),
      back: viewFixture({ scope: scopeFixture({ side: "back" }), photoId: "presentation/back.png#10:def" }),
    },
  };
}

function namedInput(): ProductSetupWorkspaceInputV2 {
  const views = [
    "Collar detail",
    "Front wide",
    "Back yoke",
    "Left cuff",
    "Right cuff",
  ].map((label, index) => ({
    id: `view-${index + 1}`,
    label,
    state: viewFixture({
      scope: scopeFixture({ regionId: `R${index + 1}`, viewId: `view-${index + 1}`, viewLabel: label }),
      photoId: `presentation/view-${index + 1}.png#10:aa${index}`,
    }),
  }));
  return { initialViewId: "view-2", views };
}

describe("flexible named workspace views", () => {
  it("legacy keys stay byte-identical and parse through workspace-drafts", () => {
    const key = viewIdentityKey(viewFixture());
    assert.equal(
      key,
      JSON.stringify([
        "presentation/front.png#10:abc",
        "proj#open-1",
        "P", "V", "R", "F", "C", "1",
        "front",
        JSON.stringify([1 / 280, 0, 0, 0, -1 / 200, 1]),
      ]),
    );
    const parsed = parseDraftIdentityKey(key);
    assert.ok(parsed);
    assert.equal(parsed.side, "front");
    assert.equal(parsed.imagePath, "presentation/front.png");
  });

  it("distinct ids on one side bucket give distinct keys; rename preserves the key", () => {
    const base = viewFixture();
    const detail = viewFixture({ scope: scopeFixture({ viewId: "front-detail", viewLabel: "Collar detail" }) });
    assert.notEqual(viewIdentityKey(detail), viewIdentityKey(base));
    const renamed = viewFixture({ scope: scopeFixture({ viewId: "front-detail", viewLabel: "Neck close-up" }) });
    assert.equal(viewIdentityKey(renamed), viewIdentityKey(detail));
    assert.equal(scopeViewId(renamed.scope), "front-detail");
    assert.equal(scopeViewLabel(renamed.scope), "Neck close-up");
    assert.equal(scopeViewId(base.scope), "front");
    assert.equal(scopeViewLabel(base.scope), "Front");
  });

  it("keys stay 10-string arrays so retirement parsing keeps matching", () => {
    for (const view of [viewFixture(), viewFixture({ scope: scopeFixture({ viewId: "x" }) })]) {
      const raw = JSON.parse(viewIdentityKey(view)) as unknown[];
      assert.equal(raw.length, 10);
      assert.ok(raw.every((entry) => typeof entry === "string"));
      assert.ok(parseDraftIdentityKey(viewIdentityKey(view)));
    }
  });

  it("legacy input lists in side order with side labels, bounded", () => {
    const listed = listWorkspaceViews(legacyInput());
    assert.deepEqual(listed.map((entry) => entry.id), ["front", "back"]);
    assert.deepEqual(listed.map((entry) => entry.label), ["Front", "Back"]);
    assert.ok(MAX_PRODUCT_SETUP_VIEWS >= 5);
  });

  it("five distinctly-named views list in order, select and resolve by id", () => {
    const input = namedInput();
    const listed = listWorkspaceViews(input);
    assert.equal(listed.length, 5);
    assert.deepEqual(listed.map((entry) => entry.id), ["view-1", "view-2", "view-3", "view-4", "view-5"]);
    assert.deepEqual(listed.map((entry) => entry.label), [
      "Collar detail", "Front wide", "Back yoke", "Left cuff", "Right cuff",
    ]);
    assert.equal(resolveInitialView(input, null), "view-2");
    assert.equal(resolveInitialView(input, "view-5"), "view-5");
    const selected = selectWorkspaceViewById(input, "view-3");
    assert.ok("photo" in selected);
    if ("photo" in selected) assert.equal(selected.scope.regionId, "R3");
    const missing = selectWorkspaceViewById(input, "view-9");
    assert.ok("error" in missing);
  });

  it("rename preserves selection and buckets across refreshes", () => {
    const before = namedInput();
    const renamed: ProductSetupWorkspaceInputV2 = {
      ...before,
      views: before.views.map((entry) =>
        entry.id === "view-1" ? { ...entry, label: "Collar macro" } : entry),
    };
    assert.equal(resolveInitialView(renamed, "view-1"), "view-1");
    const beforeKey = viewIdentityKey((before.views[0]!.state as ProductSetupPhotoView));
    const afterKey = viewIdentityKey((renamed.views[0]!.state as ProductSetupPhotoView));
    // The staged view state shown to the view is caller-owned; the label the
    // caller passes alongside may change, but scope identity must not.
    assert.equal(beforeKey, afterKey);
    // A scope-level relabel also preserves the bucket key.
    const first = before.views[0]!.state as ProductSetupPhotoView;
    const relabelled = viewFixture({
      ...first,
      scope: scopeFixture({ ...first.scope, viewLabel: "Collar macro" }),
    });
    assert.equal(viewIdentityKey(relabelled), beforeKey);
  });

  it("dedupe is first-wins and invalid ids are dropped, never invented", () => {
    const input: ProductSetupWorkspaceInputV2 = {
      views: [
        { id: "a", label: "A", state: viewFixture() },
        { id: "a", label: "A twin", state: viewFixture() },
        { id: "   ", label: "blank", state: viewFixture() },
        { id: "b", label: "", state: viewFixture() },
      ],
    };
    const listed = listWorkspaceViews(input);
    assert.deepEqual(listed.map((entry) => entry.id), ["a", "b"]);
    assert.deepEqual(listed.map((entry) => entry.label), ["A", "b"]);
  });
});

describe("photo-mapping view identity", () => {
  const entry = {
    productId: "P",
    regionId: "R",
    view: "front" as const,
    image: "presentation/front.png",
    transform: { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 },
    calibrationId: "C",
    calibrationVersion: "1",
    status: "provisional" as const,
  };

  it("legacy entries serialize to version 1 byte-identically", () => {
    const bytes = serializePhotoMappings({ version: 1, mappings: [entry] });
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.startsWith('{"version":1,'));
    assert.ok(!text.includes("viewId") && !text.includes("label"));
    const reparsed = parsePhotoMappings(bytes);
    assert.equal(reparsed?.version, 1);
    assert.deepEqual(reparsed?.mappings, [entry]);
  });

  it("view identity upgrades the envelope to version 2; v1 and v2 both parse", () => {
    const named = { ...entry, viewId: "front-detail", label: "Collar detail" };
    const bytes = serializePhotoMappings({ version: 1, mappings: [named] });
    assert.ok(new TextDecoder().decode(bytes).startsWith('{"version":2,'));
    const reparsed = parsePhotoMappings(bytes);
    assert.deepEqual(reparsed?.mappings, [named]);
    // A hand-written v2 envelope also parses (backward reader).
    const hand = new TextEncoder().encode(JSON.stringify({ version: 2, mappings: [named] }));
    assert.deepEqual(parsePhotoMappings(hand)?.mappings, [named]);
    // Invalid view identity is refused, never defaulted.
    const bad = new TextEncoder().encode(JSON.stringify({ version: 2, mappings: [{ ...named, viewId: "  " }] }));
    assert.equal(parsePhotoMappings(bad), null);
  });

  it("context binding matches exact view identity; labels never invalidate", () => {
    const context = {
      productId: "P",
      variantId: "V",
      regionId: "R",
      calibrationId: "C",
      calibrationVersion: "1",
      manifestViews: [{ view: "front" as const, image: "presentation/front.png" }],
    };
    const named = { ...entry, viewId: "front-detail", label: "Collar detail" };
    assert.deepEqual(validateMappingContext(named, context), []);
    assert.deepEqual(validateMappingContext({ ...named, label: "Renamed" }, context), []);
    assert.ok(validateMappingContext({ ...named, image: "presentation/other.png" }, context).length > 0);
    assert.ok(validateMappingContext(
      { ...named, viewId: "other-view" },
      { ...context, manifestViews: [{ view: "front" as const, viewId: "other-view", image: "presentation/front.png" }] },
    ).length === 0);
  });
});
