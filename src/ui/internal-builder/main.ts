import {
  PRESENTATION_MANIFEST_PATH,
  PRESENTATION_MAX_MODEL_BYTES,
  parsePresentationManifest,
  selectPresentationPackageAssets,
} from '../customer-editor/presentation-assets.js';
import { selectPresentationModel, selectPresentationViews } from '../customer-editor/presentation-assets.js';
import {
  PHOTO_MAPPINGS_PATH,
  parsePhotoMappings,
  serializePhotoMappings,
  solveAffineFromCorrespondences,
  artworkPhotoMatrix,
  validatePhotoMapping,
} from '../customer-editor/presentation-photo-mapping.js';
import type {
  PhotoMappingEntry,
  PhotoMappingTransform,
  PhotoMappingView,
} from '../customer-editor/presentation-photo-mapping.js';
import {
  buildIssuedProject,
  selectIssuedAssets,
  summarizeSourceProject,
  validateBuilderSelection,
} from '../../core/project-builder/index.js';
import type {
  BuilderSelection,
  BuilderSourceSummary,
} from '../../core/project-builder/index.js';
import {
  buildCandidateExport,
  canonicalize,
  importCustomerReturn,
  newRevision,
  recordInternalReview,
  serializeExport,
  validateLogos,
  validateProject,
} from '../../core/index.js';
import type {
  Configuration,
  ExportConfiguration,
  ExportPlacement,
  Placement,
  ProjectDocument,
  ResultCandidate,
  ReviewDecision,
} from '../../core/index.js';
import { assertProjectEditorLimits, evaluateProjectGeometry } from '../../core/project-editor/index.js';
import { buildOperationSheetView, matchLogoRef } from '../../core/operation-document/index.js';
import type { OperationSheetJob, PhotoMappingState, ReferenceViewInput } from '../../core/operation-document/types.js';
import type { BuildOperationSheetViewInput, OperationSheetView } from '../../core/operation-document/types.js';
import {
  evaluateOperationPhotoStates,
  operationSheetPageCount,
  operationSheetStyles,
  operationSheetSummary,
  renderOperationSheet,
  selectOperationReferenceViews,
} from '../shared/operation-document/index.js';
import {
  isOperationDraft,
  isStaleDraft,
  OPERATION_DRAFT_NUMBER,
  OPERATION_DRAFT_VERSION,
  measurePlacement,
  rotatedFootprintCorners,
} from '../../core/operation-measurements/index.js';
import { resolveVisualDimension } from '../../core/visual-dimension/index.js';
import type {
  AnchorDef,
  ArtworkEdge,
  DimensionBinding,
  MeasurementConvention,
  OperationDraft,
} from '../../core/operation-measurements/index.js';
import { createAnchorSetup, validateSafeAreaPolygon } from './anchor-setup.js';
import type { AnchorSetupHandle, AnchorSetupInput, AnchorSetupMm } from './anchor-setup.js';
import { createProductSetupView, validateAnchors } from './product-setup-view.js';
import type {
  ProductSetupCallbacks,
  ProductSetupPhotoView,
  ProductSetupScope,
  ProductSetupSide,
  ProductSetupWorkspaceInput,
} from './product-setup-view.js';
import { createGuidedScale, guidedCorrespondences } from './guided-scale.js';
import type { GuidedScaleCommit, GuidedScaleRequest } from './guided-scale.js';
import type {
  OperationSheetAssetLookup,
  SheetOverlayArtwork,
  SheetOverlayMapping,
} from '../shared/operation-document/index.js';
import {
  createProjectPackage,
  PROJECT_PACKAGE_LIMITS,
  parseProjectPackage,
} from '../../packaging/project-package/index.js';
import type { ProjectPackageAsset, ProjectPackageAssetInput } from '../../packaging/project-package/index.js';
import {
  createSelfContainedHtml,
  decodeEmbeddedProjectBase64,
} from '../../packaging/self-contained-html/index.js';
import { MAX_PREVIEW_BYTES, readRasterHeader } from '../../assets/raster-header.js';
import { parseGlb } from '../../assets/glb.js';
import { validateSelfContained } from '../../assets/validate.js';
import { createProjectFromDefinitions } from '../../core/project-builder/create-project.js';
import { isPreviewOnlyProduct } from '../../core/project-builder/provisional-product.js';
import { appendPreparedProduct, preparedEvidencePaths, selectPreparedSidecarAssets, PREPARED_IMPORT_LIMITS } from '../../core/project-builder/prepared-import.js';
import { createProvisionalProduct } from '../../core/project-builder/provisional-product.js';
import { planPhotoIntake } from '../../core/photo-intake/index.js';
import { createWebCryptoProjectHasher } from '../shared/browser-hasher.js';
import { zipSync } from 'fflate';

interface SourceState {
  fileName: string;
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
  summary: BuilderSourceSummary;
  /** Verbatim source package bytes (for "Save prepared master"). */
  packageBytes: Uint8Array;
}
interface ImportedLogo {
  id: string;
  name: string;
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  widthPx: number;
  heightPx: number;
}

interface GeneratedState {
  format: 'self-contained' | 'hybrid';
  jobPart: string;
  packageBytes: Uint8Array;
  htmlBytes: Uint8Array;
  zipBytes: Uint8Array | null;
  issuedProject: ProjectDocument;
  issuedAssets: ProjectPackageAsset[];
}

interface BaselineState {
  fileName: string;
  jobPart: string;
  packageBytes: Uint8Array;
  issuedProject: ProjectDocument;
  issuedAssets: ProjectPackageAsset[];
}

interface ReturnState {
  imported: ProjectDocument;
  candidate: ResultCandidate;
  contentDigest: string;
  serializedCandidate: string;
  candidateFileName: string;
  /** Human job handle for return-derived filenames (never a raw UUID). */
  jobPart: string;
  /** Return package assets (referenced + additional) for the reviewed-return save. */
  packageAssets: ProjectPackageAsset[];
  geometryOk: boolean;
  returnFileName: string;
  baselineFileName: string;
  reviewTimestamp: string;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing internal builder element: ${selector}`);
  return element;
}

const hook = <T extends Element>(name: string): T =>
  required<T>(`[data-builder-hook="${name}"]`);


const sourceFile = hook<HTMLInputElement>('source-file');
const sourceChoose = hook<HTMLButtonElement>('source-choose');
const sourceDrop = hook<HTMLElement>('source-drop');
const sourceStatus = hook<HTMLElement>('source-status');
const startCreate = hook<HTMLButtonElement>('start-create');
const createStatus = hook<HTMLElement>('create-status');
const logoAdd = hook<HTMLButtonElement>('logo-add');
const logoFile = hook<HTMLInputElement>('logo-file');
const logoStatus = hook<HTMLElement>('logo-status');
const productName = hook<HTMLInputElement>('product-name');
const productAdd = hook<HTMLButtonElement>('product-add');
const productChoose = hook<HTMLButtonElement>('product-choose');
const productFile = hook<HTMLInputElement>('product-file');
const productStatus = hook<HTMLElement>('product-status');
const productPhotoSide = hook<HTMLSelectElement>('product-photo-side');
const productPhotoScope = hook<HTMLSelectElement>('product-photo-scope');
const productPhotoLabel = hook<HTMLInputElement>('product-photo-label');
const productPhotoChoose = hook<HTMLButtonElement>('product-photo-choose');
const productPhotoFile = hook<HTMLInputElement>('product-photo-file');
const productPhotoStatus = hook<HTMLElement>('product-photo-status');
const preparedProductAdd = hook<HTMLButtonElement>('prepared-product-add');
const preparedProductFile = hook<HTMLInputElement>('prepared-product-file');
const preparedProductDrop = hook<HTMLElement>('prepared-product-drop');
const saveMaster = hook<HTMLButtonElement>('save-master');
const masterStatus = hook<HTMLElement>('master-status');
const productViewFile: Record<string, HTMLInputElement> = {
  front: hook<HTMLInputElement>('product-view-front-file'),
  back: hook<HTMLInputElement>('product-view-back-file'),
  left: hook<HTMLInputElement>('product-view-left-file'),
  right: hook<HTMLInputElement>('product-view-right-file'),
};
const productViewButton: Record<string, HTMLButtonElement> = {
  front: hook<HTMLButtonElement>('product-view-front'),
  back: hook<HTMLButtonElement>('product-view-back'),
  left: hook<HTMLButtonElement>('product-view-left'),
  right: hook<HTMLButtonElement>('product-view-right'),
};
const productViewLabel: Record<string, HTMLInputElement> = {
  front: hook<HTMLInputElement>('product-view-front-label'),
  back: hook<HTMLInputElement>('product-view-back-label'),
  left: hook<HTMLInputElement>('product-view-left-label'),
  right: hook<HTMLInputElement>('product-view-right-label'),
};
const productList = hook<HTMLElement>('product-list');
const logoList = hook<HTMLElement>('logo-list');
const configurationList = hook<HTMLElement>('configuration-list');
const customerName = hook<HTMLInputElement>('customer-name');
const jobRef = hook<HTMLInputElement>('job-ref');
const issuedBy = hook<HTMLInputElement>('issued-by');
const projectIdInput = hook<HTMLInputElement>('project-id');
const projectIdSuggestion = hook<HTMLElement>('project-id-suggestion');
const projectIdUseSource = hook<HTMLButtonElement>('project-id-use-source');
const formatSelf = hook<HTMLInputElement>('format-self');
const formatHybrid = hook<HTMLInputElement>('format-hybrid');
const generateButton = hook<HTMLButtonElement>('generate');
const generateStatus = hook<HTMLElement>('generate-status');
const previewOnlyAck = hook<HTMLInputElement>('preview-only-acknowledge');
const sizeEstimate = hook<HTMLElement>('size-estimate');
const downloadPackage = hook<HTMLButtonElement>('download-package');
const downloadHtml = hook<HTMLButtonElement>('download-html');
const downloadBaseline = hook<HTMLButtonElement>('download-baseline');
const baselineStatus = hook<HTMLElement>('baseline-status');
const baselineFile = hook<HTMLInputElement>('baseline-file');
const baselineChoose = hook<HTMLButtonElement>('baseline-choose');
const baselineLoadStatus = hook<HTMLElement>('baseline-load-status');
const returnFile = hook<HTMLInputElement>('return-file');
const returnStatus = hook<HTMLElement>('return-status');
const handoffSummary = hook<HTMLElement>('handoff-summary');
const reviewPanel = hook<HTMLElement>('review-panel');
const ticketSummary = hook<HTMLElement>('ticket-summary');
const candidateDownload = hook<HTMLButtonElement>('candidate-download');
const operatorDownload = hook<HTMLButtonElement>('operator-download');
const operationPrint = hook<HTMLButtonElement>('operation-print');
const operationContainer = hook<HTMLElement>('operation-container');
type PrepareStep = 'open' | 'choose' | 'details' | 'send';
type ReviewStep = 'office' | 'return' | 'check';
type BuilderMode = 'prepare' | 'review';
let builderMode: BuilderMode = 'prepare';
let prepareStep: PrepareStep = 'open';
let reviewStep: ReviewStep = 'office';
let lastAutoProjectId = '';
const modePrepare = hook<HTMLButtonElement>('mode-prepare');
const modeReview = hook<HTMLButtonElement>('mode-review');
const stepOpen = hook<HTMLButtonElement>('step-open');
const stepChoose = hook<HTMLButtonElement>('step-choose');
const stepDetails = hook<HTMLButtonElement>('step-details');
const stepSend = hook<HTMLButtonElement>('step-send');
const stepOffice = hook<HTMLButtonElement>('step-office');
const stepReturn = hook<HTMLButtonElement>('step-return');
const stepCheck = hook<HTMLButtonElement>('step-check');
const newSourceButton = hook<HTMLButtonElement>('new-source');
const projectIdNew = hook<HTMLButtonElement>('project-id-new');
const selectionSummary = hook<HTMLElement>('selection-summary');
const selectionError = hook<HTMLElement>('selection-error');
const reviewFiles = hook<HTMLElement>('review-files');
const reviewChanges = hook<HTMLElement>('review-changes');
const fileDetails = hook<HTMLElement>('file-details');
const builderAlert = hook<HTMLElement>('builder-alert');
const readySummary = hook<HTMLElement>('ready-summary');
const officeSummary = hook<HTMLElement>('office-summary');
/* In-station review decision (check step): same rules as the full reviewer. */
const decisionCurrent = hook<HTMLElement>('review-decision-current');
const decisionReviewer = hook<HTMLInputElement>('review-decision-reviewer');
const decisionChoice = hook<HTMLSelectElement>('review-decision-choice');
const decisionNote = hook<HTMLTextAreaElement>('review-decision-note');
const decisionRecord = hook<HTMLButtonElement>('review-decision-record');
const decisionDownload = hook<HTMLButtonElement>('review-decision-download');
const decisionStatus = hook<HTMLElement>('review-decision-status');
const sendToReview = hook<HTMLButtonElement>('send-to-review');
/* In-station revised proposal (check step): office corrections via newRevision. */
const proposalCurrent = hook<HTMLElement>('proposal-current');
const proposalConfig = hook<HTMLSelectElement>('proposal-config');
const proposalPlacement = hook<HTMLSelectElement>('proposal-placement');
const proposalX = hook<HTMLInputElement>('proposal-x');
const proposalY = hook<HTMLInputElement>('proposal-y');
const proposalWidth = hook<HTMLInputElement>('proposal-width');
const proposalHeight = hook<HTMLInputElement>('proposal-height');
const proposalRotation = hook<HTMLInputElement>('proposal-rotation');
const proposalInstructions = hook<HTMLTextAreaElement>('proposal-instructions');
const proposalApply = hook<HTMLButtonElement>('proposal-apply');
const proposalDownload = hook<HTMLButtonElement>('proposal-download');
const proposalStatus = hook<HTMLElement>('proposal-status');
/* Operation-sheet authoring hooks (review/prepare flow, check step). */
const sheetConfig = hook<HTMLSelectElement>('sheet-config');
const sheetSummary = hook<HTMLElement>('sheet-summary');
const sheetCustomerNotes = hook<HTMLElement>('sheet-customer-notes');
const sheetCustomer = hook<HTMLInputElement>('sheet-customer');
const sheetReference = hook<HTMLInputElement>('sheet-reference');
const sheetArticle = hook<HTMLInputElement>('sheet-article');
const sheetInstructions = hook<HTMLTextAreaElement>('sheet-instructions');
const sheetTechTemperature = hook<HTMLInputElement>('sheet-tech-temperature');
const sheetTechTime = hook<HTMLInputElement>('sheet-tech-time');
const sheetTechPressure = hook<HTMLInputElement>('sheet-tech-pressure');
const sheetTechColour = hook<HTMLInputElement>('sheet-tech-colour');
const sheetTechThread = hook<HTMLInputElement>('sheet-tech-thread');
const techSummary = hook<HTMLElement>('tech-summary');
const sheetLogos = hook<HTMLElement>('sheet-logos');
const anchorSide = hook<HTMLSelectElement>('anchor-side');
const anchorRegion = hook<HTMLSelectElement>('anchor-region');
const anchorStatus = hook<HTMLElement>('anchor-status');
const anchorSetupBox = hook<HTMLElement>('anchor-setup');
const draftSave = hook<HTMLButtonElement>('draft-save');
const draftOpenButton = hook<HTMLButtonElement>('draft-open-button');
const draftFile = hook<HTMLInputElement>('draft-file');
const draftStatus = hook<HTMLElement>('draft-status');
/* Visual product workspace mount (Choose items primary block). Declared here so
 * updateControls() — which runs during initial step paint — sees them. */
const workspaceProduct = hook<HTMLSelectElement>('workspace-product');
const workspaceVariant = hook<HTMLSelectElement>('workspace-variant');
const workspaceStatus = hook<HTMLElement>('workspace-status');
const workspaceBox = hook<HTMLElement>('product-workspace');
const guidedScaleBox = hook<HTMLElement>('guided-scale');
const addProductDisclosure = hook<HTMLDetailsElement>('add-product-disclosure');
const addProductSummary = hook<HTMLElement>('add-product-summary');
const productModelBox = hook<HTMLElement>('product-model');
const productModelStage = hook<HTMLElement>('product-model-stage');
const productModelStatus = hook<HTMLElement>('product-model-status');
/** One staff-chosen measurement for a logo (anchor + artwork edge + convention). */
interface DimensionMeasurement {
  anchorId: string;
  edge: ArtworkEdge;
  convention: MeasurementConvention;
}
/** Per-logo department authoring for one product sheet. */
interface LogoAuthoring {
  businessCode: string;
  /** One row per measured dimension; normal positioning needs ≥2 (dx + dy). */
  measurements: DimensionMeasurement[];
}
/** Per-sheet department authoring (job, instructions, technique, logos). */
interface SheetAuthoring {
  customer: string;
  reference: string;
  article: string;
  instructions: string;
  tech: { temperature: string; time: string; pressure: string; colour: string; thread: string };
  logos: Map<string, LogoAuthoring>;
}
/** Department authoring by configuration id; reset on every return import. */
const sheetAuthoring = new Map<string, SheetAuthoring>();
/** Department-authored anchors across sheets (in-memory only, never browser storage). */
let authorAnchors: AnchorDef[] = [];
let activeSheetConfigId: string | null = null;
/** Staged safe-area proposals by scope key (proposal only; product unchanged). */
const safeAreaProposals = new Map<string, { staged: Array<{ x: number; y: number }>; note: string }>();
let lastReturnAssets: Map<string, Uint8Array> | null = null;
let lastReturnReferenceViews: Record<string, readonly ReferenceViewInput[]> = Object.create(null);
let anchorSetupHandle: AnchorSetupHandle | null = null;
function alertBuilder(message = ''): void {
  builderAlert.textContent = message;
  builderAlert.hidden = !message;
}
function newLocalId(): string {
  const cryptoRef = globalThis.crypto;
  if (typeof cryptoRef?.randomUUID === 'function') {
    try {
      return cryptoRef.randomUUID();
    } catch { /* fall through to manual entropy below */ }
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoRef?.getRandomValues === 'function') {
    try {
      cryptoRef.getRandomValues(bytes);
    } catch {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    }
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function ensureAutoProjectId(): void {
  const current = projectIdInput.value;
  if (current.trim() === '' || current === lastAutoProjectId) {
    const fresh = newLocalId();
    projectIdInput.value = fresh;
    lastAutoProjectId = fresh;
  }
}
function paintModeAndStepTabs(): void {
  for (const [button, active] of [[modePrepare, builderMode === 'prepare'], [modeReview, builderMode === 'review']] as const) {
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const tabs: Array<[HTMLButtonElement, boolean]> = [
    [stepOpen, builderMode === 'prepare' && prepareStep === 'open'],
    [stepChoose, builderMode === 'prepare' && prepareStep === 'choose'],
    [stepDetails, builderMode === 'prepare' && prepareStep === 'details'],
    [stepSend, builderMode === 'prepare' && prepareStep === 'send'],
    [stepOffice, builderMode === 'review' && reviewStep === 'office'],
    [stepReturn, builderMode === 'review' && reviewStep === 'return'],
    [stepCheck, builderMode === 'review' && reviewStep === 'check'],
  ];
  for (const [button, active] of tabs) {
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
}
function showStep(mode: BuilderMode, step: PrepareStep | ReviewStep): void {
  if (mode === 'prepare') prepareStep = step as PrepareStep;
  else reviewStep = step as ReviewStep;
  builderMode = mode;
  for (const panel of document.querySelectorAll<HTMLElement>('[data-builder-mode-panel]')) {
    panel.hidden = panel.getAttribute('data-builder-mode-panel') !== mode;
  }
  for (const section of document.querySelectorAll<HTMLElement>('[data-builder-step]')) {
    const name = section.getAttribute('data-builder-step');
    const inPrepare = section.closest('[data-builder-mode-panel="prepare"]') !== null;
    section.hidden = inPrepare ? name !== prepareStep : name !== reviewStep;
  }
  paintModeAndStepTabs();
  document.body.classList.remove('show-operation-preview');
  hook('preview-document').setAttribute('aria-expanded', 'false');
  operationContainer.hidden = mode !== 'review' || step !== 'check' || lastReturn === null;
  updateControls();
}
function showMode(mode: BuilderMode): void {
  showStep(mode, mode === 'prepare' ? prepareStep : reviewStep);
}
function goNext(): void {
  if (loading || generating || creating || logoImporting || returnBusy || baselineBusy) return;
  if (builderMode === 'prepare') {
    if (prepareStep === 'open') { if (source !== null) showStep('prepare', 'choose'); }
    else if (prepareStep === 'choose') { if (source !== null && selectionValid) showStep('prepare', 'details'); }
    else if (prepareStep === 'details') { if (generated) showStep('prepare', 'send'); }
  } else {
    if (reviewStep === 'office') {
      if (activeBaseline() !== null) showStep('review', 'return');
      else baselineLoadStatus.textContent = 'Choose the office copy you saved when sending the project, then continue.';
    } else if (reviewStep === 'return') {
      if (lastReturn !== null) showStep('review', 'check');
      else returnStatus.textContent = activeBaseline() === null
        ? 'No issued baseline available; generate a package or choose a saved baseline first.'
        : 'Load a returned project file to review it.';
    }
  }
}
function goBack(): void {
  if (loading || generating || creating || logoImporting || returnBusy || baselineBusy) return;
  if (builderMode === 'prepare') {
    if (prepareStep === 'choose') showStep('prepare', 'open');
    else if (prepareStep === 'details') showStep('prepare', 'choose');
    else if (prepareStep === 'send') showStep('prepare', 'details');
  } else {
    if (reviewStep === 'return') showStep('review', 'office');
    else if (reviewStep === 'check') showStep('review', 'return');
  }
}
function renderSelectionSummary(): void {
  selectionSummary.replaceChildren();
  if (source === null) {
    selectionSummary.textContent = 'No project loaded yet.';
    return;
  }
  const selection = readSelection();
  let optionCount = 0;
  for (const box of productList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (box.checked && selection.productIds.includes(box.getAttribute('data-product') ?? '')) optionCount += 1;
  }
  for (const options of productList.querySelectorAll<HTMLElement>('[data-options-for]')) options.hidden = !selection.productIds.includes(options.getAttribute('data-options-for')!);
  const importedSelected = logoImports.filter((entry) =>
    logoList.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${entry.id}"]`)?.checked !== false,
  ).length;
  const count = (value: number, name: string) => `${value} ${name}${value === 1 ? '' : 's'}`;
  for (const line of [count(selection.productIds.length, 'product'), count(optionCount, 'option'), count(selection.logoIds.length + importedSelected, 'logo')]) {
    const row = document.createElement('p');
    row.textContent = line;
    selectionSummary.append(row);
  }
}
function renderFileDetails(identity: { customerLabel: string; jobReference: string; issuedBy: string; projectId: string }): void {
  const body = fileDetails.querySelector('.body') ?? fileDetails;
  let node = body.querySelector('[data-builder-dynamic="file-summary"]');
  if (!node) {
    node = document.createElement('p');
    node.setAttribute('data-builder-dynamic', 'file-summary');
    node.className = 'muted';
    body.insertBefore(node, body.firstChild);
  }
  const size = generated !== null
    ? (generated.format === 'hybrid' && generated.zipBytes !== null ? generated.zipBytes.length : generated.htmlBytes.length)
    : 0;
  node.textContent =
    `Customer ${identity.customerLabel} / job ${identity.jobReference} by ${identity.issuedBy}; project ${identity.projectId}. ` +
    `Office copy ${generated?.packageBytes.length ?? 0} bytes; customer file ${size} bytes.`;
}
function clearFileDetails(): void {
  fileDetails.querySelector('[data-builder-dynamic="file-summary"]')?.remove();
}
function renderReviewFiles(): void {
  reviewFiles.replaceChildren();
  if (lastReturn === null) return;
  for (const line of [`Office copy: ${lastReturn.baselineFileName}`, `Customer return: ${lastReturn.returnFileName}`]) {
    const row = document.createElement('p');
    row.textContent = line;
    reviewFiles.append(row);
  }
}
/** Display-only millimetre rounding for operator-facing before/after text
 * (e.g. 108.1 mm instead of 108.11145510835912 mm). Canonical values and the
 * technical appendix keep full precision; this never feeds geometry. */
function displayMm(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return (Math.round(value * 10) / 10).toFixed(1);
}

function renderReviewChanges(issued: ProjectDocument): void {
  reviewChanges.replaceChildren();
  if (lastReturn === null) return;
  const back = lastReturn.imported;
  function line(parent: HTMLElement, text: string, className = ''): HTMLElement {
    const node = document.createElement('p'); node.textContent = text; node.className = className; parent.append(node); return node;
  }
  const current = back.confirmation?.revision === back.revision && back.confirmation?.digest === lastReturn.contentDigest;
  line(reviewChanges, current ? `Customer confirmed this version · ${back.confirmation!.confirmedBy}` : 'Customer confirmation is missing or out of date. Ask for confirmation before approval.', current ? 'review-ok' : 'review-warning');
  line(reviewChanges, lastReturn.geometryOk ? 'All logos fit the allowed areas.' : 'Some logos do not fit the allowed areas. Check the measurements before proceeding.', lastReturn.geometryOk ? 'review-ok' : 'review-warning');
  const old = new Map(issued.configurations.map(item => [item.id, item]));
  const fresh = new Map(back.configurations.map(item => [item.id, item]));
  let changed = false;
  for (const id of new Set([...old.keys(), ...fresh.keys()])) {
    const before = old.get(id), after = fresh.get(id);
    if (canonicalize(before ?? null) === canonicalize(after ?? null)) continue;
    changed = true;
    const config = after ?? before!;
    const product = back.products.find(item => item.id === config.productId);
    const variant = product?.variants.find(item => item.id === config.variantId);
    const group = document.createElement('section'); group.className = 'change-group'; reviewChanges.append(group);
    line(group, `${product?.name ?? config.productId} · ${variant?.name ?? config.variantId}`, 'change-title');
    if (!before || !after) line(group, after ? 'Product option added.' : 'Product option removed.');
    const oldLogos = new Map((before?.placements ?? []).map((item, index) => [item.id ?? `#${index}`, item]));
    const newLogos = new Map((after?.placements ?? []).map((item, index) => [item.id ?? `#${index}`, item]));
    let changedLogo = false;
    for (const key of new Set([...oldLogos.keys(), ...newLogos.keys()])) {
      const oldItem = oldLogos.get(key), newItem = newLogos.get(key);
      if (canonicalize(oldItem ?? null) === canonicalize(newItem ?? null)) continue;
      changedLogo = true;
      const item = newItem ?? oldItem!;
      const logo = back.logos.find(logo => logo.id === item.logoId);
      line(group, logo?.name ?? item.logoId, 'change-title');
      const grid = document.createElement('div'); grid.className = 'comparison'; group.append(grid);
      function compare(label: string, previous: string, next: string): void {
        line(grid, label, 'change-label'); line(grid, `Before: ${previous}`); line(grid, `After: ${next}`);
      }
      const names = (value: Placement | undefined) => product?.regions.find(region => region.id === value?.regionId)?.name ?? value?.regionId ?? '(not placed)';
      compare('Logo size', oldItem ? `${displayMm(oldItem.widthMm)} × ${displayMm(oldItem.heightMm)} mm` : '(not placed)', newItem ? `${displayMm(newItem.widthMm)} × ${displayMm(newItem.heightMm)} mm` : '(removed)');
      if (oldItem?.regionId !== newItem?.regionId) compare('Logo area', names(oldItem), names(newItem));
      else line(group, `Logo area: ${names(item)}`);
      if (oldItem?.method !== newItem?.method) compare('Method', oldItem?.method ?? '(none)', newItem?.method ?? '(none)');
      else line(group, `Method: ${item.method}`);
      if (oldItem?.logoId !== newItem?.logoId && oldItem && newItem) compare('Artwork', back.logos.find(logo => logo.id === oldItem.logoId)?.name ?? oldItem.logoId, logo?.name ?? newItem.logoId);
      if (oldItem?.instructions !== newItem?.instructions) compare('Customer note', oldItem?.instructions || '(none)', newItem?.instructions || '(none)');
      if (oldItem && newItem && (oldItem.pos.xMm !== newItem.pos.xMm || oldItem.pos.yMm !== newItem.pos.yMm)) compare('Position (mm)', `${displayMm(oldItem.pos.xMm)}, ${displayMm(oldItem.pos.yMm)}`, `${displayMm(newItem.pos.xMm)}, ${displayMm(newItem.pos.yMm)}`);
      if (oldItem && newItem && oldItem.rotationDeg !== newItem.rotationDeg) compare('Clockwise rotation', `${displayMm(oldItem.rotationDeg)}°`, `${displayMm(newItem.rotationDeg)}°`);
      const details = document.createElement('details'); details.className = 'disclosure';
      const title = document.createElement('summary'); title.textContent = 'Position and rotation'; details.append(title); group.append(details);
      for (const [label, value] of [['Before', oldItem], ['After', newItem]] as const) {
        if (!value) continue;
        const area = product?.regions.find(region => region.id === value.regionId);
        line(details, `${label}: centre ${displayMm(value.pos.xMm)}, ${displayMm(value.pos.yMm)} mm · Clockwise ${displayMm(value.rotationDeg)}°`);
        line(details, `Reference point: ${area?.frame.originDescription ?? 'unknown'}; +x ${area?.frame.axes.xPositive ?? 'unknown'}; +y ${area?.frame.axes.yPositive ?? 'unknown'}`);
      }
    }
    if (!changedLogo) line(group, !after?.placements.length ? 'No logos placed.' : 'Product option or logo order changed.');
  }
  if (issued.instructions !== back.instructions) {
    changed = true;
    line(reviewChanges, `Project note before: ${issued.instructions || '(none)'}`);
    line(reviewChanges, `Project note after: ${back.instructions || '(none)'}`);
  }
  if (!changed) line(reviewChanges, 'No changes to logo layouts or notes.');
}

const hasher = createWebCryptoProjectHasher();

let source: SourceState | null = null;
let generated: GeneratedState | null = null;
let loadedBaseline: BaselineState | null = null;
let lastReturn: ReturnState | null = null;
let selectionValid = false;
/**
 * Whether the operator deliberately narrowed "Choose specific setups" (a real
 * change event on one of its boxes). Untouched means the applicable existing
 * setups ride along with the selected products/variants automatically, so a
 * prepared variant is usable without opening the collapsed disclosure; the
 * disclosure stays a deliberate override. Reset on every new source install;
 * preserved across in-session list re-renders (product/logo additions).
 */
let configurationsTouched = false;
/** Selected products with no regions/calibrations (uncalibrated preview-only). */
let previewOnlyIds: string[] = [];
let loading = false;
let generating = false;
let returnBusy = false;
let creating = false;
let createGeneration = 0;
let logoImporting = false;
let logoGeneration = 0;
let logoCounter = 0;
let sourceSession = 0;
let baselineBusy = false;
let loadGeneration = 0;
let generateGeneration = 0;
let returnGeneration = 0;
let logoImports: ImportedLogo[] = [];
let baselineGeneration = 0;
interface PendingProductView { bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; extension: string; widthPx: number; heightPx: number; fileName: string; }
interface PendingProductModel { bytes: Uint8Array; fileName: string; }
let pendingPrimaryImage: PendingProductView | null = null;
let pendingPrimaryModel: PendingProductModel | null = null;
let pendingViews: Record<string, PendingProductView | null> = { front: null, back: null, left: null, right: null };
let productImporting = false;
let photoAttaching = false;
let productGeneration = 0;
let productCounter = 0;
interface AddedProductPresentation { views: Array<{ view: string; image: string; label?: string }>; models: Array<{ model: string; label?: string }>; assets: Array<{ path: string; bytes: Uint8Array }>; }
let addedPresentations: AddedProductPresentation[] = [];

function activeBaseline(): BaselineState | null {
  if (generated !== null) {
    return {
      fileName: `${generated.jobPart}-issued-baseline.logo-project`,
      jobPart: generated.jobPart,
      packageBytes: generated.packageBytes,
      issuedProject: generated.issuedProject,
      issuedAssets: generated.issuedAssets,
    };
  }
  return loadedBaseline;
}

/**
 * Stale-output invalidation: any selection, identity, or format edit clears
 * generated downloads and the return preview synchronously and cancels
 * outstanding async work by bumping generation + return tokens.
 */
function invalidateOutputsForEdit(): void {
  generateGeneration += 1;
  generating = false;
  returnGeneration += 1;
  returnBusy = false;
  generated = null;
  lastReturn = null;
  sizeEstimate.textContent = 'No issued package generated yet.';
  baselineStatus.textContent = loadedBaseline !== null
    ? `No generated delivery retained. A saved office copy (${loadedBaseline.fileName}) remains loaded for return review.`
    : 'No office copy retained; generate a package first.';
  clearFileDetails();
  if (builderMode === 'prepare' && prepareStep === 'send') showStep('prepare', 'details');
  clearReturnReview();
  updateControls();
}

function updateControls(): void {
  const blocked = loading || generating || creating || logoImporting || productImporting || photoAttaching || returnBusy || baselineBusy;
  sourceChoose.disabled = blocked;
  sourceFile.disabled = blocked;
  startCreate.disabled = blocked;
  logoAdd.disabled = blocked || source === null;
  logoFile.disabled = blocked || source === null;
  productAdd.disabled = blocked;
  productChoose.disabled = blocked;
  productFile.disabled = blocked;
  productName.disabled = blocked;
  preparedProductAdd.disabled = blocked || source === null;
  preparedProductFile.disabled = blocked || source === null;
  for (const side of ['front', 'back', 'left', 'right'] as const) {
    productViewButton[side]!.disabled = blocked;
    productViewFile[side]!.disabled = blocked;
    productViewLabel[side]!.disabled = blocked;
  }
  const photoBlocked = blocked || source === null;
  productPhotoSide.disabled = photoBlocked;
  productPhotoScope.disabled = photoBlocked;
  productPhotoLabel.disabled = photoBlocked;
  productPhotoChoose.disabled = photoBlocked;
  productPhotoFile.disabled = photoBlocked;
  newSourceButton.disabled = blocked || source === null;
  baselineChoose.disabled = blocked;
  baselineFile.disabled = blocked;
  generateButton.disabled = source === null || !selectionValid || blocked ||
    (previewOnlyIds.length > 0 && !previewOnlyAck.checked);
  saveMaster.disabled = blocked || source === null;
  const office = activeBaseline();
  officeSummary.textContent = office ? `Office copy ready: ${office.fileName}` : 'Choose the office copy saved for this job.';
  baselineChoose.textContent = office ? 'Choose a different office copy' : 'Choose office copy';
  baselineChoose.className = office ? 'btn-secondary' : 'btn-primary';
  hook<HTMLButtonElement>('office-download').hidden = office === null;
  const officeNext = document.querySelector<HTMLButtonElement>('[data-builder-step="office"] [data-builder-hook="builder-next"]');
  if (officeNext) { officeNext.hidden = office === null; officeNext.className = 'btn-primary'; }
  baselineLoadStatus.hidden = office !== null && !baselineBusy && !baselineLoadStatus.textContent?.startsWith('Could not');
  const hasOutput = generated !== null && !blocked;
  downloadPackage.disabled = !hasOutput;
  downloadHtml.disabled = !hasOutput;
  downloadHtml.textContent = generated !== null && generated.format === 'hybrid'
    ? 'Download configurator HTML only (advanced)'
    : 'Download project file only (advanced)';
  downloadBaseline.disabled = activeBaseline() === null || blocked;
  hook<HTMLButtonElement>('office-download').disabled = activeBaseline() === null || blocked;
  projectIdUseSource.disabled = source === null || blocked;
  projectIdNew.disabled = blocked;
  for (const input of [customerName, jobRef, issuedBy, projectIdInput, previewOnlyAck, formatSelf, formatHybrid]) input.disabled = blocked;
  const prepOff = prepareBlocked();
  for (const input of [workspaceProduct, workspaceVariant]) input.disabled = prepOff || source === null;
  const authoringOff = authoringBlocked();
  for (const input of [sheetConfig, sheetCustomer, sheetReference, sheetArticle, sheetInstructions,
    sheetTechTemperature, sheetTechTime, sheetTechPressure, sheetTechColour, sheetTechThread,
    draftSave, draftOpenButton, draftFile, anchorSide, anchorRegion]) input.disabled = authoringOff;
  for (const input of sheetLogos.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) input.disabled = authoringOff;
  for (const input of document.querySelectorAll<HTMLInputElement>('.rows input')) input.disabled = blocked;
  const hasReturn = lastReturn !== null && !blocked;
  candidateDownload.disabled = !hasReturn;
  operatorDownload.disabled = !hasReturn;
  operationPrint.disabled = !hasReturn;
  decisionReviewer.disabled = authoringOff;
  decisionChoice.disabled = authoringOff;
  decisionNote.disabled = authoringOff;
  decisionRecord.disabled = authoringOff;
  decisionDownload.disabled = authoringOff || !hasCurrentStationReview();
  for (const input of [proposalConfig, proposalPlacement, proposalX, proposalY, proposalWidth, proposalHeight, proposalRotation, proposalInstructions]) input.disabled = authoringOff;
  proposalApply.disabled = authoringOff;
  proposalDownload.disabled = authoringOff;
  returnFile.disabled = blocked || activeBaseline() === null;
  const stepButtons = document.querySelectorAll<HTMLButtonElement>('[data-builder-hook="builder-next"], [data-builder-hook="builder-back"]');
  for (const button of stepButtons) {
    const step = button.closest('[data-builder-step]')?.getAttribute('data-builder-step');
    const visible = (builderMode === 'prepare' ? prepareStep : reviewStep) === step;
    button.hidden = !visible;
    if (!visible) continue;
    const isNext = button.getAttribute('data-builder-hook') === 'builder-next';
    button.disabled = blocked || (isNext && !canAdvanceFromCurrentStep());
  }
  if (officeNext && office === null) officeNext.hidden = true;
  modePrepare.disabled = blocked;
  modeReview.disabled = blocked;
  sendToReview.disabled = blocked;
  for (const tab of [stepOpen, stepChoose, stepDetails, stepSend, stepOffice, stepReturn, stepCheck]) tab.disabled = blocked;
  stepChoose.disabled = blocked || source === null;
  stepDetails.disabled = blocked || source === null || !selectionValid;
  stepSend.disabled = blocked || generated === null;
  stepReturn.disabled = blocked || activeBaseline() === null;
  stepCheck.disabled = blocked || lastReturn === null;
}
function canAdvanceFromCurrentStep(): boolean {
  if (builderMode === 'prepare') {
    if (prepareStep === 'open') return source !== null;
    if (prepareStep === 'choose') return source !== null && selectionValid;
    return prepareStep === 'details' && generated !== null;
  }
  if (reviewStep === 'office') return activeBaseline() !== null;
  if (reviewStep === 'return') return lastReturn !== null;
  return false;
}

function createCheckRow(value: string, label: string, onToggle?: () => void): { row: HTMLLabelElement; box: HTMLInputElement } {
  const row = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = value;
  // Ordinary jobs start with NOTHING pre-selected: the operator ticks only
  // what the customer needs. The explicit demo entry point checks all rows.
  box.checked = false;
  const text = document.createElement('span');
  text.textContent = label;
  row.append(box, text);
  // An explicit toggle hook runs BEFORE validation refresh, so derived
  // selection state (e.g. the setups override flag) is current when read.
  box.addEventListener('change', () => { onToggle?.(); refreshSelectionValidation(); });
  return { row, box };
}

function currentChecks(): { products: string[]; logos: string[]; configurations: string[] } {
  const products: string[] = [];
  for (const box of productList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (box.checked) products.push(`${box.getAttribute('data-product') ?? ''}\0${box.value}`);
  }
  const logos: string[] = [];
  for (const box of logoList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (!box.checked) logos.push(box.value);
  }
  const configurations = Array.from(configurationList.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).filter(box => box.checked).map(box => box.value);
  return { products, logos, configurations };
}

function renderSelectionLists(summary: BuilderSourceSummary, preserveChecks = false): void {
  const kept = preserveChecks ? currentChecks() : null;
  productList.replaceChildren();
  logoList.replaceChildren();
  configurationList.replaceChildren();
  if (summary.products.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No products in source.';
    productList.append(empty);
  } else {
    for (const product of summary.products) {
      const { row, box } = createCheckRow(product.id, product.name || product.id);
      if (kept !== null) box.checked = kept.products.includes(`\0${product.id}`);
      productList.append(row);
      if (product.variantIds.length > 0) {
        const variants = document.createElement('div');
        variants.className = 'variants';
        variants.setAttribute('data-options-for',product.id);
        const live = source?.project.products.find((entry) => entry.id === product.id);
        for (const variantId of product.variantIds) {
          const variant = live?.variants.find((entry) => entry.id === variantId);
          const label = variant?.name ?? (product.variantIds.length === 1
            ? 'Standard option' : `Option ${product.variantIds.indexOf(variantId) + 1}`);
          const variantRow = createCheckRow(variantId, label);
          variantRow.box.setAttribute('data-product', product.id);
          if (kept !== null) variantRow.box.checked = kept.products.includes(`${product.id}\0${variantId}`);
          variants.append(variantRow.row);
        }
        productList.append(variants);
      }
    }
  }
  if (summary.logoIds.length === 0 && logoImports.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No logos in source.';
    logoList.append(empty);
  } else {
    for (const logoId of summary.logoIds) {
      const logo = source?.project.logos.find((entry) => entry.id === logoId);
      const { row, box } = createCheckRow(logoId, logo?.name || logoId);
      if (kept !== null) box.checked = !kept.logos.includes(logoId);
      logoList.append(row);
    }
    for (const imported of logoImports) {
      const {row,box} = createCheckRow(imported.id, imported.name);
      // Newly added customer logos arrive selected automatically (stated in
      // the add-logo copy); preserved rows keep their prior state.
      if (kept === null || !kept.logos.includes(imported.id)) box.checked = true;
      logoList.append(row);
    }
  }
  if (summary.configurationIds.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No setups in source.';
    configurationList.append(empty);
  } else {
    for (const configurationId of summary.configurationIds) {
      const configuration = source?.project.configurations.find((entry) => entry.id === configurationId);
      const label = configuration !== undefined
        ? `${configuration.productId} · ${configuration.variantId} — ${configuration.placements.length} logo placements`
        : configurationId;
      // Any real toggle here is a deliberate override of the automatic
      // product/variant setup inclusion (programmatic checks don't fire this).
      const {row,box} = createCheckRow(configurationId, label, () => { configurationsTouched = true; });
      if (kept !== null) box.checked = kept.configurations.includes(configurationId);
      configurationList.append(row);
    }
  }
}

function readSelection(): BuilderSelection {
  const productIds: string[] = [];
  for (const box of productList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (box.checked && box.getAttribute('data-product') === null) productIds.push(box.value);
  }
  const importedIds = logoImports.map((entry) => entry.id);
  const logoIds: string[] = [];
  for (const box of logoList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (box.checked && !importedIds.includes(box.value)) logoIds.push(box.value);
  }
  const allConfigurations: string[] = [];
  for (const box of configurationList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (box.checked) allConfigurations.push(box.value);
  }
  const variantIdsByProduct: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  let narrowed = false;
  for (const productId of productIds) {
    const checked: string[] = [];
    let total = 0;
    for (const box of productList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (box.getAttribute('data-product') !== productId) continue;
      total += 1;
      if (box.checked) checked.push(box.value);
    }
    if (total > 0 && checked.length !== total) {
      variantIdsByProduct[productId] = checked;
      narrowed = true;
    }
  }
  const selection: BuilderSelection = { productIds, logoIds };
  if (narrowed) selection.variantIdsByProduct = variantIdsByProduct;
  if (configurationsTouched) {
    // Deliberate override: only explicitly ticked setups ship.
    const knownConfigurations = new Set<string>(source?.summary.configurationIds ?? []);
    const knownSelected = allConfigurations.filter((id) => knownConfigurations.has(id));
    const totalConfigurations = source?.summary.configurationIds.length ?? 0;
    if (knownSelected.length !== totalConfigurations) selection.configurationIds = knownSelected;
  }
  // Untouched setups list: configurationIds stays undefined so the core
  // includes the applicable existing setups of the selected products/variants
  // automatically (and backfills empty setups for options without defaults).
  // Checking a prepared product/variant is therefore enough to issue it.
  return selection;
}

/** Existing setups applicable to a selection (mirrors the core automatic path, for display only). */
function applicableConfigurationIds(selection: BuilderSelection): string[] {
  if (source === null) return [];
  const selectedProducts = new Set(selection.productIds);
  const ids: string[] = [];
  for (const config of source.project.configurations) {
    if (!selectedProducts.has(config.productId)) continue;
    const explicit = selection.variantIdsByProduct?.[config.productId];
    if (explicit !== undefined) {
      if (!explicit.includes(config.variantId)) continue;
    } else {
      const product = source.project.products.find((item) => item.id === config.productId);
      if (!product?.variants.some((variant) => variant.id === config.variantId)) continue;
    }
    ids.push(config.id);
  }
  return ids;
}

function selectedPreviewOnlyIds(): string[] {
  if (source === null) return [];
  const selected = new Set(readSelection().productIds);
  return source.project.products
    .filter((product) => selected.has(product.id) && isPreviewOnlyProduct(product))
    .map((product) => product.id);
}

/**
 * Preview-only issue gate: selected products without measurement data stay
 * preview-only and block issue until the operator either adds measurements
 * with “Import prepared product definition” in Choose items or explicitly
 * ticks "Issue preview-only (uncalibrated)". Valid zero-placement
 * selections of measured products are never blocked by this gate.
 */
function previewOnlyLabels(): string[] {
  if (source === null) return [];
  return source.project.products
    .filter((product) => previewOnlyIds.includes(product.id))
    .map((product) => product.name ?? product.id);
}

function refreshPreviewOnlyGate(): void {
  previewOnlyIds = selectedPreviewOnlyIds();
  if (previewOnlyIds.length === 0 || previewOnlyAck.checked) return;
  const labels = previewOnlyLabels();
  const names = labels.length > 0 ? labels.join(', ') : `${previewOnlyIds.length} selected products`;
  generateStatus.hidden = false;
  generateStatus.textContent =
    `Cannot issue yet: ${names} ${labels.length === 1 ? 'has' : 'have'} no measurements. ` +
    'Set measurements visually under “Set up product” in Choose items — ' +
    'or tick “Issue preview-only (uncalibrated)” below to send an unmeasured preview.';
}

function refreshSelectionValidation(): void {
  if (source === null) {
    selectionValid = false;
    generateStatus.textContent = 'Load a source project to begin.';
    updateControls();
    return;
  }
  const selection = readSelection();
  const outcome = validateBuilderSelection(source.project, selection);
  // Any selection edit invalidates previously generated downloads + preview
  // (synchronously, cancelling pending async work); the fresh validation
  // message is restored afterwards.
  invalidateOutputsForEdit();
  if (outcome.ok) {
    selectionValid = true;
    // Untouched setups ride along automatically: report the applicable
    // existing setups (options without defaults additionally start empty).
    const configurationCount = selection.configurationIds ?? applicableConfigurationIds(selection);
    const setupsNote = configurationsTouched
      ? 'chosen setups'
      : 'setups of the selected options included automatically (narrow them under Choose specific setups)';
    const readable = `Selection valid: ${selection.productIds.length} products, ${selection.logoIds.length} logos, ${configurationCount.length} ${setupsNote}. Selected variants without defaults start empty in automatic mode.`;
    generateStatus.textContent = readable;
    generateStatus.hidden = true;
    if (previewOnlyAck.checked && selectedPreviewOnlyIds().length > 0) {
      generateStatus.textContent =
        `${readable} Preview-only issue acknowledged: uncalibrated products ship preview-only, without measurements or placements.`;
      generateStatus.hidden = false;
    }
    selectionError.textContent = '';
    renderSelectionSummary();
    syncSetupCheckboxes(selection);
    refreshPreviewOnlyGate();
  } else {
    selectionValid = false;
    previewOnlyIds = [];
    const readable = `Selection invalid: ${outcome.errors.map((error) => error.message).join('; ')}`;
    generateStatus.textContent = readable;
    selectionError.textContent = 'Choose at least one product and an option for each selected product. Check any specific setups you selected.';
    renderSelectionSummary();
  }
  updateControls();
}

/**
 * Reflect automatically included setups in the override list: while the
 * operator has not deliberately narrowed setups, the ticked boxes mirror the
 * applicable existing setups of the selected products/variants (programmatic
 * checks fire no change events, so the untouched override state is kept).
 */
function syncSetupCheckboxes(selection: BuilderSelection): void {
  if (configurationsTouched || source === null) return;
  const applicable = new Set(applicableConfigurationIds(selection));
  for (const box of configurationList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    box.checked = applicable.has(box.value);
  }
}

function clearGeneratedOutputs(): void {
  generateGeneration += 1;
  generating = false;
  generated = null;
  sizeEstimate.textContent = 'No issued package generated yet.';
  baselineStatus.textContent = loadedBaseline !== null
    ? `No generated delivery retained. A saved office copy (${loadedBaseline.fileName}) remains loaded for return review.`
    : 'No office copy retained; generate a package first.';
  clearFileDetails();
  clearReturnReview();
  updateControls();
}

function clearReturnReview(): void {
  returnBusy = false;
  lastReturn = null;
  returnGeneration += 1;
  resetSheetAuthoring();
  reviewPanel.hidden = true;
  ticketSummary.textContent = 'No return imported.';
  handoffSummary.textContent = 'No return imported.';
  reviewFiles.replaceChildren();
  reviewChanges.replaceChildren();
  decisionChoice.value = 'pending';
  decisionNote.value = '';
  decisionStatus.textContent = '';
  proposalStatus.textContent = '';
  renderStationDecision();
  renderProposalEditor();
  paintTechSummary();
  for (const node of reviewPanel.querySelectorAll('[data-builder-dynamic]')) node.remove();
  operationContainer.replaceChildren();
  operationContainer.hidden = true;
  document.getElementById('internal-builder-operation-styles')?.remove();
  returnStatus.textContent = activeBaseline() === null
    ? 'Load an issued baseline (generate a package or choose a saved baseline), then load a returned .logo-project file to review it.'
    : 'Load a returned .logo-project file to review it.';
  updateControls();
}

async function loadSourceFile(file: File): Promise<void> {
  alertBuilder();
  const generation = ++loadGeneration;
  creating = false;
  logoGeneration += 1;
  logoImporting = false;
  productGeneration += 1;
  productImporting = false;
  generateGeneration += 1;
  generating = false;
  returnGeneration += 1;
  returnBusy = false;
  loading = true;
  updateControls();
  sourceStatus.textContent = `Reading ${file.name}…`;
  try {
    if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) throw new Error('archive size exceeds limit; rejected before reading');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (generation !== loadGeneration) return;
    const parsed = await parseProjectPackage(bytes, { sha256: hasher.sha256Bytes });
    if (generation !== loadGeneration) return;
    assertProjectEditorLimits(parsed.project);
    const summary = summarizeSourceProject(parsed.project);
    sourceSession += 1;
    logoImports = [];
    logoStatus.textContent = '';
    pendingPrimaryImage = null;
    pendingPrimaryModel = null;
    pendingViews = { front: null, back: null, left: null, right: null };
    addedPresentations = [];
    productStatus.textContent = '';
    productName.value = '';
    source = { fileName: file.name, project: parsed.project, assets: parsed.assets, summary, packageBytes: bytes.slice() };
    configurationsTouched = false;
    renderSelectionLists(summary);
    stagedPhotoMappings = [];
    resetMappingSessionUI();
    await loadAnchorsSidecar(parsed.assets, parsed.project);
    if (generation !== loadGeneration) return;
    guidedScale.hide();
    refreshWorkspace();
    refreshAddProductDisclosure();
    projectIdSuggestion.textContent = `Source project ID “${summary.projectId}”. Enter a unique ID for this customer issue.`;
    clearGeneratedOutputs();
    previewOnlyAck.checked = false;
    previewOnlyIds = [];
    sourceStatus.textContent = `Loaded ${file.name} (revision ${summary.revision}): ${summary.productIds.length} products, ${summary.logoIds.length} logos, ${summary.configurationIds.length} setups, ${summary.assetPaths.length} artwork files.`;
    refreshSelectionValidation();
    ensureAutoProjectId();
    showStep('prepare', 'choose');
  } catch (error) {
    if (generation === loadGeneration) {
      sourceStatus.textContent = `Could not load ${file.name}: invalid source: ${error instanceof Error ? error.message : String(error)}. The previous source remains unchanged.`;
      alertBuilder(`Could not open ${file.name}. Choose a valid project file. Your previous project is still available.`);
    }
  } finally {
    if (generation === loadGeneration) { loading = false; updateControls(); }
  }
}

function onSourceFileChange(): void {
  const file = sourceFile.files?.[0];
  if (file) void loadSourceFile(file);
  sourceFile.value = '';
}

function embeddedEditorBytes(): Uint8Array {
  const nodes = document.querySelectorAll('#__logoCustomerEditorHtml');
  if (nodes.length !== 1) {
    throw new Error('Customer configurator HTML is not embedded exactly once; rebuild the station before generating.');
  }
  const node = nodes[0]!;
  if (node.tagName !== 'SCRIPT' || node.getAttribute('type') !== 'text/plain') {
    throw new Error('Embedded customer configurator block has an unexpected element shape.');
  }
  return decodeEmbeddedProjectBase64(node.textContent ?? '');
}

async function generateIssued(): Promise<void> {
  if (source === null || loading || generating || creating || logoImporting || productImporting || baselineBusy || returnBusy) return;
  alertBuilder();
  generateStatus.hidden = false;
  const missing = [[customerName, 'customer name'], [jobRef, 'job reference'], [issuedBy, 'prepared by']] as const;
  const empty = missing.filter(([input]) => !input.value.trim());
  if (empty.length) {
    alertBuilder(`Enter ${empty.map(([, label]) => label).join(', ')} to create the customer file.`);
    empty[0]![0].focus();
    return;
  }
  const snapshot = source;
  clearGeneratedOutputs();
  const generation = ++generateGeneration;
  generating = true;
  updateControls();
  generateStatus.textContent = 'Generating issued package…';
  try {
    const selection = readSelection();
    const validation = validateBuilderSelection(snapshot.project, selection);
    if (!validation.ok) {
      generateStatus.textContent = `Selection invalid: ${validation.errors.map((error) => error.message).join('; ')}`;
      return;
    }
    // Preview-only gate (defense in depth; the button is already disabled):
    // uncalibrated selections issue only with the explicit escape checked.
    const uncalibrated = snapshot.project.products
      .filter((product) => selection.productIds.includes(product.id) && isPreviewOnlyProduct(product));
    if (uncalibrated.length > 0 && !previewOnlyAck.checked) {
      generateStatus.hidden = false;
      const names = uncalibrated.map((product) => product.name ?? product.id).join(', ');
      generateStatus.textContent =
        `Issue rejected: ${names} ${uncalibrated.length === 1 ? 'has' : 'have'} no measurements. ` +
        'Add measurements with “Import a prepared product definition” — or tick “Issue preview-only (uncalibrated)”.';
      return;
    }
    // UI trims before calling core; core validates the trimmed value
    // (1..256 chars) and rejects surrounding whitespace.
    const identity = {
      customerLabel: customerName.value.trim(),
      jobReference: jobRef.value.trim(),
      issuedBy: issuedBy.value.trim(),
      projectId: projectIdInput.value.trim(),
    };
    const issued = buildIssuedProject(snapshot.project, selection, identity);
    if (!issued.ok) {
      if (generation === generateGeneration) {
        generated = null;
        generateStatus.textContent = `Issue rejected: ${issued.errors.map((error) => error.message).join('; ')}`;
        alertBuilder('Check the project ID in More options. Enter a unique reference using 1–256 characters.');
        const options = projectIdInput.closest('details'); if (options) options.open = true;
        projectIdInput.focus();
      }
      return;
    }
    if (generation !== generateGeneration) return;
    const unchecked: string[] = [];
    for (const box of logoList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (!box.checked) unchecked.push(box.value);
    }
    const snapshotImports = logoImports.filter((entry) => !unchecked.includes(entry.id));
    if (issued.project.logos.length + snapshotImports.length > 64) {
      generateStatus.textContent = 'Issue rejected: at most 64 logos';
      return;
    }
    for (const imported of snapshotImports) {
      issued.project.logos.push({
        schemaVersion: issued.project.schemaVersion,
        id: imported.id,
        name: imported.name,
        role: 'original',
        assets: [{
          uri: importedLogoPath(imported),
          role: 'original',
          mediaType: imported.mediaType,
          widthPx: imported.widthPx,
          heightPx: imported.heightPx,
        }],
      });
    }
    const mergedValidation = validateLogos(issued.project.logos);
    if (!mergedValidation.ok) {
      generateStatus.textContent = `Issue rejected: ${mergedValidation.errors.map((error) => error.message).join('; ')}`;
      return;
    }
    for (const imported of snapshotImports) {
      const digest = await hasher.sha256Bytes(imported.bytes);
      if (generation !== generateGeneration) return;
      issued.project.logos.find((entry) => entry.id === imported.id)!.assets[0]!.sha256Hex = digest;
    }
    const importedAssets = snapshotImports.map((imported) => ({ path: importedLogoPath(imported), bytes: imported.bytes }));
    const issuedAssets = selectIssuedAssets(
      [...snapshot.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes })), ...importedAssets],
      issued.project,
    );
    // Presentation-only passthrough: optional presentation/ reference assets
    // travel as additional entries. Validated at render; never production.
    // Multiview additions made in this session merge with (never replace)
    // any package-present presentation assets, including the session manifest.
    const sessionManifest = addedPresentations.length > 0
      ? source.assets.find((asset) => asset.path === PRESENTATION_MANIFEST_PATH)?.bytes
      : undefined;
    // Session visual-trial mappings (Choose-items mapping setup): staged
    // operator entries merge over any package-present photo-mappings file by
    // exact key, then travel through the existing
    // selectPresentationPackageAssets filter below into the issued package as
    // additional presentation/photo-mappings.json. An empty staged set leaves
    // the inputs untouched.
    const stagedMappingBytes = stagedPhotoMappings.length > 0
      ? serializePhotoMappings(mergeSessionPhotoMappings(
        parsePhotoMappings(snapshot.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes),
        stagedPhotoMappings,
      ))
      : null;
    const mergedPresentationInputs = [
      ...snapshot.assets.filter((asset) => stagedMappingBytes === null || asset.path !== PHOTO_MAPPINGS_PATH),
      ...(sessionManifest ? [{ path: PRESENTATION_MANIFEST_PATH, bytes: sessionManifest, kind: 'additional' as const }] : []),
      ...addedPresentations.flatMap((entry) => entry.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes, kind: 'additional' as const }))),
      ...(stagedMappingBytes !== null ? [{ path: PHOTO_MAPPINGS_PATH, bytes: stagedMappingBytes, kind: 'additional' as const }] : []),
    ];
    const presentationAssets = selectPresentationPackageAssets(mergedPresentationInputs, issued.project.configurations);
    // Prepared-product evidence passthrough: bridge sidecars for issued
    // products travel as additional entries, plus the original area-bundle
    // exports paired at import time (derived evidence paths per issued
    // product). Evidence only, never geometry; sidecars are additionally
    // bound by their embedded product binding, never the filename.
    const preparedPaths = new Set<string>();
    for (const config of issued.project.configurations) {
      for (const evidencePath of Object.values(preparedEvidencePaths(config.productId))) preparedPaths.add(evidencePath);
    }
    const sidecarTexts: Array<{ path: string; text: string }> = [];
    for (const asset of snapshot.assets) {
      if (asset.kind !== 'additional') continue;
      if (!preparedPaths.has(asset.path)) continue;
      if (!asset.path.endsWith('.bridge-sidecar.json')) continue;
      try {
        sidecarTexts.push({ path: asset.path, text: new TextDecoder().decode(asset.bytes) });
      } catch {
        continue;
      }
    }
    const sidecarPaths = new Set(selectPreparedSidecarAssets(sidecarTexts, issued.project.configurations).map((entry) => entry.path));
    const evidenceAssets = snapshot.assets
      .filter((asset) => sidecarPaths.has(asset.path) || (preparedPaths.has(asset.path) && asset.path.endsWith('.area-bundle.json')))
      .map((asset) => ({ path: asset.path, bytes: asset.bytes }));
    const packageBytes = await createProjectPackage(
      { project: issued.project, assets: issuedAssets, additionalAssets: [...presentationAssets, ...evidenceAssets] },
      { sha256: hasher.sha256Bytes },
    );
    if (generation !== generateGeneration) return;
    const editorBytes = embeddedEditorBytes();
    if (generation !== generateGeneration) return;
    const jobPart = safeJobPart(identity.jobReference);
    const hybrid = formatHybrid.checked;
    let htmlBytes: Uint8Array;
    let zipBytes: Uint8Array | null = null;
    if (hybrid) {
      const names = ['OPEN_LOGO_CONFIGURATOR.html', `${jobPart}.logo-project`].sort();
      const entries: Record<string, Uint8Array> = {};
      for (const name of names) {
        entries[name] = name === 'OPEN_LOGO_CONFIGURATOR.html' ? editorBytes : packageBytes;
      }
      zipBytes = zipSync(entries, { level: 6, mtime: new Date(2000, 0, 1, 0, 0, 0) });
      htmlBytes = editorBytes;
    } else {
      htmlBytes = new Uint8Array(await createSelfContainedHtml({ html: editorBytes, projectPackage: packageBytes }));
    }
    if (generation !== generateGeneration) return;
    const retainedAssets: ProjectPackageAsset[] = [
      ...issuedAssets.map((asset) => ({
        path: asset.path,
        bytes: asset.bytes,
        kind: 'referenced' as const,
      })),
      ...presentationAssets.map((asset) => ({
        path: asset.path,
        bytes: asset.bytes,
        kind: 'additional' as const,
      })),
    ];
    generated = {
      format: hybrid ? 'hybrid' : 'self-contained',
      jobPart,
      packageBytes,
      htmlBytes,
      zipBytes,
      issuedProject: issued.project,
      issuedAssets: retainedAssets,
    };
    clearReturnReview();
    if (hybrid) {
      sizeEstimate.textContent =
        `Format: hybrid ZIP (${zipBytes!.length} bytes) with the configurator plus ${jobPart}.logo-project. The customer unzips it, then opens the configurator and loads the project file.`;
    } else {
      sizeEstimate.textContent =
        `Format: one file (${htmlBytes.length} bytes). The customer opens OPEN_LOGO_CONFIGURATOR.html directly, nothing to unzip.`;
    }
    baselineStatus.textContent =
      `Office copy retained: revision 1 (${packageBytes.length} bytes). Save this exact file before closing the page; memory is lost on reload.`;
    generateStatus.textContent =
      `Customer file ready (revision 1) for ${identity.customerLabel} / ${identity.jobReference} by ${identity.issuedBy}. Earlier confirmations and office reviews stay in the office copy; this file starts unconfirmed.`;
    readySummary.textContent = `${identity.customerLabel} · ${identity.jobReference} · Prepared by ${identity.issuedBy}`;
    renderFileDetails(identity);
    sizeEstimate.textContent = `${hybrid ? 'ZIP package' : 'Ready-to-open customer file'} · ${((hybrid ? zipBytes!.length : htmlBytes.length) / 1024 / 1024).toFixed(1)} MB. ${hybrid ? 'Ask the customer to unzip it first.' : 'The customer opens it directly.'}`;
    showStep('prepare', 'send');
  } catch (error) {
    if (generation === generateGeneration) {
      generated = null;
      sizeEstimate.textContent = 'No issued package generated yet.';
      baselineStatus.textContent = 'No office copy retained; generate a package first.';
      generateStatus.textContent = `Generation failed: ${error instanceof Error ? error.message : String(error)}`;
      alertBuilder('The customer file could not be created. Please try again. Your source project is unchanged.');
    }
  } finally {
    if (generation === generateGeneration) {
      generating = false;
      updateControls();
    }
  }
}

function downloadBytes(bytes: Uint8Array, fileName: string, mime: string): void {
  const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function downloadMasterFile(): Promise<void> {
  if (source === null || loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy) return;
  const snapshot = source;
  if (snapshot.project.products.length === 0) {
    masterStatus.textContent = 'Nothing to save yet: add a real product first. Empty drafts carry no package.';
    return;
  }
  const stem = snapshot.fileName.replace(/\.(logo-project|zip)$/i, '');
  const stemSafe = safeJobPart(stem);
  const fileName = `${looksLikeUuid(stemSafe) || stemSafe === 'project' ? 'prepared-master' : `${stemSafe}-prepared-master`}.logo-project`;
  // No staged mappings: the current source package bytes travel verbatim
  // (byte-identical). Staged photo mappings are operator data that must not
  // be silently dropped: rebuild the package with the merged mappings file
  // (original binaries verbatim, canonical project unchanged) and reparse to
  // verify before downloading. The reopened master then restores the mapping
  // setup, so issuing needs no re-entry. Authored prepare anchors travel the
  // same way as a versioned digest-bound sidecar, reloaded on open.
  const packagedSidecar = snapshot.assets.find((asset) => asset.path === OPERATION_ANCHORS_PATH && asset.kind === 'additional');
  if (stagedPhotoMappings.length === 0 && prepareAnchors.length === 0 && packagedSidecar === undefined) {
    downloadBytes(snapshot.packageBytes, fileName, 'application/zip');
    masterStatus.textContent =
      `Saved prepared master (${snapshot.packageBytes.length} bytes): the current source package, byte-identical. Reopen it with “Open an existing project” to continue.`;
    return;
  }
  masterStatus.textContent = 'Adding staged photo mappings and prepared anchors to the prepared master…';
  try {
    const base = parsePhotoMappings(snapshot.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes);
    const merged = mergeSessionPhotoMappings(base, stagedPhotoMappings);
    // An empty merge serializes to bytes the parser reads as absent, so the
    // mappings file is omitted entirely when nothing is mapped (e.g. every
    // mapping was retired by a photo replacement); the anchors sidecar below
    // still travels.
    const mergedBytes = merged.mappings.length > 0 ? serializePhotoMappings(merged) : null;
    if (mergedBytes !== null) {
      const reparsed = parsePhotoMappings(mergedBytes);
      if (!reparsed || reparsed.mappings.length !== merged.mappings.length) {
        throw new Error('staged mappings did not serialize');
      }
    }
    const additionalAssets = [
      ...snapshot.assets.filter((asset) => asset.kind === 'additional' && asset.path !== PHOTO_MAPPINGS_PATH && asset.path !== OPERATION_ANCHORS_PATH).map(({ path, bytes }) => ({ path, bytes })),
      ...(mergedBytes !== null ? [{ path: PHOTO_MAPPINGS_PATH, bytes: mergedBytes }] : []),
    ];
    let sidecarNote = '';
    if (prepareAnchors.length > 0) {
      const digest = await hasher.prepareProject(snapshot.project);
      additionalAssets.push({ path: OPERATION_ANCHORS_PATH, bytes: buildAnchorsSidecarBytes(snapshot.project, digest, prepareAnchors) });
      sidecarNote = ` with ${prepareAnchors.length} prepared anchor(s)`;
    } else if (packagedSidecar !== undefined) {
      additionalAssets.push({ path: packagedSidecar.path, bytes: packagedSidecar.bytes });
      sidecarNote = ' with the packaged anchors sidecar';
    }
    const rebuilt = await createProjectPackage(
      {
        project: snapshot.project,
        assets: snapshot.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes })),
        additionalAssets,
      },
      { sha256: hasher.sha256Bytes },
    );
    const back = await parseProjectPackage(rebuilt, { sha256: hasher.sha256Bytes });
    assertProjectEditorLimits(back.project);
    if (canonicalize(back.project) !== canonicalize(snapshot.project)) {
      throw new Error('reparse changed the project');
    }
    const backMappings = parsePhotoMappings(back.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH)?.bytes);
    if (merged.mappings.length > 0 && (!backMappings || backMappings.mappings.length !== merged.mappings.length)) {
      throw new Error('reparse lost staged mappings');
    }
    if (prepareAnchors.length > 0 && back.assets.find((asset) => asset.path === OPERATION_ANCHORS_PATH) === undefined) {
      throw new Error('reparse lost the anchors sidecar');
    }
    downloadBytes(rebuilt, fileName, 'application/zip');
    masterStatus.textContent =
      `Saved prepared master (${rebuilt.length} bytes) with ${merged.mappings.length} photo mapping(s)${sidecarNote}: original binaries verbatim, project unchanged. Reopen it with “Open an existing project” — anchors, mappings and setup need no re-entry.`;
  } catch (error) {
    masterStatus.textContent =
      `Prepared master was not saved: ${error instanceof Error ? error.message : String(error)}. The previous source and staged mappings are unchanged.`;
  }
}

function downloadPackageFile(): void {
  if (generated === null || loading || generating || returnBusy || baselineBusy) return;
  if (generated.format === 'hybrid' && generated.zipBytes !== null) {
    downloadBytes(generated.zipBytes, `${generated.jobPart}.zip`, 'application/zip');
    generateStatus.textContent = `Download started: ${generated.jobPart}.zip (${generated.zipBytes.length} bytes). Attach it to your normal handoff yourself.`;
  } else {
    downloadBytes(generated.htmlBytes, 'OPEN_LOGO_CONFIGURATOR.html', 'text/html');
    generateStatus.textContent = `Download started: OPEN_LOGO_CONFIGURATOR.html (${generated.htmlBytes.length} bytes). The customer opens this file directly, nothing to unzip.`;
  }
}

function downloadHtmlFile(): void {
  if (generated === null || loading || generating || returnBusy || baselineBusy) return;
  if (generated.format === 'hybrid') {
    downloadBytes(generated.htmlBytes, 'OPEN_LOGO_CONFIGURATOR.html', 'text/html');
    generateStatus.textContent = `Download started: OPEN_LOGO_CONFIGURATOR.html (${generated.htmlBytes.length} bytes) on its own.`;
  } else {
    downloadBytes(generated.packageBytes, `${generated.jobPart}.logo-project`, 'application/zip');
    generateStatus.textContent = `Download started: ${generated.jobPart}.logo-project (${generated.packageBytes.length} bytes) on its own.`;
  }
}

function downloadBaselineFile(): void {
  if (loading || generating || creating || logoImporting || returnBusy || baselineBusy) return;
  const baseline = activeBaseline();
  if (baseline === null) return;
  downloadBytes(baseline.packageBytes, `${baseline.jobPart}-issued-baseline.logo-project`, 'application/zip');
  baselineStatus.textContent =
    `Download started: office copy (${baseline.packageBytes.length} bytes). Save it before closing the page; memory is lost on reload.`;
}

function compareAssetBytes(issued: readonly ProjectPackageAsset[], back: readonly ProjectPackageAsset[]): string[] {
  // Map lookups (never `{}` indexing): punctuated or hostile ids such as
  // `__proto__`/`constructor` must compare as data, not prototype members.
  const issuedByPath = new Map(issued.map((asset) => [asset.path, asset] as const));
  const returnedByPath = new Map(back.map((asset) => [asset.path, asset] as const));
  const paths = new Set([...issuedByPath.keys(), ...returnedByPath.keys()]);
  const errors: string[] = [];
  for (const path of [...paths].sort()) {
    const original = issuedByPath.get(path);
    const candidate = returnedByPath.get(path);
    if (original === undefined || candidate === undefined) {
      errors.push(`${path}: asset is missing from ${original !== undefined ? 'the return' : 'the issued baseline'}`);
      continue;
    }
    if (original.bytes.length !== candidate.bytes.length) {
      errors.push(`${path}: asset kind or bytes differ from the issued baseline`);
      continue;
    }
    let equal = true;
    for (let index = 0; index < original.bytes.length; index += 1) {
      if (original.bytes[index] !== candidate.bytes[index]) {
        equal = false;
        break;
      }
    }
    if (original.kind !== candidate.kind || !equal) {
      errors.push(`${path}: asset kind or bytes differ from the issued baseline`);
    }
  }
  return errors;
}
function placementLabel(placement: Placement, index: number): string {
  const instruction = placement.instructions ? `; instructions: ${placement.instructions}` : '';
  return `${index + 1}. logo ${placement.logoId}, region ${placement.regionId}, ${placement.method}; centre (${displayMm(placement.pos.xMm)}, ${displayMm(placement.pos.yMm)}) mm; ${displayMm(placement.widthMm)} × ${displayMm(placement.heightMm)} mm; clockwise ${displayMm(placement.rotationDeg)}°${instruction}`;
}

function configurationDescription(configuration: Configuration | undefined): string {
  if (!configuration) return 'Configuration absent';
  if (configuration.placements.length === 0) return `${configuration.productId}/${configuration.variantId}: 0 placements`;
  return `${configuration.productId}/${configuration.variantId}\n${configuration.placements.map(placementLabel).join('\n')}`;
}


function differenceLines(issued: ProjectDocument, back: ProjectDocument): string[] {
  // Map lookups (never `{}` indexing): `__proto__`/punctuation config IDs
  // must compare as data, not prototype members.
  const issuedById = new Map(issued.configurations.map((configuration) => [configuration.id, configuration] as const));
  const returnedById = new Map(back.configurations.map((configuration) => [configuration.id, configuration] as const));
  const ids = new Set([...issuedById.keys(), ...returnedById.keys()]);
  const rows: string[] = [];
  for (const id of [...ids].sort()) {
    const original = issuedById.get(id);
    const candidate = returnedById.get(id);
    if (canonicalize(original ?? null) !== canonicalize(candidate ?? null)) {
      rows.push(`${id}\nISSUED\n${configurationDescription(original)}\nRETURNED\n${configurationDescription(candidate)}`);
    }
  }
  if (issued.instructions !== back.instructions) {
    rows.push(`PROJECT INSTRUCTIONS\nISSUED\n${issued.instructions ?? '(none)'}\nRETURNED\n${back.instructions ?? '(none)'}`);
  }
  return rows.length > 0 ? rows : ['No configuration or instruction differences from the issued baseline.'];
}

/** Office-perspective one-line return summary (diagnostics keep exact internals). */
function ticketSummaryText(imported: ProjectDocument, candidateDigest: string): string {
  const decision = imported.review !== undefined ? imported.review.decision : 'pending (no current internal review)';
  return (
    `Project ${imported.projectId}; revision ${imported.revision}; candidate digest ${candidateDigest}; confirmation ${imported.confirmation === undefined ? 'none' : `rev ${imported.confirmation.revision} by ${imported.confirmation.confirmedBy}`} (timestamp source: returned confirmation envelope); decision ${decision}.`
  );
}

function confirmationLine(imported: ProjectDocument, digest: string): string {
  if (imported.confirmation === undefined) return 'Customer confirmation: none; draft only.';
  // The confirmation timestamp is customer-supplied evidence carried in the
  // returned project (`confirmation.confirmedAt`); its source is stated here.
  const at = ` at ${imported.confirmation.confirmedAt} (timestamp from the returned confirmation envelope)`;
  if (imported.confirmation.revision === imported.revision && imported.confirmation.digest === digest) {
    return `Customer confirmation: current for revision ${imported.confirmation.revision}; confirmed by ${imported.confirmation.confirmedBy}${at} (unverified identity).`;
  }
  return `Customer confirmation: stale or mismatched confirmation for revision ${imported.confirmation.revision}; not trusted. Confirmed by ${imported.confirmation.confirmedBy}${at} (unverified identity).`;
}

function geometryLine(imported: ProjectDocument): { text: string; ok: boolean } {
  const verdict = evaluateProjectGeometry(imported);
  if (verdict.placements.length === 0) {
    return { text: 'Geometry: valid; no placements, so no geometric restrictions apply.', ok: verdict.ok };
  }
  const failures = verdict.placements.filter((item) => !item.ok);
  if (failures.length === 0) {
    return {
      text: `Geometry: valid; ${verdict.placements.length} measured footprint(s) fit their safe regions and avoid exclusions.`,
      ok: true,
    };
  }
  return {
    text: `Geometry: invalid; ${failures.map((item) => `${item.configurationId}/${item.placementId ?? `Placement ${item.placementIndex + 1}`}: ${item.reason}`).join('; ')}`,
    ok: false,
  };
}

function ensureOperationStyles(): void {
  const id = 'internal-builder-operation-styles';
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) { style = document.createElement('style'); style.id = id; document.head.append(style); }
  style.textContent = operationSheetStyles();
}

function safeJobPart(value: string): string {
  let part = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 96).replace(/[.-]+$/g, '') || 'project';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) part = `_${part}`;
  return part;
}

/** True for random-UUID handles: never shown in primary filenames or status. */
function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Human job handle for return-derived filenames: the office-copy filename
 * stem first (it survives reloads and carries the staff's own naming), then
 * the baseline job part, then a safe generic fallback. UUID-shaped values
 * are skipped at every step so no raw UUID lands in primary filenames.
 */
function stationJobPart(baselineFileName: string, jobPartFallback: string): string {
  const stem = baselineFileName.replace(/\.(logo-project|zip)$/i, '').replace(/-issued-baseline$/i, '');
  for (const value of [stem, jobPartFallback]) {
    const safe = safeJobPart(value);
    if (safe !== 'project' && !looksLikeUuid(safe)) return safe;
  }
  return 'station-return';
}

async function loadBaselineFile(file: File): Promise<void> {
  alertBuilder();
  const generation = ++baselineGeneration;
  generateGeneration += 1;
  generating = false;
  returnGeneration += 1;
  returnBusy = false;
  baselineBusy = true;
  updateControls();
  baselineLoadStatus.textContent = `Reading saved baseline ${file.name}…`;
  try {
    if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) throw new Error('archive size exceeds limit; rejected before reading');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (generation !== baselineGeneration) return;
    const parsed = await parseProjectPackage(bytes, { sha256: hasher.sha256Bytes });
    if (generation !== baselineGeneration) return;
    assertProjectEditorLimits(parsed.project);
    loadedBaseline = { fileName: file.name, jobPart: safeJobPart(parsed.project.projectId), packageBytes: bytes.slice(), issuedProject: parsed.project, issuedAssets: parsed.assets };
    // Selecting a saved baseline explicitly switches review context away from any generated delivery.
    clearGeneratedOutputs();
    baselineLoadStatus.textContent = `Loaded office copy ${file.name} (revision ${parsed.project.revision}, ${bytes.length} bytes). Return review is now available.`;
    showStep('review', 'return');
  } catch (error) {
    if (generation === baselineGeneration) {
      baselineLoadStatus.textContent = `Could not load baseline ${file.name}: ${error instanceof Error ? error.message : String(error)}. The previous baseline remains unchanged.`;
      alertBuilder(`Could not open office copy ${file.name}. Choose the original file saved for this job. Your previous copy is unchanged.`);
    }
  } finally {
    if (generation === baselineGeneration) { baselineBusy = false; updateControls(); }
  }
}

function onBaselineFileChange(): void {
  const file = baselineFile.files?.[0];
  if (file) void loadBaselineFile(file);
  baselineFile.value = '';
}

/**
 * Shared refresh after the in-memory return project is (re)placed: rebuilds
 * the digest, candidate export, diffs, operation views, sheet authoring and
 * the proposal editor from `lastReturn.imported`. Used both for fresh return
 * imports and in-station revised proposals, so office corrections share the
 * exact validated state as the import path. Returns false when superseded.
 */
async function finalizeReturnState(input: {
  /** Validated return project to display (fresh import or revised proposal). */
  imported: ProjectDocument;
  baselineIssued: ProjectDocument;
  jobPart: string;
  baselineFileName: string;
  returnFileName: string;
  /** Return package assets (referenced + additional) for rebuilds/downloads. */
  packageAssets: ProjectPackageAsset[];
  reviewTimestamp: string;
  statusMessage: string;
  generation: number;
}): Promise<boolean> {
  const geometry = geometryLine(input.imported);
  if (input.generation !== returnGeneration) return false;
  const digest = await hasher.prepareProject(input.imported);
  if (input.generation !== returnGeneration) return false;
  const candidate: ResultCandidate = buildCandidateExport(input.imported, hasher.sha256Hex);
  const serialized = serializeExport(candidate);
  if (input.generation !== returnGeneration) return false;
  const snapshot: ReturnState = {
    imported: input.imported,
    candidate,
    contentDigest: digest,
    serializedCandidate: serialized,
    candidateFileName: '',
    jobPart: stationJobPart(input.baselineFileName, input.jobPart),
    packageAssets: input.packageAssets,
    geometryOk: geometry.ok,
    returnFileName: input.returnFileName,
    baselineFileName: input.baselineFileName,
    reviewTimestamp: input.reviewTimestamp,
  };
  lastReturn = snapshot;
  snapshot.candidateFileName = `${snapshot.jobPart}-r${snapshot.imported.revision}-candidate.json`;
  const imported = snapshot.imported;
  reviewPanel.hidden = false;
  for (const node of reviewPanel.querySelectorAll('[data-builder-dynamic]')) node.remove();
  const anchor = ticketSummary;
  const confirmation = document.createElement('p');
  confirmation.setAttribute('data-builder-dynamic', 'true');
  confirmation.textContent = confirmationLine(imported, digest);
  const geometrySummary = document.createElement('p');
  geometrySummary.setAttribute('data-builder-dynamic', 'true');
  geometrySummary.textContent = geometry.text;
  const differenceText = differenceLines(input.baselineIssued, imported);
  const differences = document.createElement('pre');
  differences.setAttribute('data-builder-dynamic', 'true');
  differences.textContent = differenceText.join('\n\n');
  reviewPanel.insertBefore(confirmation, anchor);
  reviewPanel.insertBefore(geometrySummary, anchor);
  reviewPanel.insertBefore(differences, anchor);
  renderReviewFiles();
  renderReviewChanges(input.baselineIssued);
  decisionChoice.value = 'pending';
  decisionNote.value = '';
  decisionStatus.textContent = '';
  renderStationDecision();
  ticketSummary.textContent = ticketSummaryText(imported, candidate.digest);
  // Handoff summary: real filenames, exact candidate name, operator
  // Print/Save-as-PDF instructions; customer delivery (ZIP/HTML) vs
  // production attachments (candidate JSON + printed PDF); no Odoo.
  handoffSummary.textContent =
    `Return file: ${input.returnFileName}. Baseline file: ${input.baselineFileName}. Candidate file: ${snapshot.candidateFileName}. ` +
    `Press “Print operation document”, then choose Print / Save as PDF in the browser dialog; attach the candidate JSON plus the printed PDF to the production ticket/BoM. ` +
    `Customer delivery files (${generated !== null ? (generated.format === 'hybrid' ? `${generated.jobPart}.zip + OPEN_LOGO_CONFIGURATOR.html` : `OPEN_LOGO_CONFIGURATOR.html (self-contained, embeds ${generated.jobPart}.logo-project)`) : 'none generated this session'}) are separate from these production attachments. ` +
    `Reviewed ${input.reviewTimestamp} (local browser clock). No Odoo calls were made; manual attachment is the only handoff.`;
  operationContainer.replaceChildren();
  const returnAssetBytes = new Map(snapshot.packageAssets.map((asset) => [asset.path, asset.bytes]));
  const returnManifestBytes = returnAssetBytes.get('presentation/preview.json');
  const returnSelections = selectOperationReferenceViews(
    candidate.configurations,
    returnManifestBytes,
    returnManifestBytes !== undefined,
    { getBytes: (path) => returnAssetBytes.get(path) },
  );
  const returnReferenceViews: Record<string, readonly ReferenceViewInput[]> = Object.create(null);
  for (const [id, selection] of Object.entries(returnSelections)) {
    returnReferenceViews[id] = selection.views;
  }
  lastReturnAssets = returnAssetBytes;
  lastReturnReferenceViews = returnReferenceViews;
  initSheetAuthoring(candidate);
  renderSheetPreview();
  renderProposalEditor();
  operationContainer.hidden = false;
  returnStatus.textContent = input.statusMessage;
  showStep('review', 'check');
  return true;
}

async function loadReturnFile(file: File): Promise<void> {
  alertBuilder();
  const generation = ++returnGeneration;
  if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    returnBusy = false;
    updateControls();
    returnStatus.textContent = `Could not import return ${file.name}: archive size exceeds limit; rejected before reading.`;
    alertBuilder('This return file is too large. Choose a valid project return.');
    return;
  }
  returnBusy = true;
  updateControls();
  returnStatus.textContent = `Reading return ${file.name}…`;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (generation !== returnGeneration) return;
    returnBusy = false;
    updateControls();
    const detail = error instanceof Error ? error.message : String(error);
    returnStatus.textContent = `Could not import return ${file.name}: file read failed: ${detail}.`;
    alertBuilder('This return file could not be read. Please choose it again.');
    return;
  }
  if (generation !== returnGeneration) return;
  try {
    const baseline = activeBaseline();
    if (baseline === null) {
      returnStatus.textContent = 'No issued baseline available; generate a package or choose a saved baseline first.';
      return;
    }
    if (bytes.length > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
      throw new Error(`archive size ${bytes.length} exceeds ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes} bytes; rejected before parsing`);
    }
    const parsed = await parseProjectPackage(bytes, { sha256: hasher.sha256Bytes });
    if (generation !== returnGeneration) return;
    assertProjectEditorLimits(parsed.project);
    if (generation !== returnGeneration) return;
    const assetErrors = compareAssetBytes(baseline.issuedAssets, parsed.assets);
    if (assetErrors.length > 0) {
      throw new Error(`asset comparison differs from the issued baseline: ${assetErrors.join('; ')}`);
    }
    await hasher.prepareProject(baseline.issuedProject);
    const digest = await hasher.prepareProject(parsed.project);
    if (generation !== returnGeneration) return;
    const outcome = importCustomerReturn(parsed.project, baseline.issuedProject, hasher.sha256Hex);
    if (!outcome.ok) {
      throw new Error(outcome.errors.map((error) => `${error.code}: ${error.message}`).join('; '));
    }
    const imported = outcome.project;
    const reviewTimestamp = new Date().toISOString();
    if (generation !== returnGeneration) return;
    await finalizeReturnState({
      imported,
      baselineIssued: baseline.issuedProject,
      jobPart: baseline.jobPart,
      baselineFileName: baseline.fileName,
      returnFileName: file.name,
      packageAssets: parsed.assets.slice(),
      reviewTimestamp,
      statusMessage: 'Return imported against the active issued baseline. Internal review is pending.',
      generation,
    });
  } catch (error) {
    if (generation !== returnGeneration) return;
    returnStatus.textContent = `Could not import return ${file.name}: ${error instanceof Error ? error.message : String(error)}. The previous valid review remains unchanged.`;
    alertBuilder(`Could not check ${file.name}. Make sure the office copy and customer return belong to the same job. The previous valid check is unchanged.`);
  } finally {
    if (generation === returnGeneration) {
      returnBusy = false;
      updateControls();
    }
  }
}

function onReturnFileChange(): void {
  const file = returnFile.files?.[0];
  if (file) void loadReturnFile(file);
  returnFile.value = '';
}

/** True when the customer confirmation matches this exact update. */
function stationConfirmationCurrent(snapshot: ReturnState): boolean {
  const confirmation = snapshot.imported.confirmation;
  return confirmation !== undefined &&
    confirmation.revision === snapshot.imported.revision &&
    confirmation.digest === snapshot.contentDigest;
}

/** True when a recorded office decision covers this exact update. */
function hasCurrentStationReview(): boolean {
  if (lastReturn === null || lastReturn.imported.review === undefined) return false;
  const review = lastReturn.imported.review;
  return review.revision === lastReturn.imported.revision && review.digest === lastReturn.contentDigest;
}

/** Human-readable office decision for the current update (no digests/IDs). */
function renderStationDecision(): void {
  if (lastReturn === null) {
    decisionCurrent.textContent = 'No return imported.';
    return;
  }
  const review = lastReturn.imported.review;
  if (review === undefined) {
    decisionCurrent.textContent = `No office decision recorded yet for update ${lastReturn.imported.revision}.`;
    return;
  }
  const current = review.revision === lastReturn.imported.revision && review.digest === lastReturn.contentDigest;
  decisionCurrent.textContent =
    `${current ? 'Current' : 'Outdated'} office decision: ${review.decision} for update ${review.revision}, by ${review.reviewer} at ${review.at}.${review.note === undefined ? '' : ` Note: ${review.note}`}`;
}

async function recordStationReview(): Promise<void> {
  if (lastReturn === null || loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy) return;
  const snapshot = lastReturn;
  const reviewer = decisionReviewer.value.trim();
  const decision = decisionChoice.value as ReviewDecision;
  const note = decisionNote.value;
  if (reviewer === '') {
    decisionStatus.textContent = 'Type your reviewer name before recording a decision.';
    return;
  }
  if (decision === 'approved' && (!snapshot.geometryOk || !stationConfirmationCurrent(snapshot))) {
    decisionStatus.textContent = 'Approval is blocked: the customer confirmation must match this exact update, and every logo must fit its allowed area.';
    return;
  }
  returnBusy = true;
  updateControls();
  try {
    const digest = await hasher.prepareProject(snapshot.imported);
    if (lastReturn !== snapshot) return;
    if (digest !== snapshot.contentDigest || !validateProject(snapshot.imported).ok ||
      (decision === 'approved' && !evaluateProjectGeometry(snapshot.imported).ok)) {
      decisionStatus.textContent = 'Decision blocked: the update changed while you were reviewing. Check the latest values and try again.';
      return;
    }
    const outcome = recordInternalReview(snapshot.imported, {
      decision,
      reviewer,
      digestOf: digest,
      ...(note === '' ? {} : { note }),
    }, hasher.sha256Hex);
    if (lastReturn !== snapshot) return;
    if (!outcome.ok) {
      decisionStatus.textContent = `Decision was not recorded: ${outcome.errors.map((error) => error.message).join('; ')}`;
      return;
    }
    renderStationDecision();
    ticketSummary.textContent = ticketSummaryText(snapshot.imported, snapshot.candidate.digest);
    decisionStatus.textContent = `Recorded ${decision} for update ${snapshot.imported.revision}. This is internal workflow bookkeeping, not a production release.`;
  } catch (error) {
    if (lastReturn === snapshot) {
      decisionStatus.textContent = `Decision failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (lastReturn === snapshot) {
      returnBusy = false;
      updateControls();
    }
  }
}

async function downloadReviewedReturn(): Promise<void> {
  if (lastReturn === null || loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy) return;
  const snapshot = lastReturn;
  if (!hasCurrentStationReview()) {
    decisionStatus.textContent = 'Record a current office decision before saving the reviewed return.';
    return;
  }
  returnBusy = true;
  updateControls();
  try {
    const referenced: ProjectPackageAssetInput[] = [];
    const additional: ProjectPackageAssetInput[] = [];
    for (const asset of snapshot.packageAssets) {
      (asset.kind === 'referenced' ? referenced : additional).push({ path: asset.path, bytes: asset.bytes });
    }
    const bytes = await createProjectPackage({
      project: snapshot.imported,
      assets: referenced,
      additionalAssets: additional,
    }, { sha256: hasher.sha256Bytes });
    if (lastReturn !== snapshot) {
      decisionStatus.textContent = 'Save discarded because the reviewed update changed while its file was being prepared.';
      return;
    }
    const fileName = `${snapshot.jobPart}-r${snapshot.imported.revision}-reviewed.logo-project`;
    downloadBytes(bytes, fileName, 'application/zip');
    decisionStatus.textContent = `Saved ${fileName} (${bytes.length} bytes). Keep it with the office copy.`;
  } catch (error) {
    if (lastReturn === snapshot) {
      decisionStatus.textContent = `Reviewed return could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (lastReturn === snapshot) {
      returnBusy = false;
      updateControls();
    }
  }
}

/** Human label for a placement row: position, artwork and area names. */
function proposalPlacementLabel(configId: string, index: number): string {
  const imported = lastReturn?.imported;
  const configuration = imported?.configurations.find((entry) => entry.id === configId);
  const placement = configuration?.placements[index];
  if (placement === undefined) return `Placement ${index + 1}`;
  const product = imported?.products.find((entry) => entry.id === configuration?.productId);
  const region = product?.regions.find((entry) => entry.id === placement.regionId);
  const logo = imported?.logos.find((entry) => entry.id === placement.logoId);
  return `${index + 1}. ${logo?.name ?? placement.logoId} — ${region?.name ?? placement.regionId}`;
}

function refillProposalInputs(): void {
  const imported = lastReturn?.imported;
  const configuration = imported?.configurations.find((entry) => entry.id === proposalConfig.value);
  const placement = configuration?.placements[Number(proposalPlacement.value)];
  const set = (input: HTMLInputElement, value: string): void => {
    if (document.activeElement !== input) input.value = value;
  };
  set(proposalX, placement === undefined ? '' : String(placement.pos.xMm));
  set(proposalY, placement === undefined ? '' : String(placement.pos.yMm));
  set(proposalWidth, placement === undefined ? '' : String(placement.widthMm));
  set(proposalHeight, placement === undefined ? '' : String(placement.heightMm));
  set(proposalRotation, placement === undefined ? '' : String(placement.rotationDeg));
  if (document.activeElement !== proposalInstructions) proposalInstructions.value = imported?.instructions ?? '';
}

function refillProposalPlacements(keep?: string): void {
  const selected = keep ?? proposalPlacement.value;
  proposalPlacement.replaceChildren();
  const imported = lastReturn?.imported;
  const configuration = imported?.configurations.find((entry) => entry.id === proposalConfig.value);
  for (const [index] of (configuration?.placements ?? []).entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = proposalPlacementLabel(configuration!.id, index);
    proposalPlacement.append(option);
  }
  if ([...proposalPlacement.options].some((option) => option.value === selected)) proposalPlacement.value = selected;
  refillProposalInputs();
}

function renderProposalEditor(): void {
  const keepConfig = proposalConfig.value;
  const keepPlacement = proposalPlacement.value;
  proposalConfig.replaceChildren();
  proposalPlacement.replaceChildren();
  if (lastReturn === null) {
    proposalCurrent.textContent = 'No return imported.';
    for (const input of [proposalX, proposalY, proposalWidth, proposalHeight, proposalRotation]) input.value = '';
    proposalInstructions.value = '';
    return;
  }
  const imported = lastReturn.imported;
  for (const config of lastReturn.candidate.configurations) {
    const option = document.createElement('option');
    option.value = config.id;
    option.textContent = configDisplayName(config);
    proposalConfig.append(option);
  }
  if (lastReturn.candidate.configurations.some((config) => config.id === keepConfig)) proposalConfig.value = keepConfig;
  refillProposalPlacements(keepPlacement);
  proposalCurrent.textContent =
    `Update ${imported.revision}: ${imported.configurations.length} product option(s). Applying creates update ${imported.revision + 1}.`;
}

/**
 * Human-readable geometry refusal for the proposal status line: product /
 * option / logo names plus the domain reason. Technical config/placement IDs
 * stay in the "File and measurement details" diagnostics, never here.
 */
function proposalFitFailures(
  snapshot: ReturnState,
  fit: { placements: Array<{ ok: boolean; configurationId: string; placementIndex: number; reason: string }> },
): string {
  return fit.placements.filter((item) => !item.ok).map((item) => {
    const configuration = snapshot.imported.configurations.find((entry) => entry.id === item.configurationId);
    const product = snapshot.imported.products.find((entry) => entry.id === configuration?.productId);
    const variant = product?.variants.find((entry) => entry.id === configuration?.variantId);
    const placement = configuration?.placements[item.placementIndex];
    const logo = snapshot.imported.logos.find((entry) => entry.id === placement?.logoId);
    return `${product?.name ?? 'Unnamed product'} / ${variant?.name ?? 'unnamed option'} — ${logo?.name ?? 'unnamed logo'}: ${item.reason}`;
  }).join('; ');
}

/** Read one proposal number with the reviewer's finite-number wording. */
function readProposalNumber(input: HTMLInputElement, label: string): number | null {
  if (input.value.trim() === '') {
    proposalStatus.textContent = `Revised proposal blocked: ${label} must be a finite number.`;
    return null;
  }
  const value = Number(input.value);
  if (!Number.isFinite(value)) {
    proposalStatus.textContent = `Revised proposal blocked: ${label} must be a finite number.`;
    return null;
  }
  return value;
}

/**
 * In-station revised proposal: office corrections to one placement's
 * geometry plus the customer-facing project note, applied as a new revision
 * through domain `newRevision` (confirmation/review history preserved,
 * current confirmation and review cleared). Geometry is gated exactly like
 * the reviewer: every logo must fit its allowed area.
 */
async function applyStationProposal(): Promise<void> {
  if (lastReturn === null || loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy) return;
  const snapshot = lastReturn;
  const generation = returnGeneration;
  const configuration = snapshot.imported.configurations.find((entry) => entry.id === proposalConfig.value);
  if (configuration === undefined) {
    proposalStatus.textContent = 'Choose a product option before applying.';
    return;
  }
  const placementIndex = Number(proposalPlacement.value);
  const placement = configuration.placements[placementIndex];
  let numbers: { xMm: number; yMm: number; widthMm: number; heightMm: number; rotationDeg: number } | null = null;
  if (placement !== undefined) {
    const xMm = readProposalNumber(proposalX, 'X centre (mm)');
    const yMm = readProposalNumber(proposalY, 'Y centre (mm)');
    const widthMm = readProposalNumber(proposalWidth, 'Width (mm)');
    const heightMm = readProposalNumber(proposalHeight, 'Height (mm)');
    const rotationDeg = readProposalNumber(proposalRotation, 'Clockwise rotation (°)');
    if (xMm === null || yMm === null || widthMm === null || heightMm === null || rotationDeg === null) return;
    numbers = { xMm, yMm, widthMm, heightMm, rotationDeg };
  }
  const instructions = proposalInstructions.value;
  const placementChanged = placement !== undefined && numbers !== null && (
    placement.pos.xMm !== numbers.xMm || placement.pos.yMm !== numbers.yMm ||
    placement.widthMm !== numbers.widthMm || placement.heightMm !== numbers.heightMm ||
    placement.rotationDeg !== numbers.rotationDeg
  );
  const instructionsChanged = (snapshot.imported.instructions ?? '') !== instructions;
  if (!placementChanged && !instructionsChanged) {
    proposalStatus.textContent = 'No changes to apply: the numbers and note already match this update.';
    return;
  }
  let next: ProjectDocument;
  try {
    next = newRevision(snapshot.imported, (draft) => {
      const draftConfiguration = draft.configurations.find((entry) => entry.id === configuration.id);
      if (draftConfiguration === undefined) throw new Error('Selected product option disappeared.');
      if (placement !== undefined && numbers !== null) {
        const current = draftConfiguration.placements[placementIndex];
        if (current === undefined) throw new Error('Selected logo placement disappeared.');
        draftConfiguration.placements[placementIndex] = {
          ...current,
          pos: { xMm: numbers.xMm, yMm: numbers.yMm },
          widthMm: numbers.widthMm,
          heightMm: numbers.heightMm,
          rotationDeg: numbers.rotationDeg,
        };
      }
      if (instructions === '') delete draft.instructions;
      else draft.instructions = instructions;
    });
  } catch (error) {
    proposalStatus.textContent = `Revised proposal was not created: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  const fit = evaluateProjectGeometry(next);
  if (!fit.ok) {
    proposalStatus.textContent = `Revised proposal blocked: ${proposalFitFailures(snapshot, fit)}. Every logo must fit its allowed area and avoid exclusion zones.`;
    return;
  }
  returnBusy = true;
  updateControls();
  try {
    if (lastReturn !== snapshot || generation !== returnGeneration) return;
    const baseline = activeBaseline();
    if (baseline === null) {
      proposalStatus.textContent = 'Office copy is no longer available; choose it again before applying.';
      return;
    }
    const applied = await finalizeReturnState({
      imported: next,
      baselineIssued: baseline.issuedProject,
      jobPart: baseline.jobPart,
      baselineFileName: baseline.fileName,
      returnFileName: snapshot.returnFileName,
      packageAssets: snapshot.packageAssets,
      reviewTimestamp: new Date().toISOString(),
      statusMessage: `Applied revised proposal as update ${next.revision}. Earlier confirmations and reviews stay in history; the new update needs customer confirmation before approval.`,
      generation,
    });
    if (!applied) return;
    proposalStatus.textContent =
      `Applied revised proposal as update ${next.revision}. Earlier confirmations and reviews stay in history; the new update needs customer confirmation before approval. Sheet drafts for the earlier update were cleared.`;
  } catch (error) {
    if (generation === returnGeneration) {
      proposalStatus.textContent = `Revised proposal failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    // finalizeReturnState replaces lastReturn, so ownership here is the
    // generation token (a newer load bumps it first and owns the flag).
    if (generation === returnGeneration) {
      returnBusy = false;
      updateControls();
    }
  }
}

async function downloadStationProposal(): Promise<void> {
  if (lastReturn === null || loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy) return;
  const snapshot = lastReturn;
  const generation = returnGeneration;
  returnBusy = true;
  updateControls();
  try {
    if (generation !== returnGeneration || lastReturn !== snapshot) return;
    const referenced: ProjectPackageAssetInput[] = [];
    const additional: ProjectPackageAssetInput[] = [];
    for (const asset of snapshot.packageAssets) {
      (asset.kind === 'referenced' ? referenced : additional).push({ path: asset.path, bytes: asset.bytes });
    }
    const bytes = await createProjectPackage({
      project: snapshot.imported,
      assets: referenced,
      additionalAssets: additional,
    }, { sha256: hasher.sha256Bytes });
    if (generation !== returnGeneration || lastReturn !== snapshot) {
      proposalStatus.textContent = 'Save discarded because the update changed while its file was being prepared.';
      return;
    }
    const fileName = `${snapshot.jobPart}-r${snapshot.imported.revision}-proposal.logo-project`;
    downloadBytes(bytes, fileName, 'application/zip');
    proposalStatus.textContent = `Saved ${fileName} (${bytes.length} bytes). Send it to the customer as the new update; the customer must confirm it before approval.`;
  } catch (error) {
    if (generation === returnGeneration && lastReturn === snapshot) {
      proposalStatus.textContent = `Revised proposal could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (generation === returnGeneration) {
      returnBusy = false;
      updateControls();
    }
  }
}

async function downloadCandidateFile(): Promise<void> {
  if (lastReturn === null || loading || generating || baselineBusy || returnBusy) return;
  const snapshot = lastReturn;
  const generation = returnGeneration;
  returnBusy = true;
  updateControls();
  try {
    if (generation !== returnGeneration || lastReturn !== snapshot) return;
    downloadBytes(new TextEncoder().encode(snapshot.serializedCandidate), snapshot.candidateFileName, 'application/json');
    returnStatus.textContent = `Download started: ${snapshot.candidateFileName}.`;
  } catch (error) {
    if (generation === returnGeneration && lastReturn === snapshot) {
      returnStatus.textContent = `Candidate download failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (generation === returnGeneration) {
      returnBusy = false;
      updateControls();
    }
  }
}

/**
 * Minimal focused operator handoff: business data only, no ids. Pure
 * mapping off the operation-sheet view (no core contract changes): ids,
 * digests, sides/paths, sourceNotes, positionText, unfinished, valueMm1,
 * touchesArtwork/artworkPoint and version strings are all omitted. Raw
 * candidate JSON stays available separately as the advanced diagnostic.
 */
interface OperatorExportMeasurement {
  anchor: string;
  logoEdge: string;
  distanceMm: number;
}
interface OperatorExportLogo {
  code: string;
  side: string;
  method: string;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
  methodParams?: Record<string, string>;
  colours?: string[];
  measurements: OperatorExportMeasurement[];
}
interface OperatorExportProduct {
  product: string;
  variant: string;
  logos: OperatorExportLogo[];
  instructions: string[];
}
interface OperatorExport {
  format: 'operation-export/1';
  job: { customer?: string; reference?: string; article?: string };
  products: OperatorExportProduct[];
}

function buildOperatorExport(view: OperationSheetView): OperatorExport {
  const job: OperatorExport['job'] = {};
  if (view.job.customer !== undefined && view.job.customer.trim() !== '') job.customer = view.job.customer.trim();
  if (view.job.reference !== undefined && view.job.reference.trim() !== '') job.reference = view.job.reference.trim();
  if (view.job.article !== undefined && view.job.article.trim() !== '') job.article = view.job.article.trim();
  return {
    format: 'operation-export/1',
    job,
    products: view.sheets.map((sheet) => ({
      product: sheet.productName ?? 'Product',
      variant: sheet.variantName ?? 'Unspecified variant',
      logos: sheet.logos.map((logo) => ({
        code: logo.logoCode,
        side: logo.side,
        method: logo.method,
        widthMm: logo.widthMm,
        heightMm: logo.heightMm,
        rotationDeg: logo.rotationDeg,
        ...(logo.methodParams !== undefined ? { methodParams: { ...logo.methodParams } } : {}),
        ...(logo.colours !== undefined ? { colours: [...logo.colours] } : {}),
        measurements: logo.dimensions.map((dimension) => ({
          anchor: dimension.fromAnchor,
          logoEdge: dimension.toEdge,
          distanceMm: dimension.valueMm,
        })),
      })),
      instructions: [...sheet.instructions],
    })),
  };
}

function downloadOperatorFile(): void {
  if (lastReturn === null || loading || generating || baselineBusy || returnBusy) return;
  const view = buildCurrentSheetView();
  if (view === null) return;
  const reference = view.job.reference?.trim() ?? '';
  const fileName = reference !== '' ? `${safeJobPart(reference)}-operator.json` : 'operation-sheet-operator.json';
  downloadBytes(new TextEncoder().encode(JSON.stringify(buildOperatorExport(view), null, 2)), fileName, 'application/json');
  returnStatus.textContent = `Download started: ${fileName}.`;
}

/**
 * Create a clean draft: no products, no logos, no example content. The draft
 * lives in memory only (no package exists yet — packaging requires at least
 * one product) until the operator adds a real product or imports one, which
 * repackages with the real content. Nothing is selected, generation stays
 * disabled until a real selection exists, and the master download refuses
 * while there is nothing to save.
 */
async function createEmptyProject(): Promise<void> {
  if (loading || generating || creating || baselineBusy || returnBusy) return;
  alertBuilder();
  const generation = ++createGeneration;
  // Starting a new job deliberately supersedes any unfinished artwork import.
  logoGeneration += 1; logoImporting = false;
  productGeneration += 1; productImporting = false;
  loadGeneration += 1;
  generateGeneration += 1;
  generating = false;
  creating = true;
  updateControls();
  createStatus.textContent = 'Creating a new empty draft…';
  try {
    const draft: ProjectDocument = {
      schemaVersion: '0.1.0-provisional',
      projectId: newLocalId(),
      revision: 1,
      products: [],
      logos: [],
      configurations: [],
    };
    if (generation !== createGeneration) return;
    assertProjectEditorLimits(draft);
    // No packaging yet: the domain requires at least one product per
    // package, and the draft deliberately has none. The project, selection
    // lists and workspace all handle the empty shape; the first Add or
    // import repackages with real content. Master download refuses while
    // there is nothing to save (see downloadMasterFile).
    const summary = summarizeSourceProject(draft);
    logoImports = [];
    sourceSession += 1;
    pendingPrimaryImage = null;
    pendingPrimaryModel = null;
    pendingViews = { front: null, back: null, left: null, right: null };
    addedPresentations = [];
    productStatus.textContent = '';
    productName.value = '';
    source = { fileName: 'empty-draft', project: draft, assets: [], summary, packageBytes: new Uint8Array(0) };
    configurationsTouched = false;
    renderSelectionLists(summary);
    stagedPhotoMappings = [];
    resetMappingSessionUI();
    guidedScale.hide();
    refreshWorkspace();
    refreshAddProductDisclosure();
    projectIdSuggestion.textContent = 'A fresh project ID was generated for this new draft. Enter a unique ID for this customer issue.';
    clearGeneratedOutputs();
    previewOnlyAck.checked = false;
    previewOnlyIds = [];
    customerName.value = '';
    jobRef.value = '';
    issuedBy.value = '';
    formatSelf.checked = true; formatHybrid.checked = false;
    projectIdInput.value = newLocalId(); lastAutoProjectId = projectIdInput.value;
    logoStatus.textContent = '';
    masterStatus.textContent = 'Empty draft ready. Stage a model, image or side views below, then Add product — nothing is pre-selected, nothing is synthetic.';
    createStatus.textContent = 'Created a new empty draft with no products. Stage product files below and Add product, or open an existing project file.';
    refreshSelectionValidation();
    showStep('prepare', 'choose');
  } catch (error) {
    if (generation === createGeneration) {
      createStatus.textContent = `Could not create a project: ${error instanceof Error ? error.message : String(error)}. Your previous project is still available.`;
      alertBuilder('The empty draft could not be created. Your previous project is still available.');
    }
  } finally {
    if (generation === createGeneration) { creating = false; updateControls(); }
  }
}
function importedLogoPath(imported: ImportedLogo): string {
  const extension = imported.mediaType === 'image/jpeg' ? 'jpg' : imported.mediaType === 'image/webp' ? 'webp' : 'png';
  return `logos/${imported.id}.${extension}`;
}
function readableLogoName(fileName: string): string {
  const trimmed = fileName.trim().replace(/\.[^.]*$/, '').replace(/[_\-\s]+/g, ' ').trim();
  return trimmed === '' ? 'Customer logo' : trimmed.slice(0, 80);
}
async function importLogoFile(file: File): Promise<void> {
  if (!source || loading || generating || creating || returnBusy || baselineBusy) return;
  alertBuilder();
  const generation = ++logoGeneration;
  logoImporting = true;
  updateControls();
  logoStatus.textContent = `Reading ${file.name}…`;
  try {
    if (file.size > MAX_PREVIEW_BYTES) throw new Error(`logo exceeds ${MAX_PREVIEW_BYTES} bytes; rejected before reading`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (generation !== logoGeneration) return;
    const header = readRasterHeader(bytes);
    if (header === null) throw new Error('unsupported or invalid image; choose a PNG, JPEG or WebP file');
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: header.mediaType }));
    const width = bitmap.width, height = bitmap.height; bitmap.close();
    if (generation !== logoGeneration) return;
    if (width !== header.width || height !== header.height) throw new Error('image dimensions could not be verified');
    if (source === null) throw new Error('create or open a project before adding a logo');
    let id: string;
    do { id = `customer-logo-${newLocalId()}`; } while (source.project.logos.some(logo => logo.id === id) || logoImports.some(logo => logo.id === id));
    logoImports.push({ id, name: readableLogoName(file.name), bytes: bytes.slice(), mediaType: header.mediaType, widthPx: header.width, heightPx: header.height });
    logoStatus.textContent = `Added ${file.name}. It is selected automatically; the customer places it later.`;
    renderSelectionLists(source.summary, true);
    refreshSelectionValidation();
  } catch (error) {
    if (generation === logoGeneration) {
      logoStatus.textContent = `Could not add ${file.name}: ${error instanceof Error ? error.message : String(error)}. Previous logos are unchanged.`;
      alertBuilder(`Could not add ${file.name}. Choose a PNG, JPEG or WebP image. Previous logos are unchanged.`);
    }
  } finally {
    if (generation === logoGeneration) { logoImporting = false; updateControls(); }
  }
}
function onLogoFileChange(): void {
  const file = logoFile.files?.[0];
  if (file) void importLogoFile(file);
  logoFile.value = '';
}

type ProductViewSide = 'front' | 'back' | 'left' | 'right';
const PRODUCT_VIEW_SIDES: ProductViewSide[] = ['front', 'back', 'left', 'right'];

function safeProductSegment(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return cleaned === '' ? 'product' : cleaned;
}

function pendingSummary(): string {
  const parts: string[] = [];
  if (pendingPrimaryModel) parts.push('3D model ready');
  if (pendingPrimaryImage) parts.push('flat image ready');
  for (const side of PRODUCT_VIEW_SIDES) {
    if (pendingViews[side]) parts.push(`${side} view ready`);
  }
  return parts.length ? ` Staged: ${parts.join(', ')}.` : '';
}

function looksRemoteFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:') || lower.startsWith('blob:') || fileName.includes('\\') || fileName.includes(':');
}

function extensionOfFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}


async function decodeAndVerifyRaster(bytes: Uint8Array, isCurrent: () => boolean): Promise<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number } | null> {
  const header = readRasterHeader(bytes);
  if (header === null) return null;
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: header.mediaType }));
  const width = bitmap.width; const height = bitmap.height; bitmap.close();
  if (!isCurrent()) return null;
  if (width !== header.width || height !== header.height) return null;
  return { mediaType: header.mediaType, width: header.width, height: header.height };
}

// Staging slots are independent inputs: each has its own token so assigning
// one side never discards another side's in-flight decode. Re-staging the
// same slot discards the older read for that slot only.
const stageTokens: Record<'primary' | ProductViewSide, number> = { primary: 0, front: 0, back: 0, left: 0, right: 0 };

function validateModelBytes(bytes: Uint8Array): string | null {
  let parsed: { json: unknown };
  try {
    parsed = parseGlb(bytes);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const blocking = validateSelfContained(parsed.json).filter((issue) => !issue.code.endsWith('-advisory'));
  if (blocking.length > 0) return blocking.map((issue) => `${issue.code} at ${issue.path}`).join('; ');
  return null;
}

async function stagePrimaryProductFile(file: File): Promise<void> {
  if (loading || generating || creating || logoImporting || returnBusy || baselineBusy) return;
  alertBuilder();
  const generation = ++productGeneration;
  const slot = ++stageTokens.primary;
  const isCurrent = (): boolean => generation === productGeneration && slot === stageTokens.primary;
  productImporting = true;
  updateControls();
  productStatus.textContent = `Reading ${file.name}…`;
  try {
    if (looksRemoteFileName(file.name)) throw new Error('file name looks like a remote reference; choose a local .glb/.png/.jpg/.jpeg/.webp file');
    const ext = extensionOfFileName(file.name);
    if (ext === '.glb') {
      if (file.size > PRESENTATION_MAX_MODEL_BYTES) throw new Error(`model exceeds ${PRESENTATION_MAX_MODEL_BYTES} bytes; rejected before reading`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrent()) return;
      if (bytes.length === 0 || bytes.length > PRESENTATION_MAX_MODEL_BYTES) throw new Error('model is empty or exceeds the 16 MB model bound');
      const problem = validateModelBytes(bytes);
      if (problem !== null) throw new Error(`invalid 3D model (${problem}); only the self-contained subset is accepted`);
      pendingPrimaryModel = { bytes: bytes.slice(), fileName: file.name };
      pendingPrimaryImage = null;
      productStatus.textContent = `Staged 3D model ${file.name}. Add a product to create it from this single file.${pendingSummary()}`;
    } else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
      if (file.size > MAX_PREVIEW_BYTES) throw new Error(`image exceeds ${MAX_PREVIEW_BYTES} bytes; rejected before reading`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrent()) return;
      const decoded = await decodeAndVerifyRaster(bytes, isCurrent);
      if (!isCurrent()) return;
      if (decoded === null) throw new Error('unsupported or invalid image; choose a PNG, JPEG or WebP file with verifiable dimensions');
      pendingPrimaryImage = { bytes: bytes.slice(), mediaType: decoded.mediaType, extension: decoded.mediaType === 'image/jpeg' ? 'jpg' : decoded.mediaType === 'image/webp' ? 'webp' : 'png', widthPx: decoded.width, heightPx: decoded.height, fileName: file.name };
      pendingPrimaryModel = null;
      productStatus.textContent = `Staged flat image ${file.name}. Add a product to create it from this single file.${pendingSummary()}`;
    } else {
      throw new Error('unsupported file type; choose one .glb model or one .png/.jpg/.jpeg/.webp image');
    }
  } catch (error) {
    if (generation === productGeneration) {
      productStatus.textContent = `Could not stage ${file.name}: ${error instanceof Error ? error.message : String(error)}. Previous products are unchanged.`;
      alertBuilder(`Could not stage ${file.name}. Previous products are unchanged.`);
    }
  } finally {
    if (generation === productGeneration) { productImporting = false; updateControls(); }
  }
}

async function stageProductViewFile(side: ProductViewSide, file: File): Promise<void> {
  if (loading || generating || creating || logoImporting || returnBusy || baselineBusy) return;
  alertBuilder();
  const generation = ++productGeneration;
  const slot = ++stageTokens[side];
  const isCurrent = (): boolean => generation === productGeneration && slot === stageTokens[side];
  productImporting = true;
  updateControls();
  productStatus.textContent = `Reading ${side} view ${file.name}…`;
  try {
    if (looksRemoteFileName(file.name)) throw new Error('file name looks like a remote reference; choose a local PNG, JPEG or WebP image');
    if (file.size > MAX_PREVIEW_BYTES) throw new Error(`image exceeds ${MAX_PREVIEW_BYTES} bytes; rejected before reading`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isCurrent()) return;
    const decoded = await decodeAndVerifyRaster(bytes, isCurrent);
    if (!isCurrent()) return;
    if (decoded === null) throw new Error('unsupported or invalid image; choose a PNG, JPEG or WebP file with verifiable dimensions');
    pendingViews[side] = { bytes: bytes.slice(), mediaType: decoded.mediaType, extension: decoded.mediaType === 'image/jpeg' ? 'jpg' : decoded.mediaType === 'image/webp' ? 'webp' : 'png', widthPx: decoded.width, heightPx: decoded.height, fileName: file.name };
    productStatus.textContent = `Assigned ${side} view ${file.name}. It attaches to the named side only when you add the product.${pendingSummary()}`;
  } catch (error) {
    if (generation === productGeneration) {
      productStatus.textContent = `Could not assign ${side} view ${file.name}: ${error instanceof Error ? error.message : String(error)}. Previous products are unchanged.`;
      alertBuilder(`Could not assign ${side} view ${file.name}. Previous products are unchanged.`);
    }
  } finally {
    if (generation === productGeneration) { productImporting = false; updateControls(); }
  }
}


async function addProductFromStaged(): Promise<void> {
  if (source === null || loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy) {
    if (source === null) {
      productStatus.textContent = 'Create or open a project before adding a product.';
      alertBuilder('Create or open a project before adding a product.');
    }
    return;
  }
  alertBuilder();
  const generation = ++productGeneration;
  productImporting = true;
  updateControls();
  try {
    const stagedSides = (Object.keys(pendingViews) as ProductViewSide[]).filter((side) => pendingViews[side] !== null);
    if (pendingPrimaryModel === null && pendingPrimaryImage === null && stagedSides.length === 0) {
      productStatus.textContent = 'Choose one product file first: a single .glb model, a single flat image, or a single assigned side view suffices.';
      alertBuilder('Choose one product file first. A single model, image, or assigned side view is enough.');
      return;
    }
    const snapshot = source;
    const wantedName = productName.value.trim();
    productCounter += 1;
    const fallbackFileName = pendingPrimaryModel?.fileName ?? pendingPrimaryImage?.fileName ?? (stagedSides.length === 1 ? pendingViews[stagedSides[0]!]!.fileName : 'product');
    const candidateId = `provisional-product-${safeProductSegment(wantedName || fallbackFileName)}-${productCounter}-${newLocalId().slice(0, 8)}`;
    const made = createProvisionalProduct({ id: candidateId, ...(wantedName ? { name: wantedName } : {}), kind: 'other' });
    if (!made.ok) {
      productStatus.textContent = `Could not add product: ${made.errors.map((error) => error.message).join('; ')}. Previous products are unchanged.`;
      return;
    }
    const productId = made.product.id;
    const variantId = made.product.variants[0]!.id;
    const mintedProduct: ProjectDocument['products'][number] = JSON.parse(JSON.stringify(made.product)) as ProjectDocument['products'][number];
    const safe = safeProductSegment(productId);
    const stagedModel = pendingPrimaryModel;
    const stagedPrimary = pendingPrimaryImage;
    const stagedViews = { ...pendingViews };
    if (generation !== productGeneration) return;
    const assets: Array<{ path: string; bytes: Uint8Array }> = [];
    const views: Array<{ view: string; image: string; label?: string }> = [];
    const models: Array<{ model: string; label?: string }> = [];
    const primaryLabelBase = wantedName !== '' ? wantedName : `Provisional uncalibrated product ${productId}`;
    if (stagedModel) {
      const modelPath = `presentation/${safe}/model.glb`;
      assets.push({ path: modelPath, bytes: stagedModel.bytes.slice() });
      models.push({ model: modelPath, label: `${primaryLabelBase} — 3D model` });
    }
    for (const side of PRODUCT_VIEW_SIDES) {
      // Each staged image attaches to its assigned side only. A lone
      // back/left/right image stays on that side; it is never duplicated
      // into front. The primary flat image feeds the front slot only.
      const staged = side === 'front' ? (stagedViews['front'] ?? stagedPrimary) : stagedViews[side];
      if (!staged) continue;
      const imagePath = `presentation/${safe}/${side}.${staged.extension}`;
      assets.push({ path: imagePath, bytes: staged.bytes.slice() });
      const typed = productViewLabel[side]!.value.trim();
      views.push({ view: side, image: imagePath, label: typed !== '' ? typed : `${primaryLabelBase} — ${side} view` });
    }
    views.sort((a, b) => (a.view < b.view ? -1 : a.view > b.view ? 1 : 0));
    if (views.length === 0 && models.length === 0) {
      productStatus.textContent = 'Nothing staged to add: the staged files did not yield a view or model. Previous products are unchanged.';
      return;
    }
    interface NewViewEntry { productId: string; variantId: string; view: string; image: string; label?: string; }
    interface NewModelEntry { productId: string; variantId: string; model: string; label?: string; }
    interface NewManifest { version: 2; views: NewViewEntry[]; models?: NewModelEntry[]; }
    const manifestValue: NewManifest = models.length > 0
      ? { version: 2, views: views.map((entry) => ({ productId, variantId, view: entry.view, image: entry.image, ...(entry.label !== undefined ? { label: entry.label } : {}) })), models: models.map((entry) => ({ productId, variantId, model: entry.model, ...(entry.label !== undefined ? { label: entry.label } : {}) })) }
      : { version: 2, views: views.map((entry) => ({ productId, variantId, view: entry.view, image: entry.image, ...(entry.label !== undefined ? { label: entry.label } : {}) })) };
    const existingManifestBytes = snapshot.assets.find((asset) => asset.path === PRESENTATION_MANIFEST_PATH)?.bytes;
    // Merge with history through the validated parser (never raw JSON): keep
    // v1 references verbatim alongside the new v2 entries, drop invalid
    // history with a visible note, and enforce the 32-entry presentation
    // budget BEFORE committing source state.
    type MergedView = { productId: string; variantId?: string; view: string; image: string; label?: string };
    type MergedModel = { productId: string; variantId?: string; model: string; label?: string };
    type MergedReference = { productId: string; variantId?: string; image: string; label?: string };
    let mergedManifest: { version: 2; views: MergedView[]; models?: MergedModel[]; references?: MergedReference[] } = { version: 2, views: [...manifestValue.views], ...(manifestValue.models ? { models: [...manifestValue.models] } : {}) };
    let historyNote = '';
    if (existingManifestBytes) {
      const history = parsePresentationManifest(existingManifestBytes);
      if (history === null) {
        historyNote = ' The prior presentation manifest was invalid and was replaced.';
      } else if (history.version === 1) {
        mergedManifest = { version: 2, views: [...manifestValue.views], ...(manifestValue.models ? { models: [...manifestValue.models] } : {}), references: [...history.references] };
      } else {
        mergedManifest = {
          version: 2,
          views: [...history.views.map((entry) => ({ ...entry })), ...manifestValue.views],
          ...(((history.models?.length ?? 0) > 0 || manifestValue.models) ? { models: [...(history.models ?? []).map((entry) => ({ ...entry })), ...(manifestValue.models ?? [])] } : {}),
          ...(((history.references?.length ?? 0) > 0) ? { references: [...(history.references ?? []).map((entry) => ({ ...entry }))] } : {}),
        };
      }
    }
    const mergedCount = mergedManifest.views.length + (mergedManifest.models?.length ?? 0) + (mergedManifest.references?.length ?? 0);
    if (mergedCount > 32) {
      productStatus.textContent = `Could not add product: the presentation manifest would hold ${mergedCount} entries, over the 32-entry budget. Remove a product or issue first; previous products are unchanged.`;
      alertBuilder('The presentation budget (32 entries) is full. Previous products are unchanged.');
      return;
    }
    const manifestBytes = new TextEncoder().encode(JSON.stringify(mergedManifest));
    const priorAdditional = snapshot.assets.filter((asset) => asset.kind === 'additional' && asset.path !== PRESENTATION_MANIFEST_PATH);
    const combinedAdditional = [...priorAdditional.map((asset) => ({ path: asset.path, bytes: asset.bytes })), ...assets.map((asset) => ({ path: asset.path, bytes: asset.bytes })), { path: PRESENTATION_MANIFEST_PATH, bytes: manifestBytes }];
    const nextProject: ProjectDocument = JSON.parse(JSON.stringify(snapshot.project)) as ProjectDocument;
    nextProject.products.push(mintedProduct);
    nextProject.configurations.push({ id: `builder-config-${productId}`, productId, variantId, placements: [] });
    assertProjectEditorLimits(nextProject);
    if (generation !== productGeneration) return;
    const packageBytes = await createProjectPackage(
      { project: nextProject, assets: snapshot.assets.filter((asset) => asset.kind !== 'additional').map((asset) => ({ path: asset.path, bytes: asset.bytes })), additionalAssets: combinedAdditional },
      { sha256: hasher.sha256Bytes },
    );
    if (generation !== productGeneration) return;
    const reparsed = await parseProjectPackage(packageBytes, { sha256: hasher.sha256Bytes });
    if (generation !== productGeneration) return;
    const summary = summarizeSourceProject(reparsed.project);
    source = { fileName: snapshot.fileName, project: reparsed.project, assets: reparsed.assets, summary, packageBytes: packageBytes.slice() };
    addedPresentations.push({ views, models, assets: assets.filter((asset) => asset.path !== PRESENTATION_MANIFEST_PATH) });
    pendingPrimaryModel = null;
    pendingPrimaryImage = null;
    pendingViews = { front: null, back: null, left: null, right: null };
    for (const side of PRODUCT_VIEW_SIDES) productViewLabel[side]!.value = '';
    renderSelectionLists(summary, true);
    // New rows postdate the preserved snapshot, so they would arrive
    // unchecked; keep the added product, option and setup selected.
    for (const box of productList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (box.value === productId || box.getAttribute('data-product') === productId) box.checked = true;
    }
    for (const box of configurationList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (box.value === `builder-config-${productId}`) box.checked = true;
    }
    refreshSelectionValidation();
    refreshMappingOptions();
    refreshWorkspace();
    refreshAddProductDisclosure();
    if (generation !== productGeneration) return;
    productStatus.textContent = `Added preview-only product ${mintedProduct.name ?? productId} (${views.length} view${views.length === 1 ? '' : 's'}${models.length ? ', 3D model' : ''}). It carries no measurements and cannot host placements; missing sides are absent, never invented.${historyNote}`;
  } catch (error) {
    if (generation === productGeneration) {
      productStatus.textContent = `Could not add product: ${error instanceof Error ? error.message : String(error)}. Previous products are unchanged.`;
      alertBuilder('The product could not be added. Previous products are unchanged.');
    }
  } finally {
    if (generation === productGeneration) { productImporting = false; updateControls(); }
  }
}

function onProductFileChange(): void {
  const file = productFile.files?.[0];
  if (file) void stagePrimaryProductFile(file);
  productFile.value = '';
}

/**
 * Prepared-product import: a bridge-produced (or otherwise prepared) product
 * definition JSON joins the current source project. Bounded pre-read,
 * validated before anything changes; the commit roundtrips through the
 * package parser like every other source mutation. New configurations arrive
 * unchecked-filtered: this handler checks the imported product, its variants
 * and its new configurations after rendering.
 */
async function importPreparedProductFile(file: File): Promise<void> {
  if (loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy) return;
  alertBuilder();
  const generation = ++productGeneration;
  if (source === null) {
    productStatus.textContent = 'Create or open a project before importing a prepared product definition.';
    alertBuilder('Create or open a project first. The previous project is unchanged.');
    return;
  }
  productImporting = true;
  updateControls();
  productStatus.textContent = `Reading prepared product ${file.name}…`;
  try {
    if (looksRemoteFileName(file.name)) throw new Error('file name looks like a remote reference; choose a local prepared product JSON file');
    if (file.size > PREPARED_IMPORT_LIMITS.maxImportFileBytes) throw new Error(`file exceeds ${PREPARED_IMPORT_LIMITS.maxImportFileBytes} bytes; rejected before reading`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (generation !== productGeneration) return;
    if (bytes.length === 0 || bytes.length > PREPARED_IMPORT_LIMITS.maxImportFileBytes) throw new Error('file is empty or exceeds the 1 MiB bound');
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('file is not valid JSON');
    }
    if (generation !== productGeneration) return;
    const snapshot = source;
    const appended = appendPreparedProduct(snapshot.project, parsed);
    if (!appended.ok) {
      throw new Error(`prepared product rejected: ${appended.errors.map((error) => `${error.code} at ${error.path}`).join('; ')}`);
    }
    if (generation !== productGeneration) return;
    const importedProductId = appended.project.products[appended.project.products.length - 1]!.id;
    // Cryptographic evidence check (the pure kernel only format-checks the
    // digest): hash the EXACT bytes that will be packaged and compare against
    // the supplied digest BEFORE committing anything. A mismatch fails
    // atomically with the previous source and outputs preserved. The async
    // hash is re-checked for obsolescence like every other async step.
    let evidenceBytes: Uint8Array | null = null;
    if (appended.areaBundleText !== null) {
      if (appended.areaBundleSha256 === null) {
        throw new Error('prepared product rejected: area bundle text supplied without its SHA-256; refusing to package unverified evidence');
      }
      evidenceBytes = new TextEncoder().encode(appended.areaBundleText);
      const evidenceDigest = await hasher.sha256Bytes(evidenceBytes);
      if (generation !== productGeneration) return;
      if (evidenceDigest !== appended.areaBundleSha256) {
        throw new Error('prepared product rejected: evidence hash mismatch at areaBundleSha256 (recorded digest does not match the evidence bytes); refusing to package unverified evidence');
      }
      if (generation !== productGeneration) return;
    }
    // Evidence ships as additional package assets, never as geometry: the
    // bridge sidecar plus the original area-bundle export (complete source
    // evidence, including named exclusion identities the canonical polygons
    // cannot represent). Colliding evidence paths fail the import instead of
    // overwriting evidence.
    const evidencePaths = preparedEvidencePaths(importedProductId);
    for (const evidencePath of [evidencePaths.sidecar, evidencePaths.areaBundle]) {
      if (snapshot.assets.some((asset) => asset.path === evidencePath)) {
        throw new Error(`evidence path "${evidencePath}" already exists in this project; refusing to overwrite evidence`);
      }
    }
    const evidenceAdditions: { path: string; bytes: Uint8Array }[] = [];
    if (appended.sidecar !== null && typeof appended.sidecar === 'object') {
      evidenceAdditions.push({ path: evidencePaths.sidecar, bytes: new TextEncoder().encode(JSON.stringify(appended.sidecar, null, 2)) });
    }
    // Original area-bundle export ships VERBATIM (exact conversion-input
    // text): never re-serialized, so original evidence bytes are preserved.
    // These are the same bytes whose SHA-256 was verified above.
    if (evidenceBytes !== null) {
      evidenceAdditions.push({ path: evidencePaths.areaBundle, bytes: evidenceBytes });
    }
    assertProjectEditorLimits(appended.project);
    const combinedAdditional = [
      ...snapshot.assets.filter((asset) => asset.kind === 'additional').map((asset) => ({ path: asset.path, bytes: asset.bytes })),
      ...evidenceAdditions,
    ];
    const packageBytes = await createProjectPackage(
      { project: appended.project, assets: snapshot.assets.filter((asset) => asset.kind !== 'additional').map((asset) => ({ path: asset.path, bytes: asset.bytes })), additionalAssets: combinedAdditional },
      { sha256: hasher.sha256Bytes },
    );
    if (generation !== productGeneration) return;
    const reparsed = await parseProjectPackage(packageBytes, { sha256: hasher.sha256Bytes });
    if (generation !== productGeneration) return;
    const summary = summarizeSourceProject(reparsed.project);
    source = { fileName: snapshot.fileName, project: reparsed.project, assets: reparsed.assets, summary, packageBytes: packageBytes.slice() };
    const newConfigIds = new Set(reparsed.project.configurations.filter((config) => config.productId === importedProductId).map((config) => config.id));
    const newVariantIds = new Set((reparsed.project.products.find((product) => product.id === importedProductId)?.variants ?? []).map((variant) => variant.id));
    renderSelectionLists(summary, true);
    for (const box of productList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (box.value === importedProductId) box.checked = true;
      else if (box.getAttribute('data-product') === importedProductId && newVariantIds.has(box.value)) box.checked = true;
    }
    for (const box of configurationList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (newConfigIds.has(box.value)) box.checked = true;
    }
    refreshSelectionValidation();
    refreshMappingOptions();
    refreshWorkspace();
    refreshAddProductDisclosure();
    if (generation !== productGeneration) return;
    productStatus.textContent = `Imported prepared product with ${newConfigIds.size} zero-placement setup${newConfigIds.size === 1 ? '' : 's'}. Millimetre regions and calibration refs are explicit and provisional, pending review — never production-approved.${evidenceAdditions.length === 0 ? ' No bridge evidence was supplied.' : ' Bridge evidence ships with the package.'}`;
  } catch (error) {
    if (generation === productGeneration) {
      productStatus.textContent = `Could not import prepared product: ${error instanceof Error ? error.message : String(error)}. Previous products are unchanged.`;
      alertBuilder('The prepared product could not be imported. Previous products are unchanged.');
    }
  } finally {
    if (generation === productGeneration) { productImporting = false; updateControls(); }
  }
}

function onPreparedProductFileChange(): void {
  const file = preparedProductFile.files?.[0];
  if (file) void importPreparedProductFile(file);
  preparedProductFile.value = '';
}

function onProductViewFileChange(side: ProductViewSide): void {
  const file = productViewFile[side]!.files?.[0];
  if (file) void stageProductViewFile(side, file);
  productViewFile[side]!.value = '';
}

/* ---------------- In-place side photos (Tranche A) ---------------- */
/* Attach a photo to an EXISTING product scope without recreating it.  */
/* Browser work (read/decode) stays at this boundary; validation and  */
/* planning are the pure `planPhotoIntake` core service. The commit    */
/* follows the proven repackage-and-reparse roundtrip: candidate       */
/* manifest/assets/mappings are built and verified before `source`     */
/* changes, so a failed, stale or cancelled attach keeps the prior     */
/* project. A replaced side keeps its entry count and label but starts */
/* unmeasured: only mappings bound to the replaced photo/scope are     */
/* retired, and the superseded bytes are preserved under a             */
/* `superseded/` path as evidence.                                     */

/** Human product/option names for photo-attach messages (never raw IDs). */
function photoProductLabel(product: { id: string; name?: string }): string {
  return product.name ?? product.id;
}

function photoVariantLabel(
  product: { variants: Array<{ id: string; name?: string }> },
  variant: { id: string; name?: string },
): string {
  if (variant.name) return variant.name;
  if (product.variants.length === 1) return 'Standard option';
  const index = product.variants.findIndex((entry) => entry.id === variant.id);
  return `Option ${index >= 0 ? index + 1 : 1}`;
}

function photoAttachScopeName(
  product: { id: string; name?: string; variants: Array<{ id: string; name?: string }> },
  scopeVariant: { id: string; name?: string } | undefined,
): string {
  const productLabel = photoProductLabel(product);
  if (!scopeVariant) return productLabel;
  return `${photoVariantLabel(product, scopeVariant)} of ${productLabel}`;
}

function refreshPhotoAttachHint(): void {
  if (photoAttaching || source === null) return;
  const products = source.project.products;
  const product = products.find((entry) => entry.id === workspaceProductId) ?? products[0] ?? null;
  if (product === null) {
    productPhotoStatus.textContent = 'Create or open a project with a product first.';
    return;
  }
  const variant = product.variants.find((entry) => entry.id === workspaceVariantId) ?? product.variants[0] ?? null;
  const side = productPhotoSide.value;
  if (variant === null || (side !== 'front' && side !== 'back' && side !== 'left' && side !== 'right')) return;
  const wholeProduct = productPhotoScope.value === 'product';
  const scopeVariantId = wholeProduct ? undefined : variant.id;
  const assets = sessionAssetMap();
  const manifest = parsePresentationManifest(assets.get(PRESENTATION_MANIFEST_PATH));
  const occupied = manifest !== null && manifest.version === 2 && manifest.views.some(
    (entry) => entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId && entry.view === side,
  );
  const scope = photoAttachScopeName(product, scopeVariantId === undefined ? undefined : variant);
  productPhotoStatus.textContent = occupied
    ? `${workspaceSideLabel(side)} view of ${scope} already has a photo — choosing a file replaces it. The old mapping retires and the new photo starts unmeasured; the model, other sides, logos and measurements are kept.`
    : `${workspaceSideLabel(side)} view of ${scope} has no photo yet — choosing a file adds it unmeasured.`;
}

async function attachProductPhotoFile(file: File): Promise<void> {
  if (source === null || loading || generating || creating || logoImporting || productImporting || photoAttaching || returnBusy || baselineBusy) {
    if (source === null) {
      productPhotoStatus.textContent = 'Create or open a project before adding a side photo.';
      alertBuilder('Create or open a project before adding a side photo.');
    }
    return;
  }
  const sideValue = productPhotoSide.value;
  if (sideValue !== 'front' && sideValue !== 'back' && sideValue !== 'left' && sideValue !== 'right') {
    productPhotoStatus.textContent = 'Choose a side (Front, Back, Left or Right) first.';
    return;
  }
  if (looksRemoteFileName(file.name)) {
    productPhotoStatus.textContent = `Could not attach ${file.name}: file name looks like a remote reference; choose a local PNG, JPEG or WebP image. Previous products are unchanged.`;
    return;
  }
  if (file.size > MAX_PREVIEW_BYTES) {
    productPhotoStatus.textContent = `Could not attach ${file.name}: image exceeds ${MAX_PREVIEW_BYTES} bytes; rejected before reading. Previous products are unchanged.`;
    return;
  }
  // Capture ALL submission state BEFORE any await: source identity, session,
  // workspace selection, side, scope and label. Later awaits must never read
  // live UI state, so a mid-read switch cannot attach the photo elsewhere.
  const submittedSource = source;
  const submittedSession = sourceSession;
  const submittedProductId = workspaceProductId;
  const submittedVariantId = workspaceVariantId;
  const submittedWholeProduct = productPhotoScope.value === 'product';
  const submittedLabel = productPhotoLabel.value.trim();
  const submittedFileName = file.name;
  const side: ProductViewSide = sideValue;
  const generation = ++productGeneration;
  const fresh = (): boolean => generation === productGeneration && source === submittedSource && sourceSession === submittedSession;
  alertBuilder();
  photoAttaching = true;
  updateControls();
  productPhotoStatus.textContent = `Reading ${submittedFileName}…`;
  try {
    await enqueueWorkspaceCommit(async () => {
      if (!fresh() || source === null) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the project changed while reading; choose the file again. Previous products are unchanged.`;
        return;
      }
      const snapshot = source;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!fresh() || source !== snapshot) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the project changed while reading; choose the file again. Previous products are unchanged.`;
        return;
      }
      const decoded = await decodeAndVerifyRaster(bytes, fresh);
      if (!fresh() || source !== snapshot) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the project changed while reading; choose the file again. Previous products are unchanged.`;
        return;
      }
      if (decoded === null) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: unsupported or invalid image; choose a PNG, JPEG or WebP file with verifiable dimensions. Previous products are unchanged.`;
        return;
      }
      const products = snapshot.project.products;
      const product = products.find((entry) => entry.id === submittedProductId) ?? products[0] ?? null;
      if (product === null) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: no product is in the project; add a product first.`;
        return;
      }
      const variant = product.variants.find((entry) => entry.id === submittedVariantId) ?? product.variants[0] ?? null;
      if (variant === null) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the selected product has no option; reopen the project and try again.`;
        return;
      }
      const scopeVariantId = submittedWholeProduct ? undefined : variant.id;
      const assets = sessionAssetMap();
      const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
      const parsed = parsePresentationManifest(manifestBytes);
      if (parsed === null) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: no usable presentation manifest is in this project; add the product with a photo first, then attach further sides here.`;
        return;
      }
      // The pure planner speaks v2 only; v1 references ride along verbatim
      // so upgrading history is never dropped.
      const existingManifestJson: unknown = parsed.version === 2
        ? {
          version: 2,
          views: parsed.views.map((entry) => ({ ...entry })),
          ...(parsed.models ? { models: parsed.models.map((entry) => ({ ...entry })) } : {}),
          ...(parsed.references ? { references: parsed.references.map((entry) => ({ ...entry })) } : {}),
        }
        : { version: 2, views: [], references: parsed.references.map((entry) => ({ ...entry })) };
      const occupied = parsed.version === 2 && parsed.views.some(
        (entry) => entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId && entry.view === side,
      );
      const mode = occupied ? 'replace' : 'add';
      const merged = workspaceMergedMappings();
      const plan = planPhotoIntake({
        productId: product.id,
        ...(scopeVariantId !== undefined ? { variantId: scopeVariantId } : {}),
        side,
        mode,
        fileName: submittedFileName,
        bytes: bytes.slice(),
        widthPx: decoded.width,
        heightPx: decoded.height,
        mediaType: decoded.mediaType === 'image/jpeg' ? 'jpeg' : decoded.mediaType === 'image/webp' ? 'webp' : 'png',
        existingManifest: existingManifestJson,
        existingMappings: merged.mappings.map((entry) => ({
          productId: entry.productId,
          ...(entry.variantId !== undefined ? { variantId: entry.variantId } : {}),
          regionId: entry.regionId,
          view: entry.view,
          image: entry.image,
        })),
        existingAssetPaths: [...assets.keys()],
      });
      if (!plan.ok) {
        const detail = plan.code === 'unknown-product-scope'
          ? `${plan.message}. Try the other “Applies to” scope (option versus whole product).`
          : `${plan.message}. Previous products are unchanged.`;
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: ${detail}`;
        return;
      }
      if (!fresh() || source !== snapshot) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the project changed while planning; choose the file again. Previous products are unchanged.`;
        return;
      }
      if (plan.replacedAssetPath !== undefined && plan.assetPath === plan.replacedAssetPath) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the plan reuses the superseded photo path; nothing was changed.`;
        return;
      }
      // Candidate commit: new photo bytes at a fresh path, updated manifest
      // (operator label on adds), mappings minus the retired keys. The
      // superseded bytes stay in the package at their EXACT original path —
      // never overwritten, never dropped — so manifest entries or mappings
      // in other scopes/sides that share that photo keep working.
      const invalidated = new Set(plan.invalidatedMappingKeys);
      const manifestOut = JSON.parse(JSON.stringify(plan.manifest)) as {
        version: 2;
        views: Array<{ productId: string; variantId?: string; view: string; image: string; label?: string }>;
        models?: Array<{ productId: string; variantId?: string; model: string; label?: string }>;
        references?: Array<{ productId: string; variantId?: string; image: string; label?: string }>;
      };
      if (mode === 'add' && submittedLabel !== '') {
        const added = manifestOut.views.find((entry) =>
          entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId &&
          entry.view === side && entry.image === plan.assetPath);
        if (added) added.label = submittedLabel;
      }
      const newManifestBytes = new TextEncoder().encode(JSON.stringify(manifestOut));
      const skipPaths = new Set<string>([PRESENTATION_MANIFEST_PATH, PHOTO_MAPPINGS_PATH, OPERATION_ANCHORS_PATH, plan.assetPath]);
      const carriedAdditional = snapshot.assets
        .filter((asset) => asset.kind === 'additional' && !skipPaths.has(asset.path))
        .map(({ path, bytes: assetBytes }) => ({ path, bytes: assetBytes }));
      const base = parsePhotoMappings(snapshot.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes);
      const baseKept = (base?.mappings ?? []).filter((candidate) => !invalidated.has(mappingKeyOf(candidate)));
      const stagedKept = stagedPhotoMappings.filter((candidate) => !invalidated.has(mappingKeyOf(candidate)));
      const mergedMappings = mergeSessionPhotoMappings({ version: 1, mappings: baseKept }, stagedKept);
      // An empty merge means every mapping was retired: omit the mappings
      // file (the parser reads empty as absent) rather than writing bytes
      // that parse as no file.
      const mergedBytes = mergedMappings.mappings.length > 0 ? serializePhotoMappings(mergedMappings) : null;
      const additionalAssets: Array<{ path: string; bytes: Uint8Array }> = [
        ...carriedAdditional,
        { path: plan.assetPath, bytes: bytes.slice() },
        { path: PRESENTATION_MANIFEST_PATH, bytes: newManifestBytes },
        ...(mergedBytes !== null ? [{ path: PHOTO_MAPPINGS_PATH, bytes: mergedBytes }] : []),
      ];
      // The saved-anchors sidecar rides along exactly once (it is excluded
      // from the carried set above, so this push cannot duplicate its path).
      const packagedSidecar = snapshot.assets.find((asset) => asset.path === OPERATION_ANCHORS_PATH && asset.kind === 'additional');
      if (packagedSidecar !== undefined) {
        additionalAssets.push({ path: packagedSidecar.path, bytes: packagedSidecar.bytes });
      }
      const nextProject: ProjectDocument = JSON.parse(JSON.stringify(snapshot.project)) as ProjectDocument;
      assertProjectEditorLimits(nextProject);
      if (!fresh() || source !== snapshot) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the project changed while planning; choose the file again. Previous products are unchanged.`;
        return;
      }
      const packageBytes = await createProjectPackage(
        {
          project: nextProject,
          assets: snapshot.assets.filter((asset) => asset.kind !== 'additional').map(({ path, bytes: assetBytes }) => ({ path, bytes: assetBytes })),
          additionalAssets,
        },
        { sha256: hasher.sha256Bytes },
      );
      if (!fresh() || source !== snapshot) return;
      const reparsed = await parseProjectPackage(packageBytes, { sha256: hasher.sha256Bytes });
      if (!fresh() || source !== snapshot) return;
      // Verify the roundtrip before committing: same products/ids, domain
      // untouched, new view present with exact bytes, retired mappings gone,
      // superseded photo evidence retained byte-identical.
      const beforeIds = snapshot.project.products.map((entry) => entry.id);
      const afterIds = reparsed.project.products.map((entry) => entry.id);
      if (JSON.stringify(afterIds) !== JSON.stringify(beforeIds)) {
        throw new Error('The reparse changed the product list; the previous project is unchanged.');
      }
      const beforeProduct = snapshot.project.products.find((entry) => entry.id === product.id);
      const afterProduct = reparsed.project.products.find((entry) => entry.id === product.id);
      if (!beforeProduct || !afterProduct || JSON.stringify(afterProduct) !== JSON.stringify(beforeProduct)) {
        throw new Error('The reparse changed product geometry; the previous project is unchanged.');
      }
      const backManifest = parsePresentationManifest(reparsed.assets.find((asset) => asset.path === PRESENTATION_MANIFEST_PATH)?.bytes);
      const backEntry = backManifest !== null && backManifest.version === 2
        ? backManifest.views.find((entry) =>
          entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId &&
          entry.view === side && entry.image === plan.assetPath)
        : undefined;
      if (!backEntry) {
        throw new Error('The reparse lost the new photo; the previous project is unchanged.');
      }
      const backPhotoBytes = reparsed.assets.find((asset) => asset.path === plan.assetPath)?.bytes;
      if (!backPhotoBytes || backPhotoBytes.length !== bytes.length) {
        throw new Error('The reparse lost the new photo bytes; the previous project is unchanged.');
      }
      if (plan.replacedAssetPath !== undefined) {
        const beforeEvidence = snapshot.assets.find((asset) => asset.path === plan.replacedAssetPath)?.bytes;
        const afterEvidence = reparsed.assets.find((asset) => asset.path === plan.replacedAssetPath)?.bytes;
        if (!beforeEvidence || !afterEvidence || beforeEvidence.length !== afterEvidence.length ||
          !beforeEvidence.every((value, index) => value === afterEvidence[index])) {
          throw new Error('The reparse lost the superseded photo evidence; the previous project is unchanged.');
        }
      }
      const backMappings = parsePhotoMappings(reparsed.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH)?.bytes);
      const staleBack = (backMappings?.mappings ?? []).filter((candidate) => invalidated.has(mappingKeyOf(candidate)));
      if (staleBack.length > 0) {
        throw new Error('The reparse kept a retired photo mapping; the previous project is unchanged.');
      }
      if (!fresh() || source !== snapshot) return;
      stagedPhotoMappings = stagedKept;
      source = {
        fileName: snapshot.fileName,
        project: reparsed.project,
        assets: reparsed.assets,
        summary: summarizeSourceProject(reparsed.project),
        packageBytes: packageBytes.slice(),
      };
      refreshMappingOptions();
      refreshWorkspace();
      // The package changed under any generated delivery: mark outputs stale
      // and refresh the issue gate so a regen is required before download.
      invalidateOutputsForEdit();
      refreshSelectionValidation();
      // Post-commit the source identity has intentionally changed, so only
      // the generation guard still applies before reporting success.
      if (generation !== productGeneration) return;
      const scope = photoAttachScopeName(product, scopeVariantId === undefined ? undefined : variant);
      productPhotoStatus.textContent = mode === 'add'
        ? `Added ${workspaceSideLabel(side)} photo to ${scope}. It starts unmeasured — set it up on the photo workspace before authoring. Product, model, other sides, logos and measurements are unchanged.`
        : `Replaced ${workspaceSideLabel(side)} photo on ${scope}. ${invalidated.size} photo mapping${invalidated.size === 1 ? ' was' : 's were'} retired; the superseded photo stays in the package as evidence and other views sharing it are unchanged. Set up measurements on the new photo before authoring.`;
    }, () => {
      productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the project changed before the attach started; choose the file again. Previous products are unchanged.`;
    });
  } catch (error) {
    if (fresh()) {
      productPhotoStatus.textContent = `Could not attach ${submittedFileName}: ${error instanceof Error ? error.message : String(error)}`;
      alertBuilder(`The side photo could not be attached. Previous products are unchanged.`);
    }
  } finally {
    photoAttaching = false;
    updateControls();
  }
}

function onProductPhotoFileChange(): void {
  const file = productPhotoFile.files?.[0];
  if (file) void attachProductPhotoFile(file);
  productPhotoFile.value = '';
}
sourceChoose.addEventListener('click', () => sourceFile.click());
sourceFile.addEventListener('change', onSourceFileChange);
startCreate.addEventListener('click', () => void createEmptyProject());
previewOnlyAck.addEventListener('change', () => {
  // Toggling the escape changes what may issue: drop any generated delivery
  // and refresh the gate message before the operator continues.
  invalidateOutputsForEdit();
  refreshSelectionValidation();
});
saveMaster.addEventListener('click', () => void downloadMasterFile());
logoAdd.addEventListener('click', () => logoFile.click());
logoFile.addEventListener('change', onLogoFileChange);
productChoose.addEventListener('click', () => productFile.click());
productAdd.addEventListener('click', () => void addProductFromStaged());
productFile.addEventListener('change', onProductFileChange);
preparedProductAdd.addEventListener('click', () => preparedProductFile.click());
preparedProductFile.addEventListener('change', onPreparedProductFileChange);
preparedProductDrop.addEventListener('click', () => preparedProductFile.click());
preparedProductDrop.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    preparedProductFile.click();
  }
});
preparedProductDrop.addEventListener('dragover', (event) => {
  event.preventDefault();
  preparedProductDrop.classList.add('is-dragging');
});
preparedProductDrop.addEventListener('dragleave', () => preparedProductDrop.classList.remove('is-dragging'));
preparedProductDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  preparedProductDrop.classList.remove('is-dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) void importPreparedProductFile(file);
});
for (const side of PRODUCT_VIEW_SIDES) {
  productViewButton[side]!.addEventListener('click', () => productViewFile[side]!.click());
  productViewFile[side]!.addEventListener('change', () => onProductViewFileChange(side));
}
productPhotoChoose.addEventListener('click', () => productPhotoFile.click());
productPhotoFile.addEventListener('change', onProductPhotoFileChange);
productPhotoSide.addEventListener('change', () => refreshPhotoAttachHint());
productPhotoScope.addEventListener('change', () => refreshPhotoAttachHint());
newSourceButton.addEventListener('click', () => {
  showStep('prepare', 'open');
});
sourceDrop.addEventListener('click', () => sourceFile.click());
sourceDrop.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    sourceFile.click();
  }
});
sourceDrop.addEventListener('dragover', (event) => {
  event.preventDefault();
  sourceDrop.classList.add('is-dragging');
});
sourceDrop.addEventListener('dragleave', () => sourceDrop.classList.remove('is-dragging'));
sourceDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  sourceDrop.classList.remove('is-dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadSourceFile(file);
});
generateButton.addEventListener('click', () => void generateIssued());
downloadPackage.addEventListener('click', downloadPackageFile);
downloadHtml.addEventListener('click', downloadHtmlFile);
downloadBaseline.addEventListener('click', downloadBaselineFile);
hook<HTMLButtonElement>('office-download').addEventListener('click', downloadBaselineFile);
hook<HTMLButtonElement>('preview-document').addEventListener('click', () => {
  const open = document.body.classList.toggle('show-operation-preview');
  hook('preview-document').setAttribute('aria-expanded', String(open));
  if (open) operationContainer.scrollIntoView({ block: 'start' });
});
baselineChoose.addEventListener('click', () => baselineFile.click());
baselineFile.addEventListener('change', onBaselineFileChange);
returnFile.addEventListener('change', onReturnFileChange);
candidateDownload.addEventListener('click', () => void downloadCandidateFile());
decisionRecord.addEventListener('click', () => void recordStationReview());
decisionDownload.addEventListener('click', () => void downloadReviewedReturn());
proposalConfig.addEventListener('change', () => refillProposalPlacements());
proposalPlacement.addEventListener('change', () => refillProposalInputs());
proposalApply.addEventListener('click', () => void applyStationProposal());
proposalDownload.addEventListener('click', () => void downloadStationProposal());
sendToReview.addEventListener('click', () => {
  if (loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy) return;
  showStep('review', activeBaseline() !== null ? 'return' : 'office');
});
operatorDownload.addEventListener('click', downloadOperatorFile);
operationPrint.addEventListener('click', () => {
  if (lastReturn === null || loading || generating || baselineBusy || returnBusy) return;
  globalThis.print();
});
projectIdUseSource.addEventListener('click', () => {
  if (source !== null) projectIdInput.value = source.summary.projectId;
  refreshSelectionValidation();
});
projectIdNew.addEventListener('click', () => {
  const fresh = newLocalId();
  projectIdInput.value = fresh;
  lastAutoProjectId = fresh;
  refreshSelectionValidation();
  projectIdInput.focus();
});
customerName.addEventListener('input', () => refreshSelectionValidation());
jobRef.addEventListener('input', () => refreshSelectionValidation());
issuedBy.addEventListener('input', () => refreshSelectionValidation());
projectIdInput.addEventListener('input', () => refreshSelectionValidation());
formatSelf.addEventListener('change', () => refreshSelectionValidation());
formatHybrid.addEventListener('change', () => refreshSelectionValidation());
modePrepare.addEventListener('click', () => showMode('prepare'));
modeReview.addEventListener('click', () => showMode('review'));
stepOpen.addEventListener('click', () => showStep('prepare', 'open'));
stepChoose.addEventListener('click', () => { if (source !== null) showStep('prepare', 'choose'); });
stepDetails.addEventListener('click', () => { if (source !== null && selectionValid) showStep('prepare', 'details'); });
stepSend.addEventListener('click', () => { if (generated) showStep('prepare', 'send'); });
stepOffice.addEventListener('click', () => showStep('review', 'office'));
stepReturn.addEventListener('click', () => { if (activeBaseline() !== null) showStep('review', 'return'); });
stepCheck.addEventListener('click', () => { if (lastReturn !== null) showStep('review', 'check'); });
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-builder-hook="builder-next"]')) {
  button.addEventListener('click', goNext);
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-builder-hook="builder-back"]')) {
  button.addEventListener('click', goBack);
}
showStep('prepare', 'open');

/* ------------------------------------------------------------------ */
/* Optional visual-trial photo mapping setup (Choose items disclosure). */
/* Provisional trial only, never production geometry/calibration.       */
/* Staged entries merge into the issued package at generate time via    */
/* the existing mergedPresentationInputs path. Failed validation never  */
/* touches the staged set.                                              */
/* ------------------------------------------------------------------ */

const mappingDisclosureBox = hook<HTMLDetailsElement>('mapping-disclosure');
const mappingProduct = hook<HTMLSelectElement>('mapping-product');
const mappingVariant = hook<HTMLSelectElement>('mapping-variant');
const mappingRegion = hook<HTMLSelectElement>('mapping-region');
const mappingFrame = hook<HTMLElement>('mapping-frame');
const mappingSide = hook<HTMLSelectElement>('mapping-side');
const mappingPhoto = hook<HTMLSelectElement>('mapping-photo');
const mappingPhotoStatus = hook<HTMLElement>('mapping-photo-status');
const mappingRowsBox = hook<HTMLElement>('mapping-rows');
const mappingAddRow = hook<HTMLButtonElement>('mapping-add-row');
const mappingStatus = hook<HTMLSelectElement>('mapping-status');
const mappingNote = hook<HTMLInputElement>('mapping-note');
const mappingCheck = hook<HTMLButtonElement>('mapping-check');
const mappingSave = hook<HTMLButtonElement>('mapping-save');
const mappingStatusLine = hook<HTMLElement>('mapping-status-line');
const mappingSaved = hook<HTMLElement>('mapping-saved');

/* ------------------------------------------------------------------ */
/* Product-preparation anchor + safe-area setup (Choose items).        */
/* Prepare context only: named anchors are authored against the source */
/* product and travel in the saved master as a versioned sidecar; a    */
/* staged safe-area proposal can be APPLIED into the in-memory source  */
/* product (validated; selection re-validates; the saved master then   */
/* carries it for reuse). Review/return context never mutates product  */
/* geometry — proposals stay proposals there.                         */
/* ------------------------------------------------------------------ */

/** Anchors authored against the source product (prepare context only). */
let prepareAnchors: AnchorDef[] = [];

/** Versioned anchors sidecar travelling with the prepared master. */
const OPERATION_ANCHORS_PATH = 'presentation/operation-anchors.json';
const OPERATION_ANCHORS_VERSION = 'operation-anchors/1';
const OPERATION_ANCHORS_MAX_BYTES = 256 * 1024;

interface OperationAnchorsSidecar {
  version: typeof OPERATION_ANCHORS_VERSION;
  projectId: string;
  /** Content digest of the master project the anchors were saved against. */
  sourceDigest: string;
  anchors: AnchorDef[];
}

function isOperationAnchorsSidecar(raw: unknown): raw is OperationAnchorsSidecar {
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as Record<string, unknown>;
  if (record['version'] !== OPERATION_ANCHORS_VERSION) return false;
  if (typeof record['projectId'] !== 'string' || record['projectId'].length === 0) return false;
  if (typeof record['sourceDigest'] !== 'string' || (record['sourceDigest'] as string).length === 0) return false;
  if (!Array.isArray(record['anchors'])) return false;
  for (const entry of record['anchors'] as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return false;
    const anchor = entry as Record<string, unknown>;
    if (typeof anchor['id'] !== 'string' || (anchor['id'] as string).length === 0) return false;
    if (typeof anchor['name'] !== 'string' || (anchor['name'] as string).trim().length === 0) return false;
    if (!Array.isArray(anchor['posMm']) ||
      !Number.isFinite((anchor['posMm'] as unknown[])[0]) ||
      !Number.isFinite((anchor['posMm'] as unknown[])[1])) return false;
    for (const key of ['productId', 'variantId', 'regionId', 'frameId', 'calibrationId', 'calibrationVersion'] as const) {
      if (typeof anchor[key] !== 'string') return false;
    }
  }
  return true;
}

function prepareBlocked(): boolean {
  return loading || generating || creating || logoImporting || productImporting || photoAttaching || returnBusy || baselineBusy || source === null;
}

/** True once an issued baseline exists anywhere: Apply stays out of review. */
function reviewContextActive(): boolean {
  return generated !== null || loadedBaseline !== null || lastReturn !== null;
}

function buildAnchorsSidecarBytes(project: ProjectDocument, digest: string, anchors: AnchorDef[]): Uint8Array {
  const scoped = anchors.filter((entry) =>
    project.products.some((product) =>
      product.id === entry.productId &&
      product.variants.some((variant) => variant.id === entry.variantId) &&
      product.regions.some((region) => region.id === entry.regionId)));
  const sidecar: OperationAnchorsSidecar = {
    version: OPERATION_ANCHORS_VERSION,
    projectId: project.projectId,
    sourceDigest: digest,
    anchors: scoped.map((entry) => ({ ...entry, posMm: [entry.posMm[0], entry.posMm[1]] as [number, number] })),
  };
  return new TextEncoder().encode(JSON.stringify(sidecar));
}

async function loadAnchorsSidecar(assets: SourceState['assets'], project: ProjectDocument): Promise<void> {
  prepareAnchors = [];
  const raw = assets.find((asset) => asset.path === OPERATION_ANCHORS_PATH)?.bytes;
  if (!raw) return;
  if (raw.length > OPERATION_ANCHORS_MAX_BYTES) {
    masterStatus.textContent = `Anchors sidecar ignored: exceeds the 256 KiB sidecar bound. The source product is unchanged.`;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    masterStatus.textContent = `Anchors sidecar ignored: not valid JSON. The source product is unchanged.`;
    return;
  }
  if (!isOperationAnchorsSidecar(parsed)) {
    masterStatus.textContent = `Anchors sidecar ignored: not an operation-anchors/1 sidecar. The source product is unchanged.`;
    return;
  }
  if (parsed.projectId !== project.projectId) {
    masterStatus.textContent = `Anchors sidecar ignored: saved for project “${parsed.projectId}”. The source product is unchanged.`;
    return;
  }
  const digest = await hasher.prepareProject(project);
  if (parsed.sourceDigest !== digest) {
    masterStatus.textContent =
      `Anchors sidecar refused as stale (master changed since the anchors were saved): re-author anchors in the setup below. The source product is unchanged.`;
    return;
  }
  prepareAnchors = parsed.anchors
    .filter((entry) => project.products.some((product) =>
      product.id === entry.productId &&
      product.variants.some((variant) => variant.id === entry.variantId) &&
      product.regions.some((region) => region.id === entry.regionId)))
    .map((entry) => ({ ...entry }));
  if (prepareAnchors.length > 0) {
    masterStatus.textContent = `Loaded ${prepareAnchors.length} prepared anchor(s) from the master sidecar.`;
  }
}

let stagedPhotoMappings: PhotoMappingEntry[] = [];

interface MappingRowInputs {
  u: HTMLInputElement;
  v: HTMLInputElement;
  x: HTMLInputElement;
  y: HTMLInputElement;
}
let mappingRowInputs: MappingRowInputs[] = [];

function mappingKeyOf(entry: PhotoMappingEntry): string {
  return `${entry.productId}\0${entry.variantId ?? ''}\0${entry.regionId}\0${entry.view}\0${entry.image}`;
}

function mergeSessionPhotoMappings(
  base: { version: 1; mappings: PhotoMappingEntry[] } | null,
  staged: PhotoMappingEntry[],
): { version: 1; mappings: PhotoMappingEntry[] } {
  const merged = new Map<string, PhotoMappingEntry>();
  for (const entry of base?.mappings ?? []) merged.set(mappingKeyOf(entry), entry);
  for (const entry of staged) merged.set(mappingKeyOf(entry), entry);
  return { version: 1, mappings: [...merged.values()] };
}

/* ---------------- Visual product workspace (main prepare path) ---------------- */
/* Staff authors safe areas + anchors directly on product photos here (one    */
/* staff entry, operation-sheet first). Pure region-frame millimetres flow    */
/* out; photo pixels are display only. Identity: `photoId` = package path +  */
/* byte length + sync FNV-1a content hash (change detection, never security); */
/* `sourceRev` = projectId + per-open session counter, bumped ONLY on source  */
/* open/replace and stable across in-session saves, so saving one view never  */
/* drops another view's unsaved drafts. New products/photos start unmeasured  */
/* (honest pending); the guided panel below creates the first measured       */
/* region through the existing affine solver — never from photo aspect.      */
/* -------------------------------------------------------------------------- */

/** Sync FNV-1a (32-bit) content hash, hex. Change detection only. */
function fnv1a32Hex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function workspacePhotoId(imagePath: string, bytes: Uint8Array): string {
  return `${imagePath}#${bytes.length}:${fnv1a32Hex(bytes)}`;
}

function workspaceSourceRev(): string {
  if (source === null) return `empty#open-${sourceSession}`;
  return `${source.project.projectId}#open-${sourceSession}`;
}

/** Operator's workspace selection (selects only; the view keeps its own tab). */
let workspaceProductId: string | null = null;
let workspaceVariantId: string | null = null;
let workspaceSideHint: ProductSetupSide | null = null;

const WORKSPACE_SIDES: ProductSetupSide[] = ['front', 'back', 'left', 'right'];

function workspaceSideLabel(side: ProductSetupSide): string {
  return side === 'front' ? 'Front' : side === 'back' ? 'Back' : side === 'left' ? 'Left' : 'Right';
}

interface WorkspacePhotoRef {
  side: ProductSetupSide;
  imagePath: string;
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
}

function workspaceMergedMappings(): { version: 1; mappings: PhotoMappingEntry[] } {
  if (source === null) return { version: 1, mappings: [] };
  const assets = sessionAssetMap();
  return mergeSessionPhotoMappings(parsePhotoMappings(assets.get(PHOTO_MAPPINGS_PATH)), stagedPhotoMappings);
}

/**
 * Ranked mapping for one view: exact-variant staged first, then
 * exact-variant packaged, then product-wide staged, then product-wide
 * packaged. Deterministic; same-side duplicates from the Advanced editor
 * resolve to the most specific entry, never a blend.
 */
function workspaceMappingFor(
  productId: string,
  variantId: string,
  side: ProductSetupSide,
  imagePath: string,
): PhotoMappingEntry | null {
  const merged = workspaceMergedMappings();
  const stagedKeys = new Set(stagedPhotoMappings.map((entry) => mappingKeyOf(entry)));
  const candidates = merged.mappings.filter((entry) =>
    entry.productId === productId && entry.view === side && entry.image === imagePath &&
    (entry.variantId === undefined || entry.variantId === variantId));
  if (candidates.length === 0) return null;
  const score = (entry: PhotoMappingEntry): number =>
    (entry.variantId === variantId ? 0 : 2) + (stagedKeys.has(mappingKeyOf(entry)) ? 0 : 1);
  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0] ?? null;
}

/**
 * Photos available for one product/variant: manifest sided views first;
 * mapping-declared sides for manifest images second (a v1 single reference
 * gains a tab once a mapping declares its side explicitly). Missing sides
 * are absent, never invented; undecodable bytes become error views.
 */
function workspacePhotosFor(
  productId: string,
  variantId: string,
): { photos: WorkspacePhotoRef[]; warning: string | null } {
  const assets = sessionAssetMap();
  const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
  const manifest = parsePresentationManifest(manifestBytes);
  const selection = selectPresentationViews(
    manifest,
    manifestBytes !== undefined,
    productId,
    variantId,
    (path) => assets.get(path),
  );
  const bySide = new Map<ProductSetupSide, { imagePath: string }>();
  for (const view of selection.views) {
    if (view.view === null) continue;
    if (!bySide.has(view.view)) bySide.set(view.view, { imagePath: view.imagePath });
  }
  if (manifest !== null && manifest.version === 1) {
    for (const single of selection.views) {
      if (single.view !== null) continue;
      for (const entry of workspaceMergedMappings().mappings) {
        if (entry.productId !== productId || entry.image !== single.imagePath) continue;
        if (entry.variantId !== undefined && entry.variantId !== variantId) continue;
        if (!bySide.has(entry.view)) bySide.set(entry.view, { imagePath: entry.image });
      }
    }
  }
  const photos: WorkspacePhotoRef[] = [];
  for (const side of WORKSPACE_SIDES) {
    const found = bySide.get(side);
    if (!found) continue;
    const bytes = assets.get(found.imagePath);
    if (!bytes) continue;
    const header = readRasterHeader(bytes);
    if (!header) continue;
    photos.push({ side, imagePath: found.imagePath, bytes, widthPx: header.width, heightPx: header.height });
  }
  return { photos, warning: selection.warning };
}

function workspaceScopeFor(
  product: ProjectDocument['products'][number],
  variant: { id: string },
  region: ProjectDocument['products'][number]['regions'][number],
  side: ProductSetupSide,
): ProductSetupScope {
  // Display-only sharing note: the canonical region name/ids are untouched;
  // the human label carries the count so stage captions and the save
  // acknowledgement state it BEFORE any save (not only in the main status,
  // which the view's onStatus would otherwise overwrite).
  const linked = product.variants.filter((entry) => entry.regionIds.includes(region.id)).length;
  const base = region.name ?? null;
  return {
    productId: product.id,
    variantId: variant.id,
    regionId: region.id,
    frameId: region.frame.frameId,
    calibrationId: region.calibrationRef.calibrationId,
    calibrationVersion: region.calibrationRef.version,
    regionName: base === null ? null : linked > 1 ? `${base} (shared by ${linked} options)` : base,
    side,
  };
}

/** Empty scope for an unmeasured view: no region is bound to this view yet. */
function workspaceEmptyScope(productId: string, variantId: string, side: ProductSetupSide): ProductSetupScope {
  return {
    productId,
    variantId,
    regionId: '',
    frameId: '',
    calibrationId: '',
    calibrationVersion: '',
    regionName: null,
    side,
  };
}

function workspaceViewFor(
  product: ProjectDocument['products'][number],
  variant: { id: string },
  photo: WorkspacePhotoRef,
): ProductSetupPhotoView | { error: string } {
  const scopeProductId = product.id;
  const scopeVariantId = variant.id;
  const mapping = workspaceMappingFor(scopeProductId, scopeVariantId, photo.side, photo.imagePath);
  const photoId = workspacePhotoId(photo.imagePath, photo.bytes);
  const sourceRev = workspaceSourceRev();
  const photoInput = {
    bytes: photo.bytes,
    widthPx: photo.widthPx,
    heightPx: photo.heightPx,
    label: `${product.name ?? product.id} — ${workspaceSideLabel(photo.side)} view`,
  };
  if (!mapping) {
    return {
      scope: workspaceEmptyScope(scopeProductId, scopeVariantId, photo.side),
      photoId,
      sourceRev,
      photo: photoInput,
      transform: null,
      mappingStatus: 'provisional',
      safeArea: [],
      anchors: [],
    };
  }
  const region = product.regions.find((entry) => entry.id === mapping.regionId);
  if (!region) {
    return { error: `The saved mapping for the ${workspaceSideLabel(photo.side)} view references missing region “${mapping.regionId}”. Re-map this view (Advanced product setup → Map artwork photos).` };
  }
  return {
    scope: workspaceScopeFor(product, variant, region, photo.side),
    photoId,
    sourceRev,
    photo: photoInput,
    transform: { ...mapping.transform },
    mappingStatus: mapping.status,
    safeArea: region.safeArea
      .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map((point) => ({ x: point[0]!, y: point[1]! })),
    anchors: prepareAnchors
      .filter((anchor) =>
        anchor.productId === scopeProductId && anchor.variantId === scopeVariantId && anchor.regionId === region.id)
      .map((anchor) => ({ ...anchor, posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number] })),
  };
}

/** Last notice text this module wrote to the workspace status line. The view
 * reports every action through onStatus; getWorkspaceInput runs on every
 * render and must never clobber an action acknowledgement — it only
 * replaces text it wrote itself (context notices), leaving action statuses
 * intact until the context changes. */
let lastWorkspaceNotice = '';

function setWorkspaceNotice(message: string): void {
  workspaceStatus.textContent = message;
  lastWorkspaceNotice = message;
}

/**
 * Shared-region notice BEFORE any save: one region edited here updates every
 * linked option (anchors stay per-option). Stated up front, not only in the
 * save confirmation. Empty when no region is shared.
 */
function sharedNotice(product: ProjectDocument['products'][number]): string {
  const shared = product.regions.filter((region) =>
    product.variants.filter((entry) => entry.regionIds.includes(region.id)).length > 1);
  if (shared.length === 0) return '';
  return `Shared area${shared.length === 1 ? '' : 's'}: ${shared.map((region) => `“${region.name ?? region.id}” spans ${product.variants.filter((entry) => entry.regionIds.includes(region.id)).length} options`).join('; ')} — one save updates every linked option; anchors stay per option.`;
}

function getWorkspaceInput(): ProductSetupWorkspaceInput | { error: string } {
  if (source === null) {
    setWorkspaceNotice('Create or open a project first.');
    return { error: 'Create or open a project first, then add a real product.' };
  }
  const products = source.project.products;
  const product = products.find((entry) => entry.id === workspaceProductId) ?? products[0];
  if (product === undefined) {
    const message = 'Add a real product first (Choose items → Add product). The workspace stays empty until then.';
    setWorkspaceNotice(message);
    return { error: message };
  }
  const variant = product.variants.find((entry) => entry.id === workspaceVariantId) ?? product.variants[0];
  if (variant === undefined) {
    const message = 'This product has no options; re-add it from staged files.';
    setWorkspaceNotice(message);
    return { error: message };
  }
  const { photos, warning } = workspacePhotosFor(product.id, variant.id);
  if (photos.length === 0) {
    const message = 'To set measurements and anchors, add a product with a side photo.';
    setWorkspaceNotice(warning ?? '');
    return { error: message };
  }
  const views: ProductSetupWorkspaceInput['views'] = {};
  for (const photo of photos) {
    views[photo.side] = workspaceViewFor(product, variant, photo);
  }
  // Context notices replace only text this getter wrote itself (tracked in
  // lastWorkspaceNotice): view action acknowledgements arriving through
  // onStatus are never cleared by a render.
  const notice = warning ?? sharedNotice(product);
  if (workspaceStatus.textContent === lastWorkspaceNotice) setWorkspaceNotice(notice);
  if (workspaceSideHint === null) return { views };
  return { initialSide: workspaceSideHint, views };
}

/**
 * Workspace persistence commits run strictly one at a time. The open-session
 * identity (source object + session counter) is captured at SUBMISSION, so a
 * save queued before a source replacement is rejected when it reaches the
 * front — even if the new project reuses product/region/frame ids. Serial
 * saves within the same open session proceed normally. Non-commit UI (tab
 * switches, staged mapping edits) never blocks on this queue.
 */
let workspaceCommitTail: Promise<void> = Promise.resolve();
function enqueueWorkspaceCommit<T>(task: () => Promise<T>, staleResult: () => T): Promise<T> {
  const submittedSource = source;
  const submittedSession = sourceSession;
  const fresh = (): boolean => source === submittedSource && sourceSession === submittedSession;
  const guarded = async (): Promise<T> => (fresh() ? task() : staleResult());
  const run = workspaceCommitTail.then(guarded, guarded);
  workspaceCommitTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Atomic workspace save: the region safe area + the scope's anchors persist
 * together through one repackage-and-reparse commit, or neither does. Only
 * the commit assigns `source`/`prepareAnchors`; every failure path leaves
 * the previous session state untouched and reports `{ ok: false }` so the
 * view keeps the draft dirty and intact.
 *
 * Region geometry is genuinely shared: editing a region's safe area updates
 * every variant linked to that region (the save message names the region and
 * its variant count). Anchors and mappings stay per-variant.
 */
async function saveWorkspaceSetup(
  scope: ProductSetupScope,
  result: { safeArea: AnchorSetupMm[]; anchors: import('./product-setup-view.js').ProductSetupResult['anchors'] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const submittedSource = source;
  const submittedSession = sourceSession;
  return enqueueWorkspaceCommit(async () => {
  if (source !== submittedSource || sourceSession !== submittedSession) {
    return { ok: false, error: 'The project changed before saving started (new file opened or product added); re-open the view and save again. Nothing was saved.' };
  }
  if (source === null) return { ok: false, error: 'No project is open; create or open one first. Nothing was saved.' };
  const snapshot = source;
  const stale = (): boolean => source !== snapshot;
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error: `${error} Nothing was saved.` });
  try {
    const product = snapshot.project.products.find((entry) => entry.id === scope.productId);
    if (!product) return fail(`Product “${scope.productId}” is no longer in the project.`);
    const variant = product.variants.find((entry) => entry.id === scope.variantId);
    if (!variant) return fail(`Option “${scope.variantId}” is no longer in the product.`);
    const region = product.regions.find((entry) => entry.id === scope.regionId);
    if (!region) return fail('The measured area for this view no longer exists; measure it again first.');
    if (region.frame.frameId !== scope.frameId ||
      region.calibrationRef.calibrationId !== scope.calibrationId ||
      region.calibrationRef.version !== scope.calibrationVersion) {
      return fail('The measured area changed (frame or calibration) while editing; refresh and re-author the setup.');
    }
    const check = validateSafeAreaPolygon(result.safeArea.map((point) => ({ x: point.x, y: point.y })));
    if (!check.ok) return fail(`The safe area is invalid — ${check.reason}.`);
    const anchorProblem = validateAnchors(result.anchors);
    if (anchorProblem) return fail(`An anchor is invalid — ${anchorProblem}.`);
    const next: ProjectDocument = JSON.parse(JSON.stringify(snapshot.project)) as ProjectDocument;
    const nextRegion = next.products
      .find((entry) => entry.id === scope.productId)?.regions
      .find((entry) => entry.id === scope.regionId);
    if (!nextRegion) return fail('The measured area for this view no longer exists; measure it again first.');
    nextRegion.safeArea = result.safeArea.map((point) => [point.x, point.y] as [number, number]);
    const liveAnchors = prepareAnchors;
    const nextAnchors: AnchorDef[] = snapshot.project.products.some((entry) => entry.id === scope.productId)
      ? liveAnchors
        .filter((anchor) => !(anchor.productId === scope.productId && anchor.variantId === scope.variantId && anchor.regionId === scope.regionId))
        .map((anchor) => ({ ...anchor, posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number] }))
        .concat(result.anchors.map((anchor) => ({
          ...anchor,
          productId: scope.productId,
          variantId: scope.variantId,
          regionId: scope.regionId,
          frameId: scope.frameId,
          calibrationId: scope.calibrationId,
          calibrationVersion: scope.calibrationVersion,
          posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number],
        })))
      : [];
    const validated = validateProject(next);
    if (!validated || validated.ok !== true) {
      const problems = validated && Array.isArray(validated.errors)
        ? validated.errors.slice(0, 3).map((entry) => `${entry.code} at ${entry.path}`).join('; ')
        : 'the project did not validate';
      return fail(`The project rejects this setup (${problems}).`);
    }
    if (stale()) return fail('The project changed while saving (new file opened or product added); re-open the view and save again.');
    const digest = await hasher.prepareProject(next);
    if (stale()) return fail('The project changed while saving (new file opened or product added); re-open the view and save again.');
    const additionalAssets = [
      ...snapshot.assets
        .filter((asset) => asset.kind === 'additional' && asset.path !== OPERATION_ANCHORS_PATH)
        .map(({ path, bytes }) => ({ path, bytes })),
      { path: OPERATION_ANCHORS_PATH, bytes: buildAnchorsSidecarBytes(next, digest, nextAnchors) },
    ];
    const packageBytes = await createProjectPackage(
      {
        project: next,
        assets: snapshot.assets.filter((asset) => asset.kind !== 'additional').map(({ path, bytes }) => ({ path, bytes })),
        additionalAssets,
      },
      { sha256: hasher.sha256Bytes },
    );
    if (stale()) return fail('The project changed while saving (new file opened or product added); re-open the view and save again.');
    const back = await parseProjectPackage(packageBytes, { sha256: hasher.sha256Bytes });
    assertProjectEditorLimits(back.project);
    if (canonicalize(back.project) !== canonicalize(next)) {
      return fail('The reparse changed the project.');
    }
    // Compare actual sidecar CONTENT, not just presence: the save always
    // writes the sidecar, and the reopened master must carry exactly the
    // saved anchors.
    const expectedScoped = nextAnchors.filter((anchor) =>
      next.products.some((entry) =>
        entry.id === anchor.productId &&
        entry.variants.some((v) => v.id === anchor.variantId) &&
        entry.regions.some((r) => r.id === anchor.regionId)));
    const backSidecar = back.assets.find((asset) => asset.path === OPERATION_ANCHORS_PATH);
    if (backSidecar === undefined) return fail('The reparse lost the anchors sidecar.');
    let backAnchors: unknown = null;
    try {
      backAnchors = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(backSidecar.bytes));
    } catch {
      return fail('The reparsed anchors sidecar is not valid JSON.');
    }
    const sameAnchors = JSON.stringify((backAnchors as { anchors?: unknown }).anchors) ===
      JSON.stringify(expectedScoped.map((anchor) => ({ ...anchor })));
    if (!sameAnchors) return fail('The reparse changed the saved anchors.');
    if (stale()) return fail('The project changed while saving (new file opened or product added); re-open the view and save again.');
    prepareAnchors = nextAnchors;
    source = {
      fileName: snapshot.fileName,
      project: back.project,
      assets: back.assets,
      summary: summarizeSourceProject(back.project),
      packageBytes: packageBytes.slice(),
    };
    refreshWorkspaceSelectors();
    workspaceView.refresh();
    workspaceStatus.textContent =
      `Saved ${scope.regionName ?? 'measured area'} · ${workspaceSideLabel(scope.side)} ` +
      `(${result.safeArea.length} safe-area corners, ${result.anchors.length} anchors).`;
    return { ok: true };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  }, () => ({ ok: false, error: 'The project changed before saving started (new file opened or product added); re-open the view and save again. Nothing was saved.' }));
}

/** Route an unmeasured view to the guided first-measured-region panel. */
function routeWorkspaceScaleNeeded(scope: ProductSetupScope): void {
  if (source === null) {
    workspaceStatus.textContent = 'Create or open a project first.';
    return;
  }
  const product = source.project.products.find((entry) => entry.id === scope.productId);
  const variant = product?.variants.find((entry) => entry.id === scope.variantId);
  if (!product || !variant) {
    workspaceStatus.textContent = 'The product for this view is no longer in the project.';
    return;
  }
  const { photos } = workspacePhotosFor(product.id, variant.id);
  const photo = photos.find((entry) => entry.side === scope.side);
  if (!photo) {
    workspaceStatus.textContent =
      `The ${workspaceSideLabel(scope.side)} view has no photo: assign a ${scope.side} view image above (Choose items → Add product), then measure it here.`;
    return;
  }
  workspaceSideHint = scope.side;
  guidedScale.show({
    scope,
    photo: {
      bytes: photo.bytes,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      label: `${product.name ?? product.id} — ${workspaceSideLabel(photo.side)} view`,
    },
    imagePath: photo.imagePath,
  });
  workspaceStatus.textContent =
    `The ${workspaceSideLabel(scope.side)} view has no measured area yet. Click its 4 rectangle corners below, enter the real width + height, and create the measured area — no placements until then.`;
}

const workspaceCallbacks: ProductSetupCallbacks = {
  onSave: (scope, result) => saveWorkspaceSetup(scope, result),
  onStatus: (message) => {
    workspaceStatus.textContent = message;
  },
  onScaleNeeded: (scope) => routeWorkspaceScaleNeeded(scope),
};

const workspaceView = createProductSetupView(workspaceBox, getWorkspaceInput, workspaceCallbacks);

const guidedScale = createGuidedScale(guidedScaleBox, {
  onCommit: (request, commit) => commitGuidedScale(request, commit),
  onCancel: () => {
    guidedScaleBox.hidden = true;
    workspaceStatus.textContent = 'Measure setup cancelled; the view stays unmeasured.';
  },
  onStatus: (message) => {
    workspaceStatus.textContent = message;
  },
});

function refreshWorkspaceSelectors(): void {
  if (source === null) {
    workspaceProduct.replaceChildren();
    workspaceVariant.replaceChildren();
    workspaceProductId = null;
    workspaceVariantId = null;
    return;
  }
  const products = source.project.products;
  const keptProduct = workspaceProductId;
  workspaceProduct.replaceChildren();
  for (const product of products) {
    const option = document.createElement('option');
    option.value = product.id;
    option.textContent = product.name ?? product.id;
    workspaceProduct.append(option);
  }
  if (keptProduct !== null && products.some((entry) => entry.id === keptProduct)) {
    workspaceProduct.value = keptProduct;
  } else if (products.length > 0) {
    workspaceProduct.value = products[0]!.id;
  }
  workspaceProductId = workspaceProduct.value !== '' ? workspaceProduct.value : null;
  const product = products.find((entry) => entry.id === workspaceProductId) ?? null;
  const variants = product?.variants ?? [];
  const keptVariant = workspaceVariantId;
  workspaceVariant.replaceChildren();
  for (const variant of variants) {
    const option = document.createElement('option');
    option.value = variant.id;
    option.textContent = variant.name ?? (variants.length === 1
      ? 'Standard option' : `Option ${variants.indexOf(variant) + 1}`);
    workspaceVariant.append(option);
  }
  if (keptVariant !== null && variants.some((entry) => entry.id === keptVariant)) {
    workspaceVariant.value = keptVariant;
  } else if (variants.length > 0) {
    workspaceVariant.value = variants[0]!.id;
  }
  workspaceVariantId = workspaceVariant.value !== '' ? workspaceVariant.value : null;
  for (const label of document.querySelectorAll<HTMLElement>('[data-workspace-when]')) {
    const kind = label.getAttribute('data-workspace-when');
    label.hidden = kind === 'multi-product' ? products.length <= 1 : variants.length <= 1;
  }
}

function refreshWorkspace(): void {
  refreshWorkspaceSelectors();
  refreshPhotoAttachHint();
  workspaceView.refresh();
  void refreshStaffModel();
}

/**
 * The add-product form lives in a disclosure: wide open with an inviting
 * label for the truly empty draft, folded to "Add another product" once
 * real products exist so the visual workspace owns the first viewport.
 * Called only on source replacement (never on plain refreshes), so an
 * operator's manual open/close is never snapped shut under them.
 */
function refreshAddProductDisclosure(): void {
  const count = source?.project.products.length ?? 0;
  if (count === 0) {
    addProductDisclosure.open = true;
    addProductSummary.textContent = 'Add a product';
  } else {
    addProductDisclosure.open = false;
    addProductSummary.textContent = 'Add another product';
  }
}

/* ---------------- Staff 3D reference (white stage, orbit only) ---------------- */
/* Model-only uploads cannot host millimetre authoring (no evaluated photo   */
/* mapping), but the operator still sees the ACTUAL model on a white stage   */
/* with a concise route to add a side photo — never a bare no-photo error,   */
/* never a fake mesh projection. The photo workspace owns measured work; the */
/* model pane shows only when it has no usable photos.                       */

let staffModelViewer: { dispose(): void } | null = null;
let staffModelKey: string | null = null;
let staffModelGeneration = 0;

function disposeStaffModel(): void {
  if (staffModelViewer !== null) {
    try {
      staffModelViewer.dispose();
    } catch {
      /* best-effort GL teardown */
    }
    staffModelViewer = null;
  }
  staffModelKey = null;
}

async function refreshStaffModel(): Promise<void> {
  const generation = ++staffModelGeneration;
  const isCurrent = (): boolean => generation === staffModelGeneration;
  if (source === null) {
    disposeStaffModel();
    productModelBox.hidden = true;
    return;
  }
  const products = source.project.products;
  const product = products.find((entry) => entry.id === workspaceProductId) ?? products[0] ?? null;
  if (product === null) {
    disposeStaffModel();
    productModelBox.hidden = true;
    return;
  }
  const variant = product.variants.find((entry) => entry.id === workspaceVariantId) ?? product.variants[0] ?? null;
  if (variant === null) {
    disposeStaffModel();
    productModelBox.hidden = true;
    return;
  }
  // Photos own the stage when present; the model pane fills the model-only gap.
  const { photos } = workspacePhotosFor(product.id, variant.id);
  if (photos.length > 0 || !isCurrent()) {
    if (photos.length > 0) {
      disposeStaffModel();
      productModelBox.hidden = true;
    }
    return;
  }
  const assets = sessionAssetMap();
  const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
  const selection = selectPresentationModel(
    parsePresentationManifest(manifestBytes),
    manifestBytes !== undefined,
    product.id,
    variant.id,
    (path) => assets.get(path),
  );
  if (selection.modelPath === null) {
    disposeStaffModel();
    productModelBox.hidden = true;
    return;
  }
  const bytes = assets.get(selection.modelPath);
  if (!bytes || bytes.length === 0) {
    disposeStaffModel();
    productModelBox.hidden = true;
    productModelStatus.textContent = '';
    return;
  }
  const key = `${selection.modelPath}#${bytes.length}:${fnv1a32Hex(bytes)}`;
  if (staffModelViewer !== null && staffModelKey === key) {
    productModelBox.hidden = false;
    return;
  }
  productModelBox.hidden = false;
  productModelStatus.textContent = `Showing ${selection.label ?? selection.modelPath} for reference — orbit to inspect.`;
  try {
    const module = await import('../../viewer/model-viewer.js');
    if (!isCurrent() || source === null) return;
    const live = assets.get(selection.modelPath);
    if (!live || live.length === 0) {
      productModelStatus.textContent = 'The 3D model is no longer in the package.';
      return;
    }
    disposeStaffModel();
    // Fresh canvas per attach: a disposed GL context cannot be re-acquired
    // on the same element.
    const fresh = document.createElement('canvas');
    fresh.setAttribute('aria-label', '3D model reference preview');
    productModelStage.replaceChildren(fresh);
    const attached = module.ModelViewer.attach({
      canvas: fresh,
      container: productModelStage,
      background: 0xffffff,
    });
    if (attached.viewer === null) {
      productModelStatus.textContent = `3D preview unavailable: ${attached.status.kind === 'webgl-unavailable' ? attached.status.message : 'no viewer'}. Assign a side view photo above to author measurements.`;
      return;
    }
    staffModelViewer = attached.viewer;
    staffModelKey = key;
    const shown = await attached.viewer.showModel(bytes.slice());
    if (!isCurrent()) return;
    if (shown.kind !== 'ready' && shown.kind !== 'empty' && shown.kind !== 'loading') {
      productModelStatus.textContent = `3D preview unavailable (${shown.message}). Assign a side view photo above to author measurements.`;
    }
  } catch (error) {
    if (!isCurrent()) return;
    disposeStaffModel();
    productModelStatus.textContent = `3D preview unavailable: ${error instanceof Error ? error.message : String(error)}. Assign a side view photo above to author measurements.`;
  }
}

workspaceProduct.addEventListener('change', () => {
  workspaceProductId = workspaceProduct.value !== '' ? workspaceProduct.value : null;
  workspaceVariantId = null;
  workspaceSideHint = null;
  guidedScale.hide();
  if (!prepareBlocked()) refreshWorkspace();
});
workspaceVariant.addEventListener('change', () => {
  workspaceVariantId = workspaceVariant.value !== '' ? workspaceVariant.value : null;
  workspaceSideHint = null;
  guidedScale.hide();
  if (!prepareBlocked()) refreshWorkspace();
});

/** Warn at/above this fit residual; refuse above the hard bound. */
const GUIDED_RESIDUAL_WARN_MM = 1;
const GUIDED_RESIDUAL_REFUSE_MM = 5;

/**
 * Commit a guided first-measured-region panel result: solve the four
 * UV↔mm correspondences with the existing affine solver, then create the
 * calibration record + region + provisional mapping in ONE atomic
 * repackage-and-reparse commit. The rectangle safeArea defaults to the
 * measured rectangle; the variant is linked; any prior mapping for the
 * same (product, view, image) is replaced (staged and packaged), never
 * duplicated. `source`/`stagedPhotoMappings` change only on success.
 */
async function commitGuidedScale(
  request: GuidedScaleRequest,
  commit: GuidedScaleCommit,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const submittedSource = source;
  const submittedSession = sourceSession;
  return enqueueWorkspaceCommit(async () => {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error: error });
  if (source !== submittedSource || sourceSession !== submittedSession) {
    return fail('The project changed before measuring started (new file opened or product added); measure again.');
  }
  try {
    if (source === null) return fail('No project is open; create or open one first.');
    const snapshot = source;
    const stale = (): boolean => source !== snapshot;
    const product = snapshot.project.products.find((entry) => entry.id === request.scope.productId);
    if (!product) return fail(`Product “${request.scope.productId}” is no longer in the project.`);
    const variant = product.variants.find((entry) => entry.id === request.scope.variantId);
    if (!variant) return fail(`Option “${request.scope.variantId}” is no longer in the product.`);
    const side = request.scope.side;
    if (side !== 'front' && side !== 'back' && side !== 'left' && side !== 'right') {
      return fail(`Unknown view side “${request.scope.side}”.`);
    }
    const assets = sessionAssetMap();
    const photoBytes = assets.get(request.imagePath);
    if (!photoBytes || photoBytes.length === 0) {
      return fail(`Photo “${request.imagePath}” is missing from the package; re-add the product photo first.`);
    }
    if (!(commit.widthMm > 0) || !Number.isFinite(commit.widthMm) || commit.widthMm > 100000) {
      return fail('Enter the rectangle width in millimetres (a number above 0, at most 100000).');
    }
    if (!(commit.heightMm > 0) || !Number.isFinite(commit.heightMm) || commit.heightMm > 100000) {
      return fail('Enter the rectangle height in millimetres (a number above 0, at most 100000).');
    }
    const built = guidedCorrespondences(commit.cornersUv, commit.widthMm, commit.heightMm, commit.orientation);
    if (!built.ok) return fail(built.error);
    const transform = solveAffineFromCorrespondences(built.pairs);
    if (transform === null) {
      return fail('The 4 corners do not determine a mapping: use 4 finite, non-collinear corners of a genuine rectangle (a line or repeated point is refused). Re-click the corners in C1→C4 order.');
    }
    const det = transform.a * transform.e - transform.b * transform.d;
    let maxResidualMm = 0;
    for (const pair of built.pairs) {
      const du = pair.uv.u - transform.c;
      const dv = pair.uv.v - transform.f;
      const xPred = (transform.e * du - transform.b * dv) / det;
      const yPred = (-transform.d * du + transform.a * dv) / det;
      const residual = Math.hypot(xPred - pair.mm.xMm, yPred - pair.mm.yMm);
      if (!Number.isFinite(residual)) return fail('The fit produced a non-finite residual; check the corner positions.');
      maxResidualMm = Math.max(maxResidualMm, residual);
    }
    if (maxResidualMm > GUIDED_RESIDUAL_REFUSE_MM) {
      return fail(`The corners fit badly (max residual ${maxResidualMm.toFixed(1)} mm over ${GUIDED_RESIDUAL_REFUSE_MM} mm): re-click the 4 corners in C1→C4 order, or the photo has too much perspective for an affine fit.`);
    }
    const widthMm = commit.widthMm;
    const heightMm = commit.heightMm;
    const next: ProjectDocument = JSON.parse(JSON.stringify(snapshot.project)) as ProjectDocument;
    const nextProduct = next.products.find((entry) => entry.id === product.id)!;
    const takenCalibrations = new Set(nextProduct.calibrations.map((entry) => entry.id));
    let calSeq = nextProduct.calibrations.length + 1;
    while (takenCalibrations.has(`cal-visual-${calSeq}`)) calSeq += 1;
    const calibrationId = `cal-visual-${calSeq}`;
    const takenRegions = new Set(nextProduct.regions.map((entry) => entry.id));
    let regionSeq = nextProduct.regions.length + 1;
    while (takenRegions.has(`region-visual-${regionSeq}`)) regionSeq += 1;
    const regionId = `region-visual-${regionSeq}`;
    const frameId = `frame-${regionId}`;
    const orientationWord = commit.orientation === 'photo-up' ? 'photo top = area top' : 'photo top = area bottom (photo upside-down)';
    nextProduct.calibrations.push({
      id: calibrationId,
      version: '1',
      description: `Visual rectangle ${widthMm}×${heightMm} mm (${orientationWord}); max residual ${maxResidualMm.toFixed(3)} mm`,
    });
    nextProduct.regions.push({
      id: regionId,
      name: `${workspaceSideLabel(side)} measured area`,
      frame: {
        frameId,
        originDescription: `Lower-left corner of the measured rectangle as seen in the photo (${orientationWord})`,
        axes: { xPositive: 'right along the measured width', yPositive: 'up along the measured height' },
      },
      calibrationRef: { calibrationId, version: '1' },
      safeArea: [[0, 0], [widthMm, 0], [widthMm, heightMm], [0, heightMm]],
      allowedMethods: ['embroidery', 'print'],
    });
    const nextVariant = nextProduct.variants.find((entry) => entry.id === variant.id)!;
    if (!nextVariant.regionIds.includes(regionId)) nextVariant.regionIds.push(regionId);
    const warnNote = maxResidualMm >= GUIDED_RESIDUAL_WARN_MM
      ? `; residual ${maxResidualMm.toFixed(3)} mm ≥ ${GUIDED_RESIDUAL_WARN_MM} mm — verify on the photo`
      : '';
    const entry: PhotoMappingEntry = {
      productId: product.id,
      variantId: variant.id,
      regionId,
      view: side,
      image: request.imagePath,
      transform: { ...transform },
      calibrationId,
      calibrationVersion: '1',
      status: 'provisional',
      note: `Guided rectangle ${widthMm}×${heightMm} mm, ${commit.orientation}; max residual ${maxResidualMm.toFixed(3)} mm${warnNote}`,
    };
    const problems = validatePhotoMapping(entry);
    if (problems.length > 0) return fail(`The mapping is invalid: ${problems.join('; ')}.`);
    const validated = validateProject(next);
    if (!validated || validated.ok !== true) {
      const detail = validated && Array.isArray(validated.errors)
        ? validated.errors.slice(0, 3).map((issue) => `${issue.code} at ${issue.path}`).join('; ')
        : 'the project did not validate';
      return fail(`The project rejects this measured area (${detail}).`);
    }
    // Replacement is scoped to the edited variant ONLY: exact-variant
    // entries for this (product, view, image) are replaced, product-wide
    // fallbacks for other variants are preserved. Staged state is rebuilt
    // from the LIVE array at commit time (last writer wins for the same
    // key); nothing is assigned before the validated reparse succeeds.
    const isReplacedMapping = (candidate: PhotoMappingEntry): boolean =>
      candidate.productId === product.id && candidate.variantId === variant.id &&
      candidate.view === side && candidate.image === request.imagePath;
    if (stale()) return fail('The project changed while measuring (new file opened or product added); measure again.');
    const livePhoto = sessionAssetMap().get(request.imagePath);
    if (!livePhoto || livePhoto.length === 0) {
      return fail(`Photo “${request.imagePath}” left the package while measuring; re-add the product photo first.`);
    }
    const base = parsePhotoMappings(snapshot.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes);
    const baseKept = (base?.mappings ?? []).filter((candidate) => !isReplacedMapping(candidate));
    const stagedKept = stagedPhotoMappings.filter((candidate) => !isReplacedMapping(candidate));
    const mergedBytes = serializePhotoMappings(mergeSessionPhotoMappings({ version: 1, mappings: baseKept }, [...stagedKept, entry]));
    const additionalAssets = [
      ...snapshot.assets
        .filter((asset) => asset.kind === 'additional' && asset.path !== PHOTO_MAPPINGS_PATH && asset.path !== OPERATION_ANCHORS_PATH)
        .map(({ path, bytes }) => ({ path, bytes })),
      { path: PHOTO_MAPPINGS_PATH, bytes: mergedBytes },
    ];
    const packagedSidecar = snapshot.assets.find((asset) => asset.path === OPERATION_ANCHORS_PATH && asset.kind === 'additional');
    if (packagedSidecar !== undefined) {
      additionalAssets.push({ path: packagedSidecar.path, bytes: packagedSidecar.bytes });
    }
    const packageBytes = await createProjectPackage(
      {
        project: next,
        assets: snapshot.assets.filter((asset) => asset.kind !== 'additional').map(({ path, bytes }) => ({ path, bytes })),
        additionalAssets,
      },
      { sha256: hasher.sha256Bytes },
    );
    if (stale()) return fail('The project changed while measuring (new file opened or product added); measure again.');
    const back = await parseProjectPackage(packageBytes, { sha256: hasher.sha256Bytes });
    assertProjectEditorLimits(back.project);
    if (canonicalize(back.project) !== canonicalize(next)) {
      return fail('The reparse changed the project; the previous project is unchanged.');
    }
    // The packaged mapping file must carry the new entry with its exact
    // transform — compare content, not just presence.
    const backMappings = parsePhotoMappings(back.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH)?.bytes);
    const backEntry = backMappings?.mappings.find((candidate) => mappingKeyOf(candidate) === mappingKeyOf(entry));
    if (!backEntry || JSON.stringify(backEntry.transform) !== JSON.stringify(entry.transform) ||
      backEntry.regionId !== entry.regionId || backEntry.calibrationId !== entry.calibrationId) {
      return fail('The reparse lost the new mapping; the previous project is unchanged.');
    }
    if (stale()) return fail('The project changed while measuring (new file opened or product added); measure again.');
    stagedPhotoMappings = [...stagedPhotoMappings.filter((candidate) => !isReplacedMapping(candidate)), entry];
    source = {
      fileName: snapshot.fileName,
      project: back.project,
      assets: back.assets,
      summary: summarizeSourceProject(back.project),
      packageBytes: packageBytes.slice(),
    };
    workspaceSideHint = side;
    guidedScale.hide();
    refreshWorkspaceSelectors();
    workspaceView.refresh();
    refreshMappingOptions();
    renderSavedMappings();
    workspaceStatus.textContent =
      `Measured the ${workspaceSideLabel(side)} view: ${widthMm}×${heightMm} mm ` +
      `(max residual ${maxResidualMm.toFixed(3)} mm). Draw the safe area and place anchors, then save once.` +
      (warnNote !== '' ? ' Residual is high — verify the corners on the photo.' : '');
    return { ok: true };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  }, () => ({ ok: false, error: 'The project changed before measuring finished (new file opened or product added); measure again.' }));
}

function mappingSelectedProduct(): ProjectDocument['products'][number] | null {
  if (source === null) return null;
  return source.project.products.find((entry) => entry.id === mappingProduct.value) ?? null;
}

function sessionAssetMap(): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  if (source !== null) {
    for (const asset of source.assets) {
      if (!map.has(asset.path)) map.set(asset.path, asset.bytes);
    }
  }
  for (const entry of addedPresentations) {
    for (const asset of entry.assets) {
      if (!map.has(asset.path)) map.set(asset.path, asset.bytes);
    }
  }
  return map;
}

function refreshMappingOptions(): void {
  if (source === null) {
    for (const select of [mappingProduct, mappingVariant, mappingRegion, mappingPhoto]) select.replaceChildren();
    mappingFrame.textContent = 'Create or open a project first.';
    mappingPhotoStatus.textContent = '';
    mappingSave.disabled = true;
    renderSavedMappings();
    return;
  }
  const keptProduct = mappingProduct.value;
  mappingProduct.replaceChildren();
  for (const product of source.project.products) {
    const option = document.createElement('option');
    option.value = product.id;
    option.textContent = product.name !== undefined ? `${product.name} (${product.id})` : product.id;
    mappingProduct.append(option);
  }
  if (keptProduct !== '' && source.project.products.some((entry) => entry.id === keptProduct)) {
    mappingProduct.value = keptProduct;
  }
  refreshMappingVariants();
}

function refreshMappingVariants(): void {
  const product = mappingSelectedProduct();
  const kept = mappingVariant.value;
  mappingVariant.replaceChildren();
  if (product !== null) {
    const wide = document.createElement('option');
    wide.value = '';
    wide.textContent = '(product-wide)';
    mappingVariant.append(wide);
    for (const variant of product.variants) {
      const option = document.createElement('option');
      option.value = variant.id;
      option.textContent = variant.name !== undefined ? `${variant.name} (${variant.id})` : variant.id;
      mappingVariant.append(option);
    }
    if (kept !== '' && product.variants.some((entry) => entry.id === kept)) {
      mappingVariant.value = kept;
    } else if (product.variants.length > 0) {
      mappingVariant.value = product.variants[0]!.id;
    }
  }
  refreshMappingRegions();
}

function refreshMappingRegions(): void {
  const product = mappingSelectedProduct();
  const kept = mappingRegion.value;
  mappingRegion.replaceChildren();
  if (product !== null) {
    const variantId = mappingVariant.value;
    const variant = product.variants.find((entry) => entry.id === variantId);
    const allowed = variant !== undefined ? new Set(variant.regionIds) : null;
    for (const region of product.regions) {
      if (allowed !== null && !allowed.has(region.id)) continue;
      const option = document.createElement('option');
      option.value = region.id;
      option.textContent = region.name !== undefined ? `${region.name} (${region.id})` : region.id;
      mappingRegion.append(option);
    }
    if (kept !== '' && product.regions.some((entry) => entry.id === kept) && (allowed === null || allowed.has(kept))) {
      mappingRegion.value = kept;
    }
  }
  updateMappingFrame();
  refreshMappingPhotos();
}

function updateMappingFrame(): void {
  const product = mappingSelectedProduct();
  const region = product?.regions.find((entry) => entry.id === mappingRegion.value);
  mappingFrame.textContent = region === undefined
    ? 'Choose a region to see its frame and calibration.'
    : `Frame: ${region.frame.originDescription}; +x ${region.frame.axes.xPositive}; +y ${region.frame.axes.yPositive} · Calibration ${region.calibrationRef.calibrationId} v${region.calibrationRef.version}`;
}

function refreshMappingPhotos(): void {
  mappingPhoto.replaceChildren();
  const product = mappingSelectedProduct();
  if (source === null || product === null) {
    mappingPhotoStatus.textContent = '';
    mappingSave.disabled = true;
    return;
  }
  const variantId = mappingVariant.value;
  const side = mappingSide.value;
  const assets = sessionAssetMap();
  const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
  const manifest = parsePresentationManifest(manifestBytes);
  // Same lookup rules as the customer preview: exact product(+variant)/side
  // match through selectPresentationViews, never filename inference.
  const selection = selectPresentationViews(
    manifest,
    manifestBytes !== undefined,
    product.id,
    variantId,
    (path) => assets.get(path),
  );
  const matches = selection.views.filter((view) => view.view === side);
  if (matches.length === 0) {
    const detail = selection.warning !== null ? ` ${selection.warning}` : '';
    mappingPhotoStatus.textContent = `No photo for this product/side yet — assign a side view image above first.${detail}`;
    mappingSave.disabled = true;
    return;
  }
  for (const view of matches) {
    const option = document.createElement('option');
    option.value = view.imagePath;
    option.textContent = view.label !== null ? `${view.imagePath} — ${view.label}` : view.imagePath;
    mappingPhoto.append(option);
  }
  mappingPhotoStatus.textContent = selection.warning ?? '';
  mappingSave.disabled = false;
}

function addMappingRow(): void {
  const index = mappingRowInputs.length + 1;
  const row = document.createElement('div');
  row.style.display = 'grid';
  row.style.gridTemplateColumns = 'repeat(4, minmax(0, 1fr))';
  row.style.gap = '8px';
  row.style.alignItems = 'end';
  const created = {} as MappingRowInputs;
  const defs = [
    ['u', `Reference point ${index} U (0..1)`, 'U (0..1)', '0.25'],
    ['v', `Reference point ${index} V (0..1)`, 'V (0..1)', '0.75'],
    ['x', `Reference point ${index} X millimetres`, 'X mm', '50'],
    ['y', `Reference point ${index} Y millimetres`, 'Y mm', '25'],
  ] as const;
  for (const [key, aria, label, placeholder] of defs) {
    const field = document.createElement('label');
    field.style.display = 'grid';
    field.style.gap = '4px';
    field.style.fontSize = '0.9rem';
    const caption = document.createElement('span');
    caption.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', aria);
    input.style.width = '100%';
    field.append(caption, input);
    row.append(field);
    created[key] = input;
  }
  mappingRowsBox.append(row);
  mappingRowInputs.push(created);
}

function readMappingPairs(): {
  pairs: Array<{ uv: { u: number; v: number }; mm: { xMm: number; yMm: number } }>;
  errors: string[];
} {
  const pairs: Array<{ uv: { u: number; v: number }; mm: { xMm: number; yMm: number } }> = [];
  const errors: string[] = [];
  mappingRowInputs.forEach((row, index) => {
    const texts = [row.u.value.trim(), row.v.value.trim(), row.x.value.trim(), row.y.value.trim()];
    if (texts.every((text) => text === '')) return;
    const values = [row.u.valueAsNumber, row.v.valueAsNumber, row.x.valueAsNumber, row.y.valueAsNumber];
    const names = ['U', 'V', 'X mm', 'Y mm'] as const;
    for (let k = 0; k < values.length; k += 1) {
      if (!Number.isFinite(values[k])) {
        errors.push(`Reference point ${index + 1}: ${names[k]} must be a finite number.`);
        return;
      }
    }
    pairs.push({
      uv: { u: values[0]!, v: values[1]! },
      mm: { xMm: values[2]!, yMm: values[3]! },
    });
  });
  return { pairs, errors };
}

type MappingFit =
  | {
    ok: true;
    transform: PhotoMappingTransform;
    determinant: number;
    maxResidualMm: number;
    count: number;
    productId: string;
    variantId: string | undefined;
    regionId: string;
    view: PhotoMappingView;
    image: string;
    calibrationId: string;
    calibrationVersion: string;
  }
  | { ok: false; error: string };

function fitSessionMapping(): MappingFit {
  if (source === null) return { ok: false, error: 'Create or open a project before mapping photos.' };
  const product = source.project.products.find((entry) => entry.id === mappingProduct.value);
  if (product === undefined) return { ok: false, error: 'Choose a product for the mapping.' };
  const variantId = mappingVariant.value !== '' ? mappingVariant.value : undefined;
  const region = product.regions.find((entry) => entry.id === mappingRegion.value);
  if (region === undefined) return { ok: false, error: 'Choose a region for the mapping.' };
  const side = mappingSide.value;
  if (side !== 'front' && side !== 'back' && side !== 'left' && side !== 'right') {
    return { ok: false, error: 'Choose a side for the mapping.' };
  }
  const photo = mappingPhoto.value;
  if (photo === '') {
    return { ok: false, error: 'No photo for this product/side yet — assign a side view image above first.' };
  }
  const { pairs, errors } = readMappingPairs();
  if (errors.length > 0) return { ok: false, error: errors.join(' ') };
  if (pairs.length < 3) {
    return { ok: false, error: `Add at least 3 complete reference points (have ${pairs.length}).` };
  }
  const transform = solveAffineFromCorrespondences(pairs);
  if (transform === null) {
    return { ok: false, error: 'Reference points do not determine a mapping: use at least 3 finite, non-collinear points (a line or a repeated point is refused).' };
  }
  const det = transform.a * transform.e - transform.b * transform.d;
  let maxResidualMm = 0;
  for (const pair of pairs) {
    const du = pair.uv.u - transform.c;
    const dv = pair.uv.v - transform.f;
    const xPred = (transform.e * du - transform.b * dv) / det;
    const yPred = (-transform.d * du + transform.a * dv) / det;
    const residual = Math.hypot(xPred - pair.mm.xMm, yPred - pair.mm.yMm);
    if (!Number.isFinite(residual)) {
      return { ok: false, error: 'Fit produced a non-finite residual; check the reference values.' };
    }
    maxResidualMm = Math.max(maxResidualMm, residual);
  }
  return {
    ok: true,
    transform,
    determinant: det,
    maxResidualMm,
    count: pairs.length,
    productId: product.id,
    variantId,
    regionId: region.id,
    view: side,
    image: photo,
    calibrationId: region.calibrationRef.calibrationId,
    calibrationVersion: region.calibrationRef.version,
  };
}

function formatFitNumber(value: number): string {
  if (!Number.isFinite(value)) return 'non-finite';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.001 || abs >= 10000)) return value.toExponential(2);
  return String(Number(value.toPrecision(4)));
}

function mappingBusy(): boolean {
  return loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy;
}

function onMappingCheck(): void {
  if (mappingBusy()) return;
  const fit = fitSessionMapping();
  if (!fit.ok) {
    mappingStatusLine.textContent = `Check failed: ${fit.error} Nothing was saved.`;
    return;
  }
  mappingStatusLine.textContent =
    `Fit OK over ${fit.count} points: determinant ${formatFitNumber(fit.determinant)}, max residual ${fit.maxResidualMm.toFixed(3)} mm. ` +
    'Nothing saved — press “Save mapping” to stage it.';
}

function onMappingSave(): void {
  if (mappingBusy()) return;
  const fit = fitSessionMapping();
  if (!fit.ok) {
    mappingStatusLine.textContent = `Not saved: ${fit.error} Previous staged mappings are unchanged.`;
    return;
  }
  const status = mappingStatus.value;
  if (status !== 'provisional' && status !== 'review') {
    mappingStatusLine.textContent = 'Not saved: choose a status of provisional or review. Previous staged mappings are unchanged.';
    return;
  }
  const note = mappingNote.value.trim();
  const entry: PhotoMappingEntry = {
    productId: fit.productId,
    regionId: fit.regionId,
    view: fit.view,
    image: fit.image,
    transform: fit.transform,
    calibrationId: fit.calibrationId,
    calibrationVersion: fit.calibrationVersion,
    status,
  };
  if (fit.variantId !== undefined) entry.variantId = fit.variantId;
  if (note !== '') entry.note = note;
  const problems = validatePhotoMapping(entry);
  if (problems.length > 0) {
    mappingStatusLine.textContent = `Not saved: ${problems.join('; ')}. Previous staged mappings are unchanged.`;
    return;
  }
  const key = mappingKeyOf(entry);
  const at = stagedPhotoMappings.findIndex((candidate) => mappingKeyOf(candidate) === key);
  if (at >= 0) stagedPhotoMappings[at] = entry;
  else stagedPhotoMappings.push(entry);
  renderSavedMappings();
  mappingStatusLine.textContent =
    `Saved ${status} mapping for ${fit.productId}${fit.variantId ? `/${fit.variantId}` : ''} · ${fit.regionId} · ${fit.view} · ${fit.image} ` +
    `(${stagedPhotoMappings.length} staged). It ships with the next customer file when you press “Create customer file”.`;
  refreshWorkspace();
}

function renderSavedMappings(): void {
  mappingSaved.replaceChildren();
  if (stagedPhotoMappings.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No staged mappings yet.';
    mappingSaved.append(empty);
    return;
  }
  const title = document.createElement('p');
  title.textContent = `Staged mappings (${stagedPhotoMappings.length}):`;
  mappingSaved.append(title);
  stagedPhotoMappings.forEach((entry, index) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '12px';
    row.style.alignItems = 'baseline';
    row.style.justifyContent = 'space-between';
    row.style.padding = '8px 0';
    const label = document.createElement('span');
    label.textContent =
      `${entry.productId}${entry.variantId ? `/${entry.variantId}` : ''} · ${entry.regionId} · ${entry.view} · ${entry.image} — ${entry.status}` +
      (entry.note ? ` — ${entry.note}` : '');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-secondary';
    remove.style.width = 'auto';
    remove.style.flex = 'none';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove staged mapping ${index + 1}`);
    remove.addEventListener('click', () => {
      stagedPhotoMappings.splice(index, 1);
      renderSavedMappings();
      refreshWorkspace();
      mappingStatusLine.textContent = `Removed one staged mapping (${stagedPhotoMappings.length} remain).`;
    });
    row.append(label, remove);
    mappingSaved.append(row);
  });
}

function resetMappingSessionUI(): void {
  stagedPhotoMappings = [];
  mappingRowInputs = [];
  mappingRowsBox.replaceChildren();
  for (let i = 0; i < 3; i += 1) addMappingRow();
  mappingStatus.value = 'provisional';
  mappingNote.value = '';
  mappingStatusLine.textContent = '';
  refreshMappingOptions();
  renderSavedMappings();
}

mappingDisclosureBox.addEventListener('toggle', () => {
  if (mappingDisclosureBox.open) refreshMappingOptions();
});
mappingProduct.addEventListener('change', refreshMappingVariants);
mappingVariant.addEventListener('change', refreshMappingRegions);
mappingRegion.addEventListener('change', updateMappingFrame);
mappingSide.addEventListener('change', refreshMappingPhotos);
mappingAddRow.addEventListener('click', () => {
  if (!mappingBusy()) addMappingRow();
});
mappingCheck.addEventListener('click', onMappingCheck);
mappingSave.addEventListener('click', onMappingSave);
for (let i = 0; i < 3; i += 1) addMappingRow();
renderSavedMappings();


/* ------------------------------------------------------------------ */
/* Operation-sheet authoring (review/prepare flow, check step).        */
/* Department-authored operational text, logo dimensions, business      */
/* codes, technique settings, visual anchor setup, and the versioned    */
/* operation-draft sidecar. Customer notes stay read-only context;      */
/* staff wording never forges approval and never rewrites canonical     */
/* customer instructions. No browser-storage persistence: drafts move   */
/* only through explicit save/reopen files, bound to source revision +  */
/* digest (stale reopens are refused, never silently applied).           */
/* ------------------------------------------------------------------ */

function authoringBlocked(): boolean {
  return loading || generating || creating || logoImporting || productImporting ||
    returnBusy || baselineBusy || lastReturn === null;
}

function resetSheetAuthoring(): void {
  sheetAuthoring.clear();
  authorAnchors = [];
  activeSheetConfigId = null;
  safeAreaProposals.clear();
  lastReturnAssets = null;
  lastReturnReferenceViews = Object.create(null);
  if (anchorSetupHandle !== null) {
    anchorSetupHandle.destroy();
    anchorSetupHandle = null;
  }
  sheetConfig.replaceChildren();
  sheetLogos.replaceChildren();
  sheetCustomerNotes.replaceChildren();
  sheetSummary.textContent = '';
  draftStatus.textContent = '';
  anchorStatus.textContent = '';
  anchorSide.replaceChildren();
  anchorRegion.replaceChildren();
  anchorSetupBox.replaceChildren();
  draftFile.value = '';
}

function logoRefForPlacement(placement: ExportPlacement, placements: readonly ExportPlacement[]): string {
  if (placement.id !== undefined) return placement.id;
  const same = placements.filter((entry) => entry.logoId === placement.logoId);
  const occurrence = same.indexOf(placement);
  return occurrence <= 0 ? placement.logoId : `${placement.logoId}#${occurrence}`;
}

function defaultSheetAuthoring(): SheetAuthoring {
  return {
    customer: '',
    reference: '',
    article: '',
    instructions: '',
    tech: { temperature: '', time: '', pressure: '', colour: '', thread: '' },
    logos: new Map<string, LogoAuthoring>(),
  };
}

function defaultLogoAuthoring(): LogoAuthoring {
  return { businessCode: '', measurements: [{ anchorId: '', edge: 'minX', convention: 'dx' }] };
}

function edgeWord(edge: ArtworkEdge): string {
  return edge === 'minX' ? 'left' : edge === 'maxX' ? 'right' : edge === 'minY' ? 'bottom' : 'top';
}

function conventionWord(convention: MeasurementConvention): string {
  return convention === 'dx' ? 'horizontal' : convention === 'dy' ? 'vertical' : 'shortest';
}

function bindingLabelFor(anchorName: string, edge: ArtworkEdge, convention: MeasurementConvention): string {
  return `Anchor “${anchorName}” to ${edgeWord(edge)} edge, ${conventionWord(convention)}`;
}

function activeReturn(): ReturnState | null {
  return lastReturn;
}

function activeCandidateConfig(): ExportConfiguration | null {
  const current = activeReturn();
  if (current === null || activeSheetConfigId === null) return null;
  return current.candidate.configurations.find((entry) => entry.id === activeSheetConfigId) ?? null;
}

function configDisplayName(config: ExportConfiguration): string {
  const product = activeReturn()?.candidate.products.find((entry) => entry.id === config.productId);
  const productLabel = config.productName ?? product?.name ?? config.productId;
  const variant = product?.variants.find((entry) => entry.id === config.variantId);
  const variantLabel = config.variantName ?? variant?.name ?? config.variantId;
  return `${productLabel} / ${variantLabel}`;
}

/** One binding per measurement row (same logoRef repeated across rows). */
function bindingsForConfig(configId: string): DimensionBinding[] {
  const authoring = sheetAuthoring.get(configId);
  const config = activeReturn()?.candidate.configurations.find((entry) => entry.id === configId);
  if (!authoring || !config) return [];
  const out: DimensionBinding[] = [];
  for (const placement of config.placements) {
    const logoRef = logoRefForPlacement(placement, config.placements);
    const row = authoring.logos.get(logoRef) ?? authoring.logos.get(placement.logoId);
    if (!row) continue;
    for (const measurement of row.measurements) {
      if (measurement.anchorId === '') continue;
      const anchor = authorAnchors.find((entry) => entry.id === measurement.anchorId);
      if (!anchor) continue;
      out.push({
        logoRef,
        anchorId: measurement.anchorId,
        edge: measurement.edge,
        convention: measurement.convention,
        label: bindingLabelFor(anchor.name, measurement.edge, measurement.convention),
      });
    }
  }
  return out;
}

function extrasForConfig(configId: string): Record<string, { businessCode?: string; methodParams?: Record<string, string>; colours?: string[] }> {
  const authoring = sheetAuthoring.get(configId);
  if (!authoring) return {};
  const methodParams: Record<string, string> = {};
  if (authoring.tech.temperature.trim() !== '') methodParams['temperature'] = authoring.tech.temperature.trim();
  if (authoring.tech.time.trim() !== '') methodParams['time'] = authoring.tech.time.trim();
  if (authoring.tech.pressure.trim() !== '') methodParams['pressure'] = authoring.tech.pressure.trim();
  if (authoring.tech.thread.trim() !== '') methodParams['thread'] = authoring.tech.thread.trim();
  const colour = authoring.tech.colour.trim();
  const out: Record<string, { businessCode?: string; methodParams?: Record<string, string>; colours?: string[] }> = {};
  for (const [logoRef, row] of authoring.logos) {
    const code = row.businessCode.trim();
    const entry: { businessCode?: string; methodParams?: Record<string, string>; colours?: string[] } = {};
    if (code !== '') entry.businessCode = code;
    if (Object.keys(methodParams).length > 0) entry.methodParams = { ...methodParams };
    if (colour !== '') entry.colours = [colour];
    if (Object.keys(entry).length > 0) out[logoRef] = entry;
  }
  return out;
}

function jobForActiveSheet(): OperationSheetJob {
  const authoring = activeSheetConfigId !== null ? sheetAuthoring.get(activeSheetConfigId) : undefined;
  const job: OperationSheetJob = {};
  if (authoring) {
    if (authoring.customer.trim() !== '') job.customer = authoring.customer.trim();
    if (authoring.reference.trim() !== '') job.reference = authoring.reference.trim();
    if (authoring.article.trim() !== '') job.article = authoring.article.trim();
  }
  return job;
}

function instructionsForActiveSheet(): string[] {
  const authoring = activeSheetConfigId !== null ? sheetAuthoring.get(activeSheetConfigId) : undefined;
  if (!authoring) return [];
  return authoring.instructions.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function bindingsByConfig(): Record<string, DimensionBinding[]> {
  const current = activeReturn();
  const out: Record<string, DimensionBinding[]> = Object.create(null);
  if (!current) return out;
  for (const config of current.candidate.configurations) {
    out[config.id] = bindingsForConfig(config.id);
  }
  return out;
}

function extrasByConfig(): Record<string, Record<string, { businessCode?: string; methodParams?: Record<string, string>; colours?: string[] }>> {
  const current = activeReturn();
  const out: Record<string, Record<string, { businessCode?: string; methodParams?: Record<string, string>; colours?: string[] }>> = Object.create(null);
  if (!current) return out;
  for (const config of current.candidate.configurations) {
    const extras = extrasForConfig(config.id);
    if (Object.keys(extras).length > 0) out[config.id] = extras;
  }
  return out;
}

/** Prefer a raster-previewable original; geometry still carries without one. */
function sheetArtworkUri(assets: ReadonlyArray<{ uri: string }>): string | undefined {
  if (assets.length === 0) return undefined;
  return assets.find((asset) => /\.(png|jpe?g|webp)$/i.test(asset.uri))?.uri ?? assets[0]?.uri;
}

function sheetOverlayLookup(
  assetBytes: Map<string, Uint8Array>,
  candidate: ResultCandidate,
  anchors: readonly AnchorDef[],
  bindings: Record<string, readonly DimensionBinding[]>,
): OperationSheetAssetLookup {
  const states = evaluateOperationPhotoStates(candidate, assetBytes);
  return {
    getBytes: (path) => assetBytes.get(path),
    getSheetOverlay: (sheetIndex) => {
      const config = candidate.configurations[sheetIndex];
      if (!config) return undefined;
      const configStates: readonly PhotoMappingState[] = states[config.id] ?? [];
      const sides = lastReturnReferenceViews[config.id] ?? [];
      const mappings: Array<SheetOverlayMapping | undefined> = sides.map((side) => {
        const bound = configStates.find((entry) => entry.imagePath === side.imagePath);
        if (!bound || bound.regionId === undefined || bound.view === undefined || bound.transform === undefined) {
          return undefined;
        }
        return {
          regionId: bound.regionId,
          view: bound.view,
          transform: { ...bound.transform },
          status: bound.status,
        };
      });
      const configBindings = bindings[config.id] ?? [];
      const artworks: Array<SheetOverlayArtwork | undefined> = config.placements.map((placement) => {
        const relevant = configBindings.filter((binding) => matchLogoRef(config.placements, binding.logoRef) === placement);
        const measured = measurePlacement(candidate, placement, anchors, relevant);
        const arrows = measured.dimensions.map((dimension) => ({
          p0: { x: dimension.endpoints[0]!.x, y: dimension.endpoints[0]!.y },
          p1: { x: dimension.endpoints[1]!.x, y: dimension.endpoints[1]!.y },
          ...(dimension.artworkPoint !== undefined
            ? { artworkPoint: { x: dimension.artworkPoint.x, y: dimension.artworkPoint.y } }
            : {}),
        }));
        const uri = sheetArtworkUri(placement.artwork.assets);
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

/** Station brand mark the build script inlines as a data URL on
 *  `img[data-station-brand]`. Only `data:image/(png|jpeg|webp);base64,…`
 *  passes through to the sheet; anything else (missing img, external URL)
 *  yields `undefined` so the renderer falls back to its wordmark. */
const STATION_MARK_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
function stationBrand(): { markDataUrl: string } | undefined {
  const src = document.querySelector<HTMLImageElement>('img[data-station-brand]')?.getAttribute('src');
  if (typeof src === 'string' && STATION_MARK_PATTERN.test(src)) return { markDataUrl: src };
  return undefined;
}

/** Rebuild the operation-sheet view from the SAME authoring state the
 *  preview renders (bindings, business codes, operational instructions,
 *  extras). Shared by the preview and the minimal operator JSON export. */
function buildCurrentSheetView(): OperationSheetView | null {
  const current = activeReturn();
  if (current === null) return null;
  const viewInput: BuildOperationSheetViewInput = {
    candidate: current.candidate,
    anchors: authorAnchors,
    bindings: bindingsByConfig(),
    job: jobForActiveSheet(),
    sides: lastReturnReferenceViews,
    extras: extrasByConfig(),
    operationalInstructions: instructionsForActiveSheet(),
  };
  return buildOperationSheetView(viewInput);
}

/** Rebuild the one-sheet preview from the current return + department authoring. */
function renderSheetPreview(): void {
  paintTechSummary();
  const current = activeReturn();
  if (current === null || lastReturnAssets === null) return;
  const view = buildCurrentSheetView();
  if (view === null) return;
  const lookup = sheetOverlayLookup(lastReturnAssets, current.candidate, authorAnchors, bindingsByConfig());
  ensureOperationStyles();
  operationContainer.replaceChildren();
  operationContainer.append(renderOperationSheet(view, document, lookup, stationBrand()));
  sheetSummary.textContent =
    `${operationSheetSummary(view)} · ${operationSheetPageCount(view, lookup)} printed page(s). ` +
    `Customer notes stay read-only source context above and never print; only department text prints as operational instructions.`;
}

/** Live count of filled technique settings on the disclosure summary. */
function paintTechSummary(): void {
  const authoring = activeSheetConfigId !== null ? sheetAuthoring.get(activeSheetConfigId) : undefined;
  const count = authoring === undefined ? 0 : [authoring.tech.temperature, authoring.tech.time, authoring.tech.pressure, authoring.tech.colour, authoring.tech.thread]
    .filter((value) => value.trim() !== '').length;
  techSummary.textContent = count === 0 ? '' : ` · ${count} set`;
}

function displayNameForLogo(candidate: ResultCandidate, placement: ExportPlacement, index: number, businessCode: string): string {
  const name = candidate.logos.find((entry) => entry.id === placement.logoId)?.name;
  return name ?? (businessCode !== '' ? businessCode : `Logo ${index + 1}`);
}

function anchorsForPlacement(placement: ExportPlacement): AnchorDef[] {
  return authorAnchors.filter((anchor) =>
    anchor.productId === placement.productId &&
    anchor.variantId === placement.variantId &&
    anchor.regionId === placement.regionId,
  );
}

function describeLogoMeasurement(
  candidate: ResultCandidate,
  placement: ExportPlacement,
  placements: readonly ExportPlacement[],
  measurement: DimensionMeasurement,
): { text: string; ok: boolean; primary: string | null } {
  if (measurement.anchorId === '') return { text: 'No anchor chosen — pick one from the Anchor list above.', ok: false, primary: null };
  const anchor = authorAnchors.find((entry) => entry.id === measurement.anchorId);
  if (!anchor) return { text: 'The chosen anchor is gone — pick another from the Anchor list above or set one up below.', ok: false, primary: null };
  const logoRef = logoRefForPlacement(placement, placements);
  const measured = measurePlacement(candidate, placement, authorAnchors, [{
    logoRef,
    anchorId: measurement.anchorId,
    edge: measurement.edge,
    convention: measurement.convention,
    label: bindingLabelFor(anchor.name, measurement.edge, measurement.convention),
  }]);
  const first = measured.dimensions[0];
  if (first) {
    const value = `${(Math.round(first.valueMm * 10) / 10).toFixed(1)}`;
    const honesty = first.touchesArtwork
      ? 'The dimension line touches the artwork.'
      : 'The dimension line starts off-artwork: the photo draws a dashed extension linking the artwork corner.';
    const primary =
      `${value} mm · ${anchor.name} → ${edgeWord(measurement.edge)} edge · ${conventionWord(measurement.convention)}${first.touchesArtwork ? '' : ' · extended'}`;
    return { text: `${value} mm — ${first.label}; from ${first.fromAnchor} to ${first.toEdge}. ${honesty}`, ok: true, primary };
  }
  return { text: `${measured.unfinished[0] ?? 'No measurement — setup needed.'}`, ok: false, primary: null };
}

/* ---------------- Visual dimension picker (Tranche B) ---------------- */
/* Pointer-first measurement authoring on a region-frame schematic: the    */
/* operator clicks a named anchor dot, then a logo edge, confirms the      */
/* convention explicitly, and commits. Click coordinates only select       */
/* identities (which anchor, which edge); every value comes from the pure  */
/* visual-dimension kernel wrapping the exact core edge-to-anchor          */
/* arithmetic — the same numbers the sheet prints and the operator JSON   */
/* exports. The manual lists in each row stay as the keyboard fallback    */
/* under Advanced. A partial pick lives in the panel DOM only and is    */
/* never written into authoring state, drafts, or exports before Commit.   */

const VISUAL_PICK_ANCHOR_SNAP_MM = 6;
const VISUAL_PICK_EDGE_SNAP_MM = 10;
const VISUAL_PICK_SVG_NS = 'http://www.w3.org/2000/svg';
const visualPickTeardowns = new Set<() => void>();

function visualPickSvgPoint(svg: SVGSVGElement, event: MouseEvent): { x: number; y: number } | null {
  // Raw viewBox coordinates (letterbox-corrected); the surface maps them to
  // millimetres, so this stays exact at any rendered size.
  const rect = svg.getBoundingClientRect();
  const box = svg.viewBox.baseVal;
  if (!(rect.width > 0) || !(rect.height > 0) || !(box.width > 0) || !(box.height > 0)) return null;
  const scale = Math.min(rect.width / box.width, rect.height / box.height);
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const offX = rect.left + (rect.width - box.width * scale) / 2;
  const offY = rect.top + (rect.height - box.height * scale) / 2;
  const x = box.x + (event.clientX - offX) / scale;
  const y = box.y + (event.clientY - offY) / scale;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Marker sizes in constant rendered CSS pixels: usability must not depend
 *  on photo resolution or stage size, so viewBox units derive per render. */
const VISUAL_PICK_CSS = {
  anchorR: 7,
  anchorHitR: 12,
  codeFont: 12,
  anchorStroke: 1.5,
  anchorSelectedStroke: 3,
  sideR: 4,
  sideHitR: 12,
  footprintStroke: 2,
  arrowStroke: 2.5,
  safeStroke: 1.5,
} as const;

/** CSS pixels per viewBox unit under meet letterboxing, or null pre-layout. */
function visualPickCssScale(svg: SVGSVGElement): number | null {
  const rect = svg.getBoundingClientRect();
  const box = svg.viewBox.baseVal;
  if (!(rect.width > 0) || !(rect.height > 0) || !(box.width > 0) || !(box.height > 0)) return null;
  const scale = Math.min(rect.width / box.width, rect.height / box.height);
  return scale > 0 && Number.isFinite(scale) ? scale : null;
}

function visualPickFrame(points: Array<{ x: number; y: number }>): { minX: number; minY: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return null;
  if (!(maxX > minX) || !(maxY > minY)) {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return { minX: cx - 10, minY: cy - 10, w: 20, h: 20 };
  }
  const pad = Math.max(5, Math.max(maxX - minX, maxY - minY) * 0.1);
  return { minX: minX - pad, minY: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

interface VisualPickPanelContext {
  candidate: ResultCandidate;
  configId: string;
  placement: ExportPlacement;
  scoped: AnchorDef[];
  safeArea: Array<readonly [number, number]> | null;
  regionName: string;
  measurement: DimensionMeasurement;
  logoRef: string;
  logoIndex: number;
  measureIndex: number;
  blocked: boolean;
}

/** Evaluated photo surface for visual picking: the actual product photo with
 *  the actual artwork composite, both positioned by the exact evaluated
 *  mapping math. Null when no evaluated mapping (with bytes) binds the
 *  placement's region — the caller then falls back to the labelled mm
 *  schematic and never fabricates a photo scale. */
interface VisualPickPhoto {
  sideLabel: string;
  /** Product photo as a data URI for the schematic image element. */
  photoHref: string;
  artHref: string | null;
  artMatrix: { a: number; b: number; c: number; d: number; e: number; f: number };
  photoW: number;
  photoH: number;
  toPx: (xMm: number, yMm: number) => { x: number; y: number };
  toMm: (px: number, py: number) => { xMm: number; yMm: number } | null;
  artCornersPx: Array<{ x: number; y: number }>;
}

/** Raster bytes to a data URI (session-local schematic use only). */
function visualPickPhotoHref(bytes: Uint8Array, mediaType: string): string | null {
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return null;
  const step = 8192;
  let binary = '';
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step));
  }
  try {
    return `data:${mediaType};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

function resolveVisualPickPhoto(
  candidate: ResultCandidate,
  configId: string,
  placement: ExportPlacement,
): VisualPickPhoto | null {
  if (lastReturnAssets === null) return null;
  const states = evaluateOperationPhotoStates(candidate, lastReturnAssets)[configId] ?? [];
  const options = states
    .filter((entry) => entry.regionId === placement.regionId && entry.transform !== undefined && entry.imagePath !== undefined)
    .sort((a, b) => (a.view ?? '') < (b.view ?? '') ? -1 : (a.view ?? '') > (b.view ?? '') ? 1 : 0);
  const picked = options[0];
  const transform = picked?.transform;
  const imagePath = picked?.imagePath;
  if (!transform || !imagePath) return null;
  const bytes = lastReturnAssets.get(imagePath);
  if (!bytes) return null;
  const header = readRasterHeader(bytes);
  if (!header) return null;
  const matrix = artworkPhotoMatrix(transform, header.width, header.height, {
    xMm: placement.pos.xMm,
    yMm: placement.pos.yMm,
    widthMm: placement.widthMm,
    heightMm: placement.heightMm,
    rotationDeg: placement.rotationDeg,
  });
  if (!matrix) return null;
  const photoHref = visualPickPhotoHref(bytes, header.mediaType);
  if (photoHref === null) return null;
  const artworkPath = sheetArtworkUri(placement.artwork.assets);
  const artworkBytes = artworkPath ? lastReturnAssets.get(artworkPath) : undefined;
  const artworkHeader = artworkBytes ? readRasterHeader(artworkBytes) : null;
  const artHref = artworkBytes && artworkHeader
    ? visualPickPhotoHref(artworkBytes, artworkHeader.mediaType)
    : null;
  const det = transform.a * transform.e - transform.b * transform.d;
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12) return null;
  const view = picked.view ?? '';
  const sideLabel = view === 'front' || view === 'back' || view === 'left' || view === 'right'
    ? workspaceSideLabel(view)
    : 'Mapped';
  return {
    sideLabel,
    photoHref,
    artHref,
    artMatrix: { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f },
    photoW: header.width,
    photoH: header.height,
    toPx: (xMm, yMm) => ({
      x: (transform.a * xMm + transform.b * yMm + transform.c) * header.width,
      y: (transform.d * xMm + transform.e * yMm + transform.f) * header.height,
    }),
    toMm: (px, py) => {
      const du = px / header.width - transform.c;
      const dv = py / header.height - transform.f;
      const xMm = (transform.e * du - transform.b * dv) / det;
      const yMm = (-transform.d * du + transform.a * dv) / det;
      if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) return null;
      return { xMm, yMm };
    },
    artCornersPx: ( [[0, 0], [1, 0], [1, 1], [0, 1]] as Array<[number, number]>).map(([s, t]) => ({
      x: matrix.a * s + matrix.c * t + matrix.e,
      y: matrix.b * s + matrix.d * t + matrix.f,
    })),
  };
}

function openVisualPickPanel(rowBox: HTMLElement, pickButton: HTMLButtonElement, context: VisualPickPanelContext): void {
  const { candidate, configId, placement, scoped, safeArea, regionName, measurement, logoRef, logoIndex, measureIndex, blocked } = context;
  const panel = document.createElement('div');
  panel.className = 'visual-pick';
  panel.setAttribute('data-visual-pick', '');
  panel.setAttribute('data-logo-ref', logoRef);
  panel.setAttribute('data-measure-index', String(measureIndex));
  const intro = document.createElement('p');
  intro.className = 'muted';
  panel.append(intro);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('data-visual-pick-status', '');
  interface SurfacePoint { x: number; y: number }
  // Drawing surface: the evaluated product photo with the real artwork
  // overlay when mapped, else an explicitly labelled mm schematic. Clicks
  // always resolve back to region millimetres before the kernel sees them.
  const photo = resolveVisualPickPhoto(candidate, configId, placement);
  let viewBox: string;
  let schematic: boolean;
  let anchorXY: (anchor: AnchorDef) => SurfacePoint;
  let footprintXY: SurfacePoint[];
  let mmXY: (xMm: number, yMm: number) => SurfacePoint;
  let xyToMm: (x: number, y: number) => { xMm: number; yMm: number } | null;
  let unit: number;
  if (photo !== null) {
    schematic = false;
    viewBox = `0 0 ${photo.photoW} ${photo.photoH}`;
    anchorXY = (anchor) => photo.toPx(anchor.posMm[0], anchor.posMm[1]);
    footprintXY = photo.artCornersPx;
    mmXY = (xMm, yMm) => photo.toPx(xMm, yMm);
    xyToMm = (x, y) => photo.toMm(x, y);
    unit = Math.max(photo.photoW, photo.photoH) / 250;
    intro.textContent =
      `Pick on the ${photo.sideLabel} photo: click a named anchor, then a logo edge, choose Direction, then Save measurement. ` +
      'Keyboard: use Advanced in this row. Escape cancels without changing the row.';
  } else {
    schematic = true;
    const corners = rotatedFootprintCorners(
      placement.pos.xMm, placement.pos.yMm, placement.widthMm, placement.heightMm, placement.rotationDeg,
    );
    const framePoints: Array<{ x: number; y: number }> = [];
    for (const point of safeArea ?? []) framePoints.push({ x: point[0], y: point[1] });
    for (const corner of corners) framePoints.push({ x: corner.x, y: corner.y });
    for (const anchor of scoped) framePoints.push({ x: anchor.posMm[0], y: anchor.posMm[1] });
    const frame = visualPickFrame(framePoints);
    if (frame === null || corners.length < 3) {
      status.textContent = 'The visual pick cannot be drawn: the region or logo geometry is missing or non-finite. Use Advanced in this row instead.';
      panel.append(status);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'btn-secondary';
      close.textContent = 'Close';
      close.addEventListener('click', () => { panel.remove(); pickButton.disabled = false; pickButton.focus(); });
      panel.append(close);
      rowBox.append(panel);
      return;
    }
    viewBox = `${frame.minX} ${-frame.minY - frame.h} ${frame.w} ${frame.h}`;
    anchorXY = (anchor) => ({ x: anchor.posMm[0], y: -anchor.posMm[1] });
    footprintXY = corners.map((corner) => ({ x: corner.x, y: -corner.y }));
    mmXY = (xMm, yMm) => ({ x: xMm, y: -yMm });
    xyToMm = (x, y) => ({ xMm: x, yMm: -y });
    unit = Math.max(frame.w, frame.h) / 80;
    intro.textContent =
      `No mapped photo for ${regionName} — region schematic (millimetre positions, not a photograph): ` +
      'click a named anchor dot, then a logo edge, choose Direction, then Save measurement. ' +
      'Keyboard: use Advanced in this row. Escape cancels without changing the row.';
  }
  const svg = document.createElementNS(VISUAL_PICK_SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('role', 'img');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('data-visual-pick-diagram', '');
  svg.setAttribute('aria-label', schematic
    ? `Region schematic, no photo mapped, for logo ${logoIndex + 1}: click an anchor dot, then a logo edge.`
    : `Mapped product photo for logo ${logoIndex + 1}: click an anchor, then a logo edge.`);
  if (photo !== null) {
    const image = document.createElementNS(VISUAL_PICK_SVG_NS, 'image');
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', String(photo.photoW));
    image.setAttribute('height', String(photo.photoH));
    image.setAttribute('href', photo.photoHref);
    image.setAttribute('data-visual-photo', '');
    svg.append(image);
    if (photo.artHref !== null) {
      const art = document.createElementNS(VISUAL_PICK_SVG_NS, 'image');
      art.setAttribute('x', '0');
      art.setAttribute('y', '0');
      art.setAttribute('width', '1');
      art.setAttribute('height', '1');
      art.setAttribute('href', photo.artHref);
      art.setAttribute('transform', `matrix(${photo.artMatrix.a} ${photo.artMatrix.b} ${photo.artMatrix.c} ${photo.artMatrix.d} ${photo.artMatrix.e} ${photo.artMatrix.f})`);
      art.setAttribute('data-visual-artwork', '');
      svg.append(art);
    }
  } else if (safeArea !== null && safeArea.length >= 3) {
    const polygon = document.createElementNS(VISUAL_PICK_SVG_NS, 'polygon');
    polygon.setAttribute('points', safeArea.map((point) => `${point[0]},${-point[1]}`).join(' '));
    polygon.setAttribute('fill', '#f2f5f7');
    polygon.setAttribute('stroke', '#607080');
    polygon.setAttribute('stroke-width', String(unit));
    svg.append(polygon);
  }
  const footprint = document.createElementNS(VISUAL_PICK_SVG_NS, 'polygon');
  footprint.setAttribute('points', footprintXY.map((point) => `${point.x},${point.y}`).join(' '));
  footprint.setAttribute('fill', photo !== null ? 'none' : '#fdecec');
  footprint.setAttribute('stroke', '#c0392b');
  footprint.setAttribute('stroke-width', '2');
  footprint.setAttribute('data-visual-footprint', '');
  footprint.setAttribute('pointer-events', 'none');
  svg.append(footprint);
  // Comfortable edge targets with exact physical identity: each side-midpoint
  // hit circle feeds its own position to the same probe, so the kernel (not
  // the pixels) still resolves which named edge a click selected.
  interface SideMark { hit: SVGElement; dot: SVGElement; mx: number; my: number }
  const sideMarks: SideMark[] = [];
  for (let side = 0; side < footprintXY.length; side += 1) {
    const start = footprintXY[side]!;
    const end = footprintXY[(side + 1) % footprintXY.length]!;
    const mx = (start.x + end.x) / 2;
    const my = (start.y + end.y) / 2;
    const hit = document.createElementNS(VISUAL_PICK_SVG_NS, 'circle');
    hit.setAttribute('cx', String(mx));
    hit.setAttribute('cy', String(my));
    hit.setAttribute('fill', '#000');
    hit.setAttribute('fill-opacity', '0');
    hit.setAttribute('pointer-events', 'all');
    hit.setAttribute('data-visual-edge-hit', String(side));
    const dot = document.createElementNS(VISUAL_PICK_SVG_NS, 'circle');
    dot.setAttribute('cx', String(mx));
    dot.setAttribute('cy', String(my));
    dot.setAttribute('fill', '#c0392b');
    dot.setAttribute('pointer-events', 'none');
    svg.append(hit, dot);
    sideMarks.push({ hit, dot, mx, my });
  }
  const anchorCode = (index: number): string =>
    String.fromCharCode(65 + (index % 26)) + (index >= 26 ? String(Math.floor(index / 26) + 1) : '');
  interface AnchorMark { id: string; hit: SVGElement; dot: SVGElement }
  const anchorMarks: AnchorMark[] = [];
  const anchorById = new Map<string, AnchorDef>();
  // A marker click selects its validated anchor ID directly: the visible
  // target never fails the millimetre snap gate. Blank-surface clicks below
  // stay strictly gated.
  const selectAnchor = (id: string): void => {
    const picked = anchorById.get(id);
    if (!picked) return;
    anchorId = id;
    layoutPickMarkers();
    status.textContent = `Anchor “${picked.name}” selected — now click near a logo edge (within ${VISUAL_PICK_EDGE_SNAP_MM} mm).`;
    svg.focus();
  };
  scoped.forEach((anchor, index) => {
    anchorById.set(anchor.id, anchor);
    const at = anchorXY(anchor);
    const hit = document.createElementNS(VISUAL_PICK_SVG_NS, 'circle');
    hit.setAttribute('cx', String(at.x));
    hit.setAttribute('cy', String(at.y));
    hit.setAttribute('fill', '#000');
    hit.setAttribute('fill-opacity', '0');
    hit.setAttribute('pointer-events', 'all');
    hit.setAttribute('data-visual-anchor-hit', anchor.id);
    hit.addEventListener('click', (event) => {
      event.stopPropagation();
      if (blocked) return;
      selectAnchor(anchor.id);
    });
    const dot = document.createElementNS(VISUAL_PICK_SVG_NS, 'circle');
    dot.setAttribute('cx', String(at.x));
    dot.setAttribute('cy', String(at.y));
    dot.setAttribute('fill', '#fff');
    dot.setAttribute('stroke', '#111');
    dot.setAttribute('data-visual-anchor', anchor.id);
    dot.setAttribute('pointer-events', 'none');
    const code = document.createElementNS(VISUAL_PICK_SVG_NS, 'text');
    code.setAttribute('x', String(at.x));
    code.setAttribute('y', String(at.y));
    code.setAttribute('text-anchor', 'middle');
    code.setAttribute('dominant-baseline', 'central');
    code.setAttribute('font-weight', '700');
    code.setAttribute('fill', '#111');
    code.setAttribute('pointer-events', 'none');
    code.setAttribute('data-visual-anchor-code', anchor.id);
    code.textContent = anchorCode(index);
    const tip = document.createElementNS(VISUAL_PICK_SVG_NS, 'title');
    tip.textContent = anchor.name;
    dot.append(tip);
    svg.append(hit, dot, code);
    anchorMarks.push({ id: anchor.id, hit, dot });
  });
  for (const mark of sideMarks) {
    mark.hit.addEventListener('click', (event) => {
      event.stopPropagation();
      if (blocked) return;
      edgeClickAt(mark.mx, mark.my);
    });
  }
  let arrowEl: SVGElement | null = null;
  /** Constant-CSS-pixel marker sizing; re-runs on every resize. */
  function layoutPickMarkers(): void {
    const scale = visualPickCssScale(svg);
    if (scale === null) return;
    const units = (cssPx: number): number => cssPx / scale;
    footprint.setAttribute('stroke-width', String(units(VISUAL_PICK_CSS.footprintStroke)));
    for (const mark of sideMarks) {
      mark.hit.setAttribute('r', String(units(VISUAL_PICK_CSS.sideHitR)));
      mark.dot.setAttribute('r', String(units(VISUAL_PICK_CSS.sideR)));
    }
    for (const mark of anchorMarks) {
      const selected = mark.id === anchorId;
      mark.hit.setAttribute('r', String(units(VISUAL_PICK_CSS.anchorHitR)));
      mark.dot.setAttribute('r', String(units(VISUAL_PICK_CSS.anchorR)));
      mark.dot.setAttribute('stroke', selected ? '#c0392b' : '#111');
      mark.dot.setAttribute('stroke-width', String(units(selected ? VISUAL_PICK_CSS.anchorSelectedStroke : VISUAL_PICK_CSS.anchorStroke)));
    }
    for (const code of svg.querySelectorAll('[data-visual-anchor-code]')) {
      code.setAttribute('font-size', String(units(VISUAL_PICK_CSS.codeFont)));
    }
    if (arrowEl !== null) arrowEl.setAttribute('stroke-width', String(units(VISUAL_PICK_CSS.arrowStroke)));
  }
  const pickResize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layoutPickMarkers()) : null;
  pickResize?.observe(svg);
  function disconnectPickResize(): void {
    visualPickTeardowns.delete(disconnectPickResize);
    try {
      pickResize?.disconnect();
    } catch {
      /* best-effort teardown */
    }
  }
  visualPickTeardowns.add(disconnectPickResize);
  panel.append(svg);
  const key = document.createElement('p');
  key.className = 'muted';
  key.setAttribute('data-visual-pick-legend', '');
  key.textContent = scoped.map((anchor, index) => `${anchorCode(index)} · ${anchor.name}`).join('      ');
  panel.append(key);
  panel.append(status);
  const conventionField = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = 'Direction';
  conventionField.append(legend);
  const radioName = `visual-pick-convention-${logoRef}-${measureIndex}`;
  const radios = new Map<MeasurementConvention, HTMLInputElement>();
  for (const [value, label] of [['dx', 'Horizontal'], ['dy', 'Vertical'], ['shortest-to-edge', 'Shortest']] as const) {
    const wrap = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = radioName;
    radio.disabled = blocked;
    radio.setAttribute('data-visual-pick-convention', value);
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(radio, text);
    conventionField.append(wrap);
    radios.set(value, radio);
    radio.addEventListener('change', () => resolve());
  }
  panel.append(conventionField);
  const tech = document.createElement('details');
  tech.className = 'disclosure';
  const techTitle = document.createElement('summary');
  techTitle.textContent = 'Details';
  const techBody = document.createElement('p');
  techBody.className = 'muted';
  techBody.textContent = 'No proposal yet.';
  tech.append(techTitle, techBody);
  panel.append(tech);
  const actions = document.createElement('div');
  actions.className = 'actions';
  const commit = document.createElement('button');
  commit.type = 'button';
  commit.className = 'btn-primary';
  commit.textContent = 'Save measurement';
  commit.setAttribute('aria-label', `Save diagram measurement for logo ${logoIndex + 1}`);
  commit.setAttribute('data-visual-pick-commit', '');
  commit.disabled = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-secondary';
  cancel.textContent = 'Cancel';
  cancel.setAttribute('data-visual-pick-cancel', '');
  actions.append(commit, cancel);
  panel.append(actions);

  let anchorId: string | null = null;
  let edgeClickMm: { xMm: number; yMm: number } | null = null;
  let lastOk: { anchorId: string; edge: ArtworkEdge; convention: MeasurementConvention; valueMm: number; edgeDistanceMm: number } | null = null;

  function checkedConvention(): MeasurementConvention | null {
    for (const [value, radio] of radios) {
      if (radio.checked) return value;
    }
    return null;
  }

  function clearArrow(): void {
    svg.querySelector('[data-visual-pick-arrow]')?.remove();
    arrowEl = null;
  }

  function resolve(): void {
    clearArrow();
    lastOk = null;
    commit.disabled = true;
    const convention = checkedConvention();
    if (anchorId === null || edgeClickMm === null || convention === null) return;
    const anchor = anchorById.get(anchorId);
    if (!anchor) {
      status.textContent = 'The chosen anchor is gone — click another anchor marker.';
      return;
    }
    const result = resolveVisualDimension({
      anchors: scoped.map((entry) => ({ id: entry.id, posMm: [entry.posMm[0], entry.posMm[1]] as [number, number] })),
      footprint: {
        centerMm: [placement.pos.xMm, placement.pos.yMm],
        widthMm: placement.widthMm,
        heightMm: placement.heightMm,
        rotationDeg: placement.rotationDeg,
      },
      anchorClickMm: [anchor.posMm[0], anchor.posMm[1]],
      edgeClickMm: [edgeClickMm.xMm, edgeClickMm.yMm],
      convention,
      snapTolMm: VISUAL_PICK_ANCHOR_SNAP_MM,
      maxEdgeDistMm: VISUAL_PICK_EDGE_SNAP_MM,
    });
    if (!result.ok) {
      if (result.code === 'edge-too-far') {
        status.textContent = `${result.message} Click closer to a logo edge — a click on the blank garment never binds a far edge.`;
      } else if (result.code === 'incompatible-edge-or-convention') {
        status.textContent = `${result.message} Switch Direction above.`;
      } else {
        status.textContent = result.message;
      }
      return;
    }
    lastOk = {
      anchorId: result.binding.anchorId,
      edge: result.binding.edge,
      convention: result.binding.convention,
      valueMm: result.valueMm,
      edgeDistanceMm: result.edgeDistanceMm,
    };
    const from = mmXY(result.endpoints[0].x, result.endpoints[0].y);
    const to = mmXY(result.endpoints[1].x, result.endpoints[1].y);
    const line = document.createElementNS(VISUAL_PICK_SVG_NS, 'line');
    line.setAttribute('x1', String(from.x));
    line.setAttribute('y1', String(from.y));
    line.setAttribute('x2', String(to.x));
    line.setAttribute('y2', String(to.y));
    line.setAttribute('stroke', '#111');
    line.setAttribute('data-visual-pick-arrow', '');
    svg.append(line);
    arrowEl = line;
    layoutPickMarkers();
    const value = `${(Math.round(result.valueMm * 10) / 10).toFixed(1)}`;
    let note =
      `Proposed: ${value} mm · ${anchor.name} → ${edgeWord(result.binding.edge)} edge · ${conventionWord(convention)}. ` +
      'Review and Save measurement to write this row.';
    if (placement.rotationDeg !== 0 && convention !== 'shortest-to-edge') {
      note += ' Rotated artwork: measured as horizontal/vertical extent (supporting line), not along the rotated edge.';
    }
    status.textContent = note;
    techBody.textContent =
      `Clicked ${result.edgeDistanceMm.toFixed(1)} mm from the edge (gate ${VISUAL_PICK_EDGE_SNAP_MM} mm, ` +
      `anchor snap ${VISUAL_PICK_ANCHOR_SNAP_MM} mm); exact kernel value ${result.valueMm} mm.`;
    commit.disabled = blocked;
  }

  svg.addEventListener('click', (event) => {
    if (blocked) return;
    const raw = visualPickSvgPoint(svg, event);
    if (!raw) return;
    if (anchorId === null) {
      const point = xyToMm(raw.x, raw.y);
      if (!point) return;
      let best: AnchorDef | null = null;
      let bestDist = Infinity;
      for (const anchor of scoped) {
        const dist = Math.hypot(anchor.posMm[0] - point.xMm, anchor.posMm[1] - point.yMm);
        if (dist < bestDist) {
          bestDist = dist;
          best = anchor;
        }
      }
      if (best === null || !(bestDist <= VISUAL_PICK_ANCHOR_SNAP_MM)) {
        status.textContent =
          `No named anchor within ${VISUAL_PICK_ANCHOR_SNAP_MM} mm of that click — click an anchor marker. ` +
          'Advanced in this row stays available for keyboard entry.';
        return;
      }
      selectAnchor(best.id);
      return;
    }
    edgeClickAt(raw.x, raw.y);
  });

  /** Edge click at viewBox coordinates (side targets and blank surface
   *  share this path, so the probe gates both identically). */
  function edgeClickAt(vx: number, vy: number): void {
    if (anchorId === null) return;
    const point = xyToMm(vx, vy);
    if (!point) return;
    // Every new edge click retires the previous proposal FIRST: a refused
    // click must never leave a stale arrow and an enabled action behind.
    clearArrow();
    lastOk = null;
    commit.disabled = true;
    edgeClickMm = point;
    // Identify the clicked edge with the convention-neutral probe first, so
    // the preselected convention follows the actual edge instead of assuming
    // an axis. The operator still confirms or changes it before Commit.
    const pickedAnchor = anchorById.get(anchorId);
    if (!pickedAnchor) {
      status.textContent = 'The chosen anchor is gone — click another anchor marker.';
      anchorId = null;
      layoutPickMarkers();
      return;
    }
    const probe = resolveVisualDimension({
      anchors: scoped.map((entry) => ({ id: entry.id, posMm: [entry.posMm[0], entry.posMm[1]] as [number, number] })),
      footprint: {
        centerMm: [placement.pos.xMm, placement.pos.yMm],
        widthMm: placement.widthMm,
        heightMm: placement.heightMm,
        rotationDeg: placement.rotationDeg,
      },
      anchorClickMm: [pickedAnchor.posMm[0], pickedAnchor.posMm[1]],
      edgeClickMm: [point.xMm, point.yMm],
      convention: 'shortest-to-edge',
      snapTolMm: VISUAL_PICK_ANCHOR_SNAP_MM,
      maxEdgeDistMm: VISUAL_PICK_EDGE_SNAP_MM,
    });
    if (!probe.ok) {
      if (probe.code === 'edge-too-far') {
        status.textContent = `${probe.message} Click closer to a logo edge — a click on the blank garment never binds a far edge.`;
      } else {
        status.textContent = probe.message;
      }
      return;
    }
    if (checkedConvention() === null) {
      const auto = probe.binding.edge === 'minX' || probe.binding.edge === 'maxX' ? 'dx' : 'dy';
      radios.get(auto)!.checked = true;
    }
    resolve();
  }

  commit.addEventListener('click', () => {
    const convention = checkedConvention();
    if (blocked || anchorId === null || lastOk === null || convention === null || lastOk.convention !== convention) return;
    measurement.anchorId = lastOk.anchorId;
    measurement.edge = lastOk.edge;
    measurement.convention = lastOk.convention;
    disconnectPickResize();
    renderLogoRows();
    renderSheetPreview();
  });

  function close(): void {
    disconnectPickResize();
    panel.remove();
    pickButton.disabled = false;
    pickButton.focus();
  }
  cancel.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });

  status.textContent = `Click an anchor marker (${scoped.length} named anchor${scoped.length === 1 ? '' : 's'} on ${regionName}).`;
  rowBox.append(panel);
  layoutPickMarkers();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (svg.isConnected) layoutPickMarkers();
    });
  }
  svg.focus();
  svg.scrollIntoView({ block: 'nearest' });
}

function renderLogoRows(): void {
  // Any rebuild discards open visual-pick panels with it: a partial pick is
  // DOM-local only and never reaches authoring state, so config changes,
  // return reloads, draft opens, anchor edits and add/remove all cancel an
  // uncommitted pick instead of rebinding it elsewhere.
  for (const teardown of visualPickTeardowns) teardown();
  sheetLogos.replaceChildren();
  const current = activeReturn();
  const config = activeCandidateConfig();
  if (!current || !config) return;
  const authoring = sheetAuthoring.get(config.id);
  if (!authoring) return;
  if (config.placements.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No logos configured on this sheet — 0 logos, nothing to place, measure, or produce.';
    sheetLogos.append(empty);
    return;
  }
  const blocked = authoringBlocked();
  config.placements.forEach((placement, index) => {
    const logoRef = logoRefForPlacement(placement, config.placements);
    let row = authoring.logos.get(logoRef);
    if (!row) {
      row = defaultLogoAuthoring();
      authoring.logos.set(logoRef, row);
    }
    const card = document.createElement('section');
    card.className = 'sheet-logo-card';
    const heading = document.createElement('h4');
    heading.textContent = `${index + 1}. ${displayNameForLogo(current.candidate, placement, index, row.businessCode.trim())}`;
    card.append(heading);
    const region = current.candidate.products
      .find((entry) => entry.id === placement.productId)?.regions
      .find((entry) => entry.id === placement.regionId);
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent =
      `Artwork ${displayMm(placement.widthMm)} × ${displayMm(placement.heightMm)} mm` +
      (placement.rotationDeg !== 0 ? `, rotated ${displayMm(placement.rotationDeg)}°` : '') +
      ` · area “${region?.name ?? placement.regionId}” · method ${placement.method}`;
    card.append(meta);
    const codeLabel = document.createElement('label');
    codeLabel.className = 'field';
    codeLabel.textContent = 'Business code';
    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.value = row.businessCode;
    codeInput.maxLength = 80;
    codeInput.placeholder = 'e.g. EMB-7';
    codeInput.disabled = blocked;
    codeInput.setAttribute('aria-label', `Business code for logo ${index + 1}`);
    codeInput.addEventListener('input', () => {
      row!.businessCode = codeInput.value;
      heading.textContent = `${index + 1}. ${displayNameForLogo(current.candidate, placement, index, codeInput.value.trim())}`;
      renderSheetPreview();
    });
    codeLabel.append(codeInput);
    card.append(codeLabel);
    const scoped = anchorsForPlacement(placement);
    const list = document.createElement('div');
    list.setAttribute('data-measurement-list', '');
    list.setAttribute('aria-label', `Measurements for logo ${index + 1}`);
    const EDGE_OPTIONS = [['minX', 'left'], ['maxX', 'right'], ['minY', 'bottom'], ['maxY', 'top']] as const;
    const CONVENTION_OPTIONS = [['dx', 'Horizontal'], ['dy', 'Vertical'], ['shortest-to-edge', 'Shortest']] as const;
    row.measurements.forEach((measurement, measureIndex) => {
      const rowBox = document.createElement('div');
      rowBox.className = 'sheet-measurement-row';
      rowBox.setAttribute('data-measurement-row', String(measureIndex));
      const title = document.createElement('p');
      title.className = 'muted';
      title.textContent = `Measurement ${measureIndex + 1}`;
      rowBox.append(title);
      const grid = document.createElement('div');
      grid.className = 'sheet-logo-grid';
      const anchorLabel = document.createElement('label');
      anchorLabel.textContent = 'Anchor';
      const anchorSelect = document.createElement('select');
      anchorSelect.disabled = blocked;
      anchorSelect.setAttribute('aria-label', `Measurement ${measureIndex + 1} anchor for logo ${index + 1}`);
      const none = document.createElement('option');
      none.value = '';
      none.textContent = scoped.length === 0 ? 'No anchors — setup needed' : 'Choose an anchor';
      anchorSelect.append(none);
      for (const anchor of scoped) {
        const option = document.createElement('option');
        option.value = anchor.id;
        option.textContent = anchor.name;
        anchorSelect.append(option);
      }
      anchorSelect.value = measurement.anchorId;
      if (measurement.anchorId !== '' && !scoped.some((entry) => entry.id === measurement.anchorId)) {
        const stale = document.createElement('option');
        stale.value = measurement.anchorId;
        stale.textContent = '(previously chosen anchor is gone — pick another)';
        anchorSelect.append(stale);
        anchorSelect.value = measurement.anchorId;
      }
      anchorSelect.addEventListener('change', () => {
        measurement.anchorId = anchorSelect.value;
        paintMeasurementResult();
        renderSheetPreview();
      });
      anchorLabel.append(anchorSelect);
      const edgeLabel = document.createElement('label');
      edgeLabel.textContent = 'Artwork edge';
      const edgeSelect = document.createElement('select');
      edgeSelect.disabled = blocked;
      edgeSelect.setAttribute('aria-label', `Measurement ${measureIndex + 1} edge for logo ${index + 1}`);
      for (const [value, label] of EDGE_OPTIONS) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        edgeSelect.append(option);
      }
      edgeSelect.value = measurement.edge;
      edgeSelect.addEventListener('change', () => {
        measurement.edge = edgeSelect.value as ArtworkEdge;
        paintMeasurementResult();
        renderSheetPreview();
      });
      edgeLabel.append(edgeSelect);
      const conventionLabel = document.createElement('label');
      conventionLabel.textContent = 'Direction';
      const conventionSelect = document.createElement('select');
      conventionSelect.disabled = blocked;
      conventionSelect.setAttribute('aria-label', `Measurement ${measureIndex + 1} direction for logo ${index + 1}`);
      for (const [value, label] of CONVENTION_OPTIONS) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        conventionSelect.append(option);
      }
      conventionSelect.value = measurement.convention;
      conventionSelect.addEventListener('change', () => {
        measurement.convention = conventionSelect.value as MeasurementConvention;
        paintMeasurementResult();
        renderSheetPreview();
      });
      conventionLabel.append(conventionSelect);
      grid.append(anchorLabel, edgeLabel, conventionLabel);
      // Manual lists stay as the keyboard fallback, one disclosure behind
      // the visual flow instead of three prominent dropdowns beside it.
      const advanced = document.createElement('details');
      advanced.className = 'disclosure';
      advanced.setAttribute('data-measurement-advanced', '');
      const advancedTitle = document.createElement('summary');
      advancedTitle.textContent = 'Advanced';
      advanced.append(advancedTitle, grid);
      rowBox.append(advanced);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary';
      remove.textContent = 'Remove measurement';
      remove.setAttribute('aria-label', `Remove measurement ${measureIndex + 1} for logo ${index + 1}`);
      remove.disabled = blocked || row.measurements.length <= 1;
      remove.addEventListener('click', () => {
        const at = row.measurements.indexOf(measurement);
        if (at >= 0 && row.measurements.length > 1) row.measurements.splice(at, 1);
        renderLogoRows();
        renderSheetPreview();
      });
      rowBox.append(remove);
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'btn-secondary';
      pick.textContent = 'Pick on diagram';
      pick.setAttribute('aria-label', `Pick on diagram for measurement ${measureIndex + 1} for logo ${index + 1}`);
      const pickRegion = current.candidate.products
        .find((entry) => entry.id === placement.productId)?.regions
        .find((entry) => entry.id === placement.regionId);
      if (blocked || scoped.length === 0 || !pickRegion) {
        pick.disabled = true;
        pick.title = scoped.length === 0
          ? 'No anchors on this area yet — set one up first'
          : 'Unavailable while authoring is locked or the area is missing';
      }
      pick.addEventListener('click', () => {
        if (pick.disabled) return;
        const liveRegion = current.candidate.products
          .find((entry) => entry.id === placement.productId)?.regions
          .find((entry) => entry.id === placement.regionId);
        if (!liveRegion) return;
        pick.disabled = true;
        openVisualPickPanel(rowBox, pick, {
          candidate: current.candidate,
          configId: config.id,
          placement,
          scoped: anchorsForPlacement(placement),
          safeArea: liveRegion.safeArea.map((point) => [point[0], point[1]] as const),
          regionName: liveRegion.name ?? placement.regionId,
          measurement,
          logoRef,
          logoIndex: index,
          measureIndex,
          blocked,
        });
      });
      rowBox.append(pick);
      const result = document.createElement('p');
      result.setAttribute('role', 'status');
      result.setAttribute('aria-label', `Measurement ${measureIndex + 1} result for logo ${index + 1}`);
      rowBox.append(result);
      const detailWrap = document.createElement('details');
      detailWrap.className = 'disclosure';
      const detailTitle = document.createElement('summary');
      detailTitle.textContent = 'Details';
      const detailBody = document.createElement('p');
      detailBody.className = 'muted';
      detailWrap.append(detailTitle, detailBody);
      rowBox.append(detailWrap);
      function paintMeasurementResult(): void {
        const described = describeLogoMeasurement(current!.candidate, placement, config!.placements, measurement);
        if (described.ok && described.primary !== null) {
          result.textContent = described.primary;
          result.className = 'sheet-logo-result';
          detailBody.textContent = described.text;
          detailWrap.hidden = false;
        } else {
          result.textContent = described.text;
          result.className = 'sheet-logo-unfinished';
          detailWrap.hidden = true;
        }
      }
      paintMeasurementResult();
      list.append(rowBox);
    });
    card.append(list);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn-secondary';
    add.textContent = 'Add another';
    add.setAttribute('aria-label', `Add measurement for logo ${index + 1}`);
    add.disabled = blocked;
    add.addEventListener('click', () => {
      row!.measurements.push({ anchorId: '', edge: 'minX', convention: 'dx' });
      renderLogoRows();
      renderSheetPreview();
    });
    card.append(add);
    sheetLogos.append(card);
  });
}

function renderCustomerNotes(): void {
  sheetCustomerNotes.replaceChildren();
  const current = activeReturn();
  const config = activeCandidateConfig();
  if (!current || !config) return;
  const title = document.createElement('p');
  title.textContent = 'Customer notes — source context, not operational instructions (read-only):';
  title.style.fontWeight = '650';
  sheetCustomerNotes.append(title);
  const source = current.imported.configurations.find((entry) => entry.id === config.id);
  const placementNotes = (source?.placements ?? []).flatMap((placement) =>
    placement.instructions !== undefined ? [placement.instructions] : [],
  );
  const lines = [...placementNotes];
  if (current.imported.instructions !== undefined) lines.push(current.imported.instructions);
  if (lines.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'No customer notes on this sheet.';
    sheetCustomerNotes.append(none);
    return;
  }
  for (const line of lines) {
    const row = document.createElement('p');
    row.textContent = line;
    sheetCustomerNotes.append(row);
  }
}

function syncJobInputs(): void {
  const authoring = activeSheetConfigId !== null ? sheetAuthoring.get(activeSheetConfigId) : undefined;
  if (!authoring) return;
  const active = document.activeElement;
  const set = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    if (input !== active) input.value = value;
  };
  set(sheetCustomer, authoring.customer);
  set(sheetReference, authoring.reference);
  set(sheetArticle, authoring.article);
  set(sheetInstructions, authoring.instructions);
  set(sheetTechTemperature, authoring.tech.temperature);
  set(sheetTechTime, authoring.tech.time);
  set(sheetTechPressure, authoring.tech.pressure);
  set(sheetTechColour, authoring.tech.colour);
  set(sheetTechThread, authoring.tech.thread);
}

function initSheetAuthoring(candidate: ResultCandidate): void {
  sheetAuthoring.clear();
  safeAreaProposals.clear();
  authorAnchors = [];
  for (const config of candidate.configurations) {
    const authoring = defaultSheetAuthoring();
    for (const placement of config.placements) {
      authoring.logos.set(logoRefForPlacement(placement, config.placements), defaultLogoAuthoring());
    }
    sheetAuthoring.set(config.id, authoring);
  }
  activeSheetConfigId = candidate.configurations[0]?.id ?? null;
  renderAuthoringPanel();
}

function renderAuthoringPanel(): void {
  const current = activeReturn();
  sheetConfig.replaceChildren();
  if (!current) return;
  for (const config of current.candidate.configurations) {
    const option = document.createElement('option');
    option.value = config.id;
    option.textContent = configDisplayName(config);
    sheetConfig.append(option);
  }
  if (activeSheetConfigId === null || !current.candidate.configurations.some((entry) => entry.id === activeSheetConfigId)) {
    activeSheetConfigId = current.candidate.configurations[0]?.id ?? null;
  }
  if (activeSheetConfigId !== null) sheetConfig.value = activeSheetConfigId;
  renderCustomerNotes();
  syncJobInputs();
  renderLogoRows();
  refreshAnchorSetup();
  renderSheetPreview();
  updateControls();
}

/* ---------------- Anchor + safe-area setup wiring ---------------- */

function anchorScopeKey(scope: { productId: string; variantId: string; regionId: string }): string {
  return `${scope.productId} ${scope.variantId} ${scope.regionId}`;
}

function setupInputForActive(): AnchorSetupInput | { error: string } {
  const current = activeReturn();
  const config = activeCandidateConfig();
  if (!current || !config || lastReturnAssets === null) return { error: 'Load a return first.' };
  const sides = lastReturnReferenceViews[config.id] ?? [];
  const side = sides[Number(anchorSide.value)];
  if (!side) return { error: 'Choose a photo side for the setup.' };
  const photoBytes = lastReturnAssets.get(side.imagePath);
  const header = photoBytes ? readRasterHeader(photoBytes) : null;
  if (!photoBytes || !header) {
    return { error: `Photo “${side.imagePath}” is missing or undecodable; anchors can still be entered numerically, but photo clicks need the mapped photo.` };
  }
  const states = evaluateOperationPhotoStates(current.candidate, lastReturnAssets);
  const bound = (states[config.id] ?? []).find((entry) => entry.imagePath === side.imagePath);
  if (!bound || bound.regionId === undefined || bound.view === undefined || bound.transform === undefined) {
    return { error: 'Setup needed: save a photo mapping for this side first (Choose items → Map artwork photos). Nothing is guessed from photo bounds.' };
  }
  if (bound.view !== 'front' && bound.view !== 'back' && bound.view !== 'left' && bound.view !== 'right') {
    return { error: `Setup needed: the saved mapping declares an unknown side (“${bound.view}”).` };
  }
  const product = current.candidate.products.find((entry) => entry.id === config.productId);
  const region = product?.regions.find((entry) => entry.id === anchorRegion.value);
  if (!product || !region) return { error: 'Choose a region for the setup.' };
  const key = anchorScopeKey({ productId: config.productId, variantId: config.variantId, regionId: region.id });
  const proposal = safeAreaProposals.get(key);
  const safeArea = region.safeArea
    .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => ({ x: point[0]!, y: point[1]! }));
  return {
    photo: { bytes: photoBytes, widthPx: header.width, heightPx: header.height, label: side.label ?? side.view ?? side.imagePath },
    transform: { ...bound.transform },
    mappingStatus: bound.status,
    view: bound.view,
    scope: {
      productId: config.productId,
      variantId: config.variantId,
      regionId: region.id,
      frameId: region.frame.frameId,
      calibrationId: region.calibrationRef.calibrationId,
      calibrationVersion: region.calibrationRef.version,
      regionName: region.name ?? null,
    },
    safeArea,
    anchors: authorAnchors.filter((entry) =>
      entry.productId === config.productId && entry.variantId === config.variantId && entry.regionId === region.id),
    stagedSafeArea: proposal ? [...proposal.staged] : null,
  };
}

function refreshAnchorSetup(): void {
  const current = activeReturn();
  const config = activeCandidateConfig();
  anchorSide.replaceChildren();
  anchorRegion.replaceChildren();
  anchorSetupBox.replaceChildren();
  if (anchorSetupHandle !== null) {
    anchorSetupHandle.destroy();
    anchorSetupHandle = null;
  }
  if (!current || !config) {
    anchorStatus.textContent = 'Load a return to set up anchors.';
    return;
  }
  const sides = lastReturnReferenceViews[config.id] ?? [];
  sides.forEach((side, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = side.label ?? side.view ?? side.imagePath;
    anchorSide.append(option);
  });
  const product = current.candidate.products.find((entry) => entry.id === config.productId);
  for (const region of product?.regions ?? []) {
    const option = document.createElement('option');
    option.value = region.id;
    option.textContent = region.name ?? region.id;
    anchorRegion.append(option);
  }
  anchorStatus.textContent = sides.length === 0
    ? 'No product photo supplied for this sheet — setup needed before anchors can be placed on a photo.'
    : '';
  anchorSetupHandle = createAnchorSetup(anchorSetupBox, () => setupInputForActive(), {
    onAnchorsChange: (next) => {
      const scope = next[0];
      const key = scope ? anchorScopeKey(scope) : null;
      if (key === null) return;
      authorAnchors = authorAnchors.filter((entry) => anchorScopeKey(entry) !== key).concat(next);
      renderLogoRows();
      renderSheetPreview();
    },
    onSafeAreaProposal: (staged, note) => {
      const configNow = activeCandidateConfig();
      const regionId = anchorRegion.value;
      if (!configNow) return;
      const key = anchorScopeKey({ productId: configNow.productId, variantId: configNow.variantId, regionId });
      if (staged === null || note === null) {
        safeAreaProposals.delete(key);
      } else {
        safeAreaProposals.set(key, { staged, note });
      }
    },
    onStatus: (message) => {
      anchorStatus.textContent = message;
    },
  });
  anchorSetupHandle.refresh();
}

/* ---------------- Operation-draft sidecar ---------------- */

const DRAFT_FILE_BYTES = 256 * 1024;

function buildDraftForActiveSheet(): { draft: OperationDraft; businessCodes: Record<string, string> } | { error: string } {
  const current = activeReturn();
  const config = activeCandidateConfig();
  if (!current || !config) return { error: 'Load a return before saving a draft.' };
  const authoring = sheetAuthoring.get(config.id);
  if (!authoring) return { error: 'No authoring state for this sheet.' };
  for (const anchor of authorAnchors) {
    if (typeof anchor.id !== 'string' || anchor.id.length === 0 ||
      typeof anchor.name !== 'string' || anchor.name.trim().length === 0) {
      return { error: `Draft not saved: an anchor has an empty id or name. Rename it in the setup below.` };
    }
    if (!Array.isArray(anchor.posMm) || !Number.isFinite(anchor.posMm[0]) || !Number.isFinite(anchor.posMm[1])) {
      return { error: `Draft not saved: anchor “${anchor.name}” has a non-finite position.` };
    }
  }
  const methodParams: Record<string, string> = {};
  if (authoring.tech.temperature.trim() !== '') methodParams['temperature'] = authoring.tech.temperature.trim();
  if (authoring.tech.time.trim() !== '') methodParams['time'] = authoring.tech.time.trim();
  if (authoring.tech.pressure.trim() !== '') methodParams['pressure'] = authoring.tech.pressure.trim();
  if (authoring.tech.thread.trim() !== '') methodParams['thread'] = authoring.tech.thread.trim();
  if (authoring.tech.colour.trim() !== '') methodParams['colour'] = authoring.tech.colour.trim();
  const job: OperationDraft['job'] = {};
  if (authoring.customer.trim() !== '') job.customer = authoring.customer.trim();
  if (authoring.reference.trim() !== '') job.reference = authoring.reference.trim();
  if (authoring.article.trim() !== '') job.article = authoring.article.trim();
  const businessCodes: Record<string, string> = Object.create(null);
  for (const [logoRef, row] of authoring.logos) {
    if (row.businessCode.trim() !== '') businessCodes[logoRef] = row.businessCode.trim();
  }
  const key = activeSheetConfigId !== null
    ? anchorScopeKey({ productId: config.productId, variantId: config.variantId, regionId: anchorRegion.value })
    : null;
  const proposal = key !== null ? safeAreaProposals.get(key) : undefined;
  const draft: OperationDraft = {
    version: OPERATION_DRAFT_VERSION,
    draftVersion: OPERATION_DRAFT_NUMBER,
    sourceRevision: current.imported.revision,
    sourceDigest: current.candidate.digest,
    job,
    operationalInstructions: authoring.instructions,
    anchors: authorAnchors.map((entry) => ({ ...entry, posMm: [entry.posMm[0]!, entry.posMm[1]!] as [number, number] })),
    dimensions: bindingsForConfig(config.id),
    ...(current.candidate.configurations.length === 1 ? {} : { configurationId: config.id }),
    ...(Object.keys(methodParams).length === 0 ? {} : { methodParams }),
    ...(proposal === undefined ? {} : { updatedNote: proposal.note }),
  };
  return { draft, businessCodes };
}

function draftFileName(draft: OperationDraft): string {
  const reference = draft.job.reference?.trim() ?? '';
  const base = reference !== '' ? safeJobPart(reference) : 'operation-sheet';
  return `${base}-r${draft.sourceRevision}-operation-draft.json`;
}

function saveOperationDraft(): void {
  if (authoringBlocked()) return;
  const current = activeReturn();
  if (!current) {
    draftStatus.textContent = 'Load a return before saving a draft.';
    return;
  }
  const built = buildDraftForActiveSheet();
  if ('error' in built) {
    draftStatus.textContent = built.error;
    return;
  }
  const record = built.draft as unknown as Record<string, unknown>;
  const file: Record<string, unknown> = { ...record };
  if (Object.keys(built.businessCodes).length > 0) file['_sheetUi'] = { businessCodes: built.businessCodes };
  downloadBytes(
    new TextEncoder().encode(JSON.stringify(file)),
    draftFileName(built.draft),
    'application/json',
  );
  draftStatus.textContent =
    `Saved operation draft for revision ${built.draft.sourceRevision}. ` +
    `Reopen it with “Reopen operation draft” — a changed return is refused as stale, never silently applied.`;
}

async function openOperationDraftFile(file: File): Promise<void> {
  const current = activeReturn();
  if (!current) {
    draftStatus.textContent = 'Load a return before reopening a draft.';
    return;
  }
  if (file.size > DRAFT_FILE_BYTES) {
    draftStatus.textContent = `Draft not opened: ${file.name} exceeds the 256 KiB draft bound; choose the saved operation draft JSON.`;
    return;
  }
  let raw: unknown;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    draftStatus.textContent = `Draft not opened: ${file.name} is not valid JSON. The current authoring is unchanged.`;
    return;
  }
  if (!isOperationDraft(raw)) {
    draftStatus.textContent = `Draft not opened: ${file.name} is not an operation-draft/1 sidecar. The current authoring is unchanged.`;
    return;
  }
  if (isStaleDraft(raw, current.candidate.digest, current.imported.revision)) {
    draftStatus.textContent =
      `Draft is stale (saved for revision ${raw.sourceRevision}; this return is revision ${current.imported.revision} ` +
      `with a different digest): review the return again before applying — nothing was changed.`;
    return;
  }
  const targetId = raw.configurationId
    ?? (current.candidate.configurations.length === 1 ? current.candidate.configurations[0]?.id : undefined);
  const target = current.candidate.configurations.find((entry) => entry.id === targetId);
  if (!target) {
    draftStatus.textContent =
      `Draft not opened: it targets a configuration (“${raw.configurationId ?? '(sole sheet)'}”) absent from this return. The current authoring is unchanged.`;
    return;
  }
  const validAnchors = raw.anchors.filter((entry): entry is AnchorDef =>
    typeof entry === 'object' && entry !== null &&
    typeof (entry as AnchorDef).id === 'string' && (entry as AnchorDef).id.length > 0 &&
    typeof (entry as AnchorDef).name === 'string' && (entry as AnchorDef).name.trim().length > 0 &&
    Array.isArray((entry as AnchorDef).posMm) &&
    Number.isFinite((entry as AnchorDef).posMm[0]) && Number.isFinite((entry as AnchorDef).posMm[1]));
  const droppedAnchors = raw.anchors.length - validAnchors.length;
  authorAnchors = validAnchors.map((entry) => ({
    id: entry.id,
    name: entry.name.trim(),
    productId: entry.productId,
    variantId: entry.variantId,
    regionId: entry.regionId,
    frameId: entry.frameId,
    calibrationId: entry.calibrationId,
    calibrationVersion: entry.calibrationVersion,
    posMm: [entry.posMm[0]!, entry.posMm[1]!] as [number, number],
  }));
  const authoring = defaultSheetAuthoring();
  authoring.customer = raw.job.customer ?? '';
  authoring.reference = raw.job.reference ?? '';
  authoring.article = raw.job.article ?? '';
  authoring.instructions = raw.operationalInstructions;
  authoring.tech.temperature = raw.methodParams?.['temperature'] ?? '';
  authoring.tech.time = raw.methodParams?.['time'] ?? '';
  authoring.tech.pressure = raw.methodParams?.['pressure'] ?? '';
  authoring.tech.thread = raw.methodParams?.['thread'] ?? '';
  authoring.tech.colour = raw.methodParams?.['colour'] ?? '';
  for (const placement of target.placements) {
    authoring.logos.set(logoRefForPlacement(placement, target.placements), defaultLogoAuthoring());
  }
  const extrasByLogo = new Map<string, DimensionBinding[]>();
  let restoredRows = 0;
  for (const binding of raw.dimensions) {
    if (typeof binding !== 'object' || binding === null) continue;
    const candidate = binding as DimensionBinding;
    if (matchLogoRef(target.placements, candidate.logoRef) === undefined) continue;
    if (candidate.edge !== 'minX' && candidate.edge !== 'maxX' && candidate.edge !== 'minY' && candidate.edge !== 'maxY') continue;
    if (candidate.convention !== 'dx' && candidate.convention !== 'dy' && candidate.convention !== 'shortest-to-edge') continue;
    if (typeof candidate.anchorId !== 'string') continue;
    const row = authoring.logos.get(candidate.logoRef);
    if (!row) continue;
    const list = extrasByLogo.get(candidate.logoRef) ?? [];
    list.push({
      logoRef: candidate.logoRef,
      anchorId: candidate.anchorId,
      edge: candidate.edge,
      convention: candidate.convention,
      label: typeof candidate.label === 'string' && candidate.label.length > 0
        ? candidate.label
        : candidate.logoRef,
    });
    extrasByLogo.set(candidate.logoRef, list);
  }
  for (const [logoRef, row] of authoring.logos) {
    const rows = extrasByLogo.get(logoRef) ?? [];
    row.measurements = rows.map((entry) => ({
      anchorId: entry.anchorId,
      edge: entry.edge,
      convention: entry.convention,
    }));
    if (row.measurements.length === 0) row.measurements = [{ anchorId: '', edge: 'minX', convention: 'dx' }];
    restoredRows += rows.length;
  }
  const companion = (raw as unknown as { _sheetUi?: unknown })._sheetUi;
  if (typeof companion === 'object' && companion !== null) {
    const codes = (companion as { businessCodes?: unknown }).businessCodes;
    if (typeof codes === 'object' && codes !== null) {
      for (const [logoRef, code] of Object.entries(codes as Record<string, unknown>)) {
        if (typeof code !== 'string') continue;
        const row = authoring.logos.get(logoRef);
        if (row) row.businessCode = code;
      }
    }
  }
  sheetAuthoring.set(target.id, authoring);
  activeSheetConfigId = target.id;
  renderAuthoringPanel();
  draftStatus.textContent =
    `Reopened operation draft for revision ${raw.sourceRevision}` +
    (droppedAnchors > 0 ? ` (${droppedAnchors} invalid anchor(s) dropped)` : '') +
    (restoredRows > 0 ? ` (${restoredRows} dimension row(s) restored)` : '') +
    `. Review the values before printing — stale returns are refused, never merged.`;
}

function onDraftFileChange(): void {
  const file = draftFile.files?.[0];
  if (file) void openOperationDraftFile(file);
  draftFile.value = '';
}

/* ---------------- Authoring event wiring ---------------- */

sheetConfig.addEventListener('change', () => {
  if (authoringBlocked()) return;
  activeSheetConfigId = sheetConfig.value;
  renderCustomerNotes();
  syncJobInputs();
  renderLogoRows();
  refreshAnchorSetup();
  renderSheetPreview();
  updateControls();
});

for (const [input, apply] of [
  [sheetCustomer, (value: string, authoring: SheetAuthoring) => { authoring.customer = value; }],
  [sheetReference, (value: string, authoring: SheetAuthoring) => { authoring.reference = value; }],
  [sheetArticle, (value: string, authoring: SheetAuthoring) => { authoring.article = value; }],
  [sheetInstructions, (value: string, authoring: SheetAuthoring) => { authoring.instructions = value; }],
  [sheetTechTemperature, (value: string, authoring: SheetAuthoring) => { authoring.tech.temperature = value; }],
  [sheetTechTime, (value: string, authoring: SheetAuthoring) => { authoring.tech.time = value; }],
  [sheetTechPressure, (value: string, authoring: SheetAuthoring) => { authoring.tech.pressure = value; }],
  [sheetTechColour, (value: string, authoring: SheetAuthoring) => { authoring.tech.colour = value; }],
  [sheetTechThread, (value: string, authoring: SheetAuthoring) => { authoring.tech.thread = value; }],
] as const) {
  input.addEventListener('input', () => {
    if (authoringBlocked() || activeSheetConfigId === null) return;
    const authoring = sheetAuthoring.get(activeSheetConfigId);
    if (!authoring) return;
    apply((input as HTMLInputElement | HTMLTextAreaElement).value, authoring);
    renderSheetPreview();
  });
}

anchorSide.addEventListener('change', () => {
  if (!authoringBlocked()) anchorSetupHandle?.refresh();
});
anchorRegion.addEventListener('change', () => {
  if (!authoringBlocked()) anchorSetupHandle?.refresh();
});
draftSave.addEventListener('click', saveOperationDraft);
draftOpenButton.addEventListener('click', () => draftFile.click());
draftFile.addEventListener('change', onDraftFileChange);
