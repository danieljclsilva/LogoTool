/**
 * placement-panel.ts — provisional offline draft editor for logo placements
 * (Phase 6 slice 1).
 *
 * A placement references an independent logo id + a calibrated planar region
 * id and carries centre x/y, width/height (mm), and a clockwise rotation
 * (degrees in (-180, 180]). Draft/logo/placement types and the footprint
 * kernel come from the canonical core `logo-placements` module; footprints
 * are ALWAYS recomputed from numbers (a supplied footprint is never
 * authority). Fit verdicts come from the core `footprintFits` geometry
 * kernel against the region's saved safe polygon + exclusions.
 *
 * Browser/Three-free except DOM: never imports Node APIs. Reaches the 3D
 * viewer only through the optional `viewer` port
 * (`setPlacementOverlays`); numeric editing stays in this panel. Export and
 * restore envelopes are owned by the host calibration panel; this panel
 * exposes `collectDraft` / `replaceDraft` for that path.
 */

import {
  addLogo,
  addPlacement,
  buildPlacementBundle,
  placementFootprint,
  prunePlacements,
  removeLogo,
  removePlacement,
  serializePlacementBundle,
  updatePlacement,
  validateDraftPlacement,
  type DraftLogo as CoreDraftLogo,
  type DraftPlacement as CoreDraftPlacement,
  type LogosMap,
  type PlacementsMap,
} from "../../core/logo-placements/index.js";
import { createPlanarMapping, type CalibrationEvidence } from "../../core/calibration/index.js";
import { footprintFits } from "../../core/geometry/index.js";
import type { GeoPoint } from "../../core/geometry/index.js";
import type { PlanarRegionRecord } from "../../core/planar-region/index.js";
import type { AreasMap } from "../../core/region-areas/index.js";
import {
  SYNTHETIC_LOGOS,
  artVariantForLogoId,
  defaultSyntheticLogoId,
} from "./synthetic-logos.js";

/** Draft logo: canonical core type (independent synthetic reference). */
export type PlacementDraftLogo = CoreDraftLogo;
/** Draft placement: canonical core type (mm box + clockwise rotation). */
export type DraftPlacement = CoreDraftPlacement;
/** Numeric subset accepted by the footprint kernel. */
export type PlacementNumbers = Pick<
  CoreDraftPlacement,
  "xMm" | "yMm" | "widthMm" | "heightMm" | "rotationDeg"
>;

export interface PlacementFit {
  scaleMmPerUnit: number;
  inconsistent: boolean;
  assetFullSha256: string;
}

export interface PlacementContext {
  regions: PlanarRegionRecord[];
  areas: AreasMap;
  evidence: CalibrationEvidence | null;
  fit: PlacementFit | null;
  fitReady: boolean;
  draftEvidenceSnapshot: string | null;
  fitSnapshot: string | null;
  assetSha: string | null;
  restoreBusy: boolean;
}

export interface PlacementOverlayCorner {
  x: number;
  y: number;
  z: number;
}

export interface PlacementOverlayItem {
  id: string;
  regionId: string;
  cornersModel: PlacementOverlayCorner[];
  fits: boolean;
  selected: boolean;
  /**
   * Opaque artwork identity token for the viewer overlay texture (mirrors
   * `PlacementOverlayItem.art` in the viewer). Derived per placement via
   * `artVariantForLogoId(placement.logoId)` — catalogue art when known,
   * deterministic id-hash variant otherwise. Backed by the logo id alone,
   * so collectDraft/replaceDraft retain it with no new bundle fields.
   */
  art: string;
}

export interface PlacementViewerPort {
  setPlacementOverlays(items: PlacementOverlayItem[]): void;
}

export interface PlacementBindOptions {
  root: ParentNode;
  getContext: () => PlacementContext;
  notify: (kind: "placements" | "status", message?: string) => void;
  /** Optional viewer port; when absent the 3D overlay is skipped. */
  viewer?: () => PlacementViewerPort | null;
}

export interface PlacementDraftBundle {
  logos: LogosMap;
  placements: PlacementsMap;
}

/**
 * Frozen-contract footprint: delegates to the core `placementFootprint`
 * kernel (4 corners of the w×h box about (xMm, yMm), rotated clockwise).
 * A supplied footprint is never accepted as authority.
 */
export function computePlacementFootprint(
  placement: PlacementNumbers,
): GeoPoint[] {
  return placementFootprint({
    id: "",
    logoId: "",
    regionId: "",
    xMm: placement.xMm,
    yMm: placement.yMm,
    widthMm: placement.widthMm,
    heightMm: placement.heightMm,
    rotationDeg: placement.rotationDeg,
  });
}

type PlacementHookName =
  | "placement-panel"
  | "placement-context"
  | "logo-list"
  | "logo-id"
  | "logo-name"
  | "logo-add"
  | "placement-list"
  | "placement-logo"
  | "placement-region"
  | "placement-x"
  | "placement-y"
  | "placement-w"
  | "placement-h"
  | "placement-rot"
  | "placement-add"
  | "placement-update"
  | "placement-delete"
  | "placement-status"
  | "placement-preview2d"
  | "placement-sync3d"
  | "placement-note";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNumberText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PlacementPanel {
  private readonly root: ParentNode;
  private readonly getContext: () => PlacementContext;
  private readonly notify: (
    kind: "placements" | "status",
    message?: string,
  ) => void;
  private readonly getViewer: () => PlacementViewerPort | null;

  private readonly contextLine: HTMLElement;
  private readonly logoList: HTMLElement;
  private readonly logoId: HTMLInputElement;
  private readonly logoName: HTMLInputElement;
  private readonly logoAddButton: HTMLButtonElement;
  private readonly placementList: HTMLElement;
  private readonly placementLogo: HTMLSelectElement;
  private readonly placementRegion: HTMLSelectElement;
  private readonly placementX: HTMLInputElement;
  private readonly placementY: HTMLInputElement;
  private readonly placementW: HTMLInputElement;
  private readonly placementH: HTMLInputElement;
  private readonly placementRot: HTMLInputElement;
  private readonly placementAddButton: HTMLButtonElement;
  private readonly placementUpdateButton: HTMLButtonElement;
  private readonly placementDeleteButton: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly preview2d: HTMLElement;
  private readonly sync3dButton: HTMLButtonElement;
  private readonly noteEl: HTMLElement;

  private logos: Record<string, PlacementDraftLogo> = Object.create(null) as Record<
    string,
    PlacementDraftLogo
  >;
  private placements: Record<string, DraftPlacement> = Object.create(null) as Record<
    string,
    DraftPlacement
  >;
  private selectedPlacementId: string | null = null;
  private idCounter = 1;

  private constructor(options: PlacementBindOptions) {
    this.root = options.root;
    this.getContext = options.getContext;
    this.notify = options.notify;
    const viewer = options.viewer;
    this.getViewer = viewer ?? ((): PlacementViewerPort | null => null);
    const query = <T extends HTMLElement>(name: PlacementHookName): T => {
      const found =
        (this.root instanceof Element
          ? this.root.querySelector<T>(`[data-placement-hook="${name}"]`)
          : null) ?? document.querySelector<T>(`[data-placement-hook="${name}"]`);
      if (found === null) {
        throw new Error(`placement fragment is missing hook "${name}"`);
      }
      return found;
    };
    this.contextLine = query("placement-context");
    this.logoList = query("logo-list");
    this.logoId = query<HTMLInputElement>("logo-id");
    this.logoName = query<HTMLInputElement>("logo-name");
    this.logoAddButton = query<HTMLButtonElement>("logo-add");
    this.placementList = query("placement-list");
    this.placementLogo = query<HTMLSelectElement>("placement-logo");
    this.placementRegion = query<HTMLSelectElement>("placement-region");
    this.placementX = query<HTMLInputElement>("placement-x");
    this.placementY = query<HTMLInputElement>("placement-y");
    this.placementW = query<HTMLInputElement>("placement-w");
    this.placementH = query<HTMLInputElement>("placement-h");
    this.placementRot = query<HTMLInputElement>("placement-rot");
    this.placementAddButton = query<HTMLButtonElement>("placement-add");
    this.placementUpdateButton = query<HTMLButtonElement>("placement-update");
    this.placementDeleteButton = query<HTMLButtonElement>("placement-delete");
    this.statusEl = query("placement-status");
    this.preview2d = query("placement-preview2d");
    this.sync3dButton = query<HTMLButtonElement>("placement-sync3d");
    this.noteEl = query("placement-note");

    for (const logo of SYNTHETIC_LOGOS) {
      this.logos[logo.id] = { id: logo.id, name: logo.name };
    }

    this.logoAddButton.addEventListener("click", () => {
      this.onAddLogo();
    });
    this.placementAddButton.addEventListener("click", () => {
      this.onAddPlacement();
    });
    this.placementUpdateButton.addEventListener("click", () => {
      this.onUpdatePlacement();
    });
    this.placementDeleteButton.addEventListener("click", () => {
      this.onDeletePlacement();
    });
    this.sync3dButton.addEventListener("click", () => {
      this.syncPreview();
      this.setNote("3D overlay refresh requested (preview only).");
    });
    this.render();
  }

  static bind(options: PlacementBindOptions): PlacementPanel {
    return new PlacementPanel(options);
  }

  /** Deep copy of the draft for the lead-owned export path. */
  collectDraft(): PlacementDraftBundle {
    const logos: Record<string, PlacementDraftLogo> = Object.create(null) as Record<
      string,
      PlacementDraftLogo
    >;
    for (const [key, logo] of Object.entries(this.logos)) {
      const copy: PlacementDraftLogo = { id: logo.id, name: logo.name };
      if (logo.widthPx !== undefined) copy.widthPx = logo.widthPx;
      if (logo.heightPx !== undefined) copy.heightPx = logo.heightPx;
      logos[key] = copy;
    }
    const placements: Record<string, DraftPlacement> = Object.create(null) as Record<
      string,
      DraftPlacement
    >;
    for (const [key, placement] of Object.entries(this.placements)) {
      placements[key] = { ...placement };
    }
    return { logos, placements };
  }
  /**
   * Host-owned atomic swap: replace the whole logo/placement draft (e.g.
   * after a trusted restore) and resync. Optional logo pixel hints are
   * informational only (never drive geometry) and are carried through so a
   * restore→save round-trip keeps bundle bytes stable.
   */
  replaceDraft(draft: PlacementDraftBundle): void {
    const logos: LogosMap = Object.create(null) as LogosMap;
    for (const [key, logo] of Object.entries(draft.logos)) {
      const copy: PlacementDraftLogo = { id: logo.id, name: logo.name };
      if (logo.widthPx !== undefined) copy.widthPx = logo.widthPx;
      if (logo.heightPx !== undefined) copy.heightPx = logo.heightPx;
      logos[key] = copy;
    }
    const placements: PlacementsMap = Object.create(null) as PlacementsMap;
    for (const [key, placement] of Object.entries(draft.placements)) {
      placements[key] = { ...placement };
    }
    this.logos = logos;
    this.placements = placements;
    this.selectedPlacementId =
      this.selectedPlacementId !== null &&
      this.placements[this.selectedPlacementId] !== undefined
        ? this.selectedPlacementId
        : null;
    this.render();
  }

  /** Prune placements whose logo/region refs vanished; returns dropped ids. */
  pruneToContext(ctx?: PlacementContext): string[] {
    const context = ctx ?? this.getContext();
    const regionIds = context.regions.map((region) => region.regionId);
    const pruned = prunePlacements(this.placements, this.logos, regionIds);
    this.placements = pruned.placements;
    if (
      this.selectedPlacementId !== null &&
      this.placements[this.selectedPlacementId] === undefined
    ) {
      this.selectedPlacementId = null;
    }
    if (pruned.dropped.length > 0) this.render(context);
    return pruned.dropped;
  }

  /** Clear logos (reseeded to synthetics), placements, and selection. */
  reset(): void {
    this.logos = Object.create(null) as Record<string, PlacementDraftLogo>;
    for (const logo of SYNTHETIC_LOGOS) {
      this.logos[logo.id] = { id: logo.id, name: logo.name };
    }
    this.placements = Object.create(null) as Record<string, DraftPlacement>;
    this.selectedPlacementId = null;
    this.idCounter = 1;
    this.render();
  }

  /** Host entry point: refresh from host state; recompute + resync preview. */
  render(context?: PlacementContext): void {
    const ctx = context ?? this.getContext();
    this.renderContextLine(ctx);
    this.renderLogoList();
    this.renderSelects(ctx);
    this.renderPlacementList(ctx);
    this.renderStatus(ctx);
    this.renderPreview2d(ctx);
    this.syncPreview(ctx);
    // Restore owns an atomic state swap; prevent edits during its file read.
    for (const control of [this.logoId, this.logoName, this.logoAddButton,
      this.placementLogo, this.placementRegion, this.placementX, this.placementY,
      this.placementW, this.placementH, this.placementRot, this.placementAddButton,
      this.placementUpdateButton, this.placementDeleteButton, this.sync3dButton]) {
      control.disabled = ctx.restoreBusy;
    }
  }

  /** Alias the host can call after area/evidence/fit changes. */
  setEnabledFromHost(): void {
    this.render();
  }

  private isReady(ctx: PlacementContext): boolean {
    return (
      ctx.fitReady &&
      ctx.fit !== null &&
      !ctx.restoreBusy &&
      ctx.draftEvidenceSnapshot !== null &&
      ctx.fitSnapshot !== null &&
      ctx.draftEvidenceSnapshot === ctx.fitSnapshot
    );
  }

  private regionById(
    ctx: PlacementContext,
    regionId: string,
  ): PlanarRegionRecord | null {
    for (const region of ctx.regions) {
      if (region.regionId === regionId) return region;
    }
    return null;
  }

  private validateNumbers(
    logoId: string,
    regionId: string,
    xMm: number | null,
    yMm: number | null,
    widthMm: number | null,
    heightMm: number | null,
    rotationDeg: number | null,
    regionIds: readonly string[],
  ): string | null {
    if (logoId.trim().length === 0) return "A logo must be selected.";
    if (regionId.trim().length === 0) return "A region must be selected.";
    if (xMm === null || yMm === null) {
      return "Centre x/y must be finite numbers (mm).";
    }
    if (widthMm === null) {
      return "Width must be a finite number > 0 (mm).";
    }
    if (heightMm === null) {
      return "Height must be a finite number > 0 (mm).";
    }
    if (rotationDeg === null) {
      return "Rotation must be a finite number of clockwise degrees.";
    }
    const check = validateDraftPlacement(
      { id: "__panel-preview__", logoId, regionId, xMm, yMm, widthMm, heightMm, rotationDeg },
      this.logos,
      regionIds,
    );
    if (!check.ok) return check.error;
    return null;
  }
  private readEditor(): {
    logoId: string;
    regionId: string;
    xMm: number | null;
    yMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    rotationDeg: number | null;
  } {
    return {
      logoId: this.placementLogo.value,
      regionId: this.placementRegion.value,
      xMm: parseNumberText(this.placementX.value),
      yMm: parseNumberText(this.placementY.value),
      widthMm: parseNumberText(this.placementW.value),
      heightMm: parseNumberText(this.placementH.value),
      rotationDeg: parseNumberText(this.placementRot.value),
    };
  }

  private nextPlacementId(): string {
    for (;;) {
      const candidate = `PLC-${String(this.idCounter).padStart(4, "0")}`;
      this.idCounter += 1;
      if (this.placements[candidate] === undefined) return candidate;
    }
  }

  private onAddLogo(): void {
    if (this.getContext().restoreBusy) return;
    const id = this.logoId.value.trim();
    const name = this.logoName.value.trim();
    if (id.length === 0) {
      this.setNote("Logo was not added: id must be non-empty.");
      return;
    }
    if (id.length > 256) {
      this.setNote("Logo was not added: id exceeds 256 characters.");
      return;
    }
    if (name.length === 0) {
      this.setNote("Logo was not added: name must be non-empty.");
      return;
    }
    const added = addLogo(this.logos, { id, name });
    if (!added.ok) {
      this.setNote(`Logo was not added: ${added.error}`);
      return;
    }
    this.logos = added.logos;
    this.logoId.value = "";
    this.logoName.value = "";
    this.setNote(`Logo "${id}" added (draft only).`);
    this.notify("placements", `logo added ${id}`);
    this.render();
  }

  private onRemoveLogo(id: string): void {
    if (this.getContext().restoreBusy) return;
    const removed = removeLogo(this.logos, this.placements, id);
    if (!removed.ok) {
      if (this.logos[id] === undefined) {
        this.setNote(`Logo "${id}" is already gone.`);
      } else {
        this.setNote(`Logo "${id}" was not removed: ${removed.error}`);
      }
      return;
    }
    this.logos = removed.logos;
    this.setNote(`Logo "${id}" removed (draft only).`);
    this.notify("placements", `logo removed ${id}`);
    this.render();
  }

  private onAddPlacement(): void {
    if (this.getContext().restoreBusy) return;
    const ctx = this.getContext();
    const editor = this.readEditor();
    const regionIds = ctx.regions.map((region) => region.regionId);
    const error = this.validateNumbers(
      editor.logoId,
      editor.regionId,
      editor.xMm,
      editor.yMm,
      editor.widthMm,
      editor.heightMm,
      editor.rotationDeg,
      regionIds,
    );
    if (error !== null) {
      this.setNote(`Placement was not added: ${error}`);
      return;
    }
    const id = this.nextPlacementId();
    const added = addPlacement(
      this.placements,
      {
        id,
        logoId: editor.logoId,
        regionId: editor.regionId,
        xMm: editor.xMm as number,
        yMm: editor.yMm as number,
        widthMm: editor.widthMm as number,
        heightMm: editor.heightMm as number,
        rotationDeg: editor.rotationDeg as number,
      },
      this.logos,
      regionIds,
    );
    if (!added.ok) {
      this.setNote(`Placement was not added: ${added.error}`);
      return;
    }
    this.placements = added.placements;
    this.selectedPlacementId = id;
    this.hydrateEditor(this.placements[id]!);
    this.setNote(`Placement "${id}" added (draft only, pending review).`);
    this.notify("placements", `placement added ${id}`);
    this.render(ctx);
  }

  private onUpdatePlacement(): void {
    if (this.getContext().restoreBusy) return;
    const ctx = this.getContext();
    const selected =
      this.selectedPlacementId === null
        ? undefined
        : this.placements[this.selectedPlacementId];
    if (selected === undefined) {
      this.setNote("Update needs a selected placement first.");
      return;
    }
    const editor = this.readEditor();
    const regionIds = ctx.regions.map((region) => region.regionId);
    const error = this.validateNumbers(
      editor.logoId,
      editor.regionId,
      editor.xMm,
      editor.yMm,
      editor.widthMm,
      editor.heightMm,
      editor.rotationDeg,
      regionIds,
    );
    if (error !== null) {
      this.setNote(`Placement "${selected.id}" was not updated: ${error}`);
      return;
    }
    const updated = updatePlacement(
      this.placements,
      selected.id,
      {
        logoId: editor.logoId,
        regionId: editor.regionId,
        xMm: editor.xMm as number,
        yMm: editor.yMm as number,
        widthMm: editor.widthMm as number,
        heightMm: editor.heightMm as number,
        rotationDeg: editor.rotationDeg as number,
      },
      this.logos,
      regionIds,
    );
    if (!updated.ok) {
      this.setNote(`Placement "${selected.id}" was not updated: ${updated.error}`);
      return;
    }
    this.placements = updated.placements;
    this.setNote(`Placement "${selected.id}" updated (draft only).`);
    this.notify("placements", `placement updated ${selected.id}`);
    this.render(ctx);
  }

  private onDeletePlacement(): void {
    if (this.getContext().restoreBusy) return;
    const selected =
      this.selectedPlacementId === null
        ? undefined
        : this.placements[this.selectedPlacementId];
    if (selected === undefined) {
      this.setNote("Delete needs a selected placement first.");
      return;
    }
    const removed = removePlacement(this.placements, selected.id);
    if (!removed.ok) {
      this.setNote(`Placement "${selected.id}" was not deleted: ${removed.error}`);
      return;
    }
    this.placements = removed.placements;
    this.selectedPlacementId = null;
    this.setNote(`Placement "${selected.id}" deleted (draft only).`);
    this.notify("placements", `placement deleted ${selected.id}`);
    this.render();
  }

  private onSelectPlacement(id: string): void {
    if (this.getContext().restoreBusy) return;
    const placement = this.placements[id];
    if (placement === undefined) return;
    this.selectedPlacementId = id;
    this.hydrateEditor(placement);
    this.render();
  }

  private hydrateEditor(placement: DraftPlacement): void {
    this.placementLogo.value = placement.logoId;
    this.placementRegion.value = placement.regionId;
    this.placementX.value = String(placement.xMm);
    this.placementY.value = String(placement.yMm);
    this.placementW.value = String(placement.widthMm);
    this.placementH.value = String(placement.heightMm);
    this.placementRot.value = String(placement.rotationDeg);
  }

  private evaluatePlacement(
    ctx: PlacementContext,
    placement: DraftPlacement,
  ): { fits: boolean; reason: string; stale: boolean } {
    if (!this.isReady(ctx)) {
      if (ctx.restoreBusy) {
        return {
          fits: false,
          reason: "stale: a restore is running",
          stale: true,
        };
      }
      if (!ctx.fitReady || ctx.fit === null) {
        return {
          fits: false,
          reason: "stale: no current consistent fit",
          stale: true,
        };
      }
      return {
        fits: false,
        reason: "stale: evidence snapshot differs from the fit snapshot",
        stale: true,
      };
    }
    const region = this.regionById(ctx, placement.regionId);
    if (region === null) {
      return {
        fits: false,
        reason: `invalid reference: unknown region "${placement.regionId}"`,
        stale: false,
      };
    }
    if (
      ctx.draftEvidenceSnapshot === null ||
      region.sourceEvidenceSnapshot !== ctx.draftEvidenceSnapshot
    ) {
      return {
        fits: false,
        reason: "stale: region evidence differs from the current draft",
        stale: true,
      };
    }
    if (
      !isFiniteNumber(placement.xMm) ||
      !isFiniteNumber(placement.yMm) ||
      !isFiniteNumber(placement.widthMm) ||
      !(placement.widthMm > 0) ||
      !isFiniteNumber(placement.heightMm) ||
      !(placement.heightMm > 0) ||
      !isFiniteNumber(placement.rotationDeg) ||
      !(placement.rotationDeg > -180 && placement.rotationDeg <= 180)
    ) {
      return {
        fits: false,
        reason: "invalid numbers: centre must be finite, dims > 0, rotation in (-180, 180]",
        stale: false,
      };
    }
    const record = ctx.areas[placement.regionId];
    if (record === undefined || record === null) {
      return {
        fits: false,
        reason: "no saved areas for this region yet",
        stale: false,
      };
    }
    if (record.safePolygon === null) {
      return {
        fits: false,
        reason: "no safe polygon configured for this region",
        stale: false,
      };
    }
    const footprint = computePlacementFootprint(placement);
    try {
      const verdict = footprintFits({
        safe: record.safePolygon.map((point) => ({ x: point.x, y: point.y })),
        exclusions: record.exclusions.map((exclusion) =>
          exclusion.polygon.map((point) => ({ x: point.x, y: point.y })),
        ),
        footprint,
      });
      return { fits: verdict.fits, reason: verdict.reason, stale: false };
    } catch (error) {
      return {
        fits: false,
        reason: `check failed: ${error instanceof Error ? error.message : String(error)}`,
        stale: false,
      };
    }
  }

  private renderContextLine(ctx: PlacementContext): void {
    const count = Object.keys(this.placements).length;
    const ready = this.isReady(ctx);
    this.contextLine.textContent =
      `${ctx.regions.length} region(s), ${count} placement(s), ` +
      (ready
        ? "fit current — statuses live."
        : "STALE or missing fit — statuses marked stale, 3D preview cleared.");
  }

  private renderLogoList(): void {
    this.logoList.replaceChildren();
    const ids = Object.keys(this.logos).sort();
    if (ids.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "No logos yet.";
      this.logoList.appendChild(empty);
      return;
    }
    for (const id of ids) {
      const logo = this.logos[id];
      if (logo === undefined) continue;
      const item = document.createElement("li");
      item.textContent = `"${logo.id}" (${logo.name}) `;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.disabled = this.getContext().restoreBusy;
      remove.textContent = `Remove "${logo.id}"`;
      remove.setAttribute("aria-label", `Remove logo ${logo.id}`);
      remove.setAttribute("data-placement-hook", "logo-remove");
      const logoId = logo.id;
      remove.addEventListener("click", () => {
        this.onRemoveLogo(logoId);
      });
      item.appendChild(remove);
      this.logoList.appendChild(item);
    }
  }

  private renderSelects(ctx: PlacementContext): void {
    const keepLogo = this.placementLogo.value;
    const keepRegion = this.placementRegion.value;
    const logoIds = Object.keys(this.logos).sort();
    this.placementLogo.replaceChildren();
    for (const id of logoIds) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      this.placementLogo.appendChild(option);
    }
    if (keepLogo !== "" && logoIds.includes(keepLogo)) {
      this.placementLogo.value = keepLogo;
    } else if (this.placementLogo.value.trim().length === 0) {
      this.placementLogo.value = defaultSyntheticLogoId();
    }
    const regionIds = ctx.regions.map((region) => region.regionId);
    this.placementRegion.replaceChildren();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "— select region —";
    this.placementRegion.appendChild(empty);
    for (const region of ctx.regions) {
      const option = document.createElement("option");
      option.value = region.regionId;
      option.textContent = region.regionId;
      this.placementRegion.appendChild(option);
    }
    if (keepRegion !== "" && regionIds.includes(keepRegion)) {
      this.placementRegion.value = keepRegion;
    }
  }

  private renderPlacementList(ctx: PlacementContext): void {
    void ctx;
    this.placementList.replaceChildren();
    const ids = Object.keys(this.placements).sort();
    if (ids.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "No placements yet.";
      this.placementList.appendChild(empty);
      return;
    }
    for (const id of ids) {
      const placement = this.placements[id];
      if (placement === undefined) continue;
      const item = document.createElement("li");
      const selected = placement.id === this.selectedPlacementId;
      item.textContent =
        `"${placement.id}" logo "${placement.logoId}" region "${placement.regionId}" ` +
        `x=${placement.xMm} y=${placement.yMm} w=${placement.widthMm} h=${placement.heightMm} ` +
        `rot=${placement.rotationDeg}°${selected ? " (selected)" : ""} `;
      const select = document.createElement("button");
      select.type = "button";
      select.textContent = selected ? "Selected" : `Select "${placement.id}"`;
      select.disabled = selected || ctx.restoreBusy;
      select.setAttribute("aria-label", `Select placement ${placement.id}`);
      const placementId = placement.id;
      select.addEventListener("click", () => {
        this.onSelectPlacement(placementId);
      });
      item.appendChild(select);
      this.placementList.appendChild(item);
    }
  }

  private renderStatus(ctx: PlacementContext): void {
    this.statusEl.replaceChildren();
    const ids = Object.keys(this.placements).sort();
    if (ids.length === 0) {
      this.statusEl.textContent = "No placements to check.";
      return;
    }
    const list = document.createElement("ul");
    for (const id of ids) {
      const placement = this.placements[id];
      if (placement === undefined) continue;
      const verdict = this.evaluatePlacement(ctx, placement);
      const footprint = computePlacementFootprintSafe(placement);
      const item = document.createElement("li");
      const cornersText =
        footprint === null
          ? " (footprint not computable from numbers)"
          : ` (corners ${footprint
              .map(
                (corner) =>
                  `(${Number.isInteger(corner.x) ? String(corner.x) : corner.x.toFixed(3)}, ${Number.isInteger(corner.y) ? String(corner.y) : corner.y.toFixed(3)})`,
              )
              .join(" ")})`;
      item.textContent =
        `"${placement.id}": ${verdict.stale ? "STALE — " : ""}${verdict.fits ? "fits" : "does not fit"} — ` +
        `${verdict.reason}${cornersText}`;
      list.appendChild(item);
    }
    this.statusEl.appendChild(list);
  }

  private renderPreview2d(ctx: PlacementContext): void {
    const svgNS = "http://www.w3.org/2000/svg";
    this.preview2d.replaceChildren();
    if (ctx.regions.length === 0) {
      this.preview2d.textContent = "Preview unavailable: no regions authored.";
      return;
    }
    if (!this.isReady(ctx)) {
      this.preview2d.textContent =
        "Preview unavailable until evidence and fit are current (stale or missing fit).";
      return;
    }
    let rendered = 0;
    for (const region of ctx.regions) {
      const record = ctx.areas[region.regionId];
      const safe = record?.safePolygon ?? null;
      const exclusions = record?.exclusions ?? [];
      const footprints = Object.values(this.placements)
        .filter((placement) => placement.regionId === region.regionId)
        .map((placement) => ({
          placement,
          corners: computePlacementFootprintSafe(placement),
        }))
        .filter(
          (
            entry,
          ): entry is {
            placement: DraftPlacement;
            corners: GeoPoint[];
          } => entry.corners !== null,
        );
      if (safe === null && exclusions.length === 0 && footprints.length === 0) {
        continue;
      }
      rendered += 1;
      const heading = document.createElement("h3");
      heading.textContent = `Region "${region.regionId}" (mm, +Y up)`;
      this.preview2d.appendChild(heading);
      const all: GeoPoint[] = [
        { x: 0, y: 0 },
        ...(safe ?? []),
        ...exclusions.flatMap((entry) => entry.polygon),
        ...footprints.flatMap((entry) => entry.corners),
      ];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of all) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      const pad = Math.max(maxX - minX, maxY - minY) * 0.1 + 1;
      minX -= pad;
      minY -= pad;
      maxX += pad;
      maxY += pad;
      const width = maxX - minX;
      const height = maxY - minY;
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
      svg.setAttribute("role", "presentation");
      svg.setAttribute("width", "100%");
      const flip = document.createElementNS(svgNS, "g");
      flip.setAttribute("transform", `translate(0 ${minY + maxY}) scale(1 -1)`);
      const polygonEl = (
        points: GeoPoint[],
        fill: string,
        stroke: string,
        dash: string | null,
      ): SVGGraphicsElement => {
        const el = document.createElementNS(svgNS, "polygon");
        el.setAttribute(
          "points",
          points.map((point) => `${point.x},${point.y}`).join(" "),
        );
        el.setAttribute("fill", fill);
        el.setAttribute("stroke", stroke);
        el.setAttribute(
          "stroke-width",
          String(Math.max(width, height) * 0.004),
        );
        if (dash !== null) el.setAttribute("stroke-dasharray", dash);
        return el as unknown as SVGGraphicsElement;
      };
      if (safe !== null) {
        flip.appendChild(polygonEl(safe, "#d7e9f7", "#1d5f9e", null));
      }
      for (const exclusion of exclusions) {
        flip.appendChild(
          polygonEl(exclusion.polygon, "#f9dfcf", "#a34a1c", null),
        );
      }
      for (const entry of footprints) {
        const selected = entry.placement.id === this.selectedPlacementId;
        const fits = this.evaluatePlacement(ctx, entry.placement).fits;
        flip.appendChild(
          polygonEl(
            entry.corners,
            selected ? "#c8f0d4" : "none",
            fits ? "#1e7d32" : "#a31c1c",
            selected ? null : "4 2",
          ),
        );
      }
      svg.appendChild(flip);
      this.preview2d.appendChild(svg);
    }
    const legend = document.createElement("p");
    legend.textContent =
      "Legend: blue = safe, orange = exclusion, green = fitting footprint, " +
      "red = invalid footprint, filled = selected. Preview only — not to scale with the 3D view.";
    this.preview2d.appendChild(legend);
    if (rendered === 0) {
      const empty = document.createElement("p");
      empty.textContent =
        "No saved areas or placements to preview yet (mm).";
      this.preview2d.appendChild(empty);
    }
  }

  /**
   * Map every valid placement footprint to wrapper-local model coords via
   * the region planar mapping (`createPlanarMapping(...).toModel`) and push
   * the overlay set; on any invalidation (no viewer, no fit, stale) push an
   * empty set. Never throws.
   */
  syncPreview(context?: PlacementContext): void {
    try {
      const viewer = this.getViewer();
      if (viewer === null) return;
      const ctx = context ?? this.getContext();
      if (!this.isReady(ctx)) {
        viewer.setPlacementOverlays([]);
        return;
      }
      const items: PlacementOverlayItem[] = [];
      for (const placement of Object.values(this.placements)) {
        const region = this.regionById(ctx, placement.regionId);
        if (region === null) continue;
        if (
          ctx.draftEvidenceSnapshot === null ||
          region.sourceEvidenceSnapshot !== ctx.draftEvidenceSnapshot
        ) {
          continue;
        }
        const corners = computePlacementFootprintSafe(placement);
        if (corners === null) continue;
        let mapping: { toModel(p: { x: number; y: number }): { x: number; y: number; z: number } };
        try {
          mapping = createPlanarMapping({
            frameId: region.frameId,
            origin: { x: region.origin.x, y: region.origin.y, z: region.origin.z },
            xAxis: { x: region.xAxis.x, y: region.xAxis.y, z: region.xAxis.z },
            yAxis: { x: region.yAxis.x, y: region.yAxis.y, z: region.yAxis.z },
            mmPerModelUnit: region.mmPerModelUnit,
            offPlaneToleranceMm: region.offPlaneToleranceMm,
          });
        } catch {
          continue;
        }
        const cornersModel: PlacementOverlayCorner[] = [];
        let ok = true;
        for (const corner of corners) {
          try {
            const model = mapping.toModel({ x: corner.x, y: corner.y });
            if (
              !isFiniteNumber(model.x) ||
              !isFiniteNumber(model.y) ||
              !isFiniteNumber(model.z)
            ) {
              ok = false;
              break;
            }
            cornersModel.push({ x: model.x, y: model.y, z: model.z });
          } catch {
            ok = false;
            break;
          }
        }
        if (!ok || cornersModel.length !== 4) continue;
        const verdict = this.evaluatePlacement(ctx, placement);
        items.push({
          id: placement.id,
          regionId: placement.regionId,
          cornersModel,
          fits: verdict.fits && !verdict.stale,
          selected: placement.id === this.selectedPlacementId,
          // Artwork identity: logo id alone backs the token (catalogue art
          // or id-hashed variant), so save/restore retains it with no new
          // bundle fields; custom-logo add/remove keeps working unchanged.
          art: artVariantForLogoId(placement.logoId),
        });
      }
      viewer.setPlacementOverlays(items);
    } catch {
      return;
    }
  }

  private setNote(message: string): void {
    this.noteEl.textContent = message;
  }
}

function computePlacementFootprintSafe(
  placement: PlacementNumbers,
): GeoPoint[] | null {
  if (
    !isFiniteNumber(placement.xMm) ||
    !isFiniteNumber(placement.yMm) ||
    !isFiniteNumber(placement.widthMm) ||
    !(placement.widthMm > 0) ||
    !isFiniteNumber(placement.heightMm) ||
    !(placement.heightMm > 0) ||
    !isFiniteNumber(placement.rotationDeg) ||
    !(placement.rotationDeg > -180 && placement.rotationDeg <= 180)
  ) {
    return null;
  }
  try {
    const corners = computePlacementFootprint(placement);
    for (const corner of corners) {
      if (!isFiniteNumber(corner.x) || !isFiniteNumber(corner.y)) return null;
    }
    return corners;
  } catch {
    return null;
  }
}
