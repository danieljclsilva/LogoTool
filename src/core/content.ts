/**
 * Operational content envelope + content digest.
 *
 * Digest scope covers ALL operational customer-visible content: schema
 * version, project identity, product snapshots, logo snapshots,
 * configurations, and project instructions. Excluded bookkeeping: revision
 * counter, confirmation, reviews/histories, non-operational descriptions and
 * markers (`synthetic`, `description`, `issuedBaselineHash`).
 *
 * Any artwork, placement, instruction, product, logo, or identity change
 * invalidates the digest — callers never need to remember to bump a revision
 * for the digest to change (revision counters are still enforced separately
 * by `newRevision`).
 *
 * Pure apart from the injected hasher; no DOM / React / Three.js / Node APIs.
 * Hasher results are validated (lowercase SHA-256 hex); invalid output is
 * rejected with an error, never trusted.
 */

import { canonicalize } from "./canonical.js";
import { DIGEST_HEX_PATTERN } from "./types.js";
import type {
  ContentEnvelope,
  ProjectDocument,
  Sha256HexFn,
} from "./types.js";

/** Build the operational content envelope of a project (digest input). */
export function contentEnvelope(project: ProjectDocument): ContentEnvelope {
  const envelope: ContentEnvelope = {
    schemaVersion: project.schemaVersion,
    projectId: project.projectId,
    products: project.products,
    logos: project.logos,
    configurations: project.configurations,
  };
  if (project.instructions !== undefined) {
    envelope.instructions = project.instructions;
  }
  return envelope;
}

/**
 * Hex digest of the canonical bytes of the operational content envelope.
 * Throws on an invalid hasher result (not lowercase SHA-256 hex).
 */
export function contentDigest(
  project: ProjectDocument,
  sha256Hex: Sha256HexFn,
): string {
  let digest: string;
  try {
    digest = sha256Hex(canonicalize(contentEnvelope(project)));
  } catch (error) {
    throw new Error(
      `content digest failed: hasher threw (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (typeof digest !== "string" || !DIGEST_HEX_PATTERN.test(digest)) {
    throw new Error(
      "content digest failed: hasher must return lowercase SHA-256 hex ([0-9a-f]{64})",
    );
  }
  return digest;
}
