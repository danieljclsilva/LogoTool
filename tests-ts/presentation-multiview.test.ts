import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePresentationManifest,
  selectPresentationViews,
  selectPresentationModel,
  selectPresentationReference,
  selectPresentationPackageAssets,
  describePresentationInputs,
  PRESENTATION_MANIFEST_PATH,
  PRESENTATION_MAX_IMAGE_BYTES,
  PRESENTATION_MAX_MODEL_BYTES,
} from '../src/ui/customer-editor/presentation-assets.js';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
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

function glbWithJson(payload: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
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

const PIXEL = png(20, 10);
const MODEL = glb();
const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const lookupOf = (entries: Record<string, Uint8Array>) => (path: string): Uint8Array | undefined => entries[path];

test('v1 manifests parse byte-identically and select as view:null', () => {
  const raw = { version: 1, references: [{ productId: 'p', variantId: 'v', image: 'presentation/a.png', label: 'L' }] };
  const parsed = parsePresentationManifest(enc(raw));
  const lookup = lookupOf({ 'presentation/a.png': PIXEL });
  assert.deepEqual(selectPresentationViews(parsed, true, 'p', 'v', lookup), {
    views: [{ view: null, imagePath: 'presentation/a.png', label: 'L' }],
    warning: null,
  });
  assert.deepEqual(selectPresentationModel(parsed, true, 'p', 'v', lookup), {
    modelPath: null,
    label: null,
    warning: null,
  });
  const legacy = selectPresentationReference(parsed, true, 'p', 'v', lookup);
  assert.deepEqual(legacy, { imagePath: 'presentation/a.png', label: 'L', warning: null });
});

test('v2 selects each side independently and never invents missing sides', () => {
  const raw = {
    version: 2,
    views: [
      { productId: 'p', view: 'front', image: 'presentation/front.png' },
      { productId: 'p', view: 'back', image: 'presentation/back.png', label: 'B' },
      { productId: 'p', view: 'left', image: 'presentation/left.png' },
      { productId: 'p', view: 'right', image: 'presentation/right.png' },
    ],
  };
  const parsed = parsePresentationManifest(enc(raw));
  assert.equal(parsed?.version, 2);
  const full = lookupOf({
    'presentation/front.png': PIXEL,
    'presentation/back.png': PIXEL,
    'presentation/left.png': PIXEL,
    'presentation/right.png': PIXEL,
  });
  const selected = selectPresentationViews(parsed, true, 'p', 'v', full);
  assert.deepEqual(selected.views.map((entry) => entry.view), ['front', 'back', 'left', 'right']);
  assert.equal(selected.warning, null);
  const partial = selectPresentationViews(parsed, true, 'p', 'v', lookupOf({ 'presentation/front.png': PIXEL }));
  assert.deepEqual(partial.views.map((entry) => entry.view), ['front']);
  assert.match(partial.warning ?? '', /missing or too large/);
  const singleSide = parsePresentationManifest(enc({ version: 2, views: [{ productId: 'p', view: 'left', image: 'presentation/left.png' }] }));
  assert.deepEqual(selectPresentationViews(singleSide, true, 'p', 'v', lookupOf({ 'presentation/left.png': PIXEL })).views, [
    { view: 'left', imagePath: 'presentation/left.png', label: null },
  ]);
});

test('variant-scoped entries win over product-wide ones; mismatches warn without images', () => {
  const raw = {
    version: 2,
    views: [
      { productId: 'p', view: 'front', image: 'presentation/generic.png' },
      { productId: 'p', variantId: 'v2', view: 'front', image: 'presentation/specific.png' },
    ],
    models: [
      { productId: 'p', model: 'presentation/generic.glb' },
      { productId: 'p', variantId: 'v2', model: 'presentation/specific.glb' },
    ],
  };
  const parsed = parsePresentationManifest(enc(raw));
  const lookup = lookupOf({
    'presentation/generic.png': PIXEL,
    'presentation/specific.png': PIXEL,
    'presentation/generic.glb': MODEL,
    'presentation/specific.glb': MODEL,
  });
  assert.equal(selectPresentationViews(parsed, true, 'p', 'v2', lookup).views[0]?.imagePath, 'presentation/specific.png');
  assert.equal(selectPresentationViews(parsed, true, 'p', 'other', lookup).views[0]?.imagePath, 'presentation/generic.png');
  assert.equal(selectPresentationModel(parsed, true, 'p', 'v2', lookup).modelPath, 'presentation/specific.glb');
  assert.equal(selectPresentationModel(parsed, true, 'p', 'other', lookup).modelPath, 'presentation/generic.glb');
  const otherProduct = selectPresentationViews(parsed, true, 'nope', 'v2', lookup);
  assert.deepEqual(otherProduct.views, []);
  assert.equal(otherProduct.warning, null);
  const variantOnly = parsePresentationManifest(enc({ version: 2, views: [{ productId: 'p', variantId: 'v9', view: 'front', image: 'presentation/generic.png' }] }));
  const variantMiss = selectPresentationViews(variantOnly, true, 'p', 'other', lookup);
  assert.deepEqual(variantMiss.views, []);
  assert.equal(variantMiss.warning, null);
  assert.equal(selectPresentationViews(null, true, 'p', 'v', lookup).warning, 'Reference preview data was invalid and has been ignored.');
  assert.deepEqual(selectPresentationViews(parsed, false, 'p', 'v', lookup), { views: [], warning: null });
  assert.deepEqual(selectPresentationModel(parsed, false, 'p', 'v', lookup), { modelPath: null, label: null, warning: null });
});

test('invalid paths, extensions, sizes and counts are rejected', () => {
  const viewFor = (image: string): unknown => ({ version: 2, views: [{ productId: 'p', view: 'front', image }] });
  for (const bad of [
    'https://example.com/a.png',
    'http://example.com/a.png',
    'data:image/png;base64,AAA',
    'blob:abc',
    '//cdn/a.png',
    'other/a.png',
    'presentation/../a.png',
    'presentation/./a.png',
    'presentation//a.png',
    'presentation/a.png/',
    'presentation\\a.png',
    'presentation/a:b.png',
    'presentation/a.svg',
    'presentation/a.glb',
    'presentation/a',
  ]) {
    assert.equal(parsePresentationManifest(enc(viewFor(bad))), null, bad);
  }
  assert.equal(parsePresentationManifest(enc({ version: 2, views: [{ productId: 'p', view: 'up', image: 'presentation/a.png' }] })), null);
  assert.equal(parsePresentationManifest(enc({ version: 2, views: [{ productId: 'p', view: 'front', image: 'presentation/a.png' }], models: [{ productId: 'p', model: 'presentation/a.png' }] })), null);
  assert.equal(parsePresentationManifest(enc({ version: 2, views: [] })), null);
  assert.equal(parsePresentationManifest(enc({ version: 2, views: [], models: [] })), null);
  assert.equal(parsePresentationManifest(enc({ version: 3, references: [] })), null);
  assert.equal(parsePresentationManifest(enc({ references: [] })), null);
  assert.equal(parsePresentationManifest(enc({ version: 1, references: 'nope' })), null);
  assert.equal(parsePresentationManifest(enc({ version: 2, views: 'nope' })), null);
  assert.equal(parsePresentationManifest(new Uint8Array(64 * 1024 + 1)), null);
  assert.equal(parsePresentationManifest(new TextEncoder().encode('not json')), null);
  assert.equal(parsePresentationManifest(undefined), null);
  assert.equal(parsePresentationManifest(new Uint8Array(0)), null);
  const many = Array.from({ length: 33 }, (_, i) => ({ productId: 'p', view: 'front', image: `presentation/a${i}.png` }));
  assert.equal(parsePresentationManifest(enc({ version: 2, views: many })), null);
  const mixed33 = {
    version: 2,
    views: Array.from({ length: 16 }, (_, i) => ({ productId: 'p', view: 'front', image: `presentation/v${i}.png` })),
    models: Array.from({ length: 17 }, (_, i) => ({ productId: 'p', model: `presentation/m${i}.glb` })),
  };
  assert.equal(parsePresentationManifest(enc(mixed33)), null);
  const mixed32 = {
    version: 2,
    views: Array.from({ length: 16 }, (_, i) => ({ productId: 'p', view: 'front', image: `presentation/v${i}.png` })),
    models: Array.from({ length: 16 }, (_, i) => ({ productId: 'p', model: `presentation/m${i}.glb` })),
  };
  assert.equal(parsePresentationManifest(enc(mixed32))?.version, 2);
  const oversize = lookupOf({ 'presentation/a.png': new Uint8Array(PRESENTATION_MAX_IMAGE_BYTES + 1) });
  const parsed = parsePresentationManifest(enc(viewFor('presentation/a.png')));
  const dropped = selectPresentationViews(parsed, true, 'p', 'v', oversize);
  assert.deepEqual(dropped.views, []);
  assert.match(dropped.warning ?? '', /missing or too large/);
  const missing = selectPresentationViews(parsed, true, 'p', 'v', lookupOf({}));
  assert.deepEqual(missing.views, []);
  assert.match(missing.warning ?? '', /missing or too large/);
  const corrupt = selectPresentationViews(parsed, true, 'p', 'v', lookupOf({ 'presentation/a.png': new TextEncoder().encode('<svg/>xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') }));
  assert.deepEqual(corrupt.views, []);
});

test('model selection validates presence, bound, extension and header', () => {
  const raw = { version: 2, views: [], models: [{ productId: 'p', model: 'presentation/a.glb', label: 'M' }] };
  const parsed = parsePresentationManifest(enc(raw));
  assert.equal(parsed?.version, 2);
  assert.deepEqual(selectPresentationModel(parsed, true, 'p', 'v', lookupOf({ 'presentation/a.glb': MODEL })), {
    modelPath: 'presentation/a.glb',
    label: 'M',
    warning: null,
  });
  assert.match(selectPresentationModel(parsed, true, 'p', 'v', lookupOf({})).warning ?? '', /missing or too large/);
  assert.match(selectPresentationModel(parsed, true, 'p', 'v', lookupOf({ 'presentation/a.glb': new Uint8Array(PRESENTATION_MAX_MODEL_BYTES + 1) })).warning ?? '', /missing or too large/);
  assert.match(selectPresentationModel(parsed, true, 'p', 'v', lookupOf({ 'presentation/a.glb': new TextEncoder().encode('not a model at all................') })).warning ?? '', /not a valid model/);
  assert.equal(selectPresentationModel(parsed, true, 'other', 'v', lookupOf({ 'presentation/a.glb': MODEL })).warning, null);
  assert.match(selectPresentationModel(null, true, 'p', 'v', lookupOf({})).warning ?? '', /invalid/);
  assert.equal(PRESENTATION_MAX_MODEL_BYTES, 16 * 1024 * 1024);
});

test('model-only and views+model manifests select both channels', () => {
  const lookup = lookupOf({ 'presentation/a.glb': MODEL, 'presentation/f.png': PIXEL });
  const modelOnly = parsePresentationManifest(enc({ version: 2, views: [], models: [{ productId: 'p', model: 'presentation/a.glb' }] }));
  assert.deepEqual(selectPresentationViews(modelOnly, true, 'p', 'v', lookup).views, []);
  assert.equal(selectPresentationModel(modelOnly, true, 'p', 'v', lookup).modelPath, 'presentation/a.glb');
  // v1 legacy path keeps working through the reference helper for a v2 model-only manifest
  assert.equal(selectPresentationReference(modelOnly, true, 'p', 'v', lookup).imagePath, null);
  const both = parsePresentationManifest(enc({
    version: 2,
    views: [{ productId: 'p', view: 'front', image: 'presentation/f.png' }],
    models: [{ productId: 'p', model: 'presentation/a.glb' }],
  }));
  assert.equal(selectPresentationViews(both, true, 'p', 'v', lookup).views.length, 1);
  assert.equal(selectPresentationModel(both, true, 'p', 'v', lookup).modelPath, 'presentation/a.glb');
  assert.equal(selectPresentationReference(both, true, 'p', 'v', lookup).imagePath, 'presentation/f.png');
});

test('package assets prune, sort deterministically and preserve exact bytes', () => {
  const manifestBytes = enc({
    version: 2,
    views: [
      { productId: 'p', view: 'right', image: 'presentation/z.png' },
      { productId: 'p', view: 'front', image: 'presentation/a.png' },
      { productId: 'other', view: 'front', image: 'presentation/drop.png' },
      { productId: 'p', view: 'back', image: 'presentation/corrupt.png' },
    ],
    models: [
      { productId: 'p', model: 'presentation/z.glb' },
      { productId: 'other', model: 'presentation/drop.glb' },
      { productId: 'p', variantId: 'v9', model: 'presentation/scoped.glb' },
    ],
    extraIgnored: true,
  });
  const corrupt = PIXEL.slice();
  corrupt[0] = 0;
  const assets = [
    { path: PRESENTATION_MANIFEST_PATH, bytes: manifestBytes, kind: 'additional' },
    { path: 'presentation/z.png', bytes: PIXEL, kind: 'additional' },
    { path: 'presentation/a.png', bytes: PIXEL, kind: 'additional' },
    { path: 'presentation/drop.png', bytes: PIXEL, kind: 'additional' },
    { path: 'presentation/corrupt.png', bytes: corrupt, kind: 'additional' },
    { path: 'presentation/z.glb', bytes: MODEL, kind: 'additional' },
    { path: 'presentation/drop.glb', bytes: MODEL, kind: 'additional' },
    { path: 'presentation/scoped.glb', bytes: MODEL, kind: 'additional' },
  ];
  const out = selectPresentationPackageAssets(assets, [{ productId: 'p', variantId: 'v' }]);
  assert.equal(out[0]?.path, PRESENTATION_MANIFEST_PATH);
  const rewritten = JSON.parse(new TextDecoder().decode(out[0]!.bytes));
  assert.deepEqual(rewritten, {
    version: 2,
    views: [
      { productId: 'p', view: 'front', image: 'presentation/a.png' },
      { productId: 'p', view: 'right', image: 'presentation/z.png' },
    ],
    models: [{ productId: 'p', model: 'presentation/z.glb' }],
  });
  assert.deepEqual(out.slice(1).map((entry) => entry.path), ['presentation/a.png', 'presentation/z.glb', 'presentation/z.png']);
  for (const entry of out.slice(1)) {
    const source = assets.find((asset) => asset.path === entry.path)!.bytes;
    assert.ok(entry.bytes === source, `exact bytes passthrough for ${entry.path}`);
  }
  // Determinism: shuffled input yields identical output ordering and bytes.
  const shuffled = [...assets].reverse();
  const again = selectPresentationPackageAssets(shuffled, [{ productId: 'p', variantId: 'v' }]);
  assert.deepEqual(again.map((entry) => entry.path), out.map((entry) => entry.path));
  assert.deepEqual(again[0]?.bytes, out[0]?.bytes);
  // Nothing selected => nothing retained.
  assert.deepEqual(selectPresentationPackageAssets(assets, [{ productId: 'nobody', variantId: 'v' }]), []);
  // v1 behavior unchanged: retained entries in manifest order, sorted asset paths.
  const v1manifest = enc({ version: 1, references: [{ productId: 'p', image: 'presentation/a.png' }, { productId: 'other', image: 'presentation/drop.png' }] });
  const v1out = selectPresentationPackageAssets([
    { path: PRESENTATION_MANIFEST_PATH, bytes: v1manifest, kind: 'additional' },
    { path: 'presentation/a.png', bytes: PIXEL, kind: 'additional' },
    { path: 'presentation/drop.png', bytes: PIXEL, kind: 'additional' },
  ], [{ productId: 'p', variantId: 'v' }]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(v1out[0]!.bytes)), { version: 1, references: [{ productId: 'p', image: 'presentation/a.png' }] });
});

test('physical project bytes are untouched by presentation parsing', () => {
  const project = { configurations: [{ productId: 'p', variantId: 'v' }], placements: [] };
  const before = JSON.stringify(project);
  const manifestBytes = enc({ version: 2, views: [{ productId: 'p', view: 'front', image: 'presentation/a.png' }], models: [{ productId: 'p', model: 'presentation/a.glb' }] });
  const snapshot = manifestBytes.slice();
  const parsed = parsePresentationManifest(manifestBytes);
  selectPresentationViews(parsed, true, 'p', 'v', lookupOf({ 'presentation/a.png': PIXEL }));
  selectPresentationModel(parsed, true, 'p', 'v', lookupOf({ 'presentation/a.glb': MODEL }));
  describePresentationInputs({ manifestBytes, manifestPresent: true, productId: 'p', variantId: 'v', assets: new Map([['presentation/a.png', PIXEL]]) });
  assert.equal(JSON.stringify(project), before);
  assert.deepEqual(manifestBytes, snapshot);
});

test('v2 accepts optional verbatim v1 references and retains them through issue', () => {
  const raw = {
    version: 2,
    views: [{ productId: 'new', view: 'front', image: 'presentation/new.png' }],
    references: [{ productId: 'legacy', image: 'presentation/legacy.png', label: 'Legacy' }],
  };
  const parsed = parsePresentationManifest(enc(raw));
  assert.equal(parsed?.version, 2);
  assert.deepEqual(parsed, raw);
  const legacyViews = selectPresentationViews(parsed, true, 'legacy', 'v', lookupOf({ 'presentation/legacy.png': PIXEL }));
  assert.deepEqual(legacyViews.views, []);
  assert.equal(legacyViews.warning, null);
  const assets = [
    { path: PRESENTATION_MANIFEST_PATH, bytes: enc(raw), kind: 'additional' },
    { path: 'presentation/new.png', bytes: PIXEL, kind: 'additional' },
    { path: 'presentation/legacy.png', bytes: PIXEL, kind: 'additional' },
  ];
  const out = selectPresentationPackageAssets(assets, [
    { productId: 'legacy', variantId: 'v' },
    { productId: 'new', variantId: 'v' },
  ]);
  const rewritten = JSON.parse(new TextDecoder().decode(out[0]!.bytes));
  assert.deepEqual(rewritten, {
    version: 2,
    views: [{ productId: 'new', view: 'front', image: 'presentation/new.png' }],
    references: [{ productId: 'legacy', image: 'presentation/legacy.png', label: 'Legacy' }],
  });
  assert.deepEqual(out.slice(1).map((entry) => entry.path), ['presentation/legacy.png', 'presentation/new.png']);
  const newOnly = selectPresentationPackageAssets(assets, [{ productId: 'new', variantId: 'v' }]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(newOnly[0]!.bytes)), {
    version: 2,
    views: [{ productId: 'new', view: 'front', image: 'presentation/new.png' }],
  });
  const full = {
    version: 2,
    views: Array.from({ length: 16 }, (_, i) => ({ productId: 'p', view: 'front', image: `presentation/v${i}.png` })),
    models: Array.from({ length: 15 }, (_, i) => ({ productId: 'p', model: `presentation/m${i}.glb` })),
    references: [{ productId: 'p', image: 'presentation/r.png' }],
  };
  assert.equal(parsePresentationManifest(enc(full))?.version, 2);
  const over = {
    version: 2,
    views: Array.from({ length: 16 }, (_, i) => ({ productId: 'p', view: 'front', image: `presentation/v${i}.png` })),
    models: Array.from({ length: 16 }, (_, i) => ({ productId: 'p', model: `presentation/m${i}.glb` })),
    references: [{ productId: 'p', image: 'presentation/r.png' }],
  };
  assert.equal(parsePresentationManifest(enc(over)), null);
  assert.equal(parsePresentationManifest(enc({ version: 2, views: [{ productId: 'p', view: 'front', image: 'presentation/a.png' }], references: 'nope' })), null);
});

test('external-uri GLB models are rejected at the read boundary; advisories pass', () => {
  const external = glbWithJson({ asset: { version: '2.0' }, buffers: [{ byteLength: 8, uri: 'model.bin' }] });
  const manifest = parsePresentationManifest(enc({ version: 2, views: [], models: [{ productId: 'p', model: 'presentation/ext.glb' }] }));
  const selected = selectPresentationModel(manifest, true, 'p', 'v', lookupOf({ 'presentation/ext.glb': external }));
  assert.equal(selected.modelPath, null);
  assert.match(selected.warning ?? '', /self-contained/);
  assert.match(selected.warning ?? '', /external/);
  const retained = selectPresentationPackageAssets([
    { path: PRESENTATION_MANIFEST_PATH, bytes: enc({ version: 2, views: [], models: [{ productId: 'p', model: 'presentation/ext.glb' }] }), kind: 'additional' },
    { path: 'presentation/ext.glb', bytes: external, kind: 'additional' },
  ], [{ productId: 'p', variantId: 'v' }]);
  assert.deepEqual(retained, []);
  const advisory = glbWithJson({ asset: { version: '2.0' }, extensionsUsed: ['KHR_mesh_quantization'] });
  const advisoryManifest = parsePresentationManifest(enc({ version: 2, views: [], models: [{ productId: 'p', model: 'presentation/q.glb' }] }));
  assert.equal(selectPresentationModel(advisoryManifest, true, 'p', 'v', lookupOf({ 'presentation/q.glb': advisory })).modelPath, 'presentation/q.glb');
});

test('side-only creation shapes keep each image on its assigned side', () => {
  for (const side of ['front', 'back', 'left', 'right'] as const) {
    const parsed = parsePresentationManifest(enc({ version: 2, views: [{ productId: 'p', variantId: 'v', view: side, image: `presentation/${side}.png` }] }));
    const selected = selectPresentationViews(parsed, true, 'p', 'v', lookupOf({ [`presentation/${side}.png`]: PIXEL }));
    assert.deepEqual(selected.views.map((entry) => entry.view), [side]);
    assert.equal(selected.warning, null);
  }
});
