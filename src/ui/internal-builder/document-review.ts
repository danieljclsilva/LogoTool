/**
 * Step 3 "Review operational document" UI module (operator workflow, §6).
 *
 * DOM-injectable, deterministic and offline file:// safe. Renders into a
 * lead-provided host element; the lead wires it into the three-step shell
 * (containers + step navigation) and supplies every external dependency
 * through {@link DocumentReviewDeps}. No global hooks, no network, no
 * storage, no duplicate geometry/validation engine.
 *
 * Contract summary (UX spec §6):
 * - The main column ALWAYS renders the actual shared operation-sheet
 *   renderer (`renderOperationSheet`) for the current canonical revision
 *   (artwork + named view refs). No approximate preview, no preview toggle,
 *   no Send prerequisite. The preview refreshes after committed changes
 *   without stealing focus or discarding dirty rail forms.
 * - Rail order: job summary, Items to check, Operational instructions,
 *   optional Technique settings, primary Print/save PDF, secondary Save job,
 *   Back to placements.
 * - Operational instructions are staff-authored and shared with the output;
 *   customer notes stay read-only context and are never merged into
 *   operational instructions. Instruction edits refresh the preview on
 *   blur/debounce, update dirty state (via deps), and persist on Save job;
 *   there is no extra mandatory save button per field, and focused inputs
 *   are never repainted.
 * - Items to check lists only actual unresolved items, each with a Fix link
 *   selecting the affected product/option/placement or Step 1 identity
 *   field. Blocking: missing customer/job reference; no included products;
 *   malformed project/asset; placement without valid calibration/current
 *   area; invalid footprint; missing physical dimensions/method; unapplied
 *   geometry edits. Existing operation-sheet missing-code/missing-binding
 *   signals (the `unfinished` reasons from `measurePlacement`) surface as
 *   actionable incomplete items. Print/save PDF is disabled for
 *   blocking/incomplete items with a reason pointing to the first Fix; a
 *   secondary Print draft is available for structurally valid but incomplete
 *   jobs and uses the SAME renderer (whose Draft/pending markings and
 *   reasons apply automatically). Never an unmarked production-ready output.
 *   A configured zero-placement option prints its explicit no-placement
 *   statement (renderer-owned). Physical-unverified status stays visible as
 *   a persistent rail line even when all checks pass.
 * - A placement summary click is NOT hijacked (the renderer owns printed
 *   content); instead an adjacent accessible `Edit [logo]` action per logo
 *   card returns to Step 2 with the exact product/option/placement selected.
 *   Print CSS exclusions (nav/actions/inputs) are the lead's template
 *   responsibility — see the wiring notes on `DocumentReviewDeps`.
 * - `More output options` (collapsed) holds Save operator data / diagnostic
 *   export, generated from the SAME snapshot as the preview (the exact
 *   rendered `OperationSheetView`/candidate, never a stale lastReturn).
 */

import {
  canonicalize,
  serializeExport,
  validateProject,
} from '../../core/index.js';
import type {
  ExportConfiguration,
  ExportPlacement,
  ProjectDocument,
  ResultCandidate,
  ValidationError,
} from '../../core/index.js';
import {
  buildOperationSheetView,
  displayScopeTitle,
  matchLogoRef,
} from '../../core/operation-document/index.js';
import type {
  BuildOperationSheetViewInput,
  OperationSheetJob,
  OperationSheetView,
  ReferenceViewInput,
} from '../../core/operation-document/types.js';
import type { ModelViewInput } from '../../core/operation-document/types.js';
import type { SheetLogoExtras } from '../../core/operation-document/types.js';
import {
  measurePlacement,
} from '../../core/operation-measurements/index.js';
import type {
  AnchorDef,
  DimensionBinding,
} from '../../core/operation-measurements/types.js';
import { evaluateProjectGeometry } from '../../core/project-editor/index.js';
import { MAX_PREVIEW_BYTES, readRasterHeader } from '../../assets/raster-header.js';

/** True when bytes parse as SVG/XML text: a valid vector original whose
 * raster preview is unavailable (never a corrupt raster). Pure, no DOM. */
function looksLikeVectorOriginal(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > 65536) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 1024));
  } catch {
    return false;
  }
  const trimmed = text.replace(/^[\uFEFF\s]*/, '').replace(/<!--[\s\S]*?-->/g, '').trimStart();
  return trimmed.startsWith('<svg') || trimmed.startsWith('<?xml');
}
import {
  artworkPreviewReason,
  evaluateOperationPhotoStates,
  operationSheetPageCount,
  operationSheetStyles,
  operationSheetSummary,
  referencePreviewReason,
  renderOperationSheet,
} from '../shared/operation-document/index.js';
import type {
  OperationSheetAssetLookup,
  SheetOverlayArtwork,
  SheetOverlayMapping,
} from '../shared/operation-document/assets.js';
import type { PhotoMappingState } from '../../core/operation-document/types.js';
import type {
  ModelDocumentView,
} from '../../core/presentation-views/model-document-views.js';
import { isModelViewRenderStale } from '../../core/presentation-views/model-document-views.js';

/** Severity of one review item. `info` never gates printing. */
export type ReviewSeverity = 'blocking' | 'incomplete' | 'info';

/** Navigation target for a Fix link. The lead maps each kind to the exact
 * product/option/placement selection or Step 1 identity field. */
export type ReviewFixTarget =
  | { kind: 'identity'; field: 'customer' | 'reference' }
  | { kind: 'products' }
  | { kind: 'option'; productId: string; variantId: string }
  | {
    kind: 'placement';
    productId: string;
    variantId: string;
    configId: string;
    placementIndex: number;
    placementId?: string;
  };

/** One unresolved review item (or informational row). */
export interface ReviewItem {
  id: string;
  severity: ReviewSeverity;
  message: string;
  detail?: string;
  fix?: ReviewFixTarget;
}

/** Pending (unapplied) Step 2 geometry edit, supplied by the lead. */
export interface ReviewUnappliedEdit {
  label: string;
  target: ReviewFixTarget;
}

/** Department-authored technique settings for the currently reviewed scope. */
export interface ReviewTechniqueSettings {
  temperature: string;
  time: string;
  pressure: string;
  colour: string;
  thread: string;
}

/**
 * One operator-managed model document view with its captured render state
 * for the current review snapshot. `render` is the clean product capture
 * (no handles/overlays) with applied artwork from `render.revision`; a null
 * render means "not captured yet" and prints an explicit pending note.
 * Stale renders (revision moved on, camera changed) are never served to the
 * renderer — see `buildReviewSheetLookup`.
 */
export interface DocumentReviewModelView {
  view: ModelDocumentView;
  render: {
    dataUrl: string;
    width: number;
    height: number;
    revision: number;
    /** Camera digest the render was captured with (see `cameraDigest`). */
    cameraKey?: string;
  } | null;
  status: "ready" | "pending" | "failed";
  note?: string;
}

/**
 * Canonical input for one review render. The lead builds this from the
 * current operator job: `candidate` MUST be the `buildCandidateExport` of
 * `project` (same revision/digest), or null with `candidateError` when the
 * export was rejected. Asset bytes cover every referenced package path.
 * `unapplied` carries pending Step 2 geometry edits the lead tracks.
 * `modelViews` carries the operator-managed GLB views per configuration
 * (key: configuration id); absent means "no model views supplied yet" and
 * photo sides keep working as before.
 */
export interface DocumentReviewSnapshot {
  project: ProjectDocument;
  candidate: ResultCandidate | null;
  candidateError: string | null;
  assetBytes: ReadonlyMap<string, Uint8Array>;
  referenceViews: Record<string, readonly ReferenceViewInput[]>;
  anchors: readonly AnchorDef[];
  bindings: Record<string, readonly DimensionBinding[]>;
  extras: Record<string, Record<string, SheetLogoExtras>>;
  job: OperationSheetJob;
  instructionsText: string;
  technique: ReviewTechniqueSettings;
  techniqueScopeLabel: string | null;
  unapplied: readonly ReviewUnappliedEdit[];
  brandMarkDataUrl?: string;
  modelViews?: Record<string, readonly DocumentReviewModelView[]>;
}

/**
 * Lead-owned dependencies. The lead MUST route print exclusion CSS so that
 * rail/actions/inputs and `.doc-review-edit` buttons never print (print CSS
 * lives in the lead-owned template), and MUST call `handle.update()` after
 * every committed change (instructions commit, technique change, Save job,
 * placement apply, navigation into this step).
 */
export interface DocumentReviewDeps {
  /** Current snapshot, or null when no job is open (empty state). */
  readSnapshot(): DocumentReviewSnapshot | null;
  /** Browser print dialog (normally `() => window.print()`). */
  requestPrint(): void;
  /** Persist the job (download); instructions persist through this. */
  saveJob(): void | Promise<void>;
  /** Download the operator JSON built from the exact rendered view. */
  saveOperatorData(view: OperationSheetView): void;
  /** Download the diagnostic candidate JSON (exact preview snapshot). */
  saveDiagnosticData(text: string, suggestedFileName: string): void;
  /** Return to Step 2 (placements), preserving state. */
  goBackToPlacements(): void;
  /** Select the affected product/option/placement or Step 1 identity field. */
  fixItem(target: ReviewFixTarget): void;
  /** Commit instruction text (updates dirty state; lead re-renders via update). */
  commitInstructions(text: string): void;
  /** Commit one technique field (updates dirty state; lead re-renders). */
  commitTechnique(patch: Partial<ReviewTechniqueSettings>): void;
  /**
   * Optional operator model-view management (GLB-backed products). Absent
   * means the host build does not supply viewer capture yet: the review
   * shows the managed views read-only. All callbacks operate on one
   * configuration's view list; the lead re-renders via `handle.update()`
   * after each change, which re-captures through the viewer coordinator
   * (stale async captures are dropped by token, never painted).
   */
  modelViewOps?: {
    /** Add a view for the option, framed from the current viewer camera. */
    add(configId: string): void;
    /** Re-frame an existing view from the current viewer camera. */
    reframe(configId: string, viewId: string): void;
    /** Remove a view (renders for it are dropped, never printed). */
    remove(configId: string, viewId: string): void;
    /** Move a view within its configuration (`-1` up, `1` down). */
    move(configId: string, viewId: string, direction: -1 | 1): void;
    /** Retry a failed or pending capture for one view. */
    retry(configId: string, viewId: string): void;
  };
}

export interface DocumentReviewHandle {
  /** Re-read the snapshot and refresh preview, items and summary. Never
   * steals focus; never repaints a focused rail input. */
  update(): void;
  /** Remove listeners and timers; empty the host. */
  destroy(): void;
}

export interface ReviewComputation {
  items: ReviewItem[];
  structurallyValid: boolean;
  completeEnabled: boolean;
  draftEnabled: boolean;
  firstFix: ReviewFixTarget | null;
  productCount: number;
  optionCount: number;
  placementCount: number;
}

/** Display-only 1-decimal millimetres (matches the station's existing copy). */
function displayMm(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return (Math.round(value * 10) / 10).toFixed(1);
}

function logoLabel(project: ProjectDocument, logoId: string): string {
  return project.logos.find((entry) => entry.id === logoId)?.name?.trim() || logoId;
}

function regionLabel(project: ProjectDocument, productId: string, regionId: string): string {
  const product = project.products.find((entry) => entry.id === productId);
  return product?.regions.find((entry) => entry.id === regionId)?.name?.trim() || regionId;
}

function placementTarget(
  config: ExportConfiguration,
  placementIndex: number,
  placement: ExportPlacement | undefined,
): ReviewFixTarget {
  const target: ReviewFixTarget = {
    kind: 'placement',
    productId: config.productId,
    variantId: config.variantId,
    configId: config.id,
    placementIndex,
  };
  if (placement?.id !== undefined) target.placementId = placement.id;
  return target;
}

/**
 * Map one structural validator error to a human item with a Fix target.
 * Indices in validator paths (`configurations[i].placements[j]`) resolve
 * against the CURRENT project; anything unresolvable falls back to the
 * product-selection scope rather than guessing.
 */
function itemForValidationError(
  project: ProjectDocument,
  error: ValidationError,
  index: number,
): ReviewItem {
  const where = error.path || 'project';
  const configMatch = /configurations\[(\d+)\]/.exec(where);
  const placementMatch = /placements\[(\d+)\]/.exec(where);
  let fix: ReviewFixTarget = { kind: 'products' };
  let prefix = 'Job';
  if (configMatch !== null) {
    const config = project.configurations[Number(configMatch[1])];
    if (config !== undefined) {
      prefix = displayScopeTitle(project.products.find((entry) => entry.id === config.productId), config.productId, config.variantId);
      if (placementMatch !== null) {
        const placementIndex = Number(placementMatch[1]);
        const placement = config.placements[placementIndex];
        const logo = placement !== undefined ? ` — ${logoLabel(project, placement.logoId)}` : '';
        prefix += `${logo} (placement ${placementIndex + 1})`;
        fix = placementTarget(
          { id: config.id, productId: config.productId, variantId: config.variantId } as ExportConfiguration,
          placementIndex,
          undefined,
        );
      } else {
        fix = { kind: 'option', productId: config.productId, variantId: config.variantId };
      }
    }
  }
  return {
    id: `structural-${index}`,
    severity: 'blocking',
    message: `${prefix}: ${error.message}`,
    detail: `${error.code}@${error.path}`,
    fix,
  };
}

/**
 * Compute the review items for one snapshot. Pure; no DOM. Reuses the
 * existing validators and geometry (`validateProject`,
 * `evaluateProjectGeometry`, `measurePlacement` unfinished signals,
 * `artworkPreviewReason`/`referencePreviewReason` asset signals) and invents
 * no production rules.
 */
export function computeReviewItems(snapshot: DocumentReviewSnapshot): ReviewComputation {
  const { project, candidate } = snapshot;
  const items: ReviewItem[] = [];
  const structural = validateProject(project);
  const structurallyValid = structural.ok && candidate !== null;

  const customer = snapshot.job.customer?.trim() ?? '';
  const reference = snapshot.job.reference?.trim() ?? '';
  if (customer === '') {
    items.push({
      id: 'identity-customer',
      severity: 'blocking',
      message: 'Customer is missing. Enter the customer name before printing.',
      fix: { kind: 'identity', field: 'customer' },
    });
  }
  if (reference === '') {
    items.push({
      id: 'identity-reference',
      severity: 'blocking',
      message: 'Job reference is missing. Enter the job reference before printing.',
      fix: { kind: 'identity', field: 'reference' },
    });
  }

  const configurations = candidate?.configurations ?? project.configurations.map((entry) => ({
    id: entry.id,
    productId: entry.productId,
    variantId: entry.variantId,
    productName: undefined,
    variantName: undefined,
    placements: entry.placements.map((placement) => ({
      configurationId: entry.id,
      productId: entry.productId,
      variantId: entry.variantId,
      logoId: placement.logoId,
      regionId: placement.regionId,
      method: placement.method,
      pos: { ...placement.pos },
      widthMm: placement.widthMm,
      heightMm: placement.heightMm,
      rotationDeg: placement.rotationDeg,
      frame: {
        frameId: '',
        originDescription: '',
        axes: { xPositive: '', yPositive: '' },
        unit: 'mm' as const,
        referencePoint: 'artwork-bbox-center' as const,
        rotationConvention: 'clockwise-deg-facing-region' as const,
      },
      calibration: { calibrationId: '', version: '' },
      artwork: { logoId: placement.logoId, assets: [] },
    })),
  }));
  const productIds = new Set(configurations.map((entry) => entry.productId));
  const placementCount = configurations.reduce((total, entry) => total + entry.placements.length, 0);

  if (configurations.length === 0) {
    items.push({
      id: 'no-products',
      severity: 'blocking',
      message: 'No included products. Include at least one product to continue.',
      fix: { kind: 'products' },
    });
  }

  if (!structural.ok) {
    structural.errors.forEach((error, index) => {
      items.push(itemForValidationError(project, error, index));
    });
  }
  if (candidate === null && snapshot.candidateError !== null) {
    items.push({
      id: 'candidate-build',
      severity: 'blocking',
      message: `The operational document cannot be built: ${snapshot.candidateError}`,
      fix: { kind: 'products' },
    });
  }

  if (candidate !== null) {
    for (const [configIndex, config] of candidate.configurations.entries()) {
      const scope = displayScopeTitle(project.products.find((entry) => entry.id === config.productId), config.productId, config.variantId);
      if (config.placements.length === 0) {
        items.push({
          id: `zero-${config.id}`,
          severity: 'info',
          message: `${scope}: No logo placements for this option.`,
        });
      }
      for (const [placementIndex, placement] of config.placements.entries()) {
        void configIndex;
        const target = placementTarget(config, placementIndex, placement);
        const logo = logoLabel(project, placement.logoId);
        // Missing physical dimensions / method are surfaced here with a Fix
        // link even though the structural validator also reports them: the
        // item carries the actionable target the raw error lacks.
        if (!Number.isFinite(placement.widthMm) || !(placement.widthMm > 0) ||
          !Number.isFinite(placement.heightMm) || !(placement.heightMm > 0)) {
          items.push({
            id: `dims-${config.id}-${placementIndex}`,
            severity: 'blocking',
            message: `${scope} — ${logo}: missing physical dimensions. Enter a width and height in millimetres.`,
            fix: target,
          });
        }
        if (placement.method.trim() === '') {
          items.push({
            id: `method-${config.id}-${placementIndex}`,
            severity: 'blocking',
            message: `${scope} — ${logo}: missing production method. Choose the method for ${regionLabel(project, placement.productId, placement.regionId)}.`,
            fix: target,
          });
        }
        // Artwork asset bytes: missing/empty originals block; undecodable
        // bytes block; a valid vector original (SVG/XML text) cannot raster
        // preview but stays preserved and measurable, so it is incomplete
        // rather than blocking. An over-limit original is NOT listed (bytes
        // stay preserved, preview only — never an actionable unresolved item).
        const seenUris = new Set<string>();
        for (const asset of placement.artwork.assets) {
          if (seenUris.has(asset.uri)) continue;
          seenUris.add(asset.uri);
          const bytes = snapshot.assetBytes.get(asset.uri);
          if (bytes === undefined || bytes.length === 0) {
            items.push({
              id: `asset-${config.id}-${placementIndex}-${asset.uri}`,
              severity: 'blocking',
              message: artworkPreviewReason('missing', asset.uri),
              fix: target,
            });
          } else if (bytes.length <= MAX_PREVIEW_BYTES && readRasterHeader(bytes) === null) {
            if (looksLikeVectorOriginal(bytes)) {
              items.push({
                id: `asset-${config.id}-${placementIndex}-${asset.uri}`,
                severity: 'incomplete',
                message: artworkPreviewReason('unsupported', asset.uri),
                fix: target,
              });
            } else {
              items.push({
                id: `asset-${config.id}-${placementIndex}-${asset.uri}`,
                severity: 'blocking',
                message: artworkPreviewReason('corrupt', asset.uri),
                fix: target,
              });
            }
          }
        }
        // Operation-sheet missing-binding signals: explicit unfinished
        // reasons from the same pure measurement the renderer prints.
        const relevant = (snapshot.bindings[config.id] ?? []).filter((binding) =>
          matchLogoRef(config.placements, binding.logoRef) === placement,
        );
        const measured = measurePlacement(candidate, placement, snapshot.anchors, relevant);
        if (measured.unfinished.length > 0) {
          items.push({
            id: `bindings-${config.id}-${placementIndex}`,
            severity: 'incomplete',
            message: `${scope} — ${logo}: ${measured.unfinished.join('; ')}`,
            fix: target,
          });
        }
      }
      // Reference-view bytes: missing originals block (data loss); a
      // header-invalid photo degrades only the illustration, so it is
      // incomplete; the measured diagram stays the source of truth.
      for (const view of snapshot.referenceViews[config.id] ?? []) {
        const bytes = snapshot.assetBytes.get(view.imagePath);
        if (bytes === undefined || bytes.length === 0) {
          items.push({
            id: `ref-${config.id}-${view.imagePath}`,
            severity: 'blocking',
            message: artworkPreviewReason('missing', view.imagePath),
            fix: { kind: 'option', productId: config.productId, variantId: config.variantId },
          });
        } else if (readRasterHeader(bytes) === null) {
          items.push({
            id: `ref-${config.id}-${view.imagePath}`,
            severity: 'incomplete',
            message: referencePreviewReason(view.imagePath),
            fix: { kind: 'option', productId: config.productId, variantId: config.variantId },
          });
        }
      }
    }
    // Invalid footprints: exact domain reasons, never invented causes.
    // Failed model-view captures are incomplete (never blocking): the sheet
    // still prints its pending note plus the measured panels, and Print
    // draft stays available. Pending captures are NOT listed — the preview
    // placeholder already says so, and no warning wall is wanted.
    for (const [configId, entries] of Object.entries(snapshot.modelViews ?? {})) {
      const config = candidate.configurations.find((item) => item.id === configId);
      if (config === undefined) continue;
      const scope = displayScopeTitle(
        project.products.find((entry) => entry.id === config.productId),
        config.productId,
        config.variantId,
      );
      for (const entry of entries) {
        if (entry.status !== 'failed') continue;
        const name = entry.view.label?.trim() || entry.view.id;
        items.push({
          id: `model-render-${configId}-${entry.view.id}`,
          severity: 'incomplete',
          message: `${scope} — model view “${name}” render failed. Retry the capture before printing.`,
          fix: { kind: 'option', productId: config.productId, variantId: config.variantId },
        });
      }
    }
    try {
      const verdict = evaluateProjectGeometry(project);
      for (const entry of verdict.placements) {
        if (entry.ok) continue;
        const config = candidate.configurations.find((item) => item.id === entry.configurationId);
        const placement = config?.placements[entry.placementIndex];
        const scope = config !== undefined
          ? displayScopeTitle(project.products.find((entry) => entry.id === config.productId), config.productId, config.variantId)
          : entry.configurationId;
        const logo = placement !== undefined ? ` — ${logoLabel(project, placement.logoId)}` : '';
        items.push({
          id: `geometry-${entry.configurationId}-${entry.placementIndex}`,
          severity: 'blocking',
          message: `${scope}${logo}: ${entry.reason}`,
          fix: config !== undefined
            ? placementTarget(config, entry.placementIndex, placement)
            : { kind: 'products' },
        });
      }
    } catch (error) {
      items.push({
        id: 'geometry-eval',
        severity: 'blocking',
        message: `Geometry cannot be evaluated: ${error instanceof Error ? error.message : String(error)}`,
        fix: { kind: 'products' },
      });
    }
  }

  for (const [index, pending] of snapshot.unapplied.entries()) {
    items.push({
      id: `unapplied-${index}`,
      severity: 'blocking',
      message: pending.label,
      detail: 'Unapplied edits never leak into print, customer files or Save job without an explicit Apply.',
      fix: pending.target,
    });
  }

  const blocking = items.filter((item) => item.severity === 'blocking');
  const incomplete = items.filter((item) => item.severity === 'incomplete');
  return {
    items,
    structurallyValid,
    completeEnabled: structurallyValid && blocking.length === 0 && incomplete.length === 0,
    // Print draft is for structurally valid but incomplete jobs only: the
    // same renderer carries the Draft/pending markings and reasons.
    draftEnabled: structurallyValid && blocking.length === 0 && incomplete.length > 0,
    firstFix: blocking.length > 0
      ? (blocking[0]?.fix ?? null)
      : (incomplete.length > 0 ? (incomplete[0]?.fix ?? null) : null),
    productCount: productIds.size,
    optionCount: configurations.length,
    placementCount,
  };
}

/**
 * Build the operation-sheet view for the exact snapshot the preview shows.
 * Shared by the preview and both output exports (same snapshot, never stale).
 * Operator-managed model views (when supplied) ride alongside photo sides in
 * operator display order; a missing render prints an explicit pending note.
 */
export function buildReviewSheetView(snapshot: DocumentReviewSnapshot): OperationSheetView | null {
  if (snapshot.candidate === null) return null;
  const lines = snapshot.instructionsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const input: BuildOperationSheetViewInput = {
    candidate: snapshot.candidate,
    anchors: snapshot.anchors,
    bindings: snapshot.bindings,
    job: snapshot.job,
    sides: snapshot.referenceViews,
    extras: snapshot.extras,
    operationalInstructions: lines,
  };
  const modelViews = toModelViewInputs(snapshot.modelViews);
  if (modelViews !== undefined) input.modelViews = modelViews;
  return buildOperationSheetView(input);
}

/**
 * Map snapshot model-view state to sheet inputs. Pure; preserves operator
 * display order (reorder is meaningful — never re-sorted).
 */
function toModelViewInputs(
  source: Record<string, readonly DocumentReviewModelView[]> | undefined,
): Record<string, readonly ModelViewInput[]> | undefined {
  if (source === undefined) return undefined;
  const out: Record<string, readonly ModelViewInput[]> = Object.create(null);
  for (const [configId, entries] of Object.entries(source)) {
    out[configId] = entries.map((entry) => ({
      view: entry.view.id,
      imagePath: `model-view/${encodeURIComponent(configId)}/${entry.view.id}.png`,
      ...(entry.view.label !== undefined ? { label: entry.view.label } : {}),
      modelAssetId: entry.view.modelAssetId,
      modelRevision: entry.view.modelRevision,
      regions: [...entry.view.associatedRegions],
    }));
  }
  return out;
}

/**
 * Asset lookup for the one-sheet renderer with caller-evaluated photo
 * overlays, index-aligned to the view (mappings per side, artwork geometry
 * per logo with measured arrows). Absent entries read as unmapped with
 * explicit notes — nothing is guessed.
 */
export function buildReviewSheetLookup(
  snapshot: DocumentReviewSnapshot,
): OperationSheetAssetLookup | null {
  if (snapshot.candidate === null) return null;
  const candidate = snapshot.candidate;
  const revision = candidate.revision;
  const states = evaluateOperationPhotoStates(candidate, new Map(snapshot.assetBytes));
  // Revision-bound model renders by synthetic cache key: only renders
  // captured from THIS revision (and, when the capturer recorded one, from
  // the view's current camera) are served. Anything stale — revision moved
  // on after a placement/method change, camera reframed, asset swapped —
  // reads as "not rendered yet" instead of printing a stale capture.
  const renders = new Map<string, { dataUrl: string; width: number; height: number; revision: number }>();
  for (const [configId, entries] of Object.entries(snapshot.modelViews ?? {})) {
    for (const entry of entries) {
      const render = entry.render;
      if (render === null) continue;
      if (render.revision !== revision) continue;
      if (render.cameraKey !== undefined
        && isModelViewRenderStale(
          { revision: render.revision, cameraKey: render.cameraKey, modelRevision: entry.view.modelRevision },
          entry.view,
          revision,
        )) {
        continue;
      }
      renders.set(`model-view/${encodeURIComponent(configId)}/${entry.view.id}.png`, {
        dataUrl: render.dataUrl,
        width: render.width,
        height: render.height,
        revision: render.revision,
      });
    }
  }
  const artworkUri = (assets: ReadonlyArray<{ uri: string }>): string | undefined => {
    if (assets.length === 0) return undefined;
    return assets.find((asset) => /\.(png|jpe?g|webp)$/i.test(asset.uri))?.uri ?? assets[0]?.uri;
  };
  return {
    getBytes: (path) => snapshot.assetBytes.get(path),
    getModelViewImage: (path) => renders.get(path),
    getSheetOverlay: (sheetIndex) => {
      const config = candidate.configurations[sheetIndex];
      if (!config) return undefined;
      const configStates: readonly PhotoMappingState[] = states[config.id] ?? [];
      const sides = snapshot.referenceViews[config.id] ?? [];
      const mappings: Array<SheetOverlayMapping | undefined> = sides.map((side) => {
        const bound = configStates.find((entry) => entry.imagePath === side.imagePath);
        if (
          !bound || bound.regionId === undefined || bound.view === undefined ||
          bound.transform === undefined
        ) {
          return undefined;
        }
        return {
          regionId: bound.regionId,
          view: bound.view,
          transform: { ...bound.transform },
          status: bound.status,
        };
      });
      const configBindings = snapshot.bindings[config.id] ?? [];
      const artworks: Array<SheetOverlayArtwork | undefined> = config.placements.map((placement) => {
        const relevant = configBindings.filter((binding) =>
          matchLogoRef(config.placements, binding.logoRef) === placement,
        );
        const measured = measurePlacement(candidate, placement, snapshot.anchors, relevant);
        const arrows = measured.dimensions.map((dimension) => ({
          p0: { x: dimension.endpoints[0]?.x ?? NaN, y: dimension.endpoints[0]?.y ?? NaN },
          p1: { x: dimension.endpoints[1]?.x ?? NaN, y: dimension.endpoints[1]?.y ?? NaN },
          ...(dimension.artworkPoint !== undefined
            ? { artworkPoint: { x: dimension.artworkPoint.x, y: dimension.artworkPoint.y } }
            : {}),
        }));
        const uri = artworkUri(placement.artwork.assets);
        return {
          regionId: placement.regionId,
          ...(uri !== undefined ? { imagePath: uri } : {}),
          xMm: placement.pos.xMm,
          yMm: placement.pos.yMm,
          widthMm: placement.widthMm,
          heightMm: placement.heightMm,
          rotationDeg: placement.rotationDeg,
          arrows,
        };
      });
      return { mappings, artworks };
    },
  };
}

/** Read-only customer context for the rail (never merged into instructions). */
export function reviewCustomerNotes(snapshot: DocumentReviewSnapshot): { placement: string[]; project?: string } {
  if (snapshot.candidate === null) return { placement: [] };
  const placement: string[] = [];
  for (const config of snapshot.candidate.configurations) {
    for (const item of config.placements) {
      if (item.instructions !== undefined) placement.push(item.instructions);
    }
  }
  const out: { placement: string[]; project?: string } = { placement };
  if (snapshot.candidate.instructions !== undefined) out.project = snapshot.candidate.instructions;
  return out;
}

const STYLE_ELEMENT_ID = 'document-review-operation-styles';

function ensureReviewStyles(): void {
  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    document.head.append(style);
  }
  style.textContent = operationSheetStyles();
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function focusedWithin(root: HTMLElement): boolean {
  const active = document.activeElement;
  return active !== null && active !== document.body && root.contains(active);
}

export function mountDocumentReview(host: HTMLElement, deps: DocumentReviewDeps): DocumentReviewHandle {
  const aborter = new AbortController();
  const signal = aborter.signal;
  let destroyed = false;
  let lastRenderedViewText: string | null = null;
  let instructionsTimer: ReturnType<typeof setTimeout> | null = null;

  host.replaceChildren();
  host.setAttribute('data-doc-review', '');

  const heading = el('h2', 'doc-review-title', 'Review operational document');
  const rail = el('div');
  rail.setAttribute('data-doc-review-rail', '');
  const main = el('div');
  main.setAttribute('data-doc-review-main', '');
  const previewHost = el('div', 'doc-review-preview');
  previewHost.setAttribute('data-doc-review-preview', '');
  previewHost.setAttribute('role', 'region');
  previewHost.setAttribute('aria-label', 'Operational document preview');
  main.append(previewHost);

  const summaryBox = el('section');
  summaryBox.setAttribute('aria-label', 'Job summary');
  const summaryTitle = el('h3', undefined, 'Job summary');
  const summaryLines = el('div', 'muted');
  summaryBox.append(summaryTitle, summaryLines);

  const itemsBox = el('section');
  itemsBox.setAttribute('aria-label', 'Items to check');
  const itemsTitle = el('h3', undefined, 'Items to check');
  const itemsList = el('div');
  itemsBox.append(itemsTitle, itemsList);

  // Operator-managed GLB document views: add / reframe / reorder / remove /
  // retry capture per configuration. Presentation-only metadata — camera
  // moves here never touch production geometry.
  const modelBox = el('section');
  modelBox.setAttribute('aria-label', 'Model views');
  const modelTitle = el('h3', undefined, 'Model views');
  const modelHint = el(
    'p',
    'muted',
    'Clean product renders with applied artwork from the current revision. Camera moves never change saved measurements.',
  );
  const modelList = el('div');
  modelBox.append(modelTitle, modelHint, modelList);

  const physicalLine = el(
    'p',
    'muted',
    'Measurements are provisional until physically checked. No production approval is conferred.',
  );

  const instructionsBox = el('section');
  instructionsBox.setAttribute('aria-label', 'Operational instructions');
  const instructionsTitle = el('h3', undefined, 'Operational instructions');
  const instructionsHint = el(
    'p',
    'muted',
    'Department-authored text printed on the sheet. Customer notes below are read-only context and never print as operational instructions.',
  );
  const instructionsInput = document.createElement('textarea');
  instructionsInput.setAttribute('data-doc-review-instructions', '');
  instructionsInput.setAttribute('aria-label', 'Operational instructions (department-authored)');
  instructionsInput.rows = 4;
  instructionsBox.append(instructionsTitle, instructionsHint, instructionsInput);

  const notesBox = el('section');
  notesBox.setAttribute('aria-label', 'Customer notes (read-only context)');
  const notesTitle = el('h4', undefined, 'Customer notes (read-only context)');
  const notesList = el('div', 'muted');
  notesBox.append(notesTitle, notesList);
  instructionsBox.append(notesBox);

  const techDetails = document.createElement('details');
  techDetails.className = 'disclosure';
  const techSummary = document.createElement('summary');
  techDetails.append(techSummary, el('p', 'muted', 'Only what you type is printed.'));
  const techGrid = el('div', 'sheet-logo-grid');
  const techInputs = new Map<keyof ReviewTechniqueSettings, HTMLInputElement>();
  for (
    const [field, label] of [
      ['temperature', 'Temperature'],
      ['time', 'Time'],
      ['pressure', 'Pressure'],
      ['colour', 'Colour'],
      ['thread', 'Thread'],
    ] as const
  ) {
    const wrap = el('label', undefined, label);
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('aria-label', `Technique ${label}`);
    input.addEventListener('change', () => {
      deps.commitTechnique({ [field]: input.value } as Partial<ReviewTechniqueSettings>);
    }, { signal });
    techInputs.set(field, input);
    wrap.append(input);
    techGrid.append(wrap);
  }
  techDetails.append(techGrid);

  const actionsBox = el('div', 'actions');
  const printButton = document.createElement('button');
  printButton.type = 'button';
  printButton.className = 'btn-primary';
  printButton.textContent = 'Print / save PDF';
  printButton.addEventListener('click', () => deps.requestPrint(), { signal });
  const draftButton = document.createElement('button');
  draftButton.type = 'button';
  draftButton.className = 'btn-secondary';
  draftButton.textContent = 'Print draft';
  draftButton.addEventListener('click', () => deps.requestPrint(), { signal });
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'btn-secondary';
  saveButton.textContent = 'Save job';
  saveButton.addEventListener('click', () => void deps.saveJob(), { signal });
  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'btn-link';
  backButton.textContent = 'Back to placements';
  backButton.addEventListener('click', () => deps.goBackToPlacements(), { signal });
  const gateNote = el('p', 'muted');
  gateNote.setAttribute('role', 'status');
  actionsBox.append(printButton, draftButton, saveButton, backButton, gateNote);

  const moreDetails = document.createElement('details');
  moreDetails.className = 'disclosure';
  const moreSummary = document.createElement('summary');
  moreSummary.textContent = 'More output options';
  const moreBody = el('div', 'actions');
  const operatorButton = document.createElement('button');
  operatorButton.type = 'button';
  operatorButton.className = 'btn-secondary';
  operatorButton.textContent = 'Save operator data';
  operatorButton.addEventListener('click', () => {
    const snapshot = deps.readSnapshot();
    if (snapshot === null) return;
    const view = buildReviewSheetView(snapshot);
    if (view === null) return;
    deps.saveOperatorData(view);
  }, { signal });
  const diagnosticButton = document.createElement('button');
  diagnosticButton.type = 'button';
  diagnosticButton.className = 'btn-secondary';
  diagnosticButton.textContent = 'Save diagnostic data';
  diagnosticButton.addEventListener('click', () => {
    const snapshot = deps.readSnapshot();
    if (snapshot?.candidate === null || snapshot?.candidate === undefined) return;
    const reference = snapshot.job.reference?.trim().replace(/[^A-Za-z0-9._-]+/g, '-') || 'operation-sheet';
    deps.saveDiagnosticData(serializeExport(snapshot.candidate), `${reference}-candidate.json`);
  }, { signal });
  moreBody.append(
    operatorButton,
    el('p', 'muted', 'Structured operator JSON for the exact snapshot shown in the preview.'),
    diagnosticButton,
    el('p', 'muted', 'Raw candidate JSON for advanced diagnosis only.'),
  );
  moreDetails.append(moreSummary, moreBody);

  rail.append(summaryBox, itemsBox, modelBox, physicalLine, instructionsBox, techDetails, actionsBox, moreDetails);
  host.append(heading, rail, main);

  const scheduleInstructionsCommit = (): void => {
    if (instructionsTimer !== null) clearTimeout(instructionsTimer);
    instructionsTimer = setTimeout(() => {
      instructionsTimer = null;
      if (!destroyed) deps.commitInstructions(instructionsInput.value);
    }, 600);
  };
  instructionsInput.addEventListener('input', scheduleInstructionsCommit, { signal });
  instructionsInput.addEventListener('blur', () => {
    if (instructionsTimer !== null) {
      clearTimeout(instructionsTimer);
      instructionsTimer = null;
    }
    if (!destroyed) deps.commitInstructions(instructionsInput.value);
  }, { signal });

  function paintRailForms(snapshot: DocumentReviewSnapshot): void {
    if (document.activeElement !== instructionsInput && instructionsInput.value !== snapshot.instructionsText) {
      instructionsInput.value = snapshot.instructionsText;
    }
    for (const [field, input] of techInputs) {
      if (document.activeElement !== input && input.value !== snapshot.technique[field]) {
        input.value = snapshot.technique[field];
      }
    }
    const filled = (Object.keys(snapshot.technique) as Array<keyof ReviewTechniqueSettings>)
      .filter((field) => snapshot.technique[field].trim() !== '').length;
    const scope = snapshot.techniqueScopeLabel !== null ? ` for ${snapshot.techniqueScopeLabel}` : '';
    techSummary.textContent = `Technique settings (optional${scope}${filled === 0 ? '' : ` · ${filled} set`})`;
  }

  function paintItems(computation: ReviewComputation): void {
    itemsList.replaceChildren();
    if (computation.items.length === 0) {
      itemsList.append(el('p', 'muted', 'No items to check. All software checks pass.'));
      return;
    }
    for (const item of computation.items) {
      const row = el('div', `doc-review-item doc-review-${item.severity}`);
      const text = el('p', undefined, item.message);
      row.append(text);
      if (item.detail !== undefined) row.append(el('p', 'muted', item.detail));
      if (item.fix !== undefined && item.severity !== 'info') {
        const fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'btn-link';
        fix.textContent = 'Fix';
        const target = item.fix;
        fix.setAttribute('aria-label', `Fix: ${item.message}`);
        fix.addEventListener('click', () => deps.fixItem(target), { signal });
        row.append(fix);
      }
      itemsList.append(row);
    }
  }

  function paintModelViews(snapshot: DocumentReviewSnapshot): void {
    modelList.replaceChildren();
    const entries = Object.entries(snapshot.modelViews ?? {});
    const ops = deps.modelViewOps;
    if (snapshot.candidate === null) {
      modelList.append(el('p', 'muted', 'No candidate to render views for.'));
      return;
    }
    if (entries.length === 0) {
      modelList.append(el(
        'p',
        'muted',
        ops
          ? 'No model views yet. Add one to render this option from the 3D model — no product photos needed.'
          : 'No model views supplied for this job. Photo references below keep working as before.',
      ));
    }
    for (const [configId, views] of entries) {
      const config = snapshot.candidate.configurations.find((item) => item.id === configId);
      const scope = config !== undefined
        ? displayScopeTitle(
          snapshot.project.products.find((entry) => entry.id === config.productId),
          config.productId,
          config.variantId,
        )
        : configId;
      const group = el('div', 'doc-review-model-group');
      const covered = new Set(views.flatMap((entry) => entry.view.associatedRegions));
      const uncovered = [...new Set(config?.placements.map((placement) => placement.regionId) ?? [])].filter((id) => !covered.has(id));
      if (views.length > 0 && uncovered.length > 0) {
        const product = snapshot.project.products.find((entry) => entry.id === config?.productId);
        const names = uncovered.map((id) => product?.regions.find((region) => region.id === id)?.name || 'a placed area');
        group.append(el('p', 'doc-review-warning', `Add or adjust a model view to show ${names.join(', ')}. Existing views do not cover these placed areas.`));
      }
      const head = el('div', 'doc-review-model-head');
      head.append(el('strong', undefined, scope));
      if (ops) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn-link';
        add.textContent = 'Add view from current camera';
        add.addEventListener('click', () => ops.add(configId), { signal });
        head.append(add);
      }
      group.append(head);
      views.forEach((entry, viewIndex) => {
        const row = el('div', 'doc-review-model-row');
        const name = entry.view.label?.trim() || entry.view.id;
        const status = entry.status === 'ready'
          ? `rendered from revision ${entry.render?.revision ?? '?'}.`
          : entry.status === 'failed'
            ? `render failed${entry.note ? ` — ${entry.note}` : '. Retry below.'}`
            : 'render pending — capture from the 3D model.';
        row.append(el('span', undefined, `${name} (${status})`));
        if (ops) {
          const buttons: Array<{ label: string; run: () => void; disabled?: boolean }> = [
            { label: 'Reframe to current camera', run: () => ops.reframe(configId, entry.view.id) },
            { label: 'Move up', run: () => ops.move(configId, entry.view.id, -1), disabled: viewIndex === 0 },
            {
              label: 'Move down',
              run: () => ops.move(configId, entry.view.id, 1),
              disabled: viewIndex === views.length - 1,
            },
            { label: 'Retry capture', run: () => ops.retry(configId, entry.view.id) },
            { label: 'Remove', run: () => ops.remove(configId, entry.view.id) },
          ];
          for (const spec of buttons) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-link';
            button.textContent = spec.label;
            if (spec.disabled === true) button.disabled = true;
            button.addEventListener('click', spec.run, { signal });
            row.append(button);
          }
        }
        group.append(row);
      });
      modelList.append(group);
    }
  }

  function paintPreview(snapshot: DocumentReviewSnapshot, computation: ReviewComputation): void {
    // Never steal focus: when focus sits on a preview Edit action, remember
    // its key and restore it after the re-render.
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active !== null && previewHost.contains(active)
      ? active.getAttribute('data-doc-review-focus')
      : null;
    const view = buildReviewSheetView(snapshot);
    if (view === null) {
      lastRenderedViewText = null;
      previewHost.replaceChildren(
        el('p', undefined, `The operational document cannot be built: ${snapshot.candidateError ?? 'no candidate available.'}`),
      );
    } else {
      const renderState = Object.entries(snapshot.modelViews ?? {}).map(([id, entries]) => [id,
        entries.map((entry) => [entry.view.id, entry.status, entry.render?.revision ?? null, entry.render?.cameraKey ?? null]),
      ]);
      const text = canonicalize({ view, renderState });
      if (text !== lastRenderedViewText) {
        lastRenderedViewText = text;
        ensureReviewStyles();
        const lookup = buildReviewSheetLookup(snapshot);
        previewHost.replaceChildren();
        previewHost.append(renderOperationSheet(view, document, lookup ?? undefined, snapshot.brandMarkDataUrl !== undefined ? { markDataUrl: snapshot.brandMarkDataUrl } : undefined));
        // Adjacent accessible Edit actions per logo card (screen only; the
        // lead's print CSS excludes `.doc-review-edit`). Cards render in
        // sheet/logo order, matching the view.
        const cards = [...previewHost.querySelectorAll('.opsheet-logo')];
        let cursor = 0;
        view.sheets.forEach((sheet, sheetIndex) => {
          const config = snapshot.candidate?.configurations[sheetIndex];
          sheet.logos.forEach((logo, logoIndex) => {
            const card = cards[cursor];
            cursor += 1;
            if (!card || !config) return;
            const placement = config.placements[logoIndex];
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'btn-link doc-review-edit';
            edit.textContent = `Edit ${logo.logoName}`;
            const key = `${config.id}#${logoIndex}`;
            edit.setAttribute('data-doc-review-focus', key);
            edit.setAttribute('aria-label', `Edit ${logo.logoName} placement in Step 2`);
            const target: ReviewFixTarget = {
              kind: 'placement',
              productId: config.productId,
              variantId: config.variantId,
              configId: config.id,
              placementIndex: logoIndex,
              ...(placement?.id !== undefined ? { placementId: placement.id } : {}),
            };
            edit.addEventListener('click', () => deps.fixItem(target), { signal });
            card.append(edit);
          });
        });
        const summaryLine = el(
          'p',
          'muted doc-review-preview-note',
          `${operationSheetSummary(view)} · ${operationSheetPageCount(view, lookup ?? undefined)} printed page(s). ` +
          'Customer notes stay read-only source context above and never print; only department text prints as operational instructions.',
        );
        previewHost.append(summaryLine);
      }
    }
    if (focusKey !== null) {
      const next = previewHost.querySelector(`[data-doc-review-focus="${CSS.escape(focusKey)}"]`) as HTMLElement | null;
      next?.focus();
    }
    void computation;
  }

  function update(): void {
    if (destroyed) return;
    const snapshot = deps.readSnapshot();
    if (snapshot === null) {
      lastRenderedViewText = null;
      summaryLines.replaceChildren(el('p', 'muted', 'Create or open a job to review its operational document.'));
      itemsList.replaceChildren();
      modelList.replaceChildren();
      notesList.replaceChildren();
      previewHost.replaceChildren(el('p', 'muted', 'No job open.'));
      printButton.disabled = true;
      draftButton.hidden = true;
      operatorButton.disabled = true;
      diagnosticButton.disabled = true;
      gateNote.textContent = '';
      return;
    }
    const computation = computeReviewItems(snapshot);
    const customer = snapshot.job.customer?.trim() || '—';
    const reference = snapshot.job.reference?.trim() || '—';
    summaryLines.replaceChildren(
      el('p', undefined, `Customer: ${customer}`),
      el('p', undefined, `Job: ${reference}`),
      el('p', undefined, `Products: ${computation.productCount} · Options: ${computation.optionCount} · Placements: ${computation.placementCount}`),
    );
    paintItems(computation);
    paintModelViews(snapshot);
    const notes = reviewCustomerNotes(snapshot);
    notesList.replaceChildren();
    if (notes.project !== undefined) notesList.append(el('p', undefined, `Project note: ${notes.project}`));
    for (const note of notes.placement) notesList.append(el('p', undefined, note));
    if (notes.project === undefined && notes.placement.length === 0) {
      notesList.append(el('p', undefined, 'No customer notes.'));
    }
    // Focused rail inputs are never repainted: their committed values arrive
    // through the next snapshot only after blur/debounce commits.
    if (!focusedWithin(instructionsBox)) {
      if (instructionsInput.value !== snapshot.instructionsText) instructionsInput.value = snapshot.instructionsText;
    }
    if (!focusedWithin(techDetails)) paintRailForms(snapshot);
    else {
      const filled = (Object.keys(snapshot.technique) as Array<keyof ReviewTechniqueSettings>)
        .filter((field) => snapshot.technique[field].trim() !== '').length;
      const scope = snapshot.techniqueScopeLabel !== null ? ` for ${snapshot.techniqueScopeLabel}` : '';
      techSummary.textContent = `Technique settings (optional${scope}${filled === 0 ? '' : ` · ${filled} set`})`;
    }

    printButton.disabled = !computation.completeEnabled;
    draftButton.hidden = !computation.draftEnabled;
    operatorButton.disabled = !computation.structurallyValid;
    diagnosticButton.disabled = snapshot.candidate === null;
    if (!computation.structurallyValid) {
      gateNote.textContent = 'Printing is disabled: the job is structurally invalid. See the first Fix above.';
    } else if (!computation.completeEnabled && computation.firstFix !== null) {
      gateNote.textContent = computation.draftEnabled
        ? 'Complete print is disabled until every item is resolved. Use Print draft for the marked draft, or follow the first Fix.'
        : 'Print / save PDF is disabled until every item is resolved. Follow the first Fix above.';
    } else {
      gateNote.textContent = '';
    }
    paintPreview(snapshot, computation);
  }

  function destroy(): void {
    destroyed = true;
    aborter.abort();
    if (instructionsTimer !== null) {
      clearTimeout(instructionsTimer);
      instructionsTimer = null;
    }
    host.replaceChildren();
  }

  update();
  return { update, destroy };
}
