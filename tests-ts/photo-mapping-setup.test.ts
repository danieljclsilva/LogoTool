import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveAffineFromCorrespondences,
  type PhotoMappingTransform,
} from '../src/ui/customer-editor/presentation-photo-mapping.js';

function apply(t: PhotoMappingTransform, xMm: number, yMm: number): { u: number; v: number } {
  return {
    u: t.a * xMm + t.b * yMm + t.c,
    v: t.d * xMm + t.e * yMm + t.f,
  };
}

function closeTo(actual: PhotoMappingTransform, expected: PhotoMappingTransform, tol: number): void {
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) <= tol,
      `${key}: got ${actual[key]}, want ${expected[key]} (tol ${tol})`,
    );
  }
}

/** Region-mm (Y-up) -> UV (v = 0 at top): u = x/200, v = 1 - y/100. */
const FLIP: PhotoMappingTransform = { a: 1 / 200, b: 0, c: 0, d: 0, e: -1 / 100, f: 1 };

test('exact recovery of a known transform from 3 pairs', () => {
  const mm = [
    { xMm: 0, yMm: 0 },
    { xMm: 200, yMm: 0 },
    { xMm: 40, yMm: 90 },
  ];
  const pairs = mm.map((point) => ({ mm: point, uv: apply(FLIP, point.xMm, point.yMm) }));
  const solved = solveAffineFromCorrespondences(pairs);
  assert.ok(solved !== null);
  closeTo(solved, FLIP, 1e-9);
});

test('overdetermined noise-free recovery from 6 pairs', () => {
  const truth: PhotoMappingTransform = { a: 0.004, b: 0.001, c: 0.05, d: -0.002, e: -0.008, f: 0.9 };
  const mm = [
    { xMm: 0, yMm: 0 },
    { xMm: 200, yMm: 0 },
    { xMm: 200, yMm: 100 },
    { xMm: 0, yMm: 100 },
    { xMm: 37.5, yMm: 68.25 },
    { xMm: 150, yMm: 12.5 },
  ];
  const pairs = mm.map((point) => ({ mm: point, uv: apply(truth, point.xMm, point.yMm) }));
  const solved = solveAffineFromCorrespondences(pairs);
  assert.ok(solved !== null);
  closeTo(solved, truth, 1e-9);
});

test('collinear mm points are refused', () => {
  const onAxis = [
    { xMm: 0, yMm: 0 },
    { xMm: 100, yMm: 0 },
    { xMm: 200, yMm: 0 },
  ];
  assert.equal(
    solveAffineFromCorrespondences(onAxis.map((point) => ({ mm: point, uv: apply(FLIP, point.xMm, point.yMm) }))),
    null,
  );
  const diagonal = [
    { xMm: 0, yMm: 0 },
    { xMm: 50, yMm: 50 },
    { xMm: 100, yMm: 100 },
    { xMm: 25, yMm: 25 },
  ];
  assert.equal(
    solveAffineFromCorrespondences(diagonal.map((point) => ({ mm: point, uv: apply(FLIP, point.xMm, point.yMm) }))),
    null,
  );
});

test('fewer than 3 pairs are refused', () => {
  const two = [
    { mm: { xMm: 0, yMm: 0 }, uv: { u: 0, v: 1 } },
    { mm: { xMm: 200, yMm: 100 }, uv: { u: 1, v: 0 } },
  ];
  assert.equal(solveAffineFromCorrespondences(two), null);
  assert.equal(solveAffineFromCorrespondences([two[0]!]), null);
  assert.equal(solveAffineFromCorrespondences([]), null);
});

test('non-finite coordinates are refused', () => {
  const good = [
    { mm: { xMm: 0, yMm: 0 }, uv: { u: 0, v: 1 } },
    { mm: { xMm: 200, yMm: 0 }, uv: { u: 1, v: 1 } },
    { mm: { xMm: 40, yMm: 90 }, uv: { u: 0.2, v: 0.1 } },
  ];
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(
      solveAffineFromCorrespondences([
        { mm: { xMm: bad, yMm: 0 }, uv: { u: 0, v: 1 } },
        good[1]!,
        good[2]!,
      ]),
      null,
      `xMm=${String(bad)}`,
    );
    assert.equal(
      solveAffineFromCorrespondences([
        good[0]!,
        { mm: { xMm: 200, yMm: 0 }, uv: { u: bad, v: 1 } },
        good[2]!,
      ]),
      null,
      `u=${String(bad)}`,
    );
  }
});

test('degenerate point sets are refused', () => {
  // All points coincident: no extent at all.
  const coincident = [
    { mm: { xMm: 10, yMm: 20 }, uv: { u: 0.1, v: 0.2 } },
    { mm: { xMm: 10, yMm: 20 }, uv: { u: 0.1, v: 0.2 } },
    { mm: { xMm: 10, yMm: 20 }, uv: { u: 0.1, v: 0.2 } },
  ];
  assert.equal(solveAffineFromCorrespondences(coincident), null);
  // Only two distinct locations (third duplicates the first): still singular.
  const duplicated = [
    { mm: { xMm: 0, yMm: 0 }, uv: { u: 0, v: 1 } },
    { mm: { xMm: 200, yMm: 100 }, uv: { u: 1, v: 0 } },
    { mm: { xMm: 0, yMm: 0 }, uv: { u: 0, v: 1 } },
  ];
  assert.equal(solveAffineFromCorrespondences(duplicated), null);
});
