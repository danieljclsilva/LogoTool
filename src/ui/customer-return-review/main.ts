import {
  canonicalize,
  importCustomerReturn,
  newRevision,
  recordInternalReview,
  validateProject,
} from '../../core/index.js';
import type { Configuration, Placement, ProjectDocument, ReviewDecision } from '../../core/index.js';
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
    ? `${imported.review.decision} for revision ${imported.review.revision}, by ${imported.review.reviewer} (self-entered; workflow data only).`
    : `No current internal review. Returned review fields were discarded. Preserved trusted-baseline review history: ${imported.reviewHistory?.length ?? 0}.`;
  renderDifferences(baseline.project, imported);
  renderEditorChoices();
  updateControls();
}

function appendOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.append(option);
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
  setStatus(`Reading ${role === 'baseline' ? 'issued baseline' : 'customer return'}…`);
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
        ? 'Return imported against the separately selected issued baseline. Review remains pending; importing did not approve it.'
        : 'Return definitions and assets match, but geometry is invalid. Internal review is blocked until every measured footprint fits.');
      return;
    }
    baseline = nextBaseline;
    returned = nextReturned;
    if (baseline) baselineName.textContent = `Selected local baseline: ${baseline.name}`;
    if (returned) returnName.textContent = `Selected return: ${returned.name}`;
    imported = null;
    returnedAssets = [];
    renderProject();
    setStatus(`Loaded ${role}. Select the other project file to compare the return.`);
  } catch (error) {
    if (generation === operationGeneration) {
      setStatus(`Could not load ${role}: ${error instanceof Error ? error.message : String(error)}. The last valid selection remains unchanged.`);
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
    setStatus('Enter a reviewer identity before recording a decision.');
    return;
  }
  if (decision === 'approved' && (!currentFit || !hasCurrentConfirmation())) {
    setStatus('Internal approval is blocked: the customer confirmation must match the current revision and digest, and every footprint must fit.');
    return;
  }
  setBusy(true);
  try {
    const digest = await hasher.prepareProject(snapshot);
    if (generation !== operationGeneration || imported !== snapshot) return;
    const fit = evaluateProjectGeometry(snapshot).ok;
    if (digest !== currentDigest || !validateProject(snapshot).ok || (decision === 'approved' && !fit)) {
      setStatus('Review blocked: the current digest, structural validation, or required approval geometry verdict changed.');
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
      ? `Recorded changesRequested for revision ${imported.revision}. Geometry remains invalid; internal approval is still blocked.`
      : `Recorded ${decision} for revision ${imported.revision}. This is internal workflow bookkeeping, not a production release.`);
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
    setStatus(`Saved ${filename}. Original project asset bytes were retained.`);
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
    setStatus('Choose a configuration before preparing a revised proposal.');
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
      setStatus('No proposal changes; revision and approvals remain unchanged.');
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
      setStatus(`Revised proposal rejected: ${failures}. Every full measured footprint must fit its safe region and avoid exclusions. Adjust the numeric proposal and try again.`);
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
configInput.addEventListener('change', () => { renderEditorChoices(); updateControls(); });
placementInput.addEventListener('change', () => { renderEditorChoices(); updateControls(); });
updateControls();
