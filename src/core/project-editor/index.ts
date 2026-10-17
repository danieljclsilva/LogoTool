/**
 * Immutable project editing and provisional geometry evaluation.
 * Structural/reference checks use `validateProject`; geometry is a separate
 * verdict so well-formed non-fitting drafts remain editable.
 * Preview-only products (no regions, no calibrations) cannot host placements:
 * `addPlacement`/`updatePlacement` reject such targets with
 * `preview-only-unprepared-region`.
 */
import { AREA_LIMITS } from "../region-areas/index.js";
import { footprintFits, type GeoPoint } from "../geometry/index.js";
import { PLACEMENT_LIMITS } from "../logo-placements/index.js";
import { newRevision } from "../revisions.js";
import type {
  CalibrationRef,
  Placement,
  PlacementPos,
  PointMm,
  ProjectDocument,
  Region,
  RegionFrame,
} from "../types.js";

/** Runtime processing bounds only; never product or manufacturing limits. */
export const PROJECT_EDITOR_LIMITS = {
  maxProducts: 128,
  maxConfigurations: 128,
  maxVariants: 512,
  maxRegions: 128,
  maxPlacements: PLACEMENT_LIMITS.maxPlacements,
  maxLogos: PLACEMENT_LIMITS.maxLogos,
  maxVerticesPerRing: AREA_LIMITS.MAX_VERTICES,
  maxExclusionsPerRegion: AREA_LIMITS.MAX_EXCLUSIONS_PER_REGION,
  maxTotalVertices: 65_536,
  maxGeometryWork: 8_000_000,
  maxCoordinateMm: PLACEMENT_LIMITS.maxCoordMm,
  maxDimensionMm: PLACEMENT_LIMITS.maxDimMm,
} as const;

/** A tagged selector keeps arbitrary schema IDs distinct from id-less indexes. */
export type PlacementSelector =
  | { kind: "id"; id: string }
  | { kind: "index"; index: number };

export interface PlacementGeometryResult {
  configurationId: string;
  placementIndex: number;
  /** Present only when the placement carries a schema ID. */
  placementId?: string;
  ok: boolean;
  reason: string;
  footprint: PointMm[];
  frame: RegionFrame;
  calibration: CalibrationRef;
  centerMm: PlacementPos;
}

export interface ProjectGeometryResult {
  /** True only when every placement footprint fits its safe area and exclusions. */
  ok: boolean;
  placements: PlacementGeometryResult[];
}

export function placementSelector(placement: Placement, index: number): PlacementSelector {
  return placement.id === undefined ? { kind: "index", index } : { kind: "id", id: placement.id };
}

function placementIndex(placements: Placement[], selector: PlacementSelector): number {
  if (selector.kind === "id") return placements.findIndex((entry) => entry.id === selector.id);
  return Number.isSafeInteger(selector.index) && selector.index >= 0 &&
    placements[selector.index]?.id === undefined ? selector.index : -1;
}

function placementLabel(placement: Placement, index: number): string {
  return placement.id ?? `placement ${index + 1}`;
}

function requireConfiguration(project: ProjectDocument, configurationId: string) {
  const configuration = project.configurations.find((entry) => entry.id === configurationId);
  if (configuration === undefined) throw new Error(`unknown configuration "${configurationId}"`);
  return configuration;
}

/**
 * Structural preview-only check (mirrors the provisional-product contract):
 * a product with no regions and no calibrations has no prepared area, so no
 * placement may target it. Never name-substring heuristics.
 */
function isPreviewOnlyTarget(project: ProjectDocument, configurationId: string): boolean {
  const configuration = project.configurations.find((entry) => entry.id === configurationId);
  const product = project.products.find((entry) => entry.id === configuration?.productId);
  return (
    configuration !== undefined &&
    product !== undefined &&
    product.regions.length === 0 &&
    product.calibrations.length === 0
  );
}

function rejectPreviewOnlyTarget(project: ProjectDocument, configurationId: string, action: string): void {
  if (isPreviewOnlyTarget(project, configurationId)) {
    throw new Error(
      `preview-only-unprepared-region: cannot ${action} placement in configuration "${configurationId}": ` +
        `its product has no prepared regions (preview-only products cannot host placements)`,
    );
  }
}

function assertRingWithinLimits(ring: PointMm[], label: string): number {
  if (!Array.isArray(ring) || ring.length > PROJECT_EDITOR_LIMITS.maxVerticesPerRing) {
    throw new Error(`${label} exceeds the ${PROJECT_EDITOR_LIMITS.maxVerticesPerRing}-vertex project-editor limit`);
  }
  for (const point of ring) {
    if (!Array.isArray(point) || point.length !== 2 ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
        Math.abs(point[0]) > PROJECT_EDITOR_LIMITS.maxCoordinateMm ||
        Math.abs(point[1]) > PROJECT_EDITOR_LIMITS.maxCoordinateMm) {
      throw new Error(`${label} contains coordinates outside finite ±${PROJECT_EDITOR_LIMITS.maxCoordinateMm} mm runtime bounds`);
    }
  }
  return ring.length;
}

function assertRegionWithinLimits(region: Region, label: string): number {
  const exclusions = region.exclusions ?? [];
  if (exclusions.length > PROJECT_EDITOR_LIMITS.maxExclusionsPerRegion) {
    throw new Error(`${label} exceeds the ${PROJECT_EDITOR_LIMITS.maxExclusionsPerRegion}-exclusion runtime limit`);
  }
  let vertices = assertRingWithinLimits(region.safeArea, `${label} safe area`);
  for (let index = 0; index < exclusions.length; index += 1) {
    vertices += assertRingWithinLimits(exclusions[index]!, `${label} exclusion ${index + 1}`);
  }
  return vertices;
}

/** Reject work outside explicit engineering budgets before polygon-kernel calls. */
export function assertProjectEditorLimits(project: ProjectDocument): void {
  if (project.products.length > PROJECT_EDITOR_LIMITS.maxProducts) throw new Error(`project exceeds ${PROJECT_EDITOR_LIMITS.maxProducts} products`);
  if (project.configurations.length > PROJECT_EDITOR_LIMITS.maxConfigurations) throw new Error(`project exceeds ${PROJECT_EDITOR_LIMITS.maxConfigurations} configurations`);
  if (project.logos.length > PROJECT_EDITOR_LIMITS.maxLogos) throw new Error(`project exceeds ${PROJECT_EDITOR_LIMITS.maxLogos} logos`);

  let variants = 0;
  let regions = 0;
  let vertices = 0;
  for (const product of project.products) {
    variants += product.variants.length;
    if (variants > PROJECT_EDITOR_LIMITS.maxVariants) throw new Error(`project exceeds ${PROJECT_EDITOR_LIMITS.maxVariants} variants`);
    for (const region of product.regions) {
      regions += 1;
      if (regions > PROJECT_EDITOR_LIMITS.maxRegions) throw new Error(`project exceeds ${PROJECT_EDITOR_LIMITS.maxRegions} regions`);
      vertices += assertRegionWithinLimits(region, `region ${region.id}`);
      if (vertices > PROJECT_EDITOR_LIMITS.maxTotalVertices) throw new Error(`project exceeds ${PROJECT_EDITOR_LIMITS.maxTotalVertices} total safe/exclusion vertices`);
    }
  }

  // Ring validation is quadratic and repeated for each footprint. Count bounds
  // alone permit impractical work; reject the combined workload before the kernel.
  const regionWork = new Map(project.products.map((product) => [product.id,
    new Map(product.regions.map((region) => {
      const count = region.safeArea.length + (region.exclusions ?? []).reduce((sum, ring) => sum + ring.length, 0);
      return [region.id, count * count] as const;
    })),
  ]));
  let geometryWork = 0;
  let placements = 0;
  for (const configuration of project.configurations) {
    placements += configuration.placements.length;
    if (placements > PROJECT_EDITOR_LIMITS.maxPlacements) throw new Error(`project exceeds ${PROJECT_EDITOR_LIMITS.maxPlacements} placements`);
    for (const placement of configuration.placements) {
      geometryWork += regionWork.get(configuration.productId)?.get(placement.regionId) ?? 0;
      if (geometryWork > PROJECT_EDITOR_LIMITS.maxGeometryWork) throw new Error('project exceeds the combined geometry-work runtime budget');
      const values = [placement.pos.xMm, placement.pos.yMm, placement.widthMm, placement.heightMm, placement.rotationDeg];
      if (values.some((value) => !Number.isFinite(value)) ||
          Math.abs(placement.pos.xMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm ||
          Math.abs(placement.pos.yMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm ||
          Math.abs(placement.widthMm) > PROJECT_EDITOR_LIMITS.maxDimensionMm ||
          Math.abs(placement.heightMm) > PROJECT_EDITOR_LIMITS.maxDimensionMm) {
        throw new Error(`placement ${placement.id ?? "(id-less)"} exceeds finite geometry runtime bounds`);
      }
    }
  }
}

function samePatchValue(placement: Placement, key: keyof Omit<Placement, "id">, value: unknown): boolean {
  if (key === "pos") {
    const pos = value as PlacementPos | undefined;
    return pos !== undefined && placement.pos.xMm === pos.xMm && placement.pos.yMm === pos.yMm;
  }
  return placement[key] === value;
}

function revisionWithinLimits(project: ProjectDocument, mutator: (draft: ProjectDocument) => void): ProjectDocument {
  const next = newRevision(project, mutator);
  assertProjectEditorLimits(next);
  return next;
}

/** Add an editable placement; geometric fit is intentionally not a save constraint. */
export function addPlacement(
  project: ProjectDocument,
  configurationId: string,
  placement: Placement,
): ProjectDocument {
  assertProjectEditorLimits(project);
  requireConfiguration(project, configurationId);
  rejectPreviewOnlyTarget(project, configurationId, "add");
  const added: Placement = { ...placement, pos: { ...placement.pos } };
  return revisionWithinLimits(project, (draft) => {
    const configuration = draft.configurations.find((entry) => entry.id === configurationId)!;
    configuration.placements.push(added);
  });
}

/** Update a placement addressed by an unambiguous tagged selector. */
export function updatePlacement(
  project: ProjectDocument,
  configurationId: string,
  selector: PlacementSelector,
  patch: Partial<Omit<Placement, "id">>,
): ProjectDocument {
  assertProjectEditorLimits(project);
  const configuration = requireConfiguration(project, configurationId);
  rejectPreviewOnlyTarget(project, configurationId, "update");
  const currentIndex = placementIndex(configuration.placements, selector);
  const current = configuration.placements[currentIndex];
  if (current === undefined) throw new Error(`unknown placement selector in configuration "${configurationId}"`);
  const keys = Object.keys(patch) as Array<keyof Omit<Placement, "id">>;
  if (keys.every((key) => samePatchValue(current, key, patch[key]))) return project;

  return revisionWithinLimits(project, (draft) => {
    const targetConfiguration = draft.configurations.find((entry) => entry.id === configurationId)!;
    const target = targetConfiguration.placements[placementIndex(targetConfiguration.placements, selector)]!;
    for (const key of keys) {
      const value = patch[key];
      if (key === "instructions" && value === undefined) {
        delete target.instructions;
      } else if (key === "pos" && value !== undefined) {
        target.pos = { ...(value as PlacementPos) };
      } else {
        (target as unknown as Record<string, unknown>)[key] = value;
      }
    }
  });
}

/** Remove a placement; a well-formed absent selector is a no-op. */
export function removePlacement(
  project: ProjectDocument,
  configurationId: string,
  selector: PlacementSelector,
): ProjectDocument {
  assertProjectEditorLimits(project);
  const configuration = requireConfiguration(project, configurationId);
  const index = placementIndex(configuration.placements, selector);
  if (index < 0) return project;

  return revisionWithinLimits(project, (draft) => {
    const targetConfiguration = draft.configurations.find((entry) => entry.id === configurationId)!;
    targetConfiguration.placements.splice(placementIndex(targetConfiguration.placements, selector), 1);
  });
}

/** Set or clear project-level customer instructions. */
export function setProjectInstructions(
  project: ProjectDocument,
  instructions: string | undefined,
): ProjectDocument {
  assertProjectEditorLimits(project);
  if (project.instructions === instructions) return project;
  return revisionWithinLimits(project, (draft) => {
    if (instructions === undefined) delete draft.instructions;
    else draft.instructions = instructions;
  });
}

function rotatedFootprint(placement: Placement): PointMm[] {
  const theta = (placement.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const halfWidth = placement.widthMm / 2;
  const halfHeight = placement.heightMm / 2;
  const offsets: PointMm[] = [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ];
  return offsets.map(([dx, dy]): PointMm => [
    placement.pos.xMm + dx * cos + dy * sin,
    placement.pos.yMm - dx * sin + dy * cos,
  ]);
}

export interface PlacementGeometryVerdict {
  ok: boolean;
  reason: string;
  footprint: PointMm[];
}

function calculatePlacementGeometry(region: Region, placement: Placement): PlacementGeometryVerdict {
  if (
    !Number.isFinite(placement.pos.xMm) ||
    !Number.isFinite(placement.pos.yMm) ||
    !Number.isFinite(placement.widthMm) ||
    !Number.isFinite(placement.heightMm) ||
    !Number.isFinite(placement.rotationDeg) ||
    placement.widthMm <= 0 ||
    placement.heightMm <= 0
  ) {
    return { ok: false, reason: "placement geometry requires finite center, positive dimensions, and finite rotation", footprint: [] };
  }
  if (
    Math.abs(placement.pos.xMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm ||
    Math.abs(placement.pos.yMm) > PROJECT_EDITOR_LIMITS.maxCoordinateMm ||
    placement.widthMm > PROJECT_EDITOR_LIMITS.maxDimensionMm ||
    placement.heightMm > PROJECT_EDITOR_LIMITS.maxDimensionMm
  ) {
    throw new Error("placement exceeds project-editor geometry runtime bounds");
  }
  const footprint = rotatedFootprint(placement);
  if (footprint.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    return { ok: false, reason: "placement geometry produced a non-finite footprint", footprint: [] };
  }
  const footprintPoints: GeoPoint[] = footprint.map(([x, y]) => ({ x, y }));
  const safe: GeoPoint[] = region.safeArea.map(([x, y]) => ({ x, y }));
  const exclusions: GeoPoint[][] = (region.exclusions ?? []).map((polygon) =>
    polygon.map(([x, y]) => ({ x, y })),
  );
  const verdict = footprintFits({ safe, exclusions, footprint: footprintPoints });
  return { ok: verdict.fits, reason: verdict.reason, footprint };
}

/** Evaluate one footprint for drag feedback after its containing project passed limits. */
export function evaluatePlacementGeometry(region: Region, placement: Placement): PlacementGeometryVerdict {
  assertRegionWithinLimits(region, `region ${region.id}`);
  return calculatePlacementGeometry(region, placement);
}

/**
 * Evaluate every rotated placement against its region. This reports geometric
 * fit only; structural references and method eligibility use `validateProject`.
 */
export function evaluateProjectGeometry(project: ProjectDocument): ProjectGeometryResult {
  assertProjectEditorLimits(project);
  const products = new Map(project.products.map((product) => [product.id, product]));
  const results: PlacementGeometryResult[] = [];

  for (const configuration of project.configurations) {
    const product = products.get(configuration.productId);
    if (product === undefined) {
      throw new Error(`cannot evaluate geometry: configuration "${configuration.id}" has no product definition`);
    }
    for (const [placementIndex, placement] of configuration.placements.entries()) {
      const region = product.regions.find((entry) => entry.id === placement.regionId);
      if (region === undefined) {
        throw new Error(`cannot evaluate geometry: placement "${placementLabel(placement, placementIndex)}" has no region definition (preview-only products have no prepared regions)`);
      }
      const verdict = calculatePlacementGeometry(region, placement);
      results.push({
        configurationId: configuration.id,
        placementIndex,
        ...(placement.id === undefined ? {} : { placementId: placement.id }),
        ok: verdict.ok,
        reason: verdict.reason,
        footprint: verdict.footprint,
        frame: { ...region.frame, axes: { ...region.frame.axes } },
        calibration: { ...region.calibrationRef },
        centerMm: { ...placement.pos },
      });
    }
  }

  return { ok: results.every((result) => result.ok), placements: results };
}
