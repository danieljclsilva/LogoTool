/**
 * Bounded pure scoped-draft retirement policy (Tranche C1).
 *
 * Pure TypeScript: no DOM, browser, Three.js, network, or `src/ui/**`
 * imports. The UI keeps staged-edit buckets keyed by `viewIdentityKey` and
 * asks this module which keys to drop; switching side/product/variant alone
 * retires nothing (absent-from-view is not a retirement signal here).
 *
 * Matching rules (exact):
 * - Unparseable/malformed keys never match and are always kept.
 * - `source-replaced` retires keys whose `sourceRev` differs from the event.
 * - `photo-replaced` retires keys with equal `productId` whose `photoId`
 *   starts with `imagePath + "#"`, with `variantId` undefined-or-equal.
 * - `scope-removed` retires keys with equal `productId` and
 *   `variantId`/`regionId` undefined-or-equal.
 * - `binding-invalidated` retires keys with equal `productId`,
 *   `variantId`/`regionId` undefined-or-equal, `imagePath`
 *   undefined-or-prefix (`photoId` starts with `imagePath + "#"`), and
 *   `view` undefined-or-equal to the key side.
 * Output is deterministically sorted. Unknown event kinds never match.
 */

import type {
  DraftIdentityParts,
  DraftRetirement,
  DraftRetirementEvent,
} from "./types.js";

export type {
  DraftIdentityParts,
  DraftRetirement,
  DraftRetirementEvent,
} from "./types.js";

/**
 * Parse a `viewIdentityKey` string into its parts, or null when the key is
 * not a JSON array of exactly 10 strings. Never throws. `imagePath` is the
 * `photoId` prefix before the first `#` (the content-hash separator); a
 * `photoId` without `#` yields its full value as `imagePath`.
 */
export function parseDraftIdentityKey(key: string): DraftIdentityParts | null {
  if (typeof key !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(key) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length !== 10) return null;
  const parts: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    parts.push(entry);
  }
  const photoId = parts[0]!;
  const sourceRev = parts[1]!;
  const productId = parts[2]!;
  const variantId = parts[3]!;
  const regionId = parts[4]!;
  const frameId = parts[5]!;
  const calibrationId = parts[6]!;
  const calibrationVersion = parts[7]!;
  const side = parts[8]!;
  const transformKey = parts[9]!;
  const hashAt = photoId.indexOf("#");
  const imagePath = hashAt >= 0 ? photoId.slice(0, hashAt) : photoId;
  return {
    photoId,
    imagePath,
    sourceRev,
    productId,
    variantId,
    regionId,
    frameId,
    calibrationId,
    calibrationVersion,
    side,
    transformKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Decide whether one retirement event retires one draft key. Pure;
 * unparseable keys and malformed/unknown events never match.
 */
export function matchRetirementEvent(key: string, event: DraftRetirementEvent): boolean {
  const parsed = parseDraftIdentityKey(key);
  if (parsed === null) return false;
  if (!isRecord(event) || typeof event.kind !== "string") return false;
  switch (event.kind) {
    case "source-replaced": {
      if (typeof event.sourceRev !== "string") return false;
      return parsed.sourceRev !== event.sourceRev;
    }
    case "photo-replaced": {
      if (typeof event.productId !== "string" || typeof event.imagePath !== "string") return false;
      if (parsed.productId !== event.productId) return false;
      if (event.variantId !== undefined && parsed.variantId !== event.variantId) return false;
      return parsed.photoId.startsWith(`${event.imagePath}#`);
    }
    case "scope-removed": {
      if (typeof event.productId !== "string") return false;
      if (parsed.productId !== event.productId) return false;
      if (event.variantId !== undefined && parsed.variantId !== event.variantId) return false;
      if (event.regionId !== undefined && parsed.regionId !== event.regionId) return false;
      return true;
    }
    case "binding-invalidated": {
      if (typeof event.productId !== "string") return false;
      if (parsed.productId !== event.productId) return false;
      if (event.variantId !== undefined && parsed.variantId !== event.variantId) return false;
      if (event.regionId !== undefined && parsed.regionId !== event.regionId) return false;
      if (event.imagePath !== undefined && !parsed.photoId.startsWith(`${event.imagePath}#`)) {
        return false;
      }
      if (event.view !== undefined && parsed.side !== event.view) return false;
      return true;
    }
    default:
      return false;
  }
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Apply retirement events as a union: a key is retired when ANY event
 * matches it, otherwise kept. Both outputs are sorted deterministically.
 * Pure; never throws on malformed keys or events (they are kept / skipped).
 */
export function applyRetirementEvents(
  keys: readonly string[],
  events: readonly DraftRetirementEvent[],
): DraftRetirement {
  const retired: string[] = [];
  const kept: string[] = [];
  for (const key of keys) {
    let drop = false;
    for (const event of events) {
      if (matchRetirementEvent(key, event)) {
        drop = true;
        break;
      }
    }
    if (drop) retired.push(key);
    else kept.push(key);
  }
  retired.sort(compareStrings);
  kept.sort(compareStrings);
  return { retired, kept };
}
