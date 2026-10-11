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

/** Live drag transaction: candidate kept separate from committed state. */
export interface PlacementDragState {
  placementId: string;
  pointerId: number;
  baseline: DraftPlacement;
  candidateX: number;
  candidateY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  generation: number;
  evidenceSnapshot: string | null;
  fitSnapshot: string | null;
  regionIds: string;
  // Full physical-context signature captured at pointerdown: any host-side
  // change to these values mid-gesture makes the baseline untrustworthy and
  // aborts the drag (see dragStale). Baseline/area/region comparisons catch
  // host edits even when ids are retained.
  assetSha: string | null;
  fitReady: boolean;
  fitScaleMmPerUnit: number | null;
  fitInconsistent: boolean | null;
  fitAssetFullSha256: string | null;
  selectedId: string | null;
  regionSignature: string;
  areaSignature: string;
  // Frozen svg mapping seen at gesture start ("minX,minY,w,h|minY|maxY"):
  // renderPreview2d holds these bounds from committed footprints while the
  // drag is live, so the stored string must still match at move/up time.
  frozenViewBox: string;
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
  /**
   * Monotonic draft-generation counter. Incremented by every host-owned
   * committed-state swap (`replaceDraft`/`reset`/`pruneToContext`) so a
   * render mid-gesture can detect that the baseline moved under the drag.
   */
  private dragGeneration = 0;
  /**
   * Live drag candidate, kept SEPARATE from committed `this.placements`
   * until pointerup commits via core `updatePlacement`. Export during a
   * drag (`collectDraft`) therefore serializes pre-drag bytes; only the
   * render helpers merge the candidate for display.
   */
  private activeDrag: PlacementDragState | null = null;
  /**
   * Focus target: placement id whose live footprint should take keyboard
   * focus after the svg subtree is rebuilt, so focus is never stranded on
   * a detached node (see renderPreview2d tail).
   */
  private pendingDragFocus: string | null = null;

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
    // Drag listeners attach ONCE on the stable preview2d container: render
    // rebuilds the SVG children (footprints) on every pointermove, so
    // capturing on the footprint itself would lose the gesture. Pointer
    // capture is taken on the container instead (see onDragPointerDown).
    this.preview2d.addEventListener("pointerdown", (e) => {
      if (e instanceof PointerEvent) this.onDragPointerDown(e);
    });
    this.preview2d.addEventListener("pointermove", (e) => {
      if (e instanceof PointerEvent) this.onDragPointerMove(e);
    });
    this.preview2d.addEventListener("pointerup", (e) => {
      if (e instanceof PointerEvent) this.onDragPointerUp(e);
    });
    this.preview2d.addEventListener("pointercancel", (e) => {
      if (e instanceof PointerEvent) this.onDragPointerCancel(e);
    });
    this.preview2d.addEventListener("lostpointercapture", (e) => {
      // PointerId policy: only the captured pointer ends the gesture; every
      // pointer event (move/up/cancel/lostcapture) must match drag.pointerId
      // exactly — no zero special-case, so synthetic id-0 events stay inert.
      if (e instanceof PointerEvent) this.onDragLostCapture(e);
    });
    // Keyboard handling lives on window (not the container): synthetic and
    // real Escape presses may arrive with focus outside the preview, while
    // footprint Enter/Space still bubbles up from the focused polygon.
    window.addEventListener("keydown", (e) => {
      if (e instanceof KeyboardEvent) this.onDragKeyDown(e);
    });
    window.addEventListener("blur", () => {
      this.cancelActiveDrag("Drag cancelled (window lost focus).");
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
    this.dragGeneration += 1;
    this.dropActiveDrag();
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
    this.dragGeneration += 1;
    this.dropActiveDrag();
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
    this.dragGeneration += 1;
    this.dropActiveDrag();
    this.render();
  }

  /** Host entry point: refresh from host state; recompute + resync preview. */
  render(context?: PlacementContext): void {
    const ctx = context ?? this.getContext();
    // Mid-gesture invalidation: baseline moved under the drag (restore
    // running, generation bumped by host edits/replaceDraft/reset/prune,
    // snapshots/fit/regions/areas/selection changed, placement/region
    // vanished, or the frozen viewBox drifted) → silently discard the
    // candidate internals (no note spam, no nested render) and continue
    // this pass on committed state; a late pointerup is then inert.
    if (
      this.activeDrag !== null &&
      (this.dragStale(ctx, this.activeDrag) || this.dragViewBoxStale(this.activeDrag))
    ) {
      const stale = this.activeDrag;
      this.releaseDragCapture(stale.pointerId);
      this.activeDrag = null;
      const baseline = this.placements[stale.placementId];
      if (baseline !== undefined) this.hydrateEditor(baseline);
    }
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
    // Host-owned committed edits invalidate even when ids are retained.
    this.dragGeneration += 1;
    this.dropActiveDrag();
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
    this.dragGeneration += 1;
    this.dropActiveDrag();
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
    this.dragGeneration += 1;
    this.dropActiveDrag();
    this.setNote(`Placement "${selected.id}" deleted (draft only).`);
    this.notify("placements", `placement deleted ${selected.id}`);
    this.render();
  }

  private onSelectPlacement(id: string): void {
    if (this.getContext().restoreBusy) return;
    const placement = this.placements[id];
    if (placement === undefined) return;
    // A host selection change under a live gesture retires the drag through
    // the selectedId leg of the context signature (never a silent reseed).
    this.selectedPlacementId = id;
    this.hydrateEditor(placement);
    this.render();
  }

  private hydrateEditor(placement: DraftPlacement): void {
    const shown = this.draggedView(placement);
    this.placementLogo.value = placement.logoId;
    this.placementRegion.value = placement.regionId;
    this.placementX.value = String(shown.xMm);
    this.placementY.value = String(shown.yMm);
    this.placementW.value = String(shown.widthMm);
    this.placementH.value = String(shown.heightMm);
    this.placementRot.value = String(shown.rotationDeg);
  }

  /** Committed placement merged with the live drag candidate for display. */
  private draggedView(placement: DraftPlacement): DraftPlacement {
    const drag = this.activeDrag;
    if (drag !== null && drag.placementId === placement.id) {
      return { ...placement, xMm: drag.candidateX, yMm: drag.candidateY };
    }
    return placement;
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
      const committed = this.placements[id];
      if (committed === undefined) continue;
      const placement = this.draggedView(committed);
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
      const committed = this.placements[id];
      if (committed === undefined) continue;
      const placement = this.draggedView(committed);
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
    const activeElement = document.activeElement;
    const focusInsidePreview =
      activeElement instanceof Element && this.preview2d.contains(activeElement);
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
      // Frozen bounds while a drag is live: the svg viewBox is measured
      // from COMMITTED footprints only (never the candidate), so the
      // viewBox/letterbox mapping that clientToRegionMm inverts cannot drift
      // under the pointer. The candidate polygon still renders — under those
      // frozen bounds, possibly overflowing mid-gesture. Commit re-measures.
      const frozen = this.activeDrag !== null;
      const draggedRegion =
        frozen && this.activeDrag !== null
          ? (this.placements[this.activeDrag.placementId]?.regionId ?? null)
          : null;
      const footprints: { placement: DraftPlacement; corners: GeoPoint[] }[] = [];
      for (const committed of Object.values(this.placements)) {
        if (committed.regionId !== region.regionId) continue;
        const shown = this.draggedView(committed);
        // Only the dragged region freezes its measure input; sibling svgs
        // keep live bounds so unrelated regions never go stale-looking.
        const freezeMeasure = frozen && region.regionId === draggedRegion;
        const corners = computePlacementFootprintSafe(freezeMeasure ? committed : shown);
        if (corners === null) continue;
        footprints.push({ placement: shown, corners });
      }
      if (safe === null && exclusions.length === 0 && footprints.length === 0) {
        continue;
      }
      rendered += 1;
      const heading = document.createElement("h3");
      heading.textContent = `Region "${region.regionId}" (mm, +Y up)`;
      this.preview2d.appendChild(heading);
      const frozenBox =
        frozen && region.regionId === draggedRegion ? this.frozenBoxForRegion(region.regionId) : null;
      const measuredCorners: GeoPoint[][] = [];
      for (const entry of footprints) measuredCorners.push(entry.corners);
      const bounds = frozenBox ?? this.measureBounds(safe, exclusions, measuredCorners);
      if (bounds === null) continue;
      const minX = bounds.minX;
      const minY = bounds.minY;
      const maxX = bounds.maxX;
      const maxY = bounds.maxY;
      const width = maxX - minX;
      const height = maxY - minY;
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
      svg.setAttribute("role", "group");
      svg.setAttribute("aria-label", `Millimetre preview of region ${region.regionId}`);
      svg.setAttribute("data-region-id", region.regionId);
      svg.setAttribute("data-min-y", String(minY));
      svg.setAttribute("data-max-y", String(maxY));
      svg.setAttribute("width", "100%");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      const flip = document.createElementNS(svgNS, "g");
      flip.setAttribute("transform", `translate(0 ${minY + maxY}) scale(1 -1)`);
      const polygonEl = (
        points: GeoPoint[],
        fill: string,
        stroke: string,
        dash: string | null,
      ): SVGPolygonElement => {
        const el = document.createElementNS(svgNS, "polygon");
        // createElementNS is untyped for the svg tag name; "polygon" always yields a polygon element.
        const polygon = el as SVGPolygonElement;
        polygon.setAttribute(
          "points",
          points.map((point) => `${point.x},${point.y}`).join(" "),
        );
        polygon.setAttribute("fill", fill);
        polygon.setAttribute("stroke", stroke);
        polygon.setAttribute(
          "stroke-width",
          String(Math.max(width, height) * 0.004),
        );
        if (dash !== null) polygon.setAttribute("stroke-dasharray", dash);
        return polygon;
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
        const verdict = this.evaluatePlacement(ctx, entry.placement);
        // Contract attrs live directly on the footprint polygon so the
        // existing stroke assertion keeps hitting this element. Hittable:
        // fill is never "none" (selected: translucent blue; unselected:
        // "transparent") + pointer-events all, so the selected footprint
        // stays visibly distinct while the red/green verdict stroke reads.
        const fp = polygonEl(
          entry.corners,
          selected ? "rgba(29, 95, 158, 0.35)" : "transparent",
          verdict.fits ? "#1e7d32" : "#ff0000",
          null,
        );
        fp.setAttribute("data-placement-id", entry.placement.id);
        fp.setAttribute("tabindex", "0");
        fp.setAttribute("role", "button");
        fp.setAttribute(
          "aria-label",
          `Placement ${entry.placement.id} in region ${entry.placement.regionId} at ` +
            `x ${entry.placement.xMm} y ${entry.placement.yMm} millimetres` +
            (verdict.fits ? ", fits" : ", does not fit"),
        );
        fp.setAttribute("aria-pressed", selected ? "true" : "false");
        fp.setAttribute("data-selected", selected ? "true" : "false");
        fp.style.pointerEvents = "all";
        fp.style.cursor = "grab";
        fp.style.touchAction = "none";
        flip.appendChild(fp);
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
    // Keyboard focus usability: an svg rebuild replaces the focused polygon
    // node, so when focus sat inside the preview (or a drag cellared one),
    // refocus the live footprint; without a live match keep focus stable
    // on the container instead of stranding it on a detached node.
    if (this.pendingDragFocus !== null) {
      const wanted = this.pendingDragFocus;
      this.pendingDragFocus = null;
      if (focusInsidePreview) this.focusLiveFootprint(wanted);
    } else if (focusInsidePreview) {
      const selected = this.selectedPlacementId;
      if (selected !== null) this.focusLiveFootprint(selected);
    }
  }

  /** Refocus the live footprint after an SVG redraw, else the container. */
  private focusLiveFootprint(wantedId: string): void {
    const live = this.findFootprint(wantedId);
    if (live instanceof SVGElement) {
      live.focus({ preventScroll: true });
      return;
    }
    if (live instanceof HTMLElement) {
      live.focus({ preventScroll: true });
      return;
    }
    if (!this.preview2d.hasAttribute("tabindex")) {
      this.preview2d.setAttribute("tabindex", "-1");
    }
    this.preview2d.focus({ preventScroll: true });
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
      for (const committed of Object.values(this.placements)) {
        const placement = this.draggedView(committed);
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

  /** True when the drag baseline no longer matches the live context. */
  private dragStale(ctx: PlacementContext, drag: PlacementDragState): boolean {
    const committed = this.placements[drag.placementId];
    if (committed === undefined) return true;
    if (ctx.restoreBusy) return true;
    if (drag.generation !== this.dragGeneration) return true;
    if (ctx.draftEvidenceSnapshot !== drag.evidenceSnapshot) return true;
    if (ctx.fitSnapshot !== drag.fitSnapshot) return true;
    if (ctx.assetSha !== drag.assetSha) return true;
    if (ctx.fitReady !== drag.fitReady) return true;
    if (ctx.draftEvidenceSnapshot !== ctx.fitSnapshot) return true;
    if (!this.isReady(ctx)) return true;
    if (ctx.regions.map((region) => region.regionId).join("\0") !== drag.regionIds) return true;
    if (this.regionSignature(ctx) !== drag.regionSignature) return true;
    if (this.areaSignature(ctx) !== drag.areaSignature) return true;
    if (this.selectedPlacementId !== drag.selectedId) return true;
    // Committed baseline copy: host numeric edits / delete+re-add with same
    // id still invalidate even when the id is retained.
    const base = drag.baseline;
    if (
      committed.id !== base.id ||
      committed.logoId !== base.logoId ||
      committed.regionId !== base.regionId ||
      committed.xMm !== base.xMm ||
      committed.yMm !== base.yMm ||
      committed.widthMm !== base.widthMm ||
      committed.heightMm !== base.heightMm ||
      committed.rotationDeg !== base.rotationDeg
    ) {
      return true;
    }
    if (this.regionById(ctx, committed.regionId) === null) return true;
    const fit = ctx.fit;
    if ((fit === null) !== (drag.fitScaleMmPerUnit === null)) return true;
    if (fit !== null) {
      if (
        fit.scaleMmPerUnit !== drag.fitScaleMmPerUnit ||
        fit.inconsistent !== drag.fitInconsistent ||
        fit.assetFullSha256 !== drag.fitAssetFullSha256
      ) {
        return true;
      }
    }
    return false;
  }

  /** Stable string of every region's frame/origin/axes/mm/tolerance + source. */
  private regionSignature(ctx: PlacementContext): string {
    return JSON.stringify(ctx.regions
      .map((region) =>
        [
          region.regionId,
          region.frameId,
          region.originAnchorId,
          region.xAnchorId,
          region.yAnchorId,
          region.origin.x,
          region.origin.y,
          region.origin.z,
          region.xAxis.x,
          region.xAxis.y,
          region.xAxis.z,
          region.yAxis.x,
          region.yAxis.y,
          region.yAxis.z,
          region.mmPerModelUnit,
          region.offPlaneToleranceMm,
          region.sourceEvidenceSnapshot,
        ],
      )
    );
  }

  /** Stable string of the saved safe/exclusion areas (dragged region included). */
  private areaSignature(ctx: PlacementContext): string {
    return JSON.stringify(Object.keys(ctx.areas).sort().map((id) => {
      const record = ctx.areas[id];
      return [id, record?.safePolygon ?? null,
        record?.exclusions.map((exclusion) => exclusion.polygon) ?? []];
    }));
  }

  /**
   * Committed-only bounds for the dragged region's svg, in the same
   * "minX,minY,w,h|minY|maxY" shape stored on the drag. Candidate polygons
   * are excluded so the viewBox cannot drift mid-gesture.
   */
  private committedViewBoxFor(ctx: PlacementContext, placementId: string): string | null {
    const committed = this.placements[placementId];
    if (committed === undefined) return null;
    const regionId = committed.regionId;
    const region = this.regionById(ctx, regionId);
    if (region === null) return null;
    const record = ctx.areas[regionId];
    const corners: GeoPoint[][] = [];
    for (const entry of Object.values(this.placements)) {
      if (entry.regionId !== regionId) continue;
      const footprint = computePlacementFootprintSafe(entry);
      if (footprint === null) return null;
      corners.push(footprint);
    }
    const bounds = this.measureBounds(record?.safePolygon ?? null, record?.exclusions ?? [], corners);
    if (bounds === null) return null;
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    return `${bounds.minX},${bounds.minY},${width},${height}|${bounds.minY}|${bounds.maxY}`;
  }

  /** Shared committed-geometry measure behind render + frozen viewBox. */
  private measureBounds(
    safe: { x: number; y: number }[] | null,
    exclusions: { polygon: { x: number; y: number }[] }[],
    cornerSets: GeoPoint[][],
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const all: GeoPoint[] = [
      { x: 0, y: 0 },
      ...(safe ?? []),
      ...exclusions.flatMap((entry) => entry.polygon),
    ];
    for (const set of cornerSets) {
      for (const point of set) all.push(point);
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of all) {
      if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return null;
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    if (!isFiniteNumber(minX) || !isFiniteNumber(minY) || !isFiniteNumber(maxX) || !isFiniteNumber(maxY)) {
      return null;
    }
    const pad = Math.max(maxX - minX, maxY - minY) * 0.1 + 1;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    const width = maxX - minX;
    const height = maxY - minY;
    if (!isFiniteNumber(width) || !isFiniteNumber(height) || !(width > 0) || !(height > 0)) {
      return null;
    }
    return { minX, minY, maxX, maxY };
  }

  /**
   * Committed bounds for a non-dragged region during render. Null skips the
   * svg exactly like the previous empty-geometry path.
   */
  private frozenBoxForRegion(regionId: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const ctx = this.getContext();
    const record = ctx.areas[regionId];
    const corners: GeoPoint[][] = [];
    for (const entry of Object.values(this.placements)) {
      if (entry.regionId !== regionId) continue;
      const footprint = computePlacementFootprintSafe(entry);
      if (footprint === null) return null;
      corners.push(footprint);
    }
    const bounds = this.measureBounds(record?.safePolygon ?? null, record?.exclusions ?? [], corners);
    if (bounds === null) return null;
    return bounds;
  }

  /**
   * True when the frozen svg mapping drifted: the committed-only viewBox no
   * longer matches the gesture-start snapshot (e.g. safe-area edit), so the
   * stored client→mm math is stale and the drag must abort.
   */
  private dragViewBoxStale(drag: PlacementDragState): boolean {
    const live = this.committedViewBoxFor(this.getContext(), drag.placementId);
    return live === null || live !== drag.frozenViewBox;
  }

  /**
   * Punctuation-safe footprint lookup: attribute equality over
   * `[data-placement-id]` (never a CSS selector), so restored ids with
   * quotes/backslashes/brackets can never throw or misfire.
   */
  private findFootprint(id: string): Element | null {
    const nodes = this.preview2d.querySelectorAll("[data-placement-id]");
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes.item(index);
      if (node.getAttribute("data-placement-id") === id) return node;
    }
    return null;
  }

  /**
   * Punctuation-safe region svg lookup by stable data-region-id equality.
   */
  private findRegionSvg(regionId: string): SVGSVGElement | null {
    const nodes = this.preview2d.querySelectorAll("svg[data-region-id]");
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes.item(index);
      if (node.getAttribute("data-region-id") === regionId && node instanceof SVGSVGElement) {
        return node;
      }
    }
    return null;
  }



  /**
   * Client px → region mm against the FROZEN svg mapping. Explicit
   * xMidYMid-meet letterbox math (uniform `s = min(rect.w/vb.w,
   * rect.h/vb.h)` with centred offsets, then the y-flip
   * `mmY = minY + maxY - outerY` for the inner
   * `translate(0 minY+maxY) scale(1 -1)` group, whose outer viewBox y grows
   * down while mm y grows up).
   *
   * Why explicit math instead of `getScreenCTM().inverse()`: the svg subtree
   * is rebuilt on every pointermove, so a cached CTM would go stale with
   * the detached node; re-deriving from the frozen viewBox string keeps one
   * authoritative mapping for the whole gesture without touching the live
   * DOM. Guards non-finite at every step: null on any bad input, never NaN
   * to core. No hardcoded px/mm: scale derives from rect vs frozen viewBox.
   */
  private clientToRegionMm(
    svg: SVGSVGElement,
    frozenViewBox: string,
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null {
    try {
      const parsed = this.parseFrozenViewBox(frozenViewBox);
      if (parsed === null) return null;
      const rect = svg.getBoundingClientRect();
      const vbX = parsed.x;
      const vbY = parsed.y;
      const vbW = parsed.w;
      const vbH = parsed.h;
      if (
        typeof clientX !== "number" ||
        typeof clientY !== "number" ||
        !isFiniteNumber(clientX) ||
        !isFiniteNumber(clientY) ||
        !isFiniteNumber(rect.left) ||
        !isFiniteNumber(rect.top) ||
        !isFiniteNumber(rect.width) ||
        !isFiniteNumber(rect.height) ||
        !isFiniteNumber(vbX) ||
        !isFiniteNumber(vbY) ||
        !isFiniteNumber(vbW) ||
        !isFiniteNumber(vbH) ||
        !(rect.width > 0) ||
        !(rect.height > 0) ||
        !(vbW > 0) ||
        !(vbH > 0)
      ) {
        return null;
      }
      const s = Math.min(rect.width / vbW, rect.height / vbH);
      if (!isFiniteNumber(s) || !(s > 0)) return null;
      const offX = rect.left + (rect.width - vbW * s) / 2;
      const offY = rect.top + (rect.height - vbH * s) / 2;
      const outerX = vbX + (clientX - offX) / s;
      const outerY = vbY + (clientY - offY) / s;
      if (!isFiniteNumber(outerX) || !isFiniteNumber(outerY)) return null;
      const x = outerX;
      const y = parsed.minY + parsed.maxY - outerY;
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
      return { x, y };
    } catch {
      return null;
    }
  }

  /** Parse the frozen "minX,minY,w,h|minY|maxY" gesture-start snapshot. */
  private parseFrozenViewBox(frozen: string): { x: number; y: number; w: number; h: number; minY: number; maxY: number } | null {
    const bar = frozen.indexOf("|");
    if (bar < 0) return null;
    const head = frozen.slice(0, bar);
    const tail = frozen.slice(bar + 1).split("|");
    if (tail.length !== 2) return null;
    const dims = head.split(",");
    if (dims.length !== 4) return null;
    const x = Number(dims[0]);
    const y = Number(dims[1]);
    const w = Number(dims[2]);
    const h = Number(dims[3]);
    const minY = Number(tail[0]);
    const maxY = Number(tail[1]);
    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(y) ||
      !isFiniteNumber(w) ||
      !(w > 0) ||
      !isFiniteNumber(h) ||
      !(h > 0) ||
      !isFiniteNumber(minY) ||
      !isFiniteNumber(maxY)
    ) {
      return null;
    }
    return { x, y, w, h, minY, maxY };
  }

  /**
   * Gesture start. Starting a drag REQUIRES the isReady-equivalent (fit
   * current, snapshots equal, no restore): refuse silently otherwise, since
   * there is no trustworthy mapping to grab against. Refuses while
   * `restoreBusy` (the host owns an atomic draft swap there). Wrong button,
   * non-primary, and unknown footprints are silent no-ops with no mutation.
   * preventDefault avoids unwanted text selection / touch scrolling; a
   * failed setPointerCapture refuses the gesture (no stuck transaction).
   */
  private onDragPointerDown(e: PointerEvent): void {
    if (e.isPrimary !== true || e.button !== 0) return;
    const ctx = this.getContext();
    if (ctx.restoreBusy || !this.isReady(ctx)) return;
    const target = e.target instanceof Element ? e.target : null;
    const fp = target === null ? null : target.closest("[data-placement-id]");
    const placementId = fp === null ? null : fp.getAttribute("data-placement-id");
    if (placementId === null || placementId === "") return;
    const baseline = this.placements[placementId];
    if (baseline === undefined) return;
    const region = this.regionById(ctx, baseline.regionId);
    if (region === null) return;
    // The dragged region's source evidence must be current: a calibrated
    // region whose frame predates the draft would map against a stale frame.
    if (
      ctx.draftEvidenceSnapshot === null ||
      region.sourceEvidenceSnapshot !== ctx.draftEvidenceSnapshot
    ) {
      return;
    }
    const svg = fp === null ? null : fp.closest("svg");
    if (!(svg instanceof SVGSVGElement)) return;
    const frozenViewBox = this.committedViewBoxFor(ctx, placementId);
    if (frozenViewBox === null) return;
    const pointerMm = this.clientToRegionMm(svg, frozenViewBox, e.clientX, e.clientY);
    if (pointerMm === null) return;
    const grabOffsetX = pointerMm.x - baseline.xMm;
    const grabOffsetY = pointerMm.y - baseline.yMm;
    if (!isFiniteNumber(grabOffsetX) || !isFiniteNumber(grabOffsetY)) return;
    // Capture on the stable container (see constructor comment): the svg
    // subtree is rebuilt on every move, so per-footprint capture would be
    // lost. Capture failure refuses the gesture — no stuck transaction, so
    // preventDefault only runs once capture succeeds below.
    let captured = false;
    try {
      const canQueryCapture = typeof this.preview2d.hasPointerCapture === "function";
      if (canQueryCapture && this.preview2d.hasPointerCapture(e.pointerId)) {
        captured = true;
      } else {
        this.preview2d.setPointerCapture(e.pointerId);
        captured = true;
      }
    } catch {
      captured = false;
    }
    if (!captured) return;
    e.preventDefault();
    this.activeDrag = {
      placementId,
      pointerId: e.pointerId,
      baseline: { ...baseline },
      candidateX: baseline.xMm,
      candidateY: baseline.yMm,
      grabOffsetX,
      grabOffsetY,
      generation: this.dragGeneration,
      evidenceSnapshot: ctx.draftEvidenceSnapshot,
      fitSnapshot: ctx.fitSnapshot,
      regionIds: ctx.regions.map((region) => region.regionId).join("\0"),
      assetSha: ctx.assetSha,
      fitReady: ctx.fitReady,
      fitScaleMmPerUnit: ctx.fit === null ? null : ctx.fit.scaleMmPerUnit,
      fitInconsistent: ctx.fit === null ? null : ctx.fit.inconsistent,
      fitAssetFullSha256: ctx.fit === null ? null : ctx.fit.assetFullSha256,
      selectedId: placementId,
      regionSignature: this.regionSignature(ctx),
      areaSignature: this.areaSignature(ctx),
      frozenViewBox,
    };
    this.pendingDragFocus = placementId;
    this.selectedPlacementId = placementId;
    this.hydrateEditor(baseline);
    this.render(ctx);
  }

  /** Live move: local re-render only, never `notify` (avoids host loops). */
  private onDragPointerMove(e: PointerEvent): void {
    const drag = this.activeDrag;
    if (drag === null || e.pointerId !== drag.pointerId) return;
    // The host never re-renders mid-gesture, so check the full signature
    // live here (not just at render top): stale → cancel hygiene, inert.
    const ctx = this.getContext();
    if (this.dragStale(ctx, drag) || this.dragViewBoxStale(drag)) {
      this.cancelActiveDrag("Drag cancelled (context changed during the drag); no changes applied.");
      return;
    }
    // Frozen lookup: region svg by attribute equality (never a
    // punctuation-fragile selector); mapping reads the frozen viewBox.
    const svg = this.findRegionSvg(drag.baseline.regionId);
    if (svg === null) return;
    e.preventDefault();
    const probeMm = this.clientToRegionMm(svg, drag.frozenViewBox, e.clientX, e.clientY);
    if (probeMm === null) return;
    // Full float precision in the candidate: no rounding/quantization here.
    const impliedX = probeMm.x - drag.grabOffsetX;
    const impliedY = probeMm.y - drag.grabOffsetY;
    if (!isFiniteNumber(impliedX) || !isFiniteNumber(impliedY)) return;
    // Canonical endpoint/limits gate BEFORE any display: out-of-limit
    // coordinates never reach the fields, verdicts, preview, or 3D overlay.
    // (Geometric fit is still live: invalid-but-wellformed stays red via
    // evaluatePlacement, never promoted to fits.)
    const probe = updatePlacement(
      this.placements,
      drag.placementId,
      {
        logoId: drag.baseline.logoId,
        regionId: drag.baseline.regionId,
        xMm: impliedX,
        yMm: impliedY,
        widthMm: drag.baseline.widthMm,
        heightMm: drag.baseline.heightMm,
        rotationDeg: drag.baseline.rotationDeg,
      },
      this.logos,
      ctx.regions.map((region) => region.regionId),
    );
    if (!probe.ok) return;
    const candidateX = impliedX;
    const candidateY = impliedY;
    drag.candidateX = candidateX;
    drag.candidateY = candidateY;
    // Live UX: numeric fields track the candidate (keyboard alternative
    // stays in sync); committed state is untouched until pointerup.
    this.placementX.value = String(candidateX);
    this.placementY.value = String(candidateY);
    this.pendingDragFocus = drag.placementId;
    this.render(ctx);
  }
  /**
   * Transaction end: read the FINAL event coordinates (not just the last
   * move), validated through core `updatePlacement` BEFORE display/commit so
   * malformed/out-of-limit values never crash render/geometry. Invalid stays
   * uncommitted (existing evaluatePlacement verdicts); never promoted to
   * fits. A pointerup with no preceding move still applies the down-anchored
   * candidate (baseline centre preserved through the grab offset).
   */
  private onDragPointerUp(e: PointerEvent): void {
    const drag = this.activeDrag;
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const ctx = this.getContext();
    // Stale-context commit guard (checked live: the host does not
    // re-render mid-gesture). A late pointerup after invalidation silently
    // discards the candidate — no commit, no note spam.
    if (this.dragStale(ctx, drag) || this.dragViewBoxStale(drag)) {
      this.dropActiveDrag();
      return;
    }
    const baseline = this.placements[drag.placementId];
    if (baseline === undefined) {
      this.dropActiveDrag();
      this.render(ctx);
      return;
    }
    // Final coordinates from THIS event against the frozen mapping: the
    // release point counts even when no pointermove preceded it. Mapping or
    // finite failures keep the last validated move candidate (baseline when
    // no move ever validated); an out-of-limit final point is ignored the
    // same way (candidate keeps its last good value).
    const upSvg = this.findRegionSvg(drag.baseline.regionId);
    if (upSvg !== null) {
      const finalMm = this.clientToRegionMm(upSvg, drag.frozenViewBox, e.clientX, e.clientY);
      if (finalMm !== null) {
        const finalX = finalMm.x - drag.grabOffsetX;
        const finalY = finalMm.y - drag.grabOffsetY;
        if (isFiniteNumber(finalX) && isFiniteNumber(finalY)) {
          const probe = updatePlacement(
            this.placements,
            drag.placementId,
            {
              logoId: drag.baseline.logoId,
              regionId: drag.baseline.regionId,
              xMm: finalX,
              yMm: finalY,
              widthMm: drag.baseline.widthMm,
              heightMm: drag.baseline.heightMm,
              rotationDeg: drag.baseline.rotationDeg,
            },
            this.logos,
            ctx.regions.map((region) => region.regionId),
          );
          if (probe.ok) {
            drag.candidateX = finalX;
            drag.candidateY = finalY;
          }
        }
      }
    }
    const candidate = {
      logoId: baseline.logoId,
      regionId: baseline.regionId,
      xMm: drag.candidateX,
      yMm: drag.candidateY,
      widthMm: baseline.widthMm,
      heightMm: baseline.heightMm,
      rotationDeg: baseline.rotationDeg,
    };
    if (
      ctx.restoreBusy ||
      !isFiniteNumber(candidate.xMm) ||
      !isFiniteNumber(candidate.yMm)
    ) {
      this.cancelActiveDrag(`Drag of "${drag.placementId}" was not applied: context changed during the drag.`);
      return;
    }
    const updated = updatePlacement(
      this.placements,
      drag.placementId,
      candidate,
      this.logos,
      ctx.regions.map((region) => region.regionId),
    );
    const placementId = drag.placementId;
    this.pendingDragFocus = placementId;
    this.releaseDragCapture(drag.pointerId);
    this.activeDrag = null;
    if (!updated.ok) {
      this.hydrateEditor(baseline);
      this.setNote(`Drag of "${placementId}" was not applied: ${updated.error}`);
      this.render(ctx);
      return;
    }
    this.placements = updated.placements;
    this.selectedPlacementId = placementId;
    const committed = this.placements[placementId];
    if (committed !== undefined) this.hydrateEditor(committed);
    this.setNote(`Placement "${placementId}" moved (draft only).`);
    this.notify("placements", `placement dragged ${placementId}`);
    this.render();
  }

  private onDragPointerCancel(e: PointerEvent): void {
    const drag = this.activeDrag;
    if (drag === null || e.pointerId !== drag.pointerId) return;
    this.cancelActiveDrag(`Drag of "${drag.placementId}" cancelled; no changes applied.`);
  }

  private onDragLostCapture(e: PointerEvent): void {
    // A real capture loss mid-gesture aborts like a cancel — but only for
    // the captured pointer id. Note: `lostpointercapture` also fires after
    // an intentional release, but pointerup clears activeDrag first, so this
    // is a no-op in that path.
    const drag = this.activeDrag;
    if (drag === null || e.pointerId !== drag.pointerId) return;
    this.cancelActiveDrag("Drag cancelled (pointer capture lost); no changes applied.");
  }

  private onDragKeyDown(e: KeyboardEvent): void {
    if ((e.key === "Enter" || e.key === " ") && this.activeDrag === null) {
      const target = e.target instanceof Element ? e.target : null;
      const fp = target === null ? null : target.closest("[data-placement-id]");
      const placementId = fp === null ? null : fp.getAttribute("data-placement-id");
      if (placementId !== null && placementId !== "") {
        e.preventDefault();
        this.onSelectPlacement(placementId);
        return;
      }
    }
    if (e.key === "Escape" && this.activeDrag !== null) {
      e.preventDefault();
      const id = this.activeDrag.placementId;
      this.cancelActiveDrag(`Drag of "${id}" cancelled; no changes applied.`);
    }
  }

  /**
   * Cancel path: discard candidate, hydrate numeric fields back to the
   * committed baseline, re-render, release capture safely, leave late events
   * inert. Covers Escape / pointercancel / lostpointercapture / blur / live
   * stale (move, pointerup, render top).
   */
  private cancelActiveDrag(message: string): void {
    const drag = this.activeDrag;
    if (drag === null) return;
    this.pendingDragFocus = drag.placementId;
    this.releaseDragCapture(drag.pointerId);
    this.activeDrag = null;
    const baseline = this.placements[drag.placementId];
    if (baseline !== undefined) this.hydrateEditor(baseline);
    this.setNote(message);
    this.render();
  }

  /**
   * Silent variant for render/host-swap invalidation: same hygiene as
   * cancel but without note spam, so a late pointerup stays a silent no-op.
   * Never calls render() itself — the render-top caller continues its own
   * pass on committed state, and host-swap callers render explicitly — so
   * no re-entrancy through the render-top invalidation check.
   */
  private dropActiveDrag(): void {
    const drag = this.activeDrag;
    if (drag === null) return;
    this.pendingDragFocus = drag.placementId;
    this.releaseDragCapture(drag.pointerId);
    this.activeDrag = null;
    const baseline = this.placements[drag.placementId];
    if (baseline !== undefined) this.hydrateEditor(baseline);
  }

  /** Safe capture release: try/catch + hasPointerCapture check, never throws. */
  private releaseDragCapture(pointerId: number): void {
    try {
      if (
        typeof this.preview2d.hasPointerCapture === "function" &&
        this.preview2d.hasPointerCapture(pointerId)
      ) {
        this.preview2d.releasePointerCapture(pointerId);
      }
    } catch {
      return;
    }
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
