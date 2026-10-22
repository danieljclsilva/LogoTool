import test from 'node:test';
import assert from 'node:assert/strict';
import {
  guidedCorrespondences,
  guidedMmCorners,
} from '../src/ui/internal-builder/guided-scale.js';
import { solveAffineFromCorrespondences } from '../src/ui/customer-editor/presentation-photo-mapping.js';

// Lead-owned pure-math tests for the guided first-measured-region panel.
// Asymmetric W != H throughout so axis flips cannot hide.
const W = 280;
const H = 200;

test('guidedMmCorners photo-up puts C1 at top-left (0, H)', () => {
  assert.deepEqual(guidedMmCorners(W, H, 'photo-up'), [
    { x: 0, y: H },
    { x: W, y: H },
    { x: W, y: 0 },
    { x: 0, y: 0 },
  ]);
});

test('guidedMmCorners photo-down is a true 180-degree rotation (both axes flip)', () => {
  // Photo top-left is the area BOTTOM-right; a Y-only flip would wrongly
  // give C1 = (0, 0) and mirror the area instead of rotating it.
  assert.deepEqual(guidedMmCorners(W, H, 'photo-down'), [
    { x: W, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: H },
    { x: W, y: H },
  ]);
});

test('guidedCorrespondences pairs photo corners C1..C4 with mm in click order', () => {
  const corners = [
    { u: 0.2, v: 0.3 },
    { u: 0.7, v: 0.25 },
    { u: 0.75, v: 0.6 },
    { u: 0.25, v: 0.65 },
  ];
  const built = guidedCorrespondences(corners, W, H, 'photo-up');
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.pairs.length, 4);
  assert.deepEqual(built.pairs[0]!.mm, { xMm: 0, yMm: H });
  assert.deepEqual(built.pairs[0]!.uv, corners[0]);
  assert.deepEqual(built.pairs[2]!.mm, { xMm: W, yMm: 0 });
});

test('guidedCorrespondences refuses short evidence honestly', () => {
  const corners = [
    { u: 0.2, v: 0.3 },
    { u: 0.7, v: 0.25 },
    { u: 0.75, v: 0.6 },
    { u: 0.25, v: 0.65 },
  ];
  const few = guidedCorrespondences(corners.slice(0, 3), W, H, 'photo-up');
  assert.equal(few.ok, false);
  const noWidth = guidedCorrespondences(corners, 0, H, 'photo-up');
  assert.equal(noWidth.ok, false);
  const noHeight = guidedCorrespondences(corners, W, NaN, 'photo-up');
  assert.equal(noHeight.ok, false);
  const outside = guidedCorrespondences(
    [corners[0]!, corners[1]!, corners[2]!, { u: 1.5, v: 0.5 }],
    W, H, 'photo-up',
  );
  assert.equal(outside.ok, false);
});

test('photo-up parallelogram corners solve to an exact affine fit', () => {
  const corners = [
    { u: 0.2, v: 0.3 },
    { u: 0.7, v: 0.25 },
    { u: 0.75, v: 0.6 },
    { u: 0.25, v: 0.65 },
  ];
  const built = guidedCorrespondences(corners, W, H, 'photo-up');
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const transform = solveAffineFromCorrespondences(built.pairs);
  assert.ok(transform !== null);
  if (!transform) return;
  for (const pair of built.pairs) {
    const uPred = transform.a * pair.mm.xMm + transform.b * pair.mm.yMm + transform.c;
    const vPred = transform.d * pair.mm.xMm + transform.e * pair.mm.yMm + transform.f;
    assert.ok(Math.abs(uPred - pair.uv.u) < 1e-9, `u residual ${Math.abs(uPred - pair.uv.u)}`);
    assert.ok(Math.abs(vPred - pair.uv.v) < 1e-9, `v residual ${Math.abs(vPred - pair.uv.v)}`);
  }
});

test('photo-down parallelogram corners solve with C1 at (W, 0)', () => {
  const corners = [
    { u: 0.2, v: 0.3 },
    { u: 0.7, v: 0.25 },
    { u: 0.75, v: 0.6 },
    { u: 0.25, v: 0.65 },
  ];
  const built = guidedCorrespondences(corners, W, H, 'photo-down');
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.pairs[0]!.mm, { xMm: W, yMm: 0 });
  const transform = solveAffineFromCorrespondences(built.pairs);
  assert.ok(transform !== null);
  if (!transform) return;
  for (const pair of built.pairs) {
    const uPred = transform.a * pair.mm.xMm + transform.b * pair.mm.yMm + transform.c;
    const vPred = transform.d * pair.mm.xMm + transform.e * pair.mm.yMm + transform.f;
    assert.ok(Math.abs(uPred - pair.uv.u) < 1e-9, `u residual ${Math.abs(uPred - pair.uv.u)}`);
    assert.ok(Math.abs(vPred - pair.uv.v) < 1e-9, `v residual ${Math.abs(vPred - pair.uv.v)}`);
  }
});

test('collinear corners are refused by the solver (no invented mapping)', () => {
  const line = [
    { u: 0.1, v: 0.1 },
    { u: 0.5, v: 0.5 },
    { u: 0.9, v: 0.9 },
    { u: 0.3, v: 0.3 },
  ];
  const built = guidedCorrespondences(line, W, H, 'photo-up');
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(solveAffineFromCorrespondences(built.pairs), null);
});
