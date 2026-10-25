/// <reference lib="dom" />
/**
 * Placement workspace — Step 2 "Set logo placements" (operator workflow, spec §5).
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
import { resolveVisualDimension } from '../../core/visual-dimension/index.js';
import { displayVariantName } from '../../core/operation-document/index.js';
import { validateProject } from '../../core/validate.js';
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
  getStageOverlay(
    productId: string,
    variantId: string,
    regionId: string,
    viewId: string | null,
  ): PlacementStageOverlay | null;
  getLogoImage(logoId: string): { src: string; alt: string } | null;
  /** Anchors scoped to one product/option/region (caller filters; module refilters). */
  getAnchors(productId: string, variantId: string, regionId: string): AnchorDef[];
  getBindings(configurationId: string): DimensionBinding[];
  setBindings(configurationId: string, bindings: DimensionBinding[]): void;
  getTechnique?(configurationId: string, logoRef: string): PlacementTechnique | null;
  setTechnique?(configurationId: string, logoRef: string, technique: PlacementTechnique): void;
  /** Scoped product-setup route (missing calibration / safe areas / anchors). */
  requestProductSetup(productId: string, variantId?: string, regionId?: string): void;
  /** Show the existing model viewer for inspection (model mode only). */
  onViewModel?(productId: string): void;
  /** No logos exist yet: return/focus the Step 1 logo control. */
  onAddLogo(): void;
  onReview(): void;
  onApprovalBranch(): void;
  onBack(): void;
  onStatus?(message: string): void;
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
  const styleNode = document.createElement('style');
  styleNode.textContent = STYLE_TEXT;
  styleNode.setAttribute(HOOK, 'pw-style');
  document.head.append(styleNode);

  const staged = new Map<string, StagedEdits>();
  let addOpen = false;
  let addDraft: AddDraft | null = null;
  let measureOpen = false;
  let measureDraft: MeasureDraft | null = null;
  let status = '';
  const viewCache = new Map<string, { cx: number; cy: number; span: number }>();
  let viewOverride: { cx: number; cy: number; span: number } | null = null;
  const aborter = new AbortController();

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
    if (region === undefined) {
      announce('Apply blocked: choose a current safe area for this placement.');
      update();
      return;
    }
    if (!region.allowedMethods.includes(edit.method)) {
      announce(
        `Apply blocked: method “${edit.method || '(none)'}” is not offered in ` +
        `“${region.name?.trim() || 'unnamed area'}”. Choose one of: ${region.allowedMethods.join(', ') || '(none configured)'}.`,
      );
      update();
      return;
    }
    const widthMm = parseMm(edit.widthRaw);
    const heightMm = parseMm(edit.heightRaw);
    const rotationRaw = parseMm(edit.rotationRaw);
    const xMm = parseMm(edit.centreXRaw);
    const yMm = parseMm(edit.centreYRaw);
    if (widthMm === null || !(widthMm > 0)) {
      announce('Apply blocked: Width must be a number greater than 0 mm.');
      update();
      return;
    }
    if (heightMm === null || !(heightMm > 0)) {
      announce('Apply blocked: Height must be a number greater than 0 mm.');
      update();
      return;
    }
    if (rotationRaw === null) {
      announce('Apply blocked: Rotation must be a finite number of degrees.');
      update();
      return;
    }
    if (xMm === null || yMm === null) {
      announce('Apply blocked: Centre X/Y must be finite millimetre numbers.');
      update();
      return;
    }
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
    root.replaceChildren();
    const wrap = el('div', 'pw-root', 'pw-root');
    root.append(wrap);
    renderHeader(wrap);
    const layout = el('div', 'pw-layout');
    wrap.append(layout);
    const main = el('div', 'pw-main');
    const rail = el('aside', 'pw-rail', 'pw-rail');
    layout.append(main, rail);
    renderStage(main);
    renderRail(rail);
    restoreFocus(memory);
  }

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
    title.textContent = 'Set logo placements';
    wrap.append(title);
    const products = optionProducts(project);
    const headerRow = el('div', 'pw-row', 'pw-header');
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
      label.textContent = 'Measured placement diagram';
      headerRow.append(label);
      if (deps.onViewModel !== undefined) {
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
    if (needsHeader) wrap.append(headerRow);
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
    const { project, selection, product, configuration, placement, placementIndex } = currentContext();
    if (product === null || configuration === null) {
      const note = el('p', 'pw-muted', 'pw-stage-empty');
      note.textContent = 'Include at least one product to continue.';
      main.append(note);
      return;
    }
    const region = stageRegion();
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

    for (const [index, entry] of configuration.placements.entries()) {
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
      const dot = svgEl('circle', {
        cx: String(svgPt.x),
        cy: String(svgPt.y),
        r: String(Math.max(current.span / 200, 0.5)),
        fill: '#d20a2e',
        stroke: '#fff',
        'stroke-width': String(Math.max(current.span / 500, 0.2)),
      });
      const title = svgEl('title', {});
      title.textContent = anchor.name;
      dot.append(title);
      svg.append(dot);
    }

    if (placement !== null && region !== null) {
      const bindings = bindingsForPlacement(configuration.id, configuration.placements, placementIndex);
      const scopedAnchors = anchors;
      for (const binding of bindings) {
        const anchor = scopedAnchors.find((entry) => entry.id === binding.anchorId);
        if (anchor === undefined) continue;
        const footprint = rotatedFootprintCorners(
          placement.pos.xMm, placement.pos.yMm,
          placement.widthMm, placement.heightMm, placement.rotationDeg,
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
        svg.append(svgEl('line', {
          x1: String(start.x),
          y1: String(start.y),
          x2: String(end.x),
          y2: String(end.y),
          stroke: '#227443',
          'stroke-width': String(Math.max(current.span / 400, 0.3)),
        }));
      }
    }

    /* Pointer gestures: footprint drag moves (mm via caller mapping);
       empty-space drag pans; wheel zooms. View changes never touch mm. */
    let drag: { kind: 'move'; index: number; startMm: { xMm: number; yMm: number } } |
      { kind: 'pan'; startX: number; startY: number; origCx: number; origCy: number } | null = null;
    let moved = false;

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
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      const footprint = target?.closest?.('[data-placement-index]');
      const svgPt = toSvgPoint(event.clientX, event.clientY);
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
        };
        moved = false;
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
        svg.setPointerCapture?.(event.pointerId);
      }
    }, { signal: aborter.signal });

    svg.addEventListener('pointermove', (event) => {
      if (drag === null) return;
      const svgPt = toSvgPoint(event.clientX, event.clientY);
      if (svgPt === null) return;
      if (drag.kind === 'pan') {
        const ctm = svg.getScreenCTM();
        if (ctm === null) return;
        const dxSvg = (event.clientX - drag.startX) / ctm.a;
        const dySvg = (event.clientY - drag.startY) / ctm.d;
        if (!Number.isFinite(dxSvg) || !Number.isFinite(dySvg)) return;
        current.cx = drag.origCx - dxSvg;
        current.cy = drag.origCy - dySvg;
        moved = true;
        paintView();
      } else {
        const mm = mapping.fromSvg(svgPt);
        if (mm === null) return;
        const entry = configuration.placements[drag.index];
        if (entry === undefined) return;
        const nextMm = { xMm: mm.xMm + drag.startMm.xMm, yMm: mm.yMm + drag.startMm.yMm };
        if (!Number.isFinite(nextMm.xMm) || !Number.isFinite(nextMm.yMm)) return;
        if (Math.abs(nextMm.xMm - entry.pos.xMm) > 1e-9 ||
          Math.abs(nextMm.yMm - entry.pos.yMm) > 1e-9) {
          moved = true;
          paintDragGhost(drag.index, nextMm);
        }
      }
    }, { signal: aborter.signal });

    const finishDrag = (event: PointerEvent, commitDrag: boolean): void => {
      if (drag === null) return;
      const finished = drag;
      drag = null;
      clearGhost();
      if (finished.kind === 'pan') {
        if (moved) {
          viewCache.set(cacheKey, { cx: current.cx, cy: current.cy, span: current.span });
          viewOverride = { cx: current.cx, cy: current.cy, span: current.span };
        }
        return;
      }
      if (!moved) {
        const entry = configuration.placements[finished.index];
        const id = entry?.id ?? `index:${finished.index}`;
        deps.setSelection({ placementId: id });
        measureDraft = null;
        update();
        return;
      }
      if (!commitDrag) {
        update();
        return;
      }
      const svgPt = toSvgPoint(event.clientX, event.clientY);
      const mm = svgPt !== null ? mapping.fromSvg(svgPt) : null;
      if (mm === null) {
        update();
        return;
      }
      const entry = configuration.placements[finished.index];
      if (entry === undefined) {
        update();
        return;
      }
      const pos = {
        xMm: mm.xMm + finished.startMm.xMm,
        yMm: mm.yMm + finished.startMm.yMm,
      };
      let next: ProjectDocument;
      try {
        next = updatePlacementInConfig(
          deps.getProject(),
          configuration.id,
          placementSelector(entry, finished.index),
          { pos },
        );
      } catch (error) {
        announce(`Move blocked: ${error instanceof Error ? error.message : String(error)}`);
        update();
        return;
      }
      if (commitNext('Move logo', next)) {
        staged.delete(placementKeyOf(configuration.id, entry, finished.index));
        const id = entry.id ?? `index:${finished.index}`;
        deps.setSelection({ placementId: id });
        announce('Logo moved.');
        update();
      }
    };

    svg.addEventListener('pointerup', (event) => {
      finishDrag(event, true);
    }, { signal: aborter.signal });
    svg.addEventListener('pointercancel', () => {
      drag = null;
      clearGhost();
      update();
    }, { signal: aborter.signal });

    const paintView = (): void => {
      const halfView = current.span / 2;
      svg.setAttribute(
        'viewBox',
        `${current.cx - halfView * aspectFix} ${current.cy - halfView} ${current.span * aspectFix} ${current.span}`,
      );
    };

    let ghost: SVGElement | null = null;
    const paintDragGhost = (index: number, pos: { xMm: number; yMm: number }): void => {
      clearGhost();
      const entry = configuration.placements[index];
      if (entry === undefined) return;
      const corners = rotatedFootprintCorners(pos.xMm, pos.yMm, entry.widthMm, entry.heightMm, entry.rotationDeg);
      const mapped: StagePoint[] = [];
      for (const corner of corners) {
        const svgPt = mapping.toSvg(corner.x, corner.y);
        if (svgPt !== null) mapped.push(svgPt);
      }
      if (mapped.length < 3) return;
      ghost = svgEl('polygon', {
        points: mapped.map((point) => `${point.x},${point.y}`).join(' '),
        fill: 'rgba(210,10,46,0.18)',
        stroke: '#d20a2e',
        'stroke-width': String(current.span / 250),
      });
      svg.append(ghost);
    };
    const clearGhost = (): void => {
      ghost?.remove();
      ghost = null;
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
        if (measureDraft !== null && measureDraft.picking !== null) {
          measureDraft.picking = null;
          measureDraft.notice = 'Diagram pick cancelled; nothing changed.';
          update();
        }
        return;
      }
      const step = event.shiftKey ? 0.1 : 1;
      let dx = 0;
      let dy = 0;
      if (event.key === 'ArrowLeft') dx = -step;
      else if (event.key === 'ArrowRight') dx = step;
      else if (event.key === 'ArrowUp') dy = step;
      else if (event.key === 'ArrowDown') dy = -step;
      else return;
      event.preventDefault();
      let next: ProjectDocument;
      try {
        next = updatePlacementInConfig(
          deps.getProject(),
          configuration.id,
          placementSelector(placement, placementIndex),
          { pos: { xMm: placement.pos.xMm + dx, yMm: placement.pos.yMm + dy } },
        );
      } catch (error) {
        announce(`Nudge blocked: ${error instanceof Error ? error.message : String(error)}`);
        update();
        return;
      }
      if (commitNext('Nudge logo', next)) {
        staged.delete(placementKeyOf(configuration.id, placement, placementIndex));
        update();
      }
    }, { signal: aborter.signal });

    /* Measurement picker clicks reuse the stage mapping (mm identities only).
       Two-click flow: first click selects the anchor identity, second click
       selects the artwork edge. The measured value always comes from the
       visual-dimension kernel — pointer positions never enter millimetres. */
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

  function renderRail(rail: HTMLElement): void {
    const { project, selection, product, configuration, placement, placementIndex } = currentContext();
    if (product === null || configuration === null) return;

    const listTitle = el('h3', '', 'pw-placements-title');
    listTitle.textContent = 'Placements';
    rail.append(listTitle);

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
    addToggle.disabled = project.logos.length === 0;
    addToggle.addEventListener('click', () => {
      addOpen = true;
      addDraft = makeAddDraft(project, configuration);
      update();
    });
    rail.append(addToggle);

    if (addOpen) renderAddForm(rail, project, configuration);

    if (placement !== null && placementIndex >= 0) {
      renderSelectedFields(rail, project, configuration, placement, placementIndex);
    }

    renderValidation(rail, project, configuration);

    const actions = el('div', 'pw-actions', 'pw-step-actions');
    const approval = el('button', 'pw-secondary', 'pw-approval') as HTMLButtonElement;
    approval.type = 'button';
    approval.textContent = 'Send for customer approval';
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
  }

  function makeAddDraft(project: ProjectDocument, configuration: Configuration): AddDraft {
    const { selection } = currentContext();
    const product = project.products.find((entry) => entry.id === configuration.productId);
    const areas = product !== undefined ? configuredAreas(product, configuration.variantId) : [];
    const firstLogo = project.logos[0];
    const logoId = firstLogo?.id ?? '';
    const known = logoId !== '' ? knownDimensions(project, logoId) : null;
    const currentRegion = stageRegion();
    const regionId = (currentRegion !== null &&
      areas.some((area) => area.id === currentRegion.id))
      ? currentRegion.id
      : (areas[0]?.id ?? '');
    const area = areas.find((entry) => entry.id === regionId);
    void selection;
    return {
      logoId,
      regionId,
      widthRaw: known !== null ? String(known.widthMm) : '',
      heightRaw: known !== null ? String(known.heightMm) : '',
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
        'No selected artwork: tick a logo in Step 1 (Prepare the job) to place new artwork. Existing placements stay visible below.';
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
        const methodLabel = el('label', 'pw-field', 'pw-add-method-field');
        methodLabel.textContent = 'Method';
        const methodSelect = el('select', '', 'pw-add-method') as HTMLSelectElement;
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Choose a method';
        methodSelect.append(blank);
        for (const method of area.allowedMethods) {
          const option = document.createElement('option');
          option.value = method;
          option.textContent = method;
          methodSelect.append(option);
        }
        methodSelect.value = draft.method;
        methodSelect.addEventListener('change', () => {
          draft.method = methodSelect.value;
        });
        methodLabel.append(methodSelect);
        form.append(methodLabel);
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

    const group = el('div', '', 'pw-selected');
    const heading = el('h3', '', 'pw-selected-title');
    heading.textContent = 'Selected placement';
    group.append(heading);

    const logoLine = el('p', '', 'pw-field-logo');
    const logoStrong = el('strong', '');
    logoStrong.textContent = logoNameOf(project, edit.logoId);
    logoLine.append(logoStrong);
    group.append(logoLine);

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
      if (edit.keepProportions) {
        const aspect = logoPixelAspect(project, edit.logoId);
        const widthMm = parseMm(edit.widthRaw);
        if (aspect !== null && widthMm !== null && widthMm > 0) {
          edit.heightRaw = String(Math.round((widthMm / aspect) * 100) / 100);
        }
      }
      update();
    });
    widthLabel.append(widthInput);
    group.append(widthLabel);

    const heightLabel = el('label', 'pw-field', 'pw-field-height');
    heightLabel.textContent = 'Height (mm)';
    const heightInput = el('input', '', 'pw-height') as HTMLInputElement;
    heightInput.type = 'number';
    heightInput.min = '0';
    heightInput.step = 'any';
    heightInput.value = edit.heightRaw;
    heightInput.addEventListener('input', () => {
      edit.heightRaw = heightInput.value;
      update();
    });
    heightLabel.append(heightInput);
    group.append(heightLabel);

    const keep = el('label', 'pw-check', 'pw-field-keep');
    const keepBox = el('input', '', 'pw-keep') as HTMLInputElement;
    keepBox.type = 'checkbox';
    keepBox.checked = edit.keepProportions;
    keepBox.addEventListener('change', () => {
      edit.keepProportions = keepBox.checked;
      update();
    });
    keep.append(keepBox, document.createTextNode('Keep proportions'));
    group.append(keep);

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

    renderMeasurements(group, project, configuration, placement, placementIndex);

    const editRow = el('div', 'pw-inline', 'pw-edit-actions');
    const duplicate = el('button', 'pw-secondary', 'pw-duplicate') as HTMLButtonElement;
    duplicate.type = 'button';
    duplicate.textContent = 'Duplicate placement';
    duplicate.addEventListener('click', () => {
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
      apply.addEventListener('click', () => {
        applyStaged(configuration, placement, placementIndex, edit);
      });
      applyRow.append(apply);
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
    const convention = el('p', 'pw-muted', 'pw-frame-convention');
    convention.textContent = region !== undefined
      ? `Centre is the artwork bbox centre in the region frame (mm). ` +
      `Origin: ${region.frame.originDescription}; +x ${region.frame.axes.xPositive}; ` +
      `+y ${region.frame.axes.yPositive}. Rotation is clockwise degrees facing the region.`
      : 'Centre is the artwork bbox centre in the region frame (mm).';
    precise.append(convention);
    group.append(precise);

    const methodRegion = product.regions.find((entry) => entry.id === edit.regionId);
    if (methodRegion !== undefined && methodRegion.allowedMethods.length > 1) {
      const methodLabel = el('label', 'pw-field', 'pw-field-method');
      methodLabel.textContent = 'Method';
      const methodSelect = el('select', '', 'pw-method') as HTMLSelectElement;
      for (const method of methodRegion.allowedMethods) {
        const option = document.createElement('option');
        option.value = method;
        option.textContent = method;
        methodSelect.append(option);
      }
      if (edit.method !== '' && !methodRegion.allowedMethods.includes(edit.method)) {
        const option = document.createElement('option');
        option.value = edit.method;
        option.textContent = `${edit.method} (not offered here)`;
        methodSelect.append(option);
      }
      methodSelect.value = edit.method;
      methodSelect.addEventListener('change', () => {
        edit.method = methodSelect.value;
        update();
      });
      methodLabel.append(methodSelect);
      group.append(methodLabel);
    }

    const details = el('details', '', 'pw-production-details') as HTMLDetailsElement;
    const detailsSummary = el('summary', '');
    detailsSummary.textContent = 'Production details';
    details.append(detailsSummary);
    const methodLine = el('p', 'pw-muted', 'pw-method-readout');
    methodLine.textContent = `Method: ${edit.method || '(choose a method above)'}`;
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

  update();

  return {
    hasPendingEdits,
    pendingEdits: collectPendingEdits,
    applyPendingEdits,
    discardPendingEdits,
    update,
    destroy() {
      destroyed = true;
      aborter.abort();
      styleNode.remove();
      root.replaceChildren();
    },
  };
}
