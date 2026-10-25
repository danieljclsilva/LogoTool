import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePhotoMappings,
  serializePhotoMappings,
  validatePhotoMapping,
  forwardPhotoMapping,
  inversePhotoMapping,
  selectPhotoMapping,
  artworkPhotoMatrix,
  validateMappingContext,
  PHOTO_MAPPINGS_PATH,
  type PhotoMappingContext,
  type PhotoMappingEntry,
} from '../src/ui/customer-editor/presentation-photo-mapping.js';
import {
  selectPresentationPackageAssets,
  PRESENTATION_MANIFEST_PATH,
} from '../src/ui/customer-editor/presentation-assets.js';
import { canonicalize } from '../src/core/canonical.js';

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

const PIXEL = png(20, 10);
const enc = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const lookupOf = (entries: Record<string, Uint8Array>) => (path: string): Uint8Array | undefined => entries[path];

/** Region 200x100 mm, Y-up; UV v = 0 at top: u = x/200, v = 1 - y/100. */
function flipEntry(overrides: Partial<PhotoMappingEntry> = {}): PhotoMappingEntry {
  return {
    productId: 'p',
    regionId: 'r1',
    view: 'front',
    image: 'presentation/front.png',
    transform: { a: 1 / 200, b: 0, c: 0, d: 0, e: -1 / 100, f: 1 },
    calibrationId: 'cal-1',
    calibrationVersion: '3',
    status: 'provisional',
    ...overrides,
  };
}

function fileOf(entries: unknown[]): Uint8Array {
  return enc({ version: 1, mappings: entries });
}

test('valid file parses; legacy absence is null without warnings', () => {
  const parsed = parsePhotoMappings(fileOf([flipEntry()]));
  assert.equal(parsed?.version, 1);
  assert.equal(parsed?.mappings.length, 1);
  assert.equal(parsePhotoMappings(undefined), null);
  assert.equal(parsePhotoMappings(new Uint8Array(0)), null);
  assert.deepEqual(selectPhotoMapping(null, false, 'p', 'v', 'r1', 'front', 'presentation/front.png', lookupOf({})), {
    mapping: null,
    warning: null,
  });
});

test('malformed files are dropped to null, never thrown', () => {
  const good = flipEntry();
  const badFiles: Uint8Array[] = [
    new TextEncoder().encode('not json'),
    new Uint8Array(64 * 1024 + 1),
    enc({ mappings: [good] }),
    enc({ version: 1 }),
    enc({ version: 1, mappings: 'nope' }),
    enc({ version: 1, mappings: [] }),
    enc({ version: 1, mappings: [{ ...good, view: 'up' }] }),
    enc({ version: 1, mappings: [{ ...good, image: 'https://example.com/a.png' }] }),
    enc({ version: 1, mappings: [{ ...good, image: 'presentation/a.svg' }] }),
    enc({ version: 1, mappings: [{ ...good, transform: { ...good.transform, a: NaN } }] }),
    enc({ version: 1, mappings: [{ ...good, transform: { a: 1, b: 2, c: 0, d: 2, e: 4, f: 0 } }] }),
    enc({ version: 1, mappings: [{ ...good, calibrationId: '' }] }),
    enc({ version: 1, mappings: [{ ...good, status: 'approved' }] }),
    enc({ version: 1, mappings: [{ ...good, productId: '' }] }),
    enc({ version: 1, mappings: [{ ...good, regionId: '' }] }),
    enc({ version: 1, mappings: [{ ...good, note: 7 }] }),
    enc({ version: 1, mappings: Array.from({ length: 33 }, () => good) }),
  ];
  for (const bytes of badFiles) {
    assert.equal(parsePhotoMappings(bytes), null);
  }
  // Envelope version 2 with valid entries is well-formed (backward reader).
  const v2good = parsePhotoMappings(enc({ version: 2, mappings: [good] }));
  assert.equal(v2good?.version, 1);
  assert.deepEqual(v2good?.mappings, [good]);
  assert.match(selectPhotoMapping(null, true, 'p', 'v', 'r1', 'front', 'presentation/front.png', lookupOf({})).warning ?? '', /invalid/);
});

test('unsafe image paths are rejected', () => {
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
    '',
  ]) {
    assert.equal(parsePhotoMappings(fileOf([{ ...flipEntry(), image: bad }])), null, bad);
    assert.ok(validatePhotoMapping({ ...flipEntry(), image: bad }).length > 0, bad);
  }
  // Uppercase raster extensions are accepted (same as manifest reader).
  assert.equal(parsePhotoMappings(fileOf([{ ...flipEntry(), image: 'presentation/A.PNG' }]))?.mappings.length, 1);
});

test('validatePhotoMapping reports every defect class', () => {
  assert.deepEqual(validatePhotoMapping(flipEntry()), []);
  assert.ok(validatePhotoMapping(null).length > 0);
  assert.ok(validatePhotoMapping({ ...flipEntry(), transform: { a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 } }).some((e) => e.includes('degenerate')));
  assert.ok(validatePhotoMapping({ ...flipEntry(), transform: { ...flipEntry().transform, f: Infinity } }).some((e) => e.includes('finite')));
  // Near-singular (|det| <= 1e-12) is degenerate.
  assert.ok(validatePhotoMapping({ ...flipEntry(), transform: { a: 1e-7, b: 0, c: 0, d: 0, e: 1e-7, f: 0 } }).length > 0);
  assert.ok(validatePhotoMapping({ ...flipEntry(), variantId: '' }).length > 0);
  assert.ok(validatePhotoMapping({ ...flipEntry(), calibrationVersion: '' }).length > 0);
  assert.deepEqual(validatePhotoMapping({ ...flipEntry(), variantId: 'v', note: 'trial' }), []);
});

test('forward maps exact affine values; inverse is the algebraic inverse', () => {
  const entry = flipEntry();
  assert.deepEqual(forwardPhotoMapping(entry, { xMm: 0, yMm: 0 }), { u: 0, v: 1 });
  assert.deepEqual(forwardPhotoMapping(entry, { xMm: 200, yMm: 100 }), { u: 1, v: 0 });
  const mid = forwardPhotoMapping(entry, { xMm: 50, yMm: 25 })!;
  assert.ok(Math.abs(mid.u - 0.25) < 1e-15);
  assert.ok(Math.abs(mid.v - 0.75) < 1e-15);
  // Exact round-trip within 1e-9 across the region, including edges.
  for (const point of [{ xMm: 0, yMm: 0 }, { xMm: 200, yMm: 100 }, { xMm: 37.5, yMm: 68.25 }, { xMm: -12, yMm: 140 }]) {
    const uv = forwardPhotoMapping(entry, point)!;
    const back = inversePhotoMapping(entry, uv)!;
    assert.ok(Math.abs(back.xMm - point.xMm) < 1e-9, JSON.stringify(point));
    assert.ok(Math.abs(back.yMm - point.yMm) < 1e-9, JSON.stringify(point));
  }
});

test('Y convention is explicit: region Y-up maps to v = 0 at top', () => {
  const entry = flipEntry();
  const topEdge = forwardPhotoMapping(entry, { xMm: 100, yMm: 100 })!;
  const bottomEdge = forwardPhotoMapping(entry, { xMm: 100, yMm: 0 })!;
  assert.ok(Math.abs(topEdge.v - 0) < 1e-15, 'max yMm (top) -> v = 0');
  assert.ok(Math.abs(bottomEdge.v - 1) < 1e-15, 'min yMm (bottom) -> v = 1');
  // v decreases as yMm increases: the flip is in the coefficients, applied raw.
  const higher = forwardPhotoMapping(entry, { xMm: 100, yMm: 80 })!;
  const lower = forwardPhotoMapping(entry, { xMm: 100, yMm: 20 })!;
  assert.ok(higher.v < lower.v);
  assert.ok(entry.transform.e < 0, 'calibration bakes the flip (e < 0), no hidden negation');
});

test('rotation round-trips and preserves distances', () => {
  // 30-degree rotation + scale + offset.
  const t = Math.PI / 6;
  const entry = flipEntry({
    transform: { a: 0.01 * Math.cos(t), b: -0.01 * Math.sin(t), c: 0.5, d: 0.01 * Math.sin(t), e: 0.01 * Math.cos(t), f: 0.25 },
  });
  assert.deepEqual(validatePhotoMapping(entry), []);
  const p = { xMm: 10, yMm: 40 };
  const q = { xMm: -25, yMm: 7 };
  const pu = forwardPhotoMapping(entry, p)!;
  const qu = forwardPhotoMapping(entry, q)!;
  const mmDist = Math.hypot(p.xMm - q.xMm, p.yMm - q.yMm);
  const uvDist = Math.hypot(pu.u - qu.u, pu.v - qu.v);
  assert.ok(Math.abs(uvDist - 0.01 * mmDist) < 1e-12, 'uniform scale preserved under rotation');
  for (const point of [p, q, { xMm: 0, yMm: 0 }]) {
    const back = inversePhotoMapping(entry, forwardPhotoMapping(entry, point)!)!;
    assert.ok(Math.abs(back.xMm - point.xMm) < 1e-9);
    assert.ok(Math.abs(back.yMm - point.yMm) < 1e-9);
  }
});

test('normalized UV is independent of pixel size (resize invariance)', () => {
  const entry = flipEntry();
  const uv = forwardPhotoMapping(entry, { xMm: 50, yMm: 25 })!;
  const pxSmall = { x: uv.u * 200, y: uv.v * 100 };
  const pxLarge = { x: uv.u * 800, y: uv.v * 400 };
  assert.ok(Math.abs(pxLarge.x / pxSmall.x - 4) < 1e-12);
  assert.ok(Math.abs(pxLarge.y / pxSmall.y - 4) < 1e-12);
});

test('degenerate and non-finite inputs refuse with null', () => {
  const singular = flipEntry({ transform: { a: 1, b: 2, c: 0, d: 2, e: 4, f: 0 } });
  assert.equal(forwardPhotoMapping(singular, { xMm: 1, yMm: 1 }), null);
  assert.equal(inversePhotoMapping(singular, { u: 0.5, v: 0.5 }), null);
  const good = flipEntry();
  assert.equal(forwardPhotoMapping(good, { xMm: NaN, yMm: 0 }), null);
  assert.equal(inversePhotoMapping(good, { u: Infinity, v: 0 }), null);
});

function parsedFlip(overrides: Partial<PhotoMappingEntry> = {}) {
  return parsePhotoMappings(fileOf([flipEntry(overrides)]))!;
}

test('side isolation: a front mapping is never applied to back', () => {
  const mappings = parsedFlip();
  const lookup = lookupOf({ 'presentation/front.png': PIXEL });
  const hit = selectPhotoMapping(mappings, true, 'p', 'v', 'r1', 'front', 'presentation/front.png', lookup);
  assert.ok(hit.mapping !== null && hit.warning === null);
  for (const side of ['back', 'left', 'right'] as const) {
    const miss = selectPhotoMapping(mappings, true, 'p', 'v', 'r1', side, 'presentation/front.png', lookup);
    assert.equal(miss.mapping, null, side);
    assert.match(miss.warning ?? '', /reference only/);
  }
  // Region and image are part of the key too: no cross-region/image inference.
  assert.equal(selectPhotoMapping(mappings, true, 'p', 'v', 'other-region', 'front', 'presentation/front.png', lookup).mapping, null);
  assert.equal(selectPhotoMapping(mappings, true, 'p', 'v', 'r1', 'front', 'presentation/other.png', lookup).mapping, null);
});

test('stale, missing and corrupt references are refused with warnings', () => {
  const mappings = parsedFlip();
  const args = { manifestPresent: true, productId: 'p', variantId: 'v', regionId: 'r1' as const, view: 'front' as const, image: 'presentation/front.png' };
  assert.match(selectPhotoMapping(mappings, true, 'other', 'v', 'r1', 'front', args.image, lookupOf({ [args.image]: PIXEL })).warning ?? '', /reference only/);
  assert.match(selectPhotoMapping(mappings, true, 'p', 'v', 'r1', 'front', args.image, lookupOf({})).warning ?? '', /missing or too large/);
  assert.match(selectPhotoMapping(mappings, true, 'p', 'v', 'r1', 'front', args.image, lookupOf({ [args.image]: new Uint8Array(10) })).warning ?? '', /missing or too large/);
  const corrupt = PIXEL.slice();
  corrupt[0] = 0;
  assert.match(selectPhotoMapping(mappings, true, 'p', 'v', 'r1', 'front', args.image, lookupOf({ [args.image]: corrupt })).warning ?? '', /missing or too large/);
  void args;
});

test('variant scoping prefers exact option; mismatched options warn', () => {
  const generic = flipEntry();
  const specific = flipEntry({ variantId: 'v2', calibrationId: 'cal-2' });
  const mappings = parsePhotoMappings(fileOf([generic, specific]))!;
  const lookup = lookupOf({ 'presentation/front.png': PIXEL });
  assert.equal(selectPhotoMapping(mappings, true, 'p', 'v2', 'r1', 'front', 'presentation/front.png', lookup).mapping?.calibrationId, 'cal-2');
  assert.equal(selectPhotoMapping(mappings, true, 'p', 'other', 'r1', 'front', 'presentation/front.png', lookup).mapping?.calibrationId, 'cal-1');
  const variantOnly = parsePhotoMappings(fileOf([flipEntry({ variantId: 'v9' })]))!;
  const miss = selectPhotoMapping(variantOnly, true, 'p', 'other', 'r1', 'front', 'presentation/front.png', lookup);
  assert.equal(miss.mapping, null);
  assert.match(miss.warning ?? '', /product option/);
});

test('serialization is deterministic across key order and entry order', () => {
  const a = flipEntry();
  const b = flipEntry({ productId: 'q', regionId: 'r2', view: 'back', image: 'presentation/back.png', status: 'review', note: 'n' });
  const once = serializePhotoMappings({ version: 1, mappings: [a, b] });
  const reordered = serializePhotoMappings({ version: 1, mappings: [b, a] });
  assert.deepEqual(reordered, once);
  // Shuffled JSON key order in the source file still yields identical bytes.
  const shuffled = new TextEncoder().encode(JSON.stringify({ version: 1, mappings: [Object.fromEntries(Object.entries(b).reverse()), Object.fromEntries(Object.entries(a).reverse())] }));
  assert.deepEqual(serializePhotoMappings(parsePhotoMappings(shuffled)!), once);
  assert.deepEqual(serializePhotoMappings(parsePhotoMappings(once)!), once);
});

test('malformed input preserves existing mapping state by caller pattern', () => {
  const current = parsedFlip();
  const next = parsePhotoMappings(new TextEncoder().encode('{{{')) ?? current;
  assert.ok(next === current, 'caller keeps the old object when parse returns null');
});

test('canonical project bytes are unchanged by presentation-only operations', () => {
  const project = {
    schemaVersion: '0.1.0-provisional',
    projectId: 'synthetic-job',
    revision: 1,
    products: [],
    logos: [],
    configurations: [{ id: 'c1', productId: 'p', variantId: 'v', placements: [] }],
  };
  const before = canonicalize(project);
  const bytes = fileOf([flipEntry()]);
  const snapshot = bytes.slice();
  const parsed = parsePhotoMappings(bytes);
  assert.ok(parsed);
  const lookup = lookupOf({ 'presentation/front.png': PIXEL });
  selectPhotoMapping(parsed, true, 'p', 'v', 'r1', 'front', 'presentation/front.png', lookup);
  selectPhotoMapping(parsed, true, 'p', 'v', 'r1', 'back', 'presentation/front.png', lookup);
  serializePhotoMappings(parsed);
  validatePhotoMapping(parsed.mappings[0]);
  assert.equal(canonicalize(project), before);
  assert.deepEqual(bytes, snapshot);
});

test('issue selection carries filtered mappings and stays deterministic', () => {
  const manifestBytes = enc({
    version: 2,
    views: [
      { productId: 'p', view: 'front', image: 'presentation/front.png' },
      { productId: 'other', view: 'front', image: 'presentation/drop.png' },
    ],
  });
  const mappingBytes = serializePhotoMappings({
    version: 1,
    mappings: [
      flipEntry({ regionId: 'rB' }),
      flipEntry({ regionId: 'rA' }),
      flipEntry({ productId: 'other', image: 'presentation/drop.png' }),
      flipEntry({ productId: 'p', variantId: 'v9', regionId: 'rV' }),
    ],
  });
  const assets = [
    { path: PRESENTATION_MANIFEST_PATH, bytes: manifestBytes, kind: 'additional' },
    { path: PHOTO_MAPPINGS_PATH, bytes: mappingBytes, kind: 'additional' },
    { path: 'presentation/front.png', bytes: PIXEL, kind: 'additional' },
    { path: 'presentation/drop.png', bytes: PIXEL, kind: 'additional' },
  ];
  const out = selectPresentationPackageAssets(assets, [{ productId: 'p', variantId: 'v' }]);
  assert.equal(out[0]?.path, PRESENTATION_MANIFEST_PATH);
  assert.equal(out[1]?.path, PHOTO_MAPPINGS_PATH);
  const rewritten = JSON.parse(new TextDecoder().decode(out[1]!.bytes));
  assert.deepEqual(rewritten.mappings.map((entry: { regionId: string }) => entry.regionId), ['rA', 'rB']);
  assert.deepEqual(out.slice(2).map((entry) => entry.path), ['presentation/front.png']);
  // Determinism under shuffled input.
  const again = selectPresentationPackageAssets([...assets].reverse(), [{ productId: 'p', variantId: 'v' }]);
  assert.deepEqual(again.map((entry) => entry.path), out.map((entry) => entry.path));
  assert.deepEqual(again[1]?.bytes, out[1]?.bytes);
  // Malformed mappings file is dropped silently; v1/v2 outputs unchanged.
  const malformed = selectPresentationPackageAssets([
    { path: PRESENTATION_MANIFEST_PATH, bytes: manifestBytes, kind: 'additional' },
    { path: PHOTO_MAPPINGS_PATH, bytes: new TextEncoder().encode('nope'), kind: 'additional' },
    { path: 'presentation/front.png', bytes: PIXEL, kind: 'additional' },
  ], [{ productId: 'p', variantId: 'v' }]);
  assert.ok(!malformed.some((entry) => entry.path === PHOTO_MAPPINGS_PATH));
  // Legacy packages without a mappings file gain no new entries.
  const legacy = selectPresentationPackageAssets([
    { path: PRESENTATION_MANIFEST_PATH, bytes: manifestBytes, kind: 'additional' },
    { path: 'presentation/front.png', bytes: PIXEL, kind: 'additional' },
  ], [{ productId: 'p', variantId: 'v' }]);
  assert.ok(!legacy.some((entry) => entry.path === PHOTO_MAPPINGS_PATH));
});

test('validateMappingContext enforces selection, calibration and manifest binding', () => {
  const context: PhotoMappingContext = {
    productId: 'p',
    variantId: 'v',
    regionId: 'r1',
    calibrationId: 'cal-1',
    calibrationVersion: '3',
    manifestViews: [{ view: 'front', image: 'presentation/front.png' }],
  };
  assert.deepEqual(validateMappingContext(flipEntry(), context), []);
  // A mutated calibration version is stale and must fall back.
  const staleVersion = validateMappingContext(flipEntry({ calibrationVersion: '4' }), context);
  assert.ok(staleVersion.some((message) => message.includes('calibration')), `expected calibration refusal, saw: ${staleVersion}`);
  const staleId = validateMappingContext(flipEntry({ calibrationId: 'cal-9' }), context);
  assert.ok(staleId.some((message) => message.includes('calibration')));
  // A mapping photo that is not a declared preview view is stale.
  const unlisted = validateMappingContext(flipEntry({ image: 'presentation/other.png' }), context);
  assert.ok(unlisted.some((message) => message.includes('not a declared preview view')));
  // A mapping view that disagrees with the manifest declaration is stale.
  const wrongView = validateMappingContext(flipEntry({ view: 'back' }), context);
  assert.ok(wrongView.some((message) => message.includes('not a declared preview view')));
  // Region and product mismatches are stale, not silently applied.
  assert.ok(validateMappingContext(flipEntry({ regionId: 'r2' }), context).length > 0);
  assert.ok(validateMappingContext(flipEntry({ productId: 'q' }), context).length > 0);
  // Product-wide entries (no variantId) stay valid for any option.
  assert.deepEqual(validateMappingContext(flipEntry(), { ...context, variantId: 'other' }), []);
  assert.ok(validateMappingContext(flipEntry({ variantId: 'w' }), context).length > 0);
});

test('selectPhotoMapping with context refuses stale calibration and undeclared photos', () => {
  const lookup = lookupOf({ 'presentation/front.png': PIXEL, 'presentation/other.png': PIXEL });
  const context: PhotoMappingContext = {
    productId: 'p',
    variantId: 'v',
    regionId: 'r1',
    calibrationId: 'cal-1',
    calibrationVersion: '3',
    manifestViews: [{ view: 'front', image: 'presentation/front.png' }],
  };
  const good = selectPhotoMapping(
    { version: 1, mappings: [flipEntry()] }, true, 'p', 'v', 'r1', 'front', 'presentation/front.png', lookup, context,
  );
  assert.ok(good.mapping !== null && good.warning === null);
  const stale = selectPhotoMapping(
    { version: 1, mappings: [flipEntry({ calibrationVersion: '4' })] }, true, 'p', 'v', 'r1', 'front', 'presentation/front.png', lookup, context,
  );
  assert.equal(stale.mapping, null);
  assert.ok((stale.warning ?? '').includes('stale'));
  const undeclared = selectPhotoMapping(
    {
      version: 1,
      mappings: [flipEntry({ image: 'presentation/other.png' })],
    },
    true, 'p', 'v', 'r1', 'front', 'presentation/other.png', lookup, context,
  );
  assert.equal(undeclared.mapping, null);
  assert.ok((undeclared.warning ?? '').includes('stale'));
  // Legacy callers without a context keep the previous ID-and-bytes behavior.
  const legacy = selectPhotoMapping(
    { version: 1, mappings: [flipEntry({ calibrationVersion: '4' })] }, true, 'p', 'v', 'r1', 'front', 'presentation/front.png', lookup,
  );
  assert.ok(legacy.mapping !== null);
});

test('artworkPhotoMatrix maps all four domain footprint corners exactly', async () => {
  // Independent expectation path: explicit mm corners (clockwise placement
  // turn in the Y-up frame) forwarded through the existing forward map must
  // equal the matrix-mapped artwork unit corners as sets.
  const cases: Array<{ name: string; transform: { a: number; b: number; c: number; d: number; e: number; f: number }; placement: { xMm: number; yMm: number; widthMm: number; heightMm: number; rotationDeg: number } }> = [
    { name: 'axis-aligned flip', transform: { a: 1 / 200, b: 0, c: 0.5, d: 0, e: -1 / 160, f: 0.5 }, placement: { xMm: 10, yMm: -20, widthMm: 60, heightMm: 30, rotationDeg: 0 } },
    { name: 'rotated flip', transform: { a: 1 / 200, b: 0, c: 0.5, d: 0, e: -1 / 160, f: 0.5 }, placement: { xMm: 10, yMm: -20, widthMm: 60, heightMm: 30, rotationDeg: 15 } },
    { name: 'rotated anisotropic', transform: { a: 1 / 200, b: 0.0004, c: 0.1, d: 0.0002, e: -1 / 100, f: 0.9 }, placement: { xMm: -40, yMm: 25, widthMm: 80, heightMm: 40, rotationDeg: -30 } },
    { name: 'sheared rotated', transform: { a: 0.004, b: 0.0015, c: 0.2, d: -0.001, e: -0.005, f: 0.7 }, placement: { xMm: 5, yMm: 5, widthMm: 50, heightMm: 20, rotationDeg: 45 } },
    { name: 'reflected rotated', transform: { a: -1 / 200, b: 0, c: 0.5, d: 0, e: -1 / 160, f: 0.5 }, placement: { xMm: 0, yMm: 0, widthMm: 60, heightMm: 30, rotationDeg: 30 } },
    { name: 'full turn', transform: { a: 1 / 200, b: 0, c: 0.5, d: 0, e: -1 / 160, f: 0.5 }, placement: { xMm: 0, yMm: 0, widthMm: 60, heightMm: 30, rotationDeg: 180 } },
  ];
  for (const { name, transform, placement } of cases) {
    const matrix = artworkPhotoMatrix(transform, 200, 160, placement);
    assert.ok(matrix !== null, `${name}: matrix must exist`);
    const entry = {
      productId: 'p',
      regionId: 'r',
      view: 'front' as const,
      image: 'presentation/front.png',
      transform,
      calibrationId: 'c',
      calibrationVersion: 'v',
      status: 'provisional' as const,
    };
    const turn = (placement.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const unitCorners: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const mmCorners = unitCorners.map(([s, tt]) => ({
      xMm: placement.xMm + cos * placement.widthMm * (s - 0.5) - sin * placement.heightMm * (tt - 0.5),
      yMm: placement.yMm - sin * placement.widthMm * (s - 0.5) - cos * placement.heightMm * (tt - 0.5),
    }));
    const expected = mmCorners.map(({ xMm, yMm }) => {
      const uv = forwardPhotoMapping(entry, { xMm, yMm });
      assert.ok(uv !== null, `${name}: forward map must exist`);
      return { x: uv.u * 200, y: uv.v * 160 };
    });
    const actual = unitCorners.map(([s, tt]) => ({
      x: matrix.a * s + matrix.c * tt + matrix.e,
      y: matrix.b * s + matrix.d * tt + matrix.f,
    }));
    const key = (point: { x: number; y: number }): string => `${point.x.toFixed(9)},${point.y.toFixed(9)}`;
    assert.deepEqual(actual.map(key).sort(), expected.map(key).sort(), `${name}: matrix corners must equal forward-mapped footprint`);
  }
});

test('artworkPhotoMatrix refuses degenerate inputs with null', async () => {
  const good = { a: 1 / 200, b: 0, c: 0.5, d: 0, e: -1 / 160, f: 0.5 };
  const placement = { xMm: 0, yMm: 0, widthMm: 60, heightMm: 30, rotationDeg: 0 };
  assert.equal(artworkPhotoMatrix({ ...good, a: 0, e: 0 }, 200, 160, placement), null);
  assert.equal(artworkPhotoMatrix(good, 200, 160, { ...placement, widthMm: 0 }), null);
  assert.equal(artworkPhotoMatrix(good, 200, 160, { ...placement, xMm: Number.NaN }), null);
  assert.equal(artworkPhotoMatrix(good, 0, 160, placement), null);
});
