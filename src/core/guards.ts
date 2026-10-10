/**
 * Canonical runtime object guards for `src/core`.
 *
 * Single home for plain-object narrowing; call sites must import from here
 * and never redeclare equivalent guards.
 */

/** Narrow unknown to a string-keyed record (fields stay `unknown`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow unknown to a JSON-style plain object (prototype check). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
