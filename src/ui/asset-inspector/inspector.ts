/**
 * inspector.ts — asset-inspector controller for the internal GLB prototype.
 *
 * Framework-free (no React), no network, no CDN, no fetches: file intake
 * comes from `<input type=file>` / drag-and-drop, downloads leave via Blob
 * object URLs, and the model reaches the viewer as already-validated bytes.
 *
 * Asset metadata types come from the portable ingestion module.
 * Wiring: `AssetInspector.bind()` takes a root element containing the hooks
 * named in `INSPECTOR_HOOKS` (see `./template.html`) plus dependencies.
 * The Three.js viewer is injected as a factory — this module never imports
 * Three.js, not even as a type from anywhere but `../../viewer/model-viewer.js`
 * (type-only; erased at compile).
 */

import type { ModelViewer, ViewerStatus } from '../../viewer/model-viewer.js';

import { DEFAULT_MAX_BYTES } from '../../assets/index.js';
import type { AssetIssue, AssetSource, IngestAssetInput, AssetRecord, IngestAssetResult } from '../../assets/index.js';
export type IngestAssetFn = (input: IngestAssetInput) => IngestAssetResult | Promise<IngestAssetResult>;

/** Coded parse error thrown by ingest for malformed bytes. */
export interface CodedErrorShape {
  code: string;
  path?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Viewer port (type-only; the embedding page injects ModelViewer.attach).
// ---------------------------------------------------------------------------

export type ViewerFactory = (
  canvas: HTMLCanvasElement,
  onStatus: (status: ViewerStatus) => void,
) => { viewer: ModelViewer | null; status: ViewerStatus };

// ---------------------------------------------------------------------------
// Template hooks. Every name must exist once as
// `data-inspector-hook="<name>"` inside the bound root (see template.html).
// ---------------------------------------------------------------------------

export const INSPECTOR_HOOKS = {
  canvas: 'canvas',
  dropzone: 'dropzone',
  fileInput: 'file-input',
  sourceSelect: 'source-select',
  generatedBy: 'generated-by',
  fitButton: 'fit-button',
  resetButton: 'reset-button',
  wireframeButton: 'wireframe-button',
  downloadGlb: 'download-glb',
  downloadProvenance: 'download-provenance',
  status: 'status',
  issues: 'issues',
  provenance: 'provenance',
} as const;

export type InspectorHookName =
  (typeof INSPECTOR_HOOKS)[keyof typeof INSPECTOR_HOOKS];

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

export type InspectorState =
  | { kind: 'idle' }
  | { kind: 'reading'; filename: string }
  | { kind: 'ready'; filename: string; bytes: Uint8Array; record: AssetRecord }
  | {
      kind: 'blocked';
      filename: string;
      bytes: Uint8Array;
      record: AssetRecord;
      issues: AssetIssue[];
    }
  | {
      kind: 'failed';
      filename: string;
      code: string;
      path: string | null;
      message: string;
    };

export interface AssetInspectorOptions {
  /** Root element containing all INSPECTOR_HOOKS. */
  root: HTMLElement;
  /** Pinned ingest function (real `ingestAsset` once src/assets lands). */
  ingest: IngestAssetFn;
  /** Viewer factory (e.g. `(canvas, onStatus) => ModelViewer.attach({ canvas }, onStatus)`). */
  createViewer: ViewerFactory;
  /** Operator label recorded into provenance. */
  operator: string;
  /** Clock for `recordedAt`; defaults to `new Date().toISOString()`. */
  clock?: () => string;
  /** Optional state observer; called synchronously on every state transition. */
  onStateChange?: (state: InspectorState) => void;
  /** Async sha256 hex digest; defaults to `crypto.subtle`. */
  hashBytes?: (bytes: Uint8Array) => Promise<string>;
}

const GLB_MEDIA_TYPE = 'model/gltf-binary';

async function defaultHashBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'SHA-256 is unavailable (WebCrypto subtle crypto missing); cannot hash asset bytes.',
    );
  }
  // Copy into an exact-length owned buffer: subtle.digest takes BufferSource
  // and the input view may cover a larger backing store.
  const owned = new ArrayBuffer(bytes.length);
  new Uint8Array(owned).set(bytes);
  const digest = await subtle.digest('SHA-256', owned);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Bind the inspector to a template root. Owns intake -> ingest -> viewer
 * handoff -> downloads, plus all error/provenance rendering.
 */
export class AssetInspector {
  private readonly ingest: IngestAssetFn;
  private readonly operator: string;
  private readonly clock: () => string;
  private readonly hashBytes: (bytes: Uint8Array) => Promise<string>;
  private readonly onStateChange: ((state: InspectorState) => void) | undefined;
  private readonly canvas: HTMLCanvasElement;
  private readonly dropzone: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly sourceSelect: HTMLSelectElement;
  private readonly generatedByInput: HTMLInputElement;
  private readonly fitButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly wireframeButton: HTMLButtonElement;
  private readonly downloadGlbButton: HTMLButtonElement;
  private readonly downloadProvenanceButton: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly issuesEl: HTMLElement;
  private readonly provenanceEl: HTMLElement;
  private viewer: ModelViewer | null = null;
  private viewerStatus: ViewerStatus = { kind: 'empty' };
  private state: InspectorState = { kind: 'idle' };
  private wireframe = false;
  /** Incremented per intake; stale async loads bail out before touching UI. */
  private generation = 0;

  private constructor(options: AssetInspectorOptions) {
    this.ingest = options.ingest;
    this.operator = options.operator;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.hashBytes = options.hashBytes ?? defaultHashBytes;
    this.onStateChange = options.onStateChange;
    const get = <T extends HTMLElement>(name: InspectorHookName): T => {
      const found = options.root.querySelector<T>(
        `[data-inspector-hook="${name}"]`,
      );
      if (found === null) {
        throw new Error(
          `asset-inspector template is missing hook "${name}"`,
        );
      }
      return found;
    };
    this.canvas = get<HTMLCanvasElement>(INSPECTOR_HOOKS.canvas);
    this.dropzone = get(INSPECTOR_HOOKS.dropzone);
    this.fileInput = get<HTMLInputElement>(INSPECTOR_HOOKS.fileInput);
    this.sourceSelect = get<HTMLSelectElement>(INSPECTOR_HOOKS.sourceSelect);
    this.generatedByInput = get<HTMLInputElement>(INSPECTOR_HOOKS.generatedBy);
    this.fitButton = get<HTMLButtonElement>(INSPECTOR_HOOKS.fitButton);
    this.resetButton = get<HTMLButtonElement>(INSPECTOR_HOOKS.resetButton);
    this.wireframeButton = get<HTMLButtonElement>(
      INSPECTOR_HOOKS.wireframeButton,
    );
    this.downloadGlbButton = get<HTMLButtonElement>(INSPECTOR_HOOKS.downloadGlb);
    this.downloadProvenanceButton = get<HTMLButtonElement>(
      INSPECTOR_HOOKS.downloadProvenance,
    );
    this.statusEl = get(INSPECTOR_HOOKS.status);
    this.issuesEl = get(INSPECTOR_HOOKS.issues);
    this.provenanceEl = get(INSPECTOR_HOOKS.provenance);

    const { viewer, status } = options.createViewer(this.canvas, (next) => {
      this.viewerStatus = next;
      this.render();
    });
    this.viewer = viewer;
    this.viewerStatus = status;

    this.fileInput.addEventListener('change', () => {
      void this.onFiles(this.fileInput.files, false);
      this.fileInput.value = '';
    });
    this.dropzone.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('input,button,select')) return;
      this.fileInput.click();
    });
    this.dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.fileInput.click();
      }
    });
    this.dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      this.dropzone.classList.add('is-dragging');
    });
    this.dropzone.addEventListener('dragleave', () => {
      this.dropzone.classList.remove('is-dragging');
    });
    this.dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      this.dropzone.classList.remove('is-dragging');
      void this.onFiles(event.dataTransfer?.files ?? null, true);
    });
    this.fitButton.addEventListener('click', () => this.viewer?.fitView());
    this.resetButton.addEventListener('click', () => this.viewer?.resetView());
    this.wireframeButton.addEventListener('click', () => {
      this.wireframe = !this.wireframe;
      this.viewer?.setWireframe(this.wireframe);
      this.render();
    });
    this.downloadGlbButton.addEventListener('click', () => this.downloadGlb());
    this.downloadProvenanceButton.addEventListener('click', () =>
      this.downloadProvenance(),
    );
    this.render();
  }

  /** Bind to a template root; throws if any hook is missing. */
  static bind(options: AssetInspectorOptions): AssetInspector {
    return new AssetInspector(options);
  }

  getState(): InspectorState {
    return this.state;
  }

  private async onFiles(
    files: FileList | File[] | null,
    fromDrop: boolean,
  ): Promise<void> {
    if (files === null || files.length === 0) return;
    const file = files[0];
    if (file === undefined) return;
    const generation = ++this.generation;
    const filename = file.name || 'dropped-asset.glb';
    this.viewer?.clear();
    this.wireframe = false;
    this.viewer?.setWireframe(false);
    if (file.size > DEFAULT_MAX_BYTES) {
      this.setState({kind: 'failed', filename, code: 'asset-too-large', path: null, message: 'GLB exceeds the 32 MiB intake limit.'});
      return;
    }
    this.setState({ kind: 'reading', filename });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (generation !== this.generation) return;
      this.setState({
        kind: 'failed',
        filename,
        code: 'read-failed',
        path: null,
        message:
          `Could not read ${fromDrop ? 'dropped' : 'chosen'} file: ` +
          (error instanceof Error ? error.message : String(error)),
      });
      return;
    }
    let sha256Hex: string;
    try {
      sha256Hex = await this.hashBytes(bytes);
    } catch (error) {
      if (generation !== this.generation) return;
      this.setState({
        kind: 'failed',
        filename,
        code: 'hash-unavailable',
        path: null,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (generation !== this.generation) return;
    const source = this.sourceSelect.value === 'synthetic-generated'
      ? ('synthetic-generated' as const)
      : ('manually-imported' as const);
    const generatedBy = this.generatedByInput.value.trim();
    let result: IngestAssetResult;
    try {
      result = await this.ingest({
        bytes,
        filename,
        mediaType: GLB_MEDIA_TYPE,
        source,
        ...(generatedBy.length > 0 ? { generatedBy } : {}),
        recordedAt: this.clock(),
        operator: this.operator,
        sha256Hex,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.viewer?.clear();
      this.setState({
        kind: 'failed',
        filename,
        ...(isCodedError(error)
          ? { code: error.code, path: error.path ?? null, message: error.message }
          : {
              code: 'ingest-threw',
              path: null,
              message: error instanceof Error ? error.message : String(error),
            }),
      });
      return;
    }
    if (generation !== this.generation) return;
    // Reject before render: any self-containment issue blocks the viewer.
    if (result.issues.some(issue => !issue.code.endsWith('-advisory'))) {
      this.viewer?.clear();
      this.setState({
        kind: 'blocked',
        filename,
        bytes,
        record: result.record,
        issues: result.issues,
      });
      return;
    }
    if (this.viewer === null) {
      this.setState({
        kind: 'failed',
        filename,
        code: this.viewerStatus.kind,
        path: null,
        message: viewerDetail(this.viewerStatus, 'Model preview is unavailable.'),
      });
      return;
    }
    const status = await this.viewer.showModel(bytes);
    if (generation !== this.generation) return;
    if (status.kind !== 'ready') {
      this.setState({
        kind: 'failed',
        filename,
        code: status.kind,
        path: null,
        message: viewerDetail(status, 'Model preview failed.'),
      });
      return;
    }
    this.wireframe = false;
    this.setState({ kind: 'ready', filename, bytes, record: result.record });
  }

  private downloadGlb(): void {
    if (this.state.kind !== 'ready' && this.state.kind !== 'blocked') return;
    const { bytes, record } = this.state;
    // Owned exact-length buffer: Blob takes ArrayBuffer and the ingested
    // view may cover a larger backing store.
    const owned = new ArrayBuffer(bytes.length);
    new Uint8Array(owned).set(bytes);
    triggerDownload(
      new Blob([owned], { type: GLB_MEDIA_TYPE }),
      record.originalFilename ?? 'asset.glb',
    );
  }

  private downloadProvenance(): void {
    if (this.state.kind !== 'ready' && this.state.kind !== 'blocked') return;
    const { record } = this.state;
    const base = (record.originalFilename ?? 'asset').replace(/\.glb$/i, '');
    triggerDownload(
      new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
      `${base}.provenance.json`,
    );
  }

  private setState(state: InspectorState): void {
    this.state = state;
    this.onStateChange?.(state);
    this.render();
  }

  private render(): void {
    this.statusEl.textContent = statusText(this.state, this.viewerStatus);
    this.statusEl.dataset['state'] = this.state.kind;
    renderIssues(this.issuesEl, this.state);
    renderProvenance(this.provenanceEl, this.state);
    const canView = this.state.kind === 'ready' && this.viewer !== null;
    this.fitButton.disabled = !canView;
    this.resetButton.disabled = !canView;
    this.wireframeButton.disabled = !canView;
    this.wireframeButton.setAttribute('aria-pressed', String(this.wireframe));
    const hasBytes =
      this.state.kind === 'ready' || this.state.kind === 'blocked';
    this.downloadGlbButton.disabled = !hasBytes;
    this.downloadProvenanceButton.disabled = !hasBytes;
  }
}

function isCodedError(error: unknown): error is CodedErrorShape {
  if (typeof error !== 'object' || error === null) return false;
  if (!('code' in error) || !('message' in error)) return false;
  const code = error.code;
  const message = error.message;
  return typeof code === 'string' && typeof message === 'string';
}

/** Detail text of a non-ready viewer status, or the fallback message. */
export function viewerDetail(status: ViewerStatus, fallback: string): string {
  if (status.kind === 'webgl-unavailable' || status.kind === 'parse-failed') {
    return status.message;
  }
  return fallback;
}

function statusText(state: InspectorState, viewerStatus: ViewerStatus): string {
  switch (state.kind) {
    case 'idle':
      return viewerStatus.kind === 'webgl-unavailable'
        ? `Choose a .glb file or drop one here. Preview disabled: ${viewerStatus.message}`
        : 'Choose a .glb file or drop one here to inspect it.';
    case 'reading':
      return `Reading ${state.filename}…`;
    case 'ready':
      return `Showing ${state.filename} — ingest clean, self-contained.`;
    case 'blocked':
      return (
        `Rejected before render: ${state.filename} failed self-containment ` +
        `(${state.issues.length} issue${state.issues.length === 1 ? '' : 's'}). ` +
        `Provenance below; original bytes still downloadable.`
      );
    case 'failed':
      return `Failed (${state.code}): ${state.message}`;
  }
}

function renderIssues(container: HTMLElement, state: InspectorState): void {
  container.replaceChildren();
  const issues = state.kind === 'blocked' ? state.issues : [];
  if (issues.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = state.kind === 'ready'
      ? 'No validation issues.'
      : 'Validation issues will appear here.';
    container.appendChild(empty);
    return;
  }
  const list = document.createElement('ul');
  for (const issue of issues) {
    const item = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = issue.code;
    item.appendChild(code);
    const where = document.createElement('span');
    where.textContent = ` ${issue.path}: ${issue.message}`;
    item.appendChild(where);
    list.appendChild(item);
  }
  container.appendChild(list);
}

function renderProvenance(container: HTMLElement, state: InspectorState): void {
  container.replaceChildren();
  const record =
    state.kind === 'ready' || state.kind === 'blocked' ? state.record : null;
  if (record === null) {
    const empty = document.createElement('p');
    empty.textContent = 'Provenance will appear here after ingest.';
    container.appendChild(empty);
    return;
  }
  const rows: Array<[string, string]> = [
    ['assetId', record.assetId],
    ['source', record.source],
    ['originalFilename', record.originalFilename ?? '—'],
    ['generatedBy', record.generatedBy ?? '—'],
    ['mediaType', record.mediaType],
    ['byteLength', String(record.byteLength)],
    ['sha256Hex', record.sha256Hex],
    ['recordedAt', record.recordedAt],
    ['operator', record.operator],
    ['calibrationStatus', `${record.calibrationStatus} (visualization only)`],
    ['glb.version', String(record.glb.version)],
    ['glb.jsonByteLength', String(record.glb.jsonByteLength)],
    ['glb.hasBinChunk', String(record.glb.hasBinChunk)],
    ['glb.nodeCount', record.glb.nodeCount?.toString() ?? '—'],
    ['glb.meshCount', record.glb.meshCount?.toString() ?? '—'],
    [
      'declaredPositionAccessorBounds',
      record.declaredPositionAccessorBounds
        ? `min [${record.declaredPositionAccessorBounds.min.join(', ')}] / max [${record.declaredPositionAccessorBounds.max.join(', ')}] (visualization only)`
        : '—',
    ],
  ];
  const table = document.createElement('table');
  for (const [key, value] of rows) {
    const row = document.createElement('tr');
    const head = document.createElement('th');
    head.textContent = key;
    head.scope = 'row';
    const cell = document.createElement('td');
    cell.textContent = value;
    row.appendChild(head);
    row.appendChild(cell);
    table.appendChild(row);
  }
  container.appendChild(table);
}

/** Blob-object-URL download; no navigation, no fetch, revocable. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
