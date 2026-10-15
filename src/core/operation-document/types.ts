/**
 * Operation-document view model.
 *
 * Pure structural description of what appears in the internal pending-review
 * operation document. Derived from a `ResultCandidate` snapshot; no DOM,
 * browser, or PDF dependencies.
 */

import type {
  ExportArtwork,
  ExportCalibration,
  ExportFrame,
  ResultCandidate,
} from "../types.js";

export interface OperationDocument {
  /** Document identity and review status. */
  identity: OperationIdentity;
  /** Human-readable limitations printed on every document. */
  limitations: string[];
  /** Per-configuration pages/sections. */
  configurations: OperationConfiguration[];
  /** Raw project instructions, if any. */
  projectInstructions?: string;
}

export interface OperationIdentity {
  projectId: string;
  revision: number;
  digest: string;
  schemaVersion: string;
  /** Optional ISO 8601 UTC timestamp; injected by caller, no default clock. */
  generatedAt?: string;
  /** Always candidate-pending-review in this bounded slice. */
  reviewStatus: string;
  /** Calibration/physical validation caveat. */
  calibrationStatus: string;
  /** Separate local customer confirmation evidence, if present. */
  customerConfirmation?: string;
  /** Separate local internal review evidence, if present. */
  internalReview?: string;
}

export interface OperationConfiguration {
  /** 0-based index used only for stable ordering; display uses 1-based. */
  index: number;
  id: string;
  productId: string;
  variantId: string;
  productName?: string;
  variantName?: string;
  placements: OperationPlacement[];
}

export interface OperationPlacement {
  /** 1-based placement number, consistent across tables and diagrams. */
  displayIndex: number;
  id?: string;
  configurationId: string;
  productId: string;
  variantId: string;
  logoId: string;
  regionId: string;
  method: string;
  pos: { xMm: number; yMm: number };
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
  instructions?: string;
  frame: ExportFrame;
  calibration: ExportCalibration;
  artwork: ExportArtwork;
  /** Pre-computed planar diagram data in frame millimetres. */
  diagram: PlacementDiagram;
}

export interface PlacementDiagram {
  /** SVG viewBox in frame millimetres. */
  viewBox: { minX: number; minY: number; width: number; height: number };
  /** Safe-region polygon in frame millimetres. Empty = unavailable. */
  safePolygon: Point2d[];
  /** Exclusion polygons in frame millimetres. */
  exclusions: DiagramExclusion[];
  /** Rotated artwork-bbox footprint corners in frame millimetres, clockwise. */
  footprint: Point2d[];
  /** Frame axes indicator in viewBox coordinates. */
  axes: DiagramAxes;
}

export interface DiagramExclusion {
  id: string;
  name: string;
  polygon: Point2d[];
}

export interface Point2d {
  x: number;
  y: number;
}

export interface DiagramAxes {
  originX: number;
  originY: number;
  xEndX: number;
  xEndY: number;
  yEndX: number;
  yEndY: number;
  xLabel: string;
  yLabel: string;
}

/** Input to the operation-document builder. */
export interface BuildOperationDocumentInput {
  candidate: ResultCandidate;
  /** Optional ISO timestamp; caller-supplied, no default clock. */
  generatedAt?: string;
  /** Optional local customer confirmation summary. */
  customerConfirmation?: string | undefined;
  /** Optional local internal review summary. */
  internalReview?: string | undefined;
}
