/**
 * Internal review + issued-baseline tamper checks + customer-return import.
 *
 * - `recordInternalReview(project, input, sha256Hex)`: records a separate
 *   internal review decision for the exact current revision + operational
 *   content digest. The project must first be structurally/semantically
 *   valid; review of invalid content is rejected even when the digest
 *   matches. Customer confirmation never counts as internal approval.
 * - `checkAgainstBaseline(returned, issued)`: compares a returned project
 *   against the internally issued baseline (products AND logos). Duplicate
 *   or malformed ids are rejected (never silently overwritten via Map).
 *   Defensive over unknown input: malformed sides yield errors, never throw.
 * - `importCustomerReturn(returned, issued, sha256Hex)`: the explicit
 *   internal import boundary. Validates structure + semantics, checks the
 *   confirmation digest against the CURRENT returned content, compares the
 *   baseline (identity + product/logo definitions), and NEVER trusts the
 *   returned review/approved status or reviewHistory as internal authority:
 *   on success the current internal review is cleared (pending re-review)
 *   and only the trusted internal history from the issued baseline is
 *   preserved. Customer confirmation survives only when its exact
 *   revision+digest matches the returned content (customer-supplied,
 *   unverified identity evidence); stale confirmation is rejected with a
 *   coded error. Merely validating or copying an embedded approved customer
 *   review never results in internal authorization.
 */

import { isRecord } from "./guards.js";
import { canonicalize } from "./canonical.js";
import { checkProjectContract } from "./contracts.js";
import { contentDigest } from "./content.js";
import { DIGEST_HEX_PATTERN, REVIEW_DECISIONS } from "./types.js";
import type {
  CustomerConfirmation,
  CustomerReturnInput,
  ImportOutcome,
  InternalReview,
  LogoDefinition,
  ProductDefinition,
  ProjectDocument,
  ReviewDecision,
  Sha256HexFn,
  ValidationError,
  ValidationResult,
} from "./types.js";
import { validateProject } from "./validate.js";
export interface ReviewInput {
  decision: ReviewDecision;
  reviewer: string;
  /** Digest the reviewer approved; must equal the current content digest. */
  digestOf: string;
  note?: string;
  at?: string;
}

export type ReviewOutcome =
  | { ok: true; project: ProjectDocument }
  | { ok: false; errors: ValidationError[] };


/** Record a separate internal review decision for the current revision. */
export function recordInternalReview(
  project: ProjectDocument,
  input: ReviewInput,
  sha256Hex: Sha256HexFn,
): ReviewOutcome {
  const errors: ValidationError[] = [];
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      errors: [{ code: "bad-shape", path: "input", message: "review input must be an object" }],
    };
  }
  if (
    typeof input.decision !== "string" ||
    (REVIEW_DECISIONS as readonly string[]).indexOf(input.decision) < 0
  ) {
    errors.push({
      code: "bad-decision",
      path: "decision",
      message: "decision must be one of pending|approved|changesRequested",
    });
  }
  if (typeof input.reviewer !== "string" || input.reviewer.length === 0) {
    errors.push({
      code: "bad-shape",
      path: "reviewer",
      message: "reviewer must be a non-empty string",
    });
  }
  if (
    typeof input.digestOf !== "string" ||
    !DIGEST_HEX_PATTERN.test(input.digestOf)
  ) {
    errors.push({
      code: "bad-digest",
      path: "digestOf",
      message: "digestOf must be lowercase SHA-256 hex ([0-9a-f]{64})",
    });
  }
  if (input.note !== undefined && typeof input.note !== "string") {
    errors.push({ code: "bad-shape", path: "note", message: "note must be a string" });
  }
  if (
    input.at !== undefined &&
    (typeof input.at !== "string" || input.at.length === 0)
  ) {
    errors.push({ code: "bad-shape", path: "at", message: "at must be a non-empty string" });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const structural = validateProject(project);
  if (!structural.ok) {
    return {
      ok: false,
      errors: [
        {
          code: "invalid-content",
          path: "project",
          message: `cannot review invalid content: ${structural.errors.map((e) => `${e.code}@${e.path}`).join(", ")}`,
        },
      ],
    };
  }
  let current: string;
  try {
    current = contentDigest(project, sha256Hex);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: "bad-hasher",
          path: "sha256Hex",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  if (input.digestOf !== current) {
    return {
      ok: false,
      errors: [
        {
          code: "digest-mismatch",
          path: "digestOf",
          message:
            "review digest does not match the current operational content; review the exact content before deciding",
        },
      ],
    };
  }
  if (project.review !== undefined) {
    const reviewHistory: InternalReview[] = Array.isArray(project.reviewHistory)
      ? [...project.reviewHistory]
      : [];
    reviewHistory.push(project.review);
    project.reviewHistory = reviewHistory;
  }
  project.review = {
    revision: project.revision,
    digest: input.digestOf,
    decision: input.decision,
    reviewer: input.reviewer,
    at: input.at ?? new Date().toISOString(),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  return { ok: true, project };
}

function collectIds(
  entries: unknown,
  path: string,
  errors: ValidationError[],
  what: string,
): { byId: Map<string, unknown>; ok: boolean } {
  const byId = new Map<string, unknown>();
  let ok = true;
  if (!Array.isArray(entries)) {
    errors.push({
      code: "bad-shape",
      path,
      message: `baseline comparison needs a ${what} array on both sides`,
    });
    return { byId, ok: false };
  }
  entries.forEach((entry: unknown, i: number) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"].length === 0) {
      errors.push({
        code: "bad-shape",
        path: `${path}[${i}]`,
        message: `baseline ${what} entry must be an object with a non-empty string id`,
      });
      ok = false;
      return;
    }
    const id = entry["id"];
    if (byId.has(id)) {
      errors.push({
        code: "duplicate-id",
        path: `${path}[${i}]`,
        message: `baseline ${what} has a duplicate id "${id}" (never silently overwritten)`,
      });
      ok = false;
      return;
    }
    byId.set(id, entry);
  });
  return { byId, ok };
}

/**
 * Compare a returned project against the internally issued baseline.
 * Covers identity plus products AND logos. Duplicate/malformed ids are
 * rejected instead of being silently overwritten. Defensive over unknown
 * input: malformed sides yield errors, never throws.
 */
export function checkAgainstBaseline(
  returned: unknown,
  issued: unknown,
): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isRecord(returned)) {
    errors.push({ code: "bad-shape", path: "returned", message: "returned project must be an object" });
    return { ok: false, errors };
  }
  if (!isRecord(issued)) {
    errors.push({ code: "bad-shape", path: "issued", message: "issued baseline must be an object" });
    return { ok: false, errors };
  }
  if (typeof returned["projectId"] !== "string" || typeof issued["projectId"] !== "string") {
    errors.push({ code: "bad-shape", path: "projectId", message: "both sides need a projectId string" });
    return { ok: false, errors };
  }
  if (returned["projectId"] !== issued["projectId"]) {
    errors.push({
      code: "baseline-project-mismatch",
      path: "projectId",
      message: `returned projectId "${returned["projectId"] as string}" does not match issued baseline "${issued["projectId"] as string}"`,
    });
  }
  for (const key of ["products", "logos"] as const) {
    const back = collectIds(returned[key], `returned.${key}`, errors, key);
    const front = collectIds(issued[key], `issued.${key}`, errors, key);
    if (!back.ok || !front.ok) {
      continue;
    }
    for (const [id, entry] of back.byId) {
      const original = front.byId.get(id);
      if (original === undefined) {
        errors.push({
          code: "baseline-tamper",
          path: `returned.${key}`,
          message: `returned ${key === "products" ? "product" : "logo"} "${id}" is not in the issued baseline`,
        });
      } else {
        let same = false;
        try {
          same = canonicalize(entry) === canonicalize(original);
        } catch {
          errors.push({
            code: "bad-shape",
            path: `returned.${key}`,
            message: `returned ${key === "products" ? "product" : "logo"} "${id}" holds non-JSON data and cannot be compared`,
          });
          continue;
        }
        if (!same) {
          errors.push({
            code: "baseline-tamper",
            path: `returned.${key}`,
            message:
              `returned ${key === "products" ? "product" : "logo"} "${id}" definition differs from the issued baseline ` +
              `(product/logo/variant/region/calibration/method definitions must be equal; only configurations/instructions/confirmation/history may differ)`,
          });
        }
      }
    }
    for (const id of front.byId.keys()) {
      if (!back.byId.has(id)) {
        errors.push({
          code: "baseline-tamper",
          path: `returned.${key}`,
          message: `issued ${key === "products" ? "product" : "logo"} "${id}" is missing from the returned project`,
        });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}


/**
 * Internal import boundary for a customer-returned project.
 *
 * 1. Structural contract (real JSON Schema) + semantic validation of the
 *    returned document; malformed content is rejected, never imported.
 * 2. Project identity must match the issued baseline.
 * 3. Product AND logo definitions must equal the baseline (tamper rejected).
 * 4. The embedded customer confirmation must bind the exact current
 *    revision + operational content digest; stale confirmation is rejected
 *    with `stale-confirmation`. Confirmation survives as customer-supplied,
 *    unverified identity evidence only — never authenticated identity.
 * 5. The returned `review` / `reviewHistory` are NEVER trusted as internal
 *    authority: the current review is cleared and only the trusted internal
 *    history from the issued baseline is preserved. A customer injecting a
 *    current `approved` review with a correct digest still imports with NO
 *    internal review — importing never confers approval.
 */
export function importCustomerReturn(
  returned: unknown,
  issued: CustomerReturnInput,
  sha256Hex: Sha256HexFn,
): ImportOutcome {
  const errors: ValidationError[] = [];
  if (!isRecord(returned)) {
    return {
      ok: false,
      errors: [{ code: "bad-shape", path: "returned", message: "returned project must be an object" }],
    };
  }
  errors.push(...checkProjectContract(returned));
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const semantic = validateProject(returned);
  if (!semantic.ok) {
    return { ok: false, errors: semantic.errors };
  }
  const project = returned as unknown as ProjectDocument;
  errors.push(...checkAgainstBaseline(returned, issued).errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  let current: string;
  try {
    current = contentDigest(project, sha256Hex);
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          code: "bad-hasher",
          path: "sha256Hex",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const confirmation: CustomerConfirmation | undefined = project.confirmation;
  if (confirmation !== undefined && (confirmation.revision !== project.revision || confirmation.digest !== current)) {
    return { ok: false, errors: [{ code: "stale-confirmation", path: "confirmation", message: "Customer confirmation does not bind the returned revision and content" }] };
  }
  if (!validateProject(issued).ok) {
    return { ok: false, errors: [{ code: "invalid-baseline", path: "issued", message: "The trusted issued project must be valid" }] };
  }
  if (project.revision < issued.revision || (project.revision === issued.revision && current !== contentDigest(issued, sha256Hex))) {
    return { ok: false, errors: [{ code: "invalid-return-revision", path: "revision", message: "Changed content must advance the issued revision" }] };
  }
  const imported = JSON.parse(JSON.stringify(project)) as ProjectDocument;
  delete imported.review;
  imported.reviewHistory = Array.isArray(issued.reviewHistory)
    ? (JSON.parse(JSON.stringify(issued.reviewHistory)) as InternalReview[])
    : [];
  if (issued.review !== undefined) imported.reviewHistory.push(JSON.parse(JSON.stringify(issued.review)) as InternalReview);
  return { ok: true, project: imported };
}
