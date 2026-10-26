import {
  PRESENTATION_MANIFEST_PATH,
  PRESENTATION_MAX_MODEL_BYTES,
  parsePresentationManifest,
  selectPresentationPackageAssets,
} from '../customer-editor/presentation-assets.js';
/* Flexible named-view contracts (intake-UX workstream, provisional): the
 * station intake emits stable slug view ids; the sibling-owned core reader
 * below is the authority for parsing them. The legacy customer-editor
 * reader stays for the workspace paths until the lead wires the swap. */
import {
  PRESENTATION_VIEW_LIMITS,
  isLegacyViewId,
  parsePresentationManifest as parseFlexiblePresentationManifest,
} from '../../core/presentation-views/index.js';
import { selectPresentationModel, selectPresentationViews } from '../customer-editor/presentation-assets.js';
import {
  PHOTO_MAPPINGS_PATH,
  mappingViewIdOf,
  parsePhotoMappings,
  serializePhotoMappings,
  similarityTransformFromSpan,
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
  canonicalize,
  newRevision,
  validateProject,
} from '../../core/index.js';
import type {
  Placement,
  ProjectDocument,
  ResultCandidate,
} from '../../core/index.js';
import { assertProjectEditorLimits } from '../../core/project-editor/index.js';
import { displayVariantName } from '../../core/operation-document/index.js';
import type { ReferenceViewInput } from '../../core/operation-document/types.js';
import type { OperationSheetView } from '../../core/operation-document/types.js';
import {
  bytesToDataUrl,
  selectOperationReferenceViews,
} from '../shared/operation-document/index.js';
import type {
  AnchorDef,
} from '../../core/operation-measurements/types.js';
import { validateSafeAreaPolygon } from './anchor-setup.js';
import { createProductSetupView, validateAnchors, isSiblingRegionId, areaIdFromSiblingRegionId, siblingRegionIdFor, scopeOwnerOf, referencedRegionIds, retireDeletedRegions, parseActiveAreasFile, serializeActiveAreasFile, unseenSiblingIds, scopeViewId, scopeViewLabel, SCOPE_SAVED_AREA_ID, SIBLING_REGION_SEPARATOR } from './product-setup-view.js';
import type {
  ProductSetupCallbacks,
  ProductSetupPhotoView,
  ProductSetupReferenceSpan,
  ProductSetupScope,
  ProductSetupSide,
  ProductSetupWorkspaceInput,
  ProductSetupWorkspaceInputV2,
  ProductSetupResult,
} from './product-setup-view.js';
import { createGuidedScale, guidedCorrespondences, validateImageSpan } from './guided-scale.js';
import type { GuidedScaleCommit, GuidedScaleRequest, GuidedScaleSpanCommit } from './guided-scale.js';
import { createModelSetupView, projectAreaToMm } from './model-setup-view.js';
import type {
  ModelSetupInput,
  ModelSetupSnapshot,
  ModelSetupViewHandle,
  ModelSetupViewerLike,
} from './model-setup-view.js';
import type { ModelViewer as ModelViewerType } from '../../viewer/model-viewer.js';
import {
  parseSetupCalibration,
  serializeSetupCalibration,
  spanNativeDistance,
  validateReferenceSpan,
} from '../../core/setup-calibration/index.js';
import type { ReferenceSpan, SetupCalibrationBundle } from '../../core/setup-calibration/index.js';
import {
  createProjectPackage,
  PROJECT_PACKAGE_LIMITS,
  parseProjectPackage,
} from '../../packaging/project-package/index.js';
import type { ProjectPackageAsset } from '../../packaging/project-package/index.js';
import {
  decodeEmbeddedProjectBase64,
} from '../../packaging/self-contained-html/index.js';
import { MAX_PREVIEW_BYTES, readRasterHeader } from '../../assets/raster-header.js';
import { parseGlb } from '../../assets/glb.js';
import { validateSelfContained } from '../../assets/validate.js';
import { createProvisionalProduct } from '../../core/project-builder/provisional-product.js';
import { planPhotoIntake, renameIntakeViewLabel } from '../../core/photo-intake/index.js';
import type { DraftRetirementEvent } from '../../core/workspace-drafts/types.js';
import { createWebCryptoProjectHasher } from '../shared/browser-hasher.js';
import { mountPlacementWorkspace } from './placement-workspace.js';
import type {
  PlacementStageOverlay,
  PlacementWorkspaceHandle,
} from './placement-workspace.js';
import {
  mountDocumentReview,
} from './document-review.js';
import type {
  DocumentReviewHandle,
  ReviewFixTarget,
  ReviewUnappliedEdit,
} from './document-review.js';
import { mountCustomerApproval } from './customer-approval.js';
import type { CustomerApprovalHandle } from './customer-approval.js';
import {
  decodeJobSidecar,
  encodeJobSidecar,
  OPERATOR_JOB_SIDECAR_PATH,
} from '../../core/operator-job/index.js';
import type {
  OperatorJobMetadata,
} from '../../core/operator-job/index.js';
import {
  applySessionAuthoring,
  captureSaveSnapshot,
  cleanSession,
  createEmptySession,
  emptyLogoTechnique,
  emptyRecord,
  emptySelection,
  isSameSaveSession,
  rebaseSessionAuthoring,
  replaceSessionProject,
  sessionAuthoringFromMetadata,
  sessionDocumentInputs,
  snapshotSessionMetadata,
  touchSession,
} from './job-session.js';
import type { JobSession } from './job-session.js';
import { createOperatorAuthoringContext } from '../../core/operator-authoring/index.js';

/** Live logo import staging (the retained intake path); the issued/return
 * snapshot shells are deleted with the legacy desk below. */
interface ImportedLogo {
  id: string;
  name: string;
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  widthPx: number;
  heightPx: number;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing internal builder element: ${selector}`);
  return element;
}

const hook = <T extends Element>(name: string): T =>
  required<T>(`[data-builder-hook="${name}"]`);


const sourceStatus = hook<HTMLElement>('source-status');
const createStatus = hook<HTMLElement>('create-status');
const logoAdd = hook<HTMLButtonElement>('logo-add');
const logoFile = hook<HTMLInputElement>('logo-file');
const logoStatus = hook<HTMLElement>('logo-status');
const productName = hook<HTMLInputElement>('product-name');
const productAdd = hook<HTMLButtonElement>('product-add');
const productChoose = hook<HTMLButtonElement>('product-choose');
const productFile = hook<HTMLInputElement>('product-file');
const productStatus = hook<HTMLElement>('product-status');
/* Station intake mode toggle + dynamic view rows (intake UX, Worker 2). */
const intakeModeImages = hook<HTMLInputElement>('intake-mode-images');
const intakeModeModel = hook<HTMLInputElement>('intake-mode-model');
const intakeImagesPanel = hook<HTMLElement>('intake-images-panel');
const intakeModelPanel = hook<HTMLElement>('intake-model-panel');
const intakeModelStatus = hook<HTMLElement>('intake-model-status');
const productViewRows = hook<HTMLElement>('product-view-rows');
const productViewAdd = hook<HTMLButtonElement>('product-view-add');
/* In-place view images on existing Images products (named rows, Worker 2). */
const productPhotoDisclosure = hook<HTMLDetailsElement>('product-photo-disclosure');
const productPhotoContext = hook<HTMLElement>('product-photo-context');
const productPhotoRows = hook<HTMLElement>('product-photo-rows');
const productPhotoScope = hook<HTMLSelectElement>('product-photo-scope');
const productPhotoNewLabel = hook<HTMLInputElement>('product-photo-new-label');
const productPhotoAddChoose = hook<HTMLButtonElement>('product-photo-add-choose');
const productPhotoAddFile = hook<HTMLInputElement>('product-photo-add-file');
const productPhotoStatus = hook<HTMLElement>('product-photo-status');
const saveMaster = hook<HTMLButtonElement>('save-master');
const masterStatus = hook<HTMLElement>('master-status');
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
const generateStatus = hook<HTMLElement>('generate-status');
type JobStep = 'landing' | 'prepare' | 'placements' | 'review' | 'approval';
/** Operator job shell step. Landing shows when no job is open; approval is a
 * branch subview of placements, never a fourth required top-level step. */
let jobStep: JobStep = 'landing';
/** Previous non-landing step (for approval Back routing). */
let jobReturnStep: Exclude<JobStep, 'landing' | 'approval'> = 'prepare';
let lastAutoProjectId = '';
let placementHandle: PlacementWorkspaceHandle | null = null;
let reviewHandle: DocumentReviewHandle | null = null;
let approvalHandle: CustomerApprovalHandle | null = null;
const jobSave = hook<HTMLButtonElement>('job-save');
const jobOpen = hook<HTMLButtonElement>('job-open');
const jobOpenFile = hook<HTMLInputElement>('job-open-file');
const jobNew = hook<HTMLButtonElement>('job-new');
const jobResponse = hook<HTMLButtonElement>('job-response');
const jobPersistence = hook<HTMLElement>('job-persistence');
const jobShell = document.querySelector<HTMLElement>('[data-job-shell]');
const jobLanding = document.querySelector<HTMLElement>('[data-job-landing]');
const jobLandingCreate = hook<HTMLButtonElement>('job-landing-create');
const jobLandingOpen = hook<HTMLButtonElement>('job-landing-open');
const jobLandingResponse = hook<HTMLButtonElement>('job-landing-response');
const jobLandingStatus = hook<HTMLElement>('job-landing-status');
const jobStep1 = hook<HTMLButtonElement>('job-step-1');
const jobStep2 = hook<HTMLButtonElement>('job-step-2');
const jobStep3 = hook<HTMLButtonElement>('job-step-3');
const jobToPlacements = hook<HTMLButtonElement>('job-to-placements');
const jobPrepareGate = hook<HTMLElement>('job-prepare-gate');
const jobPlacementHost = hook<HTMLElement>('job-placement-host');
const jobReviewHost = hook<HTMLElement>('job-review-host');
const jobApprovalHost = hook<HTMLElement>('job-approval-host');
const projectIdNew = hook<HTMLButtonElement>('project-id-new');
const selectionSummary = hook<HTMLElement>('selection-summary');
const selectionError = hook<HTMLElement>('selection-error');
const builderAlert = hook<HTMLElement>('builder-alert');
/* In-station review decision (check step): same rules as the full reviewer. */
/* In-station revised proposal (check step): office corrections via newRevision. */
/* Operation-sheet authoring hooks (review/prepare flow, check step). */
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
const modelSetupBox = hook<HTMLElement>('model-setup');
const modelSetupSave = hook<HTMLButtonElement>('model-setup-save');
const modelSetupProductsToggle = hook<HTMLInputElement>('model-setup-products-toggle');
const modelSetupStatus = hook<HTMLElement>('model-setup-status');
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
/** Operator job-shell navigation (spec section 2): ONE three-step flow.
 * Labels exactly: 1 Prepare job → 2 Set logo placements → 3 Review document.
 * Back/step tabs preserve state and never generate files or reset a project.
 * Forward tabs enforce the same gates as primary actions and focus the first
 * specific unresolved field. */
function paintJobNav(): void {
  paintJobNavStateOnly();
  if (jobLanding) jobLanding.hidden = jobStep !== 'landing';
  if (jobShell) jobShell.hidden = jobStep === 'landing';
  for (const section of document.querySelectorAll<HTMLElement>('[data-job-step]')) {
    const name = section.getAttribute('data-job-step');
    section.hidden = jobStep !== name;
  }
  for (const branch of document.querySelectorAll<HTMLElement>('[data-job-branch]')) {
    branch.hidden = jobStep !== 'approval';
  }
  // The retained prepare mode-panel (identity inputs) and the choose setup
  // subview live inside Step 1; everything else renders through the job shell.
  for (const panel of document.querySelectorAll<HTMLElement>('[data-builder-mode-panel]')) {
    panel.hidden = true;
  }
  const chooseSection = document.querySelector<HTMLElement>('[data-builder-step="choose"]');
  if (chooseSection) chooseSection.hidden = jobStep !== 'prepare';
  updateControls();
}
/** Step 2 selection default (product/option). */
function defaultPlacementSelection(): void {
  if (!source || source.selection.productId !== '') return;
  try {
    const configs = scopedConfigurationIds(readSelection());
    const first = configs.map((id) => source!.project.configurations.find((entry) => entry.id === id)).find((entry) => entry !== undefined);
    if (first) {
      source.selection = { ...source.selection, productId: first.productId, variantId: first.variantId };
      return;
    }
  } catch { /* fall through to catalogue default */ }
  const product = source.project.products[0];
  if (product) source.selection = { ...source.selection, productId: product.id, variantId: product.variants[0]?.id ?? '' };
}
function setJobStep(next: JobStep): void {
  if (next !== 'landing' && next !== 'approval' && source === null) next = 'landing';
  if (next !== 'approval' && next !== 'landing') jobReturnStep = next;
  jobStep = next;
  paintJobNav();
  if (next === 'approval') {
    // The Advanced issue-ID field shows the pending auto ID: seed it from
    // the auto project ID when the operator has not typed one. Programmatic
    // syncing never marks a manual override.
    try {
      if (jobIssueProjectId.value === '') jobIssueProjectId.value = projectIdInput.value;
    } catch { /* branch input not mounted yet; create-time mint covers it */ }
  }
  if (next === 'placements') {
    // Single-product/single-option jobs never render dropdowns: default the
    // selection so the rail is usable immediately (still explicit and visible).
    defaultPlacementSelection();
    if (placementHandle) placementHandle.update();
  }
  if (next === 'review') {
    // The sync candidate export needs a prepared digest for the exact scoped
    // text it reads: prepare it, then re-render (the first render reports
    // honestly if the digest is not ready yet; navigation never blocks).
    if (source) {
      const scoped = scopedJobProject() ?? source.project;
      void hasher.prepareProject(scoped).then(() => { if (jobStep === 'review' && reviewHandle) reviewHandle.update(); }).catch(() => {});
    }
    if (reviewHandle) reviewHandle.update();
  }
  if (next === 'approval' && approvalHandle) approvalHandle.update();
}
function jobPrepareGateMessage(): string {
  if (source === null) return 'Create a job or open a saved job to begin.';
  if (!selectionValid) return 'Include at least one product to continue.';
  return '';
}
/** Step 1 → Step 2 gate: at least one included product + structurally valid
 * job. Calibration incompleteness surfaces on Step 2, never traps here. */
function canEnterPlacements(): boolean {
  if (source === null || !selectionValid) return false;
  return validateProject(source.project).ok;
}
function goNext(): void {
  if (loading || creating || logoImporting || productImporting || photoAttaching) return;
  if (jobStep === 'prepare') {
    if (!canEnterPlacements()) {
      jobPrepareGate.textContent = jobPrepareGateMessage() || 'Resolve the highlighted product setup before continuing.';
      const target = document.querySelector<HTMLElement>('[data-job-step="prepare"] input, [data-job-step="prepare"] button.btn-primary');
      if (target instanceof HTMLElement) target.focus();
      updateControls();
      return;
    }
    setJobStep('placements');
  } else if (jobStep === 'placements') {
    setJobStep('review');
  } else if (jobStep === 'approval') {
    setJobStep(jobReturnStep);
  }
}
function goBack(): void {
  if (loading || creating || logoImporting || productImporting || photoAttaching) return;
  if (jobStep === 'placements' || jobStep === 'review') setJobStep('prepare');
  else if (jobStep === 'approval') setJobStep(jobReturnStep);
}
function renderSelectionSummary(): void {
  selectionSummary.replaceChildren();
  if (source === null) {
    selectionSummary.textContent = 'No project loaded yet.';
    return;
  }
  const selection = readSelection();
  let optionCount = 0;
  for (const product of source.project.products) {
    if (!selection.productIds.includes(product.id)) continue;
    optionCount += selection.variantIdsByProduct?.[product.id]?.length ?? product.variants.length;
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
const hasher = createWebCryptoProjectHasher();

/** Single live job session: the one authoritative editable project/assets plus
 * operator authoring, selection and dirty state. Derived artefacts (persisted
 * metadata, document inputs) rebuild from these fields; the decode result on
 * open is a transfer object, never a second store. */
let source: JobSession | null = null;
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
let loading = false;
let creating = false;
let createGeneration = 0;
let logoImporting = false;
let logoGeneration = 0;
let logoCounter = 0;
let sourceSession = 0;
/**
 * Scoped-draft retirement log for the workspace view (Tranche C). Events
 * accumulate within one source session and reset on source replacement;
 * the view applies them idempotently on every refresh, so switching
 * product/variant/side never drops same-session drafts while replaced
 * photos and invalidated bindings retire precisely.
 */
let draftRetirements: DraftRetirementEvent[] = [];
/**
 * Committed named-area sibling lists per scope region id (canonical JSON of
 * sorted [{id, name, points}]). The stale-list guard in `saveWorkspaceSetup`
 * compares live siblings against this baseline: another scope saving first
 * moves live away from baseline, and a stale submitter is refused instead of
 * silently reverting it. Reset on every source replacement; seeded lazily on
 * first sibling save (and by span commits, which own their scope region).
 */
const areaManifestBaseline = new Map<string, string>();
let logoImports: ImportedLogo[] = [];
interface PendingProductView { bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; extension: string; widthPx: number; heightPx: number; fileName: string; }
interface PendingProductModel { bytes: Uint8Array; fileName: string; }
/**
 * Station intake staging (Worker 2): the Images path stages a DYNAMIC list
 * of named view rows. Each row carries a stable local slug id (`view-N`,
 * generated locally per draft — never the mutable human label) plus the
 * decoded file bytes. Row count is unbounded (no 4-slot cap); labels are
 * free text defaulted to "View N" when blank. The 3D path stages a single
 * GLB. Mode state governs which path stages; switching modes asks before
 * clearing the other path (no silent data loss).
 */
type IntakeMode = 'images' | 'model';
interface StagedIntakeView {
  id: string;
  label: string;
  staged: PendingProductView | null;
}
let intakeMode: IntakeMode = 'images';
let stagedIntakeViews: StagedIntakeView[] = [];
/**
 * Monotonic slug counter for the whole draft (intake rows AND in-place
 * view adds share it, so ids stay unique per product scope without reuse).
 */
let stagedIntakeViewSeq = 0;
let pendingPrimaryModel: PendingProductModel | null = null;
/** Object URLs minted for intake thumbnails, revoked on re-render/removal. */
const intakeThumbUrls = new Map<string, string>();
let productImporting = false;
let photoAttaching = false;
let productGeneration = 0;
let productCounter = 0;
interface AddedProductPresentation { views: Array<{ view: string; image: string; label?: string }>; models: Array<{ model: string; label?: string }>; assets: Array<{ path: string; bytes: Uint8Array }>; }
let addedPresentations: AddedProductPresentation[] = [];

function invalidateOutputsForEdit(): void {
  // Editing invalidates the approval branch context (the branch rebuilds
  // from the live job on re-entry); navigation alone changes nothing.
  if (jobStep === 'approval') setJobStep(jobReturnStep);
  updateControls();
}

function updateControls(): void {
  const blocked = loading || creating || logoImporting || productImporting || photoAttaching;
  logoAdd.disabled = blocked || source === null;
  logoFile.disabled = blocked || source === null;
  productAdd.disabled = blocked || !intakeActionable();
  productChoose.disabled = blocked;
  productFile.disabled = blocked;
  productName.disabled = blocked;
  intakeModeImages.disabled = blocked;
  intakeModeModel.disabled = blocked;
  productViewAdd.disabled = blocked || source === null ||
    stagedIntakeViews.length >= PRESENTATION_VIEW_LIMITS.maxViewsPerScope;
  for (const control of productViewRows.querySelectorAll('input,button')) {
    (control as HTMLInputElement | HTMLButtonElement).disabled = blocked || source === null;
  }
  const photoBlocked = blocked || source === null;
  productPhotoScope.disabled = photoBlocked;
  productPhotoNewLabel.disabled = photoBlocked;
  productPhotoAddChoose.disabled = photoBlocked;
  productPhotoAddFile.disabled = photoBlocked;
  for (const control of productPhotoRows.querySelectorAll('input,button')) {
    (control as HTMLInputElement | HTMLButtonElement).disabled = photoBlocked;
  }
  jobOpenFile.disabled = blocked;
  modelSetupSave.disabled = blocked || source === null;
  modelSetupProductsToggle.disabled = blocked;
  saveMaster.disabled = blocked || source === null;
  projectIdUseSource.disabled = source === null || blocked;
  projectIdNew.disabled = blocked;
  for (const input of [customerName, jobRef, issuedBy, projectIdInput, formatSelf, formatHybrid]) input.disabled = blocked;
  const prepOff = prepareBlocked();
  for (const input of [workspaceProduct, workspaceVariant]) input.disabled = prepOff || source === null;
  for (const input of document.querySelectorAll<HTMLInputElement>('.rows input')) input.disabled = blocked;
  // Operator job shell: header/landing/step gating (exact spec labels).
  const dirty = source?.dirty ?? false;
  jobPersistence.textContent = dirty
    ? 'Changes are held in this browser. Save job to keep them.'
    : (lastJobSaved
      ? 'Job file download started. Keep the downloaded file to reopen this job.'
      : '');
  const gateMessage = jobPrepareGateMessage();
  jobPrepareGate.textContent = gateMessage;
  jobToPlacements.disabled = blocked || !canEnterPlacements();
  jobStep1.disabled = blocked || source === null;
  jobStep2.disabled = blocked || !canEnterPlacements();
  jobStep3.disabled = blocked || source === null;
  jobSave.disabled = blocked || source === null;
  jobOpen.disabled = blocked;
  jobOpenFile.disabled = blocked;
  jobNew.disabled = blocked;
  jobResponse.disabled = blocked;
  jobLandingCreate.disabled = blocked;
  jobLandingOpen.disabled = blocked;
  jobLandingResponse.disabled = blocked;
  jobLandingStatus.textContent = source === null ? '' : `Job open: ${source.fileName}.`;
  paintJobNavStateOnly();
}
function paintJobNavStateOnly(): void {
  const steps: Array<[HTMLButtonElement, boolean]> = [
    [jobStep1, jobStep === 'prepare'],
    [jobStep2, jobStep === 'placements' || jobStep === 'approval'],
    [jobStep3, jobStep === 'review'],
  ];
  for (const [button, active] of steps) {
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
}

/* ------------------------------------------------------------------ */
/* Operator job shell: dirty tracking, persistence, authoring context, */
/* placement/review/approval mounts (spec sections 2, 6, 7, 8).       */
/* ------------------------------------------------------------------ */

/** Whether the operator deliberately typed the branch issue ID (manual
 * override). Auto-minted and untouched IDs are never manual: only a
 * deliberate retype under changed content triggers the More-options refusal;
 * everything else auto-allocates a fresh unique issue ID on Create. */
let issueIdManual = false;
/** A Save download has started at least once for the current dirty cycle. */
let lastJobSaved = false;
/** Suppress dirty-marking while installing/loading (programmatic churn). */
let suppressJobDirty = false;
/** Generation guards for async save/open so stale reads never swap live state. */
let jobSaveGeneration = 0;
let jobLoadGeneration = 0;
/** Fire-and-forget digest preparation so the sync candidate export can read
 * the current job text. Called after every job mutation and before review.
 * Both the full job text (Save job) and the scoped inclusion text (Review
 * document) are prepared, since they hash different canonical texts. */
function reprepareJobDigest(): void {
  const snapshot = source;
  if (!snapshot) return;
  void hasher.prepareProject(snapshot.project).catch(() => { /* digest stays unprepared; snapshots report it */ });
  try {
    const scoped = scopedJobProject();
    if (scoped) void hasher.prepareProject(scoped).catch(() => {});
  } catch { /* scoping is best-effort; the snapshot reports */ }
}
/** Guard UI state for unsaved-file replacement prompts. */
let pendingReplaceAction: (() => void) | null = null;

function markJobDirty(): void {
  if (suppressJobDirty || source === null) return;
  touchSession(source);
  lastJobSaved = false;
  if (approvalHandle) approvalHandle.notifyJobChanged();
  updateControls();
}
function clearJobDirtyState(saved: boolean): void {
  if (source) cleanSession(source);
  lastJobSaved = saved;
  pendingReplaceAction = null;
  updateControls();
}
/** Inline replacement guard: Save job / Discard changes / Keep editing. */
function guardUnsavedReplace(action: () => void): void {
  if (source === null || !source.dirty) { action(); return; }
  pendingReplaceAction = action;
  alertBuilder('');
  builderAlert.replaceChildren();
  const line = document.createElement('p');
  line.textContent = 'This job has unsaved changes. Save the job first, discard the changes, or keep editing.';
  const row = document.createElement('div');
  row.className = 'actions';
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'btn-secondary'; save.textContent = 'Save job';
  save.addEventListener('click', () => {
    // Capture the continuation synchronously: the async save clears the
    // guard state on success, and only a clean save (no newer edits) may
    // replace the job — a stale save keeps the guard open for an explicit
    // Discard or Keep editing choice.
    const run = pendingReplaceAction;
    void saveJobToFile().then((saved) => {
      if (saved === 'clean') {
        alertBuilder();
        run?.();
      }
    });
  });
  const discard = document.createElement('button');
  discard.type = 'button'; discard.className = 'btn-secondary'; discard.textContent = 'Discard changes';
  discard.addEventListener('click', () => {
    const run = pendingReplaceAction;
    clearJobDirtyState(false);
    run?.();
  });
  const keep = document.createElement('button');
  keep.type = 'button'; keep.className = 'btn-link'; keep.textContent = 'Keep editing';
  keep.addEventListener('click', () => { pendingReplaceAction = null; alertBuilder(); if (reviewHandle) reviewHandle.update(); });
  row.append(save, discard, keep);
  builderAlert.append(line, row);
  builderAlert.hidden = false;
  save.focus();
}
function requestNewJob(): void {
  if (loading || creating || logoImporting || productImporting || photoAttaching) return;
  guardUnsavedReplace(() => void createEmptyProject());
}
function onJobOpenFileChange(): void {
  const file = jobOpenFile.files?.[0];
  jobOpenFile.value = '';
  if (!file) return;
  guardUnsavedReplace(() => void loadJobFile(file));
}
/** Creating/opening/installing a session is the authoring reset: the fresh
 * session carries empty authoring, selection and clean state. */
function resetSessionForInstall(): void {
  issueIdManual = false;
  pendingReplaceAction = null;
}
/** Mint a fresh unique issue ID (auto-identity): updates the Advanced issue
 * input and the legacy project-id input together. Never called per keystroke. */
function mintFreshIssueId(): string {
  const fresh = newLocalId();
  jobIssueProjectId.value = fresh;
  projectIdInput.value = fresh;
  lastAutoProjectId = fresh;
  issueIdManual = false;
  markJobDirty();
  return fresh;
}
function currentInclusion(): { includedProducts: string[]; includedConfigurations: string[]; logoIds: string[] } {
  try {
    const selection = readSelection();
    return { includedProducts: [...selection.productIds], includedConfigurations: scopedConfigurationIds(selection), logoIds: [...selection.logoIds] };
  } catch { return { includedProducts: [], includedConfigurations: [], logoIds: [] }; }
}
  /** Save the editable job: exact geometry + original assets + presentation /
  * calibration sidecars + selection + identity + operation-authoring metadata.
  * One .logo-project download; browser cannot verify the disk write.
  * Returns 'clean' when the download matches the live job, 'stale' when newer
  * edits arrived during the async save (download holds the snapshot, dirty
  * state retained), or null when nothing was saved. Pending Step 2 edits
  * never leak into the file silently: the operator applies, discards, or
  * keeps editing. */
async function saveJobToFile(): Promise<'clean' | 'stale' | null> {
  if (source === null || loading || creating || logoImporting || productImporting || photoAttaching) return null;
  if (placementHandle?.hasPendingEdits() === true) {
    offerPendingEditsGuard(() => void saveJobToFile());
    return null;
  }
  if (source.project.products.length === 0) {
    alertBuilder('Add a product before saving this job.');
    productName.focus();
    return null;
  }
  alertBuilder();
  // Freeze the save snapshot BEFORE the first await: the exact session
  // identity, an exact project copy, the asset lists and the edit counter.
  // A slower save overtaken by an open/install/commit packages only this
  // snapshot and can never mix project A with assets from B or clear B's
  // dirty state when counters coincide.
  const snap = captureSaveSnapshot(source);
  const generation = ++jobSaveGeneration;
  try {
    const project = snap.project;
    // Logos are already materialized in the live job at import time (one
    // revision each): nothing is appended here, so save can never duplicate.
    const validation = validateProject(project);
    if (!validation.ok) {
      alertBuilder(`Job is not valid and was not saved: ${validation.errors.map((error) => error.message).join('; ')}`);
      return null;
    }
    // Persisted metadata derives from the canonical frozen fields: identity
    // from the Step 1 inputs, inclusion from the checkboxes, everything else
    // from the snapshot session. The digest binds to the exact packaged project below.
    const metadata = snapshotSessionMetadata(
      snap.session,
      {
        ...(customerName.value.trim() ? { customer: customerName.value.trim() } : {}),
        ...(jobRef.value.trim() ? { jobReference: jobRef.value.trim() } : {}),
        ...(issuedBy.value.trim() ? { preparedBy: issuedBy.value.trim() } : {}),
      },
      currentInclusion(),
    );
    metadata.sourceDigest = await hasher.prepareProject(project);
    if (!isSameSaveSession(source, snap) || generation !== jobSaveGeneration) return null;
    const sidecarBytes = encodeJobSidecar(metadata);
    const referenced = snap.assets.filter((asset) => asset.kind === 'referenced').map((asset) => ({ path: asset.path, bytes: asset.bytes }));
    const additional = [
      ...snap.assets.filter((asset) => asset.kind === 'additional' && asset.path !== OPERATOR_JOB_SIDECAR_PATH).map((asset) => ({ path: asset.path, bytes: asset.bytes })),
      { path: OPERATOR_JOB_SIDECAR_PATH, bytes: sidecarBytes },
    ];
    const packageBytes = await createProjectPackage({ project, assets: referenced, additionalAssets: additional }, { sha256: hasher.sha256Bytes });
    if (!isSameSaveSession(source, snap) || generation !== jobSaveGeneration) return null;
    const safeCustomer = (customerName.value.trim() || 'job').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'job';
    downloadBytes(packageBytes, `${safeCustomer}-job.logo-project`, 'application/zip');
    if (snap.session.editCounter === snap.editCounter) {
      // No newer edits arrived while saving: the file matches the live job.
      clearJobDirtyState(true);
      updateControls();
      return 'clean';
    }
    // Newer edits arrived during the async save: the download holds the
    // snapshot, so keep the dirty state (never clear newer edits).
    lastJobSaved = true;
    updateControls();
    return 'stale';
  } catch (error) {
    alertBuilder(`Could not save the job: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
/** Pending-edits guard: Apply / Discard / Keep editing. Apply commits every
 * staged Step 2 edit (validated one by one); Discard clears them; Keep
 * editing returns without touching anything. */
function offerPendingEditsGuard(after: () => void): void {
  alertBuilder('');
  builderAlert.replaceChildren();
  const line = document.createElement('p');
  line.textContent = 'There are unapplied placement edits. They are not part of the saved job until applied.';
  const row = document.createElement('div');
  row.className = 'actions';
  const apply = document.createElement('button');
  apply.type = 'button'; apply.className = 'btn-secondary'; apply.textContent = 'Apply pending edits';
  apply.addEventListener('click', () => {
    const result = placementHandle?.applyPendingEdits() ?? { applied: 0, blocked: 0 };
    alertBuilder();
    if (result.blocked > 0) {
      setJobStep('placements');
      alertBuilder(`Applied ${result.applied}; ${result.blocked} could not be applied. Resolve the highlighted edits first.`);
      return;
    }
    alertBuilder(`Applied ${result.applied} pending edit(s).`);
    after();
  });
  const discard = document.createElement('button');
  discard.type = 'button'; discard.className = 'btn-secondary'; discard.textContent = 'Discard pending edits';
  discard.addEventListener('click', () => {
    const count = placementHandle?.discardPendingEdits() ?? 0;
    alertBuilder(`Discarded ${count} pending edit(s). Nothing was committed.`);
    after();
  });
  const keep = document.createElement('button');
  keep.type = 'button'; keep.className = 'btn-link'; keep.textContent = 'Keep editing';
  keep.addEventListener('click', () => { alertBuilder(); if (reviewHandle) reviewHandle.update(); });
  row.append(apply, discard, keep);
  builderAlert.append(line, row);
  builderAlert.hidden = false;
  apply.focus();
}
/** Open a saved job: restore geometry, assets, identity, selection and
 * staff operation-authoring metadata. Legacy files without the sidecar open
 * with empty metadata (never invented measurements). The whole next session
 * validates offscreen first; failed or stale reads leave the old job and its
 * outputs completely unchanged (atomic swap with a rollback snapshot). */
async function loadJobFile(file: File): Promise<void> {
  alertBuilder();
  const generation = ++jobLoadGeneration;
  const wasBusy = loading;
  loading = true;
  updateControls();
  // Rollback: the install below writes only to the new session object (and
  // staging/DOM it owns after the swap), so holding the previous session
  // reference restores the job and its outputs on failure.
  const rollback = source === null ? null : {
    session: source,
    customer: customerName.value, reference: jobRef.value, preparedBy: issuedBy.value,
    saved: lastJobSaved,
  };
  try {
    if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) throw new Error('archive size exceeds limit; rejected before reading');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (generation !== jobLoadGeneration) return;
    const parsed = await parseProjectPackage(bytes, { sha256: hasher.sha256Bytes });
    if (generation !== jobLoadGeneration) return;
    assertProjectEditorLimits(parsed.project);
    const summary = summarizeSourceProject(parsed.project);
    // Validate the versioned job sidecar BEFORE touching live state.
    const sidecarBytes = parsed.assets.find((asset) => asset.path === OPERATOR_JOB_SIDECAR_PATH)?.bytes;
    const restored = sidecarBytes ? decodeJobSidecar(sidecarBytes) : null;
    // Remaining async work happens offscreen: the anchors sidecar load only
    // reports status text here (the versioned job sidecar is the anchor
    // source on open; legacy files open with empty authoring), and the
    // authoring decode is a pure transfer-object expansion.
    const anchors = await loadAnchorsSidecar(parsed.assets, parsed.project);
    const authoring = restored ? sessionAuthoringFromMetadata(parsed.project, restored) : null;
    // Stale reads return here without touching the live session, staging or
    // DOM: the whole next session was prepared offscreen.
    if (generation !== jobLoadGeneration) return;
    // ONE synchronous install below; every failure path above leaves the
    // previous job untouched (the catch restores the held reference).
    suppressJobDirty = true;
    sourceSession += 1;
    draftRetirements = [];
    logoImports = [];
    staffModelSnapshots.clear();
    areaManifestBaseline.clear();
    logoStatus.textContent = '';
    resetIntakeStaging();
    addedPresentations = [];
    productName.value = '';
    source = createEmptySession(file.name, parsed.project, parsed.assets, bytes.slice());
    configurationsTouched = false;
    renderSelectionLists(source.summary);
    stagedPhotoMappings = [];
    source.anchors = anchors;
    guidedScale.hide();
    refreshWorkspace();
    refreshAddProductDisclosure();
    refreshIntakeReadiness();
    projectIdSuggestion.textContent = `Source project ID “${summary.projectId}”. Enter a unique ID for this customer issue.`;
    // Restore the versioned job sidecar (legacy files: empty authoring and
    // blank identity — never silently inherit the previous job's identity).
    // The decode result is a transfer object: expand it into the session,
    // never a second store.
    if (restored && authoring) {
      applySessionAuthoring(source, authoring);
      customerName.value = restored.identity.customer ?? '';
      jobRef.value = restored.identity.jobReference ?? '';
      issuedBy.value = restored.identity.preparedBy ?? '';
      restoreJobInclusion(restored);
    } else {
      customerName.value = '';
      jobRef.value = '';
      issuedBy.value = '';
    }
    ensureAutoProjectId();
    refreshSelectionValidation();
    reprepareJobDigest();
    jobLandingStatus.textContent = '';
    sourceStatus.textContent = `Loaded ${file.name} (revision ${summary.revision}): ${summary.productIds.length} products, ${summary.logoIds.length} logos, ${summary.configurationIds.length} setups, ${summary.assetPaths.length} artwork files.`;
    setJobStep('prepare');
    clearJobDirtyState(false);
  } catch (error) {
    // Atomic failure: restore the previous live session and its outputs.
    if (rollback !== null && generation === jobLoadGeneration) {
      source = rollback.session;
      customerName.value = rollback.customer;
      jobRef.value = rollback.reference;
      issuedBy.value = rollback.preparedBy;
      lastJobSaved = rollback.saved;
      refreshWorkspace();
      updateControls();
    }
    if (generation === jobLoadGeneration) {
      alertBuilder(`Could not open ${file.name}. Choose a valid job file. Your previous job is still available.`);
      sourceStatus.textContent = `Could not load ${file.name}: invalid source: ${error instanceof Error ? error.message : String(error)}. The previous source remains unchanged.`;
    }
  } finally {
    suppressJobDirty = false;
    if (generation === jobLoadGeneration) { loading = wasBusy; updateControls(); }
  }
}
function restoreJobInclusion(metadata: OperatorJobMetadata): void {
  const products = new Set(metadata.inclusion.includedProducts);
  const configs = new Set(metadata.inclusion.includedConfigurations);
  // Top-level product include boxes carry no data-product attribute;
  // variant boxes carry their product id. Both restore from the inclusion.
  for (const box of productList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    const owner = box.getAttribute('data-product');
    if (owner === null) {
      box.checked = products.has(box.value);
    } else if (owner !== '' && box.value !== '') {
      box.checked = products.has(`${owner}\0${box.value}`) || products.has(box.value);
    }
  }
  for (const box of configurationList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    box.checked = configs.has(box.value);
  }
  // Logo selection restores exactly the saved set (including selected but
  // unused logos). Sidecars predating persisted logo selection fall back to
  // the logos used by the included configurations. Placements referencing
  // excluded logos stay visible and resolvable: exclusion never deletes
  // authored geometry.
  const usedLogos = new Set<string>();
  if (source) {
    for (const config of source.project.configurations) {
      if (!configs.has(config.id)) continue;
      for (const placement of config.placements) usedLogos.add(placement.logoId);
    }
  }
  const savedLogos = metadata.inclusion.logoIds ?? [...usedLogos];
  for (const box of logoList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    box.checked = savedLogos.includes(box.value);
  }
  // Deliberate narrowing is restored only when the saved set differs from
  // the automatic applicable set; otherwise the untouched override stays off.
  configurationsTouched = false;
  try {
    if (source !== null) {
      const automatic = new Set(applicableConfigurationIds(readSelection()));
      configurationsTouched = configs.size !== automatic.size || [...configs].some((id) => !automatic.has(id));
      if (configurationsTouched) syncSetupCheckboxes(readSelection());
    }
  } catch { configurationsTouched = false; }
  renderSelectionSummary();
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

/** Raster bytes to a data URI (session-local schematic use only). */
function visualPickPhotoHref(bytes: Uint8Array, mediaType: string): string | null {  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return null;
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
    const manifest = parseFlexiblePresentationManifest(
      parseJsonBytes(source?.assets.find((asset) => asset.path === PRESENTATION_MANIFEST_PATH)?.bytes),
    );
    // Cards show the first usable view image in manifest order (legacy
    // sides keep writer order; flexible views are never capped at four).
    const thumbFor = (productId: string): { bytes: Uint8Array; mediaType: string } | null => {
      if (manifest === null) return null;
      const sideRank = (view: string): number => {
        const at = ['front', 'back', 'left', 'right'].indexOf(view);
        return at < 0 ? 4 : at;
      };
      const views = manifest.views
        .filter((entry) => entry.productId === productId)
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => sideRank(a.entry.view) - sideRank(b.entry.view) || a.index - b.index)
        .map((ranked) => ranked.entry);
      for (const view of views) {
        const bytes = source?.assets.find((asset) => asset.path === view.image)?.bytes;
        if (!bytes || bytes.length === 0) continue;
        const header = readRasterHeader(bytes);
        if (header === null) continue;
        return { bytes, mediaType: header.mediaType };
      }
      return null;
    };
    const modelOnly = (productId: string): boolean =>
      manifest !== null &&
      (manifest.models ?? []).some((entry) => entry.productId === productId);
    summary.products.forEach((product, productIndex) => {
      const live = source?.project.products.find((entry) => entry.id === product.id);
      // Human title, never a generated ID: the source name when a real
      // non-blank one was given, otherwise a plain ordinal.
      const rawName = live?.name?.trim() ?? '';
      const title = rawName !== '' ? rawName : `Product ${productIndex + 1}`;
      const card = document.createElement('div');
      card.className = 'product-card';
      card.setAttribute('data-product-card', product.id);
      const thumb = thumbFor(product.id);
      const thumbUri = thumb !== null ? visualPickPhotoHref(thumb.bytes, thumb.mediaType) : null;
      if (thumb !== null && thumbUri !== null) {
        const image = document.createElement('img');
        image.className = 'product-thumb';
        image.alt = `${title} photo`;
        image.src = thumbUri;
        card.append(image);
      } else {
        const fallback = document.createElement('span');
        fallback.className = 'product-thumb-fallback';
        fallback.textContent = modelOnly(product.id) ? '3D model — no photo yet' : 'No photo yet';
        card.append(fallback);
      }
      const body = document.createElement('div');
      body.className = 'product-card-body';
      const { row, box } = createCheckRow(product.id, title);
      if (kept !== null) box.checked = kept.products.includes(`\0${product.id}`);
      body.append(row);
      const liveVariants = live?.variants ?? [];
      if (product.variantIds.length > 1) {
        const variants = document.createElement('div');
        variants.className = 'product-card-variants';
        variants.setAttribute('data-options-for', product.id);
        for (const variantId of product.variantIds) {
          const variant = liveVariants.find((entry) => entry.id === variantId);
          const rawVariant = variant?.name?.trim() ?? '';
          const label = rawVariant !== '' ? rawVariant : `Option ${product.variantIds.indexOf(variantId) + 1}`;
          const variantRow = createCheckRow(variantId, label);
          variantRow.box.setAttribute('data-product', product.id);
          if (kept !== null) variantRow.box.checked = kept.products.includes(`${product.id}\0${variantId}`);
          variants.append(variantRow.row);
        }
        body.append(variants);
      } else if (product.variantIds.length === 1) {
        // Single-option products need no second decision: checking the card
        // includes its only option through the ordinary default contract.
        const variant = liveVariants.find((entry) => entry.id === product.variantIds[0]);
        const singleName = variant?.name?.trim() ?? '';
        const single = document.createElement('p');
        single.className = 'muted';
        single.textContent = `Includes ${singleName !== '' ? singleName : 'Standard option'}.`;
        body.append(single);
      }
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn-secondary';
      open.textContent = 'Open setup';
      open.setAttribute('aria-label', `Open setup for ${title}`);
      open.addEventListener('click', () => openProductWorkspace(product.id));
      body.append(open);
      card.append(body);
      productList.append(card);
    });
  }
  if (summary.logoIds.length === 0) {
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
  const logoIds: string[] = [];
  for (const box of logoList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (box.checked) logoIds.push(box.value);
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
function applicableConfigurationIds(selection: BuilderSelection): string[] {  if (source === null) return [];
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
/** ONE tested inclusion projection for placements, document and issue: an
 * explicit setup narrowing (unticked setups) wins; otherwise the automatic
 * applicable setups of the selected products/variants. Save job always
 * preserves the full editable catalogue plus this selection. */
function scopedConfigurationIds(selection: BuilderSelection): string[] {
  if (source === null) return [];
  if (selection.configurationIds !== undefined) {
    const known = new Set(source.project.configurations.map((entry) => entry.id));
    return selection.configurationIds.filter((id) => known.has(id));
  }
  return applicableConfigurationIds(selection);
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
    selectionError.textContent = '';
    renderSelectionSummary();
    syncSetupCheckboxes(selection);
    // Actionable exclusion notice: artwork used by placements but unticked
    // stays placed and resolvable (never silently deleted), but no NEW
    // placement can use it until it is re-selected in Step 1.
    try {
      const selectedLogos = new Set(selection.logoIds);
      const usedExcluded = new Map<string, string>();
      for (const config of source.project.configurations) {
        for (const placement of config.placements) {
          if (!selectedLogos.has(placement.logoId) && !usedExcluded.has(placement.logoId)) {
            const logo = source.project.logos.find((entry) => entry.id === placement.logoId);
            usedExcluded.set(placement.logoId, logo?.name?.trim() || placement.logoId);
          }
        }
      }
      if (usedExcluded.size > 0) {
        const names = [...usedExcluded.values()].slice(0, 3).join(', ');
        const extra = usedExcluded.size > 3 ? ` and ${usedExcluded.size - 3} more` : '';
        selectionError.textContent = `${names}${extra} ${usedExcluded.size === 1 ? 'is' : 'are'} used by placements but not selected: existing placements stay, but tick the logo to place it again.`;
      }
    } catch { /* notice is best-effort; selection state stays authoritative */ }
  } else {
    selectionValid = false;
    const readable = `Selection invalid: ${outcome.errors.map((error) => error.message).join('; ')}`;
    generateStatus.textContent = readable;
    selectionError.textContent = 'Choose at least one product and an option for each selected product. Check any specific setups you selected.';
    renderSelectionSummary();
  }
  updateControls();
  // Selection edits are staff changes: hold them unsaved (suppressed while
  // installing/loading so programmatic churn never dirties a fresh job).
  markJobDirty();
  if (placementHandle && jobStep === 'placements') placementHandle.update();
  if (reviewHandle && jobStep === 'review') reviewHandle.update();
  if (approvalHandle && jobStep === 'approval') approvalHandle.update();
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
  if (source === null || loading || creating || logoImporting || productImporting ) return;
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
  if (stagedPhotoMappings.length === 0 && snapshot.anchors.length === 0 && packagedSidecar === undefined) {
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
    if (snapshot.anchors.length > 0) {
      const digest = await hasher.prepareProject(snapshot.project);
      additionalAssets.push({ path: OPERATION_ANCHORS_PATH, bytes: buildAnchorsSidecarBytes(snapshot.project, digest, snapshot.anchors) });
      sidecarNote = ` with ${snapshot.anchors.length} prepared anchor(s)`;
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
    if (snapshot.anchors.length > 0 && back.assets.find((asset) => asset.path === OPERATION_ANCHORS_PATH) === undefined) {
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
      variant: sheet.variantDisplay ?? sheet.productName ?? 'Product',
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

async function createEmptyProject(): Promise<void> {
  if (loading || creating) return;
  alertBuilder();
  const generation = ++createGeneration;
  // Starting a new job deliberately supersedes any unfinished artwork import.
  logoGeneration += 1; logoImporting = false;
  productGeneration += 1; productImporting = false;
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
    draftRetirements = [];
    staffModelSnapshots.clear();
    areaManifestBaseline.clear();
    resetIntakeStaging();
    addedPresentations = [];
    productName.value = '';
    source = createEmptySession('empty-draft', draft, [], new Uint8Array(0));
    configurationsTouched = false;
    renderSelectionLists(source.summary);
    stagedPhotoMappings = [];
    guidedScale.hide();
    refreshWorkspace();
    refreshAddProductDisclosure();
    refreshIntakeReadiness();
    projectIdSuggestion.textContent = 'A fresh project ID was generated for this new draft. Enter a unique ID for this customer issue.';
    customerName.value = '';
    jobRef.value = '';
    issuedBy.value = '';
    formatSelf.checked = true; formatHybrid.checked = false;
    projectIdInput.value = newLocalId(); lastAutoProjectId = projectIdInput.value;
    logoStatus.textContent = '';
    masterStatus.textContent = 'Empty draft ready. Name the product, choose Images or 3D model below, then “Add product and set up” — nothing is pre-selected, nothing is synthetic.';
    createStatus.textContent = 'Created a new empty draft with no products. Name the product and add views or a model below, or open an existing project file.';
    refreshSelectionValidation();
    resetSessionForInstall();
    setJobStep('prepare');
    clearJobDirtyState(false);
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
  if (!source || loading || creating ) return;
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
    // Materialize the artwork into the live job immediately (one revision):
    // the merged job project + asset pool is the single coherent snapshot
    // for placements, review, save and issue. No parallel staged logo list.
    const assetPath = `logos/${id}.${header.mediaType === 'image/jpeg' ? 'jpg' : header.mediaType === 'image/webp' ? 'webp' : 'png'}`;
    const next = newRevision(source.project, (draft) => {
      draft.logos.push({
        schemaVersion: source!.project.schemaVersion,
        id,
        name: readableLogoName(file.name),
        role: 'original',
        assets: [{ uri: assetPath, role: 'original', mediaType: header.mediaType, widthPx: header.width, heightPx: header.height }],
      });
    });
    source = replaceSessionProject(source, next, [...source.assets, { path: assetPath, bytes: bytes.slice(), kind: 'referenced' as const }]);
    logoStatus.textContent = `Added ${file.name}. It is selected automatically; place it in Set logo placements.`;
    renderSelectionLists(source.summary, true);
    refreshSelectionValidation();
    reprepareJobDigest();
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

/** Legacy side-keyed view identity (pre-flexible-views packages). */
type ProductViewSide = 'front' | 'back' | 'left' | 'right';

function safeProductSegment(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return cleaned === '' ? 'product' : cleaned;
}

/* ---- Station intake: explicit Images/3D toggle + dynamic named views ----
 * (Worker 2). Images mode stages a dynamic list of named view rows; each
 * row carries a stable local slug id (`view-N`, generated locally per
 * draft — never the mutable human label) plus decoded file bytes. Row
 * count is unbounded (no 4-slot cap); labels are free text defaulted to
 * "View N" when blank so a missing label never blocks. The 3D path stages
 * a single GLB. Mode state governs which path stages; switching modes asks
 * before clearing the other path (no silent data loss).
 *
 * INTEGRATION NOTE (lead/Worker 3): intake-created products emit
 * presentation-manifest v2/v3 `views` entries whose `view` is the stable slug
 * id (NOT front/back/left/right) with the human name in `label`, canonically
 * sorted, escalating to v3 when flexible ids are present (same rule as the
 * sibling `src/core/photo-intake` planner). `view` is identity (survives
 * renames); `label` is display only. The in-place commit path above already
 * plans through that generalized planner. Workspace tabs, customer preview
 * and operation-document view labels still need the reader swap from the
 * legacy customer-editor parser to the sibling `src/core/presentation-views`
 * reader before slug views display; legacy side-keyed history keeps opening
 * verbatim through the merge below.
 */
function stagedViewDisplayName(row: StagedIntakeView, index: number): string {
  const label = row.label.trim();
  return label === '' ? `View ${index + 1}` : label.slice(0, 80);
}

/** Views with decoded bytes, in row order. */
function intakeReadyViews(): StagedIntakeView[] {
  return stagedIntakeViews.filter((row) => row.staged !== null);
}

/** Whether the primary Add button can act right now (pure; no text). */
function intakeActionable(): boolean {
  if (source === null || productImporting) return false;
  return intakeMode === 'model' ? pendingPrimaryModel !== null : intakeReadyViews().length > 0;
}

/** Primary Add-button guidance: concise missing-input text until valid. */
function refreshIntakeReadiness(): void {
  if (productImporting) return; // transient "Reading…" owns the line
  if (source === null) {
    productAdd.disabled = true;
    productStatus.textContent = 'Create or open a project before adding a product.';
    return;
  }
  if (intakeMode === 'model') {
    if (pendingPrimaryModel === null) {
      productAdd.disabled = true;
      productStatus.textContent = 'Choose a 3D model (.glb) to continue — then “Add product and set up” creates it.';
    } else {
      productAdd.disabled = false;
      productStatus.textContent = `Staged 3D model ${pendingPrimaryModel.fileName}. Choose “Add product and set up” to create it — all viewpoints are included, no view images needed.`;
    }
    return;
  }
  const ready = intakeReadyViews();
  if (ready.length === 0) {
    productAdd.disabled = true;
    productStatus.textContent = 'Choose at least one view image to continue — name it (for example “Crown”); add more rows with “Add view” as needed.';
  } else {
    productAdd.disabled = false;
    const names = ready.map((row) => `“${stagedViewDisplayName(row, stagedIntakeViews.indexOf(row))}”`).join(', ');
    const capped = stagedIntakeViews.length >= PRESENTATION_VIEW_LIMITS.maxViewsPerScope
      ? ` Up to ${PRESENTATION_VIEW_LIMITS.maxViewsPerScope} view images per product.`
      : '';
    productStatus.textContent = `${ready.length} view image${ready.length === 1 ? '' : 's'} ready (${names}). Choose “Add product and set up” to create the product and open its setup.${capped}`;
  }
}

function paintIntakeMode(): void {
  intakeImagesPanel.hidden = intakeMode !== 'images';
  intakeModelPanel.hidden = intakeMode !== 'model';
  intakeModeImages.checked = intakeMode === 'images';
  intakeModeModel.checked = intakeMode === 'model';
}

function addIntakeViewRow(): StagedIntakeView | null {
  // Provisional per-product bound (sibling presentation-views contract):
  // the manifest reader rejects scopes over the cap, so intake never
  // stages more than it can commit.
  if (stagedIntakeViews.length >= PRESENTATION_VIEW_LIMITS.maxViewsPerScope) {
    productStatus.textContent = `A product holds at most ${PRESENTATION_VIEW_LIMITS.maxViewsPerScope} view images — remove a row to stage a different one.`;
    updateControls();
    return null;
  }
  const row: StagedIntakeView = { id: `view-${++stagedIntakeViewSeq}`, label: '', staged: null };
  stagedIntakeViews.push(row);
  renderIntakeViewRows();
  refreshIntakeReadiness();
  return row;
}

function removeIntakeViewRow(id: string): void {
  const thumb = intakeThumbUrls.get(id);
  if (thumb !== undefined) {
    URL.revokeObjectURL(thumb);
    intakeThumbUrls.delete(id);
  }
  stagedIntakeViews = stagedIntakeViews.filter((row) => row.id !== id);
  if (stagedIntakeViews.length === 0) {
    // The Images path always offers at least one editable row — removing
    // the last row resets to a single empty row rather than a dead end.
    addIntakeViewRow();
    return;
  }
  renderIntakeViewRows();
  refreshIntakeReadiness();
}

/** Reset intake staging to one empty Images row (creation/open entry). */
function resetIntakeStaging(): void {
  for (const url of intakeThumbUrls.values()) URL.revokeObjectURL(url);
  intakeThumbUrls.clear();
  intakeMode = 'images';
  stagedIntakeViews = [];
  stagedIntakeViewSeq = 0;
  pendingPrimaryModel = null;
  intakeModelStatus.textContent = 'No 3D model staged yet.';
  productStatus.textContent = '';
  paintIntakeMode();
  addIntakeViewRow();
}

/** Switch Images/3D mode; a staged other path is cleared only on confirm. */
function setIntakeMode(next: IntakeMode): void {
  if (next === intakeMode) {
    paintIntakeMode();
    return;
  }
  if (next === 'model') {
    const stagedCount = intakeReadyViews().length;
    if (stagedCount > 0 && !window.confirm(`Switch to 3D model? The ${stagedCount} staged view image${stagedCount === 1 ? '' : 's'} will be cleared. This cannot be undone.`)) {
      paintIntakeMode();
      return;
    }
    for (const url of intakeThumbUrls.values()) URL.revokeObjectURL(url);
    intakeThumbUrls.clear();
    stagedIntakeViews = [];
    renderIntakeViewRows();
    intakeMode = 'model';
    paintIntakeMode();
    productStatus.textContent = stagedCount > 0
      ? 'Switched to 3D model: staged view images were cleared. Choose a .glb file.'
      : 'Switched to 3D model. Choose a .glb file.';
    refreshIntakeReadiness();
    updateControls();
    return;
  }
  if (pendingPrimaryModel !== null && !window.confirm('Switch to Images? The staged 3D model will be cleared. This cannot be undone.')) {
    paintIntakeMode();
    return;
  }
  pendingPrimaryModel = null;
  intakeModelStatus.textContent = 'No 3D model staged yet.';
  intakeMode = 'images';
  if (stagedIntakeViews.length === 0) addIntakeViewRow();
  paintIntakeMode();
  renderIntakeViewRows();
  productStatus.textContent = 'Switched to Images: the staged 3D model was cleared. Choose a view image.';
  refreshIntakeReadiness();
  updateControls();
}

function rowLabelInput(rowId: string): HTMLInputElement | null {
  return productViewRows.querySelector(`[data-view-row="${rowId}"] input[type="text"]`);
}

function renderIntakeViewRows(): void {
  for (const url of intakeThumbUrls.values()) URL.revokeObjectURL(url);
  intakeThumbUrls.clear();
  productViewRows.replaceChildren();
  stagedIntakeViews.forEach((row, index) => {
    const name = stagedViewDisplayName(row, index);
    const wrap = document.createElement('div');
    wrap.className = 'view-row';
    wrap.setAttribute('data-view-row', row.id);
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'View name ';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = row.label;
    nameInput.placeholder = index === 0 ? 'e.g. Crown' : `e.g. View ${index + 1}`;
    nameInput.setAttribute('aria-label', `Name for view ${index + 1}`);
    nameInput.autocomplete = 'off';
    nameInput.maxLength = 80;
    nameInput.addEventListener('input', () => {
      row.label = nameInput.value;
      updateControls();
    });
    nameLabel.append(nameInput);
    wrap.append(nameLabel);
    const state = document.createElement('span');
    state.className = 'view-row-state';
    if (row.staged !== null) {
      const thumb = document.createElement('img');
      thumb.className = 'view-row-thumb';
      thumb.alt = '';
      const url = URL.createObjectURL(new Blob([new Uint8Array(row.staged.bytes).buffer as ArrayBuffer], { type: row.staged.mediaType }));
      intakeThumbUrls.set(row.id, url);
      thumb.src = url;
      wrap.append(thumb);
      state.textContent = `${row.staged.fileName} · ${row.staged.widthPx}×${row.staged.heightPx} ready`;
    } else {
      state.textContent = 'No image chosen yet.';
    }
    wrap.append(state);
    const file = document.createElement('input');
    file.type = 'file';
    file.className = 'intake-file';
    file.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
    file.setAttribute('aria-label', row.staged !== null ? `Replace image for ${name}` : `Choose image for ${name}`);
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      if (chosen) void stageIntakeViewFile(row.id, chosen);
      file.value = '';
    });
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'btn-secondary';
    choose.textContent = row.staged !== null ? 'Replace view image' : 'Choose view image';
    choose.addEventListener('click', () => file.click());
    wrap.append(choose, file);
    if (stagedIntakeViews.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.addEventListener('click', () => removeIntakeViewRow(row.id));
      wrap.append(remove);
    }
    productViewRows.append(wrap);
  });
  updateControls();
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

// Staging slots are independent inputs: each has its own token so staging
// one row never discards another row's in-flight decode. Re-staging the
// same row discards the older read for that row only.
const intakeViewTokens = new Map<string, number>();
let intakeModelToken = 0;

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

async function stageIntakeModelFile(file: File): Promise<void> {
  if (loading || creating || logoImporting ) return;
  alertBuilder();
  const generation = ++productGeneration;
  const slot = ++intakeModelToken;
  const isCurrent = (): boolean => generation === productGeneration && slot === intakeModelToken;
  productImporting = true;
  updateControls();
  productStatus.textContent = `Reading ${file.name}…`;
  let stagedOk = false;
  try {
    if (looksRemoteFileName(file.name)) throw new Error('file name looks like a remote reference; choose a local .glb 3D model file');
    const ext = extensionOfFileName(file.name);
    if (ext !== '.glb') throw new Error('unsupported file type; choose one .glb 3D model file');
    if (file.size > PRESENTATION_MAX_MODEL_BYTES) throw new Error(`model exceeds ${PRESENTATION_MAX_MODEL_BYTES} bytes; rejected before reading`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isCurrent()) return;
    if (bytes.length === 0 || bytes.length > PRESENTATION_MAX_MODEL_BYTES) throw new Error('model is empty or exceeds the 16 MB model bound');
    const problem = validateModelBytes(bytes);
    if (problem !== null) throw new Error(`invalid 3D model (${problem}); only the self-contained subset is accepted`);
    pendingPrimaryModel = { bytes: bytes.slice(), fileName: file.name };
    intakeModelStatus.textContent = `${file.name} ready — all viewpoints are included.`;
    if (!isCurrent()) return;
    stagedOk = true;
  } catch (error) {
    if (generation === productGeneration) {
      productStatus.textContent = `Could not stage ${file.name}: ${error instanceof Error ? error.message : String(error)}. Previous products are unchanged.`;
      alertBuilder(`Could not stage ${file.name}. Previous products are unchanged.`);
    }
  } finally {
    if (generation === productGeneration) {
      productImporting = false;
      updateControls();
      if (stagedOk) refreshIntakeReadiness();
    }
  }
}

async function stageIntakeViewFile(rowId: string, file: File): Promise<void> {
  if (loading || creating || logoImporting ) return;
  alertBuilder();
  const generation = ++productGeneration;
  const slot = (intakeViewTokens.get(rowId) ?? 0) + 1;
  intakeViewTokens.set(rowId, slot);
  const isCurrent = (): boolean => generation === productGeneration && intakeViewTokens.get(rowId) === slot;
  productImporting = true;
  updateControls();
  const row = stagedIntakeViews.find((entry) => entry.id === rowId);
  productStatus.textContent = `Reading ${file.name}…`;
  let stagedOk = false;
  try {
    if (row === undefined) throw new Error('that view row no longer exists; add a new row and choose the file again');
    if (looksRemoteFileName(file.name)) throw new Error('file name looks like a remote reference; choose a local PNG, JPEG or WebP image');
    if (file.size > MAX_PREVIEW_BYTES) throw new Error(`image exceeds ${MAX_PREVIEW_BYTES} bytes; rejected before reading`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isCurrent()) return;
    const decoded = await decodeAndVerifyRaster(bytes, isCurrent);
    if (!isCurrent()) return;
    if (decoded === null) throw new Error('unsupported or invalid image; choose a PNG, JPEG or WebP file with verifiable dimensions');
    row.staged = { bytes: bytes.slice(), mediaType: decoded.mediaType, extension: decoded.mediaType === 'image/jpeg' ? 'jpg' : decoded.mediaType === 'image/webp' ? 'webp' : 'png', widthPx: decoded.width, heightPx: decoded.height, fileName: file.name };
    renderIntakeViewRows();
    if (!isCurrent()) return;
    stagedOk = true;
  } catch (error) {
    if (generation === productGeneration) {
      productStatus.textContent = `Could not stage ${file.name}: ${error instanceof Error ? error.message : String(error)}. Previous products are unchanged.`;
      alertBuilder(`Could not stage ${file.name}. Previous products are unchanged.`);
    }
  } finally {
    if (generation === productGeneration) {
      productImporting = false;
      updateControls();
      if (stagedOk) refreshIntakeReadiness();
    }
  }
}


async function addProductFromStaged(): Promise<void> {
  if (source === null || loading || creating || logoImporting || productImporting ) {
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
    const readyRows = intakeReadyViews().map((row) => ({ row, name: stagedViewDisplayName(row, stagedIntakeViews.indexOf(row)) }));
    if (intakeMode === 'model' ? pendingPrimaryModel === null : readyRows.length === 0) {
      // The disabled Add button normally prevents this; a stale click still
      // gets concise guidance instead of a silent no-op.
      refreshIntakeReadiness();
      alertBuilder(intakeMode === 'model' ? 'Choose a 3D model first.' : 'Choose at least one view image first.');
      return;
    }
    const snapshot = source;
    const wantedName = productName.value.trim();
    productCounter += 1;
    const fallbackFileName = pendingPrimaryModel?.fileName ?? readyRows[0]?.row.staged?.fileName ?? 'product';
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
    // Each staged row becomes exactly one manifest view keyed by its stable
    // slug id (identity), with the human name in `label` (display). No
    // forced side semantics. Entries sort canonically by (view, image) and
    // the per-scope view bound is enforced before committing, mirroring the
    // sibling presentation-views contract.
    const takenPaths = new Set(snapshot.assets.map((asset) => asset.path));
    for (const { row, name } of readyRows) {
      const staged = row.staged!;
      let imagePath = `presentation/${safe}/${row.id}.${staged.extension}`;
      for (let dup = 2; takenPaths.has(imagePath) && dup < 100; dup += 1) {
        imagePath = `presentation/${safe}/${row.id}-${dup}.${staged.extension}`;
      }
      takenPaths.add(imagePath);
      assets.push({ path: imagePath, bytes: staged.bytes.slice() });
      views.push({ view: row.id, image: imagePath, label: name });
    }
    if (views.length > PRESENTATION_VIEW_LIMITS.maxViewsPerScope) {
      productStatus.textContent = `Could not add product: ${views.length} view images exceed the ${PRESENTATION_VIEW_LIMITS.maxViewsPerScope}-view per-product bound. Remove rows and try again; previous products are unchanged.`;
      return;
    }
    views.sort((a, b) => (a.view < b.view ? -1 : a.view > b.view ? 1 : a.image < b.image ? -1 : a.image > b.image ? 1 : 0));
    if (views.length === 0 && models.length === 0) {
      productStatus.textContent = 'Nothing staged to add: the staged files did not yield a view or model. Previous products are unchanged.';
      return;
    }
    interface NewViewEntry { productId: string; variantId: string; view: string; image: string; label?: string; }
    interface NewModelEntry { productId: string; variantId: string; model: string; label?: string; }
    interface NewManifest { version: 2 | 3; views: NewViewEntry[]; models?: NewModelEntry[]; }
    // Version escalates to v-next when a genuinely flexible (non-legacy)
    // id is present — the same rule as the sibling intake planner; legacy
    // four-side scopes stay version 2.
    const manifestVersion: 2 | 3 = views.some((entry) => !isLegacyViewId(entry.view)) ? 3 : 2;
    const manifestValue: NewManifest = models.length > 0
      ? { version: manifestVersion, views: views.map((entry) => ({ productId, variantId, view: entry.view, image: entry.image, ...(entry.label !== undefined ? { label: entry.label } : {}) })), models: models.map((entry) => ({ productId, variantId, model: entry.model, ...(entry.label !== undefined ? { label: entry.label } : {}) })) }
      : { version: manifestVersion, views: views.map((entry) => ({ productId, variantId, view: entry.view, image: entry.image, ...(entry.label !== undefined ? { label: entry.label } : {}) })) };
    const existingManifestBytes = snapshot.assets.find((asset) => asset.path === PRESENTATION_MANIFEST_PATH)?.bytes;
    // Merge with history through the validated parsers (never raw JSON):
    // the flexible reader first (v2/v3, legacy sides included), the legacy
    // reader only for v1 references. History rides verbatim; invalid
    // history is replaced with a visible note; the 32-entry budget is
    // enforced BEFORE committing source state.
    type MergedView = { productId: string; variantId?: string; view: string; image: string; label?: string };
    type MergedModel = { productId: string; variantId?: string; model: string; label?: string };
    type MergedReference = { productId: string; variantId?: string; image: string; label?: string };
    let mergedManifest: { version: 2 | 3; views: MergedView[]; models?: MergedModel[]; references?: MergedReference[] } = { version: manifestVersion, views: [...manifestValue.views], ...(manifestValue.models ? { models: [...manifestValue.models] } : {}) };
    let historyNote = '';
    if (existingManifestBytes) {
      // History parses through the flexible reader first so v3/flexible
      // history is never mistaken for invalid and dropped; the legacy
      // reader remains only for v1 references.
      let historyRaw: unknown = null;
      try {
        historyRaw = JSON.parse(new TextDecoder().decode(existingManifestBytes));
      } catch {
        historyRaw = null;
      }
      const historyFlexible = parseFlexiblePresentationManifest(historyRaw);
      if (historyFlexible !== null) {
        mergedManifest = {
          version: historyFlexible.version === 3 || manifestVersion === 3 ? 3 : 2,
          views: [...historyFlexible.views.map((entry) => ({ ...entry })), ...manifestValue.views],
          ...(((historyFlexible.models?.length ?? 0) > 0 || manifestValue.models) ? { models: [...(historyFlexible.models ?? []).map((entry) => ({ ...entry })), ...(manifestValue.models ?? [])] } : {}),
          ...(((historyFlexible.references?.length ?? 0) > 0) ? { references: [...(historyFlexible.references ?? []).map((entry) => ({ ...entry }))] } : {}),
        };
      } else {
        const history = parsePresentationManifest(existingManifestBytes);
        if (history === null) {
          historyNote = ' The prior presentation manifest was invalid and was replaced.';
        } else if (history.version === 1) {
          mergedManifest = { version: manifestVersion, views: [...manifestValue.views], ...(manifestValue.models ? { models: [...manifestValue.models] } : {}), references: [...history.references] };
        } else {
          mergedManifest = {
            version: manifestVersion,
            views: [...history.views.map((entry) => ({ ...entry })), ...manifestValue.views],
            ...(((history.models?.length ?? 0) > 0 || manifestValue.models) ? { models: [...(history.models ?? []).map((entry) => ({ ...entry })), ...(manifestValue.models ?? [])] } : {}),
            ...(((history.references?.length ?? 0) > 0) ? { references: [...(history.references ?? []).map((entry) => ({ ...entry }))] } : {}),
          };
        }
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
    if (snapshot === null) throw new Error('no job open');
    source = replaceSessionProject(snapshot, reparsed.project, reparsed.assets, packageBytes.slice());
    addedPresentations.push({ views, models, assets: assets.filter((asset) => asset.path !== PRESENTATION_MANIFEST_PATH) });
    if (generation !== productGeneration) return;
    // End the busy phase before post-commit UI: the workspace focus helper
    // refreshes through a blocked-guard, which must see an idle station.
    // The finally below repeats this idempotently.
    productImporting = false;
    updateControls();
    for (const url of intakeThumbUrls.values()) URL.revokeObjectURL(url);
    intakeThumbUrls.clear();
    stagedIntakeViews = [];
    pendingPrimaryModel = null;
    intakeModelStatus.textContent = 'No 3D model staged yet.';
    // Fresh empty row for the next product (renders + recomputes gating).
    addIntakeViewRow();
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
    reprepareJobDigest();
    // The calibration workspace opens automatically on the new product:
    // selection moves there and keyboard focus follows, so the next action
    // (draw the safe area, place anchors, save once) is immediate.
    openProductWorkspace(productId);
    refreshAddProductDisclosure();
    if (generation !== productGeneration) return;
    const viewCountText = views.length === 0
      ? '3D model (all viewpoints included)'
      : `${views.length} view${views.length === 1 ? '' : 's'}`;
    productStatus.textContent = `Added preview-only product ${mintedProduct.name ?? productId} (${viewCountText}). It carries no measurements yet — its setup is open below: draw the safe area, place anchors, then save once.${historyNote}`;
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
  if (file) void stageIntakeModelFile(file);
  productFile.value = '';
}

/* ---------------- In-place view images (named rows) ---------------- */
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

/**
 * Human display name for an in-place manifest view: the stored human
 * label when present, otherwise a capitalized legacy side ("Front view")
 * or the raw stable id for slug-keyed views.
 */
function inPlaceViewDisplayName(entry: { view: string; label?: string }): string {
  if (entry.label !== undefined && entry.label.trim() !== '') return entry.label;
  const side = entry.view;
  if (side === 'front' || side === 'back' || side === 'left' || side === 'right') {
    return `${side[0]!.toUpperCase()}${side.slice(1)} view`;
  }
  return entry.view;
}

function isLegacyPhotoSideKey(key: string): key is ProductViewSide {
  return key === 'front' || key === 'back' || key === 'left' || key === 'right';
}

/* Named-row in-place UI (Worker 2): one row per existing view image of the
 * selected Images product/variant (human name + Replace), plus the static
 * add row in the template. Model-only products and empty drafts hide the
 * whole disclosure — photo UI never appears where photos cannot attach.
 * Row commits route legacy side keys through the existing planner path and
 * slug keys through the local narrow commit below (lead: unify when the
 * core planner generalizes beyond front/back/left/right).
 */
function refreshPhotoAttachHint(): void {
  if (photoAttaching) return;
  productPhotoRows.replaceChildren();
  if (source === null) {
    productPhotoDisclosure.hidden = true;
    productPhotoContext.textContent = 'No product selected yet.';
    return;
  }
  const products = source.project.products;
  if (products.length === 0) {
    productPhotoDisclosure.hidden = true;
    productPhotoContext.textContent = 'No product yet — add one below first.';
    productPhotoStatus.textContent = '';
    return;
  }
  const product = products.find((entry) => entry.id === workspaceProductId) ?? products[0] ?? null;
  const variant = product?.variants.find((entry) => entry.id === workspaceVariantId) ?? product?.variants[0] ?? null;
  if (product === null || product === undefined || variant === null || variant === undefined) {
    productPhotoDisclosure.hidden = true;
    productPhotoContext.textContent = 'No product selected yet.';
    return;
  }
  const wholeProduct = productPhotoScope.value === 'product';
  const scopeVariantId = wholeProduct ? undefined : variant.id;
  const assets = sessionAssetMap();
  const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
  let rawManifest: unknown = null;
  if (manifestBytes !== undefined) {
    try {
      rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
      rawManifest = null;
    }
  }
  // Flexible-reader rows: slug views render alongside legacy sides. The
  // legacy customer-editor reader stays for the workspace paths until the
  // lead wires the swap.
  const flexible = parseFlexiblePresentationManifest(rawManifest);
  const legacyFallback = flexible === null ? parsePresentationManifest(manifestBytes) : null;
  const scope = photoAttachScopeName(product, scopeVariantId === undefined ? undefined : variant);
  const hasModel = flexible !== null &&
    (flexible.models ?? []).some((entry) => entry.productId === product.id &&
      (entry.variantId ?? undefined) === scopeVariantId);
  if (hasModel) {
    productPhotoDisclosure.hidden = true;
    return;
  }
  productPhotoDisclosure.hidden = false;
  const entries = flexible !== null
    ? flexible.views.filter((entry) => entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId)
    : [];
  productPhotoContext.textContent = entries.length === 0
    ? `Views for ${scope} — no view images yet. Name the first view and choose its image.`
    : `Views for ${scope} — ${entries.length} view image${entries.length === 1 ? '' : 's'}. Replacing one starts it unmeasured; other views, logos and measurements are kept.`;
  for (const entry of entries) {
    const label = inPlaceViewDisplayName(entry);
    const row = document.createElement('div');
    row.className = 'view-row';
    row.setAttribute('data-in-place-view', entry.view);
    const nameLabel = document.createElement('label');
    nameLabel.className = 'view-row-name-label';
    nameLabel.textContent = 'View name ';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'view-row-name';
    name.value = label;
    name.maxLength = 80;
    name.setAttribute('aria-label', `Name for existing view ${label}`);
    name.autocomplete = 'off';
    nameLabel.append(name);
    row.append(nameLabel);
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'btn-secondary';
    rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename view ${label}`);
    rename.addEventListener('click', () => {
      void renameExistingView(entry.view, name.value);
    });
    row.append(rename);
    const state = document.createElement('span');
    state.className = 'view-row-state';
    state.textContent = 'ready';
    row.append(state);
    const file = document.createElement('input');
    file.type = 'file';
    file.className = 'intake-file';
    file.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
    file.setAttribute('aria-label', `Replace view image ${label}`);
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (chosen) void attachProductPhotoFile(chosen, entry.view);
    });
    const replace = document.createElement('button');
    replace.type = 'button';
    replace.className = 'btn-secondary';
    replace.textContent = 'Replace view image';
    replace.setAttribute('aria-label', `Replace view image ${label}`);
    replace.addEventListener('click', () => file.click());
    row.append(replace, file);
    productPhotoRows.append(row);
  }
  if (legacyFallback !== null && legacyFallback.version === 1) {
    productPhotoStatus.textContent = `This product uses a legacy single reference. The add row below attaches a named view image alongside it; existing data is kept.`;
  }
}

async function attachProductPhotoFile(file: File, viewKey: string): Promise<void> {
  // Slug-keyed views (intake-named rows) commit through the local narrow
  // path below; legacy side keys keep the proven core-planner path intact.
  if (!isLegacyPhotoSideKey(viewKey)) {
    await attachSlugViewImage(file, viewKey);
    return;
  }
  if (source === null || loading || creating || logoImporting || productImporting || photoAttaching) {
    if (source === null) {
      productPhotoStatus.textContent = 'Create or open a project before adding a view image.';
      alertBuilder('Create or open a project before adding a view image.');
    }
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
  // Named-row in-place UI: legacy-side replacements keep their stored label
  // (the add row only names new slug views, handled in attachSlugViewImage).
  const submittedLabel = '';
  const submittedFileName = file.name;
  const side: ProductViewSide = viewKey;
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
      // Exclusive intake: a product is EITHER Images OR a 3D model. Attaching
      // a photo to a product that already carries a model is refused (new
      // mixed-mode intake); products that already combine both from an
      // earlier version keep opening and working unchanged.
      if (parsed !== null && parsed.version === 2 &&
        (parsed.models ?? []).some((entry) => entry.productId === product.id &&
          (entry.variantId ?? undefined) === scopeVariantId)) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: this product uses a 3D model, and a product is either Images or a 3D model. Set up measurements on the 3D model directly, or add a separate Images product for photos. Previous products are unchanged.`;
        return;
      }
      if (parsed === null) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: no usable presentation manifest is in this project; add the product with a view image first, then attach further views here.`;
        return;
      }
      // The pure planner speaks v2/v3 manifests; v1 references ride along
      // verbatim so upgrading history is never dropped. v3 flexible views
      // pass through untouched (same string identities).
      const existingManifestJson: unknown = parsed.version === 1
        ? { version: 2, views: [], references: parsed.references.map((entry) => ({ ...entry })) }
        : {
          version: parsed.version,
          views: parsed.views.map((entry) => ({ ...entry })),
          ...(parsed.models ? { models: parsed.models.map((entry) => ({ ...entry })) } : {}),
          ...((parsed.references ?? []).length > 0 ? { references: (parsed.references ?? []).map((entry) => ({ ...entry })) } : {}),
        };
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
      // Replacing a photo also retires its two-click span evidence: sidecars
      // naming the superseded image path are dropped (their photo is gone).
      // Other sidecars ride along byte-identical. Unparseable files under
      // the span directory are kept as inert evidence, never trusted.
      const retiredSpanPaths = new Set<string>();
      if (plan.replacedAssetPath !== undefined) {
        for (const asset of snapshot.assets) {
          if (asset.kind !== 'additional' || !asset.path.startsWith(`${SETUP_SPAN_DIR}/`)) continue;
          const parsedSpan = parseSpanSidecar(asset.bytes);
          if (parsedSpan.ok && parsedSpan.sidecar.imagePath === plan.replacedAssetPath) {
            retiredSpanPaths.add(asset.path);
          }
        }
        for (const path of retiredSpanPaths) skipPaths.add(path);
      }
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
      if (!beforeProduct || !afterProduct || canonicalize(afterProduct) !== canonicalize(beforeProduct)) {
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
      source = replaceSessionProject(snapshot, reparsed.project, reparsed.assets, packageBytes.slice());
      if (plan.replacedAssetPath !== undefined) {
        // Retire staged drafts bound to the superseded photo/scope — but
        // only when no other manifest entry still references that path:
        // a shared photo keeps its bytes (Tranche A evidence rule), so
        // sibling scopes staged on it stay valid and restorable.
        const shared = parsed.version === 2 && [...parsed.views, ...(parsed.references ?? [])].some(
          (entry) => entry.image === plan.replacedAssetPath &&
            !(entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId),
        );
        if (!shared) {
          draftRetirements.push({
            kind: 'photo-replaced',
            productId: product.id,
            ...(scopeVariantId !== undefined ? { variantId: scopeVariantId } : {}),
            imagePath: plan.replacedAssetPath,
          });
        }
      }
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
        : `Replaced ${workspaceSideLabel(side)} photo on ${scope}. ${invalidated.size} photo mapping${invalidated.size === 1 ? ' was' : 's were'} retired${retiredSpanPaths.size > 0 ? ` and its two-click span reference was retired` : ''}; the superseded photo stays in the package as evidence and other views sharing it are unchanged. Set up measurements on the new photo before authoring.`;
    }, () => {
      productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the project changed before the attach started; choose the file again. Previous products are unchanged.`;
    });
  } catch (error) {
    if (fresh()) {
      productPhotoStatus.textContent = `Could not attach ${submittedFileName}: ${error instanceof Error ? error.message : String(error)}`;
      alertBuilder(`The view image could not be attached. Previous products are unchanged.`);
    }
  } finally {
    photoAttaching = false;
    updateControls();
  }
}

/**
 * Slug-keyed (intake-named) view-image commit (Worker 2). Planning is the
 * sibling-owned generalized core planner (`planPhotoIntake` with `viewId`):
 * it mints the fresh path, escalates the manifest version, enforces the
 * 12-view per-scope budget and computes mapping invalidation. This function
 * owns only the UI-layer boundary (decode, scope capture) and the proven
 * repackage-and-reparse commit tail. Same atomicity as the legacy path.
 */
async function attachSlugViewImage(file: File, viewKey: string): Promise<void> {
  if (source === null || loading || creating || logoImporting || productImporting || photoAttaching) {
    if (source === null) {
      productPhotoStatus.textContent = 'Create or open a project before adding a view image.';
      alertBuilder('Create or open a project before adding a view image.');
    }
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
  // workspace selection, scope, view key and label. Later awaits must never
  // read live UI state, so a mid-read switch cannot attach elsewhere.
  const submittedSource = source;
  const submittedSession = sourceSession;
  const submittedProductId = workspaceProductId;
  const submittedVariantId = workspaceVariantId;
  const submittedWholeProduct = productPhotoScope.value === 'product';
  const submittedLabel = productPhotoNewLabel.value.trim().slice(0, 80);
  const submittedFileName = file.name;
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
      let rawManifest: unknown = null;
      if (manifestBytes !== undefined) {
        try {
          rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
        } catch {
          rawManifest = null;
        }
      }
      // Flexible-reader parse: slug views need the sibling-owned v2/v3
      // reader; the legacy customer-editor reader stays for the workspace
      // paths until the lead wires the swap.
      const flexible = parseFlexiblePresentationManifest(rawManifest);
      // Exclusive intake, mirrored from the legacy path: a product carrying
      // a model for this scope cannot gain view images.
      if (flexible !== null &&
        (flexible.models ?? []).some((entry) => entry.productId === product.id &&
          (entry.variantId ?? undefined) === scopeVariantId)) {
        productPhotoStatus.textContent = `Could not attach ${submittedFileName}: this product uses a 3D model, and a product is either Images or a 3D model. Set up measurements on the 3D model directly, or add a separate Images product for view images. Previous products are unchanged.`;
        return;
      }
      // Legacy v1 single references ride into the planner as a viewless v2
      // base (same conversion as the legacy-side path); anything else
      // unparseable refuses atomically.
      let existingManifestJson: unknown;
      if (flexible !== null) {
        existingManifestJson = rawManifest;
      } else {
        const legacyParsed = parsePresentationManifest(manifestBytes);
        if (legacyParsed === null || legacyParsed.version !== 1) {
          productPhotoStatus.textContent = `Could not attach ${submittedFileName}: no usable presentation manifest is in this project; add the product with a view image first, then attach further views here. Previous products are unchanged.`;
          return;
        }
        existingManifestJson = { version: 2, views: [], references: legacyParsed.references.map((entry) => ({ ...entry })) };
      }
      const scope = photoAttachScopeName(product, scopeVariantId === undefined ? undefined : variant);
      const scopeEntries = flexible !== null
        ? flexible.views.filter((entry) => entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId)
        : [];
      const occupied = scopeEntries.some((entry) => entry.view === viewKey);
      const mode = occupied ? 'replace' : 'add';
      const humanLabel = occupied
        ? inPlaceViewDisplayName(scopeEntries.find((entry) => entry.view === viewKey)!)
        : (submittedLabel !== '' ? submittedLabel : `View ${scopeEntries.length + 1}`);
      const merged = workspaceMergedMappings();
      const plan = planPhotoIntake({
        productId: product.id,
        ...(scopeVariantId !== undefined ? { variantId: scopeVariantId } : {}),
        viewId: viewKey,
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
      // The planner owns the fresh path, the versioned manifest and the
      // retired mapping keys; the caller assigns the human label on adds.
      const invalidated = new Set(plan.invalidatedMappingKeys);
      const manifestOut = JSON.parse(JSON.stringify(plan.manifest)) as {
        version: 2 | 3;
        views: Array<{ productId: string; variantId?: string; view: string; image: string; label?: string }>;
        models?: Array<{ productId: string; variantId?: string; model: string; label?: string }>;
        references?: Array<{ productId: string; variantId?: string; image: string; label?: string }>;
      };
      if (mode === 'add' && submittedLabel !== '') {
        const added = manifestOut.views.find((entry) =>
          entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId &&
          entry.view === viewKey && entry.image === plan.assetPath);
        if (added) added.label = submittedLabel;
      }
      const assetPath = plan.assetPath;
      const replacedAssetPath = plan.replacedAssetPath;
      const newManifestBytes = new TextEncoder().encode(JSON.stringify(manifestOut));
      const skipPaths = new Set<string>([PRESENTATION_MANIFEST_PATH, PHOTO_MAPPINGS_PATH, OPERATION_ANCHORS_PATH, assetPath]);
      // Replacing a view image also retires its two-click span evidence:
      // sidecars naming the superseded image path are dropped (their photo
      // is gone). Other sidecars ride along byte-identical. Unparseable
      // files under the span directory are kept as inert evidence.
      const retiredSpanPaths = new Set<string>();
      if (replacedAssetPath !== undefined) {
        for (const asset of snapshot.assets) {
          if (asset.kind !== 'additional' || !asset.path.startsWith(`${SETUP_SPAN_DIR}/`)) continue;
          const parsedSpan = parseSpanSidecar(asset.bytes);
          if (parsedSpan.ok && parsedSpan.sidecar.imagePath === replacedAssetPath) {
            retiredSpanPaths.add(asset.path);
          }
        }
        for (const path of retiredSpanPaths) skipPaths.add(path);
      }
      const carriedAdditional = snapshot.assets
        .filter((asset) => asset.kind === 'additional' && !skipPaths.has(asset.path))
        .map(({ path, bytes: assetBytes }) => ({ path, bytes: assetBytes }));
      const base = parsePhotoMappings(snapshot.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes);
      const baseKept = (base?.mappings ?? []).filter((candidate) => !invalidated.has(mappingKeyOf(candidate)));
      const stagedKept = stagedPhotoMappings.filter((candidate) => !invalidated.has(mappingKeyOf(candidate)));
      const mergedMappings = mergeSessionPhotoMappings({ version: 1, mappings: baseKept }, stagedKept);
      const mergedBytes = mergedMappings.mappings.length > 0 ? serializePhotoMappings(mergedMappings) : null;
      const additionalAssets: Array<{ path: string; bytes: Uint8Array }> = [
        ...carriedAdditional,
        { path: assetPath, bytes: bytes.slice() },
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
      if (!beforeProduct || !afterProduct || canonicalize(afterProduct) !== canonicalize(beforeProduct)) {
        throw new Error('The reparse changed product geometry; the previous project is unchanged.');
      }
      // Positive reparse verification through the flexible reader: the new
      // view entry must roundtrip with exact bytes.
      let backRaw: unknown = null;
      {
        const backBytes = reparsed.assets.find((asset) => asset.path === PRESENTATION_MANIFEST_PATH)?.bytes;
        if (backBytes !== undefined) {
          try {
            backRaw = JSON.parse(new TextDecoder().decode(backBytes));
          } catch {
            backRaw = null;
          }
        }
      }
      const backParsed = parseFlexiblePresentationManifest(backRaw);
      const backEntry = backParsed !== null ? backParsed.views.find((entry) =>
        entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId &&
        entry.view === viewKey && entry.image === assetPath) : undefined;
      if (!backEntry) {
        throw new Error('The reparse lost the new view image; the previous project is unchanged.');
      }
      const backPhotoBytes = reparsed.assets.find((asset) => asset.path === assetPath)?.bytes;
      if (!backPhotoBytes || backPhotoBytes.length !== bytes.length) {
        throw new Error('The reparse lost the new view image bytes; the previous project is unchanged.');
      }
      if (replacedAssetPath !== undefined) {
        const beforeEvidence = snapshot.assets.find((asset) => asset.path === replacedAssetPath)?.bytes;
        const afterEvidence = reparsed.assets.find((asset) => asset.path === replacedAssetPath)?.bytes;
        if (!beforeEvidence || !afterEvidence || beforeEvidence.length !== afterEvidence.length ||
          !beforeEvidence.every((value, index) => value === afterEvidence[index])) {
          throw new Error('The reparse lost the superseded view image evidence; the previous project is unchanged.');
        }
      }
      const backMappings = parsePhotoMappings(reparsed.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH)?.bytes);
      const staleBack = (backMappings?.mappings ?? []).filter((candidate) => invalidated.has(mappingKeyOf(candidate)));
      if (staleBack.length > 0) {
        throw new Error('The reparse kept a retired photo mapping; the previous project is unchanged.');
      }
      if (!fresh() || source !== snapshot) return;
      stagedPhotoMappings = stagedKept;
      source = replaceSessionProject(snapshot, reparsed.project, reparsed.assets, packageBytes.slice());
      if (replacedAssetPath !== undefined) {
        // Retire staged drafts bound to the superseded photo/scope — but
        // only when no other manifest entry still references that path.
        const shared = flexible !== null && [...flexible.views, ...(flexible.references ?? [])].some(
          (entry) => entry.image === replacedAssetPath &&
            !(entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId),
        );
        if (!shared) {
          draftRetirements.push({
            kind: 'photo-replaced',
            productId: product.id,
            ...(scopeVariantId !== undefined ? { variantId: scopeVariantId } : {}),
            imagePath: replacedAssetPath,
          });
        }
      }
      refreshWorkspace();
      // The package changed under any generated delivery: mark outputs stale
      // and refresh the issue gate so a regen is required before download.
      invalidateOutputsForEdit();
      refreshSelectionValidation();
      // Post-commit the source identity has intentionally changed, so only
      // the generation guard still applies before reporting success.
      if (generation !== productGeneration) return;
      if (mode === 'add') productPhotoNewLabel.value = '';
      productPhotoStatus.textContent = mode === 'add'
        ? `Added view image “${humanLabel}” to ${scope}. It starts unmeasured — set it up on the photo workspace before authoring. Product, model, other views, logos and measurements are unchanged.`
        : `Replaced view image “${humanLabel}” on ${scope}. ${invalidated.size} photo mapping${invalidated.size === 1 ? ' was' : 's were'} retired${retiredSpanPaths.size > 0 ? ` and its two-click span reference was retired` : ''}; the superseded photo stays in the package as evidence and other views sharing it are unchanged. Set up measurements on the new photo before authoring.`;
    }, () => {
      productPhotoStatus.textContent = `Could not attach ${submittedFileName}: the project changed before the attach started; choose the file again. Previous products are unchanged.`;
    });
  } catch (error) {
    if (fresh()) {
      productPhotoStatus.textContent = `Could not attach ${submittedFileName}: ${error instanceof Error ? error.message : String(error)}`;
      alertBuilder(`The view image could not be attached. Previous products are unchanged.`);
    }
  } finally {
    photoAttaching = false;
    updateControls();
  }
}

/** Fresh stable slug for an in-place view add: monotonic counter, skipping
 * ids already present in the current package (e.g. after reopening a
 * slug-view package whose counter restarted). Bounded attempts; the caller
 * treats exhaustion as a plain failure. */
function mintFreshViewSlug(): string {
  const taken = new Set<string>();
  if (source !== null) {
    const bytes = sessionAssetMap().get(PRESENTATION_MANIFEST_PATH);
    if (bytes !== undefined) {
      try {
        const flex = parseFlexiblePresentationManifest(JSON.parse(new TextDecoder().decode(bytes)));
        if (flex !== null) {
          for (const entry of flex.views) taken.add(entry.view);
        }
      } catch {
        /* unreadable manifest: planner refuses atomically downstream */
      }
    }
  }
  let candidate = `view-${++stagedIntakeViewSeq}`;
  for (let guard = 0; guard < 1000 && taken.has(candidate); guard += 1) {
    candidate = `view-${++stagedIntakeViewSeq}`;
  }
  return candidate;
}

function onProductPhotoAddFileChange(): void {
  const file = productPhotoAddFile.files?.[0];
  productPhotoAddFile.value = '';
  if (!file) return;
  // A fresh stable slug id for the new view (never the mutable label).
  void attachProductPhotoFile(file, mintFreshViewSlug());
}

/**
 * Rename an EXISTING calibrated view's human label without touching its
 * stable id, image bytes, calibration, anchors or safe areas. The renamed
 * manifest commits through the proven repackage-and-reparse roundtrip: the
 * domain project must roundtrip byte-identical and the entry must keep its
 * exact id and image path, or nothing is committed. Mappings, staged drafts
 * and workspace buckets are keyed by stable id, so nothing retires; the
 * rename only marks generated deliveries stale so they regenerate.
 */
async function renameExistingView(viewKey: string, rawLabel: string): Promise<void> {
  if (source === null || loading || creating || logoImporting || productImporting || photoAttaching) {
    if (source === null) {
      productPhotoStatus.textContent = 'Create or open a project before renaming a view image.';
      alertBuilder('Create or open a project first. The previous project is unchanged.');
    }
    return;
  }
  const label = rawLabel.trim().slice(0, 80);
  if (label.length === 0) {
    productPhotoStatus.textContent = 'Could not rename the view image: enter a name of 1–80 characters. Previous products are unchanged.';
    return;
  }
  // Capture ALL submission state BEFORE any await: source identity, session,
  // workspace selection, scope and view key. Later awaits must never read
  // live UI state, so a mid-rename switch cannot rename elsewhere.
  const submittedSource = source;
  const submittedSession = sourceSession;
  const submittedProductId = workspaceProductId;
  const submittedVariantId = workspaceVariantId;
  const submittedWholeProduct = productPhotoScope.value === 'product';
  const generation = ++productGeneration;
  const fresh = (): boolean => generation === productGeneration && source === submittedSource && sourceSession === submittedSession;
  alertBuilder();
  photoAttaching = true;
  updateControls();
  productPhotoStatus.textContent = `Renaming view image to “${label}”…`;
  try {
    await enqueueWorkspaceCommit(async () => {
      if (!fresh() || source === null) {
        productPhotoStatus.textContent = `Could not rename the view image: the project changed while renaming; try again. Previous products are unchanged.`;
        return;
      }
      const snapshot = source;
      const products = snapshot.project.products;
      const product = products.find((entry) => entry.id === submittedProductId) ?? products[0] ?? null;
      if (product === null) {
        productPhotoStatus.textContent = `Could not rename the view image: no product is in the project; add a product first.`;
        return;
      }
      const variant = product.variants.find((entry) => entry.id === submittedVariantId) ?? product.variants[0] ?? null;
      if (variant === null) {
        productPhotoStatus.textContent = `Could not rename the view image: the selected product has no option; reopen the project and try again.`;
        return;
      }
      const scopeVariantId = submittedWholeProduct ? undefined : variant.id;
      const assets = sessionAssetMap();
      const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
      let rawManifest: unknown = null;
      if (manifestBytes !== undefined) {
        try {
          rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
        } catch {
          rawManifest = null;
        }
      }
      const flexible = parseFlexiblePresentationManifest(rawManifest);
      const current = flexible !== null ? flexible.views.find((entry) =>
        entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId &&
        entry.view === viewKey) : undefined;
      if (current === undefined) {
        productPhotoStatus.textContent = `Could not rename the view image: the view is no longer in this product or option. Previous products are unchanged.`;
        return;
      }
      if ((current.label ?? '') === label) {
        productPhotoStatus.textContent = `The view image is already named “${label}”. Nothing was changed.`;
        return;
      }
      const renamed = renameIntakeViewLabel(rawManifest, {
        productId: product.id,
        ...(scopeVariantId !== undefined ? { variantId: scopeVariantId } : {}),
        view: viewKey,
        label,
      });
      if (!renamed.ok) {
        productPhotoStatus.textContent = `Could not rename the view image: ${renamed.message}. Previous products are unchanged.`;
        return;
      }
      const newManifestBytes = new TextEncoder().encode(JSON.stringify(renamed.manifest));
      const carriedAdditional = snapshot.assets
        .filter((asset) => asset.kind === 'additional' && asset.path !== PRESENTATION_MANIFEST_PATH)
        .map(({ path, bytes }) => ({ path, bytes }));
      const packageBytes = await createProjectPackage(
        {
          project: snapshot.project,
          assets: snapshot.assets.filter((asset) => asset.kind !== 'additional').map(({ path, bytes }) => ({ path, bytes })),
          additionalAssets: [...carriedAdditional, { path: PRESENTATION_MANIFEST_PATH, bytes: newManifestBytes }],
        },
        { sha256: hasher.sha256Bytes },
      );
      if (!fresh() || source !== snapshot) return;
      const reparsed = await parseProjectPackage(packageBytes, { sha256: hasher.sha256Bytes });
      if (!fresh() || source !== snapshot) return;
      // Verify the roundtrip before committing: the domain project must be
      // semantically identical (rename touches only the presentation
      // manifest) and the entry must keep its exact id and image with the
      // new label. Comparison is canonical (key order is not significant:
      // package serialization sorts keys, so JSON.stringify would cry wolf
      // after any logo import that appends keys in schema order).
      if (canonicalize(reparsed.project) !== canonicalize(snapshot.project)) {
        throw new Error('The reparse changed the project; the previous project is unchanged.');
      }
      let backRaw: unknown = null;
      {
        const backBytes = reparsed.assets.find((asset) => asset.path === PRESENTATION_MANIFEST_PATH)?.bytes;
        if (backBytes !== undefined) {
          try {
            backRaw = JSON.parse(new TextDecoder().decode(backBytes));
          } catch {
            backRaw = null;
          }
        }
      }
      const backParsed = parseFlexiblePresentationManifest(backRaw);
      const backEntry = backParsed !== null ? backParsed.views.find((entry) =>
        entry.productId === product.id && (entry.variantId ?? undefined) === scopeVariantId &&
        entry.view === viewKey) : undefined;
      if (!backEntry || backEntry.image !== current.image || backEntry.label !== label) {
        throw new Error('The reparse lost the renamed view image; the previous project is unchanged.');
      }
      if (!fresh() || source !== snapshot) return;
      source = replaceSessionProject(snapshot, reparsed.project, reparsed.assets, packageBytes.slice());
      // Identity is unchanged, so no draft or mapping retires. Release the
      // busy guard BEFORE repainting so the rows, tabs and status refresh.
      photoAttaching = false;
      updateControls();
      refreshWorkspace();
      // The package changed under any generated delivery: mark outputs stale
      // and refresh the issue gate so a regen is required before download.
      invalidateOutputsForEdit();
      refreshSelectionValidation();
      // Post-commit the source identity has intentionally changed, so only
      // the generation guard still applies before reporting success.
      if (generation !== productGeneration) return;
      productPhotoStatus.textContent = `Renamed view image to “${label}”. Measurements, calibration, anchors and safe areas are unchanged.`;
    }, () => {
      productPhotoStatus.textContent = `Could not rename the view image: the project changed before the rename started; try again. Previous products are unchanged.`;
    });
  } catch (error) {
    if (fresh()) {
      productPhotoStatus.textContent = `Could not rename the view image: ${error instanceof Error ? error.message : String(error)}`;
      alertBuilder(`The view image could not be renamed. Previous products are unchanged.`);
    }
  } finally {
    photoAttaching = false;
    updateControls();
  }
}
saveMaster.addEventListener('click', () => void downloadMasterFile());
logoAdd.addEventListener('click', () => logoFile.click());
logoFile.addEventListener('change', onLogoFileChange);
productChoose.addEventListener('click', () => productFile.click());
productAdd.addEventListener('click', () => void addProductFromStaged());
productFile.addEventListener('change', onProductFileChange);
intakeModeImages.addEventListener('change', () => setIntakeMode('images'));
intakeModeModel.addEventListener('change', () => setIntakeMode('model'));
productViewAdd.addEventListener('click', () => {
  const row = addIntakeViewRow();
  if (row !== null) rowLabelInput(row.id)?.focus();
});
productPhotoAddChoose.addEventListener('click', () => productPhotoAddFile.click());
productPhotoAddFile.addEventListener('change', onProductPhotoAddFileChange);
productPhotoScope.addEventListener('change', () => refreshPhotoAttachHint());
jobNew.addEventListener('click', () => void requestNewJob());
jobLandingCreate.addEventListener('click', () => void createEmptyProject());
jobLandingOpen.addEventListener('click', () => jobOpenFile.click());
jobLandingResponse.addEventListener('click', () => openApprovalResponseEntry());
jobOpen.addEventListener('click', () => jobOpenFile.click());
jobOpenFile.addEventListener('change', onJobOpenFileChange);
jobSave.addEventListener('click', () => void saveJobToFile());
jobResponse.addEventListener('click', () => openApprovalResponseEntry());
jobStep1.addEventListener('click', () => setJobStep('prepare'));
jobStep2.addEventListener('click', () => { if (canEnterPlacements()) setJobStep('placements'); else goNext(); });
jobStep3.addEventListener('click', () => {
  if (source === null) return;
  // Forward tabs enforce the same gates as primary actions: pending Step 2
  // edits route back to the exact apply control instead of reviewing stale geometry.
  if (placementHandle?.hasPendingEdits() === true) {
    setJobStep('placements');
    alertBuilder('Apply or discard the pending placement edits before review.');
    placementHandle.update();
    document.querySelector('[data-builder-hook="job-placement-host"] .pw-apply')?.scrollIntoView({ block: 'center' });
    (document.querySelector('[data-builder-hook="job-placement-host"] .pw-apply') as HTMLElement | null)?.focus();
    return;
  }
  setJobStep('review');
});
jobToPlacements.addEventListener('click', () => goNext());
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
/* ------------------------------------------------------------------ */
/* Operator module mounts: placement workspace, document review,        */
/* customer approval branch (shared renderer/export context).          */
/* ------------------------------------------------------------------ */

/** Issue-identity controls live inside the branch's collapsed More options
 * (advanced-only surface); they are created by the branch mount, so this
 * wiring runs post-mount and all readers resolve them lazily. */
let jobIssueProjectId!: HTMLInputElement;
let jobIssueProjectNew!: HTMLButtonElement;
function wireIssueIdentityControls(): void {
  jobIssueProjectId = hook<HTMLInputElement>('job-issue-project-id');
  jobIssueProjectNew = hook<HTMLButtonElement>('job-issue-project-new');
  jobIssueProjectNew.addEventListener('click', () => {
    mintFreshIssueId();
    jobIssueProjectId.focus();
  });
  jobIssueProjectId.addEventListener('input', () => {
    // Branch-local identity sync: never invalidate the approval step.
    // A full refreshSelectionValidation() would kick the operator back to
    // placements (invalidateOutputsForEdit) and remove the Create button
    // mid-flow. Sync the legacy input and mark dirty only.
    issueIdManual = true;
    projectIdInput.value = jobIssueProjectId.value;
    markJobDirty();
  });
}
customerName.addEventListener('input', () => markJobDirty());
jobRef.addEventListener('input', () => markJobDirty());
issuedBy.addEventListener('input', () => markJobDirty());

function jobAssetBytes(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (source) for (const asset of source.assets) out.set(asset.path, asset.bytes);
  return out;
}
function jobManifestBytes(): Uint8Array | undefined {
  return jobAssetBytes().get(PRESENTATION_MANIFEST_PATH);
}
function jobPresentationLookup(): (path: string) => Uint8Array | undefined {
  const bytes = jobAssetBytes();
  return (path: string) => bytes.get(path);
}
function placementEmptyProject(): ProjectDocument {
  return { schemaVersion: '0.1.0-provisional', projectId: newLocalId(), revision: 1, products: [], logos: [], configurations: [] };
}
function jobLogoDataUrl(logoId: string): { src: string; alt: string } | null {
  if (!source) return null;
  const logo = source.project.logos.find((entry) => entry.id === logoId);
  const name = logo?.name ?? logoId;
  const assetRef = logo?.assets.find((asset) => /\.(png|jpe?g|webp)$/i.test(asset.uri)) ?? logo?.assets[0];
  const bytes = jobAssetBytes().get(assetRef?.uri ?? '');
  if (!bytes) return null;
  const mediaType = assetRef?.mediaType ?? 'image/png';
  try {
    const blob = new Blob([new Uint8Array(bytes)], { type: mediaType });
    return { src: URL.createObjectURL(blob), alt: name || logoId };
  } catch { return null; }
}
function jobViewRefs(productId: string): Array<{ id: string; label: string; imagePath: string }> {
  if (!source) return [];
  const manifestBytes = jobManifestBytes();
  const manifest = manifestBytes ? parsePresentationManifest(manifestBytes) : null;
  const present = manifestBytes !== undefined;
  const lookup = jobPresentationLookup();
  const seen = new Map<string, { label: string; imagePath: string }>();
  const variants = [...new Set(source.project.configurations.filter((config) => config.productId === productId).map((config) => config.variantId))];
  for (const variantId of (variants.length > 0 ? variants : [''])) {
    for (const view of selectPresentationViews(manifest, present, productId, variantId, lookup).views) {
      const id = view.view ?? 'default';
      if (!seen.has(id)) seen.set(id, { label: view.label ?? id, imagePath: view.imagePath });
    }
  }
  return [...seen.entries()].map(([id, ref]) => ({ id, ...ref }));
}
function jobProductViews(productId: string): Array<{ id: string; label: string }> {
  return jobViewRefs(productId).map(({ id, label }) => ({ id, label }));
}
/** Calibrated Images photo overlay for the exact selected scope, or null.
 * Uses the evaluated session mapping (staged over packaged) only when it
 * matches product + region + variant scope + view + image + calibration and
 * validates cleanly with a reviewed status. Anything else — unmapped views,
 * model products, missing bytes, invalid or trial-only mappings — returns
 * null so the workspace shows the authoritative region-mm diagram instead.
 * Millimetres always come from the region frame through the mapping; never
 * from pixels or mesh bounds. */
function jobStageOverlay(productId: string, variantId: string, regionId: string, viewId: string | null): PlacementStageOverlay | null {
  try {
    if (!source) return null;
    if (jobProductMediaKind(productId) !== 'images') return null;
    const product = source.project.products.find((entry) => entry.id === productId);
    if (!product) return null;
    const region = product.regions.find((entry) => entry.id === regionId);
    if (!region || region.safeArea.length < 3) return null;
    const views = jobViewRefs(productId);
    if (views.length === 0) return null;
    const activeId = viewId !== null && views.some((view) => view.id === viewId) ? viewId : views[0]!.id;
    const view = views.find((entry) => entry.id === activeId);
    if (!view) return null;
    const bytes = jobAssetBytes().get(view.imagePath);
    if (!bytes || bytes.length === 0) return null;
    const header = readRasterHeader(bytes);
    if (header === null) return null;
    const merged = workspaceMergedMappings();
    const candidates = merged.mappings.filter((entry) =>
      entry.productId === productId &&
      entry.regionId === regionId &&
      (entry.variantId === undefined || entry.variantId === variantId) &&
      mappingViewIdOf(entry) === activeId &&
      entry.image === view.imagePath &&
      entry.calibrationId === region.calibrationRef.calibrationId &&
      entry.calibrationVersion === region.calibrationRef.version &&
      (entry.status === 'review' || entry.status === 'provisional') &&
      validatePhotoMapping(entry).length === 0);
    // Exact-variant scope wins over product-wide mappings; never blended.
    candidates.sort((a, b) => Number(b.variantId !== undefined) - Number(a.variantId !== undefined));
    const mapping = candidates[0];
    if (!mapping) return null;
    const { a, b, c, d, e, f } = mapping.transform;
    const det = a * e - b * d;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const widthPx = header.width;
    const heightPx = header.height;
    const src = bytesToDataUrl(bytes, header.mediaType);
    if (!src) return null;
    const provisional = mapping.status === 'provisional';
    return {
      imageSrc: src,
      imageWidthPx: widthPx,
      imageHeightPx: heightPx,
      alt: provisional
        ? `Provisional calibrated preview of ${view.label} over ${region.name?.trim() || region.id} — verify physical measurements before production`
        : `${view.label} photo overlay for ${region.name?.trim() || region.id}`,
      mappingStatus: mapping.status,
      mmToPx: (xMm: number, yMm: number) => {
        const x = (a * xMm + b * yMm + c) * widthPx;
        const y = (d * xMm + e * yMm + f) * heightPx;
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      },
      pxToMm: (x: number, y: number) => {
        const u = x / widthPx;
        const v = y / heightPx;
        const xMm = (e * (u - c) - b * (v - f)) / det;
        const yMm = (-d * (u - c) + a * (v - f)) / det;
        return Number.isFinite(xMm) && Number.isFinite(yMm) ? { xMm, yMm } : null;
      },
    };
  } catch {
    return null;
  }
}
function jobProductMediaKind(productId: string): 'images' | 'model' | 'none' {
  if (!source) return 'none';
  const manifestBytes = jobManifestBytes();
  const manifest = manifestBytes ? parsePresentationManifest(manifestBytes) : null;
  const present = manifestBytes !== undefined;
  const lookup = jobPresentationLookup();
  const variants = [...new Set(source.project.configurations.filter((config) => config.productId === productId).map((config) => config.variantId))];
  for (const variantId of (variants.length > 0 ? variants : [''])) {
    if (selectPresentationModel(manifest, present, productId, variantId, lookup).modelPath !== null) return 'model';
    if (selectPresentationViews(manifest, present, productId, variantId, lookup).views.length > 0) return 'images';
  }
  return 'none';
}
function commitPlacementProject(label: string, next: ProjectDocument): { ok: true } | { ok: false; error: string } {
  void label;
  if (!source) return { ok: false, error: 'No job open.' };
  try {
    assertProjectEditorLimits(next);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  source = replaceSessionProject(source, next);
  markJobDirty();
  reprepareJobDigest();
  // Editing/drag/apply invalidates generated files, confirmations and review
  // status per the revision contracts; navigation alone changes nothing.
  invalidateOutputsForEdit();
  if (placementHandle && jobStep === 'placements') placementHandle.update();
  if (reviewHandle) reviewHandle.update();
  if (approvalHandle) approvalHandle.notifyJobChanged();
  return { ok: true };
}
function focusProductSetup(productId: string, variantId?: string): void {
  // Exact scoped routing: the workspace ids are set first and the variant
  // list is rebuilt before selecting, so the opened scope is exactly the
  // requested one — never a stale previous product. Unknown ids fail loudly.
  if (source === null) {
    setJobStep('prepare');
    alertBuilder('No job is open; create or open a job first.');
    return;
  }
  const product = source.project.products.find((entry) => entry.id === productId);
  if (!product) {
    setJobStep('prepare');
    alertBuilder(`The requested product is no longer in this job. Choose a current product below.`);
    return;
  }
  workspaceProductId = productId;
  if (variantId !== undefined) {
    if (!product.variants.some((entry) => entry.id === variantId)) {
      setJobStep('prepare');
      alertBuilder(`The requested option is no longer on this product. Choose a current option below.`);
      return;
    }
    workspaceVariantId = variantId;
  } else if (!product.variants.some((entry) => entry.id === workspaceVariantId)) {
    workspaceVariantId = product.variants[0]?.id ?? null;
  }
  workspaceViewHint = null;
  guidedScale.hide();
  alertBuilder();
  setJobStep('prepare');
  refreshWorkspace();
  workspaceBox.scrollIntoView({ block: 'start' });
}
function mountJobModules(): void {
  try {
    placementHandle = mountPlacementWorkspace(jobPlacementHost, {
      getProject: () => source?.project ?? placementEmptyProject(),
      getSelection: () => ({ ...(source?.selection ?? emptySelection()) }),
      setSelection: (patch) => { if (source) source.selection = { ...source.selection, ...patch }; },
      commit: (label, next) => commitPlacementProject(label, next),
      newPlacementId: () => newLocalId(),
      getProductViews: (productId) => jobProductViews(productId),
      getProductMediaKind: (productId) => jobProductMediaKind(productId),
      getStageOverlay: (productId, variantId, regionId, viewId) => jobStageOverlay(productId, variantId, regionId, viewId),
      getLogoImage: (logoId) => jobLogoDataUrl(logoId),
      getAnchors: (productId, variantId, regionId) =>
        (source?.anchors ?? []).filter((anchor) => anchor.productId === productId && anchor.variantId === variantId && anchor.regionId === regionId),
      getBindings: (configurationId) => [...(source?.bindings[configurationId] ?? [])],
      setBindings: (configurationId, bindings) => {
        if (!source) return;
        source.bindings[configurationId] = [...bindings];
        markJobDirty();
        reprepareJobDigest();
        if (reviewHandle) reviewHandle.update();
      },
      getTechnique: (configurationId, logoRef) => ({ ...(source?.logoTechnique[configurationId]?.[logoRef] ?? emptyLogoTechnique()) }),
      setTechnique: (configurationId, logoRef, technique) => {
        if (!source) return;
        const perLogo = source.logoTechnique[configurationId] ?? emptyRecord();
        perLogo[logoRef] = { ...technique };
        source.logoTechnique[configurationId] = perLogo;
        markJobDirty();
        if (reviewHandle) reviewHandle.update();
      },
      getIncludedLogoIds: () => {
        try {
          if (source === null) return null;
          return [...readSelection().logoIds];
        } catch { return null; }
      },
      getIncludedScope: () => {
        try {
          if (source === null) return null;
          const inclusion = currentInclusion();
          return { productIds: inclusion.includedProducts, configurationIds: inclusion.includedConfigurations };
        } catch { return null; }
      },
      requestProductSetup: (productId, variantId) => focusProductSetup(productId, variantId),
      onViewModel: (productId) => focusProductSetup(productId),
      onAddLogo: () => { setJobStep('prepare'); logoAdd.focus(); },
      onReview: () => setJobStep('review'),
      onApprovalBranch: () => setJobStep('approval'),
      onBack: () => setJobStep('prepare'),
      onStatus: (message) => alertBuilder(message),
    });
  } catch (error) {
    alertBuilder(`Placement workspace unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    reviewHandle = mountDocumentReview(jobReviewHost, {
      readSnapshot: () => readReviewSnapshot(),
      requestPrint: () => globalThis.print(),
      saveJob: () => void saveJobToFile(),
      saveOperatorData: (view) => {
        const safeRef = (jobRef.value.trim() || 'job').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'job';
        downloadBytes(new TextEncoder().encode(JSON.stringify(buildOperatorExport(view), null, 2)), `${safeRef}-operator-data.json`, 'application/json');
      },
      saveDiagnosticData: (text, suggestedFileName) => {
        downloadBytes(new TextEncoder().encode(text), suggestedFileName, 'application/json');
      },
      goBackToPlacements: () => setJobStep('placements'),
      fixItem: (target) => fixReviewItem(target),
      commitInstructions: (text) => {
        if (source && source.instructions !== text) {
          source.instructions = text;
          markJobDirty();
          if (reviewHandle && jobStep === 'review') reviewHandle.update();
        }
      },
      commitTechnique: (patch) => {
        if (!source) return;
        const next = { ...source.technique, ...patch };
        if (JSON.stringify(next) !== JSON.stringify(source.technique)) {
          source.technique = next;
          markJobDirty();
          if (reviewHandle && jobStep === 'review') reviewHandle.update();
        }
      },
    });
  } catch (error) {
    alertBuilder(`Review document unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    approvalHandle = mountCustomerApproval(jobApprovalHost, {
      readJob: () => readApprovalJob(),
      hasUnappliedEdits: () => placementHandle?.hasPendingEdits() ?? false,
      prepareProject: (project) => hasher.prepareProject(project),
      sha256Hex: hasher.sha256Hex,
      sha256Bytes: hasher.sha256Bytes,
      readEditorBytes: () => embeddedEditorBytes(),
      sanitizeJobPart: (value) => safeJobPart(value),
      downloadBytes: (bytes, fileName, mime) => downloadBytes(bytes, fileName, mime),
      readAdditionalAssets: () => readBranchAdditionalAssets(),
      backToPlacements: () => setJobStep('placements'),
      fixIdentity: (field) => {
        if (field === 'project') {
          setJobStep('approval');
          if (approvalHandle) approvalHandle.openMoreOptions();
          jobIssueProjectId.focus();
          return;
        }
        setJobStep('prepare');
        (field === 'customer' ? customerName : jobRef).focus();
      },
      fixPlacements: () => setJobStep('placements'),
      mintFreshIssueId: () => mintFreshIssueId(),
      isIssueIdManual: () => issueIdManual,
      useCustomerChanges: (project, assets) => installCustomerResponse(project, assets),
    });
  } catch (error) {
    alertBuilder(`Customer approval branch unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
/** Local direct path authoring context: recomputed from the current job via
 * buildCandidateExport. Never a return/baseline, never invented confirmation. */
function scopedJobProject(): ProjectDocument | null {
  if (!source) return null;
  const scoped: ProjectDocument = JSON.parse(JSON.stringify(source.project)) as ProjectDocument;
  try {
    const included = new Set(scopedConfigurationIds(readSelection()));
    scoped.configurations = scoped.configurations.filter((config) => included.has(config.id));
  } catch { /* scoping is best-effort; the full job still renders */ }
  return scoped;
}
function readReviewSnapshot(): import('./document-review.js').DocumentReviewSnapshot | null {
  if (!source) return null;
  const project = scopedJobProject() ?? source.project;
  let candidate: ResultCandidate | null = null;
  let candidateError: string | null = null;
  try {
    const context = createOperatorAuthoringContext({
      project,
      assets: jobAssetBytes(),
      sha256Hex: hasher.sha256Hex,
      identity: {
        ...(customerName.value.trim() ? { customer: customerName.value.trim() } : {}),
        ...(jobRef.value.trim() ? { jobReference: jobRef.value.trim() } : {}),
        ...(issuedBy.value.trim() ? { preparedBy: issuedBy.value.trim() } : {}),
      },
      referenceViews: {},
    });
    candidate = context.candidate;
  } catch (error) {
    candidateError = error instanceof Error ? error.message : String(error);
  }
  const bytes = jobAssetBytes();
  const manifestBytes = bytes.get(PRESENTATION_MANIFEST_PATH);
  let referenceViews: Record<string, readonly import('../../core/operation-document/types.js').ReferenceViewInput[]> = emptyRecord();
  try {
    const selections = selectOperationReferenceViews(project.configurations, manifestBytes, manifestBytes !== undefined, { getBytes: (path) => bytes.get(path) });
    const mapped: Record<string, readonly import('../../core/operation-document/types.js').ReferenceViewInput[]> = emptyRecord();
    for (const [id, selection] of Object.entries(selections)) mapped[id] = selection.views;
    referenceViews = mapped;
  } catch { referenceViews = emptyRecord(); }
  const { bindings, extras } = sessionDocumentInputs(source);
  const unapplied: ReviewUnappliedEdit[] = (placementHandle?.pendingEdits() ?? []).map((pending) => ({
    label: pending.label,
    target: { kind: 'placement', productId: pending.productId, variantId: pending.variantId, configId: pending.configId, placementIndex: pending.placementIndex, ...(pending.placementId !== undefined ? { placementId: pending.placementId } : {}) },
  }));
  return {
    project,
    candidate,
    candidateError,
    assetBytes: bytes,
    referenceViews,
    anchors: [...source.anchors],
    bindings,
    extras,
    job: {
      ...(customerName.value.trim() ? { customer: customerName.value.trim() } : {}),
      ...(jobRef.value.trim() ? { reference: jobRef.value.trim() } : {}),
    },
    instructionsText: source.instructions,
    technique: { ...source.technique },
    techniqueScopeLabel: null,
    unapplied,
  };
}
function fixReviewItem(target: ReviewFixTarget): void {
  if (target.kind === 'identity') {
    setJobStep('prepare');
    (target.field === 'customer' ? customerName : jobRef).focus();
    return;
  }
  if (target.kind === 'products') {
    setJobStep('prepare');
    productList.scrollIntoView({ block: 'start' });
    productName.focus();
    return;
  }
  if (target.kind === 'option') {
    if (!source) { setJobStep('prepare'); return; }
    source.selection = { productId: target.productId, variantId: target.variantId, viewId: null, placementId: null };
    focusProductSetup(target.productId, target.variantId);
    return;
  }
  if (!source) { setJobStep('prepare'); return; }
  source.selection = { productId: target.productId, variantId: target.variantId, viewId: null, placementId: target.placementId ?? null };
  if (placementHandle) placementHandle.update();
  setJobStep('placements');
}
/** Optional branch job source: current job scoped to the Step 1 inclusion
 * (unselected products stay editable, omitted only from this issue output). */
function readApprovalJob(): import('./customer-approval.js').ApprovalJobSource | null {
  if (!source) return null;
  const scoped: ProjectDocument = JSON.parse(JSON.stringify(source.project)) as ProjectDocument;
  const fallback = {
    project: scoped,
    assets: source.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes, kind: asset.kind })),
    identity: {
      customerLabel: customerName.value,
      jobReference: jobRef.value,
      issuedBy: issuedBy.value,
      projectId: jobIssueProjectId.value || projectIdInput.value,
    },
  };
  try {
    const selection = readSelection();
    const included = new Set(scopedConfigurationIds(selection));
    const productIds = new Set(selection.productIds);
    const logoIds = new Set(selection.logoIds);
    scoped.configurations = scoped.configurations.filter((config) => included.has(config.id));
    scoped.products = scoped.products.filter((product) => productIds.has(product.id));
    const usedLogos = new Set<string>();
    for (const config of scoped.configurations) for (const placement of config.placements) usedLogos.add(placement.logoId);
    scoped.logos = scoped.logos.filter((logo) => logoIds.has(logo.id) || usedLogos.has(logo.id));
    const assets = source.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes, kind: asset.kind }));
    return { ...fallback, project: scoped, assets };
  } catch {
    return fallback;
  }
}
/** Presentation/evidence passthrough for the branch issue (mirrors the
 * issued-package additional-asset contract; evidence only, never geometry).
 * Staged-but-unsaved session mappings merge over the package file by exact
 * key (same contract as the legacy issue path); saved entries persist. */
function readBranchAdditionalAssets(): Array<{ path: string; bytes: Uint8Array }> {
  if (!source) return [];
  const out = new Map<string, Uint8Array>();
  for (const asset of source.assets) {
    if (asset.kind !== 'additional') continue;
    if (asset.path === OPERATOR_JOB_SIDECAR_PATH) continue;
    out.set(asset.path, asset.bytes);
  }
  if (stagedPhotoMappings.length > 0) {
    const merged = serializePhotoMappings(mergeSessionPhotoMappings(
      parsePhotoMappings(out.get(PHOTO_MAPPINGS_PATH)),
      stagedPhotoMappings,
    ));
    out.set(PHOTO_MAPPINGS_PATH, merged);
  }
  return [...out.entries()].map(([path, bytes]) => ({ path, bytes }));
}
/** Install validated customer-response content: exact content, placements
 * rebuilt, notes stay read-only context, opens Step 2. No auto-merge beyond
 * this explicit operator action; no sources or baseline are lost. */
function installCustomerResponse(project: ProjectDocument, assets: Array<{ path: string; bytes: Uint8Array; kind: 'referenced' | 'additional' }>): void {
  suppressJobDirty = true;
  try {
    assertProjectEditorLimits(project);
    // Preserve office-authored definitions that still resolve in the
    // validated response (decision 14): carry the live authoring across the
    // project swap, then prune dead scope. Identity inputs reset below.
    const carried = source === null ? null : {
      instructions: source.instructions,
      technique: { ...source.technique },
      bindings: source.bindings,
      logoTechnique: source.logoTechnique,
      anchors: source.anchors,
    };
    sourceSession += 1;
    draftRetirements = [];
    logoImports = [];
    staffModelSnapshots.clear();
    areaManifestBaseline.clear();
    logoStatus.textContent = '';
    resetIntakeStaging();
    addedPresentations = [];
    productName.value = '';
    source = createEmptySession('customer-response', project, assets.map((asset) => ({ path: asset.path, bytes: asset.bytes, kind: asset.kind })), new Uint8Array(0));
    if (carried !== null) {
      source.instructions = carried.instructions;
      source.technique = carried.technique;
      source.bindings = carried.bindings;
      source.logoTechnique = carried.logoTechnique;
      source.anchors = carried.anchors;
    }
    configurationsTouched = false;
    renderSelectionLists(source.summary);
    stagedPhotoMappings = [];
    guidedScale.hide();
    refreshWorkspace();
    refreshAddProductDisclosure();
    refreshIntakeReadiness();
    pendingReplaceAction = null;
    issueIdManual = false;
    rebaseAuthoringOntoResponse(project);
    sourceStatus.textContent = `Customer response installed (revision ${source.summary.revision}): ${source.summary.productIds.length} products, ${source.summary.logoIds.length} logos, ${source.summary.configurationIds.length} setups.`;
    refreshSelectionValidation();
    ensureAutoProjectId();
    jobIssueProjectId.value = projectIdInput.value;
  } finally {
    suppressJobDirty = false;
  }
  setJobStep('placements');
  markJobDirty();
  reprepareJobDigest();
}
/** Rebase office-authored inputs onto a validated response project (decision
 * 14): keep binding definitions, anchors, technique and instructions whose
 * exact product/config/placement/frame/calibration identities still resolve
 * in the response; changed or missing scopes are dropped (never silently
 * rebound, never fabricated). Distances recompute at render from
 * the preserved definitions under the response geometry. The legacy
 * return-review mirror is refreshed from the session for its surviving
 * readers. */
function rebaseAuthoringOntoResponse(response: ProjectDocument): void {
  if (!source) return;
  rebaseSessionAuthoring(source, response);
}
function openApprovalResponseEntry(): void {
  if (!source) {
    jobLandingStatus.textContent = 'Create a job or open a saved job first, then open the customer response.';
    return;
  }
  setJobStep('approval');
  if (approvalHandle) approvalHandle.openResponseEntry();
}
mountJobModules();
wireIssueIdentityControls();
setJobStep('landing');

/* ------------------------------------------------------------------ */
/* Product-preparation anchor + safe-area setup (Choose items).        */
/* Prepare context only: named anchors are authored against the source */
/* product and travel in the saved master as a versioned sidecar; a    */
/* staged safe-area proposal can be APPLIED into the in-memory source  */
/* product (validated; selection re-validates; the saved master then   */
/* carries it for reuse). Review/return context never mutates product  */
/* geometry — proposals stay proposals there.                         */
/* ------------------------------------------------------------------ */

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
  return loading || creating || logoImporting || productImporting || photoAttaching || source === null;
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

async function loadAnchorsSidecar(assets: ProjectPackageAsset[], project: ProjectDocument): Promise<AnchorDef[]> {
  const raw = assets.find((asset) => asset.path === OPERATION_ANCHORS_PATH)?.bytes;
  if (!raw) return [];
  if (raw.length > OPERATION_ANCHORS_MAX_BYTES) {
    masterStatus.textContent = `Anchors sidecar ignored: exceeds the 256 KiB sidecar bound. The source product is unchanged.`;
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    masterStatus.textContent = `Anchors sidecar ignored: not valid JSON. The source product is unchanged.`;
    return [];
  }
  if (!isOperationAnchorsSidecar(parsed)) {
    masterStatus.textContent = `Anchors sidecar ignored: not an operation-anchors/1 sidecar. The source product is unchanged.`;
    return [];
  }
  if (parsed.projectId !== project.projectId) {
    masterStatus.textContent = `Anchors sidecar ignored: saved for project “${parsed.projectId}”. The source product is unchanged.`;
    return [];
  }
  const digest = await hasher.prepareProject(project);
  if (parsed.sourceDigest !== digest) {
    masterStatus.textContent =
      `Anchors sidecar refused as stale (master changed since the anchors were saved): re-author anchors in the setup below. The source product is unchanged.`;
    return [];
  }
  const anchors = parsed.anchors
    .filter((entry) => project.products.some((product) =>
      product.id === entry.productId &&
      product.variants.some((variant) => variant.id === entry.variantId) &&
      product.regions.some((region) => region.id === entry.regionId)))
    .map((entry) => ({ ...entry }));
  if (anchors.length > 0) {
    masterStatus.textContent = `Loaded ${anchors.length} prepared anchor(s) from the master sidecar.`;
  }
  return anchors;
}

let stagedPhotoMappings: PhotoMappingEntry[] = [];

function mappingKeyOf(entry: PhotoMappingEntry): string {
  return `${entry.productId}\0${entry.variantId ?? ''}\0${entry.regionId}\0${mappingViewIdOf(entry)}\0${entry.image}`;
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
/** First-tab hint by stable view id (legacy side or slug; used until the operator picks a tab). */
let workspaceViewHint: string | null = null;

function workspaceSideLabel(side: ProductSetupSide): string {
  return side === 'front' ? 'Front' : side === 'back' ? 'Back' : side === 'left' ? 'Left' : 'Right';
}

/**
 * Display name for one workspace view: the stored human label when present,
 * the capitalized legacy side otherwise, or the raw stable id for slug views
 * without a label. Labels never identify.
 */
function workspaceViewDisplayName(viewId: string, label: string | null | undefined): string {
  const text = label?.trim() ?? '';
  if (text.length > 0) return text;
  if (viewId === 'front' || viewId === 'back' || viewId === 'left' || viewId === 'right') {
    return `${viewId[0]!.toUpperCase()}${viewId.slice(1)}`;
  }
  return viewId;
}

/**
 * Suffix-safe display noun for status/region messages that append their own
 * " view"/" photo" words: the capitalized legacy side for legacy views,
 * else the human label (or raw id). Prevents "Front view view" doubling
 * when a legacy manifest carries a label like "Front view".
 */
function workspaceViewNoun(viewId: string, label: string | null | undefined): string {
  if (!isLegacyViewId(viewId)) {
    const text = label?.trim() ?? '';
    return text.length > 0 ? text : viewId;
  }
  return `${viewId[0]!.toUpperCase()}${viewId.slice(1)}`;
}

/**
 * Legacy four-side bucket for mapping math on flexible views. Legacy views
 * keep their side; slug views use an inert `front` bucket — resolution and
 * identity always run on the stable view id (`viewId`), never this bucket.
 */
function legacyBucketFor(viewId: string): ProductSetupSide {
  return viewId === 'front' || viewId === 'back' || viewId === 'left' || viewId === 'right' ? viewId : 'front';
}

interface WorkspacePhotoRef {
  /** Stable view identity: legacy side or slug id (never the label). */
  viewId: string;
  /** Human label, or null when the manifest carries none. */
  label: string | null;
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
 * packaged. Deterministic; same-identity duplicates from the Advanced editor
 * resolve to the most specific entry, never a blend. Identity is the stable
 * view id (labels never match).
 */
function workspaceMappingFor(
  productId: string,
  variantId: string,
  viewId: string,
  imagePath: string,
): PhotoMappingEntry | null {
  const merged = workspaceMergedMappings();
  const stagedKeys = new Set(stagedPhotoMappings.map((entry) => mappingKeyOf(entry)));
  const candidates = merged.mappings.filter((entry) =>
    entry.productId === productId && mappingViewIdOf(entry) === viewId && entry.image === imagePath &&
    (entry.variantId === undefined || entry.variantId === variantId));
  if (candidates.length === 0) return null;
  const score = (entry: PhotoMappingEntry): number =>
    // Scope regions first: sibling mappings (region ids containing the
    // sibling separator) must never resolve as the workspace scope — the
    // scope view always works through its own region.
    (entry.regionId.includes(SIBLING_REGION_SEPARATOR) ? 4 : 0) +
    (entry.variantId === variantId ? 0 : 2) + (stagedKeys.has(mappingKeyOf(entry)) ? 0 : 1);
  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0] ?? null;
}

/**
 * Photos available for one product/variant: flexible named manifest views
 * (legacy sides and slug ids alike, in manifest order); a v1 single
 * reference gains a tab once a mapping declares its view explicitly.
 * Missing views are absent, never invented; undecodable bytes become error
 * views. Variant-scoped entries win over product-wide ones per view id.
 */
function workspacePhotosFor(
  productId: string,
  variantId: string,
): { photos: WorkspacePhotoRef[]; warning: string | null } {
  const assets = sessionAssetMap();
  const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
  let rawManifest: unknown = null;
  if (manifestBytes !== undefined) {
    try {
      rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
      rawManifest = null;
    }
  }
  // Flexible reader first (v2/v3, legacy sides included); the legacy
  // customer-editor reader stays only for the v1-reference fallback below.
  const flexible = parseFlexiblePresentationManifest(rawManifest);
  if (flexible !== null) {
    const perView = new Map<string, { viewId: string; label: string | null; imagePath: string; variantScoped: boolean }>();
    for (const entry of flexible.views) {
      if (entry.productId !== productId) continue;
      if (entry.variantId !== undefined && entry.variantId !== variantId) continue;
      const current = perView.get(entry.view);
      if (current === undefined || (!current.variantScoped && entry.variantId === variantId)) {
        perView.set(entry.view, {
          viewId: entry.view,
          label: entry.label ?? null,
          imagePath: entry.image,
          variantScoped: entry.variantId === variantId,
        });
      }
    }
    const photos: WorkspacePhotoRef[] = [];
    for (const found of perView.values()) {
      const bytes = assets.get(found.imagePath);
      if (!bytes) continue;
      const header = readRasterHeader(bytes);
      if (!header) continue;
      photos.push({ viewId: found.viewId, label: found.label, imagePath: found.imagePath, bytes, widthPx: header.width, heightPx: header.height });
    }
    if (photos.length > 0 || flexible.views.length > 0) return { photos, warning: null };
  }
  const manifest = parsePresentationManifest(manifestBytes);
  const selection = selectPresentationViews(
    manifest,
    manifestBytes !== undefined,
    productId,
    variantId,
    (path) => assets.get(path),
  );
  const byId = new Map<string, { imagePath: string }>();
  for (const view of selection.views) {
    if (view.view === null) continue;
    if (!byId.has(view.view)) byId.set(view.view, { imagePath: view.imagePath });
  }
  if (manifest !== null && manifest.version === 1) {
    for (const single of selection.views) {
      if (single.view !== null) continue;
      for (const entry of workspaceMergedMappings().mappings) {
        if (entry.productId !== productId || entry.image !== single.imagePath) continue;
        if (entry.variantId !== undefined && entry.variantId !== variantId) continue;
        const id = mappingViewIdOf(entry);
        if (!byId.has(id)) byId.set(id, { imagePath: entry.image });
      }
    }
  }
  const photos: WorkspacePhotoRef[] = [];
  for (const [viewId, found] of byId) {
    const bytes = assets.get(found.imagePath);
    if (!bytes) continue;
    const header = readRasterHeader(bytes);
    if (!header) continue;
    photos.push({ viewId, label: null, imagePath: found.imagePath, bytes, widthPx: header.width, heightPx: header.height });
  }
  return { photos, warning: selection.warning };
}

function workspaceScopeFor(
  product: ProjectDocument['products'][number],
  variant: { id: string },
  region: ProjectDocument['products'][number]['regions'][number],
  viewId: string,
  viewLabel: string | null,
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
    side: legacyBucketFor(viewId),
    viewId,
    viewLabel,
  };
}

/** Empty scope for an unmeasured view: no region is bound to this view yet. */
function workspaceEmptyScope(productId: string, variantId: string, viewId: string, viewLabel: string | null): ProductSetupScope {
  return {
    productId,
    variantId,
    regionId: '',
    frameId: '',
    calibrationId: '',
    calibrationVersion: '',
    regionName: null,
    side: legacyBucketFor(viewId),
    viewId,
    viewLabel,
  };
}

/**
 * Saved A/B span evidence for ONE calibrated photo view (UV endpoints +
 * entered length), bound to the exact asset/view/calibration via the span
 * sidecar. Reads the `presentation/setup-calibration/*` bundle (pixel-native
 * endpoints ÷ photo size = UV). Null on any absence or mismatch — the
 * editing stage then draws no line and invents no length; a missing or
 * stale reference stays visibly incomplete.
 */
function workspaceReferenceSpan(
  productId: string,
  viewId: string,
  photo: WorkspacePhotoRef,
  region: { calibrationRef: { calibrationId: string; version: string } },
): ProductSetupReferenceSpan | null {
  if (!Number.isFinite(photo.widthPx) || !(photo.widthPx > 0)) return null;
  if (!Number.isFinite(photo.heightPx) || !(photo.heightPx > 0)) return null;
  const sidecarBytes = sessionAssetMap().get(
    spanSidecarPathFor(productId, viewId, spanPhotoVariantScope(photo.imagePath)),
  );
  if (!sidecarBytes) return null;
  const parsed = parseSpanSidecar(sidecarBytes);
  if (!parsed.ok) return null;
  const sidecar = parsed.sidecar;
  if (sidecar.productId !== productId) return null;
  if ((sidecar.viewId ?? sidecar.side) !== viewId) return null;
  if (sidecar.imagePath !== photo.imagePath) return null;
  if (sidecar.calibrationId !== region.calibrationRef.calibrationId) return null;
  const span = sidecar.bundle.spans[0];
  if (span === undefined) return null;
  if (typeof span.lengthMm !== 'number' || !(span.lengthMm > 0)) return null;
  // Images bundles carry 2D pixel-native endpoints; anything else (3D, NaN,
  // out-of-photo) is refused here — the view re-checks UV bounds anyway.
  if (!('x' in span.a) || !('y' in span.a) || 'z' in span.a) return null;
  if (!('x' in span.b) || !('y' in span.b) || 'z' in span.b) return null;
  const ax = span.a.x;
  const ay = span.a.y;
  const bx = span.b.x;
  const by = span.b.y;
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) return null;
  return {
    aUv: { u: ax / photo.widthPx, v: ay / photo.heightPx },
    bUv: { u: bx / photo.widthPx, v: by / photo.heightPx },
    lengthMm: span.lengthMm,
    calibrationId: sidecar.calibrationId,
    calibrationVersion: region.calibrationRef.version,
  };
}

function workspaceViewFor(
  product: ProjectDocument['products'][number],
  variant: { id: string },
  photo: WorkspacePhotoRef,
): ProductSetupPhotoView | { error: string } {
  const scopeProductId = product.id;
  const scopeVariantId = variant.id;
  const mapping = workspaceMappingFor(scopeProductId, scopeVariantId, photo.viewId, photo.imagePath);
  const photoId = workspacePhotoId(photo.imagePath, photo.bytes);
  const sourceRev = workspaceSourceRev();
  const display = workspaceViewDisplayName(photo.viewId, photo.label);
  const photoInput = {
    bytes: photo.bytes,
    widthPx: photo.widthPx,
    heightPx: photo.heightPx,
    label: `${product.name ?? product.id} — ${display} view`,
  };
  // A sibling mapping must never resolve as the workspace scope: when only
  // sibling mappings bind this photo (scope mapping removed), the view is
  // honestly unmeasured and routes back to setup.
  if (mapping && mapping.regionId.includes(SIBLING_REGION_SEPARATOR)) {
    return {
      scope: workspaceEmptyScope(scopeProductId, scopeVariantId, photo.viewId, photo.label),
      photoId,
      sourceRev,
      photo: photoInput,
      transform: null,
      mappingStatus: 'provisional',
      safeArea: [],
      anchors: [],
    };
  }
  if (!mapping) {
    return {
      scope: workspaceEmptyScope(scopeProductId, scopeVariantId, photo.viewId, photo.label),
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
    return { error: `The saved mapping for the ${display} view references missing region “${mapping.regionId}”. Re-measure this view with a reference span, or replace the view image (which retires its mapping and span evidence) and measure again.` };
  }
  const safePoints = region.safeArea
    .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => ({ x: point[0]!, y: point[1]! }));
  // Sibling named areas: same calibration/frame family, restored verbatim so
  // renames and multiple polygons survive save/reopen. Identity is by stable
  // area id only — coordinates never identify an area. The reopened active
  // entry comes from the explicit persisted hint; the polygon match below is
  // merely the documented deterministic fallback (first match) when the hint
  // is absent, e.g. legacy packages.
  const siblingRegions = product.regions
    .filter((entry) => isSiblingRegionId(region.id, entry.id) &&
      entry.calibrationRef.calibrationId === region.calibrationRef.calibrationId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const savedAreas = siblingRegions.map((entry) => ({
    id: areaIdFromSiblingRegionId(region.id, entry.id) ?? entry.id,
    name: entry.name ?? entry.id,
    points: entry.safeArea
      .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map((point) => ({ x: point[0]!, y: point[1]! })),
  }));
  const scopeJson = JSON.stringify(safePoints);
  const activeSibling = savedAreas.find((entry) => JSON.stringify(entry.points) === scopeJson);
  // Explicit persisted active id wins (stable across identical polygons);
  // otherwise the polygon match, else the view's deterministic fallback.
  const hintedActive = parseActiveAreasFile(sessionAssetMap().get(activeAreasPathFor(product.id)))[region.id] ?? null;
  return {
    scope: workspaceScopeFor(product, variant, region, photo.viewId, photo.label),
    photoId,
    sourceRev,
    photo: photoInput,
    transform: { ...mapping.transform },
    mappingStatus: mapping.status,
    safeArea: safePoints,
    anchors: (source?.anchors ?? [])
      .filter((anchor) =>
        anchor.productId === scopeProductId && anchor.variantId === scopeVariantId && anchor.regionId === region.id)
      .map((anchor) => ({ ...anchor, posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number] })),
    savedAreas,
    savedActiveAreaId: hintedActive ?? (activeSibling !== undefined ? activeSibling.id : null),
    referenceSpan: workspaceReferenceSpan(product.id, photo.viewId, photo, region),
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

function getWorkspaceInput(): ProductSetupWorkspaceInputV2 | { error: string } {
  if (source === null) {
    setWorkspaceNotice('Create or open a project first.');
    return { error: 'Create or open a project first, then add a real product.' };
  }
  const products = source.project.products;
  const product = products.find((entry) => entry.id === workspaceProductId) ?? products[0];
  if (product === undefined) {
    // Single inviting intake: no duplicated "workspace stays empty" block —
    // the Add-product form below is the one intake; this only points at it.
    const message = 'No product yet — name it and add views or a model under “Add a product” below, then set it up here.';
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
    // Model-only products measure on the 3D surface below (no photos); every
    // other photo-less product genuinely needs a view image first. The
    // flexible reader covers v2 and v3 manifests; legacy v1 references ride
    // along unchanged.
    const assets = sessionAssetMap();
    let rawManifest: unknown = null;
    const manifestBytes = assets.get(PRESENTATION_MANIFEST_PATH);
    if (manifestBytes !== undefined) {
      try {
        rawManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
      } catch {
        rawManifest = null;
      }
    }
    const flexible = parseFlexiblePresentationManifest(rawManifest);
    const legacy = flexible === null ? parsePresentationManifest(manifestBytes) : null;
    const models = flexible !== null ? (flexible.models ?? []) : (legacy !== null && legacy.version === 2 ? (legacy.models ?? []) : []);
    const hasModel = models.some((entry) => entry.productId === product.id);
    if (hasModel) {
      const message = 'This product uses a 3D model — set it up on the model below (no photos needed). Staged 3D references and areas save to the master with “Save 3D setup”.';
      // The workspace renders this notice itself; do not echo it in status.
      setWorkspaceNotice('');
      return { error: message };
    }
    const message = 'To set measurements and anchors, add a product with a view image.';
    setWorkspaceNotice(warning ?? '');
    return { error: message };
  }
  // Named views in manifest order (legacy sides and slug ids alike): tabs are
  // keyed by stable view id, labelled by the human name. No four-slot cap.
  const views = photos.map((photo) => ({
    id: photo.viewId,
    label: workspaceViewDisplayName(photo.viewId, photo.label),
    state: workspaceViewFor(product, variant, photo),
  }));
  // Context notices replace only text this getter wrote itself (tracked in
  // lastWorkspaceNotice): view action acknowledgements arriving through
  // onStatus are never cleared by a render.
  const notice = warning ?? sharedNotice(product);
  if (workspaceStatus.textContent === lastWorkspaceNotice) setWorkspaceNotice(notice);
  const shared = sharedNotice(product);
  const inputExtras = {
    retirements: draftRetirements,
    ...(shared !== '' ? { sharedNotice: shared } : {}),
  };
  if (workspaceViewHint === null) return { views, ...inputExtras };
  return { initialViewId: workspaceViewHint, views, ...inputExtras };
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
 * the commit assigns the session project/anchors; every failure path leaves
 * the previous session state untouched and reports `{ ok: false }` so the
 * view keeps the draft dirty and intact.
 *
 * Region geometry is genuinely shared: editing a region's safe area updates
 * every variant linked to that region (the save message names the region and
 * its variant count). Anchors and mappings stay per-variant.
 */
async function saveWorkspaceSetup(
  scope: ProductSetupScope,
  result: ProductSetupResult,
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
    // Baseline guard against shared-region stale overwrites (Tranche C):
    // the staged edits started from result.baseSafeArea. If live moved
    // underneath — another scope saved first, including an async save that
    // landed after this one was clicked — refuse instead of silently
    // reverting the other scope's geometry. The caller keeps its edits.
    const liveArea = region.safeArea.map(([x, y]) => ({ x, y }));
    if (JSON.stringify(liveArea) !== JSON.stringify(result.baseSafeArea)) {
      const linked = product.variants.filter((entry) => entry.regionIds.includes(region.id)).length;
      const name = region.name ?? region.id;
      return fail(linked > 1
        ? `Shared area “${name}” changed on another option since this edit started — review the saved area (Reset to saved reloads it) before saving.`
        : `The saved area changed since this edit started — Reset to saved reloads it before saving.`);
    }
    // Named areas (Codex P1, corrected): identity is by STABLE AREA ID and an
    // explicit active id — never by polygon content or selection. The scope
    // region always carries exactly the scope-entry polygon (first-drawn
    // binding; selection switches never relocate it, so existing placements
    // stay put); every other staged entry persists as a sibling region.
    // Validate everything before mutating anything.
    const stagedAreas = result.namedAreas ?? [];
    if (result.activeAreaId !== undefined && result.activeAreaId !== null &&
      !stagedAreas.some((area) => area.id === result.activeAreaId)) {
      return fail('The staged active area is unknown (concurrent edit?); re-open the view and save again. Nothing was saved.');
    }
    const scopeEntry = stagedAreas.find((area) => area.id === SCOPE_SAVED_AREA_ID)
      ?? stagedAreas[0] ?? null;
    const hasScopeEntry = stagedAreas.some((area) => area.id === SCOPE_SAVED_AREA_ID);
    // Scope-entry deletion with placements in the scope region would silently
    // relocate them onto the fallback polygon: refuse explicitly instead.
    if (!hasScopeEntry && scopeEntry !== null &&
      referencedRegionIds(snapshot.project, scope.productId).has(scope.regionId)) {
      return fail('The scope area was deleted but this scope region has placed logos; restore it (Reset to saved reloads it) before removing it. Nothing was saved.');
    }
    const siblingInputs = stagedAreas.filter((area) => area !== scopeEntry);
    const siblingIds = new Set<string>();
    for (const area of siblingInputs) {
      const name = area.name.trim();
      if (name.length === 0) return fail(`A named area has an empty name; rename it before saving. Nothing was saved.`);
      if (name.length > 80) return fail(`Named area “${name}” exceeds 80 characters. Nothing was saved.`);
      const areaCheck = validateSafeAreaPolygon(area.points.map((point) => ({ x: point.x, y: point.y })));
      if (!areaCheck.ok) return fail(`Named area “${name}” is invalid — ${areaCheck.reason}. Nothing was saved.`);
      const regionId = siblingRegionIdFor(scope.regionId, area.id);
      if (siblingIds.has(regionId)) return fail(`Named areas collide on saved id “${regionId}”. Nothing was saved.`);
      siblingIds.add(regionId);
    }
    // The scope polygon comes from the scope entry only (or, when no scope
    // entry was staged — e.g. it was deleted — the first staged entry, so a
    // lone drawn area still configures its view exactly once, as legacy did).
    // Selection switches alone therefore never relocate existing placements.
    const scopeSource = scopeEntry;
    const scopeTuples = scopeSource !== null
      ? scopeSource.points.map((point) => [point.x, point.y] as [number, number])
      : result.safeArea.map((point) => [point.x, point.y] as [number, number]);
    const scopeName = scopeSource !== null && scopeSource.name.trim() !== '' ? scopeSource.name.trim() : null;
    if (scopeSource !== null) {
      const scopeCheck = validateSafeAreaPolygon(scopeSource.points.map((point) => ({ x: point.x, y: point.y })));
      if (!scopeCheck.ok) return fail(`The scope area “${scopeSource.name.trim() || scopeSource.id}” is invalid — ${scopeCheck.reason}. Nothing was saved.`);
    }
    // Stale-list guard (same Tranche-C principle as the active polygon): the
    // committed sibling list for this scope region is baselined per session;
    // when live moved underneath AND differs from what was submitted, another
    // scope saved first — refuse instead of silently reverting it.
    const liveSiblings = product.regions
      .filter((entry) => isSiblingRegionId(scope.regionId, entry.id) &&
        entry.calibrationRef.calibrationId === scope.calibrationId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const liveSiblingCanonical = JSON.stringify(liveSiblings.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      points: entry.safeArea.map(([x, y]) => ({ x, y })),
    })));
    const submittedSiblingCanonical = JSON.stringify([...siblingIds].sort().map((regionId) => {
      const area = siblingInputs.find((candidate) => siblingRegionIdFor(scope.regionId, candidate.id) === regionId)!;
      return { id: regionId, name: area.name.trim(), points: area.points.map((point) => ({ x: point.x, y: point.y })) };
    }));
    const siblingBaseline = areaManifestBaseline.get(scope.regionId);
    if (siblingBaseline !== undefined && liveSiblingCanonical !== siblingBaseline && liveSiblingCanonical !== submittedSiblingCanonical) {
      return fail(`Named areas for “${region.name ?? region.id}” changed on another option since this edit started — re-open the view (Reset to saved reloads the saved setup) before saving.`);
    }
    // Stale-submitter guard: live siblings this bucket never saw (absent both
    // from the submission and from its seed-time list) mean another scope
    // saved first — refuse instead of silently reverting them. Legacy
    // submissions without a seed list rely on the session guard above.
    if (result.baseNamedAreas !== undefined) {
      const baseRegionIds = result.baseNamedAreas
        .filter((area) => area.id !== SCOPE_SAVED_AREA_ID)
        .map((area) => siblingRegionIdFor(scope.regionId, area.id));
      const unseen = unseenSiblingIds(
        liveSiblings.map((entry) => entry.id),
        [...siblingIds].sort(),
        baseRegionIds,
      );
      if (unseen.length > 0) {
        const names = unseen.map((id) =>
          liveSiblings.find((entry) => entry.id === id)?.name ?? id);
        return fail(`Named areas changed underneath this edit (“${names.join('”, “')}” not staged here) — re-open the view (Reset to saved reloads the saved setup) before saving.`);
      }
    }
    const next: ProjectDocument = JSON.parse(JSON.stringify(snapshot.project)) as ProjectDocument;
    const nextProduct = next.products.find((entry) => entry.id === scope.productId);
    const nextRegion = nextProduct?.regions.find((entry) => entry.id === scope.regionId);
    if (!nextProduct || !nextRegion) return fail('The measured area for this view no longer exists; measure it again first.');
    // Scope region carries exactly the scope-entry polygon (or the legacy
    // staged polygon when no scope entry was staged) — never the current
    // selection. Selection switches alone cannot relocate placements.
    nextRegion.safeArea = scopeTuples;
    if (scopeName !== null && scopeName !== (nextRegion.name ?? '')) {
      nextRegion.name = scopeName;
    }
    for (const regionId of [...siblingIds].sort()) {
      const area = siblingInputs.find((candidate) => siblingRegionIdFor(scope.regionId, candidate.id) === regionId)!;
      const tuples = area.points.map((point) => [point.x, point.y] as [number, number]);
      const liveSibling = nextProduct.regions.find((entry) => entry.id === regionId);
      if (liveSibling) {
        liveSibling.name = area.name.trim();
        liveSibling.safeArea = tuples;
      } else {
        nextProduct.regions.push({
          id: regionId,
          name: area.name.trim(),
          frame: JSON.parse(JSON.stringify(nextRegion.frame)) as typeof nextRegion.frame,
          calibrationRef: { ...nextRegion.calibrationRef },
          safeArea: tuples,
          allowedMethods: [...nextRegion.allowedMethods],
        });
        const nextVariant = nextProduct.variants.find((entry) => entry.id === variant.id);
        if (nextVariant && !nextVariant.regionIds.includes(regionId)) nextVariant.regionIds.push(regionId);
      }
    }
    // Deleted areas (Codex: delete must delete/retire): live siblings no
    // longer staged. Unreferenced regions are REMOVED with their variant
    // links (real delete); referenced ones are RETIRED in place (emptied
    // polygon so nothing new fits, current calibration ref so the project
    // stays valid, links kept so placed data stays resolvable and geometry
    // gates mark it invalid). Both lists are named in the status.
    const referencedHere = referencedRegionIds(next, scope.productId);
    const siblingOrphans = liveSiblings
      .filter((entry) => !siblingIds.has(entry.id))
      .map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }));
    const siblingFate = retireDeletedRegions(
      nextProduct, siblingOrphans, nextRegion.calibrationRef.calibrationId, nextRegion.calibrationRef.version, referencedHere);
    const nextAnchors: AnchorDef[] = liveAnchorsForSave(snapshot, scope, result, {
      regionId: scope.regionId,
      frameId: scope.frameId,
      calibrationId: scope.calibrationId,
      calibrationVersion: scope.calibrationVersion,
    });
    const validated = validateProject(next);
    if (!validated || validated.ok !== true) {
      const problems = validated && Array.isArray(validated.errors)
        ? validated.errors.slice(0, 3).map((entry) => `${entry.code} at ${entry.path}`).join('; ')
        : 'the project did not validate';
      return fail(`The project rejects this setup (${problems}).`);
    }
    if (stale()) return fail('The project changed while saving (new file opened or product added); re-open the view and save again.');
    // Photo mappings for EVERY region of this scope (Codex: each issued
    // region needs its actual mapping — the customer binds photo preview per
    // regionId). Sibling twins mirror the scope mappings exactly (same
    // photo/view/transform/calibration, own regionId); mappings of removed
    // regions go with them. Retired regions keep their existing mappings
    // (binding intact, frame unchanged).
    const mergedNow = workspaceMergedMappings();
    const scopeMappings = mergedNow.mappings.filter((e) =>
      e.productId === product.id && e.regionId === scope.regionId &&
      (e.variantId === undefined || e.variantId === variant.id));
    const twinEntries: PhotoMappingEntry[] = [];
    for (const regionId of [...siblingIds].sort()) {
      for (const base of scopeMappings) {
        twinEntries.push({ ...base, transform: { ...base.transform }, regionId });
      }
    }
    const replacedMappingKeys = new Set<string>();
    for (const base of scopeMappings) replacedMappingKeys.add(mappingKeyOf(base));
    for (const twin of twinEntries) replacedMappingKeys.add(mappingKeyOf(twin));
    for (const gone of siblingFate.removed) {
      for (const base of scopeMappings) {
        replacedMappingKeys.add(mappingKeyOf({ ...base, regionId: gone.id }));
      }
    }
    const baseMappings = parsePhotoMappings(snapshot.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes);
    const baseKept = (baseMappings?.mappings ?? []).filter((candidate) => !replacedMappingKeys.has(mappingKeyOf(candidate)));
    const stagedKeptMappings = stagedPhotoMappings.filter((candidate) => !replacedMappingKeys.has(mappingKeyOf(candidate)));
    const mergedMappingBytes = serializePhotoMappings(
      mergeSessionPhotoMappings({ version: 1, mappings: baseKept }, [...stagedKeptMappings, ...scopeMappings, ...twinEntries]));
    // Explicit active-area hint per scope region (Codex: stable ids +
    // explicit activeAreaId, surviving identical polygons). Display hint
    // only — geometry never depends on it; seeding falls back deterministi-
    // cally when absent. Read-modify-write preserves other scopes.
    const activeAreasPath = activeAreasPathFor(product.id);
    let activeAreasBytes: Uint8Array | null = null;
    const stagedIdSet = new Set(stagedAreas.map((area) => area.id));
    if (result.activeAreaId !== undefined && result.activeAreaId !== null && stagedIdSet.has(result.activeAreaId)) {
      activeAreasBytes = serializeActiveAreasFile({
        ...parseActiveAreasFile(snapshot.assets.find((asset) => asset.path === activeAreasPath)?.bytes),
        [scope.regionId]: result.activeAreaId,
      });
    }
    const digest = await hasher.prepareProject(next);
    if (stale()) return fail('The project changed while saving (new file opened or product added); re-open the view and save again.');
    const additionalAssets = [
      ...snapshot.assets
        .filter((asset) => asset.kind === 'additional' && asset.path !== OPERATION_ANCHORS_PATH &&
          asset.path !== PHOTO_MAPPINGS_PATH && (activeAreasBytes === null || asset.path !== activeAreasPathFor(product.id)))
        .map(({ path, bytes }) => ({ path, bytes })),
      { path: OPERATION_ANCHORS_PATH, bytes: buildAnchorsSidecarBytes(next, digest, nextAnchors) },
      { path: PHOTO_MAPPINGS_PATH, bytes: mergedMappingBytes },
      ...(activeAreasBytes !== null ? [{ path: activeAreasPathFor(product.id), bytes: activeAreasBytes }] : []),
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
    // Sibling named areas: every submitted sibling must reopen with its
    // exact name and polygon; removed regions must be gone with their
    // mappings; retired regions stay emptied with current refs; every scope
    // and sibling mapping must carry its exact transform.
    const backProduct = back.project.products.find((entry) => entry.id === scope.productId);
    const backMappings = parsePhotoMappings(back.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH)?.bytes);
    const mappingOk = (regionId: string, transform: PhotoMappingTransform): boolean => {
      const found = backMappings?.mappings.find((candidate) =>
        candidate.productId === scope.productId && candidate.regionId === regionId);
      return found !== undefined && JSON.stringify(found.transform) === JSON.stringify(transform);
    };
    const siblingsOk = backProduct !== undefined && [...siblingIds].sort().every((regionId) => {
      const before = nextProduct.regions.find((entry) => entry.id === regionId);
      const after = backProduct.regions.find((entry) => entry.id === regionId);
      return before !== undefined && after !== undefined &&
        JSON.stringify(after.safeArea) === JSON.stringify(before.safeArea) &&
        (after.name ?? after.id) === (before.name ?? before.id);
    }) && siblingFate.removed.every((gone) =>
      backProduct.regions.every((entry) => entry.id !== gone.id)) &&
      siblingFate.retired.every((gone) => {
        const after = backProduct.regions.find((entry) => entry.id === gone.id);
        return after !== undefined && after.safeArea.length === 0 &&
          after.calibrationRef.calibrationId === scope.calibrationId;
      }) && scopeMappings.every((base) => mappingOk(base.regionId, base.transform)) &&
      twinEntries.every((twin) => mappingOk(twin.regionId, twin.transform));
    if (!siblingsOk) return fail('The reparse lost a named area or mapping; the previous project is unchanged.');
    if (activeAreasBytes !== null) {
      const backActive = back.assets.find((asset) => asset.path === activeAreasPathFor(product.id))?.bytes;
      if (!backActive || backActive.length !== activeAreasBytes.length ||
        !backActive.every((value, index) => value === activeAreasBytes[index])) {
        return fail('The reparse lost the active-area hint; the previous project is unchanged.');
      }
    }
    if (stale()) return fail('The project changed while saving (new file opened or product added); re-open the view and save again.');
    snapshot.anchors = nextAnchors;
    stagedPhotoMappings = [...stagedKeptMappings, ...scopeMappings, ...twinEntries];
    areaManifestBaseline.set(scope.regionId, submittedSiblingCanonical);
    source = replaceSessionProject(snapshot, back.project, back.assets, packageBytes.slice());
    // The package changed under any generated delivery: mark outputs stale
    // so a regen is required before download. Success path only — every
    // `fail` return above leaves prior outputs intact.
    invalidateOutputsForEdit();
    markJobDirty();
    reprepareJobDigest();
    if (placementHandle) placementHandle.update();
    if (reviewHandle) reviewHandle.update();
    if (approvalHandle) approvalHandle.notifyJobChanged();
    refreshWorkspaceSelectors();
    workspaceView.refresh();
    refreshWorkspace();
    workspaceStatus.textContent =
      `Saved ${scope.regionName ?? 'measured area'} · ${workspaceViewNoun(scopeViewId(scope), scope.viewLabel)} ` +
      `(${result.safeArea.length} safe-area corners, ${result.anchors.length} anchors).` +
      (siblingIds.size > 0 || stagedAreas.length > 1 ? ` ${stagedAreas.length} named area(s) saved.` : '') +
      (result.activeAreaId ? ` Active area recorded.` : '') +
      (siblingFate.removed.length > 0 ? ` Removed ${siblingFate.removed.length} deleted area(s) (“${siblingFate.removed.map((entry) => entry.name).join('”, “')}”) — the customer can no longer select them.` : '') +
      (siblingFate.retired.length > 0 ? ` Retired ${siblingFate.retired.length} placed area(s) with emptied geometry (“${siblingFate.retired.map((entry) => entry.name).join('”, “')}”) — existing placements stay but are invalid until re-verified; no new placements fit there.` : '');
    // Re-baseline the VIEW to the saved SCOPE polygon (not the staged
    // selection): with named areas they legitimately differ, and baselining
    // to staged content would make the next render misread it as a live
    // change and adopt-revert the staging.
    return {
      ok: true,
      scopeSafeArea: scopeTuples.map(([x, y]) => ({ x, y })),
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  }, () => ({ ok: false, error: 'The project changed before saving started (new file opened or product added); re-open the view and save again. Nothing was saved.' }));
}

/**
 * Anchor rows for one workspace save: drop this scope's prior rows, keep
 * every other scope verbatim, then bind the staged rows to the saved
 * region/frame/calibration. Pure; no DOM.
 */
function liveAnchorsForSave(
  snapshot: JobSession,
  scope: ProductSetupScope,
  result: ProductSetupResult,
  bind: { regionId: string; frameId: string; calibrationId: string; calibrationVersion: string },
): AnchorDef[] {
  if (!snapshot.project.products.some((entry) => entry.id === scope.productId)) return [];
  return snapshot.anchors
    .filter((anchor) => !(anchor.productId === scope.productId && anchor.variantId === scope.variantId && anchor.regionId === scope.regionId))
    .map((anchor) => ({ ...anchor, posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number] }))
    .concat(result.anchors.map((anchor) => ({
      ...anchor,
      productId: scope.productId,
      variantId: scope.variantId,
      regionId: bind.regionId,
      frameId: bind.frameId,
      calibrationId: bind.calibrationId,
      calibrationVersion: bind.calibrationVersion,
      posMm: [anchor.posMm[0]!, anchor.posMm[1]!] as [number, number],
    })));
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
  const viewId = scopeViewId(scope);
  const display = workspaceViewNoun(scopeViewId(scope), scope.viewLabel);
  const photo = photos.find((entry) => entry.viewId === viewId);
  if (!photo) {
    workspaceStatus.textContent =
      `The ${display} view has no photo: add a view image above (Choose items → Add product), then measure it here.`;
    return;
  }
  workspaceViewHint = viewId;
  guidedScale.show({
    scope,
    photo: {
      bytes: photo.bytes,
      widthPx: photo.widthPx,
      heightPx: photo.heightPx,
      label: `${product.name ?? product.id} — ${display} view`,
    },
    imagePath: photo.imagePath,
  });
  workspaceStatus.textContent =
    `The ${display} view has no measured area yet. Click reference points A and B below, enter their real length in millimetres, and create the calibration — no placements until then. (A rectangle-based affine mapping stays available under Advanced.)`;
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
  onSpanCommit: (request, span) => commitGuidedSpan(request, span),
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

/** Open a product's visual setup from its selection card: the include
 *  checkbox stays independent — this only moves the workspace there. */
function openProductWorkspace(productId: string): void {
  if (source === null) return;
  const product = source.project.products.find((entry) => entry.id === productId);
  if (!product) return;
  workspaceProductId = productId;
  workspaceVariantId = product.variants.some((entry) => entry.id === workspaceVariantId)
    ? workspaceVariantId
    : product.variants[0]?.id ?? null;
  workspaceViewHint = null;
  guidedScale.hide();
  if (!prepareBlocked()) refreshWorkspace();
  workspaceBox.scrollIntoView({ block: 'start' });
  workspaceProduct.focus();
  // Single-product/single-option workspaces hide the chooser selects, leaving
  // them unfocusable: fall back to the workspace mount itself (tabindex -1)
  // so keyboard focus still lands in the opened workspace. (Worker 2 intake.)
  if (document.activeElement !== workspaceProduct) workspaceBox.focus();
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
  // Single inviting intake block for the empty draft: with no products the
  // in-place view-image disclosure stays hidden (nothing to attach to yet).
  // Otherwise visibility stays owned by refreshPhotoAttachHint, which also
  // hides model-only products.
  if (count === 0) productPhotoDisclosure.hidden = true;
}

/* ---------------- Staff 3D model setup (white stage + surface setup) ------ */
/* Model-only products measure directly on the 3D surface below (two-click   */
/* reference + named areas; photos cannot attach to them). Legacy combined   */
/* model+photo products keep the photo workspace; the model pane shows only  */
/* when the workspace product has no usable photos. Never a fake mesh        */
/* projection.                                                               */

let staffModelViewer: ModelViewerType | null = null;
let staffModelCanvas: HTMLCanvasElement | null = null;
let staffModelKey: string | null = null;
let staffModelGeneration = 0;
/** Latest 3D-setup snapshot per product + model scope (in-memory staging, never stored). */
const staffModelSnapshots = new Map<string, ModelSetupSnapshot>();
let staffModelSetup: ModelSetupViewHandle | null = null;

function disposeStaffModel(): void {
  if (staffModelSetup !== null) {
    try {
      staffModelSetup.destroy();
    } catch {
      /* best-effort view teardown */
    }
    staffModelSetup = null;
  }
  modelSetupBox.replaceChildren();
  if (staffModelViewer !== null) {
    try {
      staffModelViewer.dispose();
    } catch {
      /* best-effort GL teardown */
    }
    staffModelViewer = null;
  }
  staffModelCanvas = null;
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
    staffModelCanvas = fresh;
    const attached = module.ModelViewer.attach({
      canvas: fresh,
      container: productModelStage,
      background: 0xffffff,
    });
    if (attached.viewer === null) {
      staffModelCanvas = null;
      productModelStatus.textContent = `3D preview unavailable: ${attached.status.kind === 'webgl-unavailable' ? attached.status.message : 'no viewer'}. Add a view image above to author measurements.`;
      return;
    }
    staffModelViewer = attached.viewer;
    staffModelKey = key;
    const shown = await attached.viewer.showModel(bytes.slice());
    if (!isCurrent()) return;
    if (shown.kind !== 'ready' && shown.kind !== 'empty' && shown.kind !== 'loading') {
      productModelStatus.textContent = `3D preview unavailable (${shown.message}). Add a view image above to author measurements.`;
    }
    mountModelSetup(product.id, selection.modelPath);
  } catch (error) {
    if (!isCurrent()) return;
    disposeStaffModel();
    productModelStatus.textContent = `3D preview unavailable: ${error instanceof Error ? error.message : String(error)}. Add a view image above to author measurements.`;
  }
}

/* ---------------- 3D model setup (model-only calibration, lead-owned) ---- */
/* A model-only product is measured directly on the 3D surface: two surface  */
/* picks A/B plus a real millimetre length fit a uniform scale (straight-    */
/* line chord, never a geodesic), and named safe-area polygons are authored  */
/* on the surface (each polygon establishes its region plane). No images are */
/* required or accepted. Staging is in-memory per product (switching keeps   */
/* every draft); Save commits a calibration record, one domain region per    */
/* saved area (plane-projected ring in mm — explicit planar projection,      */
/* never a curved-surface claim) and a deterministic sidecar into the master */
/* package atomically. Deleted areas are removed when unplaced, retired when */
/* placed (emptied, refs current, links kept). The customer file carries the */
/* calibration record, projected regions and model bytes. Every surface      */
/* stays provisional pending review.                                         */

const SETUP_MODEL_SIDECAR_VERSION = 'setup-model-sidecar/1';

interface ModelSetupSidecarFile {
  version: typeof SETUP_MODEL_SIDECAR_VERSION;
  kind: 'model';
  productId: string;
  variantId: string | null;
  assetKey: string;
  calibrationId: string;
  /** Verbatim view-envelope JSON (same shape as the view's own download). */
  setup: unknown;
}

function modelAssetKeyOf(modelPath: string, bytes: Uint8Array): string {
  return `${modelPath}#${bytes.length}:${fnv1a32Hex(bytes)}`;
}

function modelProductsWithModels(): Array<{ productId: string; productName: string }> {
  if (source === null) return [];
  const assets = sessionAssetMap();
  const manifest = parseFlexiblePresentationManifest(parseJsonBytes(assets.get(PRESENTATION_MANIFEST_PATH)));
  if (manifest === null) return [];
  const ids = new Set<string>();
  for (const entry of manifest.models ?? []) ids.add(entry.productId);
  return source.project.products
    .filter((product) => ids.has(product.id))
    .map((product) => ({ productId: product.id, productName: product.name ?? product.id }));
}

function modelEntryFor(productId: string, variantId: string | null | undefined): { modelPath: string; variantId: string | undefined } | null {
  if (source === null) return null;
  const assets = sessionAssetMap();
  const manifest = parseFlexiblePresentationManifest(parseJsonBytes(assets.get(PRESENTATION_MANIFEST_PATH)));
  if (manifest === null) return null;
  const entries = (manifest.models ?? []).filter((entry) => entry.productId === productId);
  if (entries.length === 0) return null;
  // Exact variant scope wins, then product-wide. NEVER another variant's
  // model: an uncovered variant has no setup scope here (mirrors
  // selectPresentationModel, which the viewer uses for display).
  const exact = entries.find((entry) => entry.variantId === variantId);
  const wide = entries.find((entry) => entry.variantId === undefined);
  const chosen = exact ?? wide ?? null;
  if (!chosen) return null;
  return { modelPath: chosen.model, variantId: chosen.variantId ?? undefined };
}

/** One setup scope per (product, model scope): product-wide models stage once; variant-specific models stage per variant. */
function modelScopeEntries(): Array<{ productId: string; productName: string; variantId: string | undefined; modelPath: string }> {
  if (source === null) return [];
  const assets = sessionAssetMap();
  const manifest = parseFlexiblePresentationManifest(parseJsonBytes(assets.get(PRESENTATION_MANIFEST_PATH)));
  if (manifest === null) return [];
  const out: Array<{ productId: string; productName: string; variantId: string | undefined; modelPath: string }> = [];
  for (const product of source.project.products) {
    const entries = (manifest.models ?? []).filter((entry) => entry.productId === product.id);
    if (entries.length === 0) continue;
    const wide = entries.find((entry) => entry.variantId === undefined);
    if (wide) {
      out.push({ productId: product.id, productName: product.name ?? product.id, variantId: undefined, modelPath: wide.model });
    }
    const seenVariants = new Set<string>();
    for (const entry of entries) {
      if (entry.variantId === undefined || seenVariants.has(entry.variantId)) continue;
      seenVariants.add(entry.variantId);
      const variant = product.variants.find((item) => item.id === entry.variantId);
      const variantLabel = variant?.name?.trim() ? variant.name : entry.variantId;
      out.push({
        productId: product.id,
        productName: `${product.name ?? product.id} — ${variantLabel}`,
        variantId: entry.variantId,
        modelPath: entry.model,
      });
    }
  }
  return out;
}

function modelSetupSidecarPathFor(productId: string, variantId: string | undefined): string {
  return `${SETUP_SPAN_DIR}/${safeProductSegment(productId)}/model.${spanScopeSuffix(variantId)}.model.json`;
}

function modelCalibrationIdFor(productId: string, variantId: string | undefined): string {
  return `cal-model-${safeProductSegment(productId)}-${spanScopeSuffix(variantId)}`;
}

function getModelSetupInput(): ModelSetupInput {
  const scopes = modelScopeEntries();
  const products = scopes.map((entry) => ({
    productId: entry.productId,
    productName: entry.productName,
    ...(entry.variantId !== undefined ? { variantId: entry.variantId } : {}),
    modelPath: entry.modelPath,
  }));
  // Exact variant scope wins, then product-wide — mirroring the viewer
  // (selectPresentationModel) exactly. NEVER another variant's scope and
  // never a first-entry fallback: an uncovered variant has no setup scope,
  // and the view says so instead of exposing foreign geometry.
  const active = scopes.find((entry) => entry.productId === workspaceProductId && (entry.variantId ?? undefined) === (workspaceVariantId ?? undefined))
    ?? scopes.find((entry) => entry.productId === workspaceProductId && entry.variantId === undefined)
    ?? null;
  let assetKey: string | null = null;
  if (active !== null) {
    const bytes = sessionAssetMap().get(active.modelPath);
    assetKey = bytes ? modelAssetKeyOf(active.modelPath, bytes) : null;
  }
  return {
    products,
    activeProductId: active?.productId ?? null,
    ...(active ? { activeVariantId: active.variantId ?? null } : {}),
    assetKey,
  };
}

/** Snapshot map key: product + exact model scope (never shared across variants). */
function modelSnapshotKey(productId: string, variantId: string | null): string {
  return `${productId}${variantId === null ? '' : ` ${variantId}`}`;
}

function parseModelSetupSidecar(bytes: Uint8Array): { ok: true; sidecar: ModelSetupSidecarFile } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (bytes.length === 0 || bytes.length > SETUP_SPAN_SIDECAR_MAX_BYTES) {
    return fail('model setup sidecar is empty or exceeds the 64 KiB sidecar bound');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('model setup sidecar is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) return fail('model setup sidecar must be an object');
  const record = raw as Record<string, unknown>;
  if (record['version'] !== SETUP_MODEL_SIDECAR_VERSION) return fail('model setup sidecar has an unknown version');
  if (record['kind'] !== 'model') return fail('model setup sidecar has the wrong kind');
  if (typeof record['productId'] !== 'string' || record['productId'].length === 0) {
    return fail('model setup sidecar productId must be a non-empty string');
  }
  if (record['variantId'] !== null && (typeof record['variantId'] !== 'string' || (record['variantId'] as string).length === 0)) {
    return fail('model setup sidecar variantId must be null or a non-empty string');
  }
  if (typeof record['assetKey'] !== 'string' || (record['assetKey'] as string).length === 0) {
    return fail('model setup sidecar assetKey must be a non-empty string');
  }
  if (typeof record['calibrationId'] !== 'string' || (record['calibrationId'] as string).length === 0) {
    return fail('model setup sidecar calibrationId must be a non-empty string');
  }
  if (typeof record['setup'] !== 'object' || record['setup'] === null) {
    return fail('model setup sidecar carries no setup envelope');
  }
  return {
    ok: true,
    sidecar: {
      version: SETUP_MODEL_SIDECAR_VERSION,
      kind: 'model',
      productId: record['productId'] as string,
      variantId: record['variantId'] as string | null,
      assetKey: record['assetKey'] as string,
      calibrationId: record['calibrationId'] as string,
      setup: record['setup'],
    },
  };
}

function serializeModelSetupSidecar(sidecar: Omit<ModelSetupSidecarFile, 'version' | 'kind'>): Uint8Array {
  const ordered = {
    version: SETUP_MODEL_SIDECAR_VERSION,
    kind: 'model',
    productId: sidecar.productId,
    variantId: sidecar.variantId,
    assetKey: sidecar.assetKey,
    calibrationId: sidecar.calibrationId,
    setup: sidecar.setup,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/** Live model setup evidence for one product scope + model asset, or null when absent/stale. */
function readModelSetup(
  product: ProjectDocument['products'][number],
  variantId: string | undefined,
  assetKey: string,
): { sidecar: ModelSetupSidecarFile; calibration: { id: string; version: string } } | null {
  const assets = sessionAssetMap();
  for (const path of [
    modelSetupSidecarPathFor(product.id, variantId),
    modelSetupSidecarPathFor(product.id, undefined),
  ]) {
    const bytes = assets.get(path);
    if (!bytes) continue;
    const parsed = parseModelSetupSidecar(bytes);
    if (!parsed.ok) continue;
    const sidecar = parsed.sidecar;
    if (sidecar.productId !== product.id || sidecar.assetKey !== assetKey) continue;
    // Scope must match exactly: a product-wide setup never stands in for a
    // variant scope and vice versa (assetKey already binds exact bytes).
    if ((sidecar.variantId ?? undefined) !== variantId) continue;
    const calibration = product.calibrations.find((entry) => entry.id === sidecar.calibrationId);
    if (!calibration) continue;
    return { sidecar, calibration: { id: calibration.id, version: calibration.version } };
  }
  return null;
}

function mountModelSetup(productId: string, modelPath: string): void {
  if (staffModelSetup !== null) {
    try {
      staffModelSetup.destroy();
    } catch {
      /* replaced below */
    }
    staffModelSetup = null;
  }
  modelSetupBox.replaceChildren();
  modelSetupBox.classList.toggle('hide-products', !modelSetupProductsToggle.checked);
  const viewerOf = (): ModelSetupViewerLike | null => staffModelViewer;
  const canvasOf = (): HTMLCanvasElement | null => staffModelCanvas;
  const handle = createModelSetupView(modelSetupBox, viewerOf, canvasOf, getModelSetupInput, {
    onStatus: (message) => {
      modelSetupStatus.textContent = message;
    },
    onChange: (snapshot) => {
      staffModelSnapshots.set(modelSnapshotKey(snapshot.productId, snapshot.variantId), snapshot);
    },
    onSelectProduct: (nextId, nextVariantId) => {
      if (source === null) return;
      const product = source.project.products.find((entry) => entry.id === nextId);
      if (!product) return;
      workspaceProductId = nextId;
      workspaceVariantId = nextVariantId !== undefined && product.variants.some((entry) => entry.id === nextVariantId)
        ? nextVariantId
        : product.variants.some((entry) => entry.id === workspaceVariantId)
          ? workspaceVariantId
          : product.variants[0]?.id ?? null;
      workspaceViewHint = null;
      guidedScale.hide();
      if (!prepareBlocked()) refreshWorkspace();
    },
  });
  staffModelSetup = handle;
  handle.refresh();
  // Reopen master evidence for the mounted scope when the identical model
  // asset is live: the imported fit is recomputed, areas reopen stale. The
  // envelope's scope must match the mounted entry exactly.
  if (source !== null) {
    const product = source.project.products.find((entry) => entry.id === productId);
    const input = getModelSetupInput();
    if (product && input.assetKey !== null && input.activeProductId !== null) {
      const scopeVariant = input.activeVariantId ?? undefined;
      const found = readModelSetup(product, scopeVariant, input.assetKey);
      if (found) {
        const envelope = {
          ...(found.sidecar.setup as Record<string, unknown>),
          assetKey: input.assetKey,
          productId: product.id,
          variantId: scopeVariant ?? null,
        };
        const outcome = handle.hydrateFromJson(JSON.stringify(envelope));
        modelSetupStatus.textContent = outcome.ok
          ? `Reopened saved 3D setup for this model (${modelPath}). ${outcome.message}`
          : `Saved 3D setup ignored: ${outcome.message}`;
      }
    }
  }
  updateControls();
}

/**
 * Commit the staged 3D setup for the active model product: calibration
 * record + deterministic sidecar in ONE atomic repackage-and-reparse
 * commit. Requires a fitted, non-stale reference and zero stale areas —
 * stale geometry never commits. Regions are deliberately NOT created (see
 * the section header). Failed commits keep prior state with an error.
 */
async function commitModelSetup(): Promise<void> {
  if (source === null) {
    modelSetupStatus.textContent = 'Create or open a project first.';
    return;
  }
  const input = getModelSetupInput();
  const activeId = input.activeProductId;
  if (activeId === null) {
    modelSetupStatus.textContent = 'No 3D-model product is available; add one from staged files first.';
    return;
  }
  // Exact scope isolation: the snapshot must belong to the active entry's
  // model scope (product-wide or one variant) — never a sibling scope.
  const activeScope: string | null = input.activeVariantId ?? null;
  const snapshot: ModelSetupSnapshot | undefined = staffModelSnapshots.get(modelSnapshotKey(activeId, activeScope));
  if (!snapshot || snapshot.variantId !== activeScope) {
    modelSetupStatus.textContent = 'This model scope has no staged setup yet; pick points on the model first. Nothing was saved.';
    return;
  }
  if (!snapshot || !snapshot.reference || snapshot.mmPerUnit === null || snapshot.mmPerUnit <= 0 || snapshot.fitStale) {
    modelSetupStatus.textContent = 'Fit the two-click reference scale first (no stale fit); nothing was saved.';
    return;
  }
  const staleAreas = snapshot.areas.filter((area) => area.status !== 'current');
  if (staleAreas.length > 0) {
    modelSetupStatus.textContent = `Recompute ${staleAreas.length} stale area(s) under the current calibration first; nothing was saved.`;
    return;
  }
  // Narrowed copies for the async commit closure below (Map lookups do not
  // narrow across awaits).
  const stagedSnapshot = snapshot;
  const stagedReference = snapshot.reference;
  const stagedMmPerUnit = snapshot.mmPerUnit;
  const submittedSource = source;
  const submittedSession = sourceSession;
  await enqueueWorkspaceCommit(async () => {
    if (source !== submittedSource || sourceSession !== submittedSession || source === null) {
      modelSetupStatus.textContent = 'The project changed before saving started; save again. Nothing was saved.';
      return;
    }
    const snap = source;
    try {
      const product = snap.project.products.find((entry) => entry.id === activeId);
      if (!product) {
        modelSetupStatus.textContent = `Product is no longer in the project. Nothing was saved.`;
        return;
      }
      const live = getModelSetupInput();
      if (live.activeProductId !== activeId || (live.activeVariantId ?? null) !== activeScope ||
        live.assetKey === null || live.assetKey !== input.assetKey) {
        modelSetupStatus.textContent = 'The model scope changed while saving; save again. Nothing was saved.';
        return;
      }
      const found = modelEntryFor(activeId, live.activeVariantId ?? undefined);
      if (!found || (found.variantId ?? null) !== activeScope) {
        modelSetupStatus.textContent = 'The 3D model for this scope left the package; nothing was saved.';
        return;
      }
      const reference = stagedReference;
      const envelope = {
        version: '0.1.0-provisional-model-setup',
        productId: activeId,
        variantId: activeScope,
        assetKey: live.assetKey,
        reference: {
          id: reference.id,
          a: { ...reference.a },
          b: { ...reference.b },
          lengthMm: reference.lengthMm,
        },
        fit: null,
        areas: [...stagedSnapshot.areas]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((area) => ({
            id: area.id,
            name: area.name,
            points: area.points.map((point) => ({ ...point })),
            status: 'current',
          })),
        flags: { pendingReview: true, productionApproved: false },
      };
      // Scope isolation (P1): calibration, regions and sidecar are keyed by
      // the EXACT model scope (product-wide or one variant) — never shared
      // across variants of one product.
      const scopeVariant = found.variantId;
      const calibrationId = modelCalibrationIdFor(activeId, scopeVariant);
      const sidecarPath = modelSetupSidecarPathFor(activeId, scopeVariant);
      // Version policy: same reference span as the stored sidecar reuses its
      // version (areas-only change keeps every ref valid); a changed
      // reference bumps, and orphaned regions (deleted areas) get their refs
      // updated so the project stays valid — their prior geometry is kept
      // and named below, never silently dropped.
      const priorSidecar = sessionAssetMap().get(sidecarPath);
      const priorSetup = priorSidecar ? parseModelSetupSidecar(priorSidecar) : null;
      const priorReference = priorSetup?.ok === true
        ? (priorSetup.sidecar.setup as Record<string, unknown>)['reference']
        : null;
      const sameReference = priorReference !== null && typeof priorReference === 'object' &&
        JSON.stringify((priorReference as Record<string, unknown>)['a']) === JSON.stringify(reference.a) &&
        JSON.stringify((priorReference as Record<string, unknown>)['b']) === JSON.stringify(reference.b) &&
        (priorReference as Record<string, unknown>)['lengthMm'] === reference.lengthMm;
      const prior = product.calibrations.find((entry) => entry.id === calibrationId);
      const priorVersion = prior === undefined ? 0 : Number.parseInt(prior.version, 10);
      const nextVersion = sameReference && prior !== undefined
        ? prior.version
        : String(Number.isFinite(priorVersion) && priorVersion > 0 ? priorVersion + 1 : 1);
      const referenceChanged = prior !== undefined && !sameReference;
      const sidecarBytes = serializeModelSetupSidecar({
        productId: activeId,
        variantId: scopeVariant ?? null,
        assetKey: live.assetKey,
        calibrationId,
        setup: envelope,
      });
      const next: ProjectDocument = JSON.parse(JSON.stringify(snap.project)) as ProjectDocument;
      const nextProduct = next.products.find((entry) => entry.id === activeId)!;
      const description =
        `Two-click 3D span on model ${found.modelPath}: reference A/B = ${reference.lengthMm} mm; ` +
        `uniform scale ${stagedMmPerUnit} mm per model unit (straight-line chord, not a surface arc); ` +
        `${stagedSnapshot.areas.length} named safe area(s) with visually established planes; ` +
        `provisional pending review — never production-approved.`;
      const priorNext = nextProduct.calibrations.find((entry) => entry.id === calibrationId);
      if (priorNext) {
        priorNext.version = nextVersion;
        priorNext.description = description;
      } else {
        nextProduct.calibrations.push({ id: calibrationId, version: nextVersion, description });
      }
      // One domain region per saved area: the area's plane-projected ring
      // (mm under the fitted scale) becomes the region polygon, and the
      // polygon's plane is the region frame. Explicit planar projection of
      // surface picks — never a curved-surface claim. Region ids derive
      // stably from area ids, so re-saving updates placements-safe regions
      // in place; regions whose area was deleted stay (placements never
      // dangle — geometry gates mark them invalid instead).
      const sanitizeSegment = (value: string): string => {
        const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
        return cleaned === '' ? 'area' : cleaned;
      };
      const scopeVariantIds = scopeVariant !== undefined
        ? [scopeVariant]
        : nextProduct.variants.map((entry) => entry.id);
      const syncedRegionIds: string[] = [];
      for (const area of [...stagedSnapshot.areas].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const projected = projectAreaToMm(area.points, stagedMmPerUnit);
        if (!projected) {
          modelSetupStatus.textContent = `Safe area “${area.name}” no longer projects onto a plane; re-pick it. Nothing was saved.`;
          return;
        }
        const regionId = `region-${sanitizeSegment(area.id)}-${spanScopeSuffix(scopeVariant)}`;
        const frameId = `frame-${regionId}`;
        const safeArea = projected.ring.map((point) => [point.x, point.y] as [number, number]);
        const frame = {
          frameId,
          originDescription: `Centroid of the “${area.name}” surface polygon on model ${found.modelPath} (region plane established by the polygon)`,
          axes: {
            xPositive: 'first-edge direction of the surface polygon, projected onto its plane',
            yPositive: 'plane normal × x (right-handed)',
          },
        };
        const liveRegion = nextProduct.regions.find((entry) => entry.id === regionId);
        if (liveRegion) {
          liveRegion.name = area.name;
          liveRegion.frame = frame;
          liveRegion.calibrationRef = { calibrationId, version: nextVersion };
          liveRegion.safeArea = safeArea;
        } else {
          nextProduct.regions.push({
            id: regionId,
            name: area.name,
            frame,
            calibrationRef: { calibrationId, version: nextVersion },
            safeArea,
            allowedMethods: ['embroidery', 'print'],
          });
        }
        for (const variantId of scopeVariantIds) {
          const linked = nextProduct.variants.find((entry) => entry.id === variantId);
          if (linked && !linked.regionIds.includes(regionId)) linked.regionIds.push(regionId);
        }
        syncedRegionIds.push(regionId);
      }
      // Deleted areas (Codex: delete must delete/retire): owned regions no
      // longer staged. Unreferenced regions are REMOVED with variant links
      // (real delete — the customer can no longer select them); referenced
      // ones are RETIRED (emptied polygon, current ref, links kept) so placed
      // data stays resolvable while geometry gates mark it invalid. Both
      // lists are named in the status; stale geometry is never relabelled as
      // current calibration output.
      const syncedSet = new Set(syncedRegionIds);
      const modelOrphans = nextProduct.regions
        .filter((region) => region.calibrationRef.calibrationId === calibrationId && !syncedSet.has(region.id))
        .map((region) => ({ id: region.id, name: region.name ?? region.id }));
      const modelFate = retireDeletedRegions(
        nextProduct, modelOrphans, calibrationId, nextVersion, referencedRegionIds(next, activeId));
      const validated = validateProject(next);
      if (!validated || validated.ok !== true) {
        modelSetupStatus.textContent = 'The project rejects this 3D setup. Nothing was saved.';
        return;
      }
      const liveBytes = sessionAssetMap().get(found.modelPath);
      if (!liveBytes || liveBytes.length === 0) {
        modelSetupStatus.textContent = 'The 3D model left the package while saving; nothing was saved.';
        return;
      }
      const additionalAssets = [
        ...snap.assets
          .filter((asset) => asset.kind === 'additional' && asset.path !== PHOTO_MAPPINGS_PATH && asset.path !== OPERATION_ANCHORS_PATH && asset.path !== sidecarPath)
          .map(({ path, bytes }) => ({ path, bytes })),
        { path: PHOTO_MAPPINGS_PATH, bytes: serializePhotoMappings(workspaceMergedMappings()) },
        { path: sidecarPath, bytes: sidecarBytes },
      ];
      const packagedSidecar = snap.assets.find((asset) => asset.path === OPERATION_ANCHORS_PATH && asset.kind === 'additional');
      if (packagedSidecar !== undefined) {
        additionalAssets.push({ path: packagedSidecar.path, bytes: packagedSidecar.bytes });
      }
      const packageBytes = await createProjectPackage(
        {
          project: next,
          assets: snap.assets.filter((asset) => asset.kind !== 'additional').map(({ path, bytes }) => ({ path, bytes })),
          additionalAssets,
        },
        { sha256: hasher.sha256Bytes },
      );
      if (source !== snap) {
        modelSetupStatus.textContent = 'The project changed while saving; save again. Nothing was saved.';
        return;
      }
      const back = await parseProjectPackage(packageBytes, { sha256: hasher.sha256Bytes });
      assertProjectEditorLimits(back.project);
      if (canonicalize(back.project) !== canonicalize(next)) {
        modelSetupStatus.textContent = 'The reparse changed the project; the previous project is unchanged.';
        return;
      }
      const backSidecar = back.assets.find((asset) => asset.path === sidecarPath);
      const sidecarIdentical = backSidecar !== undefined &&
        backSidecar.bytes.length === sidecarBytes.length &&
        backSidecar.bytes.every((value, index) => value === sidecarBytes[index]);
      if (!sidecarIdentical) {
        modelSetupStatus.textContent = 'The reparse lost the 3D setup; the previous project is unchanged.';
        return;
      }
      const backProduct = back.project.products.find((entry) => entry.id === activeId);
      const regionsOk = backProduct !== undefined && syncedRegionIds.every((regionId) => {
        const before = nextProduct.regions.find((entry) => entry.id === regionId);
        const after = backProduct.regions.find((entry) => entry.id === regionId);
        return before !== undefined && after !== undefined &&
          JSON.stringify(after.safeArea) === JSON.stringify(before.safeArea) &&
          after.calibrationRef.calibrationId === calibrationId;
      });
      if (!regionsOk) {
        modelSetupStatus.textContent = 'The reparse lost a projected region; the previous project is unchanged.';
        return;
      }
      source = replaceSessionProject(snap, back.project, back.assets, packageBytes.slice());
      // The package changed under any generated delivery: mark outputs stale
      // so a regen is required before download. Success path only — every
      // early return above leaves prior outputs intact.
      invalidateOutputsForEdit();
      refreshWorkspaceSelectors();
      modelSetupStatus.textContent =
        `Saved 3D setup (reference A/B = ${reference.lengthMm} mm, ${stagedSnapshot.areas.length} area(s) as projected regions) to the master. ` +
        (referenceChanged ? `Reference changed: dependent geometry was recomputed. ` : '') +
        (modelFate.removed.length > 0
          ? `Removed ${modelFate.removed.length} deleted area(s) (“${modelFate.removed.map((entry) => entry.name).join('”, “')}”) — no longer selectable. `
          : '') +
        (modelFate.retired.length > 0
          ? `Retired ${modelFate.retired.length} placed area(s) with emptied geometry (“${modelFate.retired.map((entry) => entry.name).join('”, “')}”) — existing placements stay but are invalid until re-verified; no new placements fit there. `
          : '') +
        `Reopen the master to retain it. Provisional pending review, never production-approved.`;
    } catch (error) {
      modelSetupStatus.textContent = `Could not save the 3D setup: ${error instanceof Error ? error.message : String(error)}. Previous state is unchanged.`;
    }
  }, () => {
    modelSetupStatus.textContent = 'The project changed before saving started; save again. Nothing was saved.';
  });
}

workspaceProduct.addEventListener('change', () => {
  workspaceProductId = workspaceProduct.value !== '' ? workspaceProduct.value : null;
  workspaceVariantId = null;
  workspaceViewHint = null;
  guidedScale.hide();
  if (!prepareBlocked()) refreshWorkspace();
});
workspaceVariant.addEventListener('change', () => {
  workspaceVariantId = workspaceVariant.value !== '' ? workspaceVariant.value : null;
  workspaceViewHint = null;
  guidedScale.hide();
  if (!prepareBlocked()) refreshWorkspace();
});
modelSetupSave.addEventListener('click', () => {
  if (prepareBlocked()) return;
  void commitModelSetup();
});
modelSetupProductsToggle.addEventListener('change', () => {
  modelSetupBox.classList.toggle('hide-products', !modelSetupProductsToggle.checked);
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
    const viewId = scopeViewId(request.scope);
    const viewDisplay = workspaceViewNoun(scopeViewId(request.scope), request.scope.viewLabel);
    // The mapping-math bucket stays a legacy side (inert for flexible
    // views); identity, retirement and display always use the stable view id.
    const bucket = request.scope.side;
    if (viewId.length === 0) {
      return fail('Unknown view for this measurement; re-open the workspace view and measure again.');
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
      name: `${viewDisplay} measured area`,
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
      view: bucket,
      // Stable identity for flexible views (labels never identify); legacy
      // views carry no viewId and keep resolving through the bucket.
      ...(isLegacyViewId(viewId) ? {} : { viewId, ...(request.scope.viewLabel?.trim() ? { label: request.scope.viewLabel.trim().slice(0, 80) } : {}) }),
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
      mappingViewIdOf(candidate) === viewId && candidate.image === request.imagePath;
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
    source = replaceSessionProject(snapshot, back.project, back.assets, packageBytes.slice());
    // The package changed under any generated delivery: mark outputs stale
    // so a regen is required before download. Success path only.
    invalidateOutputsForEdit();
    // The replaced photo/scope binding is re-evaluated: retire staged drafts
    // bound to the PRE-COMMIT scope (old region, possibly unmeasured), so the
    // new photo starts fresh. regionId is the pre-commit one on purpose: the
    // fresh key carries the new region and must survive this event.
    draftRetirements.push({
      kind: 'binding-invalidated',
      productId: product.id,
      variantId: variant.id,
      regionId: request.scope.regionId,
      view: viewId,
      imagePath: request.imagePath,
    });
    workspaceViewHint = viewId;
    guidedScale.hide();
    refreshWorkspaceSelectors();
    workspaceView.refresh();
    refreshWorkspace();
    workspaceStatus.textContent =
      `Measured the ${viewDisplay} view: ${widthMm}×${heightMm} mm ` +
      `(max residual ${maxResidualMm.toFixed(3)} mm). Draw the safe area and place anchors, then save once.` +
      (warnNote !== '' ? ' Residual is high — verify the corners on the photo.' : '');
    return { ok: true };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  }, () => ({ ok: false, error: 'The project changed before measuring finished (new file opened or product added); measure again.' }));
}

/* ---------------- Two-click span calibration (Images path, lead-owned) ---- */
/* Primary Images-path calibration: the operator clicks reference points A   */
/* and B on the actual photo and enters their real straight-line length in   */
/* millimetres. ONE span determines a uniform scale only — never anisotropy, */
/* shear, rotation-from-pixels or perspective. The mm frame convention is    */
/* operator-determined and stated everywhere it surfaces: origin exactly on  */
/* A, +x from A toward B (a similarity: rotation + uniform scale). A single  */
/* span cannot solve arbitrary perspective: front-on planar photos only,     */
/* stated in UI copy. Every output stays provisional/pending review — never  */
/* production-approved.                                                      */
/*                                                                           */
/* Persistence: ONE atomic commit stores the calibration record, an          */
/* UNCONFIGURED region (safeArea [], never an invented polygon) and the      */
/* provisional similarity mapping, plus a deterministic sidecar              */
/* (`presentation/setup-calibration/<product>/<side>[.<scope>].images.json`, */
/* W1 `SetupCalibrationBundle`, verbatim). The workspace seeds its staged    */
/* area from the saved (empty) polygon, so a fresh calibration genuinely     */
/* starts empty; the operator draws named areas explicitly and saves once    */
/* through the normal path. Recalibration bumps the calibration version,     */
/* replaces the mapping and explicitly clears the drawn polygon (old frame). */
/* The sidecar + calibration travel with Save-prepared-master byte-          */
/* identically; the region + mapping travel to the customer file through     */
/* the existing presentation passthrough once saved.                         */

const SETUP_SPAN_DIR = 'presentation/setup-calibration';
const SETUP_SPAN_SIDECAR_VERSION = 'setup-span-sidecar/1';
const SETUP_SPAN_SIDECAR_MAX_BYTES = 64 * 1024;

/** Per-product explicit active-area hint file (display hint only; content helpers live in the view module). */
function activeAreasPathFor(productId: string): string {
  return `${SETUP_SPAN_DIR}/${safeProductSegment(productId)}/active-areas.json`;
}
interface SpanSidecarFile {
  version: typeof SETUP_SPAN_SIDECAR_VERSION;
  kind: 'images';
  productId: string;
  /** Variant the photo belongs to, or null for a product-wide photo. */
  variantId: string | null;
  /** Legacy math bucket (inert for flexible views; identity is `viewId`). */
  side: ProductSetupSide;
  /** Stable view identity for flexible named views; absent on legacy files. */
  viewId?: string;
  imagePath: string;
  calibrationId: string;
  bundle: SetupCalibrationBundle;
}

function spanScopeSuffix(variantId: string | undefined): string {
  return variantId === undefined ? 'product' : `variant-${safeProductSegment(variantId)}`;
}

function spanSidecarPathFor(productId: string, viewKey: string, variantId: string | undefined): string {
  // Legacy sidecars keep byte-identical paths; slug views use their slug
  // (already a safe segment) so >4 views never collide.
  const segment = isLegacyViewId(viewKey) ? viewKey : safeProductSegment(viewKey);
  return `${SETUP_SPAN_DIR}/${safeProductSegment(productId)}/${segment}.${spanScopeSuffix(variantId)}.images.json`;
}

function spanCalibrationIdFor(viewKey: string, variantId: string | undefined): string {
  const segment = isLegacyViewId(viewKey) ? viewKey : safeProductSegment(viewKey);
  return variantId === undefined ? `cal-span-${segment}` : `cal-span-${segment}-${safeProductSegment(variantId)}`;
}

/** Manifest scope of one photo path: variant id when the entry is variant-scoped. */
function spanPhotoVariantScope(imagePath: string): string | undefined {
  if (source === null) return undefined;
  const assets = sessionAssetMap();
  const manifest = parseFlexiblePresentationManifest(parseJsonBytes(assets.get(PRESENTATION_MANIFEST_PATH)));
  if (manifest === null) return undefined;
  const exact = manifest.views.find((entry) => entry.image === imagePath);
  return exact?.variantId ?? undefined;
}

function parseSpanSidecar(bytes: Uint8Array): { ok: true; sidecar: SpanSidecarFile } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (bytes.length === 0 || bytes.length > SETUP_SPAN_SIDECAR_MAX_BYTES) {
    return fail('span sidecar is empty or exceeds the 64 KiB sidecar bound');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('span sidecar is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) return fail('span sidecar must be an object');
  const record = raw as Record<string, unknown>;
  if (record['version'] !== SETUP_SPAN_SIDECAR_VERSION) return fail('span sidecar has an unknown version');
  if (record['kind'] !== 'images') return fail('span sidecar is not an Images span sidecar');
  if (typeof record['productId'] !== 'string' || record['productId'].length === 0) return fail('span sidecar productId must be a non-empty string');
  if (record['variantId'] !== null && (typeof record['variantId'] !== 'string' || (record['variantId'] as string).length === 0)) {
    return fail('span sidecar variantId must be null or a non-empty string');
  }
  if (record['side'] !== 'front' && record['side'] !== 'back' && record['side'] !== 'left' && record['side'] !== 'right') {
    return fail('span sidecar side must be one of front|back|left|right');
  }
  // Stable view identity for flexible named views (optional; legacy files
  // predate it). Bounded like other view identities; labels never live here.
  if (record['viewId'] !== undefined &&
    (typeof record['viewId'] !== 'string' || record['viewId'].length === 0 || record['viewId'].length > 128)) {
    return fail('span sidecar viewId must be a non-empty string of at most 128 characters when present');
  }
  if (typeof record['imagePath'] !== 'string' || (record['imagePath'] as string).length === 0) {
    return fail('span sidecar imagePath must be a non-empty string');
  }
  if (typeof record['calibrationId'] !== 'string' || (record['calibrationId'] as string).length === 0) {
    return fail('span sidecar calibrationId must be a non-empty string');
  }
  const bundle = parseSetupCalibration(record['bundle']);
  if (!bundle.ok) return fail(`span sidecar bundle is invalid: ${bundle.error}`);
  if (bundle.bundle.mode !== 'images') return fail('span sidecar bundle is not an Images bundle');
  if (bundle.bundle.spans.length === 0) return fail('span sidecar bundle carries no reference span');
  if (bundle.bundle.mmPerUnit === null || !(bundle.bundle.mmPerUnit > 0)) {
    return fail('span sidecar bundle carries no fitted scale');
  }
  return {
    ok: true,
    sidecar: {
      version: SETUP_SPAN_SIDECAR_VERSION,
      kind: 'images',
      productId: record['productId'] as string,
      variantId: record['variantId'] as string | null,
      side: record['side'] as ProductSetupSide,
      ...(typeof record['viewId'] === 'string' ? { viewId: record['viewId'] as string } : {}),
      imagePath: record['imagePath'] as string,
      calibrationId: record['calibrationId'] as string,
      bundle: bundle.bundle,
    },
  };
}

function serializeSpanSidecar(sidecar: SpanSidecarFile): Uint8Array {
  // Fixed key order, canonical W1 bundle text embedded — deterministic bytes.
  // `viewId` is written only for flexible views; legacy sidecars stay
  // byte-identical to previous writers.
  const ordered = {
    version: sidecar.version,
    kind: sidecar.kind,
    productId: sidecar.productId,
    variantId: sidecar.variantId,
    side: sidecar.side,
    ...(sidecar.viewId !== undefined ? { viewId: sidecar.viewId } : {}),
    imagePath: sidecar.imagePath,
    calibrationId: sidecar.calibrationId,
    bundle: JSON.parse(serializeSetupCalibration(sidecar.bundle)) as unknown,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * Commit a primary two-click reference span: validate through the W1 kernel,
 * then create the calibration record + UNCONFIGURED region (safeArea [], no
 * invented polygon) + provisional similarity mapping in ONE atomic
 * repackage-and-reparse commit. The operator draws the safe area on the now
 * measured photo and saves once through the normal workspace path.
 * Recalibrating the same photo replaces its calibration (bumped version)
 * and mapping, and explicitly clears the drawn polygon (it belonged to the
 * retired frame); staged millimetre drafts retire by construction (new
 * transform identity) plus an explicit retirement event. A photo whose saved
 * mapping comes from another setup is refused: re-measure there, or replace
 * the view image (which retires its mapping and span evidence).
 */
async function commitGuidedSpan(
  request: GuidedScaleRequest,
  span: GuidedScaleSpanCommit,
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
    const viewId = scopeViewId(request.scope);
    const viewDisplay = workspaceViewNoun(scopeViewId(request.scope), request.scope.viewLabel);
    // The mapping-math bucket stays a legacy side (inert for flexible
    // views); identity, sidecars and display use the stable view id.
    const bucket = request.scope.side;
    if (viewId.length === 0) {
      return fail('Unknown view for this measurement; re-open the workspace view and measure again.');
    }
    const assets = sessionAssetMap();
    const photoBytes = assets.get(request.imagePath);
    if (!photoBytes || photoBytes.length === 0) {
      return fail(`Photo “${request.imagePath}” is missing from the package; re-add the view image first.`);
    }
    const header = readRasterHeader(photoBytes);
    if (!header) return fail(`Photo “${request.imagePath}” is undecodable; re-add the view image first.`);
    const checked = validateImageSpan(span.aUv, span.bUv, span.lengthMm, { widthPx: header.width, heightPx: header.height });
    if (!checked.ok) return fail(checked.error);
    const kernelSpan: ReferenceSpan = {
      id: 'span-ab',
      a: { ...checked.span.a },
      b: { ...checked.span.b },
      lengthMm: checked.span.lengthMm,
    };
    const reason = validateReferenceSpan(kernelSpan);
    if (reason !== null) return fail(reason);
    const nativePx = spanNativeDistance(kernelSpan);
    if (nativePx === null || !(nativePx > 0)) {
      return fail('Points A and B do not span a usable photo distance — re-click two distinct points.');
    }
    const scaleMmPerPx = checked.span.lengthMm / nativePx;
    const transform = similarityTransformFromSpan({
      widthPx: header.width,
      heightPx: header.height,
      aUv: span.aUv,
      bUv: span.bUv,
      lengthMm: checked.span.lengthMm,
    });
    if (!transform) return fail('The two clicks do not determine a scale mapping; re-click two distinct points on the photo.');
    // Recalibration policy: a saved mapping owned by THIS span flow (a
    // `region-span-*` region bound to our calibration id) is replaced and its
    // drawn polygon is explicitly retired (it was authored in the old frame).
    // A mapping owned by anything else (rectangle flow, Advanced editor) is
    // refused — re-measure there, or replace the view image (which retires
    // its mapping and span evidence) and measure again.
    const manifestScope = spanPhotoVariantScope(request.imagePath);
    const calibrationId = spanCalibrationIdFor(viewId, manifestScope);
    // Owned scope regions: span-calibration regions that are NOT themselves
    // siblings (a sibling id always has an owning scope prefix; scopes never
    // do). Siblings resolve back to their owner below instead of ever
    // becoming the recalibration target themselves.
    const siblingIdSet = new Set(product.regions
      .map((region) => region.id)
      .filter((id) => scopeOwnerOf(product.regions, id) !== null));
    const ownRegionIds = new Set(
      product.regions
        .filter((region) => region.id.startsWith('region-span-') &&
          region.calibrationRef.calibrationId === calibrationId &&
          !siblingIdSet.has(region.id))
        .map((region) => region.id),
    );
    const existing = workspaceMappingFor(product.id, variant.id, viewId, request.imagePath);
    let recalibrating = false;
    let recalibrateRegionId: string | null = null;
    // Recalibration targets the OWNING scope region: a sibling-owned mapping
    // resolves back to its scope (stable owner lookup, never the sibling id,
    // so placements and identity stay on the scope). Anything else keeps a
    // saved mapping from another setup: refuse with a route.
    if (existing) {
      let ownerRegionId: string | null = ownRegionIds.has(existing.regionId) ? existing.regionId : null;
      if (ownerRegionId === null) {
        const owner = scopeOwnerOf(product.regions, existing.regionId);
        ownerRegionId = owner !== null && ownRegionIds.has(owner) ? owner : null;
      }
      if (ownerRegionId === null) {
        return fail('This view already has a saved mapping from another setup. Re-measure with the known-rectangle flow in Measure setup, or replace the view image (which retires its mapping and span evidence) and measure again.');
      }
      recalibrating = true;
      recalibrateRegionId = ownerRegionId;
    }
    const priorCalibration = product.calibrations.find((entry) => entry.id === calibrationId);
    const priorVersion = priorCalibration === undefined ? 0 : Number.parseInt(priorCalibration.version, 10);
    const nextVersion = String(Number.isFinite(priorVersion) && priorVersion > 0 ? priorVersion + 1 : 1);
    const sidecarPath = spanSidecarPathFor(product.id, viewId, manifestScope);
    const bundle: SetupCalibrationBundle = {
      version: '0.1.0-provisional-setup-calibration',
      mode: 'images',
      spans: [kernelSpan],
      mmPerUnit: scaleMmPerPx,
      areas: [],
    };
    // The bundle serializes deterministically (throws on invalid drafts).
    let sidecarBytes: Uint8Array;
    try {
      sidecarBytes = serializeSpanSidecar({
        version: SETUP_SPAN_SIDECAR_VERSION,
        kind: 'images',
        productId: product.id,
        variantId: manifestScope ?? null,
        side: bucket,
        // Stable identity for flexible views; legacy sidecars carry no viewId.
        ...(isLegacyViewId(viewId) ? {} : { viewId }),
        imagePath: request.imagePath,
        calibrationId,
        bundle,
      });
    } catch (error) {
      return fail(`The reference cannot be stored (${error instanceof Error ? error.message : String(error)}).`);
    }
    const next: ProjectDocument = JSON.parse(JSON.stringify(snapshot.project)) as ProjectDocument;
    const nextProduct = next.products.find((entry) => entry.id === product.id)!;
    const calibrationDescription =
      `Two-click span on the ${viewDisplay} view (${request.imagePath}): ` +
      `reference A/B = ${checked.span.lengthMm} mm; uniform scale ${scaleMmPerPx} mm per photo pixel; ` +
      `mm origin at A, +x from A toward B; front-on planar assumption, provisional pending review — never production-approved.`;
    const priorNext = nextProduct.calibrations.find((entry) => entry.id === calibrationId);
    if (priorNext) {
      priorNext.version = nextVersion;
      priorNext.description = calibrationDescription;
    } else {
      nextProduct.calibrations.push({ id: calibrationId, version: nextVersion, description: calibrationDescription });
    }
    // The region starts UNCONFIGURED (safeArea []): no safe polygon is ever
    // invented. The operator draws it on the measured photo and saves once
    // through the normal workspace path. Recalibration clears previously
    // drawn polygons explicitly — scope region AND named siblings (all
    // `region-span-*` regions bound to this calibration, matched by prefix
    // plus calibration id) — they belonged to the retired frame. Refs bump
    // with the calibration so validation stays satisfiable.
    let regionId: string;
    let clearedSiblingNames: string[] = [];
    if (recalibrating) {
      for (const region of nextProduct.regions) {
        if (region.id.startsWith('region-span-') && region.calibrationRef.calibrationId === calibrationId) {
          if (region.id.includes(SIBLING_REGION_SEPARATOR) && region.safeArea.length > 0) {
            clearedSiblingNames.push(region.name ?? region.id);
          }
          region.safeArea = [];
          region.calibrationRef = { calibrationId, version: nextVersion };
        }
      }
      const kept = (recalibrateRegionId !== null
        ? nextProduct.regions.find((region) => region.id === recalibrateRegionId)
        : undefined)
        ?? nextProduct.regions.find((region) =>
          region.id.startsWith('region-span-') && region.calibrationRef.calibrationId === calibrationId);
      if (!kept) return fail('The span area for this view is gone; measure it again first.');
      regionId = kept.id;
    } else {
      const takenRegions = new Set(nextProduct.regions.map((entry) => entry.id));
      let regionSeq = nextProduct.regions.length + 1;
      while (takenRegions.has(`region-span-${regionSeq}`)) regionSeq += 1;
      regionId = `region-span-${regionSeq}`;
      const frameId = `frame-${regionId}`;
      nextProduct.regions.push({
        id: regionId,
        name: `${viewDisplay} span area`,
        frame: {
          frameId,
          originDescription: `Two-click reference point A on the ${viewDisplay} view (${request.imagePath}); millimetre origin at A`,
          axes: { xPositive: 'from reference point A toward reference point B', yPositive: '90° counter-clockwise of A→B in the photo plane (front-on planar assumption)' },
        },
        calibrationRef: { calibrationId, version: nextVersion },
        safeArea: [],
        allowedMethods: ['embroidery', 'print'],
      });
      const nextVariant = nextProduct.variants.find((entry) => entry.id === variant.id)!;
      if (!nextVariant.regionIds.includes(regionId)) nextVariant.regionIds.push(regionId);
    }
    const frameId = nextProduct.regions.find((entry) => entry.id === regionId)!.frame.frameId;
    const entry: PhotoMappingEntry = {
      productId: product.id,
      variantId: variant.id,
      regionId,
      view: bucket,
      // Stable identity for flexible views (labels never identify); legacy
      // views carry no viewId and keep resolving through the bucket.
      ...(isLegacyViewId(viewId) ? {} : { viewId, ...(request.scope.viewLabel?.trim() ? { label: request.scope.viewLabel.trim().slice(0, 80) } : {}) }),
      image: request.imagePath,
      transform: { ...transform },
      calibrationId,
      calibrationVersion: nextVersion,
      status: 'provisional',
      note: `Two-click span A/B = ${checked.span.lengthMm} mm (origin at A, +x toward B); uniform scale only, front-on planar assumption; provisional pending review — never production-approved.`,
    };
    const problems = validatePhotoMapping(entry);
    if (problems.length > 0) return fail(`The mapping is invalid: ${problems.join('; ')}.`);
    const validated = validateProject(next);
    if (!validated || validated.ok !== true) {
      const detail = validated && Array.isArray(validated.errors)
        ? validated.errors.slice(0, 3).map((issue) => `${issue.code} at ${issue.path}`).join('; ')
        : 'the project did not validate';
      return fail(`The project rejects this reference (${detail}).`);
    }
    if (stale()) return fail('The project changed while measuring (new file opened or product added); measure again.');
    const livePhoto = sessionAssetMap().get(request.imagePath);
    if (!livePhoto || livePhoto.length === 0) {
      return fail(`Photo “${request.imagePath}” left the package while measuring; re-add the product photo first.`);
    }
    // Mappings file: base entries minus the replaced span entries (on
    // recalibration, every mapping bound to this photo — scope plus
    // siblings), staged entries likewise, plus the new span entry and the
    // rewritten sibling mappings (new transform + calibration version) —
    // replaced, never duplicated. The sidecar is always (over)written.
    const isReplacedMapping = (candidate: PhotoMappingEntry): boolean =>
      candidate.productId === product.id && candidate.variantId === variant.id &&
      mappingViewIdOf(candidate) === viewId && candidate.image === request.imagePath;
    const base = parsePhotoMappings(snapshot.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH && asset.kind === 'additional')?.bytes);
    const baseKept = (base?.mappings ?? []).filter((candidate) => !recalibrating || !isReplacedMapping(candidate));
    const stagedKept = stagedPhotoMappings.filter((candidate) => !recalibrating || !isReplacedMapping(candidate));
    const rewrittenSiblings: PhotoMappingEntry[] = recalibrating
      ? mergeSessionPhotoMappings({ version: 1, mappings: base?.mappings ?? [] }, stagedPhotoMappings).mappings
        .filter((candidate) => isReplacedMapping(candidate) && mappingKeyOf(candidate) !== mappingKeyOf(entry))
        .map((candidate) => ({ ...candidate, transform: { ...transform }, calibrationVersion: nextVersion }))
      : [];
    const mergedBytes = serializePhotoMappings(mergeSessionPhotoMappings(
      { version: 1, mappings: baseKept }, [...stagedKept, entry, ...rewrittenSiblings]));
    const additionalAssets = [
      ...snapshot.assets
        .filter((asset) => asset.kind === 'additional' && asset.path !== OPERATION_ANCHORS_PATH && asset.path !== sidecarPath && asset.path !== PHOTO_MAPPINGS_PATH)
        .map(({ path, bytes }) => ({ path, bytes })),
      { path: PHOTO_MAPPINGS_PATH, bytes: mergedBytes },
      { path: sidecarPath, bytes: sidecarBytes },
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
    const backSidecar = back.assets.find((asset) => asset.path === sidecarPath);
    const sidecarIdentical = backSidecar !== undefined &&
      backSidecar.bytes.length === sidecarBytes.length &&
      backSidecar.bytes.every((value, index) => value === sidecarBytes[index]);
    if (!sidecarIdentical) {
      return fail('The reparse lost the new reference; the previous project is unchanged.');
    }
    // The packaged mapping file must carry the new span entry with its exact
    // transform — compare content, not just presence — plus every rewritten
    // sibling mapping.
    const backMappings = parsePhotoMappings(back.assets.find((asset) => asset.path === PHOTO_MAPPINGS_PATH)?.bytes);
    const backEntry = backMappings?.mappings.find((candidate) => mappingKeyOf(candidate) === mappingKeyOf(entry));
    if (!backEntry || JSON.stringify(backEntry.transform) !== JSON.stringify(entry.transform) ||
      backEntry.regionId !== entry.regionId || backEntry.calibrationId !== entry.calibrationId) {
      return fail('The reparse lost the new mapping; the previous project is unchanged.');
    }
    for (const rewritten of rewrittenSiblings) {
      const backTwin = backMappings?.mappings.find((candidate) => mappingKeyOf(candidate) === mappingKeyOf(rewritten));
      if (!backTwin || JSON.stringify(backTwin.transform) !== JSON.stringify(rewritten.transform) ||
        backTwin.calibrationVersion !== rewritten.calibrationVersion) {
        return fail('The reparse lost a rewritten area mapping; the previous project is unchanged.');
      }
    }
    if (stale()) return fail('The project changed while measuring (new file opened or product added); measure again.');
    stagedPhotoMappings = [...stagedKept, entry, ...rewrittenSiblings];
    // The scope region restarts with no named siblings either way.
    areaManifestBaseline.set(regionId, '[]');
    source = replaceSessionProject(snapshot, back.project, back.assets, packageBytes.slice());
    // The package changed under any generated delivery: mark outputs stale
    // so a regen is required before download. Success path only.
    invalidateOutputsForEdit();
    // Staged millimetre drafts retire on first calibration: the pre-commit
    // (unmeasured) bucket key is pruned so its pixel-frame geometry can never
    // leak into the measured view. The event carries the PRE-COMMIT region id
    // on purpose — the fresh key (new region + transform) must survive it.
    // Recalibration pushes nothing: the transform change alone orphans the
    // old bucket, and the same region id would also match (and kill) the new
    // bucket on every render.
    if (!recalibrating) {
      draftRetirements.push({
        kind: 'binding-invalidated',
        productId: product.id,
        variantId: variant.id,
        regionId: request.scope.regionId,
        view: viewId,
        imagePath: request.imagePath,
      });
    }
    workspaceViewHint = viewId;
    guidedScale.hide();
    refreshWorkspaceSelectors();
    workspaceView.refresh();
    refreshWorkspace();
    workspaceStatus.textContent = recalibrating
      ? `Re-measured the ${viewDisplay} view: A/B = ${checked.span.lengthMm} mm ` +
        `(uniform scale ${scaleMmPerPx} mm per photo pixel; origin at A, +x toward B). ` +
        `The previous frame's drawn safe polygons were cleared — draw them again on the photo and save once. ` +
        (clearedSiblingNames.length > 0 ? `Cleared named areas: “${clearedSiblingNames.join('”, “')}”. ` : '') +
        `Front-on planar assumption; provisional pending review, never production-approved.`
      : `Measured the ${viewDisplay} view from a two-click reference: A/B = ${checked.span.lengthMm} mm ` +
        `(uniform scale ${scaleMmPerPx} mm per photo pixel; origin at A, +x toward B). ` +
        `The area starts unconfigured — no safe polygon was invented. Draw it on the photo and save once. ` +
        `Front-on planar assumption; provisional pending review, never production-approved.`;
    return { ok: true };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  }, () => ({ ok: false, error: 'The project changed before measuring finished (new file opened or product added); measure again.' }));
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

/** Parse JSON bytes leniently: null when absent, empty or unparseable. */
function parseJsonBytes(bytes: Uint8Array | undefined): unknown {
  if (!bytes || bytes.length === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
