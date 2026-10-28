import { newRevision } from '../revisions.js';
/**
 * Centralized decoration-method catalogue for Logo Station (lead-owned).
 *
 * Pure domain module: no DOM, Three.js, browser or provider APIs.
 * Physical method identity only — no invented temperature/time/pressure
 * or physical limits live here. Placement-level `other` carries an
 * operator-supplied custom name; region `allowedMethods` keep explicit
 * permissions (existing values preserved on import, never silently
 * broadened).
 */

export const EMBROIDERY_METHOD = "embroidery" as const;
export const HEAT_SEAL_METHOD = "heat-seal" as const;
export const PRINT_METHOD = "print" as const;
export const OTHER_METHOD = "other" as const;

export type DecorationMethodKey =
  | typeof EMBROIDERY_METHOD
  | typeof HEAT_SEAL_METHOD
  | typeof PRINT_METHOD
  | typeof OTHER_METHOD;

export interface DecorationMethodDef {
  key: DecorationMethodKey;
  label: string;
}

/** Canonical catalogue: Embroidery + Heat Seal minimum, Print retained, Other named. */
export const SUPPORTED_METHODS: readonly DecorationMethodDef[] = [
  { key: EMBROIDERY_METHOD, label: "Embroidery" },
  { key: HEAT_SEAL_METHOD, label: "Heat Seal" },
  { key: PRINT_METHOD, label: "Print" },
  { key: OTHER_METHOD, label: "Other" },
] as const;

const LABEL_BY_KEY: Record<DecorationMethodKey, string> = {
  [EMBROIDERY_METHOD]: "Embroidery",
  [HEAT_SEAL_METHOD]: "Heat Seal",
  [PRINT_METHOD]: "Print",
  [OTHER_METHOD]: "Other",
};

/** Default explicit permissions for newly created regions. */
export const DEFAULT_NEW_REGION_METHODS: readonly string[] = [
  EMBROIDERY_METHOD,
  HEAT_SEAL_METHOD,
  PRINT_METHOD,
] as const;

/** All placement-level keys the station accepts (region lists stay explicit). */
export function supportedMethodKeys(): string[] {
  return SUPPORTED_METHODS.map((entry) => entry.key);
}

export function isKnownMethodKey(value: unknown): value is DecorationMethodKey {
  return (
    value === EMBROIDERY_METHOD ||
    value === HEAT_SEAL_METHOD ||
    value === PRINT_METHOD ||
    value === OTHER_METHOD
  );
}

export function methodLabel(key: string): string {
  return Object.hasOwn(LABEL_BY_KEY, key) ? (LABEL_BY_KEY as Record<string, string>)[key]! : key;
}

/**
 * Placement method display: `other` requires an operator-supplied custom
 * name (never invented). Returns "Other" when unnamed rather than guessing
 * a glue process.
 */
export function displayPlacementMethod(method: string, customName?: string): string {
  if (method === OTHER_METHOD) {
    const trimmed = (customName ?? "").trim();
    return trimmed.length > 0 ? `Other — ${trimmed}` : "Other";
  }
  return methodLabel(method);
}

/**
 * Normalize a region permission list read from file: trim, drop empties,
 * dedupe, preserve order. Unknown keys pass through (never dropped) so
 * older/newer files round-trip; callers decide validity against the region.
 */
export function normalizeRegionMethods(methods: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of methods) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Explicit operator setup action: offer and select a named method in one revision. */
export function configurePlacementMethod(
  project: import('../types.js').ProjectDocument,
  configurationId: string,
  placementIndex: number,
  suppliedName: string,
  geometry?: Pick<import('../types.js').Placement, 'pos' | 'widthMm' | 'heightMm' | 'rotationDeg'>,
): import('../types.js').ProjectDocument {
  const name = suppliedName.trim();
  if (name.length === 0 || name.length > 80 || /[\u0000-\u001f]/.test(name) || name.toLowerCase() === 'other') {
    throw new Error('Enter the actual method name (1–80 characters).');
  }
  const config = project.configurations.find((entry) => entry.id === configurationId);
  const placement = config?.placements[placementIndex];
  const product = project.products.find((entry) => entry.id === config?.productId);
  const region = product?.regions.find((entry) => entry.id === placement?.regionId);
  if (!config || !placement || !product || !region) throw new Error('Choose an existing logo placement and safe area first.');
  return newRevision(project, (draft) => {
    const nextProduct = draft.products.find((entry) => entry.id === product.id)!;
    const nextRegion = nextProduct.regions.find((entry) => entry.id === region.id)!;
    if (!nextRegion.allowedMethods.includes(name)) nextRegion.allowedMethods.push(name);
    const edited = draft.configurations.find((entry) => entry.id === configurationId)!.placements[placementIndex]!;
    edited.method = name;
    if (geometry) { edited.pos = { ...geometry.pos }; edited.widthMm = geometry.widthMm; edited.heightMm = geometry.heightMm; edited.rotationDeg = geometry.rotationDeg; }
  });
}
