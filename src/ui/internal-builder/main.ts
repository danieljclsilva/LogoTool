import {
  PRESENTATION_MANIFEST_PATH,
  PRESENTATION_MAX_MODEL_BYTES,
  parsePresentationManifest,
  selectPresentationPackageAssets,
} from '../customer-editor/presentation-assets.js';
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
} from '../../core/index.js';
import type {
  Configuration,
  Placement,
  ProjectDocument,
  ResultCandidate,
} from '../../core/index.js';
import { assertProjectEditorLimits, evaluateProjectGeometry } from '../../core/project-editor/index.js';
import { buildOperationDocument } from '../../core/operation-document/index.js';
import {
  operationDocumentStyles,
  renderOperationDocument,
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
import { createProvisionalProduct } from '../../core/project-builder/provisional-product.js';
import { createWebCryptoProjectHasher } from '../shared/browser-hasher.js';
import { zipSync } from 'fflate';

interface SourceState {
  fileName: string;
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
  summary: BuilderSourceSummary;
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
const createStatus = hook<HTMLElement>('create-status');
const catalogueNote = hook<HTMLElement>('catalogue-note');
const logoAdd = hook<HTMLButtonElement>('logo-add');
const logoFile = hook<HTMLInputElement>('logo-file');
const logoStatus = hook<HTMLElement>('logo-status');
const productName = hook<HTMLInputElement>('product-name');
const productAdd = hook<HTMLButtonElement>('product-add');
const productFile = hook<HTMLInputElement>('product-file');
const productStatus = hook<HTMLElement>('product-status');
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
      compare('Logo size', oldItem ? `${oldItem.widthMm} × ${oldItem.heightMm} mm` : '(not placed)', newItem ? `${newItem.widthMm} × ${newItem.heightMm} mm` : '(removed)');
      if (oldItem?.regionId !== newItem?.regionId) compare('Logo area', names(oldItem), names(newItem));
      else line(group, `Logo area: ${names(item)}`);
      if (oldItem?.method !== newItem?.method) compare('Method', oldItem?.method ?? '(none)', newItem?.method ?? '(none)');
      else line(group, `Method: ${item.method}`);
      if (oldItem?.logoId !== newItem?.logoId && oldItem && newItem) compare('Artwork', back.logos.find(logo => logo.id === oldItem.logoId)?.name ?? oldItem.logoId, logo?.name ?? newItem.logoId);
      if (oldItem?.instructions !== newItem?.instructions) compare('Customer note', oldItem?.instructions || '(none)', newItem?.instructions || '(none)');
      if (oldItem && newItem && (oldItem.pos.xMm !== newItem.pos.xMm || oldItem.pos.yMm !== newItem.pos.yMm)) compare('Position (mm)', `${oldItem.pos.xMm}, ${oldItem.pos.yMm}`, `${newItem.pos.xMm}, ${newItem.pos.yMm}`);
      if (oldItem && newItem && oldItem.rotationDeg !== newItem.rotationDeg) compare('Clockwise rotation', `${oldItem.rotationDeg}°`, `${newItem.rotationDeg}°`);
      const details = document.createElement('details'); details.className = 'disclosure';
      const title = document.createElement('summary'); title.textContent = 'Position and rotation'; details.append(title); group.append(details);
      for (const [label, value] of [['Before', oldItem], ['After', newItem]] as const) {
        if (!value) continue;
        const area = product?.regions.find(region => region.id === value.regionId);
        line(details, `${label}: centre ${value.pos.xMm}, ${value.pos.yMm} mm · Clockwise ${value.rotationDeg}°`);
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
  logoAdd.disabled = blocked || source === null;
  logoFile.disabled = blocked || source === null;
  productAdd.disabled = blocked;
  productFile.disabled = blocked;
  productName.disabled = blocked;
  for (const side of ['front', 'back', 'left', 'right'] as const) {
    productViewButton[side]!.disabled = blocked;
    productViewFile[side]!.disabled = blocked;
    productViewLabel[side]!.disabled = blocked;
  }
  newSourceButton.disabled = blocked || source === null;
  baselineChoose.disabled = blocked;
  baselineFile.disabled = blocked;
  generateButton.disabled = source === null || !selectionValid || blocked;
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
  for (const input of [customerName, jobRef, issuedBy, projectIdInput, formatSelf, formatHybrid]) input.disabled = blocked;
  for (const input of document.querySelectorAll<HTMLInputElement>('.rows input')) input.disabled = blocked;
  const hasReturn = lastReturn !== null && !blocked;
  candidateDownload.disabled = !hasReturn;
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

function createCheckRow(value: string, label: string): { row: HTMLLabelElement; box: HTMLInputElement } {
  const row = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = value;
  box.checked = true;
  const text = document.createElement('span');
  text.textContent = label;
  row.append(box, text);
  box.addEventListener('change', () => refreshSelectionValidation());
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
      if (kept !== null && !kept.products.includes(`\0${product.id}`)) box.checked = false;
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
          if (kept !== null && !kept.products.includes(`${product.id}\0${variantId}`)) variantRow.box.checked = false;
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
      if (kept !== null && kept.logos.includes(logoId)) box.checked = false;
      logoList.append(row);
    }
    for (const imported of logoImports) {
      const {row,box} = createCheckRow(imported.id, imported.name);
      if (kept?.logos.includes(imported.id)) box.checked = false;
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
      const {row,box} = createCheckRow(configurationId, label);
      if (kept && !kept.configurations.includes(configurationId)) box.checked = false;
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
  const knownConfigurations = new Set<string>(source?.summary.configurationIds ?? []);
  const knownSelected = allConfigurations.filter((id) => knownConfigurations.has(id));
  const totalConfigurations = source?.summary.configurationIds.length ?? 0;
  if (knownSelected.length !== totalConfigurations) selection.configurationIds = knownSelected;
  return selection;
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
    const configurationCount = selection.configurationIds ?? source.summary.configurationIds;
    const readable = `Selection valid: ${selection.productIds.length} products, ${selection.logoIds.length} logos, ${configurationCount.length} source configurations. Selected variants without defaults start empty in automatic mode.`;
    generateStatus.textContent = readable;
    generateStatus.hidden = true;
    selectionError.textContent = '';
    renderSelectionSummary();
  } else {
    selectionValid = false;
    const readable = `Selection invalid: ${outcome.errors.map((error) => error.message).join('; ')}`;
    generateStatus.textContent = readable;
    selectionError.textContent = 'Choose at least one product and an option for each selected product. Check any specific setups you selected.';
    renderSelectionSummary();
  }
  updateControls();
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
    source = { fileName: file.name, project: parsed.project, assets: parsed.assets, summary };
    renderSelectionLists(summary);
    projectIdSuggestion.textContent = `Source project ID “${summary.projectId}”. Enter a unique ID for this customer issue.`;
    clearGeneratedOutputs();
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
    const mergedPresentationInputs = [
      ...snapshot.assets,
      ...(sessionManifest ? [{ path: PRESENTATION_MANIFEST_PATH, bytes: sessionManifest, kind: 'additional' as const }] : []),
      ...addedPresentations.flatMap((entry) => entry.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes, kind: 'additional' as const }))),
    ];
    const presentationAssets = selectPresentationPackageAssets(mergedPresentationInputs, issued.project.configurations);
    const packageBytes = await createProjectPackage(
      { project: issued.project, assets: issuedAssets, additionalAssets: presentationAssets },
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
  return `${index + 1}. logo ${placement.logoId}, region ${placement.regionId}, ${placement.method}; centre (${placement.pos.xMm}, ${placement.pos.yMm}) mm; ${placement.widthMm} × ${placement.heightMm} mm; clockwise ${placement.rotationDeg}°${instruction}`;
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

function ensureOperationStyles(identity: Parameters<typeof operationDocumentStyles>[0]): void {
  const id = 'internal-builder-operation-styles';
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) { style = document.createElement('style'); style.id = id; document.head.append(style); }
  style.textContent = operationDocumentStyles(identity);
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
      candidateFileName: `${baseline.jobPart}-candidate-r${imported.revision}.json`,
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
    const doc = buildOperationDocument({
      candidate,
      generatedAt: reviewTimestamp,
      customerConfirmation: confirmationLine(imported, digest),
      internalReview: 'No current internal review. Returned review fields were discarded.',
    });
    ensureOperationStyles(doc.identity);
    operationContainer.append(renderOperationDocument(doc, document));
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
async function createFromCatalogue(): Promise<void> {
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
    source = { fileName: 'example-catalogue', project: checked.project, assets: checked.assets, summary };
    renderSelectionLists(summary);
    projectIdSuggestion.textContent = 'A fresh project ID was generated for this new draft. Enter a unique ID for this customer issue.';
    clearGeneratedOutputs();
    customerName.value = '';
    jobRef.value = '';
    issuedBy.value = '';
    formatSelf.checked = true; formatHybrid.checked = false;
    projectIdInput.value = newLocalId(); lastAutoProjectId = projectIdInput.value;
    logoStatus.textContent = '';
    createStatus.textContent = `Created a new draft with ${summary.products.length} example products. Example products — not for production.`;
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
    source = { fileName: snapshot.fileName, project: reparsed.project, assets: reparsed.assets, summary };
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

function onProductViewFileChange(side: ProductViewSide): void {
  const file = productViewFile[side]!.files?.[0];
  if (file) void stageProductViewFile(side, file);
  productViewFile[side]!.value = '';
}
sourceChoose.addEventListener('click', () => sourceFile.click());
sourceFile.addEventListener('change', onSourceFileChange);
startCreate.addEventListener('click', () => void createFromCatalogue());
logoAdd.addEventListener('click', () => logoFile.click());
logoFile.addEventListener('change', onLogoFileChange);
productAdd.addEventListener('click', () => void addProductFromStaged());
productFile.addEventListener('change', onProductFileChange);
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
