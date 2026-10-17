/**
 * Candidate export + internal workflow-approval check.
 *
 * - `buildCandidateExport(project, sha256Hex, options?)`: deterministic
 *   `ResultCandidate` with status `"candidate-pending-review"`. Every
 *   configuration appears (including zero-placement ones — flattened
 *   placement lists alone would lose the selection context of empty
 *   configurations). Each placement carries its product/variant/configuration
 *   ids, project/placement instructions, the explicit physical frame +
 *   measurement convention (`unit: "mm"`, bbox-center reference point,
 *   clockwise rotation), its calibration ref/version, and an artwork snapshot
 *   resolving the actual logo assets (not just an id). Product/logo
 *   snapshots are embedded so frames, calibrations and artwork resolve
 *   without external lookups. All output derives from the same validated
 *   project. Preview-only configurations (products with no regions and no
 *   calibrations) always export with zero placements; a placement somehow
 *   referencing them throws rather than emitting fictitious frame/calibration
 *   data. The candidate is the thing under review — and this export never produces production-ready
 *   output: only `"candidate-pending-review"` is supported.
 * - `serializeExport(candidate)`: canonical JSON text; byte-stable across
 *   runs for equal input.
 * - `hasCurrentInternalApproval(project, sha256Hex)`: true only when an
 *   internal `approved` review binds the exact current revision + operational
 *   content digest. This is an internal WORKFLOW bookkeeping state (someone
 *   recorded approval of the exact content) — never a physical or
 *   production-readiness check: calibration validity and physical
 *   feasibility are deferred and unresolved, so no function here claims
 *   production readiness.
 * - Customer confirmation alone never counts as internal approval.
 *
 */

import { canonicalize } from "./canonical.js";
import { checkResultContract } from "./contracts.js";
import { SCHEMA_VERSION } from "./types.js";
import type {
  ExportArtwork,
  ExportCalibration,
  ExportConfiguration,
  ExportFrame,
  ExportPlacement,
  ProjectDocument,
  ResultCandidate,
  Sha256HexFn,
} from "./types.js";
import { contentDigest } from "./content.js";
import { validateProject } from "./validate.js";

export interface CandidateExportOptions {
  /**
   * Desired result status. Only `"candidate-pending-review"` is supported;
   * any other value throws (production output is never produced by this
   * export; internal workflow approval is a separate review state, not a
   * production instruction).
   */
  requestedStatus?: string;
}

/** Deterministic candidate export for the current project content. */
export function buildCandidateExport(
  project: ProjectDocument,
  sha256Hex: Sha256HexFn,
  options?: CandidateExportOptions,
): ResultCandidate {
  const requested = options?.requestedStatus;
  if (requested !== undefined && requested !== "candidate-pending-review") {
    throw new Error(
      `unsupported export status "${requested}": only "candidate-pending-review" can be exported; ` +
        `internal workflow approval is a separate review state (see hasCurrentInternalApproval)`,
    );
  }
  // Preview-only guard BEFORE structural validation so the specific refusal
  // (never fictitious frames) stays reachable and tested: validation rejects
  // such placements too, but with a generic invalid-content wrapper.
  const previewProducts = new Map(project.products.map((entry) => [entry.id, entry]));
  for (const configuration of project.configurations) {
    const productEntry = previewProducts.get(configuration.productId);
    if (
      productEntry !== undefined &&
      productEntry.regions.length === 0 &&
      productEntry.calibrations.length === 0 &&
      configuration.placements.length > 0
    ) {
      throw new Error(
        `candidate export rejected placement on preview-only product "${productEntry.id}": preview-only products have no prepared regions, frames, or calibrations to export (refusing to emit fictitious measurement data)`,
      );
    }
  }
  const structural = validateProject(project);
  if (!structural.ok) {
    throw new Error(
      `candidate export rejected invalid content: ${structural.errors.map((e) => `${e.code}@${e.path}`).join(", ")}`,
    );
  }
  let digest: string;
  try {
    digest = contentDigest(project, sha256Hex);
  } catch (error) {
    throw new Error(
      `candidate export failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const productById = new Map(project.products.map((p) => [p.id, p]));
  const logoById = new Map(project.logos.map((l) => [l.id, l]));
  const configurations: ExportConfiguration[] = project.configurations.map(
    (configuration) => {
      const productEntry = productById.get(configuration.productId);
      if (productEntry === undefined) throw new Error("Export product reference no longer resolves");
      const regionById = new Map((productEntry?.regions ?? []).map((r) => [r.id, r]));
      const variantEntry = productEntry?.variants.find((v) => v.id === configuration.variantId);
      const placements: ExportPlacement[] = configuration.placements.map(
        (placement) => {
          const region = regionById.get(placement.regionId);
          const logo = logoById.get(placement.logoId);
          if (region === undefined || logo === undefined) throw new Error("Export region/artwork reference no longer resolves");
          const frame: ExportFrame = {
            frameId: region.frame.frameId,
            originDescription: region.frame.originDescription,
            axes: { ...region.frame.axes },
            unit: "mm",
            referencePoint: "artwork-bbox-center",
            rotationConvention: "clockwise-deg-facing-region",
          };
          const calibration: ExportCalibration = {
            calibrationId: region.calibrationRef.calibrationId,
            version: region.calibrationRef.version,
          };
          const artwork: ExportArtwork = {
            logoId: placement.logoId,
            ...(logo?.role !== undefined ? { role: logo.role } : {}),
            assets: (logo?.assets ?? []).map((asset) => ({ ...asset })),
          };
          return {
            ...(placement.id !== undefined ? { id: placement.id } : {}),
            configurationId: configuration.id,
            productId: configuration.productId,
            variantId: configuration.variantId,
            logoId: placement.logoId,
            regionId: placement.regionId,
            method: placement.method,
            pos: { xMm: placement.pos.xMm, yMm: placement.pos.yMm },
            widthMm: placement.widthMm,
            heightMm: placement.heightMm,
            rotationDeg: placement.rotationDeg,
            ...(placement.instructions !== undefined
              ? { instructions: placement.instructions }
              : {}),
            frame,
            calibration,
            artwork,
          };
        },
      );
      return {
        id: configuration.id,
        productId: configuration.productId,
        variantId: configuration.variantId,
        ...(productEntry?.name !== undefined ? { productName: productEntry.name } : {}),
        ...(variantEntry?.name !== undefined ? { variantName: variantEntry.name } : {}),
        placements,
      };
    },
  );
  const candidate: ResultCandidate = {
    schemaVersion: SCHEMA_VERSION,
    status: "candidate-pending-review",
    projectId: project.projectId,
    revision: project.revision,
    digest,
    ...(project.instructions !== undefined ? { instructions: project.instructions } : {}),
    products: project.products.map((p) => JSON.parse(JSON.stringify(p)) as typeof p),
    logos: project.logos.map((l) => JSON.parse(JSON.stringify(l)) as typeof l),
    configurations,
  };
  const contract = checkResultContract(candidate);
  if (contract.length > 0) {
    throw new Error(
      `candidate export failed its own result contract: ${contract.map((e) => `${e.code}@${e.path}`).join(", ")}`,
    );
  }
  return candidate;
}

/** Canonical serialization of a candidate export (byte-stable). */
export function serializeExport(candidate: ResultCandidate): string {
  return canonicalize(candidate);
}

/**
 * Internal workflow-approval state: an internal `approved` review binding the
 * exact current revision + operational content digest. Bookkeeping only —
 * never a physical or production-readiness check. Returns false for invalid
 * content or unusable hashers (approval cannot be established).
 */
export function hasCurrentInternalApproval(
  project: ProjectDocument,
  sha256Hex: Sha256HexFn,
): boolean {
  if (!validateProject(project).ok) return false;
  let current: string;
  try {
    current = contentDigest(project, sha256Hex);
  } catch {
    return false;
  }
  return hasCurrentInternalApprovalForDigest(project, current);
}

/** Approval check against a caller-supplied current digest (no hashing). */
function hasCurrentInternalApprovalForDigest(
  project: ProjectDocument,
  currentDigestHex: string,
): boolean {
  const review = project.review;
  if (review === undefined) return false;
  if (review.decision !== "approved") return false;
  if (review.revision !== project.revision) return false;
  return review.digest === currentDigestHex;
}
