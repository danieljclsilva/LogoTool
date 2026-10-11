import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fitUniformScale } from "../src/core/calibration/index.js";
import {
  buildEvidence,
  snapshotEvidence,
} from "../src/core/calibration-session/index.js";
import {
  createPlanarRegion,
  type PlanarRegionRecord,
} from "../src/core/planar-region/index.js";
import {
  addExclusion,
  setSafePolygon,
  type AreasMap,
} from "../src/core/region-areas/index.js";
import {
  transferPlacements,
  serializeTransferBundle,
  VARIANT_TRANSFER_VERSION,
  VARIANT_TRANSFER_LIMITS,
  type TransferRequest,
  type VariantTransferContext,
} from "../src/core/variant-transfer/index.js";
import type {
  DraftPlacement,
  LogosMap,
  PlacementsMap,
} from "../src/core/logo-placements/index.js";

const SHA = "ab".repeat(32);
const BIG_SAFE = "[[-2000,-2000],[2000,-2000],[2000,2000],[-2000,2000]]";
const CONCAVE_SAFE = "[[0,0],[50,50],[100,0],[100,100],[0,100]]";
const SQUARE_SAFE = "[[0,0],[100,0],[100,100],[0,100]]";
const HOLE = "[[10,10],[20,10],[20,20],[10,20]]";

function anchors() {
  return [
    { id: "O", model: { x: 0, y: 0, z: 0 } },
    { id: "X", model: { x: 10, y: 0, z: 0 } },
    { id: "Y", model: { x: 3, y: 5, z: 0 } },
  ];
}

function makeSide(opts: {
  product: string;
  variant: string;
  calibrationId: string;
  regionIds?: string[];
  safe?: string;
}): VariantTransferContext {
  const regionIds = opts.regionIds ?? ["front"];
  const built = buildEvidence(
    {
      product: opts.product,
      variant: opts.variant,
      calibrationId: opts.calibrationId,
      frameId: "asset-root",
      provisionalVersion: "draft-1",
      toleranceMm: 0.5,
      relativeTolerance: 0.01,
      assetFullSha256: SHA,
    },
    anchors(),
    [{ a: "O", b: "X", distanceMm: 100 }],
  );
  assert.ok(built.ok);
  const ev = built.evidence;
  const fit = fitUniformScale(ev);
  const snap = snapshotEvidence(ev);
  const regions: PlanarRegionRecord[] = [];
  let areas: AreasMap = {};
  for (const regionId of regionIds) {
    const made = createPlanarRegion(
      {
        regionId,
        frameId: `${regionId}-mm`,
        originAnchorId: "O",
        xAnchorId: "X",
        yAnchorId: "Y",
        offPlaneToleranceMm: 0.01,
      },
      anchors(),
      ev,
      snap,
    );
    assert.ok(made.ok);
    regions.push(made.region);
    const set = setSafePolygon(areas, made.region, opts.safe ?? BIG_SAFE);
    assert.ok(set.ok);
    areas = set.areas;
  }
  return {
    product: opts.product,
    variant: opts.variant,
    evidence: ev,
    fit: {
      scaleMmPerUnit: fit.scaleMmPerUnit,
      inconsistent: fit.inconsistent,
      assetFullSha256: fit.assetFullSha256,
    },
    regions,
    areas,
    evidenceSnapshot: snap,
  };
}

function sourceSide(regionIds?: string[], safe?: string): VariantTransferContext {
  return makeSide({
    product: "synthetic-tee",
    variant: "S",
    calibrationId: "cal-s",
    ...(regionIds !== undefined ? { regionIds } : {}),
    ...(safe !== undefined ? { safe } : {}),
  });
}

function targetSide(regionIds?: string[], safe?: string): VariantTransferContext {
  return makeSide({
    product: "synthetic-tee",
    variant: "M",
    calibrationId: "cal-t",
    ...(regionIds !== undefined ? { regionIds } : {}),
    ...(safe !== undefined ? { safe } : {}),
  });
}

const logos = (): LogosMap => ({ crest: { id: "crest", name: "Crest" } });

const placement = (overrides: Partial<DraftPlacement> = {}): DraftPlacement => ({
  id: "p1",
  logoId: "crest",
  regionId: "front",
  xMm: 30,
  yMm: 40,
  widthMm: 80,
  heightMm: 40,
  rotationDeg: 0,
  ...overrides,
});

const absRule = (sourceRegionId = "front", targetRegionId = "front") => ({
  sourceRegionId,
  targetRegionId,
  strategy: "absolute-position" as const,
  sourceFrameConvention: "centre-mm",
  targetFrameConvention: "centre-mm",
});

const normRule = (
  sRef: { originXmm: number; originYmm: number; widthMm: number; heightMm: number },
  tRef: { originXmm: number; originYmm: number; widthMm: number; heightMm: number },
  extra: Record<string, unknown> = {},
) => ({
  sourceRegionId: "front",
  targetRegionId: "front",
  strategy: "normalized-position" as const,
  sourceFrameConvention: "centre-mm",
  targetFrameConvention: "centre-mm",
  sourceRef: sRef,
  targetRef: tRef,
  ...extra,
});

function baseRequest(over: Partial<TransferRequest> = {}): TransferRequest {
  return {
    transferVersion: VARIANT_TRANSFER_VERSION,
    source: sourceSide(),
    sourceLogos: logos(),
    sourcePlacements: { p1: placement() },
    target: targetSide(),
    rules: [absRule()],
    ...over,
  };
}

function expectOk(request: TransferRequest) {
  const out = transferPlacements(request);
  if (!out.ok) assert.fail(`expected ok:true, got ${JSON.stringify(out)}`);
  return out.bundle;
}

function expectFail(request: unknown) {
  const parsed = request as TransferRequest; // test-only: feeds malformed shapes to the fail-closed kernel
  const out = transferPlacements(parsed);
  if (out.ok) assert.fail(`expected ok:false, got ${JSON.stringify(out)}`);
  return out;
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
}

describe("variant-transfer absolute", () => {
  it("copies centre (30,40) size 80x40 verbatim with flags", () => {
    const bundle = expectOk(baseRequest());
    assert.equal(bundle.schemaVersion, VARIANT_TRANSFER_VERSION);
    assert.equal(bundle.pendingReview, true);
    assert.equal(bundle.productionApproved, false);
    assert.equal(bundle.transfers.length, 1);
    const t = bundle.transfers[0]!;
    assert.equal(t.strategy, "absolute-position");
    assert.equal(t.xMm, 30);
    assert.equal(t.yMm, 40);
    assert.equal(t.widthMm, 80);
    assert.equal(t.heightMm, 40);
    assert.equal(t.sourceRegionId, "front");
    assert.equal(t.targetRegionId, "front");
    const placed = bundle.target.placements.find((p) => p.id === "p1");
    assert.ok(placed);
    assert.deepEqual(
      [placed.xMm, placed.yMm, placed.widthMm, placed.heightMm, placed.rotationDeg],
      [30, 40, 80, 40, 0],
    );
  });
});

describe("variant-transfer normalized", () => {
  it("maps (50,25) via S=(0,0,200,100) T=(10,20,300,150) to (85,57.5)", () => {
    const bundle = expectOk(
      baseRequest({
        rules: [
          normRule(
            { originXmm: 0, originYmm: 0, widthMm: 200, heightMm: 100 },
            { originXmm: 10, originYmm: 20, widthMm: 300, heightMm: 150 },
          ),
        ],
        sourcePlacements: { p1: placement({ xMm: 50, yMm: 25 }) },
      }),
    );
    const t = bundle.transfers[0]!;
    assert.equal(t.strategy, "normalized-position");
    assert.equal(t.xMm, 85);
    assert.equal(t.yMm, 57.5);
  });
  it("maps a second shifted-origin case to (95,60)", () => {
    const bundle = expectOk(
      baseRequest({
        rules: [
          normRule(
            { originXmm: 5, originYmm: 5, widthMm: 100, heightMm: 50 },
            { originXmm: -5, originYmm: 10, widthMm: 200, heightMm: 100 },
          ),
        ],
        sourcePlacements: { p1: placement({ xMm: 55, yMm: 30 }) },
      }),
    );
    const t = bundle.transfers[0]!;
    assert.ok(Math.abs(t.xMm - 95) < 1e-9, `x ${t.xMm}`);
    assert.ok(Math.abs(t.yMm - 60) < 1e-9, `y ${t.yMm}`);
  });
});

describe("variant-transfer dimensions", () => {
  it("keeps 80x40 fixed-size by default under normalized mapping", () => {
    const bundle = expectOk(
      baseRequest({
        rules: [
          normRule(
            { originXmm: 0, originYmm: 0, widthMm: 200, heightMm: 100 },
            { originXmm: 10, originYmm: 20, widthMm: 300, heightMm: 150 },
          ),
        ],
      }),
    );
    const t = bundle.transfers[0]!;
    assert.equal(t.widthMm, 80);
    assert.equal(t.heightMm, 40);
  });
  it("scales proportionally to 120x60 when proportional:true", () => {
    const bundle = expectOk(
      baseRequest({
        rules: [
          normRule(
            { originXmm: 0, originYmm: 0, widthMm: 200, heightMm: 100 },
            { originXmm: 10, originYmm: 20, widthMm: 300, heightMm: 150 },
            { proportionalDimensions: true },
          ),
        ],
      }),
    );
    const t = bundle.transfers[0]!;
    assert.equal(t.widthMm, 120);
    assert.equal(t.heightMm, 60);
  });
});

describe("variant-transfer overrides", () => {
  it("override wins over the rule for position/region/size/rotation", () => {
    const bundle = expectOk(
      baseRequest({
        source: sourceSide(["front", "back"]),
        target: targetSide(["front", "back"]),
        overrides: [
          {
            placementId: "p1",
            targetRegionId: "back",
            xMm: 7,
            yMm: 8,
            widthMm: 9,
            heightMm: 10,
            rotationDeg: 45,
          },
        ],
      }),
    );
    const t = bundle.transfers[0]!;
    assert.equal(t.strategy, "override");
    assert.equal(t.targetRegionId, "back");
    assert.deepEqual([t.xMm, t.yMm, t.widthMm, t.heightMm, t.rotationDeg], [7, 8, 9, 10, 45]);
    const placed = bundle.target.placements.find((p) => p.id === "p1");
    assert.ok(placed);
    assert.equal(placed.regionId, "back");
  });
  it("partial override defaults size/rotation to the source", () => {
    const bundle = expectOk(
      baseRequest({
        sourcePlacements: { p1: placement({ rotationDeg: 30 }) },
        overrides: [{ placementId: "p1", targetRegionId: "front", xMm: 1, yMm: 2 }],
      }),
    );
    const t = bundle.transfers[0]!;
    assert.equal(t.strategy, "override");
    assert.deepEqual([t.xMm, t.yMm, t.widthMm, t.heightMm, t.rotationDeg], [1, 2, 80, 40, 30]);
  });
});

describe("variant-transfer rotation and multiplicity", () => {
  it("copies rotation 30 verbatim under absolute mapping", () => {
    const bundle = expectOk(baseRequest({ sourcePlacements: { p1: placement({ rotationDeg: 30 }) } }));
    assert.equal(bundle.transfers[0]!.rotationDeg, 30);
    assert.equal(bundle.target.placements.find((p) => p.id === "p1")!.rotationDeg, 30);
  });
  it("transfers zero placements to an empty bundle", () => {
    const bundle = expectOk(baseRequest({ sourceLogos: {}, sourcePlacements: {}, rules: [] }));
    assert.deepEqual(bundle.transfers, []);
    assert.deepEqual(bundle.target.placements, []);
    assert.equal(bundle.pendingReview, true);
    assert.equal(bundle.productionApproved, false);
  });
  it("supports a repeated logo and multiple mapped regions", () => {
    const multi: LogosMap = { ...logos(), wordmark: { id: "wordmark", name: "Wordmark" } };
    const placements: PlacementsMap = {
      a: placement({ id: "a", regionId: "front", xMm: 10, yMm: 10 }),
      b: placement({ id: "b", regionId: "back", xMm: 20, yMm: 20 }),
      c: placement({ id: "c", logoId: "wordmark", regionId: "front", xMm: 30, yMm: 30 }),
    };
    const bundle = expectOk(
      baseRequest({
        source: sourceSide(["front", "back"]),
        sourceLogos: multi,
        sourcePlacements: placements,
        target: targetSide(["front", "back"]),
        rules: [absRule("front", "front"), absRule("back", "back")],
      }),
    );
    assert.equal(bundle.transfers.length, 3);
    assert.deepEqual(
      bundle.transfers.map((t) => t.sourcePlacementId),
      ["a", "b", "c"],
    );
    assert.equal(bundle.target.placements.length, 3);
    assert.ok(bundle.target.statuses.every((s) => s.fits));
  });
});

describe("variant-transfer evidence staleness", () => {
  it("rejects a tampered source evidenceSnapshot", () => {
    const source = sourceSide();
    const out = expectFail(baseRequest({ source: { ...source, evidenceSnapshot: "tampered" } }));
    assert.match(out.error, /snapshot|cannot transfer/);
  });
  it("rejects a forged source fit scale", () => {
    const source = sourceSide();
    const out = expectFail(
      baseRequest({ source: { ...source, fit: { ...source.fit, scaleMmPerUnit: source.fit.scaleMmPerUnit * 2 } } }),
    );
    assert.match(out.error, /fit|cannot transfer/);
  });
  it("rejects a forged source fit asset hash", () => {
    const source = sourceSide();
    const out = expectFail(
      baseRequest({ source: { ...source, fit: { ...source.fit, assetFullSha256: "cc".repeat(32) } } }),
    );
    assert.match(out.error, /fit|cannot transfer/);
  });
  it("rejects source region geometry that no longer matches evidence", () => {
    const source = sourceSide();
    const region = source.regions[0]!;
    const moved = {
      ...region,
      origin: { ...region.origin, x: region.origin.x + 5 },
    } as PlanarRegionRecord;
    const out = expectFail(baseRequest({ source: { ...source, regions: [moved] } }));
    assert.match(out.error, /cannot transfer/);
  });
  it("rejects source areas whose frame snapshot is stale vs the region", () => {
    const source = sourceSide();
    const staleAreas = JSON.parse(JSON.stringify(source.areas)) as AreasMap;
    staleAreas["front"] = { ...staleAreas["front"]!, frameSnapshot: "stale-snapshot" };
    const out = expectFail(baseRequest({ source: { ...source, areas: staleAreas } }));
    assert.match(out.error, /cannot transfer/);
  });
});

describe("variant-transfer target verdicts", () => {
  it("keeps a concave-notch escape as ok:true with a fits:false status", () => {
    const bundle = expectOk(
      baseRequest({
        target: targetSide(["front"], CONCAVE_SAFE),
        sourcePlacements: { p1: placement({ xMm: 50, yMm: 30, widthMm: 60, heightMm: 10 }) },
      }),
    );
    const status = bundle.target.statuses.find((s) => s.id === "p1");
    assert.ok(status, "expected a target status for p1");
    assert.equal(status.fits, false);
  });
  it("keeps an exclusion touch as ok:true with a fits:false status", () => {
    const target = targetSide(["front"], SQUARE_SAFE);
    const region = target.regions.find((r) => r.regionId === "front")!;
    const withHole = addExclusion(target.areas, region, "hole", "Hole", HOLE);
    assert.ok(withHole.ok);
    const bundle = expectOk(
      baseRequest({
        target: { ...target, areas: withHole.areas },
        sourcePlacements: { p1: placement({ xMm: 15, yMm: 7.5, widthMm: 10, heightMm: 5 }) },
      }),
    );
    const status = bundle.target.statuses.find((s) => s.id === "p1");
    assert.ok(status, "expected a target status for p1");
    assert.equal(status.fits, false);
  });
  it("allows safe-boundary contact with fits:true", () => {
    const bundle = expectOk(
      baseRequest({
        target: targetSide(["front"], CONCAVE_SAFE),
        sourcePlacements: { p1: placement({ xMm: 50, yMm: 95, widthMm: 100, heightMm: 10 }) },
      }),
    );
    const status = bundle.target.statuses.find((s) => s.id === "p1");
    assert.ok(status, "expected a target status for p1");
    assert.equal(status.fits, true);
  });
});

describe("variant-transfer determinism and immutability", () => {
  it("serializes identical bytes under shuffled insertion order", () => {
    const mk = (flip: boolean) => {
      const placements: PlacementsMap = {};
      const ids = flip ? ["p2", "p1"] : ["p1", "p2"];
      for (const id of ids) placements[id] = placement({ id, xMm: id === "p1" ? 30 : 60 });
      const logoEntries = flip
        ? (["wordmark", "crest"] as const)
        : (["crest", "wordmark"] as const);
      const multi: LogosMap = {};
      for (const id of logoEntries) multi[id] = { id, name: id };
      const rules = flip ? [absRule("back", "back"), absRule("front", "front")] : [absRule("front", "front"), absRule("back", "back")];
      return transferPlacements({
        transferVersion: VARIANT_TRANSFER_VERSION,
        source: sourceSide(["front", "back"]),
        sourceLogos: multi,
        sourcePlacements: placements,
        target: targetSide(["front", "back"]),
        rules,
        overrides: flip
          ? [
              { placementId: "p2", targetRegionId: "front", xMm: 5, yMm: 5 },
              { placementId: "p1", targetRegionId: "front", xMm: 6, yMm: 6 },
            ]
          : [
              { placementId: "p1", targetRegionId: "front", xMm: 6, yMm: 6 },
              { placementId: "p2", targetRegionId: "front", xMm: 5, yMm: 5 },
            ],
      });
    };
    const a = mk(false);
    const b = mk(true);
    assert.ok(a.ok && b.ok);
    assert.equal(serializeTransferBundle(a.bundle), serializeTransferBundle(b.bundle));
  });
  it("leaves a deep-frozen input unchanged and the bundle independent", () => {
    const request = baseRequest();
    const before = JSON.parse(JSON.stringify(request)) as unknown;
    deepFreeze(request);
    const out = transferPlacements(request);
    assert.ok(out.ok);
    assert.equal(JSON.stringify(request), JSON.stringify(before));
    const bytes = serializeTransferBundle(out.bundle);
    out.bundle.transfers[0]!.xMm = 999999;
    out.bundle.target.placements[0]!.xMm = 999999;
    const again = transferPlacements(request);
    assert.ok(again.ok);
    assert.equal(serializeTransferBundle(again.bundle), bytes);
  });
});

describe("variant-transfer malformed inputs and limits", () => {
  it("keeps existing restore exports available through the core API", async () => {
    const core = await import("../src/core/index.js");
    assert.equal(typeof core.parsePlacementRestore, "function");
    assert.ok(core.PLACEMENT_RESTORE_LIMITS);
    assert.equal(core.transferPlacements, transferPlacements);
  });
  it("rejects JSON hooks without executing them or mutating input", () => {
    const request = baseRequest();
    let called = false;
    Object.assign(request, { toJSON: () => { called = true; return {}; } });
    expectFail(request);
    assert.equal(called, false);
  });
  it("rejects duplicate rules for a source region", () => {
    expectFail(baseRequest({ rules: [absRule(), absRule()] }));
  });
  it("rejects target areas with a stale frame snapshot", () => {
    const target = targetSide();
    target.areas["front"]!.frameSnapshot = "stale";
    expectFail(baseRequest({ target }));
  });
  it("rejects a NaN source position", () => {
    expectFail(baseRequest({ sourcePlacements: { p1: placement({ xMm: NaN }) } }));
  });
  it("rejects an Infinity source dimension", () => {
    expectFail(baseRequest({ sourcePlacements: { p1: placement({ widthMm: Infinity }) } }));
  });
  it("rejects a source coordinate beyond VARIANT_TRANSFER_LIMITS", () => {
    expectFail(
      baseRequest({
        sourcePlacements: { p1: placement({ xMm: VARIANT_TRANSFER_LIMITS.maxCoordMm + 1 }) },
      }),
    );
  });
  it("rejects an override dimension beyond VARIANT_TRANSFER_LIMITS", () => {
    expectFail(
      baseRequest({
        overrides: [
          {
            placementId: "p1",
            targetRegionId: "front",
            xMm: 1,
            yMm: 2,
            widthMm: VARIANT_TRANSFER_LIMITS.maxDimMm + 1,
          },
        ],
      }),
    );
  });
  it("rejects more placements than maxPlacements", () => {
    const placements: PlacementsMap = {};
    for (let i = 0; i <= VARIANT_TRANSFER_LIMITS.maxPlacements; i += 1) {
      const id = `k${i}`;
      placements[id] = placement({ id });
    }
    const out = expectFail(baseRequest({ sourcePlacements: placements }));
    assert.match(out.error, /too many placements/);
  });
  it("rejects an id longer than maxIdLength", () => {
    const id = "x".repeat(VARIANT_TRANSFER_LIMITS.maxIdLength + 1);
    const bad: PlacementsMap = {};
    bad[id] = placement({ id });
    expectFail(baseRequest({ sourcePlacements: bad }));
  });
  it("rejects duplicate overrides for the same placementId", () => {
    const override = { placementId: "p1", targetRegionId: "front", xMm: 1, yMm: 2 };
    expectFail(baseRequest({ overrides: [override, { ...override }] }));
  });
  it("rejects a placement with neither rule nor override", () => {
    expectFail(
      baseRequest({
        source: sourceSide(["front", "back"]),
        sourcePlacements: { p1: placement({ regionId: "back" }) },
        target: targetSide(["front", "back"]),
        rules: [absRule("front", "front")],
      }),
    );
  });
  it("rejects an unsupported rule strategy string", () => {
    expectFail(baseRequest({ rules: [{ ...absRule(), strategy: "scaled-position" } as never] }));
  });
  it("rejects a mismatched transferVersion string", () => {
    expectFail(baseRequest({ transferVersion: "9.9.9-nope" }));
  });
  it("rejects a blank frame convention on an absolute rule", () => {
    expectFail(
      baseRequest({
        rules: [
          {
            sourceRegionId: "front",
            targetRegionId: "front",
            strategy: "absolute-position",
            sourceFrameConvention: "",
            targetFrameConvention: "",
          },
        ],
      }),
    );
  });
  it("rejects source.product mismatching the source evidence", () => {
    const source = sourceSide();
    expectFail(baseRequest({ source: { ...source, product: "wrong" } }));
  });
  it("rejects source.variant mismatching the source evidence", () => {
    const source = sourceSide();
    expectFail(baseRequest({ source: { ...source, variant: "XXL" } }));
  });
  it("rejects target.product mismatching the target evidence", () => {
    const target = targetSide();
    expectFail(baseRequest({ target: { ...target, product: "wrong" } }));
  });
  it("rejects target.variant mismatching the target evidence", () => {
    const target = targetSide();
    expectFail(baseRequest({ target: { ...target, variant: "XXL" } }));
  });
  it("rejects mismatched absolute frame conventions", () => {
    expectFail(
      baseRequest({
        rules: [
          {
            ...absRule(),
            sourceFrameConvention: "centre-mm",
            targetFrameConvention: "corner-mm",
          },
        ],
      }),
    );
  });
  it("fails cyclic input as ok:false without throwing", () => {
    const raw: unknown = baseRequest();
    if (raw !== null && typeof raw === "object") Reflect.set(raw, "cycle", raw);
    const malformed = raw as TransferRequest; // cyclic graph: only the kernel's clone path may touch it
    let threw = false;
    let out: unknown;
    try {
      out = transferPlacements(malformed);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "transferPlacements must not throw on cyclic input");
    assert.equal(out !== null && typeof out === "object" && "ok" in out && out.ok, false);
  });
  it("fails BigInt input as ok:false without throwing", () => {
    const request = baseRequest();
    const rawPlacements: unknown = request.sourcePlacements;
    if (rawPlacements !== null && typeof rawPlacements === "object" && "p1" in rawPlacements) {
      const entry: unknown = rawPlacements.p1;
      if (entry !== null && typeof entry === "object") Reflect.set(entry, "xMm", 10n);
    }
    let threw = false;
    let out: unknown;
    try {
      out = transferPlacements(request);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "transferPlacements must not throw on BigInt input");
    assert.equal(out !== null && typeof out === "object" && "ok" in out && out.ok, false);
  });
  it("rejects a target fit scale forged against recomputation", () => {
    const target = targetSide();
    expectFail(
      baseRequest({
        target: {
          ...target,
          fit: { ...target.fit, scaleMmPerUnit: target.fit.scaleMmPerUnit * 3 },
        },
      }),
    );
  });
  it("rejects a target region whose frame binding no longer matches areas", () => {
    const target = targetSide();
    const region = target.regions[0]!;
    const moved = { ...region, frameId: "forged-mm" } as PlanarRegionRecord;
    expectFail(baseRequest({ target: { ...target, regions: [moved] } }));
  });
  it("rejects a dangling target calibration identity", () => {
    const target = targetSide();
    const region = target.regions[0]!;
    const forged = { ...region, calibrationId: "forged-cal" } as PlanarRegionRecord;
    expectFail(baseRequest({ target: { ...target, regions: [forged] } }));
  });
  it("keeps the target calibration/frame identities copied from the target context", () => {
    const bundle = expectOk(baseRequest());
    assert.equal(bundle.target.session.evidence.calibrationId, "cal-t");
    assert.equal(bundle.target.regions[0]!.frameId, "front-mm");
  });
  it("rejects a malformed normalized reference rect", () => {
    expectFail(
      baseRequest({
        rules: [
          normRule(
            { originXmm: 0, originYmm: 0, widthMm: 200, heightMm: 100 },
            { originXmm: 10, originYmm: 20, widthMm: 0, heightMm: 150 },
          ),
        ],
      }),
    );
  });
  it("rejects a missing normalized target reference rect", () => {
    const rule = normRule(
      { originXmm: 0, originYmm: 0, widthMm: 200, heightMm: 100 },
      { originXmm: 10, originYmm: 20, widthMm: 300, heightMm: 150 },
    );
    const { targetRef: _dropped, ...noTarget } = rule;
    expectFail(baseRequest({ rules: [noTarget] }));
  });
  it("rejects a non-finite normalized transfer result", () => {
    const out = expectFail(
      baseRequest({
        rules: [
          normRule(
            { originXmm: 0, originYmm: 0, widthMm: 1e-300, heightMm: 100 },
            { originXmm: 0, originYmm: 0, widthMm: VARIANT_TRANSFER_LIMITS.maxDimMm, heightMm: 100 },
          ),
        ],
        sourcePlacements: { p1: placement({ xMm: VARIANT_TRANSFER_LIMITS.maxCoordMm }) },
      }),
    );
    assert.match(out.error, /produced non-finite/);
  });
  it("rejects a dangling logo reference in the source placements", () => {
    expectFail(baseRequest({ sourcePlacements: { p1: placement({ logoId: "ghost" }) } }));
  });
});
