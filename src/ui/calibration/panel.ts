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
  removeAnchor,
  removeMeasurement,
  serializeSessionExport,
  snapshotEvidence,
  type DraftAnchor,
  type DraftMeasurement,
  type SessionFields,
} from "../../core/calibration-session/index.js";

export interface ViewerPort {
  pickSurface(
    clientX: number,
    clientY: number,
  ): { modelPosition: { x: number; y: number; z: number } } | null;
  setAnchorMarkers(
    anchors: Array<{ id: string; model: { x: number; y: number; z: number } }>,
  ): void;
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
  | "export-button";

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

  private record: AssetRecord | null = null;
  private anchors: DraftAnchor[] = [];
  private measurements: DraftMeasurement[] = [];
  private armed = false;
  private readonly gesture = new PickGesture(CLICK_MAX_MOVE_PX);
  private pendingPick: { x: number; y: number; z: number } | null = null;
  private fitEvidence: CalibrationEvidence | null = null;
  private fit: UniformFitResult | null = null;
  private fitSnapshot: string | null = null;

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

    for (const input of [
      this.productInput,
      this.variantInput,
      this.calibrationInput,
      this.frameInput,
      this.versionInput,
      this.toleranceMmInput,
      this.toleranceRelativeInput,
    ]) {
      input.addEventListener("input", () => {
        this.render();
      });
    }
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
    this.record = record;
    this.anchors = [];
    this.measurements = [];
    this.armed = false;
    this.gesture.cancel();
    this.pendingPick = null;
    this.fitEvidence = null;
    this.fit = null;
    this.fitSnapshot = null;
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
    const viewer = this.getViewer();
    if (viewer !== null) {
      viewer.setAnchorMarkers([]);
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
    if (!this.armed) return;
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
    this.syncMarkers();
    this.setStatus(
      `Anchor "${id}" removed with its referencing measurements.`,
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

  private render(): void {
    const enabled = this.record !== null;
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
    this.renderAnchors(enabled);
    this.renderMeasurements(enabled);
    this.armButton.setAttribute("aria-pressed", String(this.armed));
    this.addAnchorButton.disabled = !enabled || this.pendingPick === null;
    this.cancelButton.disabled = !enabled || (!this.armed && this.pendingPick === null);
    this.renderFit();
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
}
