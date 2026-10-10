/**
 * panel.ts — offline calibration draft panel (Phase 5 partial slice).
 *
 * Frozen API:
 *   class CalibrationPanel {
 *     static bind(opts: { root: HTMLElement; viewer: () => ViewerPort | null }): CalibrationPanel;
 *     setAsset(record: AssetRecord | null): void;
 *   }
 *
 * Pick-flow choice (documented per contract): the arm button enables a
 * ONE-SHOT armed pick. A primary click on the inspector canvas with <= 6px of
 * maximum movement while armed calls viewer.pickSurface. A hit AUTO-ADDS an anchor
 * using the current anchor-ID/role fields and disarms. A miss keeps the panel
 * ARMED for retry with a status message. A hit with an empty/duplicate ID
 * stashes the picked point as pendingPick (still armed) so the operator can
 * fix the ID field and either click the model again or press "Add anchor from
 * last pick". The add-anchor button NEVER invents coordinates: it consumes
 * only the last stashed pick and reports when none exists.
 */

import { PickGesture } from "./pick-gesture.js";
import type { AssetRecord } from "../../assets/index.js";
import {
  fitUniformScale,
  validateCalibrationEvidence,
  type CalibrationEvidence,
  type UniformFitResult,
} from "../../core/calibration/index.js";
import {
  addAnchor,
  addMeasurement,
  buildEvidence,
  buildSessionExport,
  isFitCurrent,
  parseSessionRestore,
  RESTORE_LIMITS,
  removeAnchor,
  removeMeasurement,
  serializeSessionExport,
  snapshotEvidence,
  type DraftAnchor,
  type DraftMeasurement,
  type SessionFields,
} from "../../core/calibration-session/index.js";
import {
  buildRegionBundle,
  createPlanarRegion,
  isRegionStale,
  probeRegionPoint,
  regionToAxesFrame,
  serializeRegionBundle,
  type PlanarRegionRecord,
} from "../../core/planar-region/index.js";

export interface RegionAxesFrameLike {
  origin: { x: number; y: number; z: number };
  xDir: { x: number; y: number; z: number };
  yDir: { x: number; y: number; z: number };
  lengthMm: number;
  mmPerModelUnit: number;
}

export interface ViewerPort {
  pickSurface(
    clientX: number,
    clientY: number,
  ): { modelPosition: { x: number; y: number; z: number } } | null;
  setAnchorMarkers(
    anchors: Array<{ id: string; model: { x: number; y: number; z: number } }>,
  ): void;
  setRegionAxes(frame: RegionAxesFrameLike | null): void;
}

export interface CalibrationPanelOptions {
  root: HTMLElement;
  viewer: () => ViewerPort | null;
}

type HookName =
  | "panel"
  | "status"
  | "product-id"
  | "variant-id"
  | "calibration-id"
  | "frame-id"
  | "version"
  | "tolerance-mm"
  | "tolerance-relative"
  | "anchor-id"
  | "anchor-role"
  | "arm-pick"
  | "cancel-pick"
  | "add-anchor"
  | "anchor-list"
  | "measure-a"
  | "measure-b"
  | "measure-distance"
  | "add-measurement"
  | "measurement-list"
  | "fit-button"
  | "fit-result"
  | "export-button"
  | "restore-file"
  | "restore-button"
  | "region-id"
  | "region-frame-id"
  | "region-origin"
  | "region-x"
  | "region-y"
  | "region-tolerance"
  | "region-add"
  | "region-list"
  | "region-active"
  | "region-frame"
  | "region-probe"
  | "region-probe-button"
  | "region-probe-result"
  | "region-export-button";

/** Click-vs-drag threshold in CSS pixels: larger movement is a drag, ignored. */
const CLICK_MAX_MOVE_PX = 6;

export class CalibrationPanel {
  private readonly getViewer: () => ViewerPort | null;
  private readonly statusEl: HTMLElement;
  private readonly productInput: HTMLInputElement;
  private readonly variantInput: HTMLInputElement;
  private readonly calibrationInput: HTMLInputElement;
  private readonly frameInput: HTMLInputElement;
  private readonly versionInput: HTMLInputElement;
  private readonly toleranceMmInput: HTMLInputElement;
  private readonly toleranceRelativeInput: HTMLInputElement;
  private readonly anchorIdInput: HTMLInputElement;
  private readonly anchorRoleInput: HTMLInputElement;
  private readonly armButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly addAnchorButton: HTMLButtonElement;
  private readonly anchorList: HTMLElement;
  private readonly measureA: HTMLSelectElement;
  private readonly measureB: HTMLSelectElement;
  private readonly measureDistanceInput: HTMLInputElement;
  private readonly addMeasurementButton: HTMLButtonElement;
  private readonly measurementList: HTMLElement;
  private readonly fitButton: HTMLButtonElement;
  private readonly fitResult: HTMLElement;
  private readonly exportButton: HTMLButtonElement;

  private readonly restoreFile: HTMLInputElement;
  private readonly restoreButton: HTMLButtonElement;
  private readonly regionIdInput: HTMLInputElement;
  private readonly regionFrameInput: HTMLInputElement;
  private readonly regionOrigin: HTMLSelectElement;
  private readonly regionX: HTMLSelectElement;
  private readonly regionY: HTMLSelectElement;
  private readonly regionToleranceInput: HTMLInputElement;
  private readonly regionAddButton: HTMLButtonElement;
  private readonly regionList: HTMLElement;
  private readonly regionActive: HTMLSelectElement;
  private readonly regionFrame: HTMLElement;
  private readonly regionProbe: HTMLSelectElement;
  private readonly regionProbeButton: HTMLButtonElement;
  private readonly regionProbeResult: HTMLElement;
  private readonly regionExportButton: HTMLButtonElement;
  private record: AssetRecord | null = null;
  private anchors: DraftAnchor[] = [];
  private measurements: DraftMeasurement[] = [];
  private armed = false;
  private readonly gesture = new PickGesture(CLICK_MAX_MOVE_PX);
  private pendingPick: { x: number; y: number; z: number } | null = null;
  private fitEvidence: CalibrationEvidence | null = null;
  private fit: UniformFitResult | null = null;
  private fitSnapshot: string | null = null;
  private restoreSeq = 0;
  private restoreBusy = false;
  private regions: PlanarRegionRecord[] = [];
  private activeRegionId: string | null = null;

  private constructor(options: CalibrationPanelOptions) {
    this.getViewer = options.viewer;
    const query = <T extends HTMLElement>(name: HookName): T => {
      const found = options.root.querySelector<T>(
        `[data-calibration-hook="${name}"]`,
      );
      if (found === null) {
        throw new Error(
          `calibration fragment is missing hook "${name}"`,
        );
      }
      return found;
    };
    this.statusEl = query("status");
    this.productInput = query<HTMLInputElement>("product-id");
    this.variantInput = query<HTMLInputElement>("variant-id");
    this.calibrationInput = query<HTMLInputElement>("calibration-id");
    this.frameInput = query<HTMLInputElement>("frame-id");
    this.versionInput = query<HTMLInputElement>("version");
    this.toleranceMmInput = query<HTMLInputElement>("tolerance-mm");
    this.toleranceRelativeInput = query<HTMLInputElement>("tolerance-relative");
    this.anchorIdInput = query<HTMLInputElement>("anchor-id");
    this.anchorRoleInput = query<HTMLInputElement>("anchor-role");
    this.armButton = query<HTMLButtonElement>("arm-pick");
    this.cancelButton = query<HTMLButtonElement>("cancel-pick");
    this.addAnchorButton = query<HTMLButtonElement>("add-anchor");
    this.anchorList = query("anchor-list");
    this.measureA = query<HTMLSelectElement>("measure-a");
    this.measureB = query<HTMLSelectElement>("measure-b");
    this.measureDistanceInput = query<HTMLInputElement>("measure-distance");
    this.addMeasurementButton = query<HTMLButtonElement>("add-measurement");
    this.measurementList = query("measurement-list");
    this.fitButton = query<HTMLButtonElement>("fit-button");
    this.fitResult = query("fit-result");
    this.exportButton = query<HTMLButtonElement>("export-button");
    this.restoreFile = query<HTMLInputElement>("restore-file");
    this.restoreButton = query<HTMLButtonElement>("restore-button");
    this.regionIdInput = query<HTMLInputElement>("region-id");
    this.regionFrameInput = query<HTMLInputElement>("region-frame-id");
    this.regionOrigin = query<HTMLSelectElement>("region-origin");
    this.regionX = query<HTMLSelectElement>("region-x");
    this.regionY = query<HTMLSelectElement>("region-y");
    this.regionToleranceInput = query<HTMLInputElement>("region-tolerance");
    this.regionAddButton = query<HTMLButtonElement>("region-add");
    this.regionList = query("region-list");
    this.regionActive = query<HTMLSelectElement>("region-active");
    this.regionFrame = query("region-frame");
    this.regionProbe = query<HTMLSelectElement>("region-probe");
    this.regionProbeButton = query<HTMLButtonElement>("region-probe-button");
    this.regionProbeResult = query("region-probe-result");
    this.regionExportButton = query<HTMLButtonElement>("region-export-button");

    for (const input of [this.productInput, this.variantInput, this.calibrationInput,
      this.frameInput, this.versionInput, this.toleranceMmInput, this.toleranceRelativeInput]) {
      input.addEventListener("input", () => this.render());
    }
    this.regionProbe.addEventListener("change", () => this.regionProbeResult.replaceChildren());
    this.regionAddButton.addEventListener("click", () => {
      this.onAddRegion();
    });
    this.regionActive.addEventListener("change", () => {
      this.regionProbeResult.replaceChildren();
      this.activeRegionId = this.regionActive.value === "" ? null : this.regionActive.value;
      this.syncRegionAxes();
      this.render();
    });
    this.regionProbeButton.addEventListener("click", () => {
      this.onProbeRegion();
    });
    this.regionExportButton.addEventListener("click", () => {
      this.onExportRegions();
    });
    this.armButton.addEventListener("click", () => {
      this.onArm();
    });
    this.cancelButton.addEventListener("click", () => {
      this.onCancelPick();
    });
    this.addAnchorButton.addEventListener("click", () => {
      this.onAddAnchorFromPick();
    });
    this.addMeasurementButton.addEventListener("click", () => {
      this.onAddMeasurement();
    });
    this.fitButton.addEventListener("click", () => {
      this.onFit();
    });
    this.exportButton.addEventListener("click", () => {
      this.onExport();
    });
    this.restoreButton.addEventListener("click", () => {
      void this.onRestore();
    });
    const canvas = document.querySelector(
      '[data-inspector-hook="canvas"]',
    );
    if (canvas !== null) {
      canvas.addEventListener('pointerdown', event => {this.gesture.begin(event as PointerEvent);});
      canvas.addEventListener('pointermove', event => {this.gesture.move(event as PointerEvent);});
      canvas.addEventListener('pointercancel', () => {this.gesture.cancel();});
      canvas.addEventListener('pointerup', event => {
        const pointer = event as PointerEvent;
        if (this.gesture.finish(pointer)) this.onCanvasPointerUp(pointer.clientX, pointer.clientY);
      });
    }
    this.render();
  }

  static bind(options: CalibrationPanelOptions): CalibrationPanel {
    return new CalibrationPanel(options);
  }

  setAsset(record: AssetRecord | null): void {
    this.restoreSeq += 1;
    this.restoreBusy = false;
    this.record = record;
    this.anchors = [];
    this.measurements = [];
    this.armed = false;
    this.gesture.cancel();
    this.pendingPick = null;
    this.fitEvidence = null;
    this.fit = null;
    this.fitSnapshot = null;
    this.regions = [];
    this.activeRegionId = null;
    this.regionIdInput.value = "";
    this.regionFrameInput.value = "";
    this.regionToleranceInput.value = "";
    this.regionProbeResult.replaceChildren();
    this.productInput.value = "";
    this.variantInput.value = "";
    this.calibrationInput.value = "";
    this.frameInput.value = "";
    this.versionInput.value = "";
    this.toleranceMmInput.value = "0.5";
    this.toleranceRelativeInput.value = "0.01";
    this.anchorIdInput.value = "";
    this.anchorRoleInput.value = "";
    this.measureDistanceInput.value = "";
    this.restoreFile.value = "";
    const viewer = this.getViewer();
    if (viewer !== null) {
      viewer.setAnchorMarkers([]);
      viewer.setRegionAxes(null);
    }
    this.setStatus(
      record === null
        ? "No asset loaded. Calibration draft is empty."
        : "Asset loaded. Fresh calibration draft: pick anchors on the model.",
    );
    this.render();
  }

  private setStatus(message: string): void {
    this.statusEl.textContent = message;
  }

  private onArm(): void {
    if (this.record === null) {
      this.setStatus("Load an asset before picking anchors.");
      return;
    }
    this.pendingPick = null;
    this.gesture.cancel();
    this.armed = true;
    this.setStatus(
      "Pick armed: click a point on the model surface (dragging is ignored).",
    );
    this.render();
  }

  private onCancelPick(): void {
    this.pendingPick = null;
    this.armed = false;
    this.gesture.cancel();
    this.setStatus("Pick cancelled.");
    this.render();
  }

  private onCanvasPointerUp(clientX: number, clientY: number): void {
    if (!this.armed || this.restoreBusy) return;
    if (this.record === null) {
      this.armed = false;
      this.setStatus("Pick disarmed: no asset loaded.");
      this.render();
      return;
    }
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      this.gesture.cancel();
      return;
    }
    const viewer = this.getViewer();
    if (viewer === null) {
      this.setStatus("Pick failed: viewer is unavailable. Still armed.");
      this.render();
      return;
    }
    let hit: {
      modelPosition: { x: number; y: number; z: number };
    } | null;
    try {
      hit = viewer.pickSurface(clientX, clientY);
    } catch {
      this.setStatus("Pick failed: viewer error. Still armed for retry.");
      this.render();
      return;
    }
    if (hit === null) {
      this.setStatus("Pick missed the model surface. Still armed for retry.");
      this.render();
      return;
    }
    const point = hit.modelPosition;
    if (
      typeof point.x !== "number" ||
      typeof point.y !== "number" ||
      typeof point.z !== "number" ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(point.z)
    ) {
      this.setStatus("Pick returned a non-finite point. Still armed.");
      this.render();
      return;
    }
    const id = this.anchorIdInput.value.trim();
    const role = this.anchorRoleInput.value.trim();
    const attempt = addAnchor(this.anchors, {
      id,
      model: { x: point.x, y: point.y, z: point.z },
      ...(role.length > 0 ? { semanticRole: role } : {}),
    });
    if (!attempt.ok) {
      this.pendingPick = { x: point.x, y: point.y, z: point.z };
      this.setStatus(
        `Surface hit at (${point.x}, ${point.y}, ${point.z}) but anchor was not added: ${attempt.error}. Fix the anchor ID, then click again or press "Add anchor from last pick". Still armed.`,
      );
      this.render();
      return;
    }
    this.anchors = attempt.anchors;
    this.pendingPick = null;
    this.armed = false;
    this.anchorIdInput.value = "";
    this.syncMarkers();
    this.setStatus(`Anchor "${id}" added from surface pick.`);
    this.render();
  }

  private onAddAnchorFromPick(): void {
    if (this.record === null) {
      this.setStatus("Load an asset before adding anchors.");
      return;
    }
    if (this.pendingPick === null) {
      this.setStatus(
        "No picked point yet: arm a pick and click the model surface first.",
      );
      return;
    }
    const id = this.anchorIdInput.value.trim();
    const role = this.anchorRoleInput.value.trim();
    const attempt = addAnchor(this.anchors, {
      id,
      model: {
        x: this.pendingPick.x,
        y: this.pendingPick.y,
        z: this.pendingPick.z,
      },
      ...(role.length > 0 ? { semanticRole: role } : {}),
    });
    if (!attempt.ok) {
      this.setStatus(`Anchor was not added: ${attempt.error}.`);
      this.render();
      return;
    }
    this.anchors = attempt.anchors;
    this.pendingPick = null;
    this.armed = false;
    this.anchorIdInput.value = "";
    this.syncMarkers();
    this.setStatus(`Anchor "${id}" added from last pick.`);
    this.render();
  }

  private onRemoveAnchor(id: string): void {
    const next = removeAnchor(this.anchors, this.measurements, id);
    this.anchors = next.anchors;
    this.measurements = next.measurements;
    this.regions = this.regions.filter(
      (region) =>
        region.originAnchorId !== id &&
        region.xAnchorId !== id &&
        region.yAnchorId !== id,
    );
    if (this.activeRegionId !== null && !this.regions.some((region) => region.regionId === this.activeRegionId)) {
      this.activeRegionId = null;
    }
    this.syncMarkers();
    this.syncRegionAxes();
    this.setStatus(
      `Anchor "${id}" removed with its referencing measurements and regions.`,
    );
    this.render();
  }

  private onAddMeasurement(): void {
    if (this.record === null) {
      this.setStatus("Load an asset before adding measurements.");
      return;
    }
    const a = this.measureA.value;
    const b = this.measureB.value;
    const distanceMm = Number(this.measureDistanceInput.value);
    const attempt = addMeasurement(this.measurements, this.anchors, {
      a,
      b,
      distanceMm,
    });
    if (!attempt.ok) {
      this.setStatus(`Measurement was not added: ${attempt.error}.`);
      this.render();
      return;
    }
    this.measurements = attempt.measurements;
    this.measureDistanceInput.value = "";
    this.setStatus(`Measurement "${a}" to "${b}" added (${distanceMm} mm).`);
    this.render();
  }

  private onRemoveMeasurement(index: number): void {
    this.measurements = removeMeasurement(this.measurements, index);
    this.setStatus("Measurement removed.");
    this.render();
  }

  private readFields(): SessionFields | { error: string } {
    if (this.record === null) {
      return { error: "no asset loaded" };
    }
    if (this.toleranceMmInput.value.trim() === '' || this.toleranceRelativeInput.value.trim() === '') {
      return {error: 'enter both absolute and relative tolerances explicitly'};
    }
    const toleranceMm = Number(this.toleranceMmInput.value);
    const relativeTolerance = Number(this.toleranceRelativeInput.value);
    if (!Number.isFinite(toleranceMm) || toleranceMm < 0) {
      return { error: "absolute tolerance must be a finite number >= 0 (mm)" };
    }
    if (!Number.isFinite(relativeTolerance) || relativeTolerance < 0) {
      return {
        error: "relative tolerance must be a finite fraction >= 0 (not %)",
      };
    }
    return {
      product: this.productInput.value.trim(),
      variant: this.variantInput.value.trim(),
      calibrationId: this.calibrationInput.value.trim(),
      frameId: this.frameInput.value.trim(),
      provisionalVersion: this.versionInput.value.trim(),
      toleranceMm,
      relativeTolerance,
      assetFullSha256: this.record.sha256Hex,
    };
  }

  private onFit(): void {
    if (this.record === null) {
      this.setStatus("Load an asset before fitting.");
      return;
    }
    const fields = this.readFields();
    if ("error" in fields) {
      this.fitEvidence = null;
      this.fit = null;
      this.fitSnapshot = null;
      this.setStatus(`Fit failed: ${fields.error}.`);
      this.render();
      return;
    }
    const built = buildEvidence(fields, this.anchors, this.measurements);
    if (!built.ok) {
      this.fitEvidence = null;
      this.fit = null;
      this.fitSnapshot = null;
      this.setStatus(`Fit failed: ${built.error}.`);
      this.render();
      return;
    }
    const validation = validateCalibrationEvidence(built.evidence);
    if (!validation.ok) {
      this.fitEvidence = null;
      this.fit = null;
      this.fitSnapshot = null;
      this.setStatus(`Fit failed: ${validation.errors.join("; ")}.`);
      this.render();
      return;
    }
    let result: UniformFitResult;
    try {
      result = fitUniformScale(built.evidence);
    } catch (error) {
      this.fitEvidence = null;
      this.fit = null;
      this.fitSnapshot = null;
      this.setStatus(
        `Fit failed: ${error instanceof Error ? error.message : String(error)}.`,
      );
      this.render();
      return;
    }
    this.fitEvidence = built.evidence;
    this.fit = result;
    this.fitSnapshot = snapshotEvidence(built.evidence);
    this.syncRegionAxes();
    this.setStatus(
      result.inconsistent
        ? "Fit completed but is INCONSISTENT: residuals exceed tolerance. Pending review, never approved."
        : "Fit completed. Pending review, never approved.",
    );
    this.render();
  }

  private draftEvidence(): CalibrationEvidence | null {
    const fields = this.readFields();
    if ("error" in fields) return null;
    const built = buildEvidence(fields, this.anchors, this.measurements);
    return built.ok ? built.evidence : null;
  }

  private isExportable(): boolean {
    if (
      this.record === null ||
      this.fit === null ||
      this.fitEvidence === null
    ) {
      return false;
    }
    return isFitCurrent(this.draftEvidence(), this.fitSnapshot);
  }

  private onExport(): void {
    if (!this.isExportable()) {
      this.setStatus(
        "Export unavailable: fit is missing or stale. Refit before exporting.",
      );
      this.render();
      return;
    }
    if (this.fitEvidence === null || this.fit === null) return;
    const session = buildSessionExport(this.fitEvidence, this.fit);
    const text = serializeSessionExport(session);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `calibration-session-${this.sanitizeFileFragment(this.fitEvidence.calibrationId)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    this.setStatus(
      this.fit.inconsistent
        ? "Exported inconsistent fit as pending review (never approved)."
        : "Exported pending-review session JSON.",
    );
  }

  private async onRestore(): Promise<void> {
    if (this.restoreBusy) return;
    if (this.record === null) {
      this.setStatus("Load an asset before restoring a session.");
      return;
    }
    const files = this.restoreFile.files;
    const file = files !== null && files.length > 0 ? files[0] : undefined;
    if (file === undefined) {
      this.setStatus("No file selected: choose a calibration session JSON file first.");
      return;
    }
    if (file.size > RESTORE_LIMITS.maxBytes) {
      this.restoreFile.value = "";
      this.setStatus(`Restore failed: file exceeds ${RESTORE_LIMITS.maxBytes} bytes.`);
      return;
    }
    const seq = ++this.restoreSeq;
    const loadRecord = this.record;
    const loadSha = loadRecord.sha256Hex;
    this.restoreBusy = true;
    this.render();
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (seq !== this.restoreSeq || this.record !== loadRecord) return;
      this.restoreBusy = false;
      this.restoreFile.value = "";
      this.setStatus("Restore failed: could not read the selected file.");
      this.render();
      return;
    }
    if (seq !== this.restoreSeq || this.record !== loadRecord) return;
    const parsed = parseSessionRestore(text, loadSha);
    if (!parsed.ok) {
      this.restoreBusy = false;
      this.restoreFile.value = "";
      this.setStatus(`Restore failed: ${parsed.error}.`);
      this.render();
      return;
    }
    const draft = parsed.draft;
    const built = buildEvidence(draft.fields, draft.anchors, draft.measurements);
    if (!built.ok) {
      this.restoreBusy = false;
      this.restoreFile.value = "";
      this.setStatus(`Restore failed: ${built.error}.`);
      this.render();
      return;
    }
    const validation = validateCalibrationEvidence(built.evidence);
    if (!validation.ok) {
      this.restoreBusy = false;
      this.restoreFile.value = "";
      this.setStatus(`Restore failed: ${validation.errors.join("; ")}.`);
      this.render();
      return;
    }
    let result: UniformFitResult;
    try {
      result = fitUniformScale(built.evidence);
    } catch (error) {
      this.restoreBusy = false;
      this.restoreFile.value = "";
      this.setStatus(`Restore failed: ${error instanceof Error ? error.message : String(error)}.`);
      this.render();
      return;
    }
    this.anchors = [...draft.anchors];
    this.measurements = [...draft.measurements];
    this.productInput.value = draft.fields.product;
    this.variantInput.value = draft.fields.variant;
    this.calibrationInput.value = draft.fields.calibrationId;
    this.frameInput.value = draft.fields.frameId;
    this.versionInput.value = draft.fields.provisionalVersion;
    this.toleranceMmInput.value = String(draft.fields.toleranceMm);
    this.toleranceRelativeInput.value = String(draft.fields.relativeTolerance);
    this.anchorIdInput.value = "";
    this.anchorRoleInput.value = "";
    this.measureDistanceInput.value = "";
    this.armed = false;
    this.gesture.cancel();
    this.pendingPick = null;
    this.fitEvidence = built.evidence;
    this.fit = result;
    this.fitSnapshot = snapshotEvidence(built.evidence);
    this.regions = [];
    this.activeRegionId = null;
    this.regionIdInput.value = "";
    this.regionFrameInput.value = "";
    this.regionToleranceInput.value = "";
    this.regionProbeResult.replaceChildren();
    this.syncMarkers();
    this.syncRegionAxes();
    this.restoreBusy = false;
    this.restoreFile.value = "";
    this.render();
    this.setStatus(
      result.inconsistent
        ? "Session restored: fit recomputed locally but is INCONSISTENT. Pending review, never approved."
        : "Session restored: fit recomputed locally. Pending review, never approved.",
    );
  }

  private sanitizeFileFragment(value: string): string {
    const cleaned = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return cleaned.length > 0 ? cleaned : "draft";
  }

  private syncMarkers(): void {
    const viewer = this.getViewer();
    if (viewer === null) return;
    viewer.setAnchorMarkers(
      this.anchors.map((anchor) => ({
        id: anchor.id,
        model: {
          x: anchor.model.x,
          y: anchor.model.y,
          z: anchor.model.z,
        },
      })),
    );
  }
  private activeRegion(): PlanarRegionRecord | null {
    if (this.activeRegionId === null) return null;
    return this.regions.find((region) => region.regionId === this.activeRegionId) ?? null;
  }

  private isRegionFitReady(): boolean {
    if (this.fit === null || this.fitEvidence === null || this.fitSnapshot === null) return false;
    if (this.fit.inconsistent) return false;
    return isFitCurrent(this.draftEvidence(), this.fitSnapshot);
  }

  private isActiveRegionReady(): boolean {
    const active = this.activeRegion();
    const evidence = this.draftEvidence();
    return !this.restoreBusy && this.isRegionFitReady() && active !== null &&
      evidence !== null && !isRegionStale(active, snapshotEvidence(evidence));
  }

  private onAddRegion(): void {
    if (this.record === null) {
      this.setStatus("Load an asset before adding planar regions.");
      return;
    }
    if (!this.isRegionFitReady()) {
      this.setStatus("Region not added: need a current CONSISTENT fit first. Fit (or refit) before authoring regions.");
      this.render();
      return;
    }
    const regionId = this.regionIdInput.value.trim();
    const frameId = this.regionFrameInput.value.trim();
    if (regionId === "" || frameId === "") {
      this.setStatus("Region not added: enter a region ID and a region frame ID.");
      this.render();
      return;
    }
    if (this.regions.some((region) => region.regionId === regionId)) {
      this.setStatus(`Region not added: duplicate region ID "${regionId}".`);
      this.render();
      return;
    }
    if (this.regions.some(region => region.frameId === frameId)) {
      this.setStatus(`Region not added: duplicate frame ID "${frameId}".`);
      return;
    }
    if (this.regionToleranceInput.value.trim() === "") {
      this.setStatus("Region not added: enter the off-plane tolerance in mm explicitly.");
      this.render();
      return;
    }
    const offPlaneToleranceMm = Number(this.regionToleranceInput.value);
    if (!Number.isFinite(offPlaneToleranceMm) || offPlaneToleranceMm < 0) {
      this.setStatus("Region not added: off-plane tolerance must be a finite number >= 0 (mm).");
      this.render();
      return;
    }
    if (this.fitEvidence === null || this.fitSnapshot === null) {
      this.setStatus("Region not added: fit evidence is missing. Refit first.");
      this.render();
      return;
    }
    const created = createPlanarRegion(
      {
        regionId,
        frameId,
        originAnchorId: this.regionOrigin.value,
        xAnchorId: this.regionX.value,
        yAnchorId: this.regionY.value,
        offPlaneToleranceMm,
      },
      this.anchors.map((anchor) => ({ id: anchor.id, model: { ...anchor.model } })),
      this.fitEvidence,
      this.fitSnapshot,
    );
    if (!created.ok) {
      this.setStatus(`Region not added: ${created.error}.`);
      this.render();
      return;
    }
    this.regions = [...this.regions, created.region].sort((a, b) =>
      a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0,
    );
    this.activeRegionId = created.region.regionId;
    this.regionIdInput.value = "";
    this.regionFrameInput.value = "";
    this.syncRegionAxes();
    this.setStatus(`Planar region "${regionId}" added (pending review, never approved).`);
    this.render();
  }

  private onRemoveRegion(regionId: string): void {
    this.regions = this.regions.filter((region) => region.regionId !== regionId);
    if (this.activeRegionId === regionId) this.activeRegionId = null;
    this.syncRegionAxes();
    this.setStatus(`Planar region "${regionId}" removed. Recreate it against the current fit if still needed.`);
    this.render();
  }

  private onProbeRegion(): void {
    const active = this.activeRegion();
    if (active === null) {
      this.regionProbeResult.textContent = "No active region: add a region and select it first.";
      return;
    }
    if (!this.isActiveRegionReady()) {
      this.regionProbeResult.textContent = "Probe unavailable: region or calibration is stale. Refit and recreate the region.";
      return;
    }
    const anchor = this.anchors.find((entry) => entry.id === this.regionProbe.value);
    if (anchor === undefined) {
      this.regionProbeResult.textContent = "Probe failed: choose an existing anchor.";
      return;
    }
    const probed = probeRegionPoint(active, { ...anchor.model });
    if ("error" in probed) {
      this.regionProbeResult.textContent =
        `Anchor "${anchor.id}" is off-plane: ${probed.error} (tolerance ${active.offPlaneToleranceMm} mm).`;
      return;
    }
    this.regionProbeResult.textContent =
      `Anchor "${anchor.id}" in frame "${active.frameId}": ` +
      `x ${probed.point.x} mm, y ${probed.point.y} mm, off-plane ${probed.offPlaneMm} mm.`;
  }

  private onExportRegions(): void {
    if (this.record === null || this.fit === null || this.fitEvidence === null || this.fitSnapshot === null) {
      this.setStatus("Region export unavailable: fit is missing. Fit a consistent scale first.");
      this.render();
      return;
    }
    if (this.fit.inconsistent) {
      this.setStatus("Region export unavailable: fit is INCONSISTENT. Refit before exporting.");
      this.render();
      return;
    }
    if (!isFitCurrent(this.draftEvidence(), this.fitSnapshot)) {
      this.setStatus("Region export unavailable: fit is STALE or evidence changed. Refit before exporting.");
      this.render();
      return;
    }
    if (this.regions.length === 0) {
      this.setStatus("Region export unavailable: no planar regions authored yet.");
      this.render();
      return;
    }
    const snapshot = this.fitSnapshot;
    const stale = this.regions.filter((region) => isRegionStale(region, snapshot));
    if (stale.length > 0) {
      this.setStatus(
        `Region export unavailable: ${stale.length} stale region(s) (${stale.map((region) => region.regionId).join(", ")}). Remove and recreate them against the current fit.`,
      );
      this.render();
      return;
    }
    const built = buildRegionBundle(this.fitEvidence, this.fit, this.regions, snapshot);
    if (!built.ok) {
      this.setStatus(`Region export failed: ${built.error}.`);
      this.render();
      return;
    }
    const text = serializeRegionBundle(built.bundle);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `planar-regions-${this.sanitizeFileFragment(this.fitEvidence.calibrationId)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    this.setStatus("Exported provisional planar region bundle (pending review, never approved).");
  }

  private syncRegionAxes(): void {
    const viewer = this.getViewer();
    if (viewer === null) return;
    const active = this.activeRegion();
    if (active === null || !this.isActiveRegionReady()) {
      viewer.setRegionAxes(null);
      return;
    }
    viewer.setRegionAxes(regionToAxesFrame(active));
  }


  private render(): void {
    const enabled = this.record !== null && !this.restoreBusy;
    for (const input of [
      this.productInput,
      this.variantInput,
      this.calibrationInput,
      this.frameInput,
      this.versionInput,
      this.toleranceMmInput,
      this.toleranceRelativeInput,
      this.anchorIdInput,
      this.anchorRoleInput,
      this.measureDistanceInput,
    ]) {
      input.disabled = !enabled;
    }
    for (const button of [
      this.armButton,
      this.cancelButton,
      this.addAnchorButton,
      this.addMeasurementButton,
      this.fitButton,
    ]) {
      button.disabled = !enabled;
    }
    this.measureA.disabled = !enabled;
    this.measureB.disabled = !enabled;
    this.regionOrigin.disabled = !enabled;
    this.regionX.disabled = !enabled;
    this.regionY.disabled = !enabled;
    this.regionActive.disabled = !enabled || this.regions.length === 0;
    this.regionProbe.disabled = !enabled || this.activeRegion() === null;
    this.renderAnchors(enabled);
    this.renderMeasurements(enabled);
    this.renderRegions(enabled);
    this.armButton.setAttribute("aria-pressed", String(this.armed));
    this.addAnchorButton.disabled = !enabled || this.pendingPick === null;
    this.cancelButton.disabled = !enabled || (!this.armed && this.pendingPick === null);
    this.restoreButton.disabled = this.record === null || this.restoreBusy;
    this.restoreFile.disabled = this.record === null || this.restoreBusy;
    this.regionIdInput.disabled = !enabled;
    this.regionFrameInput.disabled = !enabled;
    this.regionToleranceInput.disabled = !enabled;
    this.regionAddButton.disabled = !enabled;
    this.regionProbeButton.disabled = !enabled || !this.isActiveRegionReady();
    this.syncRegionAxes();
    if (!this.isActiveRegionReady()) this.regionProbeResult.replaceChildren();
    this.renderFit();
    if (this.restoreBusy) {
      this.exportButton.disabled = true;
      this.regionExportButton.disabled = true;
    }
    this.syncRegionAxes();
  }
  private renderAnchors(enabled: boolean): void {
    const selectedA = this.measureA.value, selectedB = this.measureB.value;
    this.anchorList.replaceChildren();
    this.measureA.replaceChildren();
    this.measureB.replaceChildren();
    const ordered = [...this.anchors].sort((x, y) =>
      x.id < y.id ? -1 : x.id > y.id ? 1 : 0,
    );
    for (const anchor of ordered) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent =
        `id "${anchor.id}" at (${anchor.model.x}, ${anchor.model.y}, ${anchor.model.z})` +
        (anchor.semanticRole !== undefined
          ? ` role "${anchor.semanticRole}"`
          : "");
      item.appendChild(label);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.disabled = !enabled;
      remove.addEventListener("click", () => {
        this.onRemoveAnchor(anchor.id);
      });
      item.appendChild(remove);
      this.anchorList.appendChild(item);
      for (const select of [this.measureA, this.measureB]) {
        const option = document.createElement("option");
        option.value = anchor.id;
        option.textContent = anchor.id;
        select.appendChild(option);
      }
    }
    if (ordered.some(anchor => anchor.id === selectedA)) this.measureA.value = selectedA;
    if (ordered.some(anchor => anchor.id === selectedB)) this.measureB.value = selectedB;
    else if (ordered.length > 1) this.measureB.value = ordered[1]!.id;
    if (ordered.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "No anchors yet.";
      this.anchorList.appendChild(empty);
    }
  }

  private renderMeasurements(enabled: boolean): void {
    this.measurementList.replaceChildren();
    this.measurements.forEach((measurement, index) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `"${measurement.a}" to "${measurement.b}": ${measurement.distanceMm} mm`;
      item.appendChild(label);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.disabled = !enabled;
      remove.addEventListener("click", () => {
        this.onRemoveMeasurement(index);
      });
      item.appendChild(remove);
      this.measurementList.appendChild(item);
    });
    if (this.measurements.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "No known-distance measurements yet.";
      this.measurementList.appendChild(empty);
    }
  }

  private renderFit(): void {
    this.fitResult.replaceChildren();
    if (this.fit === null || this.fitEvidence === null) {
      const empty = document.createElement("p");
      empty.textContent =
        this.record === null
          ? "No fit: load an asset first."
          : "No current fit. Add anchors and a known distance, then press Fit.";
      this.fitResult.appendChild(empty);
      this.exportButton.disabled = true;
      return;
    }
    const current = isFitCurrent(this.draftEvidence(), this.fitSnapshot);
    const heading = document.createElement("p");
    heading.textContent = current
      ? `Fit is current: scale ${this.fit.scaleMmPerUnit} mm per model unit.`
      : "Fit is STALE: anchors, measurements, or fields changed. Refit before exporting.";
    this.fitResult.appendChild(heading);
    const flags = document.createElement("p");
    flags.textContent =
      "Pending internal review; not production approved. " +
      (this.fit.inconsistent
        ? "INCONSISTENT: residuals exceed tolerance (pending review only)."
        : "consistent within tolerance (still pending review, never approved).");
    this.fitResult.appendChild(flags);
    const list = document.createElement("ul");
    for (const row of this.fit.perPair) {
      const item = document.createElement("li");
      const absolute = Math.abs(row.residualMm);
      item.textContent =
        `"${row.pairIds[0]}" to "${row.pairIds[1]}": ` +
        `model span ${row.modelDistance} units; measured ${row.measuredDistanceMm} mm; ` +
        `predicted ${row.predictedDistanceMm} mm; signed error ${row.residualMm} mm; ` +
        `absolute error ${absolute} mm`;
      list.appendChild(item);
    }
    this.fitResult.appendChild(list);
    const summary = document.createElement("p");
    summary.textContent =
      `Max absolute error ${this.fit.maxResidualMm} mm; ` +
      `tolerance ${this.fit.toleranceMm} mm absolute / ${this.fit.relativeTolerance} fraction.`;
    this.fitResult.appendChild(summary);
    this.exportButton.disabled = !this.isExportable();
  }
  private renderRegions(enabled: boolean): void {
    const keepOrigin = this.regionOrigin.value;
    const keepX = this.regionX.value;
    const keepY = this.regionY.value;
    const keepActive = this.regionActive.value;
    const keepProbe = this.regionProbe.value;
    this.regionOrigin.replaceChildren();
    this.regionX.replaceChildren();
    this.regionY.replaceChildren();
    this.regionProbe.replaceChildren();
    for (const anchor of this.anchors) {
      for (const select of [this.regionOrigin, this.regionX, this.regionY, this.regionProbe]) {
        const option = document.createElement("option");
        option.value = anchor.id;
        option.textContent = anchor.id;
        select.appendChild(option);
      }
    }
    if (this.anchors.some((anchor) => anchor.id === keepOrigin)) this.regionOrigin.value = keepOrigin;
    if (this.anchors.some((anchor) => anchor.id === keepX)) this.regionX.value = keepX;
    if (this.anchors.some((anchor) => anchor.id === keepY)) this.regionY.value = keepY;
    if (this.anchors.some((anchor) => anchor.id === keepProbe)) this.regionProbe.value = keepProbe;
    this.regionList.replaceChildren();
    const evidence = this.draftEvidence();
    const snapshot = evidence === null ? null : snapshotEvidence(evidence);
    for (const region of this.regions) {
      const stale = snapshot === null || isRegionStale(region, snapshot);
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent =
        `region "${region.regionId}" frame "${region.frameId}" ` +
        `O "${region.originAnchorId}" X "${region.xAnchorId}" Y "${region.yAnchorId}"` +
        (stale ? " — STALE (evidence changed; remove and recreate)" : " — current");
      item.appendChild(label);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.disabled = !enabled;
      remove.addEventListener("click", () => {
        this.onRemoveRegion(region.regionId);
      });
      item.appendChild(remove);
      this.regionList.appendChild(item);
    }
    if (this.regions.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "No planar regions yet.";
      this.regionList.appendChild(empty);
    }
    this.regionActive.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = this.regions.length === 0 ? "No regions" : "Select a region";
    this.regionActive.appendChild(placeholder);
    for (const region of this.regions) {
      const option = document.createElement("option");
      option.value = region.regionId;
      option.textContent = region.regionId;
      this.regionActive.appendChild(option);
    }
    if (this.activeRegionId !== null && this.regions.some((region) => region.regionId === this.activeRegionId)) {
      this.regionActive.value = this.activeRegionId;
    } else if (keepActive !== "" && this.regions.some((region) => region.regionId === keepActive)) {
      this.regionActive.value = keepActive;
      this.activeRegionId = keepActive;
    } else {
      this.regionActive.value = "";
    }
    this.renderRegionFrame();
    this.renderRegionExport();
  }

  private regionNumber(value: number): string {
    return Math.abs(value) < 1e-10 ? "0" : Number(value.toPrecision(6)).toString();
  }

  private renderRegionFrame(): void {
    this.regionFrame.replaceChildren();
    const active = this.activeRegion();
    if (active === null) {
      const empty = document.createElement("p");
      empty.textContent = "No active region. X axis is red, Y axis is green, both 100 mm long.";
      this.regionFrame.appendChild(empty);
      return;
    }
    const frame = regionToAxesFrame(active);
    const heading = document.createElement("p");
    heading.textContent =
      `Active region "${active.regionId}" frame "${active.frameId}": ` +
      `origin (${this.regionNumber(active.origin.x)}, ${this.regionNumber(active.origin.y)}, ${this.regionNumber(active.origin.z)}); ` +
      `X red (${this.regionNumber(active.xAxis.x)}, ${this.regionNumber(active.xAxis.y)}, ${this.regionNumber(active.xAxis.z)}); ` +
      `Y green (${this.regionNumber(active.yAxis.x)}, ${this.regionNumber(active.yAxis.y)}, ${this.regionNumber(active.yAxis.z)}); ` +
      `axes 100 mm long (${this.regionNumber(frame.lengthMm)} mm at ${this.regionNumber(frame.mmPerModelUnit)} mm per unit); ` +
      `normal (${this.regionNumber(active.normal.x)}, ${this.regionNumber(active.normal.y)}, ${this.regionNumber(active.normal.z)}); ` +
      `tolerance ${this.regionNumber(active.offPlaneToleranceMm)} mm (explicit prototype setting). Values shown are rounded; JSON preserves full precision.`;
      this.regionFrame.appendChild(heading);
    const evidence = this.draftEvidence();
    const stale = evidence === null || isRegionStale(active, snapshotEvidence(evidence));
    const state = document.createElement("p");
    state.textContent = stale
      ? "Region is STALE: evidence changed since authoring. Remove and recreate it."
      : "Region matches the current calibration snapshot.";
    this.regionFrame.appendChild(state);
  }

  private renderRegionExport(): void {
    if (this.record === null || this.fit === null || this.fitEvidence === null || this.fitSnapshot === null) {
      this.regionExportButton.disabled = true;
      return;
    }
    if (this.fit.inconsistent || !isFitCurrent(this.draftEvidence(), this.fitSnapshot)) {
      this.regionExportButton.disabled = true;
      return;
    }
    if (this.regions.length === 0) {
      this.regionExportButton.disabled = true;
      return;
    }
    const snapshot = this.fitSnapshot;
    this.regionExportButton.disabled = this.regions.some((region) => isRegionStale(region, snapshot));
  }
}
