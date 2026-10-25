/**
 * Operator operation-sheet authoring contexts (spec section 8).
 *
 * Discriminated union separating the two provenance boundaries that feed the
 * SAME sheet renderer/export inputs:
 * - `operator`: the local direct path. Its candidate is recomputed with the
 *   existing `buildCandidateExport` on the current local project. This path
 *   MUST NOT call `importCustomerReturn` on the local project and MUST NOT
 *   fabricate return filenames or customer confirmation to satisfy UI.
 * - `customer-response`: wraps the genuine validated `importCustomerReturn`
 *   outcome as a separate provenance boundary (baseline digest/filenames,
 *   geometry verdict, carried confirmation). The only way to build one is to
 *   pass the real `ImportOutcome` from `importCustomerReturn`; stale or failed
 *   outcomes are rejected, never imported.
 *
 * Both contexts expose `sharedExportInputs`, returning the identical
 * `{ candidate, digest, referenceViews }` triple the sheet renderer and
 * operation export consume. Pure: no React/Three.js/DOM/browser/providers.
 */

import { buildCandidateExport } from "../export.js";
import { contentDigest } from "../content.js";
import { evaluateProjectGeometry } from "../project-editor/index.js";
import type {
  CustomerConfirmation,
  ImportOutcome,
  ProjectDocument,
  ResultCandidate,
  Sha256HexFn,
} from "../types.js";
import type { ReferenceViewInput } from "../operation-document/types.js";

/** Job identity shown on the operation sheet; all fields optional in setup. */
export interface AuthoringIdentity {
  customer?: string;
  jobReference?: string;
  preparedBy?: string;
}

/** Package assets by portable package path (referenced + additional). */
export type AuthoringAssets = ReadonlyMap<string, Uint8Array>;

/** Per-configuration reference selections. Key: configuration id. */
export type AuthoringReferenceViews = Record<string, readonly ReferenceViewInput[]>;

/** Local direct path: candidate recomputed from the current local project. */
export interface OperatorAuthoringContext {
  kind: "operator";
  /** Cloned snapshot of the current local project; never the live object. */
  project: ProjectDocument;
  /** Copied asset map; tiny synthetic entries in tests, never mutated. */
  assets: AuthoringAssets;
  /** Recomputed via `buildCandidateExport` on `project` (direct path). */
  candidate: ResultCandidate;
  /** Equals `candidate.digest` (the operational content digest). */
  digest: string;
  referenceViews: AuthoringReferenceViews;
  identity: AuthoringIdentity;
}

/**
 * Customer-response path: the validated import result as its own provenance
 * boundary. No field here is fabricated: the project/confirmation come from
 * the genuine `importCustomerReturn` outcome, the baseline digest is
 * recomputed from the issued baseline, and geometry is re-evaluated.
 */
export interface CustomerResponseAuthoringContext {
  kind: "customer-response";
  /** Cloned snapshot of the validated imported project. */
  project: ProjectDocument;
  assets: AuthoringAssets;
  /** Recomputed via `buildCandidateExport` on the imported project. */
  candidate: ResultCandidate;
  digest: string;
  referenceViews: AuthoringReferenceViews;
  identity: AuthoringIdentity;
  /** Recomputed operational digest of the issued baseline project. */
  baselineDigest: string;
  /** Byte-exact issued office-copy filename the response was checked against. */
  baselineFileName: string;
  /** Customer return filename that produced the validated import. */
  returnFileName: string;
  /** Re-evaluated footprint fit of the imported geometry (never assumed). */
  geometryOk: boolean;
  /**
   * Confirmation carried by the validated import, or null when the return
   * held none. Customer-supplied evidence only, never internal authority and
   * never fabricated by this module.
   */
  confirmation: CustomerConfirmation | null;
}

export type AuthoringContext =
  | OperatorAuthoringContext
  | CustomerResponseAuthoringContext;

/** Shared renderer/export inputs: identical shape for both context kinds. */
export interface SharedExportInputs {
  candidate: ResultCandidate;
  digest: string;
  referenceViews: AuthoringReferenceViews;
}

function cloneProject(project: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(project)) as ProjectDocument;
}

function copyAssets(
  assets: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array> | undefined,
): Map<string, Uint8Array> {
  if (assets === undefined) return new Map();
  if (assets instanceof Map) return new Map(assets);
  return new Map(Object.entries(assets));
}

function copyReferenceViews(
  referenceViews: AuthoringReferenceViews | undefined,
): AuthoringReferenceViews {
  if (referenceViews === undefined) return {};
  const out: Record<string, readonly ReferenceViewInput[]> = {};
  for (const [key, views] of Object.entries(referenceViews)) {
    out[key] = [...views];
  }
  return out;
}

function cleanIdentity(identity: AuthoringIdentity | undefined): AuthoringIdentity {
  if (identity === undefined) return {};
  const out: AuthoringIdentity = {};
  if (typeof identity.customer === "string" && identity.customer.length > 0) {
    out.customer = identity.customer;
  }
  if (typeof identity.jobReference === "string" && identity.jobReference.length > 0) {
    out.jobReference = identity.jobReference;
  }
  if (typeof identity.preparedBy === "string" && identity.preparedBy.length > 0) {
    out.preparedBy = identity.preparedBy;
  }
  return out;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`authoring context requires a non-empty ${field}`);
  }
  return value;
}

export interface CreateOperatorContextInput {
  project: ProjectDocument;
  assets?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  referenceViews?: AuthoringReferenceViews;
  identity?: AuthoringIdentity;
  sha256Hex: Sha256HexFn;
}

/**
 * Build the local direct authoring context. Recomputes the candidate with
 * `buildCandidateExport` on a snapshot of the local project. Never calls
 * `importCustomerReturn`, never populates return/confirmation fields.
 */
export function createOperatorAuthoringContext(
  input: CreateOperatorContextInput,
): OperatorAuthoringContext {
  if (typeof input?.sha256Hex !== "function") {
    throw new Error("createOperatorAuthoringContext requires a sha256Hex function");
  }
  const project = cloneProject(input.project);
  const candidate = buildCandidateExport(project, input.sha256Hex);
  return {
    kind: "operator",
    project,
    assets: copyAssets(input.assets),
    candidate,
    digest: candidate.digest,
    referenceViews: copyReferenceViews(input.referenceViews),
    identity: cleanIdentity(input.identity),
  };
}

export interface CreateCustomerResponseContextInput {
  /**
   * The genuine `importCustomerReturn` outcome. Only `{ ok: true }` outcomes
   * are accepted; anything else throws (a failed validation is never a
   * provenance boundary).
   */
  importOutcome: ImportOutcome;
  /** Trusted internally issued baseline the return was checked against. */
  issuedBaseline: ProjectDocument;
  baselineFileName: string;
  returnFileName: string;
  assets?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  referenceViews?: AuthoringReferenceViews;
  identity?: AuthoringIdentity;
  sha256Hex: Sha256HexFn;
}

/**
 * Build the customer-response authoring context from a genuine validated
 * import result. Recomputes the candidate, baseline digest and geometry
 * verdict from the supplied documents; carries (never invents) confirmation.
 */
export function createCustomerResponseAuthoringContext(
  input: CreateCustomerResponseContextInput,
): CustomerResponseAuthoringContext {
  if (typeof input?.sha256Hex !== "function") {
    throw new Error("createCustomerResponseAuthoringContext requires a sha256Hex function");
  }
  if (input.importOutcome === undefined || input.importOutcome.ok !== true) {
    throw new Error(
      "customer-response context requires a successful importCustomerReturn outcome (rejected returns are never imported)",
    );
  }
  const baselineFileName = requireNonEmptyString(input.baselineFileName, "baselineFileName");
  const returnFileName = requireNonEmptyString(input.returnFileName, "returnFileName");
  const project = cloneProject(input.importOutcome.project);
  const baselineDigest = contentDigest(cloneProject(input.issuedBaseline), input.sha256Hex);
  const candidate = buildCandidateExport(project, input.sha256Hex);
  let geometryOk = false;
  try {
    geometryOk = evaluateProjectGeometry(project).ok;
  } catch {
    geometryOk = false;
  }
  return {
    kind: "customer-response",
    project,
    assets: copyAssets(input.assets),
    candidate,
    digest: candidate.digest,
    referenceViews: copyReferenceViews(input.referenceViews),
    identity: cleanIdentity(input.identity),
    baselineDigest,
    baselineFileName,
    returnFileName,
    geometryOk,
    confirmation: project.confirmation === undefined
      ? null
      : JSON.parse(JSON.stringify(project.confirmation)) as CustomerConfirmation,
  };
}

/**
 * The identical `{ candidate, digest, referenceViews }` triple for both
 * context kinds: the single input shape the sheet renderer and operation
 * export consume regardless of provenance.
 */
export function sharedExportInputs(context: AuthoringContext): SharedExportInputs {
  return {
    candidate: context.candidate,
    digest: context.digest,
    referenceViews: context.referenceViews,
  };
}

/** Structural guard for reopened/unknown authoring context values. */
export function isAuthoringContext(value: unknown): value is AuthoringContext {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate["kind"] === "operator" || candidate["kind"] === "customer-response";
}
