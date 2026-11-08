/** Display-only formatting and advisory limits. Never used to compute geometry. */
export const CALIBRATION_REFERENCE_RANGE_MM = { min: 5, max: 5000 } as const;

export function formatMeasurement(value: number): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value)
    : '—';
}

export function unusualCalibrationReference(value: number): boolean {
  return Number.isFinite(value) && value > 0 &&
    (value < CALIBRATION_REFERENCE_RANGE_MM.min || value > CALIBRATION_REFERENCE_RANGE_MM.max);
}
