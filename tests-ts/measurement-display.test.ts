import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMeasurement, unusualCalibrationReference } from '../src/ui/internal-builder/measurement-display.js';

test('measurement display groups thousands and rounds display only', () => {
  assert.equal(formatMeasurement(22000), '22,000');
  assert.equal(formatMeasurement(6244.34), '6,244.3');
  assert.equal(formatMeasurement(-1234.56), '-1,234.6');
  assert.equal(formatMeasurement(Infinity), '—');
});

test('calibration plausibility is advisory outside the inclusive 5–5000 mm range', () => {
  for (const value of [0.1, 4.9, 5000.1, 22000]) assert.equal(unusualCalibrationReference(value), true);
  for (const value of [5, 300, 5000, 0, -1, NaN, Infinity]) assert.equal(unusualCalibrationReference(value), false);
});
