/**
 * Optional customer-approval branch UI module (operator workflow, §7).
 *
 * DOM-injectable, deterministic and offline file:// safe. Renders a single
 * branch subview (NOT a top-level step) into a lead-provided host; the lead
 * owns step navigation, landing/header entry points and the operator job
 * itself. No email/upload/send tools, no network, no storage, no duplicate
 * geometry/validation engine.
 *
 * Contract summary (UX spec §7):
 * - Entry is a secondary "Send for customer approval" action (lead-owned,
 *   on Step 2). This module renders the branch subview: header
 *   "Send for customer approval", job + exact current selection summary,
 *   format default self-contained HTML with a ZIP alternative under More
 *   options, one primary "Create customer file", then the two-file handoff
 *   ("Save office copy" + "Save customer file") with purpose text, and
 *   "Back to placements". Local downloads only.
 * - The customer issue is built from CURRENT operator placement geometry
 *   (see `buildApprovalIssue`): every current product/variant/configuration
 *   and placement ships verbatim with exact millimetres — never the old
 *   builder policy that empties placements. Artwork, assets, calibration,
 *   regions and notes are preserved; only issue-specific identity, revision
 *   (always 1) and confirmation/review clearing follow the existing issue
 *   contract. The byte-exact issued baseline is stored for comparison;
 *   repeated unchanged input regenerates byte-identical files; content
 *   changes invalidate prior files and require regeneration (with a new
 *   unique project ID when the content changed under the same ID).
 * - "Open customer response" is available in this subview (and the lead
 *   routes landing/header entries to `openResponseEntry`). It uses the
 *   in-memory issued office copy when present, otherwise asks for "Open
 *   office copy" first, then "Open customer response". Existing checks
 *   (structure, baseline identity, product/logo tamper, asset bytes,
 *   malformed/oversized files) reject atomically; failure preserves the
 *   active job and outputs.
 * - A validated response opens a change summary with primary "Use customer
 *   changes" and secondary "Keep current job". No auto-merge. Use installs
 *   the exact validated content (lead-owned) and opens Step 2; customer
 *   notes stay read-only context; no sources or baseline are lost. Keep
 *   leaves the job unchanged. Later staff geometry edits mark branch files
 *   stale per the revision contracts (the lead performs the actual
 *   `newRevision` clearing; this module reflects staleness and never
 *   manufactures confirmation). Internal review decisions stay out of this
 *   branch entirely (optional Advanced bookkeeping lives in the lead-owned
 *   review flow; nothing here is ever marked approved locally).
 */

import { canonicalize, importCustomerReturn, validateProject } from '../../core/index.js';
import type {
  ProjectDocument,
  Sha256HexFn,
  ValidationError,
} from '../../core/index.js';
import type { BuilderIdentity, BuilderIssueResult } from '../../core/project-builder/index.js';
import { selectIssuedAssets } from '../../core/project-builder/index.js';
import { isPreviewOnlyProduct } from '../../core/project-builder/provisional-product.js';
import {
  assertProjectEditorLimits,
  evaluateProjectGeometry,
} from '../../core/project-editor/index.js';
import {
  PROJECT_PACKAGE_LIMITS,
  createProjectPackage,
  parseProjectPackage,
} from '../../packaging/project-package/index.js';
import type {
  ProjectPackageAsset,
} from '../../packaging/project-package/index.js';
import { createSelfContainedHtml } from '../../packaging/self-contained-html/index.js';
import { displayScopeTitle, displayVariantName } from '../../core/operation-document/index.js';
import { selectPresentationPackageAssets } from '../customer-editor/presentation-assets.js';
import { zipSync } from 'fflate';

/** Current operator job, supplied by the lead. */
export interface ApprovalJobSource {
  project: ProjectDocument;
  /** Full operator asset pool (referenced + additional, exact bytes). */
  assets: ProjectPackageAsset[];
  /** Step 1 identity values (raw; the module trims and validates). */
  identity: { customerLabel: string; jobReference: string; issuedBy: string; projectId: string };
}

/** Lead-owned dependencies for the approval branch. */
export interface CustomerApprovalDeps {
  readJob(): ApprovalJobSource | null;
  /** True while Step 2 holds unapplied (staged but not committed) edits. */
  hasUnappliedEdits(): boolean;
  /** Hash and register the exact canonical project text; resolves its digest. */
  prepareProject(project: ProjectDocument): Promise<string>;
  sha256Hex: Sha256HexFn;
  /** Async SHA-256 over exact archive bytes (for packaging). */
  sha256Bytes: (bytes: Uint8Array) => Promise<string>;
  /** Customer editor shell bytes for the self-contained file. */
  readEditorBytes(): Uint8Array;
  /** Lead-owned filename sanitizer for the human job handle. */
  sanitizeJobPart(value: string): string;
  downloadBytes(bytes: Uint8Array, fileName: string, mime: string): void;
  /** Presentation/evidence passthrough assets for the issue package. */
  readAdditionalAssets(): Array<{ path: string; bytes: Uint8Array }>;
  backToPlacements(): void;
  /** Route to the Step 1 identity field for correction. */
  fixIdentity(field: 'customer' | 'reference' | 'project'): void;
  /** Route to Step 2 to apply/discard staged placement edits. */
  fixPlacements(): void;
  /** Allocate a fresh unique issue ID (lead-owned auto-identity); the new ID
   * is shown in the Advanced issue identity block. Never called per keystroke. */
  mintFreshIssueId(): string;
  /** True only when the operator deliberately typed the issue ID (manual
   * override); auto-minted and untouched IDs are never manual. */
  isIssueIdManual(): boolean;
  /** Install the exact validated response content and open Step 2. */
  useCustomerChanges(project: ProjectDocument, assets: ProjectPackageAsset[]): void;
}

export interface CustomerApprovalHandle {
  /** Re-read the job and refresh summary, gating and staleness. */
  update(): void;
  /** Landing/header entry: open the office copy first when needed, else the response picker. */
  openResponseEntry(): void;
  /** Staff edited the job: recompute staleness (files/decision flags). */
  notifyJobChanged(): void;
  /** Open the collapsed More options disclosure (advanced issue settings). */
  openMoreOptions(): void;
  destroy(): void;
}

export type ApprovalFormat = 'self-contained' | 'hybrid';

/** One validated placement/geometry change group for the summary. */
export interface ApprovalChangeGroup {
  title: string;
  lines: string[];
}

function displayMm(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return (Math.round(value * 10) / 10).toFixed(1);
}

function displayDeg(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(Math.round(value * 10) / 10).toFixed(1)}°`;
}

function fail(code: string, path: string, message: string): ValidationError {
  return { code, path, message };
}

/**
 * Validate an approval identity with the existing issue policy: UI trims,
 * core validates the trimmed 1..256-char value and rejects surrounding
 * whitespace. `projectId` must additionally differ from the current job's
 * own project ID (a customer issue always carries a new, unique ID).
 */
export function validateApprovalIdentity(
  identity: { customerLabel: string; jobReference: string; issuedBy: string; projectId: string },
  currentProjectId: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (
    const [field, value] of [
      ['customerLabel', identity.customerLabel],
      ['jobReference', identity.jobReference],
      ['issuedBy', identity.issuedBy],
      ['projectId', identity.projectId],
    ] as const
  ) {
    const path = `identity.${field}`;
    if (typeof value !== 'string') {
      errors.push(fail('bad-identity', path, `${field} must be a string`));
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 256) {
      errors.push(fail('bad-identity', path, `${field} must be 1..256 chars after trimming`));
      continue;
    }
    if (trimmed !== value) {
      errors.push(fail('bad-identity', path, `${field} must not have leading or trailing whitespace`));
    }
  }
  if (identity.projectId.trim() !== '' && identity.projectId.trim() === currentProjectId) {
    errors.push(fail(
      'bad-identity',
      'identity.projectId',
      'Use a new, unique project ID for this customer issue (it must not match the current job ID).',
    ));
  }
  return errors;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Build a customer-facing issue from CURRENT operator placement geometry.
 * Pure; never mutates its inputs.
 *
 * Everything ships verbatim — products, variants, regions, calibrations,
 * logos, every configuration with its current placements (exact millimetre
 * values, methods, instructions) and project notes. Only issue-specific
 * identity is applied: the caller-supplied project ID, revision reset to 1,
 * and confirmation/review/history clearing per the existing issue contract
 * (matching `buildIssuedProject`'s description and clearing semantics).
 * Placements are never filtered or emptied and no empty configurations are
 * backfilled: a zero-placement option ships as its explicit no-placement
 * statement, exactly as authored.
 */
export function buildApprovalIssue(
  project: ProjectDocument,
  identity: BuilderIdentity,
): BuilderIssueResult {
  const structural = validateProject(project);
  if (!structural.ok) return { ok: false, errors: structural.errors };
  const identityErrors = validateApprovalIdentity(identity, project.projectId);
  if (identityErrors.length > 0) return { ok: false, errors: identityErrors };
  if (project.products.length === 0) {
    return {
      ok: false,
      errors: [fail('empty-selection', 'products', 'Add a product before creating a customer file.')],
    };
  }
  // Preview-only guard (mirrors the candidate-export contract): a placement
  // on a product with no regions and no calibrations has no measurable
  // frame and must never ship to a customer.
  for (const configuration of project.configurations) {
    const product = project.products.find((entry) => entry.id === configuration.productId);
    if (
      product !== undefined && isPreviewOnlyProduct(product) && configuration.placements.length > 0
    ) {
      return {
        ok: false,
        errors: [fail(
          'invalid-content',
          `configurations.${configuration.id}`,
          `Placement on preview-only product "${product.id}" cannot ship: it has no prepared regions, frames, or calibrations.`,
        )],
      };
    }
  }
  const issued = clone(project);
  issued.projectId = identity.projectId.trim();
  issued.revision = 1;
  issued.description =
    `Internal-builder issue ${issued.projectId} for ${identity.customerLabel.trim()} / ${identity.jobReference.trim()} ` +
    `by ${identity.issuedBy.trim()}. Confirmation and internal review history reset before customer handoff.`;
  delete issued.confirmation;
  delete issued.review;
  delete issued.reviewHistory;
  delete issued.history;
  const validation = validateProject(issued);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, project: issued };
}

/** Human scope summary for the branch header (counts and display names only, never raw ids). */
export interface ApprovalScopeSummary {
  productCount: number;
  optionCount: number;
  placementCount: number;
  options: Array<{ productName: string; variantName: string | null; placementCount: number }>;
}

export function summarizeApprovalScope(project: ProjectDocument): ApprovalScopeSummary {
  const options = project.configurations.map((config) => {
    const product = project.products.find((entry) => entry.id === config.productId);
    return {
      productName: product?.name?.trim() || config.productId,
      variantName: displayVariantName(product, config.variantId),
      placementCount: config.placements.length,
    };
  });
  return {
    productCount: new Set(project.configurations.map((entry) => entry.productId)).size,
    optionCount: project.configurations.length,
    placementCount: project.configurations.reduce((total, entry) => total + entry.placements.length, 0),
    options,
  };
}

function compareAssetBytes(
  baseline: readonly ProjectPackageAsset[],
  returned: readonly ProjectPackageAsset[],
): string[] {
  const baseByPath = new Map(baseline.map((asset) => [asset.path, asset] as const));
  const backByPath = new Map(returned.map((asset) => [asset.path, asset] as const));
  const paths = new Set([...baseByPath.keys(), ...backByPath.keys()]);
  const errors: string[] = [];
  for (const path of [...paths].sort()) {
    const original = baseByPath.get(path);
    const candidate = backByPath.get(path);
    if (original === undefined || candidate === undefined) {
      errors.push(`${path}: asset is missing from ${original !== undefined ? 'the return' : 'the issued baseline'}`);
      continue;
    }
    if (original.bytes.length !== candidate.bytes.length) {
      errors.push(`${path}: asset kind or bytes differ from the issued baseline`);
      continue;
    }
    let equal = true;
    for (let index = 0; index < original.bytes.length; index += 1) {
      if (original.bytes[index] !== candidate.bytes[index]) {
        equal = false;
        break;
      }
    }
    if (original.kind !== candidate.kind || !equal) {
      errors.push(`${path}: asset kind or bytes differ from the issued baseline`);
    }
  }
  return errors;
}

/**
 * Describe validated response changes as renderable data (pure). Geometry
 * reasons come from the domain evaluator verbatim; confirmation currency
 * binds the exact revision + digest supplied by the caller.
 */
export function describeApprovalChanges(
  issued: ProjectDocument,
  returned: ProjectDocument,
  returnedDigest: string,
): { groups: ApprovalChangeGroup[]; geometryOk: boolean; geometryText: string; confirmationText: string } {
  const groups: ApprovalChangeGroup[] = [];
  const confirmation = returned.confirmation;
  const confirmationText = confirmation === undefined
    ? 'Customer confirmation: none; draft only.'
    : (confirmation.revision === returned.revision && confirmation.digest === returnedDigest
      ? `Customer confirmation: current for revision ${returned.revision}; confirmed by ${confirmation.confirmedBy} (timestamp from the returned confirmation envelope; unverified identity).`
      : `Customer confirmation: stale or mismatched confirmation for revision ${confirmation.revision}; not trusted. Confirmed by ${confirmation.confirmedBy} (unverified identity).`);
  let geometryOk = true;
  let geometryText = 'Geometry: valid; no placements, so no geometric restrictions apply.';
  try {
    const verdict = evaluateProjectGeometry(returned);
    geometryOk = verdict.ok;
    if (verdict.placements.length === 0) {
      geometryText = 'Geometry: valid; no placements, so no geometric restrictions apply.';
    } else if (verdict.ok) {
      geometryText = `Geometry: valid; ${verdict.placements.length} measured footprint(s) fit their safe regions and avoid exclusions.`;
    } else {
      geometryOk = false;
      geometryText = `Geometry: invalid; ${verdict.placements
        .filter((item) => !item.ok)
        .map((item) => {
          const config = returned.configurations.find((entry) => entry.id === item.configurationId);
          const product = returned.products.find((entry) => entry.id === config?.productId);
          const placement = config?.placements[item.placementIndex];
          const logo = returned.logos.find((entry) => entry.id === placement?.logoId);
          const scope = config !== undefined
            ? displayScopeTitle(product, config.productId, config.variantId)
            : item.configurationId;
          return `${scope} — ${logo?.name ?? placement?.logoId ?? ''}: ${item.reason}`;
        }).join('; ')}`;
    }
  } catch (error) {
    geometryOk = false;
    geometryText = `Geometry cannot be evaluated: ${error instanceof Error ? error.message : String(error)}`;
  }
  const issuedById = new Map(issued.configurations.map((entry) => [entry.id, entry] as const));
  const backById = new Map(returned.configurations.map((entry) => [entry.id, entry] as const));
  for (const id of new Set([...issuedById.keys(), ...backById.keys()])) {
    const before = issuedById.get(id);
    const after = backById.get(id);
    if (canonicalize(before ?? null) === canonicalize(after ?? null)) continue;
    const config = after ?? before;
    const product = returned.products.find((entry) => entry.id === config?.productId);
    const title = config !== undefined
      ? displayScopeTitle(product, config.productId, config.variantId)
      : id;
    const lines: string[] = [];
    if (!before || !after) {
      lines.push(after ? 'Product option added.' : 'Product option removed.');
    } else {
      const oldLogos = new Map(before.placements.map((item, index) => [item.id ?? `#${index}`, item] as const));
      const newLogos = new Map(after.placements.map((item, index) => [item.id ?? `#${index}`, item] as const));
      for (const key of new Set([...oldLogos.keys(), ...newLogos.keys()])) {
        const oldItem = oldLogos.get(key);
        const newItem = newLogos.get(key);
        if (canonicalize(oldItem ?? null) === canonicalize(newItem ?? null)) continue;
        const item = newItem ?? oldItem;
        const logo = returned.logos.find((entry) => entry.id === item?.logoId);
        const region = product?.regions.find((entry) => entry.id === item?.regionId);
        const logoLabel = logo?.name ?? item?.logoId ?? key;
        lines.push(`${logoLabel}: ` +
          `${oldItem ? `${displayMm(oldItem.widthMm)} × ${displayMm(oldItem.heightMm)} mm` : '(not placed)'} → ` +
          `${newItem ? `${displayMm(newItem.widthMm)} × ${displayMm(newItem.heightMm)} mm` : '(removed)'}` +
          (oldItem?.regionId !== newItem?.regionId
            ? `; area ${(product?.regions.find((entry) => entry.id === oldItem?.regionId)?.name ?? oldItem?.regionId ?? '(not placed)')} → ${region?.name ?? newItem?.regionId ?? '(removed)'}`
            : `; area ${region?.name ?? item?.regionId ?? ''}`) +
          (oldItem && newItem && (oldItem.pos.xMm !== newItem.pos.xMm || oldItem.pos.yMm !== newItem.pos.yMm)
            ? `; centre (${displayMm(oldItem.pos.xMm)}, ${displayMm(oldItem.pos.yMm)}) → (${displayMm(newItem.pos.xMm)}, ${displayMm(newItem.pos.yMm)}) mm`
            : '') +
          (oldItem?.method !== newItem?.method
            ? `; method ${oldItem?.method ?? '(not placed)'} → ${newItem?.method ?? '(removed)'}`
            : '') +
          (oldItem?.rotationDeg !== newItem?.rotationDeg
            ? `; rotation ${oldItem ? displayDeg(oldItem.rotationDeg) : '(not placed)'} → ${newItem ? displayDeg(newItem.rotationDeg) : '(removed)'}`
            : ''));
        // Per-logo instructions are customer-supplied context: surface the
        // exact before/after text inertly (no trimming, no promotion to
        // production authority) so a note-only change never reads as an
        // identical size-only line.
        if ((oldItem?.instructions ?? null) !== (newItem?.instructions ?? null)) {
          lines.push(`${logoLabel}: instructions changed.`);
          lines.push(`Before: ${oldItem?.instructions ?? '(none)'}`);
          lines.push(`After: ${newItem?.instructions ?? '(none)'}`);
        }
      }
    }
    groups.push({ title, lines });
  }
  if (issued.instructions !== returned.instructions) {
    groups.push({
      title: 'Project note',
      lines: [
        `Before: ${issued.instructions ?? '(none)'}`,
        `After: ${returned.instructions ?? '(none)'}`,
      ],
    });
  }
  if (groups.length === 0) groups.push({ title: 'No changes', lines: ['No changes to logo layouts or notes.'] });
  return { groups, geometryOk, geometryText, confirmationText };
}

interface IssuedBranchState {
  jobPart: string;
  format: ApprovalFormat;
  packageBytes: Uint8Array;
  htmlBytes: Uint8Array;
  zipBytes: Uint8Array | null;
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
  /** Canonical text of the operator project at creation (staleness + repeat checks). */
  issuedText: string;
}

/** Prior issue IDs to operator-job text at creation: manual reuse of an old
 * ID under different content is refused (unique-per-issue contract). */
type IssuedHistory = Map<string, string>;

interface ResponseBranchState {
  fileName: string;
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
  digest: string;
  geometryOk: boolean;
  /** Canonical text of the operator job when the response was checked. */
  jobText: string | null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountCustomerApproval(host: HTMLElement, deps: CustomerApprovalDeps): CustomerApprovalHandle {
  const aborter = new AbortController();
  const signal = aborter.signal;
  let destroyed = false;
  let generation = 0;
  let busy = false;
  let format: ApprovalFormat = 'self-contained';
  let issued: IssuedBranchState | null = null;
  let response: ResponseBranchState | null = null;
  const issuedHistory: IssuedHistory = new Map();

  host.replaceChildren();
  host.setAttribute('data-customer-approval', '');

  const heading = el('h2', undefined, 'Send for customer approval');
  const intro = el('p', 'muted', 'Create the customer file from the current placements, keep the office copy, and hand the customer file over yourself. This page never sends anything.');
  const summaryBox = el('section');
  summaryBox.setAttribute('aria-label', 'Job and selection summary');
  const summaryTitle = el('h3', undefined, 'Job and current selection');
  const summaryLines = el('div', 'muted');
  summaryBox.append(summaryTitle, summaryLines);

  const formatDetails = document.createElement('details');
  formatDetails.className = 'disclosure';
  const formatSummary = document.createElement('summary');
  formatSummary.textContent = 'More options';
  const formatBody = el('div', 'body');
  const formatSelfLabel = el('label', undefined, 'One file the customer opens directly (Recommended)');
  const formatSelf = document.createElement('input');
  formatSelf.type = 'radio';
  formatSelf.name = 'approval-format';
  formatSelf.checked = true;
  formatSelfLabel.prepend(formatSelf);
  const formatZipLabel = el('label', undefined, 'ZIP file with the setup files inside');
  const formatZip = document.createElement('input');
  formatZip.type = 'radio';
  formatZip.name = 'approval-format';
  formatZipLabel.prepend(formatZip);
  formatBody.append(formatSelfLabel, formatZipLabel);
  const issueIdLine = el('p', 'muted');
  const issueIdLabel = document.createElement('label');
  issueIdLabel.className = 'field';
  issueIdLabel.append(document.createTextNode('New project ID for this issue'));
  const issueIdInput = document.createElement('input');
  issueIdInput.type = 'text';
  issueIdInput.autocomplete = 'off';
  issueIdInput.placeholder = 'e.g. CUST-2026-001 — unique per issue';
  issueIdInput.setAttribute('data-builder-hook', 'job-issue-project-id');
  issueIdLabel.append(issueIdInput);
  const issueIdNew = document.createElement('button');
  issueIdNew.type = 'button';
  issueIdNew.className = 'btn-secondary';
  issueIdNew.textContent = 'Create a new ID';
  issueIdNew.setAttribute('data-builder-hook', 'job-issue-project-new');
  const issueIdNote = el('p', 'muted', 'Use a new, unique project ID for each customer issue. It links any returned file to the correct saved baseline.');
  formatBody.append(issueIdLine, issueIdLabel, issueIdNew, issueIdNote);
  formatDetails.append(formatSummary, formatBody);

  const statusLine = el('p', 'muted');
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');

  const createButton = document.createElement('button');
  createButton.type = 'button';
  createButton.className = 'btn-primary';
  createButton.textContent = 'Create customer file';

  const handoffBox = el('div');
  const officeButton = document.createElement('button');
  officeButton.type = 'button';
  officeButton.className = 'btn-secondary';
  officeButton.textContent = 'Save office copy';
  const officePurpose = el('p', 'muted', 'Keep this review copy file — the browser forgets it on reload. You need it to open the customer response.');
  const customerFileButton = document.createElement('button');
  customerFileButton.type = 'button';
  customerFileButton.className = 'btn-secondary';
  customerFileButton.textContent = 'Save customer file';
  const customerPurpose = el('p', 'muted', 'Attach this file to your normal handoff yourself. This page does not upload or send it.');
  handoffBox.append(officeButton, officePurpose, customerFileButton, customerPurpose);

  const responseBox = el('section');
  responseBox.setAttribute('aria-label', 'Customer response');
  const responseTitle = el('h3', undefined, 'Customer response');
  const officeOpenButton = document.createElement('button');
  officeOpenButton.type = 'button';
  officeOpenButton.className = 'btn-secondary';
  officeOpenButton.textContent = 'Open office copy';
  const responseOpenButton = document.createElement('button');
  responseOpenButton.type = 'button';
  responseOpenButton.className = 'btn-secondary';
  responseOpenButton.textContent = 'Open customer response';
  const officeFile = document.createElement('input');
  officeFile.type = 'file';
  officeFile.accept = '.logo-project,application/zip';
  officeFile.setAttribute('aria-label', 'Choose the saved office copy for this job');
  officeFile.hidden = true;
  const responseFile = document.createElement('input');
  responseFile.type = 'file';
  responseFile.accept = '.logo-project,application/zip';
  responseFile.setAttribute('aria-label', 'Choose the returned customer file');
  responseFile.hidden = true;
  const responseStatus = el('p', 'muted');
  responseStatus.setAttribute('role', 'status');
  responseStatus.textContent = 'No customer response opened.';
  const changesBox = el('div');
  const decisionBox = el('div', 'actions');
  const useButton = document.createElement('button');
  useButton.type = 'button';
  useButton.className = 'btn-primary';
  useButton.textContent = 'Use customer changes';
  const keepButton = document.createElement('button');
  keepButton.type = 'button';
  keepButton.className = 'btn-secondary';
  keepButton.textContent = 'Keep current job';
  decisionBox.append(useButton, keepButton);
  decisionBox.hidden = true;
  responseBox.append(responseTitle, officeOpenButton, officeFile, responseOpenButton, responseFile, responseStatus, changesBox, decisionBox);

  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'btn-link';
  backButton.textContent = 'Back to placements';

  host.append(heading, intro, summaryBox, formatDetails, createButton, statusLine, handoffBox, responseBox, backButton);

  const setBusy = (value: boolean): void => {
    busy = value;
    update();
  };

  function currentText(): string | null {
    const job = deps.readJob();
    if (job === null) return null;
    try {
      return canonicalize(job.project);
    } catch {
      return null;
    }
  }

  function isIssuedStale(): boolean {
    if (issued === null) return false;
    const text = currentText();
    return text === null || text !== issued.issuedText;
  }

  function update(): void {
    if (destroyed) return;
    const job = deps.readJob();
    summaryLines.replaceChildren();
    if (job === null) {
      summaryLines.append(el('p', undefined, 'No job open. Create or open a job to send it for customer approval.'));
      issueIdLine.textContent = 'No job open.';
    } else {
      const scope = summarizeApprovalScope(job.project);
      summaryLines.append(
        el('p', undefined, `Customer ${job.identity.customerLabel.trim() || '—'} / job ${job.identity.jobReference.trim() || '—'} by ${job.identity.issuedBy.trim() || '—'}.`),
        el('p', undefined, `${scope.productCount} products, ${scope.optionCount} options, ${scope.placementCount} placements.`),
      );
      for (const option of scope.options) {
        const label = option.variantName === null
          ? option.productName
          : `${option.productName} / ${option.variantName}`;
        summaryLines.append(el(
          'p',
          undefined,
          `${label}: ${option.placementCount} placement${option.placementCount === 1 ? '' : 's'}`,
        ));
      }
      const issueId = job.identity.projectId.trim();
      issueIdLine.textContent = issueId !== ''
        ? `Issue project ID: ${issueId} (unique per issue; kept under More options).`
        : 'Issue project ID: none yet — create one under More options before creating the customer file.';
    }
    const stale = isIssuedStale();
    createButton.disabled = busy || job === null;
    officeButton.disabled = busy || issued === null || stale;
    customerFileButton.disabled = busy || issued === null || stale;
    formatSelf.disabled = busy;
    formatZip.disabled = busy;
    officeOpenButton.disabled = busy;
    responseOpenButton.disabled = busy;
    useButton.disabled = busy || response === null;
    keepButton.disabled = busy || response === null;
    if (job !== null && stale && issued !== null) {
      statusLine.textContent = 'The job changed since the customer file was created. Previously saved files are stale: create a new customer file (with a new unique project ID when the content changed).';
    }
    if (response !== null && job !== null) {
      const jobText = currentText();
      const drifted = response.jobText !== null && jobText !== null && jobText !== response.jobText;
      responseStatus.setAttribute('data-approval-drift', drifted ? 'true' : 'false');
      if (drifted) {
        responseStatus.textContent += ' The job changed since this response was checked: using these changes replaces the newer edits.';
      }
    }
  }

  async function createCustomerFile(): Promise<void> {
    if (busy) return;
    const job = deps.readJob();
    if (job === null) {
      statusLine.textContent = 'No job open. Create or open a job first.';
      return;
    }
    if (deps.hasUnappliedEdits()) {
      statusLine.textContent = 'Apply or discard the pending placement edits before creating the customer file.';
      deps.fixPlacements();
      return;
    }
    let identity: BuilderIdentity = {
      customerLabel: job.identity.customerLabel.trim(),
      jobReference: job.identity.jobReference.trim(),
      issuedBy: job.identity.issuedBy.trim(),
      projectId: job.identity.projectId.trim(),
    };
    // Auto-identity: an empty ID or an auto-generated ID under changed
    // content is replaced with a fresh unique issue ID on Create — the simple
    // flow never asks the operator to mint one. A deliberately retyped manual
    // ID under changed content is refused with More-options guidance instead.
    // Manual reuse of ANY prior issue ID (not just the latest) under
    // different content is refused: issue IDs are unique per issue.
    const jobText = currentText();
    const contentChanged = issued !== null &&
      identity.projectId === issued.project.projectId &&
      jobText !== issued.issuedText;
    const historicText = identity.projectId !== '' ? issuedHistory.get(identity.projectId) : undefined;
    const historicReuse = historicText !== undefined && jobText !== historicText;
    if (identity.projectId === '') {
      identity = { ...identity, projectId: deps.mintFreshIssueId() };
    } else if (contentChanged) {
      if (deps.isIssueIdManual()) {
        statusLine.textContent = 'The job content changed since this issue ID was created. Enter a new unique project ID under More options, then create the customer file again.';
        deps.fixIdentity('project');
        return;
      }
      identity = { ...identity, projectId: deps.mintFreshIssueId() };
    } else if (historicReuse) {
      // Different current issue but a manually retyped older ID: always
      // refuse — the ID already identifies different content. A fresh
      // explicitly minted ID (never issued) still proceeds below.
      if (deps.isIssueIdManual()) {
        statusLine.textContent = 'That project ID was already used for different content. Enter a new unique project ID under More options, then create the customer file again.';
        deps.fixIdentity('project');
        return;
      }
      identity = { ...identity, projectId: deps.mintFreshIssueId() };
    }
    const myGeneration = ++generation;
    setBusy(true);
    statusLine.textContent = 'Creating customer file…';
    try {
      const built = buildApprovalIssue(job.project, identity);
      if (myGeneration !== generation) return;
      if (!built.ok) {
        const first = built.errors[0];
        statusLine.textContent = `Customer file not created: ${first?.message ?? 'invalid content'}`;
        if (first?.path === 'identity.customerLabel') deps.fixIdentity('customer');
        else if (first?.path === 'identity.jobReference') deps.fixIdentity('reference');
        else if (first?.path === 'identity.projectId') deps.fixIdentity('project');
        return;
      }
      assertProjectEditorLimits(built.project);
      if (myGeneration !== generation) return;
      const pool = job.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes }));
      const referenced = selectIssuedAssets(pool, built.project);
      // Presentation assets prune to the issued configurations and are
      // rewritten (manifest + mappings + retained rasters) by the shared
      // selector (same contract as the legacy issue path); evidence sidecars
      // pass through byte-identical.
      const rawAdditional = deps.readAdditionalAssets();
      const withKind = rawAdditional.map((asset) => ({ ...asset, kind: 'additional' as const }));
      const presentationFiltered = selectPresentationPackageAssets(withKind, built.project.configurations, built.project);
      const additional = [
        ...presentationFiltered,
        ...withKind
          .filter((asset) => !asset.path.startsWith('presentation/'))
          .map(({ path, bytes }) => ({ path, bytes })),
      ];
      const packageBytes = await createProjectPackage(
        { project: built.project, assets: referenced, additionalAssets: additional },
        { sha256: deps.sha256Bytes },
      );
      if (myGeneration !== generation) return;
      const editorBytes = deps.readEditorBytes();
      const jobPart = deps.sanitizeJobPart(identity.jobReference);
      let htmlBytes: Uint8Array;
      let zipBytes: Uint8Array | null = null;
      if (format === 'hybrid') {
        const entries: Record<string, Uint8Array> = {};
        for (const name of ['OPEN_LOGO_CONFIGURATOR.html', `${jobPart}.logo-project`].sort()) {
          entries[name] = name === 'OPEN_LOGO_CONFIGURATOR.html' ? editorBytes : packageBytes;
        }
        zipBytes = zipSync(entries, { level: 6, mtime: new Date(2000, 0, 1, 0, 0, 0) });
        htmlBytes = editorBytes;
      } else {
        htmlBytes = new Uint8Array(await createSelfContainedHtml({ html: editorBytes, projectPackage: packageBytes }));
      }
      if (myGeneration !== generation) return;
      const text = canonicalize(built.project);
      // Deterministic repeat: identical input must regenerate byte-identical
      // files. If this exact content was issued before under the same ID,
      // the bytes must match; a mismatch fails closed instead of shipping.
      const prior = issued;
      if (prior !== null && canonicalize(prior.project) === text && identity.projectId === prior.project.projectId) {
        const same = packageBytes.length === prior.packageBytes.length &&
          packageBytes.every((byte, index) => byte === prior.packageBytes[index]);
        if (!same) throw new Error('regenerated bytes differ for unchanged content; refusing to ship non-deterministic output');
      }
      const retained: ProjectPackageAsset[] = [
        ...referenced.map((asset) => ({ path: asset.path, bytes: asset.bytes, kind: 'referenced' as const })),
        ...additional.map((asset) => ({ path: asset.path, bytes: asset.bytes, kind: 'additional' as const })),
      ];
      issued = {
        jobPart,
        format,
        packageBytes,
        htmlBytes,
        zipBytes,
        project: built.project,
        assets: retained,
        // Staleness tracks the OPERATOR job text (readJob domain): the issued
        // project always differs (new issue ID, revision reset, cleared
        // history), so comparing against it would mark fresh files stale.
        issuedText: currentText() ?? text,
      };
      issuedHistory.set(built.project.projectId, issued.issuedText);
      const size = format === 'hybrid' && zipBytes !== null ? zipBytes.length : htmlBytes.length;
      statusLine.textContent =
        `Customer file created: office copy ${packageBytes.length} bytes; customer file ${size} bytes. ` +
        `Byte-exact office copy retained for comparison. Save both files before leaving: the browser forgets them on reload.`;
    } catch (error) {
      if (myGeneration === generation) {
        statusLine.textContent = `Customer file not created: ${error instanceof Error ? error.message : String(error)}. The active job is unchanged.`;
      }
    } finally {
      if (myGeneration === generation) setBusy(false);
    }
  }

  function saveOfficeCopy(): void {
    if (busy || issued === null || isIssuedStale()) return;
    deps.downloadBytes(issued.packageBytes, `${issued.jobPart}-approval-office-copy.logo-project`, 'application/zip');
    statusLine.textContent = `Office copy download started (${issued.packageBytes.length} bytes). Keep it: you need it to open the customer response.`;
  }

  function saveCustomerFile(): void {
    if (busy || issued === null || isIssuedStale()) return;
    if (issued.format === 'hybrid' && issued.zipBytes !== null) {
      deps.downloadBytes(issued.zipBytes, `${issued.jobPart}-customer-file.zip`, 'application/zip');
      statusLine.textContent = `Customer file download started (${issued.zipBytes.length} bytes). Attach it to your normal handoff yourself.`;
    } else {
      deps.downloadBytes(issued.htmlBytes, 'OPEN_LOGO_CONFIGURATOR.html', 'text/html');
      statusLine.textContent = `Customer file download started (${issued.htmlBytes.length} bytes). The customer opens this file directly, nothing to unzip.`;
    }
  }

  async function openOfficeCopyFile(file: File): Promise<void> {
    if (busy) return;
    if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
      responseStatus.textContent = `Could not open ${file.name}: archive size exceeds the limit; rejected before reading.`;
      return;
    }
    const myGeneration = ++generation;
    setBusy(true);
    responseStatus.textContent = `Reading office copy ${file.name}…`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (myGeneration !== generation) return;
      if (bytes.length > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
        throw new Error(`archive size ${bytes.length} exceeds the limit; rejected before parsing`);
      }
      const parsed = await parseProjectPackage(bytes, { sha256: deps.sha256Bytes });
      if (myGeneration !== generation) return;
      assertProjectEditorLimits(parsed.project);
      issued = {
        jobPart: deps.sanitizeJobPart(parsed.project.projectId),
        format,
        packageBytes: bytes.slice(),
        htmlBytes: new Uint8Array(0),
        zipBytes: null,
        project: parsed.project,
        assets: parsed.assets.slice(),
        // Staleness tracks the operator job text at open time: opening a
        // baseline for the current unchanged job stays fresh; later staff
        // edits mark the loaded files stale.
        issuedText: currentText() ?? canonicalize(parsed.project),
      };
      response = null;
      decisionBox.hidden = true;
      changesBox.replaceChildren();
      responseStatus.textContent = `Office copy loaded: ${file.name} (revision ${parsed.project.revision}). This is the baseline for the customer response; no customer file was generated from it.`;
    } catch (error) {
      if (myGeneration === generation) {
        responseStatus.textContent = `Could not open office copy ${file.name}: ${error instanceof Error ? error.message : String(error)}. The previous state is unchanged.`;
      }
    } finally {
      if (myGeneration === generation) setBusy(false);
    }
  }

  async function openCustomerResponseFile(file: File): Promise<void> {
    if (busy) return;
    if (issued === null) {
      responseStatus.textContent = 'Open the office copy saved for this job first, then open the customer response.';
      officeFile.click();
      return;
    }
    if (file.size > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
      responseStatus.textContent = `Could not import return ${file.name}: archive size exceeds the limit; rejected before reading. The active job and outputs are unchanged.`;
      return;
    }
    const baseline = issued;
    const myGeneration = ++generation;
    setBusy(true);
    responseStatus.textContent = `Reading customer response ${file.name}…`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (myGeneration !== generation) return;
      if (bytes.length > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
        throw new Error(`archive size ${bytes.length} exceeds the limit; rejected before parsing`);
      }
      const parsed = await parseProjectPackage(bytes, { sha256: deps.sha256Bytes });
      if (myGeneration !== generation) return;
      assertProjectEditorLimits(parsed.project);
      const assetErrors = compareAssetBytes(baseline.assets, parsed.assets);
      if (assetErrors.length > 0) {
        throw new Error(`asset comparison differs from the issued baseline: ${assetErrors.join('; ')}`);
      }
      await deps.prepareProject(baseline.project);
      const digest = await deps.prepareProject(parsed.project);
      if (myGeneration !== generation) return;
      const outcome = importCustomerReturn(parsed.project, baseline.project, deps.sha256Hex);
      if (!outcome.ok) {
        throw new Error(outcome.errors.map((error) => `${error.code}: ${error.message}`).join('; '));
      }
      if (myGeneration !== generation) return;
      const described = describeApprovalChanges(baseline.project, outcome.project, digest);
      response = {
        fileName: file.name,
        project: outcome.project,
        assets: parsed.assets.slice(),
        digest,
        geometryOk: described.geometryOk,
        jobText: currentText(),
      };
      changesBox.replaceChildren();
      const confirmationLine = el('p', undefined, described.confirmationText);
      const geometryLine = el('p', undefined, described.geometryText);
      changesBox.append(confirmationLine, geometryLine);
      for (const group of described.groups) {
        const section = el('section');
        section.append(el('h4', undefined, group.title));
        for (const line of group.lines) section.append(el('p', undefined, line));
        changesBox.append(section);
      }
      decisionBox.hidden = false;
      responseStatus.textContent = `Response checked against the office copy. No changes were applied: choose Use customer changes or Keep current job.`;
    } catch (error) {
      if (myGeneration === generation) {
        responseStatus.textContent = `Could not import response ${file.name}: ${error instanceof Error ? error.message : String(error)}. The active job and outputs are unchanged.`;
      }
    } finally {
      if (myGeneration === generation) setBusy(false);
    }
  }

  function useResponse(): void {
    if (busy || response === null) return;
    const snapshot = response;
    response = null;
    decisionBox.hidden = true;
    changesBox.replaceChildren();
    responseStatus.textContent = 'No customer response opened.';
    deps.useCustomerChanges(snapshot.project, snapshot.assets);
  }

  function keepJob(): void {
    if (busy || response === null) return;
    response = null;
    decisionBox.hidden = true;
    changesBox.replaceChildren();
    responseStatus.textContent = 'Kept the current job. The checked response was discarded without applying anything.';
  }

  createButton.addEventListener('click', () => void createCustomerFile(), { signal });
  officeButton.addEventListener('click', saveOfficeCopy, { signal });
  customerFileButton.addEventListener('click', saveCustomerFile, { signal });
  backButton.addEventListener('click', () => deps.backToPlacements(), { signal });
  formatSelf.addEventListener('change', () => {
    if (formatSelf.checked && format !== 'self-contained') {
      format = 'self-contained';
      issued = null;
      statusLine.textContent = 'Format changed. Create the customer file again.';
      update();
    }
  }, { signal });
  formatZip.addEventListener('change', () => {
    if (formatZip.checked && format !== 'hybrid') {
      format = 'hybrid';
      issued = null;
      statusLine.textContent = 'Format changed. Create the customer file again.';
      update();
    }
  }, { signal });
  officeOpenButton.addEventListener('click', () => officeFile.click(), { signal });
  responseOpenButton.addEventListener('click', () => {
    if (issued === null) {
      responseStatus.textContent = 'Open the office copy saved for this job first, then open the customer response.';
      officeFile.click();
      return;
    }
    responseFile.click();
  }, { signal });
  officeFile.addEventListener('change', () => {
    const file = officeFile.files?.[0];
    officeFile.value = '';
    if (file) void openOfficeCopyFile(file);
  }, { signal });
  responseFile.addEventListener('change', () => {
    const file = responseFile.files?.[0];
    responseFile.value = '';
    if (file) void openCustomerResponseFile(file);
  }, { signal });
  useButton.addEventListener('click', useResponse, { signal });
  keepButton.addEventListener('click', keepJob, { signal });

  function openMoreOptions(): void {
    if (!destroyed) formatDetails.open = true;
  }

  function openResponseEntry(): void {
    if (destroyed || busy) return;
    if (issued === null) {
      responseStatus.textContent = 'Open the office copy saved for this job first, then open the customer response.';
      officeFile.click();
      return;
    }
    responseFile.click();
  }

  function destroy(): void {
    destroyed = true;
    generation += 1;
    aborter.abort();
    host.replaceChildren();
  }

  update();
  return {
    update,
    openResponseEntry,
    openMoreOptions,
    notifyJobChanged: update,
    destroy,
  };
}
