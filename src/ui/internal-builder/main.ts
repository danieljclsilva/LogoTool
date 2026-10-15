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
import { createWebCryptoProjectHasher } from '../shared/browser-hasher.js';
import { zipSync } from 'fflate';

interface SourceState {
  fileName: string;
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
  summary: BuilderSourceSummary;
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

const hasher = createWebCryptoProjectHasher();

let source: SourceState | null = null;
let generated: GeneratedState | null = null;
let loadedBaseline: BaselineState | null = null;
let lastReturn: ReturnState | null = null;
let selectionValid = false;
let loading = false;
let generating = false;
let returnBusy = false;
let baselineBusy = false;
let loadGeneration = 0;
let generateGeneration = 0;
let returnGeneration = 0;
let baselineGeneration = 0;

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
  clearReturnReview();
  updateControls();
}

function updateControls(): void {
  const blocked = loading || generating || returnBusy || baselineBusy;
  sourceChoose.disabled = blocked;
  sourceFile.disabled = blocked;
  baselineChoose.disabled = blocked;
  baselineFile.disabled = blocked;
  generateButton.disabled = source === null || !selectionValid || blocked;
  const hasOutput = generated !== null && !blocked;
  downloadPackage.disabled = !hasOutput;
  downloadHtml.disabled = !hasOutput;
  downloadBaseline.disabled = activeBaseline() === null || blocked;
  downloadReviewer.disabled = blocked;
  projectIdUseSource.disabled = source === null || blocked;
  for (const input of [customerName, jobRef, issuedBy, projectIdInput, formatSelf, formatHybrid]) input.disabled = blocked;
  for (const input of document.querySelectorAll<HTMLInputElement>('.check-list input')) input.disabled = blocked;
  const hasReturn = lastReturn !== null && !blocked;
  candidateDownload.disabled = !hasReturn;
  operationPrint.disabled = !hasReturn;
  returnFile.disabled = blocked || activeBaseline() === null;
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

function renderSelectionLists(summary: BuilderSourceSummary): void {
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
      const { row } = createCheckRow(product.id, `${product.name} (${product.id})`);
      productList.append(row);
      if (product.variantIds.length > 0) {
        const variants = document.createElement('div');
        variants.className = 'variants';
        for (const variantId of product.variantIds) {
          const variant = createCheckRow(variantId, variantId);
          variant.box.setAttribute('data-product', product.id);
          variants.append(variant.row);
        }
        productList.append(variants);
      }
    }
  }
  if (summary.logoIds.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No logos in source.';
    logoList.append(empty);
  } else {
    for (const logoId of summary.logoIds) {
      const logo = source?.project.logos.find((entry) => entry.id === logoId);
      const label = logo?.name !== undefined ? `${logo.name} (${logoId})` : logoId;
      logoList.append(createCheckRow(logoId, label).row);
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
        ? `${configuration.id} — ${configuration.productId} / ${configuration.variantId}`
        : configurationId;
      configurationList.append(createCheckRow(configurationId, label).row);
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
  const totalConfigurations = source?.summary.configurationIds.length ?? 0;
  if (allConfigurations.length !== totalConfigurations) selection.configurationIds = allConfigurations;
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
    generateStatus.textContent =
      `Selection valid: ${selection.productIds.length} products, ${selection.logoIds.length} logos, ${configurationCount.length} source configurations. Selected variants without defaults start empty in automatic mode.`;
  } else {
    selectionValid = false;
    generateStatus.textContent = `Selection invalid: ${outcome.errors.map((error) => error.message).join('; ')}`;
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
  const generation = ++loadGeneration;
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
    source = { fileName: file.name, project: parsed.project, assets: parsed.assets, summary };
    renderSelectionLists(summary);
    projectIdSuggestion.textContent = `Source project ID “${summary.projectId}”. Enter a unique ID for this customer issue.`;
    clearGeneratedOutputs();
    sourceStatus.textContent = `Loaded ${file.name}: project ${summary.projectId} revision ${summary.revision}, ${summary.productIds.length} products, ${summary.logoIds.length} logos, ${summary.configurationIds.length} configurations, ${summary.assetPaths.length} assets.`;
    refreshSelectionValidation();
  } catch (error) {
    if (generation === loadGeneration) sourceStatus.textContent = `Could not load ${file.name}: invalid source: ${error instanceof Error ? error.message : String(error)}. The previous source remains unchanged.`;
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
  if (source === null || loading || generating || baselineBusy || returnBusy) return;
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
      }
      return;
    }
    if (generation !== generateGeneration) return;
    const issuedAssets = selectIssuedAssets(
      snapshot.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes })),
      issued.project,
    );
    const packageBytes = await createProjectPackage(
      { project: issued.project, assets: issuedAssets },
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
    const retainedAssets: ProjectPackageAsset[] = issuedAssets.map((asset) => ({
      path: asset.path,
      bytes: asset.bytes,
      kind: 'referenced' as const,
    }));
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
        `Format: hybrid; package ${packageBytes.length} bytes; configurator HTML ${editorBytes.length} bytes; zip ${zipBytes!.length} bytes.`;
    } else {
      sizeEstimate.textContent =
        `Format: self-contained; package ${packageBytes.length} bytes; self-contained HTML ${htmlBytes.length} bytes.`;
    }
    baselineStatus.textContent =
      `Retained issued baseline: ${identity.projectId} revision 1 (${packageBytes.length} bytes). Save this exact file before closing the page; memory is lost on reload.`;
    generateStatus.textContent =
      `Issued ${identity.projectId} revision 1 for ${identity.customerLabel} / ${identity.jobReference} by ${identity.issuedBy}. Confirmation and internal review history reset before customer handoff.`;
  } catch (error) {
    if (generation === generateGeneration) {
      generated = null;
      sizeEstimate.textContent = 'No issued package generated yet.';
      baselineStatus.textContent = 'No issued baseline retained; generate a package first.';
      generateStatus.textContent = `Generation failed: ${error instanceof Error ? error.message : String(error)}`;
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
    generateStatus.textContent = `Downloaded ${generated.jobPart}.zip (${generated.zipBytes.length} bytes).`;
  } else {
    downloadBytes(generated.packageBytes, `${generated.jobPart}.logo-project`, 'application/zip');
    generateStatus.textContent = `Downloaded ${generated.jobPart}.logo-project (${generated.packageBytes.length} bytes).`;
  }
}

function downloadHtmlFile(): void {
  if (generated === null || loading || generating || returnBusy || baselineBusy) return;
  downloadBytes(generated.htmlBytes, 'OPEN_LOGO_CONFIGURATOR.html', 'text/html');
  generateStatus.textContent = `Downloaded OPEN_LOGO_CONFIGURATOR.html (${generated.htmlBytes.length} bytes).`;
}

function downloadBaselineFile(): void {
  if (loading || generating || returnBusy || baselineBusy) return;
  const baseline = activeBaseline();
  if (baseline === null) return;
  downloadBytes(baseline.packageBytes, `${baseline.jobPart}-issued-baseline.logo-project`, 'application/zip');
  baselineStatus.textContent =
    `Issued baseline downloaded byte-identical (${baseline.packageBytes.length} bytes).`;
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
  } catch (error) {
    if (generation === baselineGeneration) baselineLoadStatus.textContent = `Could not load baseline ${file.name}: ${error instanceof Error ? error.message : String(error)}. The previous baseline remains unchanged.`;
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
  const generation = ++returnGeneration;
  if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    returnBusy = false;
    updateControls();
    returnStatus.textContent = `Could not import return ${file.name}: archive size exceeds limit; rejected before reading.`;
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
    const differences = document.createElement('pre');
    differences.setAttribute('data-builder-dynamic', 'true');
    differences.textContent = differenceLines(baseline.issuedProject, imported).join('\n\n');
    reviewPanel.insertBefore(confirmation, anchor);
    reviewPanel.insertBefore(geometrySummary, anchor);
    reviewPanel.insertBefore(differences, anchor);
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
  } catch (error) {
    if (generation !== returnGeneration) return;
    returnStatus.textContent = `Could not import return ${file.name}: ${error instanceof Error ? error.message : String(error)}. The previous valid review remains unchanged.`;
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
    returnStatus.textContent = `Downloaded ${snapshot.candidateFileName}.`;
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

sourceChoose.addEventListener('click', () => sourceFile.click());
sourceFile.addEventListener('change', onSourceFileChange);
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
customerName.addEventListener('input', () => refreshSelectionValidation());
jobRef.addEventListener('input', () => refreshSelectionValidation());
issuedBy.addEventListener('input', () => refreshSelectionValidation());
projectIdInput.addEventListener('input', () => refreshSelectionValidation());
formatSelf.addEventListener('change', () => refreshSelectionValidation());
formatHybrid.addEventListener('change', () => refreshSelectionValidation());
updateControls();
