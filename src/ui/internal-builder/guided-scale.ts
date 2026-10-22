/// <reference lib="dom" />
/**
 * Guided first-measured-region setup (lead-owned, staff-only).
 *
 * When a product view has no evaluated photo mapping, the workspace cannot
 * author millimetres yet. This panel captures the missing evidence visually:
 * the operator clicks the four corners of a KNOWN rectangle on the product
 * photo (in order: top-left, top-right, bottom-right, bottom-left AS SEEN on
 * the photo), enters the rectangle's real width + height in millimetres, and
 * declares the orientation (whether the photo top is the area top or the
 * photo is upside-down relative to the area).
 *
 * The four photo corners become normalized-UV ↔ region-mm correspondences
 * through {@link guidedCorrespondences} (pure, unit-tested); the caller
 * solves them with the existing `solveAffineFromCorrespondences` and, on
 * success, creates the calibration record + region + mapping. Nothing is
 * ever inferred from photo aspect ratio or model units: one length alone
 * cannot determine the 6-parameter affine, so width AND height are both
 * required and the panel refuses short evidence with an actionable message.
 *
 * No files, no fetch, no persistence here: the caller owns the photo bytes
 * and the commit. The host container (`data-builder-hook="guided-scale"`)
 * is lead-owned in the template; this module builds every node
 * programmatically and never touches the template.
 */
import type { PhotoMappingCorrespondence } from '../customer-editor/presentation-photo-mapping.js';
import type { ProductSetupScope } from './product-setup-view.js';

export type GuidedScaleOrientation = 'photo-up' | 'photo-down';

export interface GuidedScalePhoto {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  label: string;
}

export interface GuidedScaleRequest {
  scope: ProductSetupScope;
  photo: GuidedScalePhoto;
  /** Exact `presentation/` raster path the mapping will reference. */
  imagePath: string;
}

export interface GuidedScaleCommit {
  cornersUv: Array<{ u: number; v: number }>;
  widthMm: number;
  heightMm: number;
  orientation: GuidedScaleOrientation;
}

export type GuidedScaleOutcome =
  | { ok: true }
  | { ok: false; error: string };

export interface GuidedScaleCallbacks {
  /**
   * Solve + create calibration/region/mapping atomically, or neither.
   * Resolve `{ ok: true }` only after durable persistence; failure keeps
   * the panel open with the operator's corners intact.
   */
  onCommit(
    request: GuidedScaleRequest,
    commit: GuidedScaleCommit,
  ): GuidedScaleOutcome | Promise<GuidedScaleOutcome>;
  onCancel(): void;
  onStatus(message: string): void;
}

export interface GuidedScaleHandle {
  show(request: GuidedScaleRequest): void;
  hide(): void;
  refresh(): void;
  destroy(): void;
}

/**
 * Region-frame (Y-up) millimetre corners C1..C4 for a W×H rectangle.
 * Photo-up: the photo top edge is the area top (C1 = top-left = (0, H)).
 * Photo-down: the photo is rotated 180° relative to the area, so the photo
 * top-left corner is the area BOTTOM-right: C1 = (W, 0), C2 = (0, 0),
 * C3 = (0, H), C4 = (W, H). Both axes flip; a Y-only flip would mirror the
 * area, not rotate it. Pure; no DOM.
 */
export function guidedMmCorners(
  widthMm: number,
  heightMm: number,
  orientation: GuidedScaleOrientation,
): Array<{ x: number; y: number }> {
  if (orientation === 'photo-down') {
    return [
      { x: widthMm, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: heightMm },
      { x: widthMm, y: heightMm },
    ];
  }
  return [
    { x: 0, y: heightMm },
    { x: widthMm, y: heightMm },
    { x: widthMm, y: 0 },
    { x: 0, y: 0 },
  ];
}

/**
 * Build the four UV↔mm correspondences for the solver from clicked photo
 * corners (C1..C4 in photo order) and the declared rectangle. Returns an
 * error string instead of pairs when the input is unusable — the caller
 * surfaces it verbatim. Pure; no DOM.
 */
export function guidedCorrespondences(
  cornersUv: ReadonlyArray<{ u: number; v: number }>,
  widthMm: number,
  heightMm: number,
  orientation: GuidedScaleOrientation,
): { ok: true; pairs: PhotoMappingCorrespondence[] } | { ok: false; error: string } {
  if (cornersUv.length !== 4) {
    return { ok: false, error: `Click all 4 rectangle corners on the photo first (have ${cornersUv.length}).` };
  }
  for (let index = 0; index < 4; index += 1) {
    const corner = cornersUv[index]!;
    if (!Number.isFinite(corner.u) || !Number.isFinite(corner.v)) {
      return { ok: false, error: `Corner C${index + 1} is not a finite photo position; re-click it.` };
    }
    if (corner.u < 0 || corner.u > 1 || corner.v < 0 || corner.v > 1) {
      return { ok: false, error: `Corner C${index + 1} lies outside the photo; click inside the photo.` };
    }
  }
  if (!Number.isFinite(widthMm) || !(widthMm > 0)) {
    return { ok: false, error: 'Enter the rectangle width in millimetres (a number greater than 0).' };
  }
  if (!Number.isFinite(heightMm) || !(heightMm > 0)) {
    return { ok: false, error: 'Enter the rectangle height in millimetres (a number greater than 0).' };
  }
  const mm = guidedMmCorners(widthMm, heightMm, orientation);
  return {
    ok: true,
    pairs: mm.map((point, index) => ({
      uv: { u: cornersUv[index]!.u, v: cornersUv[index]!.v },
      mm: { xMm: point.x, yMm: point.y },
    })),
  };
}

/** Header-sniff the raster media type for a data-URL render (no guessing). */
function guessMediaType(bytes: Uint8Array): string {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return '';
}

function sideLabel(side: string): string {
  switch (side) {
    case 'front': return 'Front';
    case 'back': return 'Back';
    case 'left': return 'Left';
    case 'right': return 'Right';
    default: return side;
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Render the guided-scale panel into `host`. The host is shown/hidden by
 * the caller (`hidden` attribute); this module only fills/clears it.
 */
export function createGuidedScale(
  host: HTMLElement,
  callbacks: GuidedScaleCallbacks,
): GuidedScaleHandle {
  let destroyed = false;
  let request: GuidedScaleRequest | null = null;
  let corners: Array<{ x: number; y: number }> = [];
  let pending = false;
  let natural: { width: number; height: number } | null = null;

  function currentPhotoBox(): { img: HTMLImageElement; svg: SVGSVGElement } | null {
    const img = host.querySelector<HTMLImageElement>('.guided-scale-photo');
    const svg = host.querySelector<SVGSVGElement>('.guided-scale-overlay');
    return img && svg ? { img, svg } : null;
  }

  function photoToUv(event: MouseEvent, svg: SVGSVGElement): { u: number; v: number } | null {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      u: (event.clientX - rect.left) / rect.width,
      v: (event.clientY - rect.top) / rect.height,
    };
  }

  function paintMarkers(): void {
    const box = currentPhotoBox();
    if (!box || !natural) return;
    const { svg } = box;
    svg.replaceChildren();
    corners.forEach((corner, index) => {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(corner.x));
      circle.setAttribute('cy', String(corner.y));
      circle.setAttribute('r', '9');
      circle.setAttribute('class', `guided-scale-corner${index === 0 ? ' is-first' : ''}`);
      svg.append(circle);
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', String(corner.x + 13));
      label.setAttribute('y', String(corner.y + 5));
      label.setAttribute('class', 'guided-scale-label');
      label.textContent = `C${index + 1}`;
      svg.append(label);
    });
    if (corners.length >= 2 && natural) {
      const poly = document.createElementNS(SVG_NS, 'polyline');
      poly.setAttribute(
        'points',
        corners.map((corner) => `${corner.x},${corner.y}`).join(' ') +
        (corners.length === 4 ? ` ${corners[0]!.x},${corners[0]!.y}` : ''),
      );
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', '#0b6cab');
      poly.setAttribute('stroke-width', '2');
      poly.setAttribute('stroke-dasharray', '8 5');
      svg.prepend(poly);
    }
  }

  function setStatus(message: string): void {
    const line = host.querySelector<HTMLElement>('[data-guided="status"]');
    if (line) line.textContent = message;
    callbacks.onStatus(message);
  }

  function readForm(): { widthMm: number; heightMm: number; orientation: GuidedScaleOrientation } {
    const widthInput = host.querySelector<HTMLInputElement>('[data-guided="width"]');
    const heightInput = host.querySelector<HTMLInputElement>('[data-guided="height"]');
    const orientationInput = host.querySelector<HTMLSelectElement>('[data-guided="orientation"]');
    return {
      widthMm: widthInput ? widthInput.valueAsNumber : NaN,
      heightMm: heightInput ? heightInput.valueAsNumber : NaN,
      orientation: orientationInput && orientationInput.value === 'photo-down' ? 'photo-down' : 'photo-up',
    };
  }

  function toDisplayCoords(uv: { u: number; v: number }): { x: number; y: number } | null {
    if (!natural) return null;
    return { x: uv.u * natural.width, y: uv.v * natural.height };
  }

  async function onCreate(): Promise<void> {
    if (pending || destroyed || !request) return;
    const active = request;
    const form = readForm();
    const built = guidedCorrespondences(
      corners.map((corner) => {
        if (!natural) return { u: NaN, v: NaN };
        return { u: corner.x / natural.width, v: corner.y / natural.height };
      }),
      form.widthMm,
      form.heightMm,
      form.orientation,
    );
    if (!built.ok) {
      setStatus(built.error);
      return;
    }
    pending = true;
    paintButtons();
    setStatus('Creating the measured area…');
    let outcome: GuidedScaleOutcome;
    try {
      outcome = await callbacks.onCommit(active, {
        cornersUv: built.pairs.map((pair) => ({ ...pair.uv })),
        widthMm: form.widthMm,
        heightMm: form.heightMm,
        orientation: form.orientation,
      });
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    pending = false;
    if (destroyed) return;
    paintButtons();
    if (outcome.ok) {
      corners = [];
      paintMarkers();
      return;
    }
    const reason = outcome.error.replace(/\.+$/, '');
    setStatus(`Not created: ${reason}. Your corners are intact — fix the values and try again.`);
  }

  function paintButtons(): void {
    const create = host.querySelector<HTMLButtonElement>('[data-guided="create"]');
    if (create) {
      create.disabled = pending || corners.length !== 4;
      create.textContent = pending ? 'Creating…' : 'Create measured area';
    }
    const undo = host.querySelector<HTMLButtonElement>('[data-guided="undo"]');
    if (undo) undo.disabled = pending || corners.length === 0;
    const clear = host.querySelector<HTMLButtonElement>('[data-guided="clear"]');
    if (clear) clear.disabled = pending || corners.length === 0;
  }

  function render(): void {
    host.replaceChildren();
    if (!request) return;
    const active = request;
    const title = document.createElement('h4');
    title.className = 'guided-scale-title';
    const regionName = active.scope.regionName?.trim() || '';
    title.textContent = regionName !== ''
      ? `Measure ${regionName} · ${sideLabel(active.scope.side)} view`
      : `Measure the ${sideLabel(active.scope.side)} view`;
    const intro = document.createElement('p');
    intro.className = 'muted';
    intro.textContent =
      'This view has no measured area yet, so positions cannot be stored in millimetres. ' +
      'Click the 4 corners of a rectangle you can measure (C1 top-left, C2 top-right, C3 bottom-right, C4 bottom-left as seen here), ' +
      'enter its real width and height, and declare which way is up. Nothing is guessed from the photo itself.';
    const figure = document.createElement('figure');
    figure.className = 'guided-scale-figure';
    const stage = document.createElement('div');
    stage.className = 'guided-scale-stage';
    const img = document.createElement('img');
    img.className = 'guided-scale-photo';
    img.alt = active.photo.label || `${sideLabel(active.scope.side)} product photo for measuring`;
    img.draggable = false;
    const media = guessMediaType(active.photo.bytes);
    if (media !== '') {
      let binary = '';
      const bytes = active.photo.bytes;
      const chunk = 8192;
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
      }
      img.src = `data:${media};base64,${btoa(binary)}`;
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'guided-scale-overlay');
    svg.setAttribute('viewBox', `0 0 ${active.photo.widthPx} ${active.photo.heightPx}`);
    svg.setAttribute('role', 'button');
    svg.setAttribute('aria-label', 'Product photo: click to place rectangle corners C1 to C4 in order');
    svg.tabIndex = 0;
    const placeAt = (event: MouseEvent): void => {
      if (pending || corners.length >= 4) return;
      const uv = photoToUv(event, svg);
      if (!uv) return;
      if (uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1) return;
      const display = toDisplayCoords(uv);
      if (!display) return;
      corners = [...corners, display];
      paintMarkers();
      paintButtons();
      setStatus(
        corners.length === 4
          ? 'Four corners placed. Enter width + height, check the orientation, then create the measured area.'
          : `Corner C${corners.length} placed. Click corner C${corners.length + 1} (${corners.length === 1 ? 'top-right' : corners.length === 2 ? 'bottom-right' : 'bottom-left'} as seen here).`,
      );
    };
    svg.addEventListener('click', placeAt);
    svg.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && corners.length === 4) {
        event.preventDefault();
        void onCreate();
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && corners.length > 0) {
        event.preventDefault();
        corners = corners.slice(0, -1);
        paintMarkers();
        paintButtons();
        setStatus(corners.length === 0 ? 'Corners cleared. Click C1 (top-left as seen here).' : `Removed the last corner (${corners.length} placed).`);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        corners = [];
        paintMarkers();
        paintButtons();
        setStatus('Corners cleared. Click C1 (top-left as seen here).');
      }
    });
    stage.append(img, svg);
    figure.append(stage);
    natural = { width: active.photo.widthPx, height: active.photo.heightPx };

    const form = document.createElement('div');
    form.className = 'product-setup-list';
    const widthLabel = document.createElement('label');
    widthLabel.className = 'product-setup-field product-setup-number';
    widthLabel.textContent = 'Rectangle width (mm, C1→C2 edge)';
    const widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.min = '0';
    widthInput.step = 'any';
    widthInput.placeholder = 'e.g. 280';
    widthInput.setAttribute('data-guided', 'width');
    widthInput.setAttribute('aria-label', 'Rectangle width in millimetres, the C1 to C2 edge');
    widthLabel.append(widthInput);
    const heightLabel = document.createElement('label');
    heightLabel.className = 'product-setup-field product-setup-number';
    heightLabel.textContent = 'Rectangle height (mm, C2→C3 edge)';
    const heightInput = document.createElement('input');
    heightInput.type = 'number';
    heightInput.min = '0';
    heightInput.step = 'any';
    heightInput.placeholder = 'e.g. 200';
    heightInput.setAttribute('data-guided', 'height');
    heightInput.setAttribute('aria-label', 'Rectangle height in millimetres, the C2 to C3 edge');
    heightLabel.append(heightInput);
    const orientationLabel = document.createElement('label');
    orientationLabel.className = 'product-setup-field';
    orientationLabel.textContent = 'Orientation';
    const orientationSelect = document.createElement('select');
    orientationSelect.setAttribute('data-guided', 'orientation');
    orientationSelect.setAttribute('aria-label', 'Which photo edge is the top of the measured area');
    for (const [value, label] of [
      ['photo-up', 'Photo top is the TOP of the area'],
      ['photo-down', 'Photo top is the BOTTOM (photo is upside-down)'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      orientationSelect.append(option);
    }
    orientationLabel.append(orientationSelect);
    form.append(widthLabel, heightLabel, orientationLabel);

    const actions = document.createElement('div');
    actions.className = 'product-setup-actions';
    const undoButton = document.createElement('button');
    undoButton.type = 'button';
    undoButton.className = 'btn-secondary';
    undoButton.setAttribute('data-guided', 'undo');
    undoButton.textContent = 'Undo corner';
    undoButton.addEventListener('click', () => {
      if (pending || corners.length === 0) return;
      corners = corners.slice(0, -1);
      paintMarkers();
      paintButtons();
      setStatus(corners.length === 0 ? 'Corners cleared. Click C1 (top-left as seen here).' : `Removed the last corner (${corners.length} placed).`);
    });
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'btn-secondary';
    clearButton.setAttribute('data-guided', 'clear');
    clearButton.textContent = 'Clear corners';
    clearButton.addEventListener('click', () => {
      if (pending) return;
      corners = [];
      paintMarkers();
      paintButtons();
      setStatus('Corners cleared. Click C1 (top-left as seen here).');
    });
    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'btn-primary';
    createButton.setAttribute('data-guided', 'create');
    createButton.textContent = 'Create measured area';
    createButton.addEventListener('click', () => void onCreate());
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn-secondary';
    cancelButton.setAttribute('data-guided', 'cancel');
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', () => {
      if (pending) return;
      corners = [];
      callbacks.onCancel();
    });
    actions.append(undoButton, clearButton, createButton, cancelButton);

    const status = document.createElement('p');
    status.className = 'muted product-setup-status';
    status.setAttribute('data-guided', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Click C1 (top-left as seen here). Both width and height are required — one length cannot determine the mapping.';

    host.append(title, intro, figure, form, actions, status);
    paintMarkers();
    paintButtons();
  }

  return {
    show(next: GuidedScaleRequest): void {
      if (destroyed) return;
      request = next;
      corners = [];
      pending = false;
      natural = { width: next.photo.widthPx, height: next.photo.heightPx };
      host.hidden = false;
      render();
    },
    hide(): void {
      request = null;
      corners = [];
      pending = false;
      host.replaceChildren();
      host.hidden = true;
    },
    refresh(): void {
      if (destroyed || !request) return;
      render();
    },
    destroy(): void {
      destroyed = true;
      request = null;
      host.replaceChildren();
    },
  };
}
