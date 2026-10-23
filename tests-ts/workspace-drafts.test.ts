import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyRetirementEvents,
  matchRetirementEvent,
  parseDraftIdentityKey,
} from "../src/core/workspace-drafts/index.js";
import type { DraftRetirementEvent } from "../src/core/workspace-drafts/types.js";

interface SyntheticScope {
  imagePath?: string;
  photoHash?: string;
  sourceRev?: string;
  productId?: string;
  variantId?: string;
  regionId?: string;
  frameId?: string;
  calibrationId?: string;
  calibrationVersion?: string;
  side?: string;
  transformKey?: string;
}

function makeKey(extra?: SyntheticScope): string {
  const imagePath = extra?.imagePath ?? "presentation/synth/front.png";
  const photoHash = extra?.photoHash ?? "12:abc123";
  return JSON.stringify([
    `${imagePath}#${photoHash}`,
    extra?.sourceRev ?? "rev-1",
    extra?.productId ?? "jacket-01",
    extra?.variantId ?? "std",
    extra?.regionId ?? "chest",
    extra?.frameId ?? "chest-frame",
    extra?.calibrationId ?? "cal-1",
    extra?.calibrationVersion ?? "v1",
    extra?.side ?? "front",
    extra?.transformKey ?? "[1,0,0,1,0,0]",
  ]);
}

describe("parseDraftIdentityKey", () => {
  it("parses a well-formed key and derives imagePath", () => {
    const parsed = parseDraftIdentityKey(makeKey());
    assert.notEqual(parsed, null);
    assert.equal(parsed!.photoId, "presentation/synth/front.png#12:abc123");
    assert.equal(parsed!.imagePath, "presentation/synth/front.png");
    assert.equal(parsed!.sourceRev, "rev-1");
    assert.equal(parsed!.productId, "jacket-01");
    assert.equal(parsed!.variantId, "std");
    assert.equal(parsed!.regionId, "chest");
    assert.equal(parsed!.frameId, "chest-frame");
    assert.equal(parsed!.calibrationId, "cal-1");
    assert.equal(parsed!.calibrationVersion, "v1");
    assert.equal(parsed!.side, "front");
    assert.equal(parsed!.transformKey, "[1,0,0,1,0,0]");
  });

  it("rejects unparseable and malformed keys without throwing", () => {
    assert.equal(parseDraftIdentityKey("not-json"), null);
    assert.equal(parseDraftIdentityKey(""), null);
    assert.equal(parseDraftIdentityKey(JSON.stringify({ photoId: "x" })), null);
    assert.equal(parseDraftIdentityKey(JSON.stringify(["only", "three", "entries"])), null);
    assert.equal(parseDraftIdentityKey(JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), null);
    const mixed = JSON.parse(makeKey()) as unknown[];
    mixed[4] = 42;
    assert.equal(parseDraftIdentityKey(JSON.stringify(mixed)), null);
    assert.equal(parseDraftIdentityKey(JSON.stringify([...(JSON.parse(makeKey()) as string[]), "extra"])), null);
  });
});

describe("matchRetirementEvent source-replaced", () => {
  it("retires keys with a different sourceRev and keeps the current rev", () => {
    const event: DraftRetirementEvent = { kind: "source-replaced", sourceRev: "rev-2" };
    assert.equal(matchRetirementEvent(makeKey({ sourceRev: "rev-1" }), event), true);
    assert.equal(matchRetirementEvent(makeKey({ sourceRev: "rev-2" }), event), false);
  });

  it("never matches malformed keys", () => {
    const event: DraftRetirementEvent = { kind: "source-replaced", sourceRev: "rev-2" };
    assert.equal(matchRetirementEvent("not-json", event), false);
    assert.equal(matchRetirementEvent(JSON.stringify(["a", "b"]), event), false);
  });
});

describe("matchRetirementEvent photo-replaced", () => {
  it("matches product plus imagePath prefix", () => {
    const event: DraftRetirementEvent = {
      kind: "photo-replaced",
      productId: "jacket-01",
      imagePath: "presentation/synth/front.png",
    };
    assert.equal(matchRetirementEvent(makeKey(), event), true);
    assert.equal(
      matchRetirementEvent(makeKey({ imagePath: "presentation/synth/back.png" }), event),
      false,
    );
    assert.equal(matchRetirementEvent(makeKey({ productId: "other-02" }), event), false);
  });

  it("scopes variantId as undefined-or-equal", () => {
    const wide: DraftRetirementEvent = {
      kind: "photo-replaced",
      productId: "jacket-01",
      imagePath: "presentation/synth/front.png",
    };
    assert.equal(matchRetirementEvent(makeKey({ variantId: "std" }), wide), true);
    assert.equal(matchRetirementEvent(makeKey({ variantId: "tall" }), wide), true);
    const narrow: DraftRetirementEvent = {
      kind: "photo-replaced",
      productId: "jacket-01",
      variantId: "std",
      imagePath: "presentation/synth/front.png",
    };
    assert.equal(matchRetirementEvent(makeKey({ variantId: "std" }), narrow), true);
    assert.equal(matchRetirementEvent(makeKey({ variantId: "tall" }), narrow), false);
  });

  it("requires the hash separator so bare prefixes never match", () => {
    const event: DraftRetirementEvent = {
      kind: "photo-replaced",
      productId: "jacket-01",
      imagePath: "presentation/synth/front",
    };
    assert.equal(matchRetirementEvent(makeKey(), event), false);
  });
});

describe("matchRetirementEvent scope-removed", () => {
  it("removes a whole product when no scope narrows it", () => {
    const event: DraftRetirementEvent = { kind: "scope-removed", productId: "jacket-01" };
    assert.equal(matchRetirementEvent(makeKey(), event), true);
    assert.equal(matchRetirementEvent(makeKey({ variantId: "tall" }), event), true);
    assert.equal(matchRetirementEvent(makeKey({ productId: "other-02" }), event), false);
  });

  it("narrows by variantId then regionId", () => {
    const byVariant: DraftRetirementEvent = { kind: "scope-removed", productId: "jacket-01", variantId: "std" };
    assert.equal(matchRetirementEvent(makeKey({ variantId: "std" }), byVariant), true);
    assert.equal(matchRetirementEvent(makeKey({ variantId: "tall" }), byVariant), false);
    const byRegion: DraftRetirementEvent = {
      kind: "scope-removed",
      productId: "jacket-01",
      variantId: "std",
      regionId: "chest",
    };
    assert.equal(matchRetirementEvent(makeKey({ regionId: "chest" }), byRegion), true);
    assert.equal(matchRetirementEvent(makeKey({ regionId: "back-panel" }), byRegion), false);
    const regionOnly: DraftRetirementEvent = {
      kind: "scope-removed",
      productId: "jacket-01",
      regionId: "chest",
    };
    assert.equal(matchRetirementEvent(makeKey({ variantId: "tall", regionId: "chest" }), regionOnly), true);
    assert.equal(matchRetirementEvent(makeKey({ regionId: "back-panel" }), regionOnly), false);
  });
});

describe("matchRetirementEvent binding-invalidated", () => {
  it("matches a product-wide invalidation", () => {
    const event: DraftRetirementEvent = { kind: "binding-invalidated", productId: "jacket-01" };
    assert.equal(matchRetirementEvent(makeKey(), event), true);
    assert.equal(matchRetirementEvent(makeKey({ productId: "other-02" }), event), false);
  });

  it("narrows by variant, region, image prefix and view side", () => {
    const event: DraftRetirementEvent = {
      kind: "binding-invalidated",
      productId: "jacket-01",
      variantId: "std",
      regionId: "chest",
      view: "front",
      imagePath: "presentation/synth/front.png",
    };
    assert.equal(matchRetirementEvent(makeKey(), event), true);
    assert.equal(
      matchRetirementEvent(makeKey({ variantId: "tall" }), event),
      false,
    );
    assert.equal(
      matchRetirementEvent(makeKey({ regionId: "back-panel" }), event),
      false,
    );
    assert.equal(matchRetirementEvent(makeKey({ side: "back" }), event), false);
    assert.equal(
      matchRetirementEvent(makeKey({ imagePath: "presentation/synth/back.png" }), event),
      false,
    );
  });

  it("treats each optional field as a wildcard when absent", () => {
    const imageOnly: DraftRetirementEvent = {
      kind: "binding-invalidated",
      productId: "jacket-01",
      imagePath: "presentation/synth/front.png",
    };
    assert.equal(matchRetirementEvent(makeKey({ side: "back" }), imageOnly), true);
    const viewOnly: DraftRetirementEvent = {
      kind: "binding-invalidated",
      productId: "jacket-01",
      view: "front",
    };
    assert.equal(matchRetirementEvent(makeKey({ side: "front" }), viewOnly), true);
    assert.equal(matchRetirementEvent(makeKey({ side: "back" }), viewOnly), false);
  });
});

describe("applyRetirementEvents", () => {
  it("unions combined events and sorts output deterministically", () => {
    const frontStd = makeKey();
    const backStd = makeKey({ imagePath: "presentation/synth/back.png", side: "back" });
    const frontTall = makeKey({ variantId: "tall" });
    const foreign = makeKey({ productId: "other-02" });
    const events: DraftRetirementEvent[] = [
      { kind: "photo-replaced", productId: "jacket-01", imagePath: "presentation/synth/front.png" },
      { kind: "scope-removed", productId: "jacket-01", variantId: "std", regionId: "missing-region" },
    ];
    const shuffled = [foreign, frontTall, backStd, frontStd];
    const first = applyRetirementEvents(shuffled, events);
    assert.deepEqual(first.retired, [frontStd, frontTall].sort());
    assert.deepEqual(first.kept, [backStd, foreign].sort());
    const second = applyRetirementEvents([...shuffled].reverse(), [...events].reverse());
    assert.deepEqual(second, first);
  });

  it("keeps foreign and malformed keys and keeps everything when idle", () => {
    const good = makeKey();
    const malformed = ["not-json", JSON.stringify(["a", "b"]), JSON.stringify({}), ""];
    const events: DraftRetirementEvent[] = [
      { kind: "source-replaced", sourceRev: "rev-2" },
      { kind: "scope-removed", productId: "jacket-01" },
    ];
    const result = applyRetirementEvents([good, ...malformed], events);
    assert.deepEqual(result.retired, [good]);
    assert.deepEqual(result.kept, [...malformed].sort());
    const idle = applyRetirementEvents([good], []);
    assert.deepEqual(idle, { retired: [], kept: [good] });
  });

  it("is deterministic across repeat calls", () => {
    const keys = [
      makeKey({ side: "back", imagePath: "presentation/synth/back.png" }),
      makeKey(),
      makeKey({ variantId: "tall" }),
    ];
    const events: DraftRetirementEvent[] = [
      { kind: "binding-invalidated", productId: "jacket-01", view: "front" },
    ];
    assert.deepEqual(applyRetirementEvents(keys, events), applyRetirementEvents(keys, events));
  });
});
