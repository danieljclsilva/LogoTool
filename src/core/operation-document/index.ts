/**
 * Operation-document view model builder.
 *
 * Pure function: takes a canonical `ResultCandidate` snapshot and produces a
 * structured document description. No DOM, clock, or I/O.
 */

import type {
  ExportConfiguration,
  ExportPlacement,
  PointMm,
  ProductDefinition,
  Region,
  ResultCandidate,
} from "../types.js";
import { MAX_PREVIEW_BYTES, readRasterHeader } from "../../assets/raster-header.js";
import type {
  ArtworkPreview,
  BuildOperationDocumentInput,
  BuildOperationSheetViewInput,
  DiagramAxes,
  DiagramExclusion,
  OperationArtworkAsset,
  OperationConfiguration,
  OperationDocument,
  OperationIdentity,
  OperationPlacement,
  OperationProofConfiguration,
  OperationProofPlacement,
  OperationProofSide,
  OperationReferenceView,
  OperationSheet,
  OperationSheetLogo,
  OperationSheetSide,
  OperationSheetView,
  OperationSheetViewVersion,
  PhotoMappingState,
  PlacementDiagram,
  Point2d,
  ProofPhotoState,
  ReferenceViewInput,
  SheetLogoExtras,
} from "./types.js";
import {
  measurePlacement,
  rotatedFootprintCorners,
  type DimensionBinding,
} from "../operation-measurements/index.js";

const MARGIN_FACTOR = 0.12;
const MIN_SIZE = 50;
const AXES_LENGTH = 30;
const SHORT_DIGEST_CHARS = 16;

/**
 * Previewable raster extensions, mirroring the presentation adapter's
 * allowlist (`src/ui/customer-editor/presentation-assets.ts`). Anything else
 * (SVG, PDF, production files) is never rendered: originals stay preserved
 * as bytes behind the packaging adapter.
 */
const PREVIEWABLE_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function normalizeAssetBytes(
  input: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array> | undefined,
): Map<string, Uint8Array> | undefined {
  if (input === undefined) return undefined;
  if (input instanceof Map) return new Map(input);
  return new Map(Object.entries(input));
}

/**
 * Pure bounded preview verdict for one package path. Enforces the shared
 * byte + pixel-dimension caps via `readRasterHeader` and requires the header
 * media type to agree with the file extension (disguised content fails).
 * Never throws; never fetches; never mutates its inputs.
 */
function previewAsset(uri: string, assets: Map<string, Uint8Array> | undefined): ArtworkPreview {
  if (assets === undefined) return { status: "not-supplied" };
  const bytes = assets.get(uri);
  if (bytes === undefined || bytes.length === 0) return { status: "missing" };
  if (bytes.length > MAX_PREVIEW_BYTES) return { status: "too-large", byteLength: bytes.length };
  const dot = uri.lastIndexOf(".");
  const expected = dot < 0 ? undefined : PREVIEWABLE_BY_EXTENSION[uri.slice(dot).toLowerCase()];
  if (expected === undefined) return { status: "unsupported" };
  const header = readRasterHeader(bytes);
  if (header === null || header.mediaType !== expected) {
    return { status: "corrupt", byteLength: bytes.length };
  }
  return {
    status: "inline-raster",
    mediaType: header.mediaType,
    widthPx: header.width,
    heightPx: header.height,
    byteLength: bytes.length,
  };
}

function toPoint2d(point: PointMm): Point2d {
  return { x: point[0], y: point[1] };
}

/**
 * Display-only 1-decimal millimetre rounding for the compact proof summary
 * (UI/PDF). Canonical exact values are untouched; the technical appendix
 * keeps full precision. Never exponential notation; negative zero collapses
 * to `0.0`.
 */
export function formatMm1(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const rounded = Math.round(value * 10) / 10;
  const collapsed = rounded === 0 ? 0 : rounded;
  return collapsed.toFixed(1);
}

/**
 * Rotated artwork-bbox footprint corners in frame millimetres. Delegates to
 * the pure edge-to-anchor geometry (`rotatedFootprintCorners`) so the diagram
 * overlay and the measured dimensions always share the exact same numbers —
 * displayed 1-decimal strings equal the pure millimetre calculations.
 */
function rotatedFootprint(
  centreX: number,
  centreY: number,
  width: number,
  height: number,
  rotationDeg: number,
): Point2d[] {
  return rotatedFootprintCorners(centreX, centreY, width, height, rotationDeg).map((corner) => ({
    x: corner.x,
    y: corner.y,
  }));
}

function polygonBounds(polygon: Point2d[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (polygon.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function computeViewBox(safePolygon: Point2d[], footprint: Point2d[]): { minX: number; minY: number; width: number; height: number } {
  const allPoints = [...safePolygon, ...footprint];
  const bounds = polygonBounds(allPoints);
  if (!bounds) return { minX: -MIN_SIZE / 2, minY: -MIN_SIZE / 2, width: MIN_SIZE, height: MIN_SIZE };
  const width = Math.max(bounds.maxX - bounds.minX, MIN_SIZE);
  const height = Math.max(bounds.maxY - bounds.minY, MIN_SIZE);
  const margin = Math.max(width, height) * MARGIN_FACTOR;
  return {
    minX: bounds.minX - margin,
    minY: bounds.minY - margin,
    width: width + margin * 2,
    height: height + margin * 2,
  };
}

function buildAxes(originX: number, originY: number, xLabel: string, yLabel: string): DiagramAxes {
  return {
    originX,
    originY,
    xEndX: originX + AXES_LENGTH,
    xEndY: originY,
    yEndX: originX,
    yEndY: originY + AXES_LENGTH,
    xLabel,
    yLabel,
  };
}

function buildPlacementDiagram(placement: ExportPlacement, region: Region | undefined): PlacementDiagram {
  const safePolygon = region?.safeArea.map(toPoint2d) ?? [];
  const exclusions: DiagramExclusion[] = region?.exclusions?.map((polygon, index) => ({
    id: `exclusion-${index}`,
    name: `Exclusion ${index + 1}`,
    polygon: polygon.map(toPoint2d),
  })) ?? [];
  const footprint = rotatedFootprint(
    placement.pos.xMm,
    placement.pos.yMm,
    placement.widthMm,
    placement.heightMm,
    placement.rotationDeg,
  );
  const axes = buildAxes(0, 0, placement.frame.axes.xPositive, placement.frame.axes.yPositive);
  const viewBox = computeViewBox([...safePolygon, ...exclusions.flatMap((item) => item.polygon),
    { x: 0, y: 0 }, { x: axes.xEndX, y: axes.xEndY }, { x: axes.yEndX, y: axes.yEndY }], footprint);
  return { viewBox, safePolygon, safeSupplied: safePolygon.length > 0, exclusions, footprint, axes };
}

function buildArtworkAsset(
  uri: string,
  role: OperationArtworkAsset["role"],
  mediaType: string,
  sha256Hex: string | undefined,
  description: string | undefined,
  assets: Map<string, Uint8Array> | undefined,
): OperationArtworkAsset {
  return {
    uri,
    role,
    mediaType,
    ...(sha256Hex !== undefined ? { sha256Hex } : {}),
    ...(description !== undefined ? { description } : {}),
    preview: previewAsset(uri, assets),
  };
}

function buildOperationPlacement(
  placement: ExportPlacement,
  displayIndex: number,
  productById: Map<string, ProductDefinition>,
  assets: Map<string, Uint8Array> | undefined,
): OperationPlacement {
  const product = productById.get(placement.productId);
  const region = product?.regions.find((item) => item.id === placement.regionId);
  return {
    displayIndex,
    ...(placement.id !== undefined ? { id: placement.id } : {}),
    configurationId: placement.configurationId,
    productId: placement.productId,
    variantId: placement.variantId,
    logoId: placement.logoId,
    regionId: placement.regionId,
    regionName: region?.name ?? null,
    method: placement.method,
    pos: { xMm: placement.pos.xMm, yMm: placement.pos.yMm },
    widthMm: placement.widthMm,
    heightMm: placement.heightMm,
    rotationDeg: placement.rotationDeg,
    ...(placement.instructions !== undefined ? { instructions: placement.instructions } : {}),
    frame: placement.frame,
    calibration: placement.calibration,
    artwork: {
      logoId: placement.artwork.logoId,
      ...(placement.artwork.role !== undefined ? { role: placement.artwork.role } : {}),
      assets: placement.artwork.assets.map((asset) =>
        buildArtworkAsset(asset.uri, asset.role, asset.mediaType, asset.sha256Hex, asset.description, assets)
      ),
    },
    diagram: buildPlacementDiagram(placement, region),
  };
}

/**
 * Own-key record read. Configuration ids are caller-authored, so lookups
 * must not resolve through the prototype chain (`__proto__` would otherwise
 * yield `Object.prototype` and crash on `.map`, or silently pick up
 * inherited members). Missing or inherited keys read as absent.
 */
function ownEntry<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (record === undefined) return undefined;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function buildReferenceViews(
  configurationId: string,
  input: BuildOperationDocumentInput,
  assets: Map<string, Uint8Array> | undefined,
): { views: OperationReferenceView[]; note: string | null } {
  const selections: readonly ReferenceViewInput[] = ownEntry(input.referenceViews, configurationId) ?? [];
  const views = selections.map((selection) => ({
    view: selection.view,
    imagePath: selection.imagePath,
    label: selection.label ?? null,
    preview: previewAsset(selection.imagePath, assets),
  }));
  const warning = ownEntry(input.referenceWarnings, configurationId) ?? null;
  if (warning !== null) return { views, note: warning };
  if (views.length === 0) {
    return { views, note: "No product reference supplied for this configuration in the package." };
  }
  return { views, note: null };
}

function buildOperationConfiguration(
  configuration: ExportConfiguration,
  index: number,
  productById: Map<string, ProductDefinition>,
  input: BuildOperationDocumentInput,
  assets: Map<string, Uint8Array> | undefined,
): OperationConfiguration {
  const reference = buildReferenceViews(configuration.id, input, assets);
  return {
    index,
    id: configuration.id,
    productId: configuration.productId,
    variantId: configuration.variantId,
    ...(configuration.productName !== undefined ? { productName: configuration.productName } : {}),
    ...(configuration.variantName !== undefined ? { variantName: configuration.variantName } : {}),
    placements: configuration.placements.map((placement, placementIndex) =>
      buildOperationPlacement(placement, placementIndex + 1, productById, assets)
    ),
    referenceViews: reference.views,
    referenceNote: reference.note,
  };
}

/** Photo state for one reference view: exact-path binding only, never inference. */
function photoStateForView(
  imagePath: string,
  states: readonly PhotoMappingState[] | undefined,
): ProofPhotoState {
  const bound = states?.find((state) => state.imagePath === imagePath);
  if (bound === undefined) return "reference-only";
  return bound.status === "review" ? "mapped-review" : "mapped-provisional";
}

/** Validated mapping binding for one reference view, if the caller evaluated one with geometry. */
function mappingForView(
  imagePath: string,
  states: readonly PhotoMappingState[] | undefined,
): { regionId: string; view: string; transform: { a: number; b: number; c: number; d: number; e: number; f: number }; status: "provisional" | "review" } | null {
  const bound = states?.find((state) => state.imagePath === imagePath);
  if (
    bound === undefined || bound.regionId === undefined || bound.view === undefined ||
    bound.transform === undefined ||
    !Number.isFinite(bound.transform.a) || !Number.isFinite(bound.transform.b) ||
    !Number.isFinite(bound.transform.c) || !Number.isFinite(bound.transform.d) ||
    !Number.isFinite(bound.transform.e) || !Number.isFinite(bound.transform.f)
  ) {
    return null;
  }
  const det = bound.transform.a * bound.transform.e - bound.transform.b * bound.transform.d;
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12) return null;
  return { regionId: bound.regionId, view: bound.view, transform: { ...bound.transform }, status: bound.status };
}

/** Package paths of header-validated raster originals for one built placement. */
function rasterArtworkUris(built: OperationPlacement): string[] {
  return built.artwork.assets
    .filter((asset) => asset.preview.status === "inline-raster")
    .map((asset) => asset.uri);
}

function artworkStatusFor(placement: OperationPlacement): string {
  const total = placement.artwork.assets.length;
  if (total === 0) return "no artwork assets";
  const previewable = placement.artwork.assets.filter(
    (asset) => asset.preview.status === "inline-raster",
  ).length;
  if (previewable === total) return `${total} asset${total === 1 ? "" : "s"}, previewable`;
  if (previewable === 0) return `${total} asset${total === 1 ? "" : "s"}, none previewable (see appendix)`;
  return `${total} assets, ${previewable} previewable`;
}

function buildProofConfiguration(
  configuration: ExportConfiguration,
  productById: Map<string, ProductDefinition>,
  logoNameById: Map<string, string>,
  input: BuildOperationDocumentInput,
  assets: Map<string, Uint8Array> | undefined,
): OperationProofConfiguration {
  const reference = buildReferenceViews(configuration.id, input, assets);
  const states = ownEntry(input.photoStates, configuration.id);
  const placements: OperationProofPlacement[] = configuration.placements.map((placement, placementIndex) => {
    const built = buildOperationPlacement(placement, placementIndex + 1, productById, assets);
    return {
      logoId: built.logoId,
      logoName: logoNameById.get(built.logoId) ?? null,
      regionId: built.regionId,
      regionName: built.regionName,
      method: built.method,
      widthMm1: formatMm1(built.widthMm),
      heightMm1: formatMm1(built.heightMm),
      centreX1: formatMm1(built.pos.xMm),
      centreY1: formatMm1(built.pos.yMm),
      rotationDeg: built.rotationDeg,
      pos: { xMm: built.pos.xMm, yMm: built.pos.yMm },
      widthMm: built.widthMm,
      heightMm: built.heightMm,
      artworkStatus: artworkStatusFor(built),
      artworkUris: rasterArtworkUris(built),
    };
  });
  const sides: OperationProofSide[] = reference.views.map((view) => ({
    view: view.view,
    label: view.label,
    imagePath: view.imagePath,
    photoState: photoStateForView(view.imagePath, states),
    note: reference.note,
    mapping: mappingForView(view.imagePath, states),
  }));
  return {
    configurationId: configuration.id,
    productId: configuration.productId,
    variantId: configuration.variantId,
    ...(configuration.productName !== undefined ? { productName: configuration.productName } : {}),
    ...(configuration.variantName !== undefined ? { variantName: configuration.variantName } : {}),
    placements,
    sides,
  };
}

/**
 * Evidence-derived photo limitation lines. Derived only from what the caller
 * supplied (reference selections, evaluated mappings, package asset
 * presence) — never a "photos absent" claim when views are present, never a
 * calibrated-overlay implication when nothing evaluated a mapping.
 */
function derivePhotoLimitations(
  proof: readonly OperationProofConfiguration[],
  assets: Map<string, Uint8Array> | undefined,
): string[] {
  const sideCount = proof.reduce((total, entry) => total + entry.sides.length, 0);
  if (sideCount === 0) {
    return [
      "Photo evidence: no product photos are in the package; the dimensioned diagrams are the only visual basis.",
    ];
  }
  let mapped = 0;
  let provisional = 0;
  for (const entry of proof) {
    for (const side of entry.sides) {
      if (side.photoState !== "reference-only") {
        mapped += 1;
        if (side.photoState === "mapped-provisional") provisional += 1;
      }
    }
  }
  if (mapped === 0) {
    const mappingFilePresent = assets?.has("presentation/photo-mappings.json") ?? false;
    const evaluated = mappingFilePresent
      ? "a photo-mapping file is present in the package but was not evaluated by this build"
      : "no photo-mapping bindings are in the package";
    return [
      `Photo evidence: ${sideCount} reference photo${sideCount === 1 ? "" : "s"} supplied, all unmapped (${evaluated}) — view photos as reference only; no logo overlay on photos is calibrated.`,
    ];
  }
  const underReview = mapped - provisional;
  return [
    `Photo evidence: ${sideCount} reference photo${sideCount === 1 ? "" : "s"} supplied, ${mapped} bound by evaluated photo-mapping entries (${provisional} provisional, ${underReview} under review); mapped overlays are visual trials only, never production approval.`,
  ];
}

function buildIdentity(candidate: ResultCandidate, input: BuildOperationDocumentInput): OperationIdentity {
  return {
    projectId: candidate.projectId,
    revision: candidate.revision,
    digest: candidate.digest,
    shortDigest: candidate.digest.slice(0, SHORT_DIGEST_CHARS),
    schemaVersion: candidate.schemaVersion,
    ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
    reviewStatus: candidate.status,
    calibrationStatus: "Calibration and physical validation unresolved; synthetic planar data only.",
    ...(input.customerConfirmation !== undefined ? { customerConfirmation: input.customerConfirmation } : {}),
    ...(input.internalReview !== undefined ? { internalReview: input.internalReview } : {}),
  };
}

export function buildOperationDocument(input: BuildOperationDocumentInput): OperationDocument {
  const { candidate } = input;
  const productById = new Map(candidate.products.map((product) => [product.id, product]));
  const logoNameById = new Map(
    candidate.logos.flatMap((logo) => (logo.name !== undefined ? [[logo.id, logo.name] as const] : [])),
  );
  const assets = normalizeAssetBytes(input.assetBytes);
  const proof = candidate.configurations.map((configuration) =>
    buildProofConfiguration(configuration, productById, logoNameById, input, assets)
  );
  return {
    identity: buildIdentity(candidate, input),
    limitations: [
      "Illustrative diagrams, not to scale.",
      "Logo footprints only; artwork previews are illustrative customer-supplied artwork, never production colour proof.",
      "Product reference views are illustrative only; the dimensioned diagram is the source of truth.",
      // No blanket "product views are absent" claim: derivePhotoLimitations
      // below states the evidenced photo position (present/unmapped/mapped).
      // SKU, colour, thread and ticket data are not part of this document.
      "SKU, colour, thread and ticket data are out of scope for this document.",
      "Calibration and physical validation remain unresolved.",
      ...derivePhotoLimitations(proof, assets),
      "candidate-pending-review: local customer confirmation and internal review are workflow evidence, not production approval.",
    ],
    proof,
    configurations: candidate.configurations.map((configuration, index) =>
      buildOperationConfiguration(configuration, index, productById, input, assets)
    ),
    ...(candidate.instructions !== undefined ? { projectInstructions: candidate.instructions } : {}),
  };
}

/** Independent version of the one-sheet operational view contract. */
export const OPERATION_SHEET_VIEW_VERSION: OperationSheetViewVersion = "operation-sheet-view/1";

/**
 * Match a `DimensionBinding.logoRef` to one placement of a configuration:
 * a recorded placement `id` wins, otherwise `logoId` selects the first
 * placement of that logo, or `logoId#n` (0-based) selects the nth placement
 * of a repeated logo. Returns undefined when nothing matches.
 */
export function matchLogoRef(
  placements: readonly ExportPlacement[],
  logoRef: string,
): ExportPlacement | undefined {
  const byId = placements.find((placement) => placement.id === logoRef);
  if (byId !== undefined) return byId;
  const hash = logoRef.lastIndexOf("#");
  if (hash >= 0) {
    const logoId = logoRef.slice(0, hash);
    const occurrence = Number(logoRef.slice(hash + 1));
    if (logoId.length === 0 || !Number.isInteger(occurrence) || occurrence < 0) return undefined;
    return placements.filter((placement) => placement.logoId === logoId)[occurrence];
  }
  return placements.find((placement) => placement.logoId === logoRef);
}

function sheetSidesFor(
  configurationId: string,
  input: BuildOperationSheetViewInput,
): OperationSheetSide[] {
  const selections: readonly ReferenceViewInput[] = ownEntry(input.sides, configurationId) ?? [];
  return selections.map((selection) => ({
    view: selection.view,
    imagePath: selection.imagePath,
    ...(selection.label !== undefined && selection.label !== null ? { label: selection.label } : {}),
  }));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Caller-supplied extras for one logoRef; malformed extras are omitted, never guessed. */
function extrasForLogo(
  input: BuildOperationSheetViewInput,
  configurationId: string,
  logoRef: string,
): SheetLogoExtras | undefined {
  const perConfig = ownEntry(input.extras, configurationId);
  if (perConfig === undefined) return undefined;
  const raw = ownEntry(perConfig, logoRef);
  if (raw === undefined) return undefined;
  const out: SheetLogoExtras = {};
  if (raw.methodParams !== undefined && isStringRecord(raw.methodParams)) {
    out.methodParams = { ...raw.methodParams };
  }
  if (raw.colours !== undefined && isStringList(raw.colours)) {
    out.colours = [...raw.colours];
  }
  if (
    raw.businessCode !== undefined && typeof raw.businessCode === "string" &&
    raw.businessCode.length > 0
  ) {
    out.businessCode = raw.businessCode;
  }
  return out;
}

/**
 * Canonical logoRef for one placement: the recorded placement `id` when
 * present, otherwise `logoId`, or `logoId#n` for the nth placement of a
 * repeated logo within its configuration.
 */
function logoRefFor(
  placement: ExportPlacement,
  placements: readonly ExportPlacement[],
): string {
  if (placement.id !== undefined) return placement.id;
  const occurrence = placements
    .filter((entry) => entry.logoId === placement.logoId)
    .indexOf(placement);
  return occurrence <= 0 ? placement.logoId : `${placement.logoId}#${occurrence}`;
}

function buildSheetLogo(
  placement: ExportPlacement,
  placements: readonly ExportPlacement[],
  placementIndex: number,
  input: BuildOperationSheetViewInput,
  logoNameById: Map<string, string>,
  regionName: string | null,
): OperationSheetLogo {
  const configurationBindings: readonly DimensionBinding[] =
    ownEntry(input.bindings, placement.configurationId) ?? [];
  const logoRef = logoRefFor(placement, placements);
  const relevant = configurationBindings.filter((binding) =>
    matchLogoRef(placements, binding.logoRef) === placement
  );
  const measured = measurePlacement(input.candidate, placement, input.anchors, relevant);
  const dimensions = measured.dimensions.map((dimension) => ({
    label: dimension.label,
    valueMm: dimension.valueMm,
    valueMm1: formatMm1(dimension.valueMm),
    fromAnchor: dimension.fromAnchor,
    toEdge: dimension.toEdge,
    touchesArtwork: dimension.touchesArtwork,
    ...(dimension.artworkPoint !== undefined ? { artworkPoint: { ...dimension.artworkPoint } } : {}),
  }));
  const measuredText = dimensions.map((dimension) => `${dimension.valueMm1} mm \u2014 ${dimension.label}`);
  const unfinishedText =
    measured.unfinished.length > 0 ? `unfinished \u2014 ${measured.unfinished.join("; ")}` : null;
  const extras = extrasForLogo(input, placement.configurationId, logoRef);
  // Operator display identity (0-based placement order): the logo name, the
  // department-editable business code, or a positional fallback. The raw
  // customer logo id is never printed or exported here.
  const businessCode = extras?.businessCode;
  const logoName = logoNameById.get(placement.logoId);
  const displayName = logoName ?? businessCode ?? `Logo ${placementIndex + 1}`;
  const displayCode = businessCode ?? logoName ?? `Logo ${placementIndex + 1}`;
  const positionText = [...measuredText, ...(unfinishedText !== null ? [unfinishedText] : [])].join("; ") ||
    `unfinished \u2014 no anchor bindings supplied for ${displayName}`;
  return {
    logoName: displayName,
    logoCode: displayCode,
    side: regionName ?? placement.regionId,
    positionText,
    method: placement.method,
    widthMm: placement.widthMm,
    heightMm: placement.heightMm,
    rotationDeg: placement.rotationDeg,
    dimensions,
    unfinished: [...measured.unfinished],
    ...(extras?.methodParams !== undefined ? { methodParams: extras.methodParams } : {}),
    ...(extras?.colours !== undefined ? { colours: extras.colours } : {}),
  };
}

function buildOperationSheet(
  configuration: ExportConfiguration,
  input: BuildOperationSheetViewInput,
  logoNameById: Map<string, string>,
  regionNameFor: (productId: string, regionId: string) => string | null,
): OperationSheet {
  const logos = configuration.placements.map((placement, placementIndex) =>
    buildSheetLogo(
      placement,
      configuration.placements,
      placementIndex,
      input,
      logoNameById,
      regionNameFor(configuration.productId, placement.regionId),
    )
  );
  // `instructions` carries department-authored operational text ONLY.
  // Customer notes (per-placement and project-level) are carried separately
  // as `sourceNotes` context and never merged into operational instructions.
  const placementNotes: string[] = [];
  for (const placement of configuration.placements) {
    if (placement.instructions !== undefined) placementNotes.push(placement.instructions);
  }
  return {
    productId: configuration.productId,
    variantId: configuration.variantId,
    ...(configuration.productName !== undefined ? { productName: configuration.productName } : {}),
    ...(configuration.variantName !== undefined ? { variantName: configuration.variantName } : {}),
    sides: sheetSidesFor(configuration.id, input),
    logos,
    instructions: [...(input.operationalInstructions ?? [])],
    sourceNotes: {
      placement: placementNotes,
      ...(input.candidate.instructions !== undefined ? { project: input.candidate.instructions } : {}),
    },
  };
}

/**
 * Build the minimal human-facing one-sheet operational view: one sheet per
 * configured product/variant with reference sides, per-logo anchor
 * dimensions (exact millimetres plus display-rounded strings), department-
 * authored operational instructions, and separately-labelled customer
 * source notes (context only, never operational). Missing or stale
 * anchors/bindings yield explicit unfinished notes, never guessed positions.
 * Deterministic; pure.
 */
export function buildOperationSheetView(input: BuildOperationSheetViewInput): OperationSheetView {
  const { candidate } = input;
  const productById = new Map(candidate.products.map((product) => [product.id, product]));
  const logoNameById = new Map(
    candidate.logos.flatMap((logo) => (logo.name !== undefined ? [[logo.id, logo.name] as const] : [])),
  );
  const regionNameFor = (productId: string, regionId: string): string | null =>
    productById.get(productId)?.regions.find((region) => region.id === regionId)?.name ?? null;
  const job = input.job ?? {};
  return {
    version: OPERATION_SHEET_VIEW_VERSION,
    job: {
      ...(typeof job.customer === "string" && job.customer.length > 0 ? { customer: job.customer } : {}),
      ...(typeof job.reference === "string" && job.reference.length > 0 ? { reference: job.reference } : {}),
      ...(typeof job.article === "string" && job.article.length > 0 ? { article: job.article } : {}),
    },
    sheets: candidate.configurations.map((configuration) =>
      buildOperationSheet(configuration, input, logoNameById, regionNameFor)
    ),
  };
}
