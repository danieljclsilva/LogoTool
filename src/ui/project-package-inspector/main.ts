import {
  PROJECT_PACKAGE_LIMITS,
  createProjectPackage,
  parseProjectPackage,
} from '../../packaging/project-package/index.js';
import type {
  ProjectPackageAsset,
  ProjectPackageSha256,
} from '../../packaging/project-package/index.js';
import type { ProjectDocument } from '../../core/types.js';

interface LoadedPackage {
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
  fileName: string;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing project package inspector element: ${selector}`);
  return element;
}

const root = required<HTMLElement>('#project-package-inspector');
const fileInput = required<HTMLInputElement>('[data-package-hook="file-input"]');
const chooseButton = required<HTMLButtonElement>('[data-package-hook="choose"]');
const saveButton = required<HTMLButtonElement>('[data-package-hook="save"]');
const dropzone = required<HTMLElement>('[data-package-hook="dropzone"]');
const status = required<HTMLElement>('[data-package-hook="status"]');
const sourceName = required<HTMLElement>('[data-package-hook="source-name"]');
const projectId = required<HTMLElement>('[data-package-hook="project-id"]');
const projectRevision = required<HTMLElement>('[data-package-hook="project-revision"]');
const confirmationSummary = required<HTMLElement>('[data-package-hook="confirmation"]');
const reviewSummary = required<HTMLElement>('[data-package-hook="review"]');
const placementTable = required<HTMLTableElement>('[data-package-hook="placement-table"]');
const placementRows = required<HTMLTableSectionElement>('[data-package-hook="placement-rows"]');
const placementEmpty = required<HTMLElement>('[data-package-hook="placement-empty"]');
const assetTable = required<HTMLTableElement>('[data-package-hook="asset-table"]');
const assetRows = required<HTMLTableSectionElement>('[data-package-hook="asset-rows"]');
const assetsEmpty = required<HTMLElement>('[data-package-hook="assets-empty"]');

let loaded: LoadedPackage | null = null;
let readGeneration = 0;
let saving = false;

const sha256: ProjectPackageSha256 = async (bytes) => {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This browser does not provide Web Crypto SHA-256 for package verification.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

function setStatus(message: string): void {
  status.textContent = message;
}


function addCell(row: HTMLTableRowElement, value: string): void {
  const cell = document.createElement('td');
  cell.textContent = value;
  row.append(cell);
}

function named(id: string, name: string | undefined): string {
  return name ? `${name} (${id})` : id;
}

function render(projectPackage: LoadedPackage): void {
  const { project, assets } = projectPackage;
  sourceName.textContent = projectPackage.fileName;
  projectId.textContent = project.projectId;
  projectRevision.textContent = String(project.revision);

  const confirmation = project.confirmation;
  confirmationSummary.textContent = confirmation
    ? `Present for revision ${confirmation.revision}, by ${confirmation.confirmedBy} at ${confirmation.confirmedAt}. Imported, untrusted metadata only — not evidence of approval.`
    : 'None recorded; this project has no customer confirmation.';

  const importedReview = project.review
    ? ` Imported review record (untrusted metadata): “${project.review.decision}” by ${project.review.reviewer} at ${project.review.at}; it is not a local approval.`
    : ' No imported review record is present.';
  reviewSummary.textContent = `Pending internal review. Opening or importing a package never grants approval.${importedReview}`;

  const productById = new Map(project.products.map((product) => [product.id, product] as const));
  const logoById = new Map(project.logos.map((logo) => [logo.id, logo] as const));
  let placementCount = 0;
  placementRows.replaceChildren();
  for (const configuration of project.configurations) {
    const product = productById.get(configuration.productId);
    const variant = product?.variants.find((candidate) => candidate.id === configuration.variantId);
    if (configuration.placements.length === 0) {
      const row = document.createElement('tr');
      row.dataset.packageHook = 'zero-placement-configuration';
      const note = document.createElement('td');
      note.colSpan = placementTable.tHead?.rows[0]?.cells.length ?? 10;
      note.textContent = `${configuration.id} — ${named(configuration.productId, product?.name)} / ${named(configuration.variantId, variant?.name)}: no placements defined.`;
      row.append(note);
      placementRows.append(row);
      continue;
    }

    for (const placement of configuration.placements) {
      placementCount += 1;
      const region = product?.regions.find((candidate) => candidate.id === placement.regionId);
      const logo = logoById.get(placement.logoId);
      const row = document.createElement('tr');
      addCell(row, configuration.id);
      addCell(row, `${named(configuration.productId, product?.name)} / ${named(configuration.variantId, variant?.name)}`);
      addCell(row, named(placement.logoId, logo?.name));
      addCell(row, named(placement.regionId, region?.name));
      addCell(row, placement.method);
      addCell(row, `${placement.pos.xMm} mm`);
      addCell(row, `${placement.pos.yMm} mm`);
      addCell(row, `${placement.widthMm} mm`);
      addCell(row, `${placement.heightMm} mm`);
      addCell(row, `${placement.rotationDeg}°`);
      placementRows.append(row);
    }
  }
  placementTable.hidden = project.configurations.length === 0;
  placementEmpty.hidden = placementCount !== 0;
  placementEmpty.textContent = placementCount === 0
    ? 'No placements are defined in this project.'
    : '';

  const referencesByPath = new Map<string, string[]>();
  for (const logo of project.logos) {
    for (const asset of logo.assets) {
      const references = referencesByPath.get(asset.uri) ?? [];
      references.push(`${named(logo.id, logo.name)} — ${asset.role}; ${asset.mediaType}`);
      referencesByPath.set(asset.uri, references);
    }
  }
  assetRows.replaceChildren();
  for (const asset of assets) {
    const row = document.createElement('tr');
    addCell(row, asset.path);
    addCell(row, asset.kind);
    addCell(row, referencesByPath.get(asset.path)?.join('; ') ?? 'Additional package asset; no domain mapping');
    addCell(row, String(asset.bytes.byteLength));
    assetRows.append(row);
  }
  assetTable.hidden = assets.length === 0;
  assetsEmpty.hidden = assets.length !== 0;
  assetsEmpty.textContent = assets.length === 0 ? 'This project package contains no assets.' : '';
  saveButton.disabled = saving;
}

function updateSaveButton(): void {
  saveButton.disabled = loaded === null || saving;
}

async function loadFiles(files: readonly File[]): Promise<void> {
  const generation = ++readGeneration;
  if (files.length !== 1) {
    setStatus('Choose or drop exactly one .logo-project file. The currently loaded project is unchanged.');
    return;
  }

  const file = files[0];
  if (!file) return;
  if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    setStatus(`Archive size (${file.size} bytes) exceeds the ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes}-byte limit. The previously loaded project is unchanged.`);
    return;
  }
  setStatus(`Reading ${file.name}… The current project remains visible until validation succeeds.`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = await parseProjectPackage(bytes, { sha256 });
    if (generation !== readGeneration) return;
    const candidate: LoadedPackage = {
      project: parsed.project,
      assets: parsed.assets,
      fileName: file.name,
    };
    loaded = candidate;
    render(candidate);
    updateSaveButton();
    setStatus(`Loaded ${file.name} and verified its project metadata and asset digests.`);
  } catch (error) {
    if (generation !== readGeneration) return;
    const detail = error instanceof Error ? error.message : String(error);
    setStatus(`Could not load ${file.name}. The previously loaded project is unchanged. ${detail}`);
  }
}

async function savePackage(): Promise<void> {
  const snapshot = loaded;
  if (!snapshot || saving) return;
  saving = true;
  updateSaveButton();
  setStatus(`Preparing a validated .logo-project download for ${snapshot.fileName}…`);
  try {
    const referencedAssets = snapshot.assets
      .filter((asset) => asset.kind === 'referenced')
      .map(({ path, bytes }) => ({ path, bytes }));
    const additionalAssets = snapshot.assets
      .filter((asset) => asset.kind === 'additional')
      .map(({ path, bytes }) => ({ path, bytes }));
    const bytes = await createProjectPackage({
      project: snapshot.project,
      assets: referencedAssets,
      additionalAssets,
    }, { sha256 });
    const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
    const objectUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = objectUrl;
    downloadLink.download = 'project-package.logo-project';
    downloadLink.style.display = 'none';
    root.append(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    if (loaded === snapshot) setStatus('Downloaded the validated project in the same .logo-project package format.');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    setStatus(`Could not create the project package download. ${detail}`);
  } finally {
    saving = false;
    updateSaveButton();
  }
}

chooseButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  fileInput.value = '';
  if (files.length > 0) void loadFiles(files);
});
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('is-dragging');
});
dropzone.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget || !dropzone.contains(event.relatedTarget as Node)) {
    dropzone.classList.remove('is-dragging');
  }
});
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('is-dragging');
  const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
  if (files.length > 0) void loadFiles(files);
});

saveButton.addEventListener('click', () => void savePackage());
updateSaveButton();
