import test from 'node:test';
import assert from 'node:assert/strict';
import { modelPointFromMm, regionMmFromModel, validModelFrame, modelAreaRegionId, type ModelRegionFrame } from '../src/core/model-placement/index.js';
const frame: ModelRegionFrame = { origin: { x: 2, y: -3, z: 5 }, xDir: { x: 0, y: 0, z: 1 }, yDir: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, mmPerUnit: 250 };
test('calibrated model conversion respects declared rotated axes, scale and origin', () => {
  assert(validModelFrame(frame));
  const point = modelPointFromMm(frame, 75, -20);
  assert.deepEqual(point, { x: 1.92, y: -3, z: 5.3 });
  const mm = regionMmFromModel(frame, { x: 1.92, y: 1.25, z: 5.3 });
  assert(mm);
  assert(Math.abs(mm.xMm - 75) < 1e-9);
  assert(Math.abs(mm.yMm + 20) < 1e-9);
  // A surface hit's depth is projected; it must not scale an in-plane size.
  assert.deepEqual(mm, regionMmFromModel(frame, point!));
});
test('invalid or missing physical scale/axes cannot produce model placements', () => {
  for (const mmPerUnit of [0, -1, NaN, Infinity]) {
    assert.equal(modelPointFromMm({ ...frame, mmPerUnit }, 10, 20), null);
    assert.equal(regionMmFromModel({ ...frame, mmPerUnit }, { x: 1, y: 2, z: 3 }), null);
  }
  assert.equal(validModelFrame({ ...frame, yDir: frame.xDir }), false);
  assert.equal(validModelFrame({ ...frame, xDir: { x: 0, y: 0, z: 2 } }), false);
  assert.equal(validModelFrame({ ...frame, normal: { x: 0, y: -1, z: 0 } }), false);
  assert.equal(modelPointFromMm(frame, Infinity, 0), null);
});
test('model region identity preserves existing saved ids across scopes', () => {
  assert.equal(modelAreaRegionId('model-area-1-ab12', 'product'), 'region-model-area-1-ab12-product');
  assert.equal(modelAreaRegionId('Chest / Mark', 'variant-1'), 'region-chest-mark-variant-1');
});
