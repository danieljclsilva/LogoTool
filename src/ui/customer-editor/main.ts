import {
  confirmRevision,
  newRevision,
  validateProject,
} from '../../core/index.js';
import type {
  Placement,
  PointMm,
  ProductDefinition,
  ProjectDocument,
  Region,
} from '../../core/types.js';
import {
  addPlacement,
  assertProjectEditorLimits,
  evaluatePlacementGeometry,
  evaluateProjectGeometry,
  placementSelector,
  PROJECT_EDITOR_LIMITS,
  removePlacement,
  updatePlacement,
} from '../../core/project-editor/index.js';
import type { PlacementGeometryResult, ProjectGeometryResult } from '../../core/project-editor/index.js';
import {
  createProjectPackage,
  PROJECT_PACKAGE_LIMITS,
  parseProjectPackage,
} from '../../packaging/project-package/index.js';
import type { ProjectPackageAsset } from '../../packaging/project-package/index.js';
import { createWebCryptoProjectHasher } from '../shared/browser-hasher.js';
import { runCustomerSelfContainedBootstrap } from './self-contained-bootstrap.js';
import {
  decodePresentationRaster,
  parsePresentationManifest,
  PRESENTATION_MANIFEST_PATH,
  PRESENTATION_MAX_IMAGE_BYTES,
  selectPresentationModel,
  selectPresentationReference,
  selectPresentationViews,
} from './presentation-assets.js';
import type { PresentationManifest } from './presentation-assets.js';
import type { ViewerSide } from '../../viewer/model-viewer.js';

interface EditorPackage {
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
  presentationManifest: PresentationManifest | null;
  presentationManifestPresent: boolean;
}

interface DragState {
  pointerId: number;
  configurationId: string;
  placementIndex: number;
  project: ProjectDocument;
  generation: number;
  screenToRegion: DOMMatrix;
  grabOffsetX: number;
  grabOffsetY: number;
  previewX: number;
  previewY: number;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing customer editor element: ${selector}`);
  return element;
}

const hook = <T extends Element>(name: string): T =>
  required<T>(`[data-customer-hook="${name}"]`);
const root = required<HTMLElement>('#customer-editor');
const fileInput = hook<HTMLInputElement>('file-input');
const chooseButton = hook<HTMLButtonElement>('choose');
const dropzone = hook<HTMLElement>('dropzone');
const saveButton = hook<HTMLButtonElement>('save');
const submitButton = hook<HTMLButtonElement>('submit');
const status = hook<HTMLElement>('status');
const projectId = hook<HTMLElement>('project-id');
const revisionLabel = hook<HTMLElement>('revision');
const assetCount = hook<HTMLElement>('asset-count');
const configurationSelect = hook<HTMLSelectElement>('configuration');
const productSelect = hook<HTMLSelectElement>('product');
const variantSelect = hook<HTMLSelectElement>('variant');
const regionSelect = hook<HTMLSelectElement>('region');
const logoSelect = hook<HTMLSelectElement>('logo');
const placementSelect = hook<HTMLSelectElement>('placement');
const xInput = hook<HTMLInputElement>('x-mm');
const yInput = hook<HTMLInputElement>('y-mm');
const widthInput = hook<HTMLInputElement>('width-mm');
const heightInput = hook<HTMLInputElement>('height-mm');
const rotationInput = hook<HTMLInputElement>('rotation');
const methodSelect = hook<HTMLSelectElement>('method');
const placementInstructions = hook<HTMLTextAreaElement>('placement-instructions');
const projectInstructions = hook<HTMLTextAreaElement>('instructions');
const addButton = hook<HTMLButtonElement>('add');
const updateButton = hook<HTMLButtonElement>('update');
const removeButton = hook<HTMLButtonElement>('remove');
const undoButton = hook<HTMLButtonElement>('undo');
const resetButton = hook<HTMLButtonElement>('reset');
const geometryStatus = hook<HTMLElement>('geometry');
const canvas = hook<SVGSVGElement>('canvas');
const canvasLayer = hook<SVGGElement>('canvas-layer');
const frameSummary = hook<HTMLElement>('frame');
const exactReview = hook<HTMLElement>('review');
const referenceReview = hook<HTMLElement>('review-reference');
const confirmedByInput = hook<HTMLInputElement>('confirmed-by');
const confirmButton = hook<HTMLButtonElement>('confirm');
const confirmationSummary = hook<HTMLElement>('confirmation');
const hasher = createWebCryptoProjectHasher();

// ---- Guided Position -> Size -> Review workflow (B+C proof-desk shell) ----
// The template worker owns template.html. Every new hook below is looked up
// with document.querySelector + null checks (never required()), so this file
// keeps working before and after the new shell lands. document scope (not
// #customer-editor) because the new shell places step-nav/save-draft-top
// outside <main>.
type GuideStep = 'position' | 'size' | 'review';
const STEP_ORDER: GuideStep[] = ['position', 'size', 'review'];
let guideStep: GuideStep = 'position';

const optionalHook = <T extends Element>(name: string): T | null =>
  document.querySelector<T>(`[data-customer-hook="${name}"]`);
const brandMark = optionalHook<HTMLImageElement>('brand-mark');
const saveDraftTop = optionalHook<HTMLButtonElement>('save-draft-top');
const stepNav = optionalHook<HTMLElement>('step-nav');
const stepPositionButton = optionalHook<HTMLButtonElement>('step-position');
const stepSizeButton = optionalHook<HTMLButtonElement>('step-size');
const stepReviewButton = optionalHook<HTMLButtonElement>('step-review');
const taskRail = optionalHook<HTMLElement>('task-rail');
const canvasPane = optionalHook<HTMLElement>('canvas-pane');
const contextLine = optionalHook<HTMLElement>('context-line');
const logoThumb = optionalHook<HTMLImageElement>('logo-thumb');
const viewReferenceButton = optionalHook<HTMLButtonElement>('view-reference');
const viewDiagramButton = optionalHook<HTMLButtonElement>('view-diagram');
const referenceImg = optionalHook<HTMLImageElement>('reference-img');
const referenceWarning = optionalHook<HTMLElement>('reference-warning');
const ratioLock = optionalHook<HTMLInputElement>('ratio-lock');
const precisePosition = optionalHook<HTMLElement>('precise-position');
const preciseSize = optionalHook<HTMLElement>('precise-size');
const primaryNext = optionalHook<HTMLButtonElement>('primary-next');
const backStep = optionalHook<HTMLButtonElement>('back-step');
const addAnotherButton = optionalHook<HTMLButtonElement>('add-another');
const prototypeNote = optionalHook<HTMLElement>('prototype-note');
const unsavedWarning = optionalHook<HTMLElement>('unsaved-warning');
// Owned by the template/build only; queried above so a missing hook can
// never throw here.
void brandMark; void stepNav; void canvasPane; void precisePosition; void preciseSize; void prototypeNote;

const UNSAVED_STEP_MESSAGE = 'You have changes that are not applied yet — press “Apply my changes” to keep them before moving on. (Switching the logo area above discards unsaved edits.)';

function hasUnsavedEdits(): boolean {
  return placementFormDirty || projectInstructionsDirty;
}

function updateUnsavedWarning(): void {
  if (!unsavedWarning) return;
  if (loaded && hasUnsavedEdits()) {
    unsavedWarning.hidden = false;
    unsavedWarning.textContent = UNSAVED_STEP_MESSAGE;
  } else {
    unsavedWarning.hidden = true;
  }
}

function stepNeighbor(step: GuideStep, delta: 1 | -1): GuideStep {
  const next = STEP_ORDER[Math.min(STEP_ORDER.length - 1, Math.max(0, STEP_ORDER.indexOf(step) + delta))];
  return next ?? step;
}

function requestStep(target: GuideStep): void {
  if (!loaded || loading || saving || confirming || drag) return;
  guideStep = target;
  // Navigation preserves pending form values. Only Apply/Continue mutates a revision.
  renderGuideStep();
  updateUnsavedWarning();
  updateButtons();
}

function renderGuideStep(): void {
  for (const panel of document.querySelectorAll<HTMLElement>('[data-step-panel]')) {
    panel.hidden = panel.getAttribute('data-step-panel') !== guideStep;
  }
  const stepButtons: Array<[GuideStep, HTMLButtonElement | null]> = [
    ['position', stepPositionButton],
    ['size', stepSizeButton],
    ['review', stepReviewButton],
  ];
  for (const [name, button] of stepButtons) {
    if (!button) continue;
    if (name === guideStep) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  if (primaryNext) {
    primaryNext.hidden = guideStep === 'review';
    primaryNext.textContent = guideStep === 'position'
      ? 'Continue to size'
      : guideStep === 'size' ? 'Review layout' : 'Save confirmed return';
  }
  const panel = root.querySelector<HTMLElement>(`[data-step-panel="${guideStep}"]`);
  if (panel) panel.insertBefore(geometryStatus, panel.querySelector(':scope > details') ?? null);
  const heading = taskRail?.querySelector('h2') ?? null;
  if (heading) {
    heading.textContent = guideStep === 'position'
      ? 'Place the logo'
      : guideStep === 'size' ? 'Set the logo size' : 'Review and confirm';
  }
  const lede = taskRail?.querySelector('.lede') ?? null;
  if (lede) {
    lede.textContent = guideStep === 'position'
      ? (currentPlacement() ? 'Choose where this logo goes.' : 'Choose a logo and its position.')
      : guideStep === 'size'
        ? 'Choose the width. The shape stays the same.'
        : 'Check every number, then confirm and save your return file.';
    if (guideStep === 'size' && ratioLock && !ratioLock.checked) lede.textContent = 'Set the width. Height can be adjusted separately.';
  }
}

function setSelectVisibility(select: HTMLSelectElement, visible: boolean): void {
  const label = select.closest('label');
  if (label) label.hidden = !visible;
}

function renderContextLine(): void {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  const product = project && configuration && productForConfiguration(project, configuration);
  const variant = product?.variants.find((item) => item.id === configuration?.variantId);
  const region = regionForSelection();
  const logo = project?.logos.find((item) => item.id === selectedLogoId);
  if (contextLine) contextLine.textContent = product ? `${product.name ?? product.id} · ${variant?.name ?? variant?.id ?? ''}` : 'Open a project to begin';
  const caption = optionalHook<HTMLElement>('product-caption');
  if (caption) caption.textContent = product?.name ?? product?.id ?? 'Your product';
  const artwork = optionalHook<HTMLElement>('artwork-name');
  if (artwork) artwork.textContent = logo?.name ?? logo?.id ?? 'No artwork supplied';
  const placementContext = optionalHook<HTMLElement>('placement-context');
  if (placementContext) placementContext.textContent = [region?.name ?? region?.id, methodSelect.value].filter(Boolean).join(' · ');
  if (prototypeNote) prototypeNote.textContent = project?.synthetic
    ? 'Synthetic draft. Visual reference only. Final checks by Logo Station.'
    : 'Visual reference only. Final checks by Logo Station.';
}

let thumbObjectUrl: string | null = null;
let thumbGeneration = 0;
let thumbBytes: Uint8Array | undefined;
function revokeThumbUrl(): void {
  if (thumbObjectUrl) URL.revokeObjectURL(thumbObjectUrl);
  thumbObjectUrl = null;
}
async function renderLogoThumb(): Promise<void> {
  if (!logoThumb) return;
  const project = loaded?.project;
  const logo = project?.logos.find((item) => item.id === selectedLogoId);
  const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
  const ref = logo?.assets.find((asset) => extensions[asset.mediaType]);
  const bytes = ref ? loaded?.assets.find((asset) => asset.path === ref.uri)?.bytes : undefined;
  if (bytes && bytes === thumbBytes && thumbObjectUrl) return;
  const token = ++thumbGeneration;
  thumbBytes = bytes;
  revokeThumbUrl();
  logoThumb.hidden = true;
  logoThumb.removeAttribute('src');
  if (!ref || !bytes) return;
  const decoded = await decodePresentationRaster(bytes, extensions[ref.mediaType]!);
  if (token !== thumbGeneration) { if (decoded) URL.revokeObjectURL(decoded.url); return; }
  if (!decoded) return;
  thumbObjectUrl = decoded.url;
  logoThumb.src = decoded.url;
  logoThumb.alt = `Artwork preview: ${logo?.name ?? logo?.id ?? 'logo'}`;
  logoThumb.hidden = false;
}

// ---- Presentation reference (lead-owned adapter, controller-wired) ----
// The domain has no garment-photo calibrated placement mapping, so the
// measured placement diagram stays the default view. An optional bounded
// presentation manifest in the package (presentation/preview.json + raster
// images) may supply a product reference photo; it is shown as a plain
// <img> and NEVER gets a mapped logo overlay. Nothing here depends on
// jacket-specific behavior.
let referenceAsset: { imagePath: string; label: string | null } | null = null;
let referenceView: 'diagram' | 'reference' = 'diagram';
let referenceNotice = '';
let referenceObjectUrl: string | null = null;
let referenceGeneration = 0;
let referenceBytes: Uint8Array | undefined;
let preferredReferenceOnLoad = true;

function revokeReferenceUrl(): void {
  if (referenceObjectUrl !== null) {
    try { URL.revokeObjectURL(referenceObjectUrl); } catch { /* already gone */ }
    referenceObjectUrl = null;
  }
}

function currentPresentationSelection() {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  if (!loaded || !project || !configuration) {
    return { imagePath: null as string | null, label: null as string | null, warning: null as string | null };
  }
  return selectPresentationReference(
    loaded.presentationManifest,
    loaded.presentationManifestPresent,
    configuration.productId,
    configuration.variantId,
    (path) => loaded?.assets.find((entry) => entry.path === path)?.bytes,
  );
}

function renderReferenceView(): void {
  const showing = referenceView === 'reference' && referenceAsset !== null;
  if (referenceImg) {
    if (showing && referenceAsset) {
      referenceImg.src = referenceObjectUrl ?? '';
      referenceImg.alt = referenceAsset.label ?? 'Product reference photo';
      referenceImg.hidden = false;
    } else {
      referenceImg.hidden = true;
      referenceImg.removeAttribute('src');
    }
  }
  const diagramWrap = canvas.closest<HTMLElement>('.stage');
  const photoWrap = referenceImg?.closest<HTMLElement>('.reference-wrap');
  if (diagramWrap) diagramWrap.hidden = showing;
  if (photoWrap) photoWrap.hidden = !showing;
  if (showing) canvas.setAttribute('hidden', '');
  else canvas.removeAttribute('hidden');
  if (viewReferenceButton) {
    viewReferenceButton.setAttribute('aria-pressed', showing ? 'true' : 'false');
    viewReferenceButton.disabled = referenceAsset === null;
  }
  if (viewDiagramButton) viewDiagramButton.setAttribute('aria-pressed', showing ? 'false' : 'true');
  const caption = optionalHook<HTMLElement>('view-caption');
  if (caption) caption.textContent = showing ? 'Product reference · not to scale' : 'Placement diagram · millimetres';
  if (referenceWarning) {
    const text = showing ? '' : referenceNotice;
    if (text) {
      referenceWarning.hidden = false;
      referenceWarning.textContent = text;
    } else {
      referenceWarning.hidden = true;
    }
  }
}

async function updateReferenceForSelection(): Promise<void> {
  const token = ++referenceGeneration;
  const selection = currentPresentationSelection();
  if (!selection.imagePath || !loaded) {
    // Presentation-only: warning text only, never a fake overlay.
    referenceBytes = undefined;
    referenceNotice = selection.warning ?? '';
    referenceAsset = null;
    if (referenceView === 'reference') referenceView = 'diagram';
    revokeReferenceUrl();
    renderReferenceView();
    return;
  }
  const bytes = loaded.assets.find((entry) => entry.path === selection.imagePath)?.bytes;
  if (!bytes) {
    referenceNotice = selection.warning ?? 'Reference image is missing from the package; showing the measured diagram instead.';
    referenceAsset = null;
    if (referenceView === 'reference') referenceView = 'diagram';
    revokeReferenceUrl();
    renderReferenceView();
    return;
  }
  if (bytes === referenceBytes && referenceAsset?.imagePath === selection.imagePath && referenceObjectUrl) { renderReferenceView(); return; }
  referenceBytes = bytes;
  referenceAsset = null;
  revokeReferenceUrl();
  renderReferenceView();
  const extension = selection.imagePath.slice(selection.imagePath.lastIndexOf('.'));
  const decoded = await decodePresentationRaster(bytes, extension);
  if (token !== referenceGeneration || !loaded) { if (decoded) URL.revokeObjectURL(decoded.url); return; }
  if (!decoded) {
    referenceNotice = selection.warning ?? `Reference image “${selection.imagePath}” could not be shown; showing the measured diagram instead.`;
    referenceAsset = null;
    if (referenceView === 'reference') referenceView = 'diagram';
    revokeReferenceUrl();
    renderReferenceView();
    return;
  }
  revokeReferenceUrl();
  referenceObjectUrl = decoded.url;
  referenceAsset = { imagePath: selection.imagePath, label: selection.label };
  referenceNotice = '';
  if (preferredReferenceOnLoad) { referenceView = 'reference'; preferredReferenceOnLoad = false; }
  renderReferenceView();
}

interface LogoPresentationApi {
  getReferenceState: () => { imagePath: string | null; view: 'diagram' | 'reference'; warning: string | null };
  getViewsState: () => {
    available: boolean;
    mode: ViewsMode;
    side: ProductViewSide;
    sides: ProductViewSide[];
    modelPath: string | null;
    caption: string;
    warning: string | null;
    failed: boolean;
    flatFallback: boolean;
    surface: 'none' | 'raster' | 'model' | 'proxy' | 'failed';
  };
}
declare global {
  interface Window {
    __logoPresentation?: LogoPresentationApi;
  }
}
window.__logoPresentation = {
  getReferenceState: () => {
    const selection = currentPresentationSelection();
    return {
      imagePath: referenceAsset?.imagePath ?? null,
      view: referenceView === 'reference' && referenceAsset ? 'reference' : 'diagram',
      warning: referenceNotice || selection.warning,
    };
  },
  getViewsState: () => ({
    available: showcaseAvailable,
    mode: showcaseMode,
    side: showcaseSide,
    sides: showcaseViews.map((entry) => entry.view).filter((view): view is ProductViewSide => view !== null),
    modelPath: showcaseModelPath,
    caption: (document.querySelector<HTMLElement>('[data-customer-hook="views-caption"]')?.textContent ?? describeShowcaseCaption()),
    warning: showcaseWarning || null,
    failed: showcaseModelFailed,
    flatFallback: showcaseMode === 'flat' && pickShowcaseView() === null && showcaseModelPath !== null,
    surface: showcaseSurface,
  }),
};

// ---- Product views showcase (flat / 2D / 3D, per-side) ----
// Independent of the measured placement diagram: the showcase never takes
// a mapped logo overlay, never invents a missing side, and never mutates
// the project. Only package-present views are offered.
type ViewsMode = 'flat' | '2d' | '3d';
type ProductViewSide = ViewerSide;
interface ShowcaseView { view: ProductViewSide | null; imagePath: string; label: string | null }
const VIEWS_SIDES: ProductViewSide[] = ['front', 'back', 'left', 'right'];
let showcaseViews: ShowcaseView[] = [];
let showcaseModelPath: string | null = null;
let showcaseModelLabel: string | null = null;
let showcaseAvailable = false;
let showcaseMode: ViewsMode = 'flat';
let showcaseSide: ProductViewSide = 'front';
let showcaseFlatPath: string | null = null;
let showcaseFlatBytes: Uint8Array | undefined;
let showcaseFlatUrl: string | null = null;
let showcaseGeneration = 0;
let showcaseWarning = '';
let showcaseModelFailed = false;
// Last model handed to the viewer: skip redundant showModel on unchanged bytes.
let showcaseShownModelPath: string | null = null;
let showcaseShownModelBytes: Uint8Array | null = null;
// Last successfully painted surface (viewer-ready status for tests/captions).
let showcaseSurface: 'none' | 'raster' | 'model' | 'proxy' | 'failed' = 'none';
// Package+configuration scope of the last side snap: the side snaps to the
// first present photo only when a new package/configuration opens, then
// free-runs (never reset from photo lists).
let showcaseScope = '';
interface ShowcaseViewer {
  setViewSide: (side: ProductViewSide) => void;
  setOrbitEnabled: (enabled: boolean) => void;
  showModel: (bytes: Uint8Array) => Promise<{ kind: string; message?: string }>;
  showImageProxy: (bytes: Uint8Array, label: string) => Promise<{ kind: string; message?: string }>;
  clear: () => void;
  refreshSize: () => void;
}
let showcaseViewer: ShowcaseViewer | null = null;
let showcaseViewerPromise: Promise<ShowcaseViewer | null> | null = null;

function revokeShowcaseFlatUrl(): void {
  if (showcaseFlatUrl !== null) {
    try { URL.revokeObjectURL(showcaseFlatUrl); } catch { /* already gone */ }
    showcaseFlatUrl = null;
  }
}

function readShowcaseAssets(): void {
  const project = loaded?.project;
  const configuration = project ? selectedConfiguration(project) : undefined;
  showcaseViews = [];
  showcaseModelPath = null;
  showcaseModelLabel = null;
  showcaseWarning = '';
  showcaseAvailable = false;
  if (!loaded || !project || !configuration) return;
  const lookup = (path: string): Uint8Array | undefined =>
    loaded?.assets.find((entry) => entry.path === path)?.bytes;
  const viewsSelection = selectPresentationViews(
    loaded.presentationManifest,
    loaded.presentationManifestPresent,
    configuration.productId,
    configuration.variantId,
    lookup,
  );
  showcaseViews = viewsSelection.views.map((entry) => ({
    view: entry.view,
    imagePath: entry.imagePath,
    label: entry.label,
  }));
  const modelSelection = selectPresentationModel(
    loaded.presentationManifest,
    loaded.presentationManifestPresent,
    configuration.productId,
    configuration.variantId,
    lookup,
  );
  showcaseModelPath = modelSelection.modelPath;
  showcaseModelLabel = modelSelection.label;
  showcaseWarning = modelSelection.warning ?? viewsSelection.warning ?? '';
  showcaseAvailable = showcaseViews.length > 0 || showcaseModelPath !== null;
  // Side snaps to the first present photo only when a new package or
  // configuration opens; afterwards it free-runs (never reset from photo
  // lists). The camera drives directly from showcaseSide; photos gate only
  // the raster itself. Flat stays enabled with a model (labelled
  // model-projection fallback) and all four side buttons are offered.
  const scope = `${loaded.project.projectId} ${loaded.project.revision} ${configuration.id}`;
  if (scope !== showcaseScope) {
    showcaseScope = scope;
    const firstSided = showcaseViews.find((entry) => entry.view !== null);
    if (firstSided?.view) showcaseSide = firstSided.view;
  }
}

function pickShowcaseView(): ShowcaseView | null {
  if (showcaseViews.length === 0) return null;
  const sided = showcaseViews.find((entry) => entry.view === showcaseSide);
  // Never invent a missing photo: an absent side has no raster.
  return sided ?? null;
}

function describeShowcaseCaption(): string {
  if (!showcaseAvailable) return showcaseWarning || 'No product views supplied in this package.';
  if (showcaseModelFailed) return 'Preview unavailable — model could not be shown';
  const picked = pickShowcaseView();
  const sideNote = ` · ${picked?.view ?? showcaseSide} view`;
  if (showcaseMode === 'flat') {
    // Model-only flat is an explicitly labelled projection, never an invented photo.
    if (picked) return `Flat product view${sideNote} · reference only, not to scale`;
    return `Flat model projection${sideNote} · reference only, not to scale`;
  }
  if (showcaseMode === '2d') {
    if (showcaseModelPath) return `Model projection - not a garment unfolding${sideNote}`;
    return `Planar view - not a 3D reconstruction${sideNote}`;
  }
  if (showcaseModelPath) return `Interactive 3D model${sideNote} · drag to orbit; placement decisions use the measured diagram`;
  return `Proxy - not reconstructed geometry${sideNote}`;
}

function paintShowcase(): void {
  const section = document.querySelector<HTMLElement>('[data-customer-hook="views-showcase"]');
  if (!section) return;
  section.hidden = loaded?.project === undefined || loaded === null || !showcaseAvailable;
  if (section.hidden) return;
  const uncalibrated = document.querySelector<HTMLElement>('[data-customer-hook="views-uncalibrated"]');
  if (uncalibrated && loaded?.project) {
    const configuration = selectedConfiguration(loaded.project);
    const product = loaded.project.products.find((item) => item.id === configuration?.productId);
    const haystack = `${product?.id ?? ''} ${product?.name ?? ''}`.toLowerCase();
    uncalibrated.hidden = !(haystack.includes('provisional') || haystack.includes('uncalibrated'));
  }
  const modelOnly = showcaseViews.length === 0 && showcaseModelPath !== null;
  const modeHooks: Record<ViewsMode, string> = { flat: 'views-mode-flat', '2d': 'views-mode-2d', '3d': 'views-mode-3d' };
  (Object.keys(modeHooks) as ViewsMode[]).forEach((mode) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-customer-hook="${modeHooks[mode]}"]`);
    if (!button) return;
    button.setAttribute('aria-pressed', showcaseMode === mode ? 'true' : 'false');
    // Flat stays enabled with a model: model-only flat renders an explicitly
    // labelled projection, never an invented photo.
    if (mode === 'flat') button.disabled = showcaseViews.length === 0 && showcaseModelPath === null;
    if (mode === '2d') button.disabled = showcaseViews.length === 0 && showcaseModelPath === null;
    if (mode === '3d') button.disabled = showcaseViews.length === 0 && showcaseModelPath === null;
  });
  const present: Record<ProductViewSide, boolean> = { front: false, back: false, left: false, right: false };
  for (const entry of showcaseViews) {
    if (entry.view !== null) present[entry.view] = true;
  }
  const hasUnscoped = showcaseViews.some((entry) => entry.view === null);
  const missing = VIEWS_SIDES.filter((side) => !present[side] && !hasUnscoped);
  for (const side of VIEWS_SIDES) {
    const button = document.querySelector<HTMLButtonElement>(`[data-customer-hook="views-side-${side}"]`);
    if (!button) continue;
    // Sides free-run with a model: all four drive the camera directly.
    // Photos gate only the flat raster itself.
    const offered = present[side] || (hasUnscoped && showcaseViews.length > 0) || showcaseModelPath !== null;
    button.setAttribute('aria-pressed', showcaseSide === side ? 'true' : 'false');
    button.disabled = !offered;
    button.hidden = !offered && showcaseViews.length > 0 && showcaseModelPath === null;
  }
  const missingNote = document.querySelector<HTMLElement>('[data-customer-hook="views-missing"]');
  if (missingNote) {
    if (showcaseViews.length > 0 && missing.length > 0 && !hasUnscoped) {
      missingNote.hidden = false;
      missingNote.textContent = `${missing.join(', ')} not supplied in this package — no photo invented.`;
    } else if (modelOnly) {
      missingNote.hidden = false;
      missingNote.textContent = 'No product photos in this package — flat shows a labelled model projection.';
    } else {
      missingNote.hidden = true;
      missingNote.textContent = '';
    }
  }
  const failureNote = showcaseModelFailed
    ? (showcaseFlatUrl ? 'Preview unavailable — model could not be shown · showing flat raster fallback' : 'Preview unavailable — model could not be shown')
    : '';
  const warningText = showcaseWarning || failureNote;
  const warning = document.querySelector<HTMLElement>('[data-customer-hook="views-warning"]');
  if (warning) {
    if (warningText) {
      warning.hidden = false;
      warning.textContent = warningText;
    } else {
      warning.hidden = true;
      warning.textContent = '';
    }
  }
  const caption = document.querySelector<HTMLElement>('[data-customer-hook="views-caption"]');
  if (caption) caption.textContent = describeShowcaseCaption();
  const flatImg = document.querySelector<HTMLImageElement>('[data-customer-hook="views-flat-img"]');
  const flatWrap = document.querySelector<HTMLElement>('[data-customer-hook="views-flat-wrap"]');
  const modelWrap = document.querySelector<HTMLElement>('[data-customer-hook="views-model-wrap"]');
  const flatRasterVisible = showcaseMode === 'flat' && pickShowcaseView() !== null && showcaseFlatUrl !== null;
  const flatFallbackVisible = showcaseMode === 'flat' && pickShowcaseView() === null && showcaseModelPath !== null;
  const flat2dVisible = showcaseMode === '2d' && showcaseModelPath === null && showcaseFlatUrl !== null;
  const rasterVisible = flatRasterVisible || flat2dVisible;
  const fallbackRaster = showcaseModelFailed && showcaseFlatUrl !== null && pickShowcaseView() !== null;
  if (flatImg) {
    if ((rasterVisible || fallbackRaster) && showcaseFlatUrl) {
      flatImg.src = showcaseFlatUrl;
      flatImg.alt = pickShowcaseView()?.label ?? 'Product view photo';
      flatImg.hidden = false;
    } else {
      flatImg.hidden = true;
      flatImg.removeAttribute('src');
    }
  }
  const emptyState = document.querySelector<HTMLElement>('[data-customer-hook="views-empty"]');
  const emptyVisible = (showcaseMode === 'flat' && !rasterVisible && !flatFallbackVisible) || ((showcaseMode === '2d' || showcaseMode === '3d') && showcaseModelFailed && !fallbackRaster);
  if (flatWrap) flatWrap.hidden = !(rasterVisible || fallbackRaster);
  if (modelWrap) modelWrap.hidden = !((showcaseMode === '2d' || showcaseMode === '3d' || flatFallbackVisible) && !emptyVisible);
  if (emptyState) {
    emptyState.hidden = !emptyVisible;
    if (emptyVisible) emptyState.textContent = showcaseModelFailed ? 'Preview unavailable — model could not be shown' : 'No product view available for this side — no photo invented.';
  }
  // NOTE: no refreshSize() here. paintShowcase runs on every state change
  // including side switches; resizing here would refit the camera while the
  // requested side is being applied in refreshShowcase. Sizing happens only
  // after the side is set in refreshShowcase.
}

async function loadShowcaseViewer(): Promise<ShowcaseViewer | null> {
  if (showcaseViewer) return showcaseViewer;
  if (!showcaseViewerPromise) {
    showcaseViewerPromise = import('../../viewer/model-viewer.js').then((module) => {
      const canvasElement = document.querySelector<HTMLCanvasElement>('[data-customer-hook="views-model-canvas"]');
      const wrap = document.querySelector<HTMLElement>('[data-customer-hook="views-model-wrap"]');
      if (!canvasElement || !wrap) return null;
      const attached = module.ModelViewer.attach({ canvas: canvasElement, container: wrap });
      const viewer = attached.viewer;
      if (!viewer) return null;
      showcaseViewer = {
        setViewSide: (side) => viewer.setViewSide(side),
        setOrbitEnabled: (enabled) => viewer.setOrbitEnabled(enabled),
        showModel: (bytes) => viewer.showModel(bytes),
        showImageProxy: (bytes, label) => viewer.showImageProxy(bytes, label),
        clear: () => viewer.clear(),
        refreshSize: () => viewer.refreshSize(),
      };
      return showcaseViewer;
    }).catch(() => null);
  }
  return showcaseViewerPromise;
}

async function refreshShowcase(): Promise<void> {
  const token = ++showcaseGeneration;
  readShowcaseAssets();
  // Capture currency AFTER the scope snap inside readShowcaseAssets: a
  // pre-snap side would mark the first decode stale on non-front packages.
  const modeAtStart = showcaseMode;
  const sideAtStart = showcaseSide;
  const snapshot = loaded;
  if (!snapshot?.project || !showcaseAvailable) {
    showcaseFlatPath = null;
    showcaseFlatBytes = undefined;
    showcaseModelFailed = false;
    showcaseShownModelPath = null;
    showcaseShownModelBytes = null;
    showcaseSurface = 'none';
    revokeShowcaseFlatUrl();
    try { showcaseViewer?.clear(); } catch { /* viewer teardown is best-effort */ }
    paintShowcase();
    return;
  }
  const live = (): boolean => token === showcaseGeneration && loaded === snapshot && showcaseMode === modeAtStart && showcaseSide === sideAtStart;
  const picked = pickShowcaseView();
  const flatPath = picked?.imagePath ?? null;
  if (flatPath !== showcaseFlatPath) {
    showcaseFlatPath = flatPath;
    showcaseFlatBytes = undefined;
    revokeShowcaseFlatUrl();
  }
  paintShowcase();
  if (picked?.imagePath && loaded) {
    const bytes = loaded.assets.find((entry) => entry.path === picked.imagePath)?.bytes;
    if (bytes && bytes !== showcaseFlatBytes) {
      const extension = picked.imagePath.slice(picked.imagePath.lastIndexOf('.'));
      const currentPath = picked.imagePath;
      const decoded = await decodePresentationRaster(bytes, extension);
      // Stale decode guard: install only when generation, package identity,
      // mode/side, and raster path are all still current.
      if (token !== showcaseGeneration || loaded !== snapshot || showcaseMode !== modeAtStart || showcaseSide !== sideAtStart || showcaseFlatPath !== currentPath) {
        if (decoded) URL.revokeObjectURL(decoded.url);
        return;
      }
      // Cache only a completed decode. A mode switch can invalidate an
      // in-flight decode without changing its path or bytes; the next mode
      // must still be able to decode that same image.
      showcaseFlatBytes = decoded ? bytes : undefined;
      revokeShowcaseFlatUrl();
      showcaseFlatUrl = decoded?.url ?? null;
      if (decoded) showcaseSurface = 'raster';
      paintShowcase();
    }
  }
  const flatFallbackSurface = showcaseMode === 'flat' && picked === null && showcaseModelPath !== null;
  const needsSurface = showcaseMode === '2d' || showcaseMode === '3d' || flatFallbackSurface;
  if (!needsSurface) return;
  if (showcaseModelPath && loaded) {
    const bytes = loaded.assets.find((entry) => entry.path === showcaseModelPath)?.bytes;
    if (!bytes) {
      showcaseModelFailed = true;
      showcaseShownModelPath = null;
      showcaseShownModelBytes = null;
      showcaseSurface = 'failed';
      paintShowcase();
      return;
    }
    const viewer = await loadShowcaseViewer();
    if (viewer === null) {
      // WebGL unavailable or attach failed: surface, never blank success.
      if (token !== showcaseGeneration || loaded !== snapshot) return;
      showcaseModelFailed = true;
      showcaseSurface = 'failed';
      paintShowcase();
      return;
    }
    if (token !== showcaseGeneration || loaded !== snapshot || !live()) return;
    // Package buffers are immutable. Identity distinguishes replacement files
    // even when their path, length and container header bytes are identical.
    const unchanged = showcaseShownModelPath === showcaseModelPath && showcaseShownModelBytes === bytes && showcaseSurface === 'model';
    if (!unchanged) {
      const status = await viewer.showModel(bytes);
      if (token !== showcaseGeneration || loaded !== snapshot || !live()) return;
      showcaseModelFailed = status.kind !== 'ready';
      if (status.kind === 'ready') {
        showcaseShownModelPath = showcaseModelPath;
        showcaseShownModelBytes = bytes;
        showcaseSurface = 'model';
      } else {
        showcaseShownModelPath = null;
        showcaseShownModelBytes = null;
        showcaseSurface = 'failed';
        if (status.kind === 'parse-failed' && typeof status.message === 'string') showcaseWarning = status.message;
      }
    } else if (showcaseModelFailed) {
      showcaseModelFailed = false;
    }
    if (!showcaseModelFailed) showcaseSurface = 'model';
    paintShowcase();
    if (!showcaseModelFailed) {
      // Order matters: set the chosen side FIRST, then resize. refreshSize
      // preserves the exact current direction, so sizing after the side
      // keeps the requested view instead of resetting it.
      viewer.setViewSide(showcaseSide);
      viewer.setOrbitEnabled(showcaseMode === '3d');
      viewer.refreshSize();
    }
    return;
  }
  if (showcaseMode === '3d' && picked?.imagePath && loaded) {
    const bytes = loaded.assets.find((entry) => entry.path === picked.imagePath)?.bytes;
    if (!bytes) return;
    const proxyViewer = await loadShowcaseViewer();
    if (proxyViewer === null || token !== showcaseGeneration || loaded !== snapshot || !live()) return;
    showcaseShownModelPath = null;
    showcaseShownModelBytes = null;
    const status = await proxyViewer.showImageProxy(bytes, picked.label ?? 'Product view');
    if (token !== showcaseGeneration || loaded !== snapshot || !live()) return;
    showcaseModelFailed = status.kind !== 'ready';
    showcaseSurface = showcaseModelFailed ? 'failed' : 'proxy';
    paintShowcase();
    if (!showcaseModelFailed) proxyViewer.refreshSize();
  }
}

function chooseShowcaseMode(mode: ViewsMode): void {
  if (showcaseMode === mode) return;
  cancelDrag('Move cancelled because the product view changed. Your saved logo is unchanged.');
  showcaseMode = mode;
  showcaseModelFailed = false;
  paintShowcase();
  void refreshShowcase();
}

function chooseShowcaseSide(side: ProductViewSide): void {
  cancelDrag('Move cancelled because the product view changed. Your saved logo is unchanged.');
  showcaseSide = side;
  paintShowcase();
  void refreshShowcase();
}
// Aspect-ratio lock for the Size step. The lock only mirrors width into
// height in the form; independent width/height stay a domain capability and
// unlocking (or typing a height) always sticks.
let lockedRatio: number | null = null;

function refreshLockedRatio(): void {
  lockedRatio = null;
  if (!ratioLock?.checked) return;
  const width = Number(widthInput.value);
  const height = Number(heightInput.value);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    lockedRatio = width / height;
  }
}
let loaded: EditorPackage | null = null;
let baseline: ProjectDocument | null = null;
let activeConfigurationId = '';
let selectedRegionId = '';
let selectedLogoId = '';
let selectedPlacementIndex: number | null = null;
let undoHistory: ProjectDocument[] = [];
let stateGeneration = 0;
let loadGeneration = 0;
let loading = false;
let saving = false;
let confirming = false;
let confirmationFresh = false;
let placementFormDirty = false;
let projectInstructionsDirty = false;
let drag: DragState | null = null;
let generatedId = 0;
let geometryProject: ProjectDocument | null = null;
let geometryResult: ProjectGeometryResult | null = null;
let geometryLookup: Map<string, Map<number, PlacementGeometryResult>> | null = null;

function setStatus(message: string): void {
  status.textContent = message;
  status.hidden = /^Opened |^Applied your changes|^Nothing changed/.test(message);
}

function cloneProject(project: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(project)) as ProjectDocument;
}

function selectedConfiguration(project = loaded?.project): ProjectDocument['configurations'][number] | undefined {
  return project?.configurations.find((configuration) => configuration.id === activeConfigurationId)
    ?? project?.configurations[0];
}

function productForConfiguration(project: ProjectDocument, configuration: ProjectDocument['configurations'][number]): ProductDefinition | undefined {
  return project.products.find((product) => product.id === configuration.productId);
}


function regionForSelection(): Region | undefined {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  const product = project && configuration && productForConfiguration(project, configuration);
  return product?.regions.find((region) => region.id === selectedRegionId);
}

function currentPlacement(): Placement | undefined {
  const configuration = selectedConfiguration();
  if (!configuration || selectedPlacementIndex === null) return undefined;
  return configuration.placements[selectedPlacementIndex];
}

function geometryFor(project: ProjectDocument): ProjectGeometryResult {
  if (geometryProject === project && geometryResult !== null) return geometryResult;
  const result = evaluateProjectGeometry(project);
  const byConfiguration = new Map<string, Map<number, PlacementGeometryResult>>();
  for (const placement of result.placements) {
    let byPlacement = byConfiguration.get(placement.configurationId);
    if (!byPlacement) {
      byPlacement = new Map();
      byConfiguration.set(placement.configurationId, byPlacement);
    }
    byPlacement.set(placement.placementIndex, placement);
  }
  geometryProject = project;
  geometryResult = result;
  geometryLookup = byConfiguration;
  return result;
}

function selectedPlacementGeometry(project: ProjectDocument, configurationId: string, index: number): PlacementGeometryResult | undefined {
  geometryFor(project);
  return geometryLookup?.get(configurationId)?.get(index);
}

function addOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function replaceOptions(select: HTMLSelectElement, values: Array<{ value: string; label: string }>, selected: string): void {
  select.replaceChildren();
  for (const option of values) addOption(select, option.value, option.label);
  select.value = selected;
}

function displayName(id: string, name?: string): string {
  return name ?? id;
}

function invalidateUiContext(): void {
  cancelDrag('Moving stopped because you switched to something else. Your saved logo is unchanged.');
  stateGeneration += 1;
}

function updateButtons(): void {
  const project = loaded?.project;
  const usable = project !== undefined && !loading;
  const configuration = project && selectedConfiguration(project);
  const canEdit = usable && configuration !== undefined;
  const hasSelectedPlacement = canEdit && currentPlacement() !== undefined;
  const hasPendingEdits = placementFormDirty || projectInstructionsDirty;
  const structurallyValid = project !== undefined && validateProject(project).ok;
  saveButton.disabled = !usable || saving || !structurallyValid || hasPendingEdits;
  submitButton.disabled = !usable || saving || confirming || drag !== null || !structurallyValid || hasPendingEdits || !confirmationFresh || !isGeometryValid(project!);
  confirmButton.disabled = !usable || confirming || saving || drag !== null || !structurallyValid || hasPendingEdits || !confirmedByInput.value.trim() || !isGeometryValid(project!);
  updateButton.disabled = !usable || saving || confirming || drag !== null || (!projectInstructionsDirty && (!placementFormDirty || !hasSelectedPlacement));
  addButton.disabled = !canEdit || saving || confirming || drag !== null || !selectedRegionId || !selectedLogoId;
  removeButton.disabled = !canEdit || !hasSelectedPlacement || saving || confirming || drag !== null || hasPendingEdits;
  undoButton.disabled = !canEdit || undoHistory.length === 0 || saving || confirming || drag !== null || hasPendingEdits;
  resetButton.disabled = !canEdit || baseline === null || saving || confirming || drag !== null || hasPendingEdits;
  for (const control of [configurationSelect, productSelect, variantSelect, regionSelect, logoSelect, placementSelect,
    xInput, yInput, widthInput, heightInput, rotationInput, methodSelect, placementInstructions, projectInstructions,
    confirmedByInput]) control.disabled = !usable;
  // Guided shell mirrors: top draft button tracks save; step navigation and
  // the primary/back actions stay enabled whenever a project is usable so
  // the Position -> Size -> Review progression never strands the user.
  if (saveDraftTop) saveDraftTop.disabled = saveButton.disabled;
  if (primaryNext) primaryNext.disabled = !usable || saving || confirming || drag !== null;
  if (backStep) backStep.disabled = !usable || saving || confirming || drag !== null || guideStep === 'position';
  if (addAnotherButton) addAnotherButton.disabled = addButton.disabled;
  const stepBlocked = !usable || loading || saving || confirming || drag !== null;
  if (stepPositionButton) stepPositionButton.disabled = stepBlocked;
  if (stepSizeButton) stepSizeButton.disabled = stepBlocked;
  if (stepReviewButton) stepReviewButton.disabled = stepBlocked;
  if (ratioLock) ratioLock.disabled = !usable || !currentPlacement();
  if (viewReferenceButton) viewReferenceButton.disabled = referenceAsset === null;
  if (viewDiagramButton) viewDiagramButton.disabled = !usable;
  updateButton.hidden = !hasPendingEdits;
  confirmButton.hidden = confirmationFresh && !hasPendingEdits;
  submitButton.hidden = !confirmationFresh || hasPendingEdits;
  saveButton.hidden = false;
  if (addAnotherButton) addAnotherButton.hidden = !project?.logos.length;
  const jobChoices = optionalHook<HTMLElement>('job-choices');
  if (jobChoices) jobChoices.hidden = !project || !(project.configurations.length > 1 || project.products.length > 1 || (configuration ? productForConfiguration(project, configuration)?.variants.length ?? 0 : 0) > 1 || project.logos.length > 1);
}
function isGeometryValid(project: ProjectDocument): boolean {
  try {
    return geometryFor(project).ok;
  } catch {
    return false;
  }
}

function setGeometry(message: string, valid: boolean): void {
  geometryStatus.textContent = message.startsWith('Fits: yes') ? 'Fits: yes — within the logo area.' : message;
  geometryStatus.title = message;
  geometryStatus.classList.toggle('invalid', !valid);
  geometryStatus.classList.toggle('ok', valid);
}

function updateConfirmationState(): void {
  const project = loaded?.project;
  const confirmation = project?.confirmation;
  if (!project) {
    confirmationFresh = false;
    confirmationSummary.textContent = 'No project open yet.';
    return;
  }
  if (!confirmation) {
    confirmationFresh = false;
    const prior = project.history?.[project.history.length - 1];
    confirmationSummary.textContent = prior
      ? `Nothing confirmed for this version yet. An older confirmation from version ${prior.revision} no longer counts — check the sizes above, then confirm again.`
      : 'Nothing confirmed yet. Check the sizes above, then type your name and confirm.';
    return;
  }
  if (!confirmationFresh) {
    confirmationSummary.textContent = `Checking what was confirmed for version ${confirmation.revision}. A file you just opened is not trusted until it is checked.`;
    return;
  }
  if (confirmation.revision !== project.revision) {
    confirmationFresh = false;
    confirmationSummary.textContent = `The recorded confirmation is for older version ${confirmation.revision}; this is version ${project.revision}. Check the sizes above, then confirm again.`;
    return;
  }
  confirmationSummary.textContent = `Confirmed: version ${confirmation.revision}, by ${confirmation.confirmedBy} at ${confirmation.confirmedAt}. This is your own record — not Logo Station approval.`;
}

function renderSelectorOptions(): void {
  const project = loaded?.project;
  if (!project) {
    for (const select of [configurationSelect, productSelect, variantSelect, regionSelect, logoSelect, placementSelect, methodSelect]) {
      select.replaceChildren();
    }
    return;
  }
  const configuration = selectedConfiguration(project);
  if (!configuration) return;
  activeConfigurationId = configuration.id;
  const product = productForConfiguration(project, configuration);
  const variant = product?.variants.find((candidate) => candidate.id === configuration.variantId);
  const regions = (variant?.regionIds ?? []).map((id) => product?.regions.find((region) => region.id === id)).filter((region): region is Region => region !== undefined);
  if (!regions.some((region) => region.id === selectedRegionId)) selectedRegionId = currentPlacement()?.regionId ?? regions[0]?.id ?? '';
  const placement = currentPlacement();
  if (!project.logos.some((logo) => logo.id === selectedLogoId)) selectedLogoId = project.logos[0]?.id ?? '';

  replaceOptions(configurationSelect, project.configurations.map((item) => {
    const itemProduct = productForConfiguration(project, item);
    const itemVariant = itemProduct?.variants.find((candidate) => candidate.id === item.variantId);
    return { value: item.id, label: `${itemProduct?.name ?? item.productId} · ${itemVariant?.name ?? item.variantId}` };
  }), configuration.id);
  replaceOptions(productSelect, project.products.map((item) => ({ value: item.id, label: displayName(item.id, item.name) })), configuration.productId);
  replaceOptions(variantSelect, (product?.variants ?? []).map((item) => ({ value: item.id, label: displayName(item.id, item.name) })), configuration.variantId);
  replaceOptions(regionSelect, regions.map((item) => ({ value: item.id, label: displayName(item.id, item.name) })), selectedRegionId);
  replaceOptions(logoSelect, project.logos.map((item) => ({ value: item.id, label: displayName(item.id, item.name) })), selectedLogoId);
  const placementOptions = configuration.placements.map((item, index) => {
    const logo = project.logos.find((candidate) => candidate.id === item.logoId);
    const region = product?.regions.find((candidate) => candidate.id === item.regionId);
    const key = String(index);
    const name = `Placement ${index + 1}: ${logo?.name ?? item.logoId} · ${region?.name ?? item.regionId}`;
    return { value: key, label: name };
  });
  replaceOptions(placementSelect, [{ value: '', label: configuration.placements.length ? 'Choose placement' : 'No placements' }, ...placementOptions], selectedPlacementIndex === null ? '' : String(selectedPlacementIndex));
  const methods = regionForSelection()?.allowedMethods ?? [];
  const currentMethod = placement?.method ?? methods[0] ?? '';
  replaceOptions(methodSelect, methods.map((method) => ({ value: method, label: method })), currentMethod);
  // Guided shell: hide single-choice selects (never required inputs, never
  // the placement selector which doubles as the zero-placement empty
  // state). Readable product/SKU + artwork context moves to context-line.
  setSelectVisibility(configurationSelect, project.configurations.length > 1);
  setSelectVisibility(productSelect, project.products.length > 1);
  setSelectVisibility(variantSelect, (product?.variants.length ?? 0) > 1);
  setSelectVisibility(regionSelect, regions.length > 1);
  setSelectVisibility(logoSelect, project.logos.length > 1);
  setSelectVisibility(methodSelect, methods.length > 1);
  setSelectVisibility(placementSelect, configuration.placements.length > 1);
}

function placementLabel(configuration: ProjectDocument['configurations'][number], index: number): string {
  return configuration.placements[index]?.id ?? `Placement ${index + 1}`;
}
function readNumeric(input: HTMLInputElement, label: string): number {
  const value = Number(input.value);
  if (input.value.trim() === '' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

let placementFormKey = '';
function populatePlacementForm(): void {
  const placement = currentPlacement();
  if (!placement) {
    const logo = loaded?.project.logos.find((item) => item.id === selectedLogoId);
    const asset = logo?.assets.find((item) => item.widthPx && item.heightPx);
    const width = logo?.knownWidthMm ?? 40;
    const height = logo?.knownHeightMm ?? (asset ? width * asset.heightPx! / asset.widthPx! : 40);
    xInput.value = '0';
    yInput.value = '0';
    widthInput.value = String(width);
    heightInput.value = String(height);
    rotationInput.value = '0';
    if (ratioLock) ratioLock.checked = true;
    refreshLockedRatio();
    placementInstructions.value = '';
    return;
  }
  xInput.value = String(placement.pos.xMm);
  yInput.value = String(placement.pos.yMm);
  widthInput.value = String(placement.widthMm);
  heightInput.value = String(placement.heightMm);
  rotationInput.value = String(placement.rotationDeg);
  placementInstructions.value = placement.instructions ?? '';
  methodSelect.value = placement.method;
  // Size-step ratio lock defaults to checked where the starting ratio is
  // valid; populate always re-seeds it from the loaded placement.
  const key = JSON.stringify([loaded?.project.projectId, activeConfigurationId, selectedPlacementIndex, selectedLogoId]);
  if (ratioLock && key !== placementFormKey) {
    placementFormKey = key;
    const width = Number(widthInput.value);
    const height = Number(heightInput.value);
    ratioLock.checked = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  }
  refreshLockedRatio();
}


function renderCanvas(): void {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  const region = regionForSelection();
  canvasLayer.replaceChildren();
  if (!project || !configuration || !region) {
    canvas.setAttribute('viewBox', '-120 -100 240 200');
    frameSummary.textContent = 'No logo area chosen yet.';
    setGeometry('Open a project to see whether your logo fits.', true);
    return;
  }

  const safe = region.safeArea;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of safe) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (const exclusion of region.exclusions ?? []) {
    for (const [x, y] of exclusion) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const padX = Math.max((maxX - minX) * .12, 8);
  const padY = Math.max((maxY - minY) * .12, 8);
  const viewX = minX - padX;
  const viewY = -maxY - padY;
  const viewWidth = maxX - minX + padX * 2;
  const viewHeight = maxY - minY + padY * 2;
  canvas.setAttribute('viewBox', `${viewX} ${viewY} ${viewWidth} ${viewHeight}`);

  const svgNode = (name: string): SVGElement => document.createElementNS('http://www.w3.org/2000/svg', name);
  const polygonPoints = (points: PointMm[]): string => points.map(([x, y]) => `${x},${-y}`).join(' ');
  const safePolygon = svgNode('polygon');
  safePolygon.setAttribute('points', polygonPoints(safe));
  safePolygon.setAttribute('class', 'safe-area');
  safePolygon.setAttribute('aria-label', 'Safe area in millimetres');
  canvasLayer.append(safePolygon);
  for (const exclusion of region.exclusions ?? []) {
    const polygon = svgNode('polygon');
    polygon.setAttribute('points', polygonPoints(exclusion));
    polygon.setAttribute('class', 'exclusion-area');
    polygon.setAttribute('aria-label', 'Excluded area in millimetres');
    canvasLayer.append(polygon);
  }

  const originX = svgNode('line');
  originX.setAttribute('x1', String(viewX)); originX.setAttribute('x2', String(viewX + viewWidth));
  originX.setAttribute('y1', '0'); originX.setAttribute('y2', '0'); originX.setAttribute('class', 'origin');
  canvasLayer.append(originX);
  const originY = svgNode('line');
  originY.setAttribute('x1', '0'); originY.setAttribute('x2', '0');
  originY.setAttribute('y1', String(viewY)); originY.setAttribute('y2', String(viewY + viewHeight)); originY.setAttribute('class', 'origin');
  canvasLayer.append(originY);

  geometryFor(project);
  const configurationGeometry = geometryLookup?.get(configuration.id);
  for (const [index, item] of configuration.placements.entries()) {
    if (item.regionId !== region.id) continue;
    const verdict = configurationGeometry?.get(index);
    if (!verdict || verdict.footprint.length !== 4) continue;
    const polygon = svgNode('polygon') as SVGPolygonElement;
    polygon.setAttribute('points', polygonPoints(verdict.footprint));
    polygon.setAttribute('class', `footprint${verdict.ok ? '' : ' invalid'}${index === selectedPlacementIndex ? ' selected' : ''}`);
    polygon.dataset.placementIndex = String(index);
    polygon.setAttribute('tabindex', '0');
    polygon.setAttribute('role', 'button');
    const logo = project.logos.find((candidate) => candidate.id === item.logoId);
    polygon.setAttribute('aria-label', `Logo box for ${logo?.name ?? item.logoId}; ${item.widthMm} by ${item.heightMm} millimetres`);
    polygon.addEventListener('pointerdown', (event) => beginDrag(event, index));
    polygon.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        contextChanged();
        selectedPlacementIndex = index;
        renderAll();
      }
    });
    const label = svgNode('text');
    label.dataset.placementIndex = String(index);
    label.setAttribute('x', String(item.pos.xMm));
    label.setAttribute('y', String(-item.pos.yMm));
    label.setAttribute('class', 'footprint-label');
    label.textContent = logo?.name ?? item.logoId;
    canvasLayer.append(polygon, label);
  }

  frameSummary.textContent = `Region ${displayName(region.id, region.name)} · frame ${region.frame.frameId}; origin: ${region.frame.originDescription}; +x ${region.frame.axes.xPositive}, +y ${region.frame.axes.yPositive}; calibration ${region.calibrationRef.calibrationId} ${region.calibrationRef.version}. Units: mm.`;
  const selected = currentPlacement();
  if (!selected) {
    setGeometry(`${configuration.placements.length} placed logo(s) in this product set. Choose a logo area and logo to add one.`, true);
  } else {
    const verdict = selectedPlacementGeometry(project, configuration.id, selectedPlacementIndex!);
    setGeometry(verdict?.ok ? `Fits: yes — ${verdict.reason}` : `Fits: no — ${verdict?.reason ?? 'Size is unavailable.'}`, verdict?.ok === true);
  }
}

function renderReview(): void {
  const project = loaded?.project;
  if (!project) {
    exactReview.textContent = 'Open a project to check the exact sizes here.';
    referenceReview.textContent = 'Open a project to see its measurement references.';
    return;
  }
  exactReview.replaceChildren();
  const references: string[] = [`Project: ${project.projectId}`, `Version: ${project.revision}`];
  function line(parent: HTMLElement, text: string, tag = 'p'): HTMLElement {
    const element = document.createElement(tag);
    element.textContent = text;
    parent.append(element);
    return element;
  }
  for (const configuration of project.configurations) {
    const product = productForConfiguration(project, configuration);
    const variant = product?.variants.find((item) => item.id === configuration.variantId);
    const group = document.createElement('section');
    group.className = 'review-product';
    exactReview.append(group);
    line(group, `${displayName(configuration.productId, product?.name)} · ${displayName(configuration.variantId, variant?.name)}`, 'h3');
    references.push('', `Product set: ${configuration.id}`);
    for (const regionId of variant?.regionIds ?? []) {
      const region = product?.regions.find((item) => item.id === regionId);
      if (region) references.push(
        `Logo area frame: ${displayName(region.id, region.name)}`,
        `Frame: ${region.frame.frameId}; origin ${region.frame.originDescription}`,
        `Axes: +x ${region.frame.axes.xPositive}; +y ${region.frame.axes.yPositive}`,
        `Calibration: ${region.calibrationRef.calibrationId} ${region.calibrationRef.version}`,
      );
    }
    if (configuration.placements.length === 0) line(group, 'Placed logos: 0');
    for (const [index, placement] of configuration.placements.entries()) {
      const region = product?.regions.find((item) => item.id === placement.regionId);
      const logo = project.logos.find(item => item.id === placement.logoId);
      const fit = selectedPlacementGeometry(project, configuration.id, index);
      const item = document.createElement('div');
      item.className = 'review-placement';
      group.append(item);
      line(item, `${displayName(placement.logoId, logo?.name)} · ${displayName(placement.regionId, region?.name)} · ${placement.method}`, 'h4');
      line(item, `Width × height: ${placement.widthMm} mm × ${placement.heightMm} mm`);
      const fitLine = line(item, fit?.ok ? 'Fits: yes — within the logo area.' : `Fits: no — ${fit?.reason ?? 'Size is unavailable.'}`);
      fitLine.className = fit?.ok ? 'review-fit' : 'review-fit invalid';
      const measurements = document.createElement('details');
      measurements.className = 'review-measurements';
      item.append(measurements);
      line(measurements, 'Position and rotation', 'summary');
      line(measurements, `Reference point: ${region?.frame.originDescription ?? 'unknown'}`);
      line(measurements, `Directions: +x ${region?.frame.axes.xPositive ?? 'unknown'}; +y ${region?.frame.axes.yPositive ?? 'unknown'}`);
      line(measurements, `Center: ${placement.pos.xMm} mm, ${placement.pos.yMm} mm (logo middle, offsets along the area's +x and +y from its reference point)`);
      line(measurements, `Turn clockwise: ${placement.rotationDeg}°`);
      if (placement.instructions) line(item, `Note about this logo: ${placement.instructions}`);
      references.push(`Logo ${placementLabel(configuration, index)}: ${placement.logoId}; area ${placement.regionId}`);
    }
  }
  if (project.instructions) line(exactReview, `Notes for the whole project: ${project.instructions}`);
  referenceReview.textContent = references.join('\n');
}

function renderAll(): void {
  const project = loaded?.project;
  root.classList.toggle('is-empty', !project);
  dropzone.hidden = project !== undefined;
  chooseButton.textContent = project ? 'Choose another project' : 'Choose project';
  if (!project) {
    projectId.textContent = 'Not loaded';
    revisionLabel.textContent = '—';
    assetCount.textContent = '—';
    projectInstructions.value = '';
    guideStep = 'position';
    referenceView = 'diagram';
    referenceNotice = '';
    referenceAsset = null;
    updateConfirmationState();
    renderSelectorOptions();
    populatePlacementForm();
    refreshLockedRatio();
    renderCanvas();
    renderReview();
    renderGuideStep();
    renderContextLine();
    renderLogoThumb();
    updateUnsavedWarning();
    void updateReferenceForSelection();
    void refreshShowcase();
    updateButtons();
    return;
  }
  const configuration = selectedConfiguration(project);
  activeConfigurationId = configuration?.id ?? '';
  projectId.textContent = project.projectId;
  revisionLabel.textContent = String(project.revision);
  assetCount.textContent = String(loaded!.assets.length);
  projectInstructions.value = project.instructions ?? '';
  renderSelectorOptions();
  populatePlacementForm();
  refreshLockedRatio();
  renderCanvas();
  renderReview();
  renderGuideStep();
  renderContextLine();
  renderLogoThumb();
  updateUnsavedWarning();
  void updateReferenceForSelection();
  void refreshShowcase();
  updateConfirmationState();
  updateButtons();
}

function takeUndoSnapshot(project: ProjectDocument): void {
  undoHistory.push(cloneProject(project));
  if (undoHistory.length > 50) undoHistory.shift();
}

function installMutation(next: ProjectDocument, success: string, recordUndo = true): void {
  if (!loaded) return;
  if (next === loaded.project) {
    placementFormDirty = false;
    projectInstructionsDirty = false;
    renderAll();
    setStatus('Nothing changed, so no new version was made.');
    return;
  }
  try {
    assertProjectEditorLimits(next);
    geometryFor(next);
  } catch (error) {
    setStatus(`That change was rejected: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (recordUndo) takeUndoSnapshot(loaded.project);
  loaded = { ...loaded, project: next };
  placementFormDirty = false;
  projectInstructionsDirty = false;
  stateGeneration += 1;
  confirmationFresh = false;
  selectedPlacementIndex = selectedConfiguration(next)?.placements.length
    ? Math.min(selectedPlacementIndex ?? 0, selectedConfiguration(next)!.placements.length - 1)
    : null;
  renderAll();
  setStatus(success);
}

function formPlacement(): Omit<Placement, 'id'> {
  const region = regionForSelection();
  const logoId = logoSelect.value;
  if (!region || !logoId) throw new Error('Choose a product, variant, logo area, and logo above before placing a logo.');
  const rotationDeg = readNumeric(rotationInput, 'Turn');
  if (!(rotationDeg > -180 && rotationDeg <= 180)) throw new Error('Turn must be more than −180° and at most 180°.');
  return {
    logoId,
    regionId: region.id,
    method: methodSelect.value,
    pos: { xMm: readNumeric(xInput, 'Center X'), yMm: readNumeric(yInput, 'Center Y') },
    widthMm: readNumeric(widthInput, 'Width'),
    heightMm: readNumeric(heightInput, 'Height'),
    rotationDeg,
    ...(placementInstructions.value.length ? { instructions: placementInstructions.value } : {}),
  };
}

function applyPendingEdits(): void {
  if (!loaded) return;
  const project = loaded.project;
  const configuration = selectedConfiguration(project);
  const placement = currentPlacement();
  if (placementFormDirty && (!configuration || selectedPlacementIndex === null || !placement)) {
    setStatus('Pick a placed logo below (or add your numbers as a new logo) before applying.');
    return;
  }
  try {
    const placementValues = placementFormDirty ? formPlacement() : undefined;
    const nextInstructions = project.instructions !== undefined || projectInstructions.value.length > 0
      ? (projectInstructions.value.length ? projectInstructions.value : undefined)
      : undefined;
    const placementChanged = placementValues !== undefined && placement !== undefined && (
      placement.logoId !== placementValues.logoId ||
      placement.regionId !== placementValues.regionId ||
      placement.method !== placementValues.method ||
      placement.pos.xMm !== placementValues.pos.xMm ||
      placement.pos.yMm !== placementValues.pos.yMm ||
      placement.widthMm !== placementValues.widthMm ||
      placement.heightMm !== placementValues.heightMm ||
      placement.rotationDeg !== placementValues.rotationDeg ||
      (placement.instructions ?? '') !== (placementValues.instructions ?? '')
    );
    const instructionsChanged = projectInstructionsDirty && project.instructions !== nextInstructions;
    if (!placementChanged && !instructionsChanged) {
      placementFormDirty = false;
      projectInstructionsDirty = false;
      renderAll();
      setStatus('Nothing changed, so no new version was made.');
      return;
    }
    const configurationId = configuration?.id;
    const placementIndex = selectedPlacementIndex;
    const next = newRevision(project, (draft) => {
      if (placementChanged && placementValues && configurationId && placementIndex !== null) {
        const draftConfiguration = draft.configurations.find((item) => item.id === configurationId);
        const existing = draftConfiguration?.placements[placementIndex];
        if (!draftConfiguration || !existing) throw new Error('Selected placement changed before its edits could be applied.');
        const replacement: Placement = {
          ...placementValues,
          ...(existing.id === undefined ? {} : { id: existing.id }),
        };
        draftConfiguration.placements[placementIndex] = replacement;
      }
      if (instructionsChanged) {
        if (nextInstructions === undefined) delete draft.instructions;
        else draft.instructions = nextInstructions;
      }
    });
    installMutation(next, `Applied your changes as version ${next.revision}.`);
  } catch (error) {
    setStatus(`Could not save your changes: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function uniqueId(prefix: string): string {
  const project = loaded?.project;
  const existing = new Set<string>([
    ...(project?.configurations.flatMap((configuration) => configuration.placements.map((placement) => placement.id).filter((id): id is string => id !== undefined)) ?? []),
    ...(project?.configurations.map((configuration) => configuration.id) ?? []),
  ]);
  let id = '';
  do { generatedId += 1; id = `${prefix}-${generatedId}`; } while (existing.has(id));
  return id;
}

function currentSnapshot(): { project: ProjectDocument; generation: number; revision: number } | null {
  const project = loaded?.project;
  if (!project) return null;
  return { project, generation: stateGeneration, revision: project.revision };
}

function snapshotIsCurrent(snapshot: { project: ProjectDocument; generation: number; revision: number }): boolean {
  return loaded?.project === snapshot.project && stateGeneration === snapshot.generation && loaded.project.revision === snapshot.revision;
}

async function checkImportedConfirmation(snapshot: { project: ProjectDocument; generation: number; revision: number }): Promise<void> {
  const confirmation = snapshot.project.confirmation;
  if (!confirmation) {
    confirmationFresh = false;
    updateConfirmationState();
    updateButtons();
    return;
  }
  try {
    const digest = await hasher.prepareProject(snapshot.project);
    if (!snapshotIsCurrent(snapshot)) return;
    confirmationFresh = confirmation.revision === snapshot.revision && confirmation.digest === digest;
    if (!confirmationFresh) {
      confirmationSummary.textContent = `The recorded confirmation is for older version ${confirmation.revision} and does not match this version ${snapshot.revision}. Check the sizes above, then confirm again.`;
    } else {
      updateConfirmationState();
    }
  } catch (error) {
    if (!snapshotIsCurrent(snapshot)) return;
    confirmationFresh = false;
    confirmationSummary.textContent = `Confirmation could not be checked: ${error instanceof Error ? error.message : String(error)}`;
  }
  updateButtons();
}

function refreshCurrentConfirmation(): void {
  const snapshot = currentSnapshot();
  if (snapshot?.project.confirmation) void checkImportedConfirmation(snapshot);
}

async function loadProjectSource(
  source: { name: string; size: number; read: () => Promise<Uint8Array> },
): Promise<void> {
  const fileName = source.name;
  const generation = ++loadGeneration;
  stateGeneration += 1;
  cancelDrag('Moving stopped because opening a file started. Your saved logo is unchanged.');
  if (source.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    loading = false;
    updateButtons();
    setStatus(`Archive size (${source.size} bytes) exceeds the ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes}-byte limit. The currently loaded project is unchanged.`);
    refreshCurrentConfirmation();
    return;
  }
  loading = true;
  updateButtons();
  setStatus(`Opening ${fileName}… What you already have stays on screen until the new file checks out.`);
  const loadToken = stateGeneration;
  try {
    const bytes = await source.read();
    if (generation !== loadGeneration || loadToken !== stateGeneration) return;
    const parsed = await parseProjectPackage(bytes, { sha256: hasher.sha256Bytes });
    if (generation !== loadGeneration || loadToken !== stateGeneration) return;
    assertProjectEditorLimits(parsed.project);
    geometryFor(parsed.project);
    const manifestBytes = parsed.assets.find((entry) => entry.path === PRESENTATION_MANIFEST_PATH && entry.kind === 'additional')?.bytes;
    const candidate: EditorPackage = { project: parsed.project, assets: parsed.assets, presentationManifest: parsePresentationManifest(manifestBytes), presentationManifestPresent: manifestBytes !== undefined };
    loaded = candidate;
    placementFormKey = '';
    preferredReferenceOnLoad = true;
    referenceBytes = undefined;
    placementFormDirty = false;
    projectInstructionsDirty = false;
    baseline = cloneProject(parsed.project);
    undoHistory = [];
    activeConfigurationId = parsed.project.configurations[0]?.id ?? '';
    selectedPlacementIndex = parsed.project.configurations[0]?.placements.length ? 0 : null;
    const firstConfiguration = parsed.project.configurations[0];
    const firstProduct = firstConfiguration && productForConfiguration(parsed.project, firstConfiguration);
    selectedRegionId = selectedPlacementIndex !== null
      ? firstConfiguration?.placements[0]?.regionId ?? ''
      : firstProduct?.variants.find((variant) => variant.id === firstConfiguration?.variantId)?.regionIds[0] ?? '';
    selectedLogoId = selectedPlacementIndex !== null
      ? firstConfiguration?.placements[0]?.logoId ?? ''
      : parsed.project.logos[0]?.id ?? '';
    loading = false;
    stateGeneration += 1;
    confirmationFresh = false;
    const variant = firstProduct?.variants.find((item) => item.id === firstConfiguration?.variantId);
    guideStep = selectedPlacementIndex !== null && variant?.regionIds.length === 1 ? 'size' : 'position';
    renderAll();
    setStatus(`Opened ${fileName}. The file passed its checks.`);
    const snapshot = currentSnapshot();
    if (snapshot) void checkImportedConfirmation(snapshot);
  } catch (error) {
    if (generation !== loadGeneration || loadToken !== stateGeneration) return;
    loading = false;
    updateButtons();
    const detail = error instanceof Error ? error.message : String(error);
    setStatus(`Could not load ${fileName}. The previously loaded project remains unchanged. ${detail}`);
    refreshCurrentConfirmation();
  }
}

async function loadFiles(files: readonly File[]): Promise<void> {
  if (files.length !== 1) {
    loadGeneration += 1;
    stateGeneration += 1;
    cancelDrag('Moving stopped because opening a file started. Your saved logo is unchanged.');
    loading = false;
    updateButtons();
    setStatus('Open exactly one .logo-project file. What you already have is unchanged.');
    refreshCurrentConfirmation();
    return;
  }
  const file = files[0];
  if (!file) return;
  await loadProjectSource({
    name: file.name,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  });
}

async function savePackage(submit = false): Promise<void> {
  const snapshot = currentSnapshot();
  const projectPackage = loaded;
  if (!snapshot || !projectPackage || loading || saving || confirming) return;
  if (submit && drag) {
    setStatus('Wait until the logo you are dragging is placed or cancelled, then try again.');
    return;
  }
  if (placementFormDirty || projectInstructionsDirty) {
    setStatus('Press “Apply my changes” first, so nothing unsaved is left out of the file.');
    return;
  }
  if (submit && (!confirmationFresh || !projectPackage.project.confirmation || !isGeometryValid(snapshot.project))) {
    setStatus('Before the confirmed return file: confirm the exact version above, and make sure every logo fits inside its logo area.');
    return;
  }
  if (!validateProject(snapshot.project).ok) {
    setStatus('This file has a problem and cannot be saved yet.');
    return;
  }
  saving = true;
  updateButtons();
  setStatus(submit ? 'Getting your confirmed return file ready to download…' : 'Getting your draft file ready to download…');
  try {
    const references = projectPackage.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes }));
    const additional = projectPackage.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes }));
    const bytes = await createProjectPackage({ project: snapshot.project, assets: references, additionalAssets: additional }, { sha256: hasher.sha256Bytes });
    if (!snapshotIsCurrent(snapshot) || loaded !== projectPackage) {
      setStatus('Saving stopped because something changed while the file was being made.');
      return;
    }
    if (submit && (!confirmationFresh || !snapshot.project.confirmation || !isGeometryValid(snapshot.project))) {
      setStatus('Saving stopped because the confirmation or logo fit is no longer up to date.');
      return;
    }
    const objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = submit ? 'customer-confirmed-return.logo-project' : 'customer-draft.logo-project';
    link.style.display = 'none';
    root.append(link);
    link.click();
    link.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    setStatus(submit ? 'Saved your confirmed return file. Now send it back yourself as an email attachment — nothing was sent automatically.' : 'Saved your draft file. Nothing was sent anywhere.');
  } catch (error) {
    if (snapshotIsCurrent(snapshot)) setStatus(`Could not make the file: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    saving = false;
    updateButtons();
  }
}

async function confirmCurrentRevision(): Promise<void> {
  const snapshot = currentSnapshot();
  const projectPackage = loaded;
  const confirmedBy = confirmedByInput.value.trim();
  if (drag) {
    setStatus('Wait until the logo you are dragging is placed or cancelled, then confirm.');
    return;
  }
  if (!snapshot || !projectPackage || !confirmedBy || loading || confirming || saving) return;
  if (placementFormDirty || projectInstructionsDirty) {
    setStatus('Press “Apply my changes” first, then confirm.');
    return;
  }
  if (!validateProject(snapshot.project).ok) {
    setStatus('This file has a problem and cannot be confirmed yet.');
    return;
  }
  if (!isGeometryValid(snapshot.project)) {
    setStatus('At least one logo does not fit inside its logo area. Move or resize it first — you can still save a draft.');
    return;
  }
  confirming = true;
  confirmationFresh = false;
  updateButtons();
  updateConfirmationState();
  setStatus(`Checking the exact contents of version ${snapshot.revision}…`);
  try {
    const digest = await hasher.prepareProject(snapshot.project);
    if (!snapshotIsCurrent(snapshot) || loaded !== projectPackage || confirmedByInput.value.trim() !== confirmedBy) {
      setStatus('Confirmation stopped because something changed while checking. Look over the sizes again, then confirm.');
      return;
    }
    const confirmCandidate = cloneProject(snapshot.project);
    const result = confirmRevision(confirmCandidate, { confirmedBy, digestOf: digest }, hasher.sha256Hex);
    if (!result.ok) {
      setStatus(`Could not record your confirmation: ${result.errors.map((entry) => entry.message).join('; ')}`);
      return;
    }
    loaded = { ...projectPackage, project: result.project };
    stateGeneration += 1;
    confirmationFresh = true;
    renderAll();
    setStatus(`Confirmed version ${result.project.revision} — exactly as reviewed above. This is your record, not Logo Station approval.`);
  } catch (error) {
    if (snapshotIsCurrent(snapshot)) setStatus(`Could not record your confirmation: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    confirming = false;
    updateButtons();
  }
}

function contextChanged(): void {
  if (placementFormDirty || projectInstructionsDirty) setStatus('You typed something that was not applied yet — it was discarded because you switched to something else.');
  placementFormDirty = false;
  projectInstructionsDirty = false;
  invalidateUiContext();
  refreshCurrentConfirmation();
}

function chooseProductOrVariant(productId: string, variantId: string): void {
  const project = loaded?.project;
  if (!project) return;
  const existing = project.configurations.find((configuration) => configuration.productId === productId && configuration.variantId === variantId);
  if (existing) {
    activeConfigurationId = existing.id;
    selectedPlacementIndex = existing.placements.length ? 0 : null;
    const product = productForConfiguration(project, existing);
    selectedRegionId = existing.placements[0]?.regionId ?? product?.variants.find((variant) => variant.id === variantId)?.regionIds[0] ?? '';
    selectedLogoId = existing.placements[0]?.logoId ?? project.logos[0]?.id ?? '';
    renderAll();
    return;
  }
  const configId = uniqueId('CUSTOM-CFG');
  const next = newRevision(project, (draft) => {
    draft.configurations.push({ id: configId, productId, variantId, placements: [] });
  });
  activeConfigurationId = configId;
  selectedPlacementIndex = null;
  const product = productForConfiguration(next, next.configurations.find((item) => item.id === configId)!);
  selectedRegionId = product?.variants.find((variant) => variant.id === variantId)?.regionIds[0] ?? '';
  selectedLogoId = next.logos[0]?.id ?? '';
  installMutation(next, `Added an empty ${productId} / ${variantId} product set as version ${next.revision}.`);
}

function setSelectedPlacement(index: number | null): void {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  const placement = index !== null ? configuration?.placements[index] : undefined;
  selectedPlacementIndex = index;
  if (placement) {
    selectedRegionId = placement.regionId;
    selectedLogoId = placement.logoId;
  }
  renderAll();
}

function renderDragPreview(current: DragState): void {
  const configuration = current.project.configurations.find((entry) => entry.id === current.configurationId);
  const placement = configuration?.placements[current.placementIndex];
  const product = configuration && productForConfiguration(current.project, configuration);
  const region = product?.regions.find((item) => item.id === placement?.regionId);
  const polygon = canvasLayer.querySelector<SVGPolygonElement>(`.footprint[data-placement-index="${current.placementIndex}"]`);
  if (!placement || !region || !polygon) return;
  const label = canvasLayer.querySelector<SVGTextElement>(`.footprint-label[data-placement-index="${current.placementIndex}"]`);
  if (Math.abs(current.previewX) > PROJECT_EDITOR_LIMITS.maxCoordinateMm || Math.abs(current.previewY) > PROJECT_EDITOR_LIMITS.maxCoordinateMm) {
    polygon.classList.add('invalid');
    setGeometry(`Too far out — past the ±${PROJECT_EDITOR_LIMITS.maxCoordinateMm} mm edge. Letting go here will not save it.`, false);
    return;
  }
  try {
    const candidate = { ...placement, pos: { xMm: current.previewX, yMm: current.previewY } };
    const verdict = evaluatePlacementGeometry(region, candidate);
    polygon.setAttribute('points', verdict.footprint.map(([x, y]) => `${x},${-y}`).join(' '));
    polygon.classList.toggle('invalid', !verdict.ok);
    if (label) { label.setAttribute('x', String(current.previewX)); label.setAttribute('y', String(-current.previewY)); }
    xInput.value = String(current.previewX);
    yInput.value = String(current.previewY);
    setGeometry(`Moving… fits: ${verdict.ok ? 'yes' : 'no'}; ${verdict.reason}. Let go to save this spot as a new version; press Escape to drop it.`, verdict.ok);
  } catch (error) {
    polygon.classList.add('invalid');
    setGeometry(`That spot was rejected: ${error instanceof Error ? error.message : String(error)}`, false);
  }
}

function canvasPoint(event: PointerEvent, screenToRegion: DOMMatrix | null = canvas.getScreenCTM()?.inverse() ?? null): { x: number; y: number } | null {
  if (!screenToRegion) return null;
  const point = canvas.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(screenToRegion);
  return { x: local.x, y: -local.y };
}

function beginDrag(event: PointerEvent, placementIndex: number): void {
  if (!event.isPrimary || event.button !== 0 || !loaded || loading || saving || confirming || drag || placementFormDirty || projectInstructionsDirty) return;
  const configuration = selectedConfiguration();
  const placement = configuration?.placements[placementIndex];
  const screenToRegion = canvas.getScreenCTM()?.inverse() ?? null;
  if (!configuration || !placement || !screenToRegion) return;
  const point = canvasPoint(event, screenToRegion);
  if (!point) return;
  invalidateUiContext();
  refreshCurrentConfirmation();
  selectedPlacementIndex = placementIndex;
  selectedRegionId = placement.regionId;
  selectedLogoId = placement.logoId;
  drag = {
    pointerId: event.pointerId,
    configurationId: configuration.id,
    placementIndex,
    project: loaded.project,
    generation: stateGeneration,
    screenToRegion,
    grabOffsetX: placement.pos.xMm - point.x,
    grabOffsetY: placement.pos.yMm - point.y,
    previewX: placement.pos.xMm,
    previewY: placement.pos.yMm,
  };
  try { canvas.setPointerCapture(event.pointerId); }
  catch {
    drag = null;
    renderAll();
    setStatus('Drag could not start because pointer capture was unavailable.');
    return;
  }
  event.preventDefault();
  renderAll();
}

function cancelDrag(message: string): void {
  if (!drag) return;
  const pointerId = drag.pointerId;
  drag = null;
  if (canvas.hasPointerCapture(pointerId)) {
    try { canvas.releasePointerCapture(pointerId); } catch { /* lost capture is already a cancellation */ }
  }
  if (loaded) renderAll();
  setStatus(message);
}

function moveDrag(event: PointerEvent): void {
  const current = drag;
  if (!current || current.pointerId !== event.pointerId) return;
  const point = canvasPoint(event, current.screenToRegion);
  if (!point) return;
  const xMm = point.x + current.grabOffsetX;
  const yMm = point.y + current.grabOffsetY;
  if (Math.abs(xMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm || Math.abs(yMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm) {
    setGeometry(`Drag preview exceeds the ±${PROJECT_EDITOR_LIMITS.maxCoordinateMm} mm runtime geometry bound.`, false);
    event.preventDefault();
    return;
  }
  current.previewX = xMm;
  current.previewY = yMm;
  renderDragPreview(current);
  event.preventDefault();
}

function finishDrag(event: PointerEvent, commit: boolean): void {
  const current = drag;
  if (!current || current.pointerId !== event.pointerId) return;
  drag = null;
  if (canvas.hasPointerCapture(current.pointerId)) {
    try { canvas.releasePointerCapture(current.pointerId); } catch { /* pointer capture can already be gone */ }
  }
  if (!commit || !event.isPrimary || event.button !== 0 || loaded?.project !== current.project || stateGeneration !== current.generation) {
    if (loaded) renderAll();
    if (!commit || !event.isPrimary || event.button !== 0) setStatus('Move cancelled. Your saved logo stays where it was.');
    return;
  }
  const endpoint = canvasPoint(event, current.screenToRegion);
  if (!endpoint) {
    renderAll();
    setStatus('Move cancelled — that spot could not be read. Your saved logo stays where it was.');
    return;
  }
  const xMm = endpoint.x + current.grabOffsetX;
  const yMm = endpoint.y + current.grabOffsetY;
  if (Math.abs(xMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm || Math.abs(yMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm) {
    renderAll();
    setStatus(`That spot is past the ±${PROJECT_EDITOR_LIMITS.maxCoordinateMm} mm edge, so it was not saved.`);
    return;
  }
  const configuration = current.project.configurations.find((item) => item.id === current.configurationId);
  const placement = configuration?.placements[current.placementIndex];
  if (!configuration || !placement) return;
  const selector = placementSelector(placement, current.placementIndex);
  try {
    const next = updatePlacement(current.project, current.configurationId, selector, { pos: { xMm, yMm } });
    installMutation(next, `Moved the logo — saved as version ${next.revision}. All sizes stay in millimetres.`);
  } catch (error) {
    renderAll();
    setStatus(`Could not move the logo there: ${error instanceof Error ? error.message : String(error)}`);
  }
}

chooseButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  fileInput.value = '';
  if (files.length) void loadFiles(files);
});
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
});
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('is-dragging'); });
dropzone.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget || !dropzone.contains(event.relatedTarget as Node)) dropzone.classList.remove('is-dragging');
});
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('is-dragging');
  const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
  if (files.length) void loadFiles(files);
});

configurationSelect.addEventListener('change', () => {
  contextChanged();
  activeConfigurationId = configurationSelect.value;
  const configuration = selectedConfiguration();
  selectedPlacementIndex = configuration?.placements.length ? 0 : null;
  selectedRegionId = currentPlacement()?.regionId ?? '';
  selectedLogoId = currentPlacement()?.logoId ?? loaded?.project.logos[0]?.id ?? '';
  renderAll();
});
productSelect.addEventListener('change', () => {
  contextChanged();
  const product = loaded?.project.products.find((item) => item.id === productSelect.value);
  const variant = product?.variants[0];
  if (product && variant) chooseProductOrVariant(product.id, variant.id);
});
variantSelect.addEventListener('change', () => {
  contextChanged();
  const configuration = selectedConfiguration();
  if (configuration) chooseProductOrVariant(configuration.productId, variantSelect.value);
});
regionSelect.addEventListener('change', () => {
  cancelDrag('Move cancelled because the logo area changed.');
  selectedRegionId = regionSelect.value;
  const methods = regionForSelection()?.allowedMethods ?? [];
  const method = methods.includes(methodSelect.value) ? methodSelect.value : methods[0] ?? '';
  replaceOptions(methodSelect, methods.map((value) => ({ value, label: value })), method);
  placementFormDirty = currentPlacement() !== undefined;
  stateGeneration += 1;
  renderCanvas(); renderContextLine(); updateUnsavedWarning(); updateButtons();
});
logoSelect.addEventListener('change', () => {
  // Switching logos never loses applied edits: block the switch while
  // edits are pending and point at the apply action instead.
  if (placementFormDirty || projectInstructionsDirty) {
    logoSelect.value = selectedLogoId;
    updateUnsavedWarning();
    setStatus(UNSAVED_STEP_MESSAGE);
    updateButtons();
    return;
  }
  contextChanged();
  selectedLogoId = logoSelect.value;
  renderAll();
});
placementSelect.addEventListener('change', () => {
  contextChanged();
  setSelectedPlacement(placementSelect.value === '' ? null : Number(placementSelect.value));
});

for (const control of [xInput, yInput, widthInput, heightInput, rotationInput, placementInstructions, projectInstructions, methodSelect, confirmedByInput]) {
  const markFormChanged = (): void => {
    const value = control.value;
    if (drag) {
      cancelDrag('Moving stopped because you typed below. Your saved logo is unchanged.');
      control.value = value;
    }
    if (control === projectInstructions) {
      projectInstructionsDirty = true;
      setStatus('You changed the project notes — press “Apply my changes” to save them into a new version.');
    } else if (control !== confirmedByInput) {
      placementFormDirty = true;
      setStatus('You changed numbers below — press “Apply my changes” to save them into a new version.');
    }
    stateGeneration += 1;
    updateUnsavedWarning();
    updateButtons();
    const snapshot = currentSnapshot();
    if (snapshot?.project.confirmation) void checkImportedConfirmation(snapshot);
  };
  control.addEventListener('input', markFormChanged);
  control.addEventListener('change', markFormChanged);
}
widthInput.addEventListener('input', () => {
  if (!ratioLock?.checked || lockedRatio === null) return;
  const width = Number(widthInput.value);
  if (!Number.isFinite(width) || width <= 0) return;
  heightInput.value = String(width / lockedRatio);
  placementFormDirty = true;
  updateUnsavedWarning();
});
heightInput.addEventListener('input', () => {
  // Typing a height keeps independent width/height: unlock so the typed
  // value sticks instead of being mirrored back.
  if (ratioLock?.checked) ratioLock.checked = false;
  lockedRatio = null;
});
ratioLock?.addEventListener('change', () => {
  if (ratioLock.checked) refreshLockedRatio();
  else lockedRatio = null;
});

addButton.addEventListener('click', () => {
  if (!loaded) return;
  try {
    const configuration = selectedConfiguration();
    if (!configuration) throw new Error('Pick a product set first.');
    const placement: Placement = { id: uniqueId('CUSTOM-PLACEMENT'), ...formPlacement() };
    let next: ProjectDocument;
    if (projectInstructionsDirty) {
      const instructions = projectInstructions.value.length ? projectInstructions.value : undefined;
      next = newRevision(loaded.project, (draft) => {
        draft.configurations.find((item) => item.id === configuration.id)!.placements.push(placement);
        if (instructions === undefined) delete draft.instructions;
        else draft.instructions = instructions;
      });
    } else {
      next = addPlacement(loaded.project, configuration.id, placement);
    }
    assertProjectEditorLimits(next);
    geometryFor(next);
    selectedPlacementIndex = next.configurations.find((item) => item.id === configuration.id)!.placements.length - 1;
    installMutation(next, `Added the logo as version ${next.revision}. Fit is shown separately below.`);
  } catch (error) { setStatus(`Could not add the logo: ${error instanceof Error ? error.message : String(error)}`); }
});
updateButton.addEventListener('click', applyPendingEdits);
removeButton.addEventListener('click', () => {
  if (!loaded || selectedPlacementIndex === null || placementFormDirty || projectInstructionsDirty) return;
  const configuration = selectedConfiguration();
  const placement = currentPlacement();
  if (!configuration || !placement) return;
  const selector = placementSelector(placement, selectedPlacementIndex);
  try {
    const next = removePlacement(loaded.project, configuration.id, selector);
    selectedPlacementIndex = configuration.placements.length > 1 ? Math.min(selectedPlacementIndex, configuration.placements.length - 2) : null;
    installMutation(next, `Removed the logo as version ${next.revision}.`);
  } catch (error) { setStatus(`Could not remove the logo: ${error instanceof Error ? error.message : String(error)}`); }
});
undoButton.addEventListener('click', () => {
  if (!loaded || undoHistory.length === 0) return;
  const previous = undoHistory.pop()!;
  try {
    const next = newRevision(loaded.project, (draft) => {
      draft.products = cloneProject(previous).products;
      draft.logos = cloneProject(previous).logos;
      draft.configurations = cloneProject(previous).configurations;
      if (previous.instructions === undefined) delete draft.instructions; else draft.instructions = previous.instructions;
    });
    installMutation(next, `Undid the last change as new version ${next.revision}; anything confirmed before no longer counts.`, false);
  } catch (error) { undoHistory.push(previous); setStatus(`Could not undo: ${error instanceof Error ? error.message : String(error)}`); }
});
resetButton.addEventListener('click', () => {
  if (!loaded || !baseline) return;
  if (
    JSON.stringify(loaded.project.products) === JSON.stringify(baseline.products) &&
    JSON.stringify(loaded.project.logos) === JSON.stringify(baseline.logos) &&
    JSON.stringify(loaded.project.configurations) === JSON.stringify(baseline.configurations) &&
    loaded.project.instructions === baseline.instructions
  ) {
    placementFormDirty = false;
    projectInstructionsDirty = false;
    renderAll();
    setStatus('Already the same as the opened file — no new version was made.');
    return;
  }
  try {
    const original = baseline;
    const next = newRevision(loaded.project, (draft) => {
      draft.products = cloneProject(original).products;
      draft.logos = cloneProject(original).logos;
      draft.configurations = cloneProject(original).configurations;
      if (original.instructions === undefined) delete draft.instructions; else draft.instructions = original.instructions;
    });
    installMutation(next, `Started over from the opened file as new version ${next.revision}; anything confirmed before no longer counts.`);
  } catch (error) { setStatus(`Could not start over: ${error instanceof Error ? error.message : String(error)}`); }
});
confirmButton.addEventListener('click', () => void confirmCurrentRevision());
saveButton.addEventListener('click', () => void savePackage(false));
submitButton.addEventListener('click', () => void savePackage(true));
saveDraftTop?.addEventListener('click', () => void savePackage(false));
stepPositionButton?.addEventListener('click', () => requestStep('position'));
stepSizeButton?.addEventListener('click', () => requestStep('size'));
stepReviewButton?.addEventListener('click', () => requestStep('review'));
backStep?.addEventListener('click', () => requestStep(stepNeighbor(guideStep, -1)));
primaryNext?.addEventListener('click', () => {
  if (!loaded || loading || saving || confirming || drag) return;
  if (hasUnsavedEdits() && currentPlacement()) {
    applyPendingEdits();
    if (hasUnsavedEdits()) return;
  }
  if (guideStep === 'size' && !currentPlacement()) {
    addButton.click();
    if (!currentPlacement()) return;
  }
  requestStep(stepNeighbor(guideStep, 1));
});
addAnotherButton?.addEventListener('click', () => {
  if (!loaded || loading || saving || confirming || drag) return;
  if (hasUnsavedEdits()) { applyPendingEdits(); if (hasUnsavedEdits()) return; }
  selectedPlacementIndex = null;
  guideStep = 'position';
  renderAll();
  const choices = optionalHook<HTMLDetailsElement>('job-choices');
  if (choices && logoSelect.options.length > 1) choices.open = true;
});
viewReferenceButton?.addEventListener('click', () => {
  if (!referenceAsset) return;
  cancelDrag('Move cancelled because the view changed. Your saved logo is unchanged.');
  referenceView = 'reference';
  renderReferenceView();
});
viewDiagramButton?.addEventListener('click', () => {
  cancelDrag('Move cancelled because the view changed. Your saved logo is unchanged.');
  referenceView = 'diagram';
  renderReferenceView();
});
for (const mode of ['flat', '2d', '3d'] as const) {
  document.querySelector<HTMLButtonElement>(`[data-customer-hook="views-mode-${mode}"]`)?.addEventListener('click', () => chooseShowcaseMode(mode));
}
for (const side of VIEWS_SIDES) {
  document.querySelector<HTMLButtonElement>(`[data-customer-hook="views-side-${side}"]`)?.addEventListener('click', () => chooseShowcaseSide(side));
}


canvas.addEventListener('pointermove', moveDrag);
canvas.addEventListener('pointerup', (event) => finishDrag(event, true));
canvas.addEventListener('pointercancel', (event) => finishDrag(event, false));
canvas.addEventListener('lostpointercapture', (event) => finishDrag(event as PointerEvent, false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drag) { event.preventDefault(); cancelDrag('Move cancelled with Escape. Your saved logo is unchanged.'); }
});
window.addEventListener('blur', () => cancelDrag('Move cancelled because the window lost focus. Your saved logo is unchanged.'));

renderAll();
updateButtons();

runCustomerSelfContainedBootstrap((bytes, fileName) => loadProjectSource({
  name: fileName, size: bytes.length, read: async () => bytes,
}));
