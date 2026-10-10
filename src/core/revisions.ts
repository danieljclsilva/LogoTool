/**
 * Revision + customer-confirmation handling for LogoTool provisional projects.
 *
 * - `newRevision(project, mutator)`: snapshots the ORIGINAL confirmation,
 *   review and histories BEFORE mutation, clones, mutates, validates the new
 *   content (revision counter must be exactly old+1), rotates the original
 *   approval records into history, and clears BOTH current confirmation and
 *   review. A mutator that tampers with confirmation/review/histories cannot
 *   smuggle them through: only pre-mutation records are preserved.
 * - `confirmRevision(project, input, sha256Hex)`: records customer
 *   pre-approval for the exact current revision + content digest. The project
 *   must first be structurally/semantically valid; confirmation of invalid
 *   dimensions or dangling refs is rejected even when the digest matches.
 *   `confirmedBy` is customer-supplied evidence text, never an authenticated
 *   identity claim and never a cryptographic signature.
 * - Customer confirmation is never internal approval (see workflow.ts).
 */

import { contentDigest } from "./content.js";
import { DIGEST_HEX_PATTERN } from "./types.js";
import type {
  CustomerConfirmation,
  InternalReview,
  ProjectDocument,
  Sha256HexFn,
  ValidationError,
} from "./types.js";
import { validateProject } from "./validate.js";

function cloneProject(project: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(project)) as ProjectDocument;
}

/**
 * Create the next revision: clone, mutate, bump the revision counter, rotate
 * the ORIGINAL pre-mutation confirmation/review into history, clear both
 * current approval records. Rejects invalid content or a mutator changing the revision counter.
 */
export function newRevision(
  project: ProjectDocument,
  mutator: (draft: ProjectDocument) => void,
): ProjectDocument {
  const original = validateProject(project);
  if (!original.ok || !Number.isSafeInteger(project.revision) || project.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("newRevision requires a valid project and a safe revision counter");
  }
  const next = cloneProject(project);
  const history = cloneProject(project).history ?? [];
  const reviewHistory = cloneProject(project).reviewHistory ?? [];
  const confirmation = next.confirmation;
  const review = next.review;
  mutator(next);
  if (next.revision !== project.revision || next.projectId !== project.projectId || next.schemaVersion !== project.schemaVersion) {
    throw new Error("newRevision owns the revision counter; identity and version cannot change");
  }
  if (confirmation !== undefined) history.push(cloneProject(project).confirmation!);
  if (review !== undefined) reviewHistory.push(cloneProject(project).review!);
  next.history = history;
  next.reviewHistory = reviewHistory;
  delete next.confirmation;
  delete next.review;
  next.revision = project.revision + 1;
  const validation = validateProject(next);
  if (!validation.ok) {
    throw new Error(`newRevision rejected invalid content: ${validation.errors.map(e => `${e.code}@${e.path}`).join(", ")}`);
  }
  return next;
}

export interface ConfirmInput {
  confirmedBy: string;
  confirmedAt?: string;
  /** Digest the confirmer reviewed; must equal the current content digest. */
  digestOf: string;
}

export type ConfirmOutcome =
  | { ok: true; project: ProjectDocument }
  | { ok: false; errors: ValidationError[] };

/**
 * Record customer pre-approval for the exact current revision + digest.
 * Rejects malformed projects, invalid content, and digest mismatches.
 * Customer-supplied `confirmedBy` is unverified evidence text, not proof of
 * authenticated identity or a cryptographic signature.
 */
export function confirmRevision(
  project: ProjectDocument,
  input: ConfirmInput,
  sha256Hex: Sha256HexFn,
): ConfirmOutcome {
  const errors: ValidationError[] = [];
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      errors: [{ code: "bad-shape", path: "input", message: "confirm input must be an object" }],
    };
  }
  if (typeof input.confirmedBy !== "string" || input.confirmedBy.length === 0) {
    errors.push({
      code: "bad-shape",
      path: "confirmedBy",
      message: "confirmedBy must be a non-empty string (customer-supplied evidence only, not authenticated identity)",
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
  if (
    input.confirmedAt !== undefined &&
    (typeof input.confirmedAt !== "string" || input.confirmedAt.length === 0)
  ) {
    errors.push({
      code: "bad-shape",
      path: "confirmedAt",
      message: "confirmedAt must be a non-empty string",
    });
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
          message: `cannot confirm invalid content: ${structural.errors.map((e) => `${e.code}@${e.path}`).join(", ")}`,
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
            "confirmation digest does not match the current operational content; re-review the exact configuration and confirm its digest",
        },
      ],
    };
  }
  if (project.confirmation !== undefined) {
    const history: CustomerConfirmation[] = Array.isArray(project.history)
      ? [...project.history]
      : [];
    history.push(project.confirmation);
    project.history = history;
  }
  project.confirmation = {
    revision: project.revision,
    digest: input.digestOf,
    confirmedBy: input.confirmedBy,
    confirmedAt: input.confirmedAt ?? new Date().toISOString(),
  };
  return { ok: true, project };
}
