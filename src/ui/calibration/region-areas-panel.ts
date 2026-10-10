/**
 * region-areas-panel.ts — safe mm polygons + named exclusions for authored
 * planar frames (Phase 5 slice, provisional offline draft).
 *
 * Standalone companion to panel.ts. The host panel (panel.ts) wires this in
 * and owns the shared fragment/build integration; this module never touches
 * panel.ts, fragment.html, or the build script.
 *
 * All polygon parsing, area mutation, footprint checks and bundle assembly
 * delegate to the pure core module `src/core/region-areas/index.ts`. This
 * file owns only DOM binding, enablement gating, the 2D SVG mm preview and
 * status text. Pure draft geometry only: polygons are millimetres in the
 * active region frame. No 3D overlay, no SVG→physical backconversion, no
 * pixels-as-data, no fetch/upload. All messages go through textContent.
 */

import type { CalibrationEvidence } from "../../core/calibration/index.js";
import type { GeoPoint } from "../../core/geometry/index.js";
import { stableStringify } from "../../core/calibration-session/index.js";
import {
  addExclusion,
  buildAreaBundle,
  checkFootprint,
  clearSafePolygon,
  parsePolygonText,
  pruneAreas,
  removeExclusion,
  serializeAreaBundle,
  setSafePolygon,
  type AreaExclusion,
  type AreasMap,
  type RegionAreaRecord,
} from "../../core/region-areas/index.js";
import type { PlanarRegionRecord } from "../../core/planar-region/index.js";

export type { AreaExclusion, AreasMap, GeoPoint, RegionAreaRecord };
export { AREA_BUNDLE_VERSION, AREA_LIMITS } from "../../core/region-areas/index.js";

export interface RegionAreasContext {
  regions: PlanarRegionRecord[];
  activeRegion: PlanarRegionRecord | null;
  evidence: CalibrationEvidence | null;
  fit: {
    scaleMmPerUnit: number;
    inconsistent: boolean;
    assetFullSha256: string;
  } | null;
  fitReady: boolean;
  fitSnapshot: string | null;
  draftEvidenceSnapshot: string | null;
  restoreBusy: boolean;
}

export interface RegionAreasBindOptions {
  root: ParentNode;
  getContext: () => RegionAreasContext;
  notify: (kind: "areas" | "status", message?: string) => void;
}

type AreaHookName =
  | "area-panel"
  | "area-active-label"
  | "area-context"
  | "area-safe-text"
  | "area-safe-set"
  | "area-safe-clear"
  | "area-exclusion-id"
  | "area-exclusion-name"
  | "area-exclusion-text"
  | "area-exclusion-add"
  | "area-exclusion-list"
  | "area-footprint-text"
  | "area-footprint-check"
  | "area-footprint-verdict"
  | "area-preview"
  | "area-export"
  | "area-status";

function serializePolygon(polygon: GeoPoint[] | null): string {
  if (polygon === null) return "";
  return JSON.stringify(polygon.map((p) => [p.x, p.y]));
}

export class RegionAreasPanel {
  private readonly root: ParentNode;
  private readonly getContext: () => RegionAreasContext;
  private readonly notify: (
    kind: "areas" | "status",
    message?: string,
  ) => void;

  private readonly activeLabel: HTMLElement;
  private readonly contextLine: HTMLElement;
  private readonly safeText: HTMLTextAreaElement;
  private readonly safeSetButton: HTMLButtonElement;
  private readonly safeClearButton: HTMLButtonElement;
  private readonly exclusionId: HTMLInputElement;
  private readonly exclusionName: HTMLInputElement;
  private readonly exclusionText: HTMLTextAreaElement;
  private readonly exclusionAddButton: HTMLButtonElement;
  private readonly exclusionList: HTMLElement;
  private readonly footprintText: HTMLTextAreaElement;
  private readonly footprintCheckButton: HTMLButtonElement;
  private readonly verdict: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly statusEl: HTMLElement;

  private areasByRegion: AreasMap = Object.create(null) as AreasMap;
  private previewFootprint: GeoPoint[] | null = null;
  private lastRegionId: string | null = null;
  private lastEvidenceSnapshot: string | null = null;

  private constructor(options: RegionAreasBindOptions) {
    this.root = options.root;
    this.getContext = options.getContext;
    this.notify = options.notify;
    const query = <T extends HTMLElement>(name: AreaHookName): T => {
      const found = (this.root instanceof Element
        ? this.root.querySelector<T>(`[data-area-hook="${name}"]`)
        : null) ?? document.querySelector<T>(`[data-area-hook="${name}"]`);
      if (found === null) {
        throw new Error(`region-areas fragment is missing hook "${name}"`);
      }
      return found;
    };
    this.activeLabel = query("area-active-label");
    this.contextLine = query("area-context");
    this.safeText = query<HTMLTextAreaElement>("area-safe-text");
    this.safeSetButton = query<HTMLButtonElement>("area-safe-set");
    this.safeClearButton = query<HTMLButtonElement>("area-safe-clear");
    this.exclusionId = query<HTMLInputElement>("area-exclusion-id");
    this.exclusionName = query<HTMLInputElement>("area-exclusion-name");
    this.exclusionText = query<HTMLTextAreaElement>("area-exclusion-text");
    this.exclusionAddButton = query<HTMLButtonElement>("area-exclusion-add");
    this.exclusionList = query("area-exclusion-list");
    this.footprintText = query<HTMLTextAreaElement>("area-footprint-text");
    this.footprintCheckButton =
      query<HTMLButtonElement>("area-footprint-check");
    this.verdict = query("area-footprint-verdict");
    this.preview = query("area-preview");
    this.exportButton = query<HTMLButtonElement>("area-export");
    this.statusEl = query("area-status");

    this.safeText.addEventListener("input", () => {
      this.clearVerdict();
      this.markDirty();
    });
    this.exclusionText.addEventListener("input", () => {
      this.clearVerdict();
    });
    this.footprintText.addEventListener("input", () => {
      this.clearVerdict();
      this.previewFootprint = null;
      this.renderPreview();
    });
    this.safeSetButton.addEventListener("click", () => {
      this.onSetSafe();
    });
    this.safeClearButton.addEventListener("click", () => {
      this.onClearSafe();
    });
    this.exclusionAddButton.addEventListener("click", () => {
      this.onAddExclusion();
    });
    this.footprintCheckButton.addEventListener("click", () => {
      this.onCheckFootprint();
    });
    this.exportButton.addEventListener("click", () => {
      this.onExport();
    });
    this.render();
  }

  static bind(options: RegionAreasBindOptions): RegionAreasPanel {
    return new RegionAreasPanel(options);
  }

  /** Copy of saved areas (deep copy; drafts in textareas are not included). */
  get areas(): AreasMap {
    const copy: AreasMap = Object.create(null) as AreasMap;
    for (const [key, record] of Object.entries(this.areasByRegion)) {
      copy[key] = {
        regionId: record.regionId,
        frameId: record.frameId,
        frameSnapshot: record.frameSnapshot,
        safePolygon: record.safePolygon === null ? null : record.safePolygon.map((point) => ({ x: point.x, y: point.y })),
        exclusions: record.exclusions.map((exclusion) => ({
          id: exclusion.id,
          name: exclusion.name,
          polygon: exclusion.polygon.map((point) => ({ x: point.x, y: point.y })),
        })),
      };
    }
    return copy;
  }

  /**
   * Clear every draft: pending textarea text, verdict, preview footprint,
   * and saved areas. Keeps NOTHING stale. Callers that need the saved
   * areas must retain `areas` before calling reset().
   */
  reset(): void {
    this.areasByRegion = Object.create(null) as AreasMap;
    this.previewFootprint = null;
    this.safeText.value = "";
    this.exclusionId.value = "";
    this.exclusionName.value = "";
    this.exclusionText.value = "";
    this.footprintText.value = "";
    this.clearVerdict();
    this.setStatus("");
    this.lastRegionId = this.getContext().activeRegion?.regionId ?? null;
    this.lastEvidenceSnapshot = this.getContext().draftEvidenceSnapshot;
    this.render();
  }

  /** Drop saved records whose regionId is no longer authored. */
  pruneToRegions(regions: PlanarRegionRecord[]): void {
    this.areasByRegion = pruneAreas(regions, this.areasByRegion);
    this.clearVerdict();
    this.render();
  }

  /** Host entry point: refresh enablement + labels from host state. */
  render(context?: RegionAreasContext): void {
    const ctx = context ?? this.getContext();
    const active = ctx.activeRegion;
    const activeId = active?.regionId ?? null;
    if (activeId !== this.lastRegionId) {
      const saved = this.savedRecord();
      this.safeText.value = serializePolygon(saved?.safePolygon ?? null);
      this.exclusionId.value = "";
      this.exclusionName.value = "";
      this.exclusionText.value = "";
      this.footprintText.value = "";
    }
    if (
      activeId !== this.lastRegionId ||
      ctx.draftEvidenceSnapshot !== this.lastEvidenceSnapshot
    ) {
      this.lastRegionId = activeId;
      this.lastEvidenceSnapshot = ctx.draftEvidenceSnapshot;
      this.clearVerdict();
      this.previewFootprint = null;
    }
    const enabled = this.isEnabled(ctx, active);
    if (active === null) {
      this.activeLabel.textContent = "No active region.";
      this.contextLine.textContent = "";
    } else {
      this.activeLabel.textContent =
        `Active region "${active.regionId}" (frame "${active.frameId}").`;
      const stale =
        ctx.draftEvidenceSnapshot === null ||
        ctx.draftEvidenceSnapshot !== active.sourceEvidenceSnapshot;
      this.contextLine.textContent =
        `Region ${active.regionId} · frame ${active.frameId} · ` +
        `${active.mmPerModelUnit} mm/model-unit · tolerance ±${active.offPlaneToleranceMm} mm` +
        (stale
          ? " · STALE: region evidence differs from the current draft — areas are disabled."
          : "");
    }
    for (const control of this.gatedControls()) {
      control.disabled = !enabled;
    }
    if (!enabled) {
      this.clearVerdict();
      this.previewFootprint = null;
      if (ctx.restoreBusy) {
        this.setStatus("Areas are disabled while a restore is running.");
      } else if (!ctx.fitReady) {
        this.setStatus("Areas need a current consistent fit first.");
      } else if (active === null) {
        this.setStatus("Select an active region to edit areas.");
      } else {
        this.setStatus(
          "Areas are disabled: the active region is stale for this draft.",
        );
      }
    }
    this.renderExclusionList(active);
    for (const button of this.exclusionList.querySelectorAll<HTMLButtonElement>("button")) button.disabled = !enabled;
    this.exportButton.disabled = !enabled || ctx.regions.some(region => region.sourceEvidenceSnapshot !== ctx.draftEvidenceSnapshot);
    this.markDirty();
    this.renderPreview();
  }

  /** Alias the host can call directly after host state changes. */
  setEnabledFromHost(): void {
    this.render();
  }

  private gatedControls(): Array<{ disabled: boolean }> {
    return [
      this.safeText,
      this.safeSetButton,
      this.safeClearButton,
      this.exclusionId,
      this.exclusionName,
      this.exclusionText,
      this.exclusionAddButton,
      this.footprintText,
      this.footprintCheckButton,
      this.exportButton,
      ...Array.from(
        this.exclusionList.querySelectorAll<HTMLButtonElement>("button"),
      ),
    ];
  }

  private isEnabled(
    ctx: RegionAreasContext,
    active: PlanarRegionRecord | null,
  ): boolean {
    return (
      ctx.fitReady &&
      active !== null &&
      !ctx.restoreBusy &&
      ctx.draftEvidenceSnapshot !== null &&
      ctx.draftEvidenceSnapshot === active.sourceEvidenceSnapshot
    );
  }

  private savedRecord(): RegionAreaRecord | null {
    const active = this.getContext().activeRegion;
    if (active === null) return null;
    const record = this.areasByRegion[active.regionId];
    if (record === undefined) return null;
    if (record.frameSnapshot !== stableStringify(active)) return null;
    return record;
  }

  private onSetSafe(): void {
    const ctx = this.getContext();
    const active = ctx.activeRegion;
    if (active === null || !this.isEnabled(ctx, active)) {
      this.setStatus("Set is disabled for the current host state.");
      return;
    }
    // Failure preserves prior state — assignment happens only on success.
    const result = setSafePolygon(this.areasByRegion, active, this.safeText.value);
    if (!result.ok) {
      this.setStatus(`Safe polygon was not set: ${result.error}`);
      return;
    }
    this.areasByRegion = result.areas;
    this.clearVerdict();
    this.setStatus(
      `Safe polygon set for region "${active.regionId}" (${result.polygon.length} vertices, draft only).`,
    );
    this.notify("areas", `safe set for ${active.regionId}`);
    this.render(ctx);
  }

  private onClearSafe(): void {
    const ctx = this.getContext();
    const active = ctx.activeRegion;
    if (active === null || !this.isEnabled(ctx, active)) {
      this.setStatus("Clear is disabled for the current host state.");
      return;
    }
    this.areasByRegion = clearSafePolygon(this.areasByRegion, active).areas;
    this.clearVerdict();
    this.setStatus(`Safe polygon cleared for region "${active.regionId}".`);
    this.notify("areas", `safe cleared for ${active.regionId}`);
    this.render(ctx);
  }

  private onAddExclusion(): void {
    const ctx = this.getContext();
    const active = ctx.activeRegion;
    if (active === null || !this.isEnabled(ctx, active)) {
      this.setStatus("Add is disabled for the current host state.");
      return;
    }
    const result = addExclusion(
      this.areasByRegion,
      active,
      this.exclusionId.value.trim(),
      this.exclusionName.value.trim(),
      this.exclusionText.value,
    );
    if (!result.ok) {
      this.setStatus(`Exclusion was not added: ${result.error}`);
      return;
    }
    // Each exclusion is validated individually; overlaps with safe or other
    // exclusions (or lying outside safe) are retained and documented, never
    // silently dropped — see the bundle limitations note on export.
    this.areasByRegion = result.areas;
    this.exclusionId.value = "";
    this.exclusionName.value = "";
    this.exclusionText.value = "";
    this.clearVerdict();
    this.setStatus(
      `Exclusion "${result.exclusion.id}" added to region "${active.regionId}" (draft only).`,
    );
    this.notify("areas", `exclusion added for ${active.regionId}`);
    this.render(ctx);
  }

  private onRemoveExclusion(id: string): void {
    const ctx = this.getContext();
    const active = ctx.activeRegion;
    if (active === null || !this.isEnabled(ctx, active)) {
      this.setStatus("Remove is disabled for the current host state.");
      return;
    }
    const result = removeExclusion(this.areasByRegion, active, id);
    if (!result.ok) {
      this.setStatus(`Exclusion was not removed: ${result.error}`);
      return;
    }
    this.areasByRegion = result.areas;
    this.clearVerdict();
    this.setStatus(`Exclusion "${id}" removed (draft only).`);
    this.notify("areas", `exclusion removed for ${active.regionId}`);
    this.render(ctx);
  }

  private onCheckFootprint(): void {
    const ctx = this.getContext();
    const active = ctx.activeRegion;
    if (active === null || !this.isEnabled(ctx, active)) {
      this.setStatus("Check is disabled for the current host state.");
      return;
    }
    const parsed = parsePolygonText(this.footprintText.value);
    if (!parsed.ok) {
      this.previewFootprint = null;
      this.verdict.textContent = `Footprint invalid: ${parsed.error} (draft geometry only).`;
      this.setStatus(`Footprint check failed to parse: ${parsed.error}`);
      this.renderPreview();
      return;
    }
    this.previewFootprint = parsed.polygon.map((point) => ({ x: point.x, y: point.y }));
    const result = checkFootprint(this.savedRecord(), this.footprintText.value);
    if (!result.ok) {
      this.verdict.textContent = `Footprint invalid: ${result.error} (draft geometry only).`;
      this.renderPreview();
      return;
    }
    this.verdict.textContent = result.fits
      ? `Footprint fits: ${result.reason} (draft geometry only — not placed on the model).`
      : `Footprint does not fit: ${result.reason} (draft geometry only).`;
    this.renderPreview();
  }

  private onExport(): void {
    const ctx = this.getContext();
    const active = ctx.activeRegion;
    if (active === null || !this.isEnabled(ctx, active)) {
      this.setStatus("Export is disabled for the current host state.");
      return;
    }
    if (ctx.evidence === null || ctx.fit === null || ctx.fitSnapshot === null) {
      this.setStatus("Export needs current evidence and a fit snapshot.");
      return;
    }
    // Deterministic provisional area bundle via the pure core builder: the
    // region bundle is rebuilt locally (provided fit re-verified, never
    // trusted), every area record must bind to its current frame snapshot,
    // and unconfigured frames export with safePolygon null (draft-only).
    const built = buildAreaBundle(
      ctx.evidence,
      ctx.fit,
      ctx.regions,
      this.areasByRegion,
      ctx.fitSnapshot,
    );
    if (!built.ok) {
      this.setStatus(`Area export failed: ${built.error}`);
      return;
    }
    this.downloadText(
      serializeAreaBundle(built.bundle),
      `region-areas-${this.sanitizeFileFragment(active.regionId)}-provisional-draft.json`,
    );
    this.setStatus(
      "Area bundle downloaded (provisional draft, pending review — not production-approved).",
    );
    this.notify("status", "area bundle exported");
  }

  private sanitizeFileFragment(value: string): string {
    const cleaned = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return cleaned.length > 0 ? cleaned : "draft";
  }

  private downloadText(text: string, filename: string): void {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private renderExclusionList(active: PlanarRegionRecord | null): void {
    this.exclusionList.replaceChildren();
    const record =
      active === null ? null : (this.areasByRegion[active.regionId] ?? null);
    if (record === null || record.exclusions.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "No exclusions yet.";
      this.exclusionList.appendChild(empty);
      return;
    }
    for (const exclusion of record.exclusions) {
      const item = document.createElement("li");
      item.textContent =
        `"${exclusion.id}" (${exclusion.name}, ${exclusion.polygon.length} vertices) `;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = `Remove "${exclusion.id}"`;
      remove.setAttribute("aria-label", `Remove exclusion ${exclusion.id}`);
      remove.addEventListener("click", () => {
        this.onRemoveExclusion(exclusion.id);
      });
      item.appendChild(remove);
      this.exclusionList.appendChild(item);
    }
  }

  private markDirty(): void {
    const saved = this.savedRecord()?.safePolygon ?? null;
    const dirty = this.safeText.value.trim() !== serializePolygon(saved);
    this.safeText.dataset["dirty"] = dirty ? "true" : "false";
    const note = this.root.querySelector<HTMLElement>('[data-area-hook="area-dirty-note"]');
    if (note !== null) note.textContent = dirty ? "Unsaved safe-polygon text. Preview, checks and downloads use the saved polygon; set / replace to apply edits." : "Preview, checks and downloads use the saved polygon.";
    this.safeText.setAttribute(
      "aria-label",
      dirty
        ? "Safe polygon JSON (unsaved draft edits)"
        : "Safe polygon JSON (matches saved draft)",
    );
  }

  private clearVerdict(): void {
    this.verdict.replaceChildren();
    this.previewFootprint = null;
    this.renderPreview();
  }

  private setStatus(message: string): void {
    this.statusEl.textContent = message;
  }

  private renderPreview(): void {
    const ctx = this.getContext();
    const active = ctx.activeRegion;
    const record = active === null ? null : this.savedRecord();
    const safe = record?.safePolygon ?? null;
    const exclusions = record?.exclusions ?? [];
    const footprint = this.previewFootprint;
    const svgNS = "http://www.w3.org/2000/svg";
    this.preview.replaceChildren();
    if (active === null || !this.isEnabled(ctx, active)) {
      this.preview.textContent = "Preview unavailable until the active frame has a current consistent calibration.";
      return;
    }
    if (safe === null && exclusions.length === 0 && footprint === null) {
      const empty = document.createElement("p");
      empty.textContent =
        "No saved areas yet — set a safe polygon to preview it here (mm).";
      this.preview.appendChild(empty);
      return;
    }
    const all: GeoPoint[] = [
      { x: 0, y: 0 },
      ...(safe ?? []),
      ...exclusions.flatMap((entry) => entry.polygon),
      ...(footprint ?? []),
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
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const pad = Math.max(spanX, spanY) * 0.1 + 1;
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
    // Y-flip so +Y in mm points up while SVG Y grows downward.
    flip.setAttribute(
      "transform",
      `translate(0 ${minY + maxY}) scale(1 -1)`,
    );
    const polygonEl = (
      points: GeoPoint[],
      fill: string,
      stroke: string,
      dash: string | null,
    ): SVGGraphicsElement => {
      const el = document.createElementNS(svgNS, "polygon");
      el.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
      el.setAttribute("fill", fill);
      el.setAttribute("stroke", stroke);
      el.setAttribute("stroke-width", String(Math.max(width, height) * 0.004));
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
    if (footprint !== null) {
      flip.appendChild(
        polygonEl(footprint, "none", "#1e7d32", "4 2"),
      );
    }
    // Origin marker (small cross at the region-frame origin, 0,0).
    for (const [x1, y1, x2, y2] of [
      [-1, 0, 1, 0],
      [0, -1, 0, 1],
    ] as const) {
      const scale = Math.max(width, height) * 0.02;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", String(x1 * scale));
      line.setAttribute("y1", String(y1 * scale));
      line.setAttribute("x2", String(x2 * scale));
      line.setAttribute("y2", String(y2 * scale));
      line.setAttribute("stroke", "#5b6b7b");
      line.setAttribute("stroke-width", String(Math.max(width, height) * 0.004));
      flip.appendChild(line);
    }
    svg.appendChild(flip);
    const legend = document.createElement("p");
    legend.textContent =
      "Legend: blue = safe, orange = exclusion, green dashed = draft footprint. " +
      "Cross = region-frame origin (mm, +Y up). Preview only — not to scale with the 3D view.";
    this.preview.appendChild(svg);
    this.preview.appendChild(legend);
  }
}
