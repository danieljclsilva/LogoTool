import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forwardPhotoMapping,
  inversePhotoMapping,
  similarityTransformFromSpan,
  validatePhotoMapping,
  type PhotoMappingEntry,
} from '../src/ui/customer-editor/presentation-photo-mapping.js';

function entryFor(transform: NonNullable<ReturnType<typeof similarityTransformFromSpan>>): PhotoMappingEntry {
  return {
    productId: 'P',
    regionId: 'R',
    view: 'front',
    image: 'presentation/p/front.png',
    transform,
    calibrationId: 'cal-span-front',
    calibrationVersion: '1',
    status: 'provisional',
  };
}

test('span similarity: horizontal 1300 mm span maps A to origin and B to (1300, 0)', () => {
  const transform = similarityTransformFromSpan({
    widthPx: 1000,
    heightPx: 500,
    aUv: { u: 0.1, v: 0.5 },
    bUv: { u: 0.9, v: 0.5 },
    lengthMm: 1300,
  });
  assert.ok(transform !== null);
  const entry = entryFor(transform);
  assert.deepEqual(validatePhotoMapping(entry), []);
  const origin = forwardPhotoMapping(entry, { xMm: 0, yMm: 0 });
  assert.ok(origin !== null);
  assert.ok(Math.abs(origin.u - 0.1) < 1e-9 && Math.abs(origin.v - 0.5) < 1e-9);
  const end = forwardPhotoMapping(entry, { xMm: 1300, yMm: 0 });
  assert.ok(end !== null);
  assert.ok(Math.abs(end.u - 0.9) < 1e-9 && Math.abs(end.v - 0.5) < 1e-9);
});

test('span similarity: inverse recovers A/B exactly and smaller distances scale', () => {
  const transform = similarityTransformFromSpan({
    widthPx: 800,
    heightPx: 600,
    aUv: { u: 0.2, v: 0.3 },
    bUv: { u: 0.6, v: 0.7 },
    lengthMm: 500,
  });
  assert.ok(transform !== null);
  const entry = entryFor(transform);
  const backA = inversePhotoMapping(entry, { u: 0.2, v: 0.3 });
  assert.ok(backA !== null);
  assert.ok(Math.abs(backA.xMm) < 1e-6 && Math.abs(backA.yMm) < 1e-6);
  const backB = inversePhotoMapping(entry, { u: 0.6, v: 0.7 });
  assert.ok(backB !== null);
  assert.ok(Math.abs(backB.xMm - 500) < 1e-6 && Math.abs(backB.yMm) < 1e-6);
  // Midpoint of the span measures exactly half the declared length.
  const mid = inversePhotoMapping(entry, { u: 0.4, v: 0.5 });
  assert.ok(mid !== null);
  assert.ok(Math.abs(Math.hypot(mid.xMm, mid.yMm) - 250) < 1e-6);
});

test('span similarity: diagonal span keeps uniform scale in both axes', () => {
  const transform = similarityTransformFromSpan({
    widthPx: 1000,
    heightPx: 1000,
    aUv: { u: 0, v: 0 },
    bUv: { u: 1, v: 1 },
    lengthMm: Math.SQRT2 * 100,
  });
  assert.ok(transform !== null);
  const entry = entryFor(transform);
  // Similarity preserves every distance: at 0.1 mm/px, a 100 px photo
  // offset measures exactly 10 mm in any direction (the mm frame itself is
  // rotated 45 degrees, so photo-x is not an mm axis).
  const px = inversePhotoMapping(entry, { u: 0.1, v: 0 });
  const py = inversePhotoMapping(entry, { u: 0, v: 0.1 });
  assert.ok(px !== null && py !== null);
  assert.ok(Math.abs(Math.hypot(px.xMm, px.yMm) - 10) < 1e-6);
  assert.ok(Math.abs(Math.hypot(py.xMm, py.yMm) - 10) < 1e-6);
});

test('span similarity: scale is independent of zoom (display size never enters)', () => {
  const forSize = (widthPx: number, heightPx: number): number => {
    const transform = similarityTransformFromSpan({
      widthPx,
      heightPx,
      aUv: { u: 0.25, v: 0.25 },
      bUv: { u: 0.75, v: 0.75 },
      lengthMm: 400,
    });
    assert.ok(transform !== null);
    const entry = entryFor(transform);
    const mm = inversePhotoMapping(entry, { u: 0.5, v: 0.5 });
    assert.ok(mm !== null);
    return Math.hypot(mm.xMm - 0, mm.yMm - 0);
  };
  // Same normalized span on a 4x larger raster: identical millimetres.
  assert.ok(Math.abs(forSize(500, 500) - forSize(2000, 2000)) < 1e-6);
});

test('span similarity: vertical photo span works with the v-down convention', () => {
  const transform = similarityTransformFromSpan({
    widthPx: 400,
    heightPx: 800,
    aUv: { u: 0.5, v: 0.1 },
    bUv: { u: 0.5, v: 0.9 },
    lengthMm: 640,
  });
  assert.ok(transform !== null);
  const entry = entryFor(transform);
  assert.deepEqual(validatePhotoMapping(entry), []);
  const backB = inversePhotoMapping(entry, { u: 0.5, v: 0.9 });
  assert.ok(backB !== null);
  assert.ok(Math.abs(backB.xMm - 640) < 1e-6 && Math.abs(backB.yMm) < 1e-6);
});

test('span similarity: coincident A/B is refused', () => {
  assert.equal(
    similarityTransformFromSpan({
      widthPx: 1000,
      heightPx: 1000,
      aUv: { u: 0.5, v: 0.5 },
      bUv: { u: 0.5, v: 0.5 },
      lengthMm: 100,
    }),
    null,
  );
});

test('span similarity: zero, negative and non-finite lengths are refused', () => {
  const base = { widthPx: 1000, heightPx: 1000, aUv: { u: 0.1, v: 0.1 }, bUv: { u: 0.9, v: 0.9 } };
  assert.equal(similarityTransformFromSpan({ ...base, lengthMm: 0 }), null);
  assert.equal(similarityTransformFromSpan({ ...base, lengthMm: -5 }), null);
  assert.equal(similarityTransformFromSpan({ ...base, lengthMm: NaN }), null);
  assert.equal(similarityTransformFromSpan({ ...base, lengthMm: Infinity }), null);
});

test('span similarity: out-of-range UV and bad photo sizes are refused', () => {
  const good = { widthPx: 1000, heightPx: 1000, lengthMm: 100 };
  assert.equal(similarityTransformFromSpan({ ...good, aUv: { u: -0.1, v: 0.5 }, bUv: { u: 0.5, v: 0.5 } }), null);
  assert.equal(similarityTransformFromSpan({ ...good, aUv: { u: 0.5, v: 0.5 }, bUv: { u: NaN, v: 0.5 } }), null);
  assert.equal(
    similarityTransformFromSpan({ widthPx: 0, heightPx: 1000, aUv: { u: 0.1, v: 0.1 }, bUv: { u: 0.9, v: 0.9 }, lengthMm: 100 }),
    null,
  );
});

test('span similarity: roundtrip through forward then inverse is exact', () => {
  const transform = similarityTransformFromSpan({
    widthPx: 640,
    heightPx: 480,
    aUv: { u: 0.15, v: 0.8 },
    bUv: { u: 0.7, v: 0.2 },
    lengthMm: 1300,
  });
  assert.ok(transform !== null);
  const entry = entryFor(transform);
  for (const point of [{ xMm: 0, yMm: 0 }, { xMm: 1300, yMm: 0 }, { xMm: 123.5, yMm: -45.25 }]) {
    const uv = forwardPhotoMapping(entry, point);
    assert.ok(uv !== null);
    const back = inversePhotoMapping(entry, uv);
    assert.ok(back !== null);
    assert.ok(Math.abs(back.xMm - point.xMm) < 1e-6 && Math.abs(back.yMm - point.yMm) < 1e-6);
  }
});
