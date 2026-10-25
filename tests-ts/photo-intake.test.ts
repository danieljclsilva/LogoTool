import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PREVIEW_BYTES } from "../src/assets/raster-header.js";
import { planPhotoIntake, renameIntakeViewLabel } from "../src/core/photo-intake/index.js";
import type { PhotoIntakeInput } from "../src/core/photo-intake/index.js";

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(18);
  const view = new DataView(bytes.buffer);
  bytes.set([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 8, 8, 0, 0, 0, 0, 0]);
  view.setUint16(13, height);
  view.setUint16(15, width);
  return bytes;
}

function webpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x52494646);
  view.setUint32(4, 22, true);
  view.setUint32(8, 0x57454250);
  view.setUint32(12, 0x56503858);
  const wide = width - 1;
  const high = height - 1;
  bytes[24] = wide & 0xff;
  bytes[25] = (wide >> 8) & 0xff;
  bytes[26] = (wide >> 16) & 0xff;
  bytes[27] = high & 0xff;
  bytes[28] = (high >> 8) & 0xff;
  bytes[29] = (high >> 16) & 0xff;
  return bytes;
}

function modelManifest(productId = "jacket-01", variantId = "std"): unknown {
  return {
    version: 2,
    views: [],
    models: [{ productId, variantId, model: `presentation/${productId}/model.glb`, label: "3D model" }],
  };
}

function baseInput(extra?: Partial<PhotoIntakeInput>): PhotoIntakeInput {
  return {
    productId: "jacket-01",
    variantId: "std",
    side: "front",
    mode: "add",
    fileName: "front.png",
    bytes: pngBytes(20, 10),
    widthPx: 20,
    heightPx: 10,
    mediaType: "png",
    existingManifest: modelManifest(),
    existingMappings: [],
    existingAssetPaths: ["presentation/jacket-01/model.glb", "presentation/preview.json"],
    ...extra,
  };
}

describe("planPhotoIntake add", () => {
  it("plans a fresh side with a stable path, sorted manifest, and no invalidation", () => {
    const result = planPhotoIntake(baseInput());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.assetPath, "presentation/jacket-01/front.png");
    assert.equal(result.replacedAssetPath, undefined);
    assert.deepEqual(result.invalidatedMappingKeys, []);
    assert.equal(result.manifest.version, 2);
    assert.equal(result.manifest.views.length, 1);
    assert.deepEqual(result.manifest.views[0], {
      productId: "jacket-01",
      variantId: "std",
      view: "front",
      image: "presentation/jacket-01/front.png",
    });
    // The model-only product keeps its original model entry verbatim.
    assert.equal(result.manifest.models?.length, 1);
    assert.equal(result.manifest.models?.[0]?.model, "presentation/jacket-01/model.glb");
  });

  it("maps jpeg to .jpg and webp to .webp", () => {
    const jpeg = planPhotoIntake(baseInput({
      fileName: "front.jpg",
      bytes: jpegBytes(20, 10),
      mediaType: "jpeg",
    }));
    assert.equal(jpeg.ok, true);
    if (jpeg.ok) assert.equal(jpeg.assetPath, "presentation/jacket-01/front.jpg");
    const webp = planPhotoIntake(baseInput({
      fileName: "front.webp",
      bytes: webpBytes(20, 10),
      mediaType: "webp",
    }));
    assert.equal(webp.ok, true);
    if (webp.ok) assert.equal(webp.assetPath, "presentation/jacket-01/front.webp");
  });

  it("refuses an occupied side in add mode", () => {
    const manifest: unknown = {
      version: 2,
      views: [{ productId: "jacket-01", variantId: "std", view: "front", image: "presentation/jacket-01/front.png" }],
    };
    const result = planPhotoIntake(baseInput({ existingManifest: manifest }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "side-occupied");
  });

  it("sorts manifest views deterministically", () => {
    const manifest: unknown = {
      version: 2,
      views: [
        { productId: "jacket-01", variantId: "std", view: "front", image: "presentation/jacket-01/front.png" },
        { productId: "jacket-01", variantId: "std", view: "back", image: "presentation/jacket-01/back.png" },
      ],
    };
    const result = planPhotoIntake(baseInput({ side: "left", existingManifest: manifest }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.manifest.views.map((entry) => entry.view),
      ["back", "front", "left"],
    );
  });

  it("uses a suffixed path when the base path is held by an unrelated asset", () => {
    const result = planPhotoIntake(baseInput({
      side: "back",
      existingAssetPaths: ["presentation/jacket-01/back.png", "presentation/jacket-01/back-2.png"],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.assetPath, "presentation/jacket-01/back-3.png");
    assert.equal(result.manifest.views[0]?.image, "presentation/jacket-01/back-3.png");
  });
});

describe("planPhotoIntake replace", () => {
  const frontManifest: unknown = {
    version: 2,
    views: [
      { productId: "jacket-01", variantId: "std", view: "front", image: "presentation/jacket-01/front.png", label: "Front" },
      { productId: "jacket-01", variantId: "std", view: "back", image: "presentation/jacket-01/back.png", label: "Back" },
    ],
  };

  it("keeps the entry count, mints a new path, and invalidates only its own scope", () => {
    const mappings = [
      { productId: "jacket-01", variantId: "std", regionId: "chest", view: "front", image: "presentation/jacket-01/front.png" },
      { productId: "jacket-01", variantId: "std", regionId: "pocket", view: "front", image: "presentation/jacket-01/front.png" },
      { productId: "jacket-01", variantId: "std", regionId: "chest", view: "back", image: "presentation/jacket-01/back.png" },
      { productId: "jacket-01", regionId: "chest", view: "front", image: "presentation/jacket-01/front.png" },
      { productId: "other", variantId: "std", regionId: "chest", view: "front", image: "presentation/jacket-01/front.png" },
    ];
    const result = planPhotoIntake(baseInput({
      mode: "replace",
      existingManifest: frontManifest,
      existingMappings: mappings,
      existingAssetPaths: ["presentation/jacket-01/front.png", "presentation/jacket-01/back.png"],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Same-extension replace still mints a fresh path; the prior path is
    // never reused, so unrelated shares of it cannot be overwritten.
    assert.equal(result.assetPath, "presentation/jacket-01/front-2.png");
    assert.equal(result.replacedAssetPath, "presentation/jacket-01/front.png");
    assert.notEqual(result.assetPath, result.replacedAssetPath);
    assert.equal(result.manifest.views.length, 2);
    // Back binding survives; the replacement carries no copied geometry.
    const byView = new Map(result.manifest.views.map((entry) => [entry.view, entry]));
    assert.equal(byView.get("back")?.image, "presentation/jacket-01/back.png");
    assert.equal(byView.get("front")?.image, "presentation/jacket-01/front-2.png");
    assert.deepEqual(result.invalidatedMappingKeys, [
      "jacket-01\0std\0chest\0front\0presentation/jacket-01/front.png",
      "jacket-01\0std\0pocket\0front\0presentation/jacket-01/front.png",
    ]);
  });

  it("mints a new path on media change, preserves the label, and reports the superseded asset", () => {
    const result = planPhotoIntake(baseInput({
      mode: "replace",
      fileName: "front.jpg",
      bytes: jpegBytes(20, 10),
      mediaType: "jpeg",
      existingManifest: frontManifest,
      existingAssetPaths: ["presentation/jacket-01/front.png", "presentation/jacket-01/back.png"],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.assetPath, "presentation/jacket-01/front.jpg");
    assert.equal(result.replacedAssetPath, "presentation/jacket-01/front.png");
    assert.equal(result.manifest.views.length, 2);
    assert.deepEqual(result.manifest.views[1], {
      productId: "jacket-01",
      variantId: "std",
      view: "front",
      image: "presentation/jacket-01/front.jpg",
      label: "Front",
    });
  });

  it("never reuses a shared image path across sides on replace", () => {
    const shared = "presentation/jacket-01/shared.png";
    const manifest: unknown = {
      version: 2,
      views: [
        { productId: "jacket-01", variantId: "std", view: "front", image: shared },
        { productId: "jacket-01", variantId: "std", view: "back", image: shared },
      ],
    };
    const mappings = [
      { productId: "jacket-01", variantId: "std", regionId: "chest", view: "front", image: shared },
      { productId: "jacket-01", variantId: "std", regionId: "back-panel", view: "back", image: shared },
      { productId: "jacket-01", variantId: "std", regionId: "chest", view: "front", image: "presentation/jacket-01/other.png" },
    ];
    const result = planPhotoIntake(baseInput({
      mode: "replace",
      existingManifest: manifest,
      existingMappings: mappings,
      existingAssetPaths: [shared],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The new front photo lands on its own path; the back entry keeps
    // pointing at the retained original bytes.
    assert.equal(result.assetPath, "presentation/jacket-01/front.png");
    assert.equal(result.replacedAssetPath, shared);
    assert.notEqual(result.assetPath, result.replacedAssetPath);
    assert.equal(result.manifest.views.length, 2);
    const byView = new Map(result.manifest.views.map((entry) => [entry.view, entry]));
    assert.equal(byView.get("front")?.image, "presentation/jacket-01/front.png");
    assert.equal(byView.get("back")?.image, shared);
    // Only the replaced side/scope/image binding is invalidated: the back
    // mapping still resolves against the untouched original bytes.
    assert.equal(result.invalidatedMappingKeys.length, 1);
  });

  it("never reuses a shared image path across variant scopes on replace", () => {
    const shared = "presentation/jacket-01/shared.png";
    const manifest: unknown = {
      version: 2,
      views: [
        { productId: "jacket-01", view: "front", image: shared },
        { productId: "jacket-01", variantId: "std", view: "front", image: shared },
      ],
    };
    const mappings = [
      { productId: "jacket-01", regionId: "chest", view: "front", image: shared },
      { productId: "jacket-01", variantId: "std", regionId: "chest", view: "front", image: shared },
    ];
    const result = planPhotoIntake(baseInput({
      mode: "replace",
      existingManifest: manifest,
      existingMappings: mappings,
      existingAssetPaths: [shared],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.replacedAssetPath, shared);
    assert.notEqual(result.assetPath, result.replacedAssetPath);
    assert.equal(result.manifest.views.length, 2);
    const wide = result.manifest.views.find((entry) => entry.variantId === undefined);
    const scoped = result.manifest.views.find((entry) => entry.variantId === "std");
    // The product-wide entry keeps the original bytes; only the replaced
    // variant scope moves to the fresh path.
    assert.equal(wide?.image, shared);
    assert.equal(scoped?.image, result.assetPath);
    assert.equal(result.invalidatedMappingKeys.length, 1);
  });

  it("always mints a new path on same-extension replace, even without a recorded clash", () => {
    const manifest: unknown = {
      version: 2,
      views: [
        { productId: "jacket-01", variantId: "std", view: "front", image: "presentation/jacket-01/front.png" },
      ],
    };
    // The prior path is absent from existingAssetPaths (stale record), yet
    // the planner must still refuse to hand it back for new bytes.
    const result = planPhotoIntake(baseInput({
      mode: "replace",
      existingManifest: manifest,
      existingAssetPaths: ["presentation/preview.json"],
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.replacedAssetPath, "presentation/jacket-01/front.png");
    assert.notEqual(result.assetPath, result.replacedAssetPath);
    assert.equal(result.assetPath, "presentation/jacket-01/front-2.png");
    assert.equal(result.manifest.views.length, 1);
    assert.equal(result.manifest.views[0]?.image, "presentation/jacket-01/front-2.png");
  });

  it("reports side-empty when the side has no photo", () => {
    const result = planPhotoIntake(baseInput({ mode: "replace", side: "left", existingManifest: frontManifest }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "side-empty");
  });
});

describe("planPhotoIntake scopes", () => {
  const mixedManifest: unknown = {
    version: 2,
    views: [
      { productId: "jacket-01", view: "front", image: "presentation/jacket-01/front.png" },
    ],
  };

  it("treats product-wide and variant scopes as distinct (no shadowing)", () => {
    // A product-wide front does not occupy the explicit variant scope…
    const addVariant = planPhotoIntake(baseInput({ existingManifest: mixedManifest }));
    assert.equal(addVariant.ok, false);
    if (!addVariant.ok) assert.equal(addVariant.code, "unknown-product-scope");
    // …but the product-wide scope itself accepts intake.
    const wideInput = baseInput({ mode: "replace", existingManifest: mixedManifest });
    delete wideInput.variantId;
    const addWide = planPhotoIntake(wideInput);
    assert.equal(addWide.ok, true);
  });

  it("rejects an unknown product scope", () => {
    const result = planPhotoIntake(baseInput({ productId: "unknown-99" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown-product-scope");
  });
});

describe("planPhotoIntake validation", () => {
  it("rejects malformed bytes, dimension and media mismatches", () => {
    const garbage = planPhotoIntake(baseInput({ bytes: new TextEncoder().encode("<svg></svg>") }));
    assert.equal(garbage.ok, false);
    if (!garbage.ok) assert.equal(garbage.code, "malformed");
    const dims = planPhotoIntake(baseInput({ widthPx: 21 }));
    assert.equal(dims.ok, false);
    if (!dims.ok) assert.equal(dims.code, "malformed");
    const media = planPhotoIntake(baseInput({ mediaType: "jpeg" }));
    assert.equal(media.ok, false);
    if (!media.ok) assert.equal(media.code, "malformed");
    const emptyId = planPhotoIntake(baseInput({ productId: "" }));
    assert.equal(emptyId.ok, false);
    if (!emptyId.ok) assert.equal(emptyId.code, "malformed");
    const badSide = planPhotoIntake(baseInput({ side: "diagonal" as never }));
    assert.equal(badSide.ok, false);
    if (!badSide.ok) assert.equal(badSide.code, "malformed");
    const badMode = planPhotoIntake(baseInput({ mode: "upsert" as never }));
    assert.equal(badMode.ok, false);
    if (!badMode.ok) assert.equal(badMode.code, "malformed");
  });

  it("rejects invalid manifests as malformed", () => {
    for (const existingManifest of [null, undefined, { version: 1, references: [] }, { version: 2, views: [] }, { version: 2, views: [{}] }]) {
      const result = planPhotoIntake(baseInput({ existingManifest }));
      assert.equal(result.ok, false, JSON.stringify(existingManifest));
      if (!result.ok) assert.equal(result.code, "malformed");
    }
  });

  it("rejects oversized files before signature inspection", () => {
    const result = planPhotoIntake(baseInput({ bytes: new Uint8Array(MAX_PREVIEW_BYTES + 1) }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "oversized");
  });

  it("enforces the 32-entry budget on add but allows replace at budget", () => {
    const views: unknown[] = [];
    for (let n = 0; n < 31; n += 1) {
      views.push({ productId: `filler-${n}`, view: "front", image: `presentation/filler-${n}/front.png` });
    }
    const full: unknown = {
      version: 2,
      views,
      models: [{ productId: "jacket-01", variantId: "std", model: "presentation/jacket-01/model.glb" }],
    };
    const add = planPhotoIntake(baseInput({ existingManifest: full }));
    assert.equal(add.ok, false);
    if (!add.ok) assert.equal(add.code, "budget-exceeded");
    const replaceManifest: unknown = {
      version: 2,
      views: [
        ...(views as Array<Record<string, unknown>>),
        { productId: "jacket-01", variantId: "std", view: "front", image: "presentation/jacket-01/front.png" },
      ],
    };
    const replace = planPhotoIntake(baseInput({ mode: "replace", existingManifest: replaceManifest }));
    assert.equal(replace.ok, true);
    if (replace.ok) assert.equal(replace.manifest.views.length, 32);
  });

  it("is deterministic across repeat calls", () => {
    const input = baseInput({ side: "back" });
    const first = planPhotoIntake(input);
    const second = planPhotoIntake(input);
    assert.deepEqual(first, second);
  });
});

describe("renameIntakeViewLabel", () => {
  const namedManifest: unknown = {
    version: 3,
    views: [
      { productId: "jacket-01", variantId: "std", view: "view-1", image: "presentation/jacket-01/view-1.png", label: "Crown" },
      { productId: "jacket-01", variantId: "std", view: "view-2", image: "presentation/jacket-01/view-2.png", label: "Sleeve" },
      { productId: "jacket-01", view: "front", image: "presentation/jacket-01/front.png", label: "Front view" },
    ],
  };

  it("renames by stable id: image and identity preserved, siblings untouched", () => {
    const before = JSON.parse(JSON.stringify(namedManifest));
    const result = renameIntakeViewLabel(namedManifest, { productId: "jacket-01", variantId: "std", view: "view-1", label: "Crown front" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const views = (result.manifest as { views: Array<{ view: string; image: string; label?: string }> }).views;
    // Canonical id sort (legacy 'front' first); identity, images and
    // sibling labels survive verbatim — only the target label changes.
    assert.deepEqual(views.map((entry) => entry.view), ["front", "view-1", "view-2"]);
    assert.deepEqual(views.map((entry) => entry.image), [
      "presentation/jacket-01/front.png",
      "presentation/jacket-01/view-1.png",
      "presentation/jacket-01/view-2.png",
    ]);
    const byId = new Map(views.map((entry) => [entry.view, entry.label]));
    assert.equal(byId.get("view-1"), "Crown front");
    assert.equal(byId.get("view-2"), "Sleeve");
    assert.equal(byId.get("front"), "Front view");
    assert.deepEqual(namedManifest, before, "rename must not mutate its input");
  });

  it("clears the label when omitted and keeps the legacy entry byte-shape", () => {
    const result = renameIntakeViewLabel(namedManifest, { productId: "jacket-01", variantId: "std", view: "view-2" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const views = (result.manifest as { views: Array<{ view: string; label?: string }> }).views;
    const cleared = views.find((entry) => entry.view === "view-2")!;
    assert.ok(!("label" in cleared), "cleared label is omitted, not blanked");
  });

  it("rejects unknown views, duplicate scope ambiguity and bad labels", () => {
    const unknown = renameIntakeViewLabel(namedManifest, { productId: "jacket-01", variantId: "std", view: "view-9", label: "X" });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.code, "unknown-view");
    const wrongScope = renameIntakeViewLabel(namedManifest, { productId: "jacket-01", variantId: "other", view: "view-1", label: "X" });
    assert.equal(wrongScope.ok, false);
    // Whitespace-only text is within the 1..80-char contract (display layers
    // trim and fall back); overlong text is refused.
    const blank = renameIntakeViewLabel(namedManifest, { productId: "jacket-01", variantId: "std", view: "view-1", label: "   " });
    assert.equal(blank.ok, true);
    const long = renameIntakeViewLabel(namedManifest, { productId: "jacket-01", variantId: "std", view: "view-1", label: "x".repeat(81) });
    assert.equal(long.ok, false);
    const malformed = renameIntakeViewLabel({ version: 2, views: [] }, { productId: "jacket-01", view: "front", label: "X" });
    assert.equal(malformed.ok, false);
  });

  it("is deterministic and variant-scoped", () => {
    // The front entry is product-wide: the target carries no variantId.
    // A variant-scoped target would address a different (absent) scope.
    const target = { productId: "jacket-01", view: "front", label: "Front photo" } as const;
    const first = renameIntakeViewLabel(namedManifest, { ...target });
    const second = renameIntakeViewLabel(namedManifest, { ...target });
    assert.deepEqual(first, second);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const views = (first.manifest as { views: Array<{ view: string; label?: string }> }).views;
    const byId = new Map(views.map((entry) => [entry.view, entry.label]));
    assert.equal(byId.get("front"), "Front photo");
    assert.equal(byId.get("view-1"), "Crown");
    assert.equal(byId.get("view-2"), "Sleeve");
  });
});
