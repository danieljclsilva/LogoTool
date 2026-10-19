import {
  buildCandidateExport,
  canonicalize,
  importCustomerReturn,
  newRevision,
  recordInternalReview,
  serializeExport,
  validateProject,
} from '../../core/index.js';
import type { Configuration, Placement, ProjectDocument, ResultCandidate, ReviewDecision } from '../../core/index.js';
import type { OperationIdentity, ReferenceViewInput } from '../../core/operation-document/types.js';
import { buildOperationDocument } from '../../core/operation-document/index.js';
import { renderOperationDocument, operationDocumentStyles, selectOperationReferenceViews } from '../shared/operation-document/index.js';
import { assertProjectEditorLimits, evaluateProjectGeometry } from '../../core/project-editor/index.js';
import {
  createProjectPackage,
  PROJECT_PACKAGE_LIMITS,
  parseProjectPackage,
} from '../../packaging/project-package/index.js';
import type { ProjectPackageAsset, ProjectPackageAssetInput } from '../../packaging/project-package/index.js';
import { createWebCryptoProjectHasher } from '../shared/browser-hasher.js';

interface LoadedArchive {
  name: string;
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
}

const required = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required return-review element: ${selector}`);
  return element;
};
const hook = <T extends Element>(name: string): T => required<T>(`[data-review-hook="${name}"]`);

const baselineInput = hook<HTMLInputElement>('baseline-file');
const returnInput = hook<HTMLInputElement>('return-file');
const baselineName = hook<HTMLElement>('baseline-name');
const returnName = hook<HTMLElement>('return-name');
const status = hook<HTMLElement>('status');
const panel = hook<HTMLElement>('review-panel');
const projectId = hook<HTMLElement>('project-id');
const revisions = hook<HTMLElement>('revisions');
const confirmationSummary = hook<HTMLElement>('confirmation');
const geometrySummary = hook<HTMLElement>('geometry');
const reviewSummary = hook<HTMLElement>('internal-review');
const differences = hook<HTMLElement>('differences');
const reviewerInput = hook<HTMLInputElement>('reviewer');
const decisionInput = hook<HTMLSelectElement>('decision');
const noteInput = hook<HTMLTextAreaElement>('note');
const recordButton = hook<HTMLButtonElement>('record-review');
const saveReviewedButton = hook<HTMLButtonElement>('save-reviewed');
const configInput = hook<HTMLSelectElement>('configuration');
const placementInput = hook<HTMLSelectElement>('placement');
const xInput = hook<HTMLInputElement>('x');
const yInput = hook<HTMLInputElement>('y');
const widthInput = hook<HTMLInputElement>('width');
const heightInput = hook<HTMLInputElement>('height');
const rotationInput = hook<HTMLInputElement>('rotation');
const instructionsInput = hook<HTMLTextAreaElement>('instructions');
const saveProposalButton = hook<HTMLButtonElement>('save-proposal');
const candidateStatus = hook<HTMLElement>('candidate-status');
const candidateSummary = hook<HTMLElement>('candidate-summary');
const candidateConfigurations = hook<HTMLElement>('candidate-configurations');
const candidateDownload = hook<HTMLButtonElement>('candidate-download');
const operationDocumentContainer = hook<HTMLElement>('operation-document-container');
const operationDocumentPrint = hook<HTMLButtonElement>('operation-document-print');

const hasher = createWebCryptoProjectHasher();
let baseline: LoadedArchive | null = null;
let returned: LoadedArchive | null = null;
let imported: ProjectDocument | null = null;
let returnedAssets: ProjectPackageAsset[] = [];
let currentDigest = '';
let currentFit = false;
let busy = false;
let operationGeneration = 0;

function setStatus(message: string): void {
  status.textContent = message;
}

function setBusy(value: boolean): void {
  busy = value;
  baselineInput.disabled = value;
  returnInput.disabled = value;
  updateControls();
}

function updateControls(): void {
  const ready = imported !== null && !busy;
  const validReviewer = reviewerInput.value.trim().length > 0;
  const decision: ReviewDecision = decisionInput.value as ReviewDecision;
  recordButton.disabled = !ready || !validReviewer || (decision === 'approved' && (!currentFit || !hasCurrentConfirmation()));
  saveReviewedButton.disabled = !ready || !hasCurrentInternalReview();
  saveProposalButton.disabled = !ready;
  candidateDownload.disabled = !ready;
  operationDocumentPrint.disabled = !ready;
  const hasSelectedPlacement = selectedPlacement() !== null;
  for (const input of [xInput, yInput, widthInput, heightInput, rotationInput]) {
    input.disabled = !ready || !hasSelectedPlacement;
  }
  configInput.disabled = !ready;
  placementInput.disabled = !ready || !hasSelectedPlacement;
  instructionsInput.disabled = !ready;
  reviewerInput.disabled = !ready;
  decisionInput.disabled = !ready;
  noteInput.disabled = !ready;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compareAssetBytes(issued: readonly ProjectPackageAsset[], back: readonly ProjectPackageAsset[]): string[] {
  const issuedByPath = new Map(issued.map((asset) => [asset.path, asset]));
  const returnedByPath = new Map(back.map((asset) => [asset.path, asset]));
  const paths = new Set([...issuedByPath.keys(), ...returnedByPath.keys()]);
  const errors: string[] = [];
  for (const path of [...paths].sort()) {
    const original = issuedByPath.get(path);
    const candidate = returnedByPath.get(path);
    if (!original || !candidate) {
      errors.push(`${path}: asset is missing from ${original ? 'the return' : 'the issued baseline'}`);
    } else if (original.kind !== candidate.kind || !sameBytes(original.bytes, candidate.bytes)) {
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

function renderDifferences(issued: ProjectDocument, back: ProjectDocument): void {
  const issuedById = new Map(issued.configurations.map((configuration) => [configuration.id, configuration]));
  const returnedById = new Map(back.configurations.map((configuration) => [configuration.id, configuration]));
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
  differences.textContent = rows.length > 0 ? rows.join('\n\n') : 'No configuration or instruction differences from the issued baseline.';
}

function hasCurrentConfirmation(): boolean {
  return imported !== null && imported.confirmation !== undefined &&
    imported.confirmation.revision === imported.revision && imported.confirmation.digest === currentDigest;
}

function hasCurrentInternalReview(): boolean {
  return imported !== null && imported.review !== undefined &&
    imported.review.revision === imported.revision && imported.review.digest === currentDigest;
}

function currentFitSummary(): string {
  if (!imported) return 'No imported project.';
  const verdict = evaluateProjectGeometry(imported);
  currentFit = verdict.ok;
  if (verdict.placements.length === 0) return verdict.ok ? 'Valid: no placements; no geometric restrictions apply.' : 'Invalid project geometry.';
  const failures = verdict.placements.filter((item) => !item.ok);
  return failures.length === 0
    ? `Valid: ${verdict.placements.length} measured footprint(s) fit their safe regions and avoid exclusions.`
    : `Invalid: ${failures.map((item) => `${item.configurationId}/${item.placementId ?? `Placement ${item.placementIndex + 1}`}: ${item.reason}`).join('; ')}`;
}

function renderProject(): void {
  if (!imported || !baseline) {
    panel.hidden = true;
    candidateStatus.textContent = '';
    candidateSummary.textContent = '';
    candidateConfigurations.textContent = '';
    operationDocumentContainer.textContent = '';
    operationDocumentContainer.hidden = true;
    document.getElementById('operation-document-styles')?.remove();
    updateControls();
    return;
  }
  panel.hidden = false;
  projectId.textContent = imported.projectId;
  revisions.textContent = `${baseline.project.revision} / ${imported.revision}`;
  confirmationSummary.textContent = hasCurrentConfirmation()
    ? `Current for revision ${imported.confirmation!.revision}; confirmed by ${imported.confirmation!.confirmedBy} (unverified identity).`
    : imported.confirmation
      ? `Stale or mismatched confirmation for revision ${imported.confirmation.revision}; not trusted.`
      : 'No customer confirmation; draft only.';
  geometrySummary.textContent = currentFitSummary();
  reviewSummary.textContent = imported.review
    ? `${hasCurrentInternalReview() ? "Current" : "Stale"}: ${imported.review.decision} for revision ${imported.review.revision}, by ${imported.review.reviewer} at ${imported.review.at} (self-entered; workflow data only).${imported.review.note === undefined ? "" : `\nReview note: ${imported.review.note}`}`
    : `No current internal review. Returned review fields were discarded. Preserved trusted-baseline review history: ${imported.reviewHistory?.length ?? 0}.`;
  renderDifferences(baseline.project, imported);
  renderEditorChoices();
  const candidate = JSON.parse(serializeExport(buildCandidateExport(imported, hasher.sha256Hex))) as ResultCandidate;
  renderCandidatePreview(candidate);
  renderOperationDocumentPreview(candidate);
  updateControls();
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function createTextElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string): HTMLElementTagNameMap[K] {
  const element = createElement(tag, className);
  element.textContent = text;
  return element;
}

function appendDefinitionList(parent: HTMLElement, items: { term: string; details: string }[]): void {
  const dl = createElement('dl');
  for (const item of items) {
    const dt = createTextElement('dt', item.term);
    const dd = createTextElement('dd', item.details);
    dl.append(dt, dd);
  }
  parent.append(dl);
}

function appendOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function renderCandidatePreview(candidate: ResultCandidate): void {
  candidateStatus.textContent = `Status: ${candidate.status} · Schema: ${candidate.schemaVersion}`;

  candidateSummary.replaceChildren();
  const summaryGrid = createElement('div', 'summary-grid');
  const summaryItems = [
    { term: 'Project ID', details: candidate.projectId },
    { term: 'Revision', details: String(candidate.revision) },
    { term: 'Digest', details: candidate.digest },
    { term: 'Instructions', details: candidate.instructions ?? '(none)' },
  ];
  for (const item of summaryItems) {
    const cell = createElement('div');
    appendDefinitionList(cell, [item]);
    summaryGrid.append(cell);
  }
  candidateSummary.append(summaryGrid);

  candidateConfigurations.replaceChildren();
  if (candidate.configurations.length === 0) {
    candidateConfigurations.textContent = 'No configurations.';
    return;
  }

  for (const configuration of candidate.configurations) {
    const card = createElement('div', 'panel');
    const header = createTextElement('h3', `${configuration.productId} / ${configuration.variantId}`);
    card.append(header);

    const configMeta: { term: string; details: string }[] = [
      { term: 'Configuration ID', details: configuration.id },
      { term: 'Product ID', details: configuration.productId },
      { term: 'Variant ID', details: configuration.variantId },
    ];
    if (configuration.productName) configMeta.push({ term: 'Product name', details: configuration.productName });
    if (configuration.variantName) configMeta.push({ term: 'Variant name', details: configuration.variantName });
    configMeta.push({ term: 'Placements', details: String(configuration.placements.length) });
    appendDefinitionList(card, configMeta);

    if (configuration.placements.length === 0) {
      const zero = createTextElement('p', '0 placements');
      zero.className = 'trust';
      card.append(zero);
    } else {
      for (const [index, placement] of configuration.placements.entries()) {
        const placementCard = createElement('div', 'panel');
        const placementHeader = createTextElement('h4', `${index + 1}. Placement ${placement.id ?? index + 1}`);
        placementCard.append(placementHeader);

        const placementMeta: { term: string; details: string }[] = [
          { term: 'Configuration ID', details: placement.configurationId },
          { term: 'Product ID', details: placement.productId },
          { term: 'Variant ID', details: placement.variantId },
          { term: 'Logo ID', details: placement.logoId },
          { term: 'Region ID', details: placement.regionId },
          { term: 'Method', details: placement.method },
          { term: 'Centre X', details: `${placement.pos.xMm} mm` },
          { term: 'Centre Y', details: `${placement.pos.yMm} mm` },
          { term: 'Width', details: `${placement.widthMm} mm` },
          { term: 'Height', details: `${placement.heightMm} mm` },
          { term: 'Clockwise rotation', details: `${placement.rotationDeg}°` },
        ];
        if (placement.instructions !== undefined) {
          placementMeta.push({ term: 'Placement instructions', details: placement.instructions });
        }
        appendDefinitionList(placementCard, placementMeta);

        const frameSection = createTextElement('h5', 'Frame');
        placementCard.append(frameSection);
        appendDefinitionList(placementCard, [
          { term: 'Frame ID', details: placement.frame.frameId },
          { term: 'Origin description', details: placement.frame.originDescription },
          { term: 'X-positive axis', details: placement.frame.axes.xPositive },
          { term: 'Y-positive axis', details: placement.frame.axes.yPositive },
          { term: 'Unit', details: placement.frame.unit },
          { term: 'Reference point', details: placement.frame.referencePoint },
          { term: 'Rotation convention', details: placement.frame.rotationConvention },
        ]);

        const calibrationSection = createTextElement('h5', 'Calibration');
        placementCard.append(calibrationSection);
        appendDefinitionList(placementCard, [
          { term: 'Calibration ID', details: placement.calibration.calibrationId },
          { term: 'Version', details: placement.calibration.version },
        ]);

        const logo = candidate.logos.find((item) => item.id === placement.logoId);
        if (logo?.name !== undefined) appendDefinitionList(placementCard, [{ term: 'Logo name', details: logo.name }]);
        const artworkSection = createTextElement('h5', `Artwork — logo ${placement.artwork.logoId}`);
        placementCard.append(artworkSection);
        if (placement.artwork.role) {
          appendDefinitionList(placementCard, [{ term: 'Artwork role', details: placement.artwork.role }]);
        }
        if (placement.artwork.assets.length === 0) {
          const noAssets = createTextElement('p', 'No assets.');
          noAssets.className = 'trust';
          placementCard.append(noAssets);
        } else {
          for (const [assetIndex, asset] of placement.artwork.assets.entries()) {
            const assetCard = createElement('div');
            assetCard.className = 'panel';
            const assetHeader = createTextElement('h6', `Asset ${assetIndex + 1}`);
            assetCard.append(assetHeader);
            appendDefinitionList(assetCard, [
              { term: 'Role', details: asset.role },
              { term: 'URI', details: asset.uri },
              { term: 'Media type', details: asset.mediaType },
              { term: 'SHA-256', details: asset.sha256Hex ?? '(not recorded)' },
            ]);
            if (asset.description !== undefined) appendDefinitionList(assetCard, [{ term: 'Description', details: asset.description }]);
            placementCard.append(assetCard);
          }
        }

        card.append(placementCard);
      }
    }

    candidateConfigurations.append(card);
  }
}

function ensureOperationDocumentStyles(identity: OperationIdentity): void {
  const id = 'operation-document-styles';
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.append(style);
  }
  style.textContent = operationDocumentStyles(identity);
}

function operationAssetBytes(): Map<string, Uint8Array> {
  return new Map(returnedAssets.map((asset) => [asset.path, asset.bytes]));
}

function operationReferenceInputs(candidate: ResultCandidate): {
  referenceViews: Record<string, readonly ReferenceViewInput[]>;
  referenceWarnings: Record<string, string>;
} {
  const assets = operationAssetBytes();
  const manifestBytes = assets.get('presentation/preview.json');
  const selections = selectOperationReferenceViews(
    candidate.configurations,
    manifestBytes,
    manifestBytes !== undefined,
    { getBytes: (path) => assets.get(path) },
  );
  const referenceViews: Record<string, readonly ReferenceViewInput[]> = Object.create(null);
  const referenceWarnings: Record<string, string> = Object.create(null);
  for (const [id, selection] of Object.entries(selections)) {
    referenceViews[id] = selection.views;
    if (selection.warning !== null) referenceWarnings[id] = selection.warning;
  }
  return { referenceViews, referenceWarnings };
}

function renderOperationDocumentPreview(candidate: ResultCandidate): void {
  operationDocumentContainer.hidden = false;
  operationDocumentContainer.replaceChildren();
  const customerConfirmation = imported && imported.confirmation
    ? imported.confirmation.revision === imported.revision && imported.confirmation.digest === currentDigest
      ? `Current for revision ${imported.confirmation.revision}; confirmed by ${imported.confirmation.confirmedBy} at ${imported.confirmation.confirmedAt} (unverified identity).`
      : `Stale confirmation for revision ${imported.confirmation.revision}; not trusted.`
    : 'No current customer confirmation.';
  const internalReview = imported && imported.review
    ? `${hasCurrentInternalReview() ? "Current" : "Stale"}: ${imported.review.decision} for revision ${imported.review.revision}, by ${imported.review.reviewer} at ${imported.review.at} (self-entered; workflow data only).${imported.review.note === undefined ? "" : `\nReview note: ${imported.review.note}`}`
    : 'No current internal review. Returned review fields were discarded.';
  const doc = buildOperationDocument({
    candidate,
    customerConfirmation,
    internalReview,
    assetBytes: operationAssetBytes(),
    ...operationReferenceInputs(candidate),
  });
  ensureOperationDocumentStyles(doc.identity);
  operationDocumentContainer.append(renderOperationDocument(doc, document, { getBytes: (path) => operationAssetBytes().get(path) }));
}

async function downloadCandidateJson(snapshot: ProjectDocument): Promise<void> {
  const generation = operationGeneration;
  if (busy || imported !== snapshot) return;
  setBusy(true);
  try {
    await hasher.prepareProject(snapshot);
    if (generation !== operationGeneration || imported !== snapshot) {
      return;
    }
    const candidate = buildCandidateExport(snapshot, hasher.sha256Hex);
    const serialized = serializeExport(candidate);
    const blob = new Blob([serialized], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFilePart(snapshot.projectId)}-candidate-r${snapshot.revision}.json`;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1500);
    setStatus(`Saved ${anchor.download} to your downloads.`);
  } catch (error) {
    if (generation === operationGeneration && imported === snapshot) {
      setStatus(`Export data download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (generation === operationGeneration) setBusy(false);
  }
}

function renderEditorChoices(): void {
  if (!imported) return;
  const priorConfig = configInput.value;
  configInput.replaceChildren();
  for (const configuration of imported.configurations) {
    appendOption(configInput, configuration.id, `${configuration.id} — ${configuration.productId} / ${configuration.variantId}`);
  }
  if (imported.configurations.some((configuration) => configuration.id === priorConfig)) configInput.value = priorConfig;
  const config = imported.configurations.find((configuration) => configuration.id === configInput.value) ?? imported.configurations[0];
  const priorPlacement = placementInput.value;
  placementInput.replaceChildren();
  if (!config || config.placements.length === 0) {
    appendOption(placementInput, '', 'No placements in this configuration');
    placementInput.disabled = true;
  } else {
    config.placements.forEach((placement, index) => appendOption(
      placementInput,
      String(index),
      `${index + 1}: ${placement.logoId} / ${placement.regionId} — ${placement.widthMm} × ${placement.heightMm} mm`,
    ));
    if (Number(priorPlacement) < config.placements.length && priorPlacement !== '') placementInput.value = priorPlacement;
  }
  const placement = selectedPlacement();
  if (placement) {
    xInput.value = String(placement.pos.xMm);
    yInput.value = String(placement.pos.yMm);
    widthInput.value = String(placement.widthMm);
    heightInput.value = String(placement.heightMm);
    rotationInput.value = String(placement.rotationDeg);
  } else {
    xInput.value = '';
    yInput.value = '';
    widthInput.value = '';
    heightInput.value = '';
    rotationInput.value = '';
  }
  instructionsInput.value = imported.instructions ?? '';
}

function selectedConfig(): Configuration | null {
  return imported?.configurations.find((configuration) => configuration.id === configInput.value) ?? null;
}

function selectedPlacement(): Placement | null {
  const configuration = selectedConfig();
  const index = Number(placementInput.value);
  return configuration && Number.isInteger(index) && index >= 0 ? configuration.placements[index] ?? null : null;
}

async function validatePair(
  generation: number,
  issued: LoadedArchive,
  candidate: LoadedArchive,
): Promise<{ project: ProjectDocument; digest: string; fit: boolean } | { error: string } | null> {
  const assetErrors = compareAssetBytes(issued.assets, candidate.assets);
  if (assetErrors.length > 0) {
    return { error: `asset comparison differs from the issued baseline: ${assetErrors.join('; ')}` };
  }
  await hasher.prepareProject(issued.project);
  const digest = await hasher.prepareProject(candidate.project);
  if (generation !== operationGeneration) return null;
  const outcome = importCustomerReturn(candidate.project, issued.project, hasher.sha256Hex);
  if (!outcome.ok) {
    return { error: outcome.errors.map((error) => `${error.code}: ${error.message}`).join('; ') };
  }
  return { project: outcome.project, digest, fit: evaluateProjectGeometry(outcome.project).ok };
}

async function loadArchive(role: 'baseline' | 'return', file: File): Promise<void> {
  const generation = ++operationGeneration;
  setBusy(true);
  setStatus(`Reading ${role === 'baseline' ? 'saved copy' : 'returned file'}…`);
  try {
    if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
      throw new Error(`archive size ${file.size} exceeds ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes} bytes; rejected before reading`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = await parseProjectPackage(bytes, { sha256: hasher.sha256Bytes });
    if (generation !== operationGeneration) return;
    assertProjectEditorLimits(parsed.project);
    const loaded: LoadedArchive = { name: file.name, project: parsed.project, assets: parsed.assets };
    const nextBaseline = role === 'baseline' ? loaded : baseline;
    const nextReturned = role === 'return' ? loaded : returned;
    if (nextBaseline && nextReturned) {
      const result = await validatePair(generation, nextBaseline, nextReturned);
      if (generation !== operationGeneration || result === null) return;
      if ('error' in result) {
        setStatus(`Candidate ${role} rejected: ${result.error}. The last valid project pair and review remain unchanged.`);
        return;
      }
      baseline = nextBaseline;
      returned = nextReturned;
      baselineName.textContent = `Selected local baseline: ${baseline.name}`;
      returnName.textContent = `Selected return: ${returned.name}`;
      imported = result.project;
      returnedAssets = nextReturned.assets;
      currentDigest = result.digest;
      currentFit = result.fit;
      renderProject();
      setStatus(result.fit
        ? 'Return checked against the saved copy. Review is still pending; opening the file did not approve it.'
        : 'File contents match, but some sizes or positions fall outside their safe areas. Approval is blocked until every logo fits.');
      return;
    }
    baseline = nextBaseline;
    returned = nextReturned;
    if (baseline) baselineName.textContent = `Selected local baseline: ${baseline.name}`;
    if (returned) returnName.textContent = `Selected return: ${returned.name}`;
    imported = null;
    returnedAssets = [];
    renderProject();
    setStatus(`Opened the ${role === 'baseline' ? 'saved copy' : 'returned file'}. Open the other file to run the comparison.`);
  } catch (error) {
    if (generation === operationGeneration) {
      setStatus(`Could not open the ${role === 'baseline' ? 'saved copy' : 'returned file'}: ${error instanceof Error ? error.message : String(error)}. The last valid selection is unchanged.`);
    }
  } finally {
    if (generation === operationGeneration) setBusy(false);
  }
}


function onFileChange(role: 'baseline' | 'return', input: HTMLInputElement): void {
  const file = input.files?.[0];
  if (file) void loadArchive(role, file);
  input.value = '';
}

async function recordReview(): Promise<void> {
  if (!imported || busy) return;
  const snapshot = imported;
  const generation = operationGeneration;
  const reviewer = reviewerInput.value.trim();
  const decision = decisionInput.value as ReviewDecision;
  const note = noteInput.value;
  if (!reviewer) {
    setStatus('Type your reviewer name before recording a decision.');
    return;
  }
  if (decision === 'approved' && (!currentFit || !hasCurrentConfirmation())) {
    setStatus('Approval is blocked: the customer confirmation must match this exact update, and every logo must fit its safe area.');
    return;
  }
  setBusy(true);
  try {
    const digest = await hasher.prepareProject(snapshot);
    if (generation !== operationGeneration || imported !== snapshot) return;
    const fit = evaluateProjectGeometry(snapshot).ok;
    if (digest !== currentDigest || !validateProject(snapshot).ok || (decision === 'approved' && !fit)) {
      setStatus('Review blocked: the project changed while you were reviewing. Check the latest values and try again.');
      return;
    }
    const outcome = recordInternalReview(snapshot, {
      decision,
      reviewer,
      digestOf: digest,
      ...(note !== '' ? { note } : {}),
    }, hasher.sha256Hex);
    if (!outcome.ok) {
      setStatus(`Review was not recorded: ${outcome.errors.map((error) => error.message).join('; ')}`);
      return;
    }
    imported = outcome.project;
    currentDigest = digest;
    renderProject();
    setStatus(decision === 'changesRequested' && !fit
      ? `Recorded changesRequested for update ${imported.revision}. Some sizes or positions still fall outside their safe areas; approval stays blocked.`
      : `Recorded ${decision} for update ${imported.revision}. This is internal workflow bookkeeping, not a production release.`);
  } catch (error) {
    setStatus(`Review failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (generation === operationGeneration) setBusy(false);
  }
}

function packageAssets(assets: readonly ProjectPackageAsset[]): {
  referenced: ProjectPackageAssetInput[];
  additional: ProjectPackageAssetInput[];
} {
  const referenced: ProjectPackageAssetInput[] = [];
  const additional: ProjectPackageAssetInput[] = [];
  for (const asset of assets) {
    const input = { path: asset.path, bytes: asset.bytes };
    (asset.kind === 'referenced' ? referenced : additional).push(input);
  }
  return { referenced, additional };
}

async function downloadProject(snapshot: ProjectDocument, filename: string): Promise<void> {
  const generation = operationGeneration;
  const assetsSnapshot = returnedAssets;
  if (busy) return;
  setBusy(true);
  try {
    const assets = packageAssets(assetsSnapshot);
    const bytes = await createProjectPackage({
      project: snapshot,
      assets: assets.referenced,
      additionalAssets: assets.additional,
    }, { sha256: hasher.sha256Bytes });
    if (generation !== operationGeneration || imported !== snapshot) {
      setStatus('Save discarded because the reviewed project changed while its archive was being prepared.');
      return;
    }
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'application/zip' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1500);
    setStatus(`Saved ${filename} to your downloads. The original artwork bytes are unchanged.`);
  } catch (error) {
    setStatus(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (generation === operationGeneration) setBusy(false);
  }
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

async function saveReviewed(): Promise<void> {
  if (!imported || busy) return;
  const snapshot = imported;
  await downloadProject(snapshot, `${safeFilePart(snapshot.projectId)}-reviewed-r${snapshot.revision}.logo-project`);
}

function readNumber(input: HTMLInputElement): number {
  const value = Number(input.value);
  if (!input.value.trim() || !Number.isFinite(value)) throw new Error(`${input.getAttribute('aria-label') ?? 'A measurement'} must be a finite number.`);
  return value;
}

async function saveProposal(): Promise<void> {
  if (!imported || busy) return;
  const project = imported;
  const generation = operationGeneration;
  const configurationId = configInput.value;
  const placementIndex = Number(placementInput.value);
  const configuration = project.configurations.find((item) => item.id === configurationId);
  const priorPlacement = configuration && Number.isInteger(placementIndex) ? configuration.placements[placementIndex] : undefined;
  if (!configuration) {
    setStatus('Choose a configuration before preparing a revised suggestion.');
    return;
  }
  try {
    const xMm = priorPlacement ? readNumber(xInput) : undefined;
    const yMm = priorPlacement ? readNumber(yInput) : undefined;
    const widthMm = priorPlacement ? readNumber(widthInput) : undefined;
    const heightMm = priorPlacement ? readNumber(heightInput) : undefined;
    const rotationDeg = priorPlacement ? readNumber(rotationInput) : undefined;
    const nextInstructions = instructionsInput.value;
    const placementChanged = priorPlacement !== undefined && (
      priorPlacement.pos.xMm !== xMm || priorPlacement.pos.yMm !== yMm ||
      priorPlacement.widthMm !== widthMm || priorPlacement.heightMm !== heightMm ||
      priorPlacement.rotationDeg !== rotationDeg
    );
    const instructionsChanged = project.instructions !== (nextInstructions === '' ? undefined : nextInstructions);
    if (!placementChanged && !instructionsChanged) {
      setStatus('Nothing to suggest: no numbers or instructions changed, so the update number and approvals stay as they are.');
      return;
    }
    const next = newRevision(project, (draft) => {
      const draftConfiguration = draft.configurations.find((item) => item.id === configurationId);
      if (!draftConfiguration) throw new Error('Selected configuration disappeared.');
      if (placementChanged) {
        const current = draftConfiguration.placements[placementIndex];
        if (!current || xMm === undefined || yMm === undefined || widthMm === undefined || heightMm === undefined || rotationDeg === undefined) {
          throw new Error('Selected placement disappeared or has incomplete measurements.');
        }
        draftConfiguration.placements[placementIndex] = {
          ...current,
          pos: { xMm, yMm },
          widthMm,
          heightMm,
          rotationDeg,
        };
      }
      if (nextInstructions === '') delete draft.instructions;
      else draft.instructions = nextInstructions;
    });
    const fit = evaluateProjectGeometry(next);
    if (!fit.ok) {
      const failures = fit.placements.filter((item) => !item.ok)
        .map((item) => `${item.configurationId}/${item.placementId ?? `Placement ${item.placementIndex + 1}`}: ${item.reason}`).join('; ');
      setStatus(`Revised suggestion rejected: ${failures}. Every logo must fit its safe area and avoid exclusion zones. Adjust the numbers and try again.`);
      return;
    }
    setBusy(true);
    const digest = await hasher.prepareProject(next);
    if (generation !== operationGeneration || imported !== project) {
      if (generation === operationGeneration) setBusy(false);
      return;
    }
    imported = next;
    currentDigest = digest;
    currentFit = true;
    setBusy(false);
    renderProject();
    const filename = `${safeFilePart(next.projectId)}-customer-proposal-r${next.revision}.logo-project`;
    await downloadProject(next, filename);
  } catch (error) {
    if (generation === operationGeneration) {
      setBusy(false);
      setStatus(`Revised proposal was not created: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

baselineInput.addEventListener('change', () => onFileChange('baseline', baselineInput));
returnInput.addEventListener('change', () => onFileChange('return', returnInput));
reviewerInput.addEventListener('input', updateControls);
decisionInput.addEventListener('change', updateControls);
recordButton.addEventListener('click', () => void recordReview());
saveReviewedButton.addEventListener('click', () => void saveReviewed());
saveProposalButton.addEventListener('click', () => void saveProposal());
candidateDownload.addEventListener('click', () => { if (imported) void downloadCandidateJson(imported); });
operationDocumentPrint.addEventListener('click', () => {
  if (!imported || busy) return;
  globalThis.print();
});
configInput.addEventListener('change', () => { renderEditorChoices(); updateControls(); });
placementInput.addEventListener('change', () => { renderEditorChoices(); updateControls(); });
updateControls();
