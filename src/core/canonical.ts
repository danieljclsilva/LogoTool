/**
 * Canonical JSON serialization for LogoTool provisional documents.
 *
 * Rules (shared provisional contract):
 * - Recursively sort object keys (lexicographic by UTF-16 code unit).
 * - Arrays keep order, EXCEPT arrays whose every element is a plain object
 *   with a string `id`: those sort by `id` (lexicographic).
 * - UTF-8 text with separators (",", ":") — i.e. `JSON.stringify` without
 *   whitespace.
 * - Every JSON object key is preserved, including `__proto__` (safe
 *   own-property definition on a null-prototype object; never assignment
 *   that would mutate a prototype).
 * - Only finite JSON numbers are accepted. Non-finite numbers (NaN,
 *   Infinity, -Infinity), `undefined`, functions and symbols are rejected
 *   with an error — never silently converted to `null` — because canonical
 *   bytes feed authoritative digests.
 * - Pure: no crypto imports, no DOM / React / Three.js, no Node APIs.
 */

import { isPlainObject } from "./guards.js";

function hasStringId(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    typeof (value as Record<string, unknown>)["id"] === "string"
  );
}

/**
 * Normalize a value so plain `JSON.stringify` output is canonical.
 * Throws on non-JSON values (non-finite numbers, undefined, functions,
 * symbols, bigint) so digest inputs can never silently lose data.
 */
export function toCanonicalForm(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "canonicalize rejects non-finite numbers (NaN/Infinity/-Infinity): digests must be computed over exact JSON data",
      );
    }
    return value;
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new Error(
      "canonicalize rejects non-JSON values (undefined/function/symbol/bigint): digests must be computed over exact JSON data",
    );
  }
  if (Array.isArray(value)) {
    const items: unknown[] = Array.from(value, toCanonicalForm);
    if (items.length > 0 && items.every(hasStringId)) {
      (items as Record<string, unknown>[]).sort((x, y) => {
        const a = x["id"] as string;
        const b = y["id"] as string;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }
    return items;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(value).sort()) {
      const field: unknown = (value as Record<string, unknown>)[key];
      if (field === undefined) {
        throw new Error(
          `canonicalize rejects undefined field "${key}": digests must be computed over exact JSON data`,
        );
      }
      Object.defineProperty(out, key, {
        value: toCanonicalForm(field),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  throw new Error("canonicalize rejects non-JSON objects");
}

/**
 * Serialize `value` to canonical JSON text: recursively sorted object keys,
 * id-bearing object arrays sorted by `id`, separators (",", ":").
 * Throws on non-JSON input (see `toCanonicalForm`).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(toCanonicalForm(value)) ?? "null";
}
