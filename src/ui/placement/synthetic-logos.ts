/**
 * synthetic-logos.ts — independent synthetic logo catalogue for provisional
 * logo-placement drafts (Phase 6 slice 1).
 *
 * Logos are independent of regions and placements: the same logo id may be
 * reused across any number of placements in any regions. Entries carry only
 * an id, a display name, and nominal pixel dimensions (informational; the
 * placement footprint on the model is driven by millimetre width/height in
 * the placement panel, never by these pixel sizes).
 *
 * Artwork identity: each entry also carries a stable `art` token naming one
 * of the procedural preview variants rendered by the viewer overlay
 * (`mark-a` / `mark-b`). The token is a preview seed only — it never enters
 * the placement bundle, and save/restore retains artwork identity because
 * logo ids are retained. Custom (non-catalogue) logo ids map
 * deterministically by id hash to one of the same variants via
 * `artVariantForLogoId`, so any custom synthetic identity gets a
 * reproducible preview without new bundle fields.
 *
 * Pure module: no browser/Node/Three imports.
 */

/** Procedural preview variants known to the viewer overlay renderer. */
export type SyntheticArtKind = "mark-a" | "mark-b";

/** Number of procedural preview variants (`mark-a`, `mark-b`, …). */
export const SYNTHETIC_ART_VARIANTS = 2 as const;

export interface SyntheticLogoDef {
  id: string;
  name: string;
  widthPx: number;
  heightPx: number;
  /** Stable artwork token selecting the procedural preview variant. */
  art: SyntheticArtKind;
}

export const SYNTHETIC_LOGOS: readonly SyntheticLogoDef[] = [
  { id: "SYN-LOGO-A", name: "Synthetic Mark A", widthPx: 400, heightPx: 200, art: "mark-a" },
  { id: "SYN-LOGO-B", name: "Synthetic Mark B", widthPx: 300, heightPx: 300, art: "mark-b" },
] as const;

export function syntheticLogoById(id: string): SyntheticLogoDef | null {
  for (const logo of SYNTHETIC_LOGOS) {
    if (logo.id === id) return logo;
  }
  return null;
}

/**
 * Artwork token for any logo id: the catalogue `art` when known, otherwise
 * a deterministic id-hash pick over the procedural variants (FNV-1a mod
 * {@link SYNTHETIC_ART_VARIANTS}). Pure and stable across save/restore
 * because it depends only on the retained logo id.
 */
export function artVariantForLogoId(id: string): SyntheticArtKind {
  const known = syntheticLogoById(id);
  if (known !== null) return known.art;
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const variant = ((hash % SYNTHETIC_ART_VARIANTS) + SYNTHETIC_ART_VARIANTS) % SYNTHETIC_ART_VARIANTS;
  return variant === 1 ? "mark-b" : "mark-a";
}

/** Default logo for a fresh placement editor (the first synthetic logo). */
export function defaultSyntheticLogoId(): string {
  const first = SYNTHETIC_LOGOS[0];
  return first === undefined ? "SYN-LOGO-A" : first.id;
}
