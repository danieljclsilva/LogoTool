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
  selectPresentationViews,
} from './presentation-assets.js';
import type { PresentationManifest } from './presentation-assets.js';
import {
  forwardPhotoMapping,
  inversePhotoMapping,
  parsePhotoMappings,
  PHOTO_MAPPINGS_PATH,
  artworkPhotoMatrix,
  selectPhotoMapping,
  validateMappingContext,
} from './presentation-photo-mapping.js';
import type { PhotoMappingContext, PhotoMappingEntry, PhotoMappingsV1, PhotoMappingView } from './presentation-photo-mapping.js';
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
// ---- Single placement workspace (edit) + combined review ----
// Position, artwork, width and precise coordinates live together in one
// editable workspace per selected placement; there is no compulsory
// Position -> Size -> Review traversal per logo. Review is the separate
// combined proof/confirmation step.
type GuideStep = 'edit' | 'review';
const STEP_ORDER: GuideStep[] = ['edit', 'review'];
let guideStep: GuideStep = 'edit';

const optionalHook = <T extends Element>(name: string): T | null =>
  document.querySelector<T>(`[data-customer-hook="${name}"]`);
const brandMark = optionalHook<HTMLImageElement>('brand-mark');
const saveDraftTop = optionalHook<HTMLButtonElement>('save-draft-top');
const stepNav = optionalHook<HTMLElement>('step-nav');
const stepEditButton = optionalHook<HTMLButtonElement>('step-edit');
const stepReviewButton = optionalHook<HTMLButtonElement>('step-review');
const taskRail = optionalHook<HTMLElement>('task-rail');
const canvasPane = optionalHook<HTMLElement>('canvas-pane');
const contextLine = optionalHook<HTMLElement>('context-line');
const logoThumb = optionalHook<HTMLImageElement>('logo-thumb');
// Single primary canvas: one active mode (Photo/Diagram/3D) drives the canvas
// pane. The second independent views-showcase viewer below stays hidden;
// all mapped state is rendered in the primary canvas only.
const modePhotoButton = hook<HTMLButtonElement>('mode-photo');
const modeDiagramButton = hook<HTMLButtonElement>('mode-diagram');
const mode3dButton = hook<HTMLButtonElement>('mode-3d');
const sideButtons = {
  front: hook<HTMLButtonElement>('side-front'),
  back: hook<HTMLButtonElement>('side-back'),
  left: hook<HTMLButtonElement>('side-left'),
  right: hook<HTMLButtonElement>('side-right'),
} as const;
const photoWrap = hook<HTMLElement>('photo-wrap');
const photoOverlay = hook<SVGSVGElement>('photo-overlay');
const mappingStatus = hook<HTMLElement>('mapping-status');
const mode3dPane = hook<HTMLElement>('mode-3d-pane');
const modelAvailability = hook<HTMLElement>('model-availability');
// Single primary 3D pane controls: new hooks are looked up null-safely (never
// required()) so this file keeps working if the shell lags behind.
const mode3dWrap = optionalHook<HTMLElement>('mode-3d-wrap');
const mode3dZoomIn = optionalHook<HTMLButtonElement>('mode-3d-zoom-in');
const mode3dZoomOut = optionalHook<HTMLButtonElement>('mode-3d-zoom-out');
const mode3dReset = optionalHook<HTMLButtonElement>('mode-3d-reset');
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

function isNewPlacementOnlyDirt(): boolean {
  return placementFormDirty && !projectInstructionsDirty && !currentPlacement();
}

function guidedAddDirection(): string {
  // Names the actually visible commit action: the primary next button adds a
  // pending new placement (Review layout auto-adds), and Review returns via
  // the Edit tab. Never points at the collapsed More-actions Add button.
  if (guideStep === 'review') return 'go back to editing, then press “Review layout” to add the logo';
  return 'press “Review layout” to add the logo';
}

function unsavedStepMessage(): string {
  if (isNewPlacementOnlyDirt()) {
    const tail = guideStep === 'review' ? 'before saving' : 'before moving on';
    return `You have changes that are not added yet — ${guidedAddDirection()} ${tail}. (Switching the logo area above discards unsaved edits.)`;
  }
  return 'You have changes that are not applied yet — press “Apply my changes” to keep them before moving on. (Switching the logo area above discards unsaved edits.)';
}

function hasUnsavedEdits(): boolean {
  return placementFormDirty || projectInstructionsDirty;
}

function updateUnsavedWarning(): void {
  if (!unsavedWarning) return;
  if (loaded && hasUnsavedEdits()) {
    unsavedWarning.hidden = false;
    unsavedWarning.textContent = unsavedStepMessage();
  } else {
    unsavedWarning.hidden = true;
  }
}

function stepNeighbor(step: GuideStep, delta: 1 | -1): GuideStep {
  const next = STEP_ORDER[Math.min(STEP_ORDER.length - 1, Math.max(0, STEP_ORDER.indexOf(step) + delta))];
  return next ?? step;
}

function requestStep(target: GuideStep): void {
  if (!loaded || loading || saving || confirming || drag || photoDrag) return;
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
    ['edit', stepEditButton],
    ['review', stepReviewButton],
  ];
  for (const [name, button] of stepButtons) {
    if (!button) continue;
    if (name === guideStep) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  if (primaryNext) {
    primaryNext.hidden = guideStep === 'review';
    primaryNext.textContent = 'Review layout';
  }
  const panel = root.querySelector<HTMLElement>(`[data-step-panel="${guideStep}"]`);
  if (panel) panel.insertBefore(geometryStatus, panel.querySelector(':scope > details') ?? null);
  const heading = taskRail?.querySelector('h2') ?? null;
  if (heading) {
    heading.textContent = guideStep === 'edit'
      ? 'Place and size your logos'
      : 'Review and confirm';
  }
  const lede = taskRail?.querySelector('.lede') ?? null;
  if (lede) {
    lede.textContent = guideStep === 'edit'
      ? (currentPlacement() ? 'Choose where this logo goes and how big it is.' : 'Choose a logo, its position and size.')
      : 'Check every number, then confirm and save your return file.';
    if (guideStep === 'edit' && ratioLock && !ratioLock.checked) lede.textContent = 'Set the width. Height can be adjusted separately.';
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

// ---- Photo-mapping consumer (explicit region->side binding) ----
// Authority: ONLY photo-mapping entries (regionId -> view) and v2 view
// entries (image -> view). Never infer side from region IDs, labels,
// filenames, or photo order. Missing/legacy mapping -> truthful diagram
// fallback ("Reference only — editing uses measured diagram"), never a
// mislabelled photo. The measured diagram (exact domain millimetres) stays
// the source of truth; the photo is a mapped preview only.
// Rotation convention: domain rotationDeg is clockwise-positive facing the
// region (Y-up). SVG y is down, so SVG rotate(+θ) about the placement
// center reproduces exactly the validator footprint.
type PrimaryMode = 'photo' | 'diagram' | '3d';
let primaryMode: PrimaryMode = 'diagram';
interface ActivePhoto {
  entry: PhotoMappingEntry;
  imageBytes: Uint8Array;
}
let activePhoto: ActivePhoto | null = null;
let photoWarning: string | null = null;
let photoObjectUrl: string | null = null;
let photoObjectKey = '';
let photoGeneration = 0;
let photoNatural: { width: number; height: number } | null = null;
const artworkUrls = new Map<string, string>();

// Display rounding: one-decimal text (e.g. 108.1) for UI copy only. The
// canonical widthMm/heightMm/pos/rotationDeg values are never rounded; form
// fields keep exact values so re-renders lose no precision.
function formatMm(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return (Math.round(value * 10) / 10).toFixed(1);
}

function photoMappingsOfLoaded(): { mappings: PhotoMappingsV1 | null; present: boolean } {
  const bytes = loaded?.assets.find((entry) => entry.path === PHOTO_MAPPINGS_PATH && entry.kind === 'additional')?.bytes;
  return { mappings: parsePhotoMappings(bytes), present: bytes !== undefined };
}

/**
 * Current binding context for one region: the region's own calibration
 * reference plus the declared preview views for the configuration. Callers
 * refuse any mapping entry that disagrees (stale calibration, swapped or
 * relabelled photo) and fall back to the measured diagram.
 */
function mappingContextFor(regionId: string): PhotoMappingContext | null {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  const product = configuration && project?.products.find((item) => item.id === configuration.productId);
  const region = product?.regions.find((item) => item.id === regionId);
  const calibration = region?.calibrationRef;
  if (!loaded || !project || !configuration || !product || !region || !calibration) return null;
  const lookup = (path: string): Uint8Array | undefined =>
    loaded?.assets.find((entry) => entry.path === path)?.bytes;
  const manifestViews = selectPresentationViews(
    loaded.presentationManifest,
    loaded.presentationManifestPresent,
    configuration.productId,
    configuration.variantId,
    lookup,
  ).views.flatMap((view) => (view.view === null ? [] : [{ view: view.view, image: view.imagePath }]));
  return {
    productId: configuration.productId,
    variantId: configuration.variantId,
    regionId,
    calibrationId: calibration.calibrationId,
    calibrationVersion: calibration.version,
    manifestViews,
  };
}

function resolveActivePhoto(): void {
  activePhoto = null;
  photoWarning = null;
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  if (!loaded || !project || !configuration) return;
  const { mappings, present } = photoMappingsOfLoaded();
  if (!present) return; // legacy fallback: truthful diagram, no warning
  if (!mappings) {
    photoWarning = 'Photo mapping data was invalid and has been ignored.';
    return;
  }
  const lookup = (path: string): Uint8Array | undefined =>
    loaded?.assets.find((entry) => entry.path === path)?.bytes;
  const productId = configuration.productId;
  const variantId = configuration.variantId;
  const regionId = selectedRegionId;
  const context = mappingContextFor(regionId);
  if (!context) {
    // Region/product calibration refs are missing: no mapping can be current.
    photoWarning = 'No photo mapping supplied for this logo area — Reference only — editing uses measured diagram.';
    return;
  }
  // Exact-id candidates only: same product + region; variant-scoped first.
  const candidates = mappings.mappings
    .filter((entry) => entry.productId === productId && entry.regionId === regionId &&
      (entry.variantId === undefined || entry.variantId === variantId))
    .sort((left, right) => (left.variantId === undefined ? 1 : 0) - (right.variantId === undefined ? 1 : 0));
  for (const candidate of candidates) {
    // Full-key selection (product, variant, region, view, image): exact
    // match only, bytes validated by the mapping adapter. The caller's
    // context additionally enforces the region calibration reference and
    // the declared preview image/view binding; stale entries fall back.
    const selection = selectPhotoMapping(mappings, true, productId, variantId, regionId, candidate.view, candidate.image, lookup, context);
    if (selection.mapping) {
      const bytes = lookup(selection.mapping.image);
      if (bytes && bytes.length > 0) {
        activePhoto = { entry: selection.mapping, imageBytes: bytes };
        return;
      }
    }
    if (photoWarning === null) photoWarning = selection.warning;
  }
  if (photoWarning === null) photoWarning = 'No photo mapping supplied for this logo area — Reference only — editing uses measured diagram.';
}

function mappingEntriesForSelection(): PhotoMappingEntry[] {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  if (!loaded || !project || !configuration) return [];
  const { mappings } = photoMappingsOfLoaded();
  if (!mappings) return [];
  return mappings.mappings.filter((entry) => entry.productId === configuration.productId &&
    (entry.variantId === undefined || entry.variantId === configuration.variantId));
}

function mappedRegionForSide(side: PhotoMappingView): Region | undefined {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  const product = project && configuration && productForConfiguration(project, configuration);
  const variant = product?.variants.find((item) => item.id === configuration?.variantId);
  if (!project || !configuration || !product || !variant || !loaded) return undefined;
  const entries = mappingEntriesForSelection();
  const contexts = new Map<string, PhotoMappingContext | null>();
  for (const regionId of variant.regionIds) {
    const entry = entries.find((candidate) => candidate.regionId === regionId &&
      (candidate.variantId === undefined || candidate.variantId === configuration.variantId) &&
      candidate.view === side);
    if (!entry) continue;
    // Side availability needs a CURRENT binding: region calibration and
    // declared preview image/view must agree, or the side stays unavailable
    // (truthful fallback, never a mislabelled photo).
    let context = contexts.get(regionId);
    if (context === undefined) {
      context = mappingContextFor(regionId);
      contexts.set(regionId, context);
    }
    if (!context || validateMappingContext(entry, context).length > 0) continue;
    const bytes = loaded.assets.find((asset) => asset.path === entry.image)?.bytes;
    if (bytes && bytes.length > 0) return product.regions.find((region) => region.id === regionId);
  }
  return undefined;
}

function legacySidePresent(side: PhotoMappingView): boolean {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  if (!loaded || !project || !configuration) return false;
  const lookup = (path: string): Uint8Array | undefined =>
    loaded?.assets.find((entry) => entry.path === path)?.bytes;
  return selectPresentationViews(
    loaded.presentationManifest,
    loaded.presentationManifestPresent,
    configuration.productId,
    configuration.variantId,
    lookup,
  ).views.some((view) => view.view === side);
}

function revokePhotoUrl(): void {
  if (photoObjectUrl !== null) {
    try { URL.revokeObjectURL(photoObjectUrl); } catch { /* already gone */ }
    photoObjectUrl = null;
  }
  photoObjectKey = '';
}

function revokeArtworkUrls(): void {
  for (const url of artworkUrls.values()) {
    try { URL.revokeObjectURL(url); } catch { /* already gone */ }
  }
  artworkUrls.clear();
}

function artworkUrlForLogo(logoId: string): string | null {
  if (!loaded) return null;
  const logo = loaded.project.logos.find((item) => item.id === logoId);
  const ref = logo?.assets.find((asset) =>
    asset.mediaType === 'image/png' || asset.mediaType === 'image/jpeg' || asset.mediaType === 'image/webp');
  if (!logo || !ref) return null;
  const key = `${logoId}|${ref.uri}`;
  const cached = artworkUrls.get(key);
  if (cached) return cached;
  const bytes = loaded.assets.find((asset) => asset.path === ref.uri)?.bytes;
  if (!bytes || bytes.length === 0) return null;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ref.mediaType }));
  for (const [otherKey, otherUrl] of artworkUrls) {
    if (otherKey !== key && otherKey.startsWith(`${logoId}|`)) {
      try { URL.revokeObjectURL(otherUrl); } catch { /* already gone */ }
      artworkUrls.delete(otherKey);
    }
  }
  artworkUrls.set(key, url);
  return url;
}

function syncPhotoImage(): void {
  const token = ++photoGeneration;
  if (!activePhoto || !referenceImg) {
    photoNatural = null;
    revokePhotoUrl();
    if (referenceImg) {
      referenceImg.hidden = true;
      referenceImg.removeAttribute('src');
      referenceImg.alt = 'Mapped product photo';
    }
    return;
  }
  const entry = activePhoto.entry;
  const key = `${entry.productId}|${entry.variantId ?? ''}|${entry.regionId}|${entry.view}|${entry.image}`;
  if (key === photoObjectKey && photoObjectUrl && referenceImg.getAttribute('src') !== photoObjectUrl) {
    referenceImg.src = photoObjectUrl;
    referenceImg.hidden = false;
  } else if (key !== photoObjectKey) {
    revokePhotoUrl();
    photoNatural = null;
    referenceImg.hidden = true;
    referenceImg.removeAttribute('src');
  }
  const bytes = activePhoto.imageBytes;
  const extension = entry.image.slice(entry.image.lastIndexOf('.'));
  void decodePresentationRaster(bytes, extension).then((decoded) => {
    if (token !== photoGeneration || !loaded || !activePhoto) {
      if (decoded) URL.revokeObjectURL(decoded.url);
      return;
    }
    const current = activePhoto.entry;
    const currentKey = `${current.productId}|${current.variantId ?? ''}|${current.regionId}|${current.view}|${current.image}`;
    if (currentKey !== key) {
      if (decoded) URL.revokeObjectURL(decoded.url);
      return;
    }
    if (!decoded) {
      photoWarning = `Photo-mapped image “${current.image}” could not be shown; showing the measured diagram instead.`;
      activePhoto = null;
      if (primaryMode === 'photo') primaryMode = 'diagram';
      renderAll();
      return;
    }
    revokePhotoUrl();
    photoObjectUrl = decoded.url;
    photoObjectKey = key;
    if (referenceImg) {
      referenceImg.src = decoded.url;
      referenceImg.alt = `Mapped ${current.view} photo for ${current.regionId}`;
      referenceImg.hidden = primaryMode !== 'photo';
    }
  });
}

function describeMappingStatus(): string {
  if (!loaded?.project) return 'Open a project to see the photo mapping status.';
  if (activePhoto) {
    const entry = activePhoto.entry;
    const base = `Mapped photo · ${entry.view} view · calibrated ${entry.calibrationId} ${entry.calibrationVersion}. Editing uses the measured diagram.`;
    return entry.status === 'provisional' ? `Mapped photo (visual trial, not production approval) · ${entry.view} view · ${entry.calibrationId} ${entry.calibrationVersion}.` : base;
  }
  return photoWarning ?? 'No photo mapping for this logo area — Reference only — editing uses measured diagram.';
}

function renderPrimaryMode(): void {
  const usable = loaded?.project !== undefined && !loading;
  if (primaryMode === 'photo' && !activePhoto) primaryMode = 'diagram';
  const showingPhoto = primaryMode === 'photo' && activePhoto !== null;
  const showing3d = primaryMode === '3d';
  const stage = canvas.closest<HTMLElement>('.stage');
  if (stage) stage.hidden = showingPhoto || showing3d;
  if (showingPhoto || showing3d) canvas.setAttribute('hidden', '');
  else canvas.removeAttribute('hidden');
  photoWrap.hidden = !showingPhoto;
  mode3dPane.hidden = !showing3d;
  modePhotoButton.setAttribute('aria-pressed', showingPhoto ? 'true' : 'false');
  modeDiagramButton.setAttribute('aria-pressed', !showingPhoto && !showing3d ? 'true' : 'false');
  mode3dButton.setAttribute('aria-pressed', showing3d ? 'true' : 'false');
  modePhotoButton.disabled = !usable || !activePhoto;
  modePhotoButton.title = activePhoto
    ? 'Show the mapped photo preview for this logo area'
    : (photoWarning ?? 'No photo mapping for this logo area.');
  modeDiagramButton.disabled = !usable;
  modeDiagramButton.title = 'Show the measured placement diagram (millimetres)';
  mode3dButton.disabled = !usable;
  mode3dButton.title = 'Show 3D availability — no logo is projected onto any model';
  if (referenceImg) referenceImg.hidden = !showingPhoto || photoObjectUrl === null;
  const caption = optionalHook<HTMLElement>('view-caption');
  if (caption) {
    caption.textContent = showingPhoto && activePhoto
      ? `Mapped photo · ${activePhoto.entry.view} view · preview only, not to scale`
      : showing3d ? '3D availability · reference only' : 'Placement diagram · millimetres';
  }
  mappingStatus.textContent = describeMappingStatus();
  mappingStatus.classList.toggle('provisional', activePhoto?.entry.status === 'provisional');
  if (referenceWarning) {
    if (photoWarning && !showingPhoto && loaded?.project) {
      referenceWarning.hidden = false;
      referenceWarning.textContent = photoWarning;
    } else {
      referenceWarning.hidden = true;
    }
  }
  const shownSide = activePhoto?.entry.view ?? null;
  (Object.keys(sideButtons) as PhotoMappingView[]).forEach((side) => {
    const button = sideButtons[side];
    const mapped = mappedRegionForSide(side);
    button.setAttribute('aria-pressed', shownSide === side && mapped?.id === selectedRegionId ? 'true' : 'false');
    button.disabled = !usable || !mapped;
    button.title = mapped
      ? `Show the ${side} logo area`
      : legacySidePresent(side)
        ? `${side} photo is present but not mapped to a logo area — reference only; editing uses the measured diagram.`
        : `No ${side} view supplied in this package — no photo invented.`;
  });
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  if (configuration) {
    const lookup = (path: string): Uint8Array | undefined =>
      loaded?.assets.find((entry) => entry.path === path)?.bytes;
    const model = selectPresentationModel(
      loaded!.presentationManifest,
      loaded!.presentationManifestPresent,
      configuration.productId,
      configuration.variantId,
      lookup,
    );
    modelAvailability.textContent = model.modelPath
      ? `Interactive 3D model “${model.label ?? model.modelPath}” is supplied in this package. No logo artwork is projected onto it here — placement decisions use the measured diagram.`
      : 'No 3D model supplied in this package — placement decisions use the measured diagram. No geometry is reconstructed.';
  } else {
    modelAvailability.textContent = 'Open a project to check 3D availability.';
  }
  // Sync the canvas/buttons with the cached showcase state; the async model
  // load in refreshShowcase corrects any staleness without a second viewer.
  paintMode3d();
}

function choosePrimaryMode(mode: PrimaryMode): void {
  if (!loaded || loading || saving || confirming) return;
  if (mode === 'photo' && !activePhoto) {
    setStatus(photoWarning ?? 'No photo mapping for this logo area — editing uses the measured diagram.');
    return;
  }
  if (primaryMode === mode) return;
  // A mode switch always cancels an in-flight move first (never a silent
  // dead button): the saved project is unchanged, then the mode applies.
  cancelDrag('Move cancelled because the view mode changed. Your saved logo is unchanged.');
  cancelPhotoDrag('Move cancelled because the view mode changed. Your saved logo is unchanged.');
  primaryMode = mode;
  renderPrimaryMode();
  renderPhotoOverlay();
  // Entering 3D mounts (or re-measures) the pane viewer; leaving it keeps the
  // cached bytes so returning is instant and orbit is preserved.
  void refreshShowcase();
  updateButtons();
}

function chooseSide(side: PhotoMappingView): void {
  if (!loaded || loading || saving || confirming) return;
  // Cancel an in-flight move before switching areas (never a silent button):
  // the saved project is unchanged, then the area switch applies.
  cancelDrag('Move cancelled because the logo area changed. Your saved logo is unchanged.');
  cancelPhotoDrag('Move cancelled because the logo area changed. Your saved logo is unchanged.');
  const region = mappedRegionForSide(side);
  if (!region) {
    // Never a silent failure: explain exactly what is missing and the route.
    setStatus(legacySidePresent(side)
      ? `The ${side} photo is present but not mapped to a logo area — reference only; editing still uses the measured diagram.`
      : `No ${side} view is mapped in this package — no photo invented. Editing still uses the measured diagram.`);
    return;
  }
  cancelDrag('Move cancelled because the logo area changed. Your saved logo is unchanged.');
  cancelPhotoDrag('Move cancelled because the logo area changed. Your saved logo is unchanged.');
  selectedRegionId = region.id;
  renderAll();
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
  getReferenceState: () => ({
    imagePath: activePhoto?.entry.image ?? null,
    view: primaryMode === 'photo' && activePhoto ? 'reference' : 'diagram',
    warning: photoWarning,
  }),
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
  /** Refit the camera to the current model (Reset view button). */
  resetView: () => void;
  /** Dolly the camera toward (<1) or away (>1) from the target (zoom buttons, Ctrl/Meta+wheel). */
  dolly: (factor: number) => void;
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
  // Single-canvas workspace: the second independent viewer stays hidden.
  // All mapped state renders in the primary canvas; the showcase keeps its
  // hooks and status API but never paints a duplicate canvas.
  section.hidden = true;
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
      // Single primary canvas: the viewer renders inside the mode-3d pane.
      // The hidden views-showcase section keeps its hooks/status but never
      // hosts a second viewer.
      const canvasElement = mode3dWrap?.querySelector<HTMLCanvasElement>('canvas') ??
        document.querySelector<HTMLCanvasElement>('[data-customer-hook="mode-3d-canvas"]');
      const wrap = mode3dWrap ??
        document.querySelector<HTMLElement>('[data-customer-hook="mode-3d-wrap"]');
      if (!canvasElement || !wrap) return null;
      // Released customer preview: explicit white stage (the dev-inspector
      // default stays dark). Photo originals are untouched (DOM images).
      const attached = module.ModelViewer.attach({ canvas: canvasElement, container: wrap, background: 0xffffff });
      const viewer = attached.viewer;
      if (!viewer) return null;
      // Page scroll wins: OrbitControls must never trap plain wheel events
      // over the canvas. Its wheel zoom is disabled; zoom is offered through
      // explicit buttons + Ctrl/Meta+wheel only. Rotate/orbit stays enabled.
      try {
        const raw = viewer as unknown as { controls?: { enableZoom?: boolean } };
        if (raw.controls) raw.controls.enableZoom = false;
      } catch { /* keep the attached orbit behaviour when the toggle is unavailable */ }
      const zoomBy = (factor: number): void => {
        try {
          if (!Number.isFinite(factor) || factor <= 0) return;
          const raw = viewer as unknown as {
            camera: {
              position: {
                clone(): { sub(target: unknown): { length(): number; multiplyScalar(step: number): unknown } };
                copy(point: unknown): void;
              };
              updateProjectionMatrix(): void;
            };
            controls: { target: unknown; update(): void };
          };
          const offset = raw.camera.position.clone().sub(raw.controls.target);
          const length = offset.length();
          if (!Number.isFinite(length) || length <= 0) return;
          const clamped = Math.min(Math.max(factor, 0.5), 2);
          offset.multiplyScalar(clamped);
          const target = raw.controls.target as { clone(): { add(point: unknown): unknown } };
          raw.camera.position.copy(target.clone().add(offset));
          raw.camera.updateProjectionMatrix();
          raw.controls.update();
        } catch { /* zoom is best-effort and never throws into the UI */ }
      };
      showcaseViewer = {
        setViewSide: (side) => viewer.setViewSide(side),
        setOrbitEnabled: (enabled) => viewer.setOrbitEnabled(enabled),
        showModel: (bytes) => viewer.showModel(bytes),
        showImageProxy: (bytes, label) => viewer.showImageProxy(bytes, label),
        clear: () => viewer.clear(),
        refreshSize: () => viewer.refreshSize(),
        resetView: () => viewer.resetView(),
        dolly: zoomBy,
      };
      try { viewer.setOrbitEnabled(true); } catch { /* rotate stays as attached */ }
      // Ctrl/Meta+wheel zooms the model; a plain wheel is left alone so the
      // page scrolls. No preventDefault without a modifier key, ever.
      try {
        const flagged = canvasElement as HTMLCanvasElement & { __mode3dWheel?: boolean };
        if (!flagged.__mode3dWheel) {
          flagged.__mode3dWheel = true;
          canvasElement.addEventListener('wheel', (event) => {
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault();
              zoomBy(event.deltaY > 0 ? 1.15 : 1 / 1.15);
            }
          }, { passive: false });
        }
      } catch { /* wheel stays page-scroll-only when the guard cannot attach */ }
      return showcaseViewer;
    }).catch(() => null);
  }
  return showcaseViewerPromise;
}

/** Paint the single primary mode-3d pane: canvas + zoom controls + honest
 * availability/failure text. No logo artwork is ever projected onto the mesh;
 * the measured diagram stays the placement authority. */
function paintMode3d(): void {
  const showing3d = primaryMode === '3d';
  const hasModel = showcaseModelPath !== null;
  const failed = showcaseModelFailed;
  const ready = showing3d && hasModel && !failed;
  const busy = loading || saving || confirming || drag !== null || photoDrag !== null;
  if (mode3dWrap) mode3dWrap.hidden = !ready;
  for (const button of [mode3dZoomIn, mode3dZoomOut, mode3dReset]) {
    if (button) button.disabled = busy || !ready;
  }
  if (failed) {
    // Honest failure (viewer parse failed, incl. empty-bounds geometry):
    // never a blank success canvas.
    modelAvailability.textContent = 'Preview unavailable — model could not be shown';
    return;
  }
  if (!loaded?.project) {
    modelAvailability.textContent = 'Open a project to check 3D availability.';
    return;
  }
  if (hasModel) {
    modelAvailability.textContent = `Interactive 3D model “${showcaseModelLabel ?? showcaseModelPath}” is supplied in this package. No logo artwork is projected onto it here — placement decisions use the measured diagram.`;
    return;
  }
  // Selection-rejected models (corrupt/external-URI) surface their read-boundary
  // warning as the failure caption; a package with no model at all keeps the
  // no-model honesty text.
  if (showcaseWarning) {
    modelAvailability.textContent = showcaseWarning;
    return;
  }
  modelAvailability.textContent = 'No 3D model supplied in this package — placement decisions use the measured diagram. No geometry is reconstructed.';
}

async function refreshMode3dViewer(): Promise<void> {
  const generation = ++showcaseGeneration;
  const lookup = (path: string): Uint8Array | undefined =>
    loaded?.assets.find((entry) => entry.path === path)?.bytes;
  const modelPath = showcaseModelPath;
  const bytes = modelPath ? lookup(modelPath) : undefined;
  if (!modelPath || !bytes || bytes.length === 0) {
    // Model-absent (or selection-rejected): no canvas, honest text via paint.
    showcaseModelFailed = false;
    showcaseShownModelPath = null;
    showcaseShownModelBytes = null;
    showcaseSurface = 'none';
    try { showcaseViewer?.clear(); } catch { /* viewer teardown is best-effort */ }
    paintMode3d();
    return;
  }
  // Stale-model guard: identical bytes already on screen stay untouched (orbit
  // position preserved); just re-measure the now-visible wrap.
  if (showcaseShownModelPath === modelPath && showcaseShownModelBytes === bytes && !showcaseModelFailed) {
    paintMode3d();
    try { showcaseViewer?.refreshSize(); } catch { /* sizing is best-effort */ }
    return;
  }
  paintMode3d();
  const viewer = await loadShowcaseViewer();
  if (generation !== showcaseGeneration) return;
  if (!viewer) {
    showcaseModelFailed = true;
    showcaseSurface = 'failed';
    showcaseShownModelPath = null;
    showcaseShownModelBytes = null;
    paintMode3d();
    return;
  }
  let status: { kind: string; message?: string };
  try {
    status = await viewer.showModel(bytes);
  } catch (error) {
    status = { kind: 'parse-failed', message: error instanceof Error ? error.message : String(error) };
  }
  if (generation !== showcaseGeneration) return;
  if (status.kind === 'ready') {
    showcaseModelFailed = false;
    showcaseSurface = 'model';
    showcaseShownModelPath = modelPath;
    showcaseShownModelBytes = bytes;
    try { viewer.setViewSide(showcaseSide); } catch { /* default framing stands */ }
  } else {
    // Empty-bounds and corrupt parses land here: failure caption, no canvas.
    showcaseModelFailed = true;
    showcaseSurface = 'failed';
    showcaseShownModelPath = null;
    showcaseShownModelBytes = null;
  }
  paintMode3d();
  // The wrap reports 0x0 while hidden; re-measure after it becomes visible so
  // a stale viewport never blanks the freshly loaded model.
  if (!showcaseModelFailed) {
    try { viewer.refreshSize(); } catch { /* sizing is best-effort */ }
  }
}

async function refreshShowcase(): Promise<void> {
  readShowcaseAssets();
  // Single-canvas workspace: flat rasters are never decoded here, and the
  // second views-showcase section stays hidden (see paintShowcase). The model
  // channel renders in the primary mode-3d pane via refreshMode3dViewer.
  showcaseFlatPath = null;
  showcaseFlatBytes = undefined;
  if (showcaseModelPath === null) {
    showcaseModelFailed = false;
    showcaseShownModelPath = null;
    showcaseShownModelBytes = null;
    showcaseSurface = 'none';
  }
  revokeShowcaseFlatUrl();
  paintShowcase();
  await refreshMode3dViewer();
}

function chooseShowcaseMode(mode: ViewsMode): void {
  if (showcaseMode === mode) return;
  cancelDrag('Move cancelled because the product view changed. Your saved logo is unchanged.');
  cancelPhotoDrag('Move cancelled because the product view changed. Your saved logo is unchanged.');
  showcaseMode = mode;
  showcaseModelFailed = false;
  paintShowcase();
  void refreshShowcase();
}

function chooseShowcaseSide(side: ProductViewSide): void {
  cancelDrag('Move cancelled because the product view changed. Your saved logo is unchanged.');
  cancelPhotoDrag('Move cancelled because the product view changed. Your saved logo is unchanged.');
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
  submitButton.disabled = !usable || saving || confirming || drag !== null || photoDrag !== null || !structurallyValid || hasPendingEdits || !confirmationFresh || !isGeometryValid(project!);
  confirmButton.disabled = !usable || confirming || saving || drag !== null || photoDrag !== null || !structurallyValid || hasPendingEdits || !confirmedByInput.value.trim() || !isGeometryValid(project!);
  updateButton.disabled = !usable || saving || confirming || drag !== null || photoDrag !== null || (!projectInstructionsDirty && (!placementFormDirty || !hasSelectedPlacement));
  addButton.disabled = !canEdit || saving || confirming || drag !== null || photoDrag !== null || !selectedRegionId || !selectedLogoId;
  removeButton.disabled = !canEdit || !hasSelectedPlacement || saving || confirming || drag !== null || photoDrag !== null || hasPendingEdits;
  undoButton.disabled = !canEdit || undoHistory.length === 0 || saving || confirming || drag !== null || photoDrag !== null || hasPendingEdits;
  resetButton.disabled = !canEdit || baseline === null || saving || confirming || drag !== null || photoDrag !== null || hasPendingEdits;
  for (const control of [configurationSelect, productSelect, variantSelect, regionSelect, logoSelect, placementSelect,
    xInput, yInput, widthInput, heightInput, rotationInput, methodSelect, placementInstructions, projectInstructions,
    confirmedByInput]) control.disabled = !usable;
  // Guided shell mirrors: top draft button tracks save; step navigation and
  // the primary/back actions stay enabled whenever a project is usable so
  // the Position -> Size -> Review progression never strands the user.
  if (saveDraftTop) saveDraftTop.disabled = saveButton.disabled;
  if (primaryNext) primaryNext.disabled = !usable || saving || confirming || drag !== null || photoDrag !== null;
  if (backStep) backStep.disabled = !usable || saving || confirming || drag !== null || photoDrag !== null || guideStep === 'edit';
  if (addAnotherButton) addAnotherButton.disabled = addButton.disabled;
  modePhotoButton.disabled = !usable || !activePhoto;
  modePhotoButton.title = activePhoto
    ? 'Show the mapped photo preview for this logo area'
    : (photoWarning ?? 'No photo mapping for this logo area.');
  modeDiagramButton.disabled = !usable;
  mode3dButton.disabled = !usable;
  // Side tabs are navigation, not edits: enabled only for sides with a
  // mapped logo area in this product option — never a silent no-op.
  (Object.keys(sideButtons) as PhotoMappingView[]).forEach((side) => {
    const button = sideButtons[side];
    const mapped = usable ? mappedRegionForSide(side) : undefined;
    button.disabled = !usable || !mapped;
    button.setAttribute('aria-pressed', activePhoto?.entry.view === side && mapped?.id === selectedRegionId ? 'true' : 'false');
    if (!usable) button.title = 'Open a project first.';
    else if (mapped) button.title = `Show the ${side} logo area.`;
    else if (legacySidePresent(side)) button.title = `${side} photo is present but not mapped to a logo area — reference only; editing uses the measured diagram.`;
    else button.title = `No ${side} view supplied in this package — no photo invented.`;
  });
  const stepBlocked = !usable || loading || saving || confirming || drag !== null || photoDrag !== null;
  if (stepEditButton) stepEditButton.disabled = stepBlocked;
  if (stepReviewButton) stepReviewButton.disabled = stepBlocked;
  if (ratioLock) ratioLock.disabled = !usable || !currentPlacement();
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
    polygon.setAttribute('aria-label', `Logo box for ${logo?.name ?? item.logoId}; ${formatMm(item.widthMm)} by ${formatMm(item.heightMm)} millimetres`);
    polygon.addEventListener('pointerdown', (event) => beginDrag(event, index));
    polygon.addEventListener('keydown', (event) => placementKeydown(event, index));
    // Draw the ORIGINAL artwork image (not the footprint rect alone) with
    // correct aspect, clockwise-positive rotation facing the region, and
    // alpha. The image fills exactly the validator footprint box; the
    // footprint outline stays for selection/fit feedback.
    const artUrl = artworkUrlForLogo(item.logoId);
    if (artUrl) polygon.setAttribute('fill-opacity', '0.15');
    const label = svgNode('text');
    label.dataset.placementIndex = String(index);
    label.setAttribute('x', String(item.pos.xMm));
    label.setAttribute('y', String(-item.pos.yMm));
    label.setAttribute('class', 'footprint-label');
    label.textContent = logo?.name ?? item.logoId;
    canvasLayer.append(polygon);
    if (artUrl) {
      const art = svgNode('image');
      art.setAttribute('href', artUrl);
      art.setAttribute('x', String(item.pos.xMm - item.widthMm / 2));
      art.setAttribute('y', String(-item.pos.yMm - item.heightMm / 2));
      art.setAttribute('width', String(item.widthMm));
      art.setAttribute('height', String(item.heightMm));
      art.setAttribute('transform', `rotate(${item.rotationDeg} ${item.pos.xMm} ${-item.pos.yMm})`);
      art.setAttribute('opacity', '0.9');
      art.setAttribute('class', 'artwork');
      art.setAttribute('aria-hidden', 'true');
      canvasLayer.append(art);
    }
    canvasLayer.append(label);
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
      line(item, `Width × height: ${formatMm(placement.widthMm)} mm × ${formatMm(placement.heightMm)} mm`);
      const fitLine = line(item, fit?.ok ? 'Fits: yes — within the logo area.' : `Fits: no — ${fit?.reason ?? 'Size is unavailable.'}`);
      fitLine.className = fit?.ok ? 'review-fit' : 'review-fit invalid';
      const measurements = document.createElement('details');
      measurements.className = 'review-measurements';
      item.append(measurements);
      line(measurements, 'Position and rotation', 'summary');
      line(measurements, `Reference point: ${region?.frame.originDescription ?? 'unknown'}`);
      line(measurements, `Directions: +x ${region?.frame.axes.xPositive ?? 'unknown'}; +y ${region?.frame.axes.yPositive ?? 'unknown'}`);
      line(measurements, `Center: ${formatMm(placement.pos.xMm)} mm, ${formatMm(placement.pos.yMm)} mm (logo middle, offsets along the area's +x and +y from its reference point)`);
      line(measurements, `Turn clockwise: ${formatMm(placement.rotationDeg)}°`);
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
    guideStep = 'edit';
    activePhoto = null;
    photoWarning = null;
    photoNatural = null;
    revokePhotoUrl();
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
    renderPrimaryMode();
    renderPhotoOverlay();
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
  resolveActivePhoto();
  syncPhotoImage();
  renderCanvas();
  renderReview();
  renderGuideStep();
  renderContextLine();
  renderLogoThumb();
  updateUnsavedWarning();
  renderPrimaryMode();
  renderPhotoOverlay();
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

// Live apply: valid committed edits (change events) save immediately via a
// new revision — no separate Apply required. New placements still use Add;
// invalid edits keep their message and block confirm via pending edits.
function maybeAutoApply(): void {
  if (!loaded || loading || saving || confirming || drag || photoDrag) return;
  if (!placementFormDirty && !projectInstructionsDirty) return;
  if (placementFormDirty && !currentPlacement()) {
    // New-placement numbers are added, not applied: keep the guidance on the
    // add path (never a stale Apply pointer) via the shared unsaved message.
    setStatus(unsavedStepMessage());
    return;
  }
  applyPendingEdits();
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
    revokeArtworkUrls();
    revokePhotoUrl();
    activePhoto = null;
    photoWarning = null;
    photoNatural = null;
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
    guideStep = 'edit';
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

/**
 * Windows-portable filename part from a project identity: safe characters
 * only, length-capped, reserved device names guarded. Same rules as the
 * builder handoff filenames.
 */
function safeFilePart(value: string): string {
  let part = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 96).replace(/[.-]+$/g, '') || 'project';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) part = `_${part}`;
  return part;
}

async function savePackage(submit = false): Promise<void> {
  const snapshot = currentSnapshot();
  const projectPackage = loaded;
  if (!snapshot || !projectPackage || loading || saving || confirming) return;
  if (submit && (drag || photoDrag)) {
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
    // Descriptive, Windows-portable return/draft filenames: sanitized job
    // identity plus the exact revision, so repeated confirmations never
    // collide into `customer-confirmed-return (5).logo-project`.
    link.download = submit
      ? `${safeFilePart(loaded.project.projectId)}-r${loaded.project.revision}-confirmed-return.logo-project`
      : `${safeFilePart(loaded.project.projectId)}-r${loaded.project.revision}-draft.logo-project`;
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
  if (drag || photoDrag) {
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
  if (photoDrag) cancelPhotoDrag('Moving stopped because you switched to something else. Your saved logo is unchanged.');
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
  if (photoDrag) cancelPhotoDrag('Move cancelled because a new move started. Your saved logo is unchanged.');
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

interface PhotoDragState {
  pointerId: number;
  configurationId: string;
  placementIndex: number;
  project: ProjectDocument;
  generation: number;
  photo: ActivePhoto;
  grabOffsetX: number;
  grabOffsetY: number;
  previewX: number;
  previewY: number;
}
let photoDrag: PhotoDragState | null = null;

function cancelPhotoDrag(message: string): void {
  if (!photoDrag) return;
  const pointerId = photoDrag.pointerId;
  photoDrag = null;
  if (photoOverlay.hasPointerCapture(pointerId)) {
    try { photoOverlay.releasePointerCapture(pointerId); } catch { /* lost capture is already a cancellation */ }
  }
  if (loaded) renderAll();
  setStatus(message);
}

// Overlay SVG coordinates are natural photo pixels (viewBox 0 0 W H).
// Inverse mapping: pixels -> normalized UV -> region millimetres (Y-up).
function overlayMmFromEvent(event: PointerEvent, photo: ActivePhoto): { xMm: number; yMm: number } | null {
  if (!photoNatural) return null;
  const screenToPhoto = photoOverlay.getScreenCTM()?.inverse() ?? null;
  if (!screenToPhoto) return null;
  const point = photoOverlay.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(screenToPhoto);
  return inversePhotoMapping(photo.entry, { u: local.x / photoNatural.width, v: local.y / photoNatural.height });
}

function renderPhotoDragPreview(current: PhotoDragState): void {
  const configuration = current.project.configurations.find((entry) => entry.id === current.configurationId);
  const placement = configuration?.placements[current.placementIndex];
  const product = configuration && productForConfiguration(current.project, configuration);
  const region = product?.regions.find((item) => item.id === placement?.regionId);
  const polygon = photoOverlay.querySelector<SVGPolygonElement>(`.footprint[data-placement-index="${current.placementIndex}"]`);
  if (!placement || !region || !polygon || !photoNatural) return;
  const label = photoOverlay.querySelector<SVGTextElement>(`.footprint-label[data-placement-index="${current.placementIndex}"]`);
  if (Math.abs(current.previewX) > PROJECT_EDITOR_LIMITS.maxCoordinateMm || Math.abs(current.previewY) > PROJECT_EDITOR_LIMITS.maxCoordinateMm) {
    polygon.classList.add('invalid');
    setGeometry(`Too far out — past the ±${PROJECT_EDITOR_LIMITS.maxCoordinateMm} mm edge. Letting go here will not save it.`, false);
    return;
  }
  try {
    const candidate = { ...placement, pos: { xMm: current.previewX, yMm: current.previewY } };
    const verdict = evaluatePlacementGeometry(region, candidate);
    if (verdict.footprint.length !== 4) throw new Error('placement geometry produced no footprint');
    const points = verdict.footprint.map(([x, y]) => {
      const uv = forwardPhotoMapping(current.photo.entry, { xMm: x, yMm: y });
      if (!uv) throw new Error('mapped point is outside the photo calibration');
      return `${uv.u * photoNatural!.width},${uv.v * photoNatural!.height}`;
    }).join(' ');
    polygon.setAttribute('points', points);
    polygon.classList.toggle('invalid', !verdict.ok);
    if (label) {
      const center = forwardPhotoMapping(current.photo.entry, { xMm: current.previewX, yMm: current.previewY });
      if (center) {
        label.setAttribute('x', String(center.u * photoNatural.width));
        label.setAttribute('y', String(center.v * photoNatural.height));
      }
    }
    xInput.value = String(current.previewX);
    yInput.value = String(current.previewY);
    setGeometry(`Moving… fits: ${verdict.ok ? 'yes' : 'no'}; ${verdict.reason}. Let go to save this spot as a new version; press Escape to drop it.`, verdict.ok);
  } catch (error) {
    polygon.classList.add('invalid');
    setGeometry(`That spot was rejected: ${error instanceof Error ? error.message : String(error)}`, false);
  }
}

function beginPhotoDrag(event: PointerEvent, placementIndex: number): void {
  if (!event.isPrimary || event.button !== 0 || !loaded || loading || saving || confirming || photoDrag || placementFormDirty || projectInstructionsDirty) return;
  if (drag) cancelDrag('Move cancelled because a new move started. Your saved logo is unchanged.');
  const photo = activePhoto;
  if (!photo || primaryMode !== 'photo') return;
  const configuration = selectedConfiguration();
  const placement = configuration?.placements[placementIndex];
  const start = overlayMmFromEvent(event, photo);
  if (!configuration || !placement || !start) return;
  invalidateUiContext();
  refreshCurrentConfirmation();
  selectedPlacementIndex = placementIndex;
  selectedRegionId = placement.regionId;
  selectedLogoId = placement.logoId;
  photoDrag = {
    pointerId: event.pointerId,
    configurationId: configuration.id,
    placementIndex,
    project: loaded.project,
    generation: stateGeneration,
    photo,
    grabOffsetX: placement.pos.xMm - start.xMm,
    grabOffsetY: placement.pos.yMm - start.yMm,
    previewX: placement.pos.xMm,
    previewY: placement.pos.yMm,
  };
  try { photoOverlay.setPointerCapture(event.pointerId); }
  catch {
    photoDrag = null;
    renderAll();
    setStatus('Drag could not start because pointer capture was unavailable.');
    return;
  }
  event.preventDefault();
  renderAll();
}

function movePhotoDrag(event: PointerEvent): void {
  const current = photoDrag;
  if (!current || current.pointerId !== event.pointerId) return;
  const point = overlayMmFromEvent(event, current.photo);
  if (!point) return;
  const xMm = point.xMm + current.grabOffsetX;
  const yMm = point.yMm + current.grabOffsetY;
  if (Math.abs(xMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm || Math.abs(yMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm) {
    setGeometry(`Drag preview exceeds the ±${PROJECT_EDITOR_LIMITS.maxCoordinateMm} mm runtime geometry bound.`, false);
    event.preventDefault();
    return;
  }
  current.previewX = xMm;
  current.previewY = yMm;
  renderPhotoDragPreview(current);
  event.preventDefault();
}

function finishPhotoDrag(event: PointerEvent, commit: boolean): void {
  const current = photoDrag;
  if (!current || current.pointerId !== event.pointerId) return;
  photoDrag = null;
  if (photoOverlay.hasPointerCapture(current.pointerId)) {
    try { photoOverlay.releasePointerCapture(current.pointerId); } catch { /* pointer capture can already be gone */ }
  }
  if (!commit || !event.isPrimary || event.button !== 0 || loaded?.project !== current.project || stateGeneration !== current.generation) {
    if (loaded) renderAll();
    if (!commit || !event.isPrimary || event.button !== 0) setStatus('Move cancelled. Your saved logo stays where it was.');
    return;
  }
  const endpoint = overlayMmFromEvent(event, current.photo);
  if (!endpoint) {
    renderAll();
    setStatus('Move cancelled — that spot could not be read. Your saved logo stays where it was.');
    return;
  }
  const xMm = endpoint.xMm + current.grabOffsetX;
  const yMm = endpoint.yMm + current.grabOffsetY;
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
    // Inverse mapping lands back in domain millimetres: the existing
    // updatePlacement path + validation applies unchanged.
    const next = updatePlacement(current.project, current.configurationId, selector, { pos: { xMm, yMm } });
    installMutation(next, `Moved the logo — saved as version ${next.revision}. All sizes stay in millimetres.`);
  } catch (error) {
    renderAll();
    setStatus(`Could not move the logo there: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Keyboard nudge: arrows move the focused placement in region millimetres
// (Y-up: ArrowUp is +y). Works on diagram and photo polygons alike; photo
// moves commit through the same updatePlacement + validation path.
function nudgePlacement(index: number, dxMm: number, dyMm: number): void {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  const placement = configuration?.placements[index];
  if (!project || !configuration || !placement) return;
  if (placementFormDirty || projectInstructionsDirty) {
    setStatus('You have changes that are not applied yet — press “Apply my changes” first.');
    return;
  }
  const selector = placementSelector(placement, index);
  try {
    const next = updatePlacement(project, configuration.id, selector, {
      pos: { xMm: placement.pos.xMm + dxMm, yMm: placement.pos.yMm + dyMm },
    });
    installMutation(next, `Moved the logo — saved as version ${next.revision}. All sizes stay in millimetres.`);
  } catch (error) {
    setStatus(`Could not move the logo: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function placementKeydown(event: KeyboardEvent, index: number): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    contextChanged();
    selectedPlacementIndex = index;
    renderAll();
    return;
  }
  const step = event.shiftKey ? 10 : 1;
  const delta = event.key === 'ArrowLeft' ? [-step, 0]
    : event.key === 'ArrowRight' ? [step, 0]
    : event.key === 'ArrowUp' ? [0, step]
    : event.key === 'ArrowDown' ? [0, -step]
    : null;
  if (delta) {
    event.preventDefault();
    contextChanged();
    selectedPlacementIndex = index;
    const configuration = selectedConfiguration();
    const placement = configuration?.placements[index];
    if (placement) {
      selectedRegionId = placement.regionId;
      selectedLogoId = placement.logoId;
    }
    renderAll();
    nudgePlacement(index, delta[0]!, delta[1]!);
  }
}

function photoPx(photo: ActivePhoto, xMm: number, yMm: number): { x: number; y: number } | null {
  if (!photoNatural) return null;
  const uv = forwardPhotoMapping(photo.entry, { xMm, yMm });
  if (!uv) return null;
  return { x: uv.u * photoNatural.width, y: uv.v * photoNatural.height };
}

function layoutPhotoOverlay(): void {
  if (photoWrap.hidden || !photoNatural) return;
  const cw = photoWrap.clientWidth;
  const ch = photoWrap.clientHeight;
  if (!cw || !ch) return;
  // Contain-fit: the <img> letterboxes with object-fit; the overlay box is
  // positioned over the rendered image rect so millimetre mapping holds.
  const scale = Math.min(cw / photoNatural.width, ch / photoNatural.height);
  const rw = Math.max(1, photoNatural.width * scale);
  const rh = Math.max(1, photoNatural.height * scale);
  photoOverlay.style.left = `${(cw - rw) / 2}px`;
  photoOverlay.style.top = `${(ch - rh) / 2}px`;
  photoOverlay.style.width = `${rw}px`;
  photoOverlay.style.height = `${rh}px`;
}

function renderPhotoOverlay(): void {
  photoOverlay.replaceChildren();
  if (primaryMode !== 'photo' || !activePhoto || !photoNatural) return;
  const photo = activePhoto;
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  const region = regionForSelection();
  if (!project || !configuration || !region) return;
  photoOverlay.setAttribute('viewBox', `0 0 ${photoNatural.width} ${photoNatural.height}`);
  const svgNode = (name: string): SVGElement => document.createElementNS('http://www.w3.org/2000/svg', name);
  geometryFor(project);
  const configurationGeometry = geometryLookup?.get(configuration.id);
  for (const [index, item] of configuration.placements.entries()) {
    if (item.regionId !== region.id) continue;
    const verdict = configurationGeometry?.get(index);
    if (!verdict || verdict.footprint.length !== 4) continue;
    // Same footprint convention as the domain validator, carried through
    // the forward mapping into photo pixels. Mis-mapped corners drop the
    // placement overlay (never a misplaced logo).
    const corners: string[] = [];
    let mappable = true;
    for (const [x, y] of verdict.footprint) {
      const px = photoPx(photo, x, y);
      if (!px) { mappable = false; break; }
      corners.push(`${px.x},${px.y}`);
    }
    if (!mappable) continue;
    const logo = project.logos.find((candidate) => candidate.id === item.logoId);
    const polygon = svgNode('polygon') as SVGPolygonElement;
    polygon.setAttribute('points', corners.join(' '));
    polygon.setAttribute('class', `footprint${verdict.ok ? '' : ' invalid'}${index === selectedPlacementIndex ? ' selected' : ''}`);
    polygon.dataset.placementIndex = String(index);
    polygon.setAttribute('tabindex', '0');
    polygon.setAttribute('role', 'button');
    polygon.setAttribute('aria-label', `Logo box for ${logo?.name ?? item.logoId}; ${formatMm(item.widthMm)} by ${formatMm(item.heightMm)} millimetres`);
    polygon.addEventListener('pointerdown', (event) => beginPhotoDrag(event, index));
    polygon.addEventListener('keydown', (event) => placementKeydown(event, index));
    const artUrl = artworkUrlForLogo(item.logoId);
    if (artUrl) polygon.setAttribute('fill-opacity', '0.15');
    photoOverlay.append(polygon);
    if (artUrl) {
      // Authoritative center/size/rotation drawn through the mapping; alpha
      // preserved so fit feedback stays visible. Side-isolated: only the
      // active region's placements render, on the active side's photo. Shared
      // placement math with the operation proof (mapping + placement turn).
      const matrix = artworkPhotoMatrix(photo.entry.transform, photoNatural.width, photoNatural.height, {
        xMm: item.pos.xMm,
        yMm: item.pos.yMm,
        widthMm: item.widthMm,
        heightMm: item.heightMm,
        rotationDeg: item.rotationDeg,
      });
      if (matrix) {
        const art = svgNode('image');
        art.setAttribute('href', artUrl);
        art.setAttribute('x', '0');
        art.setAttribute('y', '0');
        art.setAttribute('width', '1');
        art.setAttribute('height', '1');
        art.setAttribute('preserveAspectRatio', 'none');
        art.setAttribute('transform', `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`);
        art.setAttribute('opacity', '0.85');
        art.setAttribute('class', 'artwork');
        art.setAttribute('aria-hidden', 'true');
        photoOverlay.append(art);
      }
    }
    const center = photoPx(photo, item.pos.xMm, item.pos.yMm);
    if (center) {
      const label = svgNode('text');
      label.dataset.placementIndex = String(index);
      label.setAttribute('x', String(center.x));
      label.setAttribute('y', String(center.y));
      label.setAttribute('class', 'footprint-label');
      // Pixel viewBox (not millimetres): scale the label to the photo.
      label.setAttribute('font-size', String(Math.max(photoNatural.width / 50, 0.2)));
      label.textContent = logo?.name ?? item.logoId;
      photoOverlay.append(label);
    }
  }
  layoutPhotoOverlay();
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
  cancelPhotoDrag('Move cancelled because the logo area changed.');
  selectedRegionId = regionSelect.value;
  const methods = regionForSelection()?.allowedMethods ?? [];
  const method = methods.includes(methodSelect.value) ? methodSelect.value : methods[0] ?? '';
  replaceOptions(methodSelect, methods.map((value) => ({ value, label: value })), method);
  placementFormDirty = currentPlacement() !== undefined;
  stateGeneration += 1;
  renderCanvas(); renderContextLine(); updateUnsavedWarning(); updateButtons();
  resolveActivePhoto(); syncPhotoImage(); renderPrimaryMode(); renderPhotoOverlay();
  maybeAutoApply();
});
logoSelect.addEventListener('change', () => {
  // Switching logos never loses applied edits: block the switch while
  // edits are pending and point at the apply action instead.
  if (placementFormDirty || projectInstructionsDirty) {
    logoSelect.value = selectedLogoId;
    updateUnsavedWarning();
    setStatus(unsavedStepMessage());
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
      setStatus(isNewPlacementOnlyDirt()
        ? `You changed numbers below — ${guidedAddDirection()} as a new version.`
        : 'You changed numbers below — press “Apply my changes” to save them into a new version.');
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
stepEditButton?.addEventListener('click', () => requestStep('edit'));
stepReviewButton?.addEventListener('click', () => requestStep('review'));
backStep?.addEventListener('click', () => requestStep(stepNeighbor(guideStep, -1)));
primaryNext?.addEventListener('click', () => {
  if (!loaded || loading || saving || confirming || drag || photoDrag) return;
  if (hasUnsavedEdits() && currentPlacement()) {
    applyPendingEdits();
    if (hasUnsavedEdits()) return;
  }
  if (guideStep === 'edit' && !currentPlacement()) {
    addButton.click();
    if (!currentPlacement()) return;
  }
  requestStep(stepNeighbor(guideStep, 1));
});
addAnotherButton?.addEventListener('click', () => {
  if (!loaded || loading || saving || confirming || drag || photoDrag) return;
  if (hasUnsavedEdits()) { applyPendingEdits(); if (hasUnsavedEdits()) return; }
  selectedPlacementIndex = null;
  guideStep = 'edit';
  renderAll();
  const choices = optionalHook<HTMLDetailsElement>('job-choices');
  if (choices && logoSelect.options.length > 1) choices.open = true;
});
modePhotoButton.addEventListener('click', () => choosePrimaryMode('photo'));
modeDiagramButton.addEventListener('click', () => choosePrimaryMode('diagram'));
mode3dButton.addEventListener('click', () => choosePrimaryMode('3d'));
// Explicit 3D zoom: buttons + Ctrl/Meta+wheel (wired at viewer attach). Plain
// wheel and touch scroll stay with the page — the canvas never preventDefaults
// them, so ordinary scrolling always wins.
mode3dZoomIn?.addEventListener('click', () => showcaseViewer?.dolly(1 / 1.25));
mode3dZoomOut?.addEventListener('click', () => showcaseViewer?.dolly(1.25));
mode3dReset?.addEventListener('click', () => showcaseViewer?.resetView());
if (typeof ResizeObserver !== 'undefined' && mode3dWrap) {
  const wrap = mode3dWrap;
  new ResizeObserver(() => {
    if (primaryMode === '3d' && showcaseSurface === 'model') {
      try { showcaseViewer?.refreshSize(); } catch { /* sizing is best-effort */ }
    }
  }).observe(wrap);
}
for (const side of ['front', 'back', 'left', 'right'] as const) {
  sideButtons[side].addEventListener('click', () => chooseSide(side));
}
// Photo natural size drives the contain-fit overlay box; the overlay keeps
// the millimetre mapping exact across resizes. No wheel handler is
// registered anywhere on this canvas, so page scroll is never trapped.
if (referenceImg) {
  referenceImg.addEventListener('load', () => {
    if (referenceImg.naturalWidth > 0 && referenceImg.naturalHeight > 0) {
      photoNatural = { width: referenceImg.naturalWidth, height: referenceImg.naturalHeight };
      renderPhotoOverlay();
    }
  });
}
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => layoutPhotoOverlay()).observe(photoWrap);
}
// Committed edits auto-apply (live newRevision); per-keystroke input only
// marks dirty. Invalid edits keep their message and block confirm.
for (const control of [xInput, yInput, widthInput, heightInput, rotationInput, methodSelect, placementInstructions, projectInstructions]) {
  control.addEventListener('change', () => maybeAutoApply());
}
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
photoOverlay.addEventListener('pointermove', movePhotoDrag);
photoOverlay.addEventListener('pointerup', (event) => finishPhotoDrag(event, true));
photoOverlay.addEventListener('pointercancel', (event) => finishPhotoDrag(event, false));
photoOverlay.addEventListener('lostpointercapture', (event) => finishPhotoDrag(event as PointerEvent, false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drag) { event.preventDefault(); cancelDrag('Move cancelled with Escape. Your saved logo is unchanged.'); }
  if (event.key === 'Escape' && photoDrag) { event.preventDefault(); cancelPhotoDrag('Move cancelled with Escape. Your saved logo is unchanged.'); }
});
window.addEventListener('blur', () => {
  cancelDrag('Move cancelled because the window lost focus. Your saved logo is unchanged.');
  cancelPhotoDrag('Move cancelled because the window lost focus. Your saved logo is unchanged.');
});

renderAll();
updateButtons();

runCustomerSelfContainedBootstrap((bytes, fileName) => loadProjectSource({
  name: fileName, size: bytes.length, read: async () => bytes,
}));
