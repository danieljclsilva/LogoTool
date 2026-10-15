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
import type {
  BuildOperationDocumentInput,
  DiagramAxes,
  DiagramExclusion,
  OperationConfiguration,
  OperationDocument,
  OperationIdentity,
  OperationPlacement,
  PlacementDiagram,
  Point2d,
} from "./types.js";

const MARGIN_FACTOR = 0.12;
const MIN_SIZE = 50;
const AXES_LENGTH = 30;

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
  return { viewBox, safePolygon, exclusions, footprint, axes };
}

function buildOperationPlacement(
  placement: ExportPlacement,
  displayIndex: number,
  productById: Map<string, ProductDefinition>,
): OperationPlacement {
  const product = productById.get(placement.productId);
  const region = product?.regions.find((region) => region.id === placement.regionId);
  return {
    displayIndex,
    ...(placement.id !== undefined ? { id: placement.id } : {}),
    configurationId: placement.configurationId,
    productId: placement.productId,
    variantId: placement.variantId,
    logoId: placement.logoId,
    regionId: placement.regionId,
    method: placement.method,
    pos: { xMm: placement.pos.xMm, yMm: placement.pos.yMm },
    widthMm: placement.widthMm,
    heightMm: placement.heightMm,
    rotationDeg: placement.rotationDeg,
    ...(placement.instructions !== undefined ? { instructions: placement.instructions } : {}),
    frame: placement.frame,
    calibration: placement.calibration,
    artwork: placement.artwork,
    diagram: buildPlacementDiagram(placement, region),
  };
}

function buildOperationConfiguration(
  configuration: ExportConfiguration,
  index: number,
  productById: Map<string, ProductDefinition>,
): OperationConfiguration {
  return {
    index,
    id: configuration.id,
    productId: configuration.productId,
    variantId: configuration.variantId,
    ...(configuration.productName !== undefined ? { productName: configuration.productName } : {}),
    ...(configuration.variantName !== undefined ? { variantName: configuration.variantName } : {}),
    placements: configuration.placements.map((placement, placementIndex) =>
      buildOperationPlacement(placement, placementIndex + 1, productById)
    ),
  };
}

function buildIdentity(candidate: ResultCandidate, input: BuildOperationDocumentInput): OperationIdentity {
  return {
    projectId: candidate.projectId,
    revision: candidate.revision,
    digest: candidate.digest,
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
  return {
    identity: buildIdentity(candidate, input),
    limitations: [
      "Illustrative diagrams, not to scale.",
      "Logo footprints only; actual artwork rendering is unavailable.",
      "Product views, SKU, colour, thread and ticket data are absent.",
      "Calibration and physical validation remain unresolved.",
      "candidate-pending-review: local customer confirmation and internal review are workflow evidence, not production approval.",
    ],
    configurations: candidate.configurations.map((configuration, index) =>
      buildOperationConfiguration(configuration, index, productById)
    ),
    ...(candidate.instructions !== undefined ? { projectInstructions: candidate.instructions } : {}),
  };
}
