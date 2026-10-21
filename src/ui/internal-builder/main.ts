import {
  PRESENTATION_MANIFEST_PATH,
  PRESENTATION_MAX_MODEL_BYTES,
  parsePresentationManifest,
  selectPresentationPackageAssets,
} from '../customer-editor/presentation-assets.js';
import { selectPresentationViews } from '../customer-editor/presentation-assets.js';
import {
  PHOTO_MAPPINGS_PATH,
  parsePhotoMappings,
  serializePhotoMappings,
  solveAffineFromCorrespondences,
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
} from '../../core/operation-measurements/index.js';
import type {
  AnchorDef,
  ArtworkEdge,
  DimensionBinding,
  MeasurementConvention,
  OperationDraft,
} from '../../core/operation-measurements/index.js';
import { createAnchorSetup } from './anchor-setup.js';
import type { AnchorSetupHandle, AnchorSetupInput } from './anchor-setup.js';
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
import type { ProjectPackageAsset } from '../../packaging/project-package/index.js';
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
const demoCreate = hook<HTMLButtonElement>('demo-create');
const createStatus = hook<HTMLElement>('create-status');
const catalogueNote = hook<HTMLElement>('catalogue-note');
const logoAdd = hook<HTMLButtonElement>('logo-add');
const logoFile = hook<HTMLInputElement>('logo-file');
const logoStatus = hook<HTMLElement>('logo-status');
const productName = hook<HTMLInputElement>('product-name');
const productAdd = hook<HTMLButtonElement>('product-add');
const productChoose = hook<HTMLButtonElement>('product-choose');
const productFile = hook<HTMLInputElement>('product-file');
const productStatus = hook<HTMLElement>('product-status');
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
const downloadReviewer = hook<HTMLButtonElement>('download-reviewer');
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
const sheetLogos = hook<HTMLElement>('sheet-logos');
const anchorSide = hook<HTMLSelectElement>('anchor-side');
const anchorRegion = hook<HTMLSelectElement>('anchor-region');
const anchorStatus = hook<HTMLElement>('anchor-status');
const anchorSetupBox = hook<HTMLElement>('anchor-setup');
const draftSave = hook<HTMLButtonElement>('draft-save');
const draftOpenButton = hook<HTMLButtonElement>('draft-open-button');
const draftFile = hook<HTMLInputElement>('draft-file');
const draftStatus = hook<HTMLElement>('draft-status');
/* Prepare-context product setup (Choose items disclosure). Declared here so
 * updateControls() — which runs during initial step paint — sees them. */
const prepSetupProduct = hook<HTMLSelectElement>('prep-setup-product');
const prepSetupVariant = hook<HTMLSelectElement>('prep-setup-variant');
const prepSetupRegion = hook<HTMLSelectElement>('prep-setup-region');
const prepSetupSide = hook<HTMLSelectElement>('prep-setup-side');
const prepSetupPhoto = hook<HTMLSelectElement>('prep-setup-photo');
const prepSetupMappingNote = hook<HTMLElement>('prep-setup-mapping-note');
const prepSetupStatus = hook<HTMLElement>('prep-setup-status');
const prepSetupBox = hook<HTMLElement>('prep-setup');
const prepSetupApply = hook<HTMLButtonElement>('prep-setup-apply');
const prepSetupApplyStatus = hook<HTMLElement>('prep-setup-apply-status');
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
  catalogueNote.hidden = !fromCatalogue || source === null;
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
let fromCatalogue = false;
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
    ? `No generated delivery retained. A saved baseline (${loadedBaseline.fileName}) remains loaded for return review.`
    : 'No issued baseline retained; generate a package first.';
  clearFileDetails();
  if (builderMode === 'prepare' && prepareStep === 'send') showStep('prepare', 'details');
  clearReturnReview();
  updateControls();
}

function updateControls(): void {
  const blocked = loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy;
  sourceChoose.disabled = blocked;
  sourceFile.disabled = blocked;
  startCreate.disabled = blocked;
  demoCreate.disabled = blocked;
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
  downloadReviewer.disabled = blocked;
  hook<HTMLButtonElement>('reviewer-copy').disabled = blocked;
  projectIdUseSource.disabled = source === null || blocked;
  projectIdNew.disabled = blocked;
  for (const input of [customerName, jobRef, issuedBy, projectIdInput, previewOnlyAck, formatSelf, formatHybrid]) input.disabled = blocked;
  const prepOff = prepareBlocked();
  for (const input of [prepSetupProduct, prepSetupVariant, prepSetupRegion, prepSetupSide, prepSetupPhoto]) input.disabled = prepOff;
  // Apply is prepare-only: absent from review semantics by being disabled
  // whenever an issued baseline or customer return is loaded.
  prepSetupApply.disabled = prepOff || reviewContextActive();
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
          const label = variant?.name !== undefined ? variant.name : variantId;
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
    empty.textContent = 'No configurations in source.';
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
 * Preview-only issue gate: selected products without regions/calibrations
 * stay preview-only and block issue until the operator either prepares them
 * (asset inspector, then Import prepared product JSON) or explicitly ticks
 * "Issue preview-only (uncalibrated)". Valid zero-placement selections of
 * calibrated products are never blocked by this gate.
 */
function refreshPreviewOnlyGate(): void {
  previewOnlyIds = selectedPreviewOnlyIds();
  if (previewOnlyIds.length === 0 || previewOnlyAck.checked) return;
  const ids = previewOnlyIds.join(', ');
  generateStatus.hidden = false;
  generateStatus.textContent =
    `Cannot issue yet: ${previewOnlyIds.length === 1 ? 'this product has' : 'these products have'} no regions or calibrations (${ids}). ` +
    'Prepare measurements in the asset inspector, then add them with “Import prepared product definition” in Choose items — ' +
    'or tick “Issue preview-only (uncalibrated)” below for an explicit preview-only handoff.';
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
    ? `No generated delivery retained. A saved baseline (${loadedBaseline.fileName}) remains loaded for return review.`
    : 'No issued baseline retained; generate a package first.';
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
    fromCatalogue = false;
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
    resetPrepareSetup();
    await loadAnchorsSidecar(parsed.assets, parsed.project);
    if (generation !== loadGeneration) return;
    refreshPrepareSetupProducts();
    projectIdSuggestion.textContent = `Source project ID “${summary.projectId}”. Enter a unique ID for this customer issue.`;
    clearGeneratedOutputs();
    previewOnlyAck.checked = false;
    previewOnlyIds = [];
    sourceStatus.textContent = `Loaded ${file.name}: project ${summary.projectId} revision ${summary.revision}, ${summary.productIds.length} products, ${summary.logoIds.length} logos, ${summary.configurationIds.length} configurations, ${summary.assetPaths.length} assets.`;
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
    throw new Error('Customer configurator HTML is not embedded exactly once; rebuild dist/internal-builder.html before generating.');
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
      .filter((product) => selection.productIds.includes(product.id) && isPreviewOnlyProduct(product))
      .map((product) => product.id);
    if (uncalibrated.length > 0 && !previewOnlyAck.checked) {
      generateStatus.hidden = false;
      generateStatus.textContent =
        `Issue rejected: ${uncalibrated.join(', ')} ${uncalibrated.length === 1 ? 'has' : 'have'} no regions or calibrations. ` +
        'Prepare measurements in the asset inspector, then add them with “Import prepared product definition” — or tick “Issue preview-only (uncalibrated)”.';
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
      `Retained issued baseline: ${identity.projectId} revision 1 (${packageBytes.length} bytes). Save this exact file before closing the page; memory is lost on reload.`;
    generateStatus.textContent =
      `Issued ${identity.projectId} revision 1 for ${identity.customerLabel} / ${identity.jobReference} by ${identity.issuedBy}. Confirmation and internal review history reset before customer handoff.`;
    readySummary.textContent = `${identity.customerLabel} · ${identity.jobReference} · Prepared by ${identity.issuedBy}`;
    renderFileDetails(identity);
    sizeEstimate.textContent = `${hybrid ? 'ZIP package' : 'Ready-to-open customer file'} · ${((hybrid ? zipBytes!.length : htmlBytes.length) / 1024 / 1024).toFixed(1)} MB. ${hybrid ? 'Ask the customer to unzip it first.' : 'The customer opens it directly.'}`;
    showStep('prepare', 'send');
  } catch (error) {
    if (generation === generateGeneration) {
      generated = null;
      sizeEstimate.textContent = 'No issued package generated yet.';
      baselineStatus.textContent = 'No issued baseline retained; generate a package first.';
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
  const fileName = `${safeJobPart(snapshot.project.projectId)}-prepared-master.logo-project`;
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
    const mergedBytes = serializePhotoMappings(merged);
    const reparsed = parsePhotoMappings(mergedBytes);
    if (!reparsed || reparsed.mappings.length !== merged.mappings.length) {
      throw new Error('staged mappings did not serialize');
    }
    const additionalAssets = [
      ...snapshot.assets.filter((asset) => asset.kind === 'additional' && asset.path !== PHOTO_MAPPINGS_PATH && asset.path !== OPERATION_ANCHORS_PATH).map(({ path, bytes }) => ({ path, bytes })),
      { path: PHOTO_MAPPINGS_PATH, bytes: mergedBytes },
    ];
    let sidecarNote = '';
    if (prepareAnchors.length > 0) {
      const digest = await hasher.prepareProject(snapshot.project);
      additionalAssets.push({ path: OPERATION_ANCHORS_PATH, bytes: buildAnchorsSidecarBytes(snapshot.project, digest) });
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
    if (!backMappings || backMappings.mappings.length !== merged.mappings.length) {
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
    `Download started: issued baseline (${baseline.packageBytes.length} bytes). Save it before closing the page; memory is lost on reload.`;
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
    baselineLoadStatus.textContent = `Loaded saved baseline ${file.name}: project ${parsed.project.projectId} revision ${parsed.project.revision} (${bytes.length} bytes). Return review is now available.`;
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
    const geometry = geometryLine(imported);
    if (generation !== returnGeneration) return;
    const candidateDigest = await hasher.prepareProject(imported);
    if (generation !== returnGeneration) return;
    const candidate: ResultCandidate = buildCandidateExport(imported, hasher.sha256Hex);
    const serialized = serializeExport(candidate);
    if (generation !== returnGeneration) return;
    const reviewTimestamp = new Date().toISOString();
    lastReturn = {
      imported,
      candidate,
      contentDigest: digest,
      serializedCandidate: serialized,
      candidateFileName: `${baseline.jobPart}-r${imported.revision}-candidate.json`,
      geometryOk: geometry.ok,
      returnFileName: file.name,
      baselineFileName: baseline.fileName,
      reviewTimestamp,
    };
    reviewPanel.hidden = false;
    for (const node of reviewPanel.querySelectorAll('[data-builder-dynamic]')) node.remove();
    const anchor = ticketSummary;
    const confirmation = document.createElement('p');
    confirmation.setAttribute('data-builder-dynamic', 'true');
    confirmation.textContent = confirmationLine(imported, digest);
    const geometrySummary = document.createElement('p');
    geometrySummary.setAttribute('data-builder-dynamic', 'true');
    geometrySummary.textContent = geometry.text;
    const differenceText = differenceLines(baseline.issuedProject, imported);
    const differences = document.createElement('pre');
    differences.setAttribute('data-builder-dynamic', 'true');
    differences.textContent = differenceText.join('\n\n');
    reviewPanel.insertBefore(confirmation, anchor);
    reviewPanel.insertBefore(geometrySummary, anchor);
    reviewPanel.insertBefore(differences, anchor);
    renderReviewFiles();
    renderReviewChanges(baseline.issuedProject);
    const decision = imported.review !== undefined ? imported.review.decision : 'pending (no current internal review)';
    ticketSummary.textContent =
      `Project ${imported.projectId}; revision ${imported.revision}; candidate digest ${candidate.digest}; confirmation ${imported.confirmation === undefined ? 'none' : `rev ${imported.confirmation.revision} by ${imported.confirmation.confirmedBy}`} (timestamp source: returned confirmation envelope); decision ${decision}.`;
    // Handoff summary: real filenames, exact candidate name, operator
    // Print/Save-as-PDF instructions; customer delivery (ZIP/HTML) vs
    // production attachments (candidate JSON + printed PDF); no Odoo.
    handoffSummary.textContent =
      `Return file: ${file.name}. Baseline file: ${baseline.fileName}. Candidate file: ${lastReturn.candidateFileName}. ` +
      `Press “Print operation document”, then choose Print / Save as PDF in the browser dialog; attach the candidate JSON plus the printed PDF to the production ticket/BoM. ` +
      `Customer delivery files (${generated !== null ? (generated.format === 'hybrid' ? `${generated.jobPart}.zip + OPEN_LOGO_CONFIGURATOR.html` : `OPEN_LOGO_CONFIGURATOR.html (self-contained, embeds ${generated.jobPart}.logo-project)`) : 'none generated this session'}) are separate from these production attachments. ` +
      `Reviewed ${reviewTimestamp} (local browser clock). No Odoo calls were made; manual attachment is the only handoff.`;
    operationContainer.replaceChildren();
    const returnAssetBytes = new Map(parsed.assets.map((asset) => [asset.path, asset.bytes]));
    const returnManifestBytes = returnAssetBytes.get('presentation/preview.json');
    const returnSelections = selectOperationReferenceViews(
      candidate.configurations,
      returnManifestBytes,
      returnManifestBytes !== undefined,
      { getBytes: (path) => returnAssetBytes.get(path) },
    );
    const returnReferenceViews: Record<string, readonly ReferenceViewInput[]> = Object.create(null);
    const returnReferenceWarnings: Record<string, string> = Object.create(null);
    for (const [id, selection] of Object.entries(returnSelections)) {
      returnReferenceViews[id] = selection.views;
      if (selection.warning !== null) returnReferenceWarnings[id] = selection.warning;
    }
    lastReturnAssets = returnAssetBytes;
    lastReturnReferenceViews = returnReferenceViews;
    initSheetAuthoring(candidate);
    renderSheetPreview();
    operationContainer.hidden = false;
    returnStatus.textContent = 'Return imported against the active issued baseline. Internal review is pending.';
    showStep('review', 'check');
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

function embeddedReviewerBytes(): Uint8Array {
  const nodes = document.querySelectorAll('#__logoCustomerReviewerHtml');
  if (nodes.length === 0) {
    throw new Error('Customer return reviewer HTML is not embedded; open dist/customer-return-review.html offline via file:// instead.');
  }
  if (nodes.length !== 1) {
    throw new Error('Customer return reviewer HTML is not embedded exactly once.');
  }
  const node = nodes[0]!;
  if (node.tagName !== 'SCRIPT' || node.getAttribute('type') !== 'text/plain') {
    throw new Error('Embedded reviewer block has an unexpected element shape.');
  }
  return decodeEmbeddedProjectBase64(node.textContent ?? '');
}

function downloadReviewerFile(): void {
  try {
    const bytes = embeddedReviewerBytes();
    downloadBytes(bytes, 'CUSTOMER_RETURN_REVIEW.html', 'text/html');
    baselineLoadStatus.textContent =
      `Downloaded CUSTOMER_RETURN_REVIEW.html (${bytes.length} bytes). Open it offline via file:// for full decision/reproposal support; or open dist/customer-return-review.html.`;
  } catch (error) {
    baselineLoadStatus.textContent =
      `Reviewer download unavailable: ${error instanceof Error ? error.message : String(error)} Open dist/customer-return-review.html offline via file:// instead.`;
  }
}

interface BuilderCatalogue {
  products: ProjectDocument['products'];
  logos: ProjectDocument['logos'];
  assets: { path: string; bytesBase64: string }[];
}
function readEmbeddedCatalogue(): BuilderCatalogue {
  const node = document.querySelector('#__logoBuilderCatalogue');
  if (node === null) {
    throw new Error('Example product catalogue is not embedded; rebuild dist/internal-builder.html before creating a project.');
  }
  if (node.tagName !== 'SCRIPT' || node.getAttribute('type') !== 'application/json') {
    throw new Error('Embedded example catalogue has an unexpected element shape.');
  }
  const content = node.textContent ?? '';
  if (content.length > 8 * 1024 * 1024) throw new Error('Embedded catalogue is too large.');
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Embedded example catalogue is invalid.');
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record['products']) || !Array.isArray(record['logos']) || !Array.isArray(record['assets'])) {
    throw new Error('Embedded example catalogue is missing products, logos or assets.');
  }
  return parsed as BuilderCatalogue;
}
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)!;
  return bytes;
}
async function createFromCatalogue(demo: boolean): Promise<void> {
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
  createStatus.textContent = 'Creating a new draft from example products…';
  try {
    const catalogue = readEmbeddedCatalogue();
    if (generation !== createGeneration) return;
    const draft = createProjectFromDefinitions({ products: catalogue.products, logos: catalogue.logos, projectId: newLocalId(), synthetic: true });
    if (!draft.ok) {
      if (generation === createGeneration) {
        createStatus.textContent = `Could not create a project: ${draft.errors.map((error) => error.message).join('; ')}. Your previous project is still available.`;
        alertBuilder('The example catalogue could not be used. Your previous project is still available.');
      }
      return;
    }
    if (generation !== createGeneration) return;
    assertProjectEditorLimits(draft.project);
    const catalogueAssets = catalogue.assets.map((asset) => ({ path: asset.path, bytes: base64ToBytes(asset.bytesBase64), kind: 'referenced' as const }));
    const packageBytes = await createProjectPackage({ project: draft.project, assets: catalogueAssets }, { sha256: hasher.sha256Bytes });
    const checked = await parseProjectPackage(packageBytes, { sha256: hasher.sha256Bytes });
    if (generation !== createGeneration) return;
    const summary = summarizeSourceProject(checked.project);
    logoImports = [];
    fromCatalogue = true;
    pendingPrimaryImage = null;
    pendingPrimaryModel = null;
    pendingViews = { front: null, back: null, left: null, right: null };
    addedPresentations = [];
    productStatus.textContent = '';
    productName.value = '';
    source = { fileName: 'example-catalogue', project: checked.project, assets: checked.assets, summary, packageBytes };
    configurationsTouched = false;
    renderSelectionLists(summary);
    stagedPhotoMappings = [];
    resetMappingSessionUI();
    resetPrepareSetup();
    refreshPrepareSetupProducts();
    if (demo) {
      // Explicit demo opt-in: select everything the synthetic catalogue offers.
      for (const box of document.querySelectorAll<HTMLInputElement>('.rows input[type="checkbox"]')) {
        box.checked = true;
      }
    }
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
    masterStatus.textContent = demo ? 'Synthetic demo data loaded; nothing is uploaded.' : 'Empty draft ready; nothing is selected yet.';
    createStatus.textContent = demo
      ? `Loaded synthetic demo data with ${summary.products.length} example products. Example products — not for production.`
      : `Created a new empty draft with ${summary.products.length} example products, nothing selected. Example products — not for production.`;
    refreshSelectionValidation();
    showStep('prepare', 'choose');
  } catch (error) {
    if (generation === createGeneration) {
      createStatus.textContent = `Could not create a project: ${error instanceof Error ? error.message : String(error)}. Your previous project is still available.`;
      alertBuilder('The example catalogue could not be used. Your previous project is still available.');
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
    const made = createProvisionalProduct({ id: candidateId, ...(wantedName ? { name: `${wantedName} — provisional uncalibrated` } : {}), kind: 'other' });
    if (!made.ok) {
      productStatus.textContent = `Could not add product: ${made.errors.map((error) => error.message).join('; ')}. Previous products are unchanged.`;
      return;
    }
    const productId = made.product.id;
    const variantId = made.product.variants[0]!.id;
    const safe = safeProductSegment(productId);
    const stagedModel = pendingPrimaryModel;
    const stagedPrimary = pendingPrimaryImage;
    const stagedViews = { ...pendingViews };
    if (generation !== productGeneration) return;
    const assets: Array<{ path: string; bytes: Uint8Array }> = [];
    const views: Array<{ view: string; image: string; label?: string }> = [];
    const models: Array<{ model: string; label?: string }> = [];
    const primaryLabelBase = (wantedName ? `${wantedName} — provisional uncalibrated` : `Provisional uncalibrated product ${productId}`);
    if (stagedModel) {
      const modelPath = `presentation/${safe}/model.glb`;
      assets.push({ path: modelPath, bytes: stagedModel.bytes.slice() });
      models.push({ model: modelPath, label: `${primaryLabelBase} — 3D model (projection views are model projections, not garment unfoldings)` });
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
      views.push({ view: side, image: imagePath, label: typed !== '' ? typed : `${primaryLabelBase} — ${side} view (flat reference, not calibrated)` });
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
    nextProject.products.push(JSON.parse(JSON.stringify(made.product)) as ProjectDocument['products'][number]);
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
    if (generation !== productGeneration) return;
    productStatus.textContent = `Added preview-only product ${productId} (${views.length} view${views.length === 1 ? '' : 's'}${models.length ? ', 3D model' : ''}). It carries no measurements and cannot host placements; missing sides are absent, never invented.${historyNote}`;
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
    if (generation !== productGeneration) return;
    productStatus.textContent = `Imported prepared product ${importedProductId} (${newConfigIds.size} zero-placement setup${newConfigIds.size === 1 ? '' : 's'}). Millimetre regions and calibration refs are explicit and provisional, pending review — never production-approved.${evidenceAdditions.length === 0 ? ' No bridge evidence was supplied.' : ' Bridge evidence ships with the package.'}`;
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
sourceChoose.addEventListener('click', () => sourceFile.click());
sourceFile.addEventListener('change', onSourceFileChange);
startCreate.addEventListener('click', () => void createFromCatalogue(false));
demoCreate.addEventListener('click', () => void createFromCatalogue(true));
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
downloadReviewer.addEventListener('click', downloadReviewerFile);
hook<HTMLButtonElement>('reviewer-copy').addEventListener('click', downloadReviewerFile);
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
let prepareSetupHandle: AnchorSetupHandle | null = null;

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
  return loading || generating || creating || logoImporting || productImporting || returnBusy || baselineBusy || source === null;
}

/** True once an issued baseline exists anywhere: Apply stays out of review. */
function reviewContextActive(): boolean {
  return generated !== null || loadedBaseline !== null || lastReturn !== null;
}

function resetPrepareSetup(): void {
  prepareAnchors = [];
  if (prepareSetupHandle !== null) {
    prepareSetupHandle.destroy();
    prepareSetupHandle = null;
  }
  prepSetupProduct.replaceChildren();
  prepSetupVariant.replaceChildren();
  prepSetupRegion.replaceChildren();
  prepSetupSide.replaceChildren();
  prepSetupPhoto.replaceChildren();
  prepSetupMappingNote.textContent = '';
  prepSetupStatus.textContent = '';
  prepSetupBox.replaceChildren();
  prepSetupApplyStatus.textContent = '';
}

function prepareSelectedProduct(): ProjectDocument['products'][number] | null {
  if (source === null) return null;
  return source.project.products.find((entry) => entry.id === prepSetupProduct.value) ?? null;
}

function refreshPrepareSetupProducts(): void {
  prepSetupProduct.replaceChildren();
  if (source === null) {
    prepSetupStatus.textContent = 'Create or open a project first.';
    return;
  }
  for (const product of source.project.products) {
    const option = document.createElement('option');
    option.value = product.id;
    option.textContent = product.name !== undefined ? `${product.name} (${product.id})` : product.id;
    prepSetupProduct.append(option);
  }
  refreshPrepareSetupVariants();
}

function refreshPrepareSetupVariants(): void {
  const product = prepareSelectedProduct();
  const kept = prepSetupVariant.value;
  prepSetupVariant.replaceChildren();
  if (product !== null) {
    for (const variant of product.variants) {
      const option = document.createElement('option');
      option.value = variant.id;
      option.textContent = variant.name !== undefined ? `${variant.name} (${variant.id})` : variant.id;
      prepSetupVariant.append(option);
    }
    if (kept !== '' && product.variants.some((entry) => entry.id === kept)) {
      prepSetupVariant.value = kept;
    } else if (product.variants.length > 0) {
      prepSetupVariant.value = product.variants[0]!.id;
    }
  }
  refreshPrepareSetupRegions();
}

function refreshPrepareSetupRegions(): void {
  const product = prepareSelectedProduct();
  const kept = prepSetupRegion.value;
  prepSetupRegion.replaceChildren();
  if (product !== null) {
    const variant = product.variants.find((entry) => entry.id === prepSetupVariant.value);
    const allowed = variant !== undefined ? new Set(variant.regionIds) : null;
    for (const region of product.regions) {
      if (allowed !== null && !allowed.has(region.id)) continue;
      const option = document.createElement('option');
      option.value = region.id;
      option.textContent = region.name !== undefined ? `${region.name} (${region.id})` : region.id;
      prepSetupRegion.append(option);
    }
    if (kept !== '' && product.regions.some((entry) => entry.id === kept) && (allowed === null || allowed.has(kept))) {
      prepSetupRegion.value = kept;
    }
  }
  refreshPrepareSetupPhotos();
}

function refreshPrepareSetupPhotos(): void {
  prepSetupSide.replaceChildren();
  prepSetupPhoto.replaceChildren();
  prepSetupMappingNote.textContent = '';
  const product = prepareSelectedProduct();
  if (source === null || product === null) return;
  const variantId = prepSetupVariant.value;
  const assets = sessionAssetMap();
  const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
  const manifest = parsePresentationManifest(manifestBytes);
  const selection = selectPresentationViews(manifest, manifestBytes !== undefined, product.id, variantId, (path) => assets.get(path));
  const bySide = new Map<string, Array<{ imagePath: string; label: string | null }>>();
  for (const view of selection.views) {
    if (view.view === null) continue;
    const list = bySide.get(view.view) ?? [];
    list.push({ imagePath: view.imagePath, label: view.label });
    bySide.set(view.view, list);
  }
  const keptSide = prepSetupSide.value;
  for (const side of ['front', 'back', 'left', 'right'] as const) {
    if (!bySide.has(side)) continue;
    const option = document.createElement('option');
    option.value = side;
    option.textContent = side;
    prepSetupSide.append(option);
  }
  if (keptSide !== '' && bySide.has(keptSide)) prepSetupSide.value = keptSide;
  refreshPrepareSetupPhotoOptions(bySide);
  if (selection.warning !== null) prepSetupMappingNote.textContent = selection.warning;
}

function refreshPrepareSetupPhotoOptions(bySide?: Map<string, Array<{ imagePath: string; label: string | null }>>): void {
  prepSetupPhoto.replaceChildren();
  if (bySide === undefined || prepSetupSide.value === '') {
    if (prepSetupSide.options.length === 0) {
      prepSetupMappingNote.textContent =
        'No product photo for this product/option yet — assign a side view image above first. Anchors can still be entered numerically once a photo arrives; nothing is guessed from photo bounds.';
    }
    refreshPrepareSetup();
    return;
  }
  const kept = prepSetupPhoto.value;
  for (const view of bySide.get(prepSetupSide.value) ?? []) {
    const option = document.createElement('option');
    option.value = view.imagePath;
    option.textContent = view.label !== null ? `${view.imagePath} — ${view.label}` : view.imagePath;
    prepSetupPhoto.append(option);
  }
  if (kept !== '' && [...prepSetupPhoto.options].some((entry) => entry.value === kept)) prepSetupPhoto.value = kept;
  refreshPrepareSetup();
}

/** Merged mapping entries backing the prepare setup: packaged master file first, staged session entries on top. */
function prepareMergedMappings(): { version: 1; mappings: PhotoMappingEntry[] } {
  const packaged = source === null
    ? null
    : parsePhotoMappings(source.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes);
  return mergeSessionPhotoMappings(packaged, stagedPhotoMappings);
}

function prepareSetupInput(): AnchorSetupInput | { error: string } {
  if (source === null) return { error: 'Create or open a project first.' };
  const product = prepareSelectedProduct();
  const region = product?.regions.find((entry) => entry.id === prepSetupRegion.value);
  if (!product || !region) return { error: 'Choose a product and region for the setup.' };
  const variantId = prepSetupVariant.value;
  if (variantId === '' || !product.variants.some((entry) => entry.id === variantId)) {
    return { error: 'Choose a product option (variant) for the setup.' };
  }
  const imagePath = prepSetupPhoto.value;
  if (prepSetupSide.value === '' || imagePath === '') {
    return { error: 'Choose a photo side for the setup.' };
  }
  const assets = sessionAssetMap();
  const photoBytes = assets.get(imagePath);
  const header = photoBytes ? readRasterHeader(photoBytes) : null;
  if (!photoBytes || !header) {
    return { error: `Photo “${imagePath}” is missing or undecodable; anchors can still be entered numerically, but photo clicks need the mapped photo.` };
  }
  const merged = prepareMergedMappings();
  const entry = merged.mappings.find((candidate) =>
    candidate.productId === product.id && candidate.regionId === region.id &&
    candidate.view === prepSetupSide.value && candidate.image === imagePath &&
    (candidate.variantId ?? variantId) === variantId);
  if (!entry) {
    return { error: 'Setup needed: save a photo mapping for this side first (Map artwork photos above). Packaged mappings load automatically; nothing is guessed from photo bounds.' };
  }
  if (entry.calibrationId !== region.calibrationRef.calibrationId ||
    entry.calibrationVersion !== region.calibrationRef.version) {
    return { error: `Setup refused: the mapping targets calibration “${entry.calibrationId} v${entry.calibrationVersion}” but region “${region.name ?? region.id}” pins “${region.calibrationRef.calibrationId} v${region.calibrationRef.version}”.` };
  }
  const key = anchorScopeKey({ productId: product.id, variantId, regionId: region.id });
  const proposal = safeAreaProposals.get(key);
  const safeArea = region.safeArea
    .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => ({ x: point[0]!, y: point[1]! }));
  const packagedCount = (source.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes
    ? parsePhotoMappings(source.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes)?.mappings.length ?? 0
    : 0);
  prepSetupMappingNote.textContent =
    `Mapping for this photo: ${entry.status}, ${entry.transform ? 'evaluated' : 'missing'} transform` +
    (packagedCount > 0 ? ` · ${packagedCount} packaged mapping(s) in this source` : ' · no packaged mappings; staged entries apply on top') +
    (stagedPhotoMappings.length > 0 ? ` · ${stagedPhotoMappings.length} staged` : '') + '.';
  return {
    photo: { bytes: photoBytes, widthPx: header.width, heightPx: header.height, label: `${product.name ?? product.id} · ${prepSetupSide.value} · ${imagePath}` },
    transform: { ...entry.transform },
    mappingStatus: entry.status,
    view: entry.view,
    scope: {
      productId: product.id,
      variantId,
      regionId: region.id,
      frameId: region.frame.frameId,
      calibrationId: region.calibrationRef.calibrationId,
      calibrationVersion: region.calibrationRef.version,
      regionName: region.name ?? null,
    },
    safeArea,
    anchors: prepareAnchors.filter((anchor) =>
      anchor.productId === product.id && anchor.variantId === variantId && anchor.regionId === region.id),
    stagedSafeArea: proposal ? [...proposal.staged] : null,
  };
}

function refreshPrepareSetup(): void {
  prepSetupBox.replaceChildren();
  if (prepareSetupHandle !== null) {
    prepareSetupHandle.destroy();
    prepareSetupHandle = null;
  }
  if (source === null) {
    prepSetupStatus.textContent = 'Create or open a project first.';
    updateControls();
    return;
  }
  prepareSetupHandle = createAnchorSetup(prepSetupBox, () => prepareSetupInput(), {
    onAnchorsChange: (next) => {
      const scope = next[0];
      const key = scope ? anchorScopeKey(scope) : null;
      if (key === null) return;
      prepareAnchors = prepareAnchors.filter((entry) => anchorScopeKey(entry) !== key).concat(next);
      prepSetupApplyStatus.textContent =
        `Anchors for this scope: ${next.length}. They travel with “Save prepared master”; safe-area edits below stay proposals until applied.`;
    },
    onSafeAreaProposal: (staged, note) => {
      const key = prepareScopeKeyString();
      if (key === null) return;
      if (staged === null || note === null) {
        safeAreaProposals.delete(key);
      } else {
        safeAreaProposals.set(key, { staged, note });
      }
      updateControls();
    },
    onStatus: (message) => {
      prepSetupStatus.textContent = message;
    },
  });
  prepareSetupHandle.refresh();
  updateControls();
}

function prepareScopeKeyString(): string | null {
  if (source === null) return null;
  if (prepSetupProduct.value === '' || prepSetupVariant.value === '' || prepSetupRegion.value === '') return null;
  return anchorScopeKey({ productId: prepSetupProduct.value, variantId: prepSetupVariant.value, regionId: prepSetupRegion.value });
}

/**
 * Validated Apply: writes the staged safe-area proposal for the selected
 * prepare scope into the in-memory source product. Failure blocks with the
 * reason shown; success rebuilds the source package (reparse-verified),
 * marks the source dirty (selection validation re-runs), and the existing
 * “Save prepared master” download then carries the updated definition.
 * Never touches an issued baseline or return.
 */
async function applyPrepareSafeArea(): Promise<void> {
  if (prepareBlocked()) return;
  if (reviewContextActive()) {
    prepSetupApplyStatus.textContent =
      'Apply is prepare-only: an issued baseline or customer return is loaded, so proposals stay proposals here. Return to Prepare → Choose items on a plain source to apply.';
    return;
  }
  if (source === null) {
    prepSetupApplyStatus.textContent = 'Create or open a project first.';
    return;
  }
  const snapshot = source;
  const key = prepareScopeKeyString();
  if (key === null) {
    prepSetupApplyStatus.textContent = 'Choose a product, option and region first.';
    return;
  }
  const proposal = safeAreaProposals.get(key);
  if (!proposal) {
    prepSetupApplyStatus.textContent = 'No staged safe-area proposal for this scope — drag a corner above first.';
    return;
  }
  const staged = proposal.staged;
  if (staged.length < 3 || !staged.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    prepSetupApplyStatus.textContent = 'Apply refused: the staged proposal needs at least 3 finite corners.';
    return;
  }
  let area = 0;
  for (let i = 0; i < staged.length; i += 1) {
    const a = staged[i]!;
    const b = staged[(i + 1) % staged.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area / 2) <= 1e-9) {
    prepSetupApplyStatus.textContent = 'Apply refused: the staged polygon is degenerate (zero area).';
    return;
  }
  const product = snapshot.project.products.find((entry) => entry.id === prepSetupProduct.value);
  const region = product?.regions.find((entry) => entry.id === prepSetupRegion.value);
  if (!product || !region) {
    prepSetupApplyStatus.textContent = 'Apply refused: the selected product or region is gone — choose it again.';
    return;
  }
  if (prepSetupVariant.value === '' || !product.variants.some((entry) => entry.id === prepSetupVariant.value)) {
    prepSetupApplyStatus.textContent = 'Apply refused: the selected option (variant) is gone — choose it again.';
    return;
  }
  prepSetupApplyStatus.textContent = 'Applying staged safe area to the source product…';
  try {
    const updated: ProjectDocument = {
      ...snapshot.project,
      products: snapshot.project.products.map((entry) => (
        entry.id !== product.id ? entry : {
          ...entry,
          regions: entry.regions.map((candidate) => (
            candidate.id !== region.id ? candidate : {
              ...candidate,
              safeArea: staged.map((point) => [point.x, point.y] as [number, number]),
            }
          )),
        }
      )),
    };
    const problems = validateProject(updated);
    if (!problems.ok) {
      throw new Error(`project validation: ${problems.errors.map((error) => error.message).join('; ')}`);
    }
    assertProjectEditorLimits(updated);
    const rebuilt = await createProjectPackage(
      {
        project: updated,
        assets: snapshot.assets.filter((asset) => asset.kind !== 'additional').map(({ path, bytes }) => ({ path, bytes })),
        additionalAssets: snapshot.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes })),
      },
      { sha256: hasher.sha256Bytes },
    );
    const back = await parseProjectPackage(rebuilt, { sha256: hasher.sha256Bytes });
    assertProjectEditorLimits(back.project);
    if (canonicalize(back.project) !== canonicalize(updated)) {
      throw new Error('reparse changed the project');
    }
    const summary = summarizeSourceProject(back.project);
    source = { fileName: snapshot.fileName, project: back.project, assets: back.assets, summary, packageBytes: rebuilt.slice() };
    safeAreaProposals.delete(key);
    renderSelectionLists(summary, true);
    refreshSelectionValidation();
    refreshPrepareSetupProducts();
    prepSetupApplyStatus.textContent =
      `Applied ${staged.length}-corner safe area to region “${region.name ?? region.id}”. The source changed: selection re-validated, previous downloads cleared. “Save prepared master” now carries the updated definition.`;
  } catch (error) {
    prepSetupApplyStatus.textContent =
      `Apply refused: ${error instanceof Error ? error.message : String(error)}. The source product is unchanged.`;
  } finally {
    updateControls();
  }
}

/**
 * Anchors sidecar for the prepared master: versioned, digest-bound, never
 * browser storage. Saved with the master, refused as stale on open when the
 * master digest moved since the anchors were saved.
 */
function buildAnchorsSidecarBytes(project: ProjectDocument, digest: string): Uint8Array {
  const scoped = prepareAnchors.filter((entry) =>
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

const prepSetupDisclosureBox = hook<HTMLDetailsElement>('prep-setup-disclosure');
prepSetupDisclosureBox.addEventListener('toggle', () => {
  if (prepSetupDisclosureBox.open) refreshPrepareSetupProducts();
});
prepSetupProduct.addEventListener('change', refreshPrepareSetupVariants);
prepSetupVariant.addEventListener('change', refreshPrepareSetupRegions);
prepSetupRegion.addEventListener('change', () => { if (!prepareBlocked()) refreshPrepareSetupPhotos(); });
prepSetupSide.addEventListener('change', () => {
  if (prepareBlocked()) return;
  refreshPrepareSetupPhotos();
});
prepSetupPhoto.addEventListener('change', () => { if (!prepareBlocked()) refreshPrepareSetup(); });
prepSetupApply.addEventListener('click', () => void applyPrepareSafeArea());
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
): { text: string; ok: boolean } {
  if (measurement.anchorId === '') return { text: 'No anchor chosen — setup needed.', ok: false };
  const anchor = authorAnchors.find((entry) => entry.id === measurement.anchorId);
  if (!anchor) return { text: 'The chosen anchor is gone — pick another below or set one up.', ok: false };
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
    return { text: `${value} mm — ${first.label}; from ${first.fromAnchor} to ${first.toEdge}. ${honesty}`, ok: true };
  }
  return { text: `${measured.unfinished[0] ?? 'No measurement — setup needed.'}`, ok: false };
}

function renderLogoRows(): void {
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
    const EDGE_OPTIONS = [['minX', 'left edge (min-X)'], ['maxX', 'right edge (max-X)'], ['minY', 'bottom edge (min-Y)'], ['maxY', 'top edge (max-Y)']] as const;
    const CONVENTION_OPTIONS = [['dx', 'horizontal (dx)'], ['dy', 'vertical (dy)'], ['shortest-to-edge', 'shortest (to edge)']] as const;
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
      conventionLabel.textContent = 'Convention';
      const conventionSelect = document.createElement('select');
      conventionSelect.disabled = blocked;
      conventionSelect.setAttribute('aria-label', `Measurement ${measureIndex + 1} convention for logo ${index + 1}`);
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
      rowBox.append(grid);
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
      const result = document.createElement('p');
      result.setAttribute('role', 'status');
      result.setAttribute('aria-label', `Measurement ${measureIndex + 1} result for logo ${index + 1}`);
      rowBox.append(result);
      function paintMeasurementResult(): void {
        const described = describeLogoMeasurement(current!.candidate, placement, config!.placements, measurement);
        result.textContent = described.text;
        result.className = described.ok ? 'sheet-logo-result' : 'sheet-logo-unfinished';
      }
      paintMeasurementResult();
      list.append(rowBox);
    });
    card.append(list);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn-secondary';
    add.textContent = 'Add measurement';
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
