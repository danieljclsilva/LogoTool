/**
 * Operator job persistence: versioned provisional sidecar for UI/job metadata.
 *
 * The `.logo-project` package carries the exact project geometry, original
 * assets and presentation/calibration sidecars. This module owns the bounded
 * additional-asset sidecar for the remaining UI/job metadata: job identity,
 * product/configuration inclusion, staff operational instructions, technique
 * settings, and measurement bindings. Bindings (and anchors) are bound to
 * exact project/config/placement/frame/calibration identities and are
 * recomputed on import, never trusted: `decodeJobPackage` re-runs
 * `markDependentMeasurementsUnresolved` against the packaged project, and
 * legacy files without the sidecar open with empty metadata (never invented
 * measurements).
 *
 * Dirty-transaction helpers wrap the pure project-editor add/update/remove
 * and instruction setters: one call is one logical transaction (a single
 * internal revision), and no-op edits stay no-ops (`dirty: false`, same
 * project reference).
 *
 * Pure: no React/Three.js/DOM/browser/providers/Node APIs. Deterministic,
 * versioned schemas.
 */

import { canonicalize } from "../canonical.js";
import { contentDigest } from "../content.js";
import {
  addPlacement as editorAddPlacement,
  removePlacement as editorRemovePlacement,
  setProjectInstructions as editorSetProjectInstructions,
  updatePlacement as editorUpdatePlacement,
  type PlacementSelector,
} from "../project-editor/index.js";
import type {
  Placement,
  ProjectDocument,
  Sha256HexFn,
} from "../types.js";
import type { SheetLogoExtras } from "../operation-document/types.js";
import type {
  AnchorDef,
  ArtworkEdge,
  DimensionBinding,
  MeasurementConvention,
} from "../operation-measurements/types.js";

/** Versioned provisional sidecar contract for operator job metadata. */
export const OPERATOR_JOB_VERSION = "operator-job/1" as const;
export type OperatorJobVersion = typeof OPERATOR_JOB_VERSION;

/** Numeric job-metadata contract generation; always 1 for `operator-job/1`. */
export const OPERATOR_JOB_NUMBER = 1 as const;

/** Additional-asset package path for the encoded job sidecar. */
export const OPERATOR_JOB_SIDECAR_PATH = "operator/job-metadata.json" as const;

export interface OperatorJobIdentity {
  customer?: string;
  jobReference?: string;
  preparedBy?: string;
}

/** Editable inclusion scope; unlisted products/configurations stay editable but are omitted from issue/document outputs. */
export interface JobInclusion {
  includedProducts: string[];
  includedConfigurations: string[];
  /**
   * Selected artwork ids (optional for backward compatibility with sidecars
   * written before logo selection persisted: absent reads as unselected).
   * The full artwork catalogue always travels with the job; this records
   * only the operator's selection, including selected-but-unused logos.
   */
  logoIds?: string[];
}

/** Resolution state of one persisted measurement binding. */
export type MeasurementBindingStatus = "bound" | "unresolved";

/**
 * Staff-chosen dimension binding with its exact scope identities. `logoRef`
 * follows the sheet convention (recorded placement `id`, else `logoId`, else
 * `logoId#n` for the nth placement of a repeated logo). `status` is
 * recomputed on import/scope change: anything whose scope no longer resolves
 * reads `unresolved` with a reason, never silently rebound.
 */
export interface JobMeasurementBinding {
  configurationId: string;
  productId: string;
  variantId: string;
  regionId: string;
  frameId: string;
  calibrationId: string;
  calibrationVersion: string;
  logoRef: string;
  anchorId: string;
  edge: ArtworkEdge;
  convention: MeasurementConvention;
  label: string;
  status: MeasurementBindingStatus;
  unresolvedReason?: string;
}

export interface OperatorJobMetadata {
  version: OperatorJobVersion;
  /** Numeric contract generation; always 1 for `operator-job/1`. */
  jobVersion: 1;
  /** Project revision this metadata was saved against (operational content). */
  sourceRevision: number;
  /** Operational content digest this metadata was saved against. */
  sourceDigest: string;
  identity: OperatorJobIdentity;
  inclusion: JobInclusion;
  /** Staff-authored operational text (customer notes are never merged here). */
  instructions: string;
  /** Per-logo technique settings. Key: configuration id -> logoRef -> extras. */
  techniqueSettings: Record<string, Record<string, SheetLogoExtras>>;
  /** Authored anchors in authoritative region-frame millimetres. */
  anchors: AnchorDef[];
  /** Staff-chosen measurement bindings for the job's sheets. */
  bindings: JobMeasurementBinding[];
  /** Optional free-text note about the latest local edit. */
  updatedNote?: string;
}

/** Create empty metadata: no identity, no inclusion, no measurements. */
export function createEmptyJobMetadata(): OperatorJobMetadata {
  return {
    version: OPERATOR_JOB_VERSION,
    jobVersion: OPERATOR_JOB_NUMBER,
    sourceRevision: 0,
    sourceDigest: "",
    identity: {},
    inclusion: { includedProducts: [], includedConfigurations: [], logoIds: [] },
    instructions: "",
    techniqueSettings: {},
    anchors: [],
    bindings: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEdge(value: unknown): value is ArtworkEdge {
  return value === "minX" || value === "maxX" || value === "minY" || value === "maxY";
}

function isConvention(value: unknown): value is MeasurementConvention {
  return value === "dx" || value === "dy" || value === "shortest-to-edge";
}

function isAnchor(value: unknown): value is AnchorDef {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["name"] === "string" &&
    typeof value["productId"] === "string" &&
    typeof value["variantId"] === "string" &&
    typeof value["regionId"] === "string" &&
    typeof value["frameId"] === "string" &&
    typeof value["calibrationId"] === "string" &&
    typeof value["calibrationVersion"] === "string" &&
    Array.isArray(value["posMm"])
  );
}

function isBinding(value: unknown): value is JobMeasurementBinding {
  if (!isRecord(value)) return false;
  const status = value["status"];
  if (status !== "bound" && status !== "unresolved") return false;
  if (value["unresolvedReason"] !== undefined && typeof value["unresolvedReason"] !== "string") {
    return false;
  }
  return (
    typeof value["configurationId"] === "string" &&
    typeof value["productId"] === "string" &&
    typeof value["variantId"] === "string" &&
    typeof value["regionId"] === "string" &&
    typeof value["frameId"] === "string" &&
    typeof value["calibrationId"] === "string" &&
    typeof value["calibrationVersion"] === "string" &&
    typeof value["logoRef"] === "string" &&
    typeof value["anchorId"] === "string" &&
    isEdge(value["edge"]) &&
    isConvention(value["convention"]) &&
    typeof value["label"] === "string"
  );
}

function isTechniqueSettings(value: unknown): value is OperatorJobMetadata["techniqueSettings"] {
  if (!isRecord(value)) return false;
  for (const perConfig of Object.values(value)) {
    if (!isRecord(perConfig)) return false;
    for (const extras of Object.values(perConfig)) {
      if (!isRecord(extras)) return false;
      if (extras["methodParams"] !== undefined) {
        if (!isRecord(extras["methodParams"])) return false;
        if (!Object.values(extras["methodParams"] as Record<string, unknown>).every((entry) => typeof entry === "string")) {
          return false;
        }
      }
      if (extras["colours"] !== undefined && !isStringList(extras["colours"])) return false;
      if (
        extras["businessCode"] !== undefined &&
        (typeof extras["businessCode"] !== "string" || (extras["businessCode"] as string).length === 0)
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Structural guard for a reopened job sidecar. Checks the versioned shape
 * only (never the source binding): a structurally valid sidecar can still be
 * stale for the current project — use `isStaleJobMetadata` for that. Never
 * throws; malformed input reads as absent.
 */
export function isOperatorJobMetadata(value: unknown): value is OperatorJobMetadata {
  if (!isRecord(value)) return false;
  if (value["version"] !== OPERATOR_JOB_VERSION) return false;
  if (value["jobVersion"] !== OPERATOR_JOB_NUMBER) return false;
  if (!Number.isSafeInteger(value["sourceRevision"])) return false;
  if (typeof value["sourceDigest"] !== "string") return false;
  const identity = value["identity"];
  if (!isRecord(identity)) return false;
  for (const key of ["customer", "jobReference", "preparedBy"] as const) {
    if (identity[key] !== undefined && typeof identity[key] !== "string") return false;
  }
  const inclusion = value["inclusion"];
  if (!isRecord(inclusion)) return false;
  if (!isStringList(inclusion["includedProducts"])) return false;
  if (!isStringList(inclusion["includedConfigurations"])) return false;
  if (inclusion["logoIds"] !== undefined && !isStringList(inclusion["logoIds"])) return false;
  if (typeof value["instructions"] !== "string") return false;
  if (!isTechniqueSettings(value["techniqueSettings"])) return false;
  if (!Array.isArray(value["anchors"]) || !(value["anchors"] as unknown[]).every(isAnchor)) {
    return false;
  }
  if (!Array.isArray(value["bindings"]) || !(value["bindings"] as unknown[]).every(isBinding)) {
    return false;
  }
  if (value["updatedNote"] !== undefined && typeof value["updatedNote"] !== "string") return false;
  return true;
}

/**
 * Staleness of saved metadata against the current operational content: stale
 * when structurally invalid (refuse, never rebuild from it) or when the
 * recorded source revision/digest no longer matches. Never throws.
 */
export function isStaleJobMetadata(
  metadata: unknown,
  projectDigest: string,
  projectRevision: number,
): boolean {
  if (!isOperatorJobMetadata(metadata)) return true;
  return metadata.sourceDigest !== projectDigest || metadata.sourceRevision !== projectRevision;
}

/**
 * Rebind metadata to the current project revision/digest (for Save job),
 * preserving identity, inclusion, instructions, technique settings, anchors
 * and bindings untouched. Caller should run
 * `markDependentMeasurementsUnresolved` first when scope may have changed.
 */
export function rebaseJobMetadata(
  metadata: OperatorJobMetadata,
  projectRevision: number,
  projectDigest: string,
): OperatorJobMetadata {
  const next = cloneMetadata(metadata);
  next.sourceRevision = projectRevision;
  next.sourceDigest = projectDigest;
  return next;
}

function cloneMetadata(metadata: OperatorJobMetadata): OperatorJobMetadata {
  return JSON.parse(JSON.stringify(metadata)) as OperatorJobMetadata;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Deterministic sidecar bytes (canonical JSON, UTF-8). Throws when the
 * metadata is structurally invalid — invalid metadata is never encoded.
 */
export function encodeJobSidecar(metadata: OperatorJobMetadata): Uint8Array {
  if (!isOperatorJobMetadata(metadata)) {
    throw new Error("encodeJobSidecar refuses structurally invalid job metadata");
  }
  return textEncoder.encode(canonicalize(cloneMetadata(metadata)));
}

/** Decode sidecar bytes; malformed input reads as absent (never throws). */
export function decodeJobSidecar(bytes: Uint8Array): OperatorJobMetadata | null {
  if (!(bytes instanceof Uint8Array)) return null;
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return isOperatorJobMetadata(parsed) ? parsed : null;
}

export interface JobPackageAsset {
  path: string;
  bytes: Uint8Array;
}

export interface EncodeJobPackageInput {
  /** Package assets by portable package path (referenced artwork/originals). */
  assets: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  /** Job metadata to persist as the versioned additional-asset sidecar. */
  metadata: OperatorJobMetadata;
  /** Other additional-asset sidecars to preserve (presentation, mappings). */
  extraSidecars?: readonly JobPackageAsset[];
}

export interface EncodedJobPackage {
  /** Referenced assets, deterministically sorted by path. */
  referencedAssets: JobPackageAsset[];
  /** Additional assets (job sidecar + preserved sidecars), sorted by path. */
  additionalAssets: JobPackageAsset[];
}

/**
 * Split package inputs into referenced/additional assets using the existing
 * deterministic conventions (sorted by path; duplicate/colliding paths
 * rejected, never silently overwritten). Returns the input shapes
 * `createProjectPackage` consumes; byte references are shared, inputs are
 * never mutated.
 */
export function encodeJobPackage(input: EncodeJobPackageInput): EncodedJobPackage {
  const entries: Array<[string, Uint8Array]> =
    input.assets instanceof Map ? [...input.assets] : Object.entries(input.assets);
  const referencedAssets: JobPackageAsset[] = entries
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  for (const asset of referencedAssets) {
    if (seen.has(asset.path)) {
      throw new Error(`job package refuses duplicate asset path "${asset.path}"`);
    }
    seen.add(asset.path);
  }
  const sidecarBytes = encodeJobSidecar(input.metadata);
  const additionalAssets: JobPackageAsset[] = [
    ...(input.extraSidecars ?? []).map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    { path: OPERATOR_JOB_SIDECAR_PATH, bytes: sidecarBytes },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const asset of additionalAssets) {
    if (seen.has(asset.path)) {
      throw new Error(`job package refuses colliding additional-asset path "${asset.path}"`);
    }
    seen.add(asset.path);
  }
  return { referencedAssets, additionalAssets };
}

export interface DecodeJobPackageInput {
  project: ProjectDocument;
  /** Raw bytes of `operator/job-metadata.json`, when the file carries one. */
  sidecarBytes?: Uint8Array;
  /**
   * Injected hasher for the stale-source check (same callback the domain
   * uses everywhere; core stays independent of node:crypto/SubtleCrypto).
   * Required whenever a sidecar is present; absent hasher with a present
   * sidecar yields an explicit warning instead of a trusted comparison.
   */
  sha256Hex?: Sha256HexFn;
}

export interface DecodedJobPackage {
  /**
   * Reopened metadata with bindings recomputed against `project`
   * (see `markDependentMeasurementsUnresolved`). Legacy files without the
   * sidecar yield empty metadata — never invented measurements.
   */
  metadata: OperatorJobMetadata;
  /** Human-readable notes: legacy absence, malformed sidecar, resolutions. */
  warnings: string[];
}

/**
 * Reopen job metadata for a packaged project. Missing sidecar (legacy files)
 * yields empty metadata with a warning; malformed sidecars likewise yield
 * empty metadata, never guessed measurements. Valid sidecars are recomputed
 * against the project so moved/removed scope reads unresolved.
 */
export function decodeJobPackage(input: DecodeJobPackageInput): DecodedJobPackage {
  if (input.sidecarBytes === undefined) {
    return {
      metadata: createEmptyJobMetadata(),
      warnings: [
        "legacy job file: no operator job sidecar present; opened with empty job metadata (no measurements invented)",
      ],
    };
  }
  const parsed = decodeJobSidecar(input.sidecarBytes);
  if (parsed === null) {
    return {
      metadata: createEmptyJobMetadata(),
      warnings: [
        "unreadable operator job sidecar: opened with empty job metadata (no measurements invented)",
      ],
    };
  }
  const { metadata, newlyUnresolved } = markDependentMeasurementsUnresolved(parsed, input.project);
  const warnings: string[] = [];
  if (typeof input.sha256Hex !== "function") {
    warnings.push(
      "job metadata source binding could not be verified (no hasher supplied); bindings were recomputed, not trusted",
    );
  } else {
    let currentDigest: string | null = null;
    try {
      currentDigest = contentDigest(input.project, input.sha256Hex);
    } catch {
      currentDigest = null;
    }
    if (currentDigest === null || isStaleJobMetadata(parsed, currentDigest, input.project.revision)) {
      warnings.push(
        "job metadata source revision/digest differs from the packaged project; bindings were recomputed, not trusted",
      );
    }
  }
  for (const reason of newlyUnresolved) {
    warnings.push(reason);
  }
  return { metadata, warnings };
}

/**
 * Match a binding `logoRef` to one placement of a configuration, mirroring
 * the sheet convention: a recorded placement `id` wins, otherwise `logoId`
 * selects the first placement of that logo, or `logoId#n` (0-based) selects
 * the nth placement of a repeated logo. Returns undefined when nothing
 * matches. Local reimplementation (same convention, no renderer import) so
 * this module stays independent of the operation-document renderer.
 */
function matchBindingPlacement(
  placements: readonly Placement[],
  logoRef: string,
): Placement | undefined {
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

export interface MarkUnresolvedResult {
  metadata: OperatorJobMetadata;
  /** Human reasons for bindings newly marked unresolved, in binding order. */
  newlyUnresolved: string[];
}

/**
 * Pure scope-recomputation for persisted bindings: any binding whose exact
 * configuration/product/variant/region/frame/calibration/placement/anchor
 * scope no longer resolves in `project` (plus `metadata.anchors`) is marked
 * `unresolved` with a reason, never rebound or dropped. Already-unresolved
 * bindings keep their recorded reason. The input metadata is never mutated.
 */
export function markDependentMeasurementsUnresolved(
  metadata: OperatorJobMetadata,
  project: ProjectDocument,
): MarkUnresolvedResult {
  const next = cloneMetadata(metadata);
  const newlyUnresolved: string[] = [];
  const configurationById = new Map(project.configurations.map((entry) => [entry.id, entry]));
  const productById = new Map(project.products.map((entry) => [entry.id, entry]));
  const anchorById = new Map(next.anchors.map((entry) => [entry.id, entry]));

  for (const binding of next.bindings) {
    if (binding.status === "unresolved") continue;
    const reason = resolveBinding(binding, configurationById, productById, anchorById);
    if (reason !== null) {
      binding.status = "unresolved";
      binding.unresolvedReason = reason;
      newlyUnresolved.push(`measurement "${binding.label}" unresolved: ${reason}`);
    } else if (binding.unresolvedReason !== undefined) {
      delete binding.unresolvedReason;
    }
  }
  return { metadata: next, newlyUnresolved };
}

function resolveBinding(
  binding: JobMeasurementBinding,
  configurationById: Map<string, ProjectDocument["configurations"][number]>,
  productById: Map<string, ProjectDocument["products"][number]>,
  anchorById: Map<string, AnchorDef>,
): string | null {
  const configuration = configurationById.get(binding.configurationId);
  if (configuration === undefined) {
    return `configuration "${binding.configurationId}" is no longer in the project`;
  }
  const product = productById.get(binding.productId);
  if (product === undefined || configuration.productId !== binding.productId) {
    return `product "${binding.productId}" is no longer in the project`;
  }
  if (!product.variants.some((entry) => entry.id === binding.variantId)) {
    return `variant "${binding.variantId}" is no longer on product "${binding.productId}"`;
  }
  const region = product.regions.find((entry) => entry.id === binding.regionId);
  if (region === undefined) {
    return `region "${binding.regionId}" is no longer on product "${binding.productId}"`;
  }
  if (region.frame.frameId !== binding.frameId) {
    return `frame of region "${binding.regionId}" changed (was "${binding.frameId}")`;
  }
  if (
    region.calibrationRef.calibrationId !== binding.calibrationId ||
    region.calibrationRef.version !== binding.calibrationVersion
  ) {
    return `calibration of region "${binding.regionId}" changed (was "${binding.calibrationId}@${binding.calibrationVersion}")`;
  }
  const placement = matchBindingPlacement(configuration.placements, binding.logoRef);
  if (placement === undefined) {
    return `placement "${binding.logoRef}" is no longer in configuration "${binding.configurationId}"`;
  }
  if (placement.regionId !== binding.regionId) {
    return `placement "${binding.logoRef}" moved to region "${placement.regionId}" (was "${binding.regionId}")`;
  }
  const anchor = anchorById.get(binding.anchorId);
  if (anchor === undefined) {
    return `anchor "${binding.anchorId}" is no longer authored`;
  }
  if (
    anchor.productId !== binding.productId ||
    anchor.variantId !== binding.variantId ||
    anchor.regionId !== binding.regionId ||
    anchor.frameId !== binding.frameId ||
    anchor.calibrationId !== binding.calibrationId ||
    anchor.calibrationVersion !== binding.calibrationVersion
  ) {
    return `anchor "${anchor.name}" scope no longer matches the recorded measurement scope`;
  }
  return null;
}

export interface DirtyTransaction<V> {
  /** Resulting project (same reference as input when nothing changed). */
  project: ProjectDocument;
  /** False for no-ops: no revision was created. */
  dirty: boolean;
  /** Transaction value (for removes: whether anything was removed). */
  value: V;
}

export type PlacementPatch = Partial<Omit<Placement, "id">>;

/**
 * One Apply/drag commit for a placement update: a single logical transaction
 * (exactly one revision when anything changed). No-op patches stay no-ops
 * (`dirty: false`, input reference preserved).
 */
export function applyPlacementUpdate(
  project: ProjectDocument,
  configurationId: string,
  selector: PlacementSelector,
  patch: PlacementPatch,
): DirtyTransaction<null> {
  const next = editorUpdatePlacement(project, configurationId, selector, patch);
  return { project: next, dirty: next !== project, value: null };
}

/** One Apply commit for adding a placement (always a single new revision). */
export function applyPlacementAdd(
  project: ProjectDocument,
  configurationId: string,
  placement: Placement,
): DirtyTransaction<null> {
  const next = editorAddPlacement(project, configurationId, placement);
  return { project: next, dirty: next !== project, value: null };
}

/**
 * One commit for removing a placement. An absent selector is a well-formed
 * no-op (`dirty: false`, input reference preserved).
 */
export function applyPlacementRemove(
  project: ProjectDocument,
  configurationId: string,
  selector: PlacementSelector,
): DirtyTransaction<boolean> {
  const before = project.configurations.find((entry) => entry.id === configurationId)
    ?.placements.length;
  const next = editorRemovePlacement(project, configurationId, selector);
  const after = next.configurations.find((entry) => entry.id === configurationId)
    ?.placements.length;
  return { project: next, dirty: next !== project, value: (after ?? 0) < (before ?? 0) };
}

/** One commit for staff instruction edits; unchanged text stays a no-op. */
export function applyInstructionsUpdate(
  project: ProjectDocument,
  instructions: string | undefined,
): DirtyTransaction<null> {
  const next = editorSetProjectInstructions(project, instructions);
  return { project: next, dirty: next !== project, value: null };
}

/**
 * Convert persisted job bindings to the sheet's per-configuration binding
 * inputs (`DimensionBinding`), keyed by configuration id. Only `bound`
 * bindings are included; unresolved ones are reported separately via
 * `markDependentMeasurementsUnresolved` and never silently measured.
 */
export function toSheetBindings(
  metadata: OperatorJobMetadata,
): Record<string, readonly DimensionBinding[]> {
  // Null-prototype container: configuration ids are file controlled and may
  // validly be `__proto__`/`constructor`/`toString` (same rule as the
  // session records that consume this output).
  const out: Record<string, DimensionBinding[]> = Object.create(null) as Record<
    string,
    DimensionBinding[]
  >;
  for (const binding of metadata.bindings) {
    if (binding.status !== "bound") continue;
    const entry: DimensionBinding = {
      logoRef: binding.logoRef,
      anchorId: binding.anchorId,
      edge: binding.edge,
      convention: binding.convention,
      label: binding.label,
    };
    const list = out[binding.configurationId];
    if (list === undefined) out[binding.configurationId] = [entry];
    else list.push(entry);
  }
  return out;
}

/** Re-export the hasher type for callers computing source digests. */
export type { Sha256HexFn } from "../types.js";
