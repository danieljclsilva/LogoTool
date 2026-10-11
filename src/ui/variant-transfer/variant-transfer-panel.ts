/**
 * variant-transfer-panel.ts — provisional offline variant-transfer preview
 * (Phase 7 slice, pending review).
 *
 * Owns its own DOM only. Uses the pure `transferPlacements` +
 * `serializeTransferBundle` kernel from `src/core/variant-transfer` (math is
 * never duplicated here). The host supplies the live target context plus the
 * committed placement draft; this panel never reaches the viewer/3D overlay
 * for source assets, never mutates inputs, and never calls placement
 * `replaceDraft` or viewer ports. Output is always pending-review: results
 * are preview/export only and are never applied to the target placements.
 */

import type { CalibrationEvidence } from "../../core/calibration/index.js";
import type { PlanarRegionRecord } from "../../core/planar-region/index.js";
import type { AreasMap } from "../../core/region-areas/index.js";
import type {
  LogosMap,
  PlacementsMap,
} from "../../core/logo-placements/index.js";
import { buildPlacementBundle } from "../../core/logo-placements/index.js";
import {
  serializeTransferBundle,
  transferPlacements,
  VARIANT_TRANSFER_VERSION,
  type PlacementTransferOverride,
  type RegionTransferRule,
  type TransferRequest,
  type VariantTransferBundle,
  type VariantTransferContext,
} from "../../core/variant-transfer/index.js";

/** Live target context supplied by the host on every render. */
export interface VariantTransferTargetContext {
  regions: PlanarRegionRecord[];
  areas: AreasMap;
  evidence: CalibrationEvidence | null;
  fit: {
    scaleMmPerUnit: number;
    inconsistent: boolean;
    assetFullSha256: string;
  } | null;
  fitReady: boolean;
  fitSnapshot: string | null;
  draftEvidenceSnapshot: string | null;
  assetSha: string | null;
  restoreBusy: boolean;
  dragActive: boolean;
  placementDraft: {
    logos: LogosMap;
    placements: PlacementsMap;
  };
  productLabel: string;
  variantLabel: string;
  calibrationIdLabel: string;
}

export interface VariantTransferBindOptions {
  root: ParentNode;
  getContext: () => VariantTransferTargetContext;
  notify: (kind: "transfer" | "status", message?: string) => void;
}

type TransferHookName =
  | "transfer-panel"
  | "transfer-source-status"
  | "transfer-capture-button"
  | "transfer-clear-button"
  | "transfer-target-summary"
  | "transfer-rules-text"
  | "transfer-overrides-text"
  | "transfer-run-button"
  | "transfer-status"
  | "transfer-result-list"
  | "transfer-preview"
  | "transfer-export-button";

/** Frozen source snapshot: immutable deep copies, never aliased to host state. */
interface FrozenSource {
  context: VariantTransferContext;
  logos: LogosMap;
  placements: PlacementsMap;
  sourceAssetSha: string | null;
  productLabel: string;
  variantLabel: string;
  calibrationIdLabel: string;
}

/** Stored run: bundle plus the exact signatures/texts it was computed from. */
interface StoredResult {
  bundle: VariantTransferBundle;
  sourceSig: string;
  targetSig: string;
  rulesText: string;
  overridesText: string;
}

/** Structural deep copy for plain JSON data (objects/arrays/primitives). */
function deepCopy<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) out.push(deepCopy(entry));
    return out as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const [key, entry] of Object.entries(value)) {
      out[key] = deepCopy(entry);
    }
    return out as unknown as T;
  }
  throw new Error("cannot snapshot a non-data value");
}

function stableStringifyLocal(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "nonfinite";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyLocal(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringifyLocal(record[key])}`,
    );
    return `{${parts.join(",")}}`;
  }
  return typeof value;
}

export class VariantTransferPanel {
  private readonly root: ParentNode;
  private readonly getContext: () => VariantTransferTargetContext;
  private readonly notify: (
    kind: "transfer" | "status",
    message?: string,
  ) => void;

  private readonly sourceStatus: HTMLElement;
  private readonly captureButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly targetSummary: HTMLElement;
  private readonly rulesText: HTMLTextAreaElement;
  private readonly overridesText: HTMLTextAreaElement;
  private readonly runButton: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly resultList: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly exportButton: HTMLButtonElement;

  private source: FrozenSource | null = null;
  private result: StoredResult | null = null;
  private statusText =
    "No transfer has been run yet. Capture a source snapshot, review the rules, then run (preview only).";
  private staleNote: string | null = null;

  private constructor(options: VariantTransferBindOptions) {
    this.root = options.root;
    this.getContext = options.getContext;
    this.notify = options.notify;
    const query = <T extends HTMLElement>(name: TransferHookName): T => {
      const found =
        (this.root instanceof Element
          ? this.root.querySelector<T>(`[data-transfer-hook="${name}"]`)
          : null) ??
        document.querySelector<T>(`[data-transfer-hook="${name}"]`);
      if (found === null) {
        throw new Error(`variant-transfer fragment is missing hook "${name}"`);
      }
      return found;
    };
    // Query every fixed hook up front so a renamed/missing hook fails loudly
    // instead of silently dropping panel functionality.
    query("transfer-panel");
    this.sourceStatus = query("transfer-source-status");
    this.captureButton = query<HTMLButtonElement>("transfer-capture-button");
    this.clearButton = query<HTMLButtonElement>("transfer-clear-button");
    this.targetSummary = query("transfer-target-summary");
    this.rulesText = query<HTMLTextAreaElement>("transfer-rules-text");
    this.overridesText =
      query<HTMLTextAreaElement>("transfer-overrides-text");
    this.runButton = query<HTMLButtonElement>("transfer-run-button");
    this.statusEl = query("transfer-status");
    this.resultList = query("transfer-result-list");
    this.preview = query("transfer-preview");
    this.exportButton = query<HTMLButtonElement>("transfer-export-button");

    this.captureButton.addEventListener("click", () => {
      this.onCapture();
    });
    this.clearButton.addEventListener("click", () => {
      this.onClear();
    });
    this.runButton.addEventListener("click", () => {
      this.onRun();
    });
    this.exportButton.addEventListener("click", () => {
      this.onExport();
    });
    // Rules/overrides edits immediately retire the stored run: render() runs
    // the same invalidateIfStale check, but the listener guarantees export
    // disables on the same keystroke even when the host is not re-rendering.
    const onDraftEdit = (): void => {
      if (this.result !== null) {
        this.result = null;
        this.staleNote =
          "Stale: rules or overrides text changed since the run — result discarded. Run again.";
        this.notify("status", this.staleNote);
      }
      this.render();
    };
    this.rulesText.addEventListener("input", onDraftEdit);
    this.overridesText.addEventListener("input", onDraftEdit);
    this.rulesText.addEventListener("change", onDraftEdit);
    this.overridesText.addEventListener("change", onDraftEdit);
    this.render();
  }

  static bind(options: VariantTransferBindOptions): VariantTransferPanel {
    return new VariantTransferPanel(options);
  }

  /** Host entry point: refresh from host state; invalidate stale results. */
  render(context?: VariantTransferTargetContext): void {
    const ctx = context ?? this.getContext();
    this.invalidateIfStale(ctx);
    this.renderSourceStatus();
    this.renderTargetSummary(ctx);
    this.renderStatus();
    this.renderResults();
    this.renderPreview();
    this.updateButtons(ctx);
  }

  /** Alias the host can call after asset/evidence/fit/region/area changes. */
  setEnabledFromHost(): void {
    this.render();
  }

  /** Drop the frozen source snapshot and any stored result. Always allowed. */
  clearSource(): void {
    this.onClear();
  }

  private isCurrent(ctx: VariantTransferTargetContext): boolean {
    if (!ctx.fitReady || ctx.evidence === null || ctx.fit === null) return false;
    if (ctx.fitSnapshot === null || ctx.draftEvidenceSnapshot === null) {
      return false;
    }
    if (ctx.draftEvidenceSnapshot !== ctx.fitSnapshot) return false;
    if (ctx.restoreBusy || ctx.dragActive) return false;
    // Exact asset/evidence/fit references must rebuild through the kernel:
    // a stale frame, unknown area, or malformed draft is not current.
    const built = buildPlacementBundle(
      ctx.evidence,
      {
        scaleMmPerUnit: ctx.fit.scaleMmPerUnit,
        inconsistent: ctx.fit.inconsistent,
        assetFullSha256: ctx.fit.assetFullSha256,
      },
      ctx.regions,
      ctx.areas,
      ctx.placementDraft.logos,
      ctx.placementDraft.placements,
      ctx.draftEvidenceSnapshot,
    );
    return built.ok;
  }

  private notCurrentReason(ctx: VariantTransferTargetContext): string {
    if (ctx.restoreBusy) return "a restore is running";
    if (ctx.dragActive) {
      return "a placement drag is active (source comes from the committed draft only, never a drag candidate)";
    }
    if (!ctx.fitReady || ctx.fit === null) {
      return "no current consistent fit";
    }
    if (
      ctx.evidence === null ||
      ctx.fitSnapshot === null ||
      ctx.draftEvidenceSnapshot === null
    ) {
      return "evidence, fit, or snapshots are missing";
    }
    if (ctx.draftEvidenceSnapshot !== ctx.fitSnapshot) {
      return "evidence snapshot differs from the fit snapshot";
    }
    const evidence = ctx.evidence;
    const fit = ctx.fit;
    const snapshot = ctx.draftEvidenceSnapshot;
    const built = buildPlacementBundle(
      evidence,
      {
        scaleMmPerUnit: fit.scaleMmPerUnit,
        inconsistent: fit.inconsistent,
        assetFullSha256: fit.assetFullSha256,
      },
      ctx.regions,
      ctx.areas,
      ctx.placementDraft.logos,
      ctx.placementDraft.placements,
      snapshot,
    );
    if (!built.ok) return `current placement bundle does not build: ${built.error}`;
    return "target context is not current";
  }

  private targetSignature(ctx: VariantTransferTargetContext): string {
    return stableStringifyLocal({
      areas: ctx.areas,
      assetSha: ctx.assetSha,
      calibrationIdLabel: ctx.calibrationIdLabel,
      draft: ctx.placementDraft,
      draftEvidenceSnapshot: ctx.draftEvidenceSnapshot,
      evidence: ctx.evidence,
      fit: ctx.fit,
      fitSnapshot: ctx.fitSnapshot,
      productLabel: ctx.productLabel,
      regions: ctx.regions,
      variantLabel: ctx.variantLabel,
    });
  }

  private sourceSignature(source: FrozenSource): string {
    return stableStringifyLocal({
      calibrationIdLabel: source.calibrationIdLabel,
      context: source.context,
      logos: source.logos,
      placements: source.placements,
      productLabel: source.productLabel,
      sourceAssetSha: source.sourceAssetSha,
      variantLabel: source.variantLabel,
    });
  }

  private buildTargetContext(
    ctx: VariantTransferTargetContext,
  ): VariantTransferContext {
    const evidence = ctx.evidence;
    const fit = ctx.fit;
    const draftEvidenceSnapshot = ctx.draftEvidenceSnapshot;
    if (evidence === null || fit === null || draftEvidenceSnapshot === null) {
      throw new Error("target context is not current");
    }
    return {
      product: ctx.productLabel,
      variant: ctx.variantLabel,
      evidence: deepCopy(evidence),
      fit: {
        scaleMmPerUnit: fit.scaleMmPerUnit,
        inconsistent: fit.inconsistent,
        assetFullSha256: fit.assetFullSha256,
      },
      regions: deepCopy(ctx.regions),
      areas: deepCopy(ctx.areas),
      evidenceSnapshot: draftEvidenceSnapshot,
    };
  }

  private onCapture(): void {
    const ctx = this.getContext();
    if (!this.isCurrent(ctx)) {
      // Capture failure changes no snapshot (and keeps any prior one).
      this.statusText =
        `Source snapshot was not captured: ${this.notCurrentReason(ctx)}.`;
      this.staleNote = null;
      this.notify("status", this.statusText);
      this.render(ctx);
      return;
    }
    let frozen: FrozenSource;
    try {
      const evidence = ctx.evidence;
      const fit = ctx.fit;
      const draftEvidenceSnapshot = ctx.draftEvidenceSnapshot;
      if (evidence === null || fit === null || draftEvidenceSnapshot === null) {
        throw new Error("evidence, fit, or snapshots are missing");
      }
      // Validate the FULL current placement bundle before freezing: stale
      // frames/areas or a malformed source draft must reject the capture.
      const validated = buildPlacementBundle(
        evidence,
        {
          scaleMmPerUnit: fit.scaleMmPerUnit,
          inconsistent: fit.inconsistent,
          assetFullSha256: fit.assetFullSha256,
        },
        ctx.regions,
        ctx.areas,
        ctx.placementDraft.logos,
        ctx.placementDraft.placements,
        draftEvidenceSnapshot,
      );
      if (!validated.ok) {
        throw new Error(`current placement bundle is invalid: ${validated.error}`);
      }
      const context: VariantTransferContext = {
        product: ctx.productLabel,
        variant: ctx.variantLabel,
        evidence: deepCopy(evidence),
        fit: {
          scaleMmPerUnit: fit.scaleMmPerUnit,
          inconsistent: fit.inconsistent,
          assetFullSha256: fit.assetFullSha256,
        },
        regions: deepCopy(ctx.regions),
        areas: deepCopy(ctx.areas),
        evidenceSnapshot: draftEvidenceSnapshot,
      };
      frozen = {
        context,
        logos: deepCopy(ctx.placementDraft.logos),
        placements: deepCopy(ctx.placementDraft.placements),
        sourceAssetSha: ctx.assetSha,
        productLabel: ctx.productLabel,
        variantLabel: ctx.variantLabel,
        calibrationIdLabel: ctx.calibrationIdLabel,
      };
    } catch (error) {
      this.statusText =
        `Source snapshot was not captured: ${error instanceof Error ? error.message : String(error)}.`;
      this.staleNote = null;
      this.notify("status", this.statusText);
      this.render(ctx);
      return;
    }
    this.source = frozen;
    // A new source retires any prior run: texts/signatures no longer match.
    this.result = null;
    this.staleNote = null;
    const placementCount = Object.keys(frozen.placements).length;
    this.statusText =
      `Source snapshot captured (FROZEN): ${placementCount} placement(s). ` +
      `Recapture is explicit; this snapshot survives target asset replacement.`;
    this.notify("status", this.statusText);
    this.render(ctx);
  }

  private onClear(): void {
    this.source = null;
    this.result = null;
    this.staleNote = null;
    this.statusText = "Source snapshot cleared. No transfer result is stored.";
    this.notify("status", this.statusText);
    this.render();
  }

  private parseJsonArray(
    raw: string,
    label: string,
  ): { ok: true; values: unknown[] } | { ok: false; error: string } {
    if (raw.trim().length === 0) {
      return {
        ok: false,
        error: `${label}: empty text is an explicit failure — provide a JSON array.`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, error: `${label}: invalid JSON — no partial result.` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: `${label}: must be a JSON array.` };
    }
    return { ok: true, values: parsed };
  }

  private onRun(): void {
    const ctx = this.getContext();
    const rulesText = this.rulesText.value;
    const overridesText = this.overridesText.value;
    const fail = (message: string): void => {
      // Atomic failure: no partial result is ever stored.
      this.result = null;
      this.staleNote = null;
      this.statusText = message;
      this.notify("status", message);
      this.render(ctx);
    };
    if (this.source === null) {
      fail("Transfer was not run: no frozen source snapshot — capture one first.");
      return;
    }
    if (ctx.restoreBusy || ctx.dragActive) {
      // A drag in flight invalidates even an otherwise-current context, and
      // discards any previous result on the way out.
      this.result = null;
      this.staleNote = null;
      fail(
        ctx.restoreBusy
          ? "Transfer was not run: a restore is running."
          : "Transfer was not run: a placement drag is active — finish or cancel it first (the source always comes from the committed draft).",
      );
      return;
    }
    const rulesParsed = this.parseJsonArray(rulesText, "rules");
    if (!rulesParsed.ok) {
      fail(`Transfer was not run: ${rulesParsed.error}`);
      return;
    }
    const overridesParsed = this.parseJsonArray(overridesText, "overrides");
    if (!overridesParsed.ok) {
      fail(`Transfer was not run: ${overridesParsed.error}`);
      return;
    }
    if (!this.isCurrent(ctx)) {
      fail(`Transfer was not run: target is not current (${this.notCurrentReason(ctx)}).`);
      return;
    }
    const source = this.source;
    let target: VariantTransferContext;
    try {
      target = this.buildTargetContext(ctx);
    } catch (error) {
      fail(
        `Transfer was not run: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return;
    }
    const request: TransferRequest = {
      transferVersion: VARIANT_TRANSFER_VERSION,
      source: deepCopy(source.context),
      sourceLogos: deepCopy(source.logos),
      sourcePlacements: deepCopy(source.placements),
      target,
      rules: rulesParsed.values as RegionTransferRule[],
      overrides: overridesParsed.values as PlacementTransferOverride[],
    };
    const outcome = transferPlacements(request);
    if (!outcome.ok) {
      fail(`Transfer failed: ${outcome.error}`);
      return;
    }
    this.result = {
      bundle: outcome.bundle,
      sourceSig: this.sourceSignature(source),
      targetSig: this.targetSignature(ctx),
      rulesText,
      overridesText,
    };
    this.staleNote = null;
    const count = outcome.bundle.transfers.length;
    this.statusText =
      `Transferred ${String(count)} placement(s) — pending review, never approved. ` +
      `Preview/export only; nothing was applied to the target placements. ` +
      `Numbers below are full precision; the export bytes are the serializer verbatim.`;
    this.notify("transfer", this.statusText);
    this.render(ctx);
  }

  private onExport(): void {
    const ctx = this.getContext();
    // Guard against stale contexts even when invoked without a fresh render
    // (e.g. directly changed text): re-run the invalidation before serializing.
    this.invalidateIfStale(ctx);
    if (this.result === null || this.source === null || this.staleNote !== null) {
      this.statusText =
        this.staleNote !== null
          ? `Export unavailable: ${this.staleNote}`
          : "Export unavailable: no current valid result. Run a transfer first.";
      this.notify("status", this.statusText);
      this.render(ctx);
      return;
    }
    if (!this.isCurrent(ctx)) {
      this.result = null;
      this.staleNote =
        `Stale: the target context changed (${this.notCurrentReason(ctx)}) — result discarded. Run again.`;
      this.statusText = `Export unavailable: ${this.staleNote}`;
      this.notify("status", this.statusText);
      this.render(ctx);
      return;
    }
    let text: string;
    try {
      text = serializeTransferBundle(this.result.bundle);
    } catch (error) {
      this.statusText =
        `Export failed: ${error instanceof Error ? error.message : String(error)}.`;
      this.notify("status", this.statusText);
      this.render(ctx);
      return;
    }
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `variant-transfer-${this.sanitizeFileFragment(ctx.calibrationIdLabel)}.json`;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
    this.statusText =
      "Transfer bundle exported (pending review, never approved). Export bytes are the serializer verbatim at full numeric precision.";
    this.notify("transfer", this.statusText);
    this.render(ctx);
  }

  /**
   * Invalidate the stored run on every render: restore running, drag active,
   * target signature drift, source recapture/clear, or rules/overrides edits
   * all discard the result and disable export with a stale note.
   */
  private invalidateIfStale(ctx: VariantTransferTargetContext): void {
    if (this.result === null || this.source === null) {
      if (this.result !== null) {
        this.result = null;
        this.staleNote = "Source snapshot cleared — result discarded. Run again after capturing.";
      }
      return;
    }
    const stored = this.result;
    if (ctx.restoreBusy) {
      this.result = null;
      this.staleNote = "Stale: a restore is running — result discarded. Run again when idle.";
      return;
    }
    if (ctx.dragActive) {
      this.result = null;
      this.staleNote =
        "Stale: a placement drag is active — result discarded. The source always comes from the committed draft, never a drag candidate.";
      return;
    }
    if (this.sourceSignature(this.source) !== stored.sourceSig) {
      this.result = null;
      this.staleNote = "Stale: the source snapshot changed — result discarded. Run again.";
      return;
    }
    if (this.targetSignature(ctx) !== stored.targetSig) {
      this.result = null;
      this.staleNote =
        "Stale: the target context changed (asset, evidence, fit, regions, placement draft, frame snapshots, or areas) — result discarded. Run again.";
      return;
    }
    if (
      this.rulesText.value !== stored.rulesText ||
      this.overridesText.value !== stored.overridesText
    ) {
      this.result = null;
      this.staleNote = "Stale: rules or overrides text changed since the run — result discarded. Run again.";
    }
  }

  private renderSourceStatus(): void {
    const source = this.source;
    if (source === null) {
      this.sourceStatus.textContent =
        "No source snapshot. Capturing freezes the current target context plus the committed placement draft (never any drag candidate).";
      return;
    }
    const placementCount = Object.keys(source.placements).length;
    const regionIds = source.context.regions
      .map((region) => region.regionId)
      .sort();
    const sha = source.sourceAssetSha;
    const shaPrefix = sha === null ? "unknown" : sha.slice(0, 12);
    this.sourceStatus.textContent =
      `FROZEN source "${source.productLabel}" / "${source.variantLabel}": ` +
      `${String(placementCount)} placement(s), regions [${regionIds.join(", ")}], ` +
      `asset-sha ${shaPrefix}.`;
  }

  private renderTargetSummary(ctx: VariantTransferTargetContext): void {
    const placementCount = Object.keys(ctx.placementDraft.placements).length;
    const sha = ctx.assetSha;
    const shaPrefix = sha === null ? "unknown" : sha.slice(0, 12);
    const fitText = this.isCurrent(ctx)
      ? "fit current"
      : `NOT current (${this.notCurrentReason(ctx)})`;
    this.targetSummary.textContent =
      `Target "${ctx.productLabel}" / "${ctx.variantLabel}" ` +
      `(calibration "${ctx.calibrationIdLabel}"): ` +
      `${String(ctx.regions.length)} region(s), ${String(placementCount)} committed placement(s), ` +
      `asset-sha ${shaPrefix}, ${fitText}.`;
  }

  private renderStatus(): void {
    this.statusEl.textContent = this.staleNote ?? this.statusText;
  }

  private renderResults(): void {
    this.resultList.replaceChildren();
    const stored = this.result;
    if (stored === null) {
      const empty = document.createElement("p");
      empty.textContent = this.staleNote ?? "No transfer result. Results appear here after a successful run.";
      this.resultList.appendChild(empty);
      return;
    }
    const bundle = stored.bundle;
    const note = document.createElement("p");
    note.textContent =
      "Pending review, never approved — preview only, never applied to the target placements. " +
      "Numbers below are full numeric precision.";
    this.resultList.appendChild(note);
    const byStatus: Record<string, { fits: boolean; reason: string }> = Object.create(null) as Record<
      string,
      { fits: boolean; reason: string }
    >;
    for (const status of bundle.target.statuses) {
      byStatus[status.id] = { fits: status.fits, reason: status.reason };
    }
    const list = document.createElement("ul");
    const sorted = [...bundle.transfers].sort((a, b) =>
      a.targetPlacementId < b.targetPlacementId
        ? -1
        : a.targetPlacementId > b.targetPlacementId
          ? 1
          : 0,
    );
    if (sorted.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "No placements were transferred (empty source draft).";
      list.appendChild(empty);
    }
    for (const record of sorted) {
      const verdict = byStatus[record.targetPlacementId];
      const item = document.createElement("li");
      item.textContent =
        `"${record.sourcePlacementId}" ${record.sourceRegionId} → ` +
        `"${record.targetPlacementId}" ${record.targetRegionId} via ${record.strategy}: ` +
        `x=${String(record.xMm)} y=${String(record.yMm)} ` +
        `w=${String(record.widthMm)} h=${String(record.heightMm)} ` +
        `rot=${String(record.rotationDeg)}° — ` +
        (verdict === undefined
          ? "no target verdict"
          : verdict.fits
            ? `target fits — ${verdict.reason}`
            : `target does not fit — ${verdict.reason}`);
      list.appendChild(item);
    }
    this.resultList.appendChild(list);
  }

  private renderPreview(): void {
    this.preview.replaceChildren();
    const stored = this.result;
    if (stored === null) {
      this.preview.textContent =
        "Preview unavailable: no current transfer result. Run a transfer to see the read-only target footprints.";
      return;
    }
    const bundle = stored.bundle;
    const svgNS = "http://www.w3.org/2000/svg";
    const areasByRegion: Record<
      string,
      { safe: { x: number; y: number }[] | null; exclusions: { x: number; y: number }[][] }
    > = Object.create(null) as Record<
      string,
      { safe: { x: number; y: number }[] | null; exclusions: { x: number; y: number }[][] }
    >;
    for (const area of bundle.target.areas) {
      areasByRegion[area.regionId] = {
        safe: area.safePolygon,
        exclusions: area.exclusions.map((exclusion) => exclusion.polygon),
      };
    }
    const footprintsByRegion: Record<string, { id: string; fits: boolean; points: { x: number; y: number }[] }[]> =
      Object.create(null) as Record<string, { id: string; fits: boolean; points: { x: number; y: number }[] }[]>;
    for (const status of bundle.target.statuses) {
      const placement = bundle.target.placements.find(
        (candidate) => candidate.id === status.id,
      );
      if (placement === undefined) continue;
      const list = footprintsByRegion[placement.regionId] ?? [];
      list.push({ id: status.id, fits: status.fits, points: status.footprint });
      footprintsByRegion[placement.regionId] = list;
    }
    let rendered = 0;
    for (const region of bundle.target.regions) {
      const area = areasByRegion[region.regionId];
      const safe = area?.safe ?? null;
      const exclusions = area?.exclusions ?? [];
      const footprints = footprintsByRegion[region.regionId] ?? [];
      if (safe === null && exclusions.length === 0 && footprints.length === 0) {
        continue;
      }
      rendered += 1;
      const heading = document.createElement("h3");
      heading.textContent = `Region "${region.regionId}" (mm, +Y up, read-only)`;
      this.preview.appendChild(heading);
      const bounds = measureBounds(safe, exclusions, footprints.map((entry) => entry.points));
      if (bounds === null) continue;
      const width = bounds.maxX - bounds.minX;
      const height = bounds.maxY - bounds.minY;
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", `${String(bounds.minX)} ${String(bounds.minY)} ${String(width)} ${String(height)}`);
      svg.setAttribute("role", "group");
      svg.setAttribute("aria-label", `Read-only millimetre preview of transferred footprints in region ${region.regionId}`);
      svg.setAttribute("width", "100%");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      const flip = document.createElementNS(svgNS, "g");
      flip.setAttribute("transform", `translate(0 ${String(bounds.minY + bounds.maxY)}) scale(1 -1)`);
      const polygonEl = (
        points: { x: number; y: number }[],
        fill: string,
        stroke: string,
      ): SVGPolygonElement => {
        const el = document.createElementNS(svgNS, "polygon");
        const polygon = el as SVGPolygonElement;
        polygon.setAttribute(
          "points",
          points.map((point) => `${String(point.x)},${String(point.y)}`).join(" "),
        );
        polygon.setAttribute("fill", fill);
        polygon.setAttribute("stroke", stroke);
        polygon.setAttribute("stroke-width", String(Math.max(width, height) * 0.004));
        return polygon;
      };
      if (safe !== null) {
        flip.appendChild(polygonEl(safe, "#d7e9f7", "#1d5f9e"));
      }
      for (const exclusion of exclusions) {
        flip.appendChild(polygonEl(exclusion, "#f9dfcf", "#a34a1c"));
      }
      for (const entry of footprints) {
        const fp = polygonEl(entry.points, "transparent", entry.fits ? "#1e7d32" : "#ff0000");
        fp.setAttribute("data-placement-id", entry.id);
        flip.appendChild(fp);
      }
      svg.appendChild(flip);
      this.preview.appendChild(svg);
    }
    const legend = document.createElement("p");
    legend.textContent =
      "Legend: blue = safe, orange = exclusion, green = fitting footprint, red = invalid footprint. Read-only — no drag, no 3D overlay.";
    this.preview.appendChild(legend);
    if (rendered === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No target regions with areas or footprints to preview.";
      this.preview.appendChild(empty);
    }
  }

  private updateButtons(ctx: VariantTransferTargetContext): void {
    const current = this.isCurrent(ctx);
    this.captureButton.disabled = !current;
    this.runButton.disabled = this.source === null || !current;
    this.exportButton.disabled = this.result === null || this.staleNote !== null;
    // The clear button is always enabled: dropping a snapshot or a stale
    // result must never be blocked by restore/drag/currentness state.
    this.clearButton.disabled = false;
  }

  private sanitizeFileFragment(value: string): string {
    const cleaned = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return cleaned.length > 0 ? cleaned : "draft";
  }
}

function measureBounds(
  safe: { x: number; y: number }[] | null,
  exclusions: { x: number; y: number }[][],
  footprints: { x: number; y: number }[][],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const eat = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  if (safe !== null) {
    for (const point of safe) eat(point.x, point.y);
  }
  for (const polygon of exclusions) {
    for (const point of polygon) eat(point.x, point.y);
  }
  for (const polygon of footprints) {
    for (const point of polygon) eat(point.x, point.y);
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(maxX)
  ) {
    return null;
  }
  const padX = Math.max((maxX - minX) * 0.05, 1);
  const padY = Math.max((maxY - minY) * 0.05, 1);
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}
