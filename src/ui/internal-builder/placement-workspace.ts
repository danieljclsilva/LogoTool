import { createCanvasContextPanel } from './canvas-context-panel.js';
/// <reference lib="dom" />
/**
 * Placement workspace — Step 2 "Set up & place logos" (operator workflow, spec §5).
 *
 * Framework-free UI module. The lead mounts it into a provided container with
 * caller-owned state; this module never imports `main.ts` live state, never
 * reads files/network/storage, and never invents millimetre values.
 *
 * Data flow:
 * - reads: `deps.getProject()` + `deps.getSelection()` on every render.
 * - geometry commits: pure `src/core/project-editor` add/update/remove (each
 *   is one `newRevision` transaction; confirmation/review invalidation follows
 *   the existing revision contracts). The lead's `commit` persists the result
 *   and clears preview/export caches.
 * - measurements: staff-chosen `DimensionBinding` rows per configuration via
 *   `deps.getBindings`/`setBindings`; values always come from the
 *   `measureEdgeToAnchor` kernel (plus `resolveVisualDimension` for the
 *   diagram picker). No invented distances.
 * - staging: selected-placement form edits stay local until Apply; drags
 *   commit one transaction on pointer release. Navigation alone changes
 *   nothing: staged edits are keyed by placement and survive re-renders.
 */

import {
  addPlacement as addPlacementToConfig,
  evaluatePlacementGeometry,
  placementSelector,
  removePlacement as removePlacementFromConfig,
  updatePlacement as updatePlacementInConfig,
} from '../../core/project-editor/index.js';
import {
  measureEdgeToAnchor,
  rotatedFootprintCorners,
} from '../../core/operation-measurements/index.js';
import {
  cornerSafeMeasurements,
  rotationSnapDeg,
  snapFootprint,
  resizeFromCornerMm,
  normalizeDeg,
} from '../../core/placement-manipulation/index.js';
import {
  beginEdit,
  policyForLock,
  provisionalSizeMm,
  resetToArtworkRatio,
  resizeCorner,
  setCandidateHeight,
  setCandidateWidth,
  type RatioPolicy,
} from '../../core/placement-manipulation/edit-transaction.js';
import { modelPointFromMm } from '../../core/model-placement/index.js';
import { methodLabel, SUPPORTED_METHODS, configurePlacementMethod } from '../../core/decoration-methods/index.js';
import { resolveVisualDimension } from '../../core/visual-dimension/index.js';
import { displayVariantName } from '../../core/operation-document/index.js';
import { validateProject } from '../../core/validate.js';
import { createModelPlacementView, type ModelPlacementScene, type ModelPlacementView } from './model-placement-view.js';
import { expandableWorkspace } from './workspace-expansion.js';
import type {
  Configuration,
  Placement,
  ProductDefinition,
  ProjectDocument,
  Region,
} from '../../core/types.js';
import type {
  AnchorDef,
  ArtworkEdge,
  DimensionBinding,
  MeasurementConvention,
} from '../../core/operation-measurements/types.js';

/* ------------------------------------------------------------------ */
/* Public contracts (lead-owned wiring)                                */
/* ------------------------------------------------------------------ */

/** Current operator focus. Configuration is derived from product+variant. */
export interface PlacementWorkspaceSelection {
  productId: string;
  variantId: string;
  /** Active named view tab; null means the default/first view. */
  viewId: string | null;
  /** Stable placement id; null means no placement selected. */
  placementId: string | null;
}

/** One named product view tab (caller order). Display only. */
export interface PlacementProductView {
  id: string;
  label: string;
}

/** Calibrated photo overlay for one region view, where supported. Both
 * mappings are caller-evaluated (the existing inverse-mapping geometry):
 * this module only routes pointer positions through them, so zoom/pan can
 * never change stored millimetres. Null means "no overlay": the module
 * renders the authoritative region-mm diagram instead.
 *
 * `mappingStatus` reports the provenance of the evaluated mapping: a
 * `review` mapping is checked production geometry input, while a
 * `provisional` mapping is a trial calibration preview. The stage renders a
 * truthful provisional warning for the latter and never auto-approves it.
 */
export interface PlacementStageOverlay {
  imageSrc: string;
  imageWidthPx: number;
  imageHeightPx: number;
  alt: string;
  mappingStatus?: 'provisional' | 'review';
  mmToPx(xMm: number, yMm: number): { x: number; y: number } | null;
  pxToMm(x: number, y: number): { xMm: number; yMm: number } | null;
}

/** Department technique authoring for one placement (existing contracts). */
export interface PlacementTechnique {
  businessCode: string;
  temperature: string;
  time: string;
  pressure: string;
  colour: string;
  thread: string;
}

export type PlacementCommitResult = { ok: true } | { ok: false; error: string };

export interface PlacementWorkspaceDeps {
  sharedSurface?: Parameters<typeof createModelPlacementView>[0]['sharedSurface'];
  onBeforeRender?(): void;
  onRendered?(): void;
  toggleExpanded?(): void;
  isExpanded?(): boolean;
  getProject(): ProjectDocument;
  getSelection(): PlacementWorkspaceSelection;
  setSelection(patch: Partial<PlacementWorkspaceSelection>): void;
  /**
   * Persist a fully built next project (built with pure project-editor
   * functions, i.e. already a new revision). Must invalidate preview/export
   * caches and refresh via `update()`.
   */
  commit(label: string, next: ProjectDocument): PlacementCommitResult;
  /** Mint a fresh stable placement id (never a reused or positional id). */
  newPlacementId(): string;
  /**
   * Ids of included (selected) logos for Add-placement choices. Null/undefined
   * means all catalogue logos. Existing placements referencing excluded logos
   * stay visible and resolvable regardless.
   */
  getIncludedLogoIds?(): string[] | null;
  /**
   * Included (Step 1) scope for the product/option chooser lists.
   * Selectors hide by eligible count; the live selection and existing
   * placements are never filtered out of the lists. Null/undefined means
   * the full editable catalogue. Scoped inclusion still governs
   * issue/review/output content.
   */
  getIncludedScope?(): { productIds: string[]; configurationIds: string[] } | null;
  getProductViews(productId: string): PlacementProductView[];
  getProductMediaKind(productId: string): 'images' | 'model' | 'none';
  getModelScene?(productId: string, variantId: string): ModelPlacementScene | null;
  getStageOverlay(
    productId: string,
    variantId: string,
    regionId: string,
    viewId: string | null,
  ): PlacementStageOverlay | null;
  getLogoImage(logoId: string): { src: string; alt: string } | null;
  /** Anchors scoped to one product/option/region (caller filters; module refilters). */
  getAnchors(productId: string, variantId: string, regionId: string): AnchorDef[];
  addAnchor?(anchor: Omit<AnchorDef, "id" | "frameId" | "calibrationId" | "calibrationVersion">): void;
  getBindings(configurationId: string): DimensionBinding[];
  setBindings(configurationId: string, bindings: DimensionBinding[]): void;
  getTechnique?(configurationId: string, logoRef: string): PlacementTechnique | null;
  setTechnique?(configurationId: string, logoRef: string, technique: PlacementTechnique): void;
  /** Scoped product-setup route (missing calibration / safe areas / anchors). */
  requestProductSetup(productId: string, variantId?: string, regionId?: string): void;
  /** Show the existing model viewer for inspection (model mode only). */
  onViewModel?(productId: string): void;
  /**
   * Lead-owned operator history (job-session.ts/main.ts): called once per
   * committed placement edit with a human label. Camera moves never call
   * this. Optional until the lead wires the session mutation boundary.
   */
  pushHistory?(label: string): void;
  /** Choose artwork from the device without leaving the editor. */
  onAddLogo(): void;
  onReview(): void;
  onApprovalBranch(): void;
  onBack(): void;
  onStatus?(message: string): void;
  onSaveJob?(): void;
}

export interface PendingPlacementEdit {
  productId: string;
  variantId: string;
  configId: string;
  placementIndex: number;
  placementId?: string;
  label: string;
}

export interface PlacementWorkspaceHandle {
  suspend(): void;
  closeEnlarged(): void;
  update(): void;
  destroy(): void;
  /** True while staged (unapplied) form edits or a dirty add draft exist. */
  hasPendingEdits(): boolean;
  /** One descriptor per staged placement edit (stable order). */
  pendingEdits(): PendingPlacementEdit[];
  /** Validate + commit every staged placement edit; returns applied/blocked counts. */
  applyPendingEdits(): { applied: number; blocked: number };
  /** Discard every staged placement edit without committing. */
  discardPendingEdits(): number;
  /**
   * Rebase derived drafts after an external project swap (e.g. adopting a
   * validated customer response). Auto-created mirrors that matched the
   * previous committed values are stale by definition and are dropped, so
   * the swap never manufactures "unapplied" edits; real operator drafts
   * that already differed keep their guard. Drafts whose scope vanished
   * are invalidated. Never commits.
   */
  rebaseAfterProjectSwap(previous: ProjectDocument): void;
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests / lead reuse; no DOM)              */
/* ------------------------------------------------------------------ */

/** Display-only 1-decimal millimetre rounding (never feeds geometry). */
export function displayMm(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10}`;
}

/** Parse a millimetre number field; blank/non-numeric/non-finite → null. */
export function parseMm(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** One inline message per invalid selected-placement field. Pure; no DOM. */
export interface SelectedEditFieldErrors {
  area?: string;
  method?: string;
  width?: string;
  height?: string;
  rotation?: string;
  x?: string;
  y?: string;
}

/**
 * Validate staged selected-placement raw strings with the same parseMm /
 * safe-area / method rules Apply commits with. Blank, non-numeric and
 * non-finite input is invalid; sizes must exceed 0 mm; the method must be
 * offered by the edit's own region. Partial input simply reports errors —
 * callers keep the pending guard (invalid edits still block save/review)
 * and never commit from here. Pure; no DOM.
 */
export function validateSelectedEditFields(
  edit: {
    widthRaw: string;
    heightRaw: string;
    rotationRaw: string;
    centreXRaw: string;
    centreYRaw: string;
    regionId: string;
    method: string;
  },
  region: Region | undefined,
): SelectedEditFieldErrors {
  const errors: SelectedEditFieldErrors = {};
  if (region === undefined) {
    errors.area = 'Choose a current safe area for this placement.';
  } else if (!region.allowedMethods.includes(edit.method)) {
    const areaName = region.name?.trim() || 'unnamed area';
    errors.method =
      `Method “${edit.method || '(none)'}” is not offered in “${areaName}”. ` +
      `Choose one of: ${region.allowedMethods.join(', ') || '(none configured)'}.`;
  }
  const widthMm = parseMm(edit.widthRaw);
  if (widthMm === null || !(widthMm > 0)) {
    errors.width = 'Width must be a number greater than 0 mm.';
  }
  const heightMm = parseMm(edit.heightRaw);
  if (heightMm === null || !(heightMm > 0)) {
    errors.height = 'Height must be a number greater than 0 mm.';
  }
  if (parseMm(edit.rotationRaw) === null) {
    errors.rotation = 'Rotation must be a finite number of degrees.';
  }
  if (parseMm(edit.centreXRaw) === null) {
    errors.x = 'X centre must be a finite millimetre number.';
  }
  if (parseMm(edit.centreYRaw) === null) {
    errors.y = 'Y centre must be a finite millimetre number.';
  }
  return errors;
}

/**
 * First blocking failure in Apply order (area → method → width → height →
 * rotation → centre). Pure. Drives both the disabled-Apply reason and the
 * single Apply-attempt announcement, so the two never disagree.
 */
export function firstSelectedEditError(errors: SelectedEditFieldErrors): string | undefined {
  return errors.area ?? errors.method ?? errors.width ?? errors.height ??
    errors.rotation ?? errors.x ?? errors.y;
}

/** Inline field-error paragraph with a stable hook/id for aria-describedby. No DOM outside the node. */
function selectedFieldError(hook: string, message: string): HTMLElement {
  const node = el('p', 'pw-error', hook);
  node.id = hook;
  node.textContent = message;
  return node;
}

/** Normalize clockwise degrees to (-180, 180] (schema range). Pure. */
export function normalizeRotationDeg(value: number): number {
  let result = value % 360;
  if (result <= -180) result += 360;
  else if (result > 180) result -= 360;
  return result === 0 ? 0 : result;
}

/**
 * Validated starting centre for a new placement: the bounding-box centre of
 * the region's configured safe area, or null when unconfigured. No other
 * convention is invented; callers fall back to refusing placement creation.
 */
export function regionCentreMm(region: Region): { x: number; y: number } | null {
  if (region.safeArea.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of region.safeArea) {
    const x = point[0];
    const y = point[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) ||
    !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Placement selector used by operation-draft bindings: the placement `id`
 * when recorded, else `logoId` for the first id-less placement of that logo,
 * else `logoId#n` (0-based) for the nth. Mirrors the core draft contract.
 */
export function logoRefForPlacement(placements: readonly Placement[], index: number): string {
  const placement = placements[index];
  if (placement === undefined) return `#${index}`;
  if (placement.id !== undefined && placement.id !== '') return placement.id;
  let ordinal = 0;
  for (let j = 0; j < index; j += 1) {
    const other = placements[j];
    if (other !== undefined && other.logoId === placement.logoId &&
      (other.id === undefined || other.id === '')) ordinal += 1;
  }
  return ordinal === 0 ? placement.logoId : `${placement.logoId}#${ordinal}`;
}

/** Configuration for one product/option pair, or null. Pure. */
export function configurationForOption(
  project: ProjectDocument,
  productId: string,
  variantId: string,
): Configuration | null {
  return project.configurations.find(
    (entry) => entry.productId === productId && entry.variantId === variantId,
  ) ?? null;
}

/** Configured safe areas for one option: supported regions with a drawn polygon. Pure. */
export function configuredAreas(product: ProductDefinition, variantId: string): Region[] {
  const variant = product.variants.find((entry) => entry.id === variantId);
  if (variant === undefined) return [];
  const supported = new Set(variant.regionIds);
  return product.regions.filter(
    (region) => supported.has(region.id) && region.safeArea.length >= 3,
  );
}

/** 'missing-calibration' when the region's calibration is not configured. Pure. */
export function calibrationState(
  product: ProductDefinition,
  region: Region,
): 'ok' | 'missing-calibration' {
  if (product.calibrations.length === 0) return 'missing-calibration';
  const match = product.calibrations.some(
    (entry) => entry.id === region.calibrationRef.calibrationId &&
      entry.version === region.calibrationRef.version,
  );
  return match ? 'ok' : 'missing-calibration';
}

export interface PlacementReviewGate {
  /** Review stays disabled while any blocker stands. */
  blockers: string[];
  /** Actionable issues: review stays available but must not look complete. */
  issues: string[];
  /** Informational only (e.g. explicit zero placements). */
  notices: string[];
}

function logoNameOf(project: ProjectDocument, logoId: string): string {
  return project.logos.find((entry) => entry.id === logoId)?.name?.trim() || 'Unnamed logo';
}

function areaNameOf(project: ProjectDocument, productId: string, regionId: string): string {
  const product = project.products.find((entry) => entry.id === productId);
  return product?.regions.find((entry) => entry.id === regionId)?.name?.trim() ||
    'unnamed area';
}

/** Match a draft binding logoRef against one configuration's placements. Pure. */
export function placementIndexForLogoRef(
  placements: readonly Placement[],
  logoRef: string,
): number {
  for (let index = 0; index < placements.length; index += 1) {
    if (logoRefForPlacement(placements, index) === logoRef) return index;
  }
  return -1;
}

/**
 * Review gate for one configuration. Pure; no DOM. Structural problems and
 * unapplied edits block review; invalid fit and unresolved measurements are
 * actionable issues that must never masquerade as complete.
 */
export function reviewGateForConfiguration(
  project: ProjectDocument,
  configurationId: string,
  anchors: readonly AnchorDef[],
  bindings: readonly DimensionBinding[],
  hasPendingEdits: boolean,
  addDraftDirty: boolean,
): PlacementReviewGate {
  const blockers: string[] = [];
  const issues: string[] = [];
  const notices: string[] = [];
  if (hasPendingEdits) {
    blockers.push('Apply the pending placement edits before review.');
  }
  if (addDraftDirty) {
    blockers.push('Finish or cancel the new placement before review.');
  }
  const configIndex = project.configurations.findIndex((entry) => entry.id === configurationId);
  if (configIndex < 0) {
    blockers.push('The selected product option is no longer in this job.');
    return { blockers, issues, notices };
  }
  const structural = validateProject(project);
  if (!structural.ok) {
    const prefix = `configurations[${configIndex}]`;
    for (const error of structural.errors) {
      if (error.path === prefix || error.path.startsWith(`${prefix}.`) ||
        error.path.startsWith(`${prefix}[`)) {
        blockers.push(error.message);
      }
    }
  }
  const configuration = project.configurations[configIndex]!;
  const product = project.products.find((entry) => entry.id === configuration.productId);
  if (configuration.placements.length === 0) {
    notices.push('No logo placements for this option.');
    return { blockers, issues, notices };
  }
  for (const [index, placement] of configuration.placements.entries()) {
    const logoName = logoNameOf(project, placement.logoId);
    const areaName = areaNameOf(project, configuration.productId, placement.regionId);
    const region = product?.regions.find((entry) => entry.id === placement.regionId);
    if (region !== undefined) {
      let verdict: { ok: boolean; reason: string } | null = null;
      try {
        verdict = evaluatePlacementGeometry(region, placement);
      } catch {
        verdict = null;
      }
      if (verdict !== null && !verdict.ok) {
        issues.push(
          `${logoName} extends outside ${areaName}. Move it or reduce its size. (${verdict.reason})`,
        );
      }
    }
    void index;
  }
  const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  for (const binding of bindings) {
    const placementIndex = placementIndexForLogoRef(configuration.placements, binding.logoRef);
    if (placementIndex < 0) continue;
    const placement = configuration.placements[placementIndex]!;
    const anchor = anchorsById.get(binding.anchorId);
    if (anchor === undefined) {
      issues.push(
        `Measurement “${binding.label}” has no matching anchor; set one up before review.`,
      );
      continue;
    }
    if (anchor.productId !== configuration.productId ||
      anchor.variantId !== configuration.variantId ||
      anchor.regionId !== placement.regionId) {
      issues.push(
        `Measurement “${binding.label}” anchor “${anchor.name}” is scoped to a ` +
        `different area; re-pick it before review.`,
      );
      continue;
    }
    const footprint = rotatedFootprintCorners(
      placement.pos.xMm, placement.pos.yMm,
      placement.widthMm, placement.heightMm, placement.rotationDeg,
    ).map((corner) => ({ x: corner.x, y: corner.y }));
    const measured = measureEdgeToAnchor(footprint, { x: anchor.posMm[0], y: anchor.posMm[1] }, {
      edge: binding.edge,
      convention: binding.convention,
    });
    if (!measured.ok) {
      issues.push(`Measurement “${binding.label}”: ${measured.error}.`);
    }
  }
  return { blockers, issues, notices };
}

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

const HOOK = 'data-placement-hook';
const SVG_NS = 'http://www.w3.org/2000/svg';

function mark(node: Element, name: string): Element {
  node.setAttribute(HOOK, name);
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  hook?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (hook !== undefined) node.setAttribute(HOOK, hook);
  return node;
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/**
 * Keyboard/click-accessible help popover (native details/summary: no
 * hover-only behavior, no JS state). Status and errors never hide here.
 */
function helpPopover(hook: string, text: string): HTMLElement {
  const details = document.createElement('details');
  details.className = 'pw-help';
  details.setAttribute(HOOK, hook);
  const summary = document.createElement('summary');
  summary.className = 'pw-help-summary';
  summary.textContent = 'ⓘ Help';
  details.append(summary);
  const body = el('p', 'pw-help-body');
  body.textContent = text;
  details.append(body);
  return details;
}

const EDGE_WORD: Record<ArtworkEdge, string> = {
  minX: 'left',
  maxX: 'right',
  minY: 'bottom',
  maxY: 'top',
};

const CONVENTION_WORD: Record<MeasurementConvention, string> = {
  dx: 'Horizontal',
  dy: 'Vertical',
  'shortest-to-edge': 'Shortest',
};

const STYLE_TEXT = [
  '.pw-root{font:inherit;color:inherit}',
  '.pw-layout.pw-product-workspace{border:1px solid #e4e8ec;border-radius:10px;padding:12px;background:#fff;gap:16px;grid-template-columns:minmax(0,1fr) 320px}',
  '.pw-product-workspace .model-placement-workbench{border:0;padding:0}',
  '.pw-product-workspace .pw-rail{padding-left:16px}',
  '.station-expanded-workspace .pw-product-workspace{border:0;padding:0}',
  '@media(max-width:820px){.pw-layout.pw-product-workspace{grid-template-columns:minmax(0,1fr)}.pw-product-workspace .pw-rail{padding-left:0}}',
  '.model-placement-workbench{border:1px solid #e4e8ec;border-radius:10px;padding:10px;background:#fff;min-width:0}',
  '.model-placement-toolbar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}',
  '.model-placement-toolbar .pw-secondary{padding:8px 12px;min-height:44px}',
  '.model-placement-details-button{display:none}',
  '.model-placement-stage{position:relative;height:clamp(340px,60vh,700px);min-height:0}',
  '.model-placement-stage canvas{display:block;width:100%;height:100%;touch-action:none}',
  '.station-expanded-workspace>.pw-root{height:100%;display:flex;flex-direction:column}',
  '.station-expanded-workspace .pw-layout{flex:1;min-height:0;grid-template-columns:minmax(0,1fr) 320px;gap:12px}',
  '.station-expanded-workspace .pw-main{min-height:0;display:flex;flex-direction:column}',
  '.station-expanded-workspace .model-placement-workbench{flex:1;min-height:0;display:flex;flex-direction:column}',
  '.station-expanded-workspace .model-placement-stage{flex:1;min-height:150px;height:auto}',
  '.station-expanded-workspace .pw-rail{overflow:auto;padding:0 12px;min-height:0}',
  '@media(max-width:700px){.station-expanded-workspace .pw-root>h2,.station-expanded-workspace .pw-header{display:none}.station-expanded-workspace .pw-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}.station-expanded-workspace .model-placement-details-button{display:block}.station-expanded-workspace:not(.show-placement-details) .pw-rail{display:none}.station-expanded-workspace.show-placement-details .pw-layout{grid-template-rows:minmax(210px,1fr) minmax(110px,30vh)}.station-expanded-workspace .pw-rail{margin:0;padding:8px}.station-expanded-workspace .model-placement-workbench>p{display:none}}',
  '.pw-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:0 32px}',
  '.pw-main{min-width:0}.pw-rail{border-left:1px solid #e4e8ec;padding-left:32px;min-width:0}',
  '@media(max-width:820px){.pw-layout{grid-template-columns:1fr}.pw-rail{border-left:0;border-top:1px solid #e4e8ec;padding-left:0;padding-top:20px;margin-top:24px}}',
  '.pw-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}',
  '.pw-stage{position:relative;border:1px solid #e4e8ec;border-radius:8px;background:#fff;overflow:hidden}',
  '.pw-stage svg{display:block;width:100%;height:auto;touch-action:none}',
  '.pw-hint{color:#657183;font-size:.9rem}',
  '.pw-status{min-height:1.5em}',
  '.pw-error{color:#a53a32;font-weight:600}',
  '.pw-warning{color:#6d4c00;background:#fff8e1;border:1px solid #d9a92b;border-radius:6px;padding:6px 10px;margin:8px 0}',
  '.pw-ok{color:#227443}',
  '.pw-list{display:grid;gap:8px;margin:8px 0}',
  '.pw-item{display:flex;gap:10px;align-items:center;border:1px solid #e4e8ec;border-radius:8px;padding:8px 10px;background:#fff;cursor:pointer;min-height:44px;text-align:left;width:100%;font:inherit;color:inherit}',
  '.pw-item.is-selected{border-color:#d20a2e;box-shadow:0 0 0 1px #d20a2e}',
  '.pw-thumb{width:48px;height:48px;object-fit:contain;border:1px solid #e4e8ec;border-radius:6px;background:#fff;flex:none}',
  '.pw-item-body{display:grid;gap:2px;min-width:0}',
  '.pw-item-name{font-weight:650;overflow-wrap:anywhere}',
  '.pw-item-sub{color:#657183;font-size:.85rem}',
  '.pw-field{display:grid;gap:4px;font-weight:650;margin:10px 0;max-width:34rem}',
  '.pw-field input,.pw-field select{min-width:0;border:1px solid #c6ced6;border-radius:6px;padding:9px 10px;background:#fff;font:inherit;font-weight:400;min-height:44px}',
  '.pw-check{display:flex;align-items:center;gap:10px;font-weight:500;margin:10px 0;min-height:44px}',
  '.pw-btn{border-radius:8px;padding:12px 18px;font:inherit;cursor:pointer;min-height:44px}',
  '.pw-primary{border:1px solid #d20a2e;background:#d20a2e;color:#fff;font-weight:650;width:100%;border-radius:8px;padding:12px 18px;font:inherit;cursor:pointer;min-height:44px}',
  '.pw-primary:disabled{opacity:.48;cursor:default}',
  '.pw-secondary{border:1px solid #c6ced6;background:#fff;color:inherit;font-weight:550;border-radius:8px;padding:12px 18px;font:inherit;cursor:pointer;min-height:44px}',
  '.pw-secondary:disabled{opacity:.48;cursor:default}',
  '.pw-actions{display:grid;gap:10px;margin-top:12px}',
  '.pw-step-actions{position:sticky;bottom:0;background:#fff;padding:10px 0;z-index:2}',
  '.pw-overflow-cue{position:sticky;bottom:0;display:block;text-align:center;color:#0b6cab;background:linear-gradient(transparent,#fff 40%);padding:10px 0 2px;font-size:.85rem;z-index:1}',
  '.pw-help{display:inline-block;margin:2px 0 8px}',
  '.pw-help-summary{cursor:pointer;color:#0b6cab;font-weight:600;list-style:none;min-height:44px;display:inline-flex;align-items:center}',
  '.pw-help-summary::-webkit-details-marker{display:none}',
  '.pw-help-body{margin:4px 0 8px;padding:8px 10px;border:1px solid #e4e8ec;border-radius:6px;background:#f8fafc;max-width:34rem}',
  '.pw-artwork-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:8px;margin:8px 0}',
  '.pw-artwork-card{display:grid;gap:6px;border:1px solid #e4e8ec;border-radius:8px;padding:8px;background:#fff}',
  '.pw-artwork-pick{display:grid;gap:4px;justify-items:center;border:0;background:none;padding:4px;cursor:grab;font:inherit;color:inherit;text-align:center;min-height:44px}',
  '.pw-artwork-thumb{width:64px;height:64px;object-fit:contain;border:1px solid #e4e8ec;border-radius:6px;background:#fff;pointer-events:none}',
  '.pw-artwork-name{font-weight:650;overflow-wrap:anywhere}',
  '.pw-artwork-state{color:#657183;font-size:.8rem}',
  '.pw-artwork-place{min-height:44px}',
  '.pw-product-workspace.pw-layout{min-height:min(72vh,640px);align-items:start}',
  '.pw-product-workspace .pw-main{min-height:0;min-width:0}',
  '.pw-product-workspace .pw-rail{max-height:calc(100vh - 140px);overflow:auto;overscroll-behavior:contain}',
  '.pw-product-workspace .model-placement-workbench{position:sticky;top:0}',
  '@media(max-width:820px){.pw-product-workspace.pw-layout{min-height:0}.pw-product-workspace .pw-rail{max-height:none;overflow:visible}.pw-product-workspace .model-placement-workbench{position:static}}',
  '.station-expanded-workspace .model-placement-workbench>p{display:none}',
  '.station-expanded-workspace .pw-product-workspace .model-placement-toolbar{flex-wrap:nowrap;overflow-x:auto}',
  '.pw-field{margin-top:6px;margin-bottom:6px}',
  '.pw-check{margin:6px 0}',
  '.pw-measure{padding:6px 0}',
  '.pw-selected h3{margin:.4em 0 .2em}',
  '.pw-placements-title,.pw-artwork-title{margin:.6em 0 .2em}',
  '.pw-inline{display:flex;flex-wrap:wrap;gap:8px}',
  '.pw-inline .pw-secondary,.pw-inline .pw-primary{width:auto}',
  '.pw-tabs{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}',
  '.pw-tab{border:1px solid #e4e8ec;background:#fff;border-radius:999px;padding:7px 14px;cursor:pointer;font:inherit;min-height:44px}',
  '.pw-tab.is-active{background:#d20a2e;border-color:#d20a2e;color:#fff;font-weight:700}',
  '.pw-measure{border-top:1px solid #e4e8ec;padding:8px 0}',
  '.pw-muted{color:#657183;font-size:.9rem}',
].join('\n');

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

interface StagedEdits {
  logoId: string;
  regionId: string;
  widthRaw: string;
  heightRaw: string;
  rotationRaw: string;
  keepProportions: boolean;
  centreXRaw: string;
  centreYRaw: string;
  method: string;
  widthTouched: boolean;
}

interface AddDraft {
  logoId: string;
  regionId: string;
  widthRaw: string;
  heightRaw: string;
  rotationRaw: string;
  keepProportions: boolean;
  method: string;
  widthTouched: boolean;
  notice: string;
}

interface MeasureDraft {
  anchorId: string;
  edge: ArtworkEdge;
  convention: MeasurementConvention;
  notice: string;
  picking: { anchorClickMm: [number, number] | null } | null;
  preview: { bindingAnchorId: string; edge: ArtworkEdge; valueMm: number } | null;
}

export function mountPlacementWorkspace(
  root: HTMLElement,
  deps: PlacementWorkspaceDeps,
): PlacementWorkspaceHandle {
  let destroyed = false;
  let contextPanel: ReturnType<typeof createCanvasContextPanel> | null = null;
  let contextOpen = false;
  const styleNode = document.createElement('style');
  styleNode.textContent = STYLE_TEXT;
  styleNode.setAttribute(HOOK, 'pw-style');
  document.head.append(styleNode);

  const staged = new Map<string, StagedEdits>();
  /** Tray drag payload fallback (some hosts restrict dataTransfer reads). */
  let pendingTrayDrop: string | null = null;
  /**
   * Persisted ratio policies per placement key (unified edit transaction).
   * Locks survive commits and selection changes; toggling never rolls back
   * committed geometry. Apply/commit never clears these.
   */
  const ratioLocks = new Map<string, RatioPolicy>();
  function lockFor(configurationId: string, placement: Placement, index: number): RatioPolicy {
    const stored = ratioLocks.get(placementKeyOf(configurationId, placement, index));
    if (stored !== undefined) return stored;
    return { locked: false, ratio: NaN };
  }
  let addOpen = false;
  let addDraft: AddDraft | null = null;
  let measureOpen = false;
  let measureDraft: MeasureDraft | null = null;
  let status = '';
  const viewCache = new Map<string, { cx: number; cy: number; span: number }>();
  let viewOverride: { cx: number; cy: number; span: number } | null = null;
  const aborter = new AbortController();
  let modelView: ModelPlacementView | null = null;
  /** Current model readiness; callbacks read this on every edit. */
  let modelViewDisplayOnly = false;
  let stageAborter: AbortController | null = null;
  let stageDropPoint: ((x: number, y: number) => { regionId: string; pos: { xMm: number; yMm: number } } | null) | null = null;
  const expansion = expandableWorkspace(root, () => {
    const expandButton = root.querySelector<HTMLButtonElement>('[data-placement-hook="pw-model-expand"]');
    if (expandButton) {
      expandButton.textContent = expansion.expanded() ? 'Close enlarged view' : 'Enlarge workspace';
      expandButton.setAttribute('aria-expanded', String(expansion.expanded()));
    }
  });

  function announce(message: string): void {
    status = message;
    try {
      deps.onStatus?.(message);
    } catch { /* status is best-effort */ }
  }

  function stageKey(configurationId: string, placementId: string): string {
    return `${configurationId} ${placementId}`;
  }

  function placementKeyOf(configurationId: string, placement: Placement, index: number): string {
    const id = placement.id ?? `index:${index}`;
    return stageKey(configurationId, id);
  }

  function currentContext(): {
    project: ProjectDocument;
    selection: PlacementWorkspaceSelection;
    product: ProductDefinition | null;
    configuration: Configuration | null;
    placementIndex: number;
    placement: Placement | null;
  } {
    const project = deps.getProject();
    const selection = deps.getSelection();
    const product = project.products.find((entry) => entry.id === selection.productId) ?? null;
    const configuration = configurationForOption(project, selection.productId, selection.variantId);
    let placementIndex = -1;
    let placement: Placement | null = null;
    if (configuration !== null && selection.placementId !== null) {
      placementIndex = configuration.placements.findIndex(
        (entry, index) => (entry.id ?? `index:${index}`) === selection.placementId,
      );
      if (placementIndex >= 0) placement = configuration.placements[placementIndex] ?? null;
    }
    return { project, selection, product, configuration, placementIndex, placement };
  }

  function logoPixelAspect(project: ProjectDocument, logoId: string): number | null {
    const logo = project.logos.find((entry) => entry.id === logoId);
    if (logo === undefined) return null;
    for (const asset of logo.assets) {
      if (asset.widthPx !== undefined && asset.heightPx !== undefined &&
        Number.isFinite(asset.widthPx) && Number.isFinite(asset.heightPx) &&
        asset.widthPx > 0 && asset.heightPx > 0) {
        return asset.widthPx / asset.heightPx;
      }
    }
    return null;
  }

  function knownDimensions(
    project: ProjectDocument,
    logoId: string,
  ): { widthMm: number; heightMm: number } | null {
    const logo = project.logos.find((entry) => entry.id === logoId);
    if (logo === undefined) return null;
    if (logo.knownWidthMm !== undefined && logo.knownHeightMm !== undefined &&
      Number.isFinite(logo.knownWidthMm) && Number.isFinite(logo.knownHeightMm) &&
      logo.knownWidthMm > 0 && logo.knownHeightMm > 0) {
      return { widthMm: logo.knownWidthMm, heightMm: logo.knownHeightMm };
    }
    return null;
  }

  function ensureStaged(
    project: ProjectDocument,
    configuration: Configuration,
    placement: Placement,
    index: number,
  ): StagedEdits {
    const key = placementKeyOf(configuration.id, placement, index);
    const existing = staged.get(key);
    if (existing !== undefined) return existing;
    const fresh: StagedEdits = {
      logoId: placement.logoId,
      regionId: placement.regionId,
      widthRaw: String(placement.widthMm),
      heightRaw: String(placement.heightMm),
      rotationRaw: String(placement.rotationDeg),
      keepProportions: false,
      centreXRaw: String(placement.pos.xMm),
      centreYRaw: String(placement.pos.yMm),
      method: placement.method,
      widthTouched: false,
    };
    staged.set(key, fresh);
    return fresh;
  }

  function stagedDiffers(placement: Placement, edit: StagedEdits): boolean {
    return edit.logoId !== placement.logoId ||
      edit.regionId !== placement.regionId ||
      edit.widthRaw.trim() !== String(placement.widthMm) ||
      edit.heightRaw.trim() !== String(placement.heightMm) ||
      edit.rotationRaw.trim() !== String(placement.rotationDeg) ||
      edit.centreXRaw.trim() !== String(placement.pos.xMm) ||
      edit.centreYRaw.trim() !== String(placement.pos.yMm) ||
      edit.method !== placement.method;
  }

  /** Valid local geometry drives the visual candidate; exports still read the committed project. */
  function candidatePlacement(configurationId: string, placement: Placement, index: number): Placement {
    const edit = staged.get(placementKeyOf(configurationId, placement, index));
    if (!edit) return placement;
    const width = parseMm(edit.widthRaw), height = parseMm(edit.heightRaw);
    const x = parseMm(edit.centreXRaw), y = parseMm(edit.centreYRaw), rotation = parseMm(edit.rotationRaw);
    return { ...placement,
      widthMm: width !== null && width > 0 ? width : placement.widthMm,
      heightMm: height !== null && height > 0 ? height : placement.heightMm,
      pos: { xMm: x ?? placement.pos.xMm, yMm: y ?? placement.pos.yMm },
      rotationDeg: rotation ?? placement.rotationDeg,
    };
  }

  function anyPendingForConfiguration(configuration: Configuration): boolean {
    for (const [index, placement] of configuration.placements.entries()) {
      const edit = staged.get(placementKeyOf(configuration.id, placement, index));
      if (edit !== undefined && stagedDiffers(placement, edit)) return true;
    }
    return false;
  }

  function commitNext(label: string, next: ProjectDocument): boolean {
    let result: PlacementCommitResult;
    try {
      result = deps.commit(label, next);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) {
      announce(`${label} failed: ${result.error}. Nothing changed.`);
      update();
      return false;
    }
    // Operator history owns undo after this point; camera moves never reach here.
    try {
      deps.pushHistory?.(label);
    } catch { /* history is advisory to this commit */ }
    update();
    return true;
  }

  function applyStaged(
    configuration: Configuration,
    placement: Placement,
    index: number,
    edit: StagedEdits,
  ): void {
    const project = deps.getProject();
    const product = project.products.find((entry) => entry.id === configuration.productId);
    const region = product?.regions.find((entry) => entry.id === edit.regionId);
    // Shared with the inline field errors below: one rule set drives both
    // the disabled-Apply reason and this Apply-attempt announcement, so the
    // two never disagree. Announce strings are unchanged; the domain commit
    // (updatePlacementInConfig try/catch) keeps its own validation.
    const fieldErrors = validateSelectedEditFields(edit, region);
    if (region === undefined || fieldErrors.area !== undefined) {
      announce('Apply blocked: choose a current safe area for this placement.');
      update();
      return;
    }
    if (fieldErrors.method !== undefined) {
      announce(
        `Apply blocked: method “${edit.method || '(none)'}” is not offered in ` +
        `“${region.name?.trim() || 'unnamed area'}”. Choose one of: ${region.allowedMethods.join(', ') || '(none configured)'}.`,
      );
      update();
      return;
    }
    if (fieldErrors.width !== undefined) {
      announce('Apply blocked: Width must be a number greater than 0 mm.');
      update();
      return;
    }
    if (fieldErrors.height !== undefined) {
      announce('Apply blocked: Height must be a number greater than 0 mm.');
      update();
      return;
    }
    if (fieldErrors.rotation !== undefined) {
      announce('Apply blocked: Rotation must be a finite number of degrees.');
      update();
      return;
    }
    if (fieldErrors.x !== undefined || fieldErrors.y !== undefined) {
      announce('Apply blocked: Centre X/Y must be finite millimetre numbers.');
      update();
      return;
    }
    // The validator passed, so these re-parses are non-null (parseMm is pure).
    const widthMm = parseMm(edit.widthRaw)!;
    const heightMm = parseMm(edit.heightRaw)!;
    const rotationRaw = parseMm(edit.rotationRaw)!;
    const xMm = parseMm(edit.centreXRaw)!;
    const yMm = parseMm(edit.centreYRaw)!;
    const rotationDeg = normalizeRotationDeg(rotationRaw);
    let next: ProjectDocument;
    try {
      next = updatePlacementInConfig(
        project,
        configuration.id,
        placementSelector(placement, index),
        {
          logoId: edit.logoId,
          regionId: edit.regionId,
          method: edit.method,
          pos: { xMm, yMm },
          widthMm,
          heightMm,
          rotationDeg,
        },
      );
    } catch (error) {
      announce(`Apply blocked: ${error instanceof Error ? error.message : String(error)}`);
      update();
      return;
    }
    if (commitNext('Apply placement changes', next)) {
      staged.delete(placementKeyOf(configuration.id, placement, index));
      announce('Placement changes applied.');
      update();
    }
  }

  /* ---------------- Stage geometry (pure mm; zoom is view-only) ------- */

  interface StagePoint { x: number; y: number }

  interface StageMapping {
    toSvg(xMm: number, yMm: number): StagePoint | null;
    fromSvg(point: StagePoint): { xMm: number; yMm: number } | null;
    contentBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null;
  }

  function diagramMapping(points: StagePoint[]): StageMapping {
    return {
      toSvg: (xMm, yMm) => ({ x: xMm, y: -yMm }),
      fromSvg: (point) => ({ xMm: point.x, yMm: -point.y }),
      contentBounds: () => {
        if (points.length === 0) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const point of points) {
          const sx = point.x;
          const sy = -point.y;
          if (sx < minX) minX = sx;
          if (sy < minY) minY = sy;
          if (sx > maxX) maxX = sx;
          if (sy > maxY) maxY = sy;
        }
        return { minX, minY, maxX, maxY };
      },
    };
  }

  function overlayMapping(
    overlay: PlacementStageOverlay,
    pointsMm: Array<{ x: number; y: number }>,
  ): StageMapping {
    return {
      toSvg: (xMm, yMm) => overlay.mmToPx(xMm, yMm),
      fromSvg: (point) => overlay.pxToMm(point.x, point.y),
      contentBounds: () => {
        const corners: StagePoint[] = [
          { x: 0, y: 0 },
          { x: overlay.imageWidthPx, y: 0 },
          { x: overlay.imageWidthPx, y: overlay.imageHeightPx },
          { x: 0, y: overlay.imageHeightPx },
        ];
        for (const point of pointsMm) {
          const mapped = overlay.mmToPx(point.x, point.y);
          if (mapped !== null) corners.push(mapped);
        }
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const corner of corners) {
          if (corner.x < minX) minX = corner.x;
          if (corner.y < minY) minY = corner.y;
          if (corner.x > maxX) maxX = corner.x;
          if (corner.y > maxY) maxY = corner.y;
        }
        return { minX, minY, maxX, maxY };
      },
    };
  }

  /* ---------------- Render ------------------------------------------- */

  function clearFocusMemory(): { hook: string } | null {
    const active = document.activeElement;
    if (active !== null && active instanceof HTMLElement) {
      const hook = active.getAttribute(HOOK);
      if (hook !== null && hook !== '') return { hook };
    }
    return null;
  }

  function restoreFocus(memory: { hook: string } | null): void {
    if (memory === null || destroyed) return;
    const target = root.querySelector<HTMLElement>(`[${HOOK}="${memory.hook}"]`);
    if (target !== null && typeof target.focus === 'function') {
      try {
        target.focus({ preventScroll: true });
      } catch { /* focus restore is best-effort */ }
    }
  }

  function update(): void {
    if (destroyed) return;
    const memory = clearFocusMemory();
    const openDetails = new Set(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[open]')).map((node) => node.getAttribute(HOOK)));
    const railScroll = root.querySelector<HTMLElement>('.pw-rail-content')?.scrollTop ?? 0;
    deps.onBeforeRender?.();
    if (contextPanel) { contextOpen = contextPanel.isOpen(); contextPanel.destroy(); contextPanel = null; }
    modelView?.element.remove();
    root.replaceChildren();
    const wrap = el('div', 'pw-root', 'pw-root');
    root.append(wrap);
    renderHeader(wrap);
    const context = currentContext();
    if (context.configuration && isExcludedScope(context.configuration)) {
      const warning = el('p', 'pw-warning', 'pw-add-blocked');
      warning.id = 'placement-exclusion-message';
      warning.setAttribute('role', 'alert');
      warning.textContent = excludedScopeMessage(context.project, context.configuration.productId, context.configuration.variantId);
      wrap.append(warning);
    }
    const layout = el('div', 'pw-layout');
    wrap.append(layout);
    const main = el('div', 'pw-main');
    const rail = el('aside', 'pw-rail', 'pw-rail');
    layout.append(main, rail);
    renderStage(main);
    const railBody = el('div', 'pw-rail-content', 'pw-rail-content');
    rail.append(railBody);
    renderRail(railBody);
    const actions = railBody.querySelector('[data-placement-hook="pw-step-actions"]');
    if (actions) rail.append(actions);
    const cue = railBody.querySelector('[data-placement-hook="pw-overflow-cue"]');
    if (cue) rail.insertBefore(cue, actions);
    railBody.tabIndex = 0; railBody.setAttribute('aria-label', 'Placement details');
    for (const details of root.querySelectorAll<HTMLDetailsElement>('details')) {
      if (openDetails.has(details.getAttribute(HOOK))) details.open = true;
    }
    railBody.scrollTop = railScroll;
    if (deps.sharedSurface) {
      const modelBar = main.querySelector<HTMLElement>('.model-placement-toolbar');
      const toolbar = modelBar ?? main.querySelector<HTMLElement>('[role="toolbar"]') ?? main;
      const contextHost = modelBar ? deps.sharedSurface.stage : main;
      contextPanel = createCanvasContextPanel({host: contextHost, toolbar, id:'placement-context', label:'Artwork & logos'});
      contextPanel.content.classList.add('canvas-context-content');
      contextPanel.content.append(rail);
      contextPanel.trigger.className = 'pw-secondary';
      const oldDetails = modelBar?.querySelector('[data-placement-hook="pw-model-details"]'); oldDetails?.remove();
      modelBar?.querySelector('[data-placement-hook="pw-model-save-job"]')?.remove();
      modelBar?.querySelector('[data-placement-hook="pw-model-expand"]')?.remove();
      contextPanel.trigger.setAttribute('data-placement-hook','pw-model-details');
      if (actions) wrap.append(actions);
      if (cue) cue.remove();
      if (contextOpen || addOpen || measureOpen) contextPanel.open('Logo details');

    }
    deps.onRendered?.();
    restoreFocus(memory);
    fitWorkspace();
  }

  function fitWorkspace(): void {
    if (root.getClientRects().length === 0) return;
    root.style.setProperty("--pw-workspace-height", `${Math.max(300, window.innerHeight - root.getBoundingClientRect().top - 12)}px`);
  }
  window.addEventListener("resize", fitWorkspace, { signal: aborter.signal });

  /** Included scope for chooser lists, or null for the full catalogue. */
  function includedScope(): { products: Set<string>; configurations: Set<string> } | null {
    try {
      const scope = deps.getIncludedScope?.();
      if (scope === undefined || scope === null) return null;
      return { products: new Set(scope.productIds), configurations: new Set(scope.configurationIds) };
    } catch {
      return null;
    }
  }

  function isExcludedScope(configuration: Configuration): boolean {
    const scope = includedScope();
    return scope !== null && (!scope.products.has(configuration.productId) ||
      !scope.configurations.has(configuration.id));
  }

  function excludedScopeMessage(project: ProjectDocument, productId: string, variantId: string): string {
    const product = project.products.find((entry) => entry.id === productId);
    const productName = product?.name?.trim() || 'This product';
    const optionName = product ? displayVariantName(product, variantId) : null;
    const name = optionName ? `${productName} (${optionName})` : productName;
    return `Adding a logo is blocked because ${name} is excluded from this customer file. ` +
      'Include it in Prepare job or choose an included product and option.';
  }
  /**
   * Chooser products: the included scope, plus the live selection and any
   * product with authored placements (never stranded by narrowing). A null
   * scope means the full editable catalogue.
   */
  function optionProducts(project: ProjectDocument): ProductDefinition[] {
    const scope = includedScope();
    let selectedProduct = '';
    try {
      selectedProduct = deps.getSelection().productId;
    } catch { selectedProduct = ''; }
    const withPlacements = new Set<string>();
    for (const configuration of project.configurations) {
      if (configuration.placements.length > 0) withPlacements.add(configuration.productId);
    }
    const seen = new Set<string>();
    const out: ProductDefinition[] = [];
    for (const configuration of project.configurations) {
      if (seen.has(configuration.productId)) continue;
      if (
        scope !== null &&
        !(scope.products.has(configuration.productId) && scope.configurations.has(configuration.id)) &&
        configuration.productId !== selectedProduct &&
        !withPlacements.has(configuration.productId)
      ) continue;
      seen.add(configuration.productId);
      const product = project.products.find((entry) => entry.id === configuration.productId);
      if (product !== undefined) out.push(product);
    }
    return out;
  }

  /**
   * Chooser options: configured variants in the included scope, plus the
   * selected variant and any variant with authored placements (never
   * stranded by narrowing). A null scope means the full catalogue.
   */
  function optionVariants(project: ProjectDocument, productId: string): Array<{ id: string; name: string }> {
    const product = project.products.find((entry) => entry.id === productId);
    if (product === undefined) return [];
    const withConfig = new Set(
      project.configurations
        .filter((entry) => entry.productId === productId)
        .map((entry) => entry.variantId),
    );
    const scope = includedScope();
    let selection: { productId: string; variantId: string } | null = null;
    try {
      const current = deps.getSelection();
      selection = { productId: current.productId, variantId: current.variantId };
    } catch { selection = null; }
    const withPlacements = new Set<string>();
    for (const configuration of project.configurations) {
      if (configuration.productId === productId && configuration.placements.length > 0) {
        withPlacements.add(configuration.variantId);
      }
    }
    // Display-only option labels via the shared contract: human name when
    // set, `Option N` for unnamed multi-option variants, never a raw id.
    return product.variants
      .filter((variant) => {
        if (!withConfig.has(variant.id)) return false;
        if (scope === null) return true;
        if (selection !== null && selection.productId === productId && selection.variantId === variant.id) return true;
        if (withPlacements.has(variant.id)) return true;
        return project.configurations.some((entry) =>
          entry.productId === product.id && entry.variantId === variant.id &&
          scope.products.has(entry.productId) && scope.configurations.has(entry.id));
      })
      .map((variant) => ({ id: variant.id, name: displayVariantName(product, variant.id) ?? 'Standard option' }));
  }

  function renderHeader(wrap: HTMLElement): void {
    const { project, selection } = currentContext();
    const title = el('h2', '', 'pw-title');
    title.textContent = 'Set up & place logos';
    wrap.append(title);
    const products = optionProducts(project);
    const headerRow = el('div', 'pw-row pw-header', 'pw-header');
    let needsHeader = false;
    if (products.length > 1) {
      needsHeader = true;
      const label = el('label', 'pw-field', 'pw-product-field');
      label.textContent = 'Product';
      const select = el('select', '', 'pw-product-select') as HTMLSelectElement;
      for (const product of products) {
        const option = document.createElement('option');
        option.value = product.id;
        option.textContent = product.name?.trim() || 'Unnamed product';
        select.append(option);
      }
      select.value = selection.productId;
      select.addEventListener('change', () => {
        const variants = optionVariants(deps.getProject(), select.value);
        const first = variants[0];
        deps.setSelection({
          productId: select.value,
          variantId: first?.id ?? selection.variantId,
          placementId: null,
        });
        viewOverride = null;
        update();
      });
      label.append(select);
      headerRow.append(label);
    }
    const variants = optionVariants(project, selection.productId);
    if (variants.length > 1) {
      needsHeader = true;
      const label = el('label', 'pw-field', 'pw-option-field');
      label.textContent = 'Option';
      const select = el('select', '', 'pw-option-select') as HTMLSelectElement;
      for (const variant of variants) {
        const option = document.createElement('option');
        option.value = variant.id;
        option.textContent = variant.name;
        select.append(option);
      }
      select.value = selection.variantId;
      select.addEventListener('change', () => {
        deps.setSelection({ variantId: select.value, placementId: null });
        viewOverride = null;
        update();
      });
      label.append(select);
      headerRow.append(label);
    }
    const kind = productForSelection(project, selection) !== null
      ? deps.getProductMediaKind(selection.productId)
      : 'none';
    const views = deps.getProductViews(selection.productId);
    if (views.length > 1) {
      needsHeader = true;
      const tabs = el('div', 'pw-tabs', 'pw-view-tabs') as HTMLElement;
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Product views');
      for (const view of views) {
        const tab = el('button', 'pw-tab', `pw-view-tab-${view.id}`) as HTMLButtonElement;
        tab.type = 'button';
        tab.textContent = view.label;
        tab.setAttribute('role', 'tab');
        const active = (selection.viewId ?? views[0]?.id ?? null) === view.id;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) tab.classList.add('is-active');
        tab.addEventListener('click', () => {
          deps.setSelection({ viewId: view.id });
          viewOverride = null;
          update();
        });
        tabs.append(tab);
      }
      headerRow.append(tabs);
    }
    if (kind === 'model') {
      needsHeader = true;
      const label = el('p', 'pw-muted', 'pw-model-label');
      const scene = deps.getModelScene?.(selection.productId, selection.variantId);
      label.textContent = scene && scene.regions.length > 0 ? 'Place logos on the product' : scene ? 'Model preview — measurements/safe area needed' : 'Measured placement diagram';
      headerRow.append(label);
      if (deps.onViewModel !== undefined && (!scene || scene.regions.length === 0)) {
        const view = el('button', 'pw-tab', 'pw-view-model') as HTMLButtonElement;
        view.type = 'button';
        view.textContent = 'View model';
        view.addEventListener('click', () => {
          try {
            deps.onViewModel?.(selection.productId);
          } catch { /* viewer handoff is lead-owned */ }
        });
        headerRow.append(view);
      }
    }
    if (needsHeader && !deps.sharedSurface) wrap.append(headerRow);
  }

  function productForSelection(
    project: ProjectDocument,
    selection: PlacementWorkspaceSelection,
  ): ProductDefinition | null {
    return project.products.find((entry) => entry.id === selection.productId) ?? null;
  }

  function activeViewId(views: PlacementProductView[], selection: PlacementWorkspaceSelection): string | null {
    if (views.length === 0) return null;
    if (selection.viewId !== null && views.some((view) => view.id === selection.viewId)) {
      return selection.viewId;
    }
    return views[0]?.id ?? null;
  }

  function stageRegion(): Region | null {
    const { product, selection, placement } = currentContext();
    if (product === null) return null;
    if (placement !== null) {
      const region = product.regions.find((entry) => entry.id === placement.regionId);
      if (region !== undefined) return region;
    }
    const areas = configuredAreas(product, selection.variantId);
    return areas[0] ?? product.regions.find((entry) =>
      product.variants.find((variant) => variant.id === selection.variantId)?.regionIds.includes(entry.id),
    ) ?? null;
  }

  function renderStage(main: HTMLElement): void {
    stageAborter?.abort(); stageAborter = new AbortController();
    const stageSignal = stageAborter.signal;
    stageDropPoint = null;
    const context = currentContext();
    const { project, selection, product, placementIndex } = context;
    const configuration = context.configuration === null ? null : { ...context.configuration,
      placements: context.configuration.placements.map((entry, index) => candidatePlacement(context.configuration!.id, entry, index)),
    };
    const placement = context.placement === null || !configuration ? null : candidatePlacement(configuration.id, context.placement, placementIndex);
    if (product === null || configuration === null) {
      const note = el('p', 'pw-muted', 'pw-stage-empty');
      note.textContent = 'Include at least one product to continue.';
      main.append(note);
      return;
    }
    const region = stageRegion();
    const modelScene = deps.getModelScene?.(selection.productId, selection.variantId) ?? null;
    const calibrated = modelScene !== null && region !== null && modelScene.regions.some((entry) => entry.id === region.id);
    if (modelScene) {
      main.parentElement?.classList.add('pw-product-workspace');
      modelViewDisplayOnly = !calibrated;
      if (!modelView) modelView = createModelPlacementView({
        ...(deps.sharedSurface ? {sharedSurface: deps.sharedSurface} : {}),
        anchor: (regionId, pos, name) => {
          if (modelViewDisplayOnly) return;
          const context = currentContext(); const config = context.configuration;
          if (!config || !deps.addAnchor) return;
          deps.addAnchor({ name, productId: config.productId, variantId: config.variantId, regionId, posMm: [pos.xMm, pos.yMm] });
          announce(`Reference point “${name}” added. Choose an artwork edge to save a placement measurement.`); update();
        },
        select: (index) => {
          const context = currentContext(); const entry = context.configuration?.placements[index];
          if (!entry) return;
          deps.setSelection({ placementId: entry.id ?? `index:${index}` }); update();
        },
        move: (index, pos) => {
          if (modelViewDisplayOnly) return;
          const context = currentContext(); const config = context.configuration; const entry = config?.placements[index];
          if (!config || !entry) return;
          if (Math.abs(pos.xMm - entry.pos.xMm) < 1e-9 && Math.abs(pos.yMm - entry.pos.yMm) < 1e-9) return;
          try {
            const candidate = candidatePlacement(config.id, entry, index);
            const next = updatePlacementInConfig(context.project, config.id, placementSelector(entry, index), { pos, widthMm: candidate.widthMm, heightMm: candidate.heightMm, rotationDeg: candidate.rotationDeg });
            if (commitNext('Move logo on product', next)) {
              // Reconcile staged centre fields so a later Apply cannot
              // overwrite this drag with stale coordinates.
              const stagedEdit = staged.get(placementKeyOf(config.id, entry, index));
              if (stagedEdit !== undefined) {
                stagedEdit.centreXRaw = String(pos.xMm);
                stagedEdit.centreYRaw = String(pos.yMm);
              }
              announce('Logo moved on the product.'); update();
            }
          } catch (error) { announce(`Move blocked: ${error instanceof Error ? error.message : String(error)}`); update(); }
        },
        commit: (index, patch) => {
          if (modelViewDisplayOnly) return;
          const context = currentContext(); const config = context.configuration; const entry = config?.placements[index];
          if (!config || !entry) return;
          const candidate = candidatePlacement(config.id, entry, index);
          const nextPatch: { pos?: { xMm: number; yMm: number }; widthMm?: number; heightMm?: number; rotationDeg?: number } = { pos: candidate.pos, widthMm: candidate.widthMm, heightMm: candidate.heightMm, rotationDeg: candidate.rotationDeg };
          if (patch.pos && (Math.abs(patch.pos.xMm - entry.pos.xMm) > 1e-9 || Math.abs(patch.pos.yMm - entry.pos.yMm) > 1e-9)) nextPatch.pos = patch.pos;
          if (patch.widthMm !== undefined && Math.abs(patch.widthMm - entry.widthMm) > 1e-9) nextPatch.widthMm = patch.widthMm;
          if (patch.heightMm !== undefined && Math.abs(patch.heightMm - entry.heightMm) > 1e-9) nextPatch.heightMm = patch.heightMm;
          if (patch.rotationDeg !== undefined && Math.abs(patch.rotationDeg - entry.rotationDeg) > 1e-9) nextPatch.rotationDeg = patch.rotationDeg;
          if (Object.keys(nextPatch).length === 0) return;
          try {
            const next = updatePlacementInConfig(context.project, config.id, placementSelector(entry, index), nextPatch);
            if (commitNext('Edit logo on product', next)) {
              // Reconcile staged fields with the committed drag instead of
              // dropping them: a later Apply must not resurrect stale values.
              const stagedEdit = staged.get(placementKeyOf(config.id, entry, index));
              if (stagedEdit !== undefined) {
                const updated = next.configurations.find((c) => c.id === config.id)?.placements[index];
                if (updated !== undefined) {
                  stagedEdit.centreXRaw = String(updated.pos.xMm);
                  stagedEdit.centreYRaw = String(updated.pos.yMm);
                  stagedEdit.widthRaw = String(updated.widthMm);
                  stagedEdit.heightRaw = String(updated.heightMm);
                  stagedEdit.rotationRaw = String(updated.rotationDeg);
                }
              }
              announce('Logo updated on the product.'); update();
            }
          } catch (error) { announce(`Edit blocked: ${error instanceof Error ? error.message : String(error)}`); update(); }
        },
        status: (message) => announce(message),
        preview: (index, patch) => {
          if (modelViewDisplayOnly) return;
          const context = currentContext();
          if (index !== context.placementIndex) return;
          const set = (hook: string, value: number): void => {
            const input = root.querySelector<HTMLInputElement>(`[${HOOK}="${hook}"]`);
            if (input !== null) {
              input.value = String(Math.round(value * 100) / 100);
            }
          };
          if (patch.pos !== undefined) { set('pw-x', patch.pos.xMm); set('pw-y', patch.pos.yMm); }
          if (patch.widthMm !== undefined) set('pw-width', patch.widthMm);
          if (patch.heightMm !== undefined) set('pw-height', patch.heightMm);
          if (patch.rotationDeg !== undefined) set('pw-rotation', patch.rotationDeg);
        },
        expand: () => deps.toggleExpanded ? deps.toggleExpanded() : expansion.toggle(),
        isExpanded: () => deps.isExpanded ? deps.isExpanded() : expansion.expanded(),
        toggleDetails: () => {
          if (contextPanel) { if (contextPanel.isOpen()) contextPanel.close(); else contextPanel.open(); return contextPanel.isOpen(); }
          return root.classList.toggle('show-placement-details');
        },
        ...(deps.onSaveJob ? { save: () => deps.onSaveJob?.() } : {}),
      });
      stageDropPoint = calibrated ? (x, y) => modelView?.dropPoint(x, y) ?? null : null;
      main.append(modelView.element);
      const viewScene = calibrated ? modelScene : { ...modelScene, regions: [] };
      const modelAnchors = viewScene.regions.flatMap((area) => deps.getAnchors(selection.productId, selection.variantId, area.id).flatMap((anchor) => {
        const model = modelPointFromMm(area.frame, anchor.posMm[0], anchor.posMm[1]);
        return model ? [{ id: anchor.id, model, regionId: area.id }] : [];
      }));
      modelView.update({ scene: viewScene, anchors: modelAnchors, selectedIndex: placementIndex, activeRegionId: calibrated && region ? region.id : null, status,
        revision: JSON.stringify([modelScene.key, modelScene.regions, configuration.id, project.revision, configuration.placements]),
        items: (calibrated ? configuration.placements : []).map((entry, index) => {
          const policy = lockFor(configuration.id, entry, index);
          return { index, placement: candidatePlacement(configuration.id, entry, index), imageSrc: deps.getLogoImage(entry.logoId)?.src ?? null,
            fits: product.regions.some((area) => area.id === entry.regionId && evaluatePlacementGeometry(area, entry).ok),
            lock: policy.locked && Number.isFinite(policy.ratio) && policy.ratio > 0 ? { ratio: policy.ratio } : null };
        }),
      });
      modelView.element.dataset.calibrated = String(calibrated);
      const moveTool = modelView.element.querySelector<HTMLButtonElement>('[data-placement-hook="pw-model-move"]');
      if (moveTool) moveTool.disabled = !calibrated;
      if (!calibrated) {
        const configured = configuredAreas(product, selection.variantId);
        const setupRegion = region !== null && configured.some((area) => area.id === region.id) ? region : null;
        const productName = product.name?.trim() || 'this product';
        const setupNote = el('p', 'pw-error', 'pw-stage-message');
        let setupRegionId: string | undefined;
        if (setupRegion === null) {
          setupNote.textContent =
            `Add a safe area for ${productName} before placing a logo.`;
          setupRegionId = undefined;
        } else {
          // A saved area can be present but unusable here (missing or stale
          // calibration): the setup screen owns Fit and recompute, so name
          // that route instead of only saying measurements are missing.
          setupNote.textContent =
            `Set up measurements for ${productName} before placing a logo. ` +
            `If a saved area exists, open product setup to fit the scale, then recompute stale areas.`;
          setupRegionId = setupRegion.id;
        }
        main.append(setupNote);
        const setupControls = el('div', 'pw-row');
        const setupButton = el('button', 'pw-secondary', 'pw-stage-setup') as HTMLButtonElement;
        setupButton.type = 'button';
        setupButton.textContent = 'Set up product';
        setupButton.addEventListener('click', () => {
          if (setupRegionId === undefined) deps.requestProductSetup(selection.productId, selection.variantId);
          else deps.requestProductSetup(selection.productId, selection.variantId, setupRegionId);
        });
        setupControls.append(setupButton);
        main.append(setupControls);
      }
      return;
    }
    modelView?.destroy(); modelView = null; modelViewDisplayOnly = false;
    const views = deps.getProductViews(selection.productId);
    const viewId = activeViewId(views, selection);
    let overlay: PlacementStageOverlay | null = null;
    if (region !== null) {
      try {
        overlay = deps.getStageOverlay(selection.productId, selection.variantId, region.id, viewId);
      } catch {
        overlay = null;
      }
    }
    const box = el('div', 'pw-stage', 'pw-stage');
    const svg = svgEl('svg', { tabindex: '0', role: 'img' }) as SVGSVGElement;
    mark(svg, 'pw-stage-svg');
    svg.setAttribute('aria-label', overlay !== null
      ? `Calibrated product overlay for ${region?.name?.trim() || 'unnamed area'} with logo placements.`
      : `Authoritative region-millimetre diagram for ${region?.name?.trim() || 'unnamed area'} with logo placements.`);
    box.append(svg);
    main.append(box);

    const areas = configuredAreas(product, selection.variantId);
    const footprintPts: StagePoint[] = [];
    for (const area of areas) {
      for (const point of area.safeArea) footprintPts.push({ x: point[0]!, y: point[1]! });
    }
    const anchors = region !== null
      ? deps.getAnchors(selection.productId, selection.variantId, region.id)
        .filter((anchor) => anchor.productId === selection.productId &&
          anchor.variantId === selection.variantId && anchor.regionId === region.id)
      : [];
    for (const anchor of anchors) footprintPts.push({ x: anchor.posMm[0]!, y: anchor.posMm[1]! });
    for (const entry of configuration.placements) {
      for (const corner of rotatedFootprintCorners(
        entry.pos.xMm, entry.pos.yMm, entry.widthMm, entry.heightMm, entry.rotationDeg,
      )) footprintPts.push({ x: corner.x, y: corner.y });
    }
    const mapping: StageMapping = overlay !== null
      ? overlayMapping(overlay, footprintPts)
      : diagramMapping(footprintPts);

    const cacheKey = `${configuration.id} ${(region?.id) ?? 'none'} ${viewId ?? 'default'}`;
    const bounds = mapping.contentBounds();
    const fallback = { cx: 0, cy: 0, span: 100 };
    let view = viewOverride ?? viewCache.get(cacheKey) ?? null;
    if (bounds !== null) {
      const spanX = Math.max(bounds.maxX - bounds.minX, 10);
      const spanY = Math.max(bounds.maxY - bounds.minY, 10);
      const fit = {
        cx: (bounds.minX + bounds.maxX) / 2,
        cy: (bounds.minY + bounds.maxY) / 2,
        span: Math.max(spanX, spanY) * 1.2,
      };
      if (view === null) {
        view = fit;
        viewCache.set(cacheKey, fit);
      }
    } else if (view === null) {
      view = fallback;
    }
    const current = view ?? fallback;
    const aspectFix = 4 / 3;
    const half = current.span / 2;
    svg.setAttribute('viewBox', `${current.cx - half * aspectFix} ${current.cy - half} ${current.span * aspectFix} ${current.span}`);
    const cssUnits = (pixels: number): number => {
      const matrix = svg.getScreenCTM();
      const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
      return scale > 0 ? pixels / scale : current.span * pixels / 500;
    };

    if (overlay !== null) {
      const image = svgEl('image', {
        x: '0',
        y: '0',
        width: String(overlay.imageWidthPx),
        height: String(overlay.imageHeightPx),
        href: overlay.imageSrc,
      });
      image.setAttribute(HOOK, 'pw-overlay-image');
      (image as SVGImageElement).setAttribute('aria-label', overlay.alt);
      svg.append(image);
    }
    if (overlay !== null && overlay.mappingStatus === 'provisional') {
      const note = el('p', 'pw-muted', 'pw-overlay-provisional');
      note.textContent = 'Provisional calibrated preview — verify physical measurements before production.';
      box.append(note);
    }

    for (const area of areas) {
      const mapped: StagePoint[] = [];
      for (const point of area.safeArea) {
        const svgPt = mapping.toSvg(point[0]!, point[1]!);
        if (svgPt !== null) mapped.push(svgPt);
      }
      if (mapped.length < 3) continue;
      const isActive = region !== null && area.id === region.id;
      const polygon = svgEl('polygon', {
        points: mapped.map((point) => `${point.x},${point.y}`).join(' '),
        fill: isActive ? 'rgba(11,108,171,0.08)' : 'none',
        stroke: isActive ? '#0b6cab' : '#9aa8b4',
        'stroke-width': String(current.span / 400),
      });
      mark(polygon, `pw-area-${area.id}`);
      const title = svgEl('title', {});
      title.textContent = area.name?.trim() || 'Unnamed area';
      polygon.append(title);
      svg.append(polygon);
      const labelAt = mapped[0]!;
      const tag = svgEl('text', {
        x: String(labelAt.x),
        y: String(labelAt.y - current.span / 100),
        'font-size': String(Math.max(current.span / 40, 1)),
        fill: '#0b6cab',
      });
      tag.textContent = area.name?.trim() || 'Unnamed area';
      svg.append(tag);
      for (const exclusion of area.exclusions ?? []) {
        const exclMapped: StagePoint[] = [];
        for (const point of exclusion) {
          const svgPt = mapping.toSvg(point[0]!, point[1]!);
          if (svgPt !== null) exclMapped.push(svgPt);
        }
        if (exclMapped.length < 3) continue;
        svg.append(svgEl('polygon', {
          points: exclMapped.map((point) => `${point.x},${point.y}`).join(' '),
          fill: 'none',
          stroke: '#a53a32',
          'stroke-width': String(current.span / 400),
          'stroke-dasharray': `${current.span / 100} ${current.span / 150}`,
        }));
      }
    }

    for (const [index, entry] of [...configuration.placements.entries()].sort(([a], [b]) => Number(a === placementIndex) - Number(b === placementIndex))) {
      const corners = rotatedFootprintCorners(
        entry.pos.xMm, entry.pos.yMm, entry.widthMm, entry.heightMm, entry.rotationDeg,
      );
      const mapped: StagePoint[] = [];
      for (const corner of corners) {
        const svgPt = mapping.toSvg(corner.x, corner.y);
        if (svgPt !== null) mapped.push(svgPt);
      }
      if (mapped.length < 3) continue;
      const isSelected = placement !== null && placementIndex === index;
      // Original raster artwork inside the placement footprint (beneath the
      // selection outline): canonical mm geometry through the evaluated
      // stage mapping and rotation, no pixels for scale. Non-interactive so
      // drag/selection hit targets never change; missing art keeps the
      // labelled outline fallback drawn below.
      //
      // Corner order is bottom-left, bottom-right, top-right, top-left in the
      // Y-up region frame, so image UV top-left (0,0) maps to q3 with right
      // basis q2-q3 and down basis q0-q3 — never the vertical mirror that
      // mapping UV (0,0) to q0 would produce.
      try {
        const artwork = deps.getLogoImage(entry.logoId);
        if (artwork !== null) {
          const corners = rotatedFootprintCorners(
            entry.pos.xMm, entry.pos.yMm, entry.widthMm, entry.heightMm, entry.rotationDeg,
          );
          const quad: StagePoint[] = [];
          for (const corner of corners) {
            const svgPt = mapping.toSvg(corner.x, corner.y);
            if (svgPt === null) break;
            quad.push(svgPt);
          }
          if (quad.length === 4) {
            const [q0, , q2, q3] = quad as [StagePoint, StagePoint, StagePoint, StagePoint];
            const det = (q2.x - q3.x) * (q0.y - q3.y) - (q0.x - q3.x) * (q2.y - q3.y);
            if (Number.isFinite(det) && Math.abs(det) > 1e-9) {
              const node = svgEl('image', {
                x: '0',
                y: '0',
                width: '1',
                height: '1',
                preserveAspectRatio: 'none',
                href: artwork.src,
              });
              node.setAttribute('transform', `matrix(${q2.x - q3.x} ${q2.y - q3.y} ${q0.x - q3.x} ${q0.y - q3.y} ${q3.x} ${q3.y})`);
              node.setAttribute('pointer-events', 'none');
              node.setAttribute('aria-hidden', 'true');
              mark(node, `pw-artwork-${entry.id ?? `index:${index}`}`);
              svg.append(node);
            }
          }
        }
      } catch {
        // Artwork is display-only; the labelled outline below always renders.
      }
      const polygon = svgEl('polygon', {
        points: mapped.map((point) => `${point.x},${point.y}`).join(' '),
        fill: isSelected ? 'rgba(210,10,46,0.12)' : 'rgba(210,10,46,0.04)',
        stroke: '#d20a2e',
        'stroke-width': String(isSelected ? current.span / 250 : current.span / 400),
      });
      mark(polygon, `pw-footprint-${entry.id ?? `index:${index}`}`);
      polygon.setAttribute('data-placement-index', String(index));
      const title = svgEl('title', {});
      title.textContent = logoNameOf(project, entry.logoId);
      polygon.append(title);
      svg.append(polygon);
    }

    for (const anchor of anchors) {
      const svgPt = mapping.toSvg(anchor.posMm[0]!, anchor.posMm[1]!);
      if (svgPt === null) continue;
      const size = cssUnits(7);
      const dot = svgEl('rect', {
        x: String(svgPt.x - size / 2),
        y: String(svgPt.y - size / 2),
        width: String(size),
        height: String(size),
        fill: '#fff',
        stroke: '#0b6cab',
        'stroke-width': String(Math.max(current.span / 600, 0.2)),
      });
      dot.setAttribute('pointer-events', 'none');
      mark(dot, `pw-anchor-${anchor.id}`);
      const title = svgEl('title', {});
      title.textContent = anchor.name;
      dot.append(title);
      svg.append(dot);
    }

    const safeMm: Array<[number, number]> = region !== null
      ? region.safeArea.filter((pt): pt is [number, number] =>
        Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
      : [];
    const measureGroup = svgEl('g', { 'pointer-events': 'none' });
    svg.append(measureGroup);
    const paintMeasurements = (shown: Placement): void => {
      measureGroup.replaceChildren();
      if (region === null) return;
      const bindings = bindingsForPlacement(configuration.id, configuration.placements, placementIndex);
      const scopedAnchors = anchors;
      for (const binding of bindings) {
        const anchor = scopedAnchors.find((entry) => entry.id === binding.anchorId);
        if (anchor === undefined) continue;
        const footprint = rotatedFootprintCorners(
          shown.pos.xMm, shown.pos.yMm,
          shown.widthMm, shown.heightMm, shown.rotationDeg,
        ).map((corner) => ({ x: corner.x, y: corner.y }));
        const measured = measureEdgeToAnchor(
          footprint,
          { x: anchor.posMm[0]!, y: anchor.posMm[1]! },
          { edge: binding.edge, convention: binding.convention },
        );
        if (!measured.ok) continue;
        const start = mapping.toSvg(measured.endpoints[0].x, measured.endpoints[0].y);
        const end = mapping.toSvg(measured.endpoints[1].x, measured.endpoints[1].y);
        if (start === null || end === null) continue;
        measureGroup.append(svgEl('line', {
          x1: String(start.x),
          y1: String(start.y),
          x2: String(end.x),
          y2: String(end.y),
          stroke: '#227443',
          'stroke-width': String(Math.max(current.span / 500, 0.25)),
        }));
        const label = svgEl('text', {
          x: String((start.x + end.x) / 2),
          y: String((start.y + end.y) / 2),
          'font-size': String(cssUnits(12)),
          fill: '#227443', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': String(cssUnits(3)),
        });
        label.textContent = `${displayMm(measured.valueMm)} mm`;
        label.setAttribute('aria-hidden', 'true');
        mark(label, 'pw-anchor-measure-label');
        measureGroup.append(label);
      }
      // Four corner-to-nearest-safe-segment measurements for the selection.
      // Compact labels render smaller than anchor measurement labels.
      if (safeMm.length >= 3) {
        const measures = cornerSafeMeasurements(
          { cx: shown.pos.xMm, cy: shown.pos.yMm, widthMm: shown.widthMm, heightMm: shown.heightMm, rotationDeg: shown.rotationDeg },
          safeMm,
        );
        for (const m of measures) {
          const a = mapping.toSvg(m.corner.x, m.corner.y);
          const b = mapping.toSvg(m.nearest.x, m.nearest.y);
          if (a === null || b === null) continue;
          const cline = svgEl('line', {
            x1: String(a.x), y1: String(a.y), x2: String(b.x), y2: String(b.y),
            stroke: '#6d4c00',
            'stroke-width': String(Math.max(current.span / 600, 0.2)),
            'stroke-dasharray': `${current.span / 200} ${current.span / 250}`,
          });
          cline.setAttribute('aria-hidden', 'true');
          mark(cline, `pw-corner-line-${m.cornerIndex}`);
          measureGroup.append(cline);
          const tag = svgEl('text', {
            x: String((a.x + b.x) / 2),
            y: String((a.y + b.y) / 2),
            'font-size': String(cssUnits(10)),
            fill: '#6d4c00', 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': String(cssUnits(3)),
          });
          tag.textContent = `${displayMm(m.distanceMm)} mm`;
          tag.setAttribute('aria-hidden', 'true');
          mark(tag, `pw-corner-dist-${m.cornerIndex}`);
          measureGroup.append(tag);
        }
      }
    };
    if (placement !== null) paintMeasurements(placement);

    /* Pointer gestures: footprint drag moves (mm via caller mapping);
       corner handles resize, top handle rotates; empty-space drag pans;
       wheel zooms. View changes never touch mm. Shift = unsnapped fine adjust. */
    interface DragCandidate { pos: { xMm: number; yMm: number }; widthMm: number; heightMm: number; rotationDeg: number }
    type StageDrag =
      | { kind: 'move'; index: number; startMm: { xMm: number; yMm: number }; startRevision: number; base: DragCandidate }
      | { kind: 'resize'; index: number; corner: number; startRevision: number; base: DragCandidate }
      | { kind: 'rotate'; index: number; offsetDeg: number; startRevision: number; base: DragCandidate }
      | { kind: 'pan'; startX: number; startY: number; origCx: number; origCy: number } | null;
    let drag: StageDrag = null;
    let moved = false;
    let gesturePointer: number | null = null;
    let ghostGuides: Array<{ a: StagePoint; b: StagePoint; center?: boolean }> = [];

    // Visible accessible handles on the selected logo (direct manipulation).
    if (placement !== null && placementIndex >= 0 && region !== null) {
      const corners = rotatedFootprintCorners(
        placement.pos.xMm, placement.pos.yMm, placement.widthMm, placement.heightMm, placement.rotationDeg,
      );
      const mappedCorners: StagePoint[] = [];
      for (const corner of corners) {
        const svgPt = mapping.toSvg(corner.x, corner.y);
        if (svgPt === null) break;
        mappedCorners.push(svgPt);
      }
      if (mappedCorners.length === 4) {
        const handleSize = cssUnits(12);
        for (let i = 0; i < 4; i += 1) {
          const pt = mappedCorners[i]!;
          const handle = svgEl('rect', {
            x: String(pt.x - handleSize / 2), y: String(pt.y - handleSize / 2),
            width: String(handleSize), height: String(handleSize),
            fill: '#fff', stroke: '#d20a2e', 'stroke-width': String(Math.max(current.span / 500, 0.2)),
          });
          handle.setAttribute('data-handle-kind', 'resize');
          handle.setAttribute('data-corner', String(i));
          handle.setAttribute('data-placement-index', String(placementIndex));
          handle.setAttribute('tabindex', '0');
          handle.setAttribute('role', 'button');
          handle.setAttribute('aria-label', `Resize logo from corner ${i + 1}. Drag or use arrow keys.`);
          mark(handle, `pw-resize-handle-${i}`);
          const title = svgEl('title', {});
          title.textContent = `Resize corner ${i + 1}`;
          handle.append(title);
          svg.append(handle);
        }
        const topMid = {
          x: (mappedCorners[2]!.x + mappedCorners[3]!.x) / 2,
          y: (mappedCorners[2]!.y + mappedCorners[3]!.y) / 2,
        };
        const centre = mappedCorners.length === 4
          ? { x: (mappedCorners[0]!.x + mappedCorners[2]!.x) / 2, y: (mappedCorners[0]!.y + mappedCorners[2]!.y) / 2 }
          : topMid;
        const length = Math.hypot(topMid.x - centre.x, topMid.y - centre.y);
        const gap = cssUnits(28);
        const rotatePt = {
          x: topMid.x + (length > 1e-9 ? (topMid.x - centre.x) / length : 0) * gap,
          y: topMid.y + (length > 1e-9 ? (topMid.y - centre.y) / length : -1) * gap,
        };
        const stem = svgEl('line', { x1: String(topMid.x), y1: String(topMid.y), x2: String(rotatePt.x), y2: String(rotatePt.y),
          stroke: '#64748b', 'stroke-width': String(cssUnits(1)), 'pointer-events': 'none' });
        mark(stem, 'pw-rotate-stem'); svg.append(stem);
        const rotateHandle = svgEl('circle', {
          cx: String(rotatePt.x), cy: String(rotatePt.y), r: String(cssUnits(7)),
          fill: '#fff', stroke: '#d20a2e', 'stroke-width': String(Math.max(current.span / 500, 0.2)),
        });
        rotateHandle.setAttribute('data-handle-kind', 'rotate');
        rotateHandle.setAttribute('data-placement-index', String(placementIndex));
        rotateHandle.setAttribute('tabindex', '0');
        rotateHandle.setAttribute('role', 'button');
        rotateHandle.setAttribute('aria-label', 'Rotate logo. Drag around centre, or use [ and ] keys for fine steps.');
        mark(rotateHandle, 'pw-rotate-handle');
        const rotateTitle = svgEl('title', {});
        rotateTitle.textContent = 'Rotate';
        rotateHandle.append(rotateTitle);
        svg.append(rotateHandle);
      }
    }

    const liveField = (hook: string, value: string): void => {
      const input = root.querySelector<HTMLInputElement>(`[${HOOK}="${hook}"]`);
      if (input !== null) input.value = value;
    };
    const reflectCandidate = (candidate: DragCandidate): void => {
      liveField('pw-width', String(Math.round(candidate.widthMm * 100) / 100));
      liveField('pw-height', String(Math.round(candidate.heightMm * 100) / 100));
      liveField('pw-rotation', String(Math.round(candidate.rotationDeg * 100) / 100));
      liveField('pw-x', String(Math.round(candidate.pos.xMm * 100) / 100));
      liveField('pw-y', String(Math.round(candidate.pos.yMm * 100) / 100));
    };

    const toSvgPoint = (clientX: number, clientY: number): StagePoint | null => {
      const ctm = svg.getScreenCTM();
      if (ctm === null) return null;
      try {
        const inverse = ctm.inverse();
        const point = new DOMPoint(clientX, clientY).matrixTransform(inverse);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
        return { x: point.x, y: point.y };
      } catch {
        return null;
      }
    };

    svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary || drag !== null) return;
      const target = event.target as Element | null;
      const handle = target?.closest?.('[data-handle-kind]');
      const svgPt = toSvgPoint(event.clientX, event.clientY);
      const startRevision = deps.getProject().revision;
      const handleKind = handle?.getAttribute('data-handle-kind');
      if (handleKind === 'resize' || handleKind === 'rotate') {
        const index = Number(handle?.getAttribute('data-placement-index'));
        const entry = configuration.placements[index];
        if (!Number.isInteger(index) || entry === undefined || svgPt === null) return;
        const mm = mapping.fromSvg(svgPt);
        if (mm === null) return;
        const base: DragCandidate = {
          pos: { xMm: entry.pos.xMm, yMm: entry.pos.yMm },
          widthMm: entry.widthMm, heightMm: entry.heightMm, rotationDeg: entry.rotationDeg,
        };
        if (handleKind === 'resize') {
          const corner = Number(handle?.getAttribute('data-corner'));
          if (!Number.isInteger(corner) || corner < 0 || corner > 3) return;
          drag = { kind: 'resize', index, corner, startRevision, base };
        } else {
          const pointerAngle = (Math.atan2(-(mm.yMm - base.pos.yMm), mm.xMm - base.pos.xMm) * 180) / Math.PI;
          drag = { kind: 'rotate', index, offsetDeg: base.rotationDeg - pointerAngle, startRevision, base };
        }
        // Direct manipulation is primary: drags work with staged numeric
        // edits present; the release commit reconciles staged fields.
        moved = false;
        deps.setSelection({ placementId: entry.id ?? `index:${index}` });
        gesturePointer = event.pointerId;
        svg.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const footprint = target?.closest?.('[data-placement-index]');
      if (footprint !== null && footprint !== undefined) {
        const index = Number(footprint.getAttribute('data-placement-index'));
        if (!Number.isInteger(index)) return;
        const entry = configuration.placements[index];
        if (entry === undefined || svgPt === null) return;
        const mm = mapping.fromSvg(svgPt);
        if (mm === null) return;
        drag = {
          kind: 'move',
          index,
          startMm: { xMm: entry.pos.xMm - mm.xMm, yMm: entry.pos.yMm - mm.yMm },
          startRevision,
          base: { pos: { xMm: entry.pos.xMm, yMm: entry.pos.yMm }, widthMm: entry.widthMm, heightMm: entry.heightMm, rotationDeg: entry.rotationDeg },
        };
        moved = false;
        gesturePointer = event.pointerId;
        svg.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      } else if (svgPt !== null) {
        drag = {
          kind: 'pan',
          startX: event.clientX,
          startY: event.clientY,
          origCx: current.cx,
          origCy: current.cy,
        };
        moved = false;
        gesturePointer = event.pointerId;
        svg.setPointerCapture?.(event.pointerId);
      }
    }, { signal: aborter.signal });

    svg.addEventListener('pointermove', (event) => {
      const activeDrag = drag;
      if (activeDrag === null || gesturePointer !== event.pointerId) return;
      const svgPt = toSvgPoint(event.clientX, event.clientY);
      if (svgPt === null) return;
      if (activeDrag.kind === 'pan') {
        const ctm = svg.getScreenCTM();
        if (ctm === null) return;
        const dxSvg = (event.clientX - activeDrag.startX) / ctm.a;
        const dySvg = (event.clientY - activeDrag.startY) / ctm.d;
        if (!Number.isFinite(dxSvg) || !Number.isFinite(dySvg)) return;
        current.cx = activeDrag.origCx - dxSvg;
        current.cy = activeDrag.origCy - dySvg;
        moved = true;
        paintView();
        return;
      }
      const mm = mapping.fromSvg(svgPt);
      if (mm === null) return;
      const entry = configuration.placements[activeDrag.index];
      if (entry === undefined) return;
      const unsnapped = event.shiftKey === true;
      if (activeDrag.kind === 'move') {
        const rawCx = mm.xMm + activeDrag.startMm.xMm;
        const rawCy = mm.yMm + activeDrag.startMm.yMm;
        if (!Number.isFinite(rawCx) || !Number.isFinite(rawCy)) return;
        const snapped = snapFootprint(
          { cx: rawCx, cy: rawCy, widthMm: activeDrag.base.widthMm, heightMm: activeDrag.base.heightMm, rotationDeg: activeDrag.base.rotationDeg },
          safeMm, { unsnapped, rotateTolDeg: 0 },
        );
        const candidate: DragCandidate = {
          pos: { xMm: snapped.cx, yMm: snapped.cy },
          widthMm: snapped.widthMm, heightMm: snapped.heightMm, rotationDeg: snapped.rotationDeg,
        };
        if (Math.abs(candidate.pos.xMm - entry.pos.xMm) > 1e-9 ||
          Math.abs(candidate.pos.yMm - entry.pos.yMm) > 1e-9 ||
          Math.abs(candidate.rotationDeg - entry.rotationDeg) > 1e-9) {
          moved = true;
          paintCandidateGhost(activeDrag.index, candidate, snapped.guides, unsnapped);
          reflectCandidate(candidate);
        }
      } else if (activeDrag.kind === 'resize') {
        // Unified transaction: a persisted lock makes 2D corner drags scale
        // uniformly from the opposite corner, like the 3D handles.
        const txBase = { xMm: activeDrag.base.pos.xMm, yMm: activeDrag.base.pos.yMm,
          widthMm: activeDrag.base.widthMm, heightMm: activeDrag.base.heightMm,
          rotationDeg: activeDrag.base.rotationDeg };
        const txResized = resizeCorner(
          beginEdit(txBase, lockFor(configuration.id, entry, activeDrag.index)),
          activeDrag.corner as 0 | 1 | 2 | 3, { xMm: mm.xMm, yMm: mm.yMm }).candidate;
        const resized = { cx: txResized.xMm, cy: txResized.yMm,
          widthMm: txResized.widthMm, heightMm: txResized.heightMm, rotationDeg: txResized.rotationDeg };
        const candidate: DragCandidate = { pos: { xMm: resized.cx, yMm: resized.cy },
          widthMm: resized.widthMm, heightMm: resized.heightMm, rotationDeg: resized.rotationDeg };
        moved = true;
        paintCandidateGhost(activeDrag.index, candidate, [], unsnapped);
        reflectCandidate(candidate);
      } else {
        const pointerAngle = (Math.atan2(-(mm.yMm - activeDrag.base.pos.yMm), mm.xMm - activeDrag.base.pos.xMm) * 180) / Math.PI;
        if (!Number.isFinite(pointerAngle)) return;
        const raw = pointerAngle + activeDrag.offsetDeg;
        const snapped = rotationSnapDeg(raw, safeMm, 2, unsnapped);
        const candidate: DragCandidate = {
          pos: { ...activeDrag.base.pos },
          widthMm: activeDrag.base.widthMm, heightMm: activeDrag.base.heightMm, rotationDeg: snapped.rotationDeg,
        };
        if (Math.abs(candidate.rotationDeg - entry.rotationDeg) > 1e-9 || !moved) {
          moved = true;
          paintCandidateGhost(activeDrag.index, candidate, snapped.guides, unsnapped);
          reflectCandidate(candidate);
        }
      }
    }, { signal: aborter.signal });

    let lastCandidate: DragCandidate | null = null;
    const currentCandidate = (): DragCandidate | null => {
      if (drag === null || drag.kind === 'pan' || !moved || lastCandidate === null) return null;
      return lastCandidate;
    };
    const finishDrag = (event: PointerEvent, commitDrag: boolean): void => {
      if (drag === null || gesturePointer !== event.pointerId) return;
      const finished = drag;
      const candidate = currentCandidate();
      drag = null;
      const pointer = gesturePointer; gesturePointer = null;
      if (pointer !== null && svg.hasPointerCapture(pointer)) svg.releasePointerCapture(pointer);
      clearGhost();
      lastCandidate = null;
      if (finished.kind === 'pan') {
        if (moved) {
          viewCache.set(cacheKey, { cx: current.cx, cy: current.cy, span: current.span });
          viewOverride = { cx: current.cx, cy: current.cy, span: current.span };
        }
        return;
      }
      if (!moved || candidate === null) {
        const entry = configuration.placements[finished.index];
        const id = entry?.id ?? `index:${finished.index}`;
        deps.setSelection({ placementId: id });
        measureDraft = null;
        update();
        return;
      }
      if (!commitDrag) {
        announce('Edit cancelled. Position unchanged.');
        update();
        return;
      }
      if (deps.getProject().revision !== finished.startRevision) {
        announce('Edit cancelled: the job changed while dragging. Position unchanged.');
        update();
        return;
      }
      const entry = configuration.placements[finished.index];
      if (entry === undefined) {
        update();
        return;
      }
      const patch: { pos: { xMm: number; yMm: number }; widthMm: number; heightMm: number; rotationDeg: number } = {
        pos: candidate.pos, widthMm: candidate.widthMm, heightMm: candidate.heightMm, rotationDeg: candidate.rotationDeg,
      };
      let next: ProjectDocument;
      try {
        next = updatePlacementInConfig(
          deps.getProject(),
          configuration.id,
          placementSelector(entry, finished.index),
          patch,
        );
      } catch (error) {
        announce(`Edit blocked: ${error instanceof Error ? error.message : String(error)}`);
        update();
        return;
      }
      if (commitNext(finished.kind === 'move' ? 'Move logo' : finished.kind === 'resize' ? 'Resize logo' : 'Rotate logo', next)) {
        // Reconcile staged fields with the committed drag (never drop them).
        const finishedEdit = staged.get(placementKeyOf(configuration.id, entry, finished.index));
        if (finishedEdit !== undefined) {
          const updated = next.configurations.find((c) => c.id === configuration.id)?.placements[finished.index];
          if (updated !== undefined) {
            finishedEdit.centreXRaw = String(updated.pos.xMm);
            finishedEdit.centreYRaw = String(updated.pos.yMm);
            finishedEdit.widthRaw = String(updated.widthMm);
            finishedEdit.heightRaw = String(updated.heightMm);
            finishedEdit.rotationRaw = String(updated.rotationDeg);
          }
        }
        const id = entry.id ?? `index:${finished.index}`;
        deps.setSelection({ placementId: id });
        announce(finished.kind === 'move' ? 'Logo moved.' : finished.kind === 'resize' ? 'Logo resized.' : 'Logo rotated.');
        update();
      }
    };

    svg.addEventListener('pointerup', (event) => {
      finishDrag(event, true);
    }, { signal: aborter.signal });
    const cancelGesture = (): void => {
      if (drag === null) return;
      drag = null; lastCandidate = null;
      const pointer = gesturePointer; gesturePointer = null;
      if (pointer !== null && svg.hasPointerCapture(pointer)) svg.releasePointerCapture(pointer);
      clearGhost(); announce('Edit cancelled. Position unchanged.'); update();
    };
    svg.addEventListener('pointercancel', (event) => { if (event.pointerId === gesturePointer) cancelGesture(); }, { signal: stageSignal });
    svg.addEventListener('lostpointercapture', (event) => { if (event.pointerId === gesturePointer) cancelGesture(); }, { signal: stageSignal });
    window.addEventListener('blur', cancelGesture, { signal: stageSignal });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && drag !== null) { event.preventDefault(); cancelGesture(); }
    }, { signal: stageSignal });

    const paintView = (): void => {
      const halfView = current.span / 2;
      svg.setAttribute(
        'viewBox',
        `${current.cx - halfView * aspectFix} ${current.cy - halfView} ${current.span * aspectFix} ${current.span}`,
      );
    };

    let ghost: SVGElement | null = null;
    let ghostExtras: SVGElement[] = [];
    const paintCandidateGhost = (
      index: number, candidate: DragCandidate,
      guides: Array<{ kind: string; valueMm?: number; fromMm?: { x: number; y: number }; toMm?: { x: number; y: number }; label: string }>,
      unsnapped: boolean,
    ): void => {
      clearGhost();
      lastCandidate = candidate;
      const corners = rotatedFootprintCorners(candidate.pos.xMm, candidate.pos.yMm, candidate.widthMm, candidate.heightMm, candidate.rotationDeg);
      const mapped: StagePoint[] = [];
      for (const corner of corners) {
        const svgPt = mapping.toSvg(corner.x, corner.y);
        if (svgPt !== null) mapped.push(svgPt);
      }
      if (mapped.length < 3) return;
      const polygon = svg.querySelector(`polygon[data-placement-index="${index}"]`);
      polygon?.setAttribute('points', mapped.map((point) => `${point.x},${point.y}`).join(' '));
      const entry = configuration.placements[index];
      if (!entry || mapped.length !== 4) return;
      const artwork = svg.querySelector(`[${HOOK}="pw-artwork-${entry.id ?? `index:${index}`}" ]`);
      const q0 = mapped[0]!, q2 = mapped[2]!, q3 = mapped[3]!;
      artwork?.setAttribute('transform', `matrix(${q2.x - q3.x} ${q2.y - q3.y} ${q0.x - q3.x} ${q0.y - q3.y} ${q3.x} ${q3.y})`);
      for (let i = 0; i < 4; i++) {
        const handle = svg.querySelector(`[${HOOK}="pw-resize-handle-${i}"]`), point = mapped[i]!;
        const width = Number(handle?.getAttribute('width') ?? 0), height = Number(handle?.getAttribute('height') ?? 0);
        handle?.setAttribute('x', String(point.x - width / 2)); handle?.setAttribute('y', String(point.y - height / 2));
      }
      const top = { x: (mapped[2]!.x + mapped[3]!.x) / 2, y: (mapped[2]!.y + mapped[3]!.y) / 2 };
      const centre = { x: (mapped[0]!.x + mapped[2]!.x) / 2, y: (mapped[0]!.y + mapped[2]!.y) / 2 };
      const rotation = svg.querySelector(`[${HOOK}="pw-rotate-handle"]`);
      const length = Math.hypot(top.x - centre.x, top.y - centre.y), gap = cssUnits(28);
      const rotatePt = { x: top.x + (length > 1e-9 ? (top.x - centre.x) / length : 0) * gap,
        y: top.y + (length > 1e-9 ? (top.y - centre.y) / length : -1) * gap };
      rotation?.setAttribute('cx', String(rotatePt.x)); rotation?.setAttribute('cy', String(rotatePt.y));
      const stem = svg.querySelector(`[${HOOK}="pw-rotate-stem"]`);
      stem?.setAttribute('x1', String(top.x)); stem?.setAttribute('y1', String(top.y));
      stem?.setAttribute('x2', String(rotatePt.x)); stem?.setAttribute('y2', String(rotatePt.y));
      paintMeasurements({ ...entry, ...candidate });
      ghostGuides = [];
      if (!unsnapped) {
        for (const guide of guides) {
          let a: StagePoint | null = null;
          let b: StagePoint | null = null;
          let center = false;
          if (guide.fromMm !== undefined && guide.toMm !== undefined) {
            a = mapping.toSvg(guide.fromMm.x, guide.fromMm.y);
            b = mapping.toSvg(guide.toMm.x, guide.toMm.y);
          } else if (guide.valueMm !== undefined && (guide.kind === 'v-center' || guide.kind === 'v-edge')) {
            a = mapping.toSvg(guide.valueMm, candidate.pos.yMm - candidate.heightMm);
            b = mapping.toSvg(guide.valueMm, candidate.pos.yMm + candidate.heightMm);
            center = guide.kind === 'v-center';
          } else if (guide.valueMm !== undefined && (guide.kind === 'h-center' || guide.kind === 'h-edge')) {
            a = mapping.toSvg(candidate.pos.xMm - candidate.widthMm, guide.valueMm);
            b = mapping.toSvg(candidate.pos.xMm + candidate.widthMm, guide.valueMm);
            center = guide.kind === 'h-center';
          }
          if (a === null || b === null) continue;
          ghostGuides.push({ a, b, center });
          const line = svgEl('line', {
            x1: String(a.x), y1: String(a.y), x2: String(b.x), y2: String(b.y),
            stroke: '#0b6cab',
            'stroke-width': String(Math.max(current.span / 600, 0.2)),
            'stroke-dasharray': `${current.span / 200} ${current.span / 250}`,
          });
          line.setAttribute('aria-hidden', 'true');
          line.setAttribute('pointer-events', 'none');
          mark(line, 'pw-snap-guide');
          svg.append(line);
          ghostExtras.push(line);
        }
      }
    };
    const clearGhost = (): void => {
      ghost?.remove();
      ghost = null;
      for (const extra of ghostExtras) extra.remove();
      ghostExtras = [];
      ghostGuides = [];
    };

    svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15;
      const nextSpan = Math.min(Math.max(current.span * factor, 1), 100000);
      current.span = nextSpan;
      viewCache.set(cacheKey, { cx: current.cx, cy: current.cy, span: current.span });
      viewOverride = { cx: current.cx, cy: current.cy, span: current.span };
      paintView();
    }, { signal: aborter.signal, passive: false });

    svg.addEventListener('keydown', (event) => {
      if (placement === null || placementIndex < 0) return;
      if (event.key === 'Escape') {
        if (drag !== null && drag.kind !== 'pan') {
          drag = null;
          lastCandidate = null;
          clearGhost();
          announce('Edit cancelled. Position unchanged.');
          update();
          return;
        }
        if (measureDraft !== null && measureDraft.picking !== null) {
          measureDraft.picking = null;
          measureDraft.notice = 'Diagram pick cancelled; nothing changed.';
          update();
        }
        return;
      }
      const step = event.shiftKey ? 0.1 : 1;
      const target = event.target as Element | null;
      const handleKind = target?.getAttribute('data-handle-kind');
      let dx = 0, dy = 0;
      if (event.key === 'ArrowLeft') dx = -step;
      else if (event.key === 'ArrowRight') dx = step;
      else if (event.key === 'ArrowUp') dy = step;
      else if (event.key === 'ArrowDown') dy = -step;
      else if (!(handleKind === 'rotate' && (event.key === '[' || event.key === ']'))) return;
      event.preventDefault();
      // Keyboard manipulation commits directly: no hidden pending-field
      // Apply gate. Staged numeric fields are reconciled after the commit.
      let patch: { pos?: { xMm: number; yMm: number }; widthMm?: number; heightMm?: number; rotationDeg?: number };
      if (handleKind === 'rotate') {
        const direction = event.key === '[' || event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1;
        patch = { rotationDeg: normalizeDeg(placement.rotationDeg + direction * step) };
      } else if (handleKind === 'resize') {
        const corner = Number(target?.getAttribute('data-corner'));
        const corners = rotatedFootprintCorners(placement.pos.xMm, placement.pos.yMm, placement.widthMm, placement.heightMm, placement.rotationDeg);
        const pointer = corners[corner]; if (!pointer) return;
        // Unified transaction: locked keyboard resize scales uniformly.
        const txResized = resizeCorner(
          beginEdit(
            { xMm: placement.pos.xMm, yMm: placement.pos.yMm, widthMm: placement.widthMm,
              heightMm: placement.heightMm, rotationDeg: placement.rotationDeg },
            lockFor(configuration.id, placement, placementIndex),
          ),
          corner as 0 | 1 | 2 | 3, { xMm: pointer.x + dx, yMm: pointer.y + dy }).candidate;
        patch = { pos: { xMm: txResized.xMm, yMm: txResized.yMm }, widthMm: txResized.widthMm, heightMm: txResized.heightMm };
      } else patch = { pos: { xMm: placement.pos.xMm + dx, yMm: placement.pos.yMm + dy } };
      let next: ProjectDocument;
      try {
        next = updatePlacementInConfig(
          deps.getProject(),
          configuration.id,
          placementSelector(placement, placementIndex),
          patch,
        );
      } catch (error) {
        announce(`Nudge blocked: ${error instanceof Error ? error.message : String(error)}`);
        update();
        return;
      }
      if (commitNext('Nudge logo', next)) {
        // Reconcile staged fields instead of dropping them: a later Apply
        // must not resurrect pre-nudge values.
        const stagedKey = placementKeyOf(configuration.id, placement, placementIndex);
        const stagedEdit = staged.get(stagedKey);
        if (stagedEdit !== undefined) {
          const updated = next.configurations.find((c) => c.id === configuration.id)?.placements[placementIndex];
          if (updated !== undefined) {
            stagedEdit.centreXRaw = String(updated.pos.xMm);
            stagedEdit.centreYRaw = String(updated.pos.yMm);
            stagedEdit.widthRaw = String(updated.widthMm);
            stagedEdit.heightRaw = String(updated.heightMm);
            stagedEdit.rotationRaw = String(updated.rotationDeg);
          }
        }
        update();
      }
    }, { signal: aborter.signal });

    /* Measurement picker clicks reuse the stage mapping (mm identities only).
       Two-click flow: first click selects the anchor identity, second click
       selects the artwork edge. The measured value always comes from the
       visual-dimension kernel — pointer positions never enter millimetres. */
    stageDropPoint = (x, y) => {
      if (!region) return null;
      const point = toSvgPoint(x, y); if (!point) return null;
      const pos = mapping.fromSvg(point);
      return pos ? { regionId: region.id, pos } : null;
    };
    const pickerHandler = (event: PointerEvent): void => {
      if (measureDraft === null) return;
      const picking = measureDraft.picking;
      if (picking === null) return;
      if (drag !== null) return;
      const svgPt = toSvgPoint(event.clientX, event.clientY);
      if (svgPt === null) return;
      const mm = mapping.fromSvg(svgPt);
      if (mm === null || !Number.isFinite(mm.xMm) || !Number.isFinite(mm.yMm)) return;
      if (placement === null || placementIndex < 0) return;
      if (picking.anchorClickMm === null) {
        picking.anchorClickMm = [mm.xMm, mm.yMm];
        measureDraft.notice =
          `Anchor candidate near ${displayMm(mm.xMm)}, ${displayMm(mm.yMm)} mm — ` +
          `now click near the logo edge.`;
        update();
        return;
      }
      const tolerance = Math.max(current.span / 60, 2);
      const scoped = deps.getAnchors(selection.productId, selection.variantId, placement.regionId)
        .filter((anchor) => anchor.productId === selection.productId &&
          anchor.variantId === selection.variantId && anchor.regionId === placement.regionId);
      const resolved = resolveVisualDimension({
        anchors: scoped.map((anchor) => ({ id: anchor.id, posMm: anchor.posMm })),
        footprint: {
          centerMm: [placement.pos.xMm, placement.pos.yMm],
          widthMm: placement.widthMm,
          heightMm: placement.heightMm,
          rotationDeg: placement.rotationDeg,
        },
        anchorClickMm: picking.anchorClickMm,
        edgeClickMm: [mm.xMm, mm.yMm],
        convention: measureDraft.convention,
        snapTolMm: tolerance,
        maxEdgeDistMm: tolerance * 2,
      });
      if (!resolved.ok) {
        measureDraft.notice = `Diagram pick refused: ${resolved.message}`;
        update();
        return;
      }
      measureDraft.preview = {
        bindingAnchorId: resolved.binding.anchorId,
        edge: resolved.binding.edge,
        valueMm: resolved.valueMm,
      };
      measureDraft.anchorId = resolved.binding.anchorId;
      measureDraft.edge = resolved.binding.edge;
      measureDraft.convention = resolved.binding.convention;
      measureDraft.picking = null;
      measureDraft.notice =
        `Picked ${EDGE_WORD[resolved.binding.edge]} edge: ${displayMm(resolved.valueMm)} mm. ` +
        `Save measurement to keep it.`;
      update();
    };

    svg.addEventListener('click', (event) => {
      if (measureDraft !== null && measureDraft.picking !== null) {
        event.stopPropagation();
        pickerHandler(event as unknown as PointerEvent);
      }
    }, { signal: aborter.signal });

    const hint = el('p', 'pw-hint', 'pw-stage-hint');
    hint.textContent = overlay !== null
      ? 'Calibrated overlay: click a logo to select it; drag the selected logo to move it. ' +
      'Drag empty space to pan, scroll to zoom (view only — stored millimetres never change). ' +
      'Camera orbit lives in the model viewer, never in this diagram.'
      : 'Region-millimetre diagram (authoritative, not a photograph): click a logo to select it; ' +
      'drag the selected logo to move it. Drag empty space to pan, scroll to zoom ' +
      '(view only — stored millimetres never change).';
    main.append(hint);
    const controls = el('div', 'pw-row');
    const reset = el('button', 'pw-secondary', 'pw-reset-view') as HTMLButtonElement;
    reset.type = 'button';
    reset.textContent = 'Reset view';
    reset.addEventListener('click', () => {
      viewCache.delete(cacheKey);
      viewOverride = null;
      update();
    });
    controls.append(reset);
    if (region === null) {
      const note = el('p', 'pw-error', 'pw-stage-message');
      note.textContent =
        `Add a safe area for ${product.name?.trim() || 'this product'} before placing a logo.`;
      main.append(note);
      const setup = el('button', 'pw-secondary', 'pw-stage-setup') as HTMLButtonElement;
      setup.type = 'button';
      setup.textContent = 'Set up product';
      setup.addEventListener('click', () => {
        deps.requestProductSetup(selection.productId, selection.variantId);
      });
      controls.append(setup);
    } else if (calibrationState(product, region) === 'missing-calibration') {
      const note = el('p', 'pw-error', 'pw-stage-message');
      note.textContent =
        `Set up measurements for ${product.name?.trim() || 'this product'} before placing a logo.`;
      main.append(note);
      const setup = el('button', 'pw-secondary', 'pw-stage-setup') as HTMLButtonElement;
      setup.type = 'button';
      setup.textContent = 'Set up product';
      setup.addEventListener('click', () => {
        deps.requestProductSetup(selection.productId, selection.variantId, region.id);
      });
      controls.append(setup);
    }
    main.append(controls);
    if (status !== '') {
      const line = el('p', 'pw-status pw-muted', 'pw-stage-status');
      line.setAttribute('role', 'status');
      line.textContent = status;
      main.append(line);
    }
  }

  function bindingsForPlacement(
    configurationId: string,
    placements: readonly Placement[],
    placementIndex: number,
  ): DimensionBinding[] {
    const logoRef = logoRefForPlacement(placements, placementIndex);
    let bindings: DimensionBinding[];
    try {
      bindings = deps.getBindings(configurationId);
    } catch {
      return [];
    }
    return bindings.filter((binding) => binding.logoRef === logoRef);
  }

  /**
   * Immediate provisional preview for tray artwork: commits a provisional
   * placement at the calibrated region centre right away. Unresolved method
   * or size stays visible in the inspector and blocks review — never the
   * preview. One gesture, one history entry.
   */
  function placeProvisional(
    project: ProjectDocument,
    configuration: Configuration,
    logoId: string,
    destination?: { regionId: string; pos: { xMm: number; yMm: number } },
  ): void {
    // Excluded scope: block the mutation itself (not only the button), so a
    // stale tray/drop cannot silently author outside the issued subset.
    if (isExcludedScope(configuration)) {
      announce(excludedScopeMessage(project, configuration.productId, configuration.variantId));
      update();
      return;
    }
    const product = project.products.find((entry) => entry.id === configuration.productId);
    if (product === undefined) {
      announce('The product for this option is missing; reopen the job.');
      update();
      return;
    }
    const areas = configuredAreas(product, configuration.variantId);
    const currentRegion = stageRegion();
    const target = destination ? areas.find((area) => area.id === destination.regionId) ?? null
      : (currentRegion !== null && areas.some((area) => area.id === currentRegion.id) ? currentRegion : areas[0]) ?? null;
    if (target === null) {
      announce(`Add a safe area for ${product.name?.trim() || 'this product'} before placing a logo.`);
      deps.requestProductSetup(configuration.productId, configuration.variantId);
      update();
      return;
    }
    if (calibrationState(product, target) === 'missing-calibration') {
      announce(`Set up measurements for ${product.name?.trim() || 'this product'} before placing a logo.`);
      deps.requestProductSetup(configuration.productId, configuration.variantId, target.id);
      update();
      return;
    }
    const known = knownDimensions(project, logoId);
    const size = provisionalSizeMm(regionSpanMm(target), logoPixelAspect(project, logoId), known);
    if (size === null) {
      announce('The safe area has no usable size; redraw it in product setup.');
      update();
      return;
    }
    const centre = destination ? { x: destination.pos.xMm, y: destination.pos.yMm } : regionCentreMm(target);
    if (centre === null) {
      announce('The safe area has no usable centre; redraw it in product setup.');
      update();
      return;
    }
    const method = target.allowedMethods[0] ?? '';
    if (!method) { announce('Configure a decoration method for this safe area first.'); update(); return; }
    const id = deps.newPlacementId();
    const placement: Placement = {
      id,
      logoId,
      regionId: target.id,
      method,
      pos: { xMm: centre.x, yMm: centre.y },
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      rotationDeg: 0,
    };
    let next: ProjectDocument;
    try {
      next = addPlacementToConfig(project, configuration.id, placement);
    } catch (error) {
      announce(`Place blocked: ${error instanceof Error ? error.message : String(error)}`);
      update();
      return;
    }
    if (commitNext('Place artwork preview', next)) {
      deps.setSelection({ placementId: id });
      const notes: string[] = [];
      if (known === null) notes.push('size is provisional — verify physically before production');
      notes.push(`method defaults to ${methodLabel(method)} — change it in the inspector if needed`);
      announce(notes.length === 0
        ? `Preview placed for ${logoNameOf(project, logoId)} in ${target.name?.trim() || 'unnamed area'}. Drag it on the product to position it.`
        : `Provisional preview placed for ${logoNameOf(project, logoId)} (${notes.join('; ')}). Drag it on the product; review stays blocked until resolved.`);
      update();
    }
  }

  /** Tray pick without placing: prefill the add form (click, Enter, or Space). */
  function prefillAddForm(project: ProjectDocument, configuration: Configuration, logoId: string): void {
    const product = project.products.find((entry) => entry.id === configuration.productId);
    addOpen = true;
    addDraft = makeAddDraft(project, configuration);
    addDraft.logoId = logoId;
    const region = product?.regions.find((entry) => entry.id === addDraft?.regionId);
    const raws = provisionalRaws(project, logoId, region);
    addDraft.widthRaw = raws.widthRaw;
    addDraft.heightRaw = raws.heightRaw;
    addDraft.method = region !== undefined && region.allowedMethods.length === 1
      ? (region.allowedMethods[0] ?? '')
      : '';
    addDraft.notice = '';
    // Prefill only stages a draft (creation still goes through the guarded
    // submit), so it stays allowed in an excluded scope — but the
    // announcement names the block instead of promising a placement.
    if (isExcludedScope(configuration)) {
      announce(excludedScopeMessage(project, configuration.productId, configuration.variantId));
    } else {
      announce('Artwork ready: check the size, then Add placement — or Place it for an immediate preview.');
    }
    update();
  }

  function renderArtworkTray(rail: HTMLElement, project: ProjectDocument, configuration: Configuration): void {
    const section = el('section', '', 'pw-artwork-tray');
    section.setAttribute('aria-label', 'Artwork tray');
    const title = el('h3', '', 'pw-artwork-title');
    title.textContent = 'Artwork';
    section.append(title);
    const hint = el('p', 'pw-muted', 'pw-artwork-hint');
    hint.textContent = 'Choose artwork, then place it on the product: drag a card onto the product, use Place, or open the form for exact sizes.';
    section.append(hint);
    let included: Set<string> | null = null;
    try {
      const ids = deps.getIncludedLogoIds?.();
      if (ids !== undefined && ids !== null) included = new Set(ids);
    } catch { included = null; }
    const logos = project.logos.filter((logo) => included === null || included.has(logo.id));
    if (logos.length === 0) {
      const note = el('p', 'pw-muted', 'pw-artwork-empty');
      note.textContent = 'Use Add logo to choose artwork from this device.';
      section.append(note);
      rail.append(section);
      return;
    }
    const grid = el('div', 'pw-artwork-grid', 'pw-artwork-grid');
    const blocked = isExcludedScope(configuration);
    for (const logo of logos) {
      const card = el('div', 'pw-artwork-card', `pw-artwork-${logo.id}`);
      const pick = el('button', 'pw-artwork-pick', `pw-artwork-pick-${logo.id}`) as HTMLButtonElement;
      pick.type = 'button';
      const name = logo.name?.trim() || 'Unnamed logo';
      pick.setAttribute('aria-label', `Use artwork ${name}: fills the add form`);
      pick.title = `Use ${name}: fills the add form with a provisional size`;
      pick.draggable = true;
      const thumb = deps.getLogoImage(logo.id);
      if (thumb !== null) {
        const img = document.createElement('img');
        img.className = 'pw-artwork-thumb';
        img.src = thumb.src;
        img.alt = '';
        pick.append(img);
      }
      const label = el('span', 'pw-artwork-name');
      label.textContent = name;
      pick.append(label);
      const known = knownDimensions(project, logo.id);
      const state = el('span', 'pw-artwork-state');
      state.textContent = known !== null
        ? `${displayMm(known.widthMm)} × ${displayMm(known.heightMm)} mm`
        : 'size provisional';
      pick.append(state);
      // Keyboard alternative: Enter/Space activates like a click.
      pick.addEventListener('click', () => { prefillAddForm(deps.getProject(), configuration, logo.id); });
      pick.addEventListener('dragstart', (event) => {
        try {
          event.dataTransfer?.setData('text/logo-id', logo.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        } catch { /* drag still carries the pending pick below */ }
        pendingTrayDrop = logo.id;
      });
      pick.addEventListener('dragend', () => { pendingTrayDrop = null; });
      pick.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          prefillAddForm(deps.getProject(), configuration, logo.id);
        }
      });
      card.append(pick);
      const place = el('button', 'pw-secondary pw-artwork-place', `pw-artwork-place-${logo.id}`) as HTMLButtonElement;
      place.type = 'button';
      place.textContent = 'Place';
      place.setAttribute('aria-label', `Place ${name} on the product now as a provisional preview`);
      if (blocked) {
        place.disabled = true;
        place.title = excludedScopeMessage(project, configuration.productId, configuration.variantId);
      }
      place.addEventListener('click', () => { placeProvisional(deps.getProject(), configuration, logo.id); });
      card.append(place);
      grid.append(card);
    }
    section.append(grid);
    section.append(helpPopover('pw-help-tray', 'Place shows the artwork on the product immediately with a provisional size and method. Unresolved size or method stays visible in the inspector and blocks review — never the preview.'));
    rail.append(section);
  }

  function renderRail(rail: HTMLElement): void {
    const { project, selection, product, configuration, placement, placementIndex } = currentContext();
    if (product === null || configuration === null) return;

    // Visual artwork tray comes before placements: artwork is chosen first,
    // then positioned. Drag cards onto the product, Place for an immediate
    // provisional preview, or pick a card to fill the add form.
    renderArtworkTray(rail, project, configuration);

    const creationBlocked = isExcludedScope(configuration);

    const listTitle = el('h3', '', 'pw-placements-title');
    listTitle.textContent = `Placements (${configuration.placements.length})`;
    const placementHead = el('div', 'pw-placement-head');
    placementHead.append(listTitle); rail.append(placementHead);

    if (project.logos.length === 0) {
      const note = el('p', 'pw-muted', 'pw-no-logos');
      note.textContent = 'Add artwork before adding a placement.';
      rail.append(note);
      const addLogo = el('button', 'pw-secondary', 'pw-add-logo') as HTMLButtonElement;
      addLogo.type = 'button';
      addLogo.textContent = 'Add logo';
      addLogo.addEventListener('click', () => {
        deps.onAddLogo();
      });
      rail.append(addLogo);
    }

    const list = el('div', 'pw-list', 'pw-placement-list');
    rail.append(list);
    if (configuration.placements.length === 0) {
      const empty = el('p', 'pw-muted', 'pw-empty-placements');
      empty.textContent = 'No logo placements for this option.';
      list.append(empty);
    }
    for (const [index, entry] of configuration.placements.entries()) {
      const row = el('button', 'pw-item', `pw-placement-row-${entry.id ?? `index-${index}`}`) as HTMLButtonElement;
      row.type = 'button';
      if (placement !== null && placementIndex === index) row.classList.add('is-selected');
      const image = deps.getLogoImage(entry.logoId);
      if (image !== null) {
        const thumb = document.createElement('img');
        thumb.className = 'pw-thumb';
        thumb.src = image.src;
        thumb.alt = '';
        row.append(thumb);
      }
      const body = el('span', 'pw-item-body');
      const name = el('span', 'pw-item-name');
      name.textContent = logoNameOf(project, entry.logoId);
      const sub = el('span', 'pw-item-sub');
      const areaName = areaNameOf(project, configuration.productId, entry.regionId);
      const size = `${displayMm(entry.widthMm)} × ${displayMm(entry.heightMm)} mm` +
        (entry.rotationDeg !== 0 ? ` · ${displayMm(entry.rotationDeg)}°` : '');
      sub.textContent = `${areaName} · ${size}`;
      body.append(name, sub);
      row.append(body);
      row.addEventListener('click', () => {
        deps.setSelection({ placementId: entry.id ?? `index:${index}` });
        measureDraft = null;
        update();
      });
      list.append(row);
    }

    const addToggle = el('button', 'pw-secondary', 'pw-add-placement') as HTMLButtonElement;
    addToggle.type = 'button';
    addToggle.textContent = 'Add logo placement';
    addToggle.disabled = project.logos.length === 0 || creationBlocked;
    if (creationBlocked) {
      addToggle.setAttribute('aria-describedby', 'placement-exclusion-message');
      addToggle.title = excludedScopeMessage(project, configuration.productId, configuration.variantId);
    }
    addToggle.addEventListener('click', () => {
      addOpen = true;
      addDraft = makeAddDraft(project, configuration);
      update();
    });
    placementHead.append(addToggle);

    if (addOpen) renderAddForm(rail, project, configuration);

    if (placement !== null && placementIndex >= 0) {
      renderSelectedFields(rail, project, configuration, placement, placementIndex);
    }

    renderValidation(rail, project, configuration);

    const actions = el('div', 'pw-actions pw-step-actions', 'pw-step-actions');
    const approval = el('button', 'pw-secondary', 'pw-approval') as HTMLButtonElement;
    approval.type = 'button';
    approval.textContent = 'Customer approval';
    approval.setAttribute('aria-label', 'Send for customer approval');
    approval.addEventListener('click', () => {
      deps.onApprovalBranch();
    });
    const pending = anyPendingForConfiguration(configuration);
    const gate = reviewGateForConfiguration(
      project,
      configuration.id,
      deps.getAnchors(selection.productId, selection.variantId, placement?.regionId ?? ''),
      deps.getBindings(configuration.id),
      pending,
      addDraft !== null && addOpen && isAddDirty(addDraft),
    );
    const review = el('button', 'pw-primary', 'pw-review') as HTMLButtonElement;
    review.type = 'button';
    review.textContent = 'Review document';
    review.disabled = gate.blockers.length > 0;
    if (gate.blockers.length > 0) {
      review.title = gate.blockers[0] ?? '';
    }
    review.addEventListener('click', () => {
      deps.onReview();
    });
    const back = el('button', 'pw-secondary', 'pw-back') as HTMLButtonElement;
    back.type = 'button';
    back.textContent = 'Back';
    back.addEventListener('click', () => {
      deps.onBack();
    });
    actions.append(approval, review, back);
    rail.append(actions);
    // Explicit overflow cue: the rail scrolls internally while core actions
    // stay sticky, so secondary content is never silently cut off.
    const cue = el('div', 'pw-overflow-cue', 'pw-overflow-cue');
    cue.setAttribute('aria-hidden', 'true');
    cue.textContent = 'More placement details below ↓';
    rail.append(cue);
    const syncCue = (): void => {
      const needs = rail.scrollHeight > rail.clientHeight + 8;
      const more = rail.scrollTop + rail.clientHeight < rail.scrollHeight - 8;
      cue.style.display = needs && more ? '' : 'none';
    };
    rail.addEventListener('scroll', syncCue, { passive: true });
    syncCue();
    requestAnimationFrame(syncCue);
  }

  function regionSpanMm(region: Region): { spanX: number; spanY: number } | null {
    if (region.safeArea.length < 3) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of region.safeArea) {
      const x = point[0], y = point[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) return null;
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY) return null;
    return { spanX: maxX - minX, spanY: maxY - minY };
  }

  function provisionalRaws(
    project: ProjectDocument,
    logoId: string,
    region: Region | undefined,
  ): { widthRaw: string; heightRaw: string } {
    const known = logoId !== '' ? knownDimensions(project, logoId) : null;
    if (known !== null) return { widthRaw: String(known.widthMm), heightRaw: String(known.heightMm) };
    if (logoId === '') return { widthRaw: '', heightRaw: '' };
    const size = provisionalSizeMm(
      region !== undefined ? regionSpanMm(region) : null,
      logoPixelAspect(project, logoId),
      null,
    );
    if (size === null) return { widthRaw: '', heightRaw: '' };
    return { widthRaw: String(size.widthMm), heightRaw: String(size.heightMm) };
  }

  function makeAddDraft(project: ProjectDocument, configuration: Configuration): AddDraft {
    const { selection } = currentContext();
    const product = project.products.find((entry) => entry.id === configuration.productId);
    const areas = product !== undefined ? configuredAreas(product, configuration.variantId) : [];
    const firstLogo = project.logos[0];
    const logoId = firstLogo?.id ?? '';
    const currentRegion = stageRegion();
    const regionId = (currentRegion !== null &&
      areas.some((area) => area.id === currentRegion.id))
      ? currentRegion.id
      : (areas[0]?.id ?? '');
    // Provisional starting size when the artwork has no known mm
    // dimensions: aspect-preserving, fitted to the calibrated region.
    const targetArea = areas.find((entry) => entry.id === regionId);
    const raws = provisionalRaws(project, logoId, targetArea);
    const area = targetArea;
    void selection;
    return {
      logoId,
      regionId,
      widthRaw: raws.widthRaw,
      heightRaw: raws.heightRaw,
      rotationRaw: '0',
      keepProportions: false,
      method: area !== undefined && area.allowedMethods.length === 1
        ? (area.allowedMethods[0] ?? '')
        : '',
      widthTouched: false,
      notice: '',
    };
  }

  function isAddDirty(draft: AddDraft): boolean {
    return draft.logoId !== '' || draft.regionId !== '' || draft.widthRaw !== '' ||
      draft.heightRaw !== '' || draft.rotationRaw !== '0' || draft.method !== '';
  }

  function renderAddForm(rail: HTMLElement, project: ProjectDocument, configuration: Configuration): void {
    const draft = addDraft;
    if (draft === null) return;
    const product = project.products.find((entry) => entry.id === configuration.productId);
    const areas = product !== undefined ? configuredAreas(product, configuration.variantId) : [];
    const form = el('div', '', 'pw-add-form');
    const title = el('h4', '', 'pw-add-title');
    title.textContent = 'New logo placement';
    form.append(title);

    const logoLabel = el('label', 'pw-field', 'pw-add-logo-field');
    logoLabel.textContent = 'Logo';
    const logoSelect = el('select', '', 'pw-add-logo') as HTMLSelectElement;
    // Add-placement choices show included (selected) logos only; existing
    // placements referencing excluded logos stay visible and resolvable.
    let included: Set<string> | null = null;
    try {
      const ids = deps.getIncludedLogoIds?.();
      if (ids !== undefined && ids !== null) included = new Set(ids);
    } catch { included = null; }
    for (const logo of project.logos) {
      if (included !== null && !included.has(logo.id)) continue;
      const option = document.createElement('option');
      option.value = logo.id;
      option.textContent = logo.name?.trim() || 'Unnamed logo';
      logoSelect.append(option);
    }
    if (included !== null && !included.has(draft.logoId)) {
      const first = project.logos.find((entry) => included.has(entry.id));
      draft.logoId = first?.id ?? '';
    }
    if (logoSelect.options.length === 0) {
      const note = el('p', 'pw-error', 'pw-add-no-included-logos');
      note.textContent =
        'No selected artwork: tick a logo in Step 1 (Prepare job) to place new artwork. Existing placements stay visible below.';
      form.append(note);
    }
    logoSelect.value = draft.logoId;
    logoSelect.addEventListener('change', () => {
      draft.logoId = logoSelect.value;
      const known = knownDimensions(project, draft.logoId);
      if (known !== null) {
        draft.widthRaw = String(known.widthMm);
        draft.heightRaw = String(known.heightMm);
      }
      draft.widthTouched = false;
      update();
    });
    logoLabel.append(logoSelect);
    form.append(logoLabel);

    const areaLabel = el('label', 'pw-field', 'pw-add-area-field');
    areaLabel.textContent = 'Safe area';
    if (areas.length === 0) {
      const note = el('p', 'pw-error', 'pw-add-no-areas');
      note.textContent =
        `Add a safe area for ${product?.name?.trim() || 'this product'} before placing a logo.`;
      form.append(note);
      const setup = el('button', 'pw-secondary', 'pw-add-setup') as HTMLButtonElement;
      setup.type = 'button';
      setup.textContent = 'Set up product';
      setup.addEventListener('click', () => {
        deps.requestProductSetup(configuration.productId, configuration.variantId);
      });
      form.append(setup);
    } else {
      const areaSelect = el('select', '', 'pw-add-area') as HTMLSelectElement;
      for (const area of areas) {
        const option = document.createElement('option');
        option.value = area.id;
        option.textContent = area.name?.trim() || 'Unnamed area';
        areaSelect.append(option);
      }
      areaSelect.value = draft.regionId;
      areaSelect.addEventListener('change', () => {
        draft.regionId = areaSelect.value;
        const next = areas.find((entry) => entry.id === draft.regionId);
        draft.method = next !== undefined && next.allowedMethods.length === 1
          ? (next.allowedMethods[0] ?? '')
          : '';
        update();
      });
      areaLabel.append(areaSelect);
      form.append(areaLabel);
    }

    const widthLabel = el('label', 'pw-field', 'pw-add-width-field');
    widthLabel.textContent = 'Width (mm)';
    const widthInput = el('input', '', 'pw-add-width') as HTMLInputElement;
    widthInput.type = 'number';
    widthInput.min = '0';
    widthInput.step = 'any';
    widthInput.value = draft.widthRaw;
    widthInput.addEventListener('input', () => {
      draft.widthRaw = widthInput.value;
      draft.widthTouched = true;
      if (draft.keepProportions) {
        const aspect = logoPixelAspect(project, draft.logoId);
        const widthMm = parseMm(draft.widthRaw);
        if (aspect !== null && widthMm !== null && widthMm > 0) {
          draft.heightRaw = String(Math.round((widthMm / aspect) * 100) / 100);
        }
      }
      const heightLive = form.querySelector<HTMLInputElement>(`[${HOOK}="pw-add-height"]`);
      if (heightLive !== null && document.activeElement !== heightLive) heightLive.value = draft.heightRaw;
    });
    widthLabel.append(widthInput);
    form.append(widthLabel);

    const heightLabel = el('label', 'pw-field', 'pw-add-height-field');
    heightLabel.textContent = 'Height (mm)';
    const heightInput = el('input', '', 'pw-add-height') as HTMLInputElement;
    heightInput.type = 'number';
    heightInput.min = '0';
    heightInput.step = 'any';
    heightInput.value = draft.heightRaw;
    heightInput.addEventListener('input', () => {
      draft.heightRaw = heightInput.value;
      // Symmetric with width: a locked height edit scales width via the
      // artwork pixel aspect (add-time ratio source; committed placements
      // use the unified transaction instead).
      if (draft.keepProportions) {
        const aspect = logoPixelAspect(project, draft.logoId);
        const heightMm = parseMm(draft.heightRaw);
        if (aspect !== null && aspect > 0 && heightMm !== null && heightMm > 0) {
          draft.widthRaw = String(Math.round(heightMm * aspect * 100) / 100);
          const widthLive = form.querySelector<HTMLInputElement>(`[${HOOK}="pw-add-width"]`);
          if (widthLive !== null && document.activeElement !== widthLive) widthLive.value = draft.widthRaw;
        }
      }
    });
    heightLabel.append(heightInput);
    form.append(heightLabel);

    const keep = el('label', 'pw-check', 'pw-add-keep-field');
    const keepBox = el('input', '', 'pw-add-keep') as HTMLInputElement;
    keepBox.type = 'checkbox';
    keepBox.checked = draft.keepProportions;
    keepBox.addEventListener('change', () => {
      draft.keepProportions = keepBox.checked;
      update();
    });
    keep.append(keepBox, document.createTextNode('Keep proportions'));
    form.append(keep);

    const area = areas.find((entry) => entry.id === draft.regionId);
    if (area !== undefined) {
      if (area.allowedMethods.length > 1) {
        const methodField = el('label', 'pw-field', 'pw-add-method-field');
        methodField.textContent = 'Method';
        const methodSelect = el('select', '', 'pw-add-method') as HTMLSelectElement;
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Choose a method';
        methodSelect.append(blank);
        for (const method of area.allowedMethods) {
          const option = document.createElement('option');
          option.value = method;
          option.textContent = methodLabel(method);
          methodSelect.append(option);
        }
        methodSelect.value = draft.method;
        methodSelect.addEventListener('change', () => {
          draft.method = methodSelect.value;
        });
        methodField.append(methodSelect);
        form.append(methodField);
      } else {
        const single = el('p', 'pw-muted', 'pw-add-method-single');
        single.textContent = `Method: ${area.allowedMethods[0] ?? '(none configured)'}`;
        form.append(single);
      }
    }

    if (draft.notice !== '') {
      const notice = el('p', 'pw-error', 'pw-add-notice');
      notice.setAttribute('role', 'alert');
      notice.textContent = draft.notice;
      form.append(notice);
    }

    const row = el('div', 'pw-inline');
    const add = el('button', 'pw-primary', 'pw-add-confirm') as HTMLButtonElement;
    add.type = 'button';
    add.textContent = 'Add placement';
    // Disabled (not just guarded) in an excluded scope; the mutation guard in
    // submitAddForm still covers stale-open forms that reach it anyway.
    if (isExcludedScope(configuration)) {
      add.disabled = true;
      add.title = excludedScopeMessage(project, configuration.productId, configuration.variantId);
    }
    add.addEventListener('click', () => {
      submitAddForm(project, configuration, draft);
    });
    const cancel = el('button', 'pw-secondary', 'pw-add-cancel') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      addOpen = false;
      addDraft = null;
      update();
    });
    row.append(add, cancel);
    form.append(row);
    rail.append(form);
  }

  function submitAddForm(
    project: ProjectDocument,
    configuration: Configuration,
    draft: AddDraft,
  ): void {
    // Mutation guard: re-evaluate the live inclusion scope at submit time, so
    // a stale-open form (opened while included, submitted after exclusion)
    // cannot silently author outside the issued subset. Never auto-includes.
    if (isExcludedScope(configuration)) {
      draft.notice = excludedScopeMessage(project, configuration.productId, configuration.variantId);
      update();
      return;
    }
    const product = project.products.find((entry) => entry.id === configuration.productId);
    if (product === undefined) {
      draft.notice = 'The product for this option is missing; reopen the job.';
      update();
      return;
    }
    if (draft.logoId === '') {
      draft.notice = 'Choose a logo for the new placement.';
      update();
      return;
    }
    const region = product.regions.find((entry) => entry.id === draft.regionId);
    if (region === undefined || region.safeArea.length < 3) {
      draft.notice =
        `Add a safe area for ${product.name?.trim() || 'this product'} before placing a logo.`;
      update();
      return;
    }
    if (calibrationState(product, region) === 'missing-calibration') {
      draft.notice =
        `Set up measurements for ${product.name?.trim() || 'this product'} before placing a logo.`;
      update();
      return;
    }
    const widthMm = parseMm(draft.widthRaw);
    const heightMm = parseMm(draft.heightRaw);
    if (widthMm === null || !(widthMm > 0) || heightMm === null || !(heightMm > 0)) {
      draft.notice = 'Enter a Width and Height in millimetres (both greater than 0).';
      update();
      return;
    }
    const method = region.allowedMethods.length === 1
      ? (region.allowedMethods[0] ?? '')
      : draft.method;
    if (method === '' || !region.allowedMethods.includes(method)) {
      draft.notice = `Choose a method offered in “${region.name?.trim() || 'unnamed area'}”.`;
      update();
      return;
    }
    const centre = regionCentreMm(region);
    if (centre === null) {
      draft.notice = 'The safe area has no usable centre; redraw it in product setup.';
      update();
      return;
    }
    const id = deps.newPlacementId();
    const placement: Placement = {
      id,
      logoId: draft.logoId,
      regionId: region.id,
      method,
      pos: { xMm: centre.x, yMm: centre.y },
      widthMm,
      heightMm,
      rotationDeg: 0,
    };
    let next: ProjectDocument;
    try {
      next = addPlacementToConfig(project, configuration.id, placement);
    } catch (error) {
      draft.notice = `Add blocked: ${error instanceof Error ? error.message : String(error)}`;
      update();
      return;
    }
    const logoName = logoNameOf(project, draft.logoId);
    const areaName = region.name?.trim() || 'unnamed area';
    let verdict: { ok: boolean; reason: string } | null = null;
    try {
      verdict = evaluatePlacementGeometry(region, placement);
    } catch {
      verdict = null;
    }
    if (commitNext('Add logo placement', next)) {
      addOpen = false;
      addDraft = null;
      deps.setSelection({ placementId: id });
      if (verdict !== null && !verdict.ok) {
        announce(
          `${logoName} extends outside ${areaName}. Move it or reduce its size. (${verdict.reason})`,
        );
      } else {
        announce(`Placement added for ${logoName} in ${areaName}.`);
      }
      update();
    } else {
      draft.notice = status;
      update();
    }
  }

  function renderSelectedFields(
    rail: HTMLElement,
    project: ProjectDocument,
    configuration: Configuration,
    placement: Placement,
    placementIndex: number,
  ): void {
    const product = project.products.find((entry) => entry.id === configuration.productId);
    if (product === undefined) return;
    const edit = ensureStaged(project, configuration, placement, placementIndex);
    const key = placementKeyOf(configuration.id, placement, placementIndex);
    const pending = stagedDiffers(placement, edit);
    // Inline Apply validation: same rule set applyStaged commits with.
    // Errors render only while edits are pending (invalid edits stay pending
    // and keep blocking save/review via hasPendingEdits); each keystroke
    // re-renders without announcing, and Apply announces on attempt.
    const fieldErrors = validateSelectedEditFields(
      edit,
      product.regions.find((entry) => entry.id === edit.regionId),
    );

    const group = el('div', '', 'pw-selected');
    const heading = el('h3', '', 'pw-selected-title');
    heading.textContent = 'Selected placement';
    group.append(heading);

    const logoLine = el('p', '', 'pw-field-logo');
    const logoStrong = el('strong', '');
    logoStrong.textContent = logoNameOf(project, edit.logoId);
    logoLine.append(logoStrong);
    group.append(logoLine);
    // Unresolved method/size stays visible in the inspector and blocks only
    // readiness (review), never the on-product preview.
    if (knownDimensions(project, edit.logoId) === null) {
      const provisional = el('p', 'pw-warning', 'pw-provisional-size');
      provisional.textContent =
        'Draft size — verify dimensions.';
      group.append(provisional);
    }
    const inspectorRegion = product.regions.find((entry) => entry.id === edit.regionId);
    if (inspectorRegion === undefined || placement.method === '' || !inspectorRegion.allowedMethods.includes(placement.method)) {
      const unresolved = el('p', 'pw-warning', 'pw-unresolved-method');
      unresolved.textContent =
        'Method not set: choose an offered method before review. The preview stays visible while this is unresolved.';
      group.append(unresolved);
    }

    const areas = configuredAreas(product, configuration.variantId);
    const areaLabel = el('label', 'pw-field', 'pw-field-area');
    areaLabel.textContent = 'Safe area';
    const areaSelect = el('select', '', 'pw-area-select') as HTMLSelectElement;
    const currentRegion = product.regions.find((entry) => entry.id === edit.regionId);
    const currentConfigured = areas.some((area) => area.id === edit.regionId);
    if (!currentConfigured && currentRegion !== undefined) {
      const option = document.createElement('option');
      option.value = currentRegion.id;
      option.textContent = `${currentRegion.name?.trim() || 'Unnamed area'} (needs attention)`;
      areaSelect.append(option);
    }
    for (const area of areas) {
      const option = document.createElement('option');
      option.value = area.id;
      option.textContent = area.name?.trim() || 'Unnamed area';
      areaSelect.append(option);
    }
    areaSelect.value = edit.regionId;
    areaSelect.addEventListener('change', () => {
      edit.regionId = areaSelect.value;
      const next = areas.find((entry) => entry.id === edit.regionId);
      if (next !== undefined) {
        if (next.allowedMethods.length === 1) {
          edit.method = next.allowedMethods[0] ?? '';
        } else if (!next.allowedMethods.includes(edit.method)) {
          edit.method = '';
        }
      }
      update();
    });
    areaLabel.append(areaSelect);
    group.append(areaLabel);
    if (pending && fieldErrors.area !== undefined) {
      areaSelect.setAttribute('aria-invalid', 'true');
      areaSelect.setAttribute('aria-describedby', 'pw-area-error');
      group.append(selectedFieldError('pw-area-error', fieldErrors.area));
    } else {
      areaSelect.setAttribute('aria-invalid', 'false');
    }

    const widthLabel = el('label', 'pw-field', 'pw-field-width');
    widthLabel.textContent = 'Width (mm)';
    const widthInput = el('input', '', 'pw-width') as HTMLInputElement;
    widthInput.type = 'number';
    widthInput.min = '0';
    widthInput.step = 'any';
    widthInput.value = edit.widthRaw;
    widthInput.addEventListener('input', () => {
      edit.widthRaw = widthInput.value;
      edit.widthTouched = true;
      // Unified transaction: the persisted lock is consulted in BOTH axes,
      // and invalid partial text stays local (never propagates).
      const widthMm = parseMm(edit.widthRaw);
      if (widthMm !== null && widthMm > 0 && lockFor(configuration.id, placement, placementIndex).locked) {
        const tx = beginEdit(
          { xMm: placement.pos.xMm, yMm: placement.pos.yMm, widthMm: placement.widthMm,
            heightMm: placement.heightMm, rotationDeg: placement.rotationDeg },
          lockFor(configuration.id, placement, placementIndex),
        );
        edit.heightRaw = String(Math.round(setCandidateWidth(tx, widthMm).candidate.heightMm * 100) / 100);
      }
      update();
    });
    widthLabel.append(widthInput);
    group.append(widthLabel);
    if (pending && fieldErrors.width !== undefined) {
      widthInput.setAttribute('aria-invalid', 'true');
      widthInput.setAttribute('aria-describedby', 'pw-width-error');
      group.append(selectedFieldError('pw-width-error', fieldErrors.width));
    } else {
      widthInput.setAttribute('aria-invalid', 'false');
    }
    group.append(helpPopover('pw-help-size', 'Width and height edit the same logo: when proportions are locked, changing one side scales the other. Partial numbers stay local until they are valid.'));

    const heightLabel = el('label', 'pw-field', 'pw-field-height');
    heightLabel.textContent = 'Height (mm)';
    const heightInput = el('input', '', 'pw-height') as HTMLInputElement;
    heightInput.type = 'number';
    heightInput.min = '0';
    heightInput.step = 'any';
    heightInput.value = edit.heightRaw;
    heightInput.addEventListener('input', () => {
      edit.heightRaw = heightInput.value;
      const heightMm = parseMm(edit.heightRaw);
      if (heightMm !== null && heightMm > 0 && lockFor(configuration.id, placement, placementIndex).locked) {
        const tx = beginEdit(
          { xMm: placement.pos.xMm, yMm: placement.pos.yMm, widthMm: placement.widthMm,
            heightMm: placement.heightMm, rotationDeg: placement.rotationDeg },
          lockFor(configuration.id, placement, placementIndex),
        );
        edit.widthRaw = String(Math.round(setCandidateHeight(tx, heightMm).candidate.widthMm * 100) / 100);
      }
      update();
    });
    heightLabel.append(heightInput);
    group.append(heightLabel);
    if (pending && fieldErrors.height !== undefined) {
      heightInput.setAttribute('aria-invalid', 'true');
      heightInput.setAttribute('aria-describedby', 'pw-height-error');
      group.append(selectedFieldError('pw-height-error', fieldErrors.height));
    } else {
      heightInput.setAttribute('aria-invalid', 'false');
    }

    const keep = el('label', 'pw-check', 'pw-field-keep');
    const keepBox = el('input', '', 'pw-keep') as HTMLInputElement;
    keepBox.type = 'checkbox';
    keepBox.checked = lockFor(configuration.id, placement, placementIndex).locked;
    keepBox.addEventListener('change', () => {
      // Locking captures the CURRENT placement ratio; unlocking or toggling
      // never rolls back committed geometry. The preference persists across
      // commits and selection changes.
      if (keepBox.checked) {
        const captured = policyForLock({
          xMm: placement.pos.xMm, yMm: placement.pos.yMm, widthMm: parseMm(edit.widthRaw) ?? placement.widthMm,
          heightMm: parseMm(edit.heightRaw) ?? placement.heightMm, rotationDeg: placement.rotationDeg,
        });
        ratioLocks.set(key, captured.locked ? captured : { locked: false, ratio: captured.ratio });
      } else {
        const prev = ratioLocks.get(key);
        ratioLocks.set(key, { locked: false, ratio: prev?.ratio ?? NaN });
      }
      update();
    });
    keep.append(keepBox, document.createTextNode('Keep proportions'));
    group.append(keep);
    const resetRatio = el('button', 'pw-secondary', 'pw-ratio-reset') as HTMLButtonElement;
    resetRatio.type = 'button';
    resetRatio.textContent = 'Reset to artwork ratio';
    resetRatio.title = 'Re-anchor the proportions lock to the original artwork ratio (geometry unchanged)';
    resetRatio.addEventListener('click', () => {
      const aspect = logoPixelAspect(project, edit.logoId);
      if (aspect === null || !(aspect > 0)) {
        announce('No known artwork ratio for this logo; the lock keeps the placement ratio.');
        update();
        return;
      }
      const prev = lockFor(configuration.id, placement, placementIndex);
      const tx = resetToArtworkRatio(
        beginEdit(
          { xMm: placement.pos.xMm, yMm: placement.pos.yMm, widthMm: placement.widthMm,
            heightMm: placement.heightMm, rotationDeg: placement.rotationDeg },
          prev,
        ),
        aspect * 100, 100,
      );
      ratioLocks.set(key, tx.policy);
      announce('Ratio lock now follows the original artwork ratio. Geometry unchanged.');
      update();
    });
    group.append(resetRatio);

    const rotationLabel = el('label', 'pw-field', 'pw-field-rotation');
    rotationLabel.textContent = 'Rotation (degrees)';
    const rotationInput = el('input', '', 'pw-rotation') as HTMLInputElement;
    rotationInput.type = 'number';
    rotationInput.step = 'any';
    rotationInput.value = edit.rotationRaw;
    rotationInput.addEventListener('input', () => {
      edit.rotationRaw = rotationInput.value;
      update();
    });
    rotationLabel.append(rotationInput);
    group.append(rotationLabel);
    if (pending && fieldErrors.rotation !== undefined) {
      rotationInput.setAttribute('aria-invalid', 'true');
      rotationInput.setAttribute('aria-describedby', 'pw-rotation-error');
      group.append(selectedFieldError('pw-rotation-error', fieldErrors.rotation));
    } else {
      rotationInput.setAttribute('aria-invalid', 'false');
    }

    renderMeasurements(group, project, configuration, placement, placementIndex);

    const editRow = el('div', 'pw-inline', 'pw-edit-actions');
    const duplicate = el('button', 'pw-secondary', 'pw-duplicate') as HTMLButtonElement;
    duplicate.type = 'button';
    duplicate.textContent = 'Duplicate placement';
    // Duplicating mints a NEW placement, so it shares the excluded-scope
    // creation block (removing the existing placement below stays allowed).
    if (isExcludedScope(configuration)) {
      duplicate.disabled = true;
      duplicate.title = excludedScopeMessage(project, configuration.productId, configuration.variantId);
    }
    duplicate.addEventListener('click', () => {
      if (isExcludedScope(configuration)) {
        announce(excludedScopeMessage(project, configuration.productId, configuration.variantId));
        update();
        return;
      }
      const id = deps.newPlacementId();
      const copy: Placement = {
        ...placement,
        pos: { ...placement.pos },
        id,
      };
      let next: ProjectDocument;
      try {
        next = addPlacementToConfig(deps.getProject(), configuration.id, copy);
      } catch (error) {
        announce(`Duplicate blocked: ${error instanceof Error ? error.message : String(error)}`);
        update();
        return;
      }
      if (commitNext('Duplicate placement', next)) {
        deps.setSelection({ placementId: id });
        announce('Placement duplicated.');
        update();
      }
    });
    const remove = el('button', 'pw-secondary', 'pw-remove') as HTMLButtonElement;
    remove.type = 'button';
    remove.textContent = 'Remove placement';
    remove.addEventListener('click', () => {
      let next: ProjectDocument;
      try {
        next = removePlacementFromConfig(
          deps.getProject(),
          configuration.id,
          placementSelector(placement, placementIndex),
        );
      } catch (error) {
        announce(`Remove blocked: ${error instanceof Error ? error.message : String(error)}`);
        update();
        return;
      }
      if (commitNext('Remove placement', next)) {
        staged.delete(key);
        ratioLocks.delete(key);
        const remaining = next.configurations.find((entry) => entry.id === configuration.id)?.placements ?? [];
        const first = remaining[0];
        deps.setSelection({ placementId: first?.id ?? null });
        announce('Placement removed.');
        update();
      }
    });
    editRow.append(duplicate, remove);
    group.append(editRow);

    if (pending) {
      const applyRow = el('div', 'pw-inline', 'pw-apply-row');
      const apply = el('button', 'pw-primary', 'pw-apply') as HTMLButtonElement;
      apply.type = 'button';
      apply.textContent = 'Apply changes';
      // Same first failure applyStaged would announce: Apply stays disabled
      // while any field is invalid, with the reason linked for AT.
      const firstError = firstSelectedEditError(fieldErrors);
      if (firstError !== undefined) {
        apply.disabled = true;
        apply.setAttribute('aria-describedby', 'pw-apply-reason');
        apply.title = firstError;
      }
      apply.addEventListener('click', () => {
        applyStaged(configuration, placement, placementIndex, edit);
      });
      applyRow.append(apply);
      if (firstError !== undefined) {
        applyRow.append(selectedFieldError('pw-apply-reason', `Apply disabled: ${firstError}`));
      }
      group.append(applyRow);
    }

    const precise = el('details', '', 'pw-precise-position') as HTMLDetailsElement;
    const preciseSummary = el('summary', '');
    preciseSummary.textContent = 'Precise position';
    precise.append(preciseSummary);
    const region = product.regions.find((entry) => entry.id === placement.regionId);
    const xLabel = el('label', 'pw-field', 'pw-field-x');
    xLabel.textContent = 'X centre (mm)';
    const xInput = el('input', '', 'pw-x') as HTMLInputElement;
    xInput.type = 'number';
    xInput.step = 'any';
    xInput.value = edit.centreXRaw;
    xInput.addEventListener('input', () => {
      edit.centreXRaw = xInput.value;
      update();
    });
    xLabel.append(xInput);
    precise.append(xLabel);
    if (pending && fieldErrors.x !== undefined) {
      xInput.setAttribute('aria-invalid', 'true');
      xInput.setAttribute('aria-describedby', 'pw-x-error');
      precise.append(selectedFieldError('pw-x-error', fieldErrors.x));
    } else {
      xInput.setAttribute('aria-invalid', 'false');
    }
    const yLabel = el('label', 'pw-field', 'pw-field-y');
    yLabel.textContent = 'Y centre (mm)';
    const yInput = el('input', '', 'pw-y') as HTMLInputElement;
    yInput.type = 'number';
    yInput.step = 'any';
    yInput.value = edit.centreYRaw;
    yInput.addEventListener('input', () => {
      edit.centreYRaw = yInput.value;
      update();
    });
    yLabel.append(yInput);
    precise.append(yLabel);
    if (pending && fieldErrors.y !== undefined) {
      yInput.setAttribute('aria-invalid', 'true');
      yInput.setAttribute('aria-describedby', 'pw-y-error');
      precise.append(selectedFieldError('pw-y-error', fieldErrors.y));
    } else {
      yInput.setAttribute('aria-invalid', 'false');
    }
    const convention = el('p', 'pw-muted', 'pw-frame-convention');
    convention.textContent = region !== undefined
      ? `Centre is the centre of the rectangular artwork footprint in millimetres. ` +
      `Origin: ${region.frame.originDescription}; +x ${region.frame.axes.xPositive}; ` +
      `+y ${region.frame.axes.yPositive}. Rotation is clockwise degrees facing the region.`
      : 'Centre is the centre of the rectangular artwork footprint in millimetres.';
    precise.append(convention);
    group.append(precise);

    const methodRegion = product.regions.find((entry) => entry.id === edit.regionId);
    if (methodRegion !== undefined && methodRegion.allowedMethods.length > 1) {
      const methodField = el('label', 'pw-field', 'pw-field-method');
      methodField.textContent = 'Method';
      const methodSelect = el('select', '', 'pw-method') as HTMLSelectElement;
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Choose a method';
      methodSelect.append(blank);
      for (const method of methodRegion.allowedMethods) {
        const option = document.createElement('option');
        option.value = method;
        option.textContent = methodLabel(method);
        methodSelect.append(option);
      }
      if (edit.method !== '' && !methodRegion.allowedMethods.includes(edit.method)) {
        const option = document.createElement('option');
        option.value = edit.method;
        option.textContent = `${methodLabel(edit.method)} (not offered here)`;
        methodSelect.append(option);
      }
      methodSelect.value = edit.method;
      methodSelect.addEventListener('change', () => {
        edit.method = methodSelect.value;
        update();
      });
      methodField.append(methodSelect);
      group.append(methodField);
      if (pending && fieldErrors.method !== undefined) {
        methodSelect.setAttribute('aria-invalid', 'true');
        methodSelect.setAttribute('aria-describedby', 'pw-method-error');
        group.append(selectedFieldError('pw-method-error', fieldErrors.method));
      } else {
        methodSelect.setAttribute('aria-invalid', 'false');
      }
    } else if (pending && fieldErrors.method !== undefined) {
      // Single-method (or unconfigured) areas render no method control, yet
      // Apply still requires an offered method: surface it inline here.
      group.append(selectedFieldError('pw-method-error', fieldErrors.method));
    }

    const methods = el('details', '', 'pw-more-methods') as HTMLDetailsElement;
    const methodsSummary = el('summary', ''); methodsSummary.textContent = 'More methods'; methods.append(methodsSummary);
    const methodHint = el('p', 'pw-muted'); methodHint.textContent = 'Enable a method for this safe area and use it for the selected logo. Process settings are entered separately.'; methods.append(methodHint);
    const methodButtons = el('div', 'pw-inline');
    const enableMethod = (name: string): void => {
      try {
        const live = currentContext();
        if (!live.configuration || live.placementIndex < 0) return;
        if (!live.placement) return;
        if (edit.regionId !== live.placement.regionId) { announce('Apply the safe-area change before enabling a method.'); return; }
        const candidate = candidatePlacement(live.configuration.id, live.placement, live.placementIndex);
        const next = configurePlacementMethod(live.project, live.configuration.id, live.placementIndex, name, candidate);
        if (commitNext('Configure decoration method', next)) {
          staged.delete(placementKeyOf(configuration.id, placement, placementIndex));
          announce(`Method set to ${methodLabel(name.trim())}.`); update();
        }
      } catch (error) { announce(error instanceof Error ? error.message : String(error)); }
    };
    for (const method of SUPPORTED_METHODS.filter((entry) => entry.key !== 'other')) {
      if (methodRegion?.allowedMethods.includes(method.key)) continue;
      const enable = el('button', 'pw-secondary') as HTMLButtonElement;
      enable.type = 'button'; enable.textContent = `Enable ${method.label}`;
      enable.addEventListener('click', () => enableMethod(method.key)); methodButtons.append(enable);
    }
    methods.append(methodButtons);
    const custom = el('label', 'pw-field'); custom.textContent = 'Other method name';
    const customName = el('input', '', 'pw-custom-method-name') as HTMLInputElement;
    customName.type = 'text'; customName.maxLength = 80; customName.placeholder = 'Enter the department’s method name'; custom.append(customName);
    const useCustom = el('button', 'pw-secondary', 'pw-custom-method-use') as HTMLButtonElement;
    useCustom.type = 'button'; useCustom.textContent = 'Enable and use method';
    useCustom.addEventListener('click', () => enableMethod(customName.value)); methods.append(custom, useCustom);
    group.append(methods);

    const details = el('details', '', 'pw-production-details') as HTMLDetailsElement;
    const detailsSummary = el('summary', '');
    detailsSummary.textContent = 'Production details';
    details.append(detailsSummary);
    const methodLine = el('p', 'pw-muted', 'pw-method-readout');
    methodLine.textContent = `Method: ${edit.method ? methodLabel(edit.method) : '(choose a method above)'}`;
    details.append(methodLine);
    if (placement.instructions !== undefined && placement.instructions !== '') {
      const note = el('p', 'pw-muted', 'pw-customer-note');
      note.textContent = `Customer note (read-only context): ${placement.instructions}`;
      details.append(note);
    }
    const logoRef = logoRefForPlacement(configuration.placements, placementIndex);
    if (deps.getTechnique !== undefined && deps.setTechnique !== undefined) {
      let technique: PlacementTechnique | null = null;
      try {
        technique = deps.getTechnique(configuration.id, logoRef) ?? null;
      } catch {
        technique = null;
      }
      const current: PlacementTechnique = technique ?? {
        businessCode: '',
        temperature: '',
        time: '',
        pressure: '',
        colour: '',
        thread: '',
      };
      const codeLabel = el('label', 'pw-field', 'pw-tech-code');
      codeLabel.textContent = 'Business code';
      const codeInput = el('input', '', 'pw-tech-code-input') as HTMLInputElement;
      codeInput.type = 'text';
      codeInput.autocomplete = 'off';
      codeInput.value = current.businessCode;
      const saveTechnique = (): void => {
        try {
          deps.setTechnique?.(configuration.id, logoRef, {
            businessCode: codeInput.value,
            temperature: tempInput.value,
            time: timeInput.value,
            pressure: pressureInput.value,
            colour: colourInput.value,
            thread: threadInput.value,
          });
        } catch (error) {
          announce(`Technique save failed: ${error instanceof Error ? error.message : String(error)}`);
          update();
        }
      };
      codeInput.addEventListener('change', saveTechnique);
      codeLabel.append(codeInput);
      details.append(codeLabel);
      const tempInput = el('input', '', 'pw-tech-temperature') as HTMLInputElement;
      const timeInput = el('input', '', 'pw-tech-time') as HTMLInputElement;
      const pressureInput = el('input', '', 'pw-tech-pressure') as HTMLInputElement;
      const colourInput = el('input', '', 'pw-tech-colour') as HTMLInputElement;
      const threadInput = el('input', '', 'pw-tech-thread') as HTMLInputElement;
      const fields: Array<[string, HTMLInputElement, string]> = [
        ['Temperature', tempInput, current.temperature],
        ['Time', timeInput, current.time],
        ['Pressure', pressureInput, current.pressure],
        ['Colour', colourInput, current.colour],
        ['Thread', threadInput, current.thread],
      ];
      for (const [labelText, input, value] of fields) {
        const label = el('label', 'pw-field');
        label.textContent = labelText;
        input.type = 'text';
        input.autocomplete = 'off';
        input.value = value;
        input.addEventListener('change', saveTechnique);
        label.append(input);
        details.append(label);
      }
    }
    group.append(details);
    rail.append(group);
  }

  function renderMeasurements(
    group: HTMLElement,
    project: ProjectDocument,
    configuration: Configuration,
    placement: Placement,
    placementIndex: number,
  ): void {
    const section = el('div', '', 'pw-measurements');
    const heading = el('h4', '', 'pw-measurements-title');
    heading.textContent = 'Placement measurements';
    section.append(heading);
    if (modelView && deps.addAnchor) {
      const ref = el('label', 'pw-field'); ref.textContent = 'Reference point name';
      const name = el('input', '', 'pw-model-anchor-name') as HTMLInputElement;
      name.type = 'text'; name.maxLength = 80; name.placeholder = 'e.g. Collar centre'; ref.append(name);
      const addReference = el('button', 'pw-secondary', 'pw-model-anchor-add') as HTMLButtonElement;
      addReference.type = 'button'; addReference.textContent = 'Pick reference on model';
      addReference.addEventListener('click', () => {
        const count = deps.getAnchors(configuration.productId, configuration.variantId, placement.regionId).length;
        modelView?.beginAnchorPick(name.value.trim() || `Reference ${count + 1}`);
      });
      section.append(ref, addReference);
    }
    const rows = bindingsForPlacement(configuration.id, configuration.placements, placementIndex);
    const summary = el('p', 'pw-muted', 'pw-measurements-summary');
    summary.textContent = rows.length === 0
      ? 'No measurements yet.'
      : `${rows.length} measurement${rows.length === 1 ? '' : 's'}.`;
    section.append(summary);
    for (const binding of rows) {
      const row = el('div', 'pw-measure', `pw-measurement-${binding.label}`);
      const label = el('p', '');
      const anchorName = deps.getAnchors(configuration.productId, configuration.variantId, placement.regionId)
        .find((entry) => entry.id === binding.anchorId)?.name ?? 'unknown anchor';
      let valueText = 'unresolved';
      const anchor = deps.getAnchors(configuration.productId, configuration.variantId, placement.regionId)
        .find((entry) => entry.id === binding.anchorId);
      if (anchor !== undefined) {
        const footprint = rotatedFootprintCorners(
          placement.pos.xMm, placement.pos.yMm,
          placement.widthMm, placement.heightMm, placement.rotationDeg,
        ).map((corner) => ({ x: corner.x, y: corner.y }));
        const measured = measureEdgeToAnchor(
          footprint,
          { x: anchor.posMm[0]!, y: anchor.posMm[1]! },
          { edge: binding.edge, convention: binding.convention },
        );
        if (measured.ok) valueText = `${displayMm(measured.valueMm)} mm`;
        else valueText = `unresolved (${measured.error})`;
      }
      label.textContent = `${binding.label}: from “${anchorName}” — ${valueText}.`;
      row.append(label);
      const remove = el('button', 'pw-secondary', 'pw-measurement-remove') as HTMLButtonElement;
      remove.type = 'button';
      remove.textContent = `Remove “${binding.label}”`;
      remove.addEventListener('click', () => {
        let bindings: DimensionBinding[];
        try {
          bindings = deps.getBindings(configuration.id);
        } catch {
          return;
        }
        const logoRef = logoRefForPlacement(configuration.placements, placementIndex);
        const nextBindings = bindings.filter((entry) =>
          !(entry.logoRef === logoRef && entry.anchorId === binding.anchorId &&
            entry.edge === binding.edge && entry.convention === binding.convention &&
            entry.label === binding.label));
        try {
          deps.setBindings(configuration.id, nextBindings);
        } catch (error) {
          announce(`Remove measurement failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        update();
      });
      row.append(remove);
      section.append(row);
    }
    const add = el('button', 'pw-secondary', 'pw-measurement-add') as HTMLButtonElement;
    add.type = 'button';
    add.textContent = 'Add measurement';
    add.addEventListener('click', () => {
      measureOpen = true;
      const scoped = deps.getAnchors(configuration.productId, configuration.variantId, placement.regionId);
      measureDraft = {
        anchorId: scoped[0]?.id ?? '',
        edge: 'minX',
        convention: 'dx',
        notice: '',
        picking: null,
        preview: null,
      };
      update();
    });
    section.append(add);
    if (measureOpen) renderMeasureForm(section, configuration, placement, placementIndex);
    group.append(section);
  }

  function renderMeasureForm(
    section: HTMLElement,
    configuration: Configuration,
    placement: Placement,
    placementIndex: number,
  ): void {
    const draft = measureDraft;
    if (draft === null) return;
    const form = el('div', '', 'pw-measure-form');
    const scoped = deps.getAnchors(configuration.productId, configuration.variantId, placement.regionId)
      .filter((anchor) => anchor.productId === configuration.productId &&
        anchor.variantId === configuration.variantId &&
        anchor.regionId === placement.regionId);
    if (scoped.length === 0) {
      const note = el('p', 'pw-error', 'pw-measure-no-anchors');
      note.textContent = 'Set up an anchor on this product to measure from.';
      form.append(note);
      const setup = el('button', 'pw-secondary', 'pw-measure-setup') as HTMLButtonElement;
      setup.type = 'button';
      setup.textContent = 'Set up product';
      setup.addEventListener('click', () => {
        deps.requestProductSetup(configuration.productId, configuration.variantId, placement.regionId);
      });
      form.append(setup);
      const cancel = el('button', 'pw-secondary', 'pw-measure-cancel') as HTMLButtonElement;
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        measureOpen = false;
        measureDraft = null;
        update();
      });
      form.append(cancel);
      section.append(form);
      return;
    }
    const anchorLabel = el('label', 'pw-field', 'pw-measure-anchor-field');
    anchorLabel.textContent = 'Anchor';
    const anchorSelect = el('select', '', 'pw-measure-anchor') as HTMLSelectElement;
    for (const anchor of scoped) {
      const option = document.createElement('option');
      option.value = anchor.id;
      option.textContent = anchor.name;
      anchorSelect.append(option);
    }
    anchorSelect.value = draft.anchorId;
    anchorSelect.addEventListener('change', () => {
      draft.anchorId = anchorSelect.value;
      draft.preview = null;
    });
    anchorLabel.append(anchorSelect);
    form.append(anchorLabel);

    const edgeLabel = el('label', 'pw-field', 'pw-measure-edge-field');
    edgeLabel.textContent = 'Logo edge';
    const edgeSelect = el('select', '', 'pw-measure-edge') as HTMLSelectElement;
    for (const edge of ['minX', 'maxX', 'minY', 'maxY'] as const) {
      const option = document.createElement('option');
      option.value = edge;
      option.textContent = EDGE_WORD[edge];
      edgeSelect.append(option);
    }
    edgeSelect.value = draft.edge;
    edgeSelect.addEventListener('change', () => {
      draft.edge = edgeSelect.value as ArtworkEdge;
      draft.preview = null;
    });
    edgeLabel.append(edgeSelect);
    form.append(edgeLabel);

    const conventionLabel = el('label', 'pw-field', 'pw-measure-direction-field');
    conventionLabel.textContent = 'Direction';
    const conventionSelect = el('select', '', 'pw-measure-direction') as HTMLSelectElement;
    for (const convention of ['dx', 'dy', 'shortest-to-edge'] as const) {
      const option = document.createElement('option');
      option.value = convention;
      option.textContent = CONVENTION_WORD[convention];
      conventionSelect.append(option);
    }
    conventionSelect.value = draft.convention;
    conventionSelect.addEventListener('change', () => {
      draft.convention = conventionSelect.value as MeasurementConvention;
      draft.preview = null;
    });
    conventionLabel.append(conventionSelect);
    form.append(conventionLabel);

    const pick = el('button', 'pw-secondary', 'pw-measure-pick') as HTMLButtonElement;
    pick.type = 'button';
    pick.textContent = draft.picking !== null
      ? 'Picking on diagram… (click anchor, then logo edge; Esc cancels)'
      : 'Pick on diagram';
    pick.addEventListener('click', () => {
      draft.picking = { anchorClickMm: null };
      draft.preview = null;
      draft.notice = 'Click near a named anchor on the diagram, then near the logo edge.';
      update();
    });
    form.append(pick);

    if (draft.preview !== null) {
      const preview = el('p', 'pw-ok', 'pw-measure-preview');
      preview.textContent = `Picked value: ${displayMm(draft.preview.valueMm)} mm.`;
      form.append(preview);
    }
    if (draft.notice !== '') {
      const notice = el('p', 'pw-muted', 'pw-measure-notice');
      notice.setAttribute('role', 'status');
      notice.textContent = draft.notice;
      form.append(notice);
    }

    const row = el('div', 'pw-inline');
    const save = el('button', 'pw-primary', 'pw-measure-save') as HTMLButtonElement;
    save.type = 'button';
    save.textContent = 'Save measurement';
    save.addEventListener('click', () => {
      saveMeasurement(configuration, placement, placementIndex, draft, scoped);
    });
    const cancel = el('button', 'pw-secondary', 'pw-measure-cancel') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      measureOpen = false;
      measureDraft = null;
      update();
    });
    row.append(save, cancel);
    form.append(row);
    section.append(form);
  }

  function saveMeasurement(
    configuration: Configuration,
    placement: Placement,
    placementIndex: number,
    draft: MeasureDraft,
    scoped: AnchorDef[],
  ): void {
    const anchor = scoped.find((entry) => entry.id === draft.anchorId);
    if (anchor === undefined) {
      draft.notice = 'Choose a named anchor for this measurement.';
      update();
      return;
    }
    if (draft.convention === 'dx' && draft.edge !== 'minX' && draft.edge !== 'maxX') {
      draft.notice =
        `Horizontal measures the left or right edge — “${EDGE_WORD[draft.edge]}” is not ` +
        `compatible. Choose left or right, or switch Direction.`;
      update();
      return;
    }
    if (draft.convention === 'dy' && draft.edge !== 'minY' && draft.edge !== 'maxY') {
      draft.notice =
        `Vertical measures the bottom or top edge — “${EDGE_WORD[draft.edge]}” is not ` +
        `compatible. Choose bottom or top, or switch Direction.`;
      update();
      return;
    }
    const footprint = rotatedFootprintCorners(
      placement.pos.xMm, placement.pos.yMm,
      placement.widthMm, placement.heightMm, placement.rotationDeg,
    ).map((corner) => ({ x: corner.x, y: corner.y }));
    const measured = measureEdgeToAnchor(
      footprint,
      { x: anchor.posMm[0]!, y: anchor.posMm[1]! },
      { edge: draft.edge, convention: draft.convention },
    );
    if (!measured.ok) {
      draft.notice = `Measurement refused: ${measured.error}`;
      update();
      return;
    }
    const directionWord = draft.convention === 'dx'
      ? 'horizontal'
      : draft.convention === 'dy' ? 'vertical' : 'shortest';
    const label = `${anchor.name} to ${EDGE_WORD[draft.edge]} edge, ${directionWord}`;
    const binding: DimensionBinding = {
      logoRef: logoRefForPlacement(configuration.placements, placementIndex),
      anchorId: anchor.id,
      edge: draft.edge,
      convention: draft.convention,
      label,
    };
    let bindings: DimensionBinding[];
    try {
      bindings = deps.getBindings(configuration.id);
    } catch (error) {
      draft.notice = `Could not load measurements: ${error instanceof Error ? error.message : String(error)}`;
      update();
      return;
    }
    try {
      deps.setBindings(configuration.id, [...bindings, binding]);
    } catch (error) {
      draft.notice = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
      update();
      return;
    }
    measureOpen = false;
    measureDraft = null;
    announce(`Measurement saved: ${label} — ${displayMm(measured.valueMm)} mm.`);
    update();
  }

  function renderValidation(
    rail: HTMLElement,
    project: ProjectDocument,
    configuration: Configuration,
  ): void {
    const { selection, placement } = currentContext();
    const box = el('div', '', 'pw-validation');
    const gate = reviewGateForConfiguration(
      project,
      configuration.id,
      deps.getAnchors(selection.productId, selection.variantId, placement?.regionId ?? ''),
      deps.getBindings(configuration.id),
      anyPendingForConfiguration(configuration),
      addDraft !== null && addOpen && isAddDirty(addDraft),
    );
    for (const blocker of gate.blockers) {
      const line = el('p', 'pw-error', 'pw-blocker');
      line.setAttribute('role', 'alert');
      line.textContent = blocker;
      box.append(line);
    }
    for (const issue of gate.issues) {
      const line = el('p', 'pw-warning', 'pw-issue');
      line.textContent = issue;
      box.append(line);
    }
    for (const notice of gate.notices) {
      // The placements list already shows the empty-option note; repeating
      // the same sentence in validation would duplicate it in the popup.
      if (notice === 'No logo placements for this option.' && configuration.placements.length === 0) continue;
      const line = el('p', 'pw-muted', 'pw-notice');
      line.textContent = notice;
      box.append(line);
    }
    rail.append(box);
  }

  function collectPendingEdits(): PendingPlacementEdit[] {
    const out: PendingPlacementEdit[] = [];
    let project: ProjectDocument;
    try {
      project = deps.getProject();
    } catch { return out; }
    for (const configuration of project.configurations) {
      configuration.placements.forEach((placement, index) => {
        const key = placementKeyOf(configuration.id, placement, index);
        const edit = staged.get(key);
        if (edit === undefined || !stagedDiffers(placement, edit)) return;
        const logoName = logoNameOf(project, placement.logoId).trim() || placement.logoId;
        const areaName = areaNameOf(project, configuration.productId, placement.regionId).trim() || placement.regionId;
        out.push({
          productId: configuration.productId,
          variantId: configuration.variantId,
          configId: configuration.id,
          placementIndex: index,
          ...(placement.id !== undefined ? { placementId: placement.id } : {}),
          label: `Unapplied changes to ${logoName} in ${areaName}: apply them before review, print, saving or issuing.`,
        });
      });
    }
    return out;
  }

  function hasPendingEdits(): boolean {
    if (addDraft !== null && addOpen && isAddDirty(addDraft)) return true;
    return collectPendingEdits().length > 0;
  }

  function applyPendingEdits(): { applied: number; blocked: number } {
    let applied = 0;
    let blocked = 0;
    let project: ProjectDocument;
    try {
      project = deps.getProject();
    } catch { return { applied, blocked }; }
    for (const configuration of project.configurations) {
      const placements = [...configuration.placements];
      for (const [index, placement] of placements.entries()) {
        const key = placementKeyOf(configuration.id, placement, index);
        const edit = staged.get(key);
        if (edit === undefined || !stagedDiffers(placement, edit)) continue;
        const before = staged.size;
        applyStaged(configuration, placement, index, edit);
        if (staged.size < before || !staged.has(key)) applied += 1;
        else blocked += 1;
        try {
          project = deps.getProject();
        } catch { break; }
      }
    }
    update();
    return { applied, blocked };
  }

  function discardPendingEdits(): number {
    const count = collectPendingEdits().length;
    staged.clear();
    update();
    return count;
  }

  function rebaseAfterProjectSwap(previous: ProjectDocument): void {
    let current: ProjectDocument;
    try {
      current = deps.getProject();
    } catch { return; }
    const liveKeys = new Set<string>();
    for (const configuration of current.configurations) {
      configuration.placements.forEach((placement, index) => {
        liveKeys.add(placementKeyOf(configuration.id, placement, index));
      });
    }
    const previousByKey = new Map<string, Placement>();
    for (const configuration of previous.configurations) {
      configuration.placements.forEach((placement, index) => {
        const key = placementKeyOf(configuration.id, placement, index);
        if (!previousByKey.has(key)) previousByKey.set(key, placement);
      });
    }
    for (const [key, edit] of [...staged]) {
      const old = previousByKey.get(key);
      if (old !== undefined && !stagedDiffers(old, edit)) {
        // Merely mirrored the pre-swap committed values (render-created):
        // the swap changed the geometry, so this is stale, not a user edit.
        staged.delete(key);
        continue;
      }
      if (!liveKeys.has(key)) {
        // Scope is gone; nothing left to apply to.
        staged.delete(key);
        ratioLocks.delete(key);
      }
    }
    for (const key of [...ratioLocks.keys()]) {
      if (!liveKeys.has(key)) ratioLocks.delete(key);
    }
    // A dirty add draft whose artwork or safe area vanished cannot apply:
    // clear it. Valid drafts stay guarded (they still block save/review).
    if (addDraft !== null && isAddDirty(addDraft)) {
      const logoGone = addDraft.logoId !== '' &&
        !current.logos.some((logo) => logo.id === addDraft?.logoId);
      const regionGone = addDraft.regionId !== '' &&
        !current.products.some((product) => product.regions.some((region) => region.id === addDraft?.regionId));
      if (logoGone || regionGone) {
        addDraft = null;
        addOpen = false;
      }
    }
    // Diagram picks/previews are transient canvas state bound to the previous
    // geometry: drop them, keep the chosen anchor/edge/convention.
    if (measureDraft !== null) {
      measureDraft.picking = null;
      measureDraft.preview = null;
    }
    update();
  }

  update();

  // Native tray drops use the existing calibrated surface/diagram inverse.
  // Pixel positions select a surface point; region millimetres remain authoritative.
  root.addEventListener('dragover', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-placement-hook="pw-model-workbench"],[data-placement-hook="pw-stage-svg"],.pw-stage') !== null) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    }
  });
  root.addEventListener('drop', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-placement-hook="pw-model-workbench"],[data-placement-hook="pw-stage-svg"],.pw-stage') === null) return;
    let logoId: string | null = pendingTrayDrop;
    try {
      const viaTransfer = event.dataTransfer?.getData('text/logo-id');
      if (viaTransfer !== undefined && viaTransfer !== '') logoId = viaTransfer;
    } catch { /* fall back to the pending pick */ }
    pendingTrayDrop = null;
    if (logoId === null || logoId === '') return;
    event.preventDefault();
    const context = currentContext();
    if (context.configuration === null || !context.project.logos.some((logo) => logo.id === logoId)) return;
    const included = deps.getIncludedLogoIds?.();
    if (included && !included.includes(logoId)) return;
    const destination = stageDropPoint?.(event.clientX, event.clientY);
    if (!destination) { announce('Drop the artwork on the visible calibrated product surface.'); return; }
    placeProvisional(context.project, context.configuration, logoId, destination);
  });

  return {
    suspend() { modelView?.update(null); contextPanel?.close(); },
    closeEnlarged: () => expansion.close(),
    hasPendingEdits,
    pendingEdits: collectPendingEdits,
    applyPendingEdits,
    discardPendingEdits,
    rebaseAfterProjectSwap,
    update,
    destroy() {
      destroyed = true;
      contextPanel?.destroy(); contextPanel = null;
      expansion.destroy(); modelView?.destroy(); modelView = null; modelViewDisplayOnly = false;
      aborter.abort(); stageAborter?.abort();
      styleNode.remove();
      root.replaceChildren();
    },
  };
}
