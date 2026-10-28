/**
 * Live operator job session: the single authoritative owner of the editable
 * job lifecycle (batch 1 of the lean refactor).
 *
 * One plain `JobSession` record holds the editable project + assets, the
 * operator authoring (instructions, technique, measurement bindings, anchors),
 * the Step 2 selection, and the dirty/edit-counter persistence state. Derived
 * artefacts (persisted metadata sidecars, document inputs) are rebuilt from
 * these canonical live fields — never stored as a second authoritative copy.
 *
 * Plain record + pure functions only: no DOM, no React/Three.js, no browser
 * APIs, no framework. Portable types only (core domain + packaging).
 */

import { summarizeSourceProject } from "../../core/project-builder/index.js";
import type { BuilderSourceSummary } from "../../core/project-builder/index.js";
import type { ProjectDocument } from "../../core/index.js";
import { newRevision } from "../../core/revisions.js";
import type { Placement } from "../../core/index.js";
import {
  createEmptyJobMetadata,
  markDependentMeasurementsUnresolved,
  toSheetBindings,
} from "../../core/operator-job/index.js";
import type { OperatorJobMetadata } from "../../core/operator-job/index.js";
import type { SheetLogoExtras } from "../../core/operation-document/types.js";
import type { AnchorDef, DimensionBinding } from "../../core/operation-measurements/types.js";
import type { ProjectPackageAsset } from "../../packaging/project-package/index.js";

/** Reserved techniqueSettings section for the job-wide technique panel. */
export const JOB_WIDE_TECHNIQUE_KEY = "__job__" as const;

/**
 * ID-indexed dictionary with no prototype. Configuration ids, logoRefs and
 * view slugs are operator/file controlled and may validly be
 * `__proto__`, `constructor` or `toString`: a plain `{}` would resolve
 * `dict["constructor"]` to a function (spreading it throws) and silently
 * drop an own `__proto__` assignment. Every ID-keyed record in this module
 * uses this container; JSON/canonical output still serializes identically.
 */
export function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Job-wide technique fields (portable twin of the review panel shape). */
export interface JobTechniqueFields {
  temperature: string;
  time: string;
  pressure: string;
  colour: string;
  thread: string;
}

/** Per-logo technique (portable twin of the placement workspace shape). */
export interface JobLogoTechnique extends JobTechniqueFields {
  businessCode: string;
}

/** Step 2 selection: product/option/view/placement focus. */
export interface JobSelection {
  productId: string;
  variantId: string;
  viewId: string | null;
  placementId: string | null;
}

export interface JobSession {
  fileName: string;
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
  /** Cached derived summary; refreshed only by the session writers below. */
  summary: BuilderSourceSummary;
  /** Verbatim source package bytes (byte-identical master download). File-adapter detail. */
  packageBytes: Uint8Array;
  /** Staff-authored operational instructions (shared with the output). */
  instructions: string;
  /** Job-wide technique settings for the reviewed scope. */
  technique: JobTechniqueFields;
  /** Staff-chosen measurement bindings per configuration id. */
  bindings: Record<string, DimensionBinding[]>;
  /** Per-logo production technique by configuration id then logoRef. */
  logoTechnique: Record<string, Record<string, JobLogoTechnique>>;
  /** Authored anchors in authoritative region-frame millimetres. */
  anchors: AnchorDef[];
  selection: JobSelection;
  /** Unsaved changes held in this browser (persistence-line contract). */
  dirty: boolean;
  /** Monotonic edit counter: save/open guards retain newer edits, never clear them. */
  editCounter: number;
}

export function emptyTechniqueFields(): JobTechniqueFields {
  return { temperature: "", time: "", pressure: "", colour: "", thread: "" };
}

export function emptyLogoTechnique(): JobLogoTechnique {
  return { businessCode: "", ...emptyTechniqueFields() };
}

export function emptySelection(): JobSelection {
  return { productId: "", variantId: "", viewId: null, placementId: null };
}

/** Fresh session: creating/opening/installing a job is the authoring reset. */
export function createEmptySession(
  fileName: string,
  project: ProjectDocument,
  assets: ProjectPackageAsset[],
  packageBytes: Uint8Array,
): JobSession {
  return {
    fileName,
    project,
    assets,
    summary: summarizeSourceProject(project),
    packageBytes: packageBytes.slice(),
    instructions: "",
    technique: emptyTechniqueFields(),
    bindings: emptyRecord(),
    logoTechnique: emptyRecord(),
    anchors: [],
    selection: emptySelection(),
    dirty: false,
    editCounter: 0,
  };
}

/**
 * Replace the session project/assets after a validated commit (reparse,
 * intake, workspace save). Returns a NEW session object — like the previous
 * `source = {...}` assemblies — so in-flight async staleness guards
 * (`source !== snapshot`) keep working: a project commit invalidates
 * concurrent saves, while authoring-only edits preserve identity.
 * The cached summary refreshes with the project so the two can never go
 * stale independently. Authoring, selection and dirty state carry over (the
 * previous session is unreachable after the swap).
 */
export function replaceSessionProject(
  session: JobSession,
  project: ProjectDocument,
  assets?: ProjectPackageAsset[],
  packageBytes?: Uint8Array,
): JobSession {
  return {
    ...session,
    project,
    assets: assets ?? session.assets,
    packageBytes: (packageBytes ?? session.packageBytes).slice(),
    summary: summarizeSourceProject(project),
    selection: { ...session.selection },
    technique: { ...session.technique },
  };
}

/** One logical edit: marks dirty and advances the generation guard. */
export function touchSession(session: JobSession): void {
  session.dirty = true;
  session.editCounter += 1;
}

/** The live job now matches the last download: clears dirty, keeps history. */
export function cleanSession(session: JobSession): void {
  session.dirty = false;
}

/** Local logoRef matching (same convention as the sheet renderer). */
export function matchSessionPlacement(
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

export interface ResolvedBindingScope {
  configurationId: string;
  productId: string;
  variantId: string;
  regionId: string;
  frameId: string;
  calibrationId: string;
  calibrationVersion: string;
}

/**
 * Exact scope resolution for one persisted binding. Anything that no longer
 * resolves (configuration, placement, anchor, region, frame, calibration)
 * reads unresolved with a reason — never fabricated, never silently rebound.
 */
export function resolveSessionBinding(
  project: ProjectDocument,
  anchors: readonly AnchorDef[],
  configurationId: string,
  binding: DimensionBinding,
): ResolvedBindingScope | { unresolved: string } {
  const config = project.configurations.find((entry) => entry.id === configurationId);
  if (!config) return { unresolved: "configuration is no longer in the job" };
  const product = project.products.find((entry) => entry.id === config.productId);
  if (!product) return { unresolved: "product is no longer in the job" };
  if (matchSessionPlacement(config.placements, binding.logoRef) === undefined) {
    return { unresolved: `no placement matches “${binding.logoRef}” anymore` };
  }
  const anchor = anchors.find((entry) => entry.id === binding.anchorId);
  if (!anchor) return { unresolved: "anchor is not set up (set it up on the product first)" };
  if (anchor.productId !== config.productId || anchor.variantId !== config.variantId) {
    return { unresolved: "anchor belongs to another product or option" };
  }
  const region = product.regions.find((entry) => entry.id === anchor.regionId);
  if (!region) return { unresolved: "measured area is no longer on the product" };
  return {
    configurationId,
    productId: config.productId,
    variantId: config.variantId,
    regionId: region.id,
    frameId: region.frame.frameId,
    calibrationId: region.calibrationRef.calibrationId,
    calibrationVersion: region.calibrationRef.version,
  };
}

/** Per-logo extras for the sheet renderer/export (caller-supplied only, never generated). */
export function techniqueToExtras(technique: {
  businessCode?: string;
  temperature: string;
  time: string;
  pressure: string;
  colour: string;
  thread: string;
}): SheetLogoExtras {
  const out: SheetLogoExtras = {};
  const code = (technique.businessCode ?? "").trim();
  if (code !== "") out.businessCode = code;
  const methodParams: Record<string, string> = {};
  if (technique.temperature.trim() !== "") methodParams["temperature"] = technique.temperature.trim();
  if (technique.time.trim() !== "") methodParams["time"] = technique.time.trim();
  if (technique.pressure.trim() !== "") methodParams["pressure"] = technique.pressure.trim();
  if (technique.thread.trim() !== "") methodParams["thread"] = technique.thread.trim();
  if (Object.keys(methodParams).length > 0) out.methodParams = methodParams;
  if (technique.colour.trim() !== "") out.colours = [technique.colour.trim()];
  return out;
}

export function extrasToLogoTechnique(extras: SheetLogoExtras): JobLogoTechnique {
  return {
    businessCode: extras.businessCode ?? "",
    temperature: extras.methodParams?.["temperature"] ?? "",
    time: extras.methodParams?.["time"] ?? "",
    pressure: extras.methodParams?.["pressure"] ?? "",
    colour: extras.colours?.[0] ?? "",
    thread: extras.methodParams?.["thread"] ?? "",
  };
}

export function extrasToTechniqueFields(extras: SheetLogoExtras): JobTechniqueFields {
  const full = extrasToLogoTechnique(extras);
  return {
    temperature: full.temperature,
    time: full.time,
    pressure: full.pressure,
    colour: full.colour,
    thread: full.thread,
  };
}

/**
 * Derive the persisted metadata from the canonical live fields (Save job).
 * The digest stays empty here; the caller fills `sourceDigest` after hashing
 * the exact project being packaged.
 */
export function snapshotSessionMetadata(
  session: JobSession,
  identity: OperatorJobMetadata["identity"],
  inclusion: OperatorJobMetadata["inclusion"],
  note?: string,
): OperatorJobMetadata {
  const bindings: OperatorJobMetadata["bindings"] = [];
  for (const [configurationId, list] of Object.entries(session.bindings)) {
    for (const binding of list) {
      const scope = resolveSessionBinding(session.project, session.anchors, configurationId, binding);
      if ("unresolved" in scope) {
        bindings.push({
          configurationId,
          productId: "",
          variantId: "",
          regionId: "",
          frameId: "",
          calibrationId: "",
          calibrationVersion: "",
          logoRef: binding.logoRef,
          anchorId: binding.anchorId,
          edge: binding.edge,
          convention: binding.convention,
          label: binding.label ?? "",
          status: "unresolved",
          unresolvedReason: scope.unresolved,
        });
      } else {
        bindings.push({
          ...scope,
          logoRef: binding.logoRef,
          anchorId: binding.anchorId,
          edge: binding.edge,
          convention: binding.convention,
          label: binding.label ?? "",
          status: "bound",
        });
      }
    }
  }
  const techniqueSettings: Record<string, Record<string, SheetLogoExtras>> = emptyRecord();
  for (const [configurationId, perLogo] of Object.entries(session.logoTechnique)) {
    const section: Record<string, SheetLogoExtras> = emptyRecord();
    for (const [logoRef, technique] of Object.entries(perLogo)) {
      const extras = techniqueToExtras(technique);
      if (Object.keys(extras).length > 0) section[logoRef] = extras;
    }
    if (Object.keys(section).length > 0) techniqueSettings[configurationId] = section;
  }
  const wide = techniqueToExtras(session.technique);
  if (Object.keys(wide).length > 0) techniqueSettings[JOB_WIDE_TECHNIQUE_KEY] = { "": wide };
  return {
    ...createEmptyJobMetadata(),
    sourceRevision: session.project.revision,
    sourceDigest: "",
    identity: { ...identity },
    inclusion: {
      includedProducts: [...inclusion.includedProducts],
      includedConfigurations: [...inclusion.includedConfigurations],
      logoIds: inclusion.logoIds !== undefined ? [...inclusion.logoIds] : [],
    },
    instructions: session.instructions,
    techniqueSettings,
    anchors: cloneHistoryValue(session.anchors),
    bindings,
    ...(note !== undefined ? { updatedNote: note } : {}),
  };
}

export interface SessionAuthoring {
  instructions: string;
  technique: JobTechniqueFields;
  bindings: Record<string, DimensionBinding[]>;
  logoTechnique: Record<string, Record<string, JobLogoTechnique>>;
  anchors: AnchorDef[];
}

/**
 * Expand validated metadata into live authoring (Open job). The decode
 * result is a transfer object, never a second long-lived store: bindings are
 * recomputed against the project (moved/removed scope reads unresolved and
 * is dropped from the live set, exactly like the previous open path —
 * unresolved reasons surface through the open warnings), and the technique
 * split mirrors the previous round-trip including the reserved job-wide key.
 */
export function sessionAuthoringFromMetadata(
  project: ProjectDocument,
  metadata: OperatorJobMetadata,
): SessionAuthoring {
  const { metadata: marked } = markDependentMeasurementsUnresolved(metadata, project);
  const bindings: Record<string, DimensionBinding[]> = emptyRecord();
  for (const [configurationId, list] of Object.entries(toSheetBindings(marked))) {
    bindings[configurationId] = [...list];
  }
  let technique = emptyTechniqueFields();
  const wide = marked.techniqueSettings[JOB_WIDE_TECHNIQUE_KEY]?.[""];
  if (wide) technique = extrasToTechniqueFields(wide);
  const logoTechnique: Record<string, Record<string, JobLogoTechnique>> = emptyRecord();
  for (const [configurationId, perLogo] of Object.entries(marked.techniqueSettings)) {
    if (configurationId === JOB_WIDE_TECHNIQUE_KEY) continue;
    const inner: Record<string, JobLogoTechnique> = emptyRecord();
    for (const [logoRef, extras] of Object.entries(perLogo)) {
      inner[logoRef] = extrasToLogoTechnique(extras);
    }
    if (Object.keys(inner).length > 0) logoTechnique[configurationId] = inner;
  }
  return {
    instructions: marked.instructions ?? "",
    technique,
    bindings,
    logoTechnique,
    anchors: [...(marked.anchors ?? [])],
  };
}

/** Install transferred authoring onto a session (open/response paths). */
export function applySessionAuthoring(session: JobSession, authoring: SessionAuthoring): void {
  session.instructions = authoring.instructions;
  session.technique = { ...authoring.technique };
  const bindings: Record<string, DimensionBinding[]> = emptyRecord();
  for (const [key, list] of Object.entries(authoring.bindings)) bindings[key] = [...list];
  session.bindings = bindings;
  const logoTechnique: Record<string, Record<string, JobLogoTechnique>> = emptyRecord();
  for (const [key, perLogo] of Object.entries(authoring.logoTechnique)) {
    const inner: Record<string, JobLogoTechnique> = emptyRecord();
    for (const [logoRef, technique] of Object.entries(perLogo)) inner[logoRef] = { ...technique };
    logoTechnique[key] = inner;
  }
  session.logoTechnique = logoTechnique;
  session.anchors = [...authoring.anchors];
}

/**
 * Rebase office-authored inputs onto a validated response project.
 * Binding definitions whose configuration still exists are retained
 * (changed or missing scope surfaces as unresolved with reasons at the next
 * snapshot, never silently rebound or fabricated); anchors and per-logo
 * technique whose exact scope vanished are dropped. Instructions and the
 * job-wide technique panel are office-authored context and persist.
 */
export function rebaseSessionAuthoring(session: JobSession, response: ProjectDocument): void {
  const responseProducts = new Map(response.products.map((entry) => [entry.id, entry]));
  session.anchors = session.anchors.filter((anchor) => {
    const product = responseProducts.get(anchor.productId);
    if (!product) return false;
    if (!product.variants.some((entry) => entry.id === anchor.variantId)) return false;
    const region = product.regions.find((entry) => entry.id === anchor.regionId);
    return (
      region !== undefined &&
      region.frame.frameId === anchor.frameId &&
      region.calibrationRef.calibrationId === anchor.calibrationId &&
      region.calibrationRef.version === anchor.calibrationVersion
    );
  });
  const responseConfigs = new Set(response.configurations.map((entry) => entry.id));
  for (const configurationId of Object.keys(session.bindings)) {
    if (!responseConfigs.has(configurationId)) delete session.bindings[configurationId];
  }
  for (const configurationId of Object.keys(session.logoTechnique)) {
    const config = response.configurations.find((entry) => entry.id === configurationId);
    if (!config) {
      delete session.logoTechnique[configurationId];
      continue;
    }
    const perLogo = session.logoTechnique[configurationId]!;
    for (const logoRef of Object.keys(perLogo)) {
      if (matchSessionPlacement(config.placements, logoRef) === undefined) delete perLogo[logoRef];
    }
    if (Object.keys(perLogo).length === 0) delete session.logoTechnique[configurationId];
  }
}

/**
 * Document inputs derived from the canonical live fields (review snapshot):
 * bound bindings plus per-logo extras, copied so renderers cannot mutate
 * the live session.
 */
export function sessionDocumentInputs(session: JobSession): {
  bindings: Record<string, DimensionBinding[]>;
  extras: Record<string, Record<string, SheetLogoExtras>>;
} {
  const bindings: Record<string, DimensionBinding[]> = emptyRecord();
  for (const [configurationId, list] of Object.entries(session.bindings)) {
    bindings[configurationId] = [...list];
  }
  const extras: Record<string, Record<string, SheetLogoExtras>> = emptyRecord();
  for (const [configurationId, perLogo] of Object.entries(session.logoTechnique)) {
    const section: Record<string, SheetLogoExtras> = emptyRecord();
    for (const [logoRef, technique] of Object.entries(perLogo)) {
      const entry = techniqueToExtras(technique);
      if (Object.keys(entry).length > 0) section[logoRef] = entry;
    }
    if (Object.keys(section).length > 0) extras[configurationId] = section;
  }
  return { bindings, extras };
}

/**
 * Save-snapshot capture (Save job). Freezes everything the async save needs
 * from the live session BEFORE the first await: an exact project copy, the
 * asset lists, and the edit counter. The save then packages only the frozen
 * snapshot and clears dirty state only when the live session is still this
 * exact session object with an unchanged counter — a stale save (slower,
 * overtaken by an open/install/commit) can neither mix project A with
 * assets from B nor clear B's dirty state when counters coincide.
 */
export interface SaveSnapshot {
  session: JobSession;
  project: ProjectDocument;
  assets: ProjectPackageAsset[];
  editCounter: number;
}

export function captureSaveSnapshot(session: JobSession): SaveSnapshot {
  return {
    session,
    project: JSON.parse(JSON.stringify(session.project)) as ProjectDocument,
    assets: [...session.assets],
    editCounter: session.editCounter,
  };
}

/** True only when the live session is still the exact session being saved. */
export function isSameSaveSession(live: JobSession | null, snap: SaveSnapshot): boolean {
  return live === snap.session;
}

/** Bounded operator history (session-local): one gesture one entry. */
export interface OperatorHistoryEntry {
  label: string;
  assets: ProjectPackageAsset[];
  project: ProjectDocument;
  instructions: string;
  technique: JobTechniqueFields;
  bindings: Record<string, DimensionBinding[]>;
  logoTechnique: Record<string, Record<string, JobLogoTechnique>>;
  anchors: AnchorDef[];
}

export interface OperatorHistory {
  past: OperatorHistoryEntry[];
  future: OperatorHistoryEntry[];
}

export const OPERATOR_HISTORY_LIMIT = 50 as const;

function cloneHistoryProject(project: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(project)) as ProjectDocument;
}

/** Preserve ID dictionaries, including absent prototype-like keys, across history. */
function cloneHistoryValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneHistoryValue(entry)) as T;
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) out[key] = cloneHistoryValue(entry);
    return out as T;
  }
  return value;
}

function snapshotEntry(session: JobSession, label: string): OperatorHistoryEntry {
  return {
    label,
    assets: session.assets.map((asset) => ({ ...asset })),
    project: cloneHistoryProject(session.project),
    instructions: session.instructions,
    technique: { ...session.technique },
    bindings: cloneHistoryValue(session.bindings),
    logoTechnique: cloneHistoryValue(session.logoTechnique),
    anchors: cloneHistoryValue(session.anchors),
  };
}

/** Fresh bounded history. Save/open/new-job boundaries reset via this. */
export function createOperatorHistory(): OperatorHistory {
  return { past: [], future: [] };
}

/** Record the pre-edit state; clears redo after a new edit. Bounded to 50. */
export function pushOperatorHistory(
  history: OperatorHistory,
  session: JobSession,
  label: string,
): void {
  history.past.push(snapshotEntry(session, label));
  while (history.past.length > OPERATOR_HISTORY_LIMIT) history.past.shift();
  history.future.length = 0;
}

export function canUndoOperatorHistory(history: OperatorHistory): boolean {
  return history.past.length > 0;
}

export function canRedoOperatorHistory(history: OperatorHistory): boolean {
  return history.future.length > 0;
}

function restoreHistoryAuthoring(session: JobSession, entry: OperatorHistoryEntry): void {
  session.assets = entry.assets.map((asset) => ({ ...asset }));
  session.summary = summarizeSourceProject(session.project);
  session.instructions = entry.instructions;
  session.technique = { ...entry.technique };
  session.bindings = cloneHistoryValue(entry.bindings);
  session.logoTechnique = cloneHistoryValue(entry.logoTechnique);
  session.anchors = cloneHistoryValue(entry.anchors);
}

/**
 * Undo one operator gesture: restores the previous snapshot as a NEW valid
 * revision (never resurrects historical approval), invalidating dependent
 * measurements via the caller's next snapshot. Camera-only moves must not
 * push history, so they never appear here. Returns false when empty.
 */
export function undoOperatorHistory(history: OperatorHistory, session: JobSession): boolean {
  const previous = history.past.at(-1);
  if (!previous) return false;
  const current = snapshotEntry(session, previous.label);
  const stored = cloneHistoryProject(previous.project);
  session.project = newRevision(session.project, (draft) => {
    draft.products = stored.products;
    draft.configurations = stored.configurations;
    draft.logos = stored.logos;
  });
  history.past.pop();
  history.future.push(current);
  restoreHistoryAuthoring(session, previous);
  touchSession(session);
  return true;
}

/** Redo one undone gesture; returns false when empty. Same revision contract as undo. */
export function redoOperatorHistory(history: OperatorHistory, session: JobSession): boolean {
  const next = history.future.at(-1);
  if (!next) return false;
  const current = snapshotEntry(session, next.label);
  const stored = cloneHistoryProject(next.project);
  session.project = newRevision(session.project, (draft) => {
    draft.products = stored.products;
    draft.configurations = stored.configurations;
    draft.logos = stored.logos;
  });
  history.future.pop();
  history.past.push(current);
  while (history.past.length > OPERATOR_HISTORY_LIMIT) history.past.shift();
  restoreHistoryAuthoring(session, next);
  touchSession(session);
  return true;
}
