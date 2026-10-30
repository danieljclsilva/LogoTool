import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePresentationManifest as parseFlexible,
  serializePresentationManifest as serializeFlexible,
  normalizeModelLighting as normalizeCore,
  isModelLighting as isCoreLighting,
  MODEL_LIGHTING_DEFAULT as CORE_DEFAULT,
  MODEL_LIGHTING_MIN as CORE_MIN,
  MODEL_LIGHTING_MAX as CORE_MAX,
} from '../src/core/presentation-views/index.js';
import {
  parsePresentationManifest as parseLegacy,
  selectPresentationModel as selectLegacyModel,
  selectPresentationPackageAssets as selectLegacyAssets,
  normalizeModelLighting as normalizeLegacy,
  PRESENTATION_MANIFEST_PATH,
} from '../src/ui/customer-editor/presentation-assets.js';
import { resolveModelPlacementScene } from '../src/ui/model-placement-scene.js';
import type { ProjectDocument } from '../src/core/types.js';

function enc(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function glb(): Uint8Array {
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
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
  for (let i = 20 + json.length; i < total; i++) bytes[i] = 0x20;
  return bytes;
}

function lookupOf(entries: Record<string, Uint8Array>): (path: string) => Uint8Array | undefined {
  return (path) => entries[path];
}

function minimalProject(): ProjectDocument {
  return {
    schemaVersion: '0.1.0-provisional',
    projectId: 'lighting-test',
    revision: 1,
    products: [{
      schemaVersion: '0.1.0-provisional',
      id: 'jacket',
      name: 'Jacket',
      kind: 'upper-body',
      variants: [
        { id: 'black', name: 'Black', regionIds: [] },
        { id: 'white', name: 'White', regionIds: [] },
      ],
      regions: [],
      calibrations: [],
    }],
    logos: [],
    configurations: [
      { id: 'cfg-black', productId: 'jacket', variantId: 'black', placements: [] },
      { id: 'cfg-white', productId: 'jacket', variantId: 'white', placements: [] },
    ],
  };
}

test('lighting bounds and defaults normalize to 1', () => {
  assert.equal(CORE_MIN, 0.25);
  assert.equal(CORE_MAX, 3);
  assert.equal(CORE_DEFAULT, 1);
  assert.equal(normalizeCore(1), 1);
  assert.equal(normalizeCore(0.25), 0.25);
  assert.equal(normalizeCore(3), 3);
  assert.equal(normalizeCore(2.5), 2.5);
  for (const bad of [undefined, null, '1.5', Number.NaN, Number.POSITIVE_INFINITY, 0, 0.24, 3.01, -1]) {
    assert.equal(normalizeCore(bad), 1, `core normalizes ${String(bad)} to default`);
    assert.equal(normalizeLegacy(bad), 1, `legacy normalizes ${String(bad)} to default`);
  }
  assert.equal(isCoreLighting(1.5), true);
  assert.equal(isCoreLighting(0.24), false);
  assert.equal(isCoreLighting('1.5'), false);
});

test('flexible manifest preserves validated lighting and ignores only bad lighting', () => {
  const raw = {
    version: 2,
    views: [],
    models: [
      { productId: 'jacket', model: 'presentation/a.glb', lighting: 1.5 },
      { productId: 'jacket', variantId: 'black', model: 'presentation/b.glb', lighting: 0.5 },
    ],
  };
  const parsed = parseFlexible(JSON.parse(new TextDecoder().decode(enc(raw))));
  assert.ok(parsed);
  assert.equal(parsed!.models![0]!.lighting, 1.5);
  assert.equal(parsed!.models![1]!.lighting, 0.5);
  const text = serializeFlexible(parsed!);
  const round = parseFlexible(JSON.parse(text));
  assert.equal(round!.models![0]!.lighting, 1.5);
  assert.equal(round!.models![1]!.lighting, 0.5);

  // Old files without lighting stay valid with the default.
  const old = parseFlexible(JSON.parse(new TextDecoder().decode(enc({ version: 2, views: [], models: [{ productId: 'jacket', model: 'presentation/a.glb' }] }))));
  assert.ok(old);
  assert.equal(old!.models![0]!.lighting, undefined);
  assert.equal(normalizeCore(old!.models![0]!.lighting), 1);

  // One bad lighting value never poisons the manifest or sibling entries.
  for (const bad of ['bright', Number.NaN, Number.POSITIVE_INFINITY, 0, 10]) {
    const mixed = parseFlexible(JSON.parse(new TextDecoder().decode(enc({
      version: 2,
      views: [],
      models: [
        { productId: 'jacket', model: 'presentation/a.glb', lighting: bad },
        { productId: 'jacket', model: 'presentation/b.glb', lighting: 2 },
      ],
    }))));
    assert.ok(mixed, `bad lighting ${String(bad)} keeps manifest valid`);
    assert.equal(mixed!.models!.length, 2);
    const first = mixed!.models!.find((e) => e.model === 'presentation/a.glb')!;
    const second = mixed!.models!.find((e) => e.model === 'presentation/b.glb')!;
    assert.equal(first.lighting, undefined);
    assert.equal(second.lighting, 2);
  }
});

test('legacy manifest preserves lighting and selects it per scope', () => {
  const manifest = parseLegacy(enc({
    version: 2,
    views: [],
    models: [
      { productId: 'jacket', model: 'presentation/wide.glb', lighting: 1.25 },
      { productId: 'jacket', variantId: 'black', model: 'presentation/scoped.glb', lighting: 2 },
    ],
  }));
  assert.ok(manifest);
  const models = (manifest as unknown as { models?: Array<{ variantId?: string; lighting?: number }> }).models!;
  const wide = models.find((e) => e.variantId === undefined)!;
  const scoped = models.find((e) => e.variantId === 'black')!;
  assert.equal(wide.lighting, 1.25);
  assert.equal(scoped.lighting, 2);

  const modelBytes = glb();
  const lookup = lookupOf({ 'presentation/wide.glb': modelBytes, 'presentation/scoped.glb': modelBytes });
  // Exact variant wins with its own lighting; other variants fall back to product-wide.
  const black = selectLegacyModel(manifest, true, 'jacket', 'black', lookup);
  assert.equal(black.modelPath, 'presentation/scoped.glb');
  assert.equal((black as { lighting?: number }).lighting, 2);
  const white = selectLegacyModel(manifest, true, 'jacket', 'white', lookup);
  assert.equal(white.modelPath, 'presentation/wide.glb');
  assert.equal((white as { lighting?: number }).lighting, 1.25);

  // Bad lighting is ignored, not fatal, and selects to the default.
  const bad = parseLegacy(enc({ version: 2, views: [], models: [{ productId: 'jacket', model: 'presentation/wide.glb', lighting: 'bright' }] }));
  assert.ok(bad);
  assert.equal((bad as unknown as { models?: Array<{ lighting?: number }> }).models![0]!.lighting, undefined);
  const badSel = selectLegacyModel(bad, true, 'jacket', 'white', lookupOf({ 'presentation/wide.glb': modelBytes }));
  assert.equal(badSel.modelPath, 'presentation/wide.glb');
  assert.equal((badSel as { lighting?: number }).lighting, undefined);
});

test('issued package retains validated lighting per scope and isolates variants', () => {
  const modelBytes = glb();
  const manifestBytes = enc({
    version: 2,
    views: [],
    models: [
      { productId: 'jacket', model: 'presentation/wide.glb', lighting: 1.5 },
      { productId: 'jacket', variantId: 'black', model: 'presentation/black.glb', lighting: 0.5 },
    ],
  });
  const assets = [
    { path: PRESENTATION_MANIFEST_PATH, bytes: manifestBytes, kind: 'additional' as const },
    { path: 'presentation/wide.glb', bytes: modelBytes, kind: 'additional' as const },
    { path: 'presentation/black.glb', bytes: modelBytes, kind: 'additional' as const },
  ];
  const blackOnly = selectLegacyAssets(assets, [{ productId: 'jacket', variantId: 'black' }]);
  const rewrittenBlack = JSON.parse(new TextDecoder().decode(blackOnly.find((e) => e.path === PRESENTATION_MANIFEST_PATH)!.bytes));
  // Product-wide entries ride along with every variant; the exact variant
  // entry carries its own lighting without leaking into other scopes.
  assert.equal(rewrittenBlack.models.length, 2);
  const blackWide = rewrittenBlack.models.find((e: { model: string }) => e.model === 'presentation/wide.glb');
  const blackScoped = rewrittenBlack.models.find((e: { model: string }) => e.model === 'presentation/black.glb');
  assert.equal(blackWide.lighting, 1.5);
  assert.equal(blackScoped.lighting, 0.5);
  assert.deepEqual(blackOnly.map((e) => e.path).sort(), [PRESENTATION_MANIFEST_PATH, 'presentation/black.glb', 'presentation/wide.glb'].sort());

  const whiteOnly = selectLegacyAssets(assets, [{ productId: 'jacket', variantId: 'white' }]);
  const rewrittenWhite = JSON.parse(new TextDecoder().decode(whiteOnly.find((e) => e.path === PRESENTATION_MANIFEST_PATH)!.bytes));
  assert.equal(rewrittenWhite.models.length, 1);
  assert.equal(rewrittenWhite.models[0].model, 'presentation/wide.glb');
  assert.equal(rewrittenWhite.models[0].lighting, 1.5);

  // Bad lighting never poisons the issue: the entry ships without lighting (default 1).
  const badManifest = enc({ version: 2, views: [], models: [{ productId: 'jacket', model: 'presentation/wide.glb', lighting: 99 }] });
  const badOut = selectLegacyAssets([
    { path: PRESENTATION_MANIFEST_PATH, bytes: badManifest, kind: 'additional' as const },
    { path: 'presentation/wide.glb', bytes: modelBytes, kind: 'additional' as const },
  ], [{ productId: 'jacket', variantId: 'white' }]);
  const rewrittenBad = JSON.parse(new TextDecoder().decode(badOut.find((e) => e.path === PRESENTATION_MANIFEST_PATH)!.bytes));
  assert.equal(rewrittenBad.models[0].lighting, undefined);
});

test('shared scene carries saved lighting per scope without touching bytes', () => {
  const project = minimalProject();
  const modelBytes = new Uint8Array([1, 2, 3, 4]);
  const byPath = new Map<string, Uint8Array>([
    [PRESENTATION_MANIFEST_PATH, enc({
      version: 2,
      views: [],
      models: [
        { productId: 'jacket', model: 'presentation/wide.glb', lighting: 1.75 },
        { productId: 'jacket', variantId: 'black', model: 'presentation/black.glb', lighting: 0.5 },
      ],
    })],
    ['presentation/wide.glb', modelBytes],
    ['presentation/black.glb', modelBytes],
  ]);
  const black = resolveModelPlacementScene(project, byPath, 'jacket', 'black');
  assert.ok(black);
  assert.equal(black!.lighting, 0.5);
  assert.ok(black!.bytes === modelBytes);
  const white = resolveModelPlacementScene(project, byPath, 'jacket', 'white');
  assert.ok(white);
  assert.equal(white!.lighting, 1.75);
  // No leakage: a scope with no saved value resolves without lighting (default 1).
  const plain = resolveModelPlacementScene(project, new Map<string, Uint8Array>([
    [PRESENTATION_MANIFEST_PATH, enc({ version: 2, views: [], models: [{ productId: 'jacket', model: 'presentation/wide.glb' }] })],
    ['presentation/wide.glb', modelBytes],
  ]), 'jacket', 'white');
  assert.ok(plain);
  assert.equal(plain!.lighting, undefined);
});
