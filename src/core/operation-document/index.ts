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
  DiagramAxes,
  DiagramExclusion,
  OperationArtworkAsset,
  OperationConfiguration,
  OperationDocument,
  OperationIdentity,
  OperationPlacement,
  OperationReferenceView,
  PlacementDiagram,
  Point2d,
  ReferenceViewInput,
} from "./types.js";

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

function rotatedFootprint(
  centreX: number,
  centreY: number,
  width: number,
  height: number,
  rotationDeg: number,
): Point2d[] {
  const halfW = width / 2;
  const halfH = height / 2;
  const corners: Point2d[] = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ];
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return corners.map((corner) => ({
    x: centreX + corner.x * cos + corner.y * sin,
    y: centreY - corner.x * sin + corner.y * cos,
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
  const assets = normalizeAssetBytes(input.assetBytes);
  return {
    identity: buildIdentity(candidate, input),
    limitations: [
      "Illustrative diagrams, not to scale.",
      "Logo footprints only; artwork previews are illustrative customer-supplied artwork, never production colour proof.",
      "Product reference views are illustrative only; the dimensioned diagram is the source of truth.",
      "Product views, SKU, colour, thread and ticket data are absent.",
      "Calibration and physical validation remain unresolved.",
      "candidate-pending-review: local customer confirmation and internal review are workflow evidence, not production approval.",
    ],
    configurations: candidate.configurations.map((configuration, index) =>
      buildOperationConfiguration(configuration, index, productById, input, assets)
    ),
    ...(candidate.instructions !== undefined ? { projectInstructions: candidate.instructions } : {}),
  };
}
