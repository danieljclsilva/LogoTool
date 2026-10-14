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

interface EditorPackage {
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
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
const confirmedByInput = hook<HTMLInputElement>('confirmed-by');
const confirmButton = hook<HTMLButtonElement>('confirm');
const confirmationSummary = hook<HTMLElement>('confirmation');
const hasher = createWebCryptoProjectHasher();

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
  return name ? `${name} (${id})` : id;
}

function invalidateUiContext(): void {
  cancelDrag('Drag cancelled because the editing context changed.');
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
}
function isGeometryValid(project: ProjectDocument): boolean {
  try {
    return geometryFor(project).ok;
  } catch {
    return false;
  }
}

function setGeometry(message: string, valid: boolean): void {
  geometryStatus.textContent = message;
  geometryStatus.classList.toggle('invalid', !valid);
}

function updateConfirmationState(): void {
  const project = loaded?.project;
  const confirmation = project?.confirmation;
  if (!project) {
    confirmationFresh = false;
    confirmationSummary.textContent = 'No project loaded.';
    return;
  }
  if (!confirmation) {
    confirmationFresh = false;
    const prior = project.history?.[project.history.length - 1];
    confirmationSummary.textContent = prior
      ? `No current customer confirmation. Previous confirmation from revision ${prior.revision} is stale; confirm the current revision before submit.`
      : 'No current customer confirmation. Confirm the reviewed revision before submit.';
    return;
  }
  if (!confirmationFresh) {
    confirmationSummary.textContent = `Checking confirmation for revision ${confirmation.revision}; imported confirmation is untrusted until its digest is checked.`;
    return;
  }
  if (confirmation.revision !== project.revision) {
    confirmationFresh = false;
    confirmationSummary.textContent = `Stale confirmation from revision ${confirmation.revision}; current revision is ${project.revision}. Re-review and confirm again.`;
    return;
  }
  confirmationSummary.textContent = `Current confirmation for revision ${confirmation.revision}, by ${confirmation.confirmedBy} at ${confirmation.confirmedAt}. Customer-supplied evidence only; not internal approval.`;
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

  replaceOptions(configurationSelect, project.configurations.map((item) => ({ value: item.id, label: item.id })), configuration.id);
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
}

function placementLabel(configuration: ProjectDocument['configurations'][number], index: number): string {
  return configuration.placements[index]?.id ?? `Placement ${index + 1}`;
}
function readNumeric(input: HTMLInputElement, label: string): number {
  const value = Number(input.value);
  if (input.value.trim() === '' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function populatePlacementForm(): void {
  const placement = currentPlacement();
  if (!placement) {
    xInput.value = '';
    yInput.value = '';
    widthInput.value = '';
    heightInput.value = '';
    rotationInput.value = '';
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
}


function renderCanvas(): void {
  const project = loaded?.project;
  const configuration = project && selectedConfiguration(project);
  const region = regionForSelection();
  canvasLayer.replaceChildren();
  if (!project || !configuration || !region) {
    canvas.setAttribute('viewBox', '-120 -100 240 200');
    frameSummary.textContent = 'No region selected.';
    setGeometry('Load a project to evaluate the placement footprint.', true);
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
    polygon.setAttribute('aria-label', `Inert footprint for ${logo?.name ?? item.logoId}; ${item.widthMm} by ${item.heightMm} millimetres`);
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
    setGeometry(`${configuration.placements.length} placement(s) in this configuration. Select a region and logo to add a footprint.`, true);
  } else {
    const verdict = selectedPlacementGeometry(project, configuration.id, selectedPlacementIndex!);
    setGeometry(verdict?.ok ? `Fit: yes — ${verdict.reason}` : `Fit: no — ${verdict?.reason ?? 'footprint unavailable'}`, verdict?.ok === true);
  }
}

function renderReview(): void {
  const project = loaded?.project;
  if (!project) {
    exactReview.textContent = 'Load a project to review its physical placement values.';
    return;
  }
  const rows = [`Project: ${project.projectId}`, `Revision: ${project.revision}`, 'Coordinate units: mm'];
  for (const configuration of project.configurations) {
    const product = productForConfiguration(project, configuration);
    const variant = product?.variants.find((item) => item.id === configuration.variantId);
    rows.push('', `Configuration: ${configuration.id}`, `Product / variant: ${displayName(configuration.productId, product?.name)} / ${displayName(configuration.variantId, variant?.name)}`);
    const regionIds = variant?.regionIds ?? [];
    for (const regionId of regionIds) {
      const region = product?.regions.find((item) => item.id === regionId);
      if (region) rows.push(
        `Region frame: ${displayName(region.id, region.name)}`,
        `Frame: ${region.frame.frameId}; origin ${region.frame.originDescription}`,
        `Axes: +x ${region.frame.axes.xPositive}; +y ${region.frame.axes.yPositive}`,
        `Calibration: ${region.calibrationRef.calibrationId} ${region.calibrationRef.version}`,
      );
    }
    if (configuration.placements.length === 0) rows.push('Placements: 0');
    for (const [index, placement] of configuration.placements.entries()) {
      const region = product?.regions.find((item) => item.id === placement.regionId);
      const fit = selectedPlacementGeometry(project, configuration.id, index);
      rows.push(
        `Placement ${placementLabel(configuration, index)}: logo ${placement.logoId}; region ${displayName(placement.regionId, region?.name)}; method ${placement.method}`,
        `Frame: ${region?.frame.frameId ?? 'unknown'}; origin ${region?.frame.originDescription ?? 'unknown'}`,
        `Axes: +x ${region?.frame.axes.xPositive ?? 'unknown'}; +y ${region?.frame.axes.yPositive ?? 'unknown'}`,
        `Calibration: ${region?.calibrationRef.calibrationId ?? 'unknown'} ${region?.calibrationRef.version ?? ''}`,
        `Center: ${placement.pos.xMm} mm, ${placement.pos.yMm} mm (bounding-box center, offsets along +x and +y from the frame origin)`,
        `Width × height: ${placement.widthMm} mm × ${placement.heightMm} mm`,
        `Clockwise rotation: ${placement.rotationDeg}°`,
        `Footprint fit: ${fit?.ok ? 'yes' : 'no'}${fit ? ` — ${fit.reason}` : ''}`,
        `Placement instructions: ${placement.instructions ?? '(none)'}`,
      );
    }
  }
  rows.push('', `Project instructions: ${project.instructions ?? '(none)'}`);
  exactReview.textContent = rows.join('\n');
}

function renderAll(): void {
  const project = loaded?.project;
  if (!project) {
    projectId.textContent = 'Not loaded';
    revisionLabel.textContent = '—';
    assetCount.textContent = '—';
    projectInstructions.value = '';
    updateConfirmationState();
    renderSelectorOptions();
    populatePlacementForm();
    renderCanvas();
    renderReview();
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
  renderCanvas();
  renderReview();
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
    setStatus('No changes to save; the project revision is unchanged.');
    return;
  }
  try {
    assertProjectEditorLimits(next);
    geometryFor(next);
  } catch (error) {
    setStatus(`Edit rejected before installation: ${error instanceof Error ? error.message : String(error)}`);
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
  if (!region || !logoId) throw new Error('Choose a product, variant, region, and logo before editing a placement.');
  const rotationDeg = readNumeric(rotationInput, 'Rotation');
  if (!(rotationDeg > -180 && rotationDeg <= 180)) throw new Error('Clockwise rotation must be greater than −180° and at most 180°.');
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
    setStatus('Choose an existing placement or add the edited measurements as a new placement before applying.');
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
      setStatus('No placement or instruction changes; the project revision is unchanged.');
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
    installMutation(next, `Applied committed placement and instruction edits as revision ${next.revision}.`);
  } catch (error) {
    setStatus(`Could not apply pending edits: ${error instanceof Error ? error.message : String(error)}`);
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
      confirmationSummary.textContent = `Stale confirmation for revision ${confirmation.revision}; its digest does not match current revision ${snapshot.revision}. Review and confirm again.`;
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

async function loadFiles(files: readonly File[]): Promise<void> {
  const generation = ++loadGeneration;
  stateGeneration += 1;
  cancelDrag('Drag cancelled because a project load started.');
  if (files.length !== 1) {
    loading = false;
    updateButtons();
    setStatus('Choose or drop exactly one .logo-project file. The currently loaded project is unchanged.');
    refreshCurrentConfirmation();
    return;
  }
  const file = files[0];
  if (!file) return;
  if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    loading = false;
    updateButtons();
    setStatus(`Archive size (${file.size} bytes) exceeds the ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes}-byte limit. The currently loaded project is unchanged.`);
    refreshCurrentConfirmation();
    return;
  }
  loading = true;
  updateButtons();
  setStatus(`Reading ${file.name}… The current project remains visible until package validation succeeds.`);
  const loadToken = stateGeneration;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = await parseProjectPackage(bytes, { sha256: hasher.sha256Bytes });
    if (generation !== loadGeneration || loadToken !== stateGeneration) return;
    assertProjectEditorLimits(parsed.project);
    geometryFor(parsed.project);
    const candidate: EditorPackage = { project: parsed.project, assets: parsed.assets };
    loaded = candidate;
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
    renderAll();
    setStatus(`Loaded ${file.name}. Project metadata and all asset bytes passed package validation.`);
    const snapshot = currentSnapshot();
    if (snapshot) void checkImportedConfirmation(snapshot);
  } catch (error) {
    if (generation !== loadGeneration || loadToken !== stateGeneration) return;
    loading = false;
    updateButtons();
    const detail = error instanceof Error ? error.message : String(error);
    setStatus(`Could not load ${file.name}. The previously loaded project remains unchanged. ${detail}`);
    refreshCurrentConfirmation();
  }
}

async function savePackage(submit = false): Promise<void> {
  const snapshot = currentSnapshot();
  const projectPackage = loaded;
  if (!snapshot || !projectPackage || loading || saving || confirming) return;
  if (submit && drag) {
    setStatus('Submission is blocked until the active drag is committed or cancelled. A draft save still uses only committed project values.');
    return;
  }
  if (placementFormDirty || projectInstructionsDirty) {
    setStatus('Commit or discard the uncommitted form edits before saving a package.');
    return;
  }
  if (submit && (!confirmationFresh || !projectPackage.project.confirmation || !isGeometryValid(snapshot.project))) {
    setStatus('Submit is blocked: this revision needs a fresh confirmation and every placement footprint must fit.');
    return;
  }
  if (!validateProject(snapshot.project).ok) {
    setStatus('This project is not structurally valid and cannot be packaged.');
    return;
  }
  saving = true;
  updateButtons();
  setStatus(submit ? 'Preparing the locally saved, confirmed customer-return package…' : 'Preparing a validated draft package download…');
  try {
    const references = projectPackage.assets.filter((asset) => asset.kind === 'referenced').map(({ path, bytes }) => ({ path, bytes }));
    const additional = projectPackage.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes }));
    const bytes = await createProjectPackage({ project: snapshot.project, assets: references, additionalAssets: additional }, { sha256: hasher.sha256Bytes });
    if (!snapshotIsCurrent(snapshot) || loaded !== projectPackage) {
      setStatus('Package download cancelled because the project changed while it was being prepared.');
      return;
    }
    if (submit && (!confirmationFresh || !snapshot.project.confirmation || !isGeometryValid(snapshot.project))) {
      setStatus('Submit cancelled because the fresh confirmation or valid-fit gate is no longer satisfied.');
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
    setStatus(submit ? 'Saved the confirmed customer-return package locally. Nothing was uploaded or published.' : 'Saved the editable draft package locally. Nothing was uploaded or published.');
  } catch (error) {
    if (snapshotIsCurrent(snapshot)) setStatus(`Could not create the project package. ${error instanceof Error ? error.message : String(error)}`);
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
    setStatus('Confirmation is blocked until the active drag is committed or cancelled.');
    return;
  }
  if (!snapshot || !projectPackage || !confirmedBy || loading || confirming || saving) return;
  if (placementFormDirty || projectInstructionsDirty) {
    setStatus('Save placement and project instruction edits as revisions before customer confirmation.');
    return;
  }
  if (!validateProject(snapshot.project).ok) {
    setStatus('This project is not structurally valid and cannot be confirmed.');
    return;
  }
  if (!isGeometryValid(snapshot.project)) {
    setStatus('This project cannot be confirmed until every measured footprint fits its safe area and exclusions. It can still be saved as a draft.');
    return;
  }
  confirming = true;
  confirmationFresh = false;
  updateButtons();
  updateConfirmationState();
  setStatus(`Preparing the exact revision ${snapshot.revision} content digest for review…`);
  try {
    const digest = await hasher.prepareProject(snapshot.project);
    if (!snapshotIsCurrent(snapshot) || loaded !== projectPackage || confirmedByInput.value.trim() !== confirmedBy) {
      setStatus('Confirmation cancelled because the project or review input changed while the digest was being prepared. Review and confirm again.');
      return;
    }
    const confirmCandidate = cloneProject(snapshot.project);
    const result = confirmRevision(confirmCandidate, { confirmedBy, digestOf: digest }, hasher.sha256Hex);
    if (!result.ok) {
      setStatus(`Could not confirm this revision: ${result.errors.map((entry) => entry.message).join('; ')}`);
      return;
    }
    loaded = { ...projectPackage, project: result.project };
    stateGeneration += 1;
    confirmationFresh = true;
    renderAll();
    setStatus(`Confirmed revision ${result.project.revision} for the exact reviewed content digest. This is not internal approval.`);
  } catch (error) {
    if (snapshotIsCurrent(snapshot)) setStatus(`Could not prepare customer confirmation: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    confirming = false;
    updateButtons();
  }
}

function contextChanged(): void {
  if (placementFormDirty || projectInstructionsDirty) setStatus('Uncommitted form edits were discarded because the editing context changed.');
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
  installMutation(next, `Created an empty ${productId} / ${variantId} configuration as revision ${next.revision}.`);
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
    setGeometry(`Drag preview exceeds the ±${PROJECT_EDITOR_LIMITS.maxCoordinateMm} mm runtime geometry bound; release will be rejected.`, false);
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
    setGeometry(`Drag preview — fit: ${verdict.ok ? 'yes' : 'no'}; ${verdict.reason}. Release commits the center as a new revision; cancel to discard.`, verdict.ok);
  } catch (error) {
    polygon.classList.add('invalid');
    setGeometry(`Drag preview rejected: ${error instanceof Error ? error.message : String(error)}`, false);
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
    if (!commit || !event.isPrimary || event.button !== 0) setStatus('Drag cancelled. The committed placement remains unchanged.');
    return;
  }
  const endpoint = canvasPoint(event, current.screenToRegion);
  if (!endpoint) {
    renderAll();
    setStatus('Drag cancelled because the pointer endpoint could not be mapped.');
    return;
  }
  const xMm = endpoint.x + current.grabOffsetX;
  const yMm = endpoint.y + current.grabOffsetY;
  if (Math.abs(xMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm || Math.abs(yMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm) {
    renderAll();
    setStatus(`Drag rejected beyond the ±${PROJECT_EDITOR_LIMITS.maxCoordinateMm} mm runtime geometry bound.`);
    return;
  }
  const configuration = current.project.configurations.find((item) => item.id === current.configurationId);
  const placement = configuration?.placements[current.placementIndex];
  if (!configuration || !placement) return;
  const selector = placementSelector(placement, current.placementIndex);
  try {
    const next = updatePlacement(current.project, current.configurationId, selector, { pos: { xMm, yMm } });
    installMutation(next, `Drag committed as revision ${next.revision}; position and footprint dimensions remain in millimetres.`);
  } catch (error) {
    renderAll();
    setStatus(`Could not commit drag: ${error instanceof Error ? error.message : String(error)}`);
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
  contextChanged();
  selectedRegionId = regionSelect.value;
  if (currentPlacement()?.regionId !== selectedRegionId) selectedPlacementIndex = null;
  renderAll();
});
logoSelect.addEventListener('change', () => {
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
      cancelDrag('Drag cancelled because a form field changed.');
      control.value = value;
    }
    if (control === projectInstructions) {
      projectInstructionsDirty = true;
      setStatus('Project instructions have pending edits; apply them with the placement fields before confirmation or package saving.');
    } else if (control !== confirmedByInput) {
      placementFormDirty = true;
      setStatus('Placement fields have pending edits; apply them with project instructions before confirmation or package saving.');
    }
    stateGeneration += 1;
    updateButtons();
    const snapshot = currentSnapshot();
    if (snapshot?.project.confirmation) void checkImportedConfirmation(snapshot);
  };
  control.addEventListener('input', markFormChanged);
  control.addEventListener('change', markFormChanged);
}

addButton.addEventListener('click', () => {
  if (!loaded) return;
  try {
    const configuration = selectedConfiguration();
    if (!configuration) throw new Error('Choose a configuration first.');
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
    installMutation(next, `Added editable placement as revision ${next.revision}. Geometric fit is evaluated separately.`);
  } catch (error) { setStatus(`Could not add placement: ${error instanceof Error ? error.message : String(error)}`); }
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
    installMutation(next, `Removed placement as revision ${next.revision}.`);
  } catch (error) { setStatus(`Could not remove placement: ${error instanceof Error ? error.message : String(error)}`); }
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
    installMutation(next, `Undo restored prior content as new revision ${next.revision}; prior confirmation was invalidated.`, false);
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
    setStatus('The project already matches the opened package; no reset revision was created.');
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
    installMutation(next, `Reset to the opened package content as new revision ${next.revision}; prior confirmation was invalidated.`);
  } catch (error) { setStatus(`Could not reset project: ${error instanceof Error ? error.message : String(error)}`); }
});
confirmButton.addEventListener('click', () => void confirmCurrentRevision());
saveButton.addEventListener('click', () => void savePackage(false));
submitButton.addEventListener('click', () => void savePackage(true));

canvas.addEventListener('pointermove', moveDrag);
canvas.addEventListener('pointerup', (event) => finishDrag(event, true));
canvas.addEventListener('pointercancel', (event) => finishDrag(event, false));
canvas.addEventListener('lostpointercapture', (event) => finishDrag(event as PointerEvent, false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drag) { event.preventDefault(); cancelDrag('Drag cancelled with Escape. The placement remains unchanged.'); }
});
window.addEventListener('blur', () => cancelDrag('Drag cancelled because the window lost focus.'));

renderAll();
updateButtons();
